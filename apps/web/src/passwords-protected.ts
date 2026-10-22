import { localRequest, type AccessContext } from "./passwords-access";
import { isProtectedId, publishedReferences, REFERENCE_KINDS, resolveProtectedDraft, validatePrivateWorkspaces, type PrivateWorkspace, type ReferenceKind } from "../../../packages/protected/schema";

type Client = { id: string; label: string; protected: boolean; expires_at: number };
type Broker = { epoch: number; unlocked: boolean; enabled: boolean; clients: Client[] };
type Workspace = { workspace_id: string; client_id: string; status: string; expires_at: number; request_id?: string; draft?: string };
const base = "/api/password-broker", workspacesPath = base + "/protected/workspaces";
const aborted = () => new DOMException("Abgebrochen", "AbortError");
const labels: Record<ReferenceKind, string> = { person: "Person", email: "E-Mail", case: "Vorgang" };
function sourceOrigin(url: string) {
 const parsed = new URL(url);
 if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw aborted();
 return parsed.origin;
}
function checkedBroker(value: Broker): Broker {
 if (!value || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || typeof value.unlocked !== "boolean" || typeof value.enabled !== "boolean" || !Array.isArray(value.clients) || value.clients.length > 8) throw aborted();
 for (const client of value.clients) if (!client || typeof client.id !== "string" || typeof client.label !== "string" || client.label.length > 200 || typeof client.protected !== "boolean" || !Number.isSafeInteger(client.expires_at)) throw aborted();
 return value;
}
function checkedWorkspaces(value: { workspaces: Workspace[] }): Workspace[] {
 if (!value || !Array.isArray(value.workspaces) || value.workspaces.length > 128) throw aborted();
 const ids = new Set<string>();
 for (const row of value.workspaces) {
  if (!row || !isProtectedId(row.workspace_id) || ids.has(row.workspace_id) || !isProtectedId(row.client_id) || typeof row.status !== "string" || !/^[a-z_]{1,32}$/.test(row.status) || !Number.isSafeInteger(row.expires_at) || (row.draft != null && (typeof row.draft !== "string" || new TextEncoder().encode(row.draft).length > 8000))) throw aborted();
  ids.add(row.workspace_id);
 }
 return value.workspaces.map(row => ({ ...row, draft: row.draft ?? undefined }));
}
export function initProtectedComposer(ctx: AccessContext, persistence: { get: () => PrivateWorkspace[]; save: (records: PrivateWorkspace[], generation: number) => Promise<void> }) {
 let controller = new AbortController(), lifetime = 0, editing = 0, busy = false, working = false, refreshing = false;
 let broker: Broker | null = null, live: Workspace[] = [], returnFocus: HTMLElement | null = null, previewFocus: HTMLElement | null = null;
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
 const hidePreview = button("Klartextvorschau schließen", clearPreview); hidePreview.hidden = true; hidePreview.dataset.cancel = "";
 const trust = make("ul", undefined, "broker-trust"); trust.id = "protected-trust";
 for (const text of ["Keine Zwischenablage: Originale werden nur lokal im Tresor und in der Vorschau verwendet.", "Kein Seitenlesen: Der geschützte Agent erhält keine Website-Inhalte.", "Shell-Agenten brauchen --broker-sandbox ohne unabhängigen Hostzugriff.", "Kein externes Sicherheitsaudit; Host, Zielwebsite und Administrator gehören zur Vertrauensgrenze."]) trust.append(make("li", text));
 card.append(make("h2", "Geschützte Entwürfe"), make("p", "Person, E-Mail und Vorgang bleiben im verschlüsselten Tresor. Der geschützte Agent erhält nur Platzhalter und darf keine Website-Inhalte lesen. Jede Anmeldung braucht deine ausdrückliche Freigabe. Die Klartextvorschau entsteht ausschließlich hier; es wird nichts versendet.", "note"), trust, status, actions, pairing, list, preview, hidePreview); settings.append(card);
 const dialog = make("dialog"); dialog.id = "protected-composer-dialog"; dialog.setAttribute("aria-labelledby", "protected-composer-heading");
 const heading = make("h2", "Geschützten Antwortentwurf vorbereiten"); heading.id = "protected-composer-heading";
 const form = make("form"); form.id = "protected-form";
 const clientLabel = make("label", "Geschützter Agent (Bezeichnung nicht überprüft)"); clientLabel.htmlFor = "protected-client";
 const clients = make("select"); clients.id = "protected-client"; clients.required = true;
 const sourceLabel = make("label", "Login für die einmalige Anmeldung"); sourceLabel.htmlFor = "protected-source";
 const sources = make("select"); sources.id = "protected-source"; sources.required = true;
 form.append(clientLabel, clients, sourceLabel, sources);
 const inputs = {} as Record<ReferenceKind, HTMLInputElement>;
 for (const kind of REFERENCE_KINDS) {
  const label = make("label", labels[kind] + " · nur lokal"), input = make("input");
  input.id = "protected-" + kind; label.htmlFor = input.id; input.type = kind === "email" ? "email" : "text"; input.autocomplete = "off"; input.maxLength = 1000; input.required = true; input.spellcheck = false; inputs[kind] = input; form.append(label, input);
 }
 const note = make("p", "Vorlage: kurzer deutscher Antwortentwurf. Zuerst verschlüsselt speichern, danach den Auftrag für höchstens 5 Minuten freigeben. Neue Speicherung beendet vorhandene Freigaben.", "note");
 const submit = make("button", "Verschlüsselt speichern und freigeben"); submit.type = "submit"; submit.id = "protected-publish";
 const cancel = button("Abbrechen", closeEditor); cancel.dataset.cancel = "";
 const formActions = make("div", undefined, "actions"); formActions.append(submit, cancel); form.append(note, formActions); dialog.append(heading, form); document.body.append(dialog);
 function usable() { return ctx.unlocked() && !!ctx.get().vault && !!ctx.get().token && !ctx.get().discreet; }
 function guard(run: number, generation: number, editor?: number) { if (run !== lifetime || !ctx.current(generation) || !usable() || controller.signal.aborted || (editor !== undefined && editor !== editing)) throw aborted(); }
 function clearPairing() { clearTimeout(pairTimer); pairing.textContent = ""; hidePair.hidden = true; }
 function clearPreview() { preview.textContent = ""; preview.hidden = true; hidePreview.hidden = true; if (previewFocus?.isConnected) previewFocus.focus(); previewFocus = null; }
 function closeEditor() {
  editing++; for (const input of Object.values(inputs)) input.value = ""; clients.replaceChildren(); sources.replaceChildren(); form.reset();
  if (dialog.open) dialog.close();
  if (returnFocus?.isConnected) { if (returnFocus instanceof HTMLButtonElement && returnFocus.disabled) card.focus(); else returnFocus.focus(); } returnFocus = null;
 }
 function setBusy(value: boolean) {
  busy = value;
  for (const control of card.querySelectorAll<HTMLButtonElement>("button")) control.disabled = control.hasAttribute("data-cancel") ? false : value || working || !usable();
  add.disabled = value || working || !usable() || !broker?.unlocked || !broker.enabled;
  pair.disabled = value || working || !usable() || !broker?.unlocked || !broker.enabled;
  for (const input of [...Object.values(inputs), clients, sources, submit]) input.disabled = value || working || !usable();
  cancel.disabled = false; form.setAttribute("aria-busy", String(working));
 }
 function clear() {
  lifetime++; controller.abort(); controller = new AbortController(); clearInterval(poll); poll = undefined; clearPairing(); returnFocus = null; previewFocus = null; closeEditor(); clearPreview();
  broker = null; live = []; list.replaceChildren(); working = false; refreshing = false; status.textContent = "Geschützte Entwürfe gesperrt. Lokale Klartexte wurden ausgeblendet."; setBusy(busy);
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
  if (record) { sources.value = record.source_id; for (const ref of record.references) inputs[ref.kind].value = ref.value; }
  setBusy(busy); dialog.showModal(); clients.focus();
 }
 function render() {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
  if (dialog.open) syncClients();
  list.replaceChildren();
  const records = validatePrivateWorkspaces(persistence.get(), ctx.get().vault!.entries);
  for (const record of records) {
   const grant = live.find(item => item.workspace_id === record.id), row = make("li"), source = ctx.get().vault!.entries.find(item => item.id === record.source_id)!;
   row.append(make("p", source.title + " · " + new Date(record.created_at).toLocaleString("de-DE") + " · " + (grant ? grant.status : "nur verschlüsselt gespeichert")));
   const controls = make("div", undefined, "actions");
   const prepare = button("Als neuen Auftrag vorbereiten", () => openEditor(record), "protected-prepare-" + record.id); controls.append(prepare);
   const draft = grant?.draft ?? record.draft;
   if (draft !== undefined) {
    try {
     resolveProtectedDraft(draft, record.references);
     const show = button("Lokal im Klartext ansehen", () => { if (!usable()) return; clearPreview(); previewFocus = show; preview.textContent = resolveProtectedDraft(draft, record.references); preview.hidden = false; hidePreview.hidden = false; preview.focus(); }, "protected-preview-" + record.id);
     show.dataset.protectedPreview = ""; controls.append(show);
     if (grant?.draft && record.draft !== grant.draft) controls.append(button("Entwurf verschlüsselt speichern", () => void saveDraft(record.id, grant.draft!), "protected-save-draft-" + record.id));
    } catch { row.append(make("p", "Entwurf abgewiesen: ungültige Platzhalter oder unzulässiges Format.", "note")); }
   }
   if (grant) controls.append(button("Auftrag widerrufen", () => void revoke(record.id), "protected-revoke-" + record.id));
   controls.append(button("Gespeicherten Auftrag löschen", () => void removeRecord(record.id), "protected-delete-" + record.id)); row.append(controls); list.append(row);
  }
  if (!records.length) list.append(make("li", "Noch keine geschützten Aufträge gespeichert.", "note"));
  setBusy(busy); if (!dialog.open && focused) document.getElementById(focused)?.focus();
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
   broker = result; live = rows; render(); status.textContent = "Originale bleiben im Tresor. Gespeicherte Aufträge werden nach dem Entsperren nicht automatisch freigegeben.";
  } catch { if (run === lifetime && usable()) status.textContent = "Geschützte Aufträge konnten nicht geladen werden."; }
  finally { if (run === lifetime) refreshing = false; }
 }
 async function publish() {
  if (busy || working || !usable() || !broker?.unlocked || !dialog.open) return;
  const run = lifetime, editor = editing, clientId = clients.value, sourceId = sources.value;
  working = true; setBusy(busy); let saved = false;
  await ctx.run(async generation => {
   try {
    guard(run, generation, editor);
    const source = ctx.get().vault!.entries.find(item => item.id === sourceId), client = broker?.clients.find(item => item.id === clientId && item.protected);
    if (!source || !client || !isProtectedId(clientId) || client.expires_at * 1000 <= Date.now()) throw aborted();
    const origin = sourceOrigin(source.url);
    const record: PrivateWorkspace = { id: crypto.randomUUID(), created_at: new Date().toISOString(), source_id: sourceId, template: "reply", references: REFERENCE_KINDS.map(kind => ({ id: crypto.randomUUID(), kind, value: inputs[kind].value.trim() })) };
    const records = validatePrivateWorkspaces([...persistence.get(), record], ctx.get().vault!.entries);
    await persistence.save(records, generation); saved = true; guard(run, generation, editor);
    const currentBroker = checkedBroker(await localRequest<Broker>(ctx, base, controller.signal)); guard(run, generation, editor);
    if (!currentBroker.unlocked || !currentBroker.enabled || !currentBroker.clients.some(item => item.id === clientId && item.protected && item.expires_at * 1000 > Date.now())) throw aborted();
    const revision = ctx.get().revision;
    await localRequest(ctx, workspacesPath, controller.signal, { workspace_id: record.id, client_id: clientId, epoch: currentBroker.epoch, revision, source_id: sourceId, origin, template: "reply", references: publishedReferences(record) });
    guard(run, generation, editor); if (revision !== ctx.get().revision) throw aborted();
    closeEditor(); clearPreview(); working = false; await refresh(); guard(run, generation);
    status.textContent = "Verschlüsselt gespeichert und für den geschützten Agenten freigegeben. Anmeldung weiterhin einzeln bestätigen.";
   } catch { if (run === lifetime && usable()) { closeEditor(); if (saved) { live = []; render(); } status.textContent = saved ? "Verschlüsselt gespeichert; Freigabe fehlgeschlagen. Gespeicherten Auftrag als neuen Auftrag vorbereiten." : "Auftrag konnte nicht gespeichert werden. Eingaben und Tresorstatus prüfen."; } }
   finally { if (run === lifetime) { working = false; setBusy(busy); } }
  });
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
 dialog.addEventListener("cancel", event => { event.preventDefault(); closeEditor(); });
 dialog.addEventListener("close", () => { if (sources.childElementCount) closeEditor(); });
 dialog.addEventListener("click", event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeEditor(); } });
 new MutationObserver(() => { if (settings.hidden) { closeEditor(); clearPreview(); clearPairing(); } else void refresh(); }).observe(settings, { attributes: true, attributeFilter: ["hidden"] });
 window.addEventListener("pagehide", clear);
 document.addEventListener("visibilitychange", () => { if (!document.hidden && !settings.hidden) void refresh(); });
 setBusy(false);
 return { clear, setBusy, refresh };
}
