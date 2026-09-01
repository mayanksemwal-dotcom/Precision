import { readFileSync, writeFileSync } from 'fs';

const file = 'src/views/TMSView.tsx';
let content = readFileSync(file, 'utf-8');

const regex = /const saveShiftState = async \(updatedShift: TMSShift\) => \{[\s\S]*?clearCache\(\);\n  \};\n/;
const replacement = `const saveShiftState = async (updatedShift: TMSShift) => {
    const isSelf = updatedShift.userId === user?.uid;
    let userData: any = isSelf ? user : null;

    if (!userData && allUsers && allUsers.length > 0) {
      userData = allUsers.find(u => u.uid === updatedShift.userId);
    }

    if (!userData || !userData.teamLeadId) {
      const masterRef = doc(db, 'employee_master', updatedShift.userId);
      const masterSnap = await getDocOptimized(masterRef, \`master_for_state_\${updatedShift.userId}\`);
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
            console.warn(\`[TMS SESSION LOCK] Blocked update to shift \${updatedShift.id}. The shift is already completed/closed on the server (Server Status: \${serverStatus}).\`);
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
            console.error(\`[TMS LIFECYCLE GATE] Mutation blocked: \${gateResult.reason}\`);
            throw new Error(\`Operation rejected: Stale or unauthorized shift state transition: \${gateResult.reason}\`);
          }
        }

        // Apply ONLY intended fields to prevent overwriting with stale objects
        const updates: any = {
          status: validatedStatus,
          lastHeartbeat: updatedShift.lastHeartbeat || getLiveTimeISO(),
          activities: updatedShift.activities || [],
          shiftEventLedger: updatedShift.shiftEventLedger || [],
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
        transaction.set(dbRef, updates, { merge: true });

        const liveSessionRef = doc(db, 'live_sessions', updatedShift.userId);
        if (isCompleted) {
          transaction.delete(liveSessionRef);
          const lockRef = doc(db, 'tmsActiveLocks', updatedShift.userId);
          transaction.delete(lockRef);
        } else {
          transaction.set(liveSessionRef, liveSessionData, { merge: true });
        }
      });
      
      logTmsEvent('ACTIVITY_CHANGE', {
        userId: updatedShift.userId,
        shiftId: updatedShift.id,
        reason: \`Saving shift state update (Status: \${updatedShift.status}, Activity: \${currentActivity})\`,
        sourceFunction: 'TMSView.saveShiftState',
        details: { status: updatedShift.status, currentActivity, productiveMs, breakMs, isCompleted }
      });
      clearCache();
    } catch (e: any) {
      console.error('[TMS SESSION LOCK] Save failed:', e);
      if (e.message.includes('Shift already completed') || e.message.includes('Operation rejected')) {
        // toast.error(e.message);
      }
    }
  };
`;

content = content.replace(regex, replacement);
writeFileSync(file, content, 'utf-8');
console.log("Replacement applied.");
