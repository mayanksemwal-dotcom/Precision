import { getApp } from 'firebase/app';
import { getDatabase, ref, set, update, remove, onValue, off, serverTimestamp, get } from 'firebase/database';
import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from './firebase';
import firebaseConfig from '../../firebase-applet-config.json';

// Realtime Database presence layer configuration
// When RTDB is not provisioned with custom security rules, the application uses Firestore's verified live_sessions collection directly.
let rtdbInstance: any = null;
let isRtdbActive = false;

// If explicitly provided via config with custom databaseURL, enable RTDB; otherwise use Firestore
if ((firebaseConfig as any).enableRTDB && (firebaseConfig as any).databaseURL) {
  try {
    const app = getApp();
    rtdbInstance = getDatabase(app, (firebaseConfig as any).databaseURL);
    isRtdbActive = true;
    console.info('⚡ [RTDB ENGINE] Successfully initialized Realtime Database presence layer.');
  } catch (err) {
    isRtdbActive = false;
  }
} else {
  // Use Firestore collection 'live_sessions' directly with full security rules
  isRtdbActive = false;
}

export const rtdb = rtdbInstance;
export { isRtdbActive };

/**
 * Update a live session in both RTDB (primary) and Firestore (mirror/fallback) to ensure near-zero costs while retaining compatibility.
 */
export async function writeLiveSession(uid: string, data: any, isHeartbeatOnly = false) {
  const cleanData = {
    ...data,
    updatedAt: new Date().toISOString(),
    _source: isRtdbActive ? 'rtdb' : 'firestore'
  };

  // 1. RTDB (Primary presence layer: heartbeats, active status, timers)
  if (isRtdbActive && rtdb) {
    try {
      const sessionRef = ref(rtdb, `live_sessions/${uid}`);
      await set(sessionRef, {
        ...cleanData,
        lastHeartbeatEpoch: serverTimestamp() // RTDB native timestamp for bandwidth-optimized offline checks
      });
      console.log(`📡 [RTDB WRITE] presence updated for user=${uid}`);
      
      // If RTDB is active, bypass Firestore write-mirroring to save 100% of heartbeat write billing costs
      return;
    } catch (err) {
      console.warn('⚠️ [RTDB WRITE FAIL] Falling back to Firestore for session write:', err);
      isRtdbActive = false; // Mark inactive to trigger fallback
    }
  }

  // 2. Firestore Fallback (Only executed if RTDB is inactive/unreachable)
  try {
    const fsRef = doc(db, 'live_sessions', uid);
    await setDoc(fsRef, cleanData, { merge: true });
    console.log(`🔥 [FIRESTORE FALLBACK WRITE] Active session written to Firestore for user=${uid}`);
  } catch (err) {
    console.error('❌ [FIRESTORE WRITE FAIL] Critical: Could not write active session to Firestore fallback:', err);
  }
}

/**
 * Remove a live session on logout or clock-out
 */
export async function removeLiveSession(uid: string) {
  // 1. RTDB removal
  if (isRtdbActive && rtdb) {
    try {
      const sessionRef = ref(rtdb, `live_sessions/${uid}`);
      await remove(sessionRef);
      console.log(`📡 [RTDB DELETE] Removed active session for user=${uid}`);
    } catch (err) {
      console.warn('⚠️ [RTDB DELETE FAIL] Fallback deletion to Firestore:', err);
    }
  }

  // 2. Firestore removal
  try {
    const fsRef = doc(db, 'live_sessions', uid);
    await deleteDoc(fsRef);
    console.log(`🔥 [FIRESTORE DELETE] Removed active session for user=${uid}`);
  } catch (err) {
    console.error('❌ [FIRESTORE DELETE FAIL] Critical: Could not delete active session document:', err);
  }
}

/**
 * Fetch or listen to live sessions from RTDB if active, otherwise fallback to Firestore.
 */
export function listenLiveSessions(onData: (sessions: any[]) => void, onError: (err: any) => void) {
  if (isRtdbActive && rtdb) {
    const sessionsRef = ref(rtdb, 'live_sessions');
    const unsubscribe = onValue(sessionsRef, (snapshot) => {
      const val = snapshot.val();
      if (!val) {
        onData([]);
        return;
      }
      const list = Object.keys(val).map(key => ({
        id: key,
        ...val[key]
      }));
      onData(list);
    }, (err) => {
      console.warn('⚠️ [RTDB LISTEN FAIL] falling back to Firestore listener:', err);
      isRtdbActive = false;
      // Do not trigger global error yet; trigger fallback instead
      onError(err);
    });

    return () => off(sessionsRef, 'value', unsubscribe);
  }
  return null;
}

/**
 * Fetch live sessions once from RTDB with transparent fallback.
 */
export async function fetchLiveSessionsOnce(): Promise<any[] | null> {
  if (isRtdbActive && rtdb) {
    try {
      const sessionsRef = ref(rtdb, 'live_sessions');
      const timeoutPromise = new Promise<null>((_, reject) => 
        setTimeout(() => reject(new Error('RTDB_TIMEOUT')), 2000)
      );

      const snapshot = await Promise.race([get(sessionsRef), timeoutPromise]) as any;
      if (!snapshot) return null;
      const val = snapshot.val();
      if (!val) return [];
      return Object.keys(val).map(key => ({
        id: key,
        ...val[key]
      }));
    } catch (err: any) {
      if (err?.message === 'RTDB_TIMEOUT') {
        isRtdbActive = false;
      }
      console.info('ℹ️ [RTDB FETCH ONCE TIMEOUT/FAIL] falling back to Firestore/cache:', err?.message || err);
      return null;
    }
  }
  return null;
}
