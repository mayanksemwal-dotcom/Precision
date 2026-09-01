import React, { useState, useEffect, useMemo } from 'react';
import { 
  FileUp, 
  Download, 
  Search, 
  Filter, 
  Trash2, 
  Eye, 
  RefreshCw, 
  FileText,
  ChevronDown,
  ArrowUpDown,
  Calendar,
  Users,
  Award,
  Trophy,
  CheckSquare,
  Square,
  SlidersHorizontal,
  X,
  AlertTriangle
} from 'lucide-react';
import { KPIScorecard, UserProfile, UserRole } from '../../types';
import { formatPeriodForDisplay, formatKpiNumber } from '../../lib/utils';
import { 
  fetchAllKpiScorecards, 
  fetchKpiMetadata,
  deleteKpiScorecard, 
  deleteKpiScorecardsBulk,
  deleteAllKpiScorecards,
  downloadKpiTemplate, 
  exportKpiToExcel,
  canExportKpi
} from '../../services/kpiService';
import { invalidateCacheKey } from '../../lib/firebase';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import KpiUploadModal from './KpiUploadModal';
import KpiExportModal from './KpiExportModal';
import { toast } from 'sonner';

interface KpiScorecardTableModuleProps {
  user: UserProfile;
  roster: UserProfile[];
}

