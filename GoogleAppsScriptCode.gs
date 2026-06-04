/**
 * PRECISION360 - ENTERPRISE SCALABILITY DATABASE LAYER
 * --------------------------------------------------
 * Direct-to-Spreadsheet engine that reduces operations costs
 * to absolute zero. Operates as a highly scalable database engine
 * backing Workspace integrations, audits, warnings, configurations,
 * and workforce process shifts.
 */

// Resolve Spreadsheet ID safely to avoid global initialization crashes
let SPREADSHEET_ID;
function getSpreadsheetId() {
  if (SPREADSHEET_ID) return SPREADSHEET_ID;
  
  // 1. Try script properties
  try {
    const props = PropertiesService.getScriptProperties();
    const stored = props.getProperty('SPREADSHEET_ID');
    if (stored) {
      SPREADSHEET_ID = stored;
      return SPREADSHEET_ID;
    }
  } catch (e) {}

  // 2. Try active spreadsheet
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.getActive();
    if (active) {
      SPREADSHEET_ID = active.getId();
      // Cache it
      try {
        PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', SPREADSHEET_ID);
      } catch (err) {}
      return SPREADSHEET_ID;
    }
  } catch (e) {}

  // 3. Fallback descriptive error
  throw new Error("Spreadsheet ID could not be resolved automatically. Please bind this script to a Google Sheet manually, or add SPREADSHEET_ID inside Script Properties.");
}

// --- SHEET NAMES ---
const SHEETS = {
  RAW_UPLOADS: 'RAW_UPLOADS',
  AUDIT_QUEUE: 'AUDIT_QUEUE',
  USERS: 'USERS',
  TMS_SHIFTS: 'TMS_SHIFTS',
  TMS_PROCESSES: 'TMS_PROCESSES',
  WARNINGS: 'WARNINGS',
  ALIGNMENTS: 'ALIGNMENTS',
  AGENT_KPIS: 'AGENT_KPIS'
};

/**
 * Handles GET requests (Read Query Engine)
 */
