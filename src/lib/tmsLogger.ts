import { getLiveTimeISO } from './timeSync';

export type TmsEventType = 
  | 'CLOCK_IN' 
  | 'ACTIVITY_CHANGE' 
  | 'HEARTBEAT' 
  | 'BREAK_START' 
  | 'BREAK_END' 
  | 'CLOCK_OUT' 
  | 'AUTO_CLOSE' 
  | 'SESSION_RESTORE';

export interface TmsLogParams {
  userId: string;
  shiftId: string;
  timestamp?: string;
  reason?: string;
  sourceFunction: string;
  details?: Record<string, any>;
}

/**
 * Structured debug logging for Time Management System (TMS) lifecycle events.
 */
export function logTmsEvent(event: TmsEventType, params: TmsLogParams) {
  const timestamp = params.timestamp || getLiveTimeISO();
  const logEntry = {
    tag: '[TMS_DEBUG_LOG]',
    event,
    userUid: params.userId || 'UNKNOWN',
    shiftId: params.shiftId || 'N/A',
    timestamp,
    reason: params.reason || 'N/A',
    sourceFunction: params.sourceFunction,
    ...(params.details ? { details: params.details } : {})
  };

  console.log(
    `[TMS_DEBUG_LOG] [${event}] User: ${logEntry.userUid} | Shift: ${logEntry.shiftId} | Reason: ${logEntry.reason} | Src: ${logEntry.sourceFunction}`,
    logEntry
  );
}
