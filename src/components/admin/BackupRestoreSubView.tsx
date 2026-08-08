import React, { useState, useEffect } from 'react';
import { db, auth } from '../../lib/firebase';
import { collection, getDocs, doc, setDoc, deleteDoc, writeBatch, query, orderBy, limit } from 'firebase/firestore';
import { CloudLightning, Download, Upload, Check, RefreshCw, Calendar, Eye, Users, Database, Clock, CalendarRange, ShieldAlert, Activity, FileSearch } from 'lucide-react';
import { toast } from 'sonner';
import { runPermissionDiagnostic, performPermissionRecovery, DiagnosticResult } from '../../lib/permissionRecovery';

interface BackupRestoreSubViewProps {
  adminTheme: 'light' | 'dark';
  onRefresh: () => void;
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export const BackupRestoreSubView: React.FC<BackupRestoreSubViewProps> = ({ 
  adminTheme, 
  onRefresh, 
  logAdminEvent 
}) => {
  const [backups, setBackups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<DiagnosticResult | null>(null);

  const handleRunDiagnostic = async () => {
    setDiagnosing(true);
    try {
      const res = await runPermissionDiagnostic();
      setDiagResult(res);
      toast.success('Access diagnostic complete. Review the report below.');
    } catch (err: any) {
      toast.error('Diagnostic failed: ' + err.message);
    } finally {
      setDiagnosing(false);
    }
  };

  const handleRecovery = async () => {
    if (!window.confirm('URGENT: This will rebuild the entire Permission Matrix for all roles based on system defaults. This is intended to recover from "No Modules Assigned" errors. Proceed?')) return;
    
    const loader = toast.loading('Rebuilding permission matrix...');
    try {
      await performPermissionRecovery();
      toast.success('Permission Matrix recovered successfully! Users should now see their modules.');
      logAdminEvent('Emergency Access Recovery', 'Role Permissions', 'Empty/Corrupt', 'Restored to Defaults');
      setDiagResult(null);
      if (onRefresh) onRefresh();
    } catch (err: any) {
      toast.error('Recovery failed: ' + err.message);
    } finally {
      toast.dismiss(loader);
    }
  };
  
  // Settings
  const [backupInterval, setBackupInterval] = useState('Weekly');
  const [autoBackup, setAutoBackup] = useState(true);

  // Restore Local File Prev state
  const [parsedRestoreData, setParsedRestoreData] = useState<any>(null);

  const fetchBackupsAndSettings = async () => {
    setLoading(true);
    try {
      // 1. Fetch Cloud Backups list
      const q = query(collection(db, 'admin_backups'), orderBy('timestamp', 'desc'), limit(50));
      const snap = await getDocs(q);
      const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setBackups(list);

      // 2. Fetch Settings
      const setSnap = await getDocs(collection(db, 'config'));
      const setDocItem = setSnap.docs.find(d => d.id === 'backupSettings');
      if (setDocItem) {
        const data = setDocItem.data();
        setBackupInterval(data.backupInterval || 'Weekly');
        setAutoBackup(data.autoBackup ?? true);
      }
    } catch (err) {
      console.warn('Could not read backups data lists: ', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBackupsAndSettings();
  }, []);

  // Save Scheduled Config to Firestore
  const handleSaveSettings = async () => {
    try {
      await setDoc(doc(db, 'config', 'backupSettings'), {
        backupInterval,
        autoBackup,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      toast.success('Automatic database scheduling intervals modified successfully!');
      logAdminEvent('Backup Interval Reconfigured', 'Backup Scheduler', 'Previous Mode', backupInterval);
    } catch (err: any) {
      toast.error('Writing settings doc failed.');
    }
  };

  // Compile full backup
  const handleManualBackup = async () => {
    toast.info('Generating system configurations snapshot...');
    try {
      const collections = ['users', 'config', 'tasks', 'audits', 'disciplinaryLogs', 'pips', 'importantLinks', 'dailyPerformance'];
      const backupData: Record<string, any[]> = {};
      const counts: Record<string, number> = {};

      for (const col of collections) {
        const snap = await getDocs(collection(db, col));
        backupData[col] = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        counts[col] = snap.docs.length;
      }

      const backupString = JSON.stringify(backupData, null, 2);
      const backupId = `bk_${Date.now()}`;
      const timestamp = new Date().toISOString();
      const currentUserEmail = auth.currentUser?.email || 'admin@precision360.com';

      // Firestore document size limit is 1,048,576 bytes.
      // We will split the backup content into 800,000 character chunks if it's large.
      const isLarge = backupString.length > 800000;

      if (isLarge) {
        toast.info('Payload is large. Processing chunked secure transfer...');
        const CHUNK_SIZE = 800000;
        const chunks: string[] = [];
        for (let i = 0; i < backupString.length; i += CHUNK_SIZE) {
          chunks.push(backupString.substring(i, i + CHUNK_SIZE));
        }

        // Store metadata in parent document
        await setDoc(doc(db, 'admin_backups', backupId), {
          id: backupId,
          timestamp,
          createdBy: currentUserEmail,
          recordCounts: counts,
          hasContentInChunks: true,
          numChunks: chunks.length
        });

        // Store chunks in a subcollection
        for (let i = 0; i < chunks.length; i++) {
          await setDoc(doc(db, 'admin_backups', backupId, 'chunks', `chunk_${i}`), {
            index: i,
            content: chunks[i]
          });
        }
      } else {
        // Store normally as a single document
        await setDoc(doc(db, 'admin_backups', backupId), {
          id: backupId,
          timestamp,
          createdBy: currentUserEmail,
          recordCounts: counts,
          backupContent: backupString
        });
      }

      // 2. Client download trigger (always triggers complete backup file download)
      const blob = new Blob([backupString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Precision360_Snapshot_${timestamp.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);

      toast.success('Prerecorded system checkpoint saved and downloaded locally!');
      logAdminEvent('Manual System Backup Prepared', 'Whole DB Snapshot', 'Live State', backupId);
      fetchBackupsAndSettings();
    } catch (err: any) {
      toast.error(`Database compilation failed: ${err.message}`);
    }
  };

  // Cloud Restore activation
  const handleRestoreCloudItem = async (bItem: any) => {
    if (!window.confirm(`⚠️ CRITICAL RECOVERY OVERRIDE! Are you absolutely sure you want to restore snapshot from ${new Date(bItem.timestamp).toLocaleString()}? Existing database values will be completely overwritten.`)) return;
    try {
      let backupContentStr = '';
      if (bItem.hasContentInChunks) {
        toast.info('Fetching backup chunks from Cloud storage...');
        const chunksSnap = await getDocs(collection(db, 'admin_backups', bItem.id, 'chunks'));
        const sortedChunks = chunksSnap.docs
          .map(doc => doc.data())
          .sort((a: any, b: any) => a.index - b.index);
        backupContentStr = sortedChunks.map((c: any) => c.content).join('');
      } else {
        backupContentStr = bItem.backupContent;
      }

      if (!backupContentStr) {
        throw new Error('Backup content is empty or could not be retrieved.');
      }

      const data = JSON.parse(backupContentStr);
      await executeDataRestoration(data);
    } catch (err: any) {
      toast.error('Error recovering data: ' + err.message);
    }
  };

  // Local File Restore Trigger
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const parsed = JSON.parse(evt.target?.result as string);
          setParsedRestoreData(parsed);
          toast.info('Checkpoint file parsed. Review entity summary below before clicking Recover.');
        } catch (err) {
          toast.error('Malformed JSON file check.');
        }
      };
      reader.readAsText(file);
    }
  };

  const handleLocalRestoreApply = async () => {
    if (!parsedRestoreData) return;
    if (!window.confirm('Trigger recovery from uploaded local file?')) return;
    await executeDataRestoration(parsedRestoreData);
    setParsedRestoreData(null);
  };

  // Restoration Engine
  const executeDataRestoration = async (data: Record<string, any[]>) => {
    toast.info('Establishing database pipes recovery...');
    try {
      for (const [colName, recordsList] of Object.entries(data)) {
        if (!Array.isArray(recordsList)) continue;
        
        // chunk write batches of 200 documents
        const CHUNK = 200;
        for (let i = 0; i < recordsList.length; i += CHUNK) {
          const batch = writeBatch(db);
          const chunkItem = recordsList.slice(i, i + CHUNK);
          
          chunkItem.forEach(item => {
            const { id, ...payload } = item;
            if (id) {
              const docRef = doc(db, colName, id);
              batch.set(docRef, payload, { merge: true });
            }
          });

          await batch.commit();
        }
      }
      toast.success('Database structural elements, users and alignments recovered safely!');
      logAdminEvent('System checkpoint Restored', 'All Active Collections', 'Old checkpoint', 'Rebuilt');
      onRefresh();
    } catch (err: any) {
      toast.error(`Database pipelines failed to recover: ${err.message}`);
    }
  };

  const handleDeleteBackupDoc = async (id: string) => {
    if (!window.confirm('Delete this backup snapshot record from Cloud catalog?')) return;
    try {
      // 1. Check and clean up chunks from the subcollection first
      const chunksSnap = await getDocs(collection(db, 'admin_backups', id, 'chunks'));
      if (!chunksSnap.empty) {
        const batch = writeBatch(db);
        chunksSnap.docs.forEach(docSnap => {
          batch.delete(docSnap.ref);
        });
        await batch.commit();
      }

      // 2. Delete parent document
      await deleteDoc(doc(db, 'admin_backups', id));
      toast.info('Historical index deleted.');
      fetchBackupsAndSettings();
    } catch (err: any) {
      toast.error('Deletion error: ' + err.message);
    }
  };

  const cardClass = 'bg-white border text-slate-800 border-slate-200 shadow-md p-6 rounded-2xl dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100';

  return (
    <div className="space-y-6">
      
      {/* Dynamic Header row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Manual Checkpoint Button Card */}
        <div className={`${cardClass} md:col-span-2 flex flex-col justify-between`}>
          <div className="space-y-1">
            <h3 className="text-base font-extrabold flex items-center gap-1.5 text-indigo-505">
              <CloudLightning size={18} className="text-indigo-500" /> Manual System Checkpoint
            </h3>
            <p className="text-xs text-slate-400 leading-normal">
              Bundle entire roster configurations database, personnel mappings, audits, warnings, and system metrics configurations into one downloadable JSON backup file.
            </p>
          </div>
          <div className="pt-6">
            <button 
              onClick={handleManualBackup} 
              className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-2 shadow-md cursor-pointer transition-all"
            >
              <Download size={14} /> Pack Database Checkpoint
            </button>
          </div>
        </div>

        {/* Intervals config Card */}
        <div className={cardClass}>
          <h3 className="text-sm font-extrabold pb-3 border-b mb-4 font-mono select-none uppercase tracking-wider text-slate-400">Automated Backup Cron</h3>
          
          <div className="space-y-4 text-xs font-semibold">
            <div className="space-y-1">
              <label className="block text-[10px] text-slate-400 uppercase font-bold">Snapshot Interval</label>
              <select 
                value={backupInterval}
                onChange={e => setBackupInterval(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-900/60 p-2 border border-slate-205 dark:border-slate-700 rounded-lg"
              >
                <option value="Daily">Daily Snapshot</option>
                <option value="Weekly">Weekly Checkpoint</option>
                <option value="Monthly">Monthly Preservation</option>
              </select>
            </div>

            <div className="flex items-center justify-between py-1">
              <span className="text-xs">Continuous Cloud Preservation</span>
              <button 
                onClick={() => setAutoBackup(!autoBackup)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  autoBackup ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${autoBackup ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>

            <button 
              onClick={handleSaveSettings}
              className="w-full py-2 bg-slate-800 border border-slate-700 hover:bg-slate-700 text-white font-bold rounded-lg cursor-pointer"
            >
              Apply Cron Intervals
            </button>
          </div>
        </div>
      </div>

      {/* Local File Restoring deck */}
      <div className={cardClass}>
        <h4 className="text-sm font-extrabold flex items-center gap-1.5 text-emerald-500 mb-2 uppercase tracking-wider">
          <Upload size={16} /> Recover system from checkpoint file
        </h4>
        <p className="text-xs text-slate-400 mb-4 leading-relaxed">
          Restore database tables by uploading a previously packed checkpoint. This is executed inside atomic batch sequences.
        </p>

        <div className="p-4 border border-dashed border-slate-202 dark:border-slate-700 rounded-xl bg-slate-50 dark:bg-slate-800/40 text-center flex flex-col items-center justify-center gap-2">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Select and Drag .json Checkpoint File</span>
          <input 
            type="file" 
            accept=".json" 
            onChange={handleFileChange} 
            className="text-xs text-slate-505 cursor-pointer max-w-xs"
          />
        </div>

        {/* File Parser previews table */}
        {parsedRestoreData && (
          <div className="mt-4 p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 text-xs">
            <h5 className="font-bold text-emerald-500 mb-2 flex items-center gap-1"><Eye size={12} /> Entity Checkpoint Summary</h5>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] font-semibold">
              {Object.entries(parsedRestoreData).map(([col, items]) => (
                <div key={col} className="p-2 rounded bg-slate-50 dark:bg-slate-800 border">
                  <span className="text-slate-400 block uppercase text-[9px]">{col}</span>
                  <strong className="text-sm">{(items as any[]).length} entries</strong>
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setParsedRestoreData(null)} className="px-3 py-1 bg-slate-200 text-slate-700 rounded hover:bg-slate-350 text-xs font-bold cursor-pointer">Discard File</button>
              <button onClick={handleLocalRestoreApply} className="px-3 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 text-xs font-bold cursor-pointer">Recover This Checkpoint</button>
            </div>
          </div>
        )}
      </div>

      {/* URGENT ACCESS RECOVERY - EMERGENCY TOOL */}
      <div className={`${cardClass} border-rose-500/30 bg-rose-500/5`}>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
          <div className="space-y-1">
            <h3 className="text-base font-black flex items-center gap-2 text-rose-500 uppercase tracking-tighter">
              <ShieldAlert size={20} className="animate-pulse" /> Urgent Access Recovery Console
            </h3>
            <p className="text-xs text-slate-500 font-medium">
              Diagnostic & Automated repair for "No Modules Assigned" errors.
            </p>
          </div>
        </div>

        {diagResult && (
          <div className="mt-4 p-5 rounded-2xl bg-white dark:bg-slate-950 border border-rose-500/20 animate-in slide-in-from-top-4 duration-300">
            <h4 className="text-xs font-black text-slate-800 dark:text-white uppercase mb-4 flex items-center gap-2">
              <Eye size={14} className="text-rose-500" /> Access Diagnostic Report
            </h4>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase">Missing Role Definitions</label>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {diagResult.missingRoles.length > 0 ? diagResult.missingRoles.map(r => (
                      <span key={r} className="px-2 py-0.5 bg-rose-100 text-rose-600 text-[10px] font-bold rounded border border-rose-200">{r}</span>
                    )) : <span className="text-[10px] text-emerald-500 font-bold">● All defined</span>}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase">Roles with Broken Permissions</label>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {diagResult.missingPermissionsRoles.length > 0 ? diagResult.missingPermissionsRoles.map(r => (
                      <span key={r} className="px-2 py-0.5 bg-amber-100 text-amber-600 text-[10px] font-bold rounded border border-amber-200">{r}</span>
                    )) : <span className="text-[10px] text-emerald-500 font-bold">● All synced</span>}
                  </div>
                </div>
              </div>

              <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">System Log Events</label>
                <div className="space-y-1.5 max-h-32 overflow-y-auto pr-2">
                  {diagResult.reportLogs.map((log, i) => (
                    <p key={i} className="text-[10px] font-mono text-slate-500 leading-tight">
                      <span className="text-slate-300">[{i+1}]</span> {log}
                    </p>
                  ))}
                  {diagResult.invalidRoleUsers.length > 0 && (
                     <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                        <p className="text-[10px] text-rose-500 font-black mb-1">Users with Invalid Roles:</p>
                        {diagResult.invalidRoleUsers.map((u, i) => (
                          <p key={i} className="text-[10px] font-bold text-slate-600">{u}</p>
                        ))}
                     </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button 
                onClick={() => setDiagResult(null)}
                className="px-4 py-1.5 text-[10px] font-bold text-slate-400 hover:text-slate-600 uppercase"
              >
                Close Report
              </button>
              <button 
                onClick={handleRecovery}
                className="px-4 py-1.5 bg-rose-600 text-white rounded-lg text-[10px] font-black uppercase shadow-sm"
              >
                Sync All Permissions Now
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Cloud Checkpoint Lists table */}
      <div className={cardClass}>
        <div className="flex items-center gap-2 mb-4">
          <CalendarRange size={16} className="text-indigo-405" />
          <h4 className="text-sm font-extrabold uppercase tracking-wider">Cloud Checkpoint Archiver Registry</h4>
        </div>

        <div className={`overflow-hidden border rounded-xl ${adminTheme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className={adminTheme === 'dark' ? 'bg-slate-900 border-b border-slate-800 font-bold uppercase text-[10px]' : 'bg-slate-50 border-b border-slate-200 font-bold uppercase text-[10px]'}>
                <tr>
                  <th className="p-3 pl-4">Snapshot Timestamp</th>
                  <th className="p-3">Reference Checkpoint ID</th>
                  <th className="p-3">Created By</th>
                  <th className="p-3">Structural Ratios Check</th>
                  <th className="p-3 text-right pr-6">Manage Checkpoints</th>
                </tr>
              </thead>
              <tbody>
                {backups.length > 0 ? (
                  backups.map(bk => (
                    <tr key={bk.id} className={adminTheme === 'dark' ? 'hover:bg-slate-900/60 border-b border-slate-800/40' : 'hover:bg-slate-50/50 border-b border-slate-100'}>
                      <td className="p-3 pl-4 font-mono text-[10px] opacity-75 flex items-center gap-1">
                        <Clock size={11} /> {new Date(bk.timestamp).toLocaleString()}
                      </td>
                      <td className="p-3 font-mono font-bold text-indigo-505">{bk.id}</td>
                      <td className="p-3 opacity-90">{bk.createdBy}</td>
                      <td className="p-3 max-w-[200px] truncate leading-normal text-slate-400 text-[10px]" title={JSON.stringify(bk.recordCounts)}>
                        {bk.recordCounts ? Object.entries(bk.recordCounts).map(([k,v]) => `${k}:${v}`).join(', ') : 'N/A'}
                      </td>
                      <td className="p-3 text-right pr-6">
                        <div className="flex items-center justify-end gap-2 text-xs">
                          <button 
                            onClick={() => handleRestoreCloudItem(bk)}
                            className="px-2.5 py-1 rounded bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500 hover:text-white font-bold cursor-pointer font-mono"
                          >
                            Restore
                          </button>
                          <button 
                            onClick={() => handleDeleteBackupDoc(bk.id)}
                            className="p-1 px-1.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded transition-colors cursor-pointer"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="p-10 text-center text-slate-400 font-semibold font-mono text-xs">No recorded backup checkpoint metadata saved to Cloud servers. Click Build Checkpoint above.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  );
};
