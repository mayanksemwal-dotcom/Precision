import React, { useState } from 'react';
import { 
  ShieldAlert, 
  AlertTriangle, 
  Info, 
  History, 
  FileText, 
  User as UserIcon,
  Calendar,
  ChevronRight,
  TrendingUp,
  Search,
  Filter,
  Plus
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { WarningTicket, UserRole, UserProfile } from '../types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import WarningManager from '../components/WarningManager';

interface WarningsViewProps {
  warnings: WarningTicket[];
  user: UserProfile;
  allUsers: UserProfile[];
}

export default function WarningsView({ warnings, user, allUsers }: WarningsViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [isWarningOpen, setIsWarningOpen] = useState(false);

  const filteredWarnings = warnings.filter(w => 
    w.agentId.toLowerCase().includes(searchTerm.toLowerCase()) ||
    w.remarks.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const canIssueWarning = user.role === UserRole.ADMIN || user.role === UserRole.QA;

  const getLevelColor = (level: string) => {
    switch (level) {
      case '1st': return 'bg-blue-100 text-blue-700 border-blue-200';
      case '2nd': return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'Final': return 'bg-red-100 text-red-700 border-red-200';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-red-600 flex items-center justify-center text-white shadow-lg shadow-red-200">
            <ShieldAlert size={24} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight">Disciplinary Management</h2>
            <p className="text-sm font-medium text-slate-500">Track and manage corporate disciplinary actions</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {canIssueWarning && (
            <Dialog open={isWarningOpen} onOpenChange={setIsWarningOpen}>
              <DialogTrigger asChild>
                <Button className="bg-red-600 hover:bg-red-700 text-white font-bold gap-2">
                  <Plus size={18} /> Issue Warning
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[500px] bg-white shadow-2xl border border-slate-200">
                <DialogHeader>
                  <DialogTitle className="text-xl font-bold">Raise Disciplinary Action</DialogTitle>
                  <DialogDescription className="text-slate-500">
                    Select an agent and warning level based on the corporate policy.
                  </DialogDescription>
                </DialogHeader>
                <WarningManager allUsers={allUsers} onClose={() => setIsWarningOpen(false)} />
              </DialogContent>
            </Dialog>
          )}
          <div className="px-4 py-2 bg-slate-50 rounded-lg border border-slate-200 flex items-center gap-3">
            <div className="text-right border-r border-slate-200 pr-3">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Active Level 1</p>
              <p className="text-lg font-black text-slate-900 leading-none">
                {warnings.filter(w => w.level === '1st').length}
              </p>
            </div>
            <div className="pl-1">
              <TrendingUp size={16} className="text-green-500" />
            </div>
          </div>
          <div className="px-4 py-2 bg-slate-50 rounded-lg border border-slate-200 flex items-center gap-3">
            <div className="text-right">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Issued</p>
              <p className="text-lg font-black text-slate-900 leading-none">{warnings.length}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Left Column: Stats & Policy */}
        <div className="space-y-6 lg:col-span-1">
          <Card className="border-none shadow-sm shadow-slate-200/60 overflow-hidden">
            <CardHeader className="bg-slate-900 text-white pb-6 pt-8">
              <CardTitle className="text-sm font-bold tracking-widest uppercase opacity-80 mb-2">Policy Overview</CardTitle>
              <CardDescription className="text-slate-400 text-xs leading-relaxed">
                Adhere to the corporate quality framework to maintain service excellence.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 space-y-4">
              <div className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded bg-blue-50 flex items-center justify-center text-blue-600 shrink-0 mt-0.5">
                  <Info size={12} />
                </div>
                <div className="text-xs space-y-1">
                  <p className="font-bold text-slate-900">Level 1: Oral Warning</p>
                  <p className="text-slate-500 leading-tight">Initial notification of performance misalignment.</p>
                </div>
              </div>
              <div className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded bg-amber-50 flex items-center justify-center text-amber-600 shrink-0 mt-0.5">
                  <AlertTriangle size={12} />
                </div>
                <div className="text-xs space-y-1">
                  <p className="font-bold text-slate-900">Level 2: Written Warning</p>
                  <p className="text-slate-500 leading-tight">Secondary notification with formal performance path.</p>
                </div>
              </div>
              <div className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded bg-red-50 flex items-center justify-center text-red-600 shrink-0 mt-0.5">
                  <ShieldAlert size={12} />
                </div>
                <div className="text-xs space-y-1">
                  <p className="font-bold text-slate-900">Final: Termination Warning</p>
                  <p className="text-slate-500 leading-tight">Critical notification - last chance before offboarding.</p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="bg-slate-50 border-t border-slate-100 flex justify-center py-4">
              <Button 
                variant="link" 
                className="text-xs font-bold text-slate-500 flex items-center gap-1"
                asChild
              >
                <a 
                  href="https://docs.google.com/document/d/1zAu2KCCUfOFBA8-nopnc1YRNycaDhCtRPfI7CIgFl7Y/edit?tab=t.ttcgryfeyu7#heading=h.ra63ci5w7hx3" 
                  target="_blank" 
                  rel="noopener noreferrer"
                >
                  View Staircase Policy <ChevronRight size={14} />
                </a>
              </Button>
            </CardFooter>
          </Card>
        </div>

        {/* Right Column: Active Tickets */}
        <div className="lg:col-span-3 space-y-6">
          <div className="flex items-center gap-4">
            <div className="relative flex-1 group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors" size={18} />
              <Input 
                placeholder="Search by agent ID or remarks..." 
                className="pl-10 h-11 bg-white border-slate-200 focus:ring-blue-500 rounded-xl"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <Button variant="outline" className="h-11 rounded-xl bg-white border-slate-200 flex gap-2">
              <Filter size={18} /> Filters
            </Button>
          </div>

          <Card className="border-none shadow-sm shadow-slate-200/60 overflow-hidden">
            <CardHeader className="border-b border-slate-100 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg font-black text-slate-900 tracking-tight">Active Disciplinary Log</CardTitle>
                  <CardDescription className="text-xs font-medium">Record of all issued warnings for current quarter</CardDescription>
                </div>
                <History size={20} className="text-slate-300" />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-slate-50/50">
                  <TableRow className="hover:bg-transparent border-slate-100">
                    <TableHead className="w-[150px] font-bold text-slate-900 text-[10px] uppercase tracking-widest pl-6">Level</TableHead>
                    <TableHead className="font-bold text-slate-900 text-[10px] uppercase tracking-widest">Agent ID</TableHead>
                    <TableHead className="font-bold text-slate-900 text-[10px] uppercase tracking-widest w-[120px]">Date Issued</TableHead>
                    <TableHead className="font-bold text-slate-900 text-[10px] uppercase tracking-widest pl-4">Remarks & Observations</TableHead>
                    <TableHead className="w-[100px] text-right pr-6">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredWarnings.map((ticket) => (
                    <TableRow key={ticket.id} className="hover:bg-slate-50/50 border-slate-100 group transition-colors">
                      <TableCell className="pl-6">
                        <Badge className={`border px-2 py-0.5 rounded-full font-bold text-[10px] shadow-sm ${getLevelColor(ticket.level)}`}>
                          {ticket.level} Notification
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs font-black text-slate-600">{ticket.agentId}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-slate-500">
                          <Calendar size={12} />
                          <span className="text-xs font-semibold">
                            {ticket.createdAt ? new Date(ticket.createdAt).toLocaleDateString() : 'N/A'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="pl-4">
                        <div className="flex items-start gap-3 py-1">
                          <div className="w-1 h-8 rounded-full bg-slate-100 shrink-0"></div>
                          <p className="text-xs text-slate-500 font-medium leading-relaxed italic line-clamp-2">
                            "{ticket.remarks}"
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-right pr-6">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-blue-600 rounded-lg">
                          <FileText size={16} />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredWarnings.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-20 text-center">
                        <div className="flex flex-col items-center gap-2 opacity-30">
                          <FileText size={48} strokeWidth={1} />
                          <p className="text-sm font-bold uppercase tracking-widest">No Disciplinary Records Found</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
