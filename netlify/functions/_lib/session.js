'use strict';
// =============================================================
// Session storage using Netlify Blobs.
//
// In production: works automatically — Netlify injects the
//   NETLIFY_BLOBS_CONTEXT environment variable at runtime.
//
// In local development (netlify dev):
//   Requires NETLIFY_TOKEN (your personal Netlify access token)
//   and NETLIFY_SITE_ID in your .env file. Netlify Dev ≥4.x
//   sets these automatically if you're logged in via the CLI.
// =============================================================

const { getStore } = require('@netlify/blobs');
const { v4: uuidv4 } = require('uuid');

const STORE_NAME   = 'hold-sessions';
const SESSION_TTL  = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

function store() {
  return getStore(STORE_NAME);
}

/**
 * Create a new session, return the session ID.
 * @param {object} data  — tokens + user info to persist
 * @returns {string}       session ID (stored in httpOnly cookie)
 */
async function createSession(data) {
  const sessionId = uuidv4();
  const payload = {
    ...data,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL,
  };
  await store().set(sessionId, JSON.stringify(payload));
  return sessionId;
}

/**
 * Read a session by ID. Returns null if missing or expired.
 */
async function getSession(sessionId) {
  if (!sessionId) return null;
  try {
    const raw = await store().get(sessionId);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.expiresAt && data.expiresAt < Date.now()) {
      await store().delete(sessionId).catch(() => {});
      return null;
    }
    return data;
  } catch (err) {
    console.error('[session] getSession error:', err.message);
    return null;
  }
}

/**
 * Merge updates into an existing session (used for token refresh).
 */
async function updateSession(sessionId, updates) {
  const existing = await getSession(sessionId);
  if (!existing) return false;
  const merged = { ...existing, ...updates };
  await store().set(sessionId, JSON.stringify(merged));
  return true;
}

/**
 * Delete a session (sign-out).
 */
async function deleteSession(sessionId) {
  try {
    await store().delete(sessionId);
  } catch (err) {
    console.warn('[session] deleteSession error:', err.message);
  }
}

module.exports = { createSession, getSession, updateSession, deleteSession };
