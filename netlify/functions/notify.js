'use strict';
// =============================================================
// POST /.netlify/functions/notify
//
// Sends Gmail notifications for Hold lead events.
//
// Events handled:
//   new_lead         — a new lead was created
//   status_change    — a lead's status was updated
//   overdue_digest   — daily digest of leads past their follow-up date
//
// Request body:
//   {
//     event:   'new_lead' | 'status_change' | 'overdue_digest',
//     lead:    LeadObject,          // for new_lead / status_change
//     leads:   LeadObject[],        // for overdue_digest
//     to:      string[],            // recipient email addresses
//     // optional per-event fields:
//     oldStatus: string,            // for status_change
//   }
//
// Response:
//   { success: true, messageId: string }
// =============================================================

const cookie = require('cookie');
const { google } = require('googleapis');
const { getSession } = require('./_lib/session');
const { createAuthedClient } = require('./_lib/google');

// Status display labels (mirrors sheets-sync.js)
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
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return jsonError(400, 'Invalid JSON body');
  }

  const { event: notifyEvent, lead, leads, to, oldStatus } = body;

  if (!notifyEvent) {
    return jsonError(400, 'Missing event type');
  }
  if (!to || !Array.isArray(to) || to.length === 0) {
    return jsonError(400, 'Missing or empty to[] array');
  }

  // ── Build message ─────────────────────────────────────────
  let subject, htmlBody;

  try {
    switch (notifyEvent) {
      case 'new_lead':
        if (!lead) return jsonError(400, 'Missing lead for new_lead event');
        ({ subject, htmlBody } = buildNewLeadEmail(lead));
        break;

      case 'status_change':
        if (!lead) return jsonError(400, 'Missing lead for status_change event');
        ({ subject, htmlBody } = buildStatusChangeEmail(lead, oldStatus));
        break;

      case 'overdue_digest':
        if (!leads || !Array.isArray(leads) || leads.length === 0) {
          // Nothing to do — return success silently
          return jsonOk({ success: true, skipped: true });
        }
        ({ subject, htmlBody } = buildOverdueDigestEmail(leads));
        break;

      default:
        return jsonError(400, `Unknown event type: ${notifyEvent}`);
    }
  } catch (err) {
    return jsonError(500, `Failed to build email: ${err.message}`);
  }

  // ── Send via Gmail API ────────────────────────────────────
  try {
    const authClient = createAuthedClient(session, sessionId);
    const gmail      = google.gmail({ version: 'v1', auth: authClient });

    const raw = buildRfc2822Message({
      from:    session.email,
      to:      to.join(', '),
      subject,
      htmlBody,
    });

    const res = await gmail.users.messages.send({
      userId:      'me',
      requestBody: { raw },
    });

    return jsonOk({ success: true, messageId: res.data.id });
  } catch (err) {
    console.error('[notify]', err.message, err.stack);
    return jsonError(500, err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// EMAIL BUILDERS
// ─────────────────────────────────────────────────────────────

function buildNewLeadEmail(lead) {
  const subject = `[Hold] New Inquiry — ${lead.contact || 'Unknown'} @ ${lead.venue || 'Unknown Venue'}`;

  const htmlBody = `
    ${emailHeader()}
    <h2 style="color:#8b5cf6;margin:0 0 16px;">New Inquiry</h2>
    ${leadCard(lead)}
    ${emailFooter()}
  `;

  return { subject, htmlBody };
}

function buildStatusChangeEmail(lead, oldStatus) {
  const oldLabel = STATUS_LABELS[oldStatus] || oldStatus || 'Unknown';
  const newLabel = STATUS_LABELS[lead.status] || lead.status || 'Unknown';

  const subject = `[Hold] Status Update — ${lead.contact || 'Unknown'} → ${newLabel}`;

  const htmlBody = `
    ${emailHeader()}
    <h2 style="color:#8b5cf6;margin:0 0 8px;">Status Updated</h2>
    <p style="margin:0 0 16px;color:#9ca3af;font-size:14px;">
      <span style="color:#6b7280;">${oldLabel}</span>
      <span style="margin:0 8px;">→</span>
      <strong style="color:#8b5cf6;">${newLabel}</strong>
    </p>
    ${leadCard(lead)}
    ${emailFooter()}
  `;

  return { subject, htmlBody };
}

function buildOverdueDigestEmail(leads) {
  const count   = leads.length;
  const subject = `[Hold] ${count} Lead${count !== 1 ? 's' : ''} Need Follow-Up`;

  const rows = leads.map(lead => {
    const status    = STATUS_LABELS[lead.status] || lead.status || '';
    const followUp  = lead.followUpDate ? formatDate(lead.followUpDate) : '—';
    const eventDate = lead.eventDate    ? formatDate(lead.eventDate)    : '—';

    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #374151;color:#f3f4f6;">
          ${esc(lead.contact || '—')}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #374151;color:#9ca3af;">
          ${esc(lead.venue || '—')}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #374151;color:#f87171;">
          ${followUp}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #374151;color:#9ca3af;">
          ${eventDate}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #374151;">
          <span style="
            background:${statusBg(lead.status)};
            color:${statusColor(lead.status)};
            padding:2px 8px;
            border-radius:9999px;
            font-size:12px;
          ">${esc(status)}</span>
        </td>
      </tr>
    `;
  }).join('');

  const htmlBody = `
    ${emailHeader()}
    <h2 style="color:#8b5cf6;margin:0 0 8px;">Follow-Up Digest</h2>
    <p style="margin:0 0 20px;color:#9ca3af;font-size:14px;">
      ${count} lead${count !== 1 ? 's' : ''} past their follow-up date
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;font-family:system-ui,sans-serif;">
      <thead>
        <tr style="background:#1f2937;">
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #374151;">Contact</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #374151;">Venue</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #374151;">Follow-Up</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #374151;">Event</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #374151;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    ${emailFooter()}
  `;

  return { subject, htmlBody };
}

// ─────────────────────────────────────────────────────────────
// HTML TEMPLATE HELPERS
// ─────────────────────────────────────────────────────────────

function emailHeader() {
  return `
    <div style="
      font-family:system-ui,-apple-system,sans-serif;
      background:#09090f;
      padding:24px;
      border-radius:12px;
      max-width:600px;
      color:#f3f4f6;
    ">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;">
      <span style="
        font-size:20px;font-weight:700;
        background:linear-gradient(135deg,#8b5cf6,#6366f1);
        -webkit-background-clip:text;
        -webkit-text-fill-color:transparent;
        background-clip:text;
      ">Hold</span>
      <span style="color:#374151;font-size:14px;">/ Booking Tracker</span>
    </div>
  `;
}

function emailFooter() {
  return `
    <p style="margin:24px 0 0;font-size:12px;color:#4b5563;border-top:1px solid #1f2937;padding-top:16px;">
      Sent by Hold · You can manage notification settings in the app.
    </p>
    </div>
  `;
}

function leadCard(lead) {
  const status = STATUS_LABELS[lead.status] || lead.status || '';
  const fields = [
    ['Contact',     lead.contact],
    ['Platform',    lead.platform],
    ['Venue',       lead.venue],
    ['City',        lead.city],
    ['Event Date',  lead.eventDate    ? formatDate(lead.eventDate)    : null],
    ['Follow-Up',   lead.followUpDate ? formatDate(lead.followUpDate) : null],
    ['Offer',       lead.amount       ? `$${lead.amount}`            : null],
    ['Notes',       lead.notes],
  ].filter(([, v]) => v);

  const rows = fields.map(([label, value]) => `
    <tr>
      <td style="padding:8px 12px;color:#6b7280;font-size:13px;width:120px;white-space:nowrap;">${label}</td>
      <td style="padding:8px 12px;color:#f3f4f6;font-size:13px;">${esc(value)}</td>
    </tr>
  `).join('');

  return `
    <div style="background:#111827;border-radius:8px;overflow:hidden;margin-bottom:16px;">
      <div style="padding:12px 16px;border-bottom:1px solid #1f2937;display:flex;align-items:center;justify-content:space-between;">
        <span style="font-weight:600;color:#f3f4f6;">${esc(lead.contact || 'Unknown Contact')}</span>
        <span style="
          background:${statusBg(lead.status)};
          color:${statusColor(lead.status)};
          padding:3px 10px;
          border-radius:9999px;
          font-size:12px;
          font-weight:500;
        ">${esc(status)}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function statusBg(status) {
  const map = {
    new:       '#1e1b4b',
    waiting:   '#1c1917',
    tentative: '#1a1a2e',
    confirmed: '#052e16',
    closed:    '#1f1f1f',
  };
  return map[status] || '#1f2937';
}

function statusColor(status) {
  const map = {
    new:       '#a5b4fc',
    waiting:   '#fed7aa',
    tentative: '#c4b5fd',
    confirmed: '#86efac',
    closed:    '#9ca3af',
  };
  return map[status] || '#d1d5db';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
// RFC 2822 MESSAGE BUILDER
// ─────────────────────────────────────────────────────────────

function buildRfc2822Message({ from, to, subject, htmlBody }) {
  // Wrap in a minimal HTML document
  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:16px;background:#09090f;">
  ${htmlBody}
</body>
</html>`;

  const boundary = `boundary_${Date.now().toString(36)}`;

  // Plain-text fallback (strip HTML tags, keep structure)
  const plainText = htmlBody
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    plainText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    fullHtml,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  // Gmail API requires base64url encoding
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function jsonOk(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

function jsonError(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message }),
  };
}
