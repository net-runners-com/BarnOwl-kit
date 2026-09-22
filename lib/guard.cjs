"use strict";
// guard.cjs — outbound PII guard.
//
// Every request body that would leave the machine (the anthropic passthrough
// on /v1/messages, and the OpenAI / Ollama / native engine routes, whose
// claude/codex CLIs talk to their clouds) is run through an external mask
// command first — by default `node ~/.claude/hooks/secret-guard.mjs mask`,
// a stdin → stdout filter that replaces PII with stable tokens (<名前>,
// <電話番号>, …). Image / binary content cannot be masked, so any request
// carrying it is rejected with 403.
//
// Fail-closed by design: if the mask command is missing, exits nonzero,
// times out, or its output cannot be matched back to the input texts, the
// request is BLOCKED, never forwarded unmasked. (The hook-based guard was
// fail-open on timeout once; that class of bug stops here.)
//
// Config comes from env, set by `barnowl start` from the config file's
// "guard" block:
//   BARNOWL_GUARD           "1" enables masking (unset/0 → passthrough, no guard)
//   BARNOWL_GUARD_POLICY    policy dir; its secret-guard.json is exported as
//                           SECRET_GUARD_CONFIG to the mask command
//   BARNOWL_GUARD_MASK_CMD  override mask command (string, run via shell)
//   BARNOWL_GUARD_UPSTREAM  anthropic upstream for /v1/messages
//                           (default https://api.anthropic.com; tests point it
//                           at a local mock)

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createHash } = require("crypto");

// secret-guard's own analyzer/LLM sub-timeouts run to 15s each before it
// degrades gracefully, so the outer limit must sit above them.
const MASK_TIMEOUT_MS = Number(process.env.BARNOWL_GUARD_MASK_TIMEOUT_MS || 30_000);
const MAX_BODY = 20 * 1024 * 1024; // matches otterly's parseBody cap
// Record-separator sentinel: lets one mask spawn cover every text block of a
// request. If the split count comes back wrong (delimiter inside a text, or
// the masker ate it), we fail closed rather than guess.
const DELIM = "\n\u001e__BARNOWL_GUARD_SPLIT__\u001e\n";

function enabled() {
  return process.env.BARNOWL_GUARD === "1";
}

function upstreamBase() {
  return (process.env.BARNOWL_GUARD_UPSTREAM || "https://api.anthropic.com").replace(/\/+$/, "");
}

function defaultMaskCmd() {
  const script = path.join(os.homedir(), ".claude", "hooks", "secret-guard.mjs");
  return `node ${JSON.stringify(script)} mask`;
}

function maskEnv() {
  const env = { ...process.env };
  const policy = process.env.BARNOWL_GUARD_POLICY;
  if (policy) {
    const cfg = path.join(policy, "secret-guard.json");
    if (fs.existsSync(cfg)) env.SECRET_GUARD_CONFIG = cfg;
  }
  return env;
}

/** Run all texts through ONE mask-command spawn. Resolves to the masked
 *  array, or rejects (caller turns any rejection into a 403). */
