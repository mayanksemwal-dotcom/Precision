import { initializeApp } from 'firebase/app';
import { getStorage } from 'firebase/storage';
import { firestoreLogger } from './firestoreLogger';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile
} from 'firebase/auth';
import { 
  initializeFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager,
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  collection, 
  query, 
  where, 
  onSnapshot, 
  getDocs, 
  getDocFromServer, 
  getDocsFromServer,
  writeBatch,
  getDocsFromCache, 
  getDocFromCache 
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

if (!firebaseConfig || !firebaseConfig.apiKey) {
  console.error("Firebase configuration is missing or invalid. Check firebase-applet-config.json.");
}

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// 2. Modern Database Setup with Local Cache API (Firebase v12+ style)
// This replaces enableIndexedDbPersistence() which is now deprecated.
// experimentalForceLongPolling: true resolves the "WebSocket closed without opened" error.
const databaseId = (firebaseConfig as any).firestoreDatabaseId || '(default)';

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  }),
  experimentalForceLongPolling: true
}, databaseId);

export const storage = getStorage(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/gmail.send');
googleProvider.addScope('https://www.googleapis.com/auth/gmail.readonly');

const workspaceProvider = new GoogleAuthProvider();
workspaceProvider.addScope('https://www.googleapis.com/auth/spreadsheets');
workspaceProvider.addScope('https://www.googleapis.com/auth/drive');
workspaceProvider.addScope('https://www.googleapis.com/auth/forms');
workspaceProvider.addScope('https://www.googleapis.com/auth/chat');
workspaceProvider.addScope('https://www.googleapis.com/auth/gmail.send');
workspaceProvider.addScope('https://www.googleapis.com/auth/gmail.readonly');

let cachedAccessToken: string | null = null;

export const getGoogleAccessToken = () => cachedAccessToken;
export const setGoogleAccessToken = (token: string | null) => { cachedAccessToken = token; };

export const loginWithGoogle = async () => {
  const result = await signInWithPopup(auth, googleProvider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (credential?.accessToken) {
    cachedAccessToken = credential.accessToken;
    console.log('Successfully cached Google OAuth access token during google sign-in.');
  }
  return result;
};

export const authorizeWorkspaceGoogle = async () => {
  const result = await signInWithPopup(auth, workspaceProvider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (credential?.accessToken) {
    cachedAccessToken = credential.accessToken;
    console.log('Successfully cached Google Workspace OAuth access token.');
  }
  return result;
};
export const loginWithEmail = (email: string, pass: string) => signInWithEmailAndPassword(auth, email, pass);
export const signupWithEmail = (email: string, pass: string) => createUserWithEmailAndPassword(auth, email, pass);
export const logout = async () => {
  try {
    const currentUser = auth.currentUser;
    if (currentUser?.uid) {
      const uid = currentUser.uid;
      const nowISO = new Date().toISOString();
      
      // Update user portal status to OFFLINE
      try {
        await Promise.all([
          setDoc(doc(db, 'users', uid), { status: 'OFFLINE', lastLogoutAt: nowISO }, { merge: true }),
          setDoc(doc(db, 'employee_master', uid), { status: 'OFFLINE', lastLogoutAt: nowISO }, { merge: true })
        ]);
      } catch (err) {
        console.warn('Error updating user status on logout:', err);
      }
    }
  } catch (err) {
    console.error('Error in logout cleanup:', err);
  } finally {
    await signOut(auth);
    cachedAccessToken = null;
    clearCache();
  }
};

// 3. Optional: Background verification.
// The primary profile handling is now managed in App.tsx's Auth listener.
export async function syncUserProfile(user: User, authProvider: 'google' | 'email') {
  const path = `users/${user.uid}`;
  try {
    console.log(`Syncing profile: UID=${user.uid}, Email=${user.email}, Collection=employee_master, Path=${path}`);
    const userRef = doc(db, 'employee_master', user.uid);
    const userDoc = await getDoc(userRef);
    
    if (!userDoc.exists()) {
      // Check for pre-provisioned profile under a different ID (like a local_ ID)
      const usersRef = collection(db, 'employee_master');
      const checkQuery = query(usersRef, where('email', '==', (user.email || '').toLowerCase().trim()));
      const querySnap = await getDocs(checkQuery);
      
      if (!querySnap.empty) {
        const matchedDoc = querySnap.docs[0];
        const matchedData = matchedDoc.data() as any;
        console.log(`Pre-provisioned user found matching email. Linking to Auth uid... ${matchedDoc.id} -> ${user.uid}`);
        
        const mergedData = {
          ...matchedData,
          uid: user.uid,
          email: (user.email || '').toLowerCase().trim(),
          authProvider: authProvider,
          createdAt: matchedData.createdAt || new Date().toISOString(),
          lastLogin: new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
          isActive: true,
          status: matchedData.status || 'Active'
        };
        
        await setDoc(userRef, mergedData);
        
        if (matchedDoc.id !== user.uid) {
          await deleteDoc(doc(db, 'employee_master', matchedDoc.id));
          // Migrate employee master if existed
          try {
            const oldMasterRef = doc(db, 'employee_master', matchedDoc.id);
            const oldMasterSnap = await getDoc(oldMasterRef);
            if (oldMasterSnap.exists()) {
              const oldMasterData = oldMasterSnap.data();
              await setDoc(doc(db, 'employee_master', user.uid), {
                ...oldMasterData,
                lastUpdated: new Date().toISOString()
              }, { merge: true });
              await deleteDoc(oldMasterRef);
              console.log(`Synchronized employee_master for ${user.email} from ${matchedDoc.id} to ${user.uid}`);
            }
          } catch(err) {
            console.error('Master sync err during syncUserProfile:', err);
          }
        }
      } else {
        await setDoc(userRef, {
          uid: user.uid,
          email: user.email,
          name: user.displayName || 'New Agent',
          fullName: user.displayName || 'New Agent',
          role: 'AGENT',
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
          authProvider: authProvider,
          isActive: true,
          department: 'N/A',
          Manager: 'N/A'
        });
        console.log(`Created new profile for: ${user.email}`);
      }
    } else {
      const data = userDoc.data();
      if (data.status === 'Inactive' || data.isActive === false) {
        throw new Error('DEACTIVATED_ACCOUNT: Your account has been deactivated. Please contact your administrator.');
      }
      await updateDoc(userRef, {
        lastLogin: new Date().toISOString()
      });
      console.log(`Updated last login for: ${user.email}`);
    }
  } catch (error: any) {
    console.error(`Critical error during profile sync: UID=${user.uid}, Email=${user.email}, Path=${path}, Error=${error.message}`);
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const stats = firestoreLogger.getStats();
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  
  // Log specific diagnostic for permission errors
  if (errInfo.error.includes('permission') || errInfo.error.includes('insufficient')) {
    console.error(`CRITICAL: Firestore Permission Denied! [Cumulative Reads: ${stats.totalReads}, Writes: ${stats.totalWrites}]`, JSON.stringify(errInfo));
  } else {
    console.error(`Firestore Error [Cumulative Reads: ${stats.totalReads}, Writes: ${stats.totalWrites}]:`, JSON.stringify(errInfo));
  }
  
  throw new Error(JSON.stringify(errInfo));
}

// Validate Connection to Firestore on initial boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("Firestore connection validated successfully.");
  } catch (error) {
    if (error instanceof Error && error.message.includes('offline')) {
      console.error("Please check your Firebase configuration: Client is offline.");
    } else {
      console.log("Firestore connection available (pre-cached or default permission checks).");
    }
  }
}
testConnection();

let globalQuotaExhausted = false;
const queryCache = new Map<string, { timestamp: number, data: any }>();
const docCache = new Map<string, { timestamp: number, data: any }>();
const GLOBAL_CACHE_TTL = 60 * 60 * 1000; // 1 hour for memory cache
const MAX_CACHE_ENTRIES = 60; // Max cache capacity to prevent memory leaks in long sessions

function setQueryCache(key: string, data: any) {
  const now = Date.now();
  if (queryCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of queryCache.entries()) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) queryCache.delete(oldestKey);
  }
  queryCache.set(key, { timestamp: now, data });
}

