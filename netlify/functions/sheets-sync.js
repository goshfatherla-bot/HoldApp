'use strict';
// =============================================================
// POST /.netlify/functions/sheets-sync
//
// Syncs a single lead to the user's "Hold Bookings" Google Sheet.
// Hold is the source of truth. This is one-way: Hold → Sheet only.
//
// Flow:
//   1. Validate session from cookie
//   2. Get/create "Hold Bookings" spreadsheet
//   3. Ensure "Leads" sheet + headers exist
//   4. Find row by Lead ID (column A)
//   5. Update that row if found, append if not
//
// Request body:
//   { lead: LeadObject, spreadsheetId: string|null }
//
// Response:
//   { success: true, spreadsheetId: string, action: 'updated'|'appended' }
// =============================================================

const cookie   = require('cookie');
const { google } = require('googleapis');
const { getSession, updateSession } = require('./_lib/session');
const { createAuthedClient } = require('./_lib/google');

const SPREADSHEET_NAME = 'Hold Bookings';
const SHEET_NAME       = 'Leads';

const HEADERS = [
  'Lead ID', 'Created At', 'Updated At', 'Contact Name', 'Platform',
  'Venue', 'City', 'Markets', 'Offer', 'Event Date', 'Follow Up Date',
  'Status', 'Notes', 'Source Thread Count', 'Source Screenshot Count',
];

// Status display labels
const STATUS_LABELS = {
  new:       'New Inquiry',
  waiting:   'Waiting on Reply',
  tentative: 'Tentative Hold',
  confirmed: 'Confirmed',
  closed:    'Closed',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // ── Auth ──────────────────────────────────────────────────
  const cookies   = cookie.parse(event.headers.cookie || '');
  const sessionId = cookies.hold_session;
  const session   = await getSession(sessionId);

  if (!session) {
    return jsonError(401, 'Not authenticated');
  }

  // ── Parse body ────────────────────────────────────────────
  let lead, clientSpreadsheetId;
  try {
    const body        = JSON.parse(event.body || '{}');
    lead              = body.lead;
    clientSpreadsheetId = body.spreadsheetId || null;
  } catch (err) {
    return jsonError(400, 'Invalid JSON body');
  }

  if (!lead || !lead.id) {
    return jsonError(400, 'Missing lead.id');
  }

  // ── Sheets sync ───────────────────────────────────────────
  try {
    const authClient = createAuthedClient(session, sessionId);
    const sheets     = google.sheets({ version: 'v4', auth: authClient });

    // Resolve spreadsheet ID (session cache → client hint → create new)
    let spreadsheetId = session.spreadsheetId || clientSpreadsheetId;

    if (spreadsheetId) {
      // Verify it still exists and is accessible
      try {
        await sheets.spreadsheets.get({
          spreadsheetId,
          fields: 'spreadsheetId',
        });
      } catch (err) {
        if (err.code === 404 || err.code === 403) {
          // User deleted or revoked — create a fresh one
          console.warn('[sheets-sync] Spreadsheet inaccessible, creating new.');
          spreadsheetId = null;
        } else {
          throw err;
        }
      }
    }

    if (!spreadsheetId) {
      spreadsheetId = await createSpreadsheet(sheets);
      await updateSession(sessionId, { spreadsheetId });
    } else {
      // Make sure the Leads sheet + headers are in place
      await ensureLeadsSheet(sheets, spreadsheetId);
    }

    // Upsert the lead row
    const action = await upsertLead(sheets, spreadsheetId, lead);

    // Cache spreadsheet ID in session for future calls
    if (!session.spreadsheetId || session.spreadsheetId !== spreadsheetId) {
      await updateSession(sessionId, { spreadsheetId });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, spreadsheetId, action }),
    };
  } catch (err) {
    console.error('[sheets-sync]', err.message, err.stack);
    return jsonError(500, err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// SPREADSHEET SCAFFOLDING
// ─────────────────────────────────────────────────────────────

async function createSpreadsheet(sheets) {
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: SPREADSHEET_NAME },
      sheets: [{
        properties: {
          title:          SHEET_NAME,
          gridProperties: { frozenRowCount: 1 },
        },
      }],
    },
    fields: 'spreadsheetId,sheets.properties.sheetId',
  });

  const spreadsheetId = res.data.spreadsheetId;
  const sheetId       = res.data.sheets[0].properties.sheetId;

  // Write headers
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range:            `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody:      { values: [HEADERS] },
  });

  // Style: freeze row 1, bold purple headers, set column widths
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.035, green: 0.035, blue: 0.059 },
                textFormat: {
                  bold: true,
                  foregroundColor: { red: 0.545, green: 0.361, blue: 0.929 },
                  fontSize: 11,
                },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        },
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        // Set readable column widths
        ...columnWidths(sheetId, [130, 160, 160, 160, 130, 180, 120, 180, 100, 110, 120, 140, 260, 160, 180]),
        // Auto-filter on header row
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex:   1,
                startColumnIndex: 0,
                endColumnIndex:   HEADERS.length,
              },
            },
          },
        },
      ],
    },
  });

  return spreadsheetId;
}

function columnWidths(sheetId, widths) {
  return widths.map((pixelSize, columnIndex) => ({
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension:        'COLUMNS',
        startIndex:       columnIndex,
        endIndex:         columnIndex + 1,
      },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  }));
}

async function ensureLeadsSheet(sheets, spreadsheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_NAME}!A1:${colLetter(HEADERS.length)}1`,
    });
    const existingHeaders = res.data.values?.[0] || [];
    if (existingHeaders[0] !== 'Lead ID') {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range:            `${SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody:      { values: [HEADERS] },
      });
    }
  } catch (err) {
    // Tab might not exist — log but don't crash;
    // the upsert will surface the real error.
    console.warn('[sheets-sync] ensureLeadsSheet:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// UPSERT LOGIC
// ─────────────────────────────────────────────────────────────

async function upsertLead(sheets, spreadsheetId, lead) {
  // Get all values in column A (Lead IDs)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:A`,
  });
  const colA = (res.data.values || []).map(r => (r[0] || '').toString().trim());

  // colA[0] = 'Lead ID' header, colA[1…] = actual IDs
  const rowIndex = colA.indexOf(lead.id.toString().trim()); // 0-based in the array

  const row = buildRow(lead);

  if (rowIndex > 0) {
    // Found — update in place (sheet row = array index + 1 for 1-based)
    const sheetRow = rowIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range:            `${SHEET_NAME}!A${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody:      { values: [row] },
    });
    return 'updated';
  } else {
    // Not found — append below existing rows
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range:            `${SHEET_NAME}!A:${colLetter(HEADERS.length)}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody:      { values: [row] },
    });
    return 'appended';
  }
}

function buildRow(lead) {
  const markets = Array.isArray(lead.markets)
    ? lead.markets.join(', ')
    : (lead.markets || '');

  return [
    lead.id              || '',
    lead.createdAt       ? new Date(lead.createdAt).toLocaleString()  : '',
    new Date().toLocaleString(),
    lead.contact         || '',
    lead.platform        || '',
    lead.venue           || '',
    lead.city            || '',
    markets,
    lead.amount          || '',
    lead.eventDate       || '',
    lead.followUpDate    || '',
    STATUS_LABELS[lead.status] || lead.status || '',
    lead.notes           || '',
    lead.sourceThreadCount       || '',
    (lead.screenshots || []).length || '',
  ];
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

/** Convert a 1-based column index to a letter (1→A, 26→Z, 27→AA) */
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function jsonError(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message }),
  };
}
