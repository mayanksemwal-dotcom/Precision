import React, { useState } from 'react';
import WarningsView from './WarningsView';
import PipView from './PipView';
import { UserProfile, WarningTicket } from '../types';

interface EmployeeRelationsViewProps {
  user: UserProfile;
  allUsers: UserProfile[];
  warnings: WarningTicket[];
  externalTheme?: 'light' | 'dark';
}

export default function EmployeeRelationsView({ user, allUsers, warnings, externalTheme }: EmployeeRelationsViewProps) {
  const [activeTab, setActiveTab] = useState<'warnings' | 'pips'>('warnings');
  
  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <button 
          onClick={() => setActiveTab('warnings')} 
          className={`px-4 py-2 text-sm font-bold rounded-lg transition-colors ${activeTab === 'warnings' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
        >
          Warnings
        </button>
        <button 
          onClick={() => setActiveTab('pips')} 
          className={`px-4 py-2 text-sm font-bold rounded-lg transition-colors ${activeTab === 'pips' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
        >
          PIPs
        </button>
      </div>
      
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm">
        {activeTab === 'warnings' && <WarningsView warnings={warnings} user={user} allUsers={allUsers} externalTheme={externalTheme} />}
        {activeTab === 'pips' && <PipView user={user} allUsers={allUsers} externalTheme={externalTheme} />}
      </div>
    </div>
  );
}
