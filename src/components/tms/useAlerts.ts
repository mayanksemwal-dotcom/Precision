import { useMemo } from 'react';
import { TMSShift } from '../../views/TMSView';

export interface AlertItem {
  id: string;
  userId: string;
  userName: string;
  email: string;
  type: 'excessive_break' | 'stale_session' | 'mobile_punch' | 'missed_clock_out' | 'long_idle';
  severity: 'low' | 'medium' | 'high';
  message: string;
  timestamp: string;
}

export function useAlerts(activeShifts: TMSShift[], historicalShifts: TMSShift[]) {
  return useMemo(() => {
    const alerts: AlertItem[] = [];
    const now = Date.now();

    // 1. Scan active/break shifts for real-time break anomalies and stale sessions
    activeShifts.forEach((sh) => {
      // Check break overruns
      if (sh.status === 'BREAK') {
        const activities = sh.activities || [];
        const lastActivity = activities[activities.length - 1];
        if (lastActivity && !lastActivity.endTime) {
          const breakStart = new Date(lastActivity.startTime).getTime();
          const durationMins = (now - breakStart) / 60000;
          const breakName = lastActivity.name?.toLowerCase() || '';

          if (breakName.includes('lunch') && durationMins > 45) {
            alerts.push({
              id: `alert-lunch-${sh.id}`,
              userId: sh.userId,
              userName: sh.userName,
              email: sh.userEmail,
              type: 'excessive_break',
              severity: 'high',
              message: `${sh.userName} has exceeded the 45-minute lunch break limit (${Math.round(durationMins)} mins active)`,
              timestamp: lastActivity.startTime,
            });
          } else if (breakName.includes('bio') && durationMins > 5) {
            alerts.push({
              id: `alert-bio-${sh.id}`,
              userId: sh.userId,
              userName: sh.userName,
              email: sh.userEmail,
              type: 'excessive_break',
              severity: 'medium',
              message: `${sh.userName} has exceeded the 5-minute bio break limit (${Math.round(durationMins)} mins active)`,
              timestamp: lastActivity.startTime,
            });
          } else if (breakName.includes('short') && durationMins > 20) {
            alerts.push({
              id: `alert-short-${sh.id}`,
              userId: sh.userId,
              userName: sh.userName,
              email: sh.userEmail,
              type: 'excessive_break',
              severity: 'medium',
              message: `${sh.userName} has exceeded the 20-minute short break limit (${Math.round(durationMins)} mins active)`,
              timestamp: lastActivity.startTime,
            });
          } else if (durationMins > 15 && !breakName.includes('lunch') && !breakName.includes('bio') && !breakName.includes('short')) {
            // Generic break overrun fallback
            alerts.push({
              id: `alert-generic-${sh.id}`,
              userId: sh.userId,
              userName: sh.userName,
              email: sh.userEmail,
              type: 'excessive_break',
              severity: 'low',
              message: `${sh.userName} has exceeded a 15-minute generic break limit (${Math.round(durationMins)} mins active)`,
              timestamp: lastActivity.startTime,
            });
          }
        }
      }

      // Check for stale session (clocked in over 10 hours ago)
      if (sh.status === 'ACTIVE' || sh.status === 'BREAK') {
        const clockInTime = new Date(sh.clockInTime).getTime();
        const activeHours = (now - clockInTime) / 3600000;
        
        // Calculate productive time so far
        let productiveMs = 0;
        (sh.activities || []).forEach(act => {
          if (act.type === 'productive' || act.name?.toLowerCase().includes('work')) {
            const start = new Date(act.startTime).getTime();
            const end = act.endTime ? new Date(act.endTime).getTime() : now;
            productiveMs += (end - start);
          }
        });
        const productiveHours = productiveMs / 3600000;

        if (productiveHours > 10) {
          alerts.push({
            id: `alert-stale-${sh.id}`,
            userId: sh.userId,
            userName: sh.userName,
            email: sh.userEmail,
            type: 'stale_session',
            severity: 'high',
            message: `${sh.userName} has been productive for over 10 hours (${productiveHours.toFixed(1)}h). Requires automated logout audit.`,
            timestamp: sh.clockInTime,
          });
        }
      }
    });

    // 2. Scan historical/past shifts for mobile punches or discrepancies
    historicalShifts.forEach((sh) => {
      const hasMobile = sh.hasMobilePunches || 
                        sh.clockInDevice === 'mobile' || 
                        sh.clockOutDevice === 'mobile' || 
                        (sh.activities || []).some(act => act.device === 'mobile');
      if (hasMobile) {
        alerts.push({
          id: `alert-mobile-${sh.id}`,
          userId: sh.userId,
          userName: sh.userName,
          email: sh.userEmail,
          type: 'mobile_punch',
          severity: 'medium',
          message: `${sh.userName} performed mobile punches on shift date ${new Date(sh.clockInTime).toLocaleDateString()}`,
          timestamp: sh.clockInTime,
        });
      }
    });

    return alerts;
  }, [activeShifts, historicalShifts]);
}
