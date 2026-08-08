
export const CORE_USER_ACTIONS = ['CLOCK_IN', 'PROCESS_SWITCH', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'];

export const AUDIT_DIAGNOSTIC_EVENTS = [
  'SYSTEM_REPAIR',
  'AUTO_CLOSE',
  'AUTO_EXPIRE',
  'RECOVERY',
  'MIGRATION',
  'NORMALIZATION',
  'DATA_FIX',
  'IMPORT',
  'SYNC',
  'FORCE_LOGOUT',
  'SUPERVISOR_FORCE_LOGOUT'
];

export const isCoreUserAction = (action?: string): boolean => {
  if (!action) return false;
  return CORE_USER_ACTIONS.includes(action.toUpperCase().trim());
};

export const isAuditOrDiagnosticEvent = (action?: string): boolean => {
  if (!action) return false;
  const norm = action.toUpperCase().trim();
  return AUDIT_DIAGNOSTIC_EVENTS.includes(norm) || norm.includes('REPAIR') || norm.includes('SYNC') || norm.includes('MIGRAT');
};

/**
 * Walks backwards from the end of the activity array to find the latest explicit user event.
 * Ignores SYSTEM_REPAIR, AUTO_CLOSE, RECOVERY, MIGRATION, and all other diagnostic/audit events.
 */
export const getLatestUserActivity = (activities: any[]): any | null => {
  if (!activities || !Array.isArray(activities) || activities.length === 0) return null;
  // 1. First pass: look for explicit core user action (CLOCK_IN, PROCESS_SWITCH, BREAK_START, BREAK_END, CLOCK_OUT)
  for (let i = activities.length - 1; i >= 0; i--) {
    const act = activities[i];
    if (act && act.action && isCoreUserAction(act.action)) {
      return act;
    }
  }
  // 2. Second pass: fallback for legacy items without action field: filter out diagnostic events
  for (let i = activities.length - 1; i >= 0; i--) {
    const act = activities[i];
    if (act && !isAuditOrDiagnosticEvent(act.action) && act.type !== 'system') {
      return act;
    }
  }
  return activities[activities.length - 1] || null;
};

export const isShiftCompleted = (status: string | undefined): boolean => {
  if (!status) return false;
  const norm = status.toString().toUpperCase().trim();
  return ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'].includes(norm);
};

export const buildTimelineFromActivityLedger = (
  activities: any[],
  status: string,
  clockOutTime?: string,
  referenceEndMs?: number
): any[] => {
  if (!activities || !Array.isArray(activities) || activities.length === 0) return [];

  const nowMs = referenceEndMs || Date.now();
  const isCompleted = isShiftCompleted(status);
  const endThresholdMs = (isCompleted && clockOutTime) ? new Date(clockOutTime).getTime() : nowMs;

  // Sort by startTime. For identical timestamps, keep insertion order if possible or stable sort.
  const sorted = [...activities].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  
  // Exclude activities where isAuditOrDiagnosticEvent(act.action) is true.
  // Exclude activities where act.type === 'system'.
  const filtered = sorted.filter(act => !isAuditOrDiagnosticEvent(act.action) && act.type !== 'system');

  const segments: any[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const act = filtered[i];
    const startMs = new Date(act.startTime).getTime();
    
    let endMs = endThresholdMs;
    
    // A segment lasts until the next valid segment-defining event
    for (let j = i + 1; j < filtered.length; j++) {
      endMs = new Date(filtered[j].startTime).getTime();
      break;
    }
    
    // If this is the last state-defining segment and the shift is completed, it should end at clockOutTime
    if (i === filtered.length - 1 && isCompleted && clockOutTime) {
      endMs = new Date(clockOutTime).getTime();
    }
    
    // Protection against negative duration due to clock drift or manual edits
    const effectiveEndMs = Math.max(startMs, endMs);
    
    // Is this segment currently active?
    // It is active if the shift is NOT completed AND this is the last state-defining segment
    let isLive = false;
    if (!isCompleted && i === filtered.length - 1) {
      isLive = true;
    }

    segments.push({
      ...act,
      startTime: act.startTime,
      endTime: new Date(effectiveEndMs).toISOString(),
      durationMs: effectiveEndMs - startMs,
      isLive
    });
  }

  return segments;
};
