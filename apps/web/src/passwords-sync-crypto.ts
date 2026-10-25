import { decode64, encode64, freshBytes, validateVault, type Login } from "./passwords-crypto";
import { validateWebsitePasskeys, type WebsitePasskey } from "./passwords-passkey-record";

export type SyncSnapshot = { version: 1; entries: Login[]; passkeys: WebsitePasskey[] };
export type SyncLink = { id: string; key: string; baseline: SyncSnapshot; revision: number };
export type SyncCipher = { version: 1; iv: string; ciphertext: string };
const encoder = new TextEncoder();
export const emptySnapshot = (): SyncSnapshot => ({ version: 1, entries: [], passkeys: [] });
export function validateSnapshot(value: unknown): SyncSnapshot {
  const row = value as SyncSnapshot;
  if (!row || typeof row !== "object" || Object.keys(row).sort().join() !== "entries,passkeys,version" || row.version !== 1) throw new Error("Ungültiger Synchronisierungsstand.");
  validateVault({ version: 1, entries: row.entries });
  validateWebsitePasskeys(row.passkeys);
  if (encoder.encode(JSON.stringify(row)).length > 1_000_000) throw new Error("Synchronisierungsstand überschreitet 1 MB.");
  return row;
}
export function validateSyncLinks(value: unknown): SyncLink[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("Ungültige Geräteverbindungen.");
  const ids = new Set<string>();
  for (const link of value) {
    if (!link || Object.keys(link).sort().join() !== "baseline,id,key,revision" || typeof link.id !== "string" || !/^[0-9a-f-]{36}$/.test(link.id) || ids.has(link.id) || decode64(link.key, 32).length !== 32 || !Number.isSafeInteger(link.revision) || link.revision < 1) throw new Error("Ungültige Geräteverbindung.");
    validateSnapshot(link.baseline); ids.add(link.id);
  }
  return value;
}
function canonical(value: unknown): string {
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value);
}
function mergeRows<T extends { id: string }>(base: T[], local: T[], remote: T[]): T[] {
  const [b, l, r] = [base, local, remote].map(rows => new Map(rows.map(row => [row.id, row])));
  const result: T[] = [];
  for (const id of [...new Set([...b.keys(), ...l.keys(), ...r.keys()])].sort()) {
    const old = b.get(id), mine = l.get(id), theirs = r.get(id);
    const oldValue = canonical(old), myValue = canonical(mine), theirValue = canonical(theirs);
    const next = myValue === oldValue ? theirs : theirValue === oldValue || myValue === theirValue ? mine : null;
    if (next === null) throw new Error("Synchronisierungskonflikt: Ein Eintrag wurde auf beiden Geräten geändert oder gelöscht. Beide Stände bleiben erhalten.");
    if (next !== undefined) result.push(next);
  }
  return result;
}
export function mergeSnapshots(base: SyncSnapshot, local: SyncSnapshot, remote: SyncSnapshot): SyncSnapshot {
  [base, local, remote].forEach(validateSnapshot);
  return validateSnapshot({ version: 1, entries: mergeRows(base.entries, local.entries, remote.entries), passkeys: mergeRows(base.passkeys, local.passkeys, remote.passkeys) });
}
async function key(value: string) {
  const bytes = decode64(value, 32);
  try { if (bytes.length !== 32) throw new Error("Ungültiger Synchronisierungsschlüssel."); return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]); }
  finally { bytes.fill(0); }
}
function aad(id: string, revision: number) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Ungültige Synchronisierungsrevision.");
  return encoder.encode(`HeavenKey/sync/v1\0${id}\0${revision}`);
}
export async function sealSnapshot(value: SyncSnapshot, secret: string, id: string, revision: number): Promise<SyncCipher> {
  const bytes = encoder.encode(JSON.stringify(validateSnapshot(value))), iv = freshBytes(12);
  try { return { version: 1, iv: encode64(iv), ciphertext: encode64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(id, revision) }, await key(secret), bytes))) }; }
  finally { bytes.fill(0); }
}
export async function openSnapshot(value: SyncCipher, secret: string, id: string, revision: number): Promise<SyncSnapshot> {
  if (!value || Object.keys(value).sort().join() !== "ciphertext,iv,version" || value.version !== 1 || decode64(value.iv, 12).length !== 12) throw new Error("Ungültiges Synchronisierungsformat.");
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode64(value.iv, 12), additionalData: aad(id, revision) }, await key(secret), decode64(value.ciphertext, 1_500_016)));
  try { return validateSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  finally { bytes.fill(0); }
}
export async function openLinkedSnapshot(link: SyncLink, remote: {revision: number; record: SyncCipher}): Promise<SyncSnapshot> {
  if (!Number.isSafeInteger(remote.revision) || remote.revision < link.revision) throw new Error("Der Desktop meldet einen älteren Synchronisierungsstand. Die Verbindung bitte prüfen; lokale Daten bleiben erhalten.");
  return openSnapshot(remote.record, link.key, link.id, remote.revision);
}
