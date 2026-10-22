import { localRequest, type AccessContext } from "./passwords-access";
import { decode64, encode64, freshBytes } from "./passwords-crypto";
import { clients, providers } from "../../../packages/transfers/catalog";
import { validateTransferProfile, validateTransfers, validateTransferPath, type TransferProfile } from "../../../packages/transfers/schema";
import { exportClientProfile } from "../../../packages/transfers/clients";
import { previewFileZilla, exportFileZilla, type TransferImportRow } from "../../../packages/transfers/import";
import { checkedSSHIdentity, resolveSSHProfile, sshFingerprint, validateSSHIdentities, type SSHIdentity } from "../../../packages/transfers/ssh";
import { previewConnection, type ConnectionSuggestion } from "../../../packages/transfers/smart-connection";
import { initSSHStorage } from "./passwords-ssh";

type Operation = "list" | "stat" | "get" | "put";
export type TransferRequest = { id: string; client_id: string; label: string; connection_id: string; operation: Operation; path: string; sha256: string; bytes: number; status: string; expires_at: number };
type Broker = { version: 1; public_key: string; epoch: number; revision: number; requests: TransferRequest[]; audit: { at: number; action: string; result: string }[]; limits: { max_bytes: number; request_seconds: number }; protocols: string[] };
const base = "/api/transfer-broker", utf8 = new TextEncoder();
const aborted = () => new DOMException("Abgebrochen", "AbortError");
export async function generateTransferKey(guard = () => {}): Promise<{ private_key: string; public_key: string }> {
  guard();
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  guard();
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  try {
    guard();
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    guard();
    const name = utf8.encode("ssh-ed25519"), wire = new Uint8Array(4 + name.length + 4 + publicBytes.length), view = new DataView(wire.buffer);
    view.setUint32(0, name.length); wire.set(name, 4); view.setUint32(4 + name.length, publicBytes.length); wire.set(publicBytes, 8 + name.length);
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    return { private_key: "-----BEGIN PRIVATE KEY-----\n" + b64(privateBytes).match(/.{1,64}/g)!.join("\n") + "\n-----END PRIVATE KEY-----\n", public_key: "ssh-ed25519 " + b64(wire) };
  } finally { privateBytes.fill(0); }
}
export async function sealTransferProfile(profile: TransferProfile, request: TransferRequest, publicKey: string, epoch: number, revision: number, discloseContent: boolean, guard = () => {}) {
  guard(); profile = validateTransferProfile(profile); validateTransferPath(request.path, request.operation);
  if (profile.ssh_key_id) throw new Error("Gespeicherten SSH-Schlüssel vor der Freigabe im Besitzerbrowser auflösen.");
  if (profile.id !== request.connection_id || !["list", "stat", "get", "put"].includes(request.operation) || (request.operation === "get" && !discloseContent) || (request.operation === "put" && !/^[a-f0-9]{64}$/.test(request.sha256))) throw new Error("Freigabe passt nicht zur Anfrage.");
  const raw = freshBytes(32), iv = freshBytes(12);
  const plain = utf8.encode(JSON.stringify({ version: 1, profile, operation: request.operation, path: request.path, sha256: request.operation === "put" ? request.sha256 : null, disclose_content: discloseContent }));
  try {
    const rsa = await crypto.subtle.importKey("spki", decode64(publicKey, 1024), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    guard(); const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    guard(); const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode("HeavenKey transfer v1\0" + request.id + "\0" + epoch + "\0" + revision) }, aes, plain);
    guard(); const key = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw); guard();
    return { key: encode64(new Uint8Array(key)), iv: encode64(iv), ciphertext: encode64(new Uint8Array(ciphertext)) };
  } finally { raw.fill(0); plain.fill(0); }
}
function checkedBroker(state: Broker): Broker {
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.epoch) || state.epoch < 0 || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.public_key !== "string" || !Array.isArray(state.requests) || state.requests.length > 32 || !Array.isArray(state.audit) || state.audit.length > 100 || state.limits?.max_bytes !== 1048576 || state.limits.request_seconds !== 300 || !Array.isArray(state.protocols) || state.protocols.some(p => !["sftp", "ftpes"].includes(p))) throw new Error("Ungültiger Transferstatus.");
  for (const row of state.requests) {
    if (!row || !/^[A-Za-z0-9_-]{1,100}$/.test(row.id) || typeof row.connection_id !== "string" || typeof row.client_id !== "string" || typeof row.label !== "string" || row.label.length > 200 || typeof row.status !== "string" || !["list", "stat", "get", "put"].includes(row.operation) || typeof row.sha256 !== "string" || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 1048576 || !Number.isSafeInteger(row.expires_at)) throw new Error("Ungültige Transferanfrage.");
    validateTransferPath(row.path, row.operation);
    if (row.operation === "put" && !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error("Schreibanfrage ohne SHA256.");
  }
  for (const event of state.audit) if (!event || !Number.isSafeInteger(event.at) || typeof event.action !== "string" || event.action.length > 100 || typeof event.result !== "string" || event.result.length > 100) throw new Error("Ungültiges Transferereignis.");
  return state;
}
export function initTransferBroker(ctx: AccessContext, persistence: { get: () => TransferProfile[]; save: (profiles: TransferProfile[]) => Promise<void>; getKeys?: () => SSHIdentity[]; saveState?: (profiles: TransferProfile[], keys: SSHIdentity[], generation?: number) => Promise<void> }) {
  let controller = new AbortController(), lifetime = 0, busy = false, working = false, refreshing = false;
  let state: Broker | null = null, selected: TransferRequest | null = null, draft: TransferProfile | null = null, editorOperation = 0, approvalOperation = 0;
  let returnFocus: HTMLElement | null = null, timer: ReturnType<typeof setInterval> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined, dispatching: string | null = null;
  const settings = document.getElementById("settings-view")!;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text: string, fn: () => void, id = "") => { const node = make("button", text, "secondary"); node.type = "button"; node.id = id; node.onclick = fn; return node; };
  const card = make("section", undefined, "settings-card"); card.id = "transfer-settings"; card.tabIndex = -1;
  const status = make("p", "Transfer benötigt einen entsperrten Tresor.", "note"); status.setAttribute("role", "status");
  const profileList = make("ul"), requestList = make("ul"), audit = make("ul"); profileList.id = "transfer-profiles"; requestList.id = "transfer-requests";
  const add = button("Verbindung hinzufügen", () => openEditor(), "transfer-add");
  const revoke = button("Alle Transferfreigaben widerrufen", () => void revokeAll(), "transfer-revoke-all");
  const exportButton = button("FileZilla ohne Zugangsdaten exportieren", downloadExport, "transfer-export");
  const importLabel = make("label", "FileZilla-Datei zur Vorschau auswählen"); importLabel.htmlFor = "transfer-import";
  const file = make("input"); file.type = "file"; file.accept = ".xml,application/xml,text/xml"; file.id = "transfer-import";
  const preview = make("div"); preview.id = "transfer-import-preview";
  const actions = make("div", undefined, "actions"); actions.append(add, revoke, exportButton);
  const trust = make("ul", undefined, "transfer-trust");
  for (const text of ["Profile: nur im verschlüsselten Tresor", "SFTP verlangt Hostschlüsselvergleich · FTPES verlangt TLS-Prüfung auf beiden Kanälen", "Agent: nur einzeln bestätigte Aktion, höchstens 1 MiB und 5 Minuten", "Download gibt Dateiinhalt an den Agenten weiter", "Shell-Agent benötigt --broker-sandbox ohne zusätzlichen Hostzugriff", "Host, Serverbetreiber und Administrator gehören zur Vertrauensgrenze", "Herausgeber nicht signiert · kein externes Sicherheitsaudit"]) trust.append(make("li", text));
  const clientLabel = make("label", "Externes Transferprogramm"); clientLabel.htmlFor = "transfer-client";
  const clientSelect = make("select"); clientSelect.id = "transfer-client";
  for (const item of clients) { const option = make("option", item.name + " · " + item.platforms.join(", ")); option.value = item.id; clientSelect.append(option); }
  const clientNote = make("p", clients[0]?.note ?? "", "note");
  clientSelect.onchange = () => { clientNote.textContent = clients.find(item => item.id === clientSelect.value)?.note ?? ""; renderProfiles(); };
  const catalog = make("details"), catalogList = make("ul"); catalog.append(make("summary", "Transferprogramme und Anbieter"));
  for (const item of [...clients, ...providers]) {
    const row = make("li"), link = make("a", item.name); link.href = item.docs; link.target = "_blank"; link.rel = "noopener noreferrer";
    row.append(link, document.createTextNode(" · " + item.protocols.join(", ") + " · " + item.platforms.join(", "))); row.append(make("p", item.note, "note")); catalogList.append(row);
  }
  catalog.append(catalogList, make("p", "Katalogeinträge sind Einrichtungshilfen. Zugangsdaten bleiben im Tresor; externe Programme erhalten sie nicht automatisch.", "note"));
  card.append(make("h2", "Dateitransfer"), make("p", "Verwalte SFTP- und FTPES-Verbindungen. Gekoppelte Agenten dürfen für genau ein Profil und einen Pfad anfragen. Metadaten können vertraulich sein.", "note"), status, trust, actions, make("h3", "Verbindungen"), clientLabel, clientSelect, clientNote, profileList, make("h3", "Anfragen und Freigaben"), requestList, make("h3", "Letzte Ereignisse"), audit, importLabel, file, preview, catalog); settings.append(card);
  const sshStorage = persistence.getKeys && persistence.saveState ? initSSHStorage(ctx, { getKeys: persistence.getKeys, getProfiles: persistence.get, save: (keys, profiles, generation) => persistence.saveState!(profiles, keys, generation) }, generateTransferKey) : undefined;
  const editor = make("dialog"); editor.id = "transfer-profile-dialog"; editor.setAttribute("aria-labelledby", "transfer-profile-heading");
  const editorHeading = make("h2", "Transferverbindung"); editorHeading.id = "transfer-profile-heading";
  const form = make("form"), inputs = {} as Record<string, HTMLInputElement | HTMLSelectElement>;
  const field = (name: string, title: string, type = "text", max = 1024) => { const label = make("label", title); const input = make("input"); input.id = "transfer-" + name; label.htmlFor = input.id; input.type = type; input.maxLength = max; input.autocomplete = "off"; inputs[name] = input; form.append(label, input); return input; };
  field("label", "Verbindungsname", "text", 100).required = true;
  const providerLabel = make("label", "Anbieter (Vorgaben prüfen)"); providerLabel.htmlFor = "transfer-provider";
  const provider = make("select"); provider.id = "transfer-provider"; inputs.provider = provider;
  const custom = make("option", "Eigener Server"); custom.value = "custom"; provider.append(custom);
  for (const item of providers) { const option = make("option", item.name); option.value = item.id; provider.append(option); } form.append(providerLabel, provider);
  const providerNote = make("p", "Serverdaten aus deinem Anbieterkonto übernehmen.", "note"); form.append(providerNote);
  const providerDoc = make("a", "Anbieterdokumentation öffnen"); providerDoc.target = "_blank"; providerDoc.rel = "noopener noreferrer"; providerDoc.hidden = true; form.append(providerDoc);
  const protocolLabel = make("label", "Protokoll"); protocolLabel.htmlFor = "transfer-protocol";
  const protocol = make("select"); protocol.id = "transfer-protocol"; inputs.protocol = protocol;
  for (const value of ["sftp", "ftpes"]) { const option = make("option", value === "sftp" ? "SFTP (SSH)" : "FTPES (explizites TLS)"); option.value = value; protocol.append(option); } form.append(protocolLabel, protocol);
  const quickLabel = make("label", "Verbindungsdaten einfügen (optional)"); quickLabel.htmlFor = "transfer-smart-input";
  const quickInput = make("input"); quickInput.id = "transfer-smart-input"; quickInput.type = "text"; quickInput.maxLength = 1000; quickInput.autocomplete = "off"; quickInput.placeholder = "ssh benutzer@server -p 22 oder ftpes://benutzer@server:21";
  const quickPreview = make("p", undefined, "note"); quickPreview.id = "transfer-smart-preview"; quickPreview.setAttribute("role", "status");
  let suggestion: ConnectionSuggestion | null = null;
  const quickApply = button("Geprüfte Felder übernehmen", () => {
    if (!suggestion || !usable() || busy || working) return;
    provider.value = "custom"; provider.onchange?.(new Event("change")); protocol.value = suggestion.protocol; protocol.onchange?.(new Event("change"));
    inputs.host.value = suggestion.host; port.value = String(suggestion.port); inputs.username.value = suggestion.username;
    if (!inputs.label.value.trim()) inputs.label.value = suggestion.host;
    quickPreview.textContent = "Server, Benutzer, Port und Protokoll übernommen. Hostidentität und Anmeldung selbst prüfen."; suggestion = null; quickApply.hidden = true; inputs.host.focus();
  }, "transfer-smart-apply"); quickApply.hidden = true;
  const quickCheck = button("Vorschau prüfen", () => {
    const value = quickInput.value; quickInput.value = ""; suggestion = null; quickApply.hidden = true;
    try { suggestion = previewConnection(value); quickPreview.textContent = `${suggestion.protocol.toUpperCase()} · ${suggestion.host}:${suggestion.port} · Benutzer: ${suggestion.username || "noch ergänzen"}. Keine Anmeldung, keine Befehlsausführung.`; quickApply.hidden = false; }
    catch (error) { quickPreview.textContent = (error as Error).message; }
  }, "transfer-smart-check");
  form.append(quickLabel, quickInput, quickCheck, quickPreview, quickApply);
  field("host", "Servername oder IP (keine URL)", "text", 253).required = true;
  const port = field("port", "Port", "number", 5); port.min = "1"; port.max = "65535"; port.required = true;
  field("username", "Benutzername", "text", 256).required = true;
  field("root", "Erlaubtes Stammverzeichnis", "text", 1024).required = true;
  (inputs.root as HTMLInputElement).readOnly = true;
  form.append(make("p", "Verwende einen eigenen, beim Anbieter auf den Zielordner begrenzten Transferbenutzer. / bezeichnet dessen gesamtes Konto. Die Ordnergrenze muss der Server erzwingen; Unterordnerprüfungen allein schützen nicht vor Symlinks und konkurrierenden Änderungen. HeavenKey kann die Serverkonfiguration nicht unabhängig bestätigen.", "note"));
  const hostKey = field("host_key", "SFTP-Hostfingerabdruck (SHA256, beim Anbieter prüfen)", "text", 100);
  const password = field("password", "Passwort (leer bei SSH-Schlüsselpaar)", "password", 4096);
  const identityLabel = make("label", "Gespeicherter SSH-Schlüssel"); identityLabel.htmlFor = "transfer-ssh-key";
  const identitySelect = make("select"); identitySelect.id = "transfer-ssh-key"; form.append(identityLabel, identitySelect);
  identitySelect.onchange = () => {
    if (!draft) return;
    delete draft.ssh_key_id;
    if (identitySelect.value) {
      const identity = persistence.getKeys?.().find(key => key.id === identitySelect.value); if (!identity) return;
      draft.ssh_key_id = identity.id; draft.private_key = ""; draft.public_key = ""; password.value = ""; publicKey.value = identity.public_key;
    } else publicKey.value = draft.public_key;
  };
  password.oninput = () => { if (draft && password.value) { delete draft.ssh_key_id; identitySelect.value = ""; publicKey.value = ""; } };
  const keygen = button("Ed25519-Schlüsselpaar im Browser erzeugen", () => void createKey(), "transfer-generate-key");
  const publicLabel = make("label", "Öffentlicher Schlüssel für den Server"); publicLabel.htmlFor = "transfer-public-key";
  const publicKey = make("textarea"); publicKey.id = "transfer-public-key"; publicKey.readOnly = true; publicKey.rows = 3;
  const advanced = make("details"); advanced.id = "transfer-ca-settings";
  const caLabel = make("label", "Eigene Stammzertifizierungsstelle (optional)"); caLabel.htmlFor = "transfer-ca-certificate";
  const ca = make("textarea"); ca.id = "transfer-ca-certificate"; ca.rows = 6; ca.maxLength = 16384; ca.spellcheck = false;
  ca.setAttribute("aria-describedby", "transfer-ca-explanation");
  const caExplanation = make("p", "Ohne eigenes Zertifikat gelten die System-Stammzertifikate. Mit einem PEM-Zertifikat vertraust du dieser CA ausdrücklich für den konfigurierten FTPES-Server. Nur öffentliche CERTIFICATE-Daten einfügen. Hostname und Zertifikatskette müssen weiterhin stimmen. Die Verbindung ist dadurch noch nicht geprüft.", "note"); caExplanation.id = "transfer-ca-explanation";
  advanced.append(make("summary", "Erweiterte FTPES-Vertrauenseinstellungen"), caLabel, ca, caExplanation);
  const editorStatus = make("p", undefined, "note"); editorStatus.setAttribute("role", "status");
  const save = make("button", "Verschlüsselt speichern"); save.type = "submit"; save.id = "transfer-save";
  const editorCancel = button("Abbrechen", closeEditor); editorCancel.dataset.cancel = "";
  const editorActions = make("div", undefined, "actions"); editorActions.append(save, editorCancel);
  form.append(keygen, publicLabel, publicKey, make("p", "Der private Schlüssel bleibt im verschlüsselten Tresor. Das öffentliche Schlüsselfeld darfst du beim Anbieter hinterlegen. Ein neuer Schlüssel ersetzt den bisherigen beim Speichern.", "note"), advanced, editorStatus, editorActions); editor.append(editorHeading, form); document.body.append(editor);
  const dialog = make("dialog"); dialog.id = "transfer-approval-dialog"; dialog.setAttribute("aria-labelledby", "transfer-approval-heading");
  const heading = make("h2", "Transfer einzeln freigeben"); heading.id = "transfer-approval-heading";
  const description = make("p"); description.id = "transfer-request-detail";
  const binding = make("pre"); binding.id = "transfer-request-binding";
  const approveForm = make("form"), consentLabel = make("label", undefined, "checkbox"), consent = make("input"); consent.type = "checkbox"; consent.id = "transfer-consent";
  const consentText = document.createTextNode(""); consentLabel.append(consent, consentText);
  const approve = make("button", "Einmal freigeben"); approve.type = "submit"; approve.id = "transfer-approve";
  const cancel = button("Abbrechen", cancelApproval); cancel.dataset.cancel = "";
  const approveActions = make("div", undefined, "actions"); approveActions.append(approve, cancel);
  approveForm.append(consentLabel, approveActions); dialog.append(heading, description, binding, make("p", "Agentenbezeichnungen sind ungeprüft. Jede Freigabe gilt nur für die angezeigte Operation, Verbindung und Datei. Auch Verzeichnis- und Dateimetadaten werden dem Agenten offengelegt.", "note"), approveForm); document.body.append(dialog);
  const usable = () => ctx.unlocked() && !!ctx.get().vault && !!ctx.get().token && !ctx.get().discreet;
  function guard(run: number, generation: number) { if (run !== lifetime || !ctx.current(generation) || !usable() || controller.signal.aborted) throw aborted(); }
  function focusBack() { if (returnFocus?.isConnected && !(returnFocus instanceof HTMLButtonElement && returnFocus.disabled)) returnFocus.focus(); else card.focus(); returnFocus = null; }
  function closeEditor() { editorOperation++; draft = null; form.reset(); ca.value = ""; advanced.open = false; publicKey.value = ""; editorStatus.textContent = ""; quickInput.value = ""; quickPreview.textContent = ""; suggestion = null; quickApply.hidden = true; if (editor.open) editor.close(); focusBack(); }
  function closeApproval() { approvalOperation++; clearTimeout(expiryTimer); selected = null; consent.checked = false; description.textContent = ""; binding.textContent = ""; if (dialog.open) dialog.close(); focusBack(); }
  function cancelApproval() { const id = dispatching; dispatching = null; closeApproval(); if (id && usable()) void removeRequest(id); }
  function setBusy(value: boolean) {
    busy = value; const disabled = busy || working || !usable();
    sshStorage?.setBusy(value);
    for (const control of card.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")) control.disabled = disabled || control.dataset.unsupported === "true";
    clientSelect.disabled = disabled;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button")) control.disabled = control.hasAttribute("data-cancel") ? false : disabled;
    ca.disabled = disabled || protocol.value !== "ftpes";
    approve.disabled = disabled || !state?.epoch || !selected || !consent.checked; consent.disabled = disabled; cancel.disabled = false;
    form.setAttribute("aria-busy", String(working)); approveForm.setAttribute("aria-busy", String(working));
  }
  function protocolChanged() {
    inputs.root.value = "/";
    const ssh = protocol.value === "sftp"; advanced.hidden = ssh; ca.disabled = ssh || busy || working; if (ssh) { ca.value = ""; if (draft) delete draft.ca_certificate; } hostKey.required = ssh; hostKey.disabled = !ssh; keygen.hidden = !ssh;
    identityLabel.hidden = identitySelect.hidden = !ssh || !persistence.getKeys;
    if (!ssh) { hostKey.value = ""; publicKey.value = ""; identitySelect.value = ""; if (draft) { draft.private_key = ""; draft.public_key = ""; delete draft.ssh_key_id; } }
  }
  provider.onchange = () => {
    const item = providers.find(p => p.id === provider.value); providerDoc.hidden = !item; if (item) providerDoc.href = item.docs; providerNote.textContent = item?.note ?? "Serverdaten aus deinem Anbieterkonto übernehmen.";
    for (const option of [...protocol.options]) option.disabled = !!item && !(item.protocols as readonly string[]).includes(option.value);
    protocol.value = item?.protocol ?? "sftp";
    port.value = String(item?.port ?? 22); protocolChanged();
  };
  protocol.onchange = () => { const item = providers.find(p => p.id === provider.value); port.value = String(item && item.protocol === protocol.value ? item.port : protocol.value === "sftp" ? 22 : 21); protocolChanged(); };
  consent.onchange = () => setBusy(busy);
  function openEditor(existing?: TransferProfile | TransferImportRow) {
    if (!usable() || busy || working) return;
    returnFocus = document.activeElement as HTMLElement; editorOperation++;
    draft = existing && "id" in existing ? { ...existing } : { id: crypto.randomUUID(), label: "", provider: "custom", protocol: "sftp", host: "", port: 22, username: "", root: "/", host_key: "", password: "", private_key: "", public_key: "", ...(existing ? { label: existing.label, host: existing.host, port: existing.port, username: existing.username, protocol: existing.protocol, root: existing.root } : {}) };
    for (const [key, input] of Object.entries(inputs)) input.value = String(draft[key as keyof TransferProfile]);
    identitySelect.replaceChildren(); const blankIdentity = make("option", "Passwort oder neues Schlüsselpaar verwenden"); blankIdentity.value = ""; identitySelect.append(blankIdentity);
    for (const key of persistence.getKeys?.() ?? []) { const option = make("option", key.label + " · " + sshFingerprint(key.public_key)); option.value = key.id; identitySelect.append(option); }
    identitySelect.value = draft.ssh_key_id ?? "";
    ca.value = draft.ca_certificate ?? ""; publicKey.value = (persistence.getKeys?.() ?? []).find(key => key.id === draft?.ssh_key_id)?.public_key ?? draft.public_key; const item = providers.find(p => p.id === draft?.provider); providerDoc.hidden = !item; if (item) providerDoc.href = item.docs; providerNote.textContent = item?.note ?? "Serverdaten aus deinem Anbieterkonto übernehmen."; for (const option of [...protocol.options]) option.disabled = !!item && !item.protocols.includes(option.value as "sftp" | "ftpes"); protocolChanged(); editor.showModal(); inputs.label.focus(); setBusy(busy);
    if (existing && "warnings" in existing) editorStatus.textContent = existing.warnings.join(" ");
  }
  async function createKey() {
    if (!draft || !usable() || busy || working || protocol.value !== "sftp") return;
    const run = lifetime, generation = ctx.get().generation, operation = editorOperation; working = true; setBusy(busy);
    try { const pair = await generateTransferKey(() => { guard(run, generation); if (operation !== editorOperation || !editor.open || protocol.value !== "sftp") throw aborted(); }); if (!draft) throw aborted(); delete draft.ssh_key_id; identitySelect.value = ""; draft.private_key = pair.private_key; draft.public_key = pair.public_key; publicKey.value = pair.public_key; password.value = ""; editorStatus.textContent = "Schlüsselpaar erzeugt. Öffentlichen Schlüssel beim Anbieter hinterlegen; danach verschlüsselt speichern."; }
    catch (error) { if (run === lifetime && operation === editorOperation && (error as Error).name !== "AbortError") editorStatus.textContent = "Schlüsselerzeugung fehlgeschlagen. Browser muss Ed25519 unterstützen."; }
    finally { if (run === lifetime) { working = false; setBusy(busy); } }
  }
  form.onsubmit = event => {
    event.preventDefault(); if (!draft || busy || working || !usable()) return;
    const run = lifetime, generation = ctx.get().generation, operation = editorOperation;
    let profile: TransferProfile;
    try {
      profile = validateTransferProfile({ ...draft, ...(protocol.value === "ftpes" ? { ca_certificate: ca.value } : {}), ...Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, key === "port" ? Number(input.value) : input.value])), ...(password.value ? { private_key: "", public_key: "" } : {}) });
      const item = providers.find(p => p.id === profile.provider); if (item && !(item.protocols as readonly string[]).includes(profile.protocol)) throw new Error("Protokoll wird vom Anbieter nicht unterstützt.");
    } catch (error) { editorStatus.textContent = (error as Error).message; return; }
    working = true; setBusy(busy);
    void (async () => {
      try {
        guard(run, generation); if (operation !== editorOperation) throw aborted();
        const keys = [...(persistence.getKeys?.() ?? [])];
        if (persistence.saveState && profile.private_key) {
          let identity = keys.find(key => sshFingerprint(key.public_key) === sshFingerprint(profile.public_key));
          if (!identity) { identity = await checkedSSHIdentity(profile.label, profile.private_key, profile.public_key, () => { guard(run, generation); if (operation !== editorOperation) throw aborted(); }); keys.push(identity); }
          profile = { ...profile, private_key: "", public_key: "", ssh_key_id: identity.id };
        }
        const rows = validateTransfers([...persistence.get().filter(p => p.id !== profile.id), profile]);
        if (persistence.saveState) await persistence.saveState(rows, validateSSHIdentities(keys)); else await persistence.save(rows);
        if (run !== lifetime) return;
        guard(run, generation); if (operation !== editorOperation) return;
        closeEditor(); preview.replaceChildren(); renderProfiles(); ctx.announce("Transferprofil verschlüsselt gespeichert.");
      } catch (error) { if (run === lifetime && operation === editorOperation && (error as Error).name !== "AbortError") editorStatus.textContent = "Speichern fehlgeschlagen. Tresorstatus prüfen."; }
      finally { if (run === lifetime) { working = false; setBusy(busy); } }
    })();
  };
  function renderProfiles() {
    profileList.replaceChildren(); if (!usable()) return;
    for (const p of persistence.get()) {
      const identifier = make("code", p.id);
      const verified = state?.requests.some(r => r.connection_id === p.id && r.status === "completed");
      const verification = p.protocol === "ftpes" ? (verified ? "TLS und Servername bei Transfer in dieser Sitzung geprüft" : "TLS-Prüfung steht aus") : (verified ? "Hostschlüssel bei Transfer in dieser Sitzung abgeglichen" : "Hostschlüsselvergleich steht aus");
      const row = make("li"); row.append(make("p", p.label + " · " + p.protocol.toUpperCase() + " · " + p.host + ":" + p.port + " · " + p.root + (p.protocol === "ftpes" ? " · " + (p.ca_certificate ? "Eigene CA ausdrücklich vertraut" : "System-CA") : "") + " · " + verification));
      const edit = button("Bearbeiten", () => openEditor(p), "transfer-edit-" + p.id); edit.setAttribute("aria-label", p.label + " bearbeiten");
      const remove = button("Profil entfernen", () => void removeProfile(p.id), "transfer-remove-" + p.id);
      const handoff = button("Für Programm exportieren", () => {
        try { const output = exportClientProfile(clientSelect.value, p); const url = URL.createObjectURL(new Blob([output.content], { type: output.mime })); const link = make("a"); link.href = url; link.download = output.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = output.notice; }
        catch (error) { status.textContent = (error as Error).message; }
      }, "transfer-export-" + p.id);
      handoff.disabled = !clients.find(item => item.id === clientSelect.value)?.protocols.includes(p.protocol); handoff.dataset.unsupported = String(handoff.disabled);
      row.dataset.profileId = p.id; row.append(identifier, edit, remove, handoff); profileList.append(row);
    }
    if (!profileList.childElementCount) profileList.append(make("li", "Noch keine Verbindung. Füge einen Server hinzu.", "note")); setBusy(busy);
  }
  async function removeProfile(id: string) {
    if (busy || working || !usable()) return;
    const run = lifetime, generation = ctx.get().generation; working = true; setBusy(busy);
    try {
      guard(run, generation); await localRequest(ctx, base + "/lock", controller.signal, {}); guard(run, generation);
      await persistence.save(persistence.get().filter(item => item.id !== id));
      if (run !== lifetime) return;
      guard(run, generation); closeApproval(); renderProfiles(); await refresh(); ctx.announce("Transferprofil entfernt; Freigaben widerrufen.");
    } catch (error) { if (run === lifetime && (error as Error).name !== "AbortError") status.textContent = "Profil konnte nicht entfernt werden. Status prüfen."; }
    finally { if (run === lifetime) { working = false; setBusy(busy); } }
  }
  function openApproval(request: TransferRequest) {
    if (!usable() || busy || working || !state?.epoch || request.expires_at * 1000 <= Date.now()) return;
    const p = persistence.get().find(p => p.id === request.connection_id); if (!p) { status.textContent = "Das angefragte Profil ist nicht vorhanden."; return; }
    selected = { ...request }; returnFocus = document.activeElement as HTMLElement; consent.checked = false;
    description.textContent = request.label + " (ungeprüft) · " + p.label + " · " + p.protocol.toUpperCase() + " · " + p.host + ":" + p.port + (p.protocol === "ftpes" ? " · " + (p.ca_certificate ? "Eigene CA" : "System-CA") + " · TLS-Prüfung erfolgt beim Verbindungsaufbau" : " · Hostschlüsselvergleich erfolgt beim Verbindungsaufbau");
    binding.textContent = "Operation: " + request.operation + "\nStammverzeichnis: " + p.root + "\nPfad: " + (request.path || "(Stammverzeichnis)") + "\nBytes: " + request.bytes + (request.operation === "put" ? "\nSHA256: " + request.sha256 : "");
    consentText.textContent = request.operation === "get" ? " Ich erlaube, den gesamten Inhalt dieser Datei an diesen Agenten weiterzugeben." : request.operation === "put" ? " Ich erlaube, genau diesen Inhalt mit dem angezeigten SHA256 an diesen Pfad zu schreiben und eine vorhandene Datei zu ersetzen." : " Ich erlaube, genau diese Datei- oder Verzeichnismetadaten an diesen Agenten weiterzugeben.";
    expiryTimer = setTimeout(closeApproval, Math.max(0, request.expires_at * 1000 - Date.now())); dialog.showModal(); consent.focus(); setBusy(busy);
  }
  approveForm.onsubmit = event => {
    event.preventDefault(); if (busy || working || !consent.checked || !selected || !state?.epoch) return;
    const request = { ...selected }, snapshot = { ...state }, run = lifetime, generation = ctx.get().generation, operation = approvalOperation;
    const assert = () => { guard(run, generation); if (operation !== approvalOperation || !dialog.open || !consent.checked || selected?.id !== request.id || request.expires_at * 1000 <= Date.now() || state?.epoch !== snapshot.epoch || state.revision !== snapshot.revision || ctx.get().revision !== snapshot.revision) throw aborted(); };
    working = true; setBusy(busy);
    void (async () => {
      try {
        assert(); const profile = persistence.get().find(p => p.id === request.connection_id); if (!profile) throw aborted();
        const resolved = resolveSSHProfile(profile, persistence.getKeys?.() ?? []);
        const sealed = await sealTransferProfile(resolved, request, snapshot.public_key, snapshot.epoch, snapshot.revision, request.operation === "get", assert);
        assert(); dispatching = request.id;
        await localRequest(ctx, base + "/approve/" + encodeURIComponent(request.id), controller.signal, { epoch: snapshot.epoch, revision: snapshot.revision, sealed });
        assert(); dispatching = null; closeApproval(); status.textContent = "Einmalige Transferfreigabe erteilt. Du kannst sie jederzeit widerrufen."; await refresh();
      } catch (error) { if (run === lifetime && operation === approvalOperation && (error as Error).name !== "AbortError") { status.textContent = "Transferfreigabe fehlgeschlagen. Status prüfen oder widerrufen."; } }
      finally { if (run === lifetime) { working = false; setBusy(busy); } }
    })();
  };
  async function removeRequest(id: string) {
    const run = lifetime, generation = ctx.get().generation; try { guard(run, generation); await localRequest(ctx, base + "/requests/" + encodeURIComponent(id), controller.signal, undefined, "DELETE"); guard(run, generation); await refresh(); }
    catch { if (run === lifetime) status.textContent = "Widerruf konnte nicht bestätigt werden. Tresor sperren und Status prüfen."; }
  }
  async function revokeAll() { const run = lifetime, generation = ctx.get().generation; try { guard(run, generation); await localRequest(ctx, base + "/lock", controller.signal, {}); guard(run, generation); dispatching = null; closeApproval(); status.textContent = "Alle Transferfreigaben widerrufen."; await refresh(); } catch { if (run === lifetime) status.textContent = "Widerruf konnte nicht bestätigt werden. Tresor sperren."; } }
  async function refresh() {
    if (!usable() || refreshing) return; const run = lifetime, generation = ctx.get().generation; refreshing = true;
    try {
      const response = checkedBroker(await localRequest<Broker>(ctx, base, controller.signal)); guard(run, generation);
      if (state && (state.epoch !== response.epoch || state.revision !== response.revision)) closeApproval();
      state = response;
      if (selected && !state.requests.some(r => JSON.stringify(r) === JSON.stringify(selected) && r.status === "pending")) closeApproval();
      const focused = (document.activeElement as HTMLElement)?.id; requestList.replaceChildren(); audit.replaceChildren();
      for (const request of state.requests) {
        const row = make("li"); row.append(make("p", request.label + " (ungeprüft) · " + request.operation + " · " + (request.path || "/") + " · " + request.status));
        if (request.status === "pending" && request.expires_at * 1000 > Date.now()) row.append(button("Anfrage prüfen", () => openApproval(request), "transfer-review-" + request.id));
        row.append(button(request.status === "pending" ? "Ablehnen" : "Freigabe widerrufen", () => void removeRequest(request.id), "transfer-deny-" + request.id)); requestList.append(row);
      }
      if (!requestList.childElementCount) requestList.append(make("li", "Keine Transferanfragen.", "note"));
      for (const item of state.audit.slice(-10).reverse()) audit.append(make("li", new Date(item.at * 1000).toLocaleTimeString("de-DE") + " · " + item.action + " · " + item.result));
      status.textContent = state.epoch ? "Transfer bereit. Jede Aktion benötigt deine Freigabe." : "Transfer wartet auf den lokalen Agent-Broker. Status wird erneut geprüft.";
      renderProfiles(); if (!dialog.open && !editor.open && focused) document.getElementById(focused)?.focus();
    } catch { if (run === lifetime) { state = null; closeApproval(); status.textContent = "Transferstatus noch nicht verfügbar. Erneuter Versuch folgt automatisch."; } }
    finally { if (run === lifetime) { refreshing = false; setBusy(busy); } }
  }
  file.onchange = () => {
    const source = file.files?.[0], run = lifetime, generation = ctx.get().generation; file.value = ""; preview.replaceChildren(); if (!source || !usable()) return;
    if (source.size > 1_000_000) { status.textContent = "Importdatei überschreitet 1 MB."; return; }
    void source.text().then(xml => {
      guard(run, generation); const rows = previewFileZilla(xml);
      preview.append(make("p", "Vorschau: Zugangsdaten werden verworfen. Jede Verbindung einzeln prüfen und speichern.", "note"));
      for (const row of rows) { const item = make("p", row.label + " · " + row.protocol.toUpperCase() + " · " + row.host + ":" + row.port + ". " + row.warnings.join(" ")); item.append(button("Verbindung prüfen", () => openEditor(row))); preview.append(item); }
    }).catch(error => { if (run === lifetime && (error as Error).name !== "AbortError") status.textContent = "Import fehlgeschlagen: " + (error as Error).message; });
  };
  function downloadExport() {
    if (!usable() || busy || working) return;
    const url = URL.createObjectURL(new Blob([exportFileZilla(persistence.get())], { type: "application/xml" })), link = make("a"); link.href = url; link.download = "heavenkey-filezilla-ohne-zugangsdaten.xml"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.announce("Serverdaten ohne Benutzername, Passwort oder Schlüssel exportiert.");
  }
  for (const [node, close] of [[editor, closeEditor], [dialog, cancelApproval]] as const) {
    node.addEventListener("cancel", event => { event.preventDefault(); close(); }); node.addEventListener("click", event => { if (event.target === node) { const rect = node.getBoundingClientRect(); const e = event as MouseEvent; if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) close(); } });
  }
  function clear(notify = true) {
    const token = ctx.get().token;
    if (notify && token) void fetch(base + "/lock", { method: "POST", credentials: "omit", cache: "no-store", keepalive: true, headers: { "Content-Type": "application/json", "X-HeavenKey-Client": "password-manager", "X-HeavenKey-Token": token }, body: "{}" }).catch(() => { ctx.announce("Transfer-Widerruf konnte nicht bestätigt werden. Brokerstatus prüfen.", true); });
    lifetime++; controller.abort(); controller = new AbortController(); clearInterval(timer); timer = undefined; state = null; dispatching = null; working = false; refreshing = false; returnFocus = null;
    sshStorage?.clear();
    closeEditor(); closeApproval(); preview.replaceChildren(); profileList.replaceChildren(); requestList.replaceChildren(); audit.replaceChildren(); file.value = ""; status.textContent = "Transfer gesperrt; lokale Profildaten ausgeblendet."; setBusy(busy);
  }
  async function unlocked() { if (!usable()) return; sshStorage?.refresh(); if (!timer) timer = setInterval(() => { if (!usable()) clear(); else if (!settings.hidden && !document.hidden) void refresh(); }, 3000); renderProfiles(); if (!settings.hidden) await refresh(); }
  const observer = new MutationObserver(() => { if (settings.hidden) { closeEditor(); cancelApproval(); preview.replaceChildren(); } else void refresh(); }); observer.observe(settings, { attributes: true, attributeFilter: ["hidden"] });
  setBusy(false); return { unlocked, clear, setBusy };
}
