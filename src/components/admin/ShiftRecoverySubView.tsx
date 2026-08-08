import React, { useState, useEffect, useMemo, useRef } from 'react';
import { db, auth } from '../../lib/firebase';
import { 
  collection, 
  getDocs, 
  getDoc,
  doc, 
  updateDoc, 
  writeBatch, 
  query, 
  where, 
  orderBy, 
  limit, 
  startAfter,
  getCountFromServer,
  addDoc,
  DocumentSnapshot
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
  Pause
} from 'lucide-react';
import { toast } from 'sonner';
import { UserProfile, ShiftEvent } from '../../types';
import { appendShiftEvent } from '../../lib/shiftLedger';

interface ShiftRecoverySubViewProps {
  user: UserProfile;
  adminTheme: 'light' | 'dark';
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export interface CandidateShift {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  clockInTime: string; // ISO
  currentClockOutTime?: string; // ISO
  recoveredClockOutTime: string; // ISO
  currentDurationMins: number;
  recoveredDurationMins: number;
  productiveMinutes: number;
  breakMinutes: number;
  currentUtilization: number;
  recoveredUtilization: number;
  recoverySource: 'Priority 1: Activity Timeline' | 'Priority 2: Timeline Events' | 'Priority 3: Attendance Summary' | 'Priority 4: User Logout Timestamp';
  priorityLevel: 1 | 2 | 3 | 4;
  confidenceScore: number; // e.g. 100, 95, 90, 80, 70
  requiresManualReview: boolean;
  reviewReason?: string;
  status: string;
  remarks?: string;
  activities: any[];
  timeline: any[];
  shiftEventLedger?: ShiftEvent[];
  version?: number;
}

export interface RecoveryAuditRecord {
  id: string;
  shiftId: string;
  userId: string;
  userName: string;
  userEmail: string;
  previousValues: {
    clockOutTime?: string;
    shiftDuration: number;
    utilization: number;
    status: string;
  };
  newValues: {
    clockOutTime: string;
    shiftDuration: number;
    utilization: number;
    status: string;
  };
  recoverySource: string;
  confidence: number;
  requiresManualReview: boolean;
  recoveryTimestamp: string;
  approvedBy: string;
}

export const ShiftRecoverySubView: React.FC<ShiftRecoverySubViewProps> = ({
  user,
  adminTheme,
  logAdminEvent
}) => {
  const [activeTab, setActiveTab] = useState<'scanner' | 'history'>('scanner');
  
  // Scanning state
  const [isScanning, setIsScanning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [scanCompleted, setScanCompleted] = useState(false);
  const [totalShiftsInDb, setTotalShiftsInDb] = useState(0);
  const [totalShiftsScanned, setTotalShiftsScanned] = useState(0);
  const [healthyShiftsCount, setHealthyShiftsCount] = useState(0);
  const [candidates, setCandidates] = useState<CandidateShift[]>([]);
  const [selectedShiftIds, setSelectedShiftIds] = useState<Set<string>>(new Set());

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'ALL' | 'PRIORITY_1' | 'PRIORITY_2' | 'PRIORITY_3' | 'PRIORITY_4'>('ALL');
  const [reviewFilter, setReviewFilter] = useState<'ALL' | 'REVIEW_NEEDED' | 'AUTO_APPROVED'>('ALL');

  // Modal states
  const [selectedCandidateDetail, setSelectedCandidateDetail] = useState<CandidateShift | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmInputText, setConfirmInputText] = useState('');

  // Audit history state
  const [auditLogs, setAuditLogs] = useState<RecoveryAuditRecord[]>([]);
  const [isLoadingAudit, setIsLoadingAudit] = useState(false);

  // Scanner engine refs
  const lastDocRef = useRef<DocumentSnapshot | null>(null);
  const isPausedRef = useRef<boolean>(false);
  const isCancelledRef = useRef<boolean>(false);
  const attendanceCache = useRef<Map<string, any>>(new Map());
  const userCache = useRef<Map<string, any>>(new Map());

  // Point-lookup for single attendance record
  const fetchSingleAttendance = async (userId: string, dateStr: string) => {
    const cacheKey = `${userId}_${dateStr}`;
    if (attendanceCache.current.has(cacheKey)) {
      return attendanceCache.current.get(cacheKey);
    }

    try {
      const q = query(
        collection(db, 'attendanceSummary'),
        where('userId', '==', userId),
        where('attendanceDate', '==', dateStr),
        limit(1)
      );
      const snap = await getDocs(q);
      let record: any = null;
      if (!snap.empty) {
        record = snap.docs[0].data();
      } else {
        const q2 = query(
          collection(db, 'attendanceSummary'),
          where('userId', '==', userId),
          where('date', '==', dateStr),
          limit(1)
        );
        const snap2 = await getDocs(q2);
        if (!snap2.empty) {
          record = snap2.docs[0].data();
        }
      }
      attendanceCache.current.set(cacheKey, record);
      return record;
    } catch (err) {
      attendanceCache.current.set(cacheKey, null);
      return null;
    }
  };

  // Point-lookup for single user profile
  const fetchSingleUser = async (userId: string) => {
    if (userCache.current.has(userId)) {
      return userCache.current.get(userId);
    }

    try {
      const uSnap = await getDoc(doc(db, 'users', userId));
      const uData = uSnap.exists() ? uSnap.data() : null;
      userCache.current.set(userId, uData);
      return uData;
    } catch (err) {
      userCache.current.set(userId, null);
      return null;
    }
  };

  // Start new paginated scan from page 1
  const startNewScan = async () => {
    setIsScanning(true);
    setIsPaused(false);
    setScanCompleted(false);
    setTotalShiftsScanned(0);
    setHealthyShiftsCount(0);
    setCandidates([]);
    setSelectedShiftIds(new Set());

    lastDocRef.current = null;
    isPausedRef.current = false;
    isCancelledRef.current = false;
    attendanceCache.current.clear();
    userCache.current.clear();

    let totalCount = 0;
    try {
      const countSnap = await getCountFromServer(collection(db, 'tmsShifts'));
      totalCount = countSnap.data().count;
    } catch (err) {
      console.warn('getCountFromServer fallback:', err);
    }
    setTotalShiftsInDb(totalCount);

    toast.info(`Starting paginated scan across ${totalCount > 0 ? totalCount.toLocaleString() : 'all'} historical shifts...`);

    await runPaginatedScanLoop(totalCount);
  };

  // Pause ongoing scan
  const pauseScan = () => {
    isPausedRef.current = true;
    setIsPaused(true);
    setIsScanning(false);
    toast.info('Scan paused. Candidate preview preserved.');
  };

  // Resume paused scan
  const resumeScan = async () => {
    if (scanCompleted) return;
    isPausedRef.current = false;
    setIsPaused(false);
    setIsScanning(true);
    toast.info('Resuming historical scan...');
    await runPaginatedScanLoop(totalShiftsInDb);
  };

  // Stop scan completely
  const stopScan = () => {
    isCancelledRef.current = true;
    isPausedRef.current = false;
    setIsPaused(false);
    setIsScanning(false);
    toast.info('Scan stopped.');
  };

  // Core paginated scan loop (Processes 100 shifts per batch and releases memory)
  const runPaginatedScanLoop = async (totalCount: number) => {
    const PAGE_SIZE = 100;

    try {
      while (!isCancelledRef.current && !isPausedRef.current) {
        let q;
        if (lastDocRef.current) {
          q = query(
            collection(db, 'tmsShifts'),
            startAfter(lastDocRef.current),
            limit(PAGE_SIZE)
          );
        } else {
          q = query(
            collection(db, 'tmsShifts'),
            limit(PAGE_SIZE)
          );
        }

        const pageSnap = await getDocs(q);
        if (pageSnap.empty) {
          setScanCompleted(true);
          toast.success('Scan completed: All historical shifts analyzed!');
          break;
        }

        const pageDocs = pageSnap.docs;
        lastDocRef.current = pageDocs[pageDocs.length - 1];

        const pageCandidates: CandidateShift[] = [];
        let pageHealthyCount = 0;
        const pageAutoSelectIds: string[] = [];

        for (const docSnap of pageDocs) {
          const sh: any = Object.assign({ id: docSnap.id }, docSnap.data());

          const clockIn = sh.clockInTime;
          if (!clockIn || typeof clockIn !== 'string') {
            pageHealthyCount++;
            continue;
          }

          const clockInMs = new Date(clockIn).getTime();
          if (isNaN(clockInMs)) {
            pageHealthyCount++;
            continue;
          }

          const shiftDateStr = clockIn.substring(0, 10);
          const currentClockOut = sh.clockOutTime || sh.endShiftTime;
          const currentClockOutMs = currentClockOut ? new Date(currentClockOut).getTime() : 0;

          // Skip active/break shifts if ongoing (< 16h age)
          const statusNorm = (sh.status || '').toUpperCase();
          if ((statusNorm === 'ACTIVE' || statusNorm === 'BREAK') && (!currentClockOut || currentClockOut === '')) {
            const shiftAgeHours = (Date.now() - clockInMs) / (1000 * 3600);
            if (shiftAgeHours < 16) {
              pageHealthyCount++;
              continue;
            }
          }

          const activities: any[] = Array.isArray(sh.activities) ? sh.activities : [];
          const timeline: any[] = Array.isArray(sh.timeline) ? sh.timeline : [];

          let lastActivityEndMs = 0;
          let lastActivityEndStr = '';
          let productiveMins = 0;
          let breakMins = 0;

          activities.forEach(act => {
            const startMs = act.startTime ? new Date(act.startTime).getTime() : 0;
            const endMs = act.endTime ? new Date(act.endTime).getTime() : startMs;

            if (endMs > lastActivityEndMs && !isNaN(endMs)) {
              lastActivityEndMs = endMs;
              lastActivityEndStr = act.endTime || act.startTime;
            }

            if (startMs > 0 && endMs >= startMs) {
              const dur = Math.round((endMs - startMs) / 60000);
              const actType = (act.type || act.name || '').toLowerCase();
              if (actType.includes('break') || actType.includes('meal') || actType.includes('pause')) {
                breakMins += dur;
              } else {
                productiveMins += dur;
              }
            }
          });

          let lastTimelineMs = 0;
          let lastTimelineStr = '';
          timeline.forEach(item => {
            const tMs = item.endTime ? new Date(item.endTime).getTime() : (item.timestamp ? new Date(item.timestamp).getTime() : 0);
            if (tMs > lastTimelineMs && !isNaN(tMs)) {
              lastTimelineMs = tMs;
              lastTimelineStr = item.endTime || item.timestamp;
            }
          });

          let recoveredClockOutTime: string | null = null;
          let recoverySource: CandidateShift['recoverySource'] = 'Priority 1: Activity Timeline';
          let priorityLevel: CandidateShift['priorityLevel'] = 1;
          let confidenceScore = 100;

          // Priority 1: Activity Timeline
          if (lastActivityEndMs > clockInMs) {
            recoveredClockOutTime = lastActivityEndStr || new Date(lastActivityEndMs).toISOString();
            recoverySource = 'Priority 1: Activity Timeline';
            priorityLevel = 1;
            confidenceScore = 100;
          }
          // Priority 2: Timeline Event Log
          else if (lastTimelineMs > clockInMs) {
            recoveredClockOutTime = lastTimelineStr || new Date(lastTimelineMs).toISOString();
            recoverySource = 'Priority 2: Timeline Events';
            priorityLevel = 2;
            confidenceScore = 90;
          }
          // Priority 3: Point lookup for Attendance Summary Record
          else if (sh.userId) {
            const attRecord = await fetchSingleAttendance(sh.userId, shiftDateStr);
            if (attRecord && attRecord.sessionEnd) {
              const attEndMs = new Date(attRecord.sessionEnd).getTime();
              if (attEndMs > clockInMs) {
                recoveredClockOutTime = attRecord.sessionEnd;
                recoverySource = 'Priority 3: Attendance Summary';
                priorityLevel = 3;
                confidenceScore = 80;
              }
            }
          }

          // Priority 4: Point lookup for User Logout Timestamp
          if (!recoveredClockOutTime && sh.userId) {
            const userRec = await fetchSingleUser(sh.userId);
            if (userRec && userRec.lastLogoutAt) {
              const logoutMs = new Date(userRec.lastLogoutAt).getTime();
              if (logoutMs > clockInMs && (userRec.lastLogoutAt.substring(0, 10) === shiftDateStr)) {
                recoveredClockOutTime = userRec.lastLogoutAt;
                recoverySource = 'Priority 4: User Logout Timestamp';
                priorityLevel = 4;
                confidenceScore = 70;
              }
            }
          }

          if (!recoveredClockOutTime) {
            pageHealthyCount++;
            continue;
          }

          const recoveredClockOutMs = new Date(recoveredClockOutTime).getTime();

          const currentDurMins = (currentClockOutMs > clockInMs) 
            ? Math.round((currentClockOutMs - clockInMs) / 60000) 
            : 0;

          const recoveredDurMins = Math.round((recoveredClockOutMs - clockInMs) / 60000);

          const currentUtil = sh.utilization ?? sh.finalUtilization ?? (currentDurMins > 0 ? Math.min(100, Math.round((productiveMins / currentDurMins) * 1000) / 10) : 0);
          const recoveredUtil = recoveredDurMins > 0 
            ? Math.min(100, Math.round((productiveMins / recoveredDurMins) * 1000) / 10) 
            : 0;

          const timeDiffMins = Math.abs((currentClockOutMs - recoveredClockOutMs) / 60000);
          const isClockOutMissing = !currentClockOut || currentClockOutMs === 0;
          const isClockOutTruncated = (currentClockOutMs > 0 && recoveredClockOutMs > currentClockOutMs + 5 * 60000);
          const isUtilizationDistorted = (currentDurMins < productiveMins) || (currentUtil === 0 && productiveMins > 0);
          const isAutoClosedStale = statusNorm === 'AUTO_CLOSED' && (recoveredClockOutMs > currentClockOutMs + 2 * 60000);

          const isSuspicious = isClockOutMissing || isClockOutTruncated || isUtilizationDistorted || isAutoClosedStale || (timeDiffMins > 5);

          if (!isSuspicious) {
            pageHealthyCount++;
            continue;
          }

          let requiresManualReview = false;
          let reviewReason = '';

          if (confidenceScore < 90) {
            requiresManualReview = true;
            reviewReason = `Low confidence recovery source (${recoverySource})`;
          } else if (recoveredDurMins > 16 * 60) {
            requiresManualReview = true;
            reviewReason = `Unusually long shift duration (${(recoveredDurMins / 60).toFixed(1)} hours)`;
          } else if (recoveredDurMins < 15) {
            requiresManualReview = true;
            reviewReason = `Extremely short shift duration (${recoveredDurMins} mins)`;
          } else if (Math.abs(recoveredClockOutMs - clockInMs) > 24 * 3600 * 1000) {
            requiresManualReview = true;
            reviewReason = `Shift spans across multiple days`;
          }

          const cand: CandidateShift = {
            id: sh.id,
            userId: sh.userId || 'Unknown',
            userName: sh.userName || sh.userEmail || 'Unknown User',
            userEmail: sh.userEmail || '',
            clockInTime: clockIn,
            currentClockOutTime: currentClockOut || undefined,
            recoveredClockOutTime,
            currentDurationMins: currentDurMins,
            recoveredDurationMins: recoveredDurMins,
            productiveMinutes: productiveMins,
            breakMinutes: breakMins,
            currentUtilization: currentUtil,
            recoveredUtilization: recoveredUtil,
            recoverySource,
            priorityLevel,
            confidenceScore,
            requiresManualReview,
            reviewReason,
            status: sh.status || 'AUTO_CLOSED',
            remarks: sh.remarks || '',
            activities,
            timeline,
            shiftEventLedger: sh.shiftEventLedger,
            version: sh.version || 1
          };

          pageCandidates.push(cand);
          if (!cand.requiresManualReview && cand.confidenceScore >= 90) {
            pageAutoSelectIds.push(cand.id);
          }
        } // end pageDocs loop

        setTotalShiftsScanned(prev => prev + pageDocs.length);
        setHealthyShiftsCount(prev => prev + pageHealthyCount);

        if (pageCandidates.length > 0) {
          setCandidates(prev => [...prev, ...pageCandidates]);
        }

        if (pageAutoSelectIds.length > 0) {
          setSelectedShiftIds(prev => {
            const next = new Set(prev);
            pageAutoSelectIds.forEach(id => next.add(id));
            return next;
          });
        }

        if (pageDocs.length < PAGE_SIZE) {
          setScanCompleted(true);
          toast.success('Scan completed: All historical shifts analyzed.');
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 30));
      }
    } catch (err: any) {
      console.error('Paginated scan error:', err);
      toast.error(`Scan error: ${err.message || 'Unknown error'}`);
    } finally {
      setIsScanning(false);
    }
  };

