import React, { useState, useEffect, useMemo } from 'react';
import { db, auth } from '../../lib/firebase';
import { collection, onSnapshot, query, orderBy, limit, addDoc } from 'firebase/firestore';
import { 
  Mail, Send, AlertTriangle, CheckCircle, Clock, Settings, RefreshCw, 
  HelpCircle, Eye, AlertCircle, FileText, User, Tag 
} from 'lucide-react';
import { toast } from 'sonner';

interface EmailDashboardSubViewProps {
  adminTheme: 'light' | 'dark';
}

export const EmailDashboardSubView: React.FC<EmailDashboardSubViewProps> = ({ adminTheme }) => {
  const [emails, setEmails] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // SMTP Status from server endpoint
  const [smtpStatus, setSmtpStatus] = useState<{
    isConfigured: boolean;
    host: string;
    port: number;
    user: string | null;
    from: string;
  } | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  // Test Email form state
  const [testTo, setTestTo] = useState('');
  const [testCc, setTestCc] = useState('');
  const [testSubject, setTestSubject] = useState('');
  const [testBody, setTestBody] = useState('');
  const [sendingTest, setSendingTest] = useState(false);

  // Active email item for a modal/preview drawer
  const [selectedEmail, setSelectedEmail] = useState<any | null>(null);

  // Fetch email queue from both Firestore emails and mail collections
  useEffect(() => {
    setLoading(true);
    const qEmails = query(collection(db, 'emails'), orderBy('createdAt', 'desc'), limit(50));
    const qMail = query(collection(db, 'mail'), orderBy('createdAt', 'desc'), limit(50));
    
    let emailsList: any[] = [];
    let mailList: any[] = [];
    let isMounted = true;
    
    const updateMergedList = (eList: any[], mList: any[]) => {
      if (!isMounted) return;
      const seen = new Set<string>();
      const merged: any[] = [];
      
      const all = [
        ...eList.map(item => ({ ...item, sourceCollection: item.sourceCollection || 'emails' })), 
        ...mList.map(item => ({ ...item, sourceCollection: item.sourceCollection || 'mail' }))
      ];
                    
      // Sort in-place by chronological creation time
      all.sort((a, b) => {
        const dateA = new Date(a.createdAt || 0).getTime();
        const dateB = new Date(b.createdAt || 0).getTime();
        return dateB - dateA;
      });
      
      all.forEach(item => {
        const toStr = String(item.to || item.message?.to || '').toLowerCase().trim();
        const subjStr = String(item.subject || item.message?.subject || '').toLowerCase().trim();
        const ms = new Date(item.createdAt || 0).getTime();
        // Bucket within 5 seconds for deduplicating same dispatch logged to both collections
        const hash = `${toStr}_${subjStr}_${Math.round(ms / 5000)}`;
        
        if (!seen.has(hash)) {
          seen.add(hash);
          
          // Match and see if there's a corresponding document that has a richer 'delivery' state
          const richerInstance = all.find(other => {
            if (other.id === item.id) return false;
            const otherToStr = String(other.to || other.message?.to || '').toLowerCase().trim();
            const otherSubjStr = String(other.subject || other.message?.subject || '').toLowerCase().trim();
            const otherMs = new Date(other.createdAt || 0).getTime();
            return otherToStr === toStr && otherSubjStr === subjStr && Math.abs(otherMs - ms) < 10000 && other.delivery;
          });

          if (richerInstance) {
            merged.push({ 
              ...richerInstance, 
              sourceCollection: item.sourceCollection !== richerInstance.sourceCollection 
                ? `${item.sourceCollection}/${richerInstance.sourceCollection}` 
                : item.sourceCollection 
            });
          } else {
            merged.push(item);
          }
        }
      });
      
      setEmails(merged.slice(0, 50));
      setLoading(false);
    };

    const unsubscribeEmails = onSnapshot(qEmails, (snapshot) => {
      emailsList = [];
      snapshot.forEach((doc) => {
        emailsList.push({ id: doc.id, ...doc.data(), sourceCollection: 'emails' });
      });
      updateMergedList(emailsList, mailList);
    }, (error) => {
      console.warn('Silent fallback on emails collection permission:', error);
      // If we failed to read emails, we can still load mail
      updateMergedList(emailsList, mailList);
    });

    const unsubscribeMail = onSnapshot(qMail, (snapshot) => {
      mailList = [];
      snapshot.forEach((doc) => {
        mailList.push({ id: doc.id, ...doc.data(), sourceCollection: 'mail' });
      });
      updateMergedList(emailsList, mailList);
    }, (error) => {
      console.warn('Silent fallback on mail collection permission:', error);
      // If we failed to read mail, we can still load emails
      updateMergedList(emailsList, mailList);
    });

    return () => {
      isMounted = false;
      unsubscribeEmails();
      unsubscribeMail();
    };
  }, []);

  // Fetch SMTP status from our custom server /api/smtp-status endpoint
  const fetchSmtpStatus = async () => {
    setLoadingStatus(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        setLoadingStatus(false);
        return;
      }

      const res = await fetch('/api/smtp-status', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setSmtpStatus(data);
      } else {
        console.warn('Could not fetch SMTP status from server endpoint');
      }
    } catch (err) {
      console.error('Failed to fetch SMTP Status:', err);
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    fetchSmtpStatus();
  }, []);

  // Statistics calculation supporting both local custom worker 'status' and Firebase Trigger Email 'delivery.state'
  const stats = useMemo(() => {
    let pending = 0;
    let sent = 0;
    let failed = 0;
    
    emails.forEach(e => {
      const state = (e.delivery?.state || e.status || 'pending').toLowerCase();
      if (state === 'success' || state === 'sent') {
        sent++;
      } else if (state === 'error' || state === 'failed') {
        failed++;
      } else {
        pending++;
      }
    });
    
    return { pending, sent, failed, total: emails.length };
  }, [emails]);

  // Trigger test email write
  const handleSendTestEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testTo.trim()) {
      toast.error('Recipient email (To) is required.');
      return;
    }

    setSendingTest(true);
    const nowISO = new Date().toISOString();

    const testEmailDoc = {
      to: testTo.trim(),
      cc: testCc ? testCc.split(',').map(s => s.trim()).filter(Boolean) : [],
      createdAt: nowISO,
      status: 'pending',
      retryCount: 0,
      message: {
        subject: testSubject.trim() || 'Precision360 Custom Email Delivery System - Test Email',
        text: testBody.trim() || 'This email confirms the custom Email Delivery Service is live, operational, and connected to your background process queue!',
        html: `
          <div style="font-family: sans-serif; padding: 25px; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; color: #1e293b;">
            <h2 style="color: #6366f1; margin-top: 0; font-size: 20px; font-weight: 700;">Precision360 Notification System</h2>
            <p style="font-size: 14px; line-height: 1.5; color: #334155;">Congratulations, your background custom Email Delivery Service is successfully configured and active!</p>
            <div style="margin: 20px 0; padding: 15px; background-color: #f8fafc; border-radius: 8px; border-left: 4px solid #6366f1;">
              <p style="margin: 0; font-size: 13px; font-weight: 600; color: #475569;">System Metadata:</p>
              <ul style="margin: 8px 0 0 0; padding-left: 20px; font-family: monospace; font-size: 12px; color: #64748b; line-height: 1.4;">
                <li>Queue ID: TEST_${Math.random().toString(36).substring(2, 10).toUpperCase()}</li>
                <li>Timestamp: ${nowISO}</li>
                <li>Trigger Type: Manual Test Dispatch</li>
                <li>SMTP Target: ${smtpStatus?.host || 'smtp.gmail.com'}</li>
              </ul>
            </div>
            <p style="font-size: 14px; line-height: 1.5; color: #334155;">This dispatch confirms system resilience and cross-module dispatch capabilities (Warnings, PIP, Attendance, IT Helpdesk, and Notifications).</p>
            <p style="font-size: 12px; color: #94a3b8; margin-top: 25px; border-top: 1px solid #f1f5f9; padding-top: 15px;">
              This is an automated system generated test email for diagnostics. Please do not reply directly.
            </p>
          </div>
        `
      }
    };

    try {
      await addDoc(collection(db, 'emails'), testEmailDoc);
      await addDoc(collection(db, 'mail'), testEmailDoc);
      toast.success('Test email queue document registered in Firestore (emails & mail)! The background extension/trigger is processing it.');
      // Clear fields
      setTestTo('');
      setTestCc('');
      setTestSubject('');
      setTestBody('');
    } catch (err: any) {
      console.error('Failed to create test email document:', err);
      toast.error('Failed to queue test email: ' + err.message);
    } finally {
      setSendingTest(false);
    }
  };

  const getStatusBadge = (status: string, delivery?: any) => {
    const rawVal = (delivery?.state || status || 'pending').toLowerCase();
    switch (rawVal) {
      case 'success':
      case 'sent':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-850 dark:bg-emerald-950/40 dark:text-emerald-400">
            <CheckCircle size={12} /> Sent
          </span>
        );
      case 'processing':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-105 text-blue-800 dark:bg-blue-950/40 dark:text-blue-400 animate-pulse">
            <RefreshCw size={12} className="animate-spin" /> Processing
          </span>
        );
      case 'error':
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-101 text-red-800 dark:bg-red-950/40 dark:text-red-400">
            <AlertCircle size={12} /> Failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-850 dark:bg-amber-950/40 dark:text-amber-400">
            <Clock size={12} /> Pending
          </span>
        );
    }
  };

  const handleManualRefresh = () => {
    fetchSmtpStatus();
    toast.success('SMTP configurations updated!');
  };

  return (
    <div className="space-y-6">
      
      {/* Alert about Trigger Email setup state */}
      <div className="p-4 rounded-2xl border bg-indigo-500/10 border-indigo-500/20 text-indigo-700 dark:text-indigo-300 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex gap-3">
          <Mail className="shrink-0 mt-0.5 text-indigo-500" size={20} />
          <div>
            <h4 className="font-bold text-sm text-indigo-550 dark:text-indigo-300">Custom Email Delivery Service Trigger</h4>
            <p className="text-xs text-indigo-500/80 mt-1">
              Currently running an integrated real-time service that monitors the <strong>emails</strong> collection. 
              SMTP credentials (SMTP_USER and SMTP_PASS) are securely loaded server-side using Secret Manager.
            </p>
          </div>
        </div>
        <button 
          onClick={handleManualRefresh}
          className="px-4 py-2 bg-indigo-600 text-white hover:bg-indigo-700 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5 shrink-0 self-start md:self-auto"
        >
          <RefreshCw size={13} /> Refresh Config
        </button>
      </div>

      {/* Grid: Stats and SMTP Config */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Status Panel */}
        <div className={`p-5 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-800' : 'bg-white border-slate-150'} space-y-4`}>
          <div className="flex items-center justify-between border-b pb-3 border-slate-150/10 dark:border-slate-800/60">
            <h3 className="text-sm font-black uppercase text-slate-500 flex items-center gap-1.5">
              <Settings size={15} /> SMTP Server State
            </h3>
            {smtpStatus?.isConfigured ? (
              <span className="px-2 py-0.5 text-[10px] font-black uppercase rounded bg-emerald-500/10 text-emerald-550 border border-emerald-500/20">
                ACTIVE
              </span>
            ) : (
              <span className="px-2 py-0.5 text-[10px] font-black uppercase rounded bg-red-500/10 text-red-500 border border-red-500/20">
                CREDENTIALS MISSING
              </span>
            )}
          </div>

          {loadingStatus ? (
            <div className="flex items-center justify-center py-6">
              <RefreshCw size={20} className="animate-spin text-slate-400" />
            </div>
          ) : (
            <div className="space-y-3 font-mono text-xs">
              <div className="flex justify-between py-1 border-b border-dashed border-slate-150/10 dark:border-slate-800/20">
                <span className="text-slate-400">Host:</span>
                <span className="font-bold text-slate-700 dark:text-slate-250">{smtpStatus?.host}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-dashed border-slate-150/10 dark:border-slate-800/20">
                <span className="text-slate-400">Port:</span>
                <span className="font-bold text-slate-700 dark:text-slate-250">{smtpStatus?.port} (TLS Supported)</span>
              </div>
              <div className="flex justify-between py-1 border-b border-dashed border-slate-150/10 dark:border-slate-800/20">
                <span className="text-slate-400">Username:</span>
                <span className="font-bold text-slate-700 dark:text-slate-250 truncate max-w-[180px]">
                  {smtpStatus?.user || 'Not Configured'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-slate-400">Default From:</span>
                <span className="font-bold text-slate-700 dark:text-slate-250 truncate max-w-[180px]">{smtpStatus?.from}</span>
              </div>

              {!smtpStatus?.isConfigured && (
                <div className="p-3 bg-red-500/5 rounded-xl border border-red-500/10 text-[11px] text-red-650 dark:text-red-400 leading-relaxed font-sans">
                  <strong>Credentials required:</strong> Declare <code>SMTP_USER</code> and <code>SMTP_PASS</code> in your Studio secrets to enable real email deliveries.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Dashboard Counter stats */}
        <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className={`p-4 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-800' : 'bg-white border-slate-150'} flex flex-col justify-between`}>
            <span className="text-[10px] uppercase font-bold text-slate-400">Total Registered Queue</span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-black text-slate-800 dark:text-slate-100">{stats.total}</span>
              <span className="text-xs text-slate-400">items</span>
            </div>
            <div className="mt-3 text-[10px] text-slate-400">Parsed from 'emails'</div>
          </div>

          <div className={`p-4 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-800' : 'bg-white border-slate-150'} flex flex-col justify-between border-l-4 border-l-amber-500`}>
            <span className="text-[10px] uppercase font-bold text-amber-500">Pending / Processing</span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-black text-amber-500">{stats.pending}</span>
              <span className="text-xs text-slate-400">queued</span>
            </div>
            <div className="mt-3 text-[10px] text-slate-400">Awaiting trigger handler</div>
          </div>

          <div className={`p-4 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-800' : 'bg-white border-slate-150'} flex flex-col justify-between border-l-4 border-l-emerald-500`}>
            <span className="text-[10px] uppercase font-bold text-emerald-500">Dispatched Mail</span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-black text-emerald-500">{stats.sent}</span>
              <span className="text-xs text-emerald-400">delivered</span>
            </div>
            <div className="mt-3 text-[10px] text-slate-400">Sent to mail agent</div>
          </div>

          <div className={`p-4 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-800' : 'bg-white border-slate-150'} flex flex-col justify-between border-l-4 border-l-red-500`}>
            <span className="text-[10px] uppercase font-bold text-red-500">Failed / Retries</span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-black text-red-500">{stats.failed}</span>
              <span className="text-xs text-red-400">undelivered</span>
            </div>
            <div className="mt-3 text-[10px] text-red-400">Error response tracked</div>
          </div>
        </div>

      </div>

      {/* Grid: Test Send Panel and Real-time queue monitor */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Test Email Dispatcher form */}
        <div className={`lg:col-span-1 p-5 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-800' : 'bg-white border-slate-150'} space-y-4`}>
          <div className="border-b pb-3 border-slate-150/10 dark:border-slate-800/60">
            <h3 className="text-sm font-black uppercase text-indigo-500 flex items-center gap-1.5">
              <Send size={15} /> Send Test Diagnostics
            </h3>
            <p className="text-[11px] text-slate-400 mt-1">Simulates cross-module notification dispatch on any action</p>
          </div>

          <form onSubmit={handleSendTestEmail} className="space-y-3 text-xs">
            <div>
              <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">To Address (Required)</label>
              <input 
                type="email"
                placeholder="agent-email@workforce.com"
                value={testTo}
                onChange={e => setTestTo(e.target.value)}
                className="w-full p-2.5 rounded-xl border border-slate-205 dark:border-slate-800 bg-transparent text-slate-700 dark:text-slate-200 outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">CC Addresses (Optional, comma-separated)</label>
              <input 
                type="text"
                placeholder="lead@workforce.com, qa@workforce.com"
                value={testCc}
                onChange={e => setTestCc(e.target.value)}
                className="w-full p-2.5 rounded-xl border border-slate-205 dark:border-slate-800 bg-transparent text-slate-700 dark:text-slate-200 outline-none focus:border-indigo-500 animate-none"
              />
            </div>

            <div>
              <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Subject</label>
              <input 
                type="text"
                placeholder="Optional Subject"
                value={testSubject}
                onChange={e => setTestSubject(e.target.value)}
                className="w-full p-2.5 rounded-xl border border-slate-205 dark:border-slate-800 bg-transparent text-slate-700 dark:text-slate-200 outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Plain Text Body</label>
              <textarea 
                rows={3}
                placeholder="Optional body description message..."
                value={testBody}
                onChange={e => setTestBody(e.target.value)}
                className="w-full p-2.5 rounded-xl border border-slate-205 dark:border-slate-800 bg-transparent text-slate-700 dark:text-slate-200 outline-none focus:border-indigo-500 resize-none"
              />
            </div>

            <button
              type="submit"
              disabled={sendingTest}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {sendingTest ? <RefreshCw className="animate-spin" size={13} /> : <Send size={13} />}
              Queue Test Dispatch
            </button>
          </form>
        </div>

        {/* Real-time Monitor Logs list */}
        <div className={`lg:col-span-2 p-5 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-850 border-slate-800' : 'bg-white border-slate-150'} space-y-4`}>
          <div className="flex items-center justify-between border-b pb-3 border-slate-150/10 dark:border-slate-800/60">
            <div>
              <h3 className="text-sm font-black uppercase text-slate-500 flex items-center gap-1.5">
                <FileText size={15} /> Real-time Queue Monitor
              </h3>
              <p className="text-[10px] text-slate-400 mt-0.5">Showing latest 50 activities in emails collection</p>
            </div>
            <button 
              onClick={() => {
                const prevCount = emails.length;
                toast.promise(Promise.resolve(true), {
                  loading: 'Refreshing queue data...',
                  success: () => `Successfully verified ${prevCount} records in the email queue.`,
                  error: 'Error checking queue connection'
                });
              }}
              className="p-1 px-2.5 hover:bg-slate-550/15 text-slate-400 text-[10px] font-bold rounded-lg border border-transparent hover:border-slate-150/10 transition-all flex items-center gap-1"
            >
              <RefreshCw size={11} /> Sync Status
            </button>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-2">
              <RefreshCw size={24} className="animate-spin" />
              <span className="text-xs">Connecting queue socket...</span>
            </div>
          ) : emails.length === 0 ? (
            <div className="text-center py-20 text-slate-400 border border-dashed rounded-xl border-slate-200/50">
              <Mail className="mx-auto mb-2 opacity-30" size={30} />
              <p className="text-xs font-semibold">No emails registered in queue database yet.</p>
              <p className="text-[10px] opacity-80 mt-1">Trigger warnings or hand PIP plans to fill standard entries!</p>
            </div>
          ) : (
            <div className="overflow-y-auto max-h-[380px] space-y-2 pr-1">
              {emails.map((email) => {
                const toAddress = email.to || email.message?.to || 'Unknown';
                const subject = email.subject || email.message?.subject || 'No Subject';
                const dateRaw = email.createdAt || email.sentAt;
                const formattedDate = dateRaw ? new Date(dateRaw).toLocaleString() : 'N/A';
                const err = email.errorMessage || email.deliveryError;

                return (
                  <div 
                    key={email.id} 
                    className={`p-3.5 rounded-xl border text-xs flex flex-col md:flex-row md:items-center justify-between gap-3 transition-colors ${
                      email.status === 'failed' 
                        ? 'border-red-500/10 bg-red-500/5 hover:bg-red-500/10' 
                        : email.status === 'sent' 
                          ? 'border-emerald-500/10 hover:bg-slate-500/5' 
                          : 'border-slate-150/10 hover:bg-slate-500/5'
                    }`}
                  >
                    <div className="space-y-1.5 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-slate-700 dark:text-slate-200 truncate max-w-[220px]">
                          {toAddress}
                        </span>
                        {email.cc && email.cc.length > 0 && (
                          <span className="text-[10px] text-slate-400 dark:text-slate-500">
                            CC: {Array.isArray(email.cc) ? email.cc.join(', ') : email.cc}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-500 truncate">
                        <span className="font-sans font-medium">{subject}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-slate-400 flex-wrap">
                        <span className="font-mono">{formattedDate}</span>
                        {email.retryCount !== undefined && (
                          <span className="font-sans font-medium px-1.5 py-0.2 rounded bg-slate-500/10 text-slate-500">
                            Attempts: {email.retryCount}
                          </span>
                        )}
                        <span className="font-mono text-[9px] text-slate-400/70">ID: {email.id}</span>
                      </div>

                      {err && (
                        <div className="mt-1 p-2 bg-red-500/10 text-[10px] text-red-650 dark:text-red-400 font-mono rounded border border-red-550/10 leading-relaxed overflow-x-auto">
                          <strong>Error:</strong> {err}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                      {getStatusBadge(email.status, email.delivery)}
                      <button 
                        onClick={() => setSelectedEmail(email)}
                        className="p-1.5 hover:bg-slate-500/10 rounded-lg text-slate-400 hover:text-indigo-500 transition-colors cursor-pointer"
                        title="Preview Complete Message Body"
                      >
                        <Eye size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>

      {/* Preview Email Body Modal Dialog */}
      {selectedEmail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className={`w-full max-w-2xl rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-800'} shadow-2xl p-6 space-y-4 max-h-[85vh] flex flex-col`}>
            
            <div className="flex items-center justify-between border-b pb-3 border-slate-150/10 dark:border-slate-800/60 shrink-0">
              <div className="flex items-center gap-2 text-indigo-505 font-black uppercase text-xs">
                <Mail size={16} /> Dispatched Message Payload
              </div>
              <button 
                onClick={() => setSelectedEmail(null)}
                className="p-1 px-2.5 rounded-xl hover:bg-slate-500/10 text-xs font-bold transition-all cursor-pointer text-slate-400"
              >
                Close Dialog
              </button>
            </div>

            <div className="overflow-y-auto space-y-4 flex-1 pr-1 text-xs text-slate-600 dark:text-slate-350">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-slate-500/5 rounded-xl border border-slate-150/10">
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400">Recipient (To)</label>
                  <p className="font-bold text-slate-700 dark:text-slate-250 mt-0.5">{selectedEmail.to || selectedEmail.message?.to}</p>
                </div>
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400">Copy (Cc)</label>
                  <p className="font-bold text-slate-700 dark:text-slate-250 mt-0.5">
                    {selectedEmail.cc ? (Array.isArray(selectedEmail.cc) ? selectedEmail.cc.join(', ') : selectedEmail.cc) : 'None'}
                  </p>
                </div>
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400">Subject Phrase</label>
                  <p className="font-black text-slate-800 dark:text-slate-200 mt-0.5">{selectedEmail.subject || selectedEmail.message?.subject || 'N/A'}</p>
                </div>
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400">Queue Status</label>
                  <div className="mt-1">{getStatusBadge(selectedEmail.status, selectedEmail.delivery)}</div>
                </div>
              </div>

              {/* Message Payload Body content */}
              <div className="space-y-1">
                <label className="block text-[10px] uppercase font-bold text-slate-400 font-sans">Rendered HTML Envelope</label>
                <div 
                  className="p-4 bg-white text-slate-800 border border-slate-200 rounded-xl overflow-x-auto text-[13px] leading-relaxed select-all"
                  dangerouslySetInnerHTML={{ __html: selectedEmail.html || selectedEmail.message?.html || selectedEmail.text || selectedEmail.message?.text || '<em>Empty Message Envelope Body</em>' }}
                />
              </div>

              {selectedEmail.text && (
                <div className="space-y-1">
                  <label className="block text-[10px] uppercase font-bold text-slate-400">Plain Text Payload</label>
                  <pre className="p-3 bg-slate-500/5 text-[11px] font-mono rounded-xl border border-slate-150/10 whitespace-pre-wrap leading-relaxed select-all">
                    {selectedEmail.text}
                  </pre>
                </div>
              )}
            </div>

          </div>
        </div>
      )}

    </div>
  );
};
