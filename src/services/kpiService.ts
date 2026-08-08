import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, writeBatch, query, where, orderBy, getDocsFromCache } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { db, getDocsOptimized, getDocsCacheFirst, getDocOptimized, OperationType } from '../lib/firebase';
import { formatPeriodForDisplay } from '../lib/utils';
import { handleFirestoreError } from '../lib/safeFirestore';
import { KPIScorecard, UserProfile } from '../types';

export interface KpiInvalidRecord {
  rowIndex: number;
  email: string;
  period: string;
  reasons: string[];
  rawData: Record<string, any>;
}

export interface KpiParseResult {
  totalRecords: number;
  validRecords: KPIScorecard[];
  invalidRecords: KpiInvalidRecord[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
  };
}

/**
 * Downloads a sample Excel upload template with standard column headers and example rows.
 */
export function downloadKpiTemplate() {
  const headers = [
    'Reporting Period',
    'Employee Email',
    'Role',
    'Process Name',
    'Target Productivity',
    'Actual Productivity',
    'Target Quality',
    'Actual Quality',
    'Target Attendance',
    'Actual Attendance',
    'Target APT',
    'Actual APT',
    'Bonus',
    'Penalty',
    'Comments',
    'Productivity Score',
    'Quality Score',
    'Attendance Score',
    'APT Score',
    'Total Score',
    'Process Rank',
    'Role Rank',
    'Organization Rank',
  ];

  const sampleRows = [
    {
      'Reporting Period': 'May-25',
      'Employee Email': 'john.doe@bergtechnologies.co.in',
      'Role': 'AGENT',
      'Process Name': 'Operations',
      'Target Productivity': '100%',
      'Actual Productivity': '98%',
      'Target Quality': '95%',
      'Actual Quality': '96%',
      'Target Attendance': '100%',
      'Actual Attendance': '100%',
      'Target APT': '3.5 min',
      'Actual APT': '3.2 min',
      'Bonus': 50,
      'Penalty': 0,
      'Comments': 'Consistent high performance throughout month',
      'Productivity Score': 25,
      'Quality Score': 25,
      'Attendance Score': 25,
      'APT Score': 20,
      'Total Score': 95,
      'Process Rank': 1,
      'Role Rank': 1,
      'Organization Rank': 1,
    },
    {
      'Reporting Period': 'May-25',
      'Employee Email': 'jane.smith@bergtechnologies.co.in',
      'Role': 'AGENT',
      'Process Name': 'Customer Support',
      'Target Productivity': '100%',
      'Actual Productivity': '92%',
      'Target Quality': '95%',
      'Actual Quality': '94%',
      'Target Attendance': '95%',
      'Actual Attendance': '95%',
      'Target APT': '4.0 min',
      'Actual APT': '4.1 min',
      'Bonus': 0,
      'Penalty': 10,
      'Comments': 'Met core targets with minor penalty for handling delay',
      'Productivity Score': 23,
      'Quality Score': 24,
      'Attendance Score': 23,
      'APT Score': 18,
      'Total Score': 78,
      'Process Rank': 3,
      'Role Rank': 5,
      'Organization Rank': 12,
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(sampleRows, { header: headers });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'KPI Scorecards');

  // Auto-fit column widths
  const colWidths = headers.map(h => ({ wch: Math.max(h.length + 4, 16) }));
  worksheet['!cols'] = colWidths;

  XLSX.writeFile(workbook, 'KPI_Scorecard_Upload_Template.xlsx');
}

/**
 * Normalizes header keys to standard lowercase keys
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Safely converts value to clean number
 */
function parseNumber(val: any, fallback: number = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  if (typeof val === 'number') return isNaN(val) ? fallback : val;
  const str = String(val).replace(/[^0-9.-]/g, '');
  const num = parseFloat(str);
  return isNaN(num) ? fallback : num;
}

/**
 * Parses and validates Excel file for KPI scorecards
 */
export async function parseAndValidateKpiExcel(
  file: File,
  roster: UserProfile[]
): Promise<KpiParseResult> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  const validRecords: KPIScorecard[] = [];
  const invalidRecords: KpiInvalidRecord[] = [];
  const seenEmailsInFile = new Set<string>();

  // Helper map for roster email -> user profile
  const rosterMap = new Map<string, UserProfile>();
  roster.forEach(u => {
    if (u.email) {
      rosterMap.set(u.email.toLowerCase().trim(), u);
    }
  });

  rawRows.forEach((row, index) => {
    const rowIndex = index + 2; // Row number in Excel (1 is header)
    const reasons: string[] = [];

    // Map row keys dynamically
    const keyMap: Record<string, any> = {};
    Object.keys(row).forEach(k => {
      keyMap[normalizeKey(k)] = row[k];
    });

    const rawPeriod = String(
      keyMap['reportingperiod'] ||
      keyMap['period'] ||
      keyMap['month'] ||
      ''
    ).trim();
    const period = formatPeriodForDisplay(rawPeriod);

    const rawEmail = String(
      keyMap['employeeemail'] ||
      keyMap['email'] ||
      keyMap['officialemail'] ||
      ''
    ).trim().toLowerCase();

    const role = String(keyMap['role'] || 'AGENT').trim();
    const process = String(keyMap['processname'] || keyMap['process'] || 'Operations').trim();

    const targetProductivity = keyMap['targetproductivity'] || keyMap['prodtarget'] || '-';
    const actualProductivity = keyMap['actualproductivity'] || keyMap['prodactual'] || '-';
    const targetQuality = keyMap['targetquality'] || keyMap['qualitytarget'] || '-';
    const actualQuality = keyMap['actualquality'] || keyMap['qualityactual'] || '-';
    const targetAttendance = keyMap['targetattendance'] || keyMap['attendancetarget'] || '-';
    const actualAttendance = keyMap['actualattendance'] || keyMap['attendanceactual'] || '-';
    const targetAPT = keyMap['targetapt'] || keyMap['apttarget'] || '-';
    const actualAPT = keyMap['actualapt'] || keyMap['aptactual'] || '-';

    const bonus = parseNumber(keyMap['bonus'], 0);
    const penalty = parseNumber(keyMap['penalty'], 0);
    const comments = String(keyMap['comments'] || keyMap['remarks'] || '').trim();

    const productivityScore = parseNumber(keyMap['productivityscore'] || keyMap['prodscore'], 0);
    const qualityScore = parseNumber(keyMap['qualityscore'], 0);
    const attendanceScore = parseNumber(keyMap['attendancescore'], 0);
    const aptScore = parseNumber(keyMap['aptscore'], 0);
    const totalScore = parseNumber(keyMap['totalscore'] || keyMap['score'] || keyMap['finalscore'], 0);
    
    // Extract Multi-dimension Ranks
    const processRankRaw = keyMap['processrank'] ?? keyMap['process_rank'] ?? keyMap['procrank'];
    const roleRankRaw = keyMap['rolerank'] ?? keyMap['role_rank'];
    const orgRankRaw = keyMap['organizationrank'] ?? keyMap['organization_rank'] ?? keyMap['orgrank'] ?? keyMap['org_rank'];
    const legacyRankRaw = keyMap['rank'];

    const processRank = processRankRaw !== undefined && processRankRaw !== '' ? parseNumber(processRankRaw, 0) : '-';
    const roleRank = roleRankRaw !== undefined && roleRankRaw !== '' ? parseNumber(roleRankRaw, 0) : '-';
    const organizationRank = orgRankRaw !== undefined && orgRankRaw !== '' 
      ? parseNumber(orgRankRaw, 0) 
      : (legacyRankRaw !== undefined && legacyRankRaw !== '' ? parseNumber(legacyRankRaw, 0) : '-');
    const rank = legacyRankRaw !== undefined && legacyRankRaw !== '' ? parseNumber(legacyRankRaw, 0) : organizationRank;

    // 1. Validate mandatory fields
    if (!period) {
      reasons.push('Missing Reporting Period (e.g. May-25)');
    }
    if (!rawEmail) {
      reasons.push('Missing Employee Email');
    } else {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(rawEmail)) {
        reasons.push(`Invalid email format: "${rawEmail}"`);
      }
    }

    // 2. Check for duplicate email in current file batch
    const duplicateKey = `${period.toLowerCase()}_${rawEmail}`;
    if (rawEmail && period) {
      if (seenEmailsInFile.has(duplicateKey)) {
        reasons.push(`Duplicate email found in file for period "${period}": ${rawEmail}`);
      } else {
        seenEmailsInFile.add(duplicateKey);
      }
    }

    // 3. User lookup from roster
    const matchedUser = rosterMap.get(rawEmail);
    const employeeUid = matchedUser ? matchedUser.uid : `email_${rawEmail.replace(/[^a-z0-9]/gi, '_')}`;
    const employeeName = matchedUser
      ? (matchedUser.fullName || matchedUser.name || matchedUser.employeeName || rawEmail.split('@')[0])
      : rawEmail.split('@')[0];

    // 4. Validate numerical constraints
    if (isNaN(totalScore)) {
      reasons.push('Invalid Total Score value');
    }

    if (reasons.length > 0) {
      invalidRecords.push({
        rowIndex,
        email: rawEmail || 'N/A',
        period: period || 'N/A',
        reasons,
        rawData: row,
      });
    } else {
      // Clean period string for document ID: e.g., May-25 -> May-25
      const cleanPeriod = period.replace(/[^a-zA-Z0-9_-]/g, '');
      const docId = `${cleanPeriod}_${employeeUid}`;

      validRecords.push({
        id: docId,
        reportingPeriod: period,
        employeeUid,
        employeeEmail: rawEmail,
        employeeName,
        role,
        process,
        targetProductivity,
        actualProductivity,
        targetQuality,
        actualQuality,
        targetAttendance,
        actualAttendance,
        targetAPT,
        actualAPT,
        bonus,
        penalty,
        comments,
        productivityScore,
        qualityScore,
        attendanceScore,
        aptScore,
        totalScore,
        rank,
        processRank,
        roleRank,
        organizationRank,
        uploadedBy: '', // Set during import
        uploadedAt: new Date().toISOString(),
      });
    }
  });

  return {
    totalRecords: rawRows.length,
    validRecords,
    invalidRecords,
    summary: {
      total: rawRows.length,
      valid: validRecords.length,
      invalid: invalidRecords.length,
    },
  };
}

