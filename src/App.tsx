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
  History
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { UserRole, UserProfile, SamplingTask, AuditRecord, QAAlignment, ProductionRecord, WarningTicket } from './types';
import { INITIAL_ALIGNMENTS } from './lib/sample-data';
import { auth, db, logout, handleFirestoreError, OperationType } from './lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, onSnapshot, collection, query, where, orderBy, setDoc } from 'firebase/firestore';

// Views
import AdminView from './views/AdminView';
import QAView from './views/QAView';
import TeamLeadView from './views/TeamLeadView';
import AgentView from './views/AgentView';
import LoginView from './views/LoginView';

// UI Components
import { Button } from './components/ui/button';
import { Toaster } from './components/ui/sonner';
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

  // Firebase Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Try to get existing profile
        const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        if (userDoc.exists()) {
          setUser(userDoc.data() as UserProfile);
        } else {
          // New user defaults to AGENT
          const newProfile: UserProfile = {
            uid: firebaseUser.uid,
            email: firebaseUser.email || '',
            name: firebaseUser.displayName || 'New User',
            role: UserRole.AGENT,
          };
          // Bootstrapped Admin check
          if (firebaseUser.email === 'mayank.semwal@bergtechnologies.co.in') {
            newProfile.role = UserRole.ADMIN;
          }
          await setDoc(doc(db, 'users', firebaseUser.uid), newProfile);
          setUser(newProfile);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;

    // Listen to Users (for dropdowns)
    const unsubscribeUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
      setAllUsers(snapshot.docs.map(doc => doc.data() as UserProfile));
    });

    // Listen to Alignments
    const unsubscribeAlignments = onSnapshot(doc(db, 'config', 'alignments'), (docSnap) => {
      if (docSnap.exists()) {
        setAlignments(docSnap.data().list || []);
      } else if (user.role === UserRole.ADMIN) {
        // Initialize with sample data if first time and user is admin
        setDoc(doc(db, 'config', 'alignments'), { list: INITIAL_ALIGNMENTS })
          .catch(e => handleFirestoreError(e, OperationType.WRITE, 'config/alignments'));
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'config/alignments');
    });

    // Listen to Tasks
    const tasksQuery = query(collection(db, 'tasks'), orderBy('createdAt', 'desc'));
    const unsubscribeTasks = onSnapshot(tasksQuery, (snapshot) => {
      const taskData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SamplingTask));
      setTasks(taskData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'tasks');
    });

    // Listen to Audits
    let auditsQuery;
    if (user.role === UserRole.ADMIN || user.role === UserRole.QA) {
      auditsQuery = query(collection(db, 'audits'), orderBy('auditDate', 'desc'));
    } else {
      auditsQuery = query(collection(db, 'audits'), where('agentId', '==', user.uid), orderBy('auditDate', 'desc'));
    }
    
    const unsubscribeAudits = onSnapshot(auditsQuery, (snapshot) => {
      const audits = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AuditRecord));
      setAuditLogs(audits);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'audits');
    });

    // Listen to Productions
    const unsubscribeProductions = onSnapshot(collection(db, 'production'), (snapshot) => {
      setProductions(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ProductionRecord)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'production');
    });

    // Listen to Warnings
    let warningsQuery;
    if (user.role === UserRole.ADMIN || user.role === UserRole.QA || user.role === UserRole.TEAM_LEAD) {
      warningsQuery = collection(db, 'warnings');
    } else {
      warningsQuery = query(collection(db, 'warnings'), where('agentId', '==', user.uid));
    }

    const unsubscribeWarnings = onSnapshot(warningsQuery, (snapshot) => {
      setWarnings(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as WarningTicket)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'warnings');
    });

    return () => {
      unsubscribeAlignments();
      unsubscribeTasks();
      unsubscribeAudits();
      unsubscribeProductions();
      unsubscribeWarnings();
    };
  }, [user]);

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

  return (
    <div className="flex h-screen bg-[#F8FAFC] overflow-hidden text-slate-900 font-sans">
      <Toaster position="top-right" />
      
      {/* Sidebar */}
      <motion.aside 
        initial={false}
        animate={{ width: sidebarOpen ? 260 : 80 }}
        className="bg-[#0F172A] border-r border-[#1E293B] flex flex-col z-30 text-[#CBD5E1]"
      >
        <div className="p-8 pb-4 flex flex-col items-center">
          <div className="w-full flex items-center justify-between mb-8">
            <div className={`flex items-center gap-3 ${!sidebarOpen && 'justify-center w-full'}`}>
              <div className="bg-white p-2.5 rounded-2xl flex items-center justify-center shadow-md border border-slate-200/50">
                <img 
                  src="/berg_logo.png" 
                  alt="Berg Logo" 
                  className={`${sidebarOpen ? 'h-8' : 'h-7'} object-contain`}
                  referrerPolicy="no-referrer"
                />
              </div>
              {sidebarOpen && (
                <div className="flex flex-col ml-1">
                  <span className="font-black text-xl leading-none tracking-tighter text-white">Precision360</span>
                  <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest mt-1 opacity-90">Berg Technologies</span>
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
                <DropdownMenuItem onClick={handleLogout} variant="destructive">
                  <LogOut size={16} className="mr-2" />
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
                <TeamLeadView activeTab={activeTab} tasks={tasks} auditLogs={auditLogs} productions={productions} user={user} alignments={alignments} goToTab={setActiveTab} />
              ) : activeTab === 'completed_audits' ? (
                <CompletedAuditsView auditLogs={auditLogs} user={user} alignments={alignments} />
              ) : activeTab === 'disputes' ? (
                <DisputesView 
                  auditLogs={auditLogs} 
                  user={user} 
                  onEditAudit={(audit) => {
                    setEditingAudit(audit);
                    setActiveTab('sampling');
                  }}
                />
              ) : activeTab === 'warnings' ? (
                <WarningsView warnings={warnings} user={user} allUsers={allUsers} />
              ) : activeTab === 'error_feedbacks' ? (
                <ErrorFeedbacksView auditLogs={auditLogs} user={user} alignments={alignments} />
              ) : (
                <>
                  {(effectiveRole === UserRole.ADMIN || (effectiveRole === UserRole.TEAM_LEAD && activeTab === 'config')) && (
                    <AdminView 
                      activeTab={activeTab} 
                      tasks={tasks} 
                      onTasksUpdate={() => {}} 
                      user={user}
                      alignments={alignments}
                      onAlignmentsUpdate={async (newAligns) => {
                        await setDoc(doc(db, 'config', 'alignments'), { list: newAligns });
                      }}
                      productions={productions}
                      auditLogs={auditLogs}
                      goToTab={setActiveTab}
                    />
                  )}
                  {(effectiveRole === UserRole.QA) && (
                    <QAView 
                      activeTab={activeTab} 
                      tasks={tasks} 
                      onTasksUpdate={() => {}} 
                      onAuditUpdate={() => {}} 
                      user={user}
                      alignments={alignments}
                      productions={productions}
                      auditLogs={auditLogs}
                      goToTab={setActiveTab}
                      editingAudit={editingAudit}
                      onCancelEdit={() => setEditingAudit(null)}
                    />
                  )}
                  {effectiveRole === UserRole.TEAM_LEAD && activeTab !== 'config' && <TeamLeadView activeTab={activeTab} tasks={tasks} auditLogs={auditLogs} productions={productions} user={user} alignments={alignments} goToTab={setActiveTab} />}
                  {effectiveRole === UserRole.AGENT && <AgentView activeTab={activeTab} audits={auditLogs} user={user} />}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

