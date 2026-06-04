import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { History, Search, FileSpreadsheet, Calendar, User, Clock, Trash } from 'lucide-react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';

interface AuditLogsSubViewProps {
  adminTheme: 'light' | 'dark';
}

export const AuditLogsSubView: React.FC<AuditLogsSubViewProps> = ({ adminTheme }) => {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Queries
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, 'adminAuditLogs'), orderBy('timestamp', 'desc'), limit(300));
      const snap = await getDocs(q);
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setLogs(list);
    } catch (err) {
      console.warn('Could not read admin audits logs: ', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      const q = search.toLowerCase();
      const matchSearch = 
        (log.affectedUser || '').toLowerCase().includes(q) ||
        (log.performedBy || '').toLowerCase().includes(q) ||
        (log.newValue || '').toLowerCase().includes(q);
      
      const matchAction = actionFilter ? log.action === actionFilter : true;
      return matchSearch && matchAction;
    });
  }, [logs, search, actionFilter]);

  const uniqueActions = useMemo(() => {
    const s = new Set<string>();
    logs.forEach(l => l.action && s.add(l.action));
    return Array.from(s);
  }, [logs]);

  const handleExportAuditTrail = () => {
    const data = filteredLogs.map(l => ({
      'Record Timestamp': l.timestamp ? new Date(l.timestamp).toLocaleString() : 'N/A',
      'Action Conducted': l.action || 'N/A',
      'Administrator / Performed By': l.performedBy || 'System',
      'Affected Personnel / Target': l.affectedUser || 'N/A',
      'Original Payload State': l.previousValue || 'N/A',
      'Adjustment Result / Next State': l.newValue || 'N/A'
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Audit Security Trace');
    XLSX.writeFile(wb, 'Precision360_Security_Audits_Logs.xlsx');
    toast.success('Enterprise security audit logs exported successfully!');
  };

  const cardClass = adminTheme === 'dark' 
    ? 'bg-slate-800 border-slate-700 shadow-xl p-6 rounded-2xl border text-slate-100' 
    : 'bg-white border-slate-205 shadow-md p-6 rounded-2xl border text-slate-800';

  if (loading) {
    return (
      <div className="py-12 text-center text-slate-405 font-mono text-xs">Parsing Security Registry Trail...</div>
    );
  }

  return (
    <div className="space-y-6">
      <div className={cardClass}>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 border-b border-slate-150/10 pb-4">
          <div className="flex items-center gap-2">
            <History size={18} className="text-rose-500 animate-spin-slow" />
            <div>
              <h3 className="text-base font-extrabold text-slate-900 dark:text-slate-100">Immutable Portal Audit Trail</h3>
              <p className="text-xs text-slate-400 mt-0.5">Continuous logging of credential sets, configurations matrix changes, and employee rosters.</p>
            </div>
          </div>

          <button onClick={handleExportAuditTrail} className="px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer bg-slate-800 border border-slate-700 text-white flex items-center gap-1.5">
            <FileSpreadsheet size={15} /> Export Audit Log
          </button>
        </div>

        {/* Filters Matrix */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-450" />
            <input 
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search target profile, description, values..."
              className={adminTheme === 'dark' 
                ? 'pl-10 w-full bg-slate-900 border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-xs border focus:ring-1 focus:ring-indigo-500' 
                : 'pl-10 w-full bg-white border-slate-200 text-slate-800 rounded-lg px-3 py-2 text-xs border focus:ring-1 focus:ring-indigo-500'}
            />
          </div>

          <div>
            <select 
              value={actionFilter} 
              onChange={e => setActionFilter(e.target.value)}
              className={adminTheme === 'dark' 
                ? 'w-full bg-slate-900 text-xs px-2.5 py-2 rounded-lg border border-slate-700 text-slate-350' 
                : 'w-full bg-white text-xs px-2.5 py-2 rounded-lg border border-slate-205 text-slate-650'}
            >
              <option value="">All Action Types</option>
              {uniqueActions.map(action => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-end">
            <span className="text-xs text-slate-400 font-semibold font-mono">Found {filteredLogs.length} matching logging indices</span>
          </div>
        </div>

        {/* Audit list Table */}
        <div className="overflow-hidden border border-slate-205 dark:border-slate-700 rounded-xl max-h-[450px] overflow-y-auto w-full">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={adminTheme === 'dark' ? 'bg-slate-900 text-slate-300 font-bold uppercase text-[10px]' : 'bg-slate-50 text-slate-550 font-bold uppercase text-[10px]'}>
              <tr className="border-b border-slate-200 dark:border-slate-700/60">
                <th className="p-3.5 pl-4 w-[180px]">Timestamp</th>
                <th className="p-3.5 w-[160px]">Executed Action</th>
                <th className="p-3.5 w-[180px]">Performed By (Admin)</th>
                <th className="p-3.5 w-[180px]">Affected Object</th>
                <th className="p-3.5 max-w-[200px]">Previous Value</th>
                <th className="p-3.5 max-w-[200px]">Adjustment Result / New Value</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length > 0 ? (
                filteredLogs.map(log => (
                  <tr key={log.id} className={adminTheme === 'dark' ? 'hover:bg-slate-905 border-b border-slate-800/40 text-slate-200' : 'hover:bg-slate-50/50 border-b border-slate-100 text-slate-800'}>
                    <td className="p-3.5 pl-4 font-mono text-[10px] opacity-75 flex items-center gap-1">
                      <Clock size={11} /> {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="p-3.5 font-bold">
                      <span className="bg-rose-500/10 text-rose-500 uppercase px-2 py-0.5 rounded text-[9px] tracking-wide font-extrabold">{log.action || 'AMB_ACT'}</span>
                    </td>
                    <td className="p-3.5 font-medium opacity-90">{log.performedBy || 'System/Process'}</td>
                    <td className="p-3.5 font-bold text-indigo-505">{log.affectedUser || 'N/A'}</td>
                    
                    <td className="p-3.5 font-mono text-[10px] truncate max-w-[150px] opacity-65 hover:text-indigo-400 cursor-help" title={log.previousValue}>
                      {log.previousValue || 'N/A'}
                    </td>
                    <td className="p-3.5 font-mono text-[10px] truncate max-w-[150px] opacity-90 font-bold text-slate-600 dark:text-slate-350 hover:text-indigo-400 cursor-help" title={log.newValue}>
                      {log.newValue || 'N/A'}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="p-10 text-center text-slate-400 font-semibold text-xs">No administrative actions matched the trace filters configured.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
