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

class FirestoreLogger {
  private totalReads = 0;
  private totalWrites = 0;
  private statsBySource: Record<string, CollectionStats> = {};

  constructor() {
    if (typeof window !== 'undefined') {
      // Expose to window for live debugging in browser dev console
      (window as any).firestoreLogger = this;
      console.log('📈 [Firestore Logger] Initialized! Call window.firestoreLogger.logStats() to inspect live usage.');
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

  private printToConsole(message: string) {
    console.log(`📊 [Firestore Stats] ${message} | Cumulative Reads: ${this.totalReads} | Cumulative Writes: ${this.totalWrites}`);
  }
}

export const firestoreLogger = new FirestoreLogger();
