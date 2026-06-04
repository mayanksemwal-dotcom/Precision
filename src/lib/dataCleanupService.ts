import { db } from './firebase';
import { collection, doc, writeBatch, getDocs, query, where, Timestamp } from 'firebase/firestore';
import { runDynamicKPIEngine } from './kpiEngine';

export interface AuditLog {
  deletedBy: string;
  deletedAt: Timestamp;
  recordType: string;
  recordCount: number;
  recordIds: string[];
  reason: string;
}

export const createAuditLog = async (log: AuditLog) => {
    const batch = writeBatch(db);
    const logRef = doc(collection(db, 'audit_logs'));
    batch.set(logRef, log);
    await batch.commit();
}

// Cascade delete logic for kpi_uploads
export const performCascadeDeleteKpiUploads = async (records: any[], reason: string, userEmail: string) => {
    const recordIds = records.map(r => r.docId);
    
    // Track unique affected reporting periods
    const deletedPeriods = Array.from(new Set(records.map(r => r.reportingPeriod).filter(Boolean))) as string[];
    
    // Chunk records into batches of 400
    const chunkSize = 400;
    for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        
        chunk.forEach(r => {
            console.log(`Preparing to delete kpi_uploads docId: ${r.docId}`);
            batch.delete(doc(db, 'kpi_uploads', r.docId));
        });
        
        // Add audit log on the last batch
        if (i + chunkSize >= records.length) {
            const auditLog: AuditLog = {
                deletedBy: userEmail,
                deletedAt: Timestamp.now(),
                recordType: 'kpi_uploads',
                recordCount: records.length,
                recordIds: recordIds,
                reason: reason
            };
            batch.set(doc(collection(db, 'audit_logs')), auditLog);
        }
        
        try {
            console.log(`Committing batch delete for kpi_uploads...`);
            await batch.commit();
            console.log(`Batch commit successful.`);
        } catch (error: any) {
            console.error(`Error committing batch delete for kpi_uploads:`, error);
            console.error(`User: ${userEmail}, Record IDs: ${recordIds.slice(i, i + chunkSize).join(', ')}`);
            throw error; // Re-throw to be caught by UI
        }
    }

    // Post-deletion cascade recalculation
    if (deletedPeriods.length > 0) {
        try {
            console.log(`Cascade: Triggering engine recalculations for affected periods: ${deletedPeriods.join(', ')}`);
            const usersSnap = await getDocs(collection(db, 'users'));
            const allUsers = usersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            for (const period of deletedPeriods) {
                await runDynamicKPIEngine(period, allUsers);
            }
        } catch (e) {
            console.error('Cascading update failed:', e);
        }
    }
}
