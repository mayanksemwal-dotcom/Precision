import React, { useState, useEffect, useMemo } from 'react';
import { 
  FileUp, 
  Download, 
  Search, 
  Filter, 
  Trash2, 
  Eye, 
  RefreshCw, 
  Award, 
  Trophy, 
  Users, 
  BarChart3, 
  FileText,
  X,
  ChevronDown,
  ArrowUpDown,
  Calendar,
  CheckCircle2
} from 'lucide-react';
import { KPIScorecard, UserProfile } from '../../types';
import { formatPeriodForDisplay, formatKpiNumber } from '../../lib/utils';
import { 
  fetchAllKpiScorecards, 
  fetchKpiMetadata,
  deleteKpiScorecard, 
  deleteKpiScorecardsBulk,
  downloadKpiTemplate, 
  exportKpiToExcel 
} from '../../services/kpiService';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import KpiUploadModal from './KpiUploadModal';
import KpiExportModal from './KpiExportModal';
import { canExportKpi } from '../../services/kpiService';
import { toast } from 'sonner';

interface ManagerKpiDashboardProps {
  user: UserProfile;
  roster: UserProfile[];
}

export default function ManagerKpiDashboard({ user, roster }: ManagerKpiDashboardProps) {
  const [scorecards, setScorecards] = useState<KPIScorecard[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [inspectModalRecord, setInspectModalRecord] = useState<KPIScorecard | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfig, setDeleteConfig] = useState<{ mode: 'single' | 'bulk'; id?: string; name?: string; }>({ mode: 'single' });

  const userCanExport = canExportKpi(user.role);

  // Active Tab
  const [activeTab, setActiveTab] = useState<'scorecards' | 'orgLeaderboard' | 'processLeaderboard' | 'roleLeaderboard'>('scorecards');

  // Primary Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('ALL');
  const [selectedProcess, setSelectedProcess] = useState<string>('ALL');
  const [selectedRole, setSelectedRole] = useState<string>('ALL');
  const [metaOptions, setMetaOptions] = useState<{ periods: string[]; processes: string[]; roles: string[] }>({
    periods: [],
    processes: [],
    roles: []
  });

  // Debounce search query to avoid expensive calculations on every keystroke
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  // Fetch KPI metadata on mount for instant dropdown options
  useEffect(() => {
    fetchKpiMetadata().then(meta => {
      if (meta && meta.reportingPeriods?.length > 0) {
        setMetaOptions({
          periods: meta.reportingPeriods,
          processes: meta.processes || [],
          roles: meta.roles || []
        });
        // Pre-select latest period if available and period is defaulted
        if (meta.reportingPeriods.length > 0) {
          setSelectedPeriod(meta.reportingPeriods[0]);
        }
      }
    }).catch(err => {
      console.warn('Metadata fetch error:', err);
    });
  }, []);

  // Advanced Range Filters
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [processRankMin, setProcessRankMin] = useState('');
  const [processRankMax, setProcessRankMax] = useState('');
  const [roleRankMin, setRoleRankMin] = useState('');
  const [roleRankMax, setRoleRankMax] = useState('');
  const [orgRankMin, setOrgRankMin] = useState('');
  const [orgRankMax, setOrgRankMax] = useState('');
  const [totalScoreMin, setTotalScoreMin] = useState('');
  const [totalScoreMax, setTotalScoreMax] = useState('');

  // Leaderboard specific filter dropdowns
  const [lbProcess, setLbProcess] = useState<string>('ALL');
  const [lbRole, setLbRole] = useState<string>('ALL');

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);

  useEffect(() => {
    setCurrentPage(1);
    setSelectedDocIds([]);
  }, [
    activeTab, debouncedSearch, selectedPeriod, selectedProcess, selectedRole,
    processRankMin, processRankMax, roleRankMin, roleRankMax, orgRankMin, orgRankMax,
    totalScoreMin, totalScoreMax, lbProcess, lbRole, pageSize
  ]);

  // Sorting
  const [sortField, setSortField] = useState<'processRank' | 'roleRank' | 'organizationRank' | 'totalScore' | 'employeeName' | 'reportingPeriod'>('totalScore');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const loadData = async (forceServer: boolean = false, targetPeriod?: string) => {
    setLoading(true);
    try {
      const periodToFetch = targetPeriod !== undefined ? targetPeriod : selectedPeriod;
      const records = await fetchAllKpiScorecards(periodToFetch, forceServer);
      setScorecards(records);
    } catch (err) {
      console.error('Error fetching KPI scorecards:', err);
      toast.error('Failed to load KPI scorecards.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(false, selectedPeriod);
  }, [selectedPeriod]);

  // Unique reporting periods, processes, roles for dropdown filters
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

  // Filtered and Sorted Records
  const filteredRecords = useMemo(() => {
    return scorecards.filter(rec => {
      // Search with 300ms debounced term
      const q = debouncedSearch.toLowerCase().trim();
      const matchSearch = !q || 
        rec.employeeEmail.toLowerCase().includes(q) ||
        rec.employeeName.toLowerCase().includes(q) ||
        rec.process.toLowerCase().includes(q);

      // Period Filter
      const matchPeriod = selectedPeriod === 'ALL' || rec.reportingPeriod === selectedPeriod;

      // Process Filter
      const matchProcess = selectedProcess === 'ALL' || rec.process === selectedProcess;

      // Role Filter
      const matchRole = selectedRole === 'ALL' || rec.role === selectedRole;

      // Range Filters
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
    processRankMin, processRankMax, roleRankMin, roleRankMax, orgRankMin, orgRankMax, totalScoreMin, totalScoreMax,
    sortField, sortDirection
  ]);

  const handleSortToggle = (field: 'processRank' | 'roleRank' | 'organizationRank' | 'totalScore' | 'employeeName' | 'reportingPeriod') => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection(field.includes('Rank') ? 'asc' : 'desc');
    }
  };

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

  const executeDelete = async () => {
    setDeleteConfirmOpen(false);
    if (deleteConfig.mode === 'single' && deleteConfig.id) {
      try {
        await deleteKpiScorecard(deleteConfig.id);
        toast.success('KPI scorecard deleted successfully.');
        setScorecards(prev => prev.filter(s => s.id !== deleteConfig.id));
        setSelectedDocIds(prev => prev.filter(id => id !== deleteConfig.id));
      } catch (err) {
        console.error('Delete error:', err);
        toast.error('Failed to delete scorecard.');
      }
    } else if (deleteConfig.mode === 'bulk') {
      const toDelete = selectedDocIds.filter(id => scorecards.some(s => s.id === id));
      if (toDelete.length === 0) return;
      try {
        await deleteKpiScorecardsBulk(toDelete);
        toast.success(`Successfully deleted ${toDelete.length} KPI scorecard(s).`);
        setScorecards(prev => prev.filter(s => !toDelete.includes(s.id)));
        setSelectedDocIds([]);
      } catch (err) {
        console.error('Bulk delete error:', err);
        toast.error('Failed to perform bulk delete.');
      }
    }
  };

  // Clear selection when active tab, search query, or filters change
  useEffect(() => {
    setSelectedDocIds([]);
  }, [
    activeTab, searchQuery, selectedPeriod, selectedProcess, selectedRole,
    processRankMin, processRankMax, roleRankMin, roleRankMax, orgRankMin, orgRankMax,
    totalScoreMin, totalScoreMax
  ]);

  const handleSelectRow = (id: string) => {
    setSelectedDocIds(prev =>
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  const handleSelectAllToggle = () => {
    const filteredIds = filteredRecords.map(r => r.id);
    const allFilteredSelected = filteredIds.every(id => selectedDocIds.includes(id));

    if (allFilteredSelected) {
      setSelectedDocIds(prev => prev.filter(id => !filteredIds.includes(id)));
    } else {
      setSelectedDocIds(prev => {
        const newSelection = [...prev];
        filteredIds.forEach(id => {
          if (!newSelection.includes(id)) {
            newSelection.push(id);
          }
        });
        return newSelection;
      });
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto w-full">
      {/* Page Header */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 md:p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
              Global KPI Dashboard & Leaderboards
            </h2>
            <span className="px-2.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 font-mono text-[11px] font-bold">
              Multi-Rank • Upload Driven
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Analyze team performance across Process, Role, and Organization rankings seamlessly.
          </p>
        </div>

        {/* Top Action Buttons */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button
            onClick={downloadKpiTemplate}
            variant="outline"
            size="sm"
            className="text-xs gap-1.5 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
          >
            <Download size={14} />
            <span>Sample Template</span>
          </Button>

          {userCanExport && (
            <Button
              onClick={() => setExportModalOpen(true)}
              disabled={scorecards.length === 0}
              variant="outline"
              size="sm"
              className="text-xs gap-1.5 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <FileText size={14} />
              <span>Export ({filteredRecords.length})</span>
            </Button>
          )}

          <Button
            onClick={() => setUploadModalOpen(true)}
            size="sm"
            className="bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white text-xs font-bold gap-2 shadow-md shadow-indigo-500/20 px-4 py-2 transition-all transform hover:scale-[1.02]"
          >
            <FileUp size={15} className="animate-bounce" />
            <span>Upload KPI Scorecard</span>
          </Button>
        </div>
      </div>

      {/* Navigation Tabs Bar */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('scorecards')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
            activeTab === 'scorecards'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50'
          }`}
        >
          <BarChart3 size={15} />
          <span>KPI Scorecards Table</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/20">
            {filteredRecords.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('orgLeaderboard')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
            activeTab === 'orgLeaderboard'
              ? 'bg-amber-600 text-white shadow-sm'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50'
          }`}
        >
          <Trophy size={15} className={activeTab === 'orgLeaderboard' ? 'text-amber-200' : 'text-amber-500'} />
          <span>Organization Leaderboard</span>
        </button>

        <button
          onClick={() => setActiveTab('processLeaderboard')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
            activeTab === 'processLeaderboard'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50'
          }`}
        >
          <Award size={15} />
          <span>Process Leaderboard</span>
        </button>

        <button
          onClick={() => setActiveTab('roleLeaderboard')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
            activeTab === 'roleLeaderboard'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50'
          }`}
        >
          <Users size={15} />
          <span>Role Leaderboard</span>
        </button>
      </div>

      {/* FILTER PANEL */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm flex flex-col gap-3">
        {/* Top Filter Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Search Input */}
          <div className="relative flex-grow max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by Employee Name, Email, Process..."
              className="pl-9 h-9 text-xs rounded-xl bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800"
            />
          </div>

          {/* Dropdown Filters */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Period Filter */}
            <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800">
              <Calendar size={14} className="text-slate-400" />
              <span className="text-[11px] font-bold text-slate-500">Period:</span>
              <select
                value={selectedPeriod}
                onChange={(e) => setSelectedPeriod(e.target.value)}
                className="bg-transparent text-xs font-bold text-slate-800 dark:text-slate-200 focus:outline-none"
              >
                <option value="ALL">All Periods</option>
                {uniquePeriods.map(p => (
                  <option key={p} value={p}>{formatPeriodForDisplay(p)}</option>
                ))}
              </select>
            </div>

            {/* Process Filter */}
            <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800">
              <Filter size={14} className="text-slate-400" />
              <span className="text-[11px] font-bold text-slate-500">Process:</span>
              <select
                value={selectedProcess}
                onChange={(e) => setSelectedProcess(e.target.value)}
                className="bg-transparent text-xs font-bold text-slate-800 dark:text-slate-200 focus:outline-none"
              >
                <option value="ALL">All Processes</option>
                {uniqueProcesses.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            {/* Role Filter */}
            <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800">
              <Users size={14} className="text-slate-400" />
              <span className="text-[11px] font-bold text-slate-500">Role:</span>
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                className="bg-transparent text-xs font-bold text-slate-800 dark:text-slate-200 focus:outline-none"
              >
                <option value="ALL">All Roles</option>
                {uniqueRoles.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {/* Advanced Ranges Toggle */}
            <Button
              onClick={() => setShowAdvancedFilters(prev => !prev)}
              variant="outline"
              size="sm"
              className={`h-9 text-xs gap-1.5 ${showAdvancedFilters ? 'bg-indigo-50 text-indigo-600 border-indigo-200' : ''}`}
            >
              <Filter size={13} />
              <span>Rank & Score Ranges</span>
              <ChevronDown size={12} className={`transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} />
            </Button>

            {/* Refresh button */}
            <Button
              onClick={() => loadData(true)}
              variant="ghost"
              size="sm"
              className="h-9 px-2 text-slate-500 hover:text-indigo-600"
              title="Refresh Data from Server"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>
        </div>

        {/* Expandable Advanced Range Filters */}
        {showAdvancedFilters && (
          <div className="p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            {/* Process Rank Range */}
            <div>
              <label className="font-bold text-slate-600 dark:text-slate-400 block mb-1">Process Rank Range</label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  placeholder="Min"
                  value={processRankMin}
                  onChange={e => setProcessRankMin(e.target.value)}
                  className="h-8 text-xs bg-white dark:bg-slate-900"
                />
                <span className="text-slate-400">-</span>
                <Input
                  type="number"
                  placeholder="Max"
                  value={processRankMax}
                  onChange={e => setProcessRankMax(e.target.value)}
                  className="h-8 text-xs bg-white dark:bg-slate-900"
                />
              </div>
            </div>

            {/* Role Rank Range */}
            <div>
              <label className="font-bold text-slate-600 dark:text-slate-400 block mb-1">Role Rank Range</label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  placeholder="Min"
                  value={roleRankMin}
                  onChange={e => setRoleRankMin(e.target.value)}
                  className="h-8 text-xs bg-white dark:bg-slate-900"
                />
                <span className="text-slate-400">-</span>
                <Input
                  type="number"
                  placeholder="Max"
                  value={roleRankMax}
                  onChange={e => setRoleRankMax(e.target.value)}
                  className="h-8 text-xs bg-white dark:bg-slate-900"
                />
              </div>
            </div>

            {/* Org Rank Range */}
            <div>
              <label className="font-bold text-slate-600 dark:text-slate-400 block mb-1">Org Rank Range</label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  placeholder="Min"
                  value={orgRankMin}
                  onChange={e => setOrgRankMin(e.target.value)}
                  className="h-8 text-xs bg-white dark:bg-slate-900"
                />
                <span className="text-slate-400">-</span>
                <Input
                  type="number"
                  placeholder="Max"
                  value={orgRankMax}
                  onChange={e => setOrgRankMax(e.target.value)}
                  className="h-8 text-xs bg-white dark:bg-slate-900"
                />
              </div>
            </div>

            {/* Total Score Range */}
            <div>
              <label className="font-bold text-slate-600 dark:text-slate-400 block mb-1">Total Score Range</label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  placeholder="Min Score"
                  value={totalScoreMin}
                  onChange={e => setTotalScoreMin(e.target.value)}
                  className="h-8 text-xs bg-white dark:bg-slate-900"
                />
                <span className="text-slate-400">-</span>
                <Input
                  type="number"
                  placeholder="Max Score"
                  value={totalScoreMax}
                  onChange={e => setTotalScoreMax(e.target.value)}
                  className="h-8 text-xs bg-white dark:bg-slate-900"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* TAB 1: KPI SCORECARDS TABLE */}
      {activeTab === 'scorecards' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
          {selectedDocIds.length > 0 && !loading && (
            <div className="bg-indigo-50/80 dark:bg-indigo-950/40 border-b border-indigo-100 dark:border-indigo-900/50 px-5 py-3 flex items-center justify-between gap-4 transition-all">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-indigo-600 dark:bg-indigo-400 animate-pulse" />
                <span className="text-xs font-bold text-indigo-900 dark:text-indigo-200">
                  {selectedDocIds.length} item{selectedDocIds.length > 1 ? 's' : ''} selected
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => setSelectedDocIds([])}
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl"
                >
                  Clear Selection
                </Button>
                <Button
                  onClick={handleBulkDelete}
                  variant="destructive"
                  size="sm"
                  className="h-8 text-xs font-bold gap-1.5 px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-xl shadow-sm"
                >
                  <Trash2 size={13} />
                  <span>Delete Selected</span>
                </Button>
              </div>
            </div>
          )}
          {loading ? (
            <div className="flex flex-col items-center justify-center min-h-[300px] gap-3 text-slate-500">
              <RefreshCw size={28} className="animate-spin text-indigo-600" />
              <p className="text-xs font-semibold">Loading team KPI records...</p>
            </div>
          ) : filteredRecords.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
              <Award size={36} className="text-slate-300 dark:text-slate-700 mb-2" />
              <h4 className="font-bold text-slate-800 dark:text-slate-200 text-sm">No KPI Scorecards Match Your Filter</h4>
              <p className="text-xs text-slate-500 max-w-sm mt-1">
                Try adjusting your search query, reporting period filter, or upload a new Excel scorecard file.
              </p>
            </div>
          ) : (() => {
            const totalRecords = filteredRecords.length;
            const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
            const safePage = Math.min(currentPage, totalPages);
            const startIndex = (safePage - 1) * pageSize;
            const endIndex = Math.min(startIndex + pageSize, totalRecords);
            const currentPageRecords = filteredRecords.slice(startIndex, endIndex);

            const allCurrentSelected = currentPageRecords.length > 0 && currentPageRecords.every(rec => selectedDocIds.includes(rec.id));

            return (
              <div className="flex flex-col gap-0 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="overflow-auto max-h-[60vh] relative">
                  <Table>
                    <TableHeader className="bg-slate-50 dark:bg-slate-950 sticky top-0 z-10 shadow-xs">
                      <TableRow className="text-[11px] bg-slate-50 dark:bg-slate-950">
                        <TableHead className="w-10 sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">
                          <input
                            type="checkbox"
                            className="rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500 h-4 w-4 cursor-pointer transition-all bg-white dark:bg-slate-900"
                            checked={allCurrentSelected}
                            onChange={() => {
                              if (allCurrentSelected) {
                                setSelectedDocIds(prev => prev.filter(id => !currentPageRecords.some(r => r.id === id)));
                              } else {
                                const pageIds = currentPageRecords.map(r => r.id);
                                setSelectedDocIds(prev => Array.from(new Set([...prev, ...pageIds])));
                              }
                            }}
                          />
                        </TableHead>
                        <TableHead className="font-bold cursor-pointer sticky top-0 bg-slate-50 dark:bg-slate-950 z-10" onClick={() => handleSortToggle('reportingPeriod')}>
                          <div className="flex items-center gap-1">
                            <span>Period</span>
                            <ArrowUpDown size={12} className="text-slate-400" />
                          </div>
                        </TableHead>
                        <TableHead className="font-bold cursor-pointer sticky top-0 bg-slate-50 dark:bg-slate-950 z-10" onClick={() => handleSortToggle('employeeName')}>
                          <div className="flex items-center gap-1">
                            <span>Employee</span>
                            <ArrowUpDown size={12} className="text-slate-400" />
                          </div>
                        </TableHead>
                        <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Process & Role</TableHead>
                        <TableHead className="font-bold cursor-pointer sticky top-0 bg-slate-50 dark:bg-slate-950 z-10" onClick={() => handleSortToggle('totalScore')}>
                          <div className="flex items-center gap-1">
                            <span>Total Score</span>
                            <ArrowUpDown size={12} className="text-slate-400" />
                          </div>
                        </TableHead>
                        <TableHead className="font-bold cursor-pointer sticky top-0 bg-slate-50 dark:bg-slate-950 z-10" onClick={() => handleSortToggle('processRank')}>
                          <div className="flex items-center gap-1">
                            <span>Proc Rank</span>
                            <ArrowUpDown size={12} className="text-slate-400" />
                          </div>
                        </TableHead>
                        <TableHead className="font-bold cursor-pointer sticky top-0 bg-slate-50 dark:bg-slate-950 z-10" onClick={() => handleSortToggle('roleRank')}>
                          <div className="flex items-center gap-1">
                            <span>Role Rank</span>
                            <ArrowUpDown size={12} className="text-slate-400" />
                          </div>
                        </TableHead>
                        <TableHead className="font-bold cursor-pointer sticky top-0 bg-slate-50 dark:bg-slate-950 z-10" onClick={() => handleSortToggle('organizationRank')}>
                          <div className="flex items-center gap-1">
                            <span>Org Rank</span>
                            <ArrowUpDown size={12} className="text-slate-400" />
                          </div>
                        </TableHead>
                        <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Prod</TableHead>
                        <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Quality</TableHead>
                        <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Attendance</TableHead>
                        <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">APT</TableHead>
                        <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Bonus / Penalty</TableHead>
                        <TableHead className="font-bold text-right sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {currentPageRecords.map((rec) => (
                        <TableRow key={rec.id} className={`text-xs hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${
                          selectedDocIds.includes(rec.id) ? 'bg-indigo-50/20 dark:bg-indigo-950/10' : ''
                        }`}>
                          <TableCell className="w-10">
                            <input
                              type="checkbox"
                              className="rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500 h-4 w-4 cursor-pointer transition-all bg-white dark:bg-slate-900"
                              checked={selectedDocIds.includes(rec.id)}
                              onChange={() => handleSelectRow(rec.id)}
                            />
                          </TableCell>
                          <TableCell className="font-mono font-bold text-slate-800 dark:text-slate-200">
                            {formatPeriodForDisplay(rec.reportingPeriod)}
                          </TableCell>
                          <TableCell>
                            <div>
                              <div className="font-bold text-slate-900 dark:text-white">
                                {rec.employeeName}
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono">
                                {rec.employeeEmail}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div>
                              <div className="font-medium text-slate-800 dark:text-slate-200">{rec.process}</div>
                              <div className="text-[10px] text-slate-500 font-bold uppercase">{rec.role}</div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className={`inline-block px-2 py-0.5 rounded-full font-mono font-black text-xs border whitespace-nowrap ${
                              Number(rec.totalScore) >= 90
                                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                                : Number(rec.totalScore) >= 75
                                ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800'
                                : 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800'
                            }`}>
                              {formatKpiNumber(rec.totalScore)}
                            </span>
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
                          <TableCell className="text-slate-600 dark:text-slate-400 font-mono">
                            {formatKpiNumber(rec.productivityScore)}
                          </TableCell>
                          <TableCell className="text-slate-600 dark:text-slate-400 font-mono">
                            {formatKpiNumber(rec.qualityScore)}
                          </TableCell>
                          <TableCell className="text-slate-600 dark:text-slate-400 font-mono">
                            {formatKpiNumber(rec.attendanceScore)}
                          </TableCell>
                          <TableCell className="text-slate-600 dark:text-slate-400 font-mono">
                            {formatKpiNumber(rec.aptScore)}
                          </TableCell>
                          <TableCell className="font-mono text-[11px]">
                            <span className="text-emerald-600 dark:text-emerald-400">+{formatKpiNumber(rec.bonus, '0.00')}</span>
                            {' / '}
                            <span className="text-rose-600 dark:text-rose-400">-{formatKpiNumber(rec.penalty, '0.00')}</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                onClick={() => setInspectModalRecord(rec)}
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50"
                                title="View Details"
                              >
                                <Eye size={14} />
                              </Button>
                              <Button
                                onClick={() => handleDeleteRecord(rec.id, rec.employeeName)}
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-slate-500 hover:text-rose-600 hover:bg-rose-50"
                                title="Delete Scorecard"
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

                {/* Pagination Toolbar */}
                {totalRecords > 0 && (
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-600 dark:text-slate-400">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1.5">
                        <span>Rows per page:</span>
                        <select
                          value={pageSize}
                          onChange={(e) => {
                            setPageSize(Number(e.target.value));
                            setCurrentPage(1);
                          }}
                          className="px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-bold text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 cursor-pointer"
                        >
                          <option value={50}>50</option>
                          <option value={100}>100</option>
                          <option value={200}>200</option>
                        </select>
                      </div>
                      <span className="font-mono text-slate-500">
                        Showing {startIndex + 1}–{endIndex} of {totalRecords} records
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-500 mr-2">
                        Page {safePage} of {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={safePage <= 1}
                        onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                        className="h-7 px-2.5 text-xs font-bold"
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={safePage >= totalPages}
                        onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                        className="h-7 px-2.5 text-xs font-bold"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* TAB 2, 3, 4: LEADERBOARD VIEWS */}
      {activeTab !== 'scorecards' && (
        <div className="flex flex-col gap-6">
          {/* Leaderboard Header Banner */}
          <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white rounded-2xl p-6 border border-indigo-900/50 shadow-md flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Trophy size={20} className="text-amber-400" />
                <h3 className="text-lg font-black tracking-tight">
                  {activeTab === 'orgLeaderboard' && 'Organization Performance Leaderboard'}
                  {activeTab === 'processLeaderboard' && 'Process Level Performance Leaderboard'}
                  {activeTab === 'roleLeaderboard' && 'Role Level Performance Leaderboard'}
                </h3>
              </div>
              <p className="text-xs text-slate-300 mt-1">
                {activeTab === 'orgLeaderboard' && 'Global ranking across all processes and roles for the selected period.'}
                {activeTab === 'processLeaderboard' && 'Process specific rankings uploaded from Excel.'}
                {activeTab === 'roleLeaderboard' && 'Role specific rankings uploaded from Excel.'}
              </p>
            </div>
          </div>

          {/* Leaderboard Table List */}
          {(() => {
            const list = [...filteredRecords].sort((a, b) => {
              if (activeTab === 'orgLeaderboard') {
                const rA = Number(a.organizationRank ?? a.rank) || 999999;
                const rB = Number(b.organizationRank ?? b.rank) || 999999;
                return rA - rB;
              } else if (activeTab === 'processLeaderboard') {
                const rA = Number(a.processRank) || 999999;
                const rB = Number(b.processRank) || 999999;
                return rA - rB;
              } else {
                const rA = Number(a.roleRank) || 999999;
                const rB = Number(b.roleRank) || 999999;
                return rA - rB;
              }
            });

            if (list.length === 0) {
              return (
                <div className="bg-white dark:bg-slate-900 p-12 text-center rounded-2xl border border-slate-200 dark:border-slate-800">
                  <Trophy size={32} className="mx-auto text-slate-300 mb-2" />
                  <p className="text-xs font-bold text-slate-600">No records found for this leaderboard filter.</p>
                </div>
              );
            }

            const top1 = list[0];
            const top2 = list[1];
            const top3 = list[2];

            return (
              <div className="flex flex-col gap-6">
                {/* Podium Cards Top 3 */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* #2 Rank */}
                  {top2 && (
                    <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between relative overflow-hidden order-2 md:order-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">2nd Place</span>
                        <span className="text-2xl">🥈</span>
                      </div>
                      <div className="mt-3">
                        <h4 className="font-extrabold text-slate-900 dark:text-white text-base">{top2.employeeName}</h4>
                        <p className="text-xs text-slate-500 font-mono mt-0.5">{top2.employeeEmail}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono text-xs font-extrabold">
                            Score: {formatKpiNumber(top2.totalScore)}
                          </span>
                          <span className="text-xs font-bold text-slate-500">
                            Rank #{activeTab === 'orgLeaderboard' ? (top2.organizationRank ?? top2.rank) : activeTab === 'processLeaderboard' ? top2.processRank : top2.roleRank}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* #1 Rank */}
                  {top1 && (
                    <div className="bg-gradient-to-br from-amber-500 via-amber-600 to-amber-700 text-white p-6 rounded-2xl border border-amber-400 shadow-lg flex flex-col justify-between relative overflow-hidden order-1 md:order-2 transform md:-translate-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-100">1st Place Champion</span>
                        <span className="text-3xl">🥇</span>
                      </div>
                      <div className="mt-3">
                        <h4 className="font-black text-white text-lg tracking-tight">{top1.employeeName}</h4>
                        <p className="text-xs text-amber-100 font-mono mt-0.5">{top1.employeeEmail}</p>
                        <div className="mt-3 flex items-center gap-2">
                          <span className="px-2.5 py-1 rounded-full bg-white text-amber-900 font-mono text-xs font-extrabold">
                            Score: {formatKpiNumber(top1.totalScore)}
                          </span>
                          <span className="text-xs font-bold text-amber-100">
                            Rank #{activeTab === 'orgLeaderboard' ? (top1.organizationRank ?? top1.rank) : activeTab === 'processLeaderboard' ? top1.processRank : top1.roleRank}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* #3 Rank */}
                  {top3 && (
                    <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between relative overflow-hidden order-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-700/60">3rd Place</span>
                        <span className="text-2xl">🥉</span>
                      </div>
                      <div className="mt-3">
                        <h4 className="font-extrabold text-slate-900 dark:text-white text-base">{top3.employeeName}</h4>
                        <p className="text-xs text-slate-500 font-mono mt-0.5">{top3.employeeEmail}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono text-xs font-extrabold">
                            Score: {formatKpiNumber(top3.totalScore)}
                          </span>
                          <span className="text-xs font-bold text-slate-500">
                            Rank #{activeTab === 'orgLeaderboard' ? (top3.organizationRank ?? top3.rank) : activeTab === 'processLeaderboard' ? top3.processRank : top3.roleRank}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Leaderboard Detailed Table */}
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
                  <Table>
                    <TableHeader className="bg-slate-50 dark:bg-slate-950">
                      <TableRow className="text-[11px]">
                        <TableHead className="font-bold">Leaderboard Rank</TableHead>
                        <TableHead className="font-bold">Employee</TableHead>
                        <TableHead className="font-bold">Process & Role</TableHead>
                        <TableHead className="font-bold">Total Score</TableHead>
                        <TableHead className="font-bold">Process Rank</TableHead>
                        <TableHead className="font-bold">Role Rank</TableHead>
                        <TableHead className="font-bold">Org Rank</TableHead>
                        <TableHead className="font-bold">Bonus / Penalty</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {list.map((item, idx) => {
                        const currentRank = activeTab === 'orgLeaderboard'
                          ? (item.organizationRank ?? item.rank ?? idx + 1)
                          : activeTab === 'processLeaderboard'
                          ? (item.processRank ?? idx + 1)
                          : (item.roleRank ?? idx + 1);

                        return (
                          <TableRow key={item.id} className="text-xs">
                            <TableCell className="font-mono font-black text-sm">
                              {idx === 0 ? '🥇 #1' : idx === 1 ? '🥈 #2' : idx === 2 ? '🥉 #3' : `#${currentRank}`}
                            </TableCell>
                            <TableCell>
                              <div className="font-bold text-slate-900 dark:text-white">{item.employeeName}</div>
                              <div className="text-[11px] text-slate-500 font-mono">{item.employeeEmail}</div>
                            </TableCell>
                            <TableCell>
                              <div className="font-medium">{item.process}</div>
                              <div className="text-[10px] text-slate-500 uppercase font-bold">{item.role}</div>
                            </TableCell>
                            <TableCell className="font-mono font-extrabold text-indigo-600 dark:text-indigo-400">
                              {formatKpiNumber(item.totalScore)}
                            </TableCell>
                            <TableCell className="font-mono font-bold">#{item.processRank ?? '-'}</TableCell>
                            <TableCell className="font-mono font-bold">#{item.roleRank ?? '-'}</TableCell>
                            <TableCell className="font-mono font-bold text-amber-600">#{item.organizationRank ?? item.rank ?? '-'}</TableCell>
                            <TableCell className="font-mono text-[11px]">
                              <span className="text-emerald-600">+{formatKpiNumber(item.bonus, '0.00')}</span>
                              {' / '}
                              <span className="text-rose-600">-{formatKpiNumber(item.penalty, '0.00')}</span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            );
          })()}
        </div>
      )}


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

      {/* Scorecard Detailed Inspector Modal */}
      {inspectModalRecord && (
        <Dialog open={!!inspectModalRecord} onOpenChange={(o) => !o && setInspectModalRecord(null)}>
          <DialogContent className="max-w-2xl bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-6">
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
                    {inspectModalRecord.employeeEmail} • Process: {inspectModalRecord.process}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="py-4 flex flex-col gap-4">
              {/* Top Row Badges */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-slate-50 dark:bg-slate-950 p-3 rounded-xl border border-slate-200 dark:border-slate-800 text-center">
                  <span className="text-[10px] font-bold text-slate-500 uppercase">Rank</span>
                  <div className="text-xl font-black text-indigo-600 dark:text-indigo-400 font-mono">
                    #{inspectModalRecord.rank}
                  </div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-950 p-3 rounded-xl border border-slate-200 dark:border-slate-800 text-center">
                  <span className="text-[10px] font-bold text-slate-500 uppercase">Total Score</span>
                  <div className="text-xl font-black text-slate-900 dark:text-white font-mono">
                    {formatKpiNumber(inspectModalRecord.totalScore)}
                  </div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-950 p-3 rounded-xl border border-slate-200 dark:border-slate-800 text-center">
                  <span className="text-[10px] font-bold text-slate-500 uppercase">Bonus / Penalty</span>
                  <div className="text-sm font-mono font-bold mt-1">
                    <span className="text-emerald-600">+{formatKpiNumber(inspectModalRecord.bonus, '0.00')}</span>
                    {' / '}
                    <span className="text-rose-600">-{formatKpiNumber(inspectModalRecord.penalty, '0.00')}</span>
                  </div>
                </div>
              </div>

              {/* Category Matrix */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">Productivity</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(inspectModalRecord.productivityScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectModalRecord.targetProductivity)} | Actual: {formatKpiNumber(inspectModalRecord.actualProductivity)}</div>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">Quality</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(inspectModalRecord.qualityScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectModalRecord.targetQuality)} | Actual: {formatKpiNumber(inspectModalRecord.actualQuality)}</div>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">Attendance</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(inspectModalRecord.attendanceScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectModalRecord.targetAttendance)} | Actual: {formatKpiNumber(inspectModalRecord.actualAttendance)}</div>
                </div>
                <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">
                  <div className="font-bold text-slate-700 dark:text-slate-300">APT</div>
                  <div className="text-slate-500 mt-1">Score: <span className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(inspectModalRecord.aptScore)}</span></div>
                  <div className="text-[11px] text-slate-400">Target: {formatKpiNumber(inspectModalRecord.targetAPT)} | Actual: {formatKpiNumber(inspectModalRecord.actualAPT)}</div>
                </div>
              </div>

              {inspectModalRecord.comments && (
                <div className="p-3 bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl text-xs">
                  <span className="font-bold text-indigo-700 dark:text-indigo-400">Comments:</span>
                  <p className="text-slate-600 dark:text-slate-300 mt-0.5">{inspectModalRecord.comments}</p>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
      {/* Delete Confirmation Modal */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-[425px] p-6 bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-3xl">
          <DialogHeader className="mb-4">
            <DialogTitle className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Trash2 className="text-rose-500" size={24} />
              Confirm Deletion
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-500 dark:text-slate-400 mt-2">
              {deleteConfig.mode === 'single'
                ? `Are you sure you want to delete the KPI scorecard for "${deleteConfig.name}"?`
                : `Are you sure you want to delete the ${selectedDocIds.length} selected KPI scorecard(s)?`}
              {' '}This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="rounded-xl"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={executeDelete}
              className="bg-rose-600 hover:bg-rose-500 text-white rounded-xl shadow-sm font-bold"
            >
              Yes, Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
