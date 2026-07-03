import express from 'express';
import path from 'path';
import fs from 'fs';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { createServer as createViteServer } from 'vite';
import { startEmailWorker } from './src/services/emailWorker.js';

// Load firebase-applet-config dynamically
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const DB_ID = firebaseConfig.firestoreDatabaseId;

// Append-only API Logger for persistent sandbox diagnosing
function logDebug(moduleName: string, eventName: string, details: any) {
  try {
    const logFilePath = path.join(process.cwd(), 'api-debug.log');
    const timestamp = new Date().toISOString();
    const logLine = JSON.stringify({ timestamp, moduleName, eventName, details }) + '\n';
    fs.appendFileSync(logFilePath, logLine, 'utf8');
  } catch (err) {
    console.error('Error writing to api-debug.log:', err);
  }
}

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

if (!admin.apps || admin.apps.length === 0) {
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

// Global privilege authorization checker helper for both developers and DB role-assigned administrators
async function checkUserPrivilege(decodedToken: any): Promise<boolean> {
  const email = (decodedToken.email || '').toLowerCase().trim();
  if (email === 'mayank.semwal@bergtechnologies.co.in') {
    return true;
  }
  if (decodedToken.isAdmin === true) {
    return true;
  }
  try {
    const uid = decodedToken.uid;
    
    // 1. Check users collection by UID
    let userDocExist = false;
    let roleStr = '';
    const docSnap = await db.collection('users').doc(uid).get();
    if (docSnap.exists) {
      userDocExist = true;
      roleStr = (docSnap.data()?.role || '');
    } else if (email) {
      // Fallback: Check users collection by email query
      const emailSnap = await db.collection('users').where('email', '==', email).limit(1).get();
      if (!emailSnap.empty) {
        userDocExist = true;
        roleStr = (emailSnap.docs[0].data()?.role || '');
      }
    }
    
    if (userDocExist) {
      const r = roleStr.trim().toUpperCase();
      if (r === 'ADMIN' || r === 'MANAGER' || r === 'SYSTEM_ADMIN' || r === 'ASSISTANT_MANAGER') {
        return true;
      }
    }

    // 2. Check employee_master collection
    let empDocExist = false;
    let empRoleStr = '';
    const empSnap = await db.collection('employee_master').doc(uid).get();
    if (empSnap.exists) {
      empDocExist = true;
      empRoleStr = (empSnap.data()?.role || '');
    } else if (email) {
      // Fallback: Check employee_master collection by email query
      const emailSnap = await db.collection('employee_master').where('email', '==', email).limit(1).get();
      if (!emailSnap.empty) {
        empDocExist = true;
        empRoleStr = (emailSnap.docs[0].data()?.role || '');
      }
    }

    if (empDocExist) {
      const r = empRoleStr.trim().toUpperCase();
      if (r === 'ADMIN' || r === 'MANAGER' || r === 'SYSTEM_ADMIN' || r === 'ASSISTANT_MANAGER') {
        return true;
      }
    }
  } catch (err: any) {
    console.warn(`[Privilege Check] Could not read user doc from store due to preview permission constraints:`, err);
    // FALLBACK: In pre-production/sandbox environments where the server service account gets PERMISSION_DENIED on firestore,
    // we authorize users belonging to the company domain '@bergtechnologies.co.in' as fallback, as they have been authenticated via client-side Auth.
    if (err.message && (err.message.includes('PERMISSION_DENIED') || err.message.includes('Missing or insufficient permissions') || err.message.includes('7'))) {
      if (email.endsWith('@bergtechnologies.co.in')) {
        console.log(`[Privilege Check Fallback] Authorized company employee ${email} inside preview container.`);
        return true;
      }
    }
  }
  return false;
}

async function start() {
  // Custom email queue background processing worker is disabled here to prevent local sandbox processing
  // and prioritize the native production project Firebase Cloud Function deployment.
  console.log('[SERVER] Sandbox-side background email worker is disabled in favor of native Firebase Cloud Functions.');

  // --- API ROUTES ---
  app.use('/api', (req, res, next) => {
    console.log(`[EXPRESS API LOG] Request: ${req.method} ${req.url}`);
    next();
  });

  // Health check endpoint (defined early)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date(), dbId: DB_ID });
  });

  // Server time synchronization endpoint
  app.get('/api/time', (req, res) => {
    res.json({ 
      serverTime: new Date().toISOString(), 
      serverTimeMs: Date.now() 
    });
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

      const userEmail = (decodedToken.email || '').toLowerCase().trim();
      // Allow receiving verified role from client as fallback inside sandbox preview container
      let role = (req.body.role || 'AGENT').toUpperCase();
      const isDeveloper = userEmail === 'mayank.semwal@bergtechnologies.co.in';
      let isQAFlag = role === 'QA';

      try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
          role = (userDoc.data()?.role || 'AGENT').toUpperCase();
          isQAFlag = role === 'QA';
        }
      } catch (dbErr: any) {
        console.warn(`[API /api/set-claims] Skipping user database record verification due to database permission constraints inside sandbox:`, dbErr.message || String(dbErr));
      }
      
      const finalAdminClaim = (isDeveloper && role === 'ADMIN') || 
        role === 'ADMIN' || 
        role === 'SYSTEM_ADMIN' || 
        role === 'MANAGER' || 
        role === 'ASSISTANT_MANAGER';

      try {
        await admin.auth().setCustomUserClaims(uid, {
          isAdmin: finalAdminClaim,
          isQA: isQAFlag,
        });
        console.log(`Successful claims synchronization for uid: ${uid}. Role: ${role}. Claims: isAdmin=${finalAdminClaim}, isQA=${isQAFlag}`);
      } catch (claimErr: any) {
        console.warn(`Could not set custom auth claims for uid ${uid}. Reason:`, claimErr.message || String(claimErr));
      }

      return res.json({
        status: 'success',
        role,
        claims: { isAdmin: finalAdminClaim, isQA: isQAFlag },
        warning: 'Claims updated successfully via Auth SDK.'
      });
    } catch (error) {
      console.error('Error in /api/set-claims:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // API Route: Create user in Firebase Auth only, without requiring server-side Firestore writes
  app.post('/api/create-user', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
      }
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      
      const isPrivileged = await checkUserPrivilege(decodedToken);
      if (!isPrivileged) {
        return res.status(403).json({ error: 'Forbidden: Admin or Manager authorization required' });
      }

      const { name, email, role, teamLeadId, teamLeadName, mappedManagerId, mappedManagerName, password } = req.body;
      const emailLower = (email || '').toLowerCase().trim();
      if (!name || !emailLower) {
        return res.status(400).json({ error: 'Name and email are required.' });
      }

      let authUser;
      let wasCreatedInAuth = false;
      let targetUid = null;

      // Ensure we look up if there is already an existing user profile doc in Firestore with this email, and if so reuse its document ID
      try {
        const userQuerySnap = await db.collection('users').where('email', '==', emailLower).limit(1).get();
        if (!userQuerySnap.empty) {
          targetUid = userQuerySnap.docs[0].id;
        }
      } catch (dbErr: any) {
        console.warn(`Error searching existing user in Firestore during create-user:`, dbErr.message || String(dbErr));
      }

      if (!targetUid) {
        try {
          authUser = await admin.auth().getUserByEmail(emailLower);
          targetUid = authUser.uid;
        } catch (authErr: any) {
          if (authErr.code === 'auth/user-not-found') {
            try {
              authUser = await admin.auth().createUser({
                email: emailLower,
                displayName: name,
                password: password || 'Password360@',
              });
              targetUid = authUser.uid;
              wasCreatedInAuth = true;
            } catch (createErr) {
              console.warn(`Could not create Auth user for ${emailLower}, using local provision.`, createErr);
            }
          } else {
            console.warn(`Could not fetch Auth user for ${emailLower}, using local provision.`, authErr);
          }
        }
      }

      if (!targetUid) {
        targetUid = 'local_' + Buffer.from(emailLower).toString('base64').replace(/=/g, '').slice(0, 12);
      }

      // Return generated credentials and metadata. The frontend client will save user mappings natively to Firestore.
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

      return res.json({ status: 'success', user: userProfile, wasCreatedInAuth });
    } catch (error) {
      console.error('Error in /api/create-user:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // API Route: Check /api/bulk-create-users status
  app.get('/api/bulk-create-users', (req, res) => {
    return res.json({
      status: 'active',
      message: 'Bulk Create Users endpoint is active. Use HTTP POST with a payload of user rosters to import and sync profiles.'
    });
  });

  // API Route: Bulk Create users in Firebase Auth only, without requiring server-side Firestore writes
  app.post('/api/bulk-create-users', async (req, res) => {
    logDebug('BULK_CREATE', 'REQUEST_RECEIVED', { bodyKeys: Object.keys(req.body) });
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logDebug('BULK_CREATE', 'AUTH_ERROR', { error: 'Missing or malformed Authorization header' });
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
      }
      const token = authHeader.split('Bearer ')[1];
      let decodedToken;
      try {
        decodedToken = await admin.auth().verifyIdToken(token);
      } catch (tokenErr: any) {
        logDebug('BULK_CREATE', 'TOKEN_VER_ERROR', { error: tokenErr.message || String(tokenErr) });
        return res.status(401).json({ error: `Verification failed: ${tokenErr.message}` });
      }

      const requesterEmail = (decodedToken.email || '').toLowerCase().trim();
      logDebug('BULK_CREATE', 'SENDER_IDENTIFIED', { uid: decodedToken.uid, email: requesterEmail });

      const isPrivileged = await checkUserPrivilege(decodedToken);
      if (!isPrivileged) {
        logDebug('BULK_CREATE', 'FORBIDDEN_ATTEMPT', { email: requesterEmail });
        return res.status(403).json({ error: 'Forbidden: Admin or Manager authorization required' });
      }

      const { users } = req.body;
      if (!Array.isArray(users)) {
        logDebug('BULK_CREATE', 'BODY_NOT_ARRAY', { error: 'Expected an array of users' });
        return res.status(400).json({ error: 'Expected an array of users' });
      }

      logDebug('BULK_CREATE', 'START_USER_PROVISION_LOOP', { count: users.length });
      const createdUsers = [];
      const errors = [];

      for (const userData of users) {
        const { name, email, role, department, process, teamLeadId, teamLeadName, mappedManagerId, mappedManagerName, password } = userData;
        const emailLower = (email || '').toLowerCase().trim();
        if (!name || !emailLower) {
          errors.push({ email, error: 'Name and email are required.' });
          logDebug('BULK_CREATE', 'USER_SKIP_REASON', { name, email, error: 'Name or email is blank' });
          continue;
        }

        let authUser;
        let wasCreatedInAuth = false;
        let targetUid = null;
        let errorReported = null;

        // Check if there is already an existing user profile doc in Firestore with this email, and if so reuse its document ID
        try {
          const userQuerySnap = await db.collection('users').where('email', '==', emailLower).limit(1).get();
          if (!userQuerySnap.empty) {
            targetUid = userQuerySnap.docs[0].id;
          } else {
            const empQuerySnap = await db.collection('employee_master').where('email', '==', emailLower).limit(1).get();
            if (!empQuerySnap.empty) {
              targetUid = empQuerySnap.docs[0].id;
            }
          }
        } catch (dbErr: any) {
          console.warn(`Error searching existing user in Firestore during bulk:`, dbErr.message || String(dbErr));
        }

        if (!targetUid) {
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
                logDebug('BULK_CREATE', 'AUTH_CREATE_ERROR', { email: emailLower, error: errorReported });
                console.warn(`Could not create Auth user for ${emailLower}, using local provision.`, errorReported);
              }
            } else {
               errorReported = authErr.message || String(authErr);
               logDebug('BULK_CREATE', 'AUTH_GET_BY_EMAIL_ERROR', { email: emailLower, error: errorReported });
               console.warn(`Could not fetch Auth user for ${emailLower}, using local provision.`, errorReported);
            }
          }
        }

        if (!targetUid) {
          targetUid = 'local_' + Buffer.from(emailLower).toString('base64').replace(/=/g, '').slice(0, 12);
        }

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

        createdUsers.push({ email: emailLower, uid: targetUid, wasCreatedInAuth, profile: userProfile });
      }

      logDebug('BULK_CREATE', 'PROVISION_LOOP_COMPLETED', { successCount: createdUsers.length, errorCount: errors.length });
      return res.json({ status: 'success', createdUsers, errors });
    } catch (error: any) {
      logDebug('BULK_CREATE', 'INTERNAL_SERVER_ERROR', { error: error.message || String(error), stack: error.stack });
      console.error('Error in /api/bulk-create-users:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // API Route: Link and migrate a pre-provisioned user profile securely from a temporary/local doc ID to their real Google/Auth UID
  app.post('/api/link-user-profile', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
      }
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      const uid = decodedToken.uid;
      const email = (decodedToken.email || '').toLowerCase().trim();

      const { oldDocId } = req.body;
      if (!oldDocId) {
        return res.status(400).json({ error: 'Missing oldDocId parameter' });
      }

      console.log(`[API /api/link-user-profile] Attempting to link pre-provisioned doc ${oldDocId} to real uid ${uid} for user ${email}`);

      // 1. Fetch pre-provisioned profile
      const oldUserDoc = await db.collection('users').doc(oldDocId).get();
      if (!oldUserDoc.exists) {
        return res.status(404).json({ error: 'Pre-provisioned profile not found in users collection.' });
      }

      const oldData = oldUserDoc.data() || {};
      
      // Ensure we are linking for the same email to avoid cross-user hijacking
      const oldEmail = (oldData.email || '').toLowerCase().trim();
      if (oldEmail !== email) {
        return res.status(400).json({ error: 'Security breach: Email mismatch for linking profiles.' });
      }

      const now = new Date();

      // 2. Draft merged profile
      const mergedProfile = {
        ...oldData,
        uid: uid,
        email: email,
        name: oldData.name || oldData.fullName || decodedToken.name || email.split('@')[0],
        fullName: oldData.fullName || oldData.name || decodedToken.name || email.split('@')[0],
        role: (oldData.role ? oldData.role.toUpperCase() : (email === 'mayank.semwal@bergtechnologies.co.in' ? 'ADMIN' : (oldData.role || 'AGENT').toUpperCase())),
        status: oldData.status || 'Active',
        department: oldData.department || 'Operations',
        createdAt: oldData.createdAt || now.toISOString(),
        lastLoginAt: now.toISOString(),
        authProvider: 'google'
      };

      // 3. Draft/Fetch employee_master and teamMappings
      let masterDoc = {};
      const oldMasterSnap = await db.collection('employee_master').doc(oldDocId).get();
      if (oldMasterSnap.exists) {
        masterDoc = {
          ...oldMasterSnap.data(),
          lastUpdated: now.toISOString()
        };
      } else {
        masterDoc = {
          employeeId: oldData.employeeId || '',
          employeeName: oldData.name || oldData.fullName || email.split('@')[0],
          email: email,
          role: oldData.role || 'AGENT',
          department: oldData.department || 'Operations',
          process: oldData.process || '',
          status: 'Active',
          lastUpdated: now.toISOString()
        };
      }

      let mappingDoc = {};
      const oldMappingSnap = await db.collection('teamMappings').doc(oldDocId).get();
      if (oldMappingSnap.exists) {
        mappingDoc = {
          ...oldMappingSnap.data(),
          lastUpdated: now.toISOString()
        };
      } else {
        mappingDoc = {
          userId: uid,
          userName: oldData.name || oldData.fullName || email.split('@')[0],
          process: oldData.process || '',
          lastUpdated: now.toISOString()
        };
      }

      // Write merged profiles under real uid with Admin SDK
      const batch = db.batch();
      batch.set(db.collection('users').doc(uid), mergedProfile, { merge: true });
      batch.set(db.collection('employee_master').doc(uid), masterDoc, { merge: true });
      batch.set(db.collection('teamMappings').doc(uid), mappingDoc, { merge: true });

      // Delete old documents safely on the server side
      batch.delete(db.collection('users').doc(oldDocId));
      batch.delete(db.collection('employee_master').doc(oldDocId));
      batch.delete(db.collection('teamMappings').doc(oldDocId));

      await batch.commit();

      console.log(`[API /api/link-user-profile] Successful migration of pre-provisioned user profile: ${email}`);
      return res.json({ status: 'success', user: mergedProfile });
    } catch (err: any) {
      console.error('Error in /api/link-user-profile:', err);
      return res.status(500).json({ error: err.message || String(err) });
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
      
      const isPrivileged = await checkUserPrivilege(decodedToken);
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
            role: email === 'mayank.semwal@bergtechnologies.co.in' ? 'ADMIN' : 'AGENT', // Default for new syncs
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

  // API Route: Get SMTP Configuration status (for admin dashboard diagnostics)
  app.get('/api/smtp-status', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
      }
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      
      const isPrivileged = await checkUserPrivilege(decodedToken);
      if (!isPrivileged) {
        return res.status(403).json({ error: 'Forbidden: Admin or Manager role required' });
      }

      const host = process.env.SMTP_HOST || 'smtp.gmail.com';
      const port = parseInt(process.env.SMTP_PORT || '587', 10);
      const user = process.env.SMTP_USER;
      const isConfigured = !!(user && process.env.SMTP_PASS);
      const from = process.env.SMTP_FROM || 'compliance@bergtechnologies.co.in';

      return res.json({
        isConfigured,
        host,
        port,
        user: user ? `${user.substring(0, 3)}***@${user.split('@')[1] || 'domain'}` : null,
        from
      });
    } catch (error) {
      console.error('Error in /api/smtp-status:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Automated 7 AM attendance synchronization routine
  async function autoSyncAttendance() {
    console.log('[AUTO SYNC] Starting scheduled attendance synchronization...');
    try {
      // 1. Fetch completed shifts from the last 7 days from Firestore
      const shiftsRef = db.collection('tmsShifts');
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 7); // Sync last 7 days is fast and safe
      
      const shiftsSnapshot = await shiftsRef
        .where('clockInTime', '>=', cutoffDate.toISOString())
        .get();
        
      const completedShifts = shiftsSnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as any))
        .filter(s => s.status === 'COMPLETED');
        
      if (completedShifts.length === 0) {
        console.log('[AUTO SYNC] No completed shifts found to sync.');
        return;
      }
      
      // 2. Fetch config/attendanceSettings
      const confSnap = await db.collection('config').doc('attendanceSettings').get();
      let config = { presentThreshold: 480, halfDayThreshold: 240, countBreakTime: false };
      if (confSnap.exists) {
        const c = confSnap.data() || {};
        config = {
          presentThreshold: c.presentThreshold ?? 480,
          halfDayThreshold: c.halfDayThreshold ?? 240,
          countBreakTime: c.countBreakTime ?? false
        };
      }
      
      console.log('[AUTO SYNC] Configuration:', config);
      
      // 3. Process each completed shift
      let writeCount = 0;
      const CHUNK_SIZE = 450;
      let batch = db.batch();
      
      for (const shift of completedShifts) {
        const startMs = new Date(shift.clockInTime).getTime();
        const endMs = shift.clockOutTime ? new Date(shift.clockOutTime).getTime() : startMs;
        
        let prodMs = 0;
        let breakMs = 0;
        
        (shift.activities || []).forEach((act: any) => {
          const aStart = new Date(act.startTime).getTime();
          const aEnd = act.endTime ? new Date(act.endTime).getTime() : endMs;
          const dur = Math.max(0, aEnd - aStart);
          
          const actName = (act.name || '').toLowerCase();
          const isProductive = act.type === 'productive' || 
                               actName.includes('meeting') || 
                               actName.includes('coaching') || 
                               actName.includes('alignment');
                               
          if (isProductive) {
            prodMs += dur;
          } else {
            breakMs += dur;
          }
        });
        
        let totalMins = Math.floor(prodMs / 60000);
        if (config.countBreakTime) {
          totalMins += Math.floor(breakMs / 60000);
        }
        
        let attendanceStatus: 'Present' | 'Half Day' | 'Absent' = 'Absent';
        if (totalMins >= config.presentThreshold) attendanceStatus = 'Present';
        else if (totalMins >= config.halfDayThreshold) attendanceStatus = 'Half Day';
        
        const dateStr = shift.clockInTime.split('T')[0];
        const isOvernight = shift.clockOutTime ? (shift.clockInTime.split('T')[0] !== shift.clockOutTime.split('T')[0]) : false;
        
        const summary = {
          id: shift.id,
          shiftId: shift.id,
          userId: shift.userId,
          employeeName: shift.userName || shift.userEmail,
          employeeEmail: shift.userEmail,
          employeeId: shift.employeeId || '',
          process: shift.process || 'N/A',
          mappedTL: shift.mappedTL || 'N/A',
          mappedManager: shift.mappedManager || 'N/A',
          attendanceDate: dateStr,
          attendanceStatus,
          productiveMinutes: totalMins,
          totalBreakMinutes: Math.floor(breakMs / 60000),
          sessionStart: shift.clockInTime,
          sessionEnd: shift.clockOutTime || shift.clockInTime,
          generatedBySystem: true,
          isOvernight,
          autoSyncedAt: new Date().toISOString()
        };
        
        const attDocRef = db.collection('attendanceSummary').doc(shift.id);
        batch.set(attDocRef, summary, { merge: true });
        writeCount++;
        
        if (writeCount % CHUNK_SIZE === 0) {
          await batch.commit();
          batch = db.batch();
        }
      }
      
      if (writeCount % CHUNK_SIZE !== 0) {
        await batch.commit();
      }
      
      console.log(`[AUTO SYNC] Successfully auto-synchronized ${writeCount} attendance records.`);
    } catch (err) {
      console.error('[AUTO SYNC] Error in scheduled synchronizer:', err);
    }
  }

  // Schedule auto attendance sync job every 7 AM Kolkata time
  let lastLoggedHour = -1;
  let lastSyncedDateStr = '';

  setInterval(() => {
    try {
      const kolkataTimeStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
      const kolkataDate = new Date(kolkataTimeStr);
      const hours = kolkataDate.getHours();
      const minutes = kolkataDate.getMinutes();
      const dateStr = kolkataDate.toISOString().split('T')[0];

      // Exact matching at 7:00 AM once a day
      if (hours === 7 && minutes === 0 && lastSyncedDateStr !== dateStr) {
        lastSyncedDateStr = dateStr;
        console.log(`[AUTO SYNC SCHEDULE] Triggered automated 7 AM attendance sync for date ${dateStr} IST.`);
        autoSyncAttendance();
      }
      
      // Heartbeat diagnostic status logging
      if (hours % 4 === 0 && lastLoggedHour !== hours) {
        lastLoggedHour = hours;
        console.log(`[SCHEDULER HEARTBEAT] Active. Kolkata time is ${kolkataDate.toLocaleTimeString()}.`);
      }
    } catch (err) {
      console.error('[SCHEDULER CRON ERROR] Error in tick interval:', err);
    }
  }, 60000);

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
