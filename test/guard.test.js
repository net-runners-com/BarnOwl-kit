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

// ── LLM checker ─────────────────────────────────────────────────────────────

function llmServer(reply) {
  const state = { hits: 0 };
  state.server = http.createServer((req, res) => {
    state.hits++;
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: reply(JSON.parse(d)) } }] }));
    });
  });
  return state;
}

test("llmCheckTexts: clean verdict passes; cache skips repeat chunks", async () => {
  const s = llmServer(() => '{"leak": false}');
  const port = await listen(s.server);
  await withEnv({ BARNOWL_GUARD_LLM_URL: `http://127.0.0.1:${port}`, BARNOWL_GUARD_LLM_MODEL: "test-cache-clean" }, async () => {
    await guard.llmCheckTexts(["clean text one", "clean text two"]);
    assert.equal(s.hits, 2);
    await guard.llmCheckTexts(["clean text one", "clean text two"]);
    assert.equal(s.hits, 2); // cached, no new calls
  })();
  s.server.close();
});

test("llmCheckTexts: leak verdict → GuardBlocked", async () => {
  const s = llmServer(() => '{"leak": true}');
  const port = await listen(s.server);
  await withEnv({ BARNOWL_GUARD_LLM_URL: `http://127.0.0.1:${port}`, BARNOWL_GUARD_LLM_MODEL: "test-leak" }, async () => {
    await assert.rejects(guard.llmCheckTexts(["still has 090-9999-8888"]), guard.GuardBlocked);
  })();
  s.server.close();
});

test("llmCheckTexts: unreachable checker → fail closed", withEnv(
  { BARNOWL_GUARD_LLM_URL: "http://127.0.0.1:1", BARNOWL_GUARD_LLM_MODEL: "test-down" },
  async () => {
    await assert.rejects(guard.llmCheckTexts(["x"]), /llm checker failed/);
  },
));

test("llmCheckTexts: unparseable verdict → fail closed", async () => {
  const s = llmServer(() => "well, maybe?");
  const port = await listen(s.server);
  await withEnv({ BARNOWL_GUARD_LLM_URL: `http://127.0.0.1:${port}`, BARNOWL_GUARD_LLM_MODEL: "test-vague" }, async () => {
    await assert.rejects(guard.llmCheckTexts(["y"]), /unparseable/);
  })();
  s.server.close();
});

test("llmCheckTexts: no LLM configured → no-op", withEnv({ BARNOWL_GUARD_LLM_URL: undefined }, async () => {
  await guard.llmCheckTexts(["anything"]);
}));

