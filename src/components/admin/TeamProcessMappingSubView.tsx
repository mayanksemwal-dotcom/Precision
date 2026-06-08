import React, { useState, useMemo, useEffect } from 'react';
import { Users, Link2, Search, CheckSquare, Square, RefreshCcw, ChevronsRight } from 'lucide-react';
import { db } from '../../lib/firebase';
import { doc, writeBatch, collection, getDocs, getDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { UserPicker } from '../UserPicker';

interface TeamProcessMappingSubViewProps {
  allUsers: any[];
  adminTheme: 'light' | 'dark';
  onRefresh: () => void;
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export const TeamProcessMappingSubView: React.FC<TeamProcessMappingSubViewProps> = ({ 
  allUsers, 
  adminTheme, 
  onRefresh, 
  logAdminEvent 
}) => {
  const [search, setSearch] = useState('');
  const [roleGroup, setRoleGroup] = useState('');
  
  // Selection
  const [selection, setSelection] = useState<Set<string>>(new Set());

  // Mappings values
  const [targetTL, setTargetTL] = useState('');
  const [targetManager, setTargetManager] = useState('');
  const [targetProcess, setTargetProcess] = useState('');
  const [registeredProcesses, setRegisteredProcesses] = useState<string[]>([]);

  useEffect(() => {
    const fetchRegisteredProcesses = async () => {
      try {
        const snap = await getDoc(doc(db, 'config', 'tmsProcesses'));
        let list: string[] = [];
        if (snap.exists() && Array.isArray(snap.data()?.list)) {
          list = snap.data()?.list;
        }
        // Include default dynamic fallback if empty
        if (list.length === 0) {
            list = ['HITL', 'MPQC', 'OQC', 'SOP Training', 'QA Review', 'Team Alignment'];
        }
        setRegisteredProcesses(list);
      } catch (err) {
        console.warn('Failed to load registered processes', err);
      }
    };
    fetchRegisteredProcesses();
  }, []);

  // Lists
  const teamLeads = useMemo(() => allUsers.filter(u => {
    const r = (u.role || '').toUpperCase().trim();
    return ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TEAM LEAD', 'TRAINER_TL', 'TRAINER TL', 'OPS TL'].includes(r);
  }), [allUsers]);
  const managers = useMemo(() => allUsers.filter(u => {
    const r = (u.role || '').toUpperCase();
    return r === 'MANAGER' || r === 'ADMIN';
  }), [allUsers]);
  
  const filteredUsers = useMemo(() => {
    return allUsers.filter(u => {
      const q = search.toLowerCase();
      const matchesSearch = 
        (u.name || '').toLowerCase().includes(q) ||
        (u.fullName || '').toLowerCase().includes(q) ||
        (u.employeeName || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.employeeId || '').toLowerCase().includes(q);
      const matchesRole = !roleGroup ? true : (() => {
        const userRole = (u.role || '').toUpperCase().trim();
        const filterRole = roleGroup.toUpperCase().trim();
        
        if (filterRole === 'TEAM_LEAD' || filterRole === 'TEAM LEAD') {
          return ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TEAM LEAD', 'TRAINER_TL', 'TRAINER TL', 'OPS TL'].includes(userRole);
        }
        
        return userRole === filterRole;
      })();
      return matchesSearch && matchesRole;
    });
  }, [allUsers, search, roleGroup]);

  const toggleAll = () => {
    if (selection.size === filteredUsers.length) {
      setSelection(new Set());
    } else {
      const s = new Set<string>();
      filteredUsers.forEach(u => s.add(u.uid));
      setSelection(s);
    }
  };

  const toggleOne = (uid: string) => {
    const s = new Set(selection);
    if (s.has(uid)) {
      s.delete(uid);
    } else {
      s.add(uid);
    }
    setSelection(s);
  };

  // Execution Batch Commit mapping
  const handleExecuteAlignments = async () => {
    if (selection.size === 0) {
      toast.error('Please select users from the left pane table first.');
      return;
    }
    if (!targetTL && !targetManager && !targetProcess) {
      toast.error('Please assign at least one Alignment target (Team Lead, Manager, or Process) on the right pane.');
      return;
    }

    try {
      const batch = writeBatch(db);
      const selectedList = allUsers.filter(u => selection.has(u.uid));

      // Fetch actual detail objects for mapping
      const mappedTLUser = targetTL ? allUsers.find(tl => tl.uid === targetTL) : null;
      const mappedManagerUser = targetManager ? allUsers.find(m => m.uid === targetManager) : null;

      selectedList.forEach(u => {
        const uRef = doc(db, 'users', u.uid);
        const payload: Record<string, any> = { ...u };

        if (targetTL) {
          payload.teamLeadId = targetTL;
          payload.teamLeadName = mappedTLUser ? (mappedTLUser.fullName || mappedTLUser.name || '') : '';
        }

        if (targetManager) {
          payload.mappedManagerId = targetManager;
          payload.mappedManagerName = mappedManagerUser ? (mappedManagerUser.fullName || mappedManagerUser.name || '') : '';
          payload.Manager = mappedManagerUser ? (mappedManagerUser.fullName || mappedManagerUser.name || '') : '';
        }

        if (targetProcess) {
          payload.process = targetProcess;
        }

        batch.set(uRef, payload);
      });

      await batch.commit();
      toast.success(`Broadened alignments successfully inside ${selection.size} employee directories!`);
      logAdminEvent(
        'Staff Network Reconfigured',
        `${selection.size} users`,
        'Varying Mappings',
        `${targetTL ? 'TL: ' + targetTL : ''}, ${targetManager ? 'Mgr: ' + targetManager : ''}, ${targetProcess ? 'Proc: ' + targetProcess : ''}`
      );
      
      setSelection(new Set());
      setTargetTL('');
      setTargetManager('');
      setTargetProcess('');
      onRefresh();
    } catch (err) {
      toast.error('Alignment writing failed.');
    }
  };

  const cardClass = adminTheme === 'dark' 
    ? 'bg-slate-800 border-slate-700 shadow-xl p-6 rounded-2xl border text-slate-105' 
    : 'bg-white border-slate-200 shadow-md p-6 rounded-2xl border text-slate-805';

  return (
    <div className="space-y-6">
      <div className={cardClass}>
        <div className="flex items-center gap-2 mb-6 border-b border-slate-150/10 pb-4">
          <Link2 size={18} className="text-indigo-500 animate-pulse" />
          <div>
            <h3 className="text-base font-extrabold">Dual-Pane Team alignment map</h3>
            <p className="text-xs text-slate-400 mt-0.5">Bulk configure Agent -&gt; Lead, Lead -&gt; Manager, and Process mappings.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left panel: Directory & checkbox select */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Step 1: Select Employees</span>
              <div className="flex gap-2 w-full md:w-auto">
                <input 
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search target listings..."
                  className={adminTheme === 'dark' 
                    ? 'bg-slate-900 border border-slate-700 text-xs text-slate-100 rounded-lg px-2.5 py-1.5 w-full md:w-48' 
                    : 'bg-white border border-slate-200 text-xs text-slate-800 rounded-lg px-2.5 py-1.5 w-full md:w-48'}
                />

                <select 
                  value={roleGroup} 
                  onChange={e => setRoleGroup(e.target.value)}
                  className={adminTheme === 'dark' 
                    ? 'bg-slate-900 text-xs px-2 py-1.5 rounded-lg border border-slate-700' 
                    : 'bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-202'}
                >
                  <option value="">All Roles</option>
                  <option value="AGENT">Agents only</option>
                  <option value="QA">QAs only</option>
                  <option value="TEAM_LEAD">Team Leads only</option>
                  <option value="SME">SMEs only</option>
                </select>
              </div>
            </div>

            {/* Micro Selection table */}
            <div className="max-h-[350px] overflow-y-auto border border-slate-205 dark:border-slate-700 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead className={adminTheme === 'dark' ? 'bg-slate-900 sticky top-0' : 'bg-slate-50 sticky top-0'}>
                  <tr>
                    <th className="p-3 w-10 text-center">
                      <button onClick={toggleAll} className="p-0.5 text-slate-400">
                        {selection.size === filteredUsers.length && filteredUsers.length > 0 ? (
                          <CheckSquare size={14} className="text-indigo-500" />
                        ) : (
                          <Square size={14} />
                        )}
                      </button>
                    </th>
                    <th className="p-3">Employee Name</th>
                    <th className="p-3">Designation</th>
                    <th className="p-3">Mapped TL</th>
                    <th className="p-3">Mapped Manager</th>
                    <th className="p-3">Current Process</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length > 0 ? (
                    filteredUsers.map(u => {
                      const isSel = selection.has(u.uid);
                      return (
                        <tr key={u.uid} className={adminTheme === 'dark' ? 'hover:bg-slate-905 border-b border-slate-800/40' : 'hover:bg-slate-50/50 border-b border-slate-100'}>
                          <td className="p-3 text-center">
                            <button onClick={() => toggleOne(u.uid)} className="p-0.5 text-slate-400">
                              {isSel ? <CheckSquare size={14} className="text-indigo-500" /> : <Square size={14} />}
                            </button>
                          </td>
                          <td className="p-3 font-bold">{u.fullName || u.name || u.employeeName}</td>
                          <td className="p-3"><span className="text-[10px] font-semibold bg-indigo-500/15 text-indigo-400 px-1.5 py-0.5 rounded">{u.role}</span></td>
                          <td className="p-3 font-medium opacity-85">{u.teamLeadName || 'Unassigned'}</td>
                          <td className="p-3 font-medium opacity-85">{u.mappedManagerName || u.Manager || 'Unassigned'}</td>
                          <td className="p-3 font-mono font-bold opacity-85">{u.process || 'N/A'}</td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-slate-400 font-medium">No system entries found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right panel: bulk Alignments parameters apply */}
          <div className={`p-5 rounded-2xl flex flex-col space-y-4 ${adminTheme === 'dark' ? 'bg-slate-900/40 border border-slate-700/50' : 'bg-slate-50 border border-slate-200'}`}>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Step 2: Assign Mappings</span>
            </div>

            {/* Assign TL */}
            <UserPicker 
              label="Map to Supervisor (Team Lead)"
              onSelect={(u) => setTargetTL(u.uid)}
              selectedUserId={targetTL}
              placeholder="Select supervisor..."
              roleFilter={['TEAM_LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM LEAD']}
            />

            {/* Assign Manager */}
            <UserPicker 
              label="Map to Executive (Manager)"
              onSelect={(u) => setTargetManager(u.uid)}
              selectedUserId={targetManager}
              placeholder="Select executive..."
              roleFilter={['MANAGER', 'ADMIN']}
            />

            {/* Assign Process */}
            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-slate-400 uppercase">Map to Campaign (Process Work)</label>
              <select 
                value={targetProcess}
                onChange={e => setTargetProcess(e.target.value)}
                className={`w-full text-xs p-2.5 rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-205 text-slate-850'}`}
              >
                <option value="">Select Process...</option>
                {registeredProcesses.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800/60 mt-auto">
              <div className="text-[11px] text-slate-400 font-semibold mb-4 text-center">
                Applying adjustments to <strong className="text-indigo-500">{selection.size} selected listings</strong>. 
              </div>

              <button 
                onClick={handleExecuteAlignments} 
                className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex justify-center items-center gap-1.5 shadow-md cursor-pointer transition-all"
              >
                Align Employees Now <ChevronsRight size={15} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
