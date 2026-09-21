"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAuthError, authMessage, authError } = require("../lib/auth-errors.cjs");

// Real CLI output captured 2026-09-21 (claude with a bogus token, codex with a bogus auth.json).
const AUTH = [
  "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
  "OAuth access token has been revoked.",
  "ERROR: Your access token could not be refreshed. Please log out and sign in again.",
  "failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://chatgpt.com/backend-api/codex/responses",
  "Could not validate your refresh token. Please try signing in again.",
  "Invalid API key · Please run /login",
  "Not logged in",
];
const NOT_AUTH = [
  "API Error: 429 rate_limit_error: Number of requests has exceeded your rate limit",
  "Credit balance is too low",
  "API Error: 529 overloaded_error",
  "Prompt is too long",
  "request id req_401abc failed",
];

test("isAuthError: recognises real Claude / Codex auth failures", () => {
  for (const s of AUTH) assert.equal(isAuthError(s), true, s);
});

test("isAuthError: other failures are not auth errors", () => {
  for (const s of NOT_AUTH) assert.equal(isAuthError(s), false, s);
  assert.equal(isAuthError(""), false);
  assert.equal(isAuthError(undefined), false);
});

test("authMessage names the provider and the fix", () => {
  assert.equal(
    authMessage("claude"),
    "Claude authentication failed — the login was revoked or has expired. Run `barnowl login claude` (no restart needed).",
  );
  assert.match(authMessage("codex"), /^Codex authentication failed .* `barnowl login codex`/);
});

test("authError carries the message and barnowlCode", () => {
  const e = authError("codex");
  assert.ok(e instanceof Error);
  assert.equal(e.message, authMessage("codex"));
  assert.equal(e.barnowlCode, "NOT_AUTHENTICATED");
});
