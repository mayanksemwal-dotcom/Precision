import React, { useState, useMemo, useEffect } from 'react';
import { 
  X, CheckCircle2, AlertTriangle, Download, RefreshCw, FileSpreadsheet, ShieldAlert, Users, ArrowRight, Info
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { doc, writeBatch } from 'firebase/firestore';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { safeStorage } from '../../lib/safeStorage';
import { useRoster } from '../../contexts/RosterContext';

interface IdentityNormalizationModalProps {
  isOpen: boolean;
  onClose: () => void;
  allUsers: any[];
  adminTheme: 'light' | 'dark';
  onRefresh: () => void;
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export interface NormalizationRow {
  employeeEmail: string;
  employeeUid: string;
  employeeName: string;
  managerName: string;
  managerEmail: string;
  existingManagerId: string;
  canonicalManagerUid: string;
  existingTlId: string;
  canonicalTlUid: string;
  action: 'NORMALIZE_TL' | 'NORMALIZE_MGR' | 'NORMALIZE_BOTH' | 'NONE';
  status: 'PENDING' | 'NORMALIZED' | 'ERROR';
  details?: string;
  userRecord: any;
}

export const IdentityNormalizationModal: React.FC<IdentityNormalizationModalProps> = ({
  isOpen,
  onClose,
  allUsers,
  adminTheme,
  onRefresh,
  logAdminEvent
}) => {
  const { updateMultipleUsersInRoster } = useRoster();
  const [rows, setRows] = useState<NormalizationRow[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);

  useEffect(() => {
    if (isOpen && !hasScanned) {
      scanForCorruptions();
    }
  }, [isOpen, hasScanned]);

  const scanForCorruptions = () => {
    setIsScanning(true);
    
    setTimeout(() => {
      try {
        const emailToCanonicalUid = new Map<string, string>();
        const uidToEmail = new Map<string, string>();

        // Build canonical maps
        allUsers.forEach(u => {
          if (u.email && u.uid && !u.uid.startsWith('local_')) {
            emailToCanonicalUid.set(u.email.toLowerCase().trim(), u.uid);
          }
          if (u.email && u.uid) {
            uidToEmail.set(u.uid, u.email.toLowerCase().trim());
          }
        });

        const newRows: NormalizationRow[] = [];

        allUsers.forEach(u => {
          const rawTlUid = u.teamLeadUid || u.teamLeadId || u.tlId || '';
          const rawMgrUid = u.mappedManagerUid || u.mappedManagerId || u.managerUid || u.managerId || '';

          let canonicalTlUid = rawTlUid;
          let canonicalMgrUid = rawMgrUid;

          let tlNeedsFix = false;
          let mgrNeedsFix = false;

          // Resolve TL
          if (u.teamLeadEmail) {
            const canon = emailToCanonicalUid.get(u.teamLeadEmail.toLowerCase().trim());
            if (canon && canon !== rawTlUid) {
              canonicalTlUid = canon;
              tlNeedsFix = true;
            }
          } else if (rawTlUid && rawTlUid.startsWith('local_')) {
            const email = uidToEmail.get(rawTlUid);
            if (email) {
              const canon = emailToCanonicalUid.get(email);
              if (canon && canon !== rawTlUid) {
                canonicalTlUid = canon;
                tlNeedsFix = true;
              }
            }
          }

          // Resolve Manager
          if (u.managerEmail || u.mappedManagerEmail) {
            const mgrEmail = (u.managerEmail || u.mappedManagerEmail).toLowerCase().trim();
            const canon = emailToCanonicalUid.get(mgrEmail);
            if (canon && canon !== rawMgrUid) {
              canonicalMgrUid = canon;
              mgrNeedsFix = true;
            }
          } else if (rawMgrUid && rawMgrUid.startsWith('local_')) {
            const email = uidToEmail.get(rawMgrUid);
            if (email) {
              const canon = emailToCanonicalUid.get(email);
              if (canon && canon !== rawMgrUid) {
                canonicalMgrUid = canon;
                mgrNeedsFix = true;
              }
            }
          }

          if (tlNeedsFix || mgrNeedsFix) {
            let action: NormalizationRow['action'] = 'NONE';
            if (tlNeedsFix && mgrNeedsFix) action = 'NORMALIZE_BOTH';
            else if (tlNeedsFix) action = 'NORMALIZE_TL';
            else if (mgrNeedsFix) action = 'NORMALIZE_MGR';

            newRows.push({
              employeeEmail: u.email || '',
              employeeUid: u.uid,
              employeeName: u.fullName || u.name || '',
              managerName: u.managerName || u.mappedManagerName || u.teamLeadName || '',
              managerEmail: u.managerEmail || u.mappedManagerEmail || u.teamLeadEmail || '',
              existingManagerId: rawMgrUid || rawTlUid || '',
              canonicalManagerUid: canonicalMgrUid || canonicalTlUid || '',
              existingTlId: rawTlUid,
              canonicalTlUid: canonicalTlUid,
              action,
              status: 'PENDING',
              userRecord: u
            });
          }
        });

        setRows(newRows);
        setHasScanned(true);
      } catch (err) {
        console.error('Scan error:', err);
        toast.error('Failed to scan for identity corruptions.');
      } finally {
        setIsScanning(false);
      }
    }, 500); // Small artificial delay for UI feedback
  };

  const handleCommit = async () => {
    if (rows.length === 0) return;
    setIsCommitting(true);
    
    try {
      const batch = writeBatch(db);
      const updatedUsers: any[] = [];
      const updatedRows = [...rows];

      for (let i = 0; i < updatedRows.length; i++) {
        const row = updatedRows[i];
        if (row.status !== 'PENDING') continue;

        try {
          const updateData: any = {};
          if (row.action === 'NORMALIZE_TL' || row.action === 'NORMALIZE_BOTH') {
            updateData.teamLeadUid = row.canonicalTlUid;
            updateData.teamLeadId = row.canonicalTlUid;
          }
          if (row.action === 'NORMALIZE_MGR' || row.action === 'NORMALIZE_BOTH') {
            updateData.mappedManagerUid = row.canonicalManagerUid;
            updateData.mappedManagerId = row.canonicalManagerUid;
            updateData.managerUid = row.canonicalManagerUid;
            updateData.managerId = row.canonicalManagerUid;
          }
          updateData.lastModifiedAt = new Date().toISOString();
          updateData.lastUpdated = new Date().toISOString();

          batch.update(doc(db, 'users', row.employeeUid), updateData);
          batch.update(doc(db, 'employee_master', row.employeeUid), updateData);

          updatedUsers.push({
            ...row.userRecord,
            ...updateData
          });

          row.status = 'NORMALIZED';
        } catch (err: any) {
          row.status = 'ERROR';
          row.details = err.message;
        }
      }

      await batch.commit();

      if (updatedUsers.length > 0) {
        await updateMultipleUsersInRoster(updatedUsers);
        try {
          await safeStorage.clearAllIndexedDBByPrefix('precision360_hierarchy_nodes_');
          await safeStorage.clearAllIndexedDBByPrefix('subordinates_');
        } catch (e) {
          console.warn('Cache clear failed:', e);
        }
        await logAdminEvent('Hierarchy Identity Normalization', `${updatedUsers.length} profiles`, 'Legacy IDs', 'Canonical UIDs');
        toast.success(`Successfully normalized ${updatedUsers.length} identity references.`);
        onRefresh();
      }

      setRows(updatedRows);
    } catch (err: any) {
      console.error('Commit error:', err);
      toast.error(`Failed to commit normalizations: ${err.message}`);
    } finally {
      setIsCommitting(false);
    }
  };

  const exportReport = () => {
    if (rows.length === 0) return;
    
    const exportData = rows.map(r => ({
      'Employee Email': r.employeeEmail,
      'Employee UID': r.employeeUid,
      'Manager Name': r.managerName,
      'Manager Email': r.managerEmail,
      'Existing Manager ID': r.existingManagerId || r.existingTlId,
      'Canonical Manager UID': r.canonicalManagerUid || r.canonicalTlUid,
      'Action': r.action,
      'Status': r.status
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Normalization Report');
    XLSX.writeFile(wb, `Identity_Normalization_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className={`max-w-6xl w-full max-h-[90vh] flex flex-col border shadow-2xl rounded-2xl overflow-hidden ${adminTheme === 'dark' ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
        
        {/* Header */}
        <div className={`p-4 border-b flex items-center justify-between shrink-0 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-500">
              <ShieldAlert size={20} />
            </div>
            <div>
              <h2 className="text-lg font-black text-slate-800 dark:text-slate-100 uppercase tracking-wide">
                Hierarchy Identity Normalization
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Resolve and repair legacy local_* IDs to canonical Firebase/Auth UIDs.
              </p>
            </div>
          </div>
          <button onClick={onClose} disabled={isCommitting} className="p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6 space-y-6">
          
          <div className={`p-4 rounded-xl border flex items-start gap-4 ${adminTheme === 'dark' ? 'bg-indigo-500/10 border-indigo-500/20' : 'bg-indigo-50 border-indigo-100'}`}>
            <Info size={24} className="text-indigo-500 shrink-0 mt-0.5" />
            <div className="text-sm text-indigo-900 dark:text-indigo-200 space-y-2">
              <p><strong>Identity Normalization Protocol</strong></p>
              <p>This tool scans all users to detect and repair hierarchy references that point to duplicate or legacy local IDs (e.g., <code>local_YXJwa...</code>).</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Resolves Supervisor/Manager identities by their exact Email Address.</li>
                <li>Ensures all hierarchy links use the one true Canonical UID.</li>
                <li>Does not modify employee status, roles, or existing structures—only normalizes the ID reference.</li>
              </ul>
            </div>
          </div>

          {isScanning ? (
            <div className="flex flex-col items-center justify-center p-12 space-y-4">
              <RefreshCw size={32} className="text-indigo-500 animate-spin" />
              <p className="text-sm font-semibold text-slate-500">Scanning {allUsers.length} profiles for identity discrepancies...</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-slate-800 dark:text-slate-200">
                    Discrepancies Found: {rows.length}
                  </h3>
                  {rows.length === 0 && hasScanned && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 text-[10px] font-bold uppercase tracking-wider">
                      All Clean
                    </span>
                  )}
                </div>
                {rows.length > 0 && (
                  <button 
                    onClick={exportReport}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                  >
                    <FileSpreadsheet size={14} /> Export Report
                  </button>
                )}
              </div>

              {rows.length > 0 ? (
                <div className={`border rounded-xl overflow-hidden ${adminTheme === 'dark' ? 'border-slate-700' : 'border-slate-200'}`}>
                  <div className="max-h-[400px] overflow-auto">
                    <table className="w-full text-left text-xs">
                      <thead className={`sticky top-0 z-10 ${adminTheme === 'dark' ? 'bg-slate-800 text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
                        <tr>
                          <th className="p-3 font-bold uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">Employee Email</th>
                          <th className="p-3 font-bold uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">Manager Email</th>
                          <th className="p-3 font-bold uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">Existing Ref</th>
                          <th className="p-3 font-bold uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">Canonical UID</th>
                          <th className="p-3 font-bold uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {rows.map((row, idx) => (
                          <tr key={idx} className={adminTheme === 'dark' ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}>
                            <td className="p-3">
                              <div className="font-semibold text-slate-800 dark:text-slate-200">{row.employeeEmail}</div>
                              <div className="text-[10px] text-slate-400 font-mono">{row.employeeUid}</div>
                            </td>
                            <td className="p-3">
                              <div className="font-semibold text-slate-700 dark:text-slate-300">{row.managerEmail}</div>
                              <div className="text-[10px] text-slate-500">{row.managerName}</div>
                            </td>
                            <td className="p-3 font-mono text-[10px] text-rose-500 bg-rose-500/5 rounded p-1 inline-block mt-2">
                              {row.existingManagerId || row.existingTlId}
                            </td>
                            <td className="p-3 font-mono text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/5 rounded p-1 inline-block mt-2">
                              {row.canonicalManagerUid || row.canonicalTlUid}
                            </td>
                            <td className="p-3">
                              {row.status === 'PENDING' && <span className="text-amber-500 font-semibold flex items-center gap-1"><AlertTriangle size={12}/> Pending Fix</span>}
                              {row.status === 'NORMALIZED' && <span className="text-emerald-500 font-semibold flex items-center gap-1"><CheckCircle2 size={12}/> Normalized</span>}
                              {row.status === 'ERROR' && <span className="text-red-500 font-semibold" title={row.details}>Error</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : hasScanned ? (
                <div className={`p-8 text-center rounded-xl border ${adminTheme === 'dark' ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-emerald-100 bg-emerald-50'}`}>
                  <CheckCircle2 size={32} className="mx-auto text-emerald-500 mb-3" />
                  <h4 className="text-sm font-bold text-emerald-700 dark:text-emerald-400">Zero Discrepancies Found</h4>
                  <p className="text-xs text-emerald-600/70 dark:text-emerald-400/70 mt-1">All hierarchy identity references are properly mapped to canonical UIDs.</p>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`p-4 border-t flex justify-end gap-3 shrink-0 ${adminTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
          <button
            onClick={onClose}
            disabled={isCommitting}
            className="px-4 py-2 text-xs font-bold rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCommit}
            disabled={isCommitting || rows.length === 0 || rows.every(r => r.status === 'NORMALIZED')}
            className="px-5 py-2 text-xs font-bold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-2 shadow-md shadow-indigo-500/20 disabled:opacity-50 transition-all"
          >
            {isCommitting ? (
              <><RefreshCw size={14} className="animate-spin" /> Committing Changes...</>
            ) : (
              <><ShieldAlert size={14} /> Normalize {rows.filter(r => r.status === 'PENDING').length} Records</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
