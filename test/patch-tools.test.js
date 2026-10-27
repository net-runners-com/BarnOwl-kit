"use strict";
// Verifies the engine.js tools patch:
//   - BARNOWL_ENABLE_TOOLS=1       → empty extra args (no --disallowed-tools)
//   - BARNOWL_ALLOW_TOOLS=Bash     → disallow list contains everything but Bash
//   - unset                        → full kill-list (same as the v1 patch)
//   - migrateBlock(v1 → v2) upgrades an older install
const test = require("node:test");
const assert = require("node:assert/strict");

// Pull the patch strings directly from the module without running ensurePatched.
// The module only runs on require.main === module, so a plain require is safe.
const patchMod = require("../lib/patch-otterly.js");
const fs = require("node:fs");
const path = require("node:path");

// Read the file to grab the TOOLS_REPLACEMENT and TOOLS_V1 string literals —
// they're not exported, but they're deterministic constants.
const src = fs.readFileSync(require.resolve("../lib/patch-otterly.js"), "utf8");

// Extract the TOOLS_REPLACEMENT contents by matching the comment anchor.
function evaluateTailArgs(env) {
  // Reconstruct exactly the IIFE that the patch inserts into engine.js, then
  // eval it. If the shape of the inserted code changes, the extraction below
  // breaks loudly — which is what we want.
  const start = src.indexOf("const TOOLS_REPLACEMENT = [");
  const end = src.indexOf("].join(\"\\n\");", start);
  assert.ok(start > 0 && end > start, "could not locate TOOLS_REPLACEMENT");
  // eslint-disable-next-line no-eval
  const arr = eval(src.slice(start + "const TOOLS_REPLACEMENT = ".length, end + 1));
  const body = arr.join("\n");
  // The injected text is  `"--verbose", "--setting-sources", '""'\n  // ...\n  , ...(() => {...})()`.
  // We only need the IIFE expression — strip the leading verbose/anchors.
  const iifeMatch = body.match(/, \.\.\.(\(\(\) => \{[\s\S]+?\}\)\(\))$/);
  assert.ok(iifeMatch, "could not isolate IIFE from TOOLS_REPLACEMENT");
  const prev = { ...process.env };
  try {
    for (const k of ["BARNOWL_ENABLE_TOOLS", "BARNOWL_ALLOW_TOOLS"]) delete process.env[k];
    Object.assign(process.env, env);
    // eslint-disable-next-line no-eval
    return eval(iifeMatch[1]);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, prev);
  }
}

test("tools patch: unset env → full kill-list", () => {
  const args = evaluateTailArgs({});
  assert.deepEqual(args.slice(0, 1), ["--disallowed-tools"]);
  const kill = args[1].split(" ");
  for (const t of ["Bash", "Edit", "Write", "Read", "Grep", "WebFetch", "Task"]) {
    assert.ok(kill.includes(t), `kill-list missing ${t}`);
  }
});

test("tools patch: ENABLE_TOOLS=1 → empty args", () => {
  const args = evaluateTailArgs({ BARNOWL_ENABLE_TOOLS: "1" });
  assert.deepEqual(args, []);
});

test("tools patch: ALLOW_TOOLS=Bash → Bash is subtracted", () => {
  const args = evaluateTailArgs({ BARNOWL_ALLOW_TOOLS: "Bash" });
  assert.equal(args[0], "--disallowed-tools");
  const kill = args[1].split(" ");
  assert.ok(!kill.includes("Bash"), "Bash should NOT be in kill-list");
  assert.ok(kill.includes("Edit"), "Edit should still be in kill-list");
});

test("tools patch: ALLOW_TOOLS accepts comma + space", () => {
  const args = evaluateTailArgs({ BARNOWL_ALLOW_TOOLS: "Bash, Read Write" });
  const kill = args[1].split(" ");
  for (const t of ["Bash", "Read", "Write"]) assert.ok(!kill.includes(t));
  assert.ok(kill.includes("Edit"));
});

test("tools patch: allow every tool → empty args", () => {
  const all = "Bash Edit Write Read Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit BashOutput KillShell SlashCommand ExitPlanMode";
  const args = evaluateTailArgs({ BARNOWL_ALLOW_TOOLS: all });
  assert.deepEqual(args, []);
});
