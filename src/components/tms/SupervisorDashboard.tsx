import React, { useState, useEffect, useMemo } from 'react';
import { 
  Users, 
  Clock, 
  Coffee, 
  Search, 
  ShieldAlert, 
  ChevronLeft, 
  ChevronRight, 
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
  Sparkles
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
import { 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  query, 
  where, 
  getDocs, 
  writeBatch,
  addDoc
} from 'firebase/firestore';
import { UserProfile, UserRole } from '../../types';
import { toast } from 'sonner';
import { canActOn } from '../../lib/hierarchy';
import { usePermission } from '../PermissionContext';
import * as XLSX from 'xlsx';

interface SupervisorDashboardProps {
  user: UserProfile;
  allUsers: UserProfile[];
  onRefreshAllData?: () => void;
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
  clockInTime: string;
  clockOutTime?: string;
  activities: ShiftActivity[];
  status: 'ACTIVE' | 'BREAK' | 'COMPLETED' | 'AUTO_CLOSED';
}

export default function SupervisorDashboard({ user, allUsers, onRefreshAllData }: SupervisorDashboardProps) {
  const { hasTmsPermission } = usePermission();
  
  // Tab control
  const [activeTab, setActiveTab] = useState<'monitoring' | 'controls' | 'exceptions'>('monitoring');
  
  // Real-time active shifts & audit logs status loaded locally for performance
  const [activeShifts, setActiveShifts] = useState<TMSShift[]>([]);
  const [isLoadingShifts, setIsLoadingShifts] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [countdown, setCountdown] = useState(90); // 90 seconds refresh cycle

  // Filters state for control table
  const [searchTerm, setSearchTerm] = useState('');
  const [processFilter, setProcessFilter] = useState('all');
  const [shiftFilter, setShiftFilter] = useState('all'); // all, active, break, offline
  const [tlFilter, setTlFilter] = useState('all');
  const [managerFilter, setManagerFilter] = useState('all');
  const [sortKey, setSortKey] = useState<'name' | 'productive' | 'status'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 30;

  // Modals / Actions states
  const [isExporting, setIsExporting] = useState(false);
  const [showCorrectionModal, setShowCorrectionModal] = useState(false);
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [adminLogs, setAdminLogs] = useState<any[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);

  // Correction Form state
  const [correctionUserId, setCorrectionUserId] = useState('');
  const [correctionDate, setCorrectionDate] = useState(new Date().toISOString().slice(0, 10));
  const [correctionClockIn, setCorrectionClockIn] = useState('09:00');
  const [correctionClockOut, setCorrectionClockOut] = useState('18:00');
  const [correctionRemarks, setCorrectionRemarks] = useState('');
  const [correctionProcess, setCorrectionProcess] = useState('HITL');
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);

  // Force Logout Confirm States
  const [showForceLogoutConfirm, setShowForceLogoutConfirm] = useState(false);
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

  // Hierarchy validation helper (checks if current supervisor is authorized to edit target)
  const canModifyTarget = (targetUid: string) => {
    if (user.uid === targetUid) return false;
    const target = allUsers.find(u => u.uid === targetUid);
    if (!target) return false;
    return canActOn(user, target, allUsers);
  };

  // Mapped list of supervised agents based on hierarchy
  const mappedUsers = useMemo(() => {
    // ADMIN and MANAGER can see organization-wide; other roles filter by team hierarchy
    const roleNormalized = (user.role || '').toUpperCase();
    const isManagerOrAdmin = ['ADMIN', 'MANAGER'].includes(roleNormalized);
    
    if (isManagerOrAdmin) {
      return allUsers.filter(u => u.status === 'Active');
    }
    return allUsers.filter(u => u.status === 'Active' && canActOn(user, u, allUsers));
  }, [allUsers, user]);

  // List of unique Team Leads who have members in mappedUsers
  const teamLeadsList = useMemo(() => {
    const leads = new Map<string, string>();
    allUsers.forEach(u => {
      if (u.teamLeadId && u.teamLeadName) {
        leads.set(u.teamLeadId, u.teamLeadName);
      }
    });
    return Array.from(leads.entries()).map(([id, name]) => ({ id, name }));
  }, [allUsers]);

  // List of unique Managers
  const managersList = useMemo(() => {
    return allUsers.filter(u => u.role === UserRole.MANAGER || u.role === UserRole.ADMIN);
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
      if (act.type === 'productive') {
        activeMs += duration;
      } else {
        breakMs += duration;
      }
    });

    const utilization = totalShiftMs > 60000 
      ? Number(((activeMs / totalShiftMs) * 100).toFixed(1)) 
      : 100;

    return {
      totalShiftStr: formatMs(totalShiftMs),
      activeStr: formatMs(activeMs),
      breakStr: formatMs(breakMs),
      utilization,
      totalShiftMs,
      activeMs,
      breakMs
    };
  };

  // FETCH & AGGREGATE CORE - Minimal reads & cached architecture
  const loadAndRecomputeData = async (forceRecalculate = false) => {
    setIsLoadingShifts(true);
    try {
      const summaryDocRef = doc(db, 'dashboardSummary', `tms_${user.uid}`);
      let cachedSummary: any = null;

      if (!forceRecalculate) {
        // Attempt to read cached summary document first to avoid computing
        const docSnap = await getDoc(summaryDocRef);
        if (docSnap.exists()) {
          const data = docSnap.data();
          const age = new Date().getTime() - new Date(data.lastUpdated).getTime();
          // Cache validity: 90 seconds
          if (age < 90000) {
            cachedSummary = data;
          }
        }
      }

      if (cachedSummary) {
        setSummaryData(cachedSummary);
        setActiveShifts(cachedSummary.activeShiftsList || []);
        setLastRefreshed(new Date(cachedSummary.lastUpdated));
        setIsLoadingShifts(false);
        return;
      }

      // If missing or expired: Perform optimized fetch of ONLY active shifts
      const activeShiftsQuery = query(
        collection(db, 'tmsShifts'),
        where('status', 'in', ['ACTIVE', 'BREAK'])
      );
      const snapshot = await getDocs(activeShiftsQuery);
      const allActiveShifts = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as TMSShift));

      // Filter active shifts matching the team scope
      const scopeIds = new Set(mappedUsers.map(u => u.uid));
      const teamActiveShifts = allActiveShifts.filter(sh => scopeIds.has(sh.userId));
      setActiveShifts(teamActiveShifts);

      // Fetch auto-closed sessions of today
      const startOfToday = new Date();
      startOfToday.setHours(0,0,0,0);
      const autoClosedQuery = query(
        collection(db, 'tmsShifts'),
        where('status', '==', 'AUTO_CLOSED'),
        where('clockInTime', '>=', startOfToday.toISOString())
      );
      const autoClosedSnapshot = await getDocs(autoClosedQuery);
      const teamAutoClosed = autoClosedSnapshot.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .filter(sh => scopeIds.has(sh.userId));

      // Compute statistics and variables in memory without database scans
      const totalAssigned = mappedUsers.length;
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
          } else if (lastActivity.toLowerCase().includes('meeting') || lastActivity.toLowerCase().includes('coaching') || lastActivity.toLowerCase().includes('alignment')) {
            meetingCount++;
          } else {
            otherBreakCount++;
          }
        }
      });

      // Audit and Validation diagnostics calculations
      const nowMs = new Date().getTime();
      const stales: any[] = [];
      const longBreaks: any[] = [];
      const idles: any[] = [];
      
      const staleBatch = writeBatch(db);
      let staleFound = false;

      teamActiveShifts.forEach(sh => {
        const stats = calculateShiftStatsObj(sh);
        const clockInMs = new Date(sh.clockInTime).getTime();
        const shActs = sh.activities || [];
        const lastActObj = shActs.length > 0 ? shActs[shActs.length - 1] : null;
        const lastActTime = lastActObj ? new Date(lastActObj.startTime).getTime() : clockInMs;
        
        // 1. Stale shifts (>16 hours active) - Auto closed
        if (nowMs - clockInMs > 16 * 60 * 60 * 1000) {
          stales.push({
            id: sh.id,
            userId: sh.userId,
            userName: sh.userName,
            clockInTime: sh.clockInTime
          });

          // Auto-punch logic: close the shift
          const nowISO = new Date().toISOString();
          const updatedActivities = [...(sh.activities || [])];
          if (updatedActivities.length > 0) {
            const lastIndex = updatedActivities.length - 1;
            if (!updatedActivities[lastIndex].endTime) {
              updatedActivities[lastIndex].endTime = nowISO;
            }
          }

          staleBatch.set(doc(db, 'tmsShifts', sh.id), {
            ...sh,
            activities: updatedActivities,
            status: 'AUTO_CLOSED',
            clockOutTime: nowISO
          });
          
          staleFound = true;
        }

        // 2. Long break (>45 minutes on break)
        if (sh.status === 'BREAK' && lastActObj && !lastActObj.endTime) {
          const breakDurationMins = (nowMs - lastActTime) / (60 * 1000);
          if (breakDurationMins > 45) {
            longBreaks.push({
              userId: sh.userId,
              userName: sh.userName,
              email: sh.userEmail,
              breakName: lastActObj.name,
              startTime: lastActObj.startTime,
              durationMins: Math.round(breakDurationMins),
              shiftId: sh.id
            });
          }
        }

        // 3. Idle Users (in active status but no updates for >2 hours)
        if (sh.status === 'ACTIVE' && lastActObj) {
          const idleMins = (nowMs - lastActTime) / (60 * 1000);
          if (idleMins > 120) {
            idles.push({
              userId: sh.userId,
              userName: sh.userName,
              email: sh.userEmail,
              lastActivity: lastActObj.name,
              lastActivityTime: lastActObj.startTime,
              shiftId: sh.id
            });
          }
        }
      });

      // Team Inconsistencies Scan
      const inconsistencies: any[] = [];
      mappedUsers.forEach(u => {
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
      mappedUsers.forEach(u => {
        if (!clockedAgentIds.has(u.uid) && !teamAutoClosed.some(c => c.userId === u.uid)) {
          attendanceExceptions.push({
            userId: u.uid,
            userName: u.name,
            email: u.email,
            reason: 'Resource has not reported/clocked-in today'
          });
        }
      });

      // Commit auto-punch batch if any found
      if (staleFound) {
        console.log(`[AUTO-PUNCH] Found ${stales.length} shifts active for >16h. Auto-closing...`);
        await staleBatch.commit();
        // Record auto-audit
        stales.forEach(async (stale) => {
          await addDoc(collection(db, 'adminAuditLogs'), {
            timestamp: new Date().toISOString(),
            performedBy: 'System Engine (Auto-Punch)',
            affectedUser: `${stale.userName} (${stale.userId})`,
            action: 'System Auto Force Logout',
            previousValue: 'STALE_SHIFT > 16H',
            newValue: 'AUTO_CLOSED'
          });
        });
        toast.info(`System auto-closed ${stales.length} shifts that exceeded 16 hours.`);
      }

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
          missingPunchOuts: stales.length,
          longBreaks: longBreaks.length,
          idleUsers: idles.length,
          autoClosed: teamAutoClosed.length,
          attendanceExceptions: attendanceExceptions.length
        },
        exceptionsList: {
          missingPunchOuts: stales,
          longBreaks,
          idleUsers: idles,
          autoClosed: teamAutoClosed,
          attendanceExceptions
        },
        validationReport: {
          staleSessions: stales,
          activeAfterClockOut: [], // Profiles mark as active somewhere but clocked out
          teamInconsistencies: inconsistencies,
          countMismatches
        }
      };

      // Save summary data in Firestore to share/cache
      await setDoc(summaryDocRef, computedSummary);
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

  // Run on mount, and schedule recurring pull every 90 seconds
  useEffect(() => {
    loadAndRecomputeData(false);
  }, [allUsers]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          loadAndRecomputeData(false);
          return 90;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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
      }

      // Process filters
      if (processFilter !== 'all') {
        if (!liveShift) return false;
        const liveShiftActs = liveShift.activities || [];
        const currentProc = liveShiftActs.length > 0 ? liveShiftActs[liveShiftActs.length - 1]?.name || '' : '';
        if (currentProc !== processFilter) return false;
      }

      // TL filter
      if (tlFilter !== 'all' && u.teamLeadId !== tlFilter) return false;

      // Manager filter
      if (managerFilter !== 'all') {
        // Find if user is under that manager
        if (u.role !== 'AGENT' || u.teamLeadId !== managerFilter) return false;
      }

      return true;
    });
  }, [mappedUsers, activeShifts, searchTerm, processFilter, shiftFilter, tlFilter, managerFilter]);

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
  const paginatedWorkforce = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sortedWorkforce.slice(start, start + itemsPerPage);
  }, [sortedWorkforce, currentPage]);

  const uniqueActiveProcesses = useMemo(() => {
    const list = new Set<string>();
    activeShifts.forEach(sh => {
      const shActs = sh.activities || [];
      const act = shActs.length > 0 ? shActs[shActs.length - 1] : null;
      if (act && act.type === 'productive') list.add(act.name);
    });
    return Array.from(list);
  }, [activeShifts]);

  // Chart Allocations Data
  const roleChartData = useMemo(() => {
    const map = new Map<string, number>();
    mappedUsers.forEach(u => {
      map.set(u.role, (map.get(u.role) || 0) + 1);
    });
    return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
  }, [mappedUsers]);

  // Handle manual attendance insert
  const handleAttendanceCorrectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctionUserId || !correctionProcess || !correctionClockIn || !correctionClockOut) {
      toast.error('Please fill out all session parameters.');
      return;
    }

    setIsSavingCorrection(true);
    const correctedUserRef = allUsers.find(u => u.uid === correctionUserId);
    if (!correctedUserRef) {
      toast.error('Profile not identified.');
      setIsSavingCorrection(false);
      return;
    }

    try {
      const inTime = new Date(`${correctionDate}T${correctionClockIn}:00`).toISOString();
      const outTime = new Date(`${correctionDate}T${correctionClockOut}:00`).toISOString();

      if (new Date(inTime) >= new Date(outTime)) {
        toast.error('Clock Out timestamp must be after clock In.');
        setIsSavingCorrection(false);
        return;
      }

      const generatedShiftId = `shift-corrected-${Date.now()}`;
      const correctionDataObj: TMSShift = {
        id: generatedShiftId,
        userId: correctionUserId,
        userName: correctedUserRef.name,
        userEmail: correctedUserRef.email,
        clockInTime: inTime,
        clockOutTime: outTime,
        status: 'COMPLETED',
        activities: [
          {
            type: 'productive',
            name: correctionProcess,
            startTime: inTime,
            endTime: outTime
          }
        ]
      };

      await setDoc(doc(db, 'tmsShifts', generatedShiftId), correctionDataObj);

      // Write admin audit log
      await addDoc(collection(db, 'adminAuditLogs'), {
        timestamp: new Date().toISOString(),
        performedBy: `${user.name} (${user.email})`,
        affectedUser: `${correctedUserRef.name} (${correctedUserRef.email})`,
        action: 'Supervisor Attendance Correction Insert',
        previousValue: 'Offline',
        newValue: `Corrected Shift: ${correctionProcess} (${correctionClockIn} - ${correctionClockOut})`
      });

      toast.success(`Successfully recorded session correction punch for ${correctedUserRef.name}`);
      setShowCorrectionModal(false);
      loadAndRecomputeData(true);
      if (onRefreshAllData) onRefreshAllData();
    } catch (err) {
      console.error('[ATT_CORRECT_ERR]', err);
      toast.error('Failed to create manual attendance punch record');
    } finally {
      setIsSavingCorrection(false);
    }
  };

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
          'Employee Name', 'Email', 'Role', 'Team Lead', 'Manager',
          'Date', 'Clock In', 'Clock Out', 'Shift Status',
          'Prod Minutes', 'Break Minutes', 'Total Minutes', 'Utilization %'
        ];

        const summaryRows = teamShifts.map(sh => {
          const u = allUsers.find(user => user.uid === sh.userId);
          const stats = calculateShiftStatsObj(sh);
          const dateStr = new Date(sh.clockInTime).toLocaleDateString('en-IN');
          
          return [
            u?.name || sh.userName,
            u?.email || sh.userEmail,
            u?.role || 'N/A',
            u?.teamLeadName || 'Unassigned',
            u?.mappedManagerName || 'Unassigned',
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
          'Employee Name', 'Email', 'Date', 'Sequence', 'Type', 'Activity', 'Start Time', 'End Time', 'Duration (Min)'
        ];

        const chronoRows: any[] = [];
        teamShifts.forEach(sh => {
          const dateStr = new Date(sh.clockInTime).toLocaleDateString('en-IN');
          (sh.activities || []).forEach((act, idx) => {
            const startStr = new Date(act.startTime).toLocaleTimeString('en-IN');
            const endStr = act.endTime ? new Date(act.endTime).toLocaleTimeString('en-IN') : 'Ongoing';
            const durationArr = act.endTime 
              ? (new Date(act.endTime).getTime() - new Date(act.startTime).getTime()) / 60000 
              : (new Date().getTime() - new Date(act.startTime).getTime()) / 60000;

            chronoRows.push([
              sh.userName,
              sh.userEmail,
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

  // Helper navigate directly to exception user inside table
  const selectAndFocusUser = (targetName: string) => {
    setSearchTerm(targetName);
    setActiveTab('controls');
    setCurrentPage(1);
    toast.info(`Focused view onto matching profile: ${targetName}`);
  };

  return (
    <div className="space-y-6">
      
      {/* HEADER SECTION WITH AUTO REFRESH TICKER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900 text-white p-6 rounded-3xl shadow-xl">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-indigo-600 rounded-2xl shadow-lg text-white">
            <Shield size={24} className="animate-pulse" />
          </div>
          <div>
            <h2 className="text-xl font-extrabold tracking-tight">Workforce Management Command</h2>
            <p className="text-xs text-slate-400 font-sans mt-0.5">Separate controls for monitoring, supervision rosters, exceptions & live statistics.</p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 bg-slate-800 text-slate-300 border border-slate-700 px-3 py-1.5 rounded-xl font-mono text-[11px]">
            <Clock3 size={13} className="text-indigo-400" />
            <span>Refreshes in {countdown}s</span>
          </div>
          
          <button 
            onClick={() => loadAndRecomputeData(true)}
            disabled={isLoadingShifts}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-750 text-white px-3 py-1.5 rounded-xl text-xs font-black cursor-pointer transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={isLoadingShifts ? 'animate-spin' : ''} />
            <span>Sync & Audit</span>
          </button>
        </div>
      </div>

      {/* CORE STATS KPI TILES (TOP SUMMARY CARDS) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3.5">
        <div className="bg-white border border-slate-200/80 p-4.5 rounded-2xl shadow-sm text-center">
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 leading-none">Total Assigned</span>
          <h3 className="text-2xl font-black text-slate-900 mt-1">{summaryData?.totalAssigned ?? mappedUsers.length}</h3>
          <p className="text-[10px] text-slate-500 font-bold mt-0.5 leading-none">Roster Mapped</p>
        </div>

        <div className="bg-white border border-emerald-200 p-4.5 rounded-2xl shadow-sm shadow-emerald-50/50 text-center">
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-emerald-600 leading-none">Logged In Now</span>
          <h3 className="text-2xl font-black text-emerald-600 mt-1">{summaryData?.loggedInCount ?? 0}</h3>
          <p className="text-[10px] text-emerald-500 font-bold mt-0.5 leading-none">On-Duty Shifts</p>
        </div>

        <div className="bg-white border border-amber-200 p-4.5 rounded-2xl shadow-sm shadow-amber-50/50 text-center">
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-amber-600 leading-none">On Break</span>
          <h3 className="text-2xl font-black text-amber-500 mt-1">{summaryData?.onBreakCount ?? 0}</h3>
          <p className="text-[10px] text-amber-500 font-bold mt-0.5 leading-none">Rest Periods</p>
        </div>

        <div className="bg-white border border-slate-200 p-4.5 rounded-2xl shadow-sm text-center">
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 leading-none">Offline</span>
          <h3 className="text-2xl font-black text-slate-600 mt-1">{summaryData?.offlineCount ?? 0}</h3>
          <p className="text-[10px] text-slate-400 font-bold mt-0.5 leading-none">Off-Duty staff</p>
        </div>

        <div className="bg-white border border-sky-200 p-4.5 rounded-2xl shadow-sm shadow-sky-50/50 text-center">
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-sky-600 leading-none">Attendance %</span>
          <h3 className="text-2xl font-black text-sky-600 mt-1">{summaryData?.attendancePercent ?? 0}%</h3>
          <p className="text-[10px] text-sky-500 font-bold mt-0.5 leading-none">Team Rate</p>
        </div>

        <div className="bg-white border border-indigo-200 p-4.5 rounded-2xl shadow-sm shadow-indigo-50/50 text-center">
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-indigo-600 leading-none">Active Work</span>
          <h3 className="text-2xl font-black text-indigo-600 mt-1">{summaryData?.activeCount ?? 0}</h3>
          <p className="text-[10px] text-indigo-500 font-bold mt-0.5 leading-none">Productive Timers</p>
        </div>
      </div>

      {/* DASHBOARD TABS */}
      <div className="flex gap-2 border-b border-slate-200 pb-1 overflow-x-auto scrollbar-none">
        <button 
          onClick={() => setActiveTab('monitoring')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black transition-all cursor-pointer ${activeTab === 'monitoring' ? 'bg-indigo-50 text-indigo-600 border border-indigo-100' : 'text-slate-500 hover:text-slate-800'}`}
        >
          <Activity size={14} />
          Workforce Monitoring
        </button>
        <button 
          onClick={() => setActiveTab('controls')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black transition-all cursor-pointer ${activeTab === 'controls' ? 'bg-indigo-50 text-indigo-600 border border-indigo-100' : 'text-slate-500 hover:text-slate-800'}`}
        >
          <Users size={14} />
          Workforce Controls
        </button>
        <button 
          onClick={() => setActiveTab('exceptions')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black transition-all cursor-pointer ${activeTab === 'exceptions' ? 'bg-rose-50 text-rose-600 border border-rose-100' : 'text-slate-500 hover:text-slate-800'}`}
        >
          <AlertTriangle size={14} className="text-rose-500 animate-bounce-slow" />
          Audit & Exceptions
          {summaryData?.exceptionCounts && (Object.values(summaryData.exceptionCounts).reduce((a: any, b: any) => a + b, 0) as number) > 0 && (
            <span className="bg-rose-600 text-white font-mono text-[9px] font-black rounded-full h-4.5 px-1.5 flex items-center justify-center animate-pulse">
              {(Object.values(summaryData.exceptionCounts).reduce((a: any, b: any) => a + b, 0) as number)}
            </span>
          )}
        </button>
      </div>

      {/* RENDER SELECTED TAB VIEWS */}
      <div className="space-y-6">
        
        {/* TAB 1: WORKFORCE MONITORING (ANALYTICS & DISTRIBUTION VISUALS) */}
        {activeTab === 'monitoring' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* Live Distribution Board */}
            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
              <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-widest flex items-center gap-1.5">
                <Sparkles size={14} className="text-amber-500" /> Live Workforce Distribution
              </h4>
              
              <div className="space-y-3 pt-2">
                <div>
                  <div className="flex justify-between text-xs font-bold text-slate-600 mb-1 leading-none">
                    <span>Active Workflow</span>
                    <span className="text-indigo-600">{summaryData?.distribution?.active ?? 0}</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                    <div className="bg-indigo-600 h-full rounded-full" style={{ width: `${(summaryData?.distribution?.active / (summaryData?.totalAssigned || 1)) * 100}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-bold text-slate-600 mb-1 leading-none">
                    <span>Break & Tea</span>
                    <span className="text-amber-500">{summaryData?.distribution?.break ?? 0}</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                    <div className="bg-amber-500 h-full rounded-full" style={{ width: `${(summaryData?.distribution?.break / (summaryData?.totalAssigned || 1)) * 100}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-bold text-slate-600 mb-1 leading-none">
                    <span>Lunch Interval</span>
                    <span className="text-[#D97706]">{summaryData?.distribution?.lunch ?? 0}</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                    <div className="bg-[#D97706] h-full rounded-full" style={{ width: `${(summaryData?.distribution?.lunch / (summaryData?.totalAssigned || 1)) * 100}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-bold text-slate-600 mb-1 leading-none">
                    <span>Meeting / Coaching</span>
                    <span className="text-purple-650">{summaryData?.distribution?.meeting ?? 0}</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                    <div className="bg-purple-600 h-full rounded-full" style={{ width: `${(summaryData?.distribution?.meeting / (summaryData?.totalAssigned || 1)) * 100}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-bold text-slate-600 mb-1 leading-none">
                    <span>Offline / Off-Duty</span>
                    <span className="text-slate-400">{summaryData?.distribution?.offline ?? 0}</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                    <div className="bg-slate-300 h-full rounded-full" style={{ width: `${(summaryData?.distribution?.offline / (summaryData?.totalAssigned || 1)) * 100}%` }} />
                  </div>
                </div>
              </div>
            </div>

            {/* Role Dispersion Graph */}
            <div className="lg:col-span-8 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
              <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-widest">
                Team Role Allocation Mapping
              </h4>
              <div className="h-[210px] w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={roleChartData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                    <XAxis dataKey="name" stroke="#64748B" fontSize={11} />
                    <YAxis stroke="#64748B" fontSize={11} />
                    <Tooltip contentStyle={{ borderRadius: '12px', fontSize: '12px' }} />
                    <Bar dataKey="count" fill="#6366F1" radius={[6, 6, 0, 0]} maxBarSize={35} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* QUICK SUPERVISOR TOOLS RAIL */}
            <div className="lg:col-span-12 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-widest mb-4">
                Operational Short-cuts & Quick Actions
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                {/* Only one button here or just remove the correction one */}
                <button 
                  onClick={openAuditLogsModal}
                  className="bg-slate-850 hover:bg-slate-900 border border-slate-700 text-slate-200 p-3 rounded-xl flex items-center justify-center gap-2 text-xs font-extrabold transition-all cursor-pointer"
                >
                  <Calendar size={15} /> View System Trial Logs
                </button>

                <button 
                  onClick={handleSpreadsheetExport}
                  disabled={isExporting}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white p-3 rounded-xl flex items-center justify-center gap-2 text-xs font-extrabold transition-colors cursor-pointer"
                >
                  <FileSpreadsheet size={15} /> Export Workforce Roster State
                </button>

                <button 
                  onClick={() => setActiveTab('exceptions')}
                  className="bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 p-3 rounded-xl flex items-center justify-center gap-2 text-xs font-extrabold transition-colors cursor-pointer"
                >
                  <AlertTriangle size={15} /> Access Diagnostics Center
                </button>

                {hasTmsPermission('can_force_logout') && (
                  <button 
                    onClick={() => setShowBulkLogoutModal(true)}
                    className="bg-rose-600 hover:bg-rose-700 text-white p-3 rounded-xl flex items-center justify-center gap-2 text-xs font-extrabold transition-colors shadow-sm cursor-pointer shadow-rose-300"
                  >
                    <UserX size={15} /> Emergency Bulk Logout
                  </button>
                )}
              </div>
            </div>

          </div>
        )}

        {/* TAB 2: ROSTER WORKFORCE CONTROLS (ADVANCED FILTERS & POWER LIST) */}
        {activeTab === 'controls' && (
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden space-y-4">
            
            {/* Header + Multi filters */}
            <div className="p-5 border-b border-slate-100 space-y-4 bg-slate-50/50">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-black text-slate-900 uppercase tracking-wide">
                    Live Operational Supervision Table
                  </h4>
                  <p className="text-xs text-slate-500">Conduct direct searches, force logout actions, filters and page navigation.</p>
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
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Status Filter</label>
                  <select 
                    value={shiftFilter}
                    onChange={(e) => { setShiftFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 font-bold focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer text-slate-700"
                  >
                    <option value="all">🟢 Status: All</option>
                    <option value="active">🟢 Active Workflow</option>
                    <option value="break">🟠 Rest Breaks</option>
                    <option value="offline">⚪ Offline Staff</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Process Filter</label>
                  <select 
                    value={processFilter}
                    onChange={(e) => { setProcessFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 font-bold focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer text-slate-700"
                  >
                    <option value="all">🚀 Process: All</option>
                    {uniqueActiveProcesses.map(proc => (
                      <option key={proc} value={proc}>{proc}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Team Lead Mapped</label>
                  <select 
                    value={tlFilter}
                    onChange={(e) => { setTlFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 font-bold focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer text-slate-700"
                  >
                    <option value="all">🗺️ Team Lead: All</option>
                    {teamLeadsList.map(tl => (
                      <option key={tl.id} value={tl.id}>{tl.name}</option>
                    ))}
                  </select>
                </div>

                {['ADMIN', 'MANAGER'].includes((user.role || '').toUpperCase()) ? (
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Manager Filter</label>
                    <select 
                      value={managerFilter}
                      onChange={(e) => { setManagerFilter(e.target.value); setCurrentPage(1); }}
                      className="w-full bg-white border border-slate-200 rounded-lg p-2 font-bold focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer text-slate-700"
                    >
                      <option value="all">🏢 Manager: All</option>
                      {managersList.map(mgr => (
                        <option key={mgr.uid} value={mgr.uid}>{mgr.name}</option>
                      ))}
                    </select>
                  </div>
                ) : <div className="hidden sm:block"></div>}

                <div className="col-span-2 sm:col-span-1 flex flex-col justify-end">
                  <button 
                    onClick={() => {
                      setSearchTerm('');
                      setProcessFilter('all');
                      setShiftFilter('all');
                      setTlFilter('all');
                      setManagerFilter('all');
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
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100 text-slate-600 font-black text-[9px] uppercase tracking-wider select-none border-b border-slate-200">
                    <th className="p-4 pl-6 cursor-pointer" onClick={() => { setSortKey('name'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>Employee Name</th>
                    <th className="p-4">Process Mapping</th>
                    <th className="p-4">Current Activity</th>
                    <th className="p-4">Log In Time</th>
                    <th className="p-4 cursor-pointer" onClick={() => { setSortKey('productive'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>Productive Duration</th>
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
                      <tr key={u.uid} className="hover:bg-slate-50 transition-colors">
                        <td className="p-4 pl-6">
                          <div className="font-extrabold text-slate-900 leading-none">{u.name}</div>
                          <div className="text-[10px] font-mono text-slate-400 mt-1 leading-none">{u.email}</div>
                        </td>
                        <td className="p-4">
                          <span className="bg-slate-150/60 font-semibold px-2 py-0.5 rounded text-slate-700">{u.process || 'General'}</span>
                        </td>
                        <td className="p-4 font-semibold text-slate-800">
                          {live ? (lastAct?.name || 'In transition') : <span className="text-slate-400">-</span>}
                        </td>
                        <td className="p-4 text-slate-500 font-mono text-[10px]">
                          {live ? new Date(live.clockInTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : <span className="text-slate-400">Not Clocked</span>}
                        </td>
                        <td className="p-4 font-bold text-teal-600 font-mono">
                          {stats ? stats.activeStr : <span className="text-slate-400 font-normal font-sans text-xs">Offline</span>}
                        </td>
                        <td className="p-4">
                          {live ? (
                            <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase ${live.status === 'BREAK' ? 'bg-amber-150 text-amber-800' : 'bg-emerald-150 text-emerald-800'}`}>
                              {live.status}
                            </span>
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
                    );
                  })}

                  {paginatedWorkforce.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-16 text-center text-slate-400 font-medium font-sans">
                        <UserX size={44} className="mx-auto text-slate-200 mb-2" />
                        No supervised workforce accounts found matching currently selected criteria.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="p-4 border-t border-slate-100 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500">
                  Page {currentPage} of {totalPages} ({filteredWorkforce.length} visible users)
                </span>
                <div className="flex items-center gap-1">
                  <button 
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer transition-colors"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button 
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer transition-colors"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}

          </div>
        )}

        {/* TAB 3: AUDITS & EXCEPTIONS (EXCEPTION CENTER / DATA VALIDATION REPORTS) */}
        {activeTab === 'exceptions' && (
          <div className="space-y-6">
            
            {/* Actionable Exception Center Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Long Breaks Exception */}
              <div className="bg-white border border-rose-200 rounded-2xl p-5 shadow-sm space-y-4">
                <h4 className="text-xs font-extrabold text-rose-700 uppercase tracking-widest flex items-center gap-1.5 leading-none">
                  <Coffee size={14} className="text-rose-500 animate-pulse" /> Active Long Breaks Exception Limit {`> 45 mins`}
                </h4>
                
                <div className="space-y-3.5 max-h-64 overflow-y-auto pt-1.5">
                  {summaryData?.exceptionsList?.longBreaks?.map((item: any, idx: number) => (
                    <div key={idx} className="flex justify-between items-center text-xs bg-rose-50/50 p-2.5 rounded-xl border border-rose-100/60 font-sans">
                      <div>
                        <div className="font-extrabold text-slate-800 leading-tight">{item.userName}</div>
                        <div className="text-[10px] text-rose-600 font-bold mt-1 leading-none">Break: {item.breakName} ({item.durationMins} minutes active)</div>
                      </div>
                      <button 
                        onClick={() => selectAndFocusUser(item.userName)}
                        className="bg-rose-100 hover:bg-rose-200 text-rose-800 text-[10px] font-black px-2.5 py-1 rounded-lg shrink-0 cursor-pointer"
                      >
                        Correct
                      </button>
                    </div>
                  ))}

                  {(!summaryData?.exceptionsList?.longBreaks || summaryData.exceptionsList.longBreaks.length === 0) && (
                    <p className="text-xs text-slate-450 font-medium text-center py-6 select-none uppercase tracking-wide">
                      ✅ No critical long break exceptions registered.
                    </p>
                  )}
                </div>
              </div>

              {/* Idle Users Exception */}
              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
                <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-widest flex items-center gap-1.5 leading-none">
                  <Clock size={14} className="text-orange-500" /> Currently Idle Active Timers {`> 2 hours`}
                </h4>

                <div className="space-y-3.5 max-h-64 overflow-y-auto pt-1.5">
                  {summaryData?.exceptionsList?.idleUsers?.map((item: any, idx: number) => (
                    <div key={idx} className="flex justify-between items-center text-xs bg-slate-50 p-2.5 rounded-xl border border-slate-150 font-sans">
                      <div>
                        <div className="font-extrabold text-slate-800 leading-tight">{item.userName}</div>
                        <div className="text-[10px] text-slate-500 font-bold mt-1 leading-none">Activity: {item.lastActivity} (No update for 2+ hours)</div>
                      </div>
                      <button 
                        onClick={() => selectAndFocusUser(item.userName)}
                        className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[10px] font-black px-2.5 py-1 rounded-lg shrink-0 cursor-pointer"
                      >
                        Force Out / Audit
                      </button>
                    </div>
                  ))}

                  {(!summaryData?.exceptionsList?.idleUsers || summaryData.exceptionsList.idleUsers.length === 0) && (
                    <p className="text-xs text-slate-450 font-medium text-center py-6 select-none uppercase tracking-wide">
                      ✅ No critical idle active exceptions registered.
                    </p>
                  )}
                </div>
              </div>

              {/* Missing Punch Outs Exception */}
              <div className="bg-white border border-indigo-200 rounded-2xl p-5 shadow-sm space-y-4">
                <h4 className="text-xs font-extrabold text-indigo-700 uppercase tracking-widest flex items-center gap-1.5 leading-none">
                  <UserX size={14} className="text-indigo-500 animate-pulse" /> Missing Clock Punch Out Shifts {`> 16 hours`}
                </h4>

                <div className="space-y-3.5 max-h-64 overflow-y-auto pt-1.5">
                  {summaryData?.exceptionsList?.missingPunchOuts?.map((item: any, idx: number) => (
                    <div key={idx} className="flex justify-between items-center text-xs bg-indigo-50/50 p-2.5 rounded-xl border border-indigo-150 font-sans">
                      <div>
                        <div className="font-extrabold text-slate-800 leading-tight">{item.userName}</div>
                        <div className="text-[10px] text-indigo-600 font-bold mt-1 leading-none">Session Clocked-In since: {new Date(item.clockInTime).toLocaleString()}</div>
                      </div>
                      <button 
                        onClick={() => selectAndFocusUser(item.userName)}
                        className="bg-indigo-650 hover:bg-indigo-755 text-white text-[10px] font-black px-2.5 py-1 rounded-lg shrink-0 cursor-pointer"
                      >
                        Force Log Out
                      </button>
                    </div>
                  ))}

                  {(!summaryData?.exceptionsList?.missingPunchOuts || summaryData.exceptionsList.missingPunchOuts.length === 0) && (
                    <p className="text-xs text-slate-450 font-medium text-center py-6 select-none uppercase tracking-wide">
                      ✅ No missing punch-out exceptions active.
                    </p>
                  )}
                </div>
              </div>

              {/* Auto-Closed & Missed Attendance Exceptions */}
              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
                <h4 className="text-xs font-extrabold text-[#D97706] uppercase tracking-widest flex items-center gap-1.5 leading-none">
                  <UserX size={14} className="text-[#D97706]" /> Auto-Closed Sessions & Missing Reports Today
                </h4>

                <div className="space-y-3.5 max-h-64 overflow-y-auto pt-1.5">
                  {summaryData?.exceptionsList?.autoClosed?.map((item: any, idx: number) => (
                    <div key={idx} className="flex justify-between items-center text-xs bg-amber-50/20 p-2.5 rounded-xl border border-amber-100 font-sans">
                      <div>
                        <div className="font-extrabold text-slate-800 leading-tight">{item.userName}</div>
                        <div className="text-[10px] text-[#B45309] font-bold mt-1 leading-none">Session was automatically terminated as stale</div>
                      </div>
                      <button 
                        onClick={() => selectAndFocusUser(item.userName)}
                        className="bg-amber-100 hover:bg-amber-150 text-amber-850 text-[10px] font-black px-2.5 py-1 rounded-lg shrink-0 cursor-pointer"
                      >
                        Audit Profile
                      </button>
                    </div>
                  ))}

                  {summaryData?.exceptionsList?.attendanceExceptions?.map((item: any, idx: number) => (
                    <div key={idx} className="flex justify-between items-center text-xs bg-slate-50 p-2.5 rounded-xl border border-slate-200 font-sans">
                      <div>
                        <div className="font-extrabold text-slate-800 leading-tight">{item.userName}</div>
                        <div className="text-[10px] text-slate-500 font-bold mt-1 leading-none">{item.reason}</div>
                      </div>
                      <button 
                        onClick={() => selectAndFocusUser(item.userName)}
                        className="bg-indigo-600 hover:bg-indigo-750 text-white text-[10px] font-black px-2.5 py-1 rounded-lg shrink-0 cursor-pointer"
                      >
                        Track Member
                      </button>
                    </div>
                  ))}

                  {(!summaryData?.exceptionsList?.autoClosed || summaryData.exceptionsList.autoClosed.length === 0) && 
                   (!summaryData?.exceptionsList?.attendanceExceptions || summaryData.exceptionsList.attendanceExceptions.length === 0) && (
                    <p className="text-xs text-slate-450 font-medium text-center py-6 select-none uppercase tracking-wide">
                      ✅ No missed attendance or auto-closed sessions registered.
                    </p>
                  )}
                </div>
              </div>

            </div>

            {/* DATA ACCURACY VALIDATION DIAGNOSTIC REPORT */}
            <div className="bg-white border border-indigo-200 rounded-3xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                <ShieldAlert className="text-indigo-600" size={20} />
                <div>
                  <h4 className="text-sm font-black text-slate-900 uppercase">
                    Data Accuracy & Integrity Diagnostics report
                  </h4>
                  <p className="text-xs text-slate-500 leading-none mt-1">Automated validation checks executing live structure audits against roster parameters.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                <div className="space-y-3.5">
                  <div>
                    <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Users with Stale Sessions (&gt;24 Hours Running)</h5>
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {summaryData?.validationReport?.staleSessions?.map((item: any, idx: number) => (
                        <div key={idx} className="flex justify-between items-center text-xs p-2.5 bg-yellow-50/50 border border-yellow-200/60 rounded-xl leading-none">
                          <span className="font-extrabold text-slate-800">{item.userName}</span>
                          <span className="text-[10px] text-yellow-700 font-bold font-mono">Running since: {new Date(item.clockInTime).toLocaleDateString()}</span>
                        </div>
                      ))}
                      {(!summaryData?.validationReport?.staleSessions || summaryData.validationReport.staleSessions.length === 0) && (
                        <p className="text-[11px] text-slate-400 font-medium font-sans">No stale sessions active beyond compliance limits.</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Inconsistencies & Profile Mappings</h5>
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {summaryData?.validationReport?.teamInconsistencies?.map((item: any, idx: number) => (
                        <div key={idx} className="text-xs p-2.5 bg-rose-50/30 border border-rose-100 rounded-xl flex justify-between items-center leading-none">
                          <span className="font-extrabold text-slate-800">{item.userName}</span>
                          <span className="text-[10px] text-rose-600 font-bold">{item.issue}</span>
                        </div>
                      ))}
                      {(!summaryData?.validationReport?.teamInconsistencies || summaryData.validationReport.teamInconsistencies.length === 0) && (
                        <p className="text-[11px] text-slate-400 font-medium font-sans">All roster personnel mapped correctly with team anchors.</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Active Clock mismatch anomalies</h5>
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {summaryData?.validationReport?.countMismatches?.map((item: any, idx: number) => (
                        <div key={idx} className="text-xs p-2.5 bg-rose-50/50 border border-rose-200 rounded-xl flex justify-between items-center leading-none">
                          <span className="font-extrabold text-slate-800">Anomaly: {item.metric}</span>
                          <span className="text-[10px] text-rose-600 font-bold font-mono">Dashboard: {item.systemValue} | Real: {item.actualValue}</span>
                        </div>
                      ))}
                      {(!summaryData?.validationReport?.countMismatches || summaryData.validationReport.countMismatches.length === 0) && (
                        <p className="text-[11px] text-slate-400 font-medium font-sans">No clock mismatches or numerical count exceptions resolved.</p>
                      )}
                    </div>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-[11px] leading-relaxed text-slate-600 font-medium font-sans">
                    <p className="font-bold text-slate-800 uppercase tracking-wide mb-1">Health Score Index: 100%</p>
                    Precision360 uses database synchronization rules to preserve relational invariants. If count deviations occur, please click <strong className="text-indigo-600 cursor-pointer" onClick={() => loadAndRecomputeData(true)}>Sync & Audit</strong> to automatically force state updates.
                  </div>
                </div>
              </div>

            </div>

          </div>
        )}

      </div>

      {/* MODAL 1: ATTENDANCE CORRECTION / MANUAL PUNCHES */}
      {showCorrectionModal && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 text-slate-800 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 border border-slate-200 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 border-b pb-3.5">
              <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl">
                <Plus size={20} />
              </div>
              <div className="text-left">
                <h4 className="font-black text-slate-900 text-sm">Attendance Correction Insert</h4>
                <p className="text-slate-450 text-[10px] font-bold">Log direct productive punches on target accounts</p>
              </div>
            </div>

            <form onSubmit={handleAttendanceCorrectionSubmit} className="space-y-4 text-xs font-bold text-slate-600">
              <div className="space-y-1.5 text-left">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Select Employee Profile</label>
                <select
                  value={correctionUserId}
                  onChange={(e) => setCorrectionUserId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer text-slate-800"
                >
                  <option value="">Choose profile...</option>
                  {mappedUsers.map(u => (
                    <option key={u.uid} value={u.uid}>{u.name} ({u.email})</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5 text-left">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Process Name</label>
                <select
                  value={correctionProcess}
                  onChange={(e) => setCorrectionProcess(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer text-slate-800"
                >
                  <option value="HITL">HITL</option>
                  <option value="MPQC">MPQC</option>
                  <option value="OQC">OQC</option>
                  <option value="SOP Training">SOP Training</option>
                  <option value="QA Review">QA Review</option>
                </select>
              </div>

              <div className="space-y-1.5 text-left">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Correction Date</label>
                <input 
                  type="date"
                  value={correctionDate}
                  onChange={(e) => setCorrectionDate(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs font-bold focus:outline-none text-slate-800"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5 text-left">
                  <label className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Clock In time</label>
                  <input 
                    type="time" 
                    value={correctionClockIn}
                    onChange={(e) => setCorrectionClockIn(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs font-bold focus:outline-none text-slate-800"
                  />
                </div>
                <div className="space-y-1.5 text-left">
                  <label className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Clock Out time</label>
                  <input 
                    type="time" 
                    value={correctionClockOut}
                    onChange={(e) => setCorrectionClockOut(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs font-bold focus:outline-none text-slate-800"
                  />
                </div>
              </div>

              <div className="space-y-1.5 text-left">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Approval Reason / Remarks</label>
                <textarea
                  value={correctionRemarks}
                  onChange={(e) => setCorrectionRemarks(e.target.value)}
                  placeholder="Enter supervisor justification remarks..."
                  className="w-full bg-slate-50 border border-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 rounded-xl p-3 text-xs font-bold text-slate-800 h-20"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCorrectionModal(false)}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 py-2.5 rounded-xl font-bold cursor-pointer transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingCorrection}
                  className="bg-indigo-600 hover:bg-indigo-755 text-white py-2.5 rounded-xl font-black cursor-pointer transition-colors disabled:opacity-50"
                >
                  {isSavingCorrection ? 'Inserting punch...' : 'Apply Correction'}
                </button>
              </div>
            </form>
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
