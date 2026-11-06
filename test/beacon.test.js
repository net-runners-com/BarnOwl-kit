"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const beacon = require("../lib/beacon.cjs");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-beacon-")), "beacons.json");
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

test("record: counts, timestamps, bounded hit tail", () => {
  const f = tmp();
  beacon.record("memo-1", { ip: "1.2.3.4", ua: "Mail/1", now: "2026-01-01T00:00:00Z" }, f);
  const e = beacon.record("memo-1", { ip: "5.6.7.8", ua: "Mail/2", now: "2026-01-02T00:00:00Z" }, f);
  assert.equal(e.reads, 2);
  assert.equal(e.first, "2026-01-01T00:00:00Z");
  assert.equal(e.last, "2026-01-02T00:00:00Z");
  assert.deepEqual(e.hits.map((h) => h.ip), ["1.2.3.4", "5.6.7.8"]);
  for (let i = 0; i < 60; i++) beacon.record("memo-1", { now: "x" }, f);
  assert.equal(beacon.load(f)["memo-1"].hits.length, 50);
});

test("record: ua / referer are truncated", () => {
  const f = tmp();
  const e = beacon.record("x", { ua: "u".repeat(400), referer: "r".repeat(400) }, f);
  assert.equal(e.hits[0].ua.length, 300);
  assert.equal(e.hits[0].referer.length, 300);
});

test("mintId: slug + random suffix, url-safe, distinct", () => {
  const a = beacon.mintId("Tanaka San!");
  assert.match(a, /^tanaka-san-[A-Za-z0-9_-]{6}$/);
  assert.notEqual(beacon.mintId("x"), beacon.mintId("x"));
  assert.match(beacon.mintId(""), /^[A-Za-z0-9_-]{6}$/);
});

test("renderHtml: inlines the pixel, escapes the title, rejects a bad id", () => {
  const html = beacon.renderHtml({ id: "memo-1", host: "h:8899", title: "a<b>&c", body: "<p>hi" });
  assert.ok(html.includes('src="http://h:8899/t/memo-1.gif"'));
  assert.ok(html.includes("<p>hi"));
  assert.ok(html.includes("a&lt;b&gt;&amp;c"));
  assert.throws(() => beacon.renderHtml({ id: "../etc", host: "h", title: "", body: "" }), /bad beacon id/);
});

test("handle: the pixel records and returns a gif", async () => {
  const f = tmp();
  const srv = http.createServer((req, res) => { if (!beacon.handle(req, res, f)) { res.writeHead(404); res.end(); } });
  const port = await listen(srv);
  const r = await fetch(`http://127.0.0.1:${port}/t/memo-9.gif`, { headers: { "user-agent": "Probe/1", referer: "mail://x" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/gif");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(buf, beacon.GIF);
  const e = beacon.load(f)["memo-9"];
  assert.equal(e.reads, 1);
  assert.equal(e.hits[0].ua, "Probe/1");
  assert.equal(e.hits[0].referer, "mail://x");
  srv.close();
});

test("handle: /beacons serves counts to loopback only", async () => {
  const f = tmp();
  beacon.record("memo-3", { ip: "9.9.9.9" }, f);
  const srv = http.createServer((req, res) => { if (!beacon.handle(req, res, f)) { res.writeHead(404); res.end(); } });
  const port = await listen(srv);
  const r = await fetch(`http://127.0.0.1:${port}/beacons`);
  assert.equal(r.status, 200);
  assert.equal((await r.json())["memo-3"].reads, 1);
  srv.close();
});

test("handle: a non-beacon path is not handled", () => {
  let handled;
  const req = { url: "/v1/models", method: "GET", headers: {}, socket: {} };
  const res = { writeHead() {}, end() {} };
  handled = beacon.handle(req, res, tmp());
  assert.equal(handled, false);
});

test("isLoopback / clientIp", () => {
  assert.equal(beacon.isLoopback({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(beacon.isLoopback({ socket: { remoteAddress: "8.8.8.8" } }), false);
  assert.equal(beacon.clientIp({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, socket: {} }), "1.1.1.1");
  assert.equal(beacon.clientIp({ headers: {}, socket: { remoteAddress: "3.3.3.3" } }), "3.3.3.3");
});
