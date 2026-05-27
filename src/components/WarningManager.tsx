import React, { useState } from 'react';
import { ShieldAlert, AlertTriangle, Info, History } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './ui/card';
import { Label } from './ui/label';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Separator } from './ui/separator';
import { toast } from 'sonner';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, setDoc, getDocs, collection } from 'firebase/firestore';
import { WarningTicket, UserProfile, UserRole } from '../types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

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
        <div className="space-y-1">
          <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">Target Agent</Label>
          {!initialId ? (
            <div className="w-full relative z-40">
              <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                <SelectTrigger className="mt-1 w-full h-11 bg-white border border-slate-200 text-slate-900 font-medium px-3 flex items-center justify-between rounded-lg shadow-sm focus:ring-2 focus:ring-red-500">
                  <SelectValue placeholder="Select an Agent..." />
                </SelectTrigger>
                <SelectContent className="bg-white border border-slate-200 rounded-lg shadow-xl z-[9999] p-1 text-slate-900 max-h-60 overflow-y-auto w-full">
                  {allUsers.filter(u => u.role === UserRole.AGENT).map(u => (
                    <SelectItem key={u.uid} value={u.uid} className="hover:bg-slate-100 cursor-pointer p-2.5 rounded text-slate-900 flex items-center justify-start gap-2 focus:bg-slate-100 bg-white text-sm w-full">
                      <span className="font-semibold text-slate-900">{u.name}</span>
                      <span className="text-slate-400 font-mono text-xs">({u.email})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="p-3 bg-slate-50 rounded border border-slate-200 mt-1">
               <p className="font-bold">{initialName}</p>
               <p className="text-xs text-slate-500">ID: {initialId}</p>
            </div>
          )}
        </div>

        <Separator />

        <div className="space-y-3">
          <Label>Select Warning Level</Label>
          <RadioGroup value={level} onValueChange={(v: any) => setLevel(v)} className="grid grid-cols-3 gap-4">
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="1st" id="r1" />
              <Label htmlFor="r1" className="cursor-pointer">1st</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="2nd" id="r2" />
              <Label htmlFor="r2" className="cursor-pointer">2nd</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="Final" id="r3" />
              <Label htmlFor="r3" className="cursor-pointer">Final</Label>
            </div>
          </RadioGroup>
        </div>

        <div className="space-y-2">
          <Label>Reason / Remarks</Label>
          <textarea 
            className="w-full h-24 p-3 rounded-lg border border-slate-200 focus:ring-2 focus:ring-red-500 focus:outline-none text-sm"
            placeholder="Detailed explanation for the warning ticket..."
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
          ></textarea>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button className="bg-red-600 hover:bg-red-700" onClick={handleSubmit}>Issue Ticket</Button>
      </div>
    </div>
  );
}

function Badge({ children, className }: { children: React.ReactNode, className?: string }) {
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${className}`}>
      {children}
    </span>
  );
}
