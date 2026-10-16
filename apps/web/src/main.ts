import * as vaultCrypto from "./vault";
import { startRegistration, startAuthentication, WebAuthnAbortService, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON } from "@simplewebauthn/browser";

type Grant = { id: string; guest: string; revoked: boolean; grant: { body: { expires_at: number; resource: string }; signature: number[] } };
type Ceremony<T> = { request_id: string; options: { publicKey: T } };
type Credential = { id: string; label: string; active: boolean; created: number };
type DelegationGrant = { body: { resource: string; expires_at: number; remaining_delegations: number }; signature: number[] };
type Delegation = { id: string; guest: string; grant: DelegationGrant; chain: DelegationGrant[]; parent_id: string | null; revoked: boolean; effective_revoked: boolean; can_delegate: boolean; can_revoke: boolean };
type LegacyManagement = { kind: "credential_add"; label: string } | { kind: "credential_revoke"; id: string } | { kind: "grant_create"; guest_name: string; ttl_seconds: number } | { kind: "grant_revoke"; id: string } | { kind: "delegation_create"; guest_name: string; ttl_seconds: number; remaining_delegations: number } | { kind: "delegation_delegate"; parent_id: string; guest_name: string; ttl_seconds: number; remaining_delegations: number } | { kind: "delegation_revoke"; id: string };
type AgentSpec = { name: string; public_key: string; resource: string; actions: string[]; ttl_seconds: number; parent_id: string | null };
type Management = LegacyManagement | { kind: "recovery_rotate" } | { kind: "recovery_disable" } | { kind: "agent_create"; spec: AgentSpec } | { kind: "agent_revoke"; id: string } | { kind: "vault_write"; expected_revision: number; digest: string };
let accountId: string | undefined;
let vaultKey: Uint8Array<ArrayBuffer> | undefined;
let vaultState: { account_id: string; revision: number; record: vaultCrypto.VaultRecord | null } | undefined;
let recoveryCode: string | undefined;
let vaultRecoveryKey: string | undefined;
let nativeAbort: AbortController | undefined;
let sessionExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let session: string | undefined;
let sessionName: string | undefined;
let isOwner = false;
let activeCredentialCount = 0;
let inFlight = false;
let confirmationOpen = false;
const invitedName = new URL(location.href).searchParams.get("guest");
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
    if (response.status === 401 && (path.startsWith("/api/credentials") || path.startsWith("/api/grants") || path.startsWith("/api/delegations") || path.startsWith("/api/vault") || path.startsWith("/api/agents") || path.startsWith("/api/recovery") || path === "/api/session" || path === "/api/read" || path === "/api/audit" || path === "/api/logout")) clearSession();
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
      delegation_denied: "Die Weitergabe ist widerrufen, abgelaufen oder für diese Aktion nicht erlaubt.",
      invalid_delegation_budget: "Die erlaubten Weitergaben müssen kleiner sein als im übergeordneten Zugang.",
    };
    throw new Error(messages[value.error] || value.error || `HTTP ${response.status}`);
  }
  return value as T;
}
async function createCredential(start: Ceremony<PublicKeyCredentialCreationOptionsJSON>): Promise<RegistrationResponseJSON> {
  const optionsJSON = { ...start.options.publicKey, extensions: { ...start.options.publicKey.extensions, prf: {} } };
  const result = await passkeyRequest(() => startRegistration({ optionsJSON }));
  // Never serialize PRF outputs to a remote verifier.
  if (result.clientExtensionResults) delete (result.clientExtensionResults as Record<string, unknown>).prf;
  return result;
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
  if (invocation) el("result").textContent = "—";
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
  if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = setTimeout(() => { clearSession(); status("Die Sitzung ist abgelaufen. Melde dich erneut an.", true); }, Number(result.expires_in || 300) * 1000);
  session = result.session as string;
  sessionName = result.name as string;
  isOwner = result.owner as boolean;
  accountId = result.account_id as string;
  el("identity").textContent = `${result.name} · ${isOwner ? "Eigentümer" : "Gast"}`;
  sessionControls();
}
function sessionControls(): void {
  platformControls();
  for (const id of ["register", "login"]) el<HTMLButtonElement>(id).disabled = inFlight;
  for (const id of ["management-confirm", "management-cancel"]) el<HTMLButtonElement>(id).disabled = inFlight && !confirmationOpen;
  el<HTMLButtonElement>("issue").disabled = inFlight || !session || !isOwner;
  el<HTMLButtonElement>("refresh").disabled = inFlight || !session;
  el<HTMLButtonElement>("credential-add").disabled = inFlight || !session || activeCredentialCount >= 8;
  el<HTMLButtonElement>("delegation-issue").disabled = inFlight || !session || !isOwner;
  for (const button of el("delegations").querySelectorAll<HTMLButtonElement>("button")) button.disabled = inFlight || button.dataset.available !== "true";
  for (const row of el("credentials").querySelectorAll<HTMLElement>(".credential")) {
    const button = row.querySelector<HTMLButtonElement>("button");
    if (button) button.disabled = inFlight || row.dataset.active !== "true" || activeCredentialCount <= 1;
  }
}
function clearSession(): void {
  if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer); sessionExpiryTimer = undefined;
  session = undefined; sessionName = undefined; accountId = undefined; isOwner = false; activeCredentialCount = 0;
  lockVault(); vaultState = undefined; recoveryCode = undefined; vaultRecoveryKey = undefined;
  for (const id of ["recovery-code", "vault-recovery"]) el<HTMLInputElement>(id).value = "";
  el("recovery-created").textContent = "";
  for (const id of ["agent-list", "audit-list"]) el(id).replaceChildren();
  el("identity").textContent = "Erneute Anmeldung erforderlich";
  el("grants").replaceChildren();
  el("result").textContent = "—";
  el<HTMLDialogElement>("management-dialog").close();
  const message = document.createElement("p"); message.className = "empty"; message.textContent = "Melde dich mit einem aktiven Passkey erneut an.";
  el("credentials").replaceChildren(message);
  el("delegations").replaceChildren(message.cloneNode(true));
  sessionControls();
}
async function approve(management: Management): Promise<string> {
  if (!session || !sessionName) throw new Error("Bitte zuerst mit einem aktiven Passkey anmelden.");
  const dialog = el<HTMLDialogElement>("management-dialog");
  const details: Record<Management["kind"], [string, string, string]> = {
    recovery_rotate: ["Wiederherstellungscode erstellen", "Konto: " + sessionName, "Der bisherige Einmalcode wird ungültig. Lade den neuen Code herunter und bewahre ihn getrennt auf."],
    recovery_disable: ["Wiederherstellungscode sperren", "Konto: " + sessionName, "Ohne aktiven Passkey ist danach keine Kontowiederherstellung per Code möglich."],
    agent_create: ["Agentenauftrag freigeben", "spec" in management ? JSON.stringify(management.spec, null, 2) : "", "Der Agent erhält genau diese Rechte im lokalen Pilot. Sein privater Schlüssel bleibt bei ihm."],
    agent_revoke: ["Agentenauftrag widerrufen", "id" in management ? management.id : "", "Offene und künftige Aufrufe dieses Auftrags werden abgewiesen."],
    vault_write: ["Verschlüsselten Tresor speichern", "digest" in management ? `Version: ${management.expected_revision + 1}\nPrüfsumme: ${management.digest}` : "", "Bestätigt die verschlüsselten Daten und die genaue Auswahl berechtigter Passkeys."],
    credential_add: ["Passkey hinzufügen", "label" in management ? `Bezeichnung: ${management.label}` : "", "Der neue Schlüssel erhält die bestehenden Rechte dieses Kontos."],
    credential_revoke: ["Passkey widerrufen", "id" in management ? `Schlüssel-ID: ${management.id}` : "", "Dieser Schlüssel kann sich danach nicht mehr anmelden. Alle Sitzungen dieses Kontos enden. Mindestens ein Schlüssel bleibt aktiv."],
    grant_create: ["Zugang vergeben", "guest_name" in management ? `Empfänger: ${management.guest_name}\nGültigkeit: ${management.ttl_seconds} Sekunden` : "", "Du vergibst ein Leserecht für das Labordokument."],
    grant_revoke: ["Zugang widerrufen", "id" in management ? `Zugangs-ID: ${management.id}` : "", "Dieser Zugang kann danach nicht mehr verwendet werden."],
    delegation_create: ["Weitergabe erlauben", "remaining_delegations" in management ? `Empfänger: ${management.guest_name}\nGültigkeit: ${management.ttl_seconds} Sekunden\nErlaubte Weitergaben: ${management.remaining_delegations}` : "", "Du vergibst ein Leserecht mit begrenzter Weitergabe. Der Dienst signiert die Kette."],
    delegation_delegate: ["Zugang weitergeben", "parent_id" in management ? `Eltern-ID: ${management.parent_id}\nEmpfänger: ${management.guest_name}\nGültigkeit: ${management.ttl_seconds} Sekunden\nErlaubte Weitergaben: ${management.remaining_delegations}` : "", "Der neue Zugang erbt die Grenzen dieses Zugangs. Ein Widerruf eines Vorfahren beendet ihn."],
    delegation_revoke: ["Weitergabe widerrufen", "id" in management ? `Zugangs-ID: ${management.id}` : "", "Dieser Zugang und alle davon abhängigen Weitergaben können danach nicht mehr verwendet werden."],
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
  await refreshDelegations();
  await refreshPlatform();
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
    actions.append(button);
    if (isOwner && !grant.revoked && !expired) {
      const link = document.createElement("a");
      const target = new URL("/", location.origin); target.searchParams.set("guest", grant.guest);
      link.href = target.href; link.textContent = "Zugangslink öffnen"; link.target = "_blank"; link.rel = "noopener noreferrer";
      const copy = document.createElement("button"); copy.className = "secondary"; copy.textContent = "Link kopieren";
      copy.addEventListener("click", () => void perform(copy, async () => {
        await navigator.clipboard.writeText(target.href);
        status("Zugangslink kopiert. Der Empfänger benötigt seinen eigenen Passkey.", false);
      }));
      actions.append(link, copy);
    }
    if (!isOwner && !grant.revoked && !expired) actions.append(sessionReadButton({ grant_id: grant.id }));
    row.append(text, actions); area.append(row);
  }
}
async function invokeDelegation(grant: Delegation): Promise<void> {
  el("result").textContent = "—";
  const delegation_invocation = { id: grant.id, resource: grant.grant.body.resource, action: "Read", arguments: { document: "overview" } };
  const start = await api<Ceremony<PublicKeyCredentialRequestOptionsJSON>>("/api/auth/start", { name: sessionName, delegation_invocation });
  const credential = await passkeyRequest(() => startAuthentication({ optionsJSON: start.options.publicKey }));
  const result = await api("/api/auth/finish", { request_id: start.request_id, credential, delegation_invocation });
  el("result").textContent = JSON.stringify(result, null, 2); status("Kette und Passkey geprüft. Lesen ist erlaubt.", false);
}
async function refreshDelegations(): Promise<void> {
  const result = await api<{ grants: Delegation[] }>("/api/delegations");
  const area = el("delegations"); area.replaceChildren();
  if (!result.grants.length) { const p = document.createElement("p"); p.className = "empty"; p.textContent = "Noch keine empfangenen oder weitergegebenen Zugänge."; area.append(p); }
  for (const [index, grant] of result.grants.entries()) {
    const row = document.createElement("article"); row.className = "delegation"; row.dataset.id = grant.id;
    const name = document.createElement("strong"); name.textContent = grant.guest;
    const expired = grant.grant.body.expires_at <= Date.now() / 1000;
    const badge = document.createElement("span"); badge.className = `badge ${grant.effective_revoked || expired ? "revoked" : ""}`;
    badge.textContent = grant.revoked ? "Widerrufen" : grant.effective_revoked ? "Vorfahre widerrufen" : expired ? "Abgelaufen" : "Leserecht";
    const detail = document.createElement("p"); detail.className = "note"; detail.textContent = `Tiefe ${grant.chain.length} von 5 · Noch ${grant.grant.body.remaining_delegations} Weitergaben · Endet ${new Date(grant.grant.body.expires_at * 1000).toLocaleTimeString("de-DE")}`;
    const parent = document.createElement("p"); parent.className = "note"; parent.textContent = `Eltern-ID: ${grant.parent_id || "Wurzel"}`;
    const id = document.createElement("code"); id.textContent = grant.id;
    const actions = document.createElement("div"); actions.className = "delegation-actions";
    if (grant.guest === sessionName) {
      const button = document.createElement("button"); button.textContent = "Dokument lesen"; button.dataset.available = String(!grant.effective_revoked && !expired);
      button.addEventListener("click", () => void perform(button, async () => { await invokeDelegation(grant); await refreshDelegations(); })); actions.append(button);
      if (!grant.effective_revoked && !expired) actions.append(sessionReadButton({ delegation_id: grant.id }));
    }
    if (grant.can_revoke) {
      const button = document.createElement("button"); button.className = "secondary"; button.textContent = "Weitergabe widerrufen"; button.dataset.available = String(!grant.revoked);
      button.addEventListener("click", () => void perform(button, async () => {
        const approval_id = await approve({ kind: "delegation_revoke", id: grant.id }); await api("/api/delegations/revoke", { id: grant.id, approval_id });
        status("Weitergabe und abhängige Zugänge widerrufen.", false); await refreshDelegations();
      })); actions.append(button);
    }
    row.append(name, badge, detail, parent, id, actions);
    if (grant.can_delegate) {
      const form = document.createElement("form"); form.className = "delegation-form";
      for (const [suffix, labelText, value, min, max] of [
        ["guest", "Empfänger im Labor", "secondguest", undefined, undefined],
        ["ttl", "Gültigkeit in Sekunden", String(Math.max(1, Math.min(120, Math.floor(grant.grant.body.expires_at - Date.now() / 1000) - 1))), "1", "3600"],
        ["budget", "Erlaubte Weitergaben", String(grant.grant.body.remaining_delegations - 1), "0", String(grant.grant.body.remaining_delegations - 1)],
      ] as const) {
        const field = document.createElement("div"); const label = document.createElement("label"); const input = document.createElement("input");
        input.id = `delegation-${index}-${suffix}`; input.name = suffix; input.value = value; input.required = true; label.htmlFor = input.id; label.textContent = labelText;
        if (min !== undefined) { input.type = "number"; input.min = min; input.max = max; } else input.maxLength = 32;
        field.append(label, input); form.append(field);
      }
      const button = document.createElement("button"); button.textContent = "Zugang weitergeben"; button.dataset.available = "true"; form.append(button);
      form.addEventListener("submit", event => { event.preventDefault(); void perform(button, async () => {
        const fields = new FormData(form); const management: Management = { kind: "delegation_delegate", parent_id: grant.id, guest_name: String(fields.get("guest")), ttl_seconds: Number(fields.get("ttl")), remaining_delegations: Number(fields.get("budget")) };
        const approval_id = await approve(management); await api("/api/delegations/delegate", { parent_id: management.parent_id, guest_name: management.guest_name, ttl_seconds: management.ttl_seconds, remaining_delegations: management.remaining_delegations, approval_id });
        status("Zugang innerhalb der bestätigten Grenzen weitergegeben.", false); await refreshDelegations();
      }); }); row.append(form);
    }
    area.append(row);
  }
  sessionControls();
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
el("operation-cancel").addEventListener("click", () => { nativeAbort?.abort(); WebAuthnAbortService.cancelCeremony(); });
el<HTMLFormElement>("delegation-form").addEventListener("submit", event => {
  event.preventDefault(); void perform(el("delegation-issue"), async () => {
    const management: Management = { kind: "delegation_create", guest_name: input("delegation-guest"), ttl_seconds: Number(input("delegation-ttl")), remaining_delegations: Number(input("delegation-budget")) };
    const approval_id = await approve(management); await api("/api/delegations", { guest_name: management.guest_name, ttl_seconds: management.ttl_seconds, remaining_delegations: management.remaining_delegations, approval_id });
    status("Leserecht mit begrenzter Weitergabe vergeben.", false); await refreshDelegations();
  });
});
document.documentElement.dataset.ready = "true";
if (invitedName && /^[a-zA-Z0-9-]{3,32}$/.test(invitedName)) {
  el<HTMLInputElement>("name").value = invitedName;
  el("identity").textContent = `Zugangslink für ${invitedName}. Mit dem eigenen Passkey anmelden.`;
}
if (location.protocol === "https:") el("mode").textContent = "HTTPS · Passkeys · Serverprüfung";


function platformControls(): void {
  for (const id of ["logout", "recovery-rotate", "recovery-disable", "agent-create", "vault-create", "vault-unlock", "vault-recover"]) el<HTMLButtonElement>(id).disabled = inFlight || !session;
  for (const id of ["vault-save", "vault-add-key", "vault-lock"]) el<HTMLButtonElement>(id).disabled = inFlight || !session || !vaultKey;
  el<HTMLButtonElement>("recovery-download").disabled = inFlight || (!recoveryCode && !vaultRecoveryKey);
  el<HTMLButtonElement>("recovery-submit").disabled = inFlight;
  for (const button of el("agent-list").querySelectorAll<HTMLButtonElement>("button")) button.disabled = inFlight || button.dataset.available !== "true";
}
function lockVault(): void {
  vaultKey?.fill(0); vaultKey = undefined;
  el<HTMLTextAreaElement>("vault-text").value = "";
  el<HTMLInputElement>("vault-recovery").value = "";
  el("vault-status").textContent = "Tresor gesperrt. Der Schlüssel wird nur während der Nutzung im Browser gehalten.";
}
function sessionReadButton(body: { grant_id?: string; delegation_id?: string }): HTMLButtonElement {
  const button = document.createElement("button"); button.className = "secondary"; button.textContent = "Mit Sitzung lesen";
  button.addEventListener("click", () => void perform(button, async () => {
    el("result").textContent = JSON.stringify(await api("/api/read", body), null, 2);
    status("Sitzung und aktuelle Berechtigung geprüft. Dokument geöffnet.", false);
  })); return button;
}
async function refreshPlatform(): Promise<void> {
  if (!session) return;
  const [recovery, agents, audit, credentials] = await Promise.all([
    api<{ enabled: boolean; active_passkeys: number }>("/api/recovery"),
    api<{ tasks: { id: string; revoked: boolean; effective_active: boolean; grant: { body: { spec: AgentSpec; expires_at: number } } }[] }>("/api/agents"),
    api<{ events: { event: string; reference: string; created: number }[] }>("/api/audit"),
    api<{ credentials: Credential[] }>("/api/credentials"),
  ]);
  el("recovery-status").textContent = recovery.enabled ? "Ein Einmalcode ist hinterlegt. Er wird nur einmal angezeigt und nur einmal verwendet." : "Noch kein nutzbarer Einmalcode hinterlegt.";
  el("backup-hint").textContent = recovery.active_passkeys < 2 ? "Empfohlen: Jetzt einen zweiten Passkey auf einem unabhängigen Gerät hinzufügen." : `${recovery.active_passkeys} aktive Passkeys. Bewahre mindestens einen Ersatz unabhängig auf.`;
  const list = el("agent-list"); list.replaceChildren();
  if (!agents.tasks.length) { const text = document.createElement("p"); text.className = "empty"; text.textContent = "Noch keine Agentenaufträge. Erstelle den Agentenschlüssel mit dem lokalen Beispielprogramm."; list.append(text); }
  for (const task of agents.tasks) {
    const row = document.createElement("article"); row.className = "agent-card";
    const title = document.createElement("strong"); title.textContent = task.grant.body.spec.name;
    const detail = document.createElement("p"); detail.className = "note";
    detail.textContent = `${task.effective_active ? "Aktiv" : task.revoked ? "Widerrufen" : "Nicht mehr gültig"} · ${task.grant.body.spec.resource} · ${task.grant.body.spec.actions.join(", ")} · bis ${new Date(task.grant.body.expires_at * 1000).toLocaleTimeString("de-DE")}`;
    const id = document.createElement("code"); id.textContent = task.id;
    const button = document.createElement("button"); button.className = "secondary"; button.textContent = "Auftrag widerrufen"; button.dataset.available = String(!task.revoked);
    button.addEventListener("click", () => void perform(button, async () => { const approval_id = await approve({ kind: "agent_revoke", id: task.id }); await api("/api/agents/revoke", { id: task.id, approval_id }); await refreshPlatform(); status("Agentenauftrag widerrufen.", false); }));
    row.append(title, detail, id, button); list.append(row);
  }
  const area = el("audit-list"); area.replaceChildren();
  for (const event of audit.events) {
    const row = document.createElement("div"); row.className = "audit-event";
    const time = document.createElement("time"); time.dateTime = new Date(event.created * 1000).toISOString(); time.textContent = new Date(event.created * 1000).toLocaleString("de-DE");
    const label = document.createElement("span"); label.textContent = event.event;
    row.append(time, label); area.append(row);
  }
  if (!audit.events.length) area.textContent = "Noch keine protokollierten Pilotvorgänge.";
  const select = el<HTMLSelectElement>("vault-credential"); const selected = select.value; select.replaceChildren();
  for (const credential of credentials.credentials.filter(c => c.active)) { const option = document.createElement("option"); option.value = credential.id; option.textContent = credential.label; select.append(option); }
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
  platformControls();
}
function downloadRecovery(): void {
  if (!recoveryCode && !vaultRecoveryKey) throw new Error("Erstelle zuerst einen Einmalcode oder Tresor.");
  const kit = { format: "heavenkey-recovery-kit-v1", account: sessionName, origin: location.origin, created: new Date().toISOString(), account_recovery_code: recoveryCode || null, vault_recovery_key: vaultRecoveryKey || null, instructions: "Offline und getrennt von deinen Geräten aufbewahren. Konto-Code ist einmalig. Der Tresorschlüssel ist unabhängig und entschlüsselt gespeicherte Tresordaten." };
  const url = URL.createObjectURL(new Blob([JSON.stringify(kit, null, 2) + "\n"], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `heavenkey-recovery-${sessionName || "konto"}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status("Sicherung heruntergeladen. Bewahre sie getrennt von deinen Geräten auf.", false);
}
async function prf(credentialId: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (!sessionName) throw new Error("Bitte zuerst anmelden.");
  const start = await api<Ceremony<PublicKeyCredentialRequestOptionsJSON>>("/api/auth/start", { name: sessionName });
  const options = start.options.publicKey;
  const controller = new AbortController(); nativeAbort = controller;
  const key = await passkeyRequest(async () => {
    try {
      return await navigator.credentials.get({ signal: controller.signal, publicKey: {
        challenge: vaultCrypto.decode(options.challenge), rpId: options.rpId, timeout: 60000, userVerification: "required",
        allowCredentials: [{ id: vaultCrypto.decode(credentialId), type: "public-key" }],
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      } }) as PublicKeyCredential | null;
    } finally { nativeAbort = undefined; }
  });
  if (!key) throw new Error("Passkey-Abfrage wurde abgebrochen.");
  const response = key.response as AuthenticatorAssertionResponse;
  const credential = {
    id: key.id, rawId: vaultCrypto.encode(new Uint8Array(key.rawId)), type: key.type,
    response: { clientDataJSON: vaultCrypto.encode(new Uint8Array(response.clientDataJSON)), authenticatorData: vaultCrypto.encode(new Uint8Array(response.authenticatorData)), signature: vaultCrypto.encode(new Uint8Array(response.signature)), userHandle: response.userHandle ? vaultCrypto.encode(new Uint8Array(response.userHandle)) : null },
    clientExtensionResults: {}, ...(key.authenticatorAttachment ? { authenticatorAttachment: key.authenticatorAttachment } : {}),
  };
  setSession(await api<Record<string, unknown>>("/api/auth/finish", { request_id: start.request_id, credential }));
  const result = key.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  if (!result.prf?.results?.first || result.prf.results.first.byteLength !== 32) throw new Error("Dieser Passkey oder Browser bietet hier kein PRF. Deine normale Passkey-Anmeldung funktioniert weiterhin. Nutze für den Tresor ein PRF-fähiges Gerät.");
  return new Uint8Array(result.prf.results.first);
}
async function storeVault(record: vaultCrypto.VaultRecord, expected: number): Promise<void> {
  const { management } = await api<{ management: Management }>("/api/vault/prepare", { expected_revision: expected, record });
  const approval_id = await approve(management);
  const result = await api<{ revision: number }>("/api/vault", { expected_revision: expected, record, approval_id });
  vaultState = { account_id: accountId!, revision: result.revision, record };
  el("vault-status").textContent = `Tresor entsperrt · Version ${result.revision} · ${record.wraps.length} berechtigte Passkeys.`;
  await refreshPlatform();
}
async function createVault(): Promise<void> {
  if (!accountId) throw new Error("Bitte zuerst anmelden.");
  const stored = await api<NonNullable<typeof vaultState>>("/api/vault");
  if (stored.record) throw new Error("Ein Tresor existiert bereits. Entsperre ihn, um seine Daten zu bearbeiten.");
  const current = await api<{ credential_id: string }>("/api/session");
  const salt = vaultCrypto.random(32); const output = await prf(current.credential_id, salt);
  const key = vaultCrypto.random(32); const recovery = vaultCrypto.random(32);
  try {
    const encrypted = await vaultCrypto.seal(el<HTMLTextAreaElement>("vault-text").value, key, accountId);
    const wrapped = await vaultCrypto.wrap(key, output, salt, accountId, current.credential_id);
    const record: vaultCrypto.VaultRecord = { version: 1, ...encrypted, wraps: [{ ...wrapped, credential_id: current.credential_id }], recovery: await vaultCrypto.wrap(key, recovery, vaultCrypto.random(32), accountId, "offline-recovery") };
    await storeVault(record, 0);
    vaultKey?.fill(0); vaultKey = key;
    vaultRecoveryKey = `hk-vault-v1.${vaultCrypto.encode(recovery)}`;
    el("recovery-created").textContent = "Der separate Tresorschlüssel ist jetzt in deiner herunterladbaren Sicherung enthalten. Lade sie vor dem Abmelden herunter.";
    status("Tresor erstellt. Lade jetzt deine Sicherung herunter.", false);
  } catch (error) { key.fill(0); throw error; }
  finally { output.fill(0); recovery.fill(0); }
}
async function unlockVault(): Promise<void> {
  if (!accountId) throw new Error("Bitte zuerst anmelden.");
  vaultState = await api<NonNullable<typeof vaultState>>("/api/vault");
  if (!vaultState.record) throw new Error("Lege zuerst einen Tresor an.");
  const current = await api<{ credential_id: string }>("/api/session");
  const wrapped = vaultState.record.wraps.find(w => w.credential_id === current.credential_id);
  if (!wrapped) throw new Error("Der aktuelle Passkey hat noch keinen Tresorzugang. Melde dich mit einem berechtigten Passkey an oder nutze deinen Tresor-Wiederherstellungsschlüssel.");
  const output = await prf(wrapped.credential_id, vaultCrypto.decode(wrapped.salt));
  try {
    const key = await vaultCrypto.unwrap(wrapped, output, accountId, wrapped.credential_id);
    try { el<HTMLTextAreaElement>("vault-text").value = await vaultCrypto.open(vaultState.record, key, accountId); }
    catch (error) { key.fill(0); throw error; }
    vaultKey?.fill(0); vaultKey = key;
    el("vault-status").textContent = `Tresor lokal entschlüsselt · Version ${vaultState.revision}.`;
    status("Passkey und Tresor geprüft. Daten nur auf diesem Gerät entschlüsselt.", false);
  } finally { output.fill(0); }
}
async function addVaultKey(): Promise<void> {
  if (!accountId || !vaultKey || !vaultState?.record) throw new Error("Entsperre zuerst den Tresor.");
  const id = el<HTMLSelectElement>("vault-credential").value;
  const salt = vaultCrypto.random(32); const output = await prf(id, salt);
  try {
    const wrapped = await vaultCrypto.wrap(vaultKey, output, salt, accountId, id);
    const { credentials } = await api<{ credentials: Credential[] }>("/api/credentials");
    const active = new Set(credentials.filter(c => c.active).map(c => c.id));
    const record = { ...vaultState.record, wraps: [...vaultState.record.wraps.filter(w => w.credential_id !== id && active.has(w.credential_id)), { ...wrapped, credential_id: id }] };
    await storeVault(record, vaultState.revision); status("Zusätzlicher Passkey kann denselben Tresor entsperren.", false);
  } finally { output.fill(0); }
}
async function recoverVault(): Promise<void> {
  if (!accountId) throw new Error("Bitte zuerst anmelden.");
  const value = input("vault-recovery"); el<HTMLInputElement>("vault-recovery").value = "";
  if (!value.startsWith("hk-vault-v1.")) throw new Error("Verwende den separaten Tresorschlüssel aus deiner Sicherung.");
  const recovery = vaultCrypto.decode(value.slice("hk-vault-v1.".length));
  try {
    vaultState = await api<NonNullable<typeof vaultState>>("/api/vault");
    if (!vaultState.record) throw new Error("Kein gespeicherter Tresor vorhanden.");
    const key = await vaultCrypto.unwrap(vaultState.record.recovery, recovery, accountId, "offline-recovery");
    try { el<HTMLTextAreaElement>("vault-text").value = await vaultCrypto.open(vaultState.record, key, accountId); }
    catch (error) { key.fill(0); throw error; }
    vaultKey?.fill(0); vaultKey = key;
    el("vault-status").textContent = "Tresor mit Offline-Schlüssel entsperrt. Berechtige jetzt deinen neuen Passkey.";
    status("Tresor wiederhergestellt. Wähle deinen neuen Passkey und füge ihn zum Tresor hinzu.", false);
  } finally { recovery.fill(0); }
}
for (const [id, action] of [
  ["logout", async () => { await api("/api/logout", {}); clearSession(); status("Abgemeldet. Lokale Sitzung und geöffneter Tresor beendet.", false); }],
  ["recovery-rotate", async () => { const approval_id = await approve({ kind: "recovery_rotate" }); const result = await api<{ code: string }>("/api/recovery/rotate", { approval_id }); recoveryCode = result.code; el("recovery-created").textContent = "Neuer Einmalcode erstellt. Lade die Sicherung jetzt herunter; der Dienst zeigt den Code später nicht mehr an."; await refreshPlatform(); status("Neuen Einmalcode sichern. Der vorherige ist ungültig.", false); }],
  ["recovery-disable", async () => { const approval_id = await approve({ kind: "recovery_disable" }); await api("/api/recovery/disable", { approval_id }); recoveryCode = undefined; await refreshPlatform(); status("Einmalcode gesperrt.", false); }],
  ["recovery-download", async () => downloadRecovery()],
  ["vault-create", createVault], ["vault-unlock", unlockVault], ["vault-add-key", addVaultKey], ["vault-recover", recoverVault],
  ["vault-lock", async () => lockVault()],
  ["vault-save", async () => { if (!accountId || !vaultKey || !vaultState?.record) throw new Error("Entsperre zuerst deinen Tresor."); const { credentials } = await api<{ credentials: Credential[] }>("/api/credentials"); const active = new Set(credentials.filter(c => c.active).map(c => c.id)); const record = { ...vaultState.record, ...await vaultCrypto.seal(el<HTMLTextAreaElement>("vault-text").value, vaultKey, accountId), wraps: vaultState.record.wraps.filter(w => active.has(w.credential_id)) }; await storeVault(record, vaultState.revision); status("Nur verschlüsselte Tresordaten gespeichert.", false); }],
] as const) { const button = el<HTMLButtonElement>(id); button.addEventListener("click", () => void perform(button, action)); }
el<HTMLFormElement>("agent-form").addEventListener("submit", event => {
  event.preventDefault(); void perform(el("agent-create"), async () => {
    const spec: AgentSpec = { name: input("agent-name"), public_key: input("agent-public").trim(), resource: input("agent-resource"), actions: input("agent-actions").split(","), ttl_seconds: Number(input("agent-ttl")), parent_id: input("agent-parent").trim() || null };
    const approval_id = await approve({ kind: "agent_create", spec });
    const result = await api<{ id: string }>("/api/agents", { spec, approval_id });
    el("result").textContent = JSON.stringify({ task_id: result.id, resource: spec.resource, actions: spec.actions }, null, 2);
    await refreshPlatform(); status("Agentenauftrag freigegeben. Nutze die Auftrags-ID im lokalen Agentenprogramm.", false);
  });
});
el<HTMLFormElement>("recovery-form").addEventListener("submit", event => {
  event.preventDefault(); void perform(el("recovery-submit"), async () => {
    const name = input("recovery-name"); const code = input("recovery-code"); el<HTMLInputElement>("recovery-code").value = "";
    const start = await api<Ceremony<PublicKeyCredentialCreationOptionsJSON>>("/api/recovery/start", { name, code, label: input("recovery-label") });
    const credential = await createCredential(start); await api("/api/recovery/finish", { request_id: start.request_id, credential });
    clearSession(); el<HTMLInputElement>("name").value = name;
    status("Konto wiederhergestellt. Melde dich mit dem neuen Passkey an und erstelle einen neuen Einmalcode.", false);
  });
});
void (async () => {
  try {
    const config = await api<{ origin: string; rp_id: string; keystore: string }>("/api/config");
    el("security-summary").textContent = `${config.origin} · Passkey-Domain: ${config.rp_id} · Signierschlüssel: ${config.keystore === "native-os-store" ? "Betriebssystem-Keystore" : "externe Schlüsseldatei"} · Lokaler Pilot`;
  } catch { el("security-summary").textContent = "HeavenKey-Verbindung nicht verfügbar. Prüfe, ob das Programm läuft."; }
  platformControls();
})();
