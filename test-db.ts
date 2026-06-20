import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';

async function run() {
  try {
    const config = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
    console.log('Project ID:', config.projectId);
    console.log('Database ID:', config.firestoreDatabaseId);

    initializeApp({
      projectId: config.projectId,
    });

    const db = getFirestore(undefined, config.firestoreDatabaseId);
    
    console.log('Fetching latest shifts from tmsShifts collection...');
    const snapshot = await db.collection('tmsShifts')
      .orderBy('loginTimestamp', 'desc')
      .limit(5)
      .get();

    if (snapshot.empty) {
      console.log('No documents found in tmsShifts using loginTimestamp desc. Trying standard fetch...');
      const fallbackSnapshot = await db.collection('tmsShifts')
        .limit(10)
        .get();
        
      if (fallbackSnapshot.empty) {
        console.log('No documents found in tmsShifts at all.');
      } else {
        fallbackSnapshot.docs.forEach((doc, idx) => {
          console.log(`\nDoc ${idx + 1} ID:`, doc.id);
          console.log(JSON.stringify(doc.data(), null, 2));
        });
      }
    } else {
      snapshot.docs.forEach((doc, idx) => {
        console.log(`\nDoc ${idx + 1} ID:`, doc.id);
        console.log(JSON.stringify(doc.data(), null, 2));
      });
    }
  } catch (error) {
    console.error('Error in test-db.ts:', error);
  }
}

run();
