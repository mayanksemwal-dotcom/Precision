import React, { useState, useEffect, useRef } from 'react';
import { 
  Clock, 
  Play, 
  Coffee, 
  LogOut, 
  RefreshCw, 
  User, 
  Trash2, 
  Plus, 
  Search, 
  CheckCircle, 
  History, 
  AlertCircle,
  FileSpreadsheet,
  Activity,
  Award,
  ChevronLeft,
  ChevronRight,
  Edit2
} from 'lucide-react';
import ProcessSelector from '../components/ProcessSelector';
import SupervisorDashboard from '../components/tms/SupervisorDashboard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '../components/ui/card';

import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { toast } from 'sonner';
import { usePermission } from '../components/PermissionContext';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import { 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  collection, 
  query, 
  where, 
  orderBy, 
  addDoc, 
  updateDoc, 
  deleteDoc,
  serverTimestamp,
  getDocs,
  limit
} from 'firebase/firestore';
import { UserProfile, UserRole } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
import { canActOn } from '../lib/hierarchy';
// No Sheets imports

interface TMSViewProps {
  user: UserProfile;
  allUsers: UserProfile[];
}

export interface ShiftActivity {
  type: 'productive' | 'break';
  name: string; // e.g. HITL, Lunch
  startTime: string; // ISO
  endTime?: string; // ISO (undefined if active)
}

export interface TMSShift {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  clockInTime: string; // ISO
  clockOutTime?: string; // ISO
  activities: ShiftActivity[];
  status: 'ACTIVE' | 'BREAK' | 'COMPLETED';
}

const DEFAULT_PROCESSES = ['HITL', 'MPQC', 'OQC', 'SOP Training', 'QA Review', 'Team Alignment'];
const BREAK_OPTIONS = [
  'Lunch Break', 
  'Tea/Coffee Break', 
  'Short Rest Break', 
  'Training/Coaching Session', 
  'Team Meeting', 
  'Bio Break'
];

