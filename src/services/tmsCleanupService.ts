import { db } from '../lib/firebase';
import { collection, query, where, getDocs, updateDoc, doc, writeBatch } from 'firebase/firestore';
import { syncShiftToAttendance } from './attendanceSyncService';

export const performTmsTenHourForceOut = async () => {
  console.log('[TMS CLEANUP] Checking for shifts exceeding 10 hours of productive time...');
  const now = new Date().getTime();
  const TEN_HOURS_MS = 10 * 60 * 60 * 1000;

  // Query all active and break shifts across all users
  const q = query(collection(db, 'tmsShifts'), where('status', 'in', ['ACTIVE', 'BREAK']));
  try {
    const snap = await getDocs(q);
    const batch = writeBatch(db);
    let forceOutCount = 0;
    const finalizedShifts: any[] = [];

    snap.forEach((shDoc) => {
      const sh = { id: shDoc.id, ...shDoc.data() } as any;
      
      // Calculate productive time
      let productiveMs = 0;
      const activities = sh.activities || [];
      activities.forEach((act: any) => {
        const actStart = new Date(act.startTime).getTime();
        const actEnd = act.endTime ? new Date(act.endTime).getTime() : now;
        const duration = Math.max(0, actEnd - actStart);
        const actName = (act.name || '').toLowerCase();
        const isProductive = act.type === 'productive' || 
                             actName.includes('meeting') || 
                             actName.includes('coaching') || 
                             actName.includes('training') || 
                             actName.includes('alignment');
        if (isProductive) {
          productiveMs += duration;
        }
      });

      if (productiveMs >= TEN_HOURS_MS) {
        console.log(`[TMS CLEANUP] Shift ${sh.id} of user ${sh.userName} has exceeded 10 hours productive time (${(productiveMs / 3600000).toFixed(2)}h). Automatically forcing clock out...`);
        
        // Truncate to exactly 10 hours productive time
        let accumulatedProductive = 0;
        const updatedActivities: any[] = [];
        let exactEndISO = sh.clockOutTime || new Date().toISOString();

        for (const act of activities) {
          const actStart = new Date(act.startTime).getTime();
          const actEnd = act.endTime ? new Date(act.endTime).getTime() : now;
          const duration = Math.max(0, actEnd - actStart);

          const actName = (act.name || '').toLowerCase();
          const isProductive = act.type === 'productive' || 
                               actName.includes('meeting') || 
                               actName.includes('coaching') || 
                               actName.includes('training') || 
                               actName.includes('alignment');

          if (isProductive) {
            if (accumulatedProductive + duration >= TEN_HOURS_MS) {
              const remainingNeeded = TEN_HOURS_MS - accumulatedProductive;
              const exactEndMs = actStart + remainingNeeded;
              exactEndISO = new Date(exactEndMs).toISOString();
              
              updatedActivities.push({
                ...act,
                endTime: exactEndISO
              });
              accumulatedProductive = TEN_HOURS_MS;
              break;
            } else {
              updatedActivities.push(act);
              accumulatedProductive += duration;
            }
          } else {
            const breakStart = new Date(act.startTime).getTime();
            if (accumulatedProductive >= TEN_HOURS_MS || breakStart >= new Date(exactEndISO).getTime()) {
              break;
            }
            updatedActivities.push(act);
          }
        }

        if (updatedActivities.length > 0) {
          const lastIndex = updatedActivities.length - 1;
          if (!updatedActivities[lastIndex].endTime) {
            updatedActivities[lastIndex].endTime = exactEndISO;
          }
        }

        const finalizedShift = {
          ...sh,
          activities: updatedActivities,
          status: 'AUTO_CLOSED',
          clockOutTime: exactEndISO,
          remarks: 'Auto-clocked out after 10 hours productive time'
        };

        // Update shift
        batch.update(shDoc.ref, {
          activities: updatedActivities,
          status: 'AUTO_CLOSED',
          clockOutTime: exactEndISO,
          remarks: 'Auto-clocked out after 10 hours productive time'
        });

        // Update user status
        const userRef = doc(db, 'users', sh.userId);
        batch.update(userRef, {
          status: 'OFFLINE',
          lastLogoutAt: exactEndISO
        });

        // Remove live session
        const liveSessionRef = doc(db, 'live_sessions', sh.userId);
        batch.delete(liveSessionRef);

        // Audit Log (Firestore Logging Disabled)
        console.log('[AUDIT LOG] (Firestore Logging Disabled) Automated Force Logout:', {
          timestamp: new Date().toISOString(),
          performedBy: 'System Automated Force-Out Worker',
          affectedUser: `${sh.userName || 'Unknown'} (${sh.userId})`,
          action: 'Automated Force Logout',
          previousValue: 'ACTIVE_WORK',
          newValue: 'AUTO_CLOSED (10 Hours Limit Crossed)',
          details: { shiftId: sh.id, totalProductiveHours: (productiveMs / 3600000).toFixed(2) }
        });

        forceOutCount++;
        finalizedShifts.push(finalizedShift);
      }
    });

    if (forceOutCount > 0) {
      await batch.commit();
      console.log(`[TMS CLEANUP] Successfully force clocked out ${forceOutCount} users exceeding 10 hours productive limit.`);
      
      // Sync attendance summaries
      for (const sh of finalizedShifts) {
        try {
          await syncShiftToAttendance(sh);
        } catch (err) {
          console.error(`[TMS CLEANUP] Failed to sync attendance for ${sh.id}:`, err);
        }
      }
    } else {
      console.log('[TMS CLEANUP] No users found exceeding 10 hours productive limit.');
    }
  } catch (err) {
    console.error('[TMS CLEANUP] Error getting active/break shifts for 10-hour check:', err);
  }
};

