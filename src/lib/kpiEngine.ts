import { db } from './firebase';
import { 
  collection, 
  getDocs, 
  getDoc,
  setDoc, 
  doc, 
  writeBatch,
  query,
  where,
  limit
} from 'firebase/firestore';
import { UserRole } from '../types';

export interface KpiDefinition {
  name: string;
  weight: number; // Weight percentage (e.g., 30 for 30%)
  type: 'higher_is_better' | 'lower_is_better';
  aggregationMethod?: 'SUM' | 'AVERAGE';
  dataValueFormat?: 'percentage' | 'duration' | 'number';
}

export interface KpiTemplate {
  role: string; // e.g. "QV", "QA", "SME"
  kpis: KpiDefinition[];
  majorEscalationPenalty: number;
  updatedAt?: string;
}

export interface KpiUploadRow {
  id: string;
  reportingPeriod: string; // YYYY-MM
  workDate?: string; // YYYY-MM-DD
  employeeEmail: string;
  role: string;
  processName: string;
  kpiName: string;
  target: number;
  actual: number;
  bonus: number;
  penalty: number;
  comments: string;
  hasMajorEscalation?: boolean;
}

export interface KpiCalculationBreakdown {
  name: string;
  weight: number;
  type: 'higher_is_better' | 'lower_is_better';
  dataValueFormat?: 'percentage' | 'duration' | 'number';
  target: number;
  actual: number;
  achievementPct: number; // e.g. 102.5
  weightedScore: number; // achievementPct * weight / 100
  latestComment?: string;
  commentCount: number;
  isMissing?: boolean;
}

export interface DynamicScorecard {
  id: string; // Period_Process_Email (normalized)
  reportingPeriod: string;
  workDate?: string;
  employeeEmail: string;
  employeeName: string;
  role: string;
  processName: string;
  kpiBreakdown: KpiCalculationBreakdown[];
  overallKpiScore: number; // sum of weighted KPI scores (re-scaled if some KPIs were missing)
  bonusPoints: number;
  penaltyPoints: number;
  majorEscalationPenalty: number;
  hasMajorEscalation: boolean;
  finalScore: number; // overallKpiScore + bonus - penalty - escalation
  rating: string;
  rank: number;
  published: boolean;
  updatedAt: string;
  teamLeadName?: string;
  mappedManagerName?: string;
  Manager?: string;
  isTemporaryUser?: boolean;
}

export interface LeaderboardItem {
  rank: number;
  employeeEmail: string;
  employeeName: string;
  finalScore: number;
  rating: string;
}

export interface RoleLeaderboard {
  id: string; // Period_Process_Role (Or Period_Role)
  reportingPeriod: string;
  role: string;
  processName?: string;
  rankings: LeaderboardItem[];
  updatedAt: string;
}

// 11 Supported Roles List
export const SUPPORTED_ROLES = [
  'QV',
  'QA',
  'SME',
  'QTL',
  'Trainer',
  'Trainer TL',
  'OPS TL',
  'STL',
  'Operations AM',
  'Quality AM',
  'MIS'
];

