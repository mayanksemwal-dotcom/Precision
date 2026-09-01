import { buildTimelineFromActivityLedger, isAuditOrDiagnosticEvent } from './tmsUtils';
import { calculateShiftMetrics as calcShiftMetricsEngine, calculateAttendanceDate as calcAttDateEngine } from './tmsCalculationEngine';

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
  
  // Match only explicit standalone break names / phrases, never substring in processes like 'Biotechnology' or 'Breakfast Logistics'
  const explicitBreakPhrases = [
    'lunch', 'lunch break', 'tea', 'tea break', 'bio', 'bio break', 'bathroom', 'restroom',
    'break', 'coffee', 'coffee break', 'meal', 'meal break', 'snack', 'snack break',
    'recess', 'refreshment', 'short break', 'official break', 'unpaid break', 'paid break'
  ];
  return explicitBreakPhrases.includes(nameLower);
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
  const res = calcShiftMetricsEngine(s, nowMs);
  return { productiveMs: res.productiveMs, breakMs: res.breakMs };
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
  const res = calcShiftMetricsEngine(s, nowMs);
  return res.activeWorkMs;
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
    const res = calcShiftMetricsEngine(s, nowMs);

    totalElapsedMs += res.elapsedMs;
    totalProductiveMs += res.productiveMs;
    totalBreakMs += res.breakMs;
    totalBreaksCount += res.totalBreaks;
    totalActiveWorkMs += res.activeWorkMs;
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

  // Total Connected
  const connectedMs = totalProductiveMs + totalBreakMs;

  // Utilization
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
export function aggregateShiftsForHistoryAndReports(
  shifts: any[],
  nowMs: number = Date.now()
): MergedShiftRecord[] {
  if (!shifts || !Array.isArray(shifts) || shifts.length === 0) {
    return [];
  }

  const getWorkDate = (clockInTime: any): string => {
    return calcAttDateEngine(clockInTime);
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
    const sorted = [...groupShifts].sort((a, b) => {
      return parseTimestampMs(a.clockInTime) - parseTimestampMs(b.clockInTime);
    });

    const firstShift = sorted[0];
    let hasOngoing = false;
    let latestClockOutShift: any = null;
    let latestClockOutMs = 0;

    let totalProductiveMs = 0;
    let totalBreakMs = 0;

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

      const metrics = calcShiftMetricsEngine(s, nowMs);
      totalProductiveMs += metrics.productiveMs;
      totalBreakMs += metrics.breakMs;
    });

    const totalConnectedMs = totalProductiveMs + totalBreakMs;
    const totalProductiveMins = totalProductiveMs / 60000;
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
      productiveMs: totalProductiveMs,
      breakMs: totalBreakMs,
      connectedMs: totalConnectedMs,
      utilization,
      originalShifts: sorted
    };

    results.push(merged);
  });

  return results.sort((a, b) => parseTimestampMs(b.clockInTime) - parseTimestampMs(a.clockInTime));
}

