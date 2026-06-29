import { useState, useEffect, useCallback } from 'react';
import { collection, query, where, getDocs, limit, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { TMSShift } from '../../views/TMSView';

// Local performance cache to avoid redundant database reads across components
const liveShiftsCache = new Map<string, { shifts: TMSShift[]; timestamp: number }>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes cache TTL

export function useLiveShifts(uid?: string, role?: string, userIds?: string[], monitorAll = false) {
  const [shifts, setShifts] = useState<TMSShift[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!uid) return;

    setLoading(true);
    setError(null);

    const normRole = (role || '').toUpperCase().trim();
    const isSupervisorOrTL = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'ASSISTANT_MANAGER', 'SME'].includes(normRole);

    let unsubscribers: (() => void)[] = [];

      // Phase 4: Build session cards entirely from live_sessions
    const mapLiveSessionToShift = (data: any): TMSShift => {
      return {
        id: data.sessionId || data.uid,
        userId: data.uid,
        userName: data.employeeName || '',
        userEmail: data.email || '', 
        clockInTime: data.clockInTime || '',
        status: data.status as any,
        activities: data.activities || [], 
        lastHeartbeat: data.lastHeartbeat,
        currentActivity: data.currentActivity,
        currentActivityStartTime: data.currentActivityStartTime,
        deviceName: data.deviceName,
        productiveMs: data.productiveSeconds ? data.productiveSeconds * 1000 : 0,
        breakMs: data.breakSeconds ? data.breakSeconds * 1000 : 0
      } as unknown as TMSShift;
    };

    if (userIds && userIds.length > 0 && !monitorAll) {
      // Phase 1 Optimization: Chunked Realtime UID queries for LIVE SESSIONS
      const monitorIds = uid && !userIds.includes(uid) ? [...userIds, uid] : userIds;
      console.log(`[useLiveShifts] Monitoring live_sessions for ${monitorIds.length} team members (chunked including self)`);
      
      const chunks: string[][] = [];
      for (let i = 0; i < monitorIds.length; i += 30) {
        chunks.push(monitorIds.slice(i, i + 30));
      }

      const activeListMap: Record<number, TMSShift[]> = {};
      
      unsubscribers = chunks.map((chunk, index) => {
        const q = query(
          collection(db, 'live_sessions'),
          where('uid', 'in', chunk),
          where('status', 'in', ['ACTIVE', 'BREAK'])
        );
        
        return onSnapshot(q, (snap) => {
          activeListMap[index] = snap.docs.map(d => mapLiveSessionToShift(d.data()));
          
          const allActive: TMSShift[] = [];
          Object.values(activeListMap).forEach(list => allActive.push(...list));
          setShifts(allActive);
          setLoading(false);
        }, (err) => {
          console.error(`[useLiveShifts] live_sessions chunk ${index} error:`, err);
        });
      });
    } else if (isSupervisorOrTL && !monitorAll) {
      console.log(`[useLiveShifts] Monitoring live_sessions for TL: ${uid} and self`);
      const qTeam = query(
        collection(db, 'live_sessions'),
        where('tlId', '==', uid),
        where('status', 'in', ['ACTIVE', 'BREAK'])
      );
      const qSelf = query(
        collection(db, 'live_sessions'),
        where('uid', '==', uid),
        where('status', 'in', ['ACTIVE', 'BREAK'])
      );

      const unsubTeam = onSnapshot(qTeam, (snap) => {
        setShifts(prev => {
          const others = prev.filter(s => s.teamLeadUid !== uid);
          const current = snap.docs.map(d => mapLiveSessionToShift(d.data()));
          return [...others, ...current];
        });
        setLoading(false);
      });

      const unsubSelf = onSnapshot(qSelf, (snap) => {
        setShifts(prev => {
          const others = prev.filter(s => s.userId !== uid);
          const current = snap.docs.map(d => mapLiveSessionToShift(d.data()));
          return [...others, ...current];
        });
        setLoading(false);
      });

      unsubscribers = [unsubTeam, unsubSelf];
    } else {
      console.log(`[useLiveShifts] Monitoring all live_sessions (ACTIVE/BREAK)`);
      const qAll = query(
        collection(db, 'live_sessions'),
        where('status', 'in', ['ACTIVE', 'BREAK']),
        limit(300)
      );
      const unsubAll = onSnapshot(qAll, (snap) => {
        setShifts(snap.docs.map(d => mapLiveSessionToShift(d.data())));
        setLoading(false);
      });
      unsubscribers = [unsubAll];
    }

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [uid, role, userIds?.length, monitorAll]); // Stable dependencies

  const fetchLiveShifts = useCallback(async (forceRefresh = false) => {
    // This is now handled by realtime listeners, but we keep the interface
    return shifts;
  }, [shifts]);

  return { shifts, loading, error, fetchLiveShifts };
}
