"use strict";
/**
 * Recognise "the login is dead" in claude / codex CLI error output, and build
 * the single error barnowl answers with (HTTP 401 via otterly's
 * errorToHttpStatus, which keys on the word "authentication").
 *
 * Real strings this must catch (captured 2026-09-21):
 *   claude  "Failed to authenticate. API Error: 401 OAuth access token is invalid."
 *   claude  "OAuth access token has been revoked."
 *   codex   "ERROR: Your access token could not be refreshed. Please log out and sign in again."
 *   codex   "failed to connect to websocket: HTTP error: 401 Unauthorized"
 */
const AUTH_PATTERNS = [
  /\b401\b/,
  /authenticat/i,
  /\boauth\b[^\n]*\b(revoked|invalid|expired)\b/i,
  /unauthori[sz]ed/i,
  /refresh token/i,
  /\b(sign|log)(g?ing)? ?in again\b/i,
  /please run \/login/i,
  /not logged in/i,
];

const NAMES = { claude: "Claude", codex: "Codex" };

function isAuthError(text) {
  const s = String(text || "");
  return AUTH_PATTERNS.some((re) => re.test(s));
}

function authMessage(provider) {
  const name = NAMES[provider] || provider;
  return `${name} authentication failed — the login was revoked or has expired. ` +
    `Run \`barnowl login ${provider}\` (no restart needed).`;
}

/** Error for non-otterly engines; routes read barnowlCode for the circuit breaker. */
function authError(provider) {
  const err = new Error(authMessage(provider));
  err.barnowlCode = "NOT_AUTHENTICATED";
  return err;
}

module.exports = { isAuthError, authMessage, authError, NAMES };
