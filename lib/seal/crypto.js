"use strict";
// AES-256-GCM encrypt / decrypt for barnowl's "seal" feature.
// Format on the wire: a self-describing JSON envelope so Mode A (model-side
// decrypt via tool) and Mode B2 (barnowl-side decrypt) share one representation.
//
//   {
//     v: 1,                       // envelope version
//     alg: "AES-256-GCM",
//     iv:  <base64 12-byte IV>,
//     ct:  <base64 ciphertext || GCM-tag(16)>,
//     name?: original filename (hint only, NOT authenticated beyond GCM over ct)
//   }
//
// We append the 16-byte GCM auth tag to the ciphertext so decrypt doesn't need
// a separate `tag` field — matches how Python's `cryptography` AESGCM expects it.

const crypto = require("node:crypto");

const ALG = "aes-256-gcm";
const KEY_BYTES = 32;      // AES-256
const IV_BYTES = 12;       // GCM nonce
const TAG_BYTES = 16;      // GCM auth tag

/** @returns {Buffer} 32 random bytes suitable for an ephemeral session key. */
function newKey() {
  return crypto.randomBytes(KEY_BYTES);
}

/**
 * Encrypt a plaintext Buffer with a 32-byte key.
 * @param {Buffer} plaintext
 * @param {Buffer} key   32 bytes
 * @param {object} [opts]
 * @param {string} [opts.name] optional filename hint (stored in envelope)
 * @returns {{envelope: object, raw: Buffer}}
 *   envelope — JSON-safe object (ready to embed in request body)
 *   raw      — binary (iv || ct || tag), ready for file-upload API
 */
function encrypt(plaintext, key, opts = {}) {
  if (!Buffer.isBuffer(plaintext)) throw new TypeError("plaintext must be a Buffer");
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError(`key must be a ${KEY_BYTES}-byte Buffer`);
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ctWithTag = Buffer.concat([ct, tag]);
  const envelope = {
    v: 1,
    alg: "AES-256-GCM",
    iv: iv.toString("base64"),
    ct: ctWithTag.toString("base64"),
  };
  if (opts.name) envelope.name = String(opts.name);
  const raw = Buffer.concat([iv, ctWithTag]);
  return { envelope, raw };
}

/**
 * Decrypt an envelope back to plaintext.
 * @param {object} envelope — from encrypt().envelope
 * @param {Buffer} key — same 32 bytes used for encrypt
 * @returns {Buffer} plaintext
 * @throws if the auth tag check fails or the envelope is malformed.
 */
function decrypt(envelope, key) {
  if (!envelope || envelope.v !== 1 || envelope.alg !== "AES-256-GCM") {
    throw new Error("seal/crypto: unsupported envelope");
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError(`key must be a ${KEY_BYTES}-byte Buffer`);
  }
  const iv = Buffer.from(envelope.iv, "base64");
  if (iv.length !== IV_BYTES) throw new Error("seal/crypto: bad iv length");
  const ctWithTag = Buffer.from(envelope.ct, "base64");
  if (ctWithTag.length < TAG_BYTES) throw new Error("seal/crypto: ct too short");
  const ct = ctWithTag.subarray(0, ctWithTag.length - TAG_BYTES);
  const tag = ctWithTag.subarray(ctWithTag.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Decrypt the (iv || ct || tag) raw binary form instead of the envelope.
 * Used for files uploaded as attachments without a JSON wrapper.
 */
function decryptRaw(raw, key) {
  if (!Buffer.isBuffer(raw) || raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error("seal/crypto: raw buffer too short");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const ctWithTag = raw.subarray(IV_BYTES);
  return decrypt(
    { v: 1, alg: "AES-256-GCM", iv: iv.toString("base64"), ct: ctWithTag.toString("base64") },
    key
  );
}

module.exports = { newKey, encrypt, decrypt, decryptRaw, KEY_BYTES, IV_BYTES, TAG_BYTES };
