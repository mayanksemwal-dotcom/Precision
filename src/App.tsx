/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  LayoutDashboard, 
  ClipboardCheck, 
  BarChart3, 
  Settings, 
  MessageSquare, 
  ShieldAlert, 
  LogOut, 
  User as UserIcon,
  Lock,
  Menu,
  X,
  FileUp,
  History,
  Clock,
  Award,
  Link2,
  FileText,
  Sun,
  Moon,
  LifeBuoy
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { UserRole, UserProfile, SamplingTask, AuditRecord, QAAlignment, ProductionRecord, WarningTicket, AgentKpiRecord } from './types';
import { INITIAL_ALIGNMENTS } from './lib/sample-data';
import { auth, db, logout, getDocsOptimized } from './lib/firebase';
import { isFirestoreBlocked, handleFirestoreError } from './lib/safeFirestore';
import { firestoreLogger } from './lib/firestoreLogger';
import { OperationType } from './lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, getDocs, collection, query, where, orderBy, setDoc, updateDoc, deleteDoc, limit, onSnapshot } from 'firebase/firestore';
import { Database, RefreshCw, Activity } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from './components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
// Removed fetchArchiveReports import

// Views
import AdminView from './views/AdminView';
import LoginView from './views/LoginView';
import MyProfileView from './views/MyProfileView';

// UI Components
import BergLogo from './components/BergLogo';
import { Button } from './components/ui/button';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner';
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuLabel, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger,
  DropdownMenuGroup 
} from './components/ui/dropdown-menu';

import EmployeeRelationsView from './views/EmployeeRelationsView';
import TMSView from './views/TMSView';
import ScorecardView from './views/ScorecardView';
import ManageHistoricalRecordsView from './views/ManageHistoricalRecordsView';
import ResourceHubView from './views/ResourceHubView';
import ITHelpDeskView from './views/ITHelpDeskView';
import AttendanceView from './views/AttendanceView';

