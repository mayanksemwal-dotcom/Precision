import React, { useState, useMemo, useRef, useEffect } from 'react';
import { 
  Upload, 
  FileDown, 
  CheckCircle2, 
  AlertTriangle, 
  AlertCircle, 
  X, 
  RefreshCw, 
  Search, 
  Check, 
  ShieldCheck, 
  ArrowRight, 
  FileSpreadsheet, 
  Filter, 
  Info, 
  Database,
  ArrowUpDown,
  Download
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { db, auth } from '../../lib/firebase';
import { doc, writeBatch, getDoc, collection, setDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { 
  UserProfile 
} from '../../types';
import { 
  OrgTree, 
  normalizeHierarchyUser, 
  validateHierarchy, 
  buildAuthoritativeLookupMaps, 
  normalizeHierarchyReference, 
  getHierarchyPersistencePayload,
  isPlaceholderValue,
  NodeValidationResult
} from '../../lib/hierarchy';
import { safeStorage } from '../../lib/safeStorage';
import { useRoster } from '../../contexts/RosterContext';

interface BulkHierarchyRepairModalProps {
  isOpen: boolean;
  onClose: () => void;
  allUsers: any[];
  adminTheme: 'light' | 'dark';
  onRefresh: () => void;
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export interface ParsedHierarchyRow {
  rowNum: number;
  rawRow: any;
  targetUid: string | null;
  targetEmployeeId: string;
  targetEmail: string;
  targetName: string;
  targetRole: string;
  targetDepartment: string;
  targetProcess: string;
  
  // Current assignments
  currentTLUid: string | null;
  currentTLName: string;
  currentTLEmail: string;
  currentMgrUid: string | null;
  currentMgrName: string;
  currentMgrEmail: string;
  
  // Proposed assignments
  proposedTLUid: string | null;
  proposedTLName: string;
  proposedTLEmail: string;
  proposedMgrUid: string | null;
  proposedMgrName: string;
  proposedMgrEmail: string;
  
  // Status & Validation
  status: 'VALID_CHANGE' | 'UNCHANGED' | 'ERROR';
  hasTLChange: boolean;
  hasMgrChange: boolean;
  wasBlankPreserved?: boolean;
  validationMessage: string;
  validationDetails?: string;
  commitStatus?: 'PENDING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
}

export const BulkHierarchyRepairModal: React.FC<BulkHierarchyRepairModalProps> = ({
  isOpen,
  onClose,
  allUsers,
  adminTheme,
  onRefresh,
  logAdminEvent
}) => {
  const { refreshRoster } = useRoster();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [rawParsedData, setRawParsedData] = useState<any[] | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedHierarchyRow[]>([]);
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'CHANGES' | 'ERRORS' | 'VALID' | 'UNCHANGED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitProgress, setCommitProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
  const [commitCompleted, setCommitCompleted] = useState(false);
  const [commitSummary, setCommitSummary] = useState<{ success: number; failed: number; skipped: number } | null>(null);

  // Authoritative Lookup Maps for all current users
  const lookupMaps = useMemo(() => {
    return buildAuthoritativeLookupMaps(allUsers);
  }, [allUsers]);

  // Current Validation Results
  const currentValidation = useMemo(() => {
    return validateHierarchy(allUsers);
  }, [allUsers]);

  // Filter and search computation
  const filteredRows = useMemo(() => {
    return parsedRows.filter(row => {
      // Filter tab
      if (filterStatus === 'CHANGES' && row.status !== 'VALID_CHANGE') return false;
      if (filterStatus === 'ERRORS' && row.status !== 'ERROR') return false;
      if (filterStatus === 'VALID' && row.status === 'ERROR') return false;
      if (filterStatus === 'UNCHANGED' && row.status !== 'UNCHANGED') return false;

      // Search query
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesName = row.targetName.toLowerCase().includes(q);
        const matchesEmail = row.targetEmail.toLowerCase().includes(q);
        const matchesEmpId = row.targetEmployeeId.toLowerCase().includes(q);
        const matchesUid = (row.targetUid || '').toLowerCase().includes(q);
        const matchesTL = row.proposedTLName.toLowerCase().includes(q);
        const matchesMgr = row.proposedMgrName.toLowerCase().includes(q);
        const matchesMsg = row.validationMessage.toLowerCase().includes(q);

        return matchesName || matchesEmail || matchesEmpId || matchesUid || matchesTL || matchesMgr || matchesMsg;
      }

      return true;
    });
  }, [parsedRows, filterStatus, searchQuery]);

  const metrics = useMemo(() => {
    const total = parsedRows.length;
    const changes = parsedRows.filter(r => r.status === 'VALID_CHANGE').length;
    const errors = parsedRows.filter(r => r.status === 'ERROR').length;
    const unchanged = parsedRows.filter(r => r.status === 'UNCHANGED').length;
    const preservedBlank = parsedRows.filter(r => r.wasBlankPreserved).length;
    const valid = total - errors;
    return { total, changes, errors, unchanged, preservedBlank, valid };
  }, [parsedRows]);

  const cardClass = adminTheme === 'dark' ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-800';
  const innerCardClass = adminTheme === 'dark' ? 'bg-slate-950/60 border-slate-800/80' : 'bg-slate-50 border-slate-200/80';

  /**
   * 1. EXPORT HIERARCHY FOR REPAIR
   */
  const handleExportHierarchy = () => {
    try {
      const toastId = toast.loading('Generating complete hierarchy export...');

      const exportData = allUsers.map((u, idx) => {
        const norm = normalizeHierarchyUser(u);
        const val = currentValidation.results.get(u.uid);
        
        const tlUser = norm.teamLeadUid ? allUsers.find(x => x.uid === norm.teamLeadUid) : null;
        const mgrUser = norm.managerUid ? allUsers.find(x => x.uid === norm.managerUid) : null;

        return {
          'Employee ID': u.employeeId || '',
          'Employee Email': (u.email || '').toLowerCase().trim(),
          'Employee Name': u.fullName || u.name || '',
          'User UID': u.uid,
          'Role': u.role || 'AGENT',
          'Department': u.department || 'Operations',
          'Process': u.process || '',
          'Manager Name': mgrUser ? (mgrUser.fullName || mgrUser.name || '') : (u.managerName || u.mappedManagerName || ''),
          'Manager Email': mgrUser ? (mgrUser.email || '').toLowerCase() : (u.managerEmail || u.mappedManagerEmail || ''),
          'Manager UID': norm.managerUid || '',
          'Team Lead Name': tlUser ? (tlUser.fullName || tlUser.name || '') : (u.teamLeadName || ''),
          'Team Lead Email': tlUser ? (tlUser.email || '').toLowerCase() : (u.teamLeadEmail || ''),
          'Team Lead UID': norm.teamLeadUid || '',
          'Current Manager Mapping ID': u.mappedManagerId || u.managerId || '',
          'Current Team Lead Mapping ID': u.teamLeadId || u.tlId || '',
          'Hierarchy Status': val ? val.status : 'UNKNOWN',
          'Validation Error': val && val.status !== 'HEALTHY' ? val.message : 'None',
          'Validation Details': val && val.details ? val.details : ''
        };
      });

      // Sort by Role hierarchy and Name
      exportData.sort((a, b) => a['Employee Name'].localeCompare(b['Employee Name']));

      const ws = XLSX.utils.json_to_sheet(exportData);
      
      // Configure column widths
      ws['!cols'] = [
        { wch: 14 }, // Employee ID
        { wch: 28 }, // Employee Email
        { wch: 22 }, // Employee Name
        { wch: 30 }, // User UID
        { wch: 14 }, // Role
        { wch: 16 }, // Department
        { wch: 16 }, // Process
        { wch: 22 }, // Manager Name
        { wch: 28 }, // Manager Email
        { wch: 30 }, // Manager UID
        { wch: 22 }, // Team Lead Name
        { wch: 28 }, // Team Lead Email
        { wch: 30 }, // Team Lead UID
        { wch: 26 }, // Current Manager Mapping ID
        { wch: 26 }, // Current Team Lead Mapping ID
        { wch: 18 }, // Hierarchy Status
        { wch: 40 }, // Validation Error
        { wch: 40 }  // Validation Details
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Hierarchy_Repair_Master');

      const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      XLSX.writeFile(wb, `Hierarchy_Repair_Export_${dateStr}.xlsx`);

      toast.success(`Exported ${exportData.length} employee hierarchy records successfully!`, { id: toastId });
    } catch (err: any) {
      console.error('[BulkHierarchyRepairModal] Export failed:', err);
      toast.error(`Export failed: ${err.message}`);
    }
  };

  /**
   * 2. UPLOAD & PARSE CORRECTED HIERARCHY FILE
   */
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingFile(true);
    setUploadedFileName(file.name);
    setCommitCompleted(false);
    setCommitSummary(null);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        let rawJson: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (!rawJson || rawJson.length === 0) {
          toast.error('The uploaded file contains no data rows.');
          setIsProcessingFile(false);
          return;
        }

        // Fallback for TSV incorrectly parsed as single column CSV
        if (rawJson.length > 0) {
          const keys = Object.keys(rawJson[0]);
          if (keys.length === 1 && (keys[0].includes('\t') || keys[0].includes('    '))) {
            console.log('Detected TSV/Spacing parsing issue, falling back to manual split');
            const delimiter = keys[0].includes('\t') ? '\t' : '    ';
            const headers = keys[0].split(delimiter).map(k => k.trim());
            rawJson = rawJson.map(row => {
              const values = String(row[keys[0]]).split(delimiter);
              const newRow: any = {};
              headers.forEach((h, i) => {
                newRow[h] = values[i] !== undefined ? values[i].trim() : '';
              });
              return newRow;
            });
          }
        }

        setRawParsedData(rawJson);
      } catch (err: any) {
        console.error('[BulkHierarchyRepairModal] Parse failed:', err);
        toast.error(`Failed to parse file: ${err.message}`);
      } finally {
        setIsProcessingFile(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };

    reader.onerror = () => {
      toast.error('Failed to read file.');
      setIsProcessingFile(false);
    };

    reader.readAsBinaryString(file);
  };

  /**
   * 3. MATCHING, NORMALIZATION & VALIDATION ENGINE
   */
  const processUploadedJson = (rows: any[]) => {
    console.log(`[BulkHierarchyRepair] Processing ${rows.length} rows. lookupMaps size: ${lookupMaps.uidByUid.size}`);
    const parsed: ParsedHierarchyRow[] = [];
    const simulatedProposedUsers: any[] = allUsers.map(u => ({ ...u }));

    // Detect if TL / Manager columns are explicitly present in the uploaded file headers
    const firstRow = rows[0] || {};
    const allColKeys = Object.keys(firstRow);
    const hasTLColumnsInFile = allColKeys.some(k => {
      const clean = k.toLowerCase().replace(/[\s\-_]/g, '');
      return (
        clean.includes('teamlead') ||
        clean === 'tl' ||
        clean.startsWith('tl') ||
        clean.includes('teamleaduid') ||
        clean.includes('teamleademail') ||
        clean.includes('teamleadname') ||
        clean.includes('teamleadid')
      );
    });
    const hasMgrColumnsInFile = allColKeys.some(k => {
      const clean = k.toLowerCase().replace(/[\s\-_]/g, '');
      return (
        clean.includes('manager') ||
        clean.includes('mappedmanager') ||
        clean.includes('manageruid') ||
        clean.includes('manageremail') ||
        clean.includes('managername') ||
        clean.includes('managerid')
      );
    });

    // Helper to find column value by key variations
    const getColValue = (row: any, ...keys: string[]): string => {
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
          return String(row[k]).trim();
        }
        // Case-insensitive key match
        const lowerK = k.toLowerCase().replace(/[\s\-_]/g, '');
        for (const rowKey of Object.keys(row)) {
          if (rowKey.toLowerCase().replace(/[\s\-_]/g, '') === lowerK) {
            const val = String(row[rowKey]).trim();
            if (val !== '') return val;
          }
        }
      }
      return '';
    };

    // Helper to check for clear/blank/unassigned indicators
    const isClearValue = (val: string | null | undefined) => {
      if (!val) return true;
      const l = val.toString().toLowerCase().trim().replace(/[^a-z0-9]/g, '');
      return (
        l === '' ||
        l === 'none' ||
        l === 'na' ||
        l === 'null' ||
        l === 'undefined' ||
        l === 'unassigned' ||
        l === 'clear' ||
        l === 'cleared' ||
        l === 'notapplicable' ||
        l === '0' ||
        l === 'noteamlead' ||
        l === 'nomanager' ||
        l === 'notassigned' ||
        l === 'no' ||
        l === 'nil' ||
        l === 'empty' ||
        l === 'root' ||
        l === 'direct' ||
        l === 'directtomanager'
      );
    };

    // First Pass: Resolve target employees and proposed supervisors
    const targetUidSeen = new Set<string>();

    rows.forEach((row, index) => {
      const rowNum = index + 2; // Accounting for 1-based index + header row

      const rawUid = getColValue(row, 'User UID', 'Firebase UID', 'UID', 'User ID', 'UserUID', 'FirebaseUID');
      const rawEmpId = getColValue(row, 'Employee ID', 'EmployeeID', 'Emp ID', 'EmpID');
      const rawEmail = getColValue(row, 'Employee Email', 'Email', 'EmployeeEmail', 'Email Address');
      const rawName = getColValue(row, 'Employee Name', 'Name', 'Full Name', 'FullName');
      const rawRole = getColValue(row, 'Role', 'Designation');
      const rawDept = getColValue(row, 'Department', 'Dept');
      const rawProcess = getColValue(row, 'Process');

      // Supervisor columns
      const rawTLUid = getColValue(row, 'Team Lead UID', 'TeamLeadUID', 'Team Lead ID', 'TeamLeadId', 'TL ID', 'TL UID', 'TLId');
      const rawTLEmail = getColValue(row, 'Team Lead Email', 'TeamLeadEmail', 'TL Email', 'TLEmail');
      const rawTLName = getColValue(row, 'Team Lead Name', 'TeamLeadName', 'Team Lead', 'TL Name', 'TL');

      const rawMgrUid = getColValue(row, 'Manager UID', 'ManagerUID', 'Manager ID', 'ManagerId', 'Mapped Manager UID', 'ManagerUid');
      const rawMgrEmail = getColValue(row, 'Manager Email', 'ManagerEmail', 'Mapped Manager Email', 'ManagerEmail');
      const rawMgrName = getColValue(row, 'Manager Name', 'ManagerName', 'Manager', 'Mapped Manager Name');

      // STEP 1: TARGET EMPLOYEE MATCHING (UID > Employee ID > Email. Never Name alone!)
      let targetUser: any = null;

      if (rawUid && lookupMaps.uidByUid.has(rawUid)) {
        const uid = lookupMaps.uidByUid.get(rawUid)!;
        targetUser = allUsers.find(u => u.uid === uid);
      } else if (rawEmpId && lookupMaps.uidByEmployeeId.has(rawEmpId.toLowerCase())) {
        const uid = lookupMaps.uidByEmployeeId.get(rawEmpId.toLowerCase())!;
        targetUser = allUsers.find(u => u.uid === uid);
      } else if (rawEmail && lookupMaps.uidByEmail.has(rawEmail.toLowerCase())) {
        const uid = lookupMaps.uidByEmail.get(rawEmail.toLowerCase())!;
        targetUser = allUsers.find(u => u.uid === uid);
      }

      if (!targetUser) {
        parsed.push({
          rowNum,
          rawRow: row,
          targetUid: null,
          targetEmployeeId: rawEmpId,
          targetEmail: rawEmail,
          targetName: rawName || 'Unknown Employee',
          targetRole: rawRole || 'AGENT',
          targetDepartment: rawDept,
          targetProcess: rawProcess,
          currentTLUid: null,
          currentTLName: 'N/A',
          currentTLEmail: 'N/A',
          currentMgrUid: null,
          currentMgrName: 'N/A',
          currentMgrEmail: 'N/A',
          proposedTLUid: null,
          proposedTLName: rawTLName || 'None',
          proposedTLEmail: rawTLEmail || 'None',
          proposedMgrUid: null,
          proposedMgrName: rawMgrName || 'None',
          proposedMgrEmail: rawMgrEmail || 'None',
          status: 'ERROR',
          hasTLChange: false,
          hasMgrChange: false,
          validationMessage: 'Target Employee Not Found',
          validationDetails: `Could not match employee using UID (${rawUid || 'none'}), Emp ID (${rawEmpId || 'none'}), or Email (${rawEmail || 'none'}). Matching by name alone is disallowed for safety.`
        });
        return;
      }

      const targetUid = targetUser.uid;

      // Check for duplicate rows for same employee in uploaded file
      if (targetUidSeen.has(targetUid)) {
        parsed.push({
          rowNum,
          rawRow: row,
          targetUid,
          targetEmployeeId: targetUser.employeeId || rawEmpId,
          targetEmail: targetUser.email || rawEmail,
          targetName: targetUser.fullName || targetUser.name || rawName,
          targetRole: targetUser.role || rawRole,
          targetDepartment: targetUser.department || rawDept,
          targetProcess: targetUser.process || rawProcess,
          currentTLUid: null,
          currentTLName: '',
          currentTLEmail: '',
          currentMgrUid: null,
          currentMgrName: '',
          currentMgrEmail: '',
          proposedTLUid: null,
          proposedTLName: rawTLName || 'None',
          proposedTLEmail: rawTLEmail || 'None',
          proposedMgrUid: null,
          proposedMgrName: rawMgrName || 'None',
          proposedMgrEmail: rawMgrEmail || 'None',
          status: 'ERROR',
          hasTLChange: false,
          hasMgrChange: false,
          validationMessage: 'Duplicate Row Detected',
          validationDetails: `Employee ${targetUser.fullName || targetUser.name || targetUid} is defined multiple times in the upload sheet. Remove duplicates to proceed.`
        });
        return;
      }
      targetUidSeen.add(targetUid);

      // STEP 2: RESOLVE CURRENT HIERARCHY CANONICALLY
      const rawCurrTL = targetUser.teamLeadUid || targetUser.teamLeadId || targetUser.tlId || targetUser.teamLeadEmail;
      const currentTLUid = normalizeHierarchyReference(rawCurrTL, lookupMaps);

      const rawCurrMgr = targetUser.mappedManagerUid || targetUser.mappedManagerId || targetUser.managerUid || targetUser.managerId || targetUser.mappedManagerEmail || targetUser.managerEmail;
      const currentMgrUid = normalizeHierarchyReference(rawCurrMgr, lookupMaps);

      const currentTLUser = currentTLUid ? allUsers.find(u => u.uid === currentTLUid) : null;
      const currentMgrUser = currentMgrUid ? allUsers.find(u => u.uid === currentMgrUid) : null;

      // STEP 3: RESOLVE PROPOSED SUPERVISORS (AUTHORITATIVELY FROM UPLOADED FILE)
      // Resolve Proposed Team Lead
      let proposedTLUid: string | null = null;
      let tlResolutionError: string | null = null;
      let wasTLBlankPreserved = false;

      if (hasTLColumnsInFile) {
        const isTLBlankOrClear = isClearValue(rawTLUid) && isClearValue(rawTLEmail) && isClearValue(rawTLName);
        const explicitClearKeyword = [rawTLUid, rawTLEmail, rawTLName].some(v => v && (v.toString().trim().toUpperCase() === 'CLEAR' || v.toString().trim().toUpperCase() === 'REMOVE'));

        if (isTLBlankOrClear) {
          if (explicitClearKeyword) {
            // Explicit keyword to clear Team Lead
            proposedTLUid = null;
          } else if (currentTLUid) {
            // Blank cell in uploaded file for employee with existing TL -> PRESERVE existing TL!
            proposedTLUid = currentTLUid;
            wasTLBlankPreserved = true;
          } else {
            proposedTLUid = null;
          }
        } else {
          const tlUidMatch = rawTLUid && !isPlaceholderValue(rawTLUid) ? normalizeHierarchyReference(rawTLUid, lookupMaps) : null;
          const tlEmailMatch = rawTLEmail && !isPlaceholderValue(rawTLEmail) ? normalizeHierarchyReference(rawTLEmail, lookupMaps) : null;
          
          let tlNameMatch: string | null = null;
          const normTLName = rawTLName && !isPlaceholderValue(rawTLName) ? rawTLName.toLowerCase().trim() : '';
          if (normTLName) {
            if (lookupMaps.ambiguousNames?.has(normTLName) && !tlUidMatch && !tlEmailMatch) {
              tlResolutionError = `Ambiguous Team Lead Name "${rawTLName}". Multiple employees share this name. Please provide Team Lead UID or Email.`;
            } else {
              tlNameMatch = normalizeHierarchyReference(rawTLName, lookupMaps);
            }
          }

          if (tlUidMatch) {
            proposedTLUid = tlUidMatch;
          } else if (tlEmailMatch) {
            proposedTLUid = tlEmailMatch;
          } else if (tlNameMatch) {
            proposedTLUid = tlNameMatch;
          } else if (!tlResolutionError) {
            tlResolutionError = `Could not resolve Team Lead. UID: "${rawTLUid || 'N/A'}", Email: "${rawTLEmail || 'N/A'}", Name: "${rawTLName || 'N/A'}". No matching employee found.`;
          }
        }
      } else {
        // No TL columns in file -> Retain current TL
        proposedTLUid = currentTLUid;
      }

      // Resolve Proposed Manager
      let proposedMgrUid: string | null = null;
      let mgrResolutionError: string | null = null;
      let wasMgrBlankPreserved = false;

      if (hasMgrColumnsInFile) {
        const isMgrBlankOrClear = isClearValue(rawMgrUid) && isClearValue(rawMgrEmail) && isClearValue(rawMgrName);
        const explicitClearKeyword = [rawMgrUid, rawMgrEmail, rawMgrName].some(v => v && (v.toString().trim().toUpperCase() === 'CLEAR' || v.toString().trim().toUpperCase() === 'REMOVE'));

        if (isMgrBlankOrClear) {
          if (explicitClearKeyword) {
            // Explicit keyword to clear Manager
            proposedMgrUid = null;
          } else if (currentMgrUid) {
            // Blank cell in uploaded file for employee with existing Manager -> PRESERVE existing Manager!
            proposedMgrUid = currentMgrUid;
            wasMgrBlankPreserved = true;
          } else {
            proposedMgrUid = null;
          }
        } else {
          const mgrUidMatch = rawMgrUid && !isPlaceholderValue(rawMgrUid) ? normalizeHierarchyReference(rawMgrUid, lookupMaps) : null;
          const mgrEmailMatch = rawMgrEmail && !isPlaceholderValue(rawMgrEmail) ? normalizeHierarchyReference(rawMgrEmail, lookupMaps) : null;
          
          let mgrNameMatch: string | null = null;
          const normMgrName = rawMgrName && !isPlaceholderValue(rawMgrName) ? rawMgrName.toLowerCase().trim() : '';
          if (normMgrName) {
            if (lookupMaps.ambiguousNames?.has(normMgrName) && !mgrUidMatch && !mgrEmailMatch) {
              mgrResolutionError = `Ambiguous Manager Name "${rawMgrName}". Multiple employees share this name. Please provide Manager UID or Email.`;
            } else {
              mgrNameMatch = normalizeHierarchyReference(rawMgrName, lookupMaps);
            }
          }

          if (mgrUidMatch) {
            proposedMgrUid = mgrUidMatch;
          } else if (mgrEmailMatch) {
            proposedMgrUid = mgrEmailMatch;
          } else if (mgrNameMatch) {
            proposedMgrUid = mgrNameMatch;
          } else if (!mgrResolutionError) {
            mgrResolutionError = `Could not resolve Manager. UID: "${rawMgrUid || 'N/A'}", Email: "${rawMgrEmail || 'N/A'}", Name: "${rawMgrName || 'N/A'}". No matching employee found.`;
          }
        }
      } else {
        // No Manager columns in file -> Retain current Manager
        proposedMgrUid = currentMgrUid;
      }

      // STEP 4: VALIDATION & CHANGE DETECTION
      let validationError: string | null = null;
      let validationDetails = '';

      if (proposedTLUid && proposedTLUid === targetUid) {
        validationError = 'Self-Reporting Disallowed (TL)';
        validationDetails = `Employee cannot be assigned as their own Team Lead.`;
      } else if (proposedMgrUid && proposedMgrUid === targetUid) {
        validationError = 'Self-Reporting Disallowed (Manager)';
        validationDetails = `Employee cannot be assigned as their own Manager.`;
      } else if (tlResolutionError) {
        validationError = 'Invalid Team Lead Reference';
        validationDetails = tlResolutionError;
      } else if (mgrResolutionError) {
        validationError = 'Invalid Manager Reference';
        validationDetails = mgrResolutionError;
      }

      const hasTLChange = (currentTLUid || null) !== (proposedTLUid || null);
      const hasMgrChange = (currentMgrUid || null) !== (proposedMgrUid || null);
      const hasChanges = hasTLChange || hasMgrChange;

      const propTLUser = proposedTLUid ? allUsers.find(u => u.uid === proposedTLUid) : null;
      const propMgrUser = proposedMgrUid ? allUsers.find(u => u.uid === proposedMgrUid) : null;

      let status: ParsedHierarchyRow['status'] = 'VALID_CHANGE';
      if (validationError) {
        status = 'ERROR';
      } else if (!hasChanges) {
        status = 'UNCHANGED';
      }

      parsed.push({
        rowNum,
        rawRow: row,
        targetUid,
        targetEmployeeId: targetUser.employeeId || rawEmpId,
        targetEmail: targetUser.email || rawEmail,
        targetName: targetUser.fullName || targetUser.name || rawName,
        targetRole: targetUser.role || rawRole,
        targetDepartment: targetUser.department || rawDept,
        targetProcess: targetUser.process || rawProcess,
        currentTLUid,
        currentTLName: currentTLUser ? (currentTLUser.fullName || currentTLUser.name) : (currentTLUid ? currentTLUid : 'None'),
        currentTLEmail: currentTLUser ? currentTLUser.email : 'None',
        currentMgrUid,
        currentMgrName: currentMgrUser ? (currentMgrUser.fullName || currentMgrUser.name) : (currentMgrUid ? currentMgrUid : 'None'),
        currentMgrEmail: currentMgrUser ? currentMgrUser.email : 'None',
        proposedTLUid,
        proposedTLName: propTLUser ? (propTLUser.fullName || propTLUser.name) : (proposedTLUid ? proposedTLUid : 'None'),
        proposedTLEmail: propTLUser ? propTLUser.email : 'None',
        proposedMgrUid,
        proposedMgrName: propMgrUser ? (propMgrUser.fullName || propMgrUser.name) : (proposedMgrUid ? proposedMgrUid : 'None'),
        proposedMgrEmail: propMgrUser ? propMgrUser.email : 'None',
        status,
        hasTLChange,
        hasMgrChange,
        wasBlankPreserved: wasTLBlankPreserved || wasMgrBlankPreserved,
        validationMessage: validationError || (hasChanges ? 'Valid Mapping Update' : (wasTLBlankPreserved || wasMgrBlankPreserved) ? 'Preserved Existing Hierarchy' : 'No Changes Detected'),
        validationDetails: validationDetails || (hasChanges ? 'Reporting structure is valid and ready for commit.' : (wasTLBlankPreserved || wasMgrBlankPreserved) ? 'Uploaded cell was blank; existing canonical hierarchy was preserved to prevent accidental overwrite.' : 'Current and proposed hierarchy mappings are identical.')
      });

      // Update simulation model for cycle detection pass
      if (status !== 'ERROR') {
        const simIdx = simulatedProposedUsers.findIndex(u => u.uid === targetUid);
        if (simIdx !== -1) {
          simulatedProposedUsers[simIdx] = {
            ...simulatedProposedUsers[simIdx],
            teamLeadUid: proposedTLUid,
            managerUid: proposedMgrUid,
            teamLeadId: proposedTLUid || '',
            managerId: proposedMgrUid || ''
          };
        }
      }
    });

    // STEP 4: GLOBAL CYCLE DETECTION ACROSS PROPOSED TREE
    const simLookup = new Map<string, any>();
    simulatedProposedUsers.forEach(u => simLookup.set(u.uid, u));

    parsed.forEach(pRow => {
      if (pRow.status === 'ERROR' || !pRow.targetUid) return;

      const visited = new Set<string>();
      let curr: string | null = pRow.targetUid;
      let cycleDetected = false;
      const path: string[] = [];

      while (curr) {
        if (visited.has(curr)) {
          cycleDetected = true;
          path.push(curr);
          break;
        }
        visited.add(curr);
        path.push(curr);

        const simUser = simLookup.get(curr);
        if (!simUser) break;

        const tl = simUser.teamLeadUid || simUser.teamLeadId;
        const mgr = simUser.managerUid || simUser.managerId;
        curr = tl || mgr || null;
      }

      if (cycleDetected) {
        const cycleNames = path.map(uid => simLookup.get(uid)?.name || uid).join(' ➔ ');
        pRow.status = 'ERROR';
        pRow.validationMessage = 'Circular Dependency Detected';
        pRow.validationDetails = `This mapping introduces a loop in the reporting line: ${cycleNames}`;
      }
    });

    setParsedRows(parsed);

    const changesCount = parsed.filter(r => r.status === 'VALID_CHANGE').length;
    const errorsCount = parsed.filter(r => r.status === 'ERROR').length;
    
    if (errorsCount > 0) {
      const firstError = parsed.find(r => r.status === 'ERROR');
      toast.warning(`Parsed ${parsed.length} rows: ${changesCount} valid changes, ${errorsCount} validation issues found. First error: ${firstError?.validationMessage || 'Unknown'} - ${firstError?.validationDetails || ''}`, { duration: 6000 });
    } else {
      toast.success(`Parsed ${parsed.length} rows: ${changesCount} valid changes ready for review!`);
    }
  };

  // Automatically re-run validation if allUsers finishes fetching after the file was uploaded
  useEffect(() => {
    if (rawParsedData && allUsers.length > 0) {
      processUploadedJson(rawParsedData);
    }
  }, [rawParsedData, allUsers.length]);

  /**
   * 4. COMMIT BULK REPAIR TO FIRESTORE
   */
  const handleCommitBulkRepair = async (onlyValidChanges = true) => {
    const rowsToCommit = parsedRows.filter(r => r.status === 'VALID_CHANGE');

    if (rowsToCommit.length === 0) {
      toast.info('No valid changes to commit.');
      return;
    }

    setIsCommitting(true);
    const toastId = toast.loading(`Committing ${rowsToCommit.length} hierarchy updates in atomic batches...`);

    let successCount = 0;
    let failedCount = 0;
    const BATCH_SIZE = 100; // 100 users = 300 Firestore writes per batch (limit is 500)
    const totalBatches = Math.ceil(rowsToCommit.length / BATCH_SIZE);

    try {
      for (let bIdx = 0; bIdx < totalBatches; bIdx++) {
        const start = bIdx * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, rowsToCommit.length);
        const batchRows = rowsToCommit.slice(start, end);

        const batch = writeBatch(db);

        batchRows.forEach(row => {
          if (!row.targetUid) return;

          const hierarchyPayload = getHierarchyPersistencePayload({
            userUid: row.targetUid,
            teamLeadUid: row.proposedTLUid,
            managerUid: row.proposedMgrUid,
            allUsers
          });

          const userRef = doc(db, 'users', row.targetUid);
          const masterRef = doc(db, 'employee_master', row.targetUid);
          const mappingRef = doc(db, 'teamMappings', row.targetUid);

          batch.set(userRef, hierarchyPayload, { merge: true });
          batch.set(masterRef, hierarchyPayload, { merge: true });
          batch.set(mappingRef, {
            userId: row.targetUid,
            userName: row.targetName,
            teamLeadId: row.proposedTLUid || '',
            teamLeadName: row.proposedTLName || '',
            managerId: row.proposedMgrUid || '',
            managerName: row.proposedMgrName || '',
            process: row.targetProcess || '',
            lastUpdated: new Date().toISOString()
          }, { merge: true });
        });

        await batch.commit();

        batchRows.forEach(r => {
          r.commitStatus = 'SUCCESS';
          successCount++;
        });

        setCommitProgress({
          current: end,
          total: rowsToCommit.length,
          percent: Math.round((end / rowsToCommit.length) * 100)
        });
      }

      // Write Bulk Audit Log Entry
      const auditRef = doc(collection(db, 'hierarchyAuditLogs'));
      await setDoc(auditRef, {
        timestamp: new Date().toISOString(),
        actor: auth.currentUser?.email || 'admin@precision360.co.in',
        operation: 'BULK_EXCEL_REPAIR',
        totalRowsProcessed: parsedRows.length,
        committedCount: successCount,
        failedCount: failedCount,
        fileName: uploadedFileName || 'Excel_Hierarchy_Upload',
        verification: 'PASSED'
      });

      // Clear all cached IndexedDB hierarchies & downline scopes
      await safeStorage.clearAllIndexedDBByPrefix('precision360_hierarchy_nodes_');
      await safeStorage.clearAllIndexedDBByPrefix('precision360_roster_cache_');
      await safeStorage.clearAllIndexedDBByPrefix('subordinates_');

      await logAdminEvent(
        'Bulk Hierarchy Excel Repair',
        `${successCount} Employees Updated`,
        'Multiple Legacy / Unresolved Mappings',
        `Committed ${successCount} verified assignments from ${uploadedFileName}`
      );

      setCommitCompleted(true);
      setCommitSummary({
        success: successCount,
        failed: failedCount,
        skipped: parsedRows.length - successCount
      });

      toast.success(`Successfully repaired & verified ${successCount} hierarchy mappings!`, { id: toastId });
      
      // Refresh background roster
      onRefresh();
      await refreshRoster(false, false);
    } catch (err: any) {
      console.error('[BulkHierarchyRepairModal] Commit failed:', err);
      toast.error(`Commit Failed: ${err.message}`, { id: toastId });
    } finally {
      setIsCommitting(false);
    }
  };

  /**
   * 5. EXPORT VALIDATION / EXECUTION REPORT
   */
  const handleExportReport = () => {
    try {
      const reportData = parsedRows.map(r => ({
        'Row #': r.rowNum,
        'Employee ID': r.targetEmployeeId,
        'Employee Email': r.targetEmail,
        'Employee Name': r.targetName,
        'User UID': r.targetUid || 'UNRESOLVED',
        'Role': r.targetRole,
        'Department': r.targetDepartment,
        'Process': r.targetProcess,
        'Validation Status': r.status,
        'Commit Status': r.commitStatus || (r.status === 'VALID_CHANGE' ? 'READY' : 'SKIPPED'),
        'Current TL': r.currentTLName,
        'Proposed TL': r.proposedTLName,
        'TL Changed': r.hasTLChange ? 'YES' : 'NO',
        'Current Manager': r.currentMgrName,
        'Proposed Manager': r.proposedMgrName,
        'Manager Changed': r.hasMgrChange ? 'YES' : 'NO',
        'Diagnostic Message': r.validationMessage,
        'Diagnostic Details': r.validationDetails || ''
      }));

      const ws = XLSX.utils.json_to_sheet(reportData);
      ws['!cols'] = [
        { wch: 8 },
        { wch: 14 },
        { wch: 28 },
        { wch: 22 },
        { wch: 30 },
        { wch: 14 },
        { wch: 16 },
        { wch: 16 },
        { wch: 16 },
        { wch: 14 },
        { wch: 22 },
        { wch: 22 },
        { wch: 12 },
        { wch: 22 },
        { wch: 22 },
        { wch: 14 },
        { wch: 30 },
        { wch: 40 }
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Hierarchy_Repair_Report');

      const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      XLSX.writeFile(wb, `Hierarchy_Repair_Report_${dateStr}.xlsx`);
      toast.success('Validation report exported successfully!');
    } catch (err: any) {
      console.error('Report export failed:', err);
      toast.error('Failed to export report.');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className={`${cardClass} border rounded-3xl w-full max-w-6xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden`}>
        
        {/* MODAL HEADER */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-150/10 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-950/40">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-600/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-bold">
              <FileSpreadsheet size={22} />
            </div>
            <div>
              <h2 className="text-base font-black uppercase tracking-tight flex items-center gap-2">
                Bulk Hierarchy Repair & Synchronization
              </h2>
              <p className="text-xs text-slate-400">
                Export complete organizational roster, edit reporting lines in Excel, and commit batch repairs atomically.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            disabled={isCommitting}
            className="p-2 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-all disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        {/* WORKFLOW TOOLBAR */}
        <div className="px-6 py-4 border-b border-slate-150/10 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-4 bg-slate-100/30 dark:bg-slate-900/40">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Step 1: Export Master File */}
            <button
              onClick={handleExportHierarchy}
              className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition shadow-sm active:scale-95 cursor-pointer"
            >
              <FileDown size={15} /> Export for Repair (.xlsx)
            </button>

            {/* Step 2: Hidden file input & upload button */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessingFile || isCommitting}
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition shadow-sm active:scale-95 disabled:opacity-50 cursor-pointer"
            >
              {isProcessingFile ? <RefreshCw size={15} className="animate-spin" /> : <Upload size={15} />}
              <span>{isProcessingFile ? 'Parsing Spreadsheet...' : 'Upload Corrected Hierarchy'}</span>
            </button>
          </div>

          {/* Export Report button (when rows exist) */}
          {parsedRows.length > 0 && (
            <button
              onClick={handleExportReport}
              className="px-3.5 py-2 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-xs font-bold flex items-center gap-2 transition text-slate-700 dark:text-slate-300 cursor-pointer"
            >
              <Download size={14} /> Export Validation Report
            </button>
          )}
        </div>

        {/* BODY AREA */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* EMPTY STATE */}
          {parsedRows.length === 0 && !isProcessingFile && (
            <div className={`${innerCardClass} border rounded-2xl p-10 text-center max-w-xl mx-auto space-y-4 my-8`}>
              <div className="w-16 h-16 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-500 flex items-center justify-center mx-auto">
                <FileSpreadsheet size={32} />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-black text-slate-800 dark:text-slate-100 uppercase tracking-tight">
                  No Hierarchy File Uploaded Yet
                </h3>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Follow the standard 3-step repair workflow:
                </p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-left pt-2">
                <div className="p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
                  <div className="text-[10px] font-black text-indigo-500 uppercase tracking-wider">Step 1</div>
                  <div className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Export Roster</div>
                  <div className="text-[11px] text-slate-400">Download all employee hierarchy records with IDs and UIDs.</div>
                </div>
                <div className="p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
                  <div className="text-[10px] font-black text-emerald-500 uppercase tracking-wider">Step 2</div>
                  <div className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Edit in Excel</div>
                  <div className="text-[11px] text-slate-400">Update Manager & Team Lead columns with valid Emails or UIDs.</div>
                </div>
                <div className="p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
                  <div className="text-[10px] font-black text-amber-500 uppercase tracking-wider">Step 3</div>
                  <div className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Upload & Commit</div>
                  <div className="text-[11px] text-slate-400">Validate changes in real time, review impacts, and commit atomically.</div>
                </div>
              </div>
            </div>
          )}

          {/* PARSED STATE */}
          {parsedRows.length > 0 && (
            <div className="space-y-6">
              
              {/* METRICS SUMMARY CARDS */}
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                <div className={`${innerCardClass} border p-3.5 rounded-2xl text-center`}>
                  <div className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Total In File</div>
                  <div className="text-xl font-black text-slate-800 dark:text-slate-200 mt-1">{metrics.total}</div>
                </div>
                <div className="bg-indigo-50/60 dark:bg-indigo-950/20 border border-indigo-200/50 dark:border-indigo-900/30 p-3.5 rounded-2xl text-center">
                  <div className="text-[10px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">Changes Detected</div>
                  <div className="text-xl font-black text-indigo-600 dark:text-indigo-400 mt-1">{metrics.changes}</div>
                </div>
                <div className="bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-900/30 p-3.5 rounded-2xl text-center">
                  <div className="text-[10px] font-black text-amber-600 dark:text-amber-400 uppercase tracking-wider">Preserved (Blank)</div>
                  <div className="text-xl font-black text-amber-600 dark:text-amber-400 mt-1">{metrics.preservedBlank}</div>
                </div>
                <div className="bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-900/30 p-3.5 rounded-2xl text-center">
                  <div className="text-[10px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Valid Rows</div>
                  <div className="text-xl font-black text-emerald-600 dark:text-emerald-400 mt-1">{metrics.valid}</div>
                </div>
                <div className="bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200/50 dark:border-rose-900/30 p-3.5 rounded-2xl text-center">
                  <div className="text-[10px] font-black text-rose-600 dark:text-rose-400 uppercase tracking-wider">Issues / Conflicts</div>
                  <div className="text-xl font-black text-rose-600 dark:text-rose-400 mt-1">{metrics.errors}</div>
                </div>
                <div className={`${innerCardClass} border p-3.5 rounded-2xl text-center`}>
                  <div className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Unchanged</div>
                  <div className="text-xl font-black text-slate-500 mt-1">{metrics.unchanged}</div>
                </div>
              </div>

              {/* POST-COMMIT SUMMARY BANNER */}
              {commitCompleted && commitSummary && (
                <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 size={24} className="text-emerald-500 flex-shrink-0" />
                    <div>
                      <div className="text-xs font-black uppercase tracking-wider">Bulk Hierarchy Repair Executed Successfully!</div>
                      <div className="text-xs mt-0.5 font-bold">
                        {commitSummary.success} employee hierarchy assignments updated and verified in Firestore.
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={handleExportReport}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition"
                  >
                    Download Execution Report
                  </button>
                </div>
              )}

              {/* COMMIT PROGRESS BAR */}
              {isCommitting && commitProgress && (
                <div className="p-4 rounded-2xl bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900/40 space-y-2">
                  <div className="flex justify-between items-center text-xs font-extrabold text-indigo-700 dark:text-indigo-300">
                    <span>Committing Updates: {commitProgress.current} / {commitProgress.total} employees</span>
                    <span>{commitProgress.percent}%</span>
                  </div>
                  <div className="w-full bg-slate-200 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div 
                      className="bg-indigo-600 h-full transition-all duration-300"
                      style={{ width: `${commitProgress.percent}%` }}
                    />
                  </div>
                </div>
              )}

              {/* FILTER & SEARCH BAR */}
              <div className="flex flex-col md:flex-row justify-between items-stretch md:items-center gap-3">
                
                {/* Status Filter Buttons */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  <button
                    onClick={() => setFilterStatus('ALL')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider transition ${filterStatus === 'ALL' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                  >
                    All ({metrics.total})
                  </button>
                  <button
                    onClick={() => setFilterStatus('CHANGES')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider transition ${filterStatus === 'CHANGES' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                  >
                    Changes ({metrics.changes})
                  </button>
                  <button
                    onClick={() => setFilterStatus('ERRORS')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider transition ${filterStatus === 'ERRORS' ? 'bg-rose-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30'}`}
                  >
                    Errors ({metrics.errors})
                  </button>
                  <button
                    onClick={() => setFilterStatus('VALID')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider transition ${filterStatus === 'VALID' ? 'bg-emerald-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                  >
                    Valid ({metrics.valid})
                  </button>
                  <button
                    onClick={() => setFilterStatus('UNCHANGED')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider transition ${filterStatus === 'UNCHANGED' ? 'bg-slate-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                  >
                    Unchanged ({metrics.unchanged})
                  </button>
                </div>

                {/* Search Input */}
                <div className="relative min-w-[240px]">
                  <Search size={14} className="absolute left-3 top-3 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search name, email, supervisor, error..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-xs bg-slate-50 dark:bg-slate-950 focus:outline-none"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="absolute right-3 top-3 text-slate-400 hover:text-slate-600">
                      <X size={12} />
                    </button>
                  )}
                </div>

              </div>

              {/* PREVIEW TABLE */}
              <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm bg-white dark:bg-slate-950">
                <div className="overflow-x-auto max-h-[420px]">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-[10px] font-black uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="py-3 px-3">Row</th>
                        <th className="py-3 px-3">Target Employee</th>
                        <th className="py-3 px-3">Current Hierarchy</th>
                        <th className="py-3 px-3">Proposed Hierarchy</th>
                        <th className="py-3 px-3">Validation Status</th>
                        <th className="py-3 px-3">Diagnostics / Error</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-900">
                      {filteredRows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-slate-400 italic">
                            No rows match the selected filter or search query.
                          </td>
                        </tr>
                      ) : (
                        filteredRows.map((row) => {
                          const isError = row.status === 'ERROR';
                          const isChange = row.status === 'VALID_CHANGE';
                          const isUnchanged = row.status === 'UNCHANGED';

                          return (
                            <tr 
                              key={row.rowNum}
                              className={`transition-colors ${
                                isError ? 'bg-rose-50/40 dark:bg-rose-950/15 hover:bg-rose-50/70' : 
                                isChange ? 'bg-indigo-50/30 dark:bg-indigo-950/10 hover:bg-indigo-50/60' : 
                                'hover:bg-slate-50 dark:hover:bg-slate-900/40'
                              }`}
                            >
                              {/* Row # */}
                              <td className="py-2.5 px-3 font-mono text-[10px] text-slate-400 font-bold">
                                #{row.rowNum}
                              </td>

                              {/* Target Employee */}
                              <td className="py-2.5 px-3">
                                <div className="font-extrabold text-slate-800 dark:text-slate-200">
                                  {row.targetName}
                                </div>
                                <div className="text-[10px] text-slate-400 font-medium truncate max-w-[200px]">
                                  {row.targetEmail || 'No Email'} • {row.targetRole} {row.targetEmployeeId ? `(${row.targetEmployeeId})` : ''}
                                </div>
                              </td>

                              {/* Current Hierarchy */}
                              <td className="py-2.5 px-3 text-[11px]">
                                <div className="text-slate-600 dark:text-slate-400">
                                  <span className="font-bold text-slate-400">TL:</span> {row.currentTLName || 'None'}
                                </div>
                                <div className="text-slate-600 dark:text-slate-400">
                                  <span className="font-bold text-slate-400">Mgr:</span> {row.currentMgrName || 'None'}
                                </div>
                              </td>

                              {/* Proposed Hierarchy */}
                              <td className="py-2.5 px-3 text-[11px]">
                                <div className={row.hasTLChange ? 'font-extrabold text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-400'}>
                                  <span className="font-bold text-slate-400">TL:</span> {row.proposedTLName || 'None'}
                                  {row.hasTLChange && <span className="ml-1 text-[9px] px-1 bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 rounded font-black">UPD</span>}
                                </div>
                                <div className={row.hasMgrChange ? 'font-extrabold text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-400'}>
                                  <span className="font-bold text-slate-400">Mgr:</span> {row.proposedMgrName || 'None'}
                                  {row.hasMgrChange && <span className="ml-1 text-[9px] px-1 bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 rounded font-black">UPD</span>}
                                </div>
                              </td>

                              {/* Status Badge */}
                              <td className="py-2.5 px-3">
                                {isError ? (
                                  <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-900">
                                    <AlertTriangle size={10} /> Issue
                                  </span>
                                ) : isChange ? (
                                  <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-900">
                                    <Check size={10} /> Ready
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 border border-slate-200 dark:border-slate-700">
                                    Unchanged
                                  </span>
                                )}
                              </td>

                              {/* Diagnostics Details */}
                              <td className="py-2.5 px-3 max-w-[260px]">
                                <div className={`text-[11px] font-bold ${isError ? 'text-rose-600 dark:text-rose-400' : 'text-slate-600 dark:text-slate-300'}`}>
                                  {row.validationMessage}
                                </div>
                                {row.validationDetails && (
                                  <div className="text-[10px] text-slate-400 truncate mt-0.5" title={row.validationDetails}>
                                    {row.validationDetails}
                                  </div>
                                )}
                              </td>

                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>
          )}

        </div>

        {/* MODAL FOOTER */}
        <div className="px-6 py-4 border-t border-slate-150/10 dark:border-slate-800/80 flex flex-col md:flex-row items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-950/40">
          
          <div className="text-xs text-slate-400">
            {parsedRows.length > 0 ? (
              <span>
                Ready to commit <strong className="text-indigo-600 dark:text-indigo-400">{metrics.changes}</strong> valid updates. 
                {metrics.errors > 0 && <span className="text-rose-500 font-bold ml-1">({metrics.errors} rows will be skipped due to validation issues).</span>}
              </span>
            ) : (
              <span>Upload an edited Excel or CSV sheet to begin validation.</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              disabled={isCommitting}
              className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold transition disabled:opacity-50 cursor-pointer"
            >
              Cancel
            </button>

            {parsedRows.length > 0 && !commitCompleted && (
              <button
                onClick={() => handleCommitBulkRepair(true)}
                disabled={isCommitting || metrics.changes === 0}
                className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isCommitting ? <RefreshCw size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                <span>{isCommitting ? 'Committing Batch...' : `Commit Bulk Repair (${metrics.changes})`}</span>
              </button>
            )}
          </div>

        </div>

      </div>
    </div>
  );
};
