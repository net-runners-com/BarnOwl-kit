# barnowl auto-update on start — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `barnowl start` fast-forwards a git-clone install to `origin/main` before launching, so model updates published on GitHub reach the local server by themselves.

**Architecture:** A self-contained `lib/self-update.js` does the git work and returns a status object (never throws). `bin/barnowl.js` calls it at the top of `cmdStart` when no server is running and re-runs `barnowl start` in a child after an update, so the server always launches from the pulled code.

**Tech Stack:** Node ≥18 CommonJS, `child_process.spawnSync` + system `git`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-18-auto-update-design.md`

## Global Constraints

- Tracked branch is `main` on remote `origin`; fast-forward only.
- Fetch timeout 10 s, `GIT_TERMINAL_PROMPT=0`.
- Dependency files: `package.json`, `package-lock.json` → `npm install --no-audit --no-fund` (`shell` on win32).
- Opt-out values `0` / `false` / `no` / `off` via `--no-update`, `BARNOWL_AUTO_UPDATE`, config `"autoUpdate"`.
- Installs without `.git` (npm registry) do nothing and print nothing.
- Commits end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

### Task 1: `lib/self-update.js` + tests

**Files:**
- Create: `lib/self-update.js`
- Create: `test/self-update.test.js`
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Produces: `checkForUpdate(repoDir: string, opts?: { runInstall?: (dir: string) => boolean }) → { status: "skipped"|"current"|"updated"|"failed", reason: string, from?: string, to?: string, commits?: number, depsChanged?: boolean, installFailed?: true }`

- [ ] **Step 1: Write the failing tests** — `test/self-update.test.js`

```js
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
```

- [ ] **Step 2: Add the test script** — in `package.json` `"scripts"`, add after `"verify"`:

```json
    "verify": "node bin/barnowl.js verify",
    "test": "node --test test/*.test.js"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/self-update.js'`

- [ ] **Step 4: Write `lib/self-update.js`**

```js
"use strict";
/**
 * Self-update for git-clone installs. Model lineups change often and the fix
 * usually touches code as well as config/models.json; those fixes land on
 * GitHub, and `barnowl start` fast-forwards the clone to origin/main before
 * launching so a local server follows them without a manual pull.
 *
 * checkForUpdate(repoDir, { runInstall }) never throws. It returns
 *   { status: "skipped" | "current" | "updated" | "failed", reason, ... }
 * where "updated" also carries from / to (short shas), commits, depsChanged,
 * and installFailed when the dependency install afterwards failed.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const BRANCH = "main";
const FETCH_TIMEOUT_MS = 10000;
const DEP_FILES = ["package.json", "package-lock.json"];

function git(repoDir, args, timeout) {
  const r = spawnSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const ok = !r.error && r.status === 0;
  const err = r.error ? r.error.code || r.error.message : (r.stderr || "").trim().split("\n")[0];
  return { ok, out: (r.stdout || "").trim(), err };
}

function npmInstall(repoDir) {
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: repoDir,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
  });
  return !r.error && r.status === 0;
}

function check(repoDir, runInstall) {
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    return { status: "skipped", reason: "not a git clone" };
  }
  const branch = git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return { status: "skipped", reason: `git unavailable (${branch.err})` };
  if (branch.out !== BRANCH) {
    return { status: "skipped", reason: `on branch '${branch.out}', not '${BRANCH}'` };
  }
  const dirty = git(repoDir, ["status", "--porcelain", "--untracked-files=no"]);
  if (!dirty.ok || dirty.out) return { status: "skipped", reason: "local changes to tracked files" };
  if (!git(repoDir, ["remote", "get-url", "origin"]).ok) {
    return { status: "skipped", reason: "no 'origin' remote" };
  }

  const fetched = git(repoDir, ["fetch", "--quiet", "origin", BRANCH], FETCH_TIMEOUT_MS);
  if (!fetched.ok) return { status: "failed", reason: `fetch failed (${fetched.err || "timeout"})` };
  const remote = `origin/${BRANCH}`;
  const commits = parseInt(git(repoDir, ["rev-list", "--count", `HEAD..${remote}`]).out, 10) || 0;
  if (commits === 0) return { status: "current", reason: "up to date" };

  const changed = git(repoDir, ["diff", "--name-only", "HEAD", remote]).out.split("\n");
  const depsChanged = changed.some((f) => DEP_FILES.includes(f));
  const from = git(repoDir, ["rev-parse", "--short", "HEAD"]).out;
  const merged = git(repoDir, ["merge", "--ff-only", "--quiet", remote]);
  if (!merged.ok) return { status: "failed", reason: `fast-forward refused (${merged.err})` };
  const to = git(repoDir, ["rev-parse", "--short", "HEAD"]).out;

  const result = { status: "updated", reason: `${commits} new commit(s)`, from, to, commits, depsChanged };
  if (depsChanged && !runInstall(repoDir)) result.installFailed = true;
  return result;
}

function checkForUpdate(repoDir, opts) {
  const runInstall = (opts && opts.runInstall) || npmInstall;
  try {
    return check(repoDir, runInstall);
  } catch (err) {
    return { status: "failed", reason: err.message };
  }
}

module.exports = { checkForUpdate };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: 10 tests, all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/self-update.js test/self-update.test.js package.json
git commit -m "Add self-update: fast-forward a git clone to origin/main"
```

