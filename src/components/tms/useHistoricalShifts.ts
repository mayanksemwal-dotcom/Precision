import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { collection, query, where, orderBy, limit, startAfter, QueryDocumentSnapshot } from 'firebase/firestore';
import { db, getDocsOptimized, registerShiftInvalidationListener, ShiftInvalidationParams } from '../../lib/firebase';
import { TMSShift } from '../../views/TMSView';

// Cache map for first page of historical shifts per query configuration
interface CacheEntry {
  shifts: TMSShift[];
  lastDoc: QueryDocumentSnapshot | null;
  hasMore: boolean;
  timestamp: number;
}

const firstPageCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<{ shifts: TMSShift[]; lastDoc: QueryDocumentSnapshot | null; hasMore: boolean }>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL

/**
 * Invalidates only firstPageCache entries affected by a specific shift mutation.
 */
export function invalidateHistoricalShiftsCache(params: ShiftInvalidationParams = {}) {
  const { userId, teamLeadUid, managerId } = params;
  let cleared = 0;
  for (const [key] of firstPageCache.entries()) {
    let match = false;
    if (userId && key.includes(userId)) match = true;
    if (teamLeadUid && key.includes(teamLeadUid)) match = true;
    if (managerId && key.includes(managerId)) match = true;
    if (!userId && !teamLeadUid && !managerId) match = true; // full clear if no scope provided

    if (match) {
      firstPageCache.delete(key);
      cleared++;
    }
  }
  if (cleared > 0) {
    console.info(`[HISTORICAL_CACHE_INVALIDATED] Cleared ${cleared} firstPageCache entries for user/supervisor: ${userId || teamLeadUid || managerId || 'all'}`);
  }
}

// Auto-register with global targeted shift invalidation system
if (typeof window !== 'undefined') {
  registerShiftInvalidationListener((params) => {
    invalidateHistoricalShiftsCache(params);
  });
}

/**
 * Normalizes a date into a stable UTC day boundary ISO string.
 * Default window is strictly Past 2 Days (Today + yesterday) to minimize query costs and fit within daily budget.
 * This ensures the boundary is identical throughout the entire 24h day and does NOT change per millisecond/render.
 */
export function getStableLowerBoundIso(startDate?: string): string {
  if (startDate) {
    const parsed = new Date(startDate);
    if (!isNaN(parsed.getTime())) {
      // Normalize to start of UTC day minus 6 hours to capture overnight shifts that started the previous evening
      const startOfDayUtc = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 0, 0, 0, 0);
      return new Date(startOfDayUtc - 6 * 60 * 60 * 1000).toISOString();
    }
    return startDate;
  }
  // Strict Default: Midnight UTC of 2 days ago (Today + past 2 days window to eliminate unbound historical scans)
  const now = new Date();
  const twoDaysAgoUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 0, 0, 0, 0);
  return new Date(twoDaysAgoUtc).toISOString();
}

/**
 * Normalizes an upper date boundary into a stable UTC day boundary ISO string.
 */
export function getStableUpperBoundIso(endDate?: string): string | undefined {
  if (endDate) {
    const parsed = new Date(endDate);
    if (!isNaN(parsed.getTime())) {
      // Normalize to end of UTC day plus 6 hours to capture overnight shifts ending the next morning
      const endOfDayUtc = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 23, 59, 59, 999);
      return new Date(endOfDayUtc + 6 * 60 * 60 * 1000).toISOString();
    }
    return endDate;
  }
  return undefined;
}

/**
 * Builds a deterministic, stable cache key based on query parameters
 */
function buildStableCacheKey(
  uid: string | undefined,
  role: string | undefined,
  itemsPerPage: number,
  userIds: string[] | undefined,
  lowerBoundIso: string,
  upperBoundIso: string | undefined
): string {
  const normUid = uid || 'anon';
  const normRole = (role || 'AGENT').toUpperCase().trim();
  
  let userScopePart = 'global';
  if (userIds && userIds.length > 0) {
    if (userIds.length <= 10) {
      userScopePart = [...userIds].sort().join(',');
    } else {
      const sorted = [...userIds].sort();
      userScopePart = `uids_${userIds.length}_${sorted.slice(0, 3).join('_')}_${sorted.slice(-2).join('_')}`;
    }
  }

  return `hist_${normUid}_${normRole}_${itemsPerPage}_${userScopePart}_${lowerBoundIso}_${upperBoundIso || 'open'}`;
}

