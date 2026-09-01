import { collection, query, where, orderBy, limit, startAfter, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { UserProfile, TMSShift } from '../types';
import { TMSPermissions } from '../components/PermissionContext';
import { getSubordinateUids, buildAuthoritativeLookupMaps, resolveAuthoritativeHierarchy } from '../lib/hierarchy';
import { calculateShiftMetrics } from '../lib/ledgerCalculations';
import { calculateAttendanceDate } from '../lib/tmsCalculationEngine';
import { buildTimelineFromActivityLedger } from '../lib/tmsUtils';
import { formatShiftLedgerForReport } from '../lib/shiftLedger';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

export interface OrganizationReportScope {
  mode: 'FULL_ORG' | 'MAPPED';
  userIds: string[] | null;
}

export function resolveOrganizationReportScope(params: {
  actor: UserProfile;
  allUsers?: UserProfile[];
  authorizedTeamUids?: string[] | Set<string>;
  hasTmsPermission?: (permKey: keyof TMSPermissions) => boolean;
}): OrganizationReportScope {
  const { actor, allUsers = [], authorizedTeamUids, hasTmsPermission } = params;
  if (!actor) return { mode: 'MAPPED', userIds: [] };
  
  const roleNormalized = (actor.role || '').toString().toUpperCase().trim();
  const isGlobalRole = ['ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN', 'GLOBAL_ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP'].some(g => roleNormalized.includes(g));
  const hasOrgWidePermission = hasTmsPermission ? hasTmsPermission('view_org_wide_workforce_data') : false;
  
  // 1. IF ADMIN / GLOBAL ROLE: Allow unrestricted query access for the entire dataset
  if (isGlobalRole || hasOrgWidePermission) {
    return { mode: 'FULL_ORG', userIds: null };
  }

  // 2. IF AGENT: Restrict scope strictly to their own UID
  const isAgent = roleNormalized === 'AGENT' || roleNormalized.includes('AGENT');
  
  // Bypass agent restriction if parent component explicitly provided authorized team UIDs
  const hasAuthorizedTeam = authorizedTeamUids && (
    (authorizedTeamUids instanceof Set ? authorizedTeamUids.size > 0 : authorizedTeamUids.length > 0)
  );

  if (isAgent && !hasAuthorizedTeam) {
    return { mode: 'MAPPED', userIds: [actor.uid] };
  }

  // 3. IF SUPERVISOR / MANAGER (or team lead):
  // Include their own UID and recursively load all subordinate/team member UIDs
  const mappedSet = new Set<string>();
  
  if (allUsers.length > 0) {
    const subUids = getSubordinateUids(actor, allUsers, false);
    subUids.forEach(id => { if (id) mappedSet.add(id); });
  }

  // Integrate authorizedTeamUids if explicitly passed from parent components
  if (authorizedTeamUids) {
    if (authorizedTeamUids instanceof Set) {
      authorizedTeamUids.forEach(id => { if (id) mappedSet.add(id); });
    } else if (Array.isArray(authorizedTeamUids)) {
      authorizedTeamUids.forEach(id => { if (id) mappedSet.add(id); });
    }
  }

  // Include the supervisor's/manager's own UID
  if (actor.uid) {
    mappedSet.add(actor.uid);
  }

  return { mode: 'MAPPED', userIds: Array.from(mappedSet) };
}

export interface ISTDateRange {
  startIso: string;
  endIso: string;
  startDateStr: string;
  endDateStr: string;
}

export function getISTDateRange(
  preset: string,
  customStartStr?: string,
  customEndStr?: string,
  refDate = new Date()
): ISTDateRange {
  const todayStr = refDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  let startDateStr = todayStr, endDateStr = todayStr;
  if (preset === 'today' || preset === '1') { startDateStr = todayStr; endDateStr = todayStr; }
  else if (preset === 'yesterday') {
    const yDate = new Date(refDate.getTime() - 24 * 60 * 60 * 1000);
    startDateStr = yDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    endDateStr = startDateStr;
  } else if (preset === 'custom') {
    startDateStr = customStartStr || todayStr;
    endDateStr = customEndStr || todayStr;
  } else {
    const cleanPreset = preset.replace('last', '').trim();
    const daysNum = parseInt(cleanPreset, 10) || 30;
    const sDate = new Date(refDate.getTime() - (daysNum - 1) * 24 * 60 * 60 * 1000);
    startDateStr = sDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    endDateStr = todayStr;
  }
  if (startDateStr > endDateStr) { const temp = startDateStr; startDateStr = endDateStr; endDateStr = temp; }
  const startDateObj = new Date(`${startDateStr}T00:00:00.000+05:30`);
  const endDateObj = new Date(`${endDateStr}T23:59:59.999+05:30`);
  return { startIso: startDateObj.toISOString(), endIso: endDateObj.toISOString(), startDateStr, endDateStr };
}

export async function fetchShiftsForReport(params: {
  scope: OrganizationReportScope;
  startIso: string;
  endIso: string;
  onProgress?: (percent: number, message: string) => void;
  onBatch: (shifts: TMSShift[]) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { scope, startIso, endIso, onProgress, onBatch, signal } = params;
  const startTime = performance.now();
  let queriesCount = 0;
  let docsFetchedCount = 0;
  const uniqueShiftIds = new Set<string>();

  const processDocs = (docs: any[]) => {
    const batchShifts: TMSShift[] = [];
    docs.forEach(d => {
      if (!uniqueShiftIds.has(d.id)) {
        uniqueShiftIds.add(d.id);
        batchShifts.push({ id: d.id, ...(d.data() as any) } as TMSShift);
      }
    });
    if (batchShifts.length > 0) {
      onBatch(batchShifts);
    }
  };

  if (scope.mode === 'FULL_ORG') {
    let lastDocSnap: any = null;
    let hasMore = true;
    const pageSize = 1000;

    while (hasMore) {
      if (signal?.aborted) throw new Error('Export cancelled by user');

      const qConstraints: any[] = [
        where('clockInTime', '>=', startIso),
        where('clockInTime', '<=', endIso),
        orderBy('clockInTime', 'asc'),
        limit(pageSize)
      ];

      if (lastDocSnap) qConstraints.push(startAfter(lastDocSnap));

      const q = query(collection(db, 'tmsShifts'), ...qConstraints);
      const snap = await getDocs(q);
      queriesCount++;
      docsFetchedCount += snap.size;

      onProgress?.(30 + Math.min(20, Math.floor(queriesCount * 2)), `Fetching records... (${docsFetchedCount} docs loaded)`);

      if (snap.empty) {
        hasMore = false;
        break;
      }

      processDocs(snap.docs);

      if (snap.docs.length < pageSize) {
        hasMore = false;
      } else {
        lastDocSnap = snap.docs[snap.docs.length - 1];
      }
    }
  } else {
    const userIds = Array.isArray(scope.userIds) ? Array.from(new Set(scope.userIds)) : [];
    if (userIds.length === 0) return;

    const chunks: string[][] = [];
    for (let i = 0; i < userIds.length; i += 10) {
      chunks.push(userIds.slice(i, i + 10));
    }

    const concurrency = 4;
    let chunkIndex = 0;
    const workerCount = Math.max(1, Math.min(concurrency, chunks.length));

    const workers = Array.from({ length: workerCount }, async () => {
      while (chunkIndex < chunks.length) {
        if (signal?.aborted) throw new Error('Export cancelled by user');
        const chunk = chunks[chunkIndex++];
        let lastDocSnap: any = null;
        let hasMoreChunk = true;
        const pageSize = 1000;

        while (hasMoreChunk) {
          if (signal?.aborted) throw new Error('Export cancelled by user');

          const qConstraints: any[] = [
            where('userId', 'in', chunk),
            where('clockInTime', '>=', startIso),
            where('clockInTime', '<=', endIso),
            orderBy('clockInTime', 'asc'),
            limit(pageSize)
          ];

          if (lastDocSnap) qConstraints.push(startAfter(lastDocSnap));

          const q = query(collection(db, 'tmsShifts'), ...qConstraints);
          const snap = await getDocs(q);
          queriesCount++;
          docsFetchedCount += snap.size;

          onProgress?.(30 + Math.min(20, Math.floor((docsFetchedCount / Math.max(1, userIds.length * 20)) * 20)), `Fetching team shifts... (${docsFetchedCount} docs loaded)`);

          if (snap.empty) {
            hasMoreChunk = false;
            break;
          }

          processDocs(snap.docs);

          if (snap.docs.length < pageSize) {
            hasMoreChunk = false;
          } else {
            lastDocSnap = snap.docs[snap.docs.length - 1];
          }
        }
      }
    });

    await Promise.all(workers);
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[TMS REPORT OPTIMIZED] Fetch completed. Duration: ${Math.round(performance.now() - startTime)}ms. Unique records: ${uniqueShiftIds.size}`);
  }
}

export interface ExportReportOptions {
  actor: UserProfile;
  allUsers: UserProfile[];
  authorizedTeamUids?: string[] | Set<string>;
  hasTmsPermission?: (permKey: keyof TMSPermissions) => boolean;
  preset: string;
  startDateStr?: string;
  endDateStr?: string;
  format: 'excel' | 'csv';
  reportType: 'summary' | 'chronological' | 'attendance' | 'both' | 'all';
  onProgress?: (percent: number, message: string) => void;
  signal?: AbortSignal;
}

function createSafeWorksheet(headers: string[], rows: any[][]) {
  const data = [headers];
  for (let i = 0; i < rows.length; i++) {
    data.push(rows[i]);
  }
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = headers.map(() => ({ wch: 18 }));
  return ws;
}

export async function generateAndDownloadOrganizationReport(
  options: ExportReportOptions
): Promise<{ success: boolean; message?: string }> {
  const exportStartTime = performance.now();
  try {
    if (options.signal?.aborted) throw new Error('Export cancelled by user');

    options.onProgress?.(10, 'Resolving organization scope and date range...');
    const scope = resolveOrganizationReportScope({
      actor: options.actor,
      allUsers: options.allUsers,
      authorizedTeamUids: options.authorizedTeamUids,
      hasTmsPermission: options.hasTmsPermission
    });

    const dateRange = getISTDateRange(options.preset, options.startDateStr, options.endDateStr);

    const usersByIdMap = new Map<string, UserProfile>();
    const usersByEmailMap = new Map<string, UserProfile>();
    (options.allUsers || []).forEach(u => {
      if (u.uid) usersByIdMap.set(u.uid, u);
      if (u.email) usersByEmailMap.set(u.email.toLowerCase().trim(), u);
    });

    const includeSummary = options.reportType === 'summary' || options.reportType === 'both' || options.reportType === 'all';
    const includeAttendance = options.reportType === 'attendance' || options.reportType === 'both' || options.reportType === 'all';
    const includeChrono = options.reportType === 'chronological' || options.reportType === 'both' || options.reportType === 'all';

    const summaryRows: any[][] = [];
    const chronoRows: any[][] = [];
    const ledgerRows: any[][] = [];
    
    // For attendance aggregation
    const attendanceAgg = new Map<string, {
      userId: string;
      userEmail: string;
      userName: string;
      process: string;
      attendanceDate: string;
      totalProductiveMs: number;
      earliestClockInMs: number;
      latestClockOutMs: number;
      hasOngoing: boolean;
    }>();

    let processedCount = 0;
    const nowMs = Date.now();

    options.onProgress?.(30, 'Fetching shift records...');

    const fetchedShifts: TMSShift[] = [];

    await fetchShiftsForReport({
      scope,
      startIso: dateRange.startIso,
      endIso: dateRange.endIso,
      signal: options.signal,
      onProgress: (pct, msg) => {
        options.onProgress?.(pct, msg);
      },
      onBatch: (batch) => {
        if (options.signal?.aborted) return;
        fetchedShifts.push(...batch);
      }
    });

    if (options.signal?.aborted) throw new Error('Export cancelled by user');

    if (fetchedShifts.length === 0) {
      options.onProgress?.(100, 'No records found.');
      return { success: false, message: "No TMS shift records found for the selected date range." };
    }

    options.onProgress?.(50, 'Enriching user directory maps...');

    // Extract unique user identifiers from target dataset for dynamic lookup enrichment
    const uniqueUserIds = new Set<string>();
    fetchedShifts.forEach(sh => {
      if (sh.userId) uniqueUserIds.add(sh.userId);
    });

    // Batched/in-memory lookup for any missing UIDs to optimize costs
    const missingUids = Array.from(uniqueUserIds).filter(uid => uid && !usersByIdMap.has(uid));
    if (missingUids.length > 0) {
      const fetchPromises = missingUids.map(async (uid) => {
        try {
          const uDoc = await getDoc(doc(db, 'employee_master', uid));
          if (uDoc.exists()) {
            const data = uDoc.data() as any;
            const profile = { uid: uDoc.id, ...data } as UserProfile;
            usersByIdMap.set(uDoc.id, profile);
            if (profile.email) {
              usersByEmailMap.set(profile.email.toLowerCase().trim(), profile);
            }
          }
        } catch (err) {
          console.error(`Error fetching missing user profile for uid ${uid}:`, err);
        }
      });
      await Promise.all(fetchPromises);
    }

    options.onProgress?.(60, 'Processing shift data and resolving hierarchy...');

    // Authoritative in-memory hierarchy pre-computation
    const authoritativeUsersList: UserProfile[] = Array.from(usersByIdMap.values());
    const lookupMaps = buildAuthoritativeLookupMaps(authoritativeUsersList);
    const hierarchyCache = new Map<string, { teamLead: string; manager: string }>();

    for (const u of authoritativeUsersList) {
      if (u.uid) {
        const h = resolveAuthoritativeHierarchy(u, authoritativeUsersList, lookupMaps);
        hierarchyCache.set(u.uid, { teamLead: h.teamLead, manager: h.manager });
        if (u.email) {
          hierarchyCache.set(u.email.toLowerCase().trim(), { teamLead: h.teamLead, manager: h.manager });
        }
      }
    }

    const getHierarchyForUser = (userId?: string, userEmail?: string, uProf?: UserProfile) => {
      if (userId && hierarchyCache.has(userId)) return hierarchyCache.get(userId)!;
      if (userEmail && hierarchyCache.has(userEmail.toLowerCase().trim())) return hierarchyCache.get(userEmail.toLowerCase().trim())!;
      if (uProf && uProf.uid && hierarchyCache.has(uProf.uid)) return hierarchyCache.get(uProf.uid)!;
      const res = resolveAuthoritativeHierarchy(uProf, authoritativeUsersList, lookupMaps);
      if (userId) hierarchyCache.set(userId, { teamLead: res.teamLead, manager: res.manager });
      if (userEmail) hierarchyCache.set(userEmail.toLowerCase().trim(), { teamLead: res.teamLead, manager: res.manager });
      return res;
    };

    // Sort shift records chronologically
    const sortedShifts = [...fetchedShifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());

    for (const sh of sortedShifts) {
      processedCount++;
      
      let uProfile = sh.userId ? usersByIdMap.get(sh.userId) : undefined;
      if (!uProfile && sh.userEmail) {
        uProfile = usersByEmailMap.get(sh.userEmail.toLowerCase().trim());
      }

      // Authoritative Team Lead & Manager resolution
      const userHier = getHierarchyForUser(sh.userId, sh.userEmail, uProfile);
      const teamLead = userHier.teamLead || 'Unassigned';
      const manager = userHier.manager || 'Unassigned';

      // FALLBACK RESOLUTION FOR EXPORT FIELDS:
      // Resolve Employee ID from shift record, falling back dynamically to user profile in memory, or 'N/A'
      let empId = (sh as any).employeeId || (sh as any).employeeID || (sh as any).empId || (sh as any).empID || '';
      if (typeof empId === 'string') empId = empId.trim();
      if (!empId || empId === 'N/A' || empId === '') {
        empId = uProfile?.employeeId || (uProfile as any)?.empID || (uProfile as any)?.empId || (uProfile as any)?.employeeID || 'N/A';
      }

      // Resolve Location from shift record, falling back dynamically to user profile in memory, or default 'Home' / 'N/A'
      let location = sh.workLocation || (sh as any).location || '';
      if (typeof location === 'string') location = location.trim();
      if (!location || location === 'N/A' || location === '') {
        location = uProfile?.location || (uProfile as any)?.workLocation || 'Home';
      }

      const agentName = sh.userName || uProfile?.name || uProfile?.fullName || 'N/A';
      const agentEmail = sh.userEmail || uProfile?.email || 'N/A';

      const stats = calculateShiftMetrics(sh);
      const workDate = calculateAttendanceDate(sh.clockInTime);
      
      // 1. Summary
      if (includeSummary) {
        const clockIn = new Date(sh.clockInTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
        const clockOut = sh.clockOutTime ? new Date(sh.clockOutTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : 'Ongoing';
        const shActs = sh.activities || [];
        const productiveAct = [...shActs].reverse().find(act => act.type === 'productive');
        const processName = productiveAct ? productiveAct.name : (sh.process || 'N/A');
        const lastAct = shActs.length > 0 ? shActs[shActs.length - 1] : null;
        const lastActivity = lastAct ? lastAct.name : 'N/A';
        
        summaryRows.push([
          empId, agentName, agentEmail, teamLead, manager, sh.status || 'N/A', processName, lastActivity,
          clockIn, clockOut,
          (stats.elapsedMs / 60000).toFixed(1),
          (stats.productiveMs / 60000).toFixed(1),
          (stats.breakMs / 60000).toFixed(1),
          stats.utilization.toFixed(1) + '%',
          location,
          sh.workLocationSource || 'IP Detection',
          sh.officeName || 'N/A',
          sh.publicIP || 'N/A',
          sh.locationCapturedAt ? new Date(sh.locationCapturedAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : 'N/A',
          // Hidden timestamp for sorting later
          new Date(sh.clockInTime).getTime()
        ]);
      }

      // 2. Attendance Aggregation
      if (includeAttendance) {
        const uIdKey = sh.userId || sh.userEmail || 'unknown';
        const aggKey = `${uIdKey}_${workDate}`;
        
        const isOngoing = !sh.clockOutTime && (sh.status === 'ACTIVE' || sh.status === 'BREAK' || !sh.status);
        const inMs = new Date(sh.clockInTime).getTime();
        const outMs = sh.clockOutTime ? new Date(sh.clockOutTime).getTime() : 0;
        const proc = sh.process || uProfile?.process || 'N/A';
        
        if (!attendanceAgg.has(aggKey)) {
          attendanceAgg.set(aggKey, {
            userId: uIdKey,
            userEmail: agentEmail,
            userName: agentName,
            process: proc,
            attendanceDate: workDate,
            totalProductiveMs: 0,
            earliestClockInMs: inMs,
            latestClockOutMs: outMs,
            hasOngoing: isOngoing
          });
        }
        
        const agg = attendanceAgg.get(aggKey)!;
        agg.totalProductiveMs += stats.productiveMs;
        if (inMs < agg.earliestClockInMs) agg.earliestClockInMs = inMs;
        if (outMs > agg.latestClockOutMs) agg.latestClockOutMs = outMs;
        if (isOngoing) agg.hasOngoing = true;
      }

      // 3. Chrono & Ledger
      if (includeChrono) {
        const reconstructed = buildTimelineFromActivityLedger(sh.activities || [], sh.status || 'ACTIVE', sh.clockOutTime, nowMs);
        reconstructed.forEach((act, idx) => {
          const startTimeIST = new Date(act.startTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
          const endTimeIST = act.isLive ? 'Ongoing' : new Date(act.endTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
          const durationMs = new Date(act.endTime).getTime() - new Date(act.startTime).getTime();
          const durationMin = durationMs / 60000;
          chronoRows.push([
            empId, agentName, agentEmail, teamLead, manager, workDate, idx + 1,
            act.type === 'productive' ? 'Productive Work' : 'Break',
            act.name || 'N/A', startTimeIST, endTimeIST, durationMin.toFixed(1),
            // Hidden timestamp for sorting
            new Date(act.startTime).getTime()
          ]);
        });

        const reportRows = formatShiftLedgerForReport(sh);
        reportRows.forEach((r: any) => {
          ledgerRows.push([
            r['Employee'], r['User Email'], teamLead, manager, r['Shift Date'], r['Event Sequence'],
            r['Event Time'], r['Event Type'], r['Old Value'], r['New Value'],
            r['Reason'], r['Source'], r['Performed By'], r['Confidence'], r['Remarks'],
            // Hidden timestamp for sorting
            new Date(sh.clockInTime).getTime(), r['Event Sequence'] || 0
          ]);
        });
      }
    }

    if (options.signal?.aborted) throw new Error('Export cancelled by user');

    if (processedCount === 0) {
      options.onProgress?.(100, 'No records found.');
      return { success: false, message: "No TMS shift records found for the selected date range." };
    }

    options.onProgress?.(60, 'Sorting aggregated reports...');

    // Sort the arrays by the hidden timestamp column before generating worksheet
    if (includeSummary) summaryRows.sort((a, b) => a[a.length - 1] - b[b.length - 1]).forEach(r => r.pop());
    if (includeChrono) {
      chronoRows.sort((a, b) => (a[a.length - 2] - b[b.length - 2]) || (a[a.length - 1] - b[b.length - 1])).forEach(r => { r.pop(); r.pop(); });
      ledgerRows.sort((a, b) => (a[a.length - 2] - b[b.length - 2]) || (a[a.length - 1] - b[b.length - 1])).forEach(r => { r.pop(); r.pop(); });
    }

    options.onProgress?.(70, 'Building Excel Worksheets...');
    const workbook = XLSX.utils.book_new();

    if (includeSummary) {
      options.onProgress?.(75, 'Building Organization Utilization sheet...');
      const summaryHeaders = [
        'Emp ID', 'Name', 'Email ID', 'Team Lead', 'Manager', 'Shift Status', 'Process Name', 'Last Activity',
        'Clock In Time (IST)', 'Clock Out Time (IST)', 'Total Duration (Min)',
        'Productive Duration (Min)', 'Break Duration (Min)', 'Utilization (%)',
        'Work Location', 'Detection Method', 'Office Name', 'Public IP', 'Location Captured At'
      ];
      XLSX.utils.book_append_sheet(workbook, createSafeWorksheet(summaryHeaders, summaryRows), "Organization Utilization");
    }

    if (includeAttendance) {
      options.onProgress?.(80, 'Building Attendance Report sheet...');
      const attendanceHeaders = ['Emp ID', 'Agent Name', 'Agent Email', 'Team Lead', 'Manager', 'Process', 'Date', 'Productive Mins', 'Status'];
      const attendanceRows = Array.from(attendanceAgg.values()).map(agg => {
        const prodMins = agg.totalProductiveMs / 60000;
        let status = 'Absent';
        if (prodMins > 480) status = 'Present';
        else if (prodMins >= 240) status = 'Half Day';
        
        let uProfile = agg.userId ? usersByIdMap.get(agg.userId) : undefined;
        if (!uProfile && agg.userEmail) uProfile = usersByEmailMap.get(agg.userEmail.toLowerCase().trim());
        const empId = uProfile?.employeeId || (uProfile as any)?.empID || 'N/A';
        const userHier = getHierarchyForUser(agg.userId, agg.userEmail, uProfile);
        const teamLead = userHier.teamLead || 'Unassigned';
        const manager = userHier.manager || 'Unassigned';

        return [
          empId, agg.userName, agg.userEmail, teamLead, manager, agg.process, agg.attendanceDate,
          prodMins.toFixed(1), status,
          // Hidden timestamp for sorting
          agg.earliestClockInMs
        ];
      });

      attendanceRows.sort((a, b) => (a[a.length - 1] as number) - (b[b.length - 1] as number)).forEach(r => r.pop());
      XLSX.utils.book_append_sheet(workbook, createSafeWorksheet(attendanceHeaders, attendanceRows), "Attendance Report");
    }

    if (includeChrono) {
      options.onProgress?.(88, 'Building Chronological Activity & Ledger sheets...');
      const chronoHeaders = [
        'Emp ID', 'Agent Name', 'Agent Email', 'Team Lead', 'Manager', 'Date (IST)', 'Action Sequence',
        'Duration Type', 'Specific Activity / Break Type', 'Start Time (IST)',
        'End Time (IST)', 'Duration (Mins)'
      ];
      XLSX.utils.book_append_sheet(workbook, createSafeWorksheet(chronoHeaders, chronoRows), "Chronological Activity Logs");

      const ledgerHeaders = [
        'Employee', 'User Email', 'Team Lead', 'Manager', 'Shift Date', 'Event Sequence', 'Event Time',
        'Event Type', 'Old Value', 'New Value', 'Reason', 'Source',
        'Performed By', 'Confidence', 'Remarks'
      ];
      XLSX.utils.book_append_sheet(workbook, createSafeWorksheet(ledgerHeaders, ledgerRows), "Immutable Event Ledger");
    }

    if (options.signal?.aborted) throw new Error('Export cancelled by user');

    options.onProgress?.(95, 'Packaging ZIP archive and downloading...');
    const safeUserSuffix = (options.actor.fullName || options.actor.name || 'User').split(' ').join('_');
    const scopePrefix = scope.mode === 'FULL_ORG' ? 'TMS_Org' : 'TMS_Team';
    const zip = new JSZip();

    if (options.format === 'excel') {
      const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      zip.file(`${scopePrefix}_Report_${dateRange.startDateStr}_to_${dateRange.endDateStr}_${safeUserSuffix}.xlsx`, excelBuffer);
    } else {
      const firstSheetName = workbook.SheetNames[0] || "Report";
      const csvContent = "\uFEFF" + XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheetName]);
      zip.file(`${scopePrefix}_Report_${dateRange.startDateStr}_to_${dateRange.endDateStr}_${safeUserSuffix}.csv`, csvContent);
    }

    const zipContent = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const url = URL.createObjectURL(zipContent);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `${scopePrefix}_Report_${dateRange.startDateStr}_to_${dateRange.endDateStr}.zip`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    const totalDurationMs = Math.round(performance.now() - exportStartTime);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[TMS ORG EXPORT SUCCESS] TotalDuration=${totalDurationMs}ms, ProcessedRecords=${processedCount}`);
    }

    options.onProgress?.(100, 'Export complete!');
    return { success: true };
  } catch (err: any) {
    const errorDurationMs = Math.round(performance.now() - exportStartTime);
    console.error(`[TMS ORG EXPORT ERROR] Elapsed=${errorDurationMs}ms`, err);
    return {
      success: false,
      message: err?.message || "Failed to generate organization report due to serialization or memory limits."
    };
  }
}
