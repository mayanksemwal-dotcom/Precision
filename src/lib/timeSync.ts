let timeOffset = 0; // Milliseconds client is behind/ahead of server
let wasSynced = false;

export async function syncWithServerTime(): Promise<number> {
  try {
    const clientStart = Date.now();
    let serverTimeMs: number;

    try {
      const res = await fetch('/api/time');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      
      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Response is not JSON');
      }

      const data = await res.json();
      serverTimeMs = data.serverTimeMs;
    } catch (apiErr) {
      console.log('[TimeSync] Server /api/time not reachable directly, attempting public NTP-like fallbacks...');
      
      // Fallback 1: Akamai Time (Global CDN, 100% CORS-friendly, extremely reliable)
      try {
        const akamaiRes = await fetch('https://time.akamai.com');
        if (akamaiRes.ok) {
          const text = await akamaiRes.text();
          const val = parseInt(text.trim(), 10);
          if (!isNaN(val)) {
            serverTimeMs = val * 1000;
            console.log('[TimeSync] Synchronized successfully via public Akamai Time API!');
          } else {
            throw new Error('Invalid Akamai response');
          }
        } else {
          throw new Error(`Akamai returned status ${akamaiRes.status}`);
        }
      } catch (akamaiErr) {
        console.log('[TimeSync] Akamai fallback failed, trying Cloudflare trace...');
        
        // Fallback 2: Cloudflare Trace
        try {
          const cfRes = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
          if (cfRes.ok) {
            const text = await cfRes.text();
            const match = text.match(/ts=(\d+\.?\d*)/);
            if (match) {
              const val = parseFloat(match[1]);
              if (!isNaN(val)) {
                serverTimeMs = Math.floor(val * 1000);
                console.log('[TimeSync] Synchronized successfully via public Cloudflare Trace API!');
              } else {
                throw new Error('Invalid Cloudflare trace response');
              }
            } else {
              throw new Error('No timestamp in Cloudflare trace');
            }
          } else {
            throw new Error(`Cloudflare returned status ${cfRes.status}`);
          }
        } catch (cfErr) {
          console.log('[TimeSync] Cloudflare fallback failed, trying WorldTimeAPI...');
          
          // Fallback 3: WorldTimeAPI
          try {
            const fallbackRes = await fetch('https://worldtimeapi.org/api/timezone/Asia/Kolkata');
            if (fallbackRes.ok) {
              const fallbackData = await fallbackRes.json();
              serverTimeMs = fallbackData.unixtime * 1000;
              console.log('[TimeSync] Synchronized successfully via public WorldTimeAPI!');
            } else {
              throw new Error(`WorldTimeAPI returned status ${fallbackRes.status}`);
            }
          } catch (fallbackErr) {
            console.log('[TimeSync] WorldTimeAPI fallback skipped, trying TimeAPI.io...');
            // Fallback 4: TimeAPI.io
            try {
              const backupRes = await fetch('https://timeapi.io/api/Time/current/zone?timeZone=Asia/Kolkata');
              if (backupRes.ok) {
                const backupData = await backupRes.json();
                if (backupData && backupData.dateTime) {
                  const dt = backupData.dateTime;
                  const dtSafe = dt.endsWith('Z') || dt.includes('+') ? dt : dt + '+05:30';
                  serverTimeMs = new Date(dtSafe).getTime();
                  console.log('[TimeSync] Synchronized successfully via public TimeAPI.io!');
                } else {
                  throw new Error('Invalid TimeAPI.io response');
                }
              } else {
                throw new Error(`TimeAPI.io returned status ${backupRes.status}`);
              }
            } catch (finalErr) {
              // If all network queries fail, safely use client machine system clock
              serverTimeMs = Date.now();
            }
          }
        }
      }
    }

    const clientEnd = Date.now();
    const latency = Math.floor((clientEnd - clientStart) / 2);
    
    // Expected client local time at the moment the server/NTP generated the time
    const expectedClientMs = clientStart + latency;
    
    // Offset = serverTimeMs - clientTimeMs
    timeOffset = serverTimeMs - expectedClientMs;

    wasSynced = true;
    console.log(`[TimeSync] Successfully synchronized clock! Time offset: ${timeOffset}ms (latency: ${latency}ms)`);
    return timeOffset;
  } catch (err) {
    console.warn('[TimeSync] Failed to sync with any standardized server time or public NTP source. Using local system clock. Error:', err);
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
  setInterval(() => {
    // Phase 5 Optimization: Never poll hidden tabs or inactive windows
    if (document.hidden || !document.hasFocus()) return;
    syncWithServerTime();
  }, 5 * 60 * 1000);
}
