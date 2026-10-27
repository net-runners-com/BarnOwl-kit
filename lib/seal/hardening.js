"use strict";
// Seal relay hardening — lowers the firing rate of the known failure modes of
// "LLM-side decrypt via Bash", without pretending any of them hit zero.
//
// The structural weak point of Mode A is the moment the decrypted plaintext
// arrives as a tool_result. The model is trained to read tool_result as DATA,
// but that training is probabilistic: a command-shaped sentence inside the
// payload can still be followed. Published numbers for tool_result prompt
// injection on frontier models sit around 5-15%, so the goal here is layered
// probability reduction, not a proof.
//
// Threat model, explicitly:
//   - TRUSTED:   the barnowl operator who calls sealRelay().
//   - UNTRUSTED: the payload bytes. They are usually scraped / third-party /
//                customer data, i.e. exactly where an injection would live.
//   - The upstream vendor sees key, IV, ciphertext AND (after decrypt) the
//     plaintext. Hardening does not change that — see relay.js header.
//
// Five failure modes and what covers each:
//
//   (1) prompt injection inside the decrypted tool_result
//         → spotlight()  : random-nonce fences emitted by OUR python, so the
//                          payload cannot forge the boundary it is wrapped in
//         → hardened system prompt: tool_result-is-data rule, stated after the
//                          decrypt step so it is the most recent instruction
//         → scanPayload(): we hold the plaintext BEFORE encryption, so the
//                          cheapest scan in the whole pipeline happens here
//   (2) decrypted content is harmful while the task text looks benign
//         → hardened prompt re-asserts policy triage AFTER decrypt, where the
//           multi-step "decrypt → parse → act" chain otherwise eats attention
//   (3) harm only emerges at the tail of a long derivation
//         → maxPayloadBytes: a hard cap keeps early safety signal from being
//           diluted by a huge payload, and bounds blast radius
//   (4) domain knowledge gap (biosecurity, novel tradecraft)
//         → NOT solvable client-side. scanPayload() cannot know what it has
//           never seen. Documented as residual risk.
//   (5) re-identification behind pseudonymization
//         → NOT solvable client-side either. We only refuse to let the relay
//           become the quiet path for it: auditResponse() surfaces when the
//           model echoed sealed material back out.
//
// Everything in this file is pure + synchronous so it can run on every call.

const crypto = require("node:crypto");

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;   // 256 KiB
const NONCE_BYTES = 16;                          // 128-bit fence nonce

// ── spotlighting ───────────────────────────────────────────────────────────
// Spotlighting = give untrusted text an unforgeable boundary and tell the
// model the boundary is the trust edge. The nonce is minted per call from a
// CSPRNG and never appears in the payload, so a payload author cannot write
// "<<<END ...>>>" and escape the fence: they would have to guess 128 bits.

/** @returns {string} 32 hex chars, fresh per relay call. */
function newFenceNonce() {
  return crypto.randomBytes(NONCE_BYTES).toString("hex");
}

/**
 * The two fence markers for a nonce.
 * @param {string} nonce
 * @returns {{begin: string, end: string}}
 */
function fenceMarkers(nonce) {
  return {
    begin: `<<<BARNOWL-SEALED-DATA ${nonce}>>>`,
    end: `<<<BARNOWL-END-SEALED-DATA ${nonce}>>>`,
  };
}

/**
 * Wrap text in the fence. Used for the non-Bash paths and by tests; the Bash
 * path has python emit the same markers so the boundary is produced by our
 * code rather than by anything the model types.
 * @param {string} text
 * @param {string} nonce
 */
function spotlight(text, nonce) {
  const { begin, end } = fenceMarkers(nonce);
  return `${begin}\n${text}\n${end}`;
}

// ── payload scanning (pre-encryption) ──────────────────────────────────────
// This runs on plaintext we already hold, before a single byte leaves the
// client. It is the one place where pattern matching beats anything the vendor
// could do for us, because there is no cost and no round trip.
//
// Deliberately narrow: these patterns target *instruction-shaped* text and
// obvious command injection, not "suspicious topics". A broad list would fire
// on normal documents and train the operator to ignore the warning, which is
// worse than no warning. Known miss: anything paraphrased or non-English
// beyond the ja/en forms below.

