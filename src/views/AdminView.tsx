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
  RefreshCw,
  Activity,
  Shield
} from 'lucide-react';
import { db, auth } from '../lib/firebase';
import { doc, setDoc, addDoc, collection, writeBatch } from 'firebase/firestore';
import { UserProfile, UserRole } from '../types';
import { toast } from 'sonner';
import { usePermission } from '../components/PermissionContext';

// Subview imports
import { DashboardSubView } from '../components/admin/DashboardSubView';
import { UserManagementSubView } from '../components/admin/UserManagementSubView';
import { RolePermissionSubView } from '../components/admin/RolePermissionSubView';
import { TeamProcessMappingSubView } from '../components/admin/TeamProcessMappingSubView';
import { DataManagementSubView } from '../components/admin/DataManagementSubView';
import { BackupRestoreSubView } from '../components/admin/BackupRestoreSubView';
import { ProcessManagementSubView } from '../components/admin/ProcessManagementSubView';
import { AttendanceSettingsSubView } from '../components/admin/AttendanceSettingsSubView';
import { HierarchySyncWizard } from '../components/admin/HierarchySyncWizard';
import { EmailDashboardSubView } from '../components/admin/EmailDashboardSubView';

// Subview type definition
type SubTabType = 'dashboard' | 'users' | 'roles' | 'mapping' | 'process' | 'data' | 'backup' | 'attendancecfg' | 'hierarchy' | 'emailcfg';

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
  externalTheme?: 'light' | 'dark';
}

export default function AdminView({
  activeTab: mainTab,
  user: requesterUser,
  allUsers,
  onRefresh,
  externalTheme
}: AdminViewProps) {
  const { canView, canCreate, canEdit, canDelete } = usePermission();
  
  // Tab Routing inside Admin Console
  const [activeSubTab, setActiveSubTab] = useState<SubTabType>('dashboard');
  
  // Theme Toggle: Sync with global theme if provided, else manage locally
  const [adminTheme, setAdminTheme] = useState<'light' | 'dark'>(externalTheme || 'light');

  useEffect(() => {
    if (externalTheme) {
      setAdminTheme(externalTheme);
    }
  }, [externalTheme]);

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

  const subTabs = [
    { id: 'dashboard', label: 'Dashboard', icon: ShieldCheck, visible: true },
    { id: 'users', label: 'User Directory', icon: Users, visible: canEdit('Console') || canCreate('Console') },
    { id: 'process', label: 'Process Management', icon: Activity, visible: canEdit('Console') },
    { id: 'roles', label: 'Roles Matrix', icon: Settings, visible: canEdit('Console') },
    { id: 'mapping', label: 'Team Mapping', icon: RefreshCw, visible: canEdit('Console') },
    { id: 'data', label: 'Data Management', icon: Database, visible: canDelete('Console') },
    { id: 'attendancecfg', label: 'Attendance Rules', icon: FileText, visible: canEdit('Console') },
    { id: 'emailcfg', label: 'Email Portal', icon: FileText, visible: canEdit('Console') },
    { id: 'hierarchy', label: 'Hierarchy Repair', icon: Shield, visible: requesterUser.role === 'ADMIN' },
    { id: 'backup', label: 'Backup & Restore', icon: CloudLightning, visible: canEdit('Console') && canDelete('Console') }
  ] as const;

  const visibleSubTabs = subTabs.filter(t => t.visible);

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
        </div>
      </div>

      {/* Internal Navigation tabs */}
      <div className="flex overflow-x-auto gap-1 border-b border-slate-150/5 pb-2 scrollbar-none">
        {visibleSubTabs.map(tab => {
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

        {activeSubTab === 'process' && (
          <ProcessManagementSubView user={requesterUser} adminTheme={adminTheme} />
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

        {activeSubTab === 'emailcfg' && (
          <EmailDashboardSubView adminTheme={adminTheme} />
        )}

        {activeSubTab === 'attendancecfg' && (
          <AttendanceSettingsSubView />
        )}
        
        {activeSubTab === 'hierarchy' && (
          <HierarchySyncWizard 
            allUsers={allUsers} 
            adminTheme={adminTheme} 
            onRefresh={onRefresh || (() => {})} 
            logAdminEvent={logAdminEvent} 
          />
        )}
      </div>

    </div>
  );
}
