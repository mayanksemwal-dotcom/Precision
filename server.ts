import express from 'express';
import path from 'path';
import fs from 'fs';
import * as admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { createServer as createViteServer } from 'vite';

// Load firebase-applet-config dynamically
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const DB_ID = firebaseConfig.firestoreDatabaseId;

// Synchronize uploaded original attached logo with public/berg_logo.png on startup
try {
  const sourceLogo = path.join(process.cwd(), 'src/assets/images/berg_logo_1780903600604.png');
  const targetLogo = path.join(process.cwd(), 'public/berg_logo.png');
  if (fs.existsSync(sourceLogo)) {
    fs.copyFileSync(sourceLogo, targetLogo);
    console.log('[LOGO SYNC] Replicated original attached PNG to public/berg_logo.png');
  } else {
    console.warn('[LOGO SYNC] Source original logo file not found in assets, skipping sync.');
  }
} catch (logoErr) {
  console.error('[LOGO SYNC] Error copying original logo:', logoErr);
}

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

// Helper to get Firestore client for specific database
const db = DB_ID ? getFirestore(DB_ID) : getFirestore();

const app = express();
const PORT = 3000;

app.use(express.json());

// Request logging for API routes
app.use('/api', (req, res, next) => {
  console.log(`[API REQUEST LOG] Time: ${new Date().toISOString()}, Method: ${req.method}, Path: ${req.url}, Content-Type: ${req.headers['content-type']}`);
  next();
});

// Helper for chunked batch writes
async function commitInChunks(items: any[], operation: (batch: admin.firestore.WriteBatch, item: any) => void) {
  const CHUNK_SIZE = 450; // Firestore limit is 500, using safer margin
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const batch = db.batch();
    chunk.forEach(item => operation(batch, item));
    await batch.commit();
    console.log(`[BATCH COMMIT] Chunk committed: ${i} to ${Math.min(i + CHUNK_SIZE, items.length)}`);
  }
}

