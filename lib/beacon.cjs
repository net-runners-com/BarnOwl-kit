"use strict";
/**
 * beacon.cjs — open-tracking (read receipts) for files you send.
 *
 * You embed a 1x1 pixel URL (`http://<host>/t/<id>.gif`) in an HTML/email you
 * send. When the recipient opens it, their viewer fetches the pixel and this
 * records the hit: count, first/last time, and per-request IP / User-Agent /
 * Referer. Counts live locally in <state dir>/beacons.json — nothing is sent
 * anywhere by barnowl; the recipient's viewer is what calls in.
 *
 * What it can and can't tell you (be honest with recipients — this is the same
 * mechanism as an email open receipt):
 *  - "who" is only an inference, and only if you mint a UNIQUE id per recipient.
 *  - IP is not identity (NAT/VPN/mobile); mail image-proxies (e.g. Gmail) can
 *    prefetch the pixel on delivery → a Google IP and a false "open"; tracker
 *    blockers suppress it entirely; a forwarded file counts the forwardee.
 *
 * The listing route (/beacons) is loopback-only so recipients can't read your
 * tallies; the pixel route is public by necessity.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { stateDir } = require("./model-catalog.cjs");

// 1x1 transparent GIF.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function storePath(env = process.env) {
  return path.join(stateDir(env), "beacons.json");
}

function load(file = storePath()) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return {}; }
}

function save(data, file = storePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "?";
}

function isLoopback(req) {
  const ip = (req.socket && req.socket.remoteAddress) || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Record one open of `id`. Returns the updated entry. */
function record(id, { ip = "?", ua = "", referer = "", now = new Date().toISOString() } = {}, file = storePath()) {
  const data = load(file);
  const e = data[id] || { reads: 0, first: null, last: null, hits: [] };
  e.reads++; e.first = e.first || now; e.last = now;
  // keep a bounded tail of raw hits for "who/when/what client"
  e.hits.push({ at: now, ip, ua: ua.slice(0, 300), referer: referer.slice(0, 300) });
  if (e.hits.length > 50) e.hits = e.hits.slice(-50);
  data[id] = e; save(data, file);
  return e;
}

/** Mint a per-recipient id: a readable slug plus 6 random chars. */
function mintId(label = "") {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const rnd = crypto.randomBytes(4).toString("base64url").slice(0, 6);
  return slug ? `${slug}-${rnd}` : rnd;
}

/** Self-contained HTML: your content + the inline tracking pixel. Pure. */
function renderHtml({ id, host, title = "", body = "" }) {
  if (!ID_RE.test(id)) throw new Error(`bad beacon id: ${id}`);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body>
${body}
<img src="http://${host}/t/${id}.gif" width="1" height="1" alt="" style="position:absolute;left:-9999px">
</body>
`;
}

/** Serve a beacon route. Returns true if it handled the request. */
function handle(req, res, file = storePath()) {
  const url = new URL(req.url || "/", "http://x");
  const m = url.pathname.match(/^\/t\/([A-Za-z0-9_-]{1,64})\.gif$/);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    try {
      record(m[1], {
        ip: clientIp(req), ua: req.headers["user-agent"] || "", referer: req.headers["referer"] || "",
      }, file);
    } catch (_) { /* a tracking failure must not break the pixel */ }
    res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache" });
    return res.end(req.method === "HEAD" ? undefined : GIF), true;
  }
  if (url.pathname === "/beacons" && req.method === "GET") {
    if (!isLoopback(req)) { res.writeHead(404); return res.end(), true; }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(load(file), null, 2)), true;
  }
  return false;
}

module.exports = { handle, record, load, save, storePath, mintId, renderHtml, clientIp, isLoopback, GIF };
