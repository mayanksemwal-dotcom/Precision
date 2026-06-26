import { db } from '../lib/firebase';
import { collection, query, where, getDocs, updateDoc, doc, writeBatch } from 'firebase/firestore';
import { syncShiftToAttendance } from './attendanceSyncService';

export const performTmsStaleSessionCleanup = async () => {
  console.log('[TMS CLEANUP] Starting stale session cleanup...');
  const now = new Date().getTime();
  const twentyFourHours = 24 * 60 * 60 * 1000;
  
  // Query all non-completed sessions
  const q = query(collection(db, 'tmsShifts'), where('status', 'in', ['ACTIVE', 'BREAK']));
  const snap = await getDocs(q);
  
  const batch = writeBatch(db);
  let staleCount = 0;
  const staleShifts: any[] = [];
  
  snap.forEach((shDoc) => {
    const sh = shDoc.data();
    
    // Determine last activity time
    const activities = sh.activities || [];
    const lastActivity = activities.length > 0 ? activities[activities.length - 1] : null;
    const lastActivityTime = lastActivity 
      ? new Date(lastActivity.endTime || lastActivity.startTime).getTime() 
      : new Date(sh.clockInTime).getTime();
    
    if (now - lastActivityTime > twentyFourHours) {
        const clockOutTime = new Date().toISOString();
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
        staleCount++;
        staleShifts.push(updatedShift);
    }
  });
  
  if (staleCount > 0) {
      await batch.commit();
      console.log(`[TMS CLEANUP] Successfully marked ${staleCount} stale sessions as AUTO_CLOSED.`);
      
      // Trigger attendance sync for all stale sessions
      for (const sh of staleShifts) {
          await syncShiftToAttendance(sh);
      }
  } else {
      console.log('[TMS CLEANUP] No stale sessions found.');
  }
};