test("guardEngineBody: mask + LLM leak verdict → 403", async () => {
  const s = llmServer(() => '{"leak": true}');
  const port = await listen(s.server);
  await withEnv({ ...ON, BARNOWL_GUARD_LLM_URL: `http://127.0.0.1:${port}`, BARNOWL_GUARD_LLM_MODEL: "test-e2e-leak" }, async () => {
    const r = await guard.guardEngineBody("/v1/chat/completions", { messages: [{ role: "user", content: "leaky" }] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  })();
  s.server.close();
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

// ── messagesHeaders: subscription auth for /v1/messages ─────────────────────

const CRED = { token: "oat-live", expiresAt: Date.now() + 3600_000, source: "keychain" };

test("messagesHeaders: oauth off → client headers verbatim, hop headers dropped", () => {
  const r = guard.messagesHeaders(
    { "x-api-key": "sk-ant-client", host: "localhost:11435", "content-length": "7" },
    { oauth: false },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.headers, { "x-api-key": "sk-ant-client" });
});

test("messagesHeaders: oauth on → client key swapped for the local login", () => {
  const r = guard.messagesHeaders(
    { "x-api-key": "sk-ant-dummy", authorization: "Bearer client", "content-type": "application/json" },
    { oauth: true, cred: CRED },
  );
  assert.equal(r.ok, true);
  assert.equal(r.headers["authorization"], "Bearer oat-live");
  assert.equal(r.headers["x-api-key"], undefined);
  assert.equal(r.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(r.headers["anthropic-version"], "2023-06-01");
  assert.equal(r.headers["content-type"], "application/json");
});

test("messagesHeaders: oauth on → client betas kept and deduped, version kept", () => {
  const r = guard.messagesHeaders(
    { "anthropic-beta": "code-execution-2025-08-25, oauth-2025-04-20", "anthropic-version": "2023-06-01" },
    { oauth: true, cred: CRED },
  );
  assert.equal(r.headers["anthropic-beta"], "code-execution-2025-08-25,oauth-2025-04-20");
  assert.equal(r.headers["anthropic-version"], "2023-06-01");
});

test("messagesHeaders: oauth on without a login → 401, nothing forwarded", () => {
  const r = guard.messagesHeaders({}, { oauth: true, cred: null });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.body.error.message, /no Claude Code login/);
});

test("messagesHeaders: oauth on with an expired login → 401", () => {
  const r = guard.messagesHeaders({}, { oauth: true, cred: { token: "t", expiresAt: 1000 }, now: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.body.error.message, /expired/);
});

test("messagesHeaders: a null expiresAt is treated as live", () => {
  const r = guard.messagesHeaders({}, { oauth: true, cred: { token: "t", expiresAt: null } });
  assert.equal(r.ok, true);
  assert.equal(r.headers["authorization"], "Bearer t");
});

test("oauthEnabled: reads BARNOWL_MESSAGES_OAUTH", withEnv({ BARNOWL_MESSAGES_OAUTH: "1" }, async () => {
  assert.equal(guard.oauthEnabled(), true);
}));

test("handleMessages: oauth on → upstream sees the local login, not the client key", async () => {
  let seen = null;
  const upstream = http.createServer((req, res) => {
    seen = req.headers;
    req.resume();
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  });
  const upPort = await listen(upstream);
  const front = http.createServer((req, res) => guard.handleMessages(req, res));
  const frontPort = await listen(front);

  await withEnv({
    BARNOWL_GUARD: undefined,
    BARNOWL_MESSAGES_OAUTH: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "oat-from-env",
    BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${upPort}`,
  }, async () => {
    const resp = await fetch(`http://127.0.0.1:${frontPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "sk-ant-dummy" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(resp.status, 200);
  })();

  assert.equal(seen["authorization"], "Bearer oat-from-env");
  assert.equal(seen["x-api-key"], undefined);
  assert.equal(seen["anthropic-beta"], "oauth-2025-04-20");
  upstream.close();
  front.close();
});

// ── withClaudeCodeSystem ────────────────────────────────────────────────────

const CC = "You are Claude Code, Anthropic's official CLI for Claude.";

test("withClaudeCodeSystem: no system → identity block only", () => {
  assert.deepEqual(guard.withClaudeCodeSystem({}).system, [{ type: "text", text: CC }]);
});

test("withClaudeCodeSystem: string system → identity first, client's second", () => {
  assert.deepEqual(guard.withClaudeCodeSystem({ system: "be terse" }).system,
    [{ type: "text", text: CC }, { type: "text", text: "be terse" }]);
});

test("withClaudeCodeSystem: array system → identity prepended once", () => {
  const body = { system: [{ type: "text", text: "be terse" }] };
  guard.withClaudeCodeSystem(body);
  guard.withClaudeCodeSystem(body);
  assert.deepEqual(body.system, [{ type: "text", text: CC }, { type: "text", text: "be terse" }]);
});

test("withClaudeCodeSystem: already-correct head is left alone (cache_control kept)", () => {
  const head = { type: "text", text: CC, cache_control: { type: "ephemeral" } };
  const body = { system: [head, { type: "text", text: "x" }] };
  guard.withClaudeCodeSystem(body);
  assert.equal(body.system.length, 2);
  assert.deepEqual(body.system[0], head);
});

test("handleMessages: oauth on → upstream body carries the identity system block", async () => {
  let seen = null;
  const upstream = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { seen = JSON.parse(d); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  });
  const upPort = await listen(upstream);
  const front = http.createServer((req, res) => guard.handleMessages(req, res));
  const frontPort = await listen(front);

  await withEnv({
    BARNOWL_GUARD: undefined,
    BARNOWL_MESSAGES_OAUTH: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "oat-from-env",
    BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${upPort}`,
  }, async () => {
    const resp = await fetch(`http://127.0.0.1:${frontPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        system: "be terse",
        tools: [{ type: "web_search_20260209", name: "web_search" }],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(resp.status, 200);
  })();

  assert.deepEqual(seen.system, [{ type: "text", text: CC }, { type: "text", text: "be terse" }]);
  assert.equal(seen.tools[0].type, "web_search_20260209");
  upstream.close();
  front.close();
});

// ── anthropic path table ────────────────────────────────────────────────────

test("isAnthropicPath: the first-party surface proxies, local routes do not", () => {
  for (const p of ["/v1/messages", "/v1/messages/count_tokens", "/v1/messages/batches",
    "/v1/messages/batches/msgbatch_1/results", "/v1/files", "/v1/files/file_1",
    "/v1/skills", "/v1/agents", "/v1/agents/ag_1", "/v1/sessions/s_1/events",
    "/v1/environments", "/v1/vaults", "/v1/memory_stores", "/v1/deployments",
    "/v1/deployment_runs", "/v1/organizations/users"]) {
    assert.equal(guard.isAnthropicPath(p), true, p);
  }
  for (const p of ["/v1/models", "/v1/chat/completions", "/v1/images/generations",
    "/v1/embeddings", "/api/tags", "/api/chat", "/health", "/", "/v1/messagesextra"]) {
    assert.equal(guard.isAnthropicPath(p), false, p);
  }
});

test("messagesShapes: one for messages, one per batch request, none elsewhere", () => {
  const body = { messages: [] };
  assert.deepEqual(guard.messagesShapes("/v1/messages", body), [body]);
  assert.deepEqual(guard.messagesShapes("/v1/messages/count_tokens", body), [body]);
  const a = { messages: [] };
  const b = { messages: [] };
  assert.deepEqual(
    guard.messagesShapes("/v1/messages/batches", { requests: [{ params: a }, { params: b }, { params: null }] }),
    [a, b]);
  assert.equal(guard.messagesShapes("/v1/messages/batches", { requests: "nope" }), null);
  assert.equal(guard.messagesShapes("/v1/agents", { name: "x" }), null);
});

// ── handleAnthropic beyond /v1/messages ─────────────────────────────────────

const proxyPair = async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: d });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  const upPort = await listen(upstream);
  const front = http.createServer((req, res) => guard.handleAnthropic(req, res));
  const frontPort = await listen(front);
  return { seen, upPort, frontPort, close: () => { upstream.close(); front.close(); } };
};

test("handleAnthropic: a GET keeps its path and query, sends no body", async () => {
  const p = await proxyPair();
  await withEnv({ BARNOWL_GUARD: undefined, BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${p.upPort}` }, async () => {
    const r = await fetch(`http://127.0.0.1:${p.frontPort}/v1/messages/batches?limit=2`, {
      headers: { "x-api-key": "sk-ant-client" },
    });
    assert.equal(r.status, 200);
  })();
  assert.equal(p.seen[0].method, "GET");
  assert.equal(p.seen[0].url, "/v1/messages/batches?limit=2");
  assert.equal(p.seen[0].body, "");
  assert.equal(p.seen[0].headers["x-api-key"], "sk-ant-client");
  p.close();
});

