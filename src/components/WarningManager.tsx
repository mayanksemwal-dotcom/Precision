import React, { useState } from 'react';
import { ShieldAlert, AlertTriangle, Info, History } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './ui/card';
import { Label } from './ui/label';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Separator } from './ui/separator';
import { toast } from 'sonner';

interface WarningManagerProps {
  agentName: string;
  agentId: string;
  onClose: () => void;
}

export default function WarningManager({ agentName, agentId, onClose }: WarningManagerProps) {
  const [level, setLevel] = useState<'1st' | '2nd' | 'Final'>('1st');
  const [remarks, setRemarks] = useState('');

  // Mock history
  const history = [
    { level: '1st', date: '2026-03-12', remarks: 'Consistent quality below 90%' }
  ];

  const handleSubmit = () => {
    if (!remarks) {
      toast.error('Remarks are required for issuing a warning');
      return;
    }
    toast.success(`${level} Warning issued to ${agentName}`);
    onClose();
  };

  return (
    <div className="space-y-6">
      <div className="bg-red-50 border border-red-100 p-4 rounded-lg flex gap-3">
        <ShieldAlert className="text-red-600 shrink-0" size={20} />
        <div>
          <h4 className="text-sm font-bold text-red-900">Warning Ticket Issuance</h4>
          <p className="text-xs text-red-700">This action will be logged and visible to Admin and Team Lead.</p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <Label className="text-xs uppercase font-bold text-slate-500">Target Agent</Label>
          <div className="p-3 bg-slate-50 rounded border border-slate-200 mt-1">
             <p className="font-bold">{agentName}</p>
             <p className="text-xs text-slate-500">ID: {agentId}</p>
          </div>
        </div>

        <div>
          <Label className="text-xs uppercase font-bold text-slate-500">Previous Warnings</Label>
          <div className="space-y-2 mt-1">
            {history.map((h, i) => (
              <div key={i} className="flex items-center gap-2 text-sm p-2 bg-slate-50 rounded border border-slate-100">
                <Badge className="bg-amber-100 text-amber-700 shrink-0">{h.level}</Badge>
                <span className="text-slate-400 font-mono text-xs">{h.date}</span>
                <span className="text-slate-600 truncate">{h.remarks}</span>
              </div>
            ))}
          </div>
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