export const performTmsStaleSessionCleanup = async () => {
  console.log('[TMS CLEANUP] Starting stale session cleanup...');
  const now = new Date().getTime();
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  
  // Query all non-completed sessions
  const q = query(collection(db, 'tmsShifts'), where('status', 'in', ['ACTIVE', 'BREAK']));
  const snap = await getDocs(q);
  
  const batch = writeBatch(db);
  let staleCount = 0;
  const staleShifts: any[] = [];
  
  snap.forEach((shDoc) => {
    const sh = shDoc.data();
    const clockInMs = new Date(sh.clockInTime).getTime();
    const elapsedShiftMs = now - clockInMs;
    
    // Determine last activity time
    const activities = sh.activities || [];
    const lastActivity = activities.length > 0 ? activities[activities.length - 1] : null;
    const lastActivityTime = lastActivity 
      ? new Date(lastActivity.endTime || lastActivity.startTime).getTime() 
      : clockInMs;
    const idleMs = now - lastActivityTime;
    
    const clockInDate = new Date(sh.clockInTime);
    const nowDate = new Date(now);
    const isDifferentDay = 
      clockInDate.getFullYear() !== nowDate.getFullYear() ||
      clockInDate.getMonth() !== nowDate.getMonth() ||
      clockInDate.getDate() !== nowDate.getDate();

    // Stale if running for more than 12 hours total, OR if it spans a calendar day and has been idle/active with no state change for 6+ hours
    const isStale = elapsedShiftMs >= TWELVE_HOURS_MS || (isDifferentDay && idleMs >= SIX_HOURS_MS);
    
    if (isStale) {
        const clockOutTime = new Date(lastActivityTime).toISOString();
        const updatedShift = {
            ...sh,
            id: shDoc.id,
            status: 'AUTO_CLOSED',
            clockOutTime,
            remarks: 'AUTO_CLOSED_STALE_SESSION'
        };
        batch.update(shDoc.ref, {
            status: 'AUTO_CLOSED',
            clockOutTime,
            remarks: 'AUTO_CLOSED_STALE_SESSION'
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
    }
  });
  
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
};
