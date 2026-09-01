import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, writeBatch, query, where, orderBy, getDocsFromCache, limit } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { db, getDocsOptimized, getDocsCacheFirst, getDocOptimized, OperationType } from '../lib/firebase';
import { formatPeriodForDisplay } from '../lib/utils';
import { handleFirestoreError } from '../lib/safeFirestore';
import { safeStorage } from '../lib/safeStorage';
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
 * Clean metric name for target/actual pairing matching
 */
function cleanMetricName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/\btarget\b/gi, '')
    .replace(/\bactual\b/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .replace(/s+$/, ''); // Remove trailing s for minor typos like "Scoress" vs "Scores"
}

export interface KpiHeaderMapping {
  targetProductivityKey: string;
  actualProductivityKey: string;
  productivityLabel: string;
  productivityScoreKey: string;

  targetQualityKey: string;
  actualQualityKey: string;
  qualityLabel: string;
  qualityScoreKey: string;

  targetAttendanceKey: string;
  actualAttendanceKey: string;
  attendanceLabel: string;
  attendanceScoreKey: string;

  targetAptKey: string;
  actualAptKey: string;
  aptLabel: string;
  aptScoreKey: string;
}

export function detectKpiHeaders(headers: string[]): KpiHeaderMapping {
  const mapping: KpiHeaderMapping = {
    targetProductivityKey: 'Target Productivity',
    actualProductivityKey: 'Actual Productivity',
    productivityLabel: 'Productivity',
    productivityScoreKey: 'Productivity Score',

    targetQualityKey: 'Target Quality',
    actualQualityKey: 'Actual Quality',
    qualityLabel: 'Quality',
    qualityScoreKey: 'Quality Score',

    targetAttendanceKey: 'Target Attendance',
    actualAttendanceKey: 'Actual Attendance',
    attendanceLabel: 'Attendance',
    attendanceScoreKey: 'Attendance Score',

    targetAptKey: 'Target APT',
    actualAptKey: 'Actual APT',
    aptLabel: 'APT',
    aptScoreKey: 'APT Score'
  };

  if (!headers || headers.length === 0) return mapping;

  const targetHeaders = headers.filter(h => h && String(h).toLowerCase().includes('target'));
  const pairs: { target: string; actual: string; label: string }[] = [];

  targetHeaders.forEach(tHeader => {
    const baseClean = cleanMetricName(tHeader);
    if (!baseClean) return;

    // Find matching actual header
    const matchingActual = headers.find(h => {
      if (!h || h === tHeader) return false;
      const hLower = String(h).toLowerCase();
      if (!hLower.includes('actual')) return false;
      return cleanMetricName(h) === baseClean;
    });

    if (matchingActual) {
      // Extract label from targetHeader by stripping "target" and excess symbols
      let label = tHeader.replace(/target/i, '').trim();
      // Strip leading/trailing non-alphanumeric except %
      label = label.replace(/^[^a-zA-Z0-9%]+|[^a-zA-Z0-9%]+$/g, '').trim();
      if (!label) label = tHeader;

      pairs.push({
        target: tHeader,
        actual: matchingActual,
        label
      });
    }
  });

  // Now assign detected pairs to slots
  if (pairs.length > 0) {
    const assignedIndices = new Set<number>();

    // Helper to find best matching pair by keyword
    const findBestPair = (keywords: string[]): { pair: typeof pairs[0]; idx: number } | null => {
      for (let i = 0; i < pairs.length; i++) {
        if (assignedIndices.has(i)) continue;
        const labelLower = pairs[i].label.toLowerCase();
        if (keywords.some(kw => labelLower.includes(kw))) {
          return { pair: pairs[i], idx: i };
        }
      }
      return null;
    };

    // Slot 1: Productivity
    const prodMatch = findBestPair(['prod']);
    if (prodMatch) {
      mapping.targetProductivityKey = prodMatch.pair.target;
      mapping.actualProductivityKey = prodMatch.pair.actual;
      mapping.productivityLabel = prodMatch.pair.label;
      assignedIndices.add(prodMatch.idx);
    } else {
      // Fallback to first available
      const firstAvailIdx = pairs.findIndex((_, idx) => !assignedIndices.has(idx));
      if (firstAvailIdx !== -1) {
        mapping.targetProductivityKey = pairs[firstAvailIdx].target;
        mapping.actualProductivityKey = pairs[firstAvailIdx].actual;
        mapping.productivityLabel = pairs[firstAvailIdx].label;
        assignedIndices.add(firstAvailIdx);
      }
    }

    // Slot 2: Quality
    const qualMatch = findBestPair(['qual', 'ata', 'score', 'audit', 'error']);
    if (qualMatch) {
      mapping.targetQualityKey = qualMatch.pair.target;
      mapping.actualQualityKey = qualMatch.pair.actual;
      mapping.qualityLabel = qualMatch.pair.label;
      assignedIndices.add(qualMatch.idx);
    } else {
      const firstAvailIdx = pairs.findIndex((_, idx) => !assignedIndices.has(idx));
      if (firstAvailIdx !== -1) {
        mapping.targetQualityKey = pairs[firstAvailIdx].target;
        mapping.actualQualityKey = pairs[firstAvailIdx].actual;
        mapping.qualityLabel = pairs[firstAvailIdx].label;
        assignedIndices.add(firstAvailIdx);
      }
    }

    // Slot 3: Attendance
    const attMatch = findBestPair(['attend', 'compl', 'escalat', 'leave', 'shift']);
    if (attMatch) {
      mapping.targetAttendanceKey = attMatch.pair.target;
      mapping.actualAttendanceKey = attMatch.pair.actual;
      mapping.attendanceLabel = attMatch.pair.label;
      assignedIndices.add(attMatch.idx);
    } else {
      const firstAvailIdx = pairs.findIndex((_, idx) => !assignedIndices.has(idx));
      if (firstAvailIdx !== -1) {
        mapping.targetAttendanceKey = pairs[firstAvailIdx].target;
        mapping.actualAttendanceKey = pairs[firstAvailIdx].actual;
        mapping.attendanceLabel = pairs[firstAvailIdx].label;
        assignedIndices.add(firstAvailIdx);
      }
    }

    // Slot 4: APT
    const aptMatch = findBestPair(['apt', 'doc', 'accurac', 'handling', 'time']);
    if (aptMatch) {
      mapping.targetAptKey = aptMatch.pair.target;
      mapping.actualAptKey = aptMatch.pair.actual;
      mapping.aptLabel = aptMatch.pair.label;
      assignedIndices.add(aptMatch.idx);
    } else {
      const firstAvailIdx = pairs.findIndex((_, idx) => !assignedIndices.has(idx));
      if (firstAvailIdx !== -1) {
        mapping.targetAptKey = pairs[firstAvailIdx].target;
        mapping.actualAptKey = pairs[firstAvailIdx].actual;
        mapping.aptLabel = pairs[firstAvailIdx].label;
        assignedIndices.add(firstAvailIdx);
      }
    }
  }

  // Find score keys dynamically based on our selected labels
  const findScoreKey = (label: string, defaultKey: string): string => {
    const labelLower = label.toLowerCase();
    // 1. Exact match for "<Label> Score"
    const exactMatch = headers.find(h => h && String(h).toLowerCase() === `${labelLower} score`);
    if (exactMatch) return exactMatch;

    // 2. Contains both label and "score"
    const partialMatch = headers.find(h => {
      if (!h) return false;
      const hLower = String(h).toLowerCase();
      return hLower.includes(labelLower) && hLower.includes('score');
    });
    if (partialMatch) return partialMatch;

    // 3. Fallback to standard key if it exists in sheet headers
    const standardMatch = headers.find(h => h && String(h).toLowerCase() === defaultKey.toLowerCase());
    return standardMatch || defaultKey;
  };

  mapping.productivityScoreKey = findScoreKey(mapping.productivityLabel, 'Productivity Score');
  mapping.qualityScoreKey = findScoreKey(mapping.qualityLabel, 'Quality Score');
  mapping.attendanceScoreKey = findScoreKey(mapping.attendanceLabel, 'Attendance Score');
  mapping.aptScoreKey = findScoreKey(mapping.aptLabel, 'APT Score');

  return mapping;
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

  const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });

  // Get raw headers from the first row of worksheet
  const sheetHeaders: string[] = (XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false })[0] || []) as string[];
  const detectedHeaders = detectKpiHeaders(sheetHeaders);

  const validRecords: KPIScorecard[] = [];
  const invalidRecords: KpiInvalidRecord[] = [];
  const seenDocIdsMap = new Map<string, number>();

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

    // Use detected header keys or standard fallback
    const targetProductivity = row[detectedHeaders.targetProductivityKey] ?? keyMap['targetproductivity'] ?? keyMap['prodtarget'] ?? '-';
    const actualProductivity = row[detectedHeaders.actualProductivityKey] ?? keyMap['actualproductivity'] ?? keyMap['prodactual'] ?? '-';
    const targetQuality = row[detectedHeaders.targetQualityKey] ?? keyMap['targetquality'] ?? keyMap['qualitytarget'] ?? '-';
    const actualQuality = row[detectedHeaders.actualQualityKey] ?? keyMap['actualquality'] ?? keyMap['qualityactual'] ?? '-';
    const targetAttendance = row[detectedHeaders.targetAttendanceKey] ?? keyMap['targetattendance'] ?? keyMap['attendancetarget'] ?? '-';
    const actualAttendance = row[detectedHeaders.actualAttendanceKey] ?? keyMap['actualattendance'] ?? keyMap['attendanceactual'] ?? '-';
    const targetAPT = row[detectedHeaders.targetAptKey] ?? keyMap['targetapt'] ?? keyMap['apttarget'] ?? '-';
    const actualAPT = row[detectedHeaders.actualAptKey] ?? keyMap['actualapt'] ?? keyMap['aptactual'] ?? '-';

    const bonus = parseNumber(keyMap['bonus'], 0);
    const penalty = parseNumber(keyMap['penalty'], 0);
    const comments = String(keyMap['comments'] || keyMap['remarks'] || '').trim();

    const productivityScore = parseNumber(row[detectedHeaders.productivityScoreKey] ?? keyMap['productivityscore'] ?? keyMap['prodscore'], 0);
    const qualityScore = parseNumber(row[detectedHeaders.qualityScoreKey] ?? keyMap['qualityscore'], 0);
    const attendanceScore = parseNumber(row[detectedHeaders.attendanceScoreKey] ?? keyMap['attendancescore'], 0);
    const aptScore = parseNumber(row[detectedHeaders.aptScoreKey] ?? keyMap['aptscore'], 0);
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

    // 2. User lookup from roster
    const matchedUser = rosterMap.get(rawEmail);
    const employeeUid = matchedUser ? matchedUser.uid : `email_${rawEmail.replace(/[^a-z0-9]/gi, '_')}`;
    const employeeName = matchedUser
      ? (matchedUser.fullName || matchedUser.name || matchedUser.employeeName || rawEmail.split('@')[0])
      : rawEmail.split('@')[0];

    // 3. Validate numerical constraints
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
      // Clean period string & process for collision-free document ID
      const cleanPeriod = period.replace(/[^a-zA-Z0-9_-]/g, '');
      const cleanProcess = (process || 'Operations').replace(/[^a-zA-Z0-9_-]/g, '_');
      const baseDocId = `${cleanPeriod}_${employeeUid}_${cleanProcess}`;
      const docOccurrence = (seenDocIdsMap.get(baseDocId) || 0) + 1;
      seenDocIdsMap.set(baseDocId, docOccurrence);
      const docId = docOccurrence === 1 ? baseDocId : `${baseDocId}_${docOccurrence}`;

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
        kpiNameProductivity: detectedHeaders.productivityLabel,
        kpiNameQuality: detectedHeaders.qualityLabel,
        kpiNameAttendance: detectedHeaders.attendanceLabel,
        kpiNameAPT: detectedHeaders.aptLabel,
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
  forceServer: boolean = false,
  currentUserRole?: string
): Promise<KPIScorecard[]> {
  try {
    const colRef = collection(db, 'kpi_scorecards');
    const recordsMap = new Map<string, KPIScorecard>();
    
    // Fetch by UID using cache-first strategy
    if (employeeUid) {
      const qUid = query(colRef, where('employeeUid', '==', employeeUid));
      const snapUid = await getDocsCacheFirst(qUid, `kpi_emp_${employeeUid}`, forceServer);
      snapUid.forEach(d => {
        recordsMap.set(d.id, { id: d.id, ...d.data() } as KPIScorecard);
      });
    }

    // Also check by email to retrieve any records saved with email ID or other UID
    if (employeeEmail) {
      const cleanEmail = employeeEmail.toLowerCase().trim();
      const qEmail = query(colRef, where('employeeEmail', '==', cleanEmail));
      const snapEmail = await getDocsCacheFirst(qEmail, `kpi_emp_email_${cleanEmail}`, forceServer);
      snapEmail.forEach(d => {
        recordsMap.set(d.id, { id: d.id, ...d.data() } as KPIScorecard);
      });
    }

    const records = Array.from(recordsMap.values());

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
 * Fetches lightweight KPI metadata document for instant dropdown population (with 4-hour IndexedDB cache lock)
 */
export async function fetchKpiMetadata(forceRefresh = false): Promise<KpiMetadata> {
  const cacheKey = 'precision360_kpi_metadata_summary';
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

  if (!forceRefresh) {
    try {
      const cached = await safeStorage.getIndexedDB<KpiMetadata>(cacheKey, FOUR_HOURS_MS);
      if (cached) {
        return cached;
      }
    } catch {
      // ignore cache read failure and fallback to DB
    }
  }

  try {
    const metaRef = doc(db, 'kpi_metadata', 'summary');
    const snap = await getDocOptimized(metaRef, 'kpi_meta_summary', forceRefresh);
    if (snap.exists()) {
      const data = snap.data() as KpiMetadata;
      safeStorage.setIndexedDB(cacheKey, data).catch(() => {});
      return data;
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
  forceServer: boolean = false,
  currentUserRole?: string
): Promise<KPIScorecard[]> {
  const normRole = String(currentUserRole || '').toUpperCase().trim();
  if (currentUserRole && normRole !== 'ADMIN' && normRole !== 'MIS') {
    console.warn(`[kpiService] Blocked fetchAllKpiScorecards query for non-authorized role: ${currentUserRole}`);
    return [];
  }
  try {
    const colRef = collection(db, 'kpi_scorecards');
    let q: any = colRef;
    let cacheKey = 'kpi_all_scorecards';

    if (reportingPeriod && reportingPeriod !== 'ALL') {
      q = query(colRef, where('reportingPeriod', '==', reportingPeriod));
      cacheKey = `kpi_period_${reportingPeriod}`;
    } else {
      q = query(colRef, orderBy('uploadedAt', 'desc'));
      cacheKey = 'kpi_all_scorecards_unlimited';
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
 * Deletes all scorecard records
 */
export async function deleteAllKpiScorecards(): Promise<void> {
  try {
    const colRef = collection(db, 'kpi_scorecards');
    const snap = await getDocs(colRef);
    const allIds = snap.docs.map(doc => doc.id);
    if (allIds.length > 0) {
      await deleteKpiScorecardsBulk(allIds);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, 'kpi_scorecards/all');
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
