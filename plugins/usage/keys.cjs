"use strict";
// keys.cjs — admin-issued keys for the usage plugin.
//
// <stateDir>/usage/keys.json: { "keys": [{ user, hash, createdAt, revokedAt }] }
// A key is shown once, at creation; only its SHA-256 is stored. The file is
// re-read when its mtime changes, so `barnowl usage key add|revoke` reaches a
// running server without a restart. An unreadable file matches no key.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RESERVED = new Set(["unknown"]); // the label requireKey:false gives keyless requests
let cache = { file: null, mtimeMs: -1, keys: [] };

const fileOf = (dir) => path.join(dir, "keys.json");
const hashOf = (key) => crypto.createHash("sha256").update(key, "utf8").digest("hex");

function load(dir) {
  const file = fileOf(dir);
  let st;
  try { st = fs.statSync(file); }
  catch { cache = { file, mtimeMs: -1, keys: [] }; return cache.keys; }
  if (cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.keys;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = null; }
  const keys = data && Array.isArray(data.keys)
    ? data.keys.filter((k) => k && typeof k === "object" && typeof k.user === "string" && typeof k.hash === "string")
    : [];
  cache = { file, mtimeMs: st.mtimeMs, keys };
  return keys;
}

function save(dir, keys) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ keys }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = { file, mtimeMs: fs.statSync(file).mtimeMs, keys };
}

function checkUser(user) {
  if (typeof user !== "string" || !user.trim() || user !== user.trim() || user.length > 64
    || /[\u0000-\u001f\u007f]/.test(user) || RESERVED.has(user)) {
    throw new Error('user must be 1-64 characters, no control characters or surrounding spaces, and not "unknown"');
  }
}

function add(dir, user, now = new Date()) {
  checkUser(user);
  const key = "bo_" + crypto.randomBytes(32).toString("base64url");
  const keys = load(dir).slice();
  keys.push({ user, hash: hashOf(key), createdAt: now.toISOString(), revokedAt: null });
  save(dir, keys);
  return key;
}

function verify(dir, key) {
  if (typeof key !== "string" || !key) return null;
  const want = Buffer.from(hashOf(key), "hex");
  let user = null;
  for (const k of load(dir)) {
    if (k.revokedAt) continue;
    const have = Buffer.from(k.hash, "hex");
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) user = k.user;
  }
  return user;
}

function revoke(dir, user, now = new Date()) {
  let n = 0;
  const keys = load(dir).map((k) => {
    if (k.user !== user || k.revokedAt) return k;
    n++;
    return { ...k, revokedAt: now.toISOString() };
  });
  if (n) save(dir, keys);
  return n;
}

function list(dir) {
  return load(dir).map((k) => ({ user: k.user, createdAt: k.createdAt || null, revokedAt: k.revokedAt || null }));
}

module.exports = { add, verify, revoke, list };
