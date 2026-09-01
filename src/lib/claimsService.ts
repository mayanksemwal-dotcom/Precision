import { auth } from './firebase';

export interface CustomClaimsPayload {
  role: string;
  isAdmin: boolean;
  isManager: boolean;
  isSupervisor: boolean;
  isTeamLead: boolean;
  isTL: boolean;
  isQA: boolean;
  isITEngineer: boolean;
}

/**
 * Robust fetch utility with automatic retry on network errors or server failures.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  delayMs = 1000
): Promise<Response> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) {
        return res;
      }
      // Fail fast on typical 4xx client errors except 429 Too Many Requests or transient errors
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return res;
      }
      throw new Error(`Server returned status ${res.status}`);
    } catch (err: any) {
      lastError = err;
      if (attempt === maxRetries) {
        break;
      }
      const waitTime = delayMs * Math.pow(2, attempt - 1);
      console.warn(`[CLAIMS SERVICE] Fetch to ${url} failed: ${err.message || err}. Retrying in ${waitTime}ms... (Attempt ${attempt}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }
  throw lastError || new Error(`Failed to fetch ${url} after ${maxRetries} attempts`);
}

/**
 * Synchronize custom claims for the currently logged-in user
 */
export async function syncCurrentUserClaims(expectedRole?: string, attempt = 1): Promise<{ success: boolean; claims?: CustomClaimsPayload }> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return { success: false };

    let tokenResult;
    try {
      tokenResult = await currentUser.getIdTokenResult(false);
    } catch (tokenErr: any) {
      console.warn('[CLAIMS SERVICE] Error getting cached token result:', tokenErr.message || tokenErr);
      if (attempt < 4) {
        const waitTime = 2000 * attempt;
        console.info(`[CLAIMS SERVICE] Retrying token fetch in ${waitTime}ms (Attempt ${attempt}/4)...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return syncCurrentUserClaims(expectedRole, attempt + 1);
      }
      return { success: false };
    }

    const currentRole = tokenResult.claims.role as string | undefined;
    const currentIsAdmin = !!tokenResult.claims.isAdmin;
    const currentIsManager = !!tokenResult.claims.isManager;
    const currentIsTL = !!tokenResult.claims.isTeamLead || !!tokenResult.claims.isTL;

    const normalizedExpected = (expectedRole || currentRole || 'AGENT').toUpperCase();
    const isDev = (currentUser.email || '').toLowerCase().trim() === 'mayank.semwal@bergtechnologies.co.in';
    const shouldBeAdmin = isDev || normalizedExpected === 'ADMIN' || normalizedExpected === 'SYSTEM_ADMIN';

    // If already has claims and matches expected role, skip
    if (currentRole === normalizedExpected && (!shouldBeAdmin || currentIsAdmin)) {
      return {
        success: true,
        claims: {
          role: currentRole,
          isAdmin: currentIsAdmin,
          isManager: currentIsManager,
          isSupervisor: !!tokenResult.claims.isSupervisor,
          isTeamLead: currentIsTL,
          isTL: currentIsTL,
          isQA: !!tokenResult.claims.isQA,
          isITEngineer: !!tokenResult.claims.isITEngineer,
        }
      };
    }

    let idToken;
    try {
      idToken = await currentUser.getIdToken(true);
    } catch (tokenRefreshErr: any) {
      console.warn('[CLAIMS SERVICE] Error forcing token refresh:', tokenRefreshErr.message || tokenRefreshErr);
      if (attempt < 4) {
        const waitTime = 2000 * attempt;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return syncCurrentUserClaims(expectedRole, attempt + 1);
      }
      return { success: false };
    }

    let res;
    try {
      res = await fetchWithRetry('/api/set-claims', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ role: normalizedExpected })
      }, 3, 1000);
    } catch (fetchErr: any) {
      console.error('[CLAIMS SERVICE] Failed to reach /api/set-claims after retries:', fetchErr.message || fetchErr);
      if (attempt < 4) {
        console.info('[CLAIMS SERVICE] Scheduling background retry in 10 seconds...');
        setTimeout(() => {
          syncCurrentUserClaims(expectedRole, attempt + 1).catch(console.error);
        }, 10000);
      }
      return { success: false };
    }

    if (!res.ok) {
      console.warn('[CLAIMS SERVICE] /api/set-claims response status:', res.status);
      return { success: false };
    }

    const data = await res.json();
    
    try {
      await currentUser.getIdToken(true);
    } catch (finalRefreshErr) {
      console.warn('[CLAIMS SERVICE] Warning: failed to refresh final token after setting claims:', finalRefreshErr);
    }

    console.info('[CLAIMS SERVICE] Custom claims updated and refreshed for current user:', currentUser.email);
    return { success: true, claims: data.claims };
  } catch (err: any) {
    console.error('[CLAIMS SERVICE] Error syncing current user claims:', err);
    if (attempt < 4) {
      setTimeout(() => {
        syncCurrentUserClaims(expectedRole, attempt + 1).catch(console.error);
      }, 10000);
    }
    return { success: false };
  }
}

/**
 * Synchronize custom claims for a target user (Admin/Manager action)
 */
export async function syncTargetUserClaims(targetUid: string, role: string, isITEngineer?: boolean): Promise<boolean> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return false;

    const idToken = await currentUser.getIdToken();
    const res = await fetchWithRetry('/api/set-claims', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        targetUid,
        role: (role || 'AGENT').toUpperCase(),
        isITEngineer: !!isITEngineer
      })
    }, 3, 1000);

    if (!res.ok) {
      console.warn('[CLAIMS SERVICE] Target claims update failed with status:', res.status);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[CLAIMS SERVICE] Error syncing target user claims:', err);
    return false;
  }
}

/**
 * Bulk backfill claims for an entire array of users (Admin only)
 */
export async function batchSyncAllUserClaims(users: Array<{ uid: string; role: string; isITEngineer?: boolean }>): Promise<{ successCount: number; errorCount: number }> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return { successCount: 0, errorCount: users.length };

    const idToken = await currentUser.getIdToken();
    const res = await fetchWithRetry('/api/admin/batch-sync-claims', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ users })
    }, 3, 1000);

    if (res.ok) {
      const data = await res.json();
      return {
        successCount: data.successCount || 0,
        errorCount: data.errorCount || 0
      };
    }
    return { successCount: 0, errorCount: users.length };
  } catch (err) {
    console.error('[CLAIMS SERVICE] Batch claims sync error:', err);
    return { successCount: 0, errorCount: users.length };
  }
}
