import React, { useState, useEffect } from 'react';
import { 
  Users, 
  Settings, 
  Database, 
  ShieldCheck, 
  FileText, 
  History, 
  CloudLightning,
  Sun,
  Moon,
  Upload,
  RefreshCw
} from 'lucide-react';
import { db, auth } from '../lib/firebase';
import { doc, setDoc, addDoc, collection, writeBatch } from 'firebase/firestore';
import { UserProfile, UserRole } from '../types';
import { toast } from 'sonner';

// Subview imports
import { DashboardSubView } from '../components/admin/DashboardSubView';
import { UserManagementSubView } from '../components/admin/UserManagementSubView';
import { RolePermissionSubView } from '../components/admin/RolePermissionSubView';
import { TeamProcessMappingSubView } from '../components/admin/TeamProcessMappingSubView';
import { AuditLogsSubView } from '../components/admin/AuditLogsSubView';
import { DataManagementSubView } from '../components/admin/DataManagementSubView';
import { BackupRestoreSubView } from '../components/admin/BackupRestoreSubView';

interface AdminViewProps {
  activeTab: string;
  tasks: any[];
  onTasksUpdate: (tasks: any[]) => void;
  user: UserProfile;
  alignments: any[];
  onAlignmentsUpdate: (alignments: any[]) => Promise<void>;
  productions: any[];
  auditLogs: any[];
  goToTab: (tab: string) => void;
  allUsers: any[];
  warnings: any[];
  onRefresh?: () => void;
}

