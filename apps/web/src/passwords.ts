import { createVault, openVault, sealVault, validateEnvelope, validateVault, generatePassword, parseCsv, totp, MAX_FILE_BYTES, type Envelope, type Login, type Vault } from "./passwords-crypto";
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
let pendingFocus: string | null = null;
function focusAfter(id: string) { if (busy) pendingFocus = id; else byId(id).focus(); }
let clipboardTimer: ReturnType<typeof setTimeout> | undefined;
let clipboardValue = "", clipboardEpoch = 0;
const status = (message: string, error = false) => { byId("status").textContent = message; byId("status").dataset.error = String(error); };
function setBusy(next: boolean) {
  busy = next;
  document.querySelectorAll<HTMLButtonElement>("button").forEach(button => { if (button.id !== "lock") button.disabled = next || (button.id === "unlock" && !ready); });
  byId("workspace").setAttribute("aria-busy", String(next));
}
function clearEditor() { form("entry-form").reset(); input("entry-id").value = ""; input("entry-password").type = "password"; byId("reveal-password").setAttribute("aria-pressed", "false"); byId("reveal-password").textContent = "Anzeigen"; byId("editor").hidden = true; }
function lock(message = "Tresor gesperrt.", refresh = true) {
  clearTimeout(clipboardTimer); void cleanupClipboard();
  generation++; pendingFocus = null;
  key = null; vault = null; envelope = null; remote = null; ready = false; restoreReady = false; deleting = null;
  document.querySelectorAll<HTMLFormElement>("form").forEach(element => element.reset());
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea").forEach(element => { if (element.type !== "checkbox") element.value = ""; });
  input("generator-length").value = "24";
  clearEditor();
  byId("entries").replaceChildren(); byId("count").textContent = ""; byId("delete-title").textContent = "";
  byId<HTMLDialogElement>("delete-dialog").close();
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
  catch (error) { if (active(run)) status(error instanceof Error ? error.message : "Vorgang fehlgeschlagen.", true); }
  finally { if (active(run)) { setBusy(false); if (pendingFocus) { byId(pendingFocus).focus(); pendingFocus = null; } } }
}
async function commit(next: Vault, run: number, nextKey: CryptoKey | null = key, nextSalt = envelope?.salt): Promise<boolean> {
  if (!unlocked(run) || !nextKey || !nextSalt) return false;
  validateVault(next);
  const sealed = await sealVault(next, nextKey, nextSalt);
  if (!unlocked(run)) return false;
  const saved = readSnapshot(await api("/api/password-vault", sealed, revision));
  if (!unlocked(run)) return false;
  if (!saved.record) throw new Error("Server hat keinen Tresor gespeichert.");
  revision = saved.revision; envelope = sealed; remote = sealed; key = nextKey; vault = next;
  render(); return true;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
function action(label: string, testId: string, handler: () => void): HTMLButtonElement { const button = element("button", label); button.className = "secondary"; button.dataset.testid = testId; button.type = "button"; button.disabled = busy; button.addEventListener("click", handler); return button; }
function render() {
  const list = byId("entries"); list.replaceChildren();
  if (!vault) return;
  byId("count").textContent = `(${vault.entries.length})`;
  const query = value("search").trim().toLocaleLowerCase("de");
  const filtered = vault.entries.filter(entry => (!input("favorites-only").checked || entry.favorite) && [entry.title, entry.username, entry.url, entry.notes, ...entry.tags].join("\n").toLocaleLowerCase("de").includes(query));
  byId("empty").hidden = filtered.length > 0;
  byId("empty").textContent = vault.entries.length ? "Keine passenden Logins." : "Noch keine Logins. Füge deinen ersten Login hinzu.";
  for (const entry of [...filtered].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title, "de"))) {
    const row = element("li"); row.className = "login"; row.dataset.entryId = entry.id; row.dataset.testid = "login";
    row.append(element("strong", `${entry.favorite ? "★ " : ""}${entry.title}`), element("p", entry.username));
    if (entry.url) { const url = element("a", entry.url); url.href = entry.url; url.target = "_blank"; url.rel = "noopener noreferrer"; row.append(url); }
    const tags = element("p"); entry.tags.forEach(tag => { const label = element("span", tag); label.className = "tag"; tags.append(label); }); row.append(tags);
    const actions = element("div"); actions.className = "row-actions";
    actions.append(action("Bearbeiten", "edit-entry", () => edit(entry.id)), action("Passwort kopieren", "copy-password", () => void copy(entry.password)), action("Nutzername kopieren", "copy-username", () => void copy(entry.username)), action(entry.favorite ? "Favorit entfernen" : "Als Favorit", "toggle-favorite", () => void operation(async run => { if (!vault) return; if (await commit({ version: 1, entries: vault.entries.map(item => item.id === entry.id ? { ...item, favorite: !item.favorite } : item) }, run)) status("Favorit gespeichert."); })), action("Löschen", "delete-entry", () => { deleting = entry.id; byId("delete-title").textContent = entry.title; byId<HTMLDialogElement>("delete-dialog").showModal(); }));
    if (entry.totp) actions.append(action("TOTP anzeigen", "show-totp", () => void showTotp(entry.id, row)));
    row.append(actions); list.append(row);
  }
}
function edit(id?: string) {
  if (!vault || busy) return;
  clearEditor(); const entry = vault.entries.find(item => item.id === id);
  byId("editor-heading").textContent = entry ? "Login bearbeiten" : "Login hinzufügen";
  if (entry) {
    for (const name of ["id", "title", "username", "password", "url", "notes", "totp"] as const) (byId(`entry-${name}`) as HTMLInputElement | HTMLTextAreaElement).value = entry[name];
    input("entry-tags").value = entry.tags.join(", "); input("entry-favorite").checked = entry.favorite;
  }
  byId("editor").hidden = false; input("entry-title").focus();
}
async function showTotp(id: string, row: HTMLElement) {
  const run = generation, entry = vault?.entries.find(item => item.id === id);
  if (!entry || busy) return;
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
    status("Kopiert. Automatisches Leeren nach 30 Sekunden wird versucht, wenn Lesen erlaubt und der Inhalt unverändert ist. Sonst selbst löschen.");
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
    byId("gate").hidden = true; byId("workspace").hidden = false; byId("lock").hidden = false;
    render(); status(current ? "Tresor entsperrt." : "Tresor angelegt und verschlüsselt gespeichert."); focusAfter("new-entry");
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
byId("cancel-entry").addEventListener("click", () => { clearEditor(); focusAfter("new-entry"); });
input("search").addEventListener("input", render); input("favorites-only").addEventListener("change", render);
byId("reveal-password").addEventListener("click", () => { const reveal = input("entry-password").type === "password"; input("entry-password").type = reveal ? "text" : "password"; byId("reveal-password").setAttribute("aria-pressed", String(reveal)); byId("reveal-password").textContent = reveal ? "Verbergen" : "Anzeigen"; });
byId("generate").addEventListener("click", () => { try { input("entry-password").value = generatePassword(Number(value("generator-length"))); status("Neues Passwort generiert. Zum Übernehmen verschlüsselt speichern."); } catch (error) { status((error as Error).message, true); } });
form("entry-form").addEventListener("submit", event => {
  event.preventDefault();
  void operation(async run => {
    if (!vault) return;
    const existing = value("entry-id");
    const entry: Login = { id: existing || crypto.randomUUID(), title: value("entry-title").trim(), username: value("entry-username"), password: value("entry-password"), url: value("entry-url").trim(), notes: value("entry-notes"), totp: value("entry-totp").trim(), tags: value("entry-tags").split(",").map(tag => tag.trim()).filter(Boolean), favorite: input("entry-favorite").checked };
    const entries = existing ? vault.entries.map(item => item.id === existing ? entry : item) : [...vault.entries, entry];
    if (await commit({ version: 1, entries }, run)) { clearEditor(); status("Login verschlüsselt gespeichert."); focusAfter("new-entry"); }
  });
});
byId("delete-cancel").addEventListener("click", () => { deleting = null; byId<HTMLDialogElement>("delete-dialog").close(); });
byId("delete-confirm").addEventListener("click", () => void operation(async run => {
  if (!vault || !deleting) return;
  if (await commit({ version: 1, entries: vault.entries.filter(entry => entry.id !== deleting) }, run)) { deleting = null; byId("delete-title").textContent = ""; byId<HTMLDialogElement>("delete-dialog").close(); clearEditor(); status("Login gelöscht und Tresor gespeichert."); focusAfter("new-entry"); }
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
  if (await commit({ version: 1, entries: [...vault!.entries, ...imported] }, run)) { form("import-form").reset(); status(`${imported.length} Logins vollständig importiert und verschlüsselt gespeichert.`); }
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
document.addEventListener("visibilitychange", () => { clearTimeout(hiddenTimer); if (document.visibilityState === "hidden") hiddenTimer = setTimeout(() => { if (vault || busy) lock("Nach 30 Sekunden im Hintergrund gesperrt."); }, 30_000); });
window.addEventListener("pagehide", () => { lock("Seite verlassen, Tresor gesperrt.", false); });
void load();
window.addEventListener("pageshow", event => { if (event.persisted && !vault) void load(); });
