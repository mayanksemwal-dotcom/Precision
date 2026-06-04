import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import { KpiUploadRow } from '../lib/kpiEngine';
import { X, Calendar, MessageSquare } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  kpiName: string;
  email: string;
  reportingPeriod: string;
}

export function KpiCommentHistorySidePanel({ isOpen, onClose, kpiName, email, reportingPeriod }: Props) {
  const [history, setHistory] = useState<KpiUploadRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && kpiName && email && reportingPeriod) {
      fetchHistory();
    }
  }, [isOpen, kpiName, email, reportingPeriod]);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const q = query(
        collection(db, 'kpi_uploads'),
        where('employeeEmail', '==', email.toLowerCase().trim()),
        where('kpiName', '==', kpiName),
        where('reportingPeriod', '==', reportingPeriod),
        orderBy('workDate', 'desc')
      );
      const snap = await getDocs(q);
      setHistory(snap.docs.map(d => ({ ...d.data(), docId: d.id } as any)));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50">
      <div className="w-full max-w-lg bg-white h-full shadow-2xl flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold">History: {kpiName}</h2>
          <Button variant="ghost" onClick={onClose}><X size={16} /></Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading ? (
            <p>Loading...</p>
          ) : history.length === 0 ? (
            <p>No history found.</p>
          ) : (
            history.map((row, idx) => (
              <div key={idx} className="bg-slate-50 p-3 rounded-lg border border-slate-100 flex gap-3">
                <div className="shrink-0 flex flex-col items-center gap-1">
                  <Calendar size={14} className="text-slate-400" />
                  <span className="text-[10px] font-bold text-slate-500">{row.workDate}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex gap-2 mb-1">
                    <Badge variant="outline">Act: {row.actual}</Badge>
                    <Badge variant="outline">Tgt: {row.target}</Badge>
                  </div>
                  <p className="text-xs text-slate-700 leading-snug">{row.comments || <em className="text-slate-400">No comment</em>}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
