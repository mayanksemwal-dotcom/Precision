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
  Shield,
  Wifi,
  RotateCcw
} from 'lucide-react';
import { db, auth } from '../lib/firebase';
import { doc, setDoc, addDoc, collection, writeBatch } from 'firebase/firestore';
import { UserProfile, UserRole } from '../types';
import { toast } from 'sonner';
import { usePermission } from '../components/PermissionContext';
import { useConfig } from '../contexts/ConfigContext';

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
import { OfficeNetworksSubView } from '../components/admin/OfficeNetworksSubView';
import { ShiftRecoverySubView } from '../components/admin/ShiftRecoverySubView';

// Subview type definition
type SubTabType = 'dashboard' | 'users' | 'roles' | 'mapping' | 'process' | 'data' | 'backup' | 'attendancecfg' | 'hierarchy' | 'officenetworks' | 'shiftrecovery';

interface AdminViewProps {
  activeTab?: string;
  tasks?: any[];
  onTasksUpdate?: (tasks: any[]) => void;
  user: UserProfile;
  alignments?: any[];
  onAlignmentsUpdate?: (alignments: any[]) => Promise<void>;
  productions?: any[];
  auditLogs?: any[];
  goToTab?: (tab: string) => void;
  allUsers: any[];
  warnings?: any[];
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const { refreshAll, lastRefresh } = useConfig();

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
      
      // Safety truncation to prevent Firestore 1MB document size limit errors
      // Max size is 1,048,576 bytes. We'll cap each value at 250KB to be safe.
      const MAX_LOG_LENGTH = 250000;
      
      const safePrev = (prevValue && prevValue.length > MAX_LOG_LENGTH) 
        ? prevValue.substring(0, MAX_LOG_LENGTH) + '... [TRUNCATED DUE TO SIZE]'
        : (prevValue || 'None');
        
      const safeNext = (newValue && newValue.length > MAX_LOG_LENGTH)
        ? newValue.substring(0, MAX_LOG_LENGTH) + '... [TRUNCATED DUE TO SIZE]'
        : (newValue || 'None');

      console.log('[ADMIN EVENT LOG] (Firestore Logging Disabled):', {
        timestamp: new Date().toISOString(),
        performedBy: `${actorName} (${actorEmail})`,
        affectedUser: affectedUser || 'System/N/A',
        action,
        previousValue: safePrev,
        newValue: safeNext
      });
    } catch (err) {
      console.error('Failed to handle administration audit trail log: ', err);
    }
  };

  const subTabs = [
    { id: 'dashboard', label: 'Dashboard', icon: ShieldCheck, visible: true },
    { id: 'users', label: 'User Directory', icon: Users, visible: canEdit('Console') || canCreate('Console') },
    { id: 'process', label: 'Process Management', icon: Activity, visible: canEdit('Console') },
    { id: 'roles', label: 'Roles Matrix', icon: Settings, visible: canEdit('Console') },
    { id: 'mapping', label: 'Team Mapping', icon: RefreshCw, visible: canEdit('Console') },
    { id: 'officenetworks', label: 'Office Networks', icon: Wifi, visible: true },
    { id: 'data', label: 'Data Management', icon: Database, visible: canDelete('Console') },
    { id: 'shiftrecovery', label: 'Shift Recovery', icon: RotateCcw, visible: requesterUser.role === 'ADMIN' || canEdit('Console') },
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
          {/* Manual Config Refresh (Phase 5) */}
          <button
            onClick={async () => {
              if (isRefreshing) return;
              setIsRefreshing(true);
              try {
                await refreshAll();
                if (onRefresh) onRefresh();
              } catch (err: any) {
                console.error('Failed to refresh system settings:', err);
              } finally {
                setIsRefreshing(false);
              }
            }}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all border shadow-sm cursor-pointer ${
              adminTheme === 'dark' 
                ? 'bg-slate-800/90 border-indigo-500/30 text-indigo-400 hover:bg-slate-700 hover:border-indigo-500/50 active:scale-95' 
                : 'bg-white border-slate-200 text-indigo-600 hover:bg-indigo-50/50 hover:border-indigo-200 active:scale-95'
            }`}
            title={`Last refreshed: ${lastRefresh ? lastRefresh.toLocaleTimeString() : 'Never'}`}
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin text-indigo-500' : ''} />
            <span>Refresh Settings</span>
            {lastRefresh && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 font-mono font-medium ml-0.5">
                {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </button>

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
          <ProcessManagementSubView user={requesterUser} adminTheme={adminTheme} allUsers={allUsers} />
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
        
        {activeSubTab === 'hierarchy' && (
          <HierarchySyncWizard 
            allUsers={allUsers} 
            adminTheme={adminTheme} 
            onRefresh={onRefresh || (() => {})} 
            logAdminEvent={logAdminEvent} 
          />
        )}

        {activeSubTab === 'officenetworks' && (
          <OfficeNetworksSubView 
            user={requesterUser} 
            adminTheme={adminTheme} 
          />
        )}

        {activeSubTab === 'shiftrecovery' && (
          <ShiftRecoverySubView 
            user={requesterUser} 
            adminTheme={adminTheme} 
            logAdminEvent={logAdminEvent}
          />
        )}
      </div>

    </div>
  );
}