  // Fetch Audit History
  const fetchAuditHistory = async () => {
    setIsLoadingAudit(true);
    try {
      const q = query(
        collection(db, 'shiftRecoveryAuditLogs'),
        orderBy('recoveryTimestamp', 'desc'),
        limit(100)
      );
      const snap = await getDocs(q);
      const logs: RecoveryAuditRecord[] = snap.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as RecoveryAuditRecord[];
      setAuditLogs(logs);
    } catch (err) {
      console.warn('Failed to load recovery audit history:', err);
    } finally {
      setIsLoadingAudit(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'history') {
      fetchAuditHistory();
    }
  }, [activeTab]);

  // Filtered candidate list
  const filteredCandidates = useMemo(() => {
    return candidates.filter(cand => {
      // Search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const nameMatch = cand.userName.toLowerCase().includes(q);
        const emailMatch = cand.userEmail.toLowerCase().includes(q);
        const idMatch = cand.id.toLowerCase().includes(q);
        const dateMatch = cand.clockInTime.includes(q);
        if (!nameMatch && !emailMatch && !idMatch && !dateMatch) return false;
      }

      // Priority source filter
      if (sourceFilter === 'PRIORITY_1' && cand.priorityLevel !== 1) return false;
      if (sourceFilter === 'PRIORITY_2' && cand.priorityLevel !== 2) return false;
      if (sourceFilter === 'PRIORITY_3' && cand.priorityLevel !== 3) return false;
      if (sourceFilter === 'PRIORITY_4' && cand.priorityLevel !== 4) return false;

      // Review filter
      if (reviewFilter === 'REVIEW_NEEDED' && !cand.requiresManualReview) return false;
      if (reviewFilter === 'AUTO_APPROVED' && cand.requiresManualReview) return false;

      return true;
    });
  }, [candidates, searchQuery, sourceFilter, reviewFilter]);

  // Total recoverable hours
  const totalRecoverableHours = useMemo(() => {
    let mins = 0;
    candidates.forEach(c => {
      if (selectedShiftIds.has(c.id)) {
        mins += Math.max(0, c.recoveredDurationMins - c.currentDurationMins);
      }
    });
    return (mins / 60).toFixed(1);
  }, [candidates, selectedShiftIds]);

  // Selection toggle helpers
  const toggleSelectShift = (id: string) => {
    setSelectedShiftIds(prev => {
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
    const next = new Set(selectedShiftIds);
    filteredCandidates.forEach(c => next.add(c.id));
    setSelectedShiftIds(next);
  };

  const selectHighConfidenceFiltered = () => {
    const next = new Set(selectedShiftIds);
    filteredCandidates.forEach(c => {
      if (c.confidenceScore >= 90 && !c.requiresManualReview) {
        next.add(c.id);
      }
    });
    setSelectedShiftIds(next);
  };

  const clearSelection = () => {
    setSelectedShiftIds(new Set());
  };

  // Execute Approved Recoveries
  const executeApprovedRecoveries = async () => {
    if (selectedShiftIds.size === 0) {
      toast.error('No candidate shifts selected for recovery.');
      return;
    }

    setIsExecuting(true);
    try {
      const approvedCandidates = candidates.filter(c => selectedShiftIds.has(c.id));
      const actorName = user.employeeName || user.fullName || user.email.split('@')[0];
      const actorEmail = user.email;
      const nowISO = new Date().toISOString();

      let successCount = 0;

      // Process in batches of 200 items (well within Firestore 500 limit)
      const BATCH_SIZE = 200;
      for (let i = 0; i < approvedCandidates.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        const batchCandidates = approvedCandidates.slice(i, i + BATCH_SIZE);

        for (const cand of batchCandidates) {
          const shiftRef = doc(db, 'tmsShifts', cand.id);
          const shiftDurMs = cand.recoveredDurationMins * 60 * 1000;
          const shiftHours = Math.floor(cand.recoveredDurationMins / 60);
          const shiftMins = cand.recoveredDurationMins % 60;
          const prodHours = Math.floor(cand.productiveMinutes / 60);
          const prodMins = cand.productiveMinutes % 60;
          const breakHours = Math.floor(cand.breakMinutes / 60);
          const breakMins = cand.breakMinutes % 60;

          const updatedLedger = appendShiftEvent(
            cand.shiftEventLedger,
            cand,
            {
              eventType: 'SHIFT_RECOVERY',
              timestamp: nowISO,
              performedBy: `Admin: ${actorName}`,
              source: 'Recovery Tool',
              reason: `Recovered clockOutTime via ${cand.recoverySource} by ${actorName}`,
              oldValue: cand.currentClockOutTime || 'MISSING',
              newValue: cand.recoveredClockOutTime,
              confidence: cand.confidenceScore,
              remarks: `Confidence Score: ${cand.confidenceScore}%. ${cand.reviewReason || ''}`
            }
          );

          // Update shift doc
          batch.update(shiftRef, {
            clockOutTime: cand.recoveredClockOutTime,
            endShiftTime: cand.recoveredClockOutTime,
            shiftDuration: shiftDurMs,
            productiveMinutes: cand.productiveMinutes,
            breakMinutes: cand.breakMinutes,
            utilization: cand.recoveredUtilization,
            finalUtilization: cand.recoveredUtilization,
            totalShiftTime: `${shiftHours}h ${shiftMins}m`,
            totalProductiveTime: `${prodHours}h ${prodMins}m`,
            totalBreakTime: `${breakHours}h ${breakMins}m`,
            status: 'COMPLETED',
            locked: true,
            lockedAt: nowISO,
            version: (cand.version || 1) + 1,
            remarks: `Recovered clockOutTime via ${cand.recoverySource} by ${actorName}`,
            shiftEventLedger: updatedLedger,
            updatedAt: nowISO
          });

          // Create audit log doc
          const auditRef = doc(collection(db, 'shiftRecoveryAuditLogs'));
          batch.set(auditRef, {
            shiftId: cand.id,
            userId: cand.userId,
            userName: cand.userName,
            userEmail: cand.userEmail,
            previousValues: {
              clockOutTime: cand.currentClockOutTime || 'MISSING',
              shiftDuration: cand.currentDurationMins,
              utilization: cand.currentUtilization,
              status: cand.status
            },
            newValues: {
              clockOutTime: cand.recoveredClockOutTime,
              shiftDuration: cand.recoveredDurationMins,
              utilization: cand.recoveredUtilization,
              status: 'COMPLETED'
            },
            recoverySource: cand.recoverySource,
            confidence: cand.confidenceScore,
            requiresManualReview: cand.requiresManualReview,
            recoveryTimestamp: nowISO,
            approvedBy: `${actorName} (${actorEmail})`
          });

          successCount++;
        }

        await batch.commit();
      }

      // Log master admin audit event
      await logAdminEvent(
        'Execute Historical Shift Recovery',
        `${successCount} Shifts`,
        'Corrupted/Truncated ClockOut Values',
        `Recovered and Locked ${successCount} Shifts`
      );

      toast.success(`Successfully recovered and locked ${successCount} shift records!`);

      // Remove recovered items from candidate list
      setCandidates(prev => prev.filter(c => !selectedShiftIds.has(c.id)));
      setSelectedShiftIds(new Set());
      setShowConfirmModal(false);
      setConfirmInputText('');

      // Refresh audit history if tab open
      if (activeTab === 'history') {
        fetchAuditHistory();
      }
    } catch (err: any) {
      console.error('Execution error:', err);
      toast.error(`Failed to execute recovery: ${err.message || 'Unknown error'}`);
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="space-y-6 antialiased">
      {/* Top Banner Header */}
      <div className={`p-6 rounded-3xl border shadow-sm transition-colors ${
        adminTheme === 'dark' 
          ? 'bg-slate-800/80 border-slate-700/80 text-white' 
          : 'bg-white border-slate-200 text-slate-900'
      }`}>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">
              <RotateCcw size={24} className="animate-pulse" />
            </div>
            <div>
              <h3 className="text-lg font-black uppercase tracking-tight flex items-center gap-2">
                Historical Shift Recovery Tool
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 font-mono font-bold uppercase">
                  ADMIN ONLY
                </span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Scan, preview, and safely restore corrupted or truncated clockOutTime values using immutable activity timelines.
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setActiveTab('scanner')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${
                activeTab === 'scanner'
                  ? 'bg-indigo-600 text-white border-indigo-500 shadow-md'
                  : adminTheme === 'dark'
                    ? 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-600'
                    : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <RotateCcw size={14} /> Preview Scanner
            </button>

            <button
              onClick={() => setActiveTab('history')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${
                activeTab === 'history'
                  ? 'bg-indigo-600 text-white border-indigo-500 shadow-md'
                  : adminTheme === 'dark'
                    ? 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-600'
                    : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <History size={14} /> Recovery Audit Log
            </button>

            {isScanning ? (
              <button
                onClick={pauseScan}
                className="px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-amber-500 hover:bg-amber-400 text-white shadow-md transition-all flex items-center gap-2 cursor-pointer"
              >
                <Pause size={14} /> Pause Scan
              </button>
            ) : isPaused ? (
              <button
                onClick={resumeScan}
                className="px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-emerald-600 hover:bg-emerald-500 text-white shadow-md transition-all flex items-center gap-2 cursor-pointer"
              >
                <Play size={14} /> Resume Scan
              </button>
            ) : (
              <button
                onClick={startNewScan}
                className="px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md hover:from-indigo-500 hover:to-violet-500 transition-all flex items-center gap-2 cursor-pointer"
              >
                <RefreshCw size={14} />
                {scanCompleted || totalShiftsScanned > 0 ? 'Restart Scan' : 'Run Forensic Scan'}
              </button>
            )}
          </div>
        </div>
      </div>

      {activeTab === 'scanner' && (
        <div className="space-y-6">
          {/* Scan Progress & Control Card */}
          {(totalShiftsScanned > 0 || isScanning || isPaused) && (
            <div className={`p-5 rounded-2xl border ${
              adminTheme === 'dark' ? 'bg-slate-800/80 border-slate-700' : 'bg-white border-slate-200'
            }`}>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Paginated Scan Engine Progress
                    </span>
                    {isScanning && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 font-bold uppercase animate-pulse flex items-center gap-1">
                        <RefreshCw size={10} className="animate-spin" /> Scanning
                      </span>
                    )}
                    {isPaused && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20 font-bold uppercase flex items-center gap-1">
                        <Pause size={10} /> Paused
                      </span>
                    )}
                    {scanCompleted && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 font-bold uppercase flex items-center gap-1">
                        <CheckCircle2 size={10} /> Complete
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-black font-mono mt-1 text-slate-900 dark:text-white flex items-center gap-2">
                    <span>
                      Scanning {totalShiftsScanned.toLocaleString()} {totalShiftsInDb > 0 ? `/ ${totalShiftsInDb.toLocaleString()}` : 'shifts'}
                    </span>
                    {totalShiftsInDb > 0 && (
                      <span className="text-xs text-indigo-500 font-bold">
                        ({((totalShiftsScanned / totalShiftsInDb) * 100).toFixed(1)}%)
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isScanning && (
                    <button
                      onClick={pauseScan}
                      className="px-3.5 py-1.5 rounded-xl text-xs font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <Pause size={14} /> Pause
                    </button>
                  )}

                  {isPaused && (
                    <button
                      onClick={resumeScan}
                      className="px-3.5 py-1.5 rounded-xl text-xs font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <Play size={14} /> Resume
                    </button>
                  )}

                  {(isScanning || isPaused) && (
                    <button
                      onClick={stopScan}
                      className="px-3.5 py-1.5 rounded-xl text-xs font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <Square size={14} /> Stop
                    </button>
                  )}

                  {!isScanning && !isPaused && (
                    <button
                      onClick={startNewScan}
                      className="px-3.5 py-1.5 rounded-xl text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-500 transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
                    >
                      <RotateCcw size={14} /> {scanCompleted ? 'Restart Scan' : 'Start New Scan'}
                    </button>
                  )}
                </div>
              </div>

              {totalShiftsInDb > 0 && (
                <div className="mt-3 w-full bg-slate-100 dark:bg-slate-700/50 h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-indigo-600 h-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, (totalShiftsScanned / totalShiftsInDb) * 100))}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Statistics Bar */}
          {(totalShiftsScanned > 0 || scanCompleted) && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className={`p-4 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total Scanned</div>
                <div className="text-xl font-black mt-1 text-slate-900 dark:text-white">{totalShiftsScanned.toLocaleString()}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">{healthyShiftsCount.toLocaleString()} Healthy (Protected)</div>
              </div>

              <div className={`p-4 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-500">Suspicious Candidates</div>
                <div className="text-xl font-black mt-1 text-amber-500">{candidates.length}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">Corrupted / Truncated</div>
              </div>

              <div className={`p-4 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-500">Auto-Approved</div>
                <div className="text-xl font-black mt-1 text-emerald-500">
                  {candidates.filter(c => !c.requiresManualReview).length}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">High Confidence (&gt;= 90%)</div>
              </div>

              <div className={`p-4 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-rose-500">Needs Review</div>
                <div className="text-xl font-black mt-1 text-rose-500">
                  {candidates.filter(c => c.requiresManualReview).length}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">Manual Audit Recommended</div>
              </div>

              <div className={`p-4 rounded-2xl border ${adminTheme === 'dark' ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-500">Hours Recoverable</div>
                <div className="text-xl font-black mt-1 text-indigo-500">{totalRecoverableHours} hrs</div>
                <div className="text-[11px] text-slate-500 mt-0.5">Across {selectedShiftIds.size} Selected</div>
              </div>
            </div>
          )}

          {/* Search, Filter & Controls */}
          {(totalShiftsScanned > 0 || scanCompleted) && (
            <div className={`p-4 rounded-2xl border flex flex-col md:flex-row justify-between items-stretch md:items-center gap-3 ${
              adminTheme === 'dark' ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'
            }`}>
              {/* Search */}
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search by employee name, email, or date..."
                  className={`w-full pl-9 pr-3 py-1.5 rounded-xl text-xs font-medium border outline-none transition-all ${
                    adminTheme === 'dark' 
                      ? 'bg-slate-900 border-slate-700 text-white focus:border-indigo-500' 
                      : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-indigo-500'
                  }`}
                />
              </div>

              {/* Priority Source Filter */}
              <select
                value={sourceFilter}
                onChange={e => setSourceFilter(e.target.value as any)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border outline-none cursor-pointer ${
                  adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}
              >
                <option value="ALL">All Recovery Sources</option>
                <option value="PRIORITY_1">Priority 1: Activity Timeline (100%)</option>
                <option value="PRIORITY_2">Priority 2: Timeline Events (90%)</option>
                <option value="PRIORITY_3">Priority 3: Attendance Summary (80%)</option>
                <option value="PRIORITY_4">Priority 4: User Logout (70%)</option>
              </select>

              {/* Manual Review Filter */}
              <select
                value={reviewFilter}
                onChange={e => setReviewFilter(e.target.value as any)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border outline-none cursor-pointer ${
                  adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}
              >
                <option value="ALL">All Candidate Statuses</option>
                <option value="AUTO_APPROVED">Auto-Approved (No Review Needed)</option>
                <option value="REVIEW_NEEDED">Requires Manual Review Only</option>
              </select>

              {/* Selection actions */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={selectHighConfidenceFiltered}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all cursor-pointer"
                >
                  Select High Confidence
                </button>
                <button
                  onClick={selectAllFiltered}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20 transition-all cursor-pointer"
                >
                  Select All
                </button>
                <button
                  onClick={clearSelection}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20 hover:bg-slate-500/20 transition-all cursor-pointer"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Main Candidates Data Table */}
          {totalShiftsScanned === 0 && !isScanning && !isPaused && !scanCompleted ? (
            <div className={`p-12 rounded-3xl border text-center space-y-4 ${
              adminTheme === 'dark' ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'
            }`}>
              <RotateCcw size={40} className="text-indigo-500 mx-auto" />
              <div>
                <h4 className="text-base font-bold text-slate-900 dark:text-white">Ready for High-Performance Forensic Recovery Scan</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto mt-1">
                  Processes 100,000+ shift records page-by-page using zero-preload memory management.
                </p>
              </div>
              <button
                onClick={startNewScan}
                className="px-6 py-2.5 rounded-2xl text-xs font-black uppercase tracking-wider bg-indigo-600 text-white shadow-lg hover:bg-indigo-500 transition-all cursor-pointer"
              >
                Start Historical Scan
              </button>
            </div>
          ) : (
            <div className={`rounded-3xl border overflow-hidden shadow-sm ${
              adminTheme === 'dark' ? 'bg-slate-800/80 border-slate-700' : 'bg-white border-slate-200'
            }`}>
              {/* Live status banner when scanning */}
              {isScanning && (
                <div className="px-4 py-2 bg-indigo-500/10 border-b border-indigo-500/20 text-indigo-600 dark:text-indigo-400 text-xs font-bold flex items-center gap-2">
                  <RefreshCw size={12} className="animate-spin" />
                  <span>Scanning in progress... Preview updating live ({totalShiftsScanned.toLocaleString()} shifts processed so far).</span>
                </div>
              )}
              {isPaused && (
                <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-bold flex items-center gap-2">
                  <Pause size={12} />
                  <span>Scan paused at {totalShiftsScanned.toLocaleString()} shifts. Click "Resume" to continue scanning.</span>
                </div>
              )}

              {/* Table header bar */}
              <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center bg-slate-50/50 dark:bg-slate-900/40">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Preview Report ({filteredCandidates.length} candidate shifts)
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-indigo-500 dark:text-indigo-400">
                    {selectedShiftIds.size} shift(s) selected
                  </span>

                  <button
                    onClick={() => {
                      setConfirmInputText('');
                      setShowConfirmModal(true);
                    }}
                    disabled={selectedShiftIds.size === 0 || isExecuting}
                    className="px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-emerald-600 hover:bg-emerald-500 text-white shadow-md disabled:opacity-40 transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <Lock size={13} />
                    Execute Approved Recoveries ({selectedShiftIds.size})
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className={`text-[11px] font-black uppercase tracking-wider border-b ${
                      adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-700 text-slate-400' : 'bg-slate-100/80 border-slate-200 text-slate-600'
                    }`}>
                      <th className="p-3 w-10 text-center">
                        <button 
                          onClick={() => {
                            if (selectedShiftIds.size === filteredCandidates.length) {
                              clearSelection();
                            } else {
                              selectAllFiltered();
                            }
                          }}
                          className="cursor-pointer"
                        >
                          {selectedShiftIds.size === filteredCandidates.length && filteredCandidates.length > 0 ? (
                            <CheckSquare size={16} className="text-indigo-500" />
                          ) : (
                            <Square size={16} className="text-slate-400" />
                          )}
                        </button>
                      </th>
                      <th className="p-3">Employee</th>
                      <th className="p-3">Shift Date</th>
                      <th className="p-3">Current Clock-In</th>
                      <th className="p-3">Current Clock-Out</th>
                      <th className="p-3 text-emerald-600 dark:text-emerald-400">Recovered Clock-Out</th>
                      <th className="p-3 text-center">Cur Util</th>
                      <th className="p-3 text-center text-emerald-600 dark:text-emerald-400">Rec Util</th>
                      <th className="p-3">Recovery Source</th>
                      <th className="p-3 text-center">Confidence</th>
                      <th className="p-3 text-center">Review?</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-700/60 text-xs font-medium">
                    {filteredCandidates.map(cand => {
                      const isSelected = selectedShiftIds.has(cand.id);
                      const shiftDate = cand.clockInTime.substring(0, 10);
                      const clockInFormatted = new Date(cand.clockInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                      const clockOutFormatted = cand.currentClockOutTime 
                        ? new Date(cand.currentClockOutTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : 'MISSING';
                      const recClockOutFormatted = new Date(cand.recoveredClockOutTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                      return (
                        <tr 
                          key={cand.id} 
                          className={`transition-colors ${
                            isSelected 
                              ? adminTheme === 'dark' ? 'bg-indigo-950/30' : 'bg-indigo-50/60'
                              : 'hover:bg-slate-500/5'
                          }`}
                        >
                          <td className="p-3 text-center">
                            <button onClick={() => toggleSelectShift(cand.id)} className="cursor-pointer">
                              {isSelected ? (
                                <CheckSquare size={16} className="text-indigo-500" />
                              ) : (
                                <Square size={16} className="text-slate-400" />
                              )}
                            </button>
                          </td>

                          <td className="p-3 font-semibold">
                            <div className="text-slate-900 dark:text-white">{cand.userName}</div>
                            <div className="text-[10px] text-slate-400">{cand.userEmail}</div>
                          </td>

                          <td className="p-3 font-mono text-slate-600 dark:text-slate-300">
                            {shiftDate}
                          </td>

                          <td className="p-3 font-mono text-slate-600 dark:text-slate-300">
                            {clockInFormatted}
                          </td>

                          <td className="p-3 font-mono text-rose-500 line-through">
                            {clockOutFormatted}
                          </td>

                          <td className="p-3 font-mono font-bold text-emerald-600 dark:text-emerald-400">
                            {recClockOutFormatted}
                          </td>

                          <td className="p-3 text-center font-mono text-slate-500">
                            {cand.currentUtilization}%
                          </td>

                          <td className="p-3 text-center font-mono font-bold text-emerald-600 dark:text-emerald-400">
                            {cand.recoveredUtilization}%
                          </td>

                          <td className="p-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                              cand.priorityLevel === 1 
                                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                                : cand.priorityLevel === 2
                                ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20'
                                : cand.priorityLevel === 3
                                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                                : 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20'
                            }`}>
                              {cand.recoverySource}
                            </span>
                          </td>

                          <td className="p-3 text-center">
                            <span className={`font-mono font-bold text-xs ${
                              cand.confidenceScore >= 95 
                                ? 'text-emerald-500' 
                                : cand.confidenceScore >= 90
                                ? 'text-indigo-500'
                                : 'text-amber-500'
                            }`}>
                              {cand.confidenceScore}%
                            </span>
                          </td>

                          <td className="p-3 text-center">
                            {cand.requiresManualReview ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20" title={cand.reviewReason}>
                                <AlertTriangle size={10} /> YES
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                <CheckCircle2 size={10} /> NO
                              </span>
                            )}
                          </td>

                          <td className="p-3 text-right">
                            <button
                              onClick={() => setSelectedCandidateDetail(cand)}
                              className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-950 transition-colors cursor-pointer"
                              title="View Activity Timeline Breakdown"
                            >
                              <Eye size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recovery Audit Log Tab */}
      {activeTab === 'history' && (
        <div className={`p-6 rounded-3xl border space-y-4 ${
          adminTheme === 'dark' ? 'bg-slate-800/80 border-slate-700' : 'bg-white border-slate-200'
        }`}>
          <div className="flex justify-between items-center">
            <div>
              <h4 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <History size={18} className="text-indigo-500" />
                Shift Recovery Audit History
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Immutable audit trail of all historical shift recoveries executed by administrators.
              </p>
            </div>

            <button
              onClick={fetchAuditHistory}
              disabled={isLoadingAudit}
              className="p-2 rounded-xl border bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 transition-colors cursor-pointer"
              title="Refresh Audit History"
            >
              <RefreshCw size={14} className={isLoadingAudit ? 'animate-spin' : ''} />
            </button>
          </div>

          {isLoadingAudit ? (
            <div className="p-8 text-center text-xs text-slate-400">Loading recovery audit logs...</div>
          ) : auditLogs.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">No shift recovery logs recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className={`text-[11px] font-black uppercase tracking-wider border-b ${
                    adminTheme === 'dark' ? 'bg-slate-900/60 border-slate-700 text-slate-400' : 'bg-slate-100/80 border-slate-200 text-slate-600'
                  }`}>
                    <th className="p-3">Recovery Date</th>
                    <th className="p-3">Shift ID</th>
                    <th className="p-3">Employee</th>
                    <th className="p-3">Previous Clock-Out</th>
                    <th className="p-3 text-emerald-600 dark:text-emerald-400">Recovered Clock-Out</th>
                    <th className="p-3 text-center">New Duration</th>
                    <th className="p-3 text-center">New Util</th>
                    <th className="p-3">Recovery Source</th>
                    <th className="p-3">Approved By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700/60 text-xs font-medium">
                  {auditLogs.map(log => (
                    <tr key={log.id} className="hover:bg-slate-500/5">
                      <td className="p-3 font-mono text-slate-500">
                        {new Date(log.recoveryTimestamp).toLocaleString()}
                      </td>
                      <td className="p-3 font-mono text-xs text-indigo-500">
                        {log.shiftId.substring(0, 12)}...
                      </td>
                      <td className="p-3 font-semibold text-slate-900 dark:text-white">
                        {log.userName}
                      </td>
                      <td className="p-3 font-mono text-rose-500 line-through">
                        {log.previousValues?.clockOutTime ? new Date(log.previousValues.clockOutTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'MISSING'}
                      </td>
                      <td className="p-3 font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {new Date(log.newValues.clockOutTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="p-3 text-center font-mono">
                        {(log.newValues.shiftDuration / 60).toFixed(1)} hrs
                      </td>
                      <td className="p-3 text-center font-mono text-emerald-500 font-bold">
                        {log.newValues.utilization}%
                      </td>
                      <td className="p-3 text-xs text-slate-600 dark:text-slate-300">
                        {log.recoverySource} ({log.confidence}%)
                      </td>
                      <td className="p-3 font-semibold text-indigo-600 dark:text-indigo-400">
                        {log.approvedBy}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Detail Activity Timeline Modal */}
      {selectedCandidateDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in-20">
          <div className={`w-full max-w-3xl max-h-[85vh] rounded-3xl border shadow-2xl overflow-hidden flex flex-col ${
            adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <Activity size={18} className="text-indigo-500" />
                  Activity Timeline Breakdown: {selectedCandidateDetail.userName}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">Shift ID: {selectedCandidateDetail.id}</p>
              </div>
              <button 
                onClick={() => setSelectedCandidateDetail(null)}
                className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-xs">
                <div>
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Clock In</div>
                  <div className="font-mono font-bold mt-0.5">{new Date(selectedCandidateDetail.clockInTime).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Corrupted Clock Out</div>
                  <div className="font-mono font-bold text-rose-500 mt-0.5">
                    {selectedCandidateDetail.currentClockOutTime ? new Date(selectedCandidateDetail.currentClockOutTime).toLocaleString() : 'MISSING'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Recovered Clock Out</div>
                  <div className="font-mono font-bold text-emerald-500 mt-0.5">{new Date(selectedCandidateDetail.recoveredClockOutTime).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Recovered Utilization</div>
                  <div className="font-mono font-bold text-emerald-500 mt-0.5">{selectedCandidateDetail.recoveredUtilization}%</div>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Recorded Activities ({selectedCandidateDetail.activities.length})</h4>
                {selectedCandidateDetail.activities.length === 0 ? (
                  <div className="p-4 text-center text-xs text-slate-400">No explicit activity records attached.</div>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {selectedCandidateDetail.activities.map((act, idx) => (
                      <div key={idx} className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 text-xs flex justify-between items-center">
                        <div>
                          <div className="font-bold text-slate-800 dark:text-slate-200">{act.name || act.type || 'Activity'}</div>
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                            {act.startTime ? new Date(act.startTime).toLocaleTimeString() : 'N/A'} - {act.endTime ? new Date(act.endTime).toLocaleTimeString() : 'Ongoing'}
                          </div>
                        </div>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">
                          {act.type || 'productive'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex justify-end">
              <button
                onClick={() => setSelectedCandidateDetail(null)}
                className="px-5 py-2 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in-20">
          <div className={`w-full max-w-md rounded-3xl border shadow-2xl p-6 space-y-4 ${
            adminTheme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center gap-3 text-rose-500">
              <ShieldAlert size={28} />
              <h3 className="text-base font-black uppercase tracking-tight">Confirm Shift Recovery Execution</h3>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              You are about to recover and lock <strong>{selectedShiftIds.size} shift records</strong>.
              This will update their <code className="text-indigo-500">clockOutTime</code>, recalculate shift duration and utilization, set status to <code className="text-emerald-500">COMPLETED</code>, and lock the records.
            </p>

            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 space-y-1">
              <div className="font-bold flex items-center gap-1">
                <AlertTriangle size={13} /> Explicit Confirmation Required:
              </div>
              <p className="text-[11px]">Type <strong>RECOVER</strong> below to proceed.</p>
            </div>

            <input
              type="text"
              value={confirmInputText}
              onChange={e => setConfirmInputText(e.target.value)}
              placeholder="Type RECOVER"
              className={`w-full px-4 py-2 rounded-xl text-xs font-mono border outline-none font-bold ${
                adminTheme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
              }`}
            />

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 cursor-pointer"
              >
                Cancel
              </button>

              <button
                onClick={executeApprovedRecoveries}
                disabled={confirmInputText.trim() !== 'RECOVER' || isExecuting}
                className="px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg disabled:opacity-40 transition-all cursor-pointer flex items-center gap-2"
              >
                {isExecuting ? (
                  <>
                    <RefreshCw size={13} className="animate-spin" /> Executing...
                  </>
                ) : (
                  <>
                    <Lock size={13} /> Confirm & Apply Recoveries
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
