import React from 'react';
import AttendanceDashboard from '../components/attendance/AttendanceDashboard';
import { UserProfile } from '../types';

interface AttendanceViewProps {
  user: UserProfile;
  allUsers: UserProfile[];
  externalTheme?: 'light' | 'dark';
}

export default function AttendanceView({ user, allUsers, externalTheme }: AttendanceViewProps) {
  return (
    <div className="p-8 h-full overflow-y-auto">
      <AttendanceDashboard user={user} allUsers={allUsers} />
    </div>
  );
}
