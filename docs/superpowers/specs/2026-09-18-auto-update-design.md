# barnowl auto-update on start — design

Date: 2026-09-18 · Status: approved in chat

## Goal

Model lineups change (new ids, retired ids, per-model effort levels) and the
fix usually touches code as well as `config/models.json`. Those updates are
published to GitHub as PRs. A local barnowl installed as a git clone should
pick them up by itself: every `barnowl start` (and so `restart`) checks
`origin/main` and fast-forwards before the server launches.

Out of scope: producing the updates (still a PR, since probing needs personal
Claude/Codex logins), updating the `claude` / `codex` CLIs, npm-registry
installs, checking while the server is running.

## Components

### `lib/self-update.js`

`checkForUpdate(repoDir, { runInstall }) → result`

| status | when |
| --- | --- |
| `skipped` | no `.git` (npm install) · git missing · branch is not `main` · tracked files modified · no `origin` remote |
| `current` | `HEAD..origin/main` is empty (includes local-ahead) |
| `updated` | fast-forwarded; carries `from`, `to` (short shas), `commits`, `depsChanged`, and `installFailed` if the install step failed |
| `failed` | fetch failed/timed out (offline, auth) · `merge --ff-only` refused (diverged, untracked-file clash) |

Every result has a one-line `reason` for display. Steps:

1. `.git` present? else `skipped`.
2. `git rev-parse --abbrev-ref HEAD` must be `main`.
3. `git status --porcelain --untracked-files=no` must be empty.
4. `git fetch --quiet origin main` — 10 s timeout, `GIT_TERMINAL_PROMPT=0`.
5. `git rev-list --count HEAD..origin/main` — 0 → `current`.
6. `git diff --name-only HEAD origin/main` → `depsChanged` if it lists
   `package.json` or `package-lock.json`.
7. `git merge --ff-only --quiet origin/main`.
8. If `depsChanged`: `runInstall(repoDir)` (default: `npm install --no-audit
   --no-fund`, stdio inherited, `shell` on win32). A failure is reported, not
   fatal — the pulled code still starts.

Never throws; any unexpected error becomes `failed`.

### `bin/barnowl.js`

- Config key `autoUpdate` (default on) through the usual layers: flag
  `--no-update`, env `BARNOWL_AUTO_UPDATE`, config file `"autoUpdate"`.
  `0` / `false` / `no` / `off` disable it. Shown by `barnowl config` and help.
- `cmdStart`: first thing, when auto-update is on and no server is running,
  call `checkForUpdate(<repo root>)` and print one line:
  - `updated` → `Updated 737ac78 → a1b2c3d (3 commits)`, then re-run
    `barnowl start <same args>` in a child with `BARNOWL_AUTO_UPDATE=0` and
    inherited stdio, and return its exit code. The already-loaded old code
    therefore never launches the server; the new `ensurePatched()` applies
    any patch migrations.
  - `current` → silent.
  - `skipped` / `failed` → `Auto-update skipped: <reason>` and continue.

## Testing

`test/self-update.test.js` with `node:test` (`npm test`). Each case builds a
bare repo plus clones in a temp dir and injects a stub `runInstall`:
current · updated (from/to/commits) · depsChanged calls the stub · dirty tree
skipped · non-main branch skipped · no `.git` skipped · unreachable origin
failed · diverged history failed.

Manual: stale clone + `barnowl start -p <spare port>` shows the update line and
starts on the new code.
