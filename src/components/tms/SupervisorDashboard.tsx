import React, { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
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
  HelpCircle,
  UserCheck,
  Award,
  Plus,
  Shield,
  Clock3,
  UserX,
  Sparkles,
  LogOut,
  Smartphone,
  Monitor,
  Laptop,
  Tablet,
  Bell,
  AlertCircle,
  Play
} from 'lucide-react';
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
import { db, handleFirestoreError, OperationType, getDocsOptimized } from '../../lib/firebase';
import { firestoreLogger } from '../../lib/firestoreLogger';
import { syncShiftToAttendance } from '../../services/attendanceSyncService';
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
  onSnapshot,
  limit,
  getDocsFromCache,
  deleteDoc,
  updateDoc
} from 'firebase/firestore';
import { UserProfile, UserRole } from '../../types';
import { toast } from 'sonner';
import { canActOn } from '../../lib/hierarchy';
import { usePermission } from '../PermissionContext';
import { useRoster } from './useRoster';
import { useLiveShifts } from './useLiveShifts';
import { useHistoricalShifts } from './useHistoricalShifts';
import { useAlerts } from './useAlerts';
import { MultiSelectDropdown } from '../ui/multi-select';
import * as XLSX from 'xlsx';
import { getManagerOfManager, getShiftProductiveMs, truncateShiftToProductiveTime, getDeviceType, getDetailedDeviceMetadata } from '../../views/TMSView';
import { getLiveTime, getLiveTimeISO } from '../../lib/timeSync';
import { useSharedTimer } from '../../lib/sharedTimer';
import { isManagerRole, isTLRole } from '../../lib/roles';
import { AggregationService, AttendanceAggregate } from '../../lib/aggregationService';

interface SupervisorDashboardProps {
  user?: UserProfile;
  currentUser?: UserProfile;
  allUsers?: UserProfile[];
  onRefreshAllData?: () => void;
  externalTheme?: 'light' | 'dark';
  processes?: string[];
}

interface ShiftActivity {
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
  activities: ShiftActivity[];
  status: 'ACTIVE' | 'BREAK' | 'COMPLETED' | 'AUTO_CLOSED';
  clockInDevice?: string;
  clockOutDevice?: string;
  hasMobilePunches?: boolean;
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

  const startMs = new Date(myShift.clockInTime).getTime();
  const nowMs = now.getTime();
  const totalShiftMs = Math.max(0, nowMs - startMs);

  const elapsedShift = formatMs(totalShiftMs);

  let activeMs = 0;
  let breakMs = 0;

  (myShift.activities || []).forEach(act => {
    const start = new Date(act.startTime).getTime();
    const end = act.endTime ? new Date(act.endTime).getTime() : nowMs;
    const duration = end - start;
    const actName = (act.name || '').toLowerCase();
    const isProductive = act.type === 'productive' || 
                         actName.includes('meeting') || 
                         actName.includes('coaching') || 
                         actName.includes('training') || 
                         actName.includes('alignment');
    if (isProductive) {
      activeMs += duration;
    } else {
      breakMs += duration;
    }
  });

  const elapsedActive = formatMs(activeMs);
  const elapsedBreak = formatMs(breakMs);

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

export default function SupervisorDashboard({ user: propUser, currentUser, allUsers: propAllUsers, onRefreshAllData, externalTheme, processes }: SupervisorDashboardProps) {
  const user = propUser || currentUser;
  const allUsers = propAllUsers || [];

  if (user && globalCacheUserId !== user.uid) {
    globalCacheUserId = user.uid;
  }

  if (!user) return null;

  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [selectedActivities, setSelectedActivities] = useState<string[]>([]);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);

  const isManagerOrLead = isManagerRole(user?.role);
  const isTeamLeadOrSME = isTLRole(user?.role);

  const { hasTmsPermission, permissions, loading: permissionsLoading } = usePermission();
  const isDark = document.documentElement.classList.contains('dark') || externalTheme === 'dark';
  
  // Phase 1: Identify team members for optimized monitoring
  const teamMemberUids = useMemo(() => {
    if (!user || !propAllUsers || propAllUsers.length === 0) return [];
    
    const roleNormalized = (user.role || '').toUpperCase().trim();
    const isAdmin = roleNormalized === 'ADMIN' || roleNormalized === 'MANAGER' || roleNormalized === 'OPS_HEAD';
    
    // Admins/Managers still see most data but for 1200 users we should still scope if possible
    // For now, if Admin, we don't scope by "team" unless they want to.
    // However, the requirement says "supervisors should only monitor members belonging to their reporting hierarchy"
    
    const team = propAllUsers.filter(target => canActOn(user, target, propAllUsers));
    return team.map(u => u.uid);
  }, [user, propAllUsers]);

  // Tab control
  const [activeTab, setActiveTab] = useState<'controls' | 'hierarchy' | 'alerts'>('controls');
  
  // Tab-specific loading states
  const [isTrackingEnabled, setIsTrackingEnabled] = useState(true);
  const [isHistoryEnabled, setIsHistoryEnabled] = useState(true);
  
  const handleTabChange = (tab: 'controls' | 'hierarchy' | 'alerts') => {
    setActiveTab(tab);
    if (tab === 'alerts' && !isHistoryEnabled) {
      setIsHistoryEnabled(true);
    }
  };

  const [activeShifts, setActiveShifts] = useState<TMSShift[]>([]);
  const [localSuperOwnShift, setLocalSuperOwnShift] = useState<TMSShift | null | undefined>(undefined);
  const { shifts: liveShifts, loading: loadingLiveShifts, fetchLiveShifts } = useLiveShifts(
    user?.uid, 
    user?.role, 
    teamMemberUids,
    selectedActivities.length > 0
  );
  const { 
    shifts: paginatedShifts, 
    loading: loadingHistorical, 
    hasMore, 
    fetchNextPage,
    refresh: refreshHistoricalShifts
  } = useHistoricalShifts(user?.uid, user?.role, 50, isHistoryEnabled, teamMemberUids);

  const alerts = useAlerts(liveShifts, paginatedShifts);

