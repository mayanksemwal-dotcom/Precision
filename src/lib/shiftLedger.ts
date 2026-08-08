import { formatPeriodForDisplay } from './utils';

export type ShiftEventType = 
  | 'CLOCK_IN'
  | 'CLOCK_OUT'
  | 'BREAK_START'
  | 'BREAK_END'
  | 'PROCESS_SWITCH'
  | 'SHIFT_EXTENSION'
  | 'AUTO_CLOSE'
  | 'AUTO_PRODUCTIVE_LIMIT'
  | 'SUPERVISOR_FORCE_LOGOUT'
  | 'MANUAL_CORRECTION'
  | 'SHIFT_RECOVERY'
  | 'SHIFT_RESUME'
  | 'ATTENDANCE_REPAIR'
  | 'STATUS_CHANGE'
  | 'ROLE_OVERRIDE'
  | 'DEVICE_CHANGE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'HEARTBEAT_LOST'
  | 'HEARTBEAT_RESTORED'
  | 'LEGACY_IMPORT';

export interface ShiftEvent {
  sequence: number;
  eventType: ShiftEventType;
  timestamp: string; // ISO string
  performedBy: string; // "Employee" | "Admin" | "Supervisor" | "System" | User name/email
  source: string; // "TMS" | "Recovery Tool" | "Cleanup Service" | "Attendance Repair" | "Supervisor Panel" | etc.
  reason?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  metadata?: Record<string, any>;
  confidence?: number;
  remarks?: string;
}

export interface MinimalShiftData {
  id?: string;
  userName?: string;
  employeeName?: string;
  userEmail?: string;
  email?: string;
  clockInTime?: string;
  clockOutTime?: string;
  status?: string;
  process?: string;
  currentProcess?: string;
  activities?: any[];
  shiftEventLedger?: ShiftEvent[];
  [key: string]: any;
}

/**
 * Ensures legacy shifts without a shiftEventLedger have a synthesized ledger.
 * Generates LEGACY_IMPORT and chronologically reconstructed activity events.
 */
export function generateLegacyLedgerIfEmpty(shift: MinimalShiftData): ShiftEvent[] {
  if (shift.shiftEventLedger && Array.isArray(shift.shiftEventLedger) && shift.shiftEventLedger.length > 0) {
    return shift.shiftEventLedger;
  }

  const ledger: ShiftEvent[] = [];
  const userName = shift.userName || shift.employeeName || shift.userEmail || shift.email || 'Employee';
  const clockIn = shift.clockInTime || new Date().toISOString();
  let seq = 1;

  // 1. Initial LEGACY_IMPORT / CLOCK_IN event
  ledger.push({
    sequence: seq++,
    eventType: 'LEGACY_IMPORT',
    timestamp: clockIn,
    performedBy: userName,
    source: 'TMS Legacy Import',
    reason: 'Initial shift creation from legacy record',
    oldValue: null,
    newValue: clockIn,
    metadata: {
      initialProcess: shift.process || shift.currentProcess || 'Work',
      status: shift.status || 'CLOCKED_OUT'
    },
    remarks: 'Auto-synthesized for immutable ledger compatibility'
  });

  // 2. Reconstruct events from activities if available
  if (Array.isArray(shift.activities) && shift.activities.length > 0) {
    let currentProc = shift.process || shift.currentProcess || 'Work';

    shift.activities.forEach((act, idx) => {
      const actStart = act.startTime || clockIn;
      if (act.type === 'break') {
        ledger.push({
          sequence: seq++,
          eventType: 'BREAK_START',
          timestamp: actStart,
          performedBy: userName,
          source: 'TMS',
          reason: `Started break: ${act.name || 'Break'}`,
          oldValue: currentProc,
          newValue: act.name || 'Break',
          metadata: { breakName: act.name || 'Break', ...(act.device ? { device: act.device } : {}) }
        });

        if (act.endTime) {
          ledger.push({
            sequence: seq++,
            eventType: 'BREAK_END',
            timestamp: act.endTime,
            performedBy: userName,
            source: 'TMS',
            reason: `Ended break: ${act.name || 'Break'}`,
            oldValue: act.name || 'Break',
            newValue: currentProc,
            metadata: { breakName: act.name || 'Break', ...(act.device ? { device: act.device } : {}) }
          });
        }
      } else if (act.type === 'productive' && idx > 0) {
        if (act.name && act.name !== currentProc) {
          ledger.push({
            sequence: seq++,
            eventType: 'PROCESS_SWITCH',
            timestamp: actStart,
            performedBy: userName,
            source: 'TMS',
            reason: `Switched process to ${act.name}`,
            oldValue: currentProc,
            newValue: act.name,
            metadata: { oldProcess: currentProc, newProcess: act.name }
          });
          currentProc = act.name;
        }
      }
    });
  }

  // 3. Final Clock Out / Auto Close event if ended
  if (shift.clockOutTime) {
    const isAutoClose = shift.status === 'AUTO_CLOSED';
    ledger.push({
      sequence: seq++,
      eventType: isAutoClose ? 'AUTO_CLOSE' : 'CLOCK_OUT',
      timestamp: shift.clockOutTime,
      performedBy: isAutoClose ? 'System Cleanup Service' : userName,
      source: isAutoClose ? 'Background Service' : 'TMS',
      reason: isAutoClose ? 'Auto closed due to shift limit' : 'Shift ended',
      oldValue: shift.clockInTime,
      newValue: shift.clockOutTime,
      ...(shift.remarks ? { remarks: shift.remarks } : {})
    });
  }

  return ledger;
}