function doGet(e) {
  const action = e.parameter.action;
  let result = { status: 'success', data: null };
  
  try {
    switch (action) {
      case 'getRawUploads':
        result.data = getRawUploads();
        break;
      case 'getAuditQueue':
        result.data = getAuditQueue(
          e.parameter.email, 
          e.parameter.role, 
          parseInt(e.parameter.page || 1), 
          parseInt(e.parameter.limit || 25)
        );
        break;
      case 'getWarnings':
        result.data = getWarnings(e.parameter.email, e.parameter.role);
        break;
      case 'getTmsShifts':
        result.data = getTmsShifts(e.parameter.userId);
        break;
      case 'getTmsProcesses':
        result.data = getTmsProcesses();
        break;
      case 'getAlignments':
        result.data = getAlignments();
        break;
      case 'getAgentKpis':
        result.data = getAgentKpis(e.parameter.email, e.parameter.role);
        break;
      default:
        throw new Error('Invalid GET action: ' + action);
    }
  } catch (error) {
    result = { status: 'error', message: error.toString() };
  }
  
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handles POST requests (Write / Command Engine)
 */
function doPost(e) {
  let result = { status: 'success', data: null };
  
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action || payload.type;
    
    switch (action) {
      case 'uploadRawData':
      case 'uploadData':
        result.data = uploadRawData(payload);
        break;
      case 'runRandomizer':
        result.data = runRandomizer(payload.uploadId, payload.samplingRate, payload.triggeredBy);
        break;
      case 'submitAudit':
      case 'audit_submission':
        result.data = submitAudit(payload);
        break;
      case 'dispute_resolution':
        result.data = handleDisputeResolution(payload);
        break;
      case 'warning_issued':
      case 'issueWarning':
        result.data = issueWarning(payload.warning);
        break;
      case 'acknowledgeWarning':
        result.data = acknowledgeWarning(payload.warningId, payload.status, payload.userName, payload.userRole);
        break;
      case 'saveTmsShift':
        result.data = saveTmsShift(payload.shift);
        break;
      case 'saveTmsProcesses':
        result.data = saveTmsProcesses(payload.list);
        break;
      case 'saveAlignments':
        result.data = saveAlignments(payload.list);
        break;
      case 'saveAgentKpi':
        result.data = saveAgentKpi(payload.record);
        break;
      case 'userSync':
        result.data = syncUser(payload.user);
        break;
      default:
        throw new Error('Invalid POST action: ' + action);
    }
  } catch (error) {
    result = { status: 'error', message: error.toString() };
  }
  
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// --- UTILITIES ---

function getSheet(name) {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    // Add default headers for instant automatic bootstrapping
    if (name === SHEETS.RAW_UPLOADS) {
      sheet.appendRow(["Tenant", "Category Group", "Lot ID", "SLM Feed Ids", "Task ID", "Vertical", "Tags", "Priority", "Seller ID", "Feed uploaded at", "Nemo Created at", "TL Appt", "TL Assigned", "QC Time", "APT", "QV Name", "Rows", "Rows Failed", "Rows Passed", "Attributes Edited", "Image Reshuffle", "UploadId", "UploadedBy", "Timestamp"]);
    } else if (name === SHEETS.AUDIT_QUEUE) {
      sheet.appendRow(["Unique ID", "Task ID", "Agent", "Vertical", "Rows", "Quality Score", "Date", "Error Type", "Error Guideline", "Error Theme", "Error Row No.", "QA Comment", "mappedQA", "mappedTL", "mappedManager", "Category Group", "Seller ID", "SLM Feed IDs", "Lot ID", "Audit URL", "Attributes Edited", "Image Reshuffle"]);
    } else if (name === SHEETS.USERS) {
      sheet.appendRow(["UID", "Email", "Role", "Name", "TL Name", "QA Name", "Manager Name"]);
    } else if (name === SHEETS.TMS_SHIFTS) {
      sheet.appendRow(["Id", "UserId", "UserName", "UserEmail", "ClockInTime", "ClockOutTime", "ActivitiesJson", "Status"]);
    } else if (name === SHEETS.TMS_PROCESSES) {
      sheet.appendRow(["ProcessName"]);
    } else if (name === SHEETS.WARNINGS) {
      sheet.appendRow(["WarningId", "AgentId", "AgentName", "AgentEmail", "EmployeeId", "QAId", "Level", "Remarks", "Severity", "Status", "CreatedAt", "HistoryJson", "AcceptedAt"]);
    } else if (name === SHEETS.ALIGNMENTS) {
      sheet.appendRow(["AlignmentName"]);
    } else if (name === SHEETS.AGENT_KPIS) {
      sheet.appendRow(["Id", "AgentId", "AgentName", "AgentEmail", "Month", "QualityScore", "ProductivityScore", "AttendanceScore", "AptScore", "FinalScore", "Status"]);
    }
  }
  return sheet;
}

// Helper: Case-insensitive and Space-insensitive dynamic lookup to handle variations in Flipkart exports
function getValueIgnoreCase(obj, keyName) {
  if (!obj) return '';
  const searchKey = String(keyName).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let k in obj) {
    const objKey = k.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (objKey === searchKey) {
      return obj[k];
    }
  }
  return '';
}

// --- CORE CONTROLLERS ---

function getRawUploads() {
  const sheet = getSheet(SHEETS.RAW_UPLOADS);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  
  // Return unique Upload IDs with their metadata
  const uploads = {};
  for (let i = 1; i < data.length; i++) {
    const uploadId = data[i][21]; // index 21 is UploadId in SHEETS.RAW_UPLOADS
    if (!uploadId) continue;
    if (!uploads[uploadId]) {
      uploads[uploadId] = {
        id: uploadId,
        timestamp: data[i][23] || data[i][data[i].length - 1], // index 23 is Timestamp
        count: 0
      };
    }
    uploads[uploadId].count++;
  }
  return Object.values(uploads);
}

