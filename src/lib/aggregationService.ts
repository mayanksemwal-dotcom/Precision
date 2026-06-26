import { db } from './firebase';
import { doc, getDoc, setDoc, updateDoc, increment, collection, getDocs, query, where } from 'firebase/firestore';

export interface WorkforceAggregate {
  totalUsers: number;
  activeUsers: number;
  byRole: Record<string, number>;
  byProcess: Record<string, number>;
  lastUpdated: string;
}

export interface AttendanceAggregate {
  date: string;
  totalClockIn: number;
  activeShifts: number;
  totalLate: number;
  totalOnBreak: number;
  totalOffline?: number;
  attendanceRate?: number;
  avgUtilization?: number;
  lastUpdated: string;
}

export interface KPILeaderboard {
  date: string;
  topPerformers: Array<{
    name: string;
    email: string;
    utilization: number;
    score: number;
  }>;
  processAverages: Record<string, number>;
  lastUpdated: string;
}

export interface ITHelpDeskAggregate {
  openTickets: number;
  pendingTickets: number;
  resolvedToday: number;
  criticalTickets: number;
  lastUpdated: string;
}

export class AggregationService {
  /**
   * Workforce Aggregation
   */
  static async getWorkforceSummary(): Promise<WorkforceAggregate | null> {
    const snap = await getDoc(doc(db, 'aggregates', 'workforce_summary'));
    return snap.exists() ? snap.data() as WorkforceAggregate : null;
  }

  static async updateWorkforceSummary(allUsers: any[]) {
    const aggregate: WorkforceAggregate = {
      totalUsers: allUsers.length,
      activeUsers: allUsers.filter(u => (u.status || '').toLowerCase() === 'active').length,
      byRole: {},
      byProcess: {},
      lastUpdated: new Date().toISOString()
    };

    allUsers.forEach(u => {
      const role = u.role || 'AGENT';
      aggregate.byRole[role] = (aggregate.byRole[role] || 0) + 1;
      
      const process = u.process || 'Unassigned';
      aggregate.byProcess[process] = (aggregate.byProcess[process] || 0) + 1;
    });

    await setDoc(doc(db, 'aggregates', 'workforce_summary'), aggregate);
  }

  /**
   * Attendance Aggregation
   */
  static async getAttendanceSummary(date: string): Promise<AttendanceAggregate | null> {
    const snap = await getDoc(doc(db, 'aggregates', `attendance_${date}`));
    return snap.exists() ? snap.data() as AttendanceAggregate : null;
  }

  static async updateAttendanceSummary(date: string, shifts: any[], totalRosterCount: number = 0) {
    const active = shifts.filter(s => s.status === 'ACTIVE').length;
    const onBreak = shifts.filter(s => s.status === 'BREAK').length;
    const loggedIn = active + onBreak;
    
    const aggregate: AttendanceAggregate = {
      date,
      totalClockIn: shifts.length,
      activeShifts: active,
      totalLate: shifts.filter(s => s?.isLate).length,
      totalOnBreak: onBreak,
      totalOffline: totalRosterCount > 0 ? Math.max(0, totalRosterCount - loggedIn) : 0,
      attendanceRate: totalRosterCount > 0 ? Math.round((loggedIn / totalRosterCount) * 100) : 0,
      lastUpdated: new Date().toISOString()
    };

    await setDoc(doc(db, 'aggregates', `attendance_${date}`), aggregate);
  }

  /**
   * KPI Leaderboard Aggregation
   */
  static async updateKPILeaderboard(shifts: any[]) {
    const today = new Date().toISOString().substring(0, 10);
    
    // Sort by utilization (simulated or calculated)
    const leaderboard: KPILeaderboard = {
      date: today,
      topPerformers: shifts
        .map(s => ({
          name: s.userName,
          email: s.userEmail,
          utilization: s.utilization || 0,
          score: (s.utilization || 0) * 0.8 + (s.completedTasks || 0) * 0.2
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10),
      processAverages: {},
      lastUpdated: new Date().toISOString()
    };

    await setDoc(doc(db, 'aggregates', 'kpi_leaderboard'), leaderboard);
  }

  /**
   * IT Help Desk Aggregation
   */
  static async getITSummary(): Promise<ITHelpDeskAggregate | null> {
    const snap = await getDoc(doc(db, 'aggregates', 'it_summary'));
    return snap.exists() ? snap.data() as ITHelpDeskAggregate : null;
  }

  static async updateITSummary(tickets: any[]) {
    const todayStr = new Date().toISOString().substring(0, 10);
    const aggregate: ITHelpDeskAggregate = {
      openTickets: tickets.filter(t => t.status === 'Open').length,
      pendingTickets: tickets.filter(t => t.status === 'In Progress' || t.status === 'Pending Vendor').length,
      resolvedToday: tickets.filter(t => t.status === 'Resolved' && t.resolvedAt?.substring(0, 10) === todayStr).length,
      criticalTickets: tickets.filter(t => t.priority === 'Critical' && t.status !== 'Resolved' && t.status !== 'Closed').length,
      lastUpdated: new Date().toISOString()
    };

    await setDoc(doc(db, 'aggregates', 'it_summary'), aggregate);
  }
}
