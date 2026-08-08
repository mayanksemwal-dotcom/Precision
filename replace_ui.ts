import fs from 'fs';

let content = fs.readFileSync('src/components/tms/SupervisorDashboard.tsx', 'utf-8');

const returnStartStr = '  return (\n    <div className="space-y-6">';
const returnEndStr = '    </div>\n  );\n}\n\ninterface MobileEvent {';

const returnStart = content.indexOf(returnStartStr);
const returnEnd = content.indexOf(returnEndStr);

if (returnStart === -1) { console.log('Could not find start'); process.exit(1); }
if (returnEnd === -1) { console.log('Could not find end'); process.exit(1); }

const newUi = `  return (
    <div className="flex flex-col h-full bg-slate-50 dark:bg-slate-950/50 overflow-hidden relative">
      
      {/* 1. KPI Cards Row */}
      <div className="p-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 shadow-sm shrink-0">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 flex items-center justify-center">
               <Shield size={20} className="animate-pulse" />
             </div>
             <div>
               <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 leading-tight">Workforce Operations</h2>
               <div className="flex items-center gap-2 mt-0.5">
                 <span className="text-[10px] text-slate-500 font-mono font-medium tracking-wider">Updated {lastRefreshed.toLocaleTimeString()}</span>
                 <button onClick={() => recomputeMetrics(true)} className="text-indigo-500 hover:text-indigo-600 transition-colors cursor-pointer p-0.5 rounded">
                   <RefreshCw size={10} className={isLoadingShifts ? 'animate-spin' : ''} />
                 </button>
               </div>
             </div>
          </div>
          <div className="h-8 w-px bg-slate-200 dark:bg-slate-800 hidden md:block" />
          <div className="flex gap-4">
             <div className="text-center px-2">
               <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Total Assigned</div>
               <div className="text-xl font-black text-slate-700 dark:text-slate-200 leading-none mt-1">{liveStats.total}</div>
             </div>
             <div className="text-center px-2">
               <div className="text-[10px] uppercase font-bold text-sky-500 tracking-wider">Logged In</div>
               <div className="text-xl font-black text-sky-600 leading-none mt-1">{liveStats.loggedIn}</div>
             </div>
             <div className="text-center px-2">
               <div className="text-[10px] uppercase font-bold text-emerald-500 tracking-wider">Productive</div>
               <div className="text-xl font-black text-emerald-600 leading-none mt-1">{liveStats.active}</div>
             </div>
             <div className="text-center px-2">
               <div className="text-[10px] uppercase font-bold text-amber-500 tracking-wider">On Break</div>
               <div className="text-xl font-black text-amber-600 leading-none mt-1">{liveStats.onBreak}</div>
             </div>
          </div>
        </div>

        {/* Export / Supervisor Control */}
        <div className="flex flex-wrap items-center gap-3">
          {(() => {
             const myShift = ownActiveShift || activeShifts.find(s => s.userId === user.uid);
             return !myShift ? (
               <button onClick={() => setShowSuperClockInConfirm(true)} className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 border border-emerald-200/40 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-sm">
                 <Play size={12} /> Start Shift
               </button>
             ) : (
               <button onClick={() => setShowSuperClockOutConfirm(true)} className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 hover:bg-rose-100 border border-rose-200/40 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-sm">
                 <LogOut size={12} /> End Shift
               </button>
             );
          })()}
          <button onClick={handleSpreadsheetExport} disabled={isExporting} className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-sm">
             {isExporting ? <RefreshCw size={12} className="animate-spin" /> : <FileSpreadsheet size={12} />} 
             Export
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content Area (Filters + Table) */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative bg-white dark:bg-slate-900">
          {/* 2. Filters Row */}
          <div className="p-3 bg-slate-50 dark:bg-slate-950/30 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 shrink-0">
             <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
               <div className="relative w-full sm:w-64 shrink-0">
                  <Search className="absolute left-3 top-2 text-slate-400" size={14} />
                  <input 
                    type="text" value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                    placeholder="Search Employee..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-indigo-500 font-medium text-slate-700 dark:text-slate-200 transition-shadow shadow-sm"
                  />
               </div>
               
               <div className="flex items-center gap-2 text-xs">
                  <div className="relative" ref={statusDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setIsStatusDropdownOpen(!isStatusDropdownOpen)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg font-bold text-slate-600 dark:text-slate-300 min-w-[140px] justify-between cursor-pointer shadow-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <span className="truncate">{shiftFilter === 'all' ? 'All Statuses' : shiftFilter.replace('_', ' ').toUpperCase()}</span>
                      <span className="text-[9px] text-slate-400">▼</span>
                    </button>
                    {isStatusDropdownOpen && (
                      <div className="absolute top-full mt-1.5 left-0 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 py-1 overflow-hidden animate-in fade-in slide-in-from-top-1">
                         {['all', 'active', 'break_tea', 'lunch', 'meeting', 'break', 'offline'].map(opt => (
                           <button key={opt} onClick={() => { setShiftFilter(opt); setIsStatusDropdownOpen(false); setCurrentPage(1); }} className="w-full text-left px-4 py-2 text-[11px] font-bold hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-600 dark:hover:text-indigo-400 text-slate-600 dark:text-slate-300 uppercase tracking-wider transition-colors cursor-pointer">
                             {opt.replace('_', ' ')}
                           </button>
                         ))}
                      </div>
                    )}
                  </div>

                  <button onClick={() => { setSearchTerm(''); setShiftFilter('all'); setCurrentPage(1); }} className="px-3 py-1.5 text-slate-500 hover:text-slate-800 font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                    Clear Filters
                  </button>
               </div>
             </div>
          </div>

          {/* 3. Live Workforce Table */}
          <div className="flex-1 overflow-auto relative scrollbar-thin">
             <table className="w-full text-left text-xs border-collapse whitespace-nowrap">
                <thead className="sticky top-0 z-10 bg-slate-100/90 dark:bg-slate-900/90 backdrop-blur shadow-xs border-b border-slate-200 dark:border-slate-800">
                   <tr className="text-slate-500 dark:text-slate-400 font-black text-[10px] uppercase tracking-wider select-none">
                     <th className="p-3.5 pl-6 cursor-pointer hover:bg-slate-200/50 transition-colors" onClick={() => { setSortKey('name'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>
                       Employee Name
                     </th>
                     <th className="p-3.5">Process</th>
                     <th className="p-3.5 cursor-pointer hover:bg-slate-200/50 transition-colors" onClick={() => { setSortKey('status'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>
                       Status
                     </th>
                     <th className="p-3.5">Activity</th>
                     <th className="p-3.5">Since</th>
                     <th className="p-3.5 cursor-pointer hover:bg-slate-200/50 transition-colors" onClick={() => { setSortKey('productive'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>
                       Productive Time
                     </th>
                     <th className="p-3.5">Break Time</th>
                     <th className="p-3.5 text-center">Device</th>
                     <th className="p-3.5 text-right pr-6">Actions</th>
                   </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                   {paginatedWorkforce.map(u => {
                      const live = activeShiftsMap.get(u.uid);
                      const stats = live ? calculateShiftStatsObj(live) : null;
                      const liveActs = live?.activities || [];
                      const lastAct = liveActs.length > 0 ? liveActs[liveActs.length - 1] : null;
                      const currentActivityName = lastAct?.name || (live as any)?.currentActivity || 'Offline';
                      const since = lastAct?.startTime ? new Date(lastAct.startTime).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '-';
                      
                      const isOffline = !live || live.status === 'CLOCKED_OUT';
                      const isProductive = live && live.status === 'ACTIVE' && lastAct?.type === 'productive';
                      const isBreak = live && live.status === 'BREAK';
                      const isMeeting = live && live.status === 'ACTIVE' && (lastAct?.name?.toLowerCase().includes('meeting') || lastAct?.name?.toLowerCase().includes('coaching') || lastAct?.name?.toLowerCase().includes('alignment'));
                      const isTraining = live && live.status === 'ACTIVE' && lastAct?.name?.toLowerCase().includes('training');

                      return (
                        <tr key={u.uid} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors group">
                           <td className="p-3.5 pl-6">
                             <div className="flex items-center gap-3">
                               <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-500 shrink-0 overflow-hidden">
                                 {u.photoURL ? <img src={u.photoURL} alt="" className="w-full h-full object-cover" /> : u.name.split(' ').map(n=>n[0]).slice(0,2).join('')}
                               </div>
                               <div>
                                 <div className="font-extrabold text-slate-800 dark:text-slate-200 leading-none">{u.name}</div>
                                 <div className="text-[10px] text-slate-400 font-mono mt-1 leading-none">{u.email}</div>
                               </div>
                             </div>
                           </td>
                           <td className="p-3.5">
                             <span className="bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-md text-slate-600 dark:text-slate-300 font-bold text-[10px] uppercase tracking-wider">{u.process || 'General'}</span>
                           </td>
                           <td className="p-3.5 font-bold text-[11px] uppercase tracking-wider">
                              {isOffline && <span className="flex items-center gap-1.5 text-slate-400"><div className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600" /> OFFLINE</span>}
                              {isProductive && !isMeeting && !isTraining && <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-500"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> PRODUCTIVE</span>}
                              {isBreak && <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-500"><div className="w-1.5 h-1.5 rounded-full bg-amber-500" /> BREAK</span>}
                              {isMeeting && <span className="flex items-center gap-1.5 text-sky-600 dark:text-sky-500"><div className="w-1.5 h-1.5 rounded-full bg-sky-500" /> MEETING</span>}
                              {isTraining && <span className="flex items-center gap-1.5 text-fuchsia-600 dark:text-fuchsia-500"><div className="w-1.5 h-1.5 rounded-full bg-fuchsia-500" /> TRAINING</span>}
                           </td>
                           <td className="p-3.5 font-semibold text-slate-700 dark:text-slate-300">{currentActivityName}</td>
                           <td className="p-3.5 font-mono text-[11px] text-slate-500">{since}</td>
                           <td className="p-3.5 font-mono font-bold text-[11px] text-emerald-600 dark:text-emerald-500">{stats ? stats.activeStr : '-'}</td>
                           <td className="p-3.5 font-mono font-bold text-[11px] text-amber-600 dark:text-amber-500">{stats && stats.breakMs > 0 ? stats.breakStr : '-'}</td>
                           <td className="p-3.5 text-center">
                             {live ? (
                               <div className="flex items-center justify-center gap-1 text-slate-500">
                                 {live.deviceType === 'Mobile' || live.clockInDevice === 'mobile' ? <Smartphone size={14} className="text-rose-500" /> : <Laptop size={14} className="text-indigo-500" />}
                               </div>
                             ) : '-'}
                           </td>
                           <td className="p-3.5 text-right pr-6 opacity-50 group-hover:opacity-100 transition-opacity flex items-center justify-end gap-1.5">
                             <button className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/40 rounded-lg transition-colors cursor-pointer" title="View Details" onClick={() => setExpandedUserId(prev => prev === u.uid ? null : u.uid)}>
                               <Eye size={16} />
                             </button>
                             {live && canModifyTarget(u.uid) && (
                               <button 
                                 className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/40 rounded-lg transition-colors cursor-pointer" 
                                 title="Force Logout"
                                 onClick={() => {
                                  setLogoutShiftId(live.id);
                                  setLogoutTargetUid(u.uid);
                                  setLogoutTargetName(u.name);
                                  setLogoutReason('Left without logging out');
                                  setShowForceLogoutConfirm(true);
                                 }}
                               >
                                 <LogOut size={16} />
                               </button>
                             )}
                           </td>
                        </tr>
                      )
                   })}
                   {paginatedWorkforce.length === 0 && (
                     <tr>
                       <td colSpan={9} className="p-8 text-center text-slate-400 font-bold uppercase tracking-widest text-xs">No workforce members found matching the criteria.</td>
                     </tr>
                   )}
                </tbody>
             </table>
             
             {/* Pagination */}
             {totalPages > 1 && (
               <div className="sticky bottom-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-t border-slate-200 dark:border-slate-800 p-4 flex justify-between items-center text-xs">
                 <span className="text-slate-500 font-bold uppercase tracking-wider text-[10px]">Page {currentPage} of {totalPages}</span>
                 <div className="flex gap-2">
                   <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)} className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-lg disabled:opacity-50 cursor-pointer transition-colors">Prev</button>
                   <button disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)} className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-lg disabled:opacity-50 cursor-pointer transition-colors">Next</button>
                 </div>
               </div>
             )}
          </div>
        </div>

        {/* 4. Right Side Panel (Alerts & Diagnostics) */}
        <div className="w-80 shrink-0 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-y-auto hidden lg:block relative z-20 shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.02)]">
          <div className="p-4 border-b border-slate-100 dark:border-slate-800/60 sticky top-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur z-10 flex items-center justify-between">
            <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-800 dark:text-slate-200 flex items-center gap-2">
              <Bell size={14} className="text-rose-500" />
              Live Alerts
            </h3>
            <span className="bg-rose-50 dark:bg-rose-950/40 text-rose-600 border border-rose-200/40 px-2 py-0.5 rounded font-mono text-[9px] font-bold">
              {lateLogins.length} New
            </span>
          </div>
          
          <div className="p-4 space-y-6">
             {/* Late Logins */}
             <div className="space-y-3">
               <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Late Logins (Today)</h4>
               {lateLogins.length > 0 ? (
                 <div className="space-y-2">
                   {lateLogins.map(s => (
                     <div key={s.id} className="p-3 rounded-xl border border-amber-200/60 bg-amber-50/50 dark:bg-amber-950/20 text-xs">
                       <div className="font-extrabold text-amber-900 dark:text-amber-400">{allUsers.find(u => u.uid === s.userId)?.name || 'Unknown'}</div>
                       <div className="text-[10px] text-amber-600 font-mono mt-1 font-bold">In @ {new Date(s.clockInTime).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
                     </div>
                   ))}
                 </div>
               ) : (
                 <div className="text-[10px] font-bold text-slate-400 p-3 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 uppercase tracking-wider text-center">No late logins</div>
               )}
             </div>

             {/* Long Breaks */}
             <div className="space-y-3">
               <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Long Breaks ({'>'} 15m)</h4>
               {(() => {
                 const longBreaks = activeShifts.filter(s => {
                    const stats = activeShiftsMap.has(s.userId) ? calculateShiftStatsObj(s) : null;
                    return stats && stats.breakMs > 15 * 60 * 1000 && s.status === 'BREAK';
                 });
                 if (longBreaks.length === 0) return <div className="text-[10px] font-bold text-slate-400 p-3 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 uppercase tracking-wider text-center">No active long breaks</div>;
                 return (
                   <div className="space-y-2">
                     {longBreaks.map(s => (
                       <div key={s.id} className="p-3 rounded-xl border border-rose-200/60 bg-rose-50/50 dark:bg-rose-950/20 text-xs flex items-center justify-between">
                         <div>
                           <div className="font-extrabold text-rose-900 dark:text-rose-400">{allUsers.find(u => u.uid === s.userId)?.name || 'Unknown'}</div>
                           <div className="text-[10px] text-rose-600 font-mono mt-1 font-bold">On break for {Math.floor((new Date().getTime() - new Date(s.activities[s.activities.length-1].startTime).getTime()) / 60000)}m</div>
                         </div>
                         <Coffee size={14} className="text-rose-400" />
                       </div>
                     ))}
                   </div>
                 );
               })()}
             </div>

             {/* Idle/Disconnected Users */}
             <div className="space-y-3">
               <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Stale Sessions</h4>
               {(() => {
                 const stale = activeShifts.filter(s => {
                    if (s.status !== 'ACTIVE') return false;
                    const acts = s.activities || [];
                    if (acts.length === 0) return false;
                    const last = acts[acts.length - 1];
                    const diff = new Date().getTime() - new Date(last.startTime).getTime();
                    // Mock heuristic for UI purposes if they've been on same productive task > 4 hours
                    return diff > 4 * 60 * 60 * 1000 && last.type === 'productive';
                 });
                 if (stale.length === 0) return <div className="text-[10px] font-bold text-slate-400 p-3 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 uppercase tracking-wider text-center">No stale sessions</div>;
                 return (
                   <div className="space-y-2">
                     {stale.map(s => (
                       <div key={s.id} className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm text-xs flex justify-between items-center">
                         <div>
                           <div className="font-extrabold text-slate-800 dark:text-slate-200">{allUsers.find(u => u.uid === s.userId)?.name || 'Unknown'}</div>
                           <div className="text-[10px] text-slate-500 font-bold mt-1 uppercase tracking-wider">{s.activities[s.activities.length-1]?.name}</div>
                         </div>
                         <AlertCircle size={14} className="text-amber-500" />
                       </div>
                     ))}
                   </div>
                 );
               })()}
             </div>
          </div>
        </div>
      </div>

      {/* Force Logout Confirm Modal */}
      {showForceLogoutConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-rose-600 border-b border-slate-100 dark:border-slate-800 pb-4">
               <div className="w-12 h-12 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center shrink-0">
                 <AlertCircle size={24} />
               </div>
               <div>
                 <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">Confirm Force Logout</h4>
                 <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 leading-tight">Terminate session for {logoutTargetName}</p>
               </div>
             </div>
             
             <div className="space-y-2">
               <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Reason</label>
               <input type="text" value={logoutReason} onChange={e => setLogoutReason(e.target.value)} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500" />
             </div>
             
             <div className="flex flex-col gap-2 pt-2">
               <button onClick={executeForceLogout} className="w-full bg-rose-600 hover:bg-rose-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-rose-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider">
                 Confirm Logout
               </button>
               <button onClick={() => setShowForceLogoutConfirm(false)} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                 Cancel
               </button>
             </div>
          </div>
        </div>
      )}

      {/* Export Options Modal */}
      {showEnhancedExportModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-indigo-600 border-b border-slate-100 dark:border-slate-800 pb-4">
               <div className="w-12 h-12 rounded-full bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center shrink-0">
                 <FileSpreadsheet size={24} />
               </div>
               <div>
                 <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">Export Utilization</h4>
                 <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 leading-tight">Download shift and activity reports</p>
               </div>
             </div>
             <div className="space-y-2">
               <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Report Type</label>
               <select value={exportType} onChange={e => setExportType(e.target.value as any)} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500">
                 <option value="summary">Summary Report</option>
                 <option value="chrono">Chronological Log</option>
                 <option value="both">Both</option>
               </select>
             </div>
             <div className="flex flex-col gap-2 pt-2">
               <button onClick={executeEnhancedExport} disabled={isExporting} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-indigo-200/50 flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer transition-colors uppercase tracking-wider">
                 {isExporting ? <RefreshCw size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />} 
                 {isExporting ? 'Generating...' : 'Export'}
               </button>
               <button onClick={() => setShowEnhancedExportModal(false)} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                 Cancel
               </button>
             </div>
          </div>
        </div>
      )}

      {/* Super Clock In Modal */}
      {showSuperClockInConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-emerald-600 border-b border-slate-100 dark:border-slate-800 pb-4">
               <div className="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
                 <Clock size={24} />
               </div>
               <div>
                 <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">Supervisor Shift Start</h4>
                 <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 leading-tight">Verification required before punch</p>
               </div>
             </div>
             <div className="space-y-2">
               <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Process Mapping</label>
               <select value={superSelectedProcess} onChange={e => setSuperSelectedProcess(e.target.value)} className="w-full text-xs font-bold p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 rounded-xl focus:outline-indigo-500">
                 {supervisorProcesses.map(p => <option key={p} value={p}>{p}</option>)}
               </select>
             </div>
             <div className="flex flex-col gap-2 pt-2">
               <button onClick={() => performSuperClockIn(superSelectedProcess)} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-emerald-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider">
                 <Play size={14} /> Start Shift
               </button>
               <button onClick={() => setShowSuperClockInConfirm(false)} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                 Cancel
               </button>
             </div>
          </div>
        </div>
      )}

      {/* Super Clock Out Modal */}
      {showSuperClockOutConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 border border-slate-200 dark:border-slate-800 space-y-5">
             <div className="flex items-center gap-3 text-rose-600 border-b border-slate-100 dark:border-slate-800 pb-4">
               <div className="w-12 h-12 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center shrink-0">
                 <AlertCircle size={24} />
               </div>
               <div>
                 <h4 className="font-black text-slate-900 dark:text-white text-sm uppercase tracking-tight">Clock Out Confirmation</h4>
                 <p className="text-slate-500 dark:text-slate-400 text-[10px] font-bold mt-0.5 leading-tight">Are you sure you want to end your shift?</p>
               </div>
             </div>
             <div className="flex flex-col gap-2 pt-2">
               <button onClick={() => { setShowSuperClockOutConfirm(false); performSuperClockOut(); }} className="w-full bg-rose-600 hover:bg-rose-700 text-white font-black text-xs h-11 rounded-xl shadow-lg shadow-rose-200/50 flex items-center justify-center gap-2 cursor-pointer transition-colors uppercase tracking-wider">
                 <LogOut size={14} /> End Shift
               </button>
               <button onClick={() => setShowSuperClockOutConfirm(false)} className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-xs h-10 rounded-xl cursor-pointer transition-colors uppercase tracking-wider">
                 Cancel
               </button>
             </div>
          </div>
        </div>
      )}
    </div>
  );`;

const newContent = content.substring(0, returnStart) + newUi + '\n' + content.substring(returnEnd);
fs.writeFileSync('src/components/tms/SupervisorDashboard.tsx', newContent);
console.log('Successfully applied UI rewrite');
