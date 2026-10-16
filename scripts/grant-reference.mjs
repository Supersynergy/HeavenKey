// Independent conformance check for the grant-v0 profile.
// Re-encodes every body into canonical serde_json bytes (struct field order,
// BTreeSet order, compact separators), verifies Ed25519 signatures and
// SHA-256 grant ids with Node crypto, and replays the documented deny
// semantics. `cargo test -p uac-verifier --test grant_v0` is the Rust side;
// this file must not import its implementation.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const GRANT_DOMAIN = Buffer.from("UAC-AUDIT-GRANT-v0\0", "utf8");
const INVOKE_DOMAIN = Buffer.from("UAC-AUDIT-INVOKE-v0\0", "utf8");
const MAX_CHAIN = 8, MAX_GRANT_BYTES = 4096, INVOKE_WINDOW = 30;
const ACTION_RANK = { Read: 0, Write: 1, Unlock: 2 };

function reject(reason) { const e = new Error(reason); e.name = reason; throw e; }
function requireValue(condition, reason) { if (!condition) reject(reason); }
function bytes(value, length) {
  requireValue(Array.isArray(value) && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255), "Encoding");
  if (length !== undefined) requireValue(value.length === length, "Encoding");
  return Buffer.from(value);
}
const equal = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// Canonical serde_json encoders (field order = Rust struct declaration order).
const emitArray = a => `[${a.join(",")}]`;
const emitString = s => JSON.stringify(s); // serde_json escapes control chars, " and \\ only; identical for our inputs
const emitOpt32 = v => v === null ? "null" : emitArray(v);
function sortedActions(actions) { return [...new Set(actions)].sort((a, b) => ACTION_RANK[a] - ACTION_RANK[b]); }

function grantValid(body) {
  requireValue(body && typeof body === "object" && !Array.isArray(body), "Encoding");
  requireValue(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["actions", "audience", "expires_at", "issuer", "not_before", "parent", "remaining_delegations", "resource"]), "Encoding");
  bytes(body.issuer, 32); bytes(body.audience, 32);
  requireValue(typeof body.resource === "string", "Encoding");
  requireValue(Array.isArray(body.actions) && body.actions.every(a => Object.hasOwn(ACTION_RANK, a)), "Encoding");
  requireValue(Number.isSafeInteger(body.not_before) && body.not_before >= 0 && Number.isSafeInteger(body.expires_at) && body.expires_at >= 0, "Encoding");
  requireValue(Number.isInteger(body.remaining_delegations) && body.remaining_delegations >= 0 && body.remaining_delegations <= 255, "Encoding");
  if (body.parent !== null) bytes(body.parent, 32);
}
function invocationValid(body) {
  requireValue(body && typeof body === "object" && !Array.isArray(body), "Encoding");
  requireValue(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["action", "arguments_hash", "grant", "issued_at", "nonce", "resource"]), "Encoding");
  bytes(body.grant, 32); bytes(body.arguments_hash, 32); bytes(body.nonce, 32);
  requireValue(typeof body.resource === "string" && Object.hasOwn(ACTION_RANK, body.action), "Encoding");
  requireValue(Number.isSafeInteger(body.issued_at) && body.issued_at >= 0, "Encoding");
}
function emitGrant(body) {
  return `{"issuer":${emitArray(body.issuer)},"audience":${emitArray(body.audience)},"resource":${emitString(body.resource)},"actions":[${sortedActions(body.actions).map(a => `"${a}"`).join(",")}],"not_before":${body.not_before},"expires_at":${body.expires_at},"remaining_delegations":${body.remaining_delegations},"parent":${emitOpt32(body.parent)}}`;
}
function emitInvocation(body) {
  return `{"grant":${emitArray(body.grant)},"resource":${emitString(body.resource)},"action":${emitString(body.action)},"arguments_hash":${emitArray(body.arguments_hash)},"nonce":${emitArray(body.nonce)},"issued_at":${body.issued_at}}`;
}
function emitSigned(signed, emitBody) {
  return `{"body":${emitBody(signed.body)},"signature":${emitArray(signed.signature)}}`;
}
function grantMessage(body) { grantValid(body); return Buffer.concat([GRANT_DOMAIN, Buffer.from(emitGrant(body), "utf8")]); }
function invocationMessage(body) { invocationValid(body); return Buffer.concat([INVOKE_DOMAIN, Buffer.from(emitInvocation(body), "utf8")]); }
function grantId(signed) {
  return createHash("sha256").update(GRANT_DOMAIN).update(Buffer.from(emitSigned(signed, emitGrant), "utf8")).digest("hex");
}
const publicKey = issuer => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes(issuer, 32)]), format: "der", type: "spki" });
function signatureOk(signed, emitBody, domain, publicBytes) {
  return verify(null, Buffer.concat([domain, Buffer.from(emitBody(signed.body), "utf8")]), publicKey(publicBytes), bytes(signed.signature));
}