test("handleAnthropic: oauth injects the identity block into every batch request", async () => {
  const p = await proxyPair();
  await withEnv({
    BARNOWL_GUARD: undefined,
    BARNOWL_MESSAGES_OAUTH: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "oat-from-env",
    BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${p.upPort}`,
  }, async () => {
    const r = await fetch(`http://127.0.0.1:${p.frontPort}/v1/messages/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          { custom_id: "a", params: { model: "m", messages: [{ role: "user", content: "a" }] } },
          { custom_id: "b", params: { model: "m", system: "be terse", messages: [] } },
        ],
      }),
    });
    assert.equal(r.status, 200);
  })();
  const sent = JSON.parse(p.seen[0].body);
  assert.deepEqual(sent.requests[0].params.system, [{ type: "text", text: CC }]);
  assert.deepEqual(sent.requests[1].params.system, [{ type: "text", text: CC }, { type: "text", text: "be terse" }]);
  assert.equal(p.seen[0].headers["authorization"], "Bearer oat-from-env");
  p.close();
});

test("handleAnthropic: oauth leaves a non-Messages body alone (agents)", async () => {
  const p = await proxyPair();
  const raw = JSON.stringify({ name: "a", model: "m", system: "whatever" });
  await withEnv({
    BARNOWL_GUARD: undefined,
    BARNOWL_MESSAGES_OAUTH: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "oat-from-env",
    BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${p.upPort}`,
  }, async () => {
    await fetch(`http://127.0.0.1:${p.frontPort}/v1/agents`, {
      method: "POST", headers: { "content-type": "application/json" }, body: raw,
    });
  })();
  assert.equal(p.seen[0].body, raw);
  p.close();
});

