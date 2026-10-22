import { expect, test } from "bun:test";
import { validateVault } from "./passwords-crypto";
import { createVault, openVault } from "./passwords-crypto";
import { generateTransferKey, sealTransferProfile } from "./passwords-transfer";
import { checkedSSHIdentity, removeSSHIdentity, resolveSSHProfile, sshFingerprint, validateSSHIdentities } from "../../../packages/transfers/ssh";
import { previewConnection } from "../../../packages/transfers/smart-connection";
import { validateTransferProfile } from "../../../packages/transfers/schema";
import { Window } from "happy-dom";
import { initSSHStorage } from "./passwords-ssh";

const pair = await generateTransferKey();
const identity = await checkedSSHIdentity("Deployment", pair.private_key, pair.public_key);
const profile = { id: crypto.randomUUID(), label: "Deployment", provider: "custom", protocol: "sftp" as const, host: "files.example.com", port: 22, username: "deploy", root: "/", host_key: "SHA256:" + "A".repeat(43), password: "", private_key: "", public_key: "", ssh_key_id: identity.id };

test("vault rejects malformed encrypted SSH identity collections", () => {
  expect(() => validateVault({ version: 1, entries: [], ssh_keys: [{ id: "broken" }] })).toThrow();
});

test("SSH pair is verified, fingerprinted, and deduplicated independently of label", async () => {
  expect(sshFingerprint(identity.public_key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  const duplicate = await checkedSSHIdentity("Another label", pair.private_key, pair.public_key + " user@mac");
  expect(() => validateSSHIdentities([identity, duplicate])).toThrow("bereits");
  const other = await generateTransferKey();
  await expect(checkedSSHIdentity("Mismatch", pair.private_key, other.public_key)).rejects.toThrow("passen nicht");
  await expect(checkedSSHIdentity("Multiple", pair.private_key, pair.public_key + "\n" + other.public_key)).rejects.toThrow();
  await expect(checkedSSHIdentity("OpenSSH", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----", pair.public_key)).rejects.toThrow();
});

test("encrypted backup retains SSH references and refuses orphaned or malformed identities", async () => {
  const vault = { version: 1 as const, entries: [], ssh_keys: [identity], transfers: [profile] };
  const created = await createVault("Synthetic-SSH-storage-only!42", vault);
  expect(JSON.stringify(created.envelope)).not.toContain(identity.private_key);
  const restored = await openVault(created.envelope, "Synthetic-SSH-storage-only!42");
  expect(restored.vault.ssh_keys?.[0].public_key).toBe(identity.public_key);
  expect(restored.vault.transfers?.[0].ssh_key_id).toBe(identity.id);
  expect(() => validateVault({ ...vault, ssh_keys: [] })).toThrow("fehlt");
  expect(() => validateVault({ ...vault, ssh_keys: [{ ...identity, public_key: "ssh-ed25519 AAAA" }] })).toThrow();
});

test("only owner-resolved key material enters the existing transfer wire format", async () => {
  const resolved = resolveSSHProfile(profile, [identity]);
  expect(resolved.private_key).toBe(identity.private_key);
  expect(resolved.public_key).toBe(identity.public_key);
  expect(resolved).not.toHaveProperty("ssh_key_id");
  expect(() => resolveSSHProfile(profile, [])).toThrow("fehlt");
  expect(() => validateTransferProfile({ ...profile, password: "ambiguous" })).toThrow();
  const request = { id: "synthetic", client_id: "synthetic", label: "synthetic", connection_id: profile.id, operation: "get" as const, path: "test.txt", sha256: "", bytes: 0, status: "pending", expires_at: Math.floor(Date.now() / 1000) + 60 };
  await expect(sealTransferProfile(profile, request, "unused", 1, 1, true)).rejects.toThrow("auflösen");
  expect(() => removeSSHIdentity(identity.id, [identity], [profile])).toThrow("verwendet");
  expect(removeSSHIdentity(identity.id, [identity], [])).toEqual([]);
});

test("connection preview extracts fields without interpreting shell commands or importing credentials", () => {
  expect(previewConnection("ssh deploy@files.example.com -p 2222")).toMatchObject({ username: "deploy", host: "files.example.com", protocol: "sftp", port: 2222 });
  expect(previewConnection("ftpes://hosting_test@files.example.com:21")).toMatchObject({ username: "hosting_test", protocol: "ftpes", port: 21 });
  expect(previewConnection("sftp://deploy@[::1]:22").host).toBe("[::1]");
  for (const input of ["ftp://example.com", "sftp://deploy:secret@example.com", "ssh deploy@example.com -oProxyCommand=evil", "ssh deploy@example.com;rm", "sftp://example.com/../private", "sftp://example.com/#secret", "sftp://example.com?password=secret", "example.com\nother", "sftp://example.com:0"]) expect(() => previewConnection(input)).toThrow();
});

test("unused SSH removal requires explicit confirmation and cancellation preserves the identity", async () => {
  const win = new Window({ url: "http://localhost/passwords" });
  Object.assign(globalThis, { window: win, document: win.document, MutationObserver: win.MutationObserver });
  win.document.body.innerHTML = '<section id="settings-view"></section>';
  let keys = [identity], saves = 0;
  const ctx: any = { get: () => ({ vault: { version: 1, entries: [] }, discreet: false }), current: () => true, unlocked: () => true, run: async (fn: any) => fn(1), announce: () => {} };
  const ui = initSSHStorage(ctx, { getKeys: () => keys, getProfiles: () => [], save: async value => { keys = value; saves++; } }, async () => pair);
  ui.refresh();
  win.document.querySelector<HTMLButtonElement>('[data-ssh-id] button:last-child')!.click();
  expect(saves).toBe(0);
  expect(win.document.querySelector<HTMLDialogElement>("#ssh-delete-dialog")!.open).toBe(true);
  expect(win.document.activeElement).toBe(win.document.querySelector("#ssh-delete-dialog [data-cancel]"));
  win.document.querySelector<HTMLButtonElement>("#ssh-delete-dialog [data-cancel]")!.click();
  expect(keys).toHaveLength(1);
  win.document.querySelector<HTMLButtonElement>('[data-ssh-id] button:last-child')!.click();
  win.document.querySelector<HTMLButtonElement>("#ssh-delete-confirm")!.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(keys).toHaveLength(0);
  expect(saves).toBe(1);
  expect(win.document.querySelector<HTMLDialogElement>("#ssh-delete-dialog")!.open).toBe(false);
});

test("locking during SSH generation prevents storage and clears the dialog and key list", async () => {
  const win = new Window({ url: "http://localhost/passwords" });
  Object.assign(globalThis, { window: win, document: win.document, MutationObserver: win.MutationObserver });
  win.document.body.innerHTML = '<section id="settings-view"></section>';
  let generation = 1, unlocked = true, saves = 0;
  let release!: (value: typeof pair) => void;
  const pending = new Promise<typeof pair>(resolve => release = resolve);
  const ctx: any = { get: () => ({ vault: { version: 1, entries: [] }, discreet: false }), current: (g: number) => g === generation, unlocked: () => unlocked, run: async (fn: any) => fn(generation), announce: () => {} };
  const ui = initSSHStorage(ctx, { getKeys: () => [identity], getProfiles: () => [], save: async () => { saves++; } }, () => pending);
  ui.refresh(); win.document.querySelector<HTMLButtonElement>("#ssh-new")!.click();
  win.document.querySelector<HTMLInputElement>("#ssh-label")!.value = "Cancelled synthetic key";
  win.document.querySelector<HTMLFormElement>("#ssh-dialog form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
  unlocked = false; generation++; ui.clear(); release(pair);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(saves).toBe(0);
  expect(win.document.querySelector("#ssh-identities")!.textContent).toBe("");
  expect(win.document.querySelector<HTMLInputElement>("#ssh-label")!.value).toBe("");
  expect(win.document.querySelector<HTMLDialogElement>("#ssh-dialog")!.open).toBe(false);
});
