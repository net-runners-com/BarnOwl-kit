"use strict";
/**
 * http-sessions.cjs — conversation store for the HTTP engine.
 *
 * The CLI engine got continuity from `claude --resume <id>` (Claude Code's own
 * JSONL files). The HTTP engine talks to /v1/messages directly, so barnowl
 * keeps the history itself: one JSON file per session id,
 *   { model, system, messages, updatedAt }
 * under BARNOWL_SESSIONS_DIR (default ~/.barnowl/sessions). Writes go through
 * a tmp file + rename so a crash never leaves a half-written record.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const DEFAULT_MAX_AGE_MS = 7 * 86400e3;

function dir() {
  return process.env.BARNOWL_SESSIONS_DIR || path.join(os.homedir(), ".barnowl", "sessions");
}

function validId(id) {
  return typeof id === "string" && ID_RE.test(id) && id !== "." && id !== "..";
}

function fileFor(id) {
  return path.join(dir(), `${id}.json`);
}

function load(id) {
  if (!validId(id)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
    if (!rec || !Array.isArray(rec.messages)) return null;
    return rec;
  } catch (_) {
    return null;
  }
}

function save(id, rec) {
  if (!validId(id)) throw new Error(`invalid session id: ${String(id).slice(0, 40)}`);
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const out = {
    model: rec.model || null,
    system: rec.system ?? null,
    messages: Array.isArray(rec.messages) ? rec.messages : [],
    updatedAt: Date.now(),
  };
  const f = fileFor(id);
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

function sweep(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  let removed = 0;
  let names;
  try { names = fs.readdirSync(dir()); } catch (_) { return 0; }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const f = path.join(dir(), name);
    try {
      const rec = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!(rec.updatedAt > cutoff)) { fs.unlinkSync(f); removed++; }
    } catch (_) {
      // unreadable record: drop it too
      try { fs.unlinkSync(f); removed++; } catch (_) {}
    }
  }
  return removed;
}

module.exports = { dir, load, save, sweep, validId };
