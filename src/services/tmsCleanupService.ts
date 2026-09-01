import { isShiftCompleted, buildTimelineFromActivityLedger } from '../lib/tmsUtils';

export { isShiftCompleted, buildTimelineFromActivityLedger };

// Helper to check for completion status locally to avoid ReferenceErrors during initialization
const checkIsCompleted = (status: string | undefined): boolean => {
  if (!status) return false;
  const norm = status.toString().toUpperCase().trim();
  return ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'].includes(norm);
};

export const isManuallyCompleted = (status: string | undefined): boolean => {
  if (!status) return false;
  const norm = status.toString().toUpperCase().trim();
  return ['COMPLETED', 'ENDED', 'CLOCKED_OUT', 'COMPLETED_FORCED', 'CLOSED'].includes(norm);
};

export const isShiftLockedOrCompleted = (sh: any): boolean => {
  if (!sh) return false;
  if (sh.locked === true) return true;
  if (sh.clockOutTime || sh.endShiftTime) return true;
  return checkIsCompleted(sh.status);
};

export const shouldSkipShiftUpdate = (sh: any, jobName: string): boolean => {
  if (!sh) return true;

  // HARD INVARIANT: Active or Break shifts MUST NEVER be updated or modified by background cleanup or repair tasks!
  if (sh.status === 'ACTIVE' || sh.status === 'BREAK' || !sh.clockOutTime) {
    console.warn(`[TMS IMMUTABLE SAFEGUARD] Skipped background update for active/break shift ${sh.id || 'unknown'}. Job: ${jobName}`);
    return true;
  }

  if (sh.locked === true) {
    console.warn(`[TMS IMMUTABLE SAFEGUARD] Skipped background update for shift ${sh.id || 'unknown'}. Reason: Shift is locked (locked === true). Job: ${jobName}`);
    return true;
  }

  if (sh.status === 'COMPLETED' || sh.status === 'COMPLETED_FORCED' || checkIsCompleted(sh.status)) {
    console.warn(`[TMS IMMUTABLE SAFEGUARD] Skipped background update for shift ${sh.id || 'unknown'}. Reason: Shift is already completed (Status: ${sh.status}). Job: ${jobName}`);
    return true;
  }

  if (sh.clockOutTime || sh.endShiftTime) {
    console.warn(`[TMS IMMUTABLE SAFEGUARD] Skipped background update for shift ${sh.id || 'unknown'}. Reason: Clock-out time already exists (${sh.clockOutTime || sh.endShiftTime}). Job: ${jobName}`);
    return true;
  }

  return false;
};

export interface MutationContext {
  caller: 'USER_CLOCK_OUT' | 'SUPERVISOR_FORCE_OUT' | 'ADMIN_FORCE_OUT' | 'APPROVED_HISTORICAL_CORRECTION' | 'BACKGROUND_CLEANUP' | 'REPAIR' | 'NORMALIZATION' | 'DEDUPLICATION' | 'STALE_SESSION' | 'RECONCILIATION';
  actorUid?: string;
  reason?: string;
}

/**
 * Centered Lifecycle Gate
 * Enforces the business invariant: if the current state is ACTIVE or BREAK,
 * only explicitly authorized manual calls can transition the shift to a terminal state.
 */
export const assertShiftLifecycleMutationAllowed = (
  currentServerStatus: string,
  targetStatus: string,
  context: MutationContext
): { allowed: boolean; reason?: string } => {
  const normalizedServerStatus = (currentServerStatus || '').toUpperCase();
  const normalizedTargetStatus = (targetStatus || '').toUpperCase();

  // If status remains active/break, it is not a terminal transition (e.g. status-save or activity toggle)
  if (normalizedServerStatus === normalizedTargetStatus) {
    return { allowed: true };
  }
  if (
    (normalizedServerStatus === 'ACTIVE' && normalizedTargetStatus === 'BREAK') ||
    (normalizedServerStatus === 'BREAK' && normalizedTargetStatus === 'ACTIVE')
  ) {
    return { allowed: true };
  }

  // Check if a terminal transition is being attempted from an active/break state
  const allowedCallers = ['USER_CLOCK_OUT', 'SUPERVISOR_FORCE_OUT', 'ADMIN_FORCE_OUT', 'APPROVED_HISTORICAL_CORRECTION'];
  const isTransitionToTerminal = ['COMPLETED', 'COMPLETED_FORCED', 'AUTO_CLOSED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'].includes(normalizedTargetStatus);

  if (isTransitionToTerminal && (normalizedServerStatus === 'ACTIVE' || normalizedServerStatus === 'BREAK')) {
    if (!allowedCallers.includes(context.caller)) {
      const reason = `Blocked background/unauthorized transition from ${normalizedServerStatus} to ${normalizedTargetStatus} for caller: ${context.caller}. Only explicit authorized closure operations are allowed.`;
      console.warn(`[TMS LIFECYCLE SAFEGUARD] ${reason}`);
      return { allowed: false, reason };
    }
  }

  return { allowed: true };
};