// Universal uploaded excel headers validation template
export const UNIVERSAL_TEMPLATE_COLUMNS = [
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

// Default configuration mappings that fulfill user exact specifications
export const DEFAULT_KPI_TEMPLATES: KpiTemplate[] = [
  {
    role: 'QV',
    kpis: [
      { name: 'Productivity', weight: 30, type: 'higher_is_better', aggregationMethod: 'SUM', dataValueFormat: 'number' },
      { name: 'APT', weight: 15, type: 'lower_is_better', aggregationMethod: 'AVERAGE', dataValueFormat: 'duration' },
      { name: 'Attendance', weight: 15, type: 'higher_is_better', aggregationMethod: 'AVERAGE', dataValueFormat: 'percentage' },
      { name: 'Quality', weight: 40, type: 'higher_is_better', aggregationMethod: 'AVERAGE', dataValueFormat: 'percentage' }
    ],
    majorEscalationPenalty: 20
  },
  {
    role: 'QA',
    kpis: [
      { name: 'Utilization', weight: 20, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Accuracy', weight: 30, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Compliance', weight: 20, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Documentation', weight: 30, type: 'higher_is_better', dataValueFormat: 'number' }
    ],
    majorEscalationPenalty: 15
  },
  {
    role: 'SME',
    kpis: [
      { name: 'Shrinkage', weight: 15, type: 'lower_is_better', dataValueFormat: 'percentage' },
      { name: 'Attrition', weight: 15, type: 'lower_is_better', dataValueFormat: 'percentage' },
      { name: 'Utilization', weight: 30, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Quality', weight: 40, type: 'higher_is_better', dataValueFormat: 'percentage' }
    ],
    majorEscalationPenalty: 15
  },
  {
    role: 'QTL',
    kpis: [
      { name: 'Audits Coached', weight: 30, type: 'higher_is_better', dataValueFormat: 'number' },
      { name: 'Calibration Variance', weight: 30, type: 'lower_is_better', dataValueFormat: 'percentage' },
      { name: 'Team Performance', weight: 25, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Attendance', weight: 15, type: 'higher_is_better', dataValueFormat: 'percentage' }
    ],
    majorEscalationPenalty: 20
  },
  {
    role: 'Trainer',
    kpis: [
      { name: 'Batches Handled', weight: 45, type: 'higher_is_better', dataValueFormat: 'number' },
      { name: 'Throughput Pct', weight: 30, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Training CSAT', weight: 25, type: 'higher_is_better', dataValueFormat: 'percentage' }
    ],
    majorEscalationPenalty: 10
  },
  {
    role: 'Trainer TL',
    kpis: [
      { name: 'Trainer Utilization', weight: 40, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Team CSAT', weight: 30, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Batch Completion', weight: 30, type: 'higher_is_better', dataValueFormat: 'number' }
    ],
    majorEscalationPenalty: 20
  },
  {
    role: 'OPS TL',
    kpis: [
      { name: 'Service Level', weight: 30, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Shrinkage', weight: 20, type: 'lower_is_better', dataValueFormat: 'percentage' },
      { name: 'Staff Productivity', weight: 30, type: 'higher_is_better', dataValueFormat: 'number' },
      { name: 'QA Performance', weight: 20, type: 'higher_is_better', dataValueFormat: 'percentage' }
    ],
    majorEscalationPenalty: 25
  },
  {
    role: 'STL',
    kpis: [
      { name: 'Team SLA', weight: 35, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Team Quality', weight: 35, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Attendance', weight: 15, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Attrition Rate', weight: 15, type: 'lower_is_better', dataValueFormat: 'percentage' }
    ],
    majorEscalationPenalty: 20
  },
  {
    role: 'Operations AM',
    kpis: [
      { name: 'Client SLA', weight: 35, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Team Quality', weight: 25, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Utilization', weight: 20, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Profit Margin', weight: 20, type: 'higher_is_better', dataValueFormat: 'percentage' }
    ],
    majorEscalationPenalty: 30
  },
  {
    role: 'Quality AM',
    kpis: [
      { name: 'Quality SLA', weight: 40, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Calibration Adherence', weight: 30, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Team SLA', weight: 30, type: 'higher_is_better', dataValueFormat: 'percentage' }
    ],
    majorEscalationPenalty: 30
  },
  {
    role: 'MIS',
    kpis: [
      { name: 'Report Accuracy', weight: 30, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Delivery Variance', weight: 30, type: 'lower_is_better', dataValueFormat: 'duration' },
      { name: 'Dashboard Uptime', weight: 20, type: 'higher_is_better', dataValueFormat: 'percentage' },
      { name: 'Ad-hoc SLA', weight: 20, type: 'higher_is_better', dataValueFormat: 'percentage' }
    ],
    majorEscalationPenalty: 15
  }
];

/**
 * Normalizes custom/flexible Excel date parameters to workDate (YYYY-MM-DD) and reportingPeriod (YYYY-MM).
 * Accepts: 2026-05-13, 2026-05, 13-May-2026, May-2026, 2026/05/13, Excel serial numbers, etc.
 */
export function normalizeUploadDate(rawDateStr: any): { workDate: string; reportingPeriod: string } {
  if (rawDateStr === null || rawDateStr === undefined) {
    const today = new Date().toISOString().substring(0, 10);
    return { workDate: today, reportingPeriod: today.substring(0, 7) };
  }
  
  const clean = String(rawDateStr).trim();
  if (!clean) {
    const today = new Date().toISOString().substring(0, 10);
    return { workDate: today, reportingPeriod: today.substring(0, 7) };
  }

  // 1. Try to parse standard YYYY-MM-DD or YYYY.MM.DD
  let match = clean.match(/^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/);
  if (match) {
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    return {
      workDate: `${year}-${month}-${day}`,
      reportingPeriod: `${year}-${month}`
    };
  }

  // 2. Try to parse standard YYYY-MM
  match = clean.match(/^(\d{4})[-/](\d{1,2})$/);
  if (match) {
    const year = match[1];
    const month = match[2].padStart(2, '0');
    return {
      workDate: `${year}-${month}-01`,
      reportingPeriod: `${year}-${month}`
    };
  }

  // 3. Try to parse DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
  match = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return {
      workDate: `${year}-${month}-${day}`,
      reportingPeriod: `${year}-${month}`
    };
  }

  // Monthly naming dictionaries
  const monthMap: { [key: string]: string } = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
  };

  // 4. Try parsing 13-May-2026 or 13 May 2026
  match = clean.match(/^(\d{1,2})[-/ ]([a-zA-Z]{3,10})[-/ ](\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const monthStr = match[2].toLowerCase();
    const year = match[3];
    const month = monthMap[monthStr.substring(0, 3)] || '01';
    return {
      workDate: `${year}-${month}-${day}`,
      reportingPeriod: `${year}-${month}`
    };
  }

  // 5. Try parsing May-2026 or May 2026
  match = clean.match(/^([a-zA-Z]{3,10})[-/ ](\d{4})$/);
  if (match) {
    const monthStr = match[1].toLowerCase();
    const year = match[2];
    const month = monthMap[monthStr.substring(0, 3)] || '01';
    return {
      workDate: `${year}-${month}-01`,
      reportingPeriod: `${year}-${month}`
    };
  }

  // 6. Check Excel serial decimal number
  const num = Number(clean);
  if (!isNaN(num) && num > 1000) {
    try {
      const date = new Date((num - 25569) * 86400 * 1000);
      if (!isNaN(date.getTime())) {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        return {
          workDate: `${year}-${month}-${day}`,
          reportingPeriod: `${year}-${month}`
        };
      }
    } catch (e) {}
  }

  // 7. General JS Date parse fallback
  try {
    const parsed = new Date(clean);
    if (!isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      return {
        workDate: `${year}-${month}-${day}`,
        reportingPeriod: `${year}-${month}`
      };
    }
  } catch (e) {}

  // 8. Safest default container fallback
  const currYear = new Date().getFullYear();
  const currMonth = String(new Date().getMonth() + 1).padStart(2, '0');
  return {
    workDate: `${currYear}-${currMonth}-01`,
    reportingPeriod: `${currYear}-${currMonth}`
  };
}

/**
 * Initialize Default templates in Firestore if they do not exist
 */
export async function ensureDefaultTemplatesExist() {
  try {
    const templatesCol = collection(db, 'kpi_templates');
    const snap = await getDocs(templatesCol);
    if (snap.empty) {
      console.log('[KPI ENGINE] No KPI templates found in Firestore. Seeding defaults...');
      const batch = writeBatch(db);
      for (const t of DEFAULT_KPI_TEMPLATES) {
        const ref = doc(db, 'kpi_templates', t.role);
        batch.set(ref, {
          ...t,
          updatedAt: new Date().toISOString()
        });
      }
      await batch.commit();
      console.log('[KPI ENGINE] Default system templates seeded successfully.');
    }
  } catch (err) {
    console.error('[KPI ENGINE] Failed to seed default system metrics templates:', err);
  }
}

/**
 * Compute metric achievement up to a capped value of 120%
 */
export function calculateAchievement(type: 'higher_is_better' | 'lower_is_better', target: number, actual: number): number {
  if (!target || target <= 0) return 0;
  if (!actual || actual < 0) actual = 0;
  
  let achievement = 0;
  if (type === 'higher_is_better') {
    achievement = actual / target;
  } else {
    achievement = target / actual;
  }
  
  return Math.min(1.2, achievement) * 100;
}

/**
 * Determine performance descriptive label based on updated organizational thresholds
 */
export function getPerformanceRating(score: number): string {
  if (score >= 100) return 'Outstanding';
  if (score >= 95) return 'Exceeds Expectations';
  if (score >= 85) return 'Meets Expectations';
  if (score >= 75) return 'Needs Improvement';
  return 'Unsatisfactory';
}

/**
 * Log dynamic engine calculation issues in firestore 'kpi_exceptions'
 */
async function writeExceptionLog(
  type: 'MISSING_USER' | 'MISSING_KPI' | 'DATE_MISMATCH' | 'INVALID_ROW' | 'SCORECARD_CALC_FAILED',
  severity: 'warning' | 'error',
  email: string,
  message: string,
  reportingPeriod: string
) {
  try {
    const col = collection(db, 'kpi_exceptions');
    const logRef = doc(col);
    await setDoc(logRef, {
      id: logRef.id,
      type,
      severity,
      employeeEmail: email.toLowerCase().trim(),
      message,
      reportingPeriod,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('[KPI ENGINE] Failsafe: could not write exception log to Firestore:', e);
  }
}

/**
 * Maps a string role to the strict UserRole enum
 */
function mapStringToUserRole(roleStr: string): UserRole {
  const clean = String(roleStr).trim().toUpperCase();
  if (clean === 'QA') return UserRole.QA;
  if (clean === 'SME') return UserRole.SME;
  if (clean === 'STL') return UserRole.STL;
  if (clean === 'OPS TL' || clean === 'OPS_TL') return UserRole.OPS_TL;
  if (clean === 'QTL') return UserRole.QTL;
  if (clean === 'TRAINER') return UserRole.TRAINER;
  if (clean === 'TRAINER TL' || clean === 'TRAINER_TL') return UserRole.TRAINER_TL;
  if (clean === 'MIS') return UserRole.MIS;
  if (clean === 'ADMIN') return UserRole.ADMIN;
  if (clean === 'MANAGER') return UserRole.MANAGER;
  return UserRole.AGENT; // QV and general associates default to AGENT
}

/**
 * MAIN ENTRY POINT: Calculates scorecards dynamically solely based on uploaded KPI data.
 * Completely independent of registration, creates temp profiles on-the-fly, rescales weights dynamically.
 */
export async function runDynamicKPIEngine(reportingPeriod: string, allUsersPassedIn?: any[]): Promise<{ scorecardsCount: number }> {
  try {
    console.log('========================================================================');
    console.log(`[KPI ENGINE REDESIGNED] COMPILING SCORECARDS FOR PERIOD: ${reportingPeriod}`);
    console.log('========================================================================');

    let inputPeriod = reportingPeriod || '';
    if (typeof inputPeriod === 'string') {
      inputPeriod = inputPeriod.trim();
    }
    if (!inputPeriod) {
      console.error('[KPI ENGINE] Invalid/empty reportingPeriod parameter.');
      return { scorecardsCount: 0 };
    }
    // Automatically normalize design: support YYYY-MM-DD input silently and map to YYYY-MM
    const normalized = normalizeUploadDate(inputPeriod);
    const cleanPeriod = normalized.reportingPeriod;

    // --- DIAGNOSTICS START ---
    console.log('--- KPI ENGINE DIAGNOSTIC START ---');
    console.log(`Collection: kpi_uploads`);
    console.log(`Selected Period: ${cleanPeriod}`);

    // OPTIMIZED: Removed expensive full collection scan of kpi_uploads for diagnostics
    // --- DIAGNOSTICS END ---

    // Fetch up-to-date users list directly from Firebase 'users' collection to check register state
    const usersCol = collection(db, 'users');
    const usersSnap = await getDocs(usersCol);
    const dbUsers = usersSnap.docs.map(d => d.data());

    // Fetch system Metric templates
    const templatesCol = collection(db, 'kpi_templates');
    const templatesSnap = await getDocs(templatesCol);
    const templatesMap = new Map<string, KpiTemplate>();
    templatesSnap.docs.forEach(docSnap => {
      const data = docSnap.data() as KpiTemplate;
      templatesMap.set(data.role.toUpperCase(), data);
    });

    // Backfill defaults
    DEFAULT_KPI_TEMPLATES.forEach(t => {
      if (!templatesMap.has(t.role.toUpperCase())) {
        templatesMap.set(t.role.toUpperCase(), t);
      }
    });

    // Fetch Raw Uploads for the cleanPeriod
    const uploadsCol = collection(db, 'kpi_uploads');
    const uploadsQuery = query(uploadsCol, where('reportingPeriod', '==', cleanPeriod));
    const uploadsSnap = await getDocs(uploadsQuery);

    console.log(`[KPI ENGINE] Running for period: ${cleanPeriod}`);

    if (uploadsSnap.empty) {
      // DEBUG: Log first 10 records to inspect their reportingPeriod
      const diagnosticQuery = query(uploadsCol, limit(10));
      const diagnosticSnap = await getDocs(diagnosticQuery);
      console.log(`[DEBUG KPI ENGINE] Firestore kpi_uploads sample records reportingPeriod:`, diagnosticSnap.docs.map(d => d.data().reportingPeriod));
    }

    // --- TEMPORARY DIAGNOSTIC REMOVED ---
    // OPTIMIZED: Removed second expensive full collection scan of kpi_uploads

    // --- QUERY DIAGNOSTICS ---
    console.log(`Query Executed: where('reportingPeriod', '==', '${cleanPeriod}')`);
    console.log(`Returned Record Count: ${uploadsSnap.size}`);

    if (uploadsSnap.empty) {
      console.warn(`[KPI ENGINE] No uploads located for period "${cleanPeriod}". Scoring calculations skipped.`);
      return { scorecardsCount: 0 };
    }

    // Purge old scorecards for this period to prevent calculation duplicates
    const scorecardsCol = collection(db, 'scorecards');
    const scorecardsQuery = query(scorecardsCol, where('reportingPeriod', '==', cleanPeriod));
    const scorecardsSnap = await getDocs(scorecardsQuery);
    if (!scorecardsSnap.empty) {
      console.log(`[KPI ENGINE] Purging ${scorecardsSnap.size} old scorecards for proper sync...`);
      const batch = writeBatch(db);
      scorecardsSnap.docs.forEach(docSnap => batch.delete(docSnap.ref));
      await batch.commit();
    }

    // Purge old leaderboards
    const leaderboardsCol = collection(db, 'leaderboards');
    const leaderboardsQuery = query(leaderboardsCol, where('reportingPeriod', '==', cleanPeriod));
    const leaderboardsSnap = await getDocs(leaderboardsQuery);
    if (!leaderboardsSnap.empty) {
      console.log(`[KPI ENGINE] Purging ${leaderboardsSnap.size} outdated leaderboards...`);
      const batch = writeBatch(db);
      leaderboardsSnap.docs.forEach(docSnap => batch.delete(docSnap.ref));
      await batch.commit();
    }

    const rawRows = uploadsSnap.docs.map(d => d.data() as KpiUploadRow);

    // Filter, validate, and parse raw uploaded rows
    const validRows: KpiUploadRow[] = [];
    const discoveredProcesses = new Set<string>();

    for (let idx = 0; idx < rawRows.length; idx++) {
      const r = rawRows[idx];
      try {
        const email = r.employeeEmail ? String(r.employeeEmail).trim().toLowerCase() : '';
        const role = r.role ? String(r.role).trim().toUpperCase() : '';
        const process = r.processName ? String(r.processName).trim() : '';
        const kpi = r.kpiName ? String(r.kpiName).trim() : '';

        // Row validation failsafe guards
        if (!email) throw new Error('Employee Email cannot be empty.');
        if (!role) throw new Error('Employee Role cannot be empty.');
        if (!process) throw new Error('Process Name is mandatory.');
        if (!kpi) throw new Error('KPI Name is mandatory.');

        // Normalize dates dynamically
        const dates = normalizeUploadDate(r.reportingPeriod);

        validRows.push({
          ...r,
          id: r.id || `${dates.reportingPeriod}_${process.replace(/[\s\/]+/g, '_')}_${email}_${kpi.replace(/[\s\/]+/g, '_')}`,
          employeeEmail: email,
          role,
          processName: process,
          kpiName: kpi,
          reportingPeriod: dates.reportingPeriod,
          workDate: dates.workDate || r.workDate || `${dates.reportingPeriod}-01`,
          target: r.target !== undefined && !isNaN(Number(r.target)) ? Number(r.target) : 100,
          actual: r.actual !== undefined && !isNaN(Number(r.actual)) ? Number(r.actual) : 0,
          bonus: r.bonus !== undefined && !isNaN(Number(r.bonus)) ? Number(r.bonus) : 0,
          penalty: r.penalty !== undefined && !isNaN(Number(r.penalty)) ? Number(r.penalty) : 0,
          comments: r.comments ? String(r.comments).trim() : '',
          hasMajorEscalation: !!r.hasMajorEscalation
        });

        discoveredProcesses.add(process);
      } catch (rowErr: any) {
        const errMsg = rowErr instanceof Error ? rowErr.message : String(rowErr);
        await writeExceptionLog(
          'INVALID_ROW',
          'error',
          r?.employeeEmail || 'unknown@company.com',
          `Failsafe skip on raw row #${idx}: ${errMsg}`,
          cleanPeriod
        );
      }
    }

    // Dynamic Process Discovery: automatic update and registration
    if (discoveredProcesses.size > 0) {
      try {
        const tmsProcessesRef = doc(db, 'config', 'tmsProcesses');
        const processSnap = await getDoc(tmsProcessesRef);
        
        // Use standard system defaults instead of NCC-specific ones
        const SYSTEM_DEFAULTS = ['HITL', 'MPQC', 'OQC', 'SOP Training', 'QA Review', 'Team Alignment'];
        let existingProcesses: string[] = [...SYSTEM_DEFAULTS];
        
        if (processSnap.exists()) {
          const data = processSnap.data();
          if (Array.isArray(data.list) && data.list.length > 0) {
            existingProcesses = data.list;
          } else if (Array.isArray(data.processes)) {
            existingProcesses = data.processes.map((p: any) => typeof p === 'string' ? p : p.name);
          }
        }
        
        const combined = Array.from(new Set([...existingProcesses, ...discoveredProcesses])).sort();
        
        // Only write if new processes were actually discovered beyond existing or defaults
        if (combined.length > existingProcesses.length || !processSnap.exists()) {
          const structuredProcesses = combined.map(name => ({
            name,
            status: 'Active'
          }));
          
          await setDoc(tmsProcessesRef, { 
            list: combined, 
            processes: structuredProcesses,
            lastAutoDiscoveredAt: new Date().toISOString()
          }, { merge: true });
          
          console.log(`[PROCESS DISCOVERY] Successfully registered/synced process list: ${combined}`);
        }
      } catch (errDiscovery) {
        console.warn('[KPI ENGINE] Optional process discovery storage did not sync:', errDiscovery);
      }
    }

    // Group rows by [Email + Process Name]
    const employeeProcessGroupMap = new Map<string, KpiUploadRow[]>();
    validRows.forEach(row => {
      const gKey = `${row.employeeEmail}_||_${row.processName}`;
      if (!employeeProcessGroupMap.has(gKey)) {
        employeeProcessGroupMap.set(gKey, []);
      }
      employeeProcessGroupMap.get(gKey)!.push(row);
    });

    const computedScorecards: DynamicScorecard[] = [];

    // Audit and construct user profiles dynamically + calculate
    for (const [groupKey, rows] of employeeProcessGroupMap.entries()) {
      if (rows.length === 0) continue;
      const [email, processName] = groupKey.split('_||_');

      try {
        const firstRow = rows[0];
        const roleStr = firstRow.role;

        // USER REGISTRATION INDEPENDENCE check
        const matchedUser = dbUsers.find(u => (u.email || '').toLowerCase().trim() === email.toLowerCase().trim());
        let finalUserName = '';
        let finalTL = '';
        let finalManager = '';
        let isTemp = false;

        if (matchedUser) {
          finalUserName = matchedUser.fullName || matchedUser.name || stringsExtractNameFromEmail(email);
          finalTL = matchedUser.teamLeadName || matchedUser.mappedTL || '';
          finalManager = matchedUser.mappedManagerName || matchedUser.Manager || '';
        } else {
          // No user registered - automatically create a temporary placeholder profile
          isTemp = true;
          finalUserName = stringsExtractNameFromEmail(email);
          const tempId = `placeholder_${email.replace(/[^a-zA-Z0-9]/g, '_')}`;
          
          const tempPayload = {
            uid: tempId,
            email: email,
            name: finalUserName,
            fullName: finalUserName,
            role: mapStringToUserRole(roleStr),
            status: 'Active',
            department: 'Operations',
            Manager: '',
            createdAt: new Date().toISOString(),
            lastLoginAt: '',
            isTemporary: true
          };

          // direct write
          await setDoc(doc(db, 'users', tempId), tempPayload, { merge: true });
          
          // Log the automated creation
          await writeExceptionLog(
            'MISSING_USER',
            'warning',
            email,
            `Employee "${email}" was not pre-registered. Created temporary KPI profile automatically.`,
            cleanPeriod
          );
        }

        // Fetch metrics list template
        const template = templatesMap.get(roleStr) || templatesMap.get('QV')!;

        // Group scorecard breakdown parameters
        const breakdownList: KpiCalculationBreakdown[] = [];
        let totalWeightedScoreRaw = 0;
        let sumOfWeightsOfPresentKPIs = 0;
        let aggregateBonus = 0;
        let aggregatePenalty = 0;
        let hasEscalation = false;

        template.kpis.forEach(kpiDef => {
          const uploadsForKpi = rows.filter(r => (r.kpiName || '').toLowerCase().trim() === (kpiDef.name || '').toLowerCase().trim());
          
          let targetVal = 100;
          let actualVal = 0;
          let isMissing = true;
          let commentEntries: { comment: string, date: string }[] = [];
          let latestComment: string | undefined = undefined;
          let commentCount: number = 0;

          if (uploadsForKpi.length > 0) {
            isMissing = false;
            // Support daily KPI tracking: aggregate metrics safely based on configuration
            const method = kpiDef.aggregationMethod || 'AVERAGE';
            const sumTargets = uploadsForKpi.reduce((sum, r) => sum + Number(r.target || 0), 0);
            const sumActuals = uploadsForKpi.reduce((sum, r) => sum + Number(r.actual || 0), 0);
            
            if (method === 'SUM') {
              targetVal = sumTargets;
              actualVal = sumActuals;
            } else {
              targetVal = Number((sumTargets / uploadsForKpi.length).toFixed(2));
              actualVal = Number((sumActuals / uploadsForKpi.length).toFixed(2));
            }

            uploadsForKpi.forEach(r => {
              aggregateBonus += Number(r.bonus || 0);
              aggregatePenalty += Number(r.penalty || 0);
              if (r.hasMajorEscalation) hasEscalation = true;
              if (r.comments && r.comments.trim()) commentEntries.push({ comment: r.comments.trim(), date: r.workDate || r.reportingPeriod });
            });
            
            commentEntries.sort((a,b) => b.date.localeCompare(a.date));
            latestComment = commentEntries[0]?.comment;
            commentCount = commentEntries.length;
          }

          if (isMissing) {
            // Write MISSING KPI warning log
            writeExceptionLog(
              'MISSING_KPI',
              'warning',
              email,
              `Missing standard KPI "${kpiDef.name}" on ${email} calculation. Re-scaled remaining weight.`,
              cleanPeriod
            );

            breakdownList.push({
              name: kpiDef.name,
              weight: kpiDef.weight,
              type: kpiDef.type,
              dataValueFormat: kpiDef.dataValueFormat || 'number',
              target: 0,
              actual: 0,
              achievementPct: 0,
              weightedScore: 0,
              latestComment: 'Standard KPI was missing from raw upload data.',
              commentCount: 0,
              isMissing: true
            });
          } else {
            sumOfWeightsOfPresentKPIs += kpiDef.weight;
            const achievement = calculateAchievement(kpiDef.type, targetVal, actualVal);
            const weighted = (achievement * kpiDef.weight) / 100;
            totalWeightedScoreRaw += weighted;

            breakdownList.push({
              name: kpiDef.name,
              weight: kpiDef.weight,
              type: kpiDef.type,
              dataValueFormat: kpiDef.dataValueFormat || 'number',
              target: targetVal,
              actual: actualVal,
              achievementPct: Math.round(achievement * 100) / 100,
              weightedScore: Math.round(weighted * 100) / 100,
              latestComment: latestComment || '',
              commentCount: commentCount,
              isMissing: false
            });
          }
        });

        // Loop over non-standard uploaded rows to calculate additional bonus/penalties and escalation flags
        rows.forEach(r => {
          const isStandardKpi = template.kpis.some(k => k.name.toLowerCase().trim() === (r.kpiName || '').toLowerCase().trim());
          if (!isStandardKpi) {
            aggregateBonus += Number(r.bonus || 0);
            aggregatePenalty += Number(r.penalty || 0);
            if (r.hasMajorEscalation) hasEscalation = true;
          }
        });

        // 1. Rescale score fairly if some metrics were missing
        let overallKpiScore = 0;
        if (sumOfWeightsOfPresentKPIs > 0) {
          overallKpiScore = Math.round((totalWeightedScoreRaw / (sumOfWeightsOfPresentKPIs / 100)) * 100) / 100;
        }

        const escalationDelta = hasEscalation ? template.majorEscalationPenalty : 0;
        const rawFinal = overallKpiScore + aggregateBonus - aggregatePenalty - escalationDelta;
        const finalScore = Math.max(0, Math.min(120, Math.round(rawFinal * 100) / 100));

        const scorecardId = `${cleanPeriod}_${processName}_${email}`.replace(/[\s\/]+/g, '_');

        computedScorecards.push({
          id: scorecardId,
          reportingPeriod: cleanPeriod,
          workDate: firstRow.workDate || `${cleanPeriod}-01`,
          employeeEmail: email,
          employeeName: finalUserName,
          role: roleStr,
          processName,
          kpiBreakdown: breakdownList,
          overallKpiScore,
          bonusPoints: aggregateBonus,
          penaltyPoints: aggregatePenalty,
          majorEscalationPenalty: escalationDelta,
          hasMajorEscalation: hasEscalation,
          finalScore,
          rating: getPerformanceRating(finalScore),
          rank: 1, // Default, computed after grouping below
          published: true,
          updatedAt: new Date().toISOString(),
          teamLeadName: finalTL || '',
          mappedManagerName: finalManager || '',
          Manager: finalManager || '',
          isTemporaryUser: !!isTemp
        });
      } catch (scorecardErr: any) {
        const errMsg = scorecardErr instanceof Error ? scorecardErr.message : String(scorecardErr);
        console.error(`[KPI ENGINE] Failsafe: compilation skipped for ${groupKey}:`, scorecardErr);
        await writeExceptionLog(
          'SCORECARD_CALC_FAILED',
          'error',
          email,
          `Failsafe check: compilation skipped for ${groupKey}: ${errMsg}`,
          cleanPeriod
        );
      }
    }

    // Role and process rankings calculations (for Leaderboard updates)
    const rankingGroups = new Map<string, DynamicScorecard[]>();
    computedScorecards.forEach(sc => {
      const gK = `${sc.role.toUpperCase()}_||_${sc.processName}`;
      if (!rankingGroups.has(gK)) {
        rankingGroups.set(gK, []);
      }
      rankingGroups.get(gK)!.push(sc);
    });

    rankingGroups.forEach(group => {
      group.sort((a, b) => b.finalScore - a.finalScore);
      group.forEach((sc, idx) => {
        sc.rank = idx + 1;
      });
    });

    // Commit generated scorecards using safe write batch chunks
    const chunkArray = <T>(arr: T[], size: number): T[][] =>
      Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
        arr.slice(i * size, i * size + size)
      );

    const scorecardChunks = chunkArray(computedScorecards, 400);
    for (const chunk of scorecardChunks) {
      const batch = writeBatch(db);
      chunk.forEach(sc => {
        const ref = doc(db, 'scorecards', sc.id);
        batch.set(ref, sc);
      });
      await batch.commit();
    }

    console.log('========================================================================');
    console.log(`[KPI ENGINE REDESIGNED] COMPLETED SUCCESSFULLY. generated ${computedScorecards.length} scorecards.`);
    console.log('========================================================================');

    return { scorecardsCount: computedScorecards.length };
  } catch (err: any) {
    console.error('[KPI ENGINE ERROR] Fatal calculation error: ', err);
    throw err;
  }
}

// Extract human readable name from employee email address string
export function stringsExtractNameFromEmail(email: string): string {
  const prefix = email.split('@')[0] || 'Employee';
  return prefix
    .split('.')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}
