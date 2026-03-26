'use strict';
// =============================================================
// Google OAuth2 helpers.
//
// Scopes requested:
//   openid, email, profile
//   https://www.googleapis.com/auth/spreadsheets
//   https://www.googleapis.com/auth/gmail.send
//
// The authorization code flow uses ux_mode: 'popup' on the
// frontend, so redirect_uri is 'postmessage' — the code is
// returned directly to the JS callback, not via a redirect.
// =============================================================

const { google } = require('googleapis');
const { updateSession } = require('./session');

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.send',
];

/**
 * Create a bare OAuth2 client (no credentials attached).
 */
function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'postmessage'   // popup-based code flow — no server redirect needed
  );
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
async function exchangeCode(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, token_type, … }
}

/**
 * Fetch user identity using an access token.
 */
async function getUserInfo(accessToken) {
  const client = createOAuthClient();
  client.setCredentials({ access_token: accessToken });
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();
  return data; // { id, email, name, picture, locale, … }
}

/**
 * Build an authed OAuth2 client from a stored session.
 * Attaches a 'tokens' listener so refreshed tokens are
 * automatically persisted back to Netlify Blobs.
 */
function createAuthedClient(session, sessionId) {
  const client = createOAuthClient();
  client.setCredentials({
    access_token:  session.accessToken,
    refresh_token: session.refreshToken,
    expiry_date:   session.tokenExpiry,
  });

  // Persist any freshly issued tokens transparently
  client.on('tokens', async (tokens) => {
    const updates = {};
    if (tokens.access_token)  updates.accessToken  = tokens.access_token;
    if (tokens.refresh_token) updates.refreshToken = tokens.refresh_token;
    if (tokens.expiry_date)   updates.tokenExpiry  = tokens.expiry_date;
    if (Object.keys(updates).length > 0) {
      await updateSession(sessionId, updates).catch(err =>
        console.warn('[google] token persist failed:', err.message)
      );
    }
  });

  return client;
}

module.exports = { createOAuthClient, exchangeCode, getUserInfo, createAuthedClient, SCOPES };
