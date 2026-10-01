"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const usage = require("../plugins/usage/index.cjs");
const keys = require("../plugins/usage/keys.cjs");
const records = require("../plugins/usage/records.cjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-usage-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
function fresh(options = {}) {
  const stateDir = path.join(ROOT, `s${++n}`);
  usage.init(options, { stateDir, log() {} });
  return { stateDir, dir: path.join(stateDir, "usage") };
}
const META = JSON.stringify({ device_id: "dev1", account_uuid: "acc1", session_id: "ses1" });
const nativeReq = (headers, metadata = { user_id: META }) => ({ route: "native", path: "/v1/messages", headers, body: { model: "m", metadata } });
function io() {
  const o = { out: [], err: [] };
  return { ...o, ctx: (stateDir, now) => ({ stateDir, now, out: (s) => o.out.push(s), err: (s) => o.err.push(s) }) };
}

test("name and hooks are exported", () => {
  assert.equal(usage.name, "usage");
  for (const f of ["init", "onRequest", "onComplete", "cli"]) assert.equal(typeof usage[f], "function");
});

test("valid key → user + device/account/session; the key header is always stripped", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  const r = usage.onRequest(nativeReq({ "x-barnowl-key": key }));
  assert.deepEqual(r, {
    identity: { user: "sato", deviceId: "dev1", accountUuid: "acc1", sessionId: "ses1" },
    stripHeaders: ["x-barnowl-key"],
  });
});

test("a key with stray whitespace around it still works", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  assert.equal(usage.onRequest(nativeReq({ "x-barnowl-key": `  ${key} \t` })).identity.user, "sato");
});

test("missing, wrong, revoked and duplicated keys are rejected with 403", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  const dead = keys.add(dir, "tanaka");
  keys.revoke(dir, "tanaka");
  for (const headers of [{}, { "x-barnowl-key": "bo_wrong" }, { "x-barnowl-key": dead }, { "x-barnowl-key": `${key}, ${key}` }, { "x-barnowl-key": "" }]) {
    const r = usage.onRequest(nativeReq(headers));
    assert.deepEqual(r.reject, {
      status: 403, type: "permission_error",
      message: "barnowl: missing or invalid X-Barnowl-Key (ask your administrator)",
    });
    assert.equal(r.identity.user, null);
    assert.equal(r.identity.deviceId, "dev1", "a rejected request is still attributed to its device");
    assert.deepEqual(r.stripHeaders, ["x-barnowl-key"]);
  }
});

test("requireKey: false lets keyless requests through as unknown", () => {
  fresh({ requireKey: false });
  const r = usage.onRequest(nativeReq({}));
  assert.equal(r.reject, undefined);
  assert.equal(r.identity.user, "unknown");
});

test("metadata that is absent, not JSON, or the wrong shape is ignored", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  const none = { user: "sato", deviceId: null, accountUuid: null, sessionId: null };
  for (const metadata of [null, {}, { user_id: "plain-string-id" }, { user_id: "[1,2]" }, { user_id: 42 }, { user_id: '{"device_id":7}' }]) {
    assert.deepEqual(usage.onRequest(nativeReq({ "x-barnowl-key": key }, metadata)).identity, none, JSON.stringify(metadata));
  }
});

test("api route: key identifies the user; metadata is not read", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  const r = usage.onRequest({ route: "api", path: "/v1/chat/completions", headers: { "x-barnowl-key": key }, body: { model: "sonnet", metadata: { user_id: META } } });
  assert.deepEqual(r.identity, { user: "sato", deviceId: null, accountUuid: null, sessionId: null });
});

test("onComplete appends the record to today's file", () => {
  const { dir } = fresh();
  const ts = new Date().toISOString();
  usage.onComplete({ ts, route: "native", user: "sato", status: 200, outcome: "ok", inputTokens: 3 });
  const today = records.dayOf(new Date());
  const [rec] = records.readRange(dir, today, today);
  assert.equal(rec.user, "sato");
  assert.equal(rec.inputTokens, 3);
});

