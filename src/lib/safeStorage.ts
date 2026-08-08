
/**
 * Safe Storage Wrapper
 * Handles QuotaExceededError and provides fallbacks for localStorage/sessionStorage
 * and an in-memory fallback to ensure the application never crashes on storage failures.
 */

const memoryCache: Record<string, string> = {};

const DB_NAME = 'precision360_db';
const STORE_NAME = 'cache_store';

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error('IndexedDB open timed out'));
    }, 1000);
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        try {
          request.result.createObjectStore(STORE_NAME);
        } catch (e) {}
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        reject(request.error);
      };
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
};

export const safeStorage = {
  set: (key: string, value: any): boolean => {
    try {
      if (typeof window === 'undefined') return false;
      
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      
      // Always update memory cache as the most reliable fallback
      memoryCache[key] = stringValue;
      
      if (!window.localStorage) return true;

      try {
        localStorage.setItem(key, stringValue);
        return true;
      } catch (error: any) {
        const errorMessage = (error?.message || '').toLowerCase();
        const isQuotaError = 
          error.name === 'QuotaExceededError' || 
          error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || 
          error.code === 22 ||
          errorMessage.includes('quota') ||
          errorMessage.includes('exceeded');

        if (isQuotaError) {
          console.warn(`[SafeStorage] Quota exceeded for key: ${key}. Attempting to clear cache to make room...`);
          
          // Clear known large cache keys
          const keysToClear = [
            'precision360_roster_cache',
            'precision360_profiles_cache',
            'precision360_cache_timestamp'
          ];
          
          keysToClear.forEach(k => {
            try {
              localStorage.removeItem(k);
              delete memoryCache[k];
            } catch (e) {}
          });

          // Attempt retry
          try {
            localStorage.setItem(key, stringValue);
            return true;
          } catch (retryError) {
            console.warn(`[SafeStorage] Persistent quota failure for key: ${key}. Falling back to memory-only storage.`);
            // We already updated memoryCache, so we just return true to indicate it "saved" (somewhere)
            return true; 
          }
        }
        
        console.error(`[SafeStorage] Non-quota error setting key ${key}:`, error);
        return true; // Still return true because we have the memory fallback
      }
    } catch (error) {
      console.error(`[SafeStorage] Critical failure in set(${key}):`, error);
      return false;
    }
  },

  get: <T>(key: string): T | null => {
    try {
      if (typeof window === 'undefined') return null;
      
      // Check memory cache first (most up-to-date in case of quota failures)
      let value = memoryCache[key];
      
      // If not in memory, try localStorage
      if (!value && window.localStorage) {
        value = localStorage.getItem(key) || '';
        if (value) {
          memoryCache[key] = value; // Sync to memory
        }
      }
      
      if (!value) return null;
      
      try {
        return JSON.parse(value) as T;
      } catch (e) {
        return value as unknown as T;
      }
    } catch (error) {
      console.error(`[SafeStorage] Error getting key ${key}:`, error);
      return null;
    }
  },

  setIndexedDB: async <T>(key: string, value: T): Promise<void> => {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const data = { value, timestamp: Date.now() };
      store.put(data, key);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error(`[SafeStorage] Error setting IndexedDB key ${key}:`, error);
    }
  },

  getIndexedDB: async <T>(key: string, ttlMs: number): Promise<T | null> => {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          const result = request.result;
          if (!result) {
            resolve(null);
            return;
          }
          if (Date.now() - result.timestamp > ttlMs) {
            resolve(null);
            return;
          }
          resolve(result.value as T);
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error(`[SafeStorage] Error getting IndexedDB key ${key}:`, error);
      return null;
    }
  },

  deleteIndexedDB: async (key: string): Promise<void> => {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(key);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error(`[SafeStorage] Error deleting IndexedDB key ${key}:`, error);
    }
  },

  clearAllIndexedDBByPrefix: async (prefix: string): Promise<void> => {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      
      return new Promise((resolve, reject) => {
        request.onsuccess = (event: any) => {
          const cursor = event.target.result;
          if (cursor) {
            const key = cursor.key.toString();
            if (key.startsWith(prefix)) {
              cursor.delete();
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error(`[SafeStorage] Error clearing IndexedDB prefix ${prefix}:`, error);
    }
  },

  remove: (key: string): void => {
    try {
      delete memoryCache[key];
      if (typeof window === 'undefined' || !window.localStorage) return;
      localStorage.removeItem(key);
    } catch (error) {
      console.error(`[SafeStorage] Error removing key ${key}:`, error);
    }
  },

  clearAllByPrefix: (prefix: string): void => {
    try {
      Object.keys(memoryCache).forEach(k => {
        if (k.startsWith(prefix)) delete memoryCache[k];
      });

      if (typeof window === 'undefined' || !window.localStorage) return;
      const keys = Object.keys(localStorage);
      keys.forEach(key => {
        if (key.startsWith(prefix)) {
          localStorage.removeItem(key);
        }
      });
    } catch (error) {
      console.error(`[SafeStorage] Error clearing prefix ${prefix}:`, error);
    }
  }
};
