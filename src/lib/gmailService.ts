import { getGoogleAccessToken } from './firebase';

export interface GmailEmailConfig {
  to: string;
  cc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  fromEmail: string;
}

/**
 * Builds a MIME raw email formatted string and base64url-encodes it for the Gmail API.
 */
function buildRawEmail({ to, cc = [], subject, bodyText, bodyHtml, fromEmail }: GmailEmailConfig): string {
  const boundary = "boundary_precision360_" + Math.random().toString(36).substring(2, 10);
  
  const headers = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    cc.length > 0 ? `Cc: ${cc.join(', ')}` : '',
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].filter(Boolean);

  const parts = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    '',
    bodyText,
    '',
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    '',
    bodyHtml,
    '',
    `--${boundary}--`
  ];

  const emailStr = parts.join('\r\n');
  
  // Safe base64url encoding supporting utf-8 characters properly
  const utf8Bytes = new TextEncoder().encode(emailStr);
  let binaryStr = '';
  for (let i = 0; i < utf8Bytes.length; i++) {
    binaryStr += String.fromCharCode(utf8Bytes[i]);
  }
  const base64 = btoa(binaryStr);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Dispatches an email using the Gmail REST API if a cached Google OAuth access token is available.
 * Returns true if sent successfully via Gmail API, false otherwise.
 */
export async function sendEmailViaGmailApi(config: GmailEmailConfig): Promise<{ success: boolean; error?: string }> {
  const token = getGoogleAccessToken();
  if (!token) {
    return { 
      success: false, 
      error: 'Google OAuth access token is not cached. Please sign out and sign in using Google to register active Workspace scopes.' 
    };
  }

  try {
    const raw = buildRawEmail(config);
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gmail API Error Response:', errText);
      return { success: false, error: `Gmail API status ${response.status}: ${errText}` };
    }

    const data = await response.json();
    console.log('Successfully dispatched email via user Gmail API. Message ID:', data.id);
    return { success: true };
  } catch (err: any) {
    console.error('Failed to dispatch email via Gmail API:', err);
    return { success: false, error: err.message || String(err) };
  }
}
