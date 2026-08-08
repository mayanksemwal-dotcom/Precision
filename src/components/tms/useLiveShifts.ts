import { useState, useEffect, useCallback } from 'react';
import { collection, query, where, limit, onSnapshot, documentId } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { TMSShift } from '../../views/TMSView';
import { getLatestUserActivity } from '../../lib/tmsUtils';

export function useLiveShifts(uid?: string, role?: string, userIds?: string[], monitorAll = false, isGlobalOverride = false) {
  const [shifts, setShifts] = useState<TMSShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const userIdsKey = userIds?.join(',');

  const mapLiveSessionToShift = (data: any): TMSShift => {
    let rawStatus = data.status || 'ACTIVE';
    const isActuallyOnline = data.isOnline !== false; // Default true if field missing but doc exists
    
    const activities = Array.isArray(data.activities) ? data.activities : [];
    const lastUserAct = getLatestUserActivity(activities);
    
    // Normalize status from last explicit user activity event
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
      clockInTime: data.clockInTime || '',
      status: isActuallyOnline ? resolvedStatus : 'OFFLINE',
      activities: activities
    } as TMSShift;
  };

  useEffect(() => {
    if (!uid) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const normRole = (role || '').toUpperCase().trim();
    const isSupervisorOrTL = ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'ASSISTANT_MANAGER', 'SME', 'TEAM LEAD', 'OPS TL', 'TRAINER TL', 'OPS TEAM LEAD', 'TEAM LEADER', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'EXECUTIVE', 'OPS HEAD', 'SUPERVISOR', 'ADMIN', 'MIS'].includes(normRole);

    let unsubscribes: (() => void)[] = [];
    const subMap = new Map<string, TMSShift[]>();

    // Helper to merge all subscription branches and update state
    const handleSnapshotDocs = (docs: any[], subId: string) => {
      const mapped = docs.map(d => {
        const data = d.data();
        return mapLiveSessionToShift({ id: d.id, ...data });
      });
      
      subMap.set(subId, mapped);
      
      const allShifts: TMSShift[] = [];
      const seen = new Set<string>();
      
      // Collect from all active subscriptions
      subMap.forEach(list => {
        list.forEach(s => {
          const key = s.userId || s.id;
          if (key && !seen.has(key)) {
            seen.add(key);
            allShifts.push(s);
          }
        });
      });
      
      setShifts([...allShifts]);
      setLoading(false);
    };

    try {
      const checkIsGlobalRole = (r: string) => {
        const upper = r.toUpperCase().trim();
        const globals = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP'];
        return globals.some(g => upper.includes(g));
      };

      if (userIds && userIds.length > 0) {
        // Targeted monitoring for mapped hierarchy team member UIDs
        const rawIds = uid && !userIds.includes(uid) ? [...userIds, uid] : userIds;
        const cleanIds = Array.from(new Set(rawIds.filter(id => id && typeof id === 'string' && id.trim() !== '')));

        if (cleanIds.length > 0) {
          const chunks: string[][] = [];
          for (let i = 0; i < cleanIds.length; i += 30) {
            chunks.push(cleanIds.slice(i, i + 30));
          }

          chunks.forEach((chunk, idx) => {
            const qChunk = query(collection(db, 'live_sessions'), where(documentId(), 'in', chunk));
            const subId = `chunk_${idx}`;
            const unsubChunk = onSnapshot(qChunk, (snap) => {
              handleSnapshotDocs(snap.docs, subId);
            }, (err) => {
              console.error(`[useLiveShifts] Subscription error for ${subId}:`, err);
              handleFirestoreError(err, OperationType.GET, `live_sessions_${subId}`);
            });
            unsubscribes.push(unsubChunk);
          });
        }
      } else if (monitorAll || isGlobalOverride) {
        // Fallback global query only if userIds is explicitly omitted/empty
        const qAll = query(collection(db, 'live_sessions'), limit(2500));
        const unsubAll = onSnapshot(qAll, (snap) => {
          handleSnapshotDocs(snap.docs, 'all');
        }, (err) => {
          console.error('[useLiveShifts] All subscription error:', err);
          handleFirestoreError(err, OperationType.GET, 'live_sessions_all');
        });
        unsubscribes.push(unsubAll);
      } else if (isSupervisorOrTL) {
        // Non-global supervisors and TLs query by their own ID in both tlId and managerId fields,
        // and also by reportee UIDs if available for absolute resilience.
        const qTeam = query(collection(db, 'live_sessions'), where('tlId', '==', uid));
        const qManager = query(collection(db, 'live_sessions'), where('managerId', '==', uid));
        const qSelf = query(collection(db, 'live_sessions'), where('uid', '==', uid));

        const unsubTeam = onSnapshot(qTeam, (snap) => {
          handleSnapshotDocs(snap.docs, 'team');
        }, (err) => {
          console.error('[useLiveShifts] Team subscription error:', err);
          handleFirestoreError(err, OperationType.GET, 'live_sessions_team');
        });
        unsubscribes.push(unsubTeam);

        const unsubManager = onSnapshot(qManager, (snap) => {
          handleSnapshotDocs(snap.docs, 'manager');
        }, (err) => {
          console.error('[useLiveShifts] Manager subscription error:', err);
          handleFirestoreError(err, OperationType.GET, 'live_sessions_manager');
        });
        unsubscribes.push(unsubManager);

        const unsubSelf = onSnapshot(qSelf, (snap) => {
          handleSnapshotDocs(snap.docs, 'self');
        }, (err) => {
          console.error('[useLiveShifts] Self subscription error:', err);
          handleFirestoreError(err, OperationType.GET, 'live_sessions_self');
        });
        unsubscribes.push(unsubSelf);

        // Subscribing directly to team member UIDs via chunks ensures we get real status
        // even if their database document does not have tlId / managerId synced yet
        if (userIds && userIds.length > 0) {
          const monitorIds = uid && !userIds.includes(uid) ? [...userIds, uid] : userIds;
          const chunks: string[][] = [];
          for (let i = 0; i < monitorIds.length; i += 30) {
            chunks.push(monitorIds.slice(i, i + 30));
          }

          chunks.forEach((chunk, idx) => {
            const qChunk = query(collection(db, 'live_sessions'), where(documentId(), 'in', chunk));
            const subId = `chunk_${idx}`;
            const unsubChunk = onSnapshot(qChunk, (snap) => {
              handleSnapshotDocs(snap.docs, subId);
            }, (err) => {
              console.error(`[useLiveShifts] Subscription error for ${subId}:`, err);
              handleFirestoreError(err, OperationType.GET, `live_sessions_${subId}`);
            });
            unsubscribes.push(unsubChunk);
          });
        }
      } else {
        // Fallback for standard users: only subscribe to themselves to prevent security errors and leaks
        const qSelf = query(collection(db, 'live_sessions'), where('uid', '==', uid));
        const unsubSelf = onSnapshot(qSelf, (snap) => {
          handleSnapshotDocs(snap.docs, 'self');
        }, (err) => {
          console.error('[useLiveShifts] Self subscription error:', err);
          handleFirestoreError(err, OperationType.GET, 'live_sessions_self');
        });
        unsubscribes.push(unsubSelf);
      }
    } catch (err: any) {
      console.error('[useLiveShifts] Setup subscription error:', err);
      setError(err);
      setLoading(false);
    }

    return () => {
      unsubscribes.forEach(unsub => unsub());
    };
  }, [uid, role, userIdsKey, monitorAll]);

  const fetchLiveShifts = useCallback(async (forceRefresh = false) => {
    return shifts;
  }, [shifts]);

  return { shifts, loading, error, fetchLiveShifts };
}
