/**
 * PRECISION360 – GOOGLE APPS SCRIPT DATABASE BACKEND (Code.gs)
 * -----------------------------------------------------------
 * This file acts as the completely serverless backend database layer
 * connected to your Google Spreadsheet. It implements dynamic sheet setup,
 * a robust 10-15% randomization and workload-balanced QA assignment engine,
 * enterprise scorecard calculations, dispute lifecycles, and served endpoints.
 * 
 * INSTRUCTIONS FOR DEPLOYMENT:
 * 1. Open your Google Spreadsheet.
 * 2. Click "Extensions" -> "Apps Script".
 * 3. Delete any default code in Code.gs, paste this entire file's contents, and save.
 * 4. Click "Deploy" -> "New deployment".
 * 5. Choose type: "Web app".
 * 6. Execute as: "Me" (your account).
 * 7. Who has access: "Anyone" (required for frontend fetch access).
 * 8. Click "Deploy", authorize the permissions, and copy the Web App URL.
 * 9. Paste the copied Web App URL in your frontend Apps Script Service configuration.
 */

// Global Configs
const DEFAULT_SAMPLING_RATE = 0.10; // 10% target sampling rate

/**
 * Handle incoming GET requests (API endpoints)
 */
function doGet(e) {
  try {
    const action = e.parameter.action;
    const email = e.parameter.email ? e.parameter.email.trim().toLowerCase() : '';
    const role = e.parameter.role ? e.parameter.role.trim().toUpperCase() : 'AGENT';
    
    // Auto-setup sheets on any first contact to prevent manual configuration errors
    initSpreadsheetSchema();

    let result = null;

    switch (action) {
      case 'getAuditQueue':
        result = handleGetAuditQueue(email, role, e.parameter.page, e.parameter.limit);
        break;
      case 'getScorecard':
        result = handleGetScorecard(email, e.parameter.month);
        break;
      case 'getLeaderboard':
        result = handleGetLeaderboard(e.parameter.month, e.parameter.page, e.parameter.limit);
        break;
      case 'getDisputes':
        result = handleGetDisputes(email, role);
        break;
      case 'getLogs':
        result = handleGetDisciplinaryLogs(email, role);
        break;
      case 'ping':
        result = { status: 'success', message: 'Precision360 Apps Script Backend is Live!', timestamp: new Date() };
        break;
      default:
        return createJsonResponse({ status: 'error', message: 'Invalid GET action parameter' }, 400);
    }

    return createJsonResponse({ status: 'success', data: result });
  } catch (error) {
    Logger.log('GET Error: ' + error.toString());
    return createJsonResponse({ status: 'error', message: error.toString() }, 500);
  }
}

/**
 * Handle incoming POST requests (API endpoints for write/updating operations)
 */
function doPost(e) {
  try {
    // Apps Script triggers usually send application/json stringified in e.postData.contents
    let payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }
    
    const action = payload.action;
    initSpreadsheetSchema();

    let result = null;

    switch (action) {
      case 'uploadData':
        result = handleRawUpload(payload.records, payload.process, payload.vertical, payload.samplingRate, payload.uploadedBy);
        break;
      case 'userSync':
        result = handleUserSync(payload.user);
        break;
      case 'raiseDispute':
        result = handleRaiseDispute(payload.dispute);
        break;
      case 'respondDispute':
        result = handleRespondDispute(payload.disputeId, payload.comment, payload.status, payload.userRole, payload.userName);
        break;
      case 'issueWarning':
        result = handleIssueWarning(payload.warning);
        break;
      case 'acknowledgeWarning':
        result = handleAcknowledgeWarning(payload.warningId, payload.status, payload.userName, payload.userRole);
        break;
      default:
        return createJsonResponse({ status: 'error', message: 'Invalid POST action parameter' }, 400);
    }

    return createJsonResponse({ status: 'success', data: result });
  } catch (error) {
    Logger.log('POST Error: ' + error.toString());
    return createJsonResponse({ status: 'error', message: error.toString() }, 500);
  }
}

/**
 * Creates standardized CORS-safe JSON Responses
 */
