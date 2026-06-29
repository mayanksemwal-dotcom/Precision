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
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, onSnapshot, getDocs, getDocFromServer, enableIndexedDbPersistence, getDocsFromCache, getDocsFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

if (!firebaseConfig || !firebaseConfig.apiKey) {
  console.error("Firebase configuration is missing or invalid. Check firebase-applet-config.json.");
}

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// 2. Direct Database Setup (Safest approach to avoid startup loading hangs)
export const db = (firebaseConfig as any).firestoreDatabaseId 
  ? getFirestore(app, (firebaseConfig as any).firestoreDatabaseId)
  : getFirestore(app);

// Enable offline persistence to reduce redundant network reads/billing
enableIndexedDbPersistence(db).then(() => {
  console.log("Firestore offline persistence enabled successfully.");
}).catch((err) => {
  if (err.code === 'failed-precondition') {
    // Multiple tabs open, persistence can only be enabled in one tab at a time.
    console.warn("Firestore persistence failed: Multiple tabs open. Local caching works on active tab.");
  } else if (err.code === 'unimplemented') {
    // The current browser does not support all of the features required to enable persistence
    console.warn("Firestore persistence failed: Browser does not support offline storage.");
  } else {
    console.error("Firestore persistence error:", err);
  }
});

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
  await signOut(auth);
  cachedAccessToken = null;
};

// 3. Optional: Background verification.
// The primary profile handling is now managed in App.tsx's Auth listener.
export async function syncUserProfile(user: User, authProvider: 'google' | 'email') {
  const path = `users/${user.uid}`;
  try {
    console.log(`Syncing profile: UID=${user.uid}, Email=${user.email}, Collection=users, Path=${path}`);
    const userRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userRef);
    
    if (!userDoc.exists()) {
      // Check for pre-provisioned profile under a different ID (like a local_ ID)
      const usersRef = collection(db, 'users');
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
          await deleteDoc(doc(db, 'users', matchedDoc.id));
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

export async function getDocsOptimized(q: any, logPrefix?: string, forceServer: boolean = false) {
  if (forceServer) {
    const snap = await getDocsFromServer(q);
    if (logPrefix) {
      console.log(`[SERVER FETCH (FORCED)] ${logPrefix}: ${snap.size} documents fetched from Firestore server.`);
    }
    return snap;
  }

  try {
    const snap = await getDocsFromServer(q);
    if (logPrefix) {
      console.log(`[SERVER FETCH] ${logPrefix}: ${snap.size} documents fetched from Firestore server.`);
    }
    return snap;
  } catch (err) {
    console.warn(`[SERVER FETCH FAILED] ${logPrefix || 'Query'} - falling back to offline cache...`, err);
    try {
      const snap = await getDocsFromCache(q);
      if (logPrefix) {
        console.log(`[CACHE FALLBACK] ${logPrefix}: ${snap.size} documents loaded from offline cache.`);
      }
      return snap;
    } catch (cacheErr) {
      console.error(`[CACHE FALLBACK FAILED] ${logPrefix || 'Query'}:`, cacheErr);
      throw err; // Throw the original server error if cache fallback also fails
    }
  }
}



