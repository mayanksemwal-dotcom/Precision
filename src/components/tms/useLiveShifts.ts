import { useState, useEffect, useCallback, useRef } from 'react';
import { collection, query, where, limit, documentId, getDocs } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, getDocsOptimized } from '../../lib/firebase';
import { fetchLiveSessionsOnce } from '../../lib/rtdb';
import { safeStorage } from '../../lib/safeStorage';
import { TMSShift } from '../../views/TMSView';
import { getLatestUserActivity } from '../../lib/tmsUtils';

export const mapLiveSessionToShift = (data: any): TMSShift => {
  let rawStatus = data.status || 'ACTIVE';
  const isActuallyOnline = data.isOnline !== false;
  
  const activities = Array.isArray(data.activities) ? data.activities : [];
  const lastUserAct = getLatestUserActivity(activities);
  
  let resolvedStatus = rawStatus;
  if (lastUserAct) {
    if (lastUserAct.action === 'BREAK_START' || (lastUserAct.type === 'break' && !lastUserAct.endTime)) {
      resolvedStatus = 'BREAK';
    } else if (lastUserAct.action === 'BREAK_END' || lastUserAct.type === 'productive' || lastUserAct.action === 'CLOCK_IN' || lastUserAct.action === 'PROCESS_SWITCH') {
      resolvedStatus = 'ACTIVE';
    }
  }
  
  return {
    ...data,
    id: data.sessionId || data.id || '',
    userId: data.userId || data.uid || data.id || '',
    userName: data.employeeName || data.userName || '',
    userEmail: data.email || data.userEmail || '',
    clockInTime: data.clockInTime || data.statusStartTime || data.currentActivityStartTime || data.startTime || (activities.length > 0 ? (activities[0].startTime || activities[0].start_time || activities[0].timestamp || '') : ''),
    status: isActuallyOnline ? resolvedStatus : 'OFFLINE',
    activities: activities
  } as TMSShift;
};

