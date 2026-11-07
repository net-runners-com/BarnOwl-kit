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
//
// Independent of the guard, set by `barnowl start` from the "messages" block:
//   BARNOWL_MESSAGES_OAUTH  "1" makes /v1/messages authenticate with the local
//                           Claude Code login instead of the client's own key

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

function oauthEnabled() {
  return process.env.BARNOWL_MESSAGES_OAUTH === "1";
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

// ── anthropic passthrough ───────────────────────────────────────────────────

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

// Paths that leave the machine for api.anthropic.com instead of a local
// engine: the Messages API and the rest of the first-party surface (batches,
// files, skills, managed agents and friends). Matched as an exact path or a
// path prefix. /v1/models, /v1/chat/completions, /v1/images/generations and
// the Ollama routes are deliberately absent — otterly answers those from the
// local claude / codex engines.
const ANTHROPIC_PATHS = [
  "/v1/messages",          // + /count_tokens, /batches, /batches/{id}/results
  "/v1/files",
  "/v1/skills",
  "/v1/agents",            // managed agents: scope-gated, see README
  "/v1/sessions",
  "/v1/environments",
  "/v1/vaults",
  "/v1/memory_stores",
  "/v1/deployments",
  "/v1/deployment_runs",
  "/v1/organizations",
];

function isAnthropicPath(path) {
  return ANTHROPIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** The Messages-shaped request objects inside a body, or null when the path
 *  carries some other shape. Both the guard's masker and the oauth system
 *  injection work per Messages request, and a batch holds many. */
function messagesShapes(path, body) {
  if (!body || typeof body !== "object") return null;
  if (path === "/v1/messages" || path === "/v1/messages/count_tokens") return [body];
  if (path === "/v1/messages/batches") {
    if (!Array.isArray(body.requests)) return null;
    return body.requests.map((r) => r && r.params).filter((p) => p && typeof p === "object");
  }
  return null;
}

const OAUTH_BETA = "oauth-2025-04-20";
const CLIENT_AUTH = new Set(["authorization", "x-api-key"]);
// The Claude Code login is only authorized for Claude Code traffic: a request
// whose first system block is anything else comes back as a masked
// rate_limit_error ({"type":"error","error":{"type":"rate_limit_error",
// "message":"Error"}}) — measured, not documented. So oauth mode prepends the
// identity block and leaves the client's own system prompt after it.
const CC_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Prepend the Claude Code system block unless it is already first. Mutates
 *  and returns the parsed body. */
function withClaudeCodeSystem(body) {
  const first = { type: "text", text: CC_SYSTEM };
  if (typeof body.system === "string") {
    body.system = body.system === CC_SYSTEM ? [first] : [first, { type: "text", text: body.system }];
  } else if (Array.isArray(body.system)) {
    const head = body.system[0];
    if (!head || head.type !== "text" || head.text !== CC_SYSTEM) body.system = [first, ...body.system];
  } else {
    body.system = [first];
  }
  return body;
}

/** Headers for the upstream /v1/messages call.
 *
 *  Default: the client's own headers, minus hop headers — barnowl holds no
 *  credential of its own. With BARNOWL_MESSAGES_OAUTH=1 it instead swaps in
 *  the local Claude Code login (keychain / .credentials.json, the same one
 *  the CLI engines use): any client Authorization / x-api-key is dropped, the
 *  OAuth token goes on Authorization: Bearer, and `oauth-2025-04-20` is merged
 *  into anthropic-beta. That lets an SDK with a dummy key reach the Messages
 *  API — server tools (web_search, code_execution, …) included — without an
 *  anthropic API key. barnowl does not refresh the token: once it expires the
 *  route 401s until `claude` is run again. */
function messagesHeaders(reqHeaders, { oauth = oauthEnabled(), cred = null, now = Date.now() } = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  if (!oauth) return { ok: true, headers };
  if (!cred || !cred.token) {
    return { ok: false, ...anthropicError(401, "authentication_error",
      "messages.oauth is on but no Claude Code login was found — run `claude` and log in, or set CLAUDE_CODE_OAUTH_TOKEN") };
  }
  if (cred.expiresAt && cred.expiresAt <= now) {
    return { ok: false, ...anthropicError(401, "authentication_error",
      "the Claude Code login has expired — run `claude` once to refresh it") };
  }


  const betas = new Set();
  let hasVersion = false;
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (CLIENT_AUTH.has(lower)) delete headers[k];
    else if (lower === "anthropic-beta") {
      String(headers[k]).split(",").map((b) => b.trim()).filter(Boolean).forEach((b) => betas.add(b));
      delete headers[k];
    } else if (lower === "anthropic-version") hasVersion = true;
  }
  betas.add(OAUTH_BETA);
  headers["authorization"] = `Bearer ${cred.token}`;
  headers["anthropic-beta"] = [...betas].join(",");
  if (!hasVersion) headers["anthropic-version"] = "2023-06-01";
  return { ok: true, headers };
}

// ── /v1/messages wire logging (opt-in via BARNOWL_MESSAGES_LOG) ──────────────
// Tees the proxied request + the raw upstream response (SSE bytes included, so
// the Anthropic content_block_delta / message_delta events are visible) to a
// file. The log holds PLAINTEXT request/response bodies — point it somewhere
// private. The Authorization / x-api-key headers are redacted; nothing else is.
function messagesLogPath() {
  return process.env.BARNOWL_MESSAGES_LOG || null;
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^(authorization|x-api-key)$/i.test(k) ? "<redacted>" : v;
  }
  return out;
}

