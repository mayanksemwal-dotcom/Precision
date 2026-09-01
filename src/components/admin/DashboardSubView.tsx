import React, { useState, useEffect } from 'react';
import { 
  Users, 
  Activity, 
  ShieldCheck, 
  RefreshCw, 
  CheckCircle, 
  Briefcase,
  UserCheck,
  Calendar,
  Database,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  PieChart, 
  Pie, 
  Cell 
} from 'recharts';
import { firestoreLogger } from '../../lib/firestoreLogger';
import { db } from '../../lib/firebase';
import { collection, query, where, getCountFromServer, limit } from 'firebase/firestore';

interface DashboardSubViewProps {
  allUsers: any[];
  adminTheme: 'light' | 'dark';
}

interface CollectionStats {
  reads: number;
  writes: number;
  calls: number;
}

interface DashboardStats {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  agents: number;
  qas: number;
  smes: number;
  teamLeads: number;
  managers: number;
  recordsToday: number;
  lastSync: string;
  firestoreReads: number;
  firestoreWrites: number;
  locationCounts: Record<string, number>;
  statsBySource: Record<string, CollectionStats>;
}

export const DashboardSubView: React.FC<DashboardSubViewProps> = ({ allUsers, adminTheme }) => {
  const [isFirestoreExpanded, setIsFirestoreExpanded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [stats, setStats] = useState<DashboardStats>({
    totalUsers: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    agents: 0,
    qas: 0,
    smes: 0,
    teamLeads: 0,
    managers: 0,
    recordsToday: 0,
    lastSync: 'Syncing...',
    firestoreReads: 0,
    firestoreWrites: 0,
    locationCounts: {} as Record<string, number>,
    statsBySource: {}
  });

  // Update local derived stats when allUsers changes
  useEffect(() => {
    const fsStats = firestoreLogger.getStats();
    const total = allUsers.length;
    const active = allUsers.filter(u => u?.status?.toLowerCase() === 'active' || u?.isActive === true).length;
    const inactive = total - active;
    const agents = allUsers.filter(u => (u?.role || '').toUpperCase() === 'AGENT').length;
    const qas = allUsers.filter(u => (u?.role || '').toUpperCase() === 'QA').length;
    const smes = allUsers.filter(u => (u?.role || '').toUpperCase() === 'SME').length;
    const tls = allUsers.filter(u => {
      const r = (u?.role || '').toUpperCase();
      return ['TEAM_LEAD', 'STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM LEAD', 'TRAINER TL', 'OPS TL'].includes(r);
    }).length;
    const mgrs = allUsers.filter(u => {
      const r = (u?.role || '').toUpperCase();
      return ['MANAGER', 'ASSISTANT_MANAGER', 'ADMIN', 'EXECUTIVE'].includes(r);
    }).length;

    const locationCounts = allUsers.reduce((acc, u) => {
      const loc = u.location || 'Unknown';
      acc[loc] = (acc[loc] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    setStats(prev => ({
      ...prev,
      totalUsers: total,
      activeUsers: active,
      inactiveUsers: inactive,
      agents,
      qas,
      smes,
      teamLeads: tls,
      managers: mgrs,
      locationCounts,
      firestoreReads: fsStats.totalReads,
      firestoreWrites: fsStats.totalWrites,
      statsBySource: fsStats.statsBySource
    }));
  }, [allUsers]);

  // Fetch Firestore aggregate stats only on mount and manual refresh (pauses when tab is hidden)
  useEffect(() => {
    let isMounted = true;
    const fetchRemoteStats = async () => {
      if (typeof document !== 'undefined' && document.hidden) {
        console.log('[DashboardSubView] Tab inactive/hidden: skipping aggregate stats query.');
        return;
      }
      setIsRefreshing(true);
      try {
        let recordsTodayCount = 0;
        const todayStr = new Date().toISOString().slice(0, 10);
        const auditsQ = query(collection(db, 'adminAuditLogs'), where('timestamp', '>=', todayStr), limit(100));
        const shiftsQ = query(collection(db, 'tmsShifts'), where('dateStr', '==', todayStr), limit(100));

        const [auditsSnap, shiftsSnap] = await Promise.all([
          getCountFromServer(auditsQ).catch(() => ({ data: () => ({ count: 0 }) })),
          getCountFromServer(shiftsQ).catch(() => ({ data: () => ({ count: 0 }) }))
        ]);
        recordsTodayCount = auditsSnap.data().count + shiftsSnap.data().count;

        if (isMounted) {
          setStats(prev => ({
            ...prev,
            recordsToday: recordsTodayCount,
            lastSync: new Date().toLocaleTimeString(),
          }));
        }
      } catch (err) {
        console.warn('Could not query processed records counts: ', err);
      } finally {
        if (isMounted) {
          setIsRefreshing(false);
        }
      }
    };

    fetchRemoteStats();

    const handleManualRefresh = () => {
      fetchRemoteStats();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchRemoteStats();
      }
    };

    window.addEventListener('refreshAdminDashboardStats', handleManualRefresh);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      isMounted = false;
      window.removeEventListener('refreshAdminDashboardStats', handleManualRefresh);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Chart data formatting
  const roleChartData = [
    { name: 'Agents', count: stats.agents, fill: '#10B981' },
    { name: 'QAs', count: stats.qas, fill: '#3B82F6' },
    { name: 'SMEs', count: stats.smes, fill: '#F59E0B' },
    { name: 'Team Leads', count: stats.teamLeads, fill: '#8B5CF6' },
    { name: 'Managers', count: stats.managers, fill: '#EC4899' }
  ];

  const statusChartData = [
    { name: 'Active Users', value: stats.activeUsers, color: '#10B981' },
    { name: 'Inactive Users', value: stats.inactiveUsers, color: '#EF4444' }
  ];

  const cardStyle = adminTheme === 'dark' 
    ? 'bg-slate-800 border-slate-700 text-slate-100 shadow-xl p-5 rounded-2xl border' 
    : 'bg-white border-slate-200 text-slate-800 shadow-md p-5 rounded-2xl border';

  const subTextStyle = adminTheme === 'dark' ? 'text-slate-400' : 'text-slate-500';

  return (
    <div className="space-y-6">
      {/* KPI Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Core Stats */}
        <div className={cardStyle}>
          <div className="flex justify-between items-center">
            <div>
              <p className={`text-xs font-bold uppercase tracking-wider ${subTextStyle}`}>Total Accounts</p>
              <h3 className="text-3xl font-extrabold mt-1">{stats.totalUsers}</h3>
              <p className="text-[11px] text-emerald-500 font-semibold mt-1 flex items-center gap-0.5">
                <UserCheck size={12} /> {stats.activeUsers} Active Profiles
              </p>
              <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1">
                {Object.entries(stats.locationCounts).map(([loc, count]) => (
                    <span key={loc} className="text-[10px] bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-300 font-medium">
                        {loc}: {count}
                    </span>
                ))}
              </div>
            </div>
            <div className={`p-3 rounded-full ${adminTheme === 'dark' ? 'bg-slate-700 text-teal-400' : 'bg-teal-50 text-teal-600'}`}>
              <Users size={22} />
            </div>
          </div>
        </div>

        {/* Staff Profiles */}
        <div className={cardStyle}>
          <div className="flex justify-between items-center">
            <div>
              <p className={`text-xs font-bold uppercase tracking-wider ${subTextStyle}`}>Staff Profiles</p>
              <div className="mt-1 flex gap-2">
                <span className="text-xs bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded font-mono font-bold">AGTS: {stats.agents}</span>
                <span className="text-xs bg-blue-500/10 text-blue-500 px-1.5 py-0.5 rounded font-mono font-bold">QA: {stats.qas}</span>
                <span className="text-xs bg-amber-500/10 text-amber-500 px-1.5 py-0.5 rounded font-mono font-bold">TLS: {stats.teamLeads}</span>
              </div>
              <p className={`text-[11px] mt-2 font-medium ${subTextStyle}`}>
                Operational staff and auditors mapped
              </p>
            </div>
            <div className={`p-3 rounded-full ${adminTheme === 'dark' ? 'bg-slate-700 text-amber-400' : 'bg-amber-50 text-amber-600'}`}>
              <Briefcase size={22} />
            </div>
          </div>
        </div>

        {/* Firestore Usage */}
        <div className={`lg:col-span-2 ${cardStyle}`}>
          <div className="flex flex-col h-full">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-2">
                <button onClick={() => setIsFirestoreExpanded(!isFirestoreExpanded)} className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700">
                  {isFirestoreExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                <p className={`text-xs font-bold uppercase tracking-wider ${subTextStyle}`}>Firestore Usage Breakdown</p>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex gap-4">
                  <p className="text-sm font-semibold text-emerald-500">Total Reads: {stats.firestoreReads.toLocaleString()}</p>
                  <p className="text-sm font-semibold text-amber-500">Total Writes: {stats.firestoreWrites.toLocaleString()}</p>
                </div>
                <button
                  onClick={() => {
                    const event = new Event('refreshAdminDashboardStats');
                    window.dispatchEvent(event);
                  }}
                  disabled={isRefreshing}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    isRefreshing
                      ? 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500 cursor-not-allowed'
                      : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-400 dark:hover:bg-indigo-500/20'
                  }`}
                >
                  <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
                  {isRefreshing ? 'Updating...' : 'Refresh Data'}
                </button>
              </div>
            </div>
            
            {isFirestoreExpanded && (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-700">
                        <th className="py-2">Source / Collection</th>
                        <th className="py-2 text-right">Reads</th>
                        <th className="py-2 text-right">Writes</th>
                        <th className="py-2 text-right">Calls</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(Object.entries(stats.statsBySource) as [string, CollectionStats][]).map(([source, s]) => (
                        <tr key={source} className="border-b border-slate-100 dark:border-slate-800">
                          <td className="py-2 font-mono text-[10px]">{source}</td>
                          <td className="py-2 text-right text-emerald-600">{s.reads.toLocaleString()}</td>
                          <td className="py-2 text-right text-amber-600">{s.writes.toLocaleString()}</td>
                          <td className="py-2 text-right text-slate-500">{s.calls.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] text-slate-500 mt-4 italic">
                  Note: Historical data filtering is disabled to prevent additional Firestore costs. Displaying real-time session statistics only.
                </p>
              </>
            )}

          </div>
        </div>
        
        {/* Locations (Removed) */}
      </div>

      {/* Visual Analytics Graphs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className={`lg:col-span-2 ${cardStyle} min-h-[350px]`}>
          <h4 className="text-sm font-bold uppercase tracking-wider mb-4">Organizational Staff Breakdown</h4>
          <div className="h-[280px] w-full" style={{ minHeight: '250px', width: '100%' }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={roleChartData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                <XAxis dataKey="name" stroke={adminTheme === 'dark' ? '#94A3B8' : '#64748B'} fontSize={12} />
                <YAxis stroke={adminTheme === 'dark' ? '#94A3B8' : '#64748B'} fontSize={12} />
                <Tooltip 
                  contentStyle={{
                    backgroundColor: adminTheme === 'dark' ? '#1E293B' : '#FFFFFF',
                    border: '1px solid ' + (adminTheme === 'dark' ? '#475569' : '#CBD5E1'),
                    color: adminTheme === 'dark' ? '#F8FAFC' : '#1E293B'
                  }}
                />
                <Bar dataKey="count" radius={[8, 8, 0, 0]}>
                  {roleChartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className={cardStyle}>
          <h4 className="text-sm font-bold uppercase tracking-wider mb-4">Account Status Dispersion</h4>
          <div className="h-[200px] w-full flex items-center justify-center" style={{ minHeight: '250px', width: '100%' }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart>
                <Pie
                  data={statusChartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {statusChartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-6 mt-4">
            {statusChartData.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="text-xs font-semibold">{item.name} ({item.value})</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