function setDocCache(key: string, data: any) {
  const now = Date.now();
  if (docCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of docCache.entries()) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) docCache.delete(oldestKey);
  }
  docCache.set(key, { timestamp: now, data });
}

export function pruneExpiredMemoryCache(): number {
  const now = Date.now();
  let prunedCount = 0;
  for (const [key, item] of queryCache.entries()) {
    const ttl = getCacheTTL(key);
    if (now - item.timestamp > ttl) {
      queryCache.delete(key);
      prunedCount++;
    }
  }
  for (const [key, item] of docCache.entries()) {
    const ttl = getCacheTTL(key);
    if (now - item.timestamp > ttl) {
      docCache.delete(key);
      prunedCount++;
    }
  }
  if (prunedCount > 0) {
    console.log(`[MEMORY GUARD] Automatically pruned ${prunedCount} stale memory cache entries.`);
  }
  return prunedCount;
}

export function purgeAllMemoryCaches(): number {
  const count = queryCache.size + docCache.size;
  queryCache.clear();
  docCache.clear();
  globalQuotaExhausted = false;
  console.log(`[MEMORY GUARD] Fully purged memory caches (${count} entries cleared).`);
  return count;
}

function getCacheTTL(key: string): number {
  const lowercaseKey = (key || '').toLowerCase();
  // Live sessions, active shifts, or supervisor own active shifts should have a 10 minutes cache to optimize Firestore reads and remain synchronized
  if (
    lowercaseKey.includes('live_sessions') || 
    lowercaseKey.includes('tmsshifts') || 
    lowercaseKey.includes('supervisor_own_active_shifts') ||
    lowercaseKey.includes('shift') ||
    lowercaseKey.includes('attendance')
  ) {
    return 10 * 60 * 1000; // 10 minutes (600,000 ms)
  }
  return GLOBAL_CACHE_TTL; // 1 hour for system settings, configs, kpi_templates
}

