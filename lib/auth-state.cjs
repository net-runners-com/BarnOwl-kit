"use strict";
/**
 * Server-side view of the model catalog, loaded into otterly by patch-otterly.
 *
 * bind(MODELS) keeps otterly's discovery array (served by /v1/models and
 * /api/tags) in step with <state dir>/catalog.json — mutating it in place, so
 * no other otterly code has to change. The engines report auth outcomes:
 * onAuthFailure hides a provider whose login died, onAuthSuccess brings it
 * back (also covers a login fixed outside barnowl, e.g. in Claude Code).
 */
const fs = require("fs");
const catalog = require("./model-catalog.cjs");

const state = { models: null, statics: null, current: null, file: null };

function providerOf(id) {
  // Lazy: codex-engine requires this module.
  return require("./codex-engine.cjs").isCodexModel(id) ? "codex" : "claude";
}

function fileOf() {
  return state.file || catalog.catalogPath();
}

function apply() {
  const out = [];
  for (const p of catalog.PROVIDERS) {
    const entry = state.current && state.current.providers[p];
    if (!entry) {
      out.push(...state.statics[p]);
      continue;
    }
    if (catalog.HIDDEN.has(entry.status)) continue;
    out.push(...(Array.isArray(entry.models) && entry.models.length ? entry.models : state.statics[p]));
  }
  state.models.splice(0, state.models.length, ...out);
}

function reload() {
  state.current = catalog.readCatalog(state.file);
  apply();
}

function bind(models, { file = catalog.catalogPath(), watch = true } = {}) {
  state.models = models;
  state.file = file;
  state.statics = { claude: [], codex: [] };
  for (const m of models) state.statics[providerOf(m.id)].push(m);
  reload();
  if (watch) fs.watchFile(file, { interval: 2000, persistent: false }, reload);
  return models;
}

function statusOf(provider) {
  const current = state.models ? state.current : catalog.readCatalog(fileOf());
  const entry = current && current.providers[provider];
  return entry ? entry.status : null;
}

function onAuthFailure(provider, message) {
  if (statusOf(provider) === "revoked") return false;
  const changed = catalog.markStatus(provider, "revoked", String(message || "").slice(0, 500), fileOf());
  if (state.models) reload();
  return changed;
}

function onAuthSuccess(provider) {
  const status = statusOf(provider);
  if (status !== "revoked" && status !== "logged_out") return false;
  const changed = catalog.markStatus(provider, "ok", "", fileOf());
  if (state.models) reload();
  return changed;
}

function _reset() {
  if (state.file) fs.unwatchFile(state.file);
  state.models = state.statics = state.current = state.file = null;
}

module.exports = { bind, onAuthFailure, onAuthSuccess, statusOf, _reset };
