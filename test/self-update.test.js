"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { checkForUpdate } = require("../lib/self-update.js");

// Isolate from the developer's git config (signing, hooks, default branch).
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1",
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(repo, file, content) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", `edit ${file}`);
}

/** Bare origin, an "author" clone that publishes, and the "install" under test. */
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const author = path.join(root, "author");
  const install = path.join(root, "install");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, author);
  git(author, "symbolic-ref", "HEAD", "refs/heads/main");
  commitFile(author, "README.md", "v1\n");
  git(author, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, install);
  const publish = (file, content) => {
    commitFile(author, file, content);
    git(author, "push", "-q", "origin", "main");
  };
  return { root, author, install, publish };
}

const noInstall = () => { throw new Error("install should not run"); };

test("current when origin/main has nothing new", (t) => {
  const { install } = setup(t);
  assert.equal(checkForUpdate(install, { runInstall: noInstall }).status, "current");
});

test("fast-forwards and reports from/to/commits", (t) => {
  const { author, install, publish } = setup(t);
  const from = git(install, "rev-parse", "--short", "HEAD");
  publish("a.txt", "a\n");
  publish("b.txt", "b\n");
  const r = checkForUpdate(install, { runInstall: noInstall });
  assert.equal(r.status, "updated");
  assert.equal(r.commits, 2);
  assert.equal(r.from, from);
  assert.equal(r.to, git(author, "rev-parse", "--short", "HEAD"));
  assert.equal(r.depsChanged, false);
  assert.ok(fs.existsSync(path.join(install, "b.txt")));
});

test("runs install when package.json changed", (t) => {
  const { install, publish } = setup(t);
  publish("package.json", "{}\n");
  const calls = [];
  const r = checkForUpdate(install, { runInstall: (dir) => { calls.push(dir); return true; } });
  assert.equal(r.status, "updated");
  assert.equal(r.depsChanged, true);
  assert.deepEqual(calls, [install]);
  assert.equal(r.installFailed, undefined);
});

test("flags a failed install but still counts as updated", (t) => {
  const { install, publish } = setup(t);
  publish("package-lock.json", "{}\n");
  const r = checkForUpdate(install, { runInstall: () => false });
  assert.equal(r.status, "updated");
  assert.equal(r.installFailed, true);
});

test("skips when tracked files are modified", (t) => {
  const { install, publish } = setup(t);
  publish("a.txt", "a\n");
  fs.writeFileSync(path.join(install, "README.md"), "local edit\n");
  const r = checkForUpdate(install, { runInstall: noInstall });
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /local changes/);
});

test("untracked files do not block an update", (t) => {
  const { install, publish } = setup(t);
  publish("a.txt", "a\n");
  fs.writeFileSync(path.join(install, "scratch.txt"), "x\n");
  assert.equal(checkForUpdate(install, { runInstall: noInstall }).status, "updated");
});

test("skips when not on main", (t) => {
  const { install, publish } = setup(t);
  publish("a.txt", "a\n");
  git(install, "checkout", "-q", "-b", "feature");
  const r = checkForUpdate(install, { runInstall: noInstall });
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /'feature'/);
});

test("skips a directory that is not a git clone", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-nogit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = checkForUpdate(dir, { runInstall: noInstall });
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /not a git clone/);
});

test("fails softly when origin is unreachable", (t) => {
  const { root, install } = setup(t);
  git(install, "remote", "set-url", "origin", path.join(root, "missing.git"));
  const r = checkForUpdate(install, { runInstall: noInstall });
  assert.equal(r.status, "failed");
  assert.match(r.reason, /fetch failed/);
});

test("fails softly when local main has diverged", (t) => {
  const { install, publish } = setup(t);
  publish("a.txt", "a\n");
  commitFile(install, "local.txt", "mine\n");
  const r = checkForUpdate(install, { runInstall: noInstall });
  assert.equal(r.status, "failed");
  assert.match(r.reason, /fast-forward/);
});
