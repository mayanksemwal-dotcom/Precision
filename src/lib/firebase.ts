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
      
      // Update user portal lastLogoutAt on logout without mutating administrative status
      try {
        await Promise.all([
          setDoc(doc(db, 'users', uid), { lastLogoutAt: nowISO }, { merge: true }),
          setDoc(doc(db, 'employee_master', uid), { lastLogoutAt: nowISO }, { merge: true })
        ]);
      } catch (err) {
        console.warn('Error updating user lastLogoutAt on logout:', err);
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

export { getDocFromCache, getDocsFromCache };
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
      if (data.loginRestricted === true || data.isRestricted === true || data.isLoginRestricted === true || data.status === 'Restricted') {
        const reason = data.restrictedReason ? ` Reason: ${data.restrictedReason}` : '';
        throw new Error(`RESTRICTED_ACCOUNT: Your account login has been restricted by an administrator.${reason}`);
      }
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

export interface QueryCacheMetadata {
  collection: string;
  userIds: string[];
  supervisorIds: string[];
  shiftIds: string[];
  key: string;
}

export interface DocCacheMetadata {
  collection: string;
  docId: string;
  path: string;
  key: string;
}

export interface ShiftInvalidationParams {
  userId?: string;
  shiftId?: string;
  teamLeadUid?: string;
  managerId?: string;
  teamId?: string;
  reason?: string;
}

type ShiftInvalidationListener = (params: ShiftInvalidationParams) => void;
const shiftInvalidationListeners: Set<ShiftInvalidationListener> = new Set();

export function registerShiftInvalidationListener(listener: ShiftInvalidationListener): () => void {
  shiftInvalidationListeners.add(listener);
  return () => shiftInvalidationListeners.delete(listener);
}

const queryCache = new Map<string, { timestamp: number, data: any, metadata: QueryCacheMetadata }>();
const docCache = new Map<string, { timestamp: number, data: any, metadata: DocCacheMetadata }>();
const queryInvocationCounts = new Map<string, number>();
const GLOBAL_CACHE_TTL = 60 * 60 * 1000; // 1 hour for memory cache
const MAX_CACHE_ENTRIES = 60; // Max cache capacity to prevent memory leaks in long sessions

function extractQueryMetadata(q: any, logPrefix?: string): QueryCacheMetadata {
  const collection = extractCollectionName(q, logPrefix);
  const userIds: string[] = [];
  const supervisorIds: string[] = [];
  const shiftIds: string[] = [];
  const key = logPrefix || (q?.path || '');

  // 1. Extract from logPrefix string patterns
  if (logPrefix) {
    // Pattern: my_shifts_history_fetch_<uid> or repair_my_shifts_<uid> or user_role_check_<uid>
    const matchUid = logPrefix.match(/_(?:fetch|fallback|check|state|shifts)_([a-zA-Z0-9_\-]+)$/);
    if (matchUid && matchUid[1]) {
      userIds.push(matchUid[1]);
    }
    // Pattern: hist_<uid>_<role>_...
    const matchHist = logPrefix.match(/^historical_shifts_(?:agent|sup|global|chunk_\d+)_hist_([a-zA-Z0-9_\-]+)_/);
    if (matchHist && matchHist[1] && matchHist[1] !== 'anon') {
      userIds.push(matchHist[1]);
    }
    // Pattern: historical_shifts_chunk_... which might have user IDs in cacheKey
    const matchChunkUids = logPrefix.match(/hist_[^_]+_[^_]+_\d+_([^_]+)_/);
    if (matchChunkUids && matchChunkUids[1] && matchChunkUids[1].includes(',')) {
      userIds.push(...matchChunkUids[1].split(','));
    }
    // Pattern: active_shift_direct_<shiftId> or verify_active_direct_<shiftId>
    const matchShift = logPrefix.match(/(?:active_shift_direct|verify_active_direct|force_out_shift)_([a-zA-Z0-9_\-]+)/);
    if (matchShift && matchShift[1]) {
      shiftIds.push(matchShift[1]);
    }
  }

  // 2. Extract from Firestore Query constraints / filters if available
  try {
    const filters = q?._query?.filters || q?.filters || [];
    for (const filter of filters) {
      const field = filter?.field?.segments?.[0] || filter?.field?.canonicalString || filter?.field;
      const value = filter?.value?.value !== undefined ? filter?.value?.value : filter?.value;
      if (field === 'userId' || field === 'uid') {
        if (Array.isArray(value)) {
          userIds.push(...value.map(v => typeof v === 'object' ? (v?.value ?? String(v)) : String(v)));
        } else if (typeof value === 'string') {
          userIds.push(value);
        }
      } else if (field === 'teamLeadUid' || field === 'teamLeadId' || field === 'mappedTL') {
        if (typeof value === 'string') supervisorIds.push(value);
      } else if (field === 'managerId' || field === 'mappedManager') {
        if (typeof value === 'string') supervisorIds.push(value);
      } else if (field === 'shiftId' || field === 'id') {
        if (typeof value === 'string') shiftIds.push(value);
      }
    }
  } catch (e) {}

  return {
    collection,
    userIds: Array.from(new Set(userIds)),
    supervisorIds: Array.from(new Set(supervisorIds)),
    shiftIds: Array.from(new Set(shiftIds)),
    key
  };
}

function setQueryCache(key: string, data: any, q?: any) {
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
  const metadata = extractQueryMetadata(q, key);
  queryCache.set(key, { timestamp: now, data, metadata });
}

function setDocCache(key: string, data: any, docRef?: any) {
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
  const meta: DocCacheMetadata = {
    collection: extractCollectionName(docRef, key),
    docId: docRef?.id || key.split('/').pop() || key,
    path: docRef?.path || key,
    key
  };
  docCache.set(key, { timestamp: now, data, metadata: meta });
}

function extractCallingLocation(): { caller: string; fileLine: string } {
  try {
    const err = new Error();
    const stack = err.stack || '';
    const lines = stack.split('\n');
    for (const line of lines) {
      if (!line.includes('firebase.ts') && !line.includes('firestoreLogger.ts') && (line.includes('.tsx') || line.includes('.ts'))) {
        const match = line.match(/([a-zA-Z0-9_\-\.]+)\.(tsx?):(\d+)/);
        if (match) {
          return { caller: match[1], fileLine: `${match[1]}.${match[2]}:${match[3]}` };
        }
      }
    }
  } catch (e) {}
  return { caller: 'UnknownComponent', fileLine: 'unknown' };
}

function extractCallingComponent(): string {
  return extractCallingLocation().caller;
}

function extractCollectionName(target: any, logPrefix?: string): string {
  if (logPrefix) {
    const prefix = logPrefix.toLowerCase();
    if (prefix.includes('tmsshift') || prefix.includes('historical_shift') || prefix.includes('my_shifts') || prefix.includes('repair_tms') || prefix.includes('silent_sync_shifts') || prefix.includes('export_shifts')) return 'tmsShifts';
    if (prefix.includes('live_session')) return 'live_sessions';
    if (prefix.includes('attendance') || prefix.includes('attendancesummary')) return 'attendanceSummary';
    if (prefix.includes('adminauditlog') || prefix.includes('audit')) return 'adminAuditLogs';
    if (prefix.includes('employee_master') || prefix.includes('roster') || prefix.includes('user')) return 'employee_master';
    if (prefix.includes('role')) return 'roles';
    if (prefix.includes('config') || prefix.includes('office_network')) return 'config';
    if (prefix.includes('tmsactivelocks') || prefix.includes('active_lock')) return 'tmsActiveLocks';
  }
  if (target?.path) {
    const segments = target.path.split('/');
    return segments[0] || 'unknown';
  }
  if (target?._query?.path?.segments) {
    return target._query.path.segments[0] || 'unknown';
  }
  return 'unknown';
}

export function trackFirestoreCostDiagnostic(queryName: string, docCount: number, cacheHit: boolean, callingComponent?: string) {
  const loc = extractCallingLocation();
  const component = callingComponent || loc.fileLine;
  const status = cacheHit ? 'CACHE HIT' : 'SERVER FETCH';
  console.info(`📊 [FIRESTORE COST DIAGNOSTIC] Query/Doc: "${queryName}" | Caller: "${component}" | Status: ${status} | Docs Returned: ${docCount}`);
  
  firestoreLogger.trackReadDetailed({
    collection: extractCollectionName(null, queryName),
    queryFingerprint: queryName,
    caller: component,
    trigger: 'diagnostic_track',
    resultCount: docCount,
    isCacheHit: cacheHit
  });
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
  queryInvocationCounts.clear();
  globalQuotaExhausted = false;
  console.log(`[MEMORY GUARD] Fully purged memory caches (${count} entries cleared).`);
  return count;
}

function getCacheTTL(key: string): number {
  const lowercaseKey = (key || '').toLowerCase();
  // Highly volatile active state keys (active shift locks and direct active session checks) must bypass memory caching (TTL 0) when queried.
  if (
    lowercaseKey.includes('active_lock') ||
    lowercaseKey.includes('active_shift_direct') ||
    lowercaseKey.includes('my_active_shifts_narrow') ||
    lowercaseKey.includes('tmsactivelocks') ||
    lowercaseKey.includes('supervisor_own_active_shifts')
  ) {
    return 0; // Real-time bypass for active state checks
  }
  return GLOBAL_CACHE_TTL; // 1 hour memory cache for historical shifts, attendance summaries, rosters, roles, configs
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

const pendingQueryPromises = new Map<string, Promise<any>>();
const pendingDocPromises = new Map<string, Promise<any>>();

export function printFirestoreCostTelemetry(queryName: string, reason: string, cacheHit: boolean, docCount: number, invocation: number, componentName?: string) {
  const component = componentName || extractCallingComponent();
  const cacheStatus = cacheHit ? 'HIT' : 'MISS';
  console.info(`[FIRESTORE COST] query=${queryName} reason=${reason} cache=${cacheStatus} docs=${docCount} invocation=${invocation} component=${component}`);
}

export async function getDocOptimized(docRef: any, logPrefix?: string, forceServer: boolean = false) {
  const docKey = logPrefix || docRef.path;
  const promiseKey = `${docKey}_force_${forceServer}`;

  if (pendingDocPromises.has(promiseKey)) {
    console.info(`[DE-DUP] Reusing in-flight promise for doc: "${docKey}" (forceServer: ${forceServer})`);
    return pendingDocPromises.get(promiseKey);
  }

  const promise = (async () => {
    const now = Date.now();
    const cached = docCache.get(docKey);
    const ttl = getCacheTTL(docKey);
    let resolvedReason = 'Cache miss or stale TTL';
    let cacheHit = false;
    let docsReturned = 0;

    const recordTelemetry = (snap: any, hit: boolean, reas: string) => {
      cacheHit = hit;
      resolvedReason = reas;
      docsReturned = snap && snap.exists && snap.exists() ? 1 : 0;
      const loc = extractCallingLocation();
      printFirestoreCostTelemetry(docKey, resolvedReason, cacheHit, docsReturned, 1, loc.fileLine);
      firestoreLogger.trackReadDetailed({
        collection: extractCollectionName(docRef, docKey),
        queryFingerprint: docKey,
        caller: loc.fileLine,
        trigger: reas,
        resultCount: docsReturned,
        isCacheHit: cacheHit
      });
    };

    if (globalQuotaExhausted && !forceServer) {
      if (cached) {
        if (logPrefix) console.info(`[QUOTA BYPASS] Returning memory doc cache for ${logPrefix}`);
        recordTelemetry(cached.data, true, 'Quota exhausted cache fallback');
        return cached.data;
      }
      try {
        const cacheSnap = await getDocFromCache(docRef);
        if (logPrefix) console.info(`[QUOTA BYPASS] Returning Firebase doc cache for ${logPrefix}`);
        recordTelemetry(cacheSnap, true, 'Quota exhausted Firebase cache fallback');
        return cacheSnap;
      } catch (e) { }
    }

    if (!forceServer && cached && (now - cached.timestamp < ttl)) {
      if (logPrefix) console.log(`[DOC MEMORY CACHE HIT] ${logPrefix} (TTL: ${ttl}ms)`);
      recordTelemetry(cached.data, true, 'Memory cache hit (TTL valid)');
      return cached.data;
    }

    const fetchFromServer = async () => {
      const snap = await getDocFromServer(docRef);
      setDocCache(docKey, snap, docRef);
      globalQuotaExhausted = false;
      if (logPrefix) console.log(`[DOC SERVER FETCH] ${logPrefix}`);
      recordTelemetry(snap, false, forceServer ? 'Force server fetch' : 'Cache miss or stale TTL');
      return snap;
    };

    const fetchFromCache = async () => {
      const snap = await getDocFromCache(docRef);
      if (logPrefix) console.log(`[DOC FIREBASE CACHE HIT] ${logPrefix}`);
      recordTelemetry(snap, true, 'Firebase cache hit');
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
        if (cached) {
          recordTelemetry(cached.data, true, 'Stale memory cache fallback after fetch failure');
          return cached.data;
        }
        if (isQuotaError || globalQuotaExhausted) {
          console.warn(`[QUOTA FALLBACK] Returning mock doc for ${docRef.path}`);
          const mockSnap = createMockDocumentSnapshot(docRef.id, docRef.path);
          recordTelemetry(mockSnap, true, 'Mock fallback quota exhaustion');
          return mockSnap;
        }
        throw err;
      }
    }
  })();

  pendingDocPromises.set(promiseKey, promise);
  try {
    return await promise;
  } finally {
    pendingDocPromises.delete(promiseKey);
  }
}

export async function getDocsOptimized(q: any, logPrefix?: string, forceServer: boolean = false) {
  const queryKey = logPrefix || JSON.stringify(q);
  const promiseKey = `${queryKey}_force_${forceServer}`;

  if (pendingQueryPromises.has(promiseKey)) {
    console.info(`[DE-DUP] Reusing in-flight promise for query: "${queryKey}" (forceServer: ${forceServer})`);
    return pendingQueryPromises.get(promiseKey)!;
  }

  const promise = (async () => {
    const invocationCount = (queryInvocationCounts.get(queryKey) || 0) + 1;
    queryInvocationCounts.set(queryKey, invocationCount);

    const now = Date.now();
    const cached = queryCache.get(queryKey);
    const ttl = getCacheTTL(queryKey);
    const isCacheValid = cached && (now - cached.timestamp < ttl);
    const resolvedReason = globalQuotaExhausted && !forceServer ? 'Quota exhausted cache fallback' :
                   isCacheValid && !forceServer ? 'Memory cache hit (TTL valid)' :
                   forceServer ? 'Force server fetch' : 'Cache miss or stale TTL';

    const recordTelemetry = (snap: any, hit: boolean, reas: string) => {
      const docCount = snap && (snap.size !== undefined ? snap.size : (snap.docs?.length || 0));
      const loc = extractCallingLocation();
      printFirestoreCostTelemetry(queryKey, reas, hit, docCount, invocationCount, loc.fileLine);
      firestoreLogger.trackReadDetailed({
        collection: extractCollectionName(q, queryKey),
        queryFingerprint: queryKey,
        caller: loc.fileLine,
        trigger: reas,
        resultCount: docCount,
        isCacheHit: hit
      });
    };

    console.info(`[FIRESTORE DIAGNOSTIC] Query: "${queryKey}", Invocation Count: ${invocationCount}, Reason: "${resolvedReason}", ForceServer: ${forceServer}`);

    // If quota is exhausted, prefer cache immediately unless forceServer is true
    if (globalQuotaExhausted && !forceServer) {
      if (cached) {
        if (logPrefix) console.info(`[QUOTA BYPASS] Returning memory query cache for ${logPrefix}`);
        recordTelemetry(cached.data, true, 'Quota exhausted cache fallback');
        return cached.data;
      }
      try {
        const cacheSnap = await getDocsFromCache(q);
        if (logPrefix) console.info(`[QUOTA BYPASS] Returning Firebase query cache for ${logPrefix}`);
        recordTelemetry(cacheSnap, true, 'Quota exhausted Firebase cache fallback');
        return cacheSnap;
      } catch (e) {
        // Continue to try server if no cache available
      }
    }

    // If we have a fresh cache hit, return it immediately to avoid server roundtrip
    if (!forceServer && cached && (now - cached.timestamp < ttl)) {
      if (logPrefix) console.log(`[MEMORY CACHE HIT] ${logPrefix} (TTL: ${ttl}ms)`);
      recordTelemetry(cached.data, true, 'Memory cache hit (TTL valid)');
      return cached.data;
    }

    const fetchFromServer = async () => {
      const snap = await getDocsFromServer(q);
      setQueryCache(queryKey, snap, q);
      globalQuotaExhausted = false; // Reset if successful
      if (logPrefix) console.log(`[SERVER FETCH] ${logPrefix}: ${snap.size} documents.`);
      recordTelemetry(snap, false, forceServer ? 'Force server fetch' : 'Cache miss or stale TTL');
      return snap;
    };

    const fetchFromCache = async () => {
      const snap = await getDocsFromCache(q);
      if (logPrefix) console.log(`[FIREBASE CACHE HIT] ${logPrefix}: ${snap.size} documents.`);
      recordTelemetry(snap, true, 'Firebase cache hit');
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
            const mockSnap = createMockQuerySnapshot(q, logPrefix);
            recordTelemetry(mockSnap, true, 'Mock fallback quota exhaustion');
            return mockSnap;
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
        if (cached) {
          recordTelemetry(cached.data, true, 'Stale memory cache fallback after fetch failure');
          return cached.data; // Return memory cache even if stale as last resort
        }
        if (isQuotaError || globalQuotaExhausted) {
          console.warn(`[QUOTA FALLBACK] Returning mock empty query snapshot for ${logPrefix}`);
          const mockSnap = createMockQuerySnapshot(q, logPrefix);
          recordTelemetry(mockSnap, true, 'Mock fallback quota exhaustion');
          return mockSnap;
        }
        throw err;
      }
    }
  })();

  pendingQueryPromises.set(promiseKey, promise);
  try {
    return await promise;
  } finally {
    pendingQueryPromises.delete(promiseKey);
  }
}

