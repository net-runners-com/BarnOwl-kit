"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-plugins-"));
process.env.BARNOWL_STATE_DIR = STATE;
const plugins = require("../lib/plugins.cjs");

test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

let n = 0;
const writePlugin = (src) => {
  const p = path.join(STATE, `plugin-${++n}.cjs`);
  fs.writeFileSync(p, src);
  return p;
};
const use = (cfg) => {
  if (cfg === null) delete process.env.BARNOWL_PLUGINS;
  else process.env.BARNOWL_PLUGINS = typeof cfg === "string" ? cfg : JSON.stringify(cfg);
  plugins._reset();
  globalThis.__seen = [];
};
const tick = () => new Promise((r) => setImmediate(r));
const REQ = { route: "native", path: "/v1/messages", headers: { "x-a": "1" }, body: { model: "m1", stream: true } };

const RECORDER = `
  module.exports = {
    name: "rec",
    init(options, ctx) { globalThis.__seen.push(["init", options, ctx.stateDir]); },
    onRequest(req) { globalThis.__seen.push(["req", req.route]); return { identity: { user: "u1" }, stripHeaders: ["X-Secret"] }; },
    onComplete(record) { globalThis.__seen.push(["done", { ...record }]); },
  };`;

test("unconfigured: disabled, nothing loaded", () => {
  use(null);
  assert.equal(plugins.enabled(), false);
  assert.deepEqual(plugins.load(), []);
});

test("resolvePlugin: bare name → bundled dir, path → file, ~ expanded", () => {
  assert.ok(plugins.resolvePlugin("usage").endsWith(path.join("plugins", "usage", "index.cjs")));
  assert.equal(plugins.resolvePlugin("/abs/p.cjs"), path.resolve("/abs/p.cjs"));
  assert.equal(plugins.resolvePlugin("~/p.cjs"), path.join(os.homedir(), "p.cjs"));
});

test("loads by path, passes options and the state dir, false skips", () => {
  const a = writePlugin(RECORDER);
  const b = writePlugin(`module.exports = { name: "skipped", init() { throw new Error("must not load"); } };`);
  use({ [a]: { x: 1 }, [b]: false });
  assert.equal(plugins.enabled(), true);
  assert.deepEqual(plugins.load().map((p) => p.name), ["rec"]);
  assert.deepEqual(globalThis.__seen[0], ["init", { x: 1 }, STATE]);
});

test("begin → finish: identity merged, headers to strip lowercased, record shaped", async () => {
  use({ [writePlugin(RECORDER)]: {} });
  const b = await plugins.begin(REQ);
  assert.equal(b.ok, true);
  assert.deepEqual([...b.call.stripHeaders], ["x-secret"]);
  await b.call.finish({ status: 200, outcome: "ok", inputTokens: 5 });
  const done = globalThis.__seen.find((e) => e[0] === "done")[1];
  assert.equal(done.route, "native");
  assert.equal(done.path, "/v1/messages");
  assert.equal(done.model, "m1");
  assert.equal(done.stream, true);
  assert.equal(done.user, "u1");
  assert.equal(done.status, 200);
  assert.equal(done.inputTokens, 5);
  assert.ok(Number.isInteger(done.durationMs) && done.durationMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(done.ts)));
});

test("finish runs once; a throwing onComplete is swallowed", async () => {
  const boom = writePlugin(`module.exports = { name: "boom", onComplete() { globalThis.__seen.push(["boom"]); throw new Error("disk full"); } };`);
  use({ [boom]: {}, [writePlugin(RECORDER)]: {} });
  const b = await plugins.begin(REQ);
  await b.call.finish({ status: 200, outcome: "ok" });
  await b.call.finish({ status: 500, outcome: "upstream_error" });
  assert.equal(globalThis.__seen.filter((e) => e[0] === "boom").length, 1);
  const dones = globalThis.__seen.filter((e) => e[0] === "done");
  assert.equal(dones.length, 1, "later plugins still ran, once");
  assert.equal(dones[0][1].status, 200);
});

test("hooks run in config order; the first reject wins and stops the chain", async () => {
  const first = writePlugin(`module.exports = { name: "first", onRequest() { globalThis.__seen.push("first"); return { identity: { deviceId: "d1" }, reject: { status: 401, type: "authentication_error", message: "no key" } }; } };`);
  const second = writePlugin(`module.exports = { name: "second", onRequest() { globalThis.__seen.push("second"); } };`);
  use({ [first]: {}, [second]: {} });
  const b = await plugins.begin(REQ);
  assert.equal(b.ok, false);
  assert.deepEqual(b.reject, { status: 401, type: "authentication_error", message: "no key" });
  assert.equal(b.call.record.deviceId, "d1", "identity from the rejecting hook is kept");
  assert.deepEqual(globalThis.__seen, ["first"]);
});

