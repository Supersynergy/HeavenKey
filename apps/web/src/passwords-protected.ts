import { localRequest, type AccessContext } from "./passwords-access";
import { isProtectedId, publishedReferences, REFERENCE_KINDS, resolveProtectedDraft, validatePrivateWorkspaces, validateRecipientPath, type PrivateWorkspace, type ReferenceKind } from "../../../packages/protected/schema";
import { protectedDraftHash, sealProtectedDelivery } from "./passwords-protected-crypto";

type Client = { id: string; label: string; protected: boolean; expires_at: number };
type Broker = { epoch: number; unlocked: boolean; enabled: boolean; public_key: string; clients: Client[] };
type Workspace = { workspace_id: string; client_id: string; status: string; expires_at: number; approved?: boolean; delivery?: "none" | "sending" | "accepted" | "failed" | "unknown"; recipient_path?: string; request_id?: string; draft?: string };
type Preview = { id: string; draft: string; document: string; url: string; epoch: number; revision: number };
const base = "/api/password-broker", workspacesPath = base + "/protected/workspaces";
const aborted = () => new DOMException("Abgebrochen", "AbortError");
const labels: Record<ReferenceKind, string> = { person: "Person", email: "E-Mail", case: "Vorgang" };
function sourceOrigin(url: string) {
 const parsed = new URL(url);
 if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw aborted();
 return parsed.origin;
}
function checkedBroker(value: Broker): Broker {
 if (!value || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || typeof value.unlocked !== "boolean" || typeof value.enabled !== "boolean" || typeof value.public_key !== "string" || value.public_key.length > 2048 || !Array.isArray(value.clients) || value.clients.length > 8) throw aborted();
 for (const client of value.clients) if (!client || typeof client.id !== "string" || typeof client.label !== "string" || client.label.length > 200 || typeof client.protected !== "boolean" || !Number.isSafeInteger(client.expires_at)) throw aborted();
 return value;
}
function checkedWorkspaces(value: { workspaces: Workspace[] }): Workspace[] {
 if (!value || !Array.isArray(value.workspaces) || value.workspaces.length > 128) throw aborted();
 const ids = new Set<string>();
 for (const row of value.workspaces) {
  if (!row || !isProtectedId(row.workspace_id) || ids.has(row.workspace_id) || !isProtectedId(row.client_id) || typeof row.status !== "string" || !/^[a-z_]{1,32}$/.test(row.status) || !Number.isSafeInteger(row.expires_at) || (row.draft != null && (typeof row.draft !== "string" || new TextEncoder().encode(row.draft).length > 8000))) throw aborted();
  ids.add(row.workspace_id);
  if ((row.approved != null && typeof row.approved !== "boolean") || (row.delivery != null && !["none", "sending", "accepted", "failed", "unknown"].includes(row.delivery))) throw aborted();
  if (row.recipient_path != null) validateRecipientPath(row.recipient_path);
 }
 return value.workspaces.map(row => ({ ...row, draft: row.draft ?? undefined, recipient_path: row.recipient_path ?? undefined }));
}
export function initProtectedComposer(ctx: AccessContext, persistence: { get: () => PrivateWorkspace[]; save: (records: PrivateWorkspace[], generation: number) => Promise<void> }) {
 let controller = new AbortController(), lifetime = 0, editing = 0, busy = false, working = false, refreshing = false;
 let broker: Broker | null = null, live: Workspace[] = [], returnFocus: HTMLElement | null = null, previewFocus: HTMLElement | null = null;
 let previewState: Preview | null = null, rendered = "", deliveryAttempted = new Set<string>();
 let poll: ReturnType<typeof setInterval> | undefined, pairTimer: ReturnType<typeof setTimeout> | undefined;
 const settings = document.getElementById("settings-view")!;
 const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
 const button = (text: string, fn: () => void, id = "") => { const el = make("button", text, "secondary"); el.type = "button"; el.id = id; el.onclick = fn; return el; };
 const card = make("section", undefined, "settings-card"); card.id = "protected-composer"; card.tabIndex = -1;
 const status = make("p", "Geschützte Entwürfe benötigen einen entsperrten Tresor.", "note"); status.id = "protected-status"; status.setAttribute("role", "status");
 const add = button("Geschützten Auftrag erstellen", () => openEditor(), "protected-new");
 const pair = button("Geschützten Agenten koppeln", () => void createPairing(), "protected-pair");
 const hidePair = button("Kopplungscode ausblenden", clearPairing); hidePair.dataset.cancel = ""; hidePair.hidden = true;
 const pairing = make("p", undefined, "note"); pairing.id = "protected-pairing-code"; pairing.setAttribute("role", "status");
 const actions = make("div", undefined, "actions"); actions.append(add, pair, hidePair);
 const list = make("ul"); list.id = "protected-records";
 const preview = make("pre"); preview.id = "protected-preview"; preview.tabIndex = -1; preview.hidden = true; preview.setAttribute("aria-label", "Lokale Klartextvorschau");
 const recipient = make("p", undefined, "protected-recipient"); recipient.id = "protected-recipient"; recipient.hidden = true;
 const send = button("An dieses Ziel senden", () => void deliver(), "protected-send"); send.className = ""; send.hidden = true;
 const hidePreview = button("Klartextvorschau schließen", clearPreview); hidePreview.hidden = true; hidePreview.dataset.cancel = "";
 const trust = make("ul", undefined, "broker-trust"); trust.id = "protected-trust";
 for (const text of ["Keine Zwischenablage: Originale werden nur lokal im Tresor und in der Vorschau verwendet.", "Kein Seitenlesen: Der geschützte Agent erhält keine Website-Inhalte.", "Shell-Agenten brauchen --broker-sandbox ohne unabhängigen Hostzugriff.", "Kein externes Sicherheitsaudit; Host, Zielwebsite und Administrator gehören zur Vertrauensgrenze."]) trust.append(make("li", text));
 const disclosure = make("details", undefined, "protected-trust-details"); disclosure.append(make("summary", "Schutz und Vertrauensgrenzen"), trust);
 card.append(make("h2", "Geschützte Entwürfe"), make("p", "Originale bleiben im verschlüsselten Tresor. Der Agent erhält Platzhalter und deine Freigabe, keine Website-Inhalte oder Zustellergebnisse. Anmeldung und Versand bestätigst du jeweils ausdrücklich.", "note"), status, actions, pairing, list, recipient, preview, send, hidePreview, disclosure); settings.append(card);
 const dialog = make("dialog"); dialog.id = "protected-composer-dialog"; dialog.setAttribute("aria-labelledby", "protected-composer-heading");
 const heading = make("h2", "Geschützten Antwortentwurf vorbereiten"); heading.id = "protected-composer-heading";
 const form = make("form"); form.id = "protected-form";
 const clientLabel = make("label", "Geschützter Agent (Bezeichnung nicht überprüft)"); clientLabel.htmlFor = "protected-client";
 const clients = make("select"); clients.id = "protected-client"; clients.required = true;
 const sourceLabel = make("label", "Login für die einmalige Anmeldung"); sourceLabel.htmlFor = "protected-source";
 const sources = make("select"); sources.id = "protected-source"; sources.required = true;
 form.append(clientLabel, clients, sourceLabel, sources);
 const profileLabel = make("label", "Lokales Formularprofil · optional"); profileLabel.htmlFor = "protected-profile";
 const profiles = make("select"); profiles.id = "protected-profile";
 const profileHelp = make("p", "Füllt nur Person und E-Mail aus deinem gewählten Tresorprofil. Du kannst beide Werte ändern.", "note");
 form.append(profileLabel, profiles, profileHelp);
 const inputs = {} as Record<ReferenceKind, HTMLInputElement>;
 const errors = new Map<HTMLInputElement | HTMLSelectElement, HTMLElement>(), touched = new Set<HTMLInputElement | HTMLSelectElement>();
 const helpers: Record<ReferenceKind, string> = { person: "Name der Person, wie er im Antwortentwurf stehen soll.", email: "Format: name@beispiel.de", case: "Zum Beispiel eine Vorgangsnummer. Keine freien Texte werden ausgewertet." };
 for (const kind of REFERENCE_KINDS) {
  const label = make("label", labels[kind] + " · nur lokal"), input = make("input");
  input.id = "protected-" + kind; label.htmlFor = input.id; input.type = kind === "email" ? "email" : "text"; input.autocomplete = "off"; input.maxLength = 1000; input.required = true; input.spellcheck = false; inputs[kind] = input;
  const help = make("p", helpers[kind], "note protected-field-help"); help.id = input.id + "-help"; input.setAttribute("aria-describedby", help.id); input.setAttribute("aria-required", "true"); errors.set(input, help); form.append(label, input, help);
 }
 const recipientLabel = make("label", "Empfängerpfad · optional"); recipientLabel.htmlFor = "protected-recipient-path";
 const recipientPath = make("input"); recipientPath.id = "protected-recipient-path"; recipientPath.autocomplete = "off"; recipientPath.spellcheck = false; recipientPath.maxLength = 512; recipientPath.placeholder = "/nachrichten/senden";
 const recipientHelp = make("p", "Nur ein bekanntes POST-Ziel derselben Login-Website. Ohne Ziel bleibt es bei der lokalen Vorschau.", "note protected-field-help"); recipientHelp.id = "protected-recipient-path-help"; recipientPath.setAttribute("aria-describedby", recipientHelp.id); errors.set(recipientPath, recipientHelp); form.append(recipientLabel, recipientPath, recipientHelp);
 const note = make("p", "Vorlage: kurzer deutscher Antwortentwurf. Zuerst verschlüsselt speichern, danach den Auftrag für höchstens 5 Minuten freigeben. Neue Speicherung beendet vorhandene Freigaben.", "note");
 const submit = make("button", "Verschlüsselt speichern und freigeben"); submit.type = "submit"; submit.id = "protected-publish";
 const cancel = button("Abbrechen", closeEditor); cancel.dataset.cancel = "";
 const formStatus = make("p", "", "note"); formStatus.id = "protected-form-status"; formStatus.setAttribute("role", "status");
 const formActions = make("div", undefined, "actions"); formActions.append(submit, cancel); form.append(note, formStatus, formActions); dialog.append(heading, form); document.body.append(dialog);
 for (const field of [...Object.values(inputs), recipientPath, clients, sources]) {
  if (!errors.has(field)) { const help = make("p", "", "note protected-field-help"); help.id = field.id + "-help"; field.setAttribute("aria-describedby", help.id); field.after(help); errors.set(field, help); }
  field.addEventListener("blur", () => { touched.add(field); validateField(field); });
  field.addEventListener("input", () => { if (touched.has(field)) validateField(field); });
  field.addEventListener("change", () => { if (touched.has(field)) validateField(field); });
 }
 profiles.addEventListener("change", () => {
  const profile = ctx.get().vault?.profiles?.find(item => item.id === profiles.value); if (!profile || !usable()) return;
  const fields = profile.entities, person = fields.name?.trim() || [fields.firstName?.trim(), fields.lastName?.trim()].filter(Boolean).join(" ");
  if (person && new TextEncoder().encode(person).length <= 1000) inputs.person.value = person;
  if (fields.email && new TextEncoder().encode(fields.email).length <= 1000) inputs.email.value = fields.email.trim();
  for (const input of [inputs.person, inputs.email]) if (touched.has(input)) validateField(input);
 });
 function validateField(field: HTMLInputElement | HTMLSelectElement) {
  let error = "";
  if (field === recipientPath) { try { if (field.value) validateRecipientPath(field.value); } catch { error = "Bitte einen Pfad wie /nachrichten/senden ohne Abfrage, Fragment oder Umleitung eingeben."; } }
  else if (!field.value.trim()) error = field === clients ? "Bitte einen geschützten Agenten ausdrücklich wählen." : field === sources ? "Bitte den Login ausdrücklich wählen." : "Bitte dieses lokale Pflichtfeld ausfüllen.";
  else if (new TextEncoder().encode(field.value.trim()).length > 1000) error = "Bitte auf höchstens 1000 UTF-8-Bytes kürzen.";
  else if (field === inputs.email && field.validity.typeMismatch) error = "Bitte eine E-Mail-Adresse im Format name@beispiel.de eingeben.";
  field.setAttribute("aria-invalid", String(!!error));
  errors.get(field)!.textContent = error || (field === recipientPath ? "Nur ein bekanntes POST-Ziel derselben Login-Website. Ohne Ziel bleibt es bei der lokalen Vorschau." : helpers[REFERENCE_KINDS.find(kind => inputs[kind] === field)!] || "");
  return !error;
 }
 function usable() { return ctx.unlocked() && !!ctx.get().vault && !!ctx.get().token && !ctx.get().discreet; }
 function guard(run: number, generation: number, editor?: number) { if (run !== lifetime || !ctx.current(generation) || !usable() || controller.signal.aborted || (editor !== undefined && editor !== editing)) throw aborted(); }
 function clearPairing() { clearTimeout(pairTimer); pairing.textContent = ""; hidePair.hidden = true; }
 function clearPreview(restoreFocus = true) { previewState = null; preview.textContent = ""; recipient.textContent = ""; preview.hidden = true; recipient.hidden = true; send.hidden = true; hidePreview.hidden = true; if (restoreFocus && previewFocus?.isConnected) previewFocus.focus(); previewFocus = null; }
 function closeEditor() {
  editing++; for (const input of [...Object.values(inputs), recipientPath]) input.value = ""; clients.replaceChildren(); sources.replaceChildren(); profiles.replaceChildren(); touched.clear(); formStatus.textContent = ""; form.reset(); for (const field of errors.keys()) { field.removeAttribute("aria-invalid"); errors.get(field)!.textContent = ""; }
  if (dialog.open) dialog.close();
  if (returnFocus?.isConnected) { if (returnFocus instanceof HTMLButtonElement && returnFocus.disabled) card.focus(); else returnFocus.focus(); } returnFocus = null;
 }
 function setBusy(value: boolean) {
  busy = value;
  for (const control of card.querySelectorAll<HTMLButtonElement>("button")) control.disabled = control.hasAttribute("data-cancel") ? false : value || working || !usable();
  add.disabled = value || working || !usable() || !broker?.unlocked || !broker.enabled;
  pair.disabled = value || working || !usable() || !broker?.unlocked || !broker.enabled;
  for (const input of [...Object.values(inputs), recipientPath, profiles, clients, sources, submit]) input.disabled = value || working || !usable();
  cancel.disabled = false; form.setAttribute("aria-busy", String(working)); submit.textContent = working ? "Wird verschlüsselt gespeichert …" : "Verschlüsselt speichern und freigeben";
 }
 function clear() {
  lifetime++; controller.abort(); controller = new AbortController(); clearInterval(poll); poll = undefined; clearPairing(); returnFocus = null; previewFocus = null; closeEditor(); clearPreview();
  broker = null; live = []; rendered = ""; deliveryAttempted.clear(); list.replaceChildren(); working = false; refreshing = false; status.textContent = "Geschützte Entwürfe gesperrt. Lokale Klartexte wurden ausgeblendet."; setBusy(busy);
 }
 function syncClients() {
  const selected = clients.value, available = broker?.clients.filter(client => client.protected && isProtectedId(client.id) && client.expires_at * 1000 > Date.now()) ?? [];
  if (!clients.options.length) { const placeholder = make("option", "Geschützten Agenten wählen"); placeholder.value = ""; clients.append(placeholder); }
  for (const option of Array.from(clients.options)) if (option.value && !available.some(client => client.id === option.value)) option.remove();
  for (const client of available) {
   let option = Array.from(clients.options).find(option => option.value === client.id);
   if (!option) { option = make("option"); option.value = client.id; clients.append(option); }
   if (option.textContent !== client.label) option.textContent = client.label;
  }
  clients.value = available.some(client => client.id === selected) ? selected : "";
 }
 function openEditor(record?: PrivateWorkspace) {
  if (busy || working || !usable() || !broker?.unlocked || !broker.enabled) return;
  closeEditor(); clearPreview(); returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  syncClients();
  const sourcePlaceholder = make("option", "Login ausdrücklich wählen"); sourcePlaceholder.value = ""; sources.append(sourcePlaceholder);
  for (const source of ctx.get().vault!.entries) {
   try { sourceOrigin(source.url); if (!source.password) continue; const option = make("option", source.title); option.value = source.id; sources.append(option); } catch { continue; }
  }
  const profilePlaceholder = make("option", "Profil ausdrücklich wählen"); profilePlaceholder.value = ""; profiles.append(profilePlaceholder);
  for (const profile of ctx.get().vault!.profiles ?? []) { if (!(profile.entities.name || profile.entities.firstName || profile.entities.lastName || profile.entities.email)) continue; const option = make("option", profile.title); option.value = profile.id; profiles.append(option); }
  profiles.disabled = profiles.options.length < 2; profileLabel.hidden = profiles.options.length < 2; profiles.hidden = profiles.options.length < 2; profileHelp.hidden = profiles.hidden;
  if (record) { sources.value = record.source_id; recipientPath.value = record.recipient_path ?? ""; for (const ref of record.references) inputs[ref.kind].value = ref.value; }
  for (const kind of REFERENCE_KINDS) errors.get(inputs[kind])!.textContent = helpers[kind]; errors.get(recipientPath)!.textContent = "Nur ein bekanntes POST-Ziel derselben Login-Website. Ohne Ziel bleibt es bei der lokalen Vorschau.";
  setBusy(busy); dialog.showModal(); clients.focus();
 }
 function ready(grant: Workspace | undefined) { return !!grant && grant.status === "ready" && grant.approved === true && (grant.delivery ?? "none") === "none" && grant.expires_at * 1000 > Date.now() && !deliveryAttempted.has(grant.workspace_id); }
 function showPreview(record: PrivateWorkspace, grant: Workspace | undefined, draft: string, focus: HTMLElement) {
  if (!usable()) return; clearPreview(); previewFocus = focus;
  const document = resolveProtectedDraft(draft, record.references); preview.textContent = document; preview.hidden = false; hidePreview.hidden = false;
  const source = ctx.get().vault!.entries.find(item => item.id === record.source_id)!;
  if (record.recipient_path) {
   const url = sourceOrigin(source.url) + validateRecipientPath(record.recipient_path); recipient.textContent = "Empfänger: " + url; recipient.hidden = false;
   if (new TextEncoder().encode(document).length > 16000) status.textContent = "Die aufgelöste Vorschau überschreitet 16000 UTF-8-Bytes. Für den Versand einen kürzeren Entwurf erstellen.";
   else if (ready(grant) && grant!.recipient_path === record.recipient_path && grant!.draft === draft && broker) {
    previewState = { id: record.id, draft, document, url, epoch: broker.epoch, revision: ctx.get().revision }; send.hidden = false;
   }
  }
  preview.focus();
 }
 function render() {
  if (dialog.open) syncClients();
  const records = validatePrivateWorkspaces(persistence.get(), ctx.get().vault!.entries);
  const fingerprint = JSON.stringify([records, live, live.map(item => item.expires_at * 1000 > Date.now())]);
  if (fingerprint === rendered) { setBusy(busy); return; }
  if (list.contains(document.activeElement)) { setBusy(busy); return; }
  rendered = fingerprint; list.replaceChildren();
  const states: Record<string, string> = { published: "Auftrag freigegeben · Agent kann Anmeldung anfragen", approved: "Anmeldung freigegeben · Agent kann den Entwurf erstellen", pending: "Anmeldung wartet auf deine Freigabe im Agent-Zugriff", running: "Anmeldung wird ausgeführt · Agent kann bereits entwerfen", ready: "Website angemeldet", drafted: "Entwurf liegt vor", failed: "Anmeldung fehlgeschlagen · neuen Auftrag vorbereiten", expired: "Browsersitzung beendet · neuen Auftrag vorbereiten", closed: "Auftrag beendet" };
  const deliveries: Record<string, string> = { sending: "Versand läuft", accepted: "Zielserver hat das Dokument angenommen; keine Lesebestätigung", failed: "Versand fehlgeschlagen · keine Wiederholung dieses Auftrags", unknown: "Versandergebnis unbekannt · vor neuem Auftrag beim Empfänger prüfen" };
  for (const record of records) {
   const grant = live.find(item => item.workspace_id === record.id), row = make("li"), source = ctx.get().vault!.entries.find(item => item.id === record.source_id)!;
   row.append(make("h3", source.title), make("p", new Date(record.created_at).toLocaleString("de-DE") + " · " + (grant ? (grant.expires_at * 1000 <= Date.now() ? "Freigabe abgelaufen · neuen Auftrag vorbereiten" : states[grant.status] ?? "Status prüfen") : "Verschlüsselt gespeichert · als neuen Auftrag vorbereiten"), "note"));
   if (grant?.delivery && deliveries[grant.delivery]) row.append(make("p", deliveries[grant.delivery], "protected-delivery-state"));
   if (grant?.approved) row.append(make("p", "Agent: freigegeben" + (grant.draft ? " · Entwurf vorhanden" : " · Entwurf möglich") + ". Website- und Versandstatus sind nur hier sichtbar.", "note"));
   const controls = make("div", undefined, "actions");
   if (grant?.status === "pending") { const review = button("Anmeldung prüfen", () => { const brokerCard = document.getElementById("broker-settings"); brokerCard?.scrollIntoView({ block: "start" }); brokerCard?.querySelector<HTMLButtonElement>("#broker-requests button")?.focus(); }, "protected-review-" + record.id); review.className = ""; controls.append(review); }
   const prepare = button("Als neuen Auftrag vorbereiten", () => openEditor(record), "protected-prepare-" + record.id); controls.append(prepare);
   const draft = grant?.draft ?? record.draft;
   if (draft !== undefined) {
    try {
     resolveProtectedDraft(draft, record.references);
     const show = button(record.recipient_path && ready(grant) ? "Dokument und Ziel prüfen" : "Lokal im Klartext ansehen", () => showPreview(record, live.find(item => item.workspace_id === record.id), draft, show), "protected-preview-" + record.id); show.className = "";
     show.dataset.protectedPreview = ""; controls.append(show);
     if (grant?.draft && record.draft !== grant.draft) controls.append(button("Entwurf verschlüsselt speichern", () => void saveDraft(record.id, grant.draft!), "protected-save-draft-" + record.id));
    } catch { row.append(make("p", "Entwurf abgewiesen: ungültige Platzhalter oder unzulässiges Format.", "note")); }
   }
   if (grant) controls.append(button("Auftrag widerrufen", () => void revoke(record.id), "protected-revoke-" + record.id));
   controls.append(button("Gespeicherten Auftrag löschen", () => void removeRecord(record.id), "protected-delete-" + record.id)); row.append(controls); list.append(row);
  }
  if (!records.length) list.append(make("li", "Noch keine geschützten Aufträge gespeichert.", "note"));
  setBusy(busy);
 }
 async function refresh() {
  if (!usable()) { clear(); return; }
  if (refreshing || working || settings.hidden || document.hidden) return;
  if (!poll) poll = setInterval(() => { if (!settings.hidden && !document.hidden) void refresh(); }, 3000);
  const run = lifetime, { generation, revision } = ctx.get(); refreshing = true;
  try {
   const result = checkedBroker(await localRequest<Broker>(ctx, base, controller.signal)); guard(run, generation);
   if (ctx.get().revision !== revision) return;
   if (!result.unlocked) { broker = null; live = []; closeEditor(); clearPreview(); status.textContent = "Broker noch gesperrt. Tresor erneut entsperren."; setBusy(busy); return; }
   const rows = checkedWorkspaces(await localRequest<{ workspaces: Workspace[] }>(ctx, workspacesPath, controller.signal)); guard(run, generation);
   if (ctx.get().revision !== revision) return;
   broker = result; live = rows;
   if (previewState) { const current = rows.find(row => row.workspace_id === previewState!.id); if (!ready(current) || current?.draft !== previewState.draft || result.epoch !== previewState.epoch || revision !== previewState.revision || sourceOrigin(previewState.url) + (current?.recipient_path ?? "") !== previewState.url) clearPreview(false); }
   render(); status.textContent = "Originale bleiben im Tresor. Gespeicherte Aufträge werden nach dem Entsperren nicht automatisch freigegeben.";
  } catch { if (run === lifetime && usable()) status.textContent = "Geschützte Aufträge konnten nicht geladen werden."; }
  finally { if (run === lifetime) refreshing = false; }
 }
 async function publish() {
  if (busy || working || !usable() || !broker?.unlocked || !dialog.open) return;
  let valid = true; for (const field of errors.keys()) { touched.add(field); if (!validateField(field)) valid = false; }
  if (!valid) { formStatus.textContent = "Bitte die markierten Felder prüfen."; [...errors.keys()].find(field => field.getAttribute("aria-invalid") === "true")?.focus(); return; }
  const run = lifetime, editor = editing, clientId = clients.value, sourceId = sources.value;
  working = true; formStatus.textContent = "Wird lokal verschlüsselt gespeichert …"; setBusy(busy); let saved = false;
  await ctx.run(async generation => {
   try {
    guard(run, generation, editor);
    const source = ctx.get().vault!.entries.find(item => item.id === sourceId), client = broker?.clients.find(item => item.id === clientId && item.protected);
    if (!source || !client || !isProtectedId(clientId) || client.expires_at * 1000 <= Date.now()) throw aborted();
    const origin = sourceOrigin(source.url);
    const record: PrivateWorkspace = { id: crypto.randomUUID(), created_at: new Date().toISOString(), source_id: sourceId, template: "reply", references: REFERENCE_KINDS.map(kind => ({ id: crypto.randomUUID(), kind, value: inputs[kind].value.trim() })), ...(recipientPath.value ? { recipient_path: validateRecipientPath(recipientPath.value) } : {}) };
    const records = validatePrivateWorkspaces([...persistence.get(), record], ctx.get().vault!.entries);
    await persistence.save(records, generation); saved = true; guard(run, generation, editor);
    const currentBroker = checkedBroker(await localRequest<Broker>(ctx, base, controller.signal)); guard(run, generation, editor);
    if (!currentBroker.unlocked || !currentBroker.enabled || !currentBroker.clients.some(item => item.id === clientId && item.protected && item.expires_at * 1000 > Date.now())) throw aborted();
    const revision = ctx.get().revision;
    await localRequest(ctx, workspacesPath, controller.signal, { workspace_id: record.id, client_id: clientId, epoch: currentBroker.epoch, revision, source_id: sourceId, origin, template: "reply", references: publishedReferences(record), ...(record.recipient_path ? { recipient_path: record.recipient_path } : {}) });
    guard(run, generation, editor); if (revision !== ctx.get().revision) throw aborted();
    closeEditor(); clearPreview(); working = false; await refresh(); guard(run, generation);
    status.textContent = "Verschlüsselt gespeichert und für den geschützten Agenten freigegeben. Anmeldung weiterhin einzeln bestätigen.";
   } catch { if (run === lifetime && usable()) { if (saved) { closeEditor(); live = []; render(); } else if (editor === editing) formStatus.textContent = "Speichern fehlgeschlagen. Eingaben bleiben erhalten; bitte Tresorstatus prüfen und erneut speichern."; status.textContent = saved ? "Verschlüsselt gespeichert; Freigabe fehlgeschlagen. Gespeicherten Auftrag als neuen Auftrag vorbereiten." : "Auftrag konnte nicht gespeichert werden. Eingaben bleiben erhalten."; } }
   finally { if (run === lifetime) { working = false; setBusy(busy); } }
  });
 }
 async function deliver() {
  if (busy || working || !usable() || !broker || !previewState) return;
  const selected = previewState, run = lifetime, generation = ctx.get().generation;
  const check = () => {
   guard(run, generation);
   const grant = live.find(row => row.workspace_id === selected.id);
   if (previewState !== selected || broker?.epoch !== selected.epoch || ctx.get().revision !== selected.revision || !ready(grant) || grant?.draft !== selected.draft || sourceOrigin(selected.url) + (grant?.recipient_path ?? "") !== selected.url) throw aborted();
  };
  working = true; setBusy(busy); status.textContent = "Dokument wird für das angezeigte Ziel verschlüsselt …";
  let attempted = false;
  try {
   check(); const draft_sha256 = await protectedDraftHash(selected.draft); check();
   const sealed = await sealProtectedDelivery(selected.document, selected.url, broker.public_key, selected.id, selected.epoch, selected.revision, draft_sha256, check); check();
   deliveryAttempted.add(selected.id); attempted = true; clearPreview(false);
   await localRequest(ctx, workspacesPath + "/" + encodeURIComponent(selected.id) + "/deliver", controller.signal, { epoch: selected.epoch, revision: selected.revision, draft_sha256, sealed }); guard(run, generation);
   working = false; await refresh(); guard(run, generation); status.textContent = "Einmaliger Versand beauftragt. Den Zustand zeigt der Auftrag; angenommen bedeutet keine Lesebestätigung.";
  } catch { if (run === lifetime && usable()) status.textContent = attempted ? "Versand konnte nicht bestätigt werden. Keine automatische Wiederholung; beim Empfänger prüfen, bevor du einen neuen Auftrag erstellst." : "Versand nicht gestartet. Aktuellen Auftrag und Ziel erneut prüfen."; }
  finally { if (run === lifetime) { working = false; setBusy(busy); } }
 }
 async function mutate(task: (generation: number) => Promise<void>, success: string) {
  if (busy || working || !usable()) return;
  const run = lifetime; working = true; setBusy(busy); clearPreview();
  await ctx.run(async generation => {
   try { guard(run, generation); await task(generation); guard(run, generation); working = false; await refresh(); guard(run, generation); status.textContent = success; }
   catch { if (run === lifetime && usable()) status.textContent = "Änderung konnte nicht bestätigt werden. Aktuellen Status prüfen."; }
   finally { if (run === lifetime) { working = false; setBusy(busy); } }
  });
 }
 async function saveDraft(id: string, draft: string) {
  await mutate(async generation => {
   const records = persistence.get(), record = records.find(item => item.id === id); if (!record) throw aborted(); resolveProtectedDraft(draft, record.references);
   await persistence.save(records.map(item => item.id === id ? { ...item, draft } : item), generation);
  }, "Entwurf verschlüsselt gespeichert. Bisherige Live-Freigaben wurden beendet.");
 }
 async function removeRecord(id: string) { await mutate(async generation => { await persistence.save(persistence.get().filter(item => item.id !== id), generation); }, "Gespeicherten Auftrag gelöscht; bestehende Freigaben beendet."); }
 async function revoke(id: string) { await mutate(async () => { await localRequest(ctx, workspacesPath + "/" + encodeURIComponent(id), controller.signal, undefined, "DELETE"); }, "Auftrag widerrufen; seine Anmeldung wird beendet."); }
 async function createPairing() {
  if (busy || working || !usable() || !broker?.unlocked) return;
  const run = lifetime, generation = ctx.get().generation; working = true; clearPairing(); setBusy(busy);
  try {
   const result = await localRequest<{ code: string; expires_in: number }>(ctx, base + "/protected-pairing", controller.signal, {}); guard(run, generation);
   if (settings.hidden || !/^[A-Za-z0-9_-]{4,64}$/.test(result.code) || result.expires_in !== 120) throw aborted();
   pairing.textContent = "Einmaliger Code für einen geschützten Agenten: " + result.code + " · 2 Minuten gültig."; hidePair.hidden = false; pairTimer = setTimeout(clearPairing, 120000);
  } catch { if (run === lifetime) status.textContent = "Geschützte Kopplung konnte nicht erstellt werden."; }
  finally { if (run === lifetime) { working = false; setBusy(busy); } }
 }
 form.addEventListener("submit", event => { event.preventDefault(); void publish(); });
 list.addEventListener("focusout", () => { setTimeout(() => { if (usable() && !list.contains(document.activeElement)) render(); }, 0); });
 dialog.addEventListener("cancel", event => { event.preventDefault(); closeEditor(); });
 dialog.addEventListener("close", () => { if (sources.childElementCount) closeEditor(); });
 dialog.addEventListener("click", event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeEditor(); } });
 new MutationObserver(() => { if (settings.hidden) { closeEditor(); clearPreview(); clearPairing(); } else void refresh(); }).observe(settings, { attributes: true, attributeFilter: ["hidden"] });
 window.addEventListener("pagehide", clear);
 document.addEventListener("visibilitychange", () => { if (!document.hidden && !settings.hidden) void refresh(); });
 setBusy(false);
 return { clear, setBusy, refresh };
}
