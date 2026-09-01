import { UserProfile } from '../../types';
import { getLatestUserActivity, isAuditOrDiagnosticEvent } from '../../lib/tmsUtils';
import { calculateShiftMetrics } from '../../lib/tmsCalculationEngine';

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

export function isMeetingActivity(activityName?: string): boolean {
  if (!activityName) return false;
  const nameLower = activityName.toLowerCase().trim();
  return nameLower.includes('meeting') || nameLower.includes('coaching') || nameLower.includes('alignment') || nameLower.includes('1:1') || nameLower.includes('one-on-one');
}

export function isTrainingActivity(activityName?: string): boolean {
  if (!activityName) return false;
  const nameLower = activityName.toLowerCase().trim();
  return nameLower.includes('training') || nameLower.includes('onboarding') || nameLower.includes('upskilling');
}

/**
 * Universal Firestore & JS timestamp parser returning Unix milliseconds.
 * Handles ISO strings, Firestore Timestamps ({seconds, nanoseconds}), Date objects, and Epoch numbers.
 */
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
    const parsed = new Date(trimmed).getTime();
    if (!isNaN(parsed)) return parsed;
    const isoFixed = trimmed.replace(' ', 'T');
    const parsedIso = new Date(isoFixed).getTime();
    if (!isNaN(parsedIso)) return parsedIso;

    // Handle time-only strings like "03:37 PM" or "15:30"
    if (/^\d{1,2}:\d{2}(\:\d{2})?\s*(AM|PM)?$/i.test(trimmed)) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const dateWithTime = new Date(`${todayStr} ${trimmed}`).getTime();
      if (!isNaN(dateWithTime)) return dateWithTime;
    }
  }
  return 0;
}

export interface LiveSessionRow {
  userId: string;
  userName: string;
  userEmail: string;
  photoURL?: string;
  userProcess: string;
  
  // Single live_sessions doc properties
  sessionId: string;
  hasActiveLiveSession: boolean;
  status: 'PRODUCTIVE' | 'BREAK' | 'MEETING' | 'TRAINING' | 'LOGGED_IN' | 'OFFLINE';
  displayStatus: string;
  currentActivity: string;
  currentProcess: string;
  since: string;
  productiveTimeStr: string;
  breakTimeStr: string;
  productiveSeconds: number;
  breakSeconds: number;
  deviceType: 'mobile' | 'desktop';
  lastHeartbeat: string;
  
  // Work Location Detection fields
  workLocation?: string;
  workLocationDetected?: string;
  workLocationSource?: string;
  publicIP?: string;
  officeName?: string;
  locationCapturedAt?: string;
  overrideBy?: string;
  overrideAt?: string;
  
  // Diagnostic flags
  isStuckSession?: boolean;
  lastActiveTimeStr?: string;
  diagnosticError?: string;
  rawDoc?: any;

  // Centralized metrics fields
  currentShiftProductiveMs?: number;
  totalBreakMs?: number;
  breakCount?: number;
  utilization?: number;
  shiftElapsedMs?: number;
  activeWorkMs?: number;
  clockInTime?: string;
  clockOutTime?: string;
}

export function resolveWorkLocation(liveDoc: any, userLocation?: string, isActiveSession?: boolean): string {
  if (liveDoc?.workLocation && typeof liveDoc.workLocation === 'string' && liveDoc.workLocation.trim() !== '') {
    const loc = liveDoc.workLocation.trim();
    if (loc.toLowerCase().includes('office')) return 'Office';
    if (loc.toLowerCase().includes('home') || loc.toLowerCase().includes('wfh')) return 'Home';
    return loc;
  }
  if (liveDoc?.officeName || liveDoc?.workLocationDetected === 'Office') {
    return 'Office';
  }
  if (userLocation && typeof userLocation === 'string' && userLocation.trim() !== '') {
    const uLoc = userLocation.trim();
    if (uLoc.toLowerCase().includes('office') || uLoc.toLowerCase().includes('hq')) return 'Office';
    if (uLoc.toLowerCase().includes('home') || uLoc.toLowerCase().includes('wfh')) return 'Home';
  }
  if (isActiveSession) {
    return 'Home'; // Default for active work shifts when undetected
  }
  return '';
}

/**
 * Maps a single user and their live_sessions document into a single-source-of-truth LiveSessionRow.
 */