function createJsonResponse(data, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// =========================================================================
// PHASE 1: DATABASE TABLE & SPREADSHEET SCHEMAS
// =========================================================================
function initSpreadsheetSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const tables = {
    'USERS': [
      'userId', 'email', 'role', 'mappedTL', 'mappedQA', 'status', 'createdAt', 'displayName'
    ],
    'RAW_UPLOADS': [
      'uploadId', 'uploadDate', 'process', 'vertical', 'taskId', 'agentEmail', 'taskResult', 'timestamp', 'metadata'
    ],
    'RANDOMIZED_AUDIT_QUEUE': [
      'auditId', 'uploadId', 'taskId', 'agentEmail', 'mappedQA', 'process', 'auditStatus', 'auditResult', 'feedback', 'disputeStatus', 'createdAt'
    ],
    'FEEDBACK_LOGS': [
      'feedbackId', 'auditId', 'agentEmail', 'qaEmail', 'feedback', 'feedbackStatus', 'timestamp'
    ],
    'DISPUTES': [
      'disputeId', 'auditId', 'raisedBy', 'disputeReason', 'qaResponse', 'finalDecision', 'disputeStatus', 'reopened', 'timestamp', 'historyJson'
    ],
    'SCORECARDS': [
      'date', 'agentEmail', 'productivityTarget', 'productivityAchieved', 'aptTarget', 'aptAchieved', 'qualityTarget', 'qualityAchieved', 'attendanceTarget', 'attendanceAchieved', 'bonus', 'penalty', 'finalScore', 'ranking'
    ],
    'LEADERBOARD_SNAPSHOTS': [
      'month', 'rank', 'agentEmail', 'score', 'department', 'generatedAt'
    ],
    'DISCIPLINARY_LOGS': [
      'warningId', 'agentId', 'agentName', 'agentEmail', 'employeeId', 'qaId', 'level', 'remarks', 'severity', 'status', 'createdAt', 'historyJson'
    ]
  };

  Object.keys(tables).forEach(tableName => {
    let sheet = ss.getSheetByName(tableName);
    if (!sheet) {
      sheet = ss.insertSheet(tableName);
      sheet.appendRow(tables[tableName]);
      // Apply clean black-and-white visual locking to header cells for organization
      sheet.getRange(1, 1, 1, tables[tableName].length)
           .setBackground('#000000')
           .setFontColor('#FFFFFF')
           .setFontWeight('bold');
    }
  });
}

// Helper to find a row index by columns matching
function findRowIndex(sheet, colNum, value) {
  const values = sheet.getRange(2, colNum, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] == value) return i + 2; // match row (1-indexed, skipping header)
  }
  return -1;
}

// Convert sheet data to array of objects
function sheetToJson(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  
  return rows.map(r => {
    const obj = {};
    headers.forEach((h, colIdx) => {
      obj[h] = r[colIdx];
    });
    return obj;
  });
}

// Add rows to any sheet safely using JSON keys
function addRowsToSheet(sheet, headers, objects) {
  if (objects.length === 0) return;
  const rowsToAppend = objects.map(obj => {
    return headers.map(h => obj[h] !== undefined ? obj[h] : '');
  });
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rowsToAppend.length, headers.length).setValues(rowsToAppend);
}

