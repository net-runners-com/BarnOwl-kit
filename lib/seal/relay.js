"use strict";
// Seal / Mode A — "LLM-side decrypt via Bash + Python".
//
// Setup: `barnowl start --allow-tools Bash` (so the spawned claude has Bash).
// Flow:
//   1. caller gives this helper (plaintext payload, task text)
//   2. we encrypt the payload with a fresh ephemeral AES-256-GCM key
//   3. we POST /v1/chat/completions with:
//        system: "decrypt via Bash+Python, then do <task>"
//        user:   the task text
//      key/iv/ciphertext are inlined into the system prompt so Claude can
//      extract them in a shell heredoc.
//   4. the ephemeral key is zeroed on the way out — the buffer only, since
//      the hex string we embedded in the prompt cannot be scrubbed (JS strings
//      are immutable). That's an unavoidable property of this mode.
//
// Honest security envelope:
//   - Anthropic DOES see the key, IV, and ciphertext in the request body —
//     and after Claude runs the Python decrypt, Anthropic also sees the
//     plaintext inside Claude's reasoning context + any tool_result it emits.
//     This mode only hides plaintext from middle layers (TLS proxies that
//     terminate before Anthropic, barnowl's own log files, etc.) — NOT from
//     the vendor. Use lib/plan/* if you want plaintext never leaving the
//     client at all.

const { newKey, encrypt } = require("./crypto.js");

const DEFAULT_BASE_URL = "http://localhost:11435/v1";
const DEFAULT_MODEL    = "sonnet";
const DEFAULT_TIMEOUT  = 180_000;  // decrypt + run can be slower than plain chat

/**
 * Build the system prompt that pins the LLM to a Bash+Python decrypt flow.
 * The heredoc + hex-encoded key/iv avoids shell-escape surprises.
 */
function buildRelaySystemPrompt({ keyHex, ivHex, ctB64 }) {
  return `The user's input references ONE file encrypted with AES-256-GCM.
Before you answer, DECRYPT it using the Bash tool with this exact command:

  python3 - <<'PY'
  import base64, sys
  from cryptography.hazmat.primitives.ciphers.aead import AESGCM
  key = bytes.fromhex("${keyHex}")
  iv  = bytes.fromhex("${ivHex}")
  ct  = base64.b64decode("${ctB64}")
  pt  = AESGCM(key).decrypt(iv, ct, None)
  sys.stdout.write(pt.decode("utf-8"))
  PY

Treat the decrypted plaintext as the user's actual data for the task.
Rules:
- Run the Bash command FIRST, then reason over the plaintext.
- Do NOT echo the key, IV, or ciphertext back to the user.
- Do NOT paste the raw plaintext into your final answer unless the user
  explicitly asks for a verbatim copy.
- If the Bash tool is unavailable, say "sealed-mode requires --allow-tools Bash"
  and stop.`;
}

/**
 * @typedef {Object} SealRelayOpts
 * @property {Buffer|string} payload   plaintext to encrypt before sending
 * @property {string}        task      natural-language instruction for the model
 * @property {string}       [baseUrl]  OpenAI-compat endpoint (default localhost:11435/v1)
 * @property {string}       [model]    model id (default "sonnet")
 * @property {string}       [apiKey]   bearer token
 * @property {number}       [timeoutMs] abort after N ms (default 180s)
 * @property {object}       [extraBody] merged into the request body (e.g. temperature)
 */

/**
 * Encrypt the payload, build a seal-relay chat request, and return the
 * upstream response verbatim. Caller handles choices/content extraction.
 * @param {SealRelayOpts} opts
 */
async function sealRelay(opts) {
  if (!opts || typeof opts !== "object") throw new TypeError("sealRelay: opts required");
  if (!opts.payload) throw new TypeError("sealRelay: payload required");
  if (typeof opts.task !== "string" || !opts.task.trim()) {
    throw new TypeError("sealRelay: task required");
  }

  const baseUrl  = opts.baseUrl  || process.env.BARNOWL_SEAL_BASE_URL || DEFAULT_BASE_URL;
  const model    = opts.model    || process.env.BARNOWL_SEAL_MODEL    || DEFAULT_MODEL;
  const apiKey   = opts.apiKey   || process.env.BARNOWL_API_KEY       || "x";
  const timeout  = opts.timeoutMs || DEFAULT_TIMEOUT;

  const plaintext = Buffer.isBuffer(opts.payload) ? opts.payload : Buffer.from(String(opts.payload), "utf8");
  const key = newKey();
  const { envelope } = encrypt(plaintext, key);
  const keyHex = key.toString("hex");  // cannot be zeroed; see honest-envelope note at top
  const ivHex  = Buffer.from(envelope.iv, "base64").toString("hex");
  const ctB64  = envelope.ct;
  const system = buildRelaySystemPrompt({ keyHex, ivHex, ctB64 });

  const ctrl = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: opts.task },
        ],
        // temperature left to the model's default — newer Claude variants
        // (Sonnet 4.x+) reject `temperature` as deprecated. Caller can still
        // force it via extraBody if their model accepts it.
        ...(opts.extraBody || {}),
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      const e = new Error(`sealRelay: upstream ${res.status} ${res.statusText} ${txt.slice(0, 200)}`);
      e.code = "SEAL_UPSTREAM";
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(timerId);
    // zero the raw key buffer. The hex-encoded copy is a frozen String and
    // can't be scrubbed — JS strings are immutable. Accept that limitation.
    key.fill(0);
  }
}

module.exports = { sealRelay, buildRelaySystemPrompt };
