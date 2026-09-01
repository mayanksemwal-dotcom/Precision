import React, { useState, useMemo, useEffect } from 'react';
import { KPIScorecard, UserProfile } from '../../types';
import { Button } from '../ui/button';
import { 
  Sparkles, 
  Award, 
  Users, 
  UserCheck, 
  AlertTriangle, 
  Search, 
  BarChart3,
  CheckCircle2,
  Brain,
  Layers,
  MessageSquare,
  Send,
  Calendar,
  X,
  Bot,
  User,
  ChevronRight,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  HelpCircle
} from 'lucide-react';
import { toast } from 'sonner';
import { formatPeriodForDisplay } from '../../lib/utils';
import { fetchEmployeeDailyKpiRecords } from '../../services/kpiArchiveService';
import { DailyKpiRecord } from '../../types/kpiArchive';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} from 'recharts';

interface PerformanceReviewModuleProps {
  user: UserProfile;
  scorecards: KPIScorecard[];
  roster: UserProfile[];
  activePeriod?: string;
  availablePeriods?: string[];
}

export type HierarchyScope = 'ALL_LEVELS' | 'MANAGER' | 'TEAM_LEAD' | 'AGENT_QA_SME';
export type QuartileFilter = 'ALL' | 'TQ' | 'MQ' | 'BQ';

