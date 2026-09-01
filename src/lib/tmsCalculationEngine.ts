import { parseTimestampMs as parseTs, isBreakActivity, formatMs } from './ledgerCalculations';
import { isAuditOrDiagnosticEvent } from './tmsUtils';

export const parseTimestampMs = parseTs;

export interface TMSActivity {
  id?: string;
  name?: string;
  currentActivity?: string;
  activityName?: string;
  process?: string;
  action?: string;
  type?: 'productive' | 'break' | 'system' | string;
  startTime: string | number | any;
  endTime?: string | number | any;
  durationMs?: number;
  reason?: string;
  remarks?: string;
  isLive?: boolean;
}

export interface CalculatedShiftMetrics {
  elapsedMs: number;
  productiveMs: number;
  breakMs: number;
  connectedMs: number;
  activeWorkMs: number;
  utilization: number; // 0 to 100
  totalBreaks: number;
  elapsedStr: string;
  productiveStr: string;
  breakStr: string;
  connectedStr: string;
  activeWorkStr: string;
  currentStatus: 'ACTIVE' | 'BREAK' | 'COMPLETED' | 'OFFLINE';
  currentProcess: string;
  currentBreak?: string;
  processDurations: Record<string, number>; // process name -> duration ms
  breakDurations: Record<string, number>; // break name -> duration ms
}

/**
 * Pure, 100% read-only adapter that ensures legacy shift records have safe fallback structures.
 * NEVER mutates the input object.
 */
export function normalizeLegacyShift(rawShift: any): any {
  if (!rawShift) return null;
  const activities = Array.isArray(rawShift.activities) ? rawShift.activities : [];
  
  const rawClockIn = rawShift.clockInTime ||
    rawShift.statusStartTime ||
    rawShift.currentActivityStartTime ||
    rawShift.startTime ||
    (activities.length > 0 ? (activities[0].startTime || activities[0].start_time || activities[0].timestamp || activities[0].created_at) : undefined);

  // Fallback default activity if activities array is empty but clockInTime/startTime exists
  let safeActivities = activities;
  if (safeActivities.length === 0 && rawClockIn) {
    const isBreak = (rawShift.status || '').toUpperCase().trim() === 'BREAK';
    safeActivities = [{
      startTime: rawClockIn,
      type: isBreak ? 'break' : 'productive',
      name: isBreak ? (rawShift.breakType || 'Break') : (rawShift.process || 'Work'),
      action: isBreak ? 'BREAK_START' : 'CLOCK_IN'
    }];
  }

  const normStatus = (rawShift.status || '').toString().toUpperCase().trim();
  const isCompleted = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'].includes(normStatus);

  return {
    ...rawShift,
    id: rawShift.id || 'unknown_shift',
    userId: rawShift.userId || rawShift.uid || '',
    userName: rawShift.userName || rawShift.employeeName || 'Unknown Agent',
    userEmail: rawShift.userEmail || rawShift.email || '',
    clockInTime: rawClockIn || null,
    clockOutTime: rawShift.clockOutTime || null,
    status: isCompleted ? 'COMPLETED' : (normStatus === 'BREAK' ? 'BREAK' : 'ACTIVE'),
    process: rawShift.process || rawShift.currentProcess || 'General',
    activities: safeActivities,
  };
}

/**
 * Returns attendance date string "YYYY-MM-DD" in IST (Asia/Kolkata) timezone.
 * Uses a 4-hour logical offset for overnight shifts ending early morning (00:00 - 04:00 AM).
 */
export function calculateAttendanceDate(clockInTime: any): string {
  const inMs = parseTimestampMs(clockInTime);
  if (!inMs) return '1970-01-01';
  const d = new Date(inMs);
  // 4-hour offset for overnight shifts (e.g. 01:00 AM belongs to previous day's shift)
  const logicalDate = new Date(d.getTime() - 4 * 60 * 60 * 1000);
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(logicalDate);
  } catch {
    return logicalDate.toISOString().slice(0, 10);
  }
}

/**
 * Calculates accurate shift metrics from raw shift object and activities timeline.
 * 100% read-only, non-mutating, idempotent.
 */
