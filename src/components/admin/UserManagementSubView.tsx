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
  RefreshCw,
  AlertTriangle,
  Lock,
  Unlock,
  ShieldAlert,
  ShieldCheck,
  Shield,
  Ban,
  UserX
} from 'lucide-react';
import { db, auth, getDocsOptimized, getDocOptimized } from '../../lib/firebase';
import { doc, setDoc, deleteDoc, writeBatch, collection, getDocs, getDoc, updateDoc } from 'firebase/firestore';
import { UserRole, UserProfile } from '../../types';
import { isTLRole } from '../../lib/roles';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { UserPicker } from '../UserPicker';
import { useRoster } from '../../contexts/RosterContext';
import { safeStorage } from '../../lib/safeStorage';
import { buildAuthoritativeLookupMaps, normalizeHierarchyReference, getHierarchyPersistencePayload, isPlaceholderValue } from '../../lib/hierarchy';
import { appendInactiveReasonNote, appendActiveReasonNote, INACTIVE_REASON_PRESETS } from '../../utils/userNotes';
import { syncTargetUserClaims, batchSyncAllUserClaims } from '../../lib/claimsService';

export const RESTRICT_REASON_PRESETS = [
  'Security / Access Hold',
  'Device Offboarding',
  'Disciplinary / Investigation',
  'Contract Ended / Pending Exit',
  'Temporary Administrative Lockout',
  'Other / Custom'
];

// Robust CSV Line parser helper that supports dynamic separators and double quotes containing commas/delimiters
export function parseCSVLine(line: string): string[] {
  // Auto-detect delimiter for this specific line
  let delimiter = ',';
  if (line.includes('\t')) {
    delimiter = '\t';
  } else if (!line.includes(',') && line.includes(';')) {
    delimiter = ';';
  }

  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      let val = current.trim();
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      result.push(val);
      current = '';
    } else {
      current += char;
    }
  }
  let val = current.trim();
  if (val.startsWith('"') && val.endsWith('"')) {
    val = val.slice(1, -1);
  }
  result.push(val);
  return result;
}

