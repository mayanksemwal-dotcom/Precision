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
  LifeBuoy,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  Type,
  Users,
  FileSpreadsheet,
  Play,
  Shield
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { UserRole, UserProfile } from './types';
import { INITIAL_ALIGNMENTS } from './lib/sample-data';
import { auth, db, logout, getDocsOptimized, getDocOptimized } from './lib/firebase';
import { isFirestoreBlocked, handleFirestoreError } from './lib/safeFirestore';
import { firestoreLogger } from './lib/firestoreLogger';
import { OperationType } from './lib/firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, getDocs, collection, query, where, orderBy, setDoc, updateDoc, deleteDoc, limit, onSnapshot, writeBatch } from 'firebase/firestore';
import { Database, RefreshCw, Activity } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from './components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
// Removed fetchArchiveReports import

// Views
import AdminView from './views/AdminView';
import LoginView from './views/LoginView';
import MyProfileView from './views/MyProfileView';
import KPIScorecardView from './views/KPIScorecardView';
import { runRoleStandardizationMigration } from './lib/roleMigration';
import { useMemoryGuard, manualMemoryCleanAndSync } from './hooks/useMemoryGuard';
import { syncCurrentUserClaims } from './lib/claimsService';

// UI Components
import BergLogo from './components/BergLogo';
import { Button, buttonVariants } from './components/ui/button';
import { cn } from './lib/utils';
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

import TMSView from './views/TMSView';
import ResourceHubView from './views/ResourceHubView';

import { PermissionProvider, usePermission } from './components/PermissionContext';
import { canActOn } from './lib/hierarchy';
import { safeStorage } from './lib/safeStorage';
import { useRoster } from './contexts/RosterContext';
import { ConfigProvider, useConfig } from './contexts/ConfigContext';