test("a throwing onRequest rejects with 500 plugin_error", async () => {
  use({ [writePlugin(`module.exports = { name: "bad", onRequest() { throw new Error("kaboom"); } };`)]: {} });
  const b = await plugins.begin(REQ);
  assert.equal(b.ok, false);
  assert.equal(b.reject.status, 500);
  assert.equal(b.reject.type, "plugin_error");
  assert.match(b.reject.message, /bad.*kaboom/);
});

test("a plugin that cannot load: load() throws, enabled() stays true, begin() rejects", async () => {
  use({ [path.join(STATE, "nope.cjs")]: {} });
  assert.throws(() => plugins.load(), /failed to load/);
  assert.equal(plugins.enabled(), true, "a broken config must not fall back to no plugins");
  const b = await plugins.begin(REQ);
  assert.equal(b.ok, false);
  assert.equal(b.reject.type, "plugin_error");
});

test("invalid BARNOWL_PLUGINS JSON and a throwing init both fail the load", () => {
  use("{not json");
  assert.throws(() => plugins.load(), /BARNOWL_PLUGINS/);
  use({ [writePlugin(`module.exports = { name: "i", init() { throw new Error("no dir"); } };`)]: {} });
  assert.throws(() => plugins.load(), /init failed.*no dir/);
});

test("stream flag follows each route's default", async () => {
  use({ [writePlugin(RECORDER)]: {} });
  const s = async (p, body) => (await plugins.begin({ route: "api", path: p, headers: {}, body })).call.record.stream;
  assert.equal(await s("/v1/chat/completions", {}), false);
  assert.equal(await s("/v1/chat/completions", { stream: true }), true);
  assert.equal(await s("/api/chat", {}), true);
  assert.equal(await s("/api/generate", { stream: false }), false);
  assert.equal(await s("/api/stream", {}), true);
  assert.equal(await s("/api/run", {}), false);
});

test("outcomeOf", () => {
  assert.equal(plugins.outcomeOf(200), "ok");
  assert.equal(plugins.outcomeOf(204), "ok");
  assert.equal(plugins.outcomeOf(403), "blocked");
  assert.equal(plugins.outcomeOf(500), "upstream_error");
  assert.equal(plugins.outcomeOf(429), "upstream_error");
});

test("beginEngine: reject is shaped per route and recorded as rejected", async () => {
  const rej = writePlugin(`module.exports = { name: "rej",
    onRequest() { return { reject: { status: 401, type: "authentication_error", message: "no key" } }; },
    onComplete(r) { globalThis.__seen.push({ ...r }); } };`);
  use({ [rej]: {} });
  const openai = await plugins.beginEngine("/v1/chat/completions", {}, { model: "sonnet" });
  assert.deepEqual(openai, { ok: false, status: 401, error: { error: { message: "no key", type: "authentication_error", code: 401 } } });
  const plain = await plugins.beginEngine("/api/chat", {}, {});
  assert.deepEqual(plain, { ok: false, status: 401, error: { error: "no key" } });
  assert.deepEqual(globalThis.__seen.map((r) => [r.route, r.outcome, r.status]), [["api", "rejected", 401], ["api", "rejected", 401]]);
});

test("attach + metrics tap: concurrent requests keep their own token counts", async () => {
  use({ [writePlugin(`module.exports = { name: "m", onComplete(r) { globalThis.__seen.push({ ...r }); } };`)]: {} });
  async function request(model, tokens, delayMs, status) {
    const b = await plugins.beginEngine("/v1/chat/completions", {}, { model });
    const res = new EventEmitter();
    res.statusCode = status;
    plugins.attach(res, b.call);
    await new Promise((r) => setTimeout(r, delayMs)); // the engine works; another request interleaves
    await Promise.resolve().then(() => globalThis.__barnowlOnMetrics({ inputTokens: tokens, outputTokens: tokens * 2, toolCalls: 1 }));
    res.emit("close");
  }
  await Promise.all([request("a", 10, 30, 200), request("b", 20, 5, 200), request("c", 30, 15, 403)]);
  await tick();
  const by = Object.fromEntries(globalThis.__seen.map((r) => [r.model, r]));
  assert.deepEqual([by.a.inputTokens, by.a.outputTokens, by.a.toolCalls, by.a.outcome], [10, 20, 1, "ok"]);
  assert.deepEqual([by.b.inputTokens, by.b.outputTokens, by.b.outcome], [20, 40, "ok"]);
  assert.deepEqual([by.c.inputTokens, by.c.outcome, by.c.status], [30, "blocked", 403]);
});

test("metrics tap outside any request is a no-op", () => {
  use(null);
  assert.doesNotThrow(() => globalThis.__barnowlOnMetrics({ inputTokens: 1 }));
  assert.doesNotThrow(() => globalThis.__barnowlOnMetrics(undefined));
});
