import { db, auth, getDocsOptimized } from '../lib/firebase';
import { collection, query, where, updateDoc, doc, writeBatch, getDoc, getDocs, deleteDoc, orderBy, limit } from 'firebase/firestore';
import { syncShiftToAttendance } from './attendanceSyncService';
import { logTmsEvent } from '../lib/tmsLogger';
import { appendShiftEvent } from '../lib/shiftLedger';
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

export interface FinalizedMetrics {
  productiveMinutes: number;
  breakMinutes: number;
  shiftDuration: number;
  productiveMs: number;
  breakMs: number;
  totalShiftMs: number;
  totalProductiveTime: string;
  totalBreakTime: string;
  totalShiftTime: string;
  utilization: number;
  finalUtilization: number;
}

export const calculateShiftFinalMetrics = (
  shift: any,
  clockOutISO: string,
  presentThreshold: number = 480
): FinalizedMetrics => {
  const startMs = shift.clockInTime ? new Date(shift.clockInTime).getTime() : Date.now();
  const endMs = clockOutISO ? new Date(clockOutISO).getTime() : Date.now();
  const totalShiftMs = Math.max(0, endMs - startMs);

  const rawActs = shift.activities || [];
  const sanitizedActs = sanitizeActivities(rawActs, shift.clockInTime, endMs, shift.status, clockOutISO);

  let activeMs = 0;
  let breakMs = 0;

  sanitizedActs.forEach(act => {
    const aStart = act.startTime ? new Date(act.startTime).getTime() : startMs;
    const aEnd = act.endTime ? new Date(act.endTime).getTime() : endMs;
    const duration = Math.max(0, aEnd - aStart);
    const actName = (act.name || '').toLowerCase();
    const isProductive = act.type === 'productive' || 
                 ['meeting', 'coaching', 'training', 'alignment'].some(k => actName.includes(k));
    if (isProductive) {
      activeMs += duration;
    } else {
      breakMs += duration;
    }
  });

  activeMs = Math.min(activeMs, totalShiftMs);
  if (activeMs + breakMs > totalShiftMs && totalShiftMs > 0) {
    breakMs = Math.max(0, totalShiftMs - activeMs);
  }

  const productiveMins = Number((activeMs / 60000).toFixed(1));
  const breakMins = Number((breakMs / 60000).toFixed(1));
  const shiftDurationMins = Number((totalShiftMs / 60000).toFixed(1));

  const thresholdMins = presentThreshold || 480;
  const utilization = Number(Math.min(100, Math.max(0, (productiveMins / thresholdMins) * 100)).toFixed(1));

  const formatMsHelper = (ms: number): string => {
    const totalSecs = Math.floor(ms / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return {
    productiveMinutes: productiveMins,
    breakMinutes: breakMins,
    shiftDuration: shiftDurationMins,
    productiveMs: activeMs,
    breakMs: breakMs,
    totalShiftMs,
    totalProductiveTime: formatMsHelper(activeMs),
    totalBreakTime: formatMsHelper(breakMs),
    totalShiftTime: formatMsHelper(totalShiftMs),
    utilization,
    finalUtilization: utilization
  };
};

export const createLockedCompletedShift = (
  shift: any,
  clockOutISO: string,
  closedBy: string,
  remarks?: string,
  clockOutDevice?: string,
  statusOverride: string = 'COMPLETED',
  presentThreshold: number = 480
): any => {
  const finalActivities = Array.isArray(shift.activities) ? [...shift.activities] : [];
  if (finalActivities.length > 0) {
    const lastIdx = finalActivities.length - 1;
    finalActivities[lastIdx] = {
      ...finalActivities[lastIdx],
      endTime: clockOutISO
    };
  }

  const metrics = calculateShiftFinalMetrics({ ...shift, activities: finalActivities }, clockOutISO, presentThreshold);

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

const isSupervisorOrManagerRole = (role: string | undefined): boolean => {
  if (!role) return false;
  const norm = role.toString().toUpperCase().trim();
  return [
    'ADMIN',
    'MANAGER',
    'STL',
    'OPS_TL',
    'QTL',
    'TEAM_LEAD',
    'TEAM LEAD',
    'TRAINER_TL',
    'OPS_HEAD',
    'HR',
    'IT_MANAGER',
    'ASSISTANT_MANAGER',
    'MIS',
    'SUPERVISOR',
    'SUPERVISORS',
    'SME',
    'EXECUTIVE',
    'DIRECTOR',
    'VP'
  ].includes(norm) || 
  norm.includes('ADMIN') || 
  norm.includes('MANAGER') || 
  norm.includes('TL') || 
  norm.includes('LEAD') || 
  norm.includes('SUPERVISOR') || 
  norm.includes('DIRECTOR') || 
  norm.includes('EXEC') || 
  norm.includes('PRESIDENT') || 
  norm.includes('SME');
};

export const performTmsTenHourForceOut = async () => {
  console.log('[TMS CLEANUP] Checking for shifts exceeding 10 hours or inactive sessions is bypassed (Auto clock-outs are disabled at root level).');
  return;
};

export const repairCorruptedClockInTimes = async () => {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    console.log('[TMS REPAIR] No authenticated user. Skipping repair.');
    return;
  }

  console.log('[TMS CLEANUP] Running smart repair for -5.5h corrupted clock-in times...');
  const FIVE_HALF_HOURS = 5.5 * 60 * 60 * 1000;
  let totalRepaired = 0;

  try {
    let isSupervisor = currentUser.email?.toLowerCase() === 'mayank.semwal@bergtechnologies.co.in';
    if (!isSupervisor) {
      try {
        const empSnap = await getDoc(doc(db, 'employee_master', currentUser.uid));
        if (empSnap.exists() && isSupervisorOrManagerRole(empSnap.data()?.role)) {
          isSupervisor = true;
        } else {
          const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
          if (userSnap.exists() && isSupervisorOrManagerRole(userSnap.data()?.role)) {
            isSupervisor = true;
          }
        }
      } catch (e) {
        console.warn('[TMS REPAIR] Role lookup error:', e);
      }
    }

    const batch = writeBatch(db);

    if (isSupervisor) {
      // 1. Scan live_sessions for active/break users whose clockInTime was corrupted (-5.5h)
      try {
        const liveSnap = await getDocsOptimized(query(collection(db, 'live_sessions')), 'repair_live_sessions', true);
        liveSnap.forEach((dDoc) => {
          const data = dDoc.data();
          const clockInMs = data.clockInTime ? new Date(data.clockInTime).getTime() : 0;
          const loginMs = data.loginTimestamp ? new Date(data.loginTimestamp).getTime() : 0;
          const repairedAt = data.repairedAt;
          
          const isCorrupted = !!repairedAt || (loginMs > 0 && clockInMs > 0 && (loginMs - clockInMs) >= 3.5 * 60 * 60 * 1000);

          if (isCorrupted && clockInMs > 0) {
            const trueClockInMs = clockInMs + FIVE_HALF_HOURS;
            const newClockIn = new Date(trueClockInMs).toISOString();

            const newStatusStart = data.statusStartTime 
              ? new Date(new Date(data.statusStartTime).getTime() + FIVE_HALF_HOURS).toISOString() 
              : newClockIn;

            const newActivityStart = data.currentActivityStartTime 
              ? new Date(new Date(data.currentActivityStartTime).getTime() + FIVE_HALF_HOURS).toISOString() 
              : newClockIn;

            const newActivities = (data.activities || []).map((act: any) => ({
              ...act,
              startTime: act.startTime ? new Date(new Date(act.startTime).getTime() + FIVE_HALF_HOURS).toISOString() : newClockIn,
              endTime: act.endTime ? new Date(new Date(act.endTime).getTime() + FIVE_HALF_HOURS).toISOString() : null
            }));

            batch.update(dDoc.ref, {
              clockInTime: newClockIn,
              statusStartTime: newStatusStart,
              currentActivityStartTime: newActivityStart,
              activities: newActivities,
              repairedAt: null,
              repairedRestoredAt: new Date().toISOString()
            });

            totalRepaired++;
            console.log(`[TMS REPAIR] Restored live_session for ${data.employeeName || data.email || dDoc.id}: ${data.clockInTime} -> ${newClockIn}`);
          }
        });
      } catch (liveErr) {
        console.warn('[TMS REPAIR] Could not query org-wide live_sessions for repair:', liveErr);
      }

      // 2. Scan tmsShifts for active/break OR recently AUTO_CLOSED shifts from today whose clockInTime was corrupted
      try {
        const shiftsQ = query(collection(db, 'tmsShifts'));
        const shiftsSnap = await getDocsOptimized(shiftsQ, 'repair_tms_shifts', true);

        shiftsSnap.forEach((shDoc) => {
          const sh = shDoc.data();
          const clockInMs = sh.clockInTime ? new Date(sh.clockInTime).getTime() : 0;
          const loginMs = sh.loginTimestamp ? new Date(sh.loginTimestamp).getTime() : 0;
          const repairedAt = sh.repairedAt;
          const status = (sh.status || '').toUpperCase();

          if (shouldSkipShiftUpdate(sh, 'repairCorruptedClockInTimes')) {
            return;
          }

          const isCorrupted = !!repairedAt || (loginMs > 0 && clockInMs > 0 && (loginMs - clockInMs) >= 3.5 * 60 * 60 * 1000);

          if (isCorrupted && clockInMs > 0) {
            const trueClockInMs = clockInMs + FIVE_HALF_HOURS;
            const newClockIn = new Date(trueClockInMs).toISOString();

            const newActivities = (sh.activities || []).map((act: any) => ({
              ...act,
              startTime: act.startTime ? new Date(new Date(act.startTime).getTime() + FIVE_HALF_HOURS).toISOString() : newClockIn,
              endTime: act.endTime ? new Date(new Date(act.endTime).getTime() + FIVE_HALF_HOURS).toISOString() : null
            }));

            const updates: any = {
              clockInTime: newClockIn,
              activities: newActivities,
              repairedAt: null,
              repairedRestoredAt: new Date().toISOString()
            };

            if (status === 'AUTO_CLOSED' || status === 'COMPLETED_FORCED') {
              updates.status = 'ACTIVE';
              updates.clockOutTime = null;
              updates.remarks = 'Restored active shift following clock skew repair';

              const liveRef = doc(db, 'live_sessions', sh.userId);
              batch.set(liveRef, {
                sessionId: sh.id,
                userId: sh.userId,
                employeeName: sh.userName,
                email: sh.userEmail,
                clockInTime: newClockIn,
                status: 'ACTIVE',
                statusStartTime: newClockIn,
                currentActivityStartTime: newClockIn,
                process: sh.process || 'General',
                activities: newActivities,
                lastHeartbeat: new Date().toISOString()
              }, { merge: true });
            }

            batch.update(shDoc.ref, updates);
            totalRepaired++;
            console.log(`[TMS REPAIR] Restored tmsShift ${sh.id} for ${sh.userName || sh.userEmail}: ${sh.clockInTime} -> ${newClockIn}`);
          }
        });
      } catch (shiftsErr) {
        console.warn('[TMS REPAIR] Could not query org-wide tmsShifts for repair:', shiftsErr);
      }
    } else {
      // Standard Agent: ONLY check own live_sessions document and own tmsShifts
      try {
        const myLiveDoc = await getDoc(doc(db, 'live_sessions', currentUser.uid));
        if (myLiveDoc.exists()) {
          const data = myLiveDoc.data();
          const clockInMs = data.clockInTime ? new Date(data.clockInTime).getTime() : 0;
          const loginMs = data.loginTimestamp ? new Date(data.loginTimestamp).getTime() : 0;
          const repairedAt = data.repairedAt;
          const isCorrupted = !!repairedAt || (loginMs > 0 && clockInMs > 0 && (loginMs - clockInMs) >= 3.5 * 60 * 60 * 1000);

          if (isCorrupted && clockInMs > 0) {
            const trueClockInMs = clockInMs + FIVE_HALF_HOURS;
            const newClockIn = new Date(trueClockInMs).toISOString();

            const newStatusStart = data.statusStartTime 
              ? new Date(new Date(data.statusStartTime).getTime() + FIVE_HALF_HOURS).toISOString() 
              : newClockIn;

            const newActivityStart = data.currentActivityStartTime 
              ? new Date(new Date(data.currentActivityStartTime).getTime() + FIVE_HALF_HOURS).toISOString() 
              : newClockIn;

            const newActivities = (data.activities || []).map((act: any) => ({
              ...act,
              startTime: act.startTime ? new Date(new Date(act.startTime).getTime() + FIVE_HALF_HOURS).toISOString() : newClockIn,
              endTime: act.endTime ? new Date(new Date(act.endTime).getTime() + FIVE_HALF_HOURS).toISOString() : null
            }));

            batch.update(myLiveDoc.ref, {
              clockInTime: newClockIn,
              statusStartTime: newStatusStart,
              currentActivityStartTime: newActivityStart,
              activities: newActivities,
              repairedAt: null,
              repairedRestoredAt: new Date().toISOString()
            });
            totalRepaired++;
          }
        }
      } catch (myLiveErr) {
        console.warn('[TMS REPAIR] Error checking personal live session:', myLiveErr);
      }

      try {
        const myShiftsQ = query(collection(db, 'tmsShifts'), where('userId', '==', currentUser.uid));
        const myShiftsSnap = await getDocsOptimized(myShiftsQ, `repair_my_shifts_${currentUser.uid}`, true);
        myShiftsSnap.forEach((shDoc) => {
          const sh = shDoc.data();
          const clockInMs = sh.clockInTime ? new Date(sh.clockInTime).getTime() : 0;
          const loginMs = sh.loginTimestamp ? new Date(sh.loginTimestamp).getTime() : 0;
          const repairedAt = sh.repairedAt;
          const status = (sh.status || '').toUpperCase();

          if (shouldSkipShiftUpdate(sh, 'repairCorruptedClockInTimes')) return;

          const isCorrupted = !!repairedAt || (loginMs > 0 && clockInMs > 0 && (loginMs - clockInMs) >= 3.5 * 60 * 60 * 1000);

          if (isCorrupted && clockInMs > 0) {
            const trueClockInMs = clockInMs + FIVE_HALF_HOURS;
            const newClockIn = new Date(trueClockInMs).toISOString();

            const newActivities = (sh.activities || []).map((act: any) => ({
              ...act,
              startTime: act.startTime ? new Date(new Date(act.startTime).getTime() + FIVE_HALF_HOURS).toISOString() : newClockIn,
              endTime: act.endTime ? new Date(new Date(act.endTime).getTime() + FIVE_HALF_HOURS).toISOString() : null
            }));

            const updates: any = {
              clockInTime: newClockIn,
              activities: newActivities,
              repairedAt: null,
              repairedRestoredAt: new Date().toISOString()
            };

            if (status === 'AUTO_CLOSED' || status === 'COMPLETED_FORCED') {
              updates.status = 'ACTIVE';
              updates.clockOutTime = null;
              updates.remarks = 'Restored active shift following clock skew repair';

              const liveRef = doc(db, 'live_sessions', sh.userId);
              batch.set(liveRef, {
                sessionId: sh.id,
                userId: sh.userId,
                employeeName: sh.userName,
                email: sh.userEmail,
                clockInTime: newClockIn,
                status: 'ACTIVE',
                statusStartTime: newClockIn,
                currentActivityStartTime: newClockIn,
                process: sh.process || 'General',
                activities: newActivities,
                lastHeartbeat: new Date().toISOString()
              }, { merge: true });
            }

            batch.update(shDoc.ref, updates);
            totalRepaired++;
          }
        });
      } catch (myShiftsErr) {
        console.warn('[TMS REPAIR] Error checking personal shifts:', myShiftsErr);
      }
    }

    if (totalRepaired > 0) {
      await batch.commit();
      console.log(`[TMS REPAIR] Successfully restored ${totalRepaired} corrupted shift records (+5.5 hours restored).`);
    } else {
      console.log('[TMS REPAIR] No corrupted shift records found requiring restoration.');
    }
  } catch (err) {
    console.error('[TMS REPAIR] Error during clock repair execution:', err);
  }
};

export const performTmsStaleSessionCleanup = async (currentUser?: any) => {
  console.log('[TMS CLEANUP] Stale session cleanup is bypassed (Auto clock-outs are disabled at root level).');
  return;
  const now = new Date().getTime();
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  
  try {
    // Fetch users map for roles to exempt supervisors
    const usersSnap = await getDocsOptimized(query(collection(db, 'users')), 'tms_cleanup_users_roles_stale', true);
    const userRoleMap = new Map<string, string>();
    usersSnap.forEach(uDoc => {
      const data = uDoc.data();
      if (data && data.role) {
        userRoleMap.set(uDoc.id, data.role.toString().toUpperCase().trim());
      }
    });

    // Query all non-completed sessions
    const q = query(collection(db, 'tmsShifts'), where('status', 'in', ['ACTIVE', 'BREAK']));
    const snap = await getDocsOptimized(q, 'tms_cleanup_stale_check', true);
    
    const batch = writeBatch(db);
    let staleCount = 0;
    const staleShifts: any[] = [];
    const activeShiftUserIds = new Set<string>();
    
    snap.forEach((shDoc) => {
      const sh = shDoc.data() as any;

      if (isShiftLockedOrCompleted(sh)) {
        console.log(`[TMS CLEANUP] Shift ${shDoc.id} is already completed/locked (${sh.status}). Skipping stale session cleanup.`);
        return;
      }

      // EXEMPT SUPERVISORS & MANAGERS & LEADS
      const userRole = userRoleMap.get(sh.userId) || '';
      if (isSupervisorOrManagerRole(userRole)) {
        console.log(`[TMS CLEANUP] Bypassing stale check for supervisor/manager/lead: ${sh.userName || sh.userId} (${userRole})`);
        if (sh.userId) {
          activeShiftUserIds.add(sh.userId);
        }
        return;
      }

      const clockInMs = new Date(sh.clockInTime).getTime();
    const elapsedShiftMs = now - clockInMs;
    
    // Determine last activity time
    const activities = sh.activities || [];
    const lastActivity = activities.length > 0 ? activities[activities.length - 1] : null;
    const lastActivityTime = lastActivity 
      ? new Date(lastActivity.endTime || lastActivity.startTime).getTime() 
      : clockInMs;
    
    // Stale if running for more than 16 hours, or running for more than 12 hours without extension, or running over 24 hours
    const maxAllowedMs = TWELVE_HOURS_MS;
    const isExtended = !!(sh.sessionExtended || sh.extended);
    const isOverSixteenHours = elapsedShiftMs >= 16 * 60 * 60 * 1000;
    const isOverTwentyFourHours = elapsedShiftMs >= 24 * 60 * 60 * 1000;
    
    const isStale = isOverTwentyFourHours || isOverSixteenHours || (elapsedShiftMs >= maxAllowedMs && !isExtended);
    
    if (isStale) {
        const clockOutTime = new Date(lastActivityTime).toISOString();
        const updatedShift = createLockedCompletedShift(
            { id: shDoc.id, ...sh },
            clockOutTime,
            'SYSTEM_STALE_CLEANUP',
            'AUTO_CLOSED_STALE_SESSION',
            undefined,
            'AUTO_CLOSED'
        );
        batch.set(shDoc.ref, updatedShift, { merge: true });
        
        logTmsEvent('AUTO_CLOSE', {
          userId: sh.userId,
          shiftId: shDoc.id,
          timestamp: clockOutTime,
          reason: 'AUTO_CLOSED_STALE_SESSION',
          sourceFunction: 'performTmsStaleSessionCleanup'
        });
        
        // Also update the user's status to OFFLINE if they were in this shift
        try {
          const userRef = doc(db, 'users', sh.userId);
          batch.update(userRef, {
            status: 'OFFLINE',
            lastLogoutAt: clockOutTime
          });
        } catch (uErr) {
          console.error('[TMS CLEANUP] Error queueing user status update:', uErr);
        }
 
        // Also delete from live_sessions
        try {
          const liveRef = doc(db, 'live_sessions', sh.userId);
          batch.delete(liveRef);
        } catch (lErr) {
          console.error('[TMS CLEANUP] Error queueing live session delete:', lErr);
        }
 
        staleCount++;
        staleShifts.push(updatedShift);
    } else {
        if (sh.userId) {
          activeShiftUserIds.add(sh.userId);
        }
    }
  });
 
  // Direct cleanup of ghost sessions from live_sessions collection
  // Only executed by global admins to prevent TLs/Supervisors from deleting other users' active sessions due to limited/cached query results.
  const userRole = currentUser?.role ? currentUser.role.toString().toUpperCase().trim() : '';
  const isGlobalAdmin = ['ADMIN', 'SYSTEM_ADMIN', 'MIS', 'OPS_HEAD', 'OPS HEAD'].includes(userRole);
 
  if (isGlobalAdmin) {
    try {
      const liveSessionsQ = query(collection(db, 'live_sessions'));
      const liveSessionsSnap = await getDocsOptimized(liveSessionsQ, 'tms_cleanup_live_sessions_ghost_check', true);
      let ghostCount = 0;
      
      liveSessionsSnap.forEach((liveDoc) => {
        const liveData = liveDoc.data() as any;
        const liveUserId = liveData.userId || liveData.uid || liveDoc.id;
        
        const hasActiveShift = activeShiftUserIds.has(liveUserId);
        const isPlaceholder = !liveData.status || !liveData.clockInTime;
        
        const clockInTime = liveData.clockInTime || liveData.statusStartTime;
        const clockInMs = clockInTime ? new Date(clockInTime).getTime() : 0;
        const isExtended = !!(liveData.sessionExtended || liveData.extended || liveData.isExtended);
        const isTooOld = clockInMs > 0 && (now - clockInMs) >= 12 * 60 * 60 * 1000 && !isExtended;
 
        // New: Check heartbeat recency to prevent deleting sessions that just resurrected
        // Safe threshold: 4 hours (14400000 ms) instead of 5 minutes to prevent deleting active users with hidden/inactive/unfocused tabs
        const lastHb = liveData.lastHeartbeat ? new Date(liveData.lastHeartbeat).getTime() : 0;
        const isHbRecent = lastHb > 0 && (now - lastHb) < 4 * 60 * 60 * 1000; // 4 hours
 
        if ((!hasActiveShift && !isHbRecent) || isPlaceholder || (isTooOld && !isHbRecent)) {
          console.log(`[TMS CLEANUP] Ghost live session deleted for user ${liveUserId} (placeholder: ${isPlaceholder}, hasActiveShift: ${hasActiveShift}, isTooOld: ${isTooOld}, isHbRecent: ${isHbRecent})`);
          batch.delete(liveDoc.ref);
          ghostCount++;
        }
      });
      if (ghostCount > 0) {
        console.log(`[TMS CLEANUP] Queued deletion of ${ghostCount} ghost live sessions.`);
      }
    } catch (liveErr) {
      console.error('[TMS CLEANUP] Error checking ghost live sessions:', liveErr);
    }
  } else {
    console.log('[TMS CLEANUP] Skipping ghost live sessions check as current user is not a global admin.');
  }
  
  if (staleCount > 0) {
      await batch.commit();
      console.log(`[TMS CLEANUP] Successfully marked ${staleCount} stale sessions as AUTO_CLOSED.`);
      
      // Trigger attendance sync for all stale sessions
      for (const sh of staleShifts) {
          try {
              await syncShiftToAttendance(sh);
          } catch (syncErr) {
              console.error(`[TMS CLEANUP] Error syncing stale shift ${sh.id} to attendance:`, syncErr);
          }
      }
  } else {
      console.log('[TMS CLEANUP] No stale sessions found.');
  }
  } catch (err) {
    console.error('[TMS CLEANUP] Error in performTmsStaleSessionCleanup:', err);
  }
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

  // If shift is active and recent, do not attempt to auto-repair
  const isRecent = candidateHbMs > (Date.now() - 60 * 60 * 1000); // 1 hour
  if (isRecent && !isCompleted && !isAutoClosed) {
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
  
  return {
    ...sh,
    status: finalizedStatus,
    clockOutTime: trueClockOutISO || sh.clockInTime,
    activities: finalActivities,
    repaired: true
  };
};

/**
 * Scans all historical shifts in Firestore and repairs backdated AUTO_CLOSED records,
 * setting true clock-out times and fixing productive & break duration metrics.
 */
export const bulkRepairBackdatedShifts = async (): Promise<{ repairedCount: number; totalExamined: number }> => {
  const currentUser = auth.currentUser;
  if (!currentUser) return { repairedCount: 0, totalExamined: 0 };

  const cleanUndefined = (obj: any): any => {
    if (obj === undefined) return null;
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(cleanUndefined);
    const cleaned: any = {};
    for (const key of Object.keys(obj)) {
      const val = cleanUndefined(obj[key]);
      if (val !== undefined) {
        cleaned[key] = val;
      }
    }
    return cleaned;
  };

  let isSupervisor = currentUser.email?.toLowerCase() === 'mayank.semwal@bergtechnologies.co.in';
  if (!isSupervisor) {
    try {
      const empSnap = await getDoc(doc(db, 'employee_master', currentUser.uid));
      if (empSnap.exists() && isSupervisorOrManagerRole(empSnap.data()?.role)) {
        isSupervisor = true;
      } else {
        const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
        if (userSnap.exists() && isSupervisorOrManagerRole(userSnap.data()?.role)) {
          isSupervisor = true;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  if (!isSupervisor) {
    console.log('[TMS CLEANUP] Non-supervisor user skipped org-wide bulk repair.');
    return { repairedCount: 0, totalExamined: 0 };
  }

  console.log('[TMS CLEANUP] Starting backdated shifts audit and repair...');
  try {
    // Fetch users map for lastLogoutAt & lastHeartbeat
    const usersSnap = await getDocsOptimized(query(collection(db, 'users')), 'tms_cleanup_users_map', true);
    const userMap = new Map<string, any>();
    usersSnap.forEach(uDoc => userMap.set(uDoc.id, uDoc.data()));

    // Fetch live_sessions map
    const liveSnap = await getDocsOptimized(query(collection(db, 'live_sessions')), 'tms_cleanup_live_map', true);
    const liveMap = new Map<string, any>();
    liveSnap.forEach(lDoc => liveMap.set(lDoc.id, lDoc.data()));

    const qAll = query(collection(db, 'tmsShifts'));
    const snap = await getDocsOptimized(qAll, 'tms_cleanup_bulk_repair', true);
    
    let repairedCount = 0;
    let batch = writeBatch(db);
    let batchOperationCount = 0;
    
    for (const shDoc of snap.docs) {
      const rawData = shDoc.data();
      const rawShift = { id: shDoc.id, ...rawData } as any;
      const isLockedOrDone = isShiftLockedOrCompleted(rawShift);

      if (shouldSkipShiftUpdate(rawShift, 'bulkRepairBackdatedShifts')) {
        continue;
      }

      const isManual = isManuallyCompleted(rawShift.status);

      if (!isManual) {
        const uData = userMap.get(rawShift.userId);
        const lData = liveMap.get(rawShift.userId) || liveMap.get(rawShift.id);
        const userLastHb = lData?.lastHeartbeat || uData?.lastLogoutAt || uData?.lastHeartbeat || null;

        const repaired = repairAndNormalizeShift(rawShift, userLastHb);
        
        // Check if anything changed
        const clockOutChanged = repaired.clockOutTime !== rawShift.clockOutTime;
        const statusChanged = repaired.status !== rawShift.status;
        const lastActNeedsEnd = false; // Immutable ledger: no longer check or enforce endTime

        if (clockOutChanged || statusChanged || lastActNeedsEnd) {
          repairedCount++;
          const updatedLedger = appendShiftEvent(
            rawShift.shiftEventLedger,
            rawShift,
            {
              eventType: 'ATTENDANCE_REPAIR',
              timestamp: new Date().toISOString(),
              performedBy: 'System Cleanup Service',
              source: 'Cleanup Service',
              reason: 'Repaired backdated clock-out info during bulk audit',
              oldValue: rawShift.clockOutTime || 'MISSING',
              newValue: repaired.clockOutTime,
              remarks: 'Auto-aligned activities chronologically to heal gaps/overlaps.'
            }
          );

          batch.update(shDoc.ref, cleanUndefined({
            status: repaired.status,
            clockOutTime: repaired.clockOutTime,
            activities: repaired.activities,
            shiftEventLedger: updatedLedger as any,
            remarks: rawShift.remarks ? `${rawShift.remarks} (Repaired)` : 'Repaired backdated clock-out info'
          }));

          // Ensure user status is set to OFFLINE if this was their latest shift
          if (rawShift.userId) {
            const userRef = doc(db, 'users', rawShift.userId);
            batch.set(userRef, {
              status: 'OFFLINE',
              lastLogoutAt: repaired.clockOutTime
            }, { merge: true });
          }

          batchOperationCount += 2;

          if (batchOperationCount >= 400) {
            await batch.commit();
            batch = writeBatch(db);
            batchOperationCount = 0;
          }
        }
      }
    }

    if (batchOperationCount > 0) {
      await batch.commit();
    }

    console.log(`[TMS CLEANUP] Completed backdated repair: Repaired ${repairedCount} of ${snap.docs.length} shifts.`);
    return { repairedCount, totalExamined: snap.docs.length };
  } catch (err) {
    console.error('[TMS CLEANUP] Error in bulkRepairBackdatedShifts:', err);
    return { repairedCount: 0, totalExamined: 0 };
  }
};

/**
 * NEW: Forensic Duplicate & Ghost Shift Cleanup
 * Scans for same-day sessions and merges them into a single chronological record.
 * Eliminates "Ghost Shifts" (duration < 5 mins with no productive activity).
 */
export const performTmsDuplicateShiftCleanup = async (targetUserId?: string) => {
  console.log(`[TMS FORENSIC] Starting duplicate and ghost shift cleanup${targetUserId ? ` for user ${targetUserId}` : ''}...`);
  
  try {
    const q = targetUserId 
      ? query(collection(db, 'tmsShifts'), where('userId', '==', targetUserId))
      : query(collection(db, 'tmsShifts'));
    
    const snap = await getDocs(q);
    const userShiftsMap = new Map<string, any[]>();
    
    snap.forEach(docSnap => {
      const sh = { id: docSnap.id, ...docSnap.data() } as any;
      const uid = sh.userId;
      if (!uid) return;
      if (!userShiftsMap.has(uid)) userShiftsMap.set(uid, []);
      userShiftsMap.get(uid)?.push(sh);
    });

    let totalMerged = 0;
    let totalDeleted = 0;

    for (const [uid, shifts] of userShiftsMap.entries()) {
      // Group shifts by date (YYYY-MM-DD)
      const dateGroups = new Map<string, any[]>();
      shifts.forEach(sh => {
        if (!sh.clockInTime) return;
        const dateKey = sh.clockInTime.substring(0, 10);
        if (!dateGroups.has(dateKey)) dateGroups.set(dateKey, []);
        dateGroups.get(dateKey)?.push(sh);
      });

      const batch = writeBatch(db);
      let batchCount = 0;

      for (const [date, group] of dateGroups.entries()) {
        if (group.length <= 1) continue;

        // Sort by clock-in time
        const sorted = group.sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());
        
        // 1. Identify Ghosts (duration < 5 mins AND productive < 1 min)
        const ghosts = sorted.filter(sh => {
          const start = new Date(sh.clockInTime).getTime();
          const end = sh.clockOutTime ? new Date(sh.clockOutTime).getTime() : start;
          const durationMins = (end - start) / 60000;
          
          let prodMins = 0;
          (sh.activities || []).forEach((act: any) => {
            if (act.type === 'productive' || act.name === 'Active Work') {
              const aStart = new Date(act.startTime).getTime();
              const aEnd = act.endTime ? new Date(act.endTime).getTime() : aStart;
              prodMins += (aEnd - aStart) / 60000;
            }
          });
          
          return durationMins < 5 && prodMins < 1;
        });

        const nonGhosts = sorted.filter(sh => !ghosts.some(g => g.id === sh.id));

        // 2. Delete Ghosts immediately
        ghosts.forEach(g => {
          batch.delete(doc(db, 'tmsShifts', g.id));
          batchCount++;
          totalDeleted++;
          console.log(`[TMS FORENSIC] Deleting ghost shift ${g.id} for user ${uid} on ${date}`);
        });

        // 3. Merge remaining non-ghost duplicates if they are on the same day
        if (nonGhosts.length > 1) {
          const primary = nonGhosts[0];
          const secondaries = nonGhosts.slice(1);
          
          let mergedActivities = [...(primary.activities || [])];
          let mergedLedger = [...(primary.shiftEventLedger || [])];
          let latestEndISO = primary.clockOutTime || primary.clockInTime;

          secondaries.forEach(sec => {
            // Append activities
            const secActs = (sec.activities || []).map((act: any) => ({
              ...act,
              mergedFrom: sec.id,
              mergedAt: new Date().toISOString()
            }));
            mergedActivities = [...mergedActivities, ...secActs];

            // Append ledger events
            const secLedger = (sec.shiftEventLedger || []).map((ev: any) => ({
              ...ev,
              mergedFrom: sec.id
            }));
            mergedLedger = [...mergedLedger, ...secLedger];

            // Track latest clock out
            if (sec.clockOutTime && new Date(sec.clockOutTime).getTime() > new Date(latestEndISO).getTime()) {
              latestEndISO = sec.clockOutTime;
            }

            // Mark secondary for deletion
            batch.delete(doc(db, 'tmsShifts', sec.id));
            batchCount++;
            totalDeleted++;
            totalMerged++;
            console.log(`[TMS FORENSIC] Merging shift ${sec.id} into primary ${primary.id} for user ${uid} on ${date}`);
          });

          // Sort activities chronologically
          mergedActivities.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

          // Finalize primary shift
          const metrics = calculateShiftFinalMetrics(
            { ...primary, activities: mergedActivities },
            latestEndISO
          );

          batch.update(doc(db, 'tmsShifts', primary.id), {
            activities: mergedActivities,
            shiftEventLedger: mergedLedger,
            clockOutTime: latestEndISO,
            endShiftTime: latestEndISO,
            ...metrics,
            remarks: (primary.remarks || '') + ` (Auto-merged ${secondaries.length} session(s))`
          });
          batchCount++;
        }

        if (batchCount >= 450) {
          await batch.commit();
          console.log(`[TMS FORENSIC] Committed batch for user ${uid}`);
        }
      }
      
      if (batchCount > 0) {
        await batch.commit();
      }
    }

    console.log(`[TMS FORENSIC] Cleanup complete. Deleted ${totalDeleted} shifts (including ${totalMerged} merges).`);
    return { totalMerged, totalDeleted };
  } catch (err) {
    console.error('[TMS FORENSIC] Cleanup error:', err);
    return { totalMerged: 0, totalDeleted: 0 };
  }
};

