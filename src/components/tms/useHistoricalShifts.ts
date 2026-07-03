import { useState, useEffect, useCallback } from 'react';
import { collection, query, where, orderBy, limit, startAfter, getDocs, QueryDocumentSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { TMSShift } from '../../views/TMSView';

// Cache map for first page of historical shifts per Team Lead / Supervisor
const firstPageCache = new Map<string, { shifts: TMSShift[]; lastDoc: any; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL

export function useHistoricalShifts(uid?: string, role?: string, itemsPerPage: number = 20, enabled: boolean = true, userIds?: string[]) {
  const [shifts, setShifts] = useState<TMSShift[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const fetchFirstPage = useCallback(async (forceRefresh = false) => {
    if (!uid) return;

    const cacheKey = `${uid}_${role}_${itemsPerPage}_${userIds?.length || 0}_${(userIds || []).slice(0, 3).join(',')}`;
    const cached = firstPageCache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.timestamp < CACHE_TTL_MS) && !forceRefresh) {
      setShifts(cached.shifts);
      setLastDoc(cached.lastDoc);
      setHasMore(cached.shifts.length === itemsPerPage);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const normRole = (role || '').toUpperCase().trim();
      const isSupervisorOrTL = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'ASSISTANT_MANAGER', 'SME', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD'].includes(normRole);

      let q;
      if (userIds && userIds.length > 0) {
        // Phase 1 Optimization: Chunked UID queries for historical data
        // Note: Firestore doesn't support 'in' with 'orderBy' easily across chunks for a single result set with limit
        // For historical data, we'll fetch the most recent shifts for these specific users
        const chunks: string[][] = [];
        for (let i = 0; i < userIds.length; i += 30) {
          chunks.push(userIds.slice(i, i + 30));
        }

        const chunkPromises = chunks.map(chunk => {
          const cq = query(
            collection(db, 'tmsShifts'),
            where('userId', 'in', chunk),
            orderBy('clockInTime', 'desc'),
            limit(itemsPerPage)
          );
          return getDocs(cq);
        });

        const snapshots = await Promise.all(chunkPromises);
        let combinedDocs: any[] = [];
        snapshots.forEach(snap => {
          snap.docs.forEach(d => combinedDocs.push(d));
        });

        // Sort by clockInTime desc across all chunks
        combinedDocs.sort((a, b) => {
          const tA = new Date(a.data().clockInTime).getTime();
          const tB = new Date(b.data().clockInTime).getTime();
          return tB - tA;
        });

        // Take the first itemsPerPage
        const finalDocs = combinedDocs.slice(0, itemsPerPage);
        const fetchedShifts = finalDocs.map(d => ({ id: d.id, ...d.data() } as TMSShift));
        const lastVisible = finalDocs[finalDocs.length - 1] || null;

        setShifts(fetchedShifts);
        setLastDoc(lastVisible);
        setHasMore(fetchedShifts.length === itemsPerPage);
        
        firstPageCache.set(cacheKey, {
          shifts: fetchedShifts,
          lastDoc: lastVisible,
          timestamp: Date.now()
        });
        return;
      } else if (isSupervisorOrTL) {
        const isManagerRole = ['MANAGER', 'ASSISTANT_MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD'].includes(normRole);
        const supervisorField = isManagerRole ? 'managerId' : 'teamLeadUid';
        console.log(`[useHistoricalShifts] Fetching first page for supervisor: ${uid} (field: ${supervisorField})`);
        q = query(
          collection(db, 'tmsShifts'),
          where(supervisorField, '==', uid),
          orderBy('clockInTime', 'desc'),
          limit(itemsPerPage)
        );
      } else {
        console.log(`[useHistoricalShifts] Fetching first page (organization-wide)`);
        q = query(
          collection(db, 'tmsShifts'),
          orderBy('clockInTime', 'desc'),
          limit(itemsPerPage)
        );
      }

      const snapshot = await getDocs(q);
      const fetchedShifts = snapshot.docs.map(doc => ({
        id: doc.id,
        ...(doc.data() as any)
      })) as TMSShift[];

      const lastVisible = snapshot.docs[snapshot.docs.length - 1] || null;

      firstPageCache.set(cacheKey, {
        shifts: fetchedShifts,
        lastDoc: lastVisible,
        timestamp: Date.now()
      });

      setShifts(fetchedShifts);
      setLastDoc(lastVisible);
      setHasMore(fetchedShifts.length === itemsPerPage);
    } catch (err: any) {
      console.error('[useHistoricalShifts] Error fetching historical shifts:', err);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [uid, role, itemsPerPage]);

  const fetchNextPage = useCallback(async () => {
    if (!uid || !lastDoc || loading || !hasMore) return;

    try {
      setLoading(true);
      setError(null);

      const normRole = (role || '').toUpperCase().trim();
      const isSupervisorOrTL = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'ASSISTANT_MANAGER', 'SME', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD'].includes(normRole);

      let q;
      if (isSupervisorOrTL) {
        const isManagerRole = ['MANAGER', 'ASSISTANT_MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD'].includes(normRole);
        const supervisorField = isManagerRole ? 'managerId' : 'teamLeadUid';
        q = query(
          collection(db, 'tmsShifts'),
          where(supervisorField, '==', uid),
          orderBy('clockInTime', 'desc'),
          startAfter(lastDoc),
          limit(itemsPerPage)
        );
      } else {
        q = query(
          collection(db, 'tmsShifts'),
          orderBy('clockInTime', 'desc'),
          startAfter(lastDoc),
          limit(itemsPerPage)
        );
      }

      const snapshot = await getDocs(q);
      const fetchedShifts = snapshot.docs.map(doc => ({
        id: doc.id,
        ...(doc.data() as any)
      })) as TMSShift[];

      const lastVisible = snapshot.docs[snapshot.docs.length - 1] || null;

      setShifts(prev => [...prev, ...fetchedShifts]);
      setLastDoc(lastVisible);
      setHasMore(fetchedShifts.length === itemsPerPage);
    } catch (err: any) {
      console.error('[useHistoricalShifts] Error fetching next page:', err);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [uid, role, lastDoc, loading, hasMore, itemsPerPage]);

  useEffect(() => {
    if (enabled) {
      fetchFirstPage();
    }
  }, [fetchFirstPage, enabled]);

  return {
    shifts,
    loading,
    error,
    hasMore,
    fetchNextPage,
    refresh: () => fetchFirstPage(true)
  };
}
