import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { PROFILE as GRANT_PROFILE, id as grantId, message as grantMessage } from "./delegation-reference.mjs";

export const UCV = "1.0.0";
export const BRIDGE_PROFILE = "heavenkey-ucan-bridge-v1";
const HEADER = { alg: "EdDSA", typ: "JWT", ucv: UCV };
const CAN = { Read: "read", Write: "write", Unlock: "unlock" };
const ORDER = { read: 0, write: 1, unlock: 2 };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_PROOFS = 4;
const MAX_ACTIONS = 3;

function requireValue(condition, reason) { if (!condition) throw new Error(reason); }
function base58btc(raw) {
  const bytes = Buffer.from(raw), digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const byte of bytes) { if (byte !== 0) break; out += "1"; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
function base58decode(text) {
  requireValue(typeof text === "string" && text.length > 0 && [...text].every(char => B58.includes(char)), "invalid base58");
  const bytes = [0];
  for (const char of text) {
    let carry = B58.indexOf(char);
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const char of text) { if (char !== "1") break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
}
const b64u = value => Buffer.from(value).toString("base64url");
function b64uDecode(text) {
  requireValue(typeof text === "string" && /^[A-Za-z0-9_-]+$/.test(text), "invalid base64url");
  return Buffer.from(text, "base64url");
}
function jsonDecode(text) {
  let value;
  try { value = JSON.parse(b64uDecode(text).toString("utf8")); } catch { requireValue(false, "invalid json segment"); }
  requireValue(value && typeof value === "object" && !Array.isArray(value), "invalid json segment");
  return value;
}
function exactFields(value, fields, reason) {
  requireValue(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort()), reason);
}
export function didKey(key) {
  return "did:key:z" + base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.from(key)]));
}
export function decodeDidKey(did) {
  requireValue(typeof did === "string" && did.startsWith("did:key:z"), "invalid did:key");
  const raw = base58decode(did.slice("did:key:z".length));
  requireValue(raw.length === 34 && raw[0] === 0xed && raw[1] === 0x01, "invalid did:key codec");
  return raw.subarray(2);
}
export function linkCid(id) {
  return base58btc(Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.from(id)]));
}
function decodeCid(text) {
  const raw = base58decode(text);
  requireValue(raw.length === 34 && raw[0] === 0x12 && raw[1] === 0x20, "invalid proof cid");
  return raw.subarray(2);
}
const publicKey = key => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key)]), format: "der", type: "spki" });
const signingKey = seedByte => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seedByte)]), format: "der", type: "pkcs8" });
const signGrant = (body, key) => ({ body, signature: [...sign(null, grantMessage(body), key)] });