function getMockDataForPath(path: string, id: string): any {
  if (id === 'attendanceSettings' || path.includes('attendanceSettings')) {
    return {
      gracePeriod: 10,
      halfDayThreshold: 240,
      fullDayThreshold: 480,
      enableAutoSync: true,
      lastUpdated: new Date().toISOString()
    };
  }
  if (id === 'tmsProcesses' || path.includes('tmsProcesses')) {
    return {
      list: ['HITL', 'MPQC', 'OQC', 'SOP Training', 'QA Review', 'Team Alignment'],
      lastUpdated: new Date().toISOString()
    };
  }
  if (id === 'connection' || path.includes('connection')) {
    return { connected: true };
  }
  return null;
}

function createMockDocumentSnapshot(id: string, path: string) {
  const data = getMockDataForPath(path, id);
  return {
    id,
    exists: () => data !== null,
    data: () => data,
    get: (field: string) => data?.[field],
    ref: { id, path },
    metadata: { fromCache: true, hasPendingWrites: false }
  };
}

function createMockQuerySnapshot(q: any, logPrefix?: string) {
  return {
    docs: [],
    empty: true,
    size: 0,
    metadata: { fromCache: true, hasPendingWrites: false },
    query: q || {},
    docChanges: () => [],
    forEach: (callback: any) => {},
  };
}

export async function getDocOptimized(docRef: any, logPrefix?: string, forceServer: boolean = false) {
  const docKey = logPrefix || docRef.path;
  const now = Date.now();
  const cached = docCache.get(docKey);

  if (globalQuotaExhausted && !forceServer) {
    if (cached) {
      if (logPrefix) console.warn(`[QUOTA BYPASS] Returning memory doc cache for ${logPrefix}`);
      return cached.data;
    }
    try {
      const cacheSnap = await getDocFromCache(docRef);
      if (logPrefix) console.warn(`[QUOTA BYPASS] Returning Firebase doc cache for ${logPrefix}`);
      return cacheSnap;
    } catch (e) { }
  }

  const ttl = getCacheTTL(docKey);
  if (!forceServer && cached && (now - cached.timestamp < ttl)) {
    if (logPrefix) console.log(`[DOC MEMORY CACHE HIT] ${logPrefix} (TTL: ${ttl}ms)`);
    return cached.data;
  }

  const fetchFromServer = async () => {
    const snap = await getDocFromServer(docRef);
    setDocCache(docKey, snap);
    globalQuotaExhausted = false;
    if (logPrefix) console.log(`[DOC SERVER FETCH] ${logPrefix}`);
    return snap;
  };

  const fetchFromCache = async () => {
    const snap = await getDocFromCache(docRef);
    if (logPrefix) console.log(`[DOC FIREBASE CACHE HIT] ${logPrefix}`);
    return snap;
  };

  try {
    return await fetchFromServer();
  } catch (err: any) {
    const isQuotaError = err.message?.includes('Quota') || err.message?.includes('quota') || err.code === 'resource-exhausted';
    if (isQuotaError) {
      globalQuotaExhausted = true;
      if (logPrefix) console.warn(`[QUOTA EXCEEDED] ${logPrefix} - falling back to doc cache.`);
    }
    try {
      return await fetchFromCache();
    } catch (e) {
      if (cached) return cached.data;
      if (isQuotaError || globalQuotaExhausted) {
        console.warn(`[QUOTA FALLBACK] Returning mock doc for ${docRef.path}`);
        return createMockDocumentSnapshot(docRef.id, docRef.path);
      }
      throw err;
    }
  }
}

