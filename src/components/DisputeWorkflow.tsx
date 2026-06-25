import React, { useState } from 'react';
import { MessageSquare, Send, CheckCircle2, RotateCcw, User as UserIcon, Clock } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { toast } from 'sonner';
import { UserRole, AuditRecord, DisputeStatus, DisputeHistory, UserProfile } from '../types';
import { motion, AnimatePresence } from 'motion/react';

interface DisputeWorkflowProps {
  audit: AuditRecord;
  currentUser: { name: string; role: UserRole };
  allUsers?: UserProfile[];
  onUpdate: (updatedAudit: AuditRecord) => void;
}

export default function DisputeWorkflow({ audit, currentUser, allUsers = [], onUpdate }: DisputeWorkflowProps) {
  const [comment, setComment] = useState('');

  const addDisputeStep = (newStatus: DisputeStatus) => {
    if (!comment.trim()) {
      toast.error('Comment is required');
      return;
    }

    const newHistoryEntry: DisputeHistory = {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date().toISOString(),
      userRole: currentUser.role,
      userName: currentUser.name,
      comment: comment.trim()
    };

    const isReopening = currentUser.role === UserRole.AGENT && 
      (audit.disputeStatus === DisputeStatus.QA_REVIEWED || audit.disputeStatus === DisputeStatus.RESOLVED);

    const updatedAudit: AuditRecord = {
      ...audit,
      disputeStatus: newStatus,
      disputeHistory: [...(audit.disputeHistory || []), newHistoryEntry],
      isReopened: isReopening ? true : (currentUser.role === UserRole.QA ? false : (audit.isReopened || false))
    };

    onUpdate(updatedAudit);
    setComment('');
    toast.success(`Dispute status updated: ${newStatus}`);
  };

  const getStatusBadge = (status: DisputeStatus) => {
    switch (status) {
      case DisputeStatus.PENDING: return <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">Pending Review</Badge>;
      case DisputeStatus.QA_REVIEWED: return <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">QA Reviewed</Badge>;
      case DisputeStatus.RESOLVED: return <Badge className="bg-green-100 text-green-700 hover:bg-green-100">Resolved</Badge>;
      default: return <Badge variant="outline">No Dispute</Badge>;
    }
  };

  return (
    <div className="flex flex-col w-full">
      <div className="flex justify-between items-center mb-4 px-1">
        <h3 className="font-bold text-slate-900 flex items-center gap-2">
          <MessageSquare size={18} className="text-blue-600" />
          Dispute Thread
        </h3>
        <div className="flex items-center gap-2">
          {audit.isReopened && (
            <Badge className="bg-orange-100 text-orange-850 hover:bg-orange-100 border border-orange-200 font-extrabold shadow-sm animate-pulse">
              ↺ Re-opened
            </Badge>
          )}
          {getStatusBadge(audit.disputeStatus)}
        </div>
      </div>

      <ScrollArea className="max-h-[240px] overflow-y-auto pr-4 mb-4 border rounded-lg p-4 bg-slate-50/50">
        <div className="space-y-4">
          {(audit.disputeHistory || []).map((step, i) => (
            <motion.div 
              key={step.id}
              initial={{ opacity: 0, x: step.userRole === UserRole.AGENT ? -10 : 10 }}
              animate={{ opacity: 1, x: 0 }}
              className={`flex gap-3 ${step.userRole === UserRole.QA ? 'flex-row-reverse' : ''}`}
            >
              <div className={`p-3 rounded-2xl shadow-sm text-sm ${
                step.userRole === UserRole.QA 
                  ? 'bg-blue-600 text-white rounded-tr-none' 
                  : 'bg-white border rounded-tl-none text-slate-700'
              }`}>
                {step.comment}
              </div>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm overflow-hidden ${
                step.userRole === UserRole.QA ? 'bg-blue-600 text-white' : 'bg-white border text-slate-600'
              }`}>
                {(() => {
                  const p = allUsers.find(u => (u.fullName || u.name || '').toLowerCase().trim() === (step.userName || '').toLowerCase().trim());
                  if (p?.photoURL) return <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />;
                  return <UserIcon size={14} />;
                })()}
              </div>
            </motion.div>
          ))}

          {(!audit.disputeHistory || audit.disputeHistory.length === 0) && (
            <div className="h-64 flex flex-col items-center justify-center text-slate-400 gap-2">
              <MessageSquare size={32} strokeWidth={1} />
              <p className="text-sm">No activity in this dispute thread yet.</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {(audit.disputeStatus !== DisputeStatus.RESOLVED || currentUser.role === UserRole.AGENT) && (
        <div className="space-y-3">
          <textarea
            className="w-full h-24 p-3 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm resize-none"
            placeholder={currentUser.role === UserRole.QA ? "Respond to agent's dispute..." : (audit.disputeStatus === DisputeStatus.RESOLVED ? "Re-raise dispute with new details..." : "Explain why you are disputing...")}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="flex gap-2">
            {currentUser.role === UserRole.AGENT && audit.disputeStatus === DisputeStatus.QA_REVIEWED && (
              <Button 
                variant="outline" 
                className="flex-1 border-green-200 text-green-700 hover:bg-green-50"
                onClick={() => addDisputeStep(DisputeStatus.RESOLVED)}
              >
                <CheckCircle2 size={16} className="mr-2" /> Accept & Resolve
              </Button>
            )}
            
            <Button 
              className="flex-1 bg-blue-600"
              onClick={() => {
                const targetStatus = currentUser.role === UserRole.AGENT 
                  ? DisputeStatus.PENDING 
                  : DisputeStatus.QA_REVIEWED;
                addDisputeStep(targetStatus);
              }}
            >
              <Send size={16} className="mr-2" /> 
              {currentUser.role === UserRole.AGENT && audit.disputeStatus === DisputeStatus.RESOLVED 
                ? "Re-raise Dispute" 
                : (currentUser.role === UserRole.AGENT && audit.disputeStatus === DisputeStatus.QA_REVIEWED)
                ? "Re-open Dispute"
                : (currentUser.role === UserRole.QA ? "Send to Agent" : "Send to QA")}
            </Button>

            {currentUser.role === UserRole.QA && audit.disputeStatus !== DisputeStatus.RESOLVED && (
              <Button 
                variant="outline" 
                className="flex-1 border-green-200 text-green-700 hover:bg-green-50"
                onClick={() => addDisputeStep(DisputeStatus.RESOLVED)}
              >
                <CheckCircle2 size={16} className="mr-2" /> Resolve Directly
              </Button>
            )}
          </div>
        </div>
      )}

      {audit.disputeStatus === DisputeStatus.RESOLVED && currentUser.role !== UserRole.AGENT && (
        <div className="p-4 bg-green-50 border border-green-100 rounded-lg text-center text-green-700 text-sm flex items-center justify-center gap-2">
          <CheckCircle2 size={18} />
          <span>This dispute has been marked as <strong>Resolved</strong>.</span>
        </div>
      )}
    </div>
  );
}
