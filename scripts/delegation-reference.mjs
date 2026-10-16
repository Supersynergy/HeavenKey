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
  requireValue((body.delegator === null) === (body.parent === null), "inconsistent delegator/parent");
  requireValue(body.delegator === null || !equal(body.delegator, body.audience), "delegator equals audience");
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
  const link = (parentGrant, changes) => ({ ...parentGrant.body, delegator: parentGrant.body.audience, parent: [...Buffer.from(id(parentGrant), "hex")], ...changes });
  // Four-link chain: budgets 4->3->2->1 with boundary times.
  // a2.not_before == a1.not_before and a3.expires_at == a2.expires_at are allowed equality bounds.
  const a1 = signed({ ...rootBody, audience: alias(51), remaining_delegations: 4, nonce: Array(16).fill(51) }, key);
  const a2 = signed(link(a1, { audience: alias(52), expires_at: time + 3300, remaining_delegations: 3, nonce: Array(16).fill(52) }), key);
  const a3 = signed(link(a2, { audience: alias(53), not_before: time + 100, remaining_delegations: 2, nonce: Array(16).fill(53) }), key);
  const a4 = signed(link(a3, { audience: alias(54), not_before: time + 200, expires_at: time + 3000, remaining_delegations: 1, nonce: Array(16).fill(54) }), key);
  add("a1", a1); add("a2", a2); add("a3", a3); add("a4", a4);
  // Five-link chain: budget 4->0 cascade leaves a zero-budget leaf.
  const b1 = signed({ ...rootBody, audience: alias(61), remaining_delegations: 4, nonce: Array(16).fill(61) }, key);
  const b2 = signed(link(b1, { audience: alias(62), not_before: time + 50, expires_at: time + 3400, remaining_delegations: 3, nonce: Array(16).fill(62) }), key);
  const b3 = signed(link(b2, { audience: alias(63), not_before: time + 100, expires_at: time + 3200, remaining_delegations: 2, nonce: Array(16).fill(63) }), key);
  const b4 = signed(link(b3, { audience: alias(64), not_before: time + 150, expires_at: time + 3000, remaining_delegations: 1, nonce: Array(16).fill(64) }), key);
  const b5 = signed(link(b4, { audience: alias(65), not_before: time + 200, expires_at: time + 2800, remaining_delegations: 0, nonce: Array(16).fill(65) }), key);
  add("b1", b1); add("b2", b2); add("b3", b3); add("b4", b4); add("b5", b5);
  const exhaustedRoot = signed({ ...rootBody, audience: alias(80), remaining_delegations: 0, nonce: Array(16).fill(80) }, key);
  const exhaustedChild = signed(link(exhaustedRoot, { audience: alias(81), remaining_delegations: 0, nonce: Array(16).fill(81) }), key);
  add("exhausted_root", exhaustedRoot); add("exhausted_child", exhaustedChild);
  // Boundary fixtures.
  const equalExpiry = signed(link(root, { audience: alias(71), not_before: time + 10, expires_at: rootBody.expires_at, remaining_delegations: 2, nonce: Array(16).fill(71) }), key);
  const equalStart = signed(link(root, { audience: alias(72), not_before: rootBody.not_before, expires_at: time + 1800, remaining_delegations: 2, nonce: Array(16).fill(72) }), key);
  const budgetOneRoot = signed({ ...rootBody, audience: alias(90), remaining_delegations: 1, nonce: Array(16).fill(90) }, key);
  const budgetZeroLeaf = signed(link(budgetOneRoot, { audience: alias(91), remaining_delegations: 0, nonce: Array(16).fill(91) }), key);
  add("equal_expiry", equalExpiry); add("equal_start", equalStart); add("budget_one_root", budgetOneRoot); add("budget_zero_leaf", budgetZeroLeaf);
  add("second_root", signed({ ...rootBody, audience: alias(92), remaining_delegations: 2, nonce: Array(16).fill(92) }, key));

  // Invalid bodies: decode-level denials, signed with zeroed signatures like other invalid fixtures.
  add("same_link_delegator_audience", { body: link(root, { audience: alias(73), delegator: alias(73), remaining_delegations: 2, nonce: Array(16).fill(73) }), signature: Array(64).fill(0) });
  add("delegator_without_parent", { body: { ...child.body, parent: null }, signature: Array(64).fill(0) });
  add("parent_without_delegator", { body: { ...child.body, delegator: null }, signature: Array(64).fill(0) });
  add("a4_cycle", signed(link(a3, { audience: a2.body.audience, remaining_delegations: 1, nonce: Array(16).fill(95) }), key));
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
  const sixFive = signed(link(fixtures.find(f => f.name === "depth_4").grant, { audience: alias(85), expires_at: time + 3601, remaining_delegations: 0, nonce: Array(16).fill(85) }), key);
  const sixSix = signed(link(sixFive, { audience: alias(86), remaining_delegations: 0, nonce: Array(16).fill(86) }), key);
  const sixFiveExhausted = signed(link(fixtures.find(f => f.name === "depth_4").grant, { audience: alias(87), remaining_delegations: 0, nonce: Array(16).fill(87) }), key);
  const sixSixExhausted = signed(link(sixFiveExhausted, { audience: alias(88), remaining_delegations: 0, nonce: Array(16).fill(88) }), key);
  add("six_5", sixFive); add("six_6", sixSix); add("six_5_exhausted", sixFiveExhausted); add("six_6_exhausted", sixSixExhausted);
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
  scenario("valid_four_links", ["a1", "a2", "a3", "a4"], true, { audience: alias(54), now: time + 250 });
  scenario("valid_five_links", ["b1", "b2", "b3", "b4", "b5"], true, { audience: alias(65), now: time + 250 });
  scenario("six_links_broken_fifth", ["depth_1", "depth_2", "depth_3", "depth_4", "six_5", "six_6"], false, { audience: alias(86), expect_error: "Limits" });
  scenario("six_links_budget_exhausted", ["depth_1", "depth_2", "depth_3", "depth_4", "six_5_exhausted", "six_6_exhausted"], false, { audience: alias(88), expect_error: "Limits" });
  scenario("boundary_same_expiry", ["root", "equal_expiry"], true, { audience: alias(71), now: time + 10 });
  scenario("boundary_same_start", ["root", "equal_start"], true, { audience: alias(72), now: time });
  scenario("boundary_parent_minus_one_budget", ["budget_one_root", "budget_zero_leaf"], true, { audience: alias(91) });
  scenario("now_at_not_before", ["a1", "a2", "a3", "a4"], true, { audience: alias(54), now: time + 200 });
  scenario("now_at_expires_at", ["a1", "a2", "a3", "a4"], false, { audience: alias(54), now: time + 3000, expect_error: "Time" });
  scenario("budget_exhausted_child", ["exhausted_root", "exhausted_child"], false, { audience: alias(81), expect_error: "Escalation" });
  scenario("chain_delegator_audience", ["root", "same_link_delegator_audience"], false, { audience: alias(73), expect_error: "Encoding" });
  scenario("chain_delegator_without_parent", ["root", "delegator_without_parent"], false, { audience: alias(22), expect_error: "Encoding" });
  scenario("chain_parent_without_delegator", ["root", "parent_without_delegator"], false, { audience: alias(22), expect_error: "Encoding" });
  scenario("audience_cycle_two_hops", ["a1", "a2", "a3", "a4_cycle"], false, { audience: alias(52), expect_error: "Chain" });
  scenario("extra_root_link", ["root", "second_root"], false, { audience: alias(92), expect_error: "Chain" });
  scenario("skips_parent", ["root", "grandchild"], false, { expect_error: "Chain" });
  scenario("reversed_chain", ["grandchild", "child", "root"], false, { expect_error: "Chain" });
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
  const mutated = (name, change) => {
    const grant = structuredClone(root);
    change(grant);
    invalid_json.push({ name, json: JSON.stringify(grant) });
  };
  for (const field of ["issuer", "audience", "resource", "actions", "not_before", "expires_at", "remaining_delegations", "nonce", "delegator", "parent"]) mutated(`missing_${field}`, grant => { delete grant.body[field]; });
  mutated("resource_number", grant => { grant.body.resource = 42; });
  mutated("actions_string", grant => { grant.body.actions = "Read"; });
  mutated("issuer_string", grant => { grant.body.issuer = "0123456789abcdef"; });
  mutated("negative_not_before", grant => { grant.body.not_before = -1; });
  mutated("negative_budget", grant => { grant.body.remaining_delegations = -1; });
  mutated("float_expires_at", grant => { grant.body.expires_at = time + 3600.5; });
  mutated("float_budget", grant => { grant.body.remaining_delegations = 2.5; });
  mutated("null_audience", grant => { grant.body.audience = null; });
  mutated("null_issuer", grant => { grant.body.issuer = null; });
  mutated("nested_issuer", grant => { grant.body.issuer = [grant.body.issuer]; });
  mutated("nonce_string", grant => { grant.body.nonce = "0011223344556677"; });
  mutated("signature_string", grant => { grant.signature = "abcd"; });
  mutated("body_array", grant => { grant.body = [grant.body.issuer]; });
  invalid_json.push({ name: "envelope_array", json: JSON.stringify([root]) });
  const shuffled = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a.charCodeAt(0) + a.length - b.charCodeAt(0) - b.length) % 3 - 1));
  const equivalent_json = [
    { name: "reordered_root_fields", fixture: "root", json: JSON.stringify({ signature: root.signature, body: Object.fromEntries(Object.entries(root.body).reverse()) }, null, 3) },
    { name: "shuffled_child_fields", fixture: "child", json: JSON.stringify({ signature: child.signature, body: shuffled(child.body) }, null, 4) },
    { name: "reordered_actions", fixture: "wide_actions", json: JSON.stringify({ signature: fixtures.find(f => f.name === "wide_actions").grant.signature, body: { ...fixtures.find(f => f.name === "wide_actions").grant.body, actions: ["Read", "Write", "Unlock"] } }) },
    { name: "spaced_grandchild", fixture: "grandchild", json: JSON.stringify(grandchild, null, 1) + "\n" },
  ];
  return { version: 1, profile: PROFILE, seed_byte: 7, trusted_issuer: issuer, fixtures, cases, invalid_json, equivalent_json };
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
    try { allowed = verifyChain(scenario.chain.map(name => fixtures.get(name).grant), { ...scenario, issuer: scenario.issuer ?? vectors.trusted_issuer }).allowed; } catch {}
    assert.equal(allowed, scenario.allowed, scenario.name); checks++;
  }
  for (const fixture of vectors.invalid_json) { assert.throws(() => decodeSigned(fixture.json), fixture.name); checks++; }
  const root = fixtures.get("root").grant;
  assert.equal(id(decodeSigned(JSON.stringify({ signature: root.signature, body: Object.fromEntries(Object.entries(root.body).reverse()) }, null, 2))), id(root));checks++;
  for (const entry of vectors.equivalent_json ?? []) {
    const decoded = decodeSigned(entry.json), fixture = fixtures.get(entry.fixture);
    assert.equal(message(decoded.body).toString("hex"), fixture.message_hex, entry.name);
    assert.equal(id(decoded), fixture.id_hex, entry.name);
    checks++;
  }
  return { passed: checks, fixtures: fixtures.size, cases: vectors.cases.length, invalid_json: vectors.invalid_json.length, equivalent_json: (vectors.equivalent_json ?? []).length, independent: "Node crypto Ed25519/SHA256 with separate binary encoder" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command = "--check", path = "docs/vectors/delegation-v1.json"] = process.argv.slice(2);
  if (command === "--generate") { const vectors = makeVectors(); const report = checkVectors(vectors); await writeFile(path, JSON.stringify(vectors, null, 2) + "\n"); console.log(JSON.stringify(report)); }
  else { assert.equal(command, "--check"); console.log(JSON.stringify(checkVectors(JSON.parse(await readFile(path, "utf8"))))); }
}