test("cli key add / list / revoke", () => {
  const { stateDir, dir } = fresh();
  const a = io();
  assert.equal(usage.cli(["key", "add", "sato"], a.ctx(stateDir)), 0);
  const key = /bo_[A-Za-z0-9_-]{43}/.exec(a.out.join("\n"))[0];
  assert.equal(keys.verify(dir, key), "sato");
  assert.match(a.out.join("\n"), /ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: bo_/);

  const l = io();
  assert.equal(usage.cli(["key", "list"], l.ctx(stateDir)), 0);
  assert.match(l.out.join("\n"), /sato\s+active/);
  assert.ok(!l.out.join("\n").includes(key));

  const r = io();
  assert.equal(usage.cli(["key", "revoke", "sato"], r.ctx(stateDir)), 0);
  assert.equal(keys.verify(dir, key), null);
  const again = io();
  assert.equal(usage.cli(["key", "revoke", "sato"], again.ctx(stateDir)), 1);

  const l2 = io();
  usage.cli(["key", "list"], l2.ctx(stateDir));
  assert.match(l2.out.join("\n"), /sato\s+revoked/);
});

test("cli key: bad input prints usage and exits 1; a refused name explains why", () => {
  const { stateDir } = fresh();
  for (const argv of [["key"], ["key", "add"], ["key", "revoke"], ["key", "frobnicate", "x"]]) {
    const o = io();
    assert.equal(usage.cli(argv, o.ctx(stateDir)), 1, argv.join(" "));
    assert.match(o.err.join("\n"), /barnowl usage key add <user>/);
  }
  const o = io();
  assert.equal(usage.cli(["key", "add", "unknown"], o.ctx(stateDir)), 1);
  assert.match(o.err.join("\n"), /user must be/);
});

test("cli report: default 7 days, --days, --from/--to, --json, empty", () => {
  const { stateDir, dir } = fresh();
  const now = new Date(2026, 9, 10, 12, 0, 0);
  const on = (day, extra) => records.append(dir, {
    ts: new Date(2026, 9, day, 9, 0, 0).toISOString(), route: "native", user: "sato",
    sessionId: "s" + day, outcome: "ok", durationMs: 60000, inputTokens: 100, outputTokens: 10, ...extra,
  });
  on(1); on(4); on(9); on(10, { route: "api", sessionId: null });

  const empty = io();
  assert.equal(usage.cli(["--from", "2025-01-01", "--to", "2025-01-02"], empty.ctx(stateDir, now)), 0);
  assert.match(empty.out.join("\n"), /No usage recorded between 2025-01-01 and 2025-01-02/);

  const def = io();
  assert.equal(usage.cli([], def.ctx(stateDir, now)), 0);
  const text = def.out.join("\n");
  assert.match(text, /Usage 2026-10-04 → 2026-10-10/);
  assert.match(text, /sato\s+api\s+1/);
  assert.match(text, /sato\s+native\s+2/);

  const j = io();
  assert.equal(usage.cli(["--days", "1", "--json"], j.ctx(stateDir, now)), 0);
  const parsed = JSON.parse(j.out.join("\n"));
  assert.equal(parsed.from, "2026-10-10");
  assert.equal(parsed.to, "2026-10-10");
  assert.deepEqual(parsed.rows.map((r) => [r.user, r.route, r.requests]), [["sato", "api", 1]]);

  const range = io();
  assert.equal(usage.cli(["--from", "2026-10-01", "--to", "2026-10-04", "--json"], range.ctx(stateDir, now)), 0);
  assert.equal(JSON.parse(range.out.join("\n")).rows[0].requests, 2);
});

test("cli report: bad options exit 1 with a reason", () => {
  const { stateDir } = fresh();
  for (const [argv, re] of [
    [["--days", "0"], /--days/], [["--days", "abc"], /--days/], [["--days"], /--days/],
    [["--from", "10/01"], /YYYY-MM-DD/], [["--from", "2026-10-05", "--to", "2026-10-01"], /after/],
    [["--bogus"], /unknown option/],
  ]) {
    const o = io();
    assert.equal(usage.cli(argv, o.ctx(stateDir)), 1, argv.join(" "));
    assert.match(o.err.join("\n"), re);
  }
});

test("the loader finds this plugin by its bare name", () => {
  const plugins = require("../lib/plugins.cjs");
  const saved = { p: process.env.BARNOWL_PLUGINS, s: process.env.BARNOWL_STATE_DIR };
  process.env.BARNOWL_STATE_DIR = path.join(ROOT, "loader");
  process.env.BARNOWL_PLUGINS = JSON.stringify({ usage: { requireKey: false } });
  plugins._reset();
  try {
    assert.deepEqual(plugins.load().map((p) => p.name), ["usage"]);
  } finally {
    for (const [k, v] of [["BARNOWL_PLUGINS", saved.p], ["BARNOWL_STATE_DIR", saved.s]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    plugins._reset();
  }
});