export function calculateShiftMetrics(
  rawShiftInput: any,
  evaluationTimeMs: number = Date.now()
): CalculatedShiftMetrics {
  const shift = normalizeLegacyShift(rawShiftInput);

  if (!shift || !shift.clockInTime) {
    return {
      elapsedMs: 0,
      productiveMs: 0,
      breakMs: 0,
      connectedMs: 0,
      activeWorkMs: 0,
      utilization: 0,
      totalBreaks: 0,
      elapsedStr: '00:00:00',
      productiveStr: '00:00:00',
      breakStr: '00:00:00',
      connectedStr: '00:00:00',
      activeWorkStr: '00:00:00',
      currentStatus: 'OFFLINE',
      currentProcess: 'General',
      processDurations: {},
      breakDurations: {},
    };
  }

  const clockInMs = parseTimestampMs(shift.clockInTime);
  const isCompleted = shift.status === 'COMPLETED';
  const clockOutMs = isCompleted && shift.clockOutTime ? parseTimestampMs(shift.clockOutTime) : 0;

  // Shift end boundary for calculations
  const effectiveEndMs = clockOutMs > 0 ? clockOutMs : Math.max(clockInMs, evaluationTimeMs);
  const elapsedMs = Math.max(0, effectiveEndMs - clockInMs);

  const rawActs = shift.activities || [];
  // Sort activities chronologically by startTime
  const sortedActs = [...rawActs]
    .map(a => ({ ...a, startMs: parseTimestampMs(a.startTime), endMs: a.endTime ? parseTimestampMs(a.endTime) : undefined }))
    .filter(a => a.startMs > 0 && !isAuditOrDiagnosticEvent(a.action) && a.type !== 'system')
    .sort((a, b) => a.startMs - b.startMs);

  let productiveMs = 0;
  let breakMs = 0;
  let totalBreaksCount = 0;

  const processDurations: Record<string, number> = {};
  const breakDurations: Record<string, number> = {};

  let currentProcess = shift.process || 'General';
  let currentBreak: string | undefined = undefined;
  let currentStatus: 'ACTIVE' | 'BREAK' | 'COMPLETED' | 'OFFLINE' = isCompleted ? 'COMPLETED' : 'ACTIVE';

  if (sortedActs.length === 0) {
    // Fallback if no valid activities
    if (shift.status === 'BREAK') {
      breakMs = elapsedMs;
      currentStatus = 'BREAK';
      currentBreak = 'Break';
      breakDurations['Break'] = elapsedMs;
    } else {
      productiveMs = elapsedMs;
      currentStatus = isCompleted ? 'COMPLETED' : 'ACTIVE';
      processDurations[currentProcess] = elapsedMs;
    }
  } else {
    // Count BREAK_START activities or explicit breaks
    let wasBreak = false;
    for (const act of sortedActs) {
      const actName = (act.name || act.currentActivity || act.activityName || act.process || '').trim();
      const isMeetingOrTraining = ['meeting', 'coaching', 'training', 'alignment', '1:1', 'one-on-one', 'upskilling', 'onboarding'].some(k => actName.toLowerCase().includes(k));
      const isBreak = act.type === 'break' ||
        (act.action && act.action.toUpperCase().trim() === 'BREAK_START') ||
        (!isMeetingOrTraining && act.type !== 'productive' && isBreakActivity(actName, act.type));
      if (isBreak && !wasBreak) {
        totalBreaksCount++;
      }
      wasBreak = isBreak;
    }

    let lastProcessedMs = clockInMs;

    for (let i = 0; i < sortedActs.length; i++) {
      const act = sortedActs[i];
      const actStart = Math.max(clockInMs, Math.min(effectiveEndMs, act.startMs));

      // 1. If there is an unallocated gap before this activity (e.g. between clockIn and first act, or gap after previous act)
      if (actStart > lastProcessedMs) {
        const gapDuration = actStart - lastProcessedMs;
        const procName = currentProcess || 'Work';
        productiveMs += gapDuration;
        processDurations[procName] = (processDurations[procName] || 0) + gapDuration;
        lastProcessedMs = actStart;
      }

      // 2. Next activity start or effectiveEndMs as the upper bound
      let nextBoundaryMs = effectiveEndMs;
      if (i < sortedActs.length - 1) {
        const nextStart = Math.max(clockInMs, Math.min(effectiveEndMs, sortedActs[i + 1].startMs));
        nextBoundaryMs = Math.min(effectiveEndMs, nextStart);
      }

      // 3. Determine segment end for this activity:
      // If act.endMs is provided and > actStart, clamp to nextBoundaryMs. Otherwise use nextBoundaryMs.
      let actEnd = nextBoundaryMs;
      if (act.endMs && act.endMs > actStart) {
        actEnd = Math.min(act.endMs, nextBoundaryMs);
      }

      let durationMs = Math.max(0, actEnd - actStart);
      const actName = (act.name || act.currentActivity || act.activityName || act.process || '').trim();
      const isMeetingOrTraining = ['meeting', 'coaching', 'training', 'alignment', '1:1', 'one-on-one', 'upskilling', 'onboarding'].some(k => actName.toLowerCase().includes(k));

      const isBreak = act.type === 'break' ||
        (act.action && act.action.toUpperCase().trim() === 'BREAK_START') ||
        (!isMeetingOrTraining && act.type !== 'productive' && isBreakActivity(actName, act.type));

      if (isBreak && i === sortedActs.length - 1 && !isCompleted && actEnd >= effectiveEndMs) {
        let bStartMs = shift.breakStartTime ? parseTimestampMs(shift.breakStartTime) : 0;
        if (bStartMs <= 0 && actStart > 0) {
          bStartMs = actStart;
        }
        if (bStartMs > 0) {
          durationMs = Math.max(0, effectiveEndMs - bStartMs);
        }
      }

      if (isBreak) {
        breakMs += durationMs;
        const breakName = actName || 'Break';
        breakDurations[breakName] = (breakDurations[breakName] || 0) + durationMs;

        if (i === sortedActs.length - 1 && !isCompleted && actEnd >= effectiveEndMs) {
          currentStatus = 'BREAK';
          currentBreak = breakName;
        }
      } else {
        productiveMs += durationMs;
        const procName = actName || currentProcess || 'Work';
        processDurations[procName] = (processDurations[procName] || 0) + durationMs;
        currentProcess = procName;

        if (i === sortedActs.length - 1 && !isCompleted && actEnd >= effectiveEndMs) {
          currentStatus = 'ACTIVE';
        }
      }

      lastProcessedMs = Math.max(lastProcessedMs, actEnd);
    }

    // 4. If there is remaining time after the last activity up to effectiveEndMs:
    if (effectiveEndMs > lastProcessedMs) {
      const remainingGap = effectiveEndMs - lastProcessedMs;
      const procName = currentProcess || 'Work';
      productiveMs += remainingGap;
      processDurations[procName] = (processDurations[procName] || 0) + remainingGap;
      if (!isCompleted) {
        currentStatus = 'ACTIVE';
      }
    }
  }

  const activeWorkMs = productiveMs;
  const connectedMs = productiveMs + breakMs;
  const productiveMins = productiveMs / 60000;
  const utilization = Math.min(100, Math.round(((productiveMins / 480) * 100) * 10) / 10);

  return {
    elapsedMs,
    productiveMs,
    breakMs,
    connectedMs,
    activeWorkMs,
    utilization,
    totalBreaks: totalBreaksCount,
    elapsedStr: formatMs(elapsedMs),
    productiveStr: formatMs(productiveMs),
    breakStr: formatMs(breakMs),
    connectedStr: formatMs(connectedMs),
    activeWorkStr: formatMs(activeWorkMs),
    currentStatus,
    currentProcess,
    currentBreak,
    processDurations,
    breakDurations,
  };
}