export default function AdminView({
  activeTab: mainTab,
  user: requesterUser,
  allUsers,
  onRefresh
}: AdminViewProps) {
  
  // Tab Routing inside Admin Console
  const [activeSubTab, setActiveSubTab] = useState<'dashboard' | 'users' | 'roles' | 'mapping' | 'audits' | 'data' | 'backup'>('dashboard');
  
  // Theme Toggle: Premium and professional dark & light themes supported locally inside Administration
  const [adminTheme, setAdminTheme] = useState<'light' | 'dark'>('light');

  // Logs admin event helper
  const logAdminEvent = async (action: string, affectedUser: string, prevValue: string, newValue: string) => {
    try {
      const actor = auth.currentUser;
      const actorEmail = actor?.email || 'mayank.semwal@bergtechnologies.co.in';
      const actorName = actor?.displayName || actorEmail.split('@')[0];
      
      await addDoc(collection(db, 'adminAuditLogs'), {
        timestamp: new Date().toISOString(),
        performedBy: `${actorName} (${actorEmail})`,
        affectedUser: affectedUser || 'System/N/A',
        action,
        previousValue: prevValue || 'None',
        newValue: newValue || 'None'
      });
    } catch (err) {
      console.error('Failed to write administration audit trail log: ', err);
    }
  };

  // Sync Auth Users
  const handleSyncAuthUsers = async () => {
    const loader = toast.loading('Synchronizing Auth collection tables...');
    try {
      const response = await fetch('/api/sync-users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionStorage.getItem('idToken') || ''}`
        }
      });

      if (!response.ok) {
        throw new Error('API server rejected syncing protocol credentials.');
      }

      const data = await response.json();
      toast.success(`Successfully synchronized Auth. Synced ${data.syncedCount} new profiles.`);
      logAdminEvent('User Auth Integration Sync', 'Authorization Database', 'Sync Triggered', `Synced ${data.syncedCount} records`);
      
      if (onRefresh) onRefresh();
    } catch (err: any) {
      toast.error('Sync failed: ' + err.message);
    } finally {
      toast.dismiss(loader);
    }
  };

  // Preserved Demo Seeder procedure 
  const handleSeedDemoUsers = async () => {
    const loader = toast.loading('Seeding baseline demo profiles...');
    try {
      const demoUsers = [
        { uid: 'demo_tl_1', fullName: 'Satyen Vaishnavi', name: 'Satyen Vaishnavi', email: 'satyen.vaishnavi@bergtechnologies.co.in', role: 'TEAM_LEAD', employeeId: 'BT-TL11', department: 'Operations', process: 'Campaign Core', dateJoined: '2025-01-01', status: 'Active', isActive: true },
        { uid: 'demo_tl_2', fullName: 'Akshit Sodhi', name: 'Akshit Sodhi', email: 'akshit.sodhi@bergtechnologies.co.in', role: 'TEAM_LEAD', employeeId: 'BT-TL12', department: 'Operations', process: 'Mobile Verticals', dateJoined: '2025-01-05', status: 'Active', isActive: true },
        { uid: 'demo_mgr_1', fullName: 'Mayank Semwal', name: 'Mayank Semwal', email: 'mayank.semwal@bergtechnologies.co.in', role: 'ADMIN', employeeId: 'BT-MGR01', department: 'Management', process: 'Core Platform', dateJoined: '2024-06-01', status: 'Active', isActive: true },
        { uid: 'demo_agt_1', fullName: 'Aatish Gupta', name: 'Aatish Gupta', email: 'aatish.gupta@bergtechnologies.co.in', role: 'AGENT', employeeId: 'BT-AG01', department: 'Operations', process: 'Campaign Core', teamLeadId: 'demo_tl_1', teamLeadName: 'Satyen Vaishnavi', status: 'Active', isActive: true },
        { uid: 'demo_agt_2', fullName: 'Aaryan Gurung', name: 'Aaryan Gurung', email: 'aaryan.gurung@bergtechnologies.co.in', role: 'AGENT', employeeId: 'BT-AG02', department: 'Operations', process: 'Mobile Verticals', teamLeadId: 'demo_tl_2', teamLeadName: 'Akshit Sodhi', status: 'Active', isActive: true }
      ];

      const batch = writeBatch(db);
      demoUsers.forEach(u => {
        batch.set(doc(db, 'users', u.uid), u);
      });

      await batch.commit();
      toast.success('Demo organizational baseline profiles seeded successfully.');
      logAdminEvent('Organizational Demo Seeder Run', 'Enterprise Roster', 'Baseline', '5 Demo Accounts Pre-provisioned');
      
      if (onRefresh) onRefresh();
    } catch (err: any) {
      toast.error('Demo seeder failed to complete: ' + err.message);
    } finally {
      toast.dismiss(loader);
    }
  };

  // Nav arrays 
  const subTabs = [
    { id: 'dashboard', label: 'Dashboard', icon: ShieldCheck },
    { id: 'users', label: 'User Directory', icon: Users },
    { id: 'roles', label: 'Roles Matrix', icon: Settings },
    { id: 'mapping', label: 'Team Mapping', icon: RefreshCw },
    { id: 'audits', label: 'Audit Trail', icon: History },
    { id: 'data', label: 'Data Management', icon: Database },
    { id: 'backup', label: 'Backup & Restore', icon: CloudLightning }
  ] as const;

  // Root wrapper classes matching Local Theme values
  const themeClass = adminTheme === 'dark' 
    ? 'min-h-[calc(105vh-100px)] bg-slate-900 border border-slate-800 rounded-3xl p-6 text-slate-100 mt-2 space-y-6 antialiased' 
    : 'min-h-[calc(105vh-100px)] bg-slate-50 border border-slate-200 rounded-3xl p-6 text-slate-800 mt-2 space-y-6 antialiased';

  return (
    <div className={themeClass}>
      
      {/* Console top header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-150/10 dark:border-slate-800/60 pb-5">
        <div>
          <h2 className="text-xl font-black uppercase tracking-tight text-indigo-500 dark:text-indigo-400 flex items-center gap-2">
            🛡️ Precision360 Engineering Room
          </h2>
          <p className="text-xs text-slate-400 mt-1">Enterprise BPO Administration Portal & Security Core.</p>
        </div>

        {/* Header Tools */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Theme switcher */}
          <button 
            onClick={() => setAdminTheme(prev => prev === 'light' ? 'dark' : 'light')}
            className={`p-2 rounded-xl transition-colors cursor-pointer border ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700 text-amber-400 hover:bg-slate-705' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            title="Toggle Console Color Space"
          >
            {adminTheme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>

          {/* Sync Auth buttons */}
          <button 
            onClick={handleSyncAuthUsers}
            className={`px-3 py-1.5 text-xs font-bold rounded-xl border flex items-center gap-1.5 cursor-pointer ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700 hover:bg-slate-705 text-slate-200' : 'bg-white border-slate-202 hover:bg-slate-55'}`}
          >
            <RefreshCw size={12} className="animate-spin-slow animate-pulse" /> Sync Credentials
          </button>

          {/* Demo seeder */}
          <button 
            onClick={handleSeedDemoUsers} 
            className="px-3 py-1.5 text-xs font-bold rounded-xl cursor-pointer text-white bg-indigo-600 hover:bg-indigo-700 shadow-md flex items-center gap-1.5 flex-wrap"
          >
            <Upload size={12} /> Seed Core Demo Users
          </button>
        </div>
      </div>

      {/* Internal Navigation tabs */}
      <div className="flex overflow-x-auto gap-1 border-b border-slate-150/5 pb-2 scrollbar-none">
        {subTabs.map(tab => {
          const Icon = tab.icon;
          const isAct = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id)}
              className={`px-4 py-2 text-xs font-bold rounded-xl flex items-center gap-1.5 transition-all cursor-pointer shrink-0 ${
                isAct 
                  ? 'bg-indigo-600/10 text-indigo-500 border border-indigo-400/20' 
                  : 'hover:bg-slate-500/10 text-slate-400 border border-transparent'
              }`}
            >
              <Icon size={14} /> {tab.label}
            </button>
          );
        })}
      </div>

      {/* Render selected view */}
      <div className="animate-in fade-in-25 duration-300">
        {activeSubTab === 'dashboard' && (
          <DashboardSubView allUsers={allUsers} adminTheme={adminTheme} />
        )}
        
        {activeSubTab === 'users' && (
          <UserManagementSubView 
            allUsers={allUsers} 
            adminTheme={adminTheme} 
            onRefresh={onRefresh || (() => {})} 
            logAdminEvent={logAdminEvent}
          />
        )}

        {activeSubTab === 'roles' && (
          <RolePermissionSubView adminTheme={adminTheme} logAdminEvent={logAdminEvent} />
        )}

        {activeSubTab === 'mapping' && (
          <TeamProcessMappingSubView 
            allUsers={allUsers} 
            adminTheme={adminTheme} 
            onRefresh={onRefresh || (() => {})} 
            logAdminEvent={logAdminEvent} 
          />
        )}

        {activeSubTab === 'audits' && (
          <AuditLogsSubView adminTheme={adminTheme} />
        )}

        {activeSubTab === 'data' && (
          <DataManagementSubView 
            adminTheme={adminTheme} 
            onRefresh={onRefresh || (() => {})} 
            logAdminEvent={logAdminEvent} 
          />
        )}

        {activeSubTab === 'backup' && (
          <BackupRestoreSubView 
            adminTheme={adminTheme} 
            onRefresh={onRefresh || (() => {})} 
            logAdminEvent={logAdminEvent} 
          />
        )}
      </div>

    </div>
  );
}
