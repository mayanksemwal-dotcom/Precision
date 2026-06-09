import React, { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { Save, Settings, RefreshCw, Mail } from 'lucide-react';

export function AttendanceSettingsSubView() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({
    presentThreshold: 480,
    halfDayThreshold: 240,
    countBreakTime: false,
    autoGenTimeHour: 4
  });

  const [emailSettings, setEmailSettings] = useState({
    warningToMode: 'user', // 'user' or 'custom'
    warningToCustom: '',
    warningCc: 'hr@bergtechnologies.co.in',
    warningIncludeTlCc: false,
    warningIncludeManagerCc: false,
    pipToMode: 'user', // 'user' or 'custom'
    pipToCustom: '',
    pipCc: 'hr@bergtechnologies.co.in',
    pipIncludeTlCc: false,
    pipIncludeManagerCc: false
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

        const emailSnap = await getDoc(doc(db, 'config', 'notificationSettings'));
        if (emailSnap.exists()) {
          const data = emailSnap.data();
          setEmailSettings({
            warningToMode: data.warningToMode ?? 'user',
            warningToCustom: data.warningToCustom ?? '',
            warningCc: data.warningCc ?? 'hr@bergtechnologies.co.in',
            warningIncludeTlCc: data.warningIncludeTlCc ?? false,
            warningIncludeManagerCc: data.warningIncludeManagerCc ?? false,
            pipToMode: data.pipToMode ?? 'user',
            pipToCustom: data.pipToCustom ?? '',
            pipCc: data.pipCc ?? 'hr@bergtechnologies.co.in',
            pipIncludeTlCc: data.pipIncludeTlCc ?? false,
            pipIncludeManagerCc: data.pipIncludeManagerCc ?? false
          });
        }
      } catch (err) {
        console.error('Failed to load configurations', err);
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
      console.log('Attempting to save attendance configurations...');
      await setDoc(doc(db, 'config', 'attendanceSettings'), settings);
      
      console.log('Attempting to save notification configurations...');
      await setDoc(doc(db, 'config', 'notificationSettings'), emailSettings);
      
      toast.success('All configurations saved successfully.');
    } catch (err) {
      console.error('Critical failure during settings save:', err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to save settings: ${errorMsg}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-400">Loading Configuration...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-black text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <Settings size={20} className="text-indigo-505" /> Workforce System Configuration
        </h3>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Card 1: Attendance Rules */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6">
          <h4 className="text-sm font-black text-slate-800 dark:text-slate-100 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-850 pb-3">
            🎯 Attendance Parameters
          </h4>
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
        </div>

        {/* Card 2: Disciplinary & PIP Automated Notification Settings */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6">
          <h4 className="text-sm font-black text-slate-800 dark:text-slate-100 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-850 pb-3">
            <Mail size={16} className="text-indigo-500" strokeWidth={2} /> Automated Email Notification Triggers (Warnings & PIP)
          </h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium pb-2 select-none leading-relaxed">
            Configure default email targets (To/CC/From) whenever a supervisor or system admin issues a formal Warning, Disciplinary Notice, or a Performance Improvement Plan (PIP).
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Warning Ticket Trigger Configuration */}
            <div className="space-y-4 border-r border-slate-100 dark:border-slate-850 pr-0 md:pr-6">
              <h5 className="text-xs font-black uppercase text-indigo-500 tracking-wider">Warnings & Disciplinary Email</h5>
              
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Recipient Target (To)</label>
                <select 
      className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-indigo-500 font-semibold"
                  value={emailSettings.warningToMode} 
                  onChange={e => setEmailSettings({...emailSettings, warningToMode: e.target.value})}
                >
                  <option value="user">The user to which the action happened (Default)</option>
                  <option value="custom">Specific Custom Address</option>
                </select>
              </div>

              {emailSettings.warningToMode === 'custom' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Custom Recipient Email Address</label>
                  <input 
                    type="email" 
                    placeholder="e.g. support@bergtechnologies.co.in"
                    className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-indigo-500"
                    value={emailSettings.warningToCustom} 
                    onChange={e => setEmailSettings({...emailSettings, warningToCustom: e.target.value})} 
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600 dark:text-slate-400">CC Recipients (Comma separated)</label>
                <input 
                  type="text" 
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-indigo-500"
                  value={emailSettings.warningCc} 
                  onChange={e => setEmailSettings({...emailSettings, warningCc: e.target.value})} 
                />
                <p className="text-[10px] text-slate-400">Default is hr@bergtechnologies.co.in</p>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={emailSettings.warningIncludeTlCc} 
                    onChange={e => setEmailSettings({...emailSettings, warningIncludeTlCc: e.target.checked})}
                    className="rounded text-indigo-600 focus:ring-indigo-500" 
                  />
                  Auto-CC Recipient Employee's Team Lead
                </label>
                <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={emailSettings.warningIncludeManagerCc} 
                    onChange={e => setEmailSettings({...emailSettings, warningIncludeManagerCc: e.target.checked})}
                    className="rounded text-indigo-600 focus:ring-indigo-500" 
                  />
                  Auto-CC Recipient Employee's Mapped Manager
                </label>
              </div>
            </div>

            {/* Performance Improvement Plan (PIP) Trigger Configuration */}
            <div className="space-y-4">
              <h5 className="text-xs font-black uppercase text-indigo-500 tracking-wider">Performance Improvement (PIP) Email</h5>
              
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Recipient Target (To)</label>
                <select 
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-indigo-500 font-semibold"
                  value={emailSettings.pipToMode} 
                  onChange={e => setEmailSettings({...emailSettings, pipToMode: e.target.value})}
                >
                  <option value="user">The user to which the action happened (Default)</option>
                  <option value="custom">Specific Custom Address</option>
                </select>
              </div>

              {emailSettings.pipToMode === 'custom' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-600 dark:text-slate-400">Custom Recipient Email Address</label>
                  <input 
                    type="email" 
                    placeholder="e.g. hr-ops@bergtechnologies.co.in"
                    className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-indigo-500"
                    value={emailSettings.pipToCustom} 
                    onChange={e => setEmailSettings({...emailSettings, pipToCustom: e.target.value})} 
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600 dark:text-slate-400">CC Recipients (Comma separated)</label>
                <input 
                  type="text" 
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-indigo-500"
                  value={emailSettings.pipCc} 
                  onChange={e => setEmailSettings({...emailSettings, pipCc: e.target.value})} 
                />
                <p className="text-[10px] text-slate-400">Default is hr@bergtechnologies.co.in</p>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={emailSettings.pipIncludeTlCc} 
                    onChange={e => setEmailSettings({...emailSettings, pipIncludeTlCc: e.target.checked})}
                    className="rounded text-indigo-600 focus:ring-indigo-500" 
                  />
                  Auto-CC Recipient Employee's Team Lead
                </label>
                <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={emailSettings.pipIncludeManagerCc} 
                    onChange={e => setEmailSettings({...emailSettings, pipIncludeManagerCc: e.target.checked})}
                    className="rounded text-indigo-600 focus:ring-indigo-500" 
                  />
                  Auto-CC Recipient Employee's Mapped Manager
                </label>
              </div>
            </div>
          </div>
          
          <div className="pt-4 border-t border-slate-100 dark:border-slate-850">
            <p className="text-[10px] text-amber-600 dark:text-amber-400 font-bold uppercase tracking-widest leading-none flex items-center gap-1">
              ⚡ Outbound Routing Rule: CC contains defaults + hr@bergtechnologies.co.in | Sent FROM the logged-in user who triggered the action.
            </p>
          </div>
        </div>
        
        {/* Save Trigger Button */}
        <div className="flex justify-end pt-2">
          <button 
            type="submit" 
            disabled={saving}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-2xl font-bold text-sm tracking-tight transition-colors flex items-center gap-2 shadow-sm shadow-indigo-200 cursor-pointer border-none"
          >
            {saving ? <RefreshCw className="animate-spin" size={16} /> : <Save size={16} />} 
            Save All Configurations
          </button>
        </div>
      </form>
    </div>
  );
}
