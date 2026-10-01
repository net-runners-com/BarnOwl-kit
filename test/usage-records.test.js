"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const records = require("../plugins/usage/records.cjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-records-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(ROOT, `d${++n}`, "usage");
const mode = (p) => fs.statSync(p).mode & 0o777;
const localNoon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).toISOString();

test("dayOf uses the local date", () => {
  assert.equal(records.dayOf(new Date(2026, 9, 1, 0, 0, 1)), "2026-10-01");
  assert.equal(records.dayOf(new Date(2026, 0, 9, 23, 59, 59)), "2026-01-09");
});

test("append writes one whitelisted line into the day file, private modes", { skip: process.platform === "win32" && "POSIX modes" }, () => {
  const dir = freshDir();
  records.append(dir, {
    ts: localNoon(2026, 10, 1), route: "native", path: "/v1/messages", user: "sato",
    deviceId: "dev", accountUuid: "acc", sessionId: "ses", model: "m", stream: true,
    status: 200, outcome: "ok", durationMs: 12, inputTokens: 1, outputTokens: 2,
    cacheCreationTokens: 3, cacheReadTokens: 4, tools: ["Read", "Bash"],
    // none of these may reach the disk:
    key: "bo_secret", prompt: "TOP SECRET PROMPT", headers: { authorization: "Bearer x" }, body: { messages: [] },
  });
  const file = path.join(dir, "2026-10-01.jsonl");
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.split("\n").length, 2, "one line plus the trailing newline");
  const rec = JSON.parse(raw);
  assert.deepEqual(Object.keys(rec), records.FIELDS);
  assert.equal(rec.toolCalls, 2, "derived from tools when not given");
  assert.ok(!/bo_secret|TOP SECRET|Bearer/.test(raw));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
});

test("missing fields are written as null; api records keep toolCalls", () => {
  const dir = freshDir();
  records.append(dir, { ts: localNoon(2026, 10, 1), route: "api", path: "/v1/chat/completions", user: "sato", status: 200, outcome: "ok", toolCalls: 3 });
  const [rec] = records.readRange(dir, "2026-10-01", "2026-10-01");
  assert.equal(rec.deviceId, null);
  assert.equal(rec.tools, null);
  assert.equal(rec.cacheReadTokens, null);
  assert.equal(rec.toolCalls, 3);
});

test("a record with an unusable ts falls back to now instead of throwing", () => {
  const dir = freshDir();
  records.append(dir, { ts: "not a date", route: "api", outcome: "ok" });
  const today = records.dayOf(new Date());
  assert.equal(records.readRange(dir, today, today).length, 1);
});

test("readRange is inclusive, ordered, and skips broken lines and stray files", () => {
  const dir = freshDir();
  for (const d of [30, 1, 2, 3]) {
    const m = d === 30 ? 9 : 10;
    records.append(dir, { ts: localNoon(2026, m, d), route: "native", user: `u${d}`, outcome: "ok" });
  }
  fs.appendFileSync(path.join(dir, "2026-10-02.jsonl"), '{"ts":"2026-10-02T03:00:00.000Z","user":"half\n');
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");
  fs.writeFileSync(path.join(dir, "keys.json"), "{}");
  assert.deepEqual(records.readRange(dir, "2026-10-01", "2026-10-02").map((r) => r.user), ["u1", "u2"]);
  assert.deepEqual(records.readRange(dir, "2026-09-01", "2026-12-31").map((r) => r.user), ["u30", "u1", "u2", "u3"]);
  assert.deepEqual(records.readRange(path.join(ROOT, "missing"), "2026-01-01", "2026-12-31"), []);
});

test("many appends stay one valid line each", () => {
  const dir = freshDir();
  for (let i = 0; i < 300; i++) records.append(dir, { ts: localNoon(2026, 10, 1), route: "native", user: "u", status: 200, outcome: "ok", inputTokens: i });
  const recs = records.readRange(dir, "2026-10-01", "2026-10-01");
  assert.equal(recs.length, 300);
  assert.equal(recs.reduce((s, r) => s + r.inputTokens, 0), (299 * 300) / 2);
});
