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
  console.log(`Querying records for ${email}...`);
  
  try {
    const empSnap = await db.collection('employee_master').where('email', '==', email).get();
    if (empSnap.empty) {
      console.log('No document found in employee_master for email');
    } else {
      empSnap.forEach(doc => {
        console.log(`Found doc in employee_master: ID=${doc.id}`, doc.data());
      });
    }

    const userSnap = await db.collection('users').where('email', '==', email).get();
    if (userSnap.empty) {
      console.log('No document found in users for email');
    } else {
      userSnap.forEach(doc => {
        console.log(`Found doc in users: ID=${doc.id}`, doc.data());
      });
    }
  } catch (error) {
    console.error('Error querying:', error);
  }
}

run();
