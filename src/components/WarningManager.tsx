import React, { useState } from 'react';
import { ShieldAlert, AlertTriangle, Info, History, ChevronDown, Check, Search, Send } from 'lucide-react';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { toast } from 'sonner';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, setDoc, addDoc, collection } from 'firebase/firestore';
import { WarningTicket, UserProfile, UserRole } from '../types';
import { UserPicker } from './UserPicker';

interface WarningManagerProps {
  agentName?: string;
  agentId?: string;
  onClose: () => void;
  allUsers?: UserProfile[]; // Optional list of users for selection
}

export default function WarningManager({ agentName: initialName, agentId: initialId, onClose, allUsers = [] }: WarningManagerProps) {
  const [level, setLevel] = useState<'1st' | '2nd' | 'Final' | string>('1st');
  const [remarks, setRemarks] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState(initialId || '');
  const [severity, setSeverity] = useState<'Mild' | 'Moderate' | 'Severe' | 'Critical'>('Mild');
  const [sendEmailNotification, setSendEmailNotification] = useState(true);

  const selectedAgent = allUsers.find(u => u.uid === selectedAgentId) || (initialId ? { name: initialName, uid: initialId } : null);

  // Get current logged-in user profile
  const currentUserProfile = allUsers.find(u => u.uid === auth.currentUser?.uid);

  // Filter eligible targets based on hierarchy
  const getEligibleWarningTargets = (): UserProfile[] => {
    if (!currentUserProfile) return [];

    // Admin can warn anyone except themselves
    if (currentUserProfile.role === UserRole.ADMIN) {
      return allUsers.filter(u => u.uid !== currentUserProfile.uid);
    }

    const isManager = currentUserProfile.role === UserRole.MANAGER;
    if (isManager) {
      // Manager can warn Team Leads, Agents, QAs, SMEs, Trainers, Assistant Managers under their reporting structure
      const managerTargetRoles = [
        UserRole.TEAM_LEAD, UserRole.OPS_TL, UserRole.QTL, UserRole.STL, UserRole.TRAINER_TL,
        UserRole.SME, UserRole.QA, UserRole.TRAINER, UserRole.AGENT
      ] as string[];

      return allUsers.filter(u => {
        if (u.uid === currentUserProfile.uid) return false;
        // Match role or Assistant Manager / AM identifiers
        const roleMatch = managerTargetRoles.includes(u.role) || 
                          u.role.toLowerCase().includes('manager') || 
                          u.role.toLowerCase().includes('am');
        if (!roleMatch) return false;

        // Check structure
        const isDirectReport = u.mappedManagerId === currentUserProfile.uid;
        const isIndirectReport = (() => {
          if (!u.teamLeadId) return false;
          const tl = allUsers.find(item => item.uid === u.teamLeadId);
          return tl ? tl.mappedManagerId === currentUserProfile.uid : false;
        })();

        return isDirectReport || isIndirectReport;
      });
    }

    const isTL = [
      UserRole.TEAM_LEAD, UserRole.OPS_TL, UserRole.QTL, UserRole.STL, UserRole.TRAINER_TL
    ].includes(currentUserProfile.role as UserRole);

    if (isTL) {
      // Team Lead can warn Agents, QAs, SMEs, Trainers mapped under them
      const tlTargetRoles = [
        UserRole.SME, UserRole.QA, UserRole.TRAINER, UserRole.AGENT
      ] as string[];

      return allUsers.filter(u => {
        if (u.uid === currentUserProfile.uid) return false;
        // Match role
        const roleMatch = tlTargetRoles.includes(u.role);
        if (!roleMatch) return false;

        // Check if mapped under their team or direct teamLeadId
        const isMapped = u.teamLeadId === currentUserProfile.uid || 
                         (currentUserProfile.team && u.team === currentUserProfile.team);
        return isMapped;
      });
    }

    return [];
  };

  const eligibleTargets = getEligibleWarningTargets();

  const handleSubmit = async () => {
    if (!selectedAgentId) {
      toast.error('Please select an agent');
      return;
    }
    if (!remarks) {
      toast.error('Remarks are required for issuing a warning');
      return;
    }

    try {
      const fullAgent = allUsers.find(u => u.uid === selectedAgentId);
      if (!fullAgent) {
        toast.error('Details not found in Employee Master for selected personnel.');
        return;
      }
      
      const email = fullAgent.email || '';
      const name = fullAgent.employeeName || fullAgent.fullName || fullAgent.name || 'Unknown';
      const employeeId = fullAgent.employeeId || 'N/A';
      const process = fullAgent.process || 'Commonpool';

      const ticket: WarningTicket = {
        id: `wt-${Date.now()}`,
        agentId: selectedAgentId,
        agentName: name, 
        agentEmail: email,
        employeeId: employeeId,
        process: process,
        qaId: auth.currentUser?.uid || 'unknown',
        level,
        remarks,
        severity,
        status: 'Pending',
        createdAt: new Date().toISOString(),
        history: [
          {
            action: `Warning raised by Supervisor`,
            timestamp: new Date().toISOString()
          }
        ]
      };
      
      const docRef = doc(db, 'disciplinaryLogs', ticket.id);
      await setDoc(docRef, ticket);

      const nowISO = new Date().toISOString();
      const performerName = currentUserProfile 
        ? `${currentUserProfile.fullName || currentUserProfile.name || currentUserProfile.email}`
        : (auth.currentUser?.email || 'System Admin');

      // 1. Audit Log: Warning Issued
      await addDoc(collection(db, 'adminAuditLogs'), {
        timestamp: nowISO,
        action: 'Warning Issued',
        performedBy: performerName + ` (${auth.currentUser?.email || ''})`,
        affectedUser: `${name} (${email})`,
        previousValue: 'None',
        newValue: `Level: ${level}, Severity: ${severity}`,
        remarks: remarks,
        details: {
          ticketId: ticket.id,
          employeeId: employeeId,
          level,
          severity
        }
      });

      // 2. Audit Log & Simulating email if checked
      const emailText = `
DEAR ${name.toUpperCase()} (ID: ${employeeId}),

This is an automated notification regarding a disciplinary action issued against you under the Staircase Policy.

DETAILS OF THE WARNING TICKET:
------------------------------------------
Level of Warning: ${level} Notice
Severity Level: ${severity}
Reason / Remarks: ${remarks}
Issued By: ${performerName}
Date & Time issued: ${new Date(nowISO).toLocaleString()}

ACKNOWLEDGEMENT REQUIREMENT:
You are strictly required to log in to the Precision360 compliance dashboard immediately to review and formally acknowledge/accept this warning ticket.

------------------------------------------
CC Checklist:
- Reporting Team Lead
- Reporting Manager
- HR Operations (hr@bergtechnologies.co.in)
      `;

      if (sendEmailNotification) {
        // Log "Email Sent" in audit logs
        await addDoc(collection(db, 'adminAuditLogs'), {
          timestamp: nowISO,
          action: 'Email Sent',
          performedBy: performerName + ` (${auth.currentUser?.email || ''})`,
          affectedUser: `${name} (${email})`,
          previousValue: 'None',
          newValue: 'Email Triggered = Yes',
          remarks: `Subject: Disciplinary Warning Issued - To: ${email} | CC: hr@bergtechnologies.co.in`,
          emailDetails: {
            to: email,
            sender: auth.currentUser?.email,
            subject: 'Automated Disciplinary Warning Notification',
            body: emailText,
            timestamp: nowISO
          }
        });
        toast.success(`Warning issued and notification email dispatched to ${name} and HR successfully!`);
      } else {
        // Log "Email Skipped" in audit logs
        await addDoc(collection(db, 'adminAuditLogs'), {
          timestamp: nowISO,
          action: 'Email Skipped',
          performedBy: performerName + ` (${auth.currentUser?.email || ''})`,
          affectedUser: `${name} (${email})`,
          previousValue: 'None',
          newValue: 'Email Triggered = No',
          remarks: 'Email notification bypassed by supervisor choice.',
          emailDetails: {
            to: email,
            sender: auth.currentUser?.email,
            timestamp: nowISO
          }
        });
        toast.success(`${level} Warning successfully issued in system (email skipped).`);
      }
      
      onClose();
    } catch (e) {
      console.error("Warning ticket submission failed:", e);
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to issue warning: ${errMsg}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-red-50 border border-red-100 p-4 rounded-lg flex flex-col gap-3">
        <div className="flex gap-3">
          <ShieldAlert className="text-red-600 shrink-0" size={20} />
          <div>
            <h4 className="text-sm font-bold text-red-900">Warning Ticket Issuance</h4>
            <p className="text-xs text-red-700">This action will be logged and visible to Admin and Team Lead.</p>
          </div>
        </div>
        <a 
          href="https://docs.google.com/document/d/1zAu2KCCUfOFBA8-nopnc1YRNycaDhCtRPfI7CIgFl7Y/edit?tab=t.ttcgryfeyu7#heading=h.ra63ci5w7hx3" 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-[10px] font-bold text-blue-600 hover:underline flex items-center gap-1 mt-1"
        >
          <History size={12} /> View Staircase Policy Reference
        </a>
      </div>

      <div className="space-y-4">
        {/* Target selection */}
        <div className="space-y-1 relative">
          {!initialId ? (
            <UserPicker 
              label="Target Employee/Supervisor"
              onSelect={(u) => setSelectedAgentId(u.uid)}
              selectedUserId={selectedAgentId}
              placeholder="Search employee to warn..."
              roleFilter={eligibleTargets.map(u => u.role)}
            />
          ) : (
            <div className="space-y-1">
              <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">Target Employee/Supervisor</Label>
              <div className="p-3 bg-slate-50 rounded border border-slate-200 mt-1">
                 <p className="font-bold">{initialName}</p>
                 <p className="text-xs text-slate-500">ID: {initialId}</p>
              </div>
            </div>
          )}
        </div>

        <Separator className="my-4" />

        <div className="space-y-3">
          <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">Select Warning Level</Label>
          <div className="grid grid-cols-3 gap-4">
            <button
              type="button"
              onClick={() => setLevel('1st')}
              className={`flex items-center space-x-2 p-2.5 rounded-lg border transition-all text-left cursor-pointer ${
                level === '1st'
                  ? 'bg-red-50 border-red-500 text-red-950 font-bold ring-2 ring-red-200'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <div className={`size-4 rounded-full border flex items-center justify-center shrink-0 ${
                level === '1st' ? 'border-red-600 bg-red-600' : 'border-slate-300'
              }`}>
                {level === '1st' && <div className="size-1.5 rounded-full bg-white" />}
              </div>
              <span className="font-bold select-none w-full text-xs">1st Warning</span>
            </button>

            <button
              type="button"
              onClick={() => setLevel('2nd')}
              className={`flex items-center space-x-2 p-2.5 rounded-lg border transition-all text-left cursor-pointer ${
                level === '2nd'
                  ? 'bg-red-50 border-red-500 text-red-950 font-bold ring-2 ring-red-200'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <div className={`size-4 rounded-full border flex items-center justify-center shrink-0 ${
                level === '2nd' ? 'border-red-600 bg-red-600' : 'border-slate-300'
              }`}>
                {level === '2nd' && <div className="size-1.5 rounded-full bg-white" />}
              </div>
              <span className="font-bold select-none w-full text-xs">2nd Warning</span>
            </button>

            <button
              type="button"
              onClick={() => setLevel('Final')}
              className={`flex items-center space-x-2 p-2.5 rounded-lg border transition-all text-left cursor-pointer ${
                level === 'Final'
                  ? 'bg-red-50 border-red-500 text-red-950 font-bold ring-2 ring-red-200'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <div className={`size-4 rounded-full border flex items-center justify-center shrink-0 ${
                level === 'Final' ? 'border-red-600 bg-red-600' : 'border-slate-300'
              }`}>
                {level === 'Final' && <div className="size-1.5 rounded-full bg-white" />}
              </div>
              <span className="font-bold select-none w-full text-xs">Final Notice</span>
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">Select Severity Level</Label>
          <div className="grid grid-cols-4 gap-2">
            {(['Mild', 'Moderate', 'Severe', 'Critical'] as const).map((sev) => {
              const active = severity === sev;
              const activeColors = 
                sev === 'Mild' ? 'bg-blue-50 border-blue-500 text-blue-950 ring-2 ring-blue-100' :
                sev === 'Moderate' ? 'bg-amber-50 border-amber-500 text-amber-950 ring-2 ring-amber-100' :
                sev === 'Severe' ? 'bg-orange-50 border-orange-500 text-orange-950 ring-2 ring-orange-100' :
                'bg-red-50 border-red-500 text-red-950 ring-2 ring-red-100';

              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setSeverity(sev)}
                  className={`p-2 rounded-lg border text-center font-bold text-xs transition-all cursor-pointer ${
                    active ? activeColors : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {sev}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">Reason / Remarks</Label>
          <textarea 
            className="w-full h-24 p-3 rounded-lg border border-slate-200 focus:ring-2 focus:ring-red-500 focus:outline-none text-sm text-slate-900 bg-white shadow-inner"
            placeholder="Detailed explanation for the warning ticket..."
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
          ></textarea>
        </div>

        {/* Email Notification Checkbox */}
        <div className="flex items-center gap-2 pt-3 pb-2 bg-red-50/40 border border-red-100/50 rounded-xl px-4 mt-2">
          <input
            type="checkbox"
            id="sendEmailNotificationWarn"
            checked={sendEmailNotification}
            onChange={(e) => setSendEmailNotification(e.target.checked)}
            className="h-4 w-4 rounded border-red-300 text-red-650 focus:ring-red-500 cursor-pointer"
          />
          <Label htmlFor="sendEmailNotificationWarn" className="text-xs font-bold text-red-950 cursor-pointer select-none">
            Send Email Notification to Employee & Reporting Hierarchy
          </Label>
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t pt-4">
        <Button variant="ghost" className="font-bold text-slate-600 hover:bg-[#F1F5F9]" onClick={onClose}>Cancel</Button>
        <Button className="bg-red-600 hover:bg-red-700 text-white font-bold px-6 flex items-center gap-1.5" onClick={handleSubmit}>
          <Send size={14} /> Issue Ticket
        </Button>
      </div>
    </div>
  );
}
