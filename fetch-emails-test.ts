import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { getFirestore } from 'firebase-admin/firestore';

const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const DB_ID = firebaseConfig.firestoreDatabaseId;

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

const firestore = DB_ID ? getFirestore(DB_ID) : getFirestore();

async function run() {
  console.log('--- FIRESTORE EMAIL DIAGNOSTICS ---');
  console.log('Project ID:', firebaseConfig.projectId);
  console.log('Database ID:', DB_ID);

  try {
    // 1. Fetch last 5 in 'emails' collection
    console.log('\n--- LAST 5 IN "emails" COLLECTION ---');
    const emailsSnap = await firestore.collection('emails').orderBy('createdAt', 'desc').limit(5).get();
    if (emailsSnap.empty) {
      console.log('No documents found in "emails" collection.');
    } else {
      emailsSnap.forEach(doc => {
        console.log(`Document ID: ${doc.id}`);
        console.log('Data:', JSON.stringify(doc.data(), null, 2));
      });
    }

    // 2. Fetch last 5 in 'mail' collection
    console.log('\n--- LAST 5 IN "mail" COLLECTION ---');
    const mailSnap = await firestore.collection('mail').orderBy('createdAt', 'desc').limit(5).get();
    if (mailSnap.empty) {
      console.log('No documents found in "mail" collection.');
    } else {
      mailSnap.forEach(doc => {
        console.log(`Document ID: ${doc.id}`);
        console.log('Data:', JSON.stringify(doc.data(), null, 2));
      });
    }

  } catch (err) {
    console.error('Error during diagnostics:', err);
  }
}

run();
