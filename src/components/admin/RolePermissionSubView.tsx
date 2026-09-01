import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  Plus, 
  Save, 
  Lock, 
  Info, 
  Check, 
  Square, 
  CheckSquare, 
  Copy, 
  Download, 
  Trash2, 
  FileText, 
  RefreshCw, 
  SlidersHorizontal,
  FolderLock,
  ChevronDown,
  AlertTriangle,
  Heart
} from 'lucide-react';
import { db, getDocsOptimized } from '../../lib/firebase';
import { 
  collection, 
  doc, 
  getDocs, 
  setDoc, 
  deleteDoc, 
  writeBatch, 
  query, 
  where 
} from 'firebase/firestore';
import { toast } from 'sonner';
import { useRoster } from '../../contexts/RosterContext';
import { getDefaultTmsPermissions, TMSPermissions } from '../PermissionContext';

// Defined standard roles matching UserRole
const KNOWN_ROLES = [
  'ADMIN',
  'MANAGER',
  'ASSISTANT_MANAGER',
  'OPS_HEAD',
  'HR',
  'IT_MANAGER',
  'SME',
  'QA',
  'Team Lead',
  'TRAINER',
  'MIS',
  'AGENT'
];

const ALL_MASTER_MODULES = [
  'Workforce TMS',
  'Warnings',
  'PIP Management',
  'Historical Records',
  'Important Quality Links',
  'Console',
  'Attendance'
];

interface RolePermissionSubViewProps {
  adminTheme: 'light' | 'dark';
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export interface RolePermissionDoc {
  id?: string;
  role_name: string;
  module_name: string;
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

export const RolePermissionSubView: React.FC<RolePermissionSubViewProps> = ({ adminTheme, logAdminEvent }) => {
  const { roles } = useRoster();
  const [modules, setModules] = useState<string[]>(ALL_MASTER_MODULES);
  const [rolesList, setRolesList] = useState<string[]>(KNOWN_ROLES);
  const [permissions, setPermissions] = useState<Record<string, Record<string, Omit<RolePermissionDoc, 'role_name' | 'module_name'>>>>({});
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (roles && roles.length > 0) {
      const normalizeRoleName = (r: string): string => {
        const trimmed = r.trim();
        const upper = trimmed.toUpperCase();
        if (upper === 'TEAM LEAD' || upper === 'TEAM_LEAD') {
          return 'Team Lead';
        }
        return upper;
      };
      const filtered = roles
        .map(normalizeRoleName)
        .filter(r => {
          const upper = r.toUpperCase();
          const oldTLVariations = ['STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'TRAINER TL', 'OPS TL', 'OPS_TEAM_LEAD', 'TEAM_LEADER'];
          return !oldTLVariations.includes(upper);
        });
      setRolesList(Array.from(new Set(filtered)));
    }
  }, [roles]);

  // Selector states
  const [selectedRole, setSelectedRole] = useState<string>('MANAGER');
  
  // Create / Clone / Templates states
  const [newRoleName, setNewRoleName] = useState('');
  const [isAddingRole, setIsAddingRole] = useState(false);
  const [cloneSourceRole, setCloneSourceRole] = useState('');
  
  // Custom templates list
  const [templates, setTemplates] = useState<any[]>([]);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');

  // Selected intersection cell for popover edit
  const [editingCell, setEditingCell] = useState<{ role: string; module: string } | null>(null);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);

