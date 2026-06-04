import React, { useState } from 'react';
import { ShieldAlert, AlertTriangle, Info, History, ChevronDown, Check, Search } from 'lucide-react';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { toast } from 'sonner';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, setDoc } from 'firebase/firestore';
import { WarningTicket, UserProfile, UserRole } from '../types';

interface WarningManagerProps {
  agentName?: string;
  agentId?: string;
  onClose: () => void;
  allUsers?: UserProfile[]; // Optional list of users for selection
}

export default function WarningManager({ agentName: initialName, agentId: initialId, onClose, allUsers = [] }: WarningManagerProps) {
  const [level, setLevel] = useState<'1st' | '2nd' | 'Final' | string>('1st');
  const [remarks, setRemarks] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState(initialId || '');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownSearch, setDropdownSearch] = useState('');
  const [severity, setSeverity] = useState<'Mild' | 'Moderate' | 'Severe' | 'Critical'>('Mild');

  const selectedAgent = allUsers.find(u => u.uid === selectedAgentId) || (initialId ? { name: initialName, uid: initialId } : null);

  const handleSubmit = async () => {
    if (!selectedAgentId) {
      toast.error('Please select an agent');
      return;
    }
    if (!remarks) {
      toast.error('Remarks are required for issuing a warning');
      return;
    }

    try {
      const fullAgent = allUsers.find(u => u.uid === selectedAgentId);
      const email = fullAgent?.email || '';
      const name = fullAgent?.name || initialName || selectedAgentId;
      const employeeId = `EMP-2026-${selectedAgentId.substring(0, 4).toUpperCase()}`;

      const ticket: WarningTicket = {
        id: `wt-${Date.now()}`,
        agentId: selectedAgentId,
        agentName: name,
        agentEmail: email,
        employeeId: employeeId,
        qaId: auth.currentUser?.uid || 'unknown',
        level,
        remarks,
        severity,
        status: 'Pending',
        createdAt: new Date().toISOString(),
        history: [
          {
            action: `Warning raised by QA/Supervisor`,
            timestamp: new Date().toISOString()
          }
        ]
      };
      
      console.log("Submitting ticket:", ticket);
      console.log("Current user:", auth.currentUser?.uid, auth.currentUser?.email);
      
      const docRef = doc(db, 'disciplinaryLogs', ticket.id);
      await setDoc(docRef, ticket);
      
      toast.success(`${level} Warning issued to ${name}`);
      onClose();
    } catch (e) {
      console.error("Warning ticket submission failed:", e);
      // Detailed error logging
      if (e instanceof Error) {
        console.error("Error name:", e.name);
        console.error("Error message:", e.message);
      }
      
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to issue warning: ${errMsg}`);
      try {
        handleFirestoreError(e, OperationType.WRITE, 'disciplinaryLogs');
      } catch (err) {
        // Prevent unhandled promise rejection/crashes in the UI click context
      }
    }
  };

  const agents = allUsers.filter(u => u.role === UserRole.AGENT);
  const filteredAgents = agents.filter(u => 
    u.name.toLowerCase().includes(dropdownSearch.toLowerCase()) || 
    u.email.toLowerCase().includes(dropdownSearch.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="bg-red-50 border border-red-100 p-4 rounded-lg flex flex-col gap-3">
        <div className="flex gap-3">
          <ShieldAlert className="text-red-600 shrink-0" size={20} />
          <div>
            <h4 className="text-sm font-bold text-red-900">Warning Ticket Issuance</h4>
            <p className="text-xs text-red-700">This action will be logged and visible to Admin and Team Lead.</p>
          </div>
        </div>
        <a 
          href="https://docs.google.com/document/d/1zAu2KCCUfOFBA8-nopnc1YRNycaDhCtRPfI7CIgFl7Y/edit?tab=t.ttcgryfeyu7#heading=h.ra63ci5w7hx3" 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-[10px] font-bold text-blue-600 hover:underline flex items-center gap-1 mt-1"
        >
          <History size={12} /> View Staircase Policy Reference
        </a>
      </div>

      <div className="space-y-4">
        <div className="space-y-1 relative">
          <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">Target Agent</Label>
          {!initialId ? (
            <div className="w-full relative z-40">
              <button
                type="button"
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="mt-1 w-full h-11 bg-white border border-slate-200 text-slate-900 font-medium px-3 flex items-center justify-between rounded-lg shadow-sm hover:bg-slate-50 focus:ring-2 focus:ring-red-500 focus:outline-none text-left cursor-pointer"
              >
                <span>
                  {selectedAgent 
                    ? `${selectedAgent.name} (${allUsers.find(u => u.uid === selectedAgentId)?.email || selectedAgentId})` 
                    : "Select an Agent..."
                  }
                </span>
                <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
              </button>

              {dropdownOpen && (
                <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-[9999] p-1 flex flex-col max-h-60">
                  <div className="p-1 px-2 border-b border-slate-100 flex items-center gap-2">
                    <Search size={14} className="text-slate-400 shrink-0" />
                    <input
                      type="text"
                      placeholder="Search agent..."
                      className="w-full text-xs p-1 focus:outline-none bg-transparent text-slate-900"
                      value={dropdownSearch}
                      onChange={(e) => setDropdownSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  <div className="overflow-y-auto max-h-48 pt-1 space-y-0.5">
                    {filteredAgents.map(u => (
                      <button
                        key={u.uid}
                        type="button"
                        onClick={() => {
                          setSelectedAgentId(u.uid);
                          setDropdownOpen(false);
                          setDropdownSearch('');
                        }}
                        className="w-full text-left font-semibold text-slate-900 p-2 rounded hover:bg-slate-50 flex items-center justify-between transition-colors cursor-pointer text-xs"
                      >
                        <div className="flex flex-col">
                          <span>{u.name}</span>
                          <span className="text-[10px] text-slate-400 font-mono font-medium">{u.email}</span>
                        </div>
                        {selectedAgentId === u.uid && (
                          <Check className="h-4 w-4 text-emerald-600 shrink-0" />
                        )}
                      </button>
                    ))}
                    {filteredAgents.length === 0 && (
                      <div className="text-center text-xs text-slate-400 py-4 font-bold">No agents available</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 bg-slate-50 rounded border border-slate-200 mt-1">
               <p className="font-bold">{initialName}</p>
               <p className="text-xs text-slate-500">ID: {initialId}</p>
            </div>
          )}
        </div>

        <Separator className="my-4" />

        <div className="space-y-3">
          <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">Select Warning Level</Label>
          <div className="grid grid-cols-3 gap-4">
            <button
              type="button"
              onClick={() => setLevel('1st')}
              className={`flex items-center space-x-2 p-2.5 rounded-lg border transition-all text-left cursor-pointer ${
                level === '1st'
                  ? 'bg-red-50 border-red-500 text-red-950 font-bold ring-2 ring-red-200'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <div className={`size-4 rounded-full border flex items-center justify-center shrink-0 ${
                level === '1st' ? 'border-red-600 bg-red-600' : 'border-slate-300'
              }`}>
                {level === '1st' && <div className="size-1.5 rounded-full bg-white" />}
              </div>
              <span className="font-bold select-none w-full text-xs">1st Warning</span>
            </button>

            <button
              type="button"
              onClick={() => setLevel('2nd')}
              className={`flex items-center space-x-2 p-2.5 rounded-lg border transition-all text-left cursor-pointer ${
                level === '2nd'
                  ? 'bg-red-50 border-red-500 text-red-950 font-bold ring-2 ring-red-200'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <div className={`size-4 rounded-full border flex items-center justify-center shrink-0 ${
                level === '2nd' ? 'border-red-600 bg-red-600' : 'border-slate-300'
              }`}>
                {level === '2nd' && <div className="size-1.5 rounded-full bg-white" />}
              </div>
              <span className="font-bold select-none w-full text-xs">2nd Warning</span>
            </button>

            <button
              type="button"
              onClick={() => setLevel('Final')}
              className={`flex items-center space-x-2 p-2.5 rounded-lg border transition-all text-left cursor-pointer ${
                level === 'Final'
                  ? 'bg-red-50 border-red-500 text-red-950 font-bold ring-2 ring-red-200'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <div className={`size-4 rounded-full border flex items-center justify-center shrink-0 ${
                level === 'Final' ? 'border-red-600 bg-red-600' : 'border-slate-300'
              }`}>
                {level === 'Final' && <div className="size-1.5 rounded-full bg-white" />}
              </div>
              <span className="font-bold select-none w-full text-xs">Final Notice</span>
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">Select Severity Level</Label>
          <div className="grid grid-cols-4 gap-2">
            {(['Mild', 'Moderate', 'Severe', 'Critical'] as const).map((sev) => {
              const active = severity === sev;
              const activeColors = 
                sev === 'Mild' ? 'bg-blue-50 border-blue-500 text-blue-950 ring-2 ring-blue-100' :
                sev === 'Moderate' ? 'bg-amber-50 border-amber-500 text-amber-950 ring-2 ring-amber-100' :
                sev === 'Severe' ? 'bg-orange-50 border-orange-500 text-orange-950 ring-2 ring-orange-100' :
                'bg-red-50 border-red-500 text-red-950 ring-2 ring-red-100';

              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setSeverity(sev)}
                  className={`p-2 rounded-lg border text-center font-bold text-xs transition-all cursor-pointer ${
                    active ? activeColors : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {sev}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">Reason / Remarks</Label>
          <textarea 
            className="w-full h-24 p-3 rounded-lg border border-slate-200 focus:ring-2 focus:ring-red-500 focus:outline-none text-sm text-slate-900 bg-white shadow-inner"
            placeholder="Detailed explanation for the warning ticket..."
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
          ></textarea>
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t pt-4">
        <Button variant="ghost" className="font-bold text-slate-600 hover:bg-[#F1F5F9]" onClick={onClose}>Cancel</Button>
        <Button className="bg-red-600 hover:bg-red-700 text-white font-bold px-6" onClick={handleSubmit}>Issue Ticket</Button>
      </div>
    </div>
  );
}
