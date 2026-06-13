import admin from 'firebase-admin';
import nodemailer from 'nodemailer';

// Configuration parsed from environment variables (Secret Manager)
export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

export function getSmtpConfig(): SmtpConfig {
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'compliance@bergtechnologies.co.in'
  };
}

/**
 * Creates and returns a Nodemailer Transporter if credentials are configured.
 */
function createTransporter(config: SmtpConfig) {
  if (!config.user || !config.pass) {
    return null;
  }
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465, // true for 465, false for 587/other
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      // Allow self-signed or unauthorized certificates for general resilience
      rejectUnauthorized: false
    }
  });
}

function parseAddresses(input: any): string | string[] | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    return input.map(s => String(s).trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input.split(',').map(s => s.trim()).filter(Boolean);
  }
  return String(input).trim();
}

/**
 * Starts a real-time listener on the Firestore 'emails' collection to process queues in real-time.
 */
export function startEmailWorker(db: admin.firestore.Firestore) {
  console.log('[EMAIL WORKER] Initializing custom background trigger listener...');

  const config = getSmtpConfig();
  const hasCreds = !!(config.user && config.pass);
  
  if (!hasCreds) {
    console.warn('[EMAIL WORKER] WARNING: SMTP credentials NOT configured. Email delivery will mark entries as failed with configuration detail.');
  } else {
    console.log(`[EMAIL WORKER] SMTP Transport Active: ${config.host}:${config.port} (${config.user})`);
  }

  // Subscribe to documents in the 'emails' collection that have status 'pending'
  db.collection('emails')
    .where('status', '==', 'pending')
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const doc = change.doc;
          const docData = doc.data();
          const docRef = doc.ref;

          console.log(`[Firebase Function processQueuedEmails - Function Triggered] Triggered on document creation for doc ID: ${doc.id}`);

          // De-duplicate / lease check: instantly transition to 'processing' to lock the document
          try {
            await docRef.update({
              status: 'processing'
            });
          } catch (lockErr) {
            console.error(`[Firebase Function processQueuedEmails - Email Failed] Failed to secure document lock for ${doc.id}:`, lockErr);
            return; // Already processed or failed to update path
          }

          // Extract standard and custom nested fields
          const toAddress = parseAddresses(docData.to || docData.message?.to);
          const ccAddress = parseAddresses(docData.cc || docData.message?.cc);
          const bccAddress = parseAddresses(docData.bcc || docData.message?.bcc);
          const emailSubject = docData.subject || docData.message?.subject || 'Precision360 Alert';
          const emailText = docData.text || docData.message?.text || '';
          const emailHtml = docData.html || docData.message?.html || '';

          const sender = docData.from || config.from;

          // Perform validation
          if (!toAddress) {
            console.error(`[Firebase Function processQueuedEmails - Email Failed] Invalid email document ${doc.id}: Missing recipient address.`);
            await docRef.update({
              status: 'failed',
              errorMessage: 'Invalid recipient: email "to" address is missing.',
              retryCount: (docData.retryCount || 0) + 1,
              completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return;
          }

          // Verify configuration is active
          console.log(`[Firebase Function processQueuedEmails - SMTP Connecting] SMTP Connecting to ${config.host}:${config.port}...`);
          const transporter = createTransporter(config);
          if (!transporter) {
            const warningMsg = 'SMTP Transport configuration is inactive. Check SMTP_USER & SMTP_PASS secret variables.';
            console.error(`[Firebase Function processQueuedEmails - Email Failed] ${warningMsg}`);
            await docRef.update({
              status: 'failed',
              errorMessage: warningMsg,
              retryCount: (docData.retryCount || 0) + 1,
              completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return;
          }

          // Verify SMTP Connected (verify connection)
          try {
            await transporter.verify();
            console.log(`[Firebase Function processQueuedEmails - SMTP Connected] SMTP Connected successfully with host ${config.host}`);
          } catch (verifyErr: any) {
            const smtpVerifyMsg = `SMTP Connection validation failed: ${verifyErr?.message || String(verifyErr)}`;
            console.error(`[Firebase Function processQueuedEmails - Email Failed] ${smtpVerifyMsg}`);
            await docRef.update({
              status: 'failed',
              errorMessage: smtpVerifyMsg,
              retryCount: (docData.retryCount || 0) + 1,
              completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return;
          }

          // Dispatch the mail
          try {
            const mailOptions = {
              from: sender,
              to: toAddress,
              cc: ccAddress,
              bcc: bccAddress,
              subject: emailSubject,
              text: emailText,
              html: emailHtml
            };

            await transporter.sendMail(mailOptions);
            
            console.log(`[Firebase Function processQueuedEmails - Email Sent] Email Sent successfully for doc ${doc.id} to ${toAddress}`);
            await docRef.update({
              status: 'sent',
              sentAt: admin.firestore.FieldValue.serverTimestamp(),
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
              retryCount: (docData.retryCount || 0)
            });
          } catch (sendErr: any) {
            console.error(`[Firebase Function processQueuedEmails - Email Failed] Email Failed: Dispatch failed for doc ${doc.id}:`, sendErr);
            const currentRetry = (docData.retryCount || 0) + 1;
            await docRef.update({
              status: 'failed',
              errorMessage: sendErr?.message || String(sendErr),
              retryCount: currentRetry,
              completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      });
    }, (error) => {
      console.error('[EMAIL WORKER] Firestore trigger listener error:', error);
    });
}
