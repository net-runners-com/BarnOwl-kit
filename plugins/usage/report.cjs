"use strict";
// report.cjs — per-user aggregation of usage records.

const { dayOf } = require("./records.cjs");

const GAP_MS = 5 * 60 * 1000;
const NO_KEY = "(no key)";

/** Active time of one session: each record is [ts, ts + durationMs]; intervals
 *  at most GAP_MS apart merge into a span; the result is the spans' total. */
function activeMs(records) {
  const spans = [];
  for (const r of records) {
    const start = Date.parse(r.ts);
    if (Number.isNaN(start)) continue;
    spans.push([start, start + (typeof r.durationMs === "number" && r.durationMs > 0 ? r.durationMs : 0)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [start, end] of spans) {
    if (cur && start - cur[1] <= GAP_MS) cur[1] = Math.max(cur[1], end);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [start, end];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

function summarize(records) {
  const groups = new Map();
  for (const r of records) {
    const user = typeof r.user === "string" && r.user ? r.user : NO_KEY;
    const route = typeof r.route === "string" && r.route ? r.route : "?";
    const id = user + "\u0000" + route;
    let g = groups.get(id);
    if (!g) {
      g = {
        user, route, requests: 0, blocked: 0, rejected: 0, errors: 0,
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
        deviceIds: new Set(), sessionIds: new Set(), buckets: new Map(),
      };
      groups.set(id, g);
    }
    g.requests++;
    if (r.outcome === "blocked") g.blocked++;
    else if (r.outcome === "rejected") g.rejected++;
    else if (r.outcome !== "ok") g.errors++;
    for (const f of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"]) {
      if (typeof r[f] === "number") g[f] += r[f];
    }
    if (r.deviceId) g.deviceIds.add(r.deviceId);
    if (r.sessionId) g.sessionIds.add(r.sessionId);
    // No session id (api route): one bucket per local day.
    const when = new Date(r.ts);
    const bucket = r.sessionId ? "s:" + r.sessionId : "d:" + (Number.isNaN(when.getTime()) ? "?" : dayOf(when));
    if (!g.buckets.has(bucket)) g.buckets.set(bucket, []);
    g.buckets.get(bucket).push(r);
  }
  return [...groups.values()]
    .map((g) => {
      let ms = 0;
      for (const recs of g.buckets.values()) ms += activeMs(recs);
      return {
        user: g.user, route: g.route, requests: g.requests,
        blocked: g.blocked, rejected: g.rejected, errors: g.errors,
        inputTokens: g.inputTokens, outputTokens: g.outputTokens,
        cacheCreationTokens: g.cacheCreationTokens, cacheReadTokens: g.cacheReadTokens,
        devices: g.deviceIds.size, sessions: g.sessionIds.size,
        activeMinutes: Math.round(ms / 60000),
      };
    })
    .sort((a, b) => (a.user < b.user ? -1 : a.user > b.user ? 1 : a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
}

function minutes(m) {
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function formatTable(rows) {
  if (!rows.length) return "";
  const num = (v) => v.toLocaleString("en-US");
  const cols = [
    ["user", (r) => r.user, false], ["route", (r) => r.route, false],
    ["reqs", (r) => num(r.requests), true], ["blocked", (r) => num(r.blocked), true],
    ["rejected", (r) => num(r.rejected), true], ["errors", (r) => num(r.errors), true],
    ["input", (r) => num(r.inputTokens), true], ["output", (r) => num(r.outputTokens), true],
    ["cache-w", (r) => num(r.cacheCreationTokens), true], ["cache-r", (r) => num(r.cacheReadTokens), true],
    ["devices", (r) => num(r.devices), true], ["sessions", (r) => num(r.sessions), true],
    ["active", (r) => minutes(r.activeMinutes), true],
  ];
  const cells = [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => c[1](r)))];
  const width = cols.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  return cells
    .map((row) => row.map((v, i) => (cols[i][2] ? v.padStart(width[i]) : v.padEnd(width[i]))).join("  ").trimEnd())
    .join("\n");
}

module.exports = { GAP_MS, NO_KEY, activeMs, summarize, formatTable };