/**
 * Imports validated KPI scorecards to Firestore in batches
 */
export async function importKpiScorecards(
  records: KPIScorecard[],
  user: UserProfile
): Promise<number> {
  if (records.length === 0) return 0;

  const uploadedBy = user.email || user.fullName || user.name || 'Admin';
  const uploadedAt = new Date().toISOString();

  const BATCH_SIZE = 400;
  let importedCount = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);
    const batch = writeBatch(db);

    chunk.forEach(rec => {
      const docRef = doc(db, 'kpi_scorecards', rec.id);
      const dataToSave: KPIScorecard = {
        ...rec,
        uploadedBy,
        uploadedAt,
      };
      batch.set(docRef, dataToSave, { merge: true });
    });

    try {
      await batch.commit();
      importedCount += chunk.length;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'kpi_scorecards');
    }
  }

  return importedCount;
}

/**
 * Fetches scorecards for a specific employee (Cache First -> Fallback to Network)
 */
export async function fetchEmployeeKpiScorecards(
  employeeUid: string,
  employeeEmail: string,
  forceServer: boolean = false
): Promise<KPIScorecard[]> {
  try {
    const colRef = collection(db, 'kpi_scorecards');
    
    // Fetch by UID using cache-first strategy
    const qUid = query(colRef, where('employeeUid', '==', employeeUid));
    const snapUid = await getDocsCacheFirst(qUid, `kpi_emp_${employeeUid}`, forceServer);
    
    let records: KPIScorecard[] = [];
    snapUid.forEach(d => {
      records.push({ id: d.id, ...d.data() } as KPIScorecard);
    });

    // Also fallback check by email if UID returned 0
    if (records.length === 0 && employeeEmail) {
      const qEmail = query(colRef, where('employeeEmail', '==', employeeEmail.toLowerCase().trim()));
      const snapEmail = await getDocsCacheFirst(qEmail, `kpi_emp_email_${employeeEmail}`, forceServer);
      snapEmail.forEach(d => {
        records.push({ id: d.id, ...d.data() } as KPIScorecard);
      });
    }

    // Sort by uploadedAt descending
    records.sort((a, b) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime());
    return records;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, 'kpi_scorecards');
    return [];
  }
}

