import React, { useState } from 'react';
import { ShieldAlert, AlertTriangle, Info, History, ChevronDown, Check, Search } from 'lucide-react';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
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
  const [level, setLevel] = useState<'1st' | '2nd' | 'Final'>('1st');
  const [remarks, setRemarks] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState(initialId || '');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownSearch, setDropdownSearch] = useState('');

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
      const ticket: WarningTicket = {
        id: `wt-${Date.now()}`,
        agentId: selectedAgentId,
        qaId: auth.currentUser?.uid || 'unknown',
        level,
        remarks,
        createdAt: new Date().toISOString()
      };
      
      const docRef = doc(db, 'warnings', ticket.id);
      await setDoc(docRef, ticket);
      
      toast.success(`${level} Warning issued to ${selectedAgent?.name || selectedAgentId}`);
      onClose();
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'warnings');
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
          <RadioGroup value={level} onValueChange={(v: any) => setLevel(v)} className="grid grid-cols-3 gap-4">
            <div className="flex items-center space-x-2 bg-slate-50 p-2.5 rounded-lg border border-slate-150 hover:bg-slate-100 transition-colors cursor-pointer">
              <RadioGroupItem value="1st" id="r1" className="cursor-pointer" />
              <Label htmlFor="r1" className="cursor-pointer font-bold select-none w-full text-xs">1st Warning</Label>
            </div>
            <div className="flex items-center space-x-2 bg-slate-50 p-2.5 rounded-lg border border-slate-150 hover:bg-slate-100 transition-colors cursor-pointer">
              <RadioGroupItem value="2nd" id="r2" className="cursor-pointer" />
              <Label htmlFor="r2" className="cursor-pointer font-bold select-none w-full text-xs">2nd Warning</Label>
            </div>
            <div className="flex items-center space-x-2 bg-slate-50 p-2.5 rounded-lg border border-slate-150 hover:bg-slate-100 transition-colors cursor-pointer">
              <RadioGroupItem value="Final" id="r3" className="cursor-pointer" />
              <Label htmlFor="r3" className="cursor-pointer font-bold select-none w-full text-xs">Final Notice</Label>
            </div>
          </RadioGroup>
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
