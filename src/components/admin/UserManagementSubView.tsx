import React, { useState, useMemo, useEffect } from 'react';
import { 
  Search, 
  UserPlus, 
  Trash2, 
  FileDown, 
  Upload, 
  Check, 
  X, 
  ArrowUpDown, 
  CheckSquare, 
  Square, 
  Edit3, 
  Users, 
  FileText,
  Clock,
  ExternalLink,
  RefreshCw
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { doc, setDoc, deleteDoc, writeBatch, collection, getDocs, getDoc } from 'firebase/firestore';
import { UserRole, UserProfile } from '../../types';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { UserPicker } from '../UserPicker';

interface UserManagementSubViewProps {
  allUsers: any[];
  adminTheme: 'light' | 'dark';
  onRefresh: () => void;
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export const UserManagementSubView: React.FC<UserManagementSubViewProps> = ({ 
  allUsers, 
  adminTheme, 
  onRefresh, 
  logAdminEvent 
}) => {
  // Filters & State
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [procFilter, setProcFilter] = useState('');
  
  // Table Sorting
  const [sortBy, setSortBy] = useState<string>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  
  // Selection
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());

  // Pagination
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(10);

  // Modals & Forms
  const [isNewUserOpen, setIsNewUserOpen] = useState(false);
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [isNotesOpen, setIsNotesOpen] = useState<any>(null); // holds user object to edit notes
  const [editingNotes, setEditingNotes] = useState('');

  // Edit form states
  const [isEditUserOpen, setIsEditUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [editForm, setEditForm] = useState({
    employeeId: '',
    name: '',
    role: 'AGENT' as UserRole,
    department: 'Operations',
    process: '',
    dateJoined: '',
    notes: '',
    teamLeadName: '',
    teamLeadUid: '',
    mappedManagerName: '',
    mappedManagerUid: '',
    status: 'Active'
  });

  const [newForm, setNewForm] = useState({
    employeeId: '',
    name: '',
    email: '',
    role: 'AGENT' as UserRole,
    department: 'Operations',
    process: '',
    dateJoined: new Date().toISOString().slice(0, 10),
    notes: '',
    teamLeadName: '',
    teamLeadUid: '',
    mappedManagerName: '',
    mappedManagerUid: '',
    status: 'Active',
    password: 'Password360@'
  });

  // Compute normalizedUsers
  const normalizedUsers = useMemo(() => {
    return allUsers.map(u => ({
      ...u,
      uid: u.uid || u.id || u.employeeId,
      name: u.fullName || u.name || u.employeeName || '',
      fullName: u.fullName || u.name || u.employeeName || '',
      mappedManagerName: u.mappedManagerName || u.managerName || u.Manager || '',
      teamLeadName: u.teamLeadName || '',
    }));
  }, [allUsers]);

  // Filter and Sort implementation
  const filteredUsers = useMemo(() => {
    return normalizedUsers.filter(u => {
      // search
      const q = searchTerm.toLowerCase();
      const matchSearch = 
        (u.name || '').toLowerCase().includes(q) ||
        (u.fullName || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.employeeId || '').toLowerCase().includes(q);
      
      const matchRole = !roleFilter ? true : (() => {
        const userRole = (u.role || '').toUpperCase().trim();
        const filterRole = roleFilter.toUpperCase().trim();
        
        if (filterRole === 'TEAM_LEAD' || filterRole === 'TEAM LEAD') {
          return ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TEAM LEAD', 'TRAINER_TL', 'TRAINER TL', 'OPS TL'].includes(userRole);
        }
        
        return userRole === filterRole;
      })();
      const matchStatus = statusFilter 
        ? (statusFilter === 'Active' ? (u.status?.toLowerCase() === 'active' || u.isActive === true) : (u.status?.toLowerCase() !== 'active' && u.isActive !== true)) 
        : true;
      const matchDept = deptFilter ? (u.department || 'Operations') === deptFilter : true;
      const matchProc = procFilter ? u.process === procFilter : true;

      return matchSearch && matchRole && matchStatus && matchDept && matchProc;
    }).sort((a, b) => {
      let fieldA = (sortBy === 'name' ? (a.fullName || a.name || '') : (a[sortBy] || ''));
      let fieldB = (sortBy === 'name' ? (b.fullName || b.name || '') : (b[sortBy] || ''));

      if (typeof fieldA === 'string') fieldA = fieldA.toLowerCase();
      if (typeof fieldB === 'string') fieldB = fieldB.toLowerCase();

      if (fieldA < fieldB) return sortOrder === 'asc' ? -1 : 1;
      if (fieldA > fieldB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
  }, [normalizedUsers, searchTerm, roleFilter, statusFilter, deptFilter, procFilter, sortBy, sortOrder]);

  const [registeredProcesses, setRegisteredProcesses] = useState<string[]>([]);

  useEffect(() => {
    const fetchRegisteredProcesses = async () => {
      try {
        const snap = await getDoc(doc(db, 'config', 'tmsProcesses'));
        let list: string[] = [];
        if (snap.exists() && Array.isArray(snap.data()?.list)) {
          list = snap.data()?.list;
        }
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

  const departments = useMemo(() => {
    const s = new Set<string>();
    allUsers.forEach(u => u.department && s.add(u.department));
    return Array.from(s);
  }, [allUsers]);

  const processes = useMemo(() => {
    const s = new Set<string>();
    allUsers.forEach(u => u.process && s.add(u.process));
    registeredProcesses.forEach(p => s.add(p));
    return Array.from(s);
  }, [allUsers, registeredProcesses]);

  // Paginated View
  const paginatedUsers = useMemo(() => {
    const start = page * perPage;
    return filteredUsers.slice(start, start + perPage);
  }, [filteredUsers, page, perPage]);

  const totalPages = Math.ceil(filteredUsers.length / perPage);

  // Sorting Header handle
  const handleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
  };

  // Selection toggle
  const toggleSelectAll = () => {
    if (selectedUids.size === paginatedUsers.length) {
      setSelectedUids(new Set());
    } else {
      const news = new Set<string>();
      paginatedUsers.forEach(u => news.add(u.uid));
      setSelectedUids(news);
    }
  };

  const toggleSelect = (uid: string) => {
    const news = new Set(selectedUids);
    if (news.has(uid)) {
      news.delete(uid);
    } else {
      news.add(uid);
    }
    setSelectedUids(news);
  };

  // Status toggle handler
  const handleToggleStatus = async (user: any) => {
    const currentStatus = user.status?.toLowerCase() === 'active' || user.isActive === true;
    const nextStatus = currentStatus ? 'Inactive' : 'Active';
    try {
      await setDoc(doc(db, 'users', user.uid), {
        ...user,
        status: nextStatus,
        isActive: !currentStatus,
        lastModifiedAt: new Date().toISOString()
      });
      await setDoc(doc(db, 'employee_master', user.uid), {
        status: nextStatus,
        lastUpdated: new Date().toISOString()
      }, { merge: true });
      toast.success(`User '${user.name || user.fullName}' status modified to ${nextStatus}.`);
      logAdminEvent('User Status Checked', user.email, currentStatus ? 'Active' : 'Inactive', nextStatus);
      onRefresh();
    } catch (err) {
      toast.error('Could not overwrite status.');
    }
  };

  // Bulk Actions
  const handleBulkStatusChange = async (target: 'Active' | 'Inactive') => {
    if (selectedUids.size === 0) {
      toast.error('Please select at least one user.');
      return;
    }
    try {
      const batch = writeBatch(db);
      const list = normalizedUsers.filter(u => selectedUids.has(u.uid));
      list.forEach(u => {
        batch.set(doc(db, 'users', u.uid), {
          ...u,
          status: target,
          isActive: target === 'Active',
          lastModifiedAt: new Date().toISOString()
        });
        batch.set(doc(db, 'employee_master', u.uid), {
          status: target,
          lastUpdated: new Date().toISOString()
        }, { merge: true });
      });
      await batch.commit();
      toast.success(`Broadened status to ${target} for ${selectedUids.size} team profiles.`);
      logAdminEvent('Bulk Status Modification', `${selectedUids.size} profiles`, 'Mixed', target);
      setSelectedUids(new Set());
      onRefresh();
    } catch (err) {
      toast.error('Bulk update write aborted.');
    }
  };

  // Single Delete
  const handleDeleteUser = async (uid: string, name: string) => {
    if (!window.confirm(`Are you absolutely sure you want to delete profile for ${name}? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, 'users', uid));
      await deleteDoc(doc(db, 'employee_master', uid));
      toast.success(`Profile for '${name}' deleted successfully.`);
      logAdminEvent('Profile Terminated', name, 'Active Document', 'DeletedDoc');
      onRefresh();
    } catch (err) {
      toast.error('Deletion operation denied.');
    }
  };

  // Exports
  const handleExportExcel = () => {
    const format = filteredUsers.map(u => ({
      'Employee ID': u.employeeId || 'N/A',
      'Display Name': u.fullName || u.name || 'N/A',
      'Email ID': u.email || 'N/A',
      'User Role': u.role || 'N/A',
      'Department Name': u.department || 'Operations',
      'Enterprise Process': u.process || 'N/A',
      'Team Lead': u.teamLeadName || 'N/A',
      'Manager Name': u.mappedManagerName || u.Manager || 'N/A',
      'Joined Date': u.dateJoined || 'N/A',
      'Account State': (u.status?.toLowerCase() === 'active' || u.isActive === true) ? 'Active' : 'Inactive',
      'Last Login': u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : (u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never'),
      'Employee Notes': u.notes || ''
    }));

    const ws = XLSX.utils.json_to_sheet(format);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Roster Directory');
    XLSX.writeFile(wb, 'Precision365_Profiles.xlsx');
    toast.success('Roster Sheet compiled and downloaded.');
  };

  const handleExportCSV = () => {
    const headers = ['Employee ID', 'Employee Name', 'Email ID', 'User Role', 'Department Name', 'Enterprise Process', 'Team Lead', 'Manager Name', 'Joined Date', 'Account State', 'Last Login', 'Employee Notes'];
    const rows = filteredUsers.map(u => [
      u.employeeId || 'N/A',
      u.fullName || u.name || 'N/A',
      u.email || 'N/A',
      u.role || 'N/A',
      u.department || 'Operations',
      u.process || 'N/A',
      u.teamLeadName || 'N/A',
      u.mappedManagerName || u.Manager || 'N/A',
      u.dateJoined || 'N/A',
      (u.status?.toLowerCase() === 'active' || u.isActive === true) ? 'Active' : 'Inactive',
      u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : (u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never'),
      (u.notes || '').replace(/"/g, '""').replace(/\r?\n|\r/g, ' ')
    ]);

    const csvContent = "data:text/csv;charset=utf-8,\uFEFF" 
      + [headers.join(','), ...rows.map(e => e.map(val => `"${val}"`).join(','))].join('\n');
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "Precision365_Profiles.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Roster CSV compiled and downloaded.');
  };

  // Add User Submission
  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newForm.name || !newForm.email) {
      toast.error('Name and Email are required.');
      return;
    }

    try {
      // 1. Provision via custom server Auth creation
      const response = await fetch('/api/create-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionStorage.getItem('idToken') || ''}`
        },
        body: JSON.stringify({
          name: newForm.name,
          email: newForm.email,
          role: newForm.role,
          password: newForm.password
        })
      });

      if (!response.ok) {
        const errObj = await response.json();
        throw new Error(errObj.error || 'Server rejected user creation.');
      }

      const resData = await response.json();
      const generatedUid = resData.user.uid;

      // 2. Client write for advanced attributes (Employee ID, etc.)
      const finalProfile = {
        uid: generatedUid,
        email: newForm.email.toLowerCase().trim(),
        role: newForm.role,
        fullName: newForm.name,
        name: newForm.name,
        employeeId: newForm.employeeId,
        department: newForm.department,
        process: newForm.process,
        dateJoined: newForm.dateJoined,
        notes: newForm.notes,
        teamLeadName: newForm.teamLeadName,
        teamLeadUid: newForm.teamLeadUid,
        mappedManagerName: newForm.mappedManagerName,
        mappedManagerUid: newForm.mappedManagerUid,
        status: newForm.status || 'Active',
        isActive: (newForm.status || 'Active') === 'Active',
        createdAt: new Date().toISOString()
      };

      await setDoc(doc(db, 'users', generatedUid), finalProfile);

      const masterDoc = {
        employeeId: newForm.employeeId || '',
        employeeName: newForm.name || '',
        email: newForm.email.toLowerCase().trim(),
        role: newForm.role,
        department: newForm.department || 'Operations',
        process: newForm.process || '',
        teamLeadId: newForm.teamLeadUid || '',
        teamLeadName: newForm.teamLeadName || '',
        managerId: newForm.mappedManagerUid || '',
        managerName: newForm.mappedManagerName || '',
        status: newForm.status || 'Active',
        dateJoined: newForm.dateJoined || '',
        lastUpdated: new Date().toISOString()
      };
      await setDoc(doc(db, 'employee_master', generatedUid), masterDoc);

      toast.success(`Account for '${newForm.name}' successfully spawned.`);
      logAdminEvent('User Profile Spawned', newForm.email, '', JSON.stringify(finalProfile));
      setIsNewUserOpen(false);
      setNewForm({
        employeeId: '',
        name: '',
        email: '',
        role: 'AGENT' as UserRole,
        department: 'Operations',
        process: '',
        dateJoined: new Date().toISOString().slice(0, 10),
        notes: '',
        teamLeadName: '',
        mappedManagerName: '',
        password: 'Password360@'
      });
      onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Error occurred.');
    }
  };

  // Edit User Handlers
  const handleEditUserOpen = (user: any) => {
    setEditingUser(user);
    setEditForm({
      employeeId: user.employeeId || '',
      name: user.fullName || user.name || '',
      role: (user.role as UserRole) || 'AGENT',
      department: user.department || 'Operations',
      process: user.process || '',
      dateJoined: user.dateJoined || '',
      notes: user.notes || '',
      teamLeadName: user.teamLeadName || '',
      teamLeadUid: user.teamLeadUid || '',
      mappedManagerName: user.mappedManagerName || user.Manager || '',
      mappedManagerUid: user.mappedManagerUid || '',
      status: user.status || (user.isActive === false ? 'Inactive' : 'Active')
    });
    setIsEditUserOpen(true);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    if (!editForm.name) {
      toast.error('Name is required.');
      return;
    }

    try {
      const updatedProfile = {
        ...editingUser,
        employeeId: editForm.employeeId,
        name: editForm.name,
        fullName: editForm.name,
        role: editForm.role,
        department: editForm.department,
        process: editForm.process,
        dateJoined: editForm.dateJoined,
        notes: editForm.notes,
        teamLeadName: editForm.teamLeadName,
        teamLeadUid: editForm.teamLeadUid,
        mappedManagerName: editForm.mappedManagerName,
        mappedManagerUid: editForm.mappedManagerUid,
        status: editForm.status,
        isActive: editForm.status === 'Active',
        lastModifiedAt: new Date().toISOString()
      };

      await setDoc(doc(db, 'users', editingUser.uid), updatedProfile);

      const masterDoc = {
        employeeId: editForm.employeeId || '',
        employeeName: editForm.name || '',
        email: (editingUser.email || '').toLowerCase().trim(),
        role: editForm.role,
        department: editForm.department || 'Operations',
        process: editForm.process || '',
        teamLeadId: editForm.teamLeadUid || '',
        teamLeadName: editForm.teamLeadName || '',
        managerId: editForm.mappedManagerUid || '',
        managerName: editForm.mappedManagerName || '',
        status: editForm.status || 'Active',
        dateJoined: editForm.dateJoined || '',
        lastUpdated: new Date().toISOString()
      };
      await setDoc(doc(db, 'employee_master', editingUser.uid), masterDoc);

      toast.success(`Profile for '${editForm.name}' successfully updated.`);
      logAdminEvent(
        'User Profile Updated', 
        editingUser.email, 
        JSON.stringify(editingUser), 
        JSON.stringify(updatedProfile)
      );
      
      setIsEditUserOpen(false);
      setEditingUser(null);
      onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Error occurred while updating user.');
    }
  };

  // Offline parsing for bulk csv copy-paste
  const handleBulkImport = async () => {
    if (!bulkText.trim()) {
      toast.error('Please paste CSV raw string.');
      return;
    }
    const lines = bulkText.split('\n');
    let commitCount = 0;
    try {
      const batch = writeBatch(db);
      for (let line of lines) {
        if (!line.trim()) continue;
        const [empId, name, email, roleStr, dept, processStr, joinDate, notesStr] = line.split(',').map(s => s?.trim() || '');
        if (!email || !name) continue;

        // Generate safe document id or mock uid hash
        const parsedEmail = email.toLowerCase();
        const fakeUid = 'local_' + btoa(parsedEmail).replace(/=/g, '').slice(0,12);

        const profileDoc = {
          uid: fakeUid,
          employeeId: empId || '',
          name: name,
          fullName: name,
          email: parsedEmail,
          role: (roleStr as UserRole) || 'AGENT',
          department: dept || 'Operations',
          process: processStr || '',
          dateJoined: joinDate || new Date().toISOString().slice(0,10),
          notes: notesStr || '',
          status: 'Active',
          isActive: true,
          createdAt: new Date().toISOString()
        };

        batch.set(doc(db, 'users', fakeUid), profileDoc);

        const masterData = {
          employeeId: empId || '',
          employeeName: name,
          email: parsedEmail,
          role: (roleStr as UserRole) || 'AGENT',
          department: dept || 'Operations',
          process: processStr || '',
          teamLeadId: '',
          teamLeadName: '',
          managerId: '',
          managerName: '',
          status: 'Active',
          dateJoined: joinDate || new Date().toISOString().slice(0,10),
          lastUpdated: new Date().toISOString()
        };
        batch.set(doc(db, 'employee_master', fakeUid), masterData);
        commitCount++;
      }
      await batch.commit();
      toast.success(`Successfully initialized ${commitCount} agent directories.`);
      logAdminEvent('CSV Roster Upload', `${commitCount} batch entries`, 'Blank', 'Pre-authorized users');
      setIsBulkOpen(false);
      setBulkText('');
      onRefresh();
    } catch (err: any) {
      toast.error('CSV Import runtime parsing failed.');
    }
  };

  const handleNotesSave = async () => {
    if (!isNotesOpen) return;
    try {
      await setDoc(doc(db, 'users', isNotesOpen.uid), {
        ...isNotesOpen,
        notes: editingNotes,
        lastModifiedAt: new Date().toISOString()
      }, { merge: true });
      toast.success('Professional note mapped successfully.');
      setIsNotesOpen(null);
      onRefresh();
    } catch (err) {
      toast.error('Error updating note.');
    }
  };

  // Compute dynamic workforce statistics
  const stats = useMemo(() => {
    const total = allUsers.length;
    const active = allUsers.filter(u => u.status?.toLowerCase() === 'active' || u.isActive === true).length;
    const inactive = total - active;
    
    const counts: Record<string, number> = {
      ADMIN: 0,
      MANAGER: 0,
      ASSISTANT_MANAGER: 0,
      TEAM_LEAD: 0,
      SME: 0,
      TRAINER: 0,
      QA: 0,
      AGENT: 0
    };

    allUsers.forEach(u => {
      const role = (u.role || '').toUpperCase();
      // Normalize common variations to standard internal keys
      if (['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TEAM LEAD', 'TRAINER_TL', 'TRAINER TL'].includes(role)) {
        counts.TEAM_LEAD++;
      } else if (counts[role] !== undefined) {
        counts[role]++;
      } else if (role === 'QA') {
        counts.QA++;
      } else if (role === 'AGENT' || role === 'SME' || role === 'TRAINER') {
        if (role === 'SME') counts.SME++;
        else if (role === 'TRAINER') counts.TRAINER++;
        else counts.AGENT++;
      }
    });

    return { total, active, inactive, ...counts };
  }, [allUsers]);

  // Render variables
  const containerClass = adminTheme === 'dark' ? 'space-y-6 text-slate-100' : 'space-y-6 text-slate-800';
  const filterBg = adminTheme === 'dark' ? 'bg-slate-805 gap-4 p-4 rounded-xl border border-slate-700/60' : 'bg-slate-100/50 gap-4 p-4 rounded-xl border border-slate-200/60';
  const inputClass = adminTheme === 'dark' 
    ? 'bg-slate-800 border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-slate-500 focus:outline-none w-full w-48' 
    : 'bg-white border-slate-200 text-slate-850 rounded-lg px-3 py-2 text-xs border focus:ring-1 focus:ring-slate-500 focus:outline-none w-full w-4a';
  const btnStyle = 'px-3 py-2 text-xs font-bold rounded-lg cursor-pointer flex items-center gap-1.5 transition-all text-white bg-indigo-600 hover:bg-indigo-700';

  return (
    <div className={containerClass}>
      
      {/* Workforce Analytics Summary Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-4">
        {/* Total Workforce */}
        <div className={`p-4 rounded-2xl border transition-all ${
          adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800/80 shadow-md' : 'bg-white border-slate-200 shadow-sm'
        }`}>
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Total Force</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-black text-indigo-500">{stats.total}</span>
            <span className="text-[10px] text-slate-400 font-bold">employees</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-1 flex gap-2">
            <span className="text-emerald-500">● {stats.active} Active</span>
            <span className="text-rose-500">● {stats.inactive} Inactive</span>
          </div>
        </div>

        {/* Support Staff Roles */}
        <div className={`p-4 rounded-2xl border transition-all ${
          adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800/80 shadow-md' : 'bg-white border-slate-200 shadow-sm'
        }`}>
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Admins / Managers</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-black text-indigo-400">{stats.ADMIN + stats.MANAGER + stats.ASSISTANT_MANAGER}</span>
            <span className="text-[10px] text-slate-400 font-bold">profiles</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-1 flex flex-wrap gap-1">
            <span>{stats.ADMIN} Adm •</span>
            <span>{stats.MANAGER} Mgr •</span>
            <span>{stats.ASSISTANT_MANAGER} AM</span>
          </div>
        </div>

        {/* Team Leads Core count */}
        <div className={`p-4 rounded-2xl border transition-all ${
          adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800/80 shadow-md' : 'bg-white border-slate-200 shadow-sm'
        }`}>
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Team Leads (TL)</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-2xl font-black text-amber-500">{stats.TEAM_LEAD}</span>
            <span className="text-[10px] text-slate-400 font-bold">leaders</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-1">
            Direct team supervisor matrices.
          </div>
        </div>

        {/* Quality and Training Support */}
        <div className={`p-4 rounded-2xl border transition-all ${
          adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800/80 shadow-md' : 'bg-white border-slate-200 shadow-sm'
        }`}>
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">SME / trainers / QA</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-2xl font-black text-emerald-500">{stats.SME + stats.TRAINER + stats.QA}</span>
            <span className="text-[10px] text-slate-400 font-bold">specialists</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-1 flex flex-wrap gap-1">
            <span>{stats.SME} SME •</span>
            <span>{stats.TRAINER} Trn •</span>
            <span>{stats.QA} QA</span>
          </div>
        </div>

        {/* Frontline Agents */}
        <div className={`p-4 rounded-2xl border transition-all col-span-2 sm:col-span-1 ${
          adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800/80 shadow-md' : 'bg-white border-slate-200 shadow-sm'
        }`}>
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Frontline Agents</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-2xl font-black text-sky-500">{stats.AGENT}</span>
            <span className="text-[10px] text-slate-400 font-bold">agents</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-1">
            Frontline production directory.
          </div>
        </div>
      </div>
      
      {/* Search and Filters Segment */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="relative flex-grow max-w-md">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input 
              placeholder="Search by ID, email, or employee name..." 
              value={searchTerm}
              onChange={e => { setSearchTerm(e.target.value); setPage(0); }}
              className={adminTheme === 'dark' 
                ? 'pl-10 w-full bg-slate-800 border-slate-700 text-slate-200 rounded-xl px-4 py-2 text-xs border focus:ring-1 focus:ring-indigo-500' 
                : 'pl-10 w-full bg-white border-slate-250 text-slate-800 rounded-xl px-4 py-2 text-xs border focus:ring-1 focus:ring-indigo-500'}
            />
          </div>
          
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setIsNewUserOpen(true)} className={btnStyle}>
              <UserPlus size={14} /> Add Human Resource
            </button>
            <button onClick={() => setIsBulkOpen(true)} className="px-3 py-2 text-xs font-bold rounded-lg cursor-pointer bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5 ">
              <Upload size={14} /> Paste CSV Group
            </button>
            <button onClick={handleExportExcel} className="px-3 py-2 text-xs font-bold rounded-lg cursor-pointer bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1.5">
              <FileDown size={14} /> Excel Export
            </button>
            <button onClick={handleExportCSV} className="px-3 py-2 text-xs font-bold rounded-lg cursor-pointer bg-sky-600 hover:bg-sky-700 text-white flex items-center gap-1.5">
              <FileDown size={14} /> CSV Export
            </button>
          </div>
        </div>

        {/* Filters Matrix */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-200 dark:bg-slate-800/40 dark:border-slate-700/60">
          <div>
            <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Company Role</label>
            <select 
              value={roleFilter} 
              onChange={e => { setRoleFilter(e.target.value); setPage(0); }} 
              className={adminTheme === 'dark' ? 'w-full bg-slate-800 text-xs px-2 py-1.5 rounded-lg border border-slate-700' : 'w-full bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-200'}
            >
              <option value="">All Roles</option>
              {Object.keys(UserRole).map(role => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          </div>
          
          <div>
            <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Account State</label>
            <select 
              value={statusFilter} 
              onChange={e => { setStatusFilter(e.target.value); setPage(0); }} 
              className={adminTheme === 'dark' ? 'w-full bg-slate-800 text-xs px-2 py-1.5 rounded-lg border border-slate-700' : 'w-full bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-200'}
            >
              <option value="">All States</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Operational Division</label>
            <select 
              value={deptFilter} 
              onChange={e => { setDeptFilter(e.target.value); setPage(0); }} 
              className={adminTheme === 'dark' ? 'w-full bg-slate-800 text-xs px-2 py-1.5 rounded-lg border border-slate-700' : 'w-full bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-200'}
            >
              <option value="">All Divisions</option>
              {departments.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Assigned Process</label>
            <select 
              value={procFilter} 
              onChange={e => { setProcFilter(e.target.value); setPage(0); }} 
              className={adminTheme === 'dark' ? 'w-full bg-slate-800 text-xs px-2 py-1.5 rounded-lg border border-slate-700' : 'w-full bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-200'}
            >
              <option value="">All Processes</option>
              {processes.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Bulk Status Utilities */}
      {selectedUids.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-indigo-500/10 border border-indigo-400/40 rounded-xl text-xs font-semibold">
          <CheckSquare size={16} className="text-indigo-500" />
          <span>Selected {selectedUids.size} profiles. Execute Bulk State:</span>
          <button onClick={() => handleBulkStatusChange('Active')} className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer">Set Active</button>
          <button onClick={() => handleBulkStatusChange('Inactive')} className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-bold cursor-pointer">Set Inactive</button>
        </div>
      )}

      {/* Directory Table Grid */}
      <div className={`overflow-hidden border rounded-2xl ${adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className={adminTheme === 'dark' ? 'bg-slate-800 text-slate-300 font-bold uppercase text-[10px]' : 'bg-slate-50 text-slate-500 font-bold uppercase text-[10px]'}>
              <tr>
                <th className="p-4 w-10 text-center">
                  <button onClick={toggleSelectAll} className="p-0.5 text-slate-400">
                    {selectedUids.size === paginatedUsers.length && paginatedUsers.length > 0 ? (
                      <CheckSquare size={15} className="text-indigo-500" />
                    ) : (
                      <Square size={15} />
                    )}
                  </button>
                </th>
                <th className="p-4 font-bold cursor-pointer transition-colors" onClick={() => handleSort('employeeId')}>
                  <span className="flex items-center gap-1">Employee ID <ArrowUpDown size={11} /></span>
                </th>
                <th className="p-4 font-bold cursor-pointer transition-colors" onClick={() => handleSort('name')}>
                  <span className="flex items-center gap-1">Employee Name <ArrowUpDown size={11} /></span>
                </th>
                <th className="p-4 font-bold">Email</th>
                <th className="p-4 font-bold">Role</th>
                <th className="p-4 font-bold">Division</th>
                <th className="p-4 font-bold">Process</th>
                <th className="p-4 font-bold">Team Lead</th>
                <th className="p-4 font-bold">Manager</th>
                <th className="p-4 font-bold cursor-pointer text-center" onClick={() => handleSort('dateJoined')}>
                  <span className="flex items-center gap-1 justify-center">Join Date <ArrowUpDown size={11} /></span>
                </th>
                <th className="p-4 text-center">Last Login</th>
                <th className="p-4 text-center">Active Status</th>
                <th className="p-4 text-center">Files / Notes</th>
                <th className="p-4 text-right pr-6">Manage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {paginatedUsers.length > 0 ? (
                paginatedUsers.map(user => {
                  const isActive = user.status?.toLowerCase() === 'active' || user.isActive === true;
                  const isChecked = selectedUids.has(user.uid);
                  return (
                    <tr key={user.uid} className={adminTheme === 'dark' ? 'hover:bg-slate-800/30' : 'hover:bg-slate-50/50'}>
                      <td className="p-4 text-center">
                        <button onClick={() => toggleSelect(user.uid)} className="p-0.5 text-slate-400">
                          {isChecked ? <CheckSquare size={15} className="text-indigo-500" /> : <Square size={15} />}
                        </button>
                      </td>
                      <td className="p-4 font-mono font-bold">{user.employeeId || 'E-N/A'}</td>
                      <td className="p-4 font-extrabold">{user.fullName || user.name}</td>
                      <td className="p-4 text-slate-400 dark:text-slate-500 font-semibold">{user.email}</td>
                      <td className="p-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          ['ADMIN'].includes(user.role.toUpperCase()) ? 'bg-red-500/10 text-red-500' :
                          ['MANAGER', 'ASSISTANT_MANAGER'].includes(user.role.toUpperCase()) ? 'bg-indigo-500/10 text-indigo-500' :
                          ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TEAM LEAD'].includes(user.role.toUpperCase()) ? 'bg-amber-500/10 text-amber-500' :
                          user.role.toUpperCase() === 'QA' ? 'bg-blue-500/10 text-blue-500' : 'bg-emerald-500/10 text-emerald-500'
                        }`}>
                          {user.role}
                        </span>
                      </td>
                      <td className="p-4 font-medium opacity-85">{user.department || 'Operations'}</td>
                      <td className="p-4 font-mono font-bold opacity-85">{user.process || 'Commonpool'}</td>
                      <td className="p-4 font-medium text-slate-500 dark:text-slate-400">{user.teamLeadName || 'N/A'}</td>
                      <td className="p-4 font-medium text-slate-500 dark:text-slate-400">{user.mappedManagerName || user.Manager || 'N/A'}</td>
                      <td className="p-4 text-center opacity-75">{user.dateJoined || 'N/A'}</td>
                      <td className="p-4 text-center text-slate-400 dark:text-slate-500 font-medium">
                        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : (user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : 'Never')}
                      </td>
                      
                      {/* Active Status Toggle */}
                      <td className="p-4 text-center">
                        <button 
                          onClick={() => handleToggleStatus(user)}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            isActive ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'
                          }`}
                        >
                          <span 
                            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              isActive ? 'translate-x-4' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </td>

                      {/* Notes Button trigger */}
                      <td className="p-4 text-center">
                        <button 
                          onClick={() => { setIsNotesOpen(user); setEditingNotes(user.notes || ''); }}
                          className={`p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer ${user.notes ? 'text-indigo-500' : 'text-slate-400'}`}
                          title={user.notes || 'No comments'}
                        >
                          <FileText size={15} />
                        </button>
                      </td>

                      <td className="p-4 text-right pr-6">
                        <div className="flex items-center justify-end gap-1.5">
                          <button 
                            onClick={() => handleEditUserOpen(user)}
                            className="p-1.5 text-slate-400 hover:text-indigo-500 hover:bg-indigo-500/10 rounded-lg transition-colors cursor-pointer"
                            title="Edit User Profile"
                          >
                            <Edit3 size={14} />
                          </button>
                          <button 
                            onClick={() => handleDeleteUser(user.uid, user.fullName || user.name)}
                            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
                            title="Delete User"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={14} className="p-12 text-center text-slate-400 font-semibold text-xs animate-pulse">
                    No results matched the specified query options. Expand searches or clear state toggles.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Traditional pagination */}
        {totalPages > 1 && (
          <div className={`flex items-center justify-between p-4 border-t ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            <span className="text-slate-400 font-medium">Page {page + 1} of {totalPages} ({filteredUsers.length} total users)</span>
            <div className="flex gap-1">
              <button 
                disabled={page === 0} 
                onClick={() => setPage(page - 1)}
                className="px-3 py-1 rounded bg-white hover:bg-slate-55 shadow border dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300 disabled:opacity-40 cursor-pointer"
              >
                Prev
              </button>
              <button 
                disabled={page >= totalPages - 1} 
                onClick={() => setPage(page + 1)}
                className="px-3 py-1 rounded bg-white hover:bg-slate-55 shadow border dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300 disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Edit Notes Modal */}
      {isNotesOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`max-w-md w-full border shadow-2xl rounded-2xl overflow-hidden p-6 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <h4 className="text-sm font-extrabold uppercase tracking-wider mb-2">Personnel Folder Notes</h4>
            <p className="text-xs text-slate-400 mb-4 font-mono">Profile: {isNotesOpen.fullName || isNotesOpen.name} ({isNotesOpen.email})</p>
            <textarea 
              rows={4} 
              value={editingNotes}
              onChange={e => setEditingNotes(e.target.value)}
              placeholder="Input specialized team remarks, system overrides, HR tags..."
              className={`w-full text-xs p-3 border rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 ${adminTheme === 'dark' ? 'bg-slate-900 border-slate-700' : 'bg-slate-50'}`}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setIsNotesOpen(null)} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 cursor-pointer">Cancel</button>
              <button onClick={handleNotesSave} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer">Save Employee Remark</button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Resource Addition Modal */}
      {isNewUserOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form 
            onSubmit={handleAddSubmit} 
            className={`max-w-md w-full border shadow-2xl rounded-2xl p-6 space-y-4 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
          >
            <div className="flex justify-between items-center border-b pb-2">
              <h4 className="text-sm font-extrabold uppercase tracking-wide">Pre-Provision Enterprise Account</h4>
              <button type="button" onClick={() => setIsNewUserOpen(false)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Employee ID</label>
                <input 
                  required 
                  value={newForm.employeeId} 
                  onChange={e => setNewForm({...newForm, employeeId: e.target.value})} 
                  placeholder="e.g. BT-908" 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Full Name</label>
                <input 
                  required 
                  value={newForm.name} 
                  onChange={e => setNewForm({...newForm, name: e.target.value})} 
                  placeholder="e.g. Aaryan Gurung" 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>

              <div className="col-span-2">
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Email (Unique identifier)</label>
                <input 
                  required 
                  type="email"
                  value={newForm.email} 
                  onChange={e => {
                    const emailVal = e.target.value;
                    let nextName = newForm.name;
                    
                    const oldAutoPicked = newForm.email && newForm.email.includes('@') ? (() => {
                      const part = newForm.email.split('@')[0];
                      return part.split(/[\._\-]/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                    })() : '';

                    if (!newForm.name || newForm.name.trim() === '' || newForm.name.trim() === oldAutoPicked) {
                      if (emailVal.includes('@')) {
                        const localPart = emailVal.split('@')[0];
                        if (localPart) {
                          nextName = localPart
                            .split(/[\._\-]/)
                            .filter(Boolean)
                            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                            .join(' ');
                        }
                      } else {
                        nextName = emailVal
                          .split(/[\._\-]/)
                          .filter(Boolean)
                          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                          .join(' ');
                      }
                    }
                    setNewForm({...newForm, email: emailVal, name: nextName});
                  }} 
                  placeholder="e.g. satyen.vaishnavi@bergtechnologies.co.in" 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">System Role</label>
                <select 
                  value={newForm.role} 
                  onChange={e => setNewForm({...newForm, role: e.target.value as UserRole})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg text-slate-350' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650'}
                >
                  {Object.keys(UserRole).map(role => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Primary Division</label>
                <input 
                  value={newForm.department} 
                  onChange={e => setNewForm({...newForm, department: e.target.value})} 
                  placeholder="e.g. Quality Assurance" 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Product Campaign / Process</label>
                <select 
                  value={newForm.process} 
                  onChange={e => setNewForm({...newForm, process: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg text-slate-350 text-xs' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650 text-xs'}
                >
                  <option value="">Select Process / Campaign...</option>
                  {processes.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5 uppercase tracking-widest pl-1">Team Lead</label>
                <UserPicker 
                  onSelect={(u) => setNewForm({...newForm, teamLeadName: u.fullName || u.name, teamLeadUid: u.uid})}
                  selectedUserId={newForm.teamLeadUid}
                  placeholder="Map Team Lead..."
                  roleFilter={['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'TEAM LEAD', 'MANAGER', 'ADMIN']}
                  className="mt-1"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5 uppercase tracking-widest pl-1">Mapped Manager</label>
                <UserPicker 
                  onSelect={(u) => setNewForm({...newForm, mappedManagerName: u.fullName || u.name, mappedManagerUid: u.uid})}
                  selectedUserId={newForm.mappedManagerUid}
                  placeholder="Map Manager..."
                  roleFilter={[UserRole.MANAGER, UserRole.ADMIN]}
                  className="mt-1"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Joining Date</label>
                <input 
                  type="date"
                  value={newForm.dateJoined} 
                  onChange={e => setNewForm({...newForm, dateJoined: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Account Status</label>
                <select 
                  value={newForm.status} 
                  onChange={e => setNewForm({...newForm, status: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg text-slate-350' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650'}
                >
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>

              <div className="col-span-2">
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Temporary Default Password</label>
                <input 
                  required 
                  value={newForm.password} 
                  onChange={e => setNewForm({...newForm, password: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs border-t pt-3">
              <button type="button" onClick={() => setIsNewUserOpen(false)} className="px-3 py-1.5 font-bold rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 cursor-pointer">Cancel</button>
              <button type="submit" className="px-3 py-1.5 font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer">Create Active Profile</button>
            </div>
          </form>
        </div>
      )}

      {/* Edit User Profile Modal */}
      {isEditUserOpen && editingUser && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form 
            onSubmit={handleEditSubmit} 
            className={`max-w-md w-full border shadow-2xl rounded-2xl p-6 space-y-4 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
          >
            <div className="flex justify-between items-center border-b pb-2">
              <h4 className="text-sm font-extrabold uppercase tracking-wide">Edit Enterprise Account</h4>
              <button type="button" onClick={() => setIsEditUserOpen(false)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Employee ID</label>
                <input 
                  required 
                  value={editForm.employeeId} 
                  onChange={e => setEditForm({...editForm, employeeId: e.target.value})} 
                  placeholder="e.g. BT-908" 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Full Name</label>
                <input 
                  required 
                  value={editForm.name} 
                  onChange={e => setEditForm({...editForm, name: e.target.value})} 
                  placeholder="e.g. Aaryan Gurung" 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>

              <div className="col-span-2">
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Email (Identifier, Read-Only)</label>
                <input 
                  disabled
                  type="email"
                  value={editingUser.email} 
                  className="w-full bg-slate-100 dark:bg-slate-900/60 p-2 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-400 cursor-not-allowed font-medium"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">System Role</label>
                <select 
                  value={editForm.role} 
                  onChange={e => setEditForm({...editForm, role: e.target.value as UserRole})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg text-slate-350' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650'}
                >
                  {Object.keys(UserRole).map(role => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Primary Division</label>
                <input 
                  value={editForm.department} 
                  onChange={e => setEditForm({...editForm, department: e.target.value})} 
                  placeholder="e.g. Quality Assurance" 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Product Campaign / Process</label>
                <select 
                  value={editForm.process} 
                  onChange={e => setEditForm({...editForm, process: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg text-slate-350 text-xs' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650 text-xs'}
                >
                  <option value="">Select Process / Campaign...</option>
                  {processes.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1 uppercase tracking-widest pl-1">Team Lead Mapping</label>
                <UserPicker 
                  onSelect={(u) => setEditForm({...editForm, teamLeadName: u.fullName || u.name, teamLeadUid: u.uid})}
                  selectedUserId={editForm.teamLeadUid}
                  placeholder="Reassign Team Lead..."
                  roleFilter={['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TRAINER_TL', 'TEAM LEAD', 'MANAGER', 'ADMIN']}
                  className="mt-1"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1 uppercase tracking-widest pl-1">Manager Mapping</label>
                <UserPicker 
                  onSelect={(u) => setEditForm({...editForm, mappedManagerName: u.fullName || u.name, mappedManagerUid: u.uid})}
                  selectedUserId={editForm.mappedManagerUid}
                  placeholder="Reassign Manager..."
                  roleFilter={[UserRole.MANAGER, UserRole.ADMIN]}
                  className="mt-1"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Joining Date</label>
                <input 
                  type="date"
                  value={editForm.dateJoined} 
                  onChange={e => setEditForm({...editForm, dateJoined: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Account Status</label>
                <select 
                  value={editForm.status} 
                  onChange={e => setEditForm({...editForm, status: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg text-slate-350' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650'}
                >
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>

              <div className="col-span-2">
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Personnel Notes / Remarks</label>
                <textarea 
                  rows={2}
                  value={editForm.notes} 
                  onChange={e => setEditForm({...editForm, notes: e.target.value})} 
                  placeholder="Employee description/notes" 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 rounded-lg'}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs border-t pt-3">
              <button type="button" onClick={() => setIsEditUserOpen(false)} className="px-3 py-1.5 font-bold rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 cursor-pointer text-xs">Cancel</button>
              <button type="submit" className="px-3 py-1.5 font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer text-xs">Save Changes</button>
            </div>
          </form>
        </div>
      )}

      {/* CSV Bulk uploader Clipboard dialog */}
      {isBulkOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`max-w-2xl w-full border shadow-2xl rounded-2xl p-6 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex justify-between items-center border-b pb-2 mb-4">
              <h4 className="text-sm font-extrabold uppercase tracking-wider">CSV Copy & Paste Batch Roster</h4>
              <button onClick={() => setIsBulkOpen(false)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>

            <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
              Accepts plain lines separation. Header format template: <br />
              <strong className="font-mono bg-slate-100 dark:bg-slate-900/60 p-1 rounded inline-block mt-1 text-indigo-400 select-all">
                EmployeeID, Name, Email, Role, Department, Process, DateJoined, Notes
              </strong>
            </p>

            <textarea 
              rows={8}
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
              placeholder="e.g.&#10;BT-901,Akshit Sodhi,akshit@bergtechnologies.co.in,QA,Operations,Vertical Core,2026-01-08,Senior Assessor"
              className={`w-full text-xs p-3 font-mono border rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 mb-4 ${adminTheme === 'dark' ? 'bg-slate-900 border-slate-700' : 'bg-slate-50'}`}
            />

            <div className="flex justify-between items-center text-xs">
              <span className="text-[10px] text-slate-400 font-mono">Double-check headers before triggering transaction writes.</span>
              <div className="flex gap-2">
                <button onClick={() => setIsBulkOpen(false)} className="px-3 py-1.5 font-bold rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 cursor-pointer">Cancel</button>
                <button onClick={handleBulkImport} className="px-3 py-1.5 font-bold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer">Trigger Import Batch</button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
