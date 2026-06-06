import React, { useMemo, useState } from 'react';
import { ShieldAlert, AlertTriangle, MessageCircle } from 'lucide-react';
import { usePermission } from '../components/PermissionContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { AuditRecord, DisputeStatus, UserProfile, UserRole } from '../types';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { updateDoc, doc, arrayUnion, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { toast } from 'sonner';

interface DisputesViewProps {
  auditLogs: AuditRecord[];
  user: UserProfile;
  onEditAudit?: (audit: AuditRecord) => void;
  onRefresh?: () => void;
}

export default function DisputesView({ auditLogs, user, onEditAudit, onRefresh }: DisputesViewProps) {
  const [filter, setFilter] = useState<'All' | 'Pending' | 'Active' | 'Resolved'>('Pending');
  const [selectedDispute, setSelectedDispute] = useState<AuditRecord | null>(null);
  const [actionComment, setActionComment] = useState('');
  const { canEdit: canReviewDispute } = usePermission();
  const canEditScoring = canReviewDispute('KPI Scorecard'); // Approximation for quality management
  const isManagement = canReviewDispute('KPI Scorecard'); // Proxy for review actions

  const disputes = useMemo(() => {
    let filtered = auditLogs.filter(log => log.disputeStatus !== DisputeStatus.NONE);
    
    // Default "All" view should only show non-resolved if user wants "only active"
    if (filter === 'All') {
      filtered = filtered.filter(l => l.disputeStatus !== DisputeStatus.RESOLVED);
    } else if (filter === 'Pending') {
      filtered = filtered.filter(l => l.disputeStatus === DisputeStatus.PENDING);
    } else if (filter === 'Active') {
      filtered = filtered.filter(l => l.disputeStatus === DisputeStatus.QA_REVIEWED);
    } else if (filter === 'Resolved') {
      filtered = filtered.filter(l => l.disputeStatus === DisputeStatus.RESOLVED);
    }
    
    return filtered;
  }, [auditLogs, filter]);

  const handleAction = async (action: 'Deny' | 'Partial' | 'Full' | 'BOD' | 'Comment') => {
    if (!selectedDispute) return;

    if (!actionComment.trim()) {
      toast.error('A comment is required for all dispute decisions and actions.');
      return;
    }

    try {
      let newStatus: DisputeStatus;
      if (action === 'Comment' || action === 'Deny') {
        newStatus = DisputeStatus.QA_REVIEWED;
      } else {
        newStatus = DisputeStatus.RESOLVED;
      }

      await updateDoc(doc(db, 'audits', selectedDispute.id), {
        disputeStatus: newStatus,
        isReopened: false,
        disputeHistory: arrayUnion({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          userRole: user.role,
          userName: user.name,
          comment: action !== 'Comment' ? `Action: ${action}. Comment: ${actionComment}` : actionComment
        })
      });
      toast.success(action === 'Comment' ? 'Comment added.' : `Dispute ${action}ed successfully.`);
      setSelectedDispute(null);
      setActionComment('');
      if (onRefresh) {
        onRefresh();
      }
    } catch (error) {
      toast.error('Failed to update dispute');
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Pending Disputes</h2>
      
      <div className="flex gap-2">
        {['All', 'Pending', 'Active', 'Resolved'].map(f => (
          <Button key={f} variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f as any)}>
            {f} Disputes
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Disputed Audits</CardTitle>
          <CardDescription>Review audits with active disputes ({disputes.length})</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task ID</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>QA / TL</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Latest Comment</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {disputes.map((audit) => (
                <TableRow key={audit.id}>
                  <TableCell className="font-mono font-bold text-blue-600">{audit.taskId}</TableCell>
                  <TableCell>{audit.agentId}</TableCell>
                  <TableCell>{audit.qvName}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 items-center">
                      <Badge variant={audit.disputeStatus === DisputeStatus.PENDING ? 'outline' : 'secondary'}>
                        {audit.disputeStatus}
                      </Badge>
                      {audit.isReopened && (
                        <Badge className="bg-orange-100 text-orange-850 hover:bg-orange-100 border border-orange-200 font-extrabold shadow-sm animate-pulse text-[10px]">
                          ↺ Re-opened
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {audit.disputeHistory && audit.disputeHistory.length > 0
                      ? audit.disputeHistory[audit.disputeHistory.length - 1]?.comment || 'No comment'
                      : 'No comment'}
                  </TableCell>
                  <TableCell>
                    <Dialog>
                      <DialogTrigger 
                        render={
                          <Button variant="ghost" onClick={() => setSelectedDispute(audit)}>
                            Review
                          </Button>
                        }
                      />
                      <DialogContent className="max-w-2xl">
                        <DialogHeader>
                          <DialogTitle className="flex justify-between items-center pr-6">
                            <span className="flex items-center gap-2">
                              Dispute Thread - {audit.taskId}
                              {audit.isReopened && (
                                <Badge className="bg-orange-100 text-orange-850 hover:bg-orange-100 border border-orange-200 font-extrabold text-[10px]">
                                  ↺ Re-opened
                                </Badge>
                              )}
                            </span>
                          </DialogTitle>
                        </DialogHeader>
                        
                        <div className="space-y-4 max-h-[400px] overflow-y-auto p-2 border rounded bg-slate-50">
                          {(audit.disputeHistory || []).map((h) => (
                            <div key={h.id} className={`p-3 rounded-lg border ${h.userRole === UserRole.AGENT ? 'bg-blue-50 border-blue-100 ml-4' : 'bg-white border-slate-200 mr-4'}`}>
                              <div className="flex justify-between items-center mb-1">
                                <span className="text-xs font-bold text-slate-900">{h.userName} ({h.userRole})</span>
                                <span className="text-[10px] text-slate-500">
                                  {h.timestamp ? new Date(h.timestamp).toLocaleString() : ''}
                                </span>
                              </div>
                              <p className="text-sm text-slate-700">{h.comment}</p>
                            </div>
                          ))}
                        </div>

                        <div className="space-y-2 mt-4">
                          <Input 
                            value={actionComment} 
                            onChange={(e) => setActionComment(e.target.value)} 
                            placeholder="Provide your remarks here..." 
                          />
                          {canEditScoring && (
                            <div className="flex gap-2">
                              {onEditAudit && (
                                <Button 
                                  variant="secondary" 
                                  onClick={() => {
                                    onEditAudit(audit);
                                  }}
                                  className="gap-2"
                                >
                                  <ShieldAlert size={16} /> Edit Scoring
                                </Button>
                              )}
                              <Button variant="outline" onClick={() => handleAction('Comment')}>Post Comment</Button>
                            </div>
                          )}
                        </div>

                        <DialogFooter className="mt-4 flex flex-wrap gap-2 sm:justify-start">
                          {isManagement && (
                            <>
                              <Button variant="destructive" onClick={() => handleAction('Deny')}>Deny</Button>
                              <Button variant="outline" onClick={() => handleAction('Partial')}>Partial Revert</Button>
                              <Button variant="outline" onClick={() => handleAction('Full')}>Full Revert</Button>
                              <Button variant="secondary" onClick={() => handleAction('BOD')}>BOD</Button>
                            </>
                          )}
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
