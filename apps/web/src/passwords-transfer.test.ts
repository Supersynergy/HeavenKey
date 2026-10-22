import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import { initTransferBroker, generateTransferKey, sealTransferProfile } from "./passwords-transfer";
import { encode64, decode64 } from "./passwords-crypto";
import { validateTransferProfile, type TransferProfile } from "../../../packages/transfers/schema";
const profile: TransferProfile = { id: "00000000-0000-4000-8000-000000000001", label: "Synthetic", provider: "custom", protocol: "sftp", host: "fixture.invalid", port: 22, username: "fake-user", root: "/", host_key: "SHA256:" + "a".repeat(43), password: "synthetic-password", private_key: "", public_key: "" };
const request = { id: "request", client_id: "client", label: "<img src=x>", connection_id: profile.id, operation: "get" as const, path: "report.txt", sha256: "", bytes: 0, status: "pending", expires_at: Math.floor(Date.now() / 1000) + 90 };
const keys = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
const publicKey = encode64(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)));
async function decrypt(sealed: any, aad = "HeavenKey transfer v1\x00request\x009\x004") {
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, keys.privateKey, decode64(sealed.key, 512));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode64(sealed.iv, 12), additionalData: new TextEncoder().encode(aad) }, aes, decode64(sealed.ciphertext, 30000))));
}
test("encrypted approval binds profile, action, exact path and owner epoch/revision with real NUL AAD", async () => {
  const sealed = await sealTransferProfile(profile, request, publicKey, 9, 4, true);
  expect(JSON.stringify(sealed)).not.toContain(profile.password);
  expect(await decrypt(sealed)).toEqual({ version: 1, profile, operation: "get", path: "report.txt", sha256: null, disclose_content: true });
  for (const aad of ["HeavenKey transfer v1\x00other\x009\x004", "HeavenKey transfer v1\x00request\x008\x004", "HeavenKey transfer v1\x00request\x009\x005"]) await expect(decrypt(sealed, aad)).rejects.toThrow();
  await expect(sealTransferProfile(profile, request, publicKey, 9, 4, false)).rejects.toThrow();
  await expect(sealTransferProfile(profile, { ...request, connection_id: "other" }, publicKey, 9, 4, true)).rejects.toThrow();
});
test("put approval includes exact hash and rejects a missing hash", async () => {
  const put = { ...request, operation: "put" as const, sha256: "a".repeat(64), bytes: 12 };
  expect((await decrypt(await sealTransferProfile(profile, put, publicKey, 9, 4, false))).sha256).toBe(put.sha256);
  await expect(sealTransferProfile(profile, { ...put, sha256: "" }, publicKey, 9, 4, false)).rejects.toThrow();
});
test("owner WebCrypto key pair uses importable Ed25519 PKCS8 and OpenSSH public key", async () => {
  const pair = await generateTransferKey(); expect(pair.public_key).toMatch(/^ssh-ed25519 /);
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pair.private_key.replace(/-----[^-]+-----|\s/g, "")), c => c.charCodeAt(0)), "Ed25519", false, ["sign"]);
  expect(key.algorithm.name).toBe("Ed25519"); expect(validateTransferProfile({ ...profile, password: "", ...pair }).private_key).toBe(pair.private_key);
});
const tick = () => new Promise(r => setTimeout(r, 30));
function setup() {
  const win = new Window({ url: "http://localhost/passwords" });
  Object.assign(globalThis, { window: win, document: win.document, MutationObserver: win.MutationObserver, HTMLElement: win.HTMLElement, HTMLButtonElement: win.HTMLButtonElement, DOMParser: win.DOMParser });
  win.document.body.innerHTML = '<section id="settings-view"></section>';
  let generation = 1, unlocked = true, profiles = [{ ...profile }]; const calls: any[] = [], saved: any[] = [];
  const snapshot = { token: "synthetic-token", revision: 4, record: null, vault: { version: 1, entries: [] }, discreet: false };
  const ctx: any = { get: () => ({ ...snapshot, generation }), current: (g: number) => g === generation, unlocked: () => unlocked, announce: () => {}, run: async (fn: any) => fn(generation), accept: () => {} };
  const state = { version: 1, epoch: 9, revision: 4, public_key: publicKey, requests: [{ ...request }], audit: [], limits: { max_bytes: 1048576, request_seconds: 300 }, protocols: ["sftp", "ftpes"] };
  globalThis.fetch = async (url: any, init: any = {}) => { calls.push({ path: String(url), ...init, body: init.body ? JSON.parse(init.body) : undefined }); return Response.json(String(url).includes("/approve/") ? { status: "running" } : state); };
  const persistence = { get: () => profiles, save: async (rows: TransferProfile[]) => { saved.push(rows); profiles = rows; } };
  return { win, ctx, state, calls, saved, persistence, lock: () => { unlocked = false; generation++; }, snapshot };
}
test("get approval requires explicit disclosure, renders untrusted text safely and sends only sealed credentials", async () => {
  const s = setup(), ui = initTransferBroker(s.ctx, s.persistence); await ui.unlocked();
  s.win.document.querySelector<HTMLButtonElement>("#transfer-review-request")!.click();
  const consent = s.win.document.querySelector<HTMLInputElement>("#transfer-consent")!, approve = s.win.document.querySelector<HTMLButtonElement>("#transfer-approve")!;
  expect(approve.disabled).toBe(true); expect(s.win.document.querySelector("img")).toBeNull(); expect(s.win.document.querySelector("#transfer-approval-dialog")!.textContent).toContain("gesamten Inhalt");
  consent.checked = true; consent.dispatchEvent(new s.win.Event("change")); expect(approve.disabled).toBe(false);
  s.win.document.querySelector<HTMLFormElement>("#transfer-approval-dialog form")!.dispatchEvent(new s.win.Event("submit", { cancelable: true })); await tick();
  const sent = s.calls.find(c => c.path.includes("/approve/")); expect(sent).toBeDefined(); expect(Object.keys(sent.body).sort()).toEqual(["epoch", "revision", "sealed"]); expect((await decrypt(sent.body.sealed)).disclose_content).toBe(true); ui.clear();
});
test("lock during encryption cancels approval, wipes secret dialog fields and revokes grants", async () => {
  const s = setup(), ui = initTransferBroker(s.ctx, s.persistence); await ui.unlocked(); s.win.document.querySelector<HTMLButtonElement>("#transfer-review-request")!.click();
  const consent = s.win.document.querySelector<HTMLInputElement>("#transfer-consent")!; consent.checked = true; consent.dispatchEvent(new s.win.Event("change"));
  s.win.document.querySelector<HTMLFormElement>("#transfer-approval-dialog form")!.dispatchEvent(new s.win.Event("submit", { cancelable: true })); s.lock(); ui.clear(); await tick();
  expect(s.calls.some(c => c.path.includes("/approve/"))).toBe(false); expect(s.calls.some(c => c.path.endsWith("/lock") && c.keepalive)).toBe(true); expect(s.win.document.querySelector<HTMLDialogElement>("#transfer-approval-dialog")!.open).toBe(false); expect(s.win.document.querySelector("#transfer-profiles")!.textContent).toBe("");
});
test("cancel remains available while busy and restores focus", async () => {
  const s = setup(), ui = initTransferBroker(s.ctx, s.persistence); await ui.unlocked(); const trigger = s.win.document.querySelector<HTMLButtonElement>("#transfer-review-request")!; trigger.focus(); trigger.click(); ui.setBusy(true);
  const cancel = s.win.document.querySelector<HTMLButtonElement>("#transfer-approval-dialog [data-cancel]")!; expect(cancel.disabled).toBe(false); cancel.click(); expect(s.win.document.activeElement?.id).toBe("transfer-settings"); ui.clear();
});
test("profile editor clears secret inputs on cancel and provider defaults require no fabricated host", async () => {
  const s = setup(), ui = initTransferBroker(s.ctx, s.persistence); await ui.unlocked(); s.win.document.querySelector<HTMLButtonElement>("#transfer-add")!.click();
  const password = s.win.document.querySelector<HTMLInputElement>("#transfer-password")!; password.value = "fake-unsaved-secret";
  const provider = s.win.document.querySelector<HTMLSelectElement>("#transfer-provider")!; provider.value = "hostinger"; provider.dispatchEvent(new s.win.Event("change"));
  expect(s.win.document.querySelector<HTMLInputElement>("#transfer-host")!.value).toBe("");
  s.win.document.querySelector<HTMLButtonElement>("#transfer-profile-dialog [data-cancel]")!.click(); expect(password.value).toBe(""); expect(s.saved).toHaveLength(0); ui.clear();
});
test("profile save delegates transaction to persistence without nesting the owner's busy operation", async () => {
  const s = setup(); s.ctx.run = async () => { throw new Error("nested owner transaction"); };
  const ui = initTransferBroker(s.ctx, s.persistence); await ui.unlocked(); s.win.document.querySelector<HTMLButtonElement>("#transfer-add")!.click();
  for (const [name, value] of Object.entries({ label: "New fixture", host: "new.invalid", username: "fake-user", password: "fake-password", host_key: profile.host_key })) s.win.document.querySelector<HTMLInputElement>("#transfer-" + name)!.value = value;
  s.win.document.querySelector<HTMLFormElement>("#transfer-profile-dialog form")!.dispatchEvent(new s.win.Event("submit", { cancelable: true })); await tick();
  expect(s.saved).toHaveLength(1); expect(s.saved[0]).toHaveLength(2); expect(s.calls.some(c => JSON.stringify(c.body ?? {}).includes("fake-password"))).toBe(false); ui.clear();
});
test("provider dropdown applies actual provider port and documents restricted access", async () => {
  const s = setup(), ui = initTransferBroker(s.ctx, s.persistence); await ui.unlocked(); s.win.document.querySelector<HTMLButtonElement>("#transfer-add")!.click();
  const provider = s.win.document.querySelector<HTMLSelectElement>("#transfer-provider")!; provider.value = "hostinger"; provider.dispatchEvent(new s.win.Event("change"));
  expect(s.win.document.querySelector<HTMLInputElement>("#transfer-port")!.value).toBe("65002");
  provider.value = "netcup"; provider.dispatchEvent(new s.win.Event("change")); expect(s.win.document.querySelector<HTMLSelectElement>("#transfer-protocol")!.value).toBe("ftpes"); expect(s.win.document.querySelector("#transfer-profile-dialog")!.textContent).toContain("Haupt-Systembenutzer");
  expect(s.win.document.querySelector<HTMLSelectElement>("#transfer-client")!.options.length).toBe(10); ui.clear();
});