function uploadRawData(payload) {
  const sheet = getSheet(SHEETS.RAW_UPLOADS);
  const uploadId = 'UP-' + Date.now();
  const timestamp = new Date().toISOString();
  
  payload.records.forEach(r => {
    // Mapping payload using the resilient case-insensitive lookup
    sheet.appendRow([
      getValueIgnoreCase(r, 'tenant') || '',
      getValueIgnoreCase(r, 'categorygroup') || '',
      getValueIgnoreCase(r, 'lotid') || '',
      getValueIgnoreCase(r, 'slmfeedids') || '',
      getValueIgnoreCase(r, 'taskid') || '',
      getValueIgnoreCase(r, 'vertical') || '',
      getValueIgnoreCase(r, 'tags') || '',
      getValueIgnoreCase(r, 'priority') || '',
      getValueIgnoreCase(r, 'sellerid') || '',
      getValueIgnoreCase(r, 'feeduploadedat') || '',
      getValueIgnoreCase(r, 'nemocreatedat') || '',
      getValueIgnoreCase(r, 'timestampwhentlassignstoqv') || '',
      getValueIgnoreCase(r, 'tlwhoassigned') || '',
      getValueIgnoreCase(r, 'qccompletiontimestamp') || '',
      getValueIgnoreCase(r, 'apt') || '',
      getValueIgnoreCase(r, 'qvname') || '',
      getValueIgnoreCase(r, 'rows') || 1,
      getValueIgnoreCase(r, 'rowsfailed') || 0,
      getValueIgnoreCase(r, 'rowspassed') || 0,
      getValueIgnoreCase(r, 'attributesedited') || 0,
      getValueIgnoreCase(r, 'imagereshuffledelete') || false,
      uploadId,
      payload.uploadedBy,
      timestamp
    ]);
  });
  
  return { status: 'Success', uploadId, count: payload.records.length };
}

