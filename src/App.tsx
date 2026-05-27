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
  Clock
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { UserRole, UserProfile, SamplingTask, AuditRecord, QAAlignment, ProductionRecord, WarningTicket } from './types';
import { INITIAL_ALIGNMENTS } from './lib/sample-data';
import { auth, db, logout, handleFirestoreError, OperationType } from './lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, getDocs, collection, query, where, orderBy, setDoc } from 'firebase/firestore';
import { Database, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
import { fetchArchiveReports } from './lib/sheets';

// Views
import AdminView from './views/AdminView';
import QAView from './views/QAView';
import TeamLeadView from './views/TeamLeadView';
import AgentView from './views/AgentView';
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

import CompletedAuditsView from './views/CompletedAuditsView';
import ErrorFeedbacksView from './views/ErrorFeedbacksView';
import DisputesView from './views/DisputesView';
import WarningsView from './views/WarningsView';
import TMSView from './views/TMSView';

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewAsRole, setViewAsRole] = useState<UserRole | null>(null);
  const [tasks, setTasks] = useState<SamplingTask[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditRecord[]>([]);
  const [alignments, setAlignments] = useState<QAAlignment[]>(INITIAL_ALIGNMENTS);
  const [productions, setProductions] = useState<ProductionRecord[]>([]);
  const [warnings, setWarnings] = useState<WarningTicket[]>([]);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [editingAudit, setEditingAudit] = useState<AuditRecord | null>(null);

  // Archive Reports sheets logic
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveRows, setArchiveRows] = useState<any[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archivePage, setArchivePage] = useState(1);

  // Firebase Auth Listener with Custom Claims synchronization
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Try to get existing profile
        const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        let userProfile: UserProfile;
        if (userDoc.exists()) {
          userProfile = userDoc.data() as UserProfile;
        } else {
          // Check if this email already exists under a different UID
          if (firebaseUser.email) {
            const q = query(collection(db, 'users'), where('email', '==', firebaseUser.email.toLowerCase().trim()));
            const querySnapshot = await getDocs(q);
            if (!querySnapshot.empty) {
              toast.error(`The email ID "${firebaseUser.email}" is already registered. Please sign in with your original method.`);
              await logout();
              setUser(null);
              setLoading(false);
              return;
            }
          }

          // New user defaults to AGENT
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

          userProfile = {
            uid: firebaseUser.uid,
            email: firebaseUser.email || '',
            name: getCleanName(),
            role: UserRole.AGENT,
          };
          // Bootstrapped Admin check
          if (firebaseUser.email === 'mayank.semwal@bergtechnologies.co.in') {
            userProfile.role = UserRole.ADMIN;
          }
          await setDoc(doc(db, 'users', firebaseUser.uid), userProfile);
        }

        setUser(userProfile);

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
              if (claimResponse.ok) {
                const claimsResult = await claimResponse.json();
                console.log('Successfully updated Firebase custom user claims via Express API backend:', claimsResult);
                // Force refresh local token so firebase is aware of claims changes globally
                await firebaseUser.getIdTokenResult(true);
              }
            } else {
              console.log('Firebase user custom claims already in sync. Skipping sync operations.');
            }
          } catch (claimsErr) {
            console.error('Failed to update Custom Firebase auth claims on login:', claimsErr);
          }
        })();
      } else {
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
      // Create all database query promises to execute in parallel
      const usersPromise = getDocs(collection(db, 'users'));
      const alignmentsPromise = getDoc(doc(db, 'config', 'alignments'));
      
      const tasksQuery = query(collection(db, 'tasks'), orderBy('createdAt', 'desc'));
      const tasksPromise = getDocs(tasksQuery);

      let auditsQuery;
      if (user.role === UserRole.ADMIN || user.role === UserRole.QA || user.role === UserRole.TEAM_LEAD) {
        auditsQuery = query(collection(db, 'audits'), orderBy('auditDate', 'desc'));
      } else {
        auditsQuery = query(collection(db, 'audits'), where('agentId', '==', user.uid), orderBy('auditDate', 'desc'));
      }
      const auditsPromise = getDocs(auditsQuery);

      const prodPromise = getDocs(collection(db, 'production'));

      let warningsQuery;
      if (user.role === UserRole.ADMIN || user.role === UserRole.QA || user.role === UserRole.TEAM_LEAD) {
        warningsQuery = collection(db, 'warnings');
      } else {
        warningsQuery = query(collection(db, 'warnings'), where('agentId', '==', user.uid));
      }
      const warningsPromise = getDocs(warningsQuery);

      // Execute all fetches in parallel to resolve waterfall latency issues
      const [
        usersSnap,
        alignmentsDoc,
        tasksSnap,
        auditsSnap,
        prodSnap,
        warningsSnap
      ] = await Promise.all([
        usersPromise,
        alignmentsPromise,
        tasksPromise,
        auditsPromise,
        prodPromise,
        warningsPromise
      ]);

      // Map and update state in one batch
      setAllUsers(usersSnap.docs.map(doc => doc.data() as UserProfile));

      if (alignmentsDoc.exists()) {
        setAlignments(alignmentsDoc.data().list || []);
      } else if (user.role === UserRole.ADMIN) {
        setDoc(doc(db, 'config', 'alignments'), { list: INITIAL_ALIGNMENTS })
          .then(() => setAlignments(INITIAL_ALIGNMENTS))
          .catch(e => handleFirestoreError(e, OperationType.WRITE, 'config/alignments'));
      }

      setTasks(tasksSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) } as SamplingTask)));
      setAuditLogs(auditsSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) } as AuditRecord)));
      setProductions(prodSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) } as ProductionRecord)));
      setWarnings(warningsSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) } as WarningTicket)));

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

  const handleOpenArchive = async () => {
    setArchiveOpen(true);
    setArchiveLoading(true);
    try {
      const rows = await fetchArchiveReports();
      setArchiveRows(rows);
      setArchivePage(1);
      toast.success(`Loaded ${rows.length} records from Google Sheets spreadsheet`);
    } catch (err: any) {
      toast.error('Failed to load archive sheet: ' + (err.message || String(err)));
    } finally {
      setArchiveLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

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
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: [UserRole.ADMIN, UserRole.QA, UserRole.TEAM_LEAD, UserRole.AGENT] },
    { id: 'tms', label: 'Workforce TMS', icon: Clock, roles: [UserRole.ADMIN, UserRole.QA, UserRole.TEAM_LEAD, UserRole.AGENT] },
    { id: 'sampling', label: 'Audit Desk', icon: ClipboardCheck, roles: [UserRole.ADMIN, UserRole.QA] },
    { id: 'feedback', label: 'Feedback', icon: MessageSquare, roles: [UserRole.AGENT] },
    { id: 'error_feedbacks', label: 'Feedbacks', icon: MessageSquare, roles: [UserRole.ADMIN, UserRole.QA, UserRole.TEAM_LEAD] },
    { id: 'disputes', label: 'Disputes', icon: ShieldAlert, roles: [UserRole.ADMIN, UserRole.QA, UserRole.TEAM_LEAD] },
    { id: 'reports', label: 'Reports', icon: BarChart3, roles: [UserRole.ADMIN, UserRole.TEAM_LEAD, UserRole.QA] },
    { id: 'warnings', label: 'Warnings', icon: ShieldAlert, roles: [UserRole.ADMIN, UserRole.QA, UserRole.TEAM_LEAD, UserRole.AGENT] },
    { id: 'config', label: 'Console', icon: Settings, roles: [UserRole.ADMIN, UserRole.TEAM_LEAD] },
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
             <Button
               variant="outline"
               size="sm"
               disabled={isRefreshing}
               onClick={fetchAllData}
               className="font-bold border-slate-200 hover:bg-slate-100 h-9 gap-2 shadow-sm text-slate-700 bg-white"
             >
               <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
               {isRefreshing ? "Refreshing..." : "Load Reports"}
             </Button>

             {(effectiveRole === UserRole.ADMIN || effectiveRole === UserRole.QA || effectiveRole === UserRole.TEAM_LEAD) && (
               <Button
                 variant="outline"
                 size="sm"
                 onClick={handleOpenArchive}
                 className="font-black h-9 gap-2 border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-800 shadow-sm bg-white"
               >
                 <Database size={14} />
                 Archive Reports
               </Button>
             )}

             {user.role === UserRole.ADMIN && (
               <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-lg border border-slate-200">
                 <span className="text-[10px] font-bold text-slate-500 ml-2 uppercase">Preview as:</span>
                 {[UserRole.ADMIN, UserRole.TEAM_LEAD, UserRole.QA, UserRole.AGENT].map(r => (
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
              {activeTab === 'reports' ? (
                <TeamLeadView activeTab={activeTab} tasks={tasks} auditLogs={auditLogs} productions={productions} user={effectiveUser!} alignments={alignments} goToTab={setActiveTab} allUsers={allUsers} />
              ) : activeTab === 'completed_audits' ? (
                <CompletedAuditsView auditLogs={auditLogs} user={effectiveUser!} alignments={alignments} />
              ) : activeTab === 'disputes' ? (
                <DisputesView 
                  auditLogs={auditLogs} 
                  user={effectiveUser!} 
                  onEditAudit={(audit) => {
                    setEditingAudit(audit);
                    setActiveTab('sampling');
                  }}
                />
              ) : activeTab === 'warnings' ? (
                <WarningsView warnings={warnings} user={effectiveUser!} allUsers={allUsers} />
              ) : activeTab === 'tms' ? (
                <TMSView user={effectiveUser!} allUsers={allUsers} />
              ) : activeTab === 'error_feedbacks' ? (
                <ErrorFeedbacksView auditLogs={auditLogs} user={effectiveUser!} alignments={alignments} />
              ) : (
                <>
                  {(effectiveRole === UserRole.ADMIN || (effectiveRole === UserRole.TEAM_LEAD && activeTab === 'config')) && (
                    <AdminView 
                      activeTab={activeTab} 
                      tasks={tasks} 
                      onTasksUpdate={() => {}} 
                      user={effectiveUser!}
                      alignments={alignments}
                      onAlignmentsUpdate={async (newAligns) => {
                        await setDoc(doc(db, 'config', 'alignments'), { list: newAligns });
                      }}
                      productions={productions}
                      auditLogs={auditLogs}
                      goToTab={setActiveTab}
                      allUsers={allUsers}
                    />
                  )}
                  {(effectiveRole === UserRole.QA) && (
                    <QAView 
                      activeTab={activeTab} 
                      tasks={tasks} 
                      onTasksUpdate={() => {}} 
                      onAuditUpdate={() => {}} 
                      user={effectiveUser!}
                      alignments={alignments}
                      productions={productions}
                      auditLogs={auditLogs}
                      goToTab={setActiveTab}
                      editingAudit={editingAudit}
                      onCancelEdit={() => setEditingAudit(null)}
                    />
                  )}
                  {effectiveRole === UserRole.TEAM_LEAD && activeTab !== 'config' && <TeamLeadView activeTab={activeTab} tasks={tasks} auditLogs={auditLogs} productions={productions} user={effectiveUser!} alignments={alignments} goToTab={setActiveTab} allUsers={allUsers} />}
                  {effectiveRole === UserRole.AGENT && <AgentView activeTab={activeTab} audits={auditLogs} user={effectiveUser!} />}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* Archive Reports Google Sheets Dialog Modal */}
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent className="max-w-5xl max-h-[85vh] overflow-hidden flex flex-col p-6 [id^='dialog-content-']">
          <div className="border-b pb-4">
            <h3 className="text-xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
              <Database size={22} className="text-blue-600" />
              Google Sheets Archive Reports
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Directly reading from Google Sheets without hitting Firestore (Standard Free JSON API fetching)
            </p>
          </div>

          <div className="flex-1 overflow-auto my-4 min-h-[300px]">
            {archiveLoading ? (
              <div className="flex flex-col items-center justify-center h-full py-12 gap-3 min-h-[300px]">
                <div className="animate-spin text-blue-600">
                  <RefreshCw size={36} />
                </div>
                <span className="text-sm font-bold text-slate-500 animate-pulse">Requesting Google sheets archive rows...</span>
              </div>
            ) : archiveRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-12 text-slate-400 min-h-[300px]">
                <Database size={48} className="stroke-1 mb-2" />
                <p className="text-sm">No archive rows returned or spreadsheet data is empty.</p>
              </div>
            ) : (
              <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <div className="max-h-[50vh] overflow-y-auto">
                  <Table>
                    <TableHeader className="bg-slate-50 sticky top-0 z-10 font-bold text-slate-600">
                      <TableRow>
                        {Object.keys(archiveRows[0] || {}).map((colName) => (
                          <TableHead key={colName} className="text-xs font-black uppercase text-slate-700 py-3.5 px-4 h-auto">
                            {colName}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {archiveRows.slice((archivePage - 1) * 10, archivePage * 10).map((row, rowIndex) => (
                        <TableRow key={rowIndex} className="hover:bg-slate-50/50 transition-colors">
                          {Object.values(row).map((val: any, colIndex) => (
                            <TableCell key={colIndex} className="text-xs text-slate-600 font-medium py-3 px-4 max-w-[200px] truncate" title={val !== null && val !== undefined ? String(val) : ''}>
                              {val !== null && val !== undefined ? String(val) : '-'}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>

          {archiveRows.length > 0 && !archiveLoading && (
            <div className="flex items-center justify-between border-t border-slate-100 pt-4">
              <span className="text-xs font-bold text-slate-500">
                Showing {Math.min(archiveRows.length, (archivePage - 1) * 10 + 1)}-{Math.min(archiveRows.length, archivePage * 10)} of {archiveRows.length} archive entries
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={archivePage === 1}
                  onClick={() => setArchivePage(p => Math.max(1, p - 1))}
                  className="h-8 font-bold text-xs"
                >
                  Previous Page
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={archivePage * 10 >= archiveRows.length}
                  onClick={() => setArchivePage(p => p + 1)}
                  className="h-8 font-bold text-xs"
                >
                  Next Page
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

