import { isAuditOrDiagnosticEvent } from './tmsUtils';

export type ActivityAction = 'CLOCK_IN' | 'BREAK_START' | 'BREAK_END' | 'PROCESS_SWITCH' | 'PRODUCTIVE_START' | 'CLOCK_OUT' | 'FORCE_LOGOUT' | 'AUTO_CLOSE' | 'SESSION_RECOVERY' | 'MANUAL_CORRECTION' | 'SYSTEM_REPAIR';

export function createLedgerActivity(
  action: ActivityAction,
  startTime: string,
  process: string,
  actor: string,
  sourceService: string,
  reason?: string,
  device?: string,
  previousValue?: string,
  newValue?: string
) {
  return {
    activityId: crypto.randomUUID(),
    action,
    startTime,
    process,
    actor,
    sourceService,
    reason,
    previousValue,
    newValue,
    // Legacy support fields for UI rendering compatibility
    type: isAuditOrDiagnosticEvent(action)
      ? 'system'
      : ((action === 'BREAK_START' || action.includes('BREAK')) && action !== 'BREAK_END' ? 'break' : 'productive'),
    name: process,
    device: device || 'desktop',
    // Deliberately no endTime for an immutable append-only point-in-time event
  };
}
