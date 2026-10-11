type Grant = { id: string; guest: string; revoked: boolean; grant: { body: { expires_at: number; resource: string }; signature: number[] } };
type Ceremony = { request_id: string; options: { publicKey: Record<string, unknown> } };
let session: string | undefined;
let isOwner = false;
const el = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Element fehlt: ${id}`);
  return value as T;
};
const input = (id: string) => el<HTMLInputElement>(id).value;
export function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}
export function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value as T;
}
function credentialJSON(value: PublicKeyCredential): object {
  if ("toJSON" in value && typeof value.toJSON === "function") return value.toJSON();
  const response = value.response;
  const common = { id: value.id, rawId: encode(value.rawId), type: value.type, extensions: value.getClientExtensionResults() };
  if (response instanceof AuthenticatorAttestationResponse) return { ...common, response: { attestationObject: encode(response.attestationObject), clientDataJSON: encode(response.clientDataJSON), transports: response.getTransports() } };
  if (response instanceof AuthenticatorAssertionResponse) return { ...common, response: { authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null } };
  throw new Error("Unbekannte Credential-Antwort");
}
async function register(): Promise<void> {
  const name = input("name");
  const start = await api<Ceremony>("/api/register/start", { name, bootstrap_token: input("bootstrap") || null });
  const key = start.options.publicKey;
  key.challenge = decode(key.challenge as string);
  const user = key.user as Record<string, unknown>;
  user.id = decode(user.id as string);
  if (key.excludeCredentials) for (const c of key.excludeCredentials as Record<string, unknown>[]) c.id = decode(c.id as string);
  const created = await navigator.credentials.create({ publicKey: key as unknown as PublicKeyCredentialCreationOptions });
  if (!(created instanceof PublicKeyCredential)) throw new Error("Einschreibung abgebrochen");
  await api("/api/register/finish", { request_id: start.request_id, credential: credentialJSON(created) });
  el<HTMLInputElement>("bootstrap").value = "";
  status(`Passkey für ${name} eingeschrieben. Jetzt anmelden.`, false);
}
async function authenticate(invocation?: object): Promise<Record<string, unknown>> {
  const start = await api<Ceremony>("/api/auth/start", { name: input("name"), invocation: invocation || null });
  const key = start.options.publicKey;
  key.challenge = decode(key.challenge as string);
  for (const c of key.allowCredentials as Record<string, unknown>[]) c.id = decode(c.id as string);
  const credential = await navigator.credentials.get({ publicKey: key as unknown as PublicKeyCredentialRequestOptions });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Anmeldung abgebrochen");
  return api("/api/auth/finish", { request_id: start.request_id, credential: credentialJSON(credential), invocation: invocation || null });
}
async function login(): Promise<void> {
  const result = await authenticate();
  session = result.session as string;
  isOwner = result.owner as boolean;
  el("identity").textContent = `${result.name} · ${isOwner ? "Eigentümer" : "Gast"}`;
  el<HTMLButtonElement>("issue").disabled = !isOwner;
  el<HTMLButtonElement>("refresh").disabled = false;
  status("Passkey geprüft. Sitzung ist aktiv.", false);
  await refresh();
}
function status(text: string, error: boolean): void {
  el("status").textContent = text;
  el("status").dataset.error = String(error);
  el("status").dataset.success = String(!error);
}
async function refresh(): Promise<void> {
  const result = await api<{ grants: Grant[] }>("/api/grants");
  const area = el("grants");
  area.replaceChildren();
  if (!result.grants.length) { const p = document.createElement("p"); p.className = "empty"; p.textContent = "Noch keine zugeordneten Zugänge."; area.append(p); }
  for (const grant of result.grants) {
    const row = document.createElement("div"); row.className = "grant"; row.dataset.id = grant.id;
    const text = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = grant.guest;
    const expired = grant.grant.body.expires_at <= Date.now() / 1000;
    const badge = document.createElement("span"); badge.className = `badge ${grant.revoked || expired ? "revoked" : ""}`; badge.textContent = grant.revoked ? "Widerrufen" : expired ? "Abgelaufen" : "Leserecht";
    const expiry = document.createElement("span"); expiry.className = "note"; expiry.textContent = `Endet ${new Date(grant.grant.body.expires_at * 1000).toLocaleTimeString("de-DE")}`;
    const id = document.createElement("code"); id.textContent = grant.id;
    text.append(name, badge, expiry, document.createElement("br"), id);
    const actions = document.createElement("div"); actions.className = "buttons";
    const button = document.createElement("button"); button.textContent = isOwner ? "Widerrufen" : "Dokument lesen"; button.disabled = grant.revoked || (!isOwner && expired);
    button.addEventListener("click", () => void perform(button, async () => {
      if (isOwner) { await api("/api/grants/revoke", { id: grant.id }); status("Widerruf am Ziel bestätigt.", false); }
      else { const value = await authenticate({ grant: grant.grant, resource: grant.grant.body.resource, action: "Read", arguments: { document: "overview" } }); el("result").textContent = JSON.stringify(value, null, 2); status("Aufruf autorisiert und im Verifier bestätigt.", false); }
      await refresh();
    }));
    actions.append(button); row.append(text, actions); area.append(row);
  }
}
async function perform(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  button.disabled = true; button.setAttribute("aria-busy", "true");
  try { await action(); } catch (error) { status(error instanceof Error ? error.message : String(error), true); }
  finally { button.removeAttribute("aria-busy"); if (button.isConnected) button.disabled = false; }
}
for (const [id, action] of [["register", register], ["login", login], ["refresh", refresh]] as const) {
  const button = el<HTMLButtonElement>(id); button.addEventListener("click", () => void perform(button, action));
}
el<HTMLButtonElement>("issue").addEventListener("click", () => void perform(el("issue"), async () => {
  await api("/api/grants", { guest_name: input("guest"), ttl_seconds: Number(input("ttl")) });
  status("Zugang an den Empfänger gebunden.", false); await refresh();
}));
document.documentElement.dataset.ready = "true";
