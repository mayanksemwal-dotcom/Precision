import admin from 'firebase-admin';

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

async function check() {
  try {
    const list = await admin.auth().listUsers(10);
    console.log("Success! Found users:", list.users.length);
  } catch (e: any) {
    console.error("Failed:", e.message);
  }
}
check();
