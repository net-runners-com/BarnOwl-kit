"use strict";
/**
 * Image generation for Codex models — OpenAI Images API compatible.
 *
 * Handles POST /v1/images/generations (wired into otterly's server/index.js by
 * patch-otterly.js). Generation is routed through the vendored
 * vendor/codex-image script (github.com/Leon-llb/codex-image), which drives
 * Codex CLI's built-in image_generation tool and harvests the produced file
 * straight from ~/.codex/generated_images — more reliable than asking the
 * agent to copy files itself, and it supports reference-image editing.
 *
 * The vendored copy carries small barnowl extensions: --model / --quality
 * passthrough and a general-purpose prompt template (upstream's was
 * infographic-only).
 *
 * Only Codex (gpt-*) models can generate images — Claude models are rejected
 * with a 400. `model: "codex"` uses the Codex CLI default model.
 *
 * Request body (OpenAI Images API subset + extensions):
 *   prompt   (required)  image description
 *   model    (optional)  codex | gpt-5.6-sol | ... (":<effort>" suffix stripped)
 *   n        (optional)  1-4 images (default 1; generated sequentially — the
 *                        generated_images diff is racy under parallelism)
 *   size     (optional)  e.g. "1024x1024" | "1536x1024" | "1024x1536"
 *   quality  (optional)  "standard" | "hd"
 *   image    (optional, non-standard)  local path to a reference image to edit
 *
 * Ground truth (probed from codex 0.144.4): the image_generation tool itself
 * only takes { prompt, num_last_images_to_include, referenced_image_paths } —
 * size/quality/style have NO tool parameters and are steered via prompt text.
 * Empirically: no size hint → 1254x1254; "Image size 1536x1024" in the prompt
 * → exactly 1536x1024. "hd"/detail hints roughly double render time
 * (~2.5 min standard square → ~5-6 min HD landscape).
 *
 * Response: { created, data: [{ b64_json, path }] } — `path` (non-standard) is
 * the file saved under ~/.barnowl/images/ for direct access.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CODEX_BIN, isCodexModel, mapModel } = require("./codex-engine.cjs");

const IMAGES_DIR = path.join(os.homedir(), ".barnowl", "images");
const GENERATE_PY = path.join(__dirname, "..", "vendor", "codex-image", "generate.py");

const EXTRA_PATHS = [
  path.join(os.homedir(), ".superset", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function childEnv() {
  const env = { ...process.env };
  const extra = EXTRA_PATHS.join(":");
  env.PATH = env.PATH ? env.PATH + ":" + extra : extra;
  env.CODEX_BIN = CODEX_BIN; // generate.py defaults to Codex.app; use the CLI
  return env;
}

function errorBody(status, message) {
  return {
    error: {
      message,
      type: status === 400 ? "invalid_request_error" : "server_error",
      code: status,
    },
  };
}

/** Run one generate.py invocation. Resolves { file } (path under IMAGES_DIR). */
function runGenerateScript({ prompt, model, size, quality, image, signal }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    const args = [GENERATE_PY, prompt, size || "1024x1024", IMAGES_DIR];
    const m = mapModel(model);
    if (m) args.push("--model", m);
    if (quality) args.push("--quality", quality);
    if (image) args.push("--image", image);

    // HD / non-square images can take ~5-6 min to render; give them 10.
    const timeoutMs =
      parseInt(process.env.BARNOWL_IMAGE_TIMEOUT_MS || "", 10) || 600000;

    let stdout = "";
    let stderr = "";
    let aborted = false;
    // detached → own process group, so kill(-pid) reaps the python → codex
    // wrapper → codex chain (killing only python leaves codex orphaned).
    const child = spawn("python3", args, {
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const kill = () => {
      try { process.kill(-child.pid, "SIGTERM"); } catch (_) {}
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch (_) {} }, 3000).unref();
    };
    const onAbort = () => { aborted = true; kill(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const killTimer = setTimeout(() => { aborted = true; kill(); }, timeoutMs);

    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) return reject(new Error("Aborted"));
      const ok = /SUCCESS:(.*)/.exec(stdout);
      if (code === 0 && ok && fs.existsSync(ok[1].trim())) {
        return resolve({ file: ok[1].trim() });
      }
      const detail = (stdout + "\n" + stderr).trim().slice(-500);
      reject(new Error(`codex-image generation failed (exit ${code})${detail ? ": " + detail : ""}`));
    });
  });
}

// generate.py attributes output by diffing ~/.codex/generated_images before and
// after the run, so two concurrent runs would claim each other's files. All
// generations (across requests too) go through this in-process queue.
let genQueue = Promise.resolve();
function enqueueGenerate(params) {
  const run = genQueue.then(() => runGenerateScript(params));
  genQueue = run.catch(() => {});
  return run;
}

/** Handle POST /v1/images/generations (OpenAI Images API shape). */
async function handleImages(req, res) {
  const body = req.body || {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(errorBody(400, "prompt is required")));
    return;
  }

  // Strip a ":<effort>" suffix (chat-side convention) — unused for images.
  let model = String(body.model || "codex");
  const i = model.lastIndexOf(":");
  if (i > 0) model = model.slice(0, i);

  if (!isCodexModel(model)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        errorBody(
          400,
          `model '${model}' cannot generate images — use a Codex model ` +
            "(codex, gpt-5.6-sol, gpt-5.6-terra, ...)"
        )
      )
    );
    return;
  }

  const n = Math.min(Math.max(parseInt(body.n, 10) || 1, 1), 4);
  const size = typeof body.size === "string" ? body.size : null;
  const quality = typeof body.quality === "string" ? body.quality : null;
  const image = typeof body.image === "string" ? body.image : null;
  if (image && !fs.existsSync(image)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(errorBody(400, `reference image not found: ${image}`)));
    return;
  }

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());
  if (req.timeoutSignal) {
    req.timeoutSignal.addEventListener("abort", () => abortController.abort());
  }

  try {
    const data = [];
    for (let k = 0; k < n; k++) {
      const { file } = await enqueueGenerate({
        prompt, model, size, quality, image,
        signal: abortController.signal,
      });
      data.push({
        b64_json: fs.readFileSync(file).toString("base64"),
        path: file,
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data }));
  } catch (err) {
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    const status = /Aborted/.test(String(err && err.message)) ? 499 : 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(errorBody(status, String((err && err.message) || err))));
  }
}

module.exports = { handleImages };
