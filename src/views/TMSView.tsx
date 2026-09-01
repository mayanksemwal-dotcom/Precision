import { calculateShiftMetrics, ShiftMetrics, formatMs, aggregateShiftsForHistoryAndReports, MergedShiftRecord } from "../lib/ledgerCalculations";
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Clock, 
  Play, 
  Coffee, 
  LogOut, 
  RefreshCw, 
  User, 
  Users,
  Trash2, 
  Plus, 
  Search, 
  CheckCircle, 
  History, 
  AlertCircle,
  AlertTriangle,
  FileSpreadsheet,
  Activity,
  Award,
  GraduationCap,
  ChevronLeft,
  ChevronRight,
  Edit2,
  MonitorOff,
  Laptop,
  Tablet,
  Smartphone,
  Monitor
} from 'lucide-react';
import ProcessSelector from '../components/ProcessSelector';
import SupervisorDashboard from '../components/tms/SupervisorDashboard';
import { TMSLiveSessionProvider } from '../contexts/TMSLiveSessionContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '../components/ui/card';

import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { toast } from 'sonner';
import { usePermission } from '../components/PermissionContext';
import { db, auth, handleFirestoreError, OperationType, getDocsOptimized, getDocOptimized, getDocsCacheFirst, getDocCacheFirst, getDocFromCache, clearCache, invalidateCacheKey, invalidateShiftCache } from '../lib/firebase';
import { writeLiveSession, removeLiveSession } from '../lib/rtdb';
import { parseTimestampMs, isBreakActivity, isMeetingActivity, isTrainingActivity } from '../components/tms/liveSessionMapper';
import { firestoreLogger } from '../lib/firestoreLogger';

import { 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  collection, 
  query, 
  where, 
  orderBy, 
  addDoc, 
  updateDoc, 
  deleteDoc,
  serverTimestamp,
  getDocs,
  limit,
  writeBatch,
  runTransaction,
  startAfter
} from 'firebase/firestore';
import { UserProfile, UserRole, ShiftEvent, ShiftEventType } from '../types';
import { generateAndDownloadOrganizationReport } from '../services/organizationReportExportService';
import { appendShiftEvent, generateLegacyLedgerIfEmpty, formatShiftLedgerForReport } from '../lib/shiftLedger';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { canActOn, normalizeRole, getCachedSubordinateUids, getSubordinateUids, getTmsDashboardTeamUids, OrgTree, buildAuthoritativeLookupMaps, resolveAuthoritativeHierarchy } from '../lib/hierarchy';
import { getLiveTime, getLiveTimeISO } from '../lib/timeSync';
import { logTmsEvent } from '../lib/tmsLogger';
import { useSharedTimer } from '../lib/sharedTimer';
import { safeStorage } from '../lib/safeStorage';
import { useConfig } from '../contexts/ConfigContext';
import { cleanUndefined } from '../lib/utils';
import * as TmsUtils from '../lib/tmsUtils';
import { 
  repairAndNormalizeShift, 
  sanitizeActivities, 
  isShiftLockedOrCompleted, 
  createLockedCompletedShift, 
  calculateShiftFinalMetrics,
  assertShiftLifecycleMutationAllowed,
  MutationContext
} from '../services/tmsCleanupService';

const { isShiftCompleted, buildTimelineFromActivityLedger, getLatestUserActivity, isAuditOrDiagnosticEvent, HEARTBEAT_INTERVAL_MS } = TmsUtils;
// No Sheets imports

// Module-level cache for public IP to avoid slow fetching on button click
let cachedUserIP: string | null = null;
let ipFetchPromise: Promise<string> | null = null;

const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const getOrFetchPublicIP = (): Promise<string> => {
  if (cachedUserIP) return Promise.resolve(cachedUserIP);
  if (ipFetchPromise) return ipFetchPromise;

  const ipLookupServices = [
    { url: 'https://api4.ipify.org?format=json', parse: async (res: Response) => (await res.json()).ip },
    { url: 'https://api.ipify.org?format=json', parse: async (res: Response) => (await res.json()).ip },
    { url: 'https://icanhazip.com', parse: async (res: Response) => (await res.text()).trim() },
    { url: 'https://ifconfig.me/ip', parse: async (res: Response) => (await res.text()).trim() },
    { url: 'https://ipapi.co/json/', parse: async (res: Response) => (await res.json()).ip }
  ];

  ipFetchPromise = (async () => {
    // Try to resolve using Promise.any for fast concurrent execution
    const fetchPromises = ipLookupServices.map(async (service) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200); // Fast 1.2s timeout per service
      try {
        const res = await fetch(service.url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          let ip = await service.parse(res);
          if (ip) {
            ip = ip.trim();
            if (ip.startsWith('::ffff:')) {
              ip = ip.substring(7);
            }
            ip = ip.split(':')[0].trim();
            if (ipv4Regex.test(ip) && ip !== '0.0.0.0') {
              return ip;
            }
          }
        }
      } catch (err) {
        clearTimeout(timeoutId);
      }
      throw new Error('Failed to resolve IP');
    });

    try {
      const resolved = await Promise.any(fetchPromises);
      cachedUserIP = resolved;
      return resolved;
    } catch (e) {
      // Fallback to sequential fast attempt if Promise.any fails completely
      for (const service of ipLookupServices) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 800);
          const res = await fetch(service.url, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (res.ok) {
            let ip = await service.parse(res);
            if (ip) {
              ip = ip.trim();
              if (ip.startsWith('::ffff:')) {
                ip = ip.substring(7);
              }
              ip = ip.split(':')[0].trim();
              if (ipv4Regex.test(ip) && ip !== '0.0.0.0') {
                cachedUserIP = ip;
                return ip;
              }
            }
          }
        } catch (err) {
          // Ignore
        }
      }
    }
    return '0.0.0.0';
  })();

  return ipFetchPromise;
};

// Proactively fetch as soon as file is loaded
if (typeof window !== 'undefined') {
  getOrFetchPublicIP().catch(() => {});
}

interface TMSViewProps {
  user: UserProfile;
  allUsers: UserProfile[];
  onRefreshAllData?: (isManual?: boolean) => void;
  externalTheme?: 'light' | 'dark';
  currentSubView?: string;
  onNavigateSubView?: (viewId: string) => void;
}

export interface ShiftActivity {
  activityId?: string;
  action?: string;
  startTime: string; // ISO
  endTime?: string; // ISO (undefined if active)
  process?: string;
  actor?: string;
  reason?: string;
  sourceService?: string;
  previousValue?: string;
  newValue?: string;

  // Legacy fields
  type?: 'productive' | 'break';
  name?: string; // e.g. HITL, Lunch
  device?: 'mobile' | 'desktop' | string;
}

export interface TMSShift {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  teamLeadUid?: string;
  mappedTL?: string;
  mappedManager?: string;
  clockInTime: string; // ISO
  clockOutTime?: string; // ISO
  endShiftTime?: string; // ISO
  sessionClosedBy?: string;
  activities: ShiftActivity[];
  shiftEventLedger?: ShiftEvent[];
  status: 'ACTIVE' | 'BREAK' | 'COMPLETED' | 'AUTO_CLOSED' | 'COMPLETED_FORCED' | 'CLOCKED_OUT' | 'CLOSED';
  statusStartTime?: string;
  clockInDevice?: 'mobile' | 'desktop';
  clockOutDevice?: 'mobile' | 'desktop';
  hasMobilePunches?: boolean;
  sessionExtended?: boolean;
  extended?: boolean;
  remarks?: string;
  lastHeartbeat?: string;

  // Real-time Session Metadata
  process?: string;
  deviceType?: 'Mobile' | 'Desktop' | 'Tablet';
  browser?: string;
  os?: string;
  loginTimestamp?: string;

  // Diagnostics fields
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  screenWidth?: number;
  screenHeight?: number;
  detectedDeviceType?: string;
  detectedBrowser?: string;
  detectedOS?: string;

  // State Machine & Immutable Metric Fields
  locked?: boolean;
  lockedAt?: string;
  version?: number;
  utilization?: number;
  finalUtilization?: number;
  productiveMinutes?: number;
  breakMinutes?: number;
  shiftDuration?: number;
  productiveMs?: number;
  breakMs?: number;
  totalShiftMs?: number;
  totalProductiveTime?: string;
  totalBreakTime?: string;
  totalShiftTime?: string;
  
  // Work Location Detection fields
  workLocation?: string;
  workLocationDetected?: string;
  workLocationSource?: string;
  publicIP?: string;
  officeName?: string;
  locationCapturedAt?: string;
  overrideBy?: string;
  overrideAt?: string;
}

export function getDeviceType(): 'mobile' | 'desktop' {
  if (typeof window === 'undefined' || !navigator) return 'desktop';
  const ua = (navigator.userAgent || '').toLowerCase();
  
  // Exclude tablet user agents and consider them desktop
  const isTabletUA = /ipad|tablet|playbook|silk/i.test(ua) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isTabletUA) {
    return 'desktop';
  }

  // 1. Standard mobile regular expression check (excluding tablet/ipad keywords)
  if (/mobile|android|iphone|ipod|blackberry|iemobile|opera mini|mobi/i.test(ua)) {
    return 'mobile';
  }
  
  // 2. Modern navigator.userAgentData API check (some browsers don't spoof this in "Desktop Site" mode)
  // @ts-ignore
  if (navigator.userAgentData && navigator.userAgentData.mobile) {
    return 'mobile';
  }
  
  // 3. iOS 13+ iPad Safari / iPhone "Request Desktop Site" check - handled as desktop since iPads are desktop
  
  // 4. Bypassing Attempt Check (e.g., Mobile Phone faking Desktop client/viewport via "Desktop Site" mode)
  // @ts-ignore
  const hasTouch = ('ontouchstart' in window || navigator.maxTouchPoints > 1 || (navigator.msMaxTouchPoints && navigator.msMaxTouchPoints > 1));
  const isCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  
  const screenWidth = window.screen ? (window.screen.width || 0) : 0;
  const screenHeight = window.screen ? (window.screen.height || 0) : 0;
  const minPhysicalDim = Math.min(screenWidth, screenHeight);

  // Coarse pointer AND touch support is a mobile device indicator unless screen is tablet-sized or larger
  if (hasTouch && isCoarsePointer) {
    if (minPhysicalDim > 0 && minPhysicalDim >= 600) {
      return 'desktop';
    }
    return 'mobile';
  }

  if (screenWidth > 0 && screenHeight > 0) {
    // Physical screen width or height under 600 with touch is mobile
    if (hasTouch && minPhysicalDim < 600) {
      return 'mobile';
    }
  }

  // 5. Classic Orientation Checks
  const hasMobileOrientation = typeof window.orientation !== 'undefined';
  if (hasMobileOrientation && hasTouch) {
    if (minPhysicalDim > 0 && minPhysicalDim >= 600) {
      return 'desktop';
    }
    return 'mobile';
  }

  return 'desktop';
}