export function decodeGrant(text) {
  requireValue(Buffer.byteLength(text) <= MAX_GRANT_BYTES, "Limits");
  let result;
  try { result = JSON.parse(text); } catch { reject("Encoding"); }
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || [];
  const stack = [];
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n], frame = stack.at(-1);
    if (token === "{") stack.push({ object: true, keys: new Set(), key: true });
    else if (token === "[") stack.push({ object: false });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && frame?.object) frame.key = true;
    else if (frame?.object && frame.key && token.startsWith('"') && tokens[n + 1] === ":") {
      const key = JSON.parse(token); requireValue(!frame.keys.has(key), "Encoding"); frame.keys.add(key); frame.key = false;
    }
  }
  requireValue(result && JSON.stringify(Object.keys(result).sort()) === JSON.stringify(["body", "signature"]), "Encoding");
  grantValid(result.body); bytes(result.signature);
  return result;
}

export function verifyChain(chain, invocation, context, state = { lastTime: 0, nonces: new Set() }) {
  const { root, resource, action, argumentsHash, nonce, now } = context;
  requireValue(chain.length >= 1 && chain.length <= MAX_CHAIN, "Limits");
  requireValue(now >= state.lastTime, "ClockRollback");
  state.lastTime = now;
  let previous = null;
  for (const signed of chain) {
    requireValue(Buffer.byteLength(emitSigned(signed, emitGrant), "utf8") <= MAX_GRANT_BYTES, "Limits");
    requireValue(signatureOk(signed, emitGrant, GRANT_DOMAIN, signed.body.issuer), "Signature");
    const body = signed.body;
    requireValue(body.actions.length > 0 && body.resource === resource, "Escalation");
    requireValue(!(body.not_before >= body.expires_at || now < body.not_before || now >= body.expires_at), "Time");
    requireValue(!context.revoked.includes(grantId(signed)), "Revoked");
    if (previous) {
      const parent = previous.body;
      requireValue(equal(body.issuer, parent.audience) && body.parent !== null && equal(body.parent, Buffer.from(grantId(previous), "hex")), "Chain");
      requireValue(sortedActions(body.actions).every(a => parent.actions.includes(a)) && body.not_before >= parent.not_before && body.expires_at <= parent.expires_at && parent.remaining_delegations > 0 && body.remaining_delegations < parent.remaining_delegations, "Escalation");
    } else {
      requireValue(equal(body.issuer, root) && body.parent === null, "UntrustedRoot");
    }
    previous = signed;
  }
  const leaf = previous;
  requireValue(signatureOk(invocation, emitInvocation, INVOKE_DOMAIN, leaf.body.audience), "Signature");
  const req = invocation.body;
  requireValue(equal(req.grant, Buffer.from(grantId(leaf), "hex")) && req.resource === resource && req.action === action && equal(req.arguments_hash, argumentsHash) && equal(req.nonce, nonce) && leaf.body.actions.includes(action), "Invocation");
  requireValue(!(now < req.issued_at || now - req.issued_at >= INVOKE_WINDOW), "Time");
  requireValue(!state.nonces.has(req.nonce.join(",")), "Replay");
  state.nonces.add(req.nonce.join(","));
  return true;
}