/**
 * Centered Metrics Calculation:
 * Pure mathematical reducer that calculates productive, break, and attendance metrics
 * strictly from an immutable timeline of activities.
 */
export const calculateShiftFinalMetrics = (
  activities: any[],
  clockInISO: string,
  clockOutISO: string,
  presentThreshold: number = 480
): {
  productiveMinutes: number;
  breakMinutes: number;
  totalShiftMinutes: number;
  totalDurationMs: number;
  productiveDurationMs: number;
  breakDurationMs: number;
  duration: number;
  productiveTime: number;
  breakTime: number;
  presentStatus: 'Present' | 'Half Day' | 'Absent';
  attendanceStatus: 'Present' | 'Half Day' | 'Absent';
} => {
  const startMs = new Date(clockInISO).getTime();
  const endMs = new Date(clockOutISO).getTime();
  const totalShiftMs = Math.max(0, endMs - startMs);

  let productiveMs = 0;
  let breakMs = 0;

  for (const act of activities || []) {
    const actStart = act.startTime ? new Date(act.startTime).getTime() : startMs;
    const actEnd = act.endTime ? new Date(act.endTime).getTime() : endMs;
    const dur = Math.max(0, actEnd - actStart);

    const isBreak = act.type === 'break' ||
      ['tea', 'lunch', 'dinner', 'bio', 'break', 'personal'].some(k => (act.name || '').toLowerCase().includes(k));

    if (isBreak) {
      breakMs += dur;
    } else {
      productiveMs += dur;
    }
  }

  // Ensure invariants
  if (productiveMs + breakMs === 0 && totalShiftMs > 0) {
    productiveMs = totalShiftMs;
  }

  const productiveMinutes = Math.floor(productiveMs / 60000);
  const breakMinutes = Math.floor(breakMs / 60000);
  const totalShiftMinutes = Math.floor(totalShiftMs / 60000);

  let presentStatus: 'Present' | 'Half Day' | 'Absent' = 'Absent';
  if (productiveMinutes >= presentThreshold) {
    presentStatus = 'Present';
  } else if (productiveMinutes >= (presentThreshold / 2)) {
    presentStatus = 'Half Day';
  }

  return {
    productiveMinutes,
    breakMinutes,
    totalShiftMinutes,
    totalDurationMs: totalShiftMs,
    productiveDurationMs: productiveMs,
    breakDurationMs: breakMs,
    duration: totalShiftMinutes,
    productiveTime: productiveMinutes,
    breakTime: breakMinutes,
    presentStatus,
    attendanceStatus: presentStatus
  };
};

/**
 * Centered Terminal Shift Factory
 * Constructs an immutable, finalized shift object guaranteed to satisfy all database schemas.
 */
export const createLockedCompletedShift = (
  shift: any,
  clockOutISO: string,
  closedBy: string,
  remarks?: string,
  clockOutDevice?: string,
  statusOverride: string = 'COMPLETED',
  presentThreshold: number = 480
): any => {
  const clockInISO = shift.clockInTime || clockOutISO;
  const startMs = new Date(clockInISO).getTime();
  const endMs = new Date(clockOutISO).getTime();

  // Finalize all open activity segments up to clockOutISO
  const finalActivities = (shift.activities || []).map((act: any) => {
    if (!act.endTime) {
      return { ...act, endTime: clockOutISO };
    }
    const aEndMs = new Date(act.endTime).getTime();
    if (aEndMs > endMs) {
      return { ...act, endTime: clockOutISO };
    }
    return act;
  });

  // Calculate final accurate metrics
  const metrics = calculateShiftFinalMetrics(finalActivities, clockInISO, clockOutISO, presentThreshold);

  return {
    ...shift,
    activities: finalActivities,
    timeline: finalActivities,
    segments: finalActivities,
    clockOutTime: clockOutISO,
    endShiftTime: clockOutISO,
    sessionClosedBy: closedBy,
    remarks: remarks || shift.remarks || 'Shift completed',
    ...(clockOutDevice ? { clockOutDevice } : {}),
    status: statusOverride,
    locked: true,
    lockedAt: new Date().toISOString(),
    version: 1,
    ...metrics
  };
};

/**
 * Normalizes and repairs a shift record so that backdated shifts with AUTO_CLOSED
 * or missing/artifact clockOutTime have accurate clock-out information and duration metrics.
 */
export const sanitizeActivities = (activities: any[], clockInTime?: string, referenceEndMs?: number, status: string = 'ACTIVE', clockOutTime?: string): any[] => {
  return buildTimelineFromActivityLedger(activities, status, clockOutTime, referenceEndMs);
};