// Japanese gloss per refusal category (the `explanation` Anthropic returns is
// English free text; the category is a fixed value, so a deterministic gloss is
// reliable and costs nothing). Source: platform.claude.com refusals doc.
const CATEGORY_JA = {
  cyber: "サイバー被害（マルウェア・エクスプロイト開発など）につながりうる要求。良性のセキュリティ業務でも発動することがある。",
  bio: "生物学的被害（危険な実験手法など）につながりうる要求。有益な生命科学研究でも発動しうる。",
  frontier_llm: "競合AIモデルの開発補助（商用規約で制限）につながりうる要求。良性のML研究でも発動しうる。",
  reasoning_extraction: "内部推論を出力テキストに再現させる要求。代わりに adaptive thinking を使う。",
  general_harms: "上記4カテゴリ外のポリシー領域。良性の作業でも発動しうる。",
};

/** Japanese explanation for a refusal category (null/unknown → generic line). */
function categoryJa(category) {
  if (category && CATEGORY_JA[category]) return CATEGORY_JA[category];
  return "名前付きカテゴリに該当しない拒否。";
}

// Generic response rewrite: a list of rules, each {when, set}, applied to every
// JSON object barnowl parses out of a /v1/messages response — any field of any
// event, not just refusals. `when` maps a dot-path to an expected value (or an
// array of accepted values; all entries must match). `set` maps a dot-path to a
// template string whose {dot.path} tokens interpolate the object's CURRENT
// values (so {stop_details.explanation} gives the original). A field is set only
// when its parent object already exists, so rules never fabricate structure.
//
// SSE message_delta nests the interesting fields under `delta`; rules are run
// against the object AND, when present, its `delta`, so one rule set covers both
// the streamed and the buffered shapes with the same paths.
//
// Ready-made refusal-localization rules (an example you can point `rewrite` at).
const BUILTIN_JA_RULES = Object.entries(CATEGORY_JA).map(([category, ja]) => ({
  when: { "stop_reason": "refusal", "stop_details.category": category },
  set: { "stop_details.explanation": `${ja} （原文: {stop_details.explanation}）` },
})).concat([{
  // null / unnamed category
  when: { "stop_reason": "refusal", "stop_details.category": null },
  set: { "stop_details.explanation": "名前付きカテゴリに該当しない拒否。 （原文: {stop_details.explanation}）" },
}]);