function tokenPayload(chain) {
  const leaf = chain.at(-1).body;
  return {
    att: leaf.actions.map(action => ({ can: CAN[action], with: leaf.resource })).sort((a, b) => ORDER[a.can] - ORDER[b.can]),
    aud: didKey(leaf.audience),
    exp: leaf.expires_at,
    iss: didKey(leaf.issuer),
    nbf: leaf.not_before,
    prf: chain.slice(0, -1).map(link => linkCid(Buffer.from(grantId(link), "hex"))),
  };
}
export function exportToken(chain, key) {
  const input = `${b64u(JSON.stringify(HEADER))}.${b64u(JSON.stringify(tokenPayload(chain)))}`;
  return `${input}.${b64u(sign(null, Buffer.from(input, "ascii"), key))}`;
}
export function verifyToken(token, { now, issuer = null, audience = null, resource = null, action = null } = {}) {
  requireValue(typeof token === "string" && Number.isSafeInteger(now) && now >= 0, "invalid input");
  const parts = token.split(".");
  requireValue(parts.length === 3 && parts.every(part => part.length > 0), "invalid token format");
  const header = jsonDecode(parts[0]);
  exactFields(header, ["alg", "typ", "ucv"], "invalid header fields");
  requireValue(header.alg === "EdDSA" && header.typ === "JWT" && header.ucv === UCV, "unsupported header");
  const payload = jsonDecode(parts[1]);
  exactFields(payload, ["att", "aud", "exp", "iss", "nbf", "prf"], "invalid payload fields");
  const issuerKey = decodeDidKey(payload.iss);
  decodeDidKey(payload.aud);
  requireValue(Number.isSafeInteger(payload.nbf) && payload.nbf >= 0 && Number.isSafeInteger(payload.exp) && payload.nbf < payload.exp, "invalid times");
  requireValue(Array.isArray(payload.att) && payload.att.length >= 1 && payload.att.length <= MAX_ACTIONS, "invalid att");
  const cans = new Set();
  for (const entry of payload.att) {
    exactFields(entry, ["can", "with"], "invalid att entry");
    requireValue(Object.values(CAN).includes(entry.can) && !cans.has(entry.can), "invalid capability");
    cans.add(entry.can);
    requireValue(typeof entry.with === "string" && /^[\x21-\x7e]{1,256}$/.test(entry.with), "invalid resource");
  }
  requireValue(Array.isArray(payload.prf) && payload.prf.length <= MAX_PROOFS, "invalid prf");
  for (const proof of payload.prf) decodeCid(proof);
  const signature = b64uDecode(parts[2]);
  requireValue(signature.length === 64, "invalid signature length");
  requireValue(verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), publicKey(issuerKey), signature), "invalid signature");
  requireValue(payload.nbf <= now && now < payload.exp, "inactive time");
  if (issuer !== null) requireValue(payload.iss === didKey(issuer), "untrusted issuer");
  if (audience !== null) requireValue(payload.aud === didKey(audience), "wrong audience");
  if (resource !== null || action !== null) {
    requireValue(typeof resource === "string" && Object.values(CAN).includes(action), "invalid invocation");
    requireValue(payload.att.some(entry => entry.with === resource && entry.can === action), "capability not attested");
  }
  return { allowed: true, iss: payload.iss, aud: payload.aud, att: payload.att, nbf: payload.nbf, exp: payload.exp, prf: payload.prf };
}