export async function getDocsCacheFirst(q: any, logPrefix?: string, forceServer: boolean = false) {
  if (!forceServer) {
    try {
      const cacheSnap = await getDocsFromCache(q);
      if (cacheSnap && !cacheSnap.empty) {
        if (logPrefix) console.log(`[CACHE FIRST HIT] ${logPrefix}: ${cacheSnap.size} document(s).`);
        printFirestoreCostTelemetry(logPrefix || JSON.stringify(q), 'Cache first hit', true, cacheSnap.size || 0, 1);
        return cacheSnap;
      }
    } catch (e) {
      // Cache miss or error reading cache, fall through to network fetch
    }
  }
  return await getDocsOptimized(q, logPrefix, forceServer);
}

export async function getDocCacheFirst(docRef: any, logPrefix?: string, forceServer: boolean = false) {
  if (!forceServer) {
    try {
      const cacheSnap = await getDocFromCache(docRef);
      if (cacheSnap && cacheSnap.exists()) {
        if (logPrefix) console.log(`[DOC CACHE FIRST HIT] ${logPrefix}`);
        printFirestoreCostTelemetry(logPrefix || docRef.path, 'Doc cache first hit', true, 1, 1);
        return cacheSnap;
      }
    } catch (e) {
      // Cache miss or error reading cache, fall through to network fetch
    }
  }
  return await getDocOptimized(docRef, logPrefix, forceServer);
}

