import { useEffect } from 'react';
import { pruneExpiredMemoryCache, purgeAllMemoryCaches } from '../lib/firebase';
import { toast } from 'sonner';

const PRUNE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes background prune
const AWAY_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes away -> auto prune
const AWAY_PURGE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours away -> full memory purge

export function manualMemoryCleanAndSync(): number {
  const clearedCount = purgeAllMemoryCaches();
  
  // Try triggering browser garbage collection hint if available
  if (typeof window !== 'undefined' && 'gc' in window && typeof (window as any).gc === 'function') {
    try {
      (window as any).gc();
    } catch (e) {
      // Ignored
    }
  }

  // Dispatch custom event so components can re-query if needed
  window.dispatchEvent(new CustomEvent('app_memory_cleaned', { detail: { clearedCount } }));
  
  toast.success(`Memory cleaned! ${clearedCount} cached entries cleared & re-synced.`, {
    description: 'Stale memory caches flushed successfully.'
  });

  return clearedCount;
}

export function useMemoryGuard() {
  useEffect(() => {
    let lastActiveTime = Date.now();

    // 1. Periodic background maintenance sweep every 15 minutes
    const intervalId = setInterval(() => {
      pruneExpiredMemoryCache();
    }, PRUNE_INTERVAL_MS);

    // 2. Tab Visibility & Focus Guard
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        const awayDuration = now - lastActiveTime;
        lastActiveTime = now;

        if (awayDuration > AWAY_PURGE_THRESHOLD_MS) {
          console.log(`[MEMORY GUARD] Returning after ${Math.round(awayDuration / (60 * 1000))} minutes. Performing full memory purge...`);
          purgeAllMemoryCaches();
          window.dispatchEvent(new CustomEvent('app_memory_cleaned', { detail: { reason: 'long_idle_recovery' } }));
        } else if (awayDuration > AWAY_STALE_THRESHOLD_MS) {
          console.log(`[MEMORY GUARD] Returning after ${Math.round(awayDuration / (60 * 1000))} minutes. Pruning expired cache...`);
          pruneExpiredMemoryCache();
        }
      } else {
        lastActiveTime = Date.now();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, []);
}
