export interface DailyKpiRecord {
  id: string; // ${reportingDate}_${cleanProcess}
  reportingDate: string; // YYYY-MM-DD
  yearMonth: string; // YYYY-MM
  employeeUid: string;
  employeeEmail: string;
  employeeName: string;
  role: string;
  process: string;
  team?: string;
  totalScore: number;
  kpiRating?: string;
  productivityScore?: number;
  targetProductivity?: number | string;
  actualProductivity?: number | string;
  qualityScore?: number;
  targetQuality?: number | string;
  actualQuality?: number | string;
  attendanceScore?: number;
  targetAttendance?: number | string;
  actualAttendance?: number | string;
  aptScore?: number;
  targetAPT?: number | string;
  actualAPT?: number | string;
  bonus: number;
  penalty: number;
  comments: string;
  rawData?: Record<string, any>;
  uploadedBy: string;
  uploadedAt: string;
}

export interface DailyKpiImportSummary {
  imported: number;
  updated: number;
  skippedDuplicates: number;
  failed: number;
  total: number;
  durationMs?: number;
  recordsPerSecond?: number;
  partitionCounts?: Record<string, number>;
  errors: { rowIndex: number; reason: string; rowData?: Record<string, any> }[];
}

export interface ImportProgressInfo {
  progressPercent: number;
  importedCount: number;
  totalCount: number;
  failedCount: number;
  recordsPerSecond: number;
  estimatedSecondsRemaining: number;
  currentBatch: number;
  totalBatches: number;
  activeWorkers: number;
  statusMessage?: string;
}

export interface DailyKpiParseResult {
  validRecords: DailyKpiRecord[];
  invalidRecords: { rowIndex: number; reason: string; rowData: Record<string, any> }[];
  duplicateCount: number;
  uniqueMonths: string[];
  monthCounts: Record<string, number>;
  processCounts: Record<string, number>;
  totalRows: number;
}

export interface DailyKpiFilterOptions {
  reportingDate?: string;
  process?: string;
  role?: string;
  teamLeadName?: string;
  managerName?: string;
  search?: string;
}

export interface PartitionMetadata {
  yearMonth: string;
  totalRecords: number;
  employeeCount: number;
  lastUploadedAt?: string;
  lastUploadedBy?: string;
  processes?: string[];
  roles?: string[];
}

export interface PartitionEmployee {
  employeeUid: string;
  employeeEmail: string;
  employeeName: string;
  role: string;
  process?: string;
  recordCount: number;
}

