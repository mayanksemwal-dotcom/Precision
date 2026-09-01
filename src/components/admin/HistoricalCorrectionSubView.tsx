import React, { useState, useEffect, useMemo, useRef } from 'react';
import { db, getDocsCacheFirst } from '../../lib/firebase';
import { 
  collection, 
  getDocs, 
  doc, 
  setDoc,
  getDoc,
  writeBatch, 
  query, 
  orderBy, 
  limit, 
  startAfter,
  getCountFromServer,
  addDoc,
  where
} from 'firebase/firestore';
import { 
  RotateCcw, 
  ShieldAlert, 
  CheckCircle2, 
  AlertTriangle, 
  Search, 
  Filter, 
  Calendar, 
  Clock, 
  User, 
  Activity, 
  CheckSquare, 
  Square, 
  History, 
  RefreshCw, 
  FileText, 
  Lock, 
  Sparkles,
  ArrowRight,
  Eye,
  X,
  Play,
  Pause,
  AlertCircle,
  HelpCircle,
  Database,
  Download
} from 'lucide-react';
import { toast } from 'sonner';
import { UserProfile, ShiftEvent } from '../../types';
import { appendShiftEvent } from '../../lib/shiftLedger';
import { calculateShiftMetrics, calculateAttendanceDate } from '../../lib/tmsCalculationEngine';

interface HistoricalCorrectionSubViewProps {
  user: UserProfile;
  adminTheme: 'light' | 'dark';
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export interface AttendanceGroup {
  id: string; // userId_attendanceDate
  userId: string;
  userName: string;
  userEmail: string;
  attendanceDate: string; // YYYY-MM-DD
  firstClockIn: string;
  lastClockOut: string | null;
  sessionCount: number;
  
  // Recalculated aggregate daily metrics
  recalcProductiveMs: number;
  recalcBreakMs: number;
  recalcConnectedMs: number;
  recalcUtilization: number;
  idleGapsMs: number;

  // Stored aggregate daily metrics
  storedProductiveMins: number;
  storedBreakMins: number;
  storedUtilization: number;

  // Correction Eligibility Status
  status: 'CORRECTABLE' | 'ALREADY HEALTHY' | 'HIGH PRODUCTIVE' | 'INCOMPLETE / REVIEW' | 'ANOMALY' | 'PRODUCTIVE_TIME_OVER_10H';
  originalShifts: any[];
}

export interface CorrectionReportItem {
  userName: string;
  attendanceDate: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  message: string;
  originalOut?: string;
  correctedOut?: string;
  productiveDelta?: number;
}

export interface HistoricalCorrectionJob {
  id?: string;
  jobId: string;
  status: 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED' | 'ERROR';
  startDate: string;
  endDate: string;
  lastProcessedDocId: string | null;
  lastProcessedClockInTime: string | null;
  processedCount: number;
  autoCorrectedCount: number;
  alreadyCorrectedCount: number;
  healthyCount: number;
  reviewRequiredCount: number;
  highTimeCount: number;
  over10hCount?: number;
  errorCount: number;
  totalCandidateCount: number;
  currentBatch: number;
  updatedAt: string;
  startedByUid: string;
  startedByEmail: string;
  autoCorrectEnabled: boolean;
  lastError?: string | null;
}

const sanitizeJobData = (jobObj: HistoricalCorrectionJob): Record<string, any> => {
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(jobObj)) {
    if (v !== undefined) {
      clean[k] = v;
    }
  }
  return clean;
};

