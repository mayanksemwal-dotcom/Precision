import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { doc, getDoc, collection } from 'firebase/firestore';
import { db, getDocOptimized, getDocsOptimized, clearCache } from '../lib/firebase';
import { safeStorage } from '../lib/safeStorage';
import { toast } from 'sonner';
import { UserProfile } from '../types';

interface ConfigContextType {
  attendanceSettings: any;
  tmsProcesses: any;
  rolePermissions: any[];
  rolesList: string[]; // Added
  masterConfig: any;
  officeNetworks: any;
  loading: boolean;
  refreshAll: () => Promise<void>;
  lastRefresh: Date | null;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

// Helper to normalize roles for consistent DB querying
const normalizeRole = (role: string) => {
  if (!role) return '';
  return role.toUpperCase().replace(/\s+/g, '_').trim();
};

export const ConfigProvider: React.FC<{ children: React.ReactNode, user: UserProfile | null }> = ({ children, user }) => {
  const [attendanceSettings, setAttendanceSettings] = useState<any>(null);
  const [tmsProcesses, setTmsProcesses] = useState<any>(null);
  const [rolePermissions, setRolePermissions] = useState<any[]>([]);
  const [rolesList, setRolesList] = useState<string[]>([]); // Added
  const [masterConfig, setMasterConfig] = useState<any>(null);
  const [officeNetworks, setOfficeNetworks] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  
  const isRefreshing = useRef(false);

  const fetchConfig = useCallback(async (isManual = false) => {
    if (!user || isRefreshing.current) return;
    
    // Skip if hidden/inactive unless manual
    if (!isManual && (document.hidden || !document.hasFocus())) {
      console.log('[ConfigContext] Skipping background poll: Window inactive');
      return;
    }

    if (isManual) {
      clearCache();
    }

    isRefreshing.current = true;
    if (isManual) {
      toast.loading('Refreshing system configurations...', { id: 'config-refresh' });
    }

    const cacheKey = `precision360_system_configs_${user.uid}`;
    // TTL of 4 hours (14400000 ms) - fetched once per shift/session
    const cacheTTL = 4 * 60 * 60 * 1000;

    try {
      if (!isManual) {
        // Try Cache-first lookup to save read costs on initial load
        const cached = await safeStorage.getIndexedDB<any>(cacheKey, cacheTTL);
        if (cached) {
          console.info('⚡ [CONFIG ENGINE] Loaded all reference configurations from persistent local cache.');
          if (cached.attendanceSettings) setAttendanceSettings(cached.attendanceSettings);
          if (cached.tmsProcesses) setTmsProcesses(cached.tmsProcesses);
          if (cached.masterConfig) setMasterConfig(cached.masterConfig);
          if (cached.officeNetworks) setOfficeNetworks(cached.officeNetworks);
          if (cached.rolesList) setRolesList(cached.rolesList);
          setLastRefresh(new Date(cached.cachedAt || Date.now()));
          setLoading(false);
          isRefreshing.current = false;
          return;
        }
      }

      console.log('[ConfigContext] Cache stale or manual refresh. Fetching all configurations from Firestore...');
      
      const [attendanceSnap, tmsSnap, permissionsSnap, masterSnap, rolesSnap, officeSnap] = await Promise.all([
        getDocOptimized(doc(db, 'config', 'attendanceSettings'), 'attendance_settings_global', isManual),
        getDocOptimized(doc(db, 'config', 'tmsProcesses'), 'tms_processes_global', isManual),
        getDocOptimized(doc(db, 'role_permissions', 'global_fetch'), 'role_permissions_global', isManual),
        getDocOptimized(doc(db, 'config', 'master'), 'master_config_global', isManual),
        getDocsOptimized(collection(db, 'roles'), 'roles_global_fetch', isManual),
        getDocOptimized(doc(db, 'config', 'office_networks'), 'office_networks_global', isManual)
      ]);

      const freshConfig: any = { cachedAt: Date.now() };

      if (attendanceSnap.exists()) {
        const d = attendanceSnap.data();
        setAttendanceSettings(d);
        freshConfig.attendanceSettings = d;
      }
      if (tmsSnap.exists()) {
        const d = tmsSnap.data();
        setTmsProcesses(d);
        freshConfig.tmsProcesses = d;
      }
      if (masterSnap.exists()) {
        const d = masterSnap.data();
        setMasterConfig(d);
        freshConfig.masterConfig = d;
      }
      if (officeSnap.exists()) {
        const d = officeSnap.data();
        setOfficeNetworks(d);
        freshConfig.officeNetworks = d;
      }
      
      if (rolesSnap) {
        const roles = rolesSnap.docs.map(doc => doc.id.trim());
        setRolesList(roles);
        freshConfig.rolesList = roles;
      }

      // Save successful load in dedicated IndexedDB cache
      await safeStorage.setIndexedDB(cacheKey, freshConfig);

      setLastRefresh(new Date());
      if (isManual) {
        toast.success('Configurations updated successfully', { id: 'config-refresh' });
      }
    } catch (err) {
      console.error('[ConfigContext] Failed to fetch configurations:', err);
      if (isManual) {
        toast.error('Failed to refresh configurations', { id: 'config-refresh' });
      }
    } finally {
      setLoading(false);
      isRefreshing.current = false;
    }
  }, [user]);

  // Handle role_permissions with optimized query to save reads
  const fetchPermissions = useCallback(async (isManual = false) => {
    if (!user) return;

    const cacheKey = `precision360_role_permissions_${user.uid}`;
    const cacheTTL = 4 * 60 * 60 * 1000; // 4 hours

    try {
      if (!isManual) {
        const cached = await safeStorage.getIndexedDB<any[]>(cacheKey, cacheTTL);
        if (cached) {
          console.info('⚡ [CONFIG ENGINE] Loaded user role permissions from local cache.');
          setRolePermissions(cached);
          return;
        }
      }

      const { collection, getDocs, query, where } = await import('firebase/firestore');
      
      const roleName = (user.role || 'AGENT').toUpperCase();
      const uniqueRoles = Array.from(new Set([
        roleName,
        normalizeRole(roleName),
        roleName.replace(/\s+/g, '_')
      ])).filter(Boolean);

      // We only fetch relevant roles for the current user to keep read count low (~30 vs 150+)
      const q = query(
        collection(db, 'role_permissions'),
        where('role_name', 'in', uniqueRoles)
      );

      const snap = await getDocsOptimized(q, 'role_permissions_user_roles_' + user.uid, isManual);
      const permissionsList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      
      setRolePermissions(permissionsList);
      await safeStorage.setIndexedDB(cacheKey, permissionsList);
    } catch (err) {
      console.error('[ConfigContext] Error fetching role_permissions optimized query:', err);
    }
  }, [user]);

  const refreshAll = async (isManual = false) => {
    await Promise.all([fetchConfig(isManual), fetchPermissions(isManual)]);
  };

  useEffect(() => {
    if (user) {
      refreshAll(false);
    }
  }, [user?.uid]);

  // Optimization: Remove duplicate polling by consolidating here
  // We only poll very infrequently, or wait for manual refresh
  useEffect(() => {
    if (!user) return;

    const interval = setInterval(() => {
      fetchConfig();
    }, 30 * 60 * 1000); // 30 minutes global poll

    return () => clearInterval(interval);
  }, [user, fetchConfig]);

  return (
    <ConfigContext.Provider value={{
      attendanceSettings,
      tmsProcesses,
      rolePermissions,
      rolesList,
      masterConfig,
      officeNetworks,
      loading,
      refreshAll,
      lastRefresh
    }}>
      {children}
    </ConfigContext.Provider>
  );
};

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
};
