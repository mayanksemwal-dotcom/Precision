/**
 * FIRESTORE OPERATION LOGGER & COST TRACKER
 * -----------------------------------------
 * Tracks and aggregates Firestore read/write operations to help developers
 * debug and optimize daily Firestore quota usage.
 */

interface CollectionStats {
  reads: number;
  writes: number;
  calls: number;
}

export interface FirestoreReadLogEntry {
  timestamp: string;
  collection: string;
  queryFingerprint: string;
  caller: string;
  trigger: string;
  resultCount: number;
  isCacheHit: boolean;
}

class FirestoreLogger {
  private totalReads = 0;
  private totalWrites = 0;
  private statsBySource: Record<string, CollectionStats> = {};
  private readLogs: FirestoreReadLogEntry[] = [];
  private maxLogs = 500;

  constructor() {
    if (typeof window !== 'undefined') {
      // Expose to window for live debugging in browser dev console
      (window as any).firestoreLogger = this;
      console.log('📈 [Firestore Logger] Initialized! Call window.firestoreLogger.logStats() or window.firestoreLogger.printDetailedReadLogs() to inspect live usage.');
    }
  }

  private getTracker(sourceName: string): CollectionStats {
    const cleanName = sourceName || 'unknown';
    if (!this.statsBySource[cleanName]) {
      this.statsBySource[cleanName] = { reads: 0, writes: 0, calls: 0 };
    }
    return this.statsBySource[cleanName];
  }

  /**
   * Tracks a Firestore read operation with full forensic metadata.
   */
  public trackReadDetailed(entry: {
    collection: string;
    queryFingerprint: string;
    caller: string;
    trigger: string;
    resultCount: number;
    isCacheHit?: boolean;
  }) {
    const count = Math.max(0, entry.resultCount);
    const isHit = !!entry.isCacheHit;

    if (!isHit) {
      this.totalReads += count;
    }

    const sourceName = `${entry.collection}::${entry.caller}`;
    const tracker = this.getTracker(sourceName);
    if (!isHit) {
      tracker.reads += count;
    }
    tracker.calls += 1;

    const logEntry: FirestoreReadLogEntry = {
      timestamp: new Date().toISOString(),
      collection: entry.collection,
      queryFingerprint: entry.queryFingerprint,
      caller: entry.caller,
      trigger: entry.trigger,
      resultCount: count,
      isCacheHit: isHit
    };

    this.readLogs.push(logEntry);
    if (this.readLogs.length > this.maxLogs) {
      this.readLogs.shift();
    }

    const statusTag = isHit ? '🟢 CACHE_HIT' : '🔴 SERVER_READ';
    console.info(
      `[FIRESTORE_TRACE] ${statusTag} | time=${logEntry.timestamp} | col=${entry.collection} | caller=${entry.caller} | trigger=${entry.trigger} | count=${count} | query=${entry.queryFingerprint}`
    );
  }

  /**
   * Tracks a Firestore read operation.
   * @param sourceName Description or collection name of the query (e.g. "users_fetch_listener" or "historical_shifts")
   * @param documentCount Number of documents read in this operation (e.g. snapshot.docs.length or querySnap.size)
   */
  public trackRead(sourceName: string, documentCount: number = 1) {
    const count = Math.max(0, documentCount);
    this.totalReads += count;
    
    const tracker = this.getTracker(sourceName);
    tracker.reads += count;
    tracker.calls += 1;

    this.printToConsole(`🟢 READ from [${sourceName}] - Added ${count} document reads.`);
  }

  /**
   * Tracks a Firestore write operation (setDoc, updateDoc, deleteDoc, batch, etc.).
   * @param sourceName Description or collection name of the write (e.g. "user_profile_sync")
   * @param documentCount Number of documents written in this operation (usually 1, or batch.size)
   */
  public trackWrite(sourceName: string, documentCount: number = 1) {
    const count = Math.max(0, documentCount);
    this.totalWrites += count;

    const tracker = this.getTracker(sourceName);
    tracker.writes += count;
    tracker.calls += 1;

    this.printToConsole(`🟡 WRITE to [${sourceName}] - Added ${count} document writes.`);
  }

  /**
   * Retrieves the current aggregated statistics.
   */
  public getStats() {
    return {
      totalReads: this.totalReads,
      totalWrites: this.totalWrites,
      statsBySource: this.statsBySource
    };
  }

  /**
   * Resets all tracked operations.
   */
  public resetStats() {
    this.totalReads = 0;
    this.totalWrites = 0;
    this.statsBySource = {};
    console.log('📈 [Firestore Logger] Statistics reset.');
  }

  /**
   * Outputs a beautifully formatted table of all Firestore operations to the developer console.
   */
  public logStats() {
    console.log('\n=============================================================');
    console.log(`📊 [FIRESTORE USAGE REPORT] Local Time: ${new Date().toLocaleTimeString()}`);
    console.log(`Cumulative Reads:  ${this.totalReads}`);
    console.log(`Cumulative Writes: ${this.totalWrites}`);
    console.log('=============================================================');
    
    if (Object.keys(this.statsBySource).length === 0) {
      console.log('No operations tracked yet.');
    } else {
      console.table(
        Object.entries(this.statsBySource).map(([source, stats]) => ({
          'Source/Collection': source,
          'Total Reads': stats.reads,
          'Total Writes': stats.writes,
          'Operation Calls': stats.calls,
          'Avg Reads/Call': stats.calls > 0 ? Number((stats.reads / stats.calls).toFixed(1)) : 0
        }))
      );
    }
    console.log('=============================================================\n');
  }

  /**
   * Prints the granular trace table of recent Firestore reads.
   */
  public printDetailedReadLogs() {
    console.log('\n=============================================================');
    console.log(`🔎 [DETAILED FIRESTORE READ TRACE] Total Tracked Events: ${this.readLogs.length}`);
    console.log('=============================================================');
    if (this.readLogs.length === 0) {
      console.log('No read operations tracked yet.');
    } else {
      console.table(
        this.readLogs.map(l => ({
          Timestamp: l.timestamp,
          Collection: l.collection,
          Caller: l.caller,
          Trigger: l.trigger,
          Docs: l.resultCount,
          Status: l.isCacheHit ? 'CACHE_HIT' : 'SERVER_READ',
          Query: l.queryFingerprint.length > 60 ? l.queryFingerprint.substring(0, 57) + '...' : l.queryFingerprint
        }))
      );
    }
    console.log('=============================================================\n');
  }

  public getReadLogs(): FirestoreReadLogEntry[] {
    return [...this.readLogs];
  }

  private printToConsole(message: string) {
    console.log(`📊 [Firestore Stats] ${message} | Cumulative Reads: ${this.totalReads} | Cumulative Writes: ${this.totalWrites}`);
  }
}

export const firestoreLogger = new FirestoreLogger();
