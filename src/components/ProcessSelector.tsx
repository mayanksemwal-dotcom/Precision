import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, Star, Clock, ChevronDown } from 'lucide-react';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';

interface ProcessSelectorProps {
  allProcesses: string[];
  currentProcess: string;
  onSelectProcess: (process: string) => void;
  recentProcesses: string[];
  favoriteProcesses: string[];
  onToggleFavorite: (process: string) => void;
}

export default function ProcessSelector({
  allProcesses = [],
  currentProcess,
  onSelectProcess,
  recentProcesses = [],
  favoriteProcesses = [],
  onToggleFavorite
}: ProcessSelectorProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const filteredProcesses = useMemo(() => {
    return (allProcesses || []).filter(p => 
      p && typeof p === 'string' && p.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [allProcesses, searchTerm]);

  return (
    <div className="relative w-full" ref={containerRef}>
      <div 
        className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-900 font-bold flex items-center justify-between cursor-pointer"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="truncate">{currentProcess || 'Search Process...'}</span>
        <ChevronDown size={14} className="shrink-0 ml-1 text-slate-500" />
      </div>

      {isOpen && (
        <div className="absolute top-10 left-0 w-full bg-white border border-slate-200 rounded-lg shadow-xl z-[100] p-1.5 space-y-1.5">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={13} />
            <Input 
              placeholder="Search Process..." 
              className="pl-7 h-8 text-xs"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              autoFocus
            />
          </div>

          <div className="max-h-[260px] overflow-y-auto space-y-0.5 py-0.5">
            {/* Favorites */}
            {(favoriteProcesses || []).length > 0 && !searchTerm && (
              <div className="mb-1.5">
                <p className="text-[10px] font-bold text-slate-400 uppercase p-1">Favorites</p>
                {(favoriteProcesses || []).map(proc => (
                  <div key={proc} className="flex items-center justify-between p-1 text-xs hover:bg-slate-100 rounded cursor-pointer" onClick={() => { onSelectProcess(proc); setIsOpen(false); }}>
                    <div className="flex items-center gap-1.5 font-bold">
                      <Star size={12} className="text-yellow-500 fill-yellow-500 shrink-0" />
                      {proc}
                    </div>
                    <Star size={12} className="text-yellow-500 fill-yellow-500 shrink-0 opacity-50 hover:opacity-100" onClick={(e) => { e.stopPropagation(); onToggleFavorite(proc); }} />
                  </div>
                ))}
              </div>
            )}

            {/* Recent */}
            {(recentProcesses || []).length > 0 && !searchTerm && (
              <div className="mb-1.5">
                <p className="text-[10px] font-bold text-slate-400 uppercase p-1">Recent Processes</p>
                {(recentProcesses || []).map(proc => (
                  <div key={proc} className="flex items-center justify-between p-1 text-xs hover:bg-slate-100 rounded cursor-pointer" onClick={() => { onSelectProcess(proc); setIsOpen(false); }}>
                    <div className="flex items-center gap-1.5 font-bold text-slate-700">
                        <Clock size={12} className="text-slate-400 shrink-0"/>
                        {proc}
                    </div>
                    <Star size={12} className={(favoriteProcesses || []).includes(proc) ? "text-yellow-500 fill-yellow-500 shrink-0" : "text-slate-300 shrink-0 hover:text-yellow-400"} onClick={(e) => { e.stopPropagation(); onToggleFavorite(proc); }} />
                  </div>
                ))}
              </div>
            )}

            {/* All */}
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase p-1">{searchTerm ? 'Search Results' : 'All Processes'}</p>
              {(filteredProcesses || []).length === 0 ? (
                <div className="p-2 text-center text-xs text-slate-500">No processes found</div>
              ) : (
                (filteredProcesses || []).map(proc => (
                  <div key={proc} className="flex items-center justify-between p-1 text-xs hover:bg-slate-100 rounded cursor-pointer" onClick={() => { onSelectProcess(proc); setIsOpen(false); }}>
                    <span className="font-bold text-slate-700">{proc}</span>
                    <Star size={12} className={(favoriteProcesses || []).includes(proc) ? "text-yellow-500 fill-yellow-500 shrink-0" : "text-slate-300 hover:text-yellow-400 shrink-0"} onClick={(e) => { e.stopPropagation(); onToggleFavorite(proc); }} />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