function maskTexts(texts) {
  if (texts.length === 0) return Promise.resolve([]);
  const joined = texts.join(DELIM);
  if (texts.some((t) => t.includes(DELIM))) {
    return Promise.reject(new Error("guard: delimiter collision in request text"));
  }
  const cmd = process.env.BARNOWL_GUARD_MASK_CMD || defaultMaskCmd();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, env: maskEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`guard: mask command timed out after ${MASK_TIMEOUT_MS}ms`));
    }, MASK_TIMEOUT_MS);
    child.on("error", (e) => finish(reject, new Error(`guard: mask command failed to start: ${e.message}`)));
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("close", (code) => {
      if (code !== 0) {
        return finish(reject, new Error(`guard: mask command exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
      }
      const parts = Buffer.concat(out).toString().split(DELIM);
      if (parts.length !== texts.length) {
        return finish(reject, new Error(`guard: mask output has ${parts.length} parts, expected ${texts.length}`));
      }
      finish(resolve, parts);
    });
    child.stdin.on("error", () => {}); // EPIPE if the child died first; close() reports it
    child.stdin.end(joined);
  });
}

class GuardBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardBlocked";
  }
}

// ── body walkers ────────────────────────────────────────────────────────────
// collect() returns setters for every maskable text and throws GuardBlocked
// on content that cannot be masked (images, documents, audio).

function collectAnthropic(body) {
  const slots = [];
  const block = (why) => { throw new GuardBlocked(why); };
  const addStr = (obj, key) => { if (typeof obj[key] === "string" && obj[key]) slots.push({ obj, key }); };
  const walkBlocks = (blocks) => {
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") addStr(b, "text");
      else if (b.type === "image") block("image content blocked by guard policy");
      else if (b.type === "document") block("document attachment blocked by guard policy");
      else if (b.type === "tool_result") {
        if (typeof b.content === "string") addStr(b, "content");
        else if (Array.isArray(b.content)) walkBlocks(b.content);
      } else if (b.type === "tool_use" && b.input !== undefined) walkJson(b, "input", slots);
    }
  };
  if (typeof body.system === "string") addStr(body, "system");
  else if (Array.isArray(body.system)) walkBlocks(body.system);
  for (const m of body.messages || []) {
    if (typeof m.content === "string") addStr(m, "content");
    else if (Array.isArray(m.content)) walkBlocks(m.content);
  }
  return slots;
}

// tool_use.input is arbitrary JSON the model produced (often echoes user
// text); mask its string leaves via a serialize → mask → parse round trip.
function walkJson(parent, key, slots) {
  const strings = [];
  const visit = (node) => {
    if (typeof node === "string") { strings.push(node); return; }
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  };
  visit(parent[key]);
  if (strings.length === 0) return;
  slots.push({
    obj: parent, key, json: true,
    get() { return JSON.stringify(parent[key]); },
  });
}

function collectOpenai(body) {
  const slots = [];
  for (const m of body.messages || []) {
    if (typeof m.content === "string" && m.content) slots.push({ obj: m, key: "content" });
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text" && typeof p.text === "string" && p.text) slots.push({ obj: p, key: "text" });
        else if (p.type === "image_url" || p.type === "input_image") throw new GuardBlocked("image content blocked by guard policy");
        else if (p.type === "input_audio") throw new GuardBlocked("audio content blocked by guard policy");
      }
    }
  }
  return slots;
}

function collectOllama(body) {
  const slots = [];
  const addStr = (obj, key) => { if (typeof obj[key] === "string" && obj[key]) slots.push({ obj, key }); };
  addStr(body, "prompt");
  addStr(body, "system");
  for (const m of body.messages || []) {
    if (Array.isArray(m.images) && m.images.length) throw new GuardBlocked("image content blocked by guard policy");
    addStr(m, "content");
  }
  if (Array.isArray(body.images) && body.images.length) throw new GuardBlocked("image content blocked by guard policy");
  return slots;
}

// ── LLM checker (optional second stage) ─────────────────────────────────────
// After regex masking, an arbitrary OpenAI-compatible LLM can judge whether
// unmasked PII / secrets remain. Verdict only: leak → 403; the LLM never
// rewrites text. Runs AFTER masking on purpose — the checker only sees the
// already-tokenized payload, and its job is just the regex leftovers.
// Fail-closed like the masker: unreachable / timeout / unparseable → block.

// Mask tokens (<名前>, <電話番号>, …) are stripped from the text BEFORE it
// reaches the checker: small models reliably misread the tokens themselves as
// PII, and with them removed a 3b model scored 6/6 on our verdict cases. The
// checker therefore only ever judges the residue the regex stage missed.
const MASK_TOKEN_RE = /<[^<>\n]{1,24}>/g;

const LLM_DEFAULT_PROMPT =
  "You are a data-leak gate. Answer JSON only. " +
  "{\"leak\": true} ONLY if you literally see a concrete personal value: a person's name, " +
  "a phone number with digits, an email address, a street address, a credit card number, " +
  "an API key or password. Otherwise {\"leak\": false}.";

// Few-shot pairs keep small models calibrated (code/config are not leaks).
const LLM_FEWSHOT = [
  { role: "user", content: "担当: 鈴木一郎 (070-1111-2222)" },
  { role: "assistant", content: '{"leak": true}' },
  { role: "user", content: "明日の会議は15時からです。" },
  { role: "assistant", content: '{"leak": false}' },
  { role: "user", content: 'const url = "https://api.example.com"; // TODO fix retry' },
  { role: "assistant", content: '{"leak": false}' },
];

function llmConfig() {
  const url = process.env.BARNOWL_GUARD_LLM_URL;
  if (!url) return null;
  return {
    url,
    model: process.env.BARNOWL_GUARD_LLM_MODEL || "qwen2.5:3b",
    apiKey: process.env.BARNOWL_GUARD_LLM_KEY || null,
    timeoutMs: Number(process.env.BARNOWL_GUARD_LLM_TIMEOUT_MS || 20_000),
    maxChars: Number(process.env.BARNOWL_GUARD_LLM_MAXCHARS || 4_000),
    prompt: process.env.BARNOWL_GUARD_LLM_PROMPT || LLM_DEFAULT_PROMPT,
  };
}

// Claude Code resends the whole conversation every turn; cache verdicts per
// chunk so only genuinely new text reaches the checker.
const llmVerdictCache = new Map(); // sha256 → boolean (true = leak)
const LLM_CACHE_MAX = 2000;

function cacheGet(key) {
  if (!llmVerdictCache.has(key)) return undefined;
  const v = llmVerdictCache.get(key);
  llmVerdictCache.delete(key); // refresh recency
  llmVerdictCache.set(key, v);
  return v;
}

function cacheSet(key, v) {
  llmVerdictCache.set(key, v);
  if (llmVerdictCache.size > LLM_CACHE_MAX) {
    llmVerdictCache.delete(llmVerdictCache.keys().next().value);
  }
}

async function llmJudgeChunk(cfg, chunk) {
  const key = createHash("sha256").update(cfg.model + "\0" + cfg.prompt + "\0" + chunk).digest("hex");
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let resp, data;
  try {
    resp = await fetch(cfg.url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        stream: false,
        messages: [
          { role: "system", content: cfg.prompt },
          ...LLM_FEWSHOT,
          { role: "user", content: chunk },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`llm checker HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    throw new Error(`guard: llm checker failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("guard: llm checker returned no content");
  const t = /"leak"\s*:\s*true/.test(content);
  const f = /"leak"\s*:\s*false/.test(content);
  if (t === f) throw new Error(`guard: llm checker verdict unparseable: ${content.slice(0, 120)}`);
  cacheSet(key, t);
  return t;
}

async function llmCheckTexts(texts) {
  const cfg = llmConfig();
  if (!cfg) return;
  const chunks = [];
  for (const text of texts) {
    const stripped = text.replace(MASK_TOKEN_RE, "");
    if (!stripped.trim()) continue; // nothing but mask tokens left
    for (let i = 0; i < stripped.length; i += cfg.maxChars) chunks.push(stripped.slice(i, i + cfg.maxChars));
  }
  const verdicts = await Promise.all(chunks.map((c) => llmJudgeChunk(cfg, c)));
  if (verdicts.some(Boolean)) {
    throw new GuardBlocked("llm checker flagged unmasked personal data");
  }
}

async function applyMask(slots) {
  const texts = slots.map((s) => (s.json ? JSON.stringify(s.obj[s.key]) : s.obj[s.key]));
  const masked = await maskTexts(texts);
  await llmCheckTexts(masked);
  slots.forEach((s, i) => {
    if (s.json) {
      try { s.obj[s.key] = JSON.parse(masked[i]); }
      catch { throw new GuardBlocked("guard: masked tool input is no longer valid JSON"); }
    } else {
      s.obj[s.key] = masked[i];
    }
  });
}

/** Guard an engine-route body in place. Returns { ok: true, body } or
 *  { ok: false, status, error } with the error shaped for that route. */
async function guardEngineBody(routePath, body) {
  if (!enabled() || !body || typeof body !== "object") return { ok: true, body };
  const openaiShape = (msg) => ({ error: { message: msg, type: "guard_blocked", code: 403 } });
  const plainShape = (msg) => ({ error: msg });
  const isOpenai = routePath === "/v1/chat/completions";
  const shape = isOpenai ? openaiShape : plainShape;
  try {
    let slots;
    if (isOpenai) slots = collectOpenai(body);
    else if (routePath === "/api/chat" || routePath === "/api/generate") slots = collectOllama(body);
    else if (routePath === "/api/run" || routePath === "/api/stream") slots = collectOllama(body);
    else return { ok: true, body };
    await applyMask(slots);
    return { ok: true, body };
  } catch (e) {
    const msg = e instanceof GuardBlocked ? e.message : `guard failed closed: ${e.message}`;
    return { ok: false, status: 403, error: shape(msg) };
  }
}

// ── /v1/messages passthrough ────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error("request body too large")); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "expect"]);

function anthropicError(status, type, message) {
  return { status, body: { type: "error", error: { type, message } } };
}

/** POST /v1/messages: mask (when the guard is on), then forward verbatim to
 *  the anthropic upstream with the client's own auth headers, streaming the
 *  response back. barnowl holds no API key of its own. */
async function handleMessages(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw;
  try { raw = await readBody(req); }
  catch (e) { return send(413, anthropicError(413, "invalid_request_error", e.message).body); }

  let payload = raw;
  if (enabled()) {
    let body;
    try { body = JSON.parse(raw.toString("utf8")); }
    catch { return send(400, anthropicError(400, "invalid_request_error", "invalid JSON body").body); }
    try {
      await applyMask(collectAnthropic(body));
    } catch (e) {
      const msg = e instanceof GuardBlocked ? e.message : `guard failed closed: ${e.message}`;
      return send(403, anthropicError(403, "guard_blocked", msg).body);
    }
    payload = Buffer.from(JSON.stringify(body), "utf8");
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers["content-length"] = String(payload.length);

  let upstream;
  try {
    upstream = await fetch(upstreamBase() + "/v1/messages", {
      method: "POST",
      headers,
      body: payload,
    });
  } catch (e) {
    return send(502, anthropicError(502, "api_error", `upstream unreachable: ${e.message}`).body);
  }

  const respHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP_HEADERS.has(k) && k !== "content-encoding") respHeaders[k] = v;
  });
  res.writeHead(upstream.status, respHeaders);
  if (upstream.body) {
    try {
      for await (const chunk of upstream.body) res.write(chunk);
    } catch (_) { /* client or upstream dropped mid-stream */ }
  }
  res.end();
}

module.exports = {
  enabled,
  guardEngineBody,
  handleMessages,
  // exported for tests
  maskTexts,
  llmCheckTexts,
  collectAnthropic,
  collectOpenai,
  collectOllama,
  GuardBlocked,
  DELIM,
};