export default function App() {
  useMemoryGuard();
  const [user, setUser] = useState<UserProfile | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('tms');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewAsRole, setViewAsRole] = useState<string | null>(null);
  
  const { roster, profiles, globalRoster, globalProfiles, refreshRoster, invalidateRosterCache } = useRoster();
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [employeeProfiles, setEmployeeProfiles] = useState<Record<string, any>>({});
  const [globalUsers, setGlobalUsers] = useState<UserProfile[]>([]);
  const [globalProfilesState, setGlobalProfilesState] = useState<Record<string, any>>({});

  useEffect(() => {
    setAllUsers(roster);
    setEmployeeProfiles(profiles);
  }, [roster, profiles]);

  useEffect(() => {
    setGlobalUsers(globalRoster && globalRoster.length > 0 ? globalRoster : roster);
    setGlobalProfilesState(globalProfiles && Object.keys(globalProfiles).length > 0 ? globalProfiles : profiles);
  }, [globalRoster, globalProfiles, roster, profiles]);

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

  const syncedUser = allUsersWithPhotos.find(u => u.uid === user?.uid) || user;

  const realUserWithSyncedData = useMemo(() => {
    if (!user) return null;
    const base = allUsersWithPhotos.find(u => u.uid === user.uid) || user;
    if (user.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') {
      return {
        ...base,
        role: UserRole.ADMIN
      };
    }
    return base;
  }, [user, allUsersWithPhotos]);

  const effectiveUser = useMemo(() => {
    if (!realUserWithSyncedData) return null;
    if (viewAsRole) {
      return {
        ...realUserWithSyncedData,
        role: viewAsRole as UserRole
      };
    }
    return realUserWithSyncedData;
  }, [realUserWithSyncedData, viewAsRole]);

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

  // Firebase Auth Listener with Custom Claims synchronization and Real-time Role Propagation
  useEffect(() => {
    console.log('Setting up Firebase Auth listener...');
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      console.log('onAuthStateChanged fired. User:', firebaseUser ? firebaseUser.email : 'null');
      
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }

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
            const userDocRef = doc(db, 'employee_master', firebaseUser.uid);
            const userDoc = await getDoc(userDocRef);
            
            if (userDoc.exists()) {
              console.log('User document found, syncing profile.');
              const currentData = userDoc.data() as any;
              
              // Check if administrator has marked user as login restricted
              const isRestricted = currentData.loginRestricted === true || currentData.isRestricted === true || currentData.isLoginRestricted === true || currentData.status === 'Restricted';
              const isSuperAdmin = firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in';

              if (isRestricted && !isSuperAdmin) {
                console.warn('[AUTH REJECTED] User login is restricted by administrator:', firebaseUser.email);
                const reasonMsg = currentData.restrictedReason
                  ? `Access Denied: Your account login has been restricted by an administrator.\nReason: ${currentData.restrictedReason}`
                  : 'Access Denied: Your account login has been restricted by an administrator. You cannot log into the application even with valid credentials.';
                safeStorage.set('login_restriction_message', reasonMsg);
                await signOut(auth);
                setUser(null);
                return;
              }

              // Preserve the existing organizational membership (isActive / status).
              const finalStatus = currentData.status || (currentData.isActive === false ? 'Inactive' : 'Active');
              const finalIsActive = currentData.isActive !== undefined ? currentData.isActive : (finalStatus !== 'Inactive' && finalStatus !== 'Archived' && finalStatus !== 'Suspended');

              let finalRole = (currentData.role || UserRole.AGENT).toUpperCase();
              if (firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') {
                finalRole = 'ADMIN';
              }

              const lastLoginMs = currentData.lastLoginAt ? new Date(currentData.lastLoginAt).getTime() : 0;
              // Update lastLoginAt on app startup only if missing or > 12 hours old
              const isLastLoginStale = !lastLoginMs || (now.getTime() - lastLoginMs > 12 * 60 * 60 * 1000);
              const resolvedLastLoginAt = isLastLoginStale ? now.toISOString() : currentData.lastLoginAt;

              userProfile = {
                ...currentData,
                uid: firebaseUser.uid,
                email: (firebaseUser.email || '').toLowerCase().trim(),
                name: currentData.name || currentData.fullName || getCleanName(),
                fullName: currentData.fullName || currentData.name || getCleanName(),
                role: finalRole,
                status: finalStatus,
                isActive: finalIsActive,
                department: currentData.department || 'Operations',
                Manager: currentData.Manager || currentData.mappedManagerName || currentData.managerName || '',
                createdAt: currentData.createdAt || now.toISOString(),
                lastLoginAt: resolvedLastLoginAt,
              };

              // Dirty check: Only write to Firestore if profile fields/status changed or lastLoginAt was stale
              // Fix LEAK #W2: Using deep equality check to prevent redundant writes
              const hasFieldChanges = JSON.stringify(currentData) !== JSON.stringify({...currentData, ...userProfile});

              if (hasFieldChanges) {
                console.log('[FIRESTORE WRITE COST] operation=profile_sync collection=employee_master reason=fields_changed_or_stale_login');
                await setDoc(userDocRef, userProfile, { merge: true });
              } else {
                console.log('[PROFILE SYNC SKIPPED] Profile up to date, skipping redundant Firestore write.');
              }
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
                    // Preserve the existing organizational membership
                    const finalStatus = currentData.status || (currentData.isActive === false ? 'Inactive' : 'Active');
                    const finalIsActive = currentData.isActive !== undefined ? currentData.isActive : (finalStatus !== 'Inactive' && finalStatus !== 'Archived' && finalStatus !== 'Suspended');
                    let finalRoleReg = (currentData.role || UserRole.AGENT).toUpperCase();
                    if (firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') {
                      finalRoleReg = 'ADMIN';
                    }
                    userProfile = {
                      ...currentData,
                      uid: firebaseUser.uid,
                      email: (firebaseUser.email || '').toLowerCase().trim(),
                      name: currentData.name || currentData.fullName || getCleanName(),
                      fullName: currentData.fullName || currentData.name || getCleanName(),
                      role: finalRoleReg,
                      status: finalStatus,
                      isActive: finalIsActive,
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
                const usersRef = collection(db, 'employee_master');
                const checkQuery = query(usersRef, where('email', '==', (firebaseUser.email || '').toLowerCase().trim()));
                const querySnap = await getDocsOptimized(checkQuery, 'pre_provision_check');
                
                if (!querySnap.empty) {
                  const matchedDoc = querySnap.docs[0];
                  console.log('Pre-provisioned user found. Triggering client-side profile linking and migration...', matchedDoc.id);
                  
                  const matchedData = matchedDoc.data() as any;
                  const isPreRestricted = matchedData.loginRestricted === true || matchedData.isRestricted === true || matchedData.isLoginRestricted === true || matchedData.status === 'Restricted';
                  const isSuperAdminPre = firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in';

                  if (isPreRestricted && !isSuperAdminPre) {
                    console.warn('[AUTH REJECTED] Pre-provisioned user login restricted by administrator:', firebaseUser.email);
                    const reasonMsg = matchedData.restrictedReason
                      ? `Access Denied: Your account login has been restricted by an administrator.\nReason: ${matchedData.restrictedReason}`
                      : 'Access Denied: Your account login has been restricted by an administrator. You cannot log into the application even with valid credentials.';
                    safeStorage.set('login_restriction_message', reasonMsg);
                    await signOut(auth);
                    setUser(null);
                    return;
                  }

                  // Preserve the existing organizational membership
                  const finalStatus = matchedData.status || (matchedData.isActive === false ? 'Inactive' : 'Active');
                  const finalIsActive = matchedData.isActive !== undefined ? matchedData.isActive : (finalStatus !== 'Inactive' && finalStatus !== 'Archived' && finalStatus !== 'Suspended');
                  
                  let finalRolePre = (matchedData.role || UserRole.AGENT).toUpperCase();
                  if (firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') {
                    finalRolePre = 'ADMIN';
                  }

                  userProfile = {
                    ...matchedData,
                    uid: firebaseUser.uid,
                    email: (firebaseUser.email || '').toLowerCase().trim(),
                    name: matchedData.name || matchedData.fullName || getCleanName(),
                    fullName: matchedData.fullName || matchedData.name || getCleanName(),
                    role: finalRolePre,
                    status: finalStatus,
                    isActive: finalIsActive,
                    department: matchedData.department || 'Operations',
                    Manager: matchedData.mappedManagerName || matchedData.managerName || '',
                    createdAt: matchedData.createdAt || now.toISOString(),
                    lastLoginAt: now.toISOString(),
                  };
                  
                  await setDoc(userDocRef, userProfile, { merge: true });
                  if (matchedDoc.id !== firebaseUser.uid) {
                    await deleteDoc(doc(db, 'employee_master', matchedDoc.id));
                  }
                  
                  console.log('Successfully completed client-side profile linking and migration.');
                } else {
                  console.log('No pre-provisioned profile, creating clean profile...');
                  const isEmail = firebaseUser.providerData.some(p => p.providerId === 'password');
                  userProfile = {
                    uid: firebaseUser.uid,
                    email: (firebaseUser.email || '').toLowerCase().trim(),
                    name: getCleanName(),
                    fullName: getCleanName(),
                    role: (firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') ? UserRole.ADMIN : UserRole.AGENT, // Default for first-time login
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

          // Sync Custom claims asynchronously in the background so security rules operate with zero Firestore document lookups
          syncCurrentUserClaims(userProfile.role).catch(err => {
            console.error('[AUTH CLAIMS] Error synchronizing claims:', err);
          });

          // Set up real-time snapshot listener for direct, immediate claims refreshing upon Admin action
          const userDocRef = doc(db, 'employee_master', firebaseUser.uid);
          unsubscribeProfile = onSnapshot(userDocRef, (snapshot) => {
            if (!snapshot.exists()) return;
            const liveData = snapshot.data();

            // Check live restriction status
            const isRestricted = liveData.loginRestricted === true || liveData.isRestricted === true || liveData.isLoginRestricted === true || liveData.status === 'Restricted';
            const isSuperAdmin = firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in';
            if (isRestricted && !isSuperAdmin) {
              console.warn('[AUTH REJECTED LIVE] User restriction updated, signing out...');
              signOut(auth).then(() => setUser(null));
              return;
            }

            // Check role update
            const liveRole = (liveData.role || 'AGENT').toUpperCase();
            setUser(prev => {
              if (prev && prev.role !== liveRole) {
                console.info(`[ROLE UPDATE DETECTED REALTIME] ${prev.role} -> ${liveRole}`);
                
                // Force custom claims token refresh
                firebaseUser.getIdToken(true).then(() => {
                  console.info('[ROLE CLAIMS REFRESHED REALTIME] Custom claims successfully synced.');
                }).catch(err => {
                  console.error('[ROLE CLAIMS REFRESHED REALTIME] Error refreshing token:', err);
                });

                // Clear IndexedDB & localStorage caches so the views refresh with correct data
                try {
                  safeStorage.clearAllIndexedDBByPrefix('precision360_hierarchy_nodes_');
                  safeStorage.clearAllIndexedDBByPrefix('subordinates_');
                  safeStorage.clearAllIndexedDBByPrefix(`precision360_roster_cache_${firebaseUser.uid}`);
                  localStorage.removeItem(`precision360_roster_cache_${firebaseUser.uid}`);
                  localStorage.removeItem(`precision360_roster_cache_${firebaseUser.uid}_profiles`);
                  localStorage.removeItem(`precision360_roster_cache_${firebaseUser.uid}_roles`);
                } catch (e) {
                  console.warn('Cache clear failed on role change:', e);
                }

                toast.info(`Your security role was updated to ${liveRole}. Workspace permissions refreshed.`);

                return {
                  ...prev,
                  role: liveRole,
                  ...liveData
                };
              }
              return prev;
            });
          }, (err) => {
            console.error('Real-time profile snapshot error:', err);
          });

        } catch (globalErr) {
          console.error("Global auth state error:", globalErr);
        }
      } else {
        setUser(null);
      }
    });

    return () => {
      unsubscribe();
      if (unsubscribeProfile) {
        unsubscribeProfile();
      }
    };
  }, []);

    if (user === undefined) {
      return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center gap-4 animate-in fade-in duration-300">
          <div className="bg-white rounded-2xl p-3 w-16 h-16 flex items-center justify-center shadow-lg shadow-indigo-500/10 animate-pulse">
            <img src="/berg_logo.png" alt="Berg Logo" className="h-12 w-auto object-contain" referrerPolicy="no-referrer" />
          </div>
          <div className="flex flex-col items-center gap-1 mt-2 text-center">
            <h1 className="font-extrabold text-white text-lg tracking-tight">Precision360</h1>
            <p className="text-[10px] text-indigo-400 font-bold tracking-widest uppercase">BERG TECHNOLOGIES</p>
          </div>
          <div className="flex items-center gap-2 mt-4 text-slate-400 text-xs font-medium">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-500" />
            <span>Verifying secure enterprise session...</span>
          </div>
        </div>
      );
    }

    if (!user) {
      return <LoginView onLogin={(user) => setUser(user)} />;
    }

    return (
      <ConfigProvider>
        <PermissionProvider user={effectiveUser! || realUserWithSyncedData!}>
          <div className="h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 flex flex-col md:flex-row antialiased font-sans overflow-hidden">
            <MainAppShell 
              user={realUserWithSyncedData!} 
              effectiveUser={effectiveUser! || realUserWithSyncedData!}
              setUser={setUser} 
              allUsers={allUsersWithPhotos} 
              viewAsRole={viewAsRole}
              setViewAsRole={setViewAsRole}
              theme={theme}
              setTheme={setTheme}
            />
          </div>
          <Toaster position="top-right" richColors />
        </PermissionProvider>
      </ConfigProvider>
    );
}

