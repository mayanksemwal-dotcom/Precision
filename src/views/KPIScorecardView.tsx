import React, { useState } from 'react';
import { UserProfile, UserRole } from '../types';
import EmployeeKpiDashboard from '../components/kpi/EmployeeKpiDashboard';
import ManagerKpiDashboard from '../components/kpi/ManagerKpiDashboard';
import { Button } from '../components/ui/button';
import { Award, Users, User } from 'lucide-react';

interface KPIScorecardViewProps {
  user: UserProfile;
  allUsers: UserProfile[];
  externalTheme?: 'light' | 'dark';
}

export default function KPIScorecardView({
  user,
  allUsers,
  externalTheme = 'light',
}: KPIScorecardViewProps) {
  // Check if user has management/upload permissions
  const roleStr = String(user.role || '').toUpperCase();
  const canManage =
    roleStr === UserRole.ADMIN ||
    roleStr === UserRole.MANAGER ||
    roleStr === UserRole.MIS ||
    roleStr === UserRole.TEAM_LEAD ||
    roleStr === UserRole.OPS_TL ||
    roleStr === UserRole.STL ||
    roleStr === UserRole.QTL ||
    roleStr === 'ADMIN' ||
    roleStr === 'MANAGER' ||
    roleStr === 'MIS' ||
    roleStr === 'TEAM LEAD';

  const [activeTab, setActiveTab] = useState<'manager' | 'employee'>(
    canManage ? 'manager' : 'employee'
  );

  return (
    <div className="p-4 md:p-6 min-h-screen bg-slate-50/50 dark:bg-slate-950/50 text-slate-900 dark:text-slate-100">
      {/* Role Switcher Toggle for Managers / Admins / MIS */}
      {canManage && (
        <div className="max-w-7xl mx-auto mb-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5 p-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
            <button
              onClick={() => setActiveTab('manager')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeTab === 'manager'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Users size={14} />
              <span>Team Scorecards</span>
            </button>
            <button
              onClick={() => setActiveTab('employee')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeTab === 'employee'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <User size={14} />
              <span>My Scorecard</span>
            </button>
          </div>
        </div>
      )}

      {/* Render View */}
      {activeTab === 'manager' && canManage ? (
        <ManagerKpiDashboard user={user} roster={allUsers} />
      ) : (
        <EmployeeKpiDashboard user={user} />
      )}
    </div>
  );
}
