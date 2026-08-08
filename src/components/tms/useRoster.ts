import { useState, useEffect } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { db, getDocsOptimized } from '../../lib/firebase';
import { UserProfile } from '../../types';
import { safeStorage } from '../../lib/safeStorage';

import { getLiveTime } from '../../lib/timeSync';

// Module-level cache for ultra-fast, read-optimized data re-use
let rosterCache: Record<string, { data: UserProfile[], timestamp: number }> = {};
const CACHE_TTL_MS = 15 * 60 * 1000; 

export function useRoster(uid?: string, role?: string) {
  const normRole = (role || '').toUpperCase();
  const checkIsGlobalRole = (r: string) => {
    const upper = r.toUpperCase().trim();
    const globals = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP'];
    return globals.some(g => upper.includes(g));
  };

  const isGlobalRole = checkIsGlobalRole(normRole);

  const [roster, setRoster] = useState<UserProfile[]>(() => {
    if (uid && rosterCache[uid]) return rosterCache[uid].data;
    const cached = safeStorage.get<UserProfile[]>(`precision360_roster_cache_${uid}`);
    if (Array.isArray(cached) && cached.length > 0) {
      return cached;
    }
    return [];
  });
  const [loading, setLoading] = useState(uid ? !rosterCache[uid] : false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!uid) return;

    let isMounted = true;

    const fetchRoster = async () => {
      const now = getLiveTime().getTime();
      
      // Check memory cache first
      if (rosterCache[uid] && (now - rosterCache[uid].timestamp < CACHE_TTL_MS)) {
        if (isMounted) {
          setRoster(rosterCache[uid].data);
          setLoading(false);
        }
        return;
      }

      // Check safeStorage cache next
      const cacheKey = `precision360_roster_cache_${uid}`;
      const cached = safeStorage.get<UserProfile[]>(cacheKey);
      const cachedTimestamp = safeStorage.get<string>(`${cacheKey}_timestamp`);
      const parsedTime = cachedTimestamp ? parseInt(cachedTimestamp, 10) : 0;

      if (Array.isArray(cached) && cached.length > 0 && (now - parsedTime < CACHE_TTL_MS)) {
        rosterCache[uid] = { data: cached, timestamp: parsedTime };
        if (isMounted) {
          setRoster(cached);
          setLoading(false);
        }
        return;
      }

      try {
        if (isMounted) setLoading(true);
        
        let q;
        const employeeCollection = collection(db, 'employee_master');

        if (isGlobalRole) {
          // Global roles see everyone (organization-wide)
          q = employeeCollection;
        } else {
          // Team Leads and SMEs see only their mapped team
          // We query by teamLeadUid OR managerId to capture direct and indirect subordinates
          // Note: Firestore 'or' queries are supported but 'in' is often safer for mapping
          // For now, we'll use a specific query for TLs. 
          // If we need 'OR' we might need multiple queries or a combined field
          // The request emphasizes "enforced by Firestore queries"
          q = query(employeeCollection, where('teamLeadUid', '==', uid));
        }

        const usersSnap = await getDocsOptimized(q, `roster_fetch_${uid}`);
        const rosterData = usersSnap.docs.map((doc: any) => {
          const data = doc.data() as any;
          const normalizedTLId = data.teamLeadUid || data.teamLeadId || '';
          const normalizedManagerId = data.mappedManagerUid || data.mappedManagerId || data.managerId || '';
          const name = data.fullName || data.name || data.employeeName || '';
          return {
            uid: doc.id,
            email: (data.email || '').toString().toLowerCase().trim(),
            role: (() => {
              const r = (data.role || 'AGENT').toString().toUpperCase().trim();
              return (r === 'TEAM_LEAD' || r === 'TEAM LEAD') ? 'Team Lead' : r;
            })(),
            name: name,
            fullName: name,
            employeeName: data.employeeName || name,
            employeeId: data.employeeId || '',
            status: data.status || 'Active',
            department: data.department || '',
            team: data.team || '',
            teamLeadId: normalizedTLId,
            teamLeadUid: normalizedTLId,
            teamLeadName: data.teamLeadName || '',
            teamLeadEmail: data.teamLeadEmail || '',
            managerId: normalizedManagerId,
            managerName: data.managerName || data.mappedManagerName || '',
            managerEmail: data.managerEmail || data.mappedManagerEmail || '',
            mappedManagerId: normalizedManagerId,
            mappedManagerUid: normalizedManagerId,
            mappedManagerName: data.mappedManagerName || data.managerName || '',
            mappedManagerEmail: data.mappedManagerEmail || data.managerEmail || '',
            process: data.process || '',
            photoURL: data.profilePhotoUrl || data.photoURL || '',
            profilePhotoUrl: data.profilePhotoUrl || data.photoURL || '',
            location: data.location || ''
          } as UserProfile;
        });

        rosterCache[uid] = { data: rosterData, timestamp: getLiveTime().getTime() };

        // Sync back to shared storage
        const cacheKey = `precision360_roster_cache_${uid}`;
        safeStorage.set(cacheKey, rosterData);
        safeStorage.set(`${cacheKey}_timestamp`, rosterCache[uid].timestamp.toString());

        if (isMounted) {
          setRoster(rosterData);
          setError(null);
        }
      } catch (err: any) {
        console.error('[useRoster] Error fetching roster:', err);
        if (isMounted) setError(err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchRoster();

    return () => {
      isMounted = false;
    };
  }, [uid, role]);

  const refreshRoster = async () => {
    if (!uid) return;
    try {
      setLoading(true);
      
      let q;
      const employeeCollection = collection(db, 'employee_master');
      if (isGlobalRole) {
        q = employeeCollection;
      } else {
        q = query(employeeCollection, where('teamLeadUid', '==', uid));
      }

      const usersSnap = await getDocsOptimized(q, `roster_refresh_${uid}`, true);
      const rosterData = usersSnap.docs.map((doc: any) => {
        const data = doc.data() as any;
        const normalizedTLId = data.teamLeadUid || data.teamLeadId || '';
        const normalizedManagerId = data.mappedManagerUid || data.mappedManagerId || data.managerId || '';
        const name = data.fullName || data.name || data.employeeName || '';
        return {
          uid: doc.id,
          email: (data.email || '').toString().toLowerCase().trim(),
          role: (() => {
            const r = (data.role || 'AGENT').toString().toUpperCase().trim();
            return (r === 'TEAM_LEAD' || r === 'TEAM LEAD') ? 'Team Lead' : r;
          })(),
          name: name,
          fullName: name,
          employeeName: data.employeeName || name,
          employeeId: data.employeeId || '',
          status: data.status || 'Active',
          department: data.department || '',
          team: data.team || '',
          teamLeadId: normalizedTLId,
          teamLeadUid: normalizedTLId,
          teamLeadName: data.teamLeadName || '',
          teamLeadEmail: data.teamLeadEmail || '',
          managerId: normalizedManagerId,
          managerName: data.managerName || data.mappedManagerName || '',
          managerEmail: data.managerEmail || data.mappedManagerEmail || '',
          mappedManagerId: normalizedManagerId,
          mappedManagerUid: normalizedManagerId,
          mappedManagerName: data.mappedManagerName || data.managerName || '',
          mappedManagerEmail: data.mappedManagerEmail || data.managerEmail || '',
          process: data.process || '',
          photoURL: data.profilePhotoUrl || data.photoURL || '',
          profilePhotoUrl: data.profilePhotoUrl || data.photoURL || '',
          location: data.location || ''
        } as UserProfile;
      });
      rosterCache[uid] = { data: rosterData, timestamp: getLiveTime().getTime() };
      const cacheKey = `precision360_roster_cache_${uid}`;
      safeStorage.set(cacheKey, rosterData);
      safeStorage.set(`${cacheKey}_timestamp`, rosterCache[uid].timestamp.toString());
      setRoster(rosterData);
      setError(null);
    } catch (err: any) {
      console.error('[useRoster] Error refreshing roster:', err);
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  return { roster, loading, error, refreshRoster };
}
