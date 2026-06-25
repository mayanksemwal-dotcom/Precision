import React, { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  Search, 
  Filter, 
  Plus, 
  CheckCircle, 
  Clock, 
  User as UserIcon,
  Calendar,
  ChevronRight,
  TrendingDown,
  Activity,
  Award,
  BookOpen,
  CheckSquare,
  AlertTriangle,
  FileText,
  UserCheck,
  Send,
  CalendarClock
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Label } from '../components/ui/label';
import { PipRecord, UserRole, UserProfile } from '../types';
import { UserPicker } from '../components/UserPicker';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={`flex min-h-[80px] w-full rounded-md border border-slate-200 bg-[#FAFAFA] px-3 py-2 text-xs placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, setDoc, updateDoc, collection, addDoc, onSnapshot, query, where, orderBy, getDocs, serverTimestamp, getDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { usePermission } from '../components/PermissionContext';
import { canActOn, normalizeRole } from '../lib/hierarchy';
import { sendEmailViaGmailApi } from '../lib/gmailService';
import { triggerEmail } from '../lib/emailTrigger';

interface PipViewProps {
  user: UserProfile;
  allUsers: UserProfile[];
  externalTheme?: 'light' | 'dark';
}

export default function PipView({ user, allUsers = [], externalTheme }: PipViewProps) {
  const { canCreate, canEdit, canDelete, canApprove } = usePermission();
  const [pips, setPips] = useState<PipRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [selectedPip, setSelectedPip] = useState<PipRecord | null>(null);
  const [sendEmailNotification, setSendEmailNotification] = useState(true);

  // Filter eligible targets based on real-time allUsers and hierarchal permissions
  const eligiblePipTargets = React.useMemo(() => {
    const actorRole = normalizeRole(user.role);
    const isSupervisor = [
      UserRole.ADMIN,
      UserRole.MANAGER,
      UserRole.OPS_HEAD,
      UserRole.HR,
      UserRole.IT_MANAGER,
      UserRole.TEAM_LEAD,
      UserRole.OPS_TL,
      UserRole.QTL,
      UserRole.STL,
      UserRole.TRAINER_TL,
      UserRole.SME
    ].includes(actorRole);

    if (!isSupervisor) return [];

    // All supervisor roles can see and act on any other user in the PIP dropdown
    return allUsers.filter(u => u.uid !== user.uid);
  }, [user, allUsers]);

  const getTodayYmd = () => new Date().toISOString().slice(0, 10);
  const getThirtyDaysAheadYmd = () => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  };

  // New PIP Form state
  const [isNewPipOpen, setIsNewPipOpen] = useState(false);
  const [newPipForm, setNewPipForm] = useState({
    agentId: '',
    title: 'Performance Improvement Plan',
    description: '',
    startDate: getTodayYmd(),
    endDate: getThirtyDaysAheadYmd(),
    qualityTarget: 98,
    attendanceTarget: 95,
    productivityTarget: 100,
    coachingSupportPlan: '',
  });

  // New Check-in Form state
  const [isAddCheckinOpen, setIsAddCheckinOpen] = useState(false);
  const [checkinForm, setCheckinForm] = useState({
    metricsAssessment: '',
    actionItems: '',
  });

  // Agent feedback state
  const [agentComment, setAgentComment] = useState('');
  const [submittingAcknowledge, setSubmittingAcknowledge] = useState(false);

  // Read real-time subscriptions for PIP Records
  useEffect(() => {
    setLoading(true);
    let q = query(collection(db, 'pips'), orderBy('createdAt', 'desc'));
    
    // For regular agents, filter initially or do client-side filtering. Let's do client-side to keep rule setups simple or use queries
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const records = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as PipRecord));
      setPips(records);
      setLoading(false);
    }, (error) => {
      console.error("Firestore listening error for pips:", error);
      handleFirestoreError(error, OperationType.LIST, 'pips');
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const canIssuePip = canCreate('PIP Management');
  const canModifyPip = canEdit('PIP Management');
  const canDeletePip = canDelete('PIP Management');
  const canApprovePip = canApprove('PIP Management');
  const canManagePip = canModifyPip || canIssuePip;

  // Filter & Search Logic
  const filteredPips = pips.filter(p => {
    // 1. Visibility check: 
    // Is it my own PIP?
    const isMine = p.agentId === user.uid;

    // Am I the initiator who created this PIP?
    const isInitiator = p.initiatorId === user.uid;
    
    // Is it someone I supervise?
    const targetUser = allUsers.find(u => u.uid === p.agentId);
    const isSubordinate = targetUser ? canActOn(user, targetUser, allUsers) : false;

    if (!isMine && !isSubordinate && !isInitiator) return false;

    // 2. Status Filter
    if (statusFilter !== 'All' && p.status !== statusFilter) return false;

    // 3. Search target
    const term = searchTerm.toLowerCase().trim();
    if (!term) return true;
    return (
      p.agentName?.toLowerCase().includes(term) ||
      p.agentEmail?.toLowerCase().includes(term) ||
      p.title?.toLowerCase().includes(term) ||
      p.initiatorName?.toLowerCase().includes(term)
    );
  });

  // Initialize PIP
  const handleCreatePip = async () => {
    if (!newPipForm.agentId) {
      toast.error("Please select an employee/agent first.");
      return;
    }
    if (!newPipForm.description.trim()) {
      toast.error("Please specify details or reason for the PIP program.");
      return;
    }
    if (!newPipForm.coachingSupportPlan.trim()) {
      toast.error("Please document the coaching/support plan.");
      return;
    }

    try {
      const targetAgent = allUsers.find(u => u.uid === newPipForm.agentId);
      if (!targetAgent) {
        toast.error("Employee record not found in Employee Master.");
        return;
      }

      const pipId = `pip-${Date.now()}`;
      
      const s = new Date(newPipForm.startDate);
      const e = new Date(newPipForm.endDate);
      const diffTime = e.getTime() - s.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const calculatedDurationDays = isNaN(diffDays) || diffDays < 0 ? 0 : diffDays;

      const pipRecord: PipRecord = {
        id: pipId,
        agentId: targetAgent.uid,
        agentName: targetAgent.employeeName || targetAgent.fullName || targetAgent.name || 'Unknown',
        agentEmail: targetAgent.email || '',
        employeeId: targetAgent.employeeId || 'N/A',
        process: targetAgent.process || 'Commonpool',
        initiatorId: user.uid,
        initiatorName: user.fullName || user.name || user.email,
        title: newPipForm.title,
        description: newPipForm.description,
        startDate: newPipForm.startDate,
        endDate: newPipForm.endDate,
        durationDays: calculatedDurationDays,
        qualityTarget: Number(newPipForm.qualityTarget),
        attendanceTarget: Number(newPipForm.attendanceTarget),
        productivityTarget: Number(newPipForm.productivityTarget),
        status: 'Initiated',
        coachingSupportPlan: newPipForm.coachingSupportPlan,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        checkins: [],
        acknowledgedByAgent: false
      };

      await setDoc(doc(db, 'pips', pipId), pipRecord);
      
      const nowISO = new Date().toISOString();
      const performerName = `${user.fullName || user.name || user.email}`;

      // 1. Audit Log: PIP Initiated
      await addDoc(collection(db, 'adminAuditLogs'), {
        timestamp: nowISO,
        action: 'PIP Initiated',
        performedBy: `${performerName} (${user.email})`,
        affectedUser: `${targetAgent.name} (${targetAgent.email})`,
        previousValue: 'None',
        newValue: 'Initiated',
        remarks: `Initiated PIP plan: "${newPipForm.title}". Observation Period: ${newPipForm.startDate} to ${newPipForm.endDate}. Targets: QA Score: ${newPipForm.qualityTarget}%, Attendance: ${newPipForm.attendanceTarget}%, Cases: ${newPipForm.productivityTarget}`,
        details: {
          pipId,
          startDate: newPipForm.startDate,
          endDate: newPipForm.endDate,
          targets: {
            quality: newPipForm.qualityTarget,
            attendance: newPipForm.attendanceTarget,
            productivity: newPipForm.productivityTarget
          }
        }
      });

      // 2. Automated Trigger Email Simulation
      if (sendEmailNotification) {
        let finalTo = targetAgent.email || '';
        let finalCc = ['hr@bergtechnologies.co.in'];
        const fromEmail = user.email || '';

        // Default reporting level cc: only HR as per user request
        const defaultCc = ['hr@bergtechnologies.co.in'];
        finalCc = defaultCc;

        // Query database configuration
        try {
          const notifSnap = await getDoc(doc(db, 'config', 'notificationSettings'));
          if (notifSnap.exists()) {
            const conf = notifSnap.data();
            if (conf.pipToMode === 'custom' && conf.pipToCustom) {
              finalTo = conf.pipToCustom;
            } else {
              finalTo = targetAgent.email || '';
            }

            let ccAddresses: string[] = [];
            if (conf.pipCc) {
              ccAddresses = conf.pipCc.split(',').map((s: string) => s.trim()).filter(Boolean);
            } else {
              ccAddresses = ['hr@bergtechnologies.co.in'];
            }

            if (conf.pipIncludeTlCc === true) {
              if (targetAgent.teamLeadId) {
                const tlObj = allUsers.find(u => u.uid === targetAgent.teamLeadId);
                const tlEmail = tlObj ? tlObj.email : `${targetAgent.teamLeadId}@bergtechnologies.co.in`;
                if (!ccAddresses.includes(tlEmail)) ccAddresses.push(tlEmail);
              }
            }

            if (conf.pipIncludeManagerCc === true) {
              if (targetAgent.mappedManagerId) {
                const mgrObj = allUsers.find(u => u.uid === targetAgent.mappedManagerId);
                const mgrEmail = mgrObj ? mgrObj.email : `${targetAgent.mappedManagerId}@bergtechnologies.co.in`;
                if (!ccAddresses.includes(mgrEmail)) ccAddresses.push(mgrEmail);
              }
            }
            finalCc = ccAddresses;
          }
        } catch (err) {
          console.warn("Failed to load PIP notification settings, using defaults.", err);
        }

        const reportingLineCC = finalCc; // Alias back for rendering below

        const emailSubject = `[URGENT] Performance Improvement Plan Initiated - ${targetAgent.name}`;
        const emailBody = `
Dear ${targetAgent.name},

Please be advised that a Performance Improvement Plan (PIP) has been initiated for you by your Team Lead/Manager, ${performerName}, on ${new Date().toLocaleDateString()}.

PROSPECTS & PLAN DETAILS:
- Title: ${newPipForm.title}
- Gaps Identified: ${newPipForm.description}
- Coaching & Support Schedule: ${newPipForm.coachingSupportPlan}
- Observation Period: ${newPipForm.startDate} to ${newPipForm.endDate} (${calculatedDurationDays} Calendar Days)

OBSERVATION KEY PERFORMANCE STANDARDS:
- Target QA Quality Score: ${newPipForm.qualityTarget}%
- Target Attendance standard: ${newPipForm.attendanceTarget}%
- Target Productivity cases: ${newPipForm.productivityTarget} cases

Please review and officially acknowledge this plan in your Coaching & Excellence Bureau portal.

Sincerely,
System Automatons
Berg Technologies Corp HS Division
(CC: HR Executive Desk, Operational Managers, and Direct Team Leads)
        `.trim();

        // Audit Log: Email Sent
        await addDoc(collection(db, 'adminAuditLogs'), {
          timestamp: nowISO,
          action: 'Email Sent',
          performedBy: `${performerName} (${user.email})`,
          affectedUser: `${targetAgent.name} (${targetAgent.email})`,
          previousValue: 'N/A',
          newValue: `Recipient: ${finalTo}`,
          remarks: `Automated PIP initiation notification email sent. Status: Dispatch simulated successfully.`,
          details: {
            to: finalTo,
            cc: reportingLineCC,
            subject: emailSubject,
            body: emailBody
          }
        });

        // Write email queue documents for Trigger Email from Firestore extension
        const emailPayload = {
          to: finalTo,
          cc: reportingLineCC,
          message: {
            subject: emailSubject,
            text: emailBody,
            html: `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px;">
                <h2 style="color: #4f46e5; margin-top: 0;">Performance Improvement Plan (PIP) Initiated</h2>
                <p>Dear <strong>${targetAgent.name}</strong>,</p>
                <p>Please be advised that a Performance Improvement Plan (PIP) has been initiated for you by your Team Lead/Manager, <strong>${performerName}</strong>, on ${new Date().toLocaleDateString()}.</p>
                
                <h3 style="border-bottom: 2px solid #e2e8f0; padding-bottom: 5px; color: #1e3a8a;">Prospects & Plan Details</h3>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                  <tr>
                    <td style="padding: 8px; font-weight: bold; width: 180px; background-color: #f8fafc; border: 1px solid #e2e8f0;">Title:</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${newPipForm.title}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px; font-weight: bold; background-color: #f8fafc; border: 1px solid #e2e8f0;">Gaps Identified:</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${newPipForm.description}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px; font-weight: bold; background-color: #f8fafc; border: 1px solid #e2e8f0;">Coaching Support Plan:</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${newPipForm.coachingSupportPlan || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px; font-weight: bold; background-color: #f8fafc; border: 1px solid #e2e8f0;">Observation Period:</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${newPipForm.startDate} to ${newPipForm.endDate} (${calculatedDurationDays} Calendar Days)</td>
                  </tr>
                </table>

                <h3 style="border-bottom: 2px solid #e2e8f0; padding-bottom: 5px; color: #1e3a8a;">Observation Key Performance Standards</h3>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                  <tr>
                    <td style="padding: 8px; font-weight: bold; width: 180px; background-color: #f8fafc; border: 1px solid #e2e8f0;">Target QA Quality Score:</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold; color: #4f46e5;">${newPipForm.qualityTarget}%</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px; font-weight: bold; background-color: #f8fafc; border: 1px solid #e2e8f0;">Target Attendance Standard:</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold; color: #4f46e5;">${newPipForm.attendanceTarget}%</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px; font-weight: bold; background-color: #f8fafc; border: 1px solid #e2e8f0;">Target Productivity Cases:</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold; color: #4f46e5;">${newPipForm.productivityTarget} cases</td>
                  </tr>
                </table>

                <div style="background-color: #e0e7ff; border-left: 4px solid #4f46e5; padding: 15px; margin-bottom: 20px; border-radius: 4px;">
                  <h4 style="margin: 0 0 5px 0; color: #3730a3;">Review Required</h4>
                  <p style="margin: 0; font-size: 14px;">Please review and officially acknowledge this plan in your Coaching & Excellence Bureau portal.</p>
                </div>

                <p style="font-size: 12px; color: #64748b; margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                  This is a system generated email CC'd to: ${reportingLineCC.join(', ')}
                </p>
              </div>
            `
          },
          metadata: {
            pipId,
            agentId: targetAgent.uid,
            initiator: performerName
          }
        };

        const emailTriggerResult = await triggerEmail(emailPayload);
        if (emailTriggerResult.success) {
          console.log("Successfully triggered PIP email via Firestore extension");
        } else {
          console.warn("Failed to trigger email via Firestore:", emailTriggerResult.error);
        }

        // Direct Gmail REST API sending logic as secondary
        try {
          const mailConfig = {
            to: finalTo,
            cc: reportingLineCC,
            subject: emailSubject,
            bodyText: emailBody,
            bodyHtml: emailPayload.message.html,
            fromEmail: fromEmail || 'compliance@bergtechnologies.co.in'
          };
          const gmailResult = await sendEmailViaGmailApi(mailConfig);
          if (gmailResult.success) {
            toast.success(`Automated notification email dispatched directly through your Gmail!`);
          } else {
            toast.success(`Automated notification email queued in Firestore extension!`);
          }
        } catch (gmailErr: any) {
          console.error('Failed to trigger Gmail API wrapper:', gmailErr);
          toast.success(`Automated notification email queued in Firestore extension!`);
        }
      } else {
        // Audit Log: Email Skipped
        await addDoc(collection(db, 'adminAuditLogs'), {
          timestamp: nowISO,
          action: 'Email Skipped',
          performedBy: `${performerName} (${user.email})`,
          affectedUser: `${targetAgent.name} (${targetAgent.email})`,
          previousValue: 'N/A',
          newValue: 'Skipped',
          remarks: `User opted out of sending automated PIP notification email`
        });
        toast.info("Automated email notification suppressed by initiator.");
      }

      toast.success(`Successfully pre-provisioned PIP plan for ${targetAgent.name}`);
      setIsNewPipOpen(false);
      
      // Reset form
      setNewPipForm({
        agentId: '',
        title: 'Performance Improvement Plan',
        description: '',
        startDate: getTodayYmd(),
        endDate: getThirtyDaysAheadYmd(),
        qualityTarget: 98,
        attendanceTarget: 95,
        productivityTarget: 100,
        coachingSupportPlan: '',
      });
    } catch (err: any) {
      toast.error("Failed to save PIP record: " + err.message);
    }
  };

  // Add Milestone Check-in (Weekly Reviews)
  const handleAddCheckin = async () => {
    if (!selectedPip) return;
    if (!checkinForm.metricsAssessment.trim()) {
      toast.error("Please add assessment comments.");
      return;
    }

    console.log({
      userEmail: user.email,
      userRole: user.role,
      collection: 'pips',
      documentId: selectedPip.id,
      operation: 'UPDATE'
    });

    try {
      const checkpointYmd = new Date().toISOString().slice(0, 10);
      const newCheckinId = `checkin-${Date.now()}`;
      
      const updatedCheckins = [
        ...(selectedPip.checkins || []),
        {
          id: newCheckinId,
          checkinDate: checkpointYmd,
          reviewerName: user.name,
          metricsAssessment: checkinForm.metricsAssessment.trim(),
          actionItems: checkinForm.actionItems.trim() || 'Keep monitoring current metrics',
          agentComments: '',
          acknowledgedByAgent: false,
        }
      ];

      const nowISO = new Date().toISOString();
      await updateDoc(doc(db, 'pips', selectedPip.id), {
        checkins: updatedCheckins,
        status: 'Under Review', // Automatically transition status on first check-in
        updatedAt: nowISO
      });

      // Audit log: Milestone update
      await addDoc(collection(db, 'adminAuditLogs'), {
        timestamp: nowISO,
        action: 'PIP Updated',
        performedBy: `${user.fullName || user.name || user.email} (${user.email})`,
        affectedUser: `${selectedPip.agentName} (${selectedPip.agentEmail})`,
        previousValue: selectedPip.status,
        newValue: 'Under Review',
        remarks: `Recorded milestone check-in review: "${checkinForm.metricsAssessment.trim()}". Action items: "${checkinForm.actionItems.trim() || 'Keep monitoring current metrics'}"`,
        details: {
          pipId: selectedPip.id,
          type: 'Milestone Check-in'
        }
      });

      // Update state local for continuous detail view
      const freshPipObj = {
        ...selectedPip,
        checkins: updatedCheckins,
        status: 'Under Review' as const
      };
      setSelectedPip(freshPipObj);
      
      toast.success("Milestone review check-in recorded successfully!");
      setIsAddCheckinOpen(false);
      setCheckinForm({ metricsAssessment: '', actionItems: '' });
    } catch (err: any) {
      console.error({
          firestoreError: err.message,
          collection: 'pips',
          documentId: selectedPip.id,
          userRole: user.role,
          uid: user.uid
      });
      toast.error("Failed to log review: " + err.message);
    }
  };


  // Agent check-in specific acknowledgement with comments
  const handleAgentAcknowledgeCheckin = async (checkinId: string) => {
    if (!selectedPip) return;
    if (!agentComment.trim()) {
      toast.error("Please type your review comments or feelings before acknowledging.");
      return;
    }

    console.log({
      userEmail: user.email,
      userRole: user.role,
      collection: 'pips',
      documentId: selectedPip.id,
      operation: 'UPDATE'
    });

    try {
      const updated = (selectedPip.checkins || []).map(ch => {
        if (ch.id === checkinId) {
          return {
            ...ch,
            agentComments: agentComment.trim(),
            acknowledgedByAgent: true,
            acknowledgedAt: new Date().toLocaleString()
          };
        }
        return ch;
      });

      await updateDoc(doc(db, 'pips', selectedPip.id), {
        checkins: updated,
        updatedAt: new Date().toISOString()
      });

      setSelectedPip(prev => prev ? { ...prev, checkins: updated } : null);
      setAgentComment('');
      toast.success("Milestone signature recorded! Feedback sent to team lead.");
    } catch (err: any) {
      console.error({
          firestoreError: err.message,
          collection: 'pips',
          documentId: selectedPip.id,
          userRole: user.role,
          uid: user.uid
      });
      toast.error("Failed to sign milestone: " + err.message);
    }
  };

  // Complete/Graduate/Extend PIP
  const handleUpdatePipStatus = async (newStatus: 'Passed' | 'Failed' | 'Extended', comments: string) => {
    if (!selectedPip) return;
    if (!canApprovePip) {
        toast.error("You do not have permission to approve/close PIP status.");
        return;
    }
    if (!comments.trim()) {
      toast.error("Please provide final comments/justification for closing/extending this performance program.");
      return;
    }

    console.log({
        userEmail: user.email,
        userRole: user.role,
        collection: 'pips',
        documentId: selectedPip.id,
        operation: 'UPDATE'
    });

    try {
      const nowISO = new Date().toISOString();
      const payload: any = {
        status: newStatus,
        finalComments: comments.trim(),
        updatedAt: nowISO
      };

      // If extended, add 15 more days to end date
      if (newStatus === 'Extended') {
        const d = new Date(selectedPip.endDate);
        d.setDate(d.getDate() + 15);
        payload.endDate = d.toISOString().slice(0, 10);
      }

      await updateDoc(doc(db, 'pips', selectedPip.id), payload);

      // Audit log: PIP Status update
      await addDoc(collection(db, 'adminAuditLogs'), {
        timestamp: nowISO,
        action: newStatus === 'Extended' ? 'PIP Updated' : 'PIP Closed',
        performedBy: `${user.fullName || user.name || user.email} (${user.email})`,
        affectedUser: `${selectedPip.agentName} (${selectedPip.agentEmail})`,
        previousValue: selectedPip.status,
        newValue: newStatus,
        remarks: `PIP plan officially resolved as [${newStatus}]. Comments: "${comments.trim()}"`,
        details: {
          pipId: selectedPip.id,
          finalStatus: newStatus,
          comments: comments.trim(),
          extendedEndDate: payload.endDate || null
        }
      });
      
      setSelectedPip(prev => prev ? { ...prev, ...payload } : null);
      toast.success(`PIP plan has been officially compiled and marked: ${newStatus}`);
    } catch (err: any) {
      console.error({
          firestoreError: err.message,
          collection: 'pips',
          documentId: selectedPip.id,
          userRole: user.role,
          uid: user.uid
      });
      if(err.code === 'permission-denied') {
        toast.error("You do not have permission to update PIP status.");
      } else {
        toast.error("Failed to update PIP status: " + err.message);
      }
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Initiated': return 'bg-sky-50 text-sky-700 border-sky-100';
      case 'Under Review': return 'bg-indigo-50 text-indigo-700 border-indigo-100';
      case 'Passed': return 'bg-emerald-50 text-emerald-800 border-emerald-100 font-extrabold';
      case 'Failed': return 'bg-rose-50 text-rose-800 border-rose-100 font-extrabold';
      case 'Extended': return 'bg-amber-50 text-amber-800 border-amber-100';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  // Helper: check remaining days or elapsed status
  const getElapsedStats = (pip: PipRecord) => {
    const s = new Date(pip.startDate).getTime();
    const e = new Date(pip.endDate).getTime();
    const now = new Date().getTime();

    const totalDays = Math.max(1, Math.round((e - s) / (1000 * 60 * 60 * 24)));
    const elapsedDays = Math.max(0, Math.round((now - s) / (1000 * 60 * 60 * 24)));
    const pct = Math.min(100, Math.round((elapsedDays / totalDays) * 100));
    const remains = Math.max(0, Math.round((e - now) / (1000 * 60 * 60 * 24)));

    return { totalDays, elapsedDays, pct, remains };
  };

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-12">
      {/* Banner / Hero Header */}
      <div className="relative overflow-hidden rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 text-slate-900 dark:text-white shadow-sm">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 bg-indigo-55 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border border-indigo-100 dark:border-indigo-900/40">
              <Activity size={11} className="animate-pulse" />
              Coaching & Excellence Bureau
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white mt-1.5">Performance Improvement Plans (PIP)</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium max-w-2xl leading-relaxed">
              Track, review, and support workforce calibration objectives through structured 30/60/90-day progress check-ins and key metrics.
            </p>
          </div>
          
          {canIssuePip && (
            <Dialog open={isNewPipOpen} onOpenChange={setIsNewPipOpen}>
                <DialogTrigger 
                  render={
                    <Button className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs h-9 px-4 gap-1.5 rounded-xl border-none shadow-none cursor-pointer">
                      <Plus size={14} />
                      Initiate Performance Plan
                    </Button>
                  }
                />
              <DialogContent className="sm:max-w-xl bg-white border border-slate-200 p-6 rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto">
                <DialogHeader className="pb-3 border-b border-slate-100">
                  <DialogTitle className="text-xl font-black text-[#0F172A] flex items-center gap-2">
                    <CalendarClock size={22} className="text-indigo-600" />
                    New Performance Improvement Program
                  </DialogTitle>
                  <DialogDescription className="text-xs text-slate-500 font-medium">
                    Pre-provision compliance guidelines, target KPI standards, and coaching resources for an employee.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4 text-left">
                  {/* Select Agent */}
                  <UserPicker 
                    label="Select Employee"
                    onSelect={(u) => setNewPipForm({ ...newPipForm, agentId: u.uid })}
                    selectedUserId={newPipForm.agentId}
                    placeholder="Search employee or supervisor for PIP..."
                    allUsers={eligiblePipTargets}
                  />

                  <div className="grid grid-cols-2 gap-4">
                    {/* PIP Title */}
                    <div className="space-y-1.5">
                      <Label className="text-xs font-bold text-slate-700">PIP Title/Reason</Label>
                      <Input 
                        value={newPipForm.title}
                        onChange={(e) => setNewPipForm({ ...newPipForm, title: e.target.value })}
                        className="text-xs h-10 border-slate-200"
                        placeholder="e.g. Standard 30-Day Support Plan"
                      />
                    </div>

                    {/* Custom Date Range */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-bold text-slate-700">Start Date</Label>
                        <Input
                          type="date"
                          value={newPipForm.startDate}
                          onChange={(e) => setNewPipForm({ ...newPipForm, startDate: e.target.value })}
                          className="text-xs h-10 border-slate-200"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-bold text-slate-700">End Date</Label>
                        <Input
                          type="date"
                          value={newPipForm.endDate}
                          onChange={(e) => setNewPipForm({ ...newPipForm, endDate: e.target.value })}
                          className="text-xs h-10 border-slate-200"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Target metrics metrics */}
                  <div className="p-4 bg-slate-50 border border-slate-100 rounded-xl space-y-3">
                    <span className="text-[10px] font-black uppercase text-slate-500 tracking-wider">Target Targets Under Observation</span>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <Label className="text-[10px] font-bold text-slate-600">QA Score Target (%)</Label>
                        <Input 
                          type="number"
                          value={newPipForm.qualityTarget}
                          onChange={(e) => setNewPipForm({ ...newPipForm, qualityTarget: Number(e.target.value) })}
                          className="text-xs h-8 bg-white"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] font-bold text-slate-600">Attendance (%)</Label>
                        <Input 
                          type="number"
                          value={newPipForm.attendanceTarget}
                          onChange={(e) => setNewPipForm({ ...newPipForm, attendanceTarget: Number(e.target.value) })}
                          className="text-xs h-8 bg-white"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] font-bold text-slate-600">Productivity (Cases)</Label>
                        <Input 
                          type="number"
                          value={newPipForm.productivityTarget}
                          onChange={(e) => setNewPipForm({ ...newPipForm, productivityTarget: Number(e.target.value) })}
                          className="text-xs h-8 bg-white"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Description of gaps */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold text-slate-700">Gaps/Justification Observations</Label>
                    <Textarea 
                      placeholder="Comment on historical KPIs or specific guidelines where the agent failed. Underline reasons for coaching."
                      value={newPipForm.description}
                      onChange={(e) => setNewPipForm({ ...newPipForm, description: e.target.value })}
                      className="text-xs min-h-[70px] border-slate-200"
                    />
                  </div>

                  {/* Coaching support plan info */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold text-slate-700">Support & Weekly Activity Protocol</Label>
                    <Textarea 
                      placeholder="Explain scheduled syncs, mentorship loops, training material access, or QA overrides that will assist the agent."
                      value={newPipForm.coachingSupportPlan}
                      onChange={(e) => setNewPipForm({ ...newPipForm, coachingSupportPlan: e.target.value })}
                      className="text-xs min-h-[70px] border-slate-200"
                    />
                  </div>

                  {/* Send Email Notification Checkbox */}
                  <div className="flex items-center gap-2 pt-3 pb-2 bg-indigo-50/40 border border-indigo-150 rounded-xl px-4 mt-2">
                    <input
                      type="checkbox"
                      id="sendEmailNotificationPip"
                      checked={sendEmailNotification}
                      onChange={(e) => setSendEmailNotification(e.target.checked)}
                      className="h-4 w-4 rounded border-indigo-300 text-indigo-650 focus:ring-indigo-500 cursor-pointer"
                    />
                    <Label htmlFor="sendEmailNotificationPip" className="text-xs font-black text-indigo-950 cursor-pointer select-none">
                      Send Email Notification to Employee & Reporting Hierarchy
                    </Label>
                  </div>
                </div>

                <DialogFooter className="border-t border-slate-100 pt-3 gap-2">
                  <Button 
                    variant="outline" 
                    onClick={() => setIsNewPipOpen(false)}
                    className="h-9 font-bold text-xs border-slate-200"
                  >
                    Cancel
                  </Button>
                  <Button 
                    onClick={handleCreatePip}
                    className="bg-indigo-600 font-bold text-xs h-9 text-white hover:bg-indigo-700 transition-colors"
                  >
                    Initiate Plan
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* Stats Bento Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: canIssuePip ? 'Active PIP Programs' : 'My Active PIPs', val: filteredPips.filter(p => ['Initiated', 'Under Review', 'Extended'].includes(p.status)).length, icon: Activity, color: 'text-indigo-600 bg-indigo-50 border-indigo-100' },
          { label: canIssuePip ? 'Graduated / Passed' : 'My Passed', val: filteredPips.filter(p => p.status === 'Passed').length, icon: CheckCircle, color: 'text-emerald-600 bg-emerald-50 border-emerald-100' },
          { label: canIssuePip ? 'Non-Graduated / Failed' : 'My Failed', val: filteredPips.filter(p => p.status === 'Failed').length, icon: TrendingDown, color: 'text-rose-600 bg-rose-50 border-rose-100' },
          { label: canIssuePip ? 'Extended Reviews' : 'My Extended', val: filteredPips.filter(p => p.status === 'Extended').length, icon: Clock, color: 'text-amber-600 bg-amber-50 border-amber-100' },
        ].map((stat, idx) => (
          <Card key={idx} className="border-slate-150 shadow-sm bg-white overflow-hidden text-left">
            <CardContent className="p-5 flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-[10px] uppercase font-black text-slate-400 tracking-wider font-sans">{stat.label}</p>
                <div className="text-2xl font-black text-[#0F172A]">{stat.val}</div>
              </div>
              <div className={`p-2.5 rounded-xl border ${stat.color}`}>
                <stat.icon size={18} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Filter / Table Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Side: PIP List */}
        <div className="lg:col-span-8 space-y-4">
          <Card className="border-slate-200 shadow-sm bg-white overflow-hidden text-left">
            <CardHeader className="pb-3 border-b border-slate-50 flex flex-row flex-wrap justify-between items-center gap-4">
              <div>
                <CardTitle className="text-base font-black text-slate-800 tracking-tight">Personnel Trackers</CardTitle>
                <CardDescription className="text-xs font-semibold text-slate-400">Select any record to log milestone reviews or review coaching content.</CardDescription>
              </div>

              {/* Filtering Controls */}
              <div className="flex gap-2">
                <select 
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="text-xs font-bold h-8 rounded-lg border border-slate-200 bg-white px-2 cursor-pointer outline-none focus:ring-1 focus:ring-slate-500"
                >
                  <option value="All">All Statuses</option>
                  <option value="Initiated">Initiated</option>
                  <option value="Under Review">Under Review</option>
                  <option value="Passed">Passed</option>
                  <option value="Failed">Failed</option>
                  <option value="Extended">Extended</option>
                </select>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
                  <Input 
                    type="text"
                    placeholder="Search employee..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-8 h-8 text-xs max-w-[180px]"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="py-12 text-center text-slate-400 font-bold text-xs animate-pulse">
                  Querying live Performance database...
                </div>
              ) : filteredPips.length === 0 ? (
                <div className="py-16 text-center space-y-4">
                  <div className="mx-auto w-12 h-12 bg-slate-50 border border-slate-100 rounded-full flex items-center justify-center">
                    <UserCheck className="text-slate-400" size={24} />
                  </div>
                  <div>
                    <h4 className="text-sm font-black text-slate-700">Absolute Clearance Record</h4>
                    <p className="text-xs text-slate-400 font-medium max-w-sm mx-auto mt-1">There are no active performance improvement records mapped to this filtering query. Splendid performance!</p>
                  </div>
                </div>
              ) : (
                <Table>
                  <TableHeader className="bg-slate-50/50">
                    <TableRow>
                      <TableHead className="font-extrabold text-[10px] uppercase text-slate-500 tracking-wider">Employee (Email)</TableHead>
                      <TableHead className="font-extrabold text-[10px] uppercase text-slate-500 tracking-wider">Review Scope</TableHead>
                      <TableHead className="font-extrabold text-[10px] uppercase text-slate-500 tracking-wider">Observation Period</TableHead>
                      <TableHead className="font-extrabold text-[10px] uppercase text-slate-500 tracking-wider">Meters (QA/Att/Prod)</TableHead>
                      <TableHead className="font-extrabold text-[10px] uppercase text-slate-500 tracking-wider">Status</TableHead>
                      <TableHead className="font-extrabold text-[10px] uppercase text-slate-500 tracking-wider text-right pr-6">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPips.map((p) => {
                      const { remains, pct } = getElapsedStats(p);
                      const isSelected = selectedPip && selectedPip.id === p.id;
                      
                      const targetUser = allUsers.find(u => u.uid === p.agentId);
                      const agentName = targetUser?.employeeName || targetUser?.fullName || targetUser?.name || p.agentName || 'Corporate Agent';
                      const agentEmail = targetUser?.email || p.agentEmail || 'agent@workforce.co';
                      const employeeId = targetUser?.employeeId || p.employeeId || 'E-360';
                      const process = targetUser?.process || p.process || 'N/A';

                      return (
                        <TableRow 
                          key={p.id} 
                          className={`hover:bg-slate-50/40 cursor-pointer transition-colors ${isSelected ? 'bg-indigo-50/30' : ''}`}
                          onClick={() => setSelectedPip(p)}
                        >
                          <TableCell className="py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center font-bold text-xs text-slate-600 overflow-hidden">
                                {targetUser?.photoURL ? (
                                  <img src={targetUser.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                ) : (
                                  agentName.charAt(0)
                                )}
                              </div>
                              <div className="flex flex-col text-left">
                                <span className="font-bold text-xs text-[#0F172A]">{agentName}</span>
                                <span className="text-[10px] text-slate-400 font-medium">{agentEmail}</span>
                                {targetUser && (
                                  <div className="flex flex-col mt-1">
                                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">Process: {targetUser.department || 'N/A'}</span>
                                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">Mapping: {targetUser.teamLeadName || 'No TL'}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="py-3.5">
                            <div className="flex flex-col text-left">
                              <span className="font-bold text-xs text-[#0F172A]">{p.title}</span>
                              <span className="text-[10px] text-indigo-500 font-bold uppercase mt-0.5 tracking-wider">Initiator: {p.initiatorName}</span>
                            </div>
                          </TableCell>
                          <TableCell className="py-3.5">
                            <div className="flex flex-col text-left text-[11px] font-semibold text-slate-600 space-y-1">
                              <div className="flex items-center gap-1">
                                <Calendar size={11} className="text-slate-400" />
                                <span>{p.startDate} to {p.endDate}</span>
                              </div>
                              <div className="w-24 bg-slate-100 h-1 rounded-full overflow-hidden">
                                <div className="bg-indigo-500 h-full" style={{ width: `${pct}%` }}></div>
                              </div>
                              <span className="text-[9px] font-bold text-slate-400">
                                {remains > 0 ? `${remains} days remaining` : "Period Completed"}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="py-3.5">
                            <div className="flex gap-2 items-center text-[10px] font-bold">
                              <Badge variant="outline" className="text-[10px] h-5 border-slate-200 font-bold bg-white text-slate-700">QA: {p.qualityTarget}%</Badge>
                              <Badge variant="outline" className="text-[10px] h-5 border-slate-200 font-bold bg-white text-slate-700">Att: {p.attendanceTarget}%</Badge>
                            </div>
                          </TableCell>
                          <TableCell className="py-3.5">
                            <Badge variant="outline" className={`text-[10px] font-black tracking-wide border ${getStatusColor(p.status)}`}>
                              {p.status}
                            </Badge>
                          </TableCell>
<TableCell className="py-3.5 text-right pr-6" onClick={(e) => e.stopPropagation()}>
                            <div className="flex gap-1 justify-end">
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                onClick={() => setSelectedPip(p)}
                                className="font-bold text-[11px] text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 h-7"
                              >
                                View
                              </Button>
                              {canModifyPip && (
                                  <Button 
                                    variant="ghost" 
                                    size="sm"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      const newTitle = prompt('Edit PIP title (or cancel to skip):', p.title);
                                      if (newTitle && newTitle !== p.title) {
                                        try {
                                          const { doc, updateDoc } = await import('firebase/firestore');
                                          await updateDoc(doc(db, 'pips', p.id), { title: newTitle });
                                          toast.success('PIP updated successfully');
                                        } catch (err: any) {
                                          toast.error('Update failed: ' + err.message);
                                        }
                                      }
                                    }}
                                    className="font-bold text-[11px] text-slate-600 hover:text-slate-900 hover:bg-slate-100 h-7"
                                  >
                                    Edit
                                  </Button>
                              )}
                              {canDeletePip && (
                                  <Button 
                                    variant="ghost" 
                                    size="sm"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if(confirm('Are you sure you want to permanently delete this PIP?')) {
                                        try {
                                          const { doc, deleteDoc } = await import('firebase/firestore');
                                          await deleteDoc(doc(db, 'pips', p.id));
                                          toast.success('PIP deleted successfully');
                                          setSelectedPip(null);
                                        } catch (err: any) {
                                          toast.error('Delete failed: ' + err.message);
                                        }
                                      }
                                    }}
                                    className="font-bold text-[11px] text-rose-600 hover:text-rose-800 hover:bg-rose-50 h-7"
                                  >
                                    Delete
                                  </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Side: Detail Panel */}
        <div className="lg:col-span-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto">
          {selectedPip ? (
            <div className="space-y-4 text-left">
              <Card className="border-indigo-200 shadow-md bg-white overflow-hidden relative">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 to-sky-400"></div>
                <CardHeader className="pb-4 bg-slate-50/50">
                  <div className="flex items-center justify-between gap-2.5 mb-2">
                    <Badge variant="outline" className={`text-[10px] font-black border ${getStatusColor(selectedPip.status)}`}>
                      {selectedPip.status}
                    </Badge>
                    <span className="text-[10px] font-bold text-slate-400">ID: {selectedPip.id}</span>
                  </div>
                  <CardTitle className="text-base font-black text-slate-800 leading-tight">
                    {selectedPip.title}
                  </CardTitle>
                  <CardDescription className="text-xs text-slate-500">
                    Active program for <strong className="text-slate-800">
                      {allUsers.find(u => u.uid === selectedPip.agentId)?.fullName || allUsers.find(u => u.uid === selectedPip.agentId)?.name || selectedPip.agentName}
                    </strong>
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-5 space-y-5">
                  
                  {/* Observation Target Benchmarks */}
                  <div className="space-y-2">
                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Observation Target Benchmarks</span>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="p-2 border border-slate-100 rounded-lg text-center bg-slate-50">
                        <span className="block text-[9px] font-bold text-slate-500 uppercase">QA Score</span>
                        <span className="font-extrabold text-sm text-indigo-700">{selectedPip.qualityTarget}%</span>
                      </div>
                      <div className="p-2 border border-slate-100 rounded-lg text-center bg-slate-50">
                        <span className="block text-[9px] font-bold text-slate-500 uppercase">Attendance</span>
                        <span className="font-extrabold text-sm text-indigo-700">{selectedPip.attendanceTarget}%</span>
                      </div>
                      <div className="p-2 border border-slate-100 rounded-lg text-center bg-slate-50">
                        <span className="block text-[9px] font-bold text-slate-500 uppercase">Cases Target</span>
                        <span className="font-extrabold text-sm text-indigo-700">{selectedPip.productivityTarget}</span>
                      </div>
                    </div>
                  </div>

                  {/* Program Description */}
                  <div className="space-y-1.5 text-xs text-slate-600">
                    <h5 className="font-bold text-slate-700 flex items-center gap-1.5 uppercase text-[9px] tracking-wider text-slate-500">
                      <FileText size={12} className="text-slate-400" />
                      Observed Gaps & Context
                    </h5>
                    <p className="bg-slate-50 p-3 rounded-lg text-slate-600 text-[11px] leading-relaxed border border-slate-100">
                      {selectedPip.description}
                    </p>
                  </div>

                  {/* Support Protocol */}
                  <div className="space-y-1.5 text-xs text-slate-600">
                    <h5 className="font-bold text-[#0F172A] flex items-center gap-1.5 uppercase text-[9px] tracking-wider text-slate-500">
                      <BookOpen size={12} className="text-slate-400" />
                      Coaching & Facilitation Protocol
                    </h5>
                    <p className="bg-slate-50 p-3 rounded-lg text-slate-600 text-[11px] leading-relaxed border border-slate-100">
                      {selectedPip.coachingSupportPlan}
                    </p>
                  </div>

                  {/* Sign-offs info */}
                  <div className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-lg space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-600 font-bold flex items-center gap-1">
                        <UserCheck size={13} className="text-indigo-500" />
                        Main Plan Status:
                      </span>
                      {selectedPip.signedAndAcknowledged ? (
                        <Badge className="bg-emerald-100 text-emerald-800 border-none font-bold text-[10px]">Signed & Acknowledged ✓</Badge>
                      ) : (
                        <Badge className="bg-amber-100 text-amber-800 border-none font-bold text-[10px]">Waiting Action</Badge>
                      )}
                    </div>
                    {selectedPip.signedAndAcknowledged && (
                      <p className="text-[10px] text-slate-400 italic">
                        Signed on: {selectedPip.signedAndAcknowledgedAt?.toDate?.().toLocaleString() || selectedPip.signedAndAcknowledgedAt?.toLocaleString() || 'N/A'} by {selectedPip.signedAndAcknowledgedBy}
                      </p>
                    )}
                    
                    {/* Agent can sign if not already signed */}
                    {user.uid === selectedPip.agentId && !selectedPip.signedAndAcknowledged && (
                      <Button
                        size="sm"
                        disabled={submittingAcknowledge}
                        onClick={async () => {
                            if (!selectedPip) return;
                            setSubmittingAcknowledge(true);
                            try {
                                await updateDoc(doc(db, 'pips', selectedPip.id), {
                                    signedAndAcknowledged: true,
                                    signedAndAcknowledgedAt: serverTimestamp(),
                                    signedAndAcknowledgedBy: user.email,
                                    updatedAt: new Date().toISOString()
                                });
                                setSelectedPip(prev => prev ? { 
                                    ...prev, 
                                    signedAndAcknowledged: true, 
                                    signedAndAcknowledgedAt: new Date(),
                                    signedAndAcknowledgedBy: user.email 
                                } : null);
                                toast.success("PIP signed and acknowledged successfully!");
                            } catch (err: any) {
                                if(err.code === 'permission-denied') {
                                    toast.error("You do not have permission to sign this PIP.");
                                } else {
                                    toast.error("Failed signature: " + err.message);
                                }
                            } finally {
                                setSubmittingAcknowledge(false);
                            }
                        }}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[11px] h-8 mt-1.5 cursor-pointer"
                      >
                        {submittingAcknowledge ? "Submitting..." : "[ Sign & Acknowledge PIP ]"}
                      </Button>
                    )}
                  </div>

                  {/* Timeline section: Milestone reviews */}
                  <div className="space-y-3 pt-2 border-t border-slate-150">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-black uppercase text-slate-500 tracking-wider">Coaching & Milestone Reviews</span>
                      {canManagePip && ['Initiated', 'Under Review', 'Extended'].includes(selectedPip.status) && (
                        <Dialog open={isAddCheckinOpen} onOpenChange={setIsAddCheckinOpen}>
                          <DialogTrigger 
                            render={
                              <Button className="h-6 px-2 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-bold rounded-md cursor-pointer">
                                Log Review Check-in
                              </Button>
                            }
                          />
                          <DialogContent className="sm:max-w-md bg-white border border-slate-200 p-6 rounded-2xl shadow-xl">
                            <DialogHeader>
                              <DialogTitle className="text-base font-black text-slate-800">Record Progress Milestone Review</DialogTitle>
                              <DialogDescription className="text-xs text-slate-500">
                                Evaluate the agent's progress against target metrics for the observed period.
                              </DialogDescription>
                            </DialogHeader>
                            <div className="space-y-4 py-3 text-left">
                              <div className="space-y-1.5">
                                <Label className="text-xs font-bold text-slate-700">Metrics Evaluation & Feedback</Label>
                                <Textarea 
                                  placeholder="e.g., Weekly QA average sits at 99.2%. Great improvements made on process compliance guidelines..."
                                  value={checkinForm.metricsAssessment}
                                  onChange={(e) => setCheckinForm({ ...checkinForm, metricsAssessment: e.target.value })}
                                  className="text-xs min-h-[90px]"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-bold text-slate-700">Specific Next Actions (Coaching Support)</Label>
                                <Input 
                                  placeholder="e.g., Maintain 98%+ attendance for next 7 days"
                                  value={checkinForm.actionItems}
                                  onChange={(e) => setCheckinForm({ ...checkinForm, actionItems: e.target.value })}
                                  className="text-xs h-9"
                                />
                              </div>
                            </div>
                            <DialogFooter className="gap-2">
                              <Button 
                                variant="outline" 
                                size="sm"
                                onClick={() => setIsAddCheckinOpen(false)}
                                className="h-9 font-bold text-xs"
                              >
                                Cancel
                              </Button>
                              <Button 
                                size="sm"
                                onClick={handleAddCheckin}
                                className="bg-indigo-600 hover:bg-indigo-700 font-bold text-xs h-9 text-white"
                              >
                                Save Review
                              </Button>
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>
                      )}
                    </div>

                    {/* Timeline logs */}
                    {(!selectedPip.checkins || selectedPip.checkins.length === 0) ? (
                      <div className="py-6 text-center border border-dashed border-slate-150 rounded-lg text-slate-400 font-medium text-[11px] italic bg-slate-50/50">
                        No coaching milestones recorded for this plan yet.
                      </div>
                    ) : (
                      <div className="space-y-3.5 pl-3 border-l-2 border-indigo-100">
                        {selectedPip.checkins.map((ch, cindex) => (
                          <div key={ch.id || cindex} className="relative space-y-1 text-xs">
                            {/* Dot */}
                            <div className="absolute -left-[18px] top-1 w-2.5 h-2.5 rounded-full bg-indigo-500 border-2 border-white shadow-sm"></div>
                            
                            <div className="flex justify-between items-center text-[10px]">
                              <span className="font-bold text-slate-700">Milestone Review on {ch.checkinDate}</span>
                              <span className="text-slate-400 text-[9px] font-medium">By {ch.reviewerName}</span>
                            </div>
                            
                            <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg space-y-1.5">
                              <p className="text-slate-600 text-[11px] leading-relaxed">
                                {ch.metricsAssessment}
                              </p>
                              <div className="pt-1.5 border-t border-slate-100 flex flex-col text-[10px] space-y-1">
                                <span className="font-bold text-indigo-600">Action: {ch.actionItems}</span>
                                
                                {ch.acknowledgedByAgent ? (
                                  <div className="text-[9px] text-emerald-700 font-bold bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100 inline-block w-fit mt-1">
                                    ✓ Signed by Agent: "{ch.agentComments}" ({ch.acknowledgedAt})
                                  </div>
                                ) : (
                                  <div className="pt-1 space-y-2">
                                    <span className="text-[9px] text-indigo-400 italic font-medium">Pending signature acknowledgment</span>
                                    {user.uid === selectedPip.agentId && (
                                      <div className="space-y-1.5 pt-1">
                                        <Input
                                          type="text"
                                          placeholder="Type feedback or accepted comments..."
                                          value={agentComment}
                                          onChange={(e) => setAgentComment(e.target.value)}
                                          className="h-7 text-[10px]"
                                        />
                                        <Button
                                          size="sm"
                                          onClick={() => handleAgentAcknowledgeCheckin(ch.id)}
                                          className="h-6 w-full bg-[#1E293B] hover:bg-slate-800 text-white font-bold text-[9px] pl-2 gap-1"
                                        >
                                          <Send size={10} />
                                          Acknowledge & Sign Check-in
                                        </Button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Closure & Graduation Controls */}
                  {canManagePip && ['Initiated', 'Under Review', 'Extended'].includes(selectedPip.status) && (
                    <div className="pt-4 border-t border-slate-150 space-y-3.5">
                      <span className="text-[10px] font-black uppercase text-slate-500 tracking-wider">Graduate or Update Program Status</span>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-bold text-slate-500 uppercase">Comments/Justification for Closure</Label>
                        <Textarea 
                          id="closureComments"
                          placeholder="Why is this plan graduating, failing, or being extended? Document justifications."
                          className="text-xs min-h-[60px]"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <Button
                          onClick={() => {
                            const comms = (document.getElementById('closureComments') as HTMLTextAreaElement)?.value || '';
                            handleUpdatePipStatus('Passed', comms);
                          }}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] h-8"
                        >
                          Graduate (Pass)
                        </Button>
                        <Button
                          onClick={() => {
                            const comms = (document.getElementById('closureComments') as HTMLTextAreaElement)?.value || '';
                            handleUpdatePipStatus('Failed', comms);
                          }}
                          className="bg-rose-600 hover:bg-rose-700 text-white font-bold text-[10px] h-8"
                        >
                          Mark as Failed
                        </Button>
                        <Button
                          onClick={() => {
                            const comms = (document.getElementById('closureComments') as HTMLTextAreaElement)?.value || '';
                            handleUpdatePipStatus('Extended', comms);
                          }}
                          className="bg-amber-600 hover:bg-amber-700 text-white font-bold text-[10px] h-8"
                        >
                          Extend (+15d)
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Comments for Closed Plans */}
                  {selectedPip.finalComments && (
                    <div className="pt-3 border-t border-slate-150 space-y-1">
                      <span className="text-[10px] font-black uppercase text-slate-500 tracking-wider">Final Closure Valuation</span>
                      <p className="bg-slate-50 p-2.5 border border-slate-100 rounded-lg text-slate-600 text-[10.5px] italic leading-relaxed">
                        "{selectedPip.finalComments}"
                      </p>
                    </div>
                  )}

                </CardContent>
              </Card>
            </div>
          ) : (
            <Card className="border-dashed border-slate-200 h-full flex flex-col justify-center items-center py-20 px-6 bg-white text-slate-400">
              <BookOpen size={30} className="text-slate-300 mb-3" />
              <p className="text-xs font-bold text-slate-500">No Program Selected</p>
              <p className="text-[10px] text-slate-400 text-center max-w-[200px] mt-1 leading-normal font-medium">Click on any compliance record to review active PIP support plans or log new milestones.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
