export type ConnectionSuggestion = { host: string; port: number; username: string; protocol: "sftp" | "ftpes"; source: string };
export function previewConnection(value: string): ConnectionSuggestion {
  const input = value.trim();
  if (!input || input.length > 1000 || /[\x00-\x1f\x7f]/.test(input)) throw new Error("Eine einzelne Verbindungsadresse oder einen einfachen SSH-Aufruf eingeben.");
  let address = input, source = "Verbindungsadresse";
  if (input.startsWith("ssh ")) {
    const match = /^ssh\s+([a-zA-Z0-9_.@:[\]-]+)(?:\s+-p\s+([0-9]{1,5}))?$/.exec(input);
    if (!match) throw new Error("Nur ssh benutzer@server -p PORT wird übernommen. Befehle und SSH-Optionen werden nicht ausgeführt.");
    address = "sftp://" + match[1] + (match[2] ? ":" + match[2] : ""); source = "SSH-Aufruf (nur Verbindungsdaten)";
  } else if (!input.includes("://")) address = "sftp://" + input;
  let url: URL;
  try { url = new URL(address); } catch { throw new Error("Ungültige Verbindungsadresse."); }
  if (!["sftp:", "ftpes:", "ftps:"].includes(url.protocol) || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/") || /[\s\\]/.test(url.hostname) || !url.hostname || url.hostname.includes("..")) throw new Error("Nur SFTP oder explizites FTPES ohne Passwort, Pfad, Suchparameter oder Befehle einfügen.");
  let username: string;
  try { username = decodeURIComponent(url.username); } catch { throw new Error("Ungültiger Benutzername."); }
  if (/[\x00-\x20\x7f]/.test(username) || username.length > 256) throw new Error("Ungültiger Benutzername.");
  const protocol = url.protocol === "sftp:" ? "sftp" : "ftpes", port = url.port ? Number(url.port) : protocol === "sftp" ? 22 : 21;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Ungültiger Port.");
  return { host: url.hostname, username, port, protocol, source };
}