const syntheticCA = "-----BEGIN CERTIFICATE-----\nMIIBPzCB8qADAgECAhRPEQxpKagnJOD5Tf/fRYP1tAekgDAFBgMrZXAwJjEkMCIG\nA1UEAwwbSGVhdmVuS2V5IFN5bnRoZXRpYyBDQSBUZXN0MB4XDTI2MTAyMjEzMTQx\nMloXDTI2MTAyMzEzMTQxMlowJjEkMCIGA1UEAwwbSGVhdmVuS2V5IFN5bnRoZXRp\nYyBDQSBUZXN0MCowBQYDK2VwAyEA8hI0zcL3AVTaqim7cLLO1DzpGTr8LNZ0cFOb\nVVZHBDCjMjAwMB0GA1UdDgQWBBR9IiGDLFycl0IIRWt0rH6baQ4yUzAPBgNVHRMB\nAf8EBTADAQH/MAUGAytlcANBACIlLdMwaM1WSr6r+7GG2R7ZyKtNEznazY7vpMEM\nxgk6UTr3vixY4xjVEZ8D3jib1x7wVfb4mTRrgw3v4XVJyA8=\n-----END CERTIFICATE-----\n";
test("FTPES owner CA is explicit, saved through vault adapter, shown as own trust and wiped on protocol switch", async () => {
  const s = setup(), ui = initTransferBroker(s.ctx, s.persistence); await ui.unlocked(); s.win.document.querySelector<HTMLButtonElement>("#transfer-add")!.click();
  const protocol = s.win.document.querySelector<HTMLSelectElement>("#transfer-protocol")!; protocol.value = "ftpes"; protocol.dispatchEvent(new s.win.Event("change"));
  const ca = s.win.document.querySelector<HTMLTextAreaElement>("#transfer-ca-certificate")!, advanced = s.win.document.querySelector<HTMLDetailsElement>("#transfer-ca-settings")!;
  expect(advanced.hidden).toBe(false); expect(ca.disabled).toBe(false); ca.value = syntheticCA;
  expect(s.win.document.querySelector("#transfer-ca-explanation")!.textContent).toContain("vertraust du dieser CA ausdrücklich");
  for (const [name, value] of Object.entries({ label: "Private TLS", host: "local.invalid", username: "fake-user", password: "fake-password" })) s.win.document.querySelector<HTMLInputElement>("#transfer-" + name)!.value = value;
  s.win.document.querySelector<HTMLFormElement>("#transfer-profile-dialog form")!.dispatchEvent(new s.win.Event("submit", { cancelable: true })); await tick();
  expect(s.saved[0][1].ca_certificate).toBe(syntheticCA); expect(s.win.document.querySelector("#transfer-profiles")!.textContent).toContain("Eigene CA ausdrücklich vertraut"); expect(ca.value).toBe("");
  s.win.document.querySelector<HTMLButtonElement>("#transfer-add")!.click(); protocol.value = "ftpes"; protocol.dispatchEvent(new s.win.Event("change")); ca.value = syntheticCA;
  protocol.value = "sftp"; protocol.dispatchEvent(new s.win.Event("change")); expect(ca.value).toBe(""); expect(advanced.hidden).toBe(true); ui.clear();
});
test("custom CA stays inside sealed FTPES approval, with system trust explicit when absent", async () => {
  const ftpes = { ...profile, protocol: "ftpes" as const, host_key: "", ca_certificate: syntheticCA };
  const sealed = await sealTransferProfile(ftpes, request, publicKey, 9, 4, true); expect(JSON.stringify(sealed)).not.toContain("CERTIFICATE"); expect((await decrypt(sealed)).profile.ca_certificate).toBe(syntheticCA);
  const s = setup(); s.persistence.get().splice(0, 1, { ...ftpes, ca_certificate: "" }); const ui = initTransferBroker(s.ctx, s.persistence); await ui.unlocked(); expect(s.win.document.querySelector("#transfer-profiles")!.textContent).toContain("System-CA"); ui.clear();
});
