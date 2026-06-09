import React, { useState, useEffect, useMemo } from 'react';
import { db, auth } from '../../lib/firebase';
import { collection, query, getDocs, doc, setDoc, writeBatch, where, orderBy, getDoc, addDoc } from 'firebase/firestore';
import { UserProfile, UserRole } from '../../types';
import { usePermission } from '../PermissionContext';
import { toast } from 'sonner';
import { Calendar, RefreshCw, FileText, Download, CheckCircle, ClockAlert, XCircle, Search, Save, AlertCircle, Clock } from 'lucide-react';
import * as XLSX from 'xlsx';
import { motion } from 'motion/react';
import { MultiSelectDropdown } from '../ui/multi-select';

interface AttendanceSummary {
  id: string; // shiftId or date_uid
  shiftId: string;
  userId: string;
  employeeName: string;
  employeeEmail: string;
  employeeId?: string;
  process: string;
  mappedTL: string;
  mappedManager: string;
  attendanceDate: string; // YYYY-MM-DD
  attendanceStatus: 'Present' | 'Half Day' | 'Absent';
  productiveMinutes: number;
  totalBreakMinutes: number;
  sessionStart: string;
  sessionEnd: string;
  generatedBySystem: boolean;
  lastModifiedBy?: string;
  lastModifiedTimestamp?: string;
  isOvernight: boolean;
  isManuallyOverridden?: boolean;
}

interface AttendanceConfig {
  presentThreshold: number;
  halfDayThreshold: number;
  countBreakTime: boolean;
}