async function start() {
  // --- API ROUTES ---
  app.use('/api', (req, res, next) => {
    console.log(`[EXPRESS API LOG] Request: ${req.method} ${req.url}`);
    next();
  });

  // Health check endpoint (defined early)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date(), dbId: DB_ID });
  });

  // API Route: Set Custom User Claims
  app.post('/api/set-claims', async (req, res) => {
    console.log('[DEBUG API] /api/set-claims matched');
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
      }
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      const uid = decodedToken.uid;

      const userDoc = await db.collection('users').doc(uid).get();
      const role = (userDoc.exists ? (userDoc.data()?.role || 'AGENT') : 'AGENT').toUpperCase();
      
      // Assign claims
      const isAdminFlag = role === 'ADMIN' || decodedToken.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in';
      const isQAFlag = role === 'QA';

      try {
        await admin.auth().setCustomUserClaims(uid, {
          isAdmin: isAdminFlag,
          isQA: isQAFlag,
        });
        console.log(`Successful claims synchronization for uid: ${uid}. Role: ${role}.`);
      } catch (claimErr: any) {
        console.warn(`Could not set custom auth claims for uid ${uid}. Proceeding with just Firestore Role flag. Reason:`, claimErr.message || String(claimErr));
      }

      return res.json({
        status: 'success',
        role,
        claims: { isAdmin: isAdminFlag, isQA: isQAFlag },
        warning: 'Claims might only be available locally via Firestore due to IAM permissions'
      });
    } catch (error) {
      console.error('Error in /api/set-claims:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // API Route: Create user in Firebase Auth and pre-populate Firestore database
  app.post('/api/create-user', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
      }
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      const requesterUid = decodedToken.uid;

      // Fetch user profile from Firestore to determine if they are an admin or manager
      const requesterDoc = await db.collection('users').doc(requesterUid).get();
      let isPrivileged = false;
      if (requesterDoc.exists) {
        const data = requesterDoc.data();
        const r = (data?.role || '').toUpperCase();
        isPrivileged = r === 'ADMIN' || r === 'MANAGER';
      }
      if (decodedToken.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') {
        isPrivileged = true;
      }

      if (!isPrivileged) {
        return res.status(403).json({ error: 'Forbidden: Admin or Manager role required' });
      }

      const { name, email, role, teamLeadId, teamLeadName, mappedManagerId, mappedManagerName, password } = req.body;
      const emailLower = (email || '').toLowerCase().trim();
      if (!name || !emailLower) {
        return res.status(400).json({ error: 'Name and email are required.' });
      }

      let authUser;
      let wasCreatedInAuth = false;
      let targetUid = 'local_' + Buffer.from(emailLower).toString('base64').replace(/=/g, '').slice(0, 12);
      
      try {
        authUser = await admin.auth().getUserByEmail(emailLower);
        targetUid = authUser.uid;
      } catch (authErr: any) {
        if (authErr.code === 'auth/user-not-found') {
          if (!password) {
            return res.status(400).json({ error: 'Password is required for new email accounts.' });
          }
          try {
            authUser = await admin.auth().createUser({
              email: emailLower,
              displayName: name,
              password: password,
            });
            targetUid = authUser.uid;
            wasCreatedInAuth = true;
          } catch (createErr) {
            console.warn(`Could not create Auth user for ${emailLower}, falling back to local provision.`, createErr);
          }
        } else {
          console.warn(`Could not fetch Auth user for ${emailLower}, falling back to local provision.`, authErr);
        }
      }

      const userDocRef = db.collection('users').doc(targetUid);
      const userProfile = {
        uid: targetUid,
        name: name,
        email: emailLower,
        role: role || 'AGENT',
        status: 'Active',
        department: 'Operations',
        createdAt: new Date().toISOString(),
        ...(teamLeadId ? { teamLeadId, teamLeadName: teamLeadName || '' } : {}),
        ...(mappedManagerId ? { mappedManagerId, mappedManagerName: mappedManagerName || '' } : {})
      };

      await userDocRef.set(userProfile, { merge: true });

      // Also update employee_master
      const masterDocRef = db.collection('employee_master').doc(targetUid);
      await masterDocRef.set(userProfile, { merge: true });

      return res.json({ status: 'success', user: userProfile, wasCreatedInAuth });
    } catch (error) {
      console.error('Error in /api/create-user:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // API Route: Bulk Create users in Firebase Auth and pre-populate Firestore database
  app.post('/api/bulk-create-users', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
      }
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      const requesterUid = decodedToken.uid;

      // Fetch user profile from Firestore to determine if they are an admin or manager
      const requesterDoc = await db.collection('users').doc(requesterUid).get();
      let isPrivileged = false;
      if (requesterDoc.exists) {
        const data = requesterDoc.data();
        const r = (data?.role || '').toUpperCase();
        isPrivileged = r === 'ADMIN' || r === 'MANAGER';
      }
      if (decodedToken.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') {
        isPrivileged = true;
      }

      if (!isPrivileged) {
        return res.status(403).json({ error: 'Forbidden: Admin or Manager role required' });
      }

      const { users } = req.body;
      if (!Array.isArray(users)) {
        return res.status(400).json({ error: 'Expected an array of users' });
      }

      const createdUsers = [];
      const errors = [];

      for (const userData of users) {
        const { name, email, role, department, process, teamLeadId, teamLeadName, mappedManagerId, mappedManagerName, password } = userData;
        const emailLower = (email || '').toLowerCase().trim();
        if (!name || !emailLower) {
          errors.push({ email, error: 'Name and email are required.' });
          continue;
        }

        let authUser;
        let wasCreatedInAuth = false;
        let targetUid = 'local_' + Buffer.from(emailLower).toString('base64').replace(/=/g, '').slice(0, 12);
        let errorReported = null;

        try {
          authUser = await admin.auth().getUserByEmail(emailLower);
          targetUid = authUser.uid;
        } catch (authErr: any) {
          if (authErr.code === 'auth/user-not-found') {
            const actualPassword = password || 'Password360@';
            try {
              authUser = await admin.auth().createUser({
                email: emailLower,
                displayName: name,
                password: actualPassword,
              });
              targetUid = authUser.uid;
              wasCreatedInAuth = true;
            } catch (createErr: any) {
              errorReported = createErr.message || String(createErr);
              console.warn(`Could not create Auth user for ${emailLower}, falling back to local provision.`, errorReported);
            }
          } else {
             errorReported = authErr.message || String(authErr);
             console.warn(`Could not fetch Auth user for ${emailLower}, falling back to local provision.`, errorReported);
          }
        }

        const userDocRef = db.collection('users').doc(targetUid);
        const userProfile = {
          uid: targetUid,
          name: name,
          fullName: name,
          email: emailLower,
          role: role || 'AGENT',
          status: 'Active',
          department: department || 'Operations',
          process: process || '',
          createdAt: new Date().toISOString(),
          ...(teamLeadId ? { teamLeadId, teamLeadName: teamLeadName || '' } : {}),
          ...(mappedManagerId ? { mappedManagerId, mappedManagerName: mappedManagerName || '' } : {})
        };

        await userDocRef.set(userProfile, { merge: true });

        // Also update employee_master
        const masterDocRef = db.collection('employee_master').doc(targetUid);
        await masterDocRef.set({
          employeeName: name,
          email: emailLower,
          role: role || 'AGENT',
          department: department || 'Operations',
          process: process || '',
          status: 'Active',
          createdAt: new Date().toISOString(),
          ...userProfile
        }, { merge: true });

        createdUsers.push({ email: emailLower, uid: targetUid, wasCreatedInAuth });
      }

      return res.json({ status: 'success', createdUsers, errors });
    } catch (error) {
      console.error('Error in /api/bulk-create-users:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // API Route: Sync Firebase Auth users to Firestore
  app.post('/api/sync-users', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
      }
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      const uid = decodedToken.uid;

      const requesterDoc = await db.collection('users').doc(uid).get();
      let isPrivileged = false;
      if (requesterDoc.exists) {
        const data = requesterDoc.data();
        const r = (data?.role || '').toUpperCase();
        isPrivileged = r === 'ADMIN' || r === 'MANAGER';
      }
      if (decodedToken.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') {
        isPrivileged = true;
      }

      if (!isPrivileged) {
        return res.status(403).json({ error: 'Forbidden: Admin or Manager role required' });
      }

      const listUsersResult = await admin.auth().listUsers(1000);
      const authUsers = listUsersResult.users;

      const usersSnap = await db.collection('users').get();
      const existingUids = new Set(usersSnap.docs.map(doc => doc.id));
      const existingEmails = new Set(usersSnap.docs.map(doc => (doc.data().email || '').toLowerCase().trim()));

      const missingUsers = authUsers.filter(authUser => {
        const email = (authUser.email || '').toLowerCase().trim();
        return email && !existingUids.has(authUser.uid) && !existingEmails.has(email);
      });

      if (missingUsers.length > 0) {
        await commitInChunks(missingUsers, (batch, authUser) => {
          const email = (authUser.email || '').toLowerCase().trim();
          const userProfile = {
            uid: authUser.uid,
            name: authUser.displayName || email.split('@')[0],
            email: email,
            role: email === 'mayank.semwal@bergtechnologies.co.in' ? 'ADMIN' : 'AGENT',
            status: 'Active'
          };
          const udocRef = db.collection('users').doc(authUser.uid);
          batch.set(udocRef, userProfile, { merge: true });
          
          // Also sync to employee_master to maintain consistency with the roster dashboard
          const masterDocRef = db.collection('employee_master').doc(authUser.uid);
          batch.set(masterDocRef, {
            ...userProfile,
            status: 'Active',
            department: 'Operations',
            createdAt: new Date().toISOString()
          }, { merge: true });
        });
      }

      return res.json({
        status: 'success',
        syncedCount: missingUsers.length,
        totalAuthUsers: authUsers.length
      });
    } catch (error) {
      console.error('Error in /api/sync-users:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Catch-all for undefined /api routes
  app.all('/api/*', (req, res) => {
    console.warn(`[API 404] No route matched: ${req.method} ${req.url}`);
    res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
  });

  // --- VITE / SPA FALLBACK ---
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

  // Global error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('[Global Error Handler]', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Full-Stack dev server running on port ${PORT} (DB: ${DB_ID})`);
  });
}

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

start();
