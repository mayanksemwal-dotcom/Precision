/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  ClipboardCheck, 
  BarChart3, 
  Settings, 
  MessageSquare, 
  ShieldAlert, 
  LogOut, 
  User as UserIcon,
  Menu,
  X,
  FileUp,
  History,
  Clock,
  Award,
  Link2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { UserRole, UserProfile, SamplingTask, AuditRecord, QAAlignment, ProductionRecord, WarningTicket, AgentKpiRecord } from './types';
import { INITIAL_ALIGNMENTS } from './lib/sample-data';
import { auth, db, logout } from './lib/firebase';
import { isFirestoreBlocked, handleFirestoreError } from './lib/safeFirestore';
import { OperationType } from './lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, getDocs, collection, query, where, orderBy, setDoc, updateDoc, deleteDoc, limit, onSnapshot } from 'firebase/firestore';
import { Database, RefreshCw, Activity } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
// Removed fetchArchiveReports import

// Views
import AdminView from './views/AdminView';
import LoginView from './views/LoginView';

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

import WarningsView from './views/WarningsView';
import TMSView from './views/TMSView';
import ScorecardView from './views/ScorecardView';
import PipView from './views/PipView';
import ManageHistoricalRecordsView from './views/ManageHistoricalRecordsView';
import ResourceHubView from './views/ResourceHubView';

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('tms');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewAsRole, setViewAsRole] = useState<UserRole | null>(null);
  const [tasks, setTasks] = useState<SamplingTask[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditRecord[]>([]);
  const [alignments, setAlignments] = useState<QAAlignment[]>(INITIAL_ALIGNMENTS);
  const [productions, setProductions] = useState<ProductionRecord[]>([]);
  const [warnings, setWarnings] = useState<WarningTicket[]>([]);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [agentKpis, setAgentKpis] = useState<AgentKpiRecord[]>([]);
  const [editingAudit, setEditingAudit] = useState<AuditRecord | null>(null);

  // Removed Archive Reports states

  // Firebase Auth Listener with Custom Claims synchronization
  useEffect(() => {
    console.log('Setting up Firebase Auth listener...');
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      console.log('onAuthStateChanged fired. User:', firebaseUser ? firebaseUser.email : 'null');
      if (firebaseUser) {
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
              
              userProfile = {
                ...currentData,
                uid: firebaseUser.uid,
                email: (firebaseUser.email || '').toLowerCase().trim(),
                name: currentData.name || currentData.fullName || getCleanName(),
                fullName: currentData.fullName || currentData.name || getCleanName(),
                role: currentData.role || UserRole.AGENT,
                status: currentData.status || 'Active',
                department: currentData.department || 'Operations',
                Manager: currentData.Manager || '',
                createdAt: currentData.createdAt || now.toISOString(),
                lastLoginAt: now.toISOString(), // Update last login
              };

              await setDoc(userDocRef, userProfile, { merge: true });
            } else {
              console.log('New user detected or profile missing, checking pre-provisioning...');
              const usersRef = collection(db, 'users');
              const checkQuery = query(usersRef, where('email', '==', (firebaseUser.email || '').toLowerCase().trim()));
              const querySnap = await getDocs(checkQuery);
              
              if (!querySnap.empty) {
                const matchedDoc = querySnap.docs[0];
                const matchedData = matchedDoc.data() as any;
                console.log('Pre-provisioned user found. Linking to Auth uid...', matchedDoc.id);
                
                userProfile = {
                  ...matchedData,
                  uid: firebaseUser.uid,
                  email: (firebaseUser.email || '').toLowerCase().trim(),
                  name: matchedData.name || matchedData.fullName || getCleanName(),
                  fullName: matchedData.fullName || matchedData.name || getCleanName(),
                  role: matchedData.role || UserRole.AGENT,
                  status: matchedData.status || 'Active',
                  department: matchedData.department || 'Operations',
                  Manager: matchedData.Manager || '',
                  createdAt: matchedData.createdAt || now.toISOString(),
                  lastLoginAt: now.toISOString(),
                };
                
                await setDoc(userDocRef, userProfile);
                if (matchedDoc.id !== firebaseUser.uid) {
                  await deleteDoc(doc(db, 'users', matchedDoc.id));
                }
              } else {
                console.log('No pre-provisioned profile, creating clean profile...');
                const isEmail = firebaseUser.providerData.some(p => p.providerId === 'password');
                userProfile = {
                  uid: firebaseUser.uid,
                  email: (firebaseUser.email || '').toLowerCase().trim(),
                  name: getCleanName(),
                  fullName: getCleanName(),
                  role: UserRole.AGENT,
                  status: 'Active',
                  department: 'Operations',
                  Manager: '',
                  createdAt: now.toISOString(),
                  lastLoginAt: now.toISOString(),
                  authProvider: isEmail ? 'email' : 'google',
                };
                await setDoc(userDocRef, userProfile);
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

              if (isCurrentAdmin !== expectedAdmin || isCurrentQA !== expectedQA) {
                console.log('Firebase user custom claims mismatch detected. Synchronizing claims...');
                const idToken = await firebaseUser.getIdToken(true);
                const claimResponse = await fetch('/api/set-claims', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`,
                  }
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

  const fetchAllData = async () => {
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

      // Create database query promises
      let warningsQuery: any;
      if (user.role === UserRole.ADMIN || user.role === UserRole.QA || user.role === UserRole.TEAM_LEAD) {
        warningsQuery = query(collection(db, 'disciplinaryLogs'), orderBy('createdAt', 'desc'), limit(25));
      } else {
        warningsQuery = query(collection(db, 'disciplinaryLogs'), where('agentId', '==', user.uid), orderBy('createdAt', 'desc'), limit(25));
      }
      const warningsPromise = getDocs(warningsQuery);

      // Execute fetches in parallel
      const [
        warningsSnap
      ] = await Promise.all([
        safeFetch(warningsPromise, null, 'warnings')
      ]);

      setAlignments(INITIAL_ALIGNMENTS);

      if (warningsSnap) {
        setWarnings(warningsSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) } as WarningTicket)));
      }

      setProductions([]);
      setAgentKpis([]);
      setAuditLogs([]);
      setTasks([]);

      toast.success('All reports loaded/refreshed successfully');
    } catch (error) {
      console.error('Data loading error:', error);
      handleFirestoreError(error, OperationType.LIST, 'all_data');
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (user) {
      fetchAllData();
    }
  }, [user, viewAsRole]);

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  // Real-time Users Listener for Admin Console
  useEffect(() => {
    if (!user) return;
    console.log('Setting up real-time users list listener...');
    const usersQuery = collection(db, 'users');
    const unsubscribe = onSnapshot(usersQuery, (snapshot) => {
      const usersList = snapshot.docs.map(doc => doc.data() as UserProfile);
      setAllUsers(usersList);
      console.log(`Real-time users sync: ${usersList.length} profiles loaded.`);
    }, (err) => {
      console.error('Users listener error:', err);
      handleFirestoreError(err, OperationType.LIST, 'users_realtime');
    });
    return () => unsubscribe();
  }, [user]);

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

  const navItems = [
    { id: 'tms', label: 'Workforce TMS', icon: Clock, roles: [UserRole.ADMIN, UserRole.MANAGER, UserRole.QA, UserRole.TEAM_LEAD, UserRole.AGENT] },
    { id: 'kpis_scorecard', label: 'KPI Scorecard', icon: Award, roles: [UserRole.ADMIN, UserRole.MANAGER, UserRole.QA, UserRole.TEAM_LEAD, UserRole.AGENT] },
    { id: 'warnings', label: 'Warnings', icon: ShieldAlert, roles: [UserRole.ADMIN, UserRole.MANAGER, UserRole.QA, UserRole.TEAM_LEAD, UserRole.AGENT] },
    { id: 'pips', label: 'PIP Management', icon: Activity, roles: [UserRole.ADMIN, UserRole.MANAGER, UserRole.QA, UserRole.TEAM_LEAD, UserRole.AGENT] },
    { id: 'historical', label: 'Historical Records', icon: History, roles: [UserRole.ADMIN] },
    { id: 'resources', label: 'Important Quality Links', icon: Link2, roles: [UserRole.ADMIN, UserRole.MANAGER, UserRole.QA, UserRole.TEAM_LEAD, UserRole.AGENT] },
    { id: 'config', label: 'Console', icon: Settings, roles: [UserRole.ADMIN, UserRole.MANAGER, UserRole.TEAM_LEAD] },
  ];

  const effectiveRole = viewAsRole || (user?.role || UserRole.AGENT);
  const filteredNav = navItems.filter(item => item.roles.includes(effectiveRole));
  const effectiveUser = user ? { ...user, role: effectiveRole } : null;

  return (
    <div className="flex h-screen bg-[#F8FAFC] overflow-hidden text-slate-900 font-sans">
      <Toaster position="top-right" />
      
      {/* Sidebar */}
      <motion.aside 
        initial={false}
        animate={{ width: sidebarOpen ? 280 : 80 }}
        className="bg-[#0F172A] border-r border-[#1E293B] flex flex-col z-30 text-[#CBD5E1]"
      >
        <div className="p-6 pb-4 flex flex-col items-center">
          <div className="w-full flex items-center justify-between mb-6">
            <div className={`flex items-center gap-3 ${!sidebarOpen && 'justify-center w-full'}`}>
              <div className="bg-white p-2 rounded-xl flex items-center justify-center shadow-lg border border-slate-100 flex-shrink-0">
                <BergLogo 
                  className={sidebarOpen ? 'h-7 w-20' : 'h-6 w-10'} 
                  showSubtitle={false} 
                />
              </div>
              {sidebarOpen && (
                <div className="flex flex-col min-w-0 overflow-hidden">
                  <span className="font-black text-lg leading-none tracking-tighter text-white truncate">Precision360</span>
                  <span className="text-[9px] font-bold text-sky-400 uppercase tracking-widest mt-1 opacity-90 truncate">Berg Technologies</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <nav className="flex-1 px-4 space-y-1.5">
          {filteredNav.map((item) => (
            <button
              key={item.id}
              id={`nav-${item.id}`}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-200 group text-sm ${
                activeTab === item.id 
                  ? 'bg-[#38BDF8] text-[#0F172A] font-bold shadow-md shadow-sky-500/10' 
                  : 'hover:bg-[#1E293B] hover:text-white'
              }`}
            >
              <item.icon size={18} className={activeTab === item.id ? 'text-[#0F172A]' : 'text-[#64748B] group-hover:text-white'} />
              {sidebarOpen && <span>{item.label}</span>}
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-[#1E293B]">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-[#1E293B] transition-colors group">
                  <div className="w-8 h-8 rounded-full bg-[#1E293B] group-hover:bg-[#334155] border border-[#334155] flex items-center justify-center">
                    <UserIcon size={16} className="text-[#CBD5E1]" />
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
        <header className="h-16 bg-white border-b border-[#E2E8F0] flex items-center justify-between px-8 sticky top-0 z-20">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-slate-50 rounded-lg text-[#64748B]"
            >
              {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
            <div className="flex items-center gap-2 text-sm text-[#64748B]">
               <span className="capitalize">{activeTab}</span>
               {activeTab === 'sampling' && (
                 <>
                   <span className="text-slate-300">/</span>
                   <span className="font-semibold text-[#0F172A]">Active Desk</span>
                 </>
               )}
            </div>
          </div>
          <div className="flex items-center gap-6">
             {user.role === UserRole.ADMIN && (
               <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-lg border border-slate-200">
                 <span className="text-[10px] font-bold text-slate-500 ml-2 uppercase">Preview as:</span>
                 {[UserRole.ADMIN, UserRole.MANAGER, UserRole.TEAM_LEAD, UserRole.QA, UserRole.AGENT].map(r => (
                   <button
                     key={r}
                     onClick={() => setViewAsRole(r as UserRole)}
                     className={`px-2 py-1 rounded text-[10px] font-black transition-all ${effectiveRole === r ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                   >
                     {r === UserRole.TEAM_LEAD ? 'TL' : r}
                   </button>
                 ))}
               </div>
             )}
             <div className="flex items-center gap-4">
                <div className="role-badge bg-[#F1F5F9] text-[#475569] px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">
                  {user.role}
                </div>
                <div className="flex items-center gap-3">
                   <span className="text-sm font-semibold text-[#1E293B]">{user.name}</span>
                   <div className="w-8 h-8 rounded-full bg-[#E2E8F0] border border-white shadow-sm flex items-center justify-center font-bold text-xs text-[#64748B]">
                     {user.name.split(' ').map(n => n[0]).join('')}
                   </div>
                </div>
             </div>
          </div>
        </header>

        {/* View Content */}
        <div className="flex-1 overflow-auto p-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={`${activeTab}-${effectiveRole}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="max-w-7xl mx-auto h-full"
            >
              {activeTab === 'tms' ? (
                <TMSView user={effectiveUser!} allUsers={allUsers} />
              ) : activeTab === 'kpis_scorecard' ? (
                <ScorecardView user={effectiveUser!} allUsers={allUsers} onRefreshAllData={fetchAllData} />
              ) : activeTab === 'warnings' ? (
                <WarningsView warnings={warnings} user={effectiveUser!} allUsers={allUsers} />
              ) : activeTab === 'pips' ? (
                <PipView user={effectiveUser!} allUsers={allUsers} />
              ) : activeTab === 'historical' ? (
                <ManageHistoricalRecordsView user={effectiveUser!} />
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
                />
              ) : (
                <div className="py-12 text-center text-slate-500 font-bold text-sm">
                  Module Not Registered
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>


    </div>
  );
}

