'use strict';
// =============================================================
// POST /.netlify/functions/auth-callback
//
// Receives the authorization code from the frontend (after the
// GIS popup flow), exchanges it for tokens, fetches user info,
// creates a server-side session in Netlify Blobs, and sets an
// httpOnly session cookie.
//
// The refresh token is stored ONLY in Netlify Blobs — it never
// reaches the browser. The access token is also server-side only.
// =============================================================

const cookie = require('cookie');
const { exchangeCode, getUserInfo } = require('./_lib/google');
const { createSession } = require('./_lib/session');

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { code } = body;
    if (!code) {
      return jsonError(400, 'Missing authorization code', event);
    }

    // 1. Exchange authorization code → access_token + refresh_token
    const tokens = await exchangeCode(code);
    if (!tokens.access_token) {
      throw new Error('Token exchange returned no access_token');
    }

    // 2. Fetch identity from Google
    const userInfo = await getUserInfo(tokens.access_token);
    if (!userInfo.id) {
      throw new Error('Could not retrieve Google user info');
    }

    // 3. Create server-side session (tokens stored in Netlify Blobs)
    const sessionId = await createSession({
      userId:        userInfo.id,
      email:         userInfo.email,
      name:          userInfo.name,
      picture:       userInfo.picture,
      accessToken:   tokens.access_token,
      refreshToken:  tokens.refresh_token  || null,
      tokenExpiry:   tokens.expiry_date    || null,
      spreadsheetId: null, // Populated on first sync
    });

    // 4. Set httpOnly session cookie — refresh token stays server-side
    const secure = !isLocalhost(event);
    const cookieStr = cookie.serialize('hold_session', sessionId, {
      httpOnly:  true,
      secure:    secure,
      sameSite:  secure ? 'strict' : 'lax',
      maxAge:    7 * 24 * 60 * 60, // 7 days
      path:      '/',
    });

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(event),
        'Set-Cookie':    cookieStr,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        success: true,
        user: {
          email:   userInfo.email,
          name:    userInfo.name,
          picture: userInfo.picture,
        },
      }),
    };
  } catch (err) {
    console.error('[auth-callback]', err.message);
    return jsonError(400, err.message, event);
  }
};

// ─── helpers ────────────────────────────────────────────────

function corsHeaders(event) {
  const origin = event.headers.origin || event.headers.Origin || '';
  return {
    'Access-Control-Allow-Origin':      origin,
    'Access-Control-Allow-Methods':     'POST, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function jsonError(statusCode, message, event) {
  return {
    statusCode,
    headers: { ...corsHeaders(event), 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message }),
  };
}

function isLocalhost(event) {
  const host = event.headers.host || '';
  return host.includes('localhost') || host.includes('127.0.0.1');
}
