import React, { useState, useEffect, useMemo } from 'react';
import { KpiCommentHistorySidePanel } from '../components/KpiCommentHistorySidePanel';
import { 
  Award, 
  Clock, 
  Plus, 
  Trash2, 
  ShieldAlert, 
  FileSpreadsheet, 
  CheckCircle, 
  AlertTriangle, 
  Search, 
  Filter, 
  RefreshCw, 
  Sparkles, 
  ChevronRight, 
  Settings, 
  Calendar, 
  TrendingUp, 
  Upload, 
  User as UserIcon, 
  X,
  Trophy,
  PieChart as PieIcon,
  Flame,
  LayoutGrid,
  Edit,
  Download,
  Check,
  Save,
  Sliders,
  ChevronLeft,
  History,
  ChevronDown
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { usePermission } from '../components/PermissionContext';
import { canActOn } from '../lib/hierarchy';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { cn, convertExcelDate, convertExcelPeriod } from '../lib/utils';
import { 
  collection, 
  getDocs, 
  setDoc, 
  doc, 
  deleteDoc,
  writeBatch, 
  query, 
  where,
  limit,
  orderBy,
  getCountFromServer
} from 'firebase/firestore';
import { 
  UserProfile, 
  UserRole
} from '../types';
import { 
  ensureDefaultTemplatesExist,
  runDynamicKPIEngine,
  calculateAchievement,
  getPerformanceRating,
  normalizeUploadDate,
  KpiTemplate,
  KpiUploadRow,
  DynamicScorecard,
  RoleLeaderboard,
  DEFAULT_KPI_TEMPLATES,
  SUPPORTED_ROLES,
  KpiCalculationBreakdown
} from '../lib/kpiEngine';
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  BarChart, 
  Bar 
} from 'recharts';

/**
 * Helper to normalize period to standard YYYY-MM-DD date string for safe comparison.
 */
function ensureDateStr(p: string): string {
  if (!p) return '1970-01-01';
  const str = p.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}$/.test(str)) return `${str}-01`;
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  } catch (e) {}
  return str;
}

/**
 * Format YYYY-MM period into a human readable label like "Jun 2026"
 */