---

### Task 2: wire into `barnowl start` + docs

**Files:**
- Modify: `bin/barnowl.js` (require block ~l.17, `BUILTIN` ~l.25, `parseFlags` ~l.60-106, `cmdStart` ~l.160, `cmdHelp`, `config` / `config init` in `main`)
- Modify: `README.md`, `README.ja.md` (Usage, config file, env var table)
- Modify: `docs/superpowers/specs/2026-09-18-auto-update-design.md` (no-`.git` is silent)

**Interfaces:**
- Consumes: `checkForUpdate(repoDir)` from Task 1.
- Produces: config key `autoUpdate` (boolean on the parsed config), flag `--no-update`, env `BARNOWL_AUTO_UPDATE`.

- [ ] **Step 1: Config plumbing** in `bin/barnowl.js`

```js
const { ensurePatched } = require("../lib/patch-otterly.js");
const { checkForUpdate } = require("../lib/self-update.js");
```

`BUILTIN` gains `autoUpdate: "true", // git-clone installs fast-forward to origin/main on start`.
`parseFlags`: flag `else if (a === "--no-update") flags.autoUpdate = "false";`, env `autoUpdate: process.env.BARNOWL_AUTO_UPDATE,`, output:

```js
    autoUpdate: !["0", "false", "no", "off"].includes(String(pick("autoUpdate")).toLowerCase()),
```

- [ ] **Step 2: Update check at the top of `cmdStart`** (right after `fs.mkdirSync(STATE_DIR, …)`)

```js
  // Follow GitHub: fast-forward this clone before launching. After an update
  // the code loaded in this process is stale, so the start re-runs in a child.
  const root = path.join(__dirname, "..");
  if (cfg.autoUpdate && fs.existsSync(path.join(root, ".git")) && !isAlive(readPid())) {
    const up = checkForUpdate(root);
    if (up.status === "updated") {
      console.log(`  Updated ${up.from} → ${up.to} (${up.commits} commit${up.commits === 1 ? "" : "s"})`);
      if (up.installFailed) console.error("  WARN: npm install failed after the update; run it in " + root);
      const r = spawnSync(process.execPath, [__filename, "start", ...argv], {
        stdio: "inherit",
        env: { ...process.env, BARNOWL_AUTO_UPDATE: "0" },
      });
      return r.status ?? 1;
    }
    if (up.status !== "current") console.log(`  Auto-update skipped: ${up.reason}`);
  }
```

- [ ] **Step 3: Surface it** — help: `barnowl start [-p <port>] [-d <dir>] [--mcp <profile>] [--config <file>] [--no-update]`, a line `Auto-update: git-clone installs fast-forward to origin/main on start (--no-update, BARNOWL_AUTO_UPDATE=0, "autoUpdate": false)`, and `BARNOWL_AUTO_UPDATE` in the Env list. `barnowl config` JSON gains `autoUpdate: cfg.autoUpdate`; `config init` starter gains `autoUpdate: true`.

- [ ] **Step 4: Docs** — README.md: Usage block line `barnowl start --no-update    # skip the GitHub update check`, config-file JSON gains `"autoUpdate": true` plus bullet `autoUpdate — git-clone installs fast-forward to origin/main on every start (only on a clean main; offline just warns). false disables.`, env table row `BARNOWL_AUTO_UPDATE | on | 0 skips the update check on start`. Same in README.ja.md. Spec: note that no `.git` prints nothing.

- [ ] **Step 5: Verify**

Run: `npm test` → all pass. `node bin/barnowl.js help` and `node bin/barnowl.js config --no-update` show the new option / `"autoUpdate": false`.

Manual end-to-end (temp HOME so the running :11435 server's PID file is untouched):

```bash
T=$(mktemp -d); git clone -q --bare . $T/origin.git
git -C $T/origin.git symbolic-ref HEAD refs/heads/main
git -C $T/origin.git update-ref refs/heads/main $(git rev-parse HEAD)
git clone -q -b main $T/origin.git $T/install && (cd $T/install && npm install --no-audit --no-fund >/dev/null)
git clone -q -b main $T/origin.git $T/author && (cd $T/author && echo >> README.md && git commit -qam bump && git push -q origin main)
(cd $T/install && HOME=$T node bin/barnowl.js start -p 11498)   # expect "Updated … (1 commit)" then "Started"
curl -s localhost:11498/v1/models | head -c 200; (cd $T/install && HOME=$T node bin/barnowl.js stop -p 11498)
(cd $T/install && HOME=$T node bin/barnowl.js start -p 11498)   # expect no update line
(cd $T/install && HOME=$T node bin/barnowl.js stop -p 11498)
```

- [ ] **Step 6: Commit**

```bash
git add bin/barnowl.js README.md README.ja.md docs/superpowers/specs/2026-09-18-auto-update-design.md
git commit -m "barnowl start: auto-update git-clone installs from GitHub"
```