  useEffect(() => {
    if (isTrackingEnabled) {
      let finalShifts = [...liveShifts];
      const myId = user.uid;

      if (localSuperOwnShift !== undefined) {
        if (localSuperOwnShift === null) {
          // Optimistically clocked out. Filter out our own shift.
          finalShifts = finalShifts.filter(s => s.userId !== myId);
          // If the server also shows we are clocked out, clear the override lock.
          const serverHasMe = liveShifts.some(s => s.userId === myId);
          if (!serverHasMe) {
            setLocalSuperOwnShift(undefined);
          }
        } else if (localSuperOwnShift) {
          // Optimistically clocked in / changed state. Replace or add our shift.
          finalShifts = finalShifts.filter(s => s.userId !== myId);
          finalShifts.push(localSuperOwnShift);

          // Once the server matches our local status, process, and activities size, clear override.
          const serverShift = liveShifts.find(s => s.userId === myId);
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

      setActiveShifts(finalShifts);
    } else {
      setActiveShifts([]);
    }
  }, [liveShifts, isTrackingEnabled, localSuperOwnShift, user.uid]);

  const [isLoadingShifts, setIsLoadingShifts] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
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
  const [superSelectedProcess, setSuperSelectedProcess] = useState(user?.lastUsedProcess || '');
  const [superSelectedBreak, setSuperSelectedBreak] = useState('Lunch');

  const supervisorProcesses = useMemo(() => {
    if (processes && processes.length > 0) return processes;
    return ['HITL', 'MPQC', 'OQC', 'SOP Training', 'QA Review', 'Team Alignment', 'Admin', 'Support', 'Quality Check'];
  }, [processes]);

  useEffect(() => {
    if (user?.lastUsedProcess) {
      setSuperSelectedProcess(user.lastUsedProcess);
    } else if (supervisorProcesses.length > 0 && !superSelectedProcess) {
      setSuperSelectedProcess(supervisorProcesses[0]);
    }
  }, [user?.lastUsedProcess, supervisorProcesses, superSelectedProcess]);

  const performSuperClockIn = async (targetProcess: string) => {
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

    // Generate client-side document reference for tmsShifts to avoid waiting for server ID assignment
    const tmsShiftRef = doc(collection(db, 'tmsShifts'));
    const generatedId = tmsShiftRef.id;

    const newShift: TMSShift = {
      id: generatedId,
      userId: user.uid,
      userName: user.name,
      userEmail: user.email,
      teamLeadUid: (user as any).teamLeadUid || (user as any).teamLeadId || '',
      mappedTL: (user as any).teamLeadEmail || (user as any).mappedTL || 'N/A',
      mappedManager: (user as any).mappedManagerEmail || (user as any).mappedManager || 'N/A',
      clockInTime: nowISO,
      activities: [{ type: 'productive', name: targetProcess, startTime: nowISO, device: currentDev }],
      status: 'ACTIVE',
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
      detectedOS: meta.os
    } as any;

    // 1. Close modal and set state immediately (Optimistic Update)
    setShowSuperClockInConfirm(false);
    setLocalSuperOwnShift(newShift);
    setActiveShifts(prev => {
      const filtered = prev.filter(s => s.userId !== user.uid);
      return [newShift, ...filtered];
    });

    try {
      const userRef = doc(db, 'users', user.uid);
      const lsRef = doc(db, 'live_sessions', user.uid);

      // 2. Perform database writes concurrently in parallel
      await Promise.all([
        setDoc(tmsShiftRef, newShift),
        updateDoc(userRef, {
          status: 'ONLINE',
          lastLoginAt: nowISO,
          lastUsedProcess: targetProcess
        }),
        setDoc(lsRef, {
          uid: user.uid,
          employeeId: user.uid,
          employeeName: user.name,
          role: user.role || 'SUPERVISOR',
          process: targetProcess,
          currentProcess: targetProcess,
          managerId: (user as any).mappedManagerId || (user as any).managerId || '',
          tlId: (user as any).teamLeadId || (user as any).teamLeadUid || '',
          status: 'ACTIVE',
          sessionStatus: 'ACTIVE',
          currentActivity: targetProcess,
          currentActivityStartTime: nowISO,
          breakType: null,
          productiveSeconds: 0,
          breakSeconds: 0,
          activities: newShift.activities,
          location: (user as any).location || 'Unknown',
          clockInTime: newShift.clockInTime,
          deviceName: newShift.deviceType || 'Unknown',
          platform: newShift.os || 'Unknown',
          lastHeartbeat: nowISO
        }, { merge: true })
      ]);

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
    const myShift = activeShifts.find(s => s.userId === user.uid);
    if (!myShift) return;

    const currentDev = getDeviceType();
    const myShiftId = myShift.id;
    const nowISO = getLiveTimeISO();
    
    const updatedActivities = [...(myShift.activities || [])];
    if (updatedActivities.length > 0) {
      const lastIndex = updatedActivities.length - 1;
      if (!updatedActivities[lastIndex].endTime) {
        updatedActivities[lastIndex].endTime = nowISO;
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
    setActiveShifts(prev => prev.filter(s => s.userId !== user.uid));

    try {
      const userRef = doc(db, 'users', user.uid);
      const liveSessionRef = doc(db, 'live_sessions', finalShift.userId);

      // 2. Perform DB updates concurrently
      await Promise.all([
        setDoc(doc(db, 'tmsShifts', myShiftId), finalShift),
        updateDoc(userRef, {
          status: 'OFFLINE',
          lastLogoutAt: nowISO
        }),
        deleteDoc(liveSessionRef),
        syncShiftToAttendance(finalShift)
      ]);

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
    const myShift = activeShifts.find(s => s.userId === user.uid);
    if (!myShift) return;

    const nowISO = getLiveTimeISO();
    const currentDev = getDeviceType();
    const updatedActivities = [...(myShift.activities || [])];
    const lastActivity = updatedActivities[updatedActivities.length - 1];

    if (myShift.status === 'ACTIVE') {
      // Start Break
      if (lastActivity && !lastActivity.endTime) {
        lastActivity.endTime = nowISO;
      }
      updatedActivities.push({ type: 'break', name: breakName, startTime: nowISO, device: currentDev });
      const updatedShift = { 
        ...myShift, 
        activities: updatedActivities, 
        status: 'BREAK' as const,
        hasMobilePunches: myShift.hasMobilePunches || currentDev === 'mobile'
      };

      // 1. Optimistic Update
      setLocalSuperOwnShift(updatedShift);
      setActiveShifts(prev => {
        const idx = prev.findIndex(s => s.id === myShift.id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = updatedShift;
        return next;
      });

      try {
        const userRef = doc(db, 'users', user.uid);
        const lsRef = doc(db, 'live_sessions', user.uid);

        // 2. Parallel concurrent writes
        await Promise.all([
          setDoc(doc(db, 'tmsShifts', myShift.id), updatedShift),
          updateDoc(userRef, { status: 'BREAK' }),
          setDoc(lsRef, {
            status: 'BREAK',
            sessionStatus: 'BREAK',
            currentActivity: breakName,
            currentActivityStartTime: nowISO,
            breakType: breakName,
            activities: updatedActivities,
            lastHeartbeat: nowISO
          }, { merge: true })
        ]);

        toast.success(`Break [${breakName}] started successfully`);
        setTimeout(() => recomputeMetrics(true), 500);
      } catch (err: any) {
        console.error('Start break failed:', err);
        toast.error('Failed to start break on server: ' + err.message);
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
    }
  };

  const handleSuperResumeAction = async (resumeProcess: string) => {
    const myShift = activeShifts.find(s => s.userId === user.uid);
    if (!myShift) return;

    const nowISO = getLiveTimeISO();
    const currentDev = getDeviceType();
    const updatedActivities = [...(myShift.activities || [])];
    const lastActivity = updatedActivities[updatedActivities.length - 1];

    if (myShift.status === 'BREAK') {
      // End Break and Resume Work
      if (lastActivity && !lastActivity.endTime) {
        lastActivity.endTime = nowISO;
      }
      updatedActivities.push({ type: 'productive', name: resumeProcess, startTime: nowISO, device: currentDev });
      const updatedShift = { 
        ...myShift, 
        activities: updatedActivities, 
        status: 'ACTIVE' as const,
        hasMobilePunches: myShift.hasMobilePunches || currentDev === 'mobile'
      };

      // 1. Optimistic Update
      setLocalSuperOwnShift(updatedShift);
      setActiveShifts(prev => {
        const idx = prev.findIndex(s => s.id === myShift.id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = updatedShift;
        return next;
      });

      try {
        const userRef = doc(db, 'users', user.uid);
        const lsRef = doc(db, 'live_sessions', user.uid);

        // 2. Parallel concurrent writes
        await Promise.all([
          setDoc(doc(db, 'tmsShifts', myShift.id), updatedShift),
          updateDoc(userRef, {
            status: 'ONLINE',
            lastUsedProcess: resumeProcess
          }),
          setDoc(lsRef, {
            status: 'ACTIVE',
            sessionStatus: 'ACTIVE',
            process: resumeProcess,
            currentProcess: resumeProcess,
            currentActivity: resumeProcess,
            currentActivityStartTime: nowISO,
            breakType: null,
            activities: updatedActivities,
            lastHeartbeat: nowISO
          }, { merge: true })
        ]);

        toast.success(`Resumed work on process: ${resumeProcess}`);
        setTimeout(() => recomputeMetrics(true), 500);
      } catch (err: any) {
        console.error('Resume failed:', err);
        toast.error('Failed to resume on server: ' + err.message);
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
    }
  };

  const handleSuperSwitchProcess = async (newProcess: string) => {
    if (!newProcess) return;
    const myShift = activeShifts.find(s => s.userId === user.uid);
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
      lastActivity.endTime = nowISO;
    }
    updatedActivities.push({ type: 'productive', name: newProcess, startTime: nowISO, device: currentDev });
    const updatedShift = { 
      ...myShift, 
      activities: updatedActivities, 
      status: 'ACTIVE' as const,
      hasMobilePunches: myShift.hasMobilePunches || currentDev === 'mobile'
    };

    // 1. Optimistic Update
    setLocalSuperOwnShift(updatedShift);
    setActiveShifts(prev => {
      const idx = prev.findIndex(s => s.id === myShift.id);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = updatedShift;
      return next;
    });

    try {
      const userRef = doc(db, 'users', user.uid);
      const lsRef = doc(db, 'live_sessions', user.uid);

      // 2. Parallel concurrent writes
      await Promise.all([
        setDoc(doc(db, 'tmsShifts', myShift.id), updatedShift),
        updateDoc(userRef, {
          lastUsedProcess: newProcess
        }),
        setDoc(lsRef, {
          process: newProcess,
          currentProcess: newProcess,
          currentActivity: newProcess,
          currentActivityStartTime: nowISO,
          activities: updatedActivities,
          lastHeartbeat: nowISO
        }, { merge: true })
      ]);

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

  // One-time auto-sync to fix legacy live_sessions missing activities and timestamps
  useEffect(() => {
    let isMounted = true;
    const performLegacySync = async () => {
      try {
        const q = query(
          collection(db, 'tmsShifts'),
          where('status', 'in', ['ACTIVE', 'BREAK'])
        );
        const snap = await getDocs(q);
        const now = new Date().getTime();
        
        for (const d of snap.docs) {
          if (!isMounted) break;
          const shiftData = d.data() as any;
          
          const productiveMs = getShiftProductiveMs(shiftData, now);
          const breakMs = (shiftData.activities || [])
            .filter((act: any) => act.type === 'break' && act.name.toLowerCase() !== 'offline' && !act.name.toLowerCase().includes('meeting') && !act.name.toLowerCase().includes('coaching') && !act.name.toLowerCase().includes('training') && !act.name.toLowerCase().includes('alignment'))
            .reduce((sum: number, act: any) => sum + (act.endTime ? new Date(act.endTime).getTime() : now) - new Date(act.startTime).getTime(), 0);

          const lastAct = shiftData.activities && shiftData.activities.length > 0 
            ? shiftData.activities[shiftData.activities.length - 1] 
            : null;

          const currentActivity = lastAct && !lastAct.endTime ? lastAct.name : 'In Transition';
          const breakType = shiftData.status === 'BREAK' && lastAct && !lastAct.endTime ? lastAct.name : null;
          const currentActivityStartTime = lastAct ? lastAct.startTime : new Date().toISOString();

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
            lastHeartbeat: new Date().toISOString()
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

  const recomputeMetrics = async (force = false) => {
    if (force) {
      setIsLoadingShifts(true);
      try {
        await Promise.all([
          fetchLiveShifts(true),
          refreshHistoricalShifts()
        ]);
        setLastRefreshed(new Date());
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

  const activeShiftsMap = useMemo(() => {
    const map = new Map<string, TMSShift>();
    activeShifts.forEach(s => map.set(s.userId, s));
    return map;
  }, [activeShifts]);

  // Subscribe to attendance config
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'config', 'attendanceSettings'), (snap) => {
      firestoreLogger.trackRead('config_attendanceSettings_onSnapshot', snap.exists() ? 1 : 0);
      if (snap.exists()) {
        const data = snap.data();
        if (typeof data.presentThreshold === 'number') {
          setPresentThreshold(data.presentThreshold);
        } else if (data.presentThreshold) {
          setPresentThreshold(Number(data.presentThreshold));
        }
      }
    }, (err) => {
      console.warn('Failed to subscribe config/attendanceSettings in SupervisorDashboard', err);
    });
    return () => unsub();
  }, []);
  const [shiftFilter, setShiftFilter] = useState('all'); // all, active, break, offline
  const [selectedTLs, setSelectedTLs] = useState<string[]>(() => {
    const roleNormalized = (user.role || '').toString().toUpperCase().trim();
    const isTeamLeadOrSupervisor = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'SME', 'TEAM LEAD', 'OPS TL', 'TRAINER TL'].includes(roleNormalized);
    if (isTeamLeadOrSupervisor) {
      const defaultName = user.fullName || user.name || '';
      return defaultName ? [defaultName] : [];
    }
    return [];
  });
  const [selectedManagers, setSelectedManagers] = useState<string[]>(() => {
    const isManager = ['ADMIN', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'TEAM_LEAD', 'STL', 'OPS_TL'].includes((user.role || '').toUpperCase());
    return isManager ? [user.name] : [];
  });
  const [sortKey, setSortKey] = useState<'name' | 'productive' | 'status'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);

  // Modals / Actions states
  const [isExporting, setIsExporting] = useState(false);

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
  const [showEnhancedExportModal, setShowEnhancedExportModal] = useState(false);
  const [exportRangePreset, setExportRangePreset] = useState('30'); // '7', '15', '30', 'custom'
  const [exportCustomStart, setExportCustomStart] = useState('');
  const [exportCustomEnd, setExportCustomEnd] = useState('');
  const [exportReportType, setExportReportType] = useState<'summary' | 'chrono' | 'both'>('both');
  const [exportFormat, setExportFormat] = useState<'excel' | 'csv'>('excel');

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
    const isManagerOrAdmin = ['ADMIN', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes(roleNormalized);

    // Allow TLs to force-out users of other team members
    if (isTL || isManagerOrAdmin) {
      const targetRole = (target.role || '').toUpperCase();
      const isTargetHigher = ['ADMIN', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes(targetRole);
      if (isTargetHigher && !isManagerOrAdmin) {
        return false;
      }
      return true;
    }

    return canActOn(user, target, allUsers);
  };


  // Mapped list of supervised agents based on hierarchy
  const mappedUsers = useMemo(() => {
    // ADMIN and OPS_HEAD can see organization-wide; other roles filter by team hierarchy or process
    const roleNormalized = (user.role || '').toUpperCase();
    const isGlobalAdmin = ['ADMIN', 'OPS_HEAD'].includes(roleNormalized);
    const userProcess = (user.process || '').toLowerCase().trim();
    
    // Status normalization (only filter out deactivated/inactive accounts, so offline agents show up in roster)
    const isActiveAccount = (u: UserProfile) => {
      const s = (u.status || '').toLowerCase();
      return s !== 'inactive';
    };

    if (isGlobalAdmin) {
      if (selectedTLs.length > 0) {
        const tlRefs = new Set<string>();
        const tlSearchLower = selectedTLs.map(tl => tl.toLowerCase().trim());
        const tlSearchSet = new Set(tlSearchLower);

        allUsers.forEach(candidate => {
          const candName = (candidate.name || '').toLowerCase().trim();
          const candFullName = (candidate.fullName || '').toLowerCase().trim();
          if (tlSearchSet.has(candName) || tlSearchSet.has(candFullName)) {
            if (candidate.uid) tlRefs.add(candidate.uid.toLowerCase().trim());
            if (candidate.email) tlRefs.add(candidate.email.toLowerCase().trim());
          }
        });
        
        // Add names directly too
        tlSearchLower.forEach(n => tlRefs.add(n));

        return allUsers.filter(u => isActiveAccount(u) && (
          (u.teamLeadId && tlRefs.has(u.teamLeadId.toLowerCase().trim())) ||
          (u.teamLeadUid && tlRefs.has(u.teamLeadUid.toLowerCase().trim())) ||
          (u.teamLeadName && tlRefs.has(u.teamLeadName.toLowerCase().trim())) ||
          (u.teamLeadEmail && tlRefs.has(u.teamLeadEmail.toLowerCase().trim())) ||
          (u.mappedTL && tlRefs.has(u.mappedTL.toLowerCase().trim())) ||
          (u.uid && tlRefs.has(u.uid.toLowerCase().trim())) ||
          (u.name && tlRefs.has(u.name.toLowerCase().trim())) ||
          (u.fullName && tlRefs.has(u.fullName.toLowerCase().trim()))
        ));
      }
      return allUsers.filter(u => isActiveAccount(u));
    }

    // For Managers, TLs, etc. - Restricted view
    return allUsers.filter(u => {
      if (!isActiveAccount(u)) return false;
      
      // Rule 1: Own mapped team members (via hierarchy)
      const isMyTeam = u.uid === user.uid || canActOn(user, u, allUsers);
      if (isMyTeam) return true;

      // Rule 2: Users working on the same process (even if from different team)
      const targetProcess = (u.process || '').toLowerCase().trim();
      if (userProcess && targetProcess && userProcess === targetProcess) return true;

      return false;
    });
  }, [allUsers, user, selectedTLs]);

  const supervisorTeamUids = useMemo(() => {
    return new Set(mappedUsers.map(u => u.uid));
  }, [mappedUsers]);

  // List of unique Team Leads who have members in mappedUsers or have a TL role
  const teamLeadsList = useMemo(() => {
    const leads = new Map<string, { name: string; role: string }>();
    const tlRoles = new Set(['TEAM_LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM LEAD', 'OPS TL', 'TRAINER TL', 'SME']);

    allUsers.forEach(u => {
      // 1. Add anyone explicitly referenced as a team lead in any active user's profile
      if (u.teamLeadId && u.teamLeadName) {
        if (!leads.has(u.teamLeadId)) {
          const tlObj = usersMap.get(u.teamLeadId);
          const roleStr = tlObj ? (tlObj.role || 'TEAM_LEAD') : 'TEAM_LEAD';
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
    const endMs = shift.clockOutTime 
      ? new Date(shift.clockOutTime).getTime() 
      : new Date().getTime();
    const startMs = new Date(shift.clockInTime).getTime();
    const totalShiftMs = Math.max(0, endMs - startMs);
    
    let activeMs = (shift as any).productiveMs || 0;
    let breakMs = (shift as any).breakMs || 0;

    if (shift.activities && shift.activities.length > 0) {
      activeMs = 0;
      breakMs = 0;
      (shift.activities || []).forEach(act => {
        const aStart = new Date(act.startTime).getTime();
        const aEnd = act.endTime ? new Date(act.endTime).getTime() : endMs;
        const duration = Math.max(0, aEnd - aStart);
        const actName = (act.name || '').toLowerCase();
        const isProductive = act.type === 'productive' || 
                             actName.includes('meeting') || 
                             actName.includes('coaching') || 
                             actName.includes('training') || 
                             actName.includes('alignment');
        if (isProductive) {
          activeMs += duration;
        } else {
          breakMs += duration;
        }
      });
    } else if ((shift as any).currentActivityStartTime && shift.status !== ('OFFLINE' as any)) {
      const tickingMs = Math.max(0, endMs - new Date((shift as any).currentActivityStartTime).getTime());
      const actName = ((shift as any).currentActivity || '').toLowerCase();
      // Infer productive vs break for ticking time if activities array is missing
      const isProductive = actName !== 'in transition' && actName !== 'lunch' && !actName.includes('break') && actName !== 'offline' && actName !== 'bio';
      
      if (actName !== 'in transition') {
        if (isProductive) {
          activeMs += tickingMs;
        } else {
          breakMs += tickingMs;
        }
      }
    }

    const activeMins = activeMs / 60000;
    const threshold = presentThreshold > 0 ? presentThreshold : 480;
    const rawUtil = (activeMins / threshold) * 100;
    const utilization = Number(Math.min(100, Math.max(0, rawUtil)).toFixed(1));

    const remainingMins = Math.max(0, threshold - activeMins);

    // Projected end-of-shift utilization based on standard 9 hours (540 mins)
    let projectedUtilization = utilization;
    if (!shift.clockOutTime) {
      const elapsedMins = totalShiftMs / 60000;
      if (elapsedMins > 0) {
        const rate = activeMins / elapsedMins;
        const projectedActiveMins = 540 * rate;
        projectedUtilization = Number(Math.min(100, Math.max(0, (projectedActiveMins / threshold) * 100)).toFixed(1));
      }
    }

    return {
      totalShiftStr: formatMs(totalShiftMs),
      activeStr: formatMs(activeMs),
      breakStr: formatMs(breakMs),
      utilization,
      totalShiftMs,
      activeMs,
      breakMs,
      activeMins,
      threshold,
      remainingMins,
      projectedUtilization
    };
  };

  // Filter & paginate the workforce controls list
  const filteredWorkforce = useMemo(() => {
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

    const sourceUsers = (selectedActivities.length > 0)
      ? allUsers.filter(u => (u.status || '').toLowerCase() !== 'inactive')
      : mappedUsers;

    return sourceUsers.filter(u => {
      const liveShift = activeShiftsMap.get(u.uid);
      
      // Do not push offline users at front-end Live Operational Supervisor Table
      if (!liveShift) return false;

      const matchesSearch = !searchLower 
        ? true 
        : (u.name.toLowerCase().includes(searchLower) || 
           u.email.toLowerCase().includes(searchLower) || 
           (u.employeeId && u.employeeId.toLowerCase().includes(searchLower)) ||
           (liveShift?.deviceType && liveShift.deviceType.toLowerCase().includes(searchLower)));

      if (!matchesSearch) return false;

      // Status filters
      if (shiftFilter !== 'all') {
        if (shiftFilter === 'active' && (!liveShift || liveShift.status !== 'ACTIVE')) return false;
        if (shiftFilter === 'break' && (!liveShift || liveShift.status !== 'BREAK')) return false;
        if (shiftFilter === 'offline' && liveShift) return false;
        if (shiftFilter === 'lunch') {
          if (!liveShift || liveShift.status !== 'BREAK') return false;
          const shActs = liveShift.activities || [];
          const lastActivity = shActs.length > 0 ? shActs[shActs.length - 1]?.name || '' : '';
          if (!lastActivity.toLowerCase().includes('lunch')) return false;
        }
        if (shiftFilter === 'meeting') {
          if (!liveShift || liveShift.status !== 'BREAK') return false;
          const shActs = liveShift.activities || [];
          const lastActivity = shActs.length > 0 ? shActs[shActs.length - 1]?.name || '' : '';
          const isMeet = lastActivity.toLowerCase().includes('meeting') || 
                         lastActivity.toLowerCase().includes('coaching') || 
                         lastActivity.toLowerCase().includes('training') || 
                         lastActivity.toLowerCase().includes('alignment');
          if (!isMeet) return false;
        }
        if (shiftFilter === 'break_tea') {
          if (!liveShift || liveShift.status !== 'BREAK') return false;
          const shActs = liveShift.activities || [];
          const lastActivity = shActs.length > 0 ? shActs[shActs.length - 1]?.name || '' : '';
          const isLunchOrMeet = lastActivity.toLowerCase().includes('lunch') || 
                                lastActivity.toLowerCase().includes('meeting') || 
                                lastActivity.toLowerCase().includes('coaching') || 
                                lastActivity.toLowerCase().includes('training') || 
                                lastActivity.toLowerCase().includes('alignment');
          if (isLunchOrMeet) return false;
        }
      }

      // Process filters
      if (selectedActivities.length > 0) {
        const uProc = (u.process || '').trim();
        const matchesUserProc = selectedActivities.includes(uProc);
        
        let matchesLiveProc = false;
        if (liveShift) {
          const liveShiftActs = liveShift.activities || [];
          const lastActivityName = liveShiftActs.length > 0 ? (liveShiftActs[liveShiftActs.length - 1]?.name || '').trim() : '';
          const currentActivityField = ((liveShift as any).currentActivity || '').trim();
          const activeProcess = lastActivityName || currentActivityField;
          matchesLiveProc = selectedActivities.includes(activeProcess);
        }
        
        if (!matchesUserProc && !matchesLiveProc) {
          return false;
        }
      }

      // Location filters
      if (selectedLocations.length > 0) {
        const uLoc = (u.location || '').trim();
        if (!selectedLocations.includes(uLoc)) {
          return false;
        }
      }

      // TL filter
      if (selectedTLs.length > 0 && selectedActivities.length === 0) {
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

      // Manager filter (robust nested traversal across all possible schema fields)
      if (selectedManagers.length > 0 && selectedActivities.length === 0) {
        const checkHierarchy = (uToCheck: UserProfile, visited: Set<string>): boolean => {
          if (!uToCheck) return false;
          
          // Match direct manager name, email or IDs from user fields
          const uNameLower = (uToCheck.name || '').toLowerCase().trim();
          const uFullNameLower = (uToCheck.fullName || '').toLowerCase().trim();
          const uEmailLower = (uToCheck.email || '').toLowerCase().trim();
          const uUidLower = (uToCheck.uid || '').toLowerCase().trim();
          const uMgrIdLower = (uToCheck.managerId || '').toLowerCase().trim();
          const uMappedMgrIdLower = (uToCheck.mappedManagerId || '').toLowerCase().trim();
          const uMappedMgrUidLower = ((uToCheck as any).mappedManagerUid || '').toLowerCase().trim();
          const uMgrNameLower = (uToCheck.managerName || uToCheck.mappedManagerName || uToCheck.Manager || '').toLowerCase().trim();
          const uMgrEmailLower = (uToCheck.managerEmail || uToCheck.mappedManagerEmail || '').toLowerCase().trim();

          const possibleManagerMatch = 
            managerRefs.has(uUidLower) ||
            managerRefs.has(uMgrIdLower) ||
            managerRefs.has(uMappedMgrIdLower) ||
            managerRefs.has(uMappedMgrUidLower) ||
            managerRefs.has(uMgrNameLower) ||
            managerRefs.has(uNameLower) ||
            managerRefs.has(uFullNameLower) ||
            managerRefs.has(uEmailLower) ||
            managerRefs.has(uMgrEmailLower);

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
          if (uToCheck.mappedManagerId) {
            const mgr = usersMap.get(uToCheck.mappedManagerId);
            if (mgr && checkHierarchy(mgr, visited)) return true;
          }
          if ((uToCheck as any).mappedManagerUid) {
            const mgr = usersMap.get((uToCheck as any).mappedManagerUid);
            if (mgr && checkHierarchy(mgr, visited)) return true;
          }
          return false;
        };
        if (!checkHierarchy(u, new Set())) return false;
      }

      return true;
    });
  }, [mappedUsers, activeShiftsMap, deferredSearchTerm, selectedActivities, selectedLocations, shiftFilter, selectedTLs, selectedManagers, usersMap, allUsers]);


  // Sorting - OPTIMIZED: Use Map
  const sortedWorkforce = useMemo(() => {
    const sorted = [...filteredWorkforce];
    sorted.sort((a,b) => {
      let valA: any = a.name;
      let valB: any = b.name;

      if (sortKey === 'status') {
        const sA = activeShiftsMap.get(a.uid)?.status || 'OFFLINE';
        const sB = activeShiftsMap.get(b.uid)?.status || 'OFFLINE';
        valA = sA;
        valB = sB;
      } else if (sortKey === 'productive') {
        const sA = activeShiftsMap.get(a.uid);
        const sB = activeShiftsMap.get(b.uid);
        valA = sA ? calculateShiftStatsObj(sA).activeMs : 0;
        valB = sB ? calculateShiftStatsObj(sB).activeMs : 0;
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filteredWorkforce, sortKey, sortOrder, activeShiftsMap]);


  // Paginated Results
  const totalPages = Math.ceil(sortedWorkforce.length / itemsPerPage);

  // Automatically clamp current page when total pages shrinks
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(Math.max(1, totalPages));
    }
  }, [totalPages, currentPage]);

  const paginatedWorkforce = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sortedWorkforce.slice(start, start + itemsPerPage);
  }, [sortedWorkforce, currentPage, itemsPerPage]);

  const uniqueActiveActivities = useMemo(() => {
    if (isTeamLeadOrSME) {
      // For TL/SME, we might still need to restrict by their assigned process
      // if that's the business requirement, but if they want "Current Activity",
      // we should probably still look at the shifts of their mapped users.
      // Given the previous code, let's keep the restriction but fix the source.
      
      const list = new Set<string>();
      activeShifts.forEach(sh => {
        // Only consider shifts for users in this TL's team
        if (sh.userEmail && mappedUsers.some(u => u.email === sh.userEmail)) {
           const shActs = sh.activities || [];
           const act = shActs.length > 0 ? shActs[shActs.length - 1] : null;
           if (act) {
             list.add(act.name.trim());
           }
        }
      });
      return Array.from(list).filter(Boolean);
    }

    const list = new Set<string>();
    // 1. Add processes from currently active/live shifts' current active activity
    activeShifts.forEach(sh => {
      const shActs = sh.activities || [];
      const act = shActs.length > 0 ? shActs[shActs.length - 1] : null;
      if (act) {
        list.add(act.name.trim());
      }
    });
    return Array.from(list).filter(Boolean);
  }, [activeShifts, mappedUsers, user, isTeamLeadOrSME]);

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
    if (!logoutShiftId) return;
    try {
      const shiftRef = doc(db, 'tmsShifts', logoutShiftId);
      const snapshot = await getDoc(shiftRef);
      if (!snapshot.exists()) {
        toast.error('Active shift has completed or moved.');
        return;
      }

      const shift = snapshot.data() as TMSShift;
      const nowISO = new Date().toISOString();
      
      const updatedActivities = [...(shift.activities || [])];
      if (updatedActivities.length > 0) {
        const lastIndex = updatedActivities.length - 1;
        if (!updatedActivities[lastIndex].endTime) {
          updatedActivities[lastIndex].endTime = nowISO;
        }
      }

      const finalShift: TMSShift = {
        ...shift,
        activities: updatedActivities,
        status: 'COMPLETED',
        clockOutTime: nowISO
      };

      await setDoc(shiftRef, finalShift);
      await syncShiftToAttendance(finalShift);

      // Log in audit trail
      await addDoc(collection(db, 'adminAuditLogs'), {
        timestamp: nowISO,
        performedBy: `${user.name} (${user.email})`,
        affectedUser: `${logoutTargetName} (${logoutTargetUid})`,
        action: 'Supervisor Remote Force Logout',
        previousValue: 'ACTIVE_WORK',
        newValue: `COMPLETED (Reason: ${logoutReason})`
      });

      toast.success(`Successfully terminated active session for ${logoutTargetName}`);
      setShowForceLogoutConfirm(false);
      recomputeMetrics(true);
    } catch (err) {
      console.error('[FORCE_OUT_FAIL]', err);
      toast.error('Failed to terminate remote session');
    }
  };

  // Full spreadsheet download routine
  const handleSpreadsheetExport = () => {
    setShowEnhancedExportModal(true);
  };

  const executeEnhancedExport = async () => {
    setIsExporting(true);
    try {
      let start = new Date();
      let end = new Date();

      if (exportRangePreset !== 'custom') {
        const days = parseInt(exportRangePreset);
        start.setDate(end.getDate() - days);
        start.setHours(0, 0, 0, 0);
      } else {
        if (!exportCustomStart || !exportCustomEnd) {
          toast.error('Please select both start and end dates');
          setIsExporting(false);
          return;
        }
        start = new Date(exportCustomStart);
        end = new Date(exportCustomEnd);
        end.setHours(23, 59, 59, 999);
      }

      toast.info(`Fetching shift data from ${start.toLocaleDateString()} to ${end.toLocaleDateString()}...`);

      // Fetch shifts in range
      const q = query(
        collection(db, 'tmsShifts'),
        where('clockInTime', '>=', start.toISOString()),
        where('clockInTime', '<=', end.toISOString())
      );
      const snap = await getDocsOptimized(q, 'export_shifts');
      const shifts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
      
      // Filter for team scope
      const scopeIds = new Set(mappedUsers.map(u => u.uid));
      const teamShifts = shifts.filter(sh => scopeIds.has(sh.userId));

      if (teamShifts.length === 0) {
        toast.error('No shift data found for the selected range.');
        setIsExporting(false);
        return;
      }

      const workbook = XLSX.utils.book_new();

      // 1. Utilization Summary
      if (exportReportType === 'summary' || exportReportType === 'both') {
        const summaryHeaders = [
          'Emp ID', 'Employee Name', 'Email', 'Role', 'Department', 'Location', 'Process / Segment', 'Team Lead', 'Manager', 'Manager of Manager',
          'Date', 'Clock In', 'Clock Out', 'Shift Status',
          'Prod Minutes', 'Break Minutes', 'Total Minutes', 'Utilization %'
        ];

        const summaryRows = teamShifts.map(sh => {
          const u = allUsers.find(user => 
            user.uid === sh.userId || 
            (user.email && sh.userEmail && user.email.toLowerCase().trim() === sh.userEmail.toLowerCase().trim())
          );
          const stats = calculateShiftStatsObj(sh);
          const dateStr = new Date(sh.clockInTime).toLocaleDateString('en-IN');
          
          return [
            u?.employeeId || (u as any).empID || 'N/A',
            u?.fullName || u?.name || sh.userName,
            u?.email || sh.userEmail,
            u?.role || 'N/A',
            u?.department || 'Operations',
            u?.location || 'N/A',
            u?.process || 'N/A',
            u?.teamLeadName || 'Unassigned',
            u?.mappedManagerName || u?.managerName || 'Unassigned',
            u ? getManagerOfManager(u, allUsers) : 'N/A',
            dateStr,
            new Date(sh.clockInTime).toLocaleTimeString('en-IN'),
            sh.clockOutTime ? new Date(sh.clockOutTime).toLocaleTimeString('en-IN') : 'N/A',
            sh.status,
            Math.round(stats.activeMs / 60000),
            Math.round(stats.breakMs / 60000),
            Math.round(stats.totalShiftMs / 60000),
            stats.utilization
          ];
        });

        const ws = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
        XLSX.utils.book_append_sheet(workbook, ws, "Utilization Summary");
      }

      // 2. Chronological Log
      if (exportReportType === 'chrono' || exportReportType === 'both') {
        const chronoHeaders = [
          'Emp ID', 'Employee Name', 'Email', 'Location', 'Manager of Manager', 'Date', 'Sequence', 'Type', 'Activity', 'Start Time', 'End Time', 'Duration (Min)'
        ];

        const chronoRows: any[] = [];
        teamShifts.forEach(sh => {
          const dateStr = new Date(sh.clockInTime).toLocaleDateString('en-IN');
          const u = allUsers.find(user => 
            user.uid === sh.userId || 
            (user.email && sh.userEmail && user.email.toLowerCase().trim() === sh.userEmail.toLowerCase().trim())
          );
          const empId = u?.employeeId || (u as any).empID || 'N/A';
          const loc = u?.location || 'N/A';
          const mom = u ? getManagerOfManager(u, allUsers) : 'N/A';

          (sh.activities || []).forEach((act, idx) => {
            const startStr = new Date(act.startTime).toLocaleTimeString('en-IN');
            const endStr = act.endTime ? new Date(act.endTime).toLocaleTimeString('en-IN') : 'Ongoing';
            const durationArr = act.endTime 
              ? (new Date(act.endTime).getTime() - new Date(act.startTime).getTime()) / 60000 
              : (new Date().getTime() - new Date(act.startTime).getTime()) / 60000;

            chronoRows.push([
              empId,
              sh.userName,
              sh.userEmail,
              loc,
              mom,
              dateStr,
              idx + 1,
              act.type,
              act.name,
              startStr,
              endStr,
              Math.round(durationArr)
            ]);
          });
        });

        const ws = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
        XLSX.utils.book_append_sheet(workbook, ws, "Chronological Activity Log");
      }



      if (exportFormat === 'excel') {
        XLSX.writeFile(workbook, `TMS_Enhanced_Report_${user.name.split(' ').join('_')}.xlsx`);
      } else {
        // Simple CSV handling for the first sheet
        const firstSheetName = workbook.SheetNames[0];
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheetName]);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `TMS_Enhanced_Report_${user.name.split(' ').join('_')}.csv`;
        link.click();
      }

      toast.success('Enhanced report exported successfully!');
      setShowEnhancedExportModal(false);
    } catch (err) {
      console.error('Enhanced Export Error:', err);
      toast.error('Failed to generate enhanced report');
    } finally {
      setIsExporting(false);
    }
  };

  const executeBulkForceLogout = async () => {
    if (activeShifts.length === 0) {
      toast.error('No active shifts found to logout.');
      return;
    }
    
    setIsBulkLoggingOut(true);
    try {
      const batch = writeBatch(db);
      const nowISO = new Date().toISOString();
      const count = activeShifts.length;
      
      activeShifts.forEach(sh => {
        const updatedActivities = [...(sh.activities || [])];
        if (updatedActivities.length > 0) {
          const lastIndex = updatedActivities.length - 1;
          if (!updatedActivities[lastIndex].endTime) {
            updatedActivities[lastIndex].endTime = nowISO;
          }
        }

        batch.set(doc(db, 'tmsShifts', sh.id), {
          ...sh,
          activities: updatedActivities,
          status: 'COMPLETED',
          clockOutTime: nowISO
        });

        // Update User Status
        batch.update(doc(db, 'users', sh.userId), {
          status: 'OFFLINE',
          lastLogoutAt: nowISO
        });
      });

      await batch.commit();

      // Audit logs
      await addDoc(collection(db, 'adminAuditLogs'), {
        timestamp: nowISO,
        performedBy: `${user.name} (${user.email})`,
        affectedUser: 'Multiple Users (Bulk)',
        action: 'Bulk Force Logout Execution',
        previousValue: 'ACTIVE/BREAK',
        newValue: 'COMPLETED',
        details: {
          count,
          reason: 'Administrative Bulk Logout'
        }
      });

      toast.success(`Successfully logged out ${count} active users.`);
      setShowBulkLogoutModal(false);
      recomputeMetrics(true);
    } catch (err) {
      console.error('Bulk Logout Error:', err);
      toast.error('Failed to perform bulk logout');
    } finally {
      setIsBulkLoggingOut(false);
    }
  };

  // Dynamic live statistics to keep KPI tiles and distribution sync'd with selected filters
  const liveStats = useMemo(() => {
    // Session device tracking parameters computed locally for true real-time visibility
    // Compute from activeShiftList (filtered by team/TL/Manager/Search/Device)
    const activeShiftList = filteredWorkforce.map(u => activeShiftsMap.get(u.uid)).filter(Boolean) as TMSShift[];
    
    const activeDesktop = activeShiftList.filter(s => {
      const dtype = s.deviceType || (s.clockInDevice === 'mobile' ? 'Mobile' : 'Desktop');
      return dtype === 'Desktop';
    }).length;

    const activeMobile = activeShiftList.filter(s => {
      const dtype = s.deviceType || (s.clockInDevice === 'mobile' ? 'Mobile' : 'Desktop');
      return dtype === 'Mobile' || dtype === 'Tablet';
    }).length;

    const totalActiveCount = activeShiftList.length;
    const mobileAccessPercent = totalActiveCount > 0 ? Math.round((activeMobile / totalActiveCount) * 100) : 0;

    const assignedWorkforce = mappedUsers.filter(u => {
      const searchLower = deferredSearchTerm?.toLowerCase() || '';
      const matchesSearch = !searchLower 
        ? true 
        : (u.name.toLowerCase().includes(searchLower) || 
           u.email.toLowerCase().includes(searchLower) || 
           (u.employeeId && u.employeeId.toLowerCase().includes(searchLower)));

      if (!matchesSearch) return false;

      // Location & Current Activity filters
      const liveShift = activeShiftsMap[u.uid];
      const lastActivity = liveShift && liveShift.activities && liveShift.activities.length > 0 
          ? liveShift.activities[liveShift.activities.length - 1].name.trim()
          : 'Offline';
          
      const matchesActivity = selectedActivities.length === 0 || selectedActivities.includes(lastActivity);
      const matchesLocation = selectedLocations.length === 0 || selectedLocations.includes(u.location || '');
      
      return matchesActivity && matchesLocation;
    });

    const total = assignedWorkforce.length;
    const loggedIn = activeShiftList.length;
    const onBreak = activeShiftList.filter(s => s.status === 'BREAK').length;
    const active = activeShiftList.filter(s => s.status === 'ACTIVE').length;
    const offline = Math.max(0, total - loggedIn);
    const attendancePercent = total > 0 ? Math.round((loggedIn / total) * 100) : 0;
    
    // Calculate team average utilization for all logged-in users under current scope
    let totalUtil = 0;
    activeShiftList.forEach(sh => {
      const stats = calculateShiftStatsObj(sh);
      totalUtil += stats.utilization;
    });
    const teamAvgUtilization = activeShiftList.length > 0 
      ? Number((totalUtil / activeShiftList.length).toFixed(1)) 
      : 0;
    
    return {
      total,
      loggedIn,
      onBreak,
      active,
      offline,
      attendancePercent,
      teamAvgUtilization,
      activeDesktop,
      activeMobile,
      mobileAccessPercent
    };
  }, [filteredWorkforce, activeShiftsMap, activeShifts, searchTerm, selectedActivities, selectedTLs, selectedManagers, shiftFilter]);

  const liveDistribution = useMemo(() => {
    const total = filteredWorkforce.length || 1;
    const activeShiftList = filteredWorkforce.map(u => activeShiftsMap.get(u.uid)).filter(Boolean) as TMSShift[];
    
    const active = activeShiftList.filter(s => s.status === 'ACTIVE').length;
    
    let lunch = 0;
    let meeting = 0;
    let otherBreak = 0;
    
    activeShiftList.forEach(sh => {
      if (sh.status === 'BREAK') {
        const shActs = sh.activities || [];
        const lastActivity = shActs.length > 0 ? shActs[shActs.length - 1]?.name || '' : '';
        if (lastActivity.toLowerCase().includes('lunch')) {
          lunch++;
        } else if (lastActivity.toLowerCase().includes('meeting') || lastActivity.toLowerCase().includes('coaching') || lastActivity.toLowerCase().includes('training') || lastActivity.toLowerCase().includes('alignment')) {
          meeting++;
        } else {
          otherBreak++;
        }
      }
    });

    const loggedIn = activeShiftList.length;
    const offline = Math.max(0, filteredWorkforce.length - loggedIn);
    
    return {
      active,
      break: otherBreak,
      lunch,
      meeting,
      offline
    };
  }, [filteredWorkforce, activeShiftsMap]);

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

  return (
    <div className="space-y-6">
      
      {/* HEADER SECTION WITH AUTO REFRESH TICKER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-slate-900 text-slate-800 dark:text-white p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-55 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900/40 rounded-xl shadow-xs">
            <Shield size={20} className="animate-pulse" />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight">Workforce Management Command</h2>
            <div className="flex flex-wrap items-center gap-3 mt-0.5">
              <p className="text-xs text-slate-500 dark:text-slate-400 font-sans">Separate controls for monitoring, supervision rosters, break exceeds & mobile logs & live statistics.</p>
              <div className="h-3 w-px bg-slate-200 dark:bg-slate-800 hidden md:block" />
              <div className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">
                <span>Updated: {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <button 
                  onClick={() => recomputeMetrics(true)} 
                  disabled={isLoadingShifts}
                  className="hover:text-indigo-500 transition-colors cursor-pointer p-1"
                  title="Force Refresh Data"
                >
                  <RefreshCw size={10} className={isLoadingShifts ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {(() => {
            const myShift = activeShifts.find(s => s.userId === user.uid);
            if (myShift) {
              const lastAct = myShift.activities && myShift.activities.length > 0 
                ? myShift.activities[myShift.activities.length - 1] 
                : null;
              const currentProc = lastAct && !lastAct.endTime ? lastAct.name : 'N/A';
              
              return (
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-wrap">
                  {/* Real-time Tickers */}
                  <SupervisorClockStrip myShift={myShift} />

                  <div className="flex items-center gap-2 flex-wrap">
                    {myShift.status === 'ACTIVE' ? (
                      <>
                        {/* Switch Process Control */}
                        <div className="flex items-center gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1">
                          <span className="text-[10px] font-black uppercase text-slate-400">Process:</span>
                          <select
                            className="bg-transparent border-none text-[11px] font-bold text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer p-0"
                            value={currentProc}
                            onChange={(e) => handleSuperSwitchProcess(e.target.value)}
                          >
                            <option value="" disabled>Switch...</option>
                            {supervisorProcesses.map(p => (
                              <option key={p} value={p}>{p}</option>
                            ))}
                          </select>
                        </div>

                        {/* Punch Break Control */}
                        <div className="flex items-center gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1">
                          <span className="text-[10px] font-black uppercase text-slate-400">Break:</span>
                          <select
                            className="bg-transparent border-none text-[11px] font-bold text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer p-0"
                            value={superSelectedBreak}
                            onChange={(e) => setSuperSelectedBreak(e.target.value)}
                          >
                            {SUPERVISOR_BREAK_OPTIONS.map(b => (
                              <option key={b} value={b}>{b}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleSuperBreakAction(superSelectedBreak)}
                            className="bg-amber-500 hover:bg-amber-600 text-white text-[10px] px-1.5 py-0.5 rounded font-bold cursor-pointer transition-colors"
                          >
                            Punch
                          </button>
                        </div>
                      </>
                    ) : (
                      /* Break Resume Control */
                      <div className="flex items-center gap-2 bg-amber-50 dark:bg-amber-950/20 border border-amber-200/40 rounded-lg px-2.5 py-1 text-xs text-amber-800 dark:text-amber-400">
                        <Coffee size={12} className="animate-bounce" />
                        <span className="font-bold">On Break ({currentProc})</span>
                        <div className="h-3 w-px bg-amber-200 dark:bg-amber-800" />
                        <button
                          onClick={() => {
                            const lastProductive = [...(myShift.activities || [])]
                              .reverse()
                              .find(act => act.type === 'productive');
                            const resumeProc = lastProductive?.name || user.process || supervisorProcesses[0] || 'HITL';
                            handleSuperResumeAction(resumeProc);
                          }}
                          className="bg-amber-500 hover:bg-amber-600 text-white text-[10px] px-2 py-1 rounded font-bold cursor-pointer transition-colors shadow-sm flex items-center gap-1"
                        >
                          <Play size={10} />
                          <span>Resume Work</span>
                        </button>
                      </div>
                    )}

                    {/* Clock Out Button */}
                    <button
                      onClick={() => setShowSuperClockOutConfirm(true)}
                      className="bg-rose-600 hover:bg-rose-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-colors flex items-center gap-1 shadow-sm"
                    >
                      <LogOut size={12} />
                      <span>Clock Out</span>
                    </button>
                  </div>
                </div>
              );
            } else {
              /* Clocked Out Banner */
              return (
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400">You are clocked out.</span>
                  <button
                    onClick={() => setShowSuperClockInConfirm(true)}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-all flex items-center gap-1 shadow-sm hover:scale-[1.01]"
                  >
                    <Play size={11} />
                    <span>Clock In</span>
                  </button>
                </div>
              );
            }
          })()}
        </div>
      </div>

      {/* CORE STATS KPI TILES (TOP SUMMARY CARDS - REACTIVE TO ACTIVE FILTERS) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-w-2xl">
        <div className="bg-white dark:bg-slate-900 border border-indigo-250 dark:border-indigo-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-400 leading-none">Active Work</span>
          <h3 className="text-xl font-black text-indigo-600 dark:text-indigo-400 mt-0.5">{liveStats.active}</h3>
          <p className="text-[8px] text-indigo-500 dark:text-indigo-505/85 font-bold mt-0.5 leading-none">Productive Timers</p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-amber-250 dark:border-amber-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400 leading-none">On Break</span>
          <h3 className="text-xl font-black text-amber-500 dark:text-amber-400 mt-0.5">{liveStats.onBreak}</h3>
          <p className="text-[8px] text-amber-500 dark:text-amber-505/85 font-bold mt-0.5 leading-none">Rest Periods</p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-teal-250 dark:border-teal-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-teal-600 dark:text-teal-400 leading-none">Team Avg Util</span>
          <h3 className="text-xl font-black text-teal-600 dark:text-teal-400 mt-0.5">{liveStats.teamAvgUtilization}%</h3>
          <p className="text-[8px] text-teal-550 dark:text-teal-500 font-bold mt-0.5 leading-none">Target: {presentThreshold}m</p>
        </div>
      </div>

      {/* ONBOARDING USER GUIDE BAR */}

      {/* ADMIN DEVICE ACCESS ANALYTICS */}
      <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 flex flex-col md:flex-row md:items-center md:justify-between gap-4 select-none">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 rounded-xl shrink-0">
            <Smartphone size={18} />
          </div>
          <div className="text-left leading-normal">
            <h4 className="text-[11px] font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest leading-none">
              Device Access Analytics
            </h4>
            <p className="text-[10px] text-slate-500 mt-1 leading-none">Real-time visibility into agent devices, browsers, and access channels</p>
          </div>
        </div>
        
        <div className="grid grid-cols-3 gap-3 shrink-0">
          <div className="bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800/80 px-4 py-2.5 rounded-xl text-center shadow-2xs min-w-28 sm:min-w-32">
            <div className="text-[8px] uppercase tracking-wider text-slate-400 font-bold">Active Desktop</div>
            <div className="text-base font-black text-sky-600 dark:text-sky-455 font-mono mt-0.5">{liveStats.activeDesktop || 0}</div>
          </div>
          <div 
            className="bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800/80 px-4 py-2.5 rounded-xl text-center shadow-2xs min-w-28 sm:min-w-32"
          >
            <div className="text-[8px] uppercase tracking-wider text-slate-400 font-bold">Active Mobile</div>
            <div className="text-base font-black text-rose-500 font-mono mt-0.5">{liveStats.activeMobile || 0}</div>
          </div>
          <div className="bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800/80 px-4 py-2.5 rounded-xl text-center shadow-2xs min-w-28 sm:min-w-32">
            <div className="text-[8px] uppercase tracking-wider text-slate-400 font-bold">Mobile Access %</div>
            <div className="text-base font-black text-indigo-600 dark:text-indigo-455 font-mono mt-0.5">{liveStats.mobileAccessPercent || 0}%</div>
          </div>
        </div>
      </div>

        {/* EXPORT BUTTON */}
        <div className="flex justify-end mb-4">
            <button 
              onClick={handleSpreadsheetExport}
              disabled={isExporting}
              className="bg-emerald-600 hover:bg-emerald-700 text-white p-3 rounded-xl flex items-center justify-center gap-2 text-xs font-extrabold transition-colors cursor-pointer"
            >
              <FileSpreadsheet size={15} /> Export Utilization Report
            </button>
        </div>

      {/* DASHBOARD TABS */}
      <div className="flex gap-3 border-b border-slate-200 dark:border-slate-800 pb-2 overflow-x-auto scrollbar-none">

        <button 
          onClick={() => handleTabChange('controls')}
          className={`flex flex-col items-start gap-1 px-5 py-3 rounded-xl text-left transition-all cursor-pointer border shadow-sm select-none ${
            activeTab === 'controls' 
              ? 'bg-indigo-600 border-indigo-600 text-white dark:bg-indigo-600 dark:border-indigo-600' 
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-850'
          }`}
        >
          <div className="flex items-center gap-1.5 font-black text-xs">
            <Users size={14} className={activeTab === 'controls' ? 'text-white' : 'text-indigo-600'} />
            {['ADMIN', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes((user.role || '').toUpperCase()) ? 'Live Floor Controls' : 'Live Team Controls'}
          </div>
          <span className={`text-[10px] font-medium ${activeTab === 'controls' ? 'text-indigo-100' : 'text-slate-500 dark:text-slate-400'}`}>Clock out, edit shift logs & filters</span>
        </button>

        <button 
          onClick={() => handleTabChange('alerts')}
          className={`flex flex-col items-start gap-1 px-5 py-3 rounded-xl text-left transition-all cursor-pointer border shadow-sm select-none ${
            activeTab === 'alerts' 
              ? 'bg-rose-50/70 border-rose-200 text-rose-700 dark:bg-rose-950/40 dark:border-rose-900/40 dark:text-rose-300' 
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-850'
          }`}
        >
          <div className="flex items-center gap-1.5 font-black text-xs">
            <Bell size={14} className={activeTab === 'alerts' ? 'text-rose-500' : 'text-rose-400/60'} />
            Alerts & Violations
          </div>
          <span className={`text-[10px] font-medium ${activeTab === 'alerts' ? 'text-rose-600/80 dark:text-rose-400/80' : 'text-slate-500 dark:text-slate-400'}`}>Exceeded breaks & stale sessions</span>
        </button>

      </div>

      {/* RENDER SELECTED TAB VIEWS */}
      <div className="space-y-6">

        {/* TAB: ALERTS & VIOLATIONS */}
        {activeTab === 'alerts' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-1.5">
                    <ShieldAlert className="text-rose-400" size={16} />
                    Integrity Alerts & Threshold Violations
                  </h3>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">Real-time detection of break overruns, stale sessions, and mobile device activity for mapped team members.</p>
                </div>
                <div className="flex items-center gap-1.5">
                   <div className="px-2 py-1 rounded bg-slate-50 dark:bg-slate-950/30 text-slate-600 dark:text-slate-400 text-[9px] font-black uppercase border border-slate-100 dark:border-slate-900/40">
                     {teamAlerts.length} Active Team Alerts
                   </div>
                   <button 
                     onClick={() => recomputeMetrics(true)}
                     className="p-1.5 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 transition-colors cursor-pointer"
                   >
                     <RefreshCw size={12} className={isLoadingShifts ? 'animate-spin' : ''} />
                   </button>
                </div>
              </div>

              {teamAlerts.length === 0 ? (
                <div className="py-10 flex flex-col items-center justify-center text-center space-y-2">
                  <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-full">
                    <CheckCircle size={32} className="text-emerald-500" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-900 dark:text-white">All Clear</h4>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">No active threshold violations detected under your team.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-8">
                  {/* CATEGORY 1: BREAK EXCEEDS */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 border-b border-amber-100 dark:border-amber-950/40 pb-2">
                      <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 text-amber-500">
                        <Coffee size={14} />
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                          Break Exceeds
                          <span className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400 text-[10px] font-black border border-amber-100 dark:border-amber-900/30">
                            {breakExceedsAlerts.length}
                          </span>
                        </h4>
                        <p className="text-[9px] text-slate-400 dark:text-slate-500 font-medium">Agents currently exceeding bio, short, or lunch break duration limits.</p>
                      </div>
                    </div>

                    {breakExceedsAlerts.length === 0 ? (
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 italic px-2 py-1">No active break violations.</p>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {breakExceedsAlerts.map((alert) => renderAlertCard(alert, 'break'))}
                      </div>
                    )}
                  </div>

                  {/* CATEGORY 2: MOBILE LOGS */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 border-b border-sky-100 dark:border-sky-950/40 pb-2">
                      <div className="p-1.5 rounded-lg bg-sky-50 dark:bg-sky-950/30 text-sky-500">
                        <Smartphone size={14} />
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                          Mobile Logs
                          <span className="px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-450 text-[10px] font-black border border-sky-100 dark:border-sky-900/30">
                            {mobileLogsAlerts.length}
                          </span>
                        </h4>
                        <p className="text-[9px] text-slate-400 dark:text-slate-500 font-medium">Shifts flagged for using a mobile device interface to punch.</p>
                      </div>
                    </div>

                    {mobileLogsAlerts.length === 0 ? (
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 italic px-2 py-1">No mobile device punches detected.</p>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {mobileLogsAlerts.map((alert) => renderAlertCard(alert, 'mobile'))}
                      </div>
                    )}
                  </div>

                  {/* CATEGORY 3: AUTO-LOGOUTS / STALE SESSIONS */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 border-b border-rose-100 dark:border-rose-950/40 pb-2">
                      <div className="p-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/30 text-rose-450">
                        <LogOut size={14} />
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                          Auto-Logouts & Stale Sessions
                          <span className="px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400 text-[10px] font-black border border-rose-100 dark:border-rose-900/30">
                            {autoLogoutsAlerts.length}
                          </span>
                        </h4>
                        <p className="text-[9px] text-slate-400 dark:text-slate-500 font-medium">Active sessions exceeding 10 productive hours requiring force out or audit.</p>
                      </div>
                    </div>

                    {autoLogoutsAlerts.length === 0 ? (
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 italic px-2 py-1">No stale active sessions.</p>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {autoLogoutsAlerts.map((alert) => renderAlertCard(alert, 'logout'))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        
        {/* TAB 4: HIERARCHY VALIDATION REPORT (ADMIN ONLY) */}
        {activeTab === 'hierarchy' && ['ADMIN', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes((user.role || '').toUpperCase()) && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                    <Shield size={18} className="text-indigo-500" /> Organization Hierarchy Validation Report
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Diagnostic view showing synchronization between employee roster and team mapping.</p>
                </div>
                <button 
                  onClick={() => onRefreshAllData?.()}
                  className="bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors"
                >
                  <RefreshCw size={14} /> Sync Roster
                </button>
              </div>

              {/* Statistics Overview */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                <div className="bg-slate-50 dark:bg-slate-950/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
                  <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Unmapped Users</span>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-2xl font-black text-rose-500">{allUsers.filter(u => !u.teamLeadId && !u.mappedManagerId && !u.managerId && u.role !== 'ADMIN').length}</span>
                    <span className="text-[10px] bg-rose-50 dark:bg-rose-900/20 text-rose-600 px-2 py-0.5 rounded-full font-bold">Needs Mapping</span>
                  </div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-950/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
                  <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Total Active Units</span>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-2xl font-black text-slate-800 dark:text-slate-200">{allUsers.filter(u => !u.status || u.status.toLowerCase().trim() === 'active' || u.isActive === true).length}</span>
                    <span className="text-[10px] bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 px-2 py-0.5 rounded-full font-bold">Roster Capacity</span>
                  </div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-950/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
                  <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Supervisors Identified</span>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-2xl font-black text-slate-800 dark:text-slate-200">{teamLeadsList.length}</span>
                    <span className="text-[10px] bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 px-2 py-0.5 rounded-full font-bold">TL Variants</span>
                  </div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-950/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
                  <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Missing Manager Link</span>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-2xl font-black text-orange-500">{allUsers.filter(u => !u.managerId && !u.mappedManagerId && u.role !== 'ADMIN' && u.role !== 'MANAGER').length}</span>
                    <span className="text-[10px] bg-orange-50 dark:bg-orange-900/20 text-orange-600 px-2 py-0.5 rounded-full font-bold">Incomplete</span>
                  </div>
                </div>
              </div>

              {/* Detailed Mapping Table */}
              <div className="space-y-4">
                <h4 className="text-xs font-black text-slate-700 dark:text-slate-300 uppercase tracking-widest px-1">Team Mapping Summary</h4>
                <div className="overflow-x-auto border border-slate-100 dark:border-slate-800 rounded-xl">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase font-black text-slate-500">
                      <tr>
                        <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">Resource (Supervisor)</th>
                        <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 text-center">Mapped Count</th>
                        <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">Mapped Role types</th>
                        <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 dark:divide-slate-850">
                      {teamLeadsList.map((tl) => {
                        const directReports = allUsers.filter(u => u.teamLeadId === tl.id || (u.teamLeadEmail && u.teamLeadEmail.toLowerCase() === tl.id.toLowerCase()));
                        const roles = Array.from(new Set(directReports.map(u => u.role))).join(', ');
                        const isInvalid = !['TEAM_LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL'].includes((allUsers.find(u => u.uid === tl.id)?.role || '').toString().toUpperCase());
                        
                        return (
                          <tr key={tl.id} className="hover:bg-slate-50 dark:hover:bg-slate-850/40 transition-colors">
                            <td className="px-4 py-3">
                              <div className="font-extrabold text-xs text-slate-800 dark:text-slate-200">{tl.name}</div>
                              <div className="text-[9px] font-bold text-slate-400">{tl.roleDisplay} • {tl.id}</div>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`text-xs font-black ${directReports.length === 0 ? 'text-slate-400' : 'text-indigo-600 dark:text-indigo-400'}`}>
                                {directReports.length}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-[10px] font-bold text-slate-500 whitespace-nowrap overflow-hidden text-ellipsis max-w-48 block">
                                {roles || 'No active mappings'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              {isInvalid ? (
                                <span className="bg-amber-50 dark:bg-amber-950/20 text-amber-600 text-[9px] font-black px-2 py-0.5 rounded-full uppercase">Invalid TL Role</span>
                              ) : (
                                <span className="bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 text-[9px] font-black px-2 py-0.5 rounded-full uppercase">Verified</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="mt-6 space-y-4">
                  <h4 className="text-xs font-black text-slate-700 dark:text-slate-300 uppercase tracking-widest px-1">Integrity Alerts</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-rose-50/30 dark:bg-rose-950/10 border border-rose-100 dark:border-rose-900/30 p-4 rounded-xl">
                      <h5 className="text-[11px] font-black text-rose-700 dark:text-rose-400 flex items-center gap-1.5 mb-2 uppercase">
                        <AlertTriangle size={14} /> Unmapped Users (No TL/Mgr)
                      </h5>
                      <div className="max-h-40 overflow-y-auto space-y-2">
                        {allUsers.filter(u => !u.teamLeadId && !u.mappedManagerId && !u.managerId && u.role === 'AGENT').slice(0, 10).map(u => (
                          <div key={u.uid} className="text-[10px] flex justify-between items-center text-slate-600 dark:text-slate-400 bg-white/50 dark:bg-slate-900/50 p-2 rounded-lg">
                            <span>{u.fullName || u.name}</span>
                            <span className="font-mono text-slate-400">{u.process || 'NO_PROCESS'}</span>
                          </div>
                        ))}
                        {allUsers.filter(u => !u.teamLeadId && !u.mappedManagerId && !u.managerId && u.role === 'AGENT').length > 10 && (
                          <div className="text-[9px] text-center text-slate-400 font-bold italic pt-1">
                            +{allUsers.filter(u => !u.teamLeadId && !u.mappedManagerId && !u.managerId && u.role === 'AGENT').length - 10} more unmapped
                          </div>
                        )}
                        {allUsers.filter(u => !u.teamLeadId && !u.mappedManagerId && !u.managerId && u.role === 'AGENT').length === 0 && (
                          <div className="text-[10px] text-emerald-600 font-bold text-center py-2 italic">All active users have valid mappings</div>
                        )}
                      </div>
                    </div>

                    <div className="bg-amber-50/30 dark:bg-amber-950/10 border border-amber-100 dark:border-amber-900/30 p-4 rounded-xl">
                      <h5 className="text-[11px] font-black text-amber-700 dark:text-amber-400 flex items-center gap-1.5 mb-2 uppercase">
                        <Shield size={14} /> Duplicate/Orphan Logic
                      </h5>
                      <div className="text-[10px] space-y-2.5 text-slate-600 dark:text-slate-400">
                        <div className="flex justify-between items-center p-2 rounded-lg bg-white/50 dark:bg-slate-900/50">
                          <span>Users with Multiple Sync IDs</span>
                          <span className="font-black text-slate-900 dark:text-white">0</span>
                        </div>
                        <div className="flex justify-between items-center p-2 rounded-lg bg-white/50 dark:bg-slate-900/50">
                          <span>Legacy Mapping Entries</span>
                          <span className="font-black text-slate-900 dark:text-white">
                            {allUsers.filter(u => !!u.Manager || !!u.mappedManager).length}
                          </span>
                        </div>
                        <div className="flex justify-between items-center p-2 rounded-lg bg-white/50 dark:bg-slate-900/50">
                          <span>Master Roster Sync Health</span>
                          <span className="font-black text-emerald-600">Active</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}



        {/* TAB 2: ROSTER WORKFORCE CONTROLS (ADVANCED FILTERS & POWER LIST) */}
        {activeTab === 'controls' && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden space-y-4 text-slate-800 dark:text-white">
            
            {/* Header + Multi filters */}
            <div className="p-5 border-b border-slate-100 dark:border-slate-800 space-y-4 bg-slate-50/50 dark:bg-slate-950/25">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-wide">
                    Live Operational Supervision Table
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Conduct direct searches, force logout actions, filters and page navigation.</p>
                </div>

                <div className="relative w-full md:w-72">
                  <Search className="absolute left-3 top-2 text-slate-400" size={16} />
                  <input 
                    type="text"
                    value={searchTerm}
                    onChange={(e) => {
                      setSearchTerm(e.target.value);
                      setCurrentPage(1);
                    }}
                    placeholder="Quick Search Name, Email, ID..."
                    className="pl-9 pr-4 py-1.5 text-xs bg-white text-slate-800 border border-slate-250 rounded-xl focus:outline-indigo-500 w-full"
                  />
                </div>
              </div>

              {/* Multiple Advanced Pull-down Options */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 text-xs">
                <div className="relative" ref={statusDropdownRef}>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Status Filter</label>
                  <button
                    type="button"
                    onClick={() => setIsStatusDropdownOpen(!isStatusDropdownOpen)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2 font-bold text-left text-slate-700 dark:text-slate-200 cursor-pointer flex justify-between items-center text-xs shadow-xs focus:ring-1 focus:ring-indigo-500"
                  >
                    <span className="truncate">
                      {shiftFilter === 'all' && "🟢 Status: All"}
                      {shiftFilter === 'active' && "🟢 Active Workflow"}
                      {shiftFilter === 'lunch' && "🍱 Lunch Interval"}
                      {shiftFilter === 'meeting' && "🤝 Meeting / Coaching"}
                      {shiftFilter === 'break_tea' && "☕ Tea / Short Break"}
                      {shiftFilter === 'break' && "🟠 All Rest Breaks"}
                      {shiftFilter === 'offline' && "⚪ Offline Staff"}
                    </span>
                    <span className="text-slate-400 text-[10px]">▼</span>
                  </button>

                  {isStatusDropdownOpen && (
                    <div className="absolute left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg z-50 p-1 space-y-0.5 max-h-60 overflow-y-auto animate-in fade-in slide-in-from-top-1 duration-100">
                      {[
                        { val: 'all', label: '🟢 Status: All' },
                        { val: 'active', label: '🟢 Active Workflow' },
                        { val: 'break_tea', label: '☕ Tea / Short Break' },
                        { val: 'lunch', label: '🍱 Lunch Interval' },
                        { val: 'meeting', label: '🤝 Meeting / Coaching' },
                        { val: 'break', label: '🟠 All Rest Breaks' }
                      ].map(opt => (
                        <button
                          key={opt.val}
                          type="button"
                          onClick={() => {
                            setShiftFilter(opt.val);
                            setCurrentPage(1);
                            setIsStatusDropdownOpen(false);
                          }}
                          className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md font-bold transition-all ${
                            shiftFilter === opt.val 
                              ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border-l-2 border-indigo-500' 
                              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {(isManagerOrLead || isTeamLeadOrSME) && (
                  <div className="relative">
                    <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Current Activity Filter</label>
                    <MultiSelectDropdown
                      options={uniqueActiveActivities}
                      selectedValues={selectedActivities}
                      onToggle={(val) => {
                        setSelectedActivities(prev => 
                          prev.includes(val) ? prev.filter(p => p !== val) : [...prev, val]
                        );
                        setCurrentPage(1);
                      }}
                      placeholder="🚀 Activity: All"
                    />
                  </div>
                )}

                {isManagerOrLead && (
                  <div className="relative">
                    <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Location Filter</label>
                    <MultiSelectDropdown
                      options={uniqueLocations}
                      selectedValues={selectedLocations}
                      onToggle={(val) => {
                        setSelectedLocations(prev => 
                          prev.includes(val) ? prev.filter(p => p !== val) : [...prev, val]
                        );
                        setCurrentPage(1);
                      }}
                      placeholder="📍 Location: All"
                    />
                  </div>
                )}

                {['ADMIN', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes((user.role || '').toUpperCase()) ? (
                  <div className="relative">
                    <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Manager Filter</label>
                    <MultiSelectDropdown
                      options={managersList.map(m => m.fullName || m.name || m.employeeName).filter(Boolean) as string[]}
                      selectedValues={selectedManagers}
                      onToggle={(val) => {
                        setSelectedManagers(prev => 
                          prev.includes(val) ? prev.filter(p => p !== val) : [...prev, val]
                        );
                        setCurrentPage(1);
                      }}
                      placeholder="🏢 Managers: All"
                    />
                  </div>
                ) : <div className="hidden"></div>}

                <div className="col-span-2 sm:col-span-1 flex flex-col justify-end">
                  <button 
                    onClick={() => {
                      setSearchTerm('');
                      setSelectedActivities([]);
                      setSelectedLocations([]);
                      setShiftFilter('all');
                      setSelectedTLs([]);
                      setSelectedManagers(() => {
                        const isOnlyManager = ['MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes((user.role || '').toString().toUpperCase());
                        return isOnlyManager ? [user.fullName || user.name] : [];
                      });
                      setCurrentPage(1);
                    }}
                    className="bg-slate-200 hover:bg-slate-300 text-slate-700 py-2.5 rounded-lg font-bold transition-all cursor-pointer"
                  >
                    Clear Filter
                  </button>
                </div>
              </div>
            </div>

            {/* Table layout */}
            <div className="overflow-auto max-h-[650px] border border-slate-150 dark:border-slate-800 rounded-xl scrollbar-thin">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-850 shadow-xs">
                  <tr className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-black text-[9px] uppercase tracking-wider select-none border-b border-slate-200 dark:border-slate-700">
                    <th className="p-4 pl-6 cursor-pointer" onClick={() => { setSortKey('name'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>Employee Name</th>
                    <th className="p-4">Process Mapping</th>
                    <th className="p-4">Location</th>
                    <th className="p-4">Current Activity</th>
                    <th className="p-4">Log In Time</th>
                    <th className="p-4">Device</th>
                    <th className="p-4 cursor-pointer" onClick={() => { setSortKey('productive'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>Productive Duration</th>
                    <th className="p-4">Break Duration</th>
                    <th className="p-4 text-center">Utilization</th>
                    <th className="p-4 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedWorkforce.map((u) => {
                    const live = activeShiftsMap.get(u.uid);
                    const stats = live ? calculateShiftStatsObj(live) : null;

                    const liveActs = live?.activities || [];
                    const lastAct = liveActs.length > 0 ? liveActs[liveActs.length - 1] : null;
                    const currentActivityName = lastAct?.name || (live as any)?.currentActivity || 'In transition';
                    const breakStartTime = lastAct?.startTime || (live as any)?.currentActivityStartTime;

                    return (
                      <React.Fragment key={u.uid}>
                        <tr className="hover:bg-slate-50 transition-colors">
                          <td className="p-4 pl-6">
                            <div className="flex items-center gap-2">
                              <button 
                                onClick={() => setExpandedUserId(prev => prev === u.uid ? null : u.uid)}
                                className="text-slate-400 hover:text-indigo-600 transition-colors p-0.5 rounded cursor-pointer"
                                title="Click to toggle details breakdown"
                              >
                                {expandedUserId === u.uid ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                              
                              {/* Avatar display */}
                              <div className="w-8 h-8 rounded-full overflow-hidden bg-slate-100 flex items-center justify-center font-bold text-[10px] text-slate-500 shrink-0 border border-slate-200 ml-1">
                                {u.photoURL ? (
                                  <img src={u.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                ) : (
                                  u.name.split(' ').map(n => n[0]).slice(0, 2).join('')
                                )}
                              </div>

                              <div className="flex flex-col ml-1">
                                <div 
                                  className="font-extrabold text-slate-900 leading-none cursor-pointer hover:text-indigo-600"
                                  onClick={() => setExpandedUserId(prev => prev === u.uid ? null : u.uid)}
                                >
                                  {u.name}
                                </div>
                                <div className="text-[10px] font-mono text-slate-400 mt-1 leading-none">{u.email}</div>
                              </div>
                            </div>
                          </td>
                          <td className="p-4">
                            <span className="bg-slate-150/60 font-semibold px-2 py-0.5 rounded text-slate-700">{u.process || 'General'}</span>
                          </td>
                          <td className="p-4">
                            <span className="bg-indigo-50 font-bold px-2 py-0.5 rounded text-indigo-700 border border-indigo-200/40">{u.location || 'N/A'}</span>
                          </td>
                          <td className="p-4 font-semibold text-slate-800">
                            {live ? (
                              <div className="flex flex-col gap-0.5">
                                <span>{currentActivityName}</span>
                              </div>
                            ) : <span className="text-slate-400">-</span>}
                          </td>
                          <td className="p-4 text-slate-500 font-mono text-[10px]">
                            {live ? new Date(live.clockInTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : <span className="text-slate-400">Not Clocked</span>}
                          </td>
                          <td className="p-4">
                            {live ? (
                              <div className="flex items-center gap-1.5">
                                {(() => {
                                  const dtype = live.deviceType || (live.clockInDevice === 'mobile' ? 'Mobile' : 'Desktop');
                                  if (dtype === 'Mobile') return <Smartphone size={14} className="text-rose-500 shrink-0" />;
                                  if (dtype === 'Tablet') return <Tablet size={14} className="text-indigo-500 shrink-0" />;
                                  return <Laptop size={14} className="text-sky-500 shrink-0" />;
                                })()}
                                <div className="flex flex-col text-left leading-normal">
                                  <span className="font-bold text-slate-850 dark:text-slate-200 text-[11px]">
                                    {live.deviceType || (live.clockInDevice === 'mobile' ? 'Mobile' : 'Desktop')}
                                  </span>
                                  {live.browser && (
                                    <span className="text-[9px] text-slate-400 dark:text-slate-500 font-bold leading-none font-sans mt-0.5" title={live.os}>
                                      {live.browser} / {live.os || 'Unknown OS'}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-400 font-sans text-xs">-</span>
                            )}
                          </td>
                          <td className="p-4 font-bold text-teal-600 font-mono">
                            {stats ? stats.activeStr : <span className="text-slate-400 font-normal font-sans text-xs">Offline</span>}
                          </td>
                          <td className="p-4 font-bold text-amber-600 font-mono">
                            {stats ? stats.breakStr : <span className="text-slate-400 font-normal font-sans text-xs">00:00:00</span>}
                          </td>
                          <td className="p-4 text-center relative group/util">
                            {stats ? (
                              <>
                                <div 
                                  className="flex flex-col items-center gap-1 cursor-pointer justify-center select-none"
                                  onClick={() => setExpandedUserId(prev => prev === u.uid ? null : u.uid)}
                                >
                                  <span className={`font-mono font-bold text-xs ${
                                    stats.utilization >= 100 ? 'text-emerald-600 dark:text-emerald-400' :
                                    stats.utilization >= 50 ? 'text-indigo-600 dark:text-indigo-400' :
                                    'text-rose-500'
                                  }`}>
                                    {stats.utilization}%
                                  </span>
                                  <span className={`text-[8px] font-black px-1.5 py-px rounded uppercase tracking-wider ${
                                    stats.utilization >= 100 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30' :
                                    stats.utilization >= 50 ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/30' :
                                    'bg-rose-50 text-rose-700 dark:bg-rose-950/30'
                                  }`}>
                                    {stats.utilization >= 100 ? 'Achieved' :
                                     stats.utilization >= 50 ? 'On Track' :
                                     'Below Target'}
                                  </span>
                                </div>

                                {/* Hover Micro-Card Tooltip */}
                                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover/util:block z-30 w-52 p-3 bg-white dark:bg-slate-905 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl animate-in fade-in zoom-in-95 duration-100 text-left">
                                  <div className="space-y-1 text-[11px] font-semibold text-slate-600 dark:text-slate-350">
                                    <div className="flex justify-between border-b border-slate-100 dark:border-slate-800 pb-1 font-black text-slate-800 dark:text-slate-100">
                                      <span>Shift Metric</span>
                                      <span className={stats.utilization >= 100 ? 'text-emerald-650' : stats.utilization >= 50 ? 'text-indigo-650' : 'text-rose-500'}>{stats.utilization}%</span>
                                    </div>
                                    <div className="flex justify-between pt-1">
                                      <span>Productive Time:</span>
                                      <span className="font-mono text-slate-900 dark:text-slate-205">{stats.activeMins.toFixed(1)}m</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span>Total Break Time:</span>
                                      <span className="font-mono text-amber-600 dark:text-amber-450">{(stats.breakMs / 60000).toFixed(1)}m <span className="text-[9px] text-slate-400 font-normal">({stats.breakStr})</span></span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span>Present Threshold:</span>
                                      <span className="font-mono text-slate-500">{stats.threshold}m</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span>Remaining Minutes:</span>
                                      <span className="font-mono text-slate-900 dark:text-slate-205">{stats.remainingMins.toFixed(1)}m</span>
                                    </div>
                                    <div className="flex justify-between border-t border-slate-100 dark:border-slate-800 pt-1 mt-1 font-bold">
                                      <span className="text-slate-700 dark:text-slate-300">Projected Total:</span>
                                      <span className="font-mono text-indigo-600 dark:text-indigo-400">{stats.projectedUtilization}%</span>
                                    </div>
                                  </div>
                                </div>
                              </>
                            ) : (
                              <span className="text-slate-400 font-normal">-</span>
                            )}
                          </td>
                          <td className="p-4 text-center space-x-1.5 shrink-0 flex items-center justify-center">
                            {live && canModifyTarget(u.uid) ? (
                              <button
                                onClick={() => {
                                  setLogoutShiftId(live.id);
                                  setLogoutTargetUid(u.uid);
                                  setLogoutTargetName(u.name);
                                  setLogoutReason('Left without logging out');
                                  setShowForceLogoutConfirm(true);
                                }}
                                className="bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-600 text-[10px] font-extrabold px-2.5 py-1 rounded-lg shrink-0 cursor-pointer"
                              >
                                Force Out
                              </button>
                            ) : (
                              <span className="text-slate-400 font-medium text-xs select-none">No Action</span>
                            )}
                          </td>
                        </tr>
                         {expandedUserId === u.uid && stats && (
                          <tr className="bg-slate-50/70 dark:bg-slate-900/40 border-b border-indigo-50/60 dark:border-slate-800">
                            <td colSpan={8} className="p-4 pl-12">
                              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                                <div>
                                  <span className="text-[10px] text-slate-400 dark:text-slate-500 block uppercase font-bold tracking-wider mb-1">Productive Minutes</span>
                                  <span className="font-mono font-black text-xs text-slate-800 dark:text-slate-200">
                                    {stats.activeMins.toFixed(1)}m <span className="text-[10px] text-slate-400 font-normal">({stats.activeStr})</span>
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[10px] text-slate-400 dark:text-slate-500 block uppercase font-bold tracking-wider mb-1">Total Break Time</span>
                                  <span className="font-mono font-black text-xs text-amber-600 dark:text-amber-400">
                                    {(stats.breakMs / 60000).toFixed(1)}m <span className="text-[10px] text-slate-400 font-normal">({stats.breakStr})</span>
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[10px] text-slate-400 dark:text-slate-500 block uppercase font-bold tracking-wider mb-1">Present Threshold</span>
                                  <span className="font-mono font-bold text-xs text-slate-700 dark:text-slate-300">
                                    {stats.threshold} minutes
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[10px] text-slate-400 dark:text-slate-500 block uppercase font-bold tracking-wider mb-1">Utilization %</span>
                                  <span className={`font-mono font-black text-xs ${
                                    stats.utilization >= 100 ? 'text-emerald-600' :
                                    stats.utilization >= 50 ? 'text-indigo-600' :
                                    'text-rose-500'
                                  }`}>
                                    {stats.utilization}%
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[10px] text-slate-400 dark:text-slate-500 block uppercase font-bold tracking-wider mb-1">Remaining Time</span>
                                  <span className="font-mono font-bold text-xs text-slate-705 dark:text-slate-300">
                                    {stats.remainingMins.toFixed(1)} mins
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[10px] text-slate-400 dark:text-slate-500 block uppercase font-bold tracking-wider mb-1">Projected End-of-Shift</span>
                                  <span className="font-mono font-black text-xs text-indigo-600 dark:text-indigo-455">
                                    {stats.projectedUtilization}%
                                  </span>
                                </div>
                              </div>

                              {/* Temporary Device Diagnostics Saved Info for Active Live session */}
                              {/* REMOVED as requested */}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}

                  {paginatedWorkforce.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-16 text-center text-slate-400 font-medium font-sans">
                        <UserX size={44} className="mx-auto text-slate-200 mb-2" />
                        No supervised workforce accounts found matching currently selected criteria.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            <div className="p-4 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-4 flex-wrap">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Page {currentPage} of {totalPages || 1} ({filteredWorkforce.length} visible users)
                </span>
                
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-400 dark:text-slate-500 font-medium">Show:</span>
                  <select
                    value={itemsPerPage}
                    onChange={(e) => {
                      const newSize = Number(e.target.value);
                      setItemsPerPage(newSize);
                      setCurrentPage(1); // Reset to page 1 on resize
                    }}
                    className="text-xs font-semibold bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded px-2 py-1 text-slate-700 dark:text-slate-300 outline-none cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <button 
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer transition-colors text-slate-600 dark:text-slate-400"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button 
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer transition-colors text-slate-600 dark:text-slate-400"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}

            </div>

          </div>
        )}

      </div>

      {/* MODAL: INVESTIGATE MOBILE LOGS */}
      {showInvestigateModal && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 text-slate-800 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-lg p-6 border border-slate-200 dark:border-slate-800 shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b pb-3.5">
              <h3 className="font-extrabold text-slate-900 dark:text-slate-100">Mobile Log Investigation</h3>
              <button onClick={() => setShowInvestigateModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <div className="max-h-96 overflow-y-auto space-y-2">
              {(() => {
                const allMobileEvents: any[] = [];
                selectedInvestigateLogs.forEach(log => {
                  const events = getMobileEvents(log);
                  allMobileEvents.push(...events);
                });
                
                if (allMobileEvents.length === 0) {
                  return (
                    <div className="text-center py-6 text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">
                      No mobile events recorded in this segment
                    </div>
                  );
                }
                
                return allMobileEvents.map((evt: any, idx: number) => {
                  const dateStr = evt.timestamp ? new Date(evt.timestamp).toLocaleString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  }) : 'N/A';
                  
                  return (
                    <div key={idx} className="bg-fuchsia-500/5 dark:bg-fuchsia-950/20 p-3 rounded-lg border border-fuchsia-500/10 text-xs flex justify-between items-center text-slate-800 dark:text-slate-100 dark:border-slate-800">
                      <div>
                        <div className="font-extrabold flex items-center gap-1.5">
                          <Smartphone size={12} className="text-fuchsia-500 shrink-0" />
                          {evt.name}
                        </div>
                        <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500 mt-1 block">
                          {dateStr}
                        </span>
                      </div>
                      <span className="bg-fuchsia-100 dark:bg-fuchsia-950/60 text-fuchsia-700 dark:text-fuchsia-400 text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider select-none shrink-0">
                        Mobile
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
            <button onClick={() => setShowInvestigateModal(false)} className="w-full bg-slate-900 text-white py-2 rounded-xl text-xs font-bold">Close</button>
          </div>
        </div>
      )}

      {/* MODAL 2: CONFIRM FORCE LOGOUT */}
      {showForceLogoutConfirm && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 text-slate-800 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 border border-slate-200 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 border-b pb-3.5">
              <div className="p-2.5 bg-rose-50 text-rose-600 rounded-xl">
                <AlertTriangle size={20} className="animate-pulse" />
              </div>
              <div className="text-left">
                <h4 className="font-extrabold text-slate-900 text-sm">Terminate Active User Session</h4>
                <p className="text-slate-450 text-[10px] font-bold">Terminate session remotely for {logoutTargetName}</p>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-slate-500 font-medium">
              This instruction will immediately terminate the target employee's active shift segment in Firestore, recording present UTC/Asia as Clock Out time.
            </p>

            <div className="space-y-1.5 text-left text-xs font-bold text-slate-600">
              <label className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Select Termination Reason</label>
              <select
                value={logoutReason}
                onChange={(e) => setLogoutReason(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs font-bold cursor-pointer focus:outline-none text-slate-800"
              >
                <option value="Left without logging out">Left without logging out</option>
                <option value="Inactive for shift length exceeds limits">Inactive for shift length exceeds limits</option>
                <option value="Operational shift scheduling update">Operational shift scheduling update</option>
                <option value="System maintenance protocol termination">System maintenance protocol termination</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
              <button
                onClick={() => setShowForceLogoutConfirm(false)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-705 py-2.5 rounded-xl font-bold font-sans cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeSupervisorClockOut}
                className="bg-rose-600 hover:bg-rose-700 text-white py-2.5 rounded-xl font-black cursor-pointer transition-colors"
              >
                Force Close Session
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 5: BULK FORCE LOGOUT CONFIRMATION */}
      {showBulkLogoutModal && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 text-slate-800 animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl w-full max-w-md p-8 border border-slate-200 shadow-2xl space-y-6 text-center">
            <div className="w-20 h-20 bg-rose-50 text-rose-600 rounded-full flex items-center justify-center mx-auto mb-2 shadow-sm animate-bounce-slow">
              <UserX size={40} />
            </div>
            
            <div className="space-y-2">
              <h4 className="text-2xl font-black text-slate-900 uppercase tracking-tight">Bulk Force Logout</h4>
              <p className="text-slate-500 text-sm font-medium">
                You are about to forcefully terminate <span className="text-rose-600 font-black">{activeShifts.length} active sessions</span>. This action cannot be undone and will immediately move all users to OFFLINE status.
              </p>
            </div>

            <div className="flex flex-col gap-3 pt-2">
              <button 
                onClick={executeBulkForceLogout}
                disabled={isBulkLoggingOut || activeShifts.length === 0}
                className="w-full py-4 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white font-black text-sm transition-all uppercase tracking-widest shadow-lg shadow-rose-200 flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
              >
                {isBulkLoggingOut ? <RefreshCw size={18} className="animate-spin" /> : <Shield size={18} />}
                Confirm Emergency Logout
              </button>
              <button 
                onClick={() => setShowBulkLogoutModal(false)}
                className="w-full py-4 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-xs transition-all uppercase tracking-widest cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: ENHANCED EXPORT REPORT */}
      {showEnhancedExportModal && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 text-slate-800 animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl w-full max-w-lg p-8 border border-slate-200 shadow-2xl space-y-6">
            <div className="flex items-center gap-4 border-b pb-5">
              <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center shadow-sm">
                <FileSpreadsheet size={28} />
              </div>
              <div className="text-left">
                <h4 className="font-black text-slate-900 text-lg leading-tight uppercase tracking-tight">Export Team Report</h4>
                <p className="text-slate-500 text-xs font-medium">Specify date range and filter criteria for generated intelligence reports</p>
              </div>
            </div>

            <div className="space-y-5 text-left">
              {/* Date Range Preset */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest">Date Range Preset</label>
                <select
                  value={exportRangePreset}
                  onChange={(e) => setExportRangePreset(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer text-slate-800 transition-all"
                >
                  <option value="1">Today</option>
                  <option value="7">Last 7 Days</option>
                  <option value="15">Last 15 Days</option>
                  <option value="30">Last 30 Days (Default)</option>
                  <option value="custom">Custom Date Range</option>
                </select>
              </div>

              {exportRangePreset === 'custom' && (
                <div className="grid grid-cols-2 gap-4 animate-in slide-in-from-top-2 duration-200">
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest">Start Date</label>
                    <input 
                      type="date"
                      value={exportCustomStart}
                      onChange={(e) => setExportCustomStart(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest">End Date</label>
                    <input 
                      type="date"
                      value={exportCustomEnd}
                      onChange={(e) => setExportCustomEnd(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  </div>
                </div>
              )}

              {/* File Format */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest">File Format</label>
                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => setExportFormat('excel')}
                    className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 transition-all cursor-pointer ${exportFormat === 'excel' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-100 bg-slate-50 text-slate-400 hover:border-slate-200'}`}
                  >
                    <div className={`w-2 h-2 rounded-full ${exportFormat === 'excel' ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span className="text-xs font-black">Excel (.xlsx)</span>
                  </button>
                  <button 
                    onClick={() => setExportFormat('csv')}
                    className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 transition-all cursor-pointer ${exportFormat === 'csv' ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-100 bg-slate-50 text-slate-400 hover:border-slate-200'}`}
                  >
                    <div className={`w-2 h-2 rounded-full ${exportFormat === 'csv' ? 'bg-sky-500' : 'bg-slate-300'}`} />
                    <span className="text-xs font-black">CSV (.csv)</span>
                  </button>
                </div>
              </div>

              {/* Report Type */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest">Report Type</label>
                <select
                  value={exportReportType}
                  onChange={(e) => setExportReportType(e.target.value as any)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer text-slate-800 transition-all border-l-4 border-l-indigo-500"
                >
                  <option value="summary">Utilization Summary Report</option>
                  <option value="chrono">Detailed Chronological Activity Log (Breaks & Switches)</option>
                  <option value="both">Both Reports (Separate Sheets)</option>
                </select>
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <button 
                onClick={() => setShowEnhancedExportModal(false)}
                className="flex-1 py-4 px-6 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-xs transition-all uppercase tracking-widest cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={executeEnhancedExport}
                disabled={isExporting}
                className="flex-[2] py-4 px-6 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs transition-all uppercase tracking-widest shadow-lg shadow-indigo-200 flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
              >
                {isExporting ? <RefreshCw size={14} className="animate-spin" /> : <FileSpreadsheet size={16} />}
                {isExporting ? 'Generating...' : 'Confirm & Export'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Supervisor Clock-In Confirmation Overlay Modal */}
      {showSuperClockInConfirm && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 space-y-5 text-left">
            <div className="flex items-center gap-4 text-emerald-600 border-b border-slate-50 pb-4">
              <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
                <Clock size={24} />
              </div>
              <div className="flex-1">
                <h4 className="font-black text-slate-900 text-sm uppercase tracking-tight">Supervisor Shift Start</h4>
                <p className="text-slate-500 text-[10px] font-bold mt-0.5 leading-tight">Verification required before punch</p>
              </div>
            </div>
            
            <div className="space-y-2">
              <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest block">Choose Process</label>
              <select
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-800 transition-all cursor-pointer"
                value={superSelectedProcess}
                onChange={(e) => setSuperSelectedProcess(e.target.value)}
              >
                {supervisorProcesses.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <button 
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-emerald-100 flex items-center justify-center gap-2 cursor-pointer transition-colors"
                onClick={() => performSuperClockIn(superSelectedProcess)}
              >
                <Play size={14} />
                CONFIRM & START SHIFT
              </button>
              <button 
                className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors"
                onClick={() => setShowSuperClockInConfirm(false)}
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Supervisor Clock-Out Confirmation Overlay Modal */}
      {showSuperClockOutConfirm && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 space-y-4 text-left">
            <div className="flex items-center gap-3 text-red-600">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <AlertCircle size={20} />
              </div>
              <div className="text-left">
                <h4 className="font-bold text-slate-900 text-sm">Clock Out Confirmation</h4>
                <p className="text-slate-500 text-xs mt-1">Are you sure you want to Clock Out and finalise your shift logs?</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 text-xs font-bold pt-2 border-t">
              <button 
                onClick={() => setShowSuperClockOutConfirm(false)} 
                className="px-4 py-2 hover:bg-slate-50 text-slate-500 font-bold rounded-lg cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button 
                className="bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-2 rounded-lg cursor-pointer transition-colors" 
                onClick={() => {
                  setShowSuperClockOutConfirm(false);
                  performSuperClockOut();
                }}
              >
                Confirm Clock Out
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
