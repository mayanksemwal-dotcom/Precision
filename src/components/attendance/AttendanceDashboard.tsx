import React, { useState, useEffect, useMemo, useDeferredValue, useRef } from 'react';
import { db, auth, getDocsOptimized, getDocOptimized, getDocsCacheFirst, handleFirestoreError, OperationType } from '../../lib/firebase';
import { firestoreLogger } from '../../lib/firestoreLogger';
import { getLiveTime, getLiveTimeISO } from '../../lib/timeSync';
import { collection, query, getDocs, doc, setDoc, writeBatch, where, orderBy, getDoc, addDoc, onSnapshot, limit, startAfter } from 'firebase/firestore';
import { UserProfile, UserRole } from '../../types';
import { isSupervisorOf } from '../../lib/hierarchy';
import { usePermission } from '../PermissionContext';
import { useConfig } from '../../contexts/ConfigContext';
import { toast } from 'sonner';
import { Calendar, RefreshCw, FileText, Download, CheckCircle, ClockAlert, XCircle, Search, Save, AlertCircle, Clock } from 'lucide-react';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { motion } from 'motion/react';
import { MultiSelectDropdown } from '../ui/multi-select';

interface AttendanceSummary {
  id: string; // shiftId or date_uid
  shiftId: string;
  userId: string;
  employeeName: string;
  employeeEmail: string;
  employeeId?: string;
  process: string;
  mappedTL: string;
  mappedManager: string;
  attendanceDate: string; // YYYY-MM-DD
  attendanceStatus: 'Present' | 'Half Day' | 'Absent';
  productiveMinutes: number;
  totalBreakMinutes: number;
  sessionStart: string;
  sessionEnd: string;
  generatedBySystem: boolean;
  lastModifiedBy?: string;
  lastModifiedTimestamp?: string;
  isOvernight: boolean;
  isManuallyOverridden?: boolean;
}

interface AttendanceConfig {
  presentThreshold: number;
  halfDayThreshold: number;
  countBreakTime: boolean;
}

