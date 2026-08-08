import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db, invalidateCacheKey, getDocsOptimized } from '../lib/firebase';
import { safeStorage } from '../lib/safeStorage';
import { query, where, collection, getDocs, doc, getDoc, or } from 'firebase/firestore';
import { getSubordinateUids } from '../lib/hierarchy';

export interface UserProfile {
  uid: string;
  name: string;
  fullName?: string;
  email: string;
  role: string;
  status: string;
  employeeId?: string;
  location?: string;
  process?: string;
  teamLeadUid?: string;
  teamLeadId?: string;
  teamLeadName?: string;
  teamLeadEmail?: string;
  mappedTL?: string;
  managerId?: string;
  managerName?: string;
  mappedManagerId?: string;
  [key: string]: any;
}

interface RosterContextType {
  roster: UserProfile[];
  profiles: Record<string, any>;
  roles: string[];
  isLoading: boolean;
  refreshRoster: (forceRefresh?: boolean) => Promise<void>;
  invalidateRosterCache: () => Promise<void>;
}

const RosterContext = createContext<RosterContextType | undefined>(undefined);

export const RosterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [roster, setRoster] = useState<UserProfile[]>([]);
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState<any>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (!user) {
        setRoster([]);
        setProfiles({});
        setRoles([]);
      }
    });
    return unsub;
  }, []);

  const fetchRosterFromFirestore = async (uid: string) => {
    // 1. Get the user's role first to determine query scope
    // We check both the document ID and the 'uid' field for robustness
    let role = 'AGENT';
    let email = '';
    const meDocRef = doc(db, 'employee_master', uid);
    const meDocSnap = await getDoc(meDocRef);
    
    if (meDocSnap.exists()) {
      const data = meDocSnap.data();
      role = (data?.role || 'AGENT').toUpperCase();
      email = (data?.email || '').toLowerCase().trim();
    } else {
      const userSnap = await getDocsOptimized(query(collection(db, 'employee_master'), where('uid', '==', uid)), `user_role_check_${uid}`);
      if (!userSnap.empty) {
        const data = userSnap.docs[0].data();
        role = (data?.role || 'AGENT').toUpperCase();
        email = (data?.email || '').toLowerCase().trim();
      }
    }

    const checkIsGlobalRole = (r: string) => {
      const upper = r.toUpperCase().trim();
      const globals = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP'];
      return globals.some(g => upper.includes(g));
    };

    const isGlobalRole = checkIsGlobalRole(role);

    let rosterQuery;
    if (isGlobalRole) {
      rosterQuery = collection(db, 'employee_master');
    } else {
      // Team Lead/Supervisor mapping enforced at Firestore level: Support all hierarchy fields
      const conditions = [
        where('teamLeadId', '==', uid),
        where('teamLeadUid', '==', uid),
        where('managerId', '==', uid),
        where('mappedManagerId', '==', uid),
        where('mappedManagerUid', '==', uid),
        where('managerUid', '==', uid)
      ];

      if (email) {
        conditions.push(
          where('managerEmail', '==', email),
          where('mappedManagerEmail', '==', email),
          where('teamLeadEmail', '==', email),
          where('mappedTL', '==', email),
          where('Manager', '==', email)
        );
      }

      rosterQuery = query(
        collection(db, 'employee_master'),
        or(...conditions)
      );
    }

    const [usersSnap, profilesSnap, rolesSnap] = await Promise.all([
      getDocsOptimized(rosterQuery, `roster_fetch_${uid}`),
      getDocsOptimized(collection(db, 'employeeProfiles'), 'roster_profiles_fetch'),
      getDocsOptimized(collection(db, 'roles'), 'roster_roles_fetch')
    ]);
    
    const newProfiles: Record<string, any> = {};
    profilesSnap.forEach(d => { newProfiles[d.id] = d.data(); });
    
    const rawRoles = rolesSnap.docs
      .filter(doc => {
        const data = doc.data();
        if (data.status === 'Inactive' || data.archived === true) return false;
        const upper = doc.id.trim().toUpperCase();
        const oldTLVariations = ['STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'TRAINER TL', 'OPS TL', 'TEAM LEAD', 'OPS_TEAM_LEAD', 'TEAM_LEADER'];
        return !oldTLVariations.includes(upper);
      })
      .map(doc => doc.id.trim());

    const normalizeRoleName = (r: string): string => {
      const upper = r.trim().toUpperCase();
      return (upper === 'TEAM LEAD' || upper === 'TEAM_LEAD') ? 'Team Lead' : upper;
    };
    const newRoles = Array.from(new Set(rawRoles.map(normalizeRoleName)));
    setRoles(newRoles);

    const newRoster = usersSnap.docs.map(doc => {
      const data = doc.data() as any;
      const prof = newProfiles[doc.id] || {};
      const merged = { ...prof, ...data };
      const name = merged.fullName || merged.name || merged.employeeName || '';
      return {
        uid: doc.id,
        ...merged,
        name,
        fullName: name,
        email: (merged.email || '').toString().toLowerCase().trim(),
        role: (() => {
          const emailClean = (merged.email || '').toString().toLowerCase().trim();
          if (emailClean === 'mayank.semwal@bergtechnologies.co.in') return 'ADMIN';
          const r = (merged.role || 'AGENT').toString().toUpperCase().trim();
          return (r === 'TEAM_LEAD' || r === 'TEAM LEAD') ? 'Team Lead' : r;
        })(),
        status: merged.status || 'Active',
      } as UserProfile;
    });
    
    // ENSURE the current user is ALWAYS in the roster list for self-visibility and report consistency
    if (!newRoster.find(u => u.uid === uid)) {
      const meDocRef = doc(db, 'employee_master', uid);
      const meDocSnap = await getDoc(meDocRef);
      let meData: any = null;
      
      if (meDocSnap.exists()) {
        meData = meDocSnap.data();
      } else {
        const meSnap = await getDocsOptimized(query(collection(db, 'employee_master'), where('uid', '==', uid)), `me_fetch_${uid}`);
        if (!meSnap.empty) meData = meSnap.docs[0].data();
      }

      if (meData) {
        newRoster.push({
          uid,
          ...meData,
          name: meData.fullName || meData.name || 'Me',
          fullName: meData.fullName || meData.name || 'Me',
          role: (meData.role || 'AGENT').toUpperCase(),
          status: meData.status || 'Active',
          email: (meData.email || '').toLowerCase().trim()
        } as UserProfile);
      }
    }

    let finalRoster = newRoster;
    let finalProfiles = newProfiles;

    const cacheKeyPrefix = `precision360_roster_cache_${uid}`;
    await safeStorage.setIndexedDB(cacheKeyPrefix, finalRoster);
    await safeStorage.setIndexedDB(`${cacheKeyPrefix}_profiles`, finalProfiles);
    await safeStorage.setIndexedDB(`${cacheKeyPrefix}_roles`, newRoles);
    
    return { roster: finalRoster, profiles: finalProfiles, roles: newRoles };
  };

  const activeRefreshPromiseRef = useRef<Promise<void> | null>(null);

  const refreshRoster = useCallback(async (forceRefresh = false) => {
    if (!currentUser) return;
    if (activeRefreshPromiseRef.current) return activeRefreshPromiseRef.current;

    const uid = currentUser.uid;
    const cacheKeyPrefix = `precision360_roster_cache_${uid}`;

    const promise = (async () => {
      setIsLoading(true);
      try {
        if (!forceRefresh) {
          const cachedRoster = await safeStorage.getIndexedDB<UserProfile[]>(cacheKeyPrefix, 30 * 60 * 1000);
          const cachedProfiles = await safeStorage.getIndexedDB<Record<string, any>>(`${cacheKeyPrefix}_profiles`, 30 * 60 * 1000);
          const cachedRoles = await safeStorage.getIndexedDB<string[]>(`${cacheKeyPrefix}_roles`, 30 * 60 * 1000);
          
          if (cachedRoster && cachedProfiles && cachedRoles) {
            setRoster(cachedRoster);
            setProfiles(cachedProfiles);
            setRoles(cachedRoles);
            return;
          }
        }
        
        const { roster: newRoster, profiles: newProfiles, roles: newRoles } = await fetchRosterFromFirestore(uid);
        setRoster(newRoster);
        setProfiles(newProfiles);
        setRoles(newRoles);
      } catch (error) {
        console.error('Failed to refresh roster:', error);
      } finally {
        setIsLoading(false);
      }
    })();

    activeRefreshPromiseRef.current = promise;
    try {
      await promise;
    } finally {
      activeRefreshPromiseRef.current = null;
    }
  }, [currentUser]);

  const invalidateRosterCache = useCallback(async () => {
    if (!currentUser) return;
    const cacheKeyPrefix = `precision360_roster_cache_${currentUser.uid}`;
    await safeStorage.setIndexedDB(cacheKeyPrefix, null);
    await safeStorage.setIndexedDB(`${cacheKeyPrefix}_profiles`, null);
    await safeStorage.setIndexedDB(`${cacheKeyPrefix}_roles`, null);
    try {
      await safeStorage.clearAllIndexedDBByPrefix('subordinates_v2_of_');
    } catch (e) {
      console.warn('Failed to clear subordinate cache:', e);
    }
    invalidateCacheKey(`roster_fetch_${currentUser.uid}`);
    invalidateCacheKey(`roster_refresh_${currentUser.uid}`);
    await refreshRoster(true);
  }, [refreshRoster, currentUser]);

  useEffect(() => {
    if (currentUser) {
      refreshRoster();
    }
  }, [currentUser, refreshRoster]);

  return (
    <RosterContext.Provider value={{ roster, profiles, roles, isLoading, refreshRoster, invalidateRosterCache }}>
      {children}
    </RosterContext.Provider>
  );
};

export const useRoster = () => {
  const context = useContext(RosterContext);
  if (!context) throw new Error('useRoster must be used within RosterProvider');
  return context;
};
