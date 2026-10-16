/** Browser-only encryption. PRF outputs and plaintext never enter the API payload. */
export type WrappedKey = { salt: string; nonce: string; ciphertext: string };
export type PasskeyWrap = WrappedKey & { credential_id: string };
export type VaultRecord = { version: 1; nonce: string; ciphertext: string; wraps: PasskeyWrap[]; recovery: WrappedKey };
const encoder = new TextEncoder();
export const random = (size: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(size));
export function encode(value: Uint8Array): string { return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
export function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Ungültige Schlüsselkodierung.");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("Ungültige Schlüsselkodierung.");
  return bytes;
}
const aad = (account: string, purpose: string) => encoder.encode(`HEAVENKEY-VAULT-v1\0${account}\0${purpose}`);
async function aes(bytes: Uint8Array<ArrayBuffer>, usage: KeyUsage[]): Promise<CryptoKey> { return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usage); }
async function wrappingKey(secret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (secret.length !== 32 || salt.length !== 32) throw new Error("Schlüssel muss 32 Bytes enthalten.");
  const source = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("HeavenKey vault key wrapping v1") }, source, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function wrap(dataKey: Uint8Array<ArrayBuffer>, secret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, account: string, identity: string): Promise<WrappedKey> {
  if (dataKey.length !== 32) throw new Error("Ungültiger Tresorschlüssel.");
  const nonce = random(12);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(account, identity) }, await wrappingKey(secret, salt), dataKey);
  return { salt: encode(salt), nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function unwrap(record: WrappedKey, secret: Uint8Array<ArrayBuffer>, account: string, identity: string): Promise<Uint8Array<ArrayBuffer>> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(record.nonce), additionalData: aad(account, identity) }, await wrappingKey(secret, decode(record.salt)), decode(record.ciphertext));
  const bytes = new Uint8Array(plain);
  if (bytes.length !== 32) throw new Error("Ungültiger Tresorschlüssel.");
  return bytes;
}
export async function seal(text: string, key: Uint8Array<ArrayBuffer>, account: string): Promise<{ nonce: string; ciphertext: string }> {
  const plain = encoder.encode(text);
  if (plain.length > 4096) throw new Error("Der Pilot speichert höchstens 4096 UTF-8-Bytes.");
  const nonce = random(12);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(account, "data") }, await aes(key, ["encrypt"]), plain);
  return { nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function open(record: Pick<VaultRecord, "nonce" | "ciphertext">, key: Uint8Array<ArrayBuffer>, account: string): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(record.nonce), additionalData: aad(account, "data") }, await aes(key, ["decrypt"]), decode(record.ciphertext));
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}
