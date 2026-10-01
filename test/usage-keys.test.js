"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const keys = require("../plugins/usage/keys.cjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-keys-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(ROOT, `d${++n}`, "usage");
const mode = (p) => fs.statSync(p).mode & 0o777;

test("add → verify; only the hash is on disk; modes are private", { skip: process.platform === "win32" && "POSIX modes" }, () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato");
  assert.match(key, /^bo_[A-Za-z0-9_-]{43}$/);
  assert.equal(keys.verify(dir, key), "sato");
  const raw = fs.readFileSync(path.join(dir, "keys.json"), "utf8");
  assert.ok(!raw.includes(key), "raw key must not be stored");
  assert.match(JSON.parse(raw).keys[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, "keys.json")), 0o600);
});

test("unknown, empty and non-string keys do not verify; no file is fine", () => {
  const dir = freshDir();
  assert.equal(keys.verify(dir, "bo_nope"), null);
  assert.equal(keys.verify(dir, ""), null);
  assert.equal(keys.verify(dir, undefined), null);
  assert.equal(keys.verify(dir, ["a", "b"]), null);
  assert.deepEqual(keys.list(dir), []);
});

test("several keys per user; revoke kills all of that user's keys only", () => {
  const dir = freshDir();
  const a1 = keys.add(dir, "sato");
  const a2 = keys.add(dir, "sato");
  const b1 = keys.add(dir, "鈴木");
  assert.notEqual(a1, a2);
  assert.equal(keys.revoke(dir, "sato"), 2);
  assert.equal(keys.verify(dir, a1), null);
  assert.equal(keys.verify(dir, a2), null);
  assert.equal(keys.verify(dir, b1), "鈴木");
  assert.equal(keys.revoke(dir, "sato"), 0, "nothing left to revoke");
  assert.equal(keys.revoke(dir, "nobody"), 0);
});

test("list shows users and dates, never a key or hash", () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato", new Date("2026-10-01T00:00:00Z"));
  keys.revoke(dir, "sato", new Date("2026-10-02T00:00:00Z"));
  const out = keys.list(dir);
  assert.deepEqual(out, [{ user: "sato", createdAt: "2026-10-01T00:00:00.000Z", revokedAt: "2026-10-02T00:00:00.000Z" }]);
  assert.ok(!JSON.stringify(out).includes(key));
});

test("invalid user names are refused", () => {
  const dir = freshDir();
  for (const bad of ["", "   ", "a\nb", "x".repeat(65), "unknown", undefined]) {
    assert.throws(() => keys.add(dir, bad), /user/, JSON.stringify(bad));
  }
  assert.equal(fs.existsSync(dir), false, "nothing written for a refused name");
});

test("a key file changed by another process is picked up", () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato");
  const file = path.join(dir, "keys.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.keys[0].revokedAt = "2026-10-01T00:00:00.000Z";
  fs.writeFileSync(file, JSON.stringify(data));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // make the mtime change unmistakable
  assert.equal(keys.verify(dir, key), null);
});

test("a corrupted key file rejects everything, and the next add recovers", () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato");
  const file = path.join(dir, "keys.json");
  fs.writeFileSync(file, '{"keys": [{"user": "sa');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(keys.verify(dir, key), null);
  assert.deepEqual(keys.list(dir), []);
  const fresh = keys.add(dir, "tanaka");
  assert.equal(keys.verify(dir, fresh), "tanaka");
});

test("entries with a malformed hash are ignored, not thrown on", () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato");
  const file = path.join(dir, "keys.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.keys.unshift({ user: "broken", hash: "zz", createdAt: "x", revokedAt: null }, { user: "nohash" }, null);
  fs.writeFileSync(file, JSON.stringify(data));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(keys.verify(dir, key), "sato");
});