test("handleAnthropic: the guard masks every batch request", async () => {
  const p = await proxyPair();
  await withEnv({ ...ON, BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${p.upPort}` }, async () => {
    await fetch(`http://127.0.0.1:${p.frontPort}/v1/messages/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          { custom_id: "a", params: { messages: [{ role: "user", content: "SECRET one" }] } },
          { custom_id: "b", params: { messages: [{ role: "user", content: "SECRET two" }] } },
        ],
      }),
    });
  })();
  const sent = JSON.parse(p.seen[0].body);
  assert.equal(sent.requests[0].params.messages[0].content, "<MASKED> one");
  assert.equal(sent.requests[1].params.messages[0].content, "<MASKED> two");
  p.close();
});

test("handleAnthropic: the guard blocks a shape it cannot mask", async () => {
  const p = await proxyPair();
  let status;
  let body;
  await withEnv({ ...ON, BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${p.upPort}` }, async () => {
    const r = await fetch(`http://127.0.0.1:${p.frontPort}/v1/agents`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a", system: "SECRET" }),
    });
    status = r.status;
    body = await r.json();
  })();
  assert.equal(status, 403);
  assert.equal(body.error.type, "guard_blocked");
  assert.match(body.error.message, /Messages-shaped/);
  assert.equal(p.seen.length, 0, "nothing reached the upstream");
  p.close();
});

test("handleAnthropic: the guard blocks a non-JSON body (file upload)", async () => {
  const p = await proxyPair();
  let status;
  await withEnv({ ...ON, BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${p.upPort}` }, async () => {
    const r = await fetch(`http://127.0.0.1:${p.frontPort}/v1/files`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "--x\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nSECRET\r\n--x--\r\n",
    });
    status = r.status;
  })();
  assert.equal(status, 403);
  assert.equal(p.seen.length, 0);
  p.close();
});

test("handleAnthropic: with the guard off a non-JSON body passes through byte-for-byte", async () => {
  const p = await proxyPair();
  const raw = "--x\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nhello\r\n--x--\r\n";
  await withEnv({ BARNOWL_GUARD: undefined, BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${p.upPort}` }, async () => {
    await fetch(`http://127.0.0.1:${p.frontPort}/v1/files`, {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: raw,
    });
  })();
  assert.equal(p.seen[0].body, raw);
  p.close();
});

// ── summarizeStop: the stop_details tap ─────────────────────────────────────

test("summarizeStop: SSE message_delta refusal → category + explanation", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-sonnet-5-5"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"nope"}}}',
    '',
  ].join("\n");
  assert.deepEqual(guard.summarizeStop(sse, "text/event-stream; charset=utf-8"),
    { model: "claude-sonnet-5-5", stop_reason: "refusal", category: "cyber", explanation: "nope" });
});

test("summarizeStop: SSE end_turn → null category, not dropped", () => {
  const sse = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_details":null}}\n';
  assert.deepEqual(guard.summarizeStop(sse, "text/event-stream"),
    { model: null, stop_reason: "end_turn", category: null, explanation: null });
});

test("summarizeStop: buffered JSON body", () => {
  const body = JSON.stringify({ model: "m", stop_reason: "refusal", stop_details: { category: "bio", explanation: "x" } });
  assert.deepEqual(guard.summarizeStop(body, "application/json"),
    { model: "m", stop_reason: "refusal", category: "bio", explanation: "x" });
});

