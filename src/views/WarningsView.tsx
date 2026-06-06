import React, { useState } from 'react';
import { 
  ShieldAlert, 
  AlertTriangle, 
  Info, 
  History, 
  FileText, 
  User as UserIcon,
  Calendar,
  ChevronRight,
  TrendingUp,
  Search,
  Filter,
  Plus,
  CheckCircle,
  Clock,
  Briefcase,
  Edit2,
  Trash2
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { WarningTicket, UserRole, UserProfile } from '../types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import WarningManager from '../components/WarningManager';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { softDeleteRecord } from '../lib/adminUtils';
import { doc, setDoc, updateDoc, addDoc, collection } from 'firebase/firestore';
import { toast } from 'sonner';
import { usePermission } from '../components/PermissionContext';
import { canActOn } from '../lib/hierarchy';

interface WarningsViewProps {
  warnings: WarningTicket[];
  user: UserProfile;
  allUsers: UserProfile[];
  onRefresh?: () => void;
}

export default function WarningsView({ warnings = [], user, allUsers = [], onRefresh }: WarningsViewProps) {
  const { canCreate, canEdit, canDelete } = usePermission();
  const [searchTerm, setSearchTerm] = useState('');
  const [isWarningOpen, setIsWarningOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('All');

  // Filter based on hierarchy, and exclude soft-deleted
  const filteredWarnings = warnings.filter(w => {
    if (w.isDeleted) return false; 
    
    // Visibility check: 
    // 1. Is it my own warning?
    const isMine = w.agentId === user.uid;
    
    // 2. Is it someone I supervise?
    const targetUser = allUsers.find(u => u.uid === w.agentId);
    const isSubordinate = targetUser ? canActOn(user, targetUser, allUsers) : false;

    if (!isMine && !isSubordinate) return false;

    // Search filter
    const matchesSearch = 
      (w.agentName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (w.agentEmail || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (w.remarks || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (w.level || '').toLowerCase().includes(searchTerm.toLowerCase());

    // Status filter
    const matchesStatus = statusFilter === 'All' || w.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const canIssueWarning = canCreate('Warnings');
  const canModifyWarning = canEdit('Warnings');
  const canDeleteWarning = canDelete('Warnings');

  const handleDelete = async (ticket: WarningTicket) => {
    if (confirm('Are you sure you want to soft-delete/cancel this warning ticket? It will be archived and logged.')) {
        try {
            const docRef = doc(db, 'disciplinaryLogs', ticket.id);
            const nowISO = new Date().toISOString();
            const performerName = `${user.fullName || user.name || user.email}`;

            await updateDoc(docRef, {
                isDeleted: true,
                status: 'Deleted',
                deletedAt: nowISO,
                deletedBy: user.email
            });

            // Log tool audit event
            await addDoc(collection(db, 'adminAuditLogs'), {
              timestamp: nowISO,
              action: 'Warning Closed',
              performedBy: `${performerName} (${user.email})`,
              affectedUser: `${ticket.agentName} (${ticket.agentEmail})`,
              previousValue: ticket.status || 'Pending',
              newValue: 'Deleted / Cancelled',
              remarks: `Soft deleted warning ticket ${ticket.id}`,
              details: {
                ticketId: ticket.id,
                level: ticket.level,
                reason: ticket.remarks
              }
            });

            toast.success('Warning ticket successfully soft-deleted.');
            if (onRefresh) onRefresh();
        } catch (err: any) {
             console.error('Deletion failure:', err);
             toast.error(`Deletion failed: ${err.message || 'Permission denied'}`);
        }
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case '1st': return 'bg-blue-50 text-blue-700 border-blue-200';
      case '2nd': return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'Final': return 'bg-red-50 text-red-700 border-red-200';
      default: return 'bg-purple-50 text-purple-700 border-purple-200';
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'Mild': return 'bg-slate-100 text-slate-700 border-slate-200';
      case 'Moderate': return 'bg-yellow-50 text-yellow-700 border-yellow-200';
      case 'Severe': return 'bg-orange-50 text-orange-700 border-orange-200';
      case 'Critical': return 'bg-red-100 text-red-800 border-red-300 font-extrabold';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Pending': return 'bg-yellow-100 text-yellow-900 border-yellow-200 animate-pulse';
      case 'Accepted':
      case 'Acknowledged': return 'bg-emerald-100 text-emerald-900 border-emerald-200';
      case 'Disputed': return 'bg-rose-100 text-rose-900 border-rose-200';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  // Action handers: Accept Warning
  const handleAccept = async (ticket: WarningTicket) => {
    try {
      const nowISO = new Date().toISOString();
      const updatedTicket: WarningTicket = {
        ...ticket,
        status: 'Accepted',
        acceptedAt: nowISO,
        history: [
          ...(ticket.history || []),
          {
            action: `Warning Accepted by Agent`,
            timestamp: nowISO,
            userName: user.name,
            userRole: user.role
          }
        ]
      };

      const docRef = doc(db, 'disciplinaryLogs', ticket.id);
      await setDoc(docRef, updatedTicket, { merge: true });

      // Log to audit logs
      await addDoc(collection(db, 'adminAuditLogs'), {
        timestamp: nowISO,
        action: 'Warning Modified',
        performedBy: `${user.fullName || user.name || user.email} (${user.email})`,
        affectedUser: `${ticket.agentName} (${ticket.agentEmail})`,
        previousValue: ticket.status || 'Pending',
        newValue: 'Accepted',
        remarks: 'Warning acknowledged and accepted by employee',
        details: {
          ticketId: ticket.id,
          level: ticket.level,
        }
      });

      toast.success(`Success! Warning has been successfully accepted and logged.`);
      if (onRefresh) onRefresh();
    } catch (e: any) {
      if(e.code === 'permission-denied') {
        toast.error('You do not have permission to accept this warning.');
      } else {
        handleFirestoreError(e, OperationType.WRITE, 'disciplinaryLogs');
      }
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white/80 backdrop-blur p-6 rounded-2xl border border-slate-100 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-red-600 flex items-center justify-center text-white shadow-lg shadow-red-250">
            <ShieldAlert size={24} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight">Active Disciplinary Panel</h2>
            <p className="text-sm font-medium text-slate-500">Acknowledge, track, and audit active feedback tickets</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {canIssueWarning && (
            <Dialog open={isWarningOpen} onOpenChange={setIsWarningOpen}>
              <DialogTrigger 
                render={
                  <Button className="bg-red-600 hover:bg-red-700 text-white font-bold gap-2 shadow-lg shadow-red-100 cursor-pointer">
                    <Plus size={18} /> Raise Warning Ticket
                  </Button>
                }
              />
              <DialogContent className="sm:max-w-[500px] bg-white shadow-2xl border border-slate-200 [id^='dialog-content-']">
                <DialogHeader>
                  <DialogTitle className="text-xl font-bold">Raise Disciplinary Action</DialogTitle>
                  <DialogDescription className="text-slate-500">
                    Select an agent, warning severity, and notification path under the staircase policy.
                  </DialogDescription>
                </DialogHeader>
                <WarningManager allUsers={allUsers} onClose={() => { setIsWarningOpen(false); if (onRefresh) onRefresh(); }} />
              </DialogContent>
            </Dialog>
          )}

          <div className="px-4 py-2 bg-slate-50/50 rounded-lg border border-slate-100 flex items-center gap-3">
            <div className="text-right border-r border-slate-200 pr-3">
              <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">
                {canCreate('Warnings') ? 'Pending' : 'My Pending'}
              </p>
              <p className="text-lg font-black text-red-600 leading-none">
                {filteredWarnings.filter(w => w.status === 'Pending').length}
              </p>
            </div>
            <div className="pl-1">
              <TrendingUp size={16} className="text-red-500 animate-pulse" />
            </div>
          </div>
          <div className="px-4 py-2 bg-slate-50/50 rounded-lg border border-slate-100 flex items-center gap-3">
            <div className="text-right">
              <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">
                {canCreate('Warnings') ? 'Total Active' : 'My Total Warnings'}
              </p>
              <p className="text-lg font-black text-slate-900 leading-none">{filteredWarnings.length}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Policy Box */}
        <div className="space-y-6 lg:col-span-1">
          <Card className="border border-slate-100 shadow-sm overflow-hidden bg-white">
            <CardHeader className="bg-slate-900 text-white pb-6 pt-8">
              <CardTitle className="text-xs font-extrabold tracking-widest uppercase opacity-80 mb-2">Staircase Policy Guidelines</CardTitle>
              <CardDescription className="text-slate-300 text-xs leading-relaxed">
                Rules governing process escalations, quality caps, and remedial paths.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 space-y-4">
              <div className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded bg-slate-50 flex items-center justify-center text-slate-600 shrink-0 mt-0.5">
                  <Info size={12} />
                </div>
                <div className="text-xs space-y-1">
                  <p className="font-extrabold text-slate-900">Mild Severity</p>
                  <p className="text-slate-500 leading-tight">General oral counseling, zero immediate impact on metrics.</p>
                </div>
              </div>
              <div className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded bg-yellow-50 flex items-center justify-center text-yellow-600 shrink-0 mt-0.5">
                  <AlertTriangle size={12} />
                </div>
                <div className="text-xs space-y-1">
                  <p className="font-extrabold text-slate-900">Moderate Severity</p>
                  <p className="text-slate-500 leading-tight font-medium">Official 1st/2nd reprimand, restricts top performer incentives.</p>
                </div>
              </div>
              <div className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded bg-red-50 flex items-center justify-center text-red-650 shrink-0 mt-0.5">
                  <ShieldAlert size={12} />
                </div>
                <div className="text-xs space-y-1">
                  <p className="font-extrabold text-slate-950">Critical Severity</p>
                  <p className="text-slate-500 leading-tight font-semibold">Immediate target appraisal caps. Action required within 48h.</p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="bg-slate-50/50 border-t border-slate-100 flex justify-center py-4">
              <Button 
                variant="link" 
                className="text-xs font-bold text-slate-500 flex items-center gap-1"
                render={
                  <a 
                    href="https://docs.google.com/document/d/1zAu2KCCUfOFBA8-nopnc1YRNycaDhCtRPfI7CIgFl7Y/edit?tab=t.ttcgryfeyu7#heading=h.ra63ci5w7hx3" 
                    target="_blank" 
                    rel="noopener noreferrer"
                  />
                }
              >
                Staircase Policy Reference <ChevronRight size={14} />
              </Button>
            </CardFooter>
          </Card>
        </div>

        {/* Dynamic Disciplinary Logs Table list with Glassmorphism styling */}
        <div className="lg:col-span-3 space-y-6">
          <div className="flex flex-col sm:flex-row items-center gap-4 bg-white p-4 rounded-xl border border-slate-100">
            <div className="relative flex-1 w-full group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-550 transition-colors" size={18} />
              <Input 
                placeholder="Search Agent Name, Email, ID, or Description comments..." 
                className="pl-10 h-10 w-full bg-slate-50/50 border-slate-150 focus:bg-white focus:ring-blue-550 rounded-lg text-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            
            <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 select-none">
              <span className="text-xs font-bold text-slate-400 uppercase hidden sm:inline">Status:</span>
              <div className="flex gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                {['All', 'Pending', 'Accepted'].map((st) => (
                  <button
                    key={st}
                    onClick={() => setStatusFilter(st)}
                    className={`px-2.5 py-1 text-xs font-black rounded-md transition-all cursor-pointer ${
                      statusFilter === st ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Card className="border border-slate-100 shadow-sm overflow-hidden bg-white">
            <CardHeader className="border-b border-slate-100 pb-4">
              <div>
                <CardTitle className="text-lg font-black text-slate-900 tracking-tight">Active Disciplinary Logs</CardTitle>
                <CardDescription className="text-xs font-medium text-slate-400">Quarterly disciplinary record index across teams</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-slate-50/50">
                  <TableRow className="hover:bg-transparent border-slate-100">
                    <TableHead className="w-[110px] font-bold text-slate-800 text-[10px] uppercase tracking-widest pl-6">Type</TableHead>
                    <TableHead className="font-bold text-slate-800 text-[10px] uppercase tracking-widest">Employee & Agent Info</TableHead>
                    <TableHead className="font-bold text-slate-800 text-[10px] uppercase tracking-widest w-[110px]">Severity</TableHead>
                    <TableHead className="font-bold text-slate-800 text-[10px] uppercase tracking-widest w-[110px]">Status</TableHead>
                    <TableHead className="font-bold text-slate-800 text-[10px] uppercase tracking-widest">Remarks & History</TableHead>
                    <TableHead className="w-[160px] text-right pr-6">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredWarnings.map((ticket) => {
                    const isSelfTarget = ticket.agentId === user.uid;
                    const isPending = ticket.status === 'Pending';

                    const targetUser = allUsers.find(u => u.uid === ticket.agentId);
                    const agentDisplayName = targetUser?.fullName || targetUser?.name || ticket.agentName || 'Corporate Agent';
                    const agentDisplayEmail = targetUser?.email || ticket.agentEmail || 'agent@workforce.co';
                    const agentDisplayEmpId = targetUser?.uid ? `EMP-2026-${targetUser.uid.substring(0, 4).toUpperCase()}` : (ticket.employeeId || 'EMP-360');

                    return (
                      <TableRow key={ticket.id} className="hover:bg-slate-50/50 border-slate-100 group transition-colors">
                        <TableCell className="pl-6">
                          <Badge className={`border px-2 py-0.5 rounded-full font-extrabold text-[10px] shadow-sm ${getLevelColor(ticket.level)}`}>
                            {ticket.level} Notice
                          </Badge>
                          <div className="text-[10px] text-slate-400 font-mono font-medium mt-1">
                            {ticket.createdAt ? new Date(ticket.createdAt).toLocaleDateString() : 'N/A'}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5 py-1">
                            <span className="font-black text-xs text-slate-900">{agentDisplayName}</span>
                            <span className="text-[10px] text-slate-500 font-mono font-medium">{agentDisplayEmail}</span>
                            <span className="text-[9px] text-blue-650 font-bold bg-blue-50/80 px-1.5 py-0.5 rounded border border-blue-105 inline-block w-fit font-mono mt-1">
                              {agentDisplayEmpId}
                            </span>
                            {targetUser && (
                              <div className="mt-1.5 space-y-0.5">
                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">
                                  Process: <span className="text-slate-600">{targetUser.department || targetUser.team || 'N/A'}</span>
                                </p>
                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">
                                  TL: <span className="text-slate-600">{targetUser.teamLeadName || 'Unmapped'}</span>
                                </p>
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge className={`border px-2 py-0.5 rounded-md font-bold text-[10px] ${getSeverityColor(ticket.severity || 'Mild')}`}>
                            {ticket.severity || 'Mild'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={`border px-2 py-0.5 rounded-md font-extrabold text-[10px] ${getStatusColor(ticket.status || 'Pending')}`}>
                            {ticket.status || 'Pending'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1 max-w-[280px]">
                            <p className="text-xs text-slate-650 font-semibold italic leading-relaxed line-clamp-3">
                              "{ticket.remarks}"
                            </p>
                            {ticket.acceptedAt && (
                              <span className="text-[9px] text-slate-400 font-mono font-bold flex items-center gap-1">
                                <CheckCircle size={10} className="text-emerald-500" />
                                Accepted on: {new Date(ticket.acceptedAt).toLocaleString()}
                              </span>
                            )}
                          </div>
                        </TableCell>
                      <TableCell className="text-right pr-6">
                          <div className="flex gap-1 justify-end">
                            {isSelfTarget && isPending && (
                              <Button 
                                size="sm" 
                                className="bg-emerald-650 hover:bg-emerald-700 text-white text-[10px] font-black h-8 px-2.5 rounded-lg shadow-sm cursor-pointer"
                                onClick={() => handleAccept(ticket)}
                              >
                                Accept Warning
                              </Button>
                            )}
                            {isSelfTarget && !isPending && ticket.status === 'Accepted' && (
                              <Button 
                                size="sm" 
                                className="bg-emerald-100 text-emerald-800 text-[10px] font-black h-8 px-2.5 rounded-lg shadow-sm cursor-default flex items-center gap-1"
                                disabled
                              >
                                Accepted <CheckCircle size={12} />
                              </Button>
                            )}
                            {canModifyWarning && (
                                <Button 
                                  size="sm" 
                                  variant="ghost" 
                                  className="text-slate-500 hover:bg-slate-100 h-8 w-8 p-0 cursor-pointer"
                                  onClick={async () => {
                                    const newRemarks = prompt('Edit warning remarks:', ticket.remarks);
                                    if (newRemarks && newRemarks !== ticket.remarks) {
                                      try {
                                        const { doc, updateDoc } = await import('firebase/firestore');
                                        await updateDoc(doc(db, 'disciplinaryLogs', ticket.id), { remarks: newRemarks });
                                        toast.success('Warning updated successfully');
                                        if (onRefresh) onRefresh();
                                      } catch (err: any) {
                                        toast.error(`Update failed: ${err.message}`);
                                      }
                                    }
                                  }}
                                >
                                  <Edit2 size={16} />
                                </Button>
                            )}
                            {canDeleteWarning && (
                                <Button 
                                  size="sm" 
                                  variant="ghost" 
                                  className="text-red-500 hover:bg-red-50 h-8 w-8 p-0 cursor-pointer"
                                  onClick={() => handleDelete(ticket)}
                                >
                                  <Trash2 size={16} />
                                </Button>
                            )}
                          </div>
                      </TableCell>
                      </TableRow>
                    );
                  })}
                  
                  {filteredWarnings.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-24 text-center">
                        <div className="flex flex-col items-center gap-2 opacity-30">
                          <ShieldAlert size={48} strokeWidth={1} />
                          <p className="text-sm font-bold uppercase tracking-widest text-slate-400">No Disciplinary Log Found</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
