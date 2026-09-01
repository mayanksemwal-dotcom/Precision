import React, { useState, useEffect, useMemo } from 'react';
import { 
  Trophy, 
  Award, 
  BarChart3, 
  Clock, 
  ShieldCheck, 
  Calendar, 
  MessageSquare, 
  History, 
  RefreshCw, 
  TrendingUp, 
  CheckCircle,
  AlertCircle,
  DollarSign,
  ChevronDown,
  Database,
  Search,
  Filter,
  Eye,
  FileSpreadsheet,
  Layers,
  X
} from 'lucide-react';
import { KPIScorecard, UserProfile } from '../../types';
import { DailyKpiRecord } from '../../types/kpiArchive';
import { fetchEmployeeKpiScorecards } from '../../services/kpiService';
import { fetchEmployeeDailyKpiRecords, exportDailyKpiToExcel } from '../../services/kpiArchiveService';
import { formatPeriodForDisplay, formatKpiNumber, extractYearMonth, standardizeReportingDate } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { DocumentSnapshot } from 'firebase/firestore';
import { toast } from 'sonner';

interface EmployeeKpiDashboardProps {
  user: UserProfile;
}

export default function EmployeeKpiDashboard({ user }: EmployeeKpiDashboardProps) {
  const [scorecards, setScorecards] = useState<KPIScorecard[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedScorecardId, setSelectedScorecardId] = useState<string>('');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('');

  // Daily Archive State
  const [showDailyDetails, setShowDailyDetails] = useState(false);
  const [dailyRecords, setDailyRecords] = useState<DailyKpiRecord[]>([]);
  const [loadingDaily, setLoadingDaily] = useState(false);
  const [dailySearch, setDailySearch] = useState('');
  const [dailyDateFilter, setDailyDateFilter] = useState('');
  const [teamLeadFilter, setTeamLeadFilter] = useState('');
  const [managerFilter, setManagerFilter] = useState('');
  const [dailyPageSize, setDailyPageSize] = useState<number>(30);
  const [dailyLastDoc, setDailyLastDoc] = useState<DocumentSnapshot | undefined>(undefined);
  const [dailyHasMore, setDailyHasMore] = useState(false);
  const [inspectDailyRecord, setInspectDailyRecord] = useState<DailyKpiRecord | null>(null);

  const loadData = async (forceServer: boolean = false) => {
    const roleStr = String(user?.role || '').toUpperCase().trim();
    setLoading(true);
    try {
      const records = await fetchEmployeeKpiScorecards(user.uid, user.email, forceServer, roleStr);
      setScorecards(records);
      if (records.length > 0) {
        setSelectedScorecardId(prev => (prev && records.some(r => r.id === prev) ? prev : records[0].id));
        setSelectedPeriod(prev => (prev && records.some(r => r.reportingPeriod === prev) ? prev : records[0].reportingPeriod));
      }
    } catch (err) {
      console.error('Error loading employee KPI scorecards:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user.uid, user.email]);

  const currentRecord = useMemo(() => {
    return scorecards.find(s => s.id === selectedScorecardId) || 
           scorecards.find(s => s.reportingPeriod === selectedPeriod) || 
           scorecards[0];
  }, [scorecards, selectedScorecardId, selectedPeriod]);

  const historyHeaders = useMemo(() => {
    const sampleRecord = currentRecord || scorecards.find(s => s.kpiNameProductivity || s.kpiNameQuality || s.kpiNameAttendance || s.kpiNameAPT);
    return {
      productivity: sampleRecord?.kpiNameProductivity || 'Productivity',
      quality: sampleRecord?.kpiNameQuality || 'Quality',
      attendance: sampleRecord?.kpiNameAttendance || 'Attendance',
      apt: sampleRecord?.kpiNameAPT || 'APT'
    };
  }, [scorecards, currentRecord]);

  const activeMetrics = useMemo(() => {
    if (!currentRecord) {
      return { productivity: true, quality: true, attendance: true, apt: true, count: 4 };
    }
    const checkActive = (name?: string, target?: any, actual?: any, score?: number) => {
      if (!name) return false;
      const isPlaceholder = (target === '-' || target === undefined || target === null || target === '') && 
                            (actual === '-' || actual === undefined || actual === null || actual === '') && 
                            (score === undefined || score === 0);
      return !isPlaceholder;
    };
    const prod = checkActive(
      currentRecord.kpiNameProductivity || 'Productivity',
      currentRecord.targetProductivity,
      currentRecord.actualProductivity,
      currentRecord.productivityScore
    );
    const qual = checkActive(
      currentRecord.kpiNameQuality || 'Quality',
      currentRecord.targetQuality,
      currentRecord.actualQuality,
      currentRecord.qualityScore
    );
    const att = checkActive(
      currentRecord.kpiNameAttendance || 'Attendance',
      currentRecord.targetAttendance,
      currentRecord.actualAttendance,
      currentRecord.attendanceScore
    );
    const apt = checkActive(
      currentRecord.kpiNameAPT || 'APT',
      currentRecord.targetAPT,
      currentRecord.actualAPT,
      currentRecord.aptScore
    );
    const count = (prod ? 1 : 0) + (qual ? 1 : 0) + (att ? 1 : 0) + (apt ? 1 : 0);
    if (count === 0) {
      return { productivity: true, quality: true, attendance: false, apt: false, count: 2 };
    }
    return { productivity: prod, quality: qual, attendance: att, apt, count };
  }, [currentRecord]);

  // Robustly extract standard YYYY-MM from reportingPeriod or active date filter
  const targetYearMonth = useMemo(() => {
    if (dailyDateFilter) {
      const std = standardizeReportingDate(dailyDateFilter);
      if (std && /^\d{4}-\d{2}/.test(std)) {
        return std.substring(0, 7);
      }
    }
    const activePeriod = currentRecord?.reportingPeriod || selectedPeriod;
    if (activePeriod) {
      return extractYearMonth(activePeriod);
    }
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, [currentRecord?.reportingPeriod, selectedPeriod, dailyDateFilter]);

  // Load Daily records on demand
  const handleLoadDailyRecords = async (isReset: boolean = true) => {
    setLoadingDaily(true);
    try {
      const cursor = isReset ? undefined : dailyLastDoc;
      const stdDate = dailyDateFilter ? standardizeReportingDate(dailyDateFilter) : undefined;
      const queryMonth = (stdDate && /^\d{4}-\d{2}/.test(stdDate)) ? stdDate.substring(0, 7) : targetYearMonth;

      const res = await fetchEmployeeDailyKpiRecords(
        queryMonth,
        user.uid,
        {
          reportingDate: stdDate || dailyDateFilter || undefined,
          search: dailySearch,
          teamLeadName: teamLeadFilter || undefined,
          managerName: managerFilter || undefined
        },
        dailyPageSize,
        cursor,
        user.email
      );

      if (isReset) {
        setDailyRecords(res.records);
      } else {
        setDailyRecords(prev => [...prev, ...res.records]);
      }
      setDailyLastDoc(res.lastDoc);
      setDailyHasMore(res.hasMore);
    } catch (err) {
      console.error('Error fetching employee daily KPI records:', err);
      toast.error('Failed to load day-wise KPI records.');
    } finally {
      setLoadingDaily(false);
    }
  };

  // When target month changes or daily drawer is opened, re-fetch daily data
  useEffect(() => {
    if (showDailyDetails) {
      handleLoadDailyRecords(true);
    }
  }, [targetYearMonth, showDailyDetails]);

  const handleClearDailyFilters = () => {
    setDailySearch('');
    setDailyDateFilter('');
    setTeamLeadFilter('');
    setManagerFilter('');
    setTimeout(() => {
      handleLoadDailyRecords(true);
    }, 0);
  };

  const getScoreBadgeColor = (score: number) => {
    if (score >= 90) return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20';
    if (score >= 75) return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';
    return 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20';
  };

  const handleExportDaily = () => {
    if (dailyRecords.length === 0) {
      toast.error('No daily records to export.');
      return;
    }
    exportDailyKpiToExcel(dailyRecords, `My_Daily_KPI_${targetYearMonth}.xlsx`);
    toast.success('Exported daily records.');
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3 text-slate-500">
        <RefreshCw size={28} className="animate-spin text-indigo-600" />
        <p className="text-xs font-semibold">Loading your KPI scorecard...</p>
      </div>
    );
  }

  if (scorecards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] p-8 text-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl">
        <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-500 flex items-center justify-center mb-4">
          <Award size={32} />
        </div>
        <h3 className="font-bold text-slate-900 dark:text-white text-base">No KPI Scorecards Found</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mt-1">
          Your supervisor or MIS manager has not published KPI scorecard reports for your profile yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto w-full">
      {/* Header Banner */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 md:p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-indigo-600 text-white font-extrabold flex items-center justify-center text-lg shadow-md shadow-indigo-500/20 shrink-0">
            {user.fullName ? user.fullName[0].toUpperCase() : 'U'}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-black text-slate-900 dark:text-white">
                {user.fullName || user.name || user.email}
              </h2>
              <span className="px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-mono text-[10px] font-bold uppercase">
                {currentRecord?.role || user.role}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Process: <span className="font-semibold text-slate-700 dark:text-slate-300">{currentRecord?.process || user.process || 'Operations'}</span> • Email: <span className="font-mono">{user.email}</span>
            </p>
          </div>
        </div>

        {/* Reporting Period Selector & Daily Toggle */}
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800">
            <Calendar size={15} className="text-slate-400" />
            <span className="text-xs font-bold text-slate-600 dark:text-slate-400">Monthly Period:</span>
            <select
              value={currentRecord?.id || ''}
              onChange={(e) => {
                const s = scorecards.find(sc => sc.id === e.target.value);
                if (s) {
                  setSelectedScorecardId(s.id);
                  setSelectedPeriod(s.reportingPeriod);
                }
              }}
              className="bg-transparent text-xs font-bold text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
            >
              {scorecards.map((s) => (
                <option key={s.id} value={s.id} className="text-slate-900 dark:text-slate-100">
                  {formatPeriodForDisplay(s.reportingPeriod)} {s.process ? `• ${s.process}` : ''}
                </option>
              ))}
            </select>
          </div>

          <Button
            onClick={() => setShowDailyDetails(!showDailyDetails)}
            variant={showDailyDetails ? 'default' : 'outline'}
            size="sm"
            className={`text-xs font-bold gap-2 rounded-xl transition-all ${
              showDailyDetails 
                ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md' 
                : 'border-indigo-200 dark:border-indigo-900 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50'
            }`}
          >
            <Database size={14} />
            <span>{showDailyDetails ? 'Hide Daily Details' : 'View Daily Details'}</span>
          </Button>
        </div>
      </div>

      {/* MONTHLY SUMMARY METRICS ROW */}
      {currentRecord && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {/* 🏆 Process Rank */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">🏆 Process Rank</span>
                <Award size={18} className="text-indigo-500" />
              </div>
              <div className="mt-2">
                <span className="text-2xl font-black font-mono tracking-tight text-slate-900 dark:text-white">
                  #{currentRecord.processRank ?? '-'}
                </span>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">{currentRecord.process}</p>
              </div>
            </div>

            {/* 👥 Role Rank */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">👥 Role Rank</span>
                <Trophy size={18} className="text-blue-500" />
              </div>
              <div className="mt-2">
                <span className="text-2xl font-black font-mono tracking-tight text-slate-900 dark:text-white">
                  #{currentRecord.roleRank ?? '-'}
                </span>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">{currentRecord.role}</p>
              </div>
            </div>

            {/* 🌍 Organization Rank */}
            <div className="bg-gradient-to-br from-indigo-900 to-slate-900 text-white rounded-2xl p-4 border border-indigo-800/50 shadow-md relative overflow-hidden flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-indigo-300 uppercase tracking-wider">🌍 Organization Rank</span>
                <Trophy size={18} className="text-amber-400" />
              </div>
              <div className="mt-2">
                <span className="text-2xl font-black font-mono tracking-tight text-white">
                  #{currentRecord.organizationRank ?? currentRecord.rank ?? '-'}
                </span>
                <p className="text-[11px] text-indigo-200 mt-0.5">Global Rank</p>
              </div>
            </div>

            {/* Total Score */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Monthly Score</span>
                <Award size={18} className="text-indigo-500 shrink-0" />
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-black font-mono text-slate-900 dark:text-white">
                    {formatKpiNumber(currentRecord.totalScore)}
                  </span>
                  <span className="text-xs font-bold text-slate-400">/ 100</span>
                </div>
                <div className="flex items-center">
                  <span className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-bold border whitespace-nowrap leading-none ${getScoreBadgeColor(Number(currentRecord.totalScore))}`}>
                    {currentRecord.kpiRating || (Number(currentRecord.totalScore) >= 90 ? 'Outstanding' : Number(currentRecord.totalScore) >= 75 ? 'Satisfactory' : 'Needs Focus')}
                  </span>
                </div>
              </div>
            </div>

            {/* Bonus / Penalty */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Bonus / Penalty</span>
                <TrendingUp size={18} className="text-emerald-500" />
              </div>
              <div className="mt-2 flex items-center gap-2 font-mono text-lg font-black">
                <span className="text-emerald-600 dark:text-emerald-400">+{formatKpiNumber(currentRecord.bonus, '0.00')}</span>
                <span className="text-slate-300">/</span>
                <span className="text-rose-600 dark:text-rose-400">-{formatKpiNumber(currentRecord.penalty, '0.00')}</span>
              </div>
            </div>
          </div>

          {/* DAY-WISE KPI ARCHIVE EXPLORER SECTION (COLLAPSIBLE / TOGGLEABLE) */}
          {showDailyDetails && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border-2 border-indigo-200 dark:border-indigo-900/60 shadow-lg flex flex-col gap-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                    <Database size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-900 dark:text-white flex flex-wrap items-center gap-2">
                      <span>Day-Wise KPI Breakdown</span>
                      <span className="font-mono text-xs text-indigo-600 dark:text-indigo-400 font-bold bg-indigo-50 dark:bg-indigo-950 px-2.5 py-0.5 rounded-md border border-indigo-200 dark:border-indigo-900">
                        {formatPeriodForDisplay(targetYearMonth)} ({targetYearMonth})
                      </span>
                      {dailyDateFilter && (
                        <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-950 px-2 py-0.5 rounded-md border border-emerald-200 dark:border-emerald-900 flex items-center gap-1">
                          <span>Filtered Date: {standardizeReportingDate(dailyDateFilter) || dailyDateFilter}</span>
                          <button 
                            onClick={() => { 
                              setDailyDateFilter(''); 
                              setTimeout(() => handleLoadDailyRecords(true), 0); 
                            }} 
                            className="hover:text-emerald-800 ml-1"
                            title="Clear date filter"
                          >
                            <X size={12} />
                          </button>
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-slate-500">
                      View your daily performance breakdown and supervisor remarks for this period.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleExportDaily}
                    disabled={dailyRecords.length === 0}
                    variant="outline"
                    size="sm"
                    className="text-xs gap-1.5"
                  >
                    <FileSpreadsheet size={14} />
                    <span>Export My Days</span>
                  </Button>

                  <Button
                    onClick={() => handleLoadDailyRecords(true)}
                    disabled={loadingDaily}
                    size="sm"
                    className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold gap-1.5"
                  >
                    <RefreshCw size={13} className={loadingDaily ? 'animate-spin' : ''} />
                    <span>Refresh</span>
                  </Button>
                </div>
              </div>

              {/* Daily Filters */}
              <div className="flex flex-wrap gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input
                    placeholder="Search process, remarks..."
                    value={dailySearch}
                    onChange={(e) => setDailySearch(e.target.value)}
                    className="pl-8 h-8 text-xs rounded-xl bg-slate-50 dark:bg-slate-950"
                  />
                </div>

                <div className="w-[140px]">
                  <Input
                    type="date"
                    value={dailyDateFilter}
                    onChange={(e) => setDailyDateFilter(e.target.value)}
                    placeholder="Specific Date"
                    className="h-8 text-xs rounded-xl bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>

                <div className="w-[140px]">
                  <Input
                    placeholder="Team Lead..."
                    value={teamLeadFilter}
                    onChange={(e) => setTeamLeadFilter(e.target.value)}
                    className="h-8 text-xs rounded-xl bg-slate-50 dark:bg-slate-950"
                  />
                </div>

                <div className="w-[140px]">
                  <Input
                    placeholder="Manager..."
                    value={managerFilter}
                    onChange={(e) => setManagerFilter(e.target.value)}
                    className="h-8 text-xs rounded-xl bg-slate-50 dark:bg-slate-950"
                  />
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={() => handleLoadDailyRecords(true)}
                    size="sm"
                    className="h-8 text-xs font-bold bg-slate-800 hover:bg-slate-700 text-white rounded-xl"
                  >
                    Filter
                  </Button>

                  {(dailyDateFilter || dailySearch || teamLeadFilter || managerFilter) && (
                    <Button
                      onClick={handleClearDailyFilters}
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs font-bold text-slate-600 hover:text-slate-900 border-slate-300 dark:border-slate-700 rounded-xl gap-1.5"
                    >
                      <X size={13} />
                      <span>Clear</span>
                    </Button>
                  )}
                </div>
              </div>

              {/* Daily Table */}
              {loadingDaily && dailyRecords.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 gap-2 text-slate-500">
                  <RefreshCw size={24} className="animate-spin text-indigo-600" />
                  <p className="text-xs font-semibold">Loading daily records from archive...</p>
                </div>
              ) : dailyRecords.length === 0 ? (
                <div className="p-8 text-center bg-slate-50 dark:bg-slate-950 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 flex flex-col items-center justify-center gap-3">
                  <Database size={28} className="text-slate-300 mb-0.5" />
                  <div>
                    <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      No Day-Wise Records Found for {formatPeriodForDisplay(targetYearMonth)} ({targetYearMonth})
                    </p>
                    <p className="text-[11px] text-slate-500 mt-0.5 max-w-md">
                      {dailyDateFilter 
                        ? `No daily records matched date "${standardizeReportingDate(dailyDateFilter) || dailyDateFilter}". Try clearing your filter or selecting another month.`
                        : 'No individual daily logs have been published for this employee in this archive partition.'}
                    </p>
                  </div>
                  {dailyDateFilter && (
                    <Button
                      onClick={handleClearDailyFilters}
                      variant="outline"
                      size="sm"
                      className="text-xs font-bold gap-1.5"
                    >
                      <X size={12} />
                      <span>Clear Date Filter</span>
                    </Button>
                  )}
                </div>
              ) : (
                <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs">
                  <div className="overflow-auto max-h-[500px]">
                    <Table>
                      <TableHeader className="bg-slate-50 dark:bg-slate-950">
                        <TableRow className="text-[11px]">
                          <TableHead className="font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">Date</TableHead>
                          <TableHead className="font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">Process</TableHead>
                          <TableHead className="font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">Role</TableHead>
                          <TableHead className="font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">Total Score</TableHead>
                          {activeMetrics.productivity && <TableHead className="font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">{historyHeaders.productivity}</TableHead>}
                          {activeMetrics.quality && <TableHead className="font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">{historyHeaders.quality}</TableHead>}
                          {activeMetrics.attendance && <TableHead className="font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">{historyHeaders.attendance}</TableHead>}
                          {activeMetrics.apt && <TableHead className="font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">{historyHeaders.apt}</TableHead>}
                          <TableHead className="font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">Bonus / Penalty</TableHead>
                          <TableHead className="text-right font-bold sticky top-0 z-10 bg-slate-50 dark:bg-slate-950">Details</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {dailyRecords.map((dRec, idx) => (
                          <TableRow key={`${dRec.employeeUid || ''}_${dRec.reportingDate}_${dRec.process}_${dRec.id}_${idx}`} className="text-xs hover:bg-slate-50 dark:hover:bg-slate-800/50">
                            <TableCell className="font-mono font-bold text-slate-900 dark:text-white">
                              {dRec.reportingDate}
                            </TableCell>
                            <TableCell className="font-medium">{dRec.process}</TableCell>
                            <TableCell className="text-[10px] text-slate-500 uppercase font-bold">{dRec.role}</TableCell>
                            <TableCell className="font-mono font-extrabold text-indigo-600 dark:text-indigo-400">
                              {formatKpiNumber(dRec.totalScore)}
                            </TableCell>
                            {activeMetrics.productivity && (
                              <TableCell className="font-mono text-xs">
                                <div className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(dRec.productivityScore)}</div>
                                <div className="text-[10px] text-indigo-600 dark:text-indigo-400 font-sans font-medium mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]" title={dRec.kpiNameProductivity || 'Productivity'}>
                                  {dRec.kpiNameProductivity || 'Productivity'}
                                </div>
                                <div className="text-[9px] text-slate-400 dark:text-slate-500 font-sans mt-0.5">
                                  T: {dRec.targetProductivity} | A: {dRec.actualProductivity}
                                </div>
                              </TableCell>
                            )}
                            {activeMetrics.quality && (
                              <TableCell className="font-mono text-xs">
                                <div className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(dRec.qualityScore)}</div>
                                <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-sans font-medium mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]" title={dRec.kpiNameQuality || 'Quality'}>
                                  {dRec.kpiNameQuality || 'Quality'}
                                </div>
                                <div className="text-[9px] text-slate-400 dark:text-slate-500 font-sans mt-0.5">
                                  T: {dRec.targetQuality} | A: {dRec.actualQuality}
                                </div>
                              </TableCell>
                            )}
                            {activeMetrics.attendance && (
                              <TableCell className="font-mono text-xs">
                                <div className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(dRec.attendanceScore)}</div>
                                <div className="text-[10px] text-amber-600 dark:text-amber-400 font-sans font-medium mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]" title={dRec.kpiNameAttendance || 'Attendance'}>
                                  {dRec.kpiNameAttendance || 'Attendance'}
                                </div>
                                <div className="text-[9px] text-slate-400 dark:text-slate-500 font-sans mt-0.5">
                                  T: {dRec.targetAttendance} | A: {dRec.actualAttendance}
                                </div>
                              </TableCell>
                            )}
                            {activeMetrics.apt && (
                              <TableCell className="font-mono text-xs">
                                <div className="font-bold text-slate-800 dark:text-slate-200">{formatKpiNumber(dRec.aptScore)}</div>
                                <div className="text-[10px] text-blue-600 dark:text-blue-400 font-sans font-medium mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]" title={dRec.kpiNameAPT || 'APT'}>
                                  {dRec.kpiNameAPT || 'APT'}
                                </div>
                                <div className="text-[9px] text-slate-400 dark:text-slate-500 font-sans mt-0.5">
                                  T: {dRec.targetAPT} | A: {dRec.actualAPT}
                                </div>
                              </TableCell>
                            )}
                            <TableCell className="font-mono text-[11px]">
                              <span className="text-emerald-600 font-bold">+{formatKpiNumber(dRec.bonus, '0.00')}</span>
                              {' / '}
                              <span className="text-rose-600 font-bold">-{formatKpiNumber(dRec.penalty, '0.00')}</span>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                onClick={() => setInspectDailyRecord(dRec)}
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-indigo-600 hover:text-indigo-700"
                              >
                                <Eye size={13} />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-4 pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 font-medium">Page Size:</span>
                  <select
                    className="text-xs font-bold bg-slate-50 dark:bg-slate-950 rounded-lg p-1 border border-slate-200 dark:border-slate-800 focus:outline-none"
                    value={dailyPageSize}
                    onChange={(e) => {
                      setDailyPageSize(Number(e.target.value));
                      setTimeout(() => handleLoadDailyRecords(true), 0);
                    }}
                  >
                    <option value={30}>30</option>
                    <option value={60}>60</option>
                    <option value={90}>90</option>
                  </select>
                </div>
                {dailyHasMore && (
                  <Button
                    onClick={() => handleLoadDailyRecords(false)}
                    disabled={loadingDaily}
                    variant="outline"
                    size="sm"
                    className="text-xs font-bold rounded-xl"
                  >
                    Load More Days
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Category-Wise Scores Breakdown Grid */}
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">
              Category Wise Scores Breakdown (Monthly Consolidated)
            </h3>
            <div className={`grid grid-cols-1 ${
              activeMetrics.count === 1 ? 'md:grid-cols-1' :
              activeMetrics.count === 2 ? 'md:grid-cols-2' :
              activeMetrics.count === 3 ? 'md:grid-cols-3' :
              'md:grid-cols-2 lg:grid-cols-4'
            } gap-4`}>
              {/* Productivity Card */}
              {activeMetrics.productivity && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-700 dark:text-slate-300">{historyHeaders.productivity}</span>
                    <span className="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-mono text-xs font-extrabold">
                      {formatKpiNumber(currentRecord.productivityScore)} Score
                    </span>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between text-slate-500">
                      <span>Target:</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{formatKpiNumber(currentRecord.targetProductivity)}</span>
                    </div>
                    <div className="flex justify-between text-slate-500">
                      <span>Actual:</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{formatKpiNumber(currentRecord.actualProductivity)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Quality Card */}
              {activeMetrics.quality && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-700 dark:text-slate-300">{historyHeaders.quality}</span>
                    <span className="px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 font-mono text-xs font-extrabold">
                      {formatKpiNumber(currentRecord.qualityScore)} Score
                    </span>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between text-slate-500">
                      <span>Target:</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{formatKpiNumber(currentRecord.targetQuality)}</span>
                    </div>
                    <div className="flex justify-between text-slate-500">
                      <span>Actual:</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{formatKpiNumber(currentRecord.actualQuality)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Attendance Card */}
              {activeMetrics.attendance && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-700 dark:text-slate-300">{historyHeaders.attendance}</span>
                    <span className="px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-mono text-xs font-extrabold">
                      {formatKpiNumber(currentRecord.attendanceScore)} Score
                    </span>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between text-slate-500">
                      <span>Target:</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{formatKpiNumber(currentRecord.targetAttendance)}</span>
                    </div>
                    <div className="flex justify-between text-slate-500">
                      <span>Actual:</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{formatKpiNumber(currentRecord.actualAttendance)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* APT Card */}
              {activeMetrics.apt && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-700 dark:text-slate-300">{historyHeaders.apt}</span>
                    <span className="px-2 py-0.5 rounded-full bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 font-mono text-xs font-extrabold">
                      {formatKpiNumber(currentRecord.aptScore)} Score
                    </span>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between text-slate-500">
                      <span>Target:</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{formatKpiNumber(currentRecord.targetAPT)}</span>
                    </div>
                    <div className="flex justify-between text-slate-500">
                      <span>Actual:</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{formatKpiNumber(currentRecord.actualAPT)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Supervisor / Reviewer Comments */}
          {currentRecord.comments && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300">
                <MessageSquare size={16} className="text-indigo-500" />
                <span>Supervisor Remarks & Comments</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-950 p-3.5 rounded-xl border border-slate-100 dark:border-slate-800 italic leading-relaxed">
                "{currentRecord.comments}"
              </p>
            </div>
          )}

          {/* Historical Scorecard Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-extrabold text-slate-900 dark:text-white">
                <History size={16} className="text-indigo-500" />
                <span>Previous Monthly KPI History</span>
              </div>
              <span className="text-xs text-slate-500 font-medium">
                Showing {scorecards.length} period(s)
              </span>
            </div>

            <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-auto max-h-[400px]">
              <Table>
                <TableHeader className="bg-slate-50 dark:bg-slate-950 sticky top-0 z-10 shadow-xs">
                  <TableRow className="text-[11px] bg-slate-50 dark:bg-slate-950">
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Period</TableHead>
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Total Score</TableHead>
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Process Rank</TableHead>
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Role Rank</TableHead>
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Org Rank</TableHead>
                    {activeMetrics.productivity && <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">{historyHeaders.productivity}</TableHead>}
                    {activeMetrics.quality && <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">{historyHeaders.quality}</TableHead>}
                    {activeMetrics.attendance && <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">{historyHeaders.attendance}</TableHead>}
                    {activeMetrics.apt && <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">{historyHeaders.apt}</TableHead>}
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Bonus / Penalty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scorecards.map((sc) => (
                    <TableRow
                      key={sc.id}
                      onClick={() => setSelectedPeriod(sc.reportingPeriod)}
                      className={`text-xs cursor-pointer transition-colors ${
                        sc.reportingPeriod === selectedPeriod
                          ? 'bg-indigo-50/60 dark:bg-indigo-950/30 font-semibold'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <TableCell className="font-mono font-bold text-slate-900 dark:text-white">
                        {formatPeriodForDisplay(sc.reportingPeriod)}
                      </TableCell>
                      <TableCell className="font-bold font-mono text-indigo-600 dark:text-indigo-400">
                        {formatKpiNumber(sc.totalScore)}
                      </TableCell>
                      <TableCell className="font-mono font-bold text-slate-700 dark:text-slate-300">
                        #{sc.processRank ?? '-'}
                      </TableCell>
                      <TableCell className="font-mono font-bold text-slate-700 dark:text-slate-300">
                        #{sc.roleRank ?? '-'}
                      </TableCell>
                      <TableCell className="font-mono font-bold text-amber-600 dark:text-amber-400">
                        #{sc.organizationRank ?? sc.rank ?? '-'}
                      </TableCell>
                      {activeMetrics.productivity && (
                        <TableCell className="text-slate-600 dark:text-slate-400">
                          {formatKpiNumber(sc.productivityScore)} ({formatKpiNumber(sc.actualProductivity)})
                        </TableCell>
                      )}
                      {activeMetrics.quality && (
                        <TableCell className="text-slate-600 dark:text-slate-400">
                          {formatKpiNumber(sc.qualityScore)} ({formatKpiNumber(sc.actualQuality)})
                        </TableCell>
                      )}
                      {activeMetrics.attendance && (
                        <TableCell className="text-slate-600 dark:text-slate-400">
                          {formatKpiNumber(sc.attendanceScore)} ({formatKpiNumber(sc.actualAttendance)})
                        </TableCell>
                      )}
                      {activeMetrics.apt && (
                        <TableCell className="text-slate-600 dark:text-slate-400">
                          {formatKpiNumber(sc.aptScore)} ({formatKpiNumber(sc.actualAPT)})
                        </TableCell>
                      )}
                      <TableCell className="font-mono text-[11px]">
                        <span className="text-emerald-600 dark:text-emerald-400">+{formatKpiNumber(sc.bonus, '0.00')}</span>
                        {' / '}
                        <span className="text-rose-600 dark:text-rose-400">-{formatKpiNumber(sc.penalty, '0.00')}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}

      {/* Inspect Daily Record Dialog */}
      {inspectDailyRecord && (
        <Dialog open={!!inspectDailyRecord} onOpenChange={(o) => !o && setInspectDailyRecord(null)}>
          <DialogContent className="max-w-lg bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-6 rounded-3xl">
            <DialogHeader className="border-b border-slate-100 dark:border-slate-800 pb-3">
              <DialogTitle className="text-base font-bold text-slate-900 dark:text-white flex items-center justify-between">
                <span>Daily KPI Record</span>
                <span className="font-mono text-xs px-2.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 font-bold">
                  {inspectDailyRecord.reportingDate}
                </span>
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-500 mt-0.5">
                Process: {inspectDailyRecord.process} • Role: {inspectDailyRecord.role}
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 flex flex-col gap-3">
              <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-800 text-center">
                <span className="text-[10px] font-bold text-slate-400 uppercase">Daily Total Score</span>
                <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400 font-mono mt-1">
                  {formatKpiNumber(inspectDailyRecord.totalScore)} / 100
                </div>
              </div>

              <div className={`grid ${activeMetrics.count <= 2 ? 'grid-cols-1' : 'grid-cols-2'} gap-2 text-xs`}>
                {activeMetrics.productivity && (
                  <div className="p-2.5 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-100 dark:border-slate-800">
                    <div className="font-bold text-slate-700 dark:text-slate-300">{historyHeaders.productivity}</div>
                    <div className="text-slate-500 font-mono">Score: {formatKpiNumber(inspectDailyRecord.productivityScore)}</div>
                  </div>
                )}
                {activeMetrics.quality && (
                  <div className="p-2.5 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-100 dark:border-slate-800">
                    <div className="font-bold text-slate-700 dark:text-slate-300">{historyHeaders.quality}</div>
                    <div className="text-slate-500 font-mono">Score: {formatKpiNumber(inspectDailyRecord.qualityScore)}</div>
                  </div>
                )}
                {activeMetrics.attendance && (
                  <div className="p-2.5 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-100 dark:border-slate-800">
                    <div className="font-bold text-slate-700 dark:text-slate-300">{historyHeaders.attendance}</div>
                    <div className="text-slate-500 font-mono">Score: {formatKpiNumber(inspectDailyRecord.attendanceScore)}</div>
                  </div>
                )}
                {activeMetrics.apt && (
                  <div className="p-2.5 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-100 dark:border-slate-800">
                    <div className="font-bold text-slate-700 dark:text-slate-300">{historyHeaders.apt}</div>
                    <div className="text-slate-500 font-mono">Score: {formatKpiNumber(inspectDailyRecord.aptScore)}</div>
                  </div>
                )}
              </div>

              {inspectDailyRecord.comments && (
                <div className="p-3 bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl text-xs">
                  <span className="font-bold text-indigo-700 dark:text-indigo-400">Supervisor Remarks:</span>
                  <p className="text-slate-600 dark:text-slate-300 mt-0.5">{inspectDailyRecord.comments}</p>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
