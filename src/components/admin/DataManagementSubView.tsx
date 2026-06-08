import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../../lib/firebase';
import { collection, getDocs, doc, setDoc, deleteDoc, writeBatch, query, limit } from 'firebase/firestore';
import { Database, Trash2, Archive, RotateCcw, AlertTriangle, ShieldAlert, CheckSquare, Square, Inbox, Activity, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

interface DataManagementSubViewProps {
  adminTheme: 'light' | 'dark';
  onRefresh: () => void;
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export const DataManagementSubView: React.FC<DataManagementSubViewProps> = ({ 
  adminTheme, 
  onRefresh, 
  logAdminEvent 
}) => {
  const [activeSegment, setActiveSegment] = useState<'active' | 'archived'>('active');
  const [selectedCollection, setSelectedCollection] = useState<'audits' | 'tasks' | 'dailyPerformance' | 'disciplinaryLogs' | 'pips'>('audits');
  
  // Real Firestore documents
  const [records, setRecords] = useState<any[]>([]);
  const [archived, setArchived] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Selections
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Fetch logic for active records
  const fetchActiveRecords = async () => {
    setLoading(true);
    setSelectedIds(new Set());
    try {
      const snap = await getDocs(query(collection(db, selectedCollection), limit(100)));
      const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setRecords(list);
    } catch (err: any) {
      toast.error(`Error querying active items: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Fetch logic for archived records
  const fetchArchivedRecords = async () => {
    setLoading(true);
    setSelectedIds(new Set());
    try {
      const snap = await getDocs(query(collection(db, 'archived_records'), limit(150)));
      const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setArchived(list);
    } catch (err: any) {
      toast.error(`Error querying archived entries: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeSegment === 'active') {
      fetchActiveRecords();
    } else {
      fetchArchivedRecords();
    }
  }, [selectedCollection, activeSegment]);

  // Bulk selectors
  const toggleSelectAll = () => {
    const list = activeSegment === 'active' ? records : archived;
    if (selectedIds.size === list.length) {
      setSelectedIds(new Set());
    } else {
      const s = new Set<string>();
      list.forEach(item => s.add(item.id));
      setSelectedIds(s);
    }
  };

  const toggleSelectOne = (id: string) => {
    const s = new Set(selectedIds);
    if (s.has(id)) {
      s.delete(id);
    } else {
      s.add(id);
    }
    setSelectedIds(s);
  };

  // Archive Selected Records workflow
  const handleArchiveSelected = async () => {
    if (selectedIds.size === 0) {
      toast.error('Please select records to archive.');
      return;
    }
    if (!window.confirm(`Are you sure you want to ARCHIVE ${selectedIds.size} selected items? They will be removed from calculating averages.`)) return;

    setLoading(true);
    try {
      const batchArchive = writeBatch(db);
      const batchDelete = writeBatch(db);
      const selectedList = records.filter(item => selectedIds.has(item.id));

      selectedList.forEach(item => {
        // Prepare archive wrapper record
        const archId = `arch_${selectedCollection}_${item.id}`;
        const archMeta = {
          id: archId,
          originalId: item.id,
          originalCollection: selectedCollection,
          payload: item,
          archivedAt: new Date().toISOString(),
          archivedBy: 'Admin Workspace'
        };

        // Write to archived_records
        batchArchive.set(doc(db, 'archived_records', archId), archMeta);

        // Delete from original table
        batchDelete.delete(doc(db, selectedCollection, item.id));
      });

      await batchArchive.commit();
      await batchDelete.commit();

      toast.success(`Broadened archiving logic successfully across ${selectedIds.size} metrics profiles.`);
      logAdminEvent('Historical Records Moved to Archive', selectedCollection, `${selectedIds.size} records`, 'Physical Separation');
      
      setSelectedIds(new Set());
      fetchActiveRecords();
      onRefresh();
    } catch (err: any) {
      toast.error(`Archiving metrics write failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Permanent Delete workflow
  const handlePermanentDelete = async () => {
    if (selectedIds.size === 0) {
      toast.error('Please select records to terminate.');
      return;
    }
    if (!window.confirm(`⚠️ WARNING: Critical system database action! Permanent Delete cannot be undone! Are you absolutely sure you want to permanently delete these ${selectedIds.size} records?`)) return;

    setLoading(true);
    try {
      const batch = writeBatch(db);
      const list = activeSegment === 'active' ? records : archived;
      const filtered = list.filter(item => selectedIds.has(item.id));

      filtered.forEach(item => {
        if (activeSegment === 'active') {
          batch.delete(doc(db, selectedCollection, item.id));
        } else {
          batch.delete(doc(db, 'archived_records', item.id));
        }
      });

      await batch.commit();
      toast.success(`Irreversibly deleted ${selectedIds.size} database entities from the Firestore cluster.`);
      logAdminEvent('System entities terminated irreversibly', selectedCollection, `${selectedIds.size} items`, 'DocPurged');
      
      setSelectedIds(new Set());
      if (activeSegment === 'active') {
        fetchActiveRecords();
      } else {
        fetchArchivedRecords();
      }
      onRefresh();
    } catch (err: any) {
      toast.error(`Purging failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Restore Archived Records workflow
  const handleRestoreSelected = async () => {
    if (selectedIds.size === 0) {
      toast.error('Select archived records to restore.');
      return;
    }
    setLoading(true);
    try {
      const batchRestore = writeBatch(db);
      const batchDeleteArch = writeBatch(db);
      const selectedList = archived.filter(item => selectedIds.has(item.id));

      selectedList.forEach(item => {
        const origCol = item.originalCollection;
        const origId = item.originalId;
        const data = item.payload;

        if (origCol && origId && data) {
          // Write back to original
          batchRestore.set(doc(db, origCol, origId), data);
          // Delete from archived
          batchDeleteArch.delete(doc(db, 'archived_records', item.id));
        }
      });

      await batchRestore.commit();
      await batchDeleteArch.commit();

      toast.success(`Success: Restored ${selectedIds.size} historical indices back to active loops.`);
      logAdminEvent('Archived records recovered', selectedCollection, `${selectedIds.size} entities`, 'Activated again');
      
      setSelectedIds(new Set());
      fetchArchivedRecords();
      onRefresh();
    } catch (err: any) {
      toast.error(`Restoration failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const cardClass = adminTheme === 'dark' 
    ? 'bg-slate-805 border-slate-700 shadow-xl p-6 rounded-2xl border text-slate-100 bg-slate-800' 
    : 'bg-white border-slate-200 shadow-md p-6 rounded-2xl border text-slate-800';

  return (
    <div className="space-y-6">
      {/* Visual Safety warnings block */}
      <div className="flex gap-4 p-4 rounded-xl bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30 text-amber-800 dark:text-amber-500 flex-col md:flex-row text-xs">
        <AlertTriangle size={24} className="shrink-0 animate-bounce" />
        <div className="space-y-1">
          <strong>Database Safety Workspace Control Deck</strong>
          <p className="opacity-85 text-[11px] leading-relaxed">
            Adjustment triggers here can irreversibly modify the performance reporting tables. All operations have been audited dynamically. Archiving moves documents to a secure shadow storage, excluding them immediately from all averages.
          </p>
        </div>
      </div>

      <div className={cardClass}>
        
        {/* Sub segments buttons */}
        <div className="flex justify-between items-center border-b pb-4 mb-4 border-slate-150/10">
          <div className="flex gap-2">
            <button 
              onClick={() => setActiveSegment('active')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer flex items-center gap-1.5 ${activeSegment === 'active' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-900 border border-transparent hover:bg-slate-200'}`}
            >
              <Database size={14} /> Active Database Center
            </button>
            <button 
              onClick={() => setActiveSegment('archived')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer flex items-center gap-1.5 ${activeSegment === 'archived' ? 'bg-amber-600 text-white' : 'bg-slate-100 dark:bg-slate-900 border border-transparent hover:bg-slate-200'}`}
            >
              <Inbox size={14} /> View Vault Archive
            </button>
          </div>

          {activeSegment === 'active' && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase font-bold text-slate-400">Target Segment</span>
              <select 
                value={selectedCollection} 
                onChange={e => setSelectedCollection(e.target.value as any)}
                className={adminTheme === 'dark' ? 'bg-slate-900 text-xs px-2.5 py-1.5 rounded-lg border border-slate-700' : 'bg-white text-xs px-2.5 py-1.5 rounded-lg border border-slate-200'}
              >
                <option value="audits">Audits Records</option>
                <option value="tasks">Auditors Sampling Tasks</option>
                <option value="dailyPerformance">Daily Performance Achievements</option>
                <option value="disciplinaryLogs">Warnings & Logs</option>
                <option value="pips">PIPs Records</option>
              </select>
            </div>
          )}
        </div>

        {/* Action utility bar */}
        <div className="flex justify-between items-center gap-4 mb-4 text-xs font-semibold">
          <div className="flex items-center gap-2">
            <span>Selected <strong className="text-indigo-500">{selectedIds.size} records</strong>. Target Operations:</span>
          </div>

          <div className="flex items-center gap-2">
            {activeSegment === 'active' ? (
              <>
                <button onClick={handleArchiveSelected} className="px-3 py-1.5 text-xs font-bold font-mono rounded bg-amber-600 hover:bg-amber-700 text-white cursor-pointer flex items-center gap-1"><Archive size={12} /> Move to Vault Archive</button>
                <button onClick={handlePermanentDelete} className="px-3 py-1.5 text-xs font-bold font-mono rounded bg-rose-600 hover:bg-rose-705 text-white cursor-pointer flex items-center gap-1"><Trash2 size={12} /> Permanent Purge</button>
              </>
            ) : (
              <>
                <button onClick={handleRestoreSelected} className="px-3 py-1.5 text-xs font-bold font-mono rounded bg-indigo-600 hover:bg-indigo-705 text-white cursor-pointer flex items-center gap-1"><RotateCcw size={12} /> Restore Back</button>
                <button onClick={handlePermanentDelete} className="px-3 py-1.5 text-xs font-bold font-mono rounded bg-rose-600 hover:bg-rose-705 text-white cursor-pointer flex items-center gap-1"><Trash2 size={12} /> Permanent Destruction</button>
              </>
            )}
          </div>
        </div>

        {/* Display grid */}
        <div className="overflow-hidden border border-slate-205 dark:border-slate-700 rounded-xl max-h-[350px] overflow-y-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={adminTheme === 'dark' ? 'bg-slate-900 sticky top-0' : 'bg-slate-50 sticky top-0'}>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th className="p-3 w-10 text-center">
                  <button onClick={toggleSelectAll} className="p-0.5 text-slate-405">
                    {(() => {
                      const list = activeSegment === 'active' ? records : archived;
                      return selectedIds.size === list.length && list.length > 0 ? (
                        <CheckSquare size={14} className="text-indigo-500" />
                      ) : (
                        <Square size={14} />
                      );
                    })()}
                  </button>
                </th>
                <th className="p-3">Reference DocID</th>
                {activeSegment === 'active' ? (
                  <>
                    <th className="p-3">Audit Details / Descriptor Name</th>
                    <th className="p-3">Mapped StaffID</th>
                    <th className="p-3">Campaign Group</th>
                    <th className="p-3">Recorded Date</th>
                  </>
                ) : (
                  <>
                    <th className="p-3">Original Table</th>
                    <th className="p-3">Index Date</th>
                    <th className="p-3">Archived Timestamp</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-400 font-mono">Parsing Database collections...</td>
                </tr>
              ) : (
                (() => {
                  const list = activeSegment === 'active' ? records : archived;
                  if (list.length === 0) {
                    return (
                      <tr>
                        <td colSpan={6} className="p-12 text-center text-slate-400 font-medium">
                          No database records currently stored matching this collection.
                        </td>
                      </tr>
                    );
                  }
                  return list.map(item => {
                    const isS = selectedIds.has(item.id);
                    return (
                      <tr key={item.id} className={adminTheme === 'dark' ? 'hover:bg-slate-905 border-b border-slate-800/40' : 'hover:bg-slate-50/50 border-b border-slate-100'}>
                        <td className="p-3 text-center">
                          <button onClick={() => toggleSelectOne(item.id)} className="p-0.5 text-slate-400">
                            {isS ? <CheckSquare size={14} className="text-indigo-500" /> : <Square size={14} />}
                          </button>
                        </td>
                        <td className="p-3 font-mono font-bold text-slate-500">{item.id}</td>
                        {activeSegment === 'active' ? (
                          <>
                            <td className="p-3 font-bold">{item.qvName || item.agentName || item.sellerId || item.title || 'N/A'}</td>
                            <td className="p-3 font-mono font-bold text-[11px] opacity-75">{item.agentId || item.assignedQaId || 'N/A'}</td>
                            <td className="p-3 font-medium opacity-85">{item.process || item.vertical || 'N/A'}</td>
                            <td className="p-3 opacity-75">{item.auditDate || item.createdAt || item.date || 'N/A'}</td>
                          </>
                        ) : (
                          <>
                            <td className="p-3 font-bold text-amber-500 uppercase">{item.originalCollection}</td>
                            <td className="p-3 font-mono text-[11px] opacity-85">{item.originalId}</td>
                            <td className="p-3 font-mono text-[10px] opacity-75">{new Date(item.archivedAt).toLocaleString()}</td>
                          </>
                        )}
                      </tr>
                    );
                  });
                })()
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={cardClass}>
        <div className="flex items-center gap-4 mb-5">
          <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center">
            <ShieldAlert size={24} />
          </div>
          <div>
            <h4 className="text-sm font-black uppercase tracking-tight">User Roster Synchronization & Repair</h4>
            <p className="text-[11px] text-slate-400 font-medium">Reconcile Firebase Auth, User Profiles, and Employee Master collections</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 space-y-3">
            <h5 className="text-xs font-bold flex items-center gap-2"><Activity size={14} className="text-indigo-500" /> Database Health Checks</h5>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Scan all user documents for missing status flags, malformed IDs, or legacy schema fields that cause dashboard mismatch.
            </p>
            <button 
              onClick={async () => {
                const loader = toast.loading('Running User Database health scan...');
                try {
                  const usersSnap = await getDocs(collection(db, 'users'));
                  const batch = writeBatch(db);
                  let repairCount = 0;
                  
                  usersSnap.docs.forEach(d => {
                    const data = d.data();
                    let needsRepair = false;
                    const updates: any = {};
                    
                    if (!data.status) { updates.status = 'Active'; needsRepair = true; }
                    if (!data.uid) { updates.uid = d.id; needsRepair = true; }
                    if (!data.createdAt) { updates.createdAt = new Date().toISOString(); needsRepair = true; }

                    if (needsRepair) {
                      batch.update(d.ref, updates);
                      repairCount++;
                    }
                  });

                  if (repairCount > 0) {
                    await batch.commit();
                    toast.success(`Scan complete: Repaired ${repairCount} user profile schemas.`);
                    logAdminEvent('User Database Health Scan', 'System Users', 'Legacy Data', `Repaired ${repairCount} records`);
                  } else {
                    toast.success('Scan complete: No issues detected in User Profile collection.');
                  }
                  onRefresh();
                } catch (err: any) {
                  toast.error(`Scan failed: ${err.message}`);
                } finally {
                  toast.dismiss(loader);
                }
              }}
              className="w-full py-2 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 text-slate-600 font-bold text-[10px] rounded-lg transition-all cursor-pointer"
            >
              Run Database Health Scan
            </button>
          </div>

          <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 space-y-3">
            <h5 className="text-xs font-bold flex items-center gap-2"><RefreshCw size={14} className="text-emerald-500" /> Collection Reconciliation</h5>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Synchronize 'User Profiles' with 'Employee Master' to ensure 100% data mirroring and consistent dashboard reporting.
            </p>
            <button 
              onClick={async () => {
                const loader = toast.loading('Reconciling Roster collections...');
                try {
                  const usersSnap = await getDocs(collection(db, 'users'));
                  const batch = writeBatch(db);
                  
                  usersSnap.docs.forEach(d => {
                    const data = d.data();
                    const masterDocRef = doc(db, 'employee_master', d.id);
                    batch.set(masterDocRef, {
                      ...data,
                      uid: d.id,
                      status: data.status || 'Active',
                    }, { merge: true });
                  });

                  await batch.commit();
                  toast.success(`Success: Mirrored ${usersSnap.size} profiles to Employee Master.`);
                  logAdminEvent('Collection Reconciliation', 'Employee Master', 'Partial Sync', 'Full Mirror Sync Complete');
                  onRefresh();
                } catch (err: any) {
                  toast.error(`Sync failed: ${err.message}`);
                } finally {
                  toast.dismiss(loader);
                }
              }}
              className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] rounded-lg shadow-sm transition-all cursor-pointer"
            >
              Trigger Full Collection Mirror
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
