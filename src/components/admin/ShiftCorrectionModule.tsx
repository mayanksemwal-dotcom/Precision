import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { db, auth, getDocsCacheFirst } from '../../lib/firebase';
import { 
  collection, 
  getDocs, 
  doc, 
  updateDoc, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  limit, 
  startAfter, 
  DocumentData, 
  QueryDocumentSnapshot 
} from 'firebase/firestore';
import { 
  Search, 
  Filter, 
  Calendar, 
  Clock, 
  Edit3, 
  History, 
  CheckCircle2, 
  AlertTriangle, 
  ChevronLeft, 
  ChevronRight, 
  X, 
  Plus, 
  Trash2, 
  RefreshCw, 
  ShieldAlert, 
  Activity, 
  User, 
  Tag, 
  Save 
} from 'lucide-react';
import { toast } from 'sonner';
import { calculateShiftMetrics, calculateAttendanceDate } from '../../lib/tmsCalculationEngine';
import { appendShiftEvent } from '../../lib/shiftLedger';
import { parseTimestampMs, formatMs } from '../../lib/ledgerCalculations';

interface ShiftCorrectionModuleProps {
  adminTheme: 'light' | 'dark';
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

interface HistoricalShiftItem {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  clockInTime: string;
  clockOutTime?: string | null;
  status: string;
  process?: string;
  activities: any[];
  shiftEventLedger?: any[];
  [key: string]: any;
}

export const ShiftCorrectionModule: React.FC<ShiftCorrectionModuleProps> = ({
  adminTheme,
  logAdminEvent
}) => {
  // Filters
  const [filterEmail, setFilterEmail] = useState('');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Query state & Pagination
  const [shifts, setShifts] = useState<HistoricalShiftItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [firstDocHistory, setFirstDocHistory] = useState<QueryDocumentSnapshot<DocumentData>[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // Selected shift for detailed modal view & correction
  const [selectedShift, setSelectedShift] = useState<HistoricalShiftItem | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  // Edit form state
  const [editClockIn, setEditClockIn] = useState('');
  const [editClockOut, setEditClockOut] = useState('');
  const [editStatus, setEditStatus] = useState<'ACTIVE' | 'BREAK' | 'COMPLETED' | 'AUTO_CLOSED'>('COMPLETED');
  const [editProcess, setEditProcess] = useState('');
  const [editActivities, setEditActivities] = useState<any[]>([]);
  const [correctionReason, setCorrectionReason] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Convert ISO string to format required by datetime-local input (YYYY-MM-DDTHH:mm)
  const toDateTimeLocal = (isoStr?: string | null) => {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return '';
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return '';
    }
  };

  // Convert datetime-local value to ISO string
  const toISOString = (dtLocal: string) => {
    if (!dtLocal) return null;
    try {
      const d = new Date(dtLocal);
      return !isNaN(d.getTime()) ? d.toISOString() : null;
    } catch {
      return null;
    }
  };

  // Fetch paginated historical shifts with explicit filters
  const fetchShifts = useCallback(async (isInitial = true, afterDoc: QueryDocumentSnapshot<DocumentData> | null = null) => {
    setLoading(true);
    try {
      const startIso = new Date(`${startDate}T00:00:00.000Z`).toISOString();
      const endIso = new Date(`${endDate}T23:59:59.999Z`).toISOString();

      let q;
      const cleanEmail = filterEmail.trim().toLowerCase();

      if (cleanEmail) {
        if (afterDoc) {
          q = query(
            collection(db, 'tmsShifts'),
            where('userEmail', '==', cleanEmail),
            where('clockInTime', '>=', startIso),
            where('clockInTime', '<=', endIso),
            orderBy('clockInTime', 'desc'),
            startAfter(afterDoc),
            limit(10)
          );
        } else {
          q = query(
            collection(db, 'tmsShifts'),
            where('userEmail', '==', cleanEmail),
            where('clockInTime', '>=', startIso),
            where('clockInTime', '<=', endIso),
            orderBy('clockInTime', 'desc'),
            limit(10)
          );
        }
      } else {
        if (afterDoc) {
          q = query(
            collection(db, 'tmsShifts'),
            where('clockInTime', '>=', startIso),
            where('clockInTime', '<=', endIso),
            orderBy('clockInTime', 'desc'),
            startAfter(afterDoc),
            limit(10)
          );
        } else {
          q = query(
            collection(db, 'tmsShifts'),
            where('clockInTime', '>=', startIso),
            where('clockInTime', '<=', endIso),
            orderBy('clockInTime', 'desc'),
            limit(10)
          );
        }
      }

      // Use IndexedDB persistence to reduce unnecessary reads for historical data.
      // We do not force server fetch here because historical shifts are generally stable,
      // and we want to optimize cost/performance using Firestore local cache semantics.
      const snap = await getDocsCacheFirst(q, 'adminShiftCorrection_tmsShifts');
      const items: HistoricalShiftItem[] = snap.docs.map(docSnap => {
        const data = docSnap.data() as any;
        return {
          id: docSnap.id,
          userId: data.userId || '',
          userName: data.userName || data.employeeName || 'Unknown',
          userEmail: data.userEmail || data.email || '',
          clockInTime: data.clockInTime || '',
          clockOutTime: data.clockOutTime || null,
          status: (data.status || 'COMPLETED').toUpperCase(),
          process: data.process || data.currentProcess || 'General',
          activities: Array.isArray(data.activities) ? data.activities : [],
          shiftEventLedger: Array.isArray(data.shiftEventLedger) ? data.shiftEventLedger : [],
          ...data
        };
      });

      setShifts(items);
      setHasMore(snap.docs.length === 10);
      if (snap.docs.length > 0) {
        setLastDoc(snap.docs[snap.docs.length - 1]);
      } else {
        setLastDoc(null);
      }

      if (isInitial) {
        setPageNumber(1);
        setFirstDocHistory([]);
      }
      setHasSearched(true);
    } catch (err: any) {
      console.error('Error fetching historical shifts for correction:', err);
      toast.error(`Shift query error: ${err.message || 'Check date/email filters'}`);
    } finally {
      setLoading(false);
    }
  }, [filterEmail, startDate, endDate]);

  const handleNextPage = () => {
    if (!lastDoc || !hasMore) return;
    setFirstDocHistory(prev => [...prev, lastDoc]);
    setPageNumber(prev => prev + 1);
    fetchShifts(false, lastDoc);
  };

  const handlePrevPage = () => {
    if (pageNumber <= 1) return;
    // Re-fetch from start for safe pagination without backward cursors
    fetchShifts(true);
  };

  const openShiftDetail = (shift: HistoricalShiftItem) => {
    setSelectedShift(shift);
    setIsEditing(false);
  };

  const startEditShift = (shift: HistoricalShiftItem) => {
    setSelectedShift(shift);
    setEditClockIn(toDateTimeLocal(shift.clockInTime));
    setEditClockOut(toDateTimeLocal(shift.clockOutTime));
    setEditStatus((shift.status as any) || 'COMPLETED');
    setEditProcess(shift.process || 'General');
    setEditActivities(
      (shift.activities || []).map(a => ({
        activityId: a.activityId || crypto.randomUUID(),
        action: a.action || 'ACTIVITY',
        type: a.type || 'productive',
        name: a.name || a.process || 'Work',
        startTime: toDateTimeLocal(a.startTime),
        endTime: toDateTimeLocal(a.endTime)
      }))
    );
    setCorrectionReason('');
    setIsEditing(true);
  };

  const handleAddActivity = () => {
    setEditActivities(prev => [
      ...prev,
      {
        activityId: crypto.randomUUID(),
        action: 'PROCESS_SWITCH',
        type: 'productive',
        name: editProcess || 'Active Work',
        startTime: editClockIn,
        endTime: editClockOut
      }
    ]);
  };

  const handleRemoveActivity = (index: number) => {
    setEditActivities(prev => prev.filter((_, idx) => idx !== index));
  };

  const handleUpdateActivity = (index: number, field: string, value: string) => {
    setEditActivities(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSaveCorrection = async () => {
    if (!selectedShift) return;
    if (!correctionReason.trim()) {
      toast.error('Mandatory: Please provide a reason for this historical shift correction.');
      return;
    }

    const newClockInIso = toISOString(editClockIn);
    if (!newClockInIso) {
      toast.error('Invalid Clock In time specified.');
      return;
    }

    const newClockOutIso = editClockOut ? toISOString(editClockOut) : null;
    if (newClockOutIso && parseTimestampMs(newClockOutIso) < parseTimestampMs(newClockInIso)) {
      toast.error('Clock Out time cannot be earlier than Clock In time.');
      return;
    }

    setIsSaving(true);
    const shiftId = selectedShift.id;

    try {
      const actorEmail = auth.currentUser?.email || 'admin@precision360.internal';
      const actorName = auth.currentUser?.displayName || actorEmail.split('@')[0];
      const nowIso = new Date().toISOString();

      // Format clean activities array
      const formattedActivities = editActivities.map(a => ({
        activityId: a.activityId || crypto.randomUUID(),
        action: a.action || 'ACTIVITY',
        type: a.type || 'productive',
        name: a.name || 'Work',
        startTime: toISOString(a.startTime) || newClockInIso,
        endTime: a.endTime ? toISOString(a.endTime) : undefined,
        actor: actorName,
        sourceService: 'ADMIN_CORRECTION'
      }));

      // If activities is empty, ensure default clock-in activity exists
      if (formattedActivities.length === 0) {
        formattedActivities.push({
          activityId: crypto.randomUUID(),
          action: 'CLOCK_IN',
          type: 'productive',
          name: editProcess || 'Active Work',
          startTime: newClockInIso,
          endTime: newClockOutIso || undefined,
          actor: actorName,
          sourceService: 'ADMIN_CORRECTION'
        });
      }

      // Rebuild shift object for metric calculation
      const shiftForCalc = {
        ...selectedShift,
        clockInTime: newClockInIso,
        clockOutTime: newClockOutIso,
        status: editStatus,
        process: editProcess,
        activities: formattedActivities
      };

      const metrics = calculateShiftMetrics(shiftForCalc);

      // Append shift event ledger
      const updatedLedger = appendShiftEvent(
        selectedShift.shiftEventLedger,
        selectedShift,
        {
          eventType: 'MANUAL_CORRECTION',
          timestamp: nowIso,
          performedBy: actorName,
          source: 'ADMIN_SHIFT_CORRECTION',
          reason: correctionReason,
          oldValue: `In: ${selectedShift.clockInTime} | Out: ${selectedShift.clockOutTime || 'Ongoing'} | Status: ${selectedShift.status}`,
          newValue: `In: ${newClockInIso} | Out: ${newClockOutIso || 'Ongoing'} | Status: ${editStatus}`,
          metadata: {
            correctionReason,
            recalculatedProductiveMs: metrics.productiveMs,
            recalculatedBreakMs: metrics.breakMs,
            recalculatedElapsedMs: metrics.elapsedMs
          }
        }
      );

      // Build authoritative update payload
      const updatePayload: Record<string, any> = {
        clockInTime: newClockInIso,
        clockOutTime: newClockOutIso,
        status: editStatus,
        process: editProcess,
        activities: formattedActivities,
        shiftEventLedger: updatedLedger,
        duration: metrics.elapsedMs,
        productiveTime: Math.floor(metrics.productiveMs / 60000),
        totalBreakTime: Math.floor(metrics.breakMs / 60000),
        productiveDurationMs: metrics.productiveMs,
        breakDurationMs: metrics.breakMs,
        activeWorkDurationMs: metrics.activeWorkMs,
        utilizationRate: metrics.utilization,
        lastCorrectedAt: nowIso,
        lastCorrectedBy: actorEmail,
        correctionReason: correctionReason
      };

      // 1. Authoritative shift update (Preserves shift ID, never duplicates)
      const shiftRef = doc(db, 'tmsShifts', shiftId);
      await updateDoc(shiftRef, updatePayload);

      // 2. Write structured audit log to audit_logs
      await addDoc(collection(db, 'audit_logs'), {
        action: 'SHIFT_CORRECTION',
        correctedBy: actorEmail,
        timestamp: nowIso,
        employee: selectedShift.userEmail || selectedShift.userName,
        employeeUid: selectedShift.userId,
        shiftId: shiftId,
        oldValues: {
          clockInTime: selectedShift.clockInTime,
          clockOutTime: selectedShift.clockOutTime,
          status: selectedShift.status,
          process: selectedShift.process,
          activitiesCount: (selectedShift.activities || []).length
        },
        newValues: {
          clockInTime: newClockInIso,
          clockOutTime: newClockOutIso,
          status: editStatus,
          process: editProcess,
          activitiesCount: formattedActivities.length,
          recalculatedMetrics: {
            productiveMs: metrics.productiveMs,
            breakMs: metrics.breakMs,
            elapsedMs: metrics.elapsedMs,
            utilization: metrics.utilization
          }
        },
        reason: correctionReason
      });

      // 3. Write to attendanceAuditLogs
      await addDoc(collection(db, 'attendanceAuditLogs'), {
        shiftId,
        employeeUid: selectedShift.userId,
        employeeName: selectedShift.userName,
        employeeEmail: selectedShift.userEmail,
        modifiedBy: actorEmail,
        timestamp: nowIso,
        reason: correctionReason,
        operation: 'ADMIN_MANUAL_SHIFT_CORRECTION'
      });

      // 4. Log admin event
      await logAdminEvent(
        'Shift Record Corrected',
        selectedShift.userName || selectedShift.userEmail,
        `Shift ${shiftId} [${selectedShift.status}]`,
        `Corrected [${editStatus}] - Reason: ${correctionReason}`
      );

      toast.success(`Shift ${shiftId} successfully corrected with full audit logging.`);

      // Update local state
      const updatedShiftData: HistoricalShiftItem = {
        ...selectedShift,
        ...updatePayload
      };
      setShifts(prev => prev.map(s => (s.id === shiftId ? updatedShiftData : s)));
      setSelectedShift(updatedShiftData);
      setIsEditing(false);
    } catch (err: any) {
      console.error('Failed to correct shift:', err);
      toast.error(`Shift correction failed: ${err.message || 'Database error'}`);
    } finally {
      setIsSaving(false);
    }
  };

  const cardBg = adminTheme === 'dark' ? 'bg-slate-800/80 border-slate-700/80' : 'bg-white border-slate-200';
  const textPrimary = adminTheme === 'dark' ? 'text-slate-100' : 'text-slate-800';
  const textSecondary = adminTheme === 'dark' ? 'text-slate-400' : 'text-slate-500';

  return (
    <div id="shift-correction-module" className="space-y-6">
      {/* Header Banner */}
      <div 
        id="shift-correction-header-card"
        className="flex gap-4 p-4 rounded-2xl bg-indigo-50/80 border border-indigo-200 dark:bg-indigo-950/20 dark:border-indigo-800/40 text-indigo-900 dark:text-indigo-300 flex-col md:flex-row text-xs"
      >
        <ShieldAlert size={26} className="shrink-0 text-indigo-600 dark:text-indigo-400" />
        <div className="space-y-1">
          <strong className="text-sm font-black uppercase tracking-tight">Authoritative Historical Shift Correction Deck</strong>
          <p className="opacity-90 leading-relaxed text-[11px]">
            Administrative control center for auditing and correcting past shift records. All edits preserve the authoritative Shift ID, atomically rebuild activity consistency, recalculate productive and break metrics, and generate irreversible compliance audit entries.
          </p>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div id="shift-correction-filter-card" className={`p-4 rounded-2xl border ${cardBg} shadow-sm space-y-4`}>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">Employee Email</label>
            <div className="relative">
              <input
                id="filter-shift-employee-email"
                type="text"
                value={filterEmail}
                onChange={e => setFilterEmail(e.target.value)}
                placeholder="Filter by email (optional)..."
                className={`w-full text-xs pl-8 pr-3 py-2 rounded-xl border ${
                  adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
                }`}
              />
              <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">Start Date</label>
            <div className="relative">
              <input
                id="filter-shift-start-date"
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className={`w-full text-xs pl-8 pr-3 py-2 rounded-xl border ${
                  adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
                }`}
              />
              <Calendar size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">End Date</label>
            <div className="relative">
              <input
                id="filter-shift-end-date"
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className={`w-full text-xs pl-8 pr-3 py-2 rounded-xl border ${
                  adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
                }`}
              />
              <Calendar size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            </div>
          </div>

          <div className="flex items-end gap-2">
            <button
              id="btn-apply-shift-filters"
              onClick={() => fetchShifts(true)}
              disabled={loading}
              className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-sm cursor-pointer disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              {loading ? 'Searching...' : 'Apply Filters'}
            </button>
          </div>
        </div>
      </div>

      {/* Shifts Table */}
      <div id="shift-correction-table-container" className={`rounded-2xl border ${cardBg} overflow-hidden shadow-sm`}>
        <div className="overflow-x-auto">
          <table id="shift-correction-table" className="w-full text-left text-xs border-collapse">
            <thead className={adminTheme === 'dark' ? 'bg-slate-900/90 text-slate-300' : 'bg-slate-50 text-slate-600'}>
              <tr className="border-b border-slate-200 dark:border-slate-700/80 font-bold">
                <th className="p-3">Date (IST)</th>
                <th className="p-3">Employee</th>
                <th className="p-3">Shift ID</th>
                <th className="p-3">Clock In</th>
                <th className="p-3">Clock Out</th>
                <th className="p-3">Status</th>
                <th className="p-3">Breaks</th>
                <th className="p-3">Productive</th>
                <th className="p-3">Total Duration</th>
                <th className="p-3">Process</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={11} className="p-12 text-center font-mono text-slate-400">
                    <RefreshCw size={20} className="animate-spin inline-block mr-2" /> Querying historical shift ledger records...
                  </td>
                </tr>
              ) : !hasSearched ? (
                <tr>
                  <td colSpan={11} className="p-12 text-center text-slate-400">
                    Please select filters and click 'Apply Filters' to search historical shifts.
                  </td>
                </tr>
              ) : shifts.length === 0 ? (
                <tr>
                  <td colSpan={11} className="p-12 text-center text-slate-400">
                    No historical shifts found matching the selected email and date boundaries.
                  </td>
                </tr>
              ) : (
                shifts.map(shift => {
                  const metrics = calculateShiftMetrics(shift);
                  const attDate = calculateAttendanceDate(shift.clockInTime);
                  const inStr = shift.clockInTime ? new Date(shift.clockInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
                  const outStr = shift.clockOutTime ? new Date(shift.clockOutTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Ongoing';

                  return (
                    <tr 
                      key={shift.id} 
                      id={`shift-row-${shift.id}`}
                      className={`border-b border-slate-100 dark:border-slate-800/40 transition-colors ${
                        adminTheme === 'dark' ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50/80'
                      }`}
                    >
                      <td className="p-3 font-mono font-bold text-indigo-500">{attDate}</td>
                      <td className="p-3">
                        <div className="font-bold">{shift.userName || 'Unknown'}</div>
                        <div className="text-[10px] opacity-75 font-mono">{shift.userEmail}</div>
                      </td>
                      <td className="p-3 font-mono text-[11px] text-slate-400 max-w-[120px] truncate" title={shift.id}>
                        {shift.id}
                      </td>
                      <td className="p-3 font-mono">{inStr}</td>
                      <td className="p-3 font-mono">{outStr}</td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                          shift.status === 'COMPLETED' 
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                            : shift.status === 'BREAK'
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
                            : 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400'
                        }`}>
                          {shift.status}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-slate-500">
                        {metrics.totalBreaks} ({metrics.breakStr})
                      </td>
                      <td className="p-3 font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {metrics.productiveStr}
                      </td>
                      <td className="p-3 font-mono text-slate-500">
                        {metrics.elapsedStr}
                      </td>
                      <td className="p-3 font-medium">
                        <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono text-[10px]">
                          {shift.process || 'General'}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            id={`btn-view-shift-${shift.id}`}
                            onClick={() => openShiftDetail(shift)}
                            className="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 cursor-pointer"
                          >
                            Timeline
                          </button>
                          <button
                            id={`btn-edit-shift-${shift.id}`}
                            onClick={() => startEditShift(shift)}
                            className="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1 cursor-pointer"
                          >
                            <Edit3 size={12} /> Correct
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="flex items-center justify-between p-3 border-t border-slate-150/10 dark:border-slate-800 text-xs font-semibold">
          <div className="text-slate-400">
            Page <strong className="text-indigo-500">{pageNumber}</strong> • Showing {shifts.length} records
          </div>
          <div className="flex items-center gap-2">
            <button
              id="btn-prev-page-shifts"
              onClick={handlePrevPage}
              disabled={pageNumber <= 1 || loading}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 cursor-pointer"
            >
              <ChevronLeft size={14} /> Previous
            </button>
            <button
              id="btn-next-page-shifts"
              onClick={handleNextPage}
              disabled={!hasMore || loading}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 cursor-pointer"
            >
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Modal / Drawer for Timeline Inspection */}
      {selectedShift && !isEditing && (
        <div id="modal-view-shift-timeline" className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className={`w-full max-w-3xl rounded-3xl border ${cardBg} shadow-2xl overflow-hidden flex flex-col max-h-[90vh]`}>
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <History size={18} className="text-indigo-500" />
                <h3 className="text-sm font-black uppercase">Shift Activity & Ledger Timeline</h3>
              </div>
              <button onClick={() => setSelectedShift(null)} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6">
              {/* Shift Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                  <span className="text-[10px] uppercase font-bold text-slate-400">Employee</span>
                  <div className="font-bold text-xs mt-0.5">{selectedShift.userName}</div>
                  <div className="text-[10px] text-slate-400 truncate">{selectedShift.userEmail}</div>
                </div>
                <div className="p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                  <span className="text-[10px] uppercase font-bold text-slate-400">Clock In / Out</span>
                  <div className="font-mono text-xs mt-0.5">{toDateTimeLocal(selectedShift.clockInTime)}</div>
                  <div className="font-mono text-[10px] text-slate-400">{selectedShift.clockOutTime ? toDateTimeLocal(selectedShift.clockOutTime) : 'Ongoing'}</div>
                </div>
                <div className="p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                  <span className="text-[10px] uppercase font-bold text-slate-400">Calculated Metrics</span>
                  {(() => {
                    const m = calculateShiftMetrics(selectedShift);
                    return (
                      <div className="space-y-0.5 mt-0.5">
                        <div className="text-xs font-bold text-emerald-500 font-mono">Prod: {m.productiveStr}</div>
                        <div className="text-[10px] text-amber-500 font-mono">Break: {m.breakStr}</div>
                      </div>
                    );
                  })()}
                </div>
                <div className="p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                  <span className="text-[10px] uppercase font-bold text-slate-400">Shift ID</span>
                  <div className="font-mono text-[10px] text-slate-400 break-all mt-1">{selectedShift.id}</div>
                </div>
              </div>

              {/* Activities Timeline */}
              <div>
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
                  <Activity size={14} className="text-indigo-500" /> Recorded Activities ({(selectedShift.activities || []).length})
                </h4>
                <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden divide-y divide-slate-100 dark:divide-slate-800/60">
                  {(selectedShift.activities || []).length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-400">No activity segments recorded in shift.</div>
                  ) : (
                    selectedShift.activities.map((act, idx) => {
                      const isBreak = act.type === 'break' || act.action === 'BREAK_START';
                      return (
                        <div key={idx} className="p-3 flex items-center justify-between text-xs hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                          <div className="flex items-center gap-3">
                            <span className={`w-2 h-2 rounded-full ${isBreak ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                            <div>
                              <div className="font-bold flex items-center gap-2">
                                <span>{act.name || act.process || 'Work'}</span>
                                <span className={`text-[9px] px-1.5 py-0.2 rounded font-mono uppercase ${
                                  isBreak ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
                                }`}>
                                  {act.action || act.type}
                                </span>
                              </div>
                              <div className="text-[10px] text-slate-400 font-mono">
                                Start: {act.startTime ? new Date(act.startTime).toLocaleTimeString() : '-'} {act.endTime ? `| End: ${new Date(act.endTime).toLocaleTimeString()}` : ''}
                              </div>
                            </div>
                          </div>
                          <span className="text-[10px] font-mono text-slate-400">{act.device || 'desktop'}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
              <button
                onClick={() => setSelectedShift(null)}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={() => startEditShift(selectedShift)}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5 cursor-pointer"
              >
                <Edit3 size={14} /> Open Correction Editor
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Shift Modal */}
      {selectedShift && isEditing && (
        <div id="modal-edit-shift-correction" className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className={`w-full max-w-3xl rounded-3xl border ${cardBg} shadow-2xl overflow-hidden flex flex-col max-h-[90vh]`}>
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center bg-indigo-600/10">
              <div className="flex items-center gap-2">
                <Edit3 size={18} className="text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h3 className="text-sm font-black uppercase text-indigo-900 dark:text-indigo-300">Shift Correction Workspace</h3>
                  <p className="text-[10px] text-slate-400 font-mono">Shift ID: {selectedShift.id}</p>
                </div>
              </div>
              <button onClick={() => setIsEditing(false)} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6">
              {/* Top Warning */}
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/40 text-amber-800 dark:text-amber-400 text-xs flex items-center gap-2">
                <AlertTriangle size={16} className="shrink-0" />
                <span>Adjusting timestamps will trigger automated recalculation of productive, break, and connected durations across all ledger records.</span>
              </div>

              {/* Primary Approved Shift Fields */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold mb-1">Clock In Timestamp *</label>
                  <input
                    id="edit-shift-clock-in"
                    type="datetime-local"
                    value={editClockIn}
                    onChange={e => setEditClockIn(e.target.value)}
                    className={`w-full text-xs p-2.5 rounded-xl border ${
                      adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
                    }`}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold mb-1">Clock Out Timestamp</label>
                  <input
                    id="edit-shift-clock-out"
                    type="datetime-local"
                    value={editClockOut}
                    onChange={e => setEditClockOut(e.target.value)}
                    className={`w-full text-xs p-2.5 rounded-xl border ${
                      adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
                    }`}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold mb-1">Shift Status</label>
                  <select
                    id="edit-shift-status"
                    value={editStatus}
                    onChange={e => setEditStatus(e.target.value as any)}
                    className={`w-full text-xs p-2.5 rounded-xl border ${
                      adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
                    }`}
                  >
                    <option value="COMPLETED">COMPLETED (Clocked Out)</option>
                    <option value="ACTIVE">ACTIVE (Productive Shift)</option>
                    <option value="BREAK">BREAK (On Break)</option>
                    <option value="AUTO_CLOSED">AUTO_CLOSED (System Finalized)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold mb-1">Primary Campaign / Process</label>
                  <input
                    id="edit-shift-process"
                    type="text"
                    value={editProcess}
                    onChange={e => setEditProcess(e.target.value)}
                    placeholder="e.g. Chat Support, Verification, Voice..."
                    className={`w-full text-xs p-2.5 rounded-xl border ${
                      adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
                    }`}
                  />
                </div>
              </div>

              {/* Activity Timeline Correction */}
              <div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-2 gap-2">
                  <h4 className="text-xs font-black uppercase tracking-wider text-slate-400">Activity Timeline Segments</h4>
                  {(() => {
                    const previewShift = {
                       clockInTime: editClockIn ? new Date(editClockIn).toISOString() : '',
                       clockOutTime: editClockOut ? new Date(editClockOut).toISOString() : '',
                       status: editStatus,
                       process: editProcess,
                       activities: editActivities.map(a => ({
                          ...a,
                          startTime: a.startTime ? new Date(a.startTime).toISOString() : '',
                          endTime: a.endTime ? new Date(a.endTime).toISOString() : undefined,
                       }))
                    };
                    const pm = calculateShiftMetrics(previewShift);
                    return (
                      <div className="flex gap-3 text-[11px] font-mono bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700">
                        <span className="text-emerald-600 dark:text-emerald-400 font-bold">Preview Prod: {pm.productiveStr}</span>
                        <span className="text-amber-600 dark:text-amber-400 font-bold">Break: {pm.breakStr}</span>
                      </div>
                    );
                  })()}
                  <button
                    id="btn-add-activity-segment"
                    type="button"
                    onClick={handleAddActivity}
                    className="px-2.5 py-1 text-[10px] font-bold rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 flex items-center gap-1 cursor-pointer"
                  >
                    <Plus size={12} /> Add Activity
                  </button>
                </div>

                <div className="space-y-2 max-h-60 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-2xl p-3">
                  {editActivities.map((act, idx) => (
                    <div key={act.activityId || idx} className="grid grid-cols-12 gap-2 items-center p-2 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-100 dark:border-slate-800 text-xs">
                      <div className="col-span-3">
                        <input
                          type="text"
                          value={act.name}
                          onChange={e => handleUpdateActivity(idx, 'name', e.target.value)}
                          placeholder="Activity Name"
                          className="w-full text-[11px] p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                        />
                      </div>
                      <div className="col-span-2">
                        <select
                          value={act.type}
                          onChange={e => handleUpdateActivity(idx, 'type', e.target.value)}
                          className="w-full text-[11px] p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                        >
                          <option value="productive">Productive</option>
                          <option value="break">Break</option>
                          <option value="system">System</option>
                        </select>
                      </div>
                      <div className="col-span-3">
                        <input
                          type="datetime-local"
                          value={act.startTime}
                          onChange={e => handleUpdateActivity(idx, 'startTime', e.target.value)}
                          className="w-full text-[10px] p-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono"
                        />
                      </div>
                      <div className="col-span-3">
                        <input
                          type="datetime-local"
                          value={act.endTime || ''}
                          onChange={e => handleUpdateActivity(idx, 'endTime', e.target.value)}
                          className="w-full text-[10px] p-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono"
                        />
                      </div>
                      <div className="col-span-1 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveActivity(idx)}
                          className="p-1 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded cursor-pointer"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Mandatory Correction Reason */}
              <div>
                <label className="block text-xs font-bold text-rose-600 dark:text-rose-400 mb-1">
                  Mandatory Compliance Audit Reason *
                </label>
                <textarea
                  id="edit-shift-correction-reason"
                  rows={2}
                  value={correctionReason}
                  onChange={e => setCorrectionReason(e.target.value)}
                  placeholder="State the exact business justification for this historical correction (e.g. Employee forgot to clock out, network downtime adjustment, approved overtime reconciliation)..."
                  className={`w-full text-xs p-3 rounded-xl border ${
                    adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
                  }`}
                />
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex justify-between items-center">
              <span className="text-[11px] text-slate-400 font-mono">
                Authoritative record will be updated in Firestore
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  disabled={isSaving}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  id="btn-save-shift-correction"
                  type="button"
                  onClick={handleSaveCorrection}
                  disabled={isSaving}
                  className="px-5 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5 cursor-pointer shadow-sm disabled:opacity-50"
                >
                  <Save size={14} className={isSaving ? 'animate-spin' : ''} />
                  {isSaving ? 'Saving & Auditing...' : 'Commit Shift Correction'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