function formatPeriodDisplay(p: string): string {
  if (!p || p === 'Select period...') return p;
  const parts = p.trim().split('-');
  if (parts.length < 2) return p;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = parts[0];
  const monthIdx = parseInt(parts[1], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return p;
  return `${monthNames[monthIdx]} ${year}`;
}

/**
 * Get color classes for a given score based on organizational thresholds
 */
function getRatingColor(score: number): string {
  if (score >= 100) return "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800";
  if (score >= 95) return "bg-sky-50 text-sky-700 border-sky-100 dark:bg-sky-900/20 dark:text-sky-400 dark:border-sky-800";
  if (score >= 85) return "bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800";
  if (score >= 75) return "bg-orange-50 text-orange-700 border-orange-100 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800";
  return "bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-900/20 dark:text-rose-400 dark:border-rose-800";
}

import { UserPicker } from '../components/UserPicker';

interface ScorecardViewProps {
  user: UserProfile;
  allUsers: UserProfile[];
  onRefreshAllData?: () => void;
  externalTheme?: 'light' | 'dark';
}

export default function ScorecardView({ user, allUsers = [], onRefreshAllData, externalTheme = 'light' }: ScorecardViewProps) {
  const theme = externalTheme;
  const { canView, canCreate, canEdit, canDelete } = usePermission();

  const canManageKPIs = canEdit('KPI Scorecard');
  const canUploadKPIs = canCreate('KPI Scorecard');
  const canDeleteKPIs = canDelete('KPI Scorecard');
  const canViewReports = canView('KPI Scorecard');

  // Navigation Tabs
  const [activeTab, setActiveTab] = useState<'dashboard' | 'leaderboard' | 'uploads_desk' | 'templates_desk'>('dashboard');

  // Universal Filter State
  const [selectedPeriod, setSelectedPeriod] = useState<string>('');
  const [selectedEmail, setSelectedEmail] = useState<string>('');
  const [selectedLeaderboardRole, setSelectedLeaderboardRole] = useState<string>('QV');
  const [selectedLeaderboardProcess, setSelectedLeaderboardProcess] = useState<string>('All');
  const [selectedLeaderboardType, setSelectedLeaderboardType] = useState<string>('role');
  const [selectedLeaderboardTL, setSelectedLeaderboardTL] = useState<string>('All');
  const [selectedLeaderboardMgr, setSelectedLeaderboardMgr] = useState<string>('All');
  const [selectedDashboardProcess, setSelectedDashboardProcess] = useState<string>('All');
  const [isPeriodDropdownOpen, setIsPeriodDropdownOpen] = useState<boolean>(false);
  const [isWorkDateDropdownOpen, setIsWorkDateDropdownOpen] = useState<boolean>(false);

  // Loading indicator states
  const [loading, setLoading] = useState<boolean>(false);
  const [processingRecalc, setProcessingRecalc] = useState<boolean>(false);

  // Firestore Data States
  const [allScorecards, setAllScorecards] = useState<DynamicScorecard[]>([]);
  const [allRecentUploads, setAllRecentUploads] = useState<any[]>([]);
  const [kpiTemplates, setKpiTemplates] = useState<KpiTemplate[]>([]);
  const [rawUploadsCount, setRawUploadsCount] = useState<number>(0);

  // Staging Uploader States for universal template
  const [stagingData, setStagingData] = useState<KpiUploadRow[]>([]);
  const [stagingFileName, setStagingFileName] = useState<string>('');
  const [editingStagingId, setEditingStagingId] = useState<string | null>(null);
  const [editRowFields, setEditRowFields] = useState<Partial<KpiUploadRow>>({});

  // Template Manager Edit States
  const [selectedConfigRole, setSelectedConfigRole] = useState<string>('QV');
  const [editEscalationPenalty, setEditEscalationPenalty] = useState<number>(20);
  const [editKpiList, setEditKpiList] = useState<{ name: string; weight: number; type: 'higher_is_better' | 'lower_is_better' }[]>([]);
  
  // New KPI creation inputs inside template desk
  const [newKpiName, setNewKpiName] = useState<string>('');
  const [newKpiWeight, setNewKpiWeight] = useState<number>(25);
  const [newKpiType, setNewKpiType] = useState<'higher_is_better' | 'lower_is_better'>('higher_is_better');
  const [newKpiFormat, setNewKpiFormat] = useState<'percentage' | 'duration' | 'number'>('number');

  // Historical Records Edit States
  const [editingHistoricalId, setEditingHistoricalId] = useState<string | null>(null);
  const [editHistoricalFields, setEditHistoricalFields] = useState<Partial<KpiUploadRow>>({});
  
  // Comment History Modal State
  const [activeKpiComment, setActiveKpiComment] = useState<{ kpiName: string, email: string, period: string } | null>(null);

  // Removed hardcoded checks
  const canRecalculate = canManageKPIs;
  const isQAorAgent = !canManageKPIs; // Approximation for UI toggle if needed

  // On mount, initialize default templates and fetch metrics
  useEffect(() => {
    const initAndFetch = async () => {
      setLoading(true);
      await ensureDefaultTemplatesExist();
      await fetchAllKPIData();
      setLoading(false);
    };
    initAndFetch();
  }, [user]);

  // Sync default email filter based on logged-in user
  useEffect(() => {
    if (allUsers.length > 0 && !selectedEmail) {
      setSelectedEmail(user.email.toLowerCase().trim());
    }
  }, [allUsers, selectedEmail, user]);

  // Synchronize dynamic leaderboard default selection with user's role if supported
  useEffect(() => {
    if (user && user.role) {
      const upperRole = user.role.toUpperCase();
      const matched = SUPPORTED_ROLES.find(r => r.toUpperCase() === upperRole);
      if (matched) {
        setSelectedLeaderboardRole(matched);
      }
    }
  }, [user]);

  const [selectedWorkDate, setSelectedWorkDate] = useState<string>('All');

  // Extract all unique available reporting periods from kpi_uploads and scorecards
  const availablePeriods = useMemo(() => {
    const list = new Set<string>();
    
    allRecentUploads.forEach(row => {
      if (row.reportingPeriod) {
        let p = row.reportingPeriod.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
          p = p.substring(0, 7);
        }
        if (/^\d{4}-\d{2}$/.test(p)) {
          list.add(p);
        }
      }
    });

    allScorecards.forEach(sc => {
      if (sc.reportingPeriod) {
        let p = sc.reportingPeriod.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
          p = p.substring(0, 7);
        }
        if (/^\d{4}-\d{2}$/.test(p)) {
          list.add(p);
        }
      }
    });

    return Array.from(list).sort();
  }, [allRecentUploads, allScorecards]);

  // Extract all unique available work dates from kpi_uploads and scorecards
  const availableWorkDates = useMemo(() => {
    const list = new Set<string>();
    
    allRecentUploads.forEach(row => {
      if (row.workDate) {
        let wd = row.workDate.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(wd)) {
          list.add(wd);
        }
      } else if (row.reportingPeriod) {
        let p = row.reportingPeriod.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
          list.add(p);
        }
      }
    });

    allScorecards.forEach(sc => {
      if (sc.workDate) {
        let wd = sc.workDate.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(wd)) {
          list.add(wd);
        }
      } else if (sc.reportingPeriod) {
        let p = sc.reportingPeriod.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
          list.add(p);
        }
      }
    });

    return Array.from(list).sort();
  }, [allRecentUploads, allScorecards]);

  // Auto-default selectedPeriod to the latest available period when they change
  useEffect(() => {
    if (availablePeriods.length > 0) {
      const latest = availablePeriods[availablePeriods.length - 1];
      if (!selectedPeriod || !availablePeriods.includes(selectedPeriod)) {
        setSelectedPeriod(latest);
      }
    }
  }, [availablePeriods, selectedPeriod]);

  /**
   * Fetch templates, generated scorecards and counts from Firestore
   */
  const fetchAllKPIData = async () => {
    try {
      // 1. Fetch templates
      const templatesSnap = await getDocs(collection(db, 'kpi_templates'));
      const fetchedTemplates = templatesSnap.docs.map(docSnap => docSnap.data() as KpiTemplate);
      setKpiTemplates(fetchedTemplates);

      // 2. Fetch scorecards
      const scorecardsSnap = await getDocs(collection(db, 'scorecards'));
      const fetchedScorecards = scorecardsSnap.docs.map(docSnap => docSnap.data() as DynamicScorecard);
      setAllScorecards(fetchedScorecards);

      // 3. Fetch count of raw uploads using getCountFromServer (lightweight metadata query, no docs downloaded!)
      if (canManageKPIs) {
        const uploadsCol = collection(db, 'kpi_uploads');
        const countSnap = await getCountFromServer(uploadsCol);
        setRawUploadsCount(countSnap.data().count);
      }

      // 4. Securely fetch up to 1000 raw uploaded records to populate dynamic discovery lists instantly
      try {
        const q = query(collection(db, 'kpi_uploads'), limit(10000));
        const uploadsSnap = await getDocs(q);
        setAllRecentUploads(uploadsSnap.docs.map(d => ({ ...d.data(), docId: d.id })));
      } catch (errUpload) {
        console.warn('Silent authorization fallback for kpi_uploads reads: ', errUpload);
      }

    } catch (err) {
      console.error('Error fetching scorecard resources: ', err);
      toast.error('Failed to sync Firestore KPI Scorecard system collections.');
      handleFirestoreError(err, OperationType.LIST, 'kpi_scorecards');
    }
  };

  // Synchronize Template Designer when selected config role changes
  useEffect(() => {
    const matched = kpiTemplates.find(t => t.role.toUpperCase() === selectedConfigRole.toUpperCase());
    if (matched) {
      setEditEscalationPenalty(matched.majorEscalationPenalty || 0);
      setEditKpiList(matched.kpis || []);
    } else {
      // Fallback
      const defaultMatched = DEFAULT_KPI_TEMPLATES.find(t => t.role.toUpperCase() === selectedConfigRole.toUpperCase());
      if (defaultMatched) {
        setEditEscalationPenalty(defaultMatched.majorEscalationPenalty);
        setEditKpiList(defaultMatched.kpis);
      } else {
        setEditEscalationPenalty(20);
        setEditKpiList([]);
      }
    }
  }, [selectedConfigRole, kpiTemplates]);

  // Sync recent uploads for management
  useEffect(() => {
    if (activeTab === 'uploads_desk' || activeTab === 'templates_desk') {
      fetchRecentUploads();
    }
  }, [activeTab]);

  // Clean computed metrics for active selected scorecard
  const employeeScorecards = useMemo(() => {
    const emailKey = selectedEmail.toLowerCase().trim();
    let filtered = allScorecards.filter(sc => sc.employeeEmail.toLowerCase().trim() === emailKey);
    
    filtered = filtered.filter(sc => ensureDateStr(sc.reportingPeriod) === ensureDateStr(selectedPeriod));
    
    return filtered.sort((a, b) => ensureDateStr(b.reportingPeriod).localeCompare(ensureDateStr(a.reportingPeriod)));
  }, [allScorecards, selectedPeriod, selectedEmail]);

  const dashboardDailyRecordsList = useMemo(() => {
    return allRecentUploads.filter(row => {
      // 1. Match employee email
      if (selectedEmail && row.employeeEmail.toLowerCase().trim() !== selectedEmail.toLowerCase().trim()) {
        return false;
      }
      // 2. Match reporting period
      const pDate = ensureDateStr(row.reportingPeriod);
      const isPeriodMatch = (!selectedPeriod || pDate === ensureDateStr(selectedPeriod));
      if (!isPeriodMatch) return false;

      // 3. Match work date if not 'All'
      if (selectedWorkDate && selectedWorkDate !== 'All') {
        if (row.workDate !== selectedWorkDate) {
          return false;
        }
      }

      // 4. Match dashboard process filter if not 'All'
      if (selectedDashboardProcess && selectedDashboardProcess !== 'All') {
        if (row.processName !== selectedDashboardProcess) {
          return false;
        }
      }

      return true;
    }).sort((a, b) => ensureDateStr(b.workDate || b.reportingPeriod).localeCompare(ensureDateStr(a.workDate || a.reportingPeriod)));
  }, [allRecentUploads, selectedEmail, selectedPeriod, selectedWorkDate, selectedDashboardProcess]);

  const dashboardAvailableProcesses = useMemo(() => {
    const list = new Set<string>();
    employeeScorecards.forEach(sc => {
      if (sc.processName) list.add(sc.processName);
    });
    return Array.from(list).sort();
  }, [employeeScorecards]);

  const activeScorecards = useMemo(() => {
    if (selectedDashboardProcess !== 'All') {
      return employeeScorecards.filter(sc => sc.processName === selectedDashboardProcess);
    }
    return employeeScorecards;
  }, [employeeScorecards, selectedDashboardProcess]);

  const activeScorecard = useMemo(() => {
    if (activeScorecards.length === 0) return undefined;
    if (activeScorecards.length === 1) return activeScorecards[0];

    // Aggregate scorecards
    const base = activeScorecards[0];
    const totalScorecards = activeScorecards.length;
    
    let sumFinalScore = 0;
    let sumKpiScore = 0;
    let sumBonus = 0;
    let sumPenalty = 0;
    let sumMajorPenalty = 0;

    const kpiAggregationMap = new Map<string, {
      name: string;
      type: 'higher_is_better' | 'lower_is_better';
      dataValueFormat?: 'percentage' | 'duration' | 'number';
      targetSum: number;
      actualSum: number;
      weightSum: number;
      achievementPctSum: number;
      weightedScoreSum: number;
      comments: string[];
      count: number;
    }>();

    activeScorecards.forEach(sc => {
      sumFinalScore += sc.finalScore;
      sumKpiScore += sc.overallKpiScore;
      sumBonus += sc.bonusPoints;
      sumPenalty += sc.penaltyPoints;
      sumMajorPenalty += sc.majorEscalationPenalty;

      sc.kpiBreakdown?.forEach(kpi => {
        const key = kpi.name;
        if (!kpiAggregationMap.has(key)) {
          kpiAggregationMap.set(key, {
            name: kpi.name,
            type: kpi.type,
            dataValueFormat: kpi.dataValueFormat,
            targetSum: 0,
            actualSum: 0,
            weightSum: 0,
            achievementPctSum: 0,
            weightedScoreSum: 0,
            comments: [],
            count: 0
          });
        }
        const state = kpiAggregationMap.get(key)!;
        state.targetSum += kpi.target || 0;
        state.actualSum += kpi.actual || 0;
        state.weightSum += kpi.weight || 0;
        state.achievementPctSum += kpi.achievementPct || 0;
        state.weightedScoreSum += kpi.weightedScore || 0;
        if (kpi.comments) {
          state.comments.push(...kpi.comments);
        }
        state.count += 1;
      });
    });

    const aggregatedKpis = Array.from(kpiAggregationMap.values()).map(ag => {
      const avgWeight = ag.count > 0 ? (ag.weightSum / ag.count) : 0;
      const avgTarget = ag.count > 0 ? (ag.targetSum / ag.count) : 0;
      const avgActual = ag.count > 0 ? (ag.actualSum / ag.count) : 0;
      const avgAchievementPct = ag.count > 0 ? (ag.achievementPctSum / ag.count) : 0;
      const avgWeightedScore = ag.count > 0 ? (ag.weightedScoreSum / ag.count) : 0;
      
      return {
        name: ag.name,
        type: ag.type,
        dataValueFormat: ag.dataValueFormat,
        weight: Math.round(avgWeight * 100) / 100,
        target: Math.round(avgTarget * 100) / 100,
        actual: Math.round(avgActual * 100) / 100,
        achievementPct: Math.round(avgAchievementPct * 100) / 100,
        weightedScore: Math.round(avgWeightedScore * 100) / 100,
        comments: Array.from(new Set(ag.comments)) // Deduplicate comments
      } as any;
    });

    const finalAvg = Math.round((sumFinalScore / totalScorecards) * 100)/100;

    return {
      ...base,
      id: `agg_${base.employeeEmail}_${base.reportingPeriod}`,
      reportingPeriod: base.reportingPeriod,
      processName: selectedDashboardProcess === 'All' ? 'All / Mixed' : selectedDashboardProcess,
      finalScore: finalAvg,
      overallKpiScore: Math.round((sumKpiScore / totalScorecards) * 100)/100,
      bonusPoints: Math.round((sumBonus / totalScorecards) * 10)/10,
      penaltyPoints: Math.round((sumPenalty / totalScorecards) * 10)/10,
      majorEscalationPenalty: Math.round((sumMajorPenalty / totalScorecards) * 10)/10,
      kpiBreakdown: aggregatedKpis,
      rating: getPerformanceRating(finalAvg)
    } as DynamicScorecard;
  }, [activeScorecards, selectedDashboardProcess]);

  // Aggregate user selection options based on computed scorecards
  const availablePeriodOptions = useMemo(() => {
    const list = new Set<string>();
    // Pre-populate with some standard months
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      list.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
    }
    
    allScorecards.forEach(sc => {
      if (sc.reportingPeriod) list.add(sc.reportingPeriod);
    });
    return Array.from(list).sort((a,b) => b.localeCompare(a));
  }, [allScorecards]);

  // Filter leaderboard rankings based on selections
  const leaderboardRankings = useMemo(() => {
    let matches = allScorecards
      .filter(sc => {
        const pDate = ensureDateStr(sc.reportingPeriod);
        const pMatch = (pDate === ensureDateStr(selectedPeriod));
        return pMatch;
      });

    if (selectedLeaderboardType === 'role') {
      matches = matches.filter(sc => sc.role.toUpperCase() === selectedLeaderboardRole.toUpperCase());
    } else if (selectedLeaderboardType === 'process') {
      if (selectedLeaderboardProcess !== 'All') {
        matches = matches.filter(sc => sc.processName === selectedLeaderboardProcess);
      }
    } else if (selectedLeaderboardType === 'team_lead') {
      if (selectedLeaderboardTL !== 'All') {
        matches = matches.filter(sc => (sc.teamLeadName || '').toLowerCase().trim() === selectedLeaderboardTL.toLowerCase().trim());
      }
    } else if (selectedLeaderboardType === 'manager') {
      if (selectedLeaderboardMgr !== 'All') {
        matches = matches.filter(sc => {
          const mName = (sc.mappedManagerName || sc.Manager || '').toLowerCase().trim();
          return mName === selectedLeaderboardMgr.toLowerCase().trim();
        });
      }
    }
      
    matches = matches.sort((a, b) => b.finalScore - a.finalScore);
    
    return matches.map((m, idx) => ({
      rank: idx + 1,
      employeeEmail: m.employeeEmail,
      employeeName: m.employeeName,
      finalScore: m.finalScore,
      rating: m.rating,
      kpis: m.kpiBreakdown || []
    }));
  }, [allScorecards, selectedPeriod, selectedLeaderboardRole, selectedLeaderboardProcess, selectedLeaderboardType, selectedLeaderboardTL, selectedLeaderboardMgr]);

  const availableProcesses = useMemo(() => {
    const list = new Set<string>();
    
    // Extract process names from all scorecards globally across all roles & periods
    allScorecards.forEach(sc => {
      if (sc.processName && sc.processName.trim()) {
        const pClean = sc.processName.trim();
        if (pClean !== 'All' && pClean !== 'All / Mixed') {
          list.add(pClean);
        }
      }
    });

    // Extract process names from all uploads globally across all periods as a robust fallback
    allRecentUploads.forEach(row => {
      if (row.processName && row.processName.trim()) {
        const pClean = row.processName.trim();
        if (pClean !== 'All' && pClean !== 'All / Mixed') {
          list.add(pClean);
        }
      }
    });

    return Array.from(list).sort();
  }, [allScorecards, allRecentUploads]);

  const availableTeamLeads = useMemo(() => {
    const list = new Set<string>();
    allScorecards.forEach(sc => {
      if (sc.teamLeadName && sc.teamLeadName.trim()) {
        list.add(sc.teamLeadName.trim());
      }
    });
    return Array.from(list).sort();
  }, [allScorecards]);

  const availableManagers = useMemo(() => {
    const list = new Set<string>();
    allScorecards.forEach(sc => {
      const mName = sc.mappedManagerName || sc.Manager || '';
      if (mName && mName.trim()) {
        list.add(mName.trim());
      }
    });
    return Array.from(list).sort();
  }, [allScorecards]);

  // Compute stats specifically for the selected filters (Process KPI Dashboard)
  const processKpiDashboard = useMemo(() => {
    let matches = allScorecards.filter(sc => {
      const pDate = ensureDateStr(sc.reportingPeriod);
      const pMatch = (pDate === ensureDateStr(selectedPeriod));
      return pMatch;
    });

    if (selectedLeaderboardType === 'role') {
      matches = matches.filter(sc => sc.role.toUpperCase() === selectedLeaderboardRole.toUpperCase());
    } else if (selectedLeaderboardType === 'process') {
      if (selectedLeaderboardProcess !== 'All') {
        matches = matches.filter(sc => sc.processName === selectedLeaderboardProcess);
      }
    } else if (selectedLeaderboardType === 'team_lead') {
      if (selectedLeaderboardTL !== 'All') {
        matches = matches.filter(sc => (sc.teamLeadName || '').toLowerCase().trim() === selectedLeaderboardTL.toLowerCase().trim());
      }
    } else if (selectedLeaderboardType === 'manager') {
      if (selectedLeaderboardMgr !== 'All') {
        matches = matches.filter(sc => {
          const mName = (sc.mappedManagerName || sc.Manager || '').toLowerCase().trim();
          return mName === selectedLeaderboardMgr.toLowerCase().trim();
        });
      }
    }

    if (matches.length === 0) {
      let displayName = 'Global';
      if (selectedLeaderboardType === 'process') displayName = selectedLeaderboardProcess;
      else if (selectedLeaderboardType === 'team_lead') displayName = selectedLeaderboardTL;
      else if (selectedLeaderboardType === 'manager') displayName = selectedLeaderboardMgr;
      else if (selectedLeaderboardType === 'role') displayName = selectedLeaderboardRole;

      return {
        processName: displayName,
        totalEmployees: 0,
        averageScore: 0,
        averageQuality: 0,
        averageProductivity: 0,
        averageAttendance: 0,
        topPerformer: '-',
        topPerformerScore: 0,
        bottomPerformer: '-',
        bottomPerformerScore: 0
      };
    }

    // Sort to determine Top / Bottom performer
    const sorted = [...matches].sort((a, b) => b.finalScore - a.finalScore);
    const top = sorted[0];
    const bottom = sorted[sorted.length - 1];

    let qualitySum = 0, qualityCount = 0;
    let productivitySum = 0, productivityCount = 0;
    let attendanceSum = 0, attendanceCount = 0;

    matches.forEach(sc => {
      if (sc.kpiBreakdown) {
        sc.kpiBreakdown.forEach(k => {
          const kName = (k.name || '').toLowerCase().trim();
          const pAch = k.achievementPct !== undefined ? k.achievementPct : 0;
          
          if (kName.includes('quality') || kName.includes('accuracy') || kName.includes('accura')) {
            qualitySum += pAch;
            qualityCount++;
          }
          if (kName.includes('productivity') || kName.includes('production') || kName.includes('throughput') || kName.includes('volume') || kName.includes('count') || kName.includes('speed') || kName.includes('efficiency') || kName.includes('output') || kName.includes('aht')) {
            productivitySum += pAch;
            productivityCount++;
          }
          if (kName.includes('attendance') || kName.includes('present') || kName.includes('absent') || kName.includes('shrinkage') || kName.includes('adherence') || kName.includes('leave')) {
            attendanceSum += pAch;
            attendanceCount++;
          }
        });
      }
    });

    let headerName = 'Global';
    if (selectedLeaderboardType === 'process') headerName = selectedLeaderboardProcess === 'All' ? 'Global' : selectedLeaderboardProcess;
    else if (selectedLeaderboardType === 'team_lead') headerName = `TL: ${selectedLeaderboardTL}`;
    else if (selectedLeaderboardType === 'manager') headerName = `Manager: ${selectedLeaderboardMgr}`;
    else if (selectedLeaderboardType === 'role') headerName = `Role: ${selectedLeaderboardRole}`;

    return {
      processName: headerName,
      totalEmployees: matches.length,
      averageScore: Math.round(matches.reduce((sum, s) => sum + s.finalScore, 0) / matches.length * 10) / 10,
      averageQuality: qualityCount > 0 ? Math.round(qualitySum / qualityCount * 10) / 10 : 0,
      averageProductivity: productivityCount > 0 ? Math.round(productivitySum / productivityCount * 10) / 10 : 0,
      averageAttendance: attendanceCount > 0 ? Math.round(attendanceSum / attendanceCount * 10) / 10 : 0,
      topPerformer: top ? top.employeeName : '-',
      topPerformerScore: top ? top.finalScore : 0,
      bottomPerformer: bottom ? bottom.employeeName : '-',
      bottomPerformerScore: bottom ? bottom.finalScore : 0
    };
  }, [allScorecards, selectedPeriod, selectedLeaderboardRole, selectedLeaderboardProcess, selectedLeaderboardType, selectedLeaderboardTL, selectedLeaderboardMgr]);

  // Simple statistics for selected period
  const periodStats = useMemo(() => {
    const records = allScorecards.filter(sc => {
      const pDate = ensureDateStr(sc.reportingPeriod);
      return (pDate === ensureDateStr(selectedPeriod));
    });
    if (records.length === 0) return { totalUploaded: 0, averageScore: 0, outstandingCount: 0 };
    
    const sum = records.reduce((acc, c) => acc + c.finalScore, 0);
    const outs = records.filter(sc => sc.finalScore >= 100).length;
    
    return {
      totalUploaded: records.length,
      averageScore: Math.round((sum / records.length) * 10) / 10,
      outstandingCount: outs
    };
  }, [allScorecards, selectedPeriod]);

  // Auto-reset stuck process filters when available choices change
  useEffect(() => {
    if (selectedDashboardProcess !== 'All' && !dashboardAvailableProcesses.includes(selectedDashboardProcess)) {
      setSelectedDashboardProcess('All');
    }
  }, [dashboardAvailableProcesses, selectedDashboardProcess]);

  useEffect(() => {
    if (selectedLeaderboardProcess !== 'All' && !availableProcesses.includes(selectedLeaderboardProcess)) {
      setSelectedLeaderboardProcess('All');
    }
  }, [availableProcesses, selectedLeaderboardProcess]);

  // Download Universal Excel Template Handler
  const downloadTemplate = () => {
    const headers = [
      'Reporting Period',
      'Employee Email',
      'Role',
      'Process Name',
      'KPI Name',
      'Target',
      'Actual',
      'Bonus',
      'Penalty',
      'Comments'
    ];
    // Create practical sample rows matching QV, QA, SME, QTL
    const sampleData = [
      ['2026-06-01', 'agent1@company.com', 'QV', 'Safe Search', 'Productivity', 100, 105, 0, 0, 'Smashed targets'],
      ['2026-06-01', 'agent1@company.com', 'QV', 'Safe Search', 'Quality', 98, 99, 0, 0, 'Zero QA flags'],
      ['2026-06-01', 'agent1@company.com', 'QV', 'Safe Search', 'Attendance', 95, 96.5, 0, 0, 'Consistent presence'],
      ['2026-06-01', 'agent1@company.com', 'QV', 'Safe Search', 'APT', 240, 210, 5, 0, 'Very fast handle times (Bonus applied)'],
      
      ['2026-06-01', 'qa1@company.com', 'QA', 'Quality', 'Audits Completed', 100, 115, 0, 0, 'Excellent volume'],
      ['2026-06-01', 'qa1@company.com', 'QA', 'Quality', 'QA Accuracy', 98, 97.5, 0, 1, 'Single minor alignment variance'],
      ['2026-06-01', 'qa1@company.com', 'QA', 'Quality', 'SLA Adherence', 100, 100, 0, 0, 'Standard on-time delivery'],
      ['2026-06-01', 'qa1@company.com', 'QA', 'Quality', 'Feedback Sessions', 20, 22, 2, 0, 'Coaching sessions with agents (Bonus applied)'],
      
      ['2026-06-01', 'tl1@company.com', 'QTL', 'Safe Search', 'Audits Coached', 30, 32, 0, 0, 'Good feedback tracking'],
      ['2026-06-01', 'tl1@company.com', 'QTL', 'Safe Search', 'Calibration Variance', 5, 3.2, 0, 0, 'Perfect team calibration'],
      ['2026-06-01', 'tl1@company.com', 'QTL', 'Safe Search', 'Team Performance', 92, 94.5, 2, 0, 'Team achieved average 94.5%'],
      ['2026-06-01', 'tl1@company.com', 'QTL', 'Safe Search', 'Attendance', 95, 95, 0, 0, 'Present']
    ];

    const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleData]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Precision360 Template');
    XLSX.writeFile(wb, 'Precision360_Universal_KPI_Template.xlsx');
    toast.success('Universal upload Excel template of size downloaded successfully.');
  };

  // Excel Universal CSV Parser
  const fetchRecentUploads = async () => {
    try {
      const q = query(collection(db, 'kpi_uploads'), orderBy('workDate', 'desc'), limit(1000));
      const snap = await getDocs(q);
      setAllRecentUploads(snap.docs.map(d => ({ ...d.data(), docId: d.id })));
    } catch (e) {
      console.error(e);
    }
  };

  const filteredRecentUploads = useMemo(() => {
    return allRecentUploads.filter(row => {
      const pDate = ensureDateStr(row.reportingPeriod);
      return (pDate === ensureDateStr(selectedPeriod));
    });
  }, [allRecentUploads, selectedPeriod]);

  const handleDeleteUpload = async (docId: string) => {
    const record = allRecentUploads.find(u => u.docId === docId);
    const reportingPeriod = record?.reportingPeriod;

    if (!confirm('Are you sure you want to delete this raw upload record? This will require a recalculation to update scorecards.')) return;
    try {
      await deleteDoc(doc(db, 'kpi_uploads', docId));
      toast.success('Upload record deleted successfully.');

      // Auto trigger recalculation for this period FIRST to ensure scorecards are in sync
      if (reportingPeriod) {
        toast.info(`Recalculating scorecards for period: ${reportingPeriod}`);
        await runDynamicKPIEngine(reportingPeriod, allUsers);
      }
      
      fetchRecentUploads();
      await fetchAllKPIData();
    } catch (e) {
      toast.error('Failed to delete upload record.');
    }
  };

  const handleStartHistoricalEdit = (row: any) => {
    setEditingHistoricalId(row.docId);
    setEditHistoricalFields({ ...row });
  };

  const handleUpdateHistoricalRecord = async (docId: string) => {
    setLoading(true);
    try {
      const ref = doc(db, 'kpi_uploads', docId);
      const updateData = {
        ...editHistoricalFields,
        updatedAt: new Date().toISOString(),
        updatedBy: user.email
      };
      
      // Clean up for Firestore
      delete (updateData as any).docId;

      await setDoc(ref, updateData, { merge: true });
      toast.success('Historical record updated successfully.');
      setEditingHistoricalId(null);
      setEditHistoricalFields({});
      
      // Auto trigger recalculation for this period FIRST
      if (updateData.reportingPeriod) {
        toast.info(`Recalculating scorecards for period: ${updateData.reportingPeriod}`);
        await runDynamicKPIEngine(updateData.reportingPeriod, allUsers);
      }

      fetchRecentUploads();
      await fetchAllKPIData();
    } catch (err) {
      console.error(err);
      toast.error('Failed to update record.');
    } finally {
      setLoading(false);
    }
  };

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();

      reader.onload = (evt) => {
        try {
          const bstr = evt.target?.result;
          const wb = XLSX.read(bstr, { type: 'binary' });
          const wsName = wb.SheetNames[0];
          const ws = wb.Sheets[wsName];
          const rawRows = XLSX.utils.sheet_to_json(ws) as any[];

          if (rawRows.length === 0) {
            toast.error("Spreadsheet appears empty. No rows parsed.");
            return;
          }

          // Dynamic Column Normalization Maps
          const parseList: KpiUploadRow[] = rawRows.map((r, index) => {
            const keys = Object.keys(r);
            const findCell = (keywords: string[], excludeKeywords: string[] = []) => {
              for (const kw of keywords) {
                const matchedKey = keys.find(k => {
                  const normalizedKey = k.toLowerCase().replace(/[\s\-_]/g, '');
                  const normalizedKw = kw.toLowerCase().replace(/[\s\-_]/g, '');
                  
                  const isExcluded = excludeKeywords.some(ex => 
                    normalizedKey.includes(ex.toLowerCase().replace(/[\s\-_]/g, ''))
                  );
                  if (isExcluded) return false;
                  
                  return normalizedKey.includes(normalizedKw);
                });
                if (matchedKey !== undefined) {
                  return r[matchedKey];
                }
              }
              return undefined;
            };

            const rawPeriod = findCell(['period', 'reporting']) || r['Reporting Period'] || r['Period'] || '2026-06-01';
            const rawDate = findCell(['workdate', 'date']) || r['Work Date'] || r['Date'];
            
            const normalizedPeriod = normalizeUploadDate(rawPeriod);
            const normalizedDate = rawDate ? normalizeUploadDate(rawDate) : normalizedPeriod;
            
            const reportingPeriod = normalizedPeriod.reportingPeriod;
            const workDate = normalizedDate.workDate;
            const email = String(findCell(['email', 'employee', 'user']) || r['Employee Email'] || r['Email'] || '').toLowerCase().trim();
            const role = String(findCell(['role']) || r['Role'] || 'QV').trim().toUpperCase();
            const processName = String(findCell(['process', 'processname']) || r['Process Name'] || '').trim();
            const kpi = String(findCell(['kpiname', 'kpi', 'metric', 'parameter']) || r['KPI Name'] || r['KPI'] || '').trim();
            const target = Number(findCell(['target']) || r['Target'] || 0);
            const actual = Number(findCell(['actual']) || r['Actual'] || 0);
            const bonus = Number(findCell(['bonus']) || r['Bonus'] || 0);
            const penalty = Number(findCell(['penalty']) || r['Penalty'] || 0);
            const comments = String(findCell(['comment', 'remarks', 'feedback', 'comments']) || r['Comments'] || r['Comment'] || '').trim();

            return {
              id: `stg-${Date.now()}-${index}`,
              reportingPeriod,
              workDate,
              employeeEmail: email,
              role,
              processName,
              kpiName: kpi,
              target,
              actual,
              bonus,
              penalty,
              comments,
              hasMajorEscalation: false
            };
          }).filter(r => r.employeeEmail !== '' && r.kpiName !== '');

          if (parseList.length === 0) {
            toast.warning("No rows parsed correctly. Ensure your spreadsheet contains Email and KPI Name columns.");
            return;
          }
          
          // New Validation for Process Name
          const missingProcess = parseList.find(r => !r.processName);
          if (missingProcess) {
            toast.error(`Upload rejected: Process Name is mandatory. Missing in row for ${missingProcess.employeeEmail}.`);
            return;
          }

          setStagingData(parseList);
          setStagingFileName(file.name);
          toast.success(`Successfully parsed ${parseList.length} items to the staging desk!`);
        } catch (err) {
          toast.error("Spreadsheet format parser failed. Check alignment headers.");
          console.error(err);
        }
      };

      reader.readAsBinaryString(file);
    }
  };

  // Staging Inline Inline Editor Helpers
  const handleStartStagingEdit = (row: KpiUploadRow) => {
    setEditingStagingId(row.id);
    setEditRowFields({ ...row });
  };

  const handleSaveStagingRow = () => {
    if (!editingStagingId) return;

    setStagingData(prev => 
      prev.map(row => {
        if (row.id === editingStagingId) {
          return {
            ...row,
            ...editRowFields,
            employeeEmail: (editRowFields.employeeEmail || row.employeeEmail).toLowerCase().trim(),
            role: (editRowFields.role || row.role).toUpperCase().trim()
          } as KpiUploadRow;
        }
        return row;
      })
    );

    setEditingStagingId(null);
    setEditRowFields({});
    toast.success("Row committed in memory!");
  };

  const handleRemoveStagingRow = (id: string) => {
    setStagingData(prev => prev.filter(row => row.id !== id));
    toast.info("Staged record deleted.");
  };

  /**
   * Commit Raw staging rows to 'kpi_uploads' Firestore collection,
   * then auto-calculate scorecards for that period
   */
  const handleCommitUploadGrid = async () => {
    if (stagingData.length === 0) {
      toast.error("Staging desk is empty. No uploads found.");
      return;
    }

    setLoading(true);
    try {
      const chunkArray = <T,>(arr: T[], size: number): T[][] =>
        Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
          arr.slice(i * size, i * size + size)
        );

      const dataChunks = chunkArray<KpiUploadRow>(stagingData, 400);
      
      for (const chunk of dataChunks) {
        const batch = writeBatch(db);
        chunk.forEach((row: KpiUploadRow) => {
          const safeProcess = (row.processName || 'Shared').replace(/[\s\/]+/g, '_');
          const finalWorkDate = row.workDate || `${row.reportingPeriod}-01`;
          const uniqueDocId = doc(collection(db, 'kpi_uploads')).id;
          const ref = doc(db, 'kpi_uploads', uniqueDocId);
          batch.set(ref, {
            ...row,
            id: uniqueDocId,
            workDate: finalWorkDate,
            uploadedAt: new Date().toISOString(),
            uploadedBy: user.email
          });
        });
        await batch.commit();
      }
      toast.success(`Committed ${stagingData.length} records successfully to 'kpi_uploads' collection!`);

      // Extract unique reporting periods present
      const uniquePeriods = Array.from(new Set(stagingData.map(r => r.reportingPeriod))) as string[];
      
      // Auto trigger recalculation for these periods to keep dashboard perfectly in sync
      toast.info(`Triggering KPI calculation engine running for period(s): ${uniquePeriods.join(', ')}`);
      for (const period of uniquePeriods) {
        await runDynamicKPIEngine(period, allUsers);
      }
      
      // Refresh all scorecards after engine completes
      await fetchAllKPIData();
      
      setStagingData([]);
      setStagingFileName('');
      await fetchAllKPIData();
      
      if (onRefreshAllData) onRefreshAllData();
      toast.success(`KPI calculations successfully loaded! All leaderboards & scorecards are updated.`);

    } catch (err) {
      console.error('Failed to commit uploads: ', err);
      toast.error('Failed to synchronize commits with Firestore database.');
      handleFirestoreError(err, OperationType.WRITE, 'kpi_uploads');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Trigger Manual Calculation & Publishing for selected period
   */
  const handleRecalculatePeriodScorecards = async () => {
    // Validation: If no KPI records exist, show required error message
    if (availablePeriods.length === 0) {
      toast.error("No KPI records found for calculation.");
      return;
    }

    if (!selectedPeriod) {
      toast.error("No KPI records found for calculation.");
      return;
    }

    setProcessingRecalc(true);
    try {
      const rez = await runDynamicKPIEngine(selectedPeriod, allUsers);
      await fetchAllKPIData();
      
      if (rez.scorecardsCount > 0) {
        toast.success(`Success! Re-compiled and published ${rez.scorecardsCount} scorecard records for period ${selectedPeriod}.`);
      } else {
        toast.warning(`No raw entries mapped under 'kpi_uploads' for period ${selectedPeriod}. Upload files first!`);
      }
    } catch (err) {
      console.error(err);
      toast.error('No KPI records found for calculation.');
    } finally {
      setProcessingRecalc(false);
    }
  };

  /**
   * KPI Template Manager Config Console Helpers
   */
  const handleAddKpiToTemplate = () => {
    if (!newKpiName.trim()) {
      toast.error("KPI Name cannot be empty.");
      return;
    }
    if (newKpiWeight <= 0 || newKpiWeight > 100) {
      toast.error("KPI weight must be of scale 1 to 100.");
      return;
    }

    // Check duplicate
    if (editKpiList.some(k => k.name.toLowerCase().trim() === newKpiName.toLowerCase().trim())) {
      toast.error("A KPI with this name is already allocated.");
      return;
    }

    setEditKpiList(prev => [
      ...prev,
      { 
        name: newKpiName.trim(), 
        weight: newKpiWeight, 
        type: newKpiType,
        dataValueFormat: newKpiFormat 
      }
    ]);
    
    setNewKpiName('');
    toast.success(`${newKpiName} added to template in sandbox memory.`);
  };

  const handleRemoveKpiFromTemplate = (name: string) => {
    setEditKpiList(prev => prev.filter(k => k.name !== name));
    toast.info("KPI definition withdrawn.");
  };

  const handleSaveKpiTemplateDoc = async () => {
    const totalWeight = editKpiList.reduce((acc, curr) => acc + curr.weight, 0);
    if (totalWeight !== 100) {
      toast.error(`Invalid Weights total. Combined weights must equal exactly 100%. Currently they equal: ${totalWeight}%`);
      return;
    }

    setLoading(true);
    try {
      const templateDoc: KpiTemplate = {
        role: selectedConfigRole,
        kpis: editKpiList,
        majorEscalationPenalty: editEscalationPenalty,
        updatedAt: new Date().toISOString()
      };

      const ref = doc(db, 'kpi_templates', selectedConfigRole);
      await setDoc(ref, templateDoc);

      toast.success(`KPI Template config for ${selectedConfigRole} updated completely!`);
      await fetchAllKPIData();
    } catch (err) {
      console.error('Failed to save KPI Template:', err);
      toast.error('Failed to store template document to database.');
      handleFirestoreError(err, OperationType.WRITE, 'kpi_templates');
    } finally {
      setLoading(false);
    }
  };

  // Clean staging shelf
  const clearStagingShelf = () => {
    setStagingData([]);
    setStagingFileName('');
    toast.info("Excel staging grid cleared.");
  };

  const renderDataValue = (val: number, format?: string) => {
    if (format === 'percentage') return `${val}%`;
    if (format === 'duration') {
      if (val >= 60) {
        const h = Math.floor(val / 60);
        const m = Math.round(val % 60);
        return `${h}h ${m}m`;
      }
      return `${val}m`;
    }
    return val;
  };

  // Recharts Chart Dataset Setup
  const performanceChartData = useMemo(() => {
    const group = allScorecards.filter(sc => sc.employeeEmail.toLowerCase().trim() === selectedEmail.toLowerCase().trim());
    return group.map(sc => ({
      period: sc.reportingPeriod,
      Score: sc.finalScore,
      KPI_Sub: sc.overallKpiScore
    })).sort((a,b) => a.period.localeCompare(b.period));
  }, [allScorecards, selectedEmail]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
      
      {/* Banner Heading */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-8 rounded-2xl border border-slate-800 shadow-xl relative overflow-hidden">
        <div className="absolute right-0 top-0 opacity-10 pointer-events-none transform translate-x-12 -translate-y-12">
          <Award size={220} className="text-white" />
        </div>
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1.5">
            <Badge className="bg-indigo-500 hover:bg-indigo-600 text-[10px] font-extrabold uppercase tracking-widest px-3 py-1">
              SYSTEM CONSOLE
            </Badge>
            <h1 className="text-3xl font-black tracking-tight flex items-center gap-2">
              Precision360 <span className="text-indigo-400 font-extrabold">KPI Scorecard Engine</span>
            </h1>
            <p className="text-sm font-medium text-slate-300 max-w-xl">
              Fully dynamic, template-driven analytics workstation. Configure templates, upload universal files, resolve weights, and calculate scorecards without editing code.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <Button 
              onClick={fetchAllKPIData} 
              disabled={loading}
              variant="outline"
              className="border-slate-700 bg-slate-900/60 text-white hover:bg-slate-800 h-10 px-4 font-bold text-xs gap-2 cursor-pointer"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              Sync DB Indexes
            </Button>
            
            {canManageKPIs && (
              <Button 
                onClick={handleRecalculatePeriodScorecards} 
                disabled={processingRecalc || loading}
                className="bg-indigo-600 hover:bg-indigo-700 text-white h-10 px-4 font-extrabold text-xs gap-2 shadow-lg cursor-pointer"
              >
                <Sliders size={14} className={processingRecalc ? "animate-spin" : ""} />
                {processingRecalc ? 'Recalculating...' : 'Publish Scorecards'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Workspace Menu Bar & Global Filters */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Workspace Toolbar card */}
        <div className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-150 dark:border-slate-800 p-6 rounded-2xl shadow-sm space-y-5 h-fit">
          <div>
            <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-wider">Workspace Controls</h3>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 font-medium">Select criteria for viewing and reporting</p>
          </div>

          <div className="space-y-4">
            
            {/* Reporting Period dropdown selector */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-extrabold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Reporting Period</label>
              </div>
              
              <div className="relative">
                <div 
                  className="w-full text-xs font-bold h-10 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 cursor-pointer outline-none flex items-center justify-between group hover:border-indigo-300 dark:hover:border-indigo-500 transition-colors text-slate-900 dark:text-slate-100"
                  onClick={() => setIsPeriodDropdownOpen(!isPeriodDropdownOpen)}
                >
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-indigo-500" />
                    <span className="truncate">{formatPeriodDisplay(selectedPeriod) || "Select period..."}</span>
                  </div>
                  <ChevronDown size={14} className={cn("text-slate-400 transition-transform duration-200", isPeriodDropdownOpen && "rotate-180")} />
                </div>
                
                {isPeriodDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsPeriodDropdownOpen(false)} />
                    <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-xl rounded-lg max-h-60 overflow-y-auto w-full p-1 space-y-0.5 animate-in fade-in zoom-in-95 duration-150">
                      {availablePeriods.map(p => (
                        <div
                          key={p}
                          className={`px-3 py-2.5 text-xs rounded-md cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/50 flex items-center justify-between transition-colors ${selectedPeriod === p ? "bg-indigo-50 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-400 font-bold" : "text-slate-700 dark:text-slate-300 font-medium"}`}
                          onClick={() => {
                            setSelectedPeriod(p);
                            setIsPeriodDropdownOpen(false);
                          }}
                        >
                          <span>{formatPeriodDisplay(p)}</span>
                          {selectedPeriod === p && <Check size={12} className="text-indigo-600 dark:text-indigo-400" />}
                        </div>
                      ))}
                      {availablePeriods.length === 0 && (
                        <div className="px-3 py-4 text-xs text-center text-slate-400 font-medium italic">No KPI records found</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Work Date Filter */}
            <div className="space-y-3">
              <label className="text-[10px] font-extrabold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Work Date Filter</label>
              <div className="relative">
                <div 
                  className="w-full text-xs font-bold h-10 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 cursor-pointer outline-none flex items-center justify-between group hover:border-indigo-300 dark:hover:border-indigo-500 transition-colors text-slate-900 dark:text-slate-100"
                  onClick={() => setIsWorkDateDropdownOpen(!isWorkDateDropdownOpen)}
                >
                  <div className="flex items-center gap-2">
                    <Clock size={14} className="text-slate-400 dark:text-slate-500" />
                    <span className="truncate">{selectedWorkDate === 'All' ? 'All Work Dates' : selectedWorkDate}</span>
                  </div>
                  <ChevronDown size={14} className={cn("text-slate-400 dark:text-slate-500 transition-transform duration-200", isWorkDateDropdownOpen && "rotate-180")} />
                </div>
                
                {isWorkDateDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsWorkDateDropdownOpen(false)} />
                    <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-xl rounded-lg max-h-60 overflow-y-auto w-full p-1 space-y-0.5 animate-in fade-in zoom-in-95 duration-150">
                      <div
                        className={`px-3 py-2.5 text-xs rounded-md cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/50 flex items-center justify-between transition-colors ${selectedWorkDate === 'All' ? "bg-indigo-50 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-400 font-bold" : "text-slate-700 dark:text-slate-300 font-medium"}`}
                        onClick={() => {
                          setSelectedWorkDate('All');
                          setIsWorkDateDropdownOpen(false);
                        }}
                      >
                        <span>All Work Dates</span>
                        {selectedWorkDate === 'All' && <Check size={12} className="text-indigo-600 dark:text-indigo-400" />}
                      </div>
                      {availableWorkDates.map(d => (
                        <div
                          key={d}
                          className={`px-3 py-2.5 text-xs rounded-md cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/50 flex items-center justify-between transition-colors ${selectedWorkDate === d ? "bg-indigo-50 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-400 font-bold" : "text-slate-700 dark:text-slate-300 font-medium"}`}
                          onClick={() => {
                            setSelectedWorkDate(d);
                            setIsWorkDateDropdownOpen(false);
                          }}
                        >
                          <span>{d}</span>
                          {selectedWorkDate === d && <Check size={12} className="text-indigo-600 dark:text-indigo-400" />}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Dashboard specific Process filter (only when activeTab = dashboard) */}
            {activeTab === 'dashboard' && dashboardAvailableProcesses.length > 0 && (
              <div className="space-y-1.5 mt-4">
                <label className="text-[10px] font-extrabold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Process Filter</label>
                <select 
                  value={selectedDashboardProcess}
                  onChange={(e) => setSelectedDashboardProcess(e.target.value)}
                  className="w-full text-xs font-bold h-10 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 flex items-center text-slate-900 dark:text-slate-100 outline-none focus:ring-1 focus:ring-indigo-500 transition-shadow appearance-none"
                >
                  <option value="All">All / Mixed Processes</option>
                  {dashboardAvailableProcesses.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
            )}
            
            <div className="space-y-1.5 relative mt-4">
              <label className="text-[10px] font-extrabold text-slate-500 dark:text-slate-400 uppercase tracking-wider pl-1">Employee Match</label>
              {isQAorAgent ? (
                <div className="w-full text-xs font-bold h-10 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 px-3 flex items-center text-slate-600 dark:text-slate-400">
                  {user.name} ({user.email})
                </div>
              ) : (
                <UserPicker 
                  onSelect={(u) => setSelectedEmail(u.email)}
                  selectedUserId={allUsers.find(u => u.email === selectedEmail)?.uid}
                  placeholder="Select or search employee..."
                  className="mt-1"
                />
              )}
            </div>
          </div>

          <hr className="border-slate-100 dark:border-slate-800" />

          {/* Quick Period Summary Statistics */}
          <div className="space-y-3.5 bg-slate-50/60 dark:bg-slate-800/60 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
            <h4 className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500 tracking-widest">Period {selectedPeriod} Summary</h4>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <span className="block text-[10px] font-bold text-slate-400 dark:text-slate-500">Published</span>
                <span className="text-sm font-black text-slate-800 dark:text-slate-200">{periodStats.totalUploaded}</span>
              </div>
              <div className="border-x border-slate-200 dark:border-slate-800">
                <span className="block text-[10px] font-bold text-slate-400 dark:text-slate-500">Avg Score</span>
                <span className="text-sm font-black text-slate-800 dark:text-slate-200">{periodStats.averageScore}%</span>
              </div>
              <div>
                <span className="block text-[10px] font-bold text-slate-400 dark:text-slate-500">Outstanding</span>
                <span className="text-sm font-black text-slate-800 dark:text-slate-200">{periodStats.outstandingCount}</span>
              </div>
            </div>
            
            {/* Common Themes */}
            <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <span className="block text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Common Themes</span>
              <div className="flex flex-wrap gap-1 justify-center">
                {(() => {
                  const comments = dashboardDailyRecordsList.map(r => r.comments).filter(Boolean);
                  const words = comments.join(' ').toLowerCase().split(/\s+/);
                  const stopWords = ['the', 'and', 'a', 'to', 'for', 'was', 'is', 'in', 'on', 'with', 'are', 'i', 'it', 'was', 'of', 'this'];
                  const counts: Record<string, number> = {};
                  words.forEach(w => {
                      if (w.replace(/[^a-z]/g, '').length > 3 && !stopWords.includes(w.replace(/[^a-z]/g, ''))) {
                          const cleanW = w.replace(/[^a-z]/g, '');
                          counts[cleanW] = (counts[cleanW] || 0) + 1;
                      }
                  });
                  const topThemes = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
                  return topThemes.length > 0 ? topThemes.map(theme => (
                      <Badge key={theme} variant="secondary" className="text-[10px] bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 border-none">{theme}</Badge>
                  )) : <span className="text-[10px] text-slate-400 dark:text-slate-500 italic">No themes found</span>;
                })()}
              </div>
            </div>
          </div>

          <hr className="border-slate-50 dark:border-slate-800/40" />

          {/* Tab Selection */}
          <div className="flex flex-col gap-1">
            <Button 
              variant={activeTab === 'dashboard' ? 'default' : 'ghost'}
              onClick={() => setActiveTab('dashboard')}
              className={`w-full justify-start font-black text-xs h-10 gap-2.5 px-4 cursor-pointer rounded-lg ${activeTab === 'dashboard' ? 'bg-slate-900 dark:bg-indigo-600 text-white shadow-lg' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            >
              <LayoutGrid size={15} />
              Performance Dashboard
            </Button>

            <Button 
              variant={activeTab === 'leaderboard' ? 'default' : 'ghost'}
              onClick={() => setActiveTab('leaderboard')}
              className={`w-full justify-start font-black text-xs h-10 gap-2.5 px-4 cursor-pointer rounded-lg ${activeTab === 'leaderboard' ? 'bg-slate-900 dark:bg-indigo-600 text-white shadow-lg' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            >
              <Trophy size={15} />
              Role Leaderboards
            </Button>

            {canManageKPIs && (
              <Button 
                variant={activeTab === 'uploads_desk' ? 'default' : 'ghost'}
                onClick={() => setActiveTab('uploads_desk')}
                className={`w-full justify-start font-black text-xs h-10 gap-2.5 px-4 cursor-pointer rounded-lg ${activeTab === 'uploads_desk' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
              >
                <FileSpreadsheet size={15} />
                KPI Universal Upload Desk
              </Button>
            )}

            {canEdit('Console') && (
              <>
                <Button 
                  variant={activeTab === 'templates_desk' ? 'default' : 'ghost'}
                  onClick={() => setActiveTab('templates_desk')}
                  className={`w-full justify-start font-black text-xs h-10 gap-2.5 px-4 cursor-pointer rounded-lg ${activeTab === 'templates_desk' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  <Settings size={15} />
                  KPI Pattern Editor
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Content Tabs Area */}
        <div className="lg:col-span-8 space-y-6">
          
          {/* TAB 1: Dynamic Performance scorecards */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              
              {activeScorecard ? (
                <>
                  {/* Headline score indicators */}
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
                    
                    {/* Primary final score output */}
                    <Card className="md:col-span-5 bg-gradient-to-br from-indigo-50/50 to-white dark:from-indigo-900/20 dark:to-slate-900 border-slate-150 dark:border-slate-800 shadow-sm rounded-2xl flex flex-col justify-between">
                      <CardHeader className="pb-2">
                        <span className="text-[10px] font-extrabold uppercase text-slate-400 dark:text-slate-500 tracking-wider">Published Final Score</span>
                        <div className="flex items-baseline gap-2">
                          <span className="text-5xl font-black text-slate-900 dark:text-white tracking-tight">
                            {activeScorecard.finalScore}%
                          </span>
                        </div>
                      </CardHeader>
                      <CardContent className="py-2">
                        <div className="space-y-1">
                          <span className="text-[10px] font-extrabold uppercase text-indigo-600 dark:text-indigo-400 tracking-wider">Classification</span>
                          <p className="text-lg font-black text-indigo-950 dark:text-indigo-100 leading-none">
                            {activeScorecard.rating}
                          </p>
                        </div>
                      </CardContent>
                      <CardFooter className="bg-slate-50/40 dark:bg-slate-800/40 border-t border-slate-100 dark:border-slate-800 py-3 px-6 rounded-b-2xl flex justify-between text-xs font-bold text-slate-500 dark:text-slate-400">
                        <span className="flex items-center gap-1">
                          <Calendar size={13} className="text-slate-400 dark:text-slate-500" />
                          {activeScorecard.reportingPeriod}
                        </span>
                        <span>Rank #{activeScorecard.rank} inside {activeScorecard.role}</span>
                      </CardFooter>
                    </Card>

                    {/* Meta information indicators */}
                    <Card className="md:col-span-7 border-slate-150 dark:border-slate-800 shadow-sm rounded-2xl flex flex-col justify-between dark:bg-slate-900">
                      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
                        <div>
                          <CardTitle className="text-xs font-bold uppercase text-slate-400 dark:text-slate-500">Employee Details</CardTitle>
                          <h4 className="text-md font-black text-slate-900 dark:text-white mt-1">{activeScorecard.employeeName}</h4>
                          <p className="text-xs text-slate-400 dark:text-slate-500 font-semibold">{activeScorecard.employeeEmail}</p>
                        </div>
                        <Badge className="bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border-none text-slate-800 dark:text-slate-200 text-[10px] font-black tracking-wider px-3.5 h-7">
                          {activeScorecard.role}
                        </Badge>
                      </CardHeader>
                      <CardContent className="grid grid-cols-2 gap-4 pb-4 bg-slate-50/20 dark:bg-slate-800/30 px-6 py-4 border-t border-slate-100 dark:border-slate-800 rounded-b-2xl">
                        <div>
                          <span className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block">Combined Bonus</span>
                          <span className="text-sm font-black text-emerald-600 dark:text-emerald-500">+{activeScorecard.bonusPoints} points</span>
                        </div>
                        <div>
                          <span className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block">Combined Penalty</span>
                          <span className="text-sm font-black text-rose-600 dark:text-rose-500">-{activeScorecard.penaltyPoints} points</span>
                        </div>
                        <div>
                          <span className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block">Major Esc. Penalty</span>
                          <span className={`text-sm font-black ${activeScorecard.hasMajorEscalation ? "text-rose-600 dark:text-rose-500" : "text-slate-400 dark:text-slate-500"}`}>
                            {activeScorecard.hasMajorEscalation ? `-${activeScorecard.majorEscalationPenalty} points` : 'N/A'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block">KPI Weights Matched</span>
                          <span className="text-sm font-black text-slate-800 dark:text-slate-200">{activeScorecard.overallKpiScore}% base</span>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Dynamic KPI Breakdown Table (no hardcoding of fields!) */}
                  <Card className="border-slate-150 dark:border-slate-800 shadow-sm rounded-2xl overflow-hidden dark:bg-slate-900">
                    <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
                      <div className="flex items-center gap-2">
                        <Sliders size={17} className="text-indigo-600 dark:text-indigo-400 animate-pulse" />
                        <div>
                          <CardTitle className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-wider">Dynamic KPI Target vs Actual breakdown</CardTitle>
                          <CardDescription className="text-xs text-slate-400 dark:text-slate-500 font-medium">Auto-computed achievements derived from raw uploads for role {activeScorecard.role}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <Table>
                      <TableHeader className="bg-slate-50/60 dark:bg-slate-800/60 font-black">
                        <TableRow className="border-b border-slate-150 dark:border-slate-800">
                          <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black">KPI Name</TableHead>
                          <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Direction</TableHead>
                          <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Weight</TableHead>
                          <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Target</TableHead>
                          <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Actual</TableHead>
                          <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Achievement %</TableHead>
                          <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-right">Weighted score</TableHead>
                          <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(activeScorecard.kpiBreakdown || []).map((kpi, idx) => (
                          <TableRow key={idx} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors">
                            <TableCell className="font-extrabold text-xs text-slate-800 dark:text-slate-200">{kpi.name}</TableCell>
                            <TableCell className="text-center">
                              <Badge variant="outline" className={`text-[9px] tracking-wide font-black uppercase ${kpi.type === 'higher_is_better' ? "text-emerald-700 bg-emerald-50/50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-800" : "text-amber-700 bg-amber-50/50 dark:bg-amber-900/20 border-amber-100 dark:border-amber-800"}`}>
                                {kpi.type === 'higher_is_better' ? 'Higher Is Better' : 'Lower Is Better'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center text-xs font-extrabold text-slate-500 dark:text-slate-400">{kpi.weight}%</TableCell>
                            <TableCell className="text-center text-xs font-extrabold text-slate-900 dark:text-white">{renderDataValue(kpi.target, kpi.dataValueFormat)}</TableCell>
                            <TableCell className="text-center text-xs font-extrabold text-slate-900 dark:text-white">{renderDataValue(kpi.actual, kpi.dataValueFormat)}</TableCell>
                            <TableCell className="text-center">
                              <Badge className={cn("text-xs font-black border-none", getRatingColor(kpi.achievementPct))}>
                                {kpi.achievementPct}%
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right text-xs font-black text-slate-900 dark:text-white">{kpi.weightedScore}%</TableCell>
                            <TableCell className="text-right">
                                <Button 
                                    variant="ghost" 
                                    size="sm" 
                                    onClick={() => setActiveKpiComment({ kpiName: kpi.name, email: activeScorecard.employeeEmail, period: activeScorecard.reportingPeriod })}
                                    className="dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800"
                                >
                                    <History size={14} className="mr-1.5" />
                                    View History
                                </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>

                  {/* Metric comments/justification panel */}
                  <Card className="border-slate-150 dark:border-slate-800 shadow-sm rounded-2xl p-6 space-y-4 dark:bg-slate-900">
                    <h4 className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-2">
                       Comments & Highlights discovered
                    </h4>
                    {(activeScorecard.kpiBreakdown || []).some(k => k.latestComment) ? (
                      <div className="space-y-2.5">
                        {(activeScorecard.kpiBreakdown || []).filter(k => k.latestComment).map((kpi, kIdx) => (
                            <div key={`latest-${kIdx}`} className="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-lg border border-slate-100 dark:border-slate-700 flex gap-2">
                              <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full mt-1 shrink-0" />
                              <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 leading-relaxed">
                                <strong className="text-slate-800 dark:text-slate-200 pr-1">{kpi.name} ({kpi.commentCount} comments):</strong>
                                Latest: {kpi.latestComment}
                              </p>
                            </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 dark:text-slate-500 font-medium italic">No comments uploaded for this agent period.</p>
                    )}
                  </Card>
                  
                  {activeKpiComment && (
                    <KpiCommentHistorySidePanel 
                        isOpen={!!activeKpiComment} 
                        onClose={() => setActiveKpiComment(null)} 
                        kpiName={activeKpiComment.kpiName} 
                        email={activeKpiComment.email} 
                        reportingPeriod={activeKpiComment.period}
                    />
                  )}

                  {/* Historic Trend Line Charts */}
                  {performanceChartData.length > 1 && (
                    <Card className="border-slate-150 dark:border-slate-800 shadow-sm p-6 rounded-2xl dark:bg-slate-900">
                      <h4 className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-wider mb-4 flex items-center gap-1.5">
                        <TrendingUp size={16} className="text-indigo-600 dark:text-indigo-400" /> Scoring Progression over periods
                      </h4>
                      <div className="h-60 w-full text-xs font-semibold">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={performanceChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <defs>
                              <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2}/>
                                <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke={theme === 'dark' ? '#1e293b' : '#f1f5f9'} />
                            <XAxis dataKey="period" stroke="#94a3b8" />
                            <YAxis stroke="#94a3b8" domain={[0, 120]} />
                            <Tooltip 
                                contentStyle={theme === 'dark' ? { backgroundColor: '#0f172a', borderColor: '#1e293b', borderRaduis: '8px' } : undefined}
                                itemStyle={theme === 'dark' ? { color: '#f8fafc' } : undefined}
                                formatter={(value) => [`${value}%`]} 
                            />
                            <Legend />
                            <Area type="monotone" dataKey="Score" stroke="#6366f1" strokeWidth={2.5} fillOpacity={1} fill="url(#scoreGrad)" name="Final Score %" />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  )}
                </>
              ) : (
                <Card className="border border-slate-150 p-8 rounded-2xl text-center space-y-4">
                  <div className="w-12 h-12 bg-indigo-50 rounded-full flex items-center justify-center mx-auto text-indigo-600">
                    <Sliders size={20} className="animate-spin" />
                  </div>
                  <div>
                    <h3 className="text-md font-black text-slate-900">Scorecard Calculation Pending</h3>
                    <p className="text-xs text-slate-400 font-medium max-w-sm mx-auto mt-1">
                      No scorecard has been generated for <strong>{selectedEmail}</strong> during period <strong>{selectedPeriod}</strong> yet.
                    </p>
                  </div>
                  {canManageKPIs && (
                    <Button 
                      onClick={handleRecalculatePeriodScorecards} 
                      disabled={processingRecalc}
                      className="bg-indigo-600 text-white font-extrabold text-xs h-9 gap-1.5 shadow-md cursor-pointer"
                    >
                      <RefreshCw size={12} className={processingRecalc ? 'animate-spin' : ''} />
                      Publish & Calculate Scorecards
                    </Button>
                  )}
                </Card>
              )}

              {/* Daily Performance Records Activity timeline & Employee History */}
              <Card className="border border-slate-150 shadow-sm rounded-2xl overflow-hidden mt-6 bg-white">
                <CardHeader className="bg-slate-50/50 p-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <CardTitle className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5 leading-none">
                      <History size={14} className="text-indigo-600" />
                      Daily Performance Records & Timeline
                    </CardTitle>
                    <CardDescription className="text-[10px] text-slate-400 font-semibold mt-1">
                      {selectedEmail ? `Activity history of raw KPI uploads for ${selectedEmail}` : 'Select an employee from the sidebar to track historical activity'}
                    </CardDescription>
                  </div>
                  <div className="text-[10px] bg-indigo-50 text-indigo-700 font-extrabold px-2.5 py-1 rounded">
                    {dashboardDailyRecordsList.length} records matched
                  </div>
                </CardHeader>
                <div className="overflow-x-auto max-h-[350px]">
                  <Table className="w-full">
                    <TableHeader className="bg-slate-50/30 font-black shrink-0 sticky top-0">
                      <TableRow className="border-b border-slate-100">
                        <TableHead className="text-slate-500 text-[10px] font-black uppercase py-2 pl-4">Work Date</TableHead>
                        <TableHead className="text-slate-500 text-[10px] font-black uppercase text-center py-2">Period</TableHead>
                        <TableHead className="text-slate-500 text-[10px] font-black uppercase text-center py-2">Process Name</TableHead>
                        <TableHead className="text-slate-500 text-[10px] font-black uppercase text-center py-2">KPI Name</TableHead>
                        <TableHead className="text-slate-500 text-[10px] font-black uppercase text-center py-2">Target</TableHead>
                        <TableHead className="text-slate-500 text-[10px] font-black uppercase text-center py-2">Actual</TableHead>
                        <TableHead className="text-slate-500 text-[10px] font-black uppercase text-center py-2">Bonus/Penalty</TableHead>
                        <TableHead className="text-slate-500 text-[10px] font-black uppercase py-2 pr-4 text-right">Comments</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dashboardDailyRecordsList.length > 0 ? (
                        dashboardDailyRecordsList.map((row, idx) => (
                          <TableRow key={row.docId || idx} className="hover:bg-slate-50/40 bg-white border-b border-slate-50">
                            <TableCell className="py-2.5 pl-4">
                              <span className="font-extrabold text-xs text-slate-900">{row.workDate || '-'}</span>
                            </TableCell>
                            <TableCell className="text-center py-2.5">
                              <span className="font-bold text-[11px] text-slate-500">{row.reportingPeriod}</span>
                            </TableCell>
                            <TableCell className="text-center py-2.5">
                              <span className="font-semibold text-xs text-slate-600">{row.processName}</span>
                            </TableCell>
                            <TableCell className="text-center py-2.5">
                              <Badge variant="outline" className="text-[10px] font-extrabold uppercase text-indigo-700 bg-indigo-50/30 border-indigo-100 px-2 h-5">
                                {row.kpiName}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center py-2.5 font-bold text-xs text-slate-500">{row.target}</TableCell>
                            <TableCell className="text-center py-2.5 font-extrabold text-xs text-slate-800">{row.actual}</TableCell>
                            <TableCell className="text-center py-2.5">
                              <span className="text-[11px] font-bold text-slate-500">
                                {row.bonus > 0 ? <span className="text-emerald-600 font-extrabold pr-1">+{row.bonus}B</span> : null}
                                {row.penalty > 0 ? <span className="text-rose-600 font-extrabold">-{row.penalty}P</span> : null}
                                {!row.bonus && !row.penalty ? '-' : null}
                              </span>
                            </TableCell>
                            <TableCell className="py-2.5 text-right pr-4">
                              <span className="text-[11px] text-slate-400 font-medium italic block max-w-xs truncate ml-auto" title={row.comments}>
                                {row.comments || '-'}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center py-8 text-xs text-slate-400 italic font-medium">
                            No daily records matched selected criteria. Choose another employee, period, or work-date.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            </div>
          )}

          {/* TAB 2: Leaders compilation */}
          {activeTab === 'leaderboard' && (
            <Card className="border-slate-150 shadow-sm rounded-2xl overflow-hidden">
              <CardHeader className="bg-gradient-to-b from-slate-50/50 to-white border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4">
                <div>
                  <CardTitle className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                    <Trophy size={16} className="text-amber-500" /> Dynamic Role-Based Leaderboards
                  </CardTitle>
                  <CardDescription className="text-xs text-slate-400 font-medium mt-1">
                    Ranking of employees for period {selectedPeriod} based on final dynamic scores
                  </CardDescription>
                </div>

                <div className="flex flex-wrap gap-2">
                  {/* Available Reporting Period Selector */}
                  <select
                    value={selectedPeriod}
                    onChange={(e) => setSelectedPeriod(e.target.value)}
                    className="h-9 text-xs font-black rounded-lg border border-indigo-200 bg-white text-indigo-700 px-2.5 outline-none focus:ring-1 focus:ring-indigo-600 cursor-pointer"
                  >
                    {availablePeriods.map(p => (
                      <option key={p} value={p}>Period: {p}</option>
                    ))}
                    {availablePeriods.length === 0 && (
                      <option value="">No KPI records found</option>
                    )}
                  </select>

                  {/* Leaderboard Type Selector */}
                  <select 
                    value={selectedLeaderboardType}
                    onChange={(e) => setSelectedLeaderboardType(e.target.value)}
                    className="h-9 text-xs font-black rounded-lg border border-indigo-200 bg-indigo-50/50 text-indigo-700 px-2.5 outline-none focus:ring-1 focus:ring-indigo-600 cursor-pointer"
                  >
                    <option value="role">Role Group</option>
                    <option value="process">Process Group</option>
                    <option value="team_lead">Team Lead Group</option>
                    <option value="manager">Manager Group</option>
                    <option value="global">Global Leaderboard</option>
                  </select>

                  {/* Role Selector */}
                  {selectedLeaderboardType === 'role' && canManageKPIs && (
                    <select 
                      value={selectedLeaderboardRole}
                      onChange={(e) => setSelectedLeaderboardRole(e.target.value)}
                      className="h-9 text-xs font-bold rounded-lg border border-slate-200 bg-white px-2.5 outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                    >
                      {SUPPORTED_ROLES.map(r => (
                        <option key={r} value={r}>{r} Leaderboard</option>
                      ))}
                    </select>
                  )}

                  {/* Process Selector */}
                  {selectedLeaderboardType === 'process' && (
                    <select 
                      value={selectedLeaderboardProcess}
                      onChange={(e) => setSelectedLeaderboardProcess(e.target.value)}
                      className="h-9 text-xs font-bold rounded-lg border border-slate-200 bg-white px-2.5 outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                    >
                      <option value="All">All Processes / Global</option>
                      {availableProcesses.map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  )}

                  {/* Team Lead Selector */}
                  {selectedLeaderboardType === 'team_lead' && (
                    <select 
                      value={selectedLeaderboardTL}
                      onChange={(e) => setSelectedLeaderboardTL(e.target.value)}
                      className="h-9 text-xs font-bold rounded-lg border border-slate-200 bg-white px-2.5 outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                    >
                      <option value="All">All Team Leaders</option>
                      {availableTeamLeads.map(tl => (
                        <option key={tl} value={tl}>TL: {tl}</option>
                      ))}
                    </select>
                  )}

                  {/* Manager Selector */}
                  {selectedLeaderboardType === 'manager' && (
                    <select 
                      value={selectedLeaderboardMgr}
                      onChange={(e) => setSelectedLeaderboardMgr(e.target.value)}
                      className="h-9 text-xs font-bold rounded-lg border border-slate-200 bg-white px-2.5 outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                    >
                      <option value="All">All Managers</option>
                      {availableManagers.map(mgr => (
                        <option key={mgr} value={mgr}>Manager: {mgr}</option>
                      ))}
                    </select>
                  )}
                </div>
              </CardHeader>
              
              {/* Dynamic Process KPI Dashboard Bento Grid */}
              <div id="process-kpi-dashboard" className="bg-slate-50/50 p-5 border-b border-slate-100">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-black tracking-wider uppercase text-slate-400">
                    <LayoutGrid size={14} className="text-indigo-500" />
                    <span>Process KPI Dashboard:</span>
                    <span className="text-slate-700 bg-white px-2 py-0.5 rounded border border-slate-150 font-black">{processKpiDashboard.processName}</span>
                  </div>
                  <Badge variant="outline" className="bg-indigo-50/50 text-indigo-700 border-indigo-100 font-extrabold text-[9px] uppercase self-start sm:self-auto px-2.5 py-0.5">
                    {selectedLeaderboardType === 'role' && `${selectedLeaderboardRole} Role Group`}
                    {selectedLeaderboardType === 'process' && `${selectedLeaderboardProcess === 'All' ? 'All Processes' : selectedLeaderboardProcess}`}
                    {selectedLeaderboardType === 'team_lead' && `TL: ${selectedLeaderboardTL}`}
                    {selectedLeaderboardType === 'manager' && `Mgr: ${selectedLeaderboardMgr}`}
                    {selectedLeaderboardType === 'global' && 'Global Group'}
                  </Badge>
                </div>
                
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  {/* Total Employees */}
                  <div id="kpi-card-employees" className="bg-white p-3.5 rounded-xl border border-slate-155 shadow-xs flex flex-col justify-center">
                    <span className="text-[9px] uppercase font-bold tracking-wider text-slate-400 mb-0.5">Total Employees</span>
                    <span className="text-2xl font-black text-slate-800">{processKpiDashboard.totalEmployees}</span>
                  </div>
                  
                  {/* Average Score */}
                  <div id="kpi-card-score" className="bg-white p-3.5 rounded-xl border border-slate-155 shadow-xs flex flex-col justify-center">
                    <span className="text-[9px] uppercase font-bold tracking-wider text-slate-400 mb-0.5">Average Score</span>
                    <span className="text-2xl font-black text-indigo-650">{processKpiDashboard.averageScore}%</span>
                  </div>

                  {/* Average Quality */}
                  <div id="kpi-card-quality" className="bg-white p-3.5 rounded-xl border border-slate-205 shadow-xs flex flex-col justify-center">
                    <span className="text-[9px] uppercase font-bold tracking-wider text-slate-400 mb-0.5">Average Quality</span>
                    <span className="text-2xl font-black text-emerald-600">
                      {processKpiDashboard.averageQuality > 0 ? `${processKpiDashboard.averageQuality}%` : 'N/A'}
                    </span>
                  </div>

                  {/* Average Productivity */}
                  <div id="kpi-card-prod" className="bg-white p-3.5 rounded-xl border border-slate-205 shadow-xs flex flex-col justify-center">
                    <span className="text-[9px] uppercase font-bold tracking-wider text-slate-400 mb-0.5">Average Productivity</span>
                    <span className="text-2xl font-black text-blue-600">
                      {processKpiDashboard.averageProductivity > 0 ? `${processKpiDashboard.averageProductivity}%` : 'N/A'}
                    </span>
                  </div>

                  {/* Average Attendance */}
                  <div id="kpi-card-attendance" className="bg-white p-3.5 rounded-xl border border-slate-205 shadow-xs flex flex-col justify-center">
                    <span className="text-[9px] uppercase font-bold tracking-wider text-slate-400 mb-0.5">Average Attendance</span>
                    <span className="text-2xl font-black text-amber-600">
                      {processKpiDashboard.averageAttendance > 0 ? `${processKpiDashboard.averageAttendance}%` : 'N/A'}
                    </span>
                  </div>

                  {/* Performers */}
                  <div id="kpi-card-performers" className="bg-white p-3.5 rounded-xl border border-slate-155 shadow-xs col-span-2 md:col-span-1 flex flex-col justify-center">
                    <span className="text-[9px] uppercase font-bold tracking-wider text-slate-400 mb-1">Top vs Bottom</span>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs font-bold leading-tight">
                        <span className="text-slate-500 truncate mr-2" title={processKpiDashboard.topPerformer}>🏆 {processKpiDashboard.topPerformer}</span>
                        <span className="text-indigo-655 text-[10px] font-black shrink-0">{processKpiDashboard.topPerformerScore}%</span>
                      </div>
                      <div className="flex items-center justify-between text-xs font-bold leading-tight border-t border-slate-50 pt-1">
                        <span className="text-slate-500 truncate mr-2" title={processKpiDashboard.bottomPerformer}>⚠️ {processKpiDashboard.bottomPerformer}</span>
                        <span className="text-rose-600 text-[10px] font-black shrink-0">{processKpiDashboard.bottomPerformerScore}%</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              {leaderboardRankings.length > 0 ? (
                <Table>
                  <TableHeader className="bg-slate-50/30 font-black">
                    <TableRow className="border-b border-slate-150">
                      <TableHead className="text-slate-600 text-xs font-black text-center w-16">Rank</TableHead>
                      <TableHead className="text-slate-600 text-xs font-black">Employee Profile</TableHead>
                      <TableHead className="text-slate-600 text-xs font-black text-center">Score achieved</TableHead>
                      <TableHead className="text-slate-600 text-xs font-black text-center">Performance Rating</TableHead>
                      <TableHead className="text-slate-600 text-xs font-black text-right pr-6">Primary KPIs matching</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leaderboardRankings.map((sc, index) => (
                      <TableRow 
                        key={index} 
                        className={`border-b border-slate-100 text-left hover:bg-slate-50/50 transition-colors ${sc.employeeEmail.toLowerCase() === user.email.toLowerCase() ? "bg-indigo-50/30 hover:bg-indigo-55/40" : ""}`}
                      >
                        <TableCell className="text-center font-black text-xs text-slate-800">
                          {sc.rank === 1 ? (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-100 text-amber-700 shadow-sm border border-amber-200">🥇</span>
                          ) : sc.rank === 2 ? (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 text-slate-700 shadow-sm border border-slate-200">🥈</span>
                          ) : sc.rank === 3 ? (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-50 text-amber-700 shadow-sm border border-amber-100">🥉</span>
                          ) : (
                            sc.rank
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-extrabold text-xs text-slate-900 flex items-center gap-1">
                              {sc.employeeName}
                              {sc.employeeEmail.toLowerCase() === user.email.toLowerCase() && (
                                <Badge className="bg-indigo-600 h-4 text-[9px] font-bold text-white uppercase">Me</Badge>
                              )}
                            </span>
                            <span className="text-[10px] text-slate-400 font-semibold">{sc.employeeEmail}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          <span className="text-xs font-black text-indigo-950">{sc.finalScore}%</span>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge className={cn("text-[10px] font-black border-none px-2.5 py-0.5", getRatingColor(sc.finalScore))}>
                            {sc.rating}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right pr-6 shrink-0">
                          <div className="flex flex-wrap justify-end gap-1.5">
                            {(sc.kpis || []).map((k, kIdx) => (
                              <Badge key={kIdx} variant="outline" className="text-[9px] border-slate-150 text-slate-500 bg-slate-50 font-semibold">
                                {k.name}: {k.actual}/{k.target}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="p-10 text-center space-y-2">
                  <p className="text-xs text-slate-400 font-medium italic">No performance rankings available under period {selectedPeriod} and role {selectedLeaderboardRole} yet.</p>
                </div>
              )}
            </Card>
          )}

          {/* TAB 3: Universal upload sheet config console */}
          {activeTab === 'uploads_desk' && canManageKPIs && (
            <div className="space-y-6">
              
              {/* Instructions and File Uploader */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                
                {/* Drag-and-drop Card */}
                <Card className="border border-dashed border-slate-200 p-6 rounded-2xl bg-slate-50/40 text-center flex flex-col justify-between h-56">
                  <div>
                    <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider mb-1 flex items-center justify-center gap-1.5">
                      <FileSpreadsheet size={15} className="text-emerald-600" /> Universal Spreadsheet Upload
                    </h3>
                    <p className="text-[11px] text-slate-400 leading-normal max-w-xs mx-auto mb-4">
                      Upload your compiled .xlsx or .csv employee records. The engine will map dynamic KPIs automatically.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Input 
                      type="file" 
                      accept=".xlsx, .xls, .csv" 
                      onChange={handleExcelUpload} 
                      className="w-full text-xs h-9 cursor-pointer opacity-90"
                    />
                    {stagingFileName && (
                      <p className="text-[10px] text-emerald-600 font-semibold flex items-center justify-center gap-1">
                        <Check size={12} /> Staged file: {stagingFileName}
                      </p>
                    )}
                  </div>
                </Card>

                {/* Templates download & seed Card */}
                <Card className="border border-slate-150 p-6 rounded-2xl flex flex-col justify-between h-56 bg-white shadow-sm">
                  <div>
                    <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider mb-1">Upload Work Guidelines</h3>
                    <p className="text-[11px] text-slate-400 leading-loose">
                      The template supports columns: <strong className="text-slate-600">Reporting Period, Employee Email, Role, KPI Name, Target, Actual, Bonus, Penalty, and Comments</strong>. Use one single spreadsheet for ALL roles seamlessly!
                    </p>
                  </div>

                  <div className="flex gap-2 w-full mt-4">
                    <Button 
                      variant="outline" 
                      onClick={downloadTemplate}
                      className="flex-1 text-xs font-black h-10 gap-1.5 border-slate-200 text-slate-700 cursor-pointer bg-white"
                    >
                      <Download size={13} />
                      Download Template
                    </Button>
                    <Button 
                      variant="outline" 
                      onClick={clearStagingShelf}
                      disabled={stagingData.length === 0}
                      className="text-xs font-bold h-10 border-slate-200 text-rose-600 cursor-pointer bg-white"
                      title="Clear memory"
                    >
                      Reset Shelf
                    </Button>
                  </div>
                </Card>
              </div>

              {/* Parsed Staging Data Grid */}
              {stagingData.length > 0 && (
                <Card className="border border-indigo-150 bg-indigo-50/5 shadow-md rounded-2xl overflow-hidden">
                  <CardHeader className="bg-indigo-50/40 p-4 border-b border-indigo-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <CardTitle className="text-xs font-black text-indigo-950 uppercase tracking-widest flex items-center gap-1">
                        Parsed Rows Staging Deck ({stagingData.length} records ready)
                      </CardTitle>
                      <CardDescription className="text-[11px] text-slate-400 font-semibold">Review, edit, or resolve details before writing securely to the Firestore database</CardDescription>
                    </div>

                    <Button 
                      onClick={handleCommitUploadGrid} 
                      disabled={loading}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold h-9 px-4 shrink-0 transition-all rounded-lg cursor-pointer"
                    >
                      <CheckCircle size={14} className="mr-1.5" />
                      Approve & Save Uploads to DB
                    </Button>
                  </CardHeader>
                  <div className="overflow-x-auto max-h-[420px]">
                    <Table>
                      <TableHeader className="bg-slate-50 font-black shrink-0 sticky top-0">
                        <TableRow className="border-b border-indigo-100">
                          <TableHead className="text-slate-600 text-xs font-black">Email</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-center">Period</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-center">Work Date</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-center">Process</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-center">Role</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-center">KPI Name</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-center">Target</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-center">Actual</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-center">Bonus/Penalty</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-center">Major Escalation</TableHead>
                          <TableHead className="text-slate-600 text-xs font-black text-right pr-4">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {stagingData.map((row) => {
                          const isEditing = editingStagingId === row.id;
                          return (
                            <TableRow key={row.id} className="border-b border-slate-100 hover:bg-slate-50 bg-white">
                              <TableCell className="py-2.5">
                                {isEditing ? (
                                  <Input 
                                    value={editRowFields.employeeEmail || ''} 
                                    onChange={(e) => setEditRowFields({ ...editRowFields, employeeEmail: e.target.value })}
                                    className="h-8 text-xs max-w-xs font-bold"
                                  />
                                ) : (
                                  <span className="font-extrabold text-xs text-slate-800">{row.employeeEmail}</span>
                                )}
                              </TableCell>
                              <TableCell className="text-center py-2.5">
                                {isEditing ? (
                                  <Input 
                                    value={editRowFields.reportingPeriod || ''} 
                                    onChange={(e) => setEditRowFields({ ...editRowFields, reportingPeriod: e.target.value })}
                                    className="h-8 text-xs w-20 text-center"
                                  />
                                ) : (
                                  <span className="font-semibold text-xs text-slate-500">{row.reportingPeriod}</span>
                                )}
                              </TableCell>
                              <TableCell className="text-center py-2.5">
                                {isEditing ? (
                                  <Input 
                                    value={editRowFields.workDate || ''} 
                                    onChange={(e) => setEditRowFields({ ...editRowFields, workDate: e.target.value })}
                                    className="h-8 text-xs w-24 text-center"
                                  />
                                ) : (
                                  <span className="font-semibold text-xs text-slate-500">{row.workDate || '-'}</span>
                                )}
                              </TableCell>
                              <TableCell className="text-center py-2.5">
                                {isEditing ? (
                                  <Input 
                                    value={editRowFields.processName || ''} 
                                    onChange={(e) => setEditRowFields({ ...editRowFields, processName: e.target.value })}
                                    className="h-8 text-xs w-24 text-center"
                                  />
                                ) : (
                                  <span className="font-semibold text-xs text-slate-500">{row.processName}</span>
                                )}
                              </TableCell>
                              <TableCell className="text-center py-2.5">
                                {isEditing ? (
                                  <Input 
                                    value={editRowFields.role || ''} 
                                    onChange={(e) => setEditRowFields({ ...editRowFields, role: e.target.value })}
                                    className="h-8 text-xs w-16 text-center"
                                  />
                                ) : (
                                  <Badge className="bg-slate-100 text-slate-800 font-extrabold hover:bg-slate-100 text-[10px] uppercase">{row.role}</Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-center py-2.5">
                                {isEditing ? (
                                  <Input 
                                    value={editRowFields.kpiName || ''} 
                                    onChange={(e) => setEditRowFields({ ...editRowFields, kpiName: e.target.value })}
                                    className="h-8 text-xs w-32"
                                  />
                                ) : (
                                  <span className="font-bold text-xs text-slate-800">{row.kpiName}</span>
                                )}
                              </TableCell>
                              <TableCell className="text-center py-2.5 font-bold text-xs">
                                {isEditing ? (
                                  <Input 
                                    type="number"
                                    value={editRowFields.target || 0} 
                                    onChange={(e) => setEditRowFields({ ...editRowFields, target: Number(e.target.value) })}
                                    className="h-8 text-xs w-16 text-center"
                                  />
                                ) : (
                                  row.target
                                )}
                              </TableCell>
                              <TableCell className="text-center py-2.5 font-bold text-xs text-indigo-950">
                                {isEditing ? (
                                  <Input 
                                    type="number"
                                    value={editRowFields.actual || 0} 
                                    onChange={(e) => setEditRowFields({ ...editRowFields, actual: Number(e.target.value) })}
                                    className="h-8 text-xs w-16 text-center"
                                  />
                                ) : (
                                  row.actual
                                )}
                              </TableCell>
                              <TableCell className="text-center py-2.5">
                                {isEditing ? (
                                  <div className="flex gap-1 items-center justify-center">
                                    <Input 
                                      type="number"
                                      placeholder="Bonus"
                                      value={editRowFields.bonus || 0} 
                                      onChange={(e) => setEditRowFields({ ...editRowFields, bonus: Number(e.target.value) })}
                                      className="h-8 text-xs w-14 text-center"
                                    />
                                    <Input 
                                      type="number"
                                      placeholder="Penalty"
                                      value={editRowFields.penalty || 0} 
                                      onChange={(e) => setEditRowFields({ ...editRowFields, penalty: Number(e.target.value) })}
                                      className="h-8 text-xs w-14 text-center"
                                    />
                                  </div>
                                ) : (
                                  <span className="text-xs font-semibold text-slate-500">
                                    {row.bonus > 0 && `+${row.bonus}B`} {row.penalty > 0 && `-${row.penalty}P`}
                                    {row.bonus === 0 && row.penalty === 0 && '-'}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="text-center py-2.5">
                                <input 
                                  type="checkbox"
                                  checked={isEditing ? (editRowFields.hasMajorEscalation || false) : (row.hasMajorEscalation || false)}
                                  disabled={!isEditing}
                                  onChange={(e) => setEditRowFields({ ...editRowFields, hasMajorEscalation: e.target.checked })}
                                  className="w-3.5 h-3.5 cursor-pointer accent-indigo-600 rounded"
                                />
                              </TableCell>
                              <TableCell className="text-right py-2.5 pr-4 shrink-0">
                                <div className="flex items-center justify-end gap-1.5">
                                  {isEditing ? (
                                    <Button 
                                      onClick={handleSaveStagingRow}
                                      size="sm"
                                      className="bg-emerald-500 hover:bg-emerald-600 h-7 text-[10px] text-white p-2.5 cursor-pointer"
                                    >
                                      Save
                                    </Button>
                                  ) : (
                                    <Button 
                                      onClick={() => handleStartStagingEdit(row)}
                                      size="sm"
                                      variant="ghost"
                                      className="hover:bg-slate-100 h-7 text-[10px] text-indigo-600 p-2 text-center"
                                    >
                                      Edit
                                    </Button>
                                  )}
                                  <Button 
                                    onClick={() => handleRemoveStagingRow(row.id)}
                                    size="sm"
                                    variant="ghost"
                                    className="hover:bg-rose-50 text-rose-600 h-7 text-[10px] p-2"
                                  >
                                    Delete
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </Card>
              )}

              {/* Manage Existing Data Section for Admin/Manager */}
              <Card className="border border-slate-150 shadow-sm rounded-2xl overflow-hidden mt-8">
                <CardHeader className="bg-slate-50/40 p-4 border-b border-slate-100 flex items-center justify-between">
                  <div>
                    <CardTitle className="text-xs font-black text-slate-900 uppercase tracking-widest leading-none mb-1">Manage Historical Records</CardTitle>
                    <CardDescription className="text-[10px] text-slate-400 font-medium">Historical baseline: View raw performance metrics globally.</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" onClick={fetchRecentUploads} className="h-8 text-[10px] font-bold gap-1 text-indigo-600">
                    <RefreshCw size={12} /> Sync Recent
                  </Button>
                </CardHeader>
                <div className="overflow-x-auto max-h-[300px]">
                  <Table>
                    <TableHeader className="bg-slate-50/30 sticky top-0">
                      <TableRow>
                        <TableHead className="text-[10px] font-black uppercase text-slate-500">Email</TableHead>
                        <TableHead className="text-[10px] font-black uppercase text-slate-500 text-center">Period</TableHead>
                        <TableHead className="text-[10px] font-black uppercase text-slate-500 text-center">Work Date</TableHead>
                        <TableHead className="text-[10px] font-black uppercase text-slate-500 text-center">Process</TableHead>
                        <TableHead className="text-[10px] font-black uppercase text-slate-500 text-center">KPI</TableHead>
                        <TableHead className="text-[10px] font-black uppercase text-slate-500 text-center">Actual</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRecentUploads.length > 0 ? filteredRecentUploads.map((row) => {
                        const isEditing = editingHistoricalId === row.docId;
                        return (
                          <TableRow key={row.docId} className="hover:bg-slate-50/50">
                            <TableCell className="text-[11px] font-bold text-slate-700">
                              {isEditing ? (
                                <Input 
                                  value={editHistoricalFields.employeeEmail || ''} 
                                  onChange={(e) => setEditHistoricalFields({ ...editHistoricalFields, employeeEmail: e.target.value })}
                                  className="h-7 text-[10px]"
                                />
                              ) : row.employeeEmail}
                            </TableCell>
                            <TableCell className="text-[11px] text-center font-bold text-slate-500">
                              {isEditing ? (
                                <Input 
                                  value={editHistoricalFields.reportingPeriod || ''} 
                                  onChange={(e) => setEditHistoricalFields({ ...editHistoricalFields, reportingPeriod: e.target.value })}
                                  className="h-7 text-[10px] w-20 mx-auto"
                                />
                              ) : row.reportingPeriod}
                            </TableCell>
                            <TableCell className="text-[11px] text-center font-semibold text-slate-500">
                              {isEditing ? (
                                <Input 
                                  value={editHistoricalFields.workDate || ''} 
                                  onChange={(e) => setEditHistoricalFields({ ...editHistoricalFields, workDate: e.target.value })}
                                  className="h-7 text-[10px] w-24 mx-auto text-center"
                                />
                              ) : (row.workDate || '-')}
                            </TableCell>
                            <TableCell className="text-[11px] text-center font-medium text-slate-500">
                              {isEditing ? (
                                <Input 
                                  value={editHistoricalFields.processName || ''} 
                                  onChange={(e) => setEditHistoricalFields({ ...editHistoricalFields, processName: e.target.value })}
                                  className="h-7 text-[10px] w-24 mx-auto"
                                />
                              ) : row.processName}
                            </TableCell>
                            <TableCell className="text-[11px] text-center text-slate-600 font-medium">
                              {isEditing ? (
                                <Input 
                                  value={editHistoricalFields.kpiName || ''} 
                                  onChange={(e) => setEditHistoricalFields({ ...editHistoricalFields, kpiName: e.target.value })}
                                  className="h-7 text-[10px] w-28 mx-auto"
                                />
                              ) : row.kpiName}
                            </TableCell>
                            <TableCell className="text-[11px] text-center font-bold text-indigo-600">
                              {isEditing ? (
                                <Input 
                                  type="number"
                                  value={editHistoricalFields.actual || 0} 
                                  onChange={(e) => setEditHistoricalFields({ ...editHistoricalFields, actual: Number(e.target.value) })}
                                  className="h-7 text-[10px] w-16 mx-auto"
                                />
                              ) : row.actual}
                            </TableCell>
                          </TableRow>
                        );
                      }) : (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center py-8 text-xs text-slate-400 italic font-medium">No historical records synchronized for management yet.</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            </div>
          )}

          {/* TAB 4: Dynamic KPI Templates configure */}
          {activeTab === 'templates_desk' && canEdit('Console') && (
            <Card className="border border-slate-150 shadow-sm rounded-2xl overflow-hidden bg-white">
              <CardHeader className="bg-slate-50/60 border-b border-slate-100 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <CardTitle className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5 animate-pulse">
                    <Settings className="text-indigo-600" size={17} /> KPI Template Parameter Configuration
                  </CardTitle>
                  <CardDescription className="text-xs text-slate-400 font-medium leading-relaxed">
                    Edit weights, directions, and major escalation penalties for each role dynamically. Values are updated immediately.
                  </CardDescription>
                </div>

                <select 
                  value={selectedConfigRole}
                  onChange={(e) => setSelectedConfigRole(e.target.value)}
                  className="h-10 text-xs font-extrabold rounded-lg border border-slate-200 bg-white px-3 outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                >
                  {SUPPORTED_ROLES.map(r => (
                    <option key={r} value={r}>Role Template: {r}</option>
                  ))}
                </select>
              </CardHeader>

              <CardContent className="p-6 space-y-6">
                
                {/* General escalation penalty configuration */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-b border-slate-100 pb-5">
                  <div className="space-y-1">
                    <label className="text-xs font-extrabold text-slate-700">Role Title Selected</label>
                    <p className="text-lg font-black text-slate-900">{selectedConfigRole}</p>
                  </div>
                  <div className="space-y-1.5 text-left">
                    <label className="text-xs font-extrabold text-slate-700 flex items-center gap-1">
                      <ShieldAlert size={14} className="text-rose-500" />
                      Major Escalation Penalty Deduction
                    </label>
                    <div className="flex gap-2">
                      <Input 
                        type="number"
                        value={editEscalationPenalty}
                        onChange={(e) => setEditEscalationPenalty(Number(e.target.value))}
                        className="text-xs font-bold h-9 bg-slate-50/50 text-slate-800"
                        placeholder="e.g. 20"
                      />
                      <span className="text-xs text-slate-400 font-bold flex items-center shrink-0">pts</span>
                    </div>
                  </div>
                </div>

                {/* Edit KPIs grid desk */}
                <div className="space-y-4">
                  <h4 className="text-xs font-black text-slate-800 uppercase tracking-widest flex justify-between">
                    <span>Allocated KPIs Defs list</span>
                    <span className={`text-[11px] uppercase ${editKpiList.reduce((a,c) => a + c.weight, 0) === 100 ? "text-emerald-600 font-bold" : "text-rose-600 font-extrabold"}`}>
                      Allocated Weight: {editKpiList.reduce((a,c) => a + c.weight, 0)}% (Goal: 100%)
                    </span>
                  </h4>

                  {editKpiList.length > 0 ? (
                    <div className="border border-slate-150 rounded-xl overflow-hidden">
                      <Table>
                        <TableHeader className="bg-slate-50 font-black">
                          <TableRow className="border-b border-slate-150">
                            <TableHead className="text-slate-600 text-xs font-black">KPI Name</TableHead>
                            <TableHead className="text-slate-600 text-xs font-black text-center">Direction Type</TableHead>
                            <TableHead className="text-slate-600 text-xs font-black text-center">Data Format</TableHead>
                            <TableHead className="text-slate-600 text-xs font-black text-center">Target Weight allocated</TableHead>
                            <TableHead className="text-slate-600 text-xs font-black text-right pr-4">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {editKpiList.map((kpi, index) => (
                            <TableRow key={index} className="border-b border-slate-100 hover:bg-slate-50 bg-white">
                              <TableCell className="font-extrabold text-xs text-slate-800 py-2.5">{kpi.name}</TableCell>
                              <TableCell className="text-center py-2.5">
                                <Badge variant="outline" className={`text-[9px] tracking-wide uppercase font-black ${kpi.type === 'higher_is_better' ? "text-emerald-700 bg-emerald-50/50 border-emerald-100" : "text-amber-700 bg-amber-50/50 border-amber-100"}`}>
                                  {kpi.type === 'higher_is_better' ? 'Higher is better' : 'Lower is better'}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-center py-2.5">
                                <Badge variant="secondary" className="text-[9px] font-bold uppercase py-0.5">
                                  {kpi.dataValueFormat || 'number'}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-center py-2.5 font-bold text-xs text-slate-700">{kpi.weight}%</TableCell>
                              <TableCell className="text-right py-2.5 pr-4 shrink-0">
                                <Button 
                                  onClick={() => handleRemoveKpiFromTemplate(kpi.name)}
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 text-[10px] text-rose-600 hover:bg-rose-50"
                                >
                                  Remove
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400 font-medium italic">No KPIs assigned under template sandbox yet.</p>
                  )}
                </div>

                {/* Add new KPI parameters sandbox inside active manager */}
                <div className="bg-slate-50/50 border border-slate-150 p-5 rounded-xl space-y-4">
                  <h4 className="text-xs font-black text-slate-800 uppercase tracking-widest">
                    Insert KPI Definition Model parameters
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">KPI Name</label>
                      <Input 
                        placeholder="e.g. CSAT / Productivity"
                        value={newKpiName}
                        onChange={(e) => setNewKpiName(e.target.value)}
                        className="text-xs h-9 font-bold bg-white"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Weight percentage</label>
                      <Input 
                        type="number"
                        placeholder="e.g. 20"
                        value={newKpiWeight}
                        onChange={(e) => setNewKpiWeight(Number(e.target.value))}
                        className="text-xs h-9 font-bold bg-white"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Success Metric type</label>
                      <select 
                        value={newKpiType}
                        onChange={(e) => setNewKpiType(e.target.value as any)}
                        className="h-9 w-full rounded-lg border border-slate-200 text-xs font-semibold px-2 bg-white cursor-pointer focus:ring-1 focus:ring-indigo-500"
                      >
                        <option value="higher_is_better">Higher score is better</option>
                        <option value="lower_is_better">Lower score is better</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Data Format</label>
                      <select 
                        value={newKpiFormat}
                        onChange={(e) => setNewKpiFormat(e.target.value as any)}
                        className="h-9 w-full rounded-lg border border-slate-200 text-xs font-semibold px-2 bg-white cursor-pointer focus:ring-1 focus:ring-indigo-500"
                      >
                        <option value="number">Number</option>
                        <option value="percentage">Percentage (%)</option>
                        <option value="duration">Duration / Time</option>
                      </select>
                    </div>
                  </div>
                  <Button 
                    onClick={handleAddKpiToTemplate}
                    variant="outline"
                    className="border-slate-200 hover:bg-slate-100 text-xs text-slate-700 h-9 px-4 font-bold gap-2 cursor-pointer bg-white"
                  >
                    <Plus size={14} /> Commit KPI definition
                  </Button>
                </div>

              </CardContent>

              <CardFooter className="bg-slate-50/60 py-4 px-6 border-t border-slate-150 flex flex-col sm:flex-row items-center justify-between gap-4">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">All edits affect all records instantly</span>
                <Button 
                  onClick={handleSaveKpiTemplateDoc} 
                  disabled={loading}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs h-10 px-5 gap-2 shadow-md cursor-pointer"
                >
                  <Save size={14} /> Ensure & Save Template Configuration
                </Button>
              </CardFooter>
            </Card>
          )}

        </div>

      </div>

    </div>
  );
}
