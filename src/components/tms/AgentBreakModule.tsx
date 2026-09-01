import React from 'react';
import { Coffee, CheckCircle, LogOut } from 'lucide-react';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { TMSShift } from '../../views/TMSView';

interface ProcessSelectorProps {
  allProcesses: string[];
  currentProcess: string;
  onSelectProcess: (p: string) => void;
  recentProcesses: string[];
  favoriteProcesses: string[];
  onToggleFavorite: (p: string) => void;
}

interface AgentBreakModuleProps {
  currentShift: TMSShift | null;
  selectedBreakInput: string;
  setSelectedBreakInput: (b: string) => void;
  selectedProcessInput: string;
  setSelectedProcessInput: (p: string) => void;
  BREAK_OPTIONS: string[];
  allAvailableProcesses: string[];
  recentProcesses: string[];
  favoriteProcesses: string[];
  toggleFavorite: (p: string) => void;
  handleSelectProcess: (p: string) => void;
  handleStartBreak: () => void;
  handleResumeWork: (p: string) => void;
  handleClockOut: () => void;
  isProcessingPunch: boolean;
  ProcessSelector: React.ComponentType<ProcessSelectorProps>;
}

export const AgentBreakModule: React.FC<AgentBreakModuleProps> = ({
  currentShift,
  selectedBreakInput,
  setSelectedBreakInput,
  selectedProcessInput,
  BREAK_OPTIONS,
  allAvailableProcesses,
  recentProcesses,
  favoriteProcesses,
  toggleFavorite,
  handleSelectProcess,
  handleStartBreak,
  handleResumeWork,
  handleClockOut,
  ProcessSelector,
}) => {
  if (!currentShift) return null;

  return (
    <div className="space-y-4">
      {currentShift.status === 'BREAK' ? (
        // Break Interface (Resume Controls)
        <div className="space-y-2 pt-0.5">
          <div className="p-2 bg-amber-50 border border-amber-200/80 rounded-lg text-[11px] text-amber-800 flex items-center gap-2 font-medium">
            <Coffee className="shrink-0 text-amber-500" size={14} />
            <span className="truncate">
              On Break: <strong className="font-bold">{currentShift.activities[currentShift.activities.length - 1]?.name || 'Break'}</strong>
            </span>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Resume Process</Label>
            <ProcessSelector
              allProcesses={allAvailableProcesses}
              currentProcess={selectedProcessInput}
              onSelectProcess={handleSelectProcess}
              recentProcesses={recentProcesses}
              favoriteProcesses={favoriteProcesses}
              onToggleFavorite={toggleFavorite}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 pt-0.5">
            <Button 
              className="h-8.5 bg-teal-600 hover:bg-teal-700 text-white font-black text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
              onClick={() => handleResumeWork(selectedProcessInput)}
            >
              <CheckCircle size={13} /> RESUME
            </Button>
            <Button 
              variant="destructive"
              className="h-8.5 font-black text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
              onClick={handleClockOut}
            >
              <LogOut size={13} /> CLOCK OUT
            </Button>
          </div>
        </div>
      ) : (
        // Active Interface
        <div className="space-y-2 pt-0.5">
          <div className="space-y-1">
            <Label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Take Break</Label>
            <div className="flex gap-2">
              <select
                className="flex-1 h-8.5 bg-white border border-slate-200 rounded-lg px-2 text-xs text-slate-800 font-semibold focus:ring-2 focus:ring-sky-500 focus:outline-none"
                value={selectedBreakInput}
                onChange={(e) => setSelectedBreakInput(e.target.value)}
              >
                {BREAK_OPTIONS.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              <Button 
                size="sm" 
                className="bg-amber-500 hover:bg-amber-600 font-bold text-xs h-8.5 px-3 shrink-0 cursor-pointer text-white flex items-center gap-1 rounded-lg"
                onClick={handleStartBreak}
              >
                <Coffee size={13} /> Break
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
