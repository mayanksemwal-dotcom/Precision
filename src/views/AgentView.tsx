import React, { useState } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  MessageSquare, 
  CheckCircle2, 
  HelpCircle,
  Clock,
  ExternalLink,
  ChevronRight,
  AlertCircle
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import { UserRole, AuditRecord, DisputeStatus, DisputeHistory, UserProfile } from '../types';
import DisputeWorkflow from '../components/DisputeWorkflow';
import { analyzePrecision } from '../services/geminiService';
import { Sparkles, BrainCircuit, Lightbulb } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, updateDoc } from 'firebase/firestore';
import { submitToGoogleSheet } from '../lib/sheets';

interface AgentViewProps {
  activeTab: string;
  audits: AuditRecord[];
  user: UserProfile;
  onRefresh?: () => void;
}

export default function AgentView({ activeTab, audits, user, onRefresh }: AgentViewProps) {
  const [activeFeedbackId, setActiveFeedbackId] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiTips, setAiTips] = useState<string[]>([]);

  const handleUpdateAudit = async (updated: AuditRecord) => {
    try {
      const docRef = doc(db, 'audits', updated.id);
      await updateDoc(docRef, {
        disputeStatus: updated.disputeStatus,
        disputeHistory: updated.disputeHistory,
        isReopened: updated.isReopened || false
      });
      submitToGoogleSheet('dispute_submission', updated.id, user.email, user.name, updated);
      toast.success('Dispute updated successfully');
      if (onRefresh) {
        onRefresh();
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `audits/${updated.id}`);
    }
  };

  const handleAIAnalyze = async () => {
    setAnalyzing(true);
    setAiTips([]);
    try {
      const tips = await analyzePrecision(audits);
      setAiTips(tips);
      toast.success('AI Analysis complete!');
    } catch (e) {
      toast.error('Failed to analyze data.');
    } finally {
      setAnalyzing(false);
    }
  };

  const performanceData = audits.slice(-7).map((a, i) => ({
    day: `A-${audits.length - 7 + i + 1}`,
    score: a.quality
  }));

  const mtdQuality = audits.length > 0 
    ? (audits.reduce((acc, curr) => acc + curr.quality, 0) / audits.length).toFixed(1)
    : '0.0';

  const handleAccept = async (id: string) => {
    if (!window.confirm('Are you sure you want to accept this feedback? This action will remove it from your pending list.')) {
      return;
    }

    try {
      const docRef = doc(db, 'audits', id);
      await updateDoc(docRef, {
        isAccepted: true
      });
      toast.success('Error Accepted and cleared from view.');
      if (onRefresh) {
        onRefresh();
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `audits/${id}`);
    }
  };

  const pendingFeedback = audits.filter(a => 
    a.status === 'Incorrect' && 
    !a.isAccepted && 
    a.disputeStatus !== DisputeStatus.RESOLVED
  );

  if (activeTab === 'dashboard') {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="bg-gradient-to-br from-blue-600 to-blue-700 text-white border-none shadow-lg">
            <CardHeader className="pb-2">
              <CardDescription className="text-blue-100 text-xs font-bold uppercase">MTD Quality Score</CardDescription>
              <CardTitle className="text-4xl font-black">{mtdQuality}%</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center text-sm font-medium">
                <TrendingUp size={16} className="mr-1" /> Above team average (92.5%)
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs font-bold uppercase text-slate-500">Target Accuracy</CardDescription>
              <CardTitle className="text-4xl font-black text-slate-900">92%</CardTitle>
            </CardHeader>
            <CardContent>
               <div className="w-full bg-slate-100 h-2 rounded-full mt-2">
                  <div className="bg-green-500 h-2 rounded-full" style={{ width: `${mtdQuality}%` }}></div>
               </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm border-l-4 border-l-amber-500">
             <CardHeader className="pb-2">
              <CardDescription className="text-xs font-bold uppercase text-slate-500">Recent Warnings</CardDescription>
              <CardTitle className="text-4xl font-black text-slate-900">0</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm font-medium text-green-600">
                Excellent disciplinary standing
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="shadow-sm overflow-hidden">
          <CardHeader className="border-b bg-slate-50/50">
            <CardTitle className="text-lg flex items-center gap-2">
              <TrendingUp size={20} className="text-blue-600" />
              Daily Quality Performance
            </CardTitle>
            <CardDescription>Visual trend of your last 7 active days</CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={performanceData}>
                  <defs>
                    <linearGradient id="colorScore" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.1}/>
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis 
                    dataKey="day" 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{fontSize: 12, fill: '#64748b'}} 
                    dy={10}
                  />
                  <YAxis 
                    domain={[0, 100]} 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{fontSize: 12, fill: '#64748b'}}
                  />
                  <Tooltip 
                    contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'}}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="score" 
                    stroke="#3b82f6" 
                    strokeWidth={2}
                    fillOpacity={1} 
                    fill="url(#colorScore)" 
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (activeTab === 'feedback') {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-end">
           <div>
              <h3 className="text-2xl font-bold tracking-tight">Quality Feedback</h3>
              <p className="text-slate-500">Review, accept or dispute errors flagged by QA</p>
           </div>
           <Button 
            disabled={analyzing}
            onClick={handleAIAnalyze}
            className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 border-none text-white gap-2 shadow-lg shadow-blue-500/10"
           >
             {analyzing ? (
               <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
             ) : (
               <Sparkles size={16} />
             )}
             {analyzing ? 'AI Analyzing...' : 'Analyze My Performance'}
           </Button>
        </div>

        <AnimatePresence>
          {aiTips.length > 0 && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <Card className="bg-blue-50/50 border-blue-200 border-dashed">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-bold flex items-center gap-2 text-blue-700">
                    <BrainCircuit size={16} /> AI-Powered Optimization Tips
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid md:grid-cols-3 gap-4 pb-6">
                  {aiTips.map((tip, i) => (
                    <div key={i} className="bg-white p-4 rounded-lg border border-blue-100 shadow-sm flex gap-3 items-start">
                      <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                        <Lightbulb size={12} className="text-blue-600" />
                      </div>
                      <p className="text-xs font-medium text-slate-700 leading-relaxed">{tip}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid gap-4">
          {pendingFeedback.map((f) => (
            <Card key={f.id} className={`shadow-sm border-l-4 overflow-hidden ${
              f.disputeStatus === DisputeStatus.PENDING 
                ? 'border-l-amber-500 bg-amber-50/20' 
                : f.disputeStatus === DisputeStatus.QA_REVIEWED
                ? 'border-l-rose-500 bg-rose-50/10'
                : 'border-l-red-500'
            }`}>
              <CardContent className="p-6">
                <div className="flex flex-col md:flex-row justify-between gap-6">
                  <div className="flex-1 space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge variant="outline" className="font-mono">{f.taskId}</Badge>
                      <Badge variant="secondary" className="bg-red-100 text-red-700 hover:bg-red-100">{f.errorType}</Badge>
                      {f.disputeStatus === DisputeStatus.QA_REVIEWED && (
                        <Badge className="bg-rose-100 text-rose-800 border border-rose-200 font-bold">Dispute Denied by QA</Badge>
                      )}
                      {f.isReopened && (
                        <Badge className="bg-orange-100 text-orange-850 hover:bg-orange-100 border border-orange-200 font-extrabold gap-1 animate-pulse">
                          ↺ Re-opened
                        </Badge>
                      )}
                      <span className="text-slate-400 text-sm">{f.auditDate}</span>
                    </div>
                    
                    <div>
                      <h4 className="font-bold text-slate-900">{f.theme}</h4>
                      <div className="mt-2 p-3 bg-white rounded border text-sm text-slate-600 flex gap-3">
                         <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                           <MessageSquare size={14} className="text-slate-400" />
                         </div>
                         <div>
                            <p className="font-semibold text-xs text-slate-400 uppercase">QA Comment:</p>
                            {f.qaComment}
                         </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-3 shrink-0">
                    <div className="text-right">
                      <p className="text-xs text-slate-500 font-bold uppercase">QA Score</p>
                      <p className="text-2xl font-black text-red-600">{f.quality}%</p>
                    </div>
                    
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setActiveFeedbackId(activeFeedbackId === f.id ? null : f.id)}>
                        {f.disputeStatus === DisputeStatus.NONE 
                          ? 'Dispute' 
                          : f.disputeStatus === DisputeStatus.QA_REVIEWED
                          ? 'Re-open Thread'
                          : 'View Thread'}
                      </Button>
                      <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white font-bold" onClick={() => handleAccept(f.id)}>
                        {f.disputeStatus === DisputeStatus.QA_REVIEWED ? 'Accept Feedback' : 'Accept'}
                      </Button>
                    </div>
                  </div>
                </div>

                <AnimatePresence>
                  {activeFeedbackId === f.id && (
                    <motion.div 
                      initial={{ height: 0, opacity: 0 }} 
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="mt-6 pt-6 border-t"
                    >
                      <DisputeWorkflow 
                        audit={f} 
                        currentUser={{ name: user.name, role: UserRole.AGENT }} 
                        onUpdate={handleUpdateAudit}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </CardContent>
            </Card>
          ))}

          {pendingFeedback.length === 0 && (
            <div className="py-20 text-center space-y-4">
              <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 size={32} />
              </div>
              <div>
                <h4 className="text-lg font-bold">No Pending Feedback</h4>
                <p className="text-slate-500">Your quality workspace is currently clear. Excellent job!</p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null; // Handled at App level
}
