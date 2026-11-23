"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bo-sess-"));
  process.env.BARNOWL_SESSIONS_DIR = dir;
  delete require.cache[require.resolve("../lib/http-sessions.cjs")];
  return { dir, s: require("../lib/http-sessions.cjs") };
}

test("save → load round-trips and stamps updatedAt", () => {
  const { s } = fresh();
  s.save("abc-1", { model: "sonnet", system: "sys", messages: [{ role: "user", content: "hi" }] });
  const r = s.load("abc-1");
  assert.equal(r.model, "sonnet");
  assert.equal(r.system, "sys");
  assert.deepEqual(r.messages, [{ role: "user", content: "hi" }]);
  assert.equal(typeof r.updatedAt, "number");
});

test("unknown id loads null", () => {
  const { s } = fresh();
  assert.equal(s.load("nope"), null);
});

test("path-like ids are refused", () => {
  const { s } = fresh();
  assert.equal(s.load("../x"), null);
  assert.throws(() => s.save("../x", { messages: [] }));
  assert.throws(() => s.save("a/b", { messages: [] }));
});

test("sweep removes records older than maxAge", () => {
  const { s, dir } = fresh();
  s.save("old", { messages: [] });
  s.save("new", { messages: [] });
  const f = path.join(dir, "old.json");
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  rec.updatedAt = Date.now() - 8 * 86400e3;
  fs.writeFileSync(f, JSON.stringify(rec));
  assert.equal(s.sweep(), 1);
  assert.equal(s.load("old"), null);
  assert.ok(s.load("new"));
});
