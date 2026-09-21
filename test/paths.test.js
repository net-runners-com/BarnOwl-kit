"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { PATH_KEYS, expandHome, applyPaths, detectPaths } = require("../lib/paths.cjs");

test("expandHome: leading ~ only", () => {
  assert.equal(expandHome("~/x/y", "/home/u"), "/home/u/x/y");
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("/a/~b", "/home/u"), "/a/~b");
  assert.equal(expandHome("~other/x", "/home/u"), "~other/x");
});

test("applyPaths: env wins, file values exported (~ expanded), the rest auto", () => {
  const env = { BARNOWL_CODEX_BIN: "/env/codex" };
  const out = applyPaths({
    codexBin: "/file/codex",
    claudeBin: "~/bin/claude",
    claudeKeychainAccount: "~literal",
    stateDir: "",
  }, env, "/home/u");
  assert.deepEqual(out.codexBin, { value: "/env/codex", source: "env" });
  assert.equal(env.BARNOWL_CODEX_BIN, "/env/codex");
  assert.deepEqual(out.claudeBin, { value: "/home/u/bin/claude", source: "file" });
  assert.equal(env.BARNOWL_CLAUDE_BIN, "/home/u/bin/claude");
  assert.deepEqual(out.claudeKeychainAccount, { value: "~literal", source: "file" }); // not a path
  assert.deepEqual(out.stateDir, { value: null, source: "auto" });
  assert.equal(env.BARNOWL_STATE_DIR, undefined);
  assert.deepEqual(Object.keys(out), PATH_KEYS.map((k) => k.key));
});

test("applyPaths: missing or non-object paths block → all auto, env untouched", () => {
  const env = {};
  const out = applyPaths(undefined, env, "/home/u");
  assert.ok(Object.values(out).every((r) => r.source === "auto" && r.value === null));
  assert.deepEqual(env, {});
});

test("detectPaths: fixed defaults per platform", () => {
  const mac = detectPaths({ home: "/Users/u", platform: "darwin" });
  assert.equal(mac.codexHome, path.join("/Users/u", ".codex"));
  assert.equal(mac.stateDir, path.join("/Users/u", ".barnowl"));
  assert.equal(mac.claudeCredentialsFile, null);
  assert.equal(typeof mac.claudeKeychainAccount, "string");
  const linux = detectPaths({ home: "/home/u", platform: "linux" });
  assert.equal(linux.claudeKeychainAccount, null);
  assert.equal(linux.claudeCredentialsFile, path.join("/home/u", ".claude", ".credentials.json"));
  for (const k of ["claudeBin", "codexBin", "python"]) {
    assert.ok(mac[k] === null || path.isAbsolute(mac[k]), `${k}: ${mac[k]}`);
  }
});