  const fetchSecurityData = async () => {
    setLoading(true);
    setErrorStatus(null);
    try {
      // 1. Fetch modules
      const modulesSnap = await getDocsOptimized(collection(db, 'module_master'), 'module_master_global_list');
      let fetchedModules = modulesSnap.docs.map(d => d.data().name as string).filter(mod => ALL_MASTER_MODULES.includes(mod));
      if (fetchedModules.length < ALL_MASTER_MODULES.length) {
        // Auto-seed modules
        const fbBatch = writeBatch(db);
        ALL_MASTER_MODULES.forEach(mod => {
          fbBatch.set(doc(db, 'module_master', mod), { id: mod, name: mod, createdAt: new Date().toISOString() });
        });
        await fbBatch.commit();
        fetchedModules = ALL_MASTER_MODULES;
      }
      setModules(fetchedModules);

      // 2. Fetch custom fields (Roles are managed via RosterContext)
      // We don't fetch roles here anymore as they are provided by RosterContext
      const fetchedRoles = rolesList.length > 0 ? rolesList : KNOWN_ROLES;
      if (rolesList.length === 0) {
        // Fallback to KNOWN_ROLES if roles not loaded yet, but usually they are
        setRolesList(KNOWN_ROLES);
      }


      // 3. Fetch permissions matrix map
      const permissionsSnap = await getDocsOptimized(collection(db, 'role_permissions'), 'role_permissions_global_matrix');
      
      if (permissionsSnap.empty) {
        // Auto seed dynamic permission matrix
        await seedDefaultPermissions(fetchedRoles, fetchedModules);
      } else {
        // Convert flat documents structure to nested Record structure
        const matrixMap: Record<string, Record<string, Omit<RolePermissionDoc, 'role_name' | 'module_name'>>> = {};
        const cleanfbBatch = writeBatch(db);
        let needsCleanupCommit = false;

        const existingKeys = new Set<string>();

        permissionsSnap.docs.forEach(docSnap => {
          const docId = docSnap.id;
          const docItem = docSnap.data() as RolePermissionDoc;
          const r = (docItem.role_name || '').toUpperCase();
          const m = docItem.module_name;
          if (!r || !m) return;

          const expectedId = `${docItem.role_name}_${m}`;
          const underscoreId = `${docItem.role_name}_${m.replace(/\s+/g, '_')}`;

          // If this is a legacy/duplicate document with underscores instead of spaces, 
          // we securely delete it and skip processing it to prevent overwriting correct space-keyed documents.
          if (docId === underscoreId && underscoreId !== expectedId) {
            cleanfbBatch.delete(doc(db, 'role_permissions', docId));
            needsCleanupCommit = true;
            return;
          }

          existingKeys.add(`${r}_${m}`);

          if (!matrixMap[r]) matrixMap[r] = {};
          matrixMap[r][m] = {
            can_view: !!docItem.can_view,
            can_create: !!docItem.can_create,
            can_edit: !!docItem.can_edit,
            can_delete: !!docItem.can_delete,
            can_export: !!docItem.can_export,
            can_approve: !!docItem.can_approve,
            view_team: !!docItem.view_team,
            view_all: !!docItem.view_all,
            assign: !!docItem.assign,
            override: !!docItem.override,
            force_action: !!docItem.force_action,
            manage_settings: !!docItem.manage_settings,
            manage_masters: !!docItem.manage_masters,
            audit_access: !!docItem.audit_access,
            email_trigger: !!docItem.email_trigger,
            bulk_action: !!docItem.bulk_action,
            reopen_records: !!docItem.reopen_records,
            escalate: !!docItem.escalate,
            comment: !!docItem.comment,
            view_sensitive_data: !!docItem.view_sensitive_data,
            tms_permissions: docItem.tms_permissions || undefined
          };

          // Clean undefined tms_permissions to avoid Firestore errors
          if (matrixMap[r][m].tms_permissions === undefined) {
             delete matrixMap[r][m].tms_permissions;
          }
        });

        // Auto-sync / Backfill missing module permissions (e.g. IT Help Desk) for existing roles
        let needsSyncCommit = false;
        fetchedRoles.forEach(role => {
          fetchedModules.forEach(mod => {
            const key = `${role}_${mod}`;
            if (!existingKeys.has(key)) {
              let defaults = {
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
                comment: mod === 'IT Help Desk',
                view_sensitive_data: false
              };

              // Define custom defaults for 'IT Help Desk' specifically
              if (mod === 'IT Help Desk') {
                if (role === 'ADMIN') {
                  defaults = {
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
                    view_sensitive_data: true
                  };
                } else if (role === 'MANAGER' || role === 'MIS') {
                  defaults = {
                    ...defaults,
                    can_view: true,
                    can_create: true,
                    can_edit: true,
                    can_export: true,
                    can_approve: true,
                    view_all: true,
                    assign: true,
                    bulk_action: true,
                  };
                } else if (role === 'Team Lead') {
                  defaults = {
                    ...defaults,
                    can_view: true,
                    can_create: true,
                    can_edit: true,
                    view_team: true,
                  };
                } else {
                  // Agent, SME, QA, Trainer
                  defaults = {
                    ...defaults,
                    can_view: true,
                    can_create: true,
                  };
                }
              } else {
                // Other modules generic fallback
                if (role === 'ADMIN') {
                  defaults.can_view = true;
                  defaults.can_create = true;
                  defaults.can_edit = true;
                  defaults.can_delete = true;
                  defaults.can_export = true;
                  defaults.can_approve = true;
                }
              }

              if (!matrixMap[role]) matrixMap[role] = {};
              matrixMap[role][mod] = defaults;

              cleanfbBatch.set(doc(db, 'role_permissions', key), {
                id: key,
                role_name: role,
                module_name: mod,
                ...defaults
              });
              needsSyncCommit = true;
            }
          });
        });

        if (needsCleanupCommit || needsSyncCommit) {
          cleanfbBatch.commit().catch(err => console.error("Could not complete self-healing / sync permission cleanup batch:", err));
        }

        setPermissions(matrixMap);
      }

      // 4. Fetch templates
      const templatesSnap = await getDocsOptimized(collection(db, 'permission_templates'), 'permission_templates_global_list');
      setTemplates(templatesSnap.docs.map(d => ({ id: d.id, ...d.data() })));

    } catch (err) {
      console.error('Failed to pre-fetch security roles matrix:', err);
      setErrorStatus(err instanceof Error ? err.message : 'Permission pre-fetch failed.');
      toast.error('Unable to sync dynamic roles directory.');
    } finally {
      setLoading(false);
    }
  };

  // Fetch all modules, roles, and permissions
  useEffect(() => {
    fetchSecurityData();
  }, []);

  // Seeds baseline permission records for new environments
  const seedDefaultPermissions = async (roles: string[], targetModules: string[]) => {
    setSyncing(true);
    const seedToast = toast.loading('Initializing database security blueprint rules...');
    try {
      const fbBatch = writeBatch(db);
      const matrixMap: Record<string, Record<string, Omit<RolePermissionDoc, 'role_name' | 'module_name'>>> = {};

      roles.forEach(role => {
        matrixMap[role] = {};
        targetModules.forEach(mod => {
          let defaults = {
            can_view: false,
            can_create: false,
            can_edit: false,
            can_delete: false,
            can_export: false,
            can_approve: false,
          };

          // Admin inherits absolute master privileges
          if (role === 'ADMIN') {
            defaults = {
              can_view: true,
              can_create: true,
              can_edit: true,
              can_delete: true,
              can_export: true,
              can_approve: true,
            };
          } else if (role === 'MANAGER') {
            const managerExcluded = ['Historical Records'];
            defaults = {
              can_view: !managerExcluded.includes(mod),
              can_create: !managerExcluded.includes(mod) && mod !== 'Console',
              can_edit: !managerExcluded.includes(mod) && mod !== 'Console',
              can_delete: mod === 'Warnings' || mod === 'PIP Management',
              can_export: true,
              can_approve: true,
            };
          } else if (role === 'Team Lead') {
            const tlModules = ['Workforce TMS', 'KPI Scorecard', 'Warnings', 'PIP Management', 'Important Quality Links'];
            defaults = {
              can_view: tlModules.includes(mod),
              can_create: ['Warnings'].includes(mod),
              can_edit: ['Warnings'].includes(mod),
              can_delete: false,
              can_export: ['Workforce TMS', 'KPI Scorecard'].includes(mod),
              can_approve: false,
            };
          } else if (role === 'SME') {
            const smeModules = ['Workforce TMS', 'KPI Scorecard', 'Important Quality Links'];
            defaults = {
              can_view: smeModules.includes(mod),
              can_create: false,
              can_edit: false,
              can_delete: false,
              can_export: true,
              can_approve: false,
            };
          } else if (role === 'TRAINER' || role === 'TRAINER_TL') {
            const trainerModules = ['Workforce TMS', 'KPI Scorecard', 'Important Quality Links'];
            defaults = {
              can_view: trainerModules.includes(mod),
              can_create: false,
              can_edit: false,
              can_delete: false,
              can_export: true,
              can_approve: false,
            };
          } else if (role === 'MIS') {
            const misModules = ['Workforce TMS', 'KPI Scorecard'];
            defaults = {
              can_view: misModules.includes(mod),
              can_create: false,
              can_edit: false,
              can_delete: false,
              can_export: true,
              can_approve: false,
            };
          } else if (role === 'QA' || role === 'QTL') {
            const qaModules = ['Workforce TMS', 'KPI Scorecard', 'Warnings', 'Important Quality Links'];
            defaults = {
              can_view: qaModules.includes(mod),
              can_create: ['KPI Scorecard', 'Warnings'].includes(mod),
              can_edit: ['KPI Scorecard', 'Warnings'].includes(mod),
              can_delete: false,
              can_export: true,
              can_approve: false,
            };
          } else if (role === 'AGENT') {
            const agentModules = ['Workforce TMS', 'KPI Scorecard', 'Warnings', 'Important Quality Links'];
            defaults = {
              can_view: agentModules.includes(mod),
              can_create: false,
              can_edit: false,
              can_delete: false,
              can_export: false,
              can_approve: false,
            };
          }

          // If module is 'Workforce TMS', assign default granular permissions
          const moduleDefaults: any = { ...defaults };
          if (mod === 'Workforce TMS') {
            moduleDefaults.tms_permissions = getDefaultTmsPermissions(role);
          }

          // Override specific defaults for the IT Help Desk module
          if (mod === 'IT Help Desk') {
            if (role === 'ADMIN') {
              moduleDefaults.can_view = true;
              moduleDefaults.can_create = true;
              moduleDefaults.can_edit = true;
              moduleDefaults.can_delete = true;
              moduleDefaults.can_export = true;
              moduleDefaults.can_approve = true;
            } else if (role === 'MANAGER' || role === 'MIS') {
              moduleDefaults.can_view = true;
              moduleDefaults.can_create = true;
              moduleDefaults.can_edit = true;
              moduleDefaults.can_delete = false;
              moduleDefaults.can_export = true;
              moduleDefaults.can_approve = true;
            } else if (['TEAM_LEAD', 'STL', 'OPS_TL', 'TRAINER_TL', 'QTL'].includes(role)) {
              moduleDefaults.can_view = true;
              moduleDefaults.can_create = true;
              moduleDefaults.can_edit = true;
              moduleDefaults.can_delete = false;
              moduleDefaults.can_export = false;
              moduleDefaults.can_approve = false;
            } else {
              moduleDefaults.can_view = true;
              moduleDefaults.can_create = true;
              moduleDefaults.can_edit = false;
              moduleDefaults.can_delete = false;
              moduleDefaults.can_export = false;
              moduleDefaults.can_approve = false;
            }
          }

          matrixMap[role][mod] = moduleDefaults;
          const mapId = `${role}_${mod}`;
          fbBatch.set(doc(db, 'role_permissions', mapId), {
            id: mapId,
            role_name: role,
            module_name: mod,
            ...moduleDefaults
          });
        });
      });

      await fbBatch.commit();
      setPermissions(matrixMap);
      toast.success('Successfully initialized baseline security permissions matrix!');
    } catch (err) {
      console.error(err);
      toast.error('Verification failed: Could not seed permissions.');
    } finally {
      toast.dismiss(seedToast);
      setSyncing(false);
    }
  };