function runRandomizer(uploadId, samplingRate, triggeredBy) {
  const rawSheet = getSheet(SHEETS.RAW_UPLOADS);
  const queueSheet = getSheet(SHEETS.AUDIT_QUEUE);
  const userSheet = getSheet(SHEETS.USERS);
  
  const rawData = rawSheet.getDataRange().getValues();
  const userData = userSheet.getDataRange().getValues();
  
  // Filter for this upload
  const uploadRecords = rawData.filter(row => row[21] === uploadId);
  if (uploadRecords.length === 0) return { status: 'Error', message: 'No records found for upload ID: ' + uploadId };

  // Mapping indices (based on uploadRawData structure)
  const COL_TASK_ID = 4;
  const COL_QV = 15;
  const COL_ROWS = 16;

  // Faster Grouping by QV (Agent)
  const qvGroups = {};
  for (let i = 0; i < uploadRecords.length; i++) {
    const row = uploadRecords[i];
    const qv = row[COL_QV];
    if (!qv) continue;
    if (!qvGroups[qv]) qvGroups[qv] = { totalRows: 0, records: [] };
    qvGroups[qv].totalRows += (Number(row[COL_ROWS]) || 0);
    qvGroups[qv].records.push(row);
  }

  // Map Name -> Email and Email -> Name, and cache profiles
  const nameToProfileMap = {};
  const emailToProfileMap = {};
  for (let i = 1; i < userData.length; i++) {
    const uUid = String(userData[i][0] || '').trim();
    const uEmail = String(userData[i][1] || '').trim().toLowerCase();
    const uRole = String(userData[i][2] || '').trim().toUpperCase();
    const uName = String(userData[i][3] || '').trim();
    const uTlName = String(userData[i][4] || '').trim();
    const uQaName = String(userData[i][5] || '').trim();
    const uMgrName = String(userData[i][6] || '').trim();
    
    const profile = {
      uid: uUid,
      email: uEmail,
      role: uRole,
      name: uName,
      tlName: uTlName,
      qaName: uQaName,
      mgrName: uMgrName
    };
    
    if (uEmail) {
      emailToProfileMap[uEmail] = profile;
    }
    if (uName) {
      nameToProfileMap[uName.toLowerCase()] = profile;
    }
  }

  const output = [];
  const timestamp = new Date().toISOString();
  const sampleRateDec = samplingRate / 100;
  const minSample = 1; 

  // Process Groups
  for (let qv in qvGroups) {
    const qvKey = String(qv || '').trim();
    let agentProfile = null;
    
    // Resolve Agent Profile
    if (qvKey.indexOf('@') !== -1) {
      agentProfile = emailToProfileMap[qvKey.toLowerCase()];
    }
    if (!agentProfile) {
      agentProfile = nameToProfileMap[qvKey.toLowerCase()];
    }

    let agentEmail = qvKey;
    let tlEmail = '';
    let mgrEmail = '';
    let qaEmail = '';
    
    if (agentProfile) {
      agentEmail = agentProfile.email || qvKey;
      if (agentProfile.tlName) {
        const tlProfile = nameToProfileMap[agentProfile.tlName.toLowerCase()] || emailToProfileMap[agentProfile.tlName.toLowerCase()];
        if (tlProfile) tlEmail = tlProfile.email;
      }
      if (agentProfile.mgrName) {
        const mgrProfile = nameToProfileMap[agentProfile.mgrName.toLowerCase()] || emailToProfileMap[agentProfile.mgrName.toLowerCase()];
        if (mgrProfile) mgrEmail = mgrProfile.email;
      }
      if (agentProfile.qaName) {
        const qaProfile = nameToProfileMap[agentProfile.qaName.toLowerCase()] || emailToProfileMap[agentProfile.qaName.toLowerCase()];
        if (qaProfile) qaEmail = qaProfile.email;
      }
    }

    const group = qvGroups[qv];
    const requiredSample = Math.max(minSample, Math.floor(group.totalRows * sampleRateDec));
    
    // In-place Fisher-Yates Shuffle
    let recs = group.records;
    for (let i = recs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [recs[i], recs[j]] = [recs[j], recs[i]];
    }

    let pickedCount = 0;
    for (let i = 0; i < recs.length && pickedCount < requiredSample; i++) {
      const r = recs[i];
      const count = Number(r[COL_ROWS]) || 0;
      pickedCount += count;
      
      const uniqueId = 'AUD-' + Math.random().toString(36).substr(2, 6) + '-' + Date.now();
      const auditUrl = "https://nemo.flipkart.net/task/" + r[COL_TASK_ID];

      // AUDIT_QUEUE Headers (21 Columns):
      // 0:Unique ID | 1:Task ID | 2:Agent | ...
      output.push([
        uniqueId, 
        r[4],           // Task ID
        agentEmail,     // Agent Email
        r[5],           // Vertical
        count,          // Rows
        null,           // Quality Score
        timestamp,      // Date
        '', '', '', '', '', 
        qaEmail,        // mappedQA
        tlEmail,        // mappedTL
        mgrEmail,       // mappedManager
        r[1],           // Category Group
        r[8],           // Seller ID
        r[3],           // SLM Feed IDs
        r[2],           // Lot ID
        auditUrl,       // Audit URL
        r[19],          // Attributes Edited
        r[20]           // Image Reshuffle
      ]);
    }
  }

  if (output.length > 0) {
    queueSheet.getRange(queueSheet.getLastRow() + 1, 1, output.length, output[0].length).setValues(output);
  }
  
  return { status: 'Randomization Completed', sampled: output.length };
}

