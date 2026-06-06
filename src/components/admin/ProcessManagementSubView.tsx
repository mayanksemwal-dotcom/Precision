import React, { useState, useEffect } from 'react';
import { 
  Plus, 
  Search, 
  Trash2, 
  Edit2, 
  CheckCircle, 
  XCircle,
  Database,
  Activity,
  AlertTriangle
} from 'lucide-react';
import { 
  doc, 
  onSnapshot,
  setDoc
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { UserProfile } from '../../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { toast } from 'sonner';

interface ProcessManagementSubViewProps {
  user: UserProfile;
  adminTheme: 'light' | 'dark';
}

interface MiniProcess {
  name: string;
  status: 'Active' | 'Inactive';
}

const DEFAULT_PROCESSES = ['HITL', 'MPQC', 'OQC', 'SOP Training', 'QA Review', 'Team Alignment'];

export const ProcessManagementSubView = ({ user, adminTheme }: ProcessManagementSubViewProps) => {
  const [processes, setProcesses] = useState<MiniProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Form states
  const [isAddingOrEditing, setIsAddingOrEditing] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [formName, setFormName] = useState('');

  // Fetch from config/tmsProcesses in real-time
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'config', 'tmsProcesses'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        let loaded: MiniProcess[] = [];
        if (Array.isArray(data.processes)) {
          loaded = data.processes;
        } else if (Array.isArray(data.list)) {
          loaded = data.list.map((name: string) => ({
            name,
            status: 'Active' as const
          }));
        } else {
          loaded = DEFAULT_PROCESSES.map(name => ({
            name,
            status: 'Active' as const
          }));
        }
        setProcesses(loaded);
      } else {
        const initial = DEFAULT_PROCESSES.map(name => ({
          name,
          status: 'Active' as const
        }));
        setProcesses(initial);
      }
      setLoading(false);
    }, (err) => {
      console.error('Failed to subscribe to processes config', err);
      toast.error('Failed to sync process list in real time');
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // Save both structured and clean array format for backward compatibility
  const saveToConfig = async (updatedProcesses: MiniProcess[]) => {
    const activeList = updatedProcesses
      .filter(p => p.status === 'Active')
      .map(p => p.name);

    try {
      await setDoc(doc(db, 'config', 'tmsProcesses'), {
        list: activeList,
        processes: updatedProcesses
      }, { merge: true });
    } catch (err) {
      console.error(err);
      toast.error('Failed to save processes: ' + (err as Error).message);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = formName.trim();
    if (!cleanName) {
      toast.error('Process name cannot be empty');
      return;
    }

    const nameLower = cleanName.toLowerCase();
    const duplicate = processes.some((p, idx) => p.name.toLowerCase() === nameLower && idx !== editIndex);
    if (duplicate) {
      toast.error('A process with this name already exists');
      return;
    }

    let nextList = [...processes];
    if (editIndex !== null) {
      nextList[editIndex] = {
        ...nextList[editIndex],
        name: cleanName
      };
      toast.success('Process updated successfully');
    } else {
      nextList.push({
        name: cleanName,
        status: 'Active'
      });
      toast.success('New process added successfully');
    }

    setIsAddingOrEditing(false);
    setEditIndex(null);
    setFormName('');
    await saveToConfig(nextList);
  };

  const toggleStatus = async (index: number) => {
    const nextList = [...processes];
    nextList[index].status = nextList[index].status === 'Active' ? 'Inactive' : 'Active';
    await saveToConfig(nextList);
    toast.success(`Process "${nextList[index].name}" is now ${nextList[index].status}`);
  };

  const deleteProcess = async (index: number) => {
    const name = processes[index].name;
    if (!confirm(`Are you sure you want to delete the process "${name}"? Check if any users are mapped to it.`)) {
      return;
    }
    const nextList = processes.filter((_, idx) => idx !== index);
    await saveToConfig(nextList);
    toast.success(`Process "${name}" has been deleted`);
  };

  const handleResetToDefaults = async () => {
    if (!confirm('This will restore all legacy default processes (HITL, MPQC, OQC, etc.) as active. Continue?')) {
      return;
    }
    const initial = DEFAULT_PROCESSES.map(name => ({
      name,
      status: 'Active' as const
    }));
    await saveToConfig(initial);
    toast.success('Restored default TMS processes successfully');
  };

  const filtered = processes.filter(p => 
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <Activity size={32} className="animate-spin text-indigo-500" />
        <p className="text-xs font-mono font-bold text-slate-400 uppercase tracking-widest">Loading configuration parameters...</p>
      </div>
    );
  }

  const isDark = adminTheme === 'dark';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className={`text-xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            ⚙️ TMS Process Configuration
          </h2>
          <p className="text-xs text-slate-400 font-bold uppercase tracking-wide mt-1">
            Manage available dropdown values for Punch In & Process Switch
          </p>
        </div>
        <div className="flex gap-2">
          <Button 
            onClick={handleResetToDefaults} 
            variant="outline" 
            className="text-amber-500 border-amber-500/20 hover:bg-amber-500/10 font-bold rounded-xl text-xs h-10 px-4"
          >
            <Database size={15} className="mr-2" /> Reset defaults
          </Button>
          <Button 
            onClick={() => {
              setEditIndex(null);
              setFormName('');
              setIsAddingOrEditing(true);
            }} 
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl h-10 px-5 shadow-lg shadow-indigo-500/20 text-xs"
          >
            <Plus size={15} className="mr-2" /> Add process
          </Button>
        </div>
      </div>

      <Card className={`border-none ${isDark ? 'bg-slate-850 shadow-none' : 'bg-white shadow-md shadow-slate-200'}`}>
        <CardHeader className="bg-slate-50/10 border-b border-slate-100/10 p-6">
          <div className="relative max-w-md w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <Input 
              placeholder="Filter processes..." 
              className={`pl-10 h-10 rounded-xl text-xs ${isDark ? 'bg-slate-900 border-slate-800 text-white' : 'border-slate-200 bg-white'}`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className={`font-bold uppercase tracking-widest text-[10px] border-b border-slate-100/10 ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
                  <th className="p-4 pl-6">Process Name</th>
                  <th className="p-4 text-center">Status</th>
                  <th className="p-4 text-right pr-6">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100/10">
                {filtered.length > 0 ? (
                  filtered.map((proc, idx) => (
                    <tr key={idx} className={`${isDark ? 'hover:bg-slate-800/40 text-slate-200' : 'hover:bg-slate-50/50 text-slate-700'} transition-colors group`}>
                      <td className="p-4 pl-6">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-[10px] uppercase shadow-sm ${
                            proc.status === 'Active' ? 'bg-indigo-500/10 text-indigo-505' : 'bg-slate-500/10 text-slate-404'
                          }`}>
                            {proc.name.slice(0, 2)}
                          </div>
                          <div>
                            <p className="font-extrabold text-sm">{proc.name}</p>
                            <p className="text-[10px] font-medium text-slate-400">Used for client billing, mapping & productivity tags</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4 text-center">
                        <button 
                          onClick={() => toggleStatus(idx)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wide transition-colors ${
                            proc.status === 'Active' 
                              ? 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20' 
                              : 'bg-rose-500/10 text-rose-500 hover:bg-rose-500/20'
                          }`}
                        >
                          {proc.status === 'Active' ? <CheckCircle size={10} /> : <XCircle size={10} />}
                          {proc.status}
                        </button>
                      </td>
                      <td className="p-4 text-right pr-6">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-sky-500 rounded-lg hover:bg-sky-505/10"
                            onClick={() => {
                              setEditIndex(idx);
                              setFormName(proc.name);
                              setIsAddingOrEditing(true);
                            }}
                          >
                            <Edit2 size={13} />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-rose-500 rounded-lg hover:bg-rose-505/10"
                            onClick={() => deleteProcess(idx)}
                          >
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} className="p-12 text-center text-slate-400 font-bold uppercase tracking-wider text-[11px]">
                      No custom TMS processes configured inside the system database.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Info notice */}
      <div className={`p-4 rounded-2xl border flex items-start gap-3 ${
        isDark ? 'bg-slate-900/40 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'
      }`}>
        <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
        <div className="text-xs space-y-1">
          <p className="font-bold uppercase tracking-wider text-amber-500">Security & Synchronization Protocol</p>
          <p className="leading-relaxed">
            Removing or disabling processes here directly restricts operational shifts from selecting those codes during <b>Punch In</b> or <b>Process Switch</b> workflows. This prevents unauthorized billing mapping without modifying historic shifts DB.
          </p>
        </div>
      </div>

      {/* Add/Edit Modal */}
      {isAddingOrEditing && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-[2000] flex items-center justify-center p-4">
          <Card className={`max-w-md w-full shadow-2xl border-none rounded-3xl animate-in zoom-in-95 duration-200 ${
            isDark ? 'bg-slate-900 text-white' : 'bg-white text-slate-900'
          }`}>
            <form onSubmit={handleSave}>
              <CardHeader className="bg-slate-900 text-white rounded-t-3xl pb-8">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-500 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
                    <Activity size={20} />
                  </div>
                  <div>
                    <CardTitle className="text-lg font-black text-white">
                      {editIndex !== null ? 'Update Process' : 'Add New Process'}
                    </CardTitle>
                    <CardDescription className="text-slate-400 text-xs">
                      Configure how this activity appears in operational dropdown selectors
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              
              <CardContent className="pt-8 space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">
                    Process Identifier Label
                  </Label>
                  <Input 
                    placeholder="e.g. SOP Training, MPQC Assessor, SOP Validation" 
                    className={`rounded-xl h-11 text-xs font-bold ${
                      isDark ? 'bg-slate-950 border-slate-800 text-white' : 'border-slate-200'
                    }`}
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
              </CardContent>
              
              <div className="flex justify-end gap-2.5 p-6 border-t border-slate-100/10">
                <Button 
                  type="button" 
                  variant="ghost" 
                  onClick={() => setIsAddingOrEditing(false)} 
                  className={`rounded-xl font-bold text-xs h-10 ${isDark ? 'hover:bg-slate-800' : ''}`}
                >
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl px-6 h-10 text-xs"
                >
                  {editIndex !== null ? 'Save Changes' : 'Initialize Activity'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
};
