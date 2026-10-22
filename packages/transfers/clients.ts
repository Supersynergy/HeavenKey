import { clients } from "./catalog";
import { exportFileZilla } from "./import";
import { validateTransferProfile, type TransferProfile } from "./schema";

export type ClientExport = { filename: string; content: string; mime: string; notice: string };
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const quoted = (s: string) => '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

export function exportClientProfile(clientId: string, source: TransferProfile): ClientExport {
  const p = validateTransferProfile(source);
  const client = clients.find(item => item.id === clientId);
  if (!client || !client.protocols.includes(p.protocol)) throw new Error("Dieses Programm unterstützt das gewählte Protokoll nicht.");
  const notice = "Enthält Verbindungsdaten, keine Zugangsdaten. Die Anmeldung im externen Programm liegt außerhalb der HeavenKey-Agentenfreigabe. Serveridentität dort erneut prüfen. " + client.note;
  const name = "heavenkey-" + p.id;
  if (client.integration === "filezilla") return { filename: name + ".xml", content: exportFileZilla([p]), mime: "application/xml", notice };
  if (client.integration === "cyberduck") {
    const fields = { Protocol: p.protocol === "sftp" ? "sftp" : "ftps", Hostname: p.host, Username: p.username, Port: String(p.port), Path: p.root, Nickname: p.label };
    return {filename: name + ".duck", mime:"application/xml", notice, content: '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' + Object.entries(fields).map(([k,v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("") + "</dict></plist>\n"};
  }
  if (client.integration === "openssh") {
    if (!/^[a-zA-Z0-9_.@-]+$/.test(p.username)) throw new Error("Benutzername kann nicht als OpenSSH-Profil exportiert werden.");
    return {filename:name + ".sshconfig", mime:"text/plain", notice, content:[`Host ${name}`,`  HostName ${quoted(p.host)}`,`  User ${quoted(p.username)}`,`  Port ${p.port}`,"  StrictHostKeyChecking yes","  ForwardAgent no","  PermitLocalCommand no","  ClearAllForwardings yes","  IdentitiesOnly yes","  IdentityAgent none", ""].join("\n")};
  }
  if (client.integration === "rclone") {
    if (/[^a-zA-Z0-9_.:@-]/.test(p.host) || /[\r\n]/.test(p.username)) throw new Error("Verbindungsdaten können nicht als rclone-Profil exportiert werden.");
    const fields = p.protocol === "sftp"
      ? ["type = sftp",`host = ${p.host}`,`user = ${p.username}`,`port = ${p.port}`,"known_hosts_file = ~/.ssh/known_hosts","disable_hashcheck = true"]
      : ["type = ftp",`host = ${p.host}`,`user = ${p.username}`,`port = ${p.port}`,"explicit_tls = true","no_check_certificate = false","disable_tls13 = false"];
    return {filename:name + ".rclone.conf",mime:"text/plain",notice,content:[`[${name}]`,...fields,""].join("\n")};
  }
  if (client.integration === "lftp") {
    if (/[^a-zA-Z0-9_.@-]/.test(p.username) || /[^a-zA-Z0-9_./ -]/.test(p.root)) throw new Error("Diese Verbindung benötigt eine manuelle Einrichtung in lftp.");
    const host = p.host.includes(":") ? `[${p.host}]` : p.host;
    const url = `${p.protocol === "sftp" ? "sftp" : "ftp"}://${encodeURIComponent(p.username)}@${host}:${p.port}`;
    const lines = ["set ssl:verify-certificate yes", "set net:max-retries 1", "set net:timeout 15"];
    if (p.protocol === "ftpes") lines.push("set ftp:ssl-force yes", "set ftp:ssl-protect-data yes", "set ftp:ssl-protect-list yes");
    else lines.push('set sftp:connect-program "ssh -a -x -oForwardAgent=no -oStrictHostKeyChecking=yes"');
    lines.push("open " + quoted(url), "cd " + quoted(p.root), "");
    return {filename:name + ".lftp",mime:"text/plain",notice,content:lines.join("\n")};
  }
  const details = {program:client.name,protocol:p.protocol,host:p.host,port:p.port,username:p.username,root:p.root,host_key:p.host_key,authentication:"Im Programm separat einrichten; kein Passwort oder privater Schlüssel enthalten.",documentation:client.docs};
  return {filename:name + "-" + client.id + ".json",content:JSON.stringify(details,null,2)+"\n",mime:"application/json",notice};
}