  // Create a Custom Role
  const handleCreateCustomRole = async () => {
    const rawName = newRoleName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!rawName) {
      toast.error('Invalid Role Name specified.');
      return;
    }
    if (rolesList.includes(rawName)) {
      toast.error('Role key identifier already exists.');
      return;
    }

    setSyncing(true);
    const loadId = toast.loading(`Registering custom operational role '${rawName}'...`);
    try {
      // 1. Create Role Doc
      await setDoc(doc(db, 'roles', rawName), {
        id: rawName,
        name: rawName,
        description: `Custom User Defined Role: ${rawName}`,
        createdAt: new Date().toISOString()
      });

      // 2. Clone permissions from Selected Role in dropdown if specified, or assign blank
      const fbBatch = writeBatch(db);
      const clonedMap = permissions[cloneSourceRole] || {};
      const newRolePerms: Record<string, Omit<RolePermissionDoc, 'role_name' | 'module_name'>> = {};

      modules.forEach(mod => {
        const sourcePerm = clonedMap[mod] || {
          can_view: false,
          can_create: false,
          can_edit: false,
          can_delete: false,
          can_export: false,
          can_approve: false,
        };

        const copyVal = { ...sourcePerm };
        newRolePerms[mod] = copyVal;

        const mapId = `${rawName}_${mod}`;
        fbBatch.set(doc(db, 'role_permissions', mapId), {
          id: mapId,
          role_name: rawName,
          module_name: mod,
          ...copyVal
        });
      });

      await fbBatch.commit();
      setRolesList(prev => [...prev, rawName]);
      setPermissions(prev => ({
        ...prev,
        [rawName]: newRolePerms
      }));

      await logAdminEvent('Role Created', rawName, 'None', `Cloned from ${cloneSourceRole || 'Blank'}`);
      setSelectedRole(rawName);
      setNewRoleName('');
      setIsAddingRole(false);
      toast.success(`Role '${rawName}' created successfully!`);
    } catch (err: any) {
      toast.error('Creation failed: ' + err.message);
    } finally {
      toast.dismiss(loadId);
      setSyncing(false);
    }
  };

  // Delete Custom Role
  const handleDeleteRole = async (roleName: string) => {
    if (KNOWN_ROLES.includes(roleName) && roleName !== 'AGENT' && roleName !== 'SME' && roleName !== 'TRAINER') {
      toast.error('System baseline roles cannot be deleted to maintain auth security.');
      return;
    }
    if (!window.confirm(`Are you absolutely sure you want to delete custom role: ${roleName}? Mapped users will lose access.`)) return;

    setSyncing(true);
    const loadId = toast.loading(`Pruning role '${roleName}'...`);
    try {
      await deleteDoc(doc(db, 'roles', roleName));

      const fbBatch = writeBatch(db);
      modules.forEach(mod => {
        fbBatch.delete(doc(db, 'role_permissions', `${roleName}_${mod}`));
      });
      await fbBatch.commit();

      setRolesList(prev => prev.filter(r => r !== roleName));
      setPermissions(prev => {
        const copy = { ...prev };
        delete copy[roleName];
        return copy;
      });

      await logAdminEvent('Role Deleted', roleName, 'Active Role Schema', 'Deleted');
      setSelectedRole('AGENT');
      toast.success(`Role '${roleName}' has been deleted.`);
    } catch (err: any) {
      toast.error('Deletion failed: ' + err.message);
    } finally {
      toast.dismiss(loadId);
      setSyncing(false);
    }
  };

  // Toggle dynamic permissions inside Workforce TMS
  const handleToggleTmsPermission = (role: string, permKey: string) => {
    setPermissions(prev => {
      const copy = { ...prev };
      if (!copy[role]) copy[role] = {};
      const tmsMod = copy[role]['Workforce TMS'] || {
        can_view: true,
        can_create: false,
        can_edit: false,
        can_delete: false,
        can_export: false,
        can_approve: false,
      };

      const tmsPerms = (tmsMod as any).tms_permissions || getDefaultTmsPermissions(role);
      const updatedTmsPerms = {
        ...tmsPerms,
        [permKey]: !tmsPerms[permKey as keyof TMSPermissions]
      };

      copy[role] = {
        ...copy[role],
        'Workforce TMS': {
          ...tmsMod,
          can_view: true, // Auto allow viewing if granular perms altered
          tms_permissions: updatedTmsPerms
        }
      };
      return copy;
    });
  };

  // Run global database schema migration for existing role matrix records 
  const runDynamicSelfHealingMigration = async () => {
    setSyncing(true);
    const migToast = toast.loading('Running self-healing security migration across all database roles...');
    try {
      const fbBatch = writeBatch(db);
      
      for (const r of rolesList) {
        if (r === 'ADMIN') continue;

        // Fetch current localized local structure
        const rMap = permissions[r] || {};
        const tmsItem = rMap['Workforce TMS'] || {
          can_view: true,
          can_create: false,
          can_edit: false,
          can_delete: false,
          can_export: false,
          can_approve: false,
        };

        const tmsPerms = (tmsItem as any).tms_permissions || getDefaultTmsPermissions(r);
        const mapId = `${r}_Workforce TMS`;

        const finalTmsItem = { ...tmsItem };
        if (tmsPerms) {
          finalTmsItem.tms_permissions = tmsPerms;
        } else {
          delete (finalTmsItem as any).tms_permissions;
        }

        fbBatch.set(doc(db, 'role_permissions', mapId), {
          id: mapId,
          role_name: r,
          module_name: 'Workforce TMS',
          ...finalTmsItem
        });
      }

      await fbBatch.commit();
      
      // Update local memory to ensure sync
      setPermissions(prev => {
        const copy = { ...prev };
        rolesList.forEach(r => {
          if (!copy[r]) copy[r] = {};
          const tmsItem = copy[r]['Workforce TMS'] || {
            can_view: true,
            can_create: false,
            can_edit: false,
            can_delete: false,
            can_export: false,
            can_approve: false,
          };
          copy[r]['Workforce TMS'] = {
            ...tmsItem,
            tms_permissions: (tmsItem as any).tms_permissions || getDefaultTmsPermissions(r)
          };
        });
        return copy;
      });

      toast.success('Successfully deployed dynamic TMS matrix overrides across all roles!');
    } catch (err: any) {
      console.error(err);
      toast.error('Migration failed: ' + err.message);
    } finally {
      toast.dismiss(migToast);
      setSyncing(false);
    }
  };

  // Toggle dynamic permissions inside state
  const handleToggleState = (role: string, mod: string, field: keyof Omit<RolePermissionDoc, 'role_name' | 'module_name'>) => {
    setPermissions(prev => {
      const copy = { ...prev };
      if (!copy[role]) copy[role] = {};
      if (!copy[role][mod]) {
        copy[role][mod] = {
          can_view: false,
          can_create: false,
          can_edit: false,
          can_delete: false,
          can_export: false,
          can_approve: false,
        };
      }
      
      const prevVal = copy[role][mod][field];
      const newVal = !prevVal;

      // Implication constraint: cannot create/edit/delete if cannot view (optionally view is auto enabled)
      let updatedModuleMap = { ...copy[role][mod], [field]: newVal };
      if (field !== 'can_view' && newVal === true) {
        updatedModuleMap.can_view = true;
      }

      copy[role] = {
        ...copy[role],
        [mod]: updatedModuleMap
      };
      return copy;
    });
  };

  // Persist edits for a specific role
  const handleSaveRolePermissions = async (roleName: string) => {
    if (roleName === 'ADMIN') {
      toast.info('ADMIN permissions are static system assets.');
      return;
    }

    setSyncing(true);
    const saveLoad = toast.loading(`Persisting modified permissions matrix for ${roleName}...`);
    try {
      const fbBatch = writeBatch(db);
      const roleMap = permissions[roleName] || {};

      modules.forEach(mod => {
        const item = roleMap[mod] || {
          can_view: false,
          can_create: false,
          can_edit: false,
          can_delete: false,
          can_export: false,
          can_approve: false,
        };
        const mapId = `${roleName}_${mod}`;
        
        const payload: any = {
          id: mapId,
          role_name: roleName,
          module_name: mod,
          can_view: !!item.can_view,
          can_create: !!item.can_create,
          can_edit: !!item.can_edit,
          can_delete: !!item.can_delete,
          can_export: !!item.can_export,
          can_approve: !!item.can_approve,
          view_team: item.view_team !== undefined ? !!item.view_team : false,
          view_all: item.view_all !== undefined ? !!item.view_all : false,
          assign: item.assign !== undefined ? !!item.assign : false,
          override: item.override !== undefined ? !!item.override : false,
          force_action: item.force_action !== undefined ? !!item.force_action : false,
          manage_settings: item.manage_settings !== undefined ? !!item.manage_settings : false,
          manage_masters: item.manage_masters !== undefined ? !!item.manage_masters : false,
          audit_access: item.audit_access !== undefined ? !!item.audit_access : false,
          email_trigger: item.email_trigger !== undefined ? !!item.email_trigger : false,
          bulk_action: item.bulk_action !== undefined ? !!item.bulk_action : false,
          reopen_records: item.reopen_records !== undefined ? !!item.reopen_records : false,
          escalate: item.escalate !== undefined ? !!item.escalate : false,
          comment: item.comment !== undefined ? !!item.comment : false,
          view_sensitive_data: item.view_sensitive_data !== undefined ? !!item.view_sensitive_data : false
        };

        if (mod === 'Workforce TMS') {
          payload.tms_permissions = (item as any).tms_permissions || getDefaultTmsPermissions(roleName);
        }

        fbBatch.set(doc(db, 'role_permissions', mapId), payload);
      });

      await fbBatch.commit();
      await logAdminEvent('Role Permissions Matrix Saved', roleName, 'Previous Matrix', JSON.stringify(roleMap));
      toast.success(`Dynamic access configuration saved for ${roleName}!`);
    } catch (err: any) {
      toast.error('Could not overwrite roles table database records: ' + err.message);
    } finally {
      toast.dismiss(saveLoad);
      setSyncing(false);
    }
  };

  // Save Current Role configuration as a Template
  const handleSaveAsTemplate = async () => {
    if (!newTemplateName.trim()) {
      toast.error('Please input a valid Template Name.');
      return;
    }

    setSyncing(true);
    const loadId = toast.loading(`Saving Template '${newTemplateName}'...`);
    try {
      const tId = 'tpl_' + btoa(newTemplateName).replace(/=/g, '').slice(0, 10);
      const roleMap = permissions[selectedRole] || {};

      await setDoc(doc(db, 'permission_templates', tId), {
        id: tId,
        name: newTemplateName,
        matrix: roleMap,
        createdAt: new Date().toISOString()
      });

      setTemplates(prev => [...prev, { id: tId, name: newTemplateName, matrix: roleMap }]);
      setNewTemplateName('');
      await logAdminEvent('Security Template Compiled', newTemplateName, 'Custom Layout', tId);
      toast.success(`Permission Template '${newTemplateName}' saved successfully.`);
    } catch (err: any) {
      toast.error('Failed to register template record: ' + err.message);
    } finally {
      toast.dismiss(loadId);
      setSyncing(false);
    }
  };

  // Load a specified template matrix into the active role form
  const handleApplyTemplateMat = (tplMatrix: Record<string, any>) => {
    if (selectedRole === 'ADMIN') {
      toast.error('ADMIN baseline layout cannot be loaded over.');
      return;
    }

    setPermissions(prev => ({
      ...prev,
      [selectedRole]: {
        ...prev[selectedRole],
        ...tplMatrix
      }
    }));
    toast.success(`Loaded and applied template mapping on raw ${selectedRole} forms. Clean "Persist" to sync.`);
  };

  // Master clone permissions from one role to another instantly in local state
  const handleCloneRolePermissions = (src: string) => {
    if (!src) return;
    if (selectedRole === 'ADMIN') {
      toast.info('ADMIN profiles are locked.');
      return;
    }

    const srcMap = permissions[src];
    if (!srcMap) {
      toast.error('Source role matrix is blank.');
      return;
    }

    setPermissions(prev => ({
      ...prev,
      [selectedRole]: JSON.parse(JSON.stringify(srcMap))
    }));
    toast.success(`Cloned permissions from ${src} to ${selectedRole} in local memory. Click "Persist Roles" to save permanently.`);
  };

  const cardClass = adminTheme === 'dark' 
    ? 'bg-slate-800 border-slate-700 shadow-xl p-6 rounded-2xl border text-slate-100' 
    : 'bg-white border-slate-200 shadow-md p-6 rounded-2xl border text-slate-800';

  if (loading) {
    return (
      <div className="py-12 text-center text-slate-400 font-mono text-xs">
        <RefreshCw size={24} className="animate-spin text-indigo-500 mx-auto mb-3" />
        Synchronizing Enterprise Permission Matrix Columns...
      </div>
    );
  }

  if (errorStatus) {
    return (
      <div className="py-12 px-6 text-center max-w-md mx-auto bg-red-50/50 dark:bg-red-950/10 rounded-2xl border border-red-100 dark:border-red-900/20 my-8">
        <Shield size={36} className="text-red-500 mx-auto mb-3" />
        <h4 className="text-sm font-black text-slate-800 dark:text-red-200 mb-2">Unable to Sync Dynamic Roles Directory</h4>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4 font-sans leading-relaxed">
          The database connection returned a permission error: {errorStatus}. This can happen due to custom rules or transient connection problems.
        </p>
        <button
          onClick={fetchSecurityData}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold shadow-sm cursor-pointer transition-colors"
        >
          <RefreshCw size={14} className="animate-pulse" /> Retry Sync
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      
      {/* Overview Cards & Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className={`p-5 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-100/50 border-slate-200'}`}>
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Active Roles Listed</span>
          <h3 className="text-2xl font-black mt-1 text-indigo-500">{rolesList.length}</h3>
          <p className="text-[10px] text-slate-400 mt-1">Both hardcoded standards and custom enterprise groups.</p>
        </div>
        <div className={`p-5 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-100/50 border-slate-200'}`}>
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Registered Modules</span>
          <h3 className="text-2xl font-black mt-1 text-emerald-500">{modules.length}</h3>
          <p className="text-[10px] text-slate-400 mt-1">Application sections enabled for mapping controls.</p>
        </div>
        <div className={`p-5 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-100/50 border-slate-200'}`}>
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Custom Templates</span>
          <h3 className="text-2xl font-black mt-1 text-sky-500">{templates.length}</h3>
          <p className="text-[10px] text-slate-400 mt-1">Reusable permission baselines saved for quick cloning.</p>
        </div>
      </div>

      {/* Main Configurations Container */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Side: Role Selector and Quick cloning utilities */}
        <div className="lg:col-span-4 space-y-6">
          <div className={cardClass}>
            <h3 className="text-xs font-black uppercase tracking-wider mb-4 text-indigo-400 flex items-center gap-1.5">
              <FolderLock size={15} /> Select Role Mapping
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Editing Target Role</label>
                <select 
                  value={selectedRole}
                  onChange={e => setSelectedRole(e.target.value)}
                  className={`w-full text-xs p-2 rounded-lg border font-bold ${
                    adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-slate-50 text-slate-800'
                  }`}
                >
                  {rolesList.map(role => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
              </div>

              {selectedRole !== 'ADMIN' && (
                <div className="p-3 bg-indigo-500/5 border border-indigo-500/10 rounded-xl space-y-3">
                  <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest block">Quick Controls for {selectedRole}</span>
                  
                  {/* Clone permissions feature */}
                  <div className="space-y-1">
                    <label className="block text-[9px] font-bold text-slate-400">Clone Permissions From</label>
                    <div className="flex gap-1">
                      <select 
                        id="clone-source"
                        defaultValue=""
                        onChange={e => handleCloneRolePermissions(e.target.value)}
                        className={`text-[10px] p-1.5 flex-1 rounded-lg border focus:outline-none ${
                          adminTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-white'
                        }`}
                      >
                        <option value="" disabled>-- Pick Source --</option>
                        {rolesList.filter(r => r !== selectedRole).map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Apply Template feature */}
                  {templates.length > 0 && (
                    <div className="space-y-1 border-t pt-2 mt-1">
                      <label className="block text-[9px] font-bold text-slate-400">Apply Pre-saved Template</label>
                      <div className="flex flex-wrap gap-1">
                        {templates.map(tpl => (
                          <button
                            key={tpl.id}
                            type="button"
                            onClick={() => handleApplyTemplateMat(tpl.matrix)}
                            className="bg-slate-500/15 text-slate-200 px-2 py-1 rounded text-[9px] hover:bg-indigo-600/20 hover:text-indigo-400 transition"
                          >
                            {tpl.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex flex-col gap-2 pt-2">
                <button
                  onClick={() => setIsAddingRole(true)}
                  className="w-full py-2 bg-slate-800 text-white rounded-lg text-xs font-bold hover:bg-slate-700 transition flex items-center justify-center gap-1.5 border border-slate-700"
                >
                  <Plus size={14} /> Create Custom Role
                </button>

                <button
                  onClick={() => handleSaveRolePermissions(selectedRole)}
                  disabled={syncing || selectedRole === 'ADMIN'}
                  className="w-full py-2 bg-indigo-600 font-bold hover:bg-indigo-700 text-white rounded-lg text-xs transition flex items-center justify-center gap-1.5 shadow-md shadow-indigo-600/10 disabled:opacity-40"
                >
                  <Save size={14} /> Persist {selectedRole} Matrix
                </button>

                {!KNOWN_ROLES.includes(selectedRole) && (
                  <button
                    onClick={() => handleDeleteRole(selectedRole)}
                    className="w-full py-1.5 bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white rounded-lg text-xs transition flex items-center justify-center gap-1"
                  >
                    <Trash2 size={13} /> Delete Role {selectedRole}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Templates Drawer Manager */}
          <div className={cardClass}>
            <h3 className="text-xs font-black uppercase tracking-wider mb-2 text-indigo-400 flex items-center gap-1.5">
              <SlidersHorizontal size={15} /> Save Permission Template
            </h3>
            <p className="text-[10px] text-slate-400 mb-3">Copy current {selectedRole} checkboxes so they can be cloned to other roles.</p>
            
            <div className="space-y-3">
              <input
                value={newTemplateName}
                onChange={e => setNewTemplateName(e.target.value)}
                placeholder="e.g., QA Team Baseline"
                className={`w-full text-xs p-2 rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                  adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-slate-50'
                }`}
              />

              <button
                type="button"
                onClick={handleSaveAsTemplate}
                className="w-full bg-emerald-600 font-bold hover:bg-emerald-700 text-white py-1.5 text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Download size={13} /> Save Matrix Template
              </button>
            </div>
          </div>
        </div>

        {/* Right Side: Detailed Grid Permissions List for Selected Role */}
        <div className="lg:col-span-8">
          <div className={`${cardClass} h-full`}>
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b border-slate-150/10 pb-4 mb-4">
              <div>
                <h3 className="text-sm font-extrabold text-slate-200">
                  🛡️ {selectedRole} Modules & Permissions Access Control
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">Toggle Views, Actions, and Export parameters across registered features.</p>
              </div>
              <div className="role-badge bg-indigo-500/10 text-indigo-400 px-2.5 py-1 rounded text-[10px] font-black uppercase tracking-widest border border-indigo-500/20 shrink-0">
                Editing: {selectedRole}
              </div>
            </div>

            {/* List with checkboxes header to prevent alignment errors */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className={adminTheme === 'dark' ? 'bg-slate-900/60 text-slate-400 font-extrabold uppercase text-[9px] tracking-wider' : 'bg-slate-50 text-slate-500 font-extrabold uppercase text-[9px] tracking-wider'}>
                    <th className="p-3">Module Name</th>
                    <th className="p-3 text-center">View</th>
                    <th className="p-3 text-center">Create</th>
                    <th className="p-3 text-center">Edit</th>
                    <th className="p-3 text-center">Delete</th>
                    <th className="p-3 text-center">Export</th>
                    <th className="p-3 text-center">Approve</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {modules.filter(m => m !== 'Workforce TMS').map(mod => {
                    const permState = (permissions[selectedRole] || {})[mod] || {
                      can_view: false,
                      can_create: false,
                      can_edit: false,
                      can_delete: false,
                      can_export: false,
                      can_approve: false,
                    };
                    const isAdmin = selectedRole === 'ADMIN';

                    return (
                      <tr key={mod} className={adminTheme === 'dark' ? 'hover:bg-slate-900/30' : 'hover:bg-slate-50/50'}>
                        <td className="p-3 font-extrabold text-slate-700 dark:text-slate-350">{mod}</td>
                        
                        {/* View Checkbox */}
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleToggleState(selectedRole, mod, 'can_view')}
                            className={`p-1.5 rounded transition ${
                              permState.can_view ? 'text-indigo-500 hover:bg-slate-500/10' : 'text-slate-500 hover:bg-slate-500/10'
                            }`}
                          >
                            {permState.can_view ? <CheckSquare size={16} /> : <Square size={16} />}
                          </button>
                        </td>

                        {/* Create Checkbox */}
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleToggleState(selectedRole, mod, 'can_create')}
                            className={`p-1.5 rounded transition ${
                              permState.can_create ? 'text-emerald-500 hover:bg-slate-500/10' : 'text-slate-500 hover:bg-slate-500/10'
                            }`}
                          >
                            {permState.can_create ? <CheckSquare size={16} /> : <Square size={16} />}
                          </button>
                        </td>

                        {/* Edit Checkbox */}
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleToggleState(selectedRole, mod, 'can_edit')}
                            className={`p-1.5 rounded transition ${
                              permState.can_edit ? 'text-amber-500 hover:bg-slate-500/10' : 'text-slate-500 hover:bg-slate-500/10'
                            }`}
                          >
                            {permState.can_edit ? <CheckSquare size={16} /> : <Square size={16} />}
                          </button>
                        </td>

                        {/* Delete Checkbox */}
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleToggleState(selectedRole, mod, 'can_delete')}
                            className={`p-1.5 rounded transition ${
                              permState.can_delete ? 'text-rose-500 hover:bg-slate-500/10' : 'text-slate-500 hover:bg-slate-500/10'
                            }`}
                          >
                            {permState.can_delete ? <CheckSquare size={16} /> : <Square size={16} />}
                          </button>
                        </td>

                        {/* Export Checkbox */}
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleToggleState(selectedRole, mod, 'can_export')}
                            className={`p-1.5 rounded transition ${
                              permState.can_export ? 'text-indigo-500 hover:bg-slate-500/10' : 'text-slate-500 hover:bg-slate-500/10'
                            }`}
                          >
                            {permState.can_export ? <CheckSquare size={16} /> : <Square size={16} />}
                          </button>
                        </td>

                        {/* Approve Checkbox */}
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleToggleState(selectedRole, mod, 'can_approve')}
                            className={`p-1.5 rounded transition ${
                              permState.can_approve ? 'text-sky-500 hover:bg-slate-500/10' : 'text-slate-500 hover:bg-slate-500/10'
                            }`}
                          >
                            {permState.can_approve ? <CheckSquare size={16} /> : <Square size={16} />}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Workforce TMS Sub-Module Granular Access Controls */}
            <div className={`mt-8 border-t ${adminTheme === 'dark' ? 'border-slate-800' : 'border-slate-200'} pt-6 space-y-6`}>
              <div>
                <h4 className="text-sm font-black text-slate-800 dark:text-slate-100 uppercase tracking-wide flex items-center gap-2">
                  <Shield size={16} className="text-indigo-500" />
                  Workforce TMS Granular Controls ({selectedRole})
                </h4>
                <p className="text-xs text-slate-400 mt-1">
                  Admins can dynamically toggle granular features, punches, tracking, and controls. Changes are persisted when saving the role matrix.
                </p>
              </div>

              {/* Grid of categories */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {[
                  {
                    title: 'Self Service Permissions',
                    desc: 'Shift punches & summaries',
                    color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
                    items: [
                      { key: 'view_self_service', label: 'View Self Service TMS' },
                      { key: 'can_punch_in', label: 'Can Punch In' },
                      { key: 'can_punch_out', label: 'Can Punch Out' },
                      { key: 'can_switch_process', label: 'Can Switch Process' },
                      { key: 'can_start_break', label: 'Can Start Break' },
                      { key: 'can_end_break', label: 'Can End Break' },
                      { key: 'can_start_lunch', label: 'Can Start Lunch' },
                      { key: 'can_end_lunch', label: 'Can End Lunch' },
                      { key: 'can_start_meeting', label: 'Can Start Meeting' },
                      { key: 'can_end_meeting', label: 'Can End Meeting' },
                      { key: 'can_view_own_shift_summary', label: 'Can View Own Shift Summary' },
                      { key: 'can_view_own_attendance_summary', label: 'Can View Own Attendance Summary' }
                    ]
                  },
                  {
                    title: 'Monitoring Permissions',
                    desc: 'Realtime tracking dashboards',
                    color: 'text-teal-500 bg-teal-500/10 border-teal-500/20',
                    items: [
                      { key: 'view_workforce_dashboard', label: 'View Workforce Dashboard' },
                      { key: 'view_realtime_tracking', label: 'View Real-Time Tracking' },
                      { key: 'view_logged_in_users', label: 'View Logged In Users' },
                      { key: 'view_team_status', label: 'View Team Status' },
                      { key: 'view_team_productivity', label: 'View Team Productivity' },
                      { key: 'view_team_attendance', label: 'View Team Attendance' },
                      { key: 'view_team_shift_summary', label: 'View Team Shift Summary' }
                    ]
                  },
                  {
                    title: 'Administrative Controls',
                    desc: 'Overrides & auditing limits',
                    color: 'text-rose-500 bg-rose-500/10 border-rose-500/20',
                    items: [
                      { key: 'view_workforce_control', label: 'View Workforce Control' },
                      { key: 'can_force_logout', label: 'Can Force Logout Users' },
                      { key: 'can_force_out', label: 'Can Force Out' },
                      { key: 'can_edit_tms_records', label: 'Can Edit TMS Records' },
                      { key: 'can_modify_activities', label: 'Can Modify Activities' },
                      { key: 'can_close_sessions', label: 'Can Close Sessions' },
                      { key: 'view_team_session_audit_logs', label: 'View Team Session Audit Logs' },
                      { key: 'view_clock_master_consolidation', label: 'View Clock Master Consolidation' },
                      { key: 'view_org_wide_workforce_data', label: 'View Organization-Wide Workforce Data' }
                    ]
                  }
                ].map((cat, idx) => {
                  const tmsMod = (permissions[selectedRole] || {})['Workforce TMS'] || {};
                  const tmsPerms = (tmsMod as any).tms_permissions || getDefaultTmsPermissions(selectedRole);

                  return (
                    <div key={idx} className={`p-4 rounded-xl border ${adminTheme === 'dark' ? 'bg-slate-900/40 border-slate-800' : 'bg-slate-50 border-slate-200'} space-y-3`}>
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider ${cat.color}`}>
                          {cat.title}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400">{cat.desc}</p>
                      
                      <div className="space-y-1 pt-1">
                        {cat.items.map((item) => {
                          const isActive = !!tmsPerms[item.key as keyof TMSPermissions];
                          const isAdmin = selectedRole === 'ADMIN';

                          return (
                            <button
                              key={item.key}
                              type="button"
                              onClick={() => handleToggleTmsPermission(selectedRole, item.key)}
                              className={`w-full flex items-center justify-between text-left p-1.5 rounded text-xs transition ${
                                adminTheme === 'dark' ? 'hover:bg-slate-800/50' : 'hover:bg-slate-100/50'
                              } ${isActive ? 'text-indigo-400 font-extrabold' : 'text-slate-500'}`}
                            >
                              <span>{item.label}</span>
                              <div className={isActive ? 'text-indigo-500' : 'text-slate-400'}>
                                {isActive ? <CheckSquare size={16} /> : <Square size={16} />}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Dynamic Security Verification Report */}
              <div className={`p-5 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-105/5 border-slate-200'} space-y-4`}>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b pb-3 border-slate-100/10 dark:border-slate-800">
                  <div>
                    <h5 className="text-xs font-black uppercase tracking-wider text-amber-500 flex items-center gap-1.5">
                      <AlertTriangle size={15} /> Workforce TMS Validation & Self-Healing Migration Report
                    </h5>
                    <p className="text-[10px] text-slate-400 mt-0.5">Automated security diagnostics run against active role matrices</p>
                  </div>
                  <button
                    type="button"
                    onClick={runDynamicSelfHealingMigration}
                    className="px-2.5 py-1 text-[10px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded transition"
                  >
                    🚀 Trigger Global Self-Healing
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[11px] font-medium leading-relaxed text-slate-400">
                  <div>
                    <span className="text-slate-400 font-bold block mb-1">🔍 Visible Workforce TMS Sections by Role:</span>
                    <div className="space-y-1.5 font-mono text-[10px]">
                      {rolesList.map(r => {
                        const tmsMod = (permissions[r] || {})['Workforce TMS'] || {};
                        const p = (tmsMod as any).tms_permissions || getDefaultTmsPermissions(r);
                        
                        // Count visibilities
                        const selfServiceCount = Object.keys(p).filter(k => k.startsWith('can_punch_') || k.startsWith('view_self_service') || k.includes('own_')).filter(k => !!p[k as keyof TMSPermissions]).length;
                        const monitoringCount = Object.keys(p).filter(k => k.startsWith('view_team_') || k.startsWith('view_workforce_dashboard') || k.startsWith('view_realtime') || k.startsWith('view_logged_')).filter(k => !!p[k as keyof TMSPermissions]).length;
                        const adminCount = Object.keys(p).filter(k => k.startsWith('can_force') || k.includes('tms_records') || k.includes('modify_') || k.includes('correct_') || k.includes('close_') || k.includes('consolidation') || k.includes('org_wide_') || k.startsWith('view_workforce_control')).filter(k => !!p[k as keyof TMSPermissions]).length;

                        return (
                          <div key={r} className="flex justify-between border-b pb-1 border-slate-100/10 dark:border-slate-800">
                            <span className="font-extrabold text-slate-400">{r}:</span>
                            <span className="text-slate-500">
                              SelfService ({selfServiceCount}/12) &middot; Monitoring ({monitoringCount}/7) &middot; Admin ({adminCount}/9)
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <span className="text-slate-400 font-bold block mb-1">⚠️ Security Anomalies / Conflict Matrix:</span>
                    <div className="space-y-1">
                      {rolesList.map(r => {
                        const conflicts = [];
                        const tmsMod = (permissions[r] || {})['Workforce TMS'] || {};
                        const p = (tmsMod as any).tms_permissions || getDefaultTmsPermissions(r);

                        const isAgentOrQA = ['AGENT', 'QA', 'SME', 'TRAINER'].includes(r);
                        
                        // Check if Agent holds admin controls
                        const holdsAdminControls = Object.keys(p).some(k => (k.startsWith('can_force') || k.includes('tms_records') || k.includes('modify_') || k.includes('correct_') || k.includes('close_') || k.includes('consolidation') || k.includes('org_wide_') || k.startsWith('view_workforce_control')) && !!p[k as keyof TMSPermissions]);
                        if (isAgentOrQA && holdsAdminControls) {
                          conflicts.push('IC role holds Administrative privileges!');
                        }

                        // Check if can punch but view_self_service is false
                        if (p.can_punch_in && !p.view_self_service) {
                          conflicts.push('Can Punch In but view_self_service is disabled (Access Block).');
                        }

                        // Check if can force logout but view_workforce_control is false
                        if (p.can_force_logout && !p.view_workforce_control) {
                          conflicts.push('Can Force Logout but view_workforce_control is disabled.');
                        }

                        // Check if MIS holds punch controls
                        if (r === 'MIS' && (p.can_punch_in || p.can_punch_out || p.can_start_break)) {
                          conflicts.push('MIS holds active Self Service punch permissions!');
                        }

                        if (conflicts.length === 0) return null;

                        return (
                          <div key={r} className="text-rose-400 bg-rose-500/5 border border-rose-500/10 p-1.5 rounded-lg text-[10px] space-y-0.5">
                            <span className="font-bold uppercase tracking-wider">{r} Conflict:</span>
                            {conflicts.map((conf, cIdx) => (
                              <p key={cIdx} className="pl-2 font-mono">&bull; {conf}</p>
                            ))}
                          </div>
                        );
                      })}

                      {/* Happy state if zero anomalies */}
                      {!rolesList.some(r => {
                        const tmsMod = (permissions[r] || {})['Workforce TMS'] || {};
                        const p = (tmsMod as any).tms_permissions || getDefaultTmsPermissions(r);
                        if (['AGENT', 'QA', 'SME', 'TRAINER'].includes(r) && Object.keys(p).some(k => (k.startsWith('can_force') || k.includes('tms_records') || k.includes('modify_') || k.includes('correct_') || k.includes('close_') || k.includes('consolidation') || k.includes('org_wide_') || k.startsWith('view_workforce_control')) && !!p[k as keyof TMSPermissions])) return true;
                        if (p.can_punch_in && !p.view_self_service) return true;
                        if (p.can_force_logout && !p.view_workforce_control) return true;
                        if (r === 'MIS' && (p.can_punch_in || p.can_punch_out || p.can_start_break)) return true;
                        return false;
                      }) && (
                        <div className="text-emerald-500 dark:text-emerald-400 bg-emerald-500/5 border border-emerald-500/10 p-3 rounded-lg text-center flex flex-col items-center justify-center font-mono text-[10px]">
                          <Heart size={14} className="animate-pulse text-emerald-500 mb-1 animate-infinite" />
                          <span>No structural violations or role permission conflicts detected! Workforce matrix is fully optimal and safe.</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Disclaimer */}
            <div className="flex gap-2.5 items-start p-4 mt-6 rounded-2xl bg-slate-50 border border-slate-200/60 dark:bg-slate-900/40 dark:border-slate-700/60">
              <Info size={16} className="text-indigo-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-slate-400 leading-normal">
                <strong>Dynamic Navigation Synchronization</strong>: Users will see their menus and action controls adjust dynamically in real-time according to their roles matrix set. After changing states, remember to trigger <strong>Persist {selectedRole} Matrix</strong> to write blocks to Firestore.
              </p>
            </div>
          </div>
        </div>

      </div>

      {/* Grid Matrix popover/modal helper (Displays when double-clicking or editing single cell in comprehensive table) */}
      {isAddingRole && (
        <div className="fixed inset-0 bg-slate-900/65 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className={`max-w-md w-full border shadow-2xl rounded-2xl p-6 space-y-4 ${
            adminTheme === 'dark' ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-800'
          }`}>
            <div className="flex justify-between items-center border-b pb-2">
              <h4 className="text-sm font-black uppercase tracking-wider text-indigo-400">Register Custom Operational Role</h4>
              <button onClick={() => setIsAddingRole(false)} className="text-slate-400 hover:text-slate-600"><SlidersHorizontal size={16} /></button>
            </div>
            
            <div className="space-y-4 text-xs">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">New Role Identifier</label>
                <input
                  required
                  value={newRoleName}
                  onChange={e => setNewRoleName(e.target.value)}
                  placeholder="e.g., ASSISTANT_MANAGER"
                  className={`w-full text-xs p-3 font-mono border rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                    adminTheme === 'dark' ? 'bg-slate-900 border-slate-700' : 'bg-slate-50'
                  }`}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Initial Permissions Blueprint</label>
                <select
                  value={cloneSourceRole}
                  onChange={e => setCloneSourceRole(e.target.value)}
                  className={`w-full text-xs p-2.5 rounded-lg border font-bold ${
                    adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-350' : 'bg-slate-50 text-slate-650'
                  }`}
                >
                  <option value="">-- Copy From Blank (No Modules) --</option>
                  {rolesList.map(r => (
                    <option key={r} value={r}>Copy Matrix from {r}</option>
                  ))}
                </select>
                <span className="text-[9px] text-slate-400 mt-1 block leading-normal">
                  Copies standard View, Create, Delete configuration parameters instantly into the custom role outline.
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs border-t pt-3 mt-4">
              <button onClick={() => setIsAddingRole(false)} className="px-3.5 py-2 font-bold rounded-lg bg-slate-205 text-slate-600 hover:bg-slate-300 transition cursor-pointer">Cancel</button>
              <button 
                onClick={handleCreateCustomRole} 
                disabled={!newRoleName.trim()}
                className="px-3.5 py-2 font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition cursor-pointer disabled:opacity-40"
              >
                Inject Role Entry
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
