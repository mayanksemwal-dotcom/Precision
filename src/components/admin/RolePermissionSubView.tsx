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
  FolderLock
} from 'lucide-react';
import { db } from '../../lib/firebase';
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

// Defined standard roles matching UserRole
const KNOWN_ROLES = [
  'ADMIN',
  'MANAGER',
  'STL',
  'OPS_TL',
  'SME',
  'QTL',
  'QA',
  'TEAM_LEAD',
  'TRAINER',
  'TRAINER_TL',
  'MIS',
  'AGENT'
];

const ALL_MASTER_MODULES = [
  'Workforce TMS',
  'KPI Scorecard',
  'Warnings',
  'PIP Management',
  'Historical Records',
  'Important Quality Links',
  'Console'
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
}

export const RolePermissionSubView: React.FC<RolePermissionSubViewProps> = ({ adminTheme, logAdminEvent }) => {
  const [modules, setModules] = useState<string[]>(ALL_MASTER_MODULES);
  const [rolesList, setRolesList] = useState<string[]>(KNOWN_ROLES);
  const [permissions, setPermissions] = useState<Record<string, Record<string, Omit<RolePermissionDoc, 'role_name' | 'module_name'>>>>({});
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

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

  // Fetch all modules, roles, and permissions
  useEffect(() => {
    const fetchSecurityData = async () => {
      setLoading(true);
      try {
        // 1. Fetch modules
        const modulesSnap = await getDocs(collection(db, 'module_master'));
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

        // 2. Fetch custom fields and roles
        const rolesSnap = await getDocs(collection(db, 'roles'));
        let fetchedRoles = rolesSnap.docs.map(d => d.data().name as string);
        if (fetchedRoles.length === 0) {
          const fbBatch = writeBatch(db);
          KNOWN_ROLES.forEach(role => {
            fbBatch.set(doc(db, 'roles', role), { id: role, name: role, description: `${role} Role`, createdAt: new Date().toISOString() });
          });
          await fbBatch.commit();
          fetchedRoles = KNOWN_ROLES;
        }
        setRolesList(fetchedRoles);

        // 3. Fetch permissions matrix map
        const permissionsSnap = await getDocs(collection(db, 'role_permissions'));
        const permDocs = permissionsSnap.docs.map(d => d.data() as RolePermissionDoc);
        
        if (permDocs.length === 0) {
          // Auto seed dynamic permission matrix
          await seedDefaultPermissions(fetchedRoles, fetchedModules);
        } else {
          // Convert flat documents structure to nested Record structure
          const matrixMap: Record<string, Record<string, Omit<RolePermissionDoc, 'role_name' | 'module_name'>>> = {};
          
          permDocs.forEach(docItem => {
            const r = docItem.role_name;
            const m = docItem.module_name;
            if (!matrixMap[r]) matrixMap[r] = {};
            matrixMap[r][m] = {
              can_view: !!docItem.can_view,
              can_create: !!docItem.can_create,
              can_edit: !!docItem.can_edit,
              can_delete: !!docItem.can_delete,
              can_export: !!docItem.can_export,
              can_approve: !!docItem.can_approve,
            };
          });
          setPermissions(matrixMap);
        }

        // 4. Fetch templates
        const templatesSnap = await getDocs(collection(db, 'permission_templates'));
        setTemplates(templatesSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      } catch (err) {
        console.error('Failed to pre-fetch security roles matrix:', err);
        toast.error('Unable to sync dynamic roles directory.');
      } finally {
        setLoading(false);
      }
    };

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
          } else if (role === 'TEAM_LEAD' || role === 'STL' || role === 'OPS_TL') {
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

          matrixMap[role][mod] = defaults;
          const mapId = `${role}_${mod}`;
          fbBatch.set(doc(db, 'role_permissions', mapId), {
            id: mapId,
            role_name: role,
            module_name: mod,
            ...defaults
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

  // Toggle dynamic permissions inside state
  const handleToggleState = (role: string, mod: string, field: keyof Omit<RolePermissionDoc, 'role_name' | 'module_name'>) => {
    if (role === 'ADMIN') {
      toast.info('ADMIN role permissions are globally locked down to maintain server control.');
      return;
    }

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
        fbBatch.set(doc(db, 'role_permissions', mapId), {
          id: mapId,
          role_name: roleName,
          module_name: mod,
          ...item
        });
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
                  {modules.map(mod => {
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
                              isAdmin ? 'text-indigo-500 opacity-60 cursor-not-allowed' :
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
                              isAdmin ? 'text-indigo-500 opacity-60 cursor-not-allowed' :
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
                              isAdmin ? 'text-indigo-500 opacity-60 cursor-not-allowed' :
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
                              isAdmin ? 'text-indigo-500 opacity-60 cursor-not-allowed' :
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
                              isAdmin ? 'text-indigo-500 opacity-60 cursor-not-allowed' :
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
                              isAdmin ? 'text-indigo-500 opacity-60 cursor-not-allowed' :
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
