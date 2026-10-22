export type TransferProtocol = "sftp" | "ftpes";
export type TransferProfile = {
  id: string; label: string; provider: string; protocol: TransferProtocol;
  host: string; port: number; username: string; root: string; host_key: string;
  password: string; private_key: string; public_key: string; ca_certificate?: string; ssh_key_id?: string;
};
const fields = { id: 100, label: 100, provider: 100, host: 253, username: 256, root: 1024, host_key: 100, password: 4096, private_key: 16384, public_key: 256 };
export function validateTransferProfile(value: unknown): TransferProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ungültiges Transferprofil.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).filter(key => key !== "ca_certificate" && key !== "ssh_key_id").sort().join() !== [...Object.keys(fields), "protocol", "port"].sort().join()) throw new Error("Unbekannte oder fehlende Transferfelder.");
  if ("ssh_key_id" in row && (typeof row.ssh_key_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.ssh_key_id))) throw new Error("Ungültige SSH-Schlüsselreferenz.");
  for (const [key, limit] of Object.entries(fields)) {
    if (typeof row[key] !== "string" || (row[key] as string).length > limit || (key !== "private_key" && key !== "password" && /[\x00-\x1f\x7f]/.test(row[key] as string))) throw new Error("Ungültiges Transferfeld: " + key + ".");
  }
  if ("ca_certificate" in row) {
    const pem = row.ca_certificate;
    if (typeof pem !== "string" || pem.length > 16384 || row.protocol !== "ftpes") throw new Error("Eigene Stammzertifizierungsstelle ist nur für FTPES erlaubt (maximal 16 KB).");
    if (pem) {
      if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(pem)) throw new Error("Öffentliches CA-Zertifikat im PEM-CERTIFICATE-Format erforderlich; keine privaten Schlüssel.");
      const encoded = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
      let bytes: string;
      try { bytes = atob(encoded); } catch { throw new Error("Ungültige CA-Zertifikatskodierung."); }
      if (bytes.length < 128 || bytes.charCodeAt(0) !== 0x30 || btoa(bytes) !== encoded) throw new Error("Ungültiges CA-Zertifikatsformat. Der Server prüft die Zertifikatskette beim Verbindungsaufbau.");
    }
  }
  const p = row as unknown as TransferProfile;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id) || !p.label.trim() || !p.username.trim()) throw new Error("Name, Benutzer und eindeutige Profil-ID erforderlich.");
  if (!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\]|[0-9a-fA-F:]+)$/.test(p.host) || p.host.includes("..")) throw new Error("Servernamen ohne URL oder Zugangsdaten eingeben.");
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error("Port muss zwischen 1 und 65535 liegen.");
  if (p.root !== "/") throw new Error("Verwende einen serverseitig auf den Zielordner begrenzten Transferbenutzer. / bezeichnet dessen gesamte Kontowurzel; eine lokale Unterordnerprüfung ersetzt diese Grenze nicht.");
  if (p.protocol === "sftp") {
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(p.host_key)) throw new Error("Bestätigter SHA256-Hostschlüssel erforderlich.");
    if (p.ssh_key_id ? !!p.password || !!p.private_key || !!p.public_key : !!p.password === !!p.private_key || (!!p.private_key !== !!p.public_key)) throw new Error("SFTP benötigt genau ein Passwort, Schlüsselpaar oder einen gespeicherten SSH-Schlüssel.");
    if (p.private_key && (!/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n?$/.test(p.private_key) || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(p.public_key))) throw new Error("Ed25519-Schlüssel im PKCS8-/OpenSSH-Format erforderlich.");
  } else if (p.protocol === "ftpes") {
    if (!p.password || p.private_key || p.public_key || p.host_key || p.ssh_key_id) throw new Error("FTPES benötigt Passwort und überprüftes TLS; SSH-Schlüssel sind unzulässig.");
  } else throw new Error("Nur SFTP oder explizites FTP über TLS (FTPES) erlaubt.");
  return { ...p };
}
export function validateTransfers(value: unknown): TransferProfile[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Maximal 100 Transferprofile erlaubt.");
  const ids = new Set<string>();
  return value.map(item => { const p = validateTransferProfile(item); if (ids.has(p.id)) throw new Error("Doppelte Transferprofil-ID."); ids.add(p.id); return p; });
}
export function validateTransferPath(path: string, operation: string): void {
  if (typeof path !== "string" || path.length > 1024 || (!path && operation !== "list") || path.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some(part => part === "." || part === ".." || (!part && path !== ""))) throw new Error("Ungültiger relativer Transferpfad.");
}
