import React, { useState, useMemo } from 'react';
import { 
  FileSpreadsheet, 
  FileText, 
  Download, 
  Filter, 
  Calendar, 
  Users, 
  User, 
  ShieldAlert, 
  X, 
  Award, 
  Sliders, 
  Check, 
  Building2, 
  UserCheck, 
  Briefcase,
  Layers,
  Sparkles
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { KPIScorecard, UserProfile } from '../../types';
import { exportKpiScorecardsData, canExportKpi } from '../../services/kpiService';
import { formatPeriodForDisplay } from '../../lib/utils';
import { toast } from 'sonner';

interface KpiExportModalProps {
  open: boolean;
  onClose: () => void;
  allRecords: KPIScorecard[];
  currentFilteredRecords: KPIScorecard[];
  user: UserProfile;
  roster: UserProfile[];
}

export default function KpiExportModal({
  open,
  onClose,
  allRecords,
  currentFilteredRecords,
  user,
  roster,
}: KpiExportModalProps) {
  const isAuthorized = canExportKpi(user.role);

  // Export Mode: 'current_filtered' | 'complete_period' | 'custom'
  const [exportMode, setExportMode] = useState<'current_filtered' | 'complete_period' | 'custom'>('current_filtered');
  
  // File Format
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');

  // Filter States
  const [selectedPeriod, setSelectedPeriod] = useState<string>('ALL');
  const [selectedEmployee, setSelectedEmployee] = useState<string>('ALL');
  const [selectedProcess, setSelectedProcess] = useState<string>('ALL');
  const [selectedRole, setSelectedRole] = useState<string>('ALL');
  const [selectedTeamLead, setSelectedTeamLead] = useState<string>('ALL');
  const [selectedManager, setSelectedManager] = useState<string>('ALL');
  const [selectedDepartment, setSelectedDepartment] = useState<string>('ALL');
  const [minRank, setMinRank] = useState<string>('');
  const [maxRank, setMaxRank] = useState<string>('');
  const [minScore, setMinScore] = useState<string>('');
  const [maxScore, setMaxScore] = useState<string>('');

  // Roster Lookup Map
  const rosterMap = useMemo(() => {
    const map = new Map<string, UserProfile>();
    roster.forEach(u => {
      if (u.email) {
        map.set(u.email.toLowerCase().trim(), u);
      }
    });
    return map;
  }, [roster]);

  // Unique Dropdown Options
  const uniquePeriods = useMemo(() => {
    const set = new Set<string>();
    allRecords.forEach(s => s.reportingPeriod && set.add(s.reportingPeriod));
    return Array.from(set).sort();
  }, [allRecords]);

  const uniqueEmployees = useMemo(() => {
    const map = new Map<string, string>(); // email -> name
    allRecords.forEach(s => {
      if (s.employeeEmail) {
        map.set(s.employeeEmail, s.employeeName || s.employeeEmail);
      }
    });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allRecords]);

  const uniqueProcesses = useMemo(() => {
    const set = new Set<string>();
    allRecords.forEach(s => s.process && set.add(s.process));
    return Array.from(set).sort();
  }, [allRecords]);

  const uniqueRoles = useMemo(() => {
    const set = new Set<string>();
    allRecords.forEach(s => s.role && set.add(s.role));
    return Array.from(set).sort();
  }, [allRecords]);

  const uniqueTeamLeads = useMemo(() => {
    const set = new Set<string>();
    roster.forEach(u => {
      const tl = u.teamLeadName || u.mappedTL || u.teamLeadEmail;
      if (tl && tl.trim() && tl !== '-') set.add(tl.trim());
    });
    return Array.from(set).sort();
  }, [roster]);

  const uniqueManagers = useMemo(() => {
    const set = new Set<string>();
    roster.forEach(u => {
      const mgr = u.managerName || u.mappedManager || u.managerEmail || u.Manager;
      if (mgr && mgr.trim() && mgr !== '-') set.add(mgr.trim());
    });
    return Array.from(set).sort();
  }, [roster]);

  const uniqueDepartments = useMemo(() => {
    const set = new Set<string>();
    roster.forEach(u => {
      if (u.department && u.department.trim() && u.department !== '-') set.add(u.department.trim());
    });
    return Array.from(set).sort();
  }, [roster]);

  // Computed Export Records
  const exportRecords = useMemo(() => {
    if (exportMode === 'current_filtered') {
      return currentFilteredRecords;
    }

    if (exportMode === 'complete_period') {
      if (selectedPeriod === 'ALL') return allRecords;
      return allRecords.filter(r => r.reportingPeriod === selectedPeriod);
    }

    // Custom Mode
    return allRecords.filter(rec => {
      // Roster user match
      const matchedUser = rec.employeeEmail ? rosterMap.get(rec.employeeEmail.toLowerCase().trim()) : undefined;

      // Period
      if (selectedPeriod !== 'ALL' && rec.reportingPeriod !== selectedPeriod) return false;

      // Employee
      if (selectedEmployee !== 'ALL' && rec.employeeEmail !== selectedEmployee) return false;

      // Process
      if (selectedProcess !== 'ALL' && rec.process !== selectedProcess) return false;

      // Role
      if (selectedRole !== 'ALL' && rec.role !== selectedRole) return false;

      // Team Lead
      if (selectedTeamLead !== 'ALL') {
        const recTL = matchedUser?.teamLeadName || matchedUser?.mappedTL || matchedUser?.teamLeadEmail || '';
        if (recTL.toLowerCase().trim() !== selectedTeamLead.toLowerCase().trim()) return false;
      }

      // Manager
      if (selectedManager !== 'ALL') {
        const recMgr = matchedUser?.managerName || matchedUser?.mappedManager || matchedUser?.managerEmail || matchedUser?.Manager || '';
        if (recMgr.toLowerCase().trim() !== selectedManager.toLowerCase().trim()) return false;
      }

      // Department
      if (selectedDepartment !== 'ALL') {
        const recDept = matchedUser?.department || '';
        if (recDept.toLowerCase().trim() !== selectedDepartment.toLowerCase().trim()) return false;
      }

      // Rank Range
      if (minRank.trim() !== '') {
        const rankNum = Number(rec.rank);
        if (isNaN(rankNum) || rankNum < Number(minRank)) return false;
      }
      if (maxRank.trim() !== '') {
        const rankNum = Number(rec.rank);
        if (isNaN(rankNum) || rankNum > Number(maxRank)) return false;
      }

      // Total Score Range
      if (minScore.trim() !== '') {
        const scoreNum = Number(rec.totalScore);
        if (isNaN(scoreNum) || scoreNum < Number(minScore)) return false;
      }
      if (maxScore.trim() !== '') {
        const scoreNum = Number(rec.totalScore);
        if (isNaN(scoreNum) || scoreNum > Number(maxScore)) return false;
      }

      return true;
    });
  }, [
    exportMode,
    currentFilteredRecords,
    allRecords,
    selectedPeriod,
    selectedEmployee,
    selectedProcess,
    selectedRole,
    selectedTeamLead,
    selectedManager,
    selectedDepartment,
    minRank,
    maxRank,
    minScore,
    maxScore,
    rosterMap,
  ]);

  const handleExecuteExport = () => {
    if (!isAuthorized) {
      toast.error('Access Denied: You do not have permission to export KPI scorecards.');
      return;
    }

    if (exportRecords.length === 0) {
      toast.error('No matching KPI scorecard records found to export.');
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const modeLabel = 
      exportMode === 'current_filtered' ? 'Dashboard_Filtered' :
      exportMode === 'complete_period' ? `Period_${selectedPeriod}` :
      'Custom_Filtered';

    const filename = `KPI_Scorecard_${modeLabel}_${timestamp}`;

    exportKpiScorecardsData(exportRecords, format, filename, roster);
    toast.success(`Exported ${exportRecords.length} KPI scorecard(s) in .${format.toUpperCase()} format!`);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-6 overflow-hidden bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800">
        {/* Header */}
        <DialogHeader className="border-b border-slate-100 dark:border-slate-800 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 rounded-xl border border-indigo-100 dark:border-indigo-900/50">
                <FileSpreadsheet size={22} />
              </div>
              <div>
                <DialogTitle className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <span>Export KPI Scorecard Report</span>
                  <span className="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 text-[10px] font-mono font-bold uppercase">
                    Audit & Review Ready
                  </span>
                </DialogTitle>
                <DialogDescription className="text-xs text-slate-500 dark:text-slate-400">
                  Export complete uploaded KPI records for appraisals, performance reviews, and management reporting.
                </DialogDescription>
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Content Body */}
        {!isAuthorized ? (
          <div className="py-12 px-4 flex flex-col items-center justify-center text-center">
            <div className="p-3 bg-rose-50 dark:bg-rose-950/50 text-rose-600 rounded-full mb-3">
              <ShieldAlert size={32} />
            </div>
            <h3 className="font-bold text-slate-900 dark:text-white text-base">Access Restricted</h3>
            <p className="text-xs text-slate-500 max-w-md mt-1">
              Only authorized Administrators, Managers, MIS, and HR roles are permitted to export KPI scorecard datasets. Employee profiles do not have export clearance.
            </p>
          </div>
        ) : (
          <div className="py-4 flex-grow overflow-y-auto space-y-5 pr-1 text-xs">
            {/* Quick Export Option Mode Selector */}
            <div>
              <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">
                Quick Selection Options
              </label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                {/* Current Filtered Results */}
                <button
                  type="button"
                  onClick={() => setExportMode('current_filtered')}
                  className={`p-3 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                    exportMode === 'current_filtered'
                      ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-500 ring-1 ring-indigo-500/30'
                      : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900 dark:text-white text-xs">Current Results</span>
                    {exportMode === 'current_filtered' && (
                      <span className="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px]">
                        ✓
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                    Export {currentFilteredRecords.length} record(s) matching your active dashboard filters.
                  </p>
                </button>

                {/* Complete Reporting Period */}
                <button
                  type="button"
                  onClick={() => setExportMode('complete_period')}
                  className={`p-3 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                    exportMode === 'complete_period'
                      ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-500 ring-1 ring-indigo-500/30'
                      : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900 dark:text-white text-xs">Complete Period</span>
                    {exportMode === 'complete_period' && (
                      <span className="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px]">
                        ✓
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                    Export all published records for a selected month / reporting cycle.
                  </p>
                </button>

                {/* Custom Filters */}
                <button
                  type="button"
                  onClick={() => setExportMode('custom')}
                  className={`p-3 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                    exportMode === 'custom'
                      ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-500 ring-1 ring-indigo-500/30'
                      : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900 dark:text-white text-xs">Custom Criteria</span>
                    {exportMode === 'custom' && (
                      <span className="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px]">
                        ✓
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                    Apply fine-grained filters by TL, Manager, Rank, or Score ranges.
                  </p>
                </button>
              </div>
            </div>

            {/* File Format Selector */}
            <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span className="font-bold text-slate-900 dark:text-white block">Export Format</span>
                <span className="text-[11px] text-slate-500">Choose between Excel workbook or universal CSV text format</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFormat('xlsx')}
                  className={`px-3 py-1.5 rounded-lg font-bold text-xs flex items-center gap-1.5 transition-all ${
                    format === 'xlsx'
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100'
                  }`}
                >
                  <FileSpreadsheet size={14} />
                  <span>Excel (.xlsx)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setFormat('csv')}
                  className={`px-3 py-1.5 rounded-lg font-bold text-xs flex items-center gap-1.5 transition-all ${
                    format === 'csv'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100'
                  }`}
                >
                  <FileText size={14} />
                  <span>CSV (.csv)</span>
                </button>
              </div>
            </div>

            {/* Detailed Filters (Visible for 'complete_period' or 'custom') */}
            {(exportMode === 'custom' || exportMode === 'complete_period') && (
              <div className="p-4 bg-slate-50/50 dark:bg-slate-950/50 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-4">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-200">
                  <Sliders size={14} className="text-indigo-600" />
                  <span>{exportMode === 'complete_period' ? 'Select Reporting Period' : 'Detailed Export Filters'}</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {/* Reporting Period */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1 block">
                      Reporting Period
                    </label>
                    <select
                      value={selectedPeriod}
                      onChange={(e) => setSelectedPeriod(e.target.value)}
                      className="w-full h-8 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium focus:outline-none"
                    >
                      <option value="ALL">All Periods ({uniquePeriods.length})</option>
                      {uniquePeriods.map(p => (
                        <option key={p} value={p}>{formatPeriodForDisplay(p)}</option>
                      ))}
                    </select>
                  </div>

                  {exportMode === 'custom' && (
                    <>
                      {/* Employee */}
                      <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1 block">
                          Employee
                        </label>
                        <select
                          value={selectedEmployee}
                          onChange={(e) => setSelectedEmployee(e.target.value)}
                          className="w-full h-8 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium focus:outline-none"
                        >
                          <option value="ALL">All Employees ({uniqueEmployees.length})</option>
                          {uniqueEmployees.map(([email, name]) => (
                            <option key={email} value={email}>{name} ({email})</option>
                          ))}
                        </select>
                      </div>

                      {/* Process */}
                      <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1 block">
                          Process Name
                        </label>
                        <select
                          value={selectedProcess}
                          onChange={(e) => setSelectedProcess(e.target.value)}
                          className="w-full h-8 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium focus:outline-none"
                        >
                          <option value="ALL">All Processes ({uniqueProcesses.length})</option>
                          {uniqueProcesses.map(p => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </div>

                      {/* Role */}
                      <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1 block">
                          Role
                        </label>
                        <select
                          value={selectedRole}
                          onChange={(e) => setSelectedRole(e.target.value)}
                          className="w-full h-8 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium focus:outline-none"
                        >
                          <option value="ALL">All Roles ({uniqueRoles.length})</option>
                          {uniqueRoles.map(r => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      </div>

                      {/* Team Lead */}
                      <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1 block">
                          Team Lead
                        </label>
                        <select
                          value={selectedTeamLead}
                          onChange={(e) => setSelectedTeamLead(e.target.value)}
                          className="w-full h-8 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium focus:outline-none"
                        >
                          <option value="ALL">All Team Leads ({uniqueTeamLeads.length})</option>
                          {uniqueTeamLeads.map(tl => (
                            <option key={tl} value={tl}>{tl}</option>
                          ))}
                        </select>
                      </div>

                      {/* Manager */}
                      <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1 block">
                          Manager
                        </label>
                        <select
                          value={selectedManager}
                          onChange={(e) => setSelectedManager(e.target.value)}
                          className="w-full h-8 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium focus:outline-none"
                        >
                          <option value="ALL">All Managers ({uniqueManagers.length})</option>
                          {uniqueManagers.map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>

                      {/* Department */}
                      <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1 block">
                          Department
                        </label>
                        <select
                          value={selectedDepartment}
                          onChange={(e) => setSelectedDepartment(e.target.value)}
                          className="w-full h-8 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium focus:outline-none"
                        >
                          <option value="ALL">All Departments ({uniqueDepartments.length})</option>
                          {uniqueDepartments.map(d => (
                            <option key={d} value={d}>{d}</option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}
                </div>

                {/* Range Filters for Custom Mode */}
                {exportMode === 'custom' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200/60 dark:border-slate-800">
                    {/* Rank Range */}
                    <div>
                      <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1 block">
                        Rank Range
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          placeholder="Min Rank (e.g. 1)"
                          value={minRank}
                          onChange={(e) => setMinRank(e.target.value)}
                          className="h-8 text-xs bg-white dark:bg-slate-900"
                        />
                        <span className="text-slate-400 font-bold">-</span>
                        <Input
                          type="number"
                          placeholder="Max Rank (e.g. 10)"
                          value={maxRank}
                          onChange={(e) => setMaxRank(e.target.value)}
                          className="h-8 text-xs bg-white dark:bg-slate-900"
                        />
                      </div>
                    </div>

                    {/* Total Score Range */}
                    <div>
                      <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1 block">
                        Total Score Range
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          placeholder="Min Score (e.g. 80)"
                          value={minScore}
                          onChange={(e) => setMinScore(e.target.value)}
                          className="h-8 text-xs bg-white dark:bg-slate-900"
                        />
                        <span className="text-slate-400 font-bold">-</span>
                        <Input
                          type="number"
                          placeholder="Max Score (e.g. 100)"
                          value={maxScore}
                          onChange={(e) => setMaxScore(e.target.value)}
                          className="h-8 text-xs bg-white dark:bg-slate-900"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Live Dataset Counter */}
            <div className="p-3 bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200/60 dark:border-indigo-900/60 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
                <div>
                  <span className="font-bold text-indigo-950 dark:text-indigo-200">Export Dataset Summary</span>
                  <p className="text-[11px] text-indigo-700/80 dark:text-indigo-300">
                    Source data: Directly from uploaded KPI records (no recalculation or engine calls).
                  </p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <span className="text-xs text-indigo-700 dark:text-indigo-300 font-bold block">Matching Records</span>
                <span className="text-lg font-black text-indigo-600 dark:text-indigo-400 font-mono">
                  {exportRecords.length}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <DialogFooter className="border-t border-slate-100 dark:border-slate-800 pt-3 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="text-xs"
          >
            Cancel
          </Button>
          {isAuthorized && (
            <Button
              onClick={handleExecuteExport}
              disabled={exportRecords.length === 0}
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs gap-1.5"
            >
              <Download size={14} />
              <span>Export {exportRecords.length} Record(s) ({format.toUpperCase()})</span>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
