"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const oauth = require("../lib/claude-oauth.cjs");

const HOUR = 3600_000;
const now = () => 1_700_000_000_000;
const cred = (over = {}) => ({
  token: "at-stored",
  expiresAt: now() + HOUR,
  refreshToken: "rt-stored",
  refreshTokenExpiresAt: now() + 30 * 24 * HOUR,
  scopes: ["user:inference", "user:profile"],
  source: "keychain",
  store: { kind: "keychain", account: "alice" },
  ...over,
});

// A refresh endpoint stub: records the calls, answers with `body`.
const tokenServer = (body, { status = 200, calls = [] } = {}) => async (url, opts) => {
  calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
  return { status, json: async () => body };
};

test.beforeEach(() => oauth._reset());

test("accessToken: a live stored token is used as-is, no refresh", async () => {
  let fetched = false;
  const r = await oauth.accessToken({
    read: () => cred(), now,
    fetchImpl: async () => { fetched = true; },
    persistImpl: () => "skipped",
  });
  assert.deepEqual(r, { token: "at-stored", expiresAt: now() + HOUR, refreshed: false });
  assert.equal(fetched, false);
});

test("accessToken: a token inside the skew window counts as spent", async () => {
  const calls = [];
  const r = await oauth.accessToken({
    read: () => cred({ expiresAt: now() + 60_000 }), now,
    fetchImpl: tokenServer({ access_token: "at-new", expires_in: 3600 }, { calls }),
    persistImpl: () => "written",
  });
  assert.equal(r.token, "at-new");
  assert.equal(r.refreshed, true);
  assert.equal(calls.length, 1);
});

test("refresh: posts the CLI's grant shape to the CLI's endpoint", async () => {
  const calls = [];
  const next = await oauth.refresh(cred(), {
    now,
    fetchImpl: tokenServer({ access_token: "at-new", expires_in: 7200, refresh_token_expires_in: 86400 }, { calls }),
  });
  assert.equal(calls[0].url, oauth.TOKEN_URL);
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(calls[0].body, {
    grant_type: "refresh_token",
    refresh_token: "rt-stored",
    client_id: oauth.CLIENT_ID,
    scope: "user:inference user:profile",
  });
  assert.equal(next.token, "at-new");
  assert.equal(next.expiresAt, now() + 7200_000);
  assert.equal(next.refreshToken, "rt-stored", "an unrotated refresh token is carried over");
  assert.equal(next.refreshTokenExpiresAt, now() + 86400_000);
  assert.equal(next.rotated, false);
});

test("refresh: a rotated refresh token is taken and flagged", async () => {
  const next = await oauth.refresh(cred(), {
    now,
    fetchImpl: tokenServer({ access_token: "at-new", expires_in: 3600, refresh_token: "rt-rotated" }),
  });
  assert.equal(next.refreshToken, "rt-rotated");
  assert.equal(next.rotated, true);
});

test("refresh: no refresh token → OauthError, nothing posted", async () => {
  let fetched = false;
  await assert.rejects(
    oauth.refresh(cred({ refreshToken: null }), { now, fetchImpl: async () => { fetched = true; } }),
    (e) => e instanceof oauth.OauthError && e.code === "no_refresh_token" && /log in again/.test(e.message));
  assert.equal(fetched, false);
});

test("refresh: an expired refresh token is not spent on a round trip", async () => {
  await assert.rejects(
    oauth.refresh(cred({ refreshTokenExpiresAt: now() - 1 }), { now, fetchImpl: async () => { throw new Error("posted"); } }),
    (e) => e.code === "refresh_expired");
});

test("refresh: non-200 carries the upstream detail", async () => {
  await assert.rejects(
    oauth.refresh(cred(), { now, fetchImpl: tokenServer({ error: "invalid_grant" }, { status: 400 }) }),
    (e) => e.code === "refused" && /400/.test(e.message) && /invalid_grant/.test(e.message));
});

