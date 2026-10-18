import { expect, test } from "bun:test";
import { decode64, openVault, sealVault, validateEnvelope, type Envelope } from "./passwords-crypto";

const master = "Synthetic independent cedar orbit 83!";
// Key from native libargon2 20190702_1, argon2id_hash_raw(3,65536,1,...,32), v19:
// d2d8f41b14a1a7d482c8e204b4dc1cb55b3133c9bf15c5b836dd30aa80a565ff
const reference: Envelope = {
  version: 2, kdf: "Argon2id", iterations: 3, memory_kib: 65536, parallelism: 1,
  salt: "AAECAwQFBgcICQoLDA0ODw", iv: "AAECAwQFBgcICQoL",
  ciphertext: "1OkTmQPkUhsr1HJpdjdne9NbnCzJJodjmwU7uxPr1AP474l-1TyLfOdO",
};
const empty = { version: 1 as const, entries: [] };

test("Argon2id v19 native reference vector decrypts and scheme is authenticated", async () => {
  const { vault, key } = await openVault(reference, master);
  expect(vault).toEqual(empty);
  expect(key.extractable).toBe(false);
  await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv: decode64(reference.iv, 12), additionalData: new TextEncoder().encode("HeavenKey password vault v1") }, key, decode64(reference.ciphertext, 100))).rejects.toThrow();
  const saved = await sealVault(vault, key, reference);
  expect(saved).toMatchObject({ version: 2, kdf: "Argon2id", iterations: 3, memory_kib: 65536, parallelism: 1, salt: reference.salt });
  expect(saved.iv).not.toBe(reference.iv);
  expect((await openVault(saved, master)).vault).toEqual(empty);
});

test("v2 rejects every unapproved cost, mixed scheme, missing or extra field", async () => {
  for (const field of ["iterations", "memory_kib", "parallelism"] as const) {
    for (const value of [0, -1, 1.5, "3", null, false, NaN, Infinity, 4_294_967_295]) {
      const malformed = { ...reference, [field]: value };
      expect(() => validateEnvelope(malformed)).toThrow("KDF-Parameter");
      await expect(openVault(malformed, master)).rejects.toThrow("KDF-Parameter");
    }
    const missing = { ...reference } as Record<string, unknown>;
    delete missing[field];
    expect(() => validateEnvelope(missing)).toThrow();
  }
  for (const malformed of [
    { ...reference, version: 1 }, { ...reference, kdf: "PBKDF2-SHA256" },
    { ...reference, version: 19 }, { ...reference, argon_version: 19 },
    { ...reference, iterations: 2 }, { ...reference, memory_kib: 32768 },
    { ...reference, parallelism: 2 },
  ]) expect(() => validateEnvelope(malformed)).toThrow();
  expect(validateEnvelope(reference)).toEqual(reference);
});

test("fixed legacy backup unlocks with old master and remains legacy on save", async () => {
  const backup: Envelope = {
    version: 1, kdf: "PBKDF2-SHA256", iterations: 600000,
    salt: reference.salt, iv: reference.iv,
    ciphertext: "-WKtPjyyMi-_-DfnrCpBhQPoZRXDGRjFfnyyE5e-MIe0ILyLZ-rhgWjW",
  };
  const opened = await openVault(JSON.parse(JSON.stringify(backup)), "12345678901234");
  expect(opened.vault).toEqual(empty);
  const saved = await sealVault(opened.vault, opened.key, opened.envelope);
  expect(saved.version).toBe(1);
  expect((await openVault(saved, "12345678901234")).vault).toEqual(empty);
});

test("Argon2 yields to host tasks, bounds its queue and recovers afterwards", async () => {
  let hostTaskRan = false;
  const timer = setTimeout(() => { hostTaskRan = true; }, 0);
  try {
    const pending = Array.from({ length: 3 }, () => openVault(reference, master));
    await expect(openVault(reference, master)).rejects.toThrow("gleichzeitige Entsperrversuche");
    const opened = await Promise.all(pending);
    expect(hostTaskRan).toBe(true);
    expect(opened.every(result => result.vault.entries.length === 0)).toBe(true);
    expect((await openVault(reference, master)).vault).toEqual(empty);
  } finally { clearTimeout(timer); }
});
