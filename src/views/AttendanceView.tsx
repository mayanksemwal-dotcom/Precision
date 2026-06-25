import React from 'react';
import { UserProfile } from '../types';
import AttendanceDashboard from '../components/attendance/AttendanceDashboard';

interface AttendanceViewProps {
  user: UserProfile;
  allUsers: any[];
  externalTheme?: 'light' | 'dark';
}

export default React.memo(function AttendanceView({ user, allUsers, externalTheme }: AttendanceViewProps) {
  return (
    <div className="w-full h-full flex flex-col md:flex-row gap-2 p-1.5">
      <div className="flex-1 w-full flex flex-col min-h-0 bg-white dark:bg-slate-900 border border-slate-150 dark:border-slate-800 rounded-xl overflow-hidden shadow-md relative">
         <AttendanceDashboard user={user} allUsers={allUsers} />
      </div>
    </div>
  );
});
