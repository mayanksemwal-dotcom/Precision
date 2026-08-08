import { buildTimelineFromActivityLedger, isAuditOrDiagnosticEvent } from './tmsUtils';

// Universal Firestore & JS timestamp parser returning Unix milliseconds
export function parseTimestampMs(val: any): number {
  if (!val) return 0;
  if (typeof val === 'number') {
    if (val < 1e11) return val * 1000; // Unix seconds -> ms
    return val;
  }
  if (typeof val === 'object') {
    if (typeof val.toDate === 'function') {
      try { return val.toDate().getTime(); } catch { /* fallthrough */ }
    }
    if (typeof val.seconds === 'number') {
      return val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1000000);
    }
    if (typeof val._seconds === 'number') {
      return val._seconds * 1000 + Math.floor((val._nanoseconds || 0) / 1000000);
    }
    if (val instanceof Date) {
      return val.getTime();
    }
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return 0;
    if (!isNaN(Number(trimmed)) && trimmed.length >= 10) {
      const num = Number(trimmed);
      return num < 1e11 ? num * 1000 : num;
    }
    let parsed = new Date(trimmed).getTime();
    if (!isNaN(parsed) && parsed > 0) return parsed;

    const noComma = trimmed.replace(/,/g, '');
    parsed = new Date(noComma).getTime();
    if (!isNaN(parsed) && parsed > 0) return parsed;

    const isoFixed = trimmed.replace(' ', 'T');
    const parsedIso = new Date(isoFixed).getTime();
    if (!isNaN(parsedIso) && parsedIso > 0) return parsedIso;
  }
  return 0;
}

export const BREAK_KEYWORDS = [
  'lunch',
  'tea',
  'bio',
  'break',
  'rest',
  'coffee',
  'meal',
  'snack',
  'recess',
  'refreshment'
];

export function isBreakActivity(activityName?: string, activityType?: string): boolean {
  if (activityType === 'system' || activityType === 'system_repair') return false;
  if (activityType === 'break') return true;
  if (activityType === 'productive') return false;
  if (!activityName) return false;
  const nameLower = activityName.toLowerCase().trim();
  if (nameLower.includes('system_repair') || nameLower.includes('system repair') || nameLower.includes('clock out repair') || nameLower.includes('audit')) return false;
  return BREAK_KEYWORDS.some(k => {
    const regex = new RegExp(`\\b${k}\\b`, 'i');
    return regex.test(nameLower);
  });
}

