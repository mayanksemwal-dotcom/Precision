import React, { useState } from 'react';
import { 
  FileUp, 
  CheckCircle2, 
  AlertTriangle, 
  X, 
  Download, 
  RefreshCw, 
  FileText, 
  ChevronRight, 
  AlertCircle,
  UploadCloud,
  Check,
  Ban
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { KPIScorecard, UserProfile } from '../../types';
import { formatPeriodForDisplay, formatKpiNumber } from '../../lib/utils';
import { 
  downloadKpiTemplate, 
  parseAndValidateKpiExcel, 
  importKpiScorecards, 
  KpiParseResult 
} from '../../services/kpiService';
import { toast } from 'sonner';

interface KpiUploadModalProps {
  open: boolean;
  onClose: () => void;
  onImportSuccess: () => void;
  user: UserProfile;
  roster: UserProfile[];
}

export default function KpiUploadModal({
  open,
  onClose,
  onImportSuccess,
  user,
  roster,
}: KpiUploadModalProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseResult, setParseResult] = useState<KpiParseResult | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileSelect = async (file: File) => {
    if (!file) return;
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
      toast.error('Please select a valid Excel (.xlsx, .xls) or CSV file');
      return;
    }

    setSelectedFile(file);
    setIsParsing(true);
    setStep(2); // Preview step

    try {
      const result = await parseAndValidateKpiExcel(file, roster);
      setParseResult(result);
    } catch (err) {
      console.error('Failed to parse KPI Excel:', err);
      toast.error('Failed to parse file. Please verify column structure.');
      setStep(1);
    } finally {
      setIsParsing(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleRunValidation = () => {
    if (!parseResult) return;
    setStep(4); // Summary step
  };

  const handleExecuteImport = async () => {
    if (!parseResult || parseResult.validRecords.length === 0) {
      toast.error('No valid records to import.');
      return;
    }

    setIsImporting(true);
    setStep(5);

    try {
      const count = await importKpiScorecards(parseResult.validRecords, user);
      toast.success(`Successfully imported ${count} KPI scorecard(s)!`);
      onImportSuccess();
      handleResetAndClose();
    } catch (err) {
      console.error('Import error:', err);
      toast.error('An error occurred while importing KPI records.');
      setStep(4);
    } finally {
      setIsImporting(false);
    }
  };

  const handleResetAndClose = () => {
    setStep(1);
    setSelectedFile(null);
    setParseResult(null);
    setIsParsing(false);
    setIsImporting(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleResetAndClose()}>
      <DialogContent className="sm:max-w-[950px] w-full h-[85vh] max-h-[85vh] flex flex-col p-8 overflow-hidden bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-2xl rounded-3xl">
        {/* Header */}
        <DialogHeader className="border-b border-slate-100 dark:border-slate-800 pb-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2.5 bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 rounded-xl border border-indigo-100 dark:border-indigo-900/50 shadow-sm shrink-0">
                <FileUp size={20} />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-base font-bold text-slate-900 dark:text-white tracking-tight truncate">
                  Upload KPI Scorecard (Excel)
                </DialogTitle>
                <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  Import pre-calculated monthly employee KPI scores directly from Excel sheets with multi-rank support
                </DialogDescription>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadKpiTemplate}
              className="text-xs font-bold gap-1.5 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 px-3 py-1.5 shrink-0"
            >
              <Download size={14} />
              <span>Download Template</span>
            </Button>
          </div>

          {/* Stepper Wizard Progress Header */}
          <div className="grid grid-cols-4 gap-2 mt-4">
            <div className={`h-1.5 rounded-full transition-all ${step >= 1 ? 'bg-indigo-600 shadow-sm shadow-indigo-500/30' : 'bg-slate-200 dark:bg-slate-800'}`} />
            <div className={`h-1.5 rounded-full transition-all ${step >= 2 ? 'bg-indigo-600 shadow-sm shadow-indigo-500/30' : 'bg-slate-200 dark:bg-slate-800'}`} />
            <div className={`h-1.5 rounded-full transition-all ${step >= 4 ? 'bg-indigo-600 shadow-sm shadow-indigo-500/30' : 'bg-slate-200 dark:bg-slate-800'}`} />
            <div className={`h-1.5 rounded-full transition-all ${step >= 5 ? 'bg-emerald-600 shadow-sm shadow-emerald-500/30' : 'bg-slate-200 dark:bg-slate-800'}`} />
          </div>
        </DialogHeader>

        {/* Modal Body Content */}
        <div className="flex-grow overflow-y-auto py-4">
          {/* STEP 1: Upload File */}
          {step === 1 && (
            <div className="flex flex-col items-center justify-center gap-4 py-4">
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`w-full max-w-4xl p-8 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-3 transition-all text-center cursor-pointer shadow-sm ${
                  isDragging
                    ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/30 scale-[1.01]'
                    : 'border-slate-300 dark:border-slate-700 hover:border-indigo-400 dark:hover:border-indigo-500 bg-slate-50/60 dark:bg-slate-900/60'
                }`}
                onClick={() => document.getElementById('kpi-file-input')?.click()}
              >
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-950/80 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shadow-md">
                  <UploadCloud size={28} />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white text-sm tracking-tight">
                    Drag and drop your KPI Excel file here
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Supports <span className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">.xlsx, .xls, .csv</span> formats
                  </p>
                </div>
                <Button variant="secondary" size="sm" className="mt-1 text-xs font-bold gap-1.5 px-4 py-2 shadow-sm">
                  <FileText size={14} />
                  <span>Browse File</span>
                </Button>
                <input
                  id="kpi-file-input"
                  type="file"
                  accept=".xlsx, .xls, .csv"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      handleFileSelect(e.target.files[0]);
                    }
                  }}
                />
              </div>

              {/* Format Column Checklist Notice */}
              <div className="max-w-4xl w-full bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/50 rounded-xl p-3.5 text-xs text-indigo-900 dark:text-indigo-200 shadow-sm">
                <div className="font-bold flex items-center gap-1.5 mb-1.5 text-indigo-700 dark:text-indigo-400 text-xs">
                  <AlertCircle size={14} />
                  <span>Required Excel Column Headers:</span>
                </div>
                <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300 font-mono">
                  Reporting Period, Employee Email, Role, Process Name, Target Productivity, Actual Productivity, Target Quality, Actual Quality, Target Attendance, Actual Attendance, Target APT, Actual APT, Bonus, Penalty, Comments, Productivity Score, Quality Score, Attendance Score, APT Score, Total Score, Process Rank, Role Rank, Organization Rank.
                </p>
              </div>
            </div>
          )}

          {/* STEP 2 & 3: File Parse & Preview Table */}
          {(step === 2 || step === 3) && (
            <div className="flex flex-col gap-4">
              {isParsing ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-slate-500">
                  <RefreshCw size={28} className="animate-spin text-indigo-600" />
                  <p className="text-sm font-medium">Parsing and indexing Excel rows...</p>
                </div>
              ) : parseResult ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between bg-slate-100 dark:bg-slate-800/60 p-3 rounded-xl border border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-2">
                      <FileText size={16} className="text-indigo-500" />
                      <span className="font-bold text-xs text-slate-800 dark:text-slate-200 truncate max-w-xs">
                        {selectedFile?.name}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-400 font-mono text-[11px] font-bold">
                        {parseResult.totalRecords} Rows Parsed
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep(1)}
                      className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                    >
                      Change File
                    </Button>
                  </div>

                  <div className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    Data Preview (First 5 Rows):
                  </div>

                  {/* Preview Table */}
                  <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto max-h-[42vh]">
                    <Table>
                      <TableHeader className="bg-slate-50 dark:bg-slate-900 sticky top-0">
                        <TableRow className="text-[11px]">
                          <TableHead className="font-bold">Period</TableHead>
                          <TableHead className="font-bold">Employee Email</TableHead>
                          <TableHead className="font-bold">Process</TableHead>
                          <TableHead className="font-bold">Total Score</TableHead>
                          <TableHead className="font-bold">Process Rank</TableHead>
                          <TableHead className="font-bold">Role Rank</TableHead>
                          <TableHead className="font-bold">Org Rank</TableHead>
                          <TableHead className="font-bold">Bonus / Penalty</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parseResult.validRecords.slice(0, 5).concat(
                          parseResult.invalidRecords.slice(0, 5).map(inv => ({
                            id: `inv-${inv.rowIndex}`,
                            reportingPeriod: inv.period,
                            employeeEmail: inv.email,
                            process: String(inv.rawData['Process Name'] || inv.rawData['Process'] || '-'),
                            totalScore: Number(inv.rawData['Total Score'] || 0),
                            processRank: inv.rawData['Process Rank'] || '-',
                            roleRank: inv.rawData['Role Rank'] || '-',
                            organizationRank: inv.rawData['Organization Rank'] || inv.rawData['Rank'] || '-',
                            bonus: Number(inv.rawData['Bonus'] || 0),
                            penalty: Number(inv.rawData['Penalty'] || 0),
                          } as any))
                        ).map((row, idx) => (
                          <TableRow key={idx} className="text-xs">
                            <TableCell className="font-mono font-medium">{formatPeriodForDisplay(row.reportingPeriod)}</TableCell>
                            <TableCell className="font-medium text-slate-800 dark:text-slate-200">{row.employeeEmail}</TableCell>
                            <TableCell>{row.process}</TableCell>
                            <TableCell className="font-bold text-indigo-600 dark:text-indigo-400">{formatKpiNumber(row.totalScore)}</TableCell>
                            <TableCell className="font-mono font-bold text-slate-700 dark:text-slate-300">#{row.processRank ?? '-'}</TableCell>
                            <TableCell className="font-mono font-bold text-slate-700 dark:text-slate-300">#{row.roleRank ?? '-'}</TableCell>
                            <TableCell className="font-mono font-bold text-amber-600 dark:text-amber-400">#{row.organizationRank ?? row.rank ?? '-'}</TableCell>
                            <TableCell className="font-mono text-[11px]">
                              <span className="text-emerald-600 dark:text-emerald-400">+{formatKpiNumber(row.bonus, '0.00')}</span>
                              {' / '}
                              <span className="text-rose-600 dark:text-rose-400">-{formatKpiNumber(row.penalty, '0.00')}</span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* STEP 4: Validation Summary */}
          {step === 4 && parseResult && (
            <div className="flex flex-col gap-4">
              {/* Summary Metric Cards */}
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex flex-col gap-1">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Total Records</span>
                  <span className="text-xl font-black text-slate-800 dark:text-white font-mono">
                    {parseResult.summary.total}
                  </span>
                </div>
                <div className="p-3.5 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/40 flex flex-col gap-1">
                  <span className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-1">
                    <CheckCircle2 size={13} />
                    <span>Valid Records</span>
                  </span>
                  <span className="text-xl font-black text-emerald-700 dark:text-emerald-400 font-mono">
                    {parseResult.summary.valid}
                  </span>
                </div>
                <div className="p-3.5 rounded-xl bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 flex flex-col gap-1">
                  <span className="text-[11px] font-bold text-rose-700 dark:text-rose-400 uppercase tracking-wider flex items-center gap-1">
                    <AlertTriangle size={13} />
                    <span>Invalid Records</span>
                  </span>
                  <span className="text-xl font-black text-rose-700 dark:text-rose-400 font-mono">
                    {parseResult.summary.invalid}
                  </span>
                </div>
              </div>

              {/* Invalid Records List if Any */}
              {parseResult.invalidRecords.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-bold text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
                    <Ban size={14} />
                    <span>Validation Errors ({parseResult.invalidRecords.length} rows skipped):</span>
                  </div>
                  <div className="border border-rose-200 dark:border-rose-900/40 rounded-xl overflow-x-auto max-h-[35vh] bg-rose-50/30 dark:bg-rose-950/10 p-2">
                    <Table>
                      <TableHeader>
                        <TableRow className="text-[10px]">
                          <TableHead className="font-bold text-rose-700 dark:text-rose-400">Row #</TableHead>
                          <TableHead className="font-bold text-rose-700 dark:text-rose-400">Email</TableHead>
                          <TableHead className="font-bold text-rose-700 dark:text-rose-400">Reasons</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parseResult.invalidRecords.map((inv, idx) => (
                          <TableRow key={idx} className="text-xs">
                            <TableCell className="font-mono font-bold text-rose-600 dark:text-rose-400">
                              Row {inv.rowIndex}
                            </TableCell>
                            <TableCell className="font-mono text-slate-700 dark:text-slate-300">
                              {inv.email}
                            </TableCell>
                            <TableCell className="text-rose-600 dark:text-rose-300">
                              <ul className="list-disc list-inside space-y-0.5">
                                {inv.reasons.map((r, rIdx) => (
                                  <li key={rIdx}>{r}</li>
                                ))}
                              </ul>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 p-3 rounded-xl text-xs text-amber-800 dark:text-amber-300">
                <span className="font-bold">Import Strategy:</span> Existing documents matching the same <span className="font-mono font-semibold">ReportingPeriod_EmployeeUID</span> will be replaced with new data without duplicating records.
              </div>
            </div>
          )}

          {/* STEP 5: Executing Import Loading */}
          {step === 5 && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <RefreshCw size={36} className="animate-spin text-indigo-600" />
              <div className="text-center">
                <h3 className="font-bold text-slate-900 dark:text-white text-base">
                  Importing KPI Scorecards...
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Batch updating Firestore collection <span className="font-mono font-bold">kpi_scorecards</span>
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <DialogFooter className="border-t border-slate-100 dark:border-slate-800 pt-4 flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleResetAndClose}
            disabled={isImporting}
            className="text-xs text-slate-500"
          >
            Cancel
          </Button>

          <div className="flex items-center gap-2">
            {step === 2 && parseResult && (
              <Button
                onClick={handleRunValidation}
                size="sm"
                className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold gap-1.5"
              >
                <span>Validate & Continue</span>
                <ChevronRight size={14} />
              </Button>
            )}

            {step === 4 && parseResult && (
              <Button
                onClick={handleExecuteImport}
                disabled={parseResult.validRecords.length === 0 || isImporting}
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold gap-1.5"
              >
                <Check size={14} />
                <span>Import {parseResult.validRecords.length} Valid Records</span>
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
