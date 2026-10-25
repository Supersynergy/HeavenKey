import { test, expect } from "bun:test";
import { emptySnapshot, mergeSnapshots, sealSnapshot, openSnapshot, openLinkedSnapshot } from "./passwords-sync-crypto";
import { createVault, openVault, validateVault } from "./passwords-crypto";
const entry = (id: string, password = "Synthetic-only-password-25") => ({ id, title: id, password, username: "test@example.test", url: "https://example.test", notes: "", totp: "", tags: [], favorite: false });
const snapshot = (...rows: ReturnType<typeof entry>[]) => ({ ...emptySnapshot(), entries: rows });
test("three-way sync carries additions, edits and deletions without resurrection", () => {
  const base = snapshot(entry("a"), entry("b"));
  const local = snapshot(entry("a", "Local-changed-value-25"));
  const remote = snapshot(entry("a"), entry("b"), entry("c"));
  expect(mergeSnapshots(base, local, remote)).toEqual(snapshot(entry("a", "Local-changed-value-25"), entry("c")));
  expect(mergeSnapshots(base, base, emptySnapshot())).toEqual(emptySnapshot());
});
test("simultaneous modification and edit/delete conflicts preserve both inputs", () => {
  const base = snapshot(entry("a")), local = snapshot(entry("a", "First-change-password")), remote = snapshot(entry("a", "Other-change-password"));
  const before = JSON.stringify([base, local, remote]);
  expect(() => mergeSnapshots(base, local, remote)).toThrow("konflikt");
  expect(() => mergeSnapshots(base, local, emptySnapshot())).toThrow("konflikt");
  expect(JSON.stringify([base, local, remote])).toBe(before);
});
test("ciphertext authenticates channel, revision, key and contents with fresh IV", async () => {
  const key = "A".repeat(43), id = "11111111-1111-4111-8111-111111111111", value = snapshot(entry("a"));
  const sealed = await sealSnapshot(value, key, id, 1);
  expect(JSON.stringify(sealed)).not.toContain(value.entries[0].password);
  expect(await openSnapshot(sealed, key, id, 1)).toEqual(value);
  expect((await sealSnapshot(value, key, id, 1)).iv).not.toBe(sealed.iv);
  await expect(openSnapshot(sealed, key, id, 2)).rejects.toThrow();
  await expect(openSnapshot(sealed, key, "22222222-2222-4222-8222-222222222222", 1)).rejects.toThrow();
  await expect(openSnapshot(sealed, "AQ" + "A".repeat(41), id, 1)).rejects.toThrow();
  await expect(openSnapshot({ ...sealed, ciphertext: (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1) }, key, id, 1)).rejects.toThrow();
});
test("desktop rejects an older authenticated relay snapshot after accepting a newer baseline", async () => {
  const key = "A".repeat(43), id = "11111111-1111-4111-8111-111111111111";
  const old = snapshot(entry("a", "Old-secret-before-change"));
  const record = await sealSnapshot(old, key, id, 1);
  expect(await openSnapshot(record, key, id, 1)).toEqual(old);
  const link = { id, key, revision: 5, baseline: snapshot(entry("a", "New-secret-after-change")) };
  await expect(openLinkedSnapshot(link, { revision: 1, record })).rejects.toThrow("älteren");
});
test("accepted revision floor survives encrypted desktop vault persistence", async () => {
  const master = "Synthetic-encrypted-sync-floor-25", id = "11111111-1111-4111-8111-111111111111";
  const link = { id, key: "A".repeat(43), revision: 5, baseline: emptySnapshot() };
  const created = await createVault(master, { version: 1, entries: [], mobile_sync: [link] });
  expect((await openVault(created.envelope, master)).vault.mobile_sync![0].revision).toBe(5);
  for (const revision of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateVault({ version: 1, entries: [], mobile_sync: [{...link, revision}] })).toThrow();
});
