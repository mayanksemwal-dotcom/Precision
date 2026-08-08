import { 
  collection, 
  query, 
  where, 
  orderBy, 
  limit, 
  startAfter, 
  QueryConstraint,
  DocumentSnapshot,
  WhereFilterOp
} from 'firebase/firestore';
import { db, getDocsOptimized } from './firebase';

export interface PaginationFilter {
  field: string;
  operator: WhereFilterOp;
  value: any;
}

export interface PaginationOptions {
  pageSize?: number;
  lastDoc?: DocumentSnapshot | null;
  filters?: PaginationFilter[];
  orderByField?: string;
  orderByDirection?: 'asc' | 'desc';
  forceRefresh?: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  lastDoc: DocumentSnapshot | null;
  hasMore: boolean;
}

/**
 * Highly optimized, cursor-based pagination helper for Firestore collections.
 * Leverages getDocsOptimized to prevent duplicate document reads and bypass quota errors.
 * 
 * Specifically designed for 'adminAuditLogs', 'attendance', and 'attendanceSummary'.
 */
export async function paginateCollection<T>(
  collectionName: 'adminAuditLogs' | 'attendance' | 'attendanceSummary',
  options: PaginationOptions = {}
): Promise<PaginatedResult<T>> {
  const {
    pageSize = 30,
    lastDoc = null,
    filters = [],
    orderByField = collectionName === 'attendanceSummary' || collectionName === 'attendance' ? 'attendanceDate' : 'timestamp',
    orderByDirection = 'desc',
    forceRefresh = false
  } = options;

  try {
    const colRef = collection(db, collectionName);
    const constraints: QueryConstraint[] = [];

    // Apply filters
    filters.forEach(f => {
      constraints.push(where(f.field, f.operator, f.value));
    });

    // Apply sorting
    constraints.push(orderBy(orderByField, orderByDirection));

    // Apply pagination limit (fetch pageSize + 1 to check for hasMore without an extra query)
    constraints.push(limit(pageSize + 1));

    // Apply start after cursor
    if (lastDoc) {
      constraints.push(startAfter(lastDoc));
    }

    const q = query(colRef, ...constraints);
    
    // Generate a unique cache key based on query configuration
    const filterKey = filters.map(f => `${f.field}:${f.operator}:${JSON.stringify(f.value)}`).join(';');
    const cursorKey = lastDoc ? `cursor_${lastDoc.id}` : 'start';
    const logPrefix = `paged_fetch_${collectionName}_${orderByField}_${orderByDirection}_limit_${pageSize}_${cursorKey}_${filterKey}`;

    const snap = await getDocsOptimized(q, logPrefix, forceRefresh);
    const docs = snap.docs;

    const hasMore = docs.length > pageSize;
    // If hasMore is true, exclude the extra check document
    const finalDocs = hasMore ? docs.slice(0, pageSize) : docs;

    const items = finalDocs.map(d => ({
      ...d.data(),
      id: d.id
    } as any as T));

    const newLastDoc = finalDocs.length > 0 ? finalDocs[finalDocs.length - 1] : null;

    return {
      items,
      lastDoc: newLastDoc,
      hasMore
    };
  } catch (error) {
    console.error(`Error in paginateCollection for ${collectionName}:`, error);
    return {
      items: [],
      lastDoc: null,
      hasMore: false
    };
  }
}
