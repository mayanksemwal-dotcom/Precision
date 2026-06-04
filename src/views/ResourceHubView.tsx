import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, addDoc, getDocs, deleteDoc, doc, query, orderBy } from 'firebase/firestore';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { toast } from 'sonner';
import { 
  Link2, 
  Trash2, 
  Plus, 
  Search, 
  ClipboardList, 
  BookOpen, 
  Activity, 
  GraduationCap, 
  ExternalLink, 
  Copy, 
  Check, 
  Calendar, 
  User, 
  Sparkles, 
  FolderOpen,
  FilterX,
  X
} from 'lucide-react';
import { UserProfile } from '../types';

interface ResourceLink {
  id: string;
  name: string;
  url: string;
  category: string;
  description?: string;
  createdBy: string;
  createdAt: string;
}

const CATEGORIES = [
  { 
    id: 'TRACKER', 
    label: 'Trackers & Logs', 
    icon: ClipboardList, 
    colorClass: 'bg-blue-50 text-blue-700 border-blue-200 ring-blue-500/20', 
    iconBg: 'bg-blue-100 text-blue-600',
    borderColor: 'border-blue-100 hover:border-blue-300'
  },
  { 
    id: 'GUIDELINE', 
    label: 'Guidelines & SOPs', 
    icon: BookOpen, 
    colorClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 ring-emerald-500/20', 
    iconBg: 'bg-emerald-100 text-emerald-600',
    borderColor: 'border-emerald-100 hover:border-emerald-300'
  },
  { 
    id: 'OPERATIONS', 
    label: 'Ops Dashboards', 
    icon: Activity, 
    colorClass: 'bg-indigo-50 text-indigo-700 border-indigo-200 ring-indigo-500/20', 
    iconBg: 'bg-indigo-100 text-indigo-600',
    borderColor: 'border-indigo-100 hover:border-indigo-300'
  },
  { 
    id: 'TRAINING', 
    label: 'Training & SME Guide', 
    icon: GraduationCap, 
    colorClass: 'bg-purple-50 text-purple-700 border-purple-200 ring-purple-500/20', 
    iconBg: 'bg-purple-100 text-purple-600',
    borderColor: 'border-purple-100 hover:border-purple-300'
  },
  { 
    id: 'OTHER', 
    label: 'Other Resources', 
    icon: FolderOpen, 
    colorClass: 'bg-slate-50 text-slate-700 border-slate-200 ring-slate-500/20', 
    iconBg: 'bg-slate-100 text-slate-600',
    borderColor: 'border-slate-100 hover:border-slate-300'
  }
];

