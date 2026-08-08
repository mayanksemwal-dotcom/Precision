import React, { useState, useEffect, useMemo } from 'react';
import { 
  Plus, 
  Search, 
  Trash2, 
  Edit2, 
  CheckCircle, 
  XCircle, 
  Wifi, 
  Clock, 
  ArrowUpDown, 
  Globe, 
  ShieldAlert,
  Loader2,
  X
} from 'lucide-react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { UserProfile } from '../../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { toast } from 'sonner';
import { useConfig } from '../../contexts/ConfigContext';

interface OfficeNetwork {
  id: string;
  officeName: string;
  publicIP: string;
  status: boolean; // true = Active, false = Inactive
  description?: string;
  createdAt: any;
  updatedAt: any;
}

interface OfficeNetworksSubViewProps {
  user: UserProfile;
  adminTheme: 'light' | 'dark';
}

const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

const formatSafeDate = (val: any) => {
  if (!val) return 'N/A';
  let date: Date;
  if (typeof val.toDate === 'function') {
    date = val.toDate();
  } else if (val instanceof Date) {
    date = val;
  } else if (typeof val === 'string' || typeof val === 'number') {
    date = new Date(val);
  } else if (val.seconds !== undefined) {
    date = new Date(val.seconds * 1000);
  } else {
    return 'N/A';
  }
  return isNaN(date.getTime()) ? 'N/A' : date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
};