export default function TMSView({ user, allUsers }: TMSViewProps) {
  const { canView, canCreate, canEdit, canDelete, hasTmsPermission } = usePermission();
  
  // Dynamic granular permission bindings instead of monolithic role/module checks
  const isManagerRole = hasTmsPermission('can_close_sessions'); 
  const canManageTMS = hasTmsPermission('can_edit_tms_records'); 
  const canModifyTMS = hasTmsPermission('can_edit_tms_records');
  const canDeleteTMS = hasTmsPermission('can_close_sessions');
  const canViewReports = hasTmsPermission('view_workforce_dashboard');

  // Configured processes in the app
  const [processes, setProcesses] = useState<string[]>([]);
  const [recentProcesses, setRecentProcesses] = useState<string[]>(
    JSON.parse(localStorage.getItem('tms_recent_processes') || '[]')
  );
  const [favoriteProcesses, setFavoriteProcesses] = useState<string[]>(
    JSON.parse(localStorage.getItem('tms_favorite_processes') || '[]')
  );
  
  const [newProcessName, setNewProcessName] = useState('');
  const [tmsSearch, setTmsSearch] = useState('');
  const toggleFavorite = (process: string) => {
    const newFavorites = favoriteProcesses.includes(process)
      ? favoriteProcesses.filter(p => p !== process)
      : [...favoriteProcesses, process];
    setFavoriteProcesses(newFavorites);
    localStorage.setItem('tms_favorite_processes', JSON.stringify(newFavorites));
  };
  
  const updateRecent = (process: string) => {
    const newRecent = [process, ...recentProcesses.filter(p => p !== process)].slice(0, 5);
    setRecentProcesses(newRecent);
    localStorage.setItem('tms_recent_processes', JSON.stringify(newRecent));
  };

  const [processing, setProcessing] = useState(false);
  
  // Real-time user's shift state
  const [currentShift, setCurrentShift] = useState<TMSShift | null>(null);
  const [myPastShifts, setMyPastShifts] = useState<TMSShift[]>([]);
  
  // Admin view variables
  const [allShifts, setAllShifts] = useState<TMSShift[]>([]);
  const [adminSearch, setAdminSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedProcessInput, setSelectedProcessInput] = useState('');
  const [selectedBreakInput, setSelectedBreakInput] = useState(BREAK_OPTIONS[0]);
  const [activeShiftFilter, setActiveShiftFilter] = useState('all');
  const [editingProcessName, setEditingProcessName] = useState<string | null>(null);
  const [editingProcessValue, setEditingProcessValue] = useState<string>('');

  // Custom modal confirmations instead of window.confirm inside sandboxed iframe
  const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);
  const [confirmDeleteProcessName, setConfirmDeleteProcessName] = useState<string | null>(null);

  // Force Logout States
  const [forceOutShiftId, setForceOutShiftId] = useState<string | null>(null);
  const [forceOutTargetName, setForceOutTargetName] = useState<string>('');
  const [forceOutTargetUid, setForceOutTargetUid] = useState<string>('');
  const [forceOutReason, setForceOutReason] = useState<string>('Left without logging out');
  const [forceOutCustomReason, setForceOutCustomReason] = useState<string>('');

  // Hierarchy validation helper
  const canUserForceLogoutTarget = (actor: UserProfile, targetUid: string) => {
    if (actor.uid === targetUid) return false;
    
    const target = allUsers.find(u => u.uid === targetUid);
    if (!target) return false;

    // Use granular key permission check and hierarchy check
    if (!hasTmsPermission('can_force_logout')) return false;

    return canActOn(actor, target, allUsers);
  };

  // Date Range and Format selection states for reports
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportType, setExportType] = useState<'team' | 'organization' | null>(null);
  const [selectedRangePreset, setSelectedRangePreset] = useState<string>('last30');
  const [startDateStr, setStartDateStr] = useState<string>('');
  const [endDateStr, setEndDateStr] = useState<string>('');
  const [exportFormat, setExportFormat] = useState<'csv' | 'excel'>('excel');
  const [reportType, setReportType] = useState<'summary' | 'chronological' | 'both'>('both');

  // Fallback to summary if CSV format is selected since CSV is single sheet
  useEffect(() => {
    if (exportFormat === 'csv' && reportType === 'both') {
      setReportType('summary');
    }
  }, [exportFormat, reportType]);
  
  // System timer ticker
  const [currentTime, setCurrentTime] = useState(new Date());
  const [elapsedActive, setElapsedActive] = useState('00:00:00');
  const [elapsedBreak, setElapsedBreak] = useState('00:00:00');
  const [elapsedShift, setElapsedShift] = useState('00:00:00');

  // Trigger real-time ticking clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch Processes Config in Real-time from config/tmsProcesses document
  useEffect(() => {
    if (!user) return;
    const unsub = onSnapshot(doc(db, 'config', 'tmsProcesses'), (snap) => {
      let activeList: string[] = [];
      if (snap.exists() && Array.isArray(snap.data()?.list)) {
        activeList = snap.data()?.list;
      }
      if (activeList.length > 0) {
        setProcesses(activeList);
      } else {
        setProcesses(DEFAULT_PROCESSES);
      }
    }, (err) => {
      console.warn('Failed to subscribe to config/tmsProcesses, using local defaults', err);
      setProcesses(prev => prev.length > 0 ? prev : DEFAULT_PROCESSES);
    });
    return () => unsub();
  }, [user]);

  // Fetch User's Personal Shifts & Current Active Shift
  useEffect(() => {
    if (!user) return;
    const qMyShifts = query(
      collection(db, 'tmsShifts'),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(qMyShifts, (snapshot) => {
      const shifts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TMSShift));
      
      // Sort shifts by clockInTime desc
      shifts.sort((a, b) => new Date(b.clockInTime).getTime() - new Date(a.clockInTime).getTime());
      
      setMyPastShifts(shifts);

      // Find if there's any active shift (status ACTIVE or BREAK)
      const active = shifts.find(s => s.status === 'ACTIVE' || s.status === 'BREAK');
      if (active) {
        setCurrentShift(active);
        // Default select previous active process if available
        const lastProductive = [...active.activities]
          .reverse()
          .find(act => act.type === 'productive');
        if (lastProductive && !selectedProcessInput) {
          setSelectedProcessInput(lastProductive.name);
        }
      } else {
        setCurrentShift(null);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'tmsShifts');
    });

    return () => unsubscribe();
  }, [user]);

  const getDateRange = (preset: string, customStart?: string, customEnd?: string) => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    let start = new Date(startOfToday);
    let end = new Date(endOfToday);

    switch (preset) {
      case 'today':
        break;
      case 'yesterday':
        start.setDate(start.getDate() - 1);
        end.setDate(end.getDate() - 1);
        break;
      case 'last7':
        start.setDate(start.getDate() - 6);
        break;
      case 'last30':
        start.setDate(start.getDate() - 29);
        break;
      case 'currentMonth':
        start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        break;
      case 'previousMonth':
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
        end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
        break;
      case 'custom':
        if (customStart) start = new Date(customStart + 'T00:00:00');
        if (customEnd) end = new Date(customEnd + 'T23:59:59');
        break;
    }
    return { start, end };
  };

  // Fetch ALL Shifts for Admins, Managers or Team Leads in real-time to view workforce status
  const fetchAllShifts = async () => {
    // Shifts are managed in real-time via the useEffect's onSnapshot subscription
  };

  useEffect(() => {
    if (!user || !canViewReports) return;
    const qAllShifts = query(collection(db, 'tmsShifts'), orderBy('clockInTime', 'desc'));
    const unsubscribe = onSnapshot(qAllShifts, (snap) => {
      const shifts = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as TMSShift));
      setAllShifts(shifts);
    }, (error) => {
      console.warn('Failed real-time subscription to tmsShifts', error);
    });
    return () => unsubscribe();
  }, [user, canViewReports]);

  const startForceLogoutFlow = (shiftId: string, targetUid: string, targetName: string) => {
    setForceOutShiftId(shiftId);
    setForceOutTargetUid(targetUid);
    setForceOutTargetName(targetName);
    setForceOutReason('Left without logging out');
    setForceOutCustomReason('');
  };

  const performAdminClockOut = async () => {
    if (!forceOutShiftId) return;
    try {
      const shiftRef = doc(db, 'tmsShifts', forceOutShiftId);
      const shiftSnap = await getDoc(shiftRef);
      if (!shiftSnap.exists()) {
        toast.error('Shift not found');
        return;
      }
      const shift = shiftSnap.data() as TMSShift;
      const nowISO = new Date().toISOString();
      const updatedActivities = [...shift.activities];
      const lastActivity = updatedActivities.length > 0 
        ? updatedActivities[updatedActivities.length - 1].name 
        : 'Unknown Process';
        
      if (updatedActivities.length > 0) {
        updatedActivities[updatedActivities.length - 1].endTime = nowISO;
      }

      // Apply selected / custom reason
      const finalReason = forceOutReason === 'other' 
        ? (forceOutCustomReason.trim() || 'Forced logout by supervisor')
        : forceOutReason;

      // Update shift to COMPLETED
      await updateDoc(shiftRef, {
        activities: updatedActivities,
        clockOutTime: nowISO,
        status: 'COMPLETED'
      });

      // 0. Update User Status to Offline in users collection
      const userRef = doc(db, 'users', forceOutTargetUid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        await updateDoc(userRef, {
          status: 'OFFLINE',
          lastLogoutAt: nowISO
        });
      }

      // 1. Audit log process creation/alteration
      const logId = `tms-forcelogout-${Date.now()}`;
      await setDoc(doc(db, 'uploadAuditLogs', logId), {
        id: logId,
        targetId: forceOutTargetUid,
        entityType: 'user_shift',
        fieldName: 'status',
        oldValue: 'ACTIVE/BREAK',
        newValue: 'COMPLETED_FORCED',
        updatedBy: user.uid,
        updatedByName: user.name,
        updatedAt: nowISO,
        action: 'force_logout',
        details: `Force Logout executed. User Forced Out: ${forceOutTargetName} (${shift.userEmail}). Forced By: ${user.name} (${user.email}). Reason: ${finalReason}. Current Activity at logout: ${lastActivity}.`
      });

      // 2. Also add to adminAuditLogs to be fully aligned with general compliance dashboard
      const adminLogId = `wt-audit-${Date.now()}`;
      await setDoc(doc(db, 'adminAuditLogs', adminLogId), {
        timestamp: nowISO,
        action: 'Force Logout',
        performedBy: `${user.name} (${user.email})`,
        affectedUser: `${forceOutTargetName} (${shift.userEmail})`,
        previousValue: 'ACTIVE/BREAK',
        newValue: 'COMPLETED_FORCED',
        remarks: `Supervisor executed force logout. Reason: ${finalReason}`,
        details: {
          shiftId: forceOutShiftId,
          targetUid: forceOutTargetUid,
          reason: finalReason,
          currentActivityAtLogout: lastActivity
        }
      });

      toast.success(`Successfully forced clock-out for ${forceOutTargetName}.`);
      
      // Clean up modal states
      setForceOutShiftId(null);
      setForceOutTargetUid('');
      setForceOutTargetName('');
      setForceOutReason('Left without logging out');
      setForceOutCustomReason('');

      await fetchAllShifts();
    } catch (e) {
      console.error('[TMS FORCE LOGOUT ERROR]', e);
      handleFirestoreError(e, OperationType.WRITE, 'tmsShifts');
    }
  };

  // Trigger cleanup for managers on mount
  useEffect(() => {
    fetchAllShifts();
    if (isManagerRole) {
      import('../services/tmsCleanupService').then(service => {
        service.performTmsStaleSessionCleanup();
      });
    }
  }, []);

  const saveShiftState = async (updatedShift: TMSShift) => {
    await setDoc(doc(db, 'tmsShifts', updatedShift.id), updatedShift);
  };

  const saveProcessesList = async (updatedList: string[]) => {
    await setDoc(doc(db, 'config', 'tmsProcesses'), { list: updatedList }, { merge: true });
  };

  // Handle ticking timers for currently active shift
  useEffect(() => {
    if (!currentShift) return;

    const interval = setInterval(() => {
      const now = new Date().getTime();
      const inTime = new Date(currentShift.clockInTime).getTime();
      
      // 1. Shift duration
      const totalShiftMs = now - inTime;
      setElapsedShift(formatMs(totalShiftMs));

      // 2. Compute Productive & Break times
      let activeMs = 0;
      let breakMs = 0;

      currentShift.activities.forEach(act => {
        const start = new Date(act.startTime).getTime();
        const end = act.endTime ? new Date(act.endTime).getTime() : now;
        const duration = end - start;
        if (act.type === 'productive') {
          activeMs += duration;
        } else {
          breakMs += duration;
        }
      });

      setElapsedActive(formatMs(activeMs));
      setElapsedBreak(formatMs(breakMs));
    }, 1000);

    return () => clearInterval(interval);
  }, [currentShift]);

  // Helper: Format Milliseconds to HH:MM:SS
  const formatMs = (ms: number): string => {
    if (ms <= 0 || isNaN(ms)) return '00:00:00';
    const totalSecs = Math.floor(ms / 1000);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Helper: Format ISO timestamp to hh:mm AM/PM in IST
  const formatTimeStr = (isoStr: string) => {
    if (!isoStr) return 'N/A';
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit', 
        hour12: true,
        timeZone: 'Asia/Kolkata' 
      });
    } catch {
      return 'N/A';
    }
  };

  // Helper: Format ISO timestamp to Date string in IST (DD/MM/YYYY)
  const formatDateStr = (isoStr: string) => {
    if (!isoStr) return 'N/A';
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
      });
    } catch {
      return 'N/A';
    }
  };

  // Switch/Punch Shift Operations:
  const handleClockIn = async () => {
    if (!hasTmsPermission('can_punch_in')) {
      toast.error('Access Denied: You do not have permissions to Punch In.');
      return;
    }

    const targetProcess = selectedProcessInput || (processes.length > 0 ? processes[0] : '');
    if (!targetProcess) {
      toast.error('Please select a starting process before Clocking In.');
      return;
    }

    if (currentShift) {
      toast.error('Action Blocked: You already have an active shift running.');
      return;
    }

    try {
      const nowISO = new Date().toISOString();
      const newShift: TMSShift = {
        id: `shift-${user.uid || 'anon'}-${Date.now()}`,
        userId: user.uid || '',
        userName: user.name || 'Anonymous User',
        userEmail: user.email || '',
        clockInTime: nowISO,
        status: 'ACTIVE',
        activities: [
          {
            type: 'productive',
            name: targetProcess,
            startTime: nowISO
          }
        ]
      };

      // 0. Update User Status to Online in users collection
      const userRef = doc(db, 'users', user.uid);
      await updateDoc(userRef, {
        status: 'ONLINE',
        lastLoginAt: nowISO
      });

      await saveShiftState(newShift);
      setSelectedProcessInput(targetProcess);
      toast.success(`Clocked In successfully! Process: ${targetProcess}`);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'tmsShifts');
    }
  };

  const handleSwitchProcess = async (targetProcess: string) => {
    if (!hasTmsPermission('can_switch_process')) {
      toast.error('Access Denied: You do not have permissions to Switch Processes.');
      return;
    }

    if (!currentShift) return;
    if (currentShift.status === 'BREAK') {
      toast.error('Cannot switch processes while on a break. Please Resume Work first.');
      return;
    }

    // Find active activity
    const lastActivity = currentShift.activities[currentShift.activities.length - 1];
    if (lastActivity && lastActivity.type === 'productive' && lastActivity.name === targetProcess) {
      toast.warning(`You are already actively working on ${targetProcess}.`);
      return;
    }

    try {
      const nowISO = new Date().toISOString();
      const updatedActivities = [...currentShift.activities];
      
      // Terminate last activity
      if (updatedActivities.length > 0) {
        updatedActivities[updatedActivities.length - 1].endTime = nowISO;
      }

      // Add new active process segment
      updatedActivities.push({
        type: 'productive',
        name: targetProcess,
        startTime: nowISO
      });

      await saveShiftState({
        ...currentShift,
        activities: updatedActivities,
        status: 'ACTIVE'
      });

      setSelectedProcessInput(targetProcess);
      updateRecent(targetProcess);
      toast.success(`Process switched to: ${targetProcess}`);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'tmsShifts');
    }
  };

  const handleStartBreak = async () => {
    if (!currentShift) return;
    if (currentShift.status === 'BREAK') {
      toast.error('You are already on a break.');
      return;
    }

    const breakType = selectedBreakInput || '';
    const isLunch = breakType.toLowerCase().includes('lunch');
    const isMeeting = breakType.toLowerCase().includes('meeting') || breakType.toLowerCase().includes('coaching') || breakType.toLowerCase().includes('training');

    if (isLunch) {
      if (!hasTmsPermission('can_start_lunch')) {
        toast.error('Access Denied: You do not have permission to Start Lunch.');
        return;
      }
    } else if (isMeeting) {
      if (!hasTmsPermission('can_start_meeting')) {
        toast.error('Access Denied: You do not have permission to Start Meetings/Trainings.');
        return;
      }
    } else {
      if (!hasTmsPermission('can_start_break')) {
        toast.error('Access Denied: You do not have permission to Start Breaks.');
        return;
      }
    }

    try {
      const nowISO = new Date().toISOString();
      const updatedActivities = [...currentShift.activities];
      
      // Terminate last active segment
      if (updatedActivities.length > 0) {
        updatedActivities[updatedActivities.length - 1].endTime = nowISO;
      }

      // Add new break segment
      updatedActivities.push({
        type: 'break',
        name: selectedBreakInput,
        startTime: nowISO
      });

      await saveShiftState({
        ...currentShift,
        activities: updatedActivities,
        status: 'BREAK'
      });

      toast.success(`Break started: ${selectedBreakInput}`);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'tmsShifts');
    }
  };

  const handleResumeWork = async (resumeProcess: string) => {
    if (!currentShift) return;
    if (currentShift.status !== 'BREAK') {
      toast.error('You are already working.');
      return;
    }
    if (!resumeProcess) {
      toast.error('Please select a process to resume working on.');
      return;
    }

    // Find the break activity we are currently on to see which resume permission we need
    const lastActivity = currentShift.activities[currentShift.activities.length - 1];
    const breakName = lastActivity ? (lastActivity.name || '') : '';
    const isLunch = breakName.toLowerCase().includes('lunch');
    const isMeeting = breakName.toLowerCase().includes('meeting') || breakName.toLowerCase().includes('coaching') || breakName.toLowerCase().includes('training');

    if (isLunch) {
      if (!hasTmsPermission('can_end_lunch')) {
        toast.error('Access Denied: You do not have permission to End Lunch.');
        return;
      }
    } else if (isMeeting) {
      if (!hasTmsPermission('can_end_meeting')) {
        toast.error('Access Denied: You do not have permission to End Meetings/Trainings.');
        return;
      }
    } else {
      if (!hasTmsPermission('can_end_break')) {
        toast.error('Access Denied: You do not have permission to End Breaks.');
        return;
      }
    }

    try {
      const nowISO = new Date().toISOString();
      const updatedActivities = [...currentShift.activities];
      
      // Terminate break segment
      if (updatedActivities.length > 0) {
        updatedActivities[updatedActivities.length - 1].endTime = nowISO;
      }

      // Add new active segment
      updatedActivities.push({
        type: 'productive',
        name: resumeProcess,
        startTime: nowISO
      });

      await saveShiftState({
        ...currentShift,
        activities: updatedActivities,
        status: 'ACTIVE'
      });

      setSelectedProcessInput(resumeProcess);
      updateRecent(resumeProcess);
      toast.success(`Resumed work on process: ${resumeProcess}`);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'tmsShifts');
    }
  };

  const handleClockOut = () => {
    if (!hasTmsPermission('can_punch_out')) {
      toast.error('Access Denied: You do not have permission to Clock Out.');
      return;
    }
    if (!currentShift) return;
    setShowClockOutConfirm(true);
  };

  const performClockOut = async () => {
    if (!currentShift) return;
    try {
      const nowISO = new Date().toISOString();
      const updatedActivities = [...currentShift.activities];
      
      // Terminate last activity
      if (updatedActivities.length > 0) {
        updatedActivities[updatedActivities.length - 1].endTime = nowISO;
      }

      await saveShiftState({
        ...currentShift,
        activities: updatedActivities,
        clockOutTime: nowISO,
        status: 'COMPLETED'
      });

      // Update User Status to Offline
      const userRef = doc(db, 'users', user.uid);
      await updateDoc(userRef, {
        status: 'OFFLINE',
        lastLogoutAt: nowISO
      });

      toast.success('Clocked Out successfully. Shift recorded.');
      setCurrentShift(null);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'tmsShifts');
    }
  };

  // Math: Calculate utilization metrics for a given shift
  const computeShiftStats = (shift: TMSShift) => {
    const endMs = shift.clockOutTime 
      ? new Date(shift.clockOutTime).getTime() 
      : new Date().getTime();
    const startMs = new Date(shift.clockInTime).getTime();
    
    // Total elapsed duration
    const totalShiftMs = Math.max(0, endMs - startMs);
    
    let activeMs = 0;
    let breakMs = 0;

    shift.activities.forEach(act => {
      const aStart = new Date(act.startTime).getTime();
      const aEnd = act.endTime ? new Date(act.endTime).getTime() : endMs;
      const duration = Math.max(0, aEnd - aStart);
      if (act.type === 'productive') {
        activeMs += duration;
      } else {
        breakMs += duration;
      }
    });

    // Utilization calculated as: (Productive / Shift duration) * 100
    // If shift is extremely short, treat as 100% or 0%
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

  // Admin Process configuration handlers:
  const handleAddProcess = async () => {
    if (!newProcessName.trim()) {
      toast.error('Process name cannot be empty.');
      return;
    }

    if (processes.includes(newProcessName.trim())) {
      toast.error('This process already exists.');
      return;
    }

    setProcessing(true);
    try {
      const updatedList = [...processes, newProcessName.trim()];
      await saveProcessesList(updatedList);
      
      // Audit log process creation
      const logId = `log-process-${Date.now()}`;
      await setDoc(doc(db, 'uploadAuditLogs', logId), {
        id: logId,
        targetId: 'tmsProcesses',
        entityType: 'process',
        fieldName: 'list',
        oldValue: JSON.stringify(processes),
        newValue: JSON.stringify(updatedList),
        updatedBy: user.uid,
        updatedByName: user.name,
        updatedAt: new Date().toISOString(),
        action: 'create_process',
        details: `Process "${newProcessName.trim()}" created.`
      });
      console.log(`[PROCESS CREATION] Process "${newProcessName.trim()}" successfully created by User ${user.name} (${user.email}) at ${new Date().toISOString()}`);

      setNewProcessName('');
      toast.success('New process added to console.');
    } catch (e) {
      console.error(`[PROCESS CREATION FAILURE] Error code: `, e);
      handleFirestoreError(e, OperationType.WRITE, 'config/tmsProcesses');
    } finally {
      setProcessing(false);
    }
  };

  const handleDeleteProcess = (procToDelete: string) => {
    setConfirmDeleteProcessName(procToDelete);
  };

  const performDeleteProcess = async (procToDelete: string) => {
    try {
      const updatedList = processes.filter(p => p !== procToDelete);
      await saveProcessesList(updatedList);
      setProcesses(updatedList);

      // Audit log process deletion
      const logId = `log-process-${Date.now()}`;
      await setDoc(doc(db, 'uploadAuditLogs', logId), {
        id: logId,
        targetId: 'tmsProcesses',
        entityType: 'process',
        fieldName: 'list',
        oldValue: JSON.stringify(processes),
        newValue: JSON.stringify(updatedList),
        updatedBy: user.uid,
        updatedByName: user.name,
        updatedAt: new Date().toISOString(),
        action: 'delete_process',
        details: `Process "${procToDelete}" deleted.`
      });
      console.log(`[PROCESS DELETION] Process "${procToDelete}" successfully deleted by User ${user.name} (${user.email}) at ${new Date().toISOString()}`);

      toast.success('Process deleted successfully.');
    } catch (e) {
      console.error(`[PROCESS DELETION FAILURE] Error code: `, e);
      handleFirestoreError(e, OperationType.WRITE, 'config/tmsProcesses');
    }
  };

  const handleSaveEditProcess = async (oldName: string) => {
    const trimmed = editingProcessValue.trim();
    if (!trimmed) {
      toast.error('Process name cannot be blank.');
      return;
    }
    if (processes.includes(trimmed) && trimmed !== oldName) {
      toast.error('A process with this name already exists.');
      return;
    }

    try {
      const updatedList = processes.map(p => p === oldName ? trimmed : p);
      await saveProcessesList(updatedList);
      setProcesses(updatedList);
      setEditingProcessName(null);
      setEditingProcessValue('');

      // Audit log process update
      const logId = `log-process-${Date.now()}`;
      await setDoc(doc(db, 'uploadAuditLogs', logId), {
        id: logId,
        targetId: 'tmsProcesses',
        entityType: 'process',
        fieldName: 'list',
        oldValue: JSON.stringify(processes),
        newValue: JSON.stringify(updatedList),
        updatedBy: user.uid,
        updatedByName: user.name,
        updatedAt: new Date().toISOString(),
        action: 'edit_process',
        details: `Process updated from "${oldName}" to "${trimmed}".`
      });
      console.log(`[PROCESS UPDATE] Process successfully changed from "${oldName}" to "${trimmed}" by User ${user.name} (${user.email})`);

      toast.success(`Successfully updated process name to "${trimmed}".`);
    } catch (e) {
      console.error('[TMS SAVE EDIT PROCESS ERROR]', e);
      toast.error('Failed to update process name.');
    }
  };

  const isDashboardUser = [UserRole.TEAM_LEAD, UserRole.QTL, UserRole.STL, UserRole.OPS_TL, UserRole.TRAINER_TL, UserRole.MANAGER, UserRole.ADMIN, UserRole.MIS].includes(user.role as UserRole);

  if (isDashboardUser) {
    return (
      <SupervisorDashboard 
        user={user} 
        allUsers={allUsers} 
        onRefreshAllData={fetchAllShifts}
      />
    );
  }

  function ___ignored_old_supervisor_logic___() {
    let mappedUsers: any[] = [];
    
    // Use canActOn to filter who we can see in our report, excluding inactive users
    mappedUsers = allUsers.filter(u => u.uid !== user.uid && u.status === 'Active' && canActOn(user, u, allUsers));

    console.log('--- TMS Dashboard Mapping Debug ---');
    console.log('Can View Reports:', canViewReports);
    console.log('Mapped Users Found:', mappedUsers.map(u => ({ email: u.email, role: u.role })));
    console.log('Query Results Count:', mappedUsers.length);
    console.log('-----------------------------------');

    // Single Source of Truth: Active Shifts
    // A shift is active/logged in if it is not COMPLETED
    const activeShiftsList = allShifts.filter(sh => {
        const isMappedUser = mappedUsers.some(mu => mu.uid === sh.userId);
        const isSessionRunning = sh.status !== 'COMPLETED';
        
        // Define stale: ACTIVE/BREAK but clockInTime > 24 hours ago
        const isStale = isSessionRunning && (new Date().getTime() - new Date(sh.clockInTime).getTime() > 24 * 60 * 60 * 1000);
        
        if (isMappedUser && isSessionRunning && !isStale) {
           return true; 
        }
        
        // Trigger background cleanup for stale sessions
        if (isMappedUser && isStale) {
            // Note: In real production, this would be a cloud function.
            // For now, we perform local cleanup or just exclude from count
            console.log(`[TMS ALERT] Found stale shift for ${sh.userName}: ${sh.id}`);
            // autoCloseSession(sh.id); // Potential future implementation
        }
        return false;
    });
    
    const currentActiveCount = activeShiftsList.length;

    let totalActiveMs = 0;
    let totalShiftMs = 0;
    const mappedShifts = allShifts.filter(sh => mappedUsers.some(mu => mu.uid === sh.userId));
    mappedShifts.forEach(sh => {
      const stats = computeShiftStats(sh);
      totalActiveMs += stats.activeMs;
      totalShiftMs += stats.totalShiftMs;
    });
    const teamAvgUtilization = totalShiftMs > 0 
      ? Number(((totalActiveMs / totalShiftMs) * 100).toFixed(1)) 
      : 100;

    const handleExportCSV = () => {
      setExportType('team');
      setSelectedRangePreset('last30');
      setStartDateStr('');
      setEndDateStr('');
      setExportFormat('excel');
      setReportType('both');
      setShowExportModal(true);
    };

    const executeTeamExport = (
      start: Date, 
      end: Date, 
      format: 'csv' | 'excel', 
      fetchedShifts: TMSShift[],
      selectedReportType: 'summary' | 'chronological' | 'both' = 'both'
    ) => {
      if (mappedUsers.length === 0) {
        toast.error("No mapped agents to export");
        return;
      }

      const isTodayOnly = start.toDateString() === end.toDateString() && start.toDateString() === new Date().toDateString();
      const includeSummary = selectedReportType === 'summary' || selectedReportType === 'both';
      const includeChrono = selectedReportType === 'chronological' || selectedReportType === 'both';

      const summaryHeaders = [
        'Agent Name',
        'Agent Email',
        'Role',
        isTodayOnly ? 'Live Status' : 'Period Status',
        'Process/Break',
        'Shift Count in Period',
        'Period Start (First Clock In)',
        'Period End (Last Clock Out)',
        'Total Shift Time (Min)',
        'Total Productive Time (Min)',
        'Total Break Time (Min)',
        'Range Utilization (%)'
      ];

      // Filter fetchedShifts strictly by range and user mapping
      const teamUserIds = mappedUsers.map(u => u.uid);
      const teamRangeShifts = fetchedShifts.filter(sh => {
        const clockInDate = new Date(sh.clockInTime);
        const isInRange = clockInDate >= start && clockInDate <= end;
        return isInRange && teamUserIds.includes(sh.userId);
      });

      const summaryRows = includeSummary ? mappedUsers.map(u => {
        const userShifts = fetchedShifts.filter(sh => sh.userId === u.uid);
        const activeShift = userShifts.find(sh => sh.status === 'ACTIVE' || sh.status === 'BREAK');
        
        const rangeShifts = userShifts.filter(sh => {
          const clockInDate = new Date(sh.clockInTime);
          return clockInDate >= start && clockInDate <= end;
        });

        let currentStatus = 'Offline';
        let currentProcess = 'None';
        
        if (activeShift) {
          currentStatus = activeShift.status === 'BREAK' ? 'On Break' : 'Active Work';
          const lastAct = activeShift.activities[activeShift.activities.length - 1];
          currentProcess = lastAct ? lastAct.name : 'N/A';
        } else if (rangeShifts.length > 0) {
          currentStatus = 'Completed';
          const lastS = rangeShifts[rangeShifts.length - 1];
          const lastAct = lastS.activities[lastS.activities.length - 1];
          currentProcess = lastAct ? lastAct.name : 'N/A';
        }

        const sortedRangeShifts = [...rangeShifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());
        const firstShift = sortedRangeShifts[0];
        const lastShift = sortedRangeShifts[sortedRangeShifts.length - 1];

        const clockInTime = firstShift ? new Date(firstShift.clockInTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : 'N/A';
        const clockOutTime = lastShift ? (lastShift.clockOutTime ? new Date(lastShift.clockOutTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : 'Ongoing') : 'N/A';

        let totalShiftMins = 0;
        let totalProductiveMins = 0;
        let totalBreakMins = 0;
        let overallUtil = 0;

        let totalShiftMsSum = 0;
        let totalActiveMsSum = 0;

        rangeShifts.forEach(sh => {
          const stats = computeShiftStats(sh);
          totalShiftMsSum += stats.totalShiftMs;
          totalActiveMsSum += stats.activeMs;
          totalShiftMins += stats.totalShiftMs / (60 * 1000);
          totalProductiveMins += stats.activeMs / (60 * 1000);
          totalBreakMins += stats.breakMs / (60 * 1000);
        });

        if (totalShiftMsSum > 0) {
          overallUtil = Number(((totalActiveMsSum / totalShiftMsSum) * 100).toFixed(1));
        }

        return [
          u.name,
          u.email,
          u.role,
          currentStatus,
          currentProcess,
          rangeShifts.length,
          clockInTime,
          clockOutTime,
          totalShiftMins.toFixed(1),
          totalProductiveMins.toFixed(1),
          totalBreakMins.toFixed(1),
          rangeShifts.length > 0 ? (overallUtil + '%') : '0%'
        ];
      }) : [];

      const chronoHeaders = [
        'Agent Name',
        'Agent Email',
        'Date (IST)',
        'Action Sequence',
        'Duration Type',
        'Specific Activity / Break Type',
        'Start Time (IST)',
        'End Time (IST)',
        'Duration (Mins)'
      ];

      const buildChronoRows = (shifts: TMSShift[]) => {
        const chronoRows: any[] = [];
        const sortedShifts = [...shifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());

        sortedShifts.forEach(sh => {
          const dateStr = new Date(sh.clockInTime).toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
          
          sh.activities.forEach((act, idx) => {
            const startTimeIST = new Date(act.startTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
            const endTimeIST = act.endTime 
              ? new Date(act.endTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) 
              : 'Ongoing';
            
            let durationMin = 0;
            if (act.endTime) {
              durationMin = (new Date(act.endTime).getTime() - new Date(act.startTime).getTime()) / (1000 * 60);
            } else {
              durationMin = (new Date().getTime() - new Date(act.startTime).getTime()) / (1000 * 60);
              if (durationMin < 0) durationMin = 0;
            }

            chronoRows.push([
              sh.userName || 'N/A',
              sh.userEmail || 'N/A',
              dateStr,
              idx + 1,
              act.type === 'productive' ? 'Productive Work' : 'Break',
              act.name || 'N/A',
              startTimeIST,
              endTimeIST,
              durationMin.toFixed(1)
            ]);
          });
        });
        return chronoRows;
      };

      const chronoRows = includeChrono ? buildChronoRows(teamRangeShifts) : [];

      console.log(`[REPORT EXPORT] Team Lead report exported by ${user.name} (${user.email}). Date range: ${start.toISOString()} to ${end.toISOString()} in format: ${format}, reportType: ${selectedReportType}`);

      if (format === 'excel') {
        const workbook = XLSX.utils.book_new();

        if (selectedReportType === 'both') {
          const wsMain = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
          wsMain['!cols'] = summaryHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsMain, "Team Utilization");

          const wsChrono = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
          wsChrono['!cols'] = chronoHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsChrono, "Chronological Activity Logs");
        } else if (selectedReportType === 'summary') {
          const wsMain = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
          wsMain['!cols'] = summaryHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsMain, "Team Utilization");
        } else if (selectedReportType === 'chronological') {
          const wsChrono = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
          wsChrono['!cols'] = chronoHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsChrono, "Chronological Activity Logs");
        }

        const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([excelBuffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);

        let filenameSuffix = "Team_Report";
        if (selectedReportType === 'both') filenameSuffix = "Team_Summary_and_Chronological_Report";
        else if (selectedReportType === 'summary') filenameSuffix = "Team_Summary_Report";
        else if (selectedReportType === 'chronological') filenameSuffix = "Team_Chronological_Activity_Logs";

        link.setAttribute('download', `TMS_Team_${filenameSuffix}_${user.name.split(' ').join('_')}.xlsx`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        if (selectedReportType === 'summary') {
          const csvContent = "\uFEFF" + [summaryHeaders.join(','), ...summaryRows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
          const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.setAttribute('href', url);
          link.setAttribute('download', `TMS_Team_Summary_Report_${user.name.split(' ').join('_')}.csv`);
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        } else {
          const csvContent = "\uFEFF" + [chronoHeaders.join(','), ...chronoRows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
          const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.setAttribute('href', url);
          link.setAttribute('download', `TMS_Team_Chronological_Activity_Logs_${user.name.split(' ').join('_')}.csv`);
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
      }
      
      toast.success('Utilization Report exported successfully!');
    };

    const handleGenerateExport = async () => {
      if (selectedRangePreset === 'custom' && (!startDateStr || !endDateStr)) {
        toast.error('Please select both start and end dates for custom range.');
        return;
      }
      const { start, end } = getDateRange(selectedRangePreset, startDateStr, endDateStr);
      if (start > end) {
        toast.error('Start date cannot be after end date.');
        return;
      }

      toast.info('Fetching comprehensive shift data for requested range...');
      try {
        // Fetch data directly from Firestore for the export to bypass local state limits
        const qRange = query(
          collection(db, 'tmsShifts'),
          where('clockInTime', '>=', start.toISOString()),
          where('clockInTime', '<=', end.toISOString())
        );
        const snap = await getDocs(qRange);
        const rangeShifts = snap.docs.map(d => ({ id: d.id, ...d.data() } as TMSShift));

        setShowExportModal(false);
        if (exportType === 'team') {
          executeTeamExport(start, end, exportFormat, rangeShifts, reportType);
        } else {
          executeOrganizationExport(start, end, exportFormat, rangeShifts, reportType);
        }
      } catch (err) {
        console.error('Export fetch failed:', err);
        toast.error('Failed to fetch data for export. Please try a smaller range.');
      }
    };

    const finalMappedUsers = mappedUsers.filter((u) => {
      // 1. Filter by search
      const search = (tmsSearch || '').toLowerCase();
      const matchesSearch = !search 
        ? true 
        : ((u.name || '').toLowerCase().includes(search) || (u.email || '').toLowerCase().includes(search));
        
      if (!matchesSearch) return false;

      // 2. Filter by shift status
      const activeShift = allShifts.find(s => 
        s.userEmail?.toLowerCase() === u.email?.toLowerCase() && 
        (s.status === 'ACTIVE' || s.status === 'BREAK')
      );

      if (activeShiftFilter === 'all') return true;
      if (activeShiftFilter === 'offline') return !activeShift;
      if (activeShiftFilter === 'active') return !!(activeShift && activeShift.status === 'ACTIVE');
      if (activeShiftFilter === 'break') return !!(activeShift && activeShift.status === 'BREAK');

      return true;
    });

    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        {/* Upper header segment */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm text-slate-800">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-sky-600 flex items-center justify-center text-white shadow-lg shadow-sky-200">
              <Clock size={24} />
            </div>
            <div>
              <h2 className="text-2xl font-black text-slate-900 tracking-tight">{isManagerRole ? 'Manager Dashboard' : 'Team Lead TMS Dashboard'}</h2>
              <p className="text-sm font-medium text-slate-500">Supervise logged-in agents, productivity rates, and export utilization reports</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleExportCSV}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2.5 px-4 rounded-xl flex items-center gap-1.5 shadow-sm shadow-emerald-200 cursor-pointer"
            >
              <FileSpreadsheet size={16} /> Export Team Report
            </Button>

            {/* Current system clock */}
            <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl text-left">
              <Activity className="text-emerald-500 animate-pulse shrink-0" size={16} />
              <div>
                <p className="text-[8px] uppercase font-bold tracking-widest text-slate-400 leading-none">Live Server Time (IST)</p>
                <p className="font-mono text-[11px] font-bold text-slate-800 leading-none mt-1">
                  {currentTime.toLocaleString('en-US', { 
                    timeZone: 'Asia/Kolkata',
                    dateStyle: 'medium',
                    timeStyle: 'medium'
                  })}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Metric summary boxes */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="border border-slate-200 shadow-sm bg-white rounded-2xl">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-extrabold tracking-wider text-slate-400">Total Assigned Team</CardDescription>
              <CardTitle className="text-2xl font-black text-slate-900">{mappedUsers.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-slate-500 font-medium">Mapped Agents & QAs</p>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-sm bg-white rounded-2xl">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-extrabold tracking-wider text-teal-500">Logged In Right Now</CardDescription>
              <CardTitle className="text-2xl font-black text-teal-600">{currentActiveCount}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-slate-500 font-medium">{mappedUsers.length > 0 ? `${((currentActiveCount / mappedUsers.length) * 100).toFixed(0)}%` : '0%'} of total roster active</p>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-sm bg-white rounded-2xl">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-extrabold tracking-wider text-sky-500">Average Team Utilization</CardDescription>
              <CardTitle className="text-2xl font-black text-sky-600">{teamAvgUtilization}%</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-slate-500 font-medium">Target productivity benchmark: 85%</p>
            </CardContent>
          </Card>
        </div>

        {/* Live workforce roster and session status table */}
        <Card className="border border-slate-200 shadow-sm bg-white overflow-hidden rounded-2xl">
          <CardHeader className="border-b border-slate-100 pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <CardTitle className="text-sm font-extrabold text-slate-900 uppercase tracking-widest flex items-center gap-2">
                <User size={16} className="text-sky-500" />
                Roster Session Audit & Real-time Tracking
              </CardTitle>
              <CardDescription className="text-xs">
                Live-monitored metrics for resources under your supervision.
              </CardDescription>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-3 w-full md:w-auto">
              <div className="relative w-full sm:w-44 shrink-0">
                <select
                  value={activeShiftFilter}
                  onChange={(e) => {
                    setActiveShiftFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full bg-slate-50 border border-slate-250 hover:bg-slate-100 rounded-xl px-3 py-2 pr-8 text-xs text-slate-700 font-extrabold focus:outline-none focus:ring-1 focus:ring-sky-550 cursor-pointer appearance-none"
                >
                  <option value="all">🟢 Shift Filter: All</option>
                  <option value="active">🟢 Active Shifts</option>
                  <option value="break">🟠 Break Shifts</option>
                  <option value="offline">⚪ Offline Resources</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-450">
                  <svg className="fill-current h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
                </div>
              </div>
              <div className="relative w-full md:w-64">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="Search resources..."
                  value={tmsSearch}
                  onChange={(e) => {
                    setTmsSearch(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="pl-9 h-9 text-xs focus-visible:ring-1 focus-visible:ring-sky-500 rounded-xl"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto max-h-[500px]">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 z-10 bg-slate-50 shadow-sm shadow-slate-200/50">
                  <tr className="bg-slate-50 text-slate-500 border-b border-slate-200 font-bold uppercase tracking-widest text-[9px] select-none">
                    <th className="p-4 pl-6">Profile</th>
                    <th className="p-4">Role</th>
                    <th className="p-4">Active Shift status</th>
                    <th className="p-4">Current Process</th>
                    <th className="p-4">Clocked Interval</th>
                    <th className="p-4 text-center">Avg. Shift Utilization</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {finalMappedUsers.map((u) => {
                    const userShifts = allShifts.filter(sh => sh.userId === u.uid);
                    const activeShift = userShifts.find(sh => sh.status === 'ACTIVE' || sh.status === 'BREAK');
                    
                    let stats = activeShift ? computeShiftStats(activeShift) : null;
                    
                    // overall stats
                    let totalShiftMsSum = 0;
                    let totalActiveMsSum = 0;
                    userShifts.forEach(sh => {
                      const s = computeShiftStats(sh);
                      totalShiftMsSum += s.totalShiftMs;
                      totalActiveMsSum += s.activeMs;
                    });
                    const overallUtil = totalShiftMsSum > 0 
                      ? Number(((totalActiveMsSum / totalShiftMsSum) * 100).toFixed(1)) 
                      : null;

                    return (
                      <tr key={u.uid} className="hover:bg-slate-50/50 transition-colors">
                        <td className="p-4 pl-6 font-bold text-slate-800">
                          <div>{u.name}</div>
                          <div className="text-[10px] font-mono text-slate-400 font-medium leading-none mt-1">{u.email}</div>
                        </td>
                        <td className="p-4">
                          <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-wider">{u.role}</Badge>
                        </td>
                        <td className="p-4 flex items-center gap-2">
                          {activeShift ? (
                            <>
                              <Badge className={`text-[10px] font-black uppercase ${
                                activeShift.status === 'BREAK' 
                                  ? 'bg-amber-100 text-amber-800 border-amber-200' 
                                  : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                              }`}>
                                LIVE - {activeShift.status}
                              </Badge>
                              {canUserForceLogoutTarget(user, u.uid) && (
                                <Button 
                                  size="sm" 
                                  variant="ghost" 
                                  className="text-[9px] text-red-500 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 rounded-lg shrink-0 h-6 px-1.5 ml-1 font-bold" 
                                  onClick={() => startForceLogoutFlow(activeShift.id, u.uid, u.name)}
                                >
                                  Force Out
                                </Button>
                              )}
                            </>
                          ) : (
                            <Badge variant="secondary" className="text-[10px] bg-slate-100 text-slate-500 font-bold uppercase">
                              Offline
                            </Badge>
                          )}
                        </td>
                        <td className="p-4 font-semibold text-slate-700">
                          {activeShift ? (
                            activeShift.activities[activeShift.activities.length - 1]?.name || 'N/A'
                          ) : (
                            <span className="text-slate-400">N/A</span>
                          )}
                        </td>
                        <td className="p-4 font-medium text-slate-500">
                          {activeShift ? (
                            <div className="flex flex-col gap-0.5 text-[10px]">
                              <span>Shift elapsed: {stats?.totalShiftStr}</span>
                              <span className="text-teal-600 font-bold">Productive: {stats?.activeStr}</span>
                            </div>
                          ) : (
                            <span className="text-slate-400">N/A</span>
                          )}
                        </td>
                        <td className="p-4 text-center font-bold text-sm text-[#0F172A] font-mono">
                          {overallUtil !== null ? (
                            <div>
                              <div>{overallUtil}%</div>
                              <div className="text-[9px] text-slate-400 font-normal leading-none mt-1 uppercase tracking-wider">
                                calculated over {userShifts.length} session(s)
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-400 font-normal text-xs">No entries</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {finalMappedUsers.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-16 text-center text-slate-400">
                        <div className="flex flex-col items-center gap-3">
                          <User size={36} className="text-slate-200" />
                          <p className="font-bold uppercase tracking-widest text-[10px] text-slate-400">
                            {mappedUsers.length === 0 ? "No agents mapped to you" : "No resources match your search"}
                          </p>
                          {mappedUsers.length === 0 && (
                             <p className="text-xs text-slate-400 max-w-sm font-medium">Please ask your system administrator to assign Agents or Quality Analysts to your team under the Console tab.</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Dynamic Date Range & Format Select Modal for Team Leads / Managers */}
        {showExportModal && exportType === 'team' && (
          <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200 text-slate-800">
            <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 space-y-4">
              <div className="flex items-center gap-3 border-b pb-3">
                <div className="w-10 h-10 rounded-xl bg-sky-50 flex items-center justify-center text-sky-600 shrink-0">
                  <FileSpreadsheet size={20} />
                </div>
                <div className="text-left">
                  <h4 className="font-extrabold text-slate-900 text-sm uppercase tracking-wide">
                    Export Team Report
                  </h4>
                  <p className="text-slate-500 text-[10px] font-bold leading-none mt-1">Specify date range and filter criteria</p>
                </div>
              </div>

              <div className="space-y-4 text-xs font-bold text-slate-700">
                {/* Date Range Preset */}
                <div className="space-y-1.5 text-left">
                  <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Date Range Preset</Label>
                  <select
                    value={selectedRangePreset}
                    onChange={(e) => {
                      setSelectedRangePreset(e.target.value);
                      if (e.target.value !== 'custom') {
                        setStartDateStr('');
                        setEndDateStr('');
                      }
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-sky-500 cursor-pointer"
                  >
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="last7">Last 7 Days</option>
                    <option value="last30">Last 30 Days (Default)</option>
                    <option value="currentMonth">Current Month</option>
                    <option value="previousMonth">Previous Month</option>
                    <option value="custom">Custom Date Range...</option>
                  </select>
                </div>

                {/* Custom Date Inputs */}
                {selectedRangePreset === 'custom' && (
                  <div className="grid grid-cols-2 gap-3 pt-1 animate-in slide-in-from-top-2 duration-200">
                    <div className="space-y-1.5 text-left">
                      <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">Start Date</Label>
                      <Input
                        type="date"
                        value={startDateStr}
                        onChange={(e) => setStartDateStr(e.target.value)}
                        className="border-slate-200 rounded-xl text-xs font-bold p-2.5 w-full bg-slate-50"
                      />
                    </div>
                    <div className="space-y-1.5 text-left">
                      <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">End Date</Label>
                      <Input
                        type="date"
                        value={endDateStr}
                        onChange={(e) => setEndDateStr(e.target.value)}
                        className="border-slate-200 rounded-xl text-xs font-bold p-2.5 w-full bg-slate-50"
                      />
                    </div>
                  </div>
                )}

                {/* File Format Selection */}
                <div className="space-y-2 text-left">
                  <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">File Format</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setExportFormat('excel')}
                      className={`p-3 rounded-xl border font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                        exportFormat === 'excel'
                          ? 'border-emerald-500 bg-emerald-50/50 text-emerald-850'
                          : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      Excel (.xlsx)
                    </button>
                    <button
                      type="button"
                      onClick={() => setExportFormat('csv')}
                      className={`p-3 rounded-xl border font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                        exportFormat === 'csv'
                          ? 'border-sky-500 bg-sky-50/50 text-sky-850'
                          : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full bg-sky-500" />
                      CSV (.csv)
                    </button>
                  </div>
                </div>

                {/* Report Type Selection */}
                <div className="space-y-2 text-left">
                  <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Report Type</Label>
                  <select
                    value={reportType}
                    onChange={(e) => setReportType(e.target.value as any)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-sky-500 cursor-pointer"
                  >
                    <option value="summary">Utilization Summary Report</option>
                    <option value="chronological">Detailed Chronological Activity Log (Breaks & Switches)</option>
                    {exportFormat === 'excel' && (
                      <option value="both">Both Reports (Separate Sheets)</option>
                    )}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 text-xs font-bold pt-3 border-t">
                <Button variant="ghost" onClick={() => setShowExportModal(false)} className="rounded-xl">Cancel</Button>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center gap-1.5 cursor-pointer"
                  onClick={handleGenerateExport}
                >
                  Generate & Export
                </Button>
              </div>
            </div>
          </div>
        )}

      </div>
    );
  }

  // Filtering admin shift records
  const filteredAllShifts = allShifts.filter(s => {
    const search = (adminSearch || '').toLowerCase();
    return (s.userName || '').toLowerCase().includes(search) ||
           (s.userEmail || '').toLowerCase().includes(search) ||
           (s.activities || []).some(act => (act.name || '').toLowerCase().includes(search));
  });

  const itemsPerPage = 30;
  const totalPages = Math.ceil(filteredAllShifts.length / itemsPerPage) || 1;
  const paginatedShifts = filteredAllShifts.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const handleExportAllShifts = () => {
    setExportType('organization');
    setSelectedRangePreset('last30');
    setStartDateStr('');
    setEndDateStr('');
    setExportFormat('excel');
    setReportType('both');
    setShowExportModal(true);
  };

  const executeOrganizationExport = (
    start: Date, 
    end: Date, 
    format: 'csv' | 'excel', 
    fetchedShifts: TMSShift[] = allShifts,
    selectedReportType: 'summary' | 'chronological' | 'both' = 'both'
  ) => {
    // Filter fetchedShifts strictly by date range
    const startISO = start.toISOString();
    const endISO = end.toISOString();
    const rangeShifts = fetchedShifts.filter(sh => {
      return sh.clockInTime >= startISO && sh.clockInTime <= endISO;
    });

    if (rangeShifts.length === 0) {
      toast.error("No shift logs found in the selected date range");
      return;
    }

    const includeSummary = selectedReportType === 'summary' || selectedReportType === 'both';
    const includeChrono = selectedReportType === 'chronological' || selectedReportType === 'both';

    const summaryHeaders = [
      'Name',
      'Email ID',
      'Shift Status',
      'Process Name',
      'Last Activity',
      'Clock In Time (IST)',
      'Clock Out Time (IST)',
      'Total Duration (Min)',
      'Productive Duration (Min)',
      'Break Duration (Min)',
      'Utilization (%)'
    ];

    const summaryRows = includeSummary ? rangeShifts.map(sh => {
      const stats = computeShiftStats(sh);
      const clockIn = new Date(sh.clockInTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const clockOut = sh.clockOutTime 
        ? new Date(sh.clockOutTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) 
        : 'Ongoing';

      const totalShiftMins = (stats.totalShiftMs / (60 * 1000)).toFixed(1);
      const totalProductiveMins = (stats.activeMs / (60 * 1000)).toFixed(1);
      const totalBreakMins = (stats.breakMs / (60 * 1000)).toFixed(1);

      const productiveAct = [...sh.activities].reverse().find(act => act.type === 'productive');
      const processName = productiveAct ? productiveAct.name : 'N/A';
      const lastAct = sh.activities.length > 0 ? sh.activities[sh.activities.length - 1] : null;
      const lastActivity = lastAct ? lastAct.name : 'N/A';

      return [
        sh.userName,
        sh.userEmail,
        sh.status,
        processName,
        lastActivity,
        clockIn,
        clockOut,
        totalShiftMins,
        totalProductiveMins,
        totalBreakMins,
        stats.utilization + '%'
      ];
    }) : [];

    const chronoHeaders = [
      'Agent Name',
      'Agent Email',
      'Date (IST)',
      'Action Sequence',
      'Duration Type',
      'Specific Activity / Break Type',
      'Start Time (IST)',
      'End Time (IST)',
      'Duration (Mins)'
    ];

    const buildChronoRowsForOrg = (shifts: TMSShift[]) => {
      const chronoRows: any[] = [];
      const sortedShifts = [...shifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());

      sortedShifts.forEach(sh => {
        const dateStr = new Date(sh.clockInTime).toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
        
        sh.activities.forEach((act, idx) => {
          const startTimeIST = new Date(act.startTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
          const endTimeIST = act.endTime 
            ? new Date(act.endTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) 
            : 'Ongoing';
          
          let durationMin = 0;
          if (act.endTime) {
            durationMin = (new Date(act.endTime).getTime() - new Date(act.startTime).getTime()) / (1000 * 60);
          } else {
            durationMin = (new Date().getTime() - new Date(act.startTime).getTime()) / (1000 * 60);
            if (durationMin < 0) durationMin = 0;
          }

          chronoRows.push([
            sh.userName || 'N/A',
            sh.userEmail || 'N/A',
            dateStr,
            idx + 1,
            act.type === 'productive' ? 'Productive Work' : 'Break',
            act.name || 'N/A',
            startTimeIST,
            endTimeIST,
            durationMin.toFixed(1)
          ]);
        });
      });
      return chronoRows;
    };

    const chronoRows = includeChrono ? buildChronoRowsForOrg(rangeShifts) : [];

    console.log(`[REPORT EXPORT] Admin/Manager organization report exported by ${user.name} (${user.email}). Date range: ${start.toISOString()} to ${end.toISOString()} in format: ${format}, reportType: ${selectedReportType}`);

    if (format === 'excel') {
      const workbook = XLSX.utils.book_new();

      if (selectedReportType === 'both') {
        const wsMain = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
        wsMain['!cols'] = summaryHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsMain, "Organization Utilization");

        const wsChrono = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
        wsChrono['!cols'] = chronoHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsChrono, "Chronological Activity Logs");
      } else if (selectedReportType === 'summary') {
        const wsMain = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
        wsMain['!cols'] = summaryHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsMain, "Organization Utilization");
      } else if (selectedReportType === 'chronological') {
        const wsChrono = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
        wsChrono['!cols'] = chronoHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsChrono, "Chronological Activity Logs");
      }

      const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([excelBuffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);

      let filenameSuffix = "Org_Report";
      if (selectedReportType === 'both') filenameSuffix = "Summary_and_Chronological_Report";
      else if (selectedReportType === 'summary') filenameSuffix = "Summary_Report";
      else if (selectedReportType === 'chronological') filenameSuffix = "Chronological_Activity_Logs";

      link.setAttribute('download', `TMS_Org_${filenameSuffix}.xlsx`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      if (selectedReportType === 'summary') {
        const csvContent = "\uFEFF" + [summaryHeaders.join(','), ...summaryRows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `TMS_Org_Summary_Report.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        const csvContent = "\uFEFF" + [chronoHeaders.join(','), ...chronoRows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `TMS_Org_Chronological_Activity_Logs.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    }
    
    toast.success('Organization Report exported successfully!');
  };

  const handleAdminGenerateExport = async () => {
    if (selectedRangePreset === 'custom' && (!startDateStr || !endDateStr)) {
      toast.error('Please select both start and end dates for custom range.');
      return;
    }
    const { start, end } = getDateRange(selectedRangePreset, startDateStr, endDateStr);
    if (start > end) {
      toast.error('Start date cannot be after end date.');
      return;
    }

    toast.info('Fetching comprehensive shift data for requested range...');
    try {
      // Query data directly from Firestore to ensure exactness and reliability
      const qRange = query(
        collection(db, 'tmsShifts'),
        where('clockInTime', '>=', start.toISOString()),
        where('clockInTime', '<=', end.toISOString())
      );
      const snap = await getDocs(qRange);
      const rangeShifts = snap.docs.map(d => ({ id: d.id, ...d.data() } as TMSShift));

      setShowExportModal(false);
      executeOrganizationExport(start, end, exportFormat, rangeShifts, reportType);
    } catch (err) {
      console.error('Export fetch failed:', err);
      toast.error('Failed to fetch data for export. Please try a smaller range.');
    }
  };

  const showSelfService = hasTmsPermission('view_self_service');
  const showOwnShiftSummary = hasTmsPermission('can_view_own_shift_summary');
  const showOwnAttendance = hasTmsPermission('can_view_own_attendance_summary');
  const showTimelineCol = showOwnShiftSummary || showOwnAttendance;

  // Columns layout configuration
  const punchColSpan = showTimelineCol ? "lg:col-span-5" : "lg:col-span-12";
  const timelineColSpan = showSelfService ? "lg:col-span-7" : "lg:col-span-12";

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Upper header segment */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-sky-500 flex items-center justify-center text-white shadow-lg shadow-sky-200">
            <Clock size={24} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight">Workforce Time Management</h2>
            <p className="text-sm font-medium text-slate-500">Punch shifts, breaks, processes, and track real-time utilization</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {canViewReports && ![UserRole.AGENT, UserRole.QA, UserRole.SME, UserRole.TRAINER, UserRole.MIS].includes(user.role as UserRole) && (
            <Button
              onClick={handleExportAllShifts}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2.5 px-4 rounded-xl flex items-center gap-1.5 shadow-sm shadow-emerald-200 cursor-pointer"
            >
              <FileSpreadsheet size={16} /> Export Organization Report
            </Button>
          )}

          {/* Current system clock */}
          <div className="flex items-center gap-4 bg-slate-50 border border-slate-200 px-5 py-2.5 rounded-xl">
            <Activity className="text-emerald-500 animate-pulse shrink-0" size={18} />
            <div className="text-right">
              <p className="text-[9px] uppercase font-bold tracking-widest text-slate-400">Live Server Time (IST)</p>
              <p className="font-mono text-xs font-bold text-slate-800 leading-none mt-1">
                {currentTime.toLocaleString('en-US', { 
                  timeZone: 'Asia/Kolkata',
                  dateStyle: 'medium',
                  timeStyle: 'medium'
                })}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Punch Control / Agent Panel */}
        {showSelfService && (
          <div className={`${punchColSpan} space-y-6`}>
          <Card className="border-none shadow-md shadow-slate-200 overflow-visible">
            <CardHeader className="bg-slate-900 text-white rounded-t-2xl pb-6">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg font-black tracking-tight leading-none text-white">Punch Station</CardTitle>
                  <CardDescription className="text-slate-400 text-xs leading-none mt-1.5">Shift controls and process routing</CardDescription>
                </div>
                <Badge className={`px-2.5 py-1 ${
                  !currentShift ? 'bg-red-500/20 text-red-400 border-red-500/30' :
                  currentShift.status === 'BREAK' ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                  'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                } border font-bold uppercase`}>
                  {!currentShift ? 'CLOCKED OUT' : currentShift.status === 'BREAK' ? 'ON BREAK' : 'ACTIVE WORK'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              
              {/* Ticking Clock Status inside Punch station */}
              {currentShift ? (
                <div className="grid grid-cols-3 gap-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="text-center border-r border-slate-200">
                    <p className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Shift Elapsed</p>
                    <p className="font-mono text-sm font-black text-slate-800 mt-1">{elapsedShift}</p>
                  </div>
                  <div className="text-center border-r border-slate-200">
                    <p className="text-[9px] font-black uppercase text-slate-400 tracking-wider text-teal-600">Active Work</p>
                    <p className="font-mono text-sm font-black text-teal-700 mt-1">{elapsedActive}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[9px] font-black uppercase text-slate-400 tracking-wider text-amber-600">Total Breaks</p>
                    <p className="font-mono text-sm font-black text-amber-700 mt-1">{elapsedBreak}</p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-8 bg-slate-50 border border-slate-200 border-dashed rounded-xl">
                  <Clock className="text-slate-300 mb-2" size={32} />
                  <p className="text-xs font-bold text-slate-500">You are currently clocked out.</p>
                  <p className="text-[10px] text-slate-400 mt-1">Please select a process and clock in to begin.</p>
                </div>
              )}

              {/* State Machine Flow Buttons */}
              {!currentShift ? (
                // 1. Clocked Out Interface
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Select Start Process</Label>
                    <ProcessSelector
                      allProcesses={processes}
                      currentProcess={selectedProcessInput}
                      onSelectProcess={setSelectedProcessInput}
                      recentProcesses={recentProcesses}
                      favoriteProcesses={favoriteProcesses}
                      onToggleFavorite={toggleFavorite}
                    />
                  </div>
                  <Button 
                    className="w-full h-12 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-xl flex items-center justify-center gap-2 shadow-sm shadow-emerald-200 cursor-pointer"
                    onClick={handleClockIn}
                  >
                    <Play size={16} /> GO TO WORK & CLOCK IN
                  </Button>
                </div>
              ) : currentShift.status === 'BREAK' ? (
                // 2. Break Interface (Resume Controls)
                <div className="space-y-4">
                  <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs leading-relaxed text-amber-800 flex items-start gap-2">
                    <Coffee className="shrink-0 mt-0.5 text-amber-500" size={16} />
                    <div>
                      <p className="font-bold">You are on a Break: {currentShift.activities[currentShift.activities.length - 1].name}</p>
                      <p className="mt-1 font-medium select-none">To resume working, choose your process and click Resume.</p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Resume Process</Label>
                    <ProcessSelector
                      allProcesses={processes}
                      currentProcess={selectedProcessInput}
                      onSelectProcess={setSelectedProcessInput}
                      recentProcesses={recentProcesses}
                      favoriteProcesses={favoriteProcesses}
                      onToggleFavorite={toggleFavorite}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Button 
                      className="h-11 bg-teal-600 hover:bg-teal-700 text-white font-black text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
                      onClick={() => handleResumeWork(selectedProcessInput)}
                    >
                      <CheckCircle size={14} /> RESUME WORK
                    </Button>
                    <Button 
                      variant="destructive"
                      className="h-11 font-black text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
                      onClick={handleClockOut}
                    >
                      <LogOut size={14} /> CLOCK OUT
                    </Button>
                  </div>
                </div>
              ) : (
                // 3. Active Work Interface (Break/Switch Controls)
                <div className="space-y-5">
                  <div className="bg-sky-50 border border-sky-100 p-3.5 rounded-lg text-xs text-sky-800">
                    <p className="font-bold">Current Active Process: <span className="underline">{selectedProcessInput}</span></p>
                    <p className="mt-0.5">Switch processes anytime or punch a break from the controls below.</p>
                  </div>

                  {/* Switch process inline dropdown */}
                  <div className="space-y-1.5 border-t border-slate-100 pt-4">
                    <Label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Switch To:</Label>
                    <div className="flex gap-2">
                    <ProcessSelector
                      allProcesses={processes}
                      currentProcess={""}
                      onSelectProcess={handleSwitchProcess}
                      recentProcesses={recentProcesses}
                      favoriteProcesses={favoriteProcesses}
                      onToggleFavorite={toggleFavorite}
                    />
                    </div>
                  </div>

                  {/* Punch Break controls */}
                  <div className="space-y-1.5 border-t border-slate-100 pt-4">
                    <Label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Take a Break</Label>
                    <div className="flex gap-2">
                      <select
                        className="flex-1 h-10 bg-white border border-slate-200 rounded-lg px-3 text-xs text-slate-800 font-semibold focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        value={selectedBreakInput}
                        onChange={(e) => setSelectedBreakInput(e.target.value)}
                      >
                        {BREAK_OPTIONS.map(b => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                      <Button 
                        size="sm" 
                        className="bg-amber-500 hover:bg-amber-600 font-bold text-xs h-10 px-4 shrink-0 cursor-pointer text-white flex items-center gap-1"
                        onClick={handleStartBreak}
                      >
                        <Coffee size={14} /> Punch Break
                      </Button>
                    </div>
                  </div>

                  <div className="border-t border-slate-100 pt-4">
                    <Button 
                      variant="destructive"
                      className="w-full h-11 font-black text-sm rounded-xl flex items-center justify-center gap-2 cursor-pointer shadow-sm shadow-red-200"
                      onClick={handleClockOut}
                    >
                      <LogOut size={16} /> END WORK & CLOCK OUT
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Today's Shift Metrics Summary */}
          {showOwnShiftSummary && currentShift && (
            <Card className="border-none shadow-md shadow-slate-200 bg-white">
              <CardHeader className="border-b border-rose-50/50 pb-3">
                <CardTitle className="text-sm font-black text-slate-800">Shift Math & Utilization Summary</CardTitle>
                <CardDescription className="text-[10px]">Real-time shift math (24/7 cross-day logic applied)</CardDescription>
              </CardHeader>
              <CardContent className="pt-4 flex items-center justify-between gap-4">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center justify-between text-xs font-medium border-b border-slate-100 pb-1.5">
                    <span className="text-slate-500">Utilization Rate:</span>
                    <span className="font-extrabold text-teal-600 text-sm">
                      {computeShiftStats(currentShift).utilization}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-medium border-b border-slate-100 pb-1.5">
                    <span className="text-slate-500">Total Connected:</span>
                    <span className="font-bold text-slate-700">{elapsedShift}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-medium">
                    <span className="text-slate-500">Break Duration:</span>
                    <span className="font-bold text-amber-600">{elapsedBreak}</span>
                  </div>
                </div>

                {/* Aesthetic Circular Progress */}
                <div className="relative w-20 h-20 shrink-0 flex items-center justify-center">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle cx="40" cy="40" r="32" stroke="#E2E8F0" strokeWidth="6" fill="transparent" />
                    <circle 
                      cx="40" 
                      cy="40" 
                      r="32" 
                      stroke="#0D9488" 
                      strokeWidth="6" 
                      fill="transparent" 
                      strokeDasharray={2 * Math.PI * 32}
                      strokeDashoffset={2 * Math.PI * 32 * (1 - computeShiftStats(currentShift).utilization / 100)}
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="absolute font-mono text-xs font-black text-slate-800">
                    {computeShiftStats(currentShift).utilization}%
                  </span>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
        )}

        {/* Shift Timeline / Session History Column */}
        {showTimelineCol && (
        <div className={`${timelineColSpan} space-y-6`}>
          {showOwnShiftSummary && (
          <Card className="border-none shadow-md shadow-slate-200">
            <CardHeader className="border-b border-slate-100 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg font-black text-slate-900 tracking-tight">Active Timeline List</CardTitle>
                  <CardDescription className="text-xs">Your segmented chronological punch log</CardDescription>
                </div>
                <Activity size={20} className="text-sky-400" />
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              {currentShift ? (
                <div className="relative border-l border-slate-200 ml-4 pl-6 space-y-6">
                  {currentShift.activities.map((act, index) => {
                    const isProductive = act.type === 'productive';
                    const actDuration = act.endTime 
                      ? formatMs(new Date(act.endTime).getTime() - new Date(act.startTime).getTime())
                      : 'Active Now';

                    return (
                      <div key={index} className="relative group">
                        {/* Timeline dot */}
                        <div className={`absolute -left-10 top-0.5 w-8 h-8 rounded-full border-4 border-white flex items-center justify-center text-white ${
                          !act.endTime ? 'bg-sky-500 ring-4 ring-sky-100 animate-pulse' :
                          isProductive ? 'bg-emerald-500' : 'bg-amber-500'
                        }`}>
                          {isProductive ? <CheckCircle size={10} /> : <Coffee size={10} />}
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-extrabold text-slate-950 text-sm">{act.name}</span>
                            <Badge className={`${isProductive ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100' : 'bg-amber-100 text-amber-800 hover:bg-amber-100'} text-[9px] uppercase font-extrabold pb-0.5`}>
                              {act.type}
                            </Badge>
                            {!act.endTime && (
                              <span className="text-[10px] bg-red-600 text-white font-bold px-1.5 rounded-full select-none">Active Timer</span>
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-xs font-medium text-slate-500 mt-1">
                            <span>{formatTimeStr(act.startTime)} - {act.endTime ? formatTimeStr(act.endTime) : 'Present'}</span>
                            <span className="text-slate-300">|</span>
                            <span className="font-mono font-bold text-slate-700">{actDuration}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-20">
                  <div className="flex flex-col items-center gap-3 opacity-35 max-w-sm mx-auto">
                    <History size={40} className="text-slate-400" />
                    <p className="text-xs uppercase tracking-widest font-black text-slate-600">No shift currently active</p>
                    <p className="text-[11px] font-medium text-slate-500">Your chronologic session intervals will compile here when clocked in.</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          )}

          {/* Past Shift History Logs */}
          {showOwnAttendance && (
          <Card className="border-none shadow-md shadow-slate-200">
            <CardHeader className="border-b border-slate-100 pb-4">
              <CardTitle className="text-base font-black text-slate-900">Your Shift History</CardTitle>
              <CardDescription className="text-xs">Archive of your completed workforce punches</CardDescription>
            </CardHeader>
            <CardContent className="p-0 max-h-80 overflow-y-auto">
              <div className="divide-y divide-slate-100">
                {myPastShifts.filter(s => s.status === 'COMPLETED').map((sh) => {
                  const stats = computeShiftStats(sh);
                  return (
                    <div key={sh.id} className="p-4 hover:bg-slate-50 transition-colors flex items-center justify-between text-xs">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-extrabold text-slate-800">
                            {formatDateStr(sh.clockInTime)}
                          </span>
                          <span className="text-slate-300">|</span>
                          <span className="text-slate-500 font-semibold">
                            {formatTimeStr(sh.clockInTime)} - {sh.clockOutTime ? formatTimeStr(sh.clockOutTime) : 'Ongoing'}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-500 font-semibold">
                          Total Productive: <span className="font-bold text-teal-600">{stats.activeStr}</span> &middot; Breaks: <span className="font-bold text-amber-600">{stats.breakStr}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] uppercase font-black text-slate-400 tracking-wider">Shift Utilization</p>
                        <p className="font-mono font-black text-sm text-slate-900 mt-0.5">{stats.utilization}%</p>
                      </div>
                    </div>
                  );
                })}
                {myPastShifts.filter(s => s.status === 'COMPLETED').length === 0 && (
                  <div className="text-center py-10 opacity-40 text-[10px] uppercase font-black tracking-widest text-slate-600">
                    No completed shift logs found
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
          )}
        </div>
        )}

      </div>

      {/* ADMIN PANEL - LIVE TRACKER (Process settings moved to Admin Console) */}
      {canViewReports && (
        <div className="border-t border-slate-200 pt-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex items-center gap-3 bg-red-50/50 p-4 border border-red-100 rounded-xl">
            <LockIcon className="text-red-500 shrink-0" size={18} />
            <div>
              <h3 className="text-sm font-black text-red-950 uppercase tracking-wide">Workforce Control: Clock Master Consolidation</h3>
              <p className="text-[11px] font-bold text-red-800 leading-none mt-1">Supervise organization-wide utilization and live activity maps</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-8">
            
            {/* Realtime workforce dashboard & logs for Admin */}
            <div className="space-y-6">
              <Card className="border-none shadow-md shadow-slate-200">
                <CardHeader className="border-b border-slate-100 pb-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-sm font-extrabold text-slate-900 uppercase tracking-widest">Team Session Audit Logs</CardTitle>
                      <CardDescription className="text-xs">Supervise shifts, chronological timelines, and real-time utilization index</CardDescription>
                    </div>
                    <div className="relative group w-36 sm:w-48 text-xs">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={13} />
                      <Input 
                        placeholder="Search users..." 
                        className="pl-8 h-8 rounded-lg text-[11px] bg-slate-50/50"
                        value={adminSearch}
                        onChange={(e) => {
                          setAdminSearch(e.target.value);
                          setCurrentPage(1);
                        }}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-0 max-h-[500px] overflow-y-auto">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="bg-slate-50 text-slate-500 border-b border-slate-100 font-bold uppercase tracking-widest text-[9px] select-none">
                          <th className="p-4 pl-6">Profile</th>
                          <th className="p-4">Process / Status</th>
                          <th className="p-4">Clocked Interval</th>
                          <th className="p-4 text-center">Calculated Utilization</th>
                          <th className="p-4 text-center">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {paginatedShifts.map((sh) => {
                          const stats = computeShiftStats(sh);
                          const currentActiveActivity = sh.activities[sh.activities.length - 1];

                          return (
                            <tr key={sh.id} className="hover:bg-slate-50/50 transition-colors">
                              <td className="p-4 pl-6 font-bold text-slate-800">
                                <div>{sh.userName}</div>
                                <div className="text-[10px] font-mono text-slate-400 font-medium leading-none mt-0.5">{sh.userEmail}</div>
                              </td>
                              <td className="p-4">
                                <div className="flex items-center gap-1.5">
                                  <Badge className={`text-[10px] font-black uppercase ${
                                    sh.status === 'COMPLETED' ? 'bg-slate-100 text-slate-700' :
                                    sh.status === 'BREAK' ? 'bg-amber-100 text-amber-800 border-amber-200' :
                                    'bg-sky-100 text-sky-800 border-sky-200'
                                  }`}>
                                    {sh.status === 'COMPLETED' ? 'COMPLETED' : `LIVE - ${sh.status}`}
                                  </Badge>
                                </div>
                                <div className="text-[10px] text-slate-400 font-medium mt-1">
                                  Last Activity: <span className="font-bold text-slate-600">{currentActiveActivity?.name || 'N/A'}</span>
                                </div>
                              </td>
                              <td className="p-4 font-medium text-slate-500">
                                <div className="flex flex-col gap-0.5 text-[11px]">
                                  <span>Clock In: {formatTimeStr(sh.clockInTime)}</span>
                                  <span>Clock Out: {sh.clockOutTime ? formatTimeStr(sh.clockOutTime) : 'Active'}</span>
                                </div>
                              </td>
                              <td className="p-4 text-center font-bold text-sm text-[#0F172A] font-mono">
                                {hasTmsPermission('view_team_productivity') ? (
                                  <>
                                    <div>{stats.utilization}%</div>
                                    <div className="text-[10px] text-slate-400 font-normal leading-none mt-1">
                                      Productive: {stats.activeStr} / {stats.totalShiftStr}
                                    </div>
                                  </>
                                ) : (
                                  <span className="text-slate-400 font-normal text-xs">-</span>
                                )}
                              </td>
                              <td className="p-4 text-center">
                                {(sh.status === 'ACTIVE' || sh.status === 'BREAK') && canUserForceLogoutTarget(user, sh.userId) ? (
                                  <Button 
                                    size="sm" 
                                    variant="ghost" 
                                    className="text-[10px] text-red-500 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 rounded-lg font-bold" 
                                    onClick={() => startForceLogoutFlow(sh.id, sh.userId, sh.userName)}
                                  >
                                    Force Out
                                  </Button>
                                ) : (
                                  <span className="text-slate-400 font-normal text-xs">-</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {filteredAllShifts.length === 0 && (
                          <tr>
                            <td colSpan={5} className="p-10 text-center opacity-40 font-bold uppercase tracking-widest text-[10px] text-slate-400">
                              No team records or matching logs found
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
                <CardFooter className="py-3 px-6 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 bg-slate-50/50 rounded-b-xl gap-3">
                  <div>
                    Showing <span className="font-extrabold text-slate-850">{filteredAllShifts.length === 0 ? 0 : (currentPage - 1) * itemsPerPage + 1}-{Math.min(filteredAllShifts.length, currentPage * itemsPerPage)}</span> of <span className="font-extrabold text-slate-850">{filteredAllShifts.length}</span> resources
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-[11px] text-slate-705 font-bold bg-white hover:bg-slate-100 border-slate-200 rounded-lg shrink-0 cursor-pointer"
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                    >
                      <ChevronLeft size={14} className="mr-1" /> Prev
                    </Button>
                    <span className="font-bold text-slate-700 mx-2 text-[11px] select-none">
                      Page {currentPage} of {totalPages}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-[11px] text-slate-705 font-bold bg-white hover:bg-slate-100 border-slate-200 rounded-lg shrink-0 cursor-pointer"
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                    >
                      Next <ChevronRight size={14} className="ml-1" />
                    </Button>
                  </div>
                </CardFooter>
              </Card>
            </div>

          </div>
        </div>
      )}

      {/* Custom clock-out confirmation overlay modal */}
      {showClockOutConfirm && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 text-red-600">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <AlertCircle size={20} />
              </div>
              <div>
                <h4 className="font-bold text-slate-900 text-sm">Clock Out Confirmation</h4>
                <p className="text-slate-500 text-xs mt-1">Are you sure you want to Clock Out and finalise your shift logs?</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 text-xs font-bold pt-2 border-t">
              <Button variant="ghost" onClick={() => setShowClockOutConfirm(false)}>Cancel</Button>
              <Button className="bg-red-600 hover:bg-red-700 text-white font-bold" onClick={() => {
                setShowClockOutConfirm(false);
                performClockOut();
              }}>Confirm Clock Out</Button>
            </div>
          </div>
        </div>
      )}

      {/* Custom user force logout overlay modal with reason select and logging */}
      {forceOutShiftId && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200 text-slate-800">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 text-red-650 border-b pb-3">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <AlertCircle size={20} />
              </div>
              <div className="text-left">
                <h4 className="font-extrabold text-slate-900 text-md uppercase tracking-wide">Force Logout Action</h4>
                <p className="text-slate-500 text-[10px] font-bold leading-none mt-1">Authorized compliance override execution</p>
              </div>
            </div>

            <div className="space-y-4 text-xs font-bold text-slate-700">
              <div className="p-3.5 bg-red-50/50 border border-red-100 rounded-xl space-y-2 text-left">
                <p className="text-red-950 font-black uppercase tracking-wider text-[10px]">Target Resource Details</p>
                <div className="grid grid-cols-2 gap-2 text-slate-650 font-semibold">
                  <div>
                    <span className="text-slate-400 block text-[9px] uppercase font-black">Name</span>
                    <span className="text-slate-950 font-extrabold">{forceOutTargetName}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[9px] uppercase font-black">Current Status</span>
                    <span className="bg-amber-100 text-amber-900 border border-amber-250 px-1.5 rounded text-[10px] uppercase font-black">
                      {allShifts.find(s => s.id === forceOutShiftId)?.status || 'ACTIVE'}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-slate-400 block text-[9px] uppercase font-black">Active Process at logout</span>
                    <span className="text-slate-950 font-black underline">
                      {(() => {
                        const s = allShifts.find(x => x.id === forceOutShiftId);
                        if (s && s.activities && s.activities.length > 0) {
                          return s.activities[s.activities.length - 1].name;
                        }
                        return 'Unknown Process';
                      })()}
                    </span>
                  </div>
                </div>
              </div>

              {/* Preset Reason Select */}
              <div className="space-y-1.5 text-left">
                <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Select Standard Reason</Label>
                <select
                  value={forceOutReason}
                  onChange={(e) => setForceOutReason(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
                >
                  <option value="Left without logging out">Left without logging out (End of Shift)</option>
                  <option value="Long inactivity / Away from desk">Unscheduled inactivity / Away from desk</option>
                  <option value="System glitch / Hanging session">Technical glitch / Hanging timer session</option>
                  <option value="Disciplinary violation">Disciplinary violation / Policy breach</option>
                  <option value="other">Other (Write custom response below...)</option>
                </select>
              </div>

              {/* Custom Input */}
              {forceOutReason === 'other' && (
                <div className="space-y-1.5 text-left animate-in slide-in-from-top-2 duration-200">
                  <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Custom Override Remarks</Label>
                  <textarea
                    placeholder="Provide explicit reasons for this security clock-out..."
                    value={forceOutCustomReason}
                    onChange={(e) => setForceOutCustomReason(e.target.value)}
                    className="w-full h-20 p-3 rounded-xl border border-slate-200 focus:ring-1 focus:ring-red-500 focus:outline-none text-xs text-slate-900 bg-white shadow-inner font-semibold"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 text-xs font-bold pt-3 border-t">
              <Button variant="ghost" onClick={() => setForceOutShiftId(null)} className="rounded-xl">Cancel</Button>
              <Button 
                className="bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl flex items-center gap-1.5"
                onClick={performAdminClockOut}
              >
                Finalize Force Out
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Custom process delete confirmation overlay modal */}
      {confirmDeleteProcessName && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 text-amber-600">
              <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <AlertCircle size={20} />
              </div>
              <div>
                <h4 className="font-bold text-slate-900 text-sm">Delete Process</h4>
                <p className="text-slate-500 text-xs mt-1">Are you sure you want to delete the process <span className="font-semibold text-slate-900">"{confirmDeleteProcessName}"</span> from the configuration?</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 text-xs font-bold pt-2 border-t">
              <Button variant="ghost" onClick={() => setConfirmDeleteProcessName(null)}>Cancel</Button>
              <Button className="bg-amber-600 hover:bg-amber-700 text-white font-bold" onClick={() => {
                const proc = confirmDeleteProcessName;
                setConfirmDeleteProcessName(null);
                performDeleteProcess(proc);
              }}>Confirm Delete</Button>
            </div>
          </div>
        </div>
      )}

      {/* Dynamic Date Range & Format Select Modal for Admins & Managers */}
      {showExportModal && exportType === 'organization' && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200 text-slate-800">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 border-b pb-3">
              <div className="w-10 h-10 rounded-xl bg-sky-50 flex items-center justify-center text-sky-600 shrink-0">
                <FileSpreadsheet size={20} />
              </div>
              <div className="text-left">
                <h4 className="font-extrabold text-slate-900 text-sm uppercase tracking-wide">
                  Export Organization Report
                </h4>
                <p className="text-slate-500 text-[10px] font-bold leading-none mt-1">Specify date range and filter criteria</p>
              </div>
            </div>

            <div className="space-y-4 text-xs font-bold text-slate-700">
              {/* Date Range Preset */}
              <div className="space-y-1.5 text-left">
                <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Date Range Preset</Label>
                <select
                  value={selectedRangePreset}
                  onChange={(e) => {
                    setSelectedRangePreset(e.target.value);
                    if (e.target.value !== 'custom') {
                      setStartDateStr('');
                      setEndDateStr('');
                    }
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-sky-500 cursor-pointer"
                >
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="last7">Last 7 Days</option>
                  <option value="last30">Last 30 Days (Default)</option>
                  <option value="currentMonth">Current Month</option>
                  <option value="previousMonth">Previous Month</option>
                  <option value="custom">Custom Date Range...</option>
                </select>
              </div>

              {/* Custom Date Inputs */}
              {selectedRangePreset === 'custom' && (
                <div className="grid grid-cols-2 gap-3 pt-1 animate-in slide-in-from-top-2 duration-200">
                  <div className="space-y-1.5 text-left">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">Start Date</Label>
                    <Input
                      type="date"
                      value={startDateStr}
                      onChange={(e) => setStartDateStr(e.target.value)}
                      className="border-slate-200 rounded-xl text-xs font-bold p-2.5 w-full bg-slate-50"
                    />
                  </div>
                  <div className="space-y-1.5 text-left">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">End Date</Label>
                    <Input
                      type="date"
                      value={endDateStr}
                      onChange={(e) => setEndDateStr(e.target.value)}
                      className="border-slate-200 rounded-xl text-xs font-bold p-2.5 w-full bg-slate-50"
                    />
                  </div>
                </div>
              )}

              {/* File Format Selection */}
              <div className="space-y-2 text-left">
                <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">File Format</Label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setExportFormat('excel')}
                    className={`p-3 rounded-xl border font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                      exportFormat === 'excel'
                        ? 'border-emerald-500 bg-emerald-50/50 text-emerald-850'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    Excel (.xlsx)
                  </button>
                  <button
                    type="button"
                    onClick={() => setExportFormat('csv')}
                    className={`p-3 rounded-xl border font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                      exportFormat === 'csv'
                        ? 'border-sky-500 bg-sky-50/50 text-sky-850'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-sky-500" />
                    CSV (.csv)
                  </button>
                </div>
              </div>

              {/* Report Type Selection */}
              <div className="space-y-2 text-left">
                <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Report Type</Label>
                <select
                  value={reportType}
                  onChange={(e) => setReportType(e.target.value as any)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-sky-500 cursor-pointer"
                >
                  <option value="summary">Utilization Summary Report</option>
                  <option value="chronological">Detailed Chronological Activity Log (Breaks & Switches)</option>
                  {exportFormat === 'excel' && (
                    <option value="both">Both Reports (Separate Sheets)</option>
                  )}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs font-bold pt-3 border-t">
              <Button variant="ghost" onClick={() => setShowExportModal(false)} className="rounded-xl">Cancel</Button>
              <Button
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center gap-1.5 cursor-pointer"
                onClick={handleAdminGenerateExport}
              >
                Generate & Export
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function LockIcon({ className, size }: { className?: string, size?: number }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width={size || 16} 
      height={size || 16} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      className={className}
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}
