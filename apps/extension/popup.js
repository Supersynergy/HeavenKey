import { target, destinations } from "./settings.js";
const form = document.getElementById("open-form");
const portInput = document.getElementById("port");
const mode = document.getElementById("mode");
const endpoint = document.getElementById("endpoint");
const destination = document.getElementById("destination");
const status = document.getElementById("status");
const extension = globalThis.browser || globalThis.chrome;
function update() {
  const local = mode.value === "local";
  document.getElementById("local-settings").hidden = !local;
  document.getElementById("remote-settings").hidden = local;
  portInput.required = local; portInput.disabled = !local;
  endpoint.required = !local; endpoint.disabled = local;
}
try {
  const saved = JSON.parse(localStorage.getItem("heavenkey.connection.v1") || "null");
  if (saved) {
    target(saved);
    mode.value = saved.mode; portInput.value = String(saved.port || 18240);
    endpoint.value = saved.endpoint || "";
    if (destinations.has(saved.destination)) destination.value = saved.destination;
  }
} catch { localStorage.removeItem("heavenkey.connection.v1"); }
mode.addEventListener("change", update); update();
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const settings = { mode: mode.value, port: portInput.value, endpoint: endpoint.value.trim(), destination: destination.value };
  try {
    const url = target(settings);
    await extension.tabs.create({ url });
    try { localStorage.setItem("heavenkey.connection.v1", JSON.stringify(settings)); } catch { /* Tab opening also works without persistent preferences. */ }
    status.textContent = settings.destination === "passwords" ? "Der lokale Passwortmanager ist geöffnet. Entsperre ihn dort mit deinem Masterpasswort." : "Das separat gestartete Zugangslabor ist geöffnet. Bestätige dort mit deinem Passkey.";
  } catch (error) { status.textContent = `Tab konnte nicht geöffnet werden: ${error instanceof Error ? error.message : "Unbekannter Fehler"}`; }
});
