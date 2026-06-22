import { db } from './firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export interface EmailPayload {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  message: {
    subject: string;
    text: string;
    html: string;
  };
  createdAt?: any;
  status?: string;
  metadata?: Record<string, any>;
}

/**
 * Triggers an email dispatch via the "Trigger Email from Firestore" extension.
 * Standardizes the document schema for the 'mail' and 'emails' collections.
 */
export async function triggerEmail(payload: EmailPayload): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const now = serverTimestamp();
    
    // The standard Firebase "Trigger Email" extension expects this structure
    const extensionDoc: any = {
      to: Array.isArray(payload.to) ? payload.to : [payload.to],
      message: {
        subject: payload.message.subject,
        text: payload.message.text,
        html: payload.message.html,
      },
      // Using serverTimestamp() is more robust for extension triggers and sorting
      createdAt: now, 
      metadata: {
        ...payload.metadata,
        triggeredAt: new Date().toISOString(),
        source: 'Precision360_Web_App'
      }
    };

    // Only add cc/bcc if they have valid values to avoid extension processing errors
    if (payload.cc && (Array.isArray(payload.cc) ? payload.cc.length > 0 : String(payload.cc).trim().length > 0)) {
      extensionDoc.cc = Array.isArray(payload.cc) ? payload.cc : [payload.cc];
    }
    if (payload.bcc && (Array.isArray(payload.bcc) ? payload.bcc.length > 0 : String(payload.bcc).trim().length > 0)) {
      extensionDoc.bcc = Array.isArray(payload.bcc) ? payload.bcc : [payload.bcc];
    }

    // Explicitly add 'from' if it's not provided in the payload
    extensionDoc.from = (payload as any).from || 'compliance@bergtechnologies.co.in';

    // 1. Write to 'mail' (extension default)
    const mailCol = collection(db, 'mail');
    
    // Standardize top-level fields for broad extension compatibility
    const mailDoc = {
      ...extensionDoc,
      status: 'pending' // Added for extensions that might look for an initial status
    };
    
    const docRef = await addDoc(mailCol, mailDoc);

    // 2. Write to 'emails' (dashboard history & secondary trigger point)
    try {
      await addDoc(collection(db, 'emails'), {
        ...mailDoc,
        // We include 'pending' as a status fallback for our custom UI
        status: 'pending',
        mailCollectionId: docRef.id,
        triggerId: docRef.id
      });
    } catch (auditErr) {
      console.warn("Email queued in 'mail' but failed to write to internal 'emails' collection:", auditErr);
    }

    return { success: true, id: docRef.id };
  } catch (err: any) {
    console.error("Failed to trigger email via Firestore:", err);
    return { success: false, error: err.message || String(err) };
  }
}