// Full bulk text parser supporting flexible header matching, smart heuristics and format diagnostics
export function parseBulkCSVText(text: string): { 
  users: any[]; 
  errors: { lineNum: number; text: string; type: 'error' | 'warning'; message: string }[];
} {
  const users: any[] = [];
  const errors: { lineNum: number; text: string; type: 'error' | 'warning'; message: string }[] = [];
  const validRoles = ['ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'TEAM LEAD', 'TEAM_LEAD', 'SME', 'TRAINER', 'QA', 'AGENT'];

  if (!text || !text.trim()) {
    return { users, errors };
  }

  const lines = text.split(/\r?\n/);
  if (lines.length === 0) {
    return { users, errors };
  }

  // Detect delimiter based on sample lines
  let commaCount = 0;
  let tabCount = 0;
  let semiCount = 0;
  const sampleLines = lines.slice(0, 5).filter(l => l.trim());
  for (const line of sampleLines) {
    commaCount += (line.match(/,/g) || []).length;
    tabCount += (line.match(/\t/g) || []).length;
    semiCount += (line.match(/;/g) || []).length;
  }

  let delimiter = ',';
  if (tabCount > commaCount && tabCount > semiCount) {
    delimiter = '\t';
  } else if (semiCount > commaCount && semiCount > tabCount) {
    delimiter = ';';
  }

  const parseLineFields = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        let val = current.trim();
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        }
        result.push(val);
        current = '';
      } else {
        current += char;
      }
    }
    let val = current.trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    result.push(val);
    return result;
  };

  const parsedLines = lines.map(line => {
    let trimmed = line.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      const normalFields = parseLineFields(trimmed);
      if (normalFields.length === 1 && normalFields[0].includes(delimiter)) {
        trimmed = trimmed.slice(1, -1).trim();
      }
    }
    return trimmed;
  });

  const firstLineFields = parseLineFields(parsedLines[0] || '');
  const hasEmailHeader = firstLineFields.some(f => f.toLowerCase().includes('email') || f.toLowerCase().includes('mail'));
  const hasNameHeader = firstLineFields.some(f => f.toLowerCase().includes('name'));

  let emailIdx = -1;
  let nameIdx = -1;
  let empIdIdx = -1;
  let roleIdx = -1;
  let deptIdx = -1;
  let processIdx = -1;
  let dateJoinedIdx = -1;
  let notesIdx = -1;
  let teamLeadIdx = -1;
  let managerIdx = -1;
  let locationIdx = -1;

  let startIndex = 0;

  if (hasEmailHeader || hasNameHeader) {
    startIndex = 1;
    firstLineFields.forEach((field, idx) => {
      const lower = field.toLowerCase().trim();
      if (lower.includes('email') || lower.includes('mail')) {
        emailIdx = idx;
      } else if ((lower.includes('team lead') || lower.includes('teamlead') || lower.includes('lead') || lower.includes('tl')) && !lower.includes('manager')) {
        teamLeadIdx = idx;
      } else if (lower.includes('manager') || lower.includes('mgr')) {
        managerIdx = idx;
      } else if (lower.includes('location') || lower.includes('loc') || lower.includes('branch') || lower.includes('site') || lower.includes('city')) {
        locationIdx = idx;
      } else if (lower.includes('name')) {
        nameIdx = idx;
      } else if (lower.includes('id') || lower.includes('empid') || lower.includes('number') || lower.includes('uid')) {
        empIdIdx = idx;
      } else if (lower.includes('role') || lower.includes('designation') || lower.includes('type')) {
        roleIdx = idx;
      } else if (lower.includes('dept') || lower.includes('department') || lower.includes('division')) {
        deptIdx = idx;
      } else if (lower.includes('process') || lower.includes('project') || lower.includes('queue')) {
        processIdx = idx;
      } else if (lower.includes('date') || lower.includes('join') || lower.includes('hired') || lower.includes('doj') || lower.includes('d.o.j') || lower.includes('joining')) {
        dateJoinedIdx = idx;
      } else if (lower.includes('note') || lower.includes('comment') || lower.includes('desc')) {
        notesIdx = idx;
      }
    });
  }

  // Fallbacks if not detected or header is completely missing
  if (emailIdx === -1) emailIdx = 2;
  if (nameIdx === -1) nameIdx = 1;
  if (empIdIdx === -1) empIdIdx = 0;
  if (roleIdx === -1) roleIdx = 3;
  if (deptIdx === -1) deptIdx = 4;
  if (processIdx === -1) processIdx = 5;
  if (dateJoinedIdx === -1) dateJoinedIdx = 6;
  if (notesIdx === -1) notesIdx = 7;
  if (teamLeadIdx === -1) teamLeadIdx = 8;
  if (managerIdx === -1) managerIdx = 9;
  if (locationIdx === -1) locationIdx = 10;

  for (let i = startIndex; i < parsedLines.length; i++) {
    const line = parsedLines[i];
    if (!line.trim()) continue;

    const fields = parseLineFields(line);
    const lineNum = i + 1;

    const getField = (idx: number, def: string = ''): string => {
      if (idx >= 0 && idx < fields.length) {
        return fields[idx].trim();
      }
      return def;
    };

    let email = getField(emailIdx);
    let name = getField(nameIdx);
    const empId = getField(empIdIdx);
    const roleStr = getField(roleIdx);
    const dept = getField(deptIdx);
    const processStr = getField(processIdx);
    const joinDate = getField(dateJoinedIdx);
    const notesStr = getField(notesIdx);
    const teamLeadRaw = getField(teamLeadIdx);
    const mngrRaw = getField(managerIdx);
    const locationStr = getField(locationIdx);

    // Heuristics: if email column contains no @, try to find one in the row
    if (!email || !email.includes('@')) {
      const emailRegex = /[^\s@]+@[^\s@]+\.[^\s@]+/;
      const idx = fields.findIndex(f => emailRegex.test(f));
      if (idx !== -1) {
        email = fields[idx].trim();
        if (!name) {
          const nameFieldIdx = fields.findIndex((f, fIdx) => fIdx !== idx && f.trim().length > 1 && isNaN(Number(f)));
          if (nameFieldIdx !== -1) {
            name = fields[nameFieldIdx].trim();
          }
        }
      }
    }

    if (!email && !name) continue;
    if (email.toLowerCase() === 'email' && name.toLowerCase() === 'name') continue;

    if (!name) {
      errors.push({
        lineNum,
        text: line,
        type: 'error',
        message: 'Name is missing'
      });
      continue;
    }

    if (!email) {
      errors.push({
        lineNum,
        text: line,
        type: 'error',
        message: 'Email address is missing'
      });
      continue;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      errors.push({
        lineNum,
        text: line,
        type: 'error',
        message: `Invalid email address format: "${email}"`
      });
      continue;
    }

    let finalRoleStr = roleStr || 'AGENT';
    if (roleStr) {
      const upper = roleStr.toUpperCase().trim();
      if (upper === 'TEAM_LEAD' || upper === 'TEAM LEAD') {
        finalRoleStr = 'Team Lead';
      }
    }

    users.push({
      employeeId: empId,
      name: name,
      email: email.toLowerCase(),
      role: finalRoleStr,
      department: dept,
      process: processStr,
      dateJoined: joinDate,
      notes: notesStr,
      teamLeadRawText: teamLeadRaw,
      managerRawText: mngrRaw,
      location: locationStr,
      password: 'Password360@'
    });

    if (finalRoleStr && !validRoles.includes(finalRoleStr.toUpperCase())) {
      errors.push({
        lineNum,
        text: line,
        type: 'warning',
        message: `Unknown Role: "${roleStr}". Defaults to AGENT.`
      });
    }
  }

  return { users, errors };
}

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
  const [loginAccessFilter, setLoginAccessFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [procFilter, setProcFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [tlFilter, setTlFilter] = useState('');
  const [managerFilter, setManagerFilter] = useState('');
  
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

  // Single User Inactivation State
  const [singleInactivateUser, setSingleInactivateUser] = useState<any>(null);
  const [singleInactivatePreset, setSingleInactivatePreset] = useState<string>(INACTIVE_REASON_PRESETS[0]);
  const [singleInactivateReason, setSingleInactivateReason] = useState<string>('');
  
  // Bulk Inactivation State
  const [isBulkInactivateOpen, setIsBulkInactivateOpen] = useState<boolean>(false);
  const [bulkInactivatePreset, setBulkInactivatePreset] = useState<string>(INACTIVE_REASON_PRESETS[0]);
  const [bulkInactivateReason, setBulkInactivateReason] = useState<string>('');
  const [isSubmittingInactivation, setIsSubmittingInactivation] = useState<boolean>(false);

  // Delete User Confirmation Modal States
  const [deleteTargetUser, setDeleteTargetUser] = useState<any | null>(null);
  const [isDeletingUser, setIsDeletingUser] = useState<boolean>(false);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState<boolean>(false);
  const [isDeletingBulk, setIsDeletingBulk] = useState<boolean>(false);

  // Restrict User Login Access States
  const [restrictTargetUser, setRestrictTargetUser] = useState<any | null>(null);
  const [restrictPreset, setRestrictPreset] = useState<string>(RESTRICT_REASON_PRESETS[0]);
  const [restrictReason, setRestrictReason] = useState<string>('');
  const [isSubmittingRestriction, setIsSubmittingRestriction] = useState<boolean>(false);
  const [isBulkRestrictOpen, setIsBulkRestrictOpen] = useState<boolean>(false);
  const [bulkRestrictPreset, setBulkRestrictPreset] = useState<string>(RESTRICT_REASON_PRESETS[0]);
  const [bulkRestrictReason, setBulkRestrictReason] = useState<string>('');

  // Edit / Create Form Inactivation Reason States
  const [editInactivePreset, setEditInactivePreset] = useState<string>(INACTIVE_REASON_PRESETS[0]);
  const [editInactiveReason, setEditInactiveReason] = useState<string>('');
  const [newUserInactivePreset, setNewUserInactivePreset] = useState<string>(INACTIVE_REASON_PRESETS[0]);
  const [newUserInactiveReason, setNewUserInactiveReason] = useState<string>('');

  // CSV Validation reports
  const [csvErrors, setCsvErrors] = useState<{ lineNum: number; text: string; type: 'error' | 'warning'; message: string }[]>([]);

  // CSV Import Progress State
  const [importStatus, setImportStatus] = useState<{
    isImporting: boolean;
    progress: number;
    stage: string;
    currentCount: number;
    totalCount: number;
  }>({
    isImporting: false,
    progress: 0,
    stage: '',
    currentCount: 0,
    totalCount: 0,
  });

  useEffect(() => {
    if (!bulkText) {
      setCsvErrors([]);
      return;
    }
    const { errors } = parseBulkCSVText(bulkText);
    setCsvErrors(errors);
  }, [bulkText]);

  // Edit form states
  const [isEditUserOpen, setIsEditUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const editingUserRef = React.useRef<any>(null);
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
    status: 'Active',
    location: '',
    loginRestricted: false,
    restrictedReason: ''
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
    password: 'Password360@',
    location: '',
    loginRestricted: false,
    restrictedReason: ''
  });

  // Compute normalizedUsers
  const normalizedUsers = useMemo(() => {
    return allUsers.filter(Boolean).map(u => ({
      ...u,
      uid: u.uid || u.id || u.employeeId || Math.random().toString(36).substring(7),
      name: u.fullName || u.name || u.employeeName || 'Unknown User',
      fullName: u.fullName || u.name || u.employeeName || 'Unknown User',
      photoURL: u.profilePhotoUrl || u.photoURL || '',
      mappedManagerName: u.mappedManagerName || u.managerName || '',
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
          return isTLRole(userRole);
        }
        
        return userRole === filterRole;
      })();
      const matchStatus = statusFilter 
        ? (statusFilter === 'Active' ? (u.status?.toLowerCase() === 'active' || u.isActive === true) : (u.status?.toLowerCase() !== 'active' && u.isActive !== true)) 
        : true;
      const isUserRestricted = u.loginRestricted === true || u.isRestricted === true || u.isLoginRestricted === true || u.status === 'Restricted';
      const matchLoginAccess = !loginAccessFilter ? true : (
        loginAccessFilter === 'restricted' ? isUserRestricted : !isUserRestricted
      );
      const matchDept = deptFilter ? (u.department || 'Operations') === deptFilter : true;
      const matchProc = procFilter ? u.process === procFilter : true;
      const matchLoc = locationFilter ? u.location === locationFilter : true;

      const matchTL = !tlFilter ? true : (() => {
        const uTLName = (u.teamLeadName || u.teamLead || '').toLowerCase().trim();
        const uTLUid = (u.teamLeadUid || u.teamLeadId || u.tlId || '').toLowerCase().trim();
        const filterVal = tlFilter.toLowerCase().trim();
        
        if (uTLUid === filterVal) return true;
        if (uTLName === filterVal) return true;

        const targetTLUser = allUsers.find(x => x.uid === tlFilter);
        if (targetTLUser) {
          const targetName = (targetTLUser.fullName || targetTLUser.name || '').toLowerCase().trim();
          if (targetName && uTLName.includes(targetName)) return true;
        }

        return uTLName.includes(filterVal);
      })();

      const matchMgr = !managerFilter ? true : (() => {
        const uMgrName = (u.mappedManagerName || u.managerName || u.Manager || '').toLowerCase().trim();
        const uMgrUid = (u.mappedManagerUid || u.mappedManagerId || u.managerUid || u.managerId || '').toLowerCase().trim();
        const filterVal = managerFilter.toLowerCase().trim();

        if (uMgrUid === filterVal) return true;
        if (uMgrName === filterVal) return true;

        const targetMgrUser = allUsers.find(x => x.uid === managerFilter);
        if (targetMgrUser) {
          const targetName = (targetMgrUser.fullName || targetMgrUser.name || '').toLowerCase().trim();
          if (targetName && uMgrName.includes(targetName)) return true;
        }

        return uMgrName.includes(filterVal);
      })();

      return matchSearch && matchRole && matchStatus && matchLoginAccess && matchDept && matchProc && matchLoc && matchTL && matchMgr;
    }).sort((a, b) => {
      let fieldA = (sortBy === 'name' ? (a.fullName || a.name || '') : (a[sortBy] || ''));
      let fieldB = (sortBy === 'name' ? (b.fullName || b.name || '') : (b[sortBy] || ''));

      if (typeof fieldA === 'string') fieldA = fieldA.toLowerCase();
      if (typeof fieldB === 'string') fieldB = fieldB.toLowerCase();

      if (fieldA < fieldB) return sortOrder === 'asc' ? -1 : 1;
      if (fieldA > fieldB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
  }, [normalizedUsers, searchTerm, roleFilter, statusFilter, loginAccessFilter, deptFilter, procFilter, locationFilter, tlFilter, managerFilter, sortBy, sortOrder]);

  const [registeredProcesses, setRegisteredProcesses] = useState<string[]>([]);
  const [dynamicRoles, setDynamicRoles] = useState<string[]>([]);
  const [isFetchingGlobalRoster, setIsFetchingGlobalRoster] = useState(false);
  const { roles, refreshRoster, fetchGlobalRoster, updateUserInRoster, addUserToRoster, deleteUserFromRoster, updateMultipleUsersInRoster, globalRoster } = useRoster();

  const handleFetchGlobalRoster = async () => {
    if (isFetchingGlobalRoster) return;
    setIsFetchingGlobalRoster(true);
    try {
      toast.info('Fetching global users collection from database...');
      const updatedGlobalRoster = await fetchGlobalRoster(true);
      toast.success(`Successfully fetched ${updatedGlobalRoster.length} users and cached globally!`);
      if (onRefresh) {
        onRefresh();
      }
    } catch (err: any) {
      console.error('[UserManagementSubView] Failed to fetch global roster:', err);
      toast.error('Failed to fetch global roster: ' + (err?.message || 'Unknown error'));
    } finally {
      setIsFetchingGlobalRoster(false);
    }
  };

  useEffect(() => {
    // Explicit global operational view: fetch full roster for admin management prioritizing cache memory first
    fetchGlobalRoster(false).catch(err => {
      console.warn('[UserManagementSubView] Global roster fetch warning:', err);
    });
  }, [fetchGlobalRoster]);

  useEffect(() => {
    const baselineRoles = Object.values(UserRole) as string[];
    const normalizeRoleName = (r: string): string => {
      const trimmed = r.trim();
      const upper = trimmed.toUpperCase();
      if (upper === 'TEAM LEAD' || upper === 'TEAM_LEAD') {
        return 'Team Lead';
      }
      return upper;
    };
    const combined = Array.from(new Set([...baselineRoles, ...roles].map(normalizeRoleName)));
      const filtered = combined.filter(r => {
        if (!r) return false;
        const upper = r.toUpperCase();
        const oldTLVariations = ['STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'TRAINER TL', 'OPS TL', 'OPS_TEAM_LEAD', 'TEAM_LEADER'];
        return !oldTLVariations.includes(upper);
      });
    setDynamicRoles(filtered);
  }, [roles]);

  useEffect(() => {
    const fetchRegisteredProcesses = async () => {
      try {
        const snap = await getDocOptimized(doc(db, 'config', 'tmsProcesses'), 'tms_processes_fetch');
        let list: string[] | null = null;
        if (snap.exists()) {
          const data = snap.data();
          if (Array.isArray(data?.processes)) {
            list = data.processes
              .filter((p: any) => p.status === 'Active' && !p.hidden)
              .map((p: any) => p.name);
          } else if (Array.isArray(data?.list)) {
            list = data.list;
          }
        }
        if (list === null) {
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

  const departments = useMemo(() => {
    const s = new Set<string>();
    allUsers.forEach(u => u.department && s.add(u.department));
    return Array.from(s);
  }, [allUsers]);

  const locations = useMemo(() => {
    const s = new Set<string>();
    s.add('Dehradun (DDN)');
    s.add('Jammu (JMU)');
    s.add('Bangalore (BLR)');
    allUsers.forEach(u => u.location && s.add(u.location));
    return Array.from(s).filter(Boolean);
  }, [allUsers]);

  const processes = useMemo(() => {
    const map = new Map<string, string>();
    registeredProcesses.forEach(p => {
      if (typeof p === 'string' && p.trim().length > 0) {
        const trimmed = p.trim();
        const lower = trimmed.toLowerCase();
        if (!map.has(lower)) {
          map.set(lower, trimmed);
        }
      }
    });
    return Array.from(map.values()).sort();
  }, [registeredProcesses]);

  const teamLeadsList = useMemo(() => {
    const map = new Map<string, string>();
    allUsers.forEach(u => {
      const userRole = (u.role || '').toUpperCase().trim();
      if (isTLRole(userRole)) {
        const name = (u.fullName || u.name || u.employeeName || '').trim();
        if (name) {
          map.set(u.uid, name);
        }
      }
    });
    
    allUsers.forEach(u => {
      const tlName = (u.teamLeadName || u.teamLead || '').trim();
      const tlUid = (u.teamLeadUid || u.teamLeadId || u.tlId || '').trim();
      if (tlUid && !map.has(tlUid)) {
        map.set(tlUid, tlName || tlUid);
      } else if (tlName) {
        const normName = tlName.toLowerCase();
        const alreadyExists = Array.from(map.values()).some(v => v.toLowerCase() === normName);
        if (!alreadyExists) {
          map.set(tlName, tlName);
        }
      }
    });

    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name: name.includes('(TL)') ? name : `${name} (TL)` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allUsers]);

  const managersList = useMemo(() => {
    const map = new Map<string, { name: string; label?: string }>();
    allUsers.forEach(u => {
      const userRole = (u.role || '').toUpperCase().trim();
      if (['MANAGER', 'ASSISTANT_MANAGER', 'OPS_HEAD', 'DIRECTOR'].includes(userRole)) {
        const name = (u.fullName || u.name || u.employeeName || '').trim();
        if (name) {
          map.set(u.uid, { name, label: userRole.replace('_', ' ') });
        }
      }
    });

    allUsers.forEach(u => {
      const mgrName = (u.mappedManagerName || u.managerName || u.Manager || '').trim();
      const mgrUid = (u.mappedManagerUid || u.mappedManagerId || u.managerUid || u.managerId || '').trim();
      if (mgrUid && !map.has(mgrUid)) {
        map.set(mgrUid, { name: mgrName || mgrUid });
      } else if (mgrName) {
        const normName = mgrName.toLowerCase();
        const alreadyExists = Array.from(map.values()).some(v => v.name.toLowerCase() === normName);
        if (!alreadyExists) {
          map.set(mgrName, { name: mgrName });
        }
      }
    });

    return Array.from(map.entries())
      .map(([id, data]) => ({ 
        id, 
        name: data.label ? `${data.name} (${data.label})` : `${data.name} (MANAGER)` 
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allUsers]);

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

  // Helper to clean user profile before writing to Firestore to avoid size limits
  const cleanUserProfile = (user: any) => {
    const { 
      activities, history, documents, notificationLogs, auditLogs, 
      // Add other potentially large fields here
      ...clean 
    } = user;
    return clean;
  };

  // Status toggle handler
  const handleToggleStatus = async (user: any) => {
    const currentStatus = user.status?.toLowerCase() === 'active' || user.isActive === true;
    
    // If user is currently active and being marked Inactive, require reason modal
    if (currentStatus) {
      setSingleInactivateUser(user);
      setSingleInactivatePreset(INACTIVE_REASON_PRESETS[0]);
      setSingleInactivateReason(INACTIVE_REASON_PRESETS[0]);
      return;
    }

    // Reactivating user to Active
    const nextStatus = 'Active';
    const updatedNotes = appendActiveReasonNote(
      user.notes,
      'Status restored to Active via User Management switch',
      auth.currentUser?.email,
      'Manual'
    );
    const nowISO = new Date().toISOString();
    console.info(`[USER STATUS CHANGE] uid=${user.uid} old=Inactive new=Active source=UserManagementSubView.handleToggleStatus`);

    try {
      await setDoc(doc(db, 'users', user.uid), {
        status: nextStatus,
        isActive: true,
        notes: updatedNotes,
        lastModifiedAt: nowISO
      }, { merge: true });
      
      await setDoc(doc(db, 'employee_master', user.uid), {
        status: nextStatus,
        notes: updatedNotes,
        lastUpdated: nowISO
      }, { merge: true });
      
      toast.success(`User '${user.name || user.fullName}' status modified to Active.`);
      logAdminEvent('User Status Checked', user.email, 'Inactive', 'Active');
      await updateUserInRoster({ uid: user.uid, status: nextStatus, isActive: true, notes: updatedNotes });
    } catch (err) {
      console.error(err);
      toast.error('Could not update status.');
    }
  };

  // Single User Inactivation Confirmation
  const handleConfirmSingleInactivation = async () => {
    if (!singleInactivateUser) return;
    setIsSubmittingInactivation(true);
    const targetReason = singleInactivateReason.trim() || singleInactivatePreset || 'Administrative Inactivation';
    const updatedNotes = appendInactiveReasonNote(
      singleInactivateUser.notes,
      targetReason,
      auth.currentUser?.email,
      'Manual'
    );
    const nowISO = new Date().toISOString();

    console.info(`[USER STATUS CHANGE] uid=${singleInactivateUser.uid} old=Active new=Inactive reason="${targetReason}" source=UserManagementSubView.handleConfirmSingleInactivation`);
    try {
      await setDoc(doc(db, 'users', singleInactivateUser.uid), {
        status: 'Inactive',
        isActive: false,
        notes: updatedNotes,
        lastModifiedAt: nowISO
      }, { merge: true });
      
      await setDoc(doc(db, 'employee_master', singleInactivateUser.uid), {
        status: 'Inactive',
        notes: updatedNotes,
        lastUpdated: nowISO
      }, { merge: true });

      // Clean up active live_sessions and tmsActiveLocks if required
      try {
        await deleteDoc(doc(db, 'live_sessions', singleInactivateUser.uid));
        await deleteDoc(doc(db, 'tmsActiveLocks', singleInactivateUser.uid));
        await deleteDoc(doc(db, 'teamMappings', singleInactivateUser.uid));
      } catch (e) {
        console.warn('Failed to clean up active live_session / locks for inactivated user:', e);
      }
      
      await updateUserInRoster({ 
        uid: singleInactivateUser.uid, 
        status: 'Inactive', 
        isActive: false, 
        notes: updatedNotes 
      });
      
      toast.success(`User '${singleInactivateUser.name || singleInactivateUser.fullName}' marked Inactive. Reason recorded in notes.`);
      logAdminEvent('User Inactivated', singleInactivateUser.email, 'Active', `Inactive - ${targetReason}`);
      setSingleInactivateUser(null);
      setSingleInactivateReason('');
    } catch (err) {
      console.error(err);
      toast.error('Could not inactivate user.');
    } finally {
      setIsSubmittingInactivation(false);
    }
  };

  // Bulk Actions
  const handleBulkStatusChange = async (target: 'Active' | 'Inactive') => {
    if (selectedUids.size === 0) {
      toast.error('Please select at least one user.');
      return;
    }

    if (target === 'Inactive') {
      setIsBulkInactivateOpen(true);
      setBulkInactivatePreset(INACTIVE_REASON_PRESETS[0]);
      setBulkInactivateReason(INACTIVE_REASON_PRESETS[0]);
      return;
    }

    // Bulk Reactivation to Active
    try {
      const batch = writeBatch(db);
      const list = normalizedUsers.filter(u => selectedUids.has(u.uid));
      const updates: any[] = [];
      const nowISO = new Date().toISOString();

      list.forEach(u => {
        const userRef = doc(db, 'users', u.uid);
        const masterRef = doc(db, 'employee_master', u.uid);
        const updatedNotes = appendActiveReasonNote(
          u.notes,
          'Bulk status reactivation by administrator',
          auth.currentUser?.email,
          'Bulk'
        );
        
        console.info(`[USER STATUS CHANGE] uid=${u.uid} old=${u.status || (u.isActive ? 'Active' : 'Inactive')} new=Active source=UserManagementSubView.handleBulkStatusChange`);
        batch.set(userRef, {
          status: 'Active',
          isActive: true,
          notes: updatedNotes,
          lastModifiedAt: nowISO
        }, { merge: true });
        
        batch.set(masterRef, {
          status: 'Active',
          notes: updatedNotes,
          lastUpdated: nowISO
        }, { merge: true });
        updates.push({ uid: u.uid, status: 'Active', isActive: true, notes: updatedNotes });
      });
      await batch.commit();
      await updateMultipleUsersInRoster(updates);
      toast.success(`Broadened status to Active for ${selectedUids.size} team profiles.`);
      logAdminEvent('Bulk Status Modification', `${selectedUids.size} profiles`, 'Mixed', 'Active');
      setSelectedUids(new Set());
    } catch (err) {
      console.error(err);
      toast.error('Bulk update write aborted.');
    }
  };

  // Bulk Inactivation Confirmation Handler
  const handleConfirmBulkInactivation = async () => {
    if (selectedUids.size === 0) return;
    setIsSubmittingInactivation(true);
    const targetReason = bulkInactivateReason.trim() || bulkInactivatePreset || 'Bulk Administrative Inactivation';

    try {
      const batch = writeBatch(db);
      const list = normalizedUsers.filter(u => selectedUids.has(u.uid));
      const updates: any[] = [];
      const nowISO = new Date().toISOString();

      list.forEach(u => {
        const userRef = doc(db, 'users', u.uid);
        const masterRef = doc(db, 'employee_master', u.uid);
        const updatedNotes = appendInactiveReasonNote(
          u.notes,
          targetReason,
          auth.currentUser?.email,
          'Bulk'
        );
        
        console.info(`[USER STATUS CHANGE] uid=${u.uid} old=${u.status || (u.isActive ? 'Active' : 'Inactive')} new=Inactive reason="${targetReason}" source=UserManagementSubView.handleConfirmBulkInactivation`);
        batch.set(userRef, {
          status: 'Inactive',
          isActive: false,
          notes: updatedNotes,
          lastModifiedAt: nowISO
        }, { merge: true });
        
        batch.set(masterRef, {
          status: 'Inactive',
          notes: updatedNotes,
          lastUpdated: nowISO
        }, { merge: true });

        // Clean up active live_sessions and tmsActiveLocks for bulk inactivated users
        batch.delete(doc(db, 'live_sessions', u.uid));
        batch.delete(doc(db, 'tmsActiveLocks', u.uid));
        batch.delete(doc(db, 'teamMappings', u.uid));

        updates.push({ uid: u.uid, status: 'Inactive', isActive: false, notes: updatedNotes });
      });

      await batch.commit();
      await updateMultipleUsersInRoster(updates);
      toast.success(`Marked ${selectedUids.size} profiles as Inactive. Reason recorded in notes.`);
      logAdminEvent('Bulk Status Modification', `${selectedUids.size} profiles`, 'Mixed', `Inactive - ${targetReason}`);
      setSelectedUids(new Set());
      setIsBulkInactivateOpen(false);
      setBulkInactivateReason('');
    } catch (err) {
      console.error(err);
      toast.error('Bulk inactivation aborted.');
    } finally {
      setIsSubmittingInactivation(false);
    }
  };

  // Single and Bulk Deletion Handlers
  const handleOpenDeleteUser = (user: any) => {
    setDeleteTargetUser(user);
  };

  const handleConfirmSingleDelete = async () => {
    if (!deleteTargetUser) return;
    setIsDeletingUser(true);
    const targetUid = deleteTargetUser.uid;
    const targetName = deleteTargetUser.fullName || deleteTargetUser.name || 'User';

    try {
      // 1. Mark as deleted/archived in employee_master to preserve historical references and reporting
      await setDoc(doc(db, 'employee_master', targetUid), {
        isDeleted: true,
        deletedAt: new Date().toISOString(),
        status: 'Archived',
        isActive: false
      }, { merge: true });
      
      // Clean up the users/{uid} document explicitly
      try {
        await deleteDoc(doc(db, 'users', targetUid));
      } catch (e) {
        console.warn('users/{uid} document deletion ignored/failed:', e);
      }

      // Clean up active live session, active lock, and teamMappings
      try {
        await deleteDoc(doc(db, 'teamMappings', targetUid));
      } catch (e) {
        console.warn('teamMappings cleanup ignored:', e);
      }
      try {
        await deleteDoc(doc(db, 'live_sessions', targetUid));
      } catch (e) {
        console.warn('live_sessions cleanup ignored:', e);
      }
      try {
        await deleteDoc(doc(db, 'tmsActiveLocks', targetUid));
      } catch (e) {
        console.warn('tmsActiveLocks cleanup ignored:', e);
      }

      // 2. Clear caches and delete from roster context
      try {
        await safeStorage.clearAllIndexedDBByPrefix('precision360_hierarchy_nodes_');
        await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
        if (auth.currentUser) {
          await safeStorage.clearAllIndexedDBByPrefix(`precision360_roster_cache_${auth.currentUser.uid}`);
        }
      } catch (e) {
        console.warn('Cache clear warning:', e);
      }

      await deleteUserFromRoster(targetUid);
      logAdminEvent('Profile Terminated', targetName, 'Active Document', 'DeletedDoc');
      toast.success(`Profile for '${targetName}' permanently deleted.`);
      setDeleteTargetUser(null);
    } catch (err: any) {
      console.error('Delete user error:', err);
      toast.error(`Deletion failed: ${err?.message || 'Permission denied or network failure'}`);
    } finally {
      setIsDeletingUser(false);
    }
  };

  const handleConfirmBulkDelete = async () => {
    if (selectedUids.size === 0) return;
    setIsDeletingBulk(true);

    try {
      const uidsToDelete: string[] = Array.from(selectedUids) as string[];
      const batch = writeBatch(db);

      for (const uid of uidsToDelete) {
        batch.set(doc(db, 'employee_master', String(uid)), {
          isDeleted: true,
          deletedAt: new Date().toISOString(),
          status: 'Archived',
          isActive: false
        }, { merge: true });
        batch.delete(doc(db, 'users', String(uid)));
        batch.delete(doc(db, 'live_sessions', String(uid)));
        batch.delete(doc(db, 'tmsActiveLocks', String(uid)));
        batch.delete(doc(db, 'teamMappings', String(uid)));
      }

      await batch.commit();

      for (const uid of uidsToDelete) {
        await deleteUserFromRoster(String(uid));
      }

      try {
        await safeStorage.clearAllIndexedDBByPrefix('precision360_hierarchy_nodes_');
        await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
        if (auth.currentUser) {
          await safeStorage.clearAllIndexedDBByPrefix(`precision360_roster_cache_${auth.currentUser.uid}`);
        }
      } catch (e) {
        console.warn('Cache clear warning:', e);
      }

      toast.success(`Successfully deleted ${uidsToDelete.length} user profiles.`);
      logAdminEvent('Bulk Profile Deletion', `${uidsToDelete.length} profiles`, 'Active', 'Deleted');
      setSelectedUids(new Set());
      setIsBulkDeleteOpen(false);
    } catch (err: any) {
      console.error('Bulk delete error:', err);
      toast.error(`Bulk deletion failed: ${err?.message || 'Error occurred'}`);
    } finally {
      setIsDeletingBulk(false);
    }
  };

  // Login Restriction Handlers
  const handleOpenRestrictUser = (user: any) => {
    setRestrictTargetUser(user);
    setRestrictPreset(RESTRICT_REASON_PRESETS[0]);
    setRestrictReason('');
  };

  const handleConfirmRestriction = async () => {
    if (!restrictTargetUser) return;
    setIsSubmittingRestriction(true);
    const targetUid = restrictTargetUser.uid;
    const targetName = restrictTargetUser.fullName || restrictTargetUser.name || 'User';
    const finalReason = restrictReason.trim() || restrictPreset;
    const nowISO = new Date().toISOString();
    const adminEmail = auth.currentUser?.email || 'admin';

    try {
      const updatedNotes = appendInactiveReasonNote(
        restrictTargetUser.notes,
        `[LOGIN RESTRICTED]: ${finalReason}`,
        adminEmail,
        'Security'
      );

      const updateData = {
        loginRestricted: true,
        isRestricted: true,
        restrictedReason: finalReason,
        restrictedAt: nowISO,
        restrictedBy: adminEmail,
        notes: updatedNotes,
        lastModifiedAt: nowISO,
        lastUpdated: nowISO
      };

      await setDoc(doc(db, 'users', targetUid), updateData, { merge: true });
      await setDoc(doc(db, 'employee_master', targetUid), updateData, { merge: true });

      await updateUserInRoster({
        ...restrictTargetUser,
        loginRestricted: true,
        isRestricted: true,
        restrictedReason: finalReason,
        restrictedAt: nowISO,
        restrictedBy: adminEmail,
        notes: updatedNotes
      });

      logAdminEvent('User Login Restricted', targetName, finalReason, 'SecurityPolicy');
      toast.success(`Login restricted for ${targetName}. Account cannot log in.`);
      setRestrictTargetUser(null);
      setRestrictReason('');
    } catch (err: any) {
      console.error('Error restricting user login:', err);
      toast.error(`Failed to restrict login access: ${err?.message || 'Permission denied'}`);
    } finally {
      setIsSubmittingRestriction(false);
    }
  };

  const handleUnrestrictUser = async (user: any) => {
    const nowISO = new Date().toISOString();
    const adminEmail = auth.currentUser?.email || 'admin';
    const userName = user.fullName || user.name || 'User';

    try {
      const updatedNotes = appendActiveReasonNote(
        user.notes,
        'Login restriction lifted by administrator',
        adminEmail,
        'Security'
      );

      const updateData = {
        loginRestricted: false,
        isRestricted: false,
        restrictedReason: '',
        restrictedAt: '',
        restrictedBy: '',
        notes: updatedNotes,
        lastModifiedAt: nowISO,
        lastUpdated: nowISO
      };

      await setDoc(doc(db, 'users', user.uid), updateData, { merge: true });
      await setDoc(doc(db, 'employee_master', user.uid), updateData, { merge: true });

      await updateUserInRoster({
        ...user,
        loginRestricted: false,
        isRestricted: false,
        restrictedReason: '',
        restrictedAt: '',
        restrictedBy: '',
        notes: updatedNotes
      });

      logAdminEvent('User Login Unrestricted', userName, 'Allowed', 'SecurityPolicy');
      toast.success(`Login access restored for ${userName}.`);
    } catch (err: any) {
      console.error('Error unrestricting user:', err);
      toast.error(`Failed to lift login restriction: ${err?.message || 'Permission denied'}`);
    }
  };

  const handleConfirmBulkRestriction = async () => {
    if (selectedUids.size === 0) return;
    setIsSubmittingRestriction(true);
    const finalReason = bulkRestrictReason.trim() || bulkRestrictPreset;
    const nowISO = new Date().toISOString();
    const adminEmail = auth.currentUser?.email || 'admin';

    try {
      const targetUsers = normalizedUsers.filter(u => selectedUids.has(u.uid));
      const batch = writeBatch(db);
      const updates: UserProfile[] = [];

      for (const u of targetUsers) {
        const updatedNotes = appendInactiveReasonNote(
          u.notes,
          `[BULK LOGIN RESTRICTED]: ${finalReason}`,
          adminEmail,
          'Security'
        );

        const updateData = {
          loginRestricted: true,
          isRestricted: true,
          restrictedReason: finalReason,
          restrictedAt: nowISO,
          restrictedBy: adminEmail,
          notes: updatedNotes,
          lastModifiedAt: nowISO,
          lastUpdated: nowISO
        };

        batch.set(doc(db, 'users', u.uid), updateData, { merge: true });
        batch.set(doc(db, 'employee_master', u.uid), updateData, { merge: true });

        updates.push({
          ...u,
          loginRestricted: true,
          isRestricted: true,
          restrictedReason: finalReason,
          restrictedAt: nowISO,
          restrictedBy: adminEmail,
          notes: updatedNotes
        });
      }

      await batch.commit();
      await updateMultipleUsersInRoster(updates);
      toast.success(`Login restricted for ${updates.length} users.`);
      logAdminEvent('Bulk User Login Restriction', `${updates.length} profiles`, 'Mixed', finalReason);
      setIsBulkRestrictOpen(false);
      setBulkRestrictReason('');
    } catch (err: any) {
      console.error('Bulk restrict error:', err);
      toast.error('Failed to restrict selected users.');
    } finally {
      setIsSubmittingRestriction(false);
    }
  };

  const handleBulkUnrestrict = async () => {
    if (selectedUids.size === 0) return;
    setIsSubmittingRestriction(true);
    const nowISO = new Date().toISOString();
    const adminEmail = auth.currentUser?.email || 'admin';

    try {
      const targetUsers = normalizedUsers.filter(u => selectedUids.has(u.uid));
      const batch = writeBatch(db);
      const updates: UserProfile[] = [];

      for (const u of targetUsers) {
        const updatedNotes = appendActiveReasonNote(
          u.notes,
          'Bulk login restriction lifted by administrator',
          adminEmail,
          'Security'
        );

        const updateData = {
          loginRestricted: false,
          isRestricted: false,
          restrictedReason: '',
          restrictedAt: '',
          restrictedBy: '',
          notes: updatedNotes,
          lastModifiedAt: nowISO,
          lastUpdated: nowISO
        };

        batch.set(doc(db, 'users', u.uid), updateData, { merge: true });
        batch.set(doc(db, 'employee_master', u.uid), updateData, { merge: true });

        updates.push({
          ...u,
          loginRestricted: false,
          isRestricted: false,
          restrictedReason: '',
          restrictedAt: '',
          restrictedBy: '',
          notes: updatedNotes
        });
      }

      await batch.commit();
      await updateMultipleUsersInRoster(updates);
      toast.success(`Login access restored for ${updates.length} users.`);
      logAdminEvent('Bulk User Login Unrestricted', `${updates.length} profiles`, 'Restricted', 'Allowed');
    } catch (err: any) {
      console.error('Bulk unrestrict error:', err);
      toast.error('Failed to lift login restrictions.');
    } finally {
      setIsSubmittingRestriction(false);
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
      'Location': u.location || 'N/A',
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
    const headers = ['Employee ID', 'Employee Name', 'Email ID', 'User Role', 'Department Name', 'Location', 'Enterprise Process', 'Team Lead', 'Manager Name', 'Joined Date', 'Account State', 'Last Login', 'Employee Notes'];
    const rows = filteredUsers.map(u => [
      u.employeeId || 'N/A',
      u.fullName || u.name || 'N/A',
      u.email || 'N/A',
      u.role || 'N/A',
      u.department || 'Operations',
      u.location || 'N/A',
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
      // 1. Create or retrieve the User in Firebase Authentication via server API
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken(true) : '';

      const response = await fetch('/api/create-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          name: newForm.name,
          email: newForm.email,
          role: newForm.role,
          password: newForm.password
        })
      });

      const contentType = response.headers.get('content-type');
      const isJson = !!(contentType && contentType.includes('application/json'));

      if (!response.ok) {
        let errMsg = 'Server rejected user creation.';
        if (isJson) {
          const errObj = await response.json();
          errMsg = errObj.error || errMsg;
        } else {
          const text = await response.text();
          errMsg = `Server error (${response.status}): ${text.substring(0, 80).trim()}...`;
        }
        throw new Error(errMsg);
      }

      if (!isJson) {
        const text = await response.text();
        throw new Error(`Expected JSON response, but received Content-Type: ${contentType || 'none'} (body: ${text.substring(0, 80).trim()}...)`);
      }

      const resData = await response.json();
      let generatedUid = resData.user.uid;

      // Prevent duplicate profiles! Check if there is an existing user in allUsers with this exact email,
      // and if so, reuse their UID so we merge and overwrite their settings in-place.
      const existingUser = allUsers.find((u: any) => (u.email || '').toLowerCase().trim() === newForm.email.toLowerCase().trim());
      if (existingUser && existingUser.uid) {
        generatedUid = existingUser.uid;
      }

      // 2. Perform client-side database writes which have 100% working permissions
      const isNewInactive = (newForm.status || 'Active') === 'Inactive';
      const finalNotes = isNewInactive 
        ? appendInactiveReasonNote(
            newForm.notes, 
            newUserInactiveReason || newForm.notes || 'Account provisioned with Inactive status', 
            auth.currentUser?.email, 
            'Creation'
          )
        : (newForm.notes || '');

      const isNewRestricted = newForm.loginRestricted === true;
      let finalRestrictedReason = newForm.restrictedReason || '';
      if (isNewRestricted && !finalRestrictedReason) {
        finalRestrictedReason = 'Provisioned with login access restricted';
      }

      console.info(`[USER STATUS CHANGE] uid=${generatedUid} old=${existingUser ? (existingUser.status || (existingUser.isActive === false ? 'Inactive' : 'Active')) : 'NONE'} new=${newForm.status || 'Active'} source=UserManagementSubView.handleCreateUser`);
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
        notes: finalNotes,
        teamLeadName: newForm.teamLeadName,
        teamLeadUid: newForm.teamLeadUid,
        mappedManagerName: newForm.mappedManagerName,
        mappedManagerUid: newForm.mappedManagerUid,
        Manager: newForm.mappedManagerName || '',
        status: newForm.status || 'Active',
        isActive: (newForm.status || 'Active') === 'Active',
        loginRestricted: isNewRestricted,
        isRestricted: isNewRestricted,
        restrictedReason: isNewRestricted ? finalRestrictedReason : '',
        restrictedAt: isNewRestricted ? new Date().toISOString() : '',
        restrictedBy: isNewRestricted ? (auth.currentUser?.email || 'admin') : '',
        createdAt: new Date().toISOString(),
        location: newForm.location || ''
      };

      const masterDoc = {
        employeeId: newForm.employeeId || '',
        employeeName: newForm.name || '',
        email: newForm.email.toLowerCase().trim(),
        role: newForm.role,
        department: newForm.department || 'Operations',
        process: newForm.process || '',
        teamLeadId: newForm.teamLeadUid || '',
        teamLeadUid: newForm.teamLeadUid || '',
        teamLeadName: newForm.teamLeadName || '',
        managerId: newForm.mappedManagerUid || '',
        managerName: newForm.mappedManagerName || '',
        Manager: newForm.mappedManagerName || '',
        status: newForm.status || 'Active',
        notes: finalNotes,
        dateJoined: newForm.dateJoined || '',
        loginRestricted: isNewRestricted,
        isRestricted: isNewRestricted,
        restrictedReason: isNewRestricted ? finalRestrictedReason : '',
        restrictedAt: isNewRestricted ? new Date().toISOString() : '',
        restrictedBy: isNewRestricted ? (auth.currentUser?.email || 'admin') : '',
        lastUpdated: new Date().toISOString(),
        location: newForm.location || ''
      };

      const mappingDoc = {
        userId: generatedUid,
        userName: newForm.name,
        teamLeadId: newForm.teamLeadUid || '',
        teamLeadName: newForm.teamLeadName || '',
        managerId: newForm.mappedManagerUid || '',
        managerName: newForm.mappedManagerName || '',
        Manager: newForm.mappedManagerName || '',
        process: newForm.process || '',
        lastUpdated: new Date().toISOString()
      };

      const writeStart = Date.now();
      await setDoc(doc(db, 'users', generatedUid), cleanUserProfile(finalProfile));
      await setDoc(doc(db, 'employee_master', generatedUid), masterDoc);
      await setDoc(doc(db, 'teamMappings', generatedUid), mappingDoc);

      const verifySnap = await getDoc(doc(db, 'employee_master', generatedUid));
      const verifyData = verifySnap.exists() ? verifySnap.data() : null;
      const firestoreVerified = verifyData && 
        (verifyData.teamLeadUid === (newForm.teamLeadUid || '')) &&
        (verifyData.managerId === (newForm.mappedManagerUid || ''));

      console.info(`[HIERARCHY SAVE]
actorUid=spawn
targetUserUid=${generatedUid}
previousTeamLeadUid=none
newTeamLeadUid=${newForm.teamLeadUid || 'none'}
previousManagerUid=none
newManagerUid=${newForm.mappedManagerUid || 'none'}
writeStarted=${writeStart}
writeCompleted=${Date.now()}
firestoreVerified=${firestoreVerified}`);

      if (!firestoreVerified) {
        throw new Error('Hierarchy save failed — changes were not persisted in Firestore verification check.');
      }

      try {
        await safeStorage.clearAllIndexedDBByPrefix('precision360_hierarchy_nodes_');
        await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
        if (auth.currentUser) {
          await safeStorage.clearAllIndexedDBByPrefix(`precision360_roster_cache_${auth.currentUser.uid}`);
        }
      } catch (e) {
        console.warn('Cache clear warning:', e);
      }

      toast.success(`Account for '${newForm.name}' spawned and hierarchy synchronized.`);
      logAdminEvent('User Profile Spawned', newForm.email, '', JSON.stringify(finalProfile));
      syncTargetUserClaims(generatedUid, newForm.role).catch(console.error);
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
        password: 'Password360@',
        location: ''
      });
      await addUserToRoster(finalProfile);
    } catch (err: any) {
      toast.error(err.message || 'Error occurred.');
    }
  };

  // Edit User Handlers
  const handleEditUserOpen = (user: any) => {
    setEditingUser(user);
    editingUserRef.current = user;

    // Resolve direct Team Lead
    let tlUid = user.teamLeadUid || user.teamLeadId || user.mappedTL || '';
    let tlName = user.teamLeadName || user.TeamLead || user.teamLead || '';
    if (tlUid && allUsers) {
      const foundTL = allUsers.find((u: any) => u.uid === tlUid);
      if (foundTL) {
        tlName = foundTL.fullName || foundTL.name || foundTL.employeeName || tlName;
      }
    }
    if (tlUid && (!tlName || tlName === user.teamLeadName) && globalRoster) {
      const foundTL = (globalRoster || []).find((u: any) => u.uid === tlUid);
      if (foundTL) {
        tlName = foundTL.fullName || foundTL.name || foundTL.employeeName || tlName;
      }
    }
    if (!tlUid && tlName && allUsers) {
      const foundTL = allUsers.find((u: any) => 
        (u.fullName || u.name || u.employeeName || '').toLowerCase().trim() === tlName.toLowerCase().trim()
      );
      if (foundTL) {
        tlUid = foundTL.uid;
      }
    }

    // Resolve direct Manager
    let mgrUid = user.mappedManagerUid || user.mappedManagerId || user.managerId || '';
    let mgrName = user.mappedManagerName || user.managerName || user.Manager || '';

    if (mgrUid && allUsers) {
      const foundMgr = allUsers.find((u: any) => u.uid === mgrUid);
      if (foundMgr) {
        mgrName = foundMgr.fullName || foundMgr.name || foundMgr.employeeName || mgrName;
      }
    }
    if (mgrUid && (!mgrName || mgrName === (user.mappedManagerName || user.managerName || user.Manager)) && globalRoster) {
      const foundMgr = (globalRoster || []).find((u: any) => u.uid === mgrUid);
      if (foundMgr) {
        mgrName = foundMgr.fullName || foundMgr.name || foundMgr.employeeName || mgrName;
      }
    }
    if (!mgrUid && mgrName && allUsers) {
      const foundMgr = allUsers.find((u: any) => 
        (u.fullName || u.name || u.employeeName || '').toLowerCase().trim() === mgrName.toLowerCase().trim()
      );
      if (foundMgr) {
        mgrUid = foundMgr.uid;
      }
    }

    const isRestricted = user.loginRestricted === true || user.isRestricted === true || user.isLoginRestricted === true || user.status === 'Restricted';
    setEditInactiveReason('');
    setEditForm({
      employeeId: user.employeeId || '',
      name: user.fullName || user.name || '',
      role: (user.role as UserRole) || 'AGENT',
      department: user.department || 'Operations',
      process: user.process || '',
      dateJoined: user.dateJoined || '',
      notes: user.notes || '',
      teamLeadName: tlName,
      teamLeadUid: tlUid,
      mappedManagerName: mgrName,
      mappedManagerUid: mgrUid,
      status: user.status || (user.isActive === false ? 'Inactive' : 'Active'),
      location: user.location || '',
      loginRestricted: isRestricted,
      restrictedReason: user.restrictedReason || ''
    });

    setIsEditUserOpen(true);

    // Resolve supervisors asynchronously if we have canonical UIDs
    const resolveSupervisorsAsync = async (targetTlUid: string, targetMgrUid: string) => {
      let resolvedTL: any = null;
      let resolvedMgr: any = null;

      if (targetTlUid) {
        resolvedTL = (allUsers || []).find((u: any) => u.uid === targetTlUid);
        if (!resolvedTL && (globalRoster || []).length > 0) {
          resolvedTL = globalRoster.find((u: any) => u.uid === targetTlUid);
        }
        if (!resolvedTL) {
          try {
            const tlDoc = await getDoc(doc(db, 'employee_master', targetTlUid));
            if (tlDoc.exists()) {
              resolvedTL = tlDoc.data();
            }
          } catch (e) {
            console.warn('[handleEditUserOpen] TL direct lookup failed:', e);
          }
        }
      }

      if (targetMgrUid) {
        resolvedMgr = (allUsers || []).find((u: any) => u.uid === targetMgrUid);
        if (!resolvedMgr && (globalRoster || []).length > 0) {
          resolvedMgr = globalRoster.find((u: any) => u.uid === targetMgrUid);
        }
        if (!resolvedMgr) {
          try {
            const mgrDoc = await getDoc(doc(db, 'employee_master', targetMgrUid));
            if (mgrDoc.exists()) {
              resolvedMgr = mgrDoc.data();
            }
          } catch (e) {
            console.warn('[handleEditUserOpen] Manager direct lookup failed:', e);
          }
        }
      }

      if (resolvedTL || resolvedMgr) {
        setEditForm(prev => {
          if (editingUserRef.current?.uid !== user.uid) return prev;
          return {
            ...prev,
            teamLeadName: resolvedTL ? (resolvedTL.fullName || resolvedTL.name || resolvedTL.employeeName || prev.teamLeadName) : prev.teamLeadName,
            teamLeadUid: targetTlUid,
            mappedManagerName: resolvedMgr ? (resolvedMgr.fullName || resolvedMgr.name || resolvedMgr.employeeName || prev.mappedManagerName) : prev.mappedManagerName,
            mappedManagerUid: targetMgrUid
          };
        });
      }
    };

    if (tlUid || mgrUid) {
      resolveSupervisorsAsync(tlUid, mgrUid);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    if (!editForm.employeeId || !editForm.employeeId.trim()) {
      toast.error('Employee ID is required.');
      return;
    }
    if (!editForm.name || !editForm.name.trim()) {
      toast.error('Name is required.');
      return;
    }

    try {
      // Standardize existing UIDs
      const existingTLUid = editingUser.teamLeadUid || editingUser.teamLeadId || editingUser.mappedTL || '';
      const existingMgrUid = editingUser.mappedManagerUid || editingUser.mappedManagerId || editingUser.managerId || '';

      // Standardize new UIDs from form
      const newTLUid = editForm.teamLeadUid || '';
      const newMgrUid = editForm.mappedManagerUid || '';

      const isTLChanged = newTLUid !== existingTLUid;
      const isMgrChanged = newMgrUid !== existingMgrUid;

      // Lookups
      const findUserInRoster = (uid: string) => {
        if (!uid) return null;
        let found = (allUsers || []).find((u: any) => u.uid === uid);
        if (!found) {
          found = (globalRoster || []).find((u: any) => u.uid === uid);
        }
        return found;
      };

      const selectedTLObj = findUserInRoster(newTLUid);
      const selectedMgrObj = findUserInRoster(newMgrUid);

      let teamLeadEmail = '';
      let teamLeadName = editForm.teamLeadName;
      let managerEmail = '';
      let mappedManagerName = editForm.mappedManagerName;

      // Defensive Save Rules:
      // For Team Lead
      if (!isTLChanged) {
        // Preserve original values exactly if unchanged
        teamLeadEmail = editingUser.teamLeadEmail || '';
        teamLeadName = editingUser.teamLeadName || editForm.teamLeadName || '';
      } else {
        // Explicit change
        if (newTLUid) {
          if (selectedTLObj) {
            teamLeadEmail = selectedTLObj.email || '';
            teamLeadName = selectedTLObj.fullName || selectedTLObj.name || selectedTLObj.employeeName || editForm.teamLeadName || '';
          } else {
            toast.error(`Cannot change Team Lead: Selected Team Lead (UID: ${newTLUid}) could not be resolved. Please try again after the user directory loads completely.`);
            return;
          }
        } else {
          teamLeadEmail = '';
          teamLeadName = '';
        }
      }

      // For Manager
      if (!isMgrChanged) {
        // Preserve original values exactly if unchanged
        managerEmail = editingUser.mappedManagerEmail || editingUser.managerEmail || '';
        mappedManagerName = editingUser.mappedManagerName || editingUser.managerName || editingUser.Manager || editForm.mappedManagerName || '';
      } else {
        // Explicit change
        if (newMgrUid) {
          if (selectedMgrObj) {
            managerEmail = selectedMgrObj.email || '';
            mappedManagerName = selectedMgrObj.fullName || selectedMgrObj.name || selectedMgrObj.employeeName || editForm.mappedManagerName || '';
          } else {
            toast.error(`Cannot change Manager: Selected Manager (UID: ${newMgrUid}) could not be resolved. Please try again after the user directory loads completely.`);
            return;
          }
        } else {
          managerEmail = '';
          mappedManagerName = '';
        }
      }

      // Safety checks: If UID is present but lookup was empty, fallback to existing to avoid destructive overwrites
      if (newTLUid && !teamLeadEmail && (editingUser.teamLeadEmail && !isTLChanged)) {
        teamLeadEmail = editingUser.teamLeadEmail;
      }
      if (newMgrUid && !managerEmail && ((editingUser.mappedManagerEmail || editingUser.managerEmail) && !isMgrChanged)) {
        managerEmail = editingUser.mappedManagerEmail || editingUser.managerEmail;
      }

      const oldStatus = editingUser.status || (editingUser.isActive === false ? 'Inactive' : 'Active');
      const newStatus = editForm.status || 'Active';
      let finalNotes = editForm.notes || '';

      if (newStatus === 'Inactive') {
        if (oldStatus !== 'Inactive') {
          // Status changing from Active to Inactive
          finalNotes = appendInactiveReasonNote(
            editForm.notes,
            editInactiveReason || editForm.notes || 'Status changed to Inactive in User Edit',
            auth.currentUser?.email,
            'Edit'
          );
        } else if (editInactiveReason && editInactiveReason.trim()) {
          // User already Inactive but new explicit note added
          finalNotes = appendInactiveReasonNote(
            editForm.notes,
            editInactiveReason.trim(),
            auth.currentUser?.email,
            'Edit'
          );
        }
      } else if (newStatus === 'Active' && oldStatus === 'Inactive') {
        // Status reactivated to Active
        finalNotes = appendActiveReasonNote(
          editForm.notes,
          'Status reactivated to Active in User Edit',
          auth.currentUser?.email,
          'Edit'
        );
      }

      const oldIsRestricted = editingUser.loginRestricted === true || editingUser.isRestricted === true;
      const newIsRestricted = editForm.loginRestricted === true;
      let finalRestrictedReason = editForm.restrictedReason || '';
      const nowISO = new Date().toISOString();

      if (newIsRestricted && !oldIsRestricted) {
        if (!finalRestrictedReason) finalRestrictedReason = 'Login access restricted by administrator in User Edit';
        finalNotes = appendInactiveReasonNote(
          finalNotes,
          `[LOGIN RESTRICTED]: ${finalRestrictedReason}`,
          auth.currentUser?.email,
          'Edit'
        );
      } else if (!newIsRestricted && oldIsRestricted) {
        finalNotes = appendActiveReasonNote(
          finalNotes,
          'Login restriction lifted by administrator in User Edit',
          auth.currentUser?.email,
          'Edit'
        );
        finalRestrictedReason = '';
      }

      const updatedProfile = {
        employeeId: editForm.employeeId.trim(),
        name: editForm.name.trim(),
        fullName: editForm.name.trim(),
        role: editForm.role,
        department: editForm.department || 'Operations',
        process: editForm.process || '',
        dateJoined: editForm.dateJoined || '',
        notes: finalNotes,
        teamLeadName: teamLeadName || '',
        teamLeadUid: editForm.teamLeadUid || '',
        teamLeadId: editForm.teamLeadUid || '',
        mappedTL: editForm.teamLeadUid || '',
        teamLeadEmail: teamLeadEmail,
        mappedManagerName: mappedManagerName || '',
        managerName: mappedManagerName || '',
        mappedManagerUid: editForm.mappedManagerUid || '',
        mappedManagerId: editForm.mappedManagerUid || '',
        managerId: editForm.mappedManagerUid || '',
        Manager: mappedManagerName || '',
        mappedManagerEmail: managerEmail,
        managerEmail: managerEmail,
        status: editForm.status || 'Active',
        isActive: editForm.status === 'Active',
        loginRestricted: newIsRestricted,
        isRestricted: newIsRestricted,
        restrictedReason: finalRestrictedReason,
        restrictedAt: newIsRestricted ? (editingUser.restrictedAt || nowISO) : '',
        restrictedBy: newIsRestricted ? (editingUser.restrictedBy || auth.currentUser?.email || 'admin') : '',
        lastModifiedAt: nowISO,
        location: editForm.location || ''
      };

      const writeStart = Date.now();
      if (oldStatus !== newStatus) {
        console.info(`[USER STATUS CHANGE] uid=${editingUser.uid} old=${oldStatus} new=${newStatus} source=UserManagementSubView.handleEditUser`);
      }
      // Use setDoc with merge: true to avoid throwing document-not-found exceptions
      await setDoc(doc(db, 'users', editingUser.uid), updatedProfile, { merge: true });

      const masterDoc = {
        employeeId: editForm.employeeId.trim(),
        employeeName: editForm.name.trim(),
        fullName: editForm.name.trim(),
        email: (editingUser.email || '').toLowerCase().trim(),
        role: editForm.role,
        department: editForm.department || 'Operations',
        process: editForm.process || '',
        teamLeadId: editForm.teamLeadUid || '',
        teamLeadUid: editForm.teamLeadUid || '',
        teamLeadName: teamLeadName || '',
        teamLeadEmail: teamLeadEmail,
        managerId: editForm.mappedManagerUid || '',
        mappedManagerId: editForm.mappedManagerUid || '',
        mappedManagerUid: editForm.mappedManagerUid || '',
        managerName: mappedManagerName || '',
        mappedManagerName: mappedManagerName || '',
        Manager: mappedManagerName || '',
        managerEmail: managerEmail,
        mappedManagerEmail: managerEmail,
        status: editForm.status || 'Active',
        notes: finalNotes,
        dateJoined: editForm.dateJoined || '',
        loginRestricted: newIsRestricted,
        isRestricted: newIsRestricted,
        restrictedReason: finalRestrictedReason,
        restrictedAt: newIsRestricted ? (editingUser.restrictedAt || nowISO) : '',
        restrictedBy: newIsRestricted ? (editingUser.restrictedBy || auth.currentUser?.email || 'admin') : '',
        lastUpdated: nowISO,
        location: editForm.location || ''
      };
      await setDoc(doc(db, 'employee_master', editingUser.uid), masterDoc, { merge: true });

      // 3. Sync Team Mapping (Ongoing Auto-Sync)
      const mappingDoc = {
        userId: editingUser.uid,
        userName: editForm.name.trim(),
        teamLeadId: editForm.teamLeadUid || '',
        teamLeadUid: editForm.teamLeadUid || '',
        teamLeadName: teamLeadName || '',
        teamLeadEmail: teamLeadEmail,
        managerId: editForm.mappedManagerUid || '',
        mappedManagerId: editForm.mappedManagerUid || '',
        mappedManagerUid: editForm.mappedManagerUid || '',
        managerName: mappedManagerName || '',
        mappedManagerName: mappedManagerName || '',
        Manager: mappedManagerName || '',
        managerEmail: managerEmail,
        mappedManagerEmail: managerEmail,
        process: editForm.process || '',
        lastUpdated: new Date().toISOString()
      };
      await setDoc(doc(db, 'teamMappings', editingUser.uid), mappingDoc, { merge: true });

      const verifySnap = await getDoc(doc(db, 'employee_master', editingUser.uid));
      const verifyData = verifySnap.exists() ? verifySnap.data() : null;
      const firestoreVerified = verifyData && 
        (verifyData.teamLeadUid === (editForm.teamLeadUid || '')) &&
        (verifyData.managerId === (editForm.mappedManagerUid || ''));

      console.info(`[HIERARCHY SAVE]
actorUid=${auth.currentUser?.uid || 'unknown'}
targetUserUid=${editingUser.uid}
previousTeamLeadUid=${editingUser.teamLeadUid || 'none'}
newTeamLeadUid=${editForm.teamLeadUid || 'none'}
previousManagerUid=${editingUser.mappedManagerUid || editingUser.managerId || 'none'}
newManagerUid=${editForm.mappedManagerUid || 'none'}
writeStarted=${writeStart}
writeCompleted=${Date.now()}
firestoreVerified=${firestoreVerified}`);

      if (!firestoreVerified) {
        throw new Error('Hierarchy save failed — changes were not persisted in Firestore verification check.');
      }

      try {
        await safeStorage.clearAllIndexedDBByPrefix('precision360_hierarchy_nodes_');
        await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
        if (auth.currentUser) {
          await safeStorage.clearAllIndexedDBByPrefix(`precision360_roster_cache_${auth.currentUser.uid}`);
        }
      } catch (e) {
        console.warn('Cache clear warning:', e);
      }

      if (editForm.process) {
        await setDoc(doc(db, 'live_sessions', editingUser.uid), {
          tlId: editForm.teamLeadUid || '',
          managerId: editForm.mappedManagerUid || '',
          mappedManagerId: editForm.mappedManagerUid || '',
          process: editForm.process,
          currentProcess: editForm.process
        }, { merge: true });
      }

      // Mutate local editingUser object for INSTANT UI update
      Object.assign(editingUser, updatedProfile, masterDoc);

      toast.success(`Profile for '${editForm.name}' updated and hierarchy synchronized.`);
      logAdminEvent(
        'User Profile Updated', 
        editingUser.email, 
        JSON.stringify(editingUser), 
        JSON.stringify(updatedProfile)
      );
      
      await updateUserInRoster({ ...updatedProfile, uid: editingUser.uid });
      syncTargetUserClaims(editingUser.uid, editForm.role).catch(console.error);
      
      setIsEditUserOpen(false);
      setEditingUser(null);
    } catch (err: any) {
      toast.error(err.message || 'Error occurred while updating user.');
    }
  };

  // Offline parsing for bulk csv copy-paste with support for updating existing users
  const handleBulkImport = async () => {
    if (!bulkText.trim()) {
      toast.error('Please paste or upload CSV data.');
      return;
    }

    const { users: usersToCreate, errors } = parseBulkCSVText(bulkText);

    const hasErrors = errors.some(err => err.type === 'error');
    if (hasErrors) {
      toast.error('Please fix the syntax errors in your CSV before importing.');
      return;
    }

    if (usersToCreate.length === 0) {
      toast.error('No valid users found in CSV');
      return;
    }

    try {
      setImportStatus({
        isImporting: true,
        progress: 10,
        stage: 'Provisioning user accounts via API...',
        currentCount: 0,
        totalCount: usersToCreate.length
      });

      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken(true) : '';
      
      const response = await fetch('/api/bulk-create-users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ users: usersToCreate })
      });

      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');

      if (!response.ok) {
        let errMsg = `CSV import API failed (HTTP ${response.status}).`;
        if (isJson) {
          try {
            const errObj = await response.json();
            errMsg = errObj.error || errMsg;
          } catch (jsonErr) {}
        } else {
          errMsg = `CSV import API returned an unexpected non-JSON response (HTTP ${response.status} ${response.statusText}). Endpoint: /api/bulk-create-users`;
        }
        throw new Error(errMsg);
      }

      if (!isJson) {
        throw new Error(`CSV import API returned an unexpected HTML/non-JSON response. Endpoint: /api/bulk-create-users, HTTP status: ${response.status}`);
      }

      const resData = await response.json();
      
      // Perform batch writes natively in the browser which has full authorized credentials!
      const totalUsers = resData.createdUsers || [];
      const batchChunksSize = 50; // 50 users = 150 operations, well within Firestore limits of 500
      const updatedProfilesList: any[] = [];

      setImportStatus({
        isImporting: true,
        progress: 25,
        stage: `Account setup complete (${totalUsers.length} users). Writing to Firestore...`,
        currentCount: 0,
        totalCount: totalUsers.length
      });

      const lookupMaps = buildAuthoritativeLookupMaps(allUsers, totalUsers.map((t: any) => ({
        uid: t.uid,
        email: t.email,
        employeeId: t.profile?.employeeId || '',
        name: t.profile?.name || t.profile?.fullName || t.email.split('@')[0],
        fullName: t.profile?.name || t.profile?.fullName || t.email.split('@')[0]
      })));

      const validationRows: any[] = [];
      let validCount = 0;
      let unresolvedTLCount = 0;
      let unresolvedManagerCount = 0;
      let potentialCycleCount = 0;
      let unmappedCount = 0;

      const unresolvedErrors: string[] = [];

      const isObviousDirectCycle = (empUid: string, tlUid: string | null, mgrUid: string | null) => {
        if (tlUid === empUid || mgrUid === empUid) return true;
        if (tlUid) {
          const parent = totalUsers.find((u: any) => u.uid === tlUid) || allUsers.find((u: any) => u.uid === tlUid);
          if (parent) {
            const parentRawTl = parent.teamLeadUid || parent.teamLeadId || parent.tlId || (parent.profile?.teamLeadId);
            const parentTl = normalizeHierarchyReference(parentRawTl, lookupMaps);
            if (parentTl === empUid) return true;
          }
        }
        return false;
      };

      totalUsers.forEach((item: any) => {
        let { uid, email } = item;
        if (!uid) return;
        const emailLower = (email || '').toLowerCase().trim();
        const orig = usersToCreate.find((u: any) => (u.email || '').toLowerCase().trim() === emailLower) || {};
        const existingUser = allUsers.find((u: any) => (u.email || '').toLowerCase().trim() === emailLower);
        if (existingUser && existingUser.uid) {
          uid = existingUser.uid;
        }

        const rawTl = orig.teamLeadRawText;
        const rawMgr = orig.managerRawText;

        const hasTlInput = rawTl && !isPlaceholderValue(rawTl);
        const hasMgrInput = rawMgr && !isPlaceholderValue(rawMgr);

        const explicitClearTL = rawTl && ['CLEAR', 'REMOVE', 'NONE'].includes(rawTl.toString().trim().toUpperCase());
        const explicitClearMgr = rawMgr && ['CLEAR', 'REMOVE', 'NONE'].includes(rawMgr.toString().trim().toUpperCase());

        let resolvedTLUid = normalizeHierarchyReference(rawTl, lookupMaps);
        let resolvedManagerUid = normalizeHierarchyReference(rawMgr, lookupMaps);

        // Blank Protection: Preserve existing canonical hierarchy if uploaded CSV cell is blank
        if (existingUser) {
          const currentTL = existingUser.teamLeadUid || existingUser.teamLeadId || existingUser.tlId;
          const currentMgr = existingUser.mappedManagerUid || existingUser.mappedManagerId || existingUser.managerUid || existingUser.managerId;

          if (!hasTlInput && !explicitClearTL && currentTL) {
            resolvedTLUid = currentTL;
          }
          if (!hasMgrInput && !explicitClearMgr && currentMgr) {
            resolvedManagerUid = currentMgr;
          }
        }

        let resolutionStatus: 'VALID' | 'UNRESOLVED_HIERARCHY' | 'SELF_REFERENCE' | 'CYCLE' | 'UNMAPPED' = 'VALID';
        let unresolvedDetail = '';

        if (hasTlInput && !resolvedTLUid) {
          resolutionStatus = 'UNRESOLVED_HIERARCHY';
          unresolvedDetail = `Unresolved Team Lead: "${rawTl}"`;
          unresolvedTLCount++;
        } else if (hasMgrInput && !resolvedManagerUid) {
          resolutionStatus = 'UNRESOLVED_HIERARCHY';
          unresolvedDetail = `Unresolved Manager: "${rawMgr}"`;
          unresolvedManagerCount++;
        } else if (resolvedTLUid === uid || resolvedManagerUid === uid) {
          resolutionStatus = 'SELF_REFERENCE';
          unresolvedDetail = `Self reference: reports to self`;
          potentialCycleCount++;
        } else if (isObviousDirectCycle(uid, resolvedTLUid, resolvedManagerUid)) {
          resolutionStatus = 'CYCLE';
          unresolvedDetail = `Direct reporting cycle detected`;
          potentialCycleCount++;
        } else if (!resolvedTLUid && !resolvedManagerUid) {
          const roleUpper = (orig.role || existingUser?.role || 'AGENT').toString().toUpperCase().trim();
          const topRoles = ['ADMIN', 'OPS_HEAD', 'MANAGER', 'HR', 'DIRECTOR', 'VP'];
          if (!topRoles.includes(roleUpper)) {
            resolutionStatus = 'UNMAPPED';
            unmappedCount++;
          }
        }

        if (resolutionStatus === 'VALID' || resolutionStatus === 'UNMAPPED') {
          validCount++;
        } else {
          unresolvedErrors.push(`${orig.name || email}: ${unresolvedDetail}`);
        }

        validationRows.push({
          employeeUid: uid,
          resolvedTeamLeadUid: resolvedTLUid,
          resolvedManagerUid: resolvedManagerUid,
          resolutionStatus,
          orig,
          existingUser,
          emailLower
        });
      });

      console.info(`[HIERARCHY BULK IMPORT VALIDATION SUMMARY]
Total rows: ${totalUsers.length}
Valid mappings: ${validCount}
Unresolved Team Leads: ${unresolvedTLCount}
Unresolved Managers: ${unresolvedManagerCount}
Potential cycles: ${potentialCycleCount}
Unmapped users: ${unmappedCount}`);

      const importSummary = `Total rows: ${totalUsers.length} | Valid mappings: ${validCount} | Unresolved Team Leads: ${unresolvedTLCount} | Unresolved Managers: ${unresolvedManagerCount} | Potential cycles: ${potentialCycleCount} | Unmapped users: ${unmappedCount} | Ready to commit: ${unresolvedErrors.length === 0 ? 'YES' : 'NO'}`;

      if (unresolvedErrors.length > 0) {
        const errDetail = unresolvedErrors.slice(0, 10).join('\n');
        const countRemaining = unresolvedErrors.length > 10 ? `\n...and ${unresolvedErrors.length - 10} more` : '';
        throw new Error(`[HIERARCHY VALIDATION FAILURE]\n${importSummary}\n\nErrors:\n${errDetail}${countRemaining}`);
      }

      for (let i = 0; i < totalUsers.length; i += batchChunksSize) {
        const chunk = totalUsers.slice(i, i + batchChunksSize);
        const batch = writeBatch(db);

        chunk.forEach((item: any) => {
          let { uid, email } = item;
          if (!uid) return;
          const emailLower = (email || '').toLowerCase().trim();
          const row = validationRows.find(r => r.emailLower === emailLower);
          if (!row) return;

          const orig = row.orig;
          const existingUser = row.existingUser;
          const resolvedTLUid = row.resolvedTeamLeadUid;
          const resolvedManagerUid = row.resolvedManagerUid;

          const hierarchyPayload = getHierarchyPersistencePayload({
            userUid: uid,
            teamLeadUid: resolvedTLUid,
            managerUid: resolvedManagerUid,
            allUsers: [...allUsers, ...totalUsers.map((t: any) => ({
              uid: t.uid,
              email: t.email,
              employeeId: t.profile?.employeeId || '',
              name: t.profile?.name || t.profile?.fullName || t.email.split('@')[0],
              fullName: t.profile?.name || t.profile?.fullName || t.email.split('@')[0]
            }))]
          });

          // Clean the input status to preserve existing membership on blank/invalid/presence-type statuses
          const rawOrigStatus = (orig.status || '').toString().trim().toLowerCase();
          
          let isMembershipActive = true;
          if (existingUser) {
            // Default to existing membership state
            isMembershipActive = existingUser.isActive !== false && existingUser.status !== 'Inactive' && existingUser.status !== 'Suspended';
          }
          
          if (rawOrigStatus === 'active') {
            isMembershipActive = true;
          } else if (rawOrigStatus === 'inactive' || rawOrigStatus === 'suspended') {
            isMembershipActive = false;
          } // Any other status (blank, ONLINE, OFFLINE, BREAK, IDLE, invalid) preserves the existing state
          
          const resolvedStatus = isMembershipActive ? 'Active' : 'Inactive';
          const resolvedIsActive = isMembershipActive;

          if (existingUser) {
            if (resolvedStatus !== (existingUser.status || (existingUser.isActive === false ? 'Inactive' : 'Active'))) {
              console.info(`[USER STATUS CHANGE] uid=${uid} old=${existingUser.status || (existingUser.isActive === false ? 'Inactive' : 'Active')} new=${resolvedStatus} source=UserManagementSubView.handleUploadConfirm_CSVImport`);
            }
          } else {
            console.info(`[USER STATUS CHANGE] uid=${uid} old=NONE new=${resolvedStatus} source=UserManagementSubView.handleUploadConfirm_CSVImport`);
          }

          let resolvedNotes = orig.notes || existingUser?.notes || '';
          if (resolvedStatus.toLowerCase() === 'inactive' || resolvedIsActive === false) {
            if (existingUser && (existingUser.status?.toLowerCase() === 'active' || existingUser.isActive === true)) {
              resolvedNotes = appendInactiveReasonNote(
                existingUser.notes,
                orig.notes || 'Status marked Inactive via CSV Roster Import',
                auth.currentUser?.email,
                'CSV'
              );
            } else if (!existingUser) {
              resolvedNotes = appendInactiveReasonNote(
                orig.notes,
                orig.notes || 'Imported as Inactive via CSV Roster',
                auth.currentUser?.email,
                'CSV'
              );
            } else if (orig.notes && orig.notes !== existingUser.notes) {
              resolvedNotes = appendInactiveReasonNote(
                existingUser.notes,
                orig.notes,
                auth.currentUser?.email,
                'CSV'
              );
            }
          } else if (existingUser && (existingUser.status?.toLowerCase() === 'inactive' || existingUser.isActive === false) && (resolvedStatus.toLowerCase() === 'active')) {
            resolvedNotes = appendActiveReasonNote(
              existingUser.notes,
              'Status restored to Active via CSV Roster Import',
              auth.currentUser?.email,
              'CSV'
            );
          }

          const finalProfile = {
            uid: uid,
            email: email,
            role: orig.role || existingUser?.role || 'AGENT',
            fullName: orig.name || existingUser?.fullName || existingUser?.name || '',
            name: orig.name || existingUser?.name || existingUser?.fullName || '',
            employeeId: orig.employeeId || existingUser?.employeeId || '',
            department: orig.department || existingUser?.department || 'Operations',
            process: orig.process || existingUser?.process || '',
            dateJoined: orig.dateJoined || existingUser?.dateJoined || '',
            notes: resolvedNotes,
            createdAt: existingUser?.createdAt || new Date().toISOString(),
            status: resolvedStatus,
            isActive: resolvedIsActive,
            location: orig.location || existingUser?.location || '',
            ...hierarchyPayload
          };

          const masterDoc = {
            employeeId: orig.employeeId || existingUser?.employeeId || '',
            employeeName: orig.name || existingUser?.fullName || existingUser?.name || '',
            email: email,
            role: orig.role || existingUser?.role || 'AGENT',
            department: orig.department || existingUser?.department || 'Operations',
            process: orig.process || existingUser?.process || '',
            status: resolvedStatus,
            notes: resolvedNotes,
            dateJoined: orig.dateJoined || existingUser?.dateJoined || '',
            lastUpdated: new Date().toISOString(),
            location: orig.location || existingUser?.location || '',
            ...hierarchyPayload
          };

          const mappingDoc = {
            userId: uid,
            userName: orig.name || existingUser?.fullName || existingUser?.name || '',
            process: orig.process || existingUser?.process || '',
            lastUpdated: new Date().toISOString(),
            ...hierarchyPayload
          };

          const cleanedProfile = cleanUserProfile(finalProfile);
          updatedProfilesList.push(cleanedProfile);

          batch.set(doc(db, 'users', uid), cleanedProfile, { merge: true });
          batch.set(doc(db, 'employee_master', uid), masterDoc, { merge: true });
          batch.set(doc(db, 'teamMappings', uid), mappingDoc, { merge: true });

          const pVal = orig.process || existingUser?.process || '';
          if (pVal) {
            batch.set(doc(db, 'live_sessions', uid), {
              uid: uid,
              userId: uid,
              process: pVal,
              currentProcess: pVal,
              isOnline: false
            }, { merge: true });
          }
        });

        await batch.commit();
        const completedCount = Math.min(i + batchChunksSize, totalUsers.length);
        const progressPct = totalUsers.length > 0 ? Math.round(25 + ((completedCount / totalUsers.length) * 60)) : 85;

        setImportStatus({
          isImporting: true,
          progress: progressPct,
          stage: `Syncing Firestore database records (${completedCount}/${totalUsers.length})...`,
          currentCount: completedCount,
          totalCount: totalUsers.length
        });

        console.log(`[CLIENT ROSTER BATCH] Committed user profiles block: ${i} to ${completedCount}`);
      }

      // Forensic verification block immediately after all batch commits complete
      let persistenceMismatches = 0;
      let verifyCount = 0;

      const verifyPromises = totalUsers.map(async (item: any) => {
        let { uid, email } = item;
        if (!uid) return;
        const emailLower = (email || '').toLowerCase().trim();
        const row = validationRows.find(r => r.emailLower === emailLower);
        if (!row) return;

        const expectedTL = row.resolvedTeamLeadUid || '';
        const expectedMgr = row.resolvedManagerUid || '';

        const snap = await getDoc(doc(db, 'employee_master', uid));
        if (snap.exists()) {
          verifyCount++;
          const data = snap.data();
          const dbTLUid = data.teamLeadUid || '';
          const dbMgrUid = data.managerUid || '';
          const dbTLId = data.teamLeadId || '';
          const dbMgrId = data.managerId || '';

          if (dbTLUid !== expectedTL || dbMgrUid !== expectedMgr || dbTLId !== expectedTL || dbMgrId !== expectedMgr) {
            console.error(`[HIERARCHY PERSISTENCE MISMATCH] for ${uid}:`, {
              dbTLUid, expectedTL, dbMgrUid, expectedMgr, dbTLId, dbMgrId
            });
            persistenceMismatches++;
          }
        }
      });

      await Promise.all(verifyPromises);

      console.info(`[HIERARCHY BULK VERIFY]
affected=${totalUsers.length}
canonicalMappings=${validCount}
unmapped=${unmappedCount}
invalid=${potentialCycleCount}
cycles=${potentialCycleCount}
persistenceMismatches=${persistenceMismatches}`);

      if (persistenceMismatches > 0) {
        throw new Error(`[HIERARCHY BULK VERIFY FAILURE] Detected ${persistenceMismatches} persistence mismatches after commit. Operation aborted.`);
      }
      
      setImportStatus({
        isImporting: true,
        progress: 90,
        stage: 'Reconciling local roster state & updating caches...',
        currentCount: totalUsers.length,
        totalCount: totalUsers.length
      });

      if (resData.errors && resData.errors.length > 0) {
        console.error('Bulk upload had some errors:', resData.errors);
        toast.warning(`Uploaded with ${resData.errors.length} errors. Check console.`);
      } else {
        toast.success(`Successfully updated/initialized ${totalUsers.length} user profiles.`);
      }

      logAdminEvent('CSV Roster Upload', `${totalUsers.length} batch entries`, 'Blank', 'Roster update/creation sync');

      if (updatedProfilesList.length > 0) {
        await updateMultipleUsersInRoster(updatedProfilesList);
        try {
          await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
        } catch (cacheErr) {
          console.warn('[CSV IMPORT] Subordinate cache clear skipped/failed:', cacheErr);
        }
      }

      setImportStatus({
        isImporting: true,
        progress: 100,
        stage: 'Import & sync complete!',
        currentCount: totalUsers.length,
        totalCount: totalUsers.length
      });

      setTimeout(() => {
        setIsBulkOpen(false);
        setBulkText('');
        setImportStatus({
          isImporting: false,
          progress: 0,
          stage: '',
          currentCount: 0,
          totalCount: 0
        });
      }, 750);

    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'CSV Import processing failed.');
      setImportStatus({
        isImporting: false,
        progress: 0,
        stage: '',
        currentCount: 0,
        totalCount: 0
      });
    }
  };

  // Helper helper to get values robustly
  function existedOrEmpty(userObj: any, fieldKey: string): string {
    if (!userObj) return '';
    return userObj[fieldKey] || '';
  }

  const handleNotesSave = async () => {
    if (!isNotesOpen) return;
    try {
      const nowISO = new Date().toISOString();
      await setDoc(doc(db, 'users', isNotesOpen.uid), {
        notes: editingNotes,
        lastModifiedAt: nowISO
      }, { merge: true });
      await setDoc(doc(db, 'employee_master', isNotesOpen.uid), {
        notes: editingNotes,
        lastUpdated: nowISO
      }, { merge: true });
      toast.success('Professional note mapped successfully.');
      const targetUid = isNotesOpen.uid;
      setIsNotesOpen(null);
      await updateUserInRoster({ uid: targetUid, notes: editingNotes });
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
            <button 
              onClick={handleFetchGlobalRoster} 
              disabled={isFetchingGlobalRoster}
              className="px-3 py-2 text-xs font-bold rounded-lg cursor-pointer bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white flex items-center gap-1.5 shadow-sm transition-all"
              title="Fetch global users collection from database (1-time fetch) and store in cache until manually re-fetched"
            >
              <RefreshCw size={14} className={isFetchingGlobalRoster ? 'animate-spin' : ''} />
              {isFetchingGlobalRoster ? 'Fetching Global Roster...' : 'Fetch Global Roster'}
            </button>
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
        <div className="flex flex-col gap-2 p-4 rounded-2xl bg-slate-50 border border-slate-200 dark:bg-slate-800/40 dark:border-slate-700/60">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            <div>
              <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Company Role</label>
              <select 
                value={roleFilter} 
                onChange={e => { setRoleFilter(e.target.value); setPage(0); }} 
                className={adminTheme === 'dark' ? 'w-full bg-slate-800 text-xs px-2 py-1.5 rounded-lg border border-slate-700' : 'w-full bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-200'}
              >
                <option value="">All Roles</option>
                {dynamicRoles.map(role => (
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
              <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Login Access</label>
              <select 
                value={loginAccessFilter} 
                onChange={e => { setLoginAccessFilter(e.target.value); setPage(0); }} 
                className={adminTheme === 'dark' ? 'w-full bg-slate-800 text-xs px-2 py-1.5 rounded-lg border border-slate-700' : 'w-full bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-200'}
              >
                <option value="">All Access</option>
                <option value="allowed">Allowed (Normal)</option>
                <option value="restricted">⛔ Restricted</option>
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

            <div>
              <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Employee Location</label>
              <select 
                value={locationFilter} 
                onChange={e => { setLocationFilter(e.target.value); setPage(0); }} 
                className={adminTheme === 'dark' ? 'w-full bg-slate-800 text-xs px-2 py-1.5 rounded-lg border border-slate-700' : 'w-full bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-200'}
              >
                <option value="">All Locations</option>
                {locations.map(loc => (
                  <option key={loc} value={loc}>{loc}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Team Lead</label>
              <select 
                value={tlFilter} 
                onChange={e => { setTlFilter(e.target.value); setPage(0); }} 
                className={adminTheme === 'dark' ? 'w-full bg-slate-800 text-xs px-2 py-1.5 rounded-lg border border-slate-700 font-medium text-amber-500 dark:text-amber-400' : 'w-full bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-200 font-medium text-amber-600'}
              >
                <option value="">All Team Leads</option>
                {teamLeadsList.map(tl => (
                  <option key={tl.id} value={tl.id}>{tl.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Manager</label>
              <select 
                value={managerFilter} 
                onChange={e => { setManagerFilter(e.target.value); setPage(0); }} 
                className={adminTheme === 'dark' ? 'w-full bg-slate-800 text-xs px-2 py-1.5 rounded-lg border border-slate-700 font-medium text-indigo-400' : 'w-full bg-white text-xs px-2 py-1.5 rounded-lg border border-slate-200 font-medium text-indigo-600'}
              >
                <option value="">All Managers</option>
                {managersList.map(mgr => (
                  <option key={mgr.id} value={mgr.id}>{mgr.name}</option>
                ))}
              </select>
            </div>
          </div>

          {(roleFilter || statusFilter || loginAccessFilter || deptFilter || procFilter || locationFilter || tlFilter || managerFilter || searchTerm) && (
            <div className="flex justify-end pt-1">
              <button
                onClick={() => {
                  setRoleFilter('');
                  setStatusFilter('');
                  setLoginAccessFilter('');
                  setDeptFilter('');
                  setProcFilter('');
                  setLocationFilter('');
                  setTlFilter('');
                  setManagerFilter('');
                  setSearchTerm('');
                  setPage(0);
                }}
                className="text-[11px] font-bold text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 cursor-pointer flex items-center gap-1 transition-colors"
              >
                ✕ Clear All Filters
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bulk Utilities Bar */}
      {selectedUids.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-indigo-500/10 border border-indigo-400/40 rounded-xl text-xs font-semibold">
          <div className="flex items-center gap-2">
            <CheckSquare size={16} className="text-indigo-500 shrink-0" />
            <span>Selected <strong className="text-indigo-600 dark:text-indigo-400 font-bold">{selectedUids.size}</strong> profiles:</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => handleBulkStatusChange('Active')} className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer transition-colors text-[11px] shadow-xs">
              Set Active
            </button>
            <button onClick={() => handleBulkStatusChange('Inactive')} className="px-2.5 py-1 rounded-lg bg-slate-600 hover:bg-slate-700 text-white font-bold cursor-pointer transition-colors text-[11px] shadow-xs">
              Set Inactive
            </button>
            <div className="h-4 w-px bg-slate-300 dark:bg-slate-700 mx-0.5" />
            <button onClick={() => setIsBulkRestrictOpen(true)} className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold cursor-pointer transition-colors text-[11px] flex items-center gap-1 shadow-xs">
              <Lock size={12} /> Restrict Login
            </button>
            <button onClick={handleBulkUnrestrict} className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-bold cursor-pointer transition-colors text-[11px] flex items-center gap-1 shadow-xs">
              <Unlock size={12} /> Allow Login
            </button>
            <div className="h-4 w-px bg-slate-300 dark:bg-slate-700 mx-0.5" />
            <button onClick={() => setIsBulkDeleteOpen(true)} className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold cursor-pointer transition-colors text-[11px] flex items-center gap-1 shadow-xs">
              <Trash2 size={12} /> Delete Selected
            </button>
          </div>
        </div>
      )}

      {/* Directory Table Grid */}
      <div className={`overflow-hidden border rounded-2xl ${adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
        <div className="overflow-auto max-h-[650px] scrollbar-thin">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={`sticky top-0 z-10 shadow-xs backdrop-blur-sm ${adminTheme === 'dark' ? 'bg-slate-800 text-slate-305 font-bold uppercase text-[10px]' : 'bg-slate-50 text-slate-505 font-bold uppercase text-[10px]'}`}>
              <tr>
                <th className="p-4 w-10 text-center">
                  <button onClick={toggleSelectAll} className="p-0.5 text-slate-400 cursor-pointer">
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
                <th className="p-4 font-bold">Location</th>
                <th className="p-4 font-bold">Process</th>
                <th className="p-4 font-bold">Team Lead</th>
                <th className="p-4 font-bold">Manager</th>
                <th className="p-4 font-bold cursor-pointer text-center" onClick={() => handleSort('dateJoined')}>
                  <span className="flex items-center gap-1 justify-center">Join Date <ArrowUpDown size={11} /></span>
                </th>
                <th className="p-4 text-center">Last Login</th>
                <th className="p-4 text-center">Account State</th>
                <th className="p-4 text-center">Login Access</th>
                <th className="p-4 text-center">Files / Notes</th>
                <th className="p-4 text-right pr-6">Manage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {paginatedUsers.length > 0 ? (
                paginatedUsers.map(user => {
                  const isActive = user.status?.toLowerCase() === 'active' || user.isActive === true;
                  const isRestricted = user.loginRestricted === true || user.isRestricted === true || user.isLoginRestricted === true || user.status === 'Restricted';
                  const isChecked = selectedUids.has(user.uid);
                  return (
                    <tr key={user.uid} className={adminTheme === 'dark' ? 'hover:bg-slate-800/30' : 'hover:bg-slate-50/50'}>
                      <td className="p-4 text-center">
                        <button onClick={() => toggleSelect(user.uid)} className="p-0.5 text-slate-400 cursor-pointer">
                          {isChecked ? <CheckSquare size={15} className="text-indigo-500" /> : <Square size={15} />}
                        </button>
                      </td>
                      <td className="p-4 font-mono font-bold">{user.employeeId || 'E-N/A'}</td>
                      <td className="p-4 font-extrabold text-[#0F172A] dark:text-slate-100 uppercase">
                        <div className="flex items-center gap-2">
                           <div className="w-6 h-6 rounded-full overflow-hidden bg-slate-100 flex items-center justify-center font-bold text-[10px] text-slate-400 border border-slate-200 shrink-0">
                             {user.photoURL ? (
                               <img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                             ) : (
                               (user.fullName || user.name || '??').split(' ').map((n: string) => n[0]).slice(0, 2).join('')
                             )}
                           </div>
                           <span>{user.fullName || user.name}</span>
                        </div>
                      </td>
                      <td className="p-4 text-slate-400 dark:text-slate-500 font-semibold">{user.email}</td>
                      <td className="p-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          ['ADMIN'].includes((user.role || '').toUpperCase()) ? 'bg-red-500/10 text-red-500' :
                          ['MANAGER', 'ASSISTANT_MANAGER'].includes((user.role || '').toUpperCase()) ? 'bg-indigo-500/10 text-indigo-500' :
                          ['TEAM_LEAD', 'STL', 'QTL', 'OPS_TL', 'TEAM LEAD'].includes((user.role || '').toUpperCase()) ? 'bg-amber-500/10 text-amber-500' :
                          (user.role || '').toUpperCase() === 'QA' ? 'bg-blue-500/10 text-blue-500' : 'bg-emerald-500/10 text-emerald-500'
                        }`}>
                          {user.role}
                        </span>
                      </td>
                      <td className="p-4 font-medium opacity-85">{user.department || 'Operations'}</td>
                      <td className="p-4 font-bold text-indigo-600 dark:text-indigo-400 opacity-90">{user.location || 'N/A'}</td>
                      <td className="p-4 font-mono font-bold opacity-85">{user.process || 'Commonpool'}</td>
                      <td className="p-4 font-medium text-slate-500 dark:text-slate-400">
                        {(() => {
                          const tlUid = user.teamLeadUid || user.teamLeadId || user.mappedTL || '';
                          if (tlUid) {
                            const found = (allUsers || []).find((u: any) => u.uid === tlUid) || (globalRoster || []).find((u: any) => u.uid === tlUid);
                            if (found) return found.fullName || found.name || found.employeeName;
                          }
                          return user.teamLeadName || 'N/A';
                        })()}
                      </td>
                      <td className="p-4 font-medium text-slate-500 dark:text-slate-400">
                        {(() => {
                          const mgrUid = user.mappedManagerUid || user.mappedManagerId || user.managerId || '';
                          if (mgrUid) {
                            const found = (allUsers || []).find((u: any) => u.uid === mgrUid) || (globalRoster || []).find((u: any) => u.uid === mgrUid);
                            if (found) return found.fullName || found.name || found.employeeName;
                          }
                          return user.mappedManagerName || user.managerName || user.Manager || 'N/A';
                        })()}
                      </td>
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
                          title={isActive ? 'Click to deactivate profile' : 'Click to activate profile'}
                        >
                          <span 
                            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              isActive ? 'translate-x-4' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </td>

                      {/* Login Access Status */}
                      <td className="p-4 text-center">
                        {isRestricted ? (
                          <button
                            onClick={() => handleUnrestrictUser(user)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors cursor-pointer"
                            title={`Login Restricted: ${user.restrictedReason || 'Administrative Block'}. Click to lift restriction.`}
                          >
                            <Lock size={10} className="shrink-0" />
                            <span>Restricted</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => handleOpenRestrictUser(user)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors cursor-pointer"
                            title="Login Allowed. Click to restrict login access."
                          >
                            <ShieldCheck size={10} className="shrink-0" />
                            <span>Allowed</span>
                          </button>
                        )}
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
                        <div className="flex items-center justify-end gap-1">
                          {isRestricted ? (
                            <button 
                              onClick={() => handleUnrestrictUser(user)}
                              className="p-1.5 text-amber-500 hover:text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-colors cursor-pointer"
                              title="Restore Login Access"
                            >
                              <Unlock size={14} />
                            </button>
                          ) : (
                            <button 
                              onClick={() => handleOpenRestrictUser(user)}
                              className="p-1.5 text-slate-400 hover:text-amber-500 hover:bg-amber-500/10 rounded-lg transition-colors cursor-pointer"
                              title="Restrict User Login"
                            >
                              <Lock size={14} />
                            </button>
                          )}
                          <button 
                            onClick={() => handleEditUserOpen(user)}
                            className="p-1.5 text-slate-400 hover:text-indigo-500 hover:bg-indigo-500/10 rounded-lg transition-colors cursor-pointer"
                            title="Edit User Profile"
                          >
                            <Edit3 size={14} />
                          </button>
                          <button 
                            onClick={() => handleOpenDeleteUser(user)}
                            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
                            title="Permanently Delete User Profile"
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
                  <td colSpan={16} className="p-12 text-center text-slate-400 font-semibold text-xs animate-pulse">
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
          <div className={`max-w-lg w-full border shadow-2xl rounded-2xl overflow-hidden p-6 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex justify-between items-center mb-3">
              <h4 className="text-sm font-extrabold uppercase tracking-wider flex items-center gap-2">
                <FileText size={16} className="text-indigo-500" /> Personnel Folder & Status Audit Notes
              </h4>
              <button onClick={() => setIsNotesOpen(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-2 font-mono">Profile: {isNotesOpen.fullName || isNotesOpen.name} ({isNotesOpen.email})</p>
            <div className="mb-3 text-[11px] text-slate-500 flex items-center justify-between">
              <span>Status change audit log & remarks:</span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                isNotesOpen.status?.toLowerCase() === 'active' || isNotesOpen.isActive === true
                  ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                  : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
              }`}>
                {isNotesOpen.status || (isNotesOpen.isActive === false ? 'Inactive' : 'Active')}
              </span>
            </div>
            <textarea 
              rows={8} 
              value={editingNotes}
              onChange={e => setEditingNotes(e.target.value)}
              placeholder="Input specialized team remarks, system overrides, HR tags, or status reason notes..."
              className={`w-full text-xs font-mono p-3 border rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 leading-relaxed ${
                adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setIsNotesOpen(null)} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 cursor-pointer">Cancel</button>
              <button onClick={handleNotesSave} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer">Save Employee Remark</button>
            </div>
          </div>
        </div>
      )}

      {/* Single User Inactivation Confirmation Modal */}
      {singleInactivateUser && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`max-w-md w-full border shadow-2xl rounded-2xl p-6 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-900'}`}>
            <div className="flex items-center gap-3 border-b pb-3 mb-4 border-rose-500/20">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
                <AlertTriangle size={20} />
              </div>
              <div>
                <h4 className="text-sm font-extrabold uppercase tracking-wide text-rose-600 dark:text-rose-400">
                  Mark Employee Inactive
                </h4>
                <p className="text-xs text-slate-400">An inactivation reason will be logged in employee notes</p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-900/60 mb-4 text-xs space-y-1">
              <div className="font-bold text-slate-700 dark:text-slate-200">{singleInactivateUser.fullName || singleInactivateUser.name}</div>
              <div className="text-slate-400 font-mono text-[11px]">{singleInactivateUser.email} {singleInactivateUser.employeeId ? `• ${singleInactivateUser.employeeId}` : ''}</div>
              <div className="text-slate-400 text-[11px]">Role: <span className="font-semibold text-slate-300">{singleInactivateUser.role}</span> • Dept: <span className="font-semibold text-slate-300">{singleInactivateUser.department || 'Operations'}</span></div>
            </div>

            <div className="space-y-3 mb-5">
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                  Select Reason:
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {INACTIVE_REASON_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setSingleInactivatePreset(preset);
                        if (preset !== 'Other / Custom') {
                          setSingleInactivateReason(preset);
                        }
                      }}
                      className={`text-[11px] px-2.5 py-1 rounded-lg border font-medium transition-all ${
                        singleInactivatePreset === preset
                          ? 'bg-rose-600 text-white border-rose-600 shadow-sm'
                          : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-rose-300'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                  Reason Note: <span className="text-rose-500">*</span>
                </label>
                <textarea
                  rows={3}
                  value={singleInactivateReason}
                  onChange={e => setSingleInactivateReason(e.target.value)}
                  placeholder="Enter details of inactivation to be recorded in employee notes..."
                  className={`w-full text-xs p-2.5 border rounded-xl focus:outline-none focus:ring-1 focus:ring-rose-500 ${
                    adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
                  }`}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs pt-2 border-t border-slate-100 dark:border-slate-700">
              <button
                type="button"
                onClick={() => {
                  setSingleInactivateUser(null);
                  setSingleInactivateReason('');
                }}
                disabled={isSubmittingInactivation}
                className="px-3.5 py-2 font-bold rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmSingleInactivation}
                disabled={isSubmittingInactivation || (!singleInactivateReason.trim() && !singleInactivatePreset)}
                className="px-4 py-2 font-bold rounded-xl bg-rose-600 hover:bg-rose-700 text-white cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                {isSubmittingInactivation ? 'Saving...' : 'Confirm Inactivation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Inactivation Modal */}
      {isBulkInactivateOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`max-w-md w-full border shadow-2xl rounded-2xl p-6 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-900'}`}>
            <div className="flex items-center gap-3 border-b pb-3 mb-4 border-rose-500/20">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
                <AlertTriangle size={20} />
              </div>
              <div>
                <h4 className="text-sm font-extrabold uppercase tracking-wide text-rose-600 dark:text-rose-400">
                  Bulk Inactivate ({selectedUids.size} Profiles)
                </h4>
                <p className="text-xs text-slate-400">A reason will be logged in notes for each selected user</p>
              </div>
            </div>

            <div className="space-y-3 mb-5">
              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                  Select Common Reason:
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {INACTIVE_REASON_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setBulkInactivatePreset(preset);
                        if (preset !== 'Other / Custom') {
                          setBulkInactivateReason(preset);
                        }
                      }}
                      className={`text-[11px] px-2.5 py-1 rounded-lg border font-medium transition-all ${
                        bulkInactivatePreset === preset
                          ? 'bg-rose-600 text-white border-rose-600 shadow-sm'
                          : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-rose-300'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                  Reason for Bulk Inactivation: <span className="text-rose-500">*</span>
                </label>
                <textarea
                  rows={3}
                  value={bulkInactivateReason}
                  onChange={e => setBulkInactivateReason(e.target.value)}
                  placeholder="Enter reason for bulk inactivation to be recorded in employee notes..."
                  className={`w-full text-xs p-2.5 border rounded-xl focus:outline-none focus:ring-1 focus:ring-rose-500 ${
                    adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
                  }`}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs pt-2 border-t border-slate-100 dark:border-slate-700">
              <button
                type="button"
                onClick={() => {
                  setIsBulkInactivateOpen(false);
                  setBulkInactivateReason('');
                }}
                disabled={isSubmittingInactivation}
                className="px-3.5 py-2 font-bold rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmBulkInactivation}
                disabled={isSubmittingInactivation || (!bulkInactivateReason.trim() && !bulkInactivatePreset)}
                className="px-4 py-2 font-bold rounded-xl bg-rose-600 hover:bg-rose-700 text-white cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                {isSubmittingInactivation ? 'Saving...' : `Inactivate ${selectedUids.size} Users`}
              </button>
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
                  {dynamicRoles.map(role => (
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
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Employee Location</label>
                <select 
                  value={newForm.location || ''} 
                  onChange={e => setNewForm({...newForm, location: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg text-slate-350 text-xs' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650 text-xs'}
                >
                  <option value="">Select Location...</option>
                  <option value="Dehradun (DDN)">Dehradun (DDN)</option>
                  <option value="Jammu (JMU)">Jammu (JMU)</option>
                  <option value="Bangalore (BLR)">Bangalore (BLR)</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Product Campaign / Process</label>
                <select 
                  value={newForm.process} 
                  onChange={e => setNewForm({...newForm, process: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg text-slate-350 text-xs' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650 text-xs'}
                >
                  <option value="">Select Process / Campaign...</option>
                  {registeredProcesses.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5 uppercase tracking-widest pl-1">Team Lead</label>
                <UserPicker 
                  allUsers={allUsers}
                  onSelect={(u) => {
                    setNewForm({
                      ...newForm, 
                      teamLeadName: u ? (u.fullName || u.name || u.employeeName || '') : '', 
                      teamLeadUid: u ? (u.uid || '') : ''
                    });
                  }}
                  selectedUserId={newForm.teamLeadUid}
                  placeholder="Map Team Lead..."
                  roleFilter={['Team Lead', 'TEAM LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'MANAGER', 'ASSISTANT_MANAGER', 'ADMIN', 'OPS_TEAM_LEAD', 'TEAM_LEADER']}
                  className="mt-1"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5 uppercase tracking-widest pl-1">Mapped Manager</label>
                <UserPicker 
                  allUsers={allUsers}
                  onSelect={(u) => setNewForm({
                    ...newForm, 
                    mappedManagerName: u ? (u.fullName || u.name || u.employeeName || '') : '', 
                    mappedManagerUid: u ? (u.uid || '') : ''
                  })}
                  selectedUserId={newForm.mappedManagerUid}
                  placeholder="Map Manager..."
                  roleFilter={['MANAGER', 'ASSISTANT_MANAGER', 'OPS_MANAGER', 'PROJECT_MANAGER', 'SR_MANAGER', 'ADMIN', 'SUPER_ADMIN', 'OPS_HEAD', 'MANAGER / LEAD', 'Manager', 'Assistant Manager', 'Admin']}
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

              {newForm.status === 'Inactive' && (
                <div className="col-span-2 p-2.5 rounded-xl border border-rose-500/20 bg-rose-500/5 space-y-2">
                  <label className="block text-[10px] font-bold text-rose-500 uppercase tracking-wider">
                    Inactivation Reason (Will be saved to Notes) <span className="text-rose-500">*</span>
                  </label>
                  <div className="flex flex-wrap gap-1">
                    {INACTIVE_REASON_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          setNewUserInactivePreset(p);
                          if (p !== 'Other / Custom') setNewUserInactiveReason(p);
                        }}
                        className={`text-[10px] px-2 py-0.5 rounded border transition-all ${
                          newUserInactivePreset === p
                            ? 'bg-rose-600 text-white border-rose-600'
                            : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <input
                    value={newUserInactiveReason}
                    onChange={e => setNewUserInactiveReason(e.target.value)}
                    placeholder="Enter reason for inactive status..."
                    className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 text-xs border border-slate-700 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 text-xs rounded-lg'}
                  />
                </div>
              )}

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Login Access Policy</label>
                <select 
                  value={newForm.loginRestricted ? 'Restricted' : 'Allowed'} 
                  onChange={e => setNewForm({...newForm, loginRestricted: e.target.value === 'Restricted'})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-705 rounded-lg text-slate-350' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650'}
                >
                  <option value="Allowed">Allowed (Normal Login)</option>
                  <option value="Restricted">⛔ Restricted (Block Login)</option>
                </select>
              </div>

              {newForm.loginRestricted && (
                <div className="col-span-2 p-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5 space-y-1.5">
                  <label className="block text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider flex items-center gap-1">
                    <Lock size={12} /> Login Restriction Reason
                  </label>
                  <input
                    value={newForm.restrictedReason || ''}
                    onChange={e => setNewForm({...newForm, restrictedReason: e.target.value})}
                    placeholder="Enter reason for blocking login access..."
                    className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 text-xs border border-slate-700 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 text-xs rounded-lg'}
                  />
                </div>
              )}

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
                  {dynamicRoles.map(role => (
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
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Employee Location</label>
                <select 
                  value={editForm.location || ''} 
                  onChange={e => setEditForm({...editForm, location: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg text-slate-350 text-xs' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650 text-xs'}
                >
                  <option value="">Select Location...</option>
                  <option value="Dehradun (DDN)">Dehradun (DDN)</option>
                  <option value="Jammu (JMU)">Jammu (JMU)</option>
                  <option value="Bangalore (BLR)">Bangalore (BLR)</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Product Campaign / Process</label>
                <select 
                  value={editForm.process} 
                  onChange={e => setEditForm({...editForm, process: e.target.value})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg text-slate-350 text-xs' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650 text-xs'}
                >
                  <option value="">Select Process / Campaign...</option>
                  {registeredProcesses.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1 uppercase tracking-widest pl-1">Team Lead Mapping</label>
                <UserPicker 
                  allUsers={allUsers}
                  onSelect={(u) => {
                    setEditForm({
                      ...editForm, 
                      teamLeadName: u ? (u.fullName || u.name || u.employeeName || '') : '', 
                      teamLeadUid: u ? (u.uid || '') : ''
                    });
                  }}
                  selectedUserId={editForm.teamLeadUid}
                  placeholder="Reassign Team Lead..."
                  roleFilter={['Team Lead', 'TEAM LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'MANAGER', 'ASSISTANT_MANAGER', 'ADMIN', 'OPS_TEAM_LEAD', 'TEAM_LEADER']}
                  className="mt-1"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1 uppercase tracking-widest pl-1">Manager Mapping</label>
                <UserPicker 
                  allUsers={allUsers}
                  onSelect={(u) => setEditForm({
                    ...editForm, 
                    mappedManagerName: u ? (u.fullName || u.name || u.employeeName || '') : '', 
                    mappedManagerUid: u ? (u.uid || '') : ''
                  })}
                  selectedUserId={editForm.mappedManagerUid}
                  placeholder="Reassign Manager..."
                  roleFilter={['MANAGER', 'ASSISTANT_MANAGER', 'OPS_MANAGER', 'PROJECT_MANAGER', 'SR_MANAGER', 'ADMIN', 'SUPER_ADMIN', 'OPS_HEAD', 'MANAGER / LEAD', 'Manager', 'Assistant Manager', 'Admin']}
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

              {editForm.status === 'Inactive' && (
                <div className="col-span-2 p-2.5 rounded-xl border border-rose-500/20 bg-rose-500/5 space-y-2">
                  <label className="block text-[10px] font-bold text-rose-500 uppercase tracking-wider">
                    Inactivation Reason (Will be appended to Notes) <span className="text-rose-500">*</span>
                  </label>
                  <div className="flex flex-wrap gap-1">
                    {INACTIVE_REASON_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          setEditInactivePreset(p);
                          if (p !== 'Other / Custom') setEditInactiveReason(p);
                        }}
                        className={`text-[10px] px-2 py-0.5 rounded border transition-all ${
                          editInactivePreset === p
                            ? 'bg-rose-600 text-white border-rose-600'
                            : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <input
                    value={editInactiveReason}
                    onChange={e => setEditInactiveReason(e.target.value)}
                    placeholder="Enter reason for inactive status..."
                    className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 text-xs border border-slate-700 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 text-xs rounded-lg'}
                  />
                </div>
              )}

              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-0.5">Login Access Policy</label>
                <select 
                  value={editForm.loginRestricted ? 'Restricted' : 'Allowed'} 
                  onChange={e => setEditForm({...editForm, loginRestricted: e.target.value === 'Restricted'})} 
                  className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 border border-slate-700 rounded-lg text-slate-350' : 'w-full bg-white border border-slate-200 p-2 rounded-lg text-slate-650'}
                >
                  <option value="Allowed">Allowed (Normal Login)</option>
                  <option value="Restricted">⛔ Restricted (Block Login)</option>
                </select>
              </div>

              {editForm.loginRestricted && (
                <div className="col-span-2 p-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5 space-y-1.5">
                  <label className="block text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider flex items-center gap-1">
                    <Lock size={12} /> Login Restriction Reason
                  </label>
                  <input
                    value={editForm.restrictedReason || ''}
                    onChange={e => setEditForm({...editForm, restrictedReason: e.target.value})}
                    placeholder="Enter reason for blocking login access..."
                    className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2 text-xs border border-slate-700 rounded-lg' : 'w-full bg-white border border-slate-200 p-2 text-xs rounded-lg'}
                  />
                </div>
              )}

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
              <h4 className="text-sm font-extrabold uppercase tracking-wider flex items-center gap-2">
                CSV Batch Roster Upload & Sync
                {importStatus.isImporting && (
                  <span className="text-[10px] bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 font-bold px-2 py-0.5 rounded-full flex items-center gap-1 animate-pulse">
                    <RefreshCw size={10} className="animate-spin" /> Batch In Progress
                  </span>
                )}
              </h4>
              <button 
                onClick={() => {
                  if (!importStatus.isImporting) setIsBulkOpen(false);
                }} 
                disabled={importStatus.isImporting}
                className="text-slate-400 hover:text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <X size={16} />
              </button>
            </div>

            <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
              Standard format schema template (values enclosed in quotes if they contain commas): <br />
              <strong className="font-mono bg-slate-100 dark:bg-slate-900/60 p-1 rounded inline-block mt-1 text-indigo-400 select-all">
                EmployeeID, Name, Email, Role, Department, Process, DateJoined, Notes, TeamLead, Manager, Location
              </strong>
            </p>

            {/* Drag & Drop File Picker */}
            <div className={`mb-4 p-5 border-2 border-dashed rounded-xl flex flex-col items-center justify-center transition-colors ${adminTheme === 'dark' ? 'border-slate-700 hover:border-indigo-500 bg-slate-900/40' : 'border-slate-200 hover:border-indigo-500 bg-slate-50/60'}`}>
              <Upload size={24} className={`text-indigo-500 mb-2 ${importStatus.isImporting ? 'opacity-50' : 'animate-bounce'}`} />
              <p className="text-xs font-semibold mb-1 text-slate-700 dark:text-slate-300">Drag and drop your .csv file here, or click to browse</p>
              <p className="text-[10px] text-slate-400">Quotes-aware CSV text processor</p>
              <input 
                type="file" 
                accept=".csv"
                id="csv-file-upload-input"
                className="hidden"
                disabled={importStatus.isImporting}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (event) => {
                    const text = event.target?.result as string;
                    setBulkText(text);
                    toast.success(`Loaded file "${file.name}" successfully.`);
                  };
                  reader.readAsText(file);
                }}
              />
              <button 
                type="button" 
                disabled={importStatus.isImporting}
                onClick={() => document.getElementById('csv-file-upload-input')?.click()}
                className="mt-2 text-[11px] font-bold px-3 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-all shadow-sm cursor-pointer"
              >
                Choose CSV File
              </button>
            </div>

            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">CSV Data Preview & Editor:</span>
              {bulkText && !importStatus.isImporting && (
                <button 
                  onClick={() => setBulkText('')} 
                  className="text-[10px] font-bold text-red-500 hover:underline cursor-pointer"
                >
                  Clear Data
                </button>
              )}
            </div>

            <textarea 
              rows={5}
              value={bulkText}
              disabled={importStatus.isImporting}
              onChange={e => setBulkText(e.target.value)}
              placeholder="e.g.&#10;BT-901,Akshit Sodhi,akshit@bergtechnologies.co.in,QA,Operations,Vertical Core,2026-01-08,Senior Assessor,Mayank Semwal,John Doe,Dehradun (DDN)"
              className={`w-full text-xs p-3 font-mono border rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500 mb-4 disabled:opacity-60 disabled:cursor-not-allowed ${adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50 text-slate-800'}`}
            />

            {/* Upload & Sync Progress Bar */}
            {importStatus.isImporting && (
              <div className="mb-4 p-4 rounded-xl border border-indigo-500/25 bg-indigo-50/60 dark:bg-indigo-950/40 space-y-2">
                <div className="flex items-center justify-between text-xs font-bold">
                  <span className="text-indigo-600 dark:text-indigo-400 flex items-center gap-2">
                    <RefreshCw size={14} className="animate-spin text-indigo-500" />
                    {importStatus.stage}
                  </span>
                  <span className="font-mono text-indigo-700 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-900/60 px-2 py-0.5 rounded-md text-[11px]">
                    {importStatus.progress}% {importStatus.totalCount > 0 ? `(${importStatus.currentCount}/${importStatus.totalCount})` : ''}
                  </span>
                </div>
                <div className="w-full bg-slate-200 dark:bg-slate-700 h-2.5 rounded-full overflow-hidden p-0.5">
                  <div 
                    className="bg-gradient-to-r from-indigo-500 via-sky-500 to-emerald-500 h-full transition-all duration-300 rounded-full shadow-sm"
                    style={{ width: `${importStatus.progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Diagnostics Analysis output */}
            {csvErrors.length > 0 && !importStatus.isImporting && (
              <div className="mb-4 max-h-36 overflow-y-auto rounded-xl p-3 border border-red-500/10 bg-red-500/5 space-y-1.5 text-[11px]">
                <h5 className="font-extrabold text-red-500 uppercase tracking-tight flex items-center gap-1">
                  <X size={12} fill="currentColor" className="text-white bg-red-500 rounded-full p-0.5" /> CSV Analysis & Syntax Diagnostics ({csvErrors.length})
                </h5>
                {csvErrors.map((err, i) => (
                  <div key={i} className={`flex items-start gap-1 p-1 rounded ${err.type === 'error' ? 'text-red-600 dark:text-red-400 font-medium' : 'text-amber-600 dark:text-amber-400'}`}>
                    <span className="font-mono bg-black/5 dark:bg-white/5 px-1 rounded font-bold">Line {err.lineNum}:</span>
                    <span className="flex-1">{err.message}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-between items-center text-xs border-t pt-4">
              <span className="text-[10px] text-slate-400 font-mono">Lines without Name/Email are auto-ignored from writes.</span>
              <div className="flex gap-2">
                <button 
                  onClick={() => setIsBulkOpen(false)} 
                  disabled={importStatus.isImporting}
                  className="px-3 py-1.5 font-bold rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleBulkImport} 
                  disabled={importStatus.isImporting || csvErrors.some(err => err.type === 'error')}
                  className={`px-3 py-1.5 font-bold rounded-lg text-white cursor-pointer transition-all flex items-center gap-1.5 ${
                    importStatus.isImporting || csvErrors.some(err => err.type === 'error') 
                      ? 'bg-slate-400 opacity-60 cursor-not-allowed' 
                      : 'bg-emerald-600 hover:bg-emerald-700'
                  }`}
                >
                  {importStatus.isImporting ? (
                    <>
                      <RefreshCw size={14} className="animate-spin" />
                      Syncing ({importStatus.progress}%)
                    </>
                  ) : (
                    'Trigger Import Batch'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Single User Delete Confirmation Modal */}
      {deleteTargetUser && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`max-w-md w-full border shadow-2xl rounded-2xl p-6 space-y-4 ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-500 border border-rose-500/20 shrink-0">
                <Trash2 size={24} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-black text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                  Delete User Profile
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Are you sure you want to permanently delete this user profile?
                </p>
              </div>
              <button 
                onClick={() => !isDeletingUser && setDeleteTargetUser(null)} 
                className="text-slate-400 hover:text-slate-600 p-1"
                disabled={isDeletingUser}
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400 font-bold uppercase text-[10px]">Name:</span>
                <span className="font-extrabold text-slate-800 dark:text-slate-200">{deleteTargetUser.fullName || deleteTargetUser.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400 font-bold uppercase text-[10px]">Email:</span>
                <span className="font-mono text-slate-600 dark:text-slate-400">{deleteTargetUser.email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400 font-bold uppercase text-[10px]">Employee ID:</span>
                <span className="font-mono font-bold text-slate-800 dark:text-slate-200">{deleteTargetUser.employeeId || 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400 font-bold uppercase text-[10px]">Role / Department:</span>
                <span className="text-slate-700 dark:text-slate-300 font-semibold">{deleteTargetUser.role} • {deleteTargetUser.department || 'Operations'}</span>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs leading-relaxed flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>
                <strong>Warning:</strong> This action cannot be undone. User records in the employee directory and hierarchy mappings will be permanently erased.
              </span>
            </div>

            <div className="flex justify-end gap-2 text-xs pt-2 border-t border-slate-100 dark:border-slate-800">
              <button 
                type="button" 
                onClick={() => setDeleteTargetUser(null)} 
                disabled={isDeletingUser}
                className="px-3.5 py-2 font-bold rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button 
                type="button" 
                onClick={handleConfirmSingleDelete} 
                disabled={isDeletingUser}
                className="px-4 py-2 font-bold rounded-xl bg-rose-600 hover:bg-rose-700 text-white cursor-pointer transition-all flex items-center gap-1.5 shadow-md shadow-rose-600/20 disabled:opacity-60"
              >
                {isDeletingUser ? (
                  <>
                    <RefreshCw size={13} className="animate-spin" />
                    Deleting Profile...
                  </>
                ) : (
                  <>
                    <Trash2 size={13} />
                    Permanently Delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Delete Confirmation Modal */}
      {isBulkDeleteOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`max-w-md w-full border shadow-2xl rounded-2xl p-6 space-y-4 ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-500 border border-rose-500/20 shrink-0">
                <Trash2 size={24} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-black text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                  Bulk Delete User Profiles
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  You have selected <strong className="text-rose-600 dark:text-rose-400 font-bold">{selectedUids.size}</strong> user profiles for deletion.
                </p>
              </div>
              <button 
                onClick={() => !isDeletingBulk && setIsBulkDeleteOpen(false)} 
                className="text-slate-400 hover:text-slate-600 p-1"
                disabled={isDeletingBulk}
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs leading-relaxed flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>
                <strong>Irreversible Action:</strong> All {selectedUids.size} selected user profiles will be permanently removed from database collections and hierarchy trees.
              </span>
            </div>

            <div className="flex justify-end gap-2 text-xs pt-2 border-t border-slate-100 dark:border-slate-800">
              <button 
                type="button" 
                onClick={() => setIsBulkDeleteOpen(false)} 
                disabled={isDeletingBulk}
                className="px-3.5 py-2 font-bold rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button 
                type="button" 
                onClick={handleConfirmBulkDelete} 
                disabled={isDeletingBulk}
                className="px-4 py-2 font-bold rounded-xl bg-rose-600 hover:bg-rose-700 text-white cursor-pointer transition-all flex items-center gap-1.5 shadow-md shadow-rose-600/20 disabled:opacity-60"
              >
                {isDeletingBulk ? (
                  <>
                    <RefreshCw size={13} className="animate-spin" />
                    Deleting {selectedUids.size} Profiles...
                  </>
                ) : (
                  <>
                    <Trash2 size={13} />
                    Delete {selectedUids.size} Profiles
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Single User Restrict Login Modal */}
      {restrictTargetUser && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`max-w-md w-full border shadow-2xl rounded-2xl p-6 space-y-4 ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20 shrink-0">
                <Lock size={24} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-black text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                  Restrict User Login Access
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Block login access for <strong className="text-slate-800 dark:text-slate-200">{restrictTargetUser.fullName || restrictTargetUser.name}</strong>
                </p>
              </div>
              <button 
                onClick={() => !isSubmittingRestriction && setRestrictTargetUser(null)} 
                className="text-slate-400 hover:text-slate-600 p-1"
                disabled={isSubmittingRestriction}
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs leading-relaxed">
              When restricted, the user will be <strong>blocked from logging in</strong> even after completing email/password authentication. Any active sessions will be terminated immediately.
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Select Restriction Reason Preset
              </label>
              <div className="flex flex-wrap gap-1.5">
                {RESTRICT_REASON_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setRestrictPreset(preset);
                      if (preset !== 'Other / Custom') setRestrictReason(preset);
                    }}
                    className={`text-[10px] font-semibold px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                      restrictPreset === preset
                        ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-amber-400'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Custom Remarks / Reason
              </label>
              <input
                value={restrictReason}
                onChange={e => setRestrictReason(e.target.value)}
                placeholder="Enter specific reason for restriction..."
                className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2.5 text-xs border border-slate-700 rounded-xl focus:ring-1 focus:ring-amber-500' : 'w-full bg-white border border-slate-200 p-2.5 text-xs rounded-xl focus:ring-1 focus:ring-amber-500'}
              />
            </div>

            <div className="flex justify-end gap-2 text-xs pt-2 border-t border-slate-100 dark:border-slate-800">
              <button 
                type="button" 
                onClick={() => setRestrictTargetUser(null)} 
                disabled={isSubmittingRestriction}
                className="px-3.5 py-2 font-bold rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button 
                type="button" 
                onClick={handleConfirmRestriction} 
                disabled={isSubmittingRestriction}
                className="px-4 py-2 font-bold rounded-xl bg-amber-600 hover:bg-amber-700 text-white cursor-pointer transition-all flex items-center gap-1.5 shadow-md shadow-amber-600/20 disabled:opacity-60"
              >
                {isSubmittingRestriction ? (
                  <>
                    <RefreshCw size={13} className="animate-spin" />
                    Applying Restriction...
                  </>
                ) : (
                  <>
                    <Lock size={13} />
                    Apply Login Restriction
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Restrict Login Modal */}
      {isBulkRestrictOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`max-w-md w-full border shadow-2xl rounded-2xl p-6 space-y-4 ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20 shrink-0">
                <Lock size={24} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-black text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                  Bulk Restrict Login Access
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Restricting login access for <strong className="text-amber-600 dark:text-amber-400 font-bold">{selectedUids.size}</strong> selected users.
                </p>
              </div>
              <button 
                onClick={() => !isSubmittingRestriction && setIsBulkRestrictOpen(false)} 
                className="text-slate-400 hover:text-slate-600 p-1"
                disabled={isSubmittingRestriction}
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs leading-relaxed">
              Selected users will be blocked from logging into the app. Their reason will be logged in their personnel notes.
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Select Reason Preset
              </label>
              <div className="flex flex-wrap gap-1.5">
                {RESTRICT_REASON_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setBulkRestrictPreset(preset);
                      if (preset !== 'Other / Custom') setBulkRestrictReason(preset);
                    }}
                    className={`text-[10px] font-semibold px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                      bulkRestrictPreset === preset
                        ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-amber-400'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Reason / Note
              </label>
              <input
                value={bulkRestrictReason}
                onChange={e => setBulkRestrictReason(e.target.value)}
                placeholder="Enter reason for bulk restriction..."
                className={adminTheme === 'dark' ? 'w-full bg-slate-900 p-2.5 text-xs border border-slate-700 rounded-xl focus:ring-1 focus:ring-amber-500' : 'w-full bg-white border border-slate-200 p-2.5 text-xs rounded-xl focus:ring-1 focus:ring-amber-500'}
              />
            </div>

            <div className="flex justify-end gap-2 text-xs pt-2 border-t border-slate-100 dark:border-slate-800">
              <button 
                type="button" 
                onClick={() => setIsBulkRestrictOpen(false)} 
                disabled={isSubmittingRestriction}
                className="px-3.5 py-2 font-bold rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button 
                type="button" 
                onClick={handleConfirmBulkRestriction} 
                disabled={isSubmittingRestriction}
                className="px-4 py-2 font-bold rounded-xl bg-amber-600 hover:bg-amber-700 text-white cursor-pointer transition-all flex items-center gap-1.5 shadow-md shadow-amber-600/20 disabled:opacity-60"
              >
                {isSubmittingRestriction ? (
                  <>
                    <RefreshCw size={13} className="animate-spin" />
                    Restricting {selectedUids.size} Users...
                  </>
                ) : (
                  <>
                    <Lock size={13} />
                    Restrict {selectedUids.size} Users
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