function getAuditQueue(email, role, page, limit) {
  try {
    const sheet = getSheet(SHEETS.AUDIT_QUEUE);
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return { queue: [], totalCount: 0, page, limit };
    
    let filteredRows = data.slice(1);
    
    // Role-based filtering
    const userRole = (role || '').toUpperCase();
    const userEmail = (email || '').toLowerCase();

    // Map Name <to> Email for lookup resiliency
    const usersSheet = getSheet(SHEETS.USERS);
    const userData = usersSheet.getDataRange().getValues();
    const nameToEmailMap = {};
    const emailToNameMap = {};
    for (let i = 1; i < userData.length; i++) {
      const emailVal = String(userData[i][1] || '').trim().toLowerCase();
      const nameVal = String(userData[i][3] || '').trim().toLowerCase();
      if (emailVal && nameVal) {
        nameToEmailMap[nameVal] = emailVal;
        emailToNameMap[emailVal] = nameVal;
      }
    }

    if (userRole === 'ADMIN') {
      // No filtering
    } else if (userRole === 'MANAGER') {
      filteredRows = filteredRows.filter(r => {
        const val = (String(r[14]) || '').toLowerCase();
        return val === userEmail || nameToEmailMap[val] === userEmail;
      });
    } else if (userRole === 'TEAM_LEAD') {
      filteredRows = filteredRows.filter(r => {
        const val = (String(r[13]) || '').toLowerCase();
        return val === userEmail || nameToEmailMap[val] === userEmail;
      });
    } else if (userRole === 'QA') {
      filteredRows = filteredRows.filter(r => {
        const mappedQA = (String(r[12]) || '').toLowerCase();
        return mappedQA === userEmail || !mappedQA || mappedQA === 'null' || nameToEmailMap[mappedQA] === userEmail;
      }); 
    } else if (userRole === 'AGENT') {
      filteredRows = filteredRows.filter(r => {
        const val = (String(r[2]) || '').toLowerCase();
        return val === userEmail || nameToEmailMap[val] === userEmail;
      });
    }
    
    const totalCount = filteredRows.length;
    // index 6 is timestamp. Sort reverse chronological
    const sorted = filteredRows.sort((a,b) => {
      const dateA = a[6] ? new Date(a[6]) : 0;
      const dateB = b[6] ? new Date(b[6]) : 0;
      return dateB - dateA;
    });
    
    const start = (Number(page) - 1) * Number(limit);
    const pagedData = sorted.slice(start, start + Number(limit));
    
    const queue = pagedData.map(row => {
      const agentIdentifier = String(row[2] || '');
      const agentDisplayName = emailToNameMap[agentIdentifier.toLowerCase()] || agentIdentifier;
      
      return {
        id: String(row[0] || ''),
        taskId: String(row[1] || ''),
        qvName: agentDisplayName,
        vertical: String(row[3] || ''),
        rows: Number(row[4]) || 0,
        qualityScore: row[5] === '' ? null : row[5],
        createdAt: row[6],
        status: row[5] === null || row[5] === '' ? 'Pending' : 'Completed',
        categoryGroup: String(row[15] || ''),
        sellerId: String(row[16] || ''),
        slmFeedIds: String(row[17] || ''),
        lotId: String(row[18] || ''),
        auditUrl: String(row[19] || ''),
        attributesEdited: Number(row[20]) || 0,
        imageReshuffle: !!row[21]
      };
    });
    
    return { queue, totalCount, page, limit };
  } catch (err) {
    console.error('getAuditQueue Error:', err);
    return { queue: [], totalCount: 0, page, limit, error: String(err) };
  }
}

function syncUser(user) {
  try {
    const sheet = getSheet(SHEETS.USERS);
    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === user.email) {
        rowIndex = i + 1;
        break;
      }
    }
    
    const row = [
      user.uid || '',
      user.email || '',
      user.role || '',
      user.name || '',
      user.teamLeadName || '',
      user.mappedQA || '',
      user.mappedManagerName || ''
    ];
    
    if (rowIndex > -1) {
      sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
    return { status: 'Synced' };
  } catch (err) {
    console.error('syncUser Error:', err);
    return { status: 'Error', message: String(err) };
  }
}

function submitAudit(payload) {
  const sheet = getSheet(SHEETS.AUDIT_QUEUE);
  const data = sheet.getDataRange().getValues();
  
  const auditId = payload.id || (payload.payload && payload.payload.id);
  if (!auditId) throw new Error('Missing audit ID in payload');
  
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(auditId).trim()) {
      rowIndex = i + 1;
      break;
    }
  }
  
  if (rowIndex === -1) {
    throw new Error('Audit record not found for ID: ' + auditId);
  }
  
  const aud = payload.payload || {};
  
  sheet.getRange(rowIndex, 6).setValue(aud.quality !== undefined ? aud.quality : ''); // F: Quality Score
  sheet.getRange(rowIndex, 7).setValue(payload.timestamp || new Date().toISOString()); // G: Date
  sheet.getRange(rowIndex, 8).setValue(aud.errorType || ''); // H: Error Type
  sheet.getRange(rowIndex, 9).setValue(aud.guideline || ''); // I: Error Guideline
  sheet.getRange(rowIndex, 10).setValue(aud.theme || ''); // J: Error Theme
  sheet.getRange(rowIndex, 11).setValue(aud.rowNo || ''); // K: Error Row No.
  sheet.getRange(rowIndex, 12).setValue(aud.qaComment || ''); // L: QA Comment
  sheet.getRange(rowIndex, 13).setValue(payload.userEmail || ''); // M: mappedQA
  
  return { status: 'Saved', auditId: auditId };
}

