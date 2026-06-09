export enum UserRole {
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
  STL = 'STL',
  OPS_TL = 'OPS_TL',
  SME = 'SME',
  QTL = 'QTL',
  QA = 'QA',
  TEAM_LEAD = 'TEAM_LEAD',
  TRAINER = 'TRAINER',
  TRAINER_TL = 'TRAINER_TL',
  MIS = 'MIS',
  AGENT = 'AGENT',
}

export interface UserProfile {
  uid: string;
  email: string;
  role: string | UserRole;
  name: string; // Legacy field for internal use/fallback
  fullName: string;
  employeeName?: string; // Master field
  employeeId?: string; // Master field
  status: 'Active' | 'Inactive' | string;
  department: string;
  Manager?: string; // Legacy field
  createdAt: any;
  lastLogin?: any;
  lastLoginAt?: any;
  authProvider?: 'google' | 'email';
  isActive?: boolean;
  team?: string;
  teamLeadId?: string;
  teamLeadName?: string;
  teamLeadEmail?: string;
  managerId?: string; // Master field
  managerName?: string; // Master field
  managerEmail?: string;
  mappedManagerId?: string; // Legacy/Auth field
  mappedManagerName?: string; // Legacy/Auth field
  mappedManagerEmail?: string;
  mappedTL?: string;
  mappedQA?: string;
  mappedManager?: string;
  process?: string;
  dateJoined?: string;
  lastUpdated?: string;
}

export enum DisputeStatus {
  NONE = 'None',
  PENDING = 'Pending', // Agent disputed, waiting for QA
  QA_REVIEWED = 'QA Reviewed', // QA commented, waiting for Agent final review
  RESOLVED = 'Resolved', // Agent accepted QA explanation or score was edited
}

export interface DisputeHistory {
  id: string;
  timestamp: any;
  userRole: UserRole;
  userName: string;
  comment: string;
}

export interface AuditRecord {
  id: string;
  taskId: string;
  qvName: string;
  vertical: string;
  sellerId: string;
  categoryGroup: string;
  auditUrl?: string;
  attributesEdited?: number;
  imageReshuffle?: boolean;
  rows: number;
  rowsPassed: number;
  rowsFailed: number;
  compErrorCount: number;
  mpqcErrorCount: number;
  quality: number;
  status: 'Correct' | 'Incorrect' | 'Tech Issue';
  qaComment: string;
  isOnPip?: boolean;
  rowNo?: string;
  errorType: string;
  guideline: string;
  theme: string;
  qaId: string;
  auditDate: any; 
  auditStartTime?: string | null;
  disputeStatus: DisputeStatus;
  disputeHistory: DisputeHistory[];
  agentId: string;
  teamLeadId?: string;
  isAccepted?: boolean;
  isReopened?: boolean;
}

export interface AppConfig {
  errorTypes: string[];
  guidelines: string[];
  themes: string[];
  skipLimit: number;
  minSamplingCount: number;
  systemOverrideRights: boolean;
  kpiTargets: {
    utilization: number;
    attendance: number;
    qaScore: number;
    apt: number;
  };
}

export interface SamplingTask {
  id: string;
  taskId: string;
  qvName: string;
  vertical: string;
  sellerId: string;
  categoryGroup: string;
  auditUrl?: string;
  rows: number;
  rowsPassed: number;
  rowsFailed: number;
  attributesEdited: number;
  imageReshuffle: boolean;
  assignedQaId?: string;
  status: 'Pending' | 'Completed' | 'Skipped';
  sourceFileId: string;
  createdAt: any;
}

export interface QAAlignment {
  qaEmail: string;
  agentName: string;
}

export interface WarningTicket {
  id: string;
  agentId: string;
  agentName?: string; // Optional for legacy/caching
  agentEmail?: string; // Optional for legacy/caching
  employeeId?: string; // Optional for legacy/caching
  process?: string; // Master field
  qaId: string;
  level: '1st' | '2nd' | 'Final' | string; // Warning Type
  remarks: string;
  severity: 'Mild' | 'Moderate' | 'Severe' | 'Critical';
  status: 'Pending' | 'Accepted' | 'Acknowledged' | 'Disputed';
  createdAt: any;
  acceptedAt?: string;
  history?: { action: string; timestamp: string; userRole?: string; userName?: string }[];
  isDeleted?: boolean;
}

export interface ProductionRecord {
  id?: string;
  qvName: string;
  date: string;
  totalRows: number;
  totalTasks: number;
}

export interface AgentKpiRecord {
  id: string;
  agentId: string;
  agentName: string;
  date: string;
  utilization: number;
  attendance: number;
  qaScore: number;
  aptActual: number;
  aptTarget: number;
  timeline?: string;
}

export interface DailyTarget {
  id: string; // "YYYY-MM-DD_agentId"
  date: string; // YYYY-MM-DD
  agentId: string;
  agentName: string;
  process: string;
  productivityTarget: number;
  aptTarget: number; // in mins
  qualityTarget: number; // e.g. 98%
  attendanceTarget: number; // e.g. 95%
  updatedBy: string;
  updatedAt: string;
}

export interface DailyPerformance {
  id: string; // "YYYY-MM-DD_agentId"
  date: string; // YYYY-MM-DD
  agentId: string;
  agentName: string;
  process: string;
  // Snapshot targets
  productivityTarget: number;
  aptTarget: number;
  qualityTarget: number;
  attendanceTarget: number;
  // Actual values
  actualProductivity: number;
  actualApt: 'Excellent' | 'Good' | 'Average' | 'Needs Improvement' | 'Critical';
  actualAptValue?: number; // Numeric in mins
  actualQuality: number;
  actualAttendance: number;
  bonus: number;
  penalty: number;
  remarks?: string;
  // Automatically computed scores
  productivityScore: number;
  aptScore: number;
  attendanceScore: number;
  qualityScore: number;
  finalScore: number;
  rating: string;
  isOverridden: boolean;
  isLocked: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface ScorecardRecord {
  id: string; // "agentId_YYYY-MM"
  agentId: string;
  agentName: string;
  yearMonth: string; // YYYY-MM
  averageScore: number;
  overallRating: string;
  promotionReadiness: number; // percentage 0-100
  pipRecommendation: boolean;
  alertStatus: 'None' | 'Top Performer' | 'Bottom Performer' | 'Critical Attention';
  justification: string;
  selfScorecardComments?: string;
  reviewerComments?: string;
  updatedAt: string;
}

export interface KpiAuditLog {
  id: string;
  targetId: string;
  entityType: 'Target' | 'Performance';
  fieldName: string;
  oldValue: string;
  newValue: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
}

export interface PipRecord {
  id: string;
  agentId: string;
  agentName?: string;
  agentEmail?: string;
  employeeId?: string;
  process?: string;
  initiatorId: string;
  initiatorName: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  qualityTarget: number;
  attendanceTarget: number;
  productivityTarget: number;
  status: 'Initiated' | 'Under Review' | 'Passed' | 'Failed' | 'Extended';
  coachingSupportPlan: string;
  finalComments?: string;
  createdAt: any;
  updatedAt: any;
  checkins: {
    id: string;
    checkinDate: string;
    reviewerName: string;
    metricsAssessment: string;
    actionItems: string;
    agentComments?: string;
    acknowledgedByAgent?: boolean;
    acknowledgedAt?: string;
  }[];
  acknowledgedByAgent?: boolean;
  acknowledgedAt?: string;
  signedAndAcknowledged?: boolean;
  signedAndAcknowledgedAt?: any;
  signedAndAcknowledgedBy?: string;
}




