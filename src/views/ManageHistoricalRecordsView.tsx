import React, { useState, useEffect, useMemo } from 'react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { collection, getDocs, doc, updateDoc, writeBatch } from 'firebase/firestore';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { toast } from 'sonner';
import { 
  Trash2, 
  AlertTriangle, 
  CheckSquare, 
  Square, 
  Download, 
  Edit, 
  Save, 
  X, 
  FileSpreadsheet, 
  Check, 
  CheckCircle, 
  RefreshCw, 
  Play, 
  Upload, 
  Award, 
  Database 
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import { performCascadeDeleteKpiUploads } from '../lib/dataCleanupService';
import * as XLSX from 'xlsx';
import { usePermission } from '../components/PermissionContext';
import { 
  normalizeUploadDate, 
  runDynamicKPIEngine, 
  KpiUploadRow, 
  SUPPORTED_ROLES 
} from '../lib/kpiEngine';

interface ManageHistoricalRecordsViewProps {
  user: any;
  allUsers?: any[];
  onRefreshAllData?: (silent?: boolean) => Promise<any>;
}

const ManageHistoricalRecordsView = ({ user, allUsers = [], onRefreshAllData }: ManageHistoricalRecordsViewProps) => {
  const { canEdit, canDelete } = usePermission();

  // Primary active tab inside the module
  const [activeSubTab, setActiveSubTab] = useState<'database' | 'uploader'>('database');

  // Database Tab States
  const [data, setData] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 25;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<any>({});

  // Uploader Tab States
  const [stagingData, setStagingData] = useState<KpiUploadRow[]>([]);
  const [stagingFileName, setStagingFileName] = useState<string>('');
  const [editingStagingId, setEditingStagingId] = useState<string | null>(null);
  const [editRowFields, setEditRowFields] = useState<Partial<KpiUploadRow>>({});

  // Period Scorecard Manual Calculation States
  const [selectedPeriod, setSelectedPeriod] = useState<string>('');
  const [processingRecalc, setProcessingRecalc] = useState(false);

  // Role permissions checks
  const isAuthorized = canEdit('Historical Records');
  const canDeleteRecords = canDelete('Historical Records');
  
  useEffect(() => {
    fetchData();
  }, []);
  
  const fetchData = async () => {
    setLoading(true);
    try {
      const snapshot = await getDocs(collection(db, 'kpi_uploads'));
      setData(snapshot.docs.map(doc => ({ ...doc.data(), docId: doc.id })));
    } catch (err) {
      toast.error('Failed to load database records');
    } finally {
      setLoading(false);
    }
  };

  const handleExport = () => {
    if (filteredData.length === 0) return toast.warning("No data to export");
    const ws = XLSX.utils.json_to_sheet(filteredData.map(d => ({
      ...d,
      docId: undefined
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Records");
    XLSX.writeFile(wb, "Historical_Records_Export.xlsx");
  };

  const startEdit = (row: any) => {
    setEditingId(row.docId);
    setEditForm({ ...row });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setLoading(true);
    try {
      const ref = doc(db, 'kpi_uploads', editingId);
      const updatePayload = { ...editForm };
      delete updatePayload.docId;
      await updateDoc(ref, updatePayload);
      toast.success("Record updated successfully!");
      setEditingId(null);
      fetchData();
      if (onRefreshAllData) onRefreshAllData();
    } catch (err) {
      toast.error("Failed to update record");
    } finally {
      setLoading(false);
    }
  };

  const filteredData = useMemo(() => {
    const filtered = data.filter(d => 
        (d.employeeEmail || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (d.kpiName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (d.processName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (d.role || '').toLowerCase().includes(searchTerm.toLowerCase())
    );
    return filtered;
  }, [data, searchTerm]);

  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return filteredData.slice(startIndex, startIndex + pageSize);
  }, [filteredData, currentPage]);

  const totalPages = Math.ceil(filteredData.length / pageSize);
  
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) newSelected.delete(id);
    else newSelected.add(id);
    setSelectedIds(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === data.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(data.map(d => d.docId)));
  };

  const handleBulkDelete = async () => {
    if (!isAuthorized) {
        toast.error('You do not have permission to delete records. Only Admins can perform this action.');
        return;
    }
    setLoading(true);
    try {
        const recordsToDelete = data.filter(d => selectedIds.has(d.docId));
        await performCascadeDeleteKpiUploads(recordsToDelete, 'Requested by user', user.email);
        
        toast.success(`Deleted ${selectedIds.size} records and logged audit.`);
        setSelectedIds(new Set());
        fetchData();
        if (onRefreshAllData) onRefreshAllData();
    } catch (err: any) {
      console.error('Deletion error in UI:', err);
      if (err.code === 'permission-denied') {
        toast.error(`Deletion failed: You do not have permission to delete these records.`);
      } else {
        toast.error(`Deletion failed: ${err.message || 'Unknown error'}`);
      }
    } finally {
      setLoading(false);
      setShowConfirm(false);
    }
  };

  // Extract all unique available reporting periods dynamically
  const availablePeriods = useMemo(() => {
    const list = new Set<string>();
    data.forEach(row => {
      if (row.reportingPeriod) {
        let p = row.reportingPeriod.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
          p = p.substring(0, 7);
        }
        if (/^\d{4}-\d{2}$/.test(p)) {
          list.add(p);
        }
      }
    });
    // Fallback current period if database is empty
    if (list.size === 0) {
      const now = new Date();
      const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      list.add(current);
    }
    return Array.from(list).sort();
  }, [data]);

  // Default selectedPeriod to the latest period
  useEffect(() => {
    if (availablePeriods.length > 0 && !selectedPeriod) {
      setSelectedPeriod(availablePeriods[availablePeriods.length - 1]);
    }
  }, [availablePeriods, selectedPeriod]);

  // Download Universal Template Helper
  const downloadTemplate = () => {
    const headers = [
      'Reporting Period',
      'Employee Email',
      'Role',
      'Process Name',
      'KPI Name',
      'Target',
      'Actual',
      'Bonus',
      'Penalty',
      'Comments'
    ];
    const sampleData = [
      ['2026-06-01', 'agent1@company.com', 'QV', 'Safe Search', 'Productivity', 100, 105, 0, 0, 'Smashed targets'],
      ['2026-06-01', 'agent1@company.com', 'QV', 'Safe Search', 'Quality', 98, 99, 0, 0, 'Zero QA flags'],
      ['2026-06-01', 'agent1@company.com', 'QV', 'Safe Search', 'Attendance', 95, 96.5, 0, 0, 'Consistent presence'],
      ['2026-06-01', 'agent1@company.com', 'QV', 'Safe Search', 'APT', 240, 210, 5, 0, 'Very fast handle times (Bonus applied)'],
      
      ['2026-06-01', 'qa1@company.com', 'QA', 'Quality', 'Audits Completed', 100, 115, 0, 0, 'Excellent volume'],
      ['2026-06-01', 'qa1@company.com', 'QA', 'Quality', 'QA Accuracy', 98, 97.5, 0, 1, 'Single minor alignment variance'],
      ['2026-06-01', 'qa1@company.com', 'QA', 'Quality', 'SLA Adherence', 100, 100, 0, 0, 'Standard on-time delivery'],
      ['2026-06-01', 'qa1@company.com', 'QA', 'Quality', 'Feedback Sessions', 20, 22, 2, 0, 'Coaching sessions with agents (Bonus applied)'],
      
      ['2026-06-01', 'tl1@company.com', 'QTL', 'Safe Search', 'Audits Coached', 30, 32, 0, 0, 'Good feedback tracking'],
      ['2026-06-01', 'tl1@company.com', 'QTL', 'Safe Search', 'Calibration Variance', 5, 3.2, 0, 0, 'Perfect team calibration'],
      ['2026-06-01', 'tl1@company.com', 'QTL', 'Safe Search', 'Team Performance', 92, 94.5, 2, 0, 'Team achieved average 94.5%'],
      ['2026-06-01', 'tl1@company.com', 'QTL', 'Safe Search', 'Attendance', 95, 95, 0, 0, 'Present']
    ];

    const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleData]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Precision360 Template');
    XLSX.writeFile(wb, 'Precision360_Universal_KPI_Template.xlsx');
    toast.success('Universal upload Excel template downloaded successfully.');
  };

  // File Upload Handler
  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();

      reader.onload = (evt) => {
        try {
          const bstr = evt.target?.result;
          const wb = XLSX.read(bstr, { type: 'binary' });
          const wsName = wb.SheetNames[0];
          const ws = wb.Sheets[wsName];
          const rawRows = XLSX.utils.sheet_to_json(ws) as any[];

          if (rawRows.length === 0) {
            toast.error("Spreadsheet appears empty. No rows parsed.");
            return;
          }

          // Dynamic Column Normalization Maps
          const parseList: KpiUploadRow[] = rawRows.map((r, index) => {
            const keys = Object.keys(r);
            const findCell = (keywords: string[], excludeKeywords: string[] = []) => {
              for (const kw of keywords) {
                const matchedKey = keys.find(k => {
                  const normalizedKey = k.toLowerCase().replace(/[\s\-_]/g, '');
                  const normalizedKw = kw.toLowerCase().replace(/[\s\-_]/g, '');
                  
                  const isExcluded = excludeKeywords.some(ex => 
                    normalizedKey.includes(ex.toLowerCase().replace(/[\s\-_]/g, ''))
                  );
                  if (isExcluded) return false;
                  
                  return normalizedKey.includes(normalizedKw);
                });
                if (matchedKey !== undefined) {
                  return r[matchedKey];
                }
              }
              return undefined;
            };

            const rawPeriod = findCell(['period', 'reporting']) || r['Reporting Period'] || r['Period'] || '2026-06-01';
            const rawDate = findCell(['workdate', 'date']) || r['Work Date'] || r['Date'];
            
            // Normalize dates
            let reportingPeriod = '2026-06';
            let workDate = '2026-06-01';
            try {
              const normalized = normalizeUploadDate(rawPeriod);
              reportingPeriod = normalized.reportingPeriod;
              workDate = rawDate ? normalizeUploadDate(rawDate).workDate : `${reportingPeriod}-01`;
            } catch (pErr) {
              console.warn("Date normalization failed for row. Using safe default.", pErr);
            }

            const email = String(findCell(['email', 'employee', 'user']) || r['Employee Email'] || r['Email'] || '').toLowerCase().trim();
            const role = String(findCell(['role']) || r['Role'] || 'QV').trim().toUpperCase();
            const processName = String(findCell(['process', 'processname']) || r['Process Name'] || '').trim();
            const kpi = String(findCell(['kpiname', 'kpi', 'metric', 'parameter']) || r['KPI Name'] || r['KPI'] || '').trim();
            const target = Number(findCell(['target']) || r['Target'] || 0);
            const actual = Number(findCell(['actual']) || r['Actual'] || 0);
            const bonus = Number(findCell(['bonus']) || r['Bonus'] || 0);
            const penalty = Number(findCell(['penalty']) || r['Penalty'] || 0);
            const comments = String(findCell(['comment', 'remarks', 'feedback', 'comments']) || r['Comments'] || r['Comment'] || '').trim();

            return {
              id: `stg-${Date.now()}-${index}`,
              reportingPeriod,
              workDate,
              employeeEmail: email,
              role,
              processName,
              kpiName: kpi,
              target,
              actual,
              bonus,
              penalty,
              comments,
              hasMajorEscalation: false
            };
          }).filter(r => r.employeeEmail !== '' && r.kpiName !== '');

          if (parseList.length === 0) {
            toast.warning("No rows parsed correctly. Ensure your spreadsheet contains Email and KPI Name columns.");
            return;
          }
          
          // Validation: Process Name is mandatory
          const missingProcess = parseList.find(r => !r.processName);
          if (missingProcess) {
            toast.error(`Upload rejected: Process Name is mandatory. Missing in row for ${missingProcess.employeeEmail}.`);
            return;
          }

          setStagingData(parseList);
          setStagingFileName(file.name);
          toast.success(`Successfully parsed ${parseList.length} items to the staging desk!`);
        } catch (err) {
          toast.error("Spreadsheet format parser failed. Check alignment headers.");
          console.error(err);
        }
      };

      reader.readAsBinaryString(file);
    }
  };

  // Inline Staging Row Editors
  const handleStartStagingEdit = (row: KpiUploadRow) => {
    setEditingStagingId(row.id);
    setEditRowFields({ ...row });
  };

  const handleSaveStagingRow = () => {
    if (!editingStagingId) return;

    setStagingData(prev => 
      prev.map(row => {
        if (row.id === editingStagingId) {
          return {
            ...row,
            ...editRowFields,
            employeeEmail: (editRowFields.employeeEmail || row.employeeEmail).toLowerCase().trim(),
            role: (editRowFields.role || row.role).toUpperCase().trim()
          } as KpiUploadRow;
        }
        return row;
      })
    );

    setEditingStagingId(null);
    setEditRowFields({});
    toast.success("Row committed in memory!");
  };

  const handleRemoveStagingRow = (id: string) => {
    setStagingData(prev => prev.filter(row => row.id !== id));
    toast.info("Staged record deleted.");
  };

  const clearStagingShelf = () => {
    setStagingData([]);
    setStagingFileName('');
    toast.info("Excel staging grid cleared.");
  };

  // Commit raw staging list to firestore kpi_uploads collection
  const handleCommitUploadGrid = async () => {
    if (stagingData.length === 0) {
      toast.error("Staging desk is empty. No uploads found.");
      return;
    }

    setLoading(true);
    try {
      const chunkArray = <T,>(arr: T[], size: number): T[][] =>
        Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
          arr.slice(i * size, i * size + size)
        );

      const dataChunks = chunkArray<KpiUploadRow>(stagingData, 400);
      
      for (const chunk of dataChunks) {
        const batch = writeBatch(db);
        chunk.forEach((row: KpiUploadRow) => {
          const uniqueDocId = doc(collection(db, 'kpi_uploads')).id;
          const ref = doc(db, 'kpi_uploads', uniqueDocId);
          batch.set(ref, {
            ...row,
            id: uniqueDocId,
            uploadedAt: new Date().toISOString(),
            uploadedBy: user.email
          });
        });
        await batch.commit();
      }
      toast.success(`Committed ${stagingData.length} records successfully to 'kpi_uploads' collection! Use the "Compile & Publish Scorecards" action to generate scores.`);

      setStagingData([]);
      setStagingFileName('');
      fetchData();
      
      if (onRefreshAllData) await onRefreshAllData();
    } catch (err) {
      console.error('Failed to commit uploads: ', err);
      toast.error('Failed to synchronize commits with Firestore database.');
      handleFirestoreError(err, OperationType.WRITE, 'kpi_uploads');
    } finally {
      setLoading(false);
    }
  };

  // Run dynamic calculation for selectedPeriod
  const handleRecalculatePeriodScorecards = async () => {
    if (!selectedPeriod) {
      toast.error("No period selected for calculation.");
      return;
    }

    setProcessingRecalc(true);
    try {
      const rez = await runDynamicKPIEngine(selectedPeriod, allUsers);
      
      if (rez.scorecardsCount > 0) {
        toast.success(`Success! Re-compiled and published ${rez.scorecardsCount} scorecard records for period ${selectedPeriod}.`);
      } else {
        toast.warning(`No raw entries mapped under 'kpi_uploads' for period ${selectedPeriod}. Upload files first!`);
      }
      
      if (onRefreshAllData) {
        await onRefreshAllData();
      }
      fetchData();
    } catch (err) {
      console.error(err);
      toast.error('No KPI records found for calculation.');
    } finally {
      setProcessingRecalc(false);
    }
  };

  return (
    <div className="p-8 space-y-6">
      {/* Title Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 id="historical-records-title" className="text-2xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <Database className="text-indigo-600 dark:text-indigo-400" size={26} /> Historical Compliance Module
          </h1>
          <p className="text-xs text-slate-400 dark:text-slate-500 font-semibold leading-relaxed">
            Manage global performance baselines, upload dynamic spreadsheets, review staging files, and publish periods.
          </p>
        </div>

        {/* Manual calculation widget */}
        <div className="flex items-center gap-2.5 bg-white dark:bg-slate-900 border border-slate-150 dark:border-slate-800 p-2.5 rounded-xl shadow-sm">
          <select 
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="h-8 text-[11px] font-extrabold rounded-lg border border-slate-150 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer text-slate-700 dark:text-slate-200"
          >
            {availablePeriods.map(p => (
              <option key={p} value={p}>Period: {p}</option>
            ))}
          </select>

          <Button 
            onClick={handleRecalculatePeriodScorecards} 
            disabled={processingRecalc || !isAuthorized}
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-black h-8 px-3.5 gap-1.5 rounded-lg shrink-0 transition-all cursor-pointer shadow-sm"
          >
            <Play size={11} className="fill-current" />
            {processingRecalc ? 'Compiling...' : 'Publish & Calculate'}
          </Button>
        </div>
      </div>

      {/* TABS SELECTOR DECK */}
      <div className="flex border-b border-slate-150 dark:border-slate-800/60 gap-1">
        <button
          onClick={() => setActiveSubTab('database')}
          className={`py-2.5 px-4 font-black text-xs uppercase tracking-wider border-b-2 cursor-pointer transition-all duration-150 flex items-center gap-1.5 ${activeSubTab === 'database' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-extrabold' : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}
        >
          <Database size={13} />
          Historical Database
        </button>
        <button
          onClick={() => setActiveSubTab('uploader')}
          className={`py-2.5 px-4 font-black text-xs uppercase tracking-wider border-b-2 cursor-pointer transition-all duration-150 flex items-center gap-1.5 ${activeSubTab === 'uploader' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-extrabold' : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}
        >
          <FileSpreadsheet size={13} />
          KPI Universal Upload Desk
        </button>
      </div>

      {/* SUB-VIEW 1: DATABASE VIEW */}
      {activeSubTab === 'database' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-4">
            <Input 
              placeholder="Search by email, KPI, role, or process name..." 
              value={searchTerm} 
              onChange={(e) => setSearchTerm(e.target.value)} 
              className="flex-1 dark:bg-slate-900 dark:border-slate-850 dark:text-white text-xs h-10 shadow-sm"
            />
            <div className="flex items-center gap-2">
              <span className="text-xs font-black text-slate-400 dark:text-slate-500 uppercase tracking-wider bg-slate-50 dark:bg-slate-900 px-3 py-2 rounded-lg border border-slate-100 dark:border-slate-850">
                {selectedIds.size} Selected
              </span>
              <Button 
                variant="outline" 
                onClick={handleExport}
                className="bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/30 hover:text-emerald-800 dark:hover:text-emerald-300 border-emerald-200 dark:border-emerald-900/50 text-xs font-bold h-10 cursor-pointer shadow-sm"
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Export CSV
              </Button>
              <Button 
                variant="destructive" 
                onClick={() => setShowConfirm(true)}
                className="cursor-pointer text-xs font-bold h-10 shadow-sm"
                disabled={selectedIds.size === 0 || loading || !canDeleteRecords}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Delete Selected
              </Button>
            </div>
          </div>

          <Card className="border border-slate-150 dark:border-slate-850 shadow-sm rounded-2xl overflow-hidden bg-white dark:bg-slate-900">
            <div className="overflow-x-auto max-h-[500px]">
              <Table>
                <TableHeader className="sticky top-0 bg-slate-50 dark:bg-slate-900 z-10 shadow-sm shadow-slate-100 dark:shadow-slate-950">
                  <TableRow className="dark:border-slate-800">
                    <TableHead className="w-10">
                      <Button variant="ghost" size="sm" onClick={toggleSelectAll} className="dark:text-slate-300 dark:hover:bg-slate-850 h-8 px-2 cursor-pointer">
                        {selectedIds.size === data.length && data.length > 0 ? <CheckSquare className="w-4 h-4 text-indigo-600" /> : <Square className="w-4 h-4 text-slate-400" />}
                      </Button>
                    </TableHead>
                    <TableHead className="dark:text-slate-300 text-xs font-black text-slate-600 uppercase tracking-wider">Email</TableHead>
                    <TableHead className="dark:text-slate-300 text-xs font-black text-slate-600 uppercase tracking-wider">Process</TableHead>
                    <TableHead className="dark:text-slate-300 text-xs font-black text-slate-600 uppercase tracking-wider">Role</TableHead>
                    <TableHead className="dark:text-slate-300 text-xs font-black text-slate-600 uppercase tracking-wider">KPI</TableHead>
                    <TableHead className="dark:text-slate-300 text-xs font-black text-slate-600 uppercase tracking-wider">Period</TableHead>
                    <TableHead className="text-right dark:text-slate-300 text-xs font-black text-slate-600 uppercase tracking-wider">Actual</TableHead>
                    <TableHead className="text-right dark:text-slate-300 text-xs font-black text-slate-600 uppercase tracking-wider">Target</TableHead>
                    <TableHead className="w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedData.length > 0 ? paginatedData.map(row => {
                    const isEditing = editingId === row.docId;
                    return (
                      <TableRow key={row.docId} className={`dark:border-slate-800 border-b border-slate-100 hover:bg-slate-50/50 dark:hover:bg-slate-850/50 ${selectedIds.has(row.docId) ? 'bg-indigo-50/40 dark:bg-indigo-950/10' : ''}`}>
                        <TableCell>
                          <Button variant="ghost" size="sm" onClick={() => toggleSelect(row.docId)} className="dark:text-slate-300 dark:hover:bg-slate-800 h-8 px-2 cursor-pointer">
                            {selectedIds.has(row.docId) ? <CheckSquare className="w-4 h-4 text-indigo-600"/> : <Square className="w-4 h-4 text-slate-400"/>}
                          </Button>
                        </TableCell>
                        <TableCell className="dark:text-slate-300 font-extrabold text-xs">
                          {isEditing ? <Input value={editForm.employeeEmail || ''} onChange={e => setEditForm({...editForm, employeeEmail: e.target.value})} className="h-8 text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.employeeEmail}
                        </TableCell>
                        <TableCell className="dark:text-slate-300 font-medium text-xs">
                          {isEditing ? <Input value={editForm.processName || ''} onChange={e => setEditForm({...editForm, processName: e.target.value})} className="h-8 text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.processName}
                        </TableCell>
                        <TableCell className="dark:text-slate-300">
                          {isEditing ? <Input value={editForm.role || ''} onChange={e => setEditForm({...editForm, role: e.target.value})} className="h-8 text-xs w-16 dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : <Badge className="bg-slate-100 dark:bg-slate-850 text-slate-800 dark:text-slate-300 hover:bg-slate-100 font-black text-[10px] uppercase">{row.role}</Badge>}
                        </TableCell>
                        <TableCell className="dark:text-slate-300 font-bold text-xs">
                          {isEditing ? <Input value={editForm.kpiName || ''} onChange={e => setEditForm({...editForm, kpiName: e.target.value})} className="h-8 text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.kpiName}
                        </TableCell>
                        <TableCell className="dark:text-slate-300 font-semibold text-xs text-slate-500">
                          {isEditing ? <Input value={editForm.reportingPeriod || ''} onChange={e => setEditForm({...editForm, reportingPeriod: e.target.value})} className="h-8 text-xs w-20 dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.reportingPeriod}
                        </TableCell>
                        <TableCell className="text-right dark:text-slate-300 font-bold text-xs text-indigo-950 dark:text-indigo-400">
                          {isEditing ? <Input type="number" value={editForm.actual || ''} onChange={e => setEditForm({...editForm, actual: Number(e.target.value)})} className="h-8 text-xs w-16 ml-auto dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.actual}
                        </TableCell>
                        <TableCell className="text-right dark:text-slate-300 font-bold text-xs text-slate-600 dark:text-slate-400">
                          {isEditing ? <Input type="number" value={editForm.target || ''} onChange={e => setEditForm({...editForm, target: Number(e.target.value)})} className="h-8 text-xs w-16 ml-auto dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.target}
                        </TableCell>
                        <TableCell>
                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="icon" onClick={saveEdit} className="h-6 w-6 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-slate-800 cursor-pointer"><Save className="w-3 h-3" /></Button>
                              <Button variant="ghost" size="icon" onClick={() => setEditingId(null)} className="h-6 w-6 text-rose-500 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-slate-800 cursor-pointer"><X className="w-3 h-3" /></Button>
                            </div>
                          ) : (
                            <Button variant="ghost" size="icon" onClick={() => startEdit(row)} className="h-6 w-6 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-850 cursor-pointer" disabled={!isAuthorized}><Edit className="w-3 h-3"/></Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  }) : (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-12 text-xs text-slate-400 italic font-medium">No historical compliance records found matching selection.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>

          {/* PAGINATION DECK */}
          <div className="flex items-center justify-between mt-4">
            <span className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">
              Page {currentPage} of {totalPages === 0 ? 1 : totalPages} | Total: {filteredData.length} records
            </span>
            <div className="flex gap-1.5">
              <Button 
                variant="outline" 
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                disabled={currentPage === 1}
                className="dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 text-xs font-bold"
              >
                Previous
              </Button>
              <Button 
                variant="outline" 
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                disabled={currentPage >= totalPages || totalPages === 0}
                className="dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 text-xs font-bold"
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* SUB-VIEW 2: KPI UNIVERSAL UPLOAD DESK */}
      {activeSubTab === 'uploader' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* File Drag Card */}
            <Card className="border border-dashed border-slate-200 dark:border-slate-800 p-6 rounded-2xl bg-slate-50/40 dark:bg-slate-900/40 text-center flex flex-col justify-between h-56 shadow-sm">
              <div>
                <h3 className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-wider mb-1 flex items-center justify-center gap-1.5">
                  <FileSpreadsheet size={15} className="text-emerald-600 dark:text-emerald-400" /> Universal Spreadsheet Upload
                </h3>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-normal max-w-xs mx-auto mb-4">
                  Upload compiled Excel (.xlsx, .xls) or .csv rows. The platform maps dynamic parameters securely.
                </p>
              </div>

              <div className="space-y-3">
                <Input 
                  type="file" 
                  accept=".xlsx, .xls, .csv" 
                  onChange={handleExcelUpload} 
                  disabled={!isAuthorized}
                  className="w-full text-xs h-9 cursor-pointer opacity-90 text-slate-500 dark:text-slate-400"
                />
                {stagingFileName && (
                  <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-extrabold flex items-center justify-center gap-1 animate-pulse">
                    <Check size={12} /> Staged file: {stagingFileName}
                  </p>
                )}
              </div>
            </Card>

            {/* Work guidelines template downloader */}
            <Card className="border border-slate-150 dark:border-slate-850 p-6 rounded-2xl flex flex-col justify-between h-56 bg-white dark:bg-slate-900 shadow-sm">
              <div>
                <h3 className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-wider mb-1">Spreadsheet Work Guidelines</h3>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed">
                  Required Columns: <strong className="text-slate-600 dark:text-slate-300">Reporting Period, Employee Email, Role, Process Name, KPI Name, Target, Actual, Bonus, Penalty, and Comments</strong>. Feel free to use a single sheet for all processes!
                </p>
              </div>

              <div className="flex gap-2 w-full mt-4">
                <Button 
                  variant="outline" 
                  onClick={downloadTemplate}
                  className="flex-1 text-xs font-black h-10 gap-1.5 border-slate-200 dark:border-slate-800 text-slate-750 dark:text-slate-300 cursor-pointer bg-white dark:bg-slate-900 shadow-sm"
                >
                  <Download size={13} />
                  Download Template
                </Button>
                <Button 
                  variant="outline" 
                  onClick={clearStagingShelf}
                  disabled={stagingData.length === 0}
                  className="text-xs font-extrabold h-10 border-slate-200 dark:border-slate-800 text-rose-600 dark:text-rose-400 cursor-pointer bg-white dark:bg-slate-900 shadow-sm"
                  title="Clear memory staging deck"
                >
                  Reset Shelf
                </Button>
              </div>
            </Card>
          </div>

          {/* STAGING DECK TABLE */}
          {stagingData.length > 0 && (
            <Card className="border border-indigo-150 bg-indigo-50/5 dark:bg-slate-900 shadow-md rounded-2xl overflow-hidden mt-8">
              <CardHeader className="bg-indigo-50/20 dark:bg-slate-900 p-4 border-b border-indigo-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <CardTitle className="text-xs font-black text-indigo-950 dark:text-indigo-400 uppercase tracking-widest flex items-center gap-1">
                    Parsed Rows Staging Deck ({stagingData.length} records ready)
                  </CardTitle>
                  <CardDescription className="text-[10px] text-slate-400 dark:text-slate-500 font-semibold leading-relaxed">Review, edit, or delete items in memory before saving securely to the database.</CardDescription>
                </div>

                <Button 
                  onClick={handleCommitUploadGrid} 
                  disabled={loading}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold h-9 px-4 shrink-0 transition-all rounded-lg cursor-pointer shadow-sm"
                >
                  <CheckCircle size={14} className="mr-1.5" />
                  Approve & Save Uploads to DB
                </Button>
              </CardHeader>
              <div className="overflow-x-auto max-h-[420px]">
                <Table>
                  <TableHeader className="bg-slate-50 dark:bg-slate-900 font-black shrink-0 sticky top-0">
                    <TableRow className="border-b border-indigo-100 dark:border-slate-800">
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black">Email</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Period</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Work Date</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Process</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Role</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">KPI Name</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Target</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Actual</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Bonus/Penalty</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-center">Major Escalation</TableHead>
                      <TableHead className="text-slate-600 dark:text-slate-300 text-xs font-black text-right pr-4">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stagingData.map((row) => {
                      const isEditing = editingStagingId === row.id;
                      return (
                        <TableRow key={row.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-850 bg-white dark:bg-slate-900">
                          <TableCell className="py-2.5">
                            {isEditing ? (
                              <Input 
                                value={editRowFields.employeeEmail || ''} 
                                onChange={(e) => setEditRowFields({ ...editRowFields, employeeEmail: e.target.value })}
                                className="h-8 text-xs max-w-xs font-bold"
                              />
                            ) : (
                              <span className="font-extrabold text-xs text-slate-800 dark:text-slate-200">{row.employeeEmail}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center py-2.5">
                            {isEditing ? (
                              <Input 
                                value={editRowFields.reportingPeriod || ''} 
                                onChange={(e) => setEditRowFields({ ...editRowFields, reportingPeriod: e.target.value })}
                                className="h-8 text-xs w-20 text-center"
                              />
                            ) : (
                              <span className="font-semibold text-xs text-slate-500 dark:text-slate-400">{row.reportingPeriod}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center py-2.5">
                            {isEditing ? (
                              <Input 
                                value={editRowFields.workDate || ''} 
                                onChange={(e) => setEditRowFields({ ...editRowFields, workDate: e.target.value })}
                                className="h-8 text-xs w-24 text-center"
                              />
                            ) : (
                              <span className="font-semibold text-xs text-slate-500 dark:text-slate-400">{row.workDate || '-'}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center py-2.5">
                            {isEditing ? (
                              <Input 
                                value={editRowFields.processName || ''} 
                                onChange={(e) => setEditRowFields({ ...editRowFields, processName: e.target.value })}
                                className="h-8 text-xs w-24 text-center"
                              />
                            ) : (
                              <span className="font-semibold text-xs text-slate-500 dark:text-slate-400">{row.processName}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center py-2.5">
                            {isEditing ? (
                              <Input 
                                value={editRowFields.role || ''} 
                                onChange={(e) => setEditRowFields({ ...editRowFields, role: e.target.value })}
                                className="h-8 text-xs w-16 text-center"
                              />
                            ) : (
                              <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-300 font-extrabold hover:bg-slate-100 text-[10px] uppercase">{row.role}</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-center py-2.5">
                            {isEditing ? (
                              <Input 
                                value={editRowFields.kpiName || ''} 
                                onChange={(e) => setEditRowFields({ ...editRowFields, kpiName: e.target.value })}
                                className="h-8 text-xs w-32"
                              />
                            ) : (
                              <span className="font-bold text-xs text-slate-800 dark:text-slate-200">{row.kpiName}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center py-2.5 font-bold text-xs text-slate-700 dark:text-slate-300">
                            {isEditing ? (
                              <Input 
                                type="number"
                                value={editRowFields.target || 0} 
                                onChange={(e) => setEditRowFields({ ...editRowFields, target: Number(e.target.value) })}
                                className="h-8 text-xs w-16 text-center"
                              />
                            ) : (
                              row.target
                            )}
                          </TableCell>
                          <TableCell className="text-center py-2.5 font-bold text-xs text-indigo-950 dark:text-indigo-400">
                            {isEditing ? (
                              <Input 
                                type="number"
                                value={editRowFields.actual || 0} 
                                onChange={(e) => setEditRowFields({ ...editRowFields, actual: Number(e.target.value) })}
                                className="h-8 text-xs w-16 text-center"
                              />
                            ) : (
                              row.actual
                            )}
                          </TableCell>
                          <TableCell className="text-center py-2.5">
                            {isEditing ? (
                              <div className="flex gap-1 items-center justify-center">
                                <Input 
                                  type="number"
                                  placeholder="Bonus"
                                  value={editRowFields.bonus || 0} 
                                  onChange={(e) => setEditRowFields({ ...editRowFields, bonus: Number(e.target.value) })}
                                  className="h-8 text-xs w-14 text-center"
                                />
                                <Input 
                                  type="number"
                                  placeholder="Penalty"
                                  value={editRowFields.penalty || 0} 
                                  onChange={(e) => setEditRowFields({ ...editRowFields, penalty: Number(e.target.value) })}
                                  className="h-8 text-xs w-14 text-center"
                                />
                              </div>
                            ) : (
                              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                {row.bonus > 0 && `+${row.bonus}B`} {row.penalty > 0 && `-${row.penalty}P`}
                                {row.bonus === 0 && row.penalty === 0 && '-'}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-center py-2.5">
                            <input 
                              type="checkbox"
                              checked={isEditing ? (editRowFields.hasMajorEscalation || false) : (row.hasMajorEscalation || false)}
                              disabled={!isEditing}
                              onChange={(e) => setEditRowFields({ ...editRowFields, hasMajorEscalation: e.target.checked })}
                              className="w-3.5 h-3.5 cursor-pointer accent-indigo-600 rounded"
                            />
                          </TableCell>
                          <TableCell className="text-right py-2.5 pr-4 shrink-0">
                            <div className="flex items-center justify-end gap-1.5">
                              {isEditing ? (
                                <Button 
                                  onClick={handleSaveStagingRow}
                                  size="sm"
                                  className="bg-emerald-500 hover:bg-emerald-600 h-7 text-[10px] text-white p-2.5 cursor-pointer rounded-md"
                                >
                                  Save
                                </Button>
                              ) : (
                                <Button 
                                  onClick={() => handleStartStagingEdit(row)}
                                  size="sm"
                                  variant="ghost"
                                  className="hover:bg-slate-100 dark:hover:bg-slate-800 h-7 text-[10px] text-indigo-600 dark:text-indigo-400 p-2 text-center"
                                >
                                  Edit
                                </Button>
                              )}
                              <Button 
                                onClick={() => handleRemoveStagingRow(row.id)}
                                size="sm"
                                variant="ghost"
                                className="hover:bg-rose-50 dark:hover:bg-rose-950/20 text-rose-600 dark:text-rose-400 h-7 text-[10px] p-2"
                              >
                                Delete
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Confirmation Dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="dark:bg-slate-900 border-none">
            <DialogHeader>
                <DialogTitle className="text-rose-600 flex items-center gap-2 font-black text-md"><AlertTriangle /> Confirm Deletion</DialogTitle>
                <DialogDescription className="dark:text-slate-400 text-xs font-semibold leading-relaxed">This action is irreversible. All {selectedIds.size} selected raw compliance records will be permanently removed from the Firestore database.</DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 mt-4">
                <Button variant="outline" onClick={() => setShowConfirm(false)} className="dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 text-xs font-bold">Cancel</Button>
                <Button variant="destructive" onClick={handleBulkDelete} className="cursor-pointer text-xs font-black">Permanently Delete</Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManageHistoricalRecordsView;
