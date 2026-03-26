// =============================================================
// HOLD — Google Apps Script Backend
// =============================================================
// This script is the bridge between the Hold app and your
// Google Drive. It auto-creates a "Hold Bookings" spreadsheet,
// syncs every lead you save, and sends Gmail notifications.
//
// SETUP (takes ~10 minutes, done once):
// ──────────────────────────────────────────────────────────────
// 1. Go to https://script.google.com → click "New project"
// 2. Delete any existing code in the editor
// 3. Paste this entire file
// 4. Press Ctrl+S (or Cmd+S) to save — name it "Hold Sync"
// 5. Click "Deploy" → "New deployment"
//    → Type: Web app
//    → Execute as: Me
//    → Who has access: Anyone
// 6. Click "Deploy" → copy the Web App URL
// 7. Paste that URL into Hold → Settings → Google Sheets URL
// 8. Hit "Test Connection" — done!
//
// Your "Hold Bookings" sheet will be created automatically
// in your Google Drive the first time a lead is saved.
// =============================================================

const SPREADSHEET_NAME = 'Hold Bookings';
const SHEET_NAME       = 'Leads';

const HEADERS = [
  'ID', 'Contact', 'Platform', 'Venue / Event', 'City', 'Markets',
  'Event Date', 'Offer', 'Status', 'Follow-up Date', 'Next Action',
  'Notes', 'Created', 'Last Updated',
];

// ── GET  ── Used for "Test Connection" from the Hold settings screen
function doGet(e) {
  const result = { success: true, message: 'Hold Sheets is connected and running 🎉' };
  return jsonResponse(result);
}

// ── POST ── Main endpoint — receives lead data and notification requests
function doPost(e) {
  let result;
  try {
    const payload = JSON.parse(e.postData.contents);
    const { action } = payload;

    if (action === 'sync_lead') {
      result = handleSyncLead(payload);
    } else if (action === 'notify_overdue') {
      result = handleOverdueDigest(payload);
    } else if (action === 'test') {
      result = { success: true, message: 'Hold Sheets is connected 🎉' };
    } else {
      result = { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { success: false, error: err.toString() };
  }
  return jsonResponse(result);
}

// ─────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────

function handleSyncLead(payload) {
  const { lead, event, notifyEmail, notifications } = payload;
  if (!lead || !lead.id) return { success: false, error: 'No lead data' };

  // Write to sheet
  const sheetResult = syncLeadToSheet(lead);

  // Send notification email if configured
  let emailSent  = false;
  let emailError = null;

  if (notifyEmail && notifications && event) {
    const shouldNotify = {
      new_lead:   notifications.notifyNew,
      confirmed:  notifications.notifyConfirmed,
      update_lead: false,
    }[event];

    if (shouldNotify) {
      try {
        sendLeadEmail(notifyEmail, event, lead);
        emailSent = true;
      } catch (emailErr) {
        emailError = emailErr.toString();
      }
    }
  }

  return { success: true, sheetAction: sheetResult.action, emailSent, emailError };
}

function handleOverdueDigest(payload) {
  const { leads, notifyEmail } = payload;
  if (!notifyEmail || !leads || leads.length === 0) {
    return { success: true, emailSent: false };
  }
  try {
    sendOverdueDigest(notifyEmail, leads);
    return { success: true, emailSent: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─────────────────────────────────────────────────────────────
// SHEET SYNC
// ─────────────────────────────────────────────────────────────

function syncLeadToSheet(lead) {
  const ss    = getOrCreateSpreadsheet();
  const sheet = getOrCreateLeadsSheet(ss);

  // Find existing row by lead ID
  const allData = sheet.getDataRange().getValues();
  let existingRow = -1;
  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][0]) === String(lead.id)) {
      existingRow = i + 1; // 1-based index
      break;
    }
  }

  const row = buildRow(lead);

  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
    applyStatusColor(sheet, existingRow, lead.status);
    return { action: 'updated', row: existingRow };
  } else {
    sheet.appendRow(row);
    const newRow = sheet.getLastRow();
    applyStatusColor(sheet, newRow, lead.status);
    return { action: 'created', row: newRow };
  }
}

function buildRow(lead) {
  return [
    lead.id           || '',
    lead.contact      || '',
    lead.platform     || '',
    lead.venue        || '',
    lead.city         || '',
    Array.isArray(lead.markets) ? lead.markets.join(', ') : (lead.markets || ''),
    lead.eventDate    || '',
    lead.amount       || '',
    formatStatus(lead.status),
    lead.followUpDate || '',
    lead.nextAction   || '',
    lead.notes        || '',
    lead.createdAt    ? new Date(lead.createdAt).toLocaleString() : '',
    new Date().toLocaleString(),
  ];
}

