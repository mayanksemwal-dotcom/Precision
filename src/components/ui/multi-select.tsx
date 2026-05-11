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
        className="min-h-12 w-full bg-white border border-slate-200 rounded-xl px-4 py-2 cursor-pointer focus-within:ring-4 focus-within:ring-blue-500/10 flex items-center justify-between"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex flex-wrap gap-1 items-center flex-1">
          {selectedValues.length === 0 && <span className="text-slate-400 font-medium text-sm">{placeholder}</span>}
          {selectedValues.map(val => (
            <span key={val} className="px-2 py-1 bg-slate-100 text-slate-800 rounded-md text-xs font-bold border border-slate-200 flex items-center gap-1" onClick={(e) => { e.stopPropagation(); onToggle(val); }}>
              <span className="max-w-[150px] truncate">{val}</span> <X size={12} className="hover:text-red-500 cursor-pointer flex-shrink-0" />
            </span>
          ))}
        </div>
        <ChevronDown size={16} className={`text-slate-400 transition-transform flex-shrink-0 ml-2 ${isOpen ? 'rotate-180' : ''}`} />
      </div>
      
      {isOpen && (
        <div className="absolute top-full left-0 w-full mt-2 bg-white border border-slate-200 rounded-xl shadow-lg z-50 max-h-64 flex flex-col overflow-hidden">
          <div className="p-2 border-b border-slate-100 flex items-center gap-2">
            <Search size={16} className="text-slate-400" />
            <input 
              type="text" 
              placeholder="Search..." 
              className="flex-1 bg-transparent border-none outline-none text-sm font-medium"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <div className="overflow-y-auto flex-1 p-1 custom-scrollbar">
            {filteredOptions.length === 0 ? (
              <div className="p-3 text-center text-sm text-slate-400 font-medium">No results found.</div>
            ) : (
              filteredOptions.map(opt => {
                const isSelected = selectedValues.includes(opt);
                return (
                  <div 
                    key={opt}
                    className={`px-3 py-2 text-sm font-medium rounded-lg cursor-pointer transition-colors flex items-center justify-between ${isSelected ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-50 text-slate-700'}`}
                    onClick={(e) => { e.stopPropagation(); onToggle(opt); }}
                  >
                    <span className="flex-1 pr-2 truncate" title={opt}>{opt}</span>
                    {isSelected && <Check size={16} className="text-blue-600 flex-shrink-0" />}
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
