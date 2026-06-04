import React, { useState, useEffect } from 'react';
import { Shield, Plus, Save, Lock, Info, Check, Square, CheckSquare } from 'lucide-react';
import { db } from '../../lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { toast } from 'sonner';

interface RolePermissionSubViewProps {
  adminTheme: 'light' | 'dark';
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

const DEFAULT_PERMISSIONS = [
  'View Dashboard',
  'Manage Users',
  'Manage Historical Data',
  'Edit KPI Configuration',
  'View Reports',
  'Delete Records',
  'Restore Data',
  'System Settings'
];

const DEFAULT_ROLES_MATRIX: Record<string, string[]> = {
  ADMIN: [...DEFAULT_PERMISSIONS],
  MANAGER: ['View Dashboard', 'Manage Users', 'Manage Historical Data', 'Edit KPI Configuration', 'View Reports', 'System Settings'],
  TEAM_LEAD: ['View Dashboard', 'View Reports'],
  QA: ['View Dashboard', 'View Reports'],
  AGENT: ['View Dashboard'],
  SME: ['View Dashboard', 'View Reports']
};

export const RolePermissionSubView: React.FC<RolePermissionSubViewProps> = ({ adminTheme, logAdminEvent }) => {
  const [matrix, setMatrix] = useState<Record<string, string[]>>(DEFAULT_ROLES_MATRIX);
  const [customRoles, setCustomRoles] = useState<string[]>([]);
  const [newRoleName, setNewRoleName] = useState('');
  const [isAddingRole, setIsAddingRole] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMatrix = async () => {
      try {
        const dRef = doc(db, 'config', 'roles_permissions');
        const dSnap = await getDoc(dRef);
        if (dSnap.exists()) {
          const data = dSnap.data();
          if (data.matrix) {
            setMatrix(data.matrix);
          }
          if (data.customRoles) {
            setCustomRoles(data.customRoles);
          }
        }
      } catch (err) {
        console.warn('Could not read roles_permissions config:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchMatrix();
  }, []);

  const handleToggle = (role: string, permission: string) => {
    // Admins have immutable baseline permissions
    if (role.toUpperCase() === 'ADMIN') {
      toast.info('ADMIN role permissions are static to maintain core app recovery pathways.');
      return;
    }

    const currentPerms = matrix[role] || [];
    let nextPerms = [];
    if (currentPerms.includes(permission)) {
      nextPerms = currentPerms.filter(p => p !== permission);
    } else {
      nextPerms = [...currentPerms, permission];
    }

    setMatrix(prev => ({
      ...prev,
      [role]: nextPerms
    }));
  };

  const handleSaveMatrix = async () => {
    try {
      const dRef = doc(db, 'config', 'roles_permissions');
      await setDoc(dRef, {
        matrix,
        customRoles,
        updatedAt: new Date().toISOString()
      });
      toast.success('Enterprise Role Permissions Matrix persisted successfully!');
      logAdminEvent('Permission Matrix Overwritten', 'Roles Scheme', '', 'Saved custom matrices');
    } catch (err) {
      toast.error('Writing matrix profile failed.');
    }
  };

  const handleAddCustomRole = () => {
    const cleanName = newRoleName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!cleanName) {
      toast.error('Please enter a alphanumeric role identifier.');
      return;
    }
    if (matrix[cleanName] || customRoles.includes(cleanName)) {
      toast.error('Role identifier already registered.');
      return;
    }

    // Add empty permission set
    setMatrix(prev => ({
      ...prev,
      [cleanName]: ['View Dashboard'] // Default
    }));
    setCustomRoles(prev => [...prev, cleanName]);
    setNewRoleName('');
    setIsAddingRole(false);
    toast.success(`Custom role '${cleanName}' registered into active columns!`);
    logAdminEvent('Custom Role Configuring', cleanName, '', 'Registered in columns');
  };

  const handleDeleteCustomRole = (role: string) => {
    if (!window.confirm(`Are you sure you want to delete custom role ${role}? Any mapped users will fallback to default permissions.`)) return;
    const nextMatrix = { ...matrix };
    delete nextMatrix[role];
    setMatrix(nextMatrix);
    setCustomRoles(prev => prev.filter(r => r !== role));
    toast.info(`Custom role ${role} removed.`);
  };

  if (loading) {
    return (
      <div className="py-12 text-center text-slate-400 font-mono text-xs">Loading Security Matrix Config...</div>
    );
  }

  const cardClass = adminTheme === 'dark' 
    ? 'bg-slate-800 border-slate-700 shadow-xl p-6 rounded-2xl border text-slate-100' 
    : 'bg-white border-slate-200 shadow-md p-6 rounded-2xl border text-slate-800';

  const rolesList = ['ADMIN', 'MANAGER', 'TEAM_LEAD', 'QA', 'AGENT', 'SME', ...customRoles];

  return (
    <div className="space-y-6">
      <div className={cardClass}>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 border-b border-slate-150/10 pb-4">
          <div>
            <h3 className="text-base font-extrabold flex items-center gap-2 text-indigo-500">
              <Shield size={18} /> Role Permissions Matrix
            </h3>
            <p className="text-xs text-slate-400 mt-1">Configure active system pathways across operational groups and departments.</p>
          </div>

          <div className="flex gap-2">
            <button 
              onClick={() => setIsAddingRole(true)} 
              className="px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer bg-slate-800 border border-slate-700 hover:bg-slate-700 text-white flex items-center gap-1"
            >
              <Plus size={14} /> Custom Role Column
            </button>
            <button 
              onClick={handleSaveMatrix} 
              className="px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1"
            >
              <Save size={14} /> Persist Security Changes
            </button>
          </div>
        </div>

        {/* Matrix Grid table */}
        <div className="overflow-x-auto rounded-xl border border-slate-205 dark:border-slate-700">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className={adminTheme === 'dark' ? 'bg-slate-900 border-b border-slate-705' : 'bg-slate-50 border-b border-slate-205'}>
                <th className="p-4 font-extrabold uppercase text-[10px] text-slate-400 tracking-wider w-[240px]">System Access Permissions</th>
                {rolesList.map(role => (
                  <th key={role} className="p-4 font-bold text-center border-l border-slate-200 dark:border-slate-700">
                    <div className="flex flex-col items-center gap-1.5">
                      <span className="font-extrabold text-[11px] text-slate-200 uppercase bg-slate-500/10 dark:bg-slate-700 dark:text-slate-200 rounded px-2 py-0.5">{role}</span>
                      {customRoles.includes(role) && (
                        <button 
                          onClick={() => handleDeleteCustomRole(role)}
                          className="text-[9px] text-rose-500 hover:underline font-mono"
                        >
                          [Delete]
                        </button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-150/10">
              {DEFAULT_PERMISSIONS.map(perm => (
                <tr key={perm} className={adminTheme === 'dark' ? 'hover:bg-slate-900/40' : 'hover:bg-slate-50/50'}>
                  <td className="p-4 font-bold text-slate-700 dark:text-slate-300">
                    <div className="flex flex-col dropdown">
                      <span className="text-xs">{perm}</span>
                      <span className="text-[10px] text-slate-400 font-medium">Allows system actions tagged as '{perm}'</span>
                    </div>
                  </td>
                  {rolesList.map(role => {
                    const isChecked = (matrix[role] || []).includes(perm);
                    const isAdmin = role.toUpperCase() === 'ADMIN';
                    return (
                      <td key={role} className="p-4 text-center border-l border-slate-200 dark:border-slate-700">
                        <button 
                          onClick={() => handleToggle(role, perm)}
                          className={`p-1 rounded-md transition-all ${
                            isAdmin ? 'text-indigo-400 cursor-not-allowed opacity-80' : 
                            isChecked ? 'text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30' : 'text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          {isChecked ? <CheckSquare size={18} /> : <Square size={18} />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Informative message */}
        <div className="flex gap-2.5 items-start p-4 mt-6 rounded-2xl bg-slate-50 border border-slate-200/60 dark:bg-slate-900/40 dark:border-slate-700/60">
          <Info size={16} className="text-indigo-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-slate-400 leading-normal">
            <strong>Security Invariant Guardrails</strong>: Customized role mapping operates with real-time token claims synchronization in Firebase. Baseline ADMIN pathways are locked down dynamically to prevent catastrophic lockouts from the administration portal itself.
          </p>
        </div>
      </div>

      {/* Column creation popup */}
      {isAddingRole && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`max-w-sm w-full border shadow-2xl rounded-2xl p-6 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-800'}`}>
            <h4 className="text-sm font-extrabold uppercase tracking-wider mb-2">Register Custom Organizational Role</h4>
            <p className="text-xs text-slate-400 mb-4">Column labels must not contain special character codes.</p>
            
            <input 
              required
              value={newRoleName}
              onChange={e => setNewRoleName(e.target.value)}
              placeholder="e.g. OPERATIONS_DIRECTOR"
              className={`w-full text-xs p-3 font-mono border rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 ${adminTheme === 'dark' ? 'bg-slate-900 border-slate-700' : 'bg-slate-50'}`}
            />

            <div className="flex justify-end gap-2 mt-4 text-xs">
              <button onClick={() => setIsAddingRole(false)} className="px-3 py-1.5 font-bold rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 cursor-pointer">Cancel</button>
              <button onClick={handleAddCustomRole} className="px-3 py-1.5 font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer">Inject Role Column</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
