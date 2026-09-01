import React, { useState, useEffect, useMemo, useRef, useDeferredValue, useCallback } from 'react';
import { 
  Users, 
  Clock, 
  Coffee, 
  Search, 
  ShieldAlert, 
  ChevronLeft, 
  ChevronRight, 
  ChevronDown,
  RefreshCw, 
  Calendar, 
  Briefcase, 
  Activity, 
  FileSpreadsheet, 
  AlertTriangle,
  CheckCircle,
  Check,
  X,
  Globe,
  Edit3,
  HelpCircle,
  UserCheck,
  Award,
  Plus,
  Shield,
  ShieldCheck,
  Clock3,
  UserX,
  Sparkles,
  LogOut,
  Zap,
  Smartphone,
  Monitor,
  Laptop,
  Tablet,
  Bell,
  AlertCircle,
  Play,
  Eye,
  FileText,
  Mail,
  Bug,
  LifeBuoy,
  Download
} from 'lucide-react';
import { mapToLiveSessionRow, LiveSessionRow, isBreakActivity } from './liveSessionMapper';
import { generateAndDownloadOrganizationReport } from '../../services/organizationReportExportService';
import { buildTimelineFromActivityLedger, isShiftCompleted, getLatestUserActivity, isAuditOrDiagnosticEvent, HEARTBEAT_INTERVAL_MS } from '../../lib/tmsUtils';
import { calculateShiftMetrics, aggregateShiftsForHistoryAndReports } from '../../lib/ledgerCalculations';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  PieChart, 
  Pie, 
  Cell 
} from 'recharts';
import { db, handleFirestoreError, OperationType, getDocsOptimized, getDocOptimized, clearCache, invalidateShiftCache } from '../../lib/firebase';
import { firestoreLogger } from '../../lib/firestoreLogger';
import { 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  query, 
  where, 
  getDocs, 
  writeBatch,
  addDoc,
  limit,
  getDocsFromCache,
  getDocFromCache,
  deleteDoc,
  updateDoc,
  serverTimestamp,
  runTransaction
} from 'firebase/firestore';
import { UserProfile, UserRole, ShiftEvent } from '../../types';
import { appendShiftEvent, formatShiftLedgerForReport } from '../../lib/shiftLedger';
import { toast } from 'sonner';
import { canActOn, isSupervisorOf, getSubordinateUids, getTmsDashboardTeamUids, OrgTree, normalizeHierarchyUser } from '../../lib/hierarchy';
import { subscribeToHierarchyVersion } from '../../lib/hierarchySync';
import { sanitizeTimestamp, cleanUndefined } from '../../lib/utils';
import { usePermission } from '../PermissionContext';
import { useRoster } from '../../contexts/RosterContext';
import { useTMSLiveSessions } from '../../contexts/TMSLiveSessionContext';
import { mapLiveSessionToShift } from './useLiveShifts';
import { useHistoricalShifts } from './useHistoricalShifts';
import { useAlerts } from './useAlerts';
import { repairAndNormalizeShift, createLockedCompletedShift, isShiftLockedOrCompleted, assertShiftLifecycleMutationAllowed } from '../../services/tmsCleanupService';
import { MultiSelectDropdown } from '../ui/multi-select';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { getManagerOfManager, truncateShiftToProductiveTime, getDeviceType, getDetailedDeviceMetadata, getOrFetchPublicIP } from '../../views/TMSView';
import { getLiveTime, getLiveTimeISO } from '../../lib/timeSync';
import { logTmsEvent } from '../../lib/tmsLogger';
import { useSharedTimer } from '../../lib/sharedTimer';
import { useConfig } from '../../contexts/ConfigContext';
import { isManagerRole, isTLRole } from '../../lib/roles';
import { AggregationService } from '../../lib/aggregationService';

interface SupervisorDashboardProps {
  user?: UserProfile;
  currentUser?: UserProfile;
  allUsers?: UserProfile[];
  onRefreshAllData?: () => void;
  externalTheme?: 'light' | 'dark';
  processes?: string[];
  
  // New props for integrated Supervisor Punch Station and sub-routing:
  currentSubView?: string;
  onNavigateSubView?: (viewId: string) => void;
  
  // Agent-level hooks and states of the Supervisor themselves
  currentShift?: any;
  myPastShifts?: any[];
  recentProcesses?: string[];
  favoriteProcesses?: string[];
  toggleFavorite?: (proc: string) => void;
  handleClockIn?: () => void;
  handleClockOut?: () => void;
  handleTakeBreak?: (breakName: string) => void;
  handleResumeWork?: (proc: string) => void;
  handleSwitchProcess?: (proc: string) => void;
  handleExtendShift?: () => void;
  handleManualLocationOverride?: (loc: string) => void;
  isProcessingPunch?: boolean;
}

interface ShiftActivity {
  action?: string;
  type: 'productive' | 'break';
  name: string;
  startTime: string;
  endTime?: string;
  device?: string;
}

interface TMSShift {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  teamLeadUid?: string;
  mappedTL?: string;
  mappedManager?: string;
  clockInTime: string;
  clockOutTime?: string;
  endShiftTime?: string;
  sessionClosedBy?: string;
  activities: ShiftActivity[];
  status: 'ACTIVE' | 'BREAK' | 'COMPLETED' | 'AUTO_CLOSED' | 'COMPLETED_FORCED' | 'CLOCKED_OUT' | 'CLOSED';
  statusStartTime?: string;
  clockInDevice?: string;
  clockOutDevice?: string;
  hasMobilePunches?: boolean;
  sessionExtended?: boolean;
  extended?: boolean;
  deviceType?: string;
  browser?: string;
  os?: string;
  loginTimestamp?: string;
  remarks?: string;

  // Diagnostics fields
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  screenWidth?: number;
  screenHeight?: number;
  detectedDeviceType?: string;
  detectedBrowser?: string;
  detectedOS?: string;
  
  // State Machine & Immutable Metric Fields
  locked?: boolean;
  lockedAt?: string;
  version?: number;
  utilization?: number;
  finalUtilization?: number;
  productiveMinutes?: number;
  breakMinutes?: number;
  shiftDuration?: number;
  productiveMs?: number;
  breakMs?: number;
  totalShiftMs?: number;
  totalProductiveTime?: string;
  totalBreakTime?: string;
  totalShiftTime?: string;

  // Work Location Detection fields
  workLocation?: string;
  workLocationDetected?: string;
  workLocationSource?: string;
  publicIP?: string;
  officeName?: string;
  locationCapturedAt?: string;
  overrideBy?: string;
  overrideAt?: string;
  shiftEventLedger?: ShiftEvent[];
}