test("summarizeStop: nothing to report → null", () => {
  assert.equal(guard.summarizeStop("", "application/json"), null);
  assert.equal(guard.summarizeStop("not json", "application/json"), null);
  assert.equal(guard.summarizeStop('data: {"type":"ping"}', "text/event-stream"), null);
});

// ── categoryJa: Japanese gloss per refusal category ─────────────────────────

test("categoryJa: known categories map to Japanese, unknown/null to a generic line", () => {
  assert.match(guard.categoryJa("cyber"), /サイバー/);
  assert.match(guard.categoryJa("bio"), /生物学/);
  assert.match(guard.categoryJa("frontier_llm"), /競合AI/);
  assert.match(guard.categoryJa("reasoning_extraction"), /内部推論/);
  assert.match(guard.categoryJa("general_harms"), /カテゴリ外/);
  assert.equal(guard.categoryJa(null), guard.categoryJa("nonexistent"));
  assert.match(guard.categoryJa(null), /該当しない/);
});

// ── generic response rewrite (refusal localization is one preset) ───────────

test("applyRewrite: built-in JA preset localizes a buffered-JSON refusal", () => {
  const j = { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "cyber harm" } };
  guard.applyRewrite(j, guard.BUILTIN_JA_RULES);
  assert.match(j.stop_details.explanation, /サイバー被害/);
  assert.match(j.stop_details.explanation, /原文: cyber harm/);
});

test("applyRewrite: a rule reaches into an SSE message_delta's delta scope", () => {
  const j = { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { category: "bio", explanation: "x" } } };
  guard.applyRewrite(j, guard.BUILTIN_JA_RULES);
  assert.match(j.delta.stop_details.explanation, /生物学/);
});

test("applyRewrite: non-matching objects and a null rule list are untouched", () => {
  const j = { stop_reason: "end_turn", stop_details: null };
  const copy = JSON.parse(JSON.stringify(j));
  guard.applyRewrite(j, guard.BUILTIN_JA_RULES);
  assert.deepEqual(j, copy);
  guard.applyRewrite(j, null);
  assert.deepEqual(j, copy);
});

test("applyRewrite: a rule can set any fields via dot-paths and {path} tokens", () => {
  const rules = [{
    when: { "stop_reason": "refusal", "stop_details.category": "cyber" },
    set: { "stop_details.type": "blocked", "stop_details.category": "sec",
           "stop_details.explanation": "bloqueado [{stop_details.category}] orig={stop_details.explanation}" },
  }];
  const j = { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "harm" } };
  guard.applyRewrite(j, rules);
  // tokens render against pre-mutation values
  assert.deepEqual(j.stop_details, { type: "blocked", category: "sec", explanation: "bloqueado [cyber] orig=harm" });
});

test("applyRewrite: generic — rewrite a non-refusal field (text_delta)", () => {
  const rules = [{ when: { "delta.type": "text_delta", "delta.text": "secret" }, set: { "delta.text": "[redacted]" } }];
  const j = { type: "content_block_delta", delta: { type: "text_delta", text: "secret" } };
  guard.applyRewrite(j, rules);
  assert.equal(j.delta.text, "[redacted]");
});

test("applyRewrite: `when` accepts an array of allowed values", () => {
  const rules = [{ when: { "stop_details.category": ["cyber", "bio"] }, set: { "stop_details.explanation": "hit" } }];
  const hit = { stop_details: { category: "bio", explanation: "o" } };
  guard.applyRewrite(hit, rules); assert.equal(hit.stop_details.explanation, "hit");
  const miss = { stop_details: { category: "frontier_llm", explanation: "o" } };
  guard.applyRewrite(miss, rules); assert.equal(miss.stop_details.explanation, "o");
});

test("setPath: never fabricates a missing parent", () => {
  const o = { a: {} };
  assert.equal(guard.setPath(o, "a.b.c", 1), false);
  assert.equal(guard.setPath(o, "x.y", 1), false);
  o.a.b = "here";
  assert.equal(guard.setPath(o, "a.b", "there"), true);
  assert.equal(o.a.b, "there");
});