export function makeVectors() {
  const key = signingKey(9), issuer = [...createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)];
  const rogue = signingKey(5);
  const alias = n => Array(32).fill(n), time = 1700000000;
  const rootBody = { profile: GRANT_PROFILE, issuer, delegator: null, audience: alias(0xa0), resource: "urn:uac:lab:document", actions: ["Read", "Write"], not_before: time, expires_at: time + 3600, remaining_delegations: 2, parent: null, nonce: Array(16).fill(0x11) };
  const root = signGrant(rootBody, key);
  const childBody = { ...rootBody, delegator: rootBody.audience, audience: alias(0xb0), actions: ["Read"], not_before: time + 60, expires_at: time + 1800, remaining_delegations: 1, parent: [...Buffer.from(grantId(root), "hex")], nonce: Array(16).fill(0x22) };
  const child = signGrant(childBody, key);
  const grandBody = { ...childBody, delegator: childBody.audience, audience: alias(0xc0), not_before: time + 120, expires_at: time + 900, remaining_delegations: 0, parent: [...Buffer.from(grantId(child), "hex")], nonce: Array(16).fill(0x33) };
  const grandchild = signGrant(grandBody, key);
  const fixtures = [];
  function add(name, chain) {
    const token = exportToken(chain, key);
    const payload = tokenPayload(chain);
    fixtures.push({ name, chain, token, header: { ...HEADER }, payload });
  }
  add("root_only", [root]);
  add("two_links", [root, child]);
  add("three_links", [root, child, grandchild]);
  const tamper = (token, change) => {
    const parts = token.split(".");
    return change(parts).join(".");
  };
  const valid = fixtures.find(fixture => fixture.name === "three_links").token;
  const badSignature = tamper(valid, parts => { const sig = Buffer.from(parts[2], "base64url"); sig[0] ^= 1; parts[2] = sig.toString("base64url"); return parts; });
  const roguePayload = { ...tokenPayload([root, child, grandchild]), iss: didKey(createPublicKey(rogue).export({ format: "der", type: "spki" }).subarray(-32)) };
  const rogueInput = `${b64u(JSON.stringify(HEADER))}.${b64u(JSON.stringify(roguePayload))}`;
  const rogueToken = `${rogueInput}.${b64u(sign(null, Buffer.from(rogueInput, "ascii"), rogue))}`;
  const crafted = (mutate) => {
    const payload = structuredClone(fixtures.find(fixture => fixture.name === "three_links").payload);
    mutate(payload);
    const input = `${b64u(JSON.stringify(HEADER))}.${b64u(JSON.stringify(payload))}`;
    return `${input}.${b64u(sign(null, Buffer.from(input, "ascii"), key))}`;
  };
  const withHeader = (header) => {
    const payload = fixtures.find(fixture => fixture.name === "three_links").payload;
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    return `${input}.${b64u(sign(null, Buffer.from(input, "ascii"), key))}`;
  };
  const invalid_tokens = [
    { name: "bad_signature", token: badSignature },
    { name: "two_segments", token: valid.split(".").slice(0, 2).join(".") },
    { name: "four_segments", token: `${valid}.extra` },
    { name: "empty_segment", token: `.${valid.split(".").slice(1).join(".")}` },
    { name: "invalid_base64url", token: `${valid.slice(0, -1)}!` },
    { name: "header_not_json", token: `bm90LWpzb24.${valid.split(".").slice(1).join(".")}` },
    { name: "empty_payload", token: withHeader(HEADER).split(".")[0] + ".e30." + valid.split(".")[2] },
    { name: "wrong_alg", token: withHeader({ ...HEADER, alg: "ES256" }) },
    { name: "wrong_typ", token: withHeader({ ...HEADER, typ: "JWS" }) },
    { name: "wrong_ucv", token: withHeader({ ...HEADER, ucv: "0.9.0" }) },
    { name: "extra_header_field", token: withHeader({ ...HEADER, crit: [] }) },
    { name: "empty_att", token: crafted(payload => { payload.att = []; }) },
    { name: "unknown_capability", token: crafted(payload => { payload.att = [{ can: "teleport", with: "urn:uac:lab:document" }]; }) },
    { name: "duplicate_capabilities", token: crafted(payload => { payload.att = [{ can: "read", with: "urn:uac:lab:document" }, { can: "read", with: "urn:uac:lab:document" }]; }) },
    { name: "extra_att_field", token: crafted(payload => { payload.att = [{ can: "read", with: "urn:uac:lab:document", sub: "x" }]; }) },
    { name: "invalid_resource", token: crafted(payload => { payload.att = [{ can: "read", with: "urn:uac:lab:docu ment" }]; }) },
    { name: "nbf_ge_exp", token: crafted(payload => { payload.nbf = time + 900; payload.exp = time + 120; }) },
    { name: "fractional_exp", token: crafted(payload => { payload.exp = time + 900.5; }) },
    { name: "string_exp", token: crafted(payload => { payload.exp = String(time + 900); }) },
    { name: "bad_aud_did", token: crafted(payload => { payload.aud = "did:web:example.com"; }) },
    { name: "bad_iss_codec", token: crafted(payload => { payload.iss = "did:key:z" + base58btc(Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.alloc(32)])); }) },
    { name: "bad_prf", token: crafted(payload => { payload.prf = ["not-a-cid"]; }) },
    { name: "prf_overflow", token: crafted(payload => { payload.prf = Array(5).fill(payload.prf[0]); }) },
    { name: "extra_payload_field", token: crafted(payload => { payload.fct = []; }) },
    { name: "missing_payload_field", token: crafted(payload => { delete payload.nbf; }) },
    { name: "short_signature", token: valid.slice(0, -2) },
  ];
  const cases = [];
  const scenario = (name, fixture, allowed, changes = {}) => {
    cases.push({ name, fixture, now: time + 600, issuer, audience: alias(0xc0), resource: "urn:uac:lab:document", action: "read", allowed, ...changes });
  };
  scenario("valid_three_links", "three_links", true);
  scenario("valid_two_links", "two_links", true, { audience: alias(0xb0) });
  scenario("valid_root_only", "root_only", true, { audience: alias(0xa0) });
  scenario("valid_write_capability", "root_only", true, { audience: alias(0xa0), action: "write" });
  scenario("expired", "three_links", false, { now: time + 900 });
  scenario("not_yet_valid", "three_links", false, { now: time + 119 });
  scenario("wrong_audience", "three_links", false, { audience: alias(0xa0) });
  scenario("untrusted_issuer", "three_links", false, { issuer: [...createPublicKey(rogue).export({ format: "der", type: "spki" }).subarray(-32)] });
  scenario("wrong_resource", "three_links", false, { resource: "urn:uac:other" });
  scenario("capability_escalation", "three_links", false, { action: "write" });
  scenario("unknown_action_request", "three_links", false, { action: "teleport" });
  scenario("root_capability_absent_on_leaf", "root_only", false, { audience: alias(0xa0), action: "unlock" });
  return { version: 1, profile: BRIDGE_PROFILE, ucv: UCV, seed_byte: 9, trusted_issuer: issuer, fixtures, cases, invalid_tokens, crafted_tokens: { untrusted_issuer: rogueToken } };
}