export function useLiveShifts(uid?: string, role?: string, userIds?: string[], monitorAll = false, isGlobalOverride = false) {
  const [shifts, setShifts] = useState<TMSShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const userIdsKey = userIds?.join(',');
  const isFetchingRef = useRef(false);

  // Load from IndexedDB Cache on mount (Zero network reads on mount)
  useEffect(() => {
    if (!uid) {
      setLoading(false);
      return;
    }

    const loadCache = async () => {
      setError(null);
      try {
        const cacheKey = `precision360_tms_live_data_${uid}`;
        // Load with Infinity TTL to retrieve whatever was last stored
        const cached = await safeStorage.getIndexedDB<{ shifts: TMSShift[]; lastUpdated: number }>(cacheKey, Infinity);

        if (cached && Array.isArray(cached.shifts) && cached.shifts.length > 0) {
          setShifts(cached.shifts);
          setLastUpdated(cached.lastUpdated || Date.now());
          setLoading(false); // Instantly finish loading if cache is present
        } else {
          setShifts([]);
          setLastUpdated(null);
          setLoading(true);
        }

        // Background non-blocking update for own shift state
        fetchLiveSessionsOnce().then(rtdbSessions => {
          if (rtdbSessions && rtdbSessions.length > 0) {
            const myLs = rtdbSessions.find(s => (s.userId || s.id || s.uid) === uid);
            if (myLs) {
              const myLsData = mapLiveSessionToShift(myLs);
              setShifts(prev => {
                const filtered = prev.filter(s => s.userId !== uid);
                const merged = [myLsData, ...filtered];
                safeStorage.setIndexedDB(cacheKey, { shifts: merged, lastUpdated: Date.now() }).catch(() => {});
                return merged;
              });
            }
          }
        }).catch(() => {}).finally(() => {
          setLoading(false);
        });
      } catch (e: any) {
        console.error('[useLiveShifts] Error loading IndexedDB cache:', e);
        setShifts([]);
        setLastUpdated(null);
        setLoading(false);
      }
    };

    loadCache();
  }, [uid]);

  // Automatic live data fetch on tab open/switch disabled — cache memory is used until user explicitly clicks Load Live Data

  // Manual load live data function
  const fetchLiveShifts = useCallback(async (isUserTriggered = false) => {
    if (!uid) return [];

    // Pause all live fetches if document is hidden/minimized to prevent overnight quota drain
    if (typeof document !== 'undefined' && document.hidden && !isUserTriggered) {
      console.log(`[TMS LIVE DATA] Background fetch suppressed (tab inactive/hidden) for actor=${uid}`);
      return shifts;
    }

    if (!isUserTriggered) {
      console.warn(`[TMS LIVE DATA BLOCK]
actor=${uid}
reason=AUTOMATIC_LIVE_FETCH_DISABLED`);
      return shifts;
    }

    if (isFetchingRef.current) {
      console.log(`[useLiveShifts] Fetch already in progress. Deduplicating request for actor=${uid}`);
      return shifts;
    }

    isFetchingRef.current = true;
    if (shifts.length === 0) {
      setLoading(true);
    }
    setError(null);

    try {
      const normRole = (role || '').toUpperCase().trim();
      const isSupervisorOrTL = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'ASSISTANT_MANAGER', 'SME', 'TEAM LEAD', 'OPS TL', 'TRAINER TL', 'OPS TEAM LEAD', 'TEAM LEADER', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD', 'SUPERVISOR', 'ADMIN', 'MIS'].includes(normRole);

      let fetchedShifts: TMSShift[] = [];
      let docsReadCount = 0;

      // Try Realtime Database (RTDB) first to offload Firestore read costs
      const rtdbList = await fetchLiveSessionsOnce();
      if (rtdbList !== null) {
        console.info('⚡ [RTDB FETCH SUCCESS] Loading live sessions from Realtime Database; bypassing Firestore read costs entirely.');
        const rtdbShifts = rtdbList.map(item => mapLiveSessionToShift(item));
        
        if (userIds && userIds.length > 0) {
          const rawIds = !userIds.includes(uid) ? [...userIds, uid] : userIds;
          const cleanIds = new Set(rawIds.filter(Boolean));
          fetchedShifts = rtdbShifts.filter(s => cleanIds.has(s.userId || s.id));
        } else if (monitorAll || isGlobalOverride) {
          fetchedShifts = rtdbShifts;
        } else if (isSupervisorOrTL) {
          fetchedShifts = rtdbShifts.filter(s => (s as any).tlId === uid || (s as any).managerId === uid || s.userId === uid);
        } else {
          fetchedShifts = rtdbShifts.filter(s => s.userId === uid);
        }
      } else {
        console.log('🔄 [FIRESTORE FALLBACK] RTDB not enabled/ready; querying live_sessions from Firestore.');
        if (userIds && userIds.length > 0) {
          // Strict Hierarchy Scope Query
          const rawIds = !userIds.includes(uid) ? [...userIds, uid] : userIds;
          const cleanIds = Array.from(new Set(rawIds.filter(id => id && typeof id === 'string' && id.trim() !== '')));

          if (cleanIds.length > 0) {
            const chunks: string[][] = [];
            for (let i = 0; i < cleanIds.length; i += 30) {
              chunks.push(cleanIds.slice(i, i + 30));
            }

            const chunkPromises = chunks.map(async (chunk) => {
              const qChunk = query(collection(db, 'live_sessions'), where(documentId(), 'in', chunk));
              const snap = await getDocs(qChunk);
              docsReadCount += snap.size;
              return snap.docs.map(doc => mapLiveSessionToShift({ id: doc.id, ...doc.data() }));
            });

            const results = await Promise.all(chunkPromises);
            fetchedShifts = results.flat();
          }
        } else if (monitorAll || isGlobalOverride) {
          // Global Fetch (for Admin, OPS HEAD, etc.)
          const qAll = query(collection(db, 'live_sessions'), limit(2500));
          const snap = await getDocs(qAll);
          docsReadCount += snap.size;
          fetchedShifts = snap.docs.map(doc => mapLiveSessionToShift({ id: doc.id, ...doc.data() }));
        } else if (isSupervisorOrTL) {
          // Query only managerId, tlId, and self to ensure no global leakage
          const qTeam = query(collection(db, 'live_sessions'), where('tlId', '==', uid));
          const qManager = query(collection(db, 'live_sessions'), where('managerId', '==', uid));
          const qSelf = query(collection(db, 'live_sessions'), where('uid', '==', uid));

          const [snapTeam, snapManager, snapSelf] = await Promise.all([
            getDocs(qTeam),
            getDocs(qManager),
            getDocs(qSelf)
          ]);

          docsReadCount += snapTeam.size + snapManager.size + snapSelf.size;

          const teamList = snapTeam.docs.map(doc => mapLiveSessionToShift({ id: doc.id, ...doc.data() }));
          const managerList = snapManager.docs.map(doc => mapLiveSessionToShift({ id: doc.id, ...doc.data() }));
          const selfList = snapSelf.docs.map(doc => mapLiveSessionToShift({ id: doc.id, ...doc.data() }));

          const mergedMap = new Map<string, TMSShift>();
          [...teamList, ...managerList, ...selfList].forEach(s => {
            const key = s.userId || s.id;
            if (key) mergedMap.set(key, s);
          });
          fetchedShifts = Array.from(mergedMap.values());
        } else {
          // Basic agent queries only themselves
          const qSelf = query(collection(db, 'live_sessions'), where('uid', '==', uid));
          const snap = await getDocs(qSelf);
          docsReadCount += snap.size;
          fetchedShifts = snap.docs.map(doc => mapLiveSessionToShift({ id: doc.id, ...doc.data() }));
        }
      }

      // Deduplicate results by userId / id
      const uniqueMap = new Map<string, TMSShift>();
      fetchedShifts.forEach(s => {
        const key = s.userId || s.id;
        if (key) uniqueMap.set(key, s);
      });
      const uniqueShifts = Array.from(uniqueMap.values());

      setShifts(uniqueShifts);
      const nowEpoch = Date.now();
      setLastUpdated(nowEpoch);

      // Save successful load in dedicated IndexedDB cache
      const cacheKey = `precision360_tms_live_data_${uid}`;
      await safeStorage.setIndexedDB(cacheKey, { shifts: uniqueShifts, lastUpdated: nowEpoch });

      console.log(`[TMS LIVE DATA FETCH]
actor=${uid}
role=${role || 'unknown'}
hierarchyUsers=${userIds ? userIds.length : 0}
targetedUsers=${uniqueShifts.length}
globalFetch=${(monitorAll || isGlobalOverride) ? 'true' : 'false'}
listenerCreated=false
reason=MANUAL_LOAD_LIVE_DATA
docsRead=${docsReadCount}`);

      setLoading(false);
      return uniqueShifts;
    } catch (err: any) {
      console.error('[useLiveShifts] Manual fetch failed:', err);
      setError(err);
      setLoading(false);
      throw err;
    } finally {
      isFetchingRef.current = false;
    }
  }, [uid, role, userIdsKey, monitorAll, isGlobalOverride]);

  return { shifts, loading, error, fetchLiveShifts, lastUpdated };
}
