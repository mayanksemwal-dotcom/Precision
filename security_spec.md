# Firestore Security Specification - Precision360

## Data Invariants
1. **User Profiles**: Only the user themselves or an Admin can modify their profile. Roles can only be modified by Admins.
2. **Tasks**: Can be created/updated by Admins, Managers, and QAs. Agents have read-only access to tasks assigned to them.
3. **Audits**: Created by QAs. Read access depends on roles (Agent sees their own, TL sees team, Admin sees all).
4. **PIPs/Warnings**: Created by TLs/Managers/Admins. Agents can read and acknowledge their own.
5. **Daily Targets/Performance**: Managed by TLs/Managers/Admins. Agents read their own.

## The "Dirty Dozen" Payloads (Denial Expected)
1. **Identity Spoofing**: Attempt to create a `AuditRecord` with `agentId` of another user.
2. **Privilege Escalation**: Non-admin user trying to update their own `role` to 'ADMIN' in `users` collection.
3. **Shadow Field Injection**: Adding an `isVerified: true` field to a `WarningTicket` update.
4. **State Shortcutting**: Transitioning a `PipRecord` from 'Initiated' directly to 'Passed' without a review.
5. **Orphaned Record**: Creating an `AuditRecord` with a non-existent `taskId`.
6. **Path Poisoning**: Providing a 1KB string as an ID for `disciplinaryLogs`.
7. **PII Leak**: Agent trying to `get()` the `UserProfile` of another agent.
8. **Unauthorized List**: Agent trying to `list()` all `audits` without a filter on their `agentId`.
9. **Timestamp Manipulation**: Providing a future `createdAt` timestamp from the client.
10. **Immutable Field Breach**: Trying to change the `agentId` of an existing `PipRecord`.
11. **Bulk Scrape**: Unauthenticated user trying to `list()` tasks.
12. **Cross-Tenant Write**: User A trying to update User B's `DailyPerformance` record.

## Rules Draft Strategy
- Use `isValidUserProfile`, `isValidAudit`, etc. helpers.
- Enforce `request.time` for all timestamps.
- Use `hasOnly()` for all updates.
- Role checks via `get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role`.
