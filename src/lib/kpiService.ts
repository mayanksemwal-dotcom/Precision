import { db, handleFirestoreError, OperationType } from './firebase';
import { 
  collection, 
  doc, 
  setDoc, 
  getDocs, 
  query, 
  where, 
  writeBatch,
  getDoc,
  addDoc
} from 'firebase/firestore';
import { 
  DailyTarget, 
  DailyPerformance, 
  ScorecardRecord, 
  KpiAuditLog, 
  UserProfile 
} from '../types';
import { toast } from 'sonner';

/**
 * 2. Attendance Score based on defined slabs (15% Weight)
 * >=98% = 15
 * 95–97.99% = 13
 * 92–94.99% = 10
 * 90–91.99% = 7
 * <90% = 0
 */
export function getAttendanceScore(attendancePct: number): number {
  if (attendancePct >= 98) return 15;
  if (attendancePct >= 95) return 13;
  if (attendancePct >= 92) return 10;
  if (attendancePct >= 90) return 7;
  return 0;
}

/**
 * 3. Rating calculations based on user provided thresholds:
 * >=100 = Outstanding
 * 95 - 99.99 = Exceeds Expectations
 * 85 - 94.99 = Meets Expectations
 * 75 - 84.99 = Needs Improvement
 * Below 75 = Unsatisfactory
 * 
 * CRITICAL OVERRIDE:
 * If Quality < 95% OR Attendance < 90%, final rating cannot exceed "Meets Expectations".
 */
export function getRatingAndOverride(
  finalScore: number, 
  actualQuality: number, 
  actualAttendance: number
): { rating: string; isOverridden: boolean } {
  let initialRating = 'Unsatisfactory';
  
  if (finalScore >= 100) {
    initialRating = 'Outstanding';
  } else if (finalScore >= 95) {
    initialRating = 'Exceeds Expectations';
  } else if (finalScore >= 85) {
    initialRating = 'Meets Expectations';
  } else if (finalScore >= 75) {
    initialRating = 'Needs Improvement';
  } else {
    initialRating = 'Unsatisfactory';
  }

  const qualityViolation = actualQuality < 95;
  const attendanceViolation = actualAttendance < 90;
  const triggerOverride = qualityViolation || attendanceViolation;

  if (triggerOverride) {
    if (initialRating === 'Outstanding' || initialRating === 'Exceeds Expectations') {
      return { rating: 'Meets Expectations', isOverridden: true };
    }
  }

  return { rating: initialRating, isOverridden: false };
}

/**
 * 4. Helper to compute all scores dynamically (Productivity 30%, Quality 40%, Attendance 15%, APT 15%)
 */
