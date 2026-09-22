"use strict";
// Set before require: guard.cjs reads the timeout at load time.
process.env.BARNOWL_GUARD_MASK_TIMEOUT_MS = "1500";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const guard = require("../lib/guard.cjs");

// ── stub mask commands ──────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-guard-"));
const writeStub = (name, body) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body);
  return `node ${JSON.stringify(p)}`;
};
// Passes stdin through, replacing SECRET → <MASKED> (delimiter untouched).
const STUB_MASK = writeStub("mask.js", `
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => process.stdout.write(d.split("SECRET").join("<MASKED>")));
`);
const STUB_FAIL = writeStub("fail.js", `process.exit(1);`);
const STUB_HANG = writeStub("hang.js", `setTimeout(() => {}, 60000);`);
// Swallows the delimiter → wrong part count → must fail closed.
const STUB_EAT = writeStub("eat.js", `
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => process.stdout.write("collapsed"));
`);

const withEnv = (vars, fn) => async () => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const ON = { BARNOWL_GUARD: "1", BARNOWL_GUARD_MASK_CMD: STUB_MASK };

// ── maskTexts ───────────────────────────────────────────────────────────────

test("maskTexts: multiple texts, one spawn, order preserved", withEnv(ON, async () => {
  const out = await guard.maskTexts(["a SECRET b", "clean", "SECRET"]);
  assert.deepEqual(out, ["a <MASKED> b", "clean", "<MASKED>"]);
}));

test("maskTexts: fail-closed on nonzero exit", withEnv({ ...ON, BARNOWL_GUARD_MASK_CMD: STUB_FAIL }, async () => {
  await assert.rejects(guard.maskTexts(["x"]), /exited 1/);
}));

test("maskTexts: fail-closed on timeout", withEnv({ ...ON, BARNOWL_GUARD_MASK_CMD: STUB_HANG }, async () => {
  await assert.rejects(guard.maskTexts(["x"]), /timed out/);
}));

test("maskTexts: fail-closed on part-count mismatch", withEnv({ ...ON, BARNOWL_GUARD_MASK_CMD: STUB_EAT }, async () => {
  await assert.rejects(guard.maskTexts(["a", "b"]), /parts/);
}));

// ── engine-route bodies ─────────────────────────────────────────────────────

test("guardEngineBody: disabled → body untouched", withEnv({ BARNOWL_GUARD: undefined }, async () => {
  const body = { messages: [{ role: "user", content: "SECRET" }] };
  const r = await guard.guardEngineBody("/v1/chat/completions", body);
  assert.equal(r.ok, true);
  assert.equal(body.messages[0].content, "SECRET");
}));

test("guardEngineBody: openai text masked", withEnv(ON, async () => {
  const body = {
    messages: [
      { role: "system", content: "sys SECRET" },
      { role: "user", content: [{ type: "text", text: "part SECRET" }] },
    ],
  };
  const r = await guard.guardEngineBody("/v1/chat/completions", body);
  assert.equal(r.ok, true);
  assert.equal(r.body.messages[0].content, "sys <MASKED>");
  assert.equal(r.body.messages[1].content[0].text, "part <MASKED>");
}));

test("guardEngineBody: openai image_url → 403 openai-shaped", withEnv(ON, async () => {
  const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }] }] };
  const r = await guard.guardEngineBody("/v1/chat/completions", body);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.error.error.type, "guard_blocked");
}));

test("guardEngineBody: ollama images → 403 plain-shaped", withEnv(ON, async () => {
  const body = { messages: [{ role: "user", content: "hi", images: ["base64..."] }] };
  const r = await guard.guardEngineBody("/api/chat", body);
  assert.equal(r.ok, false);
  assert.equal(typeof r.error.error, "string");
}));

test("guardEngineBody: mask failure → 403, request never passes", withEnv({ ...ON, BARNOWL_GUARD_MASK_CMD: STUB_FAIL }, async () => {
  const r = await guard.guardEngineBody("/v1/chat/completions", { messages: [{ role: "user", content: "x" }] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
}));

// ── anthropic body walker ───────────────────────────────────────────────────

test("collectAnthropic: system + blocks + tool_result collected, image throws", () => {
  const body = {
    system: "sys",
    messages: [
      { role: "user", content: "plain" },
      { role: "user", content: [{ type: "text", text: "block" }, { type: "tool_result", content: [{ type: "text", text: "tr" }] }] },
    ],
  };
  const slots = guard.collectAnthropic(body);
  assert.deepEqual(slots.map((s) => s.obj[s.key]), ["sys", "plain", "block", "tr"]);
  assert.throws(
    () => guard.collectAnthropic({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }),
    guard.GuardBlocked,
  );
});

// ── /v1/messages passthrough ────────────────────────────────────────────────

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("handleMessages: masks body, forwards auth headers, streams response", async () => {
  let seen = null;
  const upstream = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      seen = { body: JSON.parse(d), auth: req.headers.authorization, ver: req.headers["anthropic-version"] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "ok" }] }));
    });
  });
  const upPort = await listen(upstream);
  const front = http.createServer((req, res) => guard.handleMessages(req, res));
  const frontPort = await listen(front);

  await withEnv({ ...ON, BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${upPort}` }, async () => {
    const resp = await fetch(`http://127.0.0.1:${frontPort}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer sk-test",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, system: "keep SECRET safe", messages: [{ role: "user", content: "my SECRET" }] }),
    });
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).id, "msg_1");
    assert.equal(seen.body.system, "keep <MASKED> safe");
    assert.equal(seen.body.messages[0].content, "my <MASKED>");
    assert.equal(seen.auth, "Bearer sk-test");
    assert.equal(seen.ver, "2023-06-01");
  })();

  upstream.close();
  front.close();
});

test("handleMessages: image block → 403, upstream never called", async () => {
  let called = false;
  const upstream = http.createServer((req, res) => { called = true; res.end("{}"); });
  const upPort = await listen(upstream);
  const front = http.createServer((req, res) => guard.handleMessages(req, res));
  const frontPort = await listen(front);

  await withEnv({ ...ON, BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${upPort}` }, async () => {
    const resp = await fetch(`http://127.0.0.1:${frontPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "aaaa" } }] }] }),
    });
    assert.equal(resp.status, 403);
    const body = await resp.json();
    assert.equal(body.error.type, "guard_blocked");
    assert.equal(called, false);
  })();

  upstream.close();
  front.close();
});

test("handleMessages: guard disabled → verbatim passthrough", async () => {
  let seen = null;
  const upstream = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { seen = d; res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  });
  const upPort = await listen(upstream);
  const front = http.createServer((req, res) => guard.handleMessages(req, res));
  const frontPort = await listen(front);

  const raw = JSON.stringify({ messages: [{ role: "user", content: "SECRET untouched" }] });
  await withEnv({ BARNOWL_GUARD: undefined, BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${upPort}` }, async () => {
    const resp = await fetch(`http://127.0.0.1:${frontPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    assert.equal(resp.status, 200);
    assert.equal(seen, raw);
  })();

  upstream.close();
  front.close();
});
