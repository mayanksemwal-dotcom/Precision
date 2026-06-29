/**
 * SAFE FIRESTORE WRAPPER
 * ---------------------
 * Prevents Firestore access if quota exceeded previously,
 * adds centralized error handling, and provides a lightweight mechanism
 * for graceful app degradation.
 */

import { FirestoreError } from 'firebase/firestore';
import { firestoreLogger } from './firestoreLogger';
import { safeStorage } from './safeStorage';

const QUOTA_BLOCK_KEY = 'precision360_firestore_blocked';

export function isFirestoreBlocked(): boolean {
  if (typeof window !== 'undefined') {
    return safeStorage.get(QUOTA_BLOCK_KEY) === 'true';
  }
  return false;
}

export function handleFirestoreError(error: any, op: string, collection: string) {
  const stats = firestoreLogger.getStats();
  console.error(`Firestore Error [${op}] on [${collection}] (Cumulative Reads: ${stats.totalReads}, Writes: ${stats.totalWrites}):`, error);

  if (error instanceof FirestoreError) {
    if (error.code === 'resource-exhausted') {
      console.error('RESOURCE EXHAUSTED: Blocking further Firestore reads.');
      if (typeof window !== 'undefined') {
        safeStorage.set(QUOTA_BLOCK_KEY, 'true');
      }
      // Reload to trigger fallback state if blocked at boot
      window.location.reload(); 
    }
  }
}
