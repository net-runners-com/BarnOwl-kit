"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { GAP_MS, activeMs, summarize, formatTable } = require("../plugins/usage/report.cjs");

const T0 = Date.parse("2026-10-01T03:00:00.000Z");
const at = (min, extra = {}) => ({
  ts: new Date(T0 + min * 60_000).toISOString(), route: "native", user: "sato",
  sessionId: "s1", deviceId: "d1", outcome: "ok", durationMs: 60_000,
  inputTokens: 10, outputTokens: 20, cacheCreationTokens: 1, cacheReadTokens: 2, ...extra,
});

test("activeMs merges intervals up to the gap and splits beyond it", () => {
  assert.equal(GAP_MS, 5 * 60_000);
  assert.equal(activeMs([]), 0);
  assert.equal(activeMs([at(0)]), 60_000, "one request = its own duration");
  // 0-1, 3-4 (gap 2 min → merged: 0-4), then 20-21 (gap 16 min → new span)
  assert.equal(activeMs([at(20), at(0), at(3)]), 4 * 60_000 + 60_000);
  // exactly on the gap: end 1, next start 6 → still merged (0-7)
  assert.equal(activeMs([at(0), at(6)]), 7 * 60_000);
  // overlapping requests are not double counted
  assert.equal(activeMs([at(0, { durationMs: 10 * 60_000 }), at(2)]), 10 * 60_000);
  assert.equal(activeMs([at(0, { ts: "garbage" }), at(1, { durationMs: null })]), 0);
});

test("summarize groups by user then route and counts outcomes", () => {
  const rows = summarize([
    at(0), at(2, { outcome: "blocked" }), at(30, { sessionId: "s2", deviceId: "d2" }),
    at(40, { outcome: "upstream_error", inputTokens: null, outputTokens: null }),
    at(0, { route: "api", sessionId: null, deviceId: null, cacheCreationTokens: null, cacheReadTokens: null }),
    at(0, { user: "aoki", outcome: "ok" }),
    at(1, { user: null, outcome: "rejected", sessionId: null, deviceId: "d9" }),
  ]);
  assert.deepEqual(rows.map((r) => [r.user, r.route]), [["(no key)", "native"], ["aoki", "native"], ["sato", "api"], ["sato", "native"]]);
  const sato = rows[3];
  assert.equal(sato.requests, 4);
  assert.equal(sato.blocked, 1);
  assert.equal(sato.errors, 1);
  assert.equal(sato.rejected, 0);
  assert.equal(sato.inputTokens, 30);
  assert.equal(sato.outputTokens, 60);
  assert.equal(sato.cacheCreationTokens, 4);
  assert.equal(sato.cacheReadTokens, 8);
  assert.equal(sato.devices, 2);
  assert.equal(sato.sessions, 2);
  // s1: 0-1 and 2-3 merged (3 min) + 40-41 (1 min). s2: 30-31 (1 min).
  assert.equal(sato.activeMinutes, 5);
  const api = rows[2];
  assert.deepEqual([api.requests, api.sessions, api.devices, api.activeMinutes, api.cacheReadTokens], [1, 0, 0, 1, 0]);
  assert.deepEqual([rows[0].requests, rows[0].rejected, rows[0].devices], [1, 1, 1]);
});

test("summarize: api records without a session group per local day", () => {
  const day1 = new Date(2026, 9, 1, 23, 58).toISOString();
  const day2 = new Date(2026, 9, 2, 0, 1).toISOString();
  const rows = summarize([
    { ts: day1, route: "api", user: "sato", outcome: "ok", durationMs: 60_000 },
    { ts: day2, route: "api", user: "sato", outcome: "ok", durationMs: 60_000 },
  ]);
  assert.equal(rows[0].activeMinutes, 2, "3 minutes apart but on different days → two spans");
});

test("formatTable: header, aligned rows, thousands separators, empty set", () => {
  const out = formatTable(summarize([at(0, { inputTokens: 1234567 }), at(0, { route: "api", sessionId: null })]));
  const lines = out.split("\n");
  assert.match(lines[0], /^user\s+route\s+reqs\s+blocked\s+rejected\s+errors\s+input\s+output\s+cache-w\s+cache-r\s+devices\s+sessions\s+active$/);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^sato\s+native\s+1\s+0\s+0\s+0\s+1,234,567\s+20\s+1\s+2\s+1\s+1\s+1m$/);
  assert.ok(lines.every((l) => l.length === lines[0].length || l.trimEnd() === l), "no ragged trailing space");
  assert.equal(formatTable([]), "");
  const long = formatTable(summarize([at(0, { durationMs: 125 * 60_000 })]));
  assert.match(long.split("\n")[1], /2h 5m$/);
});
