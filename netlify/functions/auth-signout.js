'use strict';
// =============================================================
// POST /.netlify/functions/auth-signout
//
// Deletes the server-side session from Netlify Blobs and
// clears the session cookie. Always returns 200.
// =============================================================

const cookie = require('cookie');
const { deleteSession } = require('./_lib/session');

exports.handler = async (event) => {
  try {
    const cookies   = cookie.parse(event.headers.cookie || '');
    const sessionId = cookies.hold_session;
    if (sessionId) await deleteSession(sessionId);
  } catch (err) {
    console.warn('[auth-signout] delete session failed:', err.message);
  }

  const secure    = !isLocalhost(event);
  const clearCookie = cookie.serialize('hold_session', '', {
    httpOnly: true,
    secure:   secure,
    sameSite: secure ? 'strict' : 'lax',
    maxAge:   0,
    path:     '/',
  });

  return {
    statusCode: 200,
    headers: {
      'Set-Cookie':   clearCookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ success: true }),
  };
};

function isLocalhost(event) {
  const host = event.headers.host || '';
  return host.includes('localhost') || host.includes('127.0.0.1');
}