// =========================================================================
// PHASE 2 & 3: RAW UPLOADS AND RANDOMIZATION ENGINE
// =========================================================================
function handleRawUpload(records, process, vertical, samplingRate, uploadedBy) {
  if (!records || records.length === 0) throw new Error('No records submitted.');
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName('RAW_UPLOADS');
  const auditSheet = ss.getSheetByName('RANDOMIZED_AUDIT_QUEUE');
  const usersSheet = ss.getSheetByName('USERS');
  
  const rawHeaders = ['uploadId', 'uploadDate', 'process', 'vertical', 'taskId', 'agentEmail', 'taskResult', 'timestamp', 'metadata'];
  const auditHeaders = ['auditId', 'uploadId', 'taskId', 'agentEmail', 'mappedQA', 'process', 'auditStatus', 'auditResult', 'feedback', 'disputeStatus', 'createdAt'];
  
  const uploadId = 'up-' + Date.now();
  const uploadDateStr = new Date().toISOString().split('T')[0];
  
  const allRawRowObjects = [];
  const rawRecordsByAgent = {};

  // Formulate structural raw records
  records.forEach((rec, idx) => {
    const agentEmail = String(rec.agentEmail || rec.email || '').trim().toLowerCase();
    if (!agentEmail) return;

    const rowObj = {
      uploadId: uploadId,
      uploadDate: uploadDateStr,
      process: process || 'Default',
      vertical: vertical || 'General',
      taskId: rec.taskId || 'task-' + idx + '-' + Date.now(),
      agentEmail: agentEmail,
      taskResult: rec.taskResult || 'Completed',
      timestamp: new Date().toISOString(),
      metadata: JSON.stringify(rec)
    };
    allRawRowObjects.push(rowObj);

    if (!rawRecordsByAgent[agentEmail]) {
      rawRecordsByAgent[agentEmail] = [];
    }
    rawRecordsByAgent[agentEmail].push(rowObj);
  });

  // 1. Commit raw uploads inside Google Sheet
  addRowsToSheet(rawSheet, rawHeaders, allRawRowObjects);

  // 2. Load QA alignments and active QAs
  const users = sheetToJson(usersSheet);
  const qas = users.filter(u => u.role === 'QA' && u.status !== 'Inactive');
  if (qas.length === 0) {
    throw new Error('No active QA accounts available to assign audits.');
  }

  // Workload balancing tracker
  const qaAuditCounts = {};
  qas.forEach(qa => {
    qaAuditCounts[qa.email] = 0;
  });

  // Pre-fetch historical audits for current month to establish balance weights
  const currentAudits = sheetToJson(auditSheet);
  currentAudits.forEach(aud => {
    const qa = String(aud.mappedQA).trim().toLowerCase();
    if (qaAuditCounts[qa] !== undefined) {
      qaAuditCounts[qa]++;
    }
  });

  const samplingFraction = parseFloat(samplingRate) || DEFAULT_SAMPLING_RATE;
  const auditLogsCreated = [];

  // 3. Process-wise, vertical-wise, agent-wise sampling
  Object.keys(rawRecordsByAgent).forEach(agentEmail => {
    const agentRecords = rawRecordsByAgent[agentEmail];
    const totalCount = agentRecords.length;
    
    // Calculate targeted sample bounds (minimum 1, up to the ceiling of the sampling % rate)
    const targetSampleSize = Math.max(1, Math.ceil(totalCount * samplingFraction));
    
    // Perform Fisher-Yates shuffle directly
    const shuffled = [...agentRecords];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const sampledRecords = shuffled.slice(0, targetSampleSize);

    // Identify mapped QA for the agent
    const agentProfile = users.find(u => u.email === agentEmail);
    let assignedQA = '';
    
    if (agentProfile && agentProfile.mappedQA) {
      assignedQA = String(agentProfile.mappedQA).trim().toLowerCase();
    }

    sampledRecords.forEach((item, innerIdx) => {
      // Workload balancing fallback if no direct agent-to-QA mapped alignment exists
      let finalQA = assignedQA;
      if (!finalQA || qaAuditCounts[finalQA] === undefined) {
        // Assign to the QA with the lowest active audit count
        let minCount = Infinity;
        let selectedQA = qas[0].email;
        Object.keys(qaAuditCounts).forEach(qaEmail => {
          if (qaAuditCounts[qaEmail] < minCount) {
            minCount = qaAuditCounts[qaEmail];
            selectedQA = qaEmail;
          }
        });
        finalQA = selectedQA;
      }

      // Track the assigned audit to keep workload balance up to date during loop
      qaAuditCounts[finalQA]++;

      const auditRecord = {
        auditId: 'aud-' + Math.floor(Math.random() * 1000000) + '-' + Date.now(),
        uploadId: uploadId,
        taskId: item.taskId,
        agentEmail: agentEmail,
        mappedQA: finalQA,
        process: item.process,
        auditStatus: 'Pending',
        auditResult: '',
        feedback: '',
        disputeStatus: 'None',
        createdAt: new Date().toISOString()
      };
      
      auditLogsCreated.push(auditRecord);
    });
  });

  // 4. Record randomized audits inside Sheet table
  addRowsToSheet(auditSheet, auditHeaders, auditLogsCreated);

  return {
    uploadId: uploadId,
    totalUploaded: allRawRowObjects.length,
    totalAudited: auditLogsCreated.length,
    samplingFactor: samplingFraction * 100 + '%'
  };
}

// =========================================================================
// API ENDPOINTS FOR QUERYING
// =========================================================================

/**
 * Audit Queue Fetcher with Pagination Support
 */
