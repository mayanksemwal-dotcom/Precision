import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, getDocs, onSnapshot } from 'firebase/firestore';
import { UserProfile, UserRole } from '../types';

export interface TMSPermissions {
  // SELF SERVICE PERMISSIONS
  view_self_service: boolean;
  can_punch_in: boolean;
  can_punch_out: boolean;
  can_switch_process: boolean;
  can_start_break: boolean;
  can_end_break: boolean;
  can_start_lunch: boolean;
  can_end_lunch: boolean;
  can_start_meeting: boolean;
  can_end_meeting: boolean;
  can_view_own_shift_summary: boolean;
  can_view_own_attendance_summary: boolean;

  // MONITORING PERMISSIONS
  view_workforce_dashboard: boolean;
  view_realtime_tracking: boolean;
  view_logged_in_users: boolean;
  view_team_status: boolean;
  view_team_productivity: boolean;
  view_team_attendance: boolean;
  view_team_shift_summary: boolean;

  // ADMINISTRATIVE PERMISSIONS
  view_workforce_control: boolean;
  can_force_logout: boolean;
  can_force_out: boolean;
  can_edit_tms_records: boolean;
  can_modify_activities: boolean;
  can_close_sessions: boolean;
  view_team_session_audit_logs: boolean;
  view_clock_master_consolidation: boolean;
  view_org_wide_workforce_data: boolean;
}

export const getDefaultTmsPermissions = (roleName: string): TMSPermissions => {
  const norm = (roleName || '').toUpperCase().trim();
  const isAdmin = norm === 'ADMIN';
  const isManager = norm === 'MANAGER';
  const isTLOrSupervisor = [
    'TEAM_LEAD',
    'STL',
    'OPS_TL',
    'QTL',
    'TRAINER_TL'
  ].includes(norm);
  const isMIS = norm === 'MIS';
  const isAgentOrQA = ['AGENT', 'QA', 'SME', 'TRAINER'].includes(norm);

  const selfService = {
    view_self_service: !isMIS,
    can_punch_in: !isMIS,
    can_punch_out: !isMIS,
    can_switch_process: !isMIS,
    can_start_break: !isMIS,
    can_end_break: !isMIS,
    can_start_lunch: !isMIS,
    can_end_lunch: !isMIS,
    can_start_meeting: !isMIS,
    can_end_meeting: !isMIS,
    can_view_own_shift_summary: !isMIS,
    can_view_own_attendance_summary: !isMIS,
  };

  const monitoring = {
    view_workforce_dashboard: isTLOrSupervisor || isManager || isAdmin || isMIS,
    view_realtime_tracking: isTLOrSupervisor || isManager || isAdmin || isMIS,
    view_logged_in_users: isTLOrSupervisor || isManager || isAdmin || isMIS,
    view_team_status: isTLOrSupervisor || isManager || isAdmin || isMIS,
    view_team_productivity: isTLOrSupervisor || isManager || isAdmin || isMIS,
    view_team_attendance: isTLOrSupervisor || isManager || isAdmin || isMIS,
    view_team_shift_summary: isTLOrSupervisor || isManager || isAdmin || isMIS,
  };

  const administrative = {
    view_workforce_control: isManager || isAdmin,
    can_force_logout: isTLOrSupervisor || isManager || isAdmin,
    can_force_out: isTLOrSupervisor || isManager || isAdmin,
    can_edit_tms_records: isManager || isAdmin,
    can_modify_activities: isManager || isAdmin,
    can_close_sessions: isManager || isAdmin,
    view_team_session_audit_logs: isManager || isAdmin,
    view_clock_master_consolidation: isManager || isAdmin,
    view_org_wide_workforce_data: isManager || isAdmin,
  };

  if (isAdmin) {
    return {
      view_self_service: true,
      can_punch_in: true,
      can_punch_out: true,
      can_switch_process: true,
      can_start_break: true,
      can_end_break: true,
      can_start_lunch: true,
      can_end_lunch: true,
      can_start_meeting: true,
      can_end_meeting: true,
      can_view_own_shift_summary: true,
      can_view_own_attendance_summary: true,
      view_workforce_dashboard: true,
      view_realtime_tracking: true,
      view_logged_in_users: true,
      view_team_status: true,
      view_team_productivity: true,
      view_team_attendance: true,
      view_team_shift_summary: true,
      view_workforce_control: true,
      can_force_logout: true,
      can_force_out: true,
      can_edit_tms_records: true,
      can_modify_activities: true,
      can_close_sessions: true,
      view_team_session_audit_logs: true,
      view_clock_master_consolidation: true,
      view_org_wide_workforce_data: true,
    };
  }

  return {
    ...selfService,
    ...monitoring,
    ...administrative,
  };
};

interface PermissionActions {
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_export: boolean;
  can_approve: boolean;
  view_team: boolean;
  view_all: boolean;
  assign: boolean;
  override: boolean;
  force_action: boolean;
  manage_settings: boolean;
  manage_masters: boolean;
  audit_access: boolean;
  email_trigger: boolean;
  bulk_action: boolean;
  reopen_records: boolean;
  escalate: boolean;
  comment: boolean;
  view_sensitive_data: boolean;
  tms_permissions?: TMSPermissions;
}