const formatMs = (ms: number): string => {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

function SupervisorClockStrip({ myShift }: { myShift: TMSShift }) {
  const now = useSharedTimer();
  const { deviceType } = getDetailedDeviceMetadata();

  const metrics = calculateShiftMetrics(myShift, now.getTime());
  const elapsedShift = metrics.elapsedStr;
  const elapsedActive = metrics.activeStr;
  const elapsedBreak = metrics.breakStr;

  return (
    <div className="flex items-center gap-3 border border-indigo-100 dark:border-indigo-950/40 bg-indigo-50/40 dark:bg-indigo-950/20 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex-wrap">
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-slate-400 dark:text-slate-500 uppercase font-black font-sans">Shift:</span>
        <span className="font-mono text-indigo-600 dark:text-indigo-400 font-extrabold">{elapsedShift}</span>
      </div>
      <div className="h-3 w-px bg-slate-200 dark:bg-slate-800" />
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-slate-400 dark:text-slate-500 uppercase font-black font-sans">Active:</span>
        <span className="font-mono text-emerald-600 dark:text-emerald-400 font-extrabold">{elapsedActive}</span>
      </div>
      <div className="h-3 w-px bg-slate-200 dark:bg-slate-800" />
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-slate-400 dark:text-slate-500 uppercase font-black font-sans">Break:</span>
        <span className="font-mono text-amber-600 dark:text-amber-500 font-extrabold">{elapsedBreak}</span>
      </div>
      <div className="h-3 w-px bg-slate-200 dark:bg-slate-800" />
      <div className="flex items-center gap-1.5 px-1 py-0.5 rounded bg-white/50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800">
        {deviceType === 'Mobile' ? (
          <Smartphone size={12} className="text-fuchsia-500" />
        ) : (
          <Monitor size={12} className="text-emerald-500" />
        )}
        <span className="text-[9px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-400">{deviceType}</span>
      </div>
    </div>
  );
}

// Persistent Global Cache across mount/unmount of SupervisorDashboard removed in favor of useHistoricalShifts and useLiveShifts
let globalCacheUserId = '';

const checkIsGlobalRole = (roleStr: string | undefined): boolean => {
  if (!roleStr) return false;
  const upper = roleStr.toUpperCase().trim();
  const globals = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP'];
  return globals.some(g => upper.includes(g));
};

export default function SupervisorDashboard({ 
  user: propUser, 
  currentUser, 
  allUsers: propAllUsers, 
  onRefreshAllData, 
  externalTheme, 
  processes,
  currentSubView,
  onNavigateSubView,
  currentShift,
  myPastShifts,
  recentProcesses,
  favoriteProcesses,
  toggleFavorite,
  handleClockIn,
  handleClockOut,
  handleTakeBreak,
  handleResumeWork,
  handleSwitchProcess,
  handleExtendShift,
  handleManualLocationOverride,
  isProcessingPunch
}: SupervisorDashboardProps) {
  const { roster, refreshRoster: refreshGlobalRoster, invalidateRosterCache } = useRoster();
  const user = propUser || currentUser;
  const { hasTmsPermission, permissions, loading: permissionsLoading } = usePermission();

  const roleNormalized = (user?.role || '').toUpperCase().trim();
  const hasManagerOrAdminAccess = checkIsGlobalRole(roleNormalized) || (hasTmsPermission && hasTmsPermission('view_org_wide_workforce_data'));

  const [showEnhancedExportModal, setShowEnhancedExportModal] = useState(false);

  const allUsersProp = propAllUsers || [];
  const rawAllUsers = allUsersProp;

  // Extend hierarchy-based visibility to EVERY supervisory role (Admin, HR, Manager, Team Lead, etc.).
  // The Supervisor Dashboard displays ONLY users who belong to that supervisor's reporting hierarchy
  // (Direct and Indirect reportees, plus the supervisor themselves).
  const allUsers = useMemo(() => {
    if (!user) return rawAllUsers;
    const subordinateSet = getTmsDashboardTeamUids(user, rawAllUsers);
    return rawAllUsers.filter(u => subordinateSet.has(u.uid));
  }, [rawAllUsers, user]);

  if (user && globalCacheUserId !== user.uid) {
    globalCacheUserId = user.uid;
  }

  if (!user) return null;

  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);

  // Real-time ticking state to trigger ticking of active and break timers for all visible team members
  // Automatically pauses when browser tab is minimized/hidden to eliminate CPU and background activity
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return; // Pause UI timer ticking when tab is in background/minimized
      }
      setTick(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const isManagerOrLead = isManagerRole(user?.role);
  const isTeamLeadOrSME = isTLRole(user?.role);

  const isDark = document.documentElement.classList.contains('dark') || externalTheme === 'dark';
  
  const [hierarchyVersion, setHierarchyVersion] = useState<number | string>('v1.0');
  const [showHierarchyDiagnosticModal, setShowHierarchyDiagnosticModal] = useState(false);

  useEffect(() => {
    const unsub = subscribeToHierarchyVersion((v) => {
      setHierarchyVersion(v);
    });
    return () => unsub();
  }, []);

  // Phase 1: Identify team members for optimized monitoring (strictly scoped to supervisor hierarchy)
  const teamMemberUids = useMemo(() => {
    if (!user) return [];
    // Keep ALL reportees in hierarchy regardless of status (offline or inactive)
    const uids = allUsers.filter(u => u.uid !== user.uid).map(u => u.uid);
    uids.push(user.uid);
    return uids;
  }, [user, allUsers]);

  // Scoped user IDs for historical shifts: strictly authorized subordinates for supervisors/TLs, or undefined for global admin
  const historicalUserScopeUids = useMemo(() => {
    if (!user) return [];
    if (checkIsGlobalRole(roleNormalized)) {
      // Global role: use single paginated indexed query without sending full company roster
      return undefined;
    }
    return teamMemberUids;
  }, [user, roleNormalized, teamMemberUids]);

  const [isFixingMappings, setIsFixingMappings] = useState(false);

  const resolveSupervisorUidByName = (nameOrEmail: string, list: UserProfile[]): string => {
    if (!nameOrEmail) return '';
    const searchStr = nameOrEmail.trim().toLowerCase();
    if (!searchStr) return '';

    const found = list.find(u => {
      const uEmail = (u.email || '').toLowerCase().trim();
      const uName = (u.name || u.fullName || '').toLowerCase().trim();
      return uEmail === searchStr || uName === searchStr;
    });

    return found ? found.uid : '';
  };

  const fixAllMappings = async () => {
    if (!user || mappedUsers.length === 0 || isFixingMappings) return;
    
    // Check if there are any ID-to-name mismatches in mappedUsers
    const usersToFix = mappedUsers.filter(u => {
      const targetTLName = (u.teamLeadName || (u as any).TeamLead || '').toString().trim();
      const targetMgrName = (u.managerName || u.mappedManagerName || (u as any).Manager || '').toString().trim();

      const resolvedTLUid = resolveSupervisorUidByName(targetTLName, rawAllUsers);
      const resolvedMgrUid = resolveSupervisorUidByName(targetMgrName, rawAllUsers);

      const currentTLUid = u.teamLeadUid || u.teamLeadId || '';
      const currentMgrUid = u.mappedManagerUid || u.mappedManagerId || u.managerId || '';

      const needsTLFix = resolvedTLUid && resolvedTLUid !== currentTLUid;
      const needsMgrFix = resolvedMgrUid && resolvedMgrUid !== currentMgrUid;

      return needsTLFix || needsMgrFix;
    });

    if (usersToFix.length === 0) {
      toast.info('All mappings are already healthy!', { id: 'mapping-fix' });
      return;
    }

    const toastId = toast.loading(`Fixing mappings for ${usersToFix.length} users...`, { id: 'mapping-fix' });

    setIsFixingMappings(true);
    try {
      const batch = writeBatch(db);
      let count = 0;

      usersToFix.forEach(u => {
        const userRef = doc(db, 'users', u.uid);
        const updates: any = {};
        
        const targetTLName = (u.teamLeadName || (u as any).TeamLead || '').toString().trim();
        const targetMgrName = (u.managerName || u.mappedManagerName || (u as any).Manager || '').toString().trim();

        const resolvedTLUid = resolveSupervisorUidByName(targetTLName, rawAllUsers);
        const resolvedMgrUid = resolveSupervisorUidByName(targetMgrName, rawAllUsers);

        const currentTLUid = u.teamLeadUid || u.teamLeadId || '';
        const currentMgrUid = u.mappedManagerUid || u.mappedManagerId || u.managerId || '';

        if (resolvedTLUid && resolvedTLUid !== currentTLUid) {
          updates.teamLeadUid = resolvedTLUid;
          updates.teamLeadId = resolvedTLUid;
        }
        if (resolvedMgrUid && resolvedMgrUid !== currentMgrUid) {
          updates.mappedManagerUid = resolvedMgrUid;
          updates.mappedManagerId = resolvedMgrUid;
          updates.managerId = resolvedMgrUid;
        }

        if (Object.keys(updates).length > 0) {
          batch.update(userRef, updates);
          count++;
        }
      });

      if (count > 0) {
        await batch.commit();
        toast.success(`Successfully fixed ${count} user mappings!`, { id: toastId });
        if (onRefreshAllData) onRefreshAllData();
      } else {
        toast.info('No updates required for selected users.', { id: toastId });
      }
    } catch (err) {
      console.error('Failed to fix mappings:', err);
      toast.error('Failed to update user mappings', { id: toastId });
    } finally {
      setIsFixingMappings(false);
    }
  };

  const fixSingleMapping = async (u: UserProfile) => {
    if (!user || isFixingMappings) return;
    
    const toastId = toast.loading(`Fixing mapping for ${u.fullName || u.name}...`, { id: 'mapping-fix-single' });
    setIsFixingMappings(true);
    
    try {
      const userRef = doc(db, 'users', u.uid);
      const updates: any = {};
      
      const targetTLName = (u.teamLeadName || (u as any).TeamLead || '').toString().trim();
      const targetMgrName = (u.managerName || u.mappedManagerName || (u as any).Manager || '').toString().trim();

      const resolvedTLUid = resolveSupervisorUidByName(targetTLName, rawAllUsers);
      const resolvedMgrUid = resolveSupervisorUidByName(targetMgrName, rawAllUsers);

      const currentTLUid = u.teamLeadUid || u.teamLeadId || '';
      const currentMgrUid = u.mappedManagerUid || u.mappedManagerId || u.managerId || '';

      if (resolvedTLUid && resolvedTLUid !== currentTLUid) {
        updates.teamLeadUid = resolvedTLUid;
        updates.teamLeadId = resolvedTLUid;
      }
      if (resolvedMgrUid && resolvedMgrUid !== currentMgrUid) {
        updates.mappedManagerUid = resolvedMgrUid;
        updates.mappedManagerId = resolvedMgrUid;
        updates.managerId = resolvedMgrUid;
      }

      if (Object.keys(updates).length > 0) {
        await setDoc(userRef, updates, { merge: true });
        toast.success(`Fixed mapping for ${u.fullName || u.name}`, { id: toastId });
        if (onRefreshAllData) onRefreshAllData();
      } else {
        toast.info(`Mapping for ${u.fullName || u.name} is already correct.`, { id: toastId });
      }
    } catch (err) {
      console.error('Failed to fix mapping:', err);
      toast.error('Failed to update mapping', { id: toastId });
    } finally {
      setIsFixingMappings(false);
    }
  };

  const fixSyncLag = async (u: UserProfile, liveShift: TMSShift) => {
    if (!user || isFixingMappings) return;
    
    const toastId = toast.loading(`Fixing sync lag for ${u.fullName || u.name}...`, { id: 'sync-fix' });
    setIsFixingMappings(true);
    
    try {
      const profileTL = u.teamLeadUid || u.teamLeadId || '';
      const profileMgr = u.mappedManagerId || u.managerId || u.mappedManagerUid || '';

      const batch = writeBatch(db);
      
      // Update live_sessions
      const lsRef = doc(db, 'live_sessions', u.uid);
      batch.update(lsRef, {
        tlId: profileTL,
        managerId: profileMgr
      });
      
      // Update tmsShifts if we have a valid shift ID (not the user's uid)
      if (liveShift.id && liveShift.id !== u.uid) {
        const shiftRef = doc(db, 'tmsShifts', liveShift.id);
        batch.update(shiftRef, {
          teamLeadUid: profileTL,
          managerId: profileMgr
        });
      }
      
      await batch.commit();
      toast.success(`Successfully synced session for ${u.fullName || u.name}`, { id: toastId });
      if (onRefreshAllData) onRefreshAllData();
    } catch (err) {
      console.error('Failed to fix sync lag:', err);
      toast.error('Failed to update session mapping', { id: toastId });
    } finally {
      setIsFixingMappings(false);
    }
  };

  const fixAllSyncLags = async () => {
    if (!user || mappedUsers.length === 0 || isFixingMappings) return;
    
    const sessionsToFix = mappedUsers.filter(u => {
      const live = activeShifts.find(s => s.userId === u.uid);
      if (!live) return false;
      const profileTL = (u.teamLeadUid || u.teamLeadId || '').toString();
      const profileMgr = (u.mappedManagerId || u.managerId || u.mappedManagerUid || '').toString();
      const liveTL = (live.teamLeadUid || (live as any).tlId || '').toString();
      const liveMgr = (live.managerId || '').toString();
      return profileTL !== liveTL || (profileMgr !== liveMgr && liveMgr !== 'OFFLINE');
    });

    if (sessionsToFix.length === 0) {
      toast.info('No sync lags detected.', { id: 'sync-fix-all' });
      return;
    }

    const toastId = toast.loading(`Fixing sync lag for ${sessionsToFix.length} sessions...`, { id: 'sync-fix-all' });
    setIsFixingMappings(true);
    
    try {
      const batch = writeBatch(db);
      let count = 0;

      sessionsToFix.forEach(u => {
        const live = activeShifts.find(s => s.userId === u.uid);
        if (!live) return;
        
        const profileTL = (u.teamLeadUid || u.teamLeadId || '').toString();
        const profileMgr = (u.mappedManagerId || u.managerId || u.mappedManagerUid || '').toString();

        const lsRef = doc(db, 'live_sessions', u.uid);
        batch.update(lsRef, {
          tlId: profileTL,
          managerId: profileMgr
        });
        
        // Update tmsShifts if we have a valid shift ID (not the user's uid)
        if (live.id && live.id !== u.uid) {
          const shiftRef = doc(db, 'tmsShifts', live.id);
          batch.update(shiftRef, {
            teamLeadUid: profileTL,
            managerId: profileMgr
          });
        }
        count++;
      });

      await batch.commit();
      toast.success(`Successfully synced ${count} sessions!`, { id: toastId });
      if (onRefreshAllData) onRefreshAllData();
    } catch (err) {
      console.error('Failed to fix all sync lags:', err);
      toast.error('Failed to update sessions', { id: toastId });
    } finally {
      setIsFixingMappings(false);
    }
  };

  // Tab control
  const [activeTab, setActiveTab] = useState<'controls' | 'hierarchy' | 'alerts' | 'mapping'>('controls');
  const [tmsAdminTab, setTmsAdminTab] = useState<'roster' | 'exceeded_12h'>('roster');
  
  // Tab-specific loading states
  const [isTrackingEnabled, setIsTrackingEnabled] = useState(true);
  const [isHistoryEnabled, setIsHistoryEnabled] = useState(false);
  
  const handleTabChange = (tab: 'controls' | 'hierarchy' | 'alerts' | 'mapping') => {
    if (tab === 'alerts' && !isHistoryEnabled) {
      setIsHistoryEnabled(true);
    }
    setActiveTab(tab);
    if (tab === 'alerts' && !isHistoryEnabled) {
      setIsHistoryEnabled(true);
    }
  };

  const [activeShifts, setActiveShifts] = useState<TMSShift[]>([]);
  const [localSuperOwnShift, setLocalSuperOwnShift] = useState<TMSShift | null | undefined>(undefined);
  const [ownActiveShift, setOwnActiveShift] = useState<TMSShift | null>(null);
  const [teamLocationOverrides, setTeamLocationOverrides] = useState<Record<string, { workLocation: string; workLocationSource: string }>>({});

  const lastSupervisorHeartbeatSentAtRef = useRef<number>(0);

  // Supervisor Heartbeat optimization: Update lastHeartbeat and isOnline in live_sessions ONLY every 90 seconds when clocked in
  useEffect(() => {
    if (!user?.uid || !ownActiveShift || ownActiveShift.status === 'COMPLETED' || ownActiveShift.status === 'AUTO_CLOSED') return;

    const sendHeartbeat = async (reason: 'scheduled' | 'focus' | 'visibility' | 'mount' = 'scheduled') => {
      const now = Date.now();
      const elapsedMs = now - lastSupervisorHeartbeatSentAtRef.current;

      // Enforce shared 60s cooldown gate for focus / visibility event heartbeats
      if ((reason === 'focus' || reason === 'visibility') && elapsedMs < 60000) {
        console.log(`[HEARTBEAT SKIPPED] reason=cooldown elapsedMs=${elapsedMs}`);
        return;
      }

      lastSupervisorHeartbeatSentAtRef.current = now;

      try {
        const liveSessionRef = doc(db, 'live_sessions', user.uid);
        const userData = (user as any);
        const tlId = userData.teamLeadId || userData.teamLeadUid || userData.tlId || '';
        const managerId = userData.mappedManagerId || userData.managerId || '';
        const nowISO = getLiveTimeISO();
        
        await setDoc(liveSessionRef, {
          lastHeartbeat: nowISO,
          isOnline: true,
          tlId: tlId,
          managerId: managerId,
          userId: user.uid,
          uid: user.uid
        }, { merge: true });

        console.log(`[FIRESTORE WRITE COST] operation=heartbeat collection=live_sessions reason=${reason}`);
        console.log(`[HEARTBEAT WRITE] collection=live_sessions reason=${reason}`);
        logTmsEvent('HEARTBEAT', {
          userId: user.uid,
          shiftId: ownActiveShift.id,
          timestamp: nowISO,
          reason: `Heartbeat (${reason})`,
          sourceFunction: 'SupervisorDashboard.sendHeartbeat'
        });
      } catch (err) {
        console.warn('[SUPERVISOR HEARTBEAT] Failed to update heartbeat:', err);
      }
    };

    // Send immediately on mount / state change
    sendHeartbeat('mount');

    const heartbeatInterval = setInterval(() => sendHeartbeat('scheduled'), HEARTBEAT_INTERVAL_MS);

    const handleFocus = () => {
      sendHeartbeat('focus');
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat('visibility');
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(heartbeatInterval);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [user?.uid, ownActiveShift?.id, ownActiveShift?.status]);

  const { liveShifts, isLoading: loadingLiveShifts, fetchLiveShifts, lastUpdated } = useTMSLiveSessions();

  // Automatic tab focus visibility re-sync disabled — live data is only loaded when user explicitly clicks 'Load Live Data' button

  // Load supervisor's own active/break shift from liveShifts (retrieved from non-realtime IndexedDB / manual load)
  useEffect(() => {
    if (!user?.uid || !liveShifts) return;

    const myShiftInLive = liveShifts.find(s => s.userId === user.uid);
    if (myShiftInLive) {
      setOwnActiveShift(myShiftInLive);
    } else {
      setOwnActiveShift(null);
    }
  }, [liveShifts, user?.uid]);
  const shouldEnableHistory = isHistoryEnabled || currentSubView === 'tms-reports' || activeTab === 'alerts';

  const { 
    shifts: paginatedShifts, 
    loading: loadingHistorical, 
    hasMore, 
    fetchNextPage,
    refresh: refreshHistoricalShifts
  } = useHistoricalShifts(user?.uid, user?.role, 5, shouldEnableHistory, historicalUserScopeUids);

  const alerts = useAlerts(liveShifts, paginatedShifts);

  useEffect(() => {
    if (isTrackingEnabled) {
      let finalShifts = [...liveShifts];
      const myId = user.uid;

      // Ensure supervisor's own live shift (if present in authoritative collection) is merged
      if (ownActiveShift) {
        finalShifts = finalShifts.filter(s => s.userId !== myId);
        finalShifts.push(ownActiveShift);
      } else {
        finalShifts = finalShifts.filter(s => s.userId !== myId);
      }

      if (localSuperOwnShift !== undefined) {
        if (localSuperOwnShift === null) {
          // Optimistically clocked out. Filter out our own shift.
          finalShifts = finalShifts.filter(s => s.userId !== myId);
          // If the server also shows we are clocked out, clear the override lock.
          const serverHasMe = ownActiveShift !== null;
          if (!serverHasMe) {
            setLocalSuperOwnShift(undefined);
          }
        } else if (localSuperOwnShift) {
          // Optimistically clocked in / changed state. Replace or add our shift.
          finalShifts = finalShifts.filter(s => s.userId !== myId);
          finalShifts.push(localSuperOwnShift);

          // Once the server matches our local status, process, and activities size, clear override.
          const serverShift = ownActiveShift;
          if (serverShift) {
            const serverLastAct = serverShift.activities?.[serverShift.activities.length - 1];
            const localLastAct = localSuperOwnShift.activities?.[localSuperOwnShift.activities.length - 1];
            const statusMatches = serverShift.status === localSuperOwnShift.status;
            const processMatches = serverLastAct?.name === localLastAct?.name;
            const countMatches = serverShift.activities?.length === localSuperOwnShift.activities?.length;

            if (statusMatches && processMatches && countMatches) {
              setLocalSuperOwnShift(undefined);
            }
          }
        }
      }

      finalShifts = finalShifts.map(s => {
        const uId = s.userId || (s as any).uid || s.id;
        const ov = teamLocationOverrides[uId] || (s.userEmail ? teamLocationOverrides[s.userEmail.toLowerCase().trim()] : undefined);
        return ov ? { ...s, ...ov } : s;
      });

      setActiveShifts(finalShifts);
    } else {
      setActiveShifts([]);
    }
  }, [liveShifts, isTrackingEnabled, localSuperOwnShift, ownActiveShift, user.uid, teamLocationOverrides]);

  const [isLoadingShifts, setIsLoadingShifts] = useState(false);
  const isDataSyncing = loadingLiveShifts || isLoadingShifts;
  const [lastRefreshed, setLastRefreshed] = useState<Date>(getLiveTime());
  const [presentThreshold, setPresentThreshold] = useState<number>(480);

  // Supervisor own clock journey states & options
  const SUPERVISOR_BREAK_OPTIONS = useMemo(() => [
    'Lunch',
    'Short Break',
    'Tea Break',
    'Meeting',
    'Coaching',
    'Training',
    'Alignment',
    'System Issue',
    'SME Support',
    'Client Call',
    'Emergency Break'
  ], []);

  const [showSuperClockInConfirm, setShowSuperClockInConfirm] = useState(false);
  const [showSuperClockOutConfirm, setShowSuperClockOutConfirm] = useState(false);
  const [showSuperBreakConfirm, setShowSuperBreakConfirm] = useState(false);
  const [showSuperResumeConfirm, setShowSuperResumeConfirm] = useState(false);
  const [superSelectedProcess, setSuperSelectedProcess] = useState(user?.lastUsedProcess || '');
  const [superSelectedBreak, setSuperSelectedBreak] = useState('Lunch');
  const [superSelectedLocation, setSuperSelectedLocation] = useState<'Office' | 'Home'>('Office');

  const handleSuperClockInAction = async (targetProcess: string, targetLocation: string) => {
    await performSuperClockIn(targetProcess, targetLocation);
  };

  const handleSuperClockOutAction = async () => {
    await performSuperClockOut();
  };

  const supervisorProcesses = useMemo(() => {
    const list = processes && processes.length > 0
      ? processes
      : ['HITL', 'OQC', 'SOP Training', 'QA Review', 'Team Alignment', 'Admin', 'Support', 'Quality Check'];
    const blocked = ['mpqc', 'mpqc-fk', 'mpqc-sh'];
    return list.filter(p => !blocked.includes((p || '').toLowerCase().trim()));
  }, [processes]);

  useEffect(() => {
    if (supervisorProcesses.length > 0) {
      const myShift = localSuperOwnShift !== undefined ? localSuperOwnShift : (ownActiveShift || activeShifts.find(s => s.userId === user?.uid));
      const lastProductive = myShift?.activities ? [...myShift.activities].reverse().find(act => act.type === 'productive') : null;
      
      if (lastProductive && supervisorProcesses.includes(lastProductive.name)) {
        setSuperSelectedProcess(lastProductive.name);
      } else if (user?.lastUsedProcess && supervisorProcesses.includes(user.lastUsedProcess)) {
        setSuperSelectedProcess(user.lastUsedProcess);
      } else if (!superSelectedProcess || !supervisorProcesses.includes(superSelectedProcess)) {
        setSuperSelectedProcess(supervisorProcesses[0]);
      }
    }
  }, [user?.lastUsedProcess, supervisorProcesses, ownActiveShift, localSuperOwnShift, activeShifts, user?.uid]);

  const handleSupervisorManualLocationOverride = async (newLocation: string) => {
    const myShift = localSuperOwnShift !== undefined ? localSuperOwnShift : (ownActiveShift || activeShifts.find(s => s.userId === user.uid));
    if (!myShift) return;

    const nowISO = getLiveTimeISO();
    const updatedShift: TMSShift = {
      ...myShift,
      workLocation: newLocation,
      workLocationSource: 'Manual Override',
      overrideBy: user.uid,
      overrideAt: nowISO
    };

    setLocalSuperOwnShift(updatedShift);
    setOwnActiveShift(updatedShift);
    setActiveShifts(prev => prev.map(s => s.userId === user.uid ? updatedShift : s));

    try {
      const shiftRef = doc(db, 'tmsShifts', myShift.id);
      const lsRef = doc(db, 'live_sessions', user.uid);
      const batch = writeBatch(db);
      batch.set(shiftRef, { workLocation: newLocation, workLocationSource: 'Manual Override', overrideBy: user.uid, overrideAt: nowISO }, { merge: true });
      batch.set(lsRef, { workLocation: newLocation, workLocationSource: 'Manual Override' }, { merge: true });
      await batch.commit();
      toast.success(`Work location updated to: ${newLocation === 'Office' ? '🏢 Office' : '🏠 Home'}`);
    } catch (err: any) {
      console.error("Failed to update supervisor location override:", err);
      toast.error("Failed to update location: " + err.message);
    }
  };

  const handleTeamUserLocationOverride = async (targetUserId: string, currentLoc: string, targetName?: string) => {
    const newLocation = currentLoc === 'Office' ? 'Home' : 'Office';
    const nowISO = getLiveTimeISO();

    // 1. Instant state update for overrides map
    setTeamLocationOverrides(prev => ({
      ...prev,
      [targetUserId]: {
        workLocation: newLocation,
        workLocationSource: 'Manual Override'
      }
    }));

    // 2. Instant activeShifts update
    const existingShift = activeShifts.find(s => s.userId === targetUserId || (s as any).uid === targetUserId || s.id === targetUserId);
    if (existingShift) {
      const updatedShift: TMSShift = {
        ...existingShift,
        workLocation: newLocation,
        workLocationSource: 'Manual Override',
        overrideBy: user.uid,
        overrideAt: nowISO
      };
      setActiveShifts(prev => prev.map(s => (s.userId === targetUserId || (s as any).uid === targetUserId || s.id === targetUserId) ? updatedShift : s));
    }

    if (targetUserId === user.uid) {
      const myShift = localSuperOwnShift !== undefined ? localSuperOwnShift : (ownActiveShift || existingShift);
      if (myShift) {
        const updatedSelf = { ...myShift, workLocation: newLocation, workLocationSource: 'Manual Override', overrideBy: user.uid, overrideAt: nowISO };
        setLocalSuperOwnShift(updatedSelf);
        setOwnActiveShift(updatedSelf);
      }
    }

    try {
      if (existingShift && existingShift.id) {
        const shiftRef = doc(db, 'tmsShifts', existingShift.id);
        const batch = writeBatch(db);
        batch.set(shiftRef, { workLocation: newLocation, workLocationSource: 'Manual Override', overrideBy: user.uid, overrideAt: nowISO }, { merge: true });
        
        const lsRef = doc(db, 'live_sessions', targetUserId);
        batch.set(lsRef, {
          workLocation: newLocation,
          workLocationSource: 'Manual Override',
          overrideBy: user.uid,
          overrideAt: nowISO
        }, { merge: true });
        await batch.commit();
      } else {
        const lsRef = doc(db, 'live_sessions', targetUserId);
        await setDoc(lsRef, {
          workLocation: newLocation,
          workLocationSource: 'Manual Override',
          overrideBy: user.uid,
          overrideAt: nowISO
        }, { merge: true });
      }

      toast.success(`Updated ${targetName || 'employee'}'s location to ${newLocation === 'Office' ? '🏢 Office' : '🏠 Home'}`);
    } catch (err: any) {
      console.error('Failed to update team user location override:', err);
      toast.error('Failed to update location: ' + err.message);
    }
  };

  const performSuperClockIn = async (targetProcess: string, workLocationOverride?: string) => {
    if (!targetProcess) {
      toast.error('Please select a process before Clocking In.');
      return;
    }
    const currentDev = getDeviceType();
    const meta = getDetailedDeviceMetadata();
    const nowISO = getLiveTimeISO();
    
    const uaVal = typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A';
    const platVal = typeof navigator !== 'undefined' ? navigator.platform : 'N/A';
    const touchVal = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0;
    const swVal = typeof window !== 'undefined' && window.screen ? window.screen.width : 0;
    const shVal = typeof window !== 'undefined' && window.screen ? window.screen.height : 0;

    let publicIP = '0.0.0.0';
    let detectedLocation = 'Home';
    let officeName = '';

    // FOOLPROOF GUARD: Check for existing active or break shift in the last 24 hours
    try {
      const now = new Date();
      const cutoffMs = now.getTime() - (24 * 60 * 60 * 1000); // Look back 24 hours
      const cutoffISO = new Date(cutoffMs).toISOString();

      const qCheck = query(
        collection(db, 'tmsShifts'),
        where('userId', '==', user.uid),
        where('clockInTime', '>=', cutoffISO),
        limit(5)
      );
      const checkSnap = await getDocs(qCheck);
      const sameDayShifts = checkSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
      
      const activeShift = sameDayShifts.find(s => s.status === 'ACTIVE' || s.status === 'BREAK');
      if (activeShift) {
        toast.warning(`User ${user.name || user.uid} already has an active session. Refusing duplicate.`);
        return;
      }
    } catch (e) {
      console.warn('Pre-clock-in check failed, proceeding...', e);
    }

    console.log('[IP DETECTION] Retrieving public IPv4 from proactive background lookup...');
    try {
      publicIP = await getOrFetchPublicIP();
      console.log(`[IP DETECTION] Retrieved IP in supervisor clock-in: [${publicIP}]`);
    } catch (err) {
      console.warn('[IP DETECTION] Failed to retrieve proactive IP in supervisor. Defaulting to 0.0.0.0.');
    }

    const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

    let officesList: any[] = [];
    const defaultOffices = [
      { id: 'office_001', officeName: 'Berg Dehradun', publicIP: '115.243.137.122', status: true },
      { id: 'office_002', officeName: 'Berg Noida', publicIP: '125.23.171.67', status: true },
      { id: 'office_003', officeName: 'Berg Delhi', publicIP: '182.71.113.42', status: true }
    ];

    try {
      const officeNetworksRef = doc(db, 'config', 'office_networks');
      const officeSnap = await getDocOptimized(officeNetworksRef, 'office_networks_global', false);
      let fetchedOffices: any[] = [];
      if (officeSnap.exists()) {
        const data = officeSnap.data();
        if (data && Array.isArray(data.offices)) {
          fetchedOffices = data.offices;
        } else if (data && Array.isArray(data.officeIPs)) {
          fetchedOffices = data.officeIPs.map((ip: string, idx: number) => ({
            id: `office_legacy_${idx}`,
            officeName: `Berg Office ${idx + 1}`,
            publicIP: ip,
            status: true
          }));
        }
      }

      // MERGE RULE: Always include hardcoded offices to guarantee detection works, and layer Console configurations on top
      const officeMap = new Map<string, any>();
      defaultOffices.forEach(o => officeMap.set(o.publicIP, o));
      fetchedOffices.forEach(o => {
        if (o && o.publicIP) {
          officeMap.set(o.publicIP, { ...officeMap.get(o.publicIP), ...o });
        }
      });
      officesList = Array.from(officeMap.values());
    } catch (e) {
      officesList = defaultOffices;
    }

    const detectedIPs = publicIP.split(',').map(ip => ip.trim()).filter(ip => ipv4Regex.test(ip));
    const matchingOffice = officesList.find(office => {
      if (!office.publicIP) return false;
      const officeIPs = office.publicIP.split(',').map((ip: string) => ip.trim()).filter(ip => ipv4Regex.test(ip));
      const isIPMatch = officeIPs.some((offIP: string) => detectedIPs.some(usrIP => usrIP === offIP));
      const isActive = office.status === true || String(office.status).toLowerCase() === 'true' || String(office.status).toLowerCase() === 'active';
      return isIPMatch && isActive;
    });

    if (matchingOffice) {
      detectedLocation = 'Office';
      officeName = matchingOffice.officeName || 'Berg Office';
    } else {
      detectedLocation = 'Home';
      officeName = '';
    }

    // Generate client-side document reference for tmsShifts to avoid waiting for server ID assignment
    const tmsShiftRef = doc(collection(db, 'tmsShifts'));
    const generatedId = tmsShiftRef.id;

    const newShift: TMSShift = {
      id: generatedId,
      userId: user.uid,
      userName: user?.name || user?.fullName || 'Supervisor',
      userEmail: user?.email || user?.uid || 'Unknown',
      teamLeadUid: (user as any).teamLeadUid || (user as any).teamLeadId || '',
      mappedTL: (user as any).teamLeadEmail || (user as any).mappedTL || 'N/A',
      mappedManager: (user as any).mappedManagerEmail || (user as any).mappedManager || 'N/A',
      clockInTime: nowISO,
      activities: [{ type: 'productive', name: targetProcess, startTime: nowISO, device: currentDev }],
      status: 'ACTIVE',
      currentActivity: targetProcess || 'General',
      clockInDevice: currentDev,
      hasMobilePunches: currentDev === 'mobile',
      deviceType: meta.deviceType,
      browser: meta.browser,
      os: meta.os,
      loginTimestamp: meta.loginTimestamp,
      userAgent: uaVal,
      platform: platVal,
      maxTouchPoints: touchVal,
      screenWidth: swVal,
      screenHeight: shVal,
      detectedDeviceType: meta.deviceType,
      detectedBrowser: meta.browser,
      detectedOS: meta.os,
      workLocation: workLocationOverride || detectedLocation,
      workLocationDetected: detectedLocation,
      workLocationSource: workLocationOverride ? 'Manual Override' : 'IP Detection',
      publicIP: publicIP,
      officeName: officeName
    } as any;

    // 1. Close modal and set state immediately (Optimistic Update)
    setShowSuperClockInConfirm(false);
    setLocalSuperOwnShift(newShift);
    setOwnActiveShift(newShift);
    setActiveShifts(prev => {
      const filtered = prev.filter(s => s.userId !== user.uid);
      return [newShift, ...filtered];
    });

    try {
      const lsRef = doc(db, 'live_sessions', user.uid);

      // 2. Perform database writes concurrently using writeBatch
      const batch = writeBatch(db);
      batch.set(tmsShiftRef, newShift);
      batch.set(lsRef, {
        sessionId: newShift.id,
        userId: user.uid,
        uid: user.uid,
        employeeId: user.uid,
        employeeName: user?.name || user?.fullName || 'Supervisor',
        process: targetProcess || 'General',
        teamLead: (user as any).teamLeadId || (user as any).teamLeadUid || '',
        tlId: (user as any).teamLeadId || (user as any).teamLeadUid || '',
        manager: (user as any).mappedManagerId || (user as any).managerId || '',
        managerId: (user as any).mappedManagerId || (user as any).managerId || '',
        isOnline: true,
        status: 'ACTIVE',
        currentActivity: targetProcess || 'General',
        clockInTime: newShift.clockInTime,
        statusStartTime: nowISO,
        currentActivityStartTime: nowISO,
        lastHeartbeat: nowISO
      }, { merge: true });
      await batch.commit();

      invalidateShiftCache({
        userId: user.uid,
        shiftId: generatedId,
        teamLeadUid: (user as any).mappedTeamLeadUid || (user as any).teamLeadUid,
        managerId: (user as any).mappedManagerId || (user as any).managerId,
        reason: 'supervisor_clock_in'
      });
      toast.success(`Clocked in successfully under Process: ${targetProcess}`);
      setTimeout(() => recomputeMetrics(true), 500);
    } catch (err: any) {
      console.error('Clock-in failed:', err);
      toast.error('Failed to complete clock in on server: ' + err.message);
      // Revert optimistic state on error
      setLocalSuperOwnShift(undefined);
      setActiveShifts(prev => prev.filter(s => s.userId !== user.uid));
    }
  };

  const performSuperClockOut = async () => {
    const myShift = localSuperOwnShift !== undefined ? localSuperOwnShift : (ownActiveShift || activeShifts.find(s => s.userId === user.uid));
    if (!myShift) return;

    const currentDev = getDeviceType();
    const myShiftId = myShift.id;
    const nowISO = getLiveTimeISO();
    
    const updatedActivities = [...(myShift.activities || [])];
    if (updatedActivities.length > 0) {
      const lastIndex = updatedActivities.length - 1;
      if (!updatedActivities[lastIndex].endTime) {
        // Immutable ledger: removed endTime mutation
      }
    }
    
    const finalShift = {
      ...myShift,
      activities: updatedActivities,
      status: 'COMPLETED' as const,
      clockOutTime: nowISO,
      clockOutDevice: currentDev,
      hasMobilePunches: myShift.hasMobilePunches || currentDev === 'mobile'
    };

    // 1. Close modal and update state optimistically
    setShowSuperClockOutConfirm(false);
    setLocalSuperOwnShift(null);
    setOwnActiveShift(null);
    setActiveShifts(prev => prev.filter(s => s.userId !== user.uid));

    try {
      const batch = writeBatch(db);

      // Query any open active/break shifts for supervisor/user
      try {
        const qOpen = query(
          collection(db, 'tmsShifts'),
          where('userId', '==', user.uid),
          where('status', 'in', ['ACTIVE', 'BREAK']),
          limit(5)
        );
        const openSnap = await getDocs(qOpen);
        const openDocs = openSnap.docs.filter(d => {
          const s = d.data().status;
          return (s === 'ACTIVE' || s === 'BREAK') && d.id !== myShiftId;
        });
        openDocs.forEach(shDoc => {
          const shData = shDoc.data();
          const shActivities = [...(shData.activities || [])];
          if (shActivities.length > 0 && !shActivities[shActivities.length - 1].endTime) {
            // Immutable ledger: removed endTime mutation
          }
          batch.set(shDoc.ref, {
            ...shData,
            activities: shActivities,
            status: 'COMPLETED',
            clockOutTime: nowISO,
            clockOutDevice: currentDev
          }, { merge: true });
        });
      } catch (err) {
        console.warn('Error fetching duplicate active shifts during super clock-out:', err);
      }

      batch.set(doc(db, 'tmsShifts', myShiftId), finalShift);

      const userRef = doc(db, 'users', user.uid);
      batch.set(userRef, {
        lastLogoutAt: nowISO
      }, { merge: true });

      const liveSessionRef = doc(db, 'live_sessions', finalShift.userId);
      batch.delete(liveSessionRef);

      await batch.commit();

      invalidateShiftCache({
        userId: user.uid,
        shiftId: myShiftId,
        teamLeadUid: (user as any).mappedTeamLeadUid || (user as any).teamLeadUid,
        managerId: (user as any).mappedManagerId || (user as any).managerId,
        reason: 'supervisor_clock_out'
      });
      toast.success('Shift completed successfully. Clocked out.');
      setTimeout(() => recomputeMetrics(true), 500);
    } catch (err: any) {
      console.error('Clock-out failed:', err);
      toast.error('Failed to complete clock-out on server: ' + err.message);
      // Revert optimistic state on error
      setLocalSuperOwnShift(myShift);
      setActiveShifts(prev => {
        if (!prev.some(s => s.userId === user.uid)) {
          return [myShift, ...prev];
        }
        return prev;
      });
    }
  };

  const handleSuperBreakAction = async (breakName: string) => {
    const myShift = localSuperOwnShift !== undefined ? localSuperOwnShift : (ownActiveShift || activeShifts.find(s => s.userId === user.uid));
    if (!myShift) return;

    const nowISO = getLiveTimeISO();
    const currentDev = getDeviceType();

    if (myShift.status === 'ACTIVE') {
      try {
        const shiftId = myShift.id;
        const shiftRef = doc(db, 'tmsShifts', shiftId);
        const lsRef = doc(db, 'live_sessions', user.uid);

        let finalShiftState: any = null;

        await runTransaction(db, async (transaction) => {
          const shiftSnap = await transaction.get(shiftRef);
          if (!shiftSnap.exists()) throw new Error("Shift document not found");

          const currentShiftData = shiftSnap.data();
          const currentActivities = [...(currentShiftData.activities || [])];

          // Add BREAK_START activity
          const newActivity = {
            activityId: crypto.randomUUID(),
            action: 'BREAK_START',
            startTime: nowISO,
            process: breakName || 'Break',
            actor: user?.email || 'Supervisor',
            sourceService: 'SupervisorDashboard',
            type: 'break',
            name: breakName,
            device: currentDev
          };
          currentActivities.push(newActivity);

          const updatedShiftData = {
            ...currentShiftData,
            activities: currentActivities,
            status: 'BREAK' as const,
            currentActivity: breakName,
            hasMobilePunches: currentShiftData.hasMobilePunches || currentDev === 'mobile',
            breakStartTime: serverTimestamp()
          };

          transaction.update(shiftRef, {
            activities: currentActivities,
            status: 'BREAK',
            currentActivity: breakName,
            hasMobilePunches: updatedShiftData.hasMobilePunches,
            breakStartTime: serverTimestamp()
          });

          transaction.set(lsRef, cleanUndefined({
            status: 'BREAK',
            currentActivity: breakName,
            statusStartTime: nowISO,
            currentActivityStartTime: nowISO,
            lastHeartbeat: nowISO,
            activities: currentActivities,
            breakStartTime: serverTimestamp()
          }), { merge: true });

          finalShiftState = { id: shiftId, ...updatedShiftData };
        });

        // After successful transaction commit, update local states
        if (finalShiftState) {
          setLocalSuperOwnShift(finalShiftState);
          setOwnActiveShift(finalShiftState);
          setActiveShifts(prev => {
            const idx = prev.findIndex(s => s.id === shiftId);
            if (idx === -1) return [finalShiftState, ...prev];
            const next = [...prev];
            next[idx] = finalShiftState;
            return next;
          });

          // Sync localStorage
          localStorage.setItem('tms_last_active_shift_id', shiftId);
          localStorage.setItem('tms_last_active_shift_json', JSON.stringify(finalShiftState));

          invalidateShiftCache({
            userId: user.uid,
            shiftId,
            reason: 'supervisor_break_start'
          });
          console.log(`[BREAK STATE CHANGE] uid=${user.uid} reason=${breakName} source=SupervisorDashboard.handleSuperBreakAction status=BREAK`);
          toast.success(`Break [${breakName}] started successfully`);
          setTimeout(() => recomputeMetrics(true), 500);
        }
      } catch (err: any) {
        console.error('Start break failed:', err);
        toast.error('Failed to start break on server: ' + err.message);
      }
    }
  };

  const handleSuperResumeAction = async (resumeProcess: string) => {
    const myShift = localSuperOwnShift !== undefined ? localSuperOwnShift : (ownActiveShift || activeShifts.find(s => s.userId === user.uid));
    if (!myShift) return;

    const nowISO = getLiveTimeISO();
    const currentDev = getDeviceType();

    if (myShift.status === 'BREAK') {
      try {
        const shiftId = myShift.id;
        const shiftRef = doc(db, 'tmsShifts', shiftId);
        const lsRef = doc(db, 'live_sessions', user.uid);

        let finalShiftState: any = null;

        await runTransaction(db, async (transaction) => {
          const shiftSnap = await transaction.get(shiftRef);
          if (!shiftSnap.exists()) throw new Error("Shift document not found");

          const currentShiftData = shiftSnap.data();
          const currentActivities = [...(currentShiftData.activities || [])];

          // 1. Close open entry in breakLogs (find last active BREAK_START activity)
          for (let i = currentActivities.length - 1; i >= 0; i--) {
            if (currentActivities[i].action === 'BREAK_START' && !currentActivities[i].endTime) {
              currentActivities[i] = {
                ...currentActivities[i],
                endTime: nowISO
              };
              break;
            }
          }

          // 2. Add BREAK_END activity
          const endActivity = {
            activityId: crypto.randomUUID(),
            action: 'BREAK_END',
            startTime: nowISO,
            process: resumeProcess || 'Active Work',
            actor: user?.email || 'Supervisor',
            sourceService: 'SupervisorDashboard',
            type: 'productive',
            name: resumeProcess || 'Active Work',
            device: currentDev
          };
          currentActivities.push(endActivity);

          const updatedShiftData = {
            ...currentShiftData,
            activities: currentActivities,
            status: 'ACTIVE' as const,
            currentActivity: resumeProcess || 'General',
            hasMobilePunches: currentShiftData.hasMobilePunches || currentDev === 'mobile',
            breakStartTime: null
          };

          transaction.update(shiftRef, {
            activities: currentActivities,
            status: 'ACTIVE',
            currentActivity: updatedShiftData.currentActivity,
            hasMobilePunches: updatedShiftData.hasMobilePunches,
            breakStartTime: null
          });

          transaction.set(lsRef, cleanUndefined({
            status: 'ACTIVE',
            process: resumeProcess || 'Active Work',
            currentActivity: resumeProcess,
            statusStartTime: nowISO,
            currentActivityStartTime: nowISO,
            lastHeartbeat: nowISO,
            activities: currentActivities,
            breakStartTime: null
          }), { merge: true });

          finalShiftState = { id: shiftId, ...updatedShiftData };
        });

        // After successful transaction commit, update local states and clear local IndexedDB cache
        if (finalShiftState) {
          setLocalSuperOwnShift(finalShiftState);
          setOwnActiveShift(finalShiftState);
          setActiveShifts(prev => {
            const idx = prev.findIndex(s => s.id === shiftId);
            if (idx === -1) return [finalShiftState, ...prev];
            const next = [...prev];
            next[idx] = finalShiftState;
            return next;
          });

          // Cache Invalidation: Update localStorage session keys immediately
          localStorage.setItem('tms_last_active_shift_id', shiftId);
          localStorage.setItem('tms_last_active_shift_json', JSON.stringify(finalShiftState));

          invalidateShiftCache({
            userId: user.uid,
            shiftId,
            reason: 'supervisor_break_end'
          });
          console.log(`[BREAK STATE CHANGE] uid=${user.uid} reason=Resumed on ${resumeProcess} source=SupervisorDashboard.handleSuperResumeAction status=ACTIVE`);
          toast.success(`Resumed work on process: ${resumeProcess}`);
          setTimeout(() => recomputeMetrics(true), 500);
        }
      } catch (err: any) {
        console.error('Resume failed:', err);
        toast.error('Failed to resume on server: ' + err.message);
      }
    }
  };

  const handleSuperSwitchProcess = async (newProcess: string) => {
    if (!newProcess) return;
    const myShift = localSuperOwnShift !== undefined ? localSuperOwnShift : (ownActiveShift || activeShifts.find(s => s.userId === user.uid));
    if (!myShift) return;

    if (myShift.status !== 'ACTIVE') {
      toast.error('You must be in an active work status to switch processes.');
      return;
    }

    const nowISO = getLiveTimeISO();
    const currentDev = getDeviceType();
    const updatedActivities = [...(myShift.activities || [])];
    const lastActivity = updatedActivities[updatedActivities.length - 1];

    if (lastActivity && !lastActivity.endTime) {
      // Immutable ledger: removed endTime mutation
    }
    updatedActivities.push({
        activityId: crypto.randomUUID(),
        action: 'PROCESS_SWITCH',
        startTime: nowISO,
        process: newProcess || 'Active Work',
        actor: user?.email || 'Supervisor',
        sourceService: 'SupervisorDashboard',
        type: 'productive',
        name: newProcess || 'Active Work',
        device: currentDev
      });
    const updatedShift = { 
      ...myShift, 
      activities: updatedActivities, 
      status: 'ACTIVE' as const,
      currentActivity: newProcess || 'General',
      hasMobilePunches: myShift.hasMobilePunches || currentDev === 'mobile'
    };

    // 1. Optimistic Update
    setLocalSuperOwnShift(updatedShift);
    setOwnActiveShift(updatedShift);
    setActiveShifts(prev => {
      const idx = prev.findIndex(s => s.id === myShift.id);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = updatedShift;
      return next;
    });

    try {
      const shiftRef = doc(db, 'tmsShifts', myShift.id);
      const lsRef = doc(db, 'live_sessions', user.uid);

      await runTransaction(db, async (transaction) => {
        const shiftSnap = await transaction.get(shiftRef);
        if (!shiftSnap.exists()) throw new Error('Shift document not found on server.');

        const currentShiftData = shiftSnap.data();
        const serverActivities = [...(currentShiftData.activities || [])];

        const newAct = {
          activityId: crypto.randomUUID(),
          action: 'PROCESS_SWITCH',
          startTime: nowISO,
          process: newProcess || 'Active Work',
          actor: user?.email || user?.uid || 'Supervisor',
          sourceService: 'SupervisorDashboard',
          type: 'productive',
          name: newProcess || 'Active Work',
          device: currentDev
        };

        serverActivities.push(newAct);

        transaction.set(shiftRef, cleanUndefined({
          activities: serverActivities,
          status: 'ACTIVE',
          currentActivity: newProcess || 'General',
          lastHeartbeat: nowISO,
          hasMobilePunches: currentShiftData.hasMobilePunches || currentDev === 'mobile'
        }), { merge: true });

        transaction.set(lsRef, cleanUndefined({
          process: newProcess || 'Active Work',
          currentActivity: newProcess,
          statusStartTime: nowISO,
          currentActivityStartTime: nowISO,
          lastHeartbeat: nowISO,
          activities: serverActivities
        }), { merge: true });
      });

      invalidateShiftCache({
        userId: user.uid,
        shiftId: myShift.id,
        reason: 'supervisor_process_switch'
      });
      toast.success(`Successfully switched to process: ${newProcess}`);
      setTimeout(() => recomputeMetrics(true), 500);
    } catch (err: any) {
      console.error('Process switch failed:', err);
      toast.error('Failed to switch process on server: ' + err.message);
      // Revert on error
      setLocalSuperOwnShift(myShift);
      setActiveShifts(prev => {
        const idx = prev.findIndex(s => s.id === myShift.id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = myShift;
        return next;
      });
    }
  };

  // One-time auto-sync to fix legacy live_sessions missing activities and timestamps - DISABLED to save quota
  /*
  useEffect(() => {
    let isMounted = true;
    const performLegacySync = async () => {
      try {
        const q = query(
          collection(db, 'tmsShifts'),
          where('status', 'in', ['ACTIVE', 'BREAK'])
        );
        const snap = await getDocs(q);
        const now = getLiveTime().getTime();
        
        for (const d of snap.docs) {
          if (!isMounted) break;
          const shiftData = d.data() as any;
          
          const { productiveMs, breakMs } = calculateShiftMetrics(shiftData, now);

          const lastAct = getLatestUserActivity(shiftData.activities || []);

          const currentActivity = lastAct && !lastAct.endTime ? lastAct.name : 'In Transition';
          const breakType = shiftData.status === 'BREAK' && lastAct && !lastAct.endTime ? lastAct.name : null;
          const currentActivityStartTime = lastAct ? lastAct.startTime : getLiveTimeISO();

          const lsRef = doc(db, 'live_sessions', shiftData.userId);
          
          const userRef = doc(db, 'users', shiftData.userId);
          const userSnap = await getDoc(userRef);
          const userData = userSnap.exists() ? userSnap.data() : {};

          const liveSessionData = {
            uid: shiftData.userId,
            employeeId: shiftData.userId,
            employeeName: shiftData.userName,
            role: userData.role || 'AGENT',
            process: userData.team || 'N/A',
            currentProcess: userData.team || 'N/A',
            managerId: userData.mappedManagerId || userData.managerId || '',
            tlId: userData.teamLeadId || userData.teamLeadUid || '',
            status: shiftData.status,
            sessionStatus: shiftData.status,
            currentActivity,
            currentActivityStartTime,
            breakType,
            productiveSeconds: Math.floor(productiveMs / 1000),
            breakSeconds: Math.floor(breakMs / 1000),
            activities: shiftData.activities || [],
            location: shiftData.location || userData.location || 'Unknown',
            clockInTime: shiftData.clockInTime,
            deviceName: shiftData.deviceType || 'Unknown',
            platform: shiftData.os || 'Unknown',
            lastHeartbeat: getLiveTimeISO()
          };
          await setDoc(lsRef, liveSessionData, { merge: true });
        }
        console.log('[LegacySync] Completed sync for active users');
      } catch (err) {
        console.error('Legacy live_sessions sync failed', err);
      }
    };
    
    // Only run if the user is a manager or supervisor and has permission to see everything
    if (user && isManagerOrLead) {
      performLegacySync();
    }
    return () => { isMounted = false; };
  }, [user, isManagerOrLead]);
  */

  const recomputeMetrics = async (force = false) => {
    if (force) {
      setIsLoadingShifts(true);
      try {
        if (invalidateRosterCache) {
          await invalidateRosterCache();
        }
        await Promise.all([
          fetchLiveShifts(true),
          refreshHistoricalShifts()
        ]);
        setLastRefreshed(getLiveTime());
      } catch (err) {
        console.error("Manual refresh failed:", err);
      } finally {
        setIsLoadingShifts(false);
      }
    }
  };

  // Performance Optimization: Index Users and Shifts for O(1) lookup
  const usersMap = useMemo(() => {
    const map = new Map<string, UserProfile>();
    allUsers.forEach(u => map.set(u.uid, u));
    return map;
  }, [allUsers]);

  const usersByEmailMap = useMemo(() => {
    const map = new Map<string, UserProfile>();
    allUsers.forEach(u => {
      if (u.email) map.set(u.email.toLowerCase().trim(), u);
    });
    return map;
  }, [allUsers]);

  const usersByEmpIdMap = useMemo(() => {
    const map = new Map<string, UserProfile>();
    allUsers.forEach(u => {
      if (u.employeeId) map.set(u.employeeId.toLowerCase().trim(), u);
    });
    return map;
  }, [allUsers]);

  const [globalLiveShifts, setGlobalLiveShifts] = useState<TMSShift[]>([]);
  const [isLoadingGlobalLive, setIsLoadingGlobalLive] = useState<boolean>(false);

  const activeShiftsMap = useMemo(() => {
    const map = new Map<string, TMSShift>();
    const source = globalLiveShifts.length > 0 ? globalLiveShifts : activeShifts;
    source.forEach(s => {
      if (s.userId) map.set(s.userId, s);
      if ((s as any).uid) map.set((s as any).uid, s);
      if (s.id) map.set(s.id, s);
      if (s.userEmail) map.set(s.userEmail.toLowerCase().trim(), s);
      if ((s as any).email) map.set((s as any).email.toLowerCase().trim(), s);
      if ((s as any).employeeId) map.set((s as any).employeeId.toLowerCase().trim(), s);
    });
    return map;
  }, [globalLiveShifts, activeShifts]);

  const { attendanceSettings: centralAttendance } = useConfig();

  // Subscribe to attendance config from ConfigContext (Phase 5)
  useEffect(() => {
    if (centralAttendance) {
      if (typeof centralAttendance.presentThreshold === 'number') {
        setPresentThreshold(centralAttendance.presentThreshold);
      }
    }
  }, [centralAttendance]);
  
  const [shiftFilter, setShiftFilter] = useState('all'); // all, active, break, offline
  const sharedTimer = useSharedTimer();
  const nowMs = sharedTimer.getTime();
  const [diagnosticMode, setDiagnosticMode] = useState<boolean>(false);
  const [selectedTLs, setSelectedTLs] = useState<string[]>(() => {
    const roleNormalized = (user.role || '').toString().toUpperCase().trim();
    const isTeamLeadOrSupervisor = ['TEAM_LEAD', 'TEAM LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM LEADER', 'SME', 'OPS TEAM LEAD', 'TRAINER TL', 'OPS TL'].includes(roleNormalized);
    if (isTeamLeadOrSupervisor) {
      const defaultName = user.fullName || user.name || '';
      return defaultName ? [defaultName] : [];
    }
    return [];
  });
  const [selectedManagers, setSelectedManagers] = useState<string[]>(() => {
    const roleNormalized = (user.role || '').toString().toUpperCase().trim();
    const isGlobalAdmin = checkIsGlobalRole(roleNormalized);
    if (isGlobalAdmin) {
      return [];
    }
    const isManager = ['MANAGER', 'HR', 'IT_MANAGER', 'TEAM_LEAD', 'TEAM LEAD', 'STL', 'OPS_TL', 'ASSISTANT_MANAGER'].includes(roleNormalized);
    return isManager ? [user.name] : [];
  });
  const [sortKey, setSortKey] = useState<'name' | 'productive' | 'status' | 'break'>('status');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);

  // Modals / Actions states
  const [isExporting, setIsExporting] = useState(false);
  const [exportAbortController, setExportAbortController] = useState<AbortController | null>(null);
  const [exportProgressPercent, setExportProgressPercent] = useState<number>(0);
  const [exportProgressMessage, setExportProgressMessage] = useState<string>('');
  const [exportReportType, setExportReportType] = useState<'summary' | 'chrono' | 'attendance' | 'all'>('all');
  const [exportFormat, setExportFormat] = useState<'excel' | 'csv'>('excel');

  // Force Logout Confirm States
  const [showForceLogoutConfirm, setShowForceLogoutConfirm] = useState(false);
  const [selectedInvestigateLogs, setSelectedInvestigateLogs] = useState<any[]>([]);
  const [showInvestigateModal, setShowInvestigateModal] = useState(false);
  const [logoutShiftId, setLogoutShiftId] = useState<string | null>(null);
  const [logoutTargetName, setLogoutTargetName] = useState('');
  const [logoutTargetUid, setLogoutTargetUid] = useState('');
  const [logoutReason, setLogoutReason] = useState('Left without logging out');
  const [showBulkLogoutModal, setShowBulkLogoutModal] = useState(false);
  const [isBulkLoggingOut, setIsBulkLoggingOut] = useState(false);

  // Enhanced Export Modal States
  const [exportRangePreset, setExportRangePreset] = useState('30'); // '7', '15', '30', 'custom'
  const [exportCustomStart, setExportCustomStart] = useState('');
  const [exportCustomEnd, setExportCustomEnd] = useState('');
  const [exportSelectedProcess, setExportSelectedProcess] = useState<string>('all');

  // Missing states from Supervisor Punch Station/Operations
  const [processFilter, setProcessFilter] = useState('all');
  const [sortBy, setSortBy] = useState('login_newest');
  
  const [remoteSwitchTargetUid, setRemoteSwitchTargetUid] = useState<string | null>(null);
  const [remoteSwitchTargetName, setRemoteSwitchTargetName] = useState<string>('');
  const [remoteSwitchSelectedProcess, setRemoteSwitchSelectedProcess] = useState<string>('General');
  
  const [activityChangeTargetUid, setActivityChangeTargetUid] = useState<string | null>(null);
  const [activityChangeTargetName, setActivityChangeTargetName] = useState<string>('');
  const [activityChangeSelectedValue, setActivityChangeSelectedValue] = useState<string>('');
  
  const [exportStartDate, setExportStartDate] = useState<string>('');
  const [exportEndDate, setExportEndDate] = useState<string>('');

  const performRemoteProcessSwitch = async () => {
    if (!remoteSwitchTargetUid || !remoteSwitchSelectedProcess) return;
    
    // Find live shift of user
    const liveShift = activeShifts.find(s => s.userId === remoteSwitchTargetUid);
    if (!liveShift) {
      toast.error('No active shift found for this user to switch.');
      return;
    }
    
    const nowISO = getLiveTimeISO();
    
    try {
      // Create new activity log
      const currentActIndex = liveShift.activities.findIndex(act => !act.endTime);
      let updatedActivities = [...liveShift.activities];
      if (currentActIndex !== -1) {
        updatedActivities[currentActIndex] = {
          ...updatedActivities[currentActIndex],
          endTime: nowISO
        };
      }
      
      updatedActivities.push({
        activityId: crypto.randomUUID(),
        action: 'PROCESS_SWITCH',
        startTime: nowISO,
        process: remoteSwitchSelectedProcess || 'Active Work',
        actor: user?.email || user?.uid || 'Supervisor',
        sourceService: 'SupervisorDashboard',
        type: 'productive',
        name: remoteSwitchSelectedProcess || 'Active Work',
        device: liveShift.clockInDevice || 'desktop'
      });
      
      const shiftRef = doc(db, 'tmsShifts', liveShift.id);
      const lsRef = doc(db, 'live_sessions', remoteSwitchTargetUid);
      
      const batch = writeBatch(db);
      batch.set(shiftRef, {
        activities: updatedActivities,
        currentActivity: remoteSwitchSelectedProcess,
        lastHeartbeat: nowISO
      }, { merge: true });
      batch.set(lsRef, {
        process: remoteSwitchSelectedProcess,
        currentActivity: remoteSwitchSelectedProcess,
        currentActivityStartTime: nowISO,
        statusStartTime: nowISO,
        lastHeartbeat: nowISO
      }, { merge: true });
      await batch.commit();
      
      toast.success(`Switched ${remoteSwitchTargetName}'s process to: ${remoteSwitchSelectedProcess}`);
      if (onRefreshAllData) onRefreshAllData();
    } catch (err: any) {
      console.error('Failed remote process switch:', err);
      toast.error('Failed to switch process: ' + err.message);
    }
  };

  const performRemoteActivityChange = async (targetUid: string, targetName: string, newActivity: string, isBreak: boolean) => {
    if (!targetUid || !newActivity) return;
    
    // Find live shift of user
    const liveShift = activeShifts.find(s => s.userId === targetUid);
    if (!liveShift) {
      toast.error('No active shift found for this user to change activity.');
      return;
    }
    
    const nowISO = getLiveTimeISO();
    const currentDev = liveShift.clockInDevice || 'desktop';
    
    try {
      // 1. Close current active activity in shift activities array
      const currentActIndex = liveShift.activities.findIndex(act => !act.endTime);
      let updatedActivities = [...liveShift.activities];
      if (currentActIndex !== -1) {
        updatedActivities[currentActIndex] = {
          ...updatedActivities[currentActIndex],
          endTime: nowISO
        };
      }
      
      const shiftRef = doc(db, 'tmsShifts', liveShift.id);
      const lsRef = doc(db, 'live_sessions', targetUid);
      const batch = writeBatch(db);
      
      // 2. Add the new activity log
      if (isBreak) {
        // Switching/updating to a BREAK activity
        updatedActivities.push({
          activityId: crypto.randomUUID(),
          action: 'BREAK_START',
          startTime: nowISO,
          process: newActivity,
          actor: user?.email || user?.uid || 'Supervisor',
          sourceService: 'SupervisorDashboard',
          type: 'break',
          name: newActivity,
          device: currentDev
        });
        
        batch.set(shiftRef, {
          activities: updatedActivities,
          status: 'BREAK',
          currentActivity: newActivity,
          breakStartTime: serverTimestamp(),
          lastHeartbeat: nowISO
        }, { merge: true });
        
        batch.set(lsRef, {
          status: 'BREAK',
          currentActivity: newActivity,
          statusStartTime: nowISO,
          currentActivityStartTime: nowISO,
          lastHeartbeat: nowISO,
          activities: updatedActivities,
          breakStartTime: serverTimestamp()
        }, { merge: true });
      } else {
        // Switching/updating to a PRODUCTIVE activity (ACTIVE)
        updatedActivities.push({
          activityId: crypto.randomUUID(),
          action: liveShift.status === 'BREAK' ? 'BREAK_END' : 'PROCESS_SWITCH',
          startTime: nowISO,
          process: newActivity,
          actor: user?.email || user?.uid || 'Supervisor',
          sourceService: 'SupervisorDashboard',
          type: 'productive',
          name: newActivity,
          device: currentDev
        });
        
        batch.set(shiftRef, {
          activities: updatedActivities,
          status: 'ACTIVE',
          currentActivity: newActivity,
          breakStartTime: null,
          lastHeartbeat: nowISO
        }, { merge: true });
        
        batch.set(lsRef, {
          status: 'ACTIVE',
          process: newActivity,
          currentActivity: newActivity,
          statusStartTime: nowISO,
          currentActivityStartTime: nowISO,
          lastHeartbeat: nowISO,
          activities: updatedActivities,
          breakStartTime: null
        }, { merge: true });
      }
      
      await batch.commit();
      
      toast.success(`Updated ${targetName}'s activity to: ${newActivity}`);
      if (onRefreshAllData) onRefreshAllData();
    } catch (err: any) {
      console.error('Failed remote activity change:', err);
      toast.error('Failed to update activity: ' + err.message);
    }
  };

  const renderAlertItem = (alert: any) => {
    const isCritical = alert.severity === 'critical';
    return (
      <div key={alert.id} className={`p-3 rounded-xl border flex flex-col gap-1.5 transition-all bg-white dark:bg-slate-900 shadow-sm ${isCritical ? 'border-red-200 dark:border-red-950/40' : 'border-amber-200 dark:border-amber-950/40'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isCritical ? 'bg-red-500' : 'bg-amber-500'}`} />
            <span className="text-[10px] font-black uppercase text-slate-800 dark:text-slate-200">{alert.userName || 'System Alert'}</span>
          </div>
          <span className="text-[9px] font-bold text-slate-400 font-mono">{new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <p className="text-xs font-bold text-slate-650 dark:text-slate-300 leading-normal">{alert.message}</p>
      </div>
    );
  };

  const allAvailableUserProcesses = useMemo(() => {
    const list = allUsers.map(u => u.process).filter(p => p && p !== 'N/A');
    const combined = [...list, ...supervisorProcesses];
    return Array.from(new Set(combined.map(p => p.trim()))).sort();
  }, [allUsers, supervisorProcesses]);

  // Searchable Dropdowns States & Refs
  const [isTlDropdownOpen, setIsTlDropdownOpen] = useState(false);
  const [tlSearchQuery, setTlSearchQuery] = useState('');
  const tlDropdownRef = React.useRef<HTMLDivElement>(null);

  const [isStatusDropdownOpen, setIsStatusDropdownOpen] = useState(false);
  const statusDropdownRef = React.useRef<HTMLDivElement>(null);

  const [isProcessDropdownOpen, setIsProcessDropdownOpen] = useState(false);
  const [processSearchQuery, setProcessSearchQuery] = useState('');
  const processDropdownRef = React.useRef<HTMLDivElement>(null);

  const [isManagerDropdownOpen, setIsManagerDropdownOpen] = useState(false);
  const [managerSearchQuery, setManagerSearchQuery] = useState('');
  const managerDropdownRef = React.useRef<HTMLDivElement>(null);

  const [selectedActivities, setSelectedActivities] = useState<string[]>([]);
  const [appliedActivities, setAppliedActivities] = useState<string[]>([]);
  const [isActivityDropdownOpen, setIsActivityDropdownOpen] = useState(false);
  const [activitySearchQuery, setActivitySearchQuery] = useState('');
  const activityDropdownRef = React.useRef<HTMLDivElement>(null);

  // Close dropdowns click-outside listener
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (tlDropdownRef.current && !tlDropdownRef.current.contains(event.target as Node)) {
        setIsTlDropdownOpen(false);
      }
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(event.target as Node)) {
        setIsStatusDropdownOpen(false);
      }
      if (processDropdownRef.current && !processDropdownRef.current.contains(event.target as Node)) {
        setIsProcessDropdownOpen(false);
      }
      if (managerDropdownRef.current && !managerDropdownRef.current.contains(event.target as Node)) {
        setIsManagerDropdownOpen(false);
      }
      if (activityDropdownRef.current && !activityDropdownRef.current.contains(event.target as Node)) {
        setIsActivityDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Hierarchy validation helper (checks if current supervisor is authorized to edit target)
  const canModifyTarget = (targetUid: string) => {
    if (user.uid === targetUid) return false;
    const target = usersMap.get(targetUid);
    if (!target) return false;

    // Check if the current user has TL profile or is manager/admin
    const roleNormalized = (user.role || '').toUpperCase();
    const isTL = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'SME', 'TEAM LEAD', 'TRAINER TL', 'OPS TL'].includes(roleNormalized);
    const isManagerOrAdmin = checkIsGlobalRole(roleNormalized);

    // Allow TLs to force-out users of other team members
    if (isTL || isManagerOrAdmin) {
      const targetRole = (target.role || '').toUpperCase();
      const isTargetHigher = checkIsGlobalRole(targetRole);
      if (isTargetHigher && !isManagerOrAdmin) {
        return false;
      }
      return true;
    }

    return canActOn(user, target, allUsers);
  };


  // Mapped list of supervised agents based on hierarchy
  const mappedUsers = useMemo(() => {
    if (!user) return [];
    const isActiveAccount = (u: UserProfile) => {
      const s = (u.status || '').toLowerCase();
      return s !== 'inactive';
    };

    const result = allUsers.filter(u => u.uid !== user.uid && isActiveAccount(u));

    // DIAGNOSTIC LOGGING FOR TMS DATA SCOPE BOUNDARY
    console.info(`[TMS DATA SCOPE]
actor=${user.uid}
role=${user.role}
visibleHierarchyUsers=${result.length}
globalRosterFetched=false
globalRosterDocuments=0
tmsDatasetUsers=${allUsers.length}
outsideHierarchyUsers=0`);

    return result;
  }, [allUsers, user]);

  const supervisorTeamUids = useMemo(() => {
    return new Set(mappedUsers.map(u => u.uid));
  }, [mappedUsers]);

  // List of unique Team Leads who have members in mappedUsers or have a TL role
  const teamLeadsList = useMemo(() => {
    const leads = new Map<string, { name: string; role: string }>();
    const tlRoles = new Set(['TEAM_LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM LEAD', 'OPS TL', 'TRAINER TL', 'OPS TEAM LEAD', 'TEAM LEADER', 'SME']);

    allUsers.forEach(u => {
      // 1. Add anyone explicitly referenced as a team lead in any active user's profile
      if (u.teamLeadId && u.teamLeadName) {
        if (!leads.has(u.teamLeadId)) {
          const tlObj = usersMap.get(u.teamLeadId);
          const roleStr = tlObj ? (tlObj.role || 'Team Lead') : 'Team Lead';
          leads.set(u.teamLeadId, { name: u.teamLeadName, role: String(roleStr) });
        }
      }

      // 2. Add anyone who holds a Team Lead/Supervisor-like role and has status = 'Active'
      const roleUpper = (u.role || '').toString().toUpperCase().trim();
      const statusActive = !u.status || u.status.toLowerCase().trim() === 'active' || u.isActive === true;
      if (statusActive && tlRoles.has(roleUpper)) {
        const tlName = u.fullName || u.name || u.employeeName;
        if (tlName && !leads.has(u.uid)) {
          leads.set(u.uid, { name: tlName, role: String(u.role) });
        }
      }
    });

    const getFriendlyRole = (role: string): string => {
      const r = (role || '').toString().toUpperCase().trim().replace(/_/g, ' ');
      if (r === 'TEAM LEAD') return 'TL';
      if (r === 'TRAINER TL') return 'Trainer TL';
      if (r === 'OPS TL') return 'Ops TL';
      return r;
    };

    const list = Array.from(leads.entries()).map(([id, item]) => ({ 
      id, 
      name: item.name, 
      roleDisplay: getFriendlyRole(item.role)
    }));

    // Prioritize showing the current user's entry first if they are a Team Lead
    return list.sort((a, b) => {
      if (a.id === user.uid) return -1;
      if (b.id === user.uid) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [allUsers, user.uid, usersMap]);


  // List of unique Managers
  const managersList = useMemo(() => {
    return allUsers.filter(u => {
      const roleUpper = (u.role || '').toString().toUpperCase().trim();
      return ['MANAGER', 'ADMIN', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes(roleUpper);
    });
  }, [allUsers]);


  // Read summary metrics or trigger recalculation when necessary
  // Removed legacy summaryData state in favor of optimized useMemo based hooks

  // Core Shift math calculations

  const calculateShiftStatsObj = (shift: TMSShift) => {
    if (!shift || !shift.clockInTime) {
      return {
        totalShiftStr: '-',
        activeStr: '-',
        breakStr: '-',
        utilization: 0,
        totalShiftMs: 0,
        activeMs: 0,
        breakMs: 0,
        activeMins: 0,
        threshold: presentThreshold > 0 ? presentThreshold : 480,
        remainingMins: presentThreshold > 0 ? presentThreshold : 480,
        projectedUtilization: 0
      };
    }

    const metrics = calculateShiftMetrics(shift, getLiveTime().getTime());
    const activeMins = metrics.activeMs / 60000;
    const threshold = presentThreshold > 0 ? presentThreshold : 480;
    const remainingMins = Math.max(0, threshold - activeMins);

    return {
      ...metrics,
      activeMins,
      threshold,
      remainingMins,
      projectedUtilization: metrics.utilization
    };
  };

  const isManagerUser = useMemo(() => {
    if (!user?.role) return false;
    const roleUpper = (user.role || '').toString().toUpperCase().trim();
    return [
      'MANAGER', 'ASSISTANT_MANAGER', 'OPERATIONS_MANAGER', 'OPS_MANAGER', 
      'ADMIN', 'OPS_HEAD', 'DIRECTOR', 'VP', 'SUPER_ADMIN'
    ].includes(roleUpper);
  }, [user?.role]);

  const isGlobalActivityMode = useMemo(() => {
    return isManagerUser && appliedActivities.length > 0;
  }, [isManagerUser, appliedActivities]);

  // Global live sessions fetcher (used when Manager applies an Activity filter to view whole organization)
  const fetchGlobalLiveSessions = useCallback(async () => {
    if (!isManagerUser) return [];
    setIsLoadingGlobalLive(true);
    try {
      const qAll = query(collection(db, 'live_sessions'), limit(2500));
      const snap = await getDocs(qAll);
      const mapped = snap.docs.map(doc => mapLiveSessionToShift({ id: doc.id, ...doc.data() }));
      setGlobalLiveShifts(mapped);
      return mapped;
    } catch (err) {
      console.error('Failed to fetch global live sessions for activity filter:', err);
      return [];
    } finally {
      setIsLoadingGlobalLive(false);
    }
  }, [isManagerUser]);

  useEffect(() => {
    if (isGlobalActivityMode) {
      fetchGlobalLiveSessions();
    } else {
      setGlobalLiveShifts([]);
    }
  }, [isGlobalActivityMode, fetchGlobalLiveSessions]);

  const isLocationValue = useCallback((val?: string) => {
    if (!val) return false;
    const v = val.toLowerCase().trim();
    return v === 'office' || v === 'home' || v === 'wfh' || v === 'work from office' || v === 'work from home' || v === 'onsite' || v === 'remote';
  }, []);

  // Helper to extract the authoritative current active activity from a live shift
  const getLiveSessionCurrentActivity = useCallback((liveShift: TMSShift | any): string => {
    if (!liveShift) return 'Offline';
    const acts = Array.isArray(liveShift.activities) ? liveShift.activities : [];
    const lastUserAct = getLatestUserActivity(acts);
    let lastActName = '';
    if (lastUserAct && lastUserAct.name && !isAuditOrDiagnosticEvent(lastUserAct.action) && !isLocationValue(lastUserAct.name)) {
      lastActName = lastUserAct.name.trim();
    } else if (acts.length > 0) {
      const validActs = acts.filter(a => !isAuditOrDiagnosticEvent(a.action) && a.type !== 'system' && !isLocationValue(a.name));
      if (validActs.length > 0) {
        lastActName = (validActs[validActs.length - 1].name || '').trim();
      }
    }
    const currentActField = ((liveShift as any).currentActivity || '').trim();
    const candidate = lastActName || (!isLocationValue(currentActField) ? currentActField : '');
    const candLower = candidate.toLowerCase().trim();

    if (!candidate || candLower === 'office' || candLower === 'home' || candLower === 'wfh' || candLower === 'n/a' || candLower === 'offline') {
      const st = (liveShift.status || '').toString().toUpperCase().trim();
      if (st === 'BREAK') return 'Break';
      if (st === 'MEETING') return 'Meeting';
      if (st === 'TRAINING') return 'Training';
      if (st === 'ACTIVE' || st === 'PRODUCTIVE') return 'Productive';
      return st || 'Offline';
    }
    return candidate;
  }, [isLocationValue]);

  const managerActivityOptions = useMemo(() => {
    if (!isManagerUser) return [];
    const actSet = new Set<string>();

    if (processes && Array.isArray(processes)) {
      processes.forEach(p => {
        if (p && typeof p === 'string' && p.trim() && p.trim() !== 'N/A' && !isLocationValue(p)) {
          actSet.add(p.trim());
        }
      });
    }

    if (supervisorProcesses && Array.isArray(supervisorProcesses)) {
      supervisorProcesses.forEach(p => {
        if (p && typeof p === 'string' && p.trim() && p.trim() !== 'N/A' && !isLocationValue(p)) {
          actSet.add(p.trim());
        }
      });
    }

    // Standard operational activity names
    ['HITL', 'Quality', 'Labelling', 'Annotation', 'Review', 'Training', 'Quality Review', 'SOP Training', 'Productive', 'Break', 'Meeting'].forEach(a => {
      actSet.add(a);
    });

    const allShifts = globalLiveShifts.length > 0 ? globalLiveShifts : activeShifts;
    allShifts.forEach(s => {
      if (s.status !== 'COMPLETED' && s.status !== 'CLOSED') {
        const liveAct = getLiveSessionCurrentActivity(s);
        const actLower = liveAct.toLowerCase().trim();
        if (liveAct && actLower !== 'n/a' && actLower !== 'offline' && !isLocationValue(liveAct)) {
          actSet.add(liveAct);
        }
        if (s.process && s.process.trim() && s.process.trim() !== 'N/A' && !isLocationValue(s.process)) {
          actSet.add(s.process.trim());
        }
      }
    });

    return Array.from(actSet).filter(Boolean).sort();
  }, [isManagerUser, processes, supervisorProcesses, globalLiveShifts, activeShifts, getLiveSessionCurrentActivity, isLocationValue]);

  // 1. Base Filtered Workforce (Search, Team, Manager, Location) for normal supervisor view
  const baseFilteredWorkforce = useMemo(() => {
    if (isGlobalActivityMode) return [];

    const tlRefs = new Set<string>();
    const managerRefs = new Set<string>();
    
    const searchLower = deferredSearchTerm?.toLowerCase() || '';

    if (selectedTLs.length > 0) {
      selectedTLs.forEach(tlName => {
        const cleanName = tlName.toLowerCase().trim();
        tlRefs.add(cleanName);
        allUsers.forEach(candidate => {
          const candName = (candidate.name || '').toLowerCase().trim();
          const candFullName = (candidate.fullName || '').toLowerCase().trim();
          if (candName === cleanName || candFullName === cleanName) {
            if (candidate.uid) tlRefs.add(candidate.uid.toLowerCase().trim());
            if (candidate.email) tlRefs.add(candidate.email.toLowerCase().trim());
          }
        });
      });
    }

    if (selectedManagers.length > 0) {
      selectedManagers.forEach(mgrName => {
        const cleanName = mgrName.toLowerCase().trim();
        managerRefs.add(cleanName);
        allUsers.forEach(candidate => {
          const candName = (candidate.name || '').toLowerCase().trim();
          const candFullName = (candidate.fullName || '').toLowerCase().trim();
          if (candName === cleanName || candFullName === cleanName) {
            if (candidate.uid) managerRefs.add(candidate.uid.toLowerCase().trim());
            if (candidate.email) managerRefs.add(candidate.email.toLowerCase().trim());
          }
        });
      });
    }

    return mappedUsers.filter(u => {
      const liveShift = activeShiftsMap.get(u.uid);
      const activeAct = getLiveSessionCurrentActivity(liveShift);
      const shiftStatus = (liveShift?.status || '').trim();

      const matchesSearch = !searchLower 
        ? true 
        : (u.name.toLowerCase().includes(searchLower) || 
           u.email.toLowerCase().includes(searchLower) || 
           (u.employeeId && u.employeeId.toLowerCase().includes(searchLower)) ||
           (liveShift?.deviceType && liveShift.deviceType.toLowerCase().includes(searchLower)) ||
           (activeAct && activeAct.toLowerCase().includes(searchLower)) ||
           (shiftStatus && shiftStatus.toLowerCase().includes(searchLower)) ||
           (u.process && u.process.toLowerCase().includes(searchLower)));

      if (!matchesSearch) return false;

      // Location filters
      if (selectedLocations.length > 0) {
        const uLoc = (u.location || '').trim();
        if (!selectedLocations.includes(uLoc)) {
          return false;
        }
      }

      // TL filter
      if (selectedTLs.length > 0) {
        const matchesTL = 
          (u.teamLeadId && tlRefs.has(u.teamLeadId.toLowerCase().trim())) ||
          (u.teamLeadUid && tlRefs.has(u.teamLeadUid.toLowerCase().trim())) ||
          (u.teamLeadName && tlRefs.has(u.teamLeadName.toLowerCase().trim())) ||
          (u.teamLeadEmail && tlRefs.has(u.teamLeadEmail.toLowerCase().trim())) ||
          (u.mappedTL && tlRefs.has(u.mappedTL.toLowerCase().trim())) ||
          (u.uid && tlRefs.has(u.uid.toLowerCase().trim())) ||
          (u.name && tlRefs.has(u.name.toLowerCase().trim())) ||
          (u.fullName && tlRefs.has(u.fullName.toLowerCase().trim()));
        if (!matchesTL) return false;
      }

      // Manager filter
      if (selectedManagers.length > 0) {
        const checkHierarchy = (uToCheck: UserProfile, visited: Set<string>): boolean => {
          if (!uToCheck) return false;
          const uUidLower = (uToCheck.uid || '').toLowerCase().trim();
          const uNameLower = (uToCheck.name || '').toLowerCase().trim();
          const uFullNameLower = (uToCheck.fullName || '').toLowerCase().trim();
          const uEmailLower = (uToCheck.email || '').toLowerCase().trim();
          const uMgrIdLower = (uToCheck.managerId || '').toLowerCase().trim();
          const uMappedMgrIdLower = (uToCheck.mappedManagerId || '').toLowerCase().trim();
          const uMappedMgrUidLower = ((uToCheck as any).mappedManagerUid || '').toLowerCase().trim();
          const uMgrNameLower = (uToCheck.managerName || uToCheck.mappedManagerName || uToCheck.Manager || '').toLowerCase().trim();

          const possibleManagerMatch = 
            managerRefs.has(uUidLower) ||
            managerRefs.has(uMgrIdLower) ||
            managerRefs.has(uMappedMgrIdLower) ||
            managerRefs.has(uMappedMgrUidLower) ||
            managerRefs.has(uMgrNameLower) ||
            managerRefs.has(uNameLower) ||
            managerRefs.has(uFullNameLower) ||
            managerRefs.has(uEmailLower);

          if (possibleManagerMatch) return true;
          if (visited.has(uToCheck.uid)) return false;
          visited.add(uToCheck.uid);
          
          if (uToCheck.teamLeadId) {
            const tl = usersMap.get(uToCheck.teamLeadId);
            if (tl && checkHierarchy(tl, visited)) return true;
          }
          if (uToCheck.managerId) {
            const mgr = usersMap.get(uToCheck.managerId);
            if (mgr && checkHierarchy(mgr, visited)) return true;
          }
          return false;
        };
        if (!checkHierarchy(u, new Set())) return false;
      }

      return true;
    });
  }, [isGlobalActivityMode, mappedUsers, activeShiftsMap, deferredSearchTerm, selectedLocations, selectedTLs, selectedManagers, allUsers, getLiveSessionCurrentActivity, usersMap]);

  // 1. Single source of truth live session mapping for workforce
  const mappedWorkforceRows = useMemo(() => {
    const searchLower = deferredSearchTerm?.toLowerCase() || '';

    // =========================================================================
    // GLOBAL ACTIVITY VIEW MODE: Hierarchy restriction is OVERRIDDEN
    // Uses real live session data from live_sessions collection, maps via
    // existing canonical mapToLiveSessionRow, and filters by selected activity.
    // =========================================================================
    if (isGlobalActivityMode) {
      const sourceShifts = globalLiveShifts.length > 0 ? globalLiveShifts : activeShifts;
      const rows: LiveSessionRow[] = [];
      const seenUids = new Set<string>();

      sourceShifts.forEach(liveDocRaw => {
        // Must be an active/online session
        if (liveDocRaw.status === 'COMPLETED' || liveDocRaw.status === 'CLOSED' || (liveDocRaw as any).isOnline === false) {
          return;
        }

        const uid = liveDocRaw.userId || (liveDocRaw as any).uid || liveDocRaw.id;
        if (!uid || seenUids.has(uid)) return;
        seenUids.add(uid);

        const liveEmail = (liveDocRaw.userEmail || (liveDocRaw as any).email || '').toLowerCase().trim();
        const liveEmpId = ((liveDocRaw as any).employeeId || '').toLowerCase().trim();

        const existingU = usersMap.get(uid) || 
          (liveEmail ? usersByEmailMap.get(liveEmail) : undefined) ||
          (liveEmpId ? usersByEmpIdMap.get(liveEmpId) : undefined) ||
          (allUsers ? allUsers.find(g => g.uid === uid || (liveEmail && g.email?.toLowerCase().trim() === liveEmail)) : undefined);

        const ov = teamLocationOverrides[uid] || (liveEmail ? teamLocationOverrides[liveEmail] : undefined);
        const liveDoc = ov ? { ...liveDocRaw, ...ov } : liveDocRaw;

        const realName = existingU?.fullName || existingU?.name || existingU?.employeeName;
        const fallbackName = (liveDoc.userName && liveDoc.userName !== 'Active Employee' ? liveDoc.userName : '') || (liveDoc as any).employeeName;

        const userProfile: UserProfile = existingU ? existingU : {
          uid,
          name: realName || fallbackName || (liveEmail ? liveEmail.split('@')[0] : 'Employee'),
          fullName: realName || fallbackName || (liveEmail ? liveEmail.split('@')[0] : 'Employee'),
          email: existingU?.email || liveEmail || '',
          role: existingU?.role || (liveDoc as any).role || 'AGENT',
          status: 'ACTIVE',
          employeeId: existingU?.employeeId || liveEmpId || uid,
          process: liveDoc.process || existingU?.process || 'General',
          department: existingU?.department || (liveDoc as any).department || 'Operations',
          location: existingU?.location || (liveDoc as any).location || '',
          photoURL: existingU?.photoURL || (liveDoc as any).photoURL || '',
          teamLeadName: existingU?.teamLeadName || (liveDoc as any).teamLeadName || '',
          mappedManagerName: existingU?.mappedManagerName || existingU?.managerName || (liveDoc as any).managerName || ''
        };

        const mappedRow = mapToLiveSessionRow(userProfile, liveDoc, nowMs);

        // Discard offline sessions
        if (mappedRow.status === 'OFFLINE') {
          return;
        }

        // Match current activity
        const rowAct = (mappedRow.currentActivity || '').toLowerCase().trim();
        const rowProc = (mappedRow.currentProcess || '').toLowerCase().trim();
        const rawLiveAct = getLiveSessionCurrentActivity(liveDoc).toLowerCase().trim();
        const rawShiftProc = (liveDoc.process || '').toLowerCase().trim();

        const matchesActivity = appliedActivities.some(target => {
          const t = target.toLowerCase().trim();
          return rowAct === t || rowProc === t || rawLiveAct === t || rawShiftProc === t;
        });

        if (!matchesActivity) {
          return;
        }

        // Search matching
        if (searchLower) {
          const matchesSearch = 
            mappedRow.userName.toLowerCase().includes(searchLower) ||
            mappedRow.userEmail.toLowerCase().includes(searchLower) ||
            (mappedRow.userId && mappedRow.userId.toLowerCase().includes(searchLower)) ||
            (mappedRow.userProcess && mappedRow.userProcess.toLowerCase().includes(searchLower)) ||
            rowAct.includes(searchLower) ||
            rowProc.includes(searchLower) ||
            mappedRow.status.toLowerCase().includes(searchLower);
          if (!matchesSearch) return;
        }

        // Location matching
        if (selectedLocations.length > 0) {
          if (!selectedLocations.includes(mappedRow.workLocation)) {
            return;
          }
        }

        // Shift status matching
        if (shiftFilter !== 'all') {
          const st = mappedRow.status.toLowerCase();
          if (shiftFilter === 'active' && st !== 'active' && st !== 'productive') return;
          if (shiftFilter === 'break' && st !== 'break') return;
          if (shiftFilter === 'offline' && st !== 'offline') return;
        }

        rows.push(mappedRow);
      });

      console.info(`[TMS GLOBAL ACTIVITY VIEW]
Actor UID: ${user.uid}
Actor Role: ${user.role}
Activity Filter: ${appliedActivities.join(', ')}
Matching Active Users Count: ${rows.length}
Hierarchy Filter: OVERRIDDEN`);

      return rows;
    }

    // =========================================================================
    // NORMAL MODE: Supervisor Team / Hierarchy View
    // =========================================================================
    const rows: LiveSessionRow[] = [];
    const seenUids = new Set<string>();

    // A. Map all users in baseFilteredWorkforce with live_sessions doc
    baseFilteredWorkforce.forEach(u => {
      seenUids.add(u.uid);
      if (u.employeeId) seenUids.add(u.employeeId);

      const liveDocRaw = activeShiftsMap.get(u.uid) || (u.employeeId ? activeShiftsMap.get(u.employeeId) : undefined);
      const ov = teamLocationOverrides[u.uid] || (u.employeeId ? teamLocationOverrides[u.employeeId] : undefined) || (u.email ? teamLocationOverrides[u.email.toLowerCase().trim()] : undefined);
      const liveDoc = ov ? { ...(liveDocRaw || {}), ...ov } : liveDocRaw;

      rows.push(mapToLiveSessionRow(u, liveDoc, nowMs));
    });

    // B. Catch any orphan active live_sessions documents not in baseFilteredWorkforce (only in hierarchy mode)
    activeShifts.forEach(liveDocRaw => {
      const docUid = liveDocRaw.userId || (liveDocRaw as any).uid || liveDocRaw.id;
      if (docUid && !seenUids.has(docUid)) {
        const liveEmail = (liveDocRaw.userEmail || (liveDocRaw as any).email || '').toLowerCase().trim();
        const liveEmpId = ((liveDocRaw as any).employeeId || '').toLowerCase().trim();

        const existingU = usersMap.get(docUid) || 
          (liveEmail ? usersByEmailMap.get(liveEmail) : undefined) ||
          (liveEmpId ? usersByEmpIdMap.get(liveEmpId) : undefined);

        // Only include orphan sessions for users that belong to supervisorTeamUids
        if (!existingU || !supervisorTeamUids.has(existingU.uid)) {
          return;
        }

        seenUids.add(docUid);
        const ov = teamLocationOverrides[docUid] || (liveEmail ? teamLocationOverrides[liveEmail] : undefined);
        const liveDoc = ov ? { ...liveDocRaw, ...ov } : liveDocRaw;

        const realName = existingU?.fullName || existingU?.name || existingU?.employeeName;
        const fallbackName = (liveDoc.userName && liveDoc.userName !== 'Active Employee' ? liveDoc.userName : '') || (liveDoc as any).employeeName;

        const synthUser = {
          uid: docUid,
          name: realName || fallbackName || existingU?.email?.split('@')[0] || liveDoc.userEmail?.split('@')[0] || 'Unknown Agent',
          email: existingU?.email || liveDoc.userEmail || (liveDoc as any).email || '',
          role: existingU?.role || 'AGENT',
          status: 'ONLINE',
          employeeId: existingU?.employeeId || (liveDoc as any).employeeId || docUid,
          process: liveDoc.process || existingU?.process || 'General',
          department: existingU?.department || 'Operations',
          location: existingU?.location || '',
          photoURL: existingU?.photoURL || existingU?.profilePhotoUrl || '',
          teamLeadName: existingU?.teamLeadName || '',
          mappedManagerName: existingU?.mappedManagerName || existingU?.managerName || ''
        };
        rows.push(mapToLiveSessionRow(synthUser, liveDoc, nowMs));
      }
    });

    const allowedUserIds = getTmsDashboardTeamUids(user, rawAllUsers);
    const finalFilteredRows = rows.filter(row => allowedUserIds.has(row.userId));

    // VERIFY & DIAGNOSTIC LOGGING FOR OUTSIDE HIERARCHY USERS
    const outsideHierarchyUsers = finalFilteredRows.filter(
      row => row.userId !== user.uid && !allowedUserIds.has(row.userId)
    );

    const allowedDescendantsList = Array.from(allowedUserIds).filter(id => id !== user.uid);
    const finalRenderedUidsList = finalFilteredRows.map(r => r.userId);

    console.info(`[TMS VISIBILITY FINAL]
Actor UID: ${user.uid}
Actor Role: ${user.role}
Allowed descendant UIDs: ${allowedDescendantsList.join(', ')}
Allowed descendant count: ${allowedDescendantsList.length}
Final rendered user UIDs: ${finalRenderedUidsList.join(', ')}
Final rendered user count: ${finalFilteredRows.length}
Outside-hierarchy users: ${outsideHierarchyUsers.length}`);

    return finalFilteredRows;
  }, [
    isGlobalActivityMode,
    globalLiveShifts,
    activeShifts,
    appliedActivities,
    nowMs,
    usersMap,
    usersByEmailMap,
    usersByEmpIdMap,
    allUsers,
    teamLocationOverrides,
    getLiveSessionCurrentActivity,
    deferredSearchTerm,
    selectedLocations,
    shiftFilter,
    baseFilteredWorkforce,
    activeShiftsMap,
    supervisorTeamUids,
    user,
    rawAllUsers
  ]);

  // 2. Summary cards computed directly from mappedWorkforceRows (Single Source of Truth)
  const liveStats = useMemo(() => {
    const total = mappedWorkforceRows.length;
    let loggedIn = 0;
    let active = 0;
    let onBreak = 0;
    let offline = 0;

    mappedWorkforceRows.forEach(row => {
      if (row.status === 'OFFLINE') {
        offline++;
      } else {
        loggedIn++;
        if (row.status === 'BREAK') {
          onBreak++;
        } else {
          active++;
        }
      }
    });

    return {
      total,
      loggedIn,
      active,
      onBreak,
      offline,
      attendancePercent: total > 0 ? Math.round((loggedIn / total) * 100) : 0
    };
  }, [mappedWorkforceRows]);

  const hierarchyDiagnosticData = useMemo(() => {
    if (!user) return null;
    const tree = new OrgTree(rawAllUsers);
    const directReports = tree.getNode(user.uid)?.children || [];
    const allDescendants = Array.from(tree.getDescendants(user.uid));
    const directCount = directReports.length;
    const indirectCount = Math.max(0, allDescendants.length - directCount);
    const totalExpected = allDescendants.length;

    // Resolved count in current allUsers (excluding supervisor self)
    const resolvedUids = allUsers.filter(u => u.uid !== user.uid).map(u => u.uid);
    const totalResolved = resolvedUids.length;

    const missingUids = allDescendants.filter(id => !resolvedUids.includes(id));

    // Duplicate check
    const uidCounts = new Map<string, number>();
    allUsers.forEach(u => {
      if (u.uid) uidCounts.set(u.uid, (uidCounts.get(u.uid) || 0) + 1);
    });
    const duplicateUids = Array.from(uidCounts.entries()).filter(([_, count]) => count > 1).map(([id]) => id);

    // Unresolved mapping IDs across rawAllUsers
    const unresolvedMappingIds: string[] = [];
    const knownUids = new Set(rawAllUsers.map(u => u.uid));
    rawAllUsers.forEach(u => {
      const norm = normalizeHierarchyUser(u);
      if (norm.teamLeadUid && !knownUids.has(norm.teamLeadUid) && !unresolvedMappingIds.includes(norm.teamLeadUid)) {
        unresolvedMappingIds.push(norm.teamLeadUid);
      }
      if (norm.managerUid && !knownUids.has(norm.managerUid) && !unresolvedMappingIds.includes(norm.managerUid)) {
        unresolvedMappingIds.push(norm.managerUid);
      }
    });

    // Breakdown by live status
    let active = 0;
    let onBreak = 0;
    let offline = 0;
    mappedWorkforceRows.forEach(row => {
      const st = (row.status || '').toUpperCase();
      if (st === 'OFFLINE') offline++;
      else if (st === 'BREAK') onBreak++;
      else active++;
    });

    return {
      managerUid: user.uid,
      hierarchyVersion: hierarchyVersion || 'v1.0',
      directReportees: directCount,
      indirectReportees: indirectCount,
      totalExpected,
      totalResolved,
      missingUids,
      duplicateUids,
      unresolvedMappingIds,
      filteredByLiveStatus: {
        active,
        onBreak,
        offline
      },
      finalTmsCount: mappedWorkforceRows.length
    };
  }, [user, rawAllUsers, allUsers, mappedWorkforceRows, hierarchyVersion]);

  const liveDistribution = useMemo(() => {
    let active = 0;
    let lunch = 0;
    let meeting = 0;
    let otherBreak = 0;
    let offline = 0;

    mappedWorkforceRows.forEach(row => {
      if (row.status === 'OFFLINE') {
        offline++;
      } else if (row.status === 'BREAK') {
        const actLower = row.currentActivity.toLowerCase();
        if (actLower.includes('lunch')) {
          lunch++;
        } else {
          otherBreak++;
        }
      } else if (row.status === 'MEETING') {
        meeting++;
      } else {
        active++;
      }
    });

    return {
      active,
      break: otherBreak,
      lunch,
      meeting,
      offline
    };
  }, [mappedWorkforceRows]);

  const exceededCount = useMemo(() => {
    return mappedWorkforceRows.filter(row => row.status !== 'OFFLINE' && row.productiveSeconds > 12 * 60 * 60).length;
  }, [mappedWorkforceRows]);

  // 3. Filtered rows for table
  const tableFilteredRows = useMemo(() => {
    return mappedWorkforceRows.filter(row => {
      if (tmsAdminTab === 'exceeded_12h') {
        if (row.status === 'OFFLINE') return false;
        if (row.productiveSeconds <= 12 * 60 * 60) return false;
      }

      if (deferredSearchTerm.trim() !== '') {
        const term = deferredSearchTerm.toLowerCase().trim();
        const matchName = row.userName.toLowerCase().includes(term);
        const matchEmail = row.userEmail.toLowerCase().includes(term);
        const matchAct = row.currentActivity.toLowerCase().includes(term);
        const matchProc = row.currentProcess.toLowerCase().includes(term);
        const matchId = row.userId.toLowerCase().includes(term);
        if (!matchName && !matchEmail && !matchAct && !matchProc && !matchId) {
          return false;
        }
      }

      if (shiftFilter === 'active') {
        return row.status === 'PRODUCTIVE' || row.status === 'MEETING' || row.status === 'TRAINING';
      } else if (shiftFilter === 'break') {
        return row.status === 'BREAK';
      } else if (shiftFilter === 'offline') {
        return row.status === 'OFFLINE';
      }

      return true;
    });
  }, [mappedWorkforceRows, deferredSearchTerm, shiftFilter, tmsAdminTab]);

  // 4. Sorted rows
  const sortedWorkforceRows = useMemo(() => {
    const sorted = [...tableFilteredRows];
    sorted.sort((a, b) => {
      if (sortKey === 'status') {
        const priority = (s: string) => {
          if (s === 'PRODUCTIVE') return 1;
          if (s === 'MEETING' || s === 'TRAINING') return 2;
          if (s === 'BREAK') return 3;
          return 4; // OFFLINE
        };
        const pA = priority(a.status);
        const pB = priority(b.status);
        if (pA !== pB) return sortOrder === 'asc' ? pA - pB : pB - pA;
        return a.userName.localeCompare(b.userName);
      }

      if (sortKey === 'productive') {
        return sortOrder === 'asc' 
          ? a.productiveSeconds - b.productiveSeconds 
          : b.productiveSeconds - a.productiveSeconds;
      }

      if (sortKey === 'break') {
        return sortOrder === 'asc' 
          ? a.breakSeconds - b.breakSeconds 
          : b.breakSeconds - a.breakSeconds;
      }

      const cmp = a.userName.localeCompare(b.userName);
      return sortOrder === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [tableFilteredRows, sortKey, sortOrder]);

  // 5. Pagination
  const totalPages = Math.max(1, Math.ceil(sortedWorkforceRows.length / itemsPerPage));

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(Math.max(1, totalPages));
    }
  }, [totalPages, currentPage]);

  const paginatedWorkforceRows = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sortedWorkforceRows.slice(start, start + itemsPerPage);
  }, [sortedWorkforceRows, currentPage, itemsPerPage]);

  // 6. Diagnostic Mode Logger Effect
  useEffect(() => {
    if (diagnosticMode && mappedWorkforceRows.length > 0) {
      const diagData = mappedWorkforceRows
        .filter(row => row.hasActiveLiveSession)
        .map(row => ({
          SessionID: row.sessionId,
          UID: row.userId,
          Employee: row.userName,
          Status: row.status,
          Activity: row.currentActivity,
          ProductiveSeconds: row.productiveSeconds,
          BreakSeconds: row.breakSeconds,
          LastHeartbeat: row.lastHeartbeat,
          DiagnosticStatus: row.diagnosticError || 'VALID'
        }));

      console.group('%c[TMS Supervisor Live View Diagnostics]', 'color: #8b5cf6; font-weight: bold;');
      console.log(`Timestamp: ${new Date().toLocaleTimeString()} | Total Active Sessions: ${diagData.length}`);
      console.table(diagData);
      const issues = diagData.filter(d => d.DiagnosticStatus !== 'VALID');
      if (issues.length > 0) {
        console.warn(`Detected ${issues.length} state conflicts!`, issues);
      }
      console.groupEnd();
    }
  }, [diagnosticMode, mappedWorkforceRows]);

  const uniqueActiveActivities = useMemo(() => {
    const list = new Set<string>();
    
    // Determine scope of users to look for activities
    const relevantUsers = mappedUsers;
    const userEmailSet = new Set(relevantUsers.map(u => (u.email || '').toLowerCase().trim()).filter(Boolean));
    const userIdSet = new Set(relevantUsers.map(u => u.uid).filter(Boolean));

    activeShifts.forEach(sh => {
      const shEmail = (sh.userEmail || '').toLowerCase().trim();
      const shUid = sh.userId;
      
      // If shift belongs to our team
      const isOurTeam = (shEmail && userEmailSet.has(shEmail)) || (shUid && userIdSet.has(shUid));
      if (!isOurTeam) {
        return;
      }

      // Check last activity in array
      const shActs = sh.activities || [];
      const act = shActs.length > 0 ? shActs[shActs.length - 1] : null;
      if (act && act.name) {
        list.add(act.name.trim());
      }
      
      // Fallback to currentActivity field if present
      const currAct = (sh as any).currentActivity;
      if (currAct) {
        list.add(currAct.trim());
      }
    });

    // Ensure we always have some common activities as fallback if list is empty
    if (list.size === 0) {
      ['HITL', 'OQC', 'SOP Training', 'QA Review', 'Team Alignment', 'Admin', 'Support', 'Quality Check'].forEach(a => list.add(a));
    }

    const blocked = ['mpqc', 'mpqc-fk', 'mpqc-sh'];
    return Array.from(list).sort().filter(Boolean).filter(p => !blocked.includes(p.toLowerCase().trim()));
  }, [activeShifts, mappedUsers, allUsers, isTeamLeadOrSME, isManagerOrLead]);

  const uniqueLocations = useMemo(() => {
    const list = new Set<string>();
    list.add('Dehradun (DDN)');
    list.add('Jammu (JMU)');
    list.add('Bangalore (BLR)');
    mappedUsers.forEach(u => {
      if (u.location) {
        list.add(u.location);
      }
    });
    return Array.from(list).filter(Boolean);
  }, [mappedUsers]);

  // Chart Allocations Data
  const roleChartData = useMemo(() => {
    const map = new Map<string, number>();
    mappedUsers.forEach(u => {
      map.set(u.role, (map.get(u.role) || 0) + 1);
    });
    return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
  }, [mappedUsers]);

  const [syncing, setSyncing] = useState(false);


  // Perform operational Force Out
  const executeSupervisorClockOut = async () => {
    if (!logoutTargetUid) {
      console.warn('[FORCE_OUT] Cannot execute force clock-out: logoutTargetUid is empty.');
      return;
    }
    setIsBulkLoggingOut(true);
    console.log(`[FORCE_OUT] Starting force logout for user ${logoutTargetName} (${logoutTargetUid})...`);
    
    const nowISO = getLiveTimeISO();
    const supervisorIdentifier = user?.email || user?.uid || 'Supervisor';
    let shiftUpdateSuccess = false;
    let userUpdateSuccess = false;
    let liveSessionDeleteSuccess = false;

    // 1. Terminate/Complete active shift in tmsShifts
    try {
      let shiftRef = (logoutShiftId && logoutShiftId !== '-') ? doc(db, 'tmsShifts', logoutShiftId) : null;
      let snapshot = null;
      
      if (shiftRef) {
        try {
          snapshot = await getDocOptimized(shiftRef, `force_out_shift_${logoutShiftId}`);
        } catch (getErr: any) {
          console.warn(`[FORCE_OUT] Failed to get shift ${logoutShiftId} via getDocOptimized. Trying cache.`, getErr);
          try {
            snapshot = await getDocFromCache(shiftRef);
          } catch (cacheErr: any) {
            console.warn(`[FORCE_OUT] Failed to get shift ${logoutShiftId} from cache.`, cacheErr);
          }
        }
      }
      
      if (!snapshot || !snapshot.exists()) {
        console.log(`[FORCE_OUT] Shift ID "${logoutShiftId}" not found, invalid, or offline. Querying tmsShifts for user active sessions...`);
        const q = query(
          collection(db, 'tmsShifts'),
          where('userId', '==', logoutTargetUid),
          where('status', 'in', ['ACTIVE', 'BREAK']),
          limit(1)
        );
        let qSnap = null;
        try {
          qSnap = await getDocsOptimized(q, `force_out_query_${logoutTargetUid}`);
        } catch (getQErr: any) {
          console.warn(`[FORCE_OUT] Failed to query shifts via getDocsOptimized. Trying cache.`, getQErr);
          try {
            qSnap = await getDocsFromCache(q);
          } catch (cacheQErr: any) {
            console.warn(`[FORCE_OUT] Failed to query shifts from cache.`, cacheQErr);
          }
        }
        
        if (qSnap && !qSnap.empty) {
          const activeDoc = qSnap.docs.find((d: any) => ['ACTIVE', 'BREAK'].includes(d.data().status));
          
          if (activeDoc) {
            console.log(`[FORCE_OUT] Found active shift in tmsShifts query: ${activeDoc.id}`);
            snapshot = activeDoc;
            shiftRef = doc(db, 'tmsShifts', snapshot.id);
          } else {
            console.log(`[FORCE_OUT] No active shift document found in tmsShifts query for ${logoutTargetUid}.`);
          }
        }
      }

      if (snapshot && snapshot.exists() && shiftRef) {
        const shift = snapshot.data() as TMSShift;
        
        // Centralized lifecycle gate check
        const gateResult = assertShiftLifecycleMutationAllowed(shift.status, 'COMPLETED_FORCED', {
          caller: 'SUPERVISOR_FORCE_OUT',
          actorUid: user?.uid,
          reason: logoutReason ? `Force logout: ${logoutReason}` : 'Force logout by supervisor'
        });
        if (!gateResult.allowed) {
          console.error(`[FORCE_OUT] Mutation blocked by gate: ${gateResult.reason}`);
          toast.error(`Operation blocked: ${gateResult.reason}`);
          return;
        }

        const updatedActivities = [...(shift.activities || [])];
        if (updatedActivities.length > 0) {
          const lastIndex = updatedActivities.length - 1;
          if (!updatedActivities[lastIndex].endTime) {
            // Immutable ledger: removed endTime mutation
          }
        }

        const eventLedger = appendShiftEvent(
          shift.shiftEventLedger,
          shift,
          {
            eventType: 'SUPERVISOR_FORCE_LOGOUT',
            timestamp: nowISO,
            performedBy: `Supervisor: ${user?.employeeName || user?.fullName || supervisorIdentifier}`,
            source: 'Supervisor Panel',
            reason: logoutReason ? `Force logout: ${logoutReason}` : 'Force logout by supervisor',
            oldValue: shift.status,
            newValue: 'COMPLETED_FORCED',
            remarks: `Supervisor action performed remotely`
          }
        );

        const finalShift: TMSShift = {
          ...createLockedCompletedShift(
            shift,
            nowISO,
            supervisorIdentifier,
            logoutReason ? `Force logout by supervisor: ${logoutReason}` : 'Force logout by supervisor',
            undefined,
            'COMPLETED_FORCED'
          ),
          shiftEventLedger: eventLedger
        };

        await setDoc(shiftRef, finalShift);
        shiftUpdateSuccess = true;
        console.log(`[FORCE_OUT] Successfully updated shift ${snapshot.id} to COMPLETED_FORCED.`);

        logTmsEvent('CLOCK_OUT', {
          userId: logoutTargetUid,
          shiftId: snapshot.id,
          timestamp: nowISO,
          reason: logoutReason ? `Force logout by supervisor: ${logoutReason}` : 'Force logout by supervisor',
          sourceFunction: 'executeSupervisorClockOut',
          details: { closedBy: supervisorIdentifier, targetName: logoutTargetName }
        });

        // Log in audit trail
        const auditLogPayload = {
          timestamp: nowISO,
          performedBy: `${user.name} (${user?.email || user?.uid || 'Unknown'})`,
          affectedUser: `${logoutTargetName} (${logoutTargetUid})`,
          action: 'Supervisor Remote Force Logout',
          previousValue: 'ACTIVE_WORK',
          newValue: `COMPLETED (Reason: ${logoutReason})`,
          details: { shiftId: snapshot.id }
        };
        console.log('[AUDIT LOG] Writing Supervisor Remote Force Logout to Firestore:', auditLogPayload);
        addDoc(collection(db, 'adminAuditLogs'), auditLogPayload).catch(e => console.error('Audit log failed', e));
      } else {
        console.log(`[FORCE_OUT] No shift record was fetched for ${logoutTargetUid}. Attempting direct updateDoc fallbacks...`);
        if (shiftRef) {
          try {
            const fallbackLedger = appendShiftEvent(
              undefined,
              undefined,
              {
                eventType: 'SUPERVISOR_FORCE_LOGOUT',
                timestamp: nowISO,
                performedBy: `Supervisor: ${user?.employeeName || user?.fullName || supervisorIdentifier}`,
                source: 'Supervisor Panel',
                reason: logoutReason ? `Force logout: ${logoutReason}` : 'Force logout by supervisor',
                oldValue: 'ACTIVE',
                newValue: 'COMPLETED_FORCED',
                remarks: `Remote forced checkout via direct fallback`
              }
            );
            const fallbackLocked = {
              ...createLockedCompletedShift(
                { id: shiftRef.id, userId: logoutTargetUid, clockInTime: nowISO },
                nowISO,
                supervisorIdentifier,
                logoutReason ? `Force logout by supervisor: ${logoutReason}` : 'Force logout by supervisor',
                undefined,
                'COMPLETED_FORCED'
              ),
              shiftEventLedger: fallbackLedger
            };
            await setDoc(shiftRef, fallbackLocked, { merge: true });
            shiftUpdateSuccess = true;
            console.log(`[FORCE_OUT] Successfully force-updated shift ${shiftRef.id} via direct updateDoc fallback.`);
          } catch (updateErr: any) {
            console.error(`[FORCE_OUT] Direct updateDoc fallback failed for ${shiftRef.id}:`, updateErr);
          }
        } else {
          console.log(`[FORCE_OUT] No shift ID was available, and query returned nothing. Only user and live session will be cleaned up.`);
        }
      }
    } catch (shiftErr: any) {
      console.error(`[FORCE_OUT] Failed to update shift record for ${logoutTargetUid}:`, shiftErr);
    }

    // 2. Set user lastLogoutAt in users collection without mutating administrative status
    try {
      const userRef = doc(db, 'users', logoutTargetUid);
      await setDoc(userRef, {
        lastLogoutAt: nowISO
      }, { merge: true });
      userUpdateSuccess = true;
      console.log(`[FORCE_OUT] Successfully recorded lastLogoutAt in users collection.`);
    } catch (userErr: any) {
      console.error(`[FORCE_OUT] Failed to update user lastLogoutAt in users collection for ${logoutTargetUid}:`, userErr);
    }

    // 3. Delete live_sessions document (Most Critical for UI sync)
    try {
      await deleteDoc(doc(db, 'live_sessions', logoutTargetUid));
      liveSessionDeleteSuccess = true;
      console.log(`[FORCE_OUT] Successfully deleted live_sessions document for ${logoutTargetUid}.`);
    } catch (liveErr: any) {
      console.error(`[FORCE_OUT] Failed to delete live_sessions document for ${logoutTargetUid}:`, liveErr);
    }

    // 3b. Release active lock document so the user can clock in again
    try {
      await setDoc(doc(db, 'tmsActiveLocks', logoutTargetUid), {
        status: 'INACTIVE',
        shiftId: null,
        updatedAt: serverTimestamp()
      }, { merge: true });
      console.log(`[FORCE_OUT] Successfully released active session lock for ${logoutTargetUid}.`);
    } catch (lockErr: any) {
      console.error(`[FORCE_OUT] Failed to release active lock for ${logoutTargetUid}:`, lockErr);
    }

    // Determine final status
    if (liveSessionDeleteSuccess || userUpdateSuccess || shiftUpdateSuccess) {
      toast.success(`Successfully terminated active session for ${logoutTargetName}`);
      setShowForceLogoutConfirm(false);
      
      // Clear local states/triggers
      setLogoutTargetUid('');
      setLogoutTargetName('');
      setLogoutShiftId(null);

      // Force refresh data
      if (recomputeMetrics) recomputeMetrics(true);
      if (onRefreshAllData) onRefreshAllData();
    } else {
      console.error('[FORCE_OUT_FAIL] All methods failed to terminate the session.');
      toast.error('Failed to terminate remote session. Please check your network and permissions.');
    }
    
    setIsBulkLoggingOut(false);
  };

  // Full spreadsheet download routine
  const handleSpreadsheetExport = () => {
    setShowEnhancedExportModal(true);
  };

  const cancelEnhancedExport = () => { if (exportAbortController) { exportAbortController.abort(); setExportAbortController(null); setIsExporting(false); toast.error('Export cancelled.'); } };

  const executeEnhancedExport = async () => {
    const abortCtrl = new AbortController();
    setExportAbortController(abortCtrl);

    setIsExporting(true);
    setExportProgressPercent(5);
    setExportProgressMessage('Starting export...');
    try {
      const res = await generateAndDownloadOrganizationReport({
        actor: user,
        allUsers: rawAllUsers || [],
        authorizedTeamUids: mappedUsers.map(u => u.uid),
        hasTmsPermission: permKey => hasTmsPermission ? hasTmsPermission(permKey) : false,
        signal: abortCtrl.signal,
        preset: exportRangePreset,
        startDateStr: exportStartDate || exportCustomStart,
        endDateStr: exportEndDate || exportCustomEnd,
        format: 'excel',
        reportType: 'all',
        onProgress: (pct, msg) => {
          setExportProgressPercent(pct);
          setExportProgressMessage(msg);
        }
      });

      if (!res.success) {
        toast.error(res.message || 'No records found for the selected date range.');
      } else {
        toast.success('Enhanced report exported successfully!');
        setShowEnhancedExportModal(false);
      }
    } catch (err) {
      console.error('Enhanced Export Error:', err);
      toast.error('Failed to generate enhanced report');
    } finally {
      setIsExporting(false);
      setExportAbortController(null);
    }
  };

  const legacyExecuteEnhancedExport = async () => {
    setIsExporting(true);
    try {
      let end = new Date(getLiveTime().getTime());
      end.setHours(23, 59, 59, 999);
      let start = new Date(end.getTime());

      if (exportRangePreset !== 'custom') {
        const days = parseInt(exportRangePreset, 10) || 0;
        start.setDate(start.getDate() - days);
        start.setHours(0, 0, 0, 0);
      } else {
        const customStart = exportStartDate || exportCustomStart;
        const customEnd = exportEndDate || exportCustomEnd;
        if (!customStart || !customEnd) {
          toast.error('Please select both start and end dates');
          setIsExporting(false);
          return;
        }
        start = new Date(customStart);
        start.setHours(0, 0, 0, 0);
        end = new Date(customEnd);
        end.setHours(23, 59, 59, 999);
      }

      toast.info(`Fetching shift data from ${start.toLocaleDateString()} to ${end.toLocaleDateString()}...`);
      
      const roleNormalized = (user.role || '').toUpperCase();
      const isGlobalAdmin = checkIsGlobalRole(roleNormalized);
      const isManagerRole = ['MANAGER', 'ASSISTANT_MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD'].includes(roleNormalized);

      // Fetch shifts in range
      const constraints: any[] = [
        where('clockInTime', '>=', start.toISOString()),
        where('clockInTime', '<=', end.toISOString())
      ];
      
      if (!isGlobalAdmin) {
        // Scoped query for Supervisors/Managers to prevent massive org-wide reads
        const supervisorField = isManagerRole ? 'managerId' : 'teamLeadUid';
        constraints.push(where(supervisorField, '==', user.uid));
      }

      const q = query(
        collection(db, 'tmsShifts'),
        ...constraints
      );
      
      // Use dynamic cache key so different date ranges don't hit stale cache
      const cacheKey = `export_shifts_${user.uid}_${start.toISOString().split('T')[0]}_${end.toISOString().split('T')[0]}`;
      const snap = await getDocsOptimized(q, cacheKey);
      const rawShifts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
      const shifts = rawShifts.map(sh => sh as TMSShift);

      // Filter for team scope / selected scope
      // Supervisors only see their own team members
      const scopeIds = new Set(mappedUsers.map(u => u.uid));
      scopeIds.add(user.uid);
      let teamShifts = shifts.filter(sh => scopeIds.has(sh.userId));

      // O(1) User maps for fast lookups (using rawAllUsers for full organization export data)
      const usersByIdMap = new Map<string, any>();
      const usersByEmailMap = new Map<string, any>();
      rawAllUsers.forEach(u => {
        if (u.uid) usersByIdMap.set(u.uid, u);
        if (u.email) usersByEmailMap.set(u.email.toLowerCase().trim(), u);
      });

      // Process filter for export
      if (exportSelectedProcess !== 'all') {
        const filterProcessLower = exportSelectedProcess.toLowerCase().trim();
        teamShifts = teamShifts.filter(sh => {
          let u = sh.userId ? usersByIdMap.get(sh.userId) : undefined;
          if (!u && sh.userEmail) {
            u = usersByEmailMap.get(sh.userEmail.toLowerCase().trim());
          }
          const shiftProcess = (sh.process || '').toLowerCase().trim();
          const userProcess = (u?.process || '').toLowerCase().trim();
          return shiftProcess === filterProcessLower || userProcess === filterProcessLower;
        });
      }

      if (teamShifts.length === 0) {
        toast.error(`No shift data found for the selected range (${start.toLocaleDateString()} to ${end.toLocaleDateString()}).`);
        setIsExporting(false);
        return;
      }

      const workbook = XLSX.utils.book_new();

      const getWorkDateString = (date: Date | string) => {
        const d = new Date(date);
        // Logical offset: shifts starting between 00:00 and 04:00 belong to previous day
        const logicalDate = new Date(d.getTime() - 4 * 60 * 60 * 1000);
        return logicalDate.toLocaleDateString('en-IN');
      };

      // 1. Utilization Summary
      if (exportReportType === 'summary' || exportReportType === 'all') {
        const summaryHeaders = [
          'Emp ID', 'Employee Name', 'Email', 'Role', 'Department', 'Location', 'Process / Segment', 'Team Lead', 'Manager',
          'Date', 'Clock In', 'Clock Out', 'Shift Status',
          'Prod Minutes', 'Break Minutes', 'Total Minutes', 'Utilization %',
          'Work Location', 'Detection Method', 'Office Name', 'Public IP', 'Location Captured At'
        ];

        const mergedShifts = aggregateShiftsForHistoryAndReports(teamShifts, getLiveTime().getTime());
        const summaryRows = mergedShifts.map(m => {
          let u = m.userId ? usersByIdMap.get(m.userId) : undefined;
          if (!u && m.userEmail) {
            u = usersByEmailMap.get(m.userEmail.toLowerCase().trim());
          }
          const clockInStr = new Date(m.clockInTime).toLocaleTimeString('en-IN');
          const clockOutStr = m.clockOutTime ? new Date(m.clockOutTime).toLocaleTimeString('en-IN') : 'N/A';
          const prodMins = Math.round(m.productiveMs / 60000);
          const breakMins = Math.round(m.breakMs / 60000);
          const totalMins = Math.round(m.connectedMs / 60000);
          
          return [
            u?.employeeId || (u as any)?.empID || 'N/A',
            u?.fullName || u?.name || m.userName,
            u?.email || m.userEmail,
            u?.role || 'N/A',
            u?.department || 'Operations',
            u?.location || 'N/A',
            m.process || u?.process || 'N/A',
            u?.teamLeadName || 'Unassigned',
            u?.mappedManagerName || u?.managerName || 'Unassigned',
            m.attendanceDate,
            clockInStr,
            clockOutStr,
            m.status,
            prodMins,
            breakMins,
            totalMins,
            m.utilization,
            m.workLocation || 'Home',
            m.workLocationSource || 'IP Detection',
            m.officeName || 'N/A',
            m.publicIP || 'N/A',
            m.locationCapturedAt ? new Date(m.locationCapturedAt).toLocaleString('en-IN') : 'N/A'
          ];
        });

        const ws = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
        XLSX.utils.book_append_sheet(workbook, ws, "Utilization Summary");
      }

      // 2. Attendance Report
      if (exportReportType === 'attendance' || exportReportType === 'all') {
        const attendanceHeaders = [
          'Emp ID', 'Employee Name', 'Email', 'Location', 'Process', 'Team Lead', 'Manager',
          'Date', 'Productive Minutes', 'Attendance Status'
        ];

        const mergedShifts = aggregateShiftsForHistoryAndReports(teamShifts, getLiveTime().getTime());
        const attendanceRows = mergedShifts.map(m => {
          let u = m.userId ? usersByIdMap.get(m.userId) : undefined;
          if (!u && m.userEmail) {
            u = usersByEmailMap.get(m.userEmail.toLowerCase().trim());
          }
          
          const productiveMins = Math.round(m.productiveMs / 60000);
          let attendanceStatus = 'Half Day';
          if (productiveMins > 480) {
            attendanceStatus = 'Present';
          } else if (productiveMins < 240) {
            attendanceStatus = 'Absent';
          }

          return [
            u?.employeeId || (u as any)?.empID || 'N/A',
            u?.fullName || u?.name || m.userName,
            u?.email || m.userEmail,
            u?.location || 'N/A',
            m.process || u?.process || 'N/A',
            u?.teamLeadName || 'Unassigned',
            u?.mappedManagerName || u?.managerName || 'Unassigned',
            m.attendanceDate,
            productiveMins,
            attendanceStatus
          ];
        });

        const ws = XLSX.utils.aoa_to_sheet([attendanceHeaders, ...attendanceRows]);
        XLSX.utils.book_append_sheet(workbook, ws, "Attendance");
      }

      // 3. Chronological Log
      if (exportReportType === 'chrono' || exportReportType === 'all') {
        const chronoHeaders = [
          'Emp ID', 'Employee Name', 'Email', 'Location', 'Date', 'Sequence', 'Type', 'Activity', 'Start Time', 'End Time', 'Duration (Min)'
        ];

        const chronoRows: any[] = [];
        const sortedShiftsForChrono = [...teamShifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());
        sortedShiftsForChrono.forEach(sh => {
          const dateStr = new Date(sh.clockInTime).toLocaleDateString('en-IN');
          let u = sh.userId ? usersByIdMap.get(sh.userId) : undefined;
          if (!u && sh.userEmail) {
            u = usersByEmailMap.get(sh.userEmail.toLowerCase().trim());
          }
          const empId = u?.employeeId || (u as any)?.empID || 'N/A';
          const loc = u?.location || 'N/A';

          const reconstructed = buildTimelineFromActivityLedger(sh.activities || [], sh.status || 'ACTIVE', sh.clockOutTime, getLiveTime().getTime());
          reconstructed.forEach((act, idx) => {
            const startStr = new Date(act.startTime).toLocaleTimeString('en-IN');
            const endStr = act.isLive ? 'Ongoing' : new Date(act.endTime).toLocaleTimeString('en-IN');
            const durationMs = new Date(act.endTime).getTime() - new Date(act.startTime).getTime();
            const durationMins = durationMs / 60000;

            chronoRows.push([
              empId,
              sh.userName,
              sh.userEmail,
              loc,
              dateStr,
              idx + 1,
              act.type,
              act.name,
              startStr,
              endStr,
              Math.round(durationMins)
            ]);
          });
        });

        const ws = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
        XLSX.utils.book_append_sheet(workbook, ws, "Chronological Activity Log");

        // 4. Immutable Event Ledger Sheet
        const ledgerHeaders = [
          'Employee', 'User Email', 'Shift Date', 'Event Sequence', 'Event Time',
          'Event Type', 'Old Value', 'New Value', 'Reason', 'Source',
          'Performed By', 'Confidence', 'Remarks'
        ];

        const ledgerRows: any[] = [];
        sortedShiftsForChrono.forEach(sh => {
          const rows = formatShiftLedgerForReport(sh);
          rows.forEach(r => {
            ledgerRows.push([
              r['Employee'],
              r['User Email'],
              r['Shift Date'],
              r['Event Sequence'],
              r['Event Time'],
              r['Event Type'],
              r['Old Value'],
              r['New Value'],
              r['Reason'],
              r['Source'],
              r['Performed By'],
              r['Confidence'],
              r['Remarks']
            ]);
          });
        });

        const ledgerWs = XLSX.utils.aoa_to_sheet([ledgerHeaders, ...ledgerRows]);
        XLSX.utils.book_append_sheet(workbook, ledgerWs, "Immutable Event Ledger");
      }



      const safeUserSuffix = (user.fullName || user.name || 'User').split(' ').join('_');
      const zip = new JSZip();

      if (exportFormat === 'excel') {
        const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        zip.file(`TMS_Enhanced_Report_${safeUserSuffix}.xlsx`, excelBuffer);
      } else {
        // Simple CSV handling for the first sheet
        const firstSheetName = workbook.SheetNames[0];
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheetName]);
        zip.file(`TMS_Enhanced_Report_${safeUserSuffix}.csv`, csv);
      }

      const zipContent = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const url = URL.createObjectURL(zipContent);
      const link = document.createElement('a');
      link.href = url;
      link.download = `TMS_Enhanced_Report_${safeUserSuffix}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success('Enhanced report exported successfully!');
      setShowEnhancedExportModal(false);
    } catch (err) {
      console.error('Enhanced Export Error:', err);
      toast.error('Failed to generate enhanced report');
    } finally {
      setIsExporting(false);
      setExportAbortController(null);
    }
  };

  const executeBulkForceLogout = async (filterMode: 'all' | 'stale' = 'all') => {
    let targets = [...activeShifts];
    if (filterMode === 'stale') {
      const now = getLiveTime().getTime();
      targets = activeShifts.filter(sh => {
        const { productiveMs } = calculateShiftMetrics(sh, now);
        return (productiveMs / 3600000) >= 10;
      });
    }

    if (targets.length === 0) {
      toast.error(filterMode === 'stale' ? 'No stale sessions (>10h) found.' : 'No active shifts found to logout.');
      return;
    }
    
    setIsBulkLoggingOut(true);
    try {
      const batch = writeBatch(db);
      const nowISO = getLiveTimeISO();
      const count = targets.length;
      
      targets.forEach(sh => {
        // Enforce centralized lifecycle gate for bulk logout
        const gateResult = assertShiftLifecycleMutationAllowed(sh.status, 'COMPLETED', {
          caller: 'SUPERVISOR_FORCE_OUT',
          actorUid: user?.uid,
          reason: `Bulk Force Logout (${filterMode}) by Supervisor`
        });
        if (!gateResult.allowed) {
          console.warn(`[BULK FORCE OUT] Skipping shift ${sh.id} (User: ${sh.userId}) - Gate Reason: ${gateResult.reason}`);
          return;
        }

        const updatedActivities = [...(sh.activities || [])];
        if (updatedActivities.length > 0) {
          const lastIndex = updatedActivities.length - 1;
          if (!updatedActivities[lastIndex].endTime) {
            // Immutable ledger: removed endTime mutation
          }
        }

        // 1. Update Shift Record
        batch.set(doc(db, 'tmsShifts', sh.id), {
          ...sh,
          activities: updatedActivities,
          status: 'COMPLETED',
          clockOutTime: nowISO,
          remarks: `Bulk Force Logout (${filterMode}) by Supervisor`
        }, { merge: true });

        // 2. Update User lastLogoutAt (preserve administrative status)
        batch.update(doc(db, 'users', sh.userId), {
          lastLogoutAt: nowISO
        });

        // 3. Clean up Live Session
        batch.delete(doc(db, 'live_sessions', sh.userId));

        // 4. Release Active Lock
        batch.set(doc(db, 'tmsActiveLocks', sh.userId), {
          status: 'INACTIVE',
          shiftId: null,
          updatedAt: serverTimestamp()
        }, { merge: true });
      });

      await batch.commit();

      // Audit logs
      const auditLogPayload = {
        timestamp: nowISO,
        performedBy: `${user.name} (${user?.email || user?.uid || 'Unknown'})`,
        affectedUser: `Multiple Users (${count} - ${filterMode})`,
        action: 'Supervisor Bulk Force Logout',
        previousValue: 'ACTIVE_WORK',
        newValue: 'COMPLETED',
        remarks: `Bulk logout performed for ${count} users. Mode: ${filterMode}`,
        details: { count, filterMode }
      };
      console.log('[AUDIT LOG] Writing Supervisor Bulk Force Logout to Firestore:', auditLogPayload);
      addDoc(collection(db, 'adminAuditLogs'), auditLogPayload).catch(e => console.error('Audit log failed', e));

      toast.success(`Successfully logged out ${count} active users.`);
      setShowBulkLogoutModal(false);
      if (recomputeMetrics) recomputeMetrics(true);
      if (onRefreshAllData) onRefreshAllData();
    } catch (err) {
      console.error('Bulk Logout Error:', err);
      toast.error('Failed to perform bulk logout');
    } finally {
      setIsBulkLoggingOut(false);
    }
  };

  // Helper navigate directly to exception user inside table
  const selectAndFocusUser = (targetName: string) => {
    setSearchTerm(targetName);
    setActiveTab('controls');
    setCurrentPage(1);
    toast.info(`Focused view onto matching profile: ${targetName}`);
  };

  // Helper navigate to workforce controls using a custom state distribution filter
  const handleDistributionClick = (filterVal: string, filterLabel: string) => {
    setShiftFilter(filterVal);
    setActiveTab('controls');
    setCurrentPage(1);
    toast.info(`Filtering user management view for matching state: ${filterLabel}`);
  };

  // Filter alerts to show only for mapped users under this supervisor's team
  const teamAlerts = useMemo(() => {
    const scopeIds = new Set(mappedUsers.map(u => u.uid));
    return alerts.filter(alert => scopeIds.has(alert.userId));
  }, [alerts, mappedUsers]);

  // Bifurcate teamAlerts into three categories: break exceeds, Mobile Logs & Auto-Logouts
  const breakExceedsAlerts = useMemo(() => {
    return teamAlerts.filter(a => a.type === 'excessive_break' || a.type === 'long_idle');
  }, [teamAlerts]);

  const mobileLogsAlerts = useMemo(() => {
    return teamAlerts.filter(a => a.type === 'mobile_punch');
  }, [teamAlerts]);

  const autoLogoutsAlerts = useMemo(() => {
    return teamAlerts.filter(a => a.type === 'stale_session' || a.type === 'missed_clock_out');
  }, [teamAlerts]);

  const renderAlertCard = (alert: any, category: 'break' | 'mobile' | 'logout') => {
    let cardBgBorderClass = 'bg-slate-50 dark:bg-slate-800/20 border-slate-100 dark:border-slate-700';
    let badgeClass = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
    let iconBgClass = 'bg-slate-100 text-slate-500';
    
    if (category === 'break') {
      cardBgBorderClass = alert.severity === 'high' 
        ? 'bg-amber-500/[0.03] dark:bg-amber-550/[0.02] border-amber-200/50 dark:border-amber-900/30' 
        : 'bg-amber-500/[0.01] dark:bg-amber-550/[0.01] border-amber-100/50 dark:border-amber-950/20';
      badgeClass = alert.severity === 'high' 
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-200/40' 
        : 'bg-amber-50 text-amber-700 dark:bg-amber-950/70 dark:text-amber-400';
      iconBgClass = 'bg-amber-100/70 text-amber-600 dark:bg-amber-400/20';
    } else if (category === 'mobile') {
      cardBgBorderClass = 'bg-sky-500/[0.02] dark:bg-sky-550/[0.02] border-sky-100 dark:border-sky-900/30';
      badgeClass = 'bg-sky-100 text-sky-850 dark:bg-sky-950 dark:text-sky-300 border border-sky-200/40';
      iconBgClass = 'bg-sky-100/70 text-sky-600 dark:bg-sky-400/20';
    } else if (category === 'logout') {
      cardBgBorderClass = alert.severity === 'high' 
        ? 'bg-rose-500/[0.03] dark:bg-rose-550/[0.02] border-rose-200/50 dark:border-rose-900/30' 
        : 'bg-rose-500/[0.01] dark:bg-rose-550/[0.01] border-rose-100/50 dark:border-rose-950/20';
      badgeClass = alert.severity === 'high' 
        ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border border-rose-200/40' 
        : 'bg-rose-50 text-rose-700 dark:bg-rose-950/70 dark:text-rose-400';
      iconBgClass = 'bg-rose-100/70 text-rose-600 dark:bg-rose-400/20';
    }

    return (
      <div 
        key={alert.id} 
        className={`p-4 rounded-2xl border transition-all hover:shadow-md flex flex-col ${cardBgBorderClass}`}
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className={`p-2 rounded-lg shrink-0 ${iconBgClass}`}>
            {category === 'break' ? <Coffee size={14} /> : category === 'mobile' ? <Smartphone size={14} /> : <AlertTriangle size={14} />}
          </div>
          <div className="text-right">
            <span className={`text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider ${badgeClass}`}>
              {alert.severity}
            </span>
            <p className="text-[8px] text-slate-400 mt-0.5 font-mono font-bold uppercase">{new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          </div>
        </div>
        
        <div className="mb-2">
          <h4 className="font-black text-slate-800 dark:text-slate-100 text-xs leading-tight">{alert.userName}</h4>
          <p className="text-[9px] text-slate-400 dark:text-slate-500 truncate">{alert.email}</p>
          <div className="p-2 bg-white/50 dark:bg-slate-900/40 rounded border border-slate-100 dark:border-slate-800/30 mt-1">
            <p className="text-[10px] text-slate-700 dark:text-slate-300 leading-snug font-medium">{alert.message}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 mt-auto pt-2 border-t border-slate-100 dark:border-slate-800/30">
          <button 
            onClick={() => selectAndFocusUser(alert.userName)}
            className="flex-1 py-1.5 rounded bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-[9px] font-black uppercase text-slate-500 dark:text-slate-400 transition-colors cursor-pointer"
          >
            Investigate
          </button>
          <button 
            onClick={() => {
              setLogoutTargetUid(alert.userId);
              setLogoutTargetName(alert.userName);
              setLogoutReason(`Automated Alert: ${alert.message}`);
              const sh = activeShifts.find(s => s.userId === alert.userId);
              if (sh) setLogoutShiftId(sh.id);
              setShowForceLogoutConfirm(true);
            }}
            className="flex-1 py-1.5 rounded bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200/40 dark:bg-rose-950/50 dark:hover:bg-rose-900/60 dark:text-rose-400 dark:border-rose-900/40 text-[9px] font-black uppercase transition-colors cursor-pointer"
          >
            Force Out
          </button>
        </div>
      </div>
    );
  };

  const formatDuration = (ms: number) => {
    if (isNaN(ms) || ms <= 0) return '00h 00m 00s';
    const totalSecs = Math.floor(ms / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    return `${h.toString().padStart(2, '0')}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
  };

  const supervisorRecentActivity = useMemo(() => {
    const list: Array<{
      id: string;
      userName: string;
      eventType: string;
      timestamp: string;
      detail: string;
      performedBy: string;
    }> = [];
    
    const allKnownShifts = [...(liveShifts || []), ...(paginatedShifts || [])];
    
    allKnownShifts.forEach(sh => {
      if (sh.shiftEventLedger) {
        sh.shiftEventLedger.forEach((evt: any) => {
          const isInteresting = [
            'SUPERVISOR_FORCE_LOGOUT',
            'SHIFT_RECOVERY',
            'MANUAL_CORRECTION',
            'SHIFT_EXTENSION',
            'PROCESS_SWITCH'
          ].includes(evt.eventType);
          
          if (isInteresting) {
            let detail = '';
            if (evt.eventType === 'SUPERVISOR_FORCE_LOGOUT') detail = 'Supervisor forced logout';
            else if (evt.eventType === 'SHIFT_RECOVERY') detail = 'Session recovered';
            else if (evt.eventType === 'MANUAL_CORRECTION') detail = evt.reason || 'Manual correction applied';
            else if (evt.eventType === 'SHIFT_EXTENSION') detail = 'Shift extended';
            else if (evt.eventType === 'PROCESS_SWITCH') detail = `Switched process to ${evt.newValue || 'N/A'}`;
            
            list.push({
              id: `${sh.id}-${evt.sequence}`,
              userName: sh.userName || 'Unknown Agent',
              eventType: evt.eventType,
              timestamp: evt.timestamp,
              detail,
              performedBy: evt.performedBy || 'System'
            });
          }
        });
      }
    });
    
    return list
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 8);
  }, [liveShifts, paginatedShifts]);

  const statusChartData = useMemo(() => {
    let active = 0;
    let onBreak = 0;
    let completed = 0;
    let inactive = 0;
    
    propAllUsers?.forEach(u => {
      const sh = activeShifts.find(s => s.userId === u.uid);
      if (!sh) {
        inactive++;
      } else if (sh.status === 'BREAK') {
        onBreak++;
      } else if (sh.status === 'COMPLETED' || sh.status === 'CLOSED') {
        completed++;
      } else {
        active++;
      }
    });
    
    return [
      { name: 'Active', value: active, color: '#10b981' },
      { name: 'On Break', value: onBreak, color: '#f59e0b' },
      { name: 'Completed', value: completed, color: '#6366f1' },
      { name: 'Inactive/Offline', value: inactive, color: '#94a3b8' }
    ];
  }, [propAllUsers, activeShifts]);

  const processChartData = useMemo(() => {
    const counts: Record<string, number> = {};
    activeShifts.forEach(sh => {
      if (sh.status !== 'COMPLETED' && sh.status !== 'CLOSED') {
        const proc = sh.currentProcess || sh.activities?.[sh.activities.length - 1]?.name || 'Unknown';
        counts[proc] = (counts[proc] || 0) + 1;
      }
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [activeShifts]);

  const groupedAgentsByProcess = useMemo(() => {
    const groups: Record<string, any[]> = {};
    activeShifts.forEach(sh => {
      if (sh.status !== 'COMPLETED' && sh.status !== 'CLOSED') {
        const proc = sh.currentProcess || sh.activities?.[sh.activities.length - 1]?.name || 'Unknown';
        if (!groups[proc]) groups[proc] = [];
        groups[proc].push({
          userId: sh.userId,
          userName: sh.userName,
          status: sh.status
        });
      }
    });
    return groups;
  }, [activeShifts]);

  const renderSupervisorPunchStation = () => {
    const isClockedIn = !!currentShift;
    const isOnBreak = currentShift?.status === 'BREAK';
    
    // Calculate personal session stats using the single source of truth engine
    let elapsedMs = 0;
    let productiveMs = 0;
    let breakMs = 0;
    if (isClockedIn) {
      const metrics = calculateShiftMetrics(currentShift, getLiveTime().getTime());
      elapsedMs = metrics.elapsedMs;
      productiveMs = metrics.productiveMs;
      breakMs = metrics.breakMs;
    }

    const totalCalculated = productiveMs + breakMs;
    const prodPercent = totalCalculated > 0 ? Math.round((productiveMs / totalCalculated) * 100) : 100;
    const breakPercent = totalCalculated > 0 ? Math.round((breakMs / totalCalculated) * 100) : 0;

    return (
      <div className="p-6 space-y-6 bg-slate-50 dark:bg-slate-950/30 overflow-y-auto h-full">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* LEFT PANEL - COLSPAN 5 (Info card and Timeline) */}
          <div className="lg:col-span-5 space-y-6">
            
            {/* Section 1: Supervisor Information Card */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col space-y-4">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-full bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-100 dark:border-indigo-900/40 flex items-center justify-center text-lg font-bold text-indigo-500 overflow-hidden shrink-0">
                  {user?.profilePhotoUrl ? (
                    <img src={user.profilePhotoUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    (user?.fullName || user?.name || 'U').split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase()
                  )}
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-800 dark:text-slate-100 leading-tight">
                    {user?.fullName || user?.name || 'N/A'}
                  </h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100/30 dark:border-indigo-900/30 text-[9px] font-black uppercase text-indigo-650 dark:text-indigo-400 font-mono">
                      {user?.role || 'Supervisor'}
                    </span>
                    <span className={`w-2 h-2 rounded-full ${isClockedIn ? (isOnBreak ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500 animate-pulse') : 'bg-slate-400'}`} />
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                      {isClockedIn ? (isOnBreak ? 'On Break' : 'On-Duty') : 'Off-Duty'}
                    </span>
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4 pt-3 border-t border-slate-150 dark:border-slate-800/60 text-xs font-semibold">
                <div>
                  <span className="text-[9px] text-slate-400 dark:text-slate-500 font-black uppercase tracking-wider block">Department</span>
                  <span className="text-slate-700 dark:text-slate-300 font-bold">{user?.department || 'Operations'}</span>
                </div>
                <div>
                  <span className="text-[9px] text-slate-400 dark:text-slate-500 font-black uppercase tracking-wider block">Email</span>
                  <span className="text-slate-700 dark:text-slate-300 font-bold truncate block">{user?.email || 'N/A'}</span>
                </div>
              </div>
              
              {isClockedIn && (
                <div className="flex items-center gap-3 pt-3 border-t border-slate-150 dark:border-slate-800/60">
                  <div className="flex-1 text-center bg-emerald-50/50 dark:bg-emerald-950/20 p-2 rounded-xl border border-emerald-100/20">
                    <span className="text-[8px] font-black uppercase text-emerald-600 block tracking-wider">Productive Hours</span>
                    <span className="text-xs font-black text-emerald-700 dark:text-emerald-400 font-mono">{formatDuration(productiveMs)}</span>
                  </div>
                  <div className="flex-1 text-center bg-amber-50/50 dark:bg-amber-950/20 p-2 rounded-xl border border-amber-100/20">
                    <span className="text-[8px] font-black uppercase text-amber-600 block tracking-wider font-semibold">Break Hours</span>
                    <span className="text-xs font-black text-amber-700 dark:text-amber-400 font-mono">{formatDuration(breakMs)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Section 3: Today's Timeline */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col space-y-4">
              <h4 className="text-xs font-black text-slate-450 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                <Clock3 size={14} className="text-indigo-400" />
                Today's Timeline
              </h4>
              <div className="relative pl-6 border-l-2 border-slate-100 dark:border-slate-800 ml-2 space-y-4 max-h-[280px] overflow-y-auto pr-2">
                {isClockedIn && currentShift ? (
                  buildTimelineFromActivityLedger(
                    currentShift.activities || currentShift.shiftEventLedger || [],
                    currentShift.status || 'ACTIVE',
                    currentShift.clockOutTime
                  ).map((act: any, i: number) => {
                    const isAudit = isAuditOrDiagnosticEvent(act.action) || act.type === 'system';
                    const isProductive = !isAudit && (act.type === 'productive' || 
                                 ['meeting', 'coaching', 'training', 'alignment'].some(k => (act.name || '').toLowerCase().includes(k)));
                    
                    let dotColor = isAudit 
                      ? 'bg-slate-400 ring-4 ring-slate-100 dark:ring-slate-800' 
                      : isProductive 
                        ? 'bg-emerald-500 ring-4 ring-emerald-100 dark:ring-emerald-950/50' 
                        : 'bg-amber-500 ring-4 ring-amber-100 dark:ring-amber-950/50';
                    if (act.isLive) dotColor = 'bg-sky-500 ring-4 ring-sky-100 dark:ring-sky-950/50 animate-pulse';

                    return (
                      <div key={i} className="relative">
                        <span className={`absolute -left-[31px] top-1 w-3.5 h-3.5 rounded-full ${dotColor} flex items-center justify-center`} />
                        <div>
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="font-mono font-black text-slate-500 uppercase tracking-wider">
                              {isAudit ? 'System Event' : (act.name || 'Work')}
                              {act.isLive && <span className="ml-2 text-[8px] bg-red-600 text-white px-1 rounded-full">LIVE</span>}
                            </span>
                            <span className="text-slate-400 font-mono font-bold uppercase">
                              {new Date(act.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 
                              {' - '}
                              {act.isLive ? 'CURRENT' : new Date(act.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          <p className="text-xs text-slate-700 dark:text-slate-300 font-semibold mt-1">
                            {isAudit ? `Audit Event: ${act.name || act.action || 'System Repair'}` : isProductive ? `Working on ${act.name || 'Production'}` : `On Break: ${act.name || 'Break'}`}
                          </p>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="py-6 text-center text-slate-455 uppercase tracking-widest text-[10px] font-bold">
                    No active shift recorded for today.
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* RIGHT PANEL - COLSPAN 7 (Punch controls & Session statistics) */}
          <div className="lg:col-span-7 space-y-6">
            
            {/* Section 2: Punch Controls */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col space-y-5">
              <h4 className="text-xs font-black text-slate-455 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                <Zap size={14} className="text-emerald-500 animate-pulse" />
                Punch Controls
              </h4>
              
              {!isClockedIn ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Select Process</label>
                    <select 
                      value={superSelectedProcess} 
                      onChange={e => setSuperSelectedProcess(e.target.value)} 
                      className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500 transition-colors"
                    >
                      {processes?.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <button 
                    onClick={() => {
                      if (!superSelectedProcess && processes && processes.length > 0) {
                        setSuperSelectedProcess(processes[0]);
                      }
                      setShowSuperClockInConfirm(true);
                    }}
                    disabled={isProcessingPunch}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs h-12 rounded-xl shadow-lg shadow-emerald-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider disabled:opacity-50"
                  >
                    <Play size={14} />
                    Clock In
                  </button>
                </div>
              ) : (
                <div className="space-y-5">
                  
                  {/* Active Process / Location bar */}
                  <div className="p-4 bg-slate-50 dark:bg-slate-950/40 rounded-xl border border-slate-155 dark:border-slate-800/60 flex items-center justify-between">
                    <div className="space-y-1">
                      <span className="text-[8px] font-black uppercase text-slate-400 tracking-widest block">Active Process</span>
                      <span className="text-xs font-black text-indigo-650 dark:text-indigo-400 uppercase tracking-wider bg-indigo-50 dark:bg-indigo-950/50 px-2.5 py-1 rounded border border-indigo-100/10">
                        {currentShift.currentProcess || 'N/A'}
                      </span>
                    </div>
                    <div className="text-right space-y-1">
                      <span className="text-[8px] font-black uppercase text-slate-400 tracking-widest block">Work Location</span>
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1 justify-end">
                        <span>{currentShift.workLocation === 'Office' ? '🏢 Office' : '🏠 Home'}</span>
                        <button
                          onClick={() => {
                            const newLoc = currentShift.workLocation === 'Office' ? 'Home' : 'Office';
                            if (typeof handleManualLocationOverride === 'function') {
                              handleManualLocationOverride(newLoc);
                            }
                          }}
                          className="text-[10px] text-indigo-500 hover:underline font-bold uppercase tracking-wider ml-1"
                        >
                          (Switch)
                        </button>
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Break Action */}
                    {isOnBreak ? (
                      <button 
                        onClick={() => {
                          const lastProductive = currentShift?.activities ? [...currentShift.activities].reverse().find((act: any) => act.type === 'productive') : null;
                          if (lastProductive && processes?.includes(lastProductive.name)) {
                            setSuperSelectedProcess(lastProductive.name);
                          } else if (user?.lastUsedProcess && processes?.includes(user.lastUsedProcess)) {
                            setSuperSelectedProcess(user.lastUsedProcess);
                          }
                          setShowSuperResumeConfirm(true);
                        }}
                        disabled={isProcessingPunch}
                        className="w-full bg-teal-600 hover:bg-teal-700 text-white font-black text-xs h-12 rounded-xl shadow-lg shadow-teal-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider"
                      >
                        <Zap size={14} />
                        Resume Work
                      </button>
                    ) : (
                      <div className="flex gap-2 w-full">
                        <select 
                          value={superSelectedBreak}
                          onChange={e => setSuperSelectedBreak(e.target.value)}
                          className="text-xs font-bold p-2 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500 transition-colors w-1/3"
                        >
                          <option value="Lunch">Lunch</option>
                          <option value="Bio">Bio</option>
                          <option value="Short">Short</option>
                        </select>
                        <button 
                          onClick={() => setShowSuperBreakConfirm(true)}
                          disabled={isProcessingPunch}
                          className="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-black text-xs h-12 rounded-xl shadow-lg shadow-amber-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider"
                        >
                          <Coffee size={14} />
                          Take Break
                        </button>
                      </div>
                    )}

                    {/* Process Switch (Disabled on break) */}
                    <div className="flex gap-2 w-full">
                      <select 
                        value={superSelectedProcess} 
                        onChange={e => setSuperSelectedProcess(e.target.value)} 
                        disabled={isOnBreak || isProcessingPunch}
                        className="text-xs font-bold p-2 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500 transition-colors w-1/3 disabled:opacity-50"
                      >
                        {processes?.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <button 
                        onClick={() => {
                          if (typeof handleSwitchProcess === 'function') {
                            handleSwitchProcess(superSelectedProcess);
                          }
                        }}
                        disabled={isOnBreak || isProcessingPunch}
                        className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs h-12 rounded-xl shadow-lg shadow-indigo-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider disabled:opacity-50"
                      >
                        <RefreshCw size={14} />
                        Switch Process
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Shift Extension */}
                    <button 
                      onClick={() => {
                        if (typeof handleExtendShift === 'function') {
                          handleExtendShift();
                        }
                      }}
                      disabled={currentShift?.sessionExtended || isProcessingPunch}
                      className="w-full bg-sky-500 hover:bg-sky-600 text-white font-black text-xs h-12 rounded-xl shadow-lg shadow-sky-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider disabled:opacity-50"
                    >
                      <Sparkles size={14} />
                      {currentShift?.sessionExtended ? 'Extended' : 'Request Extension'}
                    </button>

                    {/* Clock Out */}
                    <button 
                      onClick={() => setShowSuperClockOutConfirm(true)}
                      disabled={isProcessingPunch}
                      className="w-full bg-rose-600 hover:bg-rose-700 text-white font-black text-xs h-12 rounded-xl shadow-lg shadow-rose-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider"
                    >
                      <LogOut size={14} />
                      End Shift
                    </button>
                  </div>

                </div>
              )}
            </div>

            {/* Section 4: Current Session Statistics */}
            {isClockedIn && (
              <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col space-y-4">
                <h4 className="text-xs font-black text-slate-455 dark:text-slate-500 uppercase tracking-widest">
                  Current Session Statistics
                </h4>
                
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-155 dark:border-slate-800/60">
                    <span className="text-[8px] font-black uppercase text-slate-400 block tracking-wider">Session Started</span>
                    <span className="text-xs font-black text-slate-800 dark:text-slate-200 font-mono mt-0.5 block">{new Date(currentShift.clockInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-155 dark:border-slate-800/60">
                    <span className="text-[8px] font-black uppercase text-slate-400 block tracking-wider">Total Elapsed</span>
                    <span className="text-xs font-black text-slate-800 dark:text-slate-200 font-mono mt-0.5 block">{formatDuration(elapsedMs)}</span>
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-155 dark:border-slate-800/60">
                    <span className="text-[8px] font-black uppercase text-indigo-500 block tracking-wider">Utilisation</span>
                    <span className="text-xs font-black text-indigo-650 dark:text-indigo-400 font-mono mt-0.5 block">{prodPercent}%</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center text-[10px] font-bold text-slate-500">
                    <span>PRODUCTIVE ({prodPercent}%)</span>
                    <span>BREAK ({breakPercent}%)</span>
                  </div>
                  <div className="h-3 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex">
                    <div style={{ width: `${prodPercent}%` }} className="h-full bg-indigo-600 transition-all duration-300" />
                    <div style={{ width: `${breakPercent}%` }} className="h-full bg-amber-500 transition-all duration-300" />
                  </div>
                </div>
              </div>
            )}

            {/* Section 5: Supervisor Shortcuts */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col space-y-4">
              <h4 className="text-xs font-black text-slate-455 dark:text-slate-500 uppercase tracking-widest">
                Quick Workspace Shortcuts
              </h4>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <button 
                  onClick={() => onNavigateSubView?.('tms-monitor')} 
                  className="p-3 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950/40 dark:hover:bg-slate-900 rounded-xl border border-slate-200/60 dark:border-slate-800/60 flex flex-col items-center text-center space-y-2 cursor-pointer transition-all"
                >
                  <Activity size={18} className="text-indigo-500" />
                  <span className="text-[10px] font-black uppercase text-slate-600 dark:text-slate-400 leading-tight">Monitor</span>
                </button>
                
                <button 
                  onClick={() => onNavigateSubView?.('tms-roster')} 
                  className="p-3 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950/40 dark:hover:bg-slate-900 rounded-xl border border-slate-200/60 dark:border-slate-800/60 flex flex-col items-center text-center space-y-2 cursor-pointer transition-all"
                >
                  <Users size={18} className="text-sky-500" />
                  <span className="text-[10px] font-black uppercase text-slate-600 dark:text-slate-400 leading-tight">Roster Audit</span>
                </button>

                <button 
                  onClick={() => onNavigateSubView?.('tms-recovery')} 
                  className="p-3 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950/40 dark:hover:bg-slate-900 rounded-xl border border-slate-200/60 dark:border-slate-800/60 flex flex-col items-center text-center space-y-2 cursor-pointer transition-all"
                >
                  <LifeBuoy size={18} className="text-rose-500" />
                  <span className="text-[10px] font-black uppercase text-slate-600 dark:text-slate-400 leading-tight">Recovery</span>
                </button>

                <button 
                  onClick={() => onNavigateSubView?.('tms-reports')} 
                  className="p-3 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950/40 dark:hover:bg-slate-900 rounded-xl border border-slate-200/60 dark:border-slate-800/60 flex flex-col items-center text-center space-y-2 cursor-pointer transition-all"
                >
                  <Calendar size={18} className="text-teal-500" />
                  <span className="text-[10px] font-black uppercase text-slate-600 dark:text-slate-400 leading-tight">Reports</span>
                </button>

                <button 
                  onClick={() => onNavigateSubView?.('tms-export')} 
                  className="p-3 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950/40 dark:hover:bg-slate-900 rounded-xl border border-slate-200/60 dark:border-slate-800/60 flex flex-col items-center text-center space-y-2 cursor-pointer transition-all"
                >
                  <FileSpreadsheet size={18} className="text-emerald-500" />
                  <span className="text-[10px] font-black uppercase text-slate-600 dark:text-slate-400 leading-tight">Export</span>
                </button>
              </div>
            </div>

          </div>

        </div>

        {/* Section 6: Supervisor Recent Activity */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col space-y-4">
          <h4 className="text-xs font-black text-slate-455 dark:text-slate-500 uppercase tracking-widest">
            Supervisor Recent Activity Feed
          </h4>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/60 max-h-[250px] overflow-y-auto pr-2">
            {supervisorRecentActivity.length > 0 ? (
              supervisorRecentActivity.map((act) => (
                <div key={act.id} className="py-3 flex items-center justify-between text-xs font-semibold">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                      {act.eventType === 'SUPERVISOR_FORCE_LOGOUT' ? <LogOut size={14} /> :
                       act.eventType === 'SHIFT_RECOVERY' ? <LifeBuoy size={14} /> :
                       act.eventType === 'MANUAL_CORRECTION' ? <AlertCircle size={14} /> :
                       act.eventType === 'SHIFT_EXTENSION' ? <Sparkles size={14} /> : <RefreshCw size={14} />}
                    </div>
                    <div>
                      <h5 className="font-bold text-slate-800 dark:text-slate-200 leading-tight">
                        {act.userName}
                      </h5>
                      <p className="text-[10px] text-slate-455 mt-0.5 font-medium">
                        {act.detail}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] text-slate-400 font-mono font-bold block uppercase">
                      {new Date(act.timestamp).toLocaleDateString()} {new Date(act.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="text-[9px] text-indigo-500 font-bold uppercase mt-0.5 block tracking-wide">
                      By: {act.performedBy}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-slate-455 uppercase tracking-widest text-[10px] font-bold">
                No recent supervisor ledger events recorded on your team today.
              </div>
            )}
          </div>
        </div>

      </div>
    );
  };

  const renderWorkforceMonitor = () => {
    return (
      <div className="p-2.5 space-y-2 bg-slate-50 dark:bg-slate-950/30 overflow-hidden h-full flex flex-col">
        {/* Live Data Sync Bar */}
        <div className="bg-white dark:bg-slate-900 px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 shrink-0">
          <div className="flex flex-col">
            <span className="text-[11px] font-black text-slate-800 dark:text-slate-200 uppercase tracking-wider">Live Status Data</span>
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 mt-0.5">
              Last updated: {lastUpdated ? new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Never'}
            </span>
          </div>
          <button
            id="tms-load-live-data-btn"
            onClick={async () => {
              try {
                if (isGlobalActivityMode) {
                  await fetchGlobalLiveSessions();
                }
                await fetchLiveShifts(true);
              } catch (e) {
                console.error('[MANUAL LOAD LIVE DATA FAILED]', e);
              }
            }}
            disabled={loadingLiveShifts || isLoadingGlobalLive}
            className="px-3.5 h-8 bg-indigo-650 hover:bg-indigo-755 disabled:hover:bg-indigo-650 text-white font-black text-[11px] rounded-lg shadow-sm flex items-center justify-center gap-2 cursor-pointer transition-all uppercase tracking-wider disabled:opacity-50"
          >
            <RefreshCw size={13} className={loadingLiveShifts || isLoadingGlobalLive ? 'animate-spin' : ''} />
            {loadingLiveShifts || isLoadingGlobalLive ? 'Loading live data...' : '🔄 Load Live Data'}
          </button>
        </div>

        {/* Top Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 shrink-0">
          <div className="bg-white dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
            <div>
              <span className="text-[9px] font-black uppercase text-emerald-500 tracking-wider">Productive Users</span>
              <div className="text-base font-black text-emerald-600 mt-0.5">{liveStats.active}</div>
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
            <div>
              <span className="text-[9px] font-black uppercase text-amber-500 tracking-wider">On Break</span>
              <div className="text-base font-black text-amber-600 mt-0.5">{liveStats.onBreak}</div>
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
            <div>
              <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Total Assigned</span>
              <div className="text-base font-black text-slate-800 dark:text-slate-100 mt-0.5">{liveStats.total}</div>
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
            <div>
              <span className="text-[9px] font-black uppercase text-sky-500 tracking-wider">Total Logged In</span>
              <div className="text-base font-black text-sky-600 mt-0.5">{liveStats.loggedIn}</div>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col flex-1 overflow-hidden">
          {/* Filters Bar */}
          <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 shrink-0 bg-slate-50/50 dark:bg-slate-950/20">
            <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto">
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-2.5 top-2 text-slate-400" size={13} />
                <input 
                  type="text" 
                  value={searchTerm} 
                  onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                  placeholder="Search name, email, activity..."
                  className="w-full pl-8 pr-3 py-1 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-indigo-500 font-medium text-slate-700 dark:text-slate-200 shadow-sm"
                />
              </div>

              <div className="flex items-center gap-2">
                {/* Status Filter */}
                <select 
                  value={shiftFilter} 
                  onChange={e => { setShiftFilter(e.target.value); setCurrentPage(1); }}
                  className="text-xs font-bold px-2 py-1 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 rounded-lg focus:outline-none shadow-sm cursor-pointer"
                >
                  <option value="all">All Statuses</option>
                  <option value="active">Active</option>
                  <option value="break">Break</option>
                  <option value="offline">Offline</option>
                </select>

                {/* Manager-only "Activity" Filter (Global Organization View) */}
                {isManagerUser && (
                  <div className="relative flex items-center gap-1.5" ref={activityDropdownRef}>
                    <button
                      type="button"
                      id="manager-activity-filter-btn"
                      onClick={() => {
                        setSelectedActivities(appliedActivities);
                        setIsActivityDropdownOpen(!isActivityDropdownOpen);
                      }}
                      className={`text-xs font-bold px-2.5 py-1 border rounded-lg flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer ${
                        appliedActivities.length > 0
                          ? 'bg-indigo-600 border-indigo-600 text-white shadow-indigo-500/20'
                          : selectedActivities.length > 0
                          ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-950/50 dark:border-indigo-800 dark:text-indigo-300'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <Activity size={12} className={appliedActivities.length > 0 ? 'text-white' : selectedActivities.length > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'} />
                      <span>
                        {appliedActivities.length === 0
                          ? 'Activity: Select Activity'
                          : appliedActivities.length === 1
                          ? `Activity: ${appliedActivities[0]}`
                          : `Activity: (${appliedActivities.length} selected)`}
                      </span>
                      {appliedActivities.length > 0 && (
                        <span className="ml-0.5 px-1 py-0.5 rounded bg-indigo-500/40 text-[9px] font-black uppercase tracking-wider">
                          Global
                        </span>
                      )}
                      <ChevronDown size={12} className={`transition-transform ${appliedActivities.length > 0 ? 'text-white/80' : 'text-slate-400'} ${isActivityDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isActivityDropdownOpen && (
                      <div className="absolute left-0 top-full mt-1 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 p-2.5 space-y-2.5 animate-in fade-in zoom-in-95 duration-100">
                        <div className="flex items-center justify-between px-1 pb-1.5 border-b border-slate-100 dark:border-slate-800">
                          <div>
                            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Filter Activity</span>
                            <p className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">Global Organization Override</p>
                          </div>
                          {(selectedActivities.length > 0 || appliedActivities.length > 0) && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedActivities([]);
                                setAppliedActivities([]);
                                setCurrentPage(1);
                                setIsActivityDropdownOpen(false);
                              }}
                              className="text-[10px] font-bold text-red-600 hover:text-red-700 dark:text-red-400 uppercase tracking-wider cursor-pointer"
                            >
                              Clear Filter
                            </button>
                          )}
                        </div>

                        <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200/60 dark:border-amber-900/60 text-[10.5px] text-amber-800 dark:text-amber-300 font-medium leading-relaxed">
                          Select an activity and click <strong className="font-bold">Apply</strong> to enter Global Activity View, overriding hierarchy to display all currently logged-in users on that activity across the entire organization.
                        </div>

                        {managerActivityOptions.length > 5 && (
                          <div className="relative">
                            <Search size={11} className="absolute left-2.5 top-2.5 text-slate-400" />
                            <input
                              type="text"
                              value={activitySearchQuery}
                              onChange={e => setActivitySearchQuery(e.target.value)}
                              placeholder="Search activity name..."
                              className="w-full pl-7 pr-2 py-1.5 text-[11px] bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-indigo-500 text-slate-700 dark:text-slate-200 font-medium"
                            />
                          </div>
                        )}

                        <div className="max-h-48 overflow-y-auto space-y-0.5 custom-scrollbar pr-1">
                          {managerActivityOptions
                            .filter(act => !activitySearchQuery || act.toLowerCase().includes(activitySearchQuery.toLowerCase()))
                            .map(act => {
                              const isChecked = selectedActivities.includes(act);
                              return (
                                <label
                                  key={act}
                                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                                    isChecked
                                      ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 font-bold'
                                      : 'hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => {
                                      setSelectedActivities(prev =>
                                        isChecked ? prev.filter(p => p !== act) : [...prev, act]
                                      );
                                    }}
                                    className="w-3.5 h-3.5 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300 dark:border-slate-600 cursor-pointer"
                                  />
                                  <span className="truncate flex-1">{act}</span>
                                </label>
                              );
                            })}
                          {managerActivityOptions.length === 0 && (
                            <div className="text-center py-3 text-[11px] text-slate-400 font-medium">
                              No activities found
                            </div>
                          )}
                        </div>

                        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedActivities(appliedActivities);
                              setIsActivityDropdownOpen(false);
                            }}
                            className="px-2.5 py-1 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            id="apply-activity-filter-btn"
                            onClick={() => {
                              setAppliedActivities(selectedActivities);
                              setIsActivityDropdownOpen(false);
                              setCurrentPage(1);
                            }}
                            className="px-3 py-1 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-lg shadow-sm cursor-pointer transition-colors flex items-center gap-1"
                          >
                            <Check size={12} />
                            <span>Apply</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {(searchTerm || shiftFilter !== 'all' || appliedActivities.length > 0 || selectedActivities.length > 0) && (
                  <button 
                    onClick={() => { 
                      setSearchTerm(''); 
                      setShiftFilter('all'); 
                      setSelectedActivities([]); 
                      setAppliedActivities([]); 
                      setCurrentPage(1); 
                    }}
                    className="text-[11px] font-black text-indigo-600 hover:text-indigo-700 uppercase tracking-wider px-2 py-1 cursor-pointer"
                  >
                    Clear Filters
                  </button>
                )}
              </div>
            </div>

            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Showing {paginatedWorkforceRows.length} of {sortedWorkforceRows.length} agents
            </div>
          </div>

          {/* Global Activity View Banner */}
          {isGlobalActivityMode && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 bg-gradient-to-r from-indigo-500/10 via-purple-500/10 to-blue-500/10 border-b border-indigo-200 dark:border-indigo-800/60 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-indigo-600 text-white shadow-sm flex items-center justify-center">
                  <Globe size={15} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-black uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                      Mode: Global Activity View
                    </span>
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                      Hierarchy filter: OVERRIDDEN
                    </span>
                  </div>
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mt-0.5">
                    Showing all currently logged-in <span className="font-bold text-indigo-600 dark:text-indigo-400">{appliedActivities.join(', ')}</span> users across the organization ({sortedWorkforceRows.length} active)
                  </p>
                </div>
              </div>
              <button
                type="button"
                id="clear-global-activity-btn"
                onClick={() => {
                  setSelectedActivities([]);
                  setAppliedActivities([]);
                  setCurrentPage(1);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-indigo-700 dark:text-indigo-300 bg-white dark:bg-slate-900 hover:bg-indigo-50 dark:hover:bg-slate-800 border border-indigo-200 dark:border-indigo-700 rounded-lg shadow-sm transition-all cursor-pointer"
              >
                <X size={13} />
                <span>Exit Global View (Restore Hierarchy)</span>
              </button>
            </div>
          )}

          {/* Table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 font-black uppercase tracking-wider text-[10px] sticky top-0 bg-slate-50 dark:bg-slate-900 z-10">
                  <th className="py-1 px-2.5 pl-3">Employee Name</th>
                  <th className="py-1 px-2.5">Process</th>
                  <th className="py-1 px-2.5">Status</th>
                  <th className="py-1 px-2.5">Activity</th>
                  <th className="py-1 px-2.5">Clock-In Time</th>
                  <th className="py-1 px-2.5">Productive Time</th>
                  <th className="py-1 px-2.5">Break Time</th>
                  <th className="py-1 px-2.5">Device</th>
                  <th className="py-1 px-2.5 text-right pr-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/40 font-semibold text-slate-700 dark:text-slate-300">
                {paginatedWorkforceRows.map(row => {
                  const isOffline = row.status === 'OFFLINE';
                  let statusChipColor = 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300';
                  if (row.status === 'ACTIVE' || row.status === 'PRODUCTIVE') {
                    statusChipColor = 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400';
                  } else if (row.status === 'BREAK') {
                    statusChipColor = 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400';
                  }

                  return (
                    <tr key={row.userId} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors group">
                      <td className="py-1 px-2.5 pl-3">
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center font-black text-indigo-600 dark:text-indigo-400 uppercase text-[9px] shrink-0">
                            {row.userName.split(' ').map(n => n[0]).slice(0, 2).join('')}
                          </div>
                          <div className="flex flex-col">
                            <span className="font-extrabold text-slate-900 dark:text-white leading-tight text-[11px]">{row.userName}</span>
                            <span className="text-[9px] text-slate-400 leading-none">{row.userEmail}</span>
                          </div>
                        </div>
                      </td>
                      <td className="py-1 px-2.5">
                        <span className="bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider border border-indigo-100 dark:border-indigo-900/40">
                          {row.currentProcess || 'General'}
                        </span>
                      </td>
                      <td className="py-1 px-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider border ${statusChipColor}`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="py-1 px-2.5 font-bold text-slate-600 dark:text-slate-300 text-[11px]">
                        {(() => {
                          const act = (row.currentActivity || '').trim();
                          const actLower = act.toLowerCase();
                          if (!act || actLower === 'office' || actLower === 'home' || actLower === 'wfh' || actLower === 'n/a') {
                            if (row.status === 'OFFLINE') return 'Offline';
                            if (row.status === 'BREAK') return 'Break';
                            if (row.status === 'MEETING') return 'Meeting';
                            if (row.status === 'TRAINING') return 'Training';
                            if (row.status === 'ACTIVE' || row.status === 'PRODUCTIVE') return 'Productive';
                            return row.status || 'Offline';
                          }
                          return act;
                        })()}
                      </td>
                      <td className="py-1 px-2.5 font-mono text-[10px] font-bold text-slate-600 dark:text-slate-300">
                        {row.clockInTime ? new Date(row.clockInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : (row.rawDoc?.clockInTime ? new Date(row.rawDoc.clockInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : (row.since && row.since !== '-' ? row.since : '-'))}
                      </td>
                      <td className="py-1 px-2.5 font-mono text-[10px] font-black text-emerald-600 dark:text-emerald-400">
                        {(row.clockInTime || row.hasActiveLiveSession || row.status !== 'OFFLINE' || (row.currentShiftProductiveMs && row.currentShiftProductiveMs > 0)) ? formatDuration(row.currentShiftProductiveMs || 0) : '-'}
                      </td>
                      <td className="py-1 px-2.5 font-mono text-[10px] font-bold text-amber-600">
                        {(row.clockInTime || row.hasActiveLiveSession || row.status !== 'OFFLINE' || (row.totalBreakMs && row.totalBreakMs > 0)) ? formatDuration(row.totalBreakMs || 0) : '00h 00m 00s'}
                      </td>
                      <td className="py-1 px-2.5">
                        <span className="text-slate-500 font-bold text-[11px]" title="Web / Desktop App">💻</span>
                      </td>
                      <td className="py-1 px-2.5 text-right pr-3 flex items-center justify-end gap-1.5">
                        {(!isOffline || row.isStuckSession) && canModifyTarget(row.userId) && (
                          <div className="relative inline-block text-left">
                            <button
                              onClick={() => {
                                setActivityChangeTargetUid(row.userId);
                                setActivityChangeTargetName(row.userName);
                                setActivityChangeSelectedValue(row.currentActivity || 'HITL');
                              }}
                              className="px-1.5 py-0.5 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-400 font-black text-[9px] rounded-lg uppercase tracking-wider transition-colors cursor-pointer inline-flex items-center gap-1 shadow-sm shrink-0"
                              title="Change employee's active process or break activity"
                            >
                              <Activity size={10} />
                              Change Activity
                            </button>
                            
                            {activityChangeTargetUid === row.userId && (
                              <div className="absolute right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-50 p-2.5 space-y-2 min-w-[240px] text-left">
                                <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-slate-800">
                                  <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Change Activity:</span>
                                  <button onClick={() => setActivityChangeTargetUid(null)} className="text-slate-450 hover:text-slate-650 dark:hover:text-white">
                                    <X size={11} />
                                  </button>
                                </div>
                                <div className="space-y-1">
                                  <span className="text-[8px] font-bold uppercase tracking-wider text-slate-400">Select Activity:</span>
                                  <select 
                                    value={activityChangeSelectedValue} 
                                    onChange={e => setActivityChangeSelectedValue(e.target.value)}
                                    className="w-full text-[10px] font-bold p-1 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-700 rounded text-slate-705 dark:text-slate-300"
                                  >
                                    <optgroup label="Operational Processes (Status: ACTIVE)">
                                      {supervisorProcesses?.map(pr => <option key={pr} value={pr}>{pr}</option>)}
                                    </optgroup>
                                    <optgroup label="Break/Off-Prod (Status: BREAK)">
                                      {SUPERVISOR_BREAK_OPTIONS?.map(br => <option key={br} value={br}>{br}</option>)}
                                    </optgroup>
                                  </select>
                                </div>
                                <div className="flex gap-1.5 pt-1">
                                  <button 
                                    onClick={async () => {
                                      const isBreak = SUPERVISOR_BREAK_OPTIONS.includes(activityChangeSelectedValue);
                                      await performRemoteActivityChange(row.userId, row.userName, activityChangeSelectedValue, isBreak);
                                      setActivityChangeTargetUid(null);
                                    }}
                                    className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[9px] py-1 rounded uppercase tracking-wider text-center cursor-pointer"
                                  >
                                    Confirm Change
                                  </button>
                                  <button 
                                    onClick={() => setActivityChangeTargetUid(null)}
                                    className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-[9px] px-2 py-1 rounded uppercase tracking-wider cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {(!isOffline || row.isStuckSession) && canModifyTarget(row.userId) && (
                          <button
                            onClick={() => {
                              setLogoutShiftId(row.sessionId);
                              setLogoutTargetUid(row.userId);
                              setLogoutTargetName(row.userName);
                              setLogoutReason('Operational force clock-out');
                              setShowForceLogoutConfirm(true);
                            }}
                            className="px-1.5 py-0.5 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-400 font-black text-[9px] rounded-lg uppercase tracking-wider transition-colors cursor-pointer inline-flex items-center gap-1 shadow-sm shrink-0"
                          >
                            <LogOut size={10} />
                            Force Out
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {paginatedWorkforceRows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-slate-400 font-bold uppercase tracking-widest text-xs">
                      {isGlobalActivityMode 
                        ? `No currently active users found matching "${appliedActivities.join(', ')}" across the organization.`
                        : 'No workforce members found matching the selected filters.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          {totalPages > 1 && (
            <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20 flex items-center justify-between text-xs shrink-0">
              <span className="text-slate-500 font-bold uppercase tracking-wider text-[10px]">Page {currentPage} of {totalPages}</span>
              <div className="flex gap-2">
                <button 
                  disabled={currentPage === 1} 
                  onClick={() => setCurrentPage(p => p - 1)} 
                  className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 text-slate-700 dark:text-slate-300 font-bold rounded-lg disabled:opacity-50 cursor-pointer shadow-sm transition-colors text-[11px]"
                >
                  Prev
                </button>
                <button 
                  disabled={currentPage === totalPages} 
                  onClick={() => setCurrentPage(p => p + 1)} 
                  className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 text-slate-700 dark:text-slate-300 font-bold rounded-lg disabled:opacity-50 cursor-pointer shadow-sm transition-colors text-[11px]"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderRosterSessionAudit = () => {
    return (
      <div className="flex-grow flex overflow-hidden h-full">
        {/* Main Content Area (Filters + Table) */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative bg-white dark:bg-slate-900 h-full">
          
          {/* Admin / Supervisor Sub-Tabs */}
          <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/10 px-4 shrink-0">
            <button
              onClick={() => {
                setTmsAdminTab('roster');
                setCurrentPage(1);
              }}
              className={`py-3 px-4 text-xs font-bold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 cursor-pointer ${
                tmsAdminTab === 'roster'
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400 font-extrabold'
                  : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <Users size={14} />
              Roster Session Audit
            </button>
            <button
              onClick={() => {
                setTmsAdminTab('exceeded_12h');
                setCurrentPage(1);
              }}
              className={`py-3 px-4 text-xs font-bold uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 relative cursor-pointer ${
                tmsAdminTab === 'exceeded_12h'
                  ? 'border-red-500 text-red-600 dark:text-red-400 font-extrabold'
                  : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <AlertTriangle size={14} className={tmsAdminTab === 'exceeded_12h' ? 'text-red-500 dark:text-red-400' : 'text-slate-400 dark:text-slate-500'} />
              Exceeded 12 Hours Productive
              {exceededCount > 0 && (
                <span className="bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400 text-[9px] font-black px-1.5 py-0.5 rounded-full leading-none">
                  {exceededCount}
                </span>
              )}
            </button>
          </div>

          {/* 2. Filters Row */}
          <div className="p-3 bg-slate-50 dark:bg-slate-950/30 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 shrink-0">
             <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
               <div className="relative w-full sm:w-64 shrink-0">
                  <Search className="absolute left-3 top-2.5 text-slate-400" size={14} />
                  <input 
                    type="text" value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                    placeholder="Search Employee or Activity..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-indigo-500 font-medium text-slate-700 dark:text-slate-200 transition-shadow shadow-sm"
                  />
               </div>
               
               <div className="flex items-center gap-2 text-xs">
                  <div className="relative" ref={statusDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setIsStatusDropdownOpen(!isStatusDropdownOpen)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-bold text-slate-600 dark:text-slate-300 min-w-[140px] justify-between cursor-pointer shadow-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <span className="truncate">{shiftFilter === 'all' ? 'All Statuses' : shiftFilter.replace('_', ' ').toUpperCase()}</span>
                      <ChevronDown size={14} className="text-slate-400" />
                    </button>
                    {isStatusDropdownOpen && (
                      <div className="absolute left-0 mt-1.5 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-50 py-1.5 font-bold">
                        {['all', 'active', 'break', 'completed', 'offline'].map(st => (
                          <button
                            key={st}
                            onClick={() => {
                              setShiftFilter(st);
                              setIsStatusDropdownOpen(false);
                              setCurrentPage(1);
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/65 ${shiftFilter === st ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-355'}`}
                          >
                            {st === 'all' ? 'All Statuses' : st.replace('_', ' ').toUpperCase()}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="relative" ref={processDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setIsProcessDropdownOpen(!isProcessDropdownOpen)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-bold text-slate-600 dark:text-slate-300 min-w-[140px] justify-between cursor-pointer shadow-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <span className="truncate">{processFilter === 'all' ? 'All Processes' : processFilter}</span>
                      <ChevronDown size={14} className="text-slate-400" />
                    </button>
                    {isProcessDropdownOpen && (
                      <div className="absolute left-0 mt-1.5 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-50 py-1.5 font-bold max-h-60 overflow-y-auto">
                        <button
                          onClick={() => {
                            setProcessFilter('all');
                            setIsProcessDropdownOpen(false);
                            setCurrentPage(1);
                          }}
                          className={`w-full text-left px-3.5 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/65 ${processFilter === 'all' ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-355'}`}
                        >
                          All Processes
                        </button>
                        {processes?.map(pr => (
                          <button
                            key={pr}
                            onClick={() => {
                              setProcessFilter(pr);
                              setIsProcessDropdownOpen(false);
                              setCurrentPage(1);
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/65 ${processFilter === pr ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-355'}`}
                          >
                            {pr}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
               </div>
             </div>

             <div className="flex items-center gap-3">
               <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Sort Order</span>
               <select 
                 value={sortBy} onChange={e => setSortBy(e.target.value)}
                 className="text-xs font-bold p-1.5 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-355 rounded-lg focus:outline-none shadow-sm"
               >
                 <option value="name_asc">Name (A-Z)</option>
                 <option value="name_desc">Name (Z-A)</option>
                 <option value="login_newest">Newest Clock In</option>
                 <option value="login_oldest">Oldest Clock In</option>
                 <option value="duration_longest">Longest Shift</option>
               </select>
             </div>
          </div>

          {/* 3. Table */}
          <div className="flex-1 overflow-auto">
             <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-150 dark:border-slate-800/80 text-slate-400 font-black uppercase tracking-wider text-[10px] sticky top-0 bg-slate-50 dark:bg-slate-900/90 z-20 backdrop-blur">
                    <th className="py-1.5 px-3 pl-4">Employee</th>
                    <th className="py-1.5 px-3">Status</th>
                    <th className="py-1.5 px-3">Location</th>
                    <th className="py-1.5 px-3">Process Mapping</th>
                    <th className="py-1.5 px-3">Clock In</th>
                    <th className="py-1.5 px-3">Clock Out</th>
                    <th className="py-1.5 px-3">Duration</th>
                    <th className="py-1.5 px-3">Break Logs</th>
                    <th className="py-1.5 px-3 text-center">In Sync</th>
                    <th className="py-1.5 px-3 text-right pr-4">Supervisor Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/40 font-semibold text-slate-700 dark:text-slate-355">
                    {paginatedWorkforceRows.map(row => {
                       const live = row.status !== 'OFFLINE';
                       const isOffline = row.status === 'OFFLINE';
                       let statusChipColor = 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-950/20 dark:border-slate-800/40';
                       
                       if (row.status === 'ACTIVE') {
                         statusChipColor = 'bg-emerald-50 text-emerald-700 border-emerald-100/50 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-900/30';
                       } else if (row.status === 'BREAK') {
                         statusChipColor = 'bg-amber-50 text-amber-700 border-amber-100/50 dark:bg-amber-950/20 dark:text-amber-400 dark:border-amber-900/30';
                       }

                       return (
                         <tr key={row.userId} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors group">
                            <td className="p-3.5 pl-6">
                              <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center font-black text-slate-600 dark:text-slate-355 uppercase text-[10px] select-none">
                                  {row.userName.split(' ').map(n => n[0]).slice(0, 2).join('')}
                                </div>
                                <div className="flex flex-col">
                                  <span className="font-extrabold text-slate-900 dark:text-white leading-tight">{row.userName}</span>
                                  <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 leading-none">{row.userEmail}</span>
                                </div>
                              </div>
                            </td>
                            <td className="p-3.5">
                              <span className={`px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-wider border ${statusChipColor}`}>
                                {row.status}
                              </span>
                            </td>
                            <td className="p-3.5">
                              <span className="text-slate-650 dark:text-slate-355 text-[11px] font-bold">
                                {row.workLocation === 'Office' ? '🏢 Office' : '🏠 Home'}
                              </span>
                            </td>
                            <td className="p-3.5">
                              <div className="flex items-center gap-1.5">
                                <span className="bg-indigo-50/60 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-400 px-2 py-0.5 rounded text-[10px] font-extrabold border border-indigo-100/20 uppercase tracking-wider">
                                  {row.currentProcess}
                                </span>
                                {row.status === 'ACTIVE' && canModifyTarget(row.userId) && (
                                  <div className="relative">
                                    <button 
                                      onClick={() => {
                                        setRemoteSwitchTargetUid(row.userId);
                                        setRemoteSwitchTargetName(row.userName);
                                        setRemoteSwitchSelectedProcess(row.currentProcess || '');
                                      }}
                                      className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-indigo-500 rounded transition-colors cursor-pointer"
                                      title="Remote Switch Process"
                                    >
                                      <RefreshCw size={12} />
                                    </button>
                                    
                                    {remoteSwitchTargetUid === row.userId && (
                                      <div className="absolute left-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-50 p-2 space-y-2 min-w-[200px]">
                                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block pb-1 border-b border-slate-100">Switch to:</span>
                                        <select 
                                          value={remoteSwitchSelectedProcess} 
                                          onChange={e => setRemoteSwitchSelectedProcess(e.target.value)}
                                          className="w-full text-[10px] font-bold p-1 bg-slate-50 border border-slate-200 rounded"
                                        >
                                          {processes?.map(pr => <option key={pr} value={pr}>{pr}</option>)}
                                        </select>
                                        <div className="flex gap-1">
                                          <button 
                                            onClick={async () => {
                                              await performRemoteProcessSwitch();
                                              setRemoteSwitchTargetUid(null);
                                            }}
                                            className="bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[9px] px-2 py-1 rounded uppercase tracking-wider"
                                          >
                                            Confirm
                                          </button>
                                          <button 
                                            onClick={() => setRemoteSwitchTargetUid(null)}
                                            className="bg-slate-100 text-slate-600 text-[9px] px-2 py-1 rounded uppercase tracking-wider"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="p-3.5 font-mono text-[11px] font-bold">
                              {row.clockInTime ? new Date(row.clockInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : (row.rawDoc?.clockInTime ? new Date(row.rawDoc.clockInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-')}
                            </td>
                            <td className="p-3.5 font-mono text-[11px] font-bold">
                              {row.clockOutTime ? new Date(row.clockOutTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}
                            </td>
                            <td className="p-3.5 font-mono text-[11px] font-black text-indigo-600 dark:text-indigo-400">
                              {(row.clockInTime || row.hasActiveLiveSession || row.status !== 'OFFLINE' || (row.currentShiftProductiveMs && row.currentShiftProductiveMs > 0)) ? formatDuration(row.currentShiftProductiveMs || 0) : '-'}
                            </td>
                            <td className="p-3.5">
                              {(row.breakCount > 0 || (row.totalBreakMs && row.totalBreakMs > 0)) ? (
                                <span className="bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded text-[10px] font-black">
                                  {row.breakCount > 0 ? `${row.breakCount} ` : ''}({formatDuration(row.totalBreakMs || 0)})
                                </span>
                              ) : '-'}
                            </td>
                            <td className="p-3.5 text-center">
                              {!isOffline ? (
                                <div className="flex items-center justify-center gap-1 text-slate-500">
                                  {row.deviceType === 'mobile' ? <Smartphone size={14} className="text-rose-500" /> : <Laptop size={14} className="text-indigo-500" />}
                                </div>
                              ) : '-'}
                            </td>
                            <td className="p-3.5 text-right pr-6 opacity-50 group-hover:opacity-100 transition-opacity flex items-center justify-end gap-1.5">
                              {(!isOffline || row.isStuckSession) && live && canModifyTarget(row.userId) && (
                                <div className="relative inline-block text-left">
                                  <button
                                    onClick={() => {
                                      setActivityChangeTargetUid(row.userId);
                                      setActivityChangeTargetName(row.userName);
                                      setActivityChangeSelectedValue(row.currentActivity || 'HITL');
                                    }}
                                    className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-slate-800/40 rounded-lg transition-colors cursor-pointer inline-flex items-center gap-1.5 shrink-0"
                                    title="Change employee's active process or break activity"
                                  >
                                    <Activity size={16} />
                                  </button>
                                  
                                  {activityChangeTargetUid === row.userId && (
                                    <div className="absolute right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-50 p-2.5 space-y-2 min-w-[240px] text-left">
                                      <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-slate-800">
                                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Change Activity:</span>
                                        <button onClick={() => setActivityChangeTargetUid(null)} className="text-slate-450 hover:text-slate-650 dark:hover:text-white">
                                          <X size={11} />
                                        </button>
                                      </div>
                                      <div className="space-y-1">
                                        <span className="text-[8px] font-bold uppercase tracking-wider text-slate-400">Select Activity:</span>
                                        <select 
                                          value={activityChangeSelectedValue} 
                                          onChange={e => setActivityChangeSelectedValue(e.target.value)}
                                          className="w-full text-[10px] font-bold p-1 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-700 rounded text-slate-705 dark:text-slate-300"
                                        >
                                          <optgroup label="Operational Processes (Status: ACTIVE)">
                                            {supervisorProcesses?.map(pr => <option key={pr} value={pr}>{pr}</option>)}
                                          </optgroup>
                                          <optgroup label="Break/Off-Prod (Status: BREAK)">
                                            {SUPERVISOR_BREAK_OPTIONS?.map(br => <option key={br} value={br}>{br}</option>)}
                                          </optgroup>
                                        </select>
                                      </div>
                                      <div className="flex gap-1.5 pt-1">
                                        <button 
                                          onClick={async () => {
                                            const isBreak = SUPERVISOR_BREAK_OPTIONS.includes(activityChangeSelectedValue);
                                            await performRemoteActivityChange(row.userId, row.userName, activityChangeSelectedValue, isBreak);
                                            setActivityChangeTargetUid(null);
                                          }}
                                          className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[9px] py-1 rounded uppercase tracking-wider text-center cursor-pointer"
                                        >
                                          Confirm Change
                                        </button>
                                        <button 
                                          onClick={() => setActivityChangeTargetUid(null)}
                                          className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-[9px] px-2 py-1 rounded uppercase tracking-wider cursor-pointer"
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                              {(!isOffline || row.isStuckSession) && live && canModifyTarget(row.userId) && (
                                <button 
                                  className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/40 rounded-lg transition-colors cursor-pointer" 
                                  title="Force Logout"
                                  onClick={() => {
                                   setLogoutShiftId(row.sessionId);
                                   setLogoutTargetUid(row.userId);
                                   setLogoutTargetName(row.userName);
                                   setLogoutReason('Left without logging out');
                                   setShowForceLogoutConfirm(true);
                                  }}
                                >
                                  <LogOut size={16} />
                                </button>
                              )}
                            </td>
                         </tr>
                       )
                    })}
                    {paginatedWorkforceRows.length === 0 && (
                      <tr>
                        <td colSpan={10} className="p-8 text-center text-slate-400 font-bold uppercase tracking-widest text-xs">No workforce members found matching the criteria.</td>
                      </tr>
                    )}
                 </tbody>
              </table>
              
              {/* Pagination */}
              {totalPages > 1 && (
                <div className="sticky bottom-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-t border-slate-200 dark:border-slate-800 p-4 flex justify-between items-center text-xs">
                  <span className="text-slate-500 font-bold uppercase tracking-wider text-[10px]">Page {currentPage} of {totalPages}</span>
                  <div className="flex gap-2">
                    <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)} className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-lg disabled:opacity-50 cursor-pointer transition-colors">Prev</button>
                    <button disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)} className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-lg disabled:opacity-50 cursor-pointer transition-colors">Next</button>
                  </div>
                </div>
              )}
          </div>
        </div>

        {/* Column 2: Side Panel Alerts Feed */}
        <div className="w-80 border-l border-slate-200 dark:border-slate-800 flex flex-col bg-slate-50/50 dark:bg-slate-950/20 shrink-0">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-white dark:bg-slate-900 shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <h3 className="text-[11px] font-black text-slate-900 dark:text-white uppercase tracking-wider">Workforce Alerts Feed</h3>
            </div>
            <span className="bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400 text-[10px] font-black px-2 py-0.5 rounded-full leading-none">
              {alerts.length} Active
            </span>
          </div>

          <div className="flex-grow overflow-y-auto p-4 space-y-3">
            {alerts.map(alert => renderAlertItem(alert))}
            {alerts.length === 0 && (
              <div className="py-8 text-center text-slate-455 uppercase tracking-widest text-[10px] font-bold">
                No active operational warnings or violations recorded.
              </div>
            )}
          </div>
        </div>

      </div>
    );
  };

  const renderShiftRecovery = () => {
    // Find sessions running past 12 hours or having issues
    const stuckSessions = activeShifts.filter(sh => {
      if (sh.status === 'COMPLETED' || sh.status === 'CLOSED') return false;
      const elapsedHours = (getLiveTime().getTime() - new Date(sh.clockInTime).getTime()) / (3600 * 1000);
      return elapsedHours >= 12; // 12+ hours or older
    });

    return (
      <div className="p-6 space-y-6 bg-slate-50 dark:bg-slate-950/30 overflow-y-auto h-full">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col space-y-4">
          <div className="flex justify-between items-center border-b border-slate-100 dark:border-slate-800 pb-4">
            <div>
              <h4 className="text-sm font-black text-slate-800 dark:text-slate-100 uppercase tracking-tight">Active Shift Recovery Board</h4>
              <p className="text-[10px] text-slate-400 font-bold mt-0.5 uppercase">Force Clock-Out and Recover Stale Sessions exceeding 12 hours</p>
            </div>
            <span className="bg-rose-100 text-rose-700 text-[10px] font-black px-2.5 py-0.5 rounded-full uppercase">
              {stuckSessions.length} Stuck Sessions
            </span>
          </div>

          <div className="min-w-full overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-150 dark:border-slate-800/80 text-slate-400 font-black uppercase tracking-wider text-[10px]">
                  <th className="p-3.5 pl-6">Employee</th>
                  <th className="p-3.5">Active Process</th>
                  <th className="p-3.5">Clock In Time</th>
                  <th className="p-3.5">Elapsed Time</th>
                  <th className="p-3.5 text-right pr-6">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/40 font-semibold text-slate-700 dark:text-slate-355">
                {stuckSessions.map((sh: any) => {
                  const elapsedMs = getLiveTime().getTime() - new Date(sh.clockInTime).getTime();
                  return (
                    <tr key={sh.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                      <td className="p-3.5 pl-6 font-bold text-slate-900 dark:text-white">{sh.userName}</td>
                      <td className="p-3.5 uppercase tracking-wide text-[10px]">{sh.currentProcess || 'N/A'}</td>
                      <td className="p-3.5">{new Date(sh.clockInTime).toLocaleString()}</td>
                      <td className="p-3.5 font-mono text-rose-600 font-bold">{formatDuration(elapsedMs)}</td>
                      <td className="p-3.5 text-right pr-6">
                        <button 
                          onClick={() => {
                            setLogoutShiftId(sh.id);
                            setLogoutTargetUid(sh.userId);
                            setLogoutTargetName(sh.userName);
                            setLogoutReason('Shift exceed 12-hour policy (Auto Recovery)');
                            setShowForceLogoutConfirm(true);
                          }}
                          className="px-3 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:hover:bg-rose-900/40 text-[10px] font-black uppercase rounded border border-rose-200/40 cursor-pointer transition-colors"
                        >
                          Force Out
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {stuckSessions.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-455 uppercase tracking-widest text-[10px] font-bold">
                      No active employee sessions currently exceed the 12-hour operational window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  const renderHistoricalReports = () => {
    return (
      <div className="p-6 space-y-6 bg-slate-50 dark:bg-slate-950/30 overflow-y-auto h-full flex flex-col">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col space-y-4 flex-grow overflow-hidden">
          <div className="flex justify-between items-center border-b border-slate-100 dark:border-slate-800 pb-4">
            <div>
              <h4 className="text-sm font-black text-slate-800 dark:text-slate-100 uppercase tracking-tight">Completed Sessions Registry</h4>
              <p className="text-[10px] text-slate-400 font-bold mt-0.5 uppercase">Browse historical employee attendance logs</p>
            </div>
            <button 
              onClick={() => typeof refreshHistoricalShifts === 'function' && refreshHistoricalShifts()}
              className="p-2 text-slate-400 hover:text-indigo-500 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer transition-colors"
            >
              <RefreshCw size={14} className={loadingHistorical ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="flex-grow overflow-y-auto">
            <div className="min-w-full overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-150 dark:border-slate-800/80 text-slate-400 font-black uppercase tracking-wider text-[10px]">
                    <th className="p-3.5 pl-6">Employee</th>
                    <th className="p-3.5">Clock In</th>
                    <th className="p-3.5">Clock Out</th>
                    <th className="p-3.5">Total Productive</th>
                    <th className="p-3.5">Total Break</th>
                    <th className="p-3.5">Closed By</th>
                    <th className="p-3.5 text-right pr-6">Ledger Events</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/40 font-semibold text-slate-700 dark:text-slate-355">
                  {paginatedShifts?.map((sh: any) => {
                    const now = getLiveTime().getTime();
                    const { productiveMs, breakMs: totalBreakMs } = calculateShiftMetrics(sh, now);
                    const durationStr = formatDuration(productiveMs);

                    return (
                      <tr key={sh.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors group">
                        <td className="p-3.5 pl-6 font-bold text-slate-900 dark:text-white">{sh.userName}</td>
                        <td className="p-3.5">{new Date(sh.clockInTime).toLocaleString()}</td>
                        <td className="p-3.5">{sh.clockOutTime ? new Date(sh.clockOutTime).toLocaleString() : 'N/A'}</td>
                        <td className="p-3.5 font-mono text-emerald-600 dark:text-emerald-400 font-bold">{durationStr}</td>
                        <td className="p-3.5 font-mono text-amber-600 dark:text-amber-400 font-bold">{formatDuration(totalBreakMs)}</td>
                        <td className="p-3.5 uppercase tracking-wide text-[10px]">{sh.sessionClosedBy || 'System/Agent'}</td>
                        <td className="p-3.5 text-right pr-6">
                          <span className="bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 text-[10px] font-black px-2 py-0.5 rounded-full border border-indigo-100/10">
                            {sh.shiftEventLedger?.length || 0} Events
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {paginatedShifts?.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-slate-455 uppercase tracking-widest text-[10px] font-bold">
                        No completed shifts found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          
          {hasMore && (
            <div className="pt-4 border-t border-slate-100 dark:border-slate-800/60 flex justify-center">
              <button 
                onClick={() => typeof fetchNextPage === 'function' && fetchNextPage()}
                className="px-6 py-2 bg-indigo-650 hover:bg-indigo-755 text-white font-black text-xs rounded-xl shadow-md cursor-pointer transition-colors"
              >
                {loadingHistorical ? 'Loading...' : 'Load More Shifts'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderExportCenter = () => {
    return (
      <div className="p-6 space-y-6 bg-slate-50 dark:bg-slate-950/30 overflow-y-auto h-full">
        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm max-w-2xl mx-auto flex flex-col space-y-5">
          <div className="flex items-center gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
            <div className="w-12 h-12 rounded-full bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 flex items-center justify-center shrink-0">
              <FileSpreadsheet size={24} />
            </div>
            <div>
              <h4 className="font-black text-slate-900 dark:text-white text-base uppercase tracking-tight">Workforce Data Export Hub</h4>
              <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 uppercase">Generate and download standard spreadsheets of employee shifts and activities</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest block">Date Range Preset</label>
              <select 
                value={exportRangePreset} 
                onChange={e => setExportRangePreset(e.target.value)} 
                className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500"
              >
                <option value="1">Today</option>
                <option value="2">Yesterday (Last 2 days)</option>
                <option value="7">Last 7 Days</option>
                <option value="15">Last 15 Days</option>
                <option value="30">Last 30 Days</option>
              </select>
            </div>

            <div className="bg-slate-50 dark:bg-slate-950/40 p-4 rounded-xl border border-slate-155 dark:border-slate-800/60 text-xs font-semibold space-y-2">
              <span className="text-[9px] font-black uppercase text-slate-400 tracking-widest block">Report Inclusions</span>
              <div className="flex flex-col gap-1.5 text-slate-700 dark:text-slate-350">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-indigo-500" />
                  <span>Immutable Shift Events (Sequence logs, IP addresses, Override metrics)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-indigo-500" />
                  <span>Cumulative break logs and duration audits</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-indigo-500" />
                  <span>Excel Sheet compatible format</span>
                </div>
              </div>
            </div>

            <button 
              onClick={handleSpreadsheetExport} 
              disabled={isExporting}
              className="w-full bg-indigo-650 hover:bg-indigo-755 text-white font-black text-xs h-12 rounded-xl shadow-lg shadow-indigo-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider disabled:opacity-50"
            >
              {isExporting ? <RefreshCw size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
              {isExporting ? 'Generating Report...' : 'Download Utilization Spreadsheet'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 dark:bg-slate-950/50 overflow-hidden relative">
      {/* Dynamic Sub-View Routing */}
      {currentSubView === 'tms-supervisor' && renderSupervisorPunchStation()}
      {currentSubView === 'tms-monitor' && renderWorkforceMonitor()}
      {currentSubView === 'tms-roster' && renderRosterSessionAudit()}
      {currentSubView === 'tms-recovery' && renderShiftRecovery()}
      {currentSubView === 'tms-reports' && renderHistoricalReports()}
      {currentSubView === 'tms-export' && renderExportCenter()}
      
      {/* Default Fallback for backward compatibility */}
      {!currentSubView && renderSupervisorPunchStation()}

      {/* Force Logout Confirm Modal */}
      {showForceLogoutConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-rose-600 border-b border-slate-100 dark:border-slate-800 pb-4">
                <div className="w-12 h-12 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center shrink-0">
                  <AlertCircle size={24} />
                </div>
                <div>
                  <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">Confirm Force Logout</h4>
                  <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 leading-tight">Terminate session for {logoutTargetName}</p>
                </div>
             </div>
             
             <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Reason</label>
                <input type="text" value={logoutReason} onChange={e => setLogoutReason(e.target.value)} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500" />
             </div>
             
             <div className="flex flex-col gap-2 pt-2">
                <button onClick={executeSupervisorClockOut} className="w-full bg-rose-600 hover:bg-rose-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-rose-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider">
                  Confirm Logout
                </button>
                <button onClick={() => setShowForceLogoutConfirm(false)} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                  Cancel
                </button>
             </div>
          </div>
        </div>
      )}

      {/* Export Options Modal */}
      {showEnhancedExportModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-indigo-600 border-b border-slate-100 dark:border-slate-800 pb-4">
                <div className="w-12 h-12 rounded-full bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center shrink-0">
                  <FileSpreadsheet size={24} />
                </div>
                <div>
                  <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">Export Utilization</h4>
                  <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 leading-tight">Download shift and activity reports</p>
                </div>
             </div>
             <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Date Range</label>
                  <select value={exportRangePreset} onChange={e => setExportRangePreset(e.target.value)} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500">
                    <option value="1">Today</option>
                    <option value="2">Yesterday (Last 2 days)</option>
                    <option value="7">Last 7 Days</option>
                    <option value="15">Last 15 Days</option>
                    <option value="30">Last 30 Days</option>
                    <option value="custom">Custom Range</option>
                  </select>
                </div>
                
                {exportRangePreset === 'custom' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Start Date</label>
                      <input type="date" value={exportStartDate || exportCustomStart} onChange={e => { setExportStartDate(e.target.value); setExportCustomStart(e.target.value); }} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">End Date</label>
                      <input type="date" value={exportEndDate || exportCustomEnd} onChange={e => { setExportEndDate(e.target.value); setExportCustomEnd(e.target.value); }} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500" />
                    </div>
                  </div>
                )}
             </div>
             <div className="flex flex-col gap-2 pt-2">
                {isExporting && (
                  <div className="w-full space-y-2 py-1 mb-2">
                    <div className="flex justify-between text-xs font-bold text-slate-700 dark:text-slate-300">
                      <span>{exportProgressMessage || 'Generating report...'}</span>
                      <span>{exportProgressPercent}%</span>
                    </div>
                    <div className="w-full bg-slate-100 dark:bg-slate-800 h-2.5 rounded-full overflow-hidden">
                      <div 
                        className="bg-indigo-600 dark:bg-indigo-500 h-full rounded-full transition-all duration-300 ease-out" 
                        style={{ width: `${exportProgressPercent}%` }}
                      />
                    </div>
                  </div>
                )}
                <button onClick={executeEnhancedExport} disabled={isExporting} className="w-full bg-indigo-650 hover:bg-indigo-755 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-indigo-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider disabled:opacity-50">
                  {isExporting ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
                  {isExporting ? 'Exporting...' : 'Export Spreadsheet'}
                </button>
                {isExporting ? (
                  <button onClick={cancelEnhancedExport} className="w-full bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-900/30 dark:hover:bg-red-900/50 dark:text-red-400 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                    Cancel Export
                  </button>
                ) : (
                  <button onClick={() => setShowEnhancedExportModal(false)} disabled={isExporting} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider disabled:opacity-50">
                    Close
                  </button>
                )}
             </div>
          </div>
        </div>
      )}

      {/* Super Clock In Modal */}
      {showSuperClockInConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-emerald-600 border-b border-slate-100 dark:border-slate-800 pb-4">
                <div className="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
                  <Play size={24} />
                </div>
                <div>
                  <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">Supervisor Duty Start</h4>
                  <p className="text-slate-500 dark:text-slate-405 text-[10px] font-bold mt-0.5 leading-tight">Clock into active duty status</p>
                </div>
             </div>
             <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Select Process Mapping</label>
                  <select value={superSelectedProcess} onChange={e => setSuperSelectedProcess(e.target.value)} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500">
                    {supervisorProcesses.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Work Location</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setSuperSelectedLocation('Office')} className={`py-3 text-xs font-bold rounded-xl border transition-all ${superSelectedLocation === 'Office' ? 'border-indigo-500 bg-indigo-50 text-indigo-605 dark:bg-indigo-950/40 dark:text-indigo-400' : 'border-slate-200 dark:border-slate-800 text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>🏢 Office</button>
                    <button type="button" onClick={() => setSuperSelectedLocation('Home')} className={`py-3 text-xs font-bold rounded-xl border transition-all ${superSelectedLocation === 'Home' ? 'border-indigo-500 bg-indigo-50 text-indigo-605 dark:bg-indigo-950/40 dark:text-indigo-400' : 'border-slate-200 dark:border-slate-800 text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>🏠 Home</button>
                  </div>
                </div>
             </div>
             <div className="flex flex-col gap-2 pt-2">
                <button onClick={() => { setShowSuperClockInConfirm(false); handleSuperClockInAction(superSelectedProcess, superSelectedLocation); }} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-emerald-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider">
                  Start Shift
                </button>
                <button onClick={() => setShowSuperClockInConfirm(false)} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                  Cancel
                </button>
             </div>
          </div>
        </div>
      )}

      {/* Super Clock Out Modal */}
      {showSuperClockOutConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-rose-650 border-b border-slate-100 dark:border-slate-800 pb-4">
                <div className="w-12 h-12 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center shrink-0">
                  <LogOut size={24} className="text-rose-600" />
                </div>
                <div>
                  <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">End Supervisor Shift</h4>
                  <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 leading-tight">Confirm duty logout</p>
                </div>
             </div>
             <p className="text-xs text-slate-600 dark:text-slate-405 font-bold uppercase tracking-wide leading-relaxed">This action terminates your active shift tracking session. Please ensure your tasks are handed over.</p>
             <div className="flex flex-col gap-2 pt-2">
                <button onClick={() => { setShowSuperClockOutConfirm(false); handleSuperClockOutAction(); }} className="w-full bg-rose-600 hover:bg-rose-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-rose-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider">
                  Clock Out Now
                </button>
                <button onClick={() => setShowSuperClockOutConfirm(false)} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                  Cancel
                </button>
             </div>
          </div>
        </div>
      )}

      {/* Super Break Modal */}
      {showSuperBreakConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-amber-600 border-b border-slate-100 dark:border-slate-800 pb-4">
                <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-950/40 flex items-center justify-center shrink-0">
                  <Coffee size={24} />
                </div>
                <div>
                  <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">Break Selection</h4>
                  <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 leading-tight">Select your break type</p>
                </div>
             </div>
             <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Break Type</label>
                <select value={superSelectedBreak} onChange={e => setSuperSelectedBreak(e.target.value)} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500">
                  {SUPERVISOR_BREAK_OPTIONS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-2 pt-2">
                <button onClick={() => { setShowSuperBreakConfirm(false); handleSuperBreakAction(superSelectedBreak); }} className="w-full bg-amber-600 hover:bg-amber-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-amber-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider">
                  Go on Break
                </button>
                <button onClick={() => setShowSuperBreakConfirm(false)} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                  Cancel
                </button>
              </div>
          </div>
        </div>
      )}

      {/* Super Resume Modal */}
      {showSuperResumeConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-indigo-600 border-b border-slate-100 dark:border-slate-800 pb-4">
                <div className="w-12 h-12 rounded-full bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center shrink-0">
                  <Zap size={24} />
                </div>
                <div>
                  <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">Resume Work</h4>
                  <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 leading-tight">Select process to resume</p>
                </div>
             </div>
             <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Process Mapping</label>
                <select value={superSelectedProcess} onChange={e => setSuperSelectedProcess(e.target.value)} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500">
                  {supervisorProcesses.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
             </div>
             <div className="flex flex-col gap-2 pt-2">
                <button onClick={() => { setShowSuperResumeConfirm(false); handleSuperResumeAction(superSelectedProcess); }} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-indigo-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider">
                  Resume Now
                </button>
                <button onClick={() => setShowSuperResumeConfirm(false)} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                  Cancel
                </button>
             </div>
          </div>
        </div>
      )}

      {showHierarchyDiagnosticModal && hierarchyDiagnosticData && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400">
                  <Bug size={20} />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-800 dark:text-slate-100">
                    TMS Hierarchy Health & Visibility Diagnostic
                  </h3>
                  <p className="text-xs text-slate-500 font-medium">
                    Authoritative vs. Resolved Reportee Audit Engine
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setShowHierarchyDiagnosticModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 font-mono text-xs">
              <div className="bg-slate-900 text-slate-100 p-4 rounded-xl border border-slate-800 space-y-2 overflow-x-auto">
                <div><span className="text-indigo-400 font-bold">Manager UID:</span> {hierarchyDiagnosticData.managerUid}</div>
                <div><span className="text-indigo-400 font-bold">Hierarchy Version:</span> {hierarchyDiagnosticData.hierarchyVersion}</div>
                <div><span className="text-indigo-400 font-bold">Direct Reportees:</span> {hierarchyDiagnosticData.directReportees}</div>
                <div><span className="text-indigo-400 font-bold">Indirect Reportees:</span> {hierarchyDiagnosticData.indirectReportees}</div>
                <div className="pt-2 border-t border-slate-800 font-bold text-sm text-emerald-400">
                  Total Expected: {hierarchyDiagnosticData.totalExpected}
                </div>
                <div className="font-bold text-sm text-emerald-400">
                  Total Resolved: {hierarchyDiagnosticData.totalResolved}
                </div>
                <div className="pt-2 border-t border-slate-800">
                  <span className="text-rose-400 font-bold">Missing UIDs:</span> {hierarchyDiagnosticData.missingUids.length === 0 ? 'None (0)' : JSON.stringify(hierarchyDiagnosticData.missingUids)}
                </div>
                <div>
                  <span className="text-amber-400 font-bold">Duplicate UIDs:</span> {hierarchyDiagnosticData.duplicateUids.length === 0 ? 'None (0)' : JSON.stringify(hierarchyDiagnosticData.duplicateUids)}
                </div>
                <div>
                  <span className="text-sky-400 font-bold">Unresolved Mapping IDs:</span> {hierarchyDiagnosticData.unresolvedMappingIds.length === 0 ? 'None (0)' : JSON.stringify(hierarchyDiagnosticData.unresolvedMappingIds)}
                </div>
                <div className="pt-2 border-t border-slate-800">
                  <span className="text-teal-400 font-bold">Filtered By Live Status:</span> Active: {hierarchyDiagnosticData.filteredByLiveStatus.active} | Break: {hierarchyDiagnosticData.filteredByLiveStatus.onBreak} | Offline: {hierarchyDiagnosticData.filteredByLiveStatus.offline}
                </div>
                <div className="font-bold text-sm text-indigo-300 pt-2 border-t border-slate-800">
                  Final TMS Count: {hierarchyDiagnosticData.finalTmsCount}
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button 
                onClick={() => setShowHierarchyDiagnosticModal(false)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl shadow-md transition-colors"
              >
                Close Diagnostic Audit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface MobileEvent {
  name: string;
  timestamp: string;
  device: string;
}

function getMobileEvents(log: any): MobileEvent[] {
  const events: MobileEvent[] = [];
  
  // 1. Clock In Event
  if (log.clockInTime && log.clockInDevice === 'mobile') {
    events.push({
      name: "Clock In - Punched",
      timestamp: log.clockInTime,
      device: 'mobile'
    });
  }
  
  // 2. Activities Events
  if (log.activities && Array.isArray(log.activities)) {
    log.activities.forEach((act: any) => {
      // If start of activity gets punched on mobile
      if (act.startTime && act.device === 'mobile') {
        let nameToDisplay = act.name || '';
        if (act.type === 'break') {
          if (nameToDisplay.toLowerCase().includes('lunch')) {
            nameToDisplay = 'Lunch Break';
          } else if (nameToDisplay.toLowerCase().includes('short')) {
            nameToDisplay = 'Short Break';
          } else if (nameToDisplay.toLowerCase().includes('bio')) {
            nameToDisplay = 'Bio Break';
          } else {
            nameToDisplay = nameToDisplay.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          }
          events.push({
            name: `${nameToDisplay} - Punched`,
            timestamp: act.startTime,
            device: 'mobile'
          });
        } else {
          const formattedProdName = nameToDisplay ? nameToDisplay.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Production';
          events.push({
            name: `${formattedProdName} - Punched`,
            timestamp: act.startTime,
            device: 'mobile'
          });
        }
      }
      
      // If end of activity (resume) gets punched on mobile
      if (act.endTime && act.device === 'mobile') {
        let nameToDisplay = act.name || '';
        if (act.type === 'break') {
          if (nameToDisplay.toLowerCase().includes('lunch')) {
            nameToDisplay = 'Lunch Break';
          } else if (nameToDisplay.toLowerCase().includes('short')) {
            nameToDisplay = 'Short Break';
          } else if (nameToDisplay.toLowerCase().includes('bio')) {
            nameToDisplay = 'Bio Break';
          } else {
            nameToDisplay = nameToDisplay.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          }
          events.push({
            name: `${nameToDisplay} - Resumed`,
            timestamp: act.endTime,
            device: 'mobile'
          });
        } else {
          const formattedProdName = nameToDisplay ? nameToDisplay.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Production';
          events.push({
            name: `${formattedProdName} - Resumed`,
            timestamp: act.endTime,
            device: 'mobile'
          });
        }
      }
    });
  }
  
  // 3. Clock Out Event
  if (log.clockOutTime && log.clockOutDevice === 'mobile') {
    events.push({
      name: "Clock Out - Punched",
      timestamp: log.clockOutTime,
      device: 'mobile'
    });
  }
  
  // Sort chronologically
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return events;
}