test("refresh: a response without access_token is malformed", async () => {
  await assert.rejects(
    oauth.refresh(cred(), { now, fetchImpl: tokenServer({ expires_in: 3600 }) }),
    (e) => e.code === "malformed");
});

test("persist: merges into the stored blob, keeping unrelated fields", () => {
  let written = null;
  const r = oauth.persist(
    { ...cred(), token: "at-new", expiresAt: 9, refreshToken: "rt-new", refreshTokenExpiresAt: 99 },
    {
      keychain: () => JSON.stringify({ claudeAiOauth: { accessToken: "at-old", refreshToken: "rt-old", subscriptionType: "max", rateLimitTier: "x" } }),
      keychainWrite: (account, raw) => { written = { account, raw }; return true; },
    });
  assert.equal(r, "written");
  assert.equal(written.account, "alice");
  assert.deepEqual(JSON.parse(written.raw).claudeAiOauth, {
    accessToken: "at-new", expiresAt: 9, refreshToken: "rt-new", refreshTokenExpiresAt: 99,
    subscriptionType: "max", rateLimitTier: "x",
  });
});

test("persist: a failed store write is reported, not thrown", () => {
  assert.equal(oauth.persist({ ...cred(), store: { kind: "keychain", account: "a" } },
    { keychain: () => null, keychainWrite: () => false }), "failed");
  assert.equal(oauth.persist({ ...cred(), store: null }), "skipped");
});

test("accessToken: concurrent callers share one refresh", async () => {
  const calls = [];
  const fetchImpl = tokenServer({ access_token: "at-new", expires_in: 3600 }, { calls });
  const opts = { read: () => cred({ expiresAt: now() - 1 }), now, fetchImpl, persistImpl: () => "written" };
  const [a, b, c] = await Promise.all([oauth.accessToken(opts), oauth.accessToken(opts), oauth.accessToken(opts)]);
  assert.equal(calls.length, 1);
  assert.deepEqual([a.token, b.token, c.token], ["at-new", "at-new", "at-new"]);
});

test("accessToken: a store refreshed by Claude Code wins over our cached token", async () => {
  const calls = [];
  const fetchImpl = tokenServer({ access_token: "at-ours", expires_in: 3600 }, { calls });
  const first = await oauth.accessToken({
    read: () => cred({ expiresAt: now() - 1 }), now, fetchImpl, persistImpl: () => "written",
  });
  assert.equal(first.token, "at-ours");
  const second = await oauth.accessToken({
    read: () => cred({ token: "at-from-cli", expiresAt: now() + HOUR }), now, fetchImpl,
    persistImpl: () => "written",
  });
  assert.equal(second.token, "at-from-cli");
  assert.equal(calls.length, 1, "no second refresh");
});

test("accessToken: an unwritable store still yields a usable token", async () => {
  const logged = [];
  const r = await oauth.accessToken({
    read: () => cred({ expiresAt: now() - 1 }), now,
    fetchImpl: tokenServer({ access_token: "at-new", expires_in: 3600, refresh_token: "rt-rotated" }),
    persistImpl: () => "failed",
    log: (m) => logged.push(m),
  });
  assert.equal(r.token, "at-new");
  assert.match(logged[0], /store: failed, refresh token rotated/);
});

test("accessToken: no login at all → OauthError", async () => {
  await assert.rejects(
    oauth.accessToken({ read: () => null, now, fetchImpl: async () => { throw new Error("posted"); } }),
    (e) => e.code === "no_login");
});

test("accessToken: an expired env token says so (no refresh material)", async () => {
  await assert.rejects(
    oauth.accessToken({
      read: () => ({ token: "t", expiresAt: now() - 1, refreshToken: null, source: "env", store: null }),
      now, fetchImpl: async () => { throw new Error("posted"); },
    }),
    (e) => e.code === "no_refresh_token" && /CLAUDE_CODE_OAUTH_TOKEN/.test(e.message));
});

// ── credential snapshots ────────────────────────────────────────────────────

