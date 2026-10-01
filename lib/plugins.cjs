"use strict";
// plugins.cjs — opt-in plugin loader.
//
// Config: the config file's "plugins" block, handed to the server process as
// JSON in BARNOWL_PLUGINS by `barnowl start`:
//
//   { "plugins": { "usage": { "requireKey": true }, "~/my/plugin.cjs": {} } }
//
// A bare name is a bundled plugin (plugins/<name>/index.cjs); anything with a
// path separator is a file. `false` skips an entry. With no block configured
// this module does nothing and barnowl behaves exactly as before.
//
// A plugin is a CommonJS module:
//   { name, init(options, { stateDir, log }), onRequest(req), onComplete(record), cli(argv, ctx) }
// all optional. onRequest receives { route, path, headers, body } and may
// return { identity, stripHeaders, reject: { status, type, message } }.
//
// Failure policy: a plugin that cannot load is never skipped silently
// (`barnowl start` refuses to start; a request reaching a broken config is
// rejected). A throwing onRequest rejects the request. A throwing onComplete
// is logged and swallowed — the response has already been sent.

const os = require("os");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { stateDir } = require("./model-catalog.cjs");

const als = new AsyncLocalStorage();
let loaded = null;

function log(msg) {
  console.error(`[barnowl] ${msg}`);
}

function parseConfig(env) {
  const raw = env.BARNOWL_PLUGINS;
  if (!raw) return {};
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { throw new Error(`BARNOWL_PLUGINS is not valid JSON: ${e.message}`); }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error('BARNOWL_PLUGINS / "plugins" must be an object: { "<name-or-path>": { ...options } }');
  }
  return cfg;
}

function resolvePlugin(spec) {
  if (spec.includes("/") || spec.includes(path.sep)) {
    const p = spec === "~" || spec.startsWith("~/") || spec.startsWith("~" + path.sep)
      ? path.join(os.homedir(), spec.slice(1))
      : spec;
    return path.resolve(p);
  }
  return path.join(__dirname, "..", "plugins", spec, "index.cjs");
}

/** Load and init every configured plugin. Throws on any failure. */
function load(env = process.env) {
  const out = [];
  for (const [spec, options] of Object.entries(parseConfig(env))) {
    if (options === false) continue;
    const file = resolvePlugin(spec);
    let mod;
    try { mod = require(file); }
    catch (e) { throw new Error(`plugin "${spec}" failed to load (${file}): ${e.message}`); }
    if (!mod || typeof mod !== "object") throw new Error(`plugin "${spec}" failed to load (${file}): it does not export an object`);
    const name = typeof mod.name === "string" && mod.name ? mod.name : spec;
    if (typeof mod.init === "function") {
      const opts = options && typeof options === "object" ? options : {};
      try { mod.init(opts, { stateDir: stateDir(env), log }); }
      catch (e) { throw new Error(`plugin "${name}" init failed: ${e.message}`); }
    }
    out.push({ name, mod });
  }
  return out;
}

function list() {
  if (!loaded) loaded = load();
  return loaded;
}

function enabled() {
  if (!process.env.BARNOWL_PLUGINS) return false;
  // A broken config counts as enabled so begin() rejects instead of the
  // request silently running with no plugins.
  try { return list().length > 0; } catch { return true; }
}

function isStream(reqPath, body) {
  if (reqPath === "/api/stream") return true;
  if (reqPath === "/api/chat" || reqPath === "/api/generate") return !(body && body.stream === false);
  return !!(body && body.stream === true);
}

function outcomeOf(status) {
  if (status >= 200 && status < 300) return "ok";
  return status === 403 ? "blocked" : "upstream_error";
}

/** Start one request: run every onRequest. The returned call collects the
 *  record; the caller must finish() it exactly once (extra calls are no-ops). */
async function begin({ route, path: reqPath, headers, body }) {
  const startedAt = Date.now();
  const record = {
    ts: new Date(startedAt).toISOString(),
    route,
    path: reqPath,
    model: body && typeof body.model === "string" ? body.model : null,
    stream: isStream(reqPath, body),
  };
  const notes = {};
  let finished = false;
  let active = [];
  const call = {
    record,
    stripHeaders: new Set(),
    note(fields) { if (!finished) Object.assign(notes, fields); },
    async finish(fields = {}) {
      if (finished) return;
      finished = true;
      Object.assign(record, notes, fields);
      if (record.durationMs === undefined) record.durationMs = Date.now() - startedAt;
      for (const { name, mod } of active) {
        if (typeof mod.onComplete !== "function") continue;
        try { await mod.onComplete(record); }
        catch (e) { log(`plugin "${name}" onComplete failed: ${e.message}`); }
      }
    },
  };

  try { active = list(); }
  catch (e) {
    return { ok: false, call, reject: { status: 500, type: "plugin_error", message: `barnowl plugin error: ${e.message}` } };
  }
  for (const { name, mod } of active) {
    if (typeof mod.onRequest !== "function") continue;
    let r;
    try { r = await mod.onRequest({ route, path: reqPath, headers: headers || {}, body }); }
    catch (e) {
      return { ok: false, call, reject: { status: 500, type: "plugin_error", message: `barnowl plugin "${name}" failed: ${e.message}` } };
    }
    if (!r) continue;
    if (r.identity && typeof r.identity === "object") Object.assign(record, r.identity);
    if (Array.isArray(r.stripHeaders)) for (const h of r.stripHeaders) call.stripHeaders.add(String(h).toLowerCase());
    if (r.reject) return { ok: false, call, reject: r.reject };
  }
  return { ok: true, call };
}

/** Engine routes (the patched otterly server/index.js). On reject the record
 *  is finished here and the error comes back in the route's own shape. */
async function beginEngine(reqPath, headers, body) {
  const b = await begin({ route: "api", path: reqPath, headers, body });
  if (b.ok) return { ok: true, call: b.call };
  const { status, type, message } = b.reject;
  await b.call.finish({ status, outcome: "rejected" });
  const openai = reqPath === "/v1/chat/completions" || reqPath === "/v1/images/generations";
  return { ok: false, status, error: openai ? { error: { message, type, code: status } } : { error: message } };
}

/** Bind `call` to the caller's async context and finish it when the response
 *  closes. Must be called synchronously from the request handler itself: an
 *  enterWith() inside an awaited helper would not reach the handler's later
 *  awaits. */
function attach(res, call) {
  als.enterWith(call);
  res.on("close", () => {
    const status = res.statusCode || 200;
    call.finish({ status, outcome: outcomeOf(status) });
  });
}

// otterly's Metrics.record(run) is patched to call this; every engine route
// reports its token counts there. The store is per request, so concurrent
// requests do not mix.
globalThis.__barnowlOnMetrics = (run) => {
  const call = als.getStore();
  if (!call || !run || typeof run !== "object") return;
  call.note({
    inputTokens: typeof run.inputTokens === "number" ? run.inputTokens : null,
    outputTokens: typeof run.outputTokens === "number" ? run.outputTokens : null,
    toolCalls: typeof run.toolCalls === "number" ? run.toolCalls : null,
  });
};

function _reset() {
  loaded = null;
}

module.exports = { load, enabled, begin, beginEngine, attach, outcomeOf, resolvePlugin, _reset };
