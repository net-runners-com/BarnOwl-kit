"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "barnowl.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-cli-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
function setup(config) {
  const dir = path.join(ROOT, `c${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const stateDir = path.join(dir, "state");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ autoUpdate: false, paths: { stateDir }, ...config }));
  return { file, stateDir };
}
function run(args, env = {}) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith("BARNOWL_")) delete clean[k];
  // cwd is a temp dir so a stray ./barnowl.config.json can never be picked up.
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd: ROOT, env: { ...clean, ...env } });
}

test("config shows the plugins block, or null when unset", () => {
  const on = setup({ plugins: { usage: { requireKey: false } } });
  const shown = JSON.parse(run(["config", "--config", on.file]).stdout.replace(/^.*\n/, ""));
  assert.deepEqual(shown.plugins, { usage: { requireKey: false } });
  const off = setup({});
  assert.equal(JSON.parse(run(["config", "--config", off.file]).stdout.replace(/^.*\n/, "")).plugins, null);
});

test("usage key add → usage --json, through the real CLI", () => {
  const { file, stateDir } = setup({ plugins: { usage: {} } });
  const add = run(["usage", "key", "add", "sato", "--config", file]);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /bo_[A-Za-z0-9_-]{43}/);
  assert.ok(fs.existsSync(path.join(stateDir, "usage", "keys.json")), "written under the config's state dir");

  const list = run(["usage", "key", "list", "--config", file]);
  assert.match(list.stdout, /sato\s+active/);

  const rep = run(["usage", "--json", "--config", file]);
  assert.equal(rep.status, 0, rep.stderr);
  assert.deepEqual(JSON.parse(rep.stdout).rows, []);
});

test("usage without the plugin configured explains how to enable it", () => {
  const { file } = setup({});
  const r = run(["usage", "--config", file]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"usage" is a bundled plugin that is not enabled/);
  assert.match(r.stderr, /"plugins": \{ "usage": \{\} \}/);
});

test("an unknown command is still unknown", () => {
  const { file } = setup({ plugins: { usage: {} } });
  for (const cmd of ["frobnicate", "../lib", "keys"]) {
    const r = run([cmd, "--config", file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command/);
  }
});

test("start refuses to run with a plugin that cannot load", () => {
  const { file } = setup({ port: 11496, plugins: { [path.join(ROOT, "missing-plugin.cjs")]: {} } });
  const r = run(["start", "--no-update", "--config", file]);
  try {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /plugin .* failed to load/);
  } finally {
    // If the start was not refused, a real server is now running: stop it.
    if (r.status === 0) run(["stop", "-p", "11496", "--config", file]);
  }
});

test("BARNOWL_PLUGINS env wins over the file", () => {
  const { file } = setup({ plugins: { usage: {} } });
  const out = run(["config", "--config", file], { BARNOWL_PLUGINS: '{"usage":{"requireKey":false}}' }).stdout;
  assert.deepEqual(JSON.parse(out.replace(/^.*\n/, "")).plugins, { usage: { requireKey: false } });
});