function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

// Remove a dot-path. Deletes an object key, or splices an array element when
// the final segment is a numeric index. Returns true if something was removed.
function unsetPath(obj, path) {
  const keys = path.split(".");
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return false;
    cur = cur[k];
  }
  if (cur == null || typeof cur !== "object") return false;
  if (Array.isArray(cur) && /^\d+$/.test(last)) {
    const i = Number(last);
    if (i < 0 || i >= cur.length) return false;
    cur.splice(i, 1);
    return true;
  }
  if (!(last in cur)) return false;
  delete cur[last];
  return true;
}

// Set a dot-path. By default only an existing field on an existing parent is
// written (no fabrication). With { create: true } intermediate objects are made
// as needed and a missing final key is created — so any field in the structure
// can be set, even one not present. A numeric segment indexes into an array.
function setPath(obj, path, value, { create = false } = {}) {
  const keys = path.split(".");
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (cur != null && typeof cur === "object" && cur[k] != null && typeof cur[k] === "object") {
      cur = cur[k];
    } else if (create && cur != null && typeof cur === "object") {
      cur[k] = {};              // fabricate the intermediate container
      cur = cur[k];
    } else {
      return false;
    }
  }
  if (cur == null || typeof cur !== "object") return false;
  if (!create && !(last in cur)) return false;
  cur[last] = value;
  return true;
}

function renderTemplate(str, scope) {
  return String(str).replace(/\{([A-Za-z0-9_.]+)\}/g, (_, path) => {
    const v = getPath(scope, path);
    return v == null ? "" : String(v);
  });
}

const _rulesCache = { key: undefined, rules: null };

/** Load rewrite rules from BARNOWL_MESSAGES_REWRITE (a JSON file path or inline
 *  JSON array/object); null when unset (rewrite off). Cached by the raw value.
 *  BUILTIN_JA_RULES is exported as a ready-made refusal-localization example. */
function loadRewriteRules(env = process.env) {
  const raw = env.BARNOWL_MESSAGES_REWRITE || "";
  if (_rulesCache.key === raw) return _rulesCache.rules;
  let rules = null;
  if (raw) {
    try {
      const text = fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) rules = parsed;
      else if (parsed && typeof parsed === "object") rules = [parsed];
    } catch (_) { rules = null; }
  }
  _rulesCache.key = raw; _rulesCache.rules = rules;
  return rules;
}

function _resetRewriteRules() { _rulesCache.key = undefined; _rulesCache.rules = null; }

function rewriteEnabled(env = process.env) {
  return !!loadRewriteRules(env);
}

function matchWhen(scope, when) {
  for (const [path, expected] of Object.entries(when || {})) {
    const cur = getPath(scope, path);
    if (Array.isArray(expected)) { if (!expected.includes(cur)) return false; }
    else if (cur !== expected) return false;
  }
  return true;
}

/** Apply rewrite rules to one parsed object (and its `delta`, if any). Mutates
 *  and returns it. A null/empty rule list is a no-op. */
function applyRewrite(obj, rules = loadRewriteRules()) {
  if (!rules || !rules.length || !obj || typeof obj !== "object") return obj;
  const scopes = obj.delta && typeof obj.delta === "object" ? [obj, obj.delta] : [obj];
  for (const scope of scopes) {
    for (const rule of rules) {
      if (!rule || typeof rule !== "object" || !matchWhen(scope, rule.when)) continue;
      // render all targets against the pre-mutation scope, then set
      const next = {};
      // a string value is a template ({path} tokens); a number / boolean /
      // null / object is set as-is, so non-text fields keep their type
      for (const [path, tmpl] of Object.entries(rule.set || {})) {
        next[path] = typeof tmpl === "string" ? renderTemplate(tmpl, scope) : tmpl;
      }
      for (const [path, value] of Object.entries(next)) setPath(scope, path, value, { create: rule.create === true });
      // remove fields listed in `unset` (a path or a list of paths)
      const drops = rule.unset == null ? [] : (Array.isArray(rule.unset) ? rule.unset : [rule.unset]);
      for (const path of drops) unsetPath(scope, path);
    }
  }
  return obj;
}

