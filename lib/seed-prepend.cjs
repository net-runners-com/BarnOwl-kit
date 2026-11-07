/**
 * Message-seed prepend — opt-in, per-project warm-up turns.
 *
 * Why: Opus 5.5 is strict enough that a cold first turn on a project whose
 * CLAUDE.md injects a long operating contract can soft-refuse with a short
 * canned reply. Pre-pending a few in-domain Q&A turns to the request's
 * `messages` array stops the refuse pattern from matching without touching
 * prompt content.
 *
 * Shape: this module stays off unless BARNOWL_SEED_DIR points at a directory
 * holding one or more of:
 *   - messages.json         : [{role, content}, ...]  (one shared seed)
 *   - level-1.json ...      : [{role, content}, ...]  (future escalation; the
 *                             current apply() uses level-1 only)
 * `content` may be a string (we wrap it into Anthropic text blocks) or an
 * array of Anthropic content blocks.
 *
 * Call-site: guard.cjs::handleAnthropic, right after the request body is
 * parsed. The seed is prepended to body.messages in place; nothing else about
 * the request changes.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const _cache = { dirKey: undefined, seed: null };

function seedDir() {
  return process.env.BARNOWL_SEED_DIR || "";
}

function enabled() {
  return !!seedDir();
}

function _readJson(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.messages)) return parsed.messages;
  } catch (_) { /* fall through */ }
  return null;
}

/** Load the seed. Cached by the resolved directory path + its mtime, so
 *  edits to the seed files take effect on the next request without a
 *  barnowl restart. */
function loadSeed() {
  const dir = seedDir();
  if (!dir) { _cache.dirKey = undefined; _cache.seed = null; return null; }
  let key = dir;
  const candidates = ["messages.json", "level-1.json"];
  for (const name of candidates) {
    const p = path.join(dir, name);
    try { key += "|" + name + ":" + fs.statSync(p).mtimeMs; } catch (_) { /* missing file */ }
  }
  if (_cache.dirKey === key) return _cache.seed;
  let seed = null;
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) { seed = _readJson(p); if (seed && seed.length) break; }
  }
  _cache.dirKey = key;
  _cache.seed = seed;
  return seed;
}

function _normBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [{ type: "text", text: String(content == null ? "" : content) }];
}

/** Prepend the configured seed turns to `body.messages`. In-place mutation.
 *  No-op when the seed is empty or body.messages is not a list. */
function apply(body) {
  if (!body || !Array.isArray(body.messages)) return false;
  const seed = loadSeed();
  if (!seed || !seed.length) return false;
  const norm = seed.map((m) => ({ role: m.role, content: _normBlocks(m.content) }));
  body.messages = [...norm, ...body.messages];
  return true;
}

module.exports = { enabled, loadSeed, apply, _resetCache: () => { _cache.dirKey = undefined; _cache.seed = null; } };
