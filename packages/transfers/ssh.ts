import { sha256 } from "@noble/hashes/sha2.js";
import { validateTransferProfile, type TransferProfile } from "./schema";

export type SSHIdentity = { id: string; label: string; created_at: string; private_key: string; public_key: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function publicKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== "ssh-ed25519" || parts[1].length > 100) throw new Error("Öffentlicher Ed25519-Schlüssel erforderlich.");
  let raw: string;
  try { raw = atob(parts[1]); } catch { throw new Error("Ungültiger öffentlicher SSH-Schlüssel."); }
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
  if (bytes.length !== 51 || btoa(raw) !== parts[1] || view.getUint32(0) !== 11 || new TextDecoder().decode(bytes.slice(4, 15)) !== "ssh-ed25519" || view.getUint32(15) !== 32) throw new Error("Ungültiger öffentlicher SSH-Schlüssel.");
  return bytes;
}
export function sshFingerprint(publicKey: string): string {
  return "SHA256:" + btoa(String.fromCharCode(...sha256(publicKeyBytes(publicKey)))).replace(/=+$/, "");
}
export function validateSSHIdentities(value: unknown): SSHIdentity[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Maximal 100 SSH-Schlüssel erlaubt.");
  const ids = new Set<string>(), fingerprints = new Set<string>();
  for (const key of value) {
    if (!key || typeof key !== "object" || Object.keys(key).sort().join() !== "created_at,id,label,private_key,public_key" || typeof key.id !== "string" || !uuid.test(key.id) || ids.has(key.id) || typeof key.label !== "string" || !key.label.trim() || key.label.length > 100 || /[\x00-\x1f\x7f]/.test(key.label) || typeof key.created_at !== "string" || !Number.isFinite(Date.parse(key.created_at)) || typeof key.private_key !== "string" || key.private_key.length > 16384 || !/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n?$/.test(key.private_key) || typeof key.public_key !== "string") throw new Error("Ungültiger SSH-Schlüsseleintrag.");
    const fingerprint = sshFingerprint(key.public_key);
    if (fingerprints.has(fingerprint)) throw new Error("Dieser SSH-Schlüssel ist bereits gespeichert.");
    ids.add(key.id); fingerprints.add(fingerprint);
  }
  return value;
}
export async function checkedSSHIdentity(label: string, privateKey: string, publicKey: string, guard = () => {}): Promise<SSHIdentity> {
  guard();
  if (publicKey.trim().includes("\n")) throw new Error("Genau einen öffentlichen SSH-Schlüssel auswählen.");
  const identity = { id: crypto.randomUUID(), label: label.trim(), created_at: new Date().toISOString(), private_key: privateKey.trim() + "\n", public_key: publicKey.trim().split(/\s+/).slice(0, 2).join(" ") };
  validateSSHIdentities([identity]);
  const bytes = Uint8Array.from(atob(identity.private_key.replace(/-----[^-]+-----|\s/g, "")), c => c.charCodeAt(0));
  try {
    const privatePart = await crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"]); guard();
    const publicPart = await crypto.subtle.importKey("raw", publicKeyBytes(identity.public_key).slice(19), "Ed25519", false, ["verify"]); guard();
    const challenge = crypto.getRandomValues(new Uint8Array(32)), signature = await crypto.subtle.sign("Ed25519", privatePart, challenge); guard();
    if (!await crypto.subtle.verify("Ed25519", publicPart, signature, challenge)) throw new Error("Privater und öffentlicher SSH-Schlüssel passen nicht zusammen.");
    guard(); return identity;
  } finally { bytes.fill(0); }
}
export function resolveSSHProfile(profile: TransferProfile, identities: SSHIdentity[]): TransferProfile {
  const p = validateTransferProfile(profile), { ssh_key_id, ...wire } = p;
  if (!ssh_key_id) return wire;
  const key = validateSSHIdentities(identities).find(key => key.id === ssh_key_id);
  if (!key) throw new Error("Der SSH-Schlüssel dieser Verbindung fehlt.");
  return validateTransferProfile({ ...wire, private_key: key.private_key, public_key: key.public_key });
}
export function removeSSHIdentity(id: string, identities: SSHIdentity[], profiles: TransferProfile[]): SSHIdentity[] {
  if (profiles.some(profile => profile.ssh_key_id === id)) throw new Error("Schlüssel wird verwendet. Ändere zuerst die zugehörigen Verbindungen.");
  return validateSSHIdentities(identities.filter(key => key.id !== id));
}
