import { describe, test, expect } from "bun:test";
import { createVault, openVault, sealVault, encode64, decode64, freshBytes, validateEnvelope, validateVault, generatePassword, parseCsv, totp, type Vault } from "./passwords-crypto";
const sample: Vault = { version: 1, entries: [{ id: "synthetic-1", title: "Beispiel 🗝", username: "demo@example.invalid", password: "synthetic-only-123", url: "https://example.invalid", notes: "Nur Test", totp: "", tags: ["Test"], favorite: true }] };
describe("authenticated encrypted password vault", () => {
  test("roundtrip, nonextractable key, fresh IV and salt", async () => {
    const first = await createVault("synthetic master password", sample);
    expect(first.envelope.version).toBe(2);
    expect(first.key.extractable).toBe(false);
    expect((await openVault(first.envelope, "synthetic master password")).vault).toEqual(sample);
    const saved = await sealVault(sample, first.key, first.envelope);
    expect(saved.iv).not.toBe(first.envelope.iv);
    expect((await openVault(saved, "synthetic master password")).vault).toEqual(sample);
    expect((await createVault("synthetic master password", sample)).envelope.salt).not.toBe(first.envelope.salt);
    await expect(crypto.subtle.exportKey("raw", first.key)).rejects.toThrow();
  });
  test("wrong master and modifications fail authentication", async () => {
    const { envelope } = await createVault("synthetic master password", sample);
    await expect(openVault(envelope, "another synthetic password")).rejects.toThrow();
    for (const field of ["ciphertext", "iv", "salt"] as const) {
      const bytes = decode64(envelope[field], 1_000_016); bytes[0] ^= 1;
      await expect(openVault({ ...envelope, [field]: encode64(bytes) }, "synthetic master password")).rejects.toThrow();
    }
  });
  test("strict envelope bounds reject before key derivation", async () => {
    const { envelope } = await createVault("synthetic master password");
    for (const value of [{ ...envelope, iterations: 1 }, { ...envelope, iterations: 900_000_000 }, { ...envelope, salt: encode64(freshBytes(15)) }, { ...envelope, iv: encode64(freshBytes(13)) }, { ...envelope, version: 3 }, { ...envelope, extra: true }, { ...envelope, ciphertext: "a".repeat(1_333_356) }]) expect(() => validateEnvelope(value)).toThrow();
    for (const value of ["AA=", "AB", "A", "AA+", "AA/", ""]) expect(() => decode64(value, 12)).toThrow();
    expect(encode64(decode64("AA", 1))).toBe("AA");
    await expect(createVault("too short")).rejects.toThrow();
    await expect(createVault("a".repeat(1025))).rejects.toThrow();
  });
  test("entry and plaintext bounds", () => {
    expect(() => validateVault({ version: 1, entries: [...sample.entries, ...sample.entries] })).toThrow();
    expect(() => validateVault({ version: 1, entries: [{ ...sample.entries[0], url: "javascript:alert(1)" }] })).toThrow();
    expect(() => validateVault({ version: 1, entries: [{ ...sample.entries[0], totp: "bad" }] })).toThrow();
    expect(() => validateVault({ version: 1, entries: Array.from({ length: 1001 }, (_, i) => ({ ...sample.entries[0], id: String(i) })) })).toThrow();
  });
});
test("password generator length, alphabet and invalid arguments", () => {
  for (let i = 0; i < 100; i++) { const password = generatePassword(24, "ABC012!"); expect(password).toHaveLength(24); expect(password).toMatch(/^[ABC012!]+$/); }
  expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20);
  for (const n of [0, 13, 129, 14.5, NaN]) expect(() => generatePassword(n)).toThrow();
  for (const a of ["", "a", "aba", "😀ab"]) expect(() => generatePassword(24, a)).toThrow();
});
const base32 = (text: string) => { let result = "", bits = 0, value = 0; for (const char of new TextEncoder().encode(text)) { value = (value << 8) | char; bits += 8; while (bits >= 5) { bits -= 5; result += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(value >>> bits) & 31]; } } if (bits) result += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(value << (5 - bits)) & 31]; return result; };
test("RFC6238 appendix B vectors for SHA1/SHA256/SHA512", async () => {
  const vectors = [ [59, "94287082", "46119246", "90693936"], [1111111109, "07081804", "68084774", "25091201"], [1111111111, "14050471", "67062674", "99943326"], [1234567890, "89005924", "91819424", "93441116"], [2000000000, "69279037", "90698825", "38618901"], [20000000000, "65353130", "77737706", "47863826"] ] as const;
  const secrets = ["12345678901234567890", "12345678901234567890123456789012", "1234567890123456789012345678901234567890123456789012345678901234"];
  for (const vector of vectors) for (let i = 0; i < 3; i++) { const uri = `otpauth://totp/Test?secret=${base32(secrets[i])}&algorithm=${["SHA1", "SHA256", "SHA512"][i]}&digits=8`; expect((await totp(uri, vector[0] * 1000)).code).toBe(vector[i + 1]); }
  expect((await totp(base32(secrets[0]), 59000)).code).toBe("287082");
  await expect(totp("bad")).rejects.toThrow();
  await expect(totp(`otpauth://hotp/Test?secret=${base32(secrets[0])}`)).rejects.toThrow();
});
test("CSV Bitwarden and Enpass quoted fields, multiline notes and aliases", () => {
  const bitwarden = 'folder,favorite,type,name,notes,login_uri,login_username,login_password,login_totp\r\nWork,1,login,"Demo, one","line 1\nline ""2""",https://example.invalid,demo,synthetic,\r\n';
  const [entry] = parseCsv(bitwarden);
  expect(entry.title).toBe("Demo, one"); expect(entry.notes).toBe('line 1\nline "2"'); expect(entry.tags).toEqual(["Work"]); expect(entry.favorite).toBe(true);
  const [enpass] = parseCsv('Title,Username,Password,URL,Notes,Tags\nDemo,demo,synthetic,https://example.invalid,note,"work;test"');
  expect(enpass.tags).toEqual(["work", "test"]);
});
test("CSV invalid final row fails whole import and bounds hold", () => {
  for (const csv of ['title,password\nValid,synthetic\nInvalid,too,many', 'title,password\nDemo,"unclosed', 'title,password\nDemo,"closed"junk', 'title,title,password\nA,B,C', 'name,password,type\nCard,test,card', 'title,password,url\nDemo,test,javascript:evil()', 'title,password\n,synthetic', 'title,password\n' + 'x'.repeat(2_000_001)]) expect(() => parseCsv(csv)).toThrow();
});
