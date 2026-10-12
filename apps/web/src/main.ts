import { startRegistration, startAuthentication, WebAuthnAbortService, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON } from "@simplewebauthn/browser";

type Grant = { id: string; guest: string; revoked: boolean; grant: { body: { expires_at: number; resource: string }; signature: number[] } };
type Ceremony<T> = { request_id: string; options: { publicKey: T } };
type Credential = { id: string; label: string; active: boolean; created: number };
type Management = { kind: "credential_add"; label: string } | { kind: "credential_revoke"; id: string } | { kind: "grant_create"; guest_name: string; ttl_seconds: number } | { kind: "grant_revoke"; id: string };
let session: string | undefined;
let sessionName: string | undefined;
let isOwner = false;
let activeCredentialCount = 0;
let inFlight = false;
let confirmationOpen = false;
const el = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Element fehlt: ${id}`);
  return value as T;
};
const input = (id: string) => el<HTMLInputElement>(id).value;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && (path.startsWith("/api/credentials") || path.startsWith("/api/grants"))) clearSession();
    const messages: Record<string, string> = {
      session_required: "Bitte zuerst mit einem aktiven Passkey anmelden.",
      session_expired: "Die Sitzung ist abgelaufen. Melde dich erneut an.",
      credential_revoked: "Dieser Passkey wurde widerrufen. Melde dich mit einem aktiven Schlüssel an.",
      credential_limit: "Es sind bereits 8 aktive Passkeys vorhanden. Widerrufe zuerst einen zusätzlichen Schlüssel.",
      last_credential_required: "Der letzte aktive Passkey bleibt erhalten. Füge zuerst einen Ersatzschlüssel hinzu.",
      enrollment_session_changed: "Die Sitzung hat sich geändert. Starte die Einschreibung erneut.",
      ceremony_missing: "Dieser Vorgang ist abgelaufen oder bereits beendet. Starte ihn erneut.",
      approval_required: "Bestätige diese Aktion zuerst mit deinem Passkey.",
      approval_missing: "Die Bestätigung ist abgelaufen oder bereits verwendet. Bestätige die Aktion erneut.",
      approval_mismatch: "Diese Bestätigung gehört zu einer anderen Aktion. Bestätige die Aktion erneut.",
      management_changed: "Die Aktion hat sich geändert. Bestätige sie erneut.",
    };
    throw new Error(messages[value.error] || value.error || `HTTP ${response.status}`);
  }
  return value as T;
}
async function createCredential(start: Ceremony<PublicKeyCredentialCreationOptionsJSON>): Promise<RegistrationResponseJSON> {
  return passkeyRequest(() => startRegistration({ optionsJSON: start.options.publicKey }));
}
async function passkeyRequest<T>(request: () => Promise<T>): Promise<T> {
  el<HTMLButtonElement>("operation-cancel").hidden = false;
  try { return await request(); }
  finally { el<HTMLButtonElement>("operation-cancel").hidden = true; }
}
async function register(): Promise<void> {
  const name = input("name");
  const start = await api<Ceremony<PublicKeyCredentialCreationOptionsJSON>>("/api/register/start", { name, bootstrap_token: input("bootstrap") || null });
  const created = await createCredential(start);
  await api("/api/register/finish", { request_id: start.request_id, credential: created });
  el<HTMLInputElement>("bootstrap").value = "";
  status(`Passkey für ${name} eingeschrieben. Jetzt anmelden.`, false);
}
async function authenticate(invocation?: object, name = input("name")): Promise<Record<string, unknown>> {
  const start = await api<Ceremony<PublicKeyCredentialRequestOptionsJSON>>("/api/auth/start", { name, invocation: invocation || null });
  const credential = await passkeyRequest(() => startAuthentication({ optionsJSON: start.options.publicKey }));
  return api("/api/auth/finish", { request_id: start.request_id, credential, invocation: invocation || null });
}
async function login(): Promise<void> {
  setSession(await authenticate());
  status("Passkey geprüft. Sitzung ist aktiv.", false);
  await refresh();
}
function setSession(result: Record<string, unknown>): void {
  session = result.session as string;
  sessionName = result.name as string;
  isOwner = result.owner as boolean;
  el("identity").textContent = `${result.name} · ${isOwner ? "Eigentümer" : "Gast"}`;
  sessionControls();
}
function sessionControls(): void {
  for (const id of ["register", "login"]) el<HTMLButtonElement>(id).disabled = inFlight;
  for (const id of ["management-confirm", "management-cancel"]) el<HTMLButtonElement>(id).disabled = inFlight && !confirmationOpen;
  el<HTMLButtonElement>("issue").disabled = inFlight || !session || !isOwner;
  el<HTMLButtonElement>("refresh").disabled = inFlight || !session;
  el<HTMLButtonElement>("credential-add").disabled = inFlight || !session || activeCredentialCount >= 8;
  for (const row of el("credentials").querySelectorAll<HTMLElement>(".credential")) {
    const button = row.querySelector<HTMLButtonElement>("button");
    if (button) button.disabled = inFlight || row.dataset.active !== "true" || activeCredentialCount <= 1;
  }
}
function clearSession(): void {
  session = undefined; sessionName = undefined; isOwner = false; activeCredentialCount = 0;
  el("identity").textContent = "Erneute Anmeldung erforderlich";
  el("grants").replaceChildren();
  el("result").textContent = "—";
  el<HTMLDialogElement>("management-dialog").close();
  const message = document.createElement("p"); message.className = "empty"; message.textContent = "Melde dich mit einem aktiven Passkey erneut an.";
  el("credentials").replaceChildren(message);
  sessionControls();
}
async function approve(management: Management): Promise<string> {
  if (!session || !sessionName) throw new Error("Bitte zuerst mit einem aktiven Passkey anmelden.");
  const dialog = el<HTMLDialogElement>("management-dialog");
  const details: Record<Management["kind"], [string, string, string]> = {
    credential_add: ["Passkey hinzufügen", "label" in management ? `Bezeichnung: ${management.label}` : "", "Der neue Schlüssel erhält die bestehenden Rechte dieses Kontos."],
    credential_revoke: ["Passkey widerrufen", "id" in management ? `Schlüssel-ID: ${management.id}` : "", "Dieser Schlüssel kann sich danach nicht mehr anmelden. Alle Sitzungen dieses Kontos enden. Mindestens ein Schlüssel bleibt aktiv."],
    grant_create: ["Zugang vergeben", "guest_name" in management ? `Empfänger: ${management.guest_name}\nGültigkeit: ${management.ttl_seconds} Sekunden` : "", "Du vergibst ein Leserecht für das Labordokument."],
    grant_revoke: ["Zugang widerrufen", "id" in management ? `Zugangs-ID: ${management.id}` : "", "Dieser Zugang kann danach nicht mehr verwendet werden."],
  };
  const [title, target, help] = details[management.kind];
  el("management-title").textContent = title; el("management-target").textContent = target; el("management-help").textContent = help;
  dialog.returnValue = "";
  const confirmation = new Promise<boolean>(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
  confirmationOpen = true; sessionControls(); dialog.showModal(); el("management-cancel").focus();
  const confirmed = await confirmation;
  confirmationOpen = false; sessionControls();
  if (!confirmed) throw new DOMException("Aktion abgebrochen. Du kannst sie erneut starten.", "AbortError");
  const start = await api<Ceremony<PublicKeyCredentialRequestOptionsJSON>>("/api/auth/start", { name: sessionName, management });
  const credential = await passkeyRequest(() => startAuthentication({ optionsJSON: start.options.publicKey }));
  const result = await api<{ approval_id: string }>("/api/auth/finish", { request_id: start.request_id, credential, management });
  return result.approval_id;
}
function status(text: string, error: boolean): void {
  el("status").textContent = text;
  el("status").dataset.error = String(error);
  el("status").dataset.success = String(!error);
}
async function refresh(): Promise<void> {
  await refreshCredentials();
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
      if (isOwner) { const approval_id = await approve({ kind: "grant_revoke", id: grant.id }); await api("/api/grants/revoke", { id: grant.id, approval_id }); status("Widerruf am Ziel bestätigt.", false); }
      else { const value = await authenticate({ grant: grant.grant, resource: grant.grant.body.resource, action: "Read", arguments: { document: "overview" } }, sessionName); el("result").textContent = JSON.stringify(value, null, 2); status("Aufruf autorisiert und im Verifier bestätigt.", false); }
      await refresh();
    }));
    actions.append(button); row.append(text, actions); area.append(row);
  }
}
async function refreshCredentials(): Promise<void> {
  const result = await api<{ credentials: Credential[]; current_credential_id: string }>("/api/credentials");
  activeCredentialCount = result.credentials.filter(c => c.active).length;
  const area = el("credentials"); area.replaceChildren();
  for (const credential of result.credentials) {
    const row = document.createElement("div"); row.className = "credential"; row.dataset.id = credential.id; row.dataset.active = String(credential.active);
    const text = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = credential.label;
    const badge = document.createElement("span"); badge.className = `badge ${credential.active ? "" : "revoked"}`;
    badge.textContent = !credential.active ? "Widerrufen" : credential.id === result.current_credential_id ? "Aktiv · aktuelle Sitzung" : "Aktiv";
    const created = document.createElement("span"); created.className = "note"; created.textContent = `Erstellt ${new Date(credential.created * 1000).toLocaleDateString("de-DE")}`;
    const id = document.createElement("code"); id.textContent = credential.id;
    text.append(name, badge, created, document.createElement("br"), id);
    const actions = document.createElement("div"); actions.className = "buttons";
    const button = document.createElement("button"); button.className = "secondary"; button.textContent = "Passkey widerrufen";
    button.setAttribute("aria-label", `${credential.label} widerrufen`);
    button.disabled = !credential.active || activeCredentialCount <= 1;
    button.addEventListener("click", () => void perform(button, async () => {
      const approval_id = await approve({ kind: "credential_revoke", id: credential.id });
      await api("/api/credentials/revoke", { id: credential.id, approval_id });
      clearSession();
      status(`Passkey „${credential.label}“ widerrufen. Alle Sitzungen beendet. Melde dich mit einem verbleibenden Schlüssel erneut an.`, false);
      el("login").focus();
    }));
    actions.append(button);
    if (credential.active && activeCredentialCount <= 1) { const note = document.createElement("span"); note.className = "note"; note.textContent = "Letzter aktiver Schlüssel"; actions.append(note); }
    row.append(text, actions); area.append(row);
  }
  sessionControls();
}
function validateLabel(): string {
  const value = input("credential-label").trim();
  const valid = value.length > 0 && [...value].length <= 48;
  el<HTMLInputElement>("credential-label").setAttribute("aria-invalid", String(!valid));
  el("credential-label-status").textContent = valid ? "1 bis 48 Zeichen." : "Gib eine Bezeichnung mit 1 bis 48 Zeichen ein.";
  el("credential-label-status").dataset.error = String(!valid);
  return valid ? value : "";
}
async function addCredential(): Promise<void> {
  const label = validateLabel();
  if (!label) { el("credential-label").focus(); throw new Error("Die Bezeichnung fehlt oder ist zu lang."); }
  const approval_id = await approve({ kind: "credential_add", label });
  const start = await api<Ceremony<PublicKeyCredentialCreationOptionsJSON>>("/api/credentials/start", { label, approval_id });
  const credential = await createCredential(start);
  await api("/api/credentials/finish", { request_id: start.request_id, credential });
  el<HTMLInputElement>("credential-label").value = "";
  await refreshCredentials();
  status(`Passkey „${label}“ hinzugefügt. Bestehende Zugänge gelten für dieses Konto.`, false);
}
async function perform(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  if (inFlight) return;
  inFlight = true; sessionControls(); button.disabled = true; button.setAttribute("aria-busy", "true");
  button.dataset.state = "loading";
  try { await action(); button.dataset.state = "success"; } catch (error) {
    const cancelled = error instanceof Error && (error.name === "AbortError" || "code" in error && error.code === "ERROR_CEREMONY_ABORTED");
    button.dataset.state = cancelled ? "idle" : "error";
    status(cancelled ? "Aktion abgebrochen. Du kannst sie erneut starten." : error instanceof Error ? error.message : String(error), !cancelled);
  }
  finally { inFlight = false; button.removeAttribute("aria-busy"); if (button.isConnected) button.disabled = false; sessionControls(); }
}
for (const [id, action] of [["register", register], ["login", login], ["refresh", refresh]] as const) {
  const button = el<HTMLButtonElement>(id); button.addEventListener("click", () => void perform(button, action));
}
el<HTMLButtonElement>("issue").addEventListener("click", () => void perform(el("issue"), async () => {
  const management: Management = { kind: "grant_create", guest_name: input("guest"), ttl_seconds: Number(input("ttl")) };
  const approval_id = await approve(management);
  await api("/api/grants", { guest_name: management.guest_name, ttl_seconds: management.ttl_seconds, approval_id });
  status("Zugang an den Empfänger gebunden.", false); await refresh();
}));
el<HTMLFormElement>("credential-form").addEventListener("submit", event => {
  event.preventDefault(); void perform(el("credential-add"), addCredential);
});
el("credential-label").addEventListener("blur", validateLabel);
el("credential-label").addEventListener("input", () => {
  if (el("credential-label").getAttribute("aria-invalid") === "true") validateLabel();
});
el("management-cancel").addEventListener("click", () => el<HTMLDialogElement>("management-dialog").close("cancel"));
el("management-confirm").addEventListener("click", () => el<HTMLDialogElement>("management-dialog").close("confirm"));
el("operation-cancel").addEventListener("click", () => WebAuthnAbortService.cancelCeremony());
document.documentElement.dataset.ready = "true";
