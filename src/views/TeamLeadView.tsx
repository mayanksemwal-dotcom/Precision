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
  Download
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
import { SamplingTask, AuditRecord, UserRole, UserProfile, QAAlignment, ProductionRecord } from '../types';
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
}

export default function TeamLeadView({ activeTab, tasks = [], auditLogs = [], user, alignments = [], productions = [], goToTab }: TeamLeadViewProps) {
  const [searchTerm, setSearchTerm] = useState('');

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

    // 3. Filter for QA role alignment
    let dataList = Object.values(agentMap);
    if (user?.role === UserRole.QA) {
      const myAlignedAgents = alignments
        .filter(a => a.qaEmail.toLowerCase() === user.email.toLowerCase())
        .map(a => a.agentName);
      dataList = dataList.filter(a => myAlignedAgents.includes(a.name));
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
    }).filter(a => a.name.toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => b.coverage - a.coverage);
  }, [tasks, auditLogs, searchTerm, user, alignments, productions]);

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
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs font-bold uppercase">Team MTD Quality</CardDescription>
              <CardTitle className="text-2xl font-black">93.2%</CardTitle>
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
              <CardTitle className="text-2xl font-black">8</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-amber-600 font-medium">Needs review</div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs font-bold uppercase">Pending Feedback</CardDescription>
              <CardTitle className="text-2xl font-black">12</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-slate-500 font-medium">Awaiting agent response</div>
            </CardContent>
          </Card>
        </div>

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
                      placeholder="Search by Agent name or Task ID..." 
                      className="pl-10" 
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                    />
                 </div>
                 <div className="flex gap-2">
                    <Button variant="outline" className="gap-2">
                       <Filter size={16} /> Filter
                    </Button>
                 </div>
              </div>
           </CardHeader>
           <CardContent>
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
                 {reportsData.map((agent, i) => (
                   <TableRow key={agent.name + i}>
                     <TableCell className="font-medium">{agent.name}</TableCell>
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
                     <TableCell colSpan={6} className="h-32 text-center text-slate-400">
                       No report data available for the selected criteria.
                     </TableCell>
                   </TableRow>
                 )}
               </TableBody>
             </Table>
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
