import { initializeApp } from 'firebase/app';
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
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, onSnapshot, getDocs, getDocFromServer } from 'firebase/firestore';
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

const googleProvider = new GoogleAuthProvider();

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
  return await signInWithPopup(auth, googleProvider);
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
    console.error('CRITICAL: Firestore Permission Denied!', JSON.stringify(errInfo));
  } else {
    console.error('Firestore Error: ', JSON.stringify(errInfo));
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