export function useHistoricalShifts(
  uid?: string, 
  role?: string, 
  itemsPerPage: number = 5, 
  enabled: boolean = true, 
  userIds?: string[],
  startDate?: string,
  endDate?: string
) {
  const [shifts, setShifts] = useState<TMSShift[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot | null>(null);
  const [hasMore, setHasMore] = useState(true);

  // Maintain stable serialized representation of userIds
  const serializedUserIds = useMemo(() => {
    if (!userIds || userIds.length === 0) return '';
    return [...userIds].sort().join(',');
  }, [userIds]);

  const stableLowerBound = useMemo(() => getStableLowerBoundIso(startDate), [startDate]);
  const stableUpperBound = useMemo(() => getStableUpperBoundIso(endDate), [endDate]);

  const currentCacheKey = useMemo(() => {
    return buildStableCacheKey(uid, role, itemsPerPage, userIds, stableLowerBound, stableUpperBound);
  }, [uid, role, itemsPerPage, serializedUserIds, stableLowerBound, stableUpperBound]);

  const lastFetchedKeyRef = useRef<string>('');
  const lastDocRef = useRef<QueryDocumentSnapshot | null>(null);
  lastDocRef.current = lastDoc;

  const fetchFirstPage = useCallback(async (forceRefresh = false) => {
    if (!uid) return;

    const cacheKey = currentCacheKey;
    const now = Date.now();
    const cached = firstPageCache.get(cacheKey);

    // 1. Check in-memory TTL cache
    if (cached && (now - cached.timestamp < CACHE_TTL_MS) && !forceRefresh) {
      setShifts(cached.shifts);
      setLastDoc(cached.lastDoc);
      setHasMore(cached.hasMore);
      lastFetchedKeyRef.current = cacheKey;
      return;
    }

    // 2. Prevent duplicate in-flight requests for the exact same query
    if (inFlightRequests.has(cacheKey) && !forceRefresh) {
      try {
        setLoading(true);
        const res = await inFlightRequests.get(cacheKey)!;
        setShifts(res.shifts);
        setLastDoc(res.lastDoc);
        setHasMore(res.hasMore);
        lastFetchedKeyRef.current = cacheKey;
      } catch (err: any) {
        setError(err);
      } finally {
        setLoading(false);
      }
      return;
    }

    const fetchPromise = (async () => {
      const normRole = (role || '').toUpperCase().trim();
      const checkIsGlobalRole = (r: string) => {
        const upper = r.toUpperCase().trim();
        const globals = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP'];
        return globals.some(g => upper.includes(g));
      };

      const isGlobalRole = checkIsGlobalRole(normRole);
      const isSupervisorOrTL = isGlobalRole || ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'SME', 'TEAM LEAD', 'OPS TL', 'TEAM LEADER', 'MANAGER', 'ASSISTANT_MANAGER', 'SUPERVISOR'].includes(normRole);

      let fetchedShifts: TMSShift[] = [];
      let finalLastDoc: QueryDocumentSnapshot | null = null;
      let moreAvailable = false;

      if (userIds && userIds.length > 0 && userIds.length <= 30) {
        // Scoped User IDs query: only use IN queries if list is small (<= 30) to prevent massive scan loops
        const chunks: string[][] = [];
        for (let i = 0; i < userIds.length; i += 30) {
          chunks.push(userIds.slice(i, i + 30));
        }

        const chunkPromises = chunks.map((chunk, idx) => {
          const constraints: any[] = [
            where('userId', 'in', chunk),
            where('clockInTime', '>=', stableLowerBound)
          ];
          if (stableUpperBound) {
            constraints.push(where('clockInTime', '<=', stableUpperBound));
          }
          // Fetch only itemsPerPage records per chunk
          constraints.push(orderBy('clockInTime', 'desc'), limit(itemsPerPage));

          const cq = query(collection(db, 'tmsShifts'), ...constraints);
          return getDocsOptimized(cq, `historical_shifts_chunk_${idx}_${cacheKey}`, forceRefresh);
        });

        const snapshots = await Promise.all(chunkPromises);
        const combinedDocs: QueryDocumentSnapshot[] = [];
        snapshots.forEach(snap => {
          snap.docs.forEach(d => combinedDocs.push(d as QueryDocumentSnapshot));
        });

        // Sort descending by clockInTime across all chunks
        combinedDocs.sort((a, b) => {
          const tA = new Date(a.data().clockInTime).getTime();
          const tB = new Date(b.data().clockInTime).getTime();
          return tB - tA;
        });

        // Take only the first itemsPerPage records
        const finalDocs = combinedDocs.slice(0, itemsPerPage);
        fetchedShifts = finalDocs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
        finalLastDoc = finalDocs.length > 0 ? finalDocs[finalDocs.length - 1] : null;
        moreAvailable = finalDocs.length === itemsPerPage;
      } else if (isGlobalRole) {
        // Global view: single paginated indexed query
        const constraints: any[] = [
          where('clockInTime', '>=', stableLowerBound)
        ];
        if (stableUpperBound) {
          constraints.push(where('clockInTime', '<=', stableUpperBound));
        }
        constraints.push(orderBy('clockInTime', 'desc'), limit(itemsPerPage));

        const q = query(collection(db, 'tmsShifts'), ...constraints);
        const snapshot = await getDocsOptimized(q, `historical_shifts_global_${cacheKey}`, forceRefresh);
        fetchedShifts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
        finalLastDoc = snapshot.docs.length > 0 ? (snapshot.docs[snapshot.docs.length - 1] as QueryDocumentSnapshot) : null;
        moreAvailable = snapshot.docs.length === itemsPerPage;
      } else if (isSupervisorOrTL) {
        // Supervisor fallback when no explicit userIds array passed
        const isManagerRole = ['MANAGER', 'ASSISTANT_MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD'].includes(normRole);
        const supervisorField = isManagerRole ? 'managerId' : 'teamLeadUid';

        const constraints: any[] = [
          where(supervisorField, '==', uid),
          where('clockInTime', '>=', stableLowerBound)
        ];
        if (stableUpperBound) {
          constraints.push(where('clockInTime', '<=', stableUpperBound));
        }
        constraints.push(orderBy('clockInTime', 'desc'), limit(itemsPerPage));

        const q = query(collection(db, 'tmsShifts'), ...constraints);
        const snapshot = await getDocsOptimized(q, `historical_shifts_sup_${cacheKey}`, forceRefresh);
        fetchedShifts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
        finalLastDoc = snapshot.docs.length > 0 ? (snapshot.docs[snapshot.docs.length - 1] as QueryDocumentSnapshot) : null;
        moreAvailable = snapshot.docs.length === itemsPerPage;
      } else {
        // Individual agent fallback
        const constraints: any[] = [
          where('userId', '==', uid),
          where('clockInTime', '>=', stableLowerBound)
        ];
        if (stableUpperBound) {
          constraints.push(where('clockInTime', '<=', stableUpperBound));
        }
        constraints.push(orderBy('clockInTime', 'desc'), limit(itemsPerPage));

        const q = query(collection(db, 'tmsShifts'), ...constraints);
        const snapshot = await getDocsOptimized(q, `historical_shifts_agent_${cacheKey}`, forceRefresh);
        fetchedShifts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
        finalLastDoc = snapshot.docs.length > 0 ? (snapshot.docs[snapshot.docs.length - 1] as QueryDocumentSnapshot) : null;
        moreAvailable = snapshot.docs.length === itemsPerPage;
      }

      // Save to memory cache
      firstPageCache.set(cacheKey, {
        shifts: fetchedShifts,
        lastDoc: finalLastDoc,
        hasMore: moreAvailable,
        timestamp: Date.now()
      });

      return {
        shifts: fetchedShifts,
        lastDoc: finalLastDoc,
        hasMore: moreAvailable
      };
    })();

    inFlightRequests.set(cacheKey, fetchPromise);

    try {
      setLoading(true);
      setError(null);
      const result = await fetchPromise;
      setShifts(result.shifts);
      setLastDoc(result.lastDoc);
      setHasMore(result.hasMore);
      lastFetchedKeyRef.current = cacheKey;
    } catch (err: any) {
      console.error('[useHistoricalShifts] Error fetching historical shifts:', err);
      setError(err);
    } finally {
      inFlightRequests.delete(cacheKey);
      setLoading(false);
    }
  }, [uid, role, itemsPerPage, userIds, stableLowerBound, stableUpperBound, currentCacheKey]);

  const fetchNextPage = useCallback(async () => {
    const currentLastDoc = lastDocRef.current;
    if (!uid || !currentLastDoc || loading || !hasMore) return;

    try {
      setLoading(true);
      setError(null);

      const normRole = (role || '').toUpperCase().trim();
      const checkIsGlobalRole = (r: string) => {
        const upper = r.toUpperCase().trim();
        const globals = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP'];
        return globals.some(g => upper.includes(g));
      };

      const isGlobalRole = checkIsGlobalRole(normRole);
      const isSupervisorOrTL = isGlobalRole || ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'SME', 'TEAM LEAD', 'OPS TL', 'TEAM LEADER', 'MANAGER', 'ASSISTANT_MANAGER', 'SUPERVISOR'].includes(normRole);

      let fetchedShifts: TMSShift[] = [];
      let nextLastDoc: QueryDocumentSnapshot | null = null;
      let moreAvailable = false;

      if (userIds && userIds.length > 0 && userIds.length <= 30) {
        // Single chunk cursor pagination
        const constraints: any[] = [
          where('userId', 'in', userIds),
          where('clockInTime', '>=', stableLowerBound)
        ];
          if (stableUpperBound) {
            constraints.push(where('clockInTime', '<=', stableUpperBound));
          }
          constraints.push(
            orderBy('clockInTime', 'desc'),
            startAfter(currentLastDoc),
            limit(itemsPerPage)
          );

          const q = query(collection(db, 'tmsShifts'), ...constraints);
          const snapshot = await getDocsOptimized(q, `historical_shifts_next_${currentCacheKey}_${shifts.length}`);
          fetchedShifts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
          nextLastDoc = snapshot.docs.length > 0 ? (snapshot.docs[snapshot.docs.length - 1] as QueryDocumentSnapshot) : null;
          moreAvailable = snapshot.docs.length === itemsPerPage;
      } else if (isGlobalRole) {
        const constraints: any[] = [
          where('clockInTime', '>=', stableLowerBound)
        ];
        if (stableUpperBound) {
          constraints.push(where('clockInTime', '<=', stableUpperBound));
        }
        constraints.push(
          orderBy('clockInTime', 'desc'),
          startAfter(currentLastDoc),
          limit(itemsPerPage)
        );

        const q = query(collection(db, 'tmsShifts'), ...constraints);
        const snapshot = await getDocsOptimized(q, `historical_shifts_next_global_${currentCacheKey}_${shifts.length}`);
        fetchedShifts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
        nextLastDoc = snapshot.docs.length > 0 ? (snapshot.docs[snapshot.docs.length - 1] as QueryDocumentSnapshot) : null;
        moreAvailable = snapshot.docs.length === itemsPerPage;
      } else if (isSupervisorOrTL) {
        const isManagerRole = ['MANAGER', 'ASSISTANT_MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD'].includes(normRole);
        const supervisorField = isManagerRole ? 'managerId' : 'teamLeadUid';

        const constraints: any[] = [
          where(supervisorField, '==', uid),
          where('clockInTime', '>=', stableLowerBound)
        ];
        if (stableUpperBound) {
          constraints.push(where('clockInTime', '<=', stableUpperBound));
        }
        constraints.push(
          orderBy('clockInTime', 'desc'),
          startAfter(currentLastDoc),
          limit(itemsPerPage)
        );

        const q = query(collection(db, 'tmsShifts'), ...constraints);
        const snapshot = await getDocsOptimized(q, `historical_shifts_next_sup_${currentCacheKey}_${shifts.length}`);
        fetchedShifts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
        nextLastDoc = snapshot.docs.length > 0 ? (snapshot.docs[snapshot.docs.length - 1] as QueryDocumentSnapshot) : null;
        moreAvailable = snapshot.docs.length === itemsPerPage;
      } else {
        const constraints: any[] = [
          where('userId', '==', uid),
          where('clockInTime', '>=', stableLowerBound)
        ];
        if (stableUpperBound) {
          constraints.push(where('clockInTime', '<=', stableUpperBound));
        }
        constraints.push(
          orderBy('clockInTime', 'desc'),
          startAfter(currentLastDoc),
          limit(itemsPerPage)
        );

        const q = query(collection(db, 'tmsShifts'), ...constraints);
        const snapshot = await getDocsOptimized(q, `historical_shifts_next_agent_${currentCacheKey}_${shifts.length}`);
        fetchedShifts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as TMSShift));
        nextLastDoc = snapshot.docs.length > 0 ? (snapshot.docs[snapshot.docs.length - 1] as QueryDocumentSnapshot) : null;
        moreAvailable = snapshot.docs.length === itemsPerPage;
      }

      if (fetchedShifts.length > 0) {
        setShifts(prev => [...prev, ...fetchedShifts]);
        setLastDoc(nextLastDoc);
      }
      setHasMore(moreAvailable);
    } catch (err: any) {
      console.error('[useHistoricalShifts] Error fetching next page:', err);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [uid, role, loading, hasMore, itemsPerPage, shifts.length, stableLowerBound, stableUpperBound, currentCacheKey, userIds]);

  // Execute query only when enabled and when the query parameters actually change
  useEffect(() => {
    if (enabled) {
      // Check if we already fetched for this exact cacheKey
      if (lastFetchedKeyRef.current !== currentCacheKey) {
        fetchFirstPage();
      }
    }
  }, [enabled, currentCacheKey, fetchFirstPage]);

  return {
    shifts,
    loading,
    error,
    hasMore,
    fetchNextPage,
    refresh: () => fetchFirstPage(true)
  };
}
