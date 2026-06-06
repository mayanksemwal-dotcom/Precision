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
        <h1 className="text-2xl font-bold">Manage Historical Records</h1>
        <div className="flex items-center gap-4">
            <span className="text-sm font-semibold text-slate-500">{selectedIds.size} selected</span>
            <Button 
                variant="outline" 
                onClick={handleExport}
                className="bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800 border-emerald-200"
            >
                <Download className="w-4 h-4 mr-2" />
                Export CSV
            </Button>
            <Button 
                variant="destructive" 
                onClick={() => setShowConfirm(true)}
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
      />

      <div className="rounded-md border h-[500px] overflow-auto relative">
        <Table>
          <TableHeader className="sticky top-0 bg-white z-10 shadow-sm shadow-slate-200">
              <TableRow>
                  <TableHead className="w-10">
                      <Button variant="ghost" size="sm" onClick={toggleSelectAll}>
                          {selectedIds.size === data.length && data.length > 0 ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </Button>
                  </TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Process</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>KPI</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="text-right">Target</TableHead>
                  <TableHead className="w-20"></TableHead>
              </TableRow>
          </TableHeader>
          <TableBody>
              {paginatedData.map(row => {
                  const isEditing = editingId === row.docId;
                  return (
                  <TableRow key={row.docId} className={selectedIds.has(row.docId) ? 'bg-indigo-50' : ''}>
                      <TableCell><Button variant="ghost" size="sm" onClick={() => toggleSelect(row.docId)}>{selectedIds.has(row.docId) ? <CheckSquare className="w-4 h-4"/> : <Square className="w-4 h-4"/>}</Button></TableCell>
                      <TableCell>
                          {isEditing ? <Input value={editForm.employeeEmail || ''} onChange={e => setEditForm({...editForm, employeeEmail: e.target.value})} className="h-8 text-xs" /> : row.employeeEmail}
                      </TableCell>
                      <TableCell>
                          {isEditing ? <Input value={editForm.processName || ''} onChange={e => setEditForm({...editForm, processName: e.target.value})} className="h-8 text-xs" /> : row.processName}
                      </TableCell>
                      <TableCell>
                          {isEditing ? <Input value={editForm.role || ''} onChange={e => setEditForm({...editForm, role: e.target.value})} className="h-8 text-xs w-16" /> : row.role}
                      </TableCell>
                      <TableCell>
                          {isEditing ? <Input value={editForm.kpiName || ''} onChange={e => setEditForm({...editForm, kpiName: e.target.value})} className="h-8 text-xs" /> : row.kpiName}
                      </TableCell>
                      <TableCell>
                          {isEditing ? <Input value={editForm.reportingPeriod || ''} onChange={e => setEditForm({...editForm, reportingPeriod: e.target.value})} className="h-8 text-xs w-20" /> : row.reportingPeriod}
                      </TableCell>
                      <TableCell className="text-right">
                          {isEditing ? <Input type="number" value={editForm.actual || ''} onChange={e => setEditForm({...editForm, actual: Number(e.target.value)})} className="h-8 text-xs w-16 ml-auto" /> : row.actual}
                      </TableCell>
                      <TableCell className="text-right">
                          {isEditing ? <Input type="number" value={editForm.target || ''} onChange={e => setEditForm({...editForm, target: Number(e.target.value)})} className="h-8 text-xs w-16 ml-auto" /> : row.target}
                      </TableCell>
                      <TableCell>
                          {isEditing ? (
                              <div className="flex items-center gap-1">
                                  <Button variant="ghost" size="icon" onClick={saveEdit} className="h-6 w-6 text-emerald-600"><Save className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" onClick={() => setEditingId(null)} className="h-6 w-6 text-rose-500"><X className="w-3 h-3" /></Button>
                              </div>
                          ) : (
                              <Button variant="ghost" size="icon" onClick={() => startEdit(row)} className="h-6 w-6"><Edit className="w-3 h-3"/></Button>
                          )}
                      </TableCell>
                  </TableRow>
                  );
              })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between mt-4">
        <span className="text-sm text-slate-500">
            Page {currentPage} of {totalPages === 0 ? 1 : totalPages} | Total: {filteredData.length} records
        </span>
        <div className="flex gap-2">
            <Button 
                variant="outline" 
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                disabled={currentPage === 1}
            >
                Previous
            </Button>
            <Button 
                variant="outline" 
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                disabled={currentPage >= totalPages || totalPages === 0}
            >
                Next
            </Button>
        </div>
      </div>

      {/* Confirmation Dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
            <DialogHeader>
                <DialogTitle className="text-rose-600 flex items-center gap-2"><AlertTriangle /> Confirm Deletion</DialogTitle>
                <DialogDescription>This action is irreversible. All {selectedIds.size} selected records will be permanently removed.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
                <Button variant="outline" onClick={() => setShowConfirm(false)}>Cancel</Button>
                <Button variant="destructive" onClick={handleBulkDelete}>Permanently Delete</Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManageHistoricalRecordsView;