export function computePerformance(
  paramsOrTarget: any,
  maybePerformance?: any
): {
  productivityScore: number;
  qualityScore: number;
  attendanceScore: number;
  aptScore: number;
  finalScore: number;
  rating: string;
  isOverridden: boolean;
} {
  let prodTarget = 1;
  let prodAchieved = 0;
  let aptTarget = 1;
  let aptAchieved = 0;
  let qualTarget = 95;
  let qualAchieved = 0;
  let attTarget = 100;
  let attAchieved = 100;
  let bonus = 0;
  let penalty = 0;

  if (maybePerformance) {
    // Backward compatibility for separate targets vs achievements
    const t = paramsOrTarget;
    const p = maybePerformance;

    prodTarget = t.productivityTarget ?? t.targetCalls ?? 40;
    prodAchieved = p.actualProductivity ?? p.actualCalls ?? 0;

    aptTarget = t.aptTarget ?? t.targetLeads ?? 360;
    aptAchieved = p.actualAptValue ?? p.actualLeads ?? 0;

    qualTarget = t.qualityTarget ?? t.targetQuality ?? 95;
    qualAchieved = p.actualQuality ?? p.productivityActual ?? p.qualityActual ?? 0;

    attTarget = t.attendanceTarget ?? t.targetAttendance ?? 100;
    attAchieved = p.actualAttendance ?? p.attendanceActual ?? 100;

    bonus = p.bonus ?? 0;
    penalty = p.penalty ?? 0;
  } else {
    // Single unified object style
    const r = paramsOrTarget;
    prodTarget = r.productivityTarget ?? 40;
    prodAchieved = r.actualProductivity ?? r.actualCalls ?? 0;

    aptTarget = r.aptTarget ?? 360;
    aptAchieved = r.actualAptValue ?? r.actualLeads ?? 0;

    qualTarget = r.qualityTarget ?? 95;
    qualAchieved = r.actualQuality ?? 0;

    attTarget = r.attendanceTarget ?? 100;
    attAchieved = r.actualAttendance ?? r.attendanceActual ?? 100;

    bonus = r.bonus ?? 0;
    penalty = r.penalty ?? 0;
  }

  const pTarget = Math.max(prodTarget, 1);
  const qTarget = Math.max(qualTarget, 1);

  // 1. Productivity Score (30%)
  const productivityScore = Math.min((prodAchieved / pTarget) * 30, 30);

  // 2. Quality Score (40%)
  const qualityScore = Math.min((qualAchieved / qTarget) * 40, 40);

  // 3. Attendance Score (15%)
  const attendanceScore = getAttendanceScore(attAchieved);

  // 4. APT Score (15%) - Lower is better.
  let aptScore = 0;
  if (aptAchieved <= aptTarget) {
    aptScore = 15;
  } else {
    const aTarget = Math.max(aptTarget, 1);
    const aAchieved = Math.max(aptAchieved, 1);
    aptScore = Math.max((aTarget / aAchieved) * 15, 0);
  }

  const rawFinalScore = productivityScore + qualityScore + attendanceScore + aptScore + bonus - penalty;
  const finalScore = Math.max(0, Math.min(100, Math.round(rawFinalScore * 100) / 100));

  const ratingResult = getRatingAndOverride(finalScore, qualAchieved, attAchieved);

  return {
    productivityScore: Math.round(productivityScore * 100) / 100,
    qualityScore: Math.round(qualityScore * 100) / 100,
    attendanceScore,
    aptScore: Math.round(aptScore * 100) / 100,
    finalScore,
    rating: ratingResult.rating,
    isOverridden: ratingResult.isOverridden
  };
}

/**
 * 5. Log audit trail for target/KPI score edits
 */
