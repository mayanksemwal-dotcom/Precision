import { readFileSync, writeFileSync } from 'fs';

const file = 'src/components/tms/SupervisorDashboard.tsx';
let content = readFileSync(file, 'utf-8');

// Line 1307: setDoc(doc(db, 'tmsShifts', myShift.id), updatedShift),
content = content.replace(
  /setDoc\(doc\(db, 'tmsShifts', myShift.id\), updatedShift\),/g,
  `updateDoc(doc(db, 'tmsShifts', myShift.id), {
          activities: updatedActivities,
          status: updatedShift.status,
          currentActivity: updatedShift.currentActivity,
          hasMobilePunches: updatedShift.hasMobilePunches,
          sessionExtended: updatedShift.sessionExtended
        }),`
);

writeFileSync(file, content, 'utf-8');
console.log("Replaced setDoc with updateDoc in SupervisorDashboard.tsx");
