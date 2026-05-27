import React, { useState } from 'react';
import { 
  FileUp, 
  Settings, 
  Users, 
  Database, 
  CheckCircle2, 
  AlertCircle,
  TrendingUp,
  Download,
  History
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import ConfigurationManager from '../components/ConfigurationManager';
import { SamplingTask, UserProfile, QAAlignment, UserRole } from '../types';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, writeBatch, collection, getDocs, deleteDoc, setDoc, updateDoc } from 'firebase/firestore';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Plus, Trash2, ShieldCheck, UserCog } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

interface AdminViewProps {
  activeTab: string;
  tasks: SamplingTask[];
  onTasksUpdate: (tasks: SamplingTask[]) => void;
  user: UserProfile;
  alignments: QAAlignment[];
  onAlignmentsUpdate: (alignments: QAAlignment[]) => void;
  productions?: any[];
  auditLogs?: any[];
  goToTab?: (tab: string) => void;
  allUsers?: UserProfile[];
}

export default function AdminView({ 
  activeTab, 
  tasks, 
  onTasksUpdate, 
  user, 
  alignments, 
  onAlignmentsUpdate,
  productions = [],
  auditLogs = [],
  goToTab,
  allUsers = []
}: AdminViewProps) {
  const [file, setFile] = useState<File | null>(null);
  const [coverage, setCoverage] = useState<string>('10');
  const [minSampleCount, setMinSampleCount] = useState<number>(1);
  const [processing, setProcessing] = useState(false);
  const [fileStatus, setFileStatus] = useState<'none' | 'supported' | 'unsupported'>('none');

  // Role update handler
  const handleRoleUpdate = async (targetUid: string, newRole: UserRole) => {
    if (targetUid === user.uid) {
      toast.error("You cannot change your own role.");
      return;
    }
    
    try {
      await updateDoc(doc(db, 'users', targetUid), {
        role: newRole
      });
      toast.success('User role updated successfully');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${targetUid}`);
    }
  };

  // Mapping TL to Agent/QA handler
  const handleTeamLeadUpdate = async (targetUid: string, tlUid: string) => {
    try {
      const selectedTl = allUsers.find(u => u.uid === tlUid);
      await updateDoc(doc(db, 'users', targetUid), {
        teamLeadId: tlUid || null,
        teamLeadName: selectedTl ? selectedTl.name : null
      });
      toast.success('Team Lead mapped successfully');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${targetUid}`);
    }
  };

  // Alignment editing state
  const [newAlign, setNewAlign] = useState({ qaEmail: '', agentName: '' });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      const isExcel = selectedFile.name.endsWith('.xlsx') || selectedFile.name.endsWith('.xls');
      
      if (!isExcel) {
        toast.error('Only Excel files (.xlsx) are accepted');
        setFileStatus('unsupported');
        return;
      }

      // Check header
      const reader = new FileReader();
      reader.onload = (evt) => {
        const bstream = evt.target?.result;
        const wb = XLSX.read(bstream, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 })[0] as string[];
        
        if (data && data.includes('QV Name')) {
          setFile(selectedFile);
          setFileStatus('supported');
          toast.success('File Supported: Header "QV Name" found');
        } else {
          setFileStatus('unsupported');
          toast.error('Upload a file with header "QV Name"');
        }
      };
      reader.readAsBinaryString(selectedFile);
    }
  };

  const handleStartSampling = async () => {
    const cov = parseInt(coverage);
    if (isNaN(cov) || cov < 0 || cov > 100) {
      toast.error('Incorrect Input. Select value between 0%–100%.');
      return;
    }

    setProcessing(true);
    toast.info('Processing Started...');
    
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstream = evt.target?.result;
        const wb = XLSX.read(bstream, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        
        const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
        if (rawRows.length <= 1) {
          toast.error('File is empty or only contains headers');
          setProcessing(false);
          return;
        }

        const rows = rawRows.slice(1);
        const sampleRate = cov / 100;
        const minSample = minSampleCount;

        const qvGroups: Record<string, { totalRows: number; records: any[] }> = {};
        rows.forEach(row => {
          const qv = row[15];
          if (!qv) return;
          if (!qvGroups[qv]) qvGroups[qv] = { totalRows: 0, records: [] };
          const rowCount = Number(row[16]) || 1; // Default to 1 if missing or 0
          qvGroups[qv].totalRows += rowCount;
          
          // Inject row count into the record so it doesn't default to 0 later
          row[16] = rowCount;
          qvGroups[qv].records.push(row);
        });

        const newSamples: SamplingTask[] = [];
        const timestamp = new Date().toISOString();

        for (const qv in qvGroups) {
          const group = qvGroups[qv];
          const requiredSampleRows = Math.max(minSample, Math.floor(group.totalRows * sampleRate));
          
          const recs = [...group.records];
          for (let i = recs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [recs[i], recs[j]] = [recs[j], recs[i]];
          }

          let pickedRowCount = 0;
          for (let i = 0; i < recs.length && pickedRowCount < requiredSampleRows; i++) {
            const r = recs[i];
            const rowCount = Number(r[16]) || 0;
            pickedRowCount += rowCount;

            newSamples.push({
              id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              taskId: String(r[4] || ''),
              qvName: String(r[15] || ''),
              vertical: String(r[5] || ''),
              sellerId: String(r[8] || ''),
              categoryGroup: String(r[1] || ''),
              rows: rowCount,
              rowsFailed: Number(r[17]) || 0,
              rowsPassed: Number(r[18]) || 0,
              attributesEdited: Number(r[19]) || 0,
              imageReshuffle: Boolean(r[20]),
              status: 'Pending',
              sourceFileId: file?.name || 'manual_upload',
              createdAt: timestamp
            });
          }
        }

        // Write to Firestore in batches (Firestore handles batches up to 500)
        const batch = writeBatch(db);
        newSamples.forEach(task => {
          const taskRef = doc(collection(db, 'tasks'), task.id);
          batch.set(taskRef, task);
        });

        // Save Production Data
        const dateStr = new Date().toISOString().split('T')[0];
        const uniqueId = Math.random().toString(36).substring(7);
        for (const qv in qvGroups) {
          const prodRef = doc(collection(db, 'production'), `${qv}-${dateStr}-${uniqueId}`);
          batch.set(prodRef, {
            qvName: qv,
            date: dateStr,
            totalRows: qvGroups[qv].totalRows,
            totalTasks: qvGroups[qv].records.length
          });
        }
        
        await batch.commit();

        setProcessing(false);
        toast.success(`Sampling Completed. Generated ${newSamples.length} new tasks.`);
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'tasks');
        setProcessing(false);
      }
    };
    if (file) reader.readAsBinaryString(file);
  };

  if (activeTab === 'sampling') {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center text-sm">
          <h3 className="text-xl font-bold">Audit Queue (Global View)</h3>
          <Badge variant="outline">{tasks.length} Total Tasks</Badge>
        </div>
        <div className="grid gap-4">
          {tasks.length === 0 ? (
            <div className="text-center py-20 bg-slate-50 rounded-xl border border-dashed border-slate-200">
              <p className="text-slate-400">No tasks sampled yet. Upload data in Dashboard to begin.</p>
            </div>
          ) : (
            tasks.map((task) => (
              <Card key={task.id} className="shadow-sm">
                <CardContent className="p-4 flex justify-between items-center">
                  <div className="flex gap-4 items-center">
                    <span className="font-mono font-bold text-blue-600">{task.taskId}</span>
                    <div>
                      <p className="font-semibold">{task.qvName}</p>
                      <p className="text-xs text-slate-500">{task.vertical} • {task.categoryGroup}</p>
                    </div>
                  </div>
                  <Badge variant={task.status === 'Pending' ? 'outline' : 'secondary'}>
                    {task.status}
                  </Badge>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    );
  }

  if (activeTab === 'dashboard') {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card 
            className="bg-white border-l-4 border-l-blue-600 cursor-pointer hover:bg-slate-50 transition-colors"
            onClick={() => goToTab?.('completed_audits')}
          >
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-semibold">Total Audits</CardDescription>
              <CardTitle className="text-2xl">{auditLogs?.length || 0}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center text-xs text-blue-600 font-medium">
                <TrendingUp size={12} className="mr-1" /> View all
              </div>
            </CardContent>
          </Card>
          <Card className="bg-white border-l-4 border-l-green-600">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-semibold">Quality Accuracy</CardDescription>
              <CardTitle className="text-2xl">
                {auditLogs && auditLogs.length > 0 
                  ? `${(auditLogs.reduce((acc, log) => acc + (log.quality || 0), 0) / auditLogs.length).toFixed(1)}%` 
                  : 'N/A'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center text-xs text-green-600 font-medium">
                Calculated from {auditLogs?.length || 0} audits
              </div>
            </CardContent>
          </Card>
          <Card 
            className="bg-white border-l-4 border-l-amber-600 cursor-pointer hover:bg-slate-50 transition-colors"
            onClick={() => goToTab?.('disputes')}
          >
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-semibold">Open Disputes</CardDescription>
              <CardTitle className="text-2xl">
                {auditLogs?.filter(log => log.disputeStatus === 'Pending' || log.disputeStatus === 'QA Reviewed').length || 0}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center text-xs text-amber-600 font-medium">
                Action required
              </div>
            </CardContent>
          </Card>
          <Card className="bg-white border-l-4 border-l-purple-600">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-semibold">Active QAs</CardDescription>
              <CardTitle className="text-2xl">
                {new Set(auditLogs?.filter(log => new Date(log.auditDate) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).map(l => l.qaId)).size}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center text-xs text-slate-500 font-medium">
                Active in last 7 days
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileUp className="text-blue-600" size={20} />
                Raw Data Sampling
              </CardTitle>
              <CardDescription>Upload source file and set audit coverage</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="source-file">Source File (.xlsx)</Label>
                <div 
                  className={`border-2 border-dashed rounded-xl p-8 transition-colors flex flex-col items-center justify-center gap-3 cursor-pointer ${
                    fileStatus === 'supported' ? 'border-green-200 bg-green-50' : 
                    fileStatus === 'unsupported' ? 'border-red-200 bg-red-50' : 
                    'border-slate-200 hover:border-blue-300 hover:bg-slate-50'
                  }`}
                  onClick={() => document.getElementById('source-file')?.click()}
                >
                  <Input 
                    id="source-file" 
                    type="file" 
                    className="hidden" 
                    accept=".xlsx,.xls"
                    onChange={handleFileChange}
                  />
                  {fileStatus === 'supported' ? (
                    <CheckCircle2 className="text-green-600" size={32} />
                  ) : fileStatus === 'unsupported' ? (
                    <AlertCircle className="text-red-600" size={32} />
                  ) : (
                    <FileUp className="text-slate-400" size={32} />
                  )}
                  <div className="text-center">
                    <p className="text-sm font-medium">
                      {file ? file.name : 'Click to select or drag and drop'}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      Mandatory header: <span className="font-mono font-bold">"QV Name"</span>
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="coverage">Audit Coverage (%)</Label>
                <div className="flex gap-4">
                  <Input 
                    id="coverage" 
                    type="number" 
                    value={coverage}
                    onChange={(e) => setCoverage(e.target.value)}
                    min="0"
                    max="100"
                    className="flex-1"
                  />
                  <Button 
                    className="bg-blue-600" 
                    disabled={!file || fileStatus !== 'supported' || processing}
                    onClick={handleStartSampling}
                  >
                    {processing ? 'Processing...' : 'Run Sampling'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="text-amber-600" size={20} />
                Global Access & Configuration
              </CardTitle>
              <CardDescription>Manage dropdowns and system overrides</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
               <div className="grid grid-cols-2 gap-4">
                  <Button variant="outline" className="justify-start gap-2">
                    <Settings size={16} /> Error Types
                  </Button>
                  <Button variant="outline" className="justify-start gap-2">
                    <Settings size={16} /> Guidelines
                  </Button>
                  <Button variant="outline" className="justify-start gap-2">
                    <Settings size={16} /> Themes
                  </Button>
                  <Button variant="outline" className="justify-start gap-2">
                    <History size={16} /> Audit Logs
                  </Button>
               </div>
               <div className="p-4 bg-slate-50 rounded-lg border border-slate-100">
                  <h4 className="text-sm font-semibold mb-2">Sampling Console</h4>
                  <div className="space-y-3">
                     <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Skip Limit per QA</span>
                        <input type="number" defaultValue={3} className="w-16 h-8 text-center border rounded" />
                     </div>
                     <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Min Samples per QV</span>
                        <input 
                          type="number" 
                          value={minSampleCount} 
                          onChange={(e) => setMinSampleCount(Number(e.target.value))}
                          className="w-16 h-8 text-center border rounded" 
                        />
                     </div>
                  </div>
               </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }
  if (activeTab === 'config') {
    const teamLeadsList = allUsers.filter(u => u.role === UserRole.TEAM_LEAD);

    return (
      <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-300">
        <ConfigurationManager />
        
        {/* User Management Section */}
        <div className="space-y-6 pt-8 border-t border-slate-200">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h3 className="text-xl font-bold text-[#0F172A] flex items-center gap-2">
                <UserCog size={24} className="text-blue-600" />
                User Access & Role Management
              </h3>
              <p className="text-sm text-slate-500">Promote or demote users to manage system access levels.</p>
            </div>
          </div>

          <Card className="overflow-hidden border-slate-200 shadow-sm bg-white">
            <Table>
              <TableHeader className="bg-slate-50">
                <TableRow>
                  <TableHead className="font-bold text-xs uppercase tracking-wider">User Name</TableHead>
                  <TableHead className="font-bold text-xs uppercase tracking-wider">Email Address</TableHead>
                  <TableHead className="font-bold text-xs uppercase tracking-wider">Current Role</TableHead>
                  <TableHead className="font-bold text-xs uppercase tracking-wider">Modify Role</TableHead>
                  <TableHead className="font-bold text-xs uppercase tracking-wider">Mapped Team Lead</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allUsers.map((u) => (
                  <TableRow key={u.uid} className="hover:bg-slate-50/50">
                    <TableCell className="py-3 text-sm font-bold text-[#0F172A]">{u.name}</TableCell>
                    <TableCell className="py-3 text-sm text-slate-500">{u.email}</TableCell>
                    <TableCell className="py-3">
                      <Badge variant={u.role === UserRole.ADMIN ? 'default' : u.role === UserRole.TEAM_LEAD ? 'secondary' : 'outline'}>
                        {u.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3">
                      <Select 
                        disabled={u.uid === user.uid}
                        onValueChange={(val) => handleRoleUpdate(u.uid, val as UserRole)}
                        defaultValue={u.role}
                      >
                        <SelectTrigger className="w-32 h-8 text-xs">
                          <SelectValue placeholder="Change Role" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UserRole.AGENT}>Agent</SelectItem>
                          <SelectItem value={UserRole.QA}>QA</SelectItem>
                          <SelectItem value={UserRole.TEAM_LEAD}>Team Lead</SelectItem>
                          <SelectItem value={UserRole.ADMIN}>Admin</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="py-3">
                      {u.role === UserRole.AGENT || u.role === UserRole.QA ? (
                        <Select 
                          onValueChange={(val) => handleTeamLeadUpdate(u.uid, val === 'none' ? '' : val)}
                          defaultValue={u.teamLeadId || 'none'}
                        >
                          <SelectTrigger className="w-40 h-8 text-xs">
                            <SelectValue placeholder="None Assigned" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None Assigned</SelectItem>
                            {teamLeadsList.map(tl => (
                              <SelectItem key={tl.uid} value={tl.uid}>{tl.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-slate-400 italic">N/A</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>

        <div className="space-y-6 pt-8 border-t border-slate-200">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h3 className="text-xl font-bold text-[#0F172A]">QA-Agent Relationship Alignment</h3>
              <p className="text-sm text-slate-500">Manage which Agents are audited by which Quality Analysts.</p>
            </div>
            <div className="flex flex-wrap gap-2">
               <Input 
                 placeholder="QA Email" 
                 className="w-full md:w-48 h-9 text-xs" 
                 value={newAlign.qaEmail}
                 onChange={(e) => setNewAlign({...newAlign, qaEmail: e.target.value})}
               />
               <Input 
                 placeholder="Agent Name" 
                 className="w-full md:w-48 h-9 text-xs" 
                 value={newAlign.agentName}
                 onChange={(e) => setNewAlign({...newAlign, agentName: e.target.value})}
               />
               <Button 
                 size="sm" 
                 className="bg-[#0F172A] hover:bg-slate-900 gap-1 h-9 w-full md:w-auto"
                 onClick={() => {
                   if (newAlign.qaEmail && newAlign.agentName) {
                     onAlignmentsUpdate([...alignments, newAlign]);
                     setNewAlign({ qaEmail: '', agentName: '' });
                     toast.success('Alignment added successfully');
                   } else {
                     toast.error('Please fill both QA Email and Agent Name');
                   }
                 }}
               >
                 <Plus size={14} /> Add Alignment
               </Button>
            </div>
          </div>

          <Card className="overflow-hidden border-slate-200 shadow-sm">
            <div className="max-h-[500px] overflow-auto">
              <Table>
                <TableHeader className="bg-slate-50 sticky top-0 z-10">
                  <TableRow>
                    <TableHead className="font-bold text-xs uppercase tracking-wider">QA Email</TableHead>
                    <TableHead className="font-bold text-xs uppercase tracking-wider">Agent Name (Alignment)</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {alignments.map((align, idx) => (
                    <TableRow key={`${align.qaEmail}-${align.agentName}-${idx}`} className="hover:bg-slate-50/50">
                      <TableCell className="py-3 text-sm text-slate-600 font-medium">{align.qaEmail}</TableCell>
                      <TableCell className="py-3 text-sm font-bold text-[#0F172A]">{align.agentName}</TableCell>
                      <TableCell className="py-3 text-right">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-slate-400 hover:text-red-600 transition-colors"
                          onClick={() => {
                            onAlignmentsUpdate(alignments.filter((_, i) => i !== idx));
                            toast.info('Alignment removed');
                          }}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {alignments.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="h-32 text-center text-slate-400">
                        <div className="flex flex-col items-center gap-2">
                          <Users size={32} className="opacity-20" />
                          <p>No alignments defined. Use the form above to start mapping.</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return null; // Handled at App level
}