export const OfficeNetworksSubView = ({ user, adminTheme }: OfficeNetworksSubViewProps) => {
  const { refreshAll } = useConfig();
  const [offices, setOffices] = useState<OfficeNetwork[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'officeName' | 'createdAt' | 'status'>('officeName');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Modal / Form state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  // Form Inputs
  const [formOfficeName, setFormOfficeName] = useState('');
  const [formPublicIP, setFormPublicIP] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formStatus, setFormStatus] = useState<boolean>(true);

  const isAdmin = (user.role || '').toUpperCase() === 'ADMIN';

  // Fetch Office Networks from config/office_networks
  const fetchOfficeNetworks = async () => {
    setLoading(true);
    try {
      const docRef = doc(db, 'config', 'office_networks');
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (Array.isArray(data.offices)) {
          setOffices(data.offices);
        } else if (Array.isArray(data.officeIPs)) {
          // Backward compatibility conversion
          const converted = data.officeIPs.map((ip: string, idx: number) => ({
            id: `legacy_${idx}_${Date.now()}`,
            officeName: `Berg Office ${idx + 1}`,
            publicIP: ip,
            status: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }));
          setOffices(converted);
        } else {
          setOffices([]);
        }
      } else {
        // Create initial placeholder if none exists
        const initial = [
          {
            id: 'office_001',
            officeName: 'Berg Dehradun',
            publicIP: '115.243.137.122',
            status: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: 'office_002',
            officeName: 'Berg Noida',
            publicIP: '125.23.171.67',
            status: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ];
        await setDoc(docRef, { offices: initial });
        setOffices(initial);
      }
    } catch (err) {
      console.error('Error fetching office networks:', err);
      toast.error('Failed to load office networks.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOfficeNetworks();
  }, []);

  const openAddForm = () => {
    if (!isAdmin) {
      toast.error('Only Admins can perform this action.');
      return;
    }
    setEditingId(null);
    setFormOfficeName('');
    setFormPublicIP('');
    setFormDescription('');
    setFormStatus(true);
    setIsFormOpen(true);
  };

  const openEditForm = (office: OfficeNetwork) => {
    if (!isAdmin) {
      toast.error('Only Admins can perform this action.');
      return;
    }
    setEditingId(office.id);
    setFormOfficeName(office.officeName);
    setFormPublicIP(office.publicIP);
    setFormDescription(office.description || '');
    setFormStatus(office.status);
    setIsFormOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) {
      toast.error('Permission Denied.');
      return;
    }

    // Validation
    const trimmedName = formOfficeName.trim();
    const trimmedIP = formPublicIP.trim();

    if (!trimmedName) {
      toast.error('Office Name is required.');
      return;
    }
    if (!trimmedIP) {
      toast.error('Public IP Address is required.');
      return;
    }

    // IP v4 Format check
    if (!IPV4_REGEX.test(trimmedIP)) {
      toast.error('Invalid IPv4 format. Must be a valid IP address (e.g., 192.168.1.1).');
      return;
    }

    // Duplicate IP check
    const isDuplicate = offices.some(off => 
      off.id !== editingId && 
      off.publicIP.trim() === trimmedIP
    );
    if (isDuplicate) {
      toast.error(`Duplicate IP detected. ${trimmedIP} is already configured.`);
      return;
    }

    setSaving(true);
    try {
      const nowString = new Date().toISOString();
      let updatedList: OfficeNetwork[] = [];

      if (editingId) {
        // Edit existing
        updatedList = offices.map(off => {
          if (off.id === editingId) {
            return {
              ...off,
              officeName: trimmedName,
              publicIP: trimmedIP,
              description: formDescription.trim(),
              status: formStatus,
              updatedAt: nowString
            };
          }
          return off;
        });
      } else {
        // Add new
        const newOffice: OfficeNetwork = {
          id: `office_${Date.now()}`,
          officeName: trimmedName,
          publicIP: trimmedIP,
          description: formDescription.trim(),
          status: formStatus,
          createdAt: nowString,
          updatedAt: nowString
        };
        updatedList = [...offices, newOffice];
      }

      await setDoc(doc(db, 'config', 'office_networks'), { offices: updatedList });
      setOffices(updatedList);
      toast.success(editingId ? 'Office Network updated successfully!' : 'Office Network created successfully!');
      setIsFormOpen(false);
      
      // Force Config Context to refresh immediately!
      await refreshAll();
    } catch (err) {
      console.error('Error saving office network:', err);
      toast.error('Failed to save office network.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!isAdmin) {
      toast.error('Only Admins can delete networks.');
      return;
    }
    if (!window.confirm(`Are you sure you want to delete "${name}" from Office Networks?`)) {
      return;
    }

    try {
      const updatedList = offices.filter(off => off.id !== id);
      await setDoc(doc(db, 'config', 'office_networks'), { offices: updatedList });
      setOffices(updatedList);
      toast.success(`"${name}" deleted successfully.`);
      await refreshAll();
    } catch (err) {
      console.error('Error deleting office network:', err);
      toast.error('Failed to delete office network.');
    }
  };

  const handleToggleStatus = async (office: OfficeNetwork) => {
    if (!isAdmin) {
      toast.error('Only Admins can modify status.');
      return;
    }

    try {
      const updatedList = offices.map(off => {
        if (off.id === office.id) {
          return {
            ...off,
            status: !off.status,
            updatedAt: new Date().toISOString()
          };
        }
        return off;
      });

      await setDoc(doc(db, 'config', 'office_networks'), { offices: updatedList });
      setOffices(updatedList);
      toast.success(`"${office.officeName}" is now ${!office.status ? 'Active' : 'Inactive'}.`);
      await refreshAll();
    } catch (err) {
      console.error('Error toggling status:', err);
      toast.error('Failed to update status.');
    }
  };

  // Stats computed from offices
  const stats = useMemo(() => {
    const total = offices.length;
    const active = offices.filter(o => o.status).length;
    const inactive = total - active;
    return { total, active, inactive };
  }, [offices]);

  // Search & Sorting processing
  const filteredAndSorted = useMemo(() => {
    let result = offices.filter(off => {
      const query = searchQuery.toLowerCase().trim();
      return (
        off.officeName.toLowerCase().includes(query) ||
        off.publicIP.toLowerCase().includes(query) ||
        (off.description && off.description.toLowerCase().includes(query))
      );
    });

    result.sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'officeName') {
        comparison = a.officeName.localeCompare(b.officeName);
      } else if (sortBy === 'createdAt') {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        comparison = dateA - dateB;
      } else if (sortBy === 'status') {
        comparison = (a.status ? 1 : 0) - (b.status ? 1 : 0);
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [offices, searchQuery, sortBy, sortOrder]);

  const toggleSort = (field: 'officeName' | 'createdAt' | 'status') => {
    if (sortBy === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Read-Only Banner */}
      {!isAdmin && (
        <div className="flex items-center gap-3 p-3.5 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-2xl text-xs font-semibold">
          <ShieldAlert size={16} />
          <span>Read-Only Access: As a non-administrator, you can view the Office Networks config but cannot create, modify, or delete configurations.</span>
        </div>
      )}

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className={`border ${adminTheme === 'dark' ? 'border-slate-800 bg-slate-900/40 text-slate-100' : 'border-slate-200 bg-white'}`}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Office Networks</p>
                <h3 className="text-2xl font-black mt-1 text-slate-800 dark:text-slate-100">{stats.total}</h3>
              </div>
              <div className="p-3 bg-indigo-50 dark:bg-indigo-950/40 rounded-2xl text-indigo-500">
                <Globe size={22} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={`border ${adminTheme === 'dark' ? 'border-slate-800 bg-slate-900/40 text-slate-100' : 'border-slate-200 bg-white'}`}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Active Networks</p>
                <h3 className="text-2xl font-black mt-1 text-emerald-600 dark:text-emerald-400">{stats.active}</h3>
              </div>
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 rounded-2xl text-emerald-500">
                <CheckCircle size={22} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={`border ${adminTheme === 'dark' ? 'border-slate-800 bg-slate-900/40 text-slate-100' : 'border-slate-200 bg-white'}`}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Inactive Networks</p>
                <h3 className="text-2xl font-black mt-1 text-rose-600 dark:text-rose-400">{stats.inactive}</h3>
              </div>
              <div className="p-3 bg-rose-50 dark:bg-rose-950/40 rounded-2xl text-rose-500">
                <XCircle size={22} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Control Panel (Search, Sort and Add Network Button) */}
      <div className="flex flex-col md:flex-row justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input 
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by Office Name or Public IP..." 
            className={`pl-10 text-xs font-medium rounded-xl h-10 ${
              adminTheme === 'dark' 
                ? 'bg-slate-950/40 border-slate-800 text-slate-100 focus:border-indigo-500' 
                : 'bg-white border-slate-200 text-slate-800 focus:border-indigo-500'
            }`}
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Sorting Buttons */}
          <div className="flex rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden text-xs">
            <button 
              onClick={() => toggleSort('officeName')}
              className={`px-3 py-2 font-bold flex items-center gap-1.5 transition-colors cursor-pointer ${
                sortBy === 'officeName' 
                  ? 'bg-indigo-600 text-white' 
                  : (adminTheme === 'dark' ? 'bg-slate-950/20 text-slate-400 hover:bg-slate-800' : 'bg-white text-slate-600 hover:bg-slate-50')
              }`}
            >
              Office Name <ArrowUpDown size={11} />
            </button>
            <button 
              onClick={() => toggleSort('createdAt')}
              className={`px-3 py-2 font-bold flex items-center gap-1.5 transition-colors cursor-pointer border-l border-slate-200 dark:border-slate-800 ${
                sortBy === 'createdAt' 
                  ? 'bg-indigo-600 text-white' 
                  : (adminTheme === 'dark' ? 'bg-slate-950/20 text-slate-400 hover:bg-slate-800' : 'bg-white text-slate-600 hover:bg-slate-50')
              }`}
            >
              Created Date <ArrowUpDown size={11} />
            </button>
            <button 
              onClick={() => toggleSort('status')}
              className={`px-3 py-2 font-bold flex items-center gap-1.5 transition-colors cursor-pointer border-l border-slate-200 dark:border-slate-800 ${
                sortBy === 'status' 
                  ? 'bg-indigo-600 text-white' 
                  : (adminTheme === 'dark' ? 'bg-slate-950/20 text-slate-400 hover:bg-slate-800' : 'bg-white text-slate-600 hover:bg-slate-50')
              }`}
            >
              Status <ArrowUpDown size={11} />
            </button>
          </div>

          {/* Add Network Button (Only for Admins) */}
          {isAdmin && (
            <Button 
              onClick={openAddForm}
              className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2 h-10 rounded-xl flex items-center gap-1.5 cursor-pointer"
            >
              <Plus size={15} />
              Add Office Network
            </Button>
          )}
        </div>
      </div>

      {/* Main Table */}
      <Card className={`border ${adminTheme === 'dark' ? 'border-slate-800 bg-slate-900/40' : 'border-slate-200 bg-white'}`}>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-400">
              <Loader2 className="animate-spin text-indigo-500" size={24} />
              <p className="text-xs font-semibold">Loading Office Networks...</p>
            </div>
          ) : filteredAndSorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-slate-400 text-center">
              <Wifi size={32} className="text-slate-350 dark:text-slate-700" />
              <h4 className="text-sm font-black text-slate-600 dark:text-slate-400 mt-2">No Networks Configured</h4>
              <p className="text-xs max-w-xs text-slate-450 dark:text-slate-500">
                {searchQuery ? 'No configurations matched your search criteria.' : 'Please configure office IP networks to trigger automated location matching.'}
              </p>
              {!searchQuery && isAdmin && (
                <Button 
                  onClick={openAddForm}
                  className="bg-indigo-600/10 text-indigo-500 hover:bg-indigo-600/20 text-xs font-bold px-3 py-1.5 rounded-xl mt-3"
                >
                  Configure First Network
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className={`text-[10px] font-black uppercase tracking-widest border-b ${
                    adminTheme === 'dark' ? 'border-slate-800 bg-slate-950/25 text-slate-400' : 'border-slate-100 bg-slate-50 text-slate-500'
                  }`}>
                    <th className="p-4 pl-6">Office Name</th>
                    <th className="p-4">Public IP Address</th>
                    <th className="p-4">Description</th>
                    <th className="p-4 text-center">Status</th>
                    <th className="p-4">Created Date</th>
                    <th className="p-4">Updated Date</th>
                    {isAdmin && <th className="p-4 text-right pr-6">Actions</th>}
                  </tr>
                </thead>
                <tbody className={`divide-y ${adminTheme === 'dark' ? 'divide-slate-800/60' : 'divide-slate-100'}`}>
                  {filteredAndSorted.map(off => (
                    <tr 
                      key={off.id}
                      className={`text-xs transition-colors ${
                        adminTheme === 'dark' ? 'hover:bg-slate-950/10' : 'hover:bg-slate-50/50'
                      }`}
                    >
                      <td className="p-4 pl-6 font-black text-slate-800 dark:text-slate-200">
                        {off.officeName}
                      </td>
                      <td className="p-4 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                        {off.publicIP}
                      </td>
                      <td className="p-4 text-slate-400 font-medium max-w-[200px] truncate" title={off.description}>
                        {off.description || '—'}
                      </td>
                      <td className="p-4 text-center">
                        <button
                          disabled={!isAdmin}
                          onClick={() => handleToggleStatus(off)}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide transition-all ${
                            isAdmin ? 'cursor-pointer hover:scale-102 active:scale-98' : 'cursor-default'
                          } ${
                            off.status
                              ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                              : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${off.status ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                          {off.status ? 'Active' : 'Inactive'}
                        </button>
                      </td>
                      <td className="p-4 font-medium text-slate-400">
                        <div className="flex items-center gap-1">
                          <Clock size={11} />
                          <span>{formatSafeDate(off.createdAt)}</span>
                        </div>
                      </td>
                      <td className="p-4 font-medium text-slate-400">
                        <div className="flex items-center gap-1">
                          <Clock size={11} />
                          <span>{formatSafeDate(off.updatedAt)}</span>
                        </div>
                      </td>
                      {isAdmin && (
                        <td className="p-4 text-right pr-6">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => openEditForm(off)}
                              className="p-1.5 hover:bg-slate-500/10 text-indigo-500 dark:text-indigo-400 rounded-lg transition-colors cursor-pointer"
                              title="Edit Office"
                            >
                              <Edit2 size={13.5} />
                            </button>
                            <button
                              onClick={() => handleDelete(off.id, off.officeName)}
                              className="p-1.5 hover:bg-rose-500/10 text-rose-500 rounded-lg transition-colors cursor-pointer"
                              title="Delete Office"
                            >
                              <Trash2 size={13.5} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Slide-over / Modal Form (Admin Only) */}
      {isFormOpen && isAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className={`w-full max-w-md border rounded-2xl shadow-xl overflow-hidden p-6 animate-in zoom-in-95 duration-150 ${
            adminTheme === 'dark' ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-800'
          }`}>
            <div className="flex justify-between items-center border-b border-slate-150/10 dark:border-slate-800 pb-3 mb-4">
              <h3 className="text-sm font-black uppercase tracking-wider text-indigo-500">
                {editingId ? '📝 Edit Office Network' : '🏢 Add Office Network'}
              </h3>
              <button 
                onClick={() => setIsFormOpen(false)}
                className="p-1 hover:bg-slate-500/10 rounded-lg text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Office Name *</Label>
                <Input 
                  required
                  value={formOfficeName}
                  onChange={e => setFormOfficeName(e.target.value)}
                  placeholder="e.g. Berg Dehradun"
                  className={`text-xs font-bold rounded-xl ${
                    adminTheme === 'dark' 
                      ? 'bg-slate-950/40 border-slate-800 text-slate-100 focus:border-indigo-500' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-indigo-500'
                  }`}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Public IP Address *</Label>
                <Input 
                  required
                  value={formPublicIP}
                  onChange={e => setFormPublicIP(e.target.value)}
                  placeholder="e.g. 115.243.137.122"
                  className={`text-xs font-bold rounded-xl font-mono ${
                    adminTheme === 'dark' 
                      ? 'bg-slate-950/40 border-slate-800 text-slate-100 focus:border-indigo-500' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-indigo-500'
                  }`}
                />
                <span className="text-[9px] text-slate-400 font-medium">Must be a valid, unique IPv4 address format.</span>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Description (Optional)</Label>
                <Input 
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  placeholder="e.g. Main development headquarter branch"
                  className={`text-xs font-bold rounded-xl ${
                    adminTheme === 'dark' 
                      ? 'bg-slate-950/40 border-slate-800 text-slate-100 focus:border-indigo-500' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-indigo-500'
                  }`}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Status</Label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
                    <input 
                      type="radio" 
                      name="status"
                      checked={formStatus === true}
                      onChange={() => setFormStatus(true)}
                      className="accent-indigo-600"
                    />
                    <span className="text-slate-800 dark:text-slate-200">Active</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
                    <input 
                      type="radio" 
                      name="status"
                      checked={formStatus === false}
                      onChange={() => setFormStatus(false)}
                      className="accent-indigo-600"
                    />
                    <span className="text-slate-800 dark:text-slate-200">Inactive</span>
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-150/10 dark:border-slate-800 mt-6">
                <Button 
                  type="button" 
                  onClick={() => setIsFormOpen(false)}
                  className={`text-xs font-bold px-4 py-2 rounded-xl border h-10 ${
                    adminTheme === 'dark' 
                      ? 'bg-slate-800/80 border-slate-700 hover:bg-slate-700/80 text-slate-300' 
                      : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  disabled={saving}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2 h-10 rounded-xl flex items-center gap-1.5"
                >
                  {saving ? (
                    <>
                      <Loader2 className="animate-spin" size={13} />
                      Saving...
                    </>
                  ) : (
                    'Save Network'
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