interface PermissionContextType {
  permissions: Record<string, PermissionActions>;
  loading: boolean;
  canView: (module: string) => boolean;
  canCreate: (module: string) => boolean;
  canEdit: (module: string) => boolean;
  canDelete: (module: string) => boolean;
  canExport: (module: string) => boolean;
  canApprove: (module: string) => boolean;
  hasTmsPermission: (permKey: keyof TMSPermissions) => boolean;
}

const PermissionContext = createContext<PermissionContextType | undefined>(undefined);

export const usePermission = () => {
  const context = useContext(PermissionContext);
  if (!context) {
    throw new Error('usePermission must be used within a PermissionProvider');
  }
  return context;
};

interface PermissionProviderProps {
  children: ReactNode;
  user: UserProfile | null;
  overriddenRole?: string; // For "View As Role" feature
}

export const PermissionProvider: React.FC<PermissionProviderProps> = ({ children, user, overriddenRole }) => {
  const [permissions, setPermissions] = useState<Record<string, PermissionActions>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setPermissions({});
      setLoading(false);
      return;
    }

    const rawRole = overriddenRole || user.role || 'AGENT';
    const roleName = rawRole.toUpperCase();
    const isDeveloper = user.email.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in';
    const isAdmin = (roleName === 'ADMIN' || rawRole === 'ADMIN') || (isDeveloper && !overriddenRole);
    
    // Seed default full access
    const getFullPermissions = () => {
      const permMap: Record<string, PermissionActions> = {};
      const modules = [
        'Workforce TMS', 
        'KPI Scorecard', 
        'Warnings', 
        'PIP Management', 
        'Historical Records', 
        'Important Quality Links', 
        'Console',
        'Attendance'
      ];
      modules.forEach(mod => {
        permMap[mod] = {
          can_view: true,
          can_create: true,
          can_edit: true,
          can_delete: true,
          can_export: true,
          can_approve: true,
          view_team: true,
          view_all: true,
          assign: true,
          override: true,
          force_action: true,
          manage_settings: true,
          manage_masters: true,
          audit_access: true,
          email_trigger: true,
          bulk_action: true,
          reopen_records: true,
          escalate: true,
          comment: true,
          view_sensitive_data: true,
          tms_permissions: getDefaultTmsPermissions('ADMIN')
        };
      });
      return permMap;
    };

    if (isAdmin) {
      setPermissions(getFullPermissions());
      setLoading(false);
    }

    const q = query(
      collection(db, 'role_permissions'),
      where('role_name', 'in', [roleName, rawRole])
    );

    // Realtime listener for role permissions
    const unsubscribe = onSnapshot(q, (snapshot) => {
      let permMap: Record<string, PermissionActions> = {};
      
      // If admin, start with full perms. Otherwise start with empty.
      if (isAdmin) {
        permMap = getFullPermissions();
      }

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        permMap[data.module_name] = {
          can_view: !!data.can_view,
          can_create: !!data.can_create,
          can_edit: !!data.can_edit,
          can_delete: !!data.can_delete,
          can_export: !!data.can_export,
          can_approve: !!data.can_approve,
          tms_permissions: data.tms_permissions || undefined
        };
      });
      setPermissions(permMap);
      setLoading(false);
    }, (error) => {
      console.error('Error fetching permissions:', error);
      if (isAdmin) {
        setPermissions(getFullPermissions());
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user, overriddenRole]);

  // Utility to get permissions for a module with fallback
  const getModPerms = (module: string): PermissionActions => {
    // Legacy support for 'Attendance System' -> 'Attendance'
    const targetModule = module === 'Attendance' ? 'Attendance' : module;
    const fallbackModule = module === 'Attendance' ? 'Attendance System' : module;
    
    return permissions[targetModule] || permissions[fallbackModule] || {
      can_view: false,
      can_create: false,
      can_edit: false,
      can_delete: false,
      can_export: false,
      can_approve: false,
      view_team: false,
      view_all: false,
      assign: false,
      override: false,
      force_action: false,
      manage_settings: false,
      manage_masters: false,
      audit_access: false,
      email_trigger: false,
      bulk_action: false,
      reopen_records: false,
      escalate: false,
      comment: false,
      view_sensitive_data: false,
    };
  };

  const hasTmsPermission = (permKey: keyof TMSPermissions): boolean => {
    const rawRole = overriddenRole || user?.role || 'AGENT';
    const roleName = rawRole.toUpperCase();
    const isDeveloper = user?.email?.toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in';
    const isAdmin = (roleName === 'ADMIN' || rawRole === 'ADMIN') || (isDeveloper && !overriddenRole);

    if (isAdmin) return true;

    // First check if db module contains custom rule
    const tmsMod = permissions['Workforce TMS'];
    if (tmsMod && tmsMod.tms_permissions) {
      return !!tmsMod.tms_permissions[permKey];
    }

    // Default static fallback for existing or newly added roles
    return !!getDefaultTmsPermissions(roleName)[permKey];
  };

  const value: PermissionContextType = {
    permissions,
    loading,
    canView: (mod) => getModPerms(mod).can_view,
    canCreate: (mod) => getModPerms(mod).can_create,
    canEdit: (mod) => getModPerms(mod).can_edit,
    canDelete: (mod) => getModPerms(mod).can_delete,
    canExport: (mod) => getModPerms(mod).can_export,
    canApprove: (mod) => getModPerms(mod).can_approve,
    hasTmsPermission,
  };

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
};
