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
  Award
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { toast } from 'sonner';
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
  serverTimestamp 
} from 'firebase/firestore';
import { UserProfile, UserRole } from '../types';
import { motion, AnimatePresence } from 'motion/react';

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
  // Configured processes in the app
  const [processes, setProcesses] = useState<string[]>([]);
  const [newProcessName, setNewProcessName] = useState('');
  
  // Real-time user's shift state
  const [currentShift, setCurrentShift] = useState<TMSShift | null>(null);
  const [myPastShifts, setMyPastShifts] = useState<TMSShift[]>([]);
  
  // Admin view variables
  const [allShifts, setAllShifts] = useState<TMSShift[]>([]);
  const [adminSearch, setAdminSearch] = useState('');
  const [selectedProcessInput, setSelectedProcessInput] = useState('');
  const [selectedBreakInput, setSelectedBreakInput] = useState(BREAK_OPTIONS[0]);

  // Custom modal confirmations instead of window.confirm inside sandboxed iframe
  const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);
  const [confirmDeleteProcessName, setConfirmDeleteProcessName] = useState<string | null>(null);
  
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

  // Fetch Processes Config in Real-time
  useEffect(() => {
    const docRef = doc(db, 'config', 'tmsProcesses');
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        setProcesses(snap.data().list || []);
      } else {
        // Initialize default processes for the team if not exist
        setDoc(docRef, { list: DEFAULT_PROCESSES })
          .then(() => setProcesses(DEFAULT_PROCESSES))
          .catch(e => handleFirestoreError(e, OperationType.WRITE, 'config/tmsProcesses'));
      }
    });
    return () => unsubscribe();
  }, []);

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

  // Fetch ALL Shifts for Admins or Team Leads to view workforce status
  useEffect(() => {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.TEAM_LEAD) return;
    const qAllShifts = query(collection(db, 'tmsShifts'));
    const unsubscribe = onSnapshot(qAllShifts, (snapshot) => {
      const shifts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TMSShift));
      shifts.sort((a, b) => new Date(b.clockInTime).getTime() - new Date(a.clockInTime).getTime());
      setAllShifts(shifts);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'tmsShifts');
    });
    return () => unsubscribe();
  }, [user]);

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
    const targetProcess = selectedProcessInput || (processes.length > 0 ? processes[0] : '');
    if (!targetProcess) {
      toast.error('Please select a starting process before Clocking In.');
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

      await setDoc(doc(db, 'tmsShifts', newShift.id), newShift);
      setSelectedProcessInput(targetProcess);
      toast.success(`Clocked In successfully! Process: ${targetProcess}`);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'tmsShifts');
    }
  };

  const handleSwitchProcess = async (targetProcess: string) => {
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

      await updateDoc(doc(db, 'tmsShifts', currentShift.id), {
        activities: updatedActivities,
        status: 'ACTIVE'
      });

      setSelectedProcessInput(targetProcess);
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

      await updateDoc(doc(db, 'tmsShifts', currentShift.id), {
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

      await updateDoc(doc(db, 'tmsShifts', currentShift.id), {
        activities: updatedActivities,
        status: 'ACTIVE'
      });

      setSelectedProcessInput(resumeProcess);
      toast.success(`Resumed work on process: ${resumeProcess}`);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'tmsShifts');
    }
  };

  const handleClockOut = () => {
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

      await updateDoc(doc(db, 'tmsShifts', currentShift.id), {
        activities: updatedActivities,
        clockOutTime: nowISO,
        status: 'COMPLETED'
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

    try {
      const updatedList = [...processes, newProcessName.trim()];
      await setDoc(doc(db, 'config', 'tmsProcesses'), { list: updatedList });
      setProcesses(updatedList);
      setNewProcessName('');
      toast.success('New process added to console.');
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'config/tmsProcesses');
    }
  };

  const handleDeleteProcess = (procToDelete: string) => {
    setConfirmDeleteProcessName(procToDelete);
  };

  const performDeleteProcess = async (procToDelete: string) => {
    try {
      const updatedList = processes.filter(p => p !== procToDelete);
      await setDoc(doc(db, 'config', 'tmsProcesses'), { list: updatedList });
      setProcesses(updatedList);
      toast.success('Process deleted successfully.');
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'config/tmsProcesses');
    }
  };

  if (user.role === UserRole.TEAM_LEAD) {
    const mappedUsers = allUsers.filter(u => u.teamLeadId === user.uid);
    const activeShiftsList = allShifts.filter(sh => 
      mappedUsers.some(mu => mu.uid === sh.userId) && (sh.status === 'ACTIVE' || sh.status === 'BREAK')
    );
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
      if (mappedUsers.length === 0) {
        toast.error("No mapped agents to export");
        return;
      }

      const headers = [
        'Agent Name',
        'Agent Email',
        'Role',
        'Current Shift Status',
        'Active Process / Break',
        'Process Name',
        'Last Activity',
        'Today Clock In Time',
        'Total Shift Time (Min)',
        'Total Productive Time (Min)',
        'Total Break Time (Min)',
        'Overall Utilization (%)'
      ];

      const rows = mappedUsers.map(u => {
        const userShifts = allShifts.filter(sh => sh.userId === u.uid);
        const activeShift = userShifts.find(sh => sh.status === 'ACTIVE' || sh.status === 'BREAK');
        
        let currentStatus = 'Offline';
        let currentProcess = 'None';
        let clockInTime = 'N/A';
        
        if (activeShift) {
          currentStatus = activeShift.status === 'BREAK' ? 'On Break' : 'Active Work';
          const lastAct = activeShift.activities[activeShift.activities.length - 1];
          currentProcess = lastAct ? lastAct.name : 'N/A';
          clockInTime = new Date(activeShift.clockInTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
        }

        const lastShiftOfUser = userShifts.length > 0 ? userShifts[userShifts.length - 1] : null;
        const productiveAct = lastShiftOfUser ? [...lastShiftOfUser.activities].reverse().find(act => act.type === 'productive') : null;
        const processName = productiveAct ? productiveAct.name : 'N/A';
        const lastActObj = lastShiftOfUser && lastShiftOfUser.activities.length > 0 ? lastShiftOfUser.activities[lastShiftOfUser.activities.length - 1] : null;
        const lastActivity = lastActObj ? lastActObj.name : 'N/A';

        let totalShiftMins = 0;
        let totalProductiveMins = 0;
        let totalBreakMins = 0;
        let overallUtil = 100;

        let totalShiftMsSum = 0;
        let totalActiveMsSum = 0;

        userShifts.forEach(sh => {
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
          processName,
          lastActivity,
          clockInTime,
          totalShiftMins.toFixed(1),
          totalProductiveMins.toFixed(1),
          totalBreakMins.toFixed(1),
          overallUtil + '%'
        ];
      });

      const csvContent = "\uFEFF" + [headers.join(','), ...rows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
      
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `TMS_Utilization_Report_TL_${user.name.split(' ').join('_')}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      toast.success('Utilization Report exported successfully!');
    };

    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        {/* Upper header segment */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm text-slate-800">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-sky-600 flex items-center justify-center text-white shadow-lg shadow-sky-200">
              <Clock size={24} />
            </div>
            <div>
              <h2 className="text-2xl font-black text-slate-900 tracking-tight">Team Lead TMS Dashboard</h2>
              <p className="text-sm font-medium text-slate-500">Supervise logged-in agents, productivity rates, and export utilization reports</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleExportCSV}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2.5 px-4 rounded-xl flex items-center gap-1.5 shadow-sm shadow-emerald-200 cursor-pointer"
            >
              <FileSpreadsheet size={16} /> Export Team Report (CSV)
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
          <CardHeader className="border-b border-slate-100 pb-4">
            <CardTitle className="text-sm font-extrabold text-slate-900 uppercase tracking-widest flex items-center gap-2">
              <User size={16} className="text-sky-500" />
              Roster Session Audit & Real-time Tracking
            </CardTitle>
            <CardDescription className="text-xs">
              Live-monitored metrics for resources under your supervision.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
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
                  {mappedUsers.map((u) => {
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
                        <td className="p-4">
                          {activeShift ? (
                            <Badge className={`text-[10px] font-black uppercase ${
                              activeShift.status === 'BREAK' 
                                ? 'bg-amber-100 text-amber-800 border-amber-200' 
                                : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                            }`}>
                              LIVE - {activeShift.status}
                            </Badge>
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
                  {mappedUsers.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-16 text-center text-slate-400">
                        <div className="flex flex-col items-center gap-3">
                          <User size={36} className="text-slate-200" />
                          <p className="font-bold uppercase tracking-widest text-[10px] text-slate-400">No agents mapped to you</p>
                          <p className="text-xs text-slate-400 max-w-sm font-medium">Please ask your system administrator to assign Agents or Quality Analysts to your team under the Console tab.</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Filtering admin shift records
  const filteredAllShifts = allShifts.filter(s => 
    s.userName.toLowerCase().includes(adminSearch.toLowerCase()) ||
    s.userEmail.toLowerCase().includes(adminSearch.toLowerCase()) ||
    s.activities.some(act => act.name.toLowerCase().includes(adminSearch.toLowerCase()))
  );

  const handleExportAllShifts = () => {
    if (allShifts.length === 0) {
      toast.error("No shift logs at all to export");
      return;
    }

    const headers = [
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

    const rows = allShifts.map(sh => {
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
    });

    const csvContent = "\uFEFF" + [headers.join(','), ...rows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `TMS_All_Shifts_Utilization_Report_Admin.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    toast.success('Organization Utilization Report exported successfully!');
  };

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
          {user.role === UserRole.ADMIN && (
            <Button
              onClick={handleExportAllShifts}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2.5 px-4 rounded-xl flex items-center gap-1.5 shadow-sm shadow-emerald-200 cursor-pointer"
            >
              <FileSpreadsheet size={16} /> Export Organization Report (CSV)
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
        <div className="lg:col-span-5 space-y-6">
          <Card className="border-none shadow-md shadow-slate-200">
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
                    <select
                      className="w-full h-11 bg-white border border-slate-200 rounded-lg px-3 text-sm text-slate-900 font-bold focus:ring-2 focus:ring-sky-500 focus:outline-none"
                      value={selectedProcessInput}
                      onChange={(e) => setSelectedProcessInput(e.target.value)}
                    >
                      <option value="">-- Choose Process --</option>
                      {processes.map(proc => (
                        <option key={proc} value={proc}>{proc}</option>
                      ))}
                    </select>
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
                    <select
                      className="w-full h-11 bg-white border border-slate-200 rounded-lg px-3 text-xs text-slate-800 font-bold focus:ring-2 focus:ring-sky-500 focus:outline-none"
                      value={selectedProcessInput}
                      onChange={(e) => setSelectedProcessInput(e.target.value)}
                    >
                      <option value="">-- Choose target process --</option>
                      {processes.map(proc => (
                        <option key={proc} value={proc}>{proc}</option>
                      ))}
                    </select>
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
                    <Label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Switch Current Process</Label>
                    <div className="flex gap-2">
                      <select
                        className="flex-1 h-10 bg-white border border-slate-200 rounded-lg px-3 text-xs text-slate-800 font-bold focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        value={selectedProcessInput}
                        onChange={(e) => handleSwitchProcess(e.target.value)}
                      >
                        {processes.map(proc => (
                          <option key={proc} value={proc}>{proc}</option>
                        ))}
                      </select>
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
          {currentShift && (
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

        {/* Shift Timeline / Session History Column */}
        <div className="lg:col-span-7 space-y-6">
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

          {/* Past Shift History Logs */}
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
        </div>

      </div>

      {/* ADMIN PANEL - PROCESSES & LIVE TRACKER (Only layout for admins) */}
      {user.role === UserRole.ADMIN && (
        <div className="border-t border-slate-200 pt-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex items-center gap-3 bg-red-50/50 p-4 border border-red-100 rounded-xl">
            <LockIcon className="text-red-500 shrink-0" size={18} />
            <div>
              <h3 className="text-sm font-black text-red-950 uppercase tracking-wide">Admin control: Clock Master Consolidation</h3>
              <p className="text-[11px] font-bold text-red-800 leading-none mt-1">Supervise organization-wide utilization, live activity maps, and process configurations</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            {/* Processes Names Management (Add & Delete Process Names) */}
            <div className="lg:col-span-5 space-y-6">
              <Card className="border-none shadow-md shadow-slate-200">
                <CardHeader className="border-b border-slate-100 pb-4">
                  <CardTitle className="text-sm font-extrabold text-slate-900 uppercase tracking-widest">Process Settings Configuration</CardTitle>
                  <CardDescription className="text-xs">Add/delete processes served in the Punch Station dropdown</CardDescription>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <div className="flex gap-2">
                    <Input 
                      placeholder="e.g. Bulk QC, Escalation Handling, translation..." 
                      className="bg-white border-slate-200 focus:ring-sky-500 text-xs rounded-xl"
                      value={newProcessName}
                      onChange={(e) => setNewProcessName(e.target.value)}
                    />
                    <Button 
                      onClick={handleAddProcess}
                      className="bg-sky-500 hover:bg-sky-600 text-white font-bold text-xs h-10 px-4 shrink-0 rounded-xl cursor-pointer"
                    >
                      <Plus size={16} className="mr-1" /> Add Process
                    </Button>
                  </div>

                  <div className="border border-slate-100 rounded-xl divide-y divide-slate-100 max-h-60 overflow-y-auto">
                    {processes.map((proc) => (
                      <div key={proc} className="flex items-center justify-between p-3 text-xs bg-slate-50/20 hover:bg-slate-50 transition-colors">
                        <span className="font-extrabold text-slate-800">{proc}</span>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-rose-500 hover:text-rose-700 hover:bg-red-50 rounded-lg cursor-pointer"
                          onClick={() => handleDeleteProcess(proc)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    ))}
                    {processes.length === 0 && (
                      <div className="text-center py-8 text-xs text-slate-400 font-bold">No custom processes defined</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Realtime workforce dashboard & logs for Admin */}
            <div className="lg:col-span-7 space-y-6">
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
                        onChange={(e) => setAdminSearch(e.target.value)}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-0 max-h-96 overflow-y-auto">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="bg-slate-50 text-slate-500 border-b border-slate-100 font-bold uppercase tracking-widest text-[9px] select-none">
                          <th className="p-4 pl-6">Profile</th>
                          <th className="p-4">Process / Status</th>
                          <th className="p-4">Clocked Interval</th>
                          <th className="p-4 text-center">Calculated Utilization</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredAllShifts.map((sh) => {
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
                                <div>{stats.utilization}%</div>
                                <div className="text-[10px] text-slate-400 font-normal leading-none mt-1">
                                  Productive: {stats.activeStr} / {stats.totalShiftStr}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {filteredAllShifts.length === 0 && (
                          <tr>
                            <td colSpan={4} className="p-10 text-center opacity-40 font-bold uppercase tracking-widest text-[10px] text-slate-400">
                              No team records or matching logs found
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
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