const INJECTION_PATTERNS = [
  { id: "ignore-previous",   re: /\b(ignore|disregard|forget)\b[^\n]{0,24}\b(previous|above|prior|earlier|all)\b[^\n]{0,24}\b(instruction|prompt|rule|direction)/i },
  { id: "ignore-previous-ja", re: /(以前|上記|前)の?(指示|命令|プロンプト|ルール)[^\n]{0,8}(無視|忘れ)/ },
  { id: "new-instructions",  re: /\b(new|updated|revised)\s+instructions?\s*[:：]/i },
  { id: "role-spoof",        re: /(^|\n)\s*(system|assistant|developer)\s*[:：]/i },
  { id: "role-tag-spoof",    re: /<\/?\s*(system|assistant|user|human)\s*>/i },
  { id: "persona-override",  re: /\byou\s+are\s+now\b|\bfrom\s+now\s+on,?\s+you\b/i },
  { id: "persona-override-ja", re: /(あなた|君|お前)は(今|これ)(から|より)/ },
  { id: "tool-escalation",   re: /\b(run|execute|exec|invoke|call)\b[^\n]{0,24}\b(bash|shell|command|tool|subprocess)\b/i },
  { id: "pipe-to-shell",     re: /\b(curl|wget)\b[^\n]{0,120}\|\s*(ba|z|)sh\b/i },
  { id: "destructive-shell", re: /\brm\s+-[a-z]*[rf][a-z]*\s+\/|\bmkfs\b|\bdd\s+if=[^\n]*of=\/dev\// },
  { id: "decode-and-run",    re: /\bbase64\b[^\n]{0,40}(-d|--decode)[^\n]{0,40}\|\s*(ba|z|)?sh\b/i },
  { id: "exfiltration",      re: /\bexfiltrat|\b(send|post|upload)\b[^\n]{0,32}\b(to|at)\b[^\n]{0,16}https?:\/\//i },
  { id: "secret-request",    re: /\b(print|reveal|echo|output|show)\b[^\n]{0,32}\b(the\s+)?(key|iv|ciphertext|api[\s_-]?key|token|secret)\b/i },
];

/**
 * Scan plaintext for instruction-shaped content before it is encrypted.
 * @param {Buffer|string} payload
 * @returns {Array<{id: string, index: number, excerpt: string}>}
 *   one entry per distinct pattern that fired (first hit only, so one hostile
 *   paragraph cannot flood the report).
 */
function scanPayload(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? "");
  const hits = [];
  for (const { id, re } of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 20);
    hits.push({
      id,
      index: m.index,
      excerpt: text.slice(start, m.index + m[0].length + 20).replace(/\s+/g, " ").trim(),
    });
  }
  return hits;
}

/**
 * Resolve the scan policy. `warn` is the default on purpose: `block` on a
 * pattern list this fuzzy would reject legitimate documents (a security
 * advisory quoting an injection string is a normal thing to summarize).
 * @param {string} [explicit]
 * @returns {"off"|"warn"|"block"}
 */
function scanPolicy(explicit) {
  const v = String(explicit ?? process.env.BARNOWL_SEAL_SCAN ?? "warn").toLowerCase();
  return v === "off" || v === "block" ? v : "warn";
}

/** Resolve the payload size cap in bytes. */
function maxPayloadBytes(explicit) {
  const raw = explicit ?? process.env.BARNOWL_SEAL_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PAYLOAD_BYTES;
}

/**
 * Enforce the size cap. Throws SEAL_PAYLOAD_TOO_LARGE rather than silently
 * truncating — a truncated payload answered confidently is worse than a
 * refusal the operator can see.
 * @param {Buffer} plaintext
 * @param {number} limit
 */
function enforceSizeLimit(plaintext, limit) {
  if (plaintext.length <= limit) return;
  const e = new Error(
    `sealRelay: payload ${plaintext.length} bytes exceeds limit ${limit} ` +
    `(raise with BARNOWL_SEAL_MAX_BYTES or opts.maxPayloadBytes; a large payload ` +
    `dilutes the safety and anti-injection instructions in the prompt)`
  );
  e.code = "SEAL_PAYLOAD_TOO_LARGE";
  throw e;
}

/**
 * Enforce the scan policy, returning warnings for the caller to surface.
 * @param {Buffer} plaintext
 * @param {"off"|"warn"|"block"} policy
 * @returns {Array<{id: string, index: number, excerpt: string}>}
 */
function enforceScan(plaintext, policy) {
  if (policy === "off") return [];
  const hits = scanPayload(plaintext);
  if (hits.length && policy === "block") {
    const e = new Error(
      `sealRelay: payload looks like it contains instructions aimed at the model ` +
      `(${hits.map((h) => h.id).join(", ")}). Refusing under BARNOWL_SEAL_SCAN=block; ` +
      `set BARNOWL_SEAL_SCAN=warn to send it anyway.`
    );
    e.code = "SEAL_PAYLOAD_SUSPECT";
    e.hits = hits;
    throw e;
  }
  return hits;
}

// ── response audit (post-flight) ───────────────────────────────────────────
// We cannot see the model's tool calls through the OpenAI-compat response, so
// this is not intrusion detection. It checks the one thing the final text can
// prove: whether sealed material or the fence boundary leaked into the answer.
// A hit means the model broke an explicit rule, which is also the strongest
// available signal that an injection took the wheel.

/**
 * @param {string} answer   the model's final message content
 * @param {{keyHex: string, ivHex: string, ctB64: string, nonce: string}} secrets
 * @returns {Array<{id: string, severity: "high"|"medium"}>}
 */
function auditResponse(answer, secrets) {
  const text = String(answer ?? "");
  const flags = [];
  if (!text) return flags;
  if (secrets.keyHex && text.includes(secrets.keyHex)) flags.push({ id: "key-echoed", severity: "high" });
  if (secrets.ivHex && text.includes(secrets.ivHex)) flags.push({ id: "iv-echoed", severity: "high" });
  // 48 chars is enough to be unambiguous without matching incidental base64.
  if (secrets.ctB64 && secrets.ctB64.length >= 48 && text.includes(secrets.ctB64.slice(0, 48))) {
    flags.push({ id: "ciphertext-echoed", severity: "high" });
  }
  if (secrets.nonce && text.includes(secrets.nonce)) flags.push({ id: "fence-echoed", severity: "medium" });
  return flags;
}

module.exports = {
  newFenceNonce,
  fenceMarkers,
  spotlight,
  scanPayload,
  scanPolicy,
  maxPayloadBytes,
  enforceSizeLimit,
  enforceScan,
  auditResponse,
  INJECTION_PATTERNS,
  DEFAULT_MAX_PAYLOAD_BYTES,
};