export function invalidateCacheKey(key: string) {
  docCache.delete(key);
  queryCache.delete(key);
  console.log(`[CACHE] Invalidated cache key: ${key}`);
}

/**
 * Performs TARGETED shift cache invalidation.
 * Only invalidates queries and document caches that can actually be affected by the specific user/shift/supervisor mutation.
 * Preserves unrelated users, unrelated teams, other historical shift pages, and static configs.
 */
export function invalidateShiftCache(params: ShiftInvalidationParams = {}) {
  const { userId, shiftId, teamLeadUid, managerId, teamId, reason = 'shift_mutation' } = params;
  let invalidatedQueries = 0;
  let preservedQueries = 0;
  let invalidatedDocs = 0;
  let preservedDocs = 0;

  // 1. Invalidate matching queries in queryCache
  for (const [key, entry] of queryCache.entries()) {
    const meta = (entry as any).metadata as QueryCacheMetadata | undefined;
    const lowerKey = key.toLowerCase();

    // If it's not related to shifts or live_sessions, preserve it immediately
    const isShiftOrSession = lowerKey.includes('shift') || lowerKey.includes('session') || (meta && (meta.collection === 'tmsShifts' || meta.collection === 'live_sessions'));
    if (!isShiftOrSession) {
      preservedQueries++;
      continue;
    }

    let shouldInvalidate = false;

    // Check specific user match
    if (userId) {
      if (meta?.userIds && meta.userIds.length > 0) {
        if (meta.userIds.includes(userId)) {
          shouldInvalidate = true;
        }
      } else if (key.includes(userId)) {
        shouldInvalidate = true;
      }
    }

    // Check specific shiftId match
    if (shiftId) {
      if (meta?.shiftIds && meta.shiftIds.length > 0) {
        if (meta.shiftIds.includes(shiftId)) {
          shouldInvalidate = true;
        }
      } else if (key.includes(shiftId)) {
        shouldInvalidate = true;
      }
    }

    // Check supervisor / manager match
    if (teamLeadUid) {
      if (meta?.supervisorIds && meta.supervisorIds.includes(teamLeadUid)) {
        shouldInvalidate = true;
      } else if (key.includes(teamLeadUid)) {
        shouldInvalidate = true;
      }
    }
    if (managerId) {
      if (meta?.supervisorIds && meta.supervisorIds.includes(managerId)) {
        shouldInvalidate = true;
      } else if (key.includes(managerId)) {
        shouldInvalidate = true;
      }
    }
    if (teamId && key.includes(teamId)) {
      shouldInvalidate = true;
    }

    // If no specific userId/shiftId/supervisorId was provided (e.g. broad administrative wipe), invalidate shift queries
    if (!userId && !shiftId && !teamLeadUid && !managerId && !teamId) {
      shouldInvalidate = true;
    }

    if (shouldInvalidate) {
      queryCache.delete(key);
      invalidatedQueries++;
    } else {
      preservedQueries++;
    }
  }

  // 2. Invalidate matching docCache entries
  for (const [key, entry] of docCache.entries()) {
    const meta = (entry as any).metadata as DocCacheMetadata | undefined;
    const lowerKey = key.toLowerCase();
    const isShiftOrSession = lowerKey.includes('shift') || lowerKey.includes('session') || lowerKey.includes('live_sessions') || lowerKey.includes('tmsshifts');
    if (!isShiftOrSession) {
      preservedDocs++;
      continue;
    }

    let shouldInvalidate = false;
    if (userId && (key.includes(userId) || (meta && meta.docId === userId))) {
      shouldInvalidate = true;
    }
    if (shiftId && (key.includes(shiftId) || (meta && meta.docId === shiftId))) {
      shouldInvalidate = true;
    }
    if (!userId && !shiftId && !teamLeadUid && !managerId) {
      shouldInvalidate = true;
    }

    if (shouldInvalidate) {
      docCache.delete(key);
      invalidatedDocs++;
    } else {
      preservedDocs++;
    }
  }

  // 3. Notify registered listeners (such as useHistoricalShifts firstPageCache)
  shiftInvalidationListeners.forEach(listener => {
    try {
      listener(params);
    } catch (e) {
      console.warn('[CACHE_INVALIDATION_LISTENER_ERR]', e);
    }
  });

  globalQuotaExhausted = false;

  const totalInvalidated = invalidatedQueries + invalidatedDocs;
  const totalPreserved = preservedQueries + preservedDocs;

  console.info(
    `[CACHE_INVALIDATION] collection=tmsShifts reason=${reason} userId=${userId || 'all'} shiftId=${shiftId || 'none'} invalidated=${totalInvalidated} (queries:${invalidatedQueries}, docs:${invalidatedDocs}) preserved=${totalPreserved} (queries:${preservedQueries}, docs:${preservedDocs})`
  );
}

