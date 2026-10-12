import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

export const PROFILE = "heavenkey-delegation-v1";
const fields = ["profile", "issuer", "delegator", "audience", "resource", "actions", "not_before", "expires_at", "remaining_delegations", "parent", "nonce"].sort();
const bits = { Read: 1, Write: 2, Unlock: 4 };
function requireValue(condition, reason) { if (!condition) throw new Error(reason); }
function bytes(value, length) {
  requireValue(Array.isArray(value) && value.length === length && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255), "invalid bytes");
  return Buffer.from(value);
}
const equal = (a, b) => Buffer.from(a).equals(Buffer.from(b));
function bodyValid(body) {
  requireValue(body && typeof body === "object" && !Array.isArray(body) && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(fields), "invalid fields");
  requireValue(body.profile === PROFILE, "unknown profile");
  bytes(body.issuer, 32); bytes(body.audience, 32); bytes(body.nonce, 16);
  if (body.delegator !== null) bytes(body.delegator, 32);
  if (body.parent !== null) bytes(body.parent, 32);
  requireValue(typeof body.resource === "string" && /^[\x21-\x7e]{1,256}$/.test(body.resource), "invalid resource");
  requireValue(Array.isArray(body.actions) && body.actions.length > 0 && new Set(body.actions).size === body.actions.length && body.actions.every(a => Object.hasOwn(bits, a)), "invalid actions");
  requireValue(Number.isSafeInteger(body.not_before) && body.not_before >= 0 && Number.isSafeInteger(body.expires_at) && body.not_before < body.expires_at, "invalid times");
  requireValue(Number.isInteger(body.remaining_delegations) && body.remaining_delegations >= 0 && body.remaining_delegations <= 4, "invalid budget");
}
export function message(body) {
  bodyValid(body);
  const resource = Buffer.from(body.resource, "ascii");
  const length = Buffer.alloc(2); length.writeUInt16BE(resource.length);
  const start = Buffer.alloc(8); start.writeBigUInt64BE(BigInt(body.not_before));
  const end = Buffer.alloc(8); end.writeBigUInt64BE(BigInt(body.expires_at));
  const optional = value => value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), bytes(value, 32)]);
  return Buffer.concat([Buffer.from("HEAVENKEY-DELEGATION-v1\0", "utf8"), bytes(body.issuer, 32), optional(body.delegator), bytes(body.audience, 32), length, resource, Buffer.from([body.actions.reduce((mask, a) => mask | bits[a], 0)]), start, end, Buffer.from([body.remaining_delegations]), optional(body.parent), bytes(body.nonce, 16)]);
}
function envelopeValid(grant) {
  requireValue(grant && JSON.stringify(Object.keys(grant).sort()) === JSON.stringify(["body", "signature"]), "invalid envelope");
  requireValue(Buffer.byteLength(JSON.stringify(grant)) <= 4096, "oversized grant");
  bodyValid(grant.body); bytes(grant.signature, 64);
}
export function id(grant) {
  envelopeValid(grant);
  return createHash("sha256").update(message(grant.body)).update(bytes(grant.signature, 64)).digest("hex");
}
export function decodeSigned(text) {
  requireValue(Buffer.byteLength(text) <= 4096, "oversized grant");
  const result = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g);
  const stack = [];
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n], frame = stack.at(-1);
    if (token === "{") stack.push({ object: true, keys: new Set(), key: true });
    else if (token === "[") stack.push({ object: false });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && frame?.object) frame.key = true;
    else if (frame?.object && frame.key && token.startsWith('"') && tokens[n + 1] === ":") {
      const key = JSON.parse(token); requireValue(!frame.keys.has(key), "duplicate field"); frame.keys.add(key); frame.key = false;
    }
  }
  envelopeValid(result); return result;
}
const publicKey = issuer => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes(issuer, 32)]), format: "der", type: "spki" });
export function verifyChain(chain, { issuer, audience, resource, action, now, revoked = [] }) {
  requireValue(Array.isArray(chain) && chain.length >= 1 && chain.length <= 5, "invalid chain depth");
  bytes(issuer, 32); bytes(audience, 32);
  requireValue(Number.isSafeInteger(now) && now >= 0 && Object.hasOwn(bits, action), "invalid invocation");
  const seen = new Set();
  let previous;
  for (const grant of chain) {
    envelopeValid(grant); const body = grant.body;
    requireValue(equal(body.issuer, issuer), "untrusted issuer");
    requireValue(verify(null, message(body), publicKey(issuer), bytes(grant.signature, 64)), "invalid signature");
    const grantId = id(grant); requireValue(!revoked.includes(grantId), "revoked ancestor");
    requireValue(body.not_before <= now && now < body.expires_at, "inactive time");
    const alias = Buffer.from(body.audience).toString("hex"); requireValue(!seen.has(alias), "audience cycle"); seen.add(alias);
    if (!previous) requireValue(body.parent === null && body.delegator === null, "missing root");
    else {
      const parent = previous.body;
      requireValue(body.parent !== null && equal(body.parent, Buffer.from(id(previous), "hex")), "wrong parent");
      requireValue(body.delegator !== null && equal(body.delegator, parent.audience) && !equal(body.delegator, body.audience), "wrong delegator");
      requireValue(body.resource === parent.resource && body.actions.every(a => parent.actions.includes(a)), "authority escalation");
      requireValue(body.not_before >= parent.not_before && body.expires_at <= parent.expires_at, "time escalation");
      requireValue(parent.remaining_delegations > 0 && body.remaining_delegations < parent.remaining_delegations, "budget escalation");
    }
    previous = grant;
  }
  requireValue(equal(previous.body.audience, audience) && previous.body.resource === resource && previous.body.actions.includes(action), "leaf authority mismatch");
  return { allowed: true, depth: chain.length, leaf_id: id(previous) };
}
function signingKey(seedByte) { return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seedByte)]), format: "der", type: "pkcs8" }); }
function signed(body, key) { return { body, signature: [...sign(null, message(body), key)] }; }
export function makeVectors() {
  const key = signingKey(7), issuer = [...createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)];
  const alias = n => Array(32).fill(n), time = 1700000000;
  const rootBody = { profile: PROFILE, issuer, delegator: null, audience: alias(11), resource: "urn:uac:lab:document", actions: ["Read"], not_before: time, expires_at: time + 3600, remaining_delegations: 3, parent: null, nonce: Array(16).fill(1) };
  const root = signed(rootBody, key);
  const child = signed({ ...rootBody, delegator: rootBody.audience, audience: alias(22), expires_at: time + 3000, remaining_delegations: 2, parent: [...Buffer.from(id(root), "hex")], nonce: Array(16).fill(2) }, key);
  const grandchild = signed({ ...child.body, delegator: child.body.audience, audience: alias(33), expires_at: time + 2400, remaining_delegations: 1, parent: [...Buffer.from(id(child), "hex")], nonce: Array(16).fill(3) }, key);
  const fixtures = [];
  function add(name, grant) {
    let message_hex = null, id_hex = null;
    try { message_hex = message(grant.body).toString("hex"); id_hex = id(grant); } catch {}
    fixtures.push({ name, grant, message_hex, id_hex });
  }
  add("root", root); add("child", child); add("grandchild", grandchild);
  const signature = structuredClone(child); signature.signature[0] ^= 1; add("bad_signature", signature);
  for (const [name, changes] of [
    ["wrong_parent", { parent: alias(99) }], ["wrong_resource", { resource: "urn:uac:other" }], ["escalated_actions", { actions: ["Read", "Write"] }],
    ["extended_expiry", { expires_at: time + 3601 }], ["earlier_start", { not_before: time - 1 }], ["same_budget", { remaining_delegations: 3 }], ["wrong_delegator", { delegator: alias(88) }],
  ]) add(name, signed({ ...child.body, ...changes }, key));
  add("cycle", signed({ ...grandchild.body, audience: root.body.audience }, key));
  add("wide_actions", signed({ ...rootBody, actions: ["Unlock", "Write", "Read"] }, key));
  add("safe_integer_boundary", signed({ ...rootBody, not_before: Number.MAX_SAFE_INTEGER - 1, expires_at: Number.MAX_SAFE_INTEGER }, key));
  add("max_resource", signed({ ...rootBody, resource: "r".repeat(256) }, key));
  for (const [name, changes] of [
    ["unknown_profile", { profile: "other-profile" }], ["duplicate_actions", { actions: ["Read", "Read"] }], ["empty_actions", { actions: [] }], ["unknown_action", { actions: ["Fly"] }],
    ["invalid_resource", { resource: "über" }], ["long_resource", { resource: "r".repeat(257) }], ["unsafe_time", { expires_at: Number.MAX_SAFE_INTEGER + 1 }], ["fractional_time", { not_before: time + 0.5 }],
    ["invalid_budget", { remaining_delegations: 5 }], ["invalid_issuer_length", { issuer: alias(7).slice(1) }], ["unknown_field", { extra: true }],
  ]) add(name, { body: { ...rootBody, ...changes }, signature: Array(64).fill(0) });
  const depthNames = [];
  let preceding;
  for (let depth = 0; depth < 6; depth++) {
    const body = { ...rootBody, audience: alias(40 + depth), remaining_delegations: Math.max(0, 4 - depth), nonce: Array(16).fill(40 + depth), parent: preceding ? [...Buffer.from(id(preceding), "hex")] : null, delegator: preceding ? preceding.body.audience : null };
    preceding = signed(body, key); const name = `depth_${depth + 1}`; add(name, preceding); depthNames.push(name);
  }
  const cases = [];
  function scenario(name, chain, allowed, changes = {}) { cases.push({ name, chain, audience: alias(33), resource: rootBody.resource, action: "Read", now: time + 100, revoked: [], allowed, ...changes }); }
  scenario("valid_three_links", ["root", "child", "grandchild"], true);
  for (const name of ["bad_signature", "wrong_parent", "wrong_resource", "escalated_actions", "extended_expiry", "earlier_start", "same_budget", "wrong_delegator"]) scenario(name, ["root", name], false, { audience: alias(22) });
  scenario("audience_cycle", ["root", "child", "cycle"], false, { audience: alias(11) });
  scenario("wrong_order", ["child", "root", "grandchild"], false); scenario("missing_root", ["child", "grandchild"], false);
  scenario("wrong_leaf_audience", ["root", "child", "grandchild"], false, { audience: alias(44) });
  scenario("wrong_requested_resource", ["root", "child", "grandchild"], false, { resource: "urn:uac:other" });
  scenario("wrong_requested_action", ["root", "child", "grandchild"], false, { action: "Write" });
  scenario("expired", ["root", "child", "grandchild"], false, { now: time + 3600 }); scenario("not_yet_valid", ["root", "child", "grandchild"], false, { now: time - 1 });
  scenario("root_revoked", ["root", "child", "grandchild"], false, { revoked: [id(root)] }); scenario("child_revoked", ["root", "child", "grandchild"], false, { revoked: [id(child)] });
  scenario("max_five_links", depthNames.slice(0, 5), true, { audience: alias(44) }); scenario("six_links", depthNames, false, { audience: alias(45) });
  scenario("all_action_bits", ["wide_actions"], true, { audience: alias(11), action: "Unlock" });
  scenario("safe_integer_boundary", ["safe_integer_boundary"], true, { audience: alias(11), now: Number.MAX_SAFE_INTEGER - 1 });
  scenario("max_resource", ["max_resource"], true, { audience: alias(11), resource: "r".repeat(256) });
  for (const fixture of fixtures.filter(f => f.message_hex === null)) scenario(fixture.name, [fixture.name], false, { audience: alias(11) });
  const rootJSON = JSON.stringify(root);
  const invalid_json = [
    { name: "duplicate_body_field", json: rootJSON.replace('"profile":', '"profile":"heavenkey-delegation-v1","profile":') },
    { name: "escaped_duplicate_field", json: rootJSON.replace('"profile":', '"pro\\u0066ile":"heavenkey-delegation-v1","profile":') },
    { name: "duplicate_envelope_field", json: rootJSON.replace('"signature":', '"signature":[],"signature":') },
    { name: "unknown_envelope_field", json: JSON.stringify({ ...root, extra: true }) },
    { name: "missing_body_field", json: rootJSON.replace('"profile":"heavenkey-delegation-v1",', "") },
    { name: "invalid_signature_length", json: JSON.stringify({ ...root, signature: root.signature.slice(1) }) },
    { name: "oversized_json", json: rootJSON + " ".repeat(4096) },
  ];
  return { version: 1, profile: PROFILE, seed_byte: 7, trusted_issuer: issuer, fixtures, cases, invalid_json };
}
export function checkVectors(vectors) {
  const fixtures = new Map(vectors.fixtures.map(f => [f.name, f])); let checks = 0;
  for (const fixture of fixtures.values()) {
    if (fixture.message_hex === null) assert.throws(() => message(fixture.grant.body), fixture.name);
    else { assert.equal(message(fixture.grant.body).toString("hex"), fixture.message_hex, fixture.name); assert.equal(id(fixture.grant), fixture.id_hex, fixture.name); assert.deepEqual(decodeSigned(JSON.stringify(fixture.grant)), fixture.grant); }
    checks++;
  }
  for (const scenario of vectors.cases) {
    let allowed = false;
    try { allowed = verifyChain(scenario.chain.map(name => fixtures.get(name).grant), { ...scenario, issuer: vectors.trusted_issuer }).allowed; } catch {}
    assert.equal(allowed, scenario.allowed, scenario.name); checks++;
  }
  for (const fixture of vectors.invalid_json) { assert.throws(() => decodeSigned(fixture.json), fixture.name); checks++; }
  const root = fixtures.get("root").grant;
  assert.equal(id(decodeSigned(JSON.stringify({ signature: root.signature, body: Object.fromEntries(Object.entries(root.body).reverse()) }, null, 2))), id(root));checks++;
  return { passed: checks, fixtures: fixtures.size, cases: vectors.cases.length, independent: "Node crypto Ed25519/SHA256 with separate binary encoder" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command = "--check", path = "docs/vectors/delegation-v1.json"] = process.argv.slice(2);
  if (command === "--generate") { const vectors = makeVectors(); const report = checkVectors(vectors); await writeFile(path, JSON.stringify(vectors, null, 2) + "\n"); console.log(JSON.stringify(report)); }
  else { assert.equal(command, "--check"); console.log(JSON.stringify(checkVectors(JSON.parse(await readFile(path, "utf8"))))); }
}