function handleGetAuditQueue(email, role, page, limit) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const auditSheet = ss.getSheetByName('RANDOMIZED_AUDIT_QUEUE');
  const allAudits = sheetToJson(auditSheet);
  
  let filtered = allAudits;
  
  if (role === 'QA') {
    filtered = allAudits.filter(a => String(a.mappedQA).trim().toLowerCase() === email);
  } else if (role === 'AGENT') {
    filtered = allAudits.filter(a => String(a.agentEmail).trim().toLowerCase() === email);
  } else if (role === 'TEAM_LEAD') {
    // TLs only see agents mapped under them
    const usersSheet = ss.getSheetByName('USERS');
    const users = sheetToJson(usersSheet);
    const tlProfile = users.find(u => u.email === email);
    if (tlProfile) {
      const teamAgentEmails = users
        .filter(u => u.mappedTL === email || u.userId === tlProfile.userId)
        .map(u => u.email);
      filtered = allAudits.filter(a => teamAgentEmails.indexOf(String(a.agentEmail).trim().toLowerCase()) !== -1);
    }
  }

  // Sort by newest first
  filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Apply Pagination limits
  const p = parseInt(page) || 1;
  const l = parseInt(limit) || 20;
  const startIndex = (p - 1) * l;
  const paginated = filtered.slice(startIndex, startIndex + l);

  return {
    queue: paginated,
    totalCount: filtered.length,
    page: p,
    limit: l
  };
}

/**
 * Phase 7: Scorecard Calculation Dynamic API
 */
function handleGetScorecard(email, yearMonth) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const scoreSheet = ss.getSheetByName('SCORECARDS');
  const allScores = sheetToJson(scoreSheet);
  
  // Filter scores matching the agent email on the specified month (YYYY-MM)
  const agentScores = allScores.filter(s => {
    const isAgent = String(s.agentEmail).trim().toLowerCase() === email.toLowerCase().trim();
    if (!isAgent) return false;
    if (yearMonth) {
      return String(s.date).indexOf(yearMonth) === 0;
    }
    return true;
  });

  // Calculate high performance averages
  let totalProductivityScore = 0;
  let totalQualityScore = 0;
  let totalAttendanceScore = 0;
  let totalAptScore = 0;
  let totalFinalScore = 0;
  let count = agentScores.length;

  agentScores.forEach(s => {
    const pt = parseFloat(s.productivityTarget) || 40;
    const pa = parseFloat(s.productivityAchieved) || 0;
    const qt = parseFloat(s.qualityTarget) || 95;
    const qa = parseFloat(s.qualityAchieved) || 0;
    const at = parseFloat(s.attendanceTarget) || 100;
    const aa = parseFloat(s.attendanceAchieved) || 100;
    const aptTarget = parseFloat(s.aptTarget) || 240;
    const aptActual = parseFloat(s.aptAchieved) || 0;
    const bonus = parseFloat(s.bonus) || 0;
    const penalty = parseFloat(s.penalty) || 0;

    // Formulas:
    // Productivity Score = (achieved / target) * 30
    const prodScore = pt > 0 ? Math.min(30, (pa / pt) * 30) : 0;
    
    // Quality Score = (achieved / target) * 40
    const qualScore = qt > 0 ? Math.min(44, (qa / qt) * 40) : 0; // limit to high water

    // Attendance Slabs:
    // >=98 = 15; 95-97.99 = 13; 92-94.99 = 10; 90-91.99 = 7; <90 = 0
    let attScore = 0;
    if (aa >= 98) attScore = 15;
    else if (aa >= 95) attScore = 13;
    else if (aa >= 92) attScore = 10;
    else if (aa >= 90) attScore = 7;
    else attScore = 0;

    // APT (Average Processing Time - Lower is better. Full scale is 15 points)
    let aptScore = 0;
    if (aptActual > 0) {
      // If achieved <= target, give full 15 points.
      // Else scale inversely: (target / achieved) * 15
      aptScore = aptActual <= aptTarget ? 15 : Math.max(0, (aptTarget / aptActual) * 15);
    }

    const final = prodScore + qualScore + attScore + aptScore + bonus - penalty;

    totalProductivityScore += prodScore;
    totalQualityScore += qualScore;
    totalAttendanceScore += attScore;
    totalAptScore += aptScore;
    totalFinalScore += final;
  });

  return {
    records: agentScores,
    summary: count > 0 ? {
      averageProductivityScore: (totalProductivityScore / count).toFixed(2),
      averageQualityScore: (totalQualityScore / count).toFixed(2),
      averageAttendanceScore: (totalAttendanceScore / count).toFixed(2),
      averageAptScore: (totalAptScore / count).toFixed(2),
      averageFinalScore: (totalFinalScore / count).toFixed(2),
      totalUploadedDays: count
    } : null
  };
}