export function clearCache() {
  // Legacy / fallback broad cache invalidation (used for full auth logout or general system reset)
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
  
  // Notify listeners with empty params to clear hook-level caches
  shiftInvalidationListeners.forEach(listener => {
    try {
      listener({});
    } catch (e) {}
  });

  globalQuotaExhausted = false; // Reset quota block on cache invalidations so we retry server fetches
  console.log(`[CACHE] Selective caches cleared (${clearedCount} entries) and quota block reset.`);
}

/**
 * Tracks a Firestore onSnapshot listener with precise telemetry and cost profiling.
 */
export function trackSnapshot(
  queryDescription: string,
  q: any,
  onNext: (snap: any) => void,
  onError?: (err: any) => void
) {
  const startTime = Date.now();
  let initialDocs = 0;
  let updates = 0;
  let reconnects = 0;
  let estimatedReads = 0;
  let isFirst = true;
  let wasOffline = false;

  console.info(`[FIRESTORE LISTENER START] Registering listener for: "${queryDescription}"`);

  const handleNext = (snap: any) => {
    const docCount = snap.size || 0;
    
    if (isFirst) {
      initialDocs = docCount;
      estimatedReads += docCount;
      isFirst = false;
      console.info(`[FIRESTORE LISTENER FIRST] "${queryDescription}" loaded with ${docCount} initial documents.`);
    } else {
      updates += 1;
      const changes = snap.docChanges();
      const relevantChangesCount = changes.filter((c: any) => c.type === 'added' || c.type === 'modified').length;
      estimatedReads += relevantChangesCount;
      
      if (wasOffline) {
        reconnects += 1;
        wasOffline = false;
        console.info(`[FIRESTORE LISTENER RECONNECT] "${queryDescription}" reconnected. Updates: ${updates}, Reconnects: ${reconnects}`);
      }
    }
    
    onNext(snap);
  };

  const handleError = (err: any) => {
    const isOfflineErr = err.message?.includes('offline') || err.code === 'unavailable';
    if (isOfflineErr) {
      wasOffline = true;
    }
    if (onError) {
      onError(err);
    } else {
      console.error(`[FIRESTORE LISTENER ERROR] "${queryDescription}":`, err);
    }
  };

  const unsub = onSnapshot(q, handleNext, handleError);

  return () => {
    const lifetimeMs = Date.now() - startTime;
    unsub();
    
    console.info(`
[FIRESTORE LISTENER]
query=${queryDescription}
initialDocs=${initialDocs}
updates=${updates}
reconnects=${reconnects}
lifetimeMs=${lifetimeMs}
estimatedReads=${estimatedReads}
`);
  };
}




