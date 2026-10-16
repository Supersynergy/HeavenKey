import { test, expect, afterAll } from "bun:test";
import { Window } from "happy-dom";
import { readFile } from "node:fs/promises";
const window = new Window({ url: "http://localhost:18240", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
window.document.write((await readFile("apps/web/index.html", "utf8")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, location: window.location })) Object.defineProperty(globalThis, name, { configurable: true, value });
const id = btoa("synthetic-credential").replace(/=+$/, "");
class PublicKeyCredential {}
Object.defineProperty(window, "PublicKeyCredential", { value: PublicKeyCredential });
Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true, value: PublicKeyCredential });
Object.defineProperty(window.navigator, "credentials", { value: { get: async () => ({ id, rawId: new TextEncoder().encode("synthetic-credential").buffer, type: "public-key", authenticatorAttachment: "platform", response: { clientDataJSON: new ArrayBuffer(8), authenticatorData: new ArrayBuffer(8), signature: new ArrayBuffer(8), userHandle: null }, getClientExtensionResults: () => ({}) }) } });
const calls: { path: string; body?: Record<string, unknown> }[] = [];
let recovery = false;
const recoveryCode = "synthetic-code-never-render-in-the-interface";
Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (path: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body });
  const values: Record<string, unknown> = {
    "/api/config": { origin: "http://localhost:18240", rp_id: "localhost", keystore: "external-key-file" },
    "/api/auth/start": { request_id: "synthetic", options: { publicKey: { challenge: btoa("synthetic-challenge").replace(/=+$/, ""), rpId: "localhost", allowCredentials: [{ id, type: "public-key" }], userVerification: "required" } } },
    "/api/auth/finish": body?.management ? { approval_id: "synthetic-approval" } : { session: "synthetic-session", name: "owner", owner: true, account_id: "synthetic-account", expires_in: 300 },
    "/api/credentials": { credentials: [{ id, label: "Testgerät", active: true, created: 1 }], current_credential_id: id },
    "/api/delegations": { grants: [] }, "/api/grants": { grants: [] }, "/api/agents": { tasks: [] }, "/api/audit": { events: [] },
    "/api/recovery": { enabled: recovery, active_passkeys: 1 }, "/api/recovery/rotate": { code: recoveryCode }, "/api/logout": { logged_out: true },
  };
  if (!(path in values)) throw new Error(`Unexpected mocked API: ${path}`);
  if (path === "/api/recovery/rotate") recovery = true;
  return new Response(JSON.stringify(values[path]), { status: 200, headers: { "Content-Type": "application/json" } });
} });
await import("./main");
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("UI state timeout: " + element("status").textContent); }
const element = (id: string) => window.document.getElementById(id)!;
afterAll(() => window.happyDOM.abort());
test("actual interface wires navigation, passkey login, sensitive confirmation and logout", async () => {
  await until(() => element("security-summary").textContent!.includes("externe Schlüsseldatei"));
  for (const section of ["keys", "access", "recovery", "agents", "vault", "help"]) expect(element(section)).toBeTruthy();
  expect((element("agent-create") as unknown as HTMLButtonElement).disabled).toBe(true);
  element("login").click(); await until(() => element("identity").textContent!.includes("Eigentümer"));
  await until(() => !(element("agent-create") as unknown as HTMLButtonElement).disabled);
  expect(element("backup-hint").textContent).toContain("zweiten Passkey");
  element("recovery-rotate").click(); await until(() => (element("management-dialog") as unknown as HTMLDialogElement).open);
  expect(element("management-title").textContent).toBe("Wiederherstellungscode erstellen");
  element("management-confirm").click(); await until(() => element("recovery-created").textContent!.includes("Neuer Einmalcode"));
  expect(calls.find(x => x.path === "/api/recovery/rotate")?.body?.approval_id).toBe("synthetic-approval");
  expect(window.document.body.textContent).not.toContain(recoveryCode);
  expect((element("recovery-download") as unknown as HTMLButtonElement).disabled).toBe(false);
  element("logout").click(); await until(() => element("identity").textContent!.includes("Erneute Anmeldung"));
  expect((element("agent-create") as unknown as HTMLButtonElement).disabled).toBe(true);
  expect(element("recovery-created").textContent).toBe("");
  expect((element("vault-text") as unknown as HTMLTextAreaElement).value).toBe("");
});
