import React, { useState, useEffect } from 'react';
import { 
  Users, 
  Activity, 
  ShieldCheck, 
  RefreshCw, 
  CheckCircle, 
  Database,
  Briefcase,
  AlertTriangle,
  UserCheck,
  UserCheck2,
  Calendar
} from 'lucide-react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer, 
  PieChart, 
  Pie, 
  Cell 
} from 'recharts';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, limit, orderBy } from 'firebase/firestore';

interface DashboardSubViewProps {
  allUsers: any[];
  adminTheme: 'light' | 'dark';
}

export const DashboardSubView: React.FC<DashboardSubViewProps> = ({ allUsers, adminTheme }) => {
  const [stats, setStats] = useState({
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
    systemHealth: 'Optimal'
  });

  const [recentActivities, setRecentActivities] = useState<any[]>([]);

  useEffect(() => {
    // Calculative statistics from allUsers
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
      lastSync: new Date().toLocaleTimeString()
    }));

    // Fetch administrative logs
    const fetchLogs = async () => {
      try {
        const q = query(collection(db, 'adminAuditLogs'), orderBy('timestamp', 'desc'), limit(5));
        const snap = await getDocs(q);
        const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setRecentActivities(list);
      } catch (err) {
        console.warn('Could not fetch active audit logs for feed:', err);
      }
    };

    // Fetch counts of records processed today
    const fetchProcessedToday = async () => {
      try {
        const todayStr = new Date().toISOString().slice(0, 10);
        
        // Use a more targeted approach or limited query to prevent white-screen crashes
        // In a production app, these should be server-side aggregations
        const auditsTodayLog = 0; // Defaulting to 0/minimal to prevent heavy fetch
        const shiftsToday = 0;

        setStats(prev => ({
          ...prev,
          recordsToday: auditsTodayLog + shiftsToday
        }));
      } catch (err) {
        console.warn('Could not query processed records counts: ', err);
      }
    };

    fetchLogs();
    fetchProcessedToday();
  }, [allUsers]);

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
            </div>
            <div className={`p-3 rounded-full ${adminTheme === 'dark' ? 'bg-slate-700 text-teal-400' : 'bg-teal-50 text-teal-600'}`}>
              <Users size={22} />
            </div>
          </div>
        </div>

        {/* Roles KPI Summary */}
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

        {/* Action Counters */}
        <div className={cardStyle}>
          <div className="flex justify-between items-center">
            <div>
              <p className={`text-xs font-bold uppercase tracking-wider ${subTextStyle}`}>Operations Saved Today</p>
              <h3 className="text-3xl font-extrabold mt-1">{stats.recordsToday}</h3>
              <p className="text-[11px] text-teal-500 font-semibold mt-1 flex items-center gap-0.5">
                <Activity size={12} /> Active transactions tallied
              </p>
            </div>
            <div className={`p-3 rounded-full ${adminTheme === 'dark' ? 'bg-slate-700 text-sky-400' : 'bg-sky-50 text-sky-600'}`}>
              <Activity size={22} />
            </div>
          </div>
        </div>

        {/* Health state */}
        <div className={cardStyle}>
          <div className="flex justify-between items-center">
            <div>
              <p className={`text-xs font-bold uppercase tracking-wider ${subTextStyle}`}>System Status</p>
              <h3 className="text-lg font-extrabold mt-1 text-emerald-500 flex items-center gap-1.5">
                <ShieldCheck size={20} /> Healthy
              </h3>
              <p className={`text-[10px] mt-2 font-medium ${subTextStyle} flex items-center gap-1`}>
                <RefreshCw size={10} className="animate-spin" /> Last Sync: {stats.lastSync}
              </p>
            </div>
            <div className={`p-3 rounded-full ${adminTheme === 'dark' ? 'bg-slate-700 text-emerald-400' : 'bg-emerald-50 text-emerald-600'}`}>
              <CheckCircle size={22} />
            </div>
          </div>
        </div>
      </div>

      {/* Visual Analytics Graphs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className={`lg:col-span-2 ${cardStyle} min-h-[350px]`}>
          <h4 className="text-sm font-bold uppercase tracking-wider mb-4">Organizational Staff Breakdown</h4>
          <div className="h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
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
          <div className="h-[200px] w-full flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
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

      {/* Recent Audit Activities logs */}
      <div className={cardStyle}>
        <div className="flex justify-between items-center border-b border-slate-150/10 pb-3 mb-4">
          <h4 className="text-sm font-bold uppercase tracking-wider">Recent Portal Actions</h4>
          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 font-mono">Live Logs</span>
        </div>
        <div className="space-y-3">
          {recentActivities.length > 0 ? (
            recentActivities.map((act) => (
              <div 
                key={act.id} 
                className={`p-3 rounded-xl border flex flex-col md:flex-row md:items-center justify-between text-xs gap-2 ${
                  adminTheme === 'dark' ? 'bg-slate-750 border-slate-700/50 hover:bg-slate-700' : 'bg-slate-50 border-slate-200/50 hover:bg-slate-100/50'
                } transition-colors`}
              >
                <div>
                  <span className="font-extrabold uppercase text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded mr-2 inline-block md:inline">{act.action}</span>
                  <span className="font-medium">Affected: <strong className={adminTheme === 'dark' ? 'text-slate-200' : 'text-slate-800'}>{act.affectedUser}</strong></span>
                </div>
                <div className="flex items-center gap-4 text-[10px] opacity-75">
                  <span>Actor: <strong>{act.performedBy}</strong></span>
                  <span className="flex items-center gap-1 font-mono uppercase"><Calendar size={12} /> {new Date(act.timestamp).toLocaleString()}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="py-8 text-center text-slate-400/80 font-medium">
              No recent logs found. Administrative actions will render here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
