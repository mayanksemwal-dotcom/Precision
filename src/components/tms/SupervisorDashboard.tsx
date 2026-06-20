import React, { useState, useEffect, useMemo } from 'react';
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
  Tablet
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
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
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
  onSnapshot
} from 'firebase/firestore';
import { UserProfile, UserRole } from '../../types';
import { toast } from 'sonner';
import { canActOn } from '../../lib/hierarchy';
import { usePermission } from '../PermissionContext';
import { MultiSelectDropdown } from '../ui/multi-select';
import * as XLSX from 'xlsx';
import { getManagerOfManager, getShiftProductiveMs, truncateShiftToProductiveTime, getDeviceType } from '../../views/TMSView';
import { getLiveTime, getLiveTimeISO } from '../../lib/timeSync';

interface SupervisorDashboardProps {
  user: UserProfile;
  allUsers: UserProfile[];
  onRefreshAllData?: () => void;
  externalTheme?: 'light' | 'dark';
}

interface ShiftActivity {
  type: 'productive' | 'break';
  name: string;
  startTime: string;
  endTime?: string;
}

interface TMSShift {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  mappedTL?: string;
  mappedManager?: string;
  clockInTime: string;
  clockOutTime?: string;
  activities: ShiftActivity[];
  status: 'ACTIVE' | 'BREAK' | 'COMPLETED' | 'AUTO_CLOSED';
  clockInDevice?: string;
  clockOutDevice?: string;
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

export default function SupervisorDashboard({ user, allUsers, onRefreshAllData, externalTheme }: SupervisorDashboardProps) {
  const { hasTmsPermission } = usePermission();
  const isDark = document.documentElement.classList.contains('dark') || externalTheme === 'dark';
  
  // Tab control
  const [activeTab, setActiveTab] = useState<'monitoring' | 'controls' | 'exceptions' | 'hierarchy'>('monitoring');
  
  // Real-time active shifts & audit logs status loaded locally for performance
  const [activeShifts, setActiveShifts] = useState<TMSShift[]>([]);
  const [isLoadingShifts, setIsLoadingShifts] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [countdown, setCountdown] = useState(20); // 20 seconds quick refresh cycle
  const [presentThreshold, setPresentThreshold] = useState<number>(480);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  // Subscribe to attendance config
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'config', 'attendanceSettings'), (snap) => {
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

  // Filters state for control table
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProcesses, setSelectedProcesses] = useState<string[]>([]);
  const [shiftFilter, setShiftFilter] = useState('all'); // all, active, break, offline
  const [selectedTLs, setSelectedTLs] = useState<string[]>([]);
  const [selectedManagers, setSelectedManagers] = useState<string[]>(() => {
    const isOnlyManager = (user.role || '').toString().toUpperCase() === 'MANAGER';
    return isOnlyManager ? [user.fullName || user.name] : [];
  });
  const [sortKey, setSortKey] = useState<'name' | 'productive' | 'status'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);

  // Modals / Actions states
  const [isExporting, setIsExporting] = useState(false);
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [adminLogs, setAdminLogs] = useState<any[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);

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

  // Supervisor personal shift timers
  const [elapsedActive, setElapsedActive] = useState('00:00:00');
  const [elapsedBreak, setElapsedBreak] = useState('00:00:00');
  const [elapsedShift, setElapsedShift] = useState('00:00:00');

  useEffect(() => {
    const myShift = activeShifts.find(s => s.userId === user.uid);
    if (!myShift) {
      setElapsedActive('00:00:00');
      setElapsedBreak('00:00:00');
      setElapsedShift('00:00:00');
      return;
    }

    const interval = setInterval(() => {
      const startMs = new Date(myShift.clockInTime).getTime();
      const now = getLiveTime().getTime();
      const totalShiftMs = Math.max(0, now - startMs);

      setElapsedShift(formatMs(totalShiftMs));

      let activeMs = 0;
      let breakMs = 0;

      (myShift.activities || []).forEach(act => {
        const start = new Date(act.startTime).getTime();
        const end = act.endTime ? new Date(act.endTime).getTime() : now;
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

      setElapsedActive(formatMs(activeMs));
      setElapsedBreak(formatMs(breakMs));
    }, 1000);

    return () => clearInterval(interval);
  }, [activeShifts, user.uid]);
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
    const target = allUsers.find(u => u.uid === targetUid);
    if (!target) return false;

    // Check if the current user has TL profile or is manager/admin
    const roleNormalized = (user.role || '').toUpperCase();
    const isTL = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL'].includes(roleNormalized);
    const isManagerOrAdmin = ['ADMIN', 'MANAGER'].includes(roleNormalized);

    // Allow TLs to force-out users of other team members
    if (isTL || isManagerOrAdmin) {
      const targetRole = (target.role || '').toUpperCase();
      const isTargetHigher = ['ADMIN', 'MANAGER'].includes(targetRole);
      if (isTargetHigher && !isManagerOrAdmin) {
        return false;
      }
      return true;
    }

    return canActOn(user, target, allUsers);
  };

  // Mapped list of supervised agents based on hierarchy
  const mappedUsers = useMemo(() => {
    // ADMIN and MANAGER can see organization-wide; other roles filter by team hierarchy
    const roleNormalized = (user.role || '').toUpperCase();
    const isManagerOrAdmin = ['ADMIN', 'MANAGER'].includes(roleNormalized);
    const isTeamLeadOrSupervisor = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL'].includes(roleNormalized);
    
    // Status normalization (only filter out deactivated/inactive accounts, so offline agents show up in roster)
    const isActive = (u: UserProfile) => {
      const s = (u.status || '').toLowerCase();
      return s !== 'inactive';
    };

    if (isManagerOrAdmin) {
      if (selectedTLs.length > 0) {
        return allUsers.filter(u => isActive(u) && (
          selectedTLs.includes(u.teamLeadName || '') || 
          selectedTLs.includes(u.teamLeadId || '') || 
          selectedTLs.includes(u.name) || 
          selectedTLs.includes(u.fullName || '') || 
          selectedTLs.includes(u.uid)
        ));
      }
      return allUsers.filter(u => isActive(u));
    } else if (isTeamLeadOrSupervisor) {
      // If specific Team Leads are selected, show resources belonging to those Team Leads, plus themselves
      if (selectedTLs.length > 0) {
        return allUsers.filter(u => isActive(u) && (
          selectedTLs.includes(u.teamLeadName || '') || 
          selectedTLs.includes(u.teamLeadId || '') || 
          selectedTLs.includes(u.uid) ||
          selectedTLs.includes(u.name) ||
          selectedTLs.includes(u.fullName || '') ||
          (u.teamLeadEmail && selectedTLs.some(st => u.teamLeadEmail.toLowerCase() === st.toLowerCase())) ||
          (u.email && selectedTLs.some(st => u.email.toLowerCase() === st.toLowerCase()))
        ));
      }
      // By default, fallback to their own mapped resources, plus themselves so they see their own status & attendance
      return allUsers.filter(u => isActive(u) && (u.uid === user.uid || canActOn(user, u, allUsers)));
    }
    return allUsers.filter(u => isActive(u) && (u.uid === user.uid || canActOn(user, u, allUsers)));
  }, [allUsers, user, selectedTLs]);

  // Keep a ref of the latest mappedUsers and dependencies so the snapshot closure doesn't become stale
  const mappedUsersRef = React.useRef(mappedUsers);
  const allUsersRef = React.useRef(allUsers);
  
  // Performance optimization: cache today's shift query results during massive real-time ticks
  const lastTodayShiftsFetchTimeRef = React.useRef<number>(0);
  const cachedTodayShiftsRef = React.useRef<any[]>([]);

  useEffect(() => {
    mappedUsersRef.current = mappedUsers;
    allUsersRef.current = allUsers;
  }, [mappedUsers, allUsers]);

  // List of unique Team Leads who have members in mappedUsers or have a TL role
  const teamLeadsList = useMemo(() => {
    const leads = new Map<string, { name: string; role: string }>();
    
    // 1. Add anyone explicitly referenced as a team lead in any active user's profile
    allUsers.forEach(u => {
      if (u.teamLeadId && u.teamLeadName) {
        // Find their actual role if exists, otherwise fallback to 'TEAM_LEAD'
        const tlObj = allUsers.find(candidate => candidate.uid === u.teamLeadId);
        const roleStr = tlObj ? (tlObj.role || 'TEAM_LEAD') : 'TEAM_LEAD';
        leads.set(u.teamLeadId, { name: u.teamLeadName, role: String(roleStr) });
      }
    });

    // 2. Add anyone who holds a Team Lead/Supervisor-like role and has status = 'Active'
    const tlRoles = ['TEAM_LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM LEAD', 'OPS TL', 'TRAINER TL'];
    allUsers.forEach(u => {
      const roleUpper = (u.role || '').toString().toUpperCase().trim();
      if (u.status === 'Active' && tlRoles.includes(roleUpper)) {
        const tlName = u.fullName || u.name || u.employeeName;
        if (tlName) {
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
  }, [allUsers, user.uid]);

  // List of unique Managers
  const managersList = useMemo(() => {
    return allUsers.filter(u => {
      const roleUpper = (u.role || '').toString().toUpperCase().trim();
      return roleUpper === 'MANAGER' || roleUpper === 'ADMIN';
    });
  }, [allUsers]);


  // Read summary metrics or trigger recalculation when necessary
  const [summaryData, setSummaryData] = useState<any>(null);

  // Function to calculate durations from millseconds
  const formatMs = (ms: number): string => {
    if (ms <= 0 || isNaN(ms)) return '00:00:00';
    const totalSecs = Math.floor(ms / 1000);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Core Shift math calculations
  const calculateShiftStatsObj = (shift: TMSShift) => {
    const endMs = shift.clockOutTime 
      ? new Date(shift.clockOutTime).getTime() 
      : new Date().getTime();
    const startMs = new Date(shift.clockInTime).getTime();
    const totalShiftMs = Math.max(0, endMs - startMs);
    
    let activeMs = 0;
    let breakMs = 0;

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

  // FETCH & AGGREGATE CORE - Minimal reads & in-memory synced architecture
  const loadAndRecomputeData = async (forceRecalculate = false, externalSnapshot?: any) => {
    const currentAllUsers = allUsersRef.current;
    const currentMappedUsers = mappedUsersRef.current;
    
    if (!currentAllUsers || currentAllUsers.length === 0) {
      console.log('Skipping recomputation as allUsers roster is not yet ready');
      return;
    }
    setIsLoadingShifts(true);
    try {
      // Perform optimized fetch of ONLY active shifts
      let allActiveShifts: TMSShift[] = [];
      
      if (externalSnapshot) {
        allActiveShifts = externalSnapshot.docs.map((d: any) => ({ id: d.id, ...d.data() } as TMSShift));
      } else {
        // Fetch all active shifts to ensure supervisor can see their own status and team's status
        const activeShiftsQuery = query(collection(db, 'tmsShifts'), where('status', 'in', ['ACTIVE', 'BREAK']));
        const snapshot = await getDocs(activeShiftsQuery);
        allActiveShifts = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as TMSShift));
      }

      // Filter active shifts matching the team scope OR the current supervisor's own shift
      const scopeIds = new Set(currentMappedUsers.map(u => u.uid));
      const teamActiveShiftsRaw = allActiveShifts.filter(sh => scopeIds.has(sh.userId) || sh.userId === user.uid);

      // Group active shifts by userId to identify and heal duplicates
      const shiftsByUser: { [userId: string]: TMSShift[] } = {};
      teamActiveShiftsRaw.forEach(sh => {
        if (!shiftsByUser[sh.userId]) {
          shiftsByUser[sh.userId] = [];
        }
        shiftsByUser[sh.userId].push(sh);
      });

      const teamActiveShifts: TMSShift[] = [];
      const duplicateCloses: TMSShift[] = [];
      const autoClockOuts: TMSShift[] = [];

      Object.entries(shiftsByUser).forEach(([userId, userShifts]) => {
        let primaryShift: TMSShift;
        if (userShifts.length > 1) {
          userShifts.sort((a, b) => new Date(b.clockInTime).getTime() - new Date(a.clockInTime).getTime());
          primaryShift = userShifts[0];
          for (let i = 1; i < userShifts.length; i++) {
            duplicateCloses.push(userShifts[i]);
          }
        } else {
          primaryShift = userShifts[0];
        }

        const referenceTime = new Date().getTime();
        const activeProductiveMs = getShiftProductiveMs(primaryShift as any, referenceTime);
        const TEN_HOURS_MS = 10 * 60 * 60 * 1000;

        if (activeProductiveMs >= TEN_HOURS_MS) {
          autoClockOuts.push(primaryShift);
        } else {
          teamActiveShifts.push(primaryShift);
        }
      });

      // Heal the database synchronously by batch-closing older duplicates / 10h productive limit exceeders
      if (duplicateCloses.length > 0 || autoClockOuts.length > 0) {
        console.warn(`[DATA HEAL] Found duplicate shifts (${duplicateCloses.length}) and/or expired 10h productive shifts (${autoClockOuts.length}). Updating in Firestore...`);
        const healBatch = writeBatch(db);
        const healNowISO = new Date().toISOString();
        
        duplicateCloses.forEach(sh => {
          const updatedActivities = [...(sh.activities || [])];
          if (updatedActivities.length > 0) {
            const lastIndex = updatedActivities.length - 1;
            if (!updatedActivities[lastIndex].endTime) {
              updatedActivities[lastIndex].endTime = healNowISO;
            }
          }
          healBatch.set(doc(db, 'tmsShifts', sh.id), {
            ...sh,
            activities: updatedActivities,
            status: 'AUTO_CLOSED',
            clockOutTime: healNowISO,
            remarks: 'System Auto-Resolved Duplicate Active Shift (Supervisor Healing)'
          });
        });

        autoClockOuts.forEach(sh => {
          const TEN_HOURS_MS = 10 * 60 * 60 * 1000;
          const { activities: updatedActivities, clockOutTime } = truncateShiftToProductiveTime(sh as any, TEN_HOURS_MS);
          healBatch.set(doc(db, 'tmsShifts', sh.id), {
            ...sh,
            activities: updatedActivities,
            status: 'AUTO_CLOSED',
            clockOutTime,
            remarks: 'Auto-clocked out after 10 hours productive time'
          });

          const userRef = doc(db, 'users', sh.userId);
          healBatch.update(userRef, {
            status: 'OFFLINE',
            lastLogoutAt: clockOutTime
          });
        });

        await healBatch.commit().catch(err => console.error('Error healing active shifts:', err));
      }

      setActiveShifts(teamActiveShifts);

      // Timezone-safe daily shifts retrieval with aggressive performance caching (20s) to fix lag issues
      let todayShifts: any[] = [];
      const currentTimestampMs = Date.now();
      const CACHE_EXPIRY_MS = 20000;
      
      const isCacheValid = cachedTodayShiftsRef.current.length > 0 && 
                           (currentTimestampMs - lastTodayShiftsFetchTimeRef.current < CACHE_EXPIRY_MS) && 
                           !forceRecalculate;

      if (isCacheValid) {
        todayShifts = cachedTodayShiftsRef.current;
      } else {
        // Go back 30 hours to safely cover any possible timezone skew (UTC offset overlap)
        const startOfTodayQuery = new Date(currentTimestampMs - 30 * 60 * 60 * 1000);
        const todayShiftsQuery = query(
          collection(db, 'tmsShifts'),
          where('clockInTime', '>=', startOfTodayQuery.toISOString())
        );
        const todayShiftsSnapshot = await getDocs(todayShiftsQuery);
        
        // Filter in memory for supervisor's current calendar day (same local date) OR within last 24 hours
        const nowLocalDateStr = new Date().toDateString();
        todayShifts = todayShiftsSnapshot.docs
          .map(d => ({ id: d.id, ...d.data() } as any))
          .filter(sh => {
            if (!scopeIds.has(sh.userId)) return false;
            const shiftLocalDateStr = new Date(sh.clockInTime).toDateString();
            const isTodayLocal = shiftLocalDateStr === nowLocalDateStr;
            const within24h = (currentTimestampMs - new Date(sh.clockInTime).getTime()) < 24 * 60 * 60 * 1000;
            return isTodayLocal || within24h;
          });
          
        cachedTodayShiftsRef.current = todayShifts;
        lastTodayShiftsFetchTimeRef.current = currentTimestampMs;
      }

      const teamAutoClosed = todayShifts.filter(sh => sh.status === 'AUTO_CLOSED' && (sh.remarks?.includes('10 hours') || sh.remarks?.includes('10H') || sh.remarks?.includes('10-Hour')));

      // Compute statistics and variables in memory without database scans
      const totalAssigned = currentMappedUsers.length;
      const loggedInCount = teamActiveShifts.length;
      const onBreakCount = teamActiveShifts.filter(s => s.status === 'BREAK').length;
      const activeSessionsCount = teamActiveShifts.filter(s => s.status === 'ACTIVE').length;
      const offlineCount = Math.max(0, totalAssigned - loggedInCount);
      const attendancePercent = totalAssigned > 0 ? Math.round((loggedInCount / totalAssigned) * 100) : 0;

      // Group workforce distribution categories
      let lunchCount = 0;
      let meetingCount = 0;
      let otherBreakCount = 0;

      teamActiveShifts.forEach(sh => {
        if (sh.status === 'BREAK') {
          const shActs = sh.activities || [];
          const lastActivity = shActs.length > 0 ? shActs[shActs.length - 1]?.name || '' : '';
          if (lastActivity.toLowerCase().includes('lunch')) {
            lunchCount++;
          } else if (lastActivity.toLowerCase().includes('meeting') || lastActivity.toLowerCase().includes('coaching') || lastActivity.toLowerCase().includes('training') || lastActivity.toLowerCase().includes('alignment')) {
            meetingCount++;
          } else {
            otherBreakCount++;
          }
        }
      });

      // Audit and Validation diagnostics calculations
      const nowMs = new Date().getTime();
      const bioBreaks: any[] = [];
      const lunchBreaks: any[] = [];
      const shortBreaks: any[] = [];
      const mobilePunchesList: any[] = [];

      // 1. Calculate segmented break exceptions from teamActiveShifts
      teamActiveShifts.forEach(sh => {
        const clockInMs = new Date(sh.clockInTime).getTime();
        const shActs = sh.activities || [];
        const lastActObj = shActs.length > 0 ? shActs[shActs.length - 1] : null;
        const lastActTime = lastActObj ? new Date(lastActObj.startTime).getTime() : clockInMs;

        if (sh.status === 'BREAK' && lastActObj && !lastActObj.endTime) {
          const breakDurationMins = (nowMs - lastActTime) / (60 * 1000);
          const breakNameLower = (lastActObj.name || '').toLowerCase();
          const durationMins = Math.round(breakDurationMins);

          const exceptionItem = {
            userId: sh.userId,
            userName: sh.userName,
            email: sh.userEmail,
            breakName: lastActObj.name,
            startTime: lastActObj.startTime,
            durationMins,
            shiftId: sh.id
          };

          if (breakNameLower.includes('bio')) {
            if (breakDurationMins > 5) {
              bioBreaks.push(exceptionItem);
            }
          } else if (breakNameLower.includes('lunch') || breakNameLower.includes('dinner') || breakNameLower.includes('meal')) {
            if (breakDurationMins > 45) {
              lunchBreaks.push(exceptionItem);
            }
          } else {
            if (breakDurationMins > 20) {
              shortBreaks.push(exceptionItem);
            }
          }
        }
      });

      // 2. Scan today's shifts for used mobile punches
      todayShifts.forEach(sh => {
        const hasMobile = sh.hasMobilePunches === true || 
                          sh.clockInDevice === 'mobile' || 
                          sh.clockOutDevice === 'mobile' || 
                          (sh.activities || []).some((act: any) => act.device === 'mobile');
        if (hasMobile) {
          const mobilePunchesCount = (sh.clockInDevice === 'mobile' ? 1 : 0) + 
                                     (sh.clockOutDevice === 'mobile' ? 1 : 0) + 
                                     (sh.activities || []).filter((act: any) => act.device === 'mobile').length;
          
          mobilePunchesList.push({
            userId: sh.userId,
            userName: sh.userName,
            email: sh.userEmail,
            shiftId: sh.id,
            clockInTime: sh.clockInTime,
            status: sh.status,
            mobilePunchesCount,
            activities: sh.activities || [],
            clockInDevice: sh.clockInDevice,
            clockOutDevice: sh.clockOutDevice
          });
        }
      });

      // Team Inconsistencies Scan
      const inconsistencies: any[] = [];
      currentMappedUsers.forEach(u => {
        if (!u.teamLeadId && u.role === 'AGENT') {
          inconsistencies.push({
            userId: u.uid,
            userName: u.name,
            issue: 'Missing designated Team Lead alignment'
          });
        }
      });

      // Attendance Exceptions (scheduled but no shifts today)
      const clockedAgentIds = new Set(teamActiveShifts.map(s => s.userId));
      const attendanceExceptions: any[] = [];
      currentMappedUsers.forEach(u => {
        if (!clockedAgentIds.has(u.uid) && !teamAutoClosed.some(c => c.userId === u.uid)) {
          attendanceExceptions.push({
            userId: u.uid,
            userName: u.name,
            email: u.email,
            reason: 'Resource has not reported/clocked-in today'
          });
        }
      });


      // Counts discrepancies
      const countMismatches: any[] = [];
      const actualActiveInDb = teamActiveShifts.filter(s => s.status === 'ACTIVE').length;
      if (activeSessionsCount !== actualActiveInDb) {
        countMismatches.push({
          metric: 'Active Sessions count',
          systemValue: activeSessionsCount,
          actualValue: actualActiveInDb
        });
      }

      // Compiled local summary block
      const computedSummary = {
        lastUpdated: new Date().toISOString(),
        totalAssigned,
        loggedInCount,
        activeCount: activeSessionsCount,
        onBreakCount,
        offlineCount,
        attendancePercent,
        activeSessionsCount,
        distribution: {
          active: activeSessionsCount,
          break: otherBreakCount,
          lunch: lunchCount,
          meeting: meetingCount,
          offline: offlineCount
        },
        exceptionCounts: {
          autoClosed: teamAutoClosed.length,
          attendanceExceptions: attendanceExceptions.length,
          bioBreaks: bioBreaks.length,
          lunchBreaks: lunchBreaks.length,
          shortBreaks: shortBreaks.length,
          mobilePunches: mobilePunchesList.length
        },
        exceptionsList: {
          autoClosed: teamAutoClosed,
          attendanceExceptions,
          bioBreaks,
          lunchBreaks,
          shortBreaks,
          mobilePunches: mobilePunchesList
        },
        validationReport: {
          activeAfterClockOut: [], // Profiles mark as active somewhere but clocked out
          teamInconsistencies: inconsistencies,
          countMismatches
        },
        activeShiftsList: teamActiveShifts
      };

      setSummaryData(computedSummary);
      setLastRefreshed(new Date());

    } catch (err: any) {
      console.error('[SUPERVISOR COMPILATION RECALC FAIL]', err);
      // Log more specific error info if available
      const errorMsg = err?.message || err?.code || 'Unknown Error';
      toast.error(`Failed to run diagnostics and metrics compilation: ${errorMsg}`);
    } finally {
      setIsLoadingShifts(false);
    }
  };

  // Run on mount, and schedule recurring pull when allUsers or selectedTLs changes
  useEffect(() => {
    loadAndRecomputeData(true);
  }, [allUsers, selectedTLs]);

  useEffect(() => {
    if (!user) return;

    // Real-time reactive synchronization for active/break shifts
    const activeShiftsQuery = query(
      collection(db, 'tmsShifts'),
      where('status', 'in', ['ACTIVE', 'BREAK'])
    );

    const unsubscribe = onSnapshot(activeShiftsQuery, (snapshot) => {
      loadAndRecomputeData(false, snapshot);
    }, (error) => {
      console.warn('[REALTIME_SYNC_ERROR]', error);
    });

    return () => unsubscribe();
  }, [user.uid]);

  // Filter & paginate the workforce controls list
  const filteredWorkforce = useMemo(() => {
    return mappedUsers.filter(u => {
      // search
      const matchesSearch = !searchTerm 
        ? true 
        : (u.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
           u.email.toLowerCase().includes(searchTerm.toLowerCase()) || 
           (u.employeeId && u.employeeId.toLowerCase().includes(searchTerm.toLowerCase())));

      if (!matchesSearch) return false;

      // active shift data link
      const liveShift = activeShifts.find(s => s.userId === u.uid);

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
      if (selectedProcesses.length > 0) {
        const uProc = (u.process || '').trim();
        const matchesUserProc = selectedProcesses.includes(uProc);
        
        let matchesLiveProc = false;
        if (liveShift) {
          const liveShiftActs = liveShift.activities || [];
          const currentProc = liveShiftActs.length > 0 ? liveShiftActs[liveShiftActs.length - 1]?.name || '' : '';
          matchesLiveProc = selectedProcesses.includes(currentProc);
        }
        
        if (!matchesUserProc && !matchesLiveProc) {
          return false;
        }
      }

      // TL filter
      if (selectedTLs.length > 0) {
        const matchesTL = selectedTLs.includes(u.teamLeadId || '') || 
                         selectedTLs.includes(u.teamLeadName || '') ||
                         (u.teamLeadEmail && selectedTLs.some(st => u.teamLeadEmail.toLowerCase() === st.toLowerCase()));
        if (!matchesTL) return false;
      }

      // Manager filter (robust nested traversal across all possible schema fields)
      if (selectedManagers.length > 0) {
        const checkHierarchy = (uToCheck: UserProfile, visited: Set<string>): boolean => {
          if (!uToCheck) return false;
          
          // Match direct manager name, email or IDs from user fields
          const possibleManagerMatch = 
            selectedManagers.includes(uToCheck.uid) ||
            selectedManagers.includes(uToCheck.managerId || '') ||
            selectedManagers.includes(uToCheck.mappedManagerId || '') ||
            selectedManagers.includes((uToCheck as any).mappedManagerUid || '') ||
            selectedManagers.includes(uToCheck.managerName || '') ||
            selectedManagers.includes(uToCheck.mappedManagerName || '') ||
            selectedManagers.includes(uToCheck.Manager || '') ||
            selectedManagers.includes(uToCheck.fullName || '') ||
            selectedManagers.includes(uToCheck.name || '') ||
            selectedManagers.includes(uToCheck.employeeName || '') ||
            (uToCheck.managerEmail && selectedManagers.some(m => m.toLowerCase() === uToCheck.managerEmail!.toLowerCase())) ||
            (uToCheck.mappedManagerEmail && selectedManagers.some(m => m.toLowerCase() === uToCheck.mappedManagerEmail!.toLowerCase())) ||
            (uToCheck.email && selectedManagers.some(m => m.toLowerCase() === uToCheck.email.toLowerCase()));

          if (possibleManagerMatch) return true;

          if (visited.has(uToCheck.uid)) return false;
          visited.add(uToCheck.uid);
          
          if (uToCheck.teamLeadId) {
            const tl = allUsers.find(usr => usr.uid === uToCheck.teamLeadId);
            if (tl && checkHierarchy(tl, visited)) return true;
          }
          if (uToCheck.managerId) {
            const mgr = allUsers.find(usr => usr.uid === uToCheck.managerId);
            if (mgr && checkHierarchy(mgr, visited)) return true;
          }
          if (uToCheck.mappedManagerId) {
            const mgr = allUsers.find(usr => usr.uid === uToCheck.mappedManagerId);
            if (mgr && checkHierarchy(mgr, visited)) return true;
          }
          if ((uToCheck as any).mappedManagerUid) {
            const mgr = allUsers.find(usr => usr.uid === (uToCheck as any).mappedManagerUid);
            if (mgr && checkHierarchy(mgr, visited)) return true;
          }
          return false;
        };
        if (!checkHierarchy(u, new Set())) return false;
      }

      return true;
    });
  }, [mappedUsers, activeShifts, searchTerm, selectedProcesses, shiftFilter, selectedTLs, selectedManagers]);

  // Sorting
  const sortedWorkforce = useMemo(() => {
    const sorted = [...filteredWorkforce];
    sorted.sort((a,b) => {
      let valA: any = a.name;
      let valB: any = b.name;

      if (sortKey === 'status') {
        const sA = activeShifts.find(s => s.userId === a.uid)?.status || 'OFFLINE';
        const sB = activeShifts.find(s => s.userId === b.uid)?.status || 'OFFLINE';
        valA = sA;
        valB = sB;
      } else if (sortKey === 'productive') {
        const sA = activeShifts.find(s => s.userId === a.uid);
        const sB = activeShifts.find(s => s.userId === b.uid);
        valA = sA ? calculateShiftStatsObj(sA).activeMs : 0;
        valB = sB ? calculateShiftStatsObj(sB).activeMs : 0;
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filteredWorkforce, sortKey, sortOrder, activeShifts]);

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

  const uniqueActiveProcesses = useMemo(() => {
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
  }, [activeShifts]);

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
      loadAndRecomputeData(true);
      if (onRefreshAllData) onRefreshAllData();
    } catch (err) {
      console.error('[FORCE_OUT_FAIL]', err);
      toast.error('Failed to terminate remote session');
    }
  };

  // Fetch log records for audits
  const openAuditLogsModal = async () => {
    setShowLogsModal(true);
    setIsLoadingLogs(true);
    try {
      const snap = await getDocs(collection(db, 'adminAuditLogs'));
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      list.sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setAdminLogs(list.slice(0, 50)); // display top 50
    } catch (err) {
      console.warn('Could not read admin audit trail', err);
    } finally {
      setIsLoadingLogs(false);
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
      const snap = await getDocs(q);
      const shifts = snap.docs.map(d => ({ id: d.id, ...d.data() } as TMSShift));
      
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
          'Emp ID', 'Employee Name', 'Email', 'Role', 'Department', 'Process / Segment', 'Team Lead', 'Manager', 'Manager of Manager',
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
          'Emp ID', 'Employee Name', 'Email', 'Manager of Manager', 'Date', 'Sequence', 'Type', 'Activity', 'Start Time', 'End Time', 'Duration (Min)'
        ];

        const chronoRows: any[] = [];
        teamShifts.forEach(sh => {
          const dateStr = new Date(sh.clockInTime).toLocaleDateString('en-IN');
          const u = allUsers.find(user => 
            user.uid === sh.userId || 
            (user.email && sh.userEmail && user.email.toLowerCase().trim() === sh.userEmail.toLowerCase().trim())
          );
          const empId = u?.employeeId || (u as any).empID || 'N/A';
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
      loadAndRecomputeData(true);
    } catch (err) {
      console.error('Bulk Logout Error:', err);
      toast.error('Failed to perform bulk logout');
    } finally {
      setIsBulkLoggingOut(false);
    }
  };

  // Dynamic live statistics to keep KPI tiles and distribution sync'd with selected filters
  const liveStats = useMemo(() => {
    const total = filteredWorkforce.length;
    const activeShiftList = filteredWorkforce.map(u => activeShifts.find(s => s.userId === u.uid)).filter(Boolean) as TMSShift[];
    const loggedIn = activeShiftList.length;
    const onBreak = activeShiftList.filter(s => s.status === 'BREAK').length;
    const active = activeShiftList.filter(s => s.status === 'ACTIVE').length;
    const offline = Math.max(0, total - loggedIn);
    const attendancePercent = total > 0 ? Math.round((loggedIn / total) * 100) : 0;
    
    // session device tracking parameters
    const activeDesktop = activeShiftList.filter(s => {
      const dtype = s.deviceType || (s.clockInDevice === 'mobile' ? 'Mobile' : 'Desktop');
      return dtype === 'Desktop';
    }).length;

    const activeMobile = activeShiftList.filter(s => {
      const dtype = s.deviceType || (s.clockInDevice === 'mobile' ? 'Mobile' : 'Desktop');
      return dtype === 'Mobile' || dtype === 'Tablet';
    }).length;

    const mobileAccessPercent = loggedIn > 0 ? Math.round((activeMobile / loggedIn) * 100) : 0;

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
  }, [filteredWorkforce, activeShifts, presentThreshold]);

  const liveDistribution = useMemo(() => {
    const total = filteredWorkforce.length || 1;
    const activeShiftList = filteredWorkforce.map(u => activeShifts.find(s => s.userId === u.uid)).filter(Boolean) as TMSShift[];
    
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
  }, [filteredWorkforce, activeShifts]);

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
            <p className="text-xs text-slate-500 dark:text-slate-400 font-sans mt-0.5">Separate controls for monitoring, supervision rosters, exceptions & live statistics.</p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {activeShifts.find(s => s.userId === user.uid) && (
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
            </div>
          )}
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                // Clock-In/Out logic for supervisor
                const myShift = activeShifts.find(s => s.userId === user.uid);
                if (myShift) {
                  // Clock Out logic - Perform standard end of work
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
                    status: 'COMPLETED',
                    clockOutTime: nowISO
                  };
                  
                  setDoc(doc(db, 'tmsShifts', myShiftId), finalShift).then(() => {
                    syncShiftToAttendance(finalShift);
                    toast.success('Shift completed successfully');
                    loadAndRecomputeData(true);
                  });
                } else {
                  // Clock In logic - create new shift record
                  const newShift: Omit<TMSShift, 'id'> = {
                    userId: user.uid,
                    userName: user.name,
                    userEmail: user.email,
                    mappedTL: (user as any).teamLeadEmail || (user as any).mappedTL || 'N/A',
                    mappedManager: (user as any).mappedManagerEmail || (user as any).mappedManager || 'N/A',
                    clockInTime: getLiveTimeISO(),
                    activities: [{ type: 'productive', name: 'Work Start', startTime: getLiveTimeISO() }],
                    status: 'ACTIVE'
                  };
                  addDoc(collection(db, 'tmsShifts'), newShift).then((docRef) => {
                    toast.success('Clocked in successfully');
                    // Optimistic update to UI state
                    const shiftWithId = { ...newShift, id: docRef.id };
                    setActiveShifts(prev => {
                      // Remove any existing for same user just in case
                      const filtered = prev.filter(s => s.userId !== user.uid);
                      return [shiftWithId, ...filtered];
                    });
                    // Refresh data fully
                    setTimeout(() => loadAndRecomputeData(true), 500);
                  }).catch(err => {
                    console.error('Clock-in failed:', err);
                    toast.error('Failed to clock in: ' + err.message);
                  });
                }
              }}
              className={`flex items-center gap-1.5 ${activeShifts.find(s => s.userId === user.uid) ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'} text-white px-3.5 py-1.5 rounded-xl text-xs font-bold cursor-pointer transition-colors`}
            >
              <Clock size={13} />
              <span>{activeShifts.find(s => s.userId === user.uid) ? 'Clock Out' : 'Clock In'}</span>
            </button>
            
            {activeShifts.find(s => s.userId === user.uid) && (
              <button
                onClick={() => {
                  const myShift = activeShifts.find(s => s.userId === user.uid);
                  if (!myShift) return;
                  
                  const nowISO = getLiveTimeISO();
                  const updatedActivities = [...(myShift.activities || [])];
                  const lastActivity = updatedActivities[updatedActivities.length - 1];
                  
                  if (myShift.status === 'ACTIVE') {
                    // Start Break
                    if (lastActivity && !lastActivity.endTime) {
                      lastActivity.endTime = nowISO;
                    }
                    updatedActivities.push({ type: 'break', name: 'Break', startTime: nowISO });
                    setDoc(doc(db, 'tmsShifts', myShift.id), { ...myShift, activities: updatedActivities, status: 'BREAK' })
                      .then(() => { toast.success('Break started'); loadAndRecomputeData(true); });
                  } else if (myShift.status === 'BREAK') {
                    // End Break
                    if (lastActivity && !lastActivity.endTime) {
                      lastActivity.endTime = nowISO;
                    }
                    updatedActivities.push({ type: 'productive', name: 'Work Resumed', startTime: nowISO });
                    setDoc(doc(db, 'tmsShifts', myShift.id), { ...myShift, activities: updatedActivities, status: 'ACTIVE' })
                      .then(() => { toast.success('Break ended'); loadAndRecomputeData(true); });
                  }
                }}
                className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-3.5 py-1.5 rounded-xl text-xs font-bold cursor-pointer transition-colors"
              >
                <Coffee size={13} />
                <span>{activeShifts.find(s => s.userId === user.uid)?.status === 'BREAK' ? 'End Break' : 'Punch Break'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* CORE STATS KPI TILES (TOP SUMMARY CARDS - REACTIVE TO ACTIVE FILTERS) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-250 dark:border-slate-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 leading-none">Total Assigned</span>
          <h3 className="text-xl font-black text-slate-900 dark:text-white mt-0.5">{liveStats.total}</h3>
          <p className="text-[8px] text-slate-500 dark:text-slate-400 font-bold mt-0.5 leading-none">Roster Mapped</p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-emerald-250 dark:border-emerald-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 leading-none">Logged In Now</span>
          <h3 className="text-xl font-black text-emerald-600 dark:text-emerald-400 mt-0.5">{liveStats.loggedIn}</h3>
          <p className="text-[8px] text-emerald-500 dark:text-emerald-500/85 font-bold mt-0.5 leading-none">On-Duty Shifts</p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-amber-250 dark:border-amber-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400 leading-none">On Break</span>
          <h3 className="text-xl font-black text-amber-500 dark:text-amber-400 mt-0.5">{liveStats.onBreak}</h3>
          <p className="text-[8px] text-amber-500 dark:text-amber-500/85 font-bold mt-0.5 leading-none">Rest Periods</p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-250 dark:border-slate-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 leading-none">Offline</span>
          <h3 className="text-xl font-black text-slate-500 dark:text-slate-300 mt-0.5">{liveStats.offline}</h3>
          <p className="text-[8px] text-slate-400 dark:text-slate-500 font-bold mt-0.5 leading-none">Off-Duty staff</p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-sky-250 dark:border-sky-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-sky-600 dark:text-sky-400 leading-none">Attendance %</span>
          <h3 className="text-xl font-black text-sky-600 dark:text-sky-400 mt-0.5">{liveStats.attendancePercent}%</h3>
          <p className="text-[8px] text-sky-500 dark:text-sky-500/85 font-bold mt-0.5 leading-none">Team Rate</p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-teal-250 dark:border-teal-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-teal-600 dark:text-teal-400 leading-none">Team Avg Util</span>
          <h3 className="text-xl font-black text-teal-600 dark:text-teal-400 mt-0.5">{liveStats.teamAvgUtilization}%</h3>
          <p className="text-[8px] text-teal-550 dark:text-teal-500 font-bold mt-0.5 leading-none">Target: {presentThreshold}m</p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-indigo-250 dark:border-indigo-950/30 p-2.5 rounded-xl shadow-xs text-center">
          <span className="text-[9px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-400 leading-none">Active Work</span>
          <h3 className="text-xl font-black text-indigo-600 dark:text-indigo-400 mt-0.5">{liveStats.active}</h3>
          <p className="text-[8px] text-indigo-500 dark:text-indigo-505/85 font-bold mt-0.5 leading-none">Productive Timers</p>
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
          <div className="bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800/80 px-4 py-2.5 rounded-xl text-center shadow-2xs min-w-28 sm:min-w-32">
            <div className="text-[8px] uppercase tracking-wider text-slate-400 font-bold">Active Mobile</div>
            <div className="text-base font-black text-rose-500 font-mono mt-0.5">{liveStats.activeMobile || 0}</div>
          </div>
          <div className="bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800/80 px-4 py-2.5 rounded-xl text-center shadow-2xs min-w-28 sm:min-w-32">
            <div className="text-[8px] uppercase tracking-wider text-slate-400 font-bold">Mobile Access %</div>
            <div className="text-base font-black text-indigo-600 dark:text-indigo-455 font-mono mt-0.5">{liveStats.mobileAccessPercent || 0}%</div>
          </div>
        </div>
      </div>

      {/* DASHBOARD TABS */}
      <div className="flex gap-3 border-b border-slate-200 dark:border-slate-800 pb-2 overflow-x-auto scrollbar-none">
        <button 
          onClick={() => setActiveTab('monitoring')}
          className={`flex flex-col items-start gap-1 px-5 py-3 rounded-xl text-left transition-all cursor-pointer border shadow-sm select-none ${
            activeTab === 'monitoring' 
              ? 'bg-indigo-600 border-indigo-600 text-white dark:bg-indigo-600 dark:border-indigo-600' 
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-850'
          }`}
        >
          <div className="flex items-center gap-1.5 font-black text-xs">
            <Activity size={14} className={activeTab === 'monitoring' ? 'text-white' : 'text-indigo-600'} />
            Workforce Monitoring
          </div>
          <span className={`text-[10px] font-medium ${activeTab === 'monitoring' ? 'text-indigo-100' : 'text-slate-500 dark:text-slate-400'}`}>Live dashboard & statistics</span>
        </button>
        <button 
          onClick={() => setActiveTab('controls')}
          className={`flex flex-col items-start gap-1 px-5 py-3 rounded-xl text-left transition-all cursor-pointer border shadow-sm select-none ${
            activeTab === 'controls' 
              ? 'bg-indigo-600 border-indigo-600 text-white dark:bg-indigo-600 dark:border-indigo-600' 
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-850'
          }`}
        >
          <div className="flex items-center gap-1.5 font-black text-xs">
            <Users size={14} className={activeTab === 'controls' ? 'text-white' : 'text-indigo-600'} />
            Workforce Controls
          </div>
          <span className={`text-[10px] font-medium ${activeTab === 'controls' ? 'text-indigo-100' : 'text-slate-500 dark:text-slate-400'}`}>Clock out, edit shift logs & filters</span>
        </button>

        <button 
          onClick={() => setActiveTab('exceptions')}
          className={`flex flex-col items-start gap-1 px-5 py-3 rounded-xl text-left transition-all cursor-pointer border shadow-sm select-none ${
            activeTab === 'exceptions' 
              ? 'bg-rose-600 border-rose-600 text-white dark:bg-rose-600 dark:border-rose-600' 
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-850'
          }`}
        >
          <div className="flex items-center gap-1.5 font-black text-xs">
            <AlertTriangle size={14} className={activeTab === 'exceptions' ? 'text-white' : 'text-rose-500'} />
            Audit & Exceptions
          </div>
          <span className={`text-[10px] font-medium ${activeTab === 'exceptions' ? 'text-rose-100' : 'text-slate-500 dark:text-slate-400'}`}>Monitor anomalies</span>
        </button>

        {user.role === 'ADMIN' && (
          <button 
            onClick={() => setActiveTab('hierarchy')}
            className={`flex flex-col items-start gap-1 px-5 py-3 rounded-xl text-left transition-all cursor-pointer border shadow-sm select-none ${
              activeTab === 'hierarchy' 
                ? 'bg-indigo-600 border-indigo-600 text-white dark:bg-indigo-600 dark:border-indigo-600' 
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-850'
            }`}
          >
            <div className="flex items-center gap-1.5 font-black text-xs">
              <Shield size={14} className={activeTab === 'hierarchy' ? 'text-white' : 'text-indigo-650'} />
              Diagnostics
            </div>
            <span className={`text-[10px] font-medium ${activeTab === 'hierarchy' ? 'text-indigo-100' : 'text-slate-500 dark:text-slate-400'}`}>Check database sync state</span>
          </button>
        )}
      </div>

      {/* RENDER SELECTED TAB VIEWS */}
      <div className="space-y-6">
        
        {/* TAB 4: HIERARCHY VALIDATION REPORT (ADMIN ONLY) */}
        {activeTab === 'hierarchy' && user.role === 'ADMIN' && (
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
                    <span className="text-2xl font-black text-slate-800 dark:text-slate-200">{allUsers.filter(u => u.status === 'Active').length}</span>
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

        {/* TAB 1: WORKFORCE MONITORING (ANALYTICS & DISTRIBUTION VISUALS) */}
        {activeTab === 'monitoring' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* Live Distribution Board */}
            <div className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
              <div>
                <h4 className="text-xs font-extrabold text-slate-800 dark:text-slate-200 uppercase tracking-widest flex items-center gap-1.5">
                  <Sparkles size={14} className="text-amber-500" /> Live Workforce Distribution
                </h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">💡 Click any category below to immediately filter matching agents inside Workforce Controls.</p>
              </div>
              
              <div className="space-y-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => handleDistributionClick('active', '🟢 Active Workflow')}
                  className="group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 p-2 rounded-xl transition-all border border-transparent hover:border-slate-100 dark:hover:border-slate-800/60 focus:outline-none w-full text-left"
                >
                  <div className="flex justify-between text-xs font-bold text-slate-600 dark:text-slate-400 mb-1 leading-none">
                    <span className="group-hover:text-indigo-600 dark:group-hover:text-indigo-400 font-black transition-colors">🟢 Active Workflow</span>
                    <span className="text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 px-1.5 py-0.5 rounded-md font-extrabold text-[10px]">{liveDistribution.active}</span>
                  </div>
                  <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div className="bg-indigo-600 dark:bg-indigo-500 h-full rounded-full transition-all duration-300" style={{ width: `${(liveDistribution.active / (liveStats.total || 1)) * 100}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-400 group-hover:text-indigo-500 font-bold hidden group-block mt-1 leading-none transition-colors">Click to filter controls view &rarr;</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDistributionClick('break_tea', '☕ Tea / Short Break')}
                  className="group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 p-2 rounded-xl transition-all border border-transparent hover:border-slate-100 dark:hover:border-slate-800/60 focus:outline-none w-full text-left"
                >
                  <div className="flex justify-between text-xs font-bold text-slate-600 dark:text-slate-400 mb-1 leading-none">
                    <span className="group-hover:text-amber-500 font-black transition-colors">☕ Break & Tea</span>
                    <span className="text-amber-500 bg-amber-50 dark:bg-amber-955/20 px-1.5 py-0.5 rounded-md font-extrabold text-[10px]">{liveDistribution.break}</span>
                  </div>
                  <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div className="bg-amber-500 h-full rounded-full transition-all duration-300" style={{ width: `${(liveDistribution.break / (liveStats.total || 1)) * 100}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-400 group-hover:text-amber-500 font-bold hidden group-block mt-1 leading-none transition-colors">Click to filter controls view &rarr;</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDistributionClick('lunch', '🍱 Lunch Interval')}
                  className="group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 p-2 rounded-xl transition-all border border-transparent hover:border-slate-100 dark:hover:border-slate-800/60 focus:outline-none w-full text-left"
                >
                  <div className="flex justify-between text-xs font-bold text-slate-600 dark:text-slate-400 mb-1 leading-none">
                    <span className="group-hover:text-orange-600 dark:group-hover:text-orange-400 font-black transition-colors">🍱 Lunch Interval</span>
                    <span className="text-[#D97706] bg-amber-50 dark:bg-amber-955/20 px-1.5 py-0.5 rounded-md font-extrabold text-[10px]">{liveDistribution.lunch}</span>
                  </div>
                  <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div className="bg-[#D97706] h-full rounded-full transition-all duration-300" style={{ width: `${(liveDistribution.lunch / (liveStats.total || 1)) * 100}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-400 group-hover:text-orange-550 font-bold hidden group-block mt-1 leading-none transition-colors">Click to filter controls view &rarr;</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDistributionClick('meeting', '🤝 Meeting / Coaching')}
                  className="group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 p-2 rounded-xl transition-all border border-transparent hover:border-slate-100 dark:hover:border-slate-800/60 focus:outline-none w-full text-left"
                >
                  <div className="flex justify-between text-xs font-bold text-slate-600 dark:text-slate-400 mb-1 leading-none">
                    <span className="group-hover:text-purple-600 dark:group-hover:text-purple-400 font-black transition-colors">🤝 Meeting / Coaching</span>
                    <span className="text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/20 px-1.5 py-0.5 rounded-md font-extrabold text-[10px]">{liveDistribution.meeting}</span>
                  </div>
                  <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div className="bg-purple-600 h-full rounded-full transition-all duration-300" style={{ width: `${(liveDistribution.meeting / (liveStats.total || 1)) * 100}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-400 group-hover:text-purple-500 font-bold hidden group-block mt-1 leading-none transition-colors">Click to filter controls view &rarr;</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDistributionClick('offline', '⚪ Offline Staff')}
                  className="group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 p-2 rounded-xl transition-all border border-transparent hover:border-slate-100 dark:hover:border-slate-800/60 focus:outline-none w-full text-left"
                >
                  <div className="flex justify-between text-xs font-bold text-slate-600 dark:text-slate-400 mb-1 leading-none">
                    <span className="group-hover:text-slate-600 dark:group-hover:text-slate-300 font-black transition-colors">⚪ Offline / Off-Duty</span>
                    <span className="text-slate-400 bg-slate-50 dark:bg-slate-900/50 px-1.5 py-0.5 rounded-md font-extrabold text-[10px]">{liveDistribution.offline}</span>
                  </div>
                  <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div className="bg-slate-300 dark:bg-slate-700 h-full rounded-full transition-all duration-300" style={{ width: `${(liveDistribution.offline / (liveStats.total || 1)) * 100}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-400 group-hover:text-slate-500 font-bold hidden group-block mt-1 leading-none transition-colors">Click to filter controls view &rarr;</span>
                </button>
              </div>
            </div>

            {/* Role Dispersion Graph */}
            <div className="lg:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
              <h4 className="text-xs font-extrabold text-slate-800 dark:text-white uppercase tracking-widest">
                Team Role Allocation Mapping
              </h4>
              <div className="h-[210px] w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={roleChartData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                    <XAxis dataKey="name" stroke={isDark ? '#94A3B8' : '#64748B'} fontSize={11} />
                    <YAxis stroke={isDark ? '#94A3B8' : '#64748B'} fontSize={11} />
                    <Tooltip contentStyle={{ 
                      borderRadius: '12px', 
                      fontSize: '12px',
                      backgroundColor: isDark ? '#1e293b' : '#ffffff',
                      borderColor: isDark ? '#334155' : '#e2e8f0',
                      color: isDark ? '#ffffff' : '#0f172a'
                    }} />
                    <Bar dataKey="count" fill="#6366F1" radius={[6, 6, 0, 0]} maxBarSize={35} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* QUICK SUPERVISOR TOOLS RAIL */}
            <div className="lg:col-span-12 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm">
              <h4 className="text-xs font-extrabold text-slate-800 dark:text-white uppercase tracking-widest mb-4">
                Operational Short-cuts & Quick Actions
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                <button 
                  onClick={handleSpreadsheetExport}
                  disabled={isExporting}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white p-3 rounded-xl flex items-center justify-center gap-2 text-xs font-extrabold transition-colors cursor-pointer w-full"
                >
                  <FileSpreadsheet size={15} /> Export Utilization Report
                </button>
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
                        { val: 'break', label: '🟠 All Rest Breaks' },
                        { val: 'offline', label: '⚪ Offline Staff' }
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

                <div className="relative">
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Process Filter</label>
                  <MultiSelectDropdown
                    options={uniqueActiveProcesses}
                    selectedValues={selectedProcesses}
                    onToggle={(val) => {
                      setSelectedProcesses(prev => 
                        prev.includes(val) ? prev.filter(p => p !== val) : [...prev, val]
                      );
                      setCurrentPage(1);
                    }}
                    placeholder="🚀 Process: All"
                  />
                </div>

                <div className="relative">
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Team Lead Mapped</label>
                  <MultiSelectDropdown
                    options={teamLeadsList.map(tl => tl.name)}
                    selectedValues={selectedTLs}
                    onToggle={(val) => {
                      setSelectedTLs(prev => 
                        prev.includes(val) ? prev.filter(p => p !== val) : [...prev, val]
                      );
                      setCurrentPage(1);
                    }}
                    placeholder="🗺️ Team Leads: All"
                  />
                </div>

                {['ADMIN', 'MANAGER'].includes((user.role || '').toUpperCase()) ? (
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
                      setSelectedProcesses([]);
                      setShiftFilter('all');
                      setSelectedTLs([]);
                      setSelectedManagers(() => {
                        const isOnlyManager = (user.role || '').toString().toUpperCase() === 'MANAGER';
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
                    <th className="p-4">Current Activity</th>
                    <th className="p-4">Log In Time</th>
                    <th className="p-4">Device</th>
                    <th className="p-4 cursor-pointer" onClick={() => { setSortKey('productive'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>Productive Duration</th>
                    <th className="p-4 text-center">Utilization</th>
                    <th className="p-4">Operational Status</th>
                    <th className="p-4 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedWorkforce.map((u) => {
                    const live = activeShifts.find(s => s.userId === u.uid);
                    const stats = live ? calculateShiftStatsObj(live) : null;
                    const liveActs = live?.activities || [];
                    const lastAct = liveActs.length > 0 ? liveActs[liveActs.length - 1] : null;

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
                              <div className="flex flex-col">
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
                          <td className="p-4 font-semibold text-slate-800">
                            {live ? (
                              <div className="flex flex-col gap-0.5">
                                <span>{lastAct?.name || 'In transition'}</span>
                                {live.status === 'BREAK' && lastAct && (
                                  <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 animate-pulse flex items-center gap-1 font-mono">
                                    <Clock3 size={11} className="inline text-amber-500" />
                                    <span>Break time: {formatMs(Math.max(0, new Date().getTime() - new Date(lastAct.startTime).getTime()))}</span>
                                  </span>
                                )}
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
                          <td className="p-4">
                            {live ? (
                              <div className="flex flex-col gap-1">
                                <span className={`w-fit px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase ${live.status === 'BREAK' ? 'bg-amber-150 text-amber-800' : 'bg-emerald-150 text-emerald-800'}`}>
                                  {live.status}
                                </span>
                                {live.status === 'BREAK' && lastAct && (
                                  <span className="text-[9px] font-medium font-mono text-amber-600 dark:text-amber-450 leading-none">
                                    Duration: {formatMs(Math.max(0, getLiveTime().getTime() - new Date(lastAct.startTime).getTime()))}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="bg-slate-150 text-slate-450 px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase select-none">Offline</span>
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

        {/* TAB 3: AUDITS & EXCEPTIONS (EXCEPTION CENTER / DATA VALIDATION REPORTS) */}
        {activeTab === 'exceptions' && (
          <div className="space-y-6">
            
            {/* Actionable Exception Center Cards Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              
              {/* Active Breaks Threshold Compliance */}
              <div className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 col-span-1 lg:col-span-2">
                <div className="absolute top-0 bottom-0 left-0 w-1 bg-rose-500 rounded-l-2xl" />
                <div className="flex items-center justify-between border-b border-rose-50 dark:border-slate-850 pb-3 mb-4">
                  <h4 className="text-xs font-extrabold text-slate-800 dark:text-slate-200 uppercase tracking-widest flex items-center gap-2 leading-none">
                    <Coffee size={15} className="text-rose-500" /> Active Breaks Threshold Compliance
                  </h4>
                  <span className="bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 text-[10px] font-black px-2.5 py-1 rounded-full leading-none font-mono">
                    {(summaryData?.exceptionsList?.bioBreaks?.length || 0) + 
                     (summaryData?.exceptionsList?.lunchBreaks?.length || 0) + 
                     (summaryData?.exceptionsList?.shortBreaks?.length || 0)} total exceeded
                  </span>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Segment 1: Bio Breaks Exceeded */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-fuchsia-100 dark:border-fuchsia-950 pb-1.5">
                      <span className="text-[10px] font-black text-fuchsia-600 dark:text-fuchsia-400 uppercase tracking-widest flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-500" /> Bio Breaks &gt; 5 Mins
                      </span>
                      <span className="bg-fuchsia-50 dark:bg-fuchsia-950 text-fuchsia-700 dark:text-fuchsia-300 text-[9px] font-bold px-1.5 py-0.5 rounded">
                        {summaryData?.exceptionsList?.bioBreaks?.length || 0}
                      </span>
                    </div>
                    <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                      {summaryData?.exceptionsList?.bioBreaks?.map((item: any, idx: number) => (
                        <div key={idx} className="flex justify-between items-start text-xs bg-fuchsia-50/20 dark:bg-fuchsia-950/10 p-2.5 rounded-xl border border-fuchsia-100/40 dark:border-fuchsia-950/20">
                          <div className="min-w-0 flex-1">
                            <div className="font-bold text-slate-800 dark:text-slate-200 truncate leading-tight">{item.userName}</div>
                            <div className="text-[9px] text-fuchsia-600 dark:text-fuchsia-400 font-extrabold uppercase mt-1">🚨 Bio: {item.durationMins}m</div>
                          </div>
                          <button 
                            onClick={() => selectAndFocusUser(item.userName)}
                            className="bg-fuchsia-100 hover:bg-fuchsia-200 dark:bg-fuchsia-950 dark:text-fuchsia-300 text-fuchsia-800 text-[9px] font-extrabold px-2 py-1 rounded cursor-pointer shrink-0 ml-1 transition-colors"
                          >
                            Focus
                          </button>
                        </div>
                      ))}
                      {(!summaryData?.exceptionsList?.bioBreaks || summaryData.exceptionsList.bioBreaks.length === 0) && (
                        <div className="text-center py-4 text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">
                          ✅ Compliant
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Segment 2: Short Breaks Exceeded */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-amber-100 dark:border-amber-950 pb-1.5">
                      <span className="text-[10px] font-black text-amber-600 dark:text-amber-400 uppercase tracking-widest flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Short Breaks &gt; 20 Mins
                      </span>
                      <span className="bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-[9px] font-bold px-1.5 py-0.5 rounded">
                        {summaryData?.exceptionsList?.shortBreaks?.length || 0}
                      </span>
                    </div>
                    <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                      {summaryData?.exceptionsList?.shortBreaks?.map((item: any, idx: number) => (
                        <div key={idx} className="flex justify-between items-start text-xs bg-amber-50/20 dark:bg-amber-950/10 p-2.5 rounded-xl border border-amber-100/40 dark:border-amber-950/20">
                          <div className="min-w-0 flex-1">
                            <div className="font-bold text-slate-800 dark:text-slate-200 truncate leading-tight">{item.userName}</div>
                            <div className="text-[9px] text-amber-600 dark:text-amber-400 font-extrabold uppercase mt-1">⚠️ Exceeded: {item.durationMins}m</div>
                          </div>
                          <button 
                            onClick={() => selectAndFocusUser(item.userName)}
                            className="bg-amber-100 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-300 text-amber-800 text-[9px] font-extrabold px-2 py-1 rounded cursor-pointer shrink-0 ml-1 transition-colors"
                          >
                            Focus
                          </button>
                        </div>
                      ))}
                      {(!summaryData?.exceptionsList?.shortBreaks || summaryData.exceptionsList.shortBreaks.length === 0) && (
                        <div className="text-center py-4 text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">
                          ✅ Compliant
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Segment 3: Lunch Breaks Exceeded */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-rose-100 dark:border-rose-950 pb-1.5">
                      <span className="text-[10px] font-black text-rose-600 dark:text-rose-400 uppercase tracking-widest flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> Lunch Breaks &gt; 45 Mins
                      </span>
                      <span className="bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 text-[9px] font-bold px-1.5 py-0.5 rounded">
                        {summaryData?.exceptionsList?.lunchBreaks?.length || 0}
                      </span>
                    </div>
                    <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                      {summaryData?.exceptionsList?.lunchBreaks?.map((item: any, idx: number) => (
                        <div key={idx} className="flex justify-between items-start text-xs bg-rose-50/20 dark:bg-rose-950/10 p-2.5 rounded-xl border border-rose-100/40 dark:border-rose-950/20">
                          <div className="min-w-0 flex-1">
                            <div className="font-bold text-slate-800 dark:text-slate-200 truncate leading-tight">{item.userName}</div>
                            <div className="text-[9px] text-rose-600 dark:text-rose-400 font-extrabold uppercase mt-1">🔥 Breach: {item.durationMins}m</div>
                          </div>
                          <button 
                            onClick={() => selectAndFocusUser(item.userName)}
                            className="bg-rose-100 hover:bg-rose-200 dark:bg-rose-950 dark:text-rose-300 text-rose-800 text-[9px] font-extrabold px-2 py-1 rounded cursor-pointer shrink-0 ml-1 transition-colors"
                          >
                            Focus
                          </button>
                        </div>
                      ))}
                      {(!summaryData?.exceptionsList?.lunchBreaks || summaryData.exceptionsList.lunchBreaks.length === 0) && (
                        <div className="text-center py-4 text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">
                          ✅ Compliant
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Automatic Terminations (Auto-Closed Shifts) */}
              <div className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
                <div className="absolute top-0 bottom-0 left-0 w-1 bg-sky-500 rounded-l-2xl" />
                <div className="flex items-center justify-between border-b border-slate-50 dark:border-slate-850 pb-3 mb-4">
                  <h4 className="text-xs font-extrabold text-[#D97706] dark:text-amber-400 uppercase tracking-widest flex items-center gap-2 leading-none">
                    <UserX size={15} className="text-sky-500" /> Automatic Terminations
                  </h4>
                  <span className="bg-amber-50 dark:bg-amber-950/40 text-[#D97706] dark:text-amber-400 text-[10px] font-black px-2.5 py-1 rounded-full leading-none font-mono">
                    {(summaryData?.exceptionsList?.autoClosed?.length || 0)} anomalies
                  </span>
                </div>

                <div className="space-y-3.5 max-h-80 overflow-y-auto">
                  {summaryData?.exceptionsList?.autoClosed?.map((item: any, idx: number) => (
                    <div key={idx} className="flex justify-between items-center text-xs bg-amber-50/10 dark:bg-amber-950/5 p-3 rounded-xl border border-amber-100/10 dark:border-amber-955/10 font-sans">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-amber-50 dark:bg-amber-955 text-amber-700 dark:text-amber-400 flex items-center justify-center font-extrabold text-[11px] uppercase shrink-0">
                          {item.userName ? item.userName.charAt(0) : 'U'}
                        </div>
                        <div className="min-w-0">
                          <div className="font-extrabold text-slate-800 dark:text-slate-200 leading-tight truncate">{item.userName}</div>
                          <div className="text-[10px] text-amber-600 dark:text-amber-400 font-bold mt-0.5 leading-none">Auto-clocked out after 10 hours productive time</div>
                        </div>
                      </div>
                      <button 
                        onClick={() => selectAndFocusUser(item.userName)}
                        className="bg-amber-100 hover:bg-amber-150 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900/60 text-amber-850 text-[10px] font-extrabold px-3 py-1.5 rounded-lg shrink-0 cursor-pointer transition-colors"
                      >
                        Audit Profile
                      </button>
                    </div>
                  ))}

                  {(!summaryData?.exceptionsList?.autoClosed || summaryData.exceptionsList.autoClosed.length === 0) && (
                    <div className="text-center py-8">
                      <p className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest leading-none">
                        ✅ No automatic terminations today
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Mobile Phone Devices Log Audit */}
              <div className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
                <div className="absolute top-0 bottom-0 left-0 w-1 bg-fuchsia-500 rounded-l-2xl" />
                <div className="flex items-center justify-between border-b border-rose-50 dark:border-slate-850 pb-3 mb-4">
                  <h4 className="text-xs font-extrabold text-fuchsia-700 dark:text-fuchsia-400 uppercase tracking-widest flex items-center gap-2 leading-none">
                    <Smartphone size={15} className="text-fuchsia-500" /> Mobile Access &amp; Punches Log
                  </h4>
                  <span className="bg-fuchsia-50 dark:bg-fuchsia-950/40 text-fuchsia-700 dark:text-fuchsia-400 text-[10px] font-black px-2.5 py-1 rounded-full leading-none font-mono">
                    {summaryData?.exceptionsList?.mobilePunches?.length || 0} device logs
                  </span>
                </div>

                <div className="space-y-3.5 max-h-80 overflow-y-auto">
                  {Object.values((summaryData?.exceptionsList?.mobilePunches || []).reduce((acc: any, item: any) => {
                    if (!acc[item.userName]) acc[item.userName] = { ...item, logs: [item] };
                    else {
                      acc[item.userName].mobilePunchesCount += item.mobilePunchesCount;
                      acc[item.userName].logs.push(item);
                    }
                    return acc;
                  }, {})).map((item: any, idx: number) => {
                    return (
                      <div key={idx} className="text-xs bg-fuchsia-50/10 dark:bg-fuchsia-950/5 p-3.5 rounded-xl border border-fuchsia-100/10 dark:border-fuchsia-955/10 font-sans space-y-2">
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-7 h-7 rounded-full bg-fuchsia-100 dark:bg-fuchsia-950 text-fuchsia-700 dark:text-fuchsia-400 flex items-center justify-center font-extrabold text-[10px] uppercase shrink-0">
                              {item.userName ? item.userName.charAt(0) : 'M'}
                            </div>
                            <div className="min-w-0">
                              <div className="font-extrabold text-slate-800 dark:text-slate-200 leading-tight truncate">{item.userName}</div>
                              <div className="text-[9px] text-slate-500 dark:text-slate-400">Total Mobile Action count: <span className="text-fuchsia-600 font-extrabold">{item.mobilePunchesCount}</span></div>
                            </div>
                          </div>
                          <button 
                            onClick={() => {
                              setSelectedInvestigateLogs(item.logs);
                              setShowInvestigateModal(true);
                            }}
                            className="bg-fuchsia-100 hover:bg-fuchsia-200 dark:bg-fuchsia-950 dark:text-fuchsia-300 text-fuchsia-850 text-[9px] font-extrabold px-2.5 py-1.5 rounded-lg shrink-0 cursor-pointer transition-colors"
                          >
                            Investigate
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {(!summaryData?.exceptionsList?.mobilePunches || summaryData.exceptionsList.mobilePunches.length === 0) && (
                    <div className="text-center py-10">
                      <p className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest leading-none">
                        📱 Desktop access compliant. No mobile devices reported today.
                      </p>
                    </div>
                  )}
                </div>
              </div>

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
              {selectedInvestigateLogs.flatMap(log => 
                (log.activities && log.activities.length > 0 ? log.activities : [{ name: 'Action', startTime: log.loginTimestamp || log.timestamp || Date.now() }])
              ).map((activity: any, idx: number) => {
                const ts = activity.startTime;
                const dateStr = ts ? new Date(ts).toLocaleString() : 'N/A';
                return (
                  <div key={idx} className="bg-slate-50 p-3 rounded-lg border border-slate-100 text-xs">
                    <span className="font-mono text-slate-500">{dateStr}</span>
                    <div className="font-bold">{activity.name}</div>
                  </div>
                );
              })}
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

      {/* MODAL 3: VIEW AUDIT LOGS */}
      {showLogsModal && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 text-slate-800 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-2xl p-6 border border-slate-200 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b pb-3.5">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-slate-100 text-slate-650 rounded-xl">
                  <Calendar size={20} />
                </div>
                <div className="text-left">
                  <h4 className="font-extrabold text-slate-900 text-sm">System Administration Audit Trail</h4>
                  <p className="text-slate-450 text-[10px] font-bold">Supervisor and management log action sequence</p>
                </div>
              </div>
              <button 
                onClick={() => setShowLogsModal(false)}
                className="text-slate-400 hover:text-slate-600 font-extrabold text-xs pr-2 cursor-pointer"
              >
                Close
              </button>
            </div>

            <div className="max-h-96 overflow-y-auto space-y-3.5 text-xs">
              {isLoadingLogs ? (
                <p className="text-slate-400 py-20 text-center font-bold">Scanning audit tables...</p>
              ) : adminLogs.map((log) => (
                <div key={log.id} className="p-3 bg-slate-50 border border-slate-150 rounded-xl space-y-1">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="font-black text-indigo-600 uppercase bg-indigo-50 px-2 py-0.5 rounded leading-none">{log.action}</span>
                    <span className="font-mono text-slate-400 font-bold">{new Date(log.timestamp).toLocaleString()}</span>
                  </div>
                  <div className="font-medium text-slate-700 pt-1 leading-none">
                    Performed by: <strong className="text-slate-900">{log.performedBy}</strong>
                  </div>
                  <div className="font-medium text-slate-700 pt-1 leading-none">
                    Target affected: <strong className="text-slate-900">{log.affectedUser}</strong>
                  </div>
                  <div className="text-[10px] text-slate-450 font-bold leading-normal pt-1 flex gap-2">
                    <span>Val: {log.newValue}</span>
                  </div>
                </div>
              ))}
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

    </div>
  );
}