export default function PerformanceReviewModule({
  user,
  scorecards,
  roster,
  activePeriod = 'Current Month',
  availablePeriods = []
}: PerformanceReviewModuleProps) {
  // Extract all unique months/periods from scorecards + availablePeriods
  const parsedAvailablePeriods = useMemo(() => {
    const pSet = new Set<string>();
    if (availablePeriods && availablePeriods.length > 0) {
      availablePeriods.forEach(p => pSet.add(p));
    }
    scorecards.forEach(sc => {
      const periodVal = sc.reportingPeriod || (sc as any).period || (sc as any).month;
      if (periodVal) pSet.add(periodVal);
    });
    return Array.from(pSet).sort().reverse();
  }, [scorecards, availablePeriods]);

  // Month / Period Filter state - default to latest month or activePeriod
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    if (parsedAvailablePeriods.length > 0) {
      return parsedAvailablePeriods[0];
    }
    return activePeriod !== 'ALL' && activePeriod !== 'Current Period' ? activePeriod : 'ALL';
  });

  const [hierarchyScope, setHierarchyScope] = useState<HierarchyScope>('ALL_LEVELS');
  const [selectedProcess, setSelectedProcess] = useState<string>('ALL');
  const [quartileFilter, setQuartileFilter] = useState<QuartileFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Pagination state
  const [pageSize, setPageSize] = useState<number>(50);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Reset pagination on filter change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedMonth, hierarchyScope, selectedProcess, quartileFilter, searchQuery]);

  // AI Insights State
  const [aiInsights, setAiInsights] = useState<string | null>(null);
  const [generatingAi, setGeneratingAi] = useState<boolean>(false);

  // AI Assistant Chat State
  const [showAiChatDrawer, setShowAiChatDrawer] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string; timestamp: Date }>>([
    {
      role: 'assistant',
      text: `Hello ${user.name || user.email || 'Supervisor'}! I am Precision360 Operations AI. Ask me any question regarding Monthly or Daily KPI metrics, top/bottom performers, team lead comparisons, or process health.`,
      timestamp: new Date()
    }
  ]);
  const [chatInput, setChatInput] = useState<string>('');
  const [sendingChat, setSendingChat] = useState<boolean>(false);

  // Detailed Employee Breakdown state
  const [selectedEmployeeForBreakdown, setSelectedEmployeeForBreakdown] = useState<any | null>(null);
  const [activeBreakdownTab, setActiveBreakdownTab] = useState<'monthly' | 'daily'>('monthly');
  const [dailyLogs, setDailyLogs] = useState<DailyKpiRecord[]>([]);
  const [loadingDailyLogs, setLoadingDailyLogs] = useState<boolean>(false);
  const [selectedDailyMonth, setSelectedDailyMonth] = useState<string>('');

  useEffect(() => {
    if (!selectedEmployeeForBreakdown) {
      setDailyLogs([]);
      return;
    }
    
    const defaultMonth = selectedMonth !== 'ALL' 
      ? selectedMonth 
      : (selectedEmployeeForBreakdown.reportingPeriod || selectedEmployeeForBreakdown.period || parsedAvailablePeriods[0] || '');
    
    setSelectedDailyMonth(defaultMonth);
  }, [selectedEmployeeForBreakdown, selectedMonth, parsedAvailablePeriods]);

  useEffect(() => {
    if (!selectedEmployeeForBreakdown || !selectedDailyMonth) return;

    let active = true;
    async function loadDailyLogs() {
      setLoadingDailyLogs(true);
      try {
        const empUid = selectedEmployeeForBreakdown.employeeUid || '';
        const empEmail = selectedEmployeeForBreakdown.employeeEmail || '';
        
        const result = await fetchEmployeeDailyKpiRecords(
          selectedDailyMonth,
          empUid,
          undefined,
          100,
          undefined,
          empEmail
        );
        
        if (active) {
          const sorted = (result.records || []).sort((a, b) => 
            (a.reportingDate || '').localeCompare(b.reportingDate || '')
          );
          setDailyLogs(sorted);
        }
      } catch (err) {
        console.error('Error fetching daily logs:', err);
        toast.error('Failed to load daily logs for employee.');
      } finally {
        if (active) {
          setLoadingDailyLogs(false);
        }
      }
    }

    loadDailyLogs();
    return () => {
      active = false;
    };
  }, [selectedEmployeeForBreakdown, selectedDailyMonth]);

  // Extract unique processes from scorecards
  const availableProcesses = useMemo(() => {
    const procs = new Set<string>();
    scorecards.forEach(sc => {
      if (sc.process) procs.add(sc.process);
    });
    return Array.from(procs).sort();
  }, [scorecards]);

  // Helper to identify role category
  const isManagerRole = (roleStr?: string) => {
    const r = String(roleStr || '').toUpperCase();
    return (
      r.includes('MGR') ||
      r.includes('MANAGER') ||
      r.includes('OM') ||
      r.includes('AM') ||
      r.includes('DIRECTOR') ||
      r.includes('HEAD') ||
      r.includes('EXECUTIVE') ||
      r.includes('LEADER')
    );
  };

  const isTeamLeadRole = (roleStr?: string) => {
    const r = String(roleStr || '').toUpperCase();
    return (
      r.includes('LEAD') ||
      r.includes('TL') ||
      r === 'STL' ||
      r === 'OPS_TL' ||
      r === 'QTL' ||
      r === 'TRAINER_TL' ||
      r === 'SUPERVISOR'
    );
  };

  const isAgentQaSmeRole = (roleStr?: string) => {
    const r = String(roleStr || '').toUpperCase();
    return r.includes('AGENT') || r.includes('QA') || r.includes('SME');
  };

  // Map employee UID to manager name from roster if available
  const rosterMap = useMemo(() => {
    const map = new Map<string, { managerName?: string; teamLeadName?: string }>();
    roster.forEach(u => {
      map.set(u.uid, {
        managerName: u.mappedManagerName || u.managerName,
        teamLeadName: u.mappedTL || u.teamLeadName
      });
    });
    return map;
  }, [roster]);

  // Filter & classify scorecards by Month, Hierarchy, Process, and Search
  const classifiedRecords = useMemo(() => {
    // 1. Filter by selected Month, hierarchy scope, process, and search
    let filtered = scorecards.filter(sc => {
      // Month Filter logic
      if (selectedMonth !== 'ALL') {
        const scPeriod = sc.reportingPeriod || (sc as any).period || (sc as any).month;
        if (scPeriod && scPeriod !== selectedMonth) {
          return false;
        }
      }

      const role = String(sc.role || '').toUpperCase();
      
      if (hierarchyScope === 'MANAGER' && !isManagerRole(role)) return false;
      if (hierarchyScope === 'TEAM_LEAD' && (isManagerRole(role) || !isTeamLeadRole(role))) return false;
      if (hierarchyScope === 'AGENT_QA_SME' && !isAgentQaSmeRole(role)) return false;

      if (selectedProcess !== 'ALL') {
        const scProc = String(sc.process || '').toUpperCase();
        if (scProc !== selectedProcess.toUpperCase()) return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const name = String(sc.employeeName || '').toLowerCase();
        const empId = String(sc.employeeId || '').toLowerCase();
        if (!name.includes(q) && !empId.includes(q)) return false;
      }

      return true;
    });

    // Deduplicate records per employee ID if multiple exist for same month
    const seenEmpIds = new Map<string, typeof filtered[0]>();
    filtered.forEach(sc => {
      const key = `${sc.employeeId || sc.employeeUid || sc.employeeName}_${sc.reportingPeriod || (sc as any).period}`;
      if (!seenEmpIds.has(key)) {
        seenEmpIds.set(key, sc);
      }
    });

    const uniqueFiltered = Array.from(seenEmpIds.values());

    // 2. Parse numeric score for sorting
    const parsed = uniqueFiltered.map(sc => {
      const rawScore = sc.totalScore ?? 0;
      const numericScore = typeof rawScore === 'number' ? rawScore : parseFloat(String(rawScore)) || 0;
      const leaderInfo = rosterMap.get(sc.employeeUid);

      return {
        ...sc,
        numericScore,
        reportingLead: leaderInfo?.teamLeadName || leaderInfo?.managerName || '-'
      };
    });

    // Sort descending by score
    parsed.sort((a, b) => b.numericScore - a.numericScore);

    const total = parsed.length;
    if (total === 0) return [];

    // 3. Assign Quartiles (TQ, MQ, BQ)
    const tqCutoff = Math.max(1, Math.ceil(total * 0.25));
    const bqStartIndex = Math.floor(total * 0.75);

    return parsed.map((sc, idx) => {
      let quartile: 'TQ' | 'MQ' | 'BQ' = 'MQ';
      if (idx < tqCutoff) {
        quartile = 'TQ';
      } else if (idx >= bqStartIndex) {
        quartile = 'BQ';
      }

      return {
        ...sc,
        quartile
      };
    });
  }, [scorecards, selectedMonth, hierarchyScope, selectedProcess, searchQuery, rosterMap]);

  // Apply Quartile filter for final display list
  const displayRecords = useMemo(() => {
    if (quartileFilter === 'ALL') return classifiedRecords;
    return classifiedRecords.filter(r => r.quartile === quartileFilter);
  }, [classifiedRecords, quartileFilter]);

  // Pagination calculations
  const totalRecords = displayRecords.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);

  const paginatedRecords = useMemo(() => {
    const startIdx = (safeCurrentPage - 1) * pageSize;
    return displayRecords.slice(startIdx, startIdx + pageSize);
  }, [displayRecords, safeCurrentPage, pageSize]);

  // Aggregate stats
  const stats = useMemo(() => {
    const total = classifiedRecords.length;
    if (total === 0) {
      return { 
        total: 0, 
        avgScore: 0, 
        tqCount: 0, 
        mqCount: 0, 
        bqCount: 0, 
        tqAvg: 0, 
        bqAvg: 0, 
        avgProductivityScore: 0, 
        avgQualityScore: 0, 
        avgAttendanceScore: 0, 
        avgAptScore: 0, 
        tqPerformers: [], 
        bqPerformers: [] 
      };
    }

    const tqList = classifiedRecords.filter(r => r.quartile === 'TQ');
    const mqList = classifiedRecords.filter(r => r.quartile === 'MQ');
    const bqList = classifiedRecords.filter(r => r.quartile === 'BQ');

    const sumAll = classifiedRecords.reduce((acc, r) => acc + r.numericScore, 0);
    const sumTq = tqList.reduce((acc, r) => acc + r.numericScore, 0);
    const sumBq = bqList.reduce((acc, r) => acc + r.numericScore, 0);

    const sumProd = classifiedRecords.reduce((acc, r) => acc + (Number(r.productivityScore) || 0), 0);
    const sumQual = classifiedRecords.reduce((acc, r) => acc + (Number(r.qualityScore) || 0), 0);
    const sumAtt = classifiedRecords.reduce((acc, r) => acc + (Number(r.attendanceScore) || 0), 0);
    const sumApt = classifiedRecords.reduce((acc, r) => acc + (Number(r.aptScore) || 0), 0);

    return {
      total,
      avgScore: sumAll / total,
      tqCount: tqList.length,
      mqCount: mqList.length,
      bqCount: bqList.length,
      tqAvg: tqList.length > 0 ? sumTq / tqList.length : 0,
      bqAvg: bqList.length > 0 ? sumBq / bqList.length : 0,
      avgProductivityScore: sumProd / total,
      avgQualityScore: sumQual / total,
      avgAttendanceScore: sumAtt / total,
      avgAptScore: sumApt / total,
      tqPerformers: tqList.slice(0, 5).map(r => ({ name: r.employeeName, role: r.role, score: r.numericScore })),
      bqPerformers: bqList.slice(0, 5).map(r => ({ name: r.employeeName, role: r.role, score: r.numericScore }))
    };
  }, [classifiedRecords]);

  // Request AI Insights from backend
  const handleGenerateAiInsights = async () => {
    if (classifiedRecords.length === 0) {
      toast.error('No performance records available in current filter selection.');
      return;
    }

    setGeneratingAi(true);
    setAiInsights(null);

    try {
      const payload = {
        hierarchyLevel: hierarchyScope,
        selectedProcess,
        period: selectedMonth !== 'ALL' ? formatPeriodForDisplay(selectedMonth) : activePeriod,
        summaryStats: {
          totalEvaluated: stats.total,
          avgKpiScore: stats.avgScore,
          tqCount: stats.tqCount,
          mqCount: stats.mqCount,
          bqCount: stats.bqCount,
          avgProductivityScore: stats.avgProductivityScore,
          avgQualityScore: stats.avgQualityScore,
          avgAttendanceScore: stats.avgAttendanceScore,
          avgAptScore: stats.avgAptScore,
          tqPerformers: stats.tqPerformers,
          bqPerformers: stats.bqPerformers
        }
      };

      const res = await fetch('/api/kpi/ai-insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (data.success) {
        setAiInsights(data.insights);
        toast.success('AI Performance Insights generated successfully!');
      } else {
        toast.error(data.error || 'Failed to generate AI insights.');
      }
    } catch (err) {
      console.error('Error generating AI insights:', err);
      toast.error('Connection error while generating AI insights.');
    } finally {
      setGeneratingAi(false);
    }
  };

  // Send Supervisor Chat Question to Backend AI Chat endpoint
  const handleSendChatQuestion = async (textToSend?: string) => {
    const questionText = (textToSend || chatInput).trim();
    if (!questionText) return;

    const userMsg = { role: 'user' as const, text: questionText, timestamp: new Date() };
    setChatMessages(prev => [...prev, userMsg]);
    if (!textToSend) setChatInput('');
    setSendingChat(true);

    try {
      const kpiContext = {
        period: selectedMonth !== 'ALL' ? formatPeriodForDisplay(selectedMonth) : activePeriod,
        selectedProcess,
        hierarchyLevel: hierarchyScope,
        totalEvaluated: stats.total,
        avgKpiScore: stats.avgScore,
        tqCount: stats.tqCount,
        mqCount: stats.mqCount,
        bqCount: stats.bqCount,
        avgProductivityScore: stats.avgProductivityScore,
        avgQualityScore: stats.avgQualityScore,
        avgAttendanceScore: stats.avgAttendanceScore,
        avgAptScore: stats.avgAptScore,
        tqPerformers: stats.tqPerformers,
        bqPerformers: stats.bqPerformers,
        sampleRecords: displayRecords.slice(0, 30).map(r => ({
          name: r.employeeName,
          empId: r.employeeId,
          role: r.role,
          process: r.process,
          score: r.numericScore,
          quartile: r.quartile,
          lead: r.reportingLead,
          productivity: { target: r.targetProductivity, actual: r.actualProductivity, score: r.productivityScore },
          quality: { target: r.targetQuality, actual: r.actualQuality, score: r.qualityScore },
          attendance: { target: r.targetAttendance, actual: r.actualAttendance, score: r.attendanceScore },
          apt: { target: r.targetAPT, actual: r.actualAPT, score: r.aptScore }
        }))
      };

      const historyFormatted = chatMessages.map(m => ({
        role: m.role,
        text: m.text
      }));

      const res = await fetch('/api/kpi/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: questionText,
          history: historyFormatted,
          kpiContext
        })
      });

      const data = await res.json();
      if (data.success) {
        const aiMsg = {
          role: 'assistant' as const,
          text: data.reply || 'No response returned.',
          timestamp: new Date()
        };
        setChatMessages(prev => [...prev, aiMsg]);
      } else {
        toast.error(data.error || 'AI Chat failed.');
      }
    } catch (err) {
      console.error('Chat error:', err);
      toast.error('Error connecting to AI Chat assistant.');
    } finally {
      setSendingChat(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner & AI Engine Controls */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white rounded-2xl p-6 border border-indigo-900/50 shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Brain className="text-indigo-400" size={22} />
            <h2 className="text-xl font-black tracking-tight">Team Performance Review & AI Analytics</h2>
          </div>
          <p className="text-xs text-indigo-200 max-w-2xl">
            Evaluate team performance per month across hierarchy levels (Team Lead vs. Frontline Agents/QA/SME), classify TQ, MQ, and BQ performers, and converse with the Supervisor AI Assistant.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            onClick={() => setShowAiChatDrawer(!showAiChatDrawer)}
            className="bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-400/30 text-xs font-bold h-10 px-4 rounded-xl shadow-xs gap-2 cursor-pointer transition-all"
          >
            <MessageSquare size={16} className="text-indigo-300" />
            <span>{showAiChatDrawer ? 'Close AI Chat' : 'Supervisor AI Chat'}</span>
          </Button>

          <Button
            onClick={handleGenerateAiInsights}
            disabled={generatingAi || stats.total === 0}
            className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold h-10 px-4 rounded-xl shadow-md gap-2 cursor-pointer transition-all"
          >
            <Sparkles className={generatingAi ? 'animate-spin' : 'text-amber-300'} size={16} />
            <span>{generatingAi ? 'Analyzing...' : 'Generate AI Insights'}</span>
          </Button>
        </div>
      </div>

      {/* Primary Filter Bar (Month / Period, Hierarchy, Process, Search) */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-wrap items-center justify-between gap-4">
        {/* Month / Period Filter */}
        <div className="flex items-center gap-2 bg-indigo-50/80 dark:bg-indigo-950/40 p-1.5 rounded-xl border border-indigo-100 dark:border-indigo-900/50">
          <Calendar size={15} className="text-indigo-600 dark:text-indigo-400 ml-1.5" />
          <label className="text-xs font-bold text-indigo-900 dark:text-indigo-200">Month / Period:</label>
          <select
            value={selectedMonth}
            onChange={e => setSelectedMonth(e.target.value)}
            className="text-xs bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 rounded-lg px-3 py-1 font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="ALL">All Months (Combined)</option>
            {parsedAvailablePeriods.map(p => (
              <option key={p} value={p}>
                {formatPeriodForDisplay(p)}
              </option>
            ))}
          </select>
        </div>

        {/* Hierarchy Scope Selector */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
          <button
            onClick={() => setHierarchyScope('ALL_LEVELS')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              hierarchyScope === 'ALL_LEVELS'
                ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            All Levels
          </button>

          <button
            onClick={() => setHierarchyScope('MANAGER')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              hierarchyScope === 'MANAGER'
                ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            Manager Level
          </button>

          <button
            onClick={() => setHierarchyScope('TEAM_LEAD')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              hierarchyScope === 'TEAM_LEAD'
                ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            Team Lead Level
          </button>

          <button
            onClick={() => setHierarchyScope('AGENT_QA_SME')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              hierarchyScope === 'AGENT_QA_SME'
                ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            Agent / QA / SME Level
          </button>
        </div>

        {/* Secondary Filters */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Process Filter */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-500">Process:</label>
            <select
              value={selectedProcess}
              onChange={e => setSelectedProcess(e.target.value)}
              className="text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-1.5 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="ALL">All Processes</option>
              {availableProcesses.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Quartile Filter */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-500">Quartile:</label>
            <select
              value={quartileFilter}
              onChange={e => setQuartileFilter(e.target.value as QuartileFilter)}
              className="text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-1.5 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="ALL">All Performers</option>
              <option value="TQ">TQ - Top Quartile (Top 25%)</option>
              <option value="MQ">MQ - Middle Quartile (Middle 50%)</option>
              <option value="BQ">BQ - Bottom Quartile (Bottom 25%)</option>
            </select>
          </div>

          {/* Search Input */}
          <div className="relative w-44">
            <Search className="absolute left-3 top-2 text-slate-400" size={14} />
            <input
              type="text"
              placeholder="Search employee..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
      </div>

      {/* Interactive Supervisor AI Chat Drawer / Panel */}
      {showAiChatDrawer && (
        <div className="bg-slate-900 border border-indigo-900/80 rounded-2xl p-5 text-white shadow-xl flex flex-col gap-4 animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2.5">
              <div className="p-2 bg-indigo-600 rounded-xl text-white shadow-sm">
                <Bot size={20} />
              </div>
              <div>
                <h3 className="text-sm font-black tracking-tight flex items-center gap-2">
                  Supervisor AI Assistant
                  <span className="text-[10px] bg-indigo-500/30 text-indigo-300 font-bold px-2 py-0.5 rounded-full border border-indigo-400/30">
                    Live KPI Querying
                  </span>
                </h3>
                <p className="text-[11px] text-slate-400">Ask any question based on Monthly & Daily KPI metrics for {selectedMonth !== 'ALL' ? formatPeriodForDisplay(selectedMonth) : 'All Periods'}</p>
              </div>
            </div>

            <button
              onClick={() => setShowAiChatDrawer(false)}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 cursor-pointer"
            >
              <X size={18} />
            </button>
          </div>

          {/* Chat Messages Log */}
          <div className="max-h-72 overflow-y-auto space-y-3 pr-2 font-sans">
            {chatMessages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex items-start gap-2.5 text-xs ${
                  msg.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                {msg.role === 'assistant' && (
                  <div className="p-1.5 bg-indigo-600 rounded-lg shrink-0 mt-0.5">
                    <Bot size={14} className="text-white" />
                  </div>
                )}

                <div
                  className={`p-3 rounded-2xl max-w-xl leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-tr-xs'
                      : 'bg-slate-800 text-slate-200 border border-slate-700/60 rounded-tl-xs'
                  }`}
                >
                  {msg.text}
                </div>

                {msg.role === 'user' && (
                  <div className="p-1.5 bg-slate-700 rounded-lg shrink-0 mt-0.5">
                    <User size={14} className="text-slate-300" />
                  </div>
                )}
              </div>
            ))}

            {sendingChat && (
              <div className="flex items-center gap-2 text-xs text-indigo-300 italic p-2 bg-slate-800/50 rounded-xl w-fit">
                <Sparkles size={14} className="animate-spin text-amber-300" />
                <span>Analyzing KPI database & generating response...</span>
              </div>
            )}
          </div>

          {/* Quick Starter Pills */}
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/80">
            <span className="text-[10px] uppercase font-bold text-slate-500">Suggested Questions:</span>
            <button
              onClick={() => handleSendChatQuestion("Who are the top 3 performers this month and what are their scores?")}
              className="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700 transition-all cursor-pointer"
            >
              Top 3 Performers?
            </button>
            <button
              onClick={() => handleSendChatQuestion("Which bottom quartile agents need immediate coaching intervention?")}
              className="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700 transition-all cursor-pointer"
            >
              Bottom Quartile Coaching Need?
            </button>
            <button
              onClick={() => handleSendChatQuestion("Compare Team Lead level performance versus Frontline Agent averages.")}
              className="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700 transition-all cursor-pointer"
            >
              TL vs Agent Comparison?
            </button>
          </div>

          {/* Chat Input Bar */}
          <div className="flex items-center gap-2 pt-1">
            <input
              type="text"
              placeholder="Ask a question about KPI scores, coaching needs, or performance data..."
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSendChatQuestion()}
              className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <Button
              onClick={() => handleSendChatQuestion()}
              disabled={sendingChat || !chatInput.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold h-9 px-4 rounded-xl shrink-0 cursor-pointer"
            >
              <Send size={14} />
            </Button>
          </div>
        </div>
      )}

      {/* Quartile Metric Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total Evaluated */}
        <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Total Evaluated</p>
            <h3 className="text-2xl font-black text-slate-900 dark:text-white mt-1">{stats.total}</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Period: <span className="font-bold text-indigo-600 dark:text-indigo-400">{selectedMonth !== 'ALL' ? formatPeriodForDisplay(selectedMonth) : 'All Months'}</span> | Avg: <span className="font-bold">{stats.avgScore.toFixed(1)}%</span>
            </p>
          </div>
          <div className="p-3 bg-indigo-50 dark:bg-indigo-950/50 rounded-2xl text-indigo-600 dark:text-indigo-400">
            <Users size={24} />
          </div>
        </div>

        {/* Card 2: Top Quartile (TQ) */}
        <div 
          onClick={() => setQuartileFilter(quartileFilter === 'TQ' ? 'ALL' : 'TQ')}
          className={`p-5 rounded-2xl border transition-all cursor-pointer ${
            quartileFilter === 'TQ'
              ? 'bg-emerald-500/10 border-emerald-500 ring-2 ring-emerald-500/20'
              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-emerald-300'
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">TQ (Top Quartile)</p>
              </div>
              <h3 className="text-2xl font-black text-slate-900 dark:text-white mt-1">{stats.tqCount} <span className="text-xs font-semibold text-slate-500">({stats.total > 0 ? ((stats.tqCount / stats.total) * 100).toFixed(0) : 0}%)</span></h3>
              <p className="text-[11px] text-slate-500 mt-0.5">Avg TQ Score: <span className="font-bold text-emerald-600 dark:text-emerald-400">{stats.tqAvg.toFixed(1)}%</span></p>
            </div>
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/50 rounded-2xl text-emerald-600 dark:text-emerald-400">
              <Award size={24} />
            </div>
          </div>
        </div>

        {/* Card 3: Middle Quartile (MQ) */}
        <div 
          onClick={() => setQuartileFilter(quartileFilter === 'MQ' ? 'ALL' : 'MQ')}
          className={`p-5 rounded-2xl border transition-all cursor-pointer ${
            quartileFilter === 'MQ'
              ? 'bg-blue-500/10 border-blue-500 ring-2 ring-blue-500/20'
              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-blue-300'
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                <p className="text-xs font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider">MQ (Middle Quartile)</p>
              </div>
              <h3 className="text-2xl font-black text-slate-900 dark:text-white mt-1">{stats.mqCount} <span className="text-xs font-semibold text-slate-500">({stats.total > 0 ? ((stats.mqCount / stats.total) * 100).toFixed(0) : 0}%)</span></h3>
              <p className="text-[11px] text-slate-500 mt-0.5">Core Steady Performers</p>
            </div>
            <div className="p-3 bg-blue-50 dark:bg-blue-950/50 rounded-2xl text-blue-600 dark:text-blue-400">
              <UserCheck size={24} />
            </div>
          </div>
        </div>

        {/* Card 4: Bottom Quartile (BQ) */}
        <div 
          onClick={() => setQuartileFilter(quartileFilter === 'BQ' ? 'ALL' : 'BQ')}
          className={`p-5 rounded-2xl border transition-all cursor-pointer ${
            quartileFilter === 'BQ'
              ? 'bg-rose-500/10 border-rose-500 ring-2 ring-rose-500/20'
              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-rose-300'
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-rose-500" />
                <p className="text-xs font-bold text-rose-700 dark:text-rose-400 uppercase tracking-wider">BQ (Bottom Quartile)</p>
              </div>
              <h3 className="text-2xl font-black text-slate-900 dark:text-white mt-1">{stats.bqCount} <span className="text-xs font-semibold text-slate-500">({stats.total > 0 ? ((stats.bqCount / stats.total) * 100).toFixed(0) : 0}%)</span></h3>
              <p className="text-[11px] text-slate-500 mt-0.5">Avg BQ Score: <span className="font-bold text-rose-600 dark:text-rose-400">{stats.bqAvg.toFixed(1)}%</span></p>
            </div>
            <div className="p-3 bg-rose-50 dark:bg-rose-950/50 rounded-2xl text-rose-600 dark:text-rose-400">
              <AlertTriangle size={24} />
            </div>
          </div>
        </div>
      </div>

      {/* AI Performance Insights Card */}
      {aiInsights && (
        <div className="bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-900/60 rounded-2xl p-6 shadow-sm flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-indigo-50 dark:bg-indigo-950 rounded-xl text-indigo-600 dark:text-indigo-400">
                <Sparkles size={18} />
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">AI Executive Review & Coaching Insights</h3>
            </div>
            <button 
              onClick={() => setAiInsights(null)} 
              className="text-xs font-semibold text-slate-400 hover:text-slate-600 cursor-pointer"
            >
              Dismiss
            </button>
          </div>

          <div className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap font-sans">
            {aiInsights}
          </div>
        </div>
      )}

      {/* Performance Review Detailed Table */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden flex flex-col">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-indigo-600" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Team Performance Breakdown ({totalRecords} Employees {selectedMonth !== 'ALL' ? `for ${formatPeriodForDisplay(selectedMonth)}` : ''})
            </h3>
          </div>

          <div className="flex items-center gap-3">
            {quartileFilter !== 'ALL' && (
              <button 
                onClick={() => setQuartileFilter('ALL')}
                className="text-xs font-bold text-indigo-600 hover:underline cursor-pointer"
              >
                Clear Quartile Filter
              </button>
            )}
          </div>
        </div>

        {displayRecords.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            <BarChart3 className="mx-auto mb-2 text-slate-300 dark:text-slate-700" size={32} />
            <p className="text-sm font-semibold">No performance records match your current filters.</p>
            <p className="text-xs text-slate-400 mt-1">Try changing the Month, Process, or Hierarchy scope.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto overflow-y-auto max-h-[600px]">
              <table className="w-full text-left text-xs relative border-collapse">
                <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 uppercase font-bold border-b border-slate-200 dark:border-slate-700 shadow-xs">
                  <tr>
                    <th className="p-3.5 pl-5 bg-slate-100 dark:bg-slate-800">Employee Name</th>
                    <th className="p-3.5 bg-slate-100 dark:bg-slate-800">Emp ID</th>
                    <th className="p-3.5 bg-slate-100 dark:bg-slate-800">Period / Month</th>
                    <th className="p-3.5 bg-slate-100 dark:bg-slate-800">Role</th>
                    <th className="p-3.5 bg-slate-100 dark:bg-slate-800">Process</th>
                    <th className="p-3.5 bg-slate-100 dark:bg-slate-800">Reporting TL / Manager</th>
                    <th className="p-3.5 text-center bg-slate-100 dark:bg-slate-800">KPI Score</th>
                    <th className="p-3.5 text-center bg-slate-100 dark:bg-slate-800">Quartile Tier</th>
                    <th className="p-3.5 text-center bg-slate-100 dark:bg-slate-800">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
                  {paginatedRecords.map((r, idx) => (
                    <tr key={r.id || idx} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                      <td className="p-3.5 pl-5 font-bold text-slate-900 dark:text-white">
                        {r.employeeName || 'Unknown Employee'}
                      </td>
                      <td className="p-3.5 font-mono text-slate-600 dark:text-slate-400">
                        {r.employeeId || '-'}
                      </td>
                      <td className="p-3.5 font-semibold text-slate-700 dark:text-slate-300">
                        {formatPeriodForDisplay(r.reportingPeriod || (r as any).period || '-')}
                      </td>
                      <td className="p-3.5 text-slate-700 dark:text-slate-300">
                        {r.role || '-'}
                      </td>
                      <td className="p-3.5 text-slate-600 dark:text-slate-400">
                        {r.process || '-'}
                      </td>
                      <td className="p-3.5 text-slate-600 dark:text-slate-400">
                        {r.reportingLead}
                      </td>
                      <td className="p-3.5 text-center font-black text-sm text-slate-900 dark:text-white">
                        {r.numericScore.toFixed(1)}%
                      </td>
                      <td className="p-3.5 text-center">
                        {r.quartile === 'TQ' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800">
                            <Award size={12} /> TQ (Top 25%)
                          </span>
                        )}
                        {r.quartile === 'MQ' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-800">
                            <CheckCircle2 size={12} /> MQ (Middle)
                          </span>
                        )}
                        {r.quartile === 'BQ' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-800">
                            <AlertTriangle size={12} /> BQ (Bottom 25%)
                          </span>
                        )}
                      </td>
                      <td className="p-3.5 text-center">
                        <button
                          onClick={() => {
                            setSelectedEmployeeForBreakdown(r);
                            setActiveBreakdownTab('monthly');
                          }}
                          className="bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:hover:bg-indigo-950/80 text-indigo-600 dark:text-indigo-400 font-bold px-2.5 py-1 rounded-lg text-[11px] transition-all border border-indigo-200 dark:border-indigo-800 cursor-pointer shadow-xs"
                        >
                          View Breakdown
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls Footer */}
            <div className="p-3 px-5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex flex-wrap items-center justify-between gap-3 text-xs font-medium text-slate-600 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <span>Show per page:</span>
                <select
                  value={pageSize}
                  onChange={e => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                </select>
                <span className="text-slate-400 ml-2">
                  Showing {totalRecords === 0 ? 0 : Math.min((safeCurrentPage - 1) * pageSize + 1, totalRecords)} - {Math.min(safeCurrentPage * pageSize, totalRecords)} of {totalRecords} records
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setCurrentPage(1)}
                  disabled={safeCurrentPage === 1}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="First Page"
                >
                  <ChevronsLeft size={16} />
                </button>
                <button
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={safeCurrentPage === 1}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="Previous Page"
                >
                  <ChevronLeft size={16} />
                </button>

                <span className="px-3 font-bold text-slate-900 dark:text-white">
                  Page {safeCurrentPage} of {totalPages}
                </span>

                <button
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                  disabled={safeCurrentPage === totalPages}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="Next Page"
                >
                  <ChevronRight size={16} />
                </button>
                <button
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={safeCurrentPage === totalPages}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="Last Page"
                >
                  <ChevronsRight size={16} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Detailed Employee breakdown Modal */}
      {selectedEmployeeForBreakdown && (() => {
        const matchedMonthlyRecords = scorecards.filter(sc => 
          (sc.employeeUid && sc.employeeUid === selectedEmployeeForBreakdown.employeeUid) || 
          (sc.employeeId && sc.employeeId === selectedEmployeeForBreakdown.employeeId) || 
          (sc.employeeEmail && sc.employeeEmail === selectedEmployeeForBreakdown.employeeEmail) || 
          (sc.employeeName && sc.employeeName.toLowerCase() === selectedEmployeeForBreakdown.employeeName.toLowerCase())
        ).sort((a, b) => {
          const periodA = a.reportingPeriod || (a as any).period || '';
          const periodB = b.reportingPeriod || (b as any).period || '';
          return periodA.localeCompare(periodB);
        });

        const graphData = matchedMonthlyRecords.map(sc => {
          const rawScore = sc.totalScore ?? 0;
          const scoreVal = typeof rawScore === 'number' ? rawScore : parseFloat(String(rawScore)) || 0;
          return {
            month: formatPeriodForDisplay(sc.reportingPeriod || (sc as any).period || ''),
            'Overall score': scoreVal,
            'Productivity': Number(sc.productivityScore) || 0,
            'Quality': Number(sc.qualityScore) || 0,
            'Attendance': Number(sc.attendanceScore) || 0,
            'APT': Number(sc.aptScore) || 0,
          };
        });

        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-950 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
              
              {/* Modal Header */}
              <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <User className="text-indigo-600 dark:text-indigo-400" size={20} />
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">
                      Performance Profile: {selectedEmployeeForBreakdown.employeeName}
                    </h3>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Emp ID:</span> {selectedEmployeeForBreakdown.employeeId || '-'} &bull;{' '}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Role:</span> {selectedEmployeeForBreakdown.role} &bull;{' '}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Process:</span> {selectedEmployeeForBreakdown.process} &bull;{' '}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Reporting to:</span> {selectedEmployeeForBreakdown.reportingLead}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedEmployeeForBreakdown(null)}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-800 cursor-pointer transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Tab navigation */}
              <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/20 px-5">
                <button
                  onClick={() => setActiveBreakdownTab('monthly')}
                  className={`py-3 px-4 text-xs font-bold border-b-2 transition-all cursor-pointer ${
                    activeBreakdownTab === 'monthly'
                      ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Monthly KPI Trend (MoM)
                </button>
                <button
                  onClick={() => setActiveBreakdownTab('daily')}
                  className={`py-3 px-4 text-xs font-bold border-b-2 transition-all cursor-pointer ${
                    activeBreakdownTab === 'daily'
                      ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Daily Logs Breakdown
                </button>
              </div>

              {/* Modal Scrollable Body */}
              <div className="flex-1 overflow-y-auto p-6">
                
                {activeBreakdownTab === 'monthly' && (
                  <div className="flex flex-col gap-6">
                    {/* Line Chart of performance trend */}
                    <div>
                      <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-2">Month-on-Month Performance Trend</h4>
                      {graphData.length > 0 ? (
                        <div className="h-64 bg-slate-50 dark:bg-slate-900/40 p-4 rounded-xl border border-slate-200/60 dark:border-slate-800/60">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={graphData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" className="dark:hidden" />
                              <CartesianGrid strokeDasharray="3 3" stroke="#334155" className="hidden dark:block" />
                              <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 10 }} />
                              <YAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} />
                              <Tooltip contentStyle={{ fontSize: '11px', borderRadius: '8px' }} />
                              <Legend wrapperStyle={{ fontSize: '11px' }} />
                              <Line type="monotone" name="KPI Score" dataKey="Overall score" stroke="#4f46e5" strokeWidth={2.5} activeDot={{ r: 6 }} />
                              <Line type="monotone" name="Productivity" dataKey="Productivity" stroke="#10b981" strokeWidth={1.5} strokeDasharray="3 3" />
                              <Line type="monotone" name="Quality" dataKey="Quality" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="3 3" />
                              <Line type="monotone" name="Attendance" dataKey="Attendance" stroke="#ef4444" strokeWidth={1.5} strokeDasharray="3 3" />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <div className="p-8 text-center bg-slate-50 dark:bg-slate-900 rounded-xl">
                          <p className="text-xs text-slate-500 font-semibold">No historical monthly data available to chart.</p>
                        </div>
                      )}
                    </div>

                    {/* Monthly Scorecards list */}
                    <div>
                      <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-3">Historical Monthly Metric Logs</h4>
                      <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead>
                            <tr className="bg-slate-100 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold uppercase">
                              <th className="p-3">Period</th>
                              <th className="p-3 text-center">KPI Score</th>
                              <th className="p-3 text-center">Productivity</th>
                              <th className="p-3 text-center">Quality</th>
                              <th className="p-3 text-center">Attendance</th>
                              <th className="p-3 text-center">APT</th>
                              <th className="p-3">Remarks / Comments</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium text-slate-700 dark:text-slate-300">
                            {matchedMonthlyRecords.map((mRec, mIdx) => {
                              const rawScore = mRec.totalScore ?? 0;
                              const scoreVal = typeof rawScore === 'number' ? rawScore : parseFloat(String(rawScore)) || 0;
                              return (
                                <tr key={mRec.id || mIdx} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30">
                                  <td className="p-3 font-bold text-slate-900 dark:text-white">
                                    {formatPeriodForDisplay(mRec.reportingPeriod || (mRec as any).period || '')}
                                  </td>
                                  <td className="p-3 text-center font-black text-indigo-600 dark:text-indigo-400 text-sm">
                                    {scoreVal.toFixed(1)}%
                                  </td>
                                  <td className="p-3 text-center">
                                    <div className="font-bold">{Number(mRec.productivityScore || 0).toFixed(1)}%</div>
                                    <div className="text-[10px] text-slate-400">
                                      Act: {mRec.actualProductivity} / Tgt: {mRec.targetProductivity}
                                    </div>
                                  </td>
                                  <td className="p-3 text-center">
                                    <div className="font-bold">{Number(mRec.qualityScore || 0).toFixed(1)}%</div>
                                    <div className="text-[10px] text-slate-400">
                                      Act: {mRec.actualQuality} / Tgt: {mRec.targetQuality}
                                    </div>
                                  </td>
                                  <td className="p-3 text-center">
                                    <div className="font-bold">{Number(mRec.attendanceScore || 0).toFixed(1)}%</div>
                                    <div className="text-[10px] text-slate-400">
                                      Act: {mRec.actualAttendance} / Tgt: {mRec.targetAttendance}
                                    </div>
                                  </td>
                                  <td className="p-3 text-center">
                                    <div className="font-bold">{Number(mRec.aptScore || 0).toFixed(1)}%</div>
                                    <div className="text-[10px] text-slate-400">
                                      Act: {mRec.actualAPT} / Tgt: {mRec.targetAPT}
                                    </div>
                                  </td>
                                  <td className="p-3 text-slate-500 text-[11px] max-w-xs truncate" title={mRec.comments}>
                                    {mRec.comments || '-'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}

                {activeBreakdownTab === 'daily' && (
                  <div className="flex flex-col gap-4">
                    
                    {/* Selector for Month partition in modal */}
                    <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900 p-3 rounded-xl border border-slate-200/60 dark:border-slate-800">
                      <Calendar size={15} className="text-slate-500" />
                      <label htmlFor="modal-daily-month-select" className="text-xs font-bold text-slate-700 dark:text-slate-300">
                        Query Month Archive Partition:
                      </label>
                      <select
                        id="modal-daily-month-select"
                        value={selectedDailyMonth}
                        onChange={e => setSelectedDailyMonth(e.target.value)}
                        className="text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1.5 font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        {parsedAvailablePeriods.map(p => (
                          <option key={p} value={p}>
                            {formatPeriodForDisplay(p)}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Daily Logs Table / Loading */}
                    <div>
                      <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-2">
                        Day-Wise KPI Record Sheets for <span className="text-indigo-600 font-mono font-bold">{selectedDailyMonth}</span>
                      </h4>

                      {loadingDailyLogs ? (
                        <div className="p-12 text-center flex flex-col items-center justify-center gap-2">
                          <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                          <p className="text-xs text-slate-500 font-semibold">Loading partition files from cloud storage...</p>
                        </div>
                      ) : dailyLogs.length === 0 ? (
                        <div className="p-12 text-center bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
                          <BarChart3 className="mx-auto mb-2 text-slate-300 dark:text-slate-700" size={32} />
                          <p className="text-xs text-slate-500 font-semibold">No daily performance records published for this employee in the <span className="font-mono font-bold">{selectedDailyMonth}</span> partition.</p>
                        </div>
                      ) : (
                        <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl max-h-[400px]">
                          <table className="w-full text-left text-xs border-collapse relative">
                            <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold uppercase shadow-xs">
                              <tr>
                                <th className="p-3 pl-4 bg-slate-100 dark:bg-slate-800">Date</th>
                                <th className="p-3 text-center bg-slate-100 dark:bg-slate-800">Day score</th>
                                <th className="p-3 text-center bg-slate-100 dark:bg-slate-800">Productivity</th>
                                <th className="p-3 text-center bg-slate-100 dark:bg-slate-800">Quality</th>
                                <th className="p-3 text-center bg-slate-100 dark:bg-slate-800">Attendance</th>
                                <th className="p-3 text-center bg-slate-100 dark:bg-slate-800">APT</th>
                                <th className="p-3 text-center bg-slate-100 dark:bg-slate-800">Bonus/Penalty</th>
                                <th className="p-3 bg-slate-100 dark:bg-slate-800">Remarks / Supervisor Feed</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium text-slate-700 dark:text-slate-300">
                              {dailyLogs.map((dLog, dIdx) => (
                                <tr key={dLog.id || dIdx} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30">
                                  <td className="p-3 pl-4 font-mono font-bold text-slate-900 dark:text-white">
                                    {dLog.reportingDate}
                                  </td>
                                  <td className="p-3 text-center font-black text-slate-900 dark:text-white">
                                    {(dLog.totalScore ?? 0).toFixed(1)}%
                                  </td>
                                  <td className="p-3 text-center">
                                    <div className="font-bold">{Number(dLog.productivityScore || 0).toFixed(0)}%</div>
                                    <div className="text-[9px] text-slate-400">
                                      Act: {dLog.actualProductivity} / Tgt: {dLog.targetProductivity}
                                    </div>
                                  </td>
                                  <td className="p-3 text-center">
                                    <div className="font-bold">{Number(dLog.qualityScore || 0).toFixed(0)}%</div>
                                    <div className="text-[9px] text-slate-400">
                                      Act: {dLog.actualQuality}% / Tgt: {dLog.targetQuality}%
                                    </div>
                                  </td>
                                  <td className="p-3 text-center">
                                    <div className="font-bold">{Number(dLog.attendanceScore || 0).toFixed(0)}%</div>
                                    <div className="text-[9px] text-slate-400">
                                      Act: {dLog.actualAttendance}% / Tgt: {dLog.targetAttendance}%
                                    </div>
                                  </td>
                                  <td className="p-3 text-center">
                                    <div className="font-bold">{Number(dLog.aptScore || 0).toFixed(0)}%</div>
                                    <div className="text-[9px] text-slate-400">
                                      Act: {dLog.actualAPT} / Tgt: {dLog.targetAPT}
                                    </div>
                                  </td>
                                  <td className="p-3 text-center font-mono">
                                    <span className="text-emerald-600 font-bold">+{dLog.bonus || 0}</span> /{' '}
                                    <span className="text-rose-600 font-bold">-{dLog.penalty || 0}</span>
                                  </td>
                                  <td className="p-3 text-slate-500 text-[11px] max-w-xs truncate" title={dLog.comments}>
                                    {dLog.comments || '-'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex justify-end">
                <Button
                  onClick={() => setSelectedEmployeeForBreakdown(null)}
                  className="bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:hover:bg-slate-200 dark:text-slate-950 text-xs font-bold px-4 py-2 rounded-xl shadow-xs"
                >
                  Close Profile
                </Button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
