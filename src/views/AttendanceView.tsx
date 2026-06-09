import React from 'react';
import { UserProfile } from '../types';
import AttendanceDashboard from '../components/attendance/AttendanceDashboard';

interface AttendanceViewProps {
  user: UserProfile;
  allUsers: any[];
}

export default function AttendanceView({ user, allUsers }: AttendanceViewProps) {
  return (
    <div className="w-full h-full flex flex-col md:flex-row gap-6 p-4">
      <div className="flex-1 w-full flex flex-col min-h-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl overflow-hidden shadow-2xl relative">
         <AttendanceDashboard user={user} allUsers={allUsers} />
      </div>
    </div>
  );
}
