import { type TransferProtocol, type TransferProfile } from "./schema";
export type TransferImportRow = { label: string; host: string; port: number; username: string; protocol: TransferProtocol; root: string; warnings: string[] };
export function previewFileZilla(xml: string): TransferImportRow[] {
  if (xml.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unzulässige oder zu große XML-Datei.");
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror") || document.documentElement.tagName !== "FileZilla3") throw new Error("Ungültiger FileZilla-Export.");
  const servers = [...document.querySelectorAll("Servers Server")];
  if (!servers.length || servers.length > 100) throw new Error("1 bis 100 Server erwartet.");
  return servers.map(server => {
    const text = (name: string) => [...server.children].find(child => child.tagName === name)?.textContent?.trim() ?? "";
    const code = text("Protocol");
    if (code !== "1" && code !== "4") throw new Error("Import gestoppt: Nur SFTP (1) und explizites FTPES (4) sind erlaubt.");
    const host = text("Host"), label = text("Name") || host, username = text("User"), port = Number(text("Port"));
    if (!host || host.length > 253 || !label || label.length > 100 || username.length > 256 || !Number.isInteger(port) || port < 1 || port > 65535 || /[\x00-\x1f\x7f]/.test(host + label + username)) throw new Error("Ungültige Serverdaten im Import.");
    const warnings = ["Zugangsdaten werden verworfen und müssen im Tresor ergänzt werden."];
    if (code === "1") warnings.push("SHA256-Hostfingerabdruck beim Anbieter überprüfen und ergänzen.");
    if (text("RemoteDir")) warnings.push("FileZilla-Pfad wird nicht übernommen. Stammverzeichnis prüfen.");
    return { label, host, port, username, protocol: code === "1" ? "sftp" : "ftpes", root: "/", warnings };
  });
}
const escape = (text: string) => text.replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);
export function exportFileZilla(profiles: TransferProfile[]): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<FileZilla3><Servers>' + profiles.map(p => '<Server><Host>' + escape(p.host) + '</Host><Port>' + p.port + '</Port><Protocol>' + (p.protocol === "sftp" ? "1" : "4") + '</Protocol><Type>0</Type><Logontype>2</Logontype><Name>' + escape(p.label) + '</Name></Server>').join("") + '</Servers></FileZilla3>\n';
}