export default function ResourceHubView({ user }: { user: UserProfile }) {
  const [links, setLinks] = useState<ResourceLink[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('TRACKER');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Auth check for content managers (Admins, Managers, QTLs, QAs, TLs)
  const canManage = ['ADMIN', 'MANAGER', 'TEAM_LEAD', 'QA', 'STL', 'OPS_TL', 'QTL'].includes(user.role);

  const fetchLinks = async () => {
    try {
      setLoading(true);
      const q = query(collection(db, 'importantLinks'), orderBy('createdAt', 'desc'));
      const snap = await getDocs(q);
      const data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as ResourceLink));
      setLinks(data);
    } catch (err) {
      toast.error('Failed to load important resource links');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLinks();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Please specify a Link Name');
      return;
    }
    if (!url.trim()) {
      toast.error('Please specify a URL');
      return;
    }

    // Modern smart-correction for missing schemes
    let resolvedUrl = url.trim();
    if (!/^https?:\/\//i.test(resolvedUrl)) {
      resolvedUrl = `https://${resolvedUrl}`;
    }

    try {
      await addDoc(collection(db, 'importantLinks'), {
        name: name.trim(),
        url: resolvedUrl,
        description: description.trim(),
        category,
        createdBy: user.fullName || user.name || 'QC Specialist',
        createdAt: new Date().toISOString()
      });
      
      setName('');
      setUrl('');
      setDescription('');
      setCategory('TRACKER');
      setShowAddForm(false);
      fetchLinks();
      toast.success(`Successfully uploaded "${name}" resource!`);
    } catch (err) {
      toast.error('Failed to add resources to cloud storage');
    }
  };

  const handleDelete = async (id: string, resourceName: string) => {
    if (!confirm(`Are you absolutely sure you want to remove "${resourceName}"? This action cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, 'importantLinks', id));
      fetchLinks();
      toast.success('Resource deleted successfully.');
    } catch (err) {
      toast.error('Failed to isolate and delete link resource.');
    }
  };

  const handleCopyLink = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    toast.success('URL copied to clipboard!');
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Live filter computation
  const filteredLinks = links.filter(link => {
    const matchesSearch = 
      link.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      (link.description && link.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
      link.createdBy.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesCategory = selectedCategoryFilter ? link.category === selectedCategoryFilter : true;
    return matchesSearch && matchesCategory;
  });

  // Calculate high-end KPI stats
  const totalCount = links.length;
  const trackerCount = links.filter(l => l.category === 'TRACKER').length;
  const guidelineCount = links.filter(l => l.category === 'GUIDELINE').length;
  const opsCount = links.filter(l => l.category === 'OPERATIONS').length;

  return (
    <div className="space-y-6 max-w-7xl mx-auto p-2">
      {/* 1. HERO HEADER AREA CORNERSTONE */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-3xl font-black tracking-tight text-slate-800">Important Quality Hub</h2>
            <div className="p-1.5 bg-indigo-50 rounded-lg text-indigo-600 animate-pulse hidden sm:block">
              <Sparkles size={16} />
            </div>
          </div>
          <p className="text-xs text-slate-500 font-medium mt-1">
            Access, explore development logs, review quality evaluation rubrics, and check live QC trackers instantly.
          </p>
        </div>

        {canManage && (
          <Button 
            onClick={() => setShowAddForm(!showAddForm)}
            className={`cursor-pointer transition-all duration-300 font-bold text-xs h-10 gap-2 rounded-xl shadow-sm ${
              showAddForm 
                ? 'bg-slate-800 hover:bg-slate-700 text-white' 
                : 'bg-indigo-600 hover:bg-indigo-700 text-white'
            }`}
          >
            {showAddForm ? <X size={15} /> : <Plus size={15} />}
            {showAddForm ? 'Close Link Engine' : 'Add Quality Resource'}
          </Button>
        )}
      </div>

      {/* 2. STATS CHIPS BLOCK - METRIC ALIGNMENT */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-100 p-4 rounded-xl shadow-xs hover:shadow-sm transition-all duration-300">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Total Active Assets</p>
          <p className="text-2xl font-black text-slate-800 mt-1">{totalCount}</p>
        </div>
        <div className="bg-white border border-slate-100 p-4 rounded-xl shadow-xs hover:shadow-sm transition-all duration-300">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Trackers & Logs</p>
          <p className="text-2xl font-black text-blue-600 mt-1">{trackerCount}</p>
        </div>
        <div className="bg-white border border-slate-100 p-4 rounded-xl shadow-xs hover:shadow-sm transition-all duration-300">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">SOPs & Guidelines</p>
          <p className="text-2xl font-black text-emerald-600 mt-1">{guidelineCount}</p>
        </div>
        <div className="bg-white border border-slate-100 p-4 rounded-xl shadow-xs hover:shadow-sm transition-all duration-300">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Operations Links</p>
          <p className="text-2xl font-black text-indigo-600 mt-1">{opsCount}</p>
        </div>
      </div>

      {/* 3. COLLAPSED CREATION MANAGER PANEL */}
      {showAddForm && canManage && (
        <div className="animate-in fade-in-50 duration-300">
          <Card className="border-indigo-100 shadow-md bg-gradient-to-br from-white to-slate-50/50">
            <CardHeader className="border-b border-indigo-50/60 p-4">
              <CardTitle className="text-sm font-bold text-indigo-950 flex items-center gap-2">
                <Sparkles size={14} className="text-indigo-600" />
                Register New Directory Link
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5">
              <form onSubmit={handleAdd} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                      Resource Link Name *
                    </label>
                    <Input 
                      placeholder="e.g. Master QC Update Tracker" 
                      value={name} 
                      onChange={e => setName(e.target.value)}
                      required
                      className="bg-white border-slate-200 h-10 shadow-xs text-xs focus-visible:ring-indigo-500 text-slate-800 font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                      Redirect URL *
                    </label>
                    <Input 
                      placeholder="e.g. docs.google.com/spreadsheets/d/..." 
                      value={url} 
                      onChange={e => setUrl(e.target.value)}
                      required
                      className="bg-white border-slate-200 h-10 shadow-xs text-xs focus-visible:ring-indigo-500 text-slate-800 font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                    Description & Target Purpose (Optional)
                  </label>
                  <Input 
                    placeholder="Short description of this tracker, update frequency or guidelines scope..." 
                    value={description} 
                    onChange={e => setDescription(e.target.value)}
                    className="bg-white border-slate-200 h-10 shadow-xs text-xs focus-visible:ring-indigo-500 text-slate-800 font-medium"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                    Resource Category Classification *
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                    {CATEGORIES.map(cat => {
                      const CatIcon = cat.icon;
                      const isSelected = category === cat.id;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => setCategory(cat.id)}
                          className={`flex flex-col items-center justify-center p-3.5 rounded-xl border-2 text-center transition-all duration-200 cursor-pointer ${
                            isSelected 
                              ? 'border-indigo-600 bg-indigo-50/50 text-indigo-950 shadow-xs' 
                              : 'border-slate-100 hover:border-slate-200 bg-white text-slate-600'
                          }`}
                        >
                          <div className={`p-2 rounded-lg mb-2 ${cat.iconBg}`}>
                            <CatIcon size={16} />
                          </div>
                          <span className="text-[10px] font-bold tracking-tight">{cat.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex justify-end pt-2 border-t border-slate-100">
                  <Button 
                    type="submit" 
                    className="cursor-pointer bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs h-9 px-6 rounded-lg shadow-sm"
                  >
                    Add to Hub Directory
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 4. ACTIONS: LIVE SEARCH AND CATEGORY TAG FILTERS */}
      <div className="flex flex-col gap-4 bg-white border border-slate-100 p-4 rounded-xl shadow-xs">
        {/* Search */}
        <div className="relative">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input 
            placeholder="Search resources by name, purpose, tags, or author..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 h-10 border-slate-200 text-xs shadow-none w-full"
          />
        </div>

        {/* Dynamic Category Pill Filters */}
        <div className="flex flex-wrap items-center gap-1.5 pb-1">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mr-2">Filter by:</span>
          
          <button
            onClick={() => setSelectedCategoryFilter(null)}
            className={`border cursor-pointer text-[10px] font-bold px-3 py-1.5 rounded-full transition-all duration-200 ${
              selectedCategoryFilter === null 
                ? 'bg-slate-900 border-slate-900 text-white shadow-xs' 
                : 'bg-white border-slate-200 hover:border-slate-300 text-slate-600'
            }`}
          >
            All Links ({links.length})
          </button>

          {CATEGORIES.map(cat => {
            const count = links.filter(l => l.category === cat.id).length;
            const isSelected = selectedCategoryFilter === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategoryFilter(cat.id)}
                className={`border cursor-pointer text-[10px] font-bold px-3 py-1.5 rounded-full transition-all duration-200 flex items-center gap-1.5 ${
                  isSelected 
                    ? 'bg-slate-900 border-slate-900 text-white shadow-xs' 
                    : 'bg-white border-slate-200 hover:border-slate-300 text-slate-600'
                }`}
              >
                <cat.icon size={11} className={isSelected ? 'text-white' : 'text-slate-400'} />
                {cat.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* 5. MAIN HUB MULTI-COLUMN DESIGNED DISPLAY */}
      {loading ? (
        <div className="py-20 text-center text-slate-400 text-xs font-bold font-mono">
          Syncing quality database records...
        </div>
      ) : filteredLinks.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredLinks.map(link => {
            const catInfo = CATEGORIES.find(c => c.id === link.category) || CATEGORIES[4];
            const CatIcon = catInfo.icon;
            const isCopied = copiedId === link.id;

            return (
              <div 
                key={link.id} 
                className={`group relative bg-white border rounded-xl overflow-hidden shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 flex flex-col justify-between ${catInfo.borderColor}`}
              >
                {/* Visual Accent Top Line Category Gradient */}
                <div className={`h-1 bg-gradient-to-r ${
                  link.category === 'TRACKER' ? 'from-blue-500/80 to-indigo-500/40' :
                  link.category === 'GUIDELINE' ? 'from-emerald-500/80 to-teal-500/40' :
                  link.category === 'OPERATIONS' ? 'from-indigo-500/80 to-purple-500/40' :
                  link.category === 'TRAINING' ? 'from-purple-500/80 to-pink-500/40' :
                  'from-slate-500/80 to-slate-400/40'
                }`} />

                {/* Card Content body */}
                <div className="p-5 flex-1 space-y-4">
                  {/* Category badge row */}
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[9px] font-black uppercase px-2.5 py-0.5 rounded-full border tracking-widest ${catInfo.colorClass}`}>
                      {catInfo.label}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button 
                        onClick={() => handleCopyLink(link.id, link.url)}
                        title="Copy direct URL link"
                        className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg cursor-pointer transition-colors"
                      >
                        {isCopied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                      </button>
                      
                      {canManage && (
                        <button 
                          onClick={() => handleDelete(link.id, link.name)}
                          title="Delete link"
                          className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg cursor-pointer transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Primary Link name with stylish visual flex-row */}
                  <div className="flex gap-3">
                    <div className={`p-2 rounded-xl h-10 w-10 shrink-0 flex items-center justify-center ${catInfo.iconBg}`}>
                      <CatIcon size={18} />
                    </div>
                    <div className="space-y-1">
                      <h4 className="text-sm font-black text-slate-800 group-hover:text-indigo-600 transition-colors line-clamp-2 leading-snug">
                        {link.name}
                      </h4>
                      <p className="text-[11px] text-slate-500 font-medium line-clamp-2 leading-relaxed">
                        {link.description || "No description provided for this resource directory."}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Card Footer branding metadata */}
                <div className="px-5 py-3.5 bg-slate-50/75 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-400 font-bold shrink-0">
                  <div className="flex items-center gap-1">
                    <User size={12} className="text-slate-400 shrink-0" />
                    <span className="truncate max-w-[120px]">{link.createdBy}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar size={12} className="text-slate-400 shrink-0" />
                    <span>{new Date(link.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                </div>

                {/* Modern click-to-open overlay button */}
                <a 
                  href={link.url}
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="absolute inset-x-0 bottom-0 top-12 opacity-0 cursor-pointer focus:outline-none"
                  aria-label={`Open link: ${link.name}`}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center border border-dashed border-slate-200 py-16 px-6 rounded-xl bg-white text-center">
          <FilterX size={32} className="text-slate-400 mb-3" />
          <h4 className="text-sm font-bold text-slate-700">No Quality Assets Located</h4>
          <p className="text-[11px] text-slate-400 mt-1 max-w-sm">
            We couldn't locate any links matching your filter constraints or search criteria.
          </p>
          {(searchQuery || selectedCategoryFilter) && (
            <Button 
              size="sm" 
              variant="outline" 
              onClick={() => { setSearchQuery(''); setSelectedCategoryFilter(null); }}
              className="mt-4 text-[10px] font-black tracking-wide"
            >
              Clear Search & Filter Filters
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
