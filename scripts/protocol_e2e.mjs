/** Software-authenticator integration checks. This does not replace browser/hardware acceptance. */
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, randomBytes, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Encoder } from "cbor-x";
const cbor = new Encoder({ useRecords: false, mapsAsObjects: true });
const encode = x => Buffer.from(x).toString("base64url");
const hash = x => createHash("sha256").update(x).digest();
const directory = await mkdtemp(join(tmpdir(), "heavenkey-protocol-"));
const data = join(directory, "data"), protection = join(directory, "protection.key");
await writeFile(protection, randomBytes(32), { mode: 0o600 });
const origin = "http://localhost:18243", cases = []; let server;
async function test(name, fn) { await fn(); cases.push({ name, pass: true }); console.log(`PASS ${name}`); }
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGINT");
  const timer = setTimeout(() => server.kill("SIGKILL"), 3000);
  await exited; clearTimeout(timer);
}
async function start() {
  server = spawn(resolve(process.env.HEAVENKEY_BINARY || "target/debug/uac-api"), ["--port", "18243", "--data-dir", data], { env: { ...process.env, HEAVENKEY_KEY_FILE: protection, HEAVENKEY_ORIGIN: origin, HEAVENKEY_RP_ID: "localhost" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; server.stdout.on("data", x => log += x); server.stderr.on("data", x => log += x);
  for (let n = 0; n < 100; n++) {
    if (server.exitCode !== null) throw new Error(`Server failed: ${log}`);
    try { if ((await fetch(origin + "/health", { signal: AbortSignal.timeout(300) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  } throw new Error("Server startup timeout");
}
async function request(path, body, session, requestOrigin = origin) {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin, ...(session ? { Authorization: `Bearer ${session}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const value = await response.json(); return { status: response.status, value };
}
class Authenticator {
  constructor() { this.id = randomBytes(32); this.counter = 0; Object.assign(this, generateKeyPairSync("ec", { namedCurve: "prime256v1" })); }
  registration(options, clientOrigin = origin) {
    this.userHandle = options.user.id;
    const jwk = this.publicKey.export({ format: "jwk" });
    const cose = cbor.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const length = Buffer.alloc(2); length.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([hash(options.rp.id), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, this.id, cose]);
    return { id: encode(this.id), rawId: encode(this.id), type: "public-key", authenticatorAttachment: "platform", response: { clientDataJSON: encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: clientOrigin, crossOrigin: false })), attestationObject: encode(cbor.encode({ fmt: "none", attStmt: {}, authData })), transports: ["internal"] }, clientExtensionResults: {} };
  }
  assertion(options, clientOrigin = origin) {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([hash(options.rpId), Buffer.from([0x05]), counter]);
    const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: clientOrigin, crossOrigin: false }));
    return { id: encode(this.id), rawId: encode(this.id), type: "public-key", authenticatorAttachment: "platform", response: { clientDataJSON: encode(client), authenticatorData: encode(authData), signature: encode(sign("sha256", Buffer.concat([authData, hash(client)]), this.privateKey)), userHandle: this.userHandle }, clientExtensionResults: {} };
  }
}
async function register(name, authenticator, bootstrap_token) {
  const start = await request("/api/register/start", { name, bootstrap_token }); assert.equal(start.status, 200);
  const result = await request("/api/register/finish", { request_id: start.value.request_id, credential: authenticator.registration(start.value.options.publicKey) }); assert.equal(result.status, 200);
}
async function login(name, authenticator) {
  const start = await request("/api/auth/start", { name }); assert.equal(start.status, 200);
  const result = await request("/api/auth/finish", { request_id: start.value.request_id, credential: authenticator.assertion(start.value.options.publicKey) }); assert.equal(result.status, 200); return result.value;
}
async function approval(name, authenticator, session, management) {
  const start = await request("/api/auth/start", { name, management }, session); assert.equal(start.status, 200);
  const result = await request("/api/auth/finish", { request_id: start.value.request_id, credential: authenticator.assertion(start.value.options.publicKey), management }, session); assert.equal(result.status, 200); return result.value.approval_id;
}
let passed = false;
try {
  await start();
  const owner = new Authenticator(), guest = new Authenticator();
  await test("operator bootstrap provisions owner; guest enrolls without ownership", async () => {
    const bootstrap = (await readFile(join(data, "owner-bootstrap.txt"), "utf8")).trim();
    await register("owner", owner, bootstrap); await register("guest", guest, null);
    assert.equal((await request("/api/register/start", { name: "second-owner", bootstrap_token: bootstrap })).status, 403);
  });
  let o = await login("owner", owner), g = await login("guest", guest);
  await test("real Rust verifier rejects correctly signed assertions for a foreign origin", async () => {
    const start = await request("/api/auth/start", { name: "owner" });
    const result = await request("/api/auth/finish", { request_id: start.value.request_id, credential: owner.assertion(start.value.options.publicKey, "https://evil.example") }); assert.equal(result.status, 401);
  });
  await test("cross-origin writes fail before reaching application handlers", async () => { assert.equal((await request("/api/recovery/rotate", {}, o.session, "https://evil.example")).status, 403); });
  let delegation;
  await test("passkey-approved delegation enables session reading and checks account binding", async () => {
    const body = { guest_name: "guest", ttl_seconds: 300, remaining_delegations: 1 };
    const approval_id = await approval("owner", owner, o.session, { kind: "delegation_create", ...body });
    const created = await request("/api/delegations", { ...body, approval_id }, o.session); assert.equal(created.status, 200); delegation = created.value;
    assert.equal((await request("/api/read", { delegation_id: delegation.id }, g.session)).status, 200);
    assert.equal((await request("/api/read", { delegation_id: delegation.id }, o.session)).status, 403);
  });
  const agent = generateKeyPairSync("ed25519"); let task;
  const public_key = encode(agent.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const spec = { name: "Protocol test agent", public_key, resource: "crm.contacts", actions: ["Read", "Write"], ttl_seconds: 300, parent_id: null };
  await test("bearer-only agent issuance denied; approved issuance succeeds exactly once", async () => {
    assert.equal((await request("/api/agents", { spec }, o.session)).status, 403);
    const approval_id = await approval("owner", owner, o.session, { kind: "agent_create", spec });
    const result = await request("/api/agents", { spec, approval_id }, o.session); assert.equal(result.status, 200); task = result.value.id;
    assert.equal((await request("/api/agents", { spec, approval_id }, o.session)).status, 403);
  });
  let challenge;
  await test("agent proof changes only the scoped synthetic CRM contact", async () => {
    const inv = { id: task, resource: "crm.contacts", action: "Write", arguments: { id: "demo-contact", note: "Protocol integration checked" } };
    const start = await request("/api/agents/challenge", inv); assert.equal(start.status, 200);
    challenge = start.value;
    const result = await request("/api/agents/invoke", { challenge_id: challenge.challenge_id, signature: encode(sign(null, Buffer.from(challenge.message, "base64url"), agent.privateKey)) }); assert.equal(result.status, 200);
    assert.equal(result.value.data.contacts[0].note, "Protocol integration checked"); assert.equal(result.value.data.tenant, o.account_id);
    assert.equal((await request("/api/agents/invoke", { challenge_id: challenge.challenge_id, signature: encode(sign(null, Buffer.from(challenge.message, "base64url"), agent.privateKey)) })).status, 403);
    assert.equal((await request("/api/agents/challenge", { ...inv, arguments: { id: "other-contact", note: "denied" } })).status, 403);
  });
  await test("the shipped agent CLI validates the origin-bound challenge and executes a read", async () => {
    const path = join(directory, "agent.pem");
    await writeFile(path, agent.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const child = spawn(process.execPath, [resolve("scripts/agent.mjs"), "read", path, task, "--origin", origin], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", x => output += x);
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    assert.equal(code, 0); assert.equal(JSON.parse(output).allowed, true);
  });
  await test("revoking an ancestor blocks session reads immediately", async () => {
    const approval_id = await approval("owner", owner, o.session, { kind: "delegation_revoke", id: delegation.id });
    assert.equal((await request("/api/delegations/revoke", { id: delegation.id, approval_id }, o.session)).status, 200);
    assert.equal((await request("/api/read", { delegation_id: delegation.id }, g.session)).status, 403);
  });
  let recoveryCode;
  await test("recovery code rotates with fresh passkey consent; no code is returned in status", async () => {
    const approval_id = await approval("owner", owner, o.session, { kind: "recovery_rotate" });
    const result = await request("/api/recovery/rotate", { approval_id }, o.session); assert.equal(result.status, 200); recoveryCode = result.value.code;
    const status = await request("/api/recovery", undefined, o.session); assert.equal(status.value.enabled, true); assert.equal(JSON.stringify(status.value).includes(recoveryCode), false);
  });
  await test("failed recovery guesses are throttled without locking out a valid recovery code", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await request("/api/recovery/start", { name: "owner", code: "invalid-guess", label: "Denied" })).status, 403);
    assert.equal((await request("/api/recovery/start", { name: "owner", code: "invalid-guess", label: "Denied" })).status, 429);
  });
  const replacement = new Authenticator();
  await test("a valid recovery code enrolls a fresh passkey and invalidates old sessions and agents", async () => {
    const start = await request("/api/recovery/start", { name: "owner", code: recoveryCode, label: "Replacement" }); assert.equal(start.status, 200);
    const finish = await request("/api/recovery/finish", { request_id: start.value.request_id, credential: replacement.registration(start.value.options.publicKey) }); assert.equal(finish.status, 200);
    assert.equal((await request("/api/session", undefined, o.session)).status, 401);
    assert.equal((await request("/api/recovery/start", { name: "owner", code: recoveryCode, label: "Replay" })).status, 403);
    assert.equal((await request("/api/agents/challenge", { id: task, resource: "crm.contacts", action: "Read", arguments: {} })).status, 403);
    const changed = await login("owner", replacement); assert.equal(changed.account_id, o.account_id); o = changed;
    const startOld = await request("/api/auth/start", { name: "owner" });
    const result = await request("/api/auth/finish", { request_id: startOld.value.request_id, credential: owner.assertion(startOld.value.options.publicKey) }); assert.equal(result.status, 401);
  });
  await test("protected issuer survives restart and recovered identity remains stable", async () => {
    const issuer = (await request("/api/config")).value.issuer_public_key;
    const envelope = await readFile(join(data, "issuer.enc")); assert.equal(envelope[0], 123);
    await stop(); await start();
    assert.equal((await request("/api/config")).value.issuer_public_key, issuer);
    const current = await login("owner", replacement); assert.equal(current.account_id, o.account_id); o = current;
    assert.equal((await request("/api/read", { delegation_id: delegation.id }, (await login("guest", guest)).session)).status, 403);
  });
  await test("logout removes a preapproved sensitive operation", async () => {
    const approval_id = await approval("owner", replacement, o.session, { kind: "recovery_rotate" });
    assert.equal((await request("/api/logout", {}, o.session)).status, 200);
    assert.equal((await request("/api/recovery/rotate", { approval_id }, o.session)).status, 401);
  });
  passed = true;
} finally {
  await stop(); await mkdir("docs/evidence", { recursive: true });
  await writeFile("docs/evidence/protocol-e2e.json", JSON.stringify({ pass: passed, mode: "software P-256 authenticators and real Rust WebAuthn verification over HTTP; browser UI and hardware not covered", cases }, null, 2) + "\n");
  await rm(directory, { recursive: true, force: true });
}