export default function AttendanceDashboard({ user, allUsers }: { user: UserProfile; allUsers: any[] }) {
  const { canEdit, canExport, hasTmsPermission } = usePermission();
  const roleNormalized = (user.role || '').toUpperCase().trim().replace(/\s+/g, '_');
  const isTopAdmin = ['ADMIN', 'MANAGER', 'MIS', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes(roleNormalized);
  const isStrictAdminOrManager = ['ADMIN', 'MANAGER', 'MIS', 'ASSISTANT_MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes(roleNormalized);
  const isTLRole = ['QTL', 'STL', 'OPS_TL', 'TRAINER_TL', 'TEAM_LEAD', 'TRAINER', 'SME', 'OPS_TEAM_LEAD', 'TEAM_LEADER'].includes(roleNormalized);
  const { attendanceSettings: centralAttendance } = useConfig();

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [records, setRecords] = useState<AttendanceSummary[]>([]);
  const [config, setConfig] = useState<AttendanceConfig>({ presentThreshold: 480, halfDayThreshold: 240, countBreakTime: false });
  const [dateRange, setDateRange] = useState<'today' | 'yesterday' | 'week' | 'month' | 'current_month' | 'previous_month' | 'custom'>('today');
  const [forceRefresh, setForceRefresh] = useState(false);
  
  // Filter / Pagination state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProcesses, setSelectedProcesses] = useState<string[]>([]);
  const [selectedTLs, setSelectedTLs] = useState<string[]>([]);
  const [selectedManagers, setSelectedManagers] = useState<string[]>([]);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [filterManualOnly, setFilterManualOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;
  const deferredSearchTerm = useDeferredValue(searchTerm);

  // Date Range state for Custom
  const getISTDateStr = (date: Date) => {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
  };

  const [customStartDate, setCustomStartDate] = useState(getISTDateStr(getLiveTime()));
  const [customEndDate, setCustomEndDate] = useState(getISTDateStr(getLiveTime()));
  const [lastDoc, setLastDoc] = useState<any>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const initialFilterApplied = useRef(false);
  const isSyncingRef = useRef(false);

  // Default filter for TLs
  useEffect(() => {
    if (!initialFilterApplied.current && isTLRole && !isTopAdmin && selectedTLs.length === 0) {
      const userName = (user.fullName || user.name || '').trim();
      if (userName) {
        setSelectedTLs([userName]);
        initialFilterApplied.current = true;
      }
    }
  }, [isTLRole, isTopAdmin, user]);

  // Real-time Employee Lookup - OPTIMIZED: Double index by email and UID
  const userLookup = useMemo(() => {
    const lookup: Record<string, any> = {};
    allUsers.forEach(u => {
      if (u.email) lookup[u.email.toLowerCase().trim()] = u;
      if (u.uid) lookup[u.uid] = u;
    });
    return lookup;
  }, [allUsers]);


  const enhancedRecords = useMemo(() => {
    // 1. Group by employeeEmail + logical attendanceDate (handling overnight shifts)
    const groups: Record<string, AttendanceSummary[]> = {};
    records.forEach(r => {
        // Calculate logical work date: shifts starting before 4 AM belong to previous day
        const sessionStart = new Date(r.sessionStart);
        const logicalDate = new Date(sessionStart.getTime() - 4 * 60 * 60 * 1000);
        const logicalDateStr = getISTDateStr(logicalDate);
        
        const key = `${r.employeeEmail}_${logicalDateStr}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });

    // 2. Consolidate
    const consolidated = Object.values(groups).map(group => {
        // Calculate logical work date for the group (shifts starting between 00:00 and 04:00 belong to previous day)
        const sessionStart = new Date(group[0].sessionStart);
        const logicalDate = new Date(sessionStart.getTime() - 4 * 60 * 60 * 1000);
        const logicalDateStr = getISTDateStr(logicalDate);

        if (group.length === 1) {
            return { ...group[0], attendanceDate: logicalDateStr };
        }
        
        const totalProd = group.reduce((sum, r) => sum + r.productiveMinutes, 0);
        const totalBreak = group.reduce((sum, r) => sum + r.totalBreakMinutes, 0);
        
        const base = group[0];
        const isManual = group.some(r => r.isManuallyOverridden);
        let status;
        if (isManual) {
             // If manually overridden, prioritize the overridden status
             const manualRecord = group.find(r => r.isManuallyOverridden && r.attendanceStatus);
             status = manualRecord?.attendanceStatus || (totalProd >= config.presentThreshold ? 'Present' : (totalProd >= config.halfDayThreshold ? 'Half Day' : 'Absent'));
        } else {
             status = totalProd >= config.presentThreshold ? 'Present' : (totalProd >= config.halfDayThreshold ? 'Half Day' : 'Absent');
        }
        
        return {
            ...base,
            attendanceDate: logicalDateStr,
            productiveMinutes: totalProd,
            totalBreakMinutes: totalBreak,
            attendanceStatus: status,
            sessionStart: group.reduce((min, r) => new Date(r.sessionStart) < new Date(min) ? r.sessionStart : min, group[0].sessionStart),
            sessionEnd: group.reduce((max, r) => new Date(r.sessionEnd) > new Date(max) ? r.sessionEnd : max, group[0].sessionEnd),
            isManuallyOverridden: group.some(r => r.isManuallyOverridden),
            isOvernight: group.some(r => r.isOvernight),
        };
    });

    // 3. Map for enhancement
    return consolidated.map(r => {
      const user = userLookup[r.employeeEmail.toLowerCase().trim()] || (r.userId ? userLookup[r.userId] : null);
      if (!user) return r;

      return {
        ...r,
        process: r.process !== 'N/A' && r.process ? r.process : (user.process || 'N/A'),
        mappedTL: r.mappedTL !== 'N/A' && r.mappedTL ? r.mappedTL : (user.teamLeadName || 'N/A'),
        mappedManager: r.mappedManager !== 'N/A' && r.mappedManager ? r.mappedManager : (user.managerName || user.mappedManagerName || user.Manager || 'N/A'),
        employeeId: r.employeeId || user.employeeId || ''
      };
    });
  }, [records, userLookup, config]);

  const filteredRecords = useMemo(() => {
    const { startStr: requestedStart, endStr: requestedEnd } = getDateRangeStr();

    return enhancedRecords.filter(r => {
      // 0. Filter by requested logical date range
      const matchesDateRange = r.attendanceDate >= requestedStart && r.attendanceDate <= requestedEnd;
      if (!matchesDateRange) return false;

      // 1. Base Security: If not top admin, enforce visibility rules
      if (!isTopAdmin) {
        const userEmail = (user.email || '').toLowerCase().trim();
        const userName = (user.fullName || user.name || '').toLowerCase().trim();
        const isOwnRecord = r.userId === user.uid || (r.employeeEmail || '').toLowerCase().trim() === userEmail;
        
        if (!isOwnRecord) {
          const employeeProfile = userLookup[r.userId] || userLookup[(r.employeeEmail || '').toLowerCase().trim()];
          const targetRole = employeeProfile ? (employeeProfile.role || '').toString().toUpperCase().trim().replace(/\s+/g, '_') : '';

          const executiveRoles = ['ADMIN', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'];
          
          if (executiveRoles.includes(targetRole)) return false; // Non-admins can't see executive attendance

          // Check reporting structure
          let isReport = false;
          if (employeeProfile) {
            const empTLId = employeeProfile.teamLeadId || employeeProfile.teamLeadUid;
            const empMgrId = employeeProfile.mappedManagerId || employeeProfile.managerId || employeeProfile.mappedManagerUid;
            const empTLEmail = (employeeProfile.teamLeadEmail || '').toLowerCase().trim();
            const empMgrEmail = (employeeProfile.mappedManagerEmail || employeeProfile.managerEmail || '').toLowerCase().trim();
            const empTLName = (employeeProfile.teamLeadName || '').toLowerCase().trim();
            const empMgrName = (employeeProfile.managerName || employeeProfile.mappedManagerName || '').toLowerCase().trim();

            isReport = (
              empTLId === user.uid || 
              empMgrId === user.uid || 
              (empTLEmail && empTLEmail === userEmail) ||
              (empMgrEmail && empMgrEmail === userEmail) ||
              (empTLName && empTLName === userName) ||
              (empMgrName && empMgrName === userName)
            );
          }
          
          const rTL = (r.mappedTL || '').toLowerCase().trim();
          const rMgr = (r.mappedManager || '').toLowerCase().trim();
          const matchesRecordSupervisor = (rTL === userName || rTL === userEmail || rMgr === userName || rMgr === userEmail);
          
          const isAuthorizedSupervisor = isReport || matchesRecordSupervisor;
          
          // If they are a TL/SME/Trainer, allow seeing everyone except executives (already checked above)
          if (isTLRole) {
            // Authorized to see all non-executives
          } else if (!isAuthorizedSupervisor) {
            return false;
          }
        }
      }

      const matchesSearch = !deferredSearchTerm || r.employeeName.toLowerCase().includes(deferredSearchTerm.toLowerCase()) || r.employeeEmail.toLowerCase().includes(deferredSearchTerm.toLowerCase());

      const matchesProcess = selectedProcesses.length === 0 || selectedProcesses.includes(r.process);
      const matchesTL = selectedTLs.length === 0 || selectedTLs.includes(r.mappedTL);
      const matchesManager = selectedManagers.length === 0 || selectedManagers.includes(r.mappedManager);
      
      const empLocation = (userLookup[r.userId]?.location || 'N/A').trim();
      const matchesLocation = selectedLocations.length === 0 || selectedLocations.includes(empLocation);

      const matchesStatus = selectedStatuses.length === 0 || selectedStatuses.includes(r.attendanceStatus);
      const matchesManual = !filterManualOnly || !!r.isManuallyOverridden;
      
      return matchesSearch && matchesProcess && matchesTL && matchesManager && matchesLocation && matchesStatus && matchesManual;
    });
  }, [enhancedRecords, searchTerm, selectedProcesses, selectedLocations, selectedTLs, selectedManagers, selectedStatuses, filterManualOnly, isTopAdmin, isTLRole, user, userLookup]);

  const paginatedRecords = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredRecords.slice(start, start + itemsPerPage);
  }, [filteredRecords, currentPage]);

  const totalPages = Math.ceil(filteredRecords.length / itemsPerPage);

  const [summary, setSummary] = useState({ present: 0, halfDay: 0, absent: 0, attendancePct: '0.0', manualOverrides: 0 });

  useEffect(() => {
    const fetchGlobalSummary = async () => {
      try {
        const { getCountFromServer, query, collection, where } = await import('firebase/firestore');
        const { db } = await import('../../lib/firebase');
        const { startStr, endStr } = getDateRangeStr();
        
        const baseQ = query(collection(db, 'attendanceSummary'), 
          where('attendanceDate', '>=', startStr), 
          where('attendanceDate', '<=', endStr)
        );

        const [presentSnap, halfDaySnap, absentSnap] = await Promise.all([
          getCountFromServer(query(baseQ, where('attendanceStatus', '==', 'Present'))).catch(() => ({ data: () => ({ count: 0 }) })),
          getCountFromServer(query(baseQ, where('attendanceStatus', '==', 'Half Day'))).catch(() => ({ data: () => ({ count: 0 }) })),
          getCountFromServer(query(baseQ, where('attendanceStatus', '==', 'Absent'))).catch(() => ({ data: () => ({ count: 0 }) }))
        ]);

        const present = presentSnap.data().count;
        const halfDay = halfDaySnap.data().count;
        const absent = absentSnap.data().count;
        const total = present + halfDay + absent;
        const attendancePct = total > 0 ? (((present + halfDay * 0.5) / total) * 100).toFixed(1) : '0.0';

        // For manual overrides, it's optional but we leave it out of the heavy query or compute on client loaded data if preferred.
        // For simplicity, we compute manual overrides from the loaded filtered records.
        const manualOverrides = filteredRecords.filter(r => r.isManuallyOverridden).length;

        setSummary({ present, halfDay, absent, attendancePct, manualOverrides });
      } catch (err) {
        console.warn('Could not fetch global attendance summary counts', err);
      }
    };
    fetchGlobalSummary();
  }, [dateRange, customStartDate, customEndDate, filteredRecords.length]);

  
  // Edit state
  const [editingRecord, setEditingRecord] = useState<AttendanceSummary | null>(null);
  const [editStatus, setEditStatus] = useState<'Present' | 'Half Day' | 'Absent'>('Present');
  const [editComment, setEditComment] = useState('');
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [exportFormatModal, setExportFormatModal] = useState(false);

  // Authorization for edits
  const canModifyAttendance = canEdit('Attendance') && !isTLRole;
  const canExportAttendance = canExport('Attendance');

  // Dynamic Process filter: Get processes from both user master and existing records for maximum robustness
  const availableProcesses = useMemo(() => {
    const fromUsers = allUsers.map(u => u.process);
    const fromRecords = records.map(r => r.process);
    const combined = [...fromUsers, ...fromRecords];
    const list = Array.from(new Set(combined.filter(p => p !== 'N/A' && !!p)));
    return list.sort();
  }, [allUsers, records]);

  const availableLocations = useMemo(() => {
    const list = new Set<string>();
    list.add('Dehradun (DDN)');
    list.add('Jammu (JMU)');
    list.add('Bangalore (BLR)');
    allUsers.forEach(u => u.location && list.add(u.location));
    return Array.from(list).filter(Boolean).sort();
  }, [allUsers]);

  const availableTLs = useMemo(() => {
    const fromUsers = allUsers.map(u => u.teamLeadName);
    const fromRecords = records.map(r => r.mappedTL);
    const combined = [...fromUsers, ...fromRecords];
    const list = Array.from(new Set(combined.filter(tl => tl !== 'N/A' && !!tl)));
    return list.sort();
  }, [allUsers, records]);

  const availableManagers = useMemo(() => {
    const fromUsers = allUsers.map(u => u.managerName || u.mappedManagerName || u.Manager);
    const fromRecords = records.map(r => r.mappedManager);
    const combined = [...fromUsers, ...fromRecords];
    const list = Array.from(new Set(combined.filter(m => m !== 'N/A' && !!m)));
    return list.sort();
  }, [allUsers, records]);

  const openEditModal = (r: AttendanceSummary) => {
    setEditingRecord(r);
    setEditStatus(r.attendanceStatus);
    setEditComment('');
    setShowHistory(false);
    
    // Fetch logs
    const q = query(collection(db, 'attendanceAuditLogs'), where('attendanceId', '==', r.id), orderBy('timestamp', 'desc'));
    getDocsOptimized(q, 'attendance_audit_logs_' + r.id).then(snap => setAuditLogs(snap.docs.map(d => d.data())));
  };

  const allUsersRef = React.useRef(allUsers);
  useEffect(() => {
    allUsersRef.current = allUsers;
  }, [allUsers]);

  const getDateRangeStr = () => {
    const getLocalDateString = (d: Date): string => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    let startStr = '';
    let endStr = '';

    if (dateRange === 'today') {
      const todayStr = getLocalDateString(getLiveTime());
      startStr = todayStr;
      endStr = todayStr;
    } else if (dateRange === 'yesterday') {
      const d = getLiveTime();
      d.setDate(d.getDate() - 1);
      const yesterdayStr = getLocalDateString(d);
      startStr = yesterdayStr;
      endStr = yesterdayStr;
    } else if (dateRange === 'week') {
      const d = getLiveTime();
      d.setDate(d.getDate() - 7);
      startStr = getLocalDateString(d);
      endStr = getLocalDateString(getLiveTime());
    } else if (dateRange === 'month') {
      const d = getLiveTime();
      d.setDate(d.getDate() - 30);
      startStr = getLocalDateString(d);
      endStr = getLocalDateString(getLiveTime());
    } else if (dateRange === 'current_month') {
      const d = getLiveTime();
      const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
      startStr = getLocalDateString(firstDay);
      endStr = getLocalDateString(d);
    } else if (dateRange === 'previous_month') {
      const d = getLiveTime();
      const firstDayOfPrev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const lastDayOfPrev = new Date(d.getFullYear(), d.getMonth(), 0);
      startStr = getLocalDateString(firstDayOfPrev);
      endStr = getLocalDateString(lastDayOfPrev);
    } else if (dateRange === 'custom') {
      startStr = customStartDate;
      endStr = customEndDate;
    }

    return { startStr, endStr };
  };

  const getTargetUserIds = () => {
    const isAdmin = roleNormalized === 'ADMIN';
    if (isAdmin) {
      return null; // Admin can fetch organization-wide (unscoped)
    }

    const targetUserIds: string[] = [];

    // Managers: Only fetch their team
    // TLs: Only fetch assigned users
    // Agents: Only fetch themselves
    const isManager = ['MANAGER', 'ASSISTANT_MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER', 'MIS'].includes(roleNormalized);
    const isTL = ['QTL', 'STL', 'OPS_TL', 'TRAINER_TL', 'TEAM_LEAD', 'TRAINER', 'SME', 'OPS_TEAM_LEAD', 'TEAM_LEADER'].includes(roleNormalized);

    if (isManager || isTL) {
      allUsers.forEach((u: any) => {
        if (!u.uid || u.uid === user.uid) return;
        const isDirectReport = 
          u.managerId === user.uid || 
          u.mappedManagerUid === user.uid ||
          u.teamLeadId === user.uid ||
          u.teamLeadUid === user.uid ||
          u.tlId === user.uid;
        
        const isSub = isDirectReport || isSupervisorOf(user, u, allUsers);
        if (isSub) {
          targetUserIds.push(u.uid);
        }
      });
    }

    // Always include the logged-in user themselves
    if (!targetUserIds.includes(user.uid)) {
      targetUserIds.push(user.uid);
    }

    return targetUserIds;
  };

  const fetchAttendanceRecords = async (isLoadMore = false) => {
    if (!isLoadMore) {
      // Force a refresh of the active list
      setForceRefresh(true);
      return '';
    }

    setLoadingMore(true);

    try {
      const { startStr, endStr } = getDateRangeStr();
      
      // Expand query range by 1 day on each side to ensure we capture segments of overnight shifts
      const qStart = new Date(startStr);
      qStart.setDate(qStart.getDate() - 1);
      const qStartStr = getISTDateStr(qStart);
      
      const qEnd = new Date(endStr);
      qEnd.setDate(qEnd.getDate() + 1);
      const qEndStr = getISTDateStr(qEnd);

      const attRef = collection(db, 'attendanceSummary');
      const PAGE_SIZE = 50; // Increased size to handle wider query range

      const targetUserIds = getTargetUserIds();

      if (targetUserIds === null) {
        // Admin: Unscoped query
        let q = query(attRef, where('attendanceDate', '>=', qStartStr), where('attendanceDate', '<=', qEndStr), orderBy('attendanceDate', 'desc'), limit(PAGE_SIZE));
        if (lastDoc) {
          q = query(q, startAfter(lastDoc));
        }

        const snap = await getDocsOptimized(q, `attendance_records_paged_${dateRange}_expanded`, forceRefresh);
        const attData = snap.docs.map((d: any) => ({ ...d.data(), id: d.id } as AttendanceSummary));

        setRecords(prev => {
          const existingIds = new Set(prev.map(p => p.id));
          const filteredNew = attData.filter(d => !existingIds.has(d.id));
          return [...prev, ...filteredNew];
        });

        setLastDoc(snap.docs[snap.docs.length - 1] || null);
        setHasMore(snap.size === PAGE_SIZE);
      } else {
        // Scoped query for Managers, TLs, and Agents
        // Chunk userIds into batches of 30
        const chunks: string[][] = [];
        for (let i = 0; i < targetUserIds.length; i += 30) {
          chunks.push(targetUserIds.slice(i, i + 30));
        }

        const promises = chunks.map(async (chunk, index) => {
          let q = chunk.length === 1
            ? query(attRef, where('userId', '==', chunk[0]), where('attendanceDate', '>=', qStartStr), where('attendanceDate', '<=', qEndStr), orderBy('attendanceDate', 'desc'), limit(PAGE_SIZE))
            : query(attRef, where('userId', 'in', chunk), where('attendanceDate', '>=', qStartStr), where('attendanceDate', '<=', qEndStr), orderBy('attendanceDate', 'desc'), limit(PAGE_SIZE));

          if (lastDoc && chunks.length === 1) {
            q = query(q, startAfter(lastDoc));
          }

          const snap = await getDocsOptimized(q, `attendance_records_paged_${dateRange}_expanded_chunk_${index}`, forceRefresh);
          return snap.docs;
        });

        const results = await Promise.all(promises);
        const allDocs = results.flat();
        const attData = allDocs.map((d: any) => ({ ...d.data(), id: d.id } as AttendanceSummary));

        // Sort by attendanceDate desc in-memory
        attData.sort((a, b) => new Date(b.attendanceDate).getTime() - new Date(a.attendanceDate).getTime());

        setRecords(prev => {
          const existingIds = new Set(prev.map(p => p.id));
          const filteredNew = attData.filter(d => !existingIds.has(d.id));
          return [...prev, ...filteredNew];
        });

        const lastDocObj = allDocs[allDocs.length - 1] || null;
        setLastDoc(lastDocObj);
        setHasMore(allDocs.length >= PAGE_SIZE);
      }

      setLoadingMore(false);
      return startStr;
    } catch (error: any) {
      console.error('Error loading more attendance records:', error);
      setLoadingMore(false);
      return '';
    }
  };

  useEffect(() => {
    if (centralAttendance) {
      setConfig({
        presentThreshold: centralAttendance.presentThreshold ?? 480,
        halfDayThreshold: centralAttendance.halfDayThreshold ?? 240,
        countBreakTime: centralAttendance.countBreakTime ?? false
      });
    }
  }, [centralAttendance]);

  useEffect(() => {
    if (!user?.uid) return;

    setLoading(true);
    const { startStr, endStr } = getDateRangeStr();

    // Config is now managed by ConfigContext and used in useEffect above

    const attRef = collection(db, 'attendanceSummary');
    const PAGE_SIZE = 30;

    const fetchData = async () => {
      try {
        const targetUserIds = getTargetUserIds();

        if (targetUserIds === null) {
          // Admin: Unscoped query
          const q = query(attRef, where('attendanceDate', '>=', startStr), where('attendanceDate', '<=', endStr), orderBy('attendanceDate', 'desc'), limit(PAGE_SIZE));
          const snap = await getDocsOptimized(q, `attendance_records_fetch_${dateRange}`, forceRefresh);
          const attData = snap.docs.map((d: any) => ({ ...d.data(), id: d.id } as AttendanceSummary));
          
          setRecords(attData);
          setLastDoc(snap.docs[snap.docs.length - 1] || null);
          setHasMore(snap.size === PAGE_SIZE);
        } else {
          // Scoped query for Managers, TLs, and Agents
          const chunks: string[][] = [];
          for (let i = 0; i < targetUserIds.length; i += 30) {
            chunks.push(targetUserIds.slice(i, i + 30));
          }

          const promises = chunks.map(async (chunk, index) => {
            const q = chunk.length === 1
              ? query(attRef, where('userId', '==', chunk[0]), where('attendanceDate', '>=', startStr), where('attendanceDate', '<=', endStr), orderBy('attendanceDate', 'desc'), limit(PAGE_SIZE))
              : query(attRef, where('userId', 'in', chunk), where('attendanceDate', '>=', startStr), where('attendanceDate', '<=', endStr), orderBy('attendanceDate', 'desc'), limit(PAGE_SIZE));

            const snap = await getDocsOptimized(q, `attendance_records_fetch_${dateRange}_chunk_${index}`, forceRefresh);
            return snap.docs;
          });

          const results = await Promise.all(promises);
          const allDocs = results.flat();
          const attData = allDocs.map((d: any) => ({ ...d.data(), id: d.id } as AttendanceSummary));

          // Sort descending in-memory
          attData.sort((a, b) => new Date(b.attendanceDate).getTime() - new Date(a.attendanceDate).getTime());

          setRecords(attData);
          const lastDocObj = allDocs[allDocs.length - 1] || null;
          setLastDoc(lastDocObj);
          setHasMore(allDocs.length >= PAGE_SIZE);
        }

        setLoading(false);
        if (forceRefresh) {
          setForceRefresh(false);
        }
      } catch (error) {
        console.error('Error in attendance summary fetch:', error);
        setLoading(false);
        if (forceRefresh) {
          setForceRefresh(false);
        }
      }
    };

    fetchData();
  }, [dateRange, customStartDate, customEndDate, user?.uid, isTopAdmin, isStrictAdminOrManager, isTLRole, forceRefresh]);

  const loadData = async () => {
    setForceRefresh(true);
  };

  const calculateStatus = (productiveMins: number, thresholdConf: AttendanceConfig): 'Present' | 'Half Day' | 'Absent' => {
     if (productiveMins >= thresholdConf.presentThreshold) return 'Present';
     if (productiveMins >= thresholdConf.halfDayThreshold) return 'Half Day';
     return 'Absent';
  };

  const handleSyncAttendance = async () => {
    if (isSyncingRef.current || syncing) {
      console.log('[ATTENDANCE_SYNC] Sync already in-flight, skipping manual call.');
      return;
    }
    isSyncingRef.current = true;
    setSyncing(true);
    try {
      // 1. Fetch completed shifts from last 2 days that might not have attendance
      const shiftsRef = collection(db, 'tmsShifts');
      const twoDaysAgo = getLiveTime();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2); // Sync last 2 days
      // Stabilize boundary to start of the day to ensure cache hits
      twoDaysAgo.setHours(0, 0, 0, 0);
      const twoDaysAgoISO = twoDaysAgo.toISOString();
      const twoDaysAgoDateStr = getISTDateStr(twoDaysAgo);
      
      // Use single field filter to avoid composite index requirement, with IndexedDB persistence optimization
      const qShifts = query(shiftsRef, where('clockInTime', '>=', twoDaysAgoISO));
      const shiftsSnap = await getDocsCacheFirst(qShifts, 'attendanceDashboardSync_tmsShifts');
      firestoreLogger.trackRead('attendance_sync_shifts_fetch', shiftsSnap.size);
      console.info(`[ATTENDANCE_SYNC_TRACE] function=handleSyncAttendance syncRange="last 2 days" (${twoDaysAgoDateStr} to ${getISTDateStr(getLiveTime())}) docsRead=${shiftsSnap.size}`);
      
      // Filter COMPLETED, AUTO_CLOSED, and COMPLETED_FORCED in memory
      const completedShifts = shiftsSnap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .filter((s: any) => s.status === 'COMPLETED' || s.status === 'AUTO_CLOSED' || s.status === 'COMPLETED_FORCED');

      if (completedShifts.length === 0) {
        toast.info('No finalized shifts found to sync in the requested 2-day period.');
        return;
      }

      // Fetch existing attendances to prevent duplicate logic
      const attSnap = await getDocsOptimized(query(collection(db, 'attendanceSummary'), where('attendanceDate', '>=', twoDaysAgoDateStr)), 'attendanceSummary_sync_2days');
      firestoreLogger.trackRead('attendance_sync_existing_summary_fetch', attSnap.size);
      const existingShiftIds = new Set(attSnap.docs.map(d => d.data().shiftId));

      let batch = writeBatch(db);
      let newCount = 0;
      let batchCount = 0;

      for (const shift of completedShifts as any[]) {
        if (existingShiftIds.has(shift.id)) continue; 

        // Calculate
        const startMs = new Date(shift.clockInTime).getTime();
        const endMs = shift.clockOutTime ? new Date(shift.clockOutTime).getTime() : startMs;
        
        let prodMs = 0;
        let breakMs = 0;
        (shift.activities || []).forEach((act: any) => {
          const aStart = new Date(act.startTime).getTime();
          const aEnd = act.endTime ? new Date(act.endTime).getTime() : endMs;
          const dur = Math.max(0, aEnd - aStart);
          const actName = (act.name || '').toLowerCase();
          const isProductive = act.type === 'productive' || 
                       ['meeting', 'coaching', 'training', 'alignment'].some(k => (act.name || '').toLowerCase().includes(k));
          if (isProductive) prodMs += dur;
          else breakMs += dur;
        });

        let totalMins = Math.floor(prodMs / 60000);
        if (config.countBreakTime) {
          totalMins += Math.floor(breakMs / 60000);
        }

        const dateStr = shift.clockInTime.split('T')[0];
        const isOvernight = shift.clockOutTime ? (shift.clockInTime.split('T')[0] !== shift.clockOutTime.split('T')[0]) : false;

        const summary: AttendanceSummary = {
          id: shift.id,
          shiftId: shift.id,
          userId: shift.userId,
          employeeName: shift.userName || shift.userEmail,
          employeeEmail: shift.userEmail,
          employeeId: shift.employeeId || '',
          process: shift.process || 'N/A',
          mappedTL: shift.mappedTL || 'N/A',
          mappedManager: shift.mappedManager || 'N/A',
          attendanceDate: dateStr,
          attendanceStatus: calculateStatus(totalMins, config),
          productiveMinutes: totalMins,
          totalBreakMinutes: Math.floor(breakMs / 60000),
          sessionStart: shift.clockInTime,
          sessionEnd: shift.clockOutTime || shift.clockInTime,
          generatedBySystem: true,
          isOvernight
        };

        const attDocRef = doc(db, 'attendanceSummary', shift.id);
        batch.set(attDocRef, summary);
        newCount++;
        batchCount++;

        if (batchCount >= 450) {
            await batch.commit();
            batch = writeBatch(db);
            batchCount = 0;
        }
      }

      if (batchCount > 0) {
        await batch.commit();
      }

      if (newCount > 0) {
        toast.success(`Successfully synchronized ${newCount} new attendance records.`);
        loadData();
      } else {
        toast.info('Attendance is already up to date for recent sessions.');
      }
    } catch (e) {
      console.error(e);
      toast.error('Failed to synchronize attendance');
    } finally {
      isSyncingRef.current = false;
      setSyncing(false);
    }
  };

  const handleUpdateRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRecord || !editComment.trim()) return;

    try {
      const oldStatus = editingRecord.attendanceStatus;
      
      const updateData = {
        attendanceStatus: editStatus,
        lastModifiedBy: user.email,
        lastModifiedTimestamp: getLiveTimeISO(),
        isManuallyOverridden: true
      };

      await setDoc(doc(db, 'attendanceSummary', editingRecord.id), updateData, { merge: true });

      // Add to Audit Trail
      await addDoc(collection(db, 'attendanceAuditLogs'), {
        attendanceId: editingRecord.id,
        employeeEmail: editingRecord.employeeEmail,
        date: editingRecord.attendanceDate,
        originalStatus: oldStatus,
        newStatus: editStatus,
        reason: editComment,
        modifiedBy: `${user.name} (${user.email})`,
        timestamp: getLiveTimeISO()
      });

      toast.success('Attendance updated successfully.');
      setEditingRecord(null);
      setEditComment('');
      loadData();

    } catch (e) {
      console.error(e);
      toast.error('Failed to update attendance');
    }
  };

  const runExport = async (format: 'csv' | 'xlsx') => {
    let data = filteredRecords.map(r => ({
      'Employee Name': r.employeeName,
      'Email': r.employeeEmail,
      'Employee ID': r.employeeId || '',
      'Process': r.process,
      'Team Lead': r.mappedTL,
      'Manager': r.mappedManager,
      'Attendance Date': r.attendanceDate,
      'Session Start': new Date(r.sessionStart).toLocaleString(),
      'Session End': new Date(r.sessionEnd).toLocaleString(),
      'Productive Minutes': r.productiveMinutes,
      'Attendance Status': r.attendanceStatus,
      'Modified By': r.lastModifiedBy || '',
      'Last Modified Timestamp': r.lastModifiedTimestamp || ''
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance_Data');
    
    const fileName = `Attendance_Report_${getISTDateStr(getLiveTime())}`;
    const zip = new JSZip();

    if (format === 'csv') {
       const csvContent = XLSX.write(wb, { bookType: 'csv', type: 'string' });
       zip.file(`${fileName}.csv`, csvContent);
    } else {
       const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
       zip.file(`${fileName}.xlsx`, excelBuffer);
    }

    const zipContent = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const url = URL.createObjectURL(zipContent);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `${fileName}.zip`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    setExportFormatModal(false);
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 overflow-hidden relative">
      <div className="shrink-0 p-3 border-b border-slate-100 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-black text-slate-800 dark:text-slate-100 tracking-tight flex items-center gap-1.5">
            <Calendar className="text-indigo-500" size={16} /> Attendance Register
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <select value={dateRange} onChange={(e) => setDateRange(e.target.value as any)} className="bg-slate-50 dark:bg-slate-800 border-none text-[11px] font-bold rounded-lg px-2.5 py-1.5 text-slate-600 dark:text-slate-300">
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="week">Last 7 Days</option>
            <option value="month">Last 30 Days</option>
            <option value="current_month">Current Month</option>
            <option value="previous_month">Previous Month</option>
            <option value="custom">Custom Range</option>
          </select>
          {dateRange === 'custom' && (
            <div className="flex items-center gap-1">
              <input type="date" value={customStartDate} onChange={e => setCustomStartDate(e.target.value)} className="bg-slate-50 dark:bg-slate-800 border-none rounded-lg px-2 py-1 text-[11px] font-bold text-slate-600 dark:text-slate-300" />
              <span className="text-slate-400 text-xs">to</span>
              <input type="date" value={customEndDate} onChange={e => setCustomEndDate(e.target.value)} className="bg-slate-50 dark:bg-slate-800 border-none rounded-lg px-2 py-1 text-[11px] font-bold text-slate-600 dark:text-slate-300" />
            </div>
          )}
          {canExportAttendance && (
            <button onClick={() => setExportFormatModal(true)} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400 rounded-lg font-bold text-[11px] transition-colors">
              <Download size={12} /> Export
            </button>
          )}
          {roleNormalized === 'ADMIN' && (
            <button 
              id="run-attendance-sync-btn"
              onClick={handleSyncAttendance} 
              disabled={syncing} 
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-500 text-white hover:bg-indigo-600 rounded-lg font-bold text-[11px] transition-colors"
            >
              <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing...' : 'Run Attendance Sync'}
            </button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="p-3 grid grid-cols-2 md:grid-cols-5 gap-2.5">
        {[
          { label: 'Present', val: summary.present, color: 'text-emerald-650 dark:text-emerald-400' },
          { label: 'Half Day', val: summary.halfDay, color: 'text-amber-650 dark:text-amber-400' },
          { label: 'Absent', val: summary.absent, color: 'text-rose-650 dark:text-rose-400' },
          { label: 'Attendance %', val: `${summary.attendancePct}%`, color: 'text-indigo-650 dark:text-indigo-400' },
          { label: 'Manual Overrides', val: summary.manualOverrides, color: 'text-slate-655 text-slate-500 dark:text-slate-400' }
        ].map((c, i) => (
          <div key={i} className="bg-white dark:bg-slate-800 p-2 border border-slate-100 dark:border-slate-800 rounded-xl shadow-xs text-center flex flex-col justify-center">
            <div className="text-[9px] font-black tracking-widest text-slate-400 dark:text-slate-500 uppercase leading-none">{c.label}</div>
            <div className={`text-lg font-black ${c.color} mt-1.5`}>{c.val}</div>
          </div>
        ))}
      </div>

      {/* Advanced Filters */}
      <div className="px-3 pb-2 flex flex-wrap gap-2 text-xs">
        <input 
          type="text" 
          placeholder="Search Employee..." 
          value={searchTerm} 
          onChange={e => setSearchTerm(e.target.value)} 
          className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-1 cursor-text outline-none text-xs font-bold text-slate-700 dark:text-slate-100 placeholder-slate-400 w-44" 
        />
        <MultiSelectDropdown 
          options={['Present', 'Half Day', 'Absent']}
          selectedValues={selectedStatuses}
          onToggle={(val) => setSelectedStatuses(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
          placeholder="All Statuses"
        />
        <MultiSelectDropdown 
          options={availableProcesses}
          selectedValues={selectedProcesses}
          onToggle={(val) => setSelectedProcesses(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
          placeholder="All Processes"
        />
        <MultiSelectDropdown 
          options={availableLocations}
          selectedValues={selectedLocations}
          onToggle={(val) => setSelectedLocations(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
          placeholder="All Locations"
        />
        {isStrictAdminOrManager && (
          <>
            <MultiSelectDropdown 
              options={availableTLs}
              selectedValues={selectedTLs}
              onToggle={(val) => setSelectedTLs(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
              placeholder="All Team Leaders"
            />
            <MultiSelectDropdown 
              options={availableManagers}
              selectedValues={selectedManagers}
              onToggle={(val) => setSelectedManagers(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
              placeholder="All Managers"
            />
          </>
        )}
        {(isTLRole && !isStrictAdminOrManager) && (
          <MultiSelectDropdown 
            options={availableTLs}
            selectedValues={selectedTLs}
            onToggle={(val) => setSelectedTLs(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])}
            placeholder="Team Leader Filter"
          />
        )}
      </div>

      <div className="flex-1 overflow-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center p-12 text-xs text-slate-405 text-slate-400">Loading Attendance...</div>
        ) : (
          <div className="space-y-3">
            <div className="bg-white dark:bg-slate-900 border border-slate-150 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-150 dark:border-slate-850 dark:border-slate-800 text-[10px] font-black tracking-wider text-slate-500 uppercase select-none">
                    <th className="py-1.5 px-3 pl-4">Employee</th>
                    <th className="py-1.5 px-3">Date</th>
                    <th className="py-1.5 px-3">Session Times</th>
                    <th className="py-1.5 px-3">Productive Mins</th>
                    <th className="py-1.5 px-3">Status</th>
                    {canModifyAttendance && <th className="py-1.5 px-3 text-right pr-4">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredRecords.map(r => (
                    <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                      <td className="py-1.5 px-3 pl-4">
                        <div className="flex items-center gap-2">
                           {(() => {
                             const ap = userLookup[r.employeeEmail.toLowerCase().trim()];
                             return (
                               <div className="w-7 h-7 rounded-full overflow-hidden bg-slate-100 flex items-center justify-center font-bold text-[10px] text-slate-400 border border-slate-200">
                                 {ap?.photoURL ? (
                                   <img src={ap.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                 ) : (
                                   (r.employeeName || '??').split(' ').map(n => n[0]).slice(0, 2).join('')
                                 )}
                               </div>
                             );
                           })()}
                           <div>
                             <div className="font-extrabold text-slate-800 dark:text-slate-200 text-xs leading-none">{r.employeeName}</div>
                             <div className="text-[10px] text-slate-400 mt-0.5 leading-none">{r.employeeEmail}</div>
                           </div>
                        </div>
                        {r.isOvernight && <span className="mt-1 inline-flex items-center gap-0.5 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 text-[8px] px-1 py-0.2 rounded font-bold uppercase ml-9"><Clock size={9} /> Overnight</span>}
                      </td>
                      <td className="py-1.5 px-3 text-xs font-bold text-slate-600 dark:text-slate-300">
                        {r.attendanceDate}
                      </td>
                      <td className="py-1.5 px-3 text-xs text-slate-500 font-mono">
                        {new Date(r.sessionStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  &rarr;  
                        {new Date(r.sessionEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="py-1.5 px-3">
                        <div className="font-mono text-xs font-black text-slate-700 dark:text-slate-300">
                          {r.productiveMinutes}m
                        </div>
                        <div className="text-[10px] text-slate-400">Break: {r.totalBreakMinutes}m</div>
                      </td>
                      <td className="py-1.5 px-3">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-black uppercase ${
                          r.attendanceStatus === 'Present' ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-400' :
                          r.attendanceStatus === 'Half Day' ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-400' :
                          'bg-rose-100 dark:bg-rose-950/40 text-rose-800 dark:text-rose-400'
                        }`}>
                          {r.attendanceStatus === 'Present' ? <CheckCircle size={10} /> : 
                           r.attendanceStatus === 'Half Day' ? <ClockAlert size={10} /> : <XCircle size={10} />}
                          {r.attendanceStatus}
                        </span>
                        {r.lastModifiedBy && <div className="text-[9px] text-slate-400 mt-0.5 leading-none">Edited manually</div>}
                      </td>
                      {canModifyAttendance && (
                        <td className="py-1.5 px-3 text-right pr-4">
                          <button 
                            onClick={() => openEditModal(r)}
                            className="text-[10px] font-bold text-indigo-500 hover:text-indigo-650 px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/40 rounded transition-colors"
                          >
                            Modify
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {filteredRecords.length === 0 && (
                    <tr>
                      <td colSpan={canModifyAttendance ? 6 : 5} className="py-6 text-center text-slate-400 text-xs">
                        No matching records found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {hasMore && (
              <div className="flex justify-center mt-4">
                <button 
                  onClick={() => fetchAttendanceRecords(true)} 
                  disabled={loadingMore}
                  className="px-6 py-2 bg-indigo-600 text-white font-bold rounded-xl text-xs flex items-center gap-2 hover:bg-indigo-700 disabled:opacity-50 transition-all"
                >
                  {loadingMore ? <RefreshCw size={14} className="animate-spin" /> : 'Load More Records'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editingRecord && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-6 w-full max-w-md border border-slate-200 dark:border-slate-800"
          >
            <h3 className="text-lg font-black text-slate-800 dark:text-slate-100 mb-4">Modify Attendance</h3>
            <p className="text-xs text-slate-500 mb-4">You are changing the attendance status for <b>{editingRecord.employeeName}</b> on <b>{editingRecord.attendanceDate}</b>.</p>
            
            <form onSubmit={handleUpdateRecord} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-600 block mb-1">New Status</label>
                <div className="flex gap-2">
                  {['Present', 'Half Day', 'Absent'].map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setEditStatus(s as any)}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors ${
                        editStatus === s 
                          ? 'bg-indigo-600 text-white' 
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-600 block mb-1">Reason for Modification (Mandatory)</label>
                <textarea 
                  required
                  rows={3}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
                  placeholder="E.g. System missed clock out, corrected manually based on confirmation."
                  value={editComment}
                  onChange={e => setEditComment(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button 
                  type="button" 
                  onClick={() => setEditingRecord(null)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  disabled={!editComment.trim() || editStatus === editingRecord.attendanceStatus}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
      
      {/* Export Format Modal */}
      {exportFormatModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-6 w-full max-w-xs border border-slate-200 dark:border-slate-800">
            <h3 className="text-lg font-black text-slate-800 dark:text-slate-100 mb-4">Select Export Format</h3>
            <div className="flex gap-2">
              <button onClick={() => runExport('csv')} className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-colors">CSV</button>
              <button onClick={() => runExport('xlsx')} className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-colors">Excel (.xlsx)</button>
              <button onClick={() => setExportFormatModal(false)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold">Cancel</button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
