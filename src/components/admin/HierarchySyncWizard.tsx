import React, { useState, useMemo, useEffect } from 'react';
import { Shield, RefreshCw, AlertTriangle, CheckCircle, Users, Link2, Search, Trash2, HelpCircle, UserCheck } from 'lucide-react';
import { db } from '../../lib/firebase';
import { collection, doc, getDocs, writeBatch, query, where, setDoc } from 'firebase/firestore';
import { toast } from 'sonner';

interface HierarchySyncWizardProps {
  allUsers: any[];
  adminTheme: 'light' | 'dark';
  onRefresh: () => void;
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export const HierarchySyncWizard: React.FC<HierarchySyncWizardProps> = ({
  allUsers,
  adminTheme,
  onRefresh,
  logAdminEvent
}) => {
  const [isSyncing, setIsSyncing] = useState(false);
  const [mismatches, setMismatches] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const stats = useMemo(() => {
    const total = allUsers.length;
    const missingTL = allUsers.filter(u => !u.teamLeadId && !['ADMIN', 'MANAGER'].includes(u.role?.toUpperCase())).length;
    const missingMgr = allUsers.filter(u => !u.managerId && !['ADMIN'].includes(u.role?.toUpperCase())).length;
    const orphans = allUsers.filter(u => !u.teamLeadId && !u.managerId && u.role === 'AGENT').length;
    
    return { total, missingTL, missingMgr, orphans };
  }, [allUsers]);

  const detectMismatches = async () => {
    setIsLoading(true);
    try {
      // 1. Get existing Team Mappings (if we assume a separate collection)
      const mappingSnap = await getDocs(collection(db, 'teamMappings'));
      const mappings = new Map();
      mappingSnap.docs.forEach(d => mappings.set(d.id, d.data()));

      const issues: any[] = [];
      
      allUsers.forEach(u => {
        const mapping = mappings.get(u.uid);
        const userTLId = u.teamLeadId || '';
        const userMgrId = u.managerId || u.mappedManagerId || '';
        
        const mapTLId = mapping?.teamLeadId || '';
        const mapMgrId = mapping?.managerId || '';

        if (userTLId !== mapTLId || userMgrId !== mapMgrId) {
          issues.push({
            uid: u.uid,
            name: u.fullName || u.name,
            role: u.role,
            userTL: userTLId,
            userMgr: userMgrId,
            mapTL: mapTLId,
            mapMgr: mapMgrId,
            type: !mapping ? 'MISSING_MAPPING' : 'MISMATCH'
          });
        }
      });

      setMismatches(issues);
    } catch (err) {
      console.error('Mismatch detection failed:', err);
      toast.error('Failed to analyze hierarchy mismatches.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    detectMismatches();
  }, [allUsers]);

  const handleSyncAll = async () => {
    if (mismatches.length === 0) {
      toast.info('No mismatches detected.');
      return;
    }

    setIsSyncing(true);
    try {
      const batch = writeBatch(db);
      
      mismatches.forEach(issue => {
        // Sync User Directory -> Team Mappings
        const mappingRef = doc(db, 'teamMappings', issue.uid);
        const userObj = allUsers.find(u => u.uid === issue.uid);
        
        const payload = {
          userId: issue.uid,
          userName: issue.name,
          teamLeadId: issue.userTL || '',
          teamLeadName: userObj?.teamLeadName || '',
          managerId: issue.userMgr || '',
          managerName: userObj?.managerName || userObj?.mappedManagerName || '',
          process: userObj?.process || '',
          lastUpdated: new Date().toISOString()
        };

        batch.set(mappingRef, payload);

        // Also ensure employee_master is synced
        const masterRef = doc(db, 'employee_master', issue.uid);
        batch.set(masterRef, {
          teamLeadId: issue.userTL || '',
          teamLeadName: userObj?.teamLeadName || '',
          managerId: issue.userMgr || '',
          managerName: userObj?.managerName || userObj?.mappedManagerName || '',
          lastUpdated: new Date().toISOString()
        }, { merge: true });
      });

      await batch.commit();
      toast.success(`Successfully synchronized ${mismatches.length} hierarchy records.`);
      logAdminEvent('Hierarchy Batch Sync', `${mismatches.length} users`, 'Mismatched', 'Synchronized');
      onRefresh();
      detectMismatches();
    } catch (err) {
      console.error('Sync failed:', err);
      toast.error('Error during synchronization.');
    } finally {
      setIsSyncing(false);
    }
  };

  const cardClass = adminTheme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className={`${cardClass} border rounded-2xl p-6 shadow-sm`}>
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-base font-black text-slate-800 dark:text-white uppercase tracking-tight flex items-center gap-2">
              <Shield size={20} className="text-indigo-500" /> Hierarchy Validation Center
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Data Accuracy & Integrity Diagnostics: Repair and align reporting structures between User Directory and Team Mapping.
            </p>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={detectMismatches}
              disabled={isLoading}
              className="bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 px-4 py-2 rounded-xl text-xs font-bold transition-all disabled:opacity-50 flex items-center gap-2"
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> Analyze Mismatches
            </button>
            <button 
              onClick={handleSyncAll}
              disabled={isSyncing || mismatches.length === 0}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-xs font-black transition-all disabled:opacity-50 flex items-center gap-2"
            >
              <UserCheck size={14} /> Sync All ({mismatches.length})
            </button>
          </div>
        </div>

        {/* Diagnostic Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-slate-50 dark:bg-slate-950/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Total Headcount</span>
            <div className="text-2xl font-black text-slate-800 dark:text-slate-200 mt-1">{stats.total}</div>
          </div>
          <div className="bg-slate-50 dark:bg-slate-950/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider text-rose-500">Missing Team Lead</span>
            <div className="text-2xl font-black text-rose-500 mt-1">{stats.missingTL}</div>
          </div>
          <div className="bg-slate-50 dark:bg-slate-950/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider text-orange-500">Missing Manager</span>
            <div className="text-2xl font-black text-orange-500 mt-1">{stats.missingMgr}</div>
          </div>
          <div className="bg-slate-50 dark:bg-slate-950/40 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Orphan Agents</span>
            <div className="text-2xl font-black text-slate-500 mt-1">{stats.orphans}</div>
          </div>
        </div>

        {/* Mismatch List */}
        <div className="space-y-4">
          <h4 className="text-xs font-black text-slate-700 dark:text-slate-300 uppercase tracking-widest px-1">Detected Hierarchy Inconsistencies</h4>
          
          <div className="overflow-x-auto border border-slate-100 dark:border-slate-800 rounded-xl">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase font-black text-slate-500">
                <tr>
                  <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">User Profile</th>
                  <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">User Dir TL</th>
                  <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">Mapping TL</th>
                  <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 text-right">Action Needed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-slate-850">
                {mismatches.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-emerald-600 font-bold italic text-sm">
                      <div className="flex flex-col items-center gap-2">
                        <CheckCircle size={24} />
                        All hierarchy relationships are synchronized.
                      </div>
                    </td>
                  </tr>
                ) : (
                  mismatches.map((issue) => (
                    <tr key={issue.uid} className="hover:bg-slate-50 dark:hover:bg-slate-850/40 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-extrabold text-xs text-slate-800 dark:text-slate-200">{issue.name}</div>
                        <div className="text-[9px] font-bold text-slate-400 uppercase">{issue.role} • {issue.uid}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-bold ${!issue.userTL ? 'text-rose-500' : 'text-slate-600 dark:text-slate-400'}`}>
                          {issue.userTL || 'UNASSIGNED'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-bold ${issue.mapTL !== issue.userTL ? 'text-orange-500' : 'text-slate-600 dark:text-slate-400'}`}>
                          {issue.mapTL || 'EMPTY'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {issue.type === 'MISSING_MAPPING' ? (
                          <span className="bg-rose-50 dark:bg-rose-950/20 text-rose-600 text-[9px] font-black px-2 py-0.5 rounded-full uppercase">Create Mapping</span>
                        ) : (
                          <span className="bg-amber-50 dark:bg-amber-950/20 text-amber-600 text-[9px] font-black px-2 py-0.5 rounded-full uppercase">Update Mapping</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