export async function logKpiChange(
  targetId: string,
  entityType: 'Target' | 'Performance',
  fieldName: string,
  oldValue: string,
  newValue: string,
  userId: string,
  userName: string
) {
  try {
    const logId = `log-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const logData: KpiAuditLog = {
      id: logId,
      targetId,
      entityType,
      fieldName,
      oldValue,
      newValue,
      updatedBy: userId,
      updatedByName: userName,
      updatedAt: new Date().toISOString()
    };
    await setDoc(doc(db, 'uploadAuditLogs', logId), logData);
  } catch (err) {
    console.error('Audit logging failed:', err);
  }
}

/**
 * 6. Generate Monthly Scorecard Insight
 */
export function generateScorecardRecord(
  agentId: string,
  agentName: string,
  yearMonth: string,
  performances: DailyPerformance[]
): ScorecardRecord {
  if (performances.length === 0) {
    return {
      id: `${agentId}_${yearMonth}`,
      agentId,
      agentName,
      yearMonth,
      averageScore: 0,
      overallRating: 'Unsatisfactory',
      promotionReadiness: 0,
      pipRecommendation: false,
      alertStatus: 'None',
      justification: 'No performance data exists for this period.',
      updatedAt: new Date().toISOString()
    };
  }

  const sumScore = performances.reduce((acc, curr) => acc + curr.finalScore, 0);
  const averageScore = Math.round((sumScore / performances.length) * 100) / 100;

  const avgQuality = performances.reduce((acc, curr) => acc + curr.actualQuality, 0) / performances.length;
  const avgAttendance = performances.reduce((acc, curr) => acc + curr.actualAttendance, 0) / performances.length;

  const rawRating = getRatingAndOverride(averageScore, avgQuality, avgAttendance);
  const overallRating = rawRating.rating;

  let promotionReadiness = 0;
  let pipRecommendation = false;
  let alertStatus: 'None' | 'Top Performer' | 'Bottom Performer' | 'Critical Attention' = 'None';
  let justification = '';

  if (averageScore >= 100) {
    promotionReadiness = 100;
    alertStatus = 'Top Performer';
    justification = `Outstanding average score of ${averageScore}%. Demonstrates continuous process mastery, perfect quality scores, and exemplary attendance adherence. Highly recommended for immediate growth.`;
  } else if (averageScore >= 95) {
    promotionReadiness = 85;
    alertStatus = 'Top Performer';
    justification = `Average score of ${averageScore}%. Exceeds standard expectations across critical parameters. Strong candidate for internal mentoring or team leader fast-track selection.`;
  } else if (averageScore >= 85) {
    promotionReadiness = 60;
    justification = `Meets expectations at ${averageScore}%. Performance is steady and consistent. Safe, reliable track, and could explore minor development areas to unlock promotion readiness.`;
  } else if (averageScore >= 75) {
    promotionReadiness = 20;
    alertStatus = 'Bottom Performer';
    justification = `Needs Improvement with average metrics at ${averageScore}%. Several sub-targets are routinely missed. Focus should be placed on targeted guidance before leadership consideration.`;
  } else {
    promotionReadiness = 0;
    pipRecommendation = true;
    alertStatus = 'Critical Attention';
    justification = `Critical performance of ${averageScore}%. Recommended for formal Performance Improvement Plan (PIP). Core quality or productivity metrics are substantially below target requirements.`;
  }

  if (rawRating.isOverridden) {
    promotionReadiness = Math.min(promotionReadiness, 45);
    justification += ' [CRITICAL LIMITATION: Target caps applied due to critical Quality (<95%) or Adherence (<90%) exceptions].';
  }

  return {
    id: `${agentId}_${yearMonth}`,
    agentId,
    agentName,
    yearMonth,
    averageScore,
    overallRating,
    promotionReadiness,
    pipRecommendation,
    alertStatus,
    justification,
    updatedAt: new Date().toISOString()
  };
}

/**
 * 7. Copy targets forward helper (adapted to unified uploads format)
 */
export async function copyPreviousDayTargets(
  fromRawDate: string,
  toRawDate: string,
  updatedBy: string
): Promise<number> {
  try {
    const q = query(collection(db, 'dailyPerformanceUploads'), where('date', '==', fromRawDate));
    const snap = await getDocs(q);
    if (snap.empty) {
      throw new Error(`No daily records found on ${fromRawDate} to copy from.`);
    }

    const batch = writeBatch(db);
    let count = 0;

    snap.docs.forEach((docSnap) => {
      const data = docSnap.data() as DailyPerformance;
      const targetId = `${toRawDate}_${data.agentId}`;
      const newUpload: DailyPerformance = {
        ...data,
        id: targetId,
        date: toRawDate,
        updatedBy,
        updatedAt: new Date().toISOString()
      };
      
      batch.set(doc(db, 'dailyPerformanceUploads', targetId), newUpload);
      count++;
    });

    await batch.commit();
    return count;
  } catch (err: any) {
    throw new Error(err.message || String(err));
  }
}

/**
 * 8. Seed real performance data for a professional dashboard preview out-of-the-box
 */
export async function bootstrapKpiHistoricalData(allUsers: UserProfile[], currentUserId: string) {
  try {
    const agents = allUsers.filter(u => u.role === 'AGENT');
    if (agents.length === 0) {
      console.log('No agents found in user list to bootstrap KPIs.');
      return;
    }

    const testQuery = query(collection(db, 'dailyPerformanceUploads'));
    const testSnap = await getDocs(testQuery);
    if (!testSnap.empty) {
      console.log('Daily performance credentials database already seeded.');
      return;
    }

    toast.info('Seeding optimized historical scoring database...');
    const batch = writeBatch(db);

    const processes = ['NCC', 'QC', 'Inbound Ops', 'NCC Digital'];
    const dates = [
      '2026-05-22',
      '2026-05-23',
      '2026-05-24',
      '2026-05-25',
      '2026-05-26',
      '2026-05-27',
      '2026-05-28'
    ];

    let seedCount = 0;
    
    for (let agentIndex = 0; agentIndex < agents.length; agentIndex++) {
      const agent = agents[agentIndex];
      const process = processes[agentIndex % processes.length];

      const productivityTarget = 120 + (agentIndex % 3) * 10; 
      const aptTarget = 240; // 240 seconds (4 minutes)
      const qualityTarget = 95 + (agentIndex % 2) * 3; 
      const attendanceTarget = 95; 

      for (let dIndex = 0; dIndex < dates.length; dIndex++) {
        const date = dates[dIndex];
        const targetId = `${date}_${agent.uid}`;

        let actualProductivity = productivityTarget;
        let actualAptValue = aptTarget - 20; // better than target
        let actualQuality = qualityTarget;
        let actualAttendance = attendanceTarget;
        let bonus = 0;
        let penalty = 0;

        if (dIndex === 1) {
          actualProductivity = Math.round(productivityTarget * 0.85);
          actualAptValue = aptTarget + 40; // worse than target
          actualQuality = qualityTarget - 2;
          actualAttendance = 92;
        } else if (dIndex === 3) {
          actualProductivity = Math.round(productivityTarget * 1.15);
          actualAptValue = aptTarget - 30; // better than target
          actualQuality = 100;
          actualAttendance = 100;
          bonus = 5;
        } else if (dIndex === 4 && agentIndex === 0) {
          actualProductivity = productivityTarget + 10;
          actualAptValue = aptTarget + 10;
          actualQuality = 93; 
          actualAttendance = 96;
        } else if (dIndex === 5 && agentIndex === 1) {
          actualProductivity = productivityTarget + 5;
          actualAptValue = aptTarget - 10;
          actualQuality = 98;
          actualAttendance = 88; 
        } else {
          actualProductivity = Math.round(productivityTarget * (0.95 + Math.random() * 0.1));
          actualAptValue = Math.round(aptTarget + (Math.random() * 60 - 30));
          actualQuality = Math.min(100, Math.round(qualityTarget + (Math.random() * 4 - 1)));
          actualAttendance = Math.min(100, Math.round(94 + Math.random() * 6));
        }

        const calculated = computePerformance({
          productivityTarget,
          actualProductivity,
          aptTarget,
          actualAptValue,
          qualityTarget,
          actualQuality,
          attendanceTarget,
          actualAttendance,
          bonus,
          penalty
        });

        const perfDoc: DailyPerformance = {
          id: targetId,
          date,
          agentId: agent.uid,
          agentName: agent.name,
          process,
          productivityTarget,
          aptTarget,
          qualityTarget,
          attendanceTarget,
          actualProductivity,
          actualApt: 'Excellent',
          actualAptValue,
          actualQuality,
          actualAttendance,
          bonus,
          penalty,
          remarks: calculated.isOverridden ? 'Subject to scorecard cap due to Quality/Adherence limits.' : 'Normal daily entry.',
          ...calculated,
          isLocked: dIndex < 5, 
          updatedBy: currentUserId,
          updatedAt: new Date().toISOString()
        };
        batch.set(doc(db, 'dailyPerformanceUploads', targetId), perfDoc);
        seedCount++;
      }

      if (agentIndex < 3) {
        const scorecardId = `${agent.uid}_2026-05`;
        const sumScore = 90 + agentIndex * 2;
        const scorecard: ScorecardRecord = {
          id: scorecardId,
          agentId: agent.uid,
          agentName: agent.name,
          yearMonth: '2026-05',
          averageScore: sumScore,
          overallRating: sumScore >= 95 ? 'Outstanding' : 'Exceeds Expectations',
          promotionReadiness: sumScore >= 95 ? 100 : 85,
          pipRecommendation: false,
          alertStatus: 'None',
          justification: 'Automated seed scorecard showing exceeding expectations across standard parameters.',
          updatedAt: new Date().toISOString(),
          reviewerComments: 'Solid contributor maintaining NCC standards cleanly.',
          selfScorecardComments: 'I feel I have done a great job this month!'
        };
        batch.set(doc(db, 'scorecards', scorecardId), scorecard);
      }
    }

    await batch.commit();
    toast.success(`Success! Bootstrap populated ${seedCount} dynamic scoring database entries.`);
  } catch (err: any) {
    console.error('Failed to bootstrap kpi data:', err);
  }
}

export const bootstrapKpiData = bootstrapKpiHistoricalData;
