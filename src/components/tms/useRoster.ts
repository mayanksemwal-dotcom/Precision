import { useState, useEffect } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { UserProfile } from '../../types';

// Module-level cache for ultra-fast, read-optimized data re-use
let rosterCache: UserProfile[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL

export function useRoster(uid?: string) {
  const [roster, setRoster] = useState<UserProfile[]>(rosterCache || []);
  const [loading, setLoading] = useState(!rosterCache);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!uid) return;

    let isMounted = true;

    const fetchRoster = async () => {
      const now = Date.now();
      if (rosterCache && (now - lastFetchTime < CACHE_TTL_MS)) {
        if (isMounted) {
          setRoster(rosterCache);
          setLoading(false);
        }
        return;
      }

      try {
        if (isMounted) setLoading(true);
        console.log('[TMS Billing Optimization] Fetching fresh roster from Firestore...');
        const usersSnap = await getDocs(collection(db, 'users'));
        const rosterData = usersSnap.docs.map(doc => {
          const data = doc.data() as any;
          const normalizedTLId = data.teamLeadUid || data.teamLeadId || '';
          const normalizedManagerId = data.mappedManagerUid || data.mappedManagerId || data.managerId || '';
          return {
            uid: doc.id,
            ...data,
            name: data.fullName || data.name || data.employeeName || '',
            fullName: data.fullName || data.name || data.employeeName || '',
            email: (data.email || '').toString().toLowerCase().trim(),
            employeeId: data.employeeId || '',
            photoURL: data.profilePhotoUrl || data.photoURL || '',
            role: (data.role || 'AGENT').toString().toUpperCase(),
            status: data.status || 'Active',
            teamLeadId: normalizedTLId,
            teamLeadUid: normalizedTLId,
            managerId: normalizedManagerId,
            mappedManagerId: normalizedManagerId,
            mappedManagerUid: normalizedManagerId
          } as UserProfile;
        });

        rosterCache = rosterData;
        lastFetchTime = Date.now();

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
  }, [uid]);

  const refreshRoster = async () => {
    try {
      setLoading(true);
      const usersSnap = await getDocs(collection(db, 'users'));
      const rosterData = usersSnap.docs.map(doc => {
        const data = doc.data() as any;
        const normalizedTLId = data.teamLeadUid || data.teamLeadId || '';
        const normalizedManagerId = data.mappedManagerUid || data.mappedManagerId || data.managerId || '';
        return {
          uid: doc.id,
          ...data,
          name: data.fullName || data.name || data.employeeName || '',
          fullName: data.fullName || data.name || data.employeeName || '',
          email: (data.email || '').toString().toLowerCase().trim(),
          employeeId: data.employeeId || '',
          photoURL: data.profilePhotoUrl || data.photoURL || '',
          role: (data.role || 'AGENT').toString().toUpperCase(),
          status: data.status || 'Active',
          teamLeadId: normalizedTLId,
          teamLeadUid: normalizedTLId,
          managerId: normalizedManagerId,
          mappedManagerId: normalizedManagerId,
          mappedManagerUid: normalizedManagerId
        } as UserProfile;
      });
      rosterCache = rosterData;
      lastFetchTime = Date.now();
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
