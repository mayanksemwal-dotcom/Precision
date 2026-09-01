import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db, invalidateCacheKey, getDocsOptimized, getDocOptimized, getDocsCacheFirst, getDocFromCache } from '../lib/firebase';
import { safeStorage } from '../lib/safeStorage';
import { query, where, collection, getDocs, doc, getDoc, or } from 'firebase/firestore';
import { OrgTree, OrgNode, normalizeHierarchyUser, getSubordinateUids } from '../lib/hierarchy';
import { bumpHierarchyVersion, subscribeToHierarchyVersion } from '../lib/hierarchySync';

export function logUserDirectoryRead(
  queryName: string,
  reason: 'initial load' | 'mutation reconciliation' | 'focus' | 'reconnect' | 'manual refresh' | 'cache hit' | 'cache miss',
  cacheHit: boolean,
  docCount: number,
  details?: string
) {
  const statusStr = cacheHit ? 'CACHE HIT' : 'SERVER FETCH';
  console.info(`📊 [USER DIRECTORY READ] Query: "${queryName}" | Reason: "${reason}" | Status: ${statusStr} | Docs Returned: ${docCount}${details ? ` | Details: ${details}` : ''}`);
}

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
  globalRoster: UserProfile[];
  globalProfiles: Record<string, any>;
  roles: string[];
  isLoading: boolean;
  refreshRoster: (forceRefresh?: boolean, isGlobalView?: boolean) => Promise<void>;
  fetchGlobalRoster: (forceRefresh?: boolean) => Promise<UserProfile[]>;
  invalidateRosterCache: () => Promise<void>;
  updateUserInRoster: (updatedUser: Partial<UserProfile> & { uid: string }) => Promise<void>;
  addUserToRoster: (newUser: UserProfile) => Promise<void>;
  deleteUserFromRoster: (uid: string) => Promise<void>;
  updateMultipleUsersInRoster: (updates: Array<Partial<UserProfile> & { uid: string }>) => Promise<void>;
  orgTree: OrgTree;
}

const RosterContext = createContext<RosterContextType | undefined>(undefined);