export function getDetailedDeviceMetadata() {
  if (typeof window === 'undefined' || !navigator) {
    return {
      deviceType: 'Desktop' as const,
      browser: 'Unknown',
      os: 'Unknown',
      loginTimestamp: getLiveTimeISO()
    };
  }

  const ua = (navigator.userAgent || '').toLowerCase();
  
  // 1. Determine Device Type Check
  let deviceType: 'Mobile' | 'Tablet' | 'Desktop' = 'Desktop';
  const isTablet = /ipad|tablet|playbook|silk/i.test(ua) || 
                   (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = /mobile|android|iphone|ipod|blackberry|iemobile|opera mini|mobi/i.test(ua);
  
  if (isTablet) {
    deviceType = 'Tablet';
  } else if (isMobile) {
    deviceType = 'Mobile';
  } else {
    deviceType = 'Desktop';
  }

  // 2. Determine Browser
  let browser = 'Unknown Browser';
  if (ua.includes('firefox')) {
    browser = 'Firefox';
  } else if (ua.includes('opera') || ua.includes('opr')) {
    browser = 'Opera';
  } else if (ua.includes('edg')) {
    browser = 'Edge';
  } else if (ua.includes('chrome') && !ua.includes('chromium')) {
    browser = 'Chrome';
  } else if (ua.includes('safari') && !ua.includes('chrome')) {
    browser = 'Safari';
  } else if (ua.includes('msie') || ua.includes('trident')) {
    browser = 'Internet Explorer';
  } else {
    const match = ua.match(/(chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i);
    if (match && match[1]) {
      browser = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    }
  }

  // 3. Determine OS with spoof protection
  let os = 'Unknown OS';
  if (/windows|win32/i.test(ua)) {
    os = 'Windows';
  } else if (/iphone|ipad|ipod/i.test(ua)) {
    os = 'iOS';
  } else if (/android/i.test(ua)) {
    os = 'Android';
  } else if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
    os = 'iOS';
  } else if (/macintosh|mac os x/i.test(ua)) {
    if (isMobile) {
      os = 'iOS';
    } else {
      os = 'Mac OS';
    }
  } else if (/linux/i.test(ua)) {
    if (isMobile) {
      os = 'Android';
    } else {
      os = 'Linux';
    }
  } else if (/cros/i.test(ua)) {
    os = 'Chrome OS';
  }

  return {
    deviceType,
    browser,
    os,
    loginTimestamp: getLiveTimeISO()
  };
}

export function getShiftProductiveMs(shift: TMSShift, referenceTime: number): number {
  if (!shift) return 0;
  return calculateShiftMetrics(shift, referenceTime).productiveMs;
}

export function truncateShiftToProductiveTime(shift: TMSShift, limitMs: number = 10 * 60 * 60 * 1000): { activities: ShiftActivity[]; clockOutTime: string } {
  let accumulatedProductive = 0;
  let exactEndISO = new Date().toISOString();
  let foundLimit = false;

  const acts = shift.activities || [];
  const sorted = [...acts].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  
  let currentStart = -1;
  let isProductive = false;

  for (let i = 0; i < sorted.length; i++) {
    const act = sorted[i];
    const actStart = new Date(act.startTime).getTime();
    
    if (act.endTime) {
      // Legacy
      const actEnd = new Date(act.endTime).getTime();
      const dur = Math.max(0, actEnd - actStart);
      const isProd = act.type === 'productive' || ['meeting', 'coaching', 'training'].some(k => (act.name || '').toLowerCase().includes(k));
      if (isProd) {
        if (accumulatedProductive + dur >= limitMs) {
          exactEndISO = new Date(actStart + (limitMs - accumulatedProductive)).toISOString();
          foundLimit = true;
          break;
        }
        accumulatedProductive += dur;
      }
      continue;
    }

    if (currentStart !== -1) {
      const dur = actStart - currentStart;
      if (isProductive) {
        if (accumulatedProductive + dur >= limitMs) {
          exactEndISO = new Date(currentStart + (limitMs - accumulatedProductive)).toISOString();
          foundLimit = true;
          break;
        }
        accumulatedProductive += dur;
      }
    }
    
    currentStart = actStart;
    const action = act.action;
    if (action) {
      if (['CLOCK_OUT', 'AUTO_CLOSE', 'FORCE_LOGOUT', 'SYSTEM_REPAIR'].includes(action)) {
        currentStart = -1;
      } else if (action === 'BREAK_START') {
        isProductive = false;
      } else {
        isProductive = true;
      }
    } else {
      isProductive = act.type === 'productive' || ['meeting', 'coaching', 'training'].some(k => (act.name || '').toLowerCase().includes(k));
    }
  }

  if (!foundLimit && currentStart !== -1 && isProductive) {
    const remaining = limitMs - accumulatedProductive;
    exactEndISO = new Date(currentStart + remaining).toISOString();
  }

  const newActivities: ShiftActivity[] = [...acts, {
    activityId: crypto.randomUUID(),
    action: 'AUTO_CLOSE',
    startTime: exactEndISO,
    process: 'System Limit Reached',
    actor: 'System',
    sourceService: 'Background Limit Calculation',
    reason: 'Exceeded 10 hours productive time',
    type: 'productive',
    name: 'AUTO_CLOSED',
    device: 'system'
  }];

  return {
    activities: newActivities,
    clockOutTime: exactEndISO
  };
}

export function getManagerOfManager(u: UserProfile, allUsers: UserProfile[]): string {
  if (!u || !u.uid || !allUsers || !Array.isArray(allUsers)) return 'N/A';
  
  const tree = new OrgTree(allUsers);
  const ancestors = tree.getAncestors(u.uid);
  if (ancestors.length >= 2) {
    const momUid = ancestors[1];
    const momUser = allUsers.find(x => x.uid === momUid);
    if (momUser) {
      return momUser.fullName || momUser.name || momUser.employeeName || momUser.email || 'N/A';
    }
  }
  
  return 'N/A';
}

const DEFAULT_PROCESSES = [
  "Allen", "Amazon-Cashify Crawling", "BERG_Book_all-FK", "BERG_Book_autoqc-FK", "BERG_all-FK",
  "BERG_autoqc-FK", "BERG_autoqc_P2-FK", "BERG_cc-FK", "BERG_dedup-FK", "BERG_deltaedit-FK",
  "BERG_myntra-FK", "BERG_regionalBook-FK", "BERG_shopsy-SH", "BERG_shopsycc-SH", "BERG_shopsyedit-SH",
  "BERG_shopsyeqc-SH", "Catalog Enrichment", "Clear Trip", "Compliance-Auditor", "HITL", "HR",
  "HyperLocal(HL)", "IT", "Labelling", "Multi-Process", "Practice-Set", "Quality", "RQA", "RSQA",
  "SHOPSY_shopsy_china-SH", "SQA FK", "Safe Search", "UGC", "Video Commerce", "Video-Annotation",
  "Video-Creation", "WebQC", "Finance", "MIS-Ops", "MIS-Quality", "Admin"
];
const BREAK_OPTIONS = [
  'Lunch Break', 
  'Tea/Coffee Break', 
  'Short Rest Break', 
  'Training/Coaching Session', 
  'Team Meeting', 
  'Bio Break'
];

const LiveHeaderClock = () => {
  const time = useSharedTimer();
  return <>{time.toLocaleString('en-US', { 
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium'
  })}</>;
};

const LiveDurationClock = ({ startTime }: { startTime: string }) => {
  const now = useSharedTimer();
  const ms = Math.max(0, now.getTime() - new Date(startTime).getTime());
  
  const totalSecs = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  return <>{`${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`}</>;
};

const LiveAgentDurations = ({
  currentShift,
  myPastShifts,
  formatMs,
  now
}: {
  currentShift: TMSShift | null,
  myPastShifts: TMSShift[],
  formatMs: (ms: number) => string,
  now: Date
}) => {
  const metrics = calculateShiftMetrics({
    currentShift,
    myPastShifts,
    aggregationMode: "TODAY"
  }, now.getTime());

  return (
    <div className="grid grid-cols-3 gap-2 p-2 bg-slate-50/80 rounded-xl border border-slate-200/80">
      <div className="text-center border-r border-slate-200/80 pr-1">
        <p className="text-[8px] font-black uppercase text-slate-400 tracking-wider">Shift Elapsed</p>
        <p className="font-mono text-xs font-black text-slate-800 mt-0.5">{metrics.elapsedStr}</p>
      </div>
      <div className="text-center border-r border-slate-200/80 px-1">
        <p className="text-[8px] font-black uppercase text-slate-400 tracking-wider text-teal-600">Active Work</p>
        <p className="font-mono text-xs font-black text-teal-700 mt-0.5">{metrics.activeStr}</p>
      </div>
      <div className="text-center pl-1">
        <p className="text-[8px] font-black uppercase text-slate-400 tracking-wider text-amber-600">Total Breaks</p>
        <p className="font-mono text-xs font-black text-amber-700 mt-0.5">{metrics.breakStr}</p>
      </div>
    </div>
  );
};

const LiveSummaryStats = ({
  metrics
}: {
  metrics: ShiftMetrics
}) => {
  return (
    <>
      <div className="flex items-center justify-between text-xs font-medium border-b border-slate-100 dark:border-slate-800/60 pb-1.5">
        <span className="text-slate-500 dark:text-slate-400">Productive Work:</span>
        <span className="font-bold text-teal-600 dark:text-teal-400">{metrics.activeStr}</span>
      </div>
      <div className="flex items-center justify-between text-xs font-medium border-b border-slate-100 dark:border-slate-800/60 pb-1.5">
        <span className="text-slate-500 dark:text-slate-400">Total Connected:</span>
        <span className="font-bold text-slate-700 dark:text-slate-200">{metrics.connectedStr}</span>
      </div>
      <div className="flex items-center justify-between text-xs font-medium">
        <span className="text-slate-500 dark:text-slate-400">Break Duration:</span>
        <span className="font-bold text-amber-600 dark:text-amber-400">{metrics.breakStr}</span>
      </div>
    </>
  );
};

const LiveSummaryProgress = ({
  utilization
}: {
  utilization: number;
}) => {
  const util = Math.min(100, Math.max(0, utilization));
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (util / 100) * circumference;

  return (
    <div className="relative w-full aspect-square max-w-[72px] mx-auto flex items-center justify-center">
      <svg viewBox="0 0 80 80" className="w-full h-full transform -rotate-90 drop-shadow-sm">
        <circle 
          cx="40" 
          cy="40" 
          r={radius} 
          className="stroke-slate-200 dark:stroke-slate-800" 
          strokeWidth="7" 
          fill="none" 
        />
        <circle 
          cx="40" 
          cy="40" 
          r={radius} 
          className="stroke-teal-600 dark:stroke-teal-400 transition-all duration-500 ease-out" 
          strokeWidth="7" 
          fill="none" 
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-xs font-black text-slate-800 dark:text-slate-100 pointer-events-none select-none">
        {util}%
      </span>
    </div>
  );
};

const LiveShiftMathSummaryCard = ({
  currentShift,
  myPastShifts,
  now
}: {
  currentShift: TMSShift | null;
  myPastShifts: TMSShift[];
  now: Date;
}) => {
  const metrics = calculateShiftMetrics({
    currentShift,
    myPastShifts,
    aggregationMode: "TODAY"
  }, now.getTime());

  return (
    <Card className="border-none shadow-md shadow-slate-200 bg-white dark:bg-slate-900">
      <CardHeader className="border-b border-rose-50/50 dark:border-slate-800/50 py-2.5 px-4">
        <CardTitle className="text-xs font-black uppercase text-slate-800 dark:text-slate-100 tracking-tight">Shift Math & Utilization Summary</CardTitle>
        <CardDescription className="text-[10px] text-slate-500 dark:text-slate-400">Real-time shift math (24/7 cross-day logic applied)</CardDescription>
      </CardHeader>
      <CardContent className="py-2.5 px-4 flex items-center justify-between gap-4">
        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium border-b border-slate-100 dark:border-slate-800/60 pb-1">
            <span className="text-slate-500 dark:text-slate-400">Utilization Rate:</span>
            <span className="font-extrabold text-teal-600 dark:text-teal-400 text-xs">
              {metrics.utilization}%
            </span>
          </div>
          <LiveSummaryStats metrics={metrics} />
        </div>

        {/* Aesthetic Circular Progress */}
        <div className="w-16 h-16 shrink-0 flex items-center justify-center">
          <LiveSummaryProgress utilization={metrics.utilization} />
        </div>
      </CardContent>
    </Card>
  );
};

const TMSViewContent = React.memo(function TMSViewContent({ 
  user, 
  allUsers, 
  onRefreshAllData, 
  externalTheme,
  currentSubView = 'tms-agent',
  onNavigateSubView
}: TMSViewProps) {
  const now = useSharedTimer();
  const normRoleUser = (user.role || '').toString().toUpperCase().trim();
  const checkIsDashboardUser = (r: string) => {
    const upper = r.toUpperCase().trim();
    // Broad matching for any managerial, administrative, or lead roles
    const leadKeywords = ['ADMIN', 'MANAGER', 'HEAD', 'HR', 'MIS', 'TL', 'LEAD', 'SME', 'TRAINER', 'EXECUTIVE', 'DIRECTOR', 'VP', 'SUPERVISOR', 'SUPERV', 'EXEC'];
    return leadKeywords.some(k => upper.includes(k));
  };
  const isDashboardUser = checkIsDashboardUser(normRoleUser);

  // Proactive IP pre-fetch on mount so it's instant when clicking Clock-In
  useEffect(() => {
    getOrFetchPublicIP().catch(() => {});
  }, []);

  const { canView, canCreate, canEdit, canDelete, hasTmsPermission } = usePermission();

  const filteredUsers = useMemo(() => {
    if (!isDashboardUser) {
      console.info("[TMS VIEW VISIBILITY] Actor is not a dashboard user. Returning allUsers:", allUsers.length);
      return allUsers;
    }
    if (!user || !allUsers || allUsers.length === 0) {
      console.info("[TMS VIEW VISIBILITY] Missing user data or empty allUsers. Returning empty roster.");
      return [];
    }

    const teamUidsSet = getTmsDashboardTeamUids(user, allUsers);
    teamUidsSet.add(user.uid); // Always ensure the logged-in user can see themselves

    const resultingFilteredUsers = allUsers.filter(u => teamUidsSet.has(u.uid));

    const checkIsGlobalRole = (role: string) => {
      const rNormalized = role.toUpperCase().trim();
      return ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP'].includes(rNormalized);
    };
    const isGlobalUser = checkIsGlobalRole(user.role || '') || (hasTmsPermission && hasTmsPermission('view_org_wide_workforce_data'));

    // allUsers is pre-filtered to the user's hierarchy in RosterContext, so resultingFilteredUsers will match allUsers.length.
    return resultingFilteredUsers;
  }, [allUsers, isDashboardUser, user, hasTmsPermission]);

  // Dynamic granular permission bindings instead of monolithic role/module checks
  const isManagerRole = hasTmsPermission('can_close_sessions'); 
  const canManageTMS = hasTmsPermission('can_edit_tms_records'); 
  const canModifyTMS = hasTmsPermission('can_edit_tms_records');
  const canDeleteTMS = hasTmsPermission('can_close_sessions');
  const normRole = normalizeRole(user?.role);
  const isQAOrAgent = !isDashboardUser;
  const canViewReports = hasTmsPermission('view_workforce_dashboard') && isDashboardUser;

  // Configured processes in the app
  const { attendanceSettings: centralAttendance, tmsProcesses: centralProcesses, officeNetworks } = useConfig();
  const [processes, setProcesses] = useState<string[]>([]);

  useEffect(() => {
    if (centralProcesses) {
      let processList: string[] | null = null;
      if (Array.isArray(centralProcesses.processes)) {
        processList = centralProcesses.processes
          .filter((p: any) => p.status === 'Active' && !p.hidden)
          .map((p: any) => p.name);
      } else if (Array.isArray(centralProcesses.list)) {
        processList = centralProcesses.list;
      }

      if (processList !== null) {
        setProcesses(processList);
      } else {
        setProcesses(DEFAULT_PROCESSES);
      }
    }
  }, [centralProcesses]);
  const allAvailableProcesses = useMemo(() => {
    const map = new Map<string, string>();
    const blocked = ['mpqc', 'mpqc-fk', 'mpqc-sh'];

    // 1. Add master processes to guarantee they are always available
    DEFAULT_PROCESSES.forEach(p => {
      if (typeof p === 'string' && p.trim().length > 0) {
        const trimmed = p.trim();
        const lower = trimmed.toLowerCase();
        if (blocked.includes(lower)) return;
        if (!map.has(lower)) {
          map.set(lower, trimmed);
        }
      }
    });

    // 2. Add configured active processes from Firestore state
    processes.forEach(p => {
      if (typeof p === 'string' && p.trim().length > 0) {
        const trimmed = p.trim();
        const lower = trimmed.toLowerCase();
        if (blocked.includes(lower)) return;
        if (!map.has(lower)) {
          map.set(lower, trimmed);
        }
      }
    });

    // Return unique sorted list
    return Array.from(map.values()).sort();
  }, [processes]);

  const [presentThreshold, setPresentThreshold] = useState<number>(480);

  useEffect(() => {
    if (centralAttendance) {
      if (typeof centralAttendance.presentThreshold === 'number') {
        setPresentThreshold(centralAttendance.presentThreshold);
      }
      setDesktopOnlyMode(!!centralAttendance.desktopOnlyMode);
    }
  }, [centralAttendance]);
  const [recentProcesses, setRecentProcesses] = useState<string[]>(
    safeStorage.get<string[]>('tms_recent_processes') || []
  );
  const [favoriteProcesses, setFavoriteProcesses] = useState<string[]>(
    safeStorage.get<string[]>('tms_favorite_processes') || []
  );
  
  const [newProcessName, setNewProcessName] = useState('');
  const [tmsSearch, setTmsSearch] = useState('');
  const toggleFavorite = (process: string) => {
    const newFavorites = favoriteProcesses.includes(process)
      ? favoriteProcesses.filter(p => p !== process)
      : [...favoriteProcesses, process];
    setFavoriteProcesses(newFavorites);
    safeStorage.set('tms_favorite_processes', newFavorites);
  };
  
  const updateRecent = (process: string) => {
    const newRecent = [process, ...recentProcesses.filter(p => p !== process)].slice(0, 5);
    setRecentProcesses(newRecent);
    safeStorage.set('tms_recent_processes', newRecent);
  };

  const [processing, setProcessing] = useState(false);
  
  // Real-time user's shift state with optimistic UI shielding
  const [currentShift, setCurrentShift] = useState<TMSShift | null>(null);
  const currentShiftRef = useRef<TMSShift | null>(null);
  useEffect(() => {
    currentShiftRef.current = currentShift;
  }, [currentShift]);

  const [rawActiveShift, setRawActiveShift] = useState<TMSShift | null | undefined>(undefined);
  const [localOwnShift, setLocalOwnShift] = useState<TMSShift | null | undefined>(undefined);
  const [myPastShifts, setMyPastShifts] = useState<TMSShift[]>([]);
  const attemptedHealsRef = useRef<Set<string>>(new Set());

  // Auto Logout warning states
  const [autoLogoutWarning, setAutoLogoutWarning] = useState<{
    show: boolean;
    timeLeft: number;
    reason: 'stale' | 'limit';
  }>({ show: false, timeLeft: 120, reason: 'limit' });
  const [localSessionExtended, setLocalSessionExtended] = useState(false);

  // Reconcile real-time Firestore updates and local optimistic overrides
  useEffect(() => {
    if (rawActiveShift === undefined) return; // Wait for initial load

    let resolvedOwnShift = localOwnShift;
    if (localOwnShift !== undefined) {
      if (localOwnShift === null) {
        // We local-clocked out. If server also shows no active shift, clear the override lock.
        if (!rawActiveShift) {
          setLocalOwnShift(undefined);
          resolvedOwnShift = undefined;
        }
      } else {
        // We local-clocked in / on break / switched process.
        // Merge activities between rawActiveShift and localOwnShift to ensure chronological punch logs never vanish.
        if (rawActiveShift) {
          const serverLastAct = getLatestUserActivity(rawActiveShift.activities || []);
          const localLastAct = getLatestUserActivity(localOwnShift.activities || []);

          // Normalize server status from activities
          let serverStatus = rawActiveShift.status;
          if (serverLastAct) {
            if (serverLastAct.action === 'BREAK_START' || (serverLastAct.type === 'break' && !serverLastAct.endTime)) {
              serverStatus = 'BREAK';
            } else if (serverLastAct.action === 'BREAK_END' || serverLastAct.type === 'productive' || serverLastAct.action === 'CLOCK_IN' || serverLastAct.action === 'PROCESS_SWITCH') {
              serverStatus = 'ACTIVE';
            }
          }

          let localStatus = localOwnShift.status;
          if (localLastAct) {
            if (localLastAct.action === 'BREAK_START' || (localLastAct.type === 'break' && !localLastAct.endTime)) {
              localStatus = 'BREAK';
            } else if (localLastAct.action === 'BREAK_END' || localLastAct.type === 'productive' || localLastAct.action === 'CLOCK_IN' || localLastAct.action === 'PROCESS_SWITCH') {
              localStatus = 'ACTIVE';
            }
          }

          const statusMatches = serverStatus === localStatus;
          const processMatches = serverLastAct?.name === localLastAct?.name;
          const serverActs = rawActiveShift.activities || [];
          const localActs = localOwnShift.activities || [];
          const countMatches = serverActs.length >= localActs.length;
          const hasAllLocalActivities = localActs.every(lAct => 
            serverActs.some((sAct: any) => (sAct.activityId && lAct.activityId && sAct.activityId === lAct.activityId) || sAct.startTime === lAct.startTime)
          );

          if (statusMatches && processMatches && countMatches && hasAllLocalActivities) {
            setLocalOwnShift(undefined);
            resolvedOwnShift = undefined;
          }
        }
      }
    }

    let finalShift = resolvedOwnShift !== undefined ? resolvedOwnShift : rawActiveShift;
    
    // Safety merge: if both rawActiveShift and finalShift exist, ensure all activities are combined & sorted chronologically
    if (finalShift && rawActiveShift && finalShift.id === rawActiveShift.id) {
      const combined = [...(rawActiveShift.activities || [])];
      for (const act of (finalShift.activities || [])) {
        if (!combined.some((sAct: any) => (sAct.activityId && act.activityId && sAct.activityId === act.activityId) || sAct.startTime === act.startTime)) {
          combined.push(act);
        }
      }
      combined.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
      finalShift = {
        ...finalShift,
        activities: combined
      };
    }

    setCurrentShift(finalShift);
  }, [rawActiveShift, localOwnShift]);
  
  // Admin view variables
  const [allShifts, setAllShifts] = useState<TMSShift[]>([]);
  const [adminSearch, setAdminSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  // Filtering admin shift records - memoized to prevent constant recalculation during clock ticks
  const filteredAllShifts = React.useMemo(() => {
    const search = (adminSearch || '').toLowerCase().trim();
    if (!search) return allShifts;
    return allShifts.filter(s => {
      return (s.userName || '').toLowerCase().includes(search) ||
             (s.userEmail || '').toLowerCase().includes(search) ||
             (s.activities || []).some(act => (act.name || '').toLowerCase().includes(search));
    });
  }, [allShifts, adminSearch]);

  const itemsPerPage = 30;

  const totalPages = React.useMemo(() => {
    return Math.ceil(filteredAllShifts.length / itemsPerPage) || 1;
  }, [filteredAllShifts.length]);

  const paginatedShifts = React.useMemo(() => {
    return filteredAllShifts.slice(
      (currentPage - 1) * itemsPerPage,
      currentPage * itemsPerPage
    );
  }, [filteredAllShifts, currentPage]);

  const [selectedProcessInput, setSelectedProcessInput] = useState(() => {
    const localLast = safeStorage.get<string>(`tms_last_used_process_${user.uid}`);
    if (localLast) return localLast;
    return user.lastUsedProcess || '';
  });

  const handleSelectProcess = (proc: string) => {
    setSelectedProcessInput(proc);
    if (proc && user?.uid) {
      safeStorage.set(`tms_last_used_process_${user.uid}`, proc);
    }
  };
  
  // Derive the actual active process from the current shift activities
  const currentActiveProcessName = React.useMemo(() => {
    if (!currentShift) return null;
    const lastProductive = [...currentShift.activities]
      .reverse()
      .find(act => act.type === 'productive');
    return lastProductive?.name || null;
  }, [currentShift]);
  
  const lastSyncedShiftId = React.useRef<string | null>(null);
  
  // Reactively pre-select process based on shift state or user profile
  useEffect(() => {
    if (allAvailableProcesses.length === 0) return;

    // Priority 1: If we have an active/break shift, sync the dropdown when the shift ID, status, or last productive process changes
    if (currentShift) {
      const lastProductive = [...currentShift.activities]
        .reverse()
        .find(act => act.type === 'productive');
      
      const activeProcName = lastProductive?.name;
      const cacheKey = `${currentShift.id}_${currentShift.status}_${activeProcName || ''}`;

      if (cacheKey !== lastSyncedShiftId.current) {
        if (activeProcName && allAvailableProcesses.includes(activeProcName)) {
          setSelectedProcessInput(activeProcName);
          safeStorage.set(`tms_last_used_process_${user.uid}`, activeProcName);
        }
        lastSyncedShiftId.current = cacheKey;
      }
      return;
    }

    // Reset sync tracker when clocked out
    lastSyncedShiftId.current = null;

    // Priority 2: If clocked out, pre-select local storage lastUsedProcess or user.lastUsedProcess by default
    const localLast = safeStorage.get<string>(`tms_last_used_process_${user.uid}`);
    if (localLast && allAvailableProcesses.includes(localLast)) {
      setSelectedProcessInput(localLast);
    } else if (user.lastUsedProcess && allAvailableProcesses.includes(user.lastUsedProcess)) {
      setSelectedProcessInput(user.lastUsedProcess);
    } else if (!selectedProcessInput || !allAvailableProcesses.includes(selectedProcessInput)) {
      if (user.process && allAvailableProcesses.includes(user.process)) {
        setSelectedProcessInput(user.process);
      } else if (allAvailableProcesses.length > 0) {
        setSelectedProcessInput(allAvailableProcesses[0]);
      }
    }
  }, [currentShift?.id, currentActiveProcessName, user.lastUsedProcess, user.process, allAvailableProcesses, user.uid]);

  const [selectedBreakInput, setSelectedBreakInput] = useState(BREAK_OPTIONS[0]);
  const [activeShiftFilter, setActiveShiftFilter] = useState('all');
  const [tmsAdminTab, setTmsAdminTab] = useState<'roster' | 'exceeded_12h'>('roster');
  const [editingProcessName, setEditingProcessName] = useState<string | null>(null);
  const [editingProcessValue, setEditingProcessValue] = useState<string>('');

  // Custom modal confirmations instead of window.confirm inside sandboxed iframe
  const [showClockInConfirm, setShowClockInConfirm] = useState(false);
  const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);
  const [confirmDeleteProcessName, setConfirmDeleteProcessName] = useState<string | null>(null);

  // Force Logout States
  const [forceOutShiftId, setForceOutShiftId] = useState<string | null>(null);
  const [forceOutTargetName, setForceOutTargetName] = useState<string>('');
  const [forceOutTargetUid, setForceOutTargetUid] = useState<string>('');
  const [forceOutReason, setForceOutReason] = useState<string>('Left without logging out');
  const [forceOutCustomReason, setForceOutCustomReason] = useState<string>('');

  // Hierarchy validation helper
  const canUserForceLogoutTarget = (actor: UserProfile, targetUid: string) => {
    if (actor.uid === targetUid) return false;
    
    const target = allUsers.find(u => u.uid === targetUid);
    if (!target) return false;

    // Use granular key permission check and hierarchy check
    if (!hasTmsPermission('can_force_logout')) return false;

    return canActOn(actor, target, allUsers);
  };

  // Date Range and Format selection states for reports
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportType, setExportType] = useState<'team' | 'organization' | null>(null);
  const [selectedRangePreset, setSelectedRangePreset] = useState<string>('last30');
  const [startDateStr, setStartDateStr] = useState<string>('');
  const [endDateStr, setEndDateStr] = useState<string>('');
  const [exportFormat, setExportFormat] = useState<'csv' | 'excel'>('excel');
  const [reportType, setReportType] = useState<'summary' | 'chronological' | 'both'>('both');
  const [isExporting, setIsExporting] = useState(false);
  const [exportAbortController, setExportAbortController] = useState<AbortController | null>(null);
  const [exportProgressPercent, setExportProgressPercent] = useState<number>(0);
  const [exportProgressMessage, setExportProgressMessage] = useState<string>('');

  const cancelExport = () => {
    if (exportAbortController) {
      exportAbortController.abort();
      setExportAbortController(null);
      setIsExporting(false);
      toast.error('Export cancelled by user.');
    }
  };

  // Fallback to summary if CSV format is selected since CSV is single sheet
  useEffect(() => {
    if (exportFormat === 'csv' && reportType === 'both') {
      setReportType('summary');
    }
  }, [exportFormat, reportType]);
  
  // Polling removed in Phase 5: Replaced with ConfigContext
  const [desktopOnlyMode, setDesktopOnlyMode] = useState<boolean>(false);
  const [adminBypass, setAdminBypass] = useState<boolean>(false);

  // Fetch User's Personal Shifts (Optimized Phase 3) - Polling to save quota
  useEffect(() => {
    if (!user) return;
    
    // Real-time listener ONLY for Active/Break sessions
    const qActive = query(
      collection(db, 'tmsShifts'),
      where('userId', '==', user.uid),
      orderBy('clockInTime', 'desc'),
      limit(10)
    );

    const fetchData = async () => {
      try {
        let active: TMSShift | null = null;
        let isReadFailure = false;
        
        try {
          // 1. Try Cache-first lookup from localStorage / memory reference to completely avoid network latency / cost
          const cachedActiveId = localStorage.getItem('tms_last_active_shift_id');
          if (cachedActiveId) {
            try {
              const shiftRef = doc(db, 'tmsShifts', cachedActiveId);
              const shiftSnap = await getDocCacheFirst(shiftRef, `active_shift_direct_${cachedActiveId}`, false);
              if (shiftSnap.exists()) {
                const sData = shiftSnap.data();
                const normStatus = (sData.status || '').toUpperCase();
                const completedStatuses = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'];
                if (!completedStatuses.includes(normStatus)) {
                  active = {
                    id: cachedActiveId,
                    userId: user.uid,
                    clockInTime: sData.clockInTime || getLiveTimeISO(),
                    activities: sData.activities || [],
                    status: normStatus as any,
                    ...sData
                  };
                }
              }
            } catch (err) {
              console.warn('[TMS FETCH] Cache-first lookup failed, falling back to authoritative check:', err);
            }
          }

          // 2. If no valid cache-first match, fallback to lock check (cache-first as well, forceServer: false)
          if (!active) {
            // Authoritative active shift discovery via tmsActiveLocks/{userId} (1 read unit)
            const lockRef = doc(db, 'tmsActiveLocks', user.uid);
            const lockSnap = await getDocCacheFirst(lockRef, `active_lock_check_${user.uid}`, false);
            
            if (lockSnap.exists()) {
              const lockData = lockSnap.data();
              const lockStatus = (lockData?.status || '').toUpperCase();
              const lockShiftId = lockData?.shiftId;
              
              if ((lockStatus === 'ACTIVE' || lockStatus === 'BREAK') && lockShiftId) {
                const shiftRef = doc(db, 'tmsShifts', lockShiftId);
                const shiftSnap = await getDocCacheFirst(shiftRef, `active_shift_direct_${lockShiftId}`, false);
                if (shiftSnap.exists()) {
                  const sData = shiftSnap.data();
                  const normStatus = (sData.status || '').toUpperCase();
                  const completedStatuses = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'];
                  if (!completedStatuses.includes(normStatus)) {
                    active = {
                      id: lockShiftId,
                      userId: user.uid,
                      clockInTime: sData.clockInTime || getLiveTimeISO(),
                      activities: sData.activities || [],
                      status: normStatus as any,
                      ...sData
                    };
                  }
                }
              }
            }
          }

          // 3. Fallback checks only if cache-first lookup did not find any active shifts
          if (!active) {
            const currentActiveInMem = currentShiftRef.current;
            const targetShiftId = currentActiveInMem?.id || cachedActiveId;

            if (targetShiftId) {
              const directRef = doc(db, 'tmsShifts', targetShiftId);
              let directSnap: any;
              try {
                directSnap = await getDocFromCache(directRef);
                if (!directSnap || !directSnap.exists()) {
                  directSnap = await getDocOptimized(directRef, `verify_active_direct_${targetShiftId}`, false);
                }
              } catch {
                directSnap = await getDocOptimized(directRef, `verify_active_direct_${targetShiftId}`, false);
              }
              if (directSnap && directSnap.exists()) {
                const sData = directSnap.data();
                const normStatus = (sData.status || '').toUpperCase();
                const completedStatuses = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'];
                if (!completedStatuses.includes(normStatus)) {
                  active = {
                    id: targetShiftId,
                    userId: user.uid,
                    clockInTime: sData.clockInTime || getLiveTimeISO(),
                    activities: sData.activities || [],
                    status: normStatus as any,
                    ...sData
                  };
                }
              }
            } else {
              // Narrow fallback query (limit 1)
              const qActiveNarrow = query(
                collection(db, 'tmsShifts'),
                where('userId', '==', user.uid),
                where('status', 'in', ['ACTIVE', 'BREAK']),
                limit(1)
              );
              const narrowSnap = await getDocsCacheFirst(qActiveNarrow, 'my_active_shifts_narrow', false);
              if (!narrowSnap.empty) {
                const docSnap = narrowSnap.docs[0];
                active = { id: docSnap.id, userId: user.uid, ...docSnap.data() } as TMSShift;
              }
            }
          }
        } catch (readErr) {
          console.error('[TMS FETCH] Failed to execute query/lock snapshot:', readErr);
          isReadFailure = true;
        }

        // Resolution Hierarchy:
        if (active) {
          localStorage.setItem('tms_last_active_shift_id', active.id);
          localStorage.setItem('tms_last_active_shift_json', JSON.stringify(active));
        } else {
          const currentActiveInMem = currentShiftRef.current;
          const cachedActiveId = localStorage.getItem('tms_last_active_shift_id');
          const targetShiftId = currentActiveInMem?.id || cachedActiveId;

          if (targetShiftId && isReadFailure) {
            const localJSON = localStorage.getItem('tms_last_active_shift_json');
            if (currentActiveInMem) {
              active = currentActiveInMem;
            } else if (localJSON) {
              try {
                active = JSON.parse(localJSON);
              } catch (jsonErr) {}
            }
          } else if (isReadFailure && currentActiveInMem) {
            active = currentActiveInMem;
          }
        }

        // Apply resolved active shift or clear
        if (active) {
          const isExtended = !!(active.sessionExtended || active.extended);
          const activeActs = active.activities || [];
          const lastAct = getLatestUserActivity(activeActs);
          let resolvedActiveStatus = active.status;
          if (lastAct) {
            if (lastAct.action === 'BREAK_START' || (lastAct.type === 'break' && !lastAct.endTime)) {
              resolvedActiveStatus = 'BREAK';
            } else if (lastAct.action === 'BREAK_END' || lastAct.type === 'productive' || lastAct.action === 'CLOCK_IN' || lastAct.action === 'PROCESS_SWITCH') {
              resolvedActiveStatus = 'ACTIVE';
            }
          }
          setRawActiveShift({ ...active, status: resolvedActiveStatus });
          if (isExtended) {
            setLocalSessionExtended(true);
          }
          logTmsEvent('SESSION_RESTORE', {
            userId: user.uid,
            shiftId: active.id,
            timestamp: getLiveTimeISO(),
            reason: 'Active session restored on state fetch / refresh via lease',
            sourceFunction: 'TMSView.fetchData',
            details: { status: active.status, clockInTime: active.clockInTime }
          });
          const lastProductive = [...active.activities]
            .reverse()
            .find(act => act.type === 'productive');
          if (lastProductive && allAvailableProcesses.includes(lastProductive.name)) {
            setSelectedProcessInput(lastProductive.name);
            safeStorage.set(`tms_last_used_process_${user.uid}`, lastProductive.name);
          }
        } else {
          if (!isReadFailure) {
            setRawActiveShift(null);
            setLocalOwnShift(null);
          } else {
            console.warn('[TMS ACTIVE GUARD] Skipping UI reset to CLOCKED_OUT because of a fetch/read failure.');
          }
        }
      } catch (err) {
        console.error('Failed to fetch active shifts', err);
      }
    };

    fetchData();
    const interval = setInterval(() => {
      if (document.hidden || !document.hasFocus()) return;
      fetchData();
    }, 10 * 60 * 1000);

    let lastFocusFetchTime = 0;

    const handleMemoryCleaned = () => {
      console.log('[TMSView] Memory cleaned event detected. Forcing fresh state fetch...');
      fetchData();
      fetchHistory();
    };

    const handleOnlineReconnect = () => {
      const now = Date.now();
      if (now - lastFocusFetchTime > 30000) {
        lastFocusFetchTime = now;
        console.log('[TMSView] Internet reconnected. Re-syncing active shift state with cooldown protection...');
        fetchData();
      } else {
        console.log('[TMSView] Internet reconnected, but cooldown active. Skipping fetch.');
      }
    };

    const handleFocusFetchData = () => {
      const now = Date.now();
      // Minimum 30 seconds cooldown between focus-triggered fetches to stop storms!
      if (now - lastFocusFetchTime > 30000) {
        lastFocusFetchTime = now;
        console.log('[TMSView] Window focused, triggering data fetch with cooldown protection.');
        fetchData();
      } else {
        console.log('[TMSView] Window focused but cooldown active. Skipping fetch to prevent read amplification.');
      }
    };

    window.addEventListener('app_memory_cleaned', handleMemoryCleaned);
    window.addEventListener('online', handleOnlineReconnect);
    window.addEventListener('focus', handleFocusFetchData);

    // History fetch (strictly limited to last 2 days and top 5 recent records with cache)
    const fetchHistory = async () => {
      try {
        const now = new Date();
        const twoDaysAgoIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 0, 0, 0, 0)).toISOString();
        let snap;
        try {
          const qHistory = query(
            collection(db, 'tmsShifts'),
            where('userId', '==', user.uid),
            where('clockInTime', '>=', twoDaysAgoIso),
            orderBy('clockInTime', 'desc'),
            limit(5)
          );
          snap = await getDocsOptimized(qHistory, `my_shifts_history_fetch_${user.uid}`, false);
        } catch (idxErr) {
          console.warn('Fallback fetching history without orderBy index:', idxErr);
          const qHistoryFallback = query(
            collection(db, 'tmsShifts'),
            where('userId', '==', user.uid),
            where('clockInTime', '>=', twoDaysAgoIso),
            limit(5)
          );
          snap = await getDocsOptimized(qHistoryFallback, `my_shifts_history_fallback_${user.uid}`, false);
        }

        let shifts = snap.docs.map((doc: any) => ({ id: doc.id, ...doc.data() } as TMSShift));
        shifts.sort((a, b) => parseTimestampMs(b.clockInTime) - parseTimestampMs(a.clockInTime));
        const top5Shifts = shifts.slice(0, 5);
        setMyPastShifts(top5Shifts);
      } catch (err) {
        console.error('Error fetching shift history:', err);
      }
    };
    fetchHistory();

    return () => {
      clearInterval(interval);
      window.removeEventListener('app_memory_cleaned', handleMemoryCleaned);
      window.removeEventListener('online', handleOnlineReconnect);
      window.removeEventListener('focus', handleFocusFetchData);
    };
  }, [user?.uid]);

  const getDateRange = (preset: string, customStart?: string, customEnd?: string) => {
    const now = getLiveTime();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    let start = new Date(startOfToday);
    let end = new Date(endOfToday);

    switch (preset) {
      case 'today':
        break;
      case 'yesterday':
        start.setDate(start.getDate() - 1);
        end.setDate(end.getDate() - 1);
        break;
      case 'last7':
        start.setDate(start.getDate() - 6);
        break;
      case 'last30':
        start.setDate(start.getDate() - 29);
        break;
      case 'currentMonth':
        start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        break;
      case 'previousMonth':
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
        end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
        break;
      case 'custom':
        if (customStart) start = new Date(customStart + 'T00:00:00');
        if (customEnd) end = new Date(customEnd + 'T23:59:59');
        break;
    }
    return { start, end };
  };

  // Fetch ALL Shifts for Admins, Managers or Team Leads in real-time to view workforce status
  const fetchAllShifts = async () => {
    // Shifts are managed in real-time via the useEffect's onSnapshot subscription
    // But we can trigger a manual re-fetch of users or just give feedback
    if (onRefreshAllData) {
      onRefreshAllData(true);
    } else {
      toast.info('Synchronization pulse sent. Roster state is live.', {
        icon: <RefreshCw size={14} className="animate-spin" />
      });
    }
  };

  useEffect(() => {
    // OPTIMIZED: Only fetch the active shift list from live_sessions if NOT a dashboard user (who uses SupervisorDashboard's own optimized sync)
    if (!user?.uid || !canViewReports) return;
    
    const normRole = (user.role || '').toString().toUpperCase().trim();
    const isDashboard = [
      'TEAM_LEAD', 'TEAM LEAD', 'TL', 'STL', 'QTL', 'OPS_TL', 'OPS TL', 'TRAINER_TL', 'TRAINER TL', 'SME', 'MANAGER', 'ADMIN', 'MIS', 'OPS_HEAD', 'OPS HEAD', 'HR', 'IT_MANAGER', 'ASSISTANT_MANAGER'
    ].includes(normRole);
    if (isDashboard) return;

    const fetchShifts = async () => {
      try {
        const qAllShifts = query(
          collection(db, 'live_sessions')
        );
        const snap = await getDocsOptimized(qAllShifts, 'tmsShifts_organizational_getDocs');
        firestoreLogger.trackRead('tmsShifts_organizational_getDocs', snap.size);
        const shifts = snap.docs.map(doc => {
          const data = doc.data();
          return {
            id: data.sessionId || doc.id,
            userId: data.userId || data.uid || '',
            userName: data.employeeName || data.userName || '',
            userEmail: data.email || data.userEmail || '',
            clockInTime: data.clockInTime || '',
            status: data.status || 'ACTIVE',
            activities: data.activities || [],
            ...data
          } as TMSShift;
        });
        setAllShifts(shifts);
      } catch (error) {
        console.warn('Failed to fetch tmsShifts from live_sessions', error);
      }
    };
    
    fetchShifts();
  }, [user?.uid, canViewReports]);

  const startForceLogoutFlow = (shiftId: string, targetUid: string, targetName: string) => {
    setForceOutShiftId(shiftId);
    setForceOutTargetUid(targetUid);
    setForceOutTargetName(targetName);
    setForceOutReason('Left without logging out');
    setForceOutCustomReason('');
  };

  const performAdminClockOut = async () => {
    if (!forceOutShiftId) return;
    try {
      const shiftRef = doc(db, 'tmsShifts', forceOutShiftId);
      const shiftSnap = await getDocOptimized(shiftRef, 'shift_for_forcelogout');
      if (!shiftSnap.exists()) {
        toast.error('Shift not found');
        return;
      }
      const shift = shiftSnap.data() as TMSShift;
      const nowISO = getLiveTimeISO();
      const updatedActivities = [...shift.activities];
      const lastActivity = updatedActivities.length > 0 
        ? updatedActivities[updatedActivities.length - 1].name 
        : 'Unknown Process';
        
      if (updatedActivities.length > 0) {
        // Immutable ledger: endTime mutation removed
      }

      // Apply selected / custom reason
      const finalReason = forceOutReason === 'other' 
        ? (forceOutCustomReason.trim() || 'Forced logout by supervisor')
        : forceOutReason;

      const adminIdentifier = user?.email || user?.uid || 'Unknown' || user.uid;
      const updatedLedger = appendShiftEvent(
        shift.shiftEventLedger,
        shift,
        {
          eventType: 'SUPERVISOR_FORCE_LOGOUT',
          timestamp: nowISO,
          performedBy: `Supervisor: ${user.name || adminIdentifier}`,
          source: 'Supervisor Panel',
          reason: finalReason ? `Force logout: ${finalReason}` : 'Force logout by supervisor',
          oldValue: shift.status || 'ACTIVE',
          newValue: 'COMPLETED_FORCED',
          remarks: `Admin forced checkout performed remotely`
        }
      );

      const updatedShift = {
        ...shift,
        activities: updatedActivities,
        clockOutTime: nowISO,
        endShiftTime: nowISO,
        sessionClosedBy: adminIdentifier,
        remarks: finalReason ? `Admin force logout: ${finalReason}` : 'Admin force logout',
        status: 'COMPLETED_FORCED',
        shiftEventLedger: updatedLedger
      };

      // Update shift to COMPLETED_FORCED
      await updateDoc(shiftRef, updatedShift as any);

      logTmsEvent('CLOCK_OUT', {
        userId: forceOutTargetUid,
        shiftId: forceOutShiftId,
        timestamp: nowISO,
        reason: finalReason ? `Admin force logout: ${finalReason}` : 'Admin force logout',
        sourceFunction: 'TMSView.performAdminClockOut',
        details: { closedBy: adminIdentifier, targetName: forceOutTargetName }
      });
      
      // Auto-generate Attendance - DISABLED
      // await syncShiftToAttendance(updatedShift);

      // 0. Update User lastLogoutAt in users collection without mutating administrative status
      const userRef = doc(db, 'users', forceOutTargetUid);
      const userSnap = await getDocOptimized(userRef, 'user_for_forcelogout');
      if (userSnap.exists()) {
        await updateDoc(userRef, {
          lastLogoutAt: nowISO
        });
      }

      // 1. Audit log process creation/alteration
      const logId = `tms-forcelogout-${Date.now()}`;
      await setDoc(doc(db, 'uploadAuditLogs', logId), {
        id: logId,
        targetId: forceOutTargetUid,
        entityType: 'user_shift',
        fieldName: 'status',
        oldValue: 'ACTIVE/BREAK',
        newValue: 'COMPLETED_FORCED',
        updatedBy: user.uid,
        updatedByName: user?.name || user?.fullName || 'User',
        updatedAt: nowISO,
        action: 'force_logout',
        details: `Force Logout executed. User Forced Out: ${forceOutTargetName} (${shift.userEmail}). Forced By: ${user.name} (${user?.email || user?.uid || 'Unknown'}). Reason: ${finalReason}. Current Activity at logout: ${lastActivity}.`
      });

      // 2. Log force-logout event to Firestore
      const auditLogPayload = {
        timestamp: nowISO,
        action: 'Force Logout',
        performedBy: `${user.name} (${user?.email || user?.uid || 'Unknown'})`,
        affectedUser: `${forceOutTargetName} (${shift.userEmail})`,
        previousValue: 'ACTIVE/BREAK',
        newValue: 'COMPLETED_FORCED',
        remarks: `Supervisor executed force logout. Reason: ${finalReason}`,
        details: {
          shiftId: forceOutShiftId,
          targetUid: forceOutTargetUid,
          reason: finalReason,
          currentActivityAtLogout: lastActivity
        }
      };
      console.log('[AUDIT LOG] Writing Force Logout to Firestore:', auditLogPayload);
      addDoc(collection(db, 'adminAuditLogs'), auditLogPayload).catch(e => console.error('Audit log failed', e));

      toast.success(`Successfully forced clock-out for ${forceOutTargetName}.`);
      
      // Clean up modal states
      setForceOutShiftId(null);
      setForceOutTargetUid('');
      setForceOutTargetName('');
      setForceOutReason('Left without logging out');
      setForceOutCustomReason('');

      invalidateShiftCache({
        userId: forceOutTargetUid,
        shiftId: forceOutShiftId || undefined,
        reason: 'admin_force_logout'
      });
      await fetchAllShifts();
    } catch (e) {
      console.error('[TMS FORCE LOGOUT ERROR]', e);
      handleFirestoreError(e, OperationType.WRITE, 'tmsShifts');
    }
  };

  // Reset session extension when shift is cleared
  useEffect(() => {
    if (!currentShift) {
      setLocalSessionExtended(false);
      setAutoLogoutWarning({ show: false, timeLeft: 120, reason: 'limit' });
    }
  }, [currentShift?.id]);

  const lastHeartbeatSentAtRef = useRef<number>(0);

  // Heartbeat optimization: Update lastHeartbeat and isOnline in live_sessions ONLY every 5 minutes (300,000ms) when clocked in
  useEffect(() => {
    if (!user?.uid || !currentShift || currentShift.status === 'COMPLETED' || currentShift.status === 'AUTO_CLOSED') return;

    const sendHeartbeat = async (reason: 'scheduled' | 'focus' | 'visibility' | 'mount' = 'scheduled') => {
      // Pause scheduled/background heartbeats if browser tab is hidden/minimized
      if (typeof document !== 'undefined' && document.hidden && reason === 'scheduled') {
        return;
      }

      const now = Date.now();
      const elapsedMs = now - lastHeartbeatSentAtRef.current;

      // Enforce shared 5-minute cooldown gate for focus / visibility event heartbeats to prevent burst writes
      if ((reason === 'focus' || reason === 'visibility') && elapsedMs < HEARTBEAT_INTERVAL_MS) {
        console.log(`[HEARTBEAT SKIPPED] reason=cooldown elapsedMs=${elapsedMs}`);
        return;
      }

      lastHeartbeatSentAtRef.current = now;

      try {
        const userData = (user as any);
        const tlId = userData.teamLeadId || userData.teamLeadUid || userData.tlId || '';
        const managerId = userData.mappedManagerId || userData.managerId || '';
        const nowISO = getLiveTimeISO();
        
        await writeLiveSession(user.uid, {
          lastHeartbeat: nowISO,
          isOnline: true,
          tlId: tlId,
          managerId: managerId,
          userId: user.uid,
          uid: user.uid
        });

        console.log(`[RTDB WRITE COST] operation=heartbeat collection=live_sessions reason=${reason}`);
        console.log(`[HEARTBEAT WRITE] collection=live_sessions reason=${reason}`);
        logTmsEvent('HEARTBEAT', {
          userId: user.uid,
          shiftId: currentShift.id,
          timestamp: nowISO,
          reason: `Heartbeat (${reason})`,
          sourceFunction: 'TMSView.sendHeartbeat'
        });
      } catch (err) {
        console.warn('[HEARTBEAT] Failed to update heartbeat:', err);
      }
    };

    // Send immediately on mount / state change
    sendHeartbeat('mount');

    const heartbeatInterval = setInterval(() => sendHeartbeat('scheduled'), HEARTBEAT_INTERVAL_MS);

    const handleFocus = () => {
      sendHeartbeat('focus');
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat('visibility');
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(heartbeatInterval);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [user?.uid, currentShift?.id, currentShift?.status]);

  const saveShiftState = async (updatedShift: TMSShift) => {
    const isSelf = updatedShift.userId === user?.uid;
    let userData: any = isSelf ? user : null;

    if (!userData && allUsers && allUsers.length > 0) {
      userData = allUsers.find(u => u.uid === updatedShift.userId);
    }

    if (!userData || !userData.teamLeadId) {
      const masterRef = doc(db, 'employee_master', updatedShift.userId);
      const masterSnap = await getDocOptimized(masterRef, `master_for_state_${updatedShift.userId}`);
      if (masterSnap.exists()) {
        const masterData = masterSnap.data();
        userData = { ...userData, ...masterData };
      }
    }
    
    const referenceTime = getLiveTime().getTime();
    const productiveMs = getShiftProductiveMs(updatedShift, referenceTime);
    const breakMs = (updatedShift.activities || [])
      .filter(act => act.type === 'break' && act.name.toLowerCase() !== 'offline' && !act.name.toLowerCase().includes('meeting') && !act.name.toLowerCase().includes('coaching') && !act.name.toLowerCase().includes('training') && !act.name.toLowerCase().includes('alignment'))
      .reduce((sum, act) => sum + (act.endTime ? new Date(act.endTime).getTime() : referenceTime) - new Date(act.startTime).getTime(), 0);

    const lastAct = getLatestUserActivity(updatedShift.activities || []);
    const currentActivity = (lastAct && !lastAct.endTime && lastAct.name) || 'Offline';
    const currentActivityStartTime = lastAct ? lastAct.startTime : getLiveTimeISO();

    const isCompleted = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'].includes(updatedShift.status);

    let validatedStatus = updatedShift.status;
    if (validatedStatus === 'BREAK') {
      const lastActInShift = getLatestUserActivity(updatedShift.activities || []);
      const isActualBreak = lastActInShift && (lastActInShift.action === 'BREAK_START' || (lastActInShift.type === 'break' && !isAuditOrDiagnosticEvent(lastActInShift.action)));
      if (!isActualBreak) {
        validatedStatus = 'ACTIVE';
      }
    }

    const liveSessionData = {
      sessionId: updatedShift.id,
      userId: updatedShift.userId,
      uid: updatedShift.userId,
      employeeId: updatedShift.userId,
      employeeName: updatedShift.userName || '',
      email: updatedShift.userEmail || '',
      userEmail: updatedShift.userEmail || '',
      process: lastAct?.name || userData?.team || userData?.process || 'N/A',
      teamLead: userData?.teamLeadId || userData?.teamLeadUid || '',
      tlId: userData?.teamLeadId || userData?.teamLeadUid || '',
      manager: userData?.mappedManagerId || userData?.managerId || '',
      managerId: userData?.mappedManagerId || userData?.managerId || '',
      isOnline: !isCompleted,
      status: validatedStatus,
      currentActivity: currentActivity,
      clockInTime: updatedShift.clockInTime,
      statusStartTime: currentActivityStartTime,
      currentActivityStartTime: currentActivityStartTime,
      lastHeartbeat: getLiveTimeISO(),
      activities: updatedShift.activities || [],
      workLocation: updatedShift.workLocation || '',
      workLocationDetected: updatedShift.workLocationDetected || '',
      workLocationSource: updatedShift.workLocationSource || '',
      publicIP: updatedShift.publicIP || '',
      officeName: updatedShift.officeName || '',
      locationCapturedAt: updatedShift.locationCapturedAt || '',
      overrideBy: updatedShift.overrideBy || '',
      overrideAt: updatedShift.overrideAt || ''
    };

    try {
      await runTransaction(db, async (transaction) => {
        const dbRef = doc(db, 'tmsShifts', updatedShift.id);
        const serverSnap = await transaction.get(dbRef);
        
        if (serverSnap.exists()) {
          const serverData = serverSnap.data();
          const serverStatus = serverData.status;
          const completedStatuses = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'];
          
          if (completedStatuses.includes(serverStatus)) {
            console.warn(`[TMS SESSION LOCK] Blocked update to shift ${updatedShift.id}. The shift is already completed/closed on the server (Server Status: ${serverStatus}).`);
            if (isSelf) {
              setLocalOwnShift(null);
              setCurrentShift(null);
              localStorage.removeItem('tms_last_active_shift_id');
              localStorage.removeItem('tms_last_active_shift_json');
            }
            throw new Error('Shift already completed on server.');
          }

          let caller: any = 'BACKGROUND_CLEANUP';
          const lastEvent = updatedShift.shiftEventLedger && updatedShift.shiftEventLedger.length > 0 
            ? updatedShift.shiftEventLedger[updatedShift.shiftEventLedger.length - 1]
            : null;

          if (lastEvent) {
            const evType = lastEvent.eventType as string;
            if (evType === 'CLOCK_OUT') caller = 'USER_CLOCK_OUT';
            else if (evType === 'SUPERVISOR_FORCE_LOGOUT') caller = 'SUPERVISOR_FORCE_OUT';
            else if (evType === 'APPROVED_HISTORICAL_CORRECTION' || evType === 'HISTORICAL_CORRECTION' || evType === 'MANUAL_CORRECTION') caller = 'APPROVED_HISTORICAL_CORRECTION';
          }
          if (caller === 'BACKGROUND_CLEANUP' && (updatedShift.remarks?.includes('Manual clock out') || updatedShift.remarks?.includes('Manually clocked out'))) {
            caller = 'USER_CLOCK_OUT';
          }

          const gateResult = assertShiftLifecycleMutationAllowed(serverStatus, updatedShift.status, {
            caller,
            actorUid: user?.uid,
            reason: updatedShift.remarks
          });

          if (!gateResult.allowed) {
            console.error(`[TMS LIFECYCLE GATE] Mutation blocked: ${gateResult.reason}`);
            throw new Error(`Operation rejected: Stale or unauthorized shift state transition: ${gateResult.reason}`);
          }
        }

        const serverData = serverSnap.exists() ? serverSnap.data() : null;
        const serverActivities = serverData ? (serverData.activities || []) : [];
        const serverLedger = serverData ? (serverData.shiftEventLedger || []) : [];

        // Safe defensive merge of activities to prevent stale client state from deleting newer events
        const mergedActivities = [...serverActivities];
        const clientActivities = updatedShift.activities || [];
        for (const cAct of clientActivities) {
          const existsOnServer = mergedActivities.some((sAct: any) => 
            (sAct.activityId && cAct.activityId && sAct.activityId === cAct.activityId) || 
            sAct.startTime === cAct.startTime
          );
          if (!existsOnServer) {
            mergedActivities.push(cAct);
          } else {
            const idx = mergedActivities.findIndex((sAct: any) => 
              (sAct.activityId && cAct.activityId && sAct.activityId === cAct.activityId) || 
              sAct.startTime === cAct.startTime
            );
            if (idx !== -1) {
              mergedActivities[idx] = {
                ...mergedActivities[idx],
                ...cAct,
                // Ensure we never overwrite/clear a valid endTime recorded on the server
                endTime: mergedActivities[idx].endTime || cAct.endTime
              };
            }
          }
        }
        mergedActivities.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

        // Safe defensive merge of shiftEventLedger
        const mergedLedger = [...serverLedger];
        const clientLedger = updatedShift.shiftEventLedger || [];
        for (const cLed of clientLedger) {
          const existsOnServer = mergedLedger.some((sLed: any) => 
            sLed.timestamp === cLed.timestamp && sLed.eventType === cLed.eventType
          );
          if (!existsOnServer) {
            mergedLedger.push(cLed);
          }
        }
        mergedLedger.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        // Apply ONLY intended fields to prevent overwriting with stale objects
        const updates: any = {
          status: validatedStatus,
          lastHeartbeat: updatedShift.lastHeartbeat || getLiveTimeISO(),
          activities: mergedActivities,
          shiftEventLedger: mergedLedger,
          remarks: updatedShift.remarks || '',
          workLocation: updatedShift.workLocation || '',
          workLocationDetected: updatedShift.workLocationDetected || '',
          workLocationSource: updatedShift.workLocationSource || '',
          publicIP: updatedShift.publicIP || '',
          officeName: updatedShift.officeName || '',
          locationCapturedAt: updatedShift.locationCapturedAt || '',
          overrideBy: updatedShift.overrideBy || '',
          overrideAt: updatedShift.overrideAt || '',
          sessionExtended: updatedShift.sessionExtended || false,
          extended: updatedShift.extended || false
        };

        if (isCompleted) {
          updates.clockOutTime = updatedShift.clockOutTime || getLiveTimeISO();
          updates.endShiftTime = updatedShift.endShiftTime || updates.clockOutTime;
          updates.sessionClosedBy = updatedShift.sessionClosedBy || user?.uid || 'System';
          
          if (updatedShift.productiveMinutes !== undefined) updates.productiveMinutes = updatedShift.productiveMinutes;
          if (updatedShift.breakMinutes !== undefined) updates.breakMinutes = updatedShift.breakMinutes;
          if (updatedShift.shiftDuration !== undefined) updates.shiftDuration = updatedShift.shiftDuration;
          if (updatedShift.utilization !== undefined) updates.utilization = updatedShift.utilization;
        }

        // Commit atomically
        transaction.set(dbRef, cleanUndefined(updates), { merge: true });

        const liveSessionRef = doc(db, 'live_sessions', updatedShift.userId);
        if (isCompleted) {
          transaction.delete(liveSessionRef);
          const lockRef = doc(db, 'tmsActiveLocks', updatedShift.userId);
          transaction.delete(lockRef);
        } else {
          transaction.set(liveSessionRef, cleanUndefined(liveSessionData), { merge: true });
        }
      });

      // Synchronize to Realtime Database presence layer for bandwidth offloading
      if (isCompleted) {
        removeLiveSession(updatedShift.userId).catch(err => console.warn('rtdb remove fail:', err));
      } else {
        writeLiveSession(updatedShift.userId, liveSessionData).catch(err => console.warn('rtdb write fail:', err));
      }
      
      logTmsEvent('ACTIVITY_CHANGE', {
        userId: updatedShift.userId,
        shiftId: updatedShift.id,
        reason: `Saving shift state update (Status: ${updatedShift.status}, Activity: ${currentActivity})`,
        sourceFunction: 'TMSView.saveShiftState',
        details: { status: updatedShift.status, currentActivity, productiveMs, breakMs, isCompleted }
      });
      invalidateShiftCache({
        userId: updatedShift.userId,
        shiftId: updatedShift.id,
        teamLeadUid: (updatedShift as any).teamLeadUid,
        managerId: (updatedShift as any).managerId,
        reason: `save_shift_state_${updatedShift.status}`
      });
    } catch (e: any) {
      console.error('[TMS SESSION LOCK] Save failed:', e);
      if (e.message.includes('Shift already completed') || e.message.includes('Operation rejected')) {
        // toast.error(e.message);
      }
    }
  };

  const saveProcessesList = async (updatedList: string[]) => {
    const updatedProcesses = updatedList.map(name => ({
      name,
      status: 'Active' as const
    }));
    await setDoc(doc(db, 'config', 'tmsProcesses'), { 
      list: updatedList, 
      processes: updatedProcesses 
    }, { merge: true });
    
    // Immediately invalidate the cached processes list so the punch station reloads it on next render
    invalidateCacheKey('tms_processes_fetch');
  };

  const isSupervisorRole = (role: string | UserRole): boolean => {
    return checkIsDashboardUser((role || '').toString());
  };

  const formatTimeStr = (isoStr: any) => {
    const ms = parseTimestampMs(isoStr);
    if (!ms) return 'N/A';
    try {
      const d = new Date(ms);
      return d.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit', 
        hour12: true,
        timeZone: 'Asia/Kolkata' 
      });
    } catch {
      return 'N/A';
    }
  };

  // Helper: Format ISO timestamp to Date string in IST (DD/MM/YYYY)
  const formatDateStr = (isoStr: any) => {
    const ms = parseTimestampMs(isoStr);
    if (!ms) return 'N/A';
    try {
      const d = new Date(ms);
      return d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
      });
    } catch {
      return 'N/A';
    }
  };

  const [isProcessingPunch, setIsProcessingPunch] = useState(false);

  // Switch/Punch Shift Operations:
  const handleClockIn = async () => {
    if (isProcessingPunch) return;
    if (!hasTmsPermission('can_punch_in')) {
      toast.error('Access Denied: You do not have permissions to Punch In.');
      return;
    }

    const targetProcess = (selectedProcessInput || (allAvailableProcesses.length > 0 ? allAvailableProcesses[0] : '') || '').trim();
    if (!targetProcess) {
      toast.error('Please select a starting process before Clocking In.');
      return;
    }

    const isCurrentlyActive = currentShift && (currentShift.status === 'ACTIVE' || currentShift.status === 'BREAK');
    if (isCurrentlyActive) {
      toast.error('Action Blocked: You already have an active shift running. Please Clock Out of your current session first.');
      return;
    }

    // Show confirmation modal instead of immediate punch
    setSelectedProcessInput(targetProcess);
    setShowClockInConfirm(true);
  };

  const resumeCompletedShift = async (shift: TMSShift, resumeProcess: string) => {
    const nowISO = getLiveTimeISO();
    const currentDev = getDeviceType();

    const updatedActivities = [...(shift.activities || [])];
    updatedActivities.push({
      activityId: crypto.randomUUID(),
      action: 'RESUME_SHIFT',
      startTime: nowISO,
      process: resumeProcess || 'Active Work',
      actor: user?.email || user?.uid || 'Employee',
      sourceService: 'TMS_UI',
      type: 'productive',
      name: resumeProcess || 'Active Work',
      device: currentDev
    });

    const updatedShift: TMSShift = {
      ...shift,
      status: 'ACTIVE',
      clockOutTime: null,
      endShiftTime: null,
      locked: false,
      activities: updatedActivities,
      shiftEventLedger: appendShiftEvent(shift.shiftEventLedger, shift, {
        eventType: 'SHIFT_RESUME',
        timestamp: nowISO,
        performedBy: user.name || 'Employee',
        source: 'TMS',
        reason: 'User manual shift resume (Same-day reconnect)',
        newValue: resumeProcess,
        metadata: { process: resumeProcess, previousId: shift.id }
      })
    };

    setRawActiveShift(updatedShift);
    setCurrentShift(updatedShift);
    setLocalOwnShift(updatedShift);
    setSelectedProcessInput(resumeProcess);

    try {
      const lockRef = doc(db, 'tmsActiveLocks', user.uid);
      const shiftRef = doc(db, 'tmsShifts', shift.id);
      const userRef = doc(db, 'users', user.uid);
      const liveSessionRef = doc(db, 'live_sessions', user.uid);

      await runTransaction(db, async (transaction) => {
        // A. Read the lock document inside transaction
        const lockSnap = await transaction.get(lockRef);
        if (lockSnap.exists()) {
          const lockData = lockSnap.data();
          if (lockData && (lockData.status === 'ACTIVE' || lockData.status === 'BREAK')) {
            throw new Error("ACTIVE_SHIFT_ALREADY_EXISTS");
          }
        }

        // B. Read shift being resumed inside transaction
        const shiftSnap = await transaction.get(shiftRef);
        if (!shiftSnap.exists()) {
          throw new Error("SHIFT_NOT_FOUND");
        }

        // C. Generate live session data for the write
        const lastAct = getLatestUserActivity(updatedShift.activities || []);
        const currentActivity = (lastAct && !lastAct.endTime && lastAct.name) || 'Offline';
        const currentActivityStartTime = lastAct ? lastAct.startTime : getLiveTimeISO();

        const liveSessionData = {
          sessionId: updatedShift.id,
          userId: updatedShift.userId,
          uid: updatedShift.userId,
          employeeId: updatedShift.userId,
          employeeName: updatedShift.userName || '',
          email: updatedShift.userEmail || '',
          userEmail: updatedShift.userEmail || '',
          process: lastAct?.name || user?.team || user?.process || 'N/A',
          teamLead: user?.teamLeadId || user?.teamLeadUid || '',
          tlId: user?.teamLeadId || user?.teamLeadUid || '',
          manager: user?.mappedManagerId || user?.managerId || '',
          managerId: user?.mappedManagerId || user?.managerId || '',
          isOnline: true,
          status: 'ACTIVE',
          currentActivity: currentActivity,
          clockInTime: updatedShift.clockInTime,
          statusStartTime: currentActivityStartTime,
          currentActivityStartTime: currentActivityStartTime,
          lastHeartbeat: getLiveTimeISO(),
          activities: updatedShift.activities || [],
          
          workLocation: updatedShift.workLocation || '',
          workLocationDetected: updatedShift.workLocationDetected || '',
          workLocationSource: updatedShift.workLocationSource || '',
          publicIP: updatedShift.publicIP || '',
          officeName: updatedShift.officeName || '',
          locationCapturedAt: updatedShift.locationCapturedAt || '',
          overrideBy: updatedShift.overrideBy || '',
          overrideAt: updatedShift.overrideAt || ''
        };

        // D. Perform transaction writes
        // 1. Write Lock document
        transaction.set(lockRef, cleanUndefined({
          shiftId: updatedShift.id,
          status: 'ACTIVE',
          clockInTime: updatedShift.clockInTime,
          lastHeartbeat: nowISO,
          userId: user.uid,
          userName: user.name || 'Anonymous User',
          userEmail: user?.email || user?.uid || 'Unknown',
          updatedAt: serverTimestamp()
        }), { merge: true });

        // 2. Write Shift document
        transaction.set(shiftRef, cleanUndefined(updatedShift));

        // 3. Write Live Session
        transaction.set(liveSessionRef, cleanUndefined(liveSessionData), { merge: true });

        // Expose to outer scope for RTDB synchronization
        (window as any)._tempReconnectLiveSessionData = liveSessionData;
      });

      // Synchronize to Realtime Database presence layer for bandwidth offloading
      if ((window as any)._tempReconnectLiveSessionData) {
        writeLiveSession(user.uid, (window as any)._tempReconnectLiveSessionData).catch(err => console.warn('rtdb write fail:', err));
        delete (window as any)._tempReconnectLiveSessionData;
      }

      logTmsEvent('CLOCK_IN', {
        userId: user.uid,
        shiftId: updatedShift.id,
        timestamp: nowISO,
        reason: 'User manual shift resume (Same-day) with transaction safety',
        sourceFunction: 'TMSView.resumeCompletedShift',
        details: { process: resumeProcess }
      });
      toast.success(`Resumed work successfully! Process: ${resumeProcess}`);
    } catch (e: any) {
      if (e.message === "ACTIVE_SHIFT_ALREADY_EXISTS") {
        toast.warning("You already have an active session running elsewhere. Syncing status...");
        invalidateShiftCache({
          userId: user.uid,
          reason: 'resume_shift_already_exists_sync'
        });
      } else {
        console.error('Resume failed:', e);
        toast.error('Failed to resume shift: ' + e.message);
        // Revert optimistic state
        setLocalOwnShift(undefined);
        setCurrentShift(null);
      }
    }
  };

  const performClockIn = async () => {
    if (isProcessingPunch) return;
    const targetProcess = selectedProcessInput;
    if (!targetProcess) return;

    setIsProcessingPunch(true);
    setShowClockInConfirm(false); // Close modal on confirmed start

    // FOOLPROOF GUARD: Check Firestore directly for any ACTIVE/BREAK shift.
    try {
      const now = getLiveTime();
      const cutoffMs = now.getTime() - (24 * 60 * 60 * 1000); // Look back 24 hours for any active session
      const cutoffISO = new Date(cutoffMs).toISOString();

      const qCheck = query(
        collection(db, 'tmsShifts'),
        where('userId', '==', user.uid),
        where('clockInTime', '>=', cutoffISO),
        limit(5)
      );
      const checkSnap = await getDocs(qCheck);
      const sameDayShifts = checkSnap.docs.map(d => ({ id: d.id, ...d.data() } as TMSShift));
      
      // 1. Check for ACTIVE/BREAK first (standard resume/re-sync)
      const activeShift = sameDayShifts.find(s => s.status === 'ACTIVE' || s.status === 'BREAK');
      if (activeShift) {
        toast.warning("You already have an active or break session running. Re-syncing status...");
        setRawActiveShift(activeShift);
        setCurrentShift(activeShift);
        setLocalOwnShift(activeShift);
        setIsProcessingPunch(false);
        return;
      }
    } catch (errCheck) {
      console.error("Failed to pre-verify active session status", errCheck);
    }
    
    const nowISO = getLiveTimeISO();
    const currentDev = getDeviceType();
    const meta = getDetailedDeviceMetadata();
    
    const uaVal = typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A';
    const platVal = typeof navigator !== 'undefined' ? navigator.platform : 'N/A';
    const touchVal = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0;
    const swVal = typeof window !== 'undefined' && window.screen ? window.screen.width : 0;
    const shVal = typeof window !== 'undefined' && window.screen ? window.screen.height : 0;

    // Log exactly as requested
    console.log(`[DEVICE DETECTION]`);
    console.log(`userAgent=${uaVal}`);
    console.log(`platform=${platVal}`);
    console.log(`maxTouchPoints=${touchVal}`);
    console.log(`detectedDeviceType=${meta.deviceType}`);
    console.log(`detectedBrowser=${meta.browser}`);
    console.log(`detectedOS=${meta.os}`);

    // ----------------------------------------------------
    // WORK LOCATION DETECTION (PHASE 1)
    // ----------------------------------------------------
    let publicIP = '0.0.0.0';
    let detectedLocation = 'Home';
    let officeName = '';
    
    console.log('[IP DETECTION] Retrieving public IPv4 from proactive background lookup...');
    try {
      publicIP = await getOrFetchPublicIP();
      console.log(`[IP DETECTION] Retrieved IP: [${publicIP}]`);
    } catch (err) {
      console.warn('[IP DETECTION] Failed to retrieve proactive IP. Defaulting to 0.0.0.0.');
    }

    let officesList: any[] = [];
    const defaultOffices = [
      {
        id: 'office_001',
        officeName: 'Berg Dehradun',
        publicIP: '115.243.137.122',
        status: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'office_002',
        officeName: 'Berg Noida',
        publicIP: '125.23.171.67',
        status: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'office_003',
        officeName: 'Berg Delhi',
        publicIP: '182.71.113.42',
        status: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    try {
      let networksData = officeNetworks;
      if (!networksData) {
        console.log('[IP DETECTION] officeNetworks is null/empty in ConfigContext. Reading directly from Firestore config/office_networks...');
        const officeNetworksRef = doc(db, 'config', 'office_networks');
        const officeSnap = await getDocOptimized(officeNetworksRef, 'office_networks_global', false);
        if (officeSnap.exists()) {
          networksData = officeSnap.data();
          console.log('[IP DETECTION] office_networks document fetched successfully.');
        } else {
          console.log('[IP DETECTION] office_networks document does not exist in DB. Self-healing with defaults...');
          try {
            const { setDoc } = await import('firebase/firestore');
            await setDoc(officeNetworksRef, { offices: defaultOffices });
          } catch (err) {
            console.error("[IP DETECTION] Failed to self-heal office networks:", err);
          }
          networksData = { offices: defaultOffices };
        }
      }
      
      let fetchedOffices: any[] = [];
      if (networksData && Array.isArray(networksData.offices)) {
        fetchedOffices = networksData.offices;
      } else if (networksData && Array.isArray(networksData.officeIPs)) {
        fetchedOffices = networksData.officeIPs.map((ip: string, idx: number) => ({
          id: `office_legacy_${idx}`,
          officeName: `Berg Office ${idx + 1}`,
          publicIP: ip,
          status: true
        }));
      }

      // MERGE RULE: Always include hardcoded offices to guarantee detection works, and layer Console configurations on top
      const officeMap = new Map<string, any>();
      defaultOffices.forEach(o => officeMap.set(o.publicIP, o));
      fetchedOffices.forEach(o => {
        if (o && o.publicIP) {
          officeMap.set(o.publicIP, { ...officeMap.get(o.publicIP), ...o });
        }
      });
      officesList = Array.from(officeMap.values());
    } catch (confErr) {
      console.error("[IP DETECTION] Failed to load whitelisted office networks, falling back to hardcoded defaults:", confErr);
      officesList = defaultOffices;
    }

    // Split detected IP address by commas and strictly filter/validate IPv4
    const detectedIPs = publicIP.split(',').map(ip => ip.trim()).filter(ip => ipv4Regex.test(ip));
    console.log('[IP DETECTION] Tokenized Valid User IPv4s:', detectedIPs);
    console.log('[IP DETECTION] Comparing against whitelisted offices (including merged defaults):', officesList.map(o => ({ name: o.officeName, ip: o.publicIP, status: o.status })));
    
    const matchingOffice = officesList.find(office => {
      if (!office.publicIP) return false;
      
      // Split configured office IP by commas and validate IPv4
      const officeIPs = office.publicIP.split(',').map((ip: string) => ip.trim()).filter(ip => ipv4Regex.test(ip));
      
      // Check if any of the user's detected IPv4s matches any configured office IPv4
      const isIPMatch = officeIPs.some((offIP: string) => 
        detectedIPs.some(usrIP => usrIP === offIP)
      );
      
      // Permissive boolean check
      const isActive = office.status === true || 
                       String(office.status).toLowerCase() === 'true' || 
                       String(office.status).toLowerCase() === 'active';
                        
      console.log(`[IP DETECTION] Matching office [${office.officeName}]: IPs=[${office.publicIP}], isIPMatch=${isIPMatch}, isActive=${isActive}`);
      return isIPMatch && isActive;
    });

    if (matchingOffice) {
      detectedLocation = 'Office';
      officeName = matchingOffice.officeName || 'Berg Office';
      console.log(`[IP DETECTION] MATCH SUCCESS! Location set to Office (${officeName})`);
      toast.info(`Clocking in from Office Location: ${officeName} (IP: ${publicIP})`);
    } else {
      detectedLocation = 'Home';
      officeName = '';
      console.log(`[IP DETECTION] MATCH FAILED! No active office matched the detected IP list.`);
      toast.info(`No office matching IP ${publicIP} was found. Defaulting to Home Location.`);
    }

    const initialLedger = appendShiftEvent(
      undefined,
      undefined,
      {
        eventType: 'CLOCK_IN',
        timestamp: nowISO,
        performedBy: user.name || 'Employee',
        source: 'TMS',
        reason: 'User manual clock-in',
        oldValue: null,
        newValue: targetProcess,
        metadata: { process: targetProcess || 'Active Work', workLocation: detectedLocation, publicIP }
      }
    );

    const newShift: TMSShift = {
      id: `shift-${user.uid || 'anon'}-${Date.now()}`,
      userId: user.uid || '',
      userName: user.name || 'Anonymous User',
      userEmail: user?.email || user?.uid || 'Unknown' || '',
      teamLeadUid: (user as any).teamLeadUid || (user as any).teamLeadId || '',
      mappedTL: (user as any).teamLeadEmail || (user as any).mappedTL || 'N/A',
      mappedManager: (user as any).mappedManagerEmail || (user as any).mappedManager || 'N/A',
      clockInTime: nowISO,
      status: 'ACTIVE',
      clockInDevice: currentDev,
      hasMobilePunches: currentDev === 'mobile',
      deviceType: meta.deviceType,
      browser: meta.browser,
      os: meta.os,
      loginTimestamp: meta.loginTimestamp,
      // Work Location Detection fields
      workLocation: detectedLocation,
      workLocationDetected: detectedLocation,
      workLocationSource: 'IP Detection',
      publicIP: publicIP,
      officeName: officeName,
      locationCapturedAt: nowISO,
      // Diagnostics
      userAgent: uaVal,
      platform: platVal,
      maxTouchPoints: touchVal,
      screenWidth: swVal,
      screenHeight: shVal,
      detectedDeviceType: meta.deviceType,
      detectedBrowser: meta.browser,
      detectedOS: meta.os,
      shiftEventLedger: initialLedger,
      activities: [
        {
          activityId: crypto.randomUUID(),
          action: 'CLOCK_IN',
          startTime: nowISO,
          process: targetProcess || 'Active Work',
          actor: user?.email || user?.uid || 'Employee',
          sourceService: 'TMS_UI',
          type: 'productive',
          name: targetProcess || 'Active Work',
          device: currentDev
        }
      ]
    };

    // 1. Close modal and set state immediately (Optimistic Update)
    setLocalOwnShift(newShift);
    setCurrentShift(newShift);
    setSelectedProcessInput(targetProcess);

    let activeShiftFoundFromLock: any = null;

    try {
      const lockRef = doc(db, 'tmsActiveLocks', user.uid);
      const userRef = doc(db, 'users', user.uid);
      const liveSessionRef = doc(db, 'live_sessions', user.uid);

      await runTransaction(db, async (transaction) => {
        // A. Read the lock document inside the transaction
        const lockSnap = await transaction.get(lockRef);
        if (lockSnap.exists()) {
          const lockData = lockSnap.data();
          if (lockData && (lockData.status === 'ACTIVE' || lockData.status === 'BREAK')) {
            const existingShiftId = lockData.shiftId;
            if (existingShiftId) {
              const existingShiftSnap = await transaction.get(doc(db, 'tmsShifts', existingShiftId));
              if (existingShiftSnap.exists()) {
                const existingShiftData = existingShiftSnap.data();
                const sStatus = existingShiftData.status;
                if (sStatus === 'ACTIVE' || sStatus === 'BREAK') {
                  activeShiftFoundFromLock = { id: existingShiftId, ...existingShiftData };
                  throw new Error("ACTIVE_SHIFT_ALREADY_EXISTS");
                }
              }
            }
          }
        }

        // B. Generate live session data for the write
        const lastAct = getLatestUserActivity(newShift.activities || []);
        const currentActivity = (lastAct && !lastAct.endTime && lastAct.name) || 'Offline';
        const currentActivityStartTime = lastAct ? lastAct.startTime : getLiveTimeISO();

        const liveSessionData = {
          sessionId: newShift.id,
          userId: newShift.userId,
          uid: newShift.userId,
          employeeId: newShift.userId,
          employeeName: newShift.userName || '',
          email: newShift.userEmail || '',
          userEmail: newShift.userEmail || '',
          process: lastAct?.name || user?.team || user?.process || 'N/A',
          teamLead: user?.teamLeadId || user?.teamLeadUid || '',
          tlId: user?.teamLeadId || user?.teamLeadUid || '',
          manager: user?.mappedManagerId || user?.managerId || '',
          managerId: user?.mappedManagerId || user?.managerId || '',
          isOnline: true,
          status: 'ACTIVE',
          currentActivity: currentActivity,
          clockInTime: newShift.clockInTime,
          statusStartTime: currentActivityStartTime,
          currentActivityStartTime: currentActivityStartTime,
          lastHeartbeat: getLiveTimeISO(),
          activities: newShift.activities || [],
          
          // Work Location Detection fields
          workLocation: newShift.workLocation || '',
          workLocationDetected: newShift.workLocationDetected || '',
          workLocationSource: newShift.workLocationSource || '',
          publicIP: newShift.publicIP || '',
          officeName: newShift.officeName || '',
          locationCapturedAt: newShift.locationCapturedAt || '',
          overrideBy: newShift.overrideBy || '',
          overrideAt: newShift.overrideAt || ''
        };

        // C. Perform transaction writes
        // 1. Write Lock document
        transaction.set(lockRef, cleanUndefined({
          shiftId: newShift.id,
          status: 'ACTIVE',
          clockInTime: nowISO,
          lastHeartbeat: nowISO,
          userId: user.uid,
          userName: user.name || 'Anonymous User',
          userEmail: user?.email || user?.uid || 'Unknown',
          updatedAt: serverTimestamp()
        }), { merge: true });

        // 2. Write Shift document
        transaction.set(doc(db, 'tmsShifts', newShift.id), cleanUndefined(newShift));

        // 3. Write Live Session document
        transaction.set(liveSessionRef, cleanUndefined(liveSessionData), { merge: true });
        
        // Expose to outer scope for RTDB synchronization
        (window as any)._tempClockInLiveSessionData = liveSessionData;
      });

      // D. Success sequence
      if ((window as any)._tempClockInLiveSessionData) {
        writeLiveSession(user.uid, (window as any)._tempClockInLiveSessionData).catch(err => console.warn('rtdb write fail:', err));
        delete (window as any)._tempClockInLiveSessionData;
      }

      invalidateShiftCache({
        userId: user.uid,
        shiftId: newShift.id,
        teamLeadUid: newShift.teamLeadUid,
        managerId: (newShift as any).managerId,
        reason: 'agent_clock_in'
      });
      logTmsEvent('CLOCK_IN', {
        userId: user.uid,
        shiftId: newShift.id,
        timestamp: nowISO,
        reason: 'User manual clock-in with transaction safety',
        sourceFunction: 'TMSView.performClockIn',
        details: { process: targetProcess || 'Active Work', workLocation: detectedLocation, publicIP }
      });
      toast.success(`Clocked In successfully! Process: ${targetProcess}`);

    } catch (e: any) {
      if (e.message === "ACTIVE_SHIFT_ALREADY_EXISTS" && activeShiftFoundFromLock) {
        toast.warning("You already have an active or break session running. Re-syncing status...");
        setRawActiveShift(activeShiftFoundFromLock);
        setCurrentShift(activeShiftFoundFromLock);
        setLocalOwnShift(activeShiftFoundFromLock);
      } else {
        console.error('Transaction clock-in failed:', e);
        toast.error('Failed to complete clock-in on server: ' + e.message);
        // Revert optimistic state on error
        setLocalOwnShift(undefined);
        setCurrentShift(null);
      }
    } finally {
      setIsProcessingPunch(false);
      setShowClockInConfirm(false);
    }
  };

  const handleManualLocationOverride = async (newLocation: string) => {
    if (!currentShift) return;
    
    const nowISO = getLiveTimeISO();
    const updatedShift: TMSShift = {
      ...currentShift,
      workLocation: newLocation,
      workLocationSource: 'Manual Override',
      overrideBy: user.uid,
      overrideAt: nowISO
    };
    
    // Optimistic Update
    setCurrentShift(updatedShift);
    setLocalOwnShift(updatedShift);
    setRawActiveShift(updatedShift);
    
    try {
      await saveShiftState(updatedShift);
      toast.success(`Work location updated to: ${newLocation === 'Office' ? '🏢 Office' : '🏠 Home'}`);
    } catch (err: any) {
      console.error("Failed to save location override:", err);
      toast.error("Failed to save location override: " + err.message);
    }
  };

  const handleExtendShift = async () => {
    if (!currentShift) return;
    try {
      const nowStr = getLiveTimeISO();
      const updatedLedger = appendShiftEvent(currentShift.shiftEventLedger || [], currentShift, {
        eventType: 'SHIFT_EXTENSION',
        timestamp: nowStr,
        performedBy: user.fullName || user.name || 'Supervisor',
        source: 'Supervisor Panel',
        reason: 'Manual extension request from Supervisor Punch Station',
        newValue: 'EXTENDED'
      });
      const updatedShift: TMSShift = {
        ...currentShift,
        extended: true,
        sessionExtended: true,
        shiftEventLedger: updatedLedger
      };
      // Optimistic update
      setCurrentShift(updatedShift);
      setLocalOwnShift(updatedShift);
      setRawActiveShift(updatedShift);
      setLocalSessionExtended(true);
      
      await saveShiftState(updatedShift);
      toast.success('Your shift has been successfully extended!');
    } catch (err) {
      console.error('Error extending shift:', err);
      toast.error('Failed to extend shift');
    }
  };

  const handleSwitchProcess = async (targetProcess: string) => {
    if (isProcessingPunch) return;
    if (!hasTmsPermission('can_switch_process')) {
      toast.error('Access Denied: You do not have permissions to Switch Processes.');
      return;
    }

    if (!currentShift) return;
    if (currentShift.status === 'BREAK') {
      toast.error('Cannot switch processes while on a break. Please Resume Work first.');
      return;
    }

    // Find active activity
    const lastActivity = currentShift.activities[currentShift.activities.length - 1];
    if (lastActivity && lastActivity.type === 'productive' && lastActivity.name === targetProcess) {
      toast.warning(`You are already actively working on ${targetProcess}.`);
      return;
    }

    setIsProcessingPunch(true);
    const previousShift = currentShift;
    try {
      const nowISO = getLiveTimeISO();
      const currentDev = getDeviceType();
      const meta = getDetailedDeviceMetadata();
      const updatedActivities = [...currentShift.activities];
      const lastActivity = updatedActivities[updatedActivities.length - 1];
      
      // Terminate last activity
      if (updatedActivities.length > 0) {
        // Immutable ledger: endTime mutation removed
      }

      // Add new active process segment
      updatedActivities.push({
        activityId: crypto.randomUUID(),
        action: (currentShift?.status === 'BREAK' ? 'BREAK_END' : 'PROCESS_SWITCH'),
        startTime: nowISO,
        process: targetProcess || 'Active Work',
        actor: user?.email || user?.uid || 'Employee',
        sourceService: 'TMS_UI',
        type: 'productive',
        name: targetProcess || 'Active Work',
        device: currentDev
      });

      const updatedLedger = appendShiftEvent(
        currentShift.shiftEventLedger,
        currentShift,
        {
          eventType: 'PROCESS_SWITCH',
          timestamp: nowISO,
          performedBy: user.name || 'Employee',
          source: 'TMS',
          reason: `Switched process from ${lastActivity?.name || 'none'} to ${targetProcess}`,
          oldValue: lastActivity?.name || null,
          newValue: targetProcess,
          metadata: { previousProcess: lastActivity?.name || '', nextProcess: targetProcess }
        }
      );

      const updatedShift: TMSShift = {
        ...currentShift,
        activities: updatedActivities,
        status: 'ACTIVE',
        hasMobilePunches: currentShift.hasMobilePunches || currentDev === 'mobile',
        deviceType: meta.deviceType,
        browser: meta.browser,
        os: meta.os,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : currentShift.userAgent,
        platform: typeof navigator !== 'undefined' ? navigator.platform : currentShift.platform,
        maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : currentShift.maxTouchPoints,
        detectedDeviceType: meta.deviceType,
        detectedBrowser: meta.browser,
        detectedOS: meta.os,
        shiftEventLedger: updatedLedger
      };

      // 1. Optimistic Update
      setLocalOwnShift(updatedShift);
      setCurrentShift(updatedShift);
      setSelectedProcessInput(targetProcess);
      updateRecent(targetProcess);
      safeStorage.set(`tms_last_used_process_${user.uid}`, targetProcess);
      lastSyncedShiftId.current = `${updatedShift.id}_${updatedShift.status}_${targetProcess}`;

      // 2. Perform database writes (only shift and live_session states)
      await saveShiftState(updatedShift);

      invalidateShiftCache({
        userId: user.uid,
        shiftId: updatedShift.id,
        reason: 'agent_switch_process'
      });
      logTmsEvent('ACTIVITY_CHANGE', {
        userId: user.uid,
        shiftId: updatedShift.id,
        timestamp: nowISO,
        reason: `Switched process to ${targetProcess}`,
        sourceFunction: 'TMSView.handleSwitchProcess',
        details: { newProcess: targetProcess }
      });
      toast.success(`Process switched to: ${targetProcess}`);
    } catch (e: any) {
      console.error('Process switch failed:', e);
      toast.error('Failed to switch process on server: ' + e.message);
      // Revert optimistic update
      setLocalOwnShift(previousShift ? previousShift : undefined);
      setCurrentShift(previousShift);
    } finally {
      setIsProcessingPunch(false);
    }
  };

  const handleStartBreak = async () => {
    if (isProcessingPunch) return;
    if (!currentShift) return;

    // Temporal guard: Ignore break requests if shift started too recently (prevents race conditions/ghost punches)
    const shiftStartMs = new Date(currentShift.clockInTime).getTime();
    const timeSinceStart = Date.now() - shiftStartMs;
    if (timeSinceStart < 5000) {
      console.warn('[TMS] Break request blocked: Shift started too recently (possible ghost punch).');
      return;
    }

    if (currentShift.status === 'BREAK') {
      toast.error('You are already on a break.');
      return;
    }

    const breakType = selectedBreakInput || '';
    const isLunch = breakType.toLowerCase().includes('lunch');
    const isMeeting = breakType.toLowerCase().includes('meeting') || breakType.toLowerCase().includes('coaching') || breakType.toLowerCase().includes('training');

    if (isLunch) {
      if (!hasTmsPermission('can_start_lunch')) {
        toast.error('Access Denied: You do not have permission to Start Lunch.');
        return;
      }
    } else if (isMeeting) {
      if (!hasTmsPermission('can_start_meeting')) {
        toast.error('Access Denied: You do not have permission to Start Meetings/Trainings.');
        return;
      }
    } else {
      if (!hasTmsPermission('can_start_break')) {
        toast.error('Access Denied: You do not have permission to Start Breaks.');
        return;
      }
    }

    setIsProcessingPunch(true);
    const previousShift = currentShift;

    try {
      const nowISO = getLiveTimeISO();
      const currentDev = getDeviceType();
      const meta = getDetailedDeviceMetadata();
      const breakType = selectedBreakInput || 'Break';
      const shiftId = currentShift.id;
      const shiftRef = doc(db, 'tmsShifts', shiftId);
      const lsRef = doc(db, 'live_sessions', user.uid);

      let finalShiftState: TMSShift | null = null;

      await runTransaction(db, async (transaction) => {
        const shiftSnap = await transaction.get(shiftRef);
        const lsSnap = await transaction.get(lsRef);
        if (!shiftSnap.exists()) throw new Error("Shift document not found on server.");

        const currentShiftData = shiftSnap.data();
        const completedStatuses = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'];
        if (completedStatuses.includes(currentShiftData.status)) {
          throw new Error("Shift is already completed on the server.");
        }

        const currentActivities = [...(currentShiftData.activities || [])];
        
        // Add new break activity segment
        const newActivity = {
          activityId: crypto.randomUUID(),
          action: 'BREAK_START',
          startTime: nowISO,
          process: breakType,
          actor: user?.email || user?.uid || 'Employee',
          sourceService: 'TMS_UI',
          type: 'break',
          name: breakType,
          device: currentDev
        };
        currentActivities.push(newActivity);

        const lastProductive = [...currentActivities]
          .reverse()
          .find(act => act.type === 'productive');
        if (lastProductive) {
          setSelectedProcessInput(lastProductive.name);
        }

        const lastProductiveName = lastProductive?.name || 'Work';
        const updatedLedger = appendShiftEvent(
          currentShiftData.shiftEventLedger || [],
          { ...currentShiftData, id: shiftId },
          {
            eventType: 'BREAK_START',
            timestamp: nowISO,
            performedBy: user.name || 'Employee',
            source: 'TMS',
            reason: `Started break: ${breakType}`,
            oldValue: lastProductiveName,
            newValue: breakType,
            metadata: { breakType }
          }
        );

        const updates = {
          status: 'BREAK',
          lastHeartbeat: nowISO,
          activities: currentActivities,
          shiftEventLedger: updatedLedger,
          hasMobilePunches: currentShiftData.hasMobilePunches || currentDev === 'mobile',
          breakStartTime: serverTimestamp(),
          deviceType: meta.deviceType,
          browser: meta.browser,
          os: meta.os,
          detectedDeviceType: meta.deviceType,
          detectedBrowser: meta.browser,
          detectedOS: meta.os,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : (currentShiftData.userAgent || ''),
          platform: typeof navigator !== 'undefined' ? navigator.platform : (currentShiftData.platform || ''),
          maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : (currentShiftData.maxTouchPoints || 0)
        };

        transaction.set(shiftRef, cleanUndefined(updates), { merge: true });

        const liveSessionData = {
          sessionId: shiftId,
          userId: user.uid,
          uid: user.uid,
          employeeId: user.uid,
          employeeName: user.name || '',
          email: user.email || '',
          userEmail: user.email || '',
          process: breakType,
          teamLead: user?.teamLeadId || user?.teamLeadUid || '',
          tlId: user?.teamLeadId || user?.teamLeadUid || '',
          manager: user?.mappedManagerId || user?.managerId || '',
          managerId: user?.mappedManagerId || user?.managerId || '',
          isOnline: true,
          status: 'BREAK',
          currentActivity: breakType,
          clockInTime: currentShiftData.clockInTime,
          statusStartTime: nowISO,
          currentActivityStartTime: nowISO,
          lastHeartbeat: nowISO,
          activities: currentActivities,
          breakStartTime: serverTimestamp(),
          workLocation: currentShiftData.workLocation || '',
          workLocationDetected: currentShiftData.workLocationDetected || '',
          workLocationSource: currentShiftData.workLocationSource || ''
        };

        transaction.set(lsRef, cleanUndefined(liveSessionData), { merge: true });

        // Expose to outer scope for RTDB synchronization
        (window as any)._tempBreakLiveSessionData = liveSessionData;

        finalShiftState = {
          ...currentShiftData,
          ...updates,
          id: shiftId
        } as any as TMSShift;
      });

      if (finalShiftState) {
        if ((window as any)._tempBreakLiveSessionData) {
          writeLiveSession(user.uid, (window as any)._tempBreakLiveSessionData).catch(err => console.warn('rtdb write fail:', err));
          delete (window as any)._tempBreakLiveSessionData;
        }
        setLocalOwnShift(finalShiftState);
        setCurrentShift(finalShiftState);

        // Cache Invalidation & Session syncing
        localStorage.setItem('tms_last_active_shift_id', shiftId);
        localStorage.setItem('tms_last_active_shift_json', JSON.stringify(finalShiftState));

        invalidateShiftCache({
          userId: user.uid,
          shiftId: shiftId,
          reason: 'agent_start_break'
        });
        console.log(`[BREAK STATE CHANGE] uid=${user.uid} reason=${breakType} source=TMSView.handleStartBreak status=BREAK`);
        logTmsEvent('BREAK_START', {
          userId: user.uid,
          shiftId: shiftId,
          timestamp: nowISO,
          reason: `Started break: ${breakType}`,
          sourceFunction: 'TMSView.handleStartBreak',
          details: { breakType: breakType }
        });
        toast.success(`Break started: ${breakType}`);
      }
    } catch (e: any) {
      console.error('Start break failed:', e);
      toast.error('Failed to start break on server: ' + e.message);
      // Revert optimistic update
      setLocalOwnShift(previousShift ? previousShift : undefined);
      setCurrentShift(previousShift);
    } finally {
      setIsProcessingPunch(false);
    }
  };

  const handleTakeBreak = async (breakName: string) => {
    if (isProcessingPunch) return;
    if (!currentShift) return;

    const shiftStartMs = new Date(currentShift.clockInTime).getTime();
    const timeSinceStart = Date.now() - shiftStartMs;
    if (timeSinceStart < 5000) {
      console.warn('[TMS] Break request blocked: Shift started too recently (possible ghost punch).');
      return;
    }

    if (currentShift.status === 'BREAK') {
      toast.error('You are already on a break.');
      return;
    }

    setIsProcessingPunch(true);
    const breakType = breakName || '';
    const isLunch = breakType.toLowerCase().includes('lunch');
    const isMeeting = breakType.toLowerCase().includes('meeting') || breakType.toLowerCase().includes('coaching') || breakType.toLowerCase().includes('training');

    if (isLunch) {
      if (!hasTmsPermission('can_start_lunch')) {
        toast.error('Access Denied: You do not have permission to Start Lunch.');
        setIsProcessingPunch(false);
        return;
      }
    } else if (isMeeting) {
      if (!hasTmsPermission('can_start_meeting')) {
        toast.error('Access Denied: You do not have permission to Start Meetings/Trainings.');
        setIsProcessingPunch(false);
        return;
      }
    } else {
      if (!hasTmsPermission('can_start_break')) {
        toast.error('Access Denied: You do not have permission to Start Breaks.');
        setIsProcessingPunch(false);
        return;
      }
    }

    const previousShift = currentShift;

    try {
      const nowISO = getLiveTimeISO();
      const currentDev = getDeviceType();
      const meta = getDetailedDeviceMetadata();
      const shiftId = currentShift.id;
      const shiftRef = doc(db, 'tmsShifts', shiftId);
      const lsRef = doc(db, 'live_sessions', user.uid);

      let finalShiftState: TMSShift | null = null;

      await runTransaction(db, async (transaction) => {
        const shiftSnap = await transaction.get(shiftRef);
        const lsSnap = await transaction.get(lsRef);
        if (!shiftSnap.exists()) throw new Error("Shift document not found on server.");

        const currentShiftData = shiftSnap.data();
        const completedStatuses = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'];
        if (completedStatuses.includes(currentShiftData.status)) {
          throw new Error("Shift is already completed on the server.");
        }

        const currentActivities = [...(currentShiftData.activities || [])];
        
        // Add new break activity segment
        const newActivity = {
          activityId: crypto.randomUUID(),
          action: 'BREAK_START',
          startTime: nowISO,
          process: breakType || 'Break',
          actor: user?.email || user?.uid || 'Employee',
          sourceService: 'TMS_UI',
          type: 'break',
          name: breakType || 'Break',
          device: currentDev
        };
        currentActivities.push(newActivity);

        const lastProductive = [...currentActivities]
          .reverse()
          .find(act => act.type === 'productive');
        if (lastProductive) {
          setSelectedProcessInput(lastProductive.name);
        }

        const lastProductiveName = lastProductive?.name || 'Work';
        const updatedLedger = appendShiftEvent(
          currentShiftData.shiftEventLedger || [],
          { ...currentShiftData, id: shiftId },
          {
            eventType: 'BREAK_START',
            timestamp: nowISO,
            performedBy: user.name || 'Employee',
            source: 'TMS',
            reason: `Started break: ${breakType}`,
            oldValue: lastProductiveName,
            newValue: breakType,
            metadata: { breakType }
          }
        );

        const updates = {
          status: 'BREAK',
          lastHeartbeat: nowISO,
          activities: currentActivities,
          shiftEventLedger: updatedLedger,
          hasMobilePunches: currentShiftData.hasMobilePunches || currentDev === 'mobile',
          breakStartTime: serverTimestamp(),
          deviceType: meta.deviceType,
          browser: meta.browser,
          os: meta.os,
          detectedDeviceType: meta.deviceType,
          detectedBrowser: meta.browser,
          detectedOS: meta.os,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : (currentShiftData.userAgent || ''),
          platform: typeof navigator !== 'undefined' ? navigator.platform : (currentShiftData.platform || ''),
          maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : (currentShiftData.maxTouchPoints || 0)
        };

        transaction.set(shiftRef, cleanUndefined(updates), { merge: true });

        const liveSessionData = {
          sessionId: shiftId,
          userId: user.uid,
          uid: user.uid,
          employeeId: user.uid,
          employeeName: user.name || '',
          email: user.email || '',
          userEmail: user.email || '',
          process: breakType || 'Break',
          teamLead: user?.teamLeadId || user?.teamLeadUid || '',
          tlId: user?.teamLeadId || user?.teamLeadUid || '',
          manager: user?.mappedManagerId || user?.managerId || '',
          managerId: user?.mappedManagerId || user?.managerId || '',
          isOnline: true,
          status: 'BREAK',
          currentActivity: breakType || 'Break',
          clockInTime: currentShiftData.clockInTime,
          statusStartTime: nowISO,
          currentActivityStartTime: nowISO,
          lastHeartbeat: nowISO,
          activities: currentActivities,
          breakStartTime: serverTimestamp(),
          workLocation: currentShiftData.workLocation || '',
          workLocationDetected: currentShiftData.workLocationDetected || '',
          workLocationSource: currentShiftData.workLocationSource || ''
        };

        transaction.set(lsRef, cleanUndefined(liveSessionData), { merge: true });

        // Expose to outer scope for RTDB synchronization
        (window as any)._tempTakeBreakLiveSessionData = liveSessionData;

        finalShiftState = {
          ...currentShiftData,
          ...updates,
          id: shiftId
        } as any as TMSShift;
      });

      if (finalShiftState) {
        if ((window as any)._tempTakeBreakLiveSessionData) {
          writeLiveSession(user.uid, (window as any)._tempTakeBreakLiveSessionData).catch(err => console.warn('rtdb write fail:', err));
          delete (window as any)._tempTakeBreakLiveSessionData;
        }
        setLocalOwnShift(finalShiftState);
        setCurrentShift(finalShiftState);
        setSelectedBreakInput(breakType);

        // Cache Invalidation & Session syncing
        localStorage.setItem('tms_last_active_shift_id', shiftId);
        localStorage.setItem('tms_last_active_shift_json', JSON.stringify(finalShiftState));

        invalidateShiftCache({
          userId: user.uid,
          shiftId: shiftId,
          reason: 'agent_take_break'
        });
        console.log(`[BREAK STATE CHANGE] uid=${user.uid} reason=${breakType} source=TMSView.handleTakeBreak status=BREAK`);
        logTmsEvent('BREAK_START', {
          userId: user.uid,
          shiftId: shiftId,
          timestamp: nowISO,
          reason: `Started break: ${breakType}`,
          sourceFunction: 'TMSView.handleTakeBreak',
          details: { breakType: breakType }
        });
        toast.success(`You are now on break: ${breakType}`);
      }
    } catch (e: any) {
      console.error('Break start failed:', e);
      toast.error('Failed to start break on server: ' + e.message);
      setLocalOwnShift(previousShift ? previousShift : undefined);
      setCurrentShift(previousShift);
    } finally {
      setIsProcessingPunch(false);
    }
  };

  const handleResumeWork = async (resumeProcess: string) => {
    if (isProcessingPunch) return;
    if (!currentShift) return;
    if (currentShift.status !== 'BREAK') {
      toast.error('You are already working.');
      return;
    }
    if (!resumeProcess) {
      toast.error('Please select a process to resume working on.');
      return;
    }

    // Find the break activity we are currently on to see which resume permission we need
    const lastActivity = currentShift.activities[currentShift.activities.length - 1];
    const breakName = lastActivity ? (lastActivity.name || '') : '';
    const isLunch = breakName.toLowerCase().includes('lunch');
    const isMeeting = breakName.toLowerCase().includes('meeting') || breakName.toLowerCase().includes('coaching') || breakName.toLowerCase().includes('training');

    if (isLunch) {
      if (!hasTmsPermission('can_end_lunch')) {
        toast.error('Access Denied: You do not have permission to End Lunch.');
        return;
      }
    } else if (isMeeting) {
      if (!hasTmsPermission('can_end_meeting')) {
        toast.error('Access Denied: You do not have permission to End Meetings/Trainings.');
        return;
      }
    } else {
      if (!hasTmsPermission('can_end_break')) {
        toast.error('Access Denied: You do not have permission to End Breaks.');
        return;
      }
    }

    setIsProcessingPunch(true);
    const previousShift = currentShift;

    try {
      const nowISO = getLiveTimeISO();
      const currentDev = getDeviceType();
      const meta = getDetailedDeviceMetadata();
      const shiftId = currentShift.id;
      const shiftRef = doc(db, 'tmsShifts', shiftId);
      const lsRef = doc(db, 'live_sessions', user.uid);

      let finalShiftState: TMSShift | null = null;

      await runTransaction(db, async (transaction) => {
        const shiftSnap = await transaction.get(shiftRef);
        const lsSnap = await transaction.get(lsRef);
        if (!shiftSnap.exists()) throw new Error("Shift document not found on server.");

        const currentShiftData = shiftSnap.data();
        const completedStatuses = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'];
        if (completedStatuses.includes(currentShiftData.status)) {
          throw new Error("Shift is already completed on the server.");
        }

        const currentActivities = [...(currentShiftData.activities || [])];
        
        // Terminate open break activity in activities
        for (let i = currentActivities.length - 1; i >= 0; i--) {
          if (currentActivities[i].action === 'BREAK_START' && !currentActivities[i].endTime) {
            currentActivities[i] = {
              ...currentActivities[i],
              endTime: nowISO
            };
            break;
          }
        }

        // Add new active segment (BREAK_END)
        const endActivity = {
          activityId: crypto.randomUUID(),
          action: 'BREAK_END',
          startTime: nowISO,
          process: resumeProcess || 'Active Work',
          actor: user?.email || user?.uid || 'Employee',
          sourceService: 'TMS_UI',
          type: 'productive',
          name: resumeProcess || 'Active Work',
          device: currentDev
        };
        currentActivities.push(endActivity);

        const updatedLedger = appendShiftEvent(
          currentShiftData.shiftEventLedger || [],
          { ...currentShiftData, id: shiftId },
          {
            eventType: 'BREAK_END',
            timestamp: nowISO,
            performedBy: user.name || 'Employee',
            source: 'TMS',
            reason: `Resumed work from break ${breakName} on process ${resumeProcess}`,
            oldValue: breakName,
            newValue: resumeProcess,
            metadata: { previousBreak: breakName, resumeProcess }
          }
        );

        const updates = {
          status: 'ACTIVE',
          lastHeartbeat: nowISO,
          activities: currentActivities,
          shiftEventLedger: updatedLedger,
          hasMobilePunches: currentShiftData.hasMobilePunches || currentDev === 'mobile',
          breakStartTime: null,
          deviceType: meta.deviceType,
          browser: meta.browser,
          os: meta.os,
          detectedDeviceType: meta.deviceType,
          detectedBrowser: meta.browser,
          detectedOS: meta.os,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : (currentShiftData.userAgent || ''),
          platform: typeof navigator !== 'undefined' ? navigator.platform : (currentShiftData.platform || ''),
          maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : (currentShiftData.maxTouchPoints || 0)
        };

        transaction.set(shiftRef, cleanUndefined(updates), { merge: true });

        const liveSessionData = {
          sessionId: shiftId,
          userId: user.uid,
          uid: user.uid,
          employeeId: user.uid,
          employeeName: user.name || '',
          email: user.email || '',
          userEmail: user.email || '',
          process: resumeProcess,
          teamLead: user?.teamLeadId || user?.teamLeadUid || '',
          tlId: user?.teamLeadId || user?.teamLeadUid || '',
          manager: user?.mappedManagerId || user?.managerId || '',
          managerId: user?.mappedManagerId || user?.managerId || '',
          isOnline: true,
          status: 'ACTIVE',
          currentActivity: resumeProcess,
          clockInTime: currentShiftData.clockInTime,
          statusStartTime: nowISO,
          currentActivityStartTime: nowISO,
          lastHeartbeat: nowISO,
          activities: currentActivities,
          breakStartTime: null,
          workLocation: currentShiftData.workLocation || '',
          workLocationDetected: currentShiftData.workLocationDetected || '',
          workLocationSource: currentShiftData.workLocationSource || ''
        };

        transaction.set(lsRef, cleanUndefined(liveSessionData), { merge: true });

        // Expose to outer scope for RTDB synchronization
        (window as any)._tempResumeLiveSessionData = liveSessionData;

        finalShiftState = {
          ...currentShiftData,
          ...updates,
          id: shiftId
        } as any as TMSShift;
      });

      if (finalShiftState) {
        if ((window as any)._tempResumeLiveSessionData) {
          writeLiveSession(user.uid, (window as any)._tempResumeLiveSessionData).catch(err => console.warn('rtdb write fail:', err));
          delete (window as any)._tempResumeLiveSessionData;
        }
        setLocalOwnShift(finalShiftState);
        setCurrentShift(finalShiftState);
        setSelectedProcessInput(resumeProcess);
        updateRecent(resumeProcess);

        // Cache Invalidation & Session syncing
        localStorage.setItem('tms_last_active_shift_id', shiftId);
        localStorage.setItem('tms_last_active_shift_json', JSON.stringify(finalShiftState));

        invalidateShiftCache({
          userId: user.uid,
          shiftId: shiftId,
          reason: 'agent_resume_work'
        });
        console.log(`[BREAK STATE CHANGE] uid=${user.uid} reason=Resumed on ${resumeProcess} source=TMSView.handleResumeWork status=ACTIVE`);
        logTmsEvent('BREAK_END', {
          userId: user.uid,
          shiftId: shiftId,
          timestamp: nowISO,
          reason: `Resumed work on process: ${resumeProcess}`,
          sourceFunction: 'TMSView.handleResumeWork',
          details: { process: resumeProcess || 'Active Work' }
        });
        toast.success(`Resumed work on process: ${resumeProcess}`);
      }
    } catch (e: any) {
      console.error('Resume failed:', e);
      toast.error('Failed to resume on server: ' + e.message);
      setLocalOwnShift(previousShift ? previousShift : undefined);
      setCurrentShift(previousShift);
    } finally {
      setIsProcessingPunch(false);
    }
  };

  const handleClockOut = () => {
    if (!hasTmsPermission('can_punch_out')) {
      toast.error('Access Denied: You do not have permission to Clock Out.');
      return;
    }
    if (!currentShift) return;
    setShowClockOutConfirm(true);
  };

  const performClockOut = async () => {
    if (isProcessingPunch) return;
    if (!currentShift) return;
    setIsProcessingPunch(true);
    const previousShift = currentShift;
    
    try {
      const nowISO = getLiveTimeISO();
      const currentDev = getDeviceType();
      const userIdentifier = user?.email || user?.uid || 'Unknown' || user.uid;

      // 1. Optimistic Update (Clear UI immediately)
      setLocalOwnShift(null);
      setCurrentShift(null);
      setShowClockOutConfirm(false);
      localStorage.removeItem('tms_last_active_shift_id');
      localStorage.removeItem('tms_last_active_shift_json');

      // 2. Query any open active/break shifts for this user *before* starting the transaction
      let duplicateOpenShiftRefs: any[] = [];
      try {
        const qOpen = query(
          collection(db, 'tmsShifts'),
          where('userId', '==', user.uid),
          where('status', 'in', ['ACTIVE', 'BREAK']),
          limit(5)
        );
        const openSnap = await getDocs(qOpen);
        duplicateOpenShiftRefs = openSnap.docs.filter(d => {
          const s = d.data().status;
          return (s === 'ACTIVE' || s === 'BREAK') && d.id !== currentShift.id;
        });
      } catch (err) {
        console.warn('Error fetching duplicate active shifts prior to clock-out:', err);
      }

      // 3. Perform database writes with transactional integrity
      let lastProc: string | undefined = undefined;

      await runTransaction(db, async (transaction) => {
        const shiftDocRef = doc(db, 'tmsShifts', currentShift.id);
        const shiftSnap = await transaction.get(shiftDocRef);

        if (!shiftSnap.exists()) {
          throw new Error("SHIFT_NOT_FOUND");
        }

        const serverShift = { id: shiftSnap.id, ...shiftSnap.data() } as any;

        // Verify status has not already become terminal on server
        if (serverShift.status !== 'ACTIVE' && serverShift.status !== 'BREAK') {
          throw new Error("SHIFT_ALREADY_TERMINAL");
        }

        // --- READS FIRST ---
        // Fetch any duplicates inside transaction to ensure atomic consistency
        const duplicateSnaps: any[] = [];
        for (const dupDoc of duplicateOpenShiftRefs) {
          const dupSnap = await transaction.get(dupDoc.ref);
          if (dupSnap.exists()) {
            duplicateSnaps.push(dupSnap);
          }
        }

        // --- WRITES AFTER ---
        const updatedActivities = [...(serverShift.activities || [])];
        const lastProd = [...updatedActivities].reverse().find(a => a.type === 'productive');
        lastProc = lastProd ? lastProd.name : selectedProcessInput;

        const updatedLedger = appendShiftEvent(
          serverShift.shiftEventLedger || [],
          serverShift,
          {
            eventType: 'CLOCK_OUT',
            timestamp: nowISO,
            performedBy: user.name || 'Employee',
            source: 'TMS',
            reason: 'Manual clock out by user with transaction safety',
            oldValue: serverShift.status,
            newValue: 'COMPLETED',
            remarks: serverShift.remarks || 'Manual clock out by user'
          }
        );

        const finalizedShift = {
          ...createLockedCompletedShift(
            serverShift,
            nowISO,
            userIdentifier,
            serverShift.remarks || 'Manual clock out by user',
            currentDev,
            'COMPLETED',
            presentThreshold
          ),
          shiftEventLedger: updatedLedger
        };

        if (serverShift.hasMobilePunches || currentDev === 'mobile') {
          finalizedShift.hasMobilePunches = true;
        }

        // Write finalized main shift inside transaction
        transaction.set(shiftDocRef, cleanUndefined(finalizedShift));

        // Process duplicate open shifts using the pre-fetched snapshots
        for (const dupSnap of duplicateSnaps) {
          const dupData = dupSnap.data() as any;
          if (dupData.status === 'ACTIVE' || dupData.status === 'BREAK') {
            const dupLedger = appendShiftEvent(
              dupData.shiftEventLedger || [],
              dupData,
              {
                eventType: 'CLOCK_OUT',
                timestamp: nowISO,
                performedBy: user.name || 'Employee',
                source: 'TMS',
                reason: 'Manual clock out by user (duplicate transactional cleanup)',
                oldValue: dupData.status || 'ACTIVE',
                newValue: 'COMPLETED',
                remarks: 'Auto-resolved duplicate open shift during transaction clock-out'
              }
            );
            const closedDuplicate = {
              ...createLockedCompletedShift(
                { id: dupSnap.id, ...dupData },
                nowISO,
                userIdentifier,
                dupData.remarks || 'Manual clock out by user (duplicate cleanup)',
                currentDev,
                'COMPLETED',
                presentThreshold
              ),
              shiftEventLedger: dupLedger
            };
            transaction.set(dupSnap.ref, cleanUndefined(closedDuplicate), { merge: true });
          }
        }

        // Set user metadata on logout (preserve administrative status and lastLogoutAt)
        const userRef = doc(db, 'users', user.uid);
        transaction.set(userRef, cleanUndefined({
          lastLogoutAt: nowISO
        }), { merge: true });

        // Delete live_session
        transaction.delete(doc(db, 'live_sessions', user.uid));

        // Release Active Lock
        const lockRef = doc(db, 'tmsActiveLocks', user.uid);
        transaction.set(lockRef, cleanUndefined({
          status: 'INACTIVE',
          shiftId: null,
          updatedAt: serverTimestamp()
        }), { merge: true });
      });

      if (lastProc) {
        setSelectedProcessInput(lastProc);
        safeStorage.set(`tms_last_used_process_${user.uid}`, lastProc);
      }

      invalidateShiftCache({
        userId: user.uid,
        shiftId: currentShift.id,
        teamLeadUid: (currentShift as any).teamLeadUid,
        managerId: (currentShift as any).managerId,
        reason: 'agent_clock_out'
      });
      logTmsEvent('CLOCK_OUT', {
        userId: user.uid,
        shiftId: currentShift.id,
        timestamp: nowISO,
        reason: 'Manual clock out by user with transaction safety',
        sourceFunction: 'TMSView.performClockOut',
        details: { clockOutDevice: currentDev }
      });
      toast.success('Clocked Out successfully. Shift recorded.');
    } catch (e: any) {
      if (e.message === "SHIFT_ALREADY_TERMINAL") {
        toast.warning('Your session has already been closed. Syncing...');
        invalidateShiftCache({
          userId: user.uid,
          shiftId: currentShift?.id,
          reason: 'agent_clock_out_terminal_sync'
        });
      } else {
        console.error('Clock-out transaction failed:', e);
        toast.error('Failed to clock out on server: ' + e.message);
        // Revert optimistic update on unrecoverable errors
        setLocalOwnShift(previousShift);
        setCurrentShift(previousShift);
      }
    } finally {
      setIsProcessingPunch(false);
    }
  };

  // Math: Calculate utilization metrics for a given shift
  const getWorkDateString = (date: Date | string) => {
    const d = new Date(date);
    // Logical offset: shifts starting between 00:00 and 04:00 belong to previous day
    const logicalDate = new Date(d.getTime() - 4 * 60 * 60 * 1000);
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(logicalDate);
  };

  const computeShiftStats = (shift: TMSShift) => {
    return calculateShiftMetrics(shift, now.getTime());
  };

  // Admin Process configuration handlers:
  const handleAddProcess = async () => {
    if (!newProcessName.trim()) {
      toast.error('Process name cannot be empty.');
      return;
    }

    if (processes.includes(newProcessName.trim())) {
      toast.error('This process already exists.');
      return;
    }

    setProcessing(true);
    try {
      const updatedList = [...processes, newProcessName.trim()];
      await saveProcessesList(updatedList);
      
      // Audit log process creation
      const logId = `log-process-${Date.now()}`;
      await setDoc(doc(db, 'uploadAuditLogs', logId), {
        id: logId,
        targetId: 'tmsProcesses',
        entityType: 'process',
        fieldName: 'list',
        oldValue: JSON.stringify(processes),
        newValue: JSON.stringify(updatedList),
        updatedBy: user.uid,
        updatedByName: user?.name || user?.fullName || 'User',
        updatedAt: getLiveTimeISO(),
        action: 'create_process',
        details: `Process "${newProcessName.trim()}" created.`
      });
      console.log(`[PROCESS CREATION] Process "${newProcessName.trim()}" successfully created by User ${user.name} (${user?.email || user?.uid || 'Unknown'}) at ${getLiveTimeISO()}`);

      setNewProcessName('');
      toast.success('New process added to console.');
    } catch (e) {
      console.error(`[PROCESS CREATION FAILURE] Error code: `, e);
      handleFirestoreError(e, OperationType.WRITE, 'config/tmsProcesses');
    } finally {
      setProcessing(false);
    }
  };

  const handleDeleteProcess = (procToDelete: string) => {
    setConfirmDeleteProcessName(procToDelete);
  };

  const performDeleteProcess = async (procToDelete: string) => {
    try {
      const updatedList = processes.filter(p => p !== procToDelete);
      await saveProcessesList(updatedList);
      setProcesses(updatedList);

      // Audit log process deletion
      const logId = `log-process-${Date.now()}`;
      await setDoc(doc(db, 'uploadAuditLogs', logId), {
        id: logId,
        targetId: 'tmsProcesses',
        entityType: 'process',
        fieldName: 'list',
        oldValue: JSON.stringify(processes),
        newValue: JSON.stringify(updatedList),
        updatedBy: user.uid,
        updatedByName: user?.name || user?.fullName || 'User',
        updatedAt: getLiveTimeISO(),
        action: 'delete_process',
        details: `Process "${procToDelete}" deleted.`
      });
      console.log(`[PROCESS DELETION] Process "${procToDelete}" successfully deleted by User ${user.name} (${user?.email || user?.uid || 'Unknown'}) at ${getLiveTimeISO()}`);

      toast.success('Process deleted successfully.');
    } catch (e) {
      console.error(`[PROCESS DELETION FAILURE] Error code: `, e);
      handleFirestoreError(e, OperationType.WRITE, 'config/tmsProcesses');
    }
  };

  const handleSaveEditProcess = async (oldName: string) => {
    const trimmed = editingProcessValue.trim();
    if (!trimmed) {
      toast.error('Process name cannot be blank.');
      return;
    }
    if (processes.includes(trimmed) && trimmed !== oldName) {
      toast.error('A process with this name already exists.');
      return;
    }

    try {
      const updatedList = processes.map(p => p === oldName ? trimmed : p);
      await saveProcessesList(updatedList);
      setProcesses(updatedList);
      setEditingProcessName(null);
      setEditingProcessValue('');

      // Audit log process update
      const logId = `log-process-${Date.now()}`;
      await setDoc(doc(db, 'uploadAuditLogs', logId), {
        id: logId,
        targetId: 'tmsProcesses',
        entityType: 'process',
        fieldName: 'list',
        oldValue: JSON.stringify(processes),
        newValue: JSON.stringify(updatedList),
        updatedBy: user.uid,
        updatedByName: user?.name || user?.fullName || 'User',
        updatedAt: getLiveTimeISO(),
        action: 'edit_process',
        details: `Process updated from "${oldName}" to "${trimmed}".`
      });
      console.log(`[PROCESS UPDATE] Process successfully changed from "${oldName}" to "${trimmed}" by User ${user.name} (${user?.email || user?.uid || 'Unknown'})`);

      toast.success(`Successfully updated process name to "${trimmed}".`);
    } catch (e) {
      console.error('[TMS SAVE EDIT PROCESS ERROR]', e);
      toast.error('Failed to update process name.');
    }
  };

  const { deviceType, browser, os } = getDetailedDeviceMetadata();
  const isMobileOrTablet = deviceType !== 'Desktop';

  if (desktopOnlyMode && isMobileOrTablet && !adminBypass) {
    const isAdmin = normRoleUser.includes('ADMIN');
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] p-8 text-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-xl max-w-2xl mx-auto my-12 space-y-6">
        <div className="w-20 h-20 rounded-full bg-rose-100 dark:bg-rose-950 flex items-center justify-center text-rose-600 dark:text-rose-450 animate-bounce">
          <MonitorOff size={40} />
        </div>
        <h2 className="text-2xl font-black text-rose-650 tracking-tight dark:text-rose-400">
          Device Restricted
        </h2>
        <p className="text-slate-650 dark:text-slate-300 font-extrabold leading-relaxed text-sm">
          TMS is supported only on Desktop/Laptop devices.
        </p>
        
        <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-150 dark:border-slate-800/60 w-full text-left space-y-2 max-w-sm font-semibold">
          <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400 font-mono">YOUR DEVICE METADATA</div>
          <div className="text-xs text-slate-700 dark:text-slate-300 flex justify-between">
            <span>Detected Type:</span>
            <span className="font-bold text-rose-500">{deviceType}</span>
          </div>
          <div className="text-xs text-slate-700 dark:text-slate-300 flex justify-between">
            <span>Browser:</span>
            <span>{browser}</span>
          </div>
          <div className="text-xs text-slate-700 dark:text-slate-350 flex justify-between">
            <span>OS:</span>
            <span>{os}</span>
          </div>
        </div>

        <p className="text-[10px] text-slate-400 font-medium">
          If you are on a desktop browser, please maximize your window or disable device emulation.
        </p>
        
        {isAdmin && (
          <div className="pt-2">
            <Button 
              onClick={() => {
                toast.success('Admin Device Restricted Override active for this session.');
                setAdminBypass(true);
              }}
              className="bg-indigo-650 hover:bg-indigo-755 text-white font-bold text-xs px-4 py-2 rounded-xl"
            >
              Force Access (Admin Overrule)
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (isDashboardUser && currentSubView !== 'tms-agent') {
    return (
      <SupervisorDashboard 
        user={user} 
        allUsers={filteredUsers} 
        onRefreshAllData={fetchAllShifts}
        externalTheme={externalTheme}
        processes={allAvailableProcesses}
        currentSubView={currentSubView}
        onNavigateSubView={onNavigateSubView}
        currentShift={currentShift}
        myPastShifts={myPastShifts}
        recentProcesses={recentProcesses}
        favoriteProcesses={favoriteProcesses}
        toggleFavorite={toggleFavorite}
        handleClockIn={handleClockIn}
        handleClockOut={handleClockOut}
        handleTakeBreak={handleTakeBreak}
        handleResumeWork={handleResumeWork}
        handleSwitchProcess={handleSwitchProcess}
        handleExtendShift={handleExtendShift}
        handleManualLocationOverride={handleManualLocationOverride}
        isProcessingPunch={isProcessingPunch}
      />
    );
  }

  function ___ignored_old_supervisor_logic___() {
    let mappedUsers: any[] = [];
    
    // Use canActOn to filter who we can see in our report, excluding inactive users
    mappedUsers = allUsers.filter(u => u.uid !== user.uid && (!u.status || u.status.toLowerCase().trim() === 'active' || u.isActive === true) && canActOn(user, u, allUsers));

    console.log('--- TMS Dashboard Mapping Debug ---');
    console.log('Can View Reports:', canViewReports);
    console.log('Mapped Users Found:', mappedUsers.map(u => ({ email: u.email, role: u.role })));
    console.log('Query Results Count:', mappedUsers.length);
    console.log('-----------------------------------');

    // Single Source of Truth: Active Shifts
    // A shift is active/logged in if it is not COMPLETED
    const activeShiftsList = allShifts.filter(sh => {
        const isMappedUser = mappedUsers.some(mu => mu.uid === sh.userId);
        const isSessionRunning = sh.status !== 'COMPLETED';
        
        // Define stale: ACTIVE/BREAK but clockInTime > 24 hours ago
        const isStale = isSessionRunning && (getLiveTime().getTime() - new Date(sh.clockInTime).getTime() > 24 * 60 * 60 * 1000);
        
        if (isMappedUser && isSessionRunning && !isStale) {
           return true; 
        }
        
        // Trigger background cleanup for stale sessions
        if (isMappedUser && isStale) {
            // Note: In real production, this would be a cloud function.
            // For now, we perform local cleanup or just exclude from count
            console.log(`[TMS ALERT] Found stale shift for ${sh.userName}: ${sh.id}`);
            // autoCloseSession(sh.id); // Potential future implementation
        }
        return false;
    });
    
    const currentActiveCount = activeShiftsList.length;

    let totalActiveMs = 0;
    let totalShiftMs = 0;
    const mappedShifts = allShifts.filter(sh => mappedUsers.some(mu => mu.uid === sh.userId));
    mappedShifts.forEach(sh => {
      const stats = computeShiftStats(sh);
      totalActiveMs += stats.activeMs;
      totalShiftMs += stats.totalShiftMs;
    });
    const teamAvgUtilization = totalShiftMs > 0 
      ? Number(((totalActiveMs / totalShiftMs) * 100).toFixed(1)) 
      : 100;

    const handleExportCSV = () => {
      setExportType('team');
      setSelectedRangePreset('last30');
      setStartDateStr('');
      setEndDateStr('');
      setExportFormat('excel');
      setReportType('both');
      setShowExportModal(true);
    };

    const executeTeamExport = async (
      start: Date, 
      end: Date, 
      format: 'csv' | 'excel', 
      fetchedShifts: TMSShift[],
      selectedReportType: 'summary' | 'chronological' | 'both' = 'both'
    ) => {
      if (mappedUsers.length === 0) {
        toast.error("No mapped agents to export");
        return;
      }

      const isTodayOnly = start.toDateString() === end.toDateString() && start.toDateString() === getLiveTime().toDateString();
      const includeSummary = selectedReportType === 'summary' || selectedReportType === 'both';
      const includeChrono = selectedReportType === 'chronological' || selectedReportType === 'both';

      const summaryHeaders = [
        'Emp ID',
        'Agent Name',
        'Agent Email',
        'Team Lead',
        'Manager',
        'Role',
        isTodayOnly ? 'Live Status' : 'Period Status',
        'Process/Break',
        'Shift Count in Period',
        'Period Start (First Clock In)',
        'Period End (Last Clock Out)',
        'Total Shift Time (Min)',
        'Total Productive Time (Min)',
        'Total Break Time (Min)',
        'Range Utilization (%)'
      ];

      // O(1) User maps for fast lookups
      const usersByIdMap = new Map<string, any>();
      const usersByEmailMap = new Map<string, any>();
      allUsers.forEach(u => {
        if (u.uid) usersByIdMap.set(u.uid, u);
        if (u.email) usersByEmailMap.set(u.email.toLowerCase().trim(), u);
      });

      // Authoritative in-memory hierarchy precomputation
      const authoritativeUsersList: UserProfile[] = allUsers || [];
      const lookupMaps = buildAuthoritativeLookupMaps(authoritativeUsersList);
      const hierarchyCache = new Map<string, { teamLead: string; manager: string }>();

      for (const u of authoritativeUsersList) {
        if (u.uid) {
          const h = resolveAuthoritativeHierarchy(u, authoritativeUsersList, lookupMaps);
          hierarchyCache.set(u.uid, { teamLead: h.teamLead, manager: h.manager });
          if (u.email) {
            hierarchyCache.set(u.email.toLowerCase().trim(), { teamLead: h.teamLead, manager: h.manager });
          }
        }
      }

      const getHierarchyForUser = (userId?: string, userEmail?: string, uProf?: UserProfile) => {
        if (userId && hierarchyCache.has(userId)) return hierarchyCache.get(userId)!;
        if (userEmail && hierarchyCache.has(userEmail.toLowerCase().trim())) return hierarchyCache.get(userEmail.toLowerCase().trim())!;
        if (uProf && uProf.uid && hierarchyCache.has(uProf.uid)) return hierarchyCache.get(uProf.uid)!;
        const res = resolveAuthoritativeHierarchy(uProf, authoritativeUsersList, lookupMaps);
        if (userId) hierarchyCache.set(userId, { teamLead: res.teamLead, manager: res.manager });
        if (userEmail) hierarchyCache.set(userEmail.toLowerCase().trim(), { teamLead: res.teamLead, manager: res.manager });
        return res;
      };

      // Filter fetchedShifts strictly by range and user mapping
      const teamUserIds = mappedUsers.map(u => u.uid);
      
      const requestedStartDateStr = start.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const requestedEndDateStr = end.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

      const teamRangeShifts = fetchedShifts.filter(sh => {
        const workDate = getWorkDateString(sh.clockInTime);
        const isInRange = workDate >= requestedStartDateStr && workDate <= requestedEndDateStr;
        return isInRange && teamUserIds.includes(sh.userId);
      });

      // Pre-group all fetched shifts by userId to avoid inner loop filters
      const shiftsByUserId: Record<string, TMSShift[]> = {};
      fetchedShifts.forEach(sh => {
        if (sh.userId) {
          if (!shiftsByUserId[sh.userId]) {
            shiftsByUserId[sh.userId] = [];
          }
          shiftsByUserId[sh.userId].push(sh);
        }
      });

      const summaryRows = includeSummary ? mappedUsers.map(u => {
        const userShifts = shiftsByUserId[u.uid] || [];
        const activeShift = userShifts.find(sh => sh.status === 'ACTIVE' || sh.status === 'BREAK');
        
        const rangeShifts = userShifts.filter(sh => {
          const workDate = getWorkDateString(sh.clockInTime);
          return workDate >= requestedStartDateStr && workDate <= requestedEndDateStr;
        });

        let currentStatus = 'Offline';
        let currentProcess = 'None';
        
        if (activeShift) {
          currentStatus = activeShift.status === 'BREAK' ? 'On Break' : 'Active Work';
          const lastAct = activeShift.activities[activeShift.activities.length - 1];
          currentProcess = lastAct ? lastAct.name : 'N/A';
        } else if (rangeShifts.length > 0) {
          currentStatus = 'Completed';
          const lastS = rangeShifts[rangeShifts.length - 1];
          const lastAct = lastS.activities[lastS.activities.length - 1];
          currentProcess = lastAct ? lastAct.name : 'N/A';
        }

        const sortedRangeShifts = [...rangeShifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());
        const firstShift = sortedRangeShifts[0];
        const lastShift = sortedRangeShifts[sortedRangeShifts.length - 1];

        const clockInTime = firstShift ? new Date(firstShift.clockInTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : 'N/A';
        const clockOutTime = lastShift ? (lastShift.clockOutTime ? new Date(lastShift.clockOutTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : 'Ongoing') : 'N/A';

        let totalShiftMins = 0;
        let totalProductiveMins = 0;
        let totalBreakMins = 0;
        let overallUtil = 0;

        let totalShiftMsSum = 0;
        let totalActiveMsSum = 0;

        rangeShifts.forEach(sh => {
          const stats = computeShiftStats(sh);
          totalShiftMsSum += stats.totalShiftMs;
          totalActiveMsSum += stats.activeMs;
          totalShiftMins += stats.totalShiftMs / (60 * 1000);
          totalProductiveMins += stats.activeMs / (60 * 1000);
          totalBreakMins += stats.breakMs / (60 * 1000);
        });

        if (totalShiftMsSum > 0) {
          overallUtil = Number(((totalActiveMsSum / totalShiftMsSum) * 100).toFixed(1));
        }

        const uHier = getHierarchyForUser(u.uid, u.email, u);
        const teamLead = uHier.teamLead || 'Unassigned';
        const manager = uHier.manager || 'Unassigned';

        return [
          u.employeeId || 'N/A',
          u.name,
          u.email,
          teamLead,
          manager,
          u.role,
          currentStatus,
          currentProcess,
          rangeShifts.length,
          clockInTime,
          clockOutTime,
          totalShiftMins.toFixed(1),
          totalProductiveMins.toFixed(1),
          totalBreakMins.toFixed(1),
          rangeShifts.length > 0 ? (overallUtil + '%') : '0%'
        ];
      }) : [];

      const chronoHeaders = [
        'Emp ID',
        'Agent Name',
        'Agent Email',
        'Team Lead',
        'Manager',
        'Date (IST)',
        'Action Sequence',
        'Duration Type',
        'Specific Activity / Break Type',
        'Start Time (IST)',
        'End Time (IST)',
        'Duration (Mins)'
      ];

      const buildChronoRows = (shifts: TMSShift[]) => {
        const chronoRows: any[] = [];
        const sortedShifts = [...shifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());

        sortedShifts.forEach(sh => {
          const workDate = getWorkDateString(sh.clockInTime);
          let uProfile = sh.userId ? usersByIdMap.get(sh.userId) : undefined;
          if (!uProfile && sh.userEmail) {
            uProfile = usersByEmailMap.get(sh.userEmail.toLowerCase().trim());
          }
          const empId = uProfile?.employeeId || 'N/A';
          const uHier = getHierarchyForUser(sh.userId, sh.userEmail, uProfile);
          const teamLead = uHier.teamLead || 'Unassigned';
          const manager = uHier.manager || 'Unassigned';
          
          const reconstructed = buildTimelineFromActivityLedger(sh.activities || [], sh.status || 'ACTIVE', sh.clockOutTime, getLiveTime().getTime());
          reconstructed.forEach((act, idx) => {
            const startTimeIST = new Date(act.startTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
            const endTimeIST = act.isLive 
              ? 'Ongoing'
              : new Date(act.endTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
            
            const durationMs = new Date(act.endTime).getTime() - new Date(act.startTime).getTime();
            const durationMin = durationMs / (1000 * 60);

            chronoRows.push([
              empId,
              sh.userName || 'N/A',
              sh.userEmail || 'N/A',
              teamLead,
              manager,
              workDate,
              idx + 1,
              act.type === 'productive' ? 'Productive Work' : 'Break',
              act.name || 'N/A',
              startTimeIST,
              endTimeIST,
              durationMin.toFixed(1)
            ]);
          });
        });
        return chronoRows;
      };

      const chronoRows = includeChrono ? buildChronoRows(teamRangeShifts) : [];

      const ledgerHeaders = [
        'Employee', 'User Email', 'Team Lead', 'Manager', 'Shift Date', 'Event Sequence', 'Event Time',
        'Event Type', 'Old Value', 'New Value', 'Reason', 'Source',
        'Performed By', 'Confidence', 'Remarks'
      ];

      const buildLedgerRows = (shifts: TMSShift[]) => {
        const rows: any[] = [];
        shifts.forEach(sh => {
          let uProfile = sh.userId ? usersByIdMap.get(sh.userId) : undefined;
          if (!uProfile && sh.userEmail) {
            uProfile = usersByEmailMap.get(sh.userEmail.toLowerCase().trim());
          }
          const uHier = getHierarchyForUser(sh.userId, sh.userEmail, uProfile);
          const teamLead = uHier.teamLead || 'Unassigned';
          const manager = uHier.manager || 'Unassigned';

          const reportRows = formatShiftLedgerForReport(sh);
          reportRows.forEach(r => {
            rows.push([
              r['Employee'],
              r['User Email'],
              teamLead,
              manager,
              r['Shift Date'],
              r['Event Sequence'],
              r['Event Time'],
              r['Event Type'],
              r['Old Value'],
              r['New Value'],
              r['Reason'],
              r['Source'],
              r['Performed By'],
              r['Confidence'],
              r['Remarks']
            ]);
          });
        });
        return rows;
      };

      const ledgerRows = includeChrono ? buildLedgerRows(teamRangeShifts) : [];

      // Attendance logic sheet
      const attendanceHeaders = ['Emp ID', 'Agent Name', 'Agent Email', 'Team Lead', 'Manager', 'Process', 'Date', 'Productive Mins', 'Status'];
      const buildAttendanceRows = (shifts: TMSShift[]) => {
        const mergedRecords = aggregateShiftsForHistoryAndReports(shifts, now.getTime());
        return mergedRecords.map(m => {
          let uP = m.userId ? usersByIdMap.get(m.userId) : undefined;
          if (!uP && m.userEmail) {
            uP = usersByEmailMap.get(m.userEmail.toLowerCase().trim());
          }
          const empId = uP?.employeeId || 'N/A';
          const uHier = getHierarchyForUser(m.userId, m.userEmail, uP);
          const teamLead = uHier.teamLead || 'Unassigned';
          const manager = uHier.manager || 'Unassigned';

          const proc = m.process || uP?.process || 'N/A';
          const productiveMins = m.productiveMs / 60000;
          let status = 'Absent';
          if (productiveMins > 480) status = 'Present';
          else if (productiveMins >= 240) status = 'Half Day';
          return [empId, m.userName, m.userEmail, teamLead, manager, proc, m.attendanceDate, productiveMins.toFixed(1), status];
        });
      };
      const attendanceRows = buildAttendanceRows(teamRangeShifts);

      console.log(`[REPORT EXPORT] Team Lead report exported by ${user.name} (${user?.email || user?.uid || 'Unknown'}). Date range: ${start.toISOString()} to ${end.toISOString()} in format: ${format}, reportType: ${selectedReportType}`);

      if (format === 'excel') {
        const workbook = XLSX.utils.book_new();

        if (selectedReportType === 'both') {
          const wsMain = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
          wsMain['!cols'] = summaryHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsMain, "Team Utilization");

          const wsChrono = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
          wsChrono['!cols'] = chronoHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsChrono, "Chronological Activity Logs");

          const wsLedger = XLSX.utils.aoa_to_sheet([ledgerHeaders, ...ledgerRows]);
          wsLedger['!cols'] = ledgerHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsLedger, "Immutable Event Ledger");
          
          const wsAttendance = XLSX.utils.aoa_to_sheet([attendanceHeaders, ...attendanceRows]);
          wsAttendance['!cols'] = attendanceHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsAttendance, "Attendance Report");
        } else if (selectedReportType === 'summary') {
          const wsMain = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
          wsMain['!cols'] = summaryHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsMain, "Team Utilization");
          
          const wsAttendance = XLSX.utils.aoa_to_sheet([attendanceHeaders, ...attendanceRows]);
          wsAttendance['!cols'] = attendanceHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsAttendance, "Attendance Report");
        } else if (selectedReportType === 'chronological') {
          const wsChrono = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
          wsChrono['!cols'] = chronoHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsChrono, "Chronological Activity Logs");

          const wsLedger = XLSX.utils.aoa_to_sheet([ledgerHeaders, ...ledgerRows]);
          wsLedger['!cols'] = ledgerHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsLedger, "Immutable Event Ledger");
          
          const wsAttendance = XLSX.utils.aoa_to_sheet([attendanceHeaders, ...attendanceRows]);
          wsAttendance['!cols'] = attendanceHeaders.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(workbook, wsAttendance, "Attendance Report");
        }

        const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        
        const zip = new JSZip();
        let filenameSuffix = "Team_Report";
        if (selectedReportType === 'both') filenameSuffix = "Team_Summary_and_Chronological_Report";
        else if (selectedReportType === 'summary') filenameSuffix = "Team_Summary_Report";
        else if (selectedReportType === 'chronological') filenameSuffix = "Team_Chronological_Activity_Logs";

        const safeUserSuffix = (user.name || user.fullName || 'User').split(' ').join('_');
        const fileName = `TMS_Team_${filenameSuffix}_${safeUserSuffix}`;

        zip.file(`${fileName}.xlsx`, excelBuffer);
        const zipContent = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        
        const url = URL.createObjectURL(zipContent);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `${fileName}.zip`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } else {
        const safeUserSuffix = (user.name || user.fullName || 'User').split(' ').join('_');
        const zip = new JSZip();
        
        if (selectedReportType === 'summary') {
          const csvContent = "\uFEFF" + [summaryHeaders.join(','), ...summaryRows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
          const fileName = `TMS_Team_Summary_Report_${safeUserSuffix}`;
          zip.file(`${fileName}.csv`, csvContent);
          const zipContent = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
          const url = URL.createObjectURL(zipContent);
          const link = document.createElement('a');
          link.setAttribute('href', url);
          link.setAttribute('download', `${fileName}.zip`);
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        } else {
          const csvContent = "\uFEFF" + [chronoHeaders.join(','), ...chronoRows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
          const fileName = `TMS_Team_Chronological_Activity_Logs_${safeUserSuffix}`;
          zip.file(`${fileName}.csv`, csvContent);
          const zipContent = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
          const url = URL.createObjectURL(zipContent);
          const link = document.createElement('a');
          link.setAttribute('href', url);
          link.setAttribute('download', `${fileName}.zip`);
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        }
      }
      toast.success('Utilization Report exported successfully!');
    };

  const handleGenerateExport = async () => {
    if (selectedRangePreset === 'custom' && (!startDateStr || !endDateStr)) {
      toast.error('Please select both start and end dates for custom range.');
      return;
    }

    const abortCtrl = new AbortController();
    setExportAbortController(abortCtrl);
    setIsExporting(true);
    setExportProgressPercent(5);
    setExportProgressMessage('Starting export...');
    try {
      const mappedUsers = allUsers.filter(u => u.uid !== user.uid && (!u.status || u.status.toLowerCase().trim() === 'active' || u.isActive === true) && canActOn(user, u, allUsers));
      const res = await generateAndDownloadOrganizationReport({
        actor: user,
        allUsers: allUsers || [],
        authorizedTeamUids: mappedUsers.map(u => u.uid),
        hasTmsPermission,
        preset: selectedRangePreset,
        startDateStr,
        endDateStr,
        format: exportFormat,
        reportType,
        signal: abortCtrl.signal,
        onProgress: (pct, msg) => {
          setExportProgressPercent(pct);
          setExportProgressMessage(msg);
        }
      });
      if (!res.success) {
        toast.error(res.message || 'No records found for the selected date range.');
      } else {
        toast.success('Report exported successfully!');
        setShowExportModal(false);
      }
    } catch (err: any) {
      console.error('Export generation failed:', err);
      if (err?.message !== 'Export cancelled by user') {
        toast.error('Failed to generate report.');
      }
    } finally {
      setIsExporting(false);
      setExportAbortController(null);
    }
  };

    const finalMappedUsers = mappedUsers.filter((u) => {
      // 1. Filter by search
      const search = (tmsSearch || '').toLowerCase();
      const matchesSearch = !search 
        ? true 
        : ((u.name || '').toLowerCase().includes(search) || (u.email || '').toLowerCase().includes(search));
        
      if (!matchesSearch) return false;

      // 2. Filter by shift status
      const activeShift = allShifts.find(s => 
        s.userEmail?.toLowerCase() === u.email?.toLowerCase() && 
        (s.status === 'ACTIVE' || s.status === 'BREAK')
      );

      // 3. Filter by Tab selection
      if (tmsAdminTab === 'exceeded_12h') {
        if (!activeShift) return false;
        const referenceTime = getLiveTime().getTime();
        const productiveMs = getShiftProductiveMs(activeShift, referenceTime);
        return productiveMs > 12 * 60 * 60 * 1000;
      }

      if (activeShiftFilter === 'all') return true;
      if (activeShiftFilter === 'offline') return !activeShift;
      if (activeShiftFilter === 'active') return !!(activeShift && activeShift.status === 'ACTIVE');
      if (activeShiftFilter === 'break') return !!(activeShift && activeShift.status === 'BREAK');

      return true;
    });

    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 overflow-y-auto h-full pr-1">
        {/* Upper header segment */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm text-slate-800">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-sky-600 flex items-center justify-center text-white shadow-lg shadow-sky-200">
              <Clock size={24} />
            </div>
            <div>
              <h2 className="text-2xl font-black text-slate-900 tracking-tight">{isManagerRole ? 'Manager Dashboard' : 'Team Lead TMS Dashboard'}</h2>
              <p className="text-sm font-medium text-slate-500">Supervise logged-in agents, productivity rates, and export utilization reports</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleExportCSV}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2.5 px-4 rounded-xl flex items-center gap-1.5 shadow-sm shadow-emerald-200 cursor-pointer"
            >
              <FileSpreadsheet size={16} /> Export Team Report
            </Button>

            {/* Current system clock */}
            <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl text-left">
              <Activity className="text-emerald-500 animate-pulse shrink-0" size={16} />
              <div>
                <p className="text-[8px] uppercase font-bold tracking-widest text-slate-400 leading-none">Live Server Time (IST)</p>
                <p className="font-mono text-[11px] font-bold text-slate-800 leading-none mt-1">
                  <LiveHeaderClock />
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Metric summary boxes */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="border border-slate-200 shadow-sm bg-white rounded-2xl">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-extrabold tracking-wider text-slate-400">Total Assigned Team</CardDescription>
              <CardTitle className="text-2xl font-black text-slate-900">{mappedUsers.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-slate-500 font-medium">Mapped Agents & QAs</p>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-sm bg-white rounded-2xl">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-extrabold tracking-wider text-teal-500">Logged In Right Now</CardDescription>
              <CardTitle className="text-2xl font-black text-teal-600">{currentActiveCount}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-slate-500 font-medium">{mappedUsers.length > 0 ? `${((currentActiveCount / mappedUsers.length) * 100).toFixed(0)}%` : '0%'} of total roster active</p>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-sm bg-white rounded-2xl">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-extrabold tracking-wider text-sky-500">Average Team Utilization</CardDescription>
              <CardTitle className="text-2xl font-black text-sky-600">{teamAvgUtilization}%</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-slate-500 font-medium">Target productivity benchmark: 85%</p>
            </CardContent>
          </Card>
        </div>

        {/* Live workforce roster and session status table */}
        <Card className="border border-slate-200 shadow-sm bg-white overflow-hidden rounded-2xl">
          <CardHeader className="border-b border-slate-100 pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <CardTitle className="text-sm font-extrabold text-slate-900 uppercase tracking-widest flex items-center gap-2">
                <User size={16} className="text-sky-500" />
                Roster Session Audit & Real-time Tracking
              </CardTitle>
              <CardDescription className="text-xs">
                Live-monitored metrics for resources under your supervision.
              </CardDescription>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-3 w-full md:w-auto">
              <div className="relative w-full sm:w-44 shrink-0">
                <select
                  value={activeShiftFilter}
                  onChange={(e) => {
                    setActiveShiftFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full bg-slate-50 border border-slate-250 hover:bg-slate-100 rounded-xl px-3 py-2 pr-8 text-xs text-slate-700 font-extrabold focus:outline-none focus:ring-1 focus:ring-sky-550 cursor-pointer appearance-none"
                >
                  <option value="all">🟢 Shift Filter: All</option>
                  <option value="active">🟢 Active Shifts</option>
                  <option value="break">🟠 Break Shifts</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-450">
                  <svg className="fill-current h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
                </div>
              </div>
              <div className="relative w-full md:w-64">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="Search resources..."
                  value={tmsSearch}
                  onChange={(e) => {
                    setTmsSearch(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="pl-9 h-9 text-xs focus-visible:ring-1 focus-visible:ring-sky-500 rounded-xl"
                />
              </div>
            </div>
          </CardHeader>
          
          {/* Dashboard Sub-Tabs */}
          <div className="flex border-b border-slate-100 bg-slate-50/50 px-6">
            <button
              onClick={() => {
                setTmsAdminTab('roster');
                setCurrentPage(1);
              }}
              className={`py-3 px-4 text-[10px] sm:text-xs font-black uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 cursor-pointer ${
                tmsAdminTab === 'roster'
                  ? 'border-sky-500 text-sky-600 font-extrabold'
                  : 'border-transparent text-slate-400 hover:text-slate-600 hover:border-slate-200'
              }`}
            >
              <User size={14} />
              Roster Session Audit
            </button>
            <button
              onClick={() => {
                setTmsAdminTab('exceeded_12h');
                setCurrentPage(1);
              }}
              className={`py-3 px-4 text-[10px] sm:text-xs font-black uppercase tracking-wider border-b-2 transition-colors flex items-center gap-2 relative cursor-pointer ${
                tmsAdminTab === 'exceeded_12h'
                  ? 'border-red-500 text-red-600 font-extrabold'
                  : 'border-transparent text-slate-400 hover:text-slate-600 hover:border-slate-200'
              }`}
            >
              <AlertTriangle size={14} className={tmsAdminTab === 'exceeded_12h' ? 'text-red-500' : 'text-slate-400'} />
              Exceeded 12 Hours Productive
              {(() => {
                const count = mappedUsers.filter((u) => {
                  const activeShift = allShifts.find(s => 
                    s.userEmail?.toLowerCase() === u.email?.toLowerCase() && 
                    (s.status === 'ACTIVE' || s.status === 'BREAK')
                  );
                  if (!activeShift) return false;
                  const referenceTime = getLiveTime().getTime();
                  const productiveMs = getShiftProductiveMs(activeShift, referenceTime);
                  return productiveMs > 12 * 60 * 60 * 1000;
                }).length;
                if (count > 0) {
                  return (
                    <span className="bg-red-100 text-red-700 text-[9px] font-black px-1.5 py-0.5 rounded-full leading-none">
                      {count}
                    </span>
                  );
                }
                return null;
              })()}
            </button>
          </div>

          <CardContent className="p-0">
            <div className="overflow-auto max-h-[600px] border border-slate-100 rounded-lg scrollbar-thin">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 z-10 bg-slate-50 shadow-sm shadow-slate-200/50">
                  <tr className="bg-slate-50 text-slate-500 border-b border-slate-200 font-bold uppercase tracking-widest text-[9px] select-none">
                    <th className="p-4 pl-6">Profile</th>
                    <th className="p-4">Role</th>
                    <th className="p-4">Active Shift status</th>
                    <th className="p-4">Current Process</th>
                    <th className="p-4">Clocked Interval</th>
                    <th className="p-4 text-center">Avg. Shift Utilization</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {finalMappedUsers.map((u) => {
                    const userShifts = allShifts.filter(sh => sh.userId === u.uid);
                    const activeShift = userShifts.find(sh => sh.status === 'ACTIVE' || sh.status === 'BREAK');
                    
                    let stats = activeShift ? computeShiftStats(activeShift) : null;
                    
                    // overall stats
                    let totalShiftMsSum = 0;
                    let totalActiveMsSum = 0;
                    userShifts.forEach(sh => {
                      const s = computeShiftStats(sh);
                      totalShiftMsSum += s.totalShiftMs;
                      totalActiveMsSum += s.activeMs;
                    });
                    const overallUtil = totalShiftMsSum > 0 
                      ? Number(((totalActiveMsSum / totalShiftMsSum) * 100).toFixed(1)) 
                      : null;

                    return (
                      <tr key={u.uid} className="hover:bg-slate-50/50 transition-colors">
                        <td className="p-4 pl-6 font-bold text-slate-800">
                          <div>{u.name}</div>
                          <div className="text-[10px] font-mono text-slate-400 font-medium leading-none mt-1">{u.email}</div>
                        </td>
                        <td className="p-4">
                          <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-wider">{u.role}</Badge>
                        </td>
                        <td className="p-4">
                          <div className="flex flex-col gap-1 items-start">
                            {activeShift ? (
                              <>
                                <div className="flex items-center gap-1.5">
                                  <Badge className={`text-[10px] font-black uppercase ${
                                    activeShift.status === 'BREAK' 
                                      ? 'bg-amber-100 text-amber-800 border-amber-200' 
                                      : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                                  }`}>
                                    LIVE - {activeShift.status}
                                  </Badge>
                                  {canUserForceLogoutTarget(user, u.uid) && (
                                    <Button 
                                      size="sm" 
                                      variant="ghost" 
                                      className="text-[9px] text-red-500 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 rounded-lg shrink-0 h-6 px-1.5 font-bold" 
                                      onClick={() => startForceLogoutFlow(activeShift.id, u.uid, u.name)}
                                    >
                                      Force Out
                                    </Button>
                                  )}
                                </div>
                              </>
                            ) : (
                              <Badge variant="secondary" className="text-[10px] bg-slate-100 text-slate-500 font-bold uppercase">
                                Offline
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="p-4 font-semibold text-slate-700">
                          {activeShift ? (
                            <div className="flex flex-col gap-0.5">
                              <span>{activeShift.activities[activeShift.activities.length - 1]?.name || 'N/A'}</span>
                            </div>
                          ) : (
                            <span className="text-slate-400">N/A</span>
                          )}
                        </td>
                        <td className="p-4 font-medium text-slate-500">
                          {activeShift ? (
                            <div className="flex flex-col gap-0.5 text-[10px]">
                              <span>Shift elapsed: {stats?.totalShiftStr}</span>
                              <span className="text-teal-600 font-bold">Productive: {stats?.activeStr}</span>
                            </div>
                          ) : (
                            <span className="text-slate-400">N/A</span>
                          )}
                        </td>
                        <td className="p-4 text-center font-bold text-sm text-[#0F172A] font-mono">
                          {overallUtil !== null ? (
                            <div>
                              <div>{overallUtil}%</div>
                              <div className="text-[9px] text-slate-400 font-normal leading-none mt-1 uppercase tracking-wider">
                                calculated over {userShifts.length} session(s)
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-400 font-normal text-xs">No entries</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {finalMappedUsers.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-16 text-center text-slate-400">
                        <div className="flex flex-col items-center gap-3">
                          <User size={36} className="text-slate-200" />
                          <p className="font-bold uppercase tracking-widest text-[10px] text-slate-400">
                            {mappedUsers.length === 0 ? "No agents mapped to you" : "No resources match your search"}
                          </p>
                          {mappedUsers.length === 0 && (
                             <p className="text-xs text-slate-400 max-w-sm font-medium">Please ask your system administrator to assign Agents or Quality Analysts to your team under the Console tab.</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Dynamic Date Range & Format Select Modal for Team Leads / Managers */}
        {showExportModal && exportType === 'team' && (
          <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200 text-slate-800">
            <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 space-y-4">
              <div className="flex items-center gap-3 border-b pb-3">
                <div className="w-10 h-10 rounded-xl bg-sky-50 flex items-center justify-center text-sky-600 shrink-0">
                  <FileSpreadsheet size={20} />
                </div>
                <div className="text-left">
                  <h4 className="font-extrabold text-slate-900 text-sm uppercase tracking-wide">
                    Export Team Report
                  </h4>
                  <p className="text-slate-500 text-[10px] font-bold leading-none mt-1">Specify date range and filter criteria</p>
                </div>
              </div>

              <div className="space-y-4 text-xs font-bold text-slate-700">
                {/* Date Range Preset */}
                <div className="space-y-1.5 text-left">
                  <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Date Range Preset</Label>
                  <select
                    value={selectedRangePreset}
                    onChange={(e) => {
                      setSelectedRangePreset(e.target.value);
                      if (e.target.value !== 'custom') {
                        setStartDateStr('');
                        setEndDateStr('');
                      }
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-sky-500 cursor-pointer"
                  >
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="last7">Last 7 Days</option>
                    <option value="last30">Last 30 Days (Default)</option>
                    <option value="currentMonth">Current Month</option>
                    <option value="previousMonth">Previous Month</option>
                    <option value="custom">Custom Date Range...</option>
                  </select>
                </div>

                {/* Custom Date Inputs */}
                {selectedRangePreset === 'custom' && (
                  <div className="grid grid-cols-2 gap-3 pt-1 animate-in slide-in-from-top-2 duration-200">
                    <div className="space-y-1.5 text-left">
                      <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">Start Date</Label>
                      <Input
                        type="date"
                        value={startDateStr}
                        onChange={(e) => setStartDateStr(e.target.value)}
                        className="border-slate-200 rounded-xl text-xs font-bold p-2.5 w-full bg-slate-50"
                      />
                    </div>
                    <div className="space-y-1.5 text-left">
                      <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">End Date</Label>
                      <Input
                        type="date"
                        value={endDateStr}
                        onChange={(e) => setEndDateStr(e.target.value)}
                        className="border-slate-200 rounded-xl text-xs font-bold p-2.5 w-full bg-slate-50"
                      />
                    </div>
                  </div>
                )}

                {/* File Format Selection */}
                <div className="space-y-2 text-left">
                  <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">File Format</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setExportFormat('excel')}
                      className={`p-3 rounded-xl border font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                        exportFormat === 'excel'
                          ? 'border-emerald-500 bg-emerald-50/50 text-emerald-850'
                          : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      Excel (.xlsx)
                    </button>
                    <button
                      type="button"
                      onClick={() => setExportFormat('csv')}
                      className={`p-3 rounded-xl border font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                        exportFormat === 'csv'
                          ? 'border-sky-500 bg-sky-50/50 text-sky-850'
                          : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full bg-sky-500" />
                      CSV (.csv)
                    </button>
                  </div>
                </div>

                {/* Report Type Selection */}
                <div className="space-y-2 text-left">
                  <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Report Type</Label>
                  <select
                    value={reportType}
                    onChange={(e) => setReportType(e.target.value as any)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-sky-500 cursor-pointer"
                  >
                    <option value="summary">Utilization Summary Report</option>
                    <option value="chronological">Detailed Chronological Activity Log (Breaks & Switches)</option>
                    {exportFormat === 'excel' && (
                      <option value="both">Both Reports (Separate Sheets)</option>
                    )}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 text-xs font-bold pt-3 border-t">
                {isExporting && (
                  <div className="w-full space-y-2 py-1 mb-2">
                    <div className="flex justify-between text-xs font-bold text-slate-700">
                      <span>{exportProgressMessage || 'Generating report...'}</span>
                      <span>{exportProgressPercent}%</span>
                    </div>
                    <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                      <div 
                        className="bg-emerald-600 h-full rounded-full transition-all duration-300 ease-out" 
                        style={{ width: `${exportProgressPercent}%` }}
                      />
                    </div>
                  </div>
                )}
                <Button variant="ghost" onClick={() => setShowExportModal(false)} disabled={isExporting} className="rounded-xl">Cancel</Button>
                {isExporting ? (
                  <Button
                    className="bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-900/30 dark:hover:bg-red-900/50 dark:text-red-400 font-bold rounded-xl cursor-pointer"
                    onClick={cancelExport}
                  >
                    Cancel Export
                  </Button>
                ) : (
                  <Button
                    className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    onClick={handleGenerateExport}
                    disabled={isExporting}
                  >
                    Generate & Export
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    );
  }

  const handleExportAllShifts = () => {
    setExportType('organization');
    setSelectedRangePreset('last30');
    setStartDateStr('');
    setEndDateStr('');
    setExportFormat('excel');
    setReportType('both');
    setShowExportModal(true);
  };

  const executeOrganizationExport = async (
    start: Date, 
    end: Date, 
    format: 'csv' | 'excel', 
    fetchedShifts: TMSShift[] = allShifts,
    selectedReportType: 'summary' | 'chronological' | 'both' = 'both'
  ) => {
    // Filter fetchedShifts by work date logic (shifts starting before 4 AM belong to previous day)
    const requestedStartDateStr = start.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const requestedEndDateStr = end.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const rangeShifts = fetchedShifts.filter(sh => {
      const shWorkDate = getWorkDateString(sh.clockInTime);
      return shWorkDate >= requestedStartDateStr && shWorkDate <= requestedEndDateStr;
    });

    if (rangeShifts.length === 0) {
      toast.error("No shift logs found for the selected work date(s)");
      return;
    }

    const includeSummary = selectedReportType === 'summary' || selectedReportType === 'both';
    const includeChrono = selectedReportType === 'chronological' || selectedReportType === 'both';

    // O(1) User maps for fast lookups
    const usersByIdMap = new Map<string, any>();
    const usersByEmailMap = new Map<string, any>();
    allUsers.forEach(u => {
      if (u.uid) usersByIdMap.set(u.uid, u);
      if (u.email) usersByEmailMap.set(u.email.toLowerCase().trim(), u);
    });

    // Authoritative hierarchy pre-computation
    const authoritativeUsersList: UserProfile[] = allUsers || [];
    const lookupMaps = buildAuthoritativeLookupMaps(authoritativeUsersList);
    const hierarchyCache = new Map<string, { teamLead: string; manager: string }>();

    for (const u of authoritativeUsersList) {
      if (u.uid) {
        const h = resolveAuthoritativeHierarchy(u, authoritativeUsersList, lookupMaps);
        hierarchyCache.set(u.uid, { teamLead: h.teamLead, manager: h.manager });
        if (u.email) {
          hierarchyCache.set(u.email.toLowerCase().trim(), { teamLead: h.teamLead, manager: h.manager });
        }
      }
    }

    const getHierarchyForUser = (userId?: string, userEmail?: string, uProf?: UserProfile) => {
      if (userId && hierarchyCache.has(userId)) return hierarchyCache.get(userId)!;
      if (userEmail && hierarchyCache.has(userEmail.toLowerCase().trim())) return hierarchyCache.get(userEmail.toLowerCase().trim())!;
      if (uProf && uProf.uid && hierarchyCache.has(uProf.uid)) return hierarchyCache.get(uProf.uid)!;
      const res = resolveAuthoritativeHierarchy(uProf, authoritativeUsersList, lookupMaps);
      if (userId) hierarchyCache.set(userId, { teamLead: res.teamLead, manager: res.manager });
      if (userEmail) hierarchyCache.set(userEmail.toLowerCase().trim(), { teamLead: res.teamLead, manager: res.manager });
      return res;
    };

    const summaryHeaders = [
      'Emp ID',
      'Name',
      'Email ID',
      'Team Lead',
      'Manager',
      'Shift Status',
      'Process Name',
      'Last Activity',
      'Clock In Time (IST)',
      'Clock Out Time (IST)',
      'Total Duration (Min)',
      'Productive Duration (Min)',
      'Break Duration (Min)',
      'Utilization (%)',
      'Work Location',
      'Detection Method',
      'Office Name',
      'Public IP',
      'Location Captured At'
    ];

    const summaryRows = includeSummary ? rangeShifts.map(sh => {
      const stats = computeShiftStats(sh);
      const clockIn = new Date(sh.clockInTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const clockOut = sh.clockOutTime 
        ? new Date(sh.clockOutTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) 
        : 'Ongoing';

      const totalShiftMins = (stats.totalShiftMs / (60 * 1000)).toFixed(1);
      const totalProductiveMins = (stats.activeMs / (60 * 1000)).toFixed(1);
      const totalBreakMins = (stats.breakMs / (60 * 1000)).toFixed(1);

      const shActs = sh.activities || [];
      const productiveAct = [...shActs].reverse().find(act => act.type === 'productive');
      const processName = productiveAct ? productiveAct.name : 'N/A';
      const lastAct = shActs.length > 0 ? shActs[shActs.length - 1] : null;
      const lastActivity = lastAct ? lastAct.name : 'N/A';

      let uProfile = sh.userId ? usersByIdMap.get(sh.userId) : undefined;
      if (!uProfile && sh.userEmail) {
        uProfile = usersByEmailMap.get(sh.userEmail.toLowerCase().trim());
      }
      const empId = uProfile?.employeeId || 'N/A';
      const userHier = getHierarchyForUser(sh.userId, sh.userEmail, uProfile);
      const teamLead = userHier.teamLead || 'Unassigned';
      const manager = userHier.manager || 'Unassigned';

      return [
        empId,
        sh.userName || 'N/A',
        sh.userEmail || 'N/A',
        teamLead,
        manager,
        sh.status || 'N/A',
        processName,
        lastActivity,
        clockIn,
        clockOut,
        totalShiftMins,
        totalProductiveMins,
        totalBreakMins,
        stats.utilization + '%',
        sh.workLocation || 'Home',
        sh.workLocationSource || 'IP Detection',
        sh.officeName || 'N/A',
        sh.publicIP || 'N/A',
        sh.locationCapturedAt ? new Date(sh.locationCapturedAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : 'N/A'
      ];
    }) : [];

    const chronoHeaders = [
      'Emp ID',
      'Agent Name',
      'Agent Email',
      'Team Lead',
      'Manager',
      'Date (IST)',
      'Action Sequence',
      'Duration Type',
      'Specific Activity / Break Type',
      'Start Time (IST)',
      'End Time (IST)',
      'Duration (Mins)'
    ];

    const buildChronoRowsForOrg = (shifts: TMSShift[]) => {
      const chronoRows: any[] = [];
      const sortedShifts = [...shifts].sort((a, b) => new Date(a.clockInTime).getTime() - new Date(b.clockInTime).getTime());

      sortedShifts.forEach(sh => {
        const workDate = getWorkDateString(sh.clockInTime);
        let uProfile = sh.userId ? usersByIdMap.get(sh.userId) : undefined;
        if (!uProfile && sh.userEmail) {
          uProfile = usersByEmailMap.get(sh.userEmail.toLowerCase().trim());
        }
        const empId = uProfile?.employeeId || 'N/A';
        const userHier = getHierarchyForUser(sh.userId, sh.userEmail, uProfile);
        const teamLead = userHier.teamLead || 'Unassigned';
        const manager = userHier.manager || 'Unassigned';
        
        const reconstructed = buildTimelineFromActivityLedger(sh.activities || [], sh.status || 'ACTIVE', sh.clockOutTime, getLiveTime().getTime());
        reconstructed.forEach((act, idx) => {
          const startTimeIST = new Date(act.startTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
          const endTimeIST = act.isLive 
            ? 'Ongoing'
            : new Date(act.endTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
          
          const durationMs = new Date(act.endTime).getTime() - new Date(act.startTime).getTime();
          const durationMin = durationMs / (1000 * 60);

          chronoRows.push([
            empId,
            sh.userName || 'N/A',
            sh.userEmail || 'N/A',
            teamLead,
            manager,
            workDate,
            idx + 1,
            act.type === 'productive' ? 'Productive Work' : 'Break',
            act.name || 'N/A',
            startTimeIST,
            endTimeIST,
            durationMin.toFixed(1)
          ]);
        });
      });
      return chronoRows;
    };

    const chronoRows = includeChrono ? buildChronoRowsForOrg(rangeShifts) : [];

    const ledgerHeaders = [
      'Employee', 'User Email', 'Team Lead', 'Manager', 'Shift Date', 'Event Sequence', 'Event Time',
      'Event Type', 'Old Value', 'New Value', 'Reason', 'Source',
      'Performed By', 'Confidence', 'Remarks'
    ];

    const buildLedgerRows = (shifts: TMSShift[]) => {
      const rows: any[] = [];
      shifts.forEach(sh => {
        let uProfile = sh.userId ? usersByIdMap.get(sh.userId) : undefined;
        if (!uProfile && sh.userEmail) {
          uProfile = usersByEmailMap.get(sh.userEmail.toLowerCase().trim());
        }
        const userHier = getHierarchyForUser(sh.userId, sh.userEmail, uProfile);
        const teamLead = userHier.teamLead || 'Unassigned';
        const manager = userHier.manager || 'Unassigned';

        const reportRows = formatShiftLedgerForReport(sh);
        reportRows.forEach(r => {
          rows.push([
            r['Employee'],
            r['User Email'],
            teamLead,
            manager,
            r['Shift Date'],
            r['Event Sequence'],
            r['Event Time'],
            r['Event Type'],
            r['Old Value'],
            r['New Value'],
            r['Reason'],
            r['Source'],
            r['Performed By'],
            r['Confidence'],
            r['Remarks']
          ]);
        });
      });
      return rows;
    };

    const ledgerRows = includeChrono ? buildLedgerRows(rangeShifts) : [];

    // NEW: Attendance Logic grouping by user and date
    const attendanceHeaders = [
      'Emp ID',
      'Name',
      'Email ID',
      'Team Lead',
      'Manager',
      'Process',
      'Date',
      'Productive Mins',
      'Attendance Status'
    ];

    const buildAttendanceRows = (shifts: TMSShift[]) => {
      const mergedRecords = aggregateShiftsForHistoryAndReports(shifts, now.getTime());
      return mergedRecords.map(m => {
        let uProfile = m.userId ? usersByIdMap.get(m.userId) : undefined;
        if (!uProfile && m.userEmail) {
          uProfile = usersByEmailMap.get(m.userEmail.toLowerCase().trim());
        }
        const empId = uProfile?.employeeId || 'N/A';
        const userHier = getHierarchyForUser(m.userId, m.userEmail, uProfile);
        const teamLead = userHier.teamLead || 'Unassigned';
        const manager = userHier.manager || 'Unassigned';
        const proc = m.process || uProfile?.process || 'N/A';
        const prodMins = m.productiveMs / 60000;

        let status = 'Absent';
        if (prodMins > 480) {
          status = 'Present';
        } else if (prodMins >= 240) {
          status = 'Half Day';
        }

        return [
          empId,
          m.userName,
          m.userEmail,
          teamLead,
          manager,
          proc,
          m.attendanceDate,
          prodMins.toFixed(1),
          status
        ];
      });
    };

    const attendanceRows = buildAttendanceRows(rangeShifts);

    console.log(`[REPORT EXPORT] Admin/Manager organization report exported by ${user.name} (${user?.email || user?.uid || 'Unknown'}). Date range: ${start.toISOString()} to ${end.toISOString()} in format: ${format}, reportType: ${selectedReportType}`);

    if (format === 'excel') {
      const workbook = XLSX.utils.book_new();

      if (selectedReportType === 'both') {
        const wsMain = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
        wsMain['!cols'] = summaryHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsMain, "Organization Utilization");

        const wsChrono = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
        wsChrono['!cols'] = chronoHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsChrono, "Chronological Activity Logs");

        const wsLedger = XLSX.utils.aoa_to_sheet([ledgerHeaders, ...ledgerRows]);
        wsLedger['!cols'] = ledgerHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsLedger, "Immutable Event Ledger");
        
        const wsAttendance = XLSX.utils.aoa_to_sheet([attendanceHeaders, ...attendanceRows]);
        wsAttendance['!cols'] = attendanceHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsAttendance, "Attendance Report");
      } else if (selectedReportType === 'summary') {
        const wsMain = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
        wsMain['!cols'] = summaryHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsMain, "Organization Utilization");

        const wsAttendance = XLSX.utils.aoa_to_sheet([attendanceHeaders, ...attendanceRows]);
        wsAttendance['!cols'] = attendanceHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsAttendance, "Attendance Report");
      } else if (selectedReportType === 'chronological') {
        const wsChrono = XLSX.utils.aoa_to_sheet([chronoHeaders, ...chronoRows]);
        wsChrono['!cols'] = chronoHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsChrono, "Chronological Activity Logs");

        const wsLedger = XLSX.utils.aoa_to_sheet([ledgerHeaders, ...ledgerRows]);
        wsLedger['!cols'] = ledgerHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsLedger, "Immutable Event Ledger");

        const wsAttendance = XLSX.utils.aoa_to_sheet([attendanceHeaders, ...attendanceRows]);
        wsAttendance['!cols'] = attendanceHeaders.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(workbook, wsAttendance, "Attendance Report");
      }
      const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const zip = new JSZip();
      let filenameSuffix = "Org_Report";
      if (selectedReportType === 'both') filenameSuffix = "Summary_and_Chronological_Report";
      else if (selectedReportType === 'summary') filenameSuffix = "Summary_Report";
      else if (selectedReportType === 'chronological') filenameSuffix = "Chronological_Activity_Logs";

      const fileName = `TMS_Org_${filenameSuffix}`;
      zip.file(`${fileName}.xlsx`, excelBuffer);
      const zipContent = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      
      const url = URL.createObjectURL(zipContent);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `${fileName}.zip`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } else {
      const zip = new JSZip();
      if (selectedReportType === 'summary') {
        const csvContent = "\uFEFF" + [summaryHeaders.join(','), ...summaryRows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
        const fileName = `TMS_Org_Summary_Report`;
        zip.file(`${fileName}.csv`, csvContent);
        const zipContent = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        const url = URL.createObjectURL(zipContent);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `${fileName}.zip`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } else {
        const csvContent = "\uFEFF" + [chronoHeaders.join(','), ...chronoRows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
        const fileName = `TMS_Org_Chronological_Activity_Logs`;
        zip.file(`${fileName}.csv`, csvContent);
        const zipContent = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        const url = URL.createObjectURL(zipContent);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `${fileName}.zip`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    }
    toast.success('Organization Report exported successfully!');
  };

  const handleAdminGenerateExport = async () => {
    if (selectedRangePreset === 'custom' && (!startDateStr || !endDateStr)) {
      toast.error('Please select both start and end dates for custom range.');
      return;
    }

    const abortCtrl = new AbortController();
    setExportAbortController(abortCtrl);
    setIsExporting(true);
    setExportProgressPercent(5);
    setExportProgressMessage('Starting organization export...');
    try {
      const mappedUsers = allUsers.filter(u => u.uid !== user.uid && (!u.status || u.status.toLowerCase().trim() === 'active' || u.isActive === true) && canActOn(user, u, allUsers));
      const res = await generateAndDownloadOrganizationReport({
        actor: user,
        allUsers: allUsers || [],
        authorizedTeamUids: mappedUsers.map(u => u.uid),
        hasTmsPermission,
        preset: selectedRangePreset,
        startDateStr,
        endDateStr,
        format: exportFormat,
        reportType,
        signal: abortCtrl.signal,
        onProgress: (pct, msg) => {
          setExportProgressPercent(pct);
          setExportProgressMessage(msg);
        }
      });
      if (!res.success) {
        toast.error(res.message || 'No records found for the selected date range.');
      } else {
        toast.success('Organization Report exported successfully!');
        setShowExportModal(false);
      }
    } catch (err: any) {
      console.error('Organization export generation failed:', err);
      if (err?.message !== 'Export cancelled by user') {
        toast.error('Failed to generate organization report.');
      }
    } finally {
      setIsExporting(false);
      setExportAbortController(null);
    }
  };

  const showSelfService = hasTmsPermission('view_self_service');
  const showOwnShiftSummary = hasTmsPermission('can_view_own_shift_summary');
  const showOwnAttendance = hasTmsPermission('can_view_own_attendance_summary');
  const showTimelineCol = showOwnShiftSummary || showOwnAttendance;

  // Columns layout configuration
  const punchColSpan = showTimelineCol ? "lg:col-span-5" : "lg:col-span-12";
  const timelineColSpan = showSelfService ? "lg:col-span-7" : "lg:col-span-12";

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 overflow-y-auto h-full pr-1">
      
      {/* Upper header segment */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4.5 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-sky-500 flex items-center justify-center text-white shadow-md shadow-sky-200 shrink-0">
            <Clock size={20} />
          </div>
          <div>
            <h2 className="text-[24px] font-black text-slate-900 tracking-tight leading-tight">Workforce Time Management</h2>
            <p className="text-xs font-medium text-slate-500">Punch shifts, breaks, processes, and track real-time utilization</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {canViewReports && isDashboardUser && (
            <Button
              onClick={handleExportAllShifts}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-3.5 rounded-xl flex items-center gap-1.5 shadow-sm shadow-emerald-200 cursor-pointer h-9"
            >
              <FileSpreadsheet size={15} /> Export Organization Report
            </Button>
          )}

          {/* Current system clock */}
          <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 px-4 py-1.5 rounded-xl">
            <Activity className="text-emerald-500 animate-pulse shrink-0" size={16} />
            <div className="text-right">
              <p className="text-[9px] uppercase font-bold tracking-widest text-slate-400">Live Server Time (IST)</p>
              <p className="font-mono text-xs font-bold text-slate-800 leading-none mt-0.5">
                <LiveHeaderClock />
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        
        {/* Punch Control / Agent Panel */}
        {showSelfService && (
          <div className={`${punchColSpan} space-y-4`}>
          <Card className="border-none shadow-md shadow-slate-200 overflow-visible bg-white">
            <CardHeader className="bg-slate-900 text-white rounded-t-2xl py-2.5 px-3.5">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-black tracking-tight leading-none text-white">Punch Station</CardTitle>
                  <CardDescription className="text-slate-400 text-[10px] leading-none mt-1">Shift controls and process routing</CardDescription>
                </div>
                <Badge className={`px-2 py-0.5 text-[9px] ${
                  !currentShift ? 'bg-red-500/20 text-red-400 border-red-500/30' :
                  currentShift.status === 'BREAK' ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                  'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                } border font-bold uppercase tracking-wider`}>
                  {!currentShift ? 'CLOCKED OUT' : currentShift.status === 'BREAK' ? 'ON BREAK' : 'ACTIVE WORK'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-3 space-y-2.5">
              
              {/* Ticking Clock Status inside Punch station */}
              <LiveAgentDurations 
                currentShift={currentShift} 
                myPastShifts={myPastShifts} 
                formatMs={formatMs} 
                now={now}
              />

              {/* Compact Device & Location Info Strip */}
              <div className="flex items-center justify-between px-2.5 py-1.5 bg-slate-50 rounded-lg border border-slate-200/80 text-[11px]">
                <div className="flex items-center gap-1.5 text-slate-600 font-semibold">
                  {deviceType === 'Desktop' ? <Monitor size={12} className="text-emerald-600" /> : <Smartphone size={12} className="text-fuchsia-600" />}
                  <span className="text-[10px]">{deviceType} • {os}</span>
                </div>
                {currentShift && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-600 font-bold">
                      {(currentShift.workLocation || 'Home') === 'Office' ? '🏢 Office' : '🏠 Home'}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-[9px] font-bold text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded cursor-pointer"
                      onClick={async () => {
                        const currentLoc = currentShift.workLocation || 'Home';
                        const newLoc = currentLoc === 'Office' ? 'Home' : 'Office';
                        await handleManualLocationOverride(newLoc);
                      }}
                    >
                      Change
                    </Button>
                  </div>
                )}
              </div>

              {/* State Machine Action Controls */}
              {!currentShift ? (
                // 1. Clocked Out Interface
                <div className="space-y-2 pt-0.5">
                  <div className="space-y-1">
                    <Label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Select Start Process</Label>
                    <ProcessSelector
                      allProcesses={allAvailableProcesses}
                      currentProcess={selectedProcessInput}
                      onSelectProcess={handleSelectProcess}
                      recentProcesses={recentProcesses}
                      favoriteProcesses={favoriteProcesses}
                      onToggleFavorite={toggleFavorite}
                    />
                  </div>
                  <Button 
                    disabled={isProcessingPunch}
                    className="w-full h-9 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs rounded-lg flex items-center justify-center gap-1.5 shadow-sm shadow-emerald-200 cursor-pointer disabled:opacity-50"
                    onClick={handleClockIn}
                  >
                    {isProcessingPunch ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <Play size={14} />
                    )}
                    {isProcessingPunch ? 'CLOCKING IN...' : 'GO TO WORK & CLOCK IN'}
                  </Button>
                </div>
              ) : currentShift.status === 'BREAK' ? (
                // 2. Break Interface (Resume Controls)
                <div className="space-y-2 pt-0.5">
                  <div className="p-2 bg-amber-50 border border-amber-200/80 rounded-lg text-[11px] text-amber-800 flex items-center gap-2 font-medium">
                    <Coffee className="shrink-0 text-amber-500" size={14} />
                    <span className="truncate">On Break: <strong className="font-bold">{currentShift.activities[currentShift.activities.length - 1]?.name || 'Break'}</strong></span>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Resume Process</Label>
                    <ProcessSelector
                      allProcesses={allAvailableProcesses}
                      currentProcess={selectedProcessInput}
                      onSelectProcess={handleSelectProcess}
                      recentProcesses={recentProcesses}
                      favoriteProcesses={favoriteProcesses}
                      onToggleFavorite={toggleFavorite}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-0.5">
                    <Button 
                      className="h-8.5 bg-teal-600 hover:bg-teal-700 text-white font-black text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
                      onClick={() => handleResumeWork(selectedProcessInput)}
                    >
                      <CheckCircle size={13} /> RESUME
                    </Button>
                    <Button 
                      variant="destructive"
                      className="h-8.5 font-black text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
                      onClick={handleClockOut}
                    >
                      <LogOut size={13} /> CLOCK OUT
                    </Button>
                  </div>
                </div>
              ) : (
                // 3. Active Work Interface (Break/Switch Controls)
                <div className="space-y-2 pt-0.5">
                  {/* Active Process Header */}
                  <div className="bg-sky-50 border border-sky-100 px-2.5 py-1.5 rounded-lg text-[11px] text-sky-900 flex items-center justify-between">
                    <span className="font-medium text-slate-500">Active Process:</span>
                    <span className="font-extrabold text-sky-700 truncate max-w-[200px]">{currentActiveProcessName || selectedProcessInput}</span>
                  </div>

                  {/* Switch Process Row */}
                  <div className="space-y-1">
                    <Label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Switch Process</Label>
                    <ProcessSelector
                      allProcesses={allAvailableProcesses}
                      currentProcess={""}
                      onSelectProcess={handleSwitchProcess}
                      recentProcesses={recentProcesses}
                      favoriteProcesses={favoriteProcesses}
                      onToggleFavorite={toggleFavorite}
                    />
                  </div>

                  {/* Take Break Row */}
                  <div className="space-y-1">
                    <Label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Take Break</Label>
                    <div className="flex gap-2">
                      <select
                        className="flex-1 h-8.5 bg-white border border-slate-200 rounded-lg px-2 text-xs text-slate-800 font-semibold focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        value={selectedBreakInput}
                        onChange={(e) => setSelectedBreakInput(e.target.value)}
                      >
                        {BREAK_OPTIONS.map(b => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                      <Button 
                        size="sm" 
                        className="bg-amber-500 hover:bg-amber-600 font-bold text-xs h-8.5 px-3 shrink-0 cursor-pointer text-white flex items-center gap-1 rounded-lg"
                        onClick={handleStartBreak}
                      >
                        <Coffee size={13} /> Break
                      </Button>
                    </div>
                  </div>

                  {/* End Work / Clock Out */}
                  <div className="pt-1">
                    <Button 
                      variant="destructive"
                      className="w-full h-8.5 font-black text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer shadow-sm shadow-red-200"
                      onClick={handleClockOut}
                    >
                      <LogOut size={14} /> END WORK & CLOCK OUT
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Today's Shift Metrics Summary */}
          {showOwnShiftSummary && (currentShift || (myPastShifts && myPastShifts.length > 0)) && (
            <LiveShiftMathSummaryCard 
              currentShift={currentShift}
              myPastShifts={myPastShifts}
              now={now}
            />
          )}
        </div>
        )}

        {/* Shift Timeline / Session History Column */}
        {showTimelineCol && (
        <div className={`${timelineColSpan} space-y-4`}>
          {showOwnShiftSummary && (
          <Card className="border-none shadow-md shadow-slate-200">
            <CardHeader className="border-b border-slate-100 py-2.5 px-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <CardTitle className="text-[17px] font-black text-slate-900 tracking-tight uppercase">Active Timeline List</CardTitle>
                  <CardDescription className="text-[11px] font-bold text-slate-500 uppercase tracking-tight">Your segmented chronological punch log</CardDescription>
                </div>
                <Activity size={18} className="text-sky-400" />
              </div>
            </CardHeader>
            <CardContent className="py-2 px-3.5 max-h-[440px] overflow-y-auto">
              {currentShift ? (
                <div className="relative border-l-2 border-slate-200 ml-3.5 pl-5 space-y-1 py-0.5">
                  {sanitizeActivities(
                    currentShift.activities || currentShift.shiftEventLedger || [], 
                    currentShift.clockInTime, 
                    currentShift.clockOutTime ? new Date(currentShift.clockOutTime).getTime() : getLiveTime().getTime(),
                    currentShift.status,
                    currentShift.clockOutTime
                  ).map((act, index) => {
                    const isAudit = isAuditOrDiagnosticEvent(act.action) || act.type === 'system';
                    const isBreak = !isAudit && isBreakActivity(act.name, act.type);
                    const isMeeting = !isAudit && isMeetingActivity(act.name);
                    const isTraining = !isAudit && isTrainingActivity(act.name);
                      
                    let badgeColor = 'bg-emerald-100 text-emerald-800';
                    let dotColor = 'bg-emerald-500';
                    let badgeLabel = 'Productive';
                    let Icon = CheckCircle;

                    if (isAudit) {
                      badgeColor = 'bg-slate-200 text-slate-700';
                      dotColor = 'bg-slate-500';
                      badgeLabel = 'System Event';
                      Icon = AlertTriangle;
                    } else if (isBreak) {
                      badgeColor = 'bg-amber-100 text-amber-800';
                      dotColor = 'bg-amber-500';
                      badgeLabel = 'Break';
                      Icon = Coffee;
                    } else if (isMeeting) {
                      badgeColor = 'bg-blue-100 text-blue-800';
                      dotColor = 'bg-blue-500';
                      badgeLabel = 'Meeting';
                      Icon = Users;
                    } else if (isTraining) {
                      badgeColor = 'bg-purple-100 text-purple-800';
                      dotColor = 'bg-purple-500';
                      badgeLabel = 'Training';
                      Icon = GraduationCap;
                    }

                    if (!isAudit) {
                      if (act.action === 'CLOCK_IN') {
                        badgeLabel = 'Clock In';
                      } else if (act.action === 'PROCESS_SWITCH') {
                        badgeLabel = 'Switch';
                      } else if (act.action === 'RESUME_SHIFT' || act.action === 'BREAK_END') {
                        badgeLabel = 'Resume';
                      }
                    }

                    const displayDuration = act.isLive
                      ? formatMs(getLiveTime().getTime() - new Date(act.startTime).getTime())
                      : formatMs(act.durationMs || 0);

                    return (
                      <div key={act.activityId || index} className="relative group animate-in fade-in slide-in-from-left-2 duration-300">
                        {/* Timeline dot */}
                        <div className={`absolute -left-[27px] top-2 w-5 h-5 rounded-full border-2 border-white flex items-center justify-center text-white z-10 shadow-sm ${
                          act.isLive ? 'bg-sky-600 ring-4 ring-sky-100 animate-pulse' : dotColor
                        }`}>
                          <Icon size={10} strokeWidth={3} />
                        </div>

                        <div className="bg-slate-50/50 hover:bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100 transition-all">
                          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-black text-slate-900 text-[13px] tracking-tight">{act.name || act.process || 'Activity'}</span>
                              <Badge className={`${badgeColor} text-[10px] uppercase font-black px-1.5 py-0 border-none shadow-none`}>
                                {badgeLabel}
                              </Badge>
                              {act.isLive && (
                                <span className="flex items-center gap-1 text-[10px] bg-red-600 text-white font-black px-1.5 py-0 rounded animate-pulse">
                                  <div className="w-1 h-1 bg-white rounded-full"></div>
                                  LIVE
                                </span>
                              )}
                            </div>
                            <div className="flex items-baseline gap-1.5">
                              <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider">Dur:</span>
                              <span className="font-mono font-black text-xs text-slate-700">{displayDuration}</span>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 mt-0.5">
                            <div className="flex items-center gap-1">
                              <Clock size={11} className="text-slate-400" />
                              <span>{formatTimeStr(act.startTime)}</span>
                            </div>
                            <span className="text-slate-300">→</span>
                            <div className="flex items-center gap-1">
                              {act.isLive ? (
                                <span className="text-sky-600 font-black text-xs">CURRENT</span>
                              ) : (
                                <span>{formatTimeStr(act.endTime)}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-16">
                  <div className="flex flex-col items-center gap-2 opacity-35 max-w-sm mx-auto">
                    <History size={36} className="text-slate-400" />
                    <p className="text-xs uppercase tracking-widest font-black text-slate-600">No shift currently active</p>
                    <p className="text-[11px] font-medium text-slate-500">Your chronologic session intervals will compile here when clocked in.</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          )}

          {/* Past Shift History Logs */}
          {showOwnAttendance && (
          <Card className="border-none shadow-md shadow-slate-200">
            <CardHeader className="border-b border-slate-100 py-2.5 px-4">
              <CardTitle className="text-base font-black text-slate-900">Your Shift History</CardTitle>
              <CardDescription className="text-[11px] font-bold text-slate-500 uppercase tracking-tight">Recent 2 completed shifts</CardDescription>
            </CardHeader>
            <CardContent className="p-0 max-h-[300px] overflow-y-auto">
              <div className="divide-y divide-slate-100">
                {(() => {
                  const completedStatuses = ['COMPLETED', 'AUTO_CLOSED', 'COMPLETED_FORCED', 'CLOCKED_OUT', 'CLOSED', 'ENDED'];
                  const pastShiftsFiltered = myPastShifts
                    .filter(s => {
                      const normStatus = (s.status || '').toUpperCase();
                      const isCompleted = completedStatuses.includes(normStatus) || Boolean(s.clockOutTime && normStatus !== 'ACTIVE' && normStatus !== 'BREAK');
                      if (!isCompleted) return false;

                      const inMs = parseTimestampMs(s.clockInTime);
                      if (!inMs) return false;
                      // Past 14 days
                      return (Date.now() - inMs) <= 14 * 24 * 60 * 60 * 1000;
                    })
                    .sort((a, b) => parseTimestampMs(b.clockInTime) - parseTimestampMs(a.clockInTime))
                    .slice(0, 2);

                  if (pastShiftsFiltered.length === 0) {
                    return (
                      <div className="text-center py-8 opacity-40 text-[10px] uppercase font-black tracking-widest text-slate-600">
                        No completed shift logs found (past 14 days)
                      </div>
                    );
                  }

                  // Process and calculate metrics for each individual completed shift, then group by date
                  interface HistoryShiftRecord {
                    id: string;
                    clockInTime: string;
                    clockOutTime: string | null;
                    productiveMs: number;
                    breakMs: number;
                    utilization: number;
                  }

                  const groupedByDate = new Map<string, HistoryShiftRecord[]>();
                  pastShiftsFiltered.forEach(s => {
                    const metrics = calculateShiftMetrics(s, now.getTime());
                    const date = formatDateStr(s.clockInTime);
                    
                    const record: HistoryShiftRecord = {
                      id: s.id || `shift_${s.clockInTime}`,
                      clockInTime: s.clockInTime,
                      clockOutTime: s.clockOutTime || null,
                      productiveMs: metrics.productiveMs,
                      breakMs: metrics.breakMs,
                      utilization: metrics.utilization,
                    };

                    if (!groupedByDate.has(date)) {
                      groupedByDate.set(date, []);
                    }
                    groupedByDate.get(date)?.push(record);
                  });

                  // Sort dates chronologically desc (newest first)
                  const sortedDateEntries = Array.from(groupedByDate.entries()).sort((a, b) => {
                    const aMaxMs = Math.max(...a[1].map(r => parseTimestampMs(r.clockInTime)));
                    const bMaxMs = Math.max(...b[1].map(r => parseTimestampMs(r.clockInTime)));
                    return bMaxMs - aMaxMs;
                  });

                  // Sort individual sessions within each date chronologically desc (newest first)
                  sortedDateEntries.forEach(([_, records]) => {
                    records.sort((a, b) => parseTimestampMs(b.clockInTime) - parseTimestampMs(a.clockInTime));
                  });

                  return sortedDateEntries.map(([date, records]) => (
                    <div key={date} className="border-b border-slate-50 last:border-0">
                      <div className="bg-slate-50/50 px-3.5 py-0.5 text-[9px] uppercase font-black text-slate-400 tracking-wider">
                        {date}
                      </div>
                      <div className="divide-y divide-slate-50">
                        {records.map((rec) => {
                          const activeStr = formatMs(rec.productiveMs);
                          const breakStr = formatMs(rec.breakMs);
                          return (
                            <div key={rec.id} className="px-3.5 py-1.5 hover:bg-slate-50 transition-colors flex items-center justify-between text-xs">
                              <div className="space-y-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-slate-600 font-bold text-xs">
                                    {formatTimeStr(rec.clockInTime)} - {rec.clockOutTime ? formatTimeStr(rec.clockOutTime) : 'Ongoing'}
                                  </span>
                                </div>
                                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-tight">
                                  Prod: <span className="text-teal-600">{activeStr}</span> &middot; Breaks: <span className="text-amber-600">{breakStr}</span>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className="text-[9px] uppercase font-black text-slate-400 tracking-wider leading-none">Utilization</p>
                                <p className="font-mono font-black text-xs text-slate-900">{rec.utilization}%</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </CardContent>
          </Card>
          )}
        </div>
        )}

      </div>



      {/* Custom clock-out confirmation overlay modal */}
      {showClockOutConfirm && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 space-y-4 text-left">
            <div className="flex items-center gap-3 text-red-600">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <AlertCircle size={20} />
              </div>
              <div>
                <h4 className="font-bold text-slate-900 text-sm">Clock Out Confirmation</h4>
                <p className="text-slate-500 text-xs mt-1">Are you sure you want to Clock Out and finalise your shift logs?</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 text-xs font-bold pt-2 border-t">
              <Button variant="ghost" onClick={() => setShowClockOutConfirm(false)} className="cursor-pointer">Cancel</Button>
              <Button className="bg-red-600 hover:bg-red-700 text-white font-bold cursor-pointer" onClick={() => {
                setShowClockOutConfirm(false);
                performClockOut();
              }}>Confirm Clock Out</Button>
            </div>
          </div>
        </div>
      )}

      {/* Custom clock-in confirmation overlay modal */}
      {showClockInConfirm && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 space-y-5 text-left">
            <div className="flex items-center gap-4 text-emerald-600 border-b border-slate-50 pb-4">
              <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
                <Clock size={24} />
              </div>
              <div className="flex-1">
                <h4 className="font-black text-slate-900 text-sm uppercase tracking-tight">Confirm Shift Start</h4>
                <p className="text-slate-500 text-[10px] font-bold mt-0.5 leading-tight">Verification required before punch</p>
              </div>
            </div>
            
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex flex-col items-center justify-center text-center">
              <p className="text-[10px] uppercase font-black text-slate-400 tracking-widest">Target Work Process</p>
              <p className="text-lg font-black text-slate-900 mt-1 leading-tight">{selectedProcessInput}</p>
              <p className="text-[10px] text-slate-500 font-semibold mt-2 max-w-[200px]">You are about to start work in the following process: <span className="font-bold text-emerald-600">{selectedProcessInput}</span></p>
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <Button 
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-emerald-100 flex items-center justify-center gap-2 cursor-pointer"
                onClick={performClockIn}
                disabled={isProcessingPunch}
              >
                {isProcessingPunch ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
                CONFIRM & START SHIFT
              </Button>
              <Button 
                variant="ghost" 
                className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 font-bold text-xs h-10 rounded-xl cursor-pointer"
                onClick={() => setShowClockInConfirm(false)}
              >
                CHANGE PROCESS
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Custom user force logout overlay modal with reason select and logging */}
      {forceOutShiftId && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200 text-slate-800">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 text-red-650 border-b pb-3">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <AlertCircle size={20} />
              </div>
              <div className="text-left">
                <h4 className="font-extrabold text-slate-900 text-md uppercase tracking-wide">Force Logout Action</h4>
                <p className="text-slate-500 text-[10px] font-bold leading-none mt-1">Authorized compliance override execution</p>
              </div>
            </div>

            <div className="space-y-4 text-xs font-bold text-slate-700">
              <div className="p-3.5 bg-red-50/50 border border-red-100 rounded-xl space-y-2 text-left">
                <p className="text-red-950 font-black uppercase tracking-wider text-[10px]">Target Resource Details</p>
                <div className="grid grid-cols-2 gap-2 text-slate-650 font-semibold">
                  <div>
                    <span className="text-slate-400 block text-[9px] uppercase font-black">Name</span>
                    <span className="text-slate-950 font-extrabold">{forceOutTargetName}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[9px] uppercase font-black">Current Status</span>
                    <span className="bg-amber-100 text-amber-900 border border-amber-250 px-1.5 rounded text-[10px] uppercase font-black">
                      {allShifts.find(s => s.id === forceOutShiftId)?.status || 'ACTIVE'}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-slate-400 block text-[9px] uppercase font-black">Active Process at logout</span>
                    <span className="text-slate-950 font-black underline">
                      {(() => {
                        const s = allShifts.find(x => x.id === forceOutShiftId);
                        if (s && s.activities && s.activities.length > 0) {
                          return s.activities[s.activities.length - 1].name;
                        }
                        return 'Unknown Process';
                      })()}
                    </span>
                  </div>
                </div>
              </div>

              {/* Preset Reason Select */}
              <div className="space-y-1.5 text-left">
                <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Select Standard Reason</Label>
                <select
                  value={forceOutReason}
                  onChange={(e) => setForceOutReason(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
                >
                  <option value="Left without logging out">Left without logging out (End of Shift)</option>
                  <option value="Long inactivity / Away from desk">Unscheduled inactivity / Away from desk</option>
                  <option value="System glitch / Hanging session">Technical glitch / Hanging timer session</option>
                  <option value="Disciplinary violation">Disciplinary violation / Policy breach</option>
                  <option value="other">Other (Write custom response below...)</option>
                </select>
              </div>

              {/* Custom Input */}
              {forceOutReason === 'other' && (
                <div className="space-y-1.5 text-left animate-in slide-in-from-top-2 duration-200">
                  <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Custom Override Remarks</Label>
                  <textarea
                    placeholder="Provide explicit reasons for this security clock-out..."
                    value={forceOutCustomReason}
                    onChange={(e) => setForceOutCustomReason(e.target.value)}
                    className="w-full h-20 p-3 rounded-xl border border-slate-200 focus:ring-1 focus:ring-red-500 focus:outline-none text-xs text-slate-900 bg-white shadow-inner font-semibold"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 text-xs font-bold pt-3 border-t">
              <Button variant="ghost" onClick={() => setForceOutShiftId(null)} className="rounded-xl">Cancel</Button>
              <Button 
                className="bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl flex items-center gap-1.5"
                onClick={performAdminClockOut}
              >
                Finalize Force Out
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Custom process delete confirmation overlay modal */}
      {confirmDeleteProcessName && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 text-amber-600">
              <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <AlertCircle size={20} />
              </div>
              <div>
                <h4 className="font-bold text-slate-900 text-sm">Delete Process</h4>
                <p className="text-slate-500 text-xs mt-1">Are you sure you want to delete the process <span className="font-semibold text-slate-900">"{confirmDeleteProcessName}"</span> from the configuration?</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 text-xs font-bold pt-2 border-t">
              <Button variant="ghost" onClick={() => setConfirmDeleteProcessName(null)}>Cancel</Button>
              <Button className="bg-amber-600 hover:bg-amber-700 text-white font-bold" onClick={() => {
                const proc = confirmDeleteProcessName;
                setConfirmDeleteProcessName(null);
                performDeleteProcess(proc);
              }}>Confirm Delete</Button>
            </div>
          </div>
        </div>
      )}

      {/* Dynamic Date Range & Format Select Modal for Admins & Managers */}
      {showExportModal && exportType === 'organization' && (
        <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in duration-200 text-slate-800">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 border-b pb-3">
              <div className="w-10 h-10 rounded-xl bg-sky-50 flex items-center justify-center text-sky-600 shrink-0">
                <FileSpreadsheet size={20} />
              </div>
              <div className="text-left">
                <h4 className="font-extrabold text-slate-900 text-sm uppercase tracking-wide">
                  Export Organization Report
                </h4>
                <p className="text-slate-500 text-[10px] font-bold leading-none mt-1">Specify date range and filter criteria</p>
              </div>
            </div>

            <div className="space-y-4 text-xs font-bold text-slate-700">
              {/* Date Range Preset */}
              <div className="space-y-1.5 text-left">
                <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Date Range Preset</Label>
                <select
                  value={selectedRangePreset}
                  onChange={(e) => {
                    setSelectedRangePreset(e.target.value);
                    if (e.target.value !== 'custom') {
                      setStartDateStr('');
                      setEndDateStr('');
                    }
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-sky-500 cursor-pointer"
                >
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="last7">Last 7 Days</option>
                  <option value="last30">Last 30 Days (Default)</option>
                  <option value="currentMonth">Current Month</option>
                  <option value="previousMonth">Previous Month</option>
                  <option value="custom">Custom Date Range...</option>
                </select>
              </div>

              {/* Custom Date Inputs */}
              {selectedRangePreset === 'custom' && (
                <div className="grid grid-cols-2 gap-3 pt-1 animate-in slide-in-from-top-2 duration-200">
                  <div className="space-y-1.5 text-left">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">Start Date</Label>
                    <Input
                      type="date"
                      value={startDateStr}
                      onChange={(e) => setStartDateStr(e.target.value)}
                      className="border-slate-200 rounded-xl text-xs font-bold p-2.5 w-full bg-slate-50"
                    />
                  </div>
                  <div className="space-y-1.5 text-left">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">End Date</Label>
                    <Input
                      type="date"
                      value={endDateStr}
                      onChange={(e) => setEndDateStr(e.target.value)}
                      className="border-slate-200 rounded-xl text-xs font-bold p-2.5 w-full bg-slate-50"
                    />
                  </div>
                </div>
              )}

              {/* File Format Selection */}
              <div className="space-y-2 text-left">
                <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">File Format</Label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setExportFormat('excel')}
                    className={`p-3 rounded-xl border font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                      exportFormat === 'excel'
                        ? 'border-emerald-500 bg-emerald-50/50 text-emerald-850'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    Excel (.xlsx)
                  </button>
                  <button
                    type="button"
                    onClick={() => setExportFormat('csv')}
                    className={`p-3 rounded-xl border font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                      exportFormat === 'csv'
                        ? 'border-sky-500 bg-sky-50/50 text-sky-850'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-600'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-sky-500" />
                    CSV (.csv)
                  </button>
                </div>
              </div>

              {/* Report Type Selection */}
              <div className="space-y-2 text-left">
                <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none">Report Type</Label>
                <select
                  value={reportType}
                  onChange={(e) => setReportType(e.target.value as any)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-sky-500 cursor-pointer"
                >
                  <option value="summary">Organizational Report</option>
                  <option value="chronological">Chronological Activity</option>
                  {exportFormat === 'excel' && (
                    <option value="both">Both Reports</option>
                  )}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs font-bold pt-3 border-t">
              {isExporting && (
                <div className="w-full space-y-2 py-1 mb-2">
                  <div className="flex justify-between text-xs font-bold text-slate-700">
                    <span>{exportProgressMessage || 'Generating report...'}</span>
                    <span>{exportProgressPercent}%</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                    <div 
                      className="bg-emerald-600 h-full rounded-full transition-all duration-300 ease-out" 
                      style={{ width: `${exportProgressPercent}%` }}
                    />
                  </div>
                </div>
              )}
              <Button variant="ghost" onClick={() => setShowExportModal(false)} disabled={isExporting} className="rounded-xl">Cancel</Button>
              {isExporting ? (
                <Button
                  className="bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-900/30 dark:hover:bg-red-900/50 dark:text-red-400 font-bold rounded-xl cursor-pointer"
                  onClick={cancelExport}
                >
                  Cancel Export
                </Button>
              ) : (
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  onClick={handleAdminGenerateExport}
                  disabled={isExporting}
                >
                  Generate & Export
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Auto Logout Warning Warning Modal overlay */}
      <AnimatePresence>
        {autoLogoutWarning.show && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 10 }}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-2xl max-w-md w-full space-y-6"
            >
              <div className="flex items-center gap-4 text-amber-500">
                <div className="p-3 bg-amber-50 dark:bg-amber-950/40 rounded-full">
                  <AlertCircle size={32} />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                    Inactivity / Shift Warning
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {autoLogoutWarning.reason === 'limit'
                      ? 'You are approaching your 10-hour productive time limit.'
                      : 'Your current session has been idle or active for a long duration.'}
                  </p>
                </div>
              </div>

              <div className="bg-amber-50/50 dark:bg-amber-950/10 border border-amber-100 dark:border-amber-900/20 rounded-2xl p-4 text-center">
                <div className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-widest mb-1">
                  Automatic Clock-out In
                </div>
                <div className="text-4xl font-black font-mono text-slate-800 dark:text-slate-100">
                  {Math.floor(autoLogoutWarning.timeLeft / 60)}:
                  {(autoLogoutWarning.timeLeft % 60).toString().padStart(2, '0')}
                </div>
                <p className="text-[11px] text-slate-400 mt-2">
                  Are you still actively working? Click below to keep your session open.
                </p>
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  className="w-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 font-bold py-2.5 rounded-xl text-xs cursor-pointer animate-in fade-in zoom-in-95 duration-150"
                  onClick={async () => {
                    // Force logout immediately if they choose to log out
                    setAutoLogoutWarning({ show: false, timeLeft: 120, reason: 'limit' });
                    // Trigger manual complete shift
                    const limitMs = getShiftProductiveMs(currentShift!, getLiveTime().getTime());
                    const { activities: updatedActivities, clockOutTime } = truncateShiftToProductiveTime(currentShift!, limitMs);
                    const finalizedShift = {
                      ...currentShift!,
                      activities: updatedActivities,
                      clockOutTime,
                      status: 'COMPLETED' as const,
                      remarks: 'Manually clocked out during warning dialog'
                    };
                    await saveShiftState(finalizedShift);
                    const userRef = doc(db, 'users', user.uid);
                    await setDoc(userRef, {
                      lastLogoutAt: clockOutTime
                    }, { merge: true });
                    setCurrentShift(null);
                    setLocalOwnShift(undefined);
                    localStorage.removeItem('tms_last_active_shift_id');
                    localStorage.removeItem('tms_last_active_shift_json');
                    invalidateShiftCache({
                      userId: user.uid,
                      shiftId: finalizedShift.id,
                      reason: 'warning_dialog_clock_out'
                    });
                    toast.info('Session closed successfully.', { duration: 5000 });
                  }}
                >
                  Clock Out Now
                </Button>
                <Button
                  className="w-full bg-amber-500 hover:bg-amber-600 text-white font-bold py-2.5 rounded-xl text-xs shadow-md shadow-amber-500/10 cursor-pointer animate-in fade-in zoom-in-95 duration-150"
                  onClick={async () => {
                    setLocalSessionExtended(true);
                    setAutoLogoutWarning({ show: false, timeLeft: 120, reason: 'limit' });
                    toast.success('Session extended. You can continue working safely.', { duration: 5000 });
                    
                    const activeShift = currentShiftRef.current;
                    if (activeShift) {
                      const updatedLedger = appendShiftEvent(
                        activeShift.shiftEventLedger,
                        activeShift,
                        {
                          eventType: 'SHIFT_EXTENSION',
                          timestamp: new Date().toISOString(),
                          performedBy: user.name || 'Employee',
                          source: 'TMS',
                          reason: 'User extended shift on warning dialog',
                          oldValue: 'ACTIVE_WARNING',
                          newValue: 'ACTIVE_EXTENDED',
                          remarks: 'Manual shift extension to bypass active limit'
                        }
                      );
                      const updatedShift = {
                        ...activeShift,
                        sessionExtended: true,
                        extended: true,
                        shiftEventLedger: updatedLedger
                      };
                      await saveShiftState(updatedShift);
                    }
                  }}
                >
                  Keep Session Active
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
});

export default React.memo(function TMSView(props: TMSViewProps) {
  const normRoleUser = (props.user?.role || '').toString().toUpperCase().trim();
  const checkIsDashboardUser = (r: string) => {
    const upper = r.toUpperCase().trim();
    const leadKeywords = ['ADMIN', 'MANAGER', 'HEAD', 'HR', 'MIS', 'TL', 'LEAD', 'SME', 'TRAINER', 'EXECUTIVE', 'DIRECTOR', 'VP', 'SUPERVISOR', 'SUPERV', 'EXEC'];
    return leadKeywords.some(k => upper.includes(k));
  };
  const isDashboardUser = checkIsDashboardUser(normRoleUser);

  const teamMemberUids = useMemo(() => {
    if (!props.user || !props.allUsers) return [];
    if (!isDashboardUser) return [props.user.uid];
    const teamUidsSet = getTmsDashboardTeamUids(props.user, props.allUsers);
    const uids = Array.from(teamUidsSet);
    if (!uids.includes(props.user.uid)) uids.push(props.user.uid);
    return uids;
  }, [props.user, props.allUsers, isDashboardUser]);

  return (
    <TMSLiveSessionProvider
      uid={props.user?.uid}
      role={props.user?.role}
      authorizedTeamMemberUids={teamMemberUids}
    >
      <TMSViewContent {...props} />
    </TMSLiveSessionProvider>
  );
});

function LockIcon({ className, size }: { className?: string, size?: number }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width={size || 16} 
      height={size || 16} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      className={className}
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}
