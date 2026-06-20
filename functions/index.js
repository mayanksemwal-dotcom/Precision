const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

// Initialize Firebase Admin
admin.initializeApp();

// Helper to clean and parse recipient addresses
function parseAddresses(input) {
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
 * processQueuedEmails
 * Triggered on creation of a document in the 'emails' collection on the custom Firestore database.
 */
exports.processQueuedEmails = onDocumentCreated({
  document: "emails/{documentId}",
  database: "ai-studio-69f7a1ee-9b74-4113-9d67-df0f0cfb56c0",
  secrets: ["SMTP_USER", "SMTP_PASS"] // Use Google Cloud Secret Manager secrets
}, async (event) => {
  const snapshot = event.data;
  if (!snapshot) {
    logger.warn("[processQueuedEmails] Event had no data snapshot.");
    return null;
  }

  const docId = event.params.documentId;
  const data = snapshot.data();

  logger.info(`[processQueuedEmails] Triggered on document creation for doc ID: ${docId}`, { data });

  // Safety gate: only process if status is 'pending'
  if (data.status !== "pending") {
    logger.info(`[processQueuedEmails] Document ${docId} status is ${data.status || 'undefined'}. Skipping processing.`);
    return null;
  }

  const docRef = snapshot.ref;

  // Move status immediately to 'processing' to implement lease/lock & avoid double execution
  try {
    await docRef.update({
      status: "processing",
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastAttemptAt: admin.firestore.FieldValue.serverTimestamp()
    });
    logger.info(`[processQueuedEmails] Marked document ${docId} as processing.`);
  } catch (err) {
    logger.error(`[processQueuedEmails] Failed to update document lock status for ${docId}:`, err);
    return null;
  }

  // Retrieve secrets from environment
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    const errorMsg = "SMTP_USER or SMTP_PASS environment secrets are not configured or empty.";
    logger.error(`[processQueuedEmails] [Email Failed] ${errorMsg}`);
    await docRef.update({
      status: "failed",
      errorMessage: errorMsg,
      retryCount: (data.retryCount || 0) + 1,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return null;
  }

  // Extract recipient and structure
  const toAddress = parseAddresses(data.to || (data.message && data.message.to));
  const ccAddress = parseAddresses(data.cc || (data.message && data.message.cc));
  const bccAddress = parseAddresses(data.bcc || (data.message && data.message.bcc));
  const subject = data.subject || (data.message && data.message.subject) || "Precision360 System Alert";
  const text = data.text || (data.message && data.message.text) || "";
  const html = data.html || (data.message && data.message.html) || "";
  const sender = data.from || `Precision360 <${smtpUser}>`;

  if (!toAddress) {
    const errorMsg = "Missing recipient: email 'to' address list is empty or invalid.";
    logger.error(`[processQueuedEmails] [Email Failed] ${errorMsg}`);
    await docRef.update({
      status: "failed",
      errorMessage: errorMsg,
      retryCount: (data.retryCount || 0) + 1,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return null;
  }

  // Create transporter using SMTP Port 465 (Secure SSL)
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: smtpUser,
      pass: smtpPass
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  try {
    logger.info(`[processQueuedEmails] SMTP Connecting to smtp.gmail.com:465 with ${smtpUser}...`);
    await transporter.verify();
    logger.info("[processQueuedEmails] SMTP Connected successfully.");
  } catch (connErr) {
    const errorMsg = `SMTP connection verification failed: ${connErr.message || String(connErr)}`;
    logger.error(`[processQueuedEmails] [Email Failed] ${errorMsg}`);
    await docRef.update({
      status: "failed",
      errorMessage: errorMsg,
      retryCount: (data.retryCount || 0) + 1,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return null;
  }

  // Dispatch individual email
  try {
    const mailOptions = {
      from: sender,
      to: toAddress,
      cc: ccAddress,
      bcc: bccAddress,
      subject: subject,
      text: text,
      html: html
    };

    logger.info(`[processQueuedEmails] Attempting email transmission to ${toAddress}...`);
    const info = await transporter.sendMail(mailOptions);
    logger.info(`[processQueuedEmails] [Email Sent] Successfully delivered doc ${docId}. Message ID: ${info.messageId}`);

    await docRef.update({
      status: "sent",
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      errorMessage: null
    });
  } catch (sendErr) {
    const errorMsg = `Nodemailer transmission failure: ${sendErr.message || String(sendErr)}`;
    logger.error(`[processQueuedEmails] [Email Failed] Dispatch failed:`, sendErr);
    await docRef.update({
      status: "failed",
      errorMessage: errorMsg,
      retryCount: (data.retryCount || 0) + 1,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  return null;
});
