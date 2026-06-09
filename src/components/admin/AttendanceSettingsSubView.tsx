import React, { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { Save, Settings, RefreshCw } from 'lucide-react';

export function AttendanceSettingsSubView() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({
    presentThreshold: 480,
    halfDayThreshold: 240,
    countBreakTime: false,
    autoGenTimeHour: 4
  });

  useEffect(() => {
    async function loadSettings() {
      try {
        const snap = await getDoc(doc(db, 'config', 'attendanceSettings'));
        if (snap.exists()) {
          const data = snap.data();
          setSettings({
            presentThreshold: data.presentThreshold ?? 480,
            halfDayThreshold: data.halfDayThreshold ?? 240,
            countBreakTime: data.countBreakTime ?? false,
            autoGenTimeHour: data.autoGenTimeHour ?? 4
          });
        }
      } catch (err) {
        console.error('Failed to load attendance config', err);
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await setDoc(doc(db, 'config', 'attendanceSettings'), settings);
      toast.success('Attendance settings saved successfully.');
    } catch (err) {
      console.error(err);
      toast.error('Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-400">Loading Configuration...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-black text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <Settings size={20} className="text-indigo-500" /> Attendance Configuration
        </h3>
      </div>

      <form onSubmit={handleSave} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Present Threshold (Minutes)</label>
            <input 
              type="number" 
              required min="1"
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
              value={settings.presentThreshold} 
              onChange={e => setSettings({...settings, presentThreshold: Number(e.target.value)})} 
            />
            <p className="text-[10px] text-slate-400">Productive minutes required for full Present mark.</p>
          </div>
          
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Half Day Threshold (Minutes)</label>
            <input 
              type="number" 
              required min="1"
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
              value={settings.halfDayThreshold} 
              onChange={e => setSettings({...settings, halfDayThreshold: Number(e.target.value)})} 
            />
            <p className="text-[10px] text-slate-400">Minutes required before falling into half-day (below this is Absent).</p>
          </div>
          
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Include Break Time in Productive Duration</label>
            <select 
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
              value={settings.countBreakTime ? 'true' : 'false'} 
              onChange={e => setSettings({...settings, countBreakTime: e.target.value === 'true'})}
            >
              <option value="false">No (Productive Time Only)</option>
              <option value="true">Yes</option>
            </select>
          </div>
          
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Auto Generate Target Time (24H)</label>
            <input 
              type="number" 
              required min="0" max="23"
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
              value={settings.autoGenTimeHour} 
              onChange={e => setSettings({...settings, autoGenTimeHour: Number(e.target.value)})} 
            />
            <p className="text-[10px] text-slate-400">Hour (0-23) when backend cron logic attempts sweeping historical records.</p>
          </div>
        </div>
        
        <div className="flex justify-end pt-4 border-t border-slate-100 dark:border-slate-800">
          <button 
            type="submit" 
            disabled={saving}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl font-bold text-sm tracking-tight transition-colors flex items-center gap-2"
          >
            {saving ? <RefreshCw className="animate-spin" size={16} /> : <Save size={16} />} 
            Save Configuration
          </button>
        </div>
      </form>
    </div>
  );
}