export interface KpiMetadata {
  reportingPeriods: string[];
  processes: string[];
  roles: string[];
}

/**
 * Fetches lightweight KPI metadata document for instant dropdown population
 */
export async function fetchKpiMetadata(): Promise<KpiMetadata> {
  try {
    const metaRef = doc(db, 'kpi_metadata', 'summary');
    const snap = await getDocOptimized(metaRef, 'kpi_meta_summary');
    if (snap.exists()) {
      return snap.data() as KpiMetadata;
    }
  } catch (e) {
    console.warn('Metadata document not found, fallback to dynamic derivation:', e);
  }
  return { reportingPeriods: [], processes: [], roles: [] };
}

/**
 * Fetches team scorecards for Managers/Admins filtered by reportingPeriod (Cache First -> Fallback to Network)
 */
export async function fetchAllKpiScorecards(
  reportingPeriod?: string,
  forceServer: boolean = false
): Promise<KPIScorecard[]> {
  try {
    const colRef = collection(db, 'kpi_scorecards');
    let q: any = colRef;
    let cacheKey = 'kpi_all_scorecards';

    if (reportingPeriod && reportingPeriod !== 'ALL') {
      q = query(colRef, where('reportingPeriod', '==', reportingPeriod));
      cacheKey = `kpi_period_${reportingPeriod}`;
    }

    const snap = await getDocsCacheFirst(q, cacheKey, forceServer);
    const records: KPIScorecard[] = [];
    snap.forEach(d => {
      records.push({ id: d.id, ...d.data() } as KPIScorecard);
    });

    records.sort((a, b) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime());
    return records;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, 'kpi_scorecards');
    return [];
  }
}

