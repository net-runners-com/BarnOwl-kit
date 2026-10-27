"use strict";
// seal sandbox tests — the layer that holds when the firewall patch does not.
// The severe failure on that path is persistence (a cron entry, an appended
// authorized_keys, a launch agent), so these assert that writes and network
// are gone while the decrypt itself still runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  sandboxAvailable,
  sandboxMode,
  sandboxPrefix,
  DARWIN_POLICY,
  DARWIN_BIN,
} = require("../lib/seal/sandbox.js");
const { buildDecryptCommand } = require("../lib/seal/firewall.js");
const { newKey, encrypt } = require("../lib/seal/crypto.js");

test("mode: auto by default, require/off honoured", () => {
  assert.equal(sandboxMode(), "auto");
  assert.equal(sandboxMode("require"), "require");
  assert.equal(sandboxMode("OFF"), "off");
  assert.equal(sandboxMode("nonsense"), "auto");
});

test("availability: reported per platform, unknown platforms say no", () => {
  assert.equal(sandboxAvailable("sunos"), false);
  assert.equal(sandboxAvailable("win32"), false);
  assert.equal(typeof sandboxAvailable("darwin"), "boolean");
});

test("prefix: off yields no wrapper", () => {
  assert.equal(sandboxPrefix({ mode: "off" }), "");
  assert.equal(sandboxPrefix({ mode: "off", platform: "darwin" }), "");
});

test("prefix: auto degrades silently on an unsupported platform", () => {
  assert.equal(sandboxPrefix({ mode: "auto", platform: "win32" }), "");
});

test("prefix: require refuses rather than running uncontained", () => {
  assert.throws(
    () => sandboxPrefix({ mode: "require", platform: "win32" }),
    (e) => e.code === "SEAL_NO_SANDBOX" && /no sandbox is available/.test(e.message),
  );
});

test("policy: denies network and writes, allows the reads python3 needs to start", () => {
  assert.ok(DARWIN_POLICY.includes("(deny default)"));
  assert.ok(DARWIN_POLICY.includes("(deny network*)"));
  assert.ok(DARWIN_POLICY.includes("(deny file-write*)"));
  assert.ok(DARWIN_POLICY.includes("(allow file-read*)"));
  assert.ok(DARWIN_POLICY.includes("(allow process-exec)"));
});

test("prefix: the wrapper is part of the command, so the firewall pins it", () => {
  const args = { keyHex: "a".repeat(64), ivHex: "b".repeat(24), ctB64: "YWJj", nonce: "d".repeat(32) };
  const bare = buildDecryptCommand({ ...args, sandbox: "" });
  const wrapped = buildDecryptCommand({ ...args, sandbox: "unshare -rn " });
  assert.ok(wrapped.startsWith("unshare -rn python3 - <<'PY'"));
  assert.ok(bare.startsWith("python3 - <<'PY'"));
  assert.notEqual(bare, wrapped);
});

// ── behaviour of the real sandbox, where there is one ──────────────────────

const darwinSandbox = process.platform === "darwin" && fs.existsSync(DARWIN_BIN);

test("darwin: the policy still lets the decrypt command produce plaintext", (t) => {
  if (!darwinSandbox) return t.skip("no macOS sandbox-exec here");
  const key = newKey();
  const { envelope } = encrypt(Buffer.from("機密: 田中太郎 34歳", "utf8"), key);
  const cmd = buildDecryptCommand({
    keyHex: key.toString("hex"),
    ivHex: Buffer.from(envelope.iv, "base64").toString("hex"),
    ctB64: envelope.ct,
    nonce: "e".repeat(32),
    sandbox: sandboxPrefix({ mode: "auto", platform: "darwin" }),
  });
  let out;
  try {
    out = execFileSync("/bin/bash", ["-c", cmd], { encoding: "utf8" });
  } catch (err) {
    // cryptography isn't installed everywhere; that's an env gap, not a policy bug
    if (/ModuleNotFoundError|No module named/.test(String(err.stderr))) {
      return t.skip("python3 cryptography not installed");
    }
    throw err;
  }
  assert.match(out, /^<<<BARNOWL-SEALED-DATA e{32}>>>$/m);
  assert.ok(out.includes("機密: 田中太郎 34歳"), out);
});

test("darwin: the policy blocks a write (persistence) and a connection (exfil)", (t) => {
  if (!darwinSandbox) return t.skip("no macOS sandbox-exec here");
  const probe = path.join(os.tmpdir(), `seal-sandbox-probe-${process.pid}`);
  const run = (py) => {
    try {
      return { ok: true, out: execFileSync(DARWIN_BIN, ["-p", DARWIN_POLICY, "python3", "-c", py], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (err) {
      return { ok: false, err: String(err.stderr || err.message) };
    }
  };
  assert.equal(run('print("compute")').ok, true, "sandbox broke plain compute");

  const write = run(`open(${JSON.stringify(probe)}, "w").write("x")`);
  assert.equal(write.ok, false, "a write succeeded inside the sandbox");
  assert.match(write.err, /not permitted/i);
  assert.equal(fs.existsSync(probe), false, "the file was created despite the denial");

  const net = run('import socket; socket.create_connection(("1.1.1.1", 80), 3)');
  assert.equal(net.ok, false, "a network connection succeeded inside the sandbox");
  assert.match(net.err, /not permitted/i);
});