/**
 * Daily aggregation for multi-session UT reporting on the same attendance date.
 * Groups multiple shift sessions without adding false connected time for gaps between logins.
 */
export function calculateDailyMetrics(
  shifts: any[],
  evaluationTimeMs: number = Date.now()
) {
  if (!shifts || !Array.isArray(shifts) || shifts.length === 0) {
    return {
      totalProductiveMs: 0,
      totalBreakMs: 0,
      totalConnectedMs: 0,
      dailyUtilization: 0,
      firstClockIn: null,
      lastClockOut: null,
      shiftsCount: 0,
      processDurations: {} as Record<string, number>,
      breakDurations: {} as Record<string, number>,
    };
  }

  const validShifts = shifts.map(s => normalizeLegacyShift(s)).filter(Boolean);
  
  let totalProductiveMs = 0;
  let totalBreakMs = 0;
  let earliestInMs = Infinity;
  let latestOutMs = 0;
  let hasActiveShift = false;

  const combinedProcessDurations: Record<string, number> = {};
  const combinedBreakDurations: Record<string, number> = {};

  validShifts.forEach(s => {
    const inMs = parseTimestampMs(s.clockInTime);
    if (inMs > 0 && inMs < earliestInMs) earliestInMs = inMs;

    const metrics = calculateShiftMetrics(s, evaluationTimeMs);
    totalProductiveMs += metrics.productiveMs;
    totalBreakMs += metrics.breakMs;

    if (s.status === 'ACTIVE' || s.status === 'BREAK') {
      hasActiveShift = true;
    } else if (s.clockOutTime) {
      const outMs = parseTimestampMs(s.clockOutTime);
      if (outMs > latestOutMs) latestOutMs = outMs;
    }

    Object.entries(metrics.processDurations).forEach(([proc, dur]) => {
      combinedProcessDurations[proc] = (combinedProcessDurations[proc] || 0) + dur;
    });

    Object.entries(metrics.breakDurations).forEach(([brk, dur]) => {
      combinedBreakDurations[brk] = (combinedBreakDurations[brk] || 0) + dur;
    });
  });

  const totalConnectedMs = totalProductiveMs + totalBreakMs;
  const totalProdMins = totalProductiveMs / 60000;
  const dailyUtilization = Math.min(100, Math.round(((totalProdMins / 480) * 100) * 10) / 10);

  return {
    totalProductiveMs,
    totalBreakMs,
    totalConnectedMs,
    dailyUtilization,
    firstClockIn: earliestInMs < Infinity ? new Date(earliestInMs).toISOString() : null,
    lastClockOut: hasActiveShift ? null : (latestOutMs > 0 ? new Date(latestOutMs).toISOString() : null),
    shiftsCount: validShifts.length,
    processDurations: combinedProcessDurations,
    breakDurations: combinedBreakDurations,
  };
}
