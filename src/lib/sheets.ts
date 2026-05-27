export interface SheetPayload {
  type: 'audit_submission' | 'dispute_submission' | 'dispute_resolution' | 'warning_issued';
  id: string;
  userEmail: string;
  userName: string;
  timestamp: string;
  payload: any;
}

/**
 * Submits an ordinary HTTP fetch() request sending data payload directly to the user's Google Sheets URL.
 */
export async function submitToGoogleSheet(
  type: SheetPayload['type'],
  id: string,
  userEmail: string,
  userName: string,
  payload: any
): Promise<boolean> {
  const url = 'https://script.google.com/macros/s/AKfycbzK4YFqkpma3U9rZuF_InR8fWws0pQv0zkGGC65NatjB830mRob3EOAwZ3pRvP_PFVV/exec';

  const body: SheetPayload = {
    type,
    id,
    userEmail: userEmail || '',
    userName: userName || '',
    timestamp: new Date().toISOString(),
    payload,
  };

  try {
    // Ordinary HTTP fetch
    await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      mode: 'no-cors', // standard gas redirection and compatibility
      headers: {
        'Content-Type': 'application/json'
      }
    });
    console.log(`Payload of type "${type}" sent to Google Sheets Webhook successfully.`);
    return true;
  } catch (error) {
    console.error('Failed to dispatch webhook to Google Sheets:', error);
    return false;
  }
}

/**
 * Standard free JSON fetching from the spreadsheet:
 * https://docs.google.com/spreadsheets/d/134mYoIcJPpVRMZGuuK5fU7Gldc5zg4VlZBQ4ptp4wvE/gviz/tq?tqx=out:json
 */
export async function fetchArchiveReports(): Promise<any[]> {
  const url = 'https://docs.google.com/spreadsheets/d/134mYoIcJPpVRMZGuuK5fU7Gldc5zg4VlZBQ4ptp4wvE/gviz/tq?tqx=out:json';
  try {
    const response = await fetch(url);
    const text = await response.text();
    
    const startIdx = text.indexOf('google.visualization.Query.setResponse(');
    if (startIdx !== -1) {
      const jsonStr = text.substring(startIdx + 'google.visualization.Query.setResponse('.length, text.length - 2);
      const data = JSON.parse(jsonStr);
      
      const cols = data.table.cols.map((col: any) => col.label || col.id || 'Column');
      const rows = data.table.rows.map((row: any) => {
        const obj: any = {};
        row.c.forEach((cell: any, index: number) => {
          const colName = cols[index] || `col_${index}`;
          // Extract formatted value (f) or raw value (v)
          obj[colName] = cell ? (cell.f !== undefined ? cell.f : cell.v) : '';
        });
        return obj;
      });
      return rows;
    }
  } catch (err) {
    console.error('Error fetching/parsing free JSON archive reports:', err);
    throw err;
  }
  return [];
}
