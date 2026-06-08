import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from 'sonner';
import { Trash2, AlertTriangle, CheckSquare, Square, Download, Edit, Save, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import { performCascadeDeleteKpiUploads } from '../lib/dataCleanupService';
import * as XLSX from 'xlsx';
import { usePermission } from '../components/PermissionContext';

const ManageHistoricalRecordsView = ({ user }: { user: any }) => {
  const { canEdit, canDelete } = usePermission();

  const [data, setData] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 25;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<any>({});

  // Role restriction
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
      toast.error('Failed to load data');
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
    } catch (err) {
      toast.error("Failed to update record");
    } finally {
      setLoading(false);
    }
  };

  const filteredData = useMemo(() => {
    const filtered = data.filter(d => 
        (d.employeeEmail || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (d.kpiName || '').toLowerCase().includes(searchTerm.toLowerCase())
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
    console.log('Attempting delete. User Role:', user.role, 'User Email:', user.email);
    if (!isAuthorized) {
        toast.error('You do not have permission to delete this record. Only Admins can perform this action.');
        return;
    }
    setLoading(true);
    try {
        const recordsToDelete = data.filter(d => selectedIds.has(d.docId));
        console.log(`Deleting ${recordsToDelete.length} records. IDs:`, recordsToDelete.map(r => r.docId));
        
        await performCascadeDeleteKpiUploads(recordsToDelete, 'Requested by user', user.email);
        
        toast.success(`Deleted ${selectedIds.size} records and logged audit.`);
        setSelectedIds(new Set());
        fetchData();
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

  return (
    <div className="p-8 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold dark:text-white">Manage Historical Records</h1>
        <div className="flex items-center gap-4">
            <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">{selectedIds.size} selected</span>
            <Button 
                variant="outline" 
                onClick={handleExport}
                className="bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 hover:text-emerald-800 dark:hover:text-emerald-300 border-emerald-200 dark:border-emerald-800"
            >
                <Download className="w-4 h-4 mr-2" />
                Export CSV
            </Button>
            <Button 
                variant="destructive" 
                onClick={() => setShowConfirm(true)}
                className="cursor-pointer"
                disabled={selectedIds.size === 0 || loading || !canDeleteRecords}
            >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Selected
            </Button>
        </div>
      </div>

      <Input 
        placeholder="Search by email or KPI..." 
        value={searchTerm} 
        onChange={(e) => setSearchTerm(e.target.value)} 
        className="dark:bg-slate-900 dark:border-slate-800 dark:text-white"
      />

      <div className="rounded-md border dark:border-slate-800 h-[500px] overflow-auto relative">
        <Table>
          <TableHeader className="sticky top-0 bg-white dark:bg-slate-900 z-10 shadow-sm shadow-slate-200 dark:shadow-slate-950">
              <TableRow className="dark:border-slate-800">
                  <TableHead className="w-10">
                      <Button variant="ghost" size="sm" onClick={toggleSelectAll} className="dark:text-slate-300 dark:hover:bg-slate-800">
                          {selectedIds.size === data.length && data.length > 0 ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </Button>
                  </TableHead>
                  <TableHead className="dark:text-slate-300">Email</TableHead>
                  <TableHead className="dark:text-slate-300">Process</TableHead>
                  <TableHead className="dark:text-slate-300">Role</TableHead>
                  <TableHead className="dark:text-slate-300">KPI</TableHead>
                  <TableHead className="dark:text-slate-300">Period</TableHead>
                  <TableHead className="text-right dark:text-slate-300">Actual</TableHead>
                  <TableHead className="text-right dark:text-slate-300">Target</TableHead>
                  <TableHead className="w-20"></TableHead>
              </TableRow>
          </TableHeader>
          <TableBody>
              {paginatedData.map(row => {
                  const isEditing = editingId === row.docId;
                  return (
                  <TableRow key={row.docId} className={`dark:border-slate-800 ${selectedIds.has(row.docId) ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''}`}>
                      <TableCell><Button variant="ghost" size="sm" onClick={() => toggleSelect(row.docId)} className="dark:text-slate-300 dark:hover:bg-slate-800">{selectedIds.has(row.docId) ? <CheckSquare className="w-4 h-4"/> : <Square className="w-4 h-4"/>}</Button></TableCell>
                      <TableCell className="dark:text-slate-300">
                          {isEditing ? <Input value={editForm.employeeEmail || ''} onChange={e => setEditForm({...editForm, employeeEmail: e.target.value})} className="h-8 text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.employeeEmail}
                      </TableCell>
                      <TableCell className="dark:text-slate-300">
                          {isEditing ? <Input value={editForm.processName || ''} onChange={e => setEditForm({...editForm, processName: e.target.value})} className="h-8 text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.processName}
                      </TableCell>
                      <TableCell className="dark:text-slate-300">
                          {isEditing ? <Input value={editForm.role || ''} onChange={e => setEditForm({...editForm, role: e.target.value})} className="h-8 text-xs w-16 dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.role}
                      </TableCell>
                      <TableCell className="dark:text-slate-300">
                          {isEditing ? <Input value={editForm.kpiName || ''} onChange={e => setEditForm({...editForm, kpiName: e.target.value})} className="h-8 text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.kpiName}
                      </TableCell>
                      <TableCell className="dark:text-slate-300">
                          {isEditing ? <Input value={editForm.reportingPeriod || ''} onChange={e => setEditForm({...editForm, reportingPeriod: e.target.value})} className="h-8 text-xs w-20 dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.reportingPeriod}
                      </TableCell>
                      <TableCell className="text-right dark:text-slate-300">
                          {isEditing ? <Input type="number" value={editForm.actual || ''} onChange={e => setEditForm({...editForm, actual: Number(e.target.value)})} className="h-8 text-xs w-16 ml-auto dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.actual}
                      </TableCell>
                      <TableCell className="text-right dark:text-slate-300">
                          {isEditing ? <Input type="number" value={editForm.target || ''} onChange={e => setEditForm({...editForm, target: Number(e.target.value)})} className="h-8 text-xs w-16 ml-auto dark:bg-slate-800 dark:border-slate-700 dark:text-white" /> : row.target}
                      </TableCell>
                      <TableCell>
                          {isEditing ? (
                              <div className="flex items-center gap-1">
                                  <Button variant="ghost" size="icon" onClick={saveEdit} className="h-6 w-6 text-emerald-600 dark:text-emerald-400 dark:hover:bg-slate-800"><Save className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" onClick={() => setEditingId(null)} className="h-6 w-6 text-rose-500 dark:text-rose-400 dark:hover:bg-slate-800"><X className="w-3 h-3" /></Button>
                              </div>
                          ) : (
                              <Button variant="ghost" size="icon" onClick={() => startEdit(row)} className="h-6 w-6 dark:text-slate-300 dark:hover:bg-slate-800"><Edit className="w-3 h-3"/></Button>
                          )}
                      </TableCell>
                  </TableRow>
                  );
              })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between mt-4">
        <span className="text-sm text-slate-500 dark:text-slate-400">
            Page {currentPage} of {totalPages === 0 ? 1 : totalPages} | Total: {filteredData.length} records
        </span>
        <div className="flex gap-2">
            <Button 
                variant="outline" 
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                disabled={currentPage === 1}
                className="dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
            >
                Previous
            </Button>
            <Button 
                variant="outline" 
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                disabled={currentPage >= totalPages || totalPages === 0}
                className="dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
            >
                Next
            </Button>
        </div>
      </div>

      {/* Confirmation Dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="dark:bg-slate-900 border-none">
            <DialogHeader>
                <DialogTitle className="text-rose-600 flex items-center gap-2 font-bold"><AlertTriangle /> Confirm Deletion</DialogTitle>
                <DialogDescription className="dark:text-slate-400">This action is irreversible. All {selectedIds.size} selected records will be permanently removed.</DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setShowConfirm(false)} className="dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</Button>
                <Button variant="destructive" onClick={handleBulkDelete} className="cursor-pointer">Permanently Delete</Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManageHistoricalRecordsView;