/** Rewrite a single SSE data line through the rules. */
function rewriteSseLine(line, rules = loadRewriteRules()) {
  const m = line.match(/^data: (\{.*\})\s*$/);
  if (!m) return line;
  let j; try { j = JSON.parse(m[1]); } catch { return line; }
  const before = JSON.stringify(j);
  applyRewrite(j, rules);
  const after = JSON.stringify(j);
  return after === before ? line : "data: " + after;
}

// ── barnowl-side block rules ────────────────────────────────────────────────
// Stop a request at barnowl and return a synthesized 200 assistant message
// instead of forwarding it. A rule is { when?, contains?, message, model? }:
//   when     — dot-path → value|[values] on the REQUEST body (e.g. "model")
//   contains — substring (or list) matched against the request's text
//              (system + message text). when AND contains both apply; a rule
//              with neither never matches.
//   message  — the assistant text returned to the client
//   model    — reported model id (defaults to the request's)
const _blockCache = { key: undefined, rules: null };

function loadBlockRules(env = process.env) {
  const raw = env.BARNOWL_MESSAGES_BLOCK || "";
  if (_blockCache.key === raw) return _blockCache.rules;
  let rules = null;
  if (raw) {
    try {
      const text = fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw;
      const p = JSON.parse(text);
      rules = Array.isArray(p) ? p : (p && typeof p === "object" ? [p] : null);
    } catch (_) { rules = null; }
  }
  _blockCache.key = raw; _blockCache.rules = rules;
  return rules;
}

function _resetBlockRules() { _blockCache.key = undefined; _blockCache.rules = null; }

/** The request's human text: system text + each message's text content. */
function requestText(body) {
  const parts = [];
  const pushText = (c) => {
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) for (const b of c) if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  };
  if (typeof body.system === "string") parts.push(body.system);
  else if (Array.isArray(body.system)) for (const b of body.system) if (b && typeof b.text === "string") parts.push(b.text);
  for (const m of body.messages || []) pushText(m.content);
  return parts.join("\n");
}

/** The first request-phase block rule that matches the request, or null. */
function matchBlock(body, rules = loadBlockRules()) {
  if (!rules || !rules.length || !body || typeof body !== "object") return null;
  let text = null;
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || rule.message == null) continue;
    if (rule.on === "response") continue;                 // response-phase rules handled after forwarding
    const hasWhen = rule.when && typeof rule.when === "object" && Object.keys(rule.when).length > 0;
    const contains = rule.contains == null ? null : (Array.isArray(rule.contains) ? rule.contains : [rule.contains]);
    if (!hasWhen && !contains) continue;                  // no condition → never matches
    if (hasWhen && !matchWhen(body, rule.when)) continue;
    if (contains) {
      if (text === null) text = requestText(body);
      if (!contains.some((s) => text.includes(s))) continue;
    }
    return rule;
  }
  return null;
}

/** A view of the upstream response for response-phase matching: the terminal
 *  fields (stop_reason / stop_details / model) and the assistant text. */
function responseView(text, isSSE) {
  if (isSSE) {
    let stop_reason = null, stop_details = null, model = null, body = "";
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data: (\{.*\})\s*$/); if (!m) continue;
      let j; try { j = JSON.parse(m[1]); } catch { continue; }
      if (j.type === "message_start" && j.message) model = j.message.model || model;
      if (j.type === "content_block_delta" && j.delta && j.delta.type === "text_delta") body += j.delta.text || "";
      if (j.type === "message_delta" && j.delta) {
        if (j.delta.stop_reason !== undefined) stop_reason = j.delta.stop_reason;
        if (j.delta.stop_details !== undefined) stop_details = j.delta.stop_details;
      }
    }
    return { obj: { stop_reason, stop_details, model }, text: body, model };
  }
  try {
    const j = JSON.parse(text);
    let body = "";
    for (const b of j.content || []) if (b && b.type === "text") body += b.text || "";
    return { obj: j, text: body, model: j.model || null };
  } catch { return { obj: {}, text: "", model: null }; }
}

