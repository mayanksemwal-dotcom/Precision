import React, { useState } from 'react';
import { 
  Users, 
  BarChart3, 
  FileDown, 
  Search, 
  Filter,
  CheckCircle2,
  XCircle,
  AlertCircle,
  TrendingUp,
  Download,
  ShieldAlert
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer,
  Legend
} from 'recharts';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { SamplingTask, AuditRecord, UserRole, UserProfile, QAAlignment, ProductionRecord, DisputeStatus, WarningTicket } from '../types';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';

interface TeamLeadViewProps {
  activeTab: string;
  tasks?: SamplingTask[];
  auditLogs?: AuditRecord[];
  user?: UserProfile | null;
  alignments?: QAAlignment[];
  productions?: ProductionRecord[];
  goToTab?: (tab: string) => void;
  allUsers?: UserProfile[];
  warnings?: WarningTicket[];
}

export default function TeamLeadView({ 
  activeTab, 
  tasks = [], 
  auditLogs = [], 
  user, 
  alignments = [], 
  productions = [], 
  goToTab, 
  allUsers = [],
  warnings = []
}: TeamLeadViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const handleSearchChange = (val: string) => {
    setSearchTerm(val);
    setCurrentPage(1);
  };

  // 1. Filter audit records to only those belonging to the logged in Team Lead or Manager's team
  const myTeamAudits = React.useMemo(() => {
    if (user?.role === UserRole.ADMIN) {
      return auditLogs;
    }
    if (user?.role === UserRole.TEAM_LEAD || user?.role === UserRole.MANAGER) {
      const currentUserEmail = (user.email || '').toLowerCase().trim();
      const isTL = user.role === UserRole.TEAM_LEAD;
      const isMgr = user.role === UserRole.MANAGER;

      const getMappedAgentsAndQAsForTL = (tlUid: string) => {
        return allUsers.filter(u => u.teamLeadId === tlUid);
      };

      let mappedUsers: any[] = [];
      if (isTL) {
         mappedUsers = getMappedAgentsAndQAsForTL(user.uid);
      } else if (isMgr) {
         const mappedTLs = allUsers.filter(u => {
           const isMappedRole = [UserRole.TEAM_LEAD, UserRole.OPS_TL, UserRole.QTL, UserRole.STL, UserRole.TRAINER_TL].includes(u.role as UserRole);
           return isMappedRole && u.mappedManagerId === user.uid;
         });
         mappedUsers = [...mappedTLs];
         mappedTLs.forEach(tl => {
           mappedUsers.push(...getMappedAgentsAndQAsForTL(tl.uid));
         });
      }
      
      const mappedAgentIds = mappedUsers.map(u => u.uid);
      const mappedAgentNames = mappedUsers.map(u => (u.name || '').toLowerCase().trim());
      
      return auditLogs.filter(log => 
        (log.agentId && mappedAgentIds.includes(log.agentId)) || 
        (log.qvName && mappedAgentNames.includes(log.qvName.toLowerCase().trim()))
      );
    }
    return auditLogs;
  }, [auditLogs, user, allUsers]);

  // 2. Dynamically calculate metrics
  const teamMtdQuality = React.useMemo(() => {
    const auditsWithScores = myTeamAudits.filter(a => typeof a.quality === 'number');
    if (auditsWithScores.length === 0) return 100;
    const sum = auditsWithScores.reduce((acc, curr) => acc + curr.quality, 0);
    return sum / auditsWithScores.length;
  }, [myTeamAudits]);

  const activeDisputesCount = React.useMemo(() => {
    return myTeamAudits.filter(log => log.disputeStatus === DisputeStatus.PENDING || log.disputeStatus === DisputeStatus.QA_REVIEWED).length;
  }, [myTeamAudits]);

  const pendingFeedbackCount = React.useMemo(() => {
    return myTeamAudits.filter(a => 
      a.status === 'Incorrect' && 
      !a.isAccepted && 
      a.disputeStatus !== DisputeStatus.RESOLVED &&
      a.disputeStatus !== DisputeStatus.PENDING &&
      a.disputeStatus !== DisputeStatus.QA_REVIEWED
    ).length;
  }, [myTeamAudits]);

  const teamWarnings = React.useMemo(() => {
    const currentUserEmail = (user?.email || '').toLowerCase().trim();
    const isTL = user?.role === UserRole.TEAM_LEAD;
    const isMgr = user?.role === UserRole.MANAGER;

    const getMappedAgentsAndQAsForTL = (tlUid: string) => {
      return allUsers.filter(u => u.teamLeadId === tlUid);
    };

    let mappedUsers: any[] = [];
    if (isTL && user) {
       mappedUsers = getMappedAgentsAndQAsForTL(user.uid);
    } else if (isMgr && user) {
       const mappedTLs = allUsers.filter(u => {
         const isMappedRole = [UserRole.TEAM_LEAD, UserRole.OPS_TL, UserRole.QTL, UserRole.STL, UserRole.TRAINER_TL].includes(u.role as UserRole);
         return isMappedRole && u.mappedManagerId === user.uid;
       });
       mappedUsers = [...mappedTLs];
       mappedTLs.forEach(tl => {
         mappedUsers.push(...getMappedAgentsAndQAsForTL(tl.uid));
       });
    }

    const myAgents = mappedUsers.map(u => u.uid);
    return warnings.filter(w => myAgents.includes(w.agentId));
  }, [warnings, allUsers, user]);

  const pendingWarningsCount = React.useMemo(() => {
    return teamWarnings.filter(w => w.status === 'Pending').length;
  }, [teamWarnings]);

  // Calculate Reports Data
  const reportsData = React.useMemo(() => {
    const agentMap: Record<string, {
      name: string,
      production: number,
      auditsDone: number,
      errors: number,
      totalRowsAudited: number
    }> = {};

    // 1. Production from production records instead of tasks
    productions.forEach(prod => {
      if (!agentMap[prod.qvName]) {
        agentMap[prod.qvName] = { name: prod.qvName, production: 0, auditsDone: 0, errors: 0, totalRowsAudited: 0 };
      }
      agentMap[prod.qvName].production += prod.totalRows;
    });

    // Handle tasks edge case where a task exists without a uploaded production record
    tasks.forEach(task => {
      if (!agentMap[task.qvName]) {
        agentMap[task.qvName] = { name: task.qvName, production: task.rows || 1, auditsDone: 0, errors: 0, totalRowsAudited: 0 };
      }
    });

    // 2. Audit details from auditLogs
    auditLogs.forEach(audit => {
      if (!agentMap[audit.qvName]) {
        agentMap[audit.qvName] = { name: audit.qvName, production: 0, auditsDone: 0, errors: 0, totalRowsAudited: 0 };
      }
      const data = agentMap[audit.qvName];
      data.auditsDone += 1;
      data.errors += (audit.compErrorCount + audit.mpqcErrorCount);
      data.totalRowsAudited += audit.rows;
    });

    // 3. Filter for QA role alignment and Team Lead/Manager mapped agents
    let dataList = Object.values(agentMap);
    if (user?.role === UserRole.QA) {
      const myAlignedAgents = alignments
        .filter(a => (a.qaEmail || '').toLowerCase() === (user.email || '').toLowerCase())
        .map(a => a.agentName);
      dataList = dataList.filter(a => myAlignedAgents.includes(a.name));
    } else if (user?.role === UserRole.TEAM_LEAD || user?.role === UserRole.MANAGER) {
      const currentUserEmail = (user.email || '').toLowerCase().trim();
      const isTL = user.role === UserRole.TEAM_LEAD;
      const isMgr = user.role === UserRole.MANAGER;

      const getMappedAgentsAndQAsForTL = (tlUid: string) => {
        return allUsers.filter(u => u.teamLeadId === tlUid);
      };

      let mappedUsers: any[] = [];
      if (isTL) {
         mappedUsers = getMappedAgentsAndQAsForTL(user.uid);
      } else if (isMgr) {
         const mappedTLs = allUsers.filter(u => {
           const isMappedRole = [UserRole.TEAM_LEAD, UserRole.OPS_TL, UserRole.QTL, UserRole.STL, UserRole.TRAINER_TL].includes(u.role as UserRole);
           return isMappedRole && u.mappedManagerId === user.uid;
         });
         mappedUsers = [...mappedTLs];
         mappedTLs.forEach(tl => {
           mappedUsers.push(...getMappedAgentsAndQAsForTL(tl.uid));
         });
      }

      const myAgents = mappedUsers.map(u => (u.name || '').toLowerCase().trim());
      dataList = dataList.filter(a => myAgents.includes((a.name || '').toLowerCase().trim()));
    }

    return dataList.map(agent => {
      const coverage = agent.production > 0 ? (agent.totalRowsAudited / agent.production) * 100 : 0;
      // QA Score (Logic : 1 - (Sum of Errors / Total Rows in Audited Tasks))
      const score = agent.totalRowsAudited > 0 ? (1 - (agent.errors / agent.totalRowsAudited)) * 100 : 0;
      
      return {
        ...agent,
        coverage,
        score
      };
    }).filter(a => (a.name || '').toLowerCase().includes((searchTerm || '').toLowerCase()))
    .sort((a, b) => b.coverage - a.coverage);
  }, [tasks, auditLogs, searchTerm, user, alignments, productions, allUsers]);

  const exportQCReport = () => {
    toast.info('Generating report...');
    
    const exportData = reportsData.map(r => ({
      'Agent Name': r.name,
      'Total Production (Rows)': r.production,
      'Tasks Audited': r.auditsDone,
      'Rows Audited': r.totalRowsAudited,
      'Error Count': r.errors,
      'Coverage %': `${r.coverage.toFixed(2)}%`,
      'Avg Score': `${r.score.toFixed(2)}%`
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Agent_Performance');
    XLSX.writeFile(wb, `Agent_Performance_${new Date().toISOString().split('T')[0]}.xlsx`);
    
    toast.success('Report downloaded successfully');
  };

  const teamPerformanceChartData = reportsData.map(r => ({
    agent: r.name,
    correct: auditLogs.filter(a => a.qvName === r.name && a.status === 'Correct').length,
    incorrect: auditLogs.filter(a => a.qvName === r.name && a.status === 'Incorrect').length,
  }));

  if (activeTab === 'dashboard') {
    // ... existing dashboard code ...
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs font-bold uppercase">Team MTD Quality</CardDescription>
              <CardTitle className="text-2xl font-black">{teamMtdQuality.toFixed(1)}%</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-green-600 font-medium">+2.1% from prev. month</div>
            </CardContent>
          </Card>
          <Card className="shadow-sm cursor-pointer hover:border-blue-300 transition-colors" onClick={() => goToTab?.('completed_audits')}>
            <CardHeader className="pb-2">
              <CardDescription className="text-xs font-bold uppercase">Audits Completed</CardDescription>
              <CardTitle className="text-2xl font-black">{reportsData.reduce((acc, curr) => acc + curr.auditsDone, 0)}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-slate-500 font-medium whitespace-nowrap overflow-hidden text-ellipsis">
                Out of {reportsData.reduce((acc, curr) => acc + curr.production, 0)} items
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs font-bold uppercase">Active Disputes</CardDescription>
              <CardTitle className="text-2xl font-black">{activeDisputesCount}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-amber-600 font-medium">Needs review</div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs font-bold uppercase">Pending Feedback</CardDescription>
              <CardTitle className="text-2xl font-black">{pendingFeedbackCount}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-slate-500 font-medium">Awaiting agent response</div>
            </CardContent>
          </Card>
          <Card className={`shadow-sm border-l-4 ${pendingWarningsCount > 0 ? 'border-l-red-500 bg-red-50/10' : 'border-l-indigo-500 bg-white'}`}>
            <CardHeader className="pb-2">
              <CardDescription className="text-xs font-bold uppercase">Team Warnings</CardDescription>
              <CardTitle className="text-2xl font-black">{teamWarnings.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-xs font-medium ${pendingWarningsCount > 0 ? 'text-red-650' : 'text-indigo-600'}`}>
                {pendingWarningsCount} Pending Action
              </div>
            </CardContent>
          </Card>
        </div>

        {pendingWarningsCount > 0 && (
          <div className="bg-red-50 border-2 border-red-200 text-red-950 p-4 rounded-xl flex items-start gap-3 shadow-sm animate-in fade-in slide-in-from-top-4 duration-300">
            <ShieldAlert className="text-red-650 shrink-0 mt-0.5" size={20} />
            <div className="text-xs">
              <span className="font-extrabold text-sm block mb-1">⚠️ Urgent: Pending Disciplinary Actions on Team</span>
              There are currently <strong className="underline text-red-700">{pendingWarningsCount} pending disciplinary warnings</strong> awaiting acknowledgment from agents in your team. Please coordinate with them to ensure warnings are acknowledged or reviewed immediately.
            </div>
          </div>
        )}

        <Card className="shadow-sm overflow-hidden">
          <CardHeader className="border-b bg-slate-50/50">
            <CardTitle className="text-lg flex items-center gap-2">
               <BarChart3 size={20} className="text-blue-600" />
               Agent Performance Comparison
            </CardTitle>
            <CardDescription>Breakdown of Correct vs Incorrect audits per agent</CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={teamPerformanceChartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="agent" axisLine={false} tickLine={false} tick={{fontSize: 12, fill: '#64748b'}} />
                  <YAxis axisLine={false} tickLine={false} tick={{fontSize: 12, fill: '#64748b'}} />
                  <RechartsTooltip contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'}} />
                  <Legend iconType="circle" />
                  <Bar dataKey="correct" fill="#22c55e" radius={[4, 4, 0, 0]} name="Correct Audits" />
                  <Bar dataKey="incorrect" fill="#ef4444" radius={[4, 4, 0, 0]} name="Incorrect Audits" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (activeTab === 'reports') {
    const paginatedReports = reportsData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

    return (
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
             <h3 className="text-2xl font-bold tracking-tight">QC Reports</h3>
             <p className="text-slate-500">Download and analyze team quality performance records</p>
          </div>
          <Button className="bg-blue-600 gap-2" onClick={exportQCReport}>
             <Download size={18} /> Export QC Report
          </Button>
        </div>

        <Card className="shadow-sm">
           <CardHeader>
              <div className="flex flex-col md:flex-row gap-4 items-center">
                 <div className="relative flex-1 w-full">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <Input 
                      placeholder="Search by Agent name..." 
                      className="pl-10" 
                      value={searchTerm}
                      onChange={(e) => handleSearchChange(e.target.value)}
                    />
                 </div>
                 <div className="flex gap-2">
                    <Button variant="outline" className="gap-2">
                       <Filter size={16} /> Filter
                    </Button>
                 </div>
              </div>
           </CardHeader>
           <CardContent className="space-y-4">
             <Table>
               <TableHeader>
                 <TableRow>
                   <TableHead className="font-bold">Agent Name</TableHead>
                   <TableHead className="font-bold">Production (Rows)</TableHead>
                   <TableHead className="font-bold">Tasks Audited</TableHead>
                   <TableHead className="font-bold">Rows Audited</TableHead>
                   <TableHead className="font-bold">Error Count</TableHead>
                   <TableHead className="font-bold">Coverage %</TableHead>
                   <TableHead className="font-bold">Avg Score</TableHead>
                 </TableRow>
               </TableHeader>
               <TableBody>
                 {paginatedReports.map((agent, i) => (
                   <TableRow key={agent.name + i}>
                     <TableCell className="font-medium">
                       <div className="flex items-center gap-2">
                          {(() => {
                            const ap = allUsers.find(u => (u.fullName || u.name || '').toLowerCase().trim() === (agent.name || '').toLowerCase().trim());
                            return (
                              <div className="w-7 h-7 rounded-full overflow-hidden bg-slate-100 flex items-center justify-center font-bold text-[10px] text-slate-400 border border-slate-200">
                                {ap?.photoURL ? (
                                  <img src={ap.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                ) : (
                                  (agent.name || '??').split(' ').map(n => n[0]).slice(0, 2).join('')
                                )}
                              </div>
                            );
                          })()}
                          <span>{agent.name}</span>
                       </div>
                     </TableCell>

                     <TableCell className="font-semibold text-slate-600">{agent.production.toLocaleString()}</TableCell>
                     <TableCell className="font-semibold text-slate-800">{agent.auditsDone}</TableCell>
                     <TableCell className="font-semibold text-blue-600">{agent.totalRowsAudited}</TableCell>
                     <TableCell className="font-bold text-red-600">{agent.errors}</TableCell>
                     <TableCell>
                       <span className={`font-bold ${agent.coverage >= 10 ? 'text-green-600' : 'text-amber-600'}`}>
                         {agent.coverage.toFixed(2)}%
                       </span>
                     </TableCell>
                     <TableCell>
                        <span className={`font-black ${agent.score < 90 ? 'text-red-500' : 'text-green-500'}`}>
                          {agent.score.toFixed(2)}%
                        </span>
                     </TableCell>
                   </TableRow>
                 ))}
                 {reportsData.length === 0 && (
                   <TableRow>
                     <TableCell colSpan={7} className="h-32 text-center text-slate-400">
                       No report data available for the selected criteria.
                     </TableCell>
                   </TableRow>
                 )}
               </TableBody>
             </Table>

             {reportsData.length > 0 && (
               <div className="flex items-center justify-between border-t border-slate-100 pt-4">
                 <span className="text-xs font-bold text-slate-500">
                   Showing {Math.min(reportsData.length, (currentPage - 1) * itemsPerPage + 1)}-{Math.min(reportsData.length, currentPage * itemsPerPage)} of {reportsData.length} agents
                 </span>
                 <div className="flex items-center gap-2">
                   <Button
                     variant="outline"
                     size="sm"
                     disabled={currentPage === 1}
                     onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                     className="h-8 font-bold text-xs"
                   >
                     Previous Page
                   </Button>
                   <Button
                     variant="outline"
                     size="sm"
                     disabled={currentPage * itemsPerPage >= reportsData.length}
                     onClick={() => setCurrentPage(p => p + 1)}
                     className="h-8 font-bold text-xs"
                   >
                     Next Page
                   </Button>
                 </div>
               </div>
             )}
           </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-64 text-slate-400">
      <p>Module {activeTab} coming soon...</p>
    </div>
  );
}