test("rewriteSseLine: rewrites matching data lines, passes everything else", () => {
  assert.match(guard.rewriteSseLine('data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"bio","explanation":"x"}}}', guard.BUILTIN_JA_RULES), /生物学/);
  const passthrough = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}';
  assert.equal(guard.rewriteSseLine(passthrough, guard.BUILTIN_JA_RULES), passthrough);
  assert.equal(guard.rewriteSseLine("event: message_delta", guard.BUILTIN_JA_RULES), "event: message_delta");
});

test("handleAnthropic: a rewrite rule reaches the client (SSE refusal → Japanese)", async () => {
  const sse = [
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"cyber harm"}}}',
    '', 'event: message_stop', 'data: {"type":"message_stop"}', '',
  ].join("\n");
  const upstream = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(sse); }); });
  const upPort = await listen(upstream);
  const front = http.createServer((req, res) => guard.handleAnthropic(req, res));
  const frontPort = await listen(front);
  let body;
  await withEnv({ BARNOWL_GUARD: undefined, BARNOWL_MESSAGES_REWRITE: JSON.stringify(guard.BUILTIN_JA_RULES), BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${upPort}` }, async () => {
    guard._resetRewriteRules();
    const r = await fetch(`http://127.0.0.1:${frontPort}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, messages: [] }) });
    body = ""; for await (const c of r.body) body += Buffer.from(c).toString("utf8");
  })();
  assert.match(body, /サイバー被害/, "client sees Japanese");
  assert.match(body, /原文: cyber harm/, "original kept");
  assert.ok(body.includes("message_stop"), "rest of the stream intact");
  upstream.close(); front.close();
});

test("handleAnthropic: a rewrite rule reaches the client (buffered JSON refusal → Japanese)", async () => {
  const json = JSON.stringify({ stop_reason: "refusal", stop_details: { type: "refusal", category: "frontier_llm", explanation: "competing models" } });
  const upstream = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(json); }); });
  const upPort = await listen(upstream);
  const front = http.createServer((req, res) => guard.handleAnthropic(req, res));
  const frontPort = await listen(front);
  let parsed;
  await withEnv({ BARNOWL_GUARD: undefined, BARNOWL_MESSAGES_REWRITE: JSON.stringify(guard.BUILTIN_JA_RULES), BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${upPort}` }, async () => {
    guard._resetRewriteRules();
    const r = await fetch(`http://127.0.0.1:${frontPort}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
    parsed = await r.json();
  })();
  assert.match(parsed.stop_details.explanation, /競合AI/);
  upstream.close(); front.close();
});

// ── rewrite rule loading + ordering ─────────────────────────────────────────

test("loadRewriteRules: inline JSON array/object, else null", withEnv({ BARNOWL_MESSAGES_REWRITE: undefined }, async () => {
  guard._resetRewriteRules();
  assert.equal(guard.loadRewriteRules(), null);
  await withEnv({ BARNOWL_MESSAGES_REWRITE: JSON.stringify([{ when: { "model": "x" }, set: { "model": "y" } }]) }, async () => {
    guard._resetRewriteRules();
    assert.deepEqual(guard.loadRewriteRules(), [{ when: { model: "x" }, set: { model: "y" } }]);
  })();
  await withEnv({ BARNOWL_MESSAGES_REWRITE: JSON.stringify({ when: { "a": 1 }, set: { "a": 2 } }) }, async () => {
    guard._resetRewriteRules();
    assert.equal(guard.loadRewriteRules().length, 1, "a lone object is wrapped into a one-rule list");
  })();
  guard._resetRewriteRules();
}));

test("applyRewrite: rules apply in order — a later rule overrides an earlier one", () => {
  const rules = [
    { when: { "stop_details.category": "cyber" }, set: { "stop_details.explanation": "first" } },
    { when: { "stop_reason": "refusal" }, set: { "stop_details.explanation": "second" } },
  ];
  const j = { stop_reason: "refusal", stop_details: { category: "cyber", explanation: "o" } };
  guard.applyRewrite(j, rules);
  assert.equal(j.stop_details.explanation, "second");
});
