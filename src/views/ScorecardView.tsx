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
import { firestoreLogger } from '../lib/firestoreLogger';
import { cn, convertExcelDate, convertExcelPeriod } from '../lib/utils';
import { 
  collection, 
  getDocs, 
  getDoc,
  setDoc, 
  doc, 
  deleteDoc,
  writeBatch, 
  query, 
  where,
  limit,
  orderBy,
  getCountFromServer,
  onSnapshot
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
  onRefreshAllData?: (isManual?: boolean) => void;
  externalTheme?: 'light' | 'dark';
}

export default React.memo(function ScorecardView({ user, allUsers = [], onRefreshAllData, externalTheme = 'light' }: ScorecardViewProps) {
  const theme = externalTheme;
  const { canView, canCreate, canEdit, canDelete } = usePermission();

  const canManageKPIs = canEdit('KPI Scorecard');
  const canUploadKPIs = canCreate('KPI Scorecard');
  const canDeleteKPIs = canDelete('KPI Scorecard');
  const canViewReports = canView('KPI Scorecard');
  const canPublishScorecards = ['ADMIN', 'MIS'].includes((user.role || '').toUpperCase());

  // Navigation Tabs
  const [activeTab, setActiveTab] = useState<'dashboard' | 'leaderboard' | 'templates_desk'>('dashboard');

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

  // Loading indicator states
  const [loading, setLoading] = useState<boolean>(false);
  const [processingRecalc, setProcessingRecalc] = useState<boolean>(false);

  // Firestore Data States
  const [allScorecards, setAllScorecards] = useState<DynamicScorecard[]>([]);

  // Precomputed Leaderboards States
  const [currentLeaderboard, setCurrentLeaderboard] = useState<any | null>(null);
  const [globalLeaderboard, setGlobalLeaderboard] = useState<any | null>(null);

  const getLeaderboardDocId = (period: string, type: string, key: string): string => {
    const cleanKey = (key || '').trim().replace(/[\s\/]+/g, '_');
    const cleanPeriod = (period || '').trim().replace(/[\s\/]+/g, '_');
    if (type === 'role') {
      return `${cleanPeriod}_${cleanKey}`;
    }
    return `${cleanPeriod}_${type}_${cleanKey}`;
  };
  const [allRecentUploads, setAllRecentUploads] = useState<any[]>([]);
  const [kpiTemplates, setKpiTemplates] = useState<KpiTemplate[]>([]);
  const [rawUploadsCount, setRawUploadsCount] = useState<number>(0);

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
  }, [user?.uid, user?.email]);

  // Sync default email filter based on logged-in user
  useEffect(() => {
    if (allUsers.length > 0 && !selectedEmail) {
      setSelectedEmail(user.email.toLowerCase().trim());
    }
  }, [allUsers, selectedEmail, user?.email]);

  // Synchronize dynamic leaderboard default selection with user's role if supported
  useEffect(() => {
    if (user && user.role) {
      const upperRole = user.role.toUpperCase();
      const matched = SUPPORTED_ROLES.find(r => r.toUpperCase() === upperRole);
      if (matched) {
        setSelectedLeaderboardRole(matched);
      }
    }
  }, [user?.role]);

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


  // Auto-default selectedPeriod to the latest available period when they change
  useEffect(() => {
    if (availablePeriods.length > 0) {
      const latest = availablePeriods[availablePeriods.length - 1];
      if (!selectedPeriod || !availablePeriods.includes(selectedPeriod)) {
        setSelectedPeriod(latest);
      }
    }
  }, [availablePeriods, selectedPeriod]);

  const fetchAllKPIData = async () => {
    if (!user) return;
    try {
      console.log('[KPI Billing Optimization] Performing one-time KPI data fetch...');
      // 1. Fetch templates
      const templatesSnap = await getDocs(collection(db, 'kpi_templates'));
      firestoreLogger.trackRead('kpi_templates_getDocs', templatesSnap.size);
      const fetchedTemplates = templatesSnap.docs.map(docSnap => docSnap.data() as KpiTemplate);
      setKpiTemplates(fetchedTemplates);

      // 2. Fetch scorecards
      let scorecardsRef = collection(db, 'scorecards');
      const userEmail = (user.email || '').toLowerCase().trim();
      const cleanSelectedEmail = (selectedEmail || '').toLowerCase().trim();
      let scorecardsQ;
      if (canManageKPIs) {
        if (cleanSelectedEmail) {
          scorecardsQ = query(
            scorecardsRef, 
            where('reportingPeriod', '==', selectedPeriod), 
            where('employeeEmail', '==', cleanSelectedEmail)
          );
        } else {
          scorecardsQ = query(
            scorecardsRef, 
            where('reportingPeriod', '==', selectedPeriod), 
            where('employeeEmail', '==', userEmail)
          );
        }
      } else {
        scorecardsQ = query(
          scorecardsRef, 
          where('reportingPeriod', '==', selectedPeriod), 
          where('employeeEmail', '==', userEmail)
        );
      }

      const scorecardsSnap = await getDocs(scorecardsQ);
      firestoreLogger.trackRead('scorecards_getDocs', scorecardsSnap.size);
      const fetchedScorecards = scorecardsSnap.docs.map(docSnap => docSnap.data() as DynamicScorecard);
      setAllScorecards(fetchedScorecards);

    // 3. Fetch raw uploaded records
    if (canManageKPIs) {
      let uploadsRef = collection(db, 'kpi_uploads');
      let uploadsQ = selectedPeriod 
        ? query(uploadsRef, where('reportingPeriod', '==', selectedPeriod))
        : query(uploadsRef, orderBy('createdAt', 'desc'), limit(100));
        
      const uploadsSnap = await getDocs(uploadsQ);
      firestoreLogger.trackRead('kpi_uploads_getDocs', uploadsSnap.size);
      setAllRecentUploads(uploadsSnap.docs.map(d => ({ ...d.data(), docId: d.id })));
      
      // Calculate real total count efficiently without fetching all docs if possible
      if (!selectedPeriod) {
         setRawUploadsCount(uploadsSnap.size > 99 ? 100 : uploadsSnap.size); 
      } else {
         setRawUploadsCount(uploadsSnap.size);
      }
    }
    } catch (error) {
      console.error('Error fetching KPI data: ', error);
    }
  };

  useEffect(() => {
    if (user?.uid) {
      fetchAllKPIData();
    }
  }, [selectedPeriod, canManageKPIs, selectedEmail, user?.uid]);

  // REDESIGN: Fetch precomputed leaderboards on-selection based on dropdown selections
  useEffect(() => {
    if (!selectedPeriod) return;

    const fetchLeaderboardDocs = async () => {
      let key = '';
      if (selectedLeaderboardType === 'role') key = selectedLeaderboardRole;
      else if (selectedLeaderboardType === 'process') key = selectedLeaderboardProcess;
      else if (selectedLeaderboardType === 'team_lead') key = selectedLeaderboardTL;
      else if (selectedLeaderboardType === 'manager') key = selectedLeaderboardMgr;
      else if (selectedLeaderboardType === 'global') key = 'global';

      const currentDocId = getLeaderboardDocId(selectedPeriod, selectedLeaderboardType, key);
      const globalDocId = `${selectedPeriod.trim().replace(/[\s\/]+/g, '_')}_global`;

      try {
        // 1. Fetch selected leaderboard doc
        const currentRef = doc(db, 'leaderboards', currentDocId);
        const currentSnap = await getDoc(currentRef);
        firestoreLogger.trackRead('leaderboard_getDoc', currentSnap.exists() ? 1 : 0);
        if (currentSnap.exists()) {
          setCurrentLeaderboard(currentSnap.data());
        } else {
          setCurrentLeaderboard(null);
        }

        // 2. Fetch global leaderboard doc (for stats and available filter lists)
        const globalRef = doc(db, 'leaderboards', globalDocId);
        const globalSnap = await getDoc(globalRef);
        firestoreLogger.trackRead('global_leaderboard_getDoc', globalSnap.exists() ? 1 : 0);
        if (globalSnap.exists()) {
          setGlobalLeaderboard(globalSnap.data());
        } else {
          setGlobalLeaderboard(null);
        }
      } catch (err) {
        console.warn('Leaderboard fetch error: ', err);
        setCurrentLeaderboard(null);
        setGlobalLeaderboard(null);
      }
    };

    fetchLeaderboardDocs();
  }, [selectedPeriod, selectedLeaderboardType, selectedLeaderboardRole, selectedLeaderboardProcess, selectedLeaderboardTL, selectedLeaderboardMgr]);

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
    if (activeTab === 'templates_desk') {
      fetchRecentUploads();
    }
  }, [activeTab]);

  // Clean computed metrics for active selected scorecard
  const employeeScorecards = useMemo(() => {
    if (!selectedEmail) return [];
    const emailKey = (selectedEmail || '').toLowerCase().trim();
    if (!emailKey) return [];
    
    let filtered = allScorecards.filter(sc => (sc.employeeEmail || '').toLowerCase().trim() === emailKey);
    
    filtered = filtered.filter(sc => ensureDateStr(sc.reportingPeriod) === ensureDateStr(selectedPeriod));
    
    return filtered.sort((a, b) => ensureDateStr(b.reportingPeriod).localeCompare(ensureDateStr(a.reportingPeriod)));
  }, [allScorecards, selectedPeriod, selectedEmail]);

  const dashboardDailyRecordsList = useMemo(() => {
    return allRecentUploads.filter(row => {
      // 1. Match employee email
      if (selectedEmail && (row.employeeEmail || '').toLowerCase().trim() !== (selectedEmail || '').toLowerCase().trim()) {
        return false;
      }
      // 2. Match reporting period
      const pDate = ensureDateStr(row.reportingPeriod);
      const isPeriodMatch = (!selectedPeriod || pDate === ensureDateStr(selectedPeriod));
      if (!isPeriodMatch) return false;

      // 3. Match dashboard process filter if not 'All'
      if (selectedDashboardProcess && selectedDashboardProcess !== 'All') {
        if (row.processName !== selectedDashboardProcess) {
          return false;
        }
      }

      return true;
    }).sort((a, b) => ensureDateStr(b.workDate || b.reportingPeriod).localeCompare(ensureDateStr(a.workDate || a.reportingPeriod)));
  }, [allRecentUploads, selectedEmail, selectedPeriod, selectedDashboardProcess]);

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
    if (!currentLeaderboard || !currentLeaderboard.rankings) return [];
    return currentLeaderboard.rankings;
  }, [currentLeaderboard]);

  const availableProcesses = useMemo(() => {
    if (globalLeaderboard && globalLeaderboard.availableProcesses) {
      return globalLeaderboard.availableProcesses;
    }
    const list = new Set<string>();
    
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
  }, [globalLeaderboard, allRecentUploads]);

  const availableTeamLeads = useMemo(() => {
    if (globalLeaderboard && globalLeaderboard.availableTeamLeads) {
      return globalLeaderboard.availableTeamLeads;
    }
    const list = new Set<string>();
    allUsers.forEach(u => {
      const role = (u.role || '').toUpperCase();
      if (role.includes('TL') || role.includes('LEAD')) {
        const name = u.employeeName || u.fullName || u.name;
        if (name) list.add(name.trim());
      }
    });
    return Array.from(list).sort();
  }, [globalLeaderboard, allUsers]);

  const availableManagers = useMemo(() => {
    if (globalLeaderboard && globalLeaderboard.availableManagers) {
      return globalLeaderboard.availableManagers;
    }
    const list = new Set<string>();
    allUsers.forEach(u => {
      const role = (u.role || '').toUpperCase();
      if (role.includes('MANAGER') || role.includes('ADMIN') || role.includes('OPS_HEAD') || role.includes('AM')) {
        const name = u.employeeName || u.fullName || u.name;
        if (name) list.add(name.trim());
      }
    });
    return Array.from(list).sort();
  }, [globalLeaderboard, allUsers]);

  // Compute stats specifically for the selected filters (Process KPI Dashboard)
  const processKpiDashboard = useMemo(() => {
    let displayName = 'Global';
    if (selectedLeaderboardType === 'process') displayName = selectedLeaderboardProcess === 'All' ? 'Global' : selectedLeaderboardProcess;
    else if (selectedLeaderboardType === 'team_lead') displayName = selectedLeaderboardTL === 'All' ? 'Global' : `TL: ${selectedLeaderboardTL}`;
    else if (selectedLeaderboardType === 'manager') displayName = selectedLeaderboardMgr === 'All' ? 'Global' : `Manager: ${selectedLeaderboardMgr}`;
    else if (selectedLeaderboardType === 'role') displayName = `Role: ${selectedLeaderboardRole}`;

    if (!currentLeaderboard || !currentLeaderboard.stats) {
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

    const s = currentLeaderboard.stats;
    return {
      processName: displayName,
      totalEmployees: s.totalEmployees || 0,
      averageScore: s.averageScore || 0,
      averageQuality: s.averageQuality || 0,
      averageProductivity: s.averageProductivity || 0,
      averageAttendance: s.averageAttendance || 0,
      topPerformer: s.topPerformer || '-',
      topPerformerScore: s.topPerformerScore || 0,
      bottomPerformer: s.bottomPerformer || '-',
      bottomPerformerScore: s.bottomPerformerScore || 0
    };
  }, [currentLeaderboard, selectedLeaderboardType, selectedLeaderboardRole, selectedLeaderboardProcess, selectedLeaderboardTL, selectedLeaderboardMgr]);

  // Simple statistics for selected period
  const periodStats = useMemo(() => {
    if (!globalLeaderboard || !globalLeaderboard.stats) {
      return { totalUploaded: 0, averageScore: 0, outstandingCount: 0 };
    }
    const s = globalLeaderboard.stats;
    const rankings = globalLeaderboard.rankings || [];
    const outstandingCount = rankings.filter((r: any) => r.finalScore >= 100).length;

    return {
      totalUploaded: s.totalEmployees || 0,
      averageScore: s.averageScore || 0,
      outstandingCount: outstandingCount
    };
  }, [globalLeaderboard]);

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

    if (!confirm('Are you sure you want to delete this raw upload record? This will require a manual recalculation to update scorecards.')) return;
    try {
      await deleteDoc(doc(db, 'kpi_uploads', docId));
      toast.success('Upload record deleted successfully. Please click "Publish & Calculate Scorecards" to update rankings.');
      
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
      toast.success('Historical record updated. Please manually trigger calculation for the changes to reflect in scorecards.');
      setEditingHistoricalId(null);
      setEditHistoricalFields({});
      
      fetchRecentUploads();
      await fetchAllKPIData();
    } catch (err) {
      console.error(err);
      toast.error('Failed to update record.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * KPI Template Manager Config Console Helpers
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
    if (!selectedEmail) return [];
    const group = allScorecards.filter(sc => (sc.employeeEmail || '').toLowerCase().trim() === (selectedEmail || '').toLowerCase().trim());
    return group.map(sc => ({
      period: sc.reportingPeriod,
      Score: sc.finalScore,
      KPI_Sub: sc.overallKpiScore
    })).sort((a,b) => a.period.localeCompare(b.period));
  }, [allScorecards, selectedEmail]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
      
      {/* Banner Heading */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-2xl shadow-sm relative overflow-hidden">
        <div className="absolute right-0 top-0 opacity-5 pointer-events-none transform translate-x-8 -translate-y-8 dark:opacity-10 text-indigo-500">
          <Award size={140} />
        </div>
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge className="bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-150 dark:border-indigo-900/40 text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 shadow-none">
                SYSTEM CONSOLE
              </Badge>
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white mt-1">
              Precision360 <span className="text-indigo-600 dark:text-indigo-400 font-extrabold">KPI Scorecard Engine</span>
            </h1>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 max-w-xl">
              Fully dynamic, template-driven analytics workstation. Configure templates, upload universal files, resolve weights, and calculate scorecards without editing code.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <Button 
              onClick={fetchAllKPIData} 
              disabled={loading}
              variant="outline"
              className="border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 h-9 px-3.5 font-bold text-xs gap-1.5 cursor-pointer"
            >
              <RefreshCw size={12} className={""} />
              Sync DB Indexes
            </Button>
            
            {canPublishScorecards && (
              <Button 
                onClick={handleRecalculatePeriodScorecards} 
                disabled={processingRecalc || loading}
                className="bg-indigo-600 hover:bg-indigo-700 text-white h-9 px-3.5 font-bold text-xs gap-1.5 shadow-none border-none cursor-pointer"
              >
                <Sliders size={12} className={""} />
                {processingRecalc ? 'Recalculating...' : 'Publish Scorecards'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Workspace Menu Bar & Global Filters */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Workspace Toolbar card */}
        <div className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-150 dark:border-slate-800 p-6 rounded-2xl shadow-sm space-y-5 h-fit lg:sticky lg:top-6 lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto">
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
                  onSelect={(u) => setSelectedEmail(u?.email || '')}
                  selectedUserId={allUsers.find(u => (u.email || '').toLowerCase() === (selectedEmail || '').toLowerCase())?.uid}
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
                    <Sliders size={20} />
                  </div>
                  <div>
                    <h3 className="text-md font-black text-slate-900">Scorecard Calculation Pending</h3>
                    <p className="text-xs text-slate-400 font-medium max-w-sm mx-auto mt-1">
                      No scorecard has been generated for <strong>{selectedEmail}</strong> during period <strong>{selectedPeriod}</strong> yet.
                    </p>
                  </div>
                  {canPublishScorecards && (
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
                        className={`border-b border-slate-100 text-left hover:bg-slate-50/50 transition-colors ${(sc.employeeEmail || '').toLowerCase() === (user.email || '').toLowerCase() ? "bg-indigo-50/30 hover:bg-indigo-55/40" : ""}`}
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
                          <div className="flex items-center gap-2">
                             {(() => {
                               const ap = allUsers.find(u => (u.email || '').toLowerCase().trim() === (sc.employeeEmail || '').toLowerCase().trim());
                               return (
                                 <div className="w-7 h-7 rounded-full overflow-hidden bg-slate-100 flex items-center justify-center font-bold text-[10px] text-slate-400 border border-slate-200 shrink-0">
                                   {ap?.photoURL ? (
                                     <img src={ap.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                   ) : (
                                     (sc.employeeName || '??').split(' ').map(n => n[0]).slice(0, 2).join('')
                                   )}
                                 </div>
                               );
                             })()}
                             <div className="flex flex-col">
                               <span className="font-extrabold text-xs text-slate-900 flex items-center gap-1">
                                 {sc.employeeName}
                                 {(sc.employeeEmail || '').toLowerCase() === (user.email || '').toLowerCase() && (
                                   <Badge className="bg-indigo-600 h-4 text-[9px] font-bold text-white uppercase">Me</Badge>
                                 )}
                               </span>
                               <span className="text-[10px] text-slate-400 font-semibold">{sc.employeeEmail}</span>
                             </div>
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
  )
}
)
