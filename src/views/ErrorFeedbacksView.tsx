import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Input } from '../components/ui/input';
import { Search, Calendar, MessageSquare, Download } from 'lucide-react';
import { AuditRecord, UserProfile, UserRole, QAAlignment } from '../types';
import { usePermission } from '../components/PermissionContext';
import * as XLSX from 'xlsx';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';

interface ErrorFeedbacksViewProps {
  auditLogs: AuditRecord[];
  user: UserProfile;
  alignments?: QAAlignment[];
}

export default function ErrorFeedbacksView({ auditLogs, user, alignments = [] }: ErrorFeedbacksViewProps) {
  const { canEdit } = usePermission();
  const canManageReports = canEdit('KPI Scorecard');
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const getVisibleFeedbacks = () => {
    let logs = auditLogs.filter(a => a.status === 'Incorrect' || a.compErrorCount > 0 || a.mpqcErrorCount > 0);
    
    if (!canManageReports) {
      logs = logs.filter(a => a.qaId === user.uid || a.agentId === user.uid || a.qvName === user.name);
    }
    
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      logs = logs.filter(a => 
        (a.taskId && a.taskId.toLowerCase().includes(lower)) || 
        (a.qvName && a.qvName.toLowerCase().includes(lower)) ||
        (a.errorType && a.errorType.toLowerCase().includes(lower)) ||
        (a.theme && a.theme.toLowerCase().includes(lower))
      );
    }
    
    return logs.sort((a, b) => new Date(b.auditDate).getTime() - new Date(a.auditDate).getTime());
  };

  const filteredLogs = getVisibleFeedbacks();
  const paginatedLogs = filteredLogs.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const handleSearchChange = (val: string) => {
    setSearchTerm(val);
    setCurrentPage(1);
  };

  const exportData = () => {
    if (filteredLogs.length === 0) {
      toast.error('No data to export');
      return;
    }
    
    const exportArray = filteredLogs.map(log => ({
      'Task ID': log.taskId,
      'Agent': log.qvName,
      'Vertical': log.vertical,
      'Date': new Date(log.auditDate).toLocaleDateString(),
      'Error Type': log.errorType,
      'Error Guideline': log.guideline,
      'Error Theme': log.theme,
      'Error Row No.': log.rowNo,
      'QA Comment': log.qaComment,
      'QA User': log.qaId
    }));

    const ws = XLSX.utils.json_to_sheet(exportArray);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Error_Feedbacks');
    XLSX.writeFile(wb, `Error_Feedbacks_${new Date().toISOString().split('T')[0]}.xlsx`);
    toast.success('Report downloaded successfully');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black text-slate-800 tracking-tight">Error Feedbacks</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">View detailed feedback for incorrect cases.</p>
        </div>
        <Button 
          onClick={exportData}
          className="bg-slate-900 hover:bg-slate-800 text-white font-bold gap-2"
        >
          <Download size={16} />
          Export to Excel
        </Button>
      </div>

      <Card className="shadow-sm border-slate-200">
        <CardHeader className="pb-4 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <Input 
                placeholder="Search by Task ID, Agent, Error..." 
                className="pl-10 border-slate-200"
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
            <div className="text-sm font-semibold text-slate-500 whitespace-nowrap px-4 py-2 bg-white border border-slate-200 rounded-lg shadow-sm">
              <MessageSquare size={14} className="inline mr-2 text-rose-500" />
              {filteredLogs.length} Feedbacks
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-auto max-h-[600px] border border-slate-100 rounded-lg scrollbar-thin">
            <Table>
              <TableHeader className="bg-slate-50 sticky top-0 z-10 shadow-xs">
                <TableRow>
                  <TableHead className="font-bold whitespace-nowrap pl-6">Task ID</TableHead>
                  <TableHead className="font-bold whitespace-nowrap">Agent</TableHead>
                  <TableHead className="font-bold whitespace-nowrap">Date</TableHead>
                  <TableHead className="font-bold whitespace-nowrap">Error Type</TableHead>
                  <TableHead className="font-bold whitespace-nowrap">Guideline</TableHead>
                  <TableHead className="font-bold whitespace-nowrap">Theme</TableHead>
                  <TableHead className="font-bold whitespace-nowrap">Row</TableHead>
                  <TableHead className="font-bold whitespace-nowrap">QA Comment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedLogs.map(log => (
                  <TableRow key={log.id} className="hover:bg-slate-50/50 transition-colors">
                    <TableCell className="font-mono font-medium text-xs pl-6 text-blue-600">{log.taskId}</TableCell>
                    <TableCell className="font-semibold text-slate-700">{log.qvName}</TableCell>
                    <TableCell className="text-xs text-slate-500 font-medium">{new Date(log.auditDate).toLocaleDateString()}</TableCell>
                    <TableCell>
                      <span className="px-2 py-1 rounded bg-rose-100 text-rose-700 text-[10px] font-bold block max-w-[150px] truncate" title={log.errorType}>
                        {log.errorType}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-slate-600 max-w-[150px] truncate" title={log.guideline}>{log.guideline}</TableCell>
                    <TableCell className="text-xs text-slate-600 max-w-[150px] truncate" title={log.theme}>{log.theme}</TableCell>
                    <TableCell className="text-xs font-bold text-slate-700">{log.rowNo}</TableCell>
                    <TableCell className="text-xs text-slate-600 max-w-[200px] truncate" title={log.qaComment}>
                      {log.qaComment}
                    </TableCell>
                  </TableRow>
                ))}
                {filteredLogs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="h-32 text-center text-slate-400 font-medium">
                      No error feedbacks found matching your criteria.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {filteredLogs.length > 0 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-6 py-4 bg-slate-50/30">
              <span className="text-xs font-bold text-slate-500">
                Showing {Math.min(filteredLogs.length, (currentPage - 1) * itemsPerPage + 1)}-{Math.min(filteredLogs.length, currentPage * itemsPerPage)} of {filteredLogs.length} entries
              </span>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  className="font-bold text-xs h-8"
                >
                  Previous Page
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage * itemsPerPage >= filteredLogs.length}
                  onClick={() => setCurrentPage(prev => prev + 1)}
                  className="font-bold text-xs h-8"
                >
                  Next Page
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