export default function AttendanceDashboard({ user, allUsers }: { user: UserProfile; allUsers: any[] }) {
  const { canEdit, canExport, hasTmsPermission } = usePermission();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [records, setRecords] = useState<AttendanceSummary[]>([]);
  const [config, setConfig] = useState<AttendanceConfig>({ presentThreshold: 480, halfDayThreshold: 240, countBreakTime: false });
  const [dateRange, setDateRange] = useState<'today' | 'yesterday' | 'week' | 'month' | 'current_month' | 'previous_month' | 'custom'>('today');
  
  // Filter / Pagination state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProcesses, setSelectedProcesses] = useState<string[]>([]);
  const [selectedTLs, setSelectedTLs] = useState<string[]>([]);
  const [selectedManagers, setSelectedManagers] = useState<string[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [filterManualOnly, setFilterManualOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  // Date Range state for Custom
  const [customStartDate, setCustomStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [customEndDate, setCustomEndDate] = useState(new Date().toISOString().split('T')[0]);

  // Real-time Employee Lookup
  const userLookup = useMemo(() => {
    const lookup: Record<string, any> = {};
    allUsers.forEach(u => {
      lookup[u.email.toLowerCase().trim()] = u;
    });
    return lookup;
  }, [allUsers]);

  const enhancedRecords = useMemo(() => {
    // 1. Group by employeeEmail + attendanceDate
    const groups: Record<string, AttendanceSummary[]> = {};
    records.forEach(r => {
        const key = `${r.employeeEmail}_${r.attendanceDate}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });

    // 2. Consolidate
    const consolidated = Object.values(groups).map(group => {
        if (group.length === 1) return group[0];
        
        const totalProd = group.reduce((sum, r) => sum + r.productiveMinutes, 0);
        const totalBreak = group.reduce((sum, r) => sum + r.totalBreakMinutes, 0);
        
        const base = group[0];
        const isManual = group.some(r => r.isManuallyOverridden);
        let status;
        if (isManual) {
             // If manually overridden, prioritize the overridden status
             const manualRecord = group.find(r => r.isManuallyOverridden && r.attendanceStatus);
             status = manualRecord?.attendanceStatus || (totalProd >= config.presentThreshold ? 'Present' : (totalProd >= config.halfDayThreshold ? 'Half Day' : 'Absent'));
        } else {
             status = totalProd >= config.presentThreshold ? 'Present' : (totalProd >= config.halfDayThreshold ? 'Half Day' : 'Absent');
        }
        
        return {
            ...base,
            productiveMinutes: totalProd,
            totalBreakMinutes: totalBreak,
            attendanceStatus: status,
            sessionStart: group.reduce((min, r) => new Date(r.sessionStart) < new Date(min) ? r.sessionStart : min, group[0].sessionStart),
            sessionEnd: group.reduce((max, r) => new Date(r.sessionEnd) > new Date(max) ? r.sessionEnd : max, group[0].sessionEnd),
            isManuallyOverridden: group.some(r => r.isManuallyOverridden),
            isOvernight: group.some(r => r.isOvernight),
        };
    });

    // 3. Map for enhancement
    return consolidated.map(r => {
      const user = userLookup[r.employeeEmail.toLowerCase().trim()];
      if (!user) return r;

      return {
        ...r,
        process: r.process !== 'N/A' && r.process ? r.process : (user.process || 'N/A'),
        mappedTL: r.mappedTL !== 'N/A' && r.mappedTL ? r.mappedTL : (user.teamLeadName || 'N/A'),
        mappedManager: r.mappedManager !== 'N/A' && r.mappedManager ? r.mappedManager : (user.mappedManagerName || user.Manager || 'N/A'),
        employeeId: r.employeeId || user.employeeId || ''
      };
    });
  }, [records, userLookup, config]);

  const filteredRecords = useMemo(() => {
    return enhancedRecords.filter(r => {
      const matchesSearch = !searchTerm || r.employeeName.toLowerCase().includes(searchTerm.toLowerCase()) || r.employeeEmail.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesProcess = selectedProcesses.length === 0 || selectedProcesses.includes(r.process);
      const matchesTL = selectedTLs.length === 0 || selectedTLs.includes(r.mappedTL);
      const matchesManager = selectedManagers.length === 0 || selectedManagers.includes(r.mappedManager);
      const matchesStatus = selectedStatuses.length === 0 || selectedStatuses.includes(r.attendanceStatus);
      const matchesManual = !filterManualOnly || !!r.isManuallyOverridden;
      
      return matchesSearch && matchesProcess && matchesTL && matchesManager && matchesStatus && matchesManual;
    });
  }, [enhancedRecords, searchTerm, selectedProcesses, selectedTLs, selectedManagers, selectedStatuses, filterManualOnly]);

  const paginatedRecords = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredRecords.slice(start, start + itemsPerPage);
  }, [filteredRecords, currentPage]);

  const totalPages = Math.ceil(filteredRecords.length / itemsPerPage);

  // Computed summary
  const summary = useMemo(() => {
    const present = filteredRecords.filter(r => r.attendanceStatus === 'Present').length;
    const halfDay = filteredRecords.filter(r => r.attendanceStatus === 'Half Day').length;
    const absent = filteredRecords.filter(r => r.attendanceStatus === 'Absent').length;
    const manualOverrides = filteredRecords.filter(r => r.isManuallyOverridden).length;
    const total = filteredRecords.length;
    const attendancePct = total > 0 ? (((present + halfDay * 0.5) / total) * 100).toFixed(1) : 0;
    return { present, halfDay, absent, attendancePct, manualOverrides };
  }, [filteredRecords]);
  
  // Edit state
  const [editingRecord, setEditingRecord] = useState<AttendanceSummary | null>(null);
  const [editStatus, setEditStatus] = useState<'Present' | 'Half Day' | 'Absent'>('Present');
  const [editComment, setEditComment] = useState('');
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [exportFormatModal, setExportFormatModal] = useState(false);

  // Authorization for edits
  const canModifyAttendance = canEdit('Attendance');
  const canExportAttendance = canExport('Attendance');
  const isManagerOrAdmin = ['ADMIN', 'MANAGER', 'MIS', 'QTL', 'STL', 'OPS_TL', 'TRAINER_TL', 'TL'].includes(user.role.toUpperCase());

  // Dynamic Process filter: If IC, only show processes user has worked in
  const availableProcesses = useMemo(() => {
    const list = Array.from(new Set(allUsers.map(u => u.process).filter(p => p !== 'N/A' && !!p)));
    return list.sort();
  }, [allUsers]);

  const availableTLs = useMemo(() => {
    const list = Array.from(new Set(allUsers.map(u => u.teamLeadName).filter(tl => tl !== 'N/A' && !!tl)));
    return list.sort();
  }, [allUsers]);

  const availableManagers = useMemo(() => {
    const list = Array.from(new Set(allUsers.map(u => u.mappedManagerName || u.Manager).filter(m => m !== 'N/A' && !!m)));
    return list.sort();
  }, [allUsers]);

  const openEditModal = (r: AttendanceSummary) => {
    setEditingRecord(r);
    setEditStatus(r.attendanceStatus);
    setEditComment('');
    setShowHistory(false);
    
    // Fetch logs
    const q = query(collection(db, 'attendanceAuditLogs'), where('attendanceId', '==', r.id), orderBy('timestamp', 'desc'));
    getDocs(q).then(snap => setAuditLogs(snap.docs.map(d => d.data())));
  };

  useEffect(() => {
    loadData();
  }, [dateRange]);
  const loadData = async () => {
    setLoading(true);
    try {
      // 1. Fetch Config
      const confSnap = await getDoc(doc(db, 'config', 'attendanceSettings'));
      let currConfig = { presentThreshold: 480, halfDayThreshold: 240, countBreakTime: false };
      if (confSnap.exists()) {
        const c = confSnap.data();
        currConfig = {
          presentThreshold: c.presentThreshold ?? 480,
          halfDayThreshold: c.halfDayThreshold ?? 240,
          countBreakTime: c.countBreakTime ?? false
        };
        setConfig(currConfig);
      }

      // 2. Fetch Records based on dateRange
      const now = new Date();
      let startDate = new Date();
      let endDate = new Date();

      if (dateRange === 'today') {
        startDate = new Date();
        startDate.setHours(0,0,0,0);
        endDate = new Date();
        endDate.setHours(23,59,59,999);
      } else if (dateRange === 'yesterday') {
        startDate = new Date(now.setDate(now.getDate() - 1));
        startDate.setHours(0,0,0,0);
        endDate = new Date(startDate);
        endDate.setHours(23,59,59,999);
      } else if (dateRange === 'week') {
        startDate.setDate(now.getDate() - 7);
      } else if (dateRange === 'month') {
        startDate.setDate(now.getDate() - 30);
      } else if (dateRange === 'current_month') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      } else if (dateRange === 'previous_month') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), 0);
      } else if (dateRange === 'custom') {
        startDate = new Date(customStartDate);
        endDate = new Date(customEndDate);
      }
      
      const attRef = collection(db, 'attendanceSummary');
      const q = query(attRef, where('attendanceDate', '>=', startDate.toISOString().split('T')[0]), where('attendanceDate', '<=', endDate.toISOString().split('T')[0]));
      const snap = await getDocs(q);
      
      const attData = snap.docs.map(d => ({ ...d.data(), id: d.id } as AttendanceSummary));
      attData.sort((a, b) => new Date(b.sessionStart).getTime() - new Date(a.sessionStart).getTime());
      
      let filtered = attData;
      // If not manager/admin, filter to see only their team/self (if required)
      // Assuming a manager/admin can view all. Based on role.
      if (!['ADMIN', 'MANAGER', 'MIS'].includes(user.role.toUpperCase())) {
         filtered = attData.filter(r => r.userId === user.uid || r.mappedTL === user.email || r.mappedManager === user.email);
      }

      setRecords(filtered);
    } catch (e: any) {
      console.error('Error loading attendance records:', e);
      toast.error(`Failed to load attendance records: ${e.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const calculateStatus = (productiveMins: number, thresholdConf: AttendanceConfig): 'Present' | 'Half Day' | 'Absent' => {
     if (productiveMins >= thresholdConf.presentThreshold) return 'Present';
     if (productiveMins >= thresholdConf.halfDayThreshold) return 'Half Day';
     return 'Absent';
  };

  const handleSyncAttendance = async () => {
    setSyncing(true);
    try {
      // 1. Fetch completed shifts that might not have attendance
      const shiftsRef = collection(db, 'tmsShifts');
      const lastWeek = new Date();
      lastWeek.setDate(lastWeek.getDate() - 14); // Sync last 14 days
      const qShifts = query(shiftsRef, where('status', '==', 'COMPLETED'), where('clockInTime', '>=', lastWeek.toISOString()));
      const shiftsSnap = await getDocs(qShifts);
      
      // Fetch existing attendances to prevent duplicate logic
      const attSnap = await getDocs(query(collection(db, 'attendanceSummary'), where('attendanceDate', '>=', lastWeek.toISOString().split('T')[0])));
      const existingShiftIds = new Set(attSnap.docs.map(d => d.data().shiftId));

      let batch = writeBatch(db);
      let newCount = 0;
      let batchCount = 0;

      for (const docSnap of shiftsSnap.docs) {
        const shift = docSnap.data();
        if (existingShiftIds.has(shift.id)) continue; 

        // Calculate
        const startMs = new Date(shift.clockInTime).getTime();
        const endMs = shift.clockOutTime ? new Date(shift.clockOutTime).getTime() : startMs;
        
        let prodMs = 0;
        let breakMs = 0;
        (shift.activities || []).forEach((act: any) => {
          const aStart = new Date(act.startTime).getTime();
          const aEnd = act.endTime ? new Date(act.endTime).getTime() : endMs;
          const dur = Math.max(0, aEnd - aStart);
          if (act.type === 'productive') prodMs += dur;
          else breakMs += dur;
        });

        let totalMins = Math.floor(prodMs / 60000);
        if (config.countBreakTime) {
          totalMins += Math.floor(breakMs / 60000);
        }

        const dateStr = shift.clockInTime.split('T')[0];
        const isOvernight = shift.clockOutTime ? (shift.clockInTime.split('T')[0] !== shift.clockOutTime.split('T')[0]) : false;

        const summary: AttendanceSummary = {
          id: shift.id,
          shiftId: shift.id,
          userId: shift.userId,
          employeeName: shift.userName || shift.userEmail,
          employeeEmail: shift.userEmail,
          employeeId: shift.employeeId || '',
          process: shift.process || 'N/A',
          mappedTL: shift.mappedTL || 'N/A',
          mappedManager: shift.mappedManager || 'N/A',
          attendanceDate: dateStr,
          attendanceStatus: calculateStatus(totalMins, config),
          productiveMinutes: totalMins,
          totalBreakMinutes: Math.floor(breakMs / 60000),
          sessionStart: shift.clockInTime,
          sessionEnd: shift.clockOutTime || shift.clockInTime,
          generatedBySystem: true,
          isOvernight
        };

        const attDocRef = doc(db, 'attendanceSummary', shift.id);
        batch.set(attDocRef, summary);
        newCount++;
        batchCount++;

        if (batchCount >= 450) {
            await batch.commit();
            batch = writeBatch(db);
            batchCount = 0;
        }
      }

      if (batchCount > 0) {
        await batch.commit();
      }

      if (newCount > 0) {
        toast.success(`Successfully synchronized ${newCount} new attendance records.`);
        loadData();
      } else {
        toast.info('Attendance is already up to date for recent sessions.');
      }
    } catch (e) {
      console.error(e);
      toast.error('Failed to synchronize attendance');
    } finally {
      setSyncing(false);
    }
  };

  const handleUpdateRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRecord || !editComment.trim()) return;

    try {
      const oldStatus = editingRecord.attendanceStatus;
      
      const updateData = {
        attendanceStatus: editStatus,
        lastModifiedBy: user.email,
        lastModifiedTimestamp: new Date().toISOString(),
        isManuallyOverridden: true
      };

      await setDoc(doc(db, 'attendanceSummary', editingRecord.id), updateData, { merge: true });

      // Add to Audit Trail
      await addDoc(collection(db, 'attendanceAuditLogs'), {
        attendanceId: editingRecord.id,
        employeeEmail: editingRecord.employeeEmail,
        date: editingRecord.attendanceDate,
        originalStatus: oldStatus,
        newStatus: editStatus,
        reason: editComment,
        modifiedBy: `${user.name} (${user.email})`,
        timestamp: new Date().toISOString()
      });

      toast.success('Attendance updated successfully.');
      setEditingRecord(null);
      setEditComment('');
      loadData();

    } catch (e) {
      console.error(e);
      toast.error('Failed to update attendance');
    }
  };

  const runExport = (format: 'csv' | 'xlsx') => {
    let data = filteredRecords.map(r => ({
      'Employee Name': r.employeeName,
      'Email': r.employeeEmail,
      'Employee ID': r.employeeId || '',
      'Process': r.process,
      'Team Lead': r.mappedTL,
      'Manager': r.mappedManager,
      'Attendance Date': r.attendanceDate,
      'Session Start': new Date(r.sessionStart).toLocaleString(),
      'Session End': new Date(r.sessionEnd).toLocaleString(),
      'Productive Minutes': r.productiveMinutes,
      'Attendance Status': r.attendanceStatus,
      'Modified By': r.lastModifiedBy || '',
      'Last Modified Timestamp': r.lastModifiedTimestamp || ''
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance_Data');
    
    const fileName = `Attendance_Report_${new Date().toISOString().split('T')[0]}`;
    if (format === 'csv') {
       XLSX.writeFile(wb, `${fileName}.csv`, { bookType: 'csv' });
    } else {
       XLSX.writeFile(wb, `${fileName}.xlsx`);
    }
    setExportFormatModal(false);
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 overflow-hidden relative">
      <div className="shrink-0 p-5 border-b border-slate-100 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-800 dark:text-slate-100 tracking-tight flex items-center gap-2">
            <Calendar className="text-indigo-500" /> Attendance Register
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <select value={dateRange} onChange={(e) => setDateRange(e.target.value as any)} className="bg-slate-50 dark:bg-slate-800 border-none text-xs font-bold rounded-xl px-3 py-2 text-slate-600 dark:text-slate-300">
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="week">Last 7 Days</option>
            <option value="month">Last 30 Days</option>
            <option value="current_month">Current Month</option>
            <option value="previous_month">Previous Month</option>
            <option value="custom">Custom Range</option>
          </select>
          {dateRange === 'custom' && (
            <div className="flex items-center gap-2">
              <input type="date" value={customStartDate} onChange={e => setCustomStartDate(e.target.value)} className="bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-3 py-2 text-xs font-bold text-slate-600 dark:text-slate-300" />
              <span className="text-slate-400">to</span>
              <input type="date" value={customEndDate} onChange={e => setCustomEndDate(e.target.value)} className="bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-3 py-2 text-xs font-bold text-slate-600 dark:text-slate-300" />
            </div>
          )}
          {canExportAttendance && (
            <button onClick={() => setExportFormatModal(true)} className="flex items-center gap-2 px-3 py-2 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400 rounded-xl font-bold text-xs transition-colors">
              <Download size={14} /> Export
            </button>
          )}
          <button onClick={() => {
            if (['ADMIN', 'MANAGER', 'MIS'].includes(user.role.toUpperCase())) {
              handleSyncAttendance();
            } else {
              toast.error('Only Admins or Managers can perform a full sync.');
            }
          }} disabled={syncing} className="flex items-center gap-2 px-3 py-2 bg-indigo-500 text-white hover:bg-indigo-600 rounded-xl font-bold text-xs transition-colors">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing...' : 'Sync From TMS'}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="p-5 grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { label: 'Present', val: summary.present, color: 'text-emerald-600' },
          { label: 'Half Day', val: summary.halfDay, color: 'text-amber-600' },
          { label: 'Absent', val: summary.absent, color: 'text-rose-600' },
          { label: 'Attendance %', val: `${summary.attendancePct}%`, color: 'text-indigo-600' },
          { label: 'Manual Overrides', val: summary.manualOverrides, color: 'text-slate-600' }
        ].map((c, i) => (
          <div key={i} className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
            <div className="text-xs font-medium text-slate-500 uppercase">{c.label}</div>
            <div className={`text-3xl font-black ${c.color}`}>{c.val}</div>
          </div>
        ))}
      </div>

      {/* Advanced Filters */}
      <div className="px-5 pb-5 flex flex-wrap gap-3">
        <input type="text" placeholder="Search Employee..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-2 text-xs font-bold" />
        <MultiSelectDropdown 
          options={['Present', 'Half Day', 'Absent']}
          selectedValues={selectedStatuses}
          onToggle={(val) => setSelectedStatuses(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
          placeholder="All Statuses"
        />
        <MultiSelectDropdown 
          options={availableProcesses}
          selectedValues={selectedProcesses}
          onToggle={(val) => setSelectedProcesses(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
          placeholder="All Processes"
        />
        {isManagerOrAdmin && (
          <>
            <MultiSelectDropdown 
              options={availableTLs}
              selectedValues={selectedTLs}
              onToggle={(val) => setSelectedTLs(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
              placeholder="All Team Leads"
            />
            <MultiSelectDropdown 
              options={availableManagers}
              selectedValues={selectedManagers}
              onToggle={(val) => setSelectedManagers(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
              placeholder="All Managers"
            />
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <div className="flex items-center justify-center p-12 text-sm text-slate-400">Loading Attendance...</div>
        ) : (
          <div className="space-y-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 text-sm font-black tracking-wider text-slate-500">
                    <th className="p-3">Employee</th>
                    <th className="p-3">Date</th>
                    <th className="p-3">Session Times</th>
                    <th className="p-3">Productive Mins</th>
                    <th className="p-3">Status</th>
                    {canModifyAttendance && <th className="p-3 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {paginatedRecords.map(r => (
                    <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                      <td className="p-3">
                        <div className="font-bold text-slate-800 dark:text-slate-200 text-sm">{r.employeeName}</div>
                        <div className="text-xs text-slate-400">{r.employeeEmail}</div>
                        {r.isOvernight && <span className="mt-1 inline-flex items-center gap-1 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase"><Clock size={10} /> Overnight</span>}
                      </td>
                      <td className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300">
                        {r.attendanceDate}
                      </td>
                      <td className="p-3 text-sm text-slate-500 font-mono">
                        {new Date(r.sessionStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  &rarr;  
                        {new Date(r.sessionEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="p-3">
                        <div className="font-mono text-sm font-black text-slate-700 dark:text-slate-300">
                          {r.productiveMinutes}
                        </div>
                        <div className="text-xs text-slate-400">Break: {r.totalBreakMinutes}m</div>
                      </td>
                      <td className="p-3">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-black uppercase ${
                          r.attendanceStatus === 'Present' ? 'bg-emerald-100 text-emerald-800' :
                          r.attendanceStatus === 'Half Day' ? 'bg-amber-100 text-amber-800' :
                          'bg-rose-100 text-rose-800'
                        }`}>
                          {r.attendanceStatus === 'Present' ? <CheckCircle size={12} /> : 
                           r.attendanceStatus === 'Half Day' ? <ClockAlert size={12} /> : <XCircle size={12} />}
                          {r.attendanceStatus}
                        </span>
                        {r.lastModifiedBy && <div className="text-[9px] text-slate-400 mt-1">Edited manually</div>}
                      </td>
                      {canModifyAttendance && (
                        <td className="p-4 text-right">
                          <button 
                            onClick={() => openEditModal(r)}
                            className="text-xs font-bold text-indigo-500 hover:text-indigo-600 px-2 py-1 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
                          >
                            Modify
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {paginatedRecords.length === 0 && (
                    <tr>
                      <td colSpan={canModifyAttendance ? 6 : 5} className="p-8 text-center text-slate-400 text-sm">
                        No matching records found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex justify-center gap-2 mt-4">
                <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)} className="px-3 py-1 bg-slate-100 rounded-lg text-xs font-bold disabled:opacity-50">Prev</button>
                <span className="px-3 py-1 text-xs font-bold flex items-center">Page {currentPage} of {totalPages}</span>
                <button disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)} className="px-3 py-1 bg-slate-100 rounded-lg text-xs font-bold disabled:opacity-50">Next</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editingRecord && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-6 w-full max-w-md border border-slate-200 dark:border-slate-800"
          >
            <h3 className="text-lg font-black text-slate-800 dark:text-slate-100 mb-4">Modify Attendance</h3>
            <p className="text-xs text-slate-500 mb-4">You are changing the attendance status for <b>{editingRecord.employeeName}</b> on <b>{editingRecord.attendanceDate}</b>.</p>
            
            <form onSubmit={handleUpdateRecord} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-600 block mb-1">New Status</label>
                <div className="flex gap-2">
                  {['Present', 'Half Day', 'Absent'].map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setEditStatus(s as any)}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors ${
                        editStatus === s 
                          ? 'bg-indigo-600 text-white' 
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-600 block mb-1">Reason for Modification (Mandatory)</label>
                <textarea 
                  required
                  rows={3}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
                  placeholder="E.g. System missed clock out, corrected manually based on confirmation."
                  value={editComment}
                  onChange={e => setEditComment(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button 
                  type="button" 
                  onClick={() => setEditingRecord(null)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  disabled={!editComment.trim() || editStatus === editingRecord.attendanceStatus}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
      
      {/* Export Format Modal */}
      {exportFormatModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-6 w-full max-w-xs border border-slate-200 dark:border-slate-800">
            <h3 className="text-lg font-black text-slate-800 dark:text-slate-100 mb-4">Select Export Format</h3>
            <div className="flex gap-2">
              <button onClick={() => runExport('csv')} className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-colors">CSV</button>
              <button onClick={() => runExport('xlsx')} className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-colors">Excel (.xlsx)</button>
              <button onClick={() => setExportFormatModal(false)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold">Cancel</button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