function handleDisputeResolution(payload) {
  const sheet = getSheet(SHEETS.AUDIT_QUEUE);
  const data = sheet.getDataRange().getValues();
  const auditId = payload.id;
  
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(auditId).trim()) {
      rowIndex = i + 1;
      break;
    }
  }
  
  if (rowIndex > -1) {
    const aud = payload.payload || {};
    sheet.getRange(rowIndex, 6).setValue(aud.quality !== undefined ? aud.quality : ''); // Update Quality Score
    return { status: 'Dispute Resolution Logged', auditId: auditId };
  }
  return { status: 'NotFound', message: 'Audit ID not matching' };
}

// --- NEW SCALABILITY DB METHODS ---

function getWarnings(email, role) {
  const sheet = getSheet(SHEETS.WARNINGS);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  const rows = data.slice(1);
  const uRole = (role || '').toUpperCase();
  const uEmail = (email || '').toLowerCase();
  
  let filtered = rows;
  if (uRole === 'AGENT') {
    filtered = rows.filter(r => String(r[3]).toLowerCase() === uEmail);
  }
  
  return filtered.map(row => ({
    id: String(row[0] || ''),
    agentId: String(row[1] || ''),
    agentName: String(row[2] || ''),
    agentEmail: String(row[3] || ''),
    employeeId: String(row[4] || ''),
    qaId: String(row[5] || ''),
    level: String(row[6] || ''),
    remarks: String(row[7] || ''),
    severity: String(row[8] || ''),
    status: String(row[9] || ''),
    createdAt: String(row[10] || ''),
    history: row[11] ? JSON.parse(row[11]) : [],
    acceptedAt: row[12] || null
  }));
}

function issueWarning(warning) {
  const sheet = getSheet(SHEETS.WARNINGS);
  const data = sheet.getDataRange().getValues();
  
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(warning.id).trim()) {
      rowIndex = i + 1;
      break;
    }
  }
  
  const historyStr = warning.history ? JSON.stringify(warning.history) : JSON.stringify([]);
  const row = [
    warning.id || '',
    warning.agentId || '',
    warning.agentName || '',
    warning.agentEmail || '',
    warning.employeeId || '',
    warning.qaId || '',
    warning.level || '',
    warning.remarks || '',
    warning.severity || '',
    warning.status || 'Pending',
    warning.createdAt || '',
    historyStr,
    warning.acceptedAt || ''
  ];
  
  if (rowIndex > -1) {
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  return { status: 'Saved', warningId: warning.id };
}

function acknowledgeWarning(warningId, status, userName, userRole) {
  const sheet = getSheet(SHEETS.WARNINGS);
  const data = sheet.getDataRange().getValues();
  
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(warningId).trim()) {
      rowIndex = i + 1;
      break;
    }
  }
  
  if (rowIndex > -1) {
    const acceptedAt = new Date().toISOString();
    const historyList = data[rowIndex-1][11] ? JSON.parse(data[rowIndex-1][11]) : [];
    historyList.push({
      action: "Warning " + status + " & Accepted by Agent",
      timestamp: acceptedAt,
      userName: userName,
      userRole: userRole
    });
    
    sheet.getRange(rowIndex, 10).setValue(status); // J: Status (col 10)
    sheet.getRange(rowIndex, 12).setValue(JSON.stringify(historyList)); // L: HistoryJson (col 12)
    sheet.getRange(rowIndex, 13).setValue(acceptedAt); // M: AcceptedAt (col 13)
    
    return { status: 'Updated', warningId: warningId };
  }
  throw new Error("Warning ticket not found in Sheets: " + warningId);
}