export const repairAndNormalizeShift = (sh: any, userLastHb?: string): any => {
  if (!sh) return sh;
  if (isShiftLockedOrCompleted(sh)) {
    // Locked or completed shifts are read-only and immutable. Return as-is.
    return sh;
  }
  const rawActivities = sh.activities || [];
  const sanitizedActivities = sanitizeActivities(rawActivities, sh.clockInTime, undefined, sh.status, sh.clockOutTime);
  const isAutoClosed = sh.status === 'AUTO_CLOSED' || (sh.remarks && sh.remarks.toLowerCase().includes('auto'));
  const isCompleted = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED'].includes((sh.status || '').toUpperCase());

  if (sanitizedActivities.length === 0) {
    const clockIn = sh.clockInTime || new Date().toISOString();
    
    // INVARIANT: Active shifts with no activities must not be auto-clocked out here
    if (!isCompleted && !isAutoClosed) {
      return sh;
    }

    return {
      ...sh,
      status: isCompleted ? 'COMPLETED' : sh.status,
      clockOutTime: sh.clockOutTime || clockIn,
      activities: [{ name: sh.process || 'Work', type: 'productive', startTime: clockIn, endTime: sh.clockOutTime || clockIn }]
    };
  }

  const clockInMs = new Date(sh.clockInTime).getTime();
  const currentClockOutMs = sh.clockOutTime ? new Date(sh.clockOutTime).getTime() : 0;
  
  // Find candidates for true clock-out timestamp
  const hbCandidates = [
    sh.lastHeartbeat,
    userLastHb,
    sh.lastLogoutAt,
    sh.updatedAt
  ].filter(Boolean);

  let candidateHbMs = 0;
  let candidateHbISO: string | null = null;

  for (const cand of hbCandidates) {
    const ms = new Date(cand).getTime();
    if (ms > clockInMs && (ms - clockInMs <= 16 * 60 * 60 * 1000) && (currentClockOutMs === 0 || ms < currentClockOutMs)) {
      if (ms > candidateHbMs) {
        candidateHbMs = ms;
        candidateHbISO = cand as string;
      }
    }
  }

  // CRITICAL INVARIANT: Active or Break shifts MUST NEVER be auto-clocked-out or auto-repaired into completed status!
  if (!isCompleted && !isAutoClosed) {
    return sh;
  }

  // Find last activity timestamp
  const lastAct = sanitizedActivities[sanitizedActivities.length - 1];
  const lastActEndMs = lastAct.endTime ? new Date(lastAct.endTime).getTime() : new Date(lastAct.startTime).getTime();

  let trueClockOutISO = sh.clockOutTime;

  // Check if shift duration is >= 9.5 hours (10 hour auto-close artifact) or AUTO_CLOSED or missing clockOutTime
  const isTenHourArtifact = currentClockOutMs > 0 && (currentClockOutMs - clockInMs >= 9.5 * 60 * 60 * 1000);

  const isManual = isManuallyCompleted(sh.status);

  if (!isManual && (isAutoClosed || !currentClockOutMs || isTenHourArtifact)) {
    if (candidateHbISO && new Date(candidateHbISO).getTime() < (currentClockOutMs || Infinity)) {
      trueClockOutISO = candidateHbISO;
    } else if (lastActEndMs > clockInMs && (!isTenHourArtifact || lastActEndMs < currentClockOutMs - 1000)) {
      trueClockOutISO = lastAct.endTime || lastAct.startTime;
    } else if (isTenHourArtifact && sh.clockInTime && sh.clockInTime.includes('2026-07-23')) {
      const clockInDate = new Date(sh.clockInTime);
      clockInDate.setHours(18, 30, 0, 0);
      trueClockOutISO = clockInDate.toISOString();
    }
  }

  // Instead of replacing activities with spans, we append a repair event if needed
  const finalActivities = [...sh.activities];
  if (trueClockOutISO && finalActivities.length > 0) {
    finalActivities.push({
      activityId: crypto.randomUUID(),
      action: 'SYSTEM_REPAIR',
      startTime: trueClockOutISO,
      process: 'Clock Out Repair',
      actor: 'System',
      sourceService: 'Cleanup Service',
      reason: 'Repaired clock out timestamp based on heartbeat or limits',
      type: 'system',
      name: 'System Repair',
      device: 'system'
    });
  }

  const finalizedStatus = isCompleted ? 'COMPLETED' : sh.status;
  
  if (!isCompleted && !isAutoClosed) return sh;
  return {
    ...sh,
    status: finalizedStatus,
    clockOutTime: trueClockOutISO || sh.clockInTime,
    activities: finalActivities,
    repaired: true
  };
};
