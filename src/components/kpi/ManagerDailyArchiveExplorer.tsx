import React, { useState, useEffect, useMemo } from 'react';
import { 
  Calendar, 
  Search, 
  Filter, 
  Download, 
  FileUp, 
  RefreshCw, 
  Eye, 
  Database, 
  Users, 
  Trash2,
  AlertTriangle,
  CheckSquare,
  Square,
  FileSpreadsheet,
  AlertCircle,
  Check,
  ChevronDown
} from 'lucide-react';
import { UserProfile, UserRole } from '../../types';
import { DailyKpiRecord, PartitionMetadata, PartitionEmployee } from '../../types/kpiArchive';
import { 
  fetchManagerDailyKpiRecords, 
  exportDailyKpiToExcel, 
  downloadDailyKpiTemplate,
  generateRecentYearMonths,
  fetchAvailableDailyArchivePartitions,
  fetchAvailableEmployeesForMonth,
  deleteSingleDailyKpiRecord,
  deleteBulkDailyKpiRecords,
  purgeDailyKpiPartition
} from '../../services/kpiArchiveService';
import { formatPeriodForDisplay, formatKpiNumber } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import DailyKpiUploadModal from './DailyKpiUploadModal';
import { toast } from 'sonner';
import { DocumentSnapshot } from 'firebase/firestore';

interface ManagerDailyArchiveExplorerProps {
  user: UserProfile;
  roster: UserProfile[];
}