export function formatMs(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export interface ShiftMetrics {
  elapsedMs: number;
  totalShiftMs: number; // alias for elapsedMs
  productiveMs: number;
  activeMs: number; // alias for productiveMs (total productive duration)
  breakMs: number;
  connectedMs: number;
  utilization: number;
  elapsedStr: string;
  totalShiftStr: string; // alias for elapsedStr
  activeStr: string; // alias for productiveMs (total productive duration string)
  breakStr: string;
  connectedStr: string;
  
  // Explicitly requested independent calculations
  activeWorkMs: number;
  activeWorkStr: string;
  totalBreaks: number;
  productiveStr: string;
}

// Internal function to calculate a single shift's ledger times (Productive & Break)
export function calculateLedgerTimes(s: any, nowMs: number) {
  let productiveMs = 0;
  let breakMs = 0;

  let acts = s.activities || [];
  if (!acts || !Array.isArray(acts) || acts.length === 0) {
    if (s.clockInTime) {
      acts = [{
        startTime: s.clockInTime,
        type: s.status === 'BREAK' ? 'break' : 'productive',
        name: s.status === 'BREAK' ? 'Break' : 'Work',
        action: s.status === 'BREAK' ? 'BREAK_START' : 'CLOCK_IN'
      }];
    } else {
      return { productiveMs, breakMs };
    }
  }

  // Sort activities chronologically
  const sortedActs = [...acts].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  
  // Filter out audit/system events
  const validActs = sortedActs.filter(act => !isAuditOrDiagnosticEvent(act.action) && act.type !== 'system');

  for (let i = 0; i < validActs.length; i++) {
    const act = validActs[i];
    const startMs = new Date(act.startTime).getTime();
    
    let endMs;
    if (i < validActs.length - 1) {
      endMs = new Date(validActs[i+1].startTime).getTime();
    } else {
      endMs = s.clockOutTime ? new Date(s.clockOutTime).getTime() : nowMs;
    }
    
    const durationMs = Math.max(0, endMs - startMs);
    const actName = (act.name || act.currentActivity || '').toLowerCase();
    const isMeetingOrTraining = ['meeting', 'coaching', 'training', 'alignment', '1:1', 'one-on-one', 'upskilling', 'onboarding'].some(k => actName.includes(k));
    
    let isProductive = false;
    if (act.type === 'productive' || isMeetingOrTraining) {
      isProductive = true;
    } else if (act.type === 'break' || (act.action && act.action.includes('BREAK'))) {
      isProductive = false;
    } else {
      const isBreakName = isBreakActivity(act.name || act.currentActivity || act.activityName || '', act.type);
      isProductive = !isBreakName;
    }

    if (isProductive) {
      productiveMs += durationMs;
    } else {
      breakMs += durationMs;
    }
  }

  return { productiveMs, breakMs };
}

// Compat wrapper for calculateMetricsFromLedger
export function calculateMetricsFromLedger(
  activities: any[],
  referenceTimeMs: number,
  status: string = 'ACTIVE',
  clockOutTime?: string,
  clockInTime?: string
) {
  return calculateLedgerTimes({ activities, status, clockOutTime, clockInTime }, referenceTimeMs);
}

// Internal function to calculate active work for a single shift
export function getActiveWork(s: any, nowMs: number): number {
  if (!s || s.clockOutTime) return 0;
  const acts = s.activities || [];
  if (!Array.isArray(acts) || acts.length === 0) return 0;

  const sortedActs = [...acts]
    .map(act => ({ ...act, startMs: parseTimestampMs(act.startTime) }))
    .sort((a, b) => a.startMs - b.startMs);
  
  const validActs = sortedActs.filter(
    act => !isAuditOrDiagnosticEvent(act.action) && act.type !== 'system'
  );
  
  if (validActs.length === 0) return 0;
  
  const latestAct = validActs[validActs.length - 1];
  
  const isProd = !isBreakActivity(
    latestAct.name || latestAct.currentActivity || latestAct.activityName || '',
    latestAct.type
  );
  
  const hasNoEndTime = !latestAct.endTime;
  
  if (isProd && hasNoEndTime) {
    return Math.max(0, nowMs - latestAct.startMs);
  }
  
  return 0;
}

export function calculateShiftMetrics(
  input: any,
  nowMs: number = Date.now()
): ShiftMetrics {
  let currentShift: any = null;
  let completedShiftsToday: any[] = [];
  let aggregationMode: 'CURRENT_SHIFT' | 'TODAY' = 'CURRENT_SHIFT';

  if (
    input &&
    typeof input === 'object' &&
    ('currentShift' in input || 'completedShiftsToday' in input || 'myPastShifts' in input || 'aggregationMode' in input)
  ) {
    currentShift = input.currentShift || input.shift || null;
    aggregationMode = input.aggregationMode || 'CURRENT_SHIFT';

    if (input.completedShiftsToday && Array.isArray(input.completedShiftsToday)) {
      completedShiftsToday = input.completedShiftsToday;
    } else if (input.myPastShifts && Array.isArray(input.myPastShifts)) {
      const now = new Date(nowMs);
      const nowLocalDateString = now.toDateString();
      completedShiftsToday = input.myPastShifts.filter((s: any) => {
        const isCompleted = s.status !== 'ACTIVE' && s.status !== 'BREAK';
        if (!isCompleted || s.id === currentShift?.id) return false;
        const shiftInDate = new Date(s.clockInTime);
        return shiftInDate.toDateString() === nowLocalDateString;
      });
    }
  } else {
    currentShift = input;
  }

  let totalElapsedMs = 0;
  let totalProductiveMs = 0;
  let totalBreakMs = 0;
  let totalBreaksCount = 0;
  let totalActiveWorkMs = 0;

  const processSingleShift = (s: any) => {
    if (!s || !s.clockInTime) return;
    
    // 1. Shift Elapsed
    console.log('[TMS TIMER DEBUG] calculateShiftMetrics', {
      nowMs,
      status: s.status,
      clockInTime: s.clockInTime,
  });
  const startMs = parseTimestampMs(s.clockInTime);
    if (startMs === 0) return;
    // Always use nowMs (passed from useSharedTimer) for active shifts
    const endMs = (s.clockOutTime && s.status !== 'ACTIVE' && s.status !== 'BREAK') ? parseTimestampMs(s.clockOutTime) : nowMs;
    const elapsedMs = Math.max(0, endMs - startMs);

    // 3. Productive Work and 5. Break Duration
    const { productiveMs, breakMs } = calculateLedgerTimes(s, endMs);
    
    // 2. Active Work (same as productiveMs as per specs)
    const activeWorkMs = productiveMs;

    // 4. Total Breaks (Count every BREAK_START activity)
    const acts = s.activities || [];
    const breaksCount = acts.filter((act: any) => act && act.action && act.action.toUpperCase().trim() === 'BREAK_START').length;

    totalElapsedMs += elapsedMs;
    totalProductiveMs += productiveMs;
    totalBreakMs += breakMs;
    totalBreaksCount += breaksCount;
    totalActiveWorkMs += activeWorkMs;
  };

  if (aggregationMode === 'TODAY') {
    if (completedShiftsToday && completedShiftsToday.length > 0) {
      completedShiftsToday.forEach(s => processSingleShift(s));
    }
    if (currentShift) {
      processSingleShift(currentShift);
    }
  } else {
    if (currentShift) {
      processSingleShift(currentShift);
    }
  }

  // 6. Total Connected
  const connectedMs = totalProductiveMs + totalBreakMs;

  // 7. Utilization
  const productiveMins = totalProductiveMs / 60000;
  const utilization = Math.min((productiveMins / 480) * 100, 100);
  const formattedUtilization = Number(utilization.toFixed(1));

  const elapsedStr = formatMs(totalElapsedMs);
  const activeStr = formatMs(totalProductiveMs); // alias for productive work string
  const breakStr = formatMs(totalBreakMs);
  const connectedStr = formatMs(connectedMs);
  const activeWorkStr = formatMs(totalActiveWorkMs);

  return {
    elapsedMs: totalElapsedMs,
    totalShiftMs: totalElapsedMs,
    productiveMs: totalProductiveMs,
    activeMs: totalProductiveMs,
    breakMs: totalBreakMs,
    connectedMs,
    utilization: formattedUtilization,
    elapsedStr,
    totalShiftStr: elapsedStr,
    activeStr,
    breakStr,
    connectedStr,
    activeWorkMs: totalActiveWorkMs,
    activeWorkStr,
    totalBreaks: totalBreaksCount,
    productiveStr: activeStr
  };
}

export interface MergedShiftRecord {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  process: string;
  attendanceDate: string; // "YYYY-MM-DD"
  clockInTime: any; // earliest clock-in
  clockOutTime: any; // latest clock-out or null
  status: string; // 'COMPLETED' or 'ACTIVE'
  workLocation?: string;
  workLocationSource?: string;
  officeName?: string;
  publicIP?: string;
  locationCapturedAt?: any;

  // Computed merged metrics:
  productiveMs: number;
  breakMs: number;
  connectedMs: number;
  utilization: number;
  originalShifts: any[];
}

// Helper function to extract raw productive intervals for a single shift
function extractProductiveIntervalsFromShift(s: any, nowMs: number): { start: number; end: number }[] {
  const intervals: { start: number; end: number }[] = [];
  const shiftInMs = parseTimestampMs(s.clockInTime);
  if (!shiftInMs) return intervals;

  const isOngoing = !s.clockOutTime && (s.status === 'ACTIVE' || s.status === 'BREAK' || !s.status);
  const shiftOutMs = isOngoing ? nowMs : (s.clockOutTime ? parseTimestampMs(s.clockOutTime) : shiftInMs);
  if (shiftOutMs <= shiftInMs) return intervals;

  let acts = s.activities;
  if (!acts || !Array.isArray(acts) || acts.length === 0) {
    if (s.status !== 'BREAK') {
      intervals.push({ start: shiftInMs, end: shiftOutMs });
    }
    return intervals;
  }

  const sortedActs = [...acts]
    .map(a => ({ ...a, startMs: parseTimestampMs(a.startTime) }))
    .filter(a => a.startMs > 0 && !isAuditOrDiagnosticEvent(a.action) && a.type !== 'system')
    .sort((a, b) => a.startMs - b.startMs);

  if (sortedActs.length === 0) {
    if (s.status !== 'BREAK') {
      intervals.push({ start: shiftInMs, end: shiftOutMs });
    }
    return intervals;
  }

  for (let i = 0; i < sortedActs.length; i++) {
    const act = sortedActs[i];
    const segStart = Math.max(shiftInMs, act.startMs);
    let segEnd = shiftOutMs;
    if (i < sortedActs.length - 1) {
      segEnd = Math.min(shiftOutMs, sortedActs[i + 1].startMs);
    }

    if (segEnd <= segStart) continue;

    const actName = (act.name || act.currentActivity || act.activityName || '').toLowerCase();
    const isMeetingOrTraining = ['meeting', 'coaching', 'training', 'alignment', '1:1', 'one-on-one', 'upskilling', 'onboarding'].some(k => actName.includes(k));

    let isProductive = false;
    if (act.type === 'productive' || isMeetingOrTraining) {
      isProductive = true;
    } else if (act.type === 'break' || (act.action && act.action.includes('BREAK'))) {
      isProductive = false;
    } else {
      const isBreakName = isBreakActivity(act.name || act.currentActivity || act.activityName || '', act.type);
      isProductive = !isBreakName;
    }

    if (isProductive) {
      intervals.push({ start: segStart, end: segEnd });
    }
  }

  return intervals;
}

export function aggregateShiftsForHistoryAndReports(
  shifts: any[],
  nowMs: number = Date.now()
): MergedShiftRecord[] {
  if (!shifts || !Array.isArray(shifts) || shifts.length === 0) {
    return [];
  }

  const getWorkDate = (clockInTime: any): string => {
    const inMs = parseTimestampMs(clockInTime);
    if (!inMs) return '1970-01-01';
    const d = new Date(inMs);
    // 4-hour offset for overnight shifts (00:00 - 04:00 AM belongs to previous day's shift)
    const logicalDate = new Date(d.getTime() - 4 * 60 * 60 * 1000);
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(logicalDate);
  };

  const getExactDateStr = (clockInTime: any): string => {
    const inMs = parseTimestampMs(clockInTime);
    if (!inMs) return '1970-01-01';
    const d = new Date(inMs);
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(d);
  };

  const groups = new Map<string, any[]>();

  shifts.forEach(s => {
    const uId = s.userId || s.userEmail || 'unknown';
    const wDate = getWorkDate(s.clockInTime);
    const key = `${uId}_${wDate}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(s);
  });

  const results: MergedShiftRecord[] = [];

  groups.forEach((groupShifts, key) => {
    // 1. Sort shifts chronologically by clockInTime
    const sorted = [...groupShifts].sort((a, b) => {
      return parseTimestampMs(a.clockInTime) - parseTimestampMs(b.clockInTime);
    });

    const firstShift = sorted[0];
    const earliestClockInMs = parseTimestampMs(firstShift.clockInTime);

    // 2. Determine LATEST clock-out and check for ongoing session
    let latestClockOutMs = 0;
    let latestClockOutShift: any = null;
    let hasOngoing = false;

    sorted.forEach(s => {
      const isOngoing = !s.clockOutTime && (s.status === 'ACTIVE' || s.status === 'BREAK' || !s.status);
      if (isOngoing) {
        hasOngoing = true;
      } else if (s.clockOutTime) {
        const outMs = parseTimestampMs(s.clockOutTime);
        if (outMs > latestClockOutMs) {
          latestClockOutMs = outMs;
          latestClockOutShift = s;
        }
      }
    });

    const effectiveEndMs = hasOngoing ? nowMs : (latestClockOutMs || earliestClockInMs);

    // 3. Extract & Merge overlapping productive intervals chronologically
    const rawIntervals: { start: number; end: number }[] = [];
    sorted.forEach(s => {
      rawIntervals.push(...extractProductiveIntervalsFromShift(s, nowMs));
    });

    rawIntervals.sort((a, b) => a.start - b.start || a.end - b.end);

    const mergedIntervals: { start: number; end: number }[] = [];
    for (const intv of rawIntervals) {
      if (intv.end <= intv.start) continue;
      if (mergedIntervals.length === 0) {
        mergedIntervals.push({ ...intv });
      } else {
        const last = mergedIntervals[mergedIntervals.length - 1];
        if (intv.start <= last.end) {
          last.end = Math.max(last.end, intv.end);
        } else {
          mergedIntervals.push({ ...intv });
        }
      }
    }

    let uniqueProductiveMs = 0;
    mergedIntervals.forEach(intv => {
      uniqueProductiveMs += (intv.end - intv.start);
    });

    // 4. Calculate total connected duration and non-productive / break time
    const totalConnectedMs = Math.max(0, effectiveEndMs - earliestClockInMs);
    const finalProductiveMs = Math.min(uniqueProductiveMs, totalConnectedMs);
    const totalBreakMs = Math.max(0, totalConnectedMs - finalProductiveMs);

    const totalProductiveMins = finalProductiveMs / 60000;
    const utilization = Math.min(100, Number(((totalProductiveMins / 480) * 100).toFixed(1)));

    const proc = sorted.find(s => Boolean(s.process))?.process || firstShift.process || '';
    const selectedClockOutVal = hasOngoing ? null : (latestClockOutShift ? latestClockOutShift.clockOutTime : (firstShift.clockOutTime || null));

    const merged: MergedShiftRecord = {
      id: `merged_${firstShift.id || key}`,
      userId: firstShift.userId,
      userName: firstShift.userName || 'N/A',
      userEmail: firstShift.userEmail || 'N/A',
      process: proc,
      attendanceDate: getExactDateStr(firstShift.clockInTime),
      clockInTime: firstShift.clockInTime,
      clockOutTime: selectedClockOutVal,
      status: hasOngoing ? 'ACTIVE' : 'COMPLETED',
      workLocation: firstShift.workLocation,
      workLocationSource: firstShift.workLocationSource,
      officeName: firstShift.officeName,
      publicIP: firstShift.publicIP,
      locationCapturedAt: firstShift.locationCapturedAt,
      productiveMs: finalProductiveMs,
      breakMs: totalBreakMs,
      connectedMs: totalConnectedMs,
      utilization,
      originalShifts: sorted
    };

    results.push(merged);
  });

  return results.sort((a, b) => parseTimestampMs(b.clockInTime) - parseTimestampMs(a.clockInTime));
}

