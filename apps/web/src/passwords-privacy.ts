import { createIcon } from "./passwords-presentation";
export interface PrivacyPreferences { discreet: boolean; strictBackground: boolean; revealSeconds: 10 | 15 | 30 }
const defaults: PrivacyPreferences = { discreet: false, strictBackground: false, revealSeconds: 15 };
const actions = ["unlock", "create", "save", "delete", "import", "restore", "rekey", "backup", "copy", "reveal", "privacy", "operation"] as const;
type Action = typeof actions[number];
interface Activity { action: Action; state: "success" | "error"; timestamp: string; count?: number }
let activities: Activity[] = [];
let preferences = { ...defaults };
export function parsePrivacyPreferences(raw: unknown): PrivacyPreferences {
  let value: unknown;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { ...defaults }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaults };
  const item = value as Record<string, unknown>;
  return { discreet: item.discreet === true, strictBackground: item.strictBackground === true, revealSeconds: item.revealSeconds === 10 || item.revealSeconds === 30 ? item.revealSeconds : 15 };
}
export function getPrivacyPreferences(): PrivacyPreferences { return { ...preferences }; }
export function sanitizeActivity(action: unknown, state: unknown, count?: unknown): Activity | null {
  if (!actions.includes(action as Action) || (state !== "success" && state !== "error")) return null;
  return { action: action as Action, state, timestamp: new Date().toISOString(), ...(typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 1000 ? { count } : {}) };
}
export function readActivities(): Activity[] { return activities.map(event => ({ ...event })); }
export function recordActivity(action: unknown, state: unknown = "success", count?: unknown): void {
  const event = sanitizeActivity(action, state, count);
  if (!event) return;
  activities.push(event); activities = activities.slice(-40); renderActivities();
}
export function clearActivities(): void { activities = []; renderActivities(); }
export function buildDiagnostics(settings: unknown = preferences) {
  return { app: "HeavenKey", version: "1", settings: parsePrivacyPreferences(settings), events: readActivities() };
}
const labels: Record<Action, string> = { unlock: "Entsperrt", create: "Tresor angelegt", save: "Gespeichert", delete: "Gelöscht", import: "Importiert", restore: "Wiederhergestellt", rekey: "Masterpasswort geändert", backup: "Sicherung erstellt", copy: "Kopiert", reveal: "Passwort angezeigt", privacy: "Datenschutz geändert", operation: "Vorgang" };
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element;
}
function renderActivities(): void {
  if (typeof document === "undefined") return;
  const list = document.getElementById("activity-log"); if (!list) return;
  list.replaceChildren(...activities.map(event => node("li", `${new Date(event.timestamp).toLocaleTimeString("de")} · ${labels[event.action]} · ${event.state === "success" ? "Erfolgreich" : "Fehlgeschlagen"}${event.count === undefined ? "" : ` · ${event.count}`}`)));
  if (!activities.length) list.append(node("li", "Keine Vorgänge in dieser Sitzung."));
}
export function initPrivacy(onChange: () => void): void {
  try { preferences = parsePrivacyPreferences(localStorage.getItem("heavenkey-privacy")); } catch { preferences = { ...defaults }; }
  const section = document.getElementById("privacy-settings"); if (!section) return;
  const heading = node("h2", "Datenschutz"); heading.id = "privacy-heading";
  const explanation = node("p", "Die diskrete Ansicht verdeckt Benutzername, Website und Notizen. Titel und Tags bleiben sichtbar. Kopieren bleibt möglich; Bearbeiten, Passwortanzeige und Einmalcodes sind gesperrt.");
  explanation.id = "discreet-description";
  const toggle = node("button", "Diskrete Ansicht"); toggle.prepend(createIcon("vault")); toggle.id = "discreet-toggle"; toggle.type = "button"; toggle.className = "nav-button"; toggle.setAttribute("aria-describedby", explanation.id);
  document.querySelector(".sidebar-bottom")?.prepend(toggle);
  const strictLabel = node("label"); strictLabel.className = "checkbox";
  const strict = node("input"); strict.type = "checkbox"; strict.id = "strict-background";
  strictLabel.append(strict, node("span", "Beim Wechsel in den Hintergrund sofort sperren"));
  const durationLabel = node("label", "Passwortanzeige begrenzen"); durationLabel.htmlFor = "reveal-duration";
  const duration = node("select"); duration.id = "reveal-duration";
  for (const seconds of [10, 15, 30]) { const option = node("option", `${seconds} Sekunden`); option.value = String(seconds); duration.append(option); }
  function reflect(): void { toggle.setAttribute("aria-pressed", String(preferences.discreet)); strict.checked = preferences.strictBackground; duration.value = String(preferences.revealSeconds); }
  function update(next: PrivacyPreferences): void {
    preferences = next; reflect();
    try { localStorage.setItem("heavenkey-privacy", JSON.stringify(preferences)); } catch { const message = document.getElementById("privacy-storage-status"); if (message) message.textContent = "Einstellungen gelten für diesen Tab. Der Browser erlaubt keine dauerhafte Speicherung."; }
    recordActivity("privacy"); onChange();
  }
  toggle.addEventListener("click", () => update({ ...preferences, discreet: !preferences.discreet }));
  strict.addEventListener("change", () => update({ ...preferences, strictBackground: strict.checked }));
  duration.addEventListener("change", () => update(parsePrivacyPreferences({ ...preferences, revealSeconds: Number(duration.value) })));
  const storageStatus = node("p"); storageStatus.id = "privacy-storage-status"; storageStatus.setAttribute("role", "status");
  const logHeading = node("h3", "Vorgänge dieser Sitzung");
  const logDescription = node("p", "Bis zu 40 Vorgänge mit Zeit, Aktion und Ergebnis. Ohne Kontoinhalte oder Fehlertexte. Beim Sperren wird das Protokoll gelöscht. Der Diagnoseexport enthält nur diese Angaben und deine Datenschutzeinstellungen.");
  const log = node("ol"); log.id = "activity-log";
  const clear = node("button", "Protokoll leeren"); clear.id = "clear-activity"; clear.type = "button"; clear.className = "secondary"; clear.addEventListener("click", clearActivities);
  const diagnostics = node("button", "Diagnose exportieren"); diagnostics.id = "export-diagnostics"; diagnostics.type = "button"; diagnostics.className = "secondary";
  diagnostics.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(buildDiagnostics(), null, 2)], { type: "application/json" }));
    const link = node("a"); link.href = url; link.download = "heavenkey-diagnostics.json"; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const controls = node("div"); controls.className = "field-actions"; controls.append(clear, diagnostics);
  section.append(heading, explanation, strictLabel, durationLabel, duration, storageStatus, logHeading, logDescription, log, controls); reflect(); renderActivities();
}