export function checkVectors(vectors) {
  const fixtures = new Map(vectors.fixtures.map(fixture => [fixture.name, fixture])); let checks = 0;
  const key = signingKey(vectors.seed_byte);
  for (const fixture of fixtures.values()) {
    const parts = fixture.token.split(".");
    assert.equal(parts.length, 3, fixture.name);
    assert.deepEqual(JSON.parse(b64uDecode(parts[0]).toString("utf8")), fixture.header, `${fixture.name} header`);
    assert.deepEqual(JSON.parse(b64uDecode(parts[1]).toString("utf8")), fixture.payload, `${fixture.name} payload`);
    assert.equal(exportToken(fixture.chain, key), fixture.token, `${fixture.name} deterministic token`);
    const leaf = fixture.chain.at(-1).body;
    const leafKey = Buffer.from(vectors.trusted_issuer);
    assert.equal(fixture.payload.iss, didKey(leafKey), `${fixture.name} iss`);
    const holder = verifyToken(fixture.token, { now: leaf.not_before, issuer: vectors.trusted_issuer, audience: leaf.audience });
    assert.equal(holder.allowed, true, fixture.name);
    checks++;
  }
  for (const scenario of vectors.cases) {
    let allowed = false;
    try { allowed = verifyToken(fixtures.get(scenario.fixture).token, scenario).allowed; } catch {}
    assert.equal(allowed, scenario.allowed, scenario.name); checks++;
  }
  for (const invalid of vectors.invalid_tokens) {
    assert.throws(() => verifyToken(invalid.token, { now: 1700000600, issuer: vectors.trusted_issuer }), invalid.name); checks++;
  }
  const rogue = vectors.crafted_tokens.untrusted_issuer;
  assert.throws(() => verifyToken(rogue, { now: 1700000600, issuer: vectors.trusted_issuer }), "untrusted issuer token"); checks++;
  return { passed: checks, fixtures: fixtures.size, cases: vectors.cases.length, invalid_tokens: vectors.invalid_tokens.length, independent: "Node crypto Ed25519 with separate JWS/base58btc encoder" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command = "--check", path = "docs/vectors/ucan-bridge-v1.json"] = process.argv.slice(2);
  if (command === "--generate") { const vectors = makeVectors(); const report = checkVectors(vectors); await writeFile(path, JSON.stringify(vectors, null, 2) + "\n"); console.log(JSON.stringify(report)); }
  else { assert.equal(command, "--check"); console.log(JSON.stringify(checkVectors(JSON.parse(await readFile(path, "utf8"))))); }
}
