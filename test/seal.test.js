"use strict";
// Smoke tests for lib/seal/{crypto,keystore}. Node's built-in test runner.
const test = require("node:test");
const assert = require("node:assert/strict");
const { newKey, encrypt, decrypt, decryptRaw, KEY_BYTES, IV_BYTES } = require("../lib/seal/crypto.js");
const { KeyStore } = require("../lib/seal/keystore.js");

test("crypto: round-trip via envelope", () => {
  const key = newKey();
  assert.equal(key.length, KEY_BYTES);
  const pt = Buffer.from("ふむふむ、暗号文に化けるね。");
  const { envelope, raw } = encrypt(pt, key, { name: "note.txt" });
  assert.equal(envelope.v, 1);
  assert.equal(envelope.alg, "AES-256-GCM");
  assert.equal(envelope.name, "note.txt");
  // IV in envelope should be 12 raw bytes once decoded.
  assert.equal(Buffer.from(envelope.iv, "base64").length, IV_BYTES);
  const roundTrip = decrypt(envelope, key);
  assert.deepEqual(roundTrip, pt);
  // raw form carries same iv then ct+tag, decryptable too
  const roundTripRaw = decryptRaw(raw, key);
  assert.deepEqual(roundTripRaw, pt);
});

test("crypto: tampered ciphertext fails auth", () => {
  const key = newKey();
  const { envelope } = encrypt(Buffer.from("abc"), key);
  // flip one byte of ciphertext
  const ct = Buffer.from(envelope.ct, "base64");
  ct[0] ^= 0xff;
  envelope.ct = ct.toString("base64");
  assert.throws(() => decrypt(envelope, key));
});

test("crypto: wrong key fails auth", () => {
  const { envelope } = encrypt(Buffer.from("abc"), newKey());
  assert.throws(() => decrypt(envelope, newKey()));
});

test("crypto: rejects bad key length", () => {
  assert.throws(() => encrypt(Buffer.from("x"), Buffer.alloc(10)));
});

test("keystore: mints once, reuses on second get", () => {
  const ks = new KeyStore();
  const k1 = ks.getOrCreate("sess-A");
  const k2 = ks.getOrCreate("sess-A");
  assert.equal(k1, k2);                       // same Buffer reference
  const kB = ks.getOrCreate("sess-B");
  assert.notDeepEqual(k1, kB);                // different session → different key
});

test("keystore: ttl eviction", () => {
  let t = 0;
  const ks = new KeyStore({ ttlMs: 1000, maxLifeMs: 60_000, now: () => t });
  const k1 = ks.getOrCreate("s");
  assert.equal(ks.size(), 1);
  t = 2000;                                   // past ttl, nothing touched since
  assert.equal(ks.size(), 0);
  const k2 = ks.getOrCreate("s");             // fresh key after eviction
  assert.notDeepEqual(k1, k2);
});

test("keystore: absolute lifetime cap", () => {
  let t = 0;
  const ks = new KeyStore({ ttlMs: 1_000_000, maxLifeMs: 1000, now: () => t });
  const k1 = ks.getOrCreate("s");
  for (let i = 0; i < 10; i++) { t += 100; ks.getOrCreate("s"); }   // keep touching
  t = 1500;                                   // past maxLife
  const k2 = ks.getOrCreate("s");
  assert.notDeepEqual(k1, k2);                // forced rotation
});

test("keystore: drop zeros the key", () => {
  const ks = new KeyStore();
  const k = ks.getOrCreate("s");
  const copy = Buffer.from(k);
  ks.drop("s");
  assert.notDeepEqual(copy, k);               // original buffer was zeroed in-place
  assert.ok(k.every((b) => b === 0));
});
