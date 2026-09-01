/**
 * Utility functions for formatting and managing audit notes on user profiles,
 * specifically ensuring that any status change to 'Inactive' (manual, bulk, edit, CSV, or auto)
 * logs a structured, timestamped reason entry.
 */

export interface InactiveReasonLogOptions {
  existingNotes?: string | null;
  reason: string;
  author?: string | null;
  triggerType?: 'Manual' | 'Auto' | 'Bulk' | 'CSV' | 'Edit' | 'Creation' | 'System' | 'Security';
}

export const INACTIVE_REASON_PRESETS = [
  'Resignation / Resigned',
  'Absconding / Left without notice',
  'Termination / Disciplinary Action',
  'Extended Medical / Personal Leave',
  'End of Contract / Seasonal Completion',
  'Performance Under-Review / PIP',
  'Role Transition / Transferred to other unit',
  'Account Cleanup / Duplicate Profile',
  'Other / Custom'
] as const;

/**
 * Appends a structured, timestamped entry documenting why a user is marked Inactive.
 */
export function appendInactiveReasonNote(
  existingNotes: string | undefined | null,
  reason: string,
  author?: string | null,
  triggerType: 'Manual' | 'Auto' | 'Bulk' | 'CSV' | 'Edit' | 'Creation' | 'System' | 'Security' = 'Manual'
): string {
  const now = new Date();
  // Clean readable timestamp: e.g. "14 Aug 2026, 04:39 PM"
  const formattedDate = now.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
  const formattedTime = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  const timestamp = `${formattedDate}, ${formattedTime}`;

  const cleanAuthor = author ? author.trim() : 'System';
  const cleanReason = (reason && reason.trim()) ? reason.trim() : 'No specific reason provided';

  const entry = `[${timestamp} | Status: INACTIVE | ${triggerType} by ${cleanAuthor}]\nReason: ${cleanReason}`;

  if (!existingNotes || !existingNotes.trim()) {
    return entry;
  }

  return `${existingNotes.trim()}\n\n${entry}`;
}

/**
 * Appends a structured, timestamped entry documenting when a user's status is restored to Active.
 */
export function appendActiveReasonNote(
  existingNotes: string | undefined | null,
  reason?: string | null,
  author?: string | null,
  triggerType: 'Manual' | 'Auto' | 'Bulk' | 'CSV' | 'Edit' | 'Security' = 'Manual'
): string {
  const now = new Date();
  const formattedDate = now.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
  const formattedTime = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  const timestamp = `${formattedDate}, ${formattedTime}`;

  const cleanAuthor = author ? author.trim() : 'System';
  const reasonSuffix = (reason && reason.trim()) ? ` - Note: ${reason.trim()}` : '';

  const entry = `[${timestamp} | Status: ACTIVE | ${triggerType} by ${cleanAuthor}]\nStatus restored to Active${reasonSuffix}`;

  if (!existingNotes || !existingNotes.trim()) {
    return entry;
  }

  return `${existingNotes.trim()}\n\n${entry}`;
}