const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-creds-"));
const blob = (token) => JSON.stringify({
  claudeAiOauth: { accessToken: token, expiresAt: 42, refreshToken: "rt", refreshTokenExpiresAt: 99 },
});

test("snapshot: writes 0600 and prunes to the newest few", () => {
  const dir = tmpdir();
  for (const n of ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]) {
    assert.ok(oauth.snapshot(blob(n), { dir, keep: 2, stamp: n }));
  }
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 2);
  assert.match(left[1], /2026-01-03/);
  assert.equal(fs.statSync(path.join(dir, left[0])).mode & 0o777, 0o600);
});

test("snapshot: nothing to snapshot, nothing written", () => {
  const dir = tmpdir();
  assert.equal(oauth.snapshot(null, { dir }), null);
  assert.equal(oauth.snapshot("", { dir }), null);
  assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).length, 0);
});

test("listBackups: reports what each snapshot holds, oldest first", () => {
  const dir = tmpdir();
  oauth.snapshot(blob("a"), { dir, stamp: "2026-01-01T00:00:00.000Z" });
  oauth.snapshot(JSON.stringify({ claudeAiOauth: { accessToken: "b" } }), { dir, stamp: "2026-01-02T00:00:00.000Z" });
  fs.writeFileSync(path.join(dir, "claude-broken.json"), "not json");
  const list = oauth.listBackups({ dir });
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((b) => [path.basename(b.file).slice(7, 17), b.hasRefreshToken, b.expiresAt]),
    [["2026-01-01", true, 42], ["2026-01-02", false, null], ["broken.jso", false, null]]);
  assert.equal(oauth.listBackups({ dir: path.join(dir, "missing") }).length, 0);
});

test("persist: snapshots the old contents before overwriting them", () => {
  const dir = tmpdir();
  const before = blob("at-old");
  let written = null;
  const r = oauth.persist(
    { ...cred(), token: "at-new", expiresAt: 1, refreshToken: "rt-new" },
    {
      keychain: () => before,
      keychainWrite: (_a, raw) => { written = raw; return true; },
      backupDir: dir,
    });
  assert.equal(r, "written");
  assert.equal(JSON.parse(written).claudeAiOauth.accessToken, "at-new");
  const snaps = oauth.listBackups({ dir });
  assert.equal(snaps.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(snaps[0].file, "utf8")).claudeAiOauth.accessToken, "at-old");
});

test("restore: rejects a file that is not a credential blob", () => {
  const dir = tmpdir();
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "not json");
  assert.throws(() => oauth.restore(bad, { read: () => cred() }), (e) => e.code === "bad_snapshot");
  fs.writeFileSync(bad, JSON.stringify({ claudeAiOauth: { expiresAt: 1 } }));
  assert.throws(() => oauth.restore(bad, { read: () => cred() }),
    (e) => e.code === "bad_snapshot" && /accessToken/.test(e.message));
});

test("restore: writes the snapshot back and snapshots what it replaced", () => {
  const dir = tmpdir();
  const file = path.join(dir, "good.json");
  fs.writeFileSync(file, blob("at-restored"));
  let written = null;
  const r = oauth.restore(file, {
    read: () => cred(),
    deps: {
      keychain: () => blob("at-live"),
      keychainWrite: (_a, raw) => { written = raw; return true; },
      backupDir: dir,
    },
  });
  assert.equal(JSON.parse(written).claudeAiOauth.accessToken, "at-restored");
  assert.equal(r.store.kind, "keychain");
  assert.equal(JSON.parse(fs.readFileSync(r.previous, "utf8")).claudeAiOauth.accessToken, "at-live");
});

test("restore: a store that refuses the write is an error, not a silent pass", () => {
  const dir = tmpdir();
  const file = path.join(dir, "good.json");
  fs.writeFileSync(file, blob("at-restored"));
  assert.throws(() => oauth.restore(file, {
    read: () => cred(),
    deps: { keychain: () => blob("at-live"), keychainWrite: () => false, backupDir: dir },
  }), (e) => e.code === "write_failed");
});
