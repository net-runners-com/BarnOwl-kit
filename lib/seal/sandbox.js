"use strict";
// OS-level containment for the one command a sealed turn is allowed to run.
//
// The firewall (lib/seal/firewall.js) is the control that stops the model from
// running a *different* command. This file is the answer to a different
// question: what happens if that control is not there?
//
// It can be absent. It rides on a source patch into otterly's engine.js, and a
// patch can silently fail to apply after an upstream refactor — barnowl has a
// kill-list patch in exactly that state today. So the worst case is not
// hypothetical: Bash is enabled for the sealed turn, nothing checks the
// command, and the model has been handed a shell. The severe item on that
// path is not a one-shot read, it is persistence — a recursive Bash call that
// writes a cron entry, appends to ~/.ssh/authorized_keys, or drops a launch
// agent. After that the attacker no longer needs the model.
//
// Two layers, independent failure modes:
//   firewall → the command cannot change      (strong, but patch-dependent)
//   sandbox  → the command cannot persist     (weaker, but needs no patch)
//
// What the policy denies: all network, all filesystem writes. That removes
// cron/launchd/authorized_keys writes, dropped payloads, and direct
// exfiltration. The decrypt itself needs none of it — it is arithmetic over
// constants already inlined in the command.
//
// What it does NOT deny, stated plainly: reads. A command that got through a
// broken firewall could still read a private key and print it to stdout, where
// it lands in the tool_result and can be coaxed into the model's answer.
// Closing that would mean enumerating every path python3 needs to start, which
// breaks on the next interpreter upgrade. Reads are bounded by the firewall;
// writes and network are bounded here. Neither layer alone is sufficient.

const fs = require("node:fs");

// Deny-by-default seatbelt policy. file-read* is granted because the
// interpreter cannot start without it (dyld, the stdlib, site-packages);
// everything that would let the command outlive the turn is denied.
const DARWIN_POLICY = [
  "(version 1)",
  "(deny default)",
  "(allow process-exec)",
  "(allow process-fork)",
  "(allow file-read*)",
  "(allow sysctl-read)",
  "(allow mach-lookup)",
  "(allow signal (target self))",
  "(deny network*)",
  "(deny file-write*)",
].join(" ");

const DARWIN_BIN = "/usr/bin/sandbox-exec";

/**
 * @param {string} [p] platform override (defaults to process.platform)
 * @returns {boolean}
 */
function sandboxAvailable(p = process.platform) {
  if (p === "darwin") return fs.existsSync(DARWIN_BIN);
  if (p === "linux") return fs.existsSync("/usr/bin/unshare") || fs.existsSync("/bin/unshare");
  return false;
}

/**
 * Resolve the containment mode.
 *   auto    — wrap when the platform supports it, run bare otherwise (default)
 *   require — refuse to build a sealed command without containment
 *   off     — never wrap
 * @param {string} [explicit]
 * @returns {"auto"|"require"|"off"}
 */
function sandboxMode(explicit) {
  const v = String(explicit ?? process.env.BARNOWL_SEAL_SANDBOX ?? "auto").toLowerCase();
  return v === "require" || v === "off" ? v : "auto";
}

/**
 * The shell prefix that contains the decrypt command, or "" for none.
 *
 * Note the prefix becomes part of the command the firewall pins, so a model
 * that drops it is denied — the containment cannot be shed by retyping.
 *
 * @param {{mode?: string, platform?: string}} [opts]
 * @returns {string}
 * @throws SEAL_NO_SANDBOX when mode is "require" and the platform has none
 */
function sandboxPrefix(opts = {}) {
  const mode = sandboxMode(opts.mode);
  if (mode === "off") return "";
  const platform = opts.platform || process.platform;
  if (!sandboxAvailable(platform)) {
    if (mode === "require") {
      const e = new Error(
        `seal: BARNOWL_SEAL_SANDBOX=require but no sandbox is available on ${platform}. ` +
        "Set it to auto to run the decrypt uncontained (the firewall still applies)."
      );
      e.code = "SEAL_NO_SANDBOX";
      throw e;
    }
    return "";
  }
  if (platform === "darwin") return `${DARWIN_BIN} -p '${DARWIN_POLICY}' `;
  // unshare -n gives a private, empty network namespace; -r maps the caller to
  // root inside it so no privilege is needed to create one.
  return "unshare -rn ";
}

module.exports = {
  sandboxAvailable,
  sandboxMode,
  sandboxPrefix,
  DARWIN_POLICY,
  DARWIN_BIN,
};
