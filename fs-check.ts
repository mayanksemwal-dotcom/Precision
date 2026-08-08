import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

async function check() {
  try {
    const docRef = db.collection('config').doc('master');
    const doc = await docRef.get();
    console.log("Success! Admin DB access works. Exists:", doc.exists);
    process.exit(0);
  } catch (e: any) {
    console.error("Failed Admin DB access:", e.message);
    process.exit(1);
  }
}
check();