function formatStatus(status) {
  return {
    new:       'New Inquiry',
    waiting:   'Waiting on Reply',
    tentative: 'Tentative Hold',
    confirmed: 'Confirmed ✅',
    closed:    'Closed',
  }[status] || (status || '');
}

// Color-code the status column for quick scanning
function applyStatusColor(sheet, rowIndex, status) {
  const colors = {
    new:       { bg: '#1e1b4b', fg: '#a5b4fc' },
    waiting:   { bg: '#1c1307', fg: '#fbbf24' },
    tentative: { bg: '#1c1007', fg: '#fb923c' },
    confirmed: { bg: '#052e16', fg: '#4ade80' },
    closed:    { bg: '#1a1a1a', fg: '#9ca3af' },
  };
  const c = colors[status];
  if (!c) return;
  const statusCell = sheet.getRange(rowIndex, 9); // Column 9 = Status
  statusCell.setBackground(c.bg);
  statusCell.setFontColor(c.fg);
}

// ─────────────────────────────────────────────────────────────
// SPREADSHEET SCAFFOLDING
// ─────────────────────────────────────────────────────────────

function getOrCreateSpreadsheet() {
  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  if (files.hasNext()) {
    return SpreadsheetApp.open(files.next());
  }
  // First time — create a fresh spreadsheet
  const ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  Logger.log('Created new spreadsheet: ' + ss.getUrl());
  return ss;
}

function getOrCreateLeadsSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    // Remove the default blank sheet if it's still there
    const blank = ss.getSheetByName('Sheet1');
    if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);
    setupHeaders(sheet);
    return sheet;
  }

  // Sheet exists but might be empty (e.g. user deleted rows)
  if (sheet.getLastRow() === 0) setupHeaders(sheet);

  return sheet;
}

function setupHeaders(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  headerRange.setValues([HEADERS]);
  headerRange.setBackground('#09090f');
  headerRange.setFontColor('#8b5cf6');
  headerRange.setFontWeight('bold');
  headerRange.setFontSize(11);

  sheet.setFrozenRows(1);

  // Set column widths for comfortable reading
  const widths = [130, 160, 130, 200, 120, 180, 110, 100, 140, 120, 200, 260, 160, 160];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // Enable filter
  headerRange.createFilter();
}

// ─────────────────────────────────────────────────────────────
// EMAIL NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

function sendLeadEmail(toEmail, event, lead) {
  const contact  = lead.contact  || 'Unknown contact';
  const venue    = lead.venue    || lead.city || '—';
  const date     = lead.eventDate || 'TBD';
  const amount   = lead.amount   || 'Not specified';
  const platform = lead.platform || '—';
  const action   = lead.nextAction || '—';

  const templates = {
    new_lead: {
      subject: `📩 New inquiry: ${contact}`,
      body: [
        `A new booking inquiry has been logged in Hold.\n`,
        `Contact:      ${contact}`,
        `Platform:     ${platform}`,
        `Venue:        ${venue}`,
        `Event Date:   ${date}`,
        `Offer:        ${amount}`,
        `Status:       ${formatStatus(lead.status)}`,
        `Next action:  ${action}`,
        `\nView your full lead list in the "Hold Bookings" sheet in Google Drive.`,
      ].join('\n'),
    },
    confirmed: {
      subject: `✅ Booking confirmed: ${contact}`,
      body: [
        `A booking just got confirmed in Hold! 🎉\n`,
        `Contact:     ${contact}`,
        `Venue:       ${venue}`,
        `Event Date:  ${date}`,
        `Offer:       ${amount}`,
        `\nCongratulations — check your Hold Bookings sheet for full details.`,
      ].join('\n'),
    },
  };

  const tmpl = templates[event];
  if (!tmpl) return;
  GmailApp.sendEmail(toEmail, tmpl.subject, tmpl.body);
}

function sendOverdueDigest(toEmail, leads) {
  const lines = leads
    .map(l => `  •  ${l.contact || 'Unknown'} — ${l.venue || l.city || '—'}  (due ${l.followUpDate || '?'})`)
    .join('\n');

  const count   = leads.length;
  const subject = `⏰ ${count} follow-up${count > 1 ? 's' : ''} overdue — Hold`;
  const body    = [
    `You have ${count} overdue follow-up${count > 1 ? 's' : ''} in Hold:\n`,
    lines,
    `\nOpen Hold to reach out and keep the momentum going.`,
  ].join('\n');

  GmailApp.sendEmail(toEmail, subject, body);
}

// ─────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────

function jsonResponse(obj) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