import { PermissionProvider, usePermission } from './components/PermissionContext';
import { canActOn } from './lib/hierarchy';
import { safeStorage } from './lib/safeStorage';

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('tms');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewAsRole, setViewAsRole] = useState<string | null>(null);
  const [tasks, setTasks] = useState<SamplingTask[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditRecord[]>([]);
  const [alignments, setAlignments] = useState<QAAlignment[]>(INITIAL_ALIGNMENTS);
  const [productions, setProductions] = useState<ProductionRecord[]>([]);
  const [warnings, setWarnings] = useState<WarningTicket[]>([]);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [employeeProfiles, setEmployeeProfiles] = useState<Record<string, any>>({});
  const [agentKpis, setAgentKpis] = useState<AgentKpiRecord[]>([]);

  // Derive reactive current user from the synced allUsers and employeeProfiles source of truth
  const allUsersWithPhotos = useMemo(() => {
    return allUsers.map(u => {
      const prof = employeeProfiles[u.uid] || {};
      const photo = prof.profilePhotoUrl || u.profilePhotoUrl || u.photoURL || '';
      return {
        ...u,
        photoURL: photo,
        profilePhotoUrl: photo
      };
    });
  }, [allUsers, employeeProfiles]);

  const effectiveUser = allUsersWithPhotos.find(u => u.uid === user?.uid) || user;
  const [editingAudit, setEditingAudit] = useState<AuditRecord | null>(null);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const stored = safeStorage.get<string>('theme');
      if (stored === 'light' || stored === 'dark') {
        return stored as 'light' | 'dark';
      }
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    safeStorage.set('theme', theme);
  }, [theme]);

  // Handle live changes to the browser system theme preference
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleBrowserThemeChange = (e: MediaQueryListEvent) => {
      // Only transition theme if the user hasn't explicitly set their own manual preference
      if (!safeStorage.get('theme')) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    };
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleBrowserThemeChange);
    } else {
      mediaQuery.addListener(handleBrowserThemeChange);
    }
    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleBrowserThemeChange);
      } else {
        mediaQuery.removeListener(handleBrowserThemeChange);
      }
    };
  }, []);

  // Removed direct userPermissions state since we'll use context

  // Removed Archive Reports states

  // Firebase Auth Listener with Custom Claims synchronization
  useEffect(() => {
    console.log('Setting up Firebase Auth listener...');
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      console.log('onAuthStateChanged fired. User:', firebaseUser ? firebaseUser.email : 'null');
      if (firebaseUser) {
        // Direct login allowed without email verification per user request
        try {
          const getCleanName = () => {
            if (firebaseUser.displayName) return firebaseUser.displayName;
            if (firebaseUser.email) {
              const localPart = firebaseUser.email.split('@')[0];
              if (localPart) {
                return localPart
                  .split(/[\._\-]/)
                  .filter(Boolean)
                  .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                  .join(' ');
              }
            }
            return 'New User';
          };

          const now = new Date();
          let userProfile: UserProfile;
          try {
            // Try to get existing profile from Firestore
            const userDocRef = doc(db, 'users', firebaseUser.uid);
            const userDoc = await getDoc(userDocRef);
            
            if (userDoc.exists()) {
              console.log('User document found, syncing profile.');
              const currentData = userDoc.data() as any;
              
              // Promote users to 'Active'
              let finalStatus = currentData.status === 'Pending Verification' ? 'Active' : (currentData.status || 'Active');

              userProfile = {
                ...currentData,
                uid: firebaseUser.uid,
                email: (firebaseUser.email || '').toLowerCase().trim(),
                name: currentData.name || currentData.fullName || getCleanName(),
                fullName: currentData.fullName || currentData.name || getCleanName(),
                role: (firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') ? 'ADMIN' : (currentData.role || UserRole.AGENT).toUpperCase(),
                status: finalStatus,
                department: currentData.department || 'Operations',
                Manager: currentData.Manager || '',
                createdAt: currentData.createdAt || now.toISOString(),
                lastLoginAt: now.toISOString(), // Update last login
              };

              await setDoc(userDocRef, userProfile, { merge: true });
            } else {
              // Wait if registration is currently active in the client
              const isRegistering = safeStorage.get('is_registering') === 'true';
              let resolvedFromRegister = false;
              
              if (isRegistering) {
                console.log('Detected client-side registration in progress. Waiting up to 3 seconds for LoginView database setup...');
                for (let i = 0; i < 6; i++) {
                  await new Promise(resolve => setTimeout(resolve, 500));
                  const checkDoc = await getDoc(userDocRef);
                  if (checkDoc.exists()) {
                    console.log('Registration document detected in auth listener after wait.');
                    const currentData = checkDoc.data() as any;
                    let finalStatus = currentData.status === 'Pending Verification' ? 'Active' : (currentData.status || 'Active');
                    userProfile = {
                      ...currentData,
                      uid: firebaseUser.uid,
                      email: (firebaseUser.email || '').toLowerCase().trim(),
                      name: currentData.name || currentData.fullName || getCleanName(),
                      fullName: currentData.fullName || currentData.name || getCleanName(),
                      role: (firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') ? 'ADMIN' : (currentData.role || UserRole.AGENT).toUpperCase(),
                      status: finalStatus,
                      department: currentData.department || 'Operations',
                      Manager: currentData.Manager || '',
                      createdAt: currentData.createdAt || now.toISOString(),
                      lastLoginAt: now.toISOString(),
                    };
                    await setDoc(userDocRef, userProfile, { merge: true });
                    resolvedFromRegister = true;
                    break;
                  }
                }
              }

              if (!resolvedFromRegister) {
                console.log('New user detected or profile missing, checking pre-provisioning...');
                const usersRef = collection(db, 'users');
                const checkQuery = query(usersRef, where('email', '==', (firebaseUser.email || '').toLowerCase().trim()));
                const querySnap = await getDocsOptimized(checkQuery, 'pre_provision_check');
                
                if (!querySnap.empty) {
                  const matchedDoc = querySnap.docs[0];
                  console.log('Pre-provisioned user found. Triggering server-side profile linking and migration...', matchedDoc.id);
                  
                  const idToken = await firebaseUser.getIdToken(true);
                  const response = await fetch('/api/link-user-profile', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify({ oldDocId: matchedDoc.id })
                  });

                  if (!response.ok) {
                    throw new Error(`Profile migration failed: ${await response.text()}`);
                  }

                  const resData = await response.json();
                  userProfile = resData.user;
                  console.log('Successfully completed server-side profile linking and migration.');
                } else {
                  console.log('No pre-provisioned profile, creating clean profile...');
                  const isEmail = firebaseUser.providerData.some(p => p.providerId === 'password');
                  userProfile = {
                    uid: firebaseUser.uid,
                    email: (firebaseUser.email || '').toLowerCase().trim(),
                    name: getCleanName(),
                    fullName: getCleanName(),
                    role: (firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') ? UserRole.ADMIN : UserRole.AGENT,
                    status: 'Active',
                    department: 'Operations',
                    Manager: '',
                    createdAt: now.toISOString(),
                    lastLoginAt: now.toISOString(),
                    authProvider: isEmail ? 'email' : 'google',
                  };
                  await setDoc(userDocRef, userProfile);
                }
              }
              console.log('Bootstrapped user profile saved to Firestore.');
            }
          } catch (dbErr) {
            console.warn('Unable to reach Firestore database, generating safe fallback user profile:', dbErr);
            userProfile = {
              uid: firebaseUser.uid,
              email: (firebaseUser.email || '').toLowerCase().trim(),
              name: getCleanName(),
              fullName: getCleanName(),
                  role: (firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') ? UserRole.ADMIN : UserRole.AGENT,
              status: 'Active',
              department: 'Operations',
              Manager: '',
              createdAt: now.toISOString(),
              lastLoginAt: now.toISOString(),
            } as UserProfile;
          }

          setUser(userProfile);
          console.log('User profile set in state.');

          // Sync Custom claims asynchronously in the background. We check current claims, and only hit the backend/force token refresh if they are out of sync.
          (async () => {
            try {
              // Retrieve cached claims to avoid immediate network requests
              const tokenResult = await firebaseUser.getIdTokenResult(false);
              const expectedAdmin = userProfile.role === UserRole.ADMIN;
              const expectedQA = userProfile.role === UserRole.QA;

              const isCurrentAdmin = !!tokenResult.claims.isAdmin;
              const isCurrentQA = !!tokenResult.claims.isQA;

              if ((isCurrentAdmin !== expectedAdmin || isCurrentQA !== expectedQA) && !sessionStorage.getItem('claims_sync_attempted')) {
                console.log('Firebase user custom claims mismatch detected. Synchronizing claims...');
                sessionStorage.setItem('claims_sync_attempted', 'true');
                const idToken = await firebaseUser.getIdToken(true);
                const claimResponse = await fetch('/api/set-claims', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`,
                  },
                  body: JSON.stringify({ role: userProfile.role })
                });
                const cType = claimResponse.headers.get('content-type');
                if (claimResponse.ok && cType && cType.includes('application/json')) {
                  const claimsResult = await claimResponse.json();
                  console.log('Successfully updated Firebase custom user claims via Express API backend:', claimsResult);
                  // Force refresh local token so firebase is aware of claims changes globally
                  await firebaseUser.getIdTokenResult(true);
                } else {
                  const bodySample = await claimResponse.text();
                  console.warn('Express API backend claims sync failed. Status:', claimResponse.status, 'Content-Type:', cType, 'Body Sample:', bodySample.substring(0, 200));
                  console.log('Skipping claims response check. Express API backend is offline or running in standard client-only static SPA mode.');
                }
              } else {
                console.log('Firebase user custom claims already in sync. Skipping sync operations.');
              }
            } catch (claimsErr) {
              console.error('Failed to update Custom Firebase auth claims on login:', claimsErr);
            }
          })();
        } catch (authErr) {
            console.error('Error handling firebase user:', authErr);
        }
      } else {
        console.log('User logged out.');
        setUser(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);

  // Fetch disciplinary warning tickets (one-time fetch on mount/login)
  useEffect(() => {
    if (!user?.uid) return;

    const setupWarnings = async () => {
      try {
        const warningsDocId = `${user.role.toUpperCase()}_Warnings`;
        const permissionsDoc = await getDoc(doc(db, 'role_permissions', warningsDocId));
        firestoreLogger.trackRead('warnings_permissions_check', permissionsDoc.exists() ? 1 : 0);
        let canSeeAllWarnings = false;
        
        if (permissionsDoc.exists()) {
          const perms = permissionsDoc.data();
          canSeeAllWarnings = !!perms.can_view || !!perms.can_edit || !!perms.can_delete || !!perms.can_approve;
        } else {
          canSeeAllWarnings = ['ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'QA', 'TEAM_LEAD', 'STL', 'OPS_TL'].includes(user.role.toUpperCase());
        }

        let warningsQuery;
        if (canSeeAllWarnings) {
          warningsQuery = query(collection(db, 'disciplinaryLogs'), orderBy('createdAt', 'desc'));
        } else {
          warningsQuery = query(collection(db, 'disciplinaryLogs'), where('agentId', '==', user.uid));
        }

        const unsub = onSnapshot(warningsQuery, (snap) => {
          firestoreLogger.trackRead('warnings_onSnapshot', snap.size);
          let docsList = snap.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) } as WarningTicket));
          if (!canSeeAllWarnings) {
            docsList.sort((a, b) => {
              const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
              const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
              return tB - tA;
            });
          }
          setWarnings(docsList);
        }, (e) => {
          console.error("Error setting up warnings:", e);
        });
        return unsub;
      } catch (e) {
        console.error("Error setting up warnings:", e);
      }
    };

    const unsubPromise = setupWarnings();
    return () => {
      unsubPromise.then(unsub => unsub && unsub());
    };
  }, [user?.uid]);

let rosterFetchPromise: Promise<{ roster: any[], profiles: Record<string, any> }> | null = null;

  const loadRosterWithCache = async (forceRefresh: boolean = false) => {
    if (rosterFetchPromise && !forceRefresh) {
      console.log('[TMS Billing Optimization] Re-using ongoing roster fetch promise...');
      return rosterFetchPromise;
    }

    const fetchTask = async () => {
      try {
        const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
        const cachedTimestamp = safeStorage.get<string>('precision360_cache_timestamp');
        const cachedRoster = safeStorage.get<any[]>('precision360_roster_cache');
        const cachedProfiles = safeStorage.get<Record<string, any>>('precision360_profiles_cache');

        const isCacheValid = cachedTimestamp && cachedRoster && cachedProfiles && 
          (Date.now() - parseInt(cachedTimestamp, 10) < CACHE_TTL_MS);

        if (isCacheValid && !forceRefresh) {
          try {
            const roster = cachedRoster;
            const profiles = cachedProfiles;
            if (Array.isArray(roster) && roster.length > 1) {
              console.log('[TMS Billing Optimization] Loading roster and profiles from safeStorage cache...');
              return { roster, profiles };
            }
            console.log('[TMS Billing Optimization] Cached roster has 1 or fewer users. Forcing bypass to fetch complete data...');
          } catch (e) {
            console.warn('[TMS Billing Optimization] Failed to parse cached roster, bypassing cache:', e);
          }
        }

        console.log(`[TMS Billing Optimization] Cache expired or forceRefresh=${forceRefresh}. Fetching roster from Firestore...`);
        const usersSnap = await getDocsOptimized(collection(db, 'users'), 'users_roster_refresh', forceRefresh);
        firestoreLogger.trackRead('users_roster_refresh', usersSnap.size);
        const roster = usersSnap.docs.map(doc => {
          const data = doc.data() as any;
          const normalizedTLId = data.teamLeadUid || data.teamLeadId || '';
          const normalizedManagerId = data.mappedManagerUid || data.mappedManagerId || data.managerId || '';
          return {
            uid: doc.id,
            ...data,
            name: data.fullName || data.name || data.employeeName || '',
            fullName: data.fullName || data.name || data.employeeName || '',
            email: (data.email || '').toString().toLowerCase().trim(),
            employeeId: data.employeeId || '',
            photoURL: data.profilePhotoUrl || data.photoURL || '',
            role: (data.role || UserRole.AGENT).toString().toUpperCase(),
            status: data.status || 'Active',
            teamLeadId: normalizedTLId,
            teamLeadUid: normalizedTLId,
            managerId: normalizedManagerId,
            mappedManagerId: normalizedManagerId,
            mappedManagerUid: normalizedManagerId
          } as UserProfile;
        });

        const profilesSnap = await getDocsOptimized(collection(db, 'employeeProfiles'), 'profiles_roster_refresh', forceRefresh);
        firestoreLogger.trackRead('profiles_roster_refresh', profilesSnap.size);
        const profiles: Record<string, any> = {};
        profilesSnap.forEach(d => { profiles[d.id] = d.data(); });

        safeStorage.set('precision360_roster_cache', roster);
        safeStorage.set('precision360_profiles_cache', profiles);
        safeStorage.set('precision360_cache_timestamp', Date.now().toString());

        return { roster, profiles };
      } catch (err) {
        console.error('[loadRosterWithCache] Error fetching/parsing roster:', err);
        const cachedRoster = safeStorage.get<any[]>('precision360_roster_cache');
        const cachedProfiles = safeStorage.get<Record<string, any>>('precision360_profiles_cache');
        if (cachedRoster && cachedProfiles) {
          return { roster: cachedRoster, profiles: cachedProfiles };
        }
        throw err;
      } finally {
        if (rosterFetchPromise === fetchTaskPromise) {
          rosterFetchPromise = null;
        }
      }
    };

    const fetchTaskPromise = fetchTask();
    rosterFetchPromise = fetchTaskPromise;
    return fetchTaskPromise;
  };

  const fetchAllData = async (isManual = false) => {
    if (!user) return;
    setIsRefreshing(true);

    try {
      // Helper for safer fetching
      const safeFetch = async <T,>(promise: Promise<T>, fallback: T, name: string): Promise<T> => {
        try {
          return await promise;
        } catch (err) {
          handleFirestoreError(err, OperationType.LIST, name);
          return fallback;
        }
      };

      setAlignments(INITIAL_ALIGNMENTS);
      setProductions([]);
      setAgentKpis([]);
      setAuditLogs([]);
      setTasks([]);

      // Refresh staff roster if manual trigger
      const userRole = (user.role || '').toUpperCase().trim();
      const isStaff = ['ADMIN', 'MANAGER', 'TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'MIS', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'QA', 'ASSISTANT_MANAGER', 'TRAINER', 'SME', 'TEAM LEAD', 'TRAINER TL', 'OPS TL'].includes(userRole);

      if (isStaff) {
        console.log('[TMS Billing Optimization] Loading staff roster...');
        const { roster, profiles } = await loadRosterWithCache(isManual);
        setAllUsers(roster);
        setEmployeeProfiles(profiles);
      }

      // Re-fetch warning logs
      const warningsDocId = `${user.role.toUpperCase()}_Warnings`;
      const permissionsDoc = await getDoc(doc(db, 'role_permissions', warningsDocId));
      let canSeeAllWarnings = false;
      if (permissionsDoc.exists()) {
        const perms = permissionsDoc.data();
        canSeeAllWarnings = !!perms.can_view || !!perms.can_edit || !!perms.can_delete || !!perms.can_approve;
      } else {
        canSeeAllWarnings = ['ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'QA', 'TEAM_LEAD', 'STL', 'OPS_TL'].includes(user.role.toUpperCase());
      }
      let warningsQuery;
      if (canSeeAllWarnings) {
        warningsQuery = query(collection(db, 'disciplinaryLogs'), orderBy('createdAt', 'desc'), limit(25));
      } else {
        warningsQuery = query(collection(db, 'disciplinaryLogs'), where('agentId', '==', user.uid), limit(25));
      }
      const warningsSnap = await getDocsOptimized(warningsQuery, 'warnings_manual_refresh');
      let docsList = warningsSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) } as WarningTicket));
      if (!canSeeAllWarnings) {
        docsList.sort((a, b) => {
          const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return tB - tA;
        });
      }
      setWarnings(docsList);

      if (isManual) {
        toast.success('All reports refreshed successfully');
      }
    } catch (error) {
      console.error('Data loading error:', error);
      handleFirestoreError(error, OperationType.LIST, 'all_data');
    } finally {
      setIsRefreshing(false);
    }
  };

  //Consolidated Initialization path for roster & data
  useEffect(() => {
    if (!user?.uid) return;

    console.log('[App] Initializing data for user:', user.uid);
    setActiveTab('tms');
    
    const initializeData = async () => {
      // 1. Fetch Roster & Profiles (Phase 5 Optimization)
      const userRole = (user.role || '').toUpperCase().trim();
      const isStaff = ['ADMIN', 'MANAGER', 'TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'MIS', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'QA', 'ASSISTANT_MANAGER', 'TRAINER', 'SME', 'TEAM LEAD', 'TRAINER TL', 'OPS TL'].includes(userRole);
      
      if (isStaff) {
        console.log('[TMS Billing Optimization] Loading staff roster...');
        try {
          const { roster, profiles } = await loadRosterWithCache(false);
          setAllUsers(roster);
          setEmployeeProfiles(profiles);
        } catch (err) {
          console.error('[ROSTER_FETCH_ERROR]', err);
        }
      }

      // 2. Fetch other initial data
      fetchAllData();
    };

    initializeData();

  }, [user?.uid]);

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  // Real-time Employee Master (Single Source of Truth) - OPTIMIZED: One-time fetch for staff with current user real-time listener
  useEffect(() => {
    if (!user) return;

    console.log('Setting up optimized subscription for current user profile...');
    
    const userRole = (user.role || '').toUpperCase().trim();
    const isStaff = ['ADMIN', 'MANAGER', 'TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'MIS', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'QA', 'ASSISTANT_MANAGER', 'TRAINER', 'SME', 'TEAM LEAD', 'TRAINER TL', 'OPS TL'].includes(userRole);

    const mapDocToUserProfile = (d: any) => {
      const data = d.data() as any;
      const normalizedTLId = data.teamLeadUid || data.teamLeadId || '';
      const normalizedManagerId = data.mappedManagerUid || data.mappedManagerId || data.managerId || '';
      return {
        uid: d.id,
        ...data,
        name: data.fullName || data.name || data.employeeName || '',
        fullName: data.fullName || data.name || data.employeeName || '',
        email: (data.email || '').toString().toLowerCase().trim(),
        employeeId: data.employeeId || '',
        photoURL: data.profilePhotoUrl || data.photoURL || '',
        role: (data.role || UserRole.AGENT).toString().toUpperCase(),
        status: data.status || 'Active',
        teamLeadId: normalizedTLId,
        teamLeadUid: normalizedTLId,
        managerId: normalizedManagerId,
        mappedManagerId: normalizedManagerId,
        mappedManagerUid: normalizedManagerId
      } as UserProfile;
    };

    // Realtime listener for personal user document
    const personalUserQuery = query(collection(db, 'users'), where('__name__', '==', user.uid));
    const unsubUsers = onSnapshot(personalUserQuery, (snapshot) => {
      firestoreLogger.trackRead('personal_user_snapshot', snapshot.size);
      if (!snapshot.empty) {
        const myProfile = mapDocToUserProfile(snapshot.docs[0]);
        setAllUsers(prev => {
          const filtered = prev.filter(u => u.uid !== user.uid);
          return [myProfile, ...filtered];
        });
      }
    }, (err) => {
      console.error('Personal user fetch error:', err);
    });

    // Realtime listener for personal employee profile document
    const personalProfileQuery = query(collection(db, 'employeeProfiles'), where('__name__', '==', user.uid));
    const unsubProfiles = onSnapshot(personalProfileQuery, (profSnap) => {
      firestoreLogger.trackRead('personal_profile_snapshot', profSnap.size);
      if (!profSnap.empty) {
        const myData = profSnap.docs[0].data();
        setEmployeeProfiles(prev => ({
          ...prev,
          [user.uid]: myData
        }));
      }
    }, (err) => {
      console.error('Personal profile fetch error:', err);
    });

    return () => {
      unsubUsers();
      unsubProfiles();
    };
  }, [user?.uid]);

  // Removed Employee Profiles and Roles collection-wide onSnapshot listeners
  useEffect(() => {
    if (!user?.uid) return;
    const fetchRoles = async () => {
      try {
        const rolesSnap = await getDocsOptimized(collection(db, 'roles'), 'roles_list_fetch');
        firestoreLogger.trackRead('roles_list_fetch', rolesSnap.size);
        const rolesList = rolesSnap.docs.map(doc => (((doc.data() as any).name || doc.id) as string).toUpperCase().trim());
        const qPermissions = query(collection(db, 'role_permissions'));
        const permissionsSnap = await getDocsOptimized(qPermissions, 'role_permissions_fetch');
        firestoreLogger.trackRead('role_permissions_fetch', permissionsSnap.size);
        const permissionsRoles = permissionsSnap.docs.map(doc => (((doc.data() as any).role_name || '') as string).toUpperCase().trim());
        const combined = Array.from(new Set([...rolesList, ...permissionsRoles])).filter(Boolean).sort();
        setAvailableRoles(combined.length > 0 ? combined : [
          'ADMIN', 'MANAGER', 'STL', 'OPS_TL', 'SME', 'QTL', 'QA', 'TEAM_LEAD', 'TRAINER', 'TRAINER_TL', 'MIS', 'AGENT'
        ]);
      } catch (err) {
        console.error('Error fetching roles:', err);
      }
    };
    fetchRoles();
  }, [user?.uid]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="animate-spin text-blue-600">
          <LayoutDashboard size={48} />
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginView />;
  }

  return (
    <PermissionProvider user={effectiveUser!} overriddenRole={viewAsRole || undefined}>
      <AppContent 
        user={effectiveUser}
        viewAsRole={viewAsRole}
        setViewAsRole={setViewAsRole}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        allUsers={allUsersWithPhotos}
        warnings={warnings}
        fetchAllData={fetchAllData}
        handleLogout={handleLogout}
        theme={theme}
        setTheme={setTheme}
        availableRoles={availableRoles}
      />
    </PermissionProvider>
  );
}

interface AppContentProps {
  user: UserProfile | null;
  viewAsRole: string | null;
  setViewAsRole: (r: string | null) => void;
  activeTab: string;
  setActiveTab: (t: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
  allUsers: UserProfile[];
  warnings: WarningTicket[];
  fetchAllData: (isManual?: boolean) => Promise<void>;
  handleLogout: () => Promise<void>;
  availableRoles: string[];
}

function AppContent({
  user,
  viewAsRole,
  setViewAsRole,
  activeTab,
  setActiveTab,
  sidebarOpen,
  setSidebarOpen,
  allUsers,
  warnings,
  fetchAllData,
  handleLogout,
  theme,
  setTheme,
  availableRoles
}: AppContentProps & { theme: 'light' | 'dark', setTheme: (t: 'light' | 'dark') => void }) {
  const { canView, canEdit, loading: permissionsLoading } = usePermission();

  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordState, setPasswordState] = useState<'idle' | 'updating' | 'success' | 'error'>('idle');
  const [tmsExpanded, setTmsExpanded] = useState(true);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || !oldPassword) {
      toast.error('All fields are mandatory.');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('The new password must be at least 6 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('The passwords do not match.');
      return;
    }

    setPasswordState('updating');
    try {
      const { EmailAuthProvider, reauthenticateWithCredential, updatePassword } = await import('firebase/auth');
      const currentUser = auth.currentUser;
      if (!currentUser || !currentUser.email) {
        throw new Error('No verified user session exists.');
      }

      // Reauthenticate user
      const credential = EmailAuthProvider.credential(currentUser.email, oldPassword);
      await reauthenticateWithCredential(currentUser, credential);
      
      // Update Password
      await updatePassword(currentUser, newPassword);
      
      toast.success('Your password has been changed securely.');
      setIsChangePasswordOpen(false);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordState('idle');
    } catch (err: any) {
      console.error(err);
      toast.error(`Password update failed: ${err.message}`);
      setPasswordState('error');
    }
  };

  const navItems = [
    { id: 'tms', label: 'Workforce TMS', icon: Clock },
    { id: 'kpis_scorecard', label: 'KPI Scorecard', icon: Award },
    { id: 'employee_relations', label: 'Employee Relations', icon: ShieldAlert },
    { id: 'it_help_desk', label: 'IT Help Desk', icon: LifeBuoy },
    { id: 'historical', label: 'Historical Records', icon: History },
    { id: 'resources', label: 'Important Quality Links', icon: Link2 },
    { id: 'config', label: 'Console', icon: Settings },
  ];

  const effectiveRole = viewAsRole || (user?.role || UserRole.AGENT);
  
  // Dynamically filter navigation items using centralized PermissionService with memoization for snappy performance
  const filteredNav = React.useMemo(() => {
    return navItems.filter(item => canView(item.label));
  }, [canView, permissionsLoading]);

  const effectiveUser = user ? { ...user, role: effectiveRole } : null;

  return (
    <div className="flex flex-col h-screen overflow-hidden text-slate-900 dark:text-slate-100 font-sans bg-[#F8FAFC] dark:bg-slate-950">
      <Toaster position="top-center" />
      
      {viewAsRole && (
        <div className="bg-amber-500 text-slate-950 py-1.5 px-8 text-[11px] font-black flex items-center justify-between shadow-sm z-[1000] border-b border-amber-600 shrink-0">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-600 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-600"></span>
            </span>
            <span>PREVIEW MODE ACTIVE — Simulated Role: <b className="bg-slate-900 text-amber-400 px-2.5 py-0.5 rounded-md text-[10px] tracking-wider ml-1.5 uppercase font-black">{viewAsRole}</b></span>
          </div>
          <button 
            onClick={() => setViewAsRole(null)} 
            className="bg-slate-950 hover:bg-slate-850 text-white rounded-lg px-3 py-1 text-[10px] uppercase font-black tracking-wider transition-all duration-200 shadow-sm"
          >
            Exit Preview
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden h-full">
        {/* Sidebar */}
        <motion.aside 
        initial={false}
        animate={{ width: sidebarOpen ? 290 : 80 }}
        className="bg-[#0F172A] dark:bg-slate-900 border-r border-[#1E293B] dark:border-slate-800 flex flex-col z-30 text-[#CBD5E1]"
      >
        <div className="px-4 pt-6 pb-4 flex flex-col items-start animate-fade-in">
          <div className="w-full flex items-center justify-between mb-6">
            <div className={`flex items-center gap-3.5 ${!sidebarOpen && 'justify-center w-full'}`}>
              <div className="p-0 flex items-center justify-center flex-shrink-0">
                <BergLogo 
                  className={sidebarOpen ? 'h-11 w-auto px-2' : 'h-11 w-11'} 
                  showSubtitle={false} 
                />
              </div>
              {sidebarOpen && (
                <div className="flex flex-col min-w-0 overflow-hidden">
                  <span className="font-black text-[17px] leading-none tracking-tight text-white truncate">Precision360</span>
                  <span className="text-[9px] font-bold text-sky-400 uppercase tracking-wider mt-1 opacity-90 truncate">Berg Technologies</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <nav className="flex-1 px-4 space-y-1.5 overflow-y-auto">
          {permissionsLoading && (
            <div className="space-y-2.5 mt-3 select-none">
              {[1, 2, 3, 4, 5].map((idx) => (
                <div key={idx} className="w-full h-10 bg-slate-800/40 rounded-lg animate-pulse flex items-center px-4 gap-3 border border-slate-800/20">
                  <div className="w-4 h-4 bg-slate-700/50 rounded-md shrink-0 animate-pulse" />
                  {sidebarOpen && <div className="h-3.5 w-24 bg-slate-700/40 rounded animate-pulse" />}
                </div>
              ))}
            </div>
          )}
          {!permissionsLoading && filteredNav.map((item) => (
            <React.Fragment key={item.id}>
              <button
                id={`nav-${item.id}`}
                onClick={() => {
                  if (item.id === 'tms') {
                    setTmsExpanded(!tmsExpanded);
                  }
                  setActiveTab(item.id);
                }}
                className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg transition-all duration-200 group text-[13px] ${
                  activeTab === item.id 
                    ? 'bg-[#38BDF8] text-[#0F172A] font-bold shadow-md shadow-sky-500/10' 
                    : 'hover:bg-[#1E293B] hover:text-white'
                }`}
              >
                <div className="flex items-center gap-3">
                  <item.icon size={18} className={activeTab === item.id ? 'text-[#0F172A]' : 'text-[#64748B] group-hover:text-white'} />
                  {sidebarOpen && <span>{item.label}</span>}
                </div>
                {item.id === 'tms' && sidebarOpen && (
                  <motion.div
                    animate={{ rotate: tmsExpanded ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </motion.div>
                )}
              </button>
              {item.id === 'tms' && tmsExpanded && sidebarOpen && (
                <div className="ml-9 mt-1 space-y-1 border-l border-slate-800 pl-3">
                  <button
                    onClick={() => setActiveTab('tms')}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[12px] transition-colors ${
                      activeTab === 'tms' 
                        ? 'text-sky-400 font-bold' 
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Clock size={14} />
                    TMS Dashboard
                  </button>
                  <button
                    onClick={() => setActiveTab('attendance')}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[12px] transition-colors ${
                      activeTab === 'attendance' 
                        ? 'text-sky-400 font-bold' 
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <ClipboardCheck size={14} />
                    Attendance
                  </button>
                </div>
              )}
            </React.Fragment>
          ))}
          {filteredNav.length === 0 && !permissionsLoading && (
            <div className="p-4 text-center text-xs text-rose-400 bg-rose-950/20 border border-rose-900/30 rounded-xl m-2 select-none">
              <ShieldAlert size={18} className="mx-auto mb-1 text-rose-400 animate-pulse" />
              {sidebarOpen ? 'No modules have been assigned to your role. Please contact your Administrator.' : 'Locked'}
            </div>
          )}
        </nav>

        <div className="p-4 border-t border-[#1E293B] dark:border-slate-800">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-[#1E293B] transition-colors group">
                  <div className="w-8 h-8 rounded-full bg-[#1E293B] group-hover:bg-[#334155] border border-[#334155] flex items-center justify-center overflow-hidden">
                    {user?.photoURL ? (
                      <img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <UserIcon size={16} className="text-[#CBD5E1]" />
                    )}
                  </div>
                  {sidebarOpen && (
                    <div className="flex-1 text-left">
                      <p className="text-sm font-medium leading-tight text-white">{user.name}</p>
                      <p className="text-[10px] uppercase font-bold tracking-wider text-[#64748B]">{user.role}</p>
                    </div>
                  )}
                </button>
              }
            />
            <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setActiveTab('profile')} className="cursor-pointer font-medium flex items-center pr-4">
                  <UserIcon size={16} className="mr-2 text-indigo-500" />
                  My Profile
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setIsChangePasswordOpen(true)} className="cursor-pointer font-medium flex items-center pr-4">
                  <Lock size={16} className="mr-2 text-indigo-500" />
                  Change Password
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} variant="destructive" className="text-red-600 dark:text-red-400 font-bold focus:bg-red-50 focus:text-red-750 cursor-pointer flex items-center pr-4">
                  <LogOut size={16} className="mr-2 text-red-600 dark:text-red-400 font-bold" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-white dark:bg-slate-900 border-b border-[#E2E8F0] dark:border-slate-800 flex items-center justify-between px-8 sticky top-0 z-20">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg text-[#64748B] dark:text-slate-400"
            >
              {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
            <div className="flex items-center gap-2 text-sm text-[#64748B] dark:text-slate-400">
               <span className="capitalize">{activeTab}</span>
               {activeTab === 'sampling' && (
                 <>
                   <span className="text-slate-300 dark:text-slate-700">/</span>
                   <span className="font-semibold text-[#0F172A] dark:text-white">Active Desk</span>
                 </>
               )}
            </div>
          </div>
          <div className="flex items-center gap-6">
             {(user?.role?.toUpperCase() === 'ADMIN' || user?.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in' || viewAsRole !== null) && (
               <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 py-1.5 px-3 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm hover:border-slate-300 transition-all duration-200">
                 <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 ml-1 uppercase tracking-wider">Preview Role:</span>
                 <select
                   value={viewAsRole || ''}
                   onChange={(e) => {
                     const selected = e.target.value;
                     setViewAsRole(selected === '' ? null : selected);
                   }}
                   className="bg-transparent text-xs font-black text-blue-600 dark:text-blue-400 border-none outline-none focus:ring-0 cursor-pointer pr-1 uppercase"
                 >
                   <option value="" className="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 font-bold">
                     Exit Preview ({user?.role})
                   </option>
                   {availableRoles.filter(r => r !== user?.role).map(r => (
                     <option key={r} value={r} className="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 font-bold">
                       {r}
                     </option>
                   ))}
                 </select>
               </div>
             )}
             <div className="flex items-center gap-4">
                {/* Global Theme Toggle */}
                <button 
                  onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                  className="p-2 h-9 w-9 flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-amber-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all cursor-pointer"
                  title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                >
                  {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                </button>

                <div className="role-badge bg-[#F1F5F9] dark:bg-slate-800 text-[#475569] dark:text-slate-300 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">
                  {effectiveRole} {viewAsRole ? '(Preview)' : ''}
                </div>
                <div className="flex items-center gap-3">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button className="flex items-center gap-2 px-2.5 py-1 hover:bg-slate-50 dark:hover:bg-slate-805 border border-slate-200/40 dark:border-slate-800 rounded-xl transition-all cursor-pointer group">
                          <span className="text-xs font-bold text-[#1E293B] dark:text-slate-200 group-hover:text-indigo-500 transition-colors leading-none">{effectiveUser?.name}</span>
                          <div className="w-8 h-8 rounded-full bg-[#E2E8F0] dark:bg-slate-800 border border-white dark:border-slate-700 shadow-sm flex items-center justify-center font-bold text-xs text-[#64748B] dark:text-slate-400 group-hover:scale-105 transition-transform overflow-hidden">
                            {effectiveUser?.photoURL ? (
                              <img src={effectiveUser.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              effectiveUser?.name.split(' ').map(n => n[0]).slice(0, 2).join('')
                            )}
                          </div>
                        </button>
                      }
                    />
                    <DropdownMenuContent side="bottom" align="end" sideOffset={8} className="w-52">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>My Account</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setActiveTab('profile')} className="cursor-pointer font-medium flex items-center">
                          <UserIcon size={14} className="mr-2 text-indigo-500" />
                          My Profile
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setIsChangePasswordOpen(true)} className="cursor-pointer font-medium flex items-center">
                          <Lock size={14} className="mr-2 text-indigo-500" />
                          Change Password
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={handleLogout} variant="destructive" className="text-red-600 dark:text-red-400 font-bold cursor-pointer flex items-center">
                          <LogOut size={14} className="mr-2" />
                          Logout
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
             </div>
          </div>
        </header>

        {/* View Content */}
        <div className="flex-1 overflow-auto p-8">
          <AnimatePresence mode="wait">
            {filteredNav.length === 0 && !permissionsLoading ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="max-w-md mx-auto my-12 text-center p-8 bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-xl"
              >
                <ShieldAlert size={48} className="text-rose-500 mx-auto mb-4 animate-bounce" />
                <h3 className="text-base font-black text-slate-800 dark:text-slate-105 mb-2">Access Denied</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-sans leading-relaxed">
                  No modules have been assigned to your role. Please contact your Administrator.
                </p>
              </motion.div>
            ) : (
              <motion.div
                key={`${activeTab}-${effectiveRole}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12, ease: "easeOut" }}
                className="max-w-7xl mx-auto h-full"
              >
                {activeTab === 'profile' ? (
                  <MyProfileView user={effectiveUser!} allUsers={allUsers} externalTheme={theme} onRefreshAllData={fetchAllData} />
                ) : activeTab === 'tms' ? (
                  <TMSView user={effectiveUser!} allUsers={allUsers} onRefreshAllData={fetchAllData} externalTheme={theme} />
                ) : activeTab === 'attendance' ? (
                  <AttendanceView user={effectiveUser!} allUsers={allUsers} externalTheme={theme} />
                ) : activeTab === 'kpis_scorecard' ? (
                  <ScorecardView user={effectiveUser!} allUsers={allUsers} onRefreshAllData={fetchAllData} externalTheme={theme} />
                ) : activeTab === 'employee_relations' ? (
                  <EmployeeRelationsView warnings={warnings} user={effectiveUser!} allUsers={allUsers} externalTheme={theme} />
                ) : activeTab === 'it_help_desk' ? (
                  <ITHelpDeskView user={effectiveUser!} allUsers={allUsers} externalTheme={theme} />
                ) : activeTab === 'historical' ? (
                  <ManageHistoricalRecordsView user={effectiveUser!} allUsers={allUsers} onRefreshAllData={fetchAllData} />
                ) : activeTab === 'resources' ? (
                  <ResourceHubView user={effectiveUser!} />
                ) : activeTab === 'config' ? (
                  <AdminView 
                    activeTab={activeTab} 
                    tasks={[]} 
                    onTasksUpdate={() => {}} 
                    user={effectiveUser!}
                    alignments={[]}
                    onAlignmentsUpdate={async () => {}}
                    productions={[]}
                    auditLogs={[]}
                    goToTab={setActiveTab}
                    allUsers={allUsers}
                    warnings={warnings}
                    onRefresh={fetchAllData}
                    externalTheme={theme}
                  />
                ) : (
                  <div className="py-12 text-center text-slate-500 font-bold text-sm">
                    Module Not Registered
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Change Password Dialog */}
      <Dialog open={isChangePasswordOpen} onOpenChange={setIsChangePasswordOpen}>
        <DialogContent className="sm:max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 rounded-2xl shadow-xl">
          <DialogHeader>
            <DialogTitle className="text-lg font-black text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <Lock size={18} className="text-indigo-500" /> Change Account Password
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Verify your identity by inputting current password credentials, then request password updates.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleUpdatePassword} className="space-y-4 mt-3">
            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Current Password</label>
              <input
                type="password"
                required
                value={oldPassword}
                onChange={e => setOldPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full text-xs p-2.5 rounded-lg border outline-none transition-all focus:ring-1 focus:ring-indigo-500 bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">New Desired Password</label>
              <input
                type="password"
                required
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="•••••••• (Min 6 chars)"
                className="w-full text-xs p-2.5 rounded-lg border outline-none transition-all focus:ring-1 focus:ring-indigo-500 bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Confirm New Password</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full text-xs p-2.5 rounded-lg border outline-none transition-all focus:ring-1 focus:ring-indigo-500 bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100"
              />
            </div>

            <DialogFooter className="mt-4 gap-2 flex justify-end">
              <button
                type="button"
                onClick={() => setIsChangePasswordOpen(false)}
                className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 font-bold text-xs rounded-xl cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={passwordState === 'updating'}
                className="px-5 py-2 bg-indigo-650 hover:bg-indigo-700 text-white font-black text-xs rounded-xl cursor-pointer flex items-center gap-1.5 shadow-md shadow-indigo-500/10 active:scale-95 transition-all"
              >
                {passwordState === 'updating' ? <RefreshCw size={12} className="animate-spin" /> : "Update Password"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  </div>
  );
}

