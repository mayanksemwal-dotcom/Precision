import React, { useState, useMemo, useEffect } from 'react';
import { Users, Link2, Search, CheckSquare, Square, ChevronsRight, Download, Upload, FileSpreadsheet, Sparkles, Check, AlertCircle, ArrowRight } from 'lucide-react';
import { db } from '../../lib/firebase';
import { doc, writeBatch, getDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { UserPicker } from '../UserPicker';
import { useRoster } from '../../contexts/RosterContext';
import { OrgTree } from '../../lib/hierarchy';
import { safeStorage } from '../../lib/safeStorage';

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
  const { updateMultipleUsersInRoster } = useRoster();
  const [search, setSearch] = useState('');
  const [roleGroup, setRoleGroup] = useState('');
  
  // Selection
  const [selection, setSelection] = useState<Set<string>>(new Set());

  // Mappings values
  const [targetTL, setTargetTL] = useState('');
  const [targetProcess, setTargetProcess] = useState('');
  const [registeredProcesses, setRegisteredProcesses] = useState<string[]>([]);

  // Import states
  const [mappingMode, setMappingMode] = useState<'interactive' | 'bulk'>('interactive');
  const [bulkInputText, setBulkInputText] = useState('');
  const [importStats, setImportStats] = useState<{ total: number; resolved: number; failed: number; updates: any[] } | null>(null);

  useEffect(() => {
    const fetchRegisteredProcesses = async () => {
      try {
        const snap = await getDoc(doc(db, 'config', 'tmsProcesses'));
        let list: string[] = [];
        if (snap.exists() && Array.isArray(snap.data()?.list)) {
          list = snap.data()?.list;
        }
        if (list.length === 0) {
          list = ['HITL', 'OQC', 'SOP Training', 'QA Review', 'Team Alignment'];
        }
        const blocked = ['mpqc', 'mpqc-fk', 'mpqc-sh'];
        list = list.filter(p => !blocked.includes((p || '').toLowerCase().trim()));
        setRegisteredProcesses(list);
      } catch (err) {
        console.warn('Failed to load registered processes', err);
      }
    };
    fetchRegisteredProcesses();
  }, []);

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

  // Execution Batch Commit mapping with Cycle Protection & Self-Mapping Validation
  const handleExecuteAlignments = async () => {
    if (selection.size === 0) {
      toast.error('Please select users from the left pane table first.');
      return;
    }
    if (!targetTL && !targetProcess) {
      toast.error('Please assign at least one Alignment target (Supervisor or Process) on the right pane.');
      return;
    }

    const selectedList = allUsers.filter(u => selection.has(u.uid));
    const mappedTLUser = targetTL ? allUsers.find(tl => tl.uid === targetTL) : null;

    // 1. Self-Mapping Protection
    if (targetTL && selectedList.some(u => u.uid === targetTL)) {
      toast.error('A user cannot be mapped to themselves as supervisor.');
      return;
    }

    // 2. Cycle Protection
    if (targetTL) {
      const tree = new OrgTree(allUsers);
      for (const u of selectedList) {
        const descendants = tree.getDescendants(u.uid);
        if (descendants.has(targetTL)) {
          const uName = u.fullName || u.name || u.employeeName || 'Selected user';
          const parentName = mappedTLUser ? (mappedTLUser.fullName || mappedTLUser.name || 'target supervisor') : 'target supervisor';
          toast.error(`Circular hierarchy detected! Cannot set ${parentName} as supervisor of ${uName} because ${uName} is in their upline.`);
          return;
        }
      }
    }

    try {
      const batch = writeBatch(db);
      const isManagerParent = mappedTLUser && ['MANAGER', 'ADMIN', 'OPS_HEAD', 'DIRECTOR', 'VP', 'OM', 'AM', 'DEPUTY_MANAGER'].some(r => (mappedTLUser.role || '').toString().toUpperCase().includes(r));

      selectedList.forEach(u => {
        const uRef = doc(db, 'users', u.uid);
        const payload: Record<string, any> = {
          lastModifiedAt: new Date().toISOString()
        };

        if (targetTL && mappedTLUser) {
          const parentName = mappedTLUser.fullName || mappedTLUser.name || mappedTLUser.employeeName || '';
          const parentEmail = mappedTLUser.email || '';

          payload.teamLeadId = targetTL;
          payload.teamLeadUid = targetTL;
          payload.teamLeadName = parentName;
          payload.teamLeadEmail = parentEmail;

          if (isManagerParent) {
            payload.mappedManagerId = targetTL;
            payload.mappedManagerUid = targetTL;
            payload.mappedManagerName = parentName;
            payload.mappedManagerEmail = parentEmail;
            payload.managerId = targetTL;
            payload.managerName = parentName;
            payload.Manager = parentName;
          }

          // Clear legacy manager-of-manager fields
          payload.managerOfManagerId = '';
          payload.managerOfManagerName = '';
          payload.mappedManagerOfManagerId = '';
          payload.mappedManagerOfManagerName = '';
        }

        if (targetProcess) {
          payload.process = targetProcess;
        }

        batch.update(uRef, payload);

        // SYNC Team Mappings
        const mappingRef = doc(db, 'teamMappings', u.uid);
        batch.set(mappingRef, {
          userId: u.uid,
          userName: u.fullName || u.name || '',
          teamLeadId: payload.teamLeadId || u.teamLeadId || '',
          teamLeadName: payload.teamLeadName || u.teamLeadName || '',
          managerId: payload.mappedManagerId || u.mappedManagerId || '',
          managerName: payload.mappedManagerName || u.mappedManagerName || '',
          managerOfManagerId: '',
          managerOfManagerName: '',
          process: payload.process || u.process || '',
          lastUpdated: new Date().toISOString()
        }, { merge: true });

        // SYNC employee_master
        const masterRef = doc(db, 'employee_master', u.uid);
        batch.set(masterRef, {
          teamLeadId: payload.teamLeadId || u.teamLeadId || '',
          teamLeadName: payload.teamLeadName || u.teamLeadName || '',
          managerId: payload.mappedManagerId || u.mappedManagerId || '',
          managerName: payload.mappedManagerName || u.mappedManagerName || '',
          managerOfManagerId: '',
          managerOfManagerName: '',
          process: payload.process || u.process || '',
          lastUpdated: new Date().toISOString()
        }, { merge: true });

        const pVal = payload.process || u.process || '';
        if (pVal) {
          batch.set(doc(db, 'live_sessions', u.uid), {
            process: pVal,
            currentProcess: pVal
          }, { merge: true });
        }
      });

      await batch.commit();
      toast.success(`Synchronized operational hierarchy for ${selection.size} employees!`);
      logAdminEvent(
        'Staff Network Reconfigured',
        `${selection.size} users`,
        'Varying Mappings',
        `${targetTL ? 'Supervisor: ' + targetTL : ''}, ${targetProcess ? 'Proc: ' + targetProcess : ''}`
      );
      
      setSelection(new Set());
      setTargetTL('');
      setTargetProcess('');
      
      const localUpdates = selectedList.map(u => ({
        uid: u.uid,
        teamLeadId: targetTL || u.teamLeadId,
        teamLeadUid: targetTL || u.teamLeadUid,
        teamLeadName: mappedTLUser ? (mappedTLUser.fullName || mappedTLUser.name || '') : u.teamLeadName,
        mappedManagerId: isManagerParent ? targetTL : u.mappedManagerId,
        mappedManagerUid: isManagerParent ? targetTL : u.mappedManagerUid,
        mappedManagerName: isManagerParent && mappedTLUser ? (mappedTLUser.fullName || mappedTLUser.name || '') : u.mappedManagerName,
        managerId: isManagerParent ? targetTL : u.managerId,
        managerName: isManagerParent && mappedTLUser ? (mappedTLUser.fullName || mappedTLUser.name || '') : u.managerName,
        process: targetProcess || u.process
      }));

      await updateMultipleUsersInRoster(localUpdates);
      try {
        await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
      } catch (e) {
        console.warn('Failed clearing subordinate caches:', e);
      }
    } catch (err) {
      toast.error('Alignment writing failed.');
    }
  };

  // CSV parser for flexible layouts
  const parseCSVRows = (text: string) => {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length < 2) {
      return { headers: [], rows: [] };
    }

    const splitCSVRow = (line: string) => {
      const result: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };

    const headers = splitCSVRow(lines[0]).map(h => h.toLowerCase().replace(/[\s\-_]+/g, ''));
    const rows: Record<string, string>[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cells = splitCSVRow(lines[i]);
      const rowData: Record<string, string> = {};
      cells.forEach((cell, idx) => {
        const h = headers[idx] || `col_${idx}`;
        let cleanVal = cell;
        if (cleanVal.startsWith('"') && cleanVal.endsWith('"')) {
          cleanVal = cleanVal.slice(1, -1);
        }
        rowData[h] = cleanVal.trim();
      });
      rows.push(rowData);
    }

    return { headers, rows };
  };

  // Bulk CSV Export of Team Mappings
  const handleExportCSV = () => {
    const csvRows = [
      ['Employee Name', 'Employee Email', 'Designation', 'Supervisor Name', 'Supervisor Email/ID', 'Current Process']
    ];

    allUsers.forEach(u => {
      csvRows.push([
        u.fullName || u.name || u.employeeName || '',
        u.email || '',
        u.role || '',
        u.teamLeadName || u.mappedManagerName || 'Unassigned',
        u.teamLeadId || u.mappedManagerId || '',
        u.process || 'N/A'
      ]);
    });

    const csvString = "\uFEFF" + csvRows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `precision360_team_mappings_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Successfully exported current team mappings to CSV!');
  };

  // Bulk CSV Import alignment implementation with Cycle Validation
  const handleCSVImportAlignments = async () => {
    if (!bulkInputText.trim()) {
      toast.error('Please paste or load CSV data first.');
      return;
    }

    try {
      const { rows } = parseCSVRows(bulkInputText);

      if (rows.length === 0) {
        toast.error('Could not identify any valid rows under the headers.');
        return;
      }

      const resolvedUpdates: any[] = [];
      const skippedRows: any[] = [];
      const tree = new OrgTree(allUsers);

      rows.forEach((row, rowIndex) => {
        let targetUser: any = null;

        const emailKey = Object.keys(row).find(k => k.includes('email'));
        const nameKey = Object.keys(row).find(k => k.includes('name') || k.includes('fullname') || k.includes('employee'));
        const empIdKey = Object.keys(row).find(k => k.includes('id') || k.includes('employeeid') || k.includes('empid'));

        if (emailKey && row[emailKey]) {
          const emailVal = row[emailKey].toLowerCase().trim();
          targetUser = allUsers.find(u => (u.email || '').toLowerCase().trim() === emailVal);
        }
        if (!targetUser && empIdKey && row[empIdKey]) {
          const empIdVal = row[empIdKey].toLowerCase().trim();
          targetUser = allUsers.find(u => (u.employeeId || '').toLowerCase().trim() === empIdVal);
        }
        if (!targetUser && nameKey && row[nameKey]) {
          const nameVal = row[nameKey].toLowerCase().trim();
          targetUser = allUsers.find(u => 
            (u.fullName || '').toLowerCase().trim() === nameVal ||
            (u.name || '').toLowerCase().trim() === nameVal ||
            (u.employeeName || '').toLowerCase().trim() === nameVal
          );
        }

        if (!targetUser) {
          skippedRows.push({ rowIndex: rowIndex + 2, row, reason: 'Employee profile not found in directory.' });
          return;
        }

        // Resolve Supervisor (TL or Manager)
        let supervisorUser: any = null;
        const supKey = Object.keys(row).find(k => k.includes('lead') || k.includes('supervisor') || k.includes('manager') || k === 'tl' || k === 'mgr');
        if (supKey && row[supKey]) {
          const supVal = row[supKey].toLowerCase().trim();
          supervisorUser = allUsers.find(u => {
            return (u.email || '').toLowerCase().trim() === supVal ||
                   (u.fullName || '').toLowerCase().trim() === supVal ||
                   (u.name || '').toLowerCase().trim() === supVal ||
                   (u.employeeId || '').toLowerCase().trim() === supVal;
          });
          if (!supervisorUser) {
            supervisorUser = allUsers.find(u => {
              const uName = (u.fullName || u.name || '').toLowerCase().trim();
              return uName && (uName.includes(supVal) || supVal.includes(uName));
            });
          }
        }

        // Validate Self-Mapping
        if (supervisorUser && supervisorUser.uid === targetUser.uid) {
          skippedRows.push({ rowIndex: rowIndex + 2, row, reason: 'Self-mapping rejected (user cannot report to themselves).' });
          return;
        }

        // Validate Cycle
        if (supervisorUser && tree.getDescendants(targetUser.uid).has(supervisorUser.uid)) {
          skippedRows.push({ rowIndex: rowIndex + 2, row, reason: `Circular hierarchy rejected (${supervisorUser.name} is in ${targetUser.name}'s downline).` });
          return;
        }

        // Resolve Campaign (Process)
        let processVal = '';
        const procKey = Object.keys(row).find(k => k.includes('process') || k.includes('campaign') || k.includes('project') || k.includes('team'));
        if (procKey && row[procKey]) {
          processVal = row[procKey];
        }

        resolvedUpdates.push({
          user: targetUser,
          supervisor: supervisorUser,
          process: processVal
        });
      });

      if (resolvedUpdates.length === 0) {
        toast.error('Zero rows matched existing employee profiles or passed hierarchy validations.');
        setImportStats({
          total: rows.length,
          resolved: 0,
          failed: skippedRows.length,
          updates: skippedRows
        });
        return;
      }

      const batch = writeBatch(db);
      resolvedUpdates.forEach(item => {
        const u = item.user;
        const sup = item.supervisor;
        const payload: Record<string, any> = { ...u };

        if (sup) {
          const supName = sup.fullName || sup.name || '';
          const supEmail = sup.email || '';
          const isMgr = ['MANAGER', 'ADMIN', 'OPS_HEAD', 'DIRECTOR', 'VP'].some(r => (sup.role || '').toUpperCase().includes(r));

          payload.teamLeadId = sup.uid;
          payload.teamLeadUid = sup.uid;
          payload.teamLeadName = supName;
          payload.teamLeadEmail = supEmail;

          if (isMgr) {
            payload.mappedManagerId = sup.uid;
            payload.mappedManagerUid = sup.uid;
            payload.mappedManagerName = supName;
            payload.mappedManagerEmail = supEmail;
            payload.managerId = sup.uid;
            payload.managerName = supName;
            payload.Manager = supName;
          }

          payload.managerOfManagerId = '';
          payload.managerOfManagerName = '';
        }

        if (item.process) {
          payload.process = item.process;
        }

        payload.lastUpdated = new Date().toISOString();

        batch.set(doc(db, 'users', u.uid), payload, { merge: true });

        // SYNC Team Mappings
        const mappingRef = doc(db, 'teamMappings', u.uid);
        batch.set(mappingRef, {
          userId: u.uid,
          userName: u.fullName || u.name || '',
          teamLeadId: payload.teamLeadId || u.teamLeadId || '',
          teamLeadName: payload.teamLeadName || u.teamLeadName || '',
          managerId: payload.mappedManagerId || u.mappedManagerId || '',
          managerName: payload.mappedManagerName || u.mappedManagerName || '',
          managerOfManagerId: '',
          managerOfManagerName: '',
          process: payload.process || u.process || '',
          lastUpdated: new Date().toISOString()
        }, { merge: true });

        // SYNC employee_master
        const masterRef = doc(db, 'employee_master', u.uid);
        batch.set(masterRef, {
          teamLeadId: payload.teamLeadId || u.teamLeadId || '',
          teamLeadName: payload.teamLeadName || u.teamLeadName || '',
          managerId: payload.mappedManagerId || u.mappedManagerId || '',
          managerName: payload.mappedManagerName || u.mappedManagerName || '',
          managerOfManagerId: '',
          managerOfManagerName: '',
          process: payload.process || u.process || '',
          lastUpdated: new Date().toISOString()
        }, { merge: true });

        const pVal = payload.process || u.process || '';
        if (pVal) {
          batch.set(doc(db, 'live_sessions', u.uid), {
            process: pVal,
            currentProcess: pVal
          }, { merge: true });
        }
      });

      await batch.commit();

      toast.success(`Successfully mapped and aligned ${resolvedUpdates.length} employee structures in bulk!`);
      logAdminEvent(
        'Staff Bulk Import Reconfigured',
        `${resolvedUpdates.length} rows verified`,
        'Bulk Import CSV',
        `Matched and successfully remapped: ${resolvedUpdates.length} and skipped ${skippedRows.length}`
      );

      setBulkInputText('');
      setImportStats({
        total: rows.length,
        resolved: resolvedUpdates.length,
        failed: skippedRows.length,
        updates: skippedRows
      });

      const localBulkUpdates = resolvedUpdates.map(item => ({
        uid: item.user.uid,
        teamLeadId: item.supervisor ? item.supervisor.uid : item.user.teamLeadId,
        teamLeadUid: item.supervisor ? item.supervisor.uid : item.user.teamLeadUid,
        teamLeadName: item.supervisor ? (item.supervisor.fullName || item.supervisor.name) : item.user.teamLeadName,
        process: item.process || item.user.process
      }));

      await updateMultipleUsersInRoster(localBulkUpdates);
      try {
        await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
      } catch (e) {
        console.warn('Failed clearing subordinate caches:', e);
      }
    } catch (err: any) {
      toast.error(`Import parsing/writing error: ${err.message || 'System error'}`);
    }
  };

  const cardClass = adminTheme === 'dark' 
    ? 'bg-slate-800 border-slate-700 shadow-xl p-6 rounded-2xl border text-slate-105' 
    : 'bg-white border-slate-200 shadow-md p-6 rounded-2xl border text-slate-805';

  return (
    <div className="space-y-6">
      <div className={cardClass}>
        {/* Header section */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 border-b border-slate-100 dark:border-slate-800 pb-5">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-500/10 rounded-xl text-indigo-500">
              <Link2 size={20} className="animate-pulse" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-slate-800 dark:text-white leading-tight">Team Alignments & Process Mapping</h3>
              <p className="text-xs text-slate-400 mt-0.5">Configure operational hierarchies: map direct supervisors, team leads, managers, and campaign workflows.</p>
            </div>
          </div>

          {/* Mode Switcher */}
          <div className="flex p-1 bg-slate-100 dark:bg-slate-900 rounded-xl max-w-sm sm:w-auto">
            <button
              onClick={() => setMappingMode('interactive')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                mappingMode === 'interactive'
                  ? 'bg-white dark:bg-slate-800 text-slate-800 dark:text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Users size={13} /> Interactive Grid
            </button>
            <button
              onClick={() => setMappingMode('bulk')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                mappingMode === 'bulk'
                  ? 'bg-white dark:bg-slate-800 text-slate-800 dark:text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileSpreadsheet size={13} /> Bulk Import/Export
            </button>
          </div>
        </div>

        {mappingMode === 'interactive' ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            {/* Left panel: Directory & checkbox select */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                  1. Select Employees <span className="bg-indigo-500/10 text-indigo-400 text-[10px] px-1.5 py-0.5 rounded-full">{selection.size} selected</span>
                </span>
                <div className="flex gap-2 w-full md:w-auto">
                  <input 
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search target listings..."
                    className={adminTheme === 'dark' 
                      ? 'bg-slate-900 border border-slate-700 text-xs text-slate-100 rounded-lg px-2.5 py-1.5 w-full md:w-48 focus:ring-1 focus:ring-indigo-500 outline-none' 
                      : 'bg-white border border-slate-200 text-xs text-slate-800 rounded-lg px-2.5 py-1.5 w-full md:w-48 focus:ring-1 focus:ring-indigo-500 outline-none'}
                  />

                  <select 
                    value={roleGroup} 
                    onChange={e => setRoleGroup(e.target.value)}
                    className={adminTheme === 'dark' 
                      ? 'bg-slate-900 text-xs px-2 py-1.5 rounded-lg border border-slate-700 outline-none' 
                      : 'bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-202 outline-none'}
                  >
                    <option value="">All Roles</option>
                    <option value="AGENT">Agents only</option>
                    <option value="QA">QAs only</option>
                    <option value="TEAM LEAD">Team Leads only</option>
                    <option value="SME">SMEs only</option>
                    <option value="MANAGER">Managers only</option>
                  </select>
                </div>
              </div>

              {/* Selection table */}
              <div className="max-h-[380px] overflow-y-auto border border-slate-205 dark:border-slate-800 rounded-xl shadow-inner">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className={adminTheme === 'dark' ? 'bg-slate-900 text-slate-300 sticky top-0 border-b border-slate-800' : 'bg-slate-50 text-slate-600 sticky top-0 border-b border-slate-150'}>
                    <tr>
                      <th className="p-3 w-10 text-center">
                        <button onClick={toggleAll} className="p-0.5 text-slate-400 cursor-pointer">
                          {selection.size === filteredUsers.length && filteredUsers.length > 0 ? (
                            <CheckSquare size={14} className="text-indigo-500" />
                          ) : (
                            <Square size={14} />
                          )}
                        </button>
                      </th>
                      <th className="p-3">Employee Name</th>
                      <th className="p-3">Designation</th>
                      <th className="p-3">Direct Supervisor</th>
                      <th className="p-3">Process</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.length > 0 ? (
                      filteredUsers.map(u => {
                        const isSel = selection.has(u.uid);
                        return (
                          <tr key={u.uid} className={adminTheme === 'dark' ? 'hover:bg-slate-900 border-b border-slate-800/40 transition-colors' : 'hover:bg-slate-50/50 border-b border-slate-100 transition-colors'}>
                            <td className="p-3 text-center">
                              <button onClick={() => toggleOne(u.uid)} className="p-0.5 text-slate-400 cursor-pointer">
                                {isSel ? <CheckSquare size={14} className="text-indigo-500" /> : <Square size={14} />}
                              </button>
                            </td>
                            <td className="p-3 font-bold text-slate-800 dark:text-slate-150">
                              <div className="flex items-center gap-2">
                                <div className="w-6 h-6 rounded-full overflow-hidden bg-slate-100 flex items-center justify-center font-bold text-[10px] text-slate-400 border border-slate-200 shrink-0">
                                  {u.photoURL ? (
                                    <img src={u.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                  ) : (
                                    (u.fullName || u.name || u.employeeName || '??').split(' ').map((n: string) => n[0]).slice(0, 2).join('')
                                  )}
                                </div>
                                <span className="truncate">{u.fullName || u.name || u.employeeName}</span>
                              </div>
                            </td>
                            <td className="p-3"><span className="text-[10px] font-semibold bg-indigo-500/15 text-indigo-400 px-1.5 py-0.5 rounded uppercase tracking-wider">{u.role}</span></td>
                            <td className="p-3 font-medium opacity-85 text-slate-600 dark:text-slate-300">{u.teamLeadName || u.mappedManagerName || 'Unassigned'}</td>
                            <td className="p-3 font-mono font-bold opacity-85 text-emerald-500 dark:text-emerald-400">{u.process || 'N/A'}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-slate-450 font-medium">No directory entries matched the search filters.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right panel: Alignments parameters apply */}
            <div className={`p-5 rounded-2xl flex flex-col space-y-4 shadow-sm border ${adminTheme === 'dark' ? 'bg-slate-900/50 border-slate-800' : 'bg-slate-50/50 border-slate-150'}`}>
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-xs font-black uppercase tracking-wider text-slate-500">2. Apply Mappings</span>
              </div>

              {/* Assign Supervisor (Team Lead or Manager) */}
              <UserPicker 
                label="Map to Supervisor (Team Lead / Manager)"
                onSelect={(u) => setTargetTL(u.uid)}
                selectedUserId={targetTL}
                placeholder="Search supervisor or manager..."
                roleFilter={['Team Lead', 'TEAM LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'OPS_TEAM_LEAD', 'TEAM_LEADER', 'MANAGER', 'ADMIN', 'OPS_HEAD', 'ASSISTANT_MANAGER', 'AM', 'DEPUTY_MANAGER', 'SME']}
                allUsers={allUsers}
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

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800/80 mt-auto">
                <div className="text-[11px] text-slate-400 font-semibold mb-4 text-center">
                  Executing adjustments for <strong className="text-indigo-500">{selection.size} checked employees</strong>.
                </div>

                <button 
                  onClick={handleExecuteAlignments} 
                  className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex justify-center items-center gap-1.5 shadow-md cursor-pointer transition-all hover:scale-[1.01]"
                >
                  Align Employees Now <ChevronsRight size={15} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Bulk Import and Export Center */
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            {/* Instructions box */}
            <div className={`p-4 rounded-xl border flex gap-3 ${adminTheme === 'dark' ? 'bg-indigo-950/20 border-indigo-900/40 text-indigo-250' : 'bg-indigo-55/40 border-indigo-100 text-indigo-900'}`}>
              <Sparkles size={18} className="text-indigo-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs space-y-1">
                <h4 className="font-extrabold uppercase tracking-tight text-[11px]">Dynamic Column-Flexible CSV Import Engine</h4>
                <p className="opacity-90">
                  Bulk align employee reporting lines easily. The CSV engine automatically resolves records using <strong>Email, Full Name, or Employee ID</strong>. Match columns using simple descriptors:
                </p>
                <div className="grid grid-cols-2 gap-4 mt-2 font-mono text-[10px] bg-slate-905/10 p-2 rounded-lg text-slate-500 dark:text-slate-400">
                  <div>
                    <strong>• Target Employee:</strong> email, employeeemail, employee id, name
                  </div>
                  <div>
                    <strong>• Supervisor/Manager:</strong> supervisor, team lead, manager, tl, mgr
                  </div>
                </div>
              </div>
            </div>

            {/* Main export template & import tools */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* CSV input and load tools */}
              <div className="lg:col-span-2 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Pasted CSV Content Editor</span>
                  
                  {/* File selection proxy */}
                  <div>
                    <input 
                      type="file" 
                      id="bulk-mapping-file" 
                      accept=".csv" 
                      className="hidden" 
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = (evt) => {
                          const text = evt.target?.result as string;
                          setBulkInputText(text);
                          toast.success(`Loaded "${file.name}" matching ${text.split('\n').length - 1} data listings!`);
                          setImportStats(null);
                        };
                        reader.readAsText(file);
                      }}
                    />
                    <button
                      onClick={() => document.getElementById('bulk-mapping-file')?.click()}
                      className="text-xs font-bold px-3 py-1.5 bg-slate-100/10 hover:bg-slate-100/20 text-indigo-455 hover:text-indigo-400 hover:underline border border-dashed border-slate-700 rounded-lg flex items-center gap-1.5 cursor-pointer"
                    >
                      <Upload size={13} /> Upload CSV File
                    </button>
                  </div>
                </div>

                <textarea
                  rows={8}
                  value={bulkInputText}
                  onChange={e => {
                    setBulkInputText(e.target.value);
                    if (importStats) setImportStats(null);
                  }}
                  placeholder={`Employee Email,Supervisor,Process&#10;akshit@bergtechnologies.co.in,Mayank Semwal,HITL&#10;assessor.one@bergtechnologies.co.in,Harak Singh,OQC`}
                  className={`w-full text-xs p-4 font-mono border rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 shadow-inner ${
                    adminTheme === 'dark' ? 'bg-slate-905 border-slate-800 text-slate-100' : 'bg-slate-50 text-slate-800 border-slate-200'
                  }`}
                />

                {/* Report logs */}
                {importStats && (
                  <div className={`p-4 rounded-xl border animate-in fade-in slide-in-from-top-1 ${adminTheme === 'dark' ? 'bg-slate-900/50 border-slate-800' : 'bg-slate-55 border-slate-200'}`}>
                    <h5 className="text-xs font-black uppercase tracking-tight flex items-center gap-1.5 text-slate-700 dark:text-slate-300 mb-3">
                      <Check size={14} className="text-emerald-500 bg-emerald-500/15 p-0.5 rounded-full" /> CSV Alignment Verification Report
                    </h5>
                    <div className="grid grid-cols-3 gap-4 text-xs font-bold text-center mb-4">
                      <div className="p-2 bg-slate-905/20 border border-slate-800/20 rounded-lg">
                        <div className="text-slate-400 text-[9px] uppercase">Processed</div>
                        <div className="text-lg text-slate-700 dark:text-slate-250 font-black">{importStats.total}</div>
                      </div>
                      <div className="p-2 bg-emerald-500/5 border border-emerald-500/10 rounded-lg">
                        <div className="text-emerald-500 text-[9px] uppercase">Aligned Users</div>
                        <div className="text-lg text-emerald-500 font-bold">{importStats.resolved}</div>
                      </div>
                      <div className="p-2 bg-rose-500/5 border border-rose-500/10 rounded-lg">
                        <div className="text-rose-500 text-[9px] uppercase">Skipped</div>
                        <div className="text-lg text-rose-500 font-bold">{importStats.failed}</div>
                      </div>
                    </div>

                    {importStats.updates.length > 0 && (
                      <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                        <div className="text-[10px] font-bold text-slate-450 uppercase flex items-center gap-1"><AlertCircle size={11} className="text-rose-455" /> Skipped Rows Breakdown:</div>
                        {importStats.updates.map((err, idx) => (
                          <div key={`${err.rowIndex}_${err.row.email || err.row.name || ''}_${idx}`} className="flex justify-between items-center text-[10px] bg-red-500/5 border border-red-500/10 p-1.5 rounded text-rose-400">
                            <span>Row {err.rowIndex}: <strong className="font-mono">{err.row.email || err.row.name || 'unidentified'}</strong></span>
                            <span>{err.reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Action commands right rail */}
              <div className={`p-5 rounded-2xl flex flex-col justify-between shadow-sm border ${adminTheme === 'dark' ? 'bg-slate-900/50 border-slate-800' : 'bg-slate-50 border-slate-150'}`}>
                <div className="space-y-4">
                  <div>
                    <h4 className="text-xs font-black uppercase tracking-wider text-slate-500 mb-2">1. Download Template</h4>
                    <p className="text-[11px] text-slate-400 mb-3.5 leading-relaxed">
                      Download your current roster including active process configurations and direct hierarchy structures to modify in Excel/Google Sheets.
                    </p>
                    <button
                      onClick={handleExportCSV}
                      className="w-full py-2 bg-indigo-500/10 hover:bg-indigo-500/15 text-indigo-400 border border-indigo-500/20 font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer hover:scale-[1.015]"
                    >
                      <Download size={14} /> Export Current Mappings (CSV)
                    </button>
                  </div>

                  <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                    <h4 className="text-xs font-black uppercase tracking-wider text-slate-500 mb-2">2. Execute Import Mapping</h4>
                    <p className="text-[11px] text-slate-400 leading-relaxed mb-1">
                      Pressing align will parse the CSV and write updates instantly into:
                    </p>
                    <ul className="text-[10px] text-slate-500 font-mono list-disc pl-4 space-y-0.5">
                      <li>• Firebase Users Directory</li>
                      <li>• Team Mappings snapshot</li>
                      <li>• Master Headcount listings</li>
                    </ul>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                  <button
                    onClick={handleCSVImportAlignments}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl flex justify-center items-center gap-1.5 shadow-md cursor-pointer transition-all hover:scale-[1.01]"
                  >
                    Validate & Align in Bulk <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
