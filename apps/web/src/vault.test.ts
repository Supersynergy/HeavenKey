import { test, expect } from "bun:test";
import { random, encode, decode, wrap, unwrap, seal, open } from "./vault";
test("vault rejects wrong key, changed account, wrong credential and modified ciphertext", async () => {
  const key = random(32), prf = random(32), salt = random(32);
  const wrapped = await wrap(key, prf, salt, "alice", "credential-a");
  expect(await unwrap(wrapped, prf, "alice", "credential-a")).toEqual(key);
  await expect(unwrap(wrapped, random(32), "alice", "credential-a")).rejects.toThrow();
  await expect(unwrap(wrapped, prf, "bob", "credential-a")).rejects.toThrow();
  await expect(unwrap(wrapped, prf, "alice", "credential-b")).rejects.toThrow();
  const record = await seal("Privater Beispieltext 🗝", key, "alice");
  expect(await open(record, key, "alice")).toBe("Privater Beispieltext 🗝");
  await expect(open(record, key, "bob")).rejects.toThrow();
  const bytes = decode(record.ciphertext); bytes[0] ^= 1;
  await expect(open({ ...record, ciphertext: encode(bytes) }, key, "alice")).rejects.toThrow();
  expect((await seal("same", key, "alice")).nonce).not.toBe((await seal("same", key, "alice")).nonce);
});
test("multiple independent passkeys and offline recovery wrap the same vault key", async () => {
  const key = random(32), first = random(32), second = random(32), recovery = random(32);
  const a = await wrap(key, first, random(32), "alice", "credential-a");
  const b = await wrap(key, second, random(32), "alice", "credential-b");
  const c = await wrap(key, recovery, random(32), "alice", "offline-recovery");
  expect(await unwrap(a, first, "alice", "credential-a")).toEqual(await unwrap(b, second, "alice", "credential-b"));
  expect(await unwrap(c, recovery, "alice", "offline-recovery")).toEqual(key);
  await expect(unwrap(a, second, "alice", "credential-a")).rejects.toThrow();
  expect(() => decode("invalid=")).toThrow();
});
