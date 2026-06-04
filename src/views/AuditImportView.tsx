import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { 
  FileSpreadsheet, 
  Upload, 
  CheckCircle2, 
  AlertTriangle, 
  Info, 
  Loader2, 
  ArrowRight, 
  ChevronRight, 
  Database,
  RefreshCw,
  Trash2,
  FileText
} from 'lucide-react';
import { doc, collection, writeBatch, getDocs } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { UserProfile, AuditRecord, SamplingTask, DisputeStatus, UserRole } from '../types';
import { calculateQuality, getAuditStatus } from '../lib/formulas';
import { toast } from 'sonner';

interface AuditImportViewProps {
  user: UserProfile;
  onRefresh?: () => void;
  allUsers?: UserProfile[];
}

interface ColumnMap {
  taskId: string;
  qvName: string;
  vertical: string;
  sellerId: string;
  categoryGroup: string;
  auditUrl: string;
  rows: string;
  compErrorCount: string;
  mpqcErrorCount: string;
  qaComment: string;
  errorType: string;
  guideline: string;
  theme: string;
  status: string;
  auditDate: string;
}

export default function AuditImportView({ user, onRefresh, allUsers: propAllUsers }: AuditImportViewProps) {
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string>('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<any[]>([]);
  
  // Mapping state
  const [columnMap, setColumnMap] = useState<ColumnMap>({
    taskId: '',
    qvName: '',
    vertical: '',
    sellerId: '',
    categoryGroup: '',
    auditUrl: '',
    rows: '',
    compErrorCount: '',
    mpqcErrorCount: '',
    qaComment: '',
    errorType: '',
    guideline: '',
    theme: '',
    status: '',
    auditDate: ''
  });

  const [allUsers, setAllUsers] = useState<UserProfile[]>(propAllUsers || []);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });

  // Load all users for proper ID mappings if not provided in props
  useEffect(() => {
    if (propAllUsers && propAllUsers.length > 0) {
      setAllUsers(propAllUsers);
      return;
    }
    
    const fetchUsers = async () => {
      setLoadingUsers(true);
      try {
        const usersSnap = await getDocs(collection(db, 'users'));
        const usersList = usersSnap.docs.map(d => d.data() as UserProfile);
        setAllUsers(usersList);
      } catch (err) {
        console.error('Failed to load users for mapping:', err);
      } finally {
        setLoadingUsers(false);
      }
    };
    fetchUsers();
  }, [propAllUsers]);

  // Handle file drop & selection
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const processFile = (selectedFile: File) => {
    if (!selectedFile.name.endsWith('.xlsx') && !selectedFile.name.endsWith('.xls') && !selectedFile.name.endsWith('.csv')) {
      toast.error('Unsupported file format. Please upload an Excel (.xlsx/.xls) or CSV file');
      return;
    }

    setFile(selectedFile);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstream = evt.target?.result;
        const wb = XLSX.read(bstream, { type: 'binary' });
        
        setWorkbook(wb);
        setSheets(wb.SheetNames);
        
        // Default to first sheet
        if (wb.SheetNames.length > 0) {
          loadSheetData(wb, wb.SheetNames[0]);
        }
        
        toast.success(`Successfully uploaded "${selectedFile.name}"!`);
      } catch (err: any) {
        toast.error('Failed to parse spreadsheet: ' + err.message);
        console.error('Spreadsheet parse error:', err);
      }
    };
    reader.readAsBinaryString(selectedFile);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const loadSheetData = (wb: XLSX.WorkBook, sheetName: string) => {
    setSelectedSheet(sheetName);
    const worksheet = wb.Sheets[sheetName];
    if (!worksheet) return;

    // Read full rows
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' }) as any[];
    setRawRows(rows);

    // Read header row
    const jsonHeader = XLSX.utils.sheet_to_json(worksheet, { header: 1 })[0] as string[];
    const cleanHeaders = (jsonHeader || []).map(h => String(h || '').trim()).filter(Boolean);
    setHeaders(cleanHeaders);

    // Dynamic smart mapping
    autoMapColumns(cleanHeaders);
  };

  // Helper to map headers to known AuditRecord keys automatically
  const autoMapColumns = (cols: string[]) => {
    const lowercaseCols = cols.map(c => c.toLowerCase());
    
    const findMatch = (options: string[]): string => {
      for (const opt of options) {
        const index = lowercaseCols.indexOf(opt.toLowerCase());
        if (index !== -1) {
          return cols[index];
        }
      }
      // Partial matches
      for (const opt of options) {
        const index = lowercaseCols.findIndex(c => c.includes(opt.toLowerCase()) || opt.toLowerCase().includes(c));
        if (index !== -1) {
          return cols[index];
        }
      }
      return '';
    };

    setColumnMap({
      taskId: findMatch(['task id', 'task_id', 'task', 'id', 'ticket']),
      qvName: findMatch(['qv name', 'qv_name', 'agent', 'agent name', 'user', 'username', 'email', 'qv']),
      vertical: findMatch(['vertical', 'lobby', 'queue', 'dept']),
      sellerId: findMatch(['seller id', 'seller_id', 'seller', 'merchant']),
      categoryGroup: findMatch(['category', 'category group', 'category_group', 'group']),
      auditUrl: findMatch(['audit url', 'audit_url', 'url', 'link', 'task url']),
      rows: findMatch(['rows', 'total rows', 'count', 'size', 'max rows', 'volume']),
      compErrorCount: findMatch(['comp errors', 'compliance errors', 'comp error count', 'comp_error', 'compliance']),
      mpqcErrorCount: findMatch(['mpqc errors', 'mpqc error count', 'mpqc_error', 'mpqc']),
      qaComment: findMatch(['qa comment', 'comment', 'remarks', 'feedback', 'notes', 'qa comments']),
      errorType: findMatch(['error type', 'error_type', 'root cause']),
      guideline: findMatch(['guideline', 'policy', 'clause']),
      theme: findMatch(['theme', 'topic', 'process theme']),
      status: findMatch(['status', 'audit status', 'result', 'outcome']),
      auditDate: findMatch(['date', 'audit date', 'audit_date', 'completion date', 'timestamp'])
    });
  };

  const handleSheetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (workbook) {
      loadSheetData(workbook, e.target.value);
    }
  };

  const updateMapping = (field: keyof ColumnMap, value: string) => {
    setColumnMap(prev => ({ ...prev, [field]: value }));
  };

  const handleReset = () => {
    setFile(null);
    setWorkbook(null);
    setSheets([]);
    setSelectedSheet('');
    setHeaders([]);
    setRawRows([]);
    setImportProgress({ current: 0, total: 0 });
  };

  const handleImportSubmit = async () => {
    // Basic mandatory fields validation
    if (!columnMap.taskId) {
      toast.error('Task ID column mapping is required.');
      return;
    }
    if (!columnMap.qvName) {
      toast.error('QV Name / Agent column mapping is required.');
      return;
    }
    if (!columnMap.rows) {
      toast.error('Total Rows column mapping is required.');
      return;
    }

    setImporting(true);
    setImportProgress({ current: 0, total: rawRows.length });

    try {
      const timestamp = new Date().toISOString();
      const currentUserId = user.uid;
      
      // Group rows into chunks of 200 (each row creates an audit document and a task document, i.e., 400 operations per batch)
      const chunkSize = 200;
      const chunks: any[][] = [];
      for (let i = 0; i < rawRows.length; i += chunkSize) {
        chunks.push(rawRows.slice(i, i + chunkSize));
      }

      const totalRows = rawRows.length;

      // O(1) matching pre-computed lookups for lightning-fast performance (reclaims frozen event loop!)
      const userByName = new Map<string, typeof allUsers[0]>();
      const userByEmail = new Map<string, typeof allUsers[0]>();
      const userByEmailPrefix = new Map<string, typeof allUsers[0]>();

      allUsers.forEach(u => {
        const nameKey = (u.name || '').toLowerCase().trim();
        const emailKey = (u.email || '').toLowerCase().trim();
        if (nameKey) userByName.set(nameKey, u);
        if (emailKey) {
          userByEmail.set(emailKey, u);
          const prefix = emailKey.split('@')[0];
          if (prefix) {
            userByEmailPrefix.set(prefix, u);
          }
        }
      });

      const ts = Date.now();
      const randToken = Math.random().toString(36).substr(2, 6);

      // Prepare and execute all batches in parallel to maximize database performance
      const batchPromises = chunks.map(async (chunk, chunkIdx) => {
        const batch = writeBatch(db);
        let filledCount = 0;

        for (let idx = 0; idx < chunk.length; idx++) {
          const row = chunk[idx];
          const globalIdx = chunkIdx * chunkSize + idx;

          // Read mapped values
          const rawTaskId = String(row[columnMap.taskId] || '').trim();
          const rawQvName = String(row[columnMap.qvName] || '').trim();
          
          // Skip entry if required info is completely empty
          if (!rawTaskId || !rawQvName) {
            continue;
          }

          const sizeVal = parseInt(row[columnMap.rows]) || 1;
          const compErrors = parseInt(row[columnMap.compErrorCount]) || 0;
          const mpqcErrors = parseInt(row[columnMap.mpqcErrorCount]) || 0;
          const comment = String(row[columnMap.qaComment] || '').trim();
          const verticalVal = String(row[columnMap.vertical] || 'General').trim();
          const sellerVal = String(row[columnMap.sellerId] || '-').trim();
          const categoryVal = String(row[columnMap.categoryGroup] || '-').trim();
          const urlVal = String(row[columnMap.auditUrl] || '').trim();
          
          const qVal = calculateQuality(compErrors, mpqcErrors, sizeVal);
          const derivedStatus = (compErrors > 0 || mpqcErrors > 0) ? 'Incorrect' : 'Correct';
          const mappedStatus = columnMap.status ? String(row[columnMap.status] || derivedStatus) as any : derivedStatus;

          const errTypeVal = String(row[columnMap.errorType] || (compErrors > 0 || mpqcErrors > 0 ? 'General error' : 'None')).trim();
          const guidelineVal = String(row[columnMap.guideline] || (compErrors > 0 || mpqcErrors > 0 ? 'General guideline' : 'N/A')).trim();
          const themeVal = String(row[columnMap.theme] || (compErrors > 0 || mpqcErrors > 0 ? 'General theme' : 'N/A')).trim();
          const dateVal = String(row[columnMap.auditDate] || timestamp);

          // Fast O(1) Match Agent mapped IDs
          const cleanQvName = rawQvName.toLowerCase().trim();
          let matchedUser = userByName.get(cleanQvName) || userByEmail.get(cleanQvName) || userByEmailPrefix.get(cleanQvName);

          if (!matchedUser) {
            matchedUser = allUsers.find(u => {
              const email = (u.email || '').toLowerCase().trim();
              return email && email.startsWith(cleanQvName);
            });
          }

          const agentId = matchedUser?.uid || rawQvName;
          const teamLeadId = matchedUser?.teamLeadId || '';

          // Generate fully structural completed task & audit document IDs
          const auditId = `audit-imp-${ts}-${randToken}-${globalIdx}`;
          const taskId = `task-imp-${ts}-${randToken}-${globalIdx}`;

          const auditRecord: AuditRecord = {
            id: auditId,
            taskId: rawTaskId,
            qvName: rawQvName,
            vertical: verticalVal,
            sellerId: sellerVal,
            categoryGroup: categoryVal,
            auditUrl: urlVal,
            rows: sizeVal,
            rowsPassed: Math.max(0, sizeVal - (compErrors + mpqcErrors)),
            rowsFailed: compErrors + mpqcErrors,
            compErrorCount: compErrors,
            mpqcErrorCount: mpqcErrors,
            quality: qVal,
            status: mappedStatus === 'Tech Issue' ? 'Tech Issue' : (compErrors > 0 || mpqcErrors > 0 ? 'Incorrect' : 'Correct'),
            qaComment: comment || 'Bulk Imported Audit Report',
            errorType: errTypeVal,
            guideline: guidelineVal,
            theme: themeVal,
            qaId: currentUserId,
            auditDate: dateVal,
            auditStartTime: dateVal,
            disputeStatus: DisputeStatus.NONE,
            disputeHistory: [],
            agentId: agentId,
            teamLeadId: teamLeadId
          };

          const taskRecord: SamplingTask = {
            id: taskId,
            taskId: rawTaskId,
            qvName: rawQvName,
            vertical: verticalVal,
            sellerId: sellerVal,
            categoryGroup: categoryVal,
            auditUrl: urlVal,
            rows: sizeVal,
            rowsPassed: Math.max(0, sizeVal - (compErrors + mpqcErrors)),
            rowsFailed: compErrors + mpqcErrors,
            attributesEdited: 0,
            imageReshuffle: false,
            status: 'Completed',
            sourceFileId: file?.name || 'Bulk_Import',
            createdAt: dateVal,
            assignedQaId: currentUserId
          };

          // Write both Completed Task and Completed Report
          const auditRef = doc(collection(db, 'audits'), auditRecord.id);
          const taskRef = doc(collection(db, 'tasks'), taskRecord.id);

          batch.set(auditRef, auditRecord);
          batch.set(taskRef, taskRecord);
          filledCount++;
        }

        if (filledCount > 0) {
          await batch.commit();
        }

        setImportProgress(prev => ({
          ...prev,
          current: Math.min(totalRows, prev.current + chunk.length)
        }));
      });

      await Promise.all(batchPromises);

      setImportProgress({ current: rawRows.length, total: rawRows.length });
      toast.success(`Successfully imported ${rawRows.length} completed audits to Firestore database!`);
      
      if (onRefresh) {
        onRefresh();
      }
      handleReset();
    } catch (err: any) {
      console.error('Core batch upload failed:', err);
      toast.error('Import Failed: ' + err.message);
      handleFirestoreError(err, OperationType.WRITE, 'audits/tasks-batch');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Upper header summary */}
      <div className="flex flex-col md:flex-row md:items-center justify-between bg-white p-6 rounded-2xl shadow-sm border border-slate-100 gap-4">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-slate-900 flex items-center gap-2.5">
            <Database className="text-blue-600" size={24} />
            Bulk Audit Import Tools
          </h2>
          <p className="text-slate-500 text-sm mt-1">
            Bypass standard workflow lines by importing audits directly into our Firestore cluster. Ideal for high-density migrations and historical loads.
          </p>
        </div>
        
        {loadingUsers ? (
          <div className="flex items-center gap-2 bg-blue-50/50 border border-blue-100 py-2 px-4 rounded-xl">
            <Loader2 size={16} className="text-blue-600 animate-spin" />
            <span className="text-xs text-blue-700 font-bold">Mapping active user index...</span>
          </div>
        ) : (
          <div className="bg-slate-50 border border-slate-100 py-2 px-4 rounded-xl flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
            <span className="text-xs text-slate-600 font-semibold">{allUsers.length} Agent profiles synced</span>
          </div>
        )}
      </div>

      {!file ? (
        /* Dropzone view */
        <div
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-3xl p-12 flex flex-col items-center justify-center transition-all bg-white min-h-[350px] ${
            dragActive ? 'border-blue-500 bg-blue-50/30 shadow-none' : 'border-slate-200 hover:border-slate-300 shadow-sm'
          }`}
        >
          <div className="bg-blue-50 p-4 rounded-2xl text-blue-500 mb-4 shadow-sm">
            <Upload size={32} />
          </div>
          <h3 className="text-lg font-black text-slate-800">Upload your audited excel sheet</h3>
          <p className="text-slate-400 text-xs mt-1 mb-6 text-center max-w-sm">
            Support standard Microsoft Excel (.xlsx/.xls) or standard Comma Separated Values (.csv) file types. Must contain a minimum of Task ID and Agent Name.
          </p>
          
          <label className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm px-6 py-3 rounded-xl shadow-lg shadow-blue-600/10 hover:shadow-blue-600/20 active:scale-[0.98] transition-all cursor-pointer">
            Choose Spreadsheet
            <input
              type="file"
              className="hidden"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileChange}
            />
          </label>
        </div>
      ) : (
        /* Mapping configuration view */
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          
          {/* Main Mapper controls */}
          <div className="lg:col-span-2 bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden flex flex-col">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-3">
                <div className="bg-blue-100 p-2 rounded-xl text-blue-600">
                  <FileSpreadsheet size={20} />
                </div>
                <div>
                  <h3 className="font-extrabold text-slate-800 text-sm tracking-tight">{file.name}</h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">
                    {(file.size / 1024).toFixed(1)} KB • {rawRows.length} Rows Identified
                  </p>
                </div>
              </div>

              {sheets.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-500">Sheet:</span>
                  <select
                    className="border border-slate-200 rounded-lg text-xs font-bold px-2 py-1.5 bg-white text-slate-700 focus:outline-none"
                    value={selectedSheet}
                    onChange={handleSheetChange}
                  >
                    {sheets.map(sheet => (
                      <option key={sheet} value={sheet}>{sheet}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Mappings Panel */}
            <div className="p-6 space-y-6">
              <div className="bg-blue-50/50 border border-blue-200/50 rounded-xl p-4 flex gap-3 text-blue-800 text-xs font-medium">
                <Info size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="font-extrabold text-blue-950 block mb-0.5">Automated Pre-Mapping</span>
                  Our system mapped standard audit definitions based on spreadsheet header matches. Please verify the fields below or customize as required.
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Task ID mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-700 flex items-center gap-1.5">
                    Task ID <span className="text-red-500 font-bold">*</span>
                  </label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-bold text-slate-800 focus:ring-2 focus:ring-blue-100 focus:border-blue-500 focus:outline-none bg-white"
                    value={columnMap.taskId}
                    onChange={(e) => updateMapping('taskId', e.target.value)}
                  >
                    <option value="">-- Choose Column --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                {/* QV Name mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-700 flex items-center gap-1.5">
                    Agent Name / QV Name <span className="text-red-500 font-bold">*</span>
                  </label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-bold text-slate-800 focus:ring-2 focus:ring-blue-100 focus:border-blue-500 focus:outline-none bg-white"
                    value={columnMap.qvName}
                    onChange={(e) => updateMapping('qvName', e.target.value)}
                  >
                    <option value="">-- Choose Column --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                {/* Total cases mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-700 flex items-center gap-1.5">
                    Total Rows Audited <span className="text-red-500 font-bold">*</span>
                  </label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-bold text-slate-800 focus:ring-2 focus:ring-blue-100 focus:border-blue-500 focus:outline-none bg-white"
                    value={columnMap.rows}
                    onChange={(e) => updateMapping('rows', e.target.value)}
                  >
                    <option value="">-- Choose Column --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                {/* Vertical mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-600">Vertical / Queue</label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-medium text-slate-800 bg-white focus:outline-none"
                    value={columnMap.vertical}
                    onChange={(e) => updateMapping('vertical', e.target.value)}
                  >
                    <option value="">-- Fixed "General" Option --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                {/* Compliance mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-600">Compliance Errors</label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-medium text-slate-800 bg-white focus:outline-none"
                    value={columnMap.compErrorCount}
                    onChange={(e) => updateMapping('compErrorCount', e.target.value)}
                  >
                    <option value="">-- Default "0" Options --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                {/* MPQC mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-600">MPQC Errors</label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-medium text-slate-800 bg-white focus:outline-none"
                    value={columnMap.mpqcErrorCount}
                    onChange={(e) => updateMapping('mpqcErrorCount', e.target.value)}
                  >
                    <option value="">-- Default "0" Options --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                {/* Guideline mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-600">Guideline Mapped</label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-medium text-slate-800 bg-white focus:outline-none"
                    value={columnMap.guideline}
                    onChange={(e) => updateMapping('guideline', e.target.value)}
                  >
                    <option value="">-- Auto Derived --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                {/* QA comments mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-600">QA Comment</label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-medium text-slate-800 bg-white focus:outline-none"
                    value={columnMap.qaComment}
                    onChange={(e) => updateMapping('qaComment', e.target.value)}
                  >
                    <option value="">-- Fixed Remarks Option --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                {/* Audit date mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-600">Audit Completion Date</label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-medium text-slate-800 bg-white focus:outline-none"
                    value={columnMap.auditDate}
                    onChange={(e) => updateMapping('auditDate', e.target.value)}
                  >
                    <option value="">-- Autofill Today --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                {/* Category mapping */}
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-600">Category Group</label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-2.5 text-xs font-medium text-slate-800 bg-white focus:outline-none"
                    value={columnMap.categoryGroup}
                    onChange={(e) => updateMapping('categoryGroup', e.target.value)}
                  >
                    <option value="">-- Default "-" --</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Preview table from uploaded file */}
            {rawRows.length > 0 && (
              <div className="border-t border-slate-100 p-6">
                <h4 className="text-xs font-black uppercase text-slate-400 tracking-wider mb-4 flex items-center gap-1.5">
                  <FileText size={14} className="text-slate-400" />
                  MAPPING DATA SANITY PREVIEW (First 3 Records)
                </h4>

                <div className="border border-slate-100 rounded-2xl overflow-hidden bg-slate-50/20 shadow-inner">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-100/50 font-extrabold text-slate-600 border-b border-slate-200/50">
                        <th className="py-2.5 px-3">Task ID</th>
                        <th className="py-2.5 px-3">Agent</th>
                        <th className="py-2.5 px-3">Size</th>
                        <th className="py-2.5 px-3">Comp</th>
                        <th className="py-2.5 px-3">MPQC</th>
                        <th className="py-2.5 px-3">Quality</th>
                        <th className="py-2.5 px-3">Outcome</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium text-slate-600">
                      {rawRows.slice(0, 3).map((row, index) => {
                        const rawId = String(row[columnMap.taskId] || '-');
                        const rawAgent = String(row[columnMap.qvName] || '-');
                        const rawSize = parseInt(row[columnMap.rows]) || 1;
                        const comp = parseInt(row[columnMap.compErrorCount]) || 0;
                        const mpqc = parseInt(row[columnMap.mpqcErrorCount]) || 0;
                        const derivedQuality = calculateQuality(comp, mpqc, rawSize);
                        const isIncorrect = comp > 0 || mpqc > 0;

                        return (
                          <tr key={index} className="hover:bg-slate-50/50">
                            <td className="py-2 px-3 font-semibold text-slate-800">{rawId}</td>
                            <td className="py-2 px-3">{rawAgent}</td>
                            <td className="py-2 px-3">{rawSize}</td>
                            <td className="py-2 px-3 text-amber-600 font-bold">{comp}</td>
                            <td className="py-2 px-3 text-red-600 font-bold">{mpqc}</td>
                            <td className="py-2 px-3 font-extrabold text-slate-800">{derivedQuality}%</td>
                            <td className="py-2 px-3">
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                                isIncorrect ? 'bg-red-50 text-red-700 border border-red-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                              }`}>
                                {isIncorrect ? 'Incorrect' : 'Correct'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar actions */}
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6 space-y-6">
            <h3 className="text-sm font-black text-slate-800 tracking-tight">Audit Database Actions</h3>
            
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-3">
              <div className="flex justify-between text-xs font-semibold text-slate-500">
                <span>Row count inside Sheet:</span>
                <span className="font-extrabold text-slate-800">{rawRows.length} rows</span>
              </div>
              <div className="flex justify-between text-xs font-semibold text-slate-500">
                <span>Operations planned:</span>
                <span className="font-extrabold text-slate-800">{rawRows.length * 2} writes</span>
              </div>
              <div className="h-px bg-slate-200" />
              <div className="text-[10px] text-slate-400 font-bold bg-amber-50 text-amber-700 p-2.5 rounded-xl border border-amber-100 leading-normal flex gap-1.5">
                <AlertTriangle size={18} className="flex-shrink-0 text-amber-500" />
                This action writes records directly to 'audits' and 'tasks' collections, instantly feeding agent KPI dashboards. Double check values before updating.
              </div>
            </div>

            {importing ? (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-bold text-slate-600">
                  <span>Importing values...</span>
                  <span>{Math.round((importProgress.current / (importProgress.total || 1)) * 100)}%</span>
                </div>
                <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${(importProgress.current / (importProgress.total || 1)) * 100}%` }}
                  />
                </div>
                <p className="text-[10px] text-slate-400 font-bold text-center">
                  Syncing {importProgress.current} our of {importProgress.total} records...
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleImportSubmit}
                  disabled={!columnMap.taskId || !columnMap.qvName || !columnMap.rows}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-100 disabled:text-slate-400 text-white font-bold text-sm py-3.5 px-4 rounded-xl shadow-md focus:outline-none focus:ring-2 focus:ring-blue-100 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                >
                  <Database size={16} />
                  Import Audits to Firestore
                </button>

                <button
                  type="button"
                  onClick={handleReset}
                  className="w-full bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 font-bold text-xs py-2 px-4 rounded-xl transition-all flex items-center justify-center gap-1.5"
                >
                  <Trash2 size={14} className="text-slate-400" />
                  Discard File
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