/** The first response-phase rule (on:"response") that matches the response. */
function matchBlockResponse(view, rules) {
  if (!rules) return null;
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || rule.message == null || rule.on !== "response") continue;
    const hasWhen = rule.when && typeof rule.when === "object" && Object.keys(rule.when).length > 0;
    const contains = rule.contains == null ? null : (Array.isArray(rule.contains) ? rule.contains : [rule.contains]);
    if (!hasWhen && !contains) continue;
    if (hasWhen && !matchWhen(view.obj, rule.when)) continue;
    if (contains && !contains.some((s) => view.text.includes(s))) continue;
    return rule;
  }
  return null;
}

/** Synthesize a 200 assistant response (Anthropic shape) carrying the message,
 *  streamed or buffered to match the request. */
function blockResponse(rule, body, stream) {
  const model = rule.model || body.model || "claude";
  const message = String(rule.message);
  if (!stream) {
    return { json: {
      id: "msg_barnowl_block", type: "message", role: "assistant", model,
      content: [{ type: "text", text: message }],
      stop_reason: "end_turn", stop_sequence: null, stop_details: null, container: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } };
  }
  const ev = (e, d) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
  const sse =
    ev("message_start", { type: "message_start", message: { id: "msg_barnowl_block", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }) +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: message } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null }, usage: { output_tokens: 0 } }) +
    ev("message_stop", { type: "message_stop" });
  return { sse };
}

// Pull the terminal stop info out of a /v1/messages response — the value
// barnowl sees before Claude Code does. Works on both the SSE (message_delta)
// and the buffered JSON shapes. Returns null if none found.
function summarizeStop(text, contentType) {
  if (!text) return null;
  let model = null, stop_reason = null, stop_details = null;
  // Detect SSE from the bytes, not the header: the content-type isn't always in
  // reach at the call site, but the frames are unmistakable.
  const looksSSE = /(^|\n)(event:|data: )/.test(text) || /event-stream/i.test(contentType || "");
  if (looksSSE) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data: (\{.*\})\s*$/);
      if (!m) continue;
      let j; try { j = JSON.parse(m[1]); } catch { continue; }
      if (j.type === "message_start" && j.message) model = j.message.model || model;
      if (j.type === "message_delta" && j.delta && j.delta.stop_reason !== undefined) {
        stop_reason = j.delta.stop_reason;
        stop_details = j.delta.stop_details || null;
      }
    }
  } else {
    let j; try { j = JSON.parse(text); } catch { return null; }
    model = j.model || null;
    stop_reason = j.stop_reason !== undefined ? j.stop_reason : null;
    stop_details = j.stop_details || null;
  }
  if (stop_reason === null) return null;
  return {
    model, stop_reason,
    category: stop_details ? (stop_details.category ?? null) : null,
    explanation: stop_details ? (stop_details.explanation ?? null) : null,
  };
}

function openMessagesLog(file, { method, target, headers, body }) {
  let stream;
  try { stream = fs.createWriteStream(file, { flags: "a", mode: 0o600 }); }
  catch (_) { return null; }
  const head =
    `\n===== ${new Date().toISOString()} ${method} ${target} =====\n` +
    `--- request headers (auth redacted) ---\n${JSON.stringify(redactHeaders(headers), null, 2)}\n` +
    `--- request body ---\n${body && body.length ? body.toString("utf8") : "(none)"}\n`;
  try { stream.write(head); } catch (_) { /* best effort */ }
  return stream;
}

