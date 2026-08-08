import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { doc, getDoc, collection } from 'firebase/firestore';
import { db, getDocOptimized, getDocsOptimized, clearCache } from '../lib/firebase';
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

    try {
      console.log('[ConfigContext] Fetching all configurations...');
      
      const [attendanceSnap, tmsSnap, permissionsSnap, masterSnap, rolesSnap, officeSnap] = await Promise.all([
        getDocOptimized(doc(db, 'config', 'attendanceSettings'), 'attendance_settings_global', isManual),
        getDocOptimized(doc(db, 'config', 'tmsProcesses'), 'tms_processes_global', isManual),
        getDocOptimized(doc(db, 'role_permissions', 'global_fetch'), 'role_permissions_global', isManual),
        getDocOptimized(doc(db, 'config', 'master'), 'master_config_global', isManual),
        getDocsOptimized(collection(db, 'roles'), 'roles_global_fetch', isManual),
        getDocOptimized(doc(db, 'config', 'office_networks'), 'office_networks_global', isManual)
      ]);

      if (attendanceSnap.exists()) setAttendanceSettings(attendanceSnap.data());
      if (tmsSnap.exists()) setTmsProcesses(tmsSnap.data());
      if (masterSnap.exists()) setMasterConfig(masterSnap.data());
      if (officeSnap.exists()) setOfficeNetworks(officeSnap.data());
      
      if (rolesSnap) {
        const roles = rolesSnap.docs.map(doc => doc.id.trim());
        setRolesList(roles);
      }

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
    try {
      const { collection, getDocs, query, where } = await import('firebase/firestore');
      
      const roleName = (user.role || 'AGENT').toUpperCase();
      const uniqueRoles = Array.from(new Set([
        roleName,
        normalizeRole(roleName),
        roleName.replace(/\s+/g, '_')
      ])).filter(Boolean);

      // We only fetch relevant roles for the current user to keep read count low (~30 vs 150+)
      // If admin needs full list for editing, a separate admin-only fetch can be triggered
      const q = query(
        collection(db, 'role_permissions'),
        where('role_name', 'in', uniqueRoles)
      );

      const snap = await getDocs(q);
      setRolePermissions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('[ConfigContext] Error fetching role_permissions optimized query:', err);
    }
  }, [user]);

  const refreshAll = async () => {
    await Promise.all([fetchConfig(true), fetchPermissions(true)]);
  };

  useEffect(() => {
    if (user) {
      refreshAll();
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
