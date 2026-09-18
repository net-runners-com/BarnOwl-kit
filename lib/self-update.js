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
