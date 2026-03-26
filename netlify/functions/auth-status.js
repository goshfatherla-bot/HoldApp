'use strict';
// =============================================================
// GET /.netlify/functions/auth-status
//
// Called on app load. Reads the session cookie and returns
// the current user info + spreadsheet ID if authenticated.
// Returns { authenticated: false } if no valid session.
// =============================================================

const cookie = require('cookie');
const { getSession } = require('./_lib/session');

exports.handler = async (event) => {
  try {
    const cookies = cookie.parse(event.headers.cookie || '');
    const sessionId = cookies.hold_session;
    const session   = await getSession(sessionId);

    if (!session) {
      return jsonOk({ authenticated: false });
    }

    return jsonOk({
      authenticated:  true,
      user: {
        email:   session.email,
        name:    session.name,
        picture: session.picture,
      },
      spreadsheetId: session.spreadsheetId || null,
    });
  } catch (err) {
    console.error('[auth-status]', err.message);
    // Fail gracefully — app still works without Google
    return jsonOk({ authenticated: false });
  }
};

function jsonOk(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}
