import { createVault, openVault, sealVault, validateEnvelope, validateVault, generatePassword, parseCsv, totp, MAX_FILE_BYTES, type Envelope, type Login, type Vault } from "./passwords-crypto";
import { createIcon, initPresentation } from "./passwords-presentation";
import { initBrand } from "./passwords-brand";
import { initWorkflows } from "./passwords-workflows";
import { getPrivacyPreferences, initPrivacy, recordActivity, clearActivities } from "./passwords-privacy";
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Fehlendes UI-Element: ${id}`);
  return element as T;
};
const input = (id: string) => byId<HTMLInputElement>(id);
const value = (id: string) => (byId(id) as HTMLInputElement | HTMLTextAreaElement).value;
const form = (id: string) => byId<HTMLFormElement>(id);
let token = "", revision = 0, remote: Envelope | null = null;
let restoreReady = false;
let vault: Vault | null = null, key: CryptoKey | null = null, envelope: Envelope | null = null;
let generation = 0, busy = false, ready = false, lastActivity = Date.now(), hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let deleting: string | null = null;
let selectedId: string | null = null, activeTag: string | null = null, revealedId: string | null = null;
let revealTimer: ReturnType<typeof setTimeout> | undefined;
function cancelReveal() { clearTimeout(revealTimer); revealedId = null; }
let editorReturnFocus: HTMLElement | null = null;
let workflows: ReturnType<typeof initWorkflows> | undefined;
function refreshNavigation() {
  const special = !byId("health-view").hidden ? "nav-health" : !byId("settings-view").hidden ? "nav-settings" : null;
  const selected = special || (activeTag ? null : input("favorites-only").checked ? "nav-favorites" : "nav-all");
  for (const id of ["nav-all", "nav-favorites", "nav-health", "nav-settings"]) { const current = id === selected; byId(id).classList.toggle("active", current); if (current) byId(id).setAttribute("aria-current", "page"); else byId(id).removeAttribute("aria-current"); }
  byId("tag-navigation").querySelectorAll<HTMLButtonElement>("button").forEach(button => button.classList.toggle("active", !special && button.textContent === activeTag));
}
function closeNavigation() { byId("workspace").classList.remove("navigation-open"); byId("menu-toggle").setAttribute("aria-expanded", "false"); }
function showEntries() { byId("health-view").hidden = true; byId("nav-health").classList.remove("active"); byId("nav-health").removeAttribute("aria-current"); byId("settings-view").hidden = true; byId("workspace").classList.remove("settings-open"); byId("nav-settings").classList.remove("active"); byId("nav-settings").removeAttribute("aria-current"); closeNavigation(); refreshNavigation(); }
function setFilter(favorites = false, tag: string | null = null) { if (busy || !vault) return; activeTag = tag; input("favorites-only").checked = favorites; selectedId = null; cancelReveal(); showEntries(); byId("workspace").classList.remove("show-detail"); render(); }
function showSettings() { if (busy || !vault) return; clearEditor(); showEntries(); byId("settings-view").hidden = false; byId("workspace").classList.add("settings-open"); byId("nav-settings").classList.add("active"); byId("nav-settings").setAttribute("aria-current", "page"); closeNavigation(); refreshNavigation(); byId("settings-heading").focus(); }
function setTheme(theme: string) { const dark = theme === "dark"; document.documentElement.dataset.theme = dark ? "dark" : "light"; byId("theme-toggle").setAttribute("aria-pressed", String(dark)); byId("theme-label").textContent = dark ? "Helles Design" : "Dunkles Design"; }
try { setTheme(localStorage.getItem("heavenkey-theme") || "light"); } catch { setTheme("light"); }
let pendingFocus: string | null = null;
function focusAfter(id: string) { if (busy) pendingFocus = id; else byId(id).focus(); }
let clipboardTimer: ReturnType<typeof setTimeout> | undefined;
let clipboardValue = "", clipboardEpoch = 0;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
const status = (message: string, error = false) => {
  clearTimeout(statusTimer);
  const output = byId("status"); output.textContent = message; output.dataset.error = String(error);
  let inDialog = false;
  for (const id of ["editor", "delete-dialog"]) if (byId<HTMLDialogElement>(id).open) {
    const local = byId(`${id}-status`); local.textContent = message; local.dataset.error = String(error); local.hidden = false; inDialog = true;
  }
  if (!error && !inDialog) statusTimer = setTimeout(() => { output.textContent = ""; }, 6000);
};
function setBusy(next: boolean) {
  busy = next;
  document.querySelectorAll<HTMLButtonElement>("button").forEach(button => { if (button.id !== "lock") button.disabled = next || (button.id === "unlock" && !ready) || (getPrivacyPreferences().discreet && ["reveal-detail-password", "edit-entry", "show-totp"].includes(button.dataset.testid || "")); });
  byId("workspace").setAttribute("aria-busy", String(next));
}
function clearEditor() { byId("editor-status").textContent = ""; byId("editor-status").hidden = true; form("entry-form").reset(); input("entry-id").value = ""; input("entry-password").type = "password"; byId("reveal-password").setAttribute("aria-pressed", "false"); byId("reveal-password").textContent = "Anzeigen"; byId<HTMLDialogElement>("editor").close(); }
function lock(message = "Tresor gesperrt.", refresh = true) {
  workflows?.clear();
  cancelReveal(); clearActivities();
  clearTimeout(clipboardTimer); void cleanupClipboard();
  generation++; pendingFocus = null; selectedId = null; activeTag = null; revealedId = null; editorReturnFocus = null;
  key = null; vault = null; envelope = null; remote = null; ready = false; restoreReady = false; deleting = null;
  document.querySelectorAll<HTMLFormElement>("form").forEach(element => element.reset());
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea").forEach(element => { if (element.type !== "checkbox") element.value = ""; });
  input("generator-length").value = "24"; input("favorites-only").checked = false;
  byId("health-findings").replaceChildren(); byId("health-summary").replaceChildren(); byId("health-count").textContent = "0"; byId("tag-navigation").replaceChildren(); byId("all-count").textContent = "0"; byId("fav-count").textContent = "0"; byId("logins-heading").textContent = "Alle Einträge"; byId("result-count").textContent = "0 Einträge";
  clearEditor();
  byId("detail").replaceChildren(); showEntries(); byId("workspace").classList.remove("show-detail"); document.body.classList.remove("unlocked"); byId("entries").replaceChildren(); byId("count").textContent = ""; byId("delete-title").textContent = ""; byId("delete-dialog-status").textContent = ""; byId("delete-dialog-status").hidden = true;
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach(dialog => dialog.close());
  byId("workspace").hidden = true; byId("gate").hidden = false; byId("lock").hidden = true;
  setBusy(false); status(message);
  if (document.visibilityState === "visible") input("master").focus();
  if (refresh) void load(false);
}
function active(run: number): boolean { return run === generation; }
function unlocked(run: number): boolean { return active(run) && !!key && !!vault; }
async function api(path: string, record?: Envelope, expected?: number): Promise<unknown> {
  const response = await fetch(path, { method: record ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(15_000), credentials: "omit", headers: { "X-HeavenKey-Client": "password-manager", ...(token ? { "X-HeavenKey-Token": token } : {}), ...(record ? { "Content-Type": "application/json" } : {}) }, ...(record ? { body: JSON.stringify({ expected_revision: expected, record }) } : {}) });
  if (!response.ok) {
    if (response.status === 409) throw new Error("Speicherkonflikt: Ein anderer Tab hat den Tresor geändert. Sperre ihn und entsperre erneut; deine ungespeicherten Änderungen werden verworfen.");
    throw new Error(`Lokaler Tresordienst nicht verfügbar (HTTP ${response.status}).`);
  }
  const text = await response.text();
  if (text.length > MAX_FILE_BYTES) throw new Error("Serverantwort überschreitet die Größenbegrenzung.");
  return JSON.parse(text);
}
async function pairingRequest(method: 'GET'|'POST'|'DELETE'): Promise<unknown> {
  const response = await fetch('/api/password-vault/extension/pairing', {method,cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(15_000),headers:{'X-HeavenKey-Client':'password-manager','X-HeavenKey-Token':token}});
  if (!response.ok) throw new Error(`Erweiterungsverbindung nicht verfügbar (HTTP ${response.status}).`);
  return response.json();
}
function readSnapshot(value: unknown): { revision: number; record: Envelope | null } {
  if (!value || typeof value !== "object") throw new Error("Ungültige Tresorantwort.");
  const snap = value as { revision?: unknown; record?: unknown };
  if (!Number.isSafeInteger(snap.revision) || Number(snap.revision) < 0 || !("record" in snap)) throw new Error("Ungültige Tresorrevision.");
  return { revision: Number(snap.revision), record: snap.record === null ? null : validateEnvelope(snap.record) };
}
async function load(announce = true) {
  const run = generation;
  ready = false; restoreReady = false; setBusy(true);
  try {
    const config = await api("/api/password-vault/config") as { token?: unknown; revision?: unknown };
    if (!active(run)) return;
    if (typeof config.token !== "string" || !config.token || config.token.length > 1024) throw new Error("Ungültige lokale Zugriffskonfiguration.");
    if (!Number.isSafeInteger(config.revision) || Number(config.revision) < 0) throw new Error("Ungültige lokale Tresorrevision.");
    token = config.token; revision = Number(config.revision); restoreReady = true;
    const snapshot = readSnapshot(await api("/api/password-vault"));
    if (!active(run)) return;
    revision = snapshot.revision; remote = snapshot.record; ready = true;
    byId("gate-heading").textContent = remote ? "Tresor entsperren" : "Lokalen Tresor anlegen";
    byId("unlock").textContent = remote ? "Entsperren" : "Tresor anlegen";
    byId("create-confirm").hidden = !!remote;
    input("master-confirm").required = !remote;
    input("master").autocomplete = remote ? "current-password" : "new-password";
    if (announce) status(remote ? "Verschlüsselter Tresor bereit." : "Noch kein Tresor vorhanden. Wähle ein langes, einmaliges Masterpasswort.");
  } catch (error) { if (active(run)) status(error instanceof Error ? error.message : "Laden fehlgeschlagen.", true); }
  finally { if (active(run)) setBusy(false); }
}
async function operation(task: (run: number) => Promise<void>) {
  if (busy) return;
  const run = generation;
  setBusy(true);
  try { await task(run); }
  catch (error) { if (active(run)) { if (vault) recordActivity("operation", "error"); status(error instanceof Error ? error.message : "Vorgang fehlgeschlagen.", true); } }
  finally { if (active(run)) { setBusy(false); if (pendingFocus) { byId(pendingFocus).focus(); pendingFocus = null; } } }
}
async function commit(next: Vault, run: number, nextKey: CryptoKey | null = key, nextSalt = envelope?.salt): Promise<boolean> {
  if (!unlocked(run) || !nextKey || !nextSalt) return false;
  next = validateVault(next);
  const sealed = await sealVault(next, nextKey, nextSalt);
  if (!unlocked(run)) return false;
  const saved = readSnapshot(await api("/api/password-vault", sealed, revision));
  if (!unlocked(run)) return false;
  if (!saved.record) throw new Error("Server hat keinen Tresor gespeichert.");
  revision = saved.revision; envelope = sealed; remote = sealed; key = nextKey; vault = next;
  render(); recordActivity("save"); return true;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
function action(label: string, testId: string, handler: () => void): HTMLButtonElement { const button = element("button", label); button.className = "secondary"; button.dataset.testid = testId; button.type = "button"; button.disabled = busy; button.addEventListener("click", handler); return button; }
function selectEntry(id: string, focus = false) {
  if (busy || !vault) return;
  selectedId = id; cancelReveal();
  byId("workspace").classList.add("show-detail"); render();
  if (focus || matchMedia("(max-width: 559px)").matches) byId("detail-title").focus();
  else byId("entries").querySelector<HTMLButtonElement>("[aria-current=true]")?.focus();
}
function render() {
  const list = byId("entries"); const scrollTop = list.scrollTop; list.replaceChildren();
  if (!vault) return;
  const favorites = input("favorites-only").checked;
  byId("count").textContent = `${vault.entries.length} Einträge`;
  byId("all-count").textContent = String(vault.entries.length);
  byId("fav-count").textContent = String(vault.entries.filter(entry => entry.favorite).length);
  byId("logins-heading").textContent = activeTag || (favorites ? "Favoriten" : "Alle Einträge");
  for (const [id, isActive] of [["nav-all", !favorites && !activeTag], ["nav-favorites", favorites && !activeTag]] as const) {
    byId(id).classList.toggle("active", isActive);
    if (isActive) byId(id).setAttribute("aria-current", "page"); else byId(id).removeAttribute("aria-current");
  }
  const tags = [...new Set(vault.entries.flatMap(entry => entry.tags))].sort((a,b) => a.localeCompare(b, "de"));
  const tagNav = byId("tag-navigation"); tagNav.replaceChildren();
  for (const tag of tags) { const button = action(tag, "filter-tag", () => setFilter(false, tag)); button.className = "nav-button tag-button"; button.classList.toggle("active", tag === activeTag); button.setAttribute("aria-pressed", String(tag === activeTag)); tagNav.append(button); }
  if (!tags.length) { const note = element("p", "Tags erscheinen nach dem Speichern."); note.className = "nav-note"; tagNav.append(note); }
  const query = value("search").trim().toLocaleLowerCase("de");
  const filtered = vault.entries.filter(entry => (!favorites || entry.favorite) && (!activeTag || entry.tags.includes(activeTag)) && [entry.title, entry.username, entry.url, entry.notes, ...entry.tags].join("\n").toLocaleLowerCase("de").includes(query)).sort((a,b) => (value("sort") === "reverse" ? -1 : 1) * a.title.localeCompare(b.title, "de"));
  if (!filtered.some(entry => entry.id === selectedId)) { selectedId = filtered[0]?.id || null; revealedId = null; }
  byId("result-count").textContent = `${filtered.length} ${filtered.length === 1 ? "Eintrag" : "Einträge"}`;
  byId("empty").hidden = filtered.length > 0;
  byId("empty").textContent = vault.entries.length ? "Keine passenden Logins. Ändere Suche oder Filter." : "Dein Tresor ist bereit. Füge deinen ersten Login hinzu.";
  for (const entry of filtered) {
    const row = element("li"); row.className = "login"; row.dataset.entryId = entry.id; row.dataset.testid = "login";
    const button = action("", "select-entry", () => selectEntry(entry.id)); button.className = "entry-select"; button.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); selectEntry(entry.id, true); } }); button.tabIndex = entry.id === selectedId ? 0 : -1;
    button.setAttribute("aria-current", String(entry.id === selectedId));
    const icon = element("span", entry.title.slice(0,2).toLocaleUpperCase("de")); icon.className = "entry-icon"; icon.setAttribute("aria-hidden", "true");
    const text = element("span"); text.className = "entry-label"; text.append(element("strong", entry.title), element("small", getPrivacyPreferences().discreet ? "Kontodaten ausgeblendet" : entry.username || entry.url || "Login")); button.append(icon,text);
    if (entry.favorite) { const star = createIcon("star"); star.classList.add("favorite-star"); button.setAttribute("aria-label", `${entry.title}, Favorit`); button.append(star); }
    row.append(button); list.append(row);
  }
  list.scrollTop = scrollTop;
  renderDetail(vault.entries.find(entry => entry.id === selectedId));
  byId("health-count").textContent = String(healthFindings().length); if (!byId("health-view").hidden) renderHealth(); refreshNavigation(); workflows?.refresh();
}
function healthFindings(): { entry: Login; short: boolean; reused: boolean }[] {
  if (!vault) return [];
  const uses = new Map<string, number>();
  for (const entry of vault.entries) if (entry.password) uses.set(entry.password, (uses.get(entry.password) || 0) + 1);
  return vault.entries.map(entry => ({ entry, short: entry.password.length < 14, reused: !!entry.password && (uses.get(entry.password) || 0) > 1 })).filter(item => item.short || item.reused);
}
function renderHealth() {
  const findings = healthFindings(); const summary = byId("health-summary"); summary.replaceChildren();
  for (const [count, label] of [[findings.filter(item => item.short).length, "Einträge unter 14 Zeichen"], [findings.filter(item => item.reused).length, "Einträge mit wiederverwendetem Passwort"]] as const) {
    const item = element("div"); item.append(element("strong", String(count)), element("span", label)); summary.append(item);
  }
  const list = byId("health-findings"); list.replaceChildren();
  if (!findings.length) { const clear = element("section"); clear.className = "settings-card"; clear.append(element("h2", "Keine Treffer in diesen zwei Prüfungen"),element("p", "Damit sind andere Risiken nicht ausgeschlossen. Verwende für jeden Dienst ein zufälliges, eigenes Passwort.")); list.append(clear); return; }
  const section = element("section"); section.className = "settings-card"; section.append(element("h2", `${findings.length} betroffene ${findings.length === 1 ? "Eintrag" : "Einträge"}`));
  const entries = element("ul"); entries.className = "health-list";
  for (const {entry,short,reused} of findings.sort((a,b) => a.entry.title.localeCompare(b.entry.title,"de"))) {
    const row = element("li"); row.dataset.entryId = entry.id; row.dataset.testid = "health-finding";
    const text = element("div"); text.append(element("strong",entry.title),element("p",[short ? (entry.password ? "Weniger als 14 Zeichen" : "Kein Passwort gespeichert") : "",reused ? "Passwort in mehreren Einträgen verwendet" : ""].filter(Boolean).join(" · ")));
    const open = action("Eintrag öffnen", "health-open-entry", () => { if (busy) return; activeTag = null; input("favorites-only").checked = false; input("search").value = ""; showEntries(); selectEntry(entry.id,true); }); row.append(text,open); entries.append(row);
  }
  section.append(entries); list.append(section);
}
function showHealth() {
  if (busy || !vault) return;
  showEntries(); byId("health-view").hidden = false; byId("workspace").classList.add("settings-open"); byId("nav-health").classList.add("active"); byId("nav-health").setAttribute("aria-current", "page"); renderHealth(); refreshNavigation(); byId("health-heading").focus();
}
function detailField(label: string, text: string, buttons: HTMLButtonElement[] = [], secret = false): HTMLElement {
  const field = element("div"); field.className = "detail-field"; field.setAttribute("role", "group"); field.setAttribute("aria-label", label); buttons.forEach(button => button.setAttribute("aria-label", `${button.textContent}: ${label}`));
  const content = element("div"); content.className = "field-content"; content.append(element("span", label)); const output = element("p", text || "—"); if (secret) output.className = "secret-value"; content.append(output);
  const actions = element("div"); actions.className = "field-actions"; actions.append(...buttons); field.append(content,actions); return field;
}
function renderDetail(entry?: Login) {
  const detail = byId("detail"); detail.replaceChildren();
  const back = action("Zurück zur Liste", "back-to-list", () => { byId("workspace").classList.remove("show-detail"); byId("entries").querySelector<HTMLButtonElement>("[aria-current=true]")?.focus(); }); back.prepend(createIcon("back")); back.id = "back-to-list"; back.className = "secondary back-to-list"; detail.append(back);
  if (!entry) { const blank = element("div"); blank.className = "detail-empty"; blank.append(createIcon("vault"),element("h2", "Kein Login ausgewählt"),element("p", "Wähle einen Login aus oder erstelle einen neuen Eintrag.")); detail.append(blank); return; }
  const discreet = getPrivacyPreferences().discreet;
  const head = element("div"); head.className = "detail-heading";
  const identity = element("div"); identity.className = "detail-identity"; const icon = element("span", entry.title.slice(0,2).toLocaleUpperCase("de")); icon.className = "detail-icon"; icon.setAttribute("aria-hidden", "true");
  const titleBlock = element("div"); const title = element("h2",entry.title); title.id = "detail-title"; title.dataset.testid = "detail-title"; title.tabIndex = -1; titleBlock.append(title,element("p", "Login")); identity.append(icon,titleBlock); const editButton = action("Bearbeiten", "edit-entry", () => edit(entry.id)); editButton.disabled = busy || discreet; head.append(identity, editButton); detail.append(head);
  const fields = element("div"); fields.className = "detail-fields";
  fields.append(detailField("Benutzername", discreet ? "Verdeckt" : entry.username, [action("Kopieren", "copy-username", () => void copy(entry.username))]));
  const reveal = action(revealedId === entry.id ? "Verbergen" : "Anzeigen", "reveal-detail-password", () => {
    if (getPrivacyPreferences().discreet) return;
    const show = revealedId !== entry.id; cancelReveal();
    if (show) {
      revealedId = entry.id; recordActivity("reveal"); const run = generation, id = entry.id;
      revealTimer = setTimeout(() => {
        if (!unlocked(run) || revealedId !== id) return;
        cancelReveal();
        const output = byId("detail").querySelector<HTMLElement>(".secret-value");
        const control = byId("detail").querySelector<HTMLButtonElement>("[data-testid=reveal-detail-password]");
        if (output) output.textContent = vault?.entries.find(item => item.id === id)?.password ? "••••••••••••••••" : "—";
        if (control) { control.textContent = "Anzeigen"; control.setAttribute("aria-pressed", "false"); control.setAttribute("aria-label", "Anzeigen: Passwort"); }
      }, getPrivacyPreferences().revealSeconds * 1000);
    }
    renderDetail(entry); byId("detail").querySelector<HTMLButtonElement>("[data-testid=reveal-detail-password]")?.focus();
  }); reveal.disabled = busy || discreet; reveal.setAttribute("aria-pressed", String(revealedId === entry.id));
  fields.append(detailField("Passwort", revealedId === entry.id ? entry.password : entry.password ? "••••••••••••••••" : "—", [reveal,action("Kopieren", "copy-password", () => void copy(entry.password))], true));
  if (entry.totp) { const button = action("Code anzeigen", "show-totp", () => void showTotp(entry.id, field)); button.disabled = busy || discreet; const field = detailField("Einmalcode · TOTP", discreet ? "Verdeckt" : "Wird auf diesem Gerät berechnet", [button]); fields.append(field); }
  if (entry.url) { const field = detailField("Website", discreet ? "Verdeckt" : ""); if (!discreet) { const link = element("a", entry.url); link.href = entry.url; link.target = "_blank"; link.rel = "noopener noreferrer"; field.querySelector("p")!.replaceChildren(link); } fields.append(field); }
  detail.append(fields);
  if (entry.tags.length) { const tags = element("div"); tags.className = "detail-tags"; tags.setAttribute("aria-label", "Tags"); entry.tags.forEach(tag => { const button = action(tag, "detail-tag", () => setFilter(false, tag)); button.className = "tag"; tags.append(button); }); detail.append(tags); }
  if (entry.notes) { const notes = element("div"); notes.className = "detail-notes"; notes.append(element("h3", "Notizen"),element("p",discreet ? "Verdeckt" : entry.notes)); detail.append(notes); }
  const footer = element("div"); footer.className = "detail-footer";
  const favorite = action(entry.favorite ? "Favorit entfernen" : "Als Favorit", "toggle-favorite", () => void operation(async run => { if (!vault) return; if (await commit({ ...vault, version: 1, entries: vault.entries.map(item => item.id === entry.id ? { ...item, favorite: !item.favorite } : item) }, run)) { status("Favorit gespeichert."); focusAfter(selectedId ? "detail-title" : "new-entry"); } })); favorite.prepend(createIcon("star")); favorite.setAttribute("aria-pressed", String(entry.favorite));
  const remove = action("Login löschen", "delete-entry", () => { deleting = entry.id; byId("delete-title").textContent = entry.title; byId("delete-dialog-status").textContent = ""; byId("delete-dialog-status").hidden = true; byId<HTMLDialogElement>("delete-dialog").showModal(); }); remove.classList.add("danger"); footer.append(favorite,remove); detail.append(footer);
}
function edit(id?: string) {
  if (!vault || busy) return;
  if (getPrivacyPreferences().discreet) { status("Beende die diskrete Ansicht, um Einträge zu bearbeiten."); return; }
  const previous = document.activeElement as HTMLElement;
  cancelReveal(); renderDetail(vault.entries.find(item => item.id === selectedId));
  clearEditor(); editorReturnFocus = previous.isConnected ? previous : byId("detail").querySelector<HTMLButtonElement>("[data-testid=edit-entry]"); const entry = vault.entries.find(item => item.id === id);
  byId("editor-heading").textContent = entry ? "Login bearbeiten" : "Login hinzufügen";
  if (entry) {
    for (const name of ["id", "title", "username", "password", "url", "notes", "totp"] as const) (byId(`entry-${name}`) as HTMLInputElement | HTMLTextAreaElement).value = entry[name];
    input("entry-tags").value = entry.tags.join(", "); input("entry-favorite").checked = entry.favorite;
  }
  byId<HTMLDialogElement>("editor").showModal(); input("entry-title").focus();
}
async function showTotp(id: string, row: HTMLElement) {
  const run = generation, entry = vault?.entries.find(item => item.id === id);
  if (!entry || busy || getPrivacyPreferences().discreet) return;
  try {
    const result = await totp(entry.totp);
    if (!unlocked(run) || !row.isConnected) return;
    row.querySelector(".totp")?.remove();
    const output = element("p", `${result.code} · noch ${result.remaining} s`); output.className = "totp"; output.dataset.testid = "totp-code"; output.setAttribute("role", "status"); row.append(output);
    setTimeout(() => output.remove(), result.remaining * 1000);
  } catch { if (active(run)) status("TOTP konnte nicht berechnet werden.", true); }
}
async function cleanupClipboard() {
  const previous = clipboardValue, epoch = clipboardEpoch; clipboardValue = "";
  if (!previous) return;
  try { if (await navigator.clipboard.readText() === previous && epoch === clipboardEpoch) await navigator.clipboard.writeText(""); } catch { /* Browser may deny clipboard reads; the UI explains manual cleanup. */ }
}
async function copy(secret: string) {
  if (!vault || busy) return;
  const run = generation, epoch = ++clipboardEpoch;
  try {
    await navigator.clipboard.writeText(secret);
    if (epoch !== clipboardEpoch) return;
    if (!active(run)) { clipboardValue = secret; void cleanupClipboard(); return; }
    clearTimeout(clipboardTimer); clipboardValue = secret;
    clipboardTimer = setTimeout(() => void cleanupClipboard(), 30_000);
    recordActivity("copy"); status("Kopiert.");
  } catch { if (active(run)) status("Kopieren nicht erlaubt. Erlaube die Zwischenablage in diesem sicheren Browserkontext.", true); }
}
async function readFile(id: string): Promise<string> {
  const file = input(id).files?.[0];
  if (!file || file.size > MAX_FILE_BYTES || file.size === 0) throw new Error("Wähle eine Datei mit 1 Byte bis maximal 2 MB.");
  return file.text();
}
form("unlock-form").addEventListener("submit", event => {
  event.preventDefault(); if (!ready) return;
  void operation(async run => {
    const master = value("master"), current = remote;
    if (!current && master !== value("master-confirm")) throw new Error("Die Masterpasswörter stimmen nicht überein.");
    input("master").value = ""; input("master-confirm").value = "";
    const opened = current ? await openVault(current, master) : await createVault(master);
    if (!active(run)) return;
    if (!current) { const saved = readSnapshot(await api("/api/password-vault", opened.envelope, revision)); if (!active(run)) return; revision = saved.revision; }
    vault = opened.vault; key = opened.key; envelope = opened.envelope; remote = opened.envelope; lastActivity = Date.now();
    byId("gate").hidden = true; document.body.classList.add("unlocked"); byId("workspace").hidden = false; byId("lock").hidden = false;
    render(); recordActivity(current ? "unlock" : "create"); status(current ? "Tresor entsperrt." : "Tresor angelegt und verschlüsselt gespeichert."); focusAfter("new-entry");
  });
});
byId("lock").addEventListener("click", () => lock());
form("locked-restore-form").addEventListener("submit", event => { event.preventDefault(); void operation(async run => {
  if (!restoreReady || vault || !input("locked-restore-confirm").checked) throw new Error("Lade den gesperrten Tresor und bestätige ausdrücklich das Ersetzen.");
  const master = value("locked-restore-master"); input("locked-restore-master").value = "";
  const text = await readFile("locked-restore-file"); if (!active(run)) return;
  const opened = await openVault(JSON.parse(text), master); if (!active(run)) return;
  const saved = readSnapshot(await api("/api/password-vault", opened.envelope, revision)); if (!active(run)) return;
  if (!saved.record) throw new Error("Server hat keine Sicherung gespeichert.");
  lock("Sicherung wiederhergestellt. Entsperre mit dem Masterpasswort der Sicherung.");
}); });
byId("reload").addEventListener("click", () => { if (!busy) void load(); });
byId("new-entry").addEventListener("click", () => edit());
function cancelEditor() { clearEditor(); if (editorReturnFocus?.isConnected) editorReturnFocus.focus(); else focusAfter("new-entry"); editorReturnFocus = null; }
byId("cancel-entry").addEventListener("click", cancelEditor);
byId<HTMLDialogElement>("editor").addEventListener("cancel", event => { event.preventDefault(); cancelEditor(); });
input("search").addEventListener("input", () => { cancelReveal(); render(); }); input("favorites-only").addEventListener("change", () => { activeTag = null; cancelReveal(); showEntries(); render(); });
byId("sort").addEventListener("change", render);
byId("nav-all").addEventListener("click", () => setFilter());
byId("nav-favorites").addEventListener("click", () => setFilter(true));
byId("nav-settings").addEventListener("click", showSettings);
byId("nav-health").addEventListener("click", showHealth);
byId("close-health").addEventListener("click", () => { showEntries(); input("search").focus(); });
byId("close-settings").addEventListener("click", () => { showEntries(); input("search").focus(); });
byId("nav-generator").addEventListener("click", () => { if (busy || !vault) return; if (getPrivacyPreferences().discreet) { status("Beende die diskrete Ansicht, um Einträge zu bearbeiten."); return; } showEntries(); edit(); input("entry-password").value = generatePassword(24); input("entry-password").focus(); status("Neues Passwort generiert. Zum Übernehmen verschlüsselt speichern."); });
byId("menu-toggle").addEventListener("click", () => { const open = byId("workspace").classList.toggle("navigation-open"); byId("menu-toggle").setAttribute("aria-expanded", String(open)); if (open) byId("nav-all").focus(); });
byId("theme-toggle").addEventListener("click", () => { const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; setTheme(theme); try { localStorage.setItem("heavenkey-theme", theme); } catch { status("Design für diesen Tab geändert. Der Browser erlaubt keine dauerhafte Speicherung."); } });
document.addEventListener("keydown", event => {
  if (vault && event.ctrlKey && event.altKey && !event.metaKey && (event.code === "KeyL" || event.key.toLowerCase() === "l")) { event.preventDefault(); lock(); return; }
  if (byId<HTMLDialogElement>("shortcuts-dialog").open) return;
  if (document.querySelector('#quick-access[open],#import-preview[open],#profile-editor[open],#profile-delete[open]')) return;
  if (event.key === "Escape") { if (byId("workspace").classList.contains("navigation-open")) { closeNavigation(); byId("menu-toggle").focus(); } return; }
  if (!vault) return;
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && byId<HTMLDialogElement>("editor").open && !busy) { event.preventDefault(); form("entry-form").requestSubmit(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !byId<HTMLDialogElement>("editor").open && !byId<HTMLDialogElement>("delete-dialog").open) { event.preventDefault(); showEntries(); byId("workspace").classList.remove("show-detail"); input("search").focus(); input("search").select(); }
});
input("search").addEventListener("keydown", event => { if (event.key === "ArrowDown") { event.preventDefault(); byId("entries").querySelector<HTMLButtonElement>("button")?.focus(); } });
byId("entries").addEventListener("keydown", event => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = [...byId("entries").querySelectorAll<HTMLButtonElement>("button")]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); if (index < 0) return;
  event.preventDefault(); buttons[Math.max(0,Math.min(buttons.length - 1,index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
});
byId("reveal-password").addEventListener("click", () => { const reveal = input("entry-password").type === "password"; input("entry-password").type = reveal ? "text" : "password"; byId("reveal-password").setAttribute("aria-pressed", String(reveal)); byId("reveal-password").textContent = reveal ? "Verbergen" : "Anzeigen"; });
byId("generate").addEventListener("click", () => { try { input("entry-password").value = generatePassword(Number(value("generator-length"))); status("Neues Passwort generiert. Zum Übernehmen verschlüsselt speichern."); } catch (error) { status((error as Error).message, true); } });
form("entry-form").addEventListener("submit", event => {
  event.preventDefault();
  void operation(async run => {
    if (!vault) return;
    const existing = value("entry-id");
    const entry: Login = { id: existing || crypto.randomUUID(), title: value("entry-title").trim(), username: value("entry-username"), password: value("entry-password"), url: value("entry-url").trim(), notes: value("entry-notes"), totp: value("entry-totp").trim(), tags: value("entry-tags").split(",").map(tag => tag.trim()).filter(Boolean), favorite: input("entry-favorite").checked };
    const entries = existing ? vault.entries.map(item => item.id === existing ? entry : item) : [...vault.entries, entry];
    selectedId = entry.id; revealedId = null;
    if (await commit({ ...vault, version: 1, entries }, run)) { clearEditor(); byId("workspace").classList.add("show-detail"); status("Login verschlüsselt gespeichert."); focusAfter(selectedId ? "detail-title" : "new-entry"); }
  });
});
byId("delete-cancel").addEventListener("click", () => { deleting = null; byId<HTMLDialogElement>("delete-dialog").close(); });
byId("delete-confirm").addEventListener("click", () => void operation(async run => {
  if (!vault || !deleting) return;
  if (await commit({ ...vault, version: 1, entries: vault.entries.filter(entry => entry.id !== deleting) }, run)) { deleting = null; byId("delete-title").textContent = ""; byId<HTMLDialogElement>("delete-dialog").close(); clearEditor(); status("Login gelöscht und Tresor gespeichert."); focusAfter("new-entry"); }
}));
byId("export-backup").addEventListener("click", () => {
  if (!envelope || busy) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope)], { type: "application/json" }));
  const link = element("a"); link.href = url; link.download = "heavenkey-password-vault.json"; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  status("Verschlüsselte Sicherung heruntergeladen. Bewahre das zugehörige Masterpasswort getrennt auf.");
});
form("import-form").addEventListener("submit", event => { event.preventDefault(); void operation(async run => {
  if (!vault) return;
  const text = await readFile("import-file"); if (!unlocked(run)) return;
  const imported = parseCsv(text);
  if (unlocked(run)) workflows?.previewImport(imported);
}); });
form("restore-form").addEventListener("submit", event => { event.preventDefault(); void operation(async run => {
  if (!vault || !input("restore-confirm").checked) throw new Error("Bestätige ausdrücklich das Ersetzen aller Logins.");
  const master = value("restore-master"); input("restore-master").value = "";
  const text = await readFile("restore-file"); if (!unlocked(run)) return;
  const opened = await openVault(JSON.parse(text), master); if (!unlocked(run)) return;
  if (await commit(opened.vault, run)) { form("restore-form").reset(); clearEditor(); status(`${opened.vault.entries.length} Logins wiederhergestellt. Das aktuelle Masterpasswort bleibt gültig.`); }
}); });
form("rekey-form").addEventListener("submit", event => { event.preventDefault(); void operation(async run => {
  if (!vault) return;
  const master = value("new-master");
  if (master !== value("new-master-confirm")) throw new Error("Die neuen Masterpasswörter stimmen nicht überein.");
  form("rekey-form").reset();
  const rekeyed = await createVault(master, vault); if (!unlocked(run)) return;
  if (await commit(vault!, run, rekeyed.key, rekeyed.envelope.salt)) status("Masterpasswort geändert. Alte Sicherungen brauchen weiterhin ihr damaliges Passwort.");
}); });
for (const name of ["pointerdown", "keydown", "input"] as const) document.addEventListener(name, () => { lastActivity = Date.now(); }, { passive: true });
setInterval(() => { if (vault && Date.now() - lastActivity >= 300_000) lock("Nach 5 Minuten ohne Eingabe gesperrt."); }, 1000);
document.addEventListener("visibilitychange", () => { clearTimeout(hiddenTimer); if (document.visibilityState === "hidden") { if (getPrivacyPreferences().strictBackground) { if (vault || busy) lock("Beim Wechsel in den Hintergrund gesperrt."); } else hiddenTimer = setTimeout(() => { if (vault || busy) lock("Nach 30 Sekunden im Hintergrund gesperrt."); }, 30_000); } });
window.addEventListener("pagehide", () => { lock("Seite verlassen, Tresor gesperrt.", false); });
initPrivacy(() => { cancelReveal(); clearEditor(); workflows?.clear(); if (vault) render(); });
workflows = initWorkflows({vault:()=>vault,revision:()=>revision,generation:()=>generation,current:unlocked,busy:()=>busy,discreet:()=>getPrivacyPreferences().discreet,run:operation,commit,status,select:id=>{showEntries();selectEntry(id,true);},settings:showSettings,copy,pairing:pairingRequest});
initBrand();
initPresentation();
void load();
window.addEventListener("pageshow", event => { if (event.persisted && !vault) void load(); });
