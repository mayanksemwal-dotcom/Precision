import React, { useState, useMemo } from 'react';
import { 
  FileUp, 
  CheckCircle2, 
  AlertTriangle, 
  X, 
  Download, 
  RefreshCw, 
  FileText, 
  Calendar,
  Layers,
  AlertCircle,
  Database,
  ArrowRight,
  Sparkles,
  Search,
  Check,
  ChevronRight,
  Filter,
  Eye,
  Zap,
  Clock,
  Gauge,
  Cpu
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { UserProfile } from '../../types';
import { DailyKpiRecord, DailyKpiImportSummary, ImportProgressInfo, DailyKpiParseResult } from '../../types/kpiArchive';
import { 
  downloadDailyKpiTemplate, 
  parseAndValidateDailyKpiExcel, 
  importDailyKpiRecords 
} from '../../services/kpiArchiveService';
import { formatKpiNumber } from '../../lib/utils';
import { toast } from 'sonner';

interface DailyKpiUploadModalProps {
  open: boolean;
  onClose: () => void;
  onImportSuccess: (importedMonth?: string) => void;
  user: UserProfile;
  roster: UserProfile[];
}

export default function DailyKpiUploadModal({
  open,
  onClose,
  onImportSuccess,
  user,
  roster
}: DailyKpiUploadModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState<{ percent: number; current: number; total: number }>({
    percent: 0,
    current: 0,
    total: 0
  });

  const [parseData, setParseData] = useState<DailyKpiParseResult | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [teamLeadFilter, setTeamLeadFilter] = useState('');
  const [managerFilter, setManagerFilter] = useState('');
  const [selectedMonthFilter, setSelectedMonthFilter] = useState<string>('all');
  const [previewTab, setPreviewTab] = useState<'valid' | 'invalid'>('valid');
  const [previewLimit, setPreviewLimit] = useState(50);

  const [isImporting, setIsImporting] = useState(false);
  const [importTelemetry, setImportTelemetry] = useState<ImportProgressInfo | null>(null);
  const [importSummary, setImportSummary] = useState<DailyKpiImportSummary | null>(null);

  const resetState = () => {
    setStep(1);
    setSelectedFile(null);
    setIsParsing(false);
    setParseProgress({ percent: 0, current: 0, total: 0 });
    setParseData(null);
    setSearchQuery('');
    setSelectedMonthFilter('all');
    setPreviewTab('valid');
    setPreviewLimit(50);
    setIsImporting(false);
    setImportTelemetry(null);
    setImportSummary(null);
  };

  const handleClose = () => {
    if (isImporting) return;
    resetState();
    onClose();
  };

  const handleFileSelect = async (file: File) => {
    if (!file) return;
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
      toast.error('Please upload a valid Excel (.xlsx, .xls) or CSV file');
      return;
    }

    setSelectedFile(file);
    setIsParsing(true);
    setParseProgress({ percent: 0, current: 0, total: 0 });

    try {
      const result = await parseAndValidateDailyKpiExcel(
        file, 
        roster,
        (percent, current, total) => {
          setParseProgress({ percent, current, total });
        }
      );
      setParseData(result);
      setStep(2);
      toast.success(`Parsed ${result.validRecords.length.toLocaleString()} valid records across ${result.uniqueMonths.length} partition(s).`);
    } catch (err: any) {
      console.error('Error parsing Daily KPI file:', err);
      toast.error(err?.message || 'Failed to parse Excel file. Please verify file headers.');
    } finally {
      setIsParsing(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleExecuteImport = async () => {
    if (!parseData || parseData.validRecords.length === 0) {
      toast.error('No valid records to import.');
      return;
    }

    setIsImporting(true);
    setImportTelemetry({
      progressPercent: 0,
      importedCount: 0,
      totalCount: parseData.validRecords.length,
      failedCount: 0,
      recordsPerSecond: 0,
      estimatedSecondsRemaining: 0,
      currentBatch: 1,
      totalBatches: Math.ceil(parseData.validRecords.length / 475),
      activeWorkers: 6,
      statusMessage: 'Starting parallel write pipelines...'
    });

    try {
      const summary = await importDailyKpiRecords(
        parseData.validRecords,
        user,
        (progressInfo: ImportProgressInfo) => {
          setImportTelemetry(progressInfo);
        },
        { concurrency: 6, batchSize: 475 }
      );

      setImportSummary(summary);
      setStep(3);
      toast.success(`Successfully archived ${summary.imported.toLocaleString()} daily KPI records!`);
      const importedMonth = Object.keys(summary.partitionCounts || {})[0];
      onImportSuccess(importedMonth);
    } catch (err: any) {
      console.error('Import failed:', err);
      toast.error('Failed to import daily records.');
    } finally {
      setIsImporting(false);
    }
  };

  // Filtered valid records with memory efficiency
  const filteredValidRecords = useMemo(() => {
    if (!parseData?.validRecords) return [];
    let list = parseData.validRecords;

    if (selectedMonthFilter !== 'all') {
      list = list.filter(r => r.yearMonth === selectedMonthFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(r => 
        (r.employeeName && r.employeeName.toLowerCase().includes(q)) ||
        (r.employeeEmail && r.employeeEmail.toLowerCase().includes(q)) ||
        (r.process && r.process.toLowerCase().includes(q)) ||
        (r.reportingDate && r.reportingDate.includes(q)) ||
        (r.role && r.role.toLowerCase().includes(q))
      );
    }
    
    if (teamLeadFilter.trim()) {
      const q = teamLeadFilter.toLowerCase().trim();
      list = list.filter(r => (r as any).teamLeadName?.toLowerCase().includes(q));
    }
    
    if (managerFilter.trim()) {
      const q = managerFilter.toLowerCase().trim();
      list = list.filter(r => (r as any).managerName?.toLowerCase().includes(q));
    }

    return list;
  }, [parseData, selectedMonthFilter, searchQuery, teamLeadFilter, managerFilter]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="sm:max-w-5xl md:max-w-6xl max-w-[96vw] w-full max-h-[92vh] flex flex-col p-0 overflow-hidden bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-2xl rounded-3xl">
        {/* Header */}
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white px-6 py-5 border-b border-indigo-900/50 shrink-0">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-600/80 border border-indigo-400/40 flex items-center justify-center text-white shrink-0">
                <Database size={20} />
              </div>
              <div>
                <DialogTitle className="text-lg font-black tracking-tight text-white flex items-center gap-2">
                  <span>Day-Wise KPI Archive Upload</span>
                  <span className="px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-mono text-[10px] uppercase font-bold border border-indigo-400/30">
                    High-Capacity Engine (1Lakh+ Ready)
                  </span>
                </DialogTitle>
                <DialogDescription className="text-xs text-slate-300 mt-0.5">
                  Import day-to-day performance records. Uses concurrent batch pipelines and zero-shift date mapping.
                </DialogDescription>
              </div>
            </div>

            <Button
              onClick={downloadDailyKpiTemplate}
              variant="outline"
              size="sm"
              className="bg-white/10 hover:bg-white/20 text-white border-white/20 text-xs gap-1.5 shrink-0 self-start sm:self-auto"
            >
              <Download size={14} />
              <span>Sample Template</span>
            </Button>
          </div>

          {/* Stepper tracker */}
          <div className="flex items-center gap-3 mt-4 pt-3 border-t border-indigo-900/40 text-xs overflow-x-auto">
            <div className={`flex items-center gap-1.5 font-bold whitespace-nowrap ${step >= 1 ? 'text-white' : 'text-slate-500'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${step >= 1 ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-400'}`}>1</span>
              <span>Upload File</span>
            </div>
            <ArrowRight size={12} className="text-slate-600 shrink-0" />
            <div className={`flex items-center gap-1.5 font-bold whitespace-nowrap ${step >= 2 ? 'text-white' : 'text-slate-500'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${step >= 2 ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-400'}`}>2</span>
              <span>Validate & Preview ({parseData?.validRecords.length ? parseData.validRecords.length.toLocaleString() : 0})</span>
            </div>
            <ArrowRight size={12} className="text-slate-600 shrink-0" />
            <div className={`flex items-center gap-1.5 font-bold whitespace-nowrap ${step === 3 ? 'text-white' : 'text-slate-500'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${step === 3 ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-400'}`}>3</span>
              <span>Import Summary</span>
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto min-h-0 p-6">
          {/* STEP 1: Upload Dropzone */}
          {step === 1 && (
            <div className="flex flex-col gap-4">
              <div
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                className="border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-500 rounded-2xl p-10 text-center transition-all bg-slate-50/50 dark:bg-slate-950/50 flex flex-col items-center justify-center cursor-pointer group"
                onClick={() => !isParsing && document.getElementById('daily-kpi-file-input')?.click()}
              >
                <input
                  id="daily-kpi-file-input"
                  type="file"
                  accept=".xlsx, .xls, .csv"
                  className="hidden"
                  disabled={isParsing}
                  onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                />

                <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform shadow-xs">
                  {isParsing ? <RefreshCw className="animate-spin" size={32} /> : <FileUp size={32} />}
                </div>

                <h4 className="font-extrabold text-slate-900 dark:text-white text-base">
                  {isParsing ? 'Processing Excel File...' : 'Choose or drag & drop Daily KPI Excel file'}
                </h4>
                
                {isParsing ? (
                  <div className="w-full max-w-md mt-4 space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono text-indigo-600 dark:text-indigo-400 font-bold">
                      <span>Parsing & standardizing rows...</span>
                      <span>{parseProgress.current > 0 ? `${parseProgress.current.toLocaleString()} / ${parseProgress.total.toLocaleString()} rows (${parseProgress.percent}%)` : 'Initializing workbook...'}</span>
                    </div>
                    <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-indigo-600 h-2 rounded-full transition-all duration-200"
                        style={{ width: `${parseProgress.percent}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md">
                    Supports high-volume datasets (100k+ rows). Supports DD-MM-YYYY, DD-MMM-YYYY, YYYY-MM-DD, and Excel serial formats without timezone skew.
                  </p>
                )}

                {!isParsing && (
                  <div className="mt-4 flex items-center gap-2">
                    <Button size="sm" className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-5 py-2.5 rounded-xl">
                      Browse File
                    </Button>
                  </div>
                )}
              </div>

              {/* Optimization and Architecture Highlights */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-indigo-50/60 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl p-3.5 text-xs text-slate-600 dark:text-slate-300 flex items-start gap-2.5">
                  <Zap size={16} className="text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-slate-900 dark:text-white">Parallel Concurrency:</span> Batches of 475 records are written simultaneously across 6 concurrent worker streams with automatic exponential retry backoff.
                  </div>
                </div>

                <div className="bg-indigo-50/60 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl p-3.5 text-xs text-slate-600 dark:text-slate-300 flex items-start gap-2.5">
                  <Calendar size={16} className="text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-slate-900 dark:text-white">Accurate Partitioning:</span> Zero-shift parsing accurately preserves day & month boundaries (e.g. 01-04-2026 accurately maps to 2026-04).
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: Preview & Validation */}
          {step === 2 && parseData && (
            <div className="flex flex-col gap-4">
              {/* Stat Badges */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div 
                  onClick={() => setPreviewTab('valid')}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    previewTab === 'valid'
                      ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-500 shadow-xs'
                      : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 hover:border-emerald-300'
                  }`}
                >
                  <div className="text-[11px] font-bold text-emerald-800 dark:text-emerald-400 uppercase flex items-center justify-between">
                    <span>Valid Records</span>
                    {previewTab === 'valid' && <Check size={14} />}
                  </div>
                  <div className="text-2xl font-black font-mono text-emerald-700 dark:text-emerald-300 mt-0.5">
                    {parseData.validRecords.length.toLocaleString()}
                  </div>
                </div>

                <div 
                  onClick={() => setPreviewTab('invalid')}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    previewTab === 'invalid'
                      ? 'bg-rose-50 dark:bg-rose-950/50 border-rose-500 shadow-xs'
                      : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 hover:border-rose-300'
                  }`}
                >
                  <div className="text-[11px] font-bold text-rose-800 dark:text-rose-400 uppercase flex items-center justify-between">
                    <span>Invalid Rows</span>
                    {previewTab === 'invalid' && <Check size={14} />}
                  </div>
                  <div className="text-2xl font-black font-mono text-rose-700 dark:text-rose-300 mt-0.5">
                    {parseData.invalidRecords.length.toLocaleString()}
                  </div>
                </div>

                <div className="bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900/50 p-3.5 rounded-xl">
                  <div className="text-[11px] font-bold text-indigo-800 dark:text-indigo-400 uppercase">Partitions Detected</div>
                  <div className="text-xs font-mono font-bold text-indigo-700 dark:text-indigo-300 mt-1 truncate" title={parseData.uniqueMonths.join(', ')}>
                    {parseData.uniqueMonths.length} Month{parseData.uniqueMonths.length !== 1 ? 's' : ''} ({parseData.uniqueMonths.join(', ') || 'Current'})
                  </div>
                </div>

                <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 p-3.5 rounded-xl">
                  <div className="text-[11px] font-bold text-amber-800 dark:text-amber-400 uppercase">Duplicate Keys</div>
                  <div className="text-2xl font-black font-mono text-amber-700 dark:text-amber-300 mt-0.5">
                    {parseData.duplicateCount.toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Invalid Rows Box */}
              {previewTab === 'invalid' && parseData.invalidRecords.length > 0 && (
                <div className="bg-rose-50/80 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 rounded-2xl p-4 text-xs text-rose-900 dark:text-rose-200 flex flex-col gap-2.5">
                  <div className="font-bold flex items-center gap-2">
                    <AlertTriangle size={16} className="text-rose-600" />
                    <span>{parseData.invalidRecords.length} row(s) failed validation and will be omitted from import:</span>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                    {parseData.invalidRecords.slice(0, 100).map((inv, idx) => (
                      <div key={`inv-row-${inv.rowIndex}-${idx}`} className="bg-white/80 dark:bg-slate-900/80 border border-rose-200/60 dark:border-rose-900/40 rounded-lg p-2 font-mono text-[11px] flex items-center justify-between">
                        <span><strong className="text-rose-700">Row {inv.rowIndex}:</strong> {inv.reason}</span>
                        <span className="text-[10px] text-slate-500">{JSON.stringify(inv.rowData).slice(0, 60)}...</span>
                      </div>
                    ))}
                    {parseData.invalidRecords.length > 100 && (
                      <div className="text-center font-bold text-rose-600 py-1">
                        + {parseData.invalidRecords.length - 100} more invalid rows omitted from view
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Valid Data Controls & Preview */}
              {previewTab === 'valid' && (
                <>
                  {/* Search and Partition Filter Bar */}
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-slate-50 dark:bg-slate-950/60 p-3 rounded-2xl border border-slate-200 dark:border-slate-800">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                      <Input
                        placeholder="Search employee, email, process, or date..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9 h-9 text-xs bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl"
                      />
                      {searchQuery && (
                        <button 
                          onClick={() => setSearchQuery('')} 
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <Input
                      placeholder="Filter by Team Lead..."
                      value={teamLeadFilter}
                      onChange={(e) => setTeamLeadFilter(e.target.value)}
                      className="h-9 text-xs bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl"
                    />
                    <Input
                      placeholder="Filter by Manager..."
                      value={managerFilter}
                      onChange={(e) => setManagerFilter(e.target.value)}
                      className="h-9 text-xs bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl"
                    />

                    {/* Partition Filter Chips */}
                    {parseData.uniqueMonths.length > 1 && (
                      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 text-xs">
                        <span className="text-slate-400 font-bold text-[11px] shrink-0">Partition:</span>
                        <button
                          onClick={() => setSelectedMonthFilter('all')}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
                            selectedMonthFilter === 'all'
                              ? 'bg-indigo-600 text-white'
                              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100'
                          }`}
                        >
                          All ({parseData.validRecords.length.toLocaleString()})
                        </button>
                        {parseData.uniqueMonths.map(m => {
                          const count = parseData.monthCounts?.[m] || parseData.validRecords.filter(r => r.yearMonth === m).length;
                          return (
                            <button
                              key={m}
                              onClick={() => setSelectedMonthFilter(m)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition-colors whitespace-nowrap ${
                                selectedMonthFilter === m
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100'
                              }`}
                            >
                              {m} ({count.toLocaleString()})
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Data Preview Table */}
                  <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-2xs">
                    <div className="overflow-x-auto max-h-72 overflow-y-auto">
                      <Table className="w-full">
                        <TableHeader className="bg-slate-100/80 dark:bg-slate-950 sticky top-0 z-10">
                          <TableRow className="text-[11px] border-b border-slate-200 dark:border-slate-800">
                            <TableHead className="font-bold whitespace-nowrap">Date</TableHead>
                            <TableHead className="font-bold whitespace-nowrap">Employee Details</TableHead>
                            <TableHead className="font-bold whitespace-nowrap">Process & Role</TableHead>
                            <TableHead className="font-bold whitespace-nowrap text-right">KPI Score</TableHead>
                            <TableHead className="font-bold whitespace-nowrap text-right">Productivity</TableHead>
                            <TableHead className="font-bold whitespace-nowrap text-right">Quality</TableHead>
                            <TableHead className="font-bold whitespace-nowrap text-right">Attendance</TableHead>
                            <TableHead className="font-bold whitespace-nowrap text-right">APT</TableHead>
                            <TableHead className="font-bold whitespace-nowrap text-right">Bonus / Deduction</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredValidRecords.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={9} className="text-center py-8 text-slate-400 text-xs">
                                No matching records found for "{searchQuery}".
                              </TableCell>
                            </TableRow>
                          ) : (
                            filteredValidRecords.slice(0, previewLimit).map((rec, i) => (
                              <TableRow key={`${rec.employeeEmail || rec.employeeUid}_${rec.reportingDate}_${rec.process}_${rec.id}_${i}`} className="text-xs hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors">
                                <TableCell className="font-mono font-bold whitespace-nowrap text-slate-800 dark:text-slate-200">
                                  {rec.reportingDate}
                                </TableCell>
                                <TableCell className="min-w-[180px]">
                                  <div className="font-bold text-slate-900 dark:text-white leading-tight">{rec.employeeName}</div>
                                  <div className="text-[11px] text-slate-500 font-mono truncate max-w-[200px]">{rec.employeeEmail}</div>
                                </TableCell>
                                <TableCell className="min-w-[160px]">
                                  <div className="font-semibold text-slate-800 dark:text-slate-200">{rec.process}</div>
                                  <div className="text-[10px] text-indigo-600 dark:text-indigo-400 font-bold uppercase">{rec.role}</div>
                                </TableCell>
                                <TableCell className="font-mono font-extrabold text-indigo-600 dark:text-indigo-400 text-right whitespace-nowrap">
                                  {formatKpiNumber(rec.totalScore)}
                                </TableCell>
                                <TableCell className="font-mono text-[11px] text-right whitespace-nowrap">
                                  {formatKpiNumber(rec.productivityScore)}
                                </TableCell>
                                <TableCell className="font-mono text-[11px] text-right whitespace-nowrap">
                                  {formatKpiNumber(rec.qualityScore)}
                                </TableCell>
                                <TableCell className="font-mono text-[11px] text-right whitespace-nowrap">
                                  {formatKpiNumber(rec.attendanceScore)}
                                </TableCell>
                                <TableCell className="font-mono text-[11px] text-right whitespace-nowrap">
                                  {formatKpiNumber(rec.aptScore)}
                                </TableCell>
                                <TableCell className="font-mono text-[11px] text-right whitespace-nowrap">
                                  <span className="text-emerald-600">+{formatKpiNumber(rec.bonus, '0.00')}</span> / <span className="text-rose-600">-{formatKpiNumber(rec.penalty, '0.00')}</span>
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {/* Pagination / Record limit count */}
                  <div className="flex items-center justify-between text-xs text-slate-500 px-1">
                    <div>
                      Showing <strong className="text-slate-900 dark:text-white">{Math.min(filteredValidRecords.length, previewLimit).toLocaleString()}</strong> of <strong className="text-slate-900 dark:text-white">{filteredValidRecords.length.toLocaleString()}</strong> {selectedMonthFilter !== 'all' ? `records in ${selectedMonthFilter}` : 'total records'}
                    </div>

                    {filteredValidRecords.length > previewLimit && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPreviewLimit(prev => prev + 100)}
                        className="text-xs text-indigo-600 hover:text-indigo-700 font-bold"
                      >
                        Load More (+100)
                      </Button>
                    )}
                  </div>
                </>
              )}

              {/* Progress Live Telemetry if importing */}
              {isImporting && importTelemetry && (
                <div className="flex flex-col gap-3 pt-2 bg-gradient-to-br from-indigo-950 via-slate-900 to-indigo-950 text-white p-5 rounded-2xl border border-indigo-700/50 shadow-xl">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Zap className="text-amber-400 animate-pulse" size={18} />
                      <span className="text-sm font-black tracking-tight">
                        Writing High-Volume Batches to Firestore
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs font-mono">
                      <span className="bg-indigo-500/20 text-indigo-300 px-2.5 py-1 rounded-lg border border-indigo-400/30 flex items-center gap-1.5">
                        <Cpu size={12} />
                        {importTelemetry.activeWorkers} Parallel Streams
                      </span>
                      <span className="text-amber-400 font-bold text-sm">
                        {importTelemetry.progressPercent}%
                      </span>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full bg-slate-800 rounded-full h-3 overflow-hidden p-0.5 border border-slate-700">
                    <div
                      className="bg-gradient-to-r from-indigo-500 via-blue-500 to-emerald-400 h-2 rounded-full transition-all duration-200"
                      style={{ width: `${importTelemetry.progressPercent}%` }}
                    />
                  </div>

                  {/* Telemetry Metrics */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                    <div className="bg-white/5 border border-white/10 rounded-xl p-2.5">
                      <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
                        <span>Records Committed</span>
                      </div>
                      <div className="text-base font-black font-mono text-emerald-400 mt-0.5">
                        {importTelemetry.importedCount.toLocaleString()} <span className="text-[11px] text-slate-400 font-normal">/ {importTelemetry.totalCount.toLocaleString()}</span>
                      </div>
                    </div>

                    <div className="bg-white/5 border border-white/10 rounded-xl p-2.5">
                      <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
                        <Gauge size={12} className="text-blue-400" />
                        <span>Throughput</span>
                      </div>
                      <div className="text-base font-black font-mono text-blue-300 mt-0.5">
                        {importTelemetry.recordsPerSecond.toLocaleString()} <span className="text-[11px] text-slate-400 font-normal">rec/sec</span>
                      </div>
                    </div>

                    <div className="bg-white/5 border border-white/10 rounded-xl p-2.5">
                      <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
                        <Clock size={12} className="text-amber-400" />
                        <span>Est. Remaining</span>
                      </div>
                      <div className="text-base font-black font-mono text-amber-300 mt-0.5">
                        ~{importTelemetry.estimatedSecondsRemaining}s
                      </div>
                    </div>

                    <div className="bg-white/5 border border-white/10 rounded-xl p-2.5">
                      <div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1">
                        <Layers size={12} className="text-indigo-400" />
                        <span>Batch Index</span>
                      </div>
                      <div className="text-base font-black font-mono text-indigo-300 mt-0.5">
                        {importTelemetry.currentBatch} <span className="text-[11px] text-slate-400 font-normal">/ {importTelemetry.totalBatches}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 3: Summary */}
          {step === 3 && importSummary && (
            <div className="flex flex-col items-center justify-center text-center p-4 gap-5">
              <div className="w-16 h-16 rounded-2xl bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shadow-lg border border-emerald-500/20">
                <CheckCircle2 size={36} />
              </div>

              <div>
                <h3 className="text-xl font-black text-slate-900 dark:text-white">Archive Upload Completed</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md">
                  All daily KPI records have been processed and partitioned across their respective monthly databases.
                </p>
              </div>

              {/* Summary Metric Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-2xl my-1">
                <div className="bg-slate-50 dark:bg-slate-950 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] font-bold text-slate-500 uppercase">Total Processed</div>
                  <div className="text-xl font-black font-mono mt-0.5 text-slate-900 dark:text-white">{importSummary.total.toLocaleString()}</div>
                </div>

                <div className="bg-emerald-50 dark:bg-emerald-950/40 p-3.5 rounded-2xl border border-emerald-200 dark:border-emerald-900/50">
                  <div className="text-[10px] font-bold text-emerald-600 uppercase">Imported</div>
                  <div className="text-xl font-black font-mono text-emerald-600 mt-0.5">{importSummary.imported.toLocaleString()}</div>
                </div>

                <div className="bg-blue-50 dark:bg-blue-950/40 p-3.5 rounded-2xl border border-blue-200 dark:border-blue-900/50">
                  <div className="text-[10px] font-bold text-blue-600 uppercase">Average Speed</div>
                  <div className="text-xl font-black font-mono text-blue-600 mt-0.5">
                    {importSummary.recordsPerSecond ? `${importSummary.recordsPerSecond.toLocaleString()} r/s` : 'Instant'}
                  </div>
                </div>

                <div className="bg-indigo-50 dark:bg-indigo-950/40 p-3.5 rounded-2xl border border-indigo-200 dark:border-indigo-900/50">
                  <div className="text-[10px] font-bold text-indigo-600 uppercase">Duration</div>
                  <div className="text-xl font-black font-mono text-indigo-600 mt-0.5">
                    {importSummary.durationMs ? `${(importSummary.durationMs / 1000).toFixed(1)}s` : '<1s'}
                  </div>
                </div>
              </div>

              {/* Partition Breakdown Pills */}
              {importSummary.partitionCounts && Object.keys(importSummary.partitionCounts).length > 0 && (
                <div className="w-full max-w-2xl bg-slate-50 dark:bg-slate-950/60 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 text-left">
                  <div className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-1.5">
                    <Calendar size={14} className="text-indigo-600" />
                    <span>Partition Breakdown:</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(importSummary.partitionCounts).map(([month, count]) => (
                      <div key={month} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5 text-xs font-mono flex items-center gap-2">
                        <span className="font-bold text-indigo-600 dark:text-indigo-400">{month}</span>
                        <span className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full text-[11px] font-bold text-slate-700 dark:text-slate-300">
                          {count.toLocaleString()} records
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Any Errors */}
              {importSummary.errors && importSummary.errors.length > 0 && (
                <div className="w-full max-w-2xl bg-rose-50 dark:bg-rose-950/30 p-4 rounded-2xl border border-rose-200 dark:border-rose-900/50 text-left text-xs text-rose-800 dark:text-rose-300">
                  <div className="font-bold flex items-center gap-1.5 mb-2">
                    <AlertCircle size={14} />
                    <span>{importSummary.errors.length} batch error(s) occurred:</span>
                  </div>
                  <div className="space-y-1">
                    {importSummary.errors.map((e, idx) => (
                      <div key={`err-${e.rowIndex}-${idx}`} className="font-mono text-[11px]">
                        Batch starting row {e.rowIndex}: {e.reason}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="bg-slate-50 dark:bg-slate-950 px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
          <Button
            onClick={handleClose}
            variant="ghost"
            size="sm"
            disabled={isImporting}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {step === 3 ? 'Close' : 'Cancel'}
          </Button>

          <div className="flex items-center gap-2">
            {step === 2 && (
              <>
                <Button
                  onClick={() => setStep(1)}
                  variant="outline"
                  size="sm"
                  disabled={isImporting}
                  className="text-xs font-semibold"
                >
                  Back
                </Button>
                <Button
                  onClick={handleExecuteImport}
                  disabled={isImporting || !parseData || parseData.validRecords.length === 0}
                  size="sm"
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-6 py-2 rounded-xl shadow-md gap-2"
                >
                  {isImporting ? (
                    <>
                      <RefreshCw size={14} className="animate-spin" />
                      <span>Writing Batches...</span>
                    </>
                  ) : (
                    <>
                      <Zap size={14} className="text-amber-300" />
                      <span>Commit {parseData?.validRecords.length.toLocaleString() || 0} Records</span>
                    </>
                  )}
                </Button>
              </>
            )}

            {step === 3 && (
              <Button
                onClick={handleClose}
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-6 py-2 rounded-xl"
              >
                Done
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

