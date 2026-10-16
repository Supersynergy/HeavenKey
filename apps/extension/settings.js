export const destinations = new Set(["passwords", "overview", "keys", "access", "recovery", "agents", "vault", "help"]);
export function target(settings) {
  if (!destinations.has(settings.destination)) throw new Error("Unbekanntes Ziel.");
  let origin;
  if (settings.mode === "local") {
    if (!/^\d+$/.test(String(settings.port))) throw new Error("Port muss eine ganze Zahl sein.");
    const port = Number(settings.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port muss zwischen 1 und 65535 liegen.");
    origin = `http://localhost:${port}`;
  } else if (settings.mode === "https") {
    let parsed;
    try { parsed = new URL(settings.endpoint); } catch { throw new Error("Bitte eine vollständige HTTPS-Adresse eingeben."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("Nur die HTTPS-Basisadresse ohne Pfad, Anmeldung oder Parameter eingeben.");
    origin = parsed.origin;
  } else throw new Error("Unbekannte Verbindung.");
  if (settings.destination === "passwords") {
    if (settings.mode !== "local") throw new Error("Der Passwortmanager ist ausschließlich lokal verfügbar.");
    return `${origin}/passwords/`;
  }
  return `${origin}/${settings.destination === "overview" ? "" : `#${settings.destination}`}`;
}