export function HistoricalCorrectionSubView({
  user,
  adminTheme,
  logAdminEvent
}: HistoricalCorrectionSubViewProps) {
  // Persistent Scanner Job State
  const [activeJob, setActiveJob] = useState<HistoricalCorrectionJob | null>(null);
  const [autoCorrectEnabled, setAutoCorrectEnabled] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
  const [docsPerSec, setDocsPerSec] = useState<number>(0);
  const [estRemainingSec, setEstRemainingSec] = useState<number>(0);

  // Scanner state
  const [isScanning, setIsScanning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [scanCompleted, setScanCompleted] = useState(false);
  const [totalShiftsScanned, setTotalShiftsScanned] = useState(0);
  const [totalShiftsInDb, setTotalShiftsInDb] = useState(0);

  // Grouped results (keyed by userId_attendanceDate)
  const [groups, setGroups] = useState<Record<string, AttendanceGroup>>({});
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());

  // Interactive filters
  const [startDate, setStartDate] = useState('2026-06-01');
  const [endDate, setEndDate] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Modals / Overlays
  const [previewGroup, setPreviewGroup] = useState<AttendanceGroup | null>(null);
  const [ledgerGroup, setLedgerGroup] = useState<AttendanceGroup | null>(null);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [isCorrecting, setIsCorrecting] = useState(false);
  const [correctionReport, setCorrectionReport] = useState<CorrectionReportItem[] | null>(null);

  // Refs for scan lifecycle
  const lastDocRef = useRef<any>(null);
  const isPausedRef = useRef(false);
  const isCancelledRef = useRef(false);
  const scanLoopActive = useRef(false);
  const currentJobRef = useRef<HistoricalCorrectionJob | null>(null);
  const scanStartTimeRef = useRef<number>(0);

  // Calculate status statistics
  const stats = useMemo(() => {
    const values = Object.values(groups) as AttendanceGroup[];
    const total = values.length;
    let correctable = 0;
    let alreadyHealthy = 0;
    let highProductive = 0;
    let over10h = 0;
    let incompleteReview = 0;
    let anomaly = 0;

    values.forEach(g => {
      if (g.status === 'CORRECTABLE') correctable++;
      else if (g.status === 'ALREADY HEALTHY') alreadyHealthy++;
      else if (g.status === 'HIGH PRODUCTIVE') highProductive++;
      else if (g.status === 'PRODUCTIVE_TIME_OVER_10H') over10h++;
      else if (g.status === 'INCOMPLETE / REVIEW') incompleteReview++;
      else if (g.status === 'ANOMALY') anomaly++;
    });

    return { total, correctable, alreadyHealthy, highProductive, over10h, incompleteReview, anomaly };
  }, [groups]);

  // Apply visual theme mappings
  const containerBg = adminTheme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const headerBg = adminTheme === 'dark' ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200';
  const textPrimary = adminTheme === 'dark' ? 'text-slate-100' : 'text-slate-800';
  const textSecondary = adminTheme === 'dark' ? 'text-slate-400' : 'text-slate-500';
  const inputBg = adminTheme === 'dark' ? 'bg-slate-950 border-slate-850 text-slate-100' : 'bg-white border-slate-200 text-slate-800';
  const cardBg = adminTheme === 'dark' ? 'bg-slate-950 border-slate-850' : 'bg-slate-50/50 border-slate-200/60';

  // Sort and filter groups for table view
  const filteredGroups = useMemo(() => {
    let list = Object.values(groups) as AttendanceGroup[];

    // Apply text search (name, email)
    if (searchTerm.trim() !== '') {
      const s = searchTerm.toLowerCase();
      list = list.filter(g => 
        g.userName.toLowerCase().includes(s) || 
        g.userEmail.toLowerCase().includes(s) ||
        g.userId.toLowerCase().includes(s)
      );
    }

    // Apply status filter
    if (statusFilter !== 'ALL') {
      if (statusFilter === 'NEEDS_CORRECTION') {
        list = list.filter(g => g.status === 'CORRECTABLE');
      } else {
        list = list.filter(g => g.status === statusFilter);
      }
    }

    // Date range filtering
    if (startDate !== '') {
      list = list.filter(g => g.attendanceDate >= startDate);
    }
    if (endDate !== '') {
      list = list.filter(g => g.attendanceDate <= endDate);
    }

    // Sort chronologically by attendanceDate desc, then userName
    return list.sort((a, b) => {
      const dateCompare = b.attendanceDate.localeCompare(a.attendanceDate);
      if (dateCompare !== 0) return dateCompare;
      return a.userName.localeCompare(b.userName);
    });
  }, [groups, searchTerm, statusFilter, startDate, endDate]);

  // Fetch initial total count of documents in DB and search for active job on mount
  useEffect(() => {
    const fetchCountAndActiveJob = async () => {
      try {
        const START_DATE_ISO = '2026-05-31T18:30:00.000Z';
        const qCount = query(
          collection(db, 'tmsShifts'),
          where('clockInTime', '>=', START_DATE_ISO)
        );
        const countSnap = await getCountFromServer(qCount);
        setTotalShiftsInDb(countSnap.data().count);

        if (user?.uid) {
          // Check localStorage first for instant UI restoration
          try {
            const cachedJobRaw = localStorage.getItem(`tms_active_job_${user.uid}`);
            if (cachedJobRaw) {
              const cachedJob = JSON.parse(cachedJobRaw) as HistoricalCorrectionJob;
              setActiveJob(cachedJob);
              currentJobRef.current = cachedJob;
              setTotalShiftsScanned(cachedJob.processedCount || 0);
              if (cachedJob.autoCorrectEnabled !== undefined) {
                setAutoCorrectEnabled(cachedJob.autoCorrectEnabled);
              }
            }
          } catch (e) {
            console.warn('Could not read cached job from localStorage:', e);
          }

          const qJobs = query(
            collection(db, 'tmsHistoricalCorrectionJobs'),
            where('startedByUid', '==', user.uid),
            where('status', 'in', ['RUNNING', 'PAUSED', 'ERROR']),
            orderBy('updatedAt', 'desc'),
            limit(1)
          );
          const jobSnap = await getDocs(qJobs);
          if (!jobSnap.empty) {
            const jobData = { id: jobSnap.docs[0].id, ...jobSnap.docs[0].data() } as HistoricalCorrectionJob;
            setActiveJob(jobData);
            currentJobRef.current = jobData;
            setTotalShiftsScanned(jobData.processedCount || 0);
            if (jobData.autoCorrectEnabled !== undefined) {
              setAutoCorrectEnabled(jobData.autoCorrectEnabled);
            }
            if (jobData.status === 'PAUSED' || jobData.status === 'RUNNING') {
              setIsPaused(true);
            }
            if (jobData.lastError) {
              setJobError(jobData.lastError);
            }
            localStorage.setItem(`tms_active_job_${user.uid}`, JSON.stringify(jobData));
            toast.info(`Previous scan job found (${(jobData.processedCount || 0).toLocaleString()} records processed). Resume or start fresh.`);
          }
        }
      } catch (err) {
        console.warn('Error during scanner initialization:', err);
      }
    };
    fetchCountAndActiveJob();
  }, [user?.uid]);

  // Classify grouped shifts based on the rigorous recovery rules
  const classifyGroup = (
    originalShifts: any[],
    recalcProductiveMs: number,
    recalcBreakMs: number,
    recalcConnectedMs: number
  ): 'CORRECTABLE' | 'ALREADY HEALTHY' | 'HIGH PRODUCTIVE' | 'INCOMPLETE / REVIEW' | 'ANOMALY' | 'PRODUCTIVE_TIME_OVER_10H' => {
    if (!originalShifts || originalShifts.length === 0) return 'INCOMPLETE / REVIEW';

    // Check if already corrected by 10h cap
    const isAlreadyCap10hCorrected = originalShifts.some(sh => sh.correctedByOver10h || sh.over10hCorrectionVersion === 'v1');
    if (isAlreadyCap10hCorrected) {
      return 'ALREADY HEALTHY';
    }

    // Check for explicit exception markers (Section 7D)
    const hasExplicitException = originalShifts.some(sh => 
      sh.halfDay || sh.leave || sh.isApprovedException || sh.manualAdjustment || sh.overrideReason || sh.supervisorOverride || sh.hasException
    );
    if (hasExplicitException) {
      return 'INCOMPLETE / REVIEW';
    }

    // Sort chronologically by clockInTime
    const sortedShifts = [...originalShifts].sort((a, b) => {
      const timeA = a.clockInTime ? new Date(a.clockInTime).getTime() : 0;
      const timeB = b.clockInTime ? new Date(b.clockInTime).getTime() : 0;
      return timeA - timeB;
    });

    // 1. Check for ANOMALY (Chronological or metadata contradictions)
    let hasChronologyError = false;
    let hasOverlap = false;

    for (let i = 0; i < sortedShifts.length; i++) {
      const sh = sortedShifts[i];
      const inMs = sh.clockInTime ? new Date(sh.clockInTime).getTime() : 0;
      const outMs = sh.clockOutTime ? new Date(sh.clockOutTime).getTime() : 0;

      if (!inMs || isNaN(inMs)) {
        return 'ANOMALY';
      }

      if (sh.status === 'COMPLETED' || sh.clockOutTime) {
        if (!outMs || isNaN(outMs)) {
          return 'ANOMALY';
        }
        if (outMs < inMs) {
          hasChronologyError = true;
        }
      }

      // Check overlap with subsequent shift
      if (i < sortedShifts.length - 1) {
        const nextSh = sortedShifts[i + 1];
        const nextInMs = nextSh.clockInTime ? new Date(nextSh.clockInTime).getTime() : 0;
        if (outMs > 0 && nextInMs > 0 && nextInMs < outMs) {
          hasOverlap = true;
        }
      }
    }

    // Extreme total elapsed duration (> 18 hours total sessions)
    const totalElapsedMs = originalShifts.reduce((acc, sh) => {
      const inMs = sh.clockInTime ? new Date(sh.clockInTime).getTime() : 0;
      const outMs = sh.clockOutTime ? new Date(sh.clockOutTime).getTime() : 0;
      return acc + (outMs > inMs ? (outMs - inMs) : 0);
    }, 0);

    if (totalElapsedMs > 18 * 60 * 60 * 1000) {
      return 'ANOMALY';
    }

    if (hasChronologyError || hasOverlap) {
      return 'ANOMALY';
    }

    // 2. Check for INCOMPLETE / REVIEW
    // If we have shifts but no activity sequence is present, or an active ongoing session exists
    const hasActivities = originalShifts.some(sh => sh.activities && sh.activities.length > 0);
    if (!hasActivities) {
      return 'INCOMPLETE / REVIEW';
    }

    const hasOngoing = originalShifts.some(sh => sh.status !== 'COMPLETED' && !sh.clockOutTime);
    if (hasOngoing) {
      return 'INCOMPLETE / REVIEW';
    }

    // 3. Productive time evaluation
    const productiveMins = recalcProductiveMs / 60000;
    if (productiveMins > 600) {
      return 'PRODUCTIVE_TIME_OVER_10H';
    } else if (productiveMins > 480) {
      return 'HIGH PRODUCTIVE';
    } else if (productiveMins === 480) {
      return 'ALREADY HEALTHY';
    } else {
      // Under target (productiveMins < 480)
      // Verify we have a valid latest session to extend
      const latestSession = sortedShifts[sortedShifts.length - 1];
      if (!latestSession || !latestSession.clockOutTime) {
        return 'INCOMPLETE / REVIEW';
      }
      return 'CORRECTABLE';
    }
  };

  // Start new scanner job from scratch
  const startNewScan = async () => {
    setIsScanning(true);
    setIsPaused(false);
    setScanCompleted(false);
    setGroups({});
    setSelectedGroupIds(new Set());
    lastDocRef.current = null;
    isPausedRef.current = false;
    isCancelledRef.current = false;
    scanLoopActive.current = true;

    const newJobId = `job_${user.uid}_${Date.now()}`;
    const newJob: HistoricalCorrectionJob = {
      jobId: newJobId,
      status: 'RUNNING',
      startDate: '2026-06-01',
      endDate: endDate || 'Present',
      lastProcessedDocId: null,
      lastProcessedClockInTime: null,
      processedCount: 0,
      autoCorrectedCount: 0,
      alreadyCorrectedCount: 0,
      healthyCount: 0,
      reviewRequiredCount: 0,
      highTimeCount: 0,
      errorCount: 0,
      totalCandidateCount: 0,
      currentBatch: 0,
      updatedAt: new Date().toISOString(),
      startedByUid: user.uid,
      startedByEmail: user.email || user.name,
      autoCorrectEnabled: autoCorrectEnabled
    };

    setActiveJob(newJob);
    currentJobRef.current = newJob;
    setJobError(null);
    setTotalShiftsScanned(0);

    toast.info(`Starting new scan job (Auto-Correct: ${autoCorrectEnabled ? 'ENABLED' : 'DRY RUN'})`);
    await runScanLoop(newJob);
  };

  const pauseScan = async () => {
    isPausedRef.current = true;
    setIsPaused(true);
    setIsScanning(false);

    if (currentJobRef.current) {
      const updated = {
        ...currentJobRef.current,
        status: 'PAUSED' as const,
        updatedAt: new Date().toISOString()
      };
      currentJobRef.current = updated;
      setActiveJob(updated);
      try {
        await setDoc(doc(db, 'tmsHistoricalCorrectionJobs', updated.jobId), sanitizeJobData(updated), { merge: true });
      } catch (e) {
        console.warn('Failed to save paused job state:', e);
      }
    }
    toast.info('Scan paused. Checkpoint saved to Firestore.');
  };

  const resumeScan = async () => {
    isPausedRef.current = false;
    setIsPaused(false);
    setIsScanning(true);
    toast.info('Resuming historical scan from saved checkpoint...');
    await runScanLoop(currentJobRef.current || activeJob || undefined);
  };

  const stopScan = async () => {
    isCancelledRef.current = true;
    isPausedRef.current = false;
    setIsPaused(false);
    setIsScanning(false);

    if (currentJobRef.current) {
      const updated = {
        ...currentJobRef.current,
        status: 'STOPPED' as const,
        updatedAt: new Date().toISOString()
      };
      currentJobRef.current = updated;
      setActiveJob(updated);
      try {
        await setDoc(doc(db, 'tmsHistoricalCorrectionJobs', updated.jobId), sanitizeJobData(updated), { merge: true });
      } catch (e) {
        console.warn('Failed to save stopped job state:', e);
      }
    }
    toast.info('Scan stopped by administrator.');
  };

  const runScanLoop = async (jobToRun?: HistoricalCorrectionJob) => {
    const PAGE_SIZE = 250;
    const START_DATE_ISO = '2026-05-31T18:30:00.000Z';
    const nowMs = Date.now();

    let job = jobToRun || currentJobRef.current;
    if (!job) {
      const jobId = `job_${user.uid}_${Date.now()}`;
      job = {
        jobId,
        status: 'RUNNING',
        startDate: '2026-06-01',
        endDate: endDate || 'Present',
        lastProcessedDocId: null,
        lastProcessedClockInTime: null,
        processedCount: 0,
        autoCorrectedCount: 0,
        alreadyCorrectedCount: 0,
        healthyCount: 0,
        reviewRequiredCount: 0,
        highTimeCount: 0,
        errorCount: 0,
        totalCandidateCount: 0,
        currentBatch: 0,
        updatedAt: new Date().toISOString(),
        startedByUid: user.uid,
        startedByEmail: user.email || user.name,
        autoCorrectEnabled: autoCorrectEnabled
      };
      scanStartTimeRef.current = Date.now();
    } else {
      job.status = 'RUNNING';
      job.autoCorrectEnabled = autoCorrectEnabled;
      delete job.lastError;
      if (scanStartTimeRef.current === 0) {
        scanStartTimeRef.current = Date.now();
      }
    }

    currentJobRef.current = job;
    setActiveJob({ ...job });
    setJobError(null);

    try {
      const cleanJob = sanitizeJobData(job);
      localStorage.setItem(`tms_active_job_${user.uid}`, JSON.stringify(cleanJob));
      await setDoc(doc(db, 'tmsHistoricalCorrectionJobs', job.jobId), cleanJob, { merge: true });
    } catch (err) {
      console.warn('Could not persist scan job checkpoint:', err);
    }

    setIsScanning(true);
    setIsPaused(false);
    isPausedRef.current = false;
    isCancelledRef.current = false;
    scanLoopActive.current = true;

    let cursorDocSnap: any = null;

    try {
      while (!isCancelledRef.current && !isPausedRef.current) {
        let q;

        if (!cursorDocSnap && job.lastProcessedDocId) {
          try {
            cursorDocSnap = await getDoc(doc(db, 'tmsShifts', job.lastProcessedDocId));
          } catch (e) {
            console.warn('Could not fetch lastProcessedDocId snap:', e);
          }
        }

        if (cursorDocSnap && cursorDocSnap.exists && cursorDocSnap.exists()) {
          q = query(
            collection(db, 'tmsShifts'),
            where('clockInTime', '>=', START_DATE_ISO),
            orderBy('clockInTime', 'desc'),
            startAfter(cursorDocSnap),
            limit(PAGE_SIZE)
          );
        } else if (job.lastProcessedClockInTime) {
          q = query(
            collection(db, 'tmsShifts'),
            where('clockInTime', '>=', START_DATE_ISO),
            orderBy('clockInTime', 'desc'),
            startAfter(job.lastProcessedClockInTime),
            limit(PAGE_SIZE)
          );
        } else {
          q = query(
            collection(db, 'tmsShifts'),
            where('clockInTime', '>=', START_DATE_ISO),
            orderBy('clockInTime', 'desc'),
            limit(PAGE_SIZE)
          );
        }

        // IndexedDB optimization for historical read-heavy data
        const snap = await getDocsCacheFirst(q, 'adminHistoricalCorrectionScan_tmsShifts');

        if (snap.empty) {
          job.status = 'COMPLETED';
          job.updatedAt = new Date().toISOString();
          const cleanJob = sanitizeJobData(job);
          localStorage.setItem(`tms_active_job_${user.uid}`, JSON.stringify(cleanJob));
          await setDoc(doc(db, 'tmsHistoricalCorrectionJobs', job.jobId), cleanJob, { merge: true });
          setActiveJob({ ...job });
          setIsScanning(false);
          setScanCompleted(true);
          toast.success(`Historical scan complete! Processed ${job.processedCount.toLocaleString()} records.`);
          break;
        }

        const docs = snap.docs;
        cursorDocSnap = docs[docs.length - 1];

        job.currentBatch += 1;
        job.processedCount += docs.length;

        const localBatchGroups: Record<string, AttendanceGroup> = {};

        for (const docSnap of docs) {
          const rawSh = { id: docSnap.id, ...(docSnap.data() as any) } as any;
          if (!rawSh.clockInTime || !rawSh.userId) continue;

          const attDate = calculateAttendanceDate(rawSh.clockInTime);
          if (attDate < '2026-06-01') continue;

          const key = `${rawSh.userId}_${attDate}`;
          if (!localBatchGroups[key]) {
            localBatchGroups[key] = {
              id: key,
              userId: rawSh.userId,
              userName: rawSh.userName || rawSh.employeeName || 'Unknown User',
              userEmail: rawSh.userEmail || rawSh.email || 'N/A',
              attendanceDate: attDate,
              firstClockIn: rawSh.clockInTime,
              lastClockOut: rawSh.clockOutTime || null,
              sessionCount: 0,
              recalcProductiveMs: 0,
              recalcBreakMs: 0,
              recalcConnectedMs: 0,
              recalcUtilization: 0,
              idleGapsMs: 0,
              storedProductiveMins: 0,
              storedBreakMins: 0,
              storedUtilization: 0,
              status: 'ALREADY HEALTHY',
              originalShifts: []
            };
          }
          localBatchGroups[key].originalShifts.push(rawSh);
        }

        // Write batch collector for corrections (chunked to max 150 ops per batch)
        const pendingOps: Array<{ ref: any; data: any; options?: any }> = [];

        for (const key of Object.keys(localBatchGroups)) {
          const g = localBatchGroups[key];
          g.originalShifts.sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());
          g.sessionCount = g.originalShifts.length;
          g.firstClockIn = g.originalShifts[0].clockInTime;

          const lastShift = g.originalShifts[g.sessionCount - 1];
          g.lastClockOut = lastShift.clockOutTime || null;

          let totalProdMs = 0;
          let totalBreakMs = 0;
          let sumStoredProd = 0;
          let sumStoredBreak = 0;
          let maxStoredUt = 0;

          g.originalShifts.forEach(sh => {
            const m = calculateShiftMetrics(sh, nowMs);
            totalProdMs += m.productiveMs;
            totalBreakMs += m.breakMs;
            sumStoredProd += sh.productiveMinutes || 0;
            sumStoredBreak += sh.breakMinutes || 0;
            if ((sh.utilization || 0) > maxStoredUt) maxStoredUt = sh.utilization || 0;
          });

          g.recalcProductiveMs = totalProdMs;
          g.recalcBreakMs = totalBreakMs;
          g.recalcConnectedMs = totalProdMs + totalBreakMs;
          g.recalcUtilization = Math.round(((totalProdMs / 60000) / 480) * 100 * 10) / 10;
          g.storedProductiveMins = sumStoredProd;
          g.storedBreakMins = sumStoredBreak;
          g.storedUtilization = maxStoredUt;

          const status = classifyGroup(g.originalShifts, totalProdMs, totalBreakMs, totalProdMs + totalBreakMs);
          g.status = status;

          if (status === 'ALREADY HEALTHY') {
            job.healthyCount += 1;
          } else if (status === 'HIGH PRODUCTIVE') {
            job.highTimeCount += 1;
          } else if (status === 'PRODUCTIVE_TIME_OVER_10H') {
            job.over10hCount = (job.over10hCount || 0) + 1;
          } else if (status === 'INCOMPLETE / REVIEW' || status === 'ANOMALY') {
            job.reviewRequiredCount += 1;
          } else if (status === 'CORRECTABLE') {
            job.totalCandidateCount += 1;

            if (autoCorrectEnabled) {
              const sh = lastShift;
              const auditId = `AUTO_CORRECTION_${sh.id}_v1`;

              // Idempotency check: verify if already corrected via ledger event or flag
              const isAlreadyCorrected = sh.shiftEventLedger?.some((e: any) => 
                e.source === 'Auto-Correction Scanner Engine' || e.performedBy === 'HISTORICAL_CORRECTION_ENGINE'
              );

              if (isAlreadyCorrected) {
                job.alreadyCorrectedCount += 1;
                g.status = 'ALREADY HEALTHY';
              } else {
                const totalProdMins = totalProdMs / 60000;
                const deficitMins = Math.max(0, 480 - totalProdMins);

                if (deficitMins > 0 && sh && sh.clockOutTime) {
                  const origOutMs = new Date(sh.clockOutTime).getTime();
                  const correctedOutMs = origOutMs + (deficitMins * 60000);
                  const correctedOutTime = new Date(correctedOutMs).toISOString();

                  const updatedShiftObj = {
                    ...sh,
                    clockOutTime: correctedOutTime,
                    status: 'COMPLETED'
                  };
                  const newMetrics = calculateShiftMetrics(updatedShiftObj, nowMs);

                  const finalProdMins = newMetrics.productiveMs / 60000;
                  const finalBrkMins = newMetrics.breakMs / 60000;
                  const finalDurMins = newMetrics.elapsedMs / 60000;

                  const auditDoc = {
                    correctionId: auditId,
                    shiftId: sh.id,
                    userId: sh.userId,
                    userName: sh.userName || sh.employeeName || 'N/A',
                    attendanceDate: g.attendanceDate,
                    correctionType: 'AUTO_HISTORICAL_CORRECTION',
                    originalClockInTime: sh.clockInTime,
                    originalClockOutTime: sh.clockOutTime,
                    correctedClockOutTime: correctedOutTime,
                    originalProductiveMinutes: sh.productiveMinutes || 0,
                    correctedProductiveMinutes: finalProdMins,
                    originalBreakMinutes: sh.breakMinutes || 0,
                    correctedBreakMinutes: finalBrkMins,
                    originalUtilization: sh.utilization || 0,
                    correctedUtilization: newMetrics.utilization,
                    deficitMinutes: deficitMins,
                    reason: 'Deterministic Auto Historical Correction to 8h productive target',
                    classification: 'CORRECTABLE',
                    engineVersion: 'v1',
                    correctedAt: new Date().toISOString(),
                    correctedBy: 'HISTORICAL_CORRECTION_ENGINE',
                    jobId: job.jobId
                  };

                  const updatedLedger = appendShiftEvent(sh.shiftEventLedger || [], sh, {
                    eventType: 'MANUAL_CORRECTION',
                    timestamp: new Date().toISOString(),
                    performedBy: 'HISTORICAL_CORRECTION_ENGINE',
                    source: 'Auto-Correction Scanner Engine',
                    reason: 'Auto Clock-Out Target 8h Correction',
                    remarks: `Clock-out corrected to 8h target. Productive extended by ${deficitMins.toFixed(1)} mins.`
                  });

                  const shiftUpdates = {
                    clockOutTime: correctedOutTime,
                    productiveMinutes: finalProdMins,
                    breakMinutes: finalBrkMins,
                    productiveMs: newMetrics.productiveMs,
                    breakMs: newMetrics.breakMs,
                    totalShiftMs: newMetrics.elapsedMs,
                    shiftDuration: finalDurMins,
                    utilization: newMetrics.utilization,
                    finalUtilization: newMetrics.utilization,
                    totalProductiveTime: newMetrics.productiveStr,
                    totalBreakTime: newMetrics.breakStr,
                    totalShiftTime: newMetrics.elapsedStr,
                    status: 'COMPLETED',
                    shiftEventLedger: updatedLedger,
                    version: (sh.version || 1) + 1
                  };

                  pendingOps.push({ ref: doc(db, 'tmsHistoricalCorrections', auditId), data: auditDoc });
                  pendingOps.push({ ref: doc(db, 'tmsShifts', sh.id), data: shiftUpdates, options: { merge: true } });

                  job.autoCorrectedCount += 1;
                  g.status = 'ALREADY HEALTHY';
                  g.storedProductiveMins = 480;
                }
              }
            }
          }
        }

        // Commit ops in chunks of max 150 to keep under Firestore limits and prevent stream exhaustion
        if (pendingOps.length > 0) {
          const CHUNK_SIZE = 150;
          for (let i = 0; i < pendingOps.length; i += CHUNK_SIZE) {
            const chunk = pendingOps.slice(i, i + CHUNK_SIZE);
            const b = writeBatch(db);
            chunk.forEach(op => {
              if (op.options) {
                b.set(op.ref, op.data, op.options);
              } else {
                b.set(op.ref, op.data);
              }
            });
            await b.commit();
            if (i + CHUNK_SIZE < pendingOps.length) {
              await new Promise(r => setTimeout(r, 40));
            }
          }
        }

        setGroups(prev => {
          const next = { ...prev, ...localBatchGroups };
          const keys = Object.keys(next);
          if (keys.length > 250) {
            const keepKeys = keys.slice(keys.length - 250);
            const bounded: Record<string, AttendanceGroup> = {};
            keepKeys.forEach(k => { bounded[k] = next[k]; });
            return bounded;
          }
          return next;
        });

        const lastDoc = docs[docs.length - 1];
        job.lastProcessedDocId = lastDoc.id;
        job.lastProcessedClockInTime = (lastDoc.data() as any)?.clockInTime || null;
        job.updatedAt = new Date().toISOString();

        // Throughput & remaining time calculations
        const elapsedSec = Math.max(0.1, (Date.now() - scanStartTimeRef.current) / 1000);
        const curDocsPerSec = Math.round(job.processedCount / elapsedSec);
        setDocsPerSec(curDocsPerSec);

        const remDocs = Math.max(0, (totalShiftsInDb || 49000) - job.processedCount);
        const curEstSec = curDocsPerSec > 0 ? Math.round(remDocs / curDocsPerSec) : 0;
        setEstRemainingSec(curEstSec);

        const cleanJob = sanitizeJobData(job);
        localStorage.setItem(`tms_active_job_${user.uid}`, JSON.stringify(cleanJob));
        await setDoc(doc(db, 'tmsHistoricalCorrectionJobs', job.jobId), cleanJob, { merge: true });
        setActiveJob({ ...job });
        setTotalShiftsScanned(job.processedCount);

        await new Promise(r => setTimeout(r, 10));
      }
    } catch (err: any) {
      console.error('Scan batch error:', err);
      if (job) {
        job.status = 'ERROR';
        job.lastError = err.message || String(err);
        job.errorCount += 1;
        job.updatedAt = new Date().toISOString();
        const cleanJob = sanitizeJobData(job);
        localStorage.setItem(`tms_active_job_${user.uid}`, JSON.stringify(cleanJob));
        await setDoc(doc(db, 'tmsHistoricalCorrectionJobs', job.jobId), cleanJob, { merge: true });
        setActiveJob({ ...job });
        setJobError(job.lastError);
      }
      toast.error(`Scan batch error: ${err.message || err}. Click Retry Batch to resume safely.`);
      setIsScanning(false);
    } finally {
      scanLoopActive.current = false;
    }
  };

  // Helper to calculate exact correction parameters for an AttendanceGroup
  const getCorrectionDetails = (g: AttendanceGroup) => {
    // Find latest session
    const sortedShifts = [...g.originalShifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());
    const sessionToExtend = sortedShifts[sortedShifts.length - 1];
    
    const totalProdMins = g.recalcProductiveMs / 60000;
    const deficitMins = Math.max(0, 480 - totalProdMins);

    const origOutMs = sessionToExtend?.clockOutTime ? new Date(sessionToExtend.clockOutTime).getTime() : 0;
    const correctedOutMs = origOutMs + (deficitMins * 60000);
    const correctedOutTime = new Date(correctedOutMs).toISOString();

    return {
      sessionToExtend,
      deficitMins,
      originalClockOut: sessionToExtend?.clockOutTime || 'N/A',
      correctedClockOut: correctedOutTime,
      productiveDelta: deficitMins,
      originalTotalProductiveMins: totalProdMins,
      correctedTotalProductiveMins: totalProdMins + deficitMins,
      originalSessionOut: sessionToExtend?.clockOutTime || 'N/A',
      correctedSessionOut: correctedOutTime
    };
  };

  // Execute database updates for a single AttendanceGroup (Cap Productive Time at 600 mins / 10 Hours)
  const executeGroupCap10hCorrection = async (g: AttendanceGroup, adminReason: string) => {
    setIsCorrecting(true);
    const nowMs = Date.now();
    const batch = writeBatch(db);
    const backupCollectionRef = collection(db, 'tmsHistoricalCorrections');

    try {
      const totalProdMins = g.recalcProductiveMs / 60000;
      if (totalProdMins <= 600) {
        throw new Error('This record has productive time <= 600 minutes and does not require 10h capping.');
      }

      // Safety check: recalculate from raw activities
      const sortedShifts = [...g.originalShifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());
      
      let accumulatedMins = 0;
      const shiftUpdatesList: Array<{ shiftId: string; updates: any }> = [];

      for (const sh of sortedShifts) {
        if (sh.correctedByOver10h) continue;

        const shMetrics = calculateShiftMetrics(sh, nowMs);
        const shProdMins = shMetrics.productiveMs / 60000;

        if (accumulatedMins + shProdMins <= 600) {
          accumulatedMins += shProdMins;
        } else if (accumulatedMins < 600) {
          const allowedMins = 600 - accumulatedMins;
          const allowedMs = allowedMins * 60000;
          const allowedSecs = allowedMins * 60;
          const util = Math.round(((allowedMins / 480) * 100) * 10) / 10;

          const updates = {
            productiveMinutes: allowedMins,
            productiveSeconds: allowedSecs,
            productiveMs: allowedMs,
            totalProductiveTime: formatTimeStr(allowedMs),
            utilization: util,
            finalUtilization: util,
            correctedByOver10h: true,
            over10hCorrectionVersion: 'v1'
          };

          shiftUpdatesList.push({ shiftId: sh.id, updates });
          accumulatedMins = 600;
        } else {
          const updates = {
            productiveMinutes: 0,
            productiveSeconds: 0,
            productiveMs: 0,
            totalProductiveTime: '00:00:00',
            utilization: 0,
            finalUtilization: 0,
            correctedByOver10h: true,
            over10hCorrectionVersion: 'v1'
          };

          shiftUpdatesList.push({ shiftId: sh.id, updates });
        }
      }

      if (shiftUpdatesList.length === 0) {
        throw new Error('Target record has already been corrected for Productive Time > 10 Hours.');
      }

      // Write Immutable Audit Record
      const auditDocId = `audit_over10h_${g.id}_${nowMs}`;
      const origUtil = Math.round(((totalProdMins / 480) * 100) * 10) / 10;
      const auditPayload = {
        correctionId: auditDocId,
        operatorId: user.uid || '',
        operatorName: user.name || 'Admin',
        timestamp: new Date().toISOString(),
        approvedAt: new Date().toISOString(),
        shiftId: sortedShifts.map(s => s.id).join(', '),
        sessionIds: sortedShifts.map(s => s.id),
        userId: g.userId,
        userName: g.userName,
        userEmail: g.userEmail,
        attendanceDate: g.attendanceDate,
        originalProductiveMinutes: totalProdMins,
        correctedProductiveMinutes: 600,
        excessMinutes: Math.round(totalProdMins - 600),
        originalUtilization: origUtil,
        correctedUtilization: 125,
        changedFields: ['productiveMinutes', 'productiveSeconds', 'productiveMs', 'totalProductiveTime', 'utilization', 'finalUtilization'],
        correctionType: 'PRODUCTIVE_TIME_OVER_10H',
        calculationEngineVersion: '1.0.0',
        reason: adminReason || 'Historical productive time capped at 600m (10h)'
      };

      await addDoc(backupCollectionRef, auditPayload);

      // Apply updates to Firestore
      shiftUpdatesList.forEach(({ shiftId, updates }) => {
        batch.update(doc(db, 'tmsShifts', shiftId), updates);
      });

      await batch.commit();

      await logAdminEvent(
        'TMS_HISTORICAL_CORRECTION_OVER_10H',
        g.userName,
        `Prod: ${totalProdMins.toFixed(1)}m (${origUtil.toFixed(1)}%)`,
        `Prod: 600m (125.0%)`
      );

      // Reflect in local state
      setGroups((prev: Record<string, AttendanceGroup>) => {
        const next = { ...prev };
        if (next[g.id]) {
          next[g.id] = {
            ...next[g.id],
            storedProductiveMins: 600,
            storedUtilization: 125,
            recalcProductiveMs: 600 * 60000,
            recalcUtilization: 125,
            status: 'ALREADY HEALTHY',
            originalShifts: next[g.id].originalShifts.map(s => {
              const up = shiftUpdatesList.find(u => u.shiftId === s.id);
              return up ? { ...s, ...up.updates } : s;
            })
          };
        }
        return next;
      });

      toast.success(`Successfully capped productive time to 600m (10h) for ${g.userName} on ${g.attendanceDate}!`);
    } catch (err: any) {
      console.error('Cap 10h correction write error:', err);
      toast.error(`Database write failed: ${err.message || err}`);
    } finally {
      setIsCorrecting(false);
      setPreviewGroup(null);
    }
  };

  // Execute database updates for a single AttendanceGroup (approved single record)
  const executeGroupCorrection = async (g: AttendanceGroup, adminReason: string) => {
    if (g.status === 'PRODUCTIVE_TIME_OVER_10H' || (g.recalcProductiveMs / 60000) > 600) {
      return executeGroupCap10hCorrection(g, adminReason);
    }

    setIsCorrecting(true);
    const nowMs = Date.now();
    const batch = writeBatch(db);
    const backupCollectionRef = collection(db, 'tmsHistoricalCorrections');

    try {
      const details = getCorrectionDetails(g);
      if (details.deficitMins <= 0 || !details.sessionToExtend) {
        throw new Error('This record has no deficit or valid session to correct.');
      }

      const sh = details.sessionToExtend;

      // 1. Build extended activities sequence
      const newActivity = {
        startTime: sh.clockOutTime,
        endTime: details.correctedClockOut,
        type: 'productive',
        name: sh.process || 'Work',
        action: 'PROCESS_START',
        remarks: 'Historical correction productive target adjustment'
      };
      const updatedActivities = [...(sh.activities || []), newActivity];

      // 2. Run updated shift through central TMS engine
      const updatedShiftObj = {
        ...sh,
        clockOutTime: details.correctedClockOut,
        activities: updatedActivities,
        status: 'COMPLETED'
      };
      const metrics = calculateShiftMetrics(updatedShiftObj, nowMs);

      const finalProdMins = metrics.productiveMs / 60000;
      const finalBrkMins = metrics.breakMs / 60000;
      const finalDurMins = metrics.elapsedMs / 60000;

      const changedFieldsObj = {
        clockOutTime: details.correctedClockOut,
        activities: updatedActivities,
        productiveMinutes: finalProdMins,
        breakMinutes: finalBrkMins,
        productiveMs: metrics.productiveMs,
        breakMs: metrics.breakMs,
        totalShiftMs: metrics.elapsedMs,
        shiftDuration: finalDurMins,
        utilization: metrics.utilization,
        finalUtilization: metrics.utilization,
        totalProductiveTime: metrics.productiveStr,
        totalBreakTime: metrics.breakStr,
        totalShiftTime: metrics.elapsedStr,
        status: 'COMPLETED' as const
      };

      // 3. Write Immutable Audit Record (Requirement 9)
      const auditDocId = `audit_${sh.id}_${nowMs}`;
      const auditPayload = {
        correctionId: auditDocId,
        shiftId: sh.id,
        sessionId: sh.id,
        userId: sh.userId,
        userName: sh.userName || sh.employeeName || 'N/A',
        attendanceDate: g.attendanceDate,
        originalClockInTime: sh.clockInTime,
        originalClockOutTime: sh.clockOutTime,
        correctedClockOutTime: details.correctedClockOut,
        originalProductiveMinutes: sh.productiveMinutes || 0,
        correctedProductiveMinutes: finalProdMins,
        originalBreakMinutes: sh.breakMinutes || 0,
        correctedBreakMinutes: finalBrkMins,
        originalUtilization: sh.utilization || 0,
        correctedUtilization: metrics.utilization,
        deficitMinutes: details.deficitMins,
        operatorId: user.uid || '',
        operatorName: user.name,
        reason: adminReason || 'Manual Clock-Out Target 8h Correction',
        calculationEngineVersion: '1.0.0',
        approvedAt: new Date().toISOString(),
        correctionType: 'MANUAL_CLOCKOUT_EXTENSION'
      };

      await addDoc(backupCollectionRef, auditPayload);

      // 4. Build shift event ledger correction event
      const updatedLedger = appendShiftEvent(sh.shiftEventLedger || [], sh, {
        eventType: 'MANUAL_CORRECTION',
        timestamp: new Date().toISOString(),
        performedBy: user.name,
        source: 'Historical Correction Tool',
        reason: adminReason || 'Manual Clock-Out Target 8h Correction',
        remarks: `Clock-out corrected to 8h target. Productive extended by ${details.deficitMins.toFixed(1)} mins.`
      });

      // 5. Queue updates
      const shiftDocRef = doc(db, 'tmsShifts', sh.id);
      batch.update(shiftDocRef, {
        ...changedFieldsObj,
        shiftEventLedger: updatedLedger,
        version: (sh.version || 1) + 1
      });

      // Commit changes
      await batch.commit();

      // Log global admin action audit
      await logAdminEvent(
        'TMS_HISTORICAL_CORRECTION_CLOCKOUT',
        g.userName,
        `ClockOut: ${sh.clockOutTime}, Prod: ${g.storedProductiveMins.toFixed(1)}m`,
        `ClockOut: ${details.correctedClockOut}, Prod: 480.0m`
      );

      // Reflect change in local UI state by updating group status to ALREADY HEALTHY
      setGroups((prev: Record<string, AttendanceGroup>) => {
        const next = { ...prev };
        if (next[g.id]) {
          next[g.id] = {
            ...next[g.id],
            storedProductiveMins: 480,
            storedUtilization: 100,
            recalcProductiveMs: 480 * 60000,
            recalcUtilization: 100,
            status: 'ALREADY HEALTHY',
            originalShifts: next[g.id].originalShifts.map(s => s.id === sh.id ? { ...s, ...changedFieldsObj, shiftEventLedger: updatedLedger } : s)
          };
        }
        return next;
      });

      toast.success(`Successfully corrected Clock-Out to 8h target for ${g.userName} on ${g.attendanceDate}!`);
    } catch (err: any) {
      console.error('Correction write error:', err);
      toast.error(`Database write failed: ${err.message || err}`);
    } finally {
      setIsCorrecting(false);
      setPreviewGroup(null);
    }
  };

  // Execute bulk correction for all selected groups (Requirement 12)
  const executeBulkCorrection = async (adminReason: string) => {
    setIsCorrecting(true);
    setShowBulkConfirm(false);
    
    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;
    const nowMs = Date.now();
    const reports: CorrectionReportItem[] = [];

    toast.info(`Executing bulk correction for ${selectedGroupIds.size} records...`);

    try {
      for (const groupId of Array.from(selectedGroupIds) as string[]) {
        const g = groups[groupId];
        if (!g) continue;

        if (g.status === 'PRODUCTIVE_TIME_OVER_10H' || (g.recalcProductiveMs / 60000) > 600) {
          // Process 10H capping correction
          try {
            const totalProdMins = g.recalcProductiveMs / 60000;
            if (totalProdMins <= 600) {
              reports.push({
                userName: g.userName,
                attendanceDate: g.attendanceDate,
                status: 'SKIPPED',
                message: 'Productive time <= 600 minutes'
              });
              skipCount++;
              continue;
            }

            const sortedShifts = [...g.originalShifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());
            let accumulatedMins = 0;
            const shiftUpdatesList: Array<{ shiftId: string; updates: any }> = [];

            for (const sh of sortedShifts) {
              if (sh.correctedByOver10h) continue;

              const shMetrics = calculateShiftMetrics(sh, nowMs);
              const shProdMins = shMetrics.productiveMs / 60000;

              if (accumulatedMins + shProdMins <= 600) {
                accumulatedMins += shProdMins;
              } else if (accumulatedMins < 600) {
                const allowedMins = 600 - accumulatedMins;
                const allowedMs = allowedMins * 60000;
                const allowedSecs = allowedMins * 60;
                const util = Math.round(((allowedMins / 480) * 100) * 10) / 10;

                const updates = {
                  productiveMinutes: allowedMins,
                  productiveSeconds: allowedSecs,
                  productiveMs: allowedMs,
                  totalProductiveTime: formatTimeStr(allowedMs),
                  utilization: util,
                  finalUtilization: util,
                  correctedByOver10h: true,
                  over10hCorrectionVersion: 'v1'
                };

                shiftUpdatesList.push({ shiftId: sh.id, updates });
                accumulatedMins = 600;
              } else {
                const updates = {
                  productiveMinutes: 0,
                  productiveSeconds: 0,
                  productiveMs: 0,
                  totalProductiveTime: '00:00:00',
                  utilization: 0,
                  finalUtilization: 0,
                  correctedByOver10h: true,
                  over10hCorrectionVersion: 'v1'
                };

                shiftUpdatesList.push({ shiftId: sh.id, updates });
              }
            }

            if (shiftUpdatesList.length === 0) {
              reports.push({
                userName: g.userName,
                attendanceDate: g.attendanceDate,
                status: 'SKIPPED',
                message: 'Already corrected for 10h cap'
              });
              skipCount++;
              continue;
            }

            const batch = writeBatch(db);
            const backupCollectionRef = collection(db, 'tmsHistoricalCorrections');

            const auditDocId = `audit_bulk_over10h_${g.id}_${nowMs}`;
            const origUtil = Math.round(((totalProdMins / 480) * 100) * 10) / 10;
            const auditPayload = {
              correctionId: auditDocId,
              operatorId: user.uid || '',
              operatorName: user.name || 'Admin',
              timestamp: new Date().toISOString(),
              approvedAt: new Date().toISOString(),
              shiftId: sortedShifts.map(s => s.id).join(', '),
              sessionIds: sortedShifts.map(s => s.id),
              userId: g.userId,
              userName: g.userName,
              userEmail: g.userEmail,
              attendanceDate: g.attendanceDate,
              originalProductiveMinutes: totalProdMins,
              correctedProductiveMinutes: 600,
              excessMinutes: Math.round(totalProdMins - 600),
              originalUtilization: origUtil,
              correctedUtilization: 125,
              changedFields: ['productiveMinutes', 'productiveSeconds', 'productiveMs', 'totalProductiveTime', 'utilization', 'finalUtilization'],
              correctionType: 'PRODUCTIVE_TIME_OVER_10H',
              calculationEngineVersion: '1.0.0',
              reason: adminReason || 'Bulk historical productive time capped at 600m (10h)'
            };

            await addDoc(backupCollectionRef, auditPayload);

            shiftUpdatesList.forEach(({ shiftId, updates }) => {
              batch.update(doc(db, 'tmsShifts', shiftId), updates);
            });

            await batch.commit();
            successCount++;

            reports.push({
              userName: g.userName,
              attendanceDate: g.attendanceDate,
              status: 'SUCCESS',
              message: `Productive time capped at 600m (Excess removed: -${Math.round(totalProdMins - 600)} mins)`,
              originalOut: g.lastClockOut || 'N/A',
              correctedOut: g.lastClockOut || 'N/A',
              productiveDelta: Math.round(totalProdMins - 600)
            });

            // Update local state reactively
            setGroups((prev: Record<string, AttendanceGroup>) => {
              const next = { ...prev };
              if (next[groupId]) {
                next[groupId] = {
                  ...next[groupId],
                  storedProductiveMins: 600,
                  storedUtilization: 125,
                  recalcProductiveMs: 600 * 60000,
                  recalcUtilization: 125,
                  status: 'ALREADY HEALTHY',
                  originalShifts: next[groupId].originalShifts.map(s => {
                    const up = shiftUpdatesList.find(u => u.shiftId === s.id);
                    return up ? { ...s, ...up.updates } : s;
                  })
                };
              }
              return next;
            });

          } catch (innerErr: any) {
            console.error(`Error processing 10h cap for group ${groupId}:`, innerErr);
            failCount++;
            reports.push({
              userName: g.userName,
              attendanceDate: g.attendanceDate,
              status: 'FAILED',
              message: innerErr.message || 'Firestore commit write failure'
            });
          }
        } else if (g.status === 'CORRECTABLE' || g.status === 'ANOMALY' || g.status === 'INCOMPLETE / REVIEW') {
          // Process 8H extension correction
          try {
            const details = getCorrectionDetails(g);
            if (details.deficitMins <= 0 || !details.sessionToExtend) {
              reports.push({
                userName: g.userName,
                attendanceDate: g.attendanceDate,
                status: 'SKIPPED',
                message: 'No productive deficit detected or no sessions available'
              });
              skipCount++;
              continue;
            }

            const sh = details.sessionToExtend;
            const batch = writeBatch(db);
            const backupCollectionRef = collection(db, 'tmsHistoricalCorrections');

            // 1. Build extended activities sequence
            const newActivity = {
              startTime: sh.clockOutTime,
              endTime: details.correctedClockOut,
              type: 'productive',
              name: sh.process || 'Work',
              action: 'PROCESS_START',
              remarks: 'Historical correction productive target adjustment'
            };
            const updatedActivities = [...(sh.activities || []), newActivity];

            // 2. Run through calculation engine
            const updatedShiftObj = {
              ...sh,
              clockOutTime: details.correctedClockOut,
              activities: updatedActivities,
              status: 'COMPLETED'
            };
            const metrics = calculateShiftMetrics(updatedShiftObj, nowMs);

            const finalProdMins = metrics.productiveMs / 60000;
            const finalBrkMins = metrics.breakMs / 60000;
            const finalDurMins = metrics.elapsedMs / 60000;

            const changedFieldsObj = {
              clockOutTime: details.correctedClockOut,
              activities: updatedActivities,
              productiveMinutes: finalProdMins,
              breakMinutes: finalBrkMins,
              productiveMs: metrics.productiveMs,
              breakMs: metrics.breakMs,
              totalShiftMs: metrics.elapsedMs,
              shiftDuration: finalDurMins,
              utilization: metrics.utilization,
              finalUtilization: metrics.utilization,
              totalProductiveTime: metrics.productiveStr,
              totalBreakTime: metrics.breakStr,
              totalShiftTime: metrics.elapsedStr,
              status: 'COMPLETED' as const
            };

            // 3. Write Immutable Audit Record
            const auditDocId = `audit_bulk_${sh.id}_${nowMs}`;
            const auditPayload = {
              correctionId: auditDocId,
              shiftId: sh.id,
              sessionId: sh.id,
              userId: sh.userId,
              userName: sh.userName || sh.employeeName || 'N/A',
              attendanceDate: g.attendanceDate,
              originalClockInTime: sh.clockInTime,
              originalClockOutTime: sh.clockOutTime,
              correctedClockOutTime: details.correctedClockOut,
              originalProductiveMinutes: sh.productiveMinutes || 0,
              correctedProductiveMinutes: finalProdMins,
              originalBreakMinutes: sh.breakMinutes || 0,
              correctedBreakMinutes: finalBrkMins,
              originalUtilization: sh.utilization || 0,
              correctedUtilization: metrics.utilization,
              deficitMinutes: details.deficitMins,
              operatorId: user.uid || '',
              operatorName: user.name,
              reason: adminReason || 'Bulk target Clock-Out target 8h correction',
              calculationEngineVersion: '1.0.0',
              approvedAt: new Date().toISOString(),
              correctionType: 'MANUAL_CLOCKOUT_EXTENSION'
            };

            await addDoc(backupCollectionRef, auditPayload);

            // 4. Build ledger event
            const updatedLedger = appendShiftEvent(sh.shiftEventLedger || [], sh, {
              eventType: 'MANUAL_CORRECTION',
              timestamp: new Date().toISOString(),
              performedBy: user.name,
              source: 'Historical Correction Tool',
              reason: adminReason || 'Bulk Clock-Out Target 8h Correction',
              remarks: `Clock-out corrected to 8h target in bulk. Productive extended by ${details.deficitMins.toFixed(1)} mins.`
            });

            // 5. Update tmsShifts doc
            const shiftDocRef = doc(db, 'tmsShifts', sh.id);
            batch.update(shiftDocRef, {
              ...changedFieldsObj,
              shiftEventLedger: updatedLedger,
              version: (sh.version || 1) + 1
            });

            await batch.commit();
            successCount++;

            reports.push({
              userName: g.userName,
              attendanceDate: g.attendanceDate,
              status: 'SUCCESS',
              message: `Productive extended by +${details.deficitMins.toFixed(1)} mins.`,
              originalOut: sh.clockOutTime,
              correctedOut: details.correctedClockOut,
              productiveDelta: details.deficitMins
            });

            // Update local state reactively
            setGroups((prev: Record<string, AttendanceGroup>) => {
              const next = { ...prev };
              if (next[groupId]) {
                next[groupId] = {
                  ...next[groupId],
                  storedProductiveMins: 480,
                  storedUtilization: 100,
                  recalcProductiveMs: 480 * 60000,
                  recalcUtilization: 100,
                  status: 'ALREADY HEALTHY',
                  originalShifts: next[groupId].originalShifts.map(s => s.id === sh.id ? { ...s, ...changedFieldsObj, shiftEventLedger: updatedLedger } : s)
                };
              }
              return next;
            });

          } catch (innerErr: any) {
            console.error(`Error processing bulk correction for group ${groupId}:`, innerErr);
            failCount++;
            reports.push({
              userName: g.userName,
              attendanceDate: g.attendanceDate,
              status: 'FAILED',
              message: innerErr.message || 'Firestore commit write failure'
            });
          }
        } else {
          reports.push({
            userName: g.userName,
            attendanceDate: g.attendanceDate,
            status: 'SKIPPED',
            message: `Record is not in correctable status (Status is ${g.status})`
          });
          skipCount++;
        }
      }

      await logAdminEvent(
        'TMS_HISTORICAL_BULK_CORRECTION_CLOCKOUT',
        `${successCount} Users`,
        'Bulk candidates under target',
        `Corrected ${successCount} records, skipped ${skipCount}, failed ${failCount}`
      );

      setCorrectionReport(reports);
      setSelectedGroupIds(new Set());
      toast.success(`Bulk recovery completed! Corrected: ${successCount}, Skipped: ${skipCount}, Failed: ${failCount}`);
    } catch (err: any) {
      console.error('Bulk correction major exception:', err);
      toast.error(`Bulk operation failed: ${err.message || err}`);
    } finally {
      setIsCorrecting(false);
    }
  };

  // Download Bulk Correction Report as CSV
  const downloadCsvReport = (reportItems: CorrectionReportItem[]) => {
    let content = "UserName,AttendanceDate,Status,OriginalClockOut,CorrectedClockOut,ProductiveDeltaMins,Details\n";
    reportItems.forEach(item => {
      content += `"${item.userName}","${item.attendanceDate}","${item.status}","${item.originalOut || ''}","${item.correctedOut || ''}",${item.productiveDelta || 0},"${item.message}"\n`;
    });
    
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `tms_bulk_correction_report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Row Selection Helpers
  const toggleSelectGroup = (id: string) => {
    setSelectedGroupIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllFiltered = () => {
    const next = new Set<string>();
    filteredGroups.forEach(g => {
      next.add(g.id);
    });
    setSelectedGroupIds(next);
    toast.info(`Selected all ${next.size} filtered candidate records.`);
  };

  const selectAllEligible = () => {
    const next = new Set<string>();
    filteredGroups.forEach(g => {
      if (g.status === 'CORRECTABLE') {
        next.add(g.id);
      }
    });
    setSelectedGroupIds(next);
    toast.info(`Selected all ${next.size} CORRECTABLE candidates.`);
  };

  const selectNone = () => {
    setSelectedGroupIds(new Set());
    toast.info('Selection cleared.');
  };

  // Convert milliseconds into display format "HH:MM:SS"
  const formatTimeStr = (ms: number) => {
    const totSecs = Math.floor(ms / 1000);
    const hrs = Math.floor(totSecs / 3600);
    const mins = Math.floor((totSecs % 3600) / 60);
    const secs = totSecs % 60;

    return [
      hrs.toString().padStart(2, '0'),
      mins.toString().padStart(2, '0'),
      secs.toString().padStart(2, '0')
    ].join(':');
  };

  const formatMinsToHHMM = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  return (
    <div className={`border rounded-2xl p-6 ${containerBg} shadow-sm space-y-6 antialiased`}>
      {/* 1. Header Information */}
      <div className={`flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b pb-4 ${adminTheme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`}>
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 bg-rose-500/10 text-rose-500 text-[10px] font-black rounded-md uppercase tracking-wider">
              Temporary Admin Recovery Tool
            </span>
          </div>
          <h2 className="text-xl font-black uppercase tracking-tight text-rose-500 mt-1 flex items-center gap-2">
            ⚠️ Historical Correction Console
          </h2>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Scan and batch-correct Clock-Out timestamps to align employees with the <strong>8-hour (480 mins) productive target</strong>.
            All modifications generate immutable backup records and are permanently audited.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <span className="px-2 py-0.5 bg-rose-500/10 text-rose-400 text-[10px] font-bold rounded-md uppercase tracking-wider border border-rose-500/20">
              Historical Scan Range: 01 Jun 2026 IST → {endDate || 'Present'}
            </span>
          </div>
        </div>

        {/* Auto-Correction Mode Toggle & Scan Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5 bg-slate-800/60 p-2 rounded-xl border border-slate-700/50">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoCorrectEnabled}
                onChange={(e) => setAutoCorrectEnabled(e.target.checked)}
                disabled={isScanning}
                className="w-4 h-4 rounded text-rose-500 focus:ring-rose-500 bg-slate-900 border-slate-700 cursor-pointer"
              />
              <span className="text-xs font-bold text-slate-200">
                Auto-Correct During Scan
              </span>
            </label>
            <span className={`px-2 py-0.5 text-[10px] font-extrabold rounded uppercase tracking-wider ${
              autoCorrectEnabled
                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
            }`}>
              {autoCorrectEnabled ? 'LIVE AUTO-CORRECT' : 'SCAN ONLY (DRY RUN)'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {!isScanning && !isPaused && (
              <button
                onClick={startNewScan}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 active:scale-95 shadow-sm"
              >
                <Play size={13} />
                <span>Start Analysis Scan</span>
              </button>
            )}

            {isScanning && (
              <button
                onClick={pauseScan}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 active:scale-95 shadow-sm"
              >
                <Pause size={13} />
                <span>Pause Scan</span>
              </button>
            )}

            {isPaused && (
              <div className="flex items-center gap-2">
                <button
                  onClick={resumeScan}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 active:scale-95 shadow-sm"
                >
                  <Play size={13} />
                  <span>Resume Scan</span>
                </button>
                <button
                  onClick={stopScan}
                  className="px-3 py-2 bg-slate-500 hover:bg-slate-600 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1 active:scale-95"
                >
                  <X size={13} />
                  <span>Stop</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Persistent Scan Job Alert Banner */}
      {activeJob && !isScanning && (
        <div className="p-4 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-400 font-bold text-[10px] rounded uppercase tracking-wider">
                Previous Scan Detected
              </span>
              <span className="text-xs text-slate-300 font-mono">Job ID: {activeJob.jobId}</span>
              <span className={`px-2 py-0.5 text-[10px] font-extrabold rounded uppercase ${
                activeJob.status === 'ERROR' ? 'bg-rose-500/20 text-rose-400' : 'bg-amber-500/20 text-amber-400'
              }`}>
                Status: {activeJob.status}
              </span>
            </div>
            <p className="text-xs font-medium text-slate-200 mt-1">
              Job progress saved — <strong>{(activeJob.processedCount || 0).toLocaleString()}</strong> records processed in batch #{activeJob.currentBatch || 0}.
              {activeJob.autoCorrectedCount > 0 && <span className="text-emerald-400"> (Auto-Corrected: {activeJob.autoCorrectedCount.toLocaleString()})</span>}
            </p>
            {activeJob.lastError && (
              <p className="text-xs text-rose-400 font-mono mt-1">
                Last Batch Error: {activeJob.lastError}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {activeJob.status === 'ERROR' && (
              <button
                onClick={() => runScanLoop(activeJob)}
                className="px-3.5 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
              >
                <RotateCcw size={13} />
                <span>Retry Batch</span>
              </button>
            )}
            <button
              onClick={resumeScan}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
            >
              <Play size={13} />
              <span>Resume Scan</span>
            </button>
            <button
              onClick={startNewScan}
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw size={13} />
              <span>Start New Scan</span>
            </button>
          </div>
        </div>
      )}

      {/* 2. Real-time Scanner Progress Bar */}
      {(isScanning || isPaused) && (
        <div className={`p-4 rounded-xl border ${cardBg} space-y-3`}>
          <div className="flex justify-between items-center text-xs flex-wrap gap-2">
            <span className="font-semibold flex items-center gap-1.5 text-slate-300">
              {isScanning ? (
                <RefreshCw size={13} className="animate-spin text-indigo-500" />
              ) : (
                <Pause size={13} className="text-amber-500" />
              )}
              {isScanning ? `High-Speed Scanner Running (Batch #${activeJob?.currentBatch || 0})` : 'Scanning paused by administrator'}
            </span>
            <div className="flex items-center gap-3 font-mono text-xs">
              {isScanning && docsPerSec > 0 && (
                <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 rounded font-bold border border-emerald-500/20">
                  ⚡ {docsPerSec.toLocaleString()} docs/sec
                </span>
              )}
              {isScanning && estRemainingSec > 0 && (
                <span className="text-slate-400">
                  ⏱️ ~{Math.ceil(estRemainingSec / 60)} min remaining
                </span>
              )}
              <span className="text-slate-400">
                Scanned: {(activeJob?.processedCount || totalShiftsScanned).toLocaleString()} / {totalShiftsInDb > 0 ? totalShiftsInDb.toLocaleString() : 'Counting...'}
              </span>
            </div>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
            <div 
              className={`h-full transition-all duration-300 ${isPaused ? 'bg-amber-500' : 'bg-indigo-500'}`} 
              style={{ width: `${Math.min(100, totalShiftsInDb > 0 ? ((activeJob?.processedCount || totalShiftsScanned) / totalShiftsInDb) * 100 : 0)}%` }}
            />
          </div>
          <div className="flex flex-wrap justify-between items-center text-[10px] text-slate-400 border-t border-slate-800/40 pt-2">
            <span>Historical Scan Range: <strong>01 Jun 2026 IST</strong> to <strong>{endDate || 'Present'}</strong></span>
            <span>Batch Checkpoints Persisted to Firestore & LocalStorage</span>
          </div>
        </div>
      )}

      {/* 3. Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <div className={`p-3 rounded-xl border ${cardBg} text-center`}>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Total Scanned</p>
          <p className="text-lg font-black mt-1 text-slate-200">{activeJob?.processedCount || stats.total}</p>
        </div>
        <div className={`p-3 rounded-xl border ${cardBg} text-center border-l-4 border-l-emerald-500`}>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Already Healthy</p>
          <p className="text-lg font-black mt-1 text-emerald-500">{activeJob?.healthyCount || stats.alreadyHealthy}</p>
        </div>
        <div className={`p-3 rounded-xl border ${cardBg} text-center border-l-4 border-l-indigo-500`}>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Correctable</p>
          <p className="text-lg font-black mt-1 text-indigo-400">{activeJob?.totalCandidateCount || stats.correctable}</p>
        </div>
        <div className={`p-3 rounded-xl border ${cardBg} text-center border-l-4 border-l-rose-500`}>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Over 10 Hours (&gt;600m)</p>
          <p className="text-lg font-black mt-1 text-rose-400">{activeJob?.over10hCount || stats.over10h}</p>
        </div>
        <div className={`p-3 rounded-xl border ${cardBg} text-center border-l-4 border-l-emerald-400`}>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Auto-Corrected</p>
          <p className="text-lg font-black mt-1 text-emerald-400">{activeJob?.autoCorrectedCount || 0}</p>
        </div>
        <div className={`p-3 rounded-xl border ${cardBg} text-center border-l-4 border-l-amber-500`}>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">High Productive</p>
          <p className="text-lg font-black mt-1 text-amber-500">{activeJob?.highTimeCount || stats.highProductive}</p>
        </div>
        <div className={`p-3 rounded-xl border ${cardBg} text-center border-l-4 border-l-purple-500`}>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Incomplete / Review</p>
          <p className="text-lg font-black mt-1 text-purple-400">{activeJob?.reviewRequiredCount || stats.incompleteReview}</p>
        </div>
        <div className={`p-3 rounded-xl border ${cardBg} text-center border-l-4 border-l-rose-500`}>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Anomalies / Errors</p>
          <p className="text-lg font-black mt-1 text-rose-500">{(activeJob?.errorCount || 0) + stats.anomaly}</p>
        </div>
      </div>

      {/* 4. Filter Bar */}
      <div className={`p-4 rounded-xl border ${cardBg} grid grid-cols-1 md:grid-cols-4 gap-4`}>
        {/* Search Input */}
        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Search Agent</label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Name, email, or UID..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className={`w-full pl-9 pr-3 py-2 rounded-xl text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-500 ${inputBg}`}
            />
          </div>
        </div>

        {/* Status Filter */}
        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Classification</label>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className={`w-full px-3 py-2 rounded-xl text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-500 ${inputBg}`}
          >
            <option value="ALL">All Classified</option>
            <option value="NEEDS_CORRECTION">Eligible (Correctable Only)</option>
            <option value="PRODUCTIVE_TIME_OVER_10H">OVER 10 HOURS (&gt;600m / &gt;10h)</option>
            <option value="CORRECTABLE">CORRECTABLE (Under 8h)</option>
            <option value="ALREADY HEALTHY">ALREADY HEALTHY (&gt;=8h)</option>
            <option value="HIGH PRODUCTIVE">HIGH PRODUCTIVE (&gt;8h)</option>
            <option value="INCOMPLETE / REVIEW">INCOMPLETE / REVIEW</option>
            <option value="ANOMALY">ANOMALY (Review Required)</option>
          </select>
        </div>

        {/* Date Filters */}
        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
            <span>Attendance From Date</span>
            <span className="text-rose-500 font-extrabold">(Locked)</span>
          </label>
          <input
            type="date"
            value={startDate}
            disabled
            className={`w-full px-3 py-2 rounded-xl text-xs font-semibold opacity-60 cursor-not-allowed ${inputBg}`}
          />
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Attendance To Date</label>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className={`w-full px-3 py-2 rounded-xl text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-500 ${inputBg}`}
          />
        </div>
      </div>

      {/* Prominent Row Selection Controls (Requirement 1) */}
      <div className={`flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border ${cardBg}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-slate-300">Selection Controls:</span>
          <button
            onClick={selectAllFiltered}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-lg text-xs font-bold transition-all cursor-pointer shadow-sm border border-slate-700"
          >
            Select All Filtered
          </button>
          <button
            onClick={selectAllEligible}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition-all cursor-pointer shadow-sm"
          >
            Select All Eligible (&lt;8h)
          </button>
          <button
            onClick={() => {
              const next = new Set<string>();
              filteredGroups.forEach(g => {
                if (g.status === 'PRODUCTIVE_TIME_OVER_10H') {
                  next.add(g.id);
                }
              });
              setSelectedGroupIds(next);
              toast.info(`Selected all ${next.size} OVER 10 HOURS candidates.`);
            }}
            className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-all cursor-pointer shadow-sm"
          >
            Select All (&gt;10 Hours)
          </button>
          <button
            onClick={() => {
              const next = new Set<string>();
              filteredGroups.forEach(g => {
                if (g.status === 'HIGH PRODUCTIVE') {
                  next.add(g.id);
                }
              });
              setSelectedGroupIds(next);
              toast.info(`Selected all ${next.size} HIGH PRODUCTIVE candidates.`);
            }}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold transition-all cursor-pointer shadow-sm"
          >
            Select All High Productive
          </button>
          <button
            onClick={() => {
              const next = new Set<string>();
              filteredGroups.forEach(g => {
                if (g.status === 'INCOMPLETE / REVIEW') {
                  next.add(g.id);
                }
              });
              setSelectedGroupIds(next);
              toast.info(`Selected all ${next.size} INCOMPLETE / REVIEW candidates.`);
            }}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold transition-all cursor-pointer shadow-sm"
          >
            Select All Incomplete
          </button>
          <button
            onClick={() => {
              const next = new Set<string>();
              filteredGroups.forEach(g => {
                if (g.status === 'ANOMALY') {
                  next.add(g.id);
                }
              });
              setSelectedGroupIds(next);
              toast.info(`Selected all ${next.size} ANOMALY candidates.`);
            }}
            className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-all cursor-pointer shadow-sm"
          >
            Select All Anomalies
          </button>
          <button
            onClick={selectNone}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-lg text-xs font-bold transition-all cursor-pointer shadow-sm border border-slate-700"
          >
            Select None
          </button>
        </div>
        <div className="text-xs font-bold font-mono text-indigo-400 bg-indigo-500/10 px-3 py-1.5 rounded-lg border border-indigo-500/20">
          {selectedGroupIds.size} records selected
        </div>
      </div>

      {/* 5. Bulk Correction Action Banner (Requirement 11) */}
      {selectedGroupIds.size > 0 && (
        <div className="p-4 bg-indigo-600/10 border border-indigo-500/25 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <p className="text-xs font-black uppercase text-indigo-400 flex items-center gap-1">
              <Sparkles size={14} />
              Bulk Selection Ready: {selectedGroupIds.size} records selected
            </p>
            <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-tight">
              A total of <strong>{selectedGroupIds.size}</strong> records will be previewed for Clock-Out extension corrections.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setSelectedGroupIds(new Set())}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-705 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
            >
              Clear Selection
            </button>
            <button
              onClick={() => setShowBulkConfirm(true)}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 shadow-sm"
            >
              <CheckCircle2 size={13} />
              <span>Preview & Correct Selected ({selectedGroupIds.size})</span>
            </button>
          </div>
        </div>
      )}

      {/* 6. Main Classified Records Table */}
      <div className={`border rounded-xl overflow-hidden ${cardBg}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className={`border-b ${adminTheme === 'dark' ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
                <th className="p-3 font-semibold text-slate-400 w-10 text-center">Select</th>
                <th className="p-3 font-semibold text-slate-400">User / Agent</th>
                <th className="p-3 font-semibold text-slate-400">Date</th>
                <th className="p-3 font-semibold text-slate-400 text-center">Sessions</th>
                <th className="p-3 font-semibold text-slate-400">First Clock-In</th>
                <th className="p-3 font-semibold text-slate-400">Last Clock-Out</th>
                <th className="p-3 font-semibold text-slate-400 text-right">Recalculated Prod</th>
                <th className="p-3 font-semibold text-slate-400 text-right">Recalculated Break</th>
                <th className="p-3 font-semibold text-slate-400 text-right">Recalculated UT</th>
                <th className="p-3 font-semibold text-slate-400 text-center">Eligibility</th>
                <th className="p-3 font-semibold text-slate-400 text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredGroups.length === 0 ? (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-slate-400">
                    {stats.total === 0 ? 'No shift records scanned yet. Click "Start Analysis Scan" to begin audit.' : 'No records match selected filters.'}
                  </td>
                </tr>
              ) : (
                filteredGroups.map(g => {
                  const isSelected = selectedGroupIds.has(g.id);
                  let statusBadge = '';
                  let statusClass = '';

                  switch (g.status) {
                    case 'PRODUCTIVE_TIME_OVER_10H':
                      statusBadge = 'OVER 10 HOURS';
                      statusClass = 'bg-rose-500/15 text-rose-400 border-rose-500/30 font-black';
                      break;
                    case 'CORRECTABLE':
                      statusBadge = 'CORRECTABLE';
                      statusClass = 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20';
                      break;
                    case 'ALREADY HEALTHY':
                      statusBadge = 'ALREADY HEALTHY';
                      statusClass = 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
                      break;
                    case 'HIGH PRODUCTIVE':
                      statusBadge = 'HIGH PRODUCTIVE';
                      statusClass = 'bg-amber-500/10 text-amber-500 border-amber-500/20';
                      break;
                    case 'INCOMPLETE / REVIEW':
                      statusBadge = 'INCOMPLETE / REVIEW';
                      statusClass = 'bg-purple-500/10 text-purple-400 border-purple-500/20';
                      break;
                    case 'ANOMALY':
                      statusBadge = 'ANOMALY';
                      statusClass = 'bg-rose-500/10 text-rose-500 border-rose-500/20';
                      break;
                  }

                  const recalculatedProdStr = formatTimeStr(g.recalcProductiveMs);
                  const recalculatedBrkStr = formatTimeStr(g.recalcBreakMs);
                  const firstClockInDateStr = g.firstClockIn ? new Date(g.firstClockIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
                  const lastClockOutDateStr = g.lastClockOut ? new Date(g.lastClockOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Ongoing';
                  const isOver10h = g.status === 'PRODUCTIVE_TIME_OVER_10H' || (g.recalcProductiveMs / 60000) > 600;

                  return (
                    <tr 
                      key={g.id} 
                      className={`border-b transition-colors ${
                        adminTheme === 'dark' 
                          ? 'border-slate-800/60 hover:bg-slate-900/40' 
                          : 'border-slate-150 hover:bg-slate-50/50'
                      } ${isSelected ? (adminTheme === 'dark' ? 'bg-indigo-500/5' : 'bg-indigo-50/20') : ''}`}
                    >
                      <td className="p-3 text-center align-middle">
                        <button
                          onClick={() => toggleSelectGroup(g.id)}
                          className="text-slate-400 hover:text-indigo-500 cursor-pointer"
                        >
                          {isSelected ? (
                            <CheckSquare size={16} className="text-indigo-500" />
                          ) : (
                            <Square size={16} />
                          )}
                        </button>
                      </td>
                      <td className="p-3 font-semibold">
                        <div>
                          <p className={textPrimary}>{g.userName}</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">{g.userEmail}</p>
                        </div>
                      </td>
                      <td className="p-3 font-mono font-medium text-slate-400">{g.attendanceDate}</td>
                      <td className="p-3 text-center font-bold">
                        <span className="px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                          {g.sessionCount}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-slate-400">{firstClockInDateStr}</td>
                      <td className="p-3 font-mono text-slate-400">{lastClockOutDateStr}</td>
                      <td className="p-3 text-right font-mono font-bold text-indigo-400">
                        <span>{recalculatedProdStr}</span>
                        {isOver10h && (
                          <p className="text-[10px] text-rose-400 font-bold">
                            +{Math.round((g.recalcProductiveMs / 60000) - 600)}m excess
                          </p>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono text-slate-400">{recalculatedBrkStr}</td>
                      <td className="p-3 text-right font-mono font-bold text-indigo-400">{g.recalcUtilization.toFixed(1)}%</td>
                      <td className="p-3 text-center">
                        <span className={`px-2 py-0.5 rounded-md border text-[10px] font-extrabold tracking-wider uppercase ${statusClass}`}>
                          {statusBadge}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <div className="flex justify-center items-center gap-1.5">
                          <button
                            onClick={() => setLedgerGroup(g)}
                            title="Inspect chronological raw activity ledger"
                            className="p-1.5 rounded bg-slate-800 hover:bg-slate-705 text-slate-300 hover:text-white transition-colors cursor-pointer"
                          >
                            <Eye size={13} />
                          </button>
                          
                          {(g.status === 'CORRECTABLE' || g.status === 'ANOMALY' || g.status === 'INCOMPLETE / REVIEW') && (
                            <button
                              onClick={() => setPreviewGroup(g)}
                              className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-[10px] font-black transition-all cursor-pointer uppercase tracking-wider"
                            >
                              Correction
                            </button>
                          )}

                          {g.status === 'PRODUCTIVE_TIME_OVER_10H' && (
                            <button
                              onClick={() => setPreviewGroup(g)}
                              className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded text-[10px] font-black transition-all cursor-pointer uppercase tracking-wider shadow-sm"
                            >
                              Cap at 10h
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 7. Modal Dialog: Chronological Event Sequence Inspection */}
      {ledgerGroup && (
        <div className="fixed inset-0 bg-black/65 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`w-full max-w-2xl rounded-2xl border p-6 overflow-hidden flex flex-col max-h-[85vh] shadow-xl ${containerBg}`}>
            {/* Header */}
            <div className="flex justify-between items-center pb-4 border-b border-slate-800">
              <div>
                <h3 className="text-base font-black uppercase tracking-tight text-slate-100 flex items-center gap-2">
                  <History size={16} className="text-indigo-400" />
                  Chronological Ledger: {ledgerGroup.userName}
                </h3>
                <p className="text-[10px] text-slate-400 mt-1">
                  Attendance Date: {ledgerGroup.attendanceDate} • Sessions: {ledgerGroup.sessionCount}
                </p>
              </div>
              <button 
                onClick={() => setLedgerGroup(null)}
                className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {/* Events Timeline */}
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              {ledgerGroup.originalShifts.map((sh, sIdx) => {
                const sClockIn = sh.clockInTime ? new Date(sh.clockInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'N/A';
                const sClockOut = sh.clockOutTime ? new Date(sh.clockOutTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Ongoing';
                const shActivities = Array.isArray(sh.activities) ? sh.activities : [];

                return (
                  <div key={sh.id} className="p-4 rounded-xl bg-slate-950 border border-slate-850 space-y-3">
                    <div className="flex justify-between items-center text-[10px] font-extrabold uppercase tracking-wider text-indigo-400 border-b border-slate-900 pb-1.5">
                      <span>Session {sIdx + 1} ({sh.id})</span>
                      <span>{sClockIn} → {sClockOut}</span>
                    </div>

                    <div className="space-y-2">
                      {shActivities.length === 0 ? (
                        <p className="text-xs text-slate-400 italic text-center py-2">No raw activity items recorded.</p>
                      ) : (
                        shActivities
                          .map(act => ({
                            ...act,
                            parsedStart: act.startTime ? new Date(act.startTime).getTime() : 0,
                            parsedEnd: act.endTime ? new Date(act.endTime).getTime() : 0
                          }))
                          .sort((a, b) => a.parsedStart - b.parsedStart)
                          .map((act, aIdx) => {
                            const actStartStr = act.startTime ? new Date(act.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'N/A';
                            const actDurMins = act.parsedEnd && act.parsedStart ? Math.round((act.parsedEnd - act.parsedStart) / 60000) : 0;
                            const isBreak = act.type === 'break' || (act.action || '').toUpperCase().includes('BREAK');
                            const indicatorBg = isBreak ? 'bg-amber-500/15 text-amber-500 border-amber-500/20' : 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20';

                            return (
                              <div key={aIdx} className="flex justify-between items-center text-[11px] font-medium border-b border-slate-900 pb-1.5 last:border-0 last:pb-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-slate-400 text-[10px]">{actStartStr}</span>
                                  <span className={`px-2 py-0.5 rounded border font-extrabold tracking-wider text-[9px] uppercase ${indicatorBg}`}>
                                    {act.action || (isBreak ? 'BREAK_START' : 'PROCESS_SWITCH')}
                                  </span>
                                  <span className="text-slate-200">
                                    {act.name || act.currentActivity || act.activityName || act.process || 'Work Session'}
                                  </span>
                                </div>
                                <div className="text-right text-slate-400 font-mono">
                                  {actDurMins > 0 ? `${actDurMins}m` : 'Live'}
                                </div>
                              </div>
                            );
                          })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="pt-4 border-t border-slate-800 text-right">
              <button
                onClick={() => setLedgerGroup(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-705 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                Close Ledger
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. Modal Dialog: Single Correction Preview & Approvals (Requirement 5) */}
      {previewGroup && (() => {
        const isOver10h = previewGroup.status === 'PRODUCTIVE_TIME_OVER_10H' || (previewGroup.recalcProductiveMs / 60000) > 600;
        const details = getCorrectionDetails(previewGroup);
        const formatTimeDisplay = (timeStr: string) => {
          if (!timeStr || timeStr === 'N/A') return 'N/A';
          try {
            return new Date(timeStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          } catch {
            return timeStr;
          }
        };

        const totalProdMins = Math.round(previewGroup.recalcProductiveMs / 60000);
        const excessMins = Math.max(0, totalProdMins - 600);

        return (
          <div className="fixed inset-0 bg-black/65 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className={`w-full max-w-xl rounded-2xl border p-6 overflow-hidden flex flex-col shadow-xl ${containerBg}`}>
              {/* Header */}
              <div className="flex justify-between items-center pb-4 border-b border-slate-800">
                <div>
                  <h3 className="text-base font-black uppercase tracking-tight text-slate-100 flex items-center gap-2">
                    <History size={16} className={isOver10h ? "text-rose-400" : "text-indigo-400"} />
                    {isOver10h ? 'Preview 10-Hour Cap Correction:' : 'Preview Correction:'} {previewGroup.userName}
                  </h3>
                  <p className="text-[10px] text-slate-400 mt-1">
                    {isOver10h
                      ? 'Derived Productive Time exceeds 600 minutes (10 hours). Capping derived metrics to 600m without changing timestamps or activities.'
                      : 'Operates at the attendance-cycle level. Adjusts effective Clock-Out on the latest session of the cycle.'}
                  </p>
                </div>
                <button 
                  onClick={() => setPreviewGroup(null)}
                  className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Comparison Panel */}
              <div className="py-6 space-y-5 flex-1">
                <div className="grid grid-cols-2 gap-4">
                  {/* Current (Stored) Column */}
                  <div className="p-4 rounded-xl bg-slate-950 border border-slate-850 space-y-3">
                    <p className="text-[10px] font-black uppercase tracking-wider text-rose-500 border-b border-slate-900 pb-1">
                      OLD (CURRENT VALUES)
                    </p>
                    <div className="space-y-1.5 font-mono text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Clock-In:</span>
                        <span className="text-slate-200">{formatTimeDisplay(previewGroup.firstClockIn)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Clock-Out:</span>
                        <span className="text-slate-200">{formatTimeDisplay(previewGroup.lastClockOut || details.originalClockOut)}</span>
                      </div>
                      <div className="flex justify-between font-bold text-rose-400 border-t border-slate-900/50 pt-1">
                        <span className="text-slate-400">Productive:</span>
                        <span>{formatMinsToHHMM(totalProdMins)} ({totalProdMins}m)</span>
                      </div>
                      <div className="flex justify-between border-t border-slate-900/50 pt-1">
                        <span className="text-slate-400">Utilization:</span>
                        <span>{previewGroup.recalcUtilization.toFixed(1)}%</span>
                      </div>
                    </div>
                  </div>

                  {/* Recalculated Column */}
                  <div className="p-4 rounded-xl bg-slate-950 border border-slate-850 space-y-3">
                    <p className="text-[10px] font-black uppercase tracking-wider text-emerald-500 border-b border-slate-900 pb-1">
                      NEW (PROPOSED VALUES)
                    </p>
                    <div className="space-y-1.5 font-mono text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Clock-In:</span>
                        <span className="text-slate-200">{formatTimeDisplay(previewGroup.firstClockIn)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Clock-Out:</span>
                        <span className="text-slate-200 text-emerald-400 font-bold">
                          {isOver10h ? `${formatTimeDisplay(previewGroup.lastClockOut)} (Unchanged)` : formatTimeDisplay(details.correctedClockOut)}
                        </span>
                      </div>
                      <div className="flex justify-between font-bold text-emerald-400 border-t border-slate-900/50 pt-1">
                        <span className="text-slate-400">Productive:</span>
                        <span>{isOver10h ? '10:00 (600m Cap)' : '08:00 (480m Target)'}</span>
                      </div>
                      <div className="flex justify-between border-t border-slate-900/50 pt-1">
                        <span className="text-slate-400">Utilization:</span>
                        <span>{isOver10h ? '125.0%' : '100.0%'}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Proposed changes highlighted */}
                {isOver10h ? (
                  <div className="p-4 rounded-xl bg-rose-950/25 border border-rose-500/25 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-wider text-rose-400 flex items-center gap-1">
                      <Sparkles size={11} />
                      10-Hour Cap Correction Details
                    </p>
                    <div className="space-y-1.5 text-xs text-rose-300 font-semibold font-mono">
                      <p>• Total Recalculated Productive: <span className="text-rose-200">{totalProdMins} mins</span></p>
                      <p>• Excess Productive Time: <span className="text-rose-400 font-bold">+{excessMins} mins over 600m</span></p>
                      <p>• Capped Productive Time: <span className="text-emerald-400 font-bold">600 mins (10:00:00)</span></p>
                      <p className="text-slate-300 text-[11px] font-normal mt-1 border-t border-rose-500/20 pt-1">
                        🛡️ <strong>Safety Guarantee:</strong> Timestamps (clockInTime/clockOutTime), raw activities[], shiftEventLedger, and process history WILL NOT BE MODIFIED.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 rounded-xl bg-indigo-950/25 border border-indigo-500/25 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-wider text-indigo-400 flex items-center gap-1">
                      <Sparkles size={11} />
                      Target Deficit & Correction Delta
                    </p>
                    <div className="space-y-1.5 text-xs text-indigo-300 font-semibold font-mono">
                      <p>
                        • Affected Session ID: <span className="text-indigo-200">{details.sessionToExtend?.id}</span>
                      </p>
                      <p>
                        • Original Clock-Out: <span className="text-indigo-200">{formatTimeDisplay(details.originalSessionOut)}</span>
                      </p>
                      <p>
                        • Corrected Clock-Out: <span className="text-emerald-400 font-bold">{formatTimeDisplay(details.correctedSessionOut)}</span>
                      </p>
                      <p className="text-amber-400 font-bold">
                        • Clock-Out change: +{details.productiveDelta.toFixed(1)} minutes
                      </p>
                    </div>
                  </div>
                )}

                {/* Audit Warning Statement (Requirement 10) */}
                <div className="p-3.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl text-[11px] leading-relaxed font-semibold">
                  <strong>Important Notice:</strong> This operation will modify historical derived shift data and/or effective Clock-Out timestamps. Raw chronological activity history will be preserved. This action will be permanently audited.
                </div>

                {/* Reason Input */}
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                    Correction Justification / Reason (Audited)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g., Target 8-hour shift productive deficit correction"
                    id="correctionReason"
                    className={`w-full px-3 py-2 rounded-xl text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-500 ${inputBg}`}
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="pt-4 border-t border-slate-800 flex justify-end gap-2">
                <button
                  onClick={() => setPreviewGroup(null)}
                  disabled={isCorrecting}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-705 text-white rounded-xl text-xs font-bold transition-all cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  disabled={isCorrecting}
                  onClick={() => {
                    const rInput = document.getElementById('correctionReason') as HTMLInputElement;
                    executeGroupCorrection(previewGroup, rInput?.value || '');
                  }}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-800 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50 active:scale-95 shadow-sm"
                >
                  {isCorrecting ? (
                    <RefreshCw size={13} className="animate-spin" />
                  ) : (
                    <CheckCircle2 size={13} />
                  )}
                  <span>Approve Historical Correction</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 9. Modal Dialog: Bulk Confirm Overlays (Requirement 10 & 11) */}
      {showBulkConfirm && (
        <div className="fixed inset-0 bg-black/65 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`w-full max-w-md rounded-2xl border p-6 overflow-hidden flex flex-col shadow-xl ${containerBg}`}>
            {/* Title */}
            <div className="pb-4 border-b border-slate-800 flex items-center gap-2">
              <AlertTriangle className="text-amber-500" size={20} />
              <h3 className="text-base font-black uppercase tracking-tight text-slate-100">
                Confirm Bulk Historical Correction
              </h3>
            </div>

            {/* Warning Message */}
            <div className="py-6 space-y-4">
              <p className="text-xs text-slate-300 leading-relaxed">
                You have selected <span className="font-extrabold text-indigo-400">{selectedGroupIds.size} records</span> for bulk correction. 
              </p>

              {/* Specific display (Requirement 11) */}
              <div className="p-3 bg-indigo-500/10 border border-indigo-500/25 rounded-lg text-indigo-300 font-extrabold text-xs text-center font-mono uppercase tracking-wider">
                {selectedGroupIds.size} records will be corrected
              </div>
              
              {/* Mandatory warning text (Requirement 10) */}
              <div className="p-3.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[11px] font-semibold rounded-lg leading-relaxed">
                This operation will modify historical derived shift data and/or effective Clock-Out timestamps. Raw chronological activity history will be preserved. This action will be permanently audited.
              </div>

              {/* Justification input */}
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                  Bulk Correction Justification (Audited)
                </label>
                <input
                  type="text"
                  placeholder="e.g., Bulk Clock-Out recovery to 8h productive target"
                  id="bulkCorrectionReason"
                  className={`w-full px-3 py-2 rounded-xl text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-500 ${inputBg}`}
                />
              </div>
            </div>

            {/* Buttons */}
            <div className="pt-4 border-t border-slate-800 flex justify-end gap-2">
              <button
                onClick={() => setShowBulkConfirm(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-705 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const reasonEl = document.getElementById('bulkCorrectionReason') as HTMLInputElement;
                  executeBulkCorrection(reasonEl?.value || '');
                }}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 shadow-sm active:scale-95"
              >
                <CheckCircle2 size={13} />
                <span>Approve Historical Correction</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 10. Modal Dialog: Bulk Correction Results Report (Requirement 12) */}
      {correctionReport && (
        <div className="fixed inset-0 bg-black/65 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`w-full max-w-2xl rounded-2xl border p-6 overflow-hidden flex flex-col max-h-[85vh] shadow-xl ${containerBg}`}>
            {/* Header */}
            <div className="flex justify-between items-center pb-4 border-b border-slate-800">
              <div>
                <h3 className="text-base font-black uppercase tracking-tight text-slate-100 flex items-center gap-2">
                  <FileText size={16} className="text-emerald-400" />
                  Bulk Correction Audit Report
                </h3>
                <p className="text-[10px] text-slate-400 mt-1 uppercase">
                  Execution completed. Final status and details below.
                </p>
              </div>
              <button 
                onClick={() => setCorrectionReport(null)}
                className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {/* Stats Summary */}
            <div className="grid grid-cols-3 gap-4 py-4 border-b border-slate-800">
              <div className="p-3 bg-emerald-500/15 border border-emerald-500/20 text-center rounded-xl">
                <span className="block text-[10px] font-bold text-emerald-400 uppercase">Success</span>
                <span className="text-lg font-black text-emerald-400">{correctionReport.filter(r => r.status === 'SUCCESS').length}</span>
              </div>
              <div className="p-3 bg-amber-500/15 border border-amber-500/20 text-center rounded-xl">
                <span className="block text-[10px] font-bold text-amber-400 uppercase">Skipped</span>
                <span className="text-lg font-black text-amber-400">{correctionReport.filter(r => r.status === 'SKIPPED').length}</span>
              </div>
              <div className="p-3 bg-rose-500/15 border border-rose-500/20 text-center rounded-xl">
                <span className="block text-[10px] font-bold text-rose-400 uppercase">Failed</span>
                <span className="text-lg font-black text-rose-400">{correctionReport.filter(r => r.status === 'FAILED').length}</span>
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto py-4 space-y-2">
              {correctionReport.map((rep, idx) => {
                let badgeClass = '';
                if (rep.status === 'SUCCESS') badgeClass = 'bg-emerald-500/15 text-emerald-500';
                else if (rep.status === 'SKIPPED') badgeClass = 'bg-amber-500/15 text-amber-500';
                else badgeClass = 'bg-rose-500/15 text-rose-500';

                return (
                  <div key={idx} className="p-3 rounded-xl bg-slate-950 border border-slate-850 flex justify-between items-center text-xs font-medium">
                    <div>
                      <p className="font-semibold text-slate-200">{rep.userName}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">Date: {rep.attendanceDate} • {rep.message}</p>
                    </div>
                    <div>
                      <span className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase ${badgeClass}`}>
                        {rep.status}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer with Download */}
            <div className="pt-4 border-t border-slate-800 flex justify-between items-center">
              <button
                onClick={() => downloadCsvReport(correctionReport)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 shadow-sm"
              >
                <Download size={13} />
                <span>Download Report (CSV)</span>
              </button>
              <button
                onClick={() => setCorrectionReport(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-705 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                Close Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
