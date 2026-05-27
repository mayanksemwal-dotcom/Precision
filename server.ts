import express from 'express';
import path from 'path';
import fs from 'fs';
import * as admin from 'firebase-admin';
import { createServer as createViteServer } from 'vite';

// Load firebase-applet-config dynamically
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Configure environment variable for specific database ID
process.env.FIRESTORE_DATABASE = firebaseConfig.firestoreDatabaseId;

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

const app = express();
const PORT = 3000;

app.use(express.json());

// API Route: Set Custom User Claims
app.post('/api/set-claims', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    const uid = decodedToken.uid;

    // Fetch user profile from Firestore to determine their role
    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    let role = 'AGENT';
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData && userData.role) {
        role = userData.role;
      }
    }

    // Assign claims
    const isAdmin = role === 'ADMIN';
    const isQA = role === 'QA';

    await admin.auth().setCustomUserClaims(uid, {
      isAdmin,
      isQA,
    });

    console.log(`Successful claims synchronization for uid: ${uid}. Role: ${role}. Claims: isAdmin=${isAdmin}, isQA=${isQA}`);

    return res.json({
      status: 'success',
      role,
      claims: { isAdmin, isQA }
    });
  } catch (error) {
    console.error('Error in /api/set-claims:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Full-Stack dev server running on port ${PORT}`);
  });
}

start();