interface MainAppShellProps {
  user: UserProfile;
  effectiveUser: UserProfile;
  setUser: (u: UserProfile | null) => void;
  allUsers: UserProfile[];
  viewAsRole: string | null;
  setViewAsRole: (r: string | null) => void;
  theme: 'light' | 'dark';
  setTheme: React.Dispatch<React.SetStateAction<'light' | 'dark'>>;
}

function MainAppShell({ 
  user, 
  effectiveUser, 
  setUser, 
  allUsers, 
  viewAsRole, 
  setViewAsRole,
  theme,
  setTheme
}: MainAppShellProps) {
  const { globalRoster, roster, invalidateRosterCache } = useRoster();
  const globalUsers = globalRoster && globalRoster.length > 0 ? globalRoster : roster;
  
  const { isDashboardUser, isAdminUser, tmsSubViews } = useMemo(() => {
    const normRole = (effectiveUser?.role || '').toString().toUpperCase().trim();
    const leadKeywords = ['ADMIN', 'MANAGER', 'HEAD', 'HR', 'MIS', 'TL', 'LEAD', 'SME', 'TRAINER', 'EXECUTIVE', 'DIRECTOR', 'VP', 'SUPERVISOR', 'SUPERV', 'EXEC'];
    const isDash = leadKeywords.some(k => normRole.includes(k));
    const isAdmin = normRole.includes('ADMIN');

    const views = [
      { id: 'tms-agent', label: 'Punch Station', icon: Clock, show: true },
      { id: 'tms-monitor', label: 'TMS Dashboard', icon: Activity, show: isDash }
    ];

    return {
      isDashboardUser: isDash,
      isAdminUser: isAdmin,
      tmsSubViews: views.filter(v => v.show)
    };
  }, [effectiveUser]);

  // Console authorization: strictly restricted to Admin & MIS roles
  const isConsoleUser = useMemo(() => {
    const normRole = (effectiveUser?.role || '').toString().toUpperCase().trim();
    const realNormRole = (user?.role || '').toString().toUpperCase().trim();
    const allowed = ['ADMIN', 'MIS', 'SYSTEM_ADMIN'];
    return (
      allowed.includes(normRole) ||
      normRole.includes('ADMIN') ||
      normRole.includes('MIS') ||
      allowed.includes(realNormRole) ||
      realNormRole.includes('ADMIN') ||
      realNormRole.includes('MIS')
    );
  }, [effectiveUser, user]);

  // Route authorization checker guard
  const isViewAuthorized = (viewId: string) => {
    if (viewId === 'tms-agent' || viewId === 'kpi' || viewId === 'resource' || viewId === 'profile') {
      return true;
    }
    if (viewId === 'tms-monitor') {
      return isDashboardUser;
    }
    if (viewId === 'admin') {
      return isConsoleUser;
    }
    return false;
  };

  const getViewFromHash = () => {
    const rawHash = window.location.hash.replace('#', '').trim();
    if (rawHash && isViewAuthorized(rawHash)) {
      return rawHash;
    }
    return tmsSubViews[0]?.id || 'tms-agent';
  };

  const [currentView, setCurrentView] = useState<string>(() => getViewFromHash());

  const navigateToView = (viewId: string) => {
    if (isViewAuthorized(viewId)) {
      setCurrentView(viewId);
      if (window.location.hash !== `#${viewId}`) {
        window.history.pushState(null, '', `#${viewId}`);
      }
    }
  };

  // Listen to browser Back/Forward navigation (hashchange / popstate)
  useEffect(() => {
    const handleHashChange = () => {
      const targetView = getViewFromHash();
      if (targetView !== currentView) {
        setCurrentView(targetView);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    window.addEventListener('popstate', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      window.removeEventListener('popstate', handleHashChange);
    };
  }, [effectiveUser, isDashboardUser, currentView]);

  // Ensure valid authorized view when role or authorization changes
  useEffect(() => {
    const validView = isViewAuthorized(currentView) ? currentView : (tmsSubViews[0]?.id || 'tms-agent');
    if (validView !== currentView) {
      setCurrentView(validView);
    }
    if (window.location.hash !== `#${validView}`) {
      window.history.replaceState(null, '', `#${validView}`);
    }
  }, [currentView, effectiveUser, isDashboardUser]);

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('precision360-desktop-sidebar');
    return saved !== null ? saved === 'true' : true;
  });
  const [fontSize, setFontSize] = useState(() => {
    return localStorage.getItem('precision360-font-size') || 'standard';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (fontSize === 'medium') {
      root.style.fontSize = '14px';
    } else if (fontSize === 'compact') {
      root.style.fontSize = '12px';
    } else {
      root.style.fontSize = '16px';
    }
    localStorage.setItem('precision360-font-size', fontSize);
  }, [fontSize]);

  // Determine current active view title
  const viewTitle = useMemo(() => {
    if (currentView === 'tms-agent') return 'Punch Station';
    if (currentView === 'tms-monitor') return 'TMS Dashboard';
    switch (currentView) {
      case 'kpi': return 'KPI Scorecard';
      case 'resource': return 'Resource Hub';
      case 'admin': return 'Console';
      case 'profile': return 'My Profile';
      default: return 'Precision360';
    }
  }, [currentView]);

  // Dynamic document title, canonical link, and noindex protection for protected space
  useEffect(() => {
    document.title = `${viewTitle} | Precision360`;

    // Strictly protect internal workforce pages from search indexers
    const robotsMeta = document.querySelector('meta[name="robots"]');
    if (robotsMeta) {
      robotsMeta.setAttribute('content', 'noindex, nofollow, noarchive');
    }

    const canonicalLink = document.querySelector('link[rel="canonical"]');
    if (canonicalLink) {
      canonicalLink.setAttribute('href', `${window.location.origin}${window.location.pathname}#${currentView}`);
    }
  }, [currentView, viewTitle]);

  return (
    <>
      {/* Mobile Sidebar Backdrop */}
      {mobileSidebarOpen && (
        <div 
          className="fixed inset-0 bg-slate-950/60 z-40 md:hidden transition-opacity duration-300"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* Left Sidebar */}
      <div className={`
        fixed inset-y-0 left-0 bg-slate-950 text-slate-300 flex flex-col z-50 shrink-0 transition-all duration-300 transform overflow-hidden
        md:translate-x-0 md:sticky md:top-0 md:h-screen
        ${mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        ${desktopSidebarOpen ? 'w-64 border-r border-slate-900/60' : 'w-20 border-r border-slate-900/60'}
      `}>
        {/* Brand Header */}
        <div className={`p-4 border-b border-slate-900/60 flex items-center ${desktopSidebarOpen ? 'justify-between gap-3 min-w-[240px]' : 'justify-center'} transition-all duration-300`}>
          {desktopSidebarOpen ? (
            <div className="flex items-center gap-3">
              <div className="bg-white rounded-xl p-1.5 w-10 h-10 flex items-center justify-center shrink-0 shadow-md">
                <img src="/berg_logo.png" alt="Berg Logo" className="h-full w-auto object-contain" referrerPolicy="no-referrer" />
              </div>
              <div>
                <div className="font-extrabold text-white text-sm leading-tight tracking-tight">Precision360</div>
                <div className="text-[10px] text-indigo-400 font-bold tracking-widest leading-none mt-0.5">BERG TECHNOLOGIES</div>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-xl p-1.5 w-10 h-10 flex items-center justify-center shrink-0 shadow-md" title="Precision360 - Berg Technologies">
              <img src="/berg_logo.png" alt="Berg Logo" className="h-full w-auto object-contain" referrerPolicy="no-referrer" />
            </div>
          )}
          {desktopSidebarOpen && (
            <button
              onClick={() => {
                setDesktopSidebarOpen(false);
                localStorage.setItem('precision360-desktop-sidebar', 'false');
              }}
              className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-900 transition-colors hidden md:block"
              title="Collapse Sidebar"
            >
              <ChevronLeft size={16} />
            </button>
          )}
        </div>

        {/* Navigation Section */}
        <div className={`flex flex-col gap-1.5 p-3 flex-grow overflow-y-auto ${desktopSidebarOpen ? 'min-w-[240px]' : 'items-center'} transition-all duration-300`}>
          {/* TMS SubViews / Navigation Items */}
          {tmsSubViews.map(view => {
            const ViewIcon = view.icon;
            const isActive = currentView === view.id;
            return desktopSidebarOpen ? (
              <button
                key={view.id}
                onClick={() => {
                  navigateToView(view.id);
                  setMobileSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-bold rounded-xl transition-colors text-left ${
                  isActive
                    ? 'bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 font-extrabold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
                }`}
              >
                <ViewIcon size={16} className="text-indigo-400 shrink-0" />
                <span>{view.label}</span>
              </button>
            ) : (
              <button
                key={view.id}
                onClick={() => {
                  navigateToView(view.id);
                  setMobileSidebarOpen(false);
                }}
                className={`p-3 rounded-xl transition-colors ${
                  isActive
                    ? 'bg-indigo-600 text-white font-extrabold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
                }`}
                title={view.label}
              >
                <ViewIcon size={20} className="shrink-0" />
              </button>
            );
          })}

          {/* KPI Scorecard */}
          {desktopSidebarOpen ? (
            <button
              onClick={() => {
                navigateToView('kpi');
                setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-bold rounded-xl transition-colors text-left ${
                currentView === 'kpi'
                  ? 'bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 font-extrabold'
                  : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
              }`}
            >
              <Award size={16} className="text-indigo-400 shrink-0" />
              <span>KPI Scorecard</span>
            </button>
          ) : (
            <button
              onClick={() => {
                navigateToView('kpi');
                setMobileSidebarOpen(false);
              }}
              className={`p-3 rounded-xl transition-colors ${
                currentView === 'kpi'
                  ? 'bg-indigo-600 text-white font-extrabold'
                  : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
              }`}
              title="KPI Scorecard"
            >
              <Award size={20} className="shrink-0" />
            </button>
          )}

          {/* Resource Hub */}
          {desktopSidebarOpen ? (
            <button
              onClick={() => {
                navigateToView('resource');
                setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-bold rounded-xl transition-colors text-left ${
                currentView === 'resource'
                  ? 'bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 font-extrabold'
                  : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
              }`}
            >
              <Link2 size={16} className="text-indigo-400 shrink-0" />
              <span>Resource Hub</span>
            </button>
          ) : (
            <button
              onClick={() => {
                navigateToView('resource');
                setMobileSidebarOpen(false);
              }}
              className={`p-3 rounded-xl transition-colors ${
                currentView === 'resource'
                  ? 'bg-indigo-600 text-white font-extrabold'
                  : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
              }`}
              title="Resource Hub"
            >
              <Link2 size={20} className="shrink-0" />
            </button>
          )}

          {/* Console (Visible ONLY for Admin & MIS roles) */}
          {isConsoleUser && (
            desktopSidebarOpen ? (
              <button
                onClick={() => {
                  navigateToView('admin');
                  setMobileSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-bold rounded-xl transition-colors text-left ${
                  currentView === 'admin'
                    ? 'bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 font-extrabold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
                }`}
              >
                <Settings size={16} className="text-indigo-400 shrink-0" />
                <span>Console</span>
              </button>
            ) : (
              <button
                onClick={() => {
                  navigateToView('admin');
                  setMobileSidebarOpen(false);
                }}
                className={`p-3 rounded-xl transition-colors ${
                  currentView === 'admin'
                    ? 'bg-indigo-600 text-white font-extrabold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
                }`}
                title="Console Admin Panel"
              >
                <Settings size={20} className="shrink-0" />
              </button>
            )
          )}
        </div>

        {/* User Card at the Bottom of Sidebar */}
        {desktopSidebarOpen ? (
          <div className="p-4 border-t border-slate-900/60 bg-slate-950/60 flex items-center justify-between gap-3 shrink-0 min-w-[240px]">
            <div 
              className="flex items-center gap-2.5 cursor-pointer hover:opacity-85 transition-opacity overflow-hidden"
              onClick={() => navigateToView('profile')}
            >
              <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700/60 flex items-center justify-center text-xs font-bold text-slate-300 overflow-hidden shrink-0">
                {effectiveUser.profilePhotoUrl ? (
                  <img src={effectiveUser.profilePhotoUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  (effectiveUser.fullName || effectiveUser.name || 'U').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
                )}
              </div>
              <div className="overflow-hidden leading-tight">
                <div className="font-bold text-white text-xs truncate">{effectiveUser.fullName || effectiveUser.name}</div>
                <div className="text-[9px] text-slate-500 font-bold uppercase tracking-wider mt-0.5">{effectiveUser.role}</div>
              </div>
            </div>
            <button 
              onClick={() => logout()}
              className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-950/20 transition-colors shrink-0"
              title="Sign Out"
            >
              <LogOut size={16} />
            </button>
          </div>
        ) : (
          <div className="p-4 border-t border-slate-900/60 bg-slate-950/60 flex flex-col items-center gap-3 shrink-0">
            <div 
              className="cursor-pointer hover:opacity-85 transition-opacity overflow-hidden"
              onClick={() => navigateToView('profile')}
              title={`${effectiveUser.fullName || effectiveUser.name} (${effectiveUser.role}) - My Profile`}
            >
              <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700/60 flex items-center justify-center text-xs font-bold text-slate-300 overflow-hidden shrink-0">
                {effectiveUser.profilePhotoUrl ? (
                  <img src={effectiveUser.profilePhotoUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  (effectiveUser.fullName || effectiveUser.name || 'U').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
                )}
              </div>
            </div>
            <button 
              onClick={() => logout()}
              className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-950/20 transition-colors shrink-0"
              title="Sign Out"
            >
              <LogOut size={16} />
            </button>
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-grow flex flex-col w-full min-w-0 bg-slate-50 dark:bg-slate-950 overflow-hidden">
        {/* Top Header */}
        <header className="h-16 px-4 md:px-6 bg-white dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-900/80 flex items-center justify-between shrink-0 gap-4">
          
          {/* Header Left: Hamburger Toggle & Title */}
          <div className="flex items-center gap-3 shrink-0">
            {/* Mobile Hamburger Toggle */}
            <button 
              onClick={() => setMobileSidebarOpen(true)}
              className="p-1.5 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 md:hidden"
              title="Open Navigation"
            >
              <Menu size={20} />
            </button>
            
            {/* Desktop Hamburger Toggle */}
            <button 
              onClick={() => {
                const nextState = !desktopSidebarOpen;
                setDesktopSidebarOpen(nextState);
                localStorage.setItem('precision360-desktop-sidebar', String(nextState));
              }}
              className="p-1.5 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hidden md:block transition-all duration-200"
              title={desktopSidebarOpen ? "Collapse Navigation" : "Expand Navigation"}
            >
              <Menu size={20} />
            </button>

            <h1 className="text-base font-black text-slate-800 dark:text-white capitalize tracking-tight flex items-center gap-2">
              {viewTitle}
            </h1>
          </div>

          {/* Header Center: Exit Role Preview Banner */}
          {viewAsRole && (
            <div className="animate-pulse">
              <Button 
                onClick={() => setViewAsRole(null)}
                variant="destructive"
                size="sm"
                className="h-8 text-[9px] sm:text-xs font-black tracking-widest uppercase rounded-full px-4 py-1 flex items-center gap-1.5 shadow-md shadow-red-900/20 border border-red-500/30"
              >
                <Lock size={12} />
                PREVIEW ROLE: EXIT PREVIEW ({viewAsRole})
              </Button>
            </div>
          )}

          {/* Header Right Tools */}
          <div className="flex items-center gap-3 shrink-0">
            {/* Re-sync & Memory Cache Cleaner Button */}
            <button
              onClick={() => manualMemoryCleanAndSync()}
              className="h-8 px-2.5 rounded-xl border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30 text-[11px] font-bold flex items-center gap-1.5 transition-colors shrink-0"
              title="Prune stale memory cache & re-sync app state"
            >
              <RefreshCw size={13} />
              <span className="hidden md:inline">Re-sync & Clean</span>
            </button>

            {/* Admin Role Preview Tool (Only visible to real ADMIN) */}
            {user.role === 'ADMIN' && (
              <DropdownMenu>
                <DropdownMenuTrigger 
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "h-8 text-[11px] font-bold gap-1.5 border-indigo-500/20 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/5 hover:text-indigo-600 shrink-0"
                  )}
                >
                  <ShieldAlert size={14} />
                  <span className="hidden sm:inline">Preview As</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Preview Role Space</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setViewAsRole('AGENT')}>
                      Agent Space
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setViewAsRole('Team Lead')}>
                      Team Lead Space
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setViewAsRole('MANAGER')}>
                      Manager Space
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setViewAsRole('HR')}>
                      HR Space
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setViewAsRole('QA')}>
                      QA Space
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  {viewAsRole && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setViewAsRole(null)} className="text-red-500 font-bold">
                        Exit Preview
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Font Size / Text Density Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger className="p-1.5 rounded-xl border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors flex items-center justify-center cursor-pointer focus:outline-none shrink-0" title="Text density / Font size">
                <Type size={15} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Text Density</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setFontSize('standard')} className={cn("flex items-center justify-between", fontSize === 'standard' && "font-black text-indigo-600 dark:text-indigo-400")}>
                    <span>Standard Size (16px)</span>
                    {fontSize === 'standard' && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setFontSize('medium')} className={cn("flex items-center justify-between", fontSize === 'medium' && "font-black text-indigo-600 dark:text-indigo-400")}>
                    <span>Medium / Compact (14px)</span>
                    {fontSize === 'medium' && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setFontSize('compact')} className={cn("flex items-center justify-between", fontSize === 'compact' && "font-black text-indigo-600 dark:text-indigo-400")}>
                    <span>Extra Compact (12px)</span>
                    {fontSize === 'compact' && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Dark Mode Toggle */}
            <button
              onClick={() => setTheme(prev => prev === 'light' ? 'dark' : 'light')}
              className="p-1.5 rounded-xl border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
              title="Toggle theme"
            >
              {theme === 'dark' ? <Sun size={15} className="text-amber-400" /> : <Moon size={15} />}
            </button>

            {/* Active Role Badge */}
            <span className="hidden md:inline-block px-2.5 py-1 rounded-full bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 font-mono text-[9px] font-black uppercase tracking-wider border border-indigo-150/10 dark:border-indigo-900/40 shrink-0">
              {effectiveUser.role}
            </span>

            {/* Avatar & Name Profile Trigger */}
            <div 
              className="flex items-center gap-2 cursor-pointer hover:opacity-85 transition-opacity shrink-0"
              onClick={() => navigateToView('profile')}
            >
              <div className="w-8 h-8 rounded-full bg-indigo-50 dark:bg-slate-800 border border-indigo-100 dark:border-slate-800 flex items-center justify-center text-xs font-bold text-indigo-500 overflow-hidden shrink-0">
                {effectiveUser.profilePhotoUrl ? (
                  <img src={effectiveUser.profilePhotoUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  (effectiveUser.fullName || effectiveUser.name || 'U').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
                )}
              </div>
            </div>
          </div>

        </header>

        {/* View Router */}
        <main className={`flex-grow ${currentView.startsWith('tms-') ? 'overflow-hidden flex flex-col p-2 md:p-3 lg:p-3.5' : 'overflow-y-auto p-3.5 md:p-5 lg:p-6'} bg-slate-50 dark:bg-slate-950`}>
          {currentView.startsWith('tms-') && (
            <TMSView 
              user={effectiveUser} 
              allUsers={allUsers} 
              externalTheme={theme} 
              currentSubView={currentView}
              onNavigateSubView={(viewId) => navigateToView(viewId)}
            />
          )}
          {currentView === 'kpi' && <KPIScorecardView user={effectiveUser} allUsers={allUsers} externalTheme={theme} />}
          {currentView === 'resource' && <ResourceHubView user={effectiveUser} />}
          {currentView === 'admin' && (
            <AdminView 
              user={effectiveUser} 
              allUsers={globalUsers}
              goToTab={(tab) => {
                if (tab === 'tms') navigateToView(tmsSubViews[0]?.id || 'tms-agent');
                else if (tab === 'resource') navigateToView('resource');
                else if (tab === 'profile') navigateToView('profile');
              }}
              externalTheme={theme}
              onRefresh={invalidateRosterCache}
            />
          )}
          {currentView === 'profile' && (
            <MyProfileView 
              user={effectiveUser!} 
              allUsers={allUsers} 
              externalTheme={theme} 
            />
          )}
        </main>
      </div>
    </>
  );
}