export default function ManagerDailyArchiveExplorer({ user, roster }: ManagerDailyArchiveExplorerProps) {
  // Partitions dynamically derived from database
  const [availablePartitions, setAvailablePartitions] = useState<PartitionMetadata[]>([]);
  const [loadingPartitions, setLoadingPartitions] = useState(true);

  // Selected Month State
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  // Employees dynamically derived from the selected month partition
  const [availableEmployees, setAvailableEmployees] = useState<PartitionEmployee[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [selectedEmployeeUid, setSelectedEmployeeUid] = useState<string>('ALL');

  // Additional Filters
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedProcess, setSelectedProcess] = useState<string>('ALL');
  const [selectedRole, setSelectedRole] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');

  // Records and Query State
  const [records, setRecords] = useState<DailyKpiRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [lastDocSnapshot, setLastDocSnapshot] = useState<DocumentSnapshot | undefined>(undefined);

  // Selection for Bulk Operations
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set());
  const [isDeletingBulk, setIsDeletingBulk] = useState(false);
  const [bulkDeleteModalOpen, setBulkDeleteModalOpen] = useState(false);

  // Single Deletion Dialog State
  const [recordToDelete, setRecordToDelete] = useState<DailyKpiRecord | null>(null);
  const [isDeletingSingle, setIsDeletingSingle] = useState(false);

  // Purge Partition Dialog State
  const [purgeModalOpen, setPurgeModalOpen] = useState(false);
  const [isPurging, setIsPurging] = useState(false);

  // Modals State
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [inspectRecord, setInspectRecord] = useState<DailyKpiRecord | null>(null);

  const userRoleStr = String(user?.role || '').toUpperCase();
  const isAdminOrMIS = userRoleStr === UserRole.ADMIN || userRoleStr === UserRole.MIS || userRoleStr === 'ADMIN' || userRoleStr === 'MIS';
  const canDelete = isAdminOrMIS || userRoleStr === 'MANAGER' || userRoleStr === 'OPS_HEAD' || userRoleStr === 'TEAM_LEAD';

  // Fallback months if database has no partitions yet
  const fallbackMonths = useMemo(() => generateRecentYearMonths(), []);

  // Debounce search
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  // 1. Load Partitions on mount & derive active month
  const loadPartitions = async (preferredMonth?: string) => {
    setLoadingPartitions(true);
    try {
      const parts = await fetchAvailableDailyArchivePartitions();
      setAvailablePartitions(parts);

      if (preferredMonth) {
        setSelectedMonth(preferredMonth);
      } else if (parts.length > 0) {
        // If current selectedMonth is not in partitions or has 0 records, pick the latest partition with data
        const currentPart = parts.find(p => p.yearMonth === selectedMonth);
        if (!currentPart || currentPart.totalRecords === 0) {
          const latestValid = parts.find(p => p.totalRecords > 0) || parts[0];
          setSelectedMonth(latestValid.yearMonth);
        }
      }
    } catch (err) {
      console.error('Failed to load archive partitions:', err);
    } finally {
      setLoadingPartitions(false);
    }
  };

  useEffect(() => {
    loadPartitions();
  }, []);

  // 2. Load Employees dynamically when selectedMonth changes
  const loadEmployeesForCurrentMonth = async (month: string) => {
    if (!month) return;
    setLoadingEmployees(true);
    try {
      const emps = await fetchAvailableEmployeesForMonth(month);
      setAvailableEmployees(emps);
      // If the currently selected employee is not in this month's employees, reset to ALL
      if (selectedEmployeeUid !== 'ALL') {
        const found = emps.some(e => e.employeeUid === selectedEmployeeUid);
        if (!found) {
          setSelectedEmployeeUid('ALL');
        }
      }
    } catch (err) {
      console.error('Failed to load partition employees:', err);
    } finally {
      setLoadingEmployees(false);
    }
  };

  useEffect(() => {
    loadEmployeesForCurrentMonth(selectedMonth);
    setSelectedRecordIds(new Set());
  }, [selectedMonth]);

  // 3. Load Records on demand
  const handleFetchRecords = async (isReset: boolean = true) => {
    if (!selectedMonth) return;
    setLoading(true);
    try {
      const cursor = isReset ? undefined : lastDocSnapshot;
      const res = await fetchManagerDailyKpiRecords(
        selectedMonth,
        selectedEmployeeUid,
        {
          reportingDate: selectedDate || undefined,
          process: selectedProcess,
          role: selectedRole,
          search: debouncedSearch
        },
        50,
        cursor
      );

      if (isReset) {
        setRecords(res.records);
        setSelectedRecordIds(new Set());
      } else {
        setRecords(prev => [...prev, ...res.records]);
      }
      setLastDocSnapshot(res.lastDoc);
      setHasMore(res.hasMore);
    } catch (err) {
      console.error('Failed to fetch daily KPI records:', err);
      toast.error('Failed to query daily KPI archive.');
    } finally {
      setLoading(false);
    }
  };

  // Trigger query whenever selectedMonth, selectedEmployeeUid, selectedDate, selectedProcess, selectedRole or debouncedSearch changes
  useEffect(() => {
    handleFetchRecords(true);
  }, [selectedMonth, selectedEmployeeUid, selectedDate, selectedProcess, selectedRole, debouncedSearch]);

  // Extract unique process and role filter values from currently loaded records or partition metadata
  const currentPartition = useMemo(() => {
    return availablePartitions.find(p => p.yearMonth === selectedMonth);
  }, [availablePartitions, selectedMonth]);

  const uniqueProcesses = useMemo(() => {
    const set = new Set<string>();
    if (currentPartition?.processes) {
      currentPartition.processes.forEach(p => p && set.add(p));
    }
    records.forEach(r => r.process && set.add(r.process));
    return Array.from(set).sort();
  }, [records, currentPartition]);

  const uniqueRoles = useMemo(() => {
    const set = new Set<string>();
    if (currentPartition?.roles) {
      currentPartition.roles.forEach(r => r && set.add(r));
    }
    records.forEach(r => r.role && set.add(r.role));
    return Array.from(set).sort();
  }, [records, currentPartition]);

  // Summary statistics
  const stats = useMemo(() => {
    if (records.length === 0) return { count: 0, avgScore: 0, totalBonus: 0, totalPenalty: 0 };
    const totalScore = records.reduce((acc, r) => acc + (Number(r.totalScore) || 0), 0);
    const totalBonus = records.reduce((acc, r) => acc + (Number(r.bonus) || 0), 0);
    const totalPenalty = records.reduce((acc, r) => acc + (Number(r.penalty) || 0), 0);
    return {
      count: records.length,
      avgScore: totalScore / records.length,
      totalBonus,
      totalPenalty
    };
  }, [records]);

  // Helper for guaranteed unique record key (handles duplicate IDs across employees/dates)
  const getRecordRowKey = (rec: DailyKpiRecord, index?: number): string => {
    const emp = rec.employeeUid || rec.employeeEmail || 'emp';
    const dt = rec.reportingDate || 'date';
    const proc = rec.process ? rec.process.replace(/[^a-zA-Z0-9_-]/g, '_') : 'proc';
    const id = rec.id || '';
    return index !== undefined ? `${emp}__${dt}__${proc}__${id}__${index}` : `${emp}__${dt}__${proc}__${id}`;
  };

  // Selection Helpers
  const isAllSelected = useMemo(() => {
    if (records.length === 0) return false;
    return records.every(r => selectedRecordIds.has(getRecordRowKey(r)));
  }, [records, selectedRecordIds]);

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedRecordIds(new Set());
    } else {
      const allIds = new Set(records.map(r => getRecordRowKey(r)));
      setSelectedRecordIds(allIds);
    }
  };

  const toggleSelectRecord = (key: string) => {
    setSelectedRecordIds(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Single Record Deletion
  const handleExecuteSingleDelete = async () => {
    if (!recordToDelete) return;
    setIsDeletingSingle(true);
    try {
      const targetKey = getRecordRowKey(recordToDelete);
      await deleteSingleDailyKpiRecord(recordToDelete);
      setRecords(prev => prev.filter(r => getRecordRowKey(r) !== targetKey));
      setSelectedRecordIds(prev => {
        const next = new Set(prev);
        next.delete(targetKey);
        return next;
      });
      // Refresh partition metadata in background
      loadPartitions(selectedMonth);
      loadEmployeesForCurrentMonth(selectedMonth);
      toast.success(`Record for ${recordToDelete.employeeName} (${recordToDelete.reportingDate}) permanently deleted.`);
      setRecordToDelete(null);
    } catch (err: any) {
      console.error('Failed to delete single record:', err);
      toast.error('Failed to delete daily KPI record.');
    } finally {
      setIsDeletingSingle(false);
    }
  };

  // Bulk Record Deletion
  const handleExecuteBulkDelete = async () => {
    if (selectedRecordIds.size === 0) return;
    setIsDeletingBulk(true);
    try {
      const targetRecords = records.filter(r => selectedRecordIds.has(getRecordRowKey(r)));
      const deletedCount = await deleteBulkDailyKpiRecords(targetRecords);
      setRecords(prev => prev.filter(r => !selectedRecordIds.has(getRecordRowKey(r))));
      setSelectedRecordIds(new Set());
      setBulkDeleteModalOpen(false);
      // Refresh partition metadata
      loadPartitions(selectedMonth);
      loadEmployeesForCurrentMonth(selectedMonth);
      toast.success(`Successfully deleted ${deletedCount.toLocaleString()} daily KPI record(s).`);
    } catch (err: any) {
      console.error('Failed to bulk delete records:', err);
      toast.error('Failed to delete selected records.');
    } finally {
      setIsDeletingBulk(false);
    }
  };

  // Purge Partition Deletion
  const handleExecutePurge = async () => {
    if (!selectedMonth) return;
    setIsPurging(true);
    try {
      const deleted = await purgeDailyKpiPartition(selectedMonth);
      setPurgeModalOpen(false);
      toast.success(`Partition ${selectedMonth} purged. Deleted ${deleted.toLocaleString()} records.`);
      await loadPartitions();
      setRecords([]);
      setSelectedRecordIds(new Set());
    } catch (err: any) {
      console.error('Failed to purge partition:', err);
      toast.error('Failed to purge partition.');
    } finally {
      setIsPurging(false);
    }
  };

  const handleExport = () => {
    if (records.length === 0) {
      toast.error('No daily records to export.');
      return;
    }
    exportDailyKpiToExcel(records, `Daily_KPI_Archive_${selectedMonth}.xlsx`);
    toast.success('Exported daily records to Excel.');
  };

  // Available month options derived strictly from uploaded partition metadata
  const monthOptions = useMemo(() => {
    if (availablePartitions.length > 0) {
      return availablePartitions.map(p => ({
        value: p.yearMonth,
        label: `${formatPeriodForDisplay(p.yearMonth)} (${p.yearMonth})`,
        count: p.totalRecords
      }));
    }
    // Fallback if no uploads exist yet
    return fallbackMonths.map(m => ({
      value: m,
      label: `${formatPeriodForDisplay(m)} (${m})`,
      count: 0
    }));
  }, [availablePartitions, fallbackMonths]);

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white rounded-2xl p-6 border border-indigo-900/50 shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Database size={20} className="text-indigo-400" />
            <h3 className="text-lg font-black tracking-tight">
              Day-Wise KPI Archive Explorer
            </h3>
            <span className="px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-mono text-[10px] font-bold border border-indigo-400/30">
              {availablePartitions.length} Partition{availablePartitions.length !== 1 ? 's' : ''} Active
            </span>
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Explore and audit daily performance records, breakdown components, and manage partition data.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button
            onClick={downloadDailyKpiTemplate}
            variant="outline"
            size="sm"
            className="bg-white/10 hover:bg-white/20 text-white border-white/20 text-xs gap-1.5"
          >
            <Download size={14} />
            <span>Sample Template</span>
          </Button>

          <Button
            onClick={handleExport}
            disabled={records.length === 0}
            variant="outline"
            size="sm"
            className="bg-white/10 hover:bg-white/20 text-white border-white/20 text-xs gap-1.5"
          >
            <FileSpreadsheet size={14} />
            <span>Export ({records.length})</span>
          </Button>

          {canDelete && records.length > 0 && (
            <Button
              onClick={() => setPurgeModalOpen(true)}
              variant="outline"
              size="sm"
              className="bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border-rose-500/40 text-xs gap-1.5"
            >
              <Trash2 size={14} />
              <span>Purge Month</span>
            </Button>
          )}

          {isAdminOrMIS && (
            <Button
              onClick={() => setUploadModalOpen(true)}
              size="sm"
              className="bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white text-xs font-bold gap-2 shadow-md px-4 py-2"
            >
              <FileUp size={15} />
              <span>Upload Daily KPI</span>
            </Button>
          )}
        </div>
      </div>

      {/* Filter Panel: Dynamically populated from uploaded data */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
          {/* 1. Archive Month Selector (Derived strictly from uploaded partitions) */}
          <div className="flex flex-col gap-1">
            <label htmlFor="daily-kpi-archive-month-select" className="font-bold text-slate-600 dark:text-slate-400 flex items-center justify-between">
              <span className="flex items-center gap-1">
                <Calendar size={13} className="text-slate-400" />
                <span>Archive Month</span>
              </span>
              {loadingPartitions && <RefreshCw size={10} className="animate-spin text-indigo-500" />}
            </label>
            <select
              id="daily-kpi-archive-month-select"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="h-9 px-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-bold text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              {monthOptions.map(m => (
                <option key={m.value} value={m.value}>
                  {m.label} {m.count > 0 ? `• ${m.count.toLocaleString()} records` : '(0 records)'}
                </option>
              ))}
            </select>
          </div>

          {/* 2. Employee Scope Selector (Derived strictly from uploaded employees in this partition) */}
          <div className="flex flex-col gap-1">
            <label htmlFor="daily-kpi-employee-scope-select" className="font-bold text-slate-600 dark:text-slate-400 flex items-center justify-between">
              <span className="flex items-center gap-1">
                <Users size={13} className="text-slate-400" />
                <span>Employee Scope</span>
              </span>
              {loadingEmployees && <RefreshCw size={10} className="animate-spin text-indigo-500" />}
            </label>
            <select
              id="daily-kpi-employee-scope-select"
              value={selectedEmployeeUid}
              onChange={(e) => setSelectedEmployeeUid(e.target.value)}
              className="h-9 px-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-medium text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              <option value="ALL">
                All Uploaded Employees {currentPartition ? `(${currentPartition.totalRecords.toLocaleString()} records)` : ''}
              </option>
              {availableEmployees.map(emp => (
                <option key={emp.employeeUid} value={emp.employeeUid}>
                  {emp.employeeName} ({emp.employeeEmail}) • {emp.recordCount} record{emp.recordCount !== 1 ? 's' : ''}
                </option>
              ))}
              {/* Fallback to roster if partition has no employees listed yet */}
              {availableEmployees.length === 0 && roster.map(u => (
                <option key={u.uid} value={u.uid}>
                  {u.fullName || u.name || u.email} ({u.role || 'Agent'})
                </option>
              ))}
            </select>
          </div>

          {/* 3. Specific Date Picker */}
          <div className="flex flex-col gap-1">
            <label className="font-bold text-slate-600 dark:text-slate-400">Specific Date (Optional)</label>
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="h-9 text-xs bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800"
            />
          </div>

          {/* 4. Search Query */}
          <div className="flex flex-col gap-1">
            <label className="font-bold text-slate-600 dark:text-slate-400 flex items-center gap-1">
              <Search size={13} className="text-slate-400" />
              <span>Search Query</span>
            </label>
            <Input
              placeholder="Search name, email, process..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 text-xs bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800"
            />
          </div>

          {/* 5. Process & Role Filters or Trigger */}
          <div className="flex items-end gap-2">
            <div className="flex-1 flex flex-col gap-1">
              <label className="font-bold text-slate-600 dark:text-slate-400">Process</label>
              <select
                value={selectedProcess}
                onChange={(e) => setSelectedProcess(e.target.value)}
                className="h-9 px-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
              >
                <option value="ALL">All Processes</option>
                {uniqueProcesses.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            <Button
              onClick={() => handleFetchRecords(true)}
              disabled={loading}
              className="h-9 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl px-3 gap-1.5 shadow-sm shrink-0"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              <span>Filter</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Floating Bulk Action Bar when records are selected */}
      {selectedRecordIds.size > 0 && (
        <div className="sticky top-4 z-20 bg-slate-900 text-white p-3.5 px-5 rounded-2xl shadow-xl border border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-indigo-500 flex items-center justify-center font-bold text-xs">
              {selectedRecordIds.size}
            </div>
            <div>
              <div className="text-xs font-bold">
                {selectedRecordIds.size} record{selectedRecordIds.size !== 1 ? 's' : ''} selected
              </div>
              <div className="text-[11px] text-slate-400">
                Partition: {selectedMonth}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => setSelectedRecordIds(new Set())}
              variant="outline"
              size="sm"
              className="bg-white/10 hover:bg-white/20 text-white border-white/20 text-xs h-8"
            >
              Deselect All
            </Button>

            <Button
              onClick={() => setBulkDeleteModalOpen(true)}
              size="sm"
              className="bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold gap-1.5 h-8 px-4 rounded-xl shadow-md"
            >
              <Trash2 size={13} />
              <span>Permanently Delete Selected ({selectedRecordIds.size})</span>
            </Button>
          </div>
        </div>
      )}

      {/* Summary KPI Cards */}
      {records.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 rounded-2xl shadow-sm">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Records Queried</span>
            <div className="text-2xl font-black font-mono text-slate-900 dark:text-white mt-1">
              {stats.count.toLocaleString()}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 rounded-2xl shadow-sm">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Avg Daily Score</span>
            <div className="text-2xl font-black font-mono text-indigo-600 dark:text-indigo-400 mt-1">
              {formatKpiNumber(stats.avgScore)}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 rounded-2xl shadow-sm">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Total Incentives / Bonus</span>
            <div className="text-2xl font-black font-mono text-emerald-600 dark:text-emerald-400 mt-1">
              +{formatKpiNumber(stats.totalBonus, '0.00')}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 rounded-2xl shadow-sm">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Total Penalties</span>
            <div className="text-2xl font-black font-mono text-rose-600 dark:text-rose-400 mt-1">
              -{formatKpiNumber(stats.totalPenalty, '0.00')}
            </div>
          </div>
        </div>
      )}

      {/* Main Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        {loading && records.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 gap-3 text-slate-500">
            <RefreshCw size={28} className="animate-spin text-indigo-600" />
            <p className="text-xs font-semibold">Querying partition /kpiArchive/{selectedMonth}...</p>
          </div>
        ) : records.length === 0 ? (
          <div className="p-16 text-center">
            <Database size={36} className="mx-auto text-slate-300 mb-2" />
            <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">No Day-Wise KPI Records Found</h4>
            <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
              No daily performance records exist in the <span className="font-mono font-bold">{selectedMonth}</span> partition for the current filter.
            </p>
            {isAdminOrMIS && (
              <div className="mt-4">
                <Button
                  onClick={() => setUploadModalOpen(true)}
                  size="sm"
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold gap-1.5 rounded-xl"
                >
                  <FileUp size={14} />
                  <span>Upload Records to this Partition</span>
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-slate-50 dark:bg-slate-950">
                <TableRow className="text-[11px]">
                  {canDelete && (
                    <TableHead className="w-10 text-center">
                      <button
                        onClick={toggleSelectAll}
                        className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors"
                        title={isAllSelected ? 'Deselect all' : 'Select all'}
                      >
                        {isAllSelected ? (
                          <CheckSquare size={16} className="text-indigo-600" />
                        ) : (
                          <Square size={16} />
                        )}
                      </button>
                    </TableHead>
                  )}
                  <TableHead className="font-bold">Date</TableHead>
                  <TableHead className="font-bold">Employee</TableHead>
                  <TableHead className="font-bold">Process & Role</TableHead>
                  <TableHead className="font-bold">Total Score</TableHead>
                  <TableHead className="font-bold">Productivity</TableHead>
                  <TableHead className="font-bold">Quality</TableHead>
                  <TableHead className="font-bold">Attendance</TableHead>
                  <TableHead className="font-bold">APT</TableHead>
                  <TableHead className="font-bold">Bonus / Penalty</TableHead>
                  <TableHead className="text-right font-bold">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((rec, idx) => {
                  const rowKey = getRecordRowKey(rec, idx);
                  const isSelected = selectedRecordIds.has(getRecordRowKey(rec));
                  return (
                    <TableRow 
                      key={rowKey} 
                      className={`text-xs hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${
                        isSelected ? 'bg-indigo-50/60 dark:bg-indigo-950/30' : ''
                      }`}
                    >
                      {canDelete && (
                        <TableCell className="text-center">
                          <button
                            onClick={() => toggleSelectRecord(getRecordRowKey(rec))}
                            className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors"
                          >
                            {isSelected ? (
                              <CheckSquare size={16} className="text-indigo-600" />
                            ) : (
                              <Square size={16} />
                            )}
                          </button>
                        </TableCell>
                      )}
                      <TableCell className="font-mono font-bold text-slate-900 dark:text-white">
                        {rec.reportingDate}
                      </TableCell>
                      <TableCell>
                        <div className="font-bold text-slate-900 dark:text-white">{rec.employeeName}</div>
                        <div className="text-[11px] text-slate-500 font-mono">{rec.employeeEmail}</div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{rec.process}</div>
                        <div className="text-[10px] text-slate-500 uppercase font-bold">{rec.role}</div>
                      </TableCell>
                      <TableCell>
                        <div className="font-mono font-extrabold text-indigo-600 dark:text-indigo-400 text-sm">
                          {formatKpiNumber(rec.totalScore)}
                        </div>
                        {rec.kpiRating && (
                          <span className="text-[10px] font-bold text-slate-400">{rec.kpiRating}</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <div className="font-bold text-slate-700 dark:text-slate-300">{formatKpiNumber(rec.productivityScore)}</div>
                        {(rec.targetProductivity || rec.actualProductivity) && (
                          <div className="text-[10px] text-slate-400">T:{formatKpiNumber(rec.targetProductivity)} | A:{formatKpiNumber(rec.actualProductivity)}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <div className="font-bold text-slate-700 dark:text-slate-300">{formatKpiNumber(rec.qualityScore)}</div>
                        {(rec.targetQuality || rec.actualQuality) && (
                          <div className="text-[10px] text-slate-400">T:{formatKpiNumber(rec.targetQuality)} | A:{formatKpiNumber(rec.actualQuality)}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <div className="font-bold text-slate-700 dark:text-slate-300">{formatKpiNumber(rec.attendanceScore)}</div>
                        {(rec.targetAttendance || rec.actualAttendance) && (
                          <div className="text-[10px] text-slate-400">T:{formatKpiNumber(rec.targetAttendance)} | A:{formatKpiNumber(rec.actualAttendance)}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <div className="font-bold text-slate-700 dark:text-slate-300">{formatKpiNumber(rec.aptScore)}</div>
                        {(rec.targetAPT || rec.actualAPT) && (
                          <div className="text-[10px] text-slate-400">T:{formatKpiNumber(rec.targetAPT)} | A:{formatKpiNumber(rec.actualAPT)}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">
                        <span className="text-emerald-600 font-bold">+{formatKpiNumber(rec.bonus, '0.00')}</span>
                        {' / '}
                        <span className="text-rose-600 font-bold">-{formatKpiNumber(rec.penalty, '0.00')}</span>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            onClick={() => setInspectRecord(rec)}
                            variant="ghost"
                            size="sm"
                            title="Inspect Details"
                            className="h-8 w-8 p-0 text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/50"
                          >
                            <Eye size={14} />
                          </Button>

                          {canDelete && (
                            <Button
                              onClick={() => setRecordToDelete(rec)}
                              variant="ghost"
                              size="sm"
                              title="Permanently Delete Record"
                              className="h-8 w-8 p-0 text-rose-500 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/50"
                            >
                              <Trash2 size={14} />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Load More Pagination */}
        {hasMore && (
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex justify-center">
            <Button
              onClick={() => handleFetchRecords(false)}
              disabled={loading}
              variant="outline"
              size="sm"
              className="text-xs font-bold gap-2 px-6 rounded-xl"
            >
              {loading ? <RefreshCw size={13} className="animate-spin" /> : null}
              <span>Load Next Page (Cursor)</span>
            </Button>
          </div>
        )}
      </div>

      {/* Inspect Record Modal */}
      {inspectRecord && (
        <Dialog open={!!inspectRecord} onOpenChange={(o) => !o && setInspectRecord(null)}>
          <DialogContent className="max-w-2xl bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-6 rounded-3xl">
            <DialogHeader className="border-b border-slate-100 dark:border-slate-800 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <DialogTitle className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <span>{inspectRecord.employeeName}</span>
                    <span className="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 text-xs font-mono font-bold">
                      {inspectRecord.reportingDate}
                    </span>
                  </DialogTitle>
                  <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {inspectRecord.employeeEmail} • Process: {inspectRecord.process} • Role: {inspectRecord.role}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="py-4 flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 dark:bg-slate-950 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 text-center">
                  <span className="text-[10px] font-bold text-slate-500 uppercase">Daily KPI Score</span>
                  <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400 font-mono mt-1">
                    {formatKpiNumber(inspectRecord.totalScore)}
                  </div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-950 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 text-center">
                  <span className="text-[10px] font-bold text-slate-500 uppercase">Bonus / Penalty</span>
                  <div className="text-sm font-mono font-bold mt-2">
                    <span className="text-emerald-600">+{formatKpiNumber(inspectRecord.bonus, '0.00')}</span>
                    {' / '}
                    <span className="text-rose-600">-{formatKpiNumber(inspectRecord.penalty, '0.00')}</span>
                  </div>
                </div>
              </div>

              {/* Metric Breakdown */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">Productivity</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(inspectRecord.productivityScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectRecord.targetProductivity)} | Actual: {formatKpiNumber(inspectRecord.actualProductivity)}</div>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">Quality</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(inspectRecord.qualityScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectRecord.targetQuality)} | Actual: {formatKpiNumber(inspectRecord.actualQuality)}</div>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">Attendance</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(inspectRecord.attendanceScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectRecord.targetAttendance)} | Actual: {formatKpiNumber(inspectRecord.actualAttendance)}</div>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">APT</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(inspectRecord.aptScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectRecord.targetAPT)} | Actual: {formatKpiNumber(inspectRecord.actualAPT)}</div>
                </div>
              </div>

              {inspectRecord.comments && (
                <div className="p-3.5 bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl text-xs">
                  <span className="font-bold text-indigo-700 dark:text-indigo-400">Supervisor Remarks:</span>
                  <p className="text-slate-600 dark:text-slate-300 mt-0.5 leading-relaxed">{inspectRecord.comments}</p>
                </div>
              )}

              <div className="text-[11px] text-slate-400 flex justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
                <span>Uploaded By: {inspectRecord.uploadedBy || 'System'}</span>
                <span>Partition: /kpiArchive/{inspectRecord.yearMonth}</span>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Single Delete Confirmation Dialog */}
      {recordToDelete && (
        <Dialog open={!!recordToDelete} onOpenChange={(o) => !o && setRecordToDelete(null)}>
          <DialogContent className="max-w-md bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-6 rounded-3xl">
            <DialogHeader>
              <div className="w-12 h-12 rounded-2xl bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center mb-2">
                <Trash2 size={24} />
              </div>
              <DialogTitle className="text-lg font-bold text-slate-900 dark:text-white">
                Permanently Delete Record?
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Are you sure you want to delete this daily KPI entry? This operation is permanent and cannot be undone.
              </DialogDescription>
            </DialogHeader>

            <div className="my-3 p-3 bg-slate-50 dark:bg-slate-950 rounded-2xl border border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div><strong className="text-slate-700 dark:text-slate-300">Employee:</strong> {recordToDelete.employeeName} ({recordToDelete.employeeEmail})</div>
              <div><strong className="text-slate-700 dark:text-slate-300">Date:</strong> {recordToDelete.reportingDate}</div>
              <div><strong className="text-slate-700 dark:text-slate-300">Process:</strong> {recordToDelete.process}</div>
              <div><strong className="text-slate-700 dark:text-slate-300">Score:</strong> {formatKpiNumber(recordToDelete.totalScore)}</div>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                onClick={() => setRecordToDelete(null)}
                variant="ghost"
                size="sm"
                disabled={isDeletingSingle}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                onClick={handleExecuteSingleDelete}
                disabled={isDeletingSingle}
                size="sm"
                className="bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold px-4 rounded-xl shadow-md gap-1.5"
              >
                {isDeletingSingle ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}
                <span>Delete Permanently</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Bulk Delete Confirmation Dialog */}
      {bulkDeleteModalOpen && (
        <Dialog open={bulkDeleteModalOpen} onOpenChange={(o) => !o && setBulkDeleteModalOpen(false)}>
          <DialogContent className="max-w-md bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-6 rounded-3xl">
            <DialogHeader>
              <div className="w-12 h-12 rounded-2xl bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center mb-2">
                <AlertTriangle size={24} />
              </div>
              <DialogTitle className="text-lg font-bold text-slate-900 dark:text-white">
                Delete {selectedRecordIds.size} Selected Record{selectedRecordIds.size !== 1 ? 's' : ''}?
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                You are about to permanently delete <strong className="text-slate-900 dark:text-white">{selectedRecordIds.size} daily KPI record(s)</strong> from partition <span className="font-mono font-bold text-indigo-600">{selectedMonth}</span>. This action is irreversible.
              </DialogDescription>
            </DialogHeader>

            <DialogFooter className="gap-2 sm:gap-0 mt-4">
              <Button
                onClick={() => setBulkDeleteModalOpen(false)}
                variant="ghost"
                size="sm"
                disabled={isDeletingBulk}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                onClick={handleExecuteBulkDelete}
                disabled={isDeletingBulk}
                size="sm"
                className="bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold px-5 rounded-xl shadow-md gap-1.5"
              >
                {isDeletingBulk ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}
                <span>Confirm Bulk Delete</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Purge Entire Partition Confirmation Dialog */}
      {purgeModalOpen && (
        <Dialog open={purgeModalOpen} onOpenChange={(o) => !o && setPurgeModalOpen(false)}>
          <DialogContent className="max-w-md bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-6 rounded-3xl">
            <DialogHeader>
              <div className="w-12 h-12 rounded-2xl bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center mb-2">
                <Trash2 size={24} />
              </div>
              <DialogTitle className="text-lg font-bold text-slate-900 dark:text-white">
                Purge Entire Month Partition ({selectedMonth})?
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                This will delete <strong className="text-rose-600">ALL records</strong> within the <span className="font-mono font-bold text-slate-900 dark:text-white">{selectedMonth}</span> daily archive partition and reset its metadata index.
              </DialogDescription>
            </DialogHeader>

            <div className="my-2 p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 rounded-xl text-xs text-rose-800 dark:text-rose-300">
              Warning: This is an administrative purge action. Ensure you have exported a backup if needed.
            </div>

            <DialogFooter className="gap-2 sm:gap-0 mt-3">
              <Button
                onClick={() => setPurgeModalOpen(false)}
                variant="ghost"
                size="sm"
                disabled={isPurging}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                onClick={handleExecutePurge}
                disabled={isPurging}
                size="sm"
                className="bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold px-5 rounded-xl shadow-md gap-1.5"
              >
                {isPurging ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}
                <span>Purge Partition</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Upload Modal */}
      {isAdminOrMIS && (
        <DailyKpiUploadModal
          open={uploadModalOpen}
          onClose={() => setUploadModalOpen(false)}
          onImportSuccess={(uploadedMonth?: string) => {
            loadPartitions(uploadedMonth || selectedMonth);
            handleFetchRecords(true);
          }}
          user={user}
          roster={roster}
        />
      )}
    </div>
  );
}
