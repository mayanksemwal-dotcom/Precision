# Security Specification

## Data Invariants
1. An AuditRecord must have an existing taskId and be linked to both a QA (creator) and an Agent (qvName).
2. Users can only edit their own UserProfile (limited fields).
3. QAs can only create AuditRecords for tasks assigned to them or unassigned tasks.

## The "Dirty Dozen" Payloads
1. Attempt to create AuditRecord with quality > 100.
2. Attempt to create AuditRecord with a different agentId than the one inferred from the task.
3. Attempt to update AuditRecord as an Agent (other than dispute fields).
4. Attempt to update UserProfile role to ADMIN as a regular user.
5. Attempt to read other users' documents in `users/` collection.
6. Attempt to delete an AuditRecord as a non-Admin.
7. Attempt to create a Task as a non-Admin/QA.
8. Attempt to update `config/main` as a non-Admin.
9. Attempt to create AuditRecord with invalid `status` string.
10. Attempt to spoof `qaId` in AuditRecord creation.
11. Attempt to bypass `isValidId` with 2MB ID string.
12. Attempt to write to `tasks/` as an Agent.

## Test Runner (Logic Verification)
A complete test file would verify that these all returned PERMISSION_DENIED.
