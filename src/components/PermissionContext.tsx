import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { db, getDocsOptimized } from '../lib/firebase';
import { collection, query, where } from 'firebase/firestore';
import { firestoreLogger } from '../lib/firestoreLogger';
import { UserProfile, UserRole } from '../types';
import { normalizeRole } from '../lib/hierarchy';
import { useConfig } from '../contexts/ConfigContext';

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
  const norm = normalizeRole(roleName);
  const isAdmin = norm === 'ADMIN';
  const isManager = ['MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes(norm);
  const isTLOrSupervisor = [
    UserRole.TEAM_LEAD,
    UserRole.SME
  ].includes(norm as UserRole);
  const isMIS = norm === 'MIS';
  const isAgentOrQA = ['AGENT', 'QA', 'TRAINER'].includes(norm);

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
    view_org_wide_workforce_data: isAdmin,
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
  const { rolePermissions, loading: configLoading } = useConfig();
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
    const isFullPrivilegeRole = [UserRole.ADMIN, 'ADMIN', 'SYSTEM_ADMIN'].includes(roleName);
    const isAdmin = isFullPrivilegeRole;
    
    // Seed default full access
    const getFullPermissions = () => {
      const permMap: Record<string, PermissionActions> = {};
      const modules = [
        'Workforce TMS', 
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

    const uniqueRoles = Array.from(new Set([
      roleName,
      rawRole,
      normalizeRole(rawRole),
      rawRole.toUpperCase(),
      rawRole.toUpperCase().replace(/\s+/g, '_')
    ])).filter(Boolean);

    // Phase 5 Optimization: Use cached rolePermissions from ConfigContext instead of querying Firestore
    const syncFromCache = async () => {
      let permMap: Record<string, PermissionActions> = {};
      
      // If admin, start with full perms
      if (isAdmin) {
        permMap = getFullPermissions();
      }

      // Filter global cache for the specific roles relevant to this user
      let userRelevantDocs = rolePermissions.filter((rp: any) => uniqueRoles.includes(rp.role_name));
      
      // Fallback: If we have an overriddenRole that is missing from the global cache, 
      // we must fetch it directly to avoid UI regressions for managers/admins testing roles.
      if (userRelevantDocs.length === 0 && !isAdmin && !configLoading) {
        try {
          const q = query(collection(db, 'role_permissions'), where('role_name', 'in', uniqueRoles));
          const snap = await getDocsOptimized(q, 'role_permissions_fallback');
          userRelevantDocs = snap.docs.map(d => d.data());
        } catch (err) {
          console.error('Fallback permission fetch failed:', err);
        }
      }
      
      userRelevantDocs.forEach((data: any) => {
        const m = data.module_name || '';
        if (!m) return;

        permMap[m] = {
          can_view: !!data.can_view,
          can_create: !!data.can_create,
          can_edit: !!data.can_edit,
          can_delete: !!data.can_delete,
          can_export: !!data.can_export,
          can_approve: !!data.can_approve,
          view_team: !!data.view_team,
          view_all: !!data.view_all,
          assign: !!data.assign,
          override: !!data.override,
          force_action: !!data.force_action,
          manage_settings: !!data.manage_settings,
          manage_masters: !!data.manage_masters,
          audit_access: !!data.audit_access,
          email_trigger: !!data.email_trigger,
          bulk_action: !!data.bulk_action,
          reopen_records: !!data.reopen_records,
          escalate: !!data.escalate,
          comment: !!data.comment,
          view_sensitive_data: !!data.view_sensitive_data,
          tms_permissions: data.tms_permissions || undefined
        };
      });
      
      setPermissions(permMap);
      setLoading(false);
    };

    if (!configLoading) {
      syncFromCache();
    }
    
  }, [user?.uid, user?.role, user?.email, overriddenRole, rolePermissions, configLoading]);

  // Utility to get permissions for a module with fallback
  const getModPerms = (module: string): PermissionActions => {
    // Legacy support for 'Attendance System' -> 'Attendance'
    const targetModule = module === 'Attendance' ? 'Attendance' : module;
    const fallbackModule = module === 'Attendance' ? 'Attendance System' : module;
    
    // Ensure anyone except MIS can view 'Workforce TMS'
    if (module === 'Workforce TMS') {
      const rawRole = overriddenRole || user?.role || 'AGENT';
      const roleName = rawRole.toUpperCase();
      const norm = normalizeRole(roleName);
      if (norm !== 'MIS') {
        const dbPerms = permissions[targetModule] || permissions[fallbackModule];
        return {
          can_view: true,
          can_create: dbPerms ? !!dbPerms.can_create : true,
          can_edit: dbPerms ? !!dbPerms.can_edit : true,
          can_delete: dbPerms ? !!dbPerms.can_delete : false,
          can_export: dbPerms ? !!dbPerms.can_export : false,
          can_approve: dbPerms ? !!dbPerms.can_approve : false,
          view_team: dbPerms ? !!dbPerms.view_team : false,
          view_all: dbPerms ? !!dbPerms.view_all : false,
          assign: dbPerms ? !!dbPerms.assign : false,
          override: dbPerms ? !!dbPerms.override : false,
          force_action: dbPerms ? !!dbPerms.force_action : false,
          manage_settings: dbPerms ? !!dbPerms.manage_settings : false,
          manage_masters: dbPerms ? !!dbPerms.manage_masters : false,
          audit_access: dbPerms ? !!dbPerms.audit_access : false,
          email_trigger: dbPerms ? !!dbPerms.email_trigger : false,
          bulk_action: dbPerms ? !!dbPerms.bulk_action : false,
          reopen_records: dbPerms ? !!dbPerms.reopen_records : false,
          escalate: dbPerms ? !!dbPerms.escalate : false,
          comment: dbPerms ? !!dbPerms.comment : true,
          view_sensitive_data: dbPerms ? !!dbPerms.view_sensitive_data : false,
          tms_permissions: dbPerms ? dbPerms.tms_permissions : undefined
        };
      }
    }

    // Strictly enforce Console Module for Admin & MIS only
    if (module === 'Console') {
      const rawRole = overriddenRole || user?.role || 'AGENT';
      const roleName = rawRole.toUpperCase().trim();
      const norm = normalizeRole(roleName);
      const isAllowed = norm === 'ADMIN' || norm === 'MIS' || roleName === 'ADMIN' || roleName === 'MIS' || roleName.includes('ADMIN') || roleName.includes('MIS');
      
      if (!isAllowed) {
        return {
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
      }

      const dbPerms = permissions[targetModule] || permissions[fallbackModule];
      return {
        can_view: true,
        can_create: dbPerms ? !!dbPerms.can_create : (norm === 'ADMIN'),
        can_edit: dbPerms ? !!dbPerms.can_edit : (norm === 'ADMIN'),
        can_delete: dbPerms ? !!dbPerms.can_delete : (norm === 'ADMIN'),
        can_export: dbPerms ? !!dbPerms.can_export : true,
        can_approve: dbPerms ? !!dbPerms.can_approve : (norm === 'ADMIN'),
        view_team: true,
        view_all: true,
        assign: dbPerms ? !!dbPerms.assign : (norm === 'ADMIN'),
        override: dbPerms ? !!dbPerms.override : (norm === 'ADMIN'),
        force_action: dbPerms ? !!dbPerms.force_action : (norm === 'ADMIN'),
        manage_settings: dbPerms ? !!dbPerms.manage_settings : (norm === 'ADMIN'),
        manage_masters: dbPerms ? !!dbPerms.manage_masters : (norm === 'ADMIN'),
        audit_access: dbPerms ? !!dbPerms.audit_access : true,
        email_trigger: dbPerms ? !!dbPerms.email_trigger : false,
        bulk_action: dbPerms ? !!dbPerms.bulk_action : (norm === 'ADMIN'),
        reopen_records: dbPerms ? !!dbPerms.reopen_records : false,
        escalate: dbPerms ? !!dbPerms.escalate : false,
        comment: true,
        view_sensitive_data: dbPerms ? !!dbPerms.view_sensitive_data : true,
      };
    }
    
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
    const isAdmin = (roleName === 'ADMIN' || rawRole === 'ADMIN');

    if (isAdmin) return true;

    // Critical self-service keys for shift, break, and punch controls.
    // Guaranteeing these are always enabled for standard roles (and never overridden to false)
    // ensures ICs are never blocked from clocking in/out, switching processes, or managing breaks.
    const selfServiceKeys: (keyof TMSPermissions)[] = [
      'view_self_service',
      'can_punch_in',
      'can_punch_out',
      'can_switch_process',
      'can_start_break',
      'can_end_break',
      'can_start_lunch',
      'can_end_lunch',
      'can_start_meeting',
      'can_end_meeting',
      'can_view_own_shift_summary',
      'can_view_own_attendance_summary'
    ];

    const norm = normalizeRole(roleName);
    if (selfServiceKeys.includes(permKey) && norm !== 'MIS') {
      return true;
    }

    // First check if db module contains custom rule
    const tmsMod = permissions['Workforce TMS'];
    if (tmsMod && tmsMod.tms_permissions && tmsMod.tms_permissions[permKey] !== undefined) {
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