/**
 * Deletes a single scorecard
 */
export async function deleteKpiScorecard(docId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'kpi_scorecards', docId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `kpi_scorecards/${docId}`);
  }
}

/**
 * Deletes multiple scorecards in a batch
 */
export async function deleteKpiScorecardsBulk(docIds: string[]): Promise<void> {
  try {
    const CHUNK_SIZE = 500;
    for (let i = 0; i < docIds.length; i += CHUNK_SIZE) {
      const chunk = docIds.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);
      chunk.forEach(id => {
        batch.delete(doc(db, 'kpi_scorecards', id));
      });
      await batch.commit();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `kpi_scorecards/bulk`);
  }
}

/**
 * Checks if a user's role is permitted to export KPI scorecards.
 * Allowed roles: Admin, Manager, MIS, HR.
 */
export function canExportKpi(roleStr?: string): boolean {
  if (!roleStr) return false;
  const normalized = String(roleStr).toUpperCase().trim();
  return (
    normalized === 'ADMIN' ||
    normalized === 'MANAGER' ||
    normalized === 'MIS' ||
    normalized === 'HR'
  );
}

/**
 * Exports KPI scorecard records to Excel (.xlsx) or CSV format.
 * Includes all KPI fields exactly as uploaded without recalculation or engine calls.
 */
export function exportKpiScorecardsData(
  records: KPIScorecard[],
  format: 'xlsx' | 'csv' = 'xlsx',
  filename: string = 'KPI_Scorecard_Report',
  roster: UserProfile[] = []
) {
  const rosterMap = new Map<string, UserProfile>();
  roster.forEach(u => {
    if (u.email) rosterMap.set(u.email.toLowerCase().trim(), u);
  });

  const exportData = records.map(r => {
    const matchedUser = r.employeeEmail ? rosterMap.get(r.employeeEmail.toLowerCase().trim()) : undefined;
    const empId = r.employeeId || matchedUser?.employeeId || '-';
    const uploadedDate = r.uploadedAt ? new Date(r.uploadedAt).toLocaleString() : '';

    return {
      'Reporting Period': r.reportingPeriod || '-',
      'Employee Name': r.employeeName || '-',
      'Employee Email': r.employeeEmail || '-',
      'Employee ID': empId,
      'Role': r.role || '-',
      'Process Name': r.process || '-',
      'Target Productivity': r.targetProductivity ?? '-',
      'Actual Productivity': r.actualProductivity ?? '-',
      'Target Quality': r.targetQuality ?? '-',
      'Actual Quality': r.actualQuality ?? '-',
      'Target Attendance': r.targetAttendance ?? '-',
      'Actual Attendance': r.actualAttendance ?? '-',
      'Target APT': r.targetAPT ?? '-',
      'Actual APT': r.actualAPT ?? '-',
      'Bonus': r.bonus ?? 0,
      'Penalty': r.penalty ?? 0,
      'Comments': r.comments || '',
      'Productivity Score': r.productivityScore ?? 0,
      'Quality Score': r.qualityScore ?? 0,
      'Attendance Score': r.attendanceScore ?? 0,
      'APT Score': r.aptScore ?? 0,
      'Total Score': r.totalScore ?? 0,
      'Process Rank': r.processRank ?? '-',
      'Role Rank': r.roleRank ?? '-',
      'Organization Rank': r.organizationRank ?? r.rank ?? '-',
      'Uploaded By': r.uploadedBy || '-',
      'Uploaded Date': uploadedDate,
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(exportData);

  if (format === 'csv') {
    const csvOutput = XLSX.utils.sheet_to_csv(worksheet);
    const blob = new Blob([csvOutput], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const finalFilename = filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`;
    link.href = url;
    link.setAttribute('download', finalFilename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } else {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'KPI Scorecards');
    const finalFilename = filename.toLowerCase().endsWith('.xlsx') ? filename : `${filename}.xlsx`;
    XLSX.writeFile(workbook, finalFilename);
  }
}

/**
 * Exports current KPI list to Excel
 */
export function exportKpiToExcel(records: KPIScorecard[], filename: string = 'KPI_Scorecard_Report.xlsx', roster: UserProfile[] = []) {
  exportKpiScorecardsData(records, 'xlsx', filename, roster);
}