export function authorizeGrant(signed, { root, holder, resource, action, now, revoked }) {
  requireValue(Buffer.byteLength(emitSigned(signed, emitGrant), "utf8") <= MAX_GRANT_BYTES, "Limits");
  requireValue(signatureOk(signed, emitGrant, GRANT_DOMAIN, signed.body.issuer), "Signature");
  const body = signed.body;
  requireValue(equal(body.issuer, root) && body.parent === null, "UntrustedRoot");
  requireValue(!revoked, "Revoked");
  requireValue(equal(body.audience, holder) && body.resource === resource && body.actions.includes(action), "Invocation");
  requireValue(!(body.not_before >= body.expires_at || now < body.not_before || now >= body.expires_at), "Time");
  return true;
}

function outcome(fn) {
  try { fn(); return "ok"; } catch (e) { return e.name || "Encoding"; }
}

export function checkVectors(vectors) {
  const grants = new Map(vectors.fixtures.map(f => [f.name, f.grant]));
  const invocations = new Map(vectors.invocations.map(f => [f.name, f.invocation]));
  const root = Buffer.from(vectors.trusted_root, "hex");
  let checks = 0;
  for (const fixture of vectors.fixtures) {
    const m = grantMessage(fixture.grant.body);
    assert.equal(m.toString("hex"), fixture.message_hex, `message ${fixture.name}`);
    assert.equal(grantId(fixture.grant), fixture.id_hex, `id ${fixture.name}`);
    if (fixture.signature_valid !== false) assert.ok(signatureOk(fixture.grant, emitGrant, GRANT_DOMAIN, fixture.grant.body.issuer), `signature ${fixture.name}`);
    else assert.ok(!signatureOk(fixture.grant, emitGrant, GRANT_DOMAIN, fixture.grant.body.issuer), `signature ${fixture.name}`);
    checks++;
  }
  for (const fixture of vectors.invocations) {
    assert.equal(invocationMessage(fixture.invocation.body).toString("hex"), fixture.message_hex, `message ${fixture.name}`);
    checks++;
  }
  for (const kase of vectors.cases) {
    const state = { lastTime: 0, nonces: new Set() };
    const chain = kase.chain.map(name => grants.get(name));
    const invocation = invocations.get(kase.invocation);
    for (const step of kase.steps) {
      const context = {
        root, resource: kase.context.resource, action: kase.context.action,
        argumentsHash: Buffer.from(kase.context.arguments_hash, "hex"), nonce: Buffer.from(kase.context.nonce, "hex"),
        revoked: kase.revoked || [], now: step.now,
      };
      assert.equal(outcome(() => verifyChain(chain, invocation, context, state)), step.expect, `${kase.name} @${step.now}`);
      checks++;
    }
  }
  for (const kase of vectors.grant_cases) {
    const context = {
      root, holder: Buffer.from(kase.holder, "hex"), resource: kase.resource,
      action: kase.action, now: kase.now, revoked: kase.revoked || false,
    };
    assert.equal(outcome(() => authorizeGrant(grants.get(kase.grant), context)), kase.expect, kase.name);
    checks++;
  }
  for (const entry of vectors.invalid_json) { assert.throws(() => decodeGrant(entry.json), entry.name); checks++; }
  for (const entry of vectors.equivalent_json) {
    const decoded = decodeGrant(entry.json);
    assert.equal(grantId(decoded), entry.expect_id, entry.name); checks++;
  }
  return { passed: checks, fixtures: vectors.fixtures.length, cases: vectors.cases.length, independent: "Node crypto Ed25519/SHA256 with separate serde_json encoder" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command = "--check", path = "docs/vectors/grant-v0.json"] = process.argv.slice(2);
  assert.equal(command, "--check");
  console.log(JSON.stringify(checkVectors(JSON.parse(await readFile(path, "utf8")))));
}