/**
 * Paginated Leaderboard Engine
 */
function handleGetLeaderboard(month, page, limit) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const scoreSheet = ss.getSheetByName('SCORECARDS');
  const allScores = sheetToJson(scoreSheet);

  const filterMonth = month || new Date().toISOString().substring(0, 7); // Default to current YYYY-MM
  
  // Aggregate scores by agent
  const agentAggregations = {};
  allScores.forEach(s => {
    if (String(s.date).indexOf(filterMonth) !== 0) return;
    const email = String(s.agentEmail).trim().toLowerCase();
    
    if (!agentAggregations[email]) {
      agentAggregations[email] = { email: email, totalScore: 0, dayCount: 0 };
    }
    agentAggregations[email].totalScore += parseFloat(s.finalScore) || 0;
    agentAggregations[email].dayCount++;
  });

  const leaderboardList = Object.keys(agentAggregations).map(email => {
    const agg = agentAggregations[email];
    return {
      agentEmail: agg.email,
      rank: 0,
      score: +(agg.totalScore / agg.dayCount).toFixed(2)
    };
  });

  // Sort descending
  leaderboardList.sort((a, b) => b.score - a.score);
  leaderboardList.forEach((item, idx) => {
    item.rank = idx + 1;
  });

  // Paginate
  const p = parseInt(page) || 1;
  const l = parseInt(limit) || 10;
  const startIndex = (p - 1) * l;
  const paginated = leaderboardList.slice(startIndex, startIndex + l);

  return {
    leaderboard: paginated,
    totalRecords: leaderboardList.length,
    month: filterMonth,
    page: p,
    limit: l
  };
}

// =========================================================================
// POST HANDLERS FOR TRANSACTION WRITES
// =========================================================================

/**
 * Handle Synced User Profile
 */
function handleUserSync(user) {
  if (!user || !user.uid || !user.email) throw new Error('Incomplete profile data');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('USERS');
  
  const headers = ['userId', 'email', 'role', 'mappedTL', 'mappedQA', 'status', 'createdAt', 'displayName'];
  const uid = String(user.uid);
  const rowIdx = findRowIndex(sheet, 1, uid);

  const rowData = {
    userId: uid,
    email: String(user.email).trim().toLowerCase(),
    role: user.role || 'AGENT',
    mappedTL: String(user.mappedTL || '').trim().toLowerCase(),
    mappedQA: String(user.mappedQA || '').trim().toLowerCase(),
    status: user.status || 'Active',
    createdAt: user.createdAt || new Date().toISOString(),
    displayName: user.displayName || user.name || ''
  };

  if (rowIdx !== -1) {
    // Update existing row
    headers.forEach((h, colIdx) => {
      sheet.getRange(rowIdx, colIdx + 1).setValue(rowData[h]);
    });
  } else {
    // Append new row
    addRowsToSheet(sheet, headers, [rowData]);
  }
  return { status: 'synced', userId: uid };
}

/**
 * Full Dispute Workflow Lifecycle
 */
function handleRaiseDispute(dispute) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const disputeSheet = ss.getSheetByName('DISPUTES');
  const auditSheet = ss.getSheetByName('RANDOMIZED_AUDIT_QUEUE');
  
  const disputeHeaders = ['disputeId', 'auditId', 'raisedBy', 'disputeReason', 'qaResponse', 'finalDecision', 'disputeStatus', 'reopened', 'timestamp', 'historyJson'];
  const newDisputeId = 'disp-' + Date.now();

  const auditId = dispute.auditId;
  const auditIdx = findRowIndex(auditSheet, 1, auditId);
  if (auditIdx === -1) throw new Error('Assigned audit record not found.');

  // Initialize history trace logs
  const history = [
    { action: 'Dispute Raised', timestamp: new Date().toISOString(), user: dispute.raisedBy, reason: dispute.disputeReason }
  ];

  const rowData = {
    disputeId: newDisputeId,
    auditId: auditId,
    raisedBy: String(dispute.raisedBy).trim().toLowerCase(),
    disputeReason: dispute.disputeReason,
    qaResponse: '',
    finalDecision: '',
    disputeStatus: 'Pending',
    reopened: 'No',
    timestamp: new Date().toISOString(),
    historyJson: JSON.stringify(history)
  };

  addRowsToSheet(disputeSheet, disputeHeaders, [rowData]);

  // Update audit record status to 'Pending' in randomized audit sheets
  auditSheet.getRange(auditIdx, 10).setValue('Pending'); // Col 10 match disputeStatus

  return { disputeId: newDisputeId, auditId: auditId };
}

