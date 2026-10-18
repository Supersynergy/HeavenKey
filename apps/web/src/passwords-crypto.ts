/** Local password vault: only authenticated ciphertext crosses the API boundary. */
import { validateProfiles, type FormProfile } from "../../../packages/forms/schema";
import { argon2idAsync } from "@noble/hashes/argon2.js";
export const ITERATIONS = 600_000;
export const MAX_ITEMS = 1000;
export const MAX_PLAIN_BYTES = 1_000_000;
export const MAX_FILE_BYTES = 2_000_000;
type Ciphertext = { salt: string; iv: string; ciphertext: string };
export type Envelope = Ciphertext & ({ version: 1; kdf: "PBKDF2-SHA256"; iterations: 600000 } | { version: 2; kdf: "Argon2id"; iterations: 3; memory_kib: 65536; parallelism: 1 });
export type Login = { id: string; title: string; username: string; password: string; url: string; notes: string; totp: string; tags: string[]; favorite: boolean };
export type Vault = { version: 1 | 2; entries: Login[]; profiles?: FormProfile[] };
const utf8 = new TextEncoder();
const aad = utf8.encode("HeavenKey password vault v1");
const argon2Scheme = { version: 2, kdf: "Argon2id", iterations: 3, memory_kib: 65536, parallelism: 1 } as const;
const authenticationData = (envelope: Envelope) => envelope.version === 1 ? aad : utf8.encode(`HeavenKey password vault v2|Argon2id|v=19|m=65536|t=3|p=1|dkLen=32|salt=${envelope.salt}`);
export const freshBytes = (length: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(length));
export function encode64(bytes: Uint8Array): string {
  let raw = "";
  for (let start = 0; start < bytes.length; start += 8192) raw += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decode64(value: unknown, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("Ungültige Base64url-Kodierung.");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
  if (bytes.length > max || encode64(bytes) !== value) throw new Error("Ungültige Base64url-Kodierung.");
  return bytes;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function validateEnvelope(value: unknown): Envelope {
  if (!object(value)) throw new Error("Unbekanntes Tresorformat oder unzulässige KDF-Parameter.");
  const keys = Object.keys(value).sort().join();
  const legacy = keys === "ciphertext,iterations,iv,kdf,salt,version" && value.version === 1 && value.kdf === "PBKDF2-SHA256" && value.iterations === ITERATIONS;
  const argon2 = keys === "ciphertext,iterations,iv,kdf,memory_kib,parallelism,salt,version" && value.version === 2 && value.kdf === "Argon2id" && value.iterations === 3 && value.memory_kib === 65536 && value.parallelism === 1;
  if (!legacy && !argon2) throw new Error("Unbekanntes Tresorformat oder unzulässige KDF-Parameter.");
  if (decode64(value.salt, 16).length !== 16 || decode64(value.iv, 12).length !== 12 || decode64(value.ciphertext, MAX_PLAIN_BYTES + 16).length < 16) throw new Error("Ungültige Tresorlänge.");
  return value as Envelope;
}
export function validateMaster(master: string): void {
  if (master.length < 14 || master.length > 1024) throw new Error("Das Masterpasswort braucht 14 bis 1024 Zeichen.");
}
export function validateNewMaster(master: string): void {
  validateMaster(master);
  const sample = master.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const common = new Set(["12345678901234", "123456789012345", "1234567890123456", "passwordpassword", "passwortpasswort", "qwertyqwertyqwerty", "correcthorsebatterystaple"]);
  if (common.has(sample) || /^(.{1,4})\1+$/u.test(sample)) throw new Error("Dieses neue Masterpasswort ist ein bekanntes oder wiederholtes Muster. Wähle eine lange, zufällige Passphrase.");
}
export async function derive(master: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  validateMaster(master);
  if (salt.length !== 16) throw new Error("Ungültiges Salt.");
  const bytes = utf8.encode(master);
  try {
    const source = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt }, source, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { bytes.fill(0); }
}
let derivationTail: Promise<void> = Promise.resolve();
let pendingDerivations = 0;
async function deriveArgon2(master: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  validateMaster(master);
  if (salt.length !== 16) throw new Error("Ungültiges Salt.");
  if (pendingDerivations >= 3) throw new Error("Zu viele gleichzeitige Entsperrversuche. Bitte kurz warten.");
  pendingDerivations++;
  const previous = derivationTail;
  let release!: () => void;
  derivationTail = new Promise<void>(resolve => { release = resolve; });
  let bytes: Uint8Array<ArrayBuffer> | undefined, derived: Uint8Array | undefined;
  try {
    await previous;
    bytes = utf8.encode(master);
    derived = await argon2idAsync(bytes, salt, { m: 65536, t: 3, p: 1, version: 19, dkLen: 32, maxmem: 65536 * 1024, asyncTick: 10 });
    return await crypto.subtle.importKey("raw", derived as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    bytes?.fill(0); derived?.fill(0); salt.fill(0);
    pendingDerivations--; release();
  }
}
export function validateVault(value: unknown): Vault {
  if (!object(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.entries) || value.entries.length > MAX_ITEMS || (value.version === 2 && value.profiles === undefined)) throw new Error("Ungültige Tresordaten oder zu viele Einträge (maximal 1000).");
  if (value.profiles !== undefined) validateProfiles(value.profiles);
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry)) throw new Error("Ungültiger Eintrag.");
    for (const [name, limit] of Object.entries({ id: 100, title: 200, username: 1000, password: 4096, url: 4096, notes: 10000, totp: 1024 })) {
      if (typeof entry[name] !== "string" || (entry[name] as string).length > limit) throw new Error(`Ungültiges Feld: ${name}.`);
    }
    if (!entry.id || !(entry.title as string).trim() || ids.has(entry.id as string) || typeof entry.favorite !== "boolean" || !Array.isArray(entry.tags) || entry.tags.length > 20 || entry.tags.some(tag => typeof tag !== "string" || tag.length > 80)) throw new Error("Ungültiger Titel, ID, Favorit oder Tags.");
    ids.add(entry.id as string);
    if (entry.url) { try { if (!["https:", "http:"].includes(new URL(entry.url as string).protocol)) throw new Error(); } catch { throw new Error("URLs müssen mit https:// oder http:// beginnen."); } }
    if (entry.totp) parseTotp(entry.totp as string);
  }
  if (utf8.encode(JSON.stringify(value)).length > MAX_PLAIN_BYTES) throw new Error("Der Tresor überschreitet 1 MB Klartext.");
  return (value.profiles !== undefined ? {...value,version:2} : value) as Vault;
}
export async function sealVault(vault: Vault, key: CryptoKey, source: Envelope | string): Promise<Envelope> {
  vault = validateVault(vault);
  const envelope: Envelope = typeof source === "string"
    ? { version: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: source, iv: encode64(new Uint8Array(12)), ciphertext: encode64(new Uint8Array(16)) }
    : validateEnvelope(source);
  if (decode64(envelope.salt, 16).length !== 16) throw new Error("Ungültiges Salt.");
  const plain = utf8.encode(JSON.stringify(vault));
  try {
    const iv = freshBytes(12);
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: authenticationData(envelope) }, key, plain);
    return { ...envelope, iv: encode64(iv), ciphertext: encode64(new Uint8Array(cipher)) };
  } finally { plain.fill(0); }
}
export async function openVault(value: unknown, master: string): Promise<{ vault: Vault; key: CryptoKey; envelope: Envelope }> {
  const envelope = validateEnvelope(value);
  const salt = decode64(envelope.salt, 16);
  let key: CryptoKey;
  try { key = await (envelope.version === 1 ? derive(master, salt) : deriveArgon2(master, salt)); }
  finally { salt.fill(0); }
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode64(envelope.iv, 12), additionalData: authenticationData(envelope) }, key, decode64(envelope.ciphertext, MAX_PLAIN_BYTES + 16)));
    const vault = validateVault(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return { vault, key, envelope };
  } catch { throw new Error("Entsperren fehlgeschlagen: Passwort falsch, Datei beschädigt oder Format ungültig."); }
  finally { bytes?.fill(0); }
}
export async function createVault(master: string, vault: Vault = { version: 1, entries: [] }): Promise<{ vault: Vault; key: CryptoKey; envelope: Envelope }> {
  validateNewMaster(master);
  vault = validateVault(vault);
  const salt = freshBytes(16), encodedSalt = encode64(salt);
  try {
    const key = await deriveArgon2(master, salt);
    const source: Envelope = { ...argon2Scheme, salt: encodedSalt, iv: encode64(new Uint8Array(12)), ciphertext: encode64(new Uint8Array(16)) };
    return { vault, key, envelope: await sealVault(vault, key, source) };
  } finally { salt.fill(0); }
}
export function generatePassword(length = 24, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&()*+,-./:;<=>?@[]^_{|}~"): string {
  if (!Number.isInteger(length) || length < 14 || length > 128 || alphabet.length < 2 || alphabet.length > 256 || new Set(alphabet).size !== alphabet.length || [...alphabet].length !== alphabet.length) throw new Error("Ungültige Generatorparameter.");
  const ceiling = 256 - 256 % alphabet.length;
  let result = "";
  while (result.length < length) for (const value of freshBytes(128)) { if (value < ceiling) result += alphabet[value % alphabet.length]; if (result.length === length) break; }
  return result;
}
export type TotpConfig = { secret: Uint8Array<ArrayBuffer>; algorithm: "SHA-1" | "SHA-256" | "SHA-512"; digits: 6 | 8; period: number };
function base32(value: string): Uint8Array<ArrayBuffer> {
  const clean = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z2-7]{16,832}={0,6}$/.test(clean)) throw new Error("Ungültiger TOTP-Base32-Schlüssel.");
  const raw = clean.replace(/=+$/, "");
  if ([1, 3, 6].includes(raw.length % 8) || (clean.includes("=") && (clean.length % 8 !== 0 || clean.length - raw.length !== (8 - raw.length % 8) % 8))) throw new Error("Ungültige TOTP-Base32-Länge.");
  let bits = 0, buffer = 0;
  const result: number[] = [];
  for (const char of raw) { buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); bits += 5; if (bits >= 8) { bits -= 8; result.push((buffer >>> bits) & 255); } }
  if (bits && (buffer & (1 << bits) - 1)) throw new Error("Ungültige TOTP-Base32-Endbits.");
  return new Uint8Array(result);
}
export function parseTotp(value: string): TotpConfig {
  let secret = value.trim(), algorithm: TotpConfig["algorithm"] = "SHA-1", digits: 6 | 8 = 6, period = 30;
  if (secret.startsWith("otpauth://")) {
    const uri = new URL(secret);
    if (uri.protocol !== "otpauth:" || uri.hostname !== "totp" || uri.username || uri.password) throw new Error("Nur TOTP-URIs werden unterstützt.");
    secret = uri.searchParams.get("secret") ?? "";
    const algo = (uri.searchParams.get("algorithm") ?? "SHA1").toUpperCase().replace("-", "");
    if (!["SHA1", "SHA256", "SHA512"].includes(algo)) throw new Error("Unbekannter TOTP-Algorithmus.");
    algorithm = algo === "SHA1" ? "SHA-1" : algo === "SHA256" ? "SHA-256" : "SHA-512";
    const n = Number(uri.searchParams.get("digits") ?? "6");
    if (n !== 6 && n !== 8) throw new Error("TOTP unterstützt 6 oder 8 Ziffern.");
    digits = n;
    period = Number(uri.searchParams.get("period") ?? "30");
    if (!Number.isInteger(period) || period < 15 || period > 120) throw new Error("Ungültiges TOTP-Zeitfenster.");
  }
  return { secret: base32(secret), algorithm, digits, period };
}
export async function totp(value: string, time = Date.now()): Promise<{ code: string; remaining: number }> {
  if (!Number.isFinite(time) || time < 0) throw new Error("Ungültige Zeit.");
  const config = parseTotp(value), counter = new Uint8Array(8);
  let tick = BigInt(Math.floor(time / 1000 / config.period));
  for (let i = 7; i >= 0; i--) { counter[i] = Number(tick & 255n); tick >>= 8n; }
  try {
    const key = await crypto.subtle.importKey("raw", config.secret, { name: "HMAC", hash: config.algorithm }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter)), offset = digest[digest.length - 1] & 15;
    const n = ((digest[offset] & 127) << 24 | digest[offset + 1] << 16 | digest[offset + 2] << 8 | digest[offset + 3]) >>> 0;
    return { code: String(n % 10 ** config.digits).padStart(config.digits, "0"), remaining: config.period - Math.floor(time / 1000) % config.period };
  } finally { config.secret.fill(0); }
}
/** RFC4180 quoting; validate every row before returning anything to the caller. */
export function parseCsv(text: string): Login[] {
  if (utf8.encode(text).length > MAX_FILE_BYTES) throw new Error("CSV darf höchstens 2 MB groß sein.");
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += char; }
    else if (char === ",") { row.push(cell); cell = ""; closed = false; }
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; closed = false; }
    else if (char === '"' && !cell && !closed) quoted = true;
    else { if (closed || char === '"') throw new Error("Ungültige CSV-Anführungszeichen."); cell += char; }
    if (rows.length > MAX_ITEMS + 1) throw new Error("CSV enthält zu viele Einträge.");
  }
  if (quoted) throw new Error("CSV-Zitat ist nicht geschlossen.");
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error("CSV braucht eine Kopfzeile und mindestens einen Eintrag.");
  const headers = rows.shift()!.map(h => h.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error("Doppelte CSV-Spalten.");
  const get = (cells: string[], ...names: string[]) => { for (const name of names) { const index = headers.indexOf(name); if (index >= 0) return cells[index] ?? ""; } return ""; };
  if (!headers.some(h => ["name", "title"].includes(h)) || !headers.some(h => ["password", "login_password"].includes(h))) throw new Error("CSV braucht name/title und password/login_password.");
  const entries = rows.map(cells => {
    if (cells.length !== headers.length) throw new Error("CSV-Zeile hat eine andere Spaltenzahl als die Kopfzeile.");
    const kind = get(cells, "type");
    if (kind && !["login", "1", "password"].includes(kind.toLowerCase())) throw new Error("CSV enthält einen nicht unterstützten Eintragstyp. Nur Logins importieren.");
    const favorite = get(cells, "favorite", "favourite").toLowerCase();
    if (favorite && !["1", "0", "true", "false", "yes", "no"].includes(favorite)) throw new Error("Ungültiger Favoritenwert.");
    return { id: crypto.randomUUID(), title: get(cells, "name", "title"), username: get(cells, "login_username", "username", "user name", "login", "email"), password: get(cells, "login_password", "password"), url: get(cells, "login_uri", "url", "website", "web site"), notes: get(cells, "notes", "note"), totp: get(cells, "login_totp", "totp", "one-time password", "otp"), favorite: ["1", "true", "yes"].includes(favorite), tags: get(cells, "tags", "folder").split(/[;,]/).map(v => v.trim()).filter(Boolean) };
  });
  return validateVault({ version: 1, entries }).entries;
}
