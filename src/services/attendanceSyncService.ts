import { db } from '../lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

export async function syncShiftToAttendance(shift: any) {
  try {
    const attDocRef = doc(db, 'attendanceSummary', shift.id);
    
    // Always regenerate from tmsShifts - removed first-write-wins (existing.exists() return)
    
    const confSnap = await getDoc(doc(db, 'config', 'attendanceSettings'));
    let config = { presentThreshold: 480, halfDayThreshold: 240, countBreakTime: false };
    if (confSnap.exists()) {
      const c = confSnap.data();
      config = {
        presentThreshold: c.presentThreshold ?? 480,
        halfDayThreshold: c.halfDayThreshold ?? 240,
        countBreakTime: c.countBreakTime ?? false
      };
    }

    const startMs = new Date(shift.clockInTime).getTime();
    const endMs = shift.clockOutTime ? new Date(shift.clockOutTime).getTime() : startMs;

    // Calculate logical work date: shifts starting between 00:00 and 04:00 belong to previous day
    const logicalDate = new Date(startMs - 4 * 60 * 60 * 1000);
    const dateStr = logicalDate.toISOString().split('T')[0];

    let prodMs = 0;
    let breakMs = 0;
    (shift.activities || []).forEach((act: any) => {
      const aStart = new Date(act.startTime).getTime();
      const aEnd = act.endTime ? new Date(act.endTime).getTime() : endMs;
      const dur = Math.max(0, aEnd - aStart);
      const actName = (act.name || '').toLowerCase();
      const isProductive = act.type === 'productive' || 
                   ['meeting', 'coaching', 'training', 'alignment'].some(k => (act.name || '').toLowerCase().includes(k));
      if (isProductive) prodMs += dur;
      else breakMs += dur;
    });

    let totalMins = Math.floor(prodMs / 60000);
    if (config.countBreakTime) {
      totalMins += Math.floor(breakMs / 60000);
    }

    let status = 'Absent';
    if (totalMins >= config.presentThreshold) status = 'Present';
    else if (totalMins >= config.halfDayThreshold) status = 'Half Day';

    const isOvernight = shift.clockOutTime ? (shift.clockInTime.split('T')[0] !== shift.clockOutTime.split('T')[0]) : false;

    const summary = {
      id: shift.id,
      shiftId: shift.id,
      userId: shift.userId,
      employeeName: shift.userName || shift.userEmail,
      employeeEmail: shift.userEmail,
      process: shift.process || 'N/A',
      mappedTL: shift.mappedTL || 'N/A',
      mappedManager: shift.mappedManager || 'N/A',
      attendanceDate: dateStr,
      attendanceStatus: status,
      productiveMinutes: totalMins,
      totalBreakMinutes: Math.floor(breakMs / 60000),
      sessionStart: shift.clockInTime,
      sessionEnd: shift.clockOutTime || shift.clockInTime,
      generatedBySystem: true,
      isOvernight
    };

    await setDoc(attDocRef, summary, { merge: true });
  } catch (error) {
    console.error('Failed to sync attendance for shift:', shift.id, error);
  }
}