/**
 * Handle responding/reviewing active disputes
 */
function handleRespondDispute(disputeId, comment, status, userRole, userName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const disputeSheet = ss.getSheetByName('DISPUTES');
  const auditSheet = ss.getSheetByName('RANDOMIZED_AUDIT_QUEUE');

  const disputeIdx = findRowIndex(disputeSheet, 1, disputeId);
  if (disputeIdx === -1) throw new Error('Dispute index mismatch.');

  // Fetch older histories
  const historyStr = disputeSheet.getRange(disputeIdx, 10).getValue(); // Col 10 historyJson
  let history = [];
  try {
    history = JSON.parse(historyStr) || [];
  } catch(e) {}

  history.push({
    action: `Status Update to ${status}`,
    timestamp: new Date().toISOString(),
    user: userName ? userName + ` (${userRole})` : 'Supervisor',
    comment: comment
  });

  // Update dispute columns
  disputeSheet.getRange(disputeIdx, 5).setValue(comment); // QA response updated
  disputeSheet.getRange(disputeIdx, 7).setValue(status); // Status updated
  disputeSheet.getRange(disputeIdx, 10).setValue(JSON.stringify(history)); // Log parsed history

  // Update connected randomized audit queue table
  const auditId = disputeSheet.getRange(disputeIdx, 2).getValue();
  const auditIdx = findRowIndex(auditSheet, 1, auditId);
  if (auditIdx !== -1) {
    auditSheet.getRange(auditIdx, 10).setValue(status); // Set disputeStatus
    if (status === 'Resolved') {
      auditSheet.getRange(auditIdx, 7).setValue('Completed'); // Final audit status complete
    }
  }

  return { disputeId: disputeId, status: status };
}

/**
 * Raise warnings/tickets
 */
function handleIssueWarning(warning) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DISCIPLINARY_LOGS');
  const headers = ['warningId', 'agentId', 'agentName', 'agentEmail', 'employeeId', 'qaId', 'level', 'remarks', 'severity', 'status', 'createdAt', 'historyJson'];
  
  const history = [
    { action: 'Warning raised', timestamp: new Date().toISOString() }
  ];

  const record = {
    warningId: warning.warningId || 'wt-' + Date.now(),
    agentId: warning.agentId,
    agentName: warning.agentName,
    agentEmail: String(warning.agentEmail).trim().toLowerCase(),
    employeeId: warning.employeeId || 'EMP-' + Math.floor(Math.random() * 1000),
    qaId: warning.qaId,
    level: warning.level,
    remarks: warning.remarks,
    severity: warning.severity,
    status: 'Pending',
    createdAt: new Date().toISOString(),
    historyJson: JSON.stringify(history)
  };

  addRowsToSheet(sheet, headers, [record]);
  return { warningId: record.warningId };
}

/**
 * Acknowledge warnings
 */
function handleAcknowledgeWarning(warningId, status, userName, userRole) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DISCIPLINARY_LOGS');
  
  const idx = findRowIndex(sheet, 1, warningId);
  if (idx === -1) throw new Error('Warning log index mismatched/not found');

  const historyStr = sheet.getRange(idx, 12).getValue() || '[]';
  let history = [];
  try {
    history = JSON.parse(historyStr);
  } catch(e) {}

  history.push({
    action: `Warning acknowledged by Agent to ${status}`,
    timestamp: new Date().toISOString(),
    userName: userName,
    userRole: userRole
  });

  sheet.getRange(idx, 10).setValue(status); // Col 10 is status
  sheet.getRange(idx, 12).setValue(JSON.stringify(history)); // Col 12 is historyJson

  return { warningId: warningId, status: status };
}
