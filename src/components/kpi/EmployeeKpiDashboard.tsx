import React, { useState, useEffect } from 'react';
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
  ChevronDown
} from 'lucide-react';
import { KPIScorecard, UserProfile } from '../../types';
import { fetchEmployeeKpiScorecards } from '../../services/kpiService';
import { formatPeriodForDisplay, formatKpiNumber } from '../../lib/utils';
import { Button } from '../ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

interface EmployeeKpiDashboardProps {
  user: UserProfile;
}

export default function EmployeeKpiDashboard({ user }: EmployeeKpiDashboardProps) {
  const [scorecards, setScorecards] = useState<KPIScorecard[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState<string>('');

  const loadData = async (forceServer: boolean = false) => {
    setLoading(true);
    try {
      const records = await fetchEmployeeKpiScorecards(user.uid, user.email, forceServer);
      setScorecards(records);
      if (records.length > 0) {
        setSelectedPeriod(records[0].reportingPeriod);
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

  const currentRecord = scorecards.find(s => s.reportingPeriod === selectedPeriod) || scorecards[0];

  const getScoreBadgeColor = (score: number) => {
    if (score >= 90) return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20';
    if (score >= 75) return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';
    return 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20';
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

        {/* Reporting Period Selector */}
        <div className="flex items-center gap-2 shrink-0">
          <Calendar size={16} className="text-slate-400" />
          <span className="text-xs font-bold text-slate-600 dark:text-slate-400">Reporting Period:</span>
          <select
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-bold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {scorecards.map((s) => (
              <option key={s.id} value={s.reportingPeriod}>
                {formatPeriodForDisplay(s.reportingPeriod)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {currentRecord && (
        <>
          {/* Top Summary Metrics Row */}
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
                <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Total KPI Score</span>
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

          {/* Category-Wise Scores Breakdown Grid */}
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">
              Category Wise Scores Breakdown
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Productivity Card */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-700 dark:text-slate-300">Productivity</span>
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

              {/* Quality Card */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-700 dark:text-slate-300">Quality Audit</span>
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

              {/* Attendance Card */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-700 dark:text-slate-300">Attendance</span>
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

              {/* APT Card */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-700 dark:text-slate-300">APT (Avg Handle Time)</span>
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
                <span>Previous KPI History</span>
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
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Productivity</TableHead>
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Quality</TableHead>
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">Attendance</TableHead>
                    <TableHead className="font-bold sticky top-0 bg-slate-50 dark:bg-slate-950 z-10">APT</TableHead>
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
                      <TableCell className="text-slate-600 dark:text-slate-400">
                        {formatKpiNumber(sc.productivityScore)} ({formatKpiNumber(sc.actualProductivity)})
                      </TableCell>
                      <TableCell className="text-slate-600 dark:text-slate-400">
                        {formatKpiNumber(sc.qualityScore)} ({formatKpiNumber(sc.actualQuality)})
                      </TableCell>
                      <TableCell className="text-slate-600 dark:text-slate-400">
                        {formatKpiNumber(sc.attendanceScore)} ({formatKpiNumber(sc.actualAttendance)})
                      </TableCell>
                      <TableCell className="text-slate-600 dark:text-slate-400">
                        {formatKpiNumber(sc.aptScore)} ({formatKpiNumber(sc.actualAPT)})
                      </TableCell>
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
    </div>
  );
}
