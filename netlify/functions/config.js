'use strict';
// =============================================================
// GET /.netlify/functions/config
// Returns public configuration values needed by the frontend.
// Only non-sensitive values here — NEVER return secrets.
// =============================================================

exports.handler = async () => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'GOOGLE_CLIENT_ID environment variable is not set.',
        googleEnabled: false,
      }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300', // 5-minute cache
    },
    body: JSON.stringify({
      googleEnabled: true,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
    }),
  };
};
