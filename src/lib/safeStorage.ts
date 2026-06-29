
/**
 * Safe Storage Wrapper
 * Handles QuotaExceededError and provides fallbacks for localStorage/sessionStorage
 * and an in-memory fallback to ensure the application never crashes on storage failures.
 */

const memoryCache: Record<string, string> = {};

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
            console.error(`[SafeStorage] Persistent quota failure for key: ${key}. Falling back to memory-only storage.`);
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