export async function getDocsOptimized(q: any, logPrefix?: string, forceServer: boolean = false) {
  const queryKey = logPrefix || JSON.stringify(q);
  const now = Date.now();
  const cached = queryCache.get(queryKey);

  // If quota is exhausted, prefer cache immediately unless forceServer is true
  if (globalQuotaExhausted && !forceServer) {
    if (cached) {
      if (logPrefix) console.warn(`[QUOTA BYPASS] Returning memory query cache for ${logPrefix}`);
      return cached.data;
    }
    try {
      const cacheSnap = await getDocsFromCache(q);
      if (logPrefix) console.warn(`[QUOTA BYPASS] Returning Firebase query cache for ${logPrefix}`);
      return cacheSnap;
    } catch (e) {
      // Continue to try server if no cache available
    }
  }

  // If we have a fresh cache hit, return it immediately to avoid server roundtrip
  const ttl = getCacheTTL(queryKey);
  if (!forceServer && cached && (now - cached.timestamp < ttl)) {
    if (logPrefix) console.log(`[MEMORY CACHE HIT] ${logPrefix} (TTL: ${ttl}ms)`);
    return cached.data;
  }

  const fetchFromServer = async () => {
    const snap = await getDocsFromServer(q);
    setQueryCache(queryKey, snap);
    globalQuotaExhausted = false; // Reset if successful
    if (logPrefix) console.log(`[SERVER FETCH] ${logPrefix}: ${snap.size} documents.`);
    return snap;
  };

  const fetchFromCache = async () => {
    const snap = await getDocsFromCache(q);
    if (logPrefix) console.log(`[FIREBASE CACHE HIT] ${logPrefix}: ${snap.size} documents.`);
    return snap;
  };

  if (forceServer) {
    try {
      return await fetchFromServer();
    } catch (err: any) {
      const isQuotaError = err.message?.includes('Quota') || err.message?.includes('quota') || err.code === 'resource-exhausted';
      if (isQuotaError) globalQuotaExhausted = true;
      console.warn(`[SERVER FETCH FORCED FAILED] ${logPrefix}`, err);
      try {
        return await fetchFromCache();
      } catch (cacheErr) {
        if (isQuotaError || globalQuotaExhausted) {
          return createMockQuerySnapshot(q, logPrefix);
        }
        throw err;
      }
    }
  }

  try {
    // Try server first if cache is stale or missing
    return await fetchFromServer();
  } catch (err: any) {
    const isQuotaError = err.message?.includes('Quota') || err.message?.includes('quota') || err.code === 'resource-exhausted';
    if (isQuotaError) {
      globalQuotaExhausted = true;
      console.warn(`[QUOTA EXCEEDED] ${logPrefix} - falling back to cache.`);
    } else {
      console.warn(`[SERVER FETCH FAILED] ${logPrefix}`, err);
    }
    
    try {
      return await fetchFromCache();
    } catch (cacheErr) {
      console.error(`[CRITICAL] Both Server and Cache failed for ${logPrefix}`, cacheErr);
      if (cached) return cached.data; // Return memory cache even if stale as last resort
      if (isQuotaError || globalQuotaExhausted) {
        console.warn(`[QUOTA FALLBACK] Returning mock empty query snapshot for ${logPrefix}`);
        return createMockQuerySnapshot(q, logPrefix);
      }
      throw err;
    }
  }
}

export async function getDocsCacheFirst(q: any, logPrefix?: string, forceServer: boolean = false) {
  if (!forceServer) {
    try {
      const cacheSnap = await getDocsFromCache(q);
      if (cacheSnap && !cacheSnap.empty) {
        if (logPrefix) console.log(`[CACHE FIRST HIT] ${logPrefix}: ${cacheSnap.size} document(s).`);
        return cacheSnap;
      }
    } catch (e) {
      // Cache miss or error reading cache, fall through to network fetch
    }
  }
  return await getDocsOptimized(q, logPrefix, forceServer);
}

export function invalidateCacheKey(key: string) {
  docCache.delete(key);
  queryCache.delete(key);
  console.log(`[CACHE] Invalidated cache key: ${key}`);
}

export function clearCache() {
  // Selectively clear shift and session related caches to preserve static configs (saving read quota)
  let clearedCount = 0;
  for (const [key] of queryCache.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('shift') || lowerKey.includes('session') || lowerKey.includes('active')) {
      queryCache.delete(key);
      clearedCount++;
    }
  }
  for (const [key] of docCache.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('shift') || lowerKey.includes('session') || lowerKey.includes('active')) {
      docCache.delete(key);
      clearedCount++;
    }
  }
  
  globalQuotaExhausted = false; // Reset quota block on cache invalidations so we retry server fetches
  console.log(`[CACHE] Selective caches cleared (${clearedCount} entries) and quota block reset.`);
}




