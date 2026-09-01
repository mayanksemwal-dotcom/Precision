import React, { useState, useEffect, useMemo } from 'react';
import { 
  Trophy, 
  Users, 
  BarChart3, 
  Database,
  Award,
  Filter,
  Search,
  RefreshCw,
  Calendar,
  Layers,
  ChevronDown
} from 'lucide-react';
import { UserProfile, UserRole, KPIScorecard } from '../../types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import KpiScorecardTableModule from './KpiScorecardTableModule';
import ManagerDailyArchiveExplorer from './ManagerDailyArchiveExplorer';
import { fetchAllKpiScorecards, fetchKpiMetadata } from '../../services/kpiService';
import { formatPeriodForDisplay, formatKpiNumber } from '../../lib/utils';
import { toast } from 'sonner';

interface ManagerKpiDashboardProps {
  user: UserProfile;
  roster: UserProfile[];
}

export default function ManagerKpiDashboard({ user, roster }: ManagerKpiDashboardProps) {
  // Active Tab: scorecards (Monthly), dailyArchive (Daily Partition), leaderboards
  const [activeTab, setActiveTab] = useState<'scorecards' | 'dailyArchive' | 'orgLeaderboard' | 'processLeaderboard' | 'roleLeaderboard'>('scorecards');

  // Leaderboard data state
  const [scorecards, setScorecards] = useState<KPIScorecard[]>([]);
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState<string>('ALL');
  const [metaOptions, setMetaOptions] = useState<{ periods: string[]; processes: string[]; roles: string[] }>({ periods: [], processes: [], roles: [] });
  const [lbSearchQuery, setLbSearchQuery] = useState('');
  const [debouncedLbSearch, setDebouncedLbSearch] = useState('');
  const [selectedProcess, setSelectedProcess] = useState<string>('ALL');
  const [selectedRole, setSelectedRole] = useState<string>('ALL');

  const userRoleStr = String(user?.role || '').toUpperCase().trim();
  const isAgentQaSme = ['AGENT', 'QA', 'SME'].includes(userRoleStr);
  const isManagerRole =
    !isAgentQaSme ||
    userRoleStr.includes('MANAGER') ||
    userRoleStr.includes('ADMIN') ||
    userRoleStr.includes('MIS') ||
    userRoleStr.includes('HR') ||
    userRoleStr.includes('LEAD') ||
    userRoleStr.includes('SUPERVISOR');

  // Guard activeTab if user does not have Leaderboard access
  useEffect(() => {
    if (!isManagerRole && (activeTab === 'orgLeaderboard' || activeTab === 'processLeaderboard' || activeTab === 'roleLeaderboard')) {
      setActiveTab('scorecards');
    }
  }, [isManagerRole, activeTab]);

  // Debounce search
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedLbSearch(lbSearchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [lbSearchQuery]);

  // Fetch metadata on mount
  useEffect(() => {
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
      console.warn('Metadata fetch error:', err);
    });
  }, []);

  // Fetch scorecards for Leaderboards
  const loadLeaderboardData = async () => {
    if (activeTab === 'scorecards' || activeTab === 'dailyArchive') return;
    setLoadingLeaderboard(true);
    try {
      const records = await fetchAllKpiScorecards(selectedPeriod, false, userRoleStr);
      setScorecards(records);
    } catch (err) {
      console.error('Error fetching leaderboard scorecards:', err);
      toast.error('Failed to load leaderboard data.');
    } finally {
      setLoadingLeaderboard(false);
    }
  };

  useEffect(() => {
    if (activeTab !== 'scorecards' && activeTab !== 'dailyArchive') {
      loadLeaderboardData();
    }
  }, [activeTab, selectedPeriod]);

  // Unique list of periods, processes, roles
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

  // Filtered leaderboard records
  const filteredLeaderboardRecords = useMemo(() => {
    return scorecards.filter(rec => {
      const q = debouncedLbSearch.toLowerCase().trim();
      const matchSearch = !q || 
        rec.employeeEmail.toLowerCase().includes(q) ||
        rec.employeeName.toLowerCase().includes(q) ||
        rec.process.toLowerCase().includes(q);

      const matchPeriod = selectedPeriod === 'ALL' || rec.reportingPeriod === selectedPeriod;
      const matchProcess = selectedProcess === 'ALL' || rec.process === selectedProcess;
      const matchRole = selectedRole === 'ALL' || rec.role === selectedRole;

      return matchSearch && matchPeriod && matchProcess && matchRole;
    });
  }, [scorecards, debouncedLbSearch, selectedPeriod, selectedProcess, selectedRole]);

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto w-full">
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
          <span>Monthly Scorecards</span>
        </button>

        <button
          onClick={() => setActiveTab('dailyArchive')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
            activeTab === 'dailyArchive'
              ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50'
          }`}
        >
          <Database size={15} />
          <span>Day-Wise KPI Archive</span>
          <span className="px-1.5 py-0.5 rounded-full text-[9px] bg-indigo-500/20 text-indigo-200 font-mono border border-indigo-400/30">
            Partitioned
          </span>
        </button>

        {isManagerRole && (
          <>
            <button
              onClick={() => setActiveTab('orgLeaderboard')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
                activeTab === 'orgLeaderboard'
                  ? 'bg-amber-600 text-white shadow-sm'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50'
              }`}
            >
              <Trophy size={15} className={activeTab === 'orgLeaderboard' ? 'text-amber-200' : 'text-amber-500'} />
              <span>Org Leaderboard</span>
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
          </>
        )}
      </div>

      {/* TAB 1: MONTHLY KPI SCORECARDS TABLE */}
      {activeTab === 'scorecards' && (
        <KpiScorecardTableModule user={user} roster={roster} />
      )}

      {/* TAB 2: DAY-WISE KPI ARCHIVE EXPLORER */}
      {activeTab === 'dailyArchive' && (
        <ManagerDailyArchiveExplorer user={user} roster={roster} />
      )}

      {/* TAB 4, 5, 6: MONTHLY LEADERBOARDS (Manager Roles Only) */}
      {isManagerRole && activeTab !== 'scorecards' && activeTab !== 'dailyArchive' && (
        <div className="flex flex-col gap-6">
          {/* Leaderboard Header Banner */}
          <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white rounded-2xl p-6 border border-indigo-900/50 shadow-md flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Trophy size={20} className="text-amber-400" />
                <h3 className="text-lg font-black tracking-tight">
                  {activeTab === 'orgLeaderboard' && 'Monthly Organization Performance Leaderboard'}
                  {activeTab === 'processLeaderboard' && 'Monthly Process Level Performance Leaderboard'}
                  {activeTab === 'roleLeaderboard' && 'Monthly Role Level Performance Leaderboard'}
                </h3>
              </div>
              <p className="text-xs text-slate-300 mt-1">
                {activeTab === 'orgLeaderboard' && 'Global ranking across all processes and roles for the published monthly period.'}
                {activeTab === 'processLeaderboard' && 'Process specific rankings computed from monthly scorecards.'}
                {activeTab === 'roleLeaderboard' && 'Role specific rankings computed from monthly scorecards.'}
              </p>
            </div>

            <Button
              onClick={loadLeaderboardData}
              disabled={loadingLeaderboard}
              variant="outline"
              size="sm"
              className="bg-white/10 hover:bg-white/20 text-white border-white/20 text-xs gap-1.5"
            >
              <RefreshCw size={13} className={loadingLeaderboard ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </Button>
          </div>

          {/* Filter Bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="relative flex-grow max-w-md">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search employee or process..."
                value={lbSearchQuery}
                onChange={(e) => setLbSearchQuery(e.target.value)}
                className="pl-9 h-9 text-xs rounded-xl bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800">
                <Calendar size={14} className="text-slate-400" />
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

              <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800">
                <Filter size={14} className="text-slate-400" />
                <span className="font-bold text-slate-500">Process:</span>
                <select
                  value={selectedProcess}
                  onChange={(e) => setSelectedProcess(e.target.value)}
                  className="bg-transparent font-bold text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  <option value="ALL">All Processes</option>
                  {uniqueProcesses.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800">
                <Users size={14} className="text-slate-400" />
                <span className="font-bold text-slate-500">Role:</span>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                  className="bg-transparent font-bold text-slate-800 dark:text-slate-200 focus:outline-none"
                >
                  <option value="ALL">All Roles</option>
                  {uniqueRoles.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Leaderboard Table List */}
          {(() => {
            const list = [...filteredLeaderboardRecords].sort((a, b) => {
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

            if (loadingLeaderboard) {
              return (
                <div className="flex flex-col items-center justify-center p-16 gap-3 text-slate-500">
                  <RefreshCw size={28} className="animate-spin text-indigo-600" />
                  <p className="text-xs font-semibold">Loading Leaderboard rankings...</p>
                </div>
              );
            }

            if (list.length === 0) {
              return (
                <div className="bg-white dark:bg-slate-900 p-12 text-center rounded-2xl border border-slate-200 dark:border-slate-800">
                  <Trophy size={32} className="mx-auto text-slate-300 mb-2" />
                  <p className="text-xs font-bold text-slate-600">No monthly scorecard records found for this leaderboard filter.</p>
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
                          <TableRow key={item.id || `${item.employeeEmail || 'emp'}_${item.reportingPeriod || ''}_${item.process || ''}_${idx}`} className="text-xs">
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
    </div>
  );
}
