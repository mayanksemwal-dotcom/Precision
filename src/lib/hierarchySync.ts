import { doc, setDoc, getDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebase';
import { safeStorage } from './safeStorage';

export interface HierarchyVersionMeta {
  version: number;
  updatedAt: string;
  updatedBy: string;
}

const HIERARCHY_META_DOC = 'hierarchy_version';
const HIERARCHY_META_COLLECTION = 'system_meta';

/**
 * Bumps the global hierarchy version in Firestore.
 * This triggers real-time recalculation across all active client dashboards and invalidates stale caches.
 */
export async function bumpHierarchyVersion(updatedBy?: string): Promise<number> {
  const newVersion = Date.now();
  const email = updatedBy || auth.currentUser?.email || auth.currentUser?.uid || 'system';
  const nowISO = new Date().toISOString();

  try {
    const metaRef = doc(db, HIERARCHY_META_COLLECTION, HIERARCHY_META_DOC);
    await setDoc(metaRef, {
      version: newVersion,
      updatedAt: nowISO,
      updatedBy: email,
      lastModified: serverTimestamp()
    }, { merge: true });

    // Invalidate local subordinate caches immediately
    try {
      await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
    } catch (e) {
      // Non-blocking
    }

    console.info(`⚡ [HIERARCHY VERSION BUMPED] Version: ${newVersion} by ${email}`);
  } catch (err) {
    console.warn('Failed to bump hierarchy version in Firestore:', err);
  }

  return newVersion;
}

/**
 * Retrieves the current hierarchy version document from Firestore.
 */
export async function getHierarchyVersion(): Promise<number | null> {
  try {
    const metaRef = doc(db, HIERARCHY_META_COLLECTION, HIERARCHY_META_DOC);
    const snap = await getDoc(metaRef);
    if (snap.exists()) {
      const data = snap.data();
      return typeof data?.version === 'number' ? data.version : null;
    }
  } catch (err) {
    console.warn('Failed to fetch hierarchy version:', err);
  }
  return null;
}

/**
 * Listens to remote hierarchy version updates in Firestore.
 * Returns an unsubscribe function.
 */
export function subscribeToHierarchyVersion(onVersionChange: (version: number, meta: HierarchyVersionMeta) => void): () => void {
  try {
    const metaRef = doc(db, HIERARCHY_META_COLLECTION, HIERARCHY_META_DOC);
    return onSnapshot(metaRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const v = data?.version;
        if (typeof v === 'number') {
          onVersionChange(v, {
            version: v,
            updatedAt: data?.updatedAt || '',
            updatedBy: data?.updatedBy || ''
          });
        }
      }
    }, (error) => {
      console.warn('[HierarchySync] Version listener error:', error);
    });
  } catch (err) {
    console.warn('[HierarchySync] Failed to initialize version listener:', err);
    return () => {};
  }
}
