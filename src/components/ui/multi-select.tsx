import React, { useState } from 'react';
import { ChevronDown, Search, X, Check } from 'lucide-react';

export function MultiSelectDropdown({ 
  options, 
  selectedValues, 
  onToggle, 
  placeholder 
}: { 
  options: string[], 
  selectedValues: string[], 
  onToggle: (val: string) => void,
  placeholder: string 
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  
  const filteredOptions = options.filter(o => o.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="relative">
      <div 
        className="min-h-[34px] w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-1 cursor-pointer focus-within:ring-2 focus-within:ring-blue-500/10 flex items-center justify-between transition-all"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex flex-wrap gap-1 items-center flex-1">
          {selectedValues.length === 0 && <span className="text-slate-500 dark:text-slate-400 font-bold text-xs">{placeholder}</span>}
          {selectedValues.map(val => (
            <span key={val} className="px-1.5 py-0.5 bg-slate-50 dark:bg-slate-700 text-slate-850 dark:text-slate-100 rounded-lg text-[10px] font-bold border border-slate-200 dark:border-slate-600 flex items-center gap-1" onClick={(e) => { e.stopPropagation(); onToggle(val); }}>
              <span className="max-w-[150px] truncate">{val}</span> <X size={10} className="hover:text-red-500 cursor-pointer flex-shrink-0" />
            </span>
          ))}
        </div>
        <ChevronDown size={14} className="text-slate-400 dark:text-slate-500 transition-transform flex-shrink-0 ml-2 animate-duration-150" />
      </div>
      
      {isOpen && (
        <div className="absolute top-full left-0 w-full mt-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg z-50 max-h-64 flex flex-col overflow-hidden">
          <div className="p-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
            <Search size={14} className="text-slate-400 dark:text-slate-500" />
            <input 
              type="text" 
              placeholder="Search..." 
              className="flex-1 bg-transparent border-none outline-none text-xs font-bold text-slate-700 dark:text-slate-100 placeholder-slate-400"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <div className="overflow-y-auto flex-1 p-1 custom-scrollbar">
            {filteredOptions.length === 0 ? (
              <div className="p-3 text-center text-xs text-slate-400 dark:text-slate-500 font-medium">No results found.</div>
            ) : (
              filteredOptions.map(opt => {
                const isSelected = selectedValues.includes(opt);
                return (
                  <div 
                    key={opt}
                    className={`px-2.5 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors flex items-center justify-between ${isSelected ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-650 dark:text-indigo-400' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}`}
                    onClick={(e) => { e.stopPropagation(); onToggle(opt); }}
                  >
                    <span className="flex-1 pr-2 truncate text-left" title={opt}>{opt}</span>
                    {isSelected && <Check size={14} className="text-indigo-600 dark:text-indigo-400 flex-shrink-0" />}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
      
      {isOpen && <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)}></div>}
    </div>
  );
}
