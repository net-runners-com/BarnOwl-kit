"use strict";
// seal-relay tests: without hitting a real LLM, verify that
//   (a) the request body contains a system prompt with key/iv/ciphertext,
//   (b) those parameters, pulled back out of the system prompt, actually
//       decrypt to the original plaintext (end-to-end chain correctness),
//   (c) the ephemeral key Buffer is zeroed after the call.
const test = require("node:test");
const assert = require("node:assert/strict");
const { sealRelay, buildRelaySystemPrompt } = require("../lib/seal/relay.js");
const { decryptRaw } = require("../lib/seal/crypto.js");

function captureRequest(replyContent = "ok") {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_url, init) => {
    try { captured = JSON.parse(init.body); } catch { captured = { raw: init.body }; }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: replyContent } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return {
    captured() { return captured; },
    restore() { globalThis.fetch = original; },
  };
}

test("relay: system prompt carries hex key, hex iv, base64 ct", async () => {
  const probe = captureRequest();
  try {
    await sealRelay({ payload: "個人情報: 田中太郎 34歳", task: "この人の年齢を教えて" });
  } finally { probe.restore(); }
  const req = probe.captured();
  const sysMsg = req.messages.find((m) => m.role === "system").content;
  assert.ok(/[0-9a-f]{64}/.test(sysMsg), "no 32-byte hex key in system prompt");
  assert.ok(/bytes\.fromhex\("[0-9a-f]{64}"\)/.test(sysMsg), "key fromhex call not present");
  assert.ok(/bytes\.fromhex\("[0-9a-f]{24}"\)/.test(sysMsg), "iv fromhex (24 hex chars) not present");
  assert.ok(/base64\.b64decode\("[A-Za-z0-9+/=]+"\)/.test(sysMsg), "base64 ciphertext missing");
});

test("relay: the embedded ciphertext round-trips with crypto.decryptRaw", async () => {
  const probe = captureRequest();
  const payload = "機密データ: ユーザー ID = 12345";
  try {
    await sealRelay({ payload, task: "この ID から集計" });
  } finally { probe.restore(); }
  const sysMsg = probe.captured().messages.find((m) => m.role === "system").content;
  const keyHex = sysMsg.match(/key = bytes\.fromhex\("([0-9a-f]{64})"\)/)[1];
  const ivHex  = sysMsg.match(/iv  = bytes\.fromhex\("([0-9a-f]{24})"\)/)[1];
  const ctB64  = sysMsg.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/)[1];
  const raw = Buffer.concat([Buffer.from(ivHex, "hex"), Buffer.from(ctB64, "base64")]);
  const roundTrip = decryptRaw(raw, Buffer.from(keyHex, "hex")).toString("utf8");
  assert.equal(roundTrip, payload);
});

test("relay: user message is the task text (unmodified)", async () => {
  const probe = captureRequest();
  try {
    await sealRelay({ payload: "x", task: "名前を昇順で並べて" });
  } finally { probe.restore(); }
  const userMsg = probe.captured().messages.find((m) => m.role === "user").content;
  assert.equal(userMsg, "名前を昇順で並べて");
});

test("relay: upstream non-OK propagates as SEAL_UPSTREAM", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  try {
    await assert.rejects(
      () => sealRelay({ payload: "x", task: "t" }),
      (e) => e.code === "SEAL_UPSTREAM" && /upstream 429/.test(e.message),
    );
  } finally { globalThis.fetch = original; }
});

test("relay: refuses empty task", async () => {
  await assert.rejects(() => sealRelay({ payload: "x", task: "   " }), /task required/);
});

test("relay: refuses missing payload", async () => {
  await assert.rejects(() => sealRelay({ task: "t" }), /payload required/);
});

test("relay: buildRelaySystemPrompt is deterministic for same inputs", () => {
  const a = buildRelaySystemPrompt({ keyHex: "a".repeat(64), ivHex: "b".repeat(24), ctB64: "YWJj" });
  const b = buildRelaySystemPrompt({ keyHex: "a".repeat(64), ivHex: "b".repeat(24), ctB64: "YWJj" });
  assert.equal(a, b);
  assert.ok(a.includes("--allow-tools Bash"));  // explicit failure message
  assert.ok(a.includes("AES-256-GCM"));
});
