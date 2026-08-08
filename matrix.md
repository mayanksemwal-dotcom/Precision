# Precision360 – TMS Data Integrity Audit

## Write Matrix

| Source Field | Writer Function | File | Trigger | Can Overwrite? | Last Write Wins? | Protected? |
|---|---|---|---|---|---|---|
| `clockInTime` | `handleAction('CLOCK_IN')` | `TMSView.tsx` | User clicks Clock In | No | Yes | No |
| `clockInTime` | `repairCorruptedClockInTimes` | `tmsCleanupService.ts` | Skew detection | Yes | Yes | No |
| `clockOutTime` | `handleAction('CLOCK_OUT')` | `TMSView.tsx` | User clicks Clock Out | Yes | Yes | No |
| `clockOutTime` | `forceLogoutAgent` | `SupervisorDashboard.tsx` | Supervisor Force Logout | Yes | Yes | No |
| `clockOutTime` | `performTmsStaleSessionCleanup` | `tmsCleanupService.ts` | >16h stale sessions | Yes | Yes | No |
| `clockOutTime` | `repairAndNormalizeShift` | `tmsCleanupService.ts` | Corrupted `clockOutTime` | Yes | Yes | No |
| `activities[]` | `handleAction` (all) | `TMSView.tsx` | User changes state | Yes (mutates last) | Yes | No |
| `activities[]` | `forceLogoutAgent` | `SupervisorDashboard.tsx` | Supervisor Force Logout | Yes (mutates last) | Yes | No |
| `activities[]` | `repairAndNormalizeShift` | `tmsCleanupService.ts` | Clock skew / limits | Yes (rebuilds) | Yes | No |
| `attendanceSummary` | `syncShiftToAttendance` | `attendanceSyncService.ts` | Shift updates | Yes | Yes | No |
| `attendanceSummary` | `bulkUpdate` / `handleSaveEdit` | `AttendanceDashboard.tsx` | Sync / Manual Edit | Yes | Yes | No |
| `timeline[]` | `repairAndNormalizeShift` | `tmsCleanupService.ts` | Shift repairs | Yes | Yes | No |

## Divergence Scenarios

### 1. Timeline says ENDED while Shift remains ACTIVE
* **Scenario A:** A stale shift cleanup runs in `tmsCleanupService.ts` but encounters a partial failure. It might update the `timeline` or `activities` array (setting `endTime`) but fail to update the root `status` to `AUTO_CLOSED`.
* **Scenario B:** The `truncateShiftToProductiveTime` function successfully terminates the final activity in `activities[]` but the outer transaction fails before setting `status = 'COMPLETED'`.
* **Scenario C:** Manual database edits or partial syncs leave `clockOutTime` populated but the `live_sessions` document is still broadcasting `ACTIVE` because it wasn't cleared.

### 2. ClockOut differs across collections
* **Scenario A:** A supervisor does a force logout, which updates `tmsShifts` `clockOutTime`. But the `attendanceSummary` document isn't correctly re-synced if `syncShiftToAttendance` isn't triggered, leaving attendance pointing to a missing or different time.
* **Scenario B:** An Admin manually edits the "Productive Minutes" or "Status" in the `AttendanceDashboard`, which alters `attendanceSummary` but does NOT back-propagate to `tmsShifts`. The Chronological Report (reading `activities[]`) will show different durations than the Attendance Report.
* **Scenario C:** `tmsCleanupService` identifies a 10h artifact and auto-adjusts `clockOutTime`. It does not always guarantee a re-sync to `attendanceSummary`.

## Root Cause Summary
There are too many independent services updating the same documents and duplicating the "state" of the system across fields (`clockOutTime`, `status`, `activities[]`, `timeline[]`, `attendanceSummary`). 
Because operations rely on "read-modify-write" (mutating the last element in an array or overwriting a field) instead of an immutable append-only event ledger, network partitions, concurrent writes, and sequential cron jobs frequently overwrite each other.