export default function KpiScorecardTableModule({ user, roster }: KpiScorecardTableModuleProps) {
  const [scorecards, setScorecards] = useState<KPIScorecard[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [inspectModalRecord, setInspectModalRecord] = useState<KPIScorecard | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfig, setDeleteConfig] = useState<{ mode: 'single' | 'bulk' | 'all'; id?: string; name?: string }>({ mode: 'bulk' });

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('ALL');
  const [selectedProcess, setSelectedProcess] = useState<string>('ALL');
  const [selectedRole, setSelectedRole] = useState<string>('ALL');
  const [metaOptions, setMetaOptions] = useState<{ periods: string[]; processes: string[]; roles: string[] }>({ periods: [], processes: [], roles: [] });

  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [processRankMin, setProcessRankMin] = useState('');
  const [processRankMax, setProcessRankMax] = useState('');
  const [roleRankMin, setRoleRankMin] = useState('');
  const [roleRankMax, setRoleRankMax] = useState('');
  const [orgRankMin, setOrgRankMin] = useState('');
  const [orgRankMax, setOrgRankMax] = useState('');
  const [totalScoreMin, setTotalScoreMin] = useState('');
  const [totalScoreMax, setTotalScoreMax] = useState('');

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);
  const [sortField, setSortField] = useState<'processRank' | 'roleRank' | 'organizationRank' | 'totalScore' | 'employeeName' | 'reportingPeriod'>('totalScore');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const userCanExport = canExportKpi(user.role);
  const userRoleStr = String(user?.role || '').toUpperCase();
  const isAdminOrMIS = userRoleStr === UserRole.ADMIN || userRoleStr === UserRole.MIS || userRoleStr === 'ADMIN' || userRoleStr === 'MIS';

  // Debounce search
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  // Fetch metadata on mount
  useEffect(() => {
    if (!isAdminOrMIS) return;
    fetchKpiMetadata().then(meta => {
      if (meta && meta.reportingPeriods?.length > 0) {
        setMetaOptions({
          periods: meta.reportingPeriods,
          processes: meta.processes || [],
          roles: meta.roles || []
        });
        if (meta.reportingPeriods.length > 0) {
          setSelectedPeriod(meta.reportingPeriods[0]);
        }
      }
    }).catch(err => {
      console.warn('Error fetching KPI metadata:', err);
    });
  }, [isAdminOrMIS]);

  // Load Scorecards
  const loadData = async (forceServer: boolean = false, targetPeriod?: string) => {
    if (!isAdminOrMIS) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const periodToFetch = targetPeriod !== undefined ? targetPeriod : selectedPeriod;
      const records = await fetchAllKpiScorecards(periodToFetch, forceServer, userRoleStr);
      setScorecards(records);
    } catch (err) {
      console.error('Error fetching KPI scorecards:', err);
      toast.error('Failed to load KPI scorecards.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isAdminOrMIS) return;
    loadData(false, selectedPeriod);
  }, [selectedPeriod, isAdminOrMIS]);

  // Filtered & Sorted records
  const filteredRecords = useMemo(() => {
    return scorecards.filter(rec => {
      const q = debouncedSearch.toLowerCase().trim();
      const matchSearch = !q || 
        rec.employeeEmail.toLowerCase().includes(q) ||
        rec.employeeName.toLowerCase().includes(q) ||
        rec.process.toLowerCase().includes(q);

      const matchPeriod = selectedPeriod === 'ALL' || rec.reportingPeriod === selectedPeriod;
      const matchProcess = selectedProcess === 'ALL' || rec.process === selectedProcess;
      const matchRole = selectedRole === 'ALL' || rec.role === selectedRole;

      const procRank = Number(rec.processRank);
      if (processRankMin && (!procRank || procRank < Number(processRankMin))) return false;
      if (processRankMax && (!procRank || procRank > Number(processRankMax))) return false;

      const rRank = Number(rec.roleRank);
      if (roleRankMin && (!rRank || rRank < Number(roleRankMin))) return false;
      if (roleRankMax && (!rRank || rRank > Number(roleRankMax))) return false;

      const oRank = Number(rec.organizationRank ?? rec.rank);
      if (orgRankMin && (!oRank || oRank < Number(orgRankMin))) return false;
      if (orgRankMax && (!oRank || oRank > Number(orgRankMax))) return false;

      const score = Number(rec.totalScore);
      if (totalScoreMin && (isNaN(score) || score < Number(totalScoreMin))) return false;
      if (totalScoreMax && (isNaN(score) || score > Number(totalScoreMax))) return false;

      return matchSearch && matchPeriod && matchProcess && matchRole;
    }).sort((a, b) => {
      let valA: any = a[sortField];
      let valB: any = b[sortField];
      if (sortField === 'organizationRank') {
        valA = Number(a.organizationRank ?? a.rank) || 999999;
        valB = Number(b.organizationRank ?? b.rank) || 999999;
      } else if (sortField === 'processRank' || sortField === 'roleRank' || sortField === 'totalScore') {
        valA = Number(valA) || (sortField.includes('Rank') ? 999999 : 0);
        valB = Number(valB) || (sortField.includes('Rank') ? 999999 : 0);
      } else {
        valA = String(valA || '').toLowerCase();
        valB = String(valB || '').toLowerCase();
      }
      if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [
    scorecards, debouncedSearch, selectedPeriod, selectedProcess, selectedRole,
    processRankMin, processRankMax, roleRankMin, roleRankMax, orgRankMin, orgRankMax,
    totalScoreMin, totalScoreMax, sortField, sortDirection
  ]);

  const handleDeleteRecord = (docId: string, employeeName: string) => {
    setDeleteConfig({ mode: 'single', id: docId, name: employeeName });
    setDeleteConfirmOpen(true);
  };

  const handleBulkDelete = () => {
    const toDelete = selectedDocIds.filter(id => scorecards.some(s => s.id === id));
    if (toDelete.length === 0) return;
    setDeleteConfig({ mode: 'bulk' });
    setDeleteConfirmOpen(true);
  };

  const handleDeleteAllRecords = () => {
    setDeleteConfig({ mode: 'all' });
    setDeleteConfirmOpen(true);
  };

  const executeDelete = async () => {
    setDeleteConfirmOpen(false);
    if (deleteConfig.mode === 'single' && deleteConfig.id) {
      const targetId = deleteConfig.id;
      // Optimistically remove from state instantly
      setScorecards(prev => prev.filter(s => s.id !== targetId));
      setSelectedDocIds(prev => prev.filter(id => id !== targetId));

      try {
        await deleteKpiScorecard(targetId);
        invalidateCacheKey('kpi_all_scorecards_unlimited');
        toast.success('KPI scorecard deleted permanently.');
        await loadData(true);
      } catch (err) {
        toast.error('Failed to delete scorecard.');
        await loadData(true);
      }
    } else if (deleteConfig.mode === 'bulk') {
      const toDelete = [...selectedDocIds];
      if (toDelete.length === 0) return;

      // Optimistically remove from state instantly
      setScorecards(prev => prev.filter(s => !toDelete.includes(s.id)));
      setSelectedDocIds([]);

      try {
        await deleteKpiScorecardsBulk(toDelete);
        invalidateCacheKey('kpi_all_scorecards_unlimited');
        toast.success(`Successfully deleted ${toDelete.length} KPI scorecard(s).`);
        await loadData(true);
      } catch (err) {
        toast.error('Failed to perform bulk delete.');
        await loadData(true);
      }
    } else if (deleteConfig.mode === 'all') {
      // Optimistically clear all
      setScorecards([]);
      setSelectedDocIds([]);

      try {
        await deleteAllKpiScorecards();
        invalidateCacheKey('kpi_all_scorecards_unlimited');
        toast.success('All KPI scorecards permanently deleted.');
        await loadData(true);
      } catch (err) {
        toast.error('Failed to delete all records.');
        await loadData(true);
      }
    }
  };

  const handleSortToggle = (field: typeof sortField) => {
    setSortDirection(prev => (sortField === field && prev === 'desc' ? 'asc' : 'desc'));
    setSortField(field);
  };

  const handleSelectRow = (id: string) => {
    setSelectedDocIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const totalRecords = filteredRecords.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalRecords);
  const currentPageRecords = filteredRecords.slice(startIndex, endIndex);
  const allCurrentSelected = currentPageRecords.length > 0 && currentPageRecords.every(rec => selectedDocIds.includes(rec.id));

  const handleSelectAllCurrentPage = () => {
    if (allCurrentSelected) {
      const pageIds = new Set(currentPageRecords.map(r => r.id));
      setSelectedDocIds(prev => prev.filter(id => !pageIds.has(id)));
    } else {
      const pageIds = currentPageRecords.map(r => r.id);
      setSelectedDocIds(prev => Array.from(new Set([...prev, ...pageIds])));
    }
  };

  // Distinct dropdown choices
  const uniquePeriods = useMemo(() => {
    const set = new Set<string>(metaOptions.periods);
    scorecards.forEach(s => s.reportingPeriod && set.add(s.reportingPeriod));
    return Array.from(set).sort();
  }, [scorecards, metaOptions.periods]);

  const uniqueProcesses = useMemo(() => {
    const set = new Set<string>(metaOptions.processes);
    scorecards.forEach(s => s.process && set.add(s.process));
    return Array.from(set).sort();
  }, [scorecards, metaOptions.processes]);

  const uniqueRoles = useMemo(() => {
    const set = new Set<string>(metaOptions.roles);
    scorecards.forEach(s => s.role && set.add(s.role));
    return Array.from(set).sort();
  }, [scorecards, metaOptions.roles]);

  const tableHeaders = useMemo(() => {
    // Look at first item in current filtered results to see if there are custom KPI names
    const sampleRecord = filteredRecords.find(r => r.kpiNameProductivity || r.kpiNameQuality || r.kpiNameAttendance || r.kpiNameAPT);
    return {
      productivity: sampleRecord?.kpiNameProductivity || 'Productivity',
      quality: sampleRecord?.kpiNameQuality || 'Quality',
      attendance: sampleRecord?.kpiNameAttendance || 'Attendance',
      apt: sampleRecord?.kpiNameAPT || 'APT'
    };
  }, [filteredRecords]);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm flex flex-col gap-0">
      {/* Top Action Bar */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap gap-4 items-center justify-between bg-slate-50/50 dark:bg-slate-950/50">
        <div className="flex flex-wrap items-center gap-3 flex-grow max-w-2xl">
          {/* Search Input */}
          <div className="relative flex-grow min-w-[200px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search employee, email, process..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs rounded-xl bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800"
            />
          </div>

          {/* Period Filter */}
          <div className="flex items-center gap-1.5 bg-white dark:bg-slate-900 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 text-xs">
            <Calendar size={13} className="text-slate-400" />
            <span className="font-bold text-slate-500">Period:</span>
            <select
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value)}
              className="bg-transparent font-bold text-slate-800 dark:text-slate-200 focus:outline-none"
            >
              <option value="ALL">All Periods</option>
              {uniquePeriods.map(p => (
                <option key={p} value={p}>{formatPeriodForDisplay(p)}</option>
              ))}
            </select>
          </div>

          {/* Advanced Filter Toggle */}
          <Button
            onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
            variant="outline"
            size="sm"
            className={`h-9 text-xs gap-1.5 rounded-xl ${showAdvancedFilters ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : ''}`}
          >
            <SlidersHorizontal size={13} />
            <span>Filters</span>
          </Button>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {isAdminOrMIS && (
            <Button
              onClick={() => setUploadModalOpen(true)}
              size="sm"
              className="h-9 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold gap-1.5 rounded-xl shadow-xs cursor-pointer"
            >
              <FileUp size={15} />
              <span>Upload Monthly KPI</span>
            </Button>
          )}

          {userCanExport && (
            <Button
              onClick={() => setExportModalOpen(true)}
              variant="outline"
              size="sm"
              className="h-9 text-xs gap-1.5 rounded-xl border-slate-200 dark:border-slate-800"
            >
              <Download size={14} />
              <span>Export</span>
            </Button>
          )}

          <Button
            onClick={() => loadData(true)}
            disabled={loading}
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-slate-500 hover:text-slate-800 rounded-xl"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* Advanced Filters Panel */}
      {showAdvancedFilters && (
        <div className="p-4 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="font-bold text-slate-600 dark:text-slate-400 block mb-1">Process Filter</label>
            <select
              value={selectedProcess}
              onChange={(e) => setSelectedProcess(e.target.value)}
              className="w-full h-8 px-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
            >
              <option value="ALL">All Processes</option>
              {uniqueProcesses.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="font-bold text-slate-600 dark:text-slate-400 block mb-1">Role Filter</label>
            <select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
              className="w-full h-8 px-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
            >
              <option value="ALL">All Roles</option>
              {uniqueRoles.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="font-bold text-slate-600 dark:text-slate-400 block mb-1">Score Range (Min - Max)</label>
            <div className="flex gap-2">
              <Input
                placeholder="Min"
                value={totalScoreMin}
                onChange={(e) => setTotalScoreMin(e.target.value)}
                className="h-8 text-xs bg-white dark:bg-slate-900"
              />
              <Input
                placeholder="Max"
                value={totalScoreMax}
                onChange={(e) => setTotalScoreMax(e.target.value)}
                className="h-8 text-xs bg-white dark:bg-slate-900"
              />
            </div>
          </div>

          <div className="flex items-end">
            <Button
              onClick={() => {
                setSelectedProcess('ALL');
                setSelectedRole('ALL');
                setTotalScoreMin('');
                setTotalScoreMax('');
                setProcessRankMin('');
                setProcessRankMax('');
                setRoleRankMin('');
                setRoleRankMax('');
                setOrgRankMin('');
                setOrgRankMax('');
              }}
              variant="ghost"
              size="sm"
              className="text-xs text-rose-600 hover:text-rose-700 h-8"
            >
              Reset Filters
            </Button>
          </div>
        </div>
      )}

      {/* Selected Items Actions Toolbar */}
      {selectedDocIds.length > 0 && !loading && (
        <div className="bg-indigo-50/90 dark:bg-indigo-950/40 p-3 px-4 flex flex-wrap justify-between items-center border-b border-indigo-100 dark:border-indigo-900 text-xs">
          <div className="flex items-center gap-2">
            <CheckSquare size={16} className="text-indigo-600 dark:text-indigo-400" />
            <span className="font-bold text-indigo-950 dark:text-indigo-200">
              {selectedDocIds.length} item(s) selected
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={handleBulkDelete}
              variant="destructive"
              size="sm"
              className="h-7 text-xs font-bold gap-1 rounded-lg"
            >
              <Trash2 size={13} />
              <span>Delete Selected</span>
            </Button>

            <Button
              onClick={handleDeleteAllRecords}
              variant="outline"
              size="sm"
              className="h-7 text-xs font-bold text-rose-600 border-rose-200 hover:bg-rose-50 rounded-lg"
            >
              <span>Permanent Delete All</span>
            </Button>
          </div>
        </div>
      )}

      {/* Table Content */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-500">
          <RefreshCw className="animate-spin text-indigo-600" size={28} />
          <p className="text-xs font-semibold">Loading monthly scorecards...</p>
        </div>
      ) : filteredRecords.length === 0 ? (
        <div className="text-center py-20 p-6">
          <Award className="text-slate-300 mx-auto mb-2" size={40} />
          <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">No KPI Scorecards Found</h4>
          <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
            No published scorecards match your current filter criteria.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[65vh]">
          <Table>
            <TableHeader className="bg-slate-50 dark:bg-slate-950 sticky top-0 z-10">
              <TableRow className="text-[11px]">
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={allCurrentSelected}
                    onChange={handleSelectAllCurrentPage}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                  />
                </TableHead>
                <TableHead className="cursor-pointer font-bold" onClick={() => handleSortToggle('reportingPeriod')}>
                  <div className="flex items-center gap-1">
                    <span>Period</span>
                    <ArrowUpDown size={12} className="text-slate-400" />
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer font-bold" onClick={() => handleSortToggle('employeeName')}>
                  <div className="flex items-center gap-1">
                    <span>Employee</span>
                    <ArrowUpDown size={12} className="text-slate-400" />
                  </div>
                </TableHead>
                <TableHead className="font-bold">Process & Role</TableHead>
                <TableHead className="cursor-pointer font-bold" onClick={() => handleSortToggle('totalScore')}>
                  <div className="flex items-center gap-1">
                    <span>Score</span>
                    <ArrowUpDown size={12} className="text-slate-400" />
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer font-bold" onClick={() => handleSortToggle('processRank')}>
                  <div className="flex items-center gap-1">
                    <span>Proc Rank</span>
                    <ArrowUpDown size={12} className="text-slate-400" />
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer font-bold" onClick={() => handleSortToggle('roleRank')}>
                  <div className="flex items-center gap-1">
                    <span>Role Rank</span>
                    <ArrowUpDown size={12} className="text-slate-400" />
                  </div>
                </TableHead>
                <TableHead className="cursor-pointer font-bold" onClick={() => handleSortToggle('organizationRank')}>
                  <div className="flex items-center gap-1">
                    <span>Org Rank</span>
                    <ArrowUpDown size={12} className="text-slate-400" />
                  </div>
                </TableHead>
                <TableHead className="font-bold">{tableHeaders.productivity}</TableHead>
                <TableHead className="font-bold">{tableHeaders.quality}</TableHead>
                <TableHead className="font-bold">{tableHeaders.attendance}</TableHead>
                <TableHead className="font-bold">{tableHeaders.apt}</TableHead>
                <TableHead className="font-bold">Bonus / Penalty</TableHead>
                <TableHead className="text-right font-bold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {currentPageRecords.map((rec) => (
                <TableRow
                  key={rec.id}
                  className={`text-xs transition-colors ${
                    selectedDocIds.includes(rec.id) ? 'bg-indigo-50/40 dark:bg-indigo-950/20' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selectedDocIds.includes(rec.id)}
                      onChange={() => handleSelectRow(rec.id)}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                  </TableCell>
                  <TableCell className="font-mono font-bold text-slate-800 dark:text-slate-200">
                    {formatPeriodForDisplay(rec.reportingPeriod)}
                  </TableCell>
                  <TableCell>
                    <div className="font-bold text-slate-900 dark:text-white">{rec.employeeName}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{rec.employeeEmail}</div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{rec.process}</div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase">{rec.role}</div>
                  </TableCell>
                  <TableCell className="font-mono font-extrabold text-indigo-600 dark:text-indigo-400">
                    {formatKpiNumber(rec.totalScore)}
                  </TableCell>
                  <TableCell className="font-mono font-bold text-slate-700 dark:text-slate-300">
                    #{rec.processRank ?? '-'}
                  </TableCell>
                  <TableCell className="font-mono font-bold text-slate-700 dark:text-slate-300">
                    #{rec.roleRank ?? '-'}
                  </TableCell>
                  <TableCell className="font-mono font-bold text-amber-600 dark:text-amber-400">
                    #{rec.organizationRank ?? rec.rank ?? '-'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(rec.productivityScore)}</div>
                    <div className="text-[10px] text-indigo-600 dark:text-indigo-400 font-sans font-medium mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]" title={rec.kpiNameProductivity || 'Productivity'}>
                      {rec.kpiNameProductivity || 'Productivity'}
                    </div>
                    <div className="text-[9px] text-slate-400 dark:text-slate-500 font-sans mt-0.5">
                      T: {rec.targetProductivity} | A: {rec.actualProductivity}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(rec.qualityScore)}</div>
                    <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-sans font-medium mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]" title={rec.kpiNameQuality || 'Quality'}>
                      {rec.kpiNameQuality || 'Quality'}
                    </div>
                    <div className="text-[9px] text-slate-400 dark:text-slate-500 font-sans mt-0.5">
                      T: {rec.targetQuality} | A: {rec.actualQuality}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(rec.attendanceScore)}</div>
                    <div className="text-[10px] text-amber-600 dark:text-amber-400 font-sans font-medium mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]" title={rec.kpiNameAttendance || 'Attendance'}>
                      {rec.kpiNameAttendance || 'Attendance'}
                    </div>
                    <div className="text-[9px] text-slate-400 dark:text-slate-500 font-sans mt-0.5">
                      T: {rec.targetAttendance} | A: {rec.actualAttendance}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(rec.aptScore)}</div>
                    <div className="text-[10px] text-blue-600 dark:text-blue-400 font-sans font-medium mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]" title={rec.kpiNameAPT || 'APT'}>
                      {rec.kpiNameAPT || 'APT'}
                    </div>
                    <div className="text-[9px] text-slate-400 dark:text-slate-500 font-sans mt-0.5">
                      T: {rec.targetAPT} | A: {rec.actualAPT}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">
                    <span className="text-emerald-600 font-bold">+{formatKpiNumber(rec.bonus, '0.00')}</span>
                    {' / '}
                    <span className="text-rose-600 font-bold">-{formatKpiNumber(rec.penalty, '0.00')}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        onClick={() => setInspectModalRecord(rec)}
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50"
                      >
                        <Eye size={14} />
                      </Button>
                      <Button
                        onClick={() => handleDeleteRecord(rec.id, rec.employeeName)}
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination Footer */}
      <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs bg-slate-50/50 dark:bg-slate-950/50">
        <div className="flex items-center gap-3">
          <span className="text-slate-500">
            Showing <span className="font-bold text-slate-800 dark:text-slate-200">{totalRecords === 0 ? 0 : startIndex + 1}</span> to{' '}
            <span className="font-bold text-slate-800 dark:text-slate-200">{endIndex}</span> of{' '}
            <span className="font-bold text-slate-800 dark:text-slate-200">{totalRecords}</span> entries
          </span>

          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">Rows per page:</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="h-7 px-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 font-bold"
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
              <option value={5000}>5000</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
            disabled={safePage <= 1}
            variant="outline"
            size="sm"
            className="h-8 text-xs font-bold"
          >
            Previous
          </Button>
          <span className="px-2 font-bold text-slate-700 dark:text-slate-300">
            Page {safePage} of {totalPages}
          </span>
          <Button
            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
            disabled={safePage >= totalPages}
            variant="outline"
            size="sm"
            className="h-8 text-xs font-bold"
          >
            Next
          </Button>
        </div>
      </div>

      {/* Upload Modal */}
      <KpiUploadModal
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onImportSuccess={() => loadData(true)}
        user={user}
        roster={roster}
      />

      {/* Export Modal */}
      <KpiExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        allRecords={scorecards}
        currentFilteredRecords={filteredRecords}
        user={user}
        roster={roster}
      />

      {/* Inspect Single Record Modal */}
      {inspectModalRecord && (
        <Dialog open={!!inspectModalRecord} onOpenChange={(o) => !o && setInspectModalRecord(null)}>
          <DialogContent className="max-w-2xl bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-6 rounded-3xl">
            <DialogHeader className="border-b border-slate-100 dark:border-slate-800 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <DialogTitle className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <span>{inspectModalRecord.employeeName}</span>
                    <span className="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 text-xs font-mono font-bold">
                      {formatPeriodForDisplay(inspectModalRecord.reportingPeriod)}
                    </span>
                  </DialogTitle>
                  <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {inspectModalRecord.employeeEmail} • Process: {inspectModalRecord.process} • Role: {inspectModalRecord.role}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="py-4 flex flex-col gap-4 text-xs">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-slate-50 dark:bg-slate-950 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Process Rank</span>
                  <div className="text-xl font-black font-mono mt-1">#{inspectModalRecord.processRank ?? '-'}</div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-950 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Role Rank</span>
                  <div className="text-xl font-black font-mono mt-1">#{inspectModalRecord.roleRank ?? '-'}</div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-950 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Org Rank</span>
                  <div className="text-xl font-black font-mono text-amber-600 mt-1">#{inspectModalRecord.organizationRank ?? inspectModalRecord.rank ?? '-'}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">{inspectModalRecord.kpiNameProductivity || 'Productivity'}</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold">{formatKpiNumber(inspectModalRecord.productivityScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectModalRecord.targetProductivity)} | Actual: {formatKpiNumber(inspectModalRecord.actualProductivity)}</div>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">{inspectModalRecord.kpiNameQuality || 'Quality'}</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold">{formatKpiNumber(inspectModalRecord.qualityScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectModalRecord.targetQuality)} | Actual: {formatKpiNumber(inspectModalRecord.actualQuality)}</div>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">{inspectModalRecord.kpiNameAttendance || 'Attendance'}</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold">{formatKpiNumber(inspectModalRecord.attendanceScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectModalRecord.targetAttendance)} | Actual: {formatKpiNumber(inspectModalRecord.actualAttendance)}</div>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">{inspectModalRecord.kpiNameAPT || 'APT'}</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold">{formatKpiNumber(inspectModalRecord.aptScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectModalRecord.targetAPT)} | Actual: {formatKpiNumber(inspectModalRecord.actualAPT)}</div>
                </div>
              </div>

              {inspectModalRecord.comments && (
                <div className="p-3 bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl">
                  <span className="font-bold text-indigo-700 dark:text-indigo-400">Comments:</span>
                  <p className="text-slate-600 dark:text-slate-300 mt-0.5">{inspectModalRecord.comments}</p>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="max-w-md bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-6 rounded-3xl">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-2xl bg-rose-50 dark:bg-rose-950/60 text-rose-600 flex items-center justify-center">
                <AlertTriangle size={20} />
              </div>
              <DialogTitle className="text-base font-bold text-slate-900 dark:text-white">
                Confirm Permanent Delete
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {deleteConfig.mode === 'single'
                ? `Are you sure you want to delete the KPI scorecard for "${deleteConfig.name}"?`
                : deleteConfig.mode === 'bulk'
                ? `Are you sure you want to permanently delete the ${selectedDocIds.length} selected KPI scorecard(s)?`
                : `Are you sure you want to permanently delete ALL KPI scorecards? This will wipe the entire monthly collection and clear cached entries.`}
              <span className="block mt-1 font-bold text-rose-600">This action cannot be undone.</span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmOpen(false)} className="text-xs">
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={executeDelete} className="text-xs font-bold px-4">
              Permanent Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