function getTmsShifts(userId) {
  const sheet = getSheet(SHEETS.TMS_SHIFTS);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  const rows = data.slice(1);
  let filtered = rows;
  if (userId) {
    filtered = rows.filter(r => String(r[1]) === String(userId));
  }
  
  return filtered.map(row => ({
    id: String(row[0] || ''),
    userId: String(row[1] || ''),
    userName: String(row[2] || ''),
    userEmail: String(row[3] || ''),
    clockInTime: String(row[4] || ''),
    clockOutTime: row[5] ? String(row[5]) : undefined,
    activities: row[6] ? JSON.parse(row[6]) : [],
    status: String(row[7] || '')
  }));
}

function saveTmsShift(shift) {
  const sheet = getSheet(SHEETS.TMS_SHIFTS);
  const data = sheet.getDataRange().getValues();
  
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(shift.id).trim()) {
      rowIndex = i + 1;
      break;
    }
  }
  
  const row = [
    shift.id || '',
    shift.userId || '',
    shift.userName || '',
    shift.userEmail || '',
    shift.clockInTime || '',
    shift.clockOutTime || '',
    JSON.stringify(shift.activities || []),
    shift.status || ''
  ];
  
  if (rowIndex > -1) {
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  return { status: 'Saved', shiftId: shift.id };
}

function getTmsProcesses() {
  const sheet = getSheet(SHEETS.TMS_PROCESSES);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  return data.slice(1).map(r => String(r[0]));
}

function saveTmsProcesses(list) {
  const sheet = getSheet(SHEETS.TMS_PROCESSES);
  sheet.clearContents();
  sheet.appendRow(["ProcessName"]);
  list.forEach(p => {
    sheet.appendRow([p]);
  });
  return { status: 'Saved' };
}

function getAlignments() {
  const sheet = getSheet(SHEETS.ALIGNMENTS);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  return data.slice(1).map(r => String(r[0]));
}

function saveAlignments(list) {
  const sheet = getSheet(SHEETS.ALIGNMENTS);
  sheet.clearContents();
  sheet.appendRow(["AlignmentName"]);
  list.forEach(item => {
    sheet.appendRow([item]);
  });
  return { status: 'Saved' };
}

function getAgentKpis(email, role) {
  const sheet = getSheet(SHEETS.AGENT_KPIS);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const rows = data.slice(1);
  
  const uRole = (role || '').toUpperCase();
  const uEmail = (email || '').toLowerCase();
  
  let filtered = rows;
  if (uRole === 'AGENT') {
    filtered = rows.filter(r => String(r[3]).toLowerCase() === uEmail);
  }
  
  return filtered.map(row => ({
    id: String(row[0] || ''),
    agentId: String(row[1] || ''),
    agentName: String(row[2] || ''),
    agentEmail: String(row[3] || ''),
    month: String(row[4] || ''),
    qualityScore: row[5] === '' ? null : Number(row[5]),
    productivityScore: row[6] === '' ? null : Number(row[6]),
    attendanceScore: row[7] === '' ? null : Number(row[7]),
    aptScore: row[8] === '' ? null : Number(row[8]),
    finalScore: row[9] === '' ? null : Number(row[9]),
    status: String(row[10] || '')
  }));
}

function saveAgentKpi(record) {
  const sheet = getSheet(SHEETS.AGENT_KPIS);
  const data = sheet.getDataRange().getValues();
  
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(record.id).trim()) {
      rowIndex = i + 1;
      break;
    }
  }
  
  const row = [
    record.id || '',
    record.agentId || '',
    record.agentName || '',
    record.agentEmail || '',
    record.month || '',
    record.qualityScore !== undefined && record.qualityScore !== null ? record.qualityScore : '',
    record.productivityScore !== undefined && record.productivityScore !== null ? record.productivityScore : '',
    record.attendanceScore !== undefined && record.attendanceScore !== null ? record.attendanceScore : '',
    record.aptScore !== undefined && record.aptScore !== null ? record.aptScore : '',
    record.finalScore !== undefined && record.finalScore !== null ? record.finalScore : '',
    record.status || ''
  ];
  
  if (rowIndex > -1) {
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  return { status: 'Saved', kpiId: record.id };
}
