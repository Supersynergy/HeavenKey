import { startRegistration, startAuthentication, WebAuthnAbortService, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON } from "@simplewebauthn/browser";

type Grant = { id: string; guest: string; revoked: boolean; grant: { body: { expires_at: number; resource: string }; signature: number[] } };
type Ceremony<T> = { request_id: string; options: { publicKey: T } };
type Credential = { id: string; label: string; active: boolean; created: number };
type DelegationGrant = { body: { resource: string; expires_at: number; remaining_delegations: number }; signature: number[] };
type Delegation = { id: string; guest: string; grant: DelegationGrant; chain: DelegationGrant[]; parent_id: string | null; revoked: boolean; effective_revoked: boolean; can_delegate: boolean; can_revoke: boolean };
type Management = { kind: "credential_add"; label: string } | { kind: "credential_revoke"; id: string } | { kind: "grant_create"; guest_name: string; ttl_seconds: number } | { kind: "grant_revoke"; id: string } | { kind: "delegation_create"; guest_name: string; ttl_seconds: number; remaining_delegations: number } | { kind: "delegation_delegate"; parent_id: string; guest_name: string; ttl_seconds: number; remaining_delegations: number } | { kind: "delegation_revoke"; id: string };
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
    if (response.status === 401 && (path.startsWith("/api/credentials") || path.startsWith("/api/grants") || path.startsWith("/api/delegations"))) clearSession();
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
  el<HTMLButtonElement>("delegation-issue").disabled = inFlight || !session || !isOwner;
  for (const button of el("delegations").querySelectorAll<HTMLButtonElement>("button")) button.disabled = inFlight || button.dataset.available !== "true";
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
  el("delegations").replaceChildren(message.cloneNode(true));
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
el("operation-cancel").addEventListener("click", () => WebAuthnAbortService.cancelCeremony());
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
