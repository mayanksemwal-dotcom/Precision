let timeOffset = 0; // Milliseconds client is behind/ahead of server
let wasSynced = false;

export async function syncWithServerTime(): Promise<number> {
  try {
    const clientStart = Date.now();
    const res = await fetch('/api/time');
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();
    const clientEnd = Date.now();
    const latency = Math.floor((clientEnd - clientStart) / 2);
    
    const serverTimeMs = data.serverTimeMs;
    // Expected client local time at the moment the server generated the time
    const expectedClientMs = clientStart + latency;
    
    // Offset = serverTimeMs - clientTimeMs
    timeOffset = serverTimeMs - expectedClientMs;
    wasSynced = true;
    console.log(`[TimeSync] Successfully synchronized with server! Time offset: ${timeOffset}ms (latency: ${latency}ms)`);
    return timeOffset;
  } catch (err) {
    console.warn('[TimeSync] Failed to sync with server time, using local system clock. Error:', err);
    return 0;
  }
}

/**
 * Returns a synchronized Date object based on the latest server offset.
 */
export function getLiveTime(): Date {
  return new Date(Date.now() + timeOffset);
}

/**
 * Returns a synchronized ISO string based on the latest server offset.
 */
export function getLiveTimeISO(): string {
  return getLiveTime().toISOString();
}

/**
 * Returns whether the clock has successfully completed at least one server-side sync.
 */
export function isClockSynced(): boolean {
  return wasSynced;
}

// Automatically initiate sync on import
if (typeof window !== 'undefined') {
  syncWithServerTime();
  // Re-sync every 5 minutes to prevent drift
  setInterval(syncWithServerTime, 5 * 60 * 1000);
}
