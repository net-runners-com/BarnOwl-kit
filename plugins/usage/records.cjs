"use strict";
// records.cjs — the usage log: one JSON line per request in
// <stateDir>/usage/YYYY-MM-DD.jsonl (local date). Metadata only. FIELDS is a
// whitelist: whatever else a record object carries never reaches the disk.

const fs = require("fs");
const path = require("path");

const FIELDS = [
  "ts", "route", "path", "user", "deviceId", "accountUuid", "sessionId",
  "model", "stream", "status", "outcome", "durationMs",
  "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens",
  "tools", "toolCalls",
];
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function dayOf(date) {
  const p = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function shape(record) {
  const out = {};
  for (const f of FIELDS) out[f] = record[f] === undefined ? null : record[f];
  if (out.toolCalls === null && Array.isArray(out.tools)) out.toolCalls = out.tools.length;
  return out;
}

function append(dir, record) {
  const line = shape(record);
  let when = new Date(line.ts);
  if (Number.isNaN(when.getTime())) {
    when = new Date();
    line.ts = when.toISOString();
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, dayOf(when) + ".jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
}

function readRange(dir, from, to) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    const m = DAY_FILE.exec(name);
    if (!m || m[1] < from || m[1] > to) continue;
    for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === "object") out.push(rec);
      } catch { /* a line cut short by a crash: skip it */ }
    }
  }
  return out;
}

module.exports = { FIELDS, dayOf, append, readRange };