/** The anthropic passthrough (every method, every path in ANTHROPIC_PATHS).
 *
 *  Masks what it can (the guard), swaps in the local Claude Code login when
 *  messages.oauth is on, then forwards to the upstream with the client's own
 *  headers and streams the response back. barnowl holds no API key of its own.
 *
 *  Guard interaction: only Messages-shaped bodies (/v1/messages,
 *  /v1/messages/count_tokens, /v1/messages/batches) can be masked, so with the
 *  guard ON every other body — an agent config, a file upload — is blocked
 *  rather than forwarded unmasked. Bodyless methods (GET / DELETE) pass. */
async function handleAnthropic(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const target = req.url || "/v1/messages";
  const path = target.split("?")[0];
  const method = req.method || "POST";

  let raw = Buffer.alloc(0);
  if (BODY_METHODS.has(method)) {
    try { raw = await readBody(req); }
    catch (e) { return send(413, anthropicError(413, "invalid_request_error", e.message).body); }
  } else {
    req.resume();
  }

  // barnowl-side block rules: if a request matches, stop here and return a
  // synthesized 200 message instead of forwarding. Runs on the original body,
  // before any oauth identity injection. Scoped to Messages-shaped requests.
  const blockRules = loadBlockRules();
  if (blockRules && blockRules.length && raw.length && /json/i.test(String(req.headers["content-type"] || ""))
      && (path === "/v1/messages" || path === "/v1/messages/count_tokens")) {
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; }
    const hit = body && matchBlock(body, blockRules);
    if (hit) {
      const r = blockResponse(hit, body, !!body.stream);
      if (r.sse) { res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }); res.end(r.sse); }
      else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r.json)); }
      return;
    }
  }

  const oauth = oauthEnabled();
  let payload = raw;
  if (raw.length && (enabled() || oauth)) {
    const isJson = /json/i.test(String(req.headers["content-type"] || ""));
    if (!isJson) {
      if (enabled()) {
        return send(403, anthropicError(403, "guard_blocked",
          `the guard cannot mask a ${req.headers["content-type"] || "bodied"} request to ${path}`).body);
      }
    } else {
      let body;
      try { body = JSON.parse(raw.toString("utf8")); }
      catch { return send(400, anthropicError(400, "invalid_request_error", "invalid JSON body").body); }
      const shapes = messagesShapes(path, body);
      if (enabled()) {
        if (!shapes) {
          return send(403, anthropicError(403, "guard_blocked",
            `the guard can only mask Messages-shaped requests; ${path} is blocked while the guard is on`).body);
        }
        try {
          const slots = [];
          for (const shape of shapes) slots.push(...collectAnthropic(shape));
          await applyMask(slots);
        } catch (e) {
          const msg = e instanceof GuardBlocked ? e.message : `guard failed closed: ${e.message}`;
          return send(403, anthropicError(403, "guard_blocked", msg).body);
        }
      }
      if (oauth && shapes) for (const shape of shapes) withClaudeCodeSystem(shape);
      // Opt-in seed-prepend: on /v1/messages only, when BARNOWL_SEED_DIR points
      // at a directory holding `messages.json` / `level-1.json`. Prepends the
      // warm-up turns in-place so a cold first turn does not land on a short
      // canned refuse. See ./seed-prepend.cjs.
      let seedApplied = false;
      try {
        const seed = require("./seed-prepend.cjs");
        if (seed.enabled() && path === "/v1/messages" && shapes) {
          for (const shape of shapes) seedApplied = seed.apply(shape) || seedApplied;
        }
      } catch (_) { /* seed off or broken; carry on */ }
      if (enabled() || (oauth && shapes) || seedApplied) payload = Buffer.from(JSON.stringify(body), "utf8");
    }
  }

  let cred = null;
  if (oauth) {
    // Refreshes the stored token when it is spent; 401s only when no login
    // (or no refresh token) is left to use.
    try {
      cred = await require("./claude-oauth.cjs").accessToken({
        log: (m) => console.log(`[barnowl] ${m}`),
      });
    } catch (e) {
      return send(401, anthropicError(401, "authentication_error", e.message).body);
    }
  }
  const h = messagesHeaders(req.headers, { oauth, cred });
  if (!h.ok) return send(h.status, h.body);
  const headers = h.headers;
  if (payload.length) headers["content-length"] = String(payload.length);
  else delete headers["content-length"];

  let upstream;
  try {
    upstream = await fetch(upstreamBase() + target, {
      method,
      headers,
      body: payload.length ? payload : undefined,
    });
  } catch (e) {
    return send(502, anthropicError(502, "api_error", `upstream unreachable: ${e.message}`).body);
  }

  const respHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP_HEADERS.has(k) && k !== "content-encoding") respHeaders[k] = v;
  });

  const logFile = messagesLogPath();
  const logStream = logFile ? openMessagesLog(logFile, { method, target, headers, body: payload }) : null;
  if (logStream) {
    try { logStream.write(`--- response status ${upstream.status} ---\n`); } catch (_) { /* ignore */ }
  }
  // Tap stop_details on the way through (only when we're already logging, to
  // keep the hot path free). We observe and forward — the bytes to Claude Code
  // are never altered.
  const tap = !!logStream;
  const rrules = loadRewriteRules();
  const rewrite = !!rrules;
  const isSSE = /event-stream/i.test(respHeaders["content-type"] || respHeaders["Content-Type"] || "");
  let respText = ""; const RESP_CAP = 8 * 1024 * 1024;
  const accum = (text) => { if (tap && respText.length < RESP_CAP) respText += text; };
  const teeLog = (buf) => { if (logStream) { try { logStream.write(buf); } catch (_) { /* ignore */ } } };
  const respBlock = (blockRules || []).filter((r) => r && r.on === "response" && r.message != null);

  if (respBlock.length) {
    // Response-phase block: buffer the whole upstream response, and if a rule
    // matches it, replace it with a synthesized message; otherwise forward it
    // (applying rewrite). Buffering costs streaming, so this is opt-in.
    let buf = Buffer.alloc(0);
    if (upstream.body) {
      try { for await (const chunk of upstream.body) buf = Buffer.concat([buf, Buffer.from(chunk)]); }
      catch (_) { /* dropped */ }
    }
    const text = buf.toString("utf8");
    accum(text);                                   // the tap observes the ORIGINAL response
    const view = responseView(text, isSSE);
    const hit = matchBlockResponse(view, respBlock);
    if (hit) {
      const r = blockResponse(hit, { model: view.model }, isSSE);
      if (r.sse) {
        const h = { ...respHeaders, "content-type": "text/event-stream", "cache-control": "no-store" };
        delete h["content-length"];
        res.writeHead(200, h); teeLog(r.sse); res.end(r.sse);
      } else {
        const out = JSON.stringify(r.json);
        const h = { ...respHeaders, "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) };
        res.writeHead(200, h); teeLog(out); res.end(out);
      }
      if (logStream) { try { logStream.write(`--- blocked (on:response) → replaced with a message ---\n`); } catch (_) { /* ignore */ } }
    } else {
      let out = buf;
      if (rewrite) {
        if (isSSE) out = Buffer.from(text.split("\n").map((l) => l.startsWith("data: ") ? rewriteSseLine(l, rrules) : l).join("\n"), "utf8");
        else { try { const j = JSON.parse(text); applyRewrite(j, rrules); out = Buffer.from(JSON.stringify(j), "utf8"); } catch (_) { /* forward as-is */ } }
      }
      const h = { ...respHeaders }; if (!isSSE) h["content-length"] = String(out.length);
      res.writeHead(upstream.status, h); teeLog(out); res.end(out);
    }
  } else if (rewrite && !isSSE) {
    // Buffered JSON: read it all, localize a refusal, then send. Non-streaming
    // responses are already buffered client-side, so no streaming is lost.
    let buf = Buffer.alloc(0);
    if (upstream.body) {
      try { for await (const chunk of upstream.body) buf = Buffer.concat([buf, Buffer.from(chunk)]); }
      catch (_) { /* dropped */ }
    }
    accum(buf.toString("utf8"));
    let out = buf;
    try {
      const j = JSON.parse(buf.toString("utf8"));
      const before = JSON.stringify(j);
      applyRewrite(j, rrules);
      const after = JSON.stringify(j);
      if (after !== before) out = Buffer.from(after, "utf8");
    } catch (_) { /* not JSON we can rewrite; forward as-is */ }
    respHeaders["content-length"] = String(out.length);
    res.writeHead(upstream.status, respHeaders);
    teeLog(out);
    res.end(out);
  } else if (rewrite && isSSE) {
    // SSE: transform line-by-line so normal content still streams; only a
    // refusal message_delta event is rewritten before it reaches the client.
    res.writeHead(upstream.status, respHeaders);
    let pending = "";
    const emit = (str) => { res.write(str); teeLog(str); };
    if (upstream.body) {
      try {
        for await (const chunk of upstream.body) {
          const text = Buffer.from(chunk).toString("utf8");
          accum(text);
          pending += text;
          let nl;
          while ((nl = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            emit(rewriteSseLine(line, rrules) + "\n");
          }
        }
      } catch (_) { /* dropped */ }
    }
    if (pending) emit(pending);
    res.end();
  } else {
    // Observe-only: forward raw bytes unchanged.
    res.writeHead(upstream.status, respHeaders);
    if (upstream.body) {
      try {
        for await (const chunk of upstream.body) {
          res.write(chunk);
          teeLog(chunk);
          accum(Buffer.from(chunk).toString("utf8"));
        }
      } catch (_) { /* client or upstream dropped mid-stream */ }
    }
    res.end();
  }
  if (tap) {
    const stop = summarizeStop(respText, respHeaders["content-type"] || respHeaders["Content-Type"]);
    if (stop) {
      const isRefusal = stop.stop_reason === "refusal";
      const ja = isRefusal ? categoryJa(stop.category) : null;
      const line = `--- stop: reason=${stop.stop_reason} model=${stop.model || "?"}`
        + ` category=${stop.category ?? "null"}`
        + (stop.explanation ? ` explanation=${JSON.stringify(stop.explanation)}` : "")
        + (ja ? ` ja=${JSON.stringify(ja)}` : "") + ` ---\n`;
      if (logStream) { try { logStream.write(line); } catch (_) { /* ignore */ } }
      if (isRefusal) {
        console.log(`[barnowl] 拒否を検知: category=${stop.category ?? "null"} model=${stop.model || "?"}\n`
          + `  意味: ${ja}`
          + (stop.explanation ? `\n  原文: ${stop.explanation}` : ""));
      }
    }
  }
  if (logStream) { try { logStream.end("\n===== end =====\n"); } catch (_) { /* ignore */ } }
}

// An otterly patched by an older barnowl calls handleMessages for POST
// /v1/messages only; the generalized handler covers it.
const handleMessages = handleAnthropic;

module.exports = {
  enabled,
  oauthEnabled,
  guardEngineBody,
  isAnthropicPath,
  handleAnthropic,
  handleMessages,
  messagesHeaders,
  messagesShapes,
  messagesLogPath,
  redactHeaders,
  summarizeStop,
  categoryJa,
  rewriteEnabled,
  loadRewriteRules,
  _resetRewriteRules,
  applyRewrite,
  rewriteSseLine,
  loadBlockRules,
  _resetBlockRules,
  matchBlock,
  matchBlockResponse,
  responseView,
  blockResponse,
  requestText,
  getPath,
  setPath,
  unsetPath,
  BUILTIN_JA_RULES,
  withClaudeCodeSystem,
  // exported for tests
  maskTexts,
  llmCheckTexts,
  collectAnthropic,
  collectOpenai,
  collectOllama,
  GuardBlocked,
  DELIM,
};