/**
 * Safely appends a new event to an existing shift's event ledger.
 * Guaranteeing sequence monotonicity and immutability.
 */
export function appendShiftEvent(
  existingLedger: ShiftEvent[] | undefined,
  existingShiftData: MinimalShiftData | undefined,
  event: Omit<ShiftEvent, 'sequence'>
): ShiftEvent[] {
  let ledger: ShiftEvent[] = [];

  if (existingLedger && Array.isArray(existingLedger) && existingLedger.length > 0) {
    ledger = [...existingLedger];
  } else if (existingShiftData) {
    ledger = generateLegacyLedgerIfEmpty(existingShiftData);
  }

  const nextSeq = ledger.length > 0 ? Math.max(...ledger.map(e => e.sequence || 0)) + 1 : 1;

  const newEntry: any = {
    eventId: crypto.randomUUID(),
    sequence: nextSeq,
    eventType: event.eventType,
    timestamp: event.timestamp,
    performedBy: event.performedBy,
    source: event.source,
    reason: event.reason,
  };
  
  if (event.oldValue !== undefined) newEntry.oldValue = event.oldValue;
  if (event.newValue !== undefined) newEntry.newValue = event.newValue;
  if (event.metadata !== undefined) newEntry.metadata = event.metadata;
  if (event.confidence !== undefined) newEntry.confidence = event.confidence;
  if (event.remarks !== undefined) newEntry.remarks = event.remarks;

  return [...ledger, newEntry];
}

export interface ChronologicalExportRow {
  'Employee': string;
  'User Email': string;
  'Shift Date': string;
  'Event Sequence': number;
  'Event Time': string;
  'Event Type': string;
  'Old Value': string;
  'New Value': string;
  'Reason': string;
  'Source': string;
  'Performed By': string;
  'Confidence': string;
  'Remarks': string;
}

import { buildTimelineFromActivityLedger } from '../lib/tmsUtils';

/**
 * Formats a shift and its event ledger into rows for Chronological Audit Trail Export.
 */
export function formatShiftLedgerForReport(shift: MinimalShiftData): ChronologicalExportRow[] {
  const employee = shift.userName || shift.employeeName || 'Unknown Employee';
  const email = shift.userEmail || shift.email || '-';
  const shiftDate = shift.clockInTime ? shift.clockInTime.split('T')[0] : 'N/A';

  // Use the shared timeline reconstruction logic to derive windows
  const segments = buildTimelineFromActivityLedger(
    shift.activities || [], 
    shift.status || 'ACTIVE', 
    shift.clockOutTime
  );

  return segments.map((act, index) => {
    let formattedTime = act.startTime;
    try {
      formattedTime = new Date(act.startTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    } catch {
      // fallback
    }

    let endFormatted = 'Active Now';
    if (act.endTime) {
      try {
        endFormatted = new Date(act.endTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      } catch {
        // fallback
      }
    }

    return {
      'Employee': employee,
      'User Email': email,
      'Shift Date': shiftDate,
      'Event Sequence': index + 1,
      'Event Time': formattedTime,
      'Event Type': act.action || (act.type === 'break' ? 'BREAK' : 'WORK'),
      'Old Value': act.previousValue || '-',
      'New Value': act.newValue || act.process || act.name || '-',
      'Reason': `${act.reason || '-'}${act.isLive ? ' (CURRENT)' : ` (Ended: ${endFormatted})`}`,
      'Source': act.sourceService || 'TMS',
      'Performed By': act.actor || employee,
      'Confidence': act.confidence !== undefined ? `${act.confidence}%` : '-',
      'Remarks': act.remarks || '-'
    };
  });
}
