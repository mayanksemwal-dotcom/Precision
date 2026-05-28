export enum UserRole {
  ADMIN = 'ADMIN',
  QA = 'QA',
  TEAM_LEAD = 'TEAM_LEAD',
  AGENT = 'AGENT',
}

export interface UserProfile {
  uid: string;
  email: string;
  role: UserRole;
  team?: string;
  name: string;
  teamLeadId?: string;
  teamLeadName?: string;
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
  qaId: string;
  level: '1st' | '2nd' | 'Final';
  remarks: string;
  createdAt: any;
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


