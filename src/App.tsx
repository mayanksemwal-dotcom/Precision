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

import { PermissionProvider, usePermission } from './components/PermissionContext';
import { canActOn } from './lib/hierarchy';

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

  // Removed direct userPermissions state since we'll use context

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
                role: (firebaseUser.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') ? 'ADMIN' : (currentData.role || UserRole.AGENT),
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
      const { canEdit: checkEdit } = await getDoc(doc(db, 'role_permissions', user.role)).then(d => d.data() as any || {});
      const hasManagementPrivilege = (role: string, module: string) => {
          // This is a bit tricky inside the parent App component where we don't have the context yet easily
          // But we can check the role_permissions document directly or use a helper.
          // Since we want to remove hardcoded role names, we'll assume if they can EDIT, they are management.
          return true; // Fallback for now, will refine
      };

      // Using a simpler check for now: if user is not an AGENT, they see more. 
      // But we want to avoid hardcoded 'AGENT' too.
      // Let's use a check for the 'canEdit' permission of the Warnings module.
      
      const permissionsDoc = await getDoc(doc(db, 'role_permissions', user.role));
      const perms = permissionsDoc.data();
      const canSeeAllWarnings = perms?.modules?.['Warnings']?.canEdit || perms?.modules?.['Warnings']?.canDelete || perms?.modules?.['Warnings']?.canApprove;

      if (canSeeAllWarnings) {
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
      if (['ADMIN', 'MANAGER'].includes((user.role || '').toUpperCase())) {
        setActiveTab('config');
      } else {
        setActiveTab('tms');
      }
      fetchAllData();
    }
  }, [user]);

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  // Real-time Employee Master (Single Source of Truth) Listener
  useEffect(() => {
    if (!user) return;
    console.log('Synchronizing with Employee Master (Single Source of Truth)...');
    const masterQuery = collection(db, 'employee_master');
    const unsubscribe = onSnapshot(masterQuery, (snapshot) => {
      const usersList = snapshot.docs.map(doc => {
        const data = doc.data() as any;
        return {
          uid: doc.id,
          ...data,
          // Normalize name across different possible field mappings for master data consistency
          name: data.fullName || data.name || data.employeeName || '',
          fullName: data.fullName || data.name || data.employeeName || '',
        } as UserProfile;
      });
      setAllUsers(usersList);
      console.log(`Employee Master Sync: ${usersList.length} records normalized and loaded.`);
    }, (err) => {
      console.error('Employee Master listener error:', err);
      handleFirestoreError(err, OperationType.LIST, 'employee_master_sync');
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

  return (
    <PermissionProvider user={user} overriddenRole={viewAsRole || undefined}>
      <AppContent 
        user={user}
        viewAsRole={viewAsRole}
        setViewAsRole={setViewAsRole}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        allUsers={allUsers}
        warnings={warnings}
        fetchAllData={fetchAllData}
        handleLogout={handleLogout}
      />
    </PermissionProvider>
  );
}

interface AppContentProps {
  user: UserProfile | null;
  viewAsRole: UserRole | null;
  setViewAsRole: (r: UserRole | null) => void;
  activeTab: string;
  setActiveTab: (t: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
  allUsers: UserProfile[];
  warnings: WarningTicket[];
  fetchAllData: () => Promise<void>;
  handleLogout: () => Promise<void>;
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
  handleLogout
}: AppContentProps) {
  const { canView, canEdit, loading: permissionsLoading } = usePermission();

  const navItems = [
    { id: 'tms', label: 'Workforce TMS', icon: Clock },
    { id: 'kpis_scorecard', label: 'KPI Scorecard', icon: Award },
    { id: 'warnings', label: 'Warnings', icon: ShieldAlert },
    { id: 'pips', label: 'PIP Management', icon: Activity },
    { id: 'historical', label: 'Historical Records', icon: History },
    { id: 'resources', label: 'Important Quality Links', icon: Link2 },
    { id: 'config', label: 'Console', icon: Settings },
  ];

  const effectiveRole = viewAsRole || (user?.role || UserRole.AGENT);
  
  // Dynamically filter navigation items using centralized PermissionService
  const filteredNav = navItems.filter(item => canView(item.label));

  const effectiveUser = user ? { ...user, role: effectiveRole } : null;

  return (
    <div className="flex flex-col h-screen overflow-hidden text-slate-900 font-sans bg-[#F8FAFC]">
      <Toaster position="top-right" />
      
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

        <nav className="flex-1 px-4 space-y-1.5 overflow-y-auto">
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
          {filteredNav.length === 0 && !permissionsLoading && (
            <div className="p-4 text-center text-xs text-rose-400 bg-rose-950/20 border border-rose-900/30 rounded-xl m-2 select-none">
              <ShieldAlert size={18} className="mx-auto mb-1 text-rose-400 animate-pulse" />
              {sidebarOpen ? 'No modules have been assigned to your role. Please contact your Administrator.' : 'Locked'}
            </div>
          )}
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
             {(user?.role?.toUpperCase() === 'ADMIN' || user?.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in' || viewAsRole !== null) && (
               <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-lg border border-slate-200">
                 <span className="text-[10px] font-bold text-slate-500 ml-2 uppercase">Preview as:</span>
                 {[UserRole.ADMIN, UserRole.MANAGER, UserRole.TEAM_LEAD, UserRole.QA, UserRole.AGENT].map(r => (
                   <button
                     key={r}
                     onClick={() => setViewAsRole(r === UserRole.ADMIN ? null : (r as UserRole))}
                     className={`px-2 py-1 rounded text-[10px] font-black transition-all ${effectiveRole === r ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                   >
                     {r === UserRole.TEAM_LEAD ? 'TL' : r}
                   </button>
                 ))}
               </div>
             )}
             <div className="flex items-center gap-4">
                <div className="role-badge bg-[#F1F5F9] text-[#475569] px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">
                  {effectiveRole} {viewAsRole ? '(Preview)' : ''}
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
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  </div>
  );
}

