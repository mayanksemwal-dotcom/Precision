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

  const userIdsKey = userIds?.join(',');

  useEffect(() => {
    if (!uid) return;

    setLoading(true);
    setError(null);

    const normRole = (role || '').toUpperCase().trim();
    const isSupervisorOrTL = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'ASSISTANT_MANAGER', 'SME', 'TEAM LEAD', 'OPS TL', 'TRAINER TL', 'OPS TEAM LEAD', 'TEAM LEADER', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD'].includes(normRole);

    let unsubscribers: (() => void)[] = [];

    // Deduplicate helper to prevent duplicate/stale user entries
    const deduplicateShifts = (shiftsList: TMSShift[]): TMSShift[] => {
      const uniqueMap = new Map<string, TMSShift>();
      shiftsList.forEach(s => {
        if (!s.userId) return;
        const existing = uniqueMap.get(s.userId);
        if (!existing) {
          uniqueMap.set(s.userId, s);
        } else {
          const existingTime = (existing as any).lastHeartbeat ? new Date((existing as any).lastHeartbeat).getTime() : 0;
          const sTime = (s as any).lastHeartbeat ? new Date((s as any).lastHeartbeat).getTime() : 0;
          // Keep the newer heartbeat record to avoid showing stale status details
          if (sTime > existingTime) {
            uniqueMap.set(s.userId, s);
          }
        }
      });
      return Array.from(uniqueMap.values());
    };

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
        deviceName: data.deviceName || data.deviceType || 'Unknown',
        deviceType: data.deviceType || (data.deviceName && data.deviceName !== 'Unknown' ? data.deviceName : 'Desktop'),
        clockInDevice: data.clockInDevice || (data.deviceType === 'Mobile' ? 'mobile' : 'desktop'),
        os: data.os || data.platform || 'Unknown',
        productiveMs: data.productiveSeconds ? data.productiveSeconds * 1000 : 0,
        breakMs: data.breakSeconds ? data.breakSeconds * 1000 : 0,
        teamLeadUid: data.tlId || data.teamLeadUid || data.teamLeadId || '',
        managerId: data.managerId || ''
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
          where('uid', 'in', chunk)
        );
        
        return onSnapshot(q, (snap) => {
          activeListMap[index] = snap.docs.map(d => mapLiveSessionToShift(d.data()));
          
          const allActive: TMSShift[] = [];
          Object.values(activeListMap).forEach(list => allActive.push(...list));
          setShifts(deduplicateShifts(allActive));
          setLoading(false);
        }, (err) => {
          console.error(`[useLiveShifts] live_sessions chunk ${index} error:`, err);
        });
      });
    } else if (isSupervisorOrTL && !monitorAll) {
      const isManagerRole = ['MANAGER', 'ASSISTANT_MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD'].includes(normRole);
      const supervisorField = isManagerRole ? 'managerId' : 'tlId';

      console.log(`[useLiveShifts] Monitoring live_sessions for supervisor: ${uid} (field: ${supervisorField}) and self`);
      const qTeam = query(
        collection(db, 'live_sessions'),
        where(supervisorField, '==', uid)
      );
      const qSelf = query(
        collection(db, 'live_sessions'),
        where('uid', '==', uid)
      );

      const unsubTeam = onSnapshot(qTeam, (snap) => {
        setShifts(prev => {
          const others = prev.filter(s => isManagerRole ? (s as any).managerId !== uid : s.teamLeadUid !== uid);
          const current = snap.docs.map(d => mapLiveSessionToShift(d.data()));
          return deduplicateShifts([...others, ...current]);
        });
        setLoading(false);
      });

      const unsubSelf = onSnapshot(qSelf, (snap) => {
        setShifts(prev => {
          const others = prev.filter(s => s.userId !== uid);
          const current = snap.docs.map(d => mapLiveSessionToShift(d.data()));
          return deduplicateShifts([...others, ...current]);
        });
        setLoading(false);
      });

      unsubscribers = [unsubTeam, unsubSelf];
    } else {
      console.log(`[useLiveShifts] Monitoring all live_sessions`);
      const qAll = query(
        collection(db, 'live_sessions'),
        limit(300)
      );
      const unsubAll = onSnapshot(qAll, (snap) => {
        setShifts(deduplicateShifts(snap.docs.map(d => mapLiveSessionToShift(d.data()))));
        setLoading(false);
      });
      unsubscribers = [unsubAll];
    }

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [uid, role, userIdsKey, monitorAll]); // Stable dependencies including joined userIdsKey

  const fetchLiveShifts = useCallback(async (forceRefresh = false) => {
    // This is now handled by realtime listeners, but we keep the interface
    return shifts;
  }, [shifts]);

  return { shifts, loading, error, fetchLiveShifts };
}
