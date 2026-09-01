const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const DB_ID = firebaseConfig.firestoreDatabaseId;

admin.initializeApp({
  projectId: firebaseConfig.projectId,
});

const db = DB_ID ? getFirestore(DB_ID) : getFirestore();

async function run() {
  const email = 'mukul.choudhary@bergtechnologies.co.in';
  console.log(`Starting backend Team Lead sync for ${email}...`);
  
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    const uid = userRecord.uid;
    console.log(`Resolved UID for ${email}: ${uid}`);

    // Update in employee_master
    const empRef = db.collection('employee_master').doc(uid);
    const empSnap = await empRef.get();
    if (empSnap.exists) {
      console.log('Current employee_master doc data:', empSnap.data());
      await empRef.update({
        role: 'TEAM_LEAD',
        roleName: 'TEAM_LEAD',
      });
      console.log('Updated role in employee_master');
    } else {
      console.log('Document in employee_master does not exist, creating it...');
      await empRef.set({
        uid,
        email,
        fullName: 'Mukul Choudhary',
        name: 'Mukul Choudhary',
        employeeName: 'Mukul Choudhary',
        role: 'TEAM_LEAD',
        roleName: 'TEAM_LEAD',
        status: 'ACTIVE',
        process: 'Operations',
      }, { merge: true });
      console.log('Created and set role to TEAM_LEAD in employee_master');
    }

    // Update in users
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
      console.log('Current users doc data:', userSnap.data());
      await userRef.update({
        role: 'TEAM_LEAD',
        roleName: 'TEAM_LEAD',
      });
      console.log('Updated role in users');
    } else {
      console.log('Document in users does not exist, creating it...');
      await userRef.set({
        uid,
        email,
        fullName: 'Mukul Choudhary',
        name: 'Mukul Choudhary',
        employeeName: 'Mukul Choudhary',
        role: 'TEAM_LEAD',
        roleName: 'TEAM_LEAD',
        status: 'ACTIVE',
        process: 'Operations',
      }, { merge: true });
      console.log('Created and set role to TEAM_LEAD in users');
    }

    // Compute claims
    const claims = {
      role: 'TEAM_LEAD',
      isAdmin: false,
      isManager: false,
      isSupervisor: false,
      isTeamLead: true,
      isTL: true,
      isQA: false,
      isITEngineer: false,
    };

    await admin.auth().setCustomUserClaims(uid, claims);
    console.log('Successfully set Custom User Claims for Mukul:', claims);

    console.log('Backend sync completed successfully!');
  } catch (error) {
    console.error('Error during backend sync:', error);
  }
}

run();