export const RosterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [roster, setRoster] = useState<UserProfile[]>([]);
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [globalRoster, setGlobalRoster] = useState<UserProfile[]>([]);
  const [globalProfiles, setGlobalProfiles] = useState<Record<string, any>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState<any>(null);

  const globalRosterRef = useRef<UserProfile[]>([]);
  useEffect(() => {
    globalRosterRef.current = globalRoster;
  }, [globalRoster]);

  const orgTree = useMemo(() => new OrgTree(roster), [roster]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (!user) {
        setRoster([]);
        setProfiles({});
        setGlobalRoster([]);
        setGlobalProfiles({});
        setRoles([]);
      }
    });
    return unsub;
  }, []);

  /**
   * Explicit User Directory Global Fetch (Cache-Memory-First)
   * Only called when Admin explicitly visits the User Directory or triggers an explicit refresh.
   */
  const fetchGlobalRoster = useCallback(async (forceRefresh = false): Promise<UserProfile[]> => {
    // 1. In-memory check
    if (!forceRefresh && globalRosterRef.current && globalRosterRef.current.length > 1) {
      logUserDirectoryRead('precision360_roster_cache_global', 'cache hit', true, globalRosterRef.current.length, 'In-memory global roster');
      return globalRosterRef.current;
    }

    // 2. Cache Memory First (IndexedDB - 1 hour TTL)
    const cacheKey = `precision360_roster_cache_global`;
    const longTTL = 60 * 60 * 1000;
    if (!forceRefresh) {
      try {
        const cachedRoster = await safeStorage.getIndexedDB<UserProfile[]>(cacheKey, longTTL);
        const cachedProfiles = await safeStorage.getIndexedDB<Record<string, any>>(`${cacheKey}_profiles`, longTTL);
        const cachedRoles = await safeStorage.getIndexedDB<string[]>(`${cacheKey}_roles`, longTTL);

        if (cachedRoster && Array.isArray(cachedRoster) && cachedRoster.length > 0) {
          setGlobalRoster(cachedRoster);
          if (cachedProfiles) setGlobalProfiles(cachedProfiles);
          if (cachedRoles) setRoles(cachedRoles);
          logUserDirectoryRead('precision360_roster_cache_global', 'cache hit', true, cachedRoster.length, 'IndexedDB cache-first read');
          return cachedRoster;
        }
      } catch (err) {
        console.warn('[fetchGlobalRoster] Cache memory read error:', err);
      }
    }

    // 3. Explicit Fetch from Firestore (ONLY when cache miss or explicit forceRefresh)
    console.info('🚀 [EXPLICIT GLOBAL ROSTER FETCH] Fetching employee_master collection from Firestore for User Directory...');
    const usersSnap = await getDocsCacheFirst(collection(db, 'employee_master'), 'roster_global_user_directory', forceRefresh);
    logUserDirectoryRead('roster_global_user_directory', forceRefresh ? 'manual refresh' : 'initial load', false, usersSnap.size || 0, 'Explicit User Directory fetch');

    const rawUserDocsMap = new Map<string, any>();
    usersSnap.docs.forEach(d => {
      const uData = { uid: d.id, ...d.data() };
      rawUserDocsMap.set(d.id, uData);
    });

    // Fetch associated employee profiles in batches
    const uids = Array.from(rawUserDocsMap.keys());
    const newProfiles: Record<string, any> = {};
    if (uids.length > 0) {
      const batchSize = 30;
      const profilePromises: Promise<any>[] = [];
      for (let i = 0; i < uids.length; i += batchSize) {
        const batch = uids.slice(i, i + batchSize);
        const qProfiles = query(collection(db, 'employeeProfiles'), where('__name__', 'in', batch));
        profilePromises.push(getDocsCacheFirst(qProfiles, `global_profiles_batch_${i}`, forceRefresh));
      }
      const profileSnaps = await Promise.all(profilePromises);
      profileSnaps.forEach((snap, idx) => {
        logUserDirectoryRead(`global_profiles_batch_${idx}`, forceRefresh ? 'manual refresh' : 'initial load', false, snap.size || 0);
        snap.docs.forEach(d => {
          newProfiles[d.id] = d.data();
        });
      });
    }

    const newRolesSet = new Set<string>();
    const finalGlobalRoster: UserProfile[] = Array.from(rawUserDocsMap.values())
      .filter(data => data.isDeleted !== true && data.status !== 'Deleted')
      .map(data => {
        const docId = data.uid;
        const prof = newProfiles[docId] || {};
        const merged = { ...prof, ...data };
        const name = merged.fullName || merged.name || merged.employeeName || '';
        let role = (merged.role || 'AGENT').toString().toUpperCase().trim();
        if ((merged.email || '').toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') {
          role = 'ADMIN';
        }
        if (role === 'TEAM_LEAD' || role === 'TEAM LEAD') {
          role = 'Team Lead';
        }
        newRolesSet.add(role);
        return {
          uid: docId,
          ...merged,
          name,
          fullName: name,
          email: (merged.email || '').toString().toLowerCase().trim(),
          role,
          status: merged.status || 'Active',
        } as UserProfile;
      });

    const newRoles = Array.from(newRolesSet).sort();

    // Cache in IndexedDB
    await safeStorage.setIndexedDB(cacheKey, finalGlobalRoster);
    await safeStorage.setIndexedDB(`${cacheKey}_profiles`, newProfiles);
    await safeStorage.setIndexedDB(`${cacheKey}_roles`, newRoles);

    setGlobalRoster(finalGlobalRoster);
    setGlobalProfiles(newProfiles);
    setRoles(newRoles);

    return finalGlobalRoster;
  }, []);

  const fetchRosterFromFirestore = async (
    uid: string, 
    reason: 'initial load' | 'reconnect' | 'manual refresh' = 'initial load',
    isGlobalView: boolean = false
  ) => {
    if (isGlobalView) {
      const gRoster = await fetchGlobalRoster(reason === 'manual refresh');
      return { roster: gRoster, profiles: {}, roles: [] };
    }

    // 1. Get the user's role and details first
    let role = 'AGENT';
    let email = '';
    let meData: any = null;

    const meDocRef = doc(db, 'employee_master', uid);
    let meDocSnap: any;
    try {
      meDocSnap = await getDocFromCache(meDocRef);
      if (!meDocSnap || !meDocSnap.exists()) {
        meDocSnap = await getDocOptimized(meDocRef, `user_me_doc_${uid}`);
      }
    } catch {
      meDocSnap = await getDocOptimized(meDocRef, `user_me_doc_${uid}`);
    }
    
    if (meDocSnap && meDocSnap.exists()) {
      meData = meDocSnap.data();
      role = (meData?.role || 'AGENT').toUpperCase();
      email = (meData?.email || '').toLowerCase().trim();
    } else {
      const userSnap = await getDocsCacheFirst(query(collection(db, 'employee_master'), where('uid', '==', uid)), `user_role_check_${uid}`);
      if (!userSnap.empty) {
        meData = userSnap.docs[0].data();
        role = (meData?.role || 'AGENT').toUpperCase();
        email = (meData?.email || '').toLowerCase().trim();
      }
    }

    if (email === 'mayank.semwal@bergtechnologies.co.in') {
      role = 'ADMIN';
    }

    const upperRole = role.toUpperCase().trim();
    const isTL = ['TEAM_LEAD', 'TEAM LEAD', 'TL', 'SME', 'OPS_TL', 'STL', 'QTL', 'TRAINER_TL'].some(g => upperRole.includes(g));
    const isManager = ['MANAGER', 'ASSISTANT_MANAGER', 'AM', 'OPERATIONS_MANAGER'].some(g => upperRole.includes(g));
    const isGlobal = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP', 'SUPER_ADMIN'].some(g => upperRole.includes(g));

    let rawUserDocsMap = new Map<string, any>();
    if (meData) {
      rawUserDocsMap.set(uid, { uid, ...meData });
    }

    // Check if we have global roster in cache memory (0 network reads!)
    const cacheKeyGlobal = `precision360_roster_cache_global`;
    const cachedGlobal = await safeStorage.getIndexedDB<UserProfile[]>(cacheKeyGlobal, 60 * 60 * 1000);

    if (cachedGlobal && Array.isArray(cachedGlobal) && cachedGlobal.length > 0) {
      // FAST 0ms IN-MEMORY HIERARCHY RESOLUTION FROM CACHE
      console.info(`⚡ [TMS ROSTER] Resolving hierarchy in-memory from cached global roster (${cachedGlobal.length} users) in 0ms!`);
      const normalizedAll = cachedGlobal.map(u => normalizeHierarchyUser(u));
      const meUser = normalizedAll.find(u => u.uid === uid) || normalizeHierarchyUser({ uid, role, email, ...meData });
      
      if (isGlobal) {
        cachedGlobal.forEach(u => rawUserDocsMap.set(u.uid, u));
      } else {
        const descendants = new Set(getSubordinateUids(meUser, normalizedAll, false));
        cachedGlobal.forEach(u => {
          if (u.uid === uid || descendants.has(u.uid)) {
            rawUserDocsMap.set(u.uid, u);
          }
        });
      }
    } else if (isTL) {
      // Targeted queries for Team Lead reportees (NO GLOBAL SCAN)
      console.info(`🎯 [TMS TARGETED FETCH] Fetching direct reportees for Team Lead: ${uid}`);
      const queries = [
        query(collection(db, 'employee_master'), where('teamLeadUid', '==', uid)),
        query(collection(db, 'employee_master'), where('tlId', '==', uid)),
      ];
      if (email) {
        queries.push(query(collection(db, 'employee_master'), where('teamLeadEmail', '==', email)));
      }
      const snaps = await Promise.all(queries.map((q, idx) => getDocsCacheFirst(q, `tl_reportees_${uid}_${idx}`)));
      snaps.forEach(snap => {
        snap.docs.forEach(d => {
          rawUserDocsMap.set(d.id, { uid: d.id, ...d.data() });
        });
      });
    } else if (isManager) {
      // Targeted queries for Manager reportees (NO GLOBAL SCAN)
      console.info(`🎯 [TMS TARGETED FETCH] Fetching reportees for Manager: ${uid}`);
      const queries = [
        query(collection(db, 'employee_master'), where('managerUid', '==', uid)),
        query(collection(db, 'employee_master'), where('mappedManagerUid', '==', uid)),
      ];
      if (email) {
        queries.push(query(collection(db, 'employee_master'), where('mappedManagerEmail', '==', email)));
      }
      const snaps = await Promise.all(queries.map((q, idx) => getDocsCacheFirst(q, `mgr_reportees_${uid}_${idx}`)));
      snaps.forEach(snap => {
        snap.docs.forEach(d => {
          rawUserDocsMap.set(d.id, { uid: d.id, ...d.data() });
        });
      });
    } else if (isGlobal) {
      // For global roles without cached global roster: query any direct reportees
      console.info(`🎯 [TMS TARGETED FETCH] Scoped load for Global Role: ${uid} (Global scan disabled on startup)`);
      const queries = [
        query(collection(db, 'employee_master'), where('managerUid', '==', uid)),
        query(collection(db, 'employee_master'), where('mappedManagerUid', '==', uid)),
      ];
      const snaps = await Promise.all(queries.map((q, idx) => getDocsCacheFirst(q, `global_direct_${uid}_${idx}`)));
      snaps.forEach(snap => {
        snap.docs.forEach(d => {
          rawUserDocsMap.set(d.id, { uid: d.id, ...d.data() });
        });
      });
    }

    const allResolvedNodes = Array.from(rawUserDocsMap.values());
    await safeStorage.setIndexedDB(`precision360_hierarchy_nodes_${uid}`, allResolvedNodes);

    // Fetch profiles for the resolved hierarchy nodes
    const hierarchyUids = Array.from(rawUserDocsMap.keys());
    const newProfiles: Record<string, any> = {};

    if (hierarchyUids.length > 0) {
      const batchSize = 30;
      const profilePromises: Promise<any>[] = [];
      for (let i = 0; i < hierarchyUids.length; i += batchSize) {
        const batch = hierarchyUids.slice(i, i + batchSize);
        const qProfiles = query(collection(db, 'employeeProfiles'), where('__name__', 'in', batch));
        profilePromises.push(getDocsCacheFirst(qProfiles, `roster_profiles_batch_${i}`));
      }
      const profileSnaps = await Promise.all(profilePromises);
      profileSnaps.forEach((snap, idx) => {
        snap.docs.forEach(d => {
          newProfiles[d.id] = d.data();
        });
      });
    }

    const newRolesSet = new Set<string>();
    const finalRoster = Array.from(rawUserDocsMap.values())
      .filter(data => data.isDeleted !== true && data.status !== 'Deleted' && data.status !== 'Archived')
      .map(data => {
        const docId = data.uid;
        const prof = newProfiles[docId] || {};
        const merged = { ...prof, ...data };
        const name = merged.fullName || merged.name || merged.employeeName || '';
        let r = (merged.role || 'AGENT').toString().toUpperCase().trim();
        if ((merged.email || '').toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in') {
          r = 'ADMIN';
        }
        if (r === 'TEAM_LEAD' || r === 'TEAM LEAD') {
          r = 'Team Lead';
        }
        newRolesSet.add(r);
        return {
          uid: docId,
          ...merged,
          name,
          fullName: name,
          email: (merged.email || '').toString().toLowerCase().trim(),
          role: r,
          status: merged.status || 'Active',
        } as UserProfile;
      });

    if (!finalRoster.find(u => u.uid === uid) && meData) {
      finalRoster.push({
        uid,
        ...meData,
        name: meData.fullName || meData.name || 'Me',
        fullName: meData.fullName || meData.name || 'Me',
        role: (meData.role || 'AGENT').toUpperCase(),
        status: meData.status || 'Active',
        email: (meData.email || '').toLowerCase().trim()
      } as UserProfile);
    }

    const newRoles = Array.from(newRolesSet).sort();

    const cacheKeyPrefix = `precision360_roster_cache_${uid}`;
    await safeStorage.setIndexedDB(cacheKeyPrefix, finalRoster);
    await safeStorage.setIndexedDB(`${cacheKeyPrefix}_profiles`, newProfiles);
    await safeStorage.setIndexedDB(`${cacheKeyPrefix}_roles`, newRoles);

    return { roster: finalRoster, profiles: newProfiles, roles: newRoles };
  };

  const activeRefreshPromiseRef = useRef<Promise<void> | null>(null);

  const refreshRoster = useCallback(async (forceRefresh = false, isGlobalView = false) => {
    if (!currentUser) return;
    if (activeRefreshPromiseRef.current) return activeRefreshPromiseRef.current;

    const uid = currentUser.uid;
    const cacheKeyPrefix = `precision360_roster_cache_${uid}${isGlobalView ? '_global' : ''}`;
    const hierarchyCacheKey = `precision360_hierarchy_nodes_${uid}`;

    const promise = (async () => {
      setIsLoading(true);
      try {
        if (!forceRefresh) {
          // Attempt to load hierarchy relationships and profiles from IndexedDB (10-minute long TTL)
          const longTTL = 10 * 60 * 1000;
          const cachedNodes = await safeStorage.getIndexedDB<any[]>(hierarchyCacheKey, longTTL);
          const cachedRoster = await safeStorage.getIndexedDB<UserProfile[]>(cacheKeyPrefix, longTTL);
          const cachedProfiles = await safeStorage.getIndexedDB<Record<string, any>>(`${cacheKeyPrefix}_profiles`, longTTL);
          const cachedRoles = await safeStorage.getIndexedDB<string[]>(`${cacheKeyPrefix}_roles`, longTTL);

          if (cachedRoster && cachedProfiles && cachedRoles && (isGlobalView || cachedNodes)) {
            // Rebuild OrgTree in memory locally from cached hierarchy nodes
            if (cachedNodes && !isGlobalView) {
              const localOrgTree = new OrgTree(cachedNodes);
              const descendants = localOrgTree.getDescendants(uid);
              console.info(`🏠 [WARM STARTUP] Resolved ${descendants.size} descendants locally from IndexedDB hierarchy cache.`);
            }
            if (isGlobalView) {
              setGlobalRoster(cachedRoster);
              setGlobalProfiles(cachedProfiles);
            } else {
              setRoster(cachedRoster);
              setProfiles(cachedProfiles);
            }
            setRoles(cachedRoles);
            logUserDirectoryRead(`precision360_roster_cache_${uid}`, 'cache hit', true, cachedRoster.length);
            return;
          }
        }

        const { roster: newRoster, profiles: newProfiles, roles: newRoles } = await fetchRosterFromFirestore(uid, forceRefresh ? 'manual refresh' : 'initial load', isGlobalView);
        if (isGlobalView) {
          setGlobalRoster(newRoster);
          setGlobalProfiles(newProfiles);

          // Re-derive hierarchy roster in-memory for current user so TMS Dashboard reflects instantly
          if (uid) {
            const meUser = newRoster.find(u => u.uid === uid);
            const roleUpper = (meUser?.role || '').toString().toUpperCase().trim();
            const checkIsGlobalRole = (r: string) => {
              const globals = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP', 'SUPER_ADMIN'];
              return globals.some(g => r.includes(g));
            };
            const isGlobal = checkIsGlobalRole(roleUpper);

            let hierarchyRoster: UserProfile[];
            if (isGlobal) {
              hierarchyRoster = newRoster;
            } else {
              const subordinateUids = meUser ? new Set(getSubordinateUids(meUser as any, newRoster as any, false)) : new Set<string>();
              hierarchyRoster = newRoster.filter(u => u.uid === uid || subordinateUids.has(u.uid));
            }
            setRoster(hierarchyRoster);
            setProfiles(newProfiles);

            const cacheKeyPrefix = `precision360_roster_cache_${uid}`;
            safeStorage.setIndexedDB(cacheKeyPrefix, hierarchyRoster);
            safeStorage.setIndexedDB(`${cacheKeyPrefix}_profiles`, newProfiles);
            safeStorage.setIndexedDB(`precision360_hierarchy_nodes_${uid}`, hierarchyRoster);
          }
        } else {
          setRoster(newRoster);
          setProfiles(newProfiles);
        }
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
  }, [currentUser, fetchGlobalRoster]);

  const invalidateRosterCache = useCallback(async () => {
    if (!currentUser) return;
    const uid = currentUser.uid;
    await safeStorage.clearAllIndexedDBByPrefix('precision360_roster_cache_');
    await safeStorage.clearAllIndexedDBByPrefix('precision360_hierarchy_nodes_');
    await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
    invalidateCacheKey(`roster_fetch_${uid}`);
    invalidateCacheKey(`roster_refresh_${uid}`);
    await refreshRoster(true);
  }, [refreshRoster, currentUser]);

  // Incremental user state updates (avoids full roster reloads!)
  const updateUserInRoster = useCallback(async (updatedUser: Partial<UserProfile> & { uid: string }) => {
    if (!updatedUser || !updatedUser.uid) return;
    
    let nextGlobalRoster: UserProfile[] = [];

    // Update global roster
    setGlobalRoster(prevGlobal => {
      const index = prevGlobal.findIndex(u => u.uid === updatedUser.uid);
      if (index >= 0) {
        nextGlobalRoster = [...prevGlobal];
        const mergedName = updatedUser.fullName || updatedUser.name || prevGlobal[index].fullName || prevGlobal[index].name || '';
        nextGlobalRoster[index] = {
          ...prevGlobal[index],
          ...updatedUser,
          name: mergedName,
          fullName: mergedName,
        };
      } else {
        const mergedName = updatedUser.fullName || updatedUser.name || 'User';
        nextGlobalRoster = [...prevGlobal, {
          name: mergedName,
          fullName: mergedName,
          email: '',
          role: 'AGENT',
          status: 'Active',
          ...updatedUser
        } as UserProfile];
      }

      if (currentUser) {
        const uid = currentUser.uid;
        const cacheKeyPrefix = `precision360_roster_cache_${uid}_global`;
        safeStorage.setIndexedDB(cacheKeyPrefix, nextGlobalRoster);
      }
      return nextGlobalRoster;
    });

    // Update hierarchy roster
    setRoster(prevRoster => {
      const poolMap = new Map<string, UserProfile>();
      if (nextGlobalRoster && nextGlobalRoster.length > 0) {
        nextGlobalRoster.forEach(u => poolMap.set(u.uid, u));
      } else {
        prevRoster.forEach(u => poolMap.set(u.uid, u));
      }

      const existing = poolMap.get(updatedUser.uid);
      const mergedName = updatedUser.fullName || updatedUser.name || existing?.fullName || existing?.name || 'User';
      poolMap.set(updatedUser.uid, {
        name: mergedName,
        fullName: mergedName,
        email: '',
        role: 'AGENT',
        status: 'Active',
        ...existing,
        ...updatedUser
      } as UserProfile);

      const allUsersPool = Array.from(poolMap.values());
      let newRoster: UserProfile[];

      if (currentUser) {
        const tree = new OrgTree(allUsersPool as any);
        const descendants = tree.getDescendants(currentUser.uid);
        newRoster = allUsersPool.filter(u => u.uid === currentUser.uid || descendants.has(u.uid));
      } else {
        newRoster = allUsersPool;
      }

      if (currentUser) {
        const uid = currentUser.uid;
        safeStorage.setIndexedDB(`precision360_hierarchy_nodes_${uid}`, newRoster);

        const cacheKeyPrefix = `precision360_roster_cache_${uid}`;
        safeStorage.setIndexedDB(cacheKeyPrefix, newRoster);
      }
      return newRoster;
    });

    if (updatedUser.profilePhotoUrl || updatedUser.phone || updatedUser.address || updatedUser.role) {
      setProfiles(prev => {
        const newProfiles = { ...prev, [updatedUser.uid]: { ...(prev[updatedUser.uid] || {}), ...updatedUser } };
        if (currentUser) {
          const cacheKeyPrefix = `precision360_roster_cache_${currentUser.uid}`;
          safeStorage.setIndexedDB(`${cacheKeyPrefix}_profiles`, newProfiles);
        }
        return newProfiles;
      });
    }

    // Bump global hierarchy version for cross-client propagation
    bumpHierarchyVersion(currentUser?.email || undefined).catch(console.warn);

    logUserDirectoryRead('single_user_mutation', 'mutation reconciliation', true, 0, `Reconciled user locally with incremental hierarchy synchronization: ${updatedUser.uid}`);
  }, [currentUser]);

  const addUserToRoster = useCallback(async (newUser: UserProfile) => {
    await updateUserInRoster(newUser);
  }, [updateUserInRoster]);

  const deleteUserFromRoster = useCallback(async (uid: string) => {
    if (!uid) return;
    setRoster(prev => {
      const newRoster = prev.filter(u => u.uid !== uid);
      if (currentUser) {
        const cacheKeyPrefix = `precision360_roster_cache_${currentUser.uid}`;
        safeStorage.setIndexedDB(cacheKeyPrefix, newRoster);
      }
      return newRoster;
    });
    setGlobalRoster(prev => {
      const newGlobal = prev.filter(u => u.uid !== uid);
      if (currentUser) {
        const cacheKeyPrefix = `precision360_roster_cache_${currentUser.uid}_global`;
        safeStorage.setIndexedDB(cacheKeyPrefix, newGlobal);
      }
      return newGlobal;
    });
    setProfiles(prev => {
      const newProfiles = { ...prev };
      delete newProfiles[uid];
      if (currentUser) {
        const cacheKeyPrefix = `precision360_roster_cache_${currentUser.uid}`;
        safeStorage.setIndexedDB(`${cacheKeyPrefix}_profiles`, newProfiles);
      }
      return newProfiles;
    });
    setGlobalProfiles(prev => {
      const newProfiles = { ...prev };
      delete newProfiles[uid];
      if (currentUser) {
        const cacheKeyPrefix = `precision360_roster_cache_${currentUser.uid}_global`;
        safeStorage.setIndexedDB(`${cacheKeyPrefix}_profiles`, newProfiles);
      }
      return newProfiles;
    });
    if (currentUser) {
      const longTTL = 30 * 24 * 60 * 60 * 1000;
      safeStorage.getIndexedDB<any[]>(`precision360_hierarchy_nodes_${currentUser.uid}`, longTTL).then(cachedNodes => {
        if (cachedNodes) {
          const updatedNodes = cachedNodes.filter(n => n.uid !== uid);
          safeStorage.setIndexedDB(`precision360_hierarchy_nodes_${currentUser.uid}`, updatedNodes);
        }
      });
    }
    bumpHierarchyVersion(currentUser?.email || undefined).catch(console.warn);
    logUserDirectoryRead('single_user_deletion', 'mutation reconciliation', true, 0, `Deleted user locally from hierarchy and global roster: ${uid}`);
  }, [currentUser]);

  const updateMultipleUsersInRoster = useCallback(async (updates: Array<Partial<UserProfile> & { uid: string }>) => {
    if (!updates || updates.length === 0) return;
    const updatesMap = new Map<string, Partial<UserProfile>>();
    updates.forEach(u => { if (u.uid) updatesMap.set(u.uid, u); });

    let nextGlobalRoster: UserProfile[] = [];

    setGlobalRoster(prevGlobal => {
      const newGlobal = prevGlobal.map(u => {
        const upd = updatesMap.get(u.uid);
        if (!upd) return u;
        const mergedName = upd.fullName || upd.name || u.fullName || u.name || '';
        return {
          ...u,
          ...upd,
          name: mergedName,
          fullName: mergedName,
        };
      });

      updates.forEach(upd => {
        if (!newGlobal.some(u => u.uid === upd.uid)) {
          const mergedName = upd.fullName || upd.name || 'User';
          newGlobal.push({
            name: mergedName,
            fullName: mergedName,
            email: '',
            role: 'AGENT',
            status: 'Active',
            ...upd
          } as UserProfile);
        }
      });

      nextGlobalRoster = newGlobal;

      if (currentUser) {
        const uid = currentUser.uid;
        const cacheKeyPrefix = `precision360_roster_cache_${uid}_global`;
        safeStorage.setIndexedDB(cacheKeyPrefix, newGlobal);
      }
      return newGlobal;
    });

    setRoster(prevRoster => {
      const poolMap = new Map<string, UserProfile>();
      if (nextGlobalRoster && nextGlobalRoster.length > 0) {
        nextGlobalRoster.forEach(u => poolMap.set(u.uid, u));
      } else {
        prevRoster.forEach(u => poolMap.set(u.uid, u));
      }

      updates.forEach(upd => {
        const existing = poolMap.get(upd.uid);
        const mergedName = upd.fullName || upd.name || existing?.fullName || existing?.name || 'User';
        poolMap.set(upd.uid, {
          name: mergedName,
          fullName: mergedName,
          email: '',
          role: 'AGENT',
          status: 'Active',
          ...existing,
          ...upd
        } as UserProfile);
      });

      const allUsersPool = Array.from(poolMap.values());
      let newRoster: UserProfile[];

      if (currentUser) {
        const tree = new OrgTree(allUsersPool as any);
        const descendants = tree.getDescendants(currentUser.uid);
        newRoster = allUsersPool.filter(u => u.uid === currentUser.uid || descendants.has(u.uid));
      } else {
        newRoster = allUsersPool;
      }

      if (currentUser) {
        const uid = currentUser.uid;
        safeStorage.setIndexedDB(`precision360_hierarchy_nodes_${uid}`, newRoster);

        const cacheKeyPrefix = `precision360_roster_cache_${uid}`;
        safeStorage.setIndexedDB(cacheKeyPrefix, newRoster);
      }
      return newRoster;
    });

    bumpHierarchyVersion(currentUser?.email || undefined).catch(console.warn);
    logUserDirectoryRead('bulk_user_mutation', 'mutation reconciliation', true, 0, `Reconciled ${updates.length} users locally with incremental hierarchy synchronization`);
  }, [currentUser]);

  useEffect(() => {
    if (globalRoster.length > 0 && roster.length > 0) {
      const globalUids = new Set(globalRoster.map(u => u.uid));
      const tmsUids = new Set(roster.map(u => u.uid));
      const globalOnlyUids = Array.from(globalUids).filter(uid => !tmsUids.has(uid));
      const tmsOnlyUids = Array.from(tmsUids).filter(uid => !globalUids.has(uid));
      
      console.info(`[TMS ROSTER FORENSIC]
actor=${currentUser?.uid || 'none'}
globalCount=${globalRoster.length}
hierarchyResolvedCount=${roster.length}
cachedHierarchyCount=${roster.length}
tmsRosterCount=${roster.length}
renderedCount=${roster.length}
globalOnly=${globalOnlyUids.join(', ') || 'none'}
tmsOnly=${tmsOnlyUids.join(', ') || 'none'}`);

      globalOnlyUids.forEach(uid => {
        const u = globalRoster.find(item => item.uid === uid);
        if (u) {
          console.info(`[GLOBAL_ONLY USER EXCLUSION REASON]
uid=${u.uid}
name=${u.name || u.fullName || 'Unknown'}
email=${u.email || 'none'}
role=${u.role || 'AGENT'}
status=${u.status || 'Active'}
teamLeadUid=${u.teamLeadUid || u.teamLeadId || 'none'}
managerUid=${u.managerUid || u.managerId || 'none'}
teamLeadEmail=${u.teamLeadEmail || 'none'}
managerEmail=${u.managerEmail || 'none'}
reason=User exists in global employee_master (${globalRoster.length} total) but is excluded from TMS hierarchy downline (${roster.length} users) because their reporting chain (teamLeadUid/managerUid/email) does not connect to the current actor's downline tree.`);
        }
      });
    }
  }, [globalRoster, roster, currentUser]);

  const lastSeenVersionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!currentUser) return;
    const unsub = subscribeToHierarchyVersion((remoteVersion, meta) => {
      if (lastSeenVersionRef.current === null) {
        lastSeenVersionRef.current = remoteVersion;
        return;
      }
      if (remoteVersion > lastSeenVersionRef.current) {
        console.info(`⚡ [HIERARCHY VERSION UPDATED] Remote version ${remoteVersion} (was ${lastSeenVersionRef.current}). Invalidating caches and refreshing hierarchy for actor=${currentUser.uid}...`);
        lastSeenVersionRef.current = remoteVersion;
        
        // Invalidate caches
        const uid = currentUser.uid;
        safeStorage.clearAllIndexedDBByPrefix(`precision360_roster_cache_${uid}`).catch(console.warn);
        safeStorage.clearAllIndexedDBByPrefix(`precision360_hierarchy_nodes_${uid}`).catch(console.warn);
        safeStorage.clearAllIndexedDBByPrefix('subordinates_').catch(console.warn);
        invalidateCacheKey(`roster_fetch_${uid}`);
        invalidateCacheKey(`roster_refresh_${uid}`);

        // Targeted refresh
        refreshRoster(true, false);
      }
    });

    return () => unsub();
  }, [currentUser, refreshRoster]);

  useEffect(() => {
    if (currentUser) {
      refreshRoster();
    }
  }, [currentUser, refreshRoster]);

  return (
    <RosterContext.Provider value={{
      roster,
      profiles,
      globalRoster,
      globalProfiles,
      roles,
      isLoading,
      refreshRoster,
      fetchGlobalRoster,
      invalidateRosterCache,
      updateUserInRoster,
      addUserToRoster,
      deleteUserFromRoster,
      updateMultipleUsersInRoster,
      orgTree
    }}>
      {children}
    </RosterContext.Provider>
  );
};

export const useRoster = () => {
  const context = useContext(RosterContext);
  if (!context) throw new Error('useRoster must be used within RosterProvider');
  return context;
};

