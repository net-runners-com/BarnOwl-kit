"use strict";
// usage plugin — who used barnowl, when, with which model, and how many tokens.
//
// Enable:   { "plugins": { "usage": {} } }             (config file)
// Options:  requireKey (default true) — false lets keyless requests through,
//           recorded as user "unknown".
// Client:   ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: <key>"   (Claude Code)
//           or the X-Barnowl-Key header on any OpenAI / Ollama client.
// Admin:    barnowl usage key add <user> | key revoke <user> | key list
//           barnowl usage [--days N | --from D --to D] [--json]
//
// Records are metadata only (records.cjs FIELDS): no prompt, no response, no key.

const path = require("path");
const keys = require("./keys.cjs");
const records = require("./records.cjs");
const report = require("./report.cjs");

const HEADER = "x-barnowl-key";
const REJECT = {
  status: 401,
  type: "authentication_error",
  message: "barnowl: missing or invalid X-Barnowl-Key (ask your administrator)",
};
const KEY_USAGE = "Usage: barnowl usage key add <user> | barnowl usage key revoke <user> | barnowl usage key list";

let state = { dir: null, requireKey: true };

function init(options, ctx) {
  state = { dir: path.join(ctx.stateDir, "usage"), requireKey: !(options && options.requireKey === false) };
}

/** Claude Code puts a JSON string in metadata.user_id:
 *  {"device_id","account_uuid","session_id"}. Anything else is ignored. */
function parseMetadata(body) {
  const none = { deviceId: null, accountUuid: null, sessionId: null };
  const raw = body && body.metadata && body.metadata.user_id;
  if (typeof raw !== "string") return none;
  let m;
  try { m = JSON.parse(raw); } catch { return none; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return none;
  const str = (v) => (typeof v === "string" && v ? v : null);
  return { deviceId: str(m.device_id), accountUuid: str(m.account_uuid), sessionId: str(m.session_id) };
}

function onRequest({ route, headers, body }) {
  const meta = route === "native" ? parseMetadata(body) : { deviceId: null, accountUuid: null, sessionId: null };
  const raw = headers ? headers[HEADER] : undefined;
  const user = typeof raw === "string" ? keys.verify(state.dir, raw.trim()) : null;
  const base = { stripHeaders: [HEADER] };
  if (user) return { identity: { user, ...meta }, ...base };
  if (!state.requireKey) return { identity: { user: "unknown", ...meta }, ...base };
  return { identity: { user: null, ...meta }, ...base, reject: { ...REJECT } };
}

function onComplete(record) {
  records.append(state.dir, record);
}

function parseReportArgs(argv, now) {
  let days = 7;
  let from = null;
  let to = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") days = Number(argv[++i]);
    else if (a === "--from") from = argv[++i];
    else if (a === "--to") to = argv[++i];
    else if (a === "--json") json = true;
    else return { error: `unknown option: ${a}` };
  }
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  if ((from !== null && !DAY.test(String(from))) || (to !== null && !DAY.test(String(to)))) {
    return { error: "--from and --to take a date as YYYY-MM-DD" };
  }
  if (from === null && (!Number.isInteger(days) || days < 1)) return { error: "--days takes a positive whole number" };
  const end = to === null ? now : new Date(`${to}T12:00:00`);
  if (to === null) to = records.dayOf(now);
  if (from === null) {
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    from = records.dayOf(start);
  }
  if (from > to) return { error: `--from ${from} is after --to ${to}` };
  return { from, to, json };
}

function cliKey(argv, dir, ctx) {
  const [sub, user] = argv;
  if (sub === "add" && user) {
    let key;
    try { key = keys.add(dir, user); }
    catch (e) { ctx.err(e.message); return 1; }
    ctx.out([
      `Key for ${user} (shown once — it cannot be recovered, only revoked):`,
      "",
      `  ${key}`,
      "",
      "Claude Code:",
      `  export ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: ${key}"`,
      "Other clients: send the header  X-Barnowl-Key: <key>",
    ].join("\n"));
    return 0;
  }
  if (sub === "revoke" && user) {
    const n = keys.revoke(dir, user);
    if (!n) { ctx.err(`No active key for ${user}.`); return 1; }
    ctx.out(`Revoked ${n} key${n === 1 ? "" : "s"} for ${user}.`);
    return 0;
  }
  if (sub === "list" && argv.length === 1) {
    const all = keys.list(dir);
    if (!all.length) { ctx.out("No keys issued."); return 0; }
    const width = Math.max(4, ...all.map((k) => k.user.length));
    ctx.out(all.map((k) => `${k.user.padEnd(width)}  ${k.revokedAt ? "revoked" : "active "}  created ${k.createdAt || "?"}${k.revokedAt ? `  revoked ${k.revokedAt}` : ""}`).join("\n"));
    return 0;
  }
  ctx.err(KEY_USAGE);
  return 1;
}

/** `barnowl usage ...` — ctx: { stateDir, out, err, now? }. Returns an exit code. */
function cli(argv, ctx) {
  const dir = path.join(ctx.stateDir, "usage");
  if (argv[0] === "key") return cliKey(argv.slice(1), dir, ctx);
  const args = parseReportArgs(argv, ctx.now || new Date());
  if (args.error) {
    ctx.err(`${args.error}\nUsage: barnowl usage [--days N | --from YYYY-MM-DD --to YYYY-MM-DD] [--json]\n${KEY_USAGE}`);
    return 1;
  }
  const rows = report.summarize(records.readRange(dir, args.from, args.to));
  if (args.json) {
    ctx.out(JSON.stringify({ from: args.from, to: args.to, rows }, null, 2));
    return 0;
  }
  if (!rows.length) {
    ctx.out(`No usage recorded between ${args.from} and ${args.to}.`);
    return 0;
  }
  ctx.out(`Usage ${args.from} → ${args.to}\n\n${report.formatTable(rows)}`);
  return 0;
}

module.exports = { name: "usage", init, onRequest, onComplete, cli };
