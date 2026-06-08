import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2, User as UserIcon, X, ChevronDown } from 'lucide-react';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  limit, 
  getDocs, 
  startAfter,
  QueryDocumentSnapshot,
  DocumentData,
  doc,
  getDoc
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { UserProfile } from '../types';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

interface UserPickerProps {
  onSelect: (user: UserProfile) => void;
  selectedUserId?: string;
  placeholder?: string;
  roleFilter?: string[];
  className?: string;
  label?: string;
}

export const UserPicker = ({ 
  onSelect, 
  selectedUserId, 
  placeholder = "Search and select employee...",
  roleFilter,
  className,
  label
}: UserPickerProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [allFetchedUsers, setAllFetchedUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch selected user details if not provided
  useEffect(() => {
    const fetchSelected = async () => {
      if (selectedUserId && (!selectedUser || selectedUser.uid !== selectedUserId)) {
        const uDoc = await getDoc(doc(db, 'users', selectedUserId));
        if (uDoc.exists()) {
          setSelectedUser({ uid: uDoc.id, ...uDoc.data() } as UserProfile);
        }
      } else if (!selectedUserId) {
        setSelectedUser(null);
      }
    };
    fetchSelected();
  }, [selectedUserId]);

  // Pre-load all active users once
  const loadAllUsers = useCallback(async () => {
    setLoading(true);
    try {
      const q = query(
        collection(db, 'users'),
        where('status', '==', 'Active')
      );
      const snap = await getDocs(q);
      const results = snap.docs.map(d => {
        const data = d.data() as any;
        return { 
          uid: d.id, 
          ...data,
          role: (data.role || '').toUpperCase()
        } as UserProfile;
      });
      results.sort((a, b) => {
        const nameA = (a.fullName || a.name || a.employeeName || '').toLowerCase();
        const nameB = (b.fullName || b.name || b.employeeName || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
      setAllFetchedUsers(results);
    } catch (err) {
      console.error('Failed to pre-fetch user records:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Filter local listings based on the search state & filters
  const users = React.useMemo(() => {
    let list = allFetchedUsers;
    
    if (search) {
      const term = search.toLowerCase().trim();
      list = list.filter(u => {
        const name = (u.employeeName || u.fullName || u.name || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        const role = (u.role || '').toLowerCase();
        const dept = (u.department || '').toLowerCase();
        const proc = (u.process || '').toLowerCase();
        return name.includes(term) || email.includes(term) || role.includes(term) || dept.includes(term) || proc.includes(term);
      });
    }

    if (roleFilter && roleFilter.length > 0) {
      list = list.filter(u => roleFilter.includes(u.role));
    }

    // Return the matched listings, bounded for speed
    return list.slice(0, 50);
  }, [allFetchedUsers, search, roleFilter]);

  return (
    <div className={`relative space-y-1 ${className}`} ref={dropdownRef}>
      {label && <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">{label}</label>}
      
      <div 
        className={`flex items-center justify-between w-full h-11 px-3 rounded-xl border transition-all cursor-pointer bg-white ${
          isOpen ? 'border-sky-500 ring-2 ring-sky-100 shadow-sm' : 'border-slate-200 hover:border-slate-300'
        }`}
        onClick={() => {
          const nextState = !isOpen;
          setIsOpen(nextState);
          if (nextState && allFetchedUsers.length === 0) {
            loadAllUsers();
          }
        }}
      >
        <div className="flex items-center gap-2 overflow-hidden flex-1">
          <UserIcon size={16} className={selectedUser ? 'text-sky-500' : 'text-slate-300'} />
          {selectedUser ? (
                    <div className="flex flex-col items-start overflow-hidden">
                       <span className="text-xs font-black text-slate-900 truncate leading-none">
                         {selectedUser.employeeName || selectedUser.fullName || selectedUser.name}
                       </span>
                       <span className="text-[10px] text-slate-500 font-bold leading-none mt-1">
                         {selectedUser.email}
                       </span>
                       <span className="text-[10px] text-slate-400 font-bold leading-none mt-1">
                         {selectedUser.role} | {selectedUser.process || selectedUser.department || 'No Process'}
                       </span>
                    </div>
          ) : (
            <span className="text-xs text-slate-400 font-semibold">{placeholder}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
            {selectedUserId && (
                <button 
                  onClick={(e) => {
                      e.stopPropagation();
                      onSelect({ uid: '' } as any);
                      setSelectedUser(null);
                  }}
                  className="p-1 hover:bg-slate-100 rounded-full text-slate-400"
                >
                    <X size={14} />
                </button>
            )}
            <ChevronDown size={14} className={`text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-slate-200 rounded-2xl shadow-xl z-[100] p-2 animate-in fade-in slide-in-from-top-2 duration-200 overflow-hidden">
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
            <Input 
              autoFocus
              placeholder="Type name to search..." 
              className="pl-9 h-10 rounded-xl border-slate-200 bg-slate-50 focus:bg-white text-xs font-semibold"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
            {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 animate-spin" size={14} />}
          </div>

          <div className="max-h-60 overflow-y-auto space-y-1 scrollbar-thin">
            {users.map((u) => (
              <div 
                key={u.uid}
                className="p-3 hover:bg-slate-50 rounded-xl cursor-pointer flex items-center justify-between group transition-colors border border-transparent hover:border-slate-100"
                onClick={() => {
                  onSelect(u);
                  setSelectedUser(u);
                  setIsOpen(false);
                  setSearch('');
                }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-400 group-hover:bg-sky-50 group-hover:text-sky-600 transition-colors">
                    <UserIcon size={14} />
                  </div>
                  <div>
                    <p className="text-xs font-black text-slate-900 leading-none">{u.employeeName || u.fullName || u.name}</p>
                    <p className="text-[10px] font-bold text-slate-500 mt-1">{u.email}</p>
                    <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] font-bold text-slate-400">{u.role}</span>
                        {u.process && <span className="text-[10px] font-bold text-slate-400">| {u.process}</span>}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                   <Badge variant="outline" className="text-[9px] px-1.5 h-4 border-slate-200 text-slate-400 group-hover:text-sky-600 group-hover:border-sky-200">
                     {u.process || u.department || 'N/A'}
                   </Badge>
                </div>
              </div>
            ))}
            
            {search && users.length === 0 && !loading && (
              <div className="p-8 text-center text-slate-400">
                <p className="text-xs font-bold uppercase tracking-tight">No employees found</p>
                <p className="text-[10px] mt-1">Try a different search term</p>
              </div>
            )}
            
            {!search && users.length === 0 && (
              <div className="p-8 text-center text-slate-400 border border-dashed border-slate-100 rounded-xl m-2">
                <Search size={24} className="mx-auto mb-2 opacity-20" />
                <p className="text-[10px] font-bold uppercase tracking-widest">Type min. 2 chars to search</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
