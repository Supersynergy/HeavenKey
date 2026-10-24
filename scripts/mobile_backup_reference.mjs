import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(root, "docs/vectors/mobile-backup-v1.json"), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "heavenkey-mobile-backup-"));
const binary = join(scratch, "mobile-backup-test");
const aad = Buffer.from("HeavenKey/mobile-backup/v1");
const fields = ["id", "notes", "origin", "password", "title", "updatedAt", "username"];
let assertions = 0;

function run(command, args, input, timeout = 15_000) {
  const result = spawnSync(command, args, { input, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr.slice(0, 4000)}`);
  return result.stdout;
}

function swift(operation, values = {}) {
  return JSON.parse(run(binary, [], JSON.stringify({ operation, ...values })));
}

function fingerprint(entries) {
  const digest = createHash("sha256");
  const count = (value) => { const length = Buffer.alloc(4); length.writeUInt32BE(value); digest.update(length); };
  count(entries.length);
  for (const entry of [...entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    for (const field of fields) {
      const value = Buffer.from(entry[field], "utf8");
      count(value.length); digest.update(value);
    }
  }
  return digest.digest("hex");
}

async function key(value) {
  assert.match(value, /^hk1_[A-Za-z0-9_-]{43}$/);
  const bytes = Buffer.from(value.slice(4), "base64url");
  assert.equal(bytes.length, 32);
  assert.equal(bytes.toString("base64url"), value.slice(4));
  return webcrypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(entries, recoveryKey, nonce = webcrypto.getRandomValues(new Uint8Array(12)), authenticatedData = aad) {
  const plaintext = Buffer.isBuffer(entries) ? entries : Buffer.from(JSON.stringify(entries));
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: authenticatedData, tagLength: 128 }, await key(recoveryKey), plaintext);
  return JSON.stringify({ format: "heavenkey-mobile-backup", version: 1,
    iv: Buffer.from(nonce).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url") });
}

async function open(archive, recoveryKey) {
  const header = JSON.parse(archive);
  assert.deepEqual(Object.keys(header).sort(), ["ciphertext", "format", "iv", "version"]);
  assert.equal(header.format, "heavenkey-mobile-backup"); assert.equal(header.version, 1);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(header.iv, "base64url"),
    additionalData: aad, tagLength: 128 }, await key(recoveryKey), Buffer.from(header.ciphertext, "base64url"));
  return JSON.parse(Buffer.from(plaintext).toString("utf8"));
}

function rejected(archive, recoveryKey = fixture.recoveryKey, expected) {
  const response = swift("open", { archive, key: recoveryKey });
  assert.ok(response.error, "Swift accepted an invalid archive");
  if (expected) assert.equal(response.error, expected);
  assertions++;
}

try {
  run("/usr/bin/swiftc", ["-O", join(root, "apps/mobile/ios/Shared/VaultPolicy.swift"),
    join(root, "apps/mobile/ios/Shared/MobileBackup.swift"), join(root, "scripts/mobile_backup_test.swift"), "-o", binary], undefined, 60_000);
  assert.equal(fingerprint(fixture.entries), fixture.fingerprint); assertions++;
  assert.deepEqual(await open(fixture.archive, fixture.recoveryKey), fixture.entries); assertions++;
  assert.equal(await seal(fixture.entries, fixture.recoveryKey, Buffer.from(fixture.nonce, "base64url")), fixture.archive); assertions++;
  const fromFixture = swift("open", { archive: fixture.archive, key: fixture.recoveryKey });
  assert.deepEqual(fromFixture.entries, fixture.entries); assert.equal(fromFixture.fingerprint, fixture.fingerprint); assertions += 2;

  const generated = swift("newKey").key;
  assert.equal(swift("checkKey", { key: generated }).valid, true); assertions++;
  assert.notEqual(generated, swift("newKey").key); assertions++;
  const sealed = swift("seal", { entries: fixture.entries, key: generated });
  assert.deepEqual(await open(sealed.archive, generated), fixture.entries); assertions++;
  assert.equal(sealed.fingerprint, fixture.fingerprint); assertions++;
  const sealedAgain = swift("seal", { entries: fixture.entries, key: generated });
  assert.notEqual(JSON.parse(sealed.archive).iv, JSON.parse(sealedAgain.archive).iv); assertions++;
  assert.notEqual(JSON.parse(await seal(fixture.entries, generated)).iv, JSON.parse(await seal(fixture.entries, generated)).iv); assertions++;
  assert.ok(!sealed.archive.includes(generated)); assertions++;
  const jsArchive = await seal(fixture.entries, generated);
  assert.deepEqual(swift("open", { archive: jsArchive, key: generated }).entries, fixture.entries); assertions++;
  assert.equal(swift("fingerprint", { entries: [...fixture.entries].reverse() }).fingerprint, fixture.fingerprint); assertions++;
  const changed = structuredClone(fixture.entries); changed[0].notes += "!";
  assert.notEqual(swift("fingerprint", { entries: changed }).fingerprint, fixture.fingerprint); assertions++;
  const empty = swift("seal", { entries: [], key: generated });
  assert.deepEqual(await open(empty.archive, generated), []); assertions++;
  assert.deepEqual(swift("open", { archive: await seal([], generated), key: generated }).entries, []); assertions++;

  for (const badKey of ["", generated + "=", generated.slice(0, -1), generated.replace("hk1_", "hk2_"),
    "hk1_" + "A".repeat(42) + "B", "hk1_" + "+".repeat(43)]) {
    assert.equal(swift("checkKey", { key: badKey }).valid, false); assertions++;
    rejected(jsArchive, badKey, "invalid_key");
  }
  rejected(jsArchive, swift("newKey").key, "invalid_archive");
  const header = JSON.parse(jsArchive);
  const tampered = Buffer.from(header.ciphertext, "base64url"); tampered[tampered.length - 1] ^= 1;
  rejected(JSON.stringify({ ...header, ciphertext: tampered.toString("base64url") }), generated);
  const changedNonce = Buffer.from(header.iv, "base64url"); changedNonce[0] ^= 1;
  rejected(JSON.stringify({ ...header, iv: changedNonce.toString("base64url") }), generated);
  await assert.rejects(open(JSON.stringify({ ...header, ciphertext: tampered.toString("base64url") }), generated)); assertions++;
  await assert.rejects(open(sealed.archive, swift("newKey").key)); assertions++;
  rejected(await seal(fixture.entries, generated, undefined, Buffer.from("wrong-aad")), generated);
  for (const malformed of ["", "{", "[]", "null", JSON.stringify({ ...header, extra: true }),
    JSON.stringify({ ...header, version: true }), JSON.stringify({ ...header, version: "1" }),
    JSON.stringify({ ...header, version: 2 }), JSON.stringify({ ...header, format: "other" }),
    JSON.stringify({ ...header, iv: header.iv + "=" }), JSON.stringify({ ...header, iv: "AA" }),
    JSON.stringify({ ...header, ciphertext: "AA" }), JSON.stringify({ ...header, ciphertext: header.ciphertext + "=" }),
    JSON.stringify({ ...header, iv: undefined }), JSON.stringify(header).replace('"version":1', '"version":1.0')]) rejected(malformed, generated);
  for (const records of [[fixture.entries[0], fixture.entries[0]], Array.from({ length: 501 }, (_, i) => ({ ...fixture.entries[0], id: `entry_${i}` })),
    [{ ...fixture.entries[0], extra: "no" }], [{ ...fixture.entries[0], password: "" }],
    [{ ...fixture.entries[0], origin: "http://example.com" }], [{ ...fixture.entries[0], notes: "x".repeat(4097) }],
    [{ ...fixture.entries[0], title: 123 }]]) {
    rejected(await seal(records, generated), generated);
    assert.ok(swift("seal", { entries: records, key: generated }).error); assertions++;
  }
  rejected(await seal(Buffer.from("not JSON"), generated), generated);
  rejected(await seal(Buffer.alloc(16 * 1024 * 1024 + 1, 32), generated), generated);
  rejected(" ".repeat(24 * 1024 * 1024 + 1), generated, "too_large");
  const fullCount = Array.from({ length: 500 }, (_, i) => ({ ...fixture.entries[0], id: `entry_${i}` }));
  assert.deepEqual(await open(swift("seal", { entries: fullCount, key: generated }).archive, generated), fullCount); assertions++;
  const existing = { ...fixture.entries[0], password: "Synthetic-changed-password" };
  const incomingNew = { ...fixture.entries[0], id: "new_merge_entry" };
  assert.deepEqual(swift("merge", { current: [existing], incoming: [fixture.entries[0], incomingNew], replace: false }).entries,
    [existing, incomingNew]); assertions++;
  assert.deepEqual(swift("merge", { current: [existing], incoming: [fixture.entries[0], incomingNew], replace: true }).entries,
    [fixture.entries[0], incomingNew]); assertions++;
  assert.deepEqual(swift("merge", { current: [existing], incoming: [], replace: false }).entries, [existing]); assertions++;
  assert.equal(swift("merge", { current: fullCount, incoming: [incomingNew], replace: false }).error, "too_large"); assertions++;
  assert.equal(swift("merge", { current: [existing], incoming: [incomingNew, incomingNew], replace: false }).error, "invalid_archive"); assertions++;
  const longHost = [63, 63, 63, 61].map((length) => "a".repeat(length)).join(".");
  const oversized = fullCount.map((entry) => ({ ...entry, id: entry.id.padEnd(80, "x"), origin: `https://${longHost}:65535`,
    title: "\0".repeat(120), username: "\0".repeat(320), password: "\0".repeat(1024), notes: "\0".repeat(4096) }));
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 16 * 1024 * 1024); assertions++;
  assert.equal(swift("seal", { entries: oversized, key: generated }).error, "too_large"); assertions++;
  console.log(JSON.stringify({ ok: true, assertions, crypto: "WebCrypto ↔ compiled Swift CryptoKit",
    fixture: "docs/vectors/mobile-backup-v1.json", deviceRuntime: false }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