export function mapToLiveSessionRow(u: Partial<UserProfile> & { uid: string }, liveDoc: any, nowMs: number): LiveSessionRow {
  const userId = u.uid;
  const rawUName = u.name || (u as any).fullName;
  const cleanUName = rawUName && rawUName !== 'Active Employee' ? rawUName : '';
  const rawLiveName = liveDoc?.employeeName || liveDoc?.userName;
  const cleanLiveName = rawLiveName && rawLiveName !== 'Active Employee' ? rawLiveName : '';
  const userName = cleanUName || cleanLiveName || (u.email ? u.email.split('@')[0] : (liveDoc?.userEmail ? liveDoc.userEmail.split('@')[0] : '')) || 'Unknown Agent';
  const userEmail = u.email || liveDoc?.email || liveDoc?.userEmail || '';
  const photoURL = u.photoURL;

  // Check if liveDoc exists and represents an active shift clock-in
  const rawStatus = (liveDoc?.status || '').toString().toUpperCase().trim();
  const isDocOnline = liveDoc && liveDoc.isOnline !== false;
  const isCompletedOrClosed = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'OFFLINE'].includes(rawStatus);

  const isActiveSession = Boolean(liveDoc && !isCompletedOrClosed);

  // Calculate latest activity timestamp across all heartbeat/status update/activity fields
  const lastActiveMs = parseTimestampMs(liveDoc?.lastHeartbeat) ||
    parseTimestampMs(liveDoc?.statusStartTime) ||
    parseTimestampMs(liveDoc?.currentActivityStartTime) ||
    parseTimestampMs(liveDoc?.clockInTime) ||
    parseTimestampMs(liveDoc?.lastLoginAt) ||
    parseTimestampMs(u.lastLoginAt) ||
    0;

  let latestActivityMs = lastActiveMs;
  const activities = liveDoc && Array.isArray(liveDoc.activities) ? liveDoc.activities : [];
  if (activities.length > 0) {
    activities.forEach((act: any) => {
      const actStartRaw = act.startTime || act.start_time || act.timestamp || act.start || act.time || act.createdAt || act.created_at;
      const sMs = parseTimestampMs(actStartRaw);
      if (sMs > latestActivityMs) latestActivityMs = sMs;

      const actEndRaw = act.endTime || act.end_time || act.end;
      const eMs = parseTimestampMs(actEndRaw);
      if (eMs > latestActivityMs) latestActivityMs = eMs;
    });
  }

  // Format last active relative string
  let lastActiveTimeStr = '';
  if (latestActivityMs > 0) {
    const diffMins = Math.floor((nowMs - latestActivityMs) / 60000);
    if (diffMins < 1) {
      lastActiveTimeStr = 'Just now';
    } else if (diffMins < 60) {
      lastActiveTimeStr = `${diffMins}m ago`;
    } else if (diffMins < 24 * 60) {
      const hours = Math.floor(diffMins / 60);
      const mins = diffMins % 60;
      lastActiveTimeStr = `${hours}h ${mins}m ago`;
    } else {
      const days = Math.floor(diffMins / (24 * 60));
      lastActiveTimeStr = `${days}d ago`;
    }
  } else {
    lastActiveTimeStr = '-';
  }

  // Inactivity & max shift age threshold:
  // If no activity/heartbeat for more than 14 hours OR if shift clock-in is older than 14 hours without clocking out, treat as stuck session
  const INACTIVITY_THRESHOLD_MS = 14 * 60 * 60 * 1000; // 14 hours
  const MAX_SHIFT_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours max shift length

  const shiftClockInMsForAge = parseTimestampMs(liveDoc?.clockInTime) || parseTimestampMs(liveDoc?.statusStartTime) || parseTimestampMs(liveDoc?.startTime) || 0;
  const isStuckByInactivity = isActiveSession && latestActivityMs > 0 && (nowMs - latestActivityMs) > INACTIVITY_THRESHOLD_MS;
  const isStuckByAge = isActiveSession && shiftClockInMsForAge > 0 && (nowMs - shiftClockInMsForAge) > INACTIVITY_THRESHOLD_MS;
  const isStuckSession = isStuckByInactivity || isStuckByAge;

  // Use capped evaluation time for timers if session is stuck offline or if shift clock-in is old
  let evaluationTimeMs = isStuckSession ? (latestActivityMs > 0 ? latestActivityMs : nowMs) : nowMs;
  if (shiftClockInMsForAge > 0 && (evaluationTimeMs - shiftClockInMsForAge) > MAX_SHIFT_DURATION_MS) {
    evaluationTimeMs = shiftClockInMsForAge + MAX_SHIFT_DURATION_MS;
  }

  // Check if user is logged into Web Portal (Supervisors, Managers, or Agents logged in without active shift)
  const lastLoginMs = parseTimestampMs(u.lastLoginAt || (u as any)?.lastLogin || liveDoc?.lastLoginAt || liveDoc?.lastLogin);
  const lastLogoutMs = parseTimestampMs((u as any)?.lastLogoutAt || (u as any)?.lastLogout || liveDoc?.lastLogoutAt || liveDoc?.lastLogout);
  const userStatusNorm = (u.status || '').toString().toUpperCase().trim();

  const lastLoginDate = new Date(lastLoginMs);
  const nowDate = new Date(nowMs);
  const isSameDay = lastLoginMs > 0 &&
    lastLoginDate.getDate() === nowDate.getDate() &&
    lastLoginDate.getMonth() === nowDate.getMonth() &&
    lastLoginDate.getFullYear() === nowDate.getFullYear();

  const isPortalOnline = userStatusNorm === 'ONLINE' ||
    (u as any)?.isOnline === true ||
    liveDoc?.isOnline === true ||
    (lastLoginMs > 0 && (isSameDay || (nowMs - lastLoginMs) < 16 * 60 * 60 * 1000) && (lastLogoutMs === 0 || lastLoginMs >= lastLogoutMs));

  // If user has NO active shift clock-in:
  if (!isActiveSession) {
    return {
      userId,
      userName,
      userEmail,
      photoURL,
      userProcess: u.process || 'General',
      sessionId: liveDoc?.sessionId || liveDoc?.id || '-',
      hasActiveLiveSession: false,
      status: 'OFFLINE',
      displayStatus: 'OFFLINE',
      currentActivity: 'Offline',
      currentProcess: liveDoc?.process || u.process || 'General',
      since: '-',
      productiveTimeStr: '-',
      breakTimeStr: '-',
      productiveSeconds: 0,
      breakSeconds: 0,
      deviceType: 'desktop',
      lastHeartbeat: liveDoc?.lastHeartbeat || '-',
      workLocation: resolveWorkLocation(liveDoc, u.location, false),
      workLocationDetected: liveDoc?.workLocationDetected || '',
      workLocationSource: liveDoc?.workLocationSource || '',
      publicIP: liveDoc?.publicIP || '',
      officeName: liveDoc?.officeName || '',
      locationCapturedAt: liveDoc?.locationCapturedAt || '',
      overrideBy: liveDoc?.overrideBy || '',
      overrideAt: liveDoc?.overrideAt || '',
      isStuckSession: false,
      lastActiveTimeStr,
      currentShiftProductiveMs: 0,
      totalBreakMs: 0,
      breakCount: 0,
      utilization: 0,
      shiftElapsedMs: 0,
      activeWorkMs: 0,
      clockInTime: undefined,
      clockOutTime: undefined,
      rawDoc: liveDoc
    };
  }

  const isLocationValue = (val?: string) => {
    if (!val) return false;
    const v = val.toLowerCase().trim();
    return v === 'office' || v === 'home' || v === 'wfh' || v === 'work from office' || v === 'work from home' || v === 'onsite' || v === 'remote';
  };

  // --- User HAS an active clock-in session ---
  const lastAct = getLatestUserActivity(activities);

  // 1. Current Activity Resolution
  let rawActivityName = '';
  if (lastAct && lastAct.name && lastAct.name !== 'Offline' && lastAct.name !== 'N/A' && !isLocationValue(lastAct.name)) {
    rawActivityName = lastAct.name;
  } else if (liveDoc.currentActivity && liveDoc.currentActivity !== 'Offline' && liveDoc.currentActivity !== 'N/A' && !isLocationValue(liveDoc.currentActivity)) {
    rawActivityName = liveDoc.currentActivity;
  } else if (liveDoc.process && liveDoc.process !== 'N/A' && !isLocationValue(liveDoc.process)) {
    rawActivityName = liveDoc.process;
  } else if (u.process && !isLocationValue(u.process)) {
    rawActivityName = u.process;
  } else {
    rawActivityName = '';
  }

  const isOnlyPortalLoggedIn = rawActivityName.toLowerCase().includes('portal logged in') || 
                               rawActivityName.toLowerCase().includes('portal login');

  if (isOnlyPortalLoggedIn) {
    return {
      userId,
      userName,
      userEmail,
      photoURL,
      userProcess: u.process || 'General',
      sessionId: liveDoc?.sessionId || liveDoc?.id || '-',
      hasActiveLiveSession: false,
      status: 'OFFLINE',
      displayStatus: 'OFFLINE',
      currentActivity: 'Offline',
      currentProcess: liveDoc?.process || u.process || 'General',
      since: '-',
      productiveTimeStr: '-',
      breakTimeStr: '-',
      productiveSeconds: 0,
      breakSeconds: 0,
      deviceType: 'desktop',
      lastHeartbeat: liveDoc?.lastHeartbeat || '-',
      workLocation: resolveWorkLocation(liveDoc, u.location, false),
      workLocationDetected: liveDoc?.workLocationDetected || '',
      workLocationSource: liveDoc?.workLocationSource || '',
      publicIP: liveDoc?.publicIP || '',
      officeName: liveDoc?.officeName || '',
      locationCapturedAt: liveDoc?.locationCapturedAt || '',
      overrideBy: liveDoc?.overrideBy || '',
      overrideAt: liveDoc?.overrideAt || '',
      rawDoc: liveDoc
    };
  }

  const rawActivityType = lastAct?.type || '';

  // 2. State Enforcement
  // An activity is ONLY an active break if lastAct exists, has NO endTime (!lastAct.endTime), AND is an explicit break action/type.
  const isLastActOpenBreak = lastAct ? (!lastAct.endTime && (lastAct.action === 'BREAK_START' || lastAct.type === 'break' || (lastAct.type !== 'productive' && isBreakActivity(rawActivityName, rawActivityType)))) : false;
  const isBreak = lastAct
    ? isLastActOpenBreak
    : (rawStatus === 'BREAK' || rawStatus === 'ON_BREAK');

  let status: 'PRODUCTIVE' | 'BREAK' | 'MEETING' | 'TRAINING' | 'LOGGED_IN' | 'OFFLINE' = 'PRODUCTIVE';
  let currentActivity = rawActivityName || 'Productive';

  if (isBreak) {
    status = 'BREAK';
    currentActivity = (rawActivityName && !isLocationValue(rawActivityName)) ? rawActivityName : 'Break';
  } else {
    if (isMeetingActivity(rawActivityName)) {
      status = 'MEETING';
      currentActivity = rawActivityName || 'Meeting';
    } else if (isTrainingActivity(rawActivityName)) {
      status = 'TRAINING';
      currentActivity = rawActivityName || 'Training';
    } else {
      status = 'PRODUCTIVE';
      currentActivity = (rawActivityName && !isLocationValue(rawActivityName)) ? rawActivityName : 'Productive';
    }
  }

  // 3. Current Process
  const lastProductiveAct = activities.slice().reverse().find((a: any) => a.type === 'productive' && !isBreakActivity(a.name) && !isLocationValue(a.name));
  const currentProcess = (liveDoc.process && !isLocationValue(liveDoc.process)) ? liveDoc.process
    : (liveDoc.currentProcess && !isLocationValue(liveDoc.currentProcess)) ? liveDoc.currentProcess
    : (lastProductiveAct?.name && !isLocationValue(lastProductiveAct.name)) ? lastProductiveAct.name
    : (u.process && !isLocationValue(u.process)) ? u.process
    : 'General';

  // 4. Since Time (Shift Clock-In Time)
  const shiftClockInMs = parseTimestampMs(liveDoc.clockInTime) ||
    parseTimestampMs(liveDoc.statusStartTime) ||
    parseTimestampMs(liveDoc.currentActivityStartTime) ||
    parseTimestampMs(liveDoc.startTime);

  const sinceTimeMs = shiftClockInMs ||
    parseTimestampMs(lastAct?.startTime || lastAct?.start_time || lastAct?.timestamp) ||
    parseTimestampMs(liveDoc.lastLoginAt) ||
    parseTimestampMs(liveDoc.lastHeartbeat);

  let sinceFormatted = '-';
  if (sinceTimeMs > 0) {
    try {
      sinceFormatted = new Date(sinceTimeMs).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
    } catch {
      sinceFormatted = new Date(sinceTimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  }

  // 5. Timers (Productive & Break Time) computed via unified calculateShiftMetrics
  const metrics = calculateShiftMetrics(liveDoc, evaluationTimeMs);
  let productiveMs = metrics.productiveMs;
  let breakMs = metrics.breakMs;
  let totalShiftElapsedMs = metrics.elapsedMs;

  const prodSec = Math.floor(productiveMs / 1000);
  const breakSec = Math.floor(breakMs / 1000);

  const formatTimer = (sec: number) => {
    if (sec <= 0) return '0m 0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  };

  const productiveTimeStr = formatTimer(prodSec);
  const breakTimeStr = formatTimer(breakSec);

  // 6. Device
  const deviceRaw = (lastAct?.device || liveDoc.deviceType || liveDoc.clockInDevice || liveDoc.device || '').toString().toLowerCase();
  const deviceType: 'mobile' | 'desktop' = deviceRaw.includes('mobile') || deviceRaw.includes('phone') || deviceRaw.includes('android') || deviceRaw.includes('ios') ? 'mobile' : 'desktop';

  // 7. Diagnostic validation check
  let diagnosticError: string | undefined;
  if ((rawStatus === 'ACTIVE' || rawStatus === 'PRODUCTIVE') && isBreakActivity(rawActivityName)) {
    diagnosticError = `Invalid Raw State: Status is '${rawStatus}' but activity is '${rawActivityName}' (Rectified to BREAK)`;
  }

  const effectiveClockInIso = liveDoc.clockInTime ||
    (shiftClockInMs > 0 ? new Date(shiftClockInMs).toISOString() : undefined);

  const enrichedLiveDoc = {
    ...liveDoc,
    currentShiftProductiveMs: metrics.productiveMs,
    totalBreakMs: metrics.breakMs,
    breakCount: metrics.totalBreaks,
    utilization: metrics.utilization,
    shiftElapsedMs: metrics.elapsedMs,
    activeWorkMs: metrics.activeWorkMs,
    clockInTime: effectiveClockInIso,
    clockOutTime: liveDoc.clockOutTime,
  };

  return {
    userId,
    userName,
    userEmail,
    photoURL,
    userProcess: u.process || 'General',
    sessionId: liveDoc.sessionId || liveDoc.id || userId,
    hasActiveLiveSession: true,
    status: isStuckSession ? 'OFFLINE' : status,
    displayStatus: isStuckSession ? 'OFFLINE' : status,
    currentActivity: isStuckSession ? `Offline (Inactive since ${lastActiveTimeStr})` : currentActivity,
    currentProcess,
    since: isStuckSession ? '-' : sinceFormatted,
    productiveTimeStr,
    breakTimeStr,
    productiveSeconds: prodSec,
    breakSeconds: breakSec,
    deviceType,
    lastHeartbeat: liveDoc.lastHeartbeat || liveDoc.statusStartTime || liveDoc.clockInTime || '-',
    workLocation: resolveWorkLocation(liveDoc, u.location, true),
    workLocationDetected: liveDoc?.workLocationDetected || (resolveWorkLocation(liveDoc, u.location, true) === 'Office' ? 'Office' : 'Home'),
    workLocationSource: liveDoc?.workLocationSource || 'IP Detection',
    publicIP: liveDoc?.publicIP || '',
    officeName: liveDoc?.officeName || '',
    locationCapturedAt: liveDoc?.locationCapturedAt || '',
    overrideBy: liveDoc?.overrideBy || '',
    overrideAt: liveDoc?.overrideAt || '',
    isStuckSession,
    lastActiveTimeStr,
    diagnosticError,

    // Centralized metrics directly on the row
    currentShiftProductiveMs: metrics.productiveMs,
    totalBreakMs: metrics.breakMs,
    breakCount: metrics.totalBreaks,
    utilization: metrics.utilization,
    shiftElapsedMs: metrics.elapsedMs,
    activeWorkMs: metrics.activeWorkMs,
    clockInTime: effectiveClockInIso,
    clockOutTime: liveDoc.clockOutTime,

    rawDoc: enrichedLiveDoc
  };
}

