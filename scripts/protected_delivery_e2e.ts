import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { protectedDraftHash, sealProtectedDelivery } from "../apps/web/src/passwords-protected-crypto";

const root = resolve(import.meta.dir, "..");
export const synthetic = { master: "Synthetic-Delivery-Master-Only!", username: "synthetic-delivery-user", password: "Synthetic-Delivery-Password-Only!", cookie: "Synthetic-Private-Cookie-Only", person: "Synthetic Delivery Person", email: "delivery-private@example.invalid", case: "SYNTHETIC-DELIVERY-42", response: "SYNTHETIC-RESPONSE-CANARY-7813", header: "SYNTHETIC-HEADER-CANARY-3297" };
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export async function until<T>(fn: () => Promise<T>, accept: (value: T) => boolean, seconds = 25): Promise<T> {
 const end = performance.now() + seconds * 1000;
 for (;;) { const value = await fn(); if (accept(value)) return value; if (performance.now() >= end) throw Error("Bounded acceptance condition timed out"); await delay(200); }
}
async function assertFree(port: number) {
 for (const host of ["127.0.0.1", "::1"]) await new Promise<void>((ok, fail) => {
  const socket = createConnection({ host, port }); socket.setTimeout(500);
  socket.once("connect", () => { socket.destroy(); fail(Error("Refusing occupied port " + host + ":" + port)); });
  socket.once("error", error => { socket.destroy(); (error as NodeJS.ErrnoException).code === "ECONNREFUSED" ? ok() : fail(error); });
  socket.once("timeout", () => { socket.destroy(); fail(Error("Port ownership probe timed out")); });
 });
}

export type Published = { workspace_id: string; source_id: string; epoch: number; revision: number; recipient_path?: string; references: { id: string; kind: string }[] };
export class ProtectedHarness {
 readonly binary = resolve(process.env.HEAVENKEY_BINARY || "target/debug/uac-api");
 readonly chrome = process.env.CHROME_PATH || "/Users/master/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
 readonly origin: string; readonly fixtureOrigin: string;
 temp = ""; profilesRoot = ""; ownerToken = ""; binaryHash = ""; sourceHashes: Record<string, string> = {};
 server?: ChildProcess; browser?: Browser; page!: Page; fixture?: ReturnType<typeof Bun.serve>;
 cases: string[] = []; errors: string[] = []; agentResponses: string[] = []; ownerBodies: { path: string; body: string }[] = [];
 screenshots: { path: string; sha256: string }[] = []; documents: { path: string; body: string; contentType: string; authenticated: boolean }[] = [];
 loginPosts = 0; redirectHits = 0; clipboardWrites = 0; heartbeatKeys = 0;
 releaseLogin: (() => void) | undefined; loginGate: Promise<void> = Promise.resolve();
 sourceFiles = ["apps/api/src/password_manager/broker.rs", "apps/api/src/password_manager/broker/protected.rs", "apps/api/src/password_manager/browser_executor.rs", "apps/web/src/passwords-protected.ts", "apps/web/src/passwords-protected-crypto.ts", "apps/web/src/passwords-protected.css", "apps/web/src/passwords-broker.ts", "apps/web/src/passwords.ts", "apps/web/src/passwords.css", "packages/protected/schema.ts", "scripts/protected_delivery_e2e.ts", "scripts/protected_expiry_e2e.ts"];
 constructor(readonly port: number, readonly fixturePort: number, readonly reportPath: string) { this.origin = "http://localhost:" + port; this.fixtureOrigin = "http://localhost:" + fixturePort; }
 check(name: string) { this.cases.push(name); console.log("PASS " + name); }
 async hashSources() { return Object.fromEntries(await Promise.all(this.sourceFiles.map(async path => [path, digest(await readFile(join(root, path)))]))); }
 async profiles() { return (await readdir(this.profilesRoot)).filter(name => /^heavenkey-broker-[0-9a-f-]{36}$/.test(name)); }
 privatePids() {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" }); assert.equal(out.exitCode, 0);
  return out.stdout.toString().split("\n").flatMap(line => { const m = /^\s*(\d+)\s+(.+)$/.exec(line); return m && m[2].includes("--user-data-dir=" + this.profilesRoot + "/heavenkey-broker-") ? [Number(m[1])] : []; });
 }
 async agent(action: string, token: string, body: unknown = {}, path?: string) {
  const response = await fetch(this.origin + (path || "/api/password-broker/agent/" + action), { method: "POST", redirect: "manual", signal: AbortSignal.timeout(18000), headers: { "Content-Type": "application/json", "X-HeavenKey-Client": "password-agent", ...(token ? { "X-HeavenKey-Token": token } : {}) }, body: JSON.stringify(body) });
  const text = await response.text(); this.agentResponses.push(text); let value: any; try { value = JSON.parse(text); } catch { value = {}; }
  return { status: response.status, value };
 }
 async owner(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(this.origin + path, { method, signal: AbortSignal.timeout(15000), headers: { Origin: this.origin, "X-HeavenKey-Client": "password-manager", "X-HeavenKey-Token": this.ownerToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value: any; try { value = await response.json(); } catch { value = {}; } return { status: response.status, value };
 }
 async start(blockLogin = false) {
  await assertFree(this.port); await assertFree(this.fixturePort); await mkdir(resolve(this.reportPath, ".."), { recursive: true });
  this.binaryHash = digest(await readFile(this.binary)); this.sourceHashes = await this.hashSources();
  this.temp = await mkdtemp(join(tmpdir(), "heavenkey-protected-acceptance-")); this.profilesRoot = join(this.temp, "profiles"); await mkdir(this.profilesRoot, { mode: 0o700 });
  if (blockLogin) this.loginGate = new Promise(resolve => { this.releaseLogin = resolve; });
  this.fixture = Bun.serve({ hostname: "127.0.0.1", port: this.fixturePort, fetch: async request => {
   const path = new URL(request.url).pathname;
   if (path === "/login" && request.method === "POST") {
    const fields = new URLSearchParams(await request.text()); assert.equal(fields.get("username"), synthetic.username); assert.equal(fields.get("password"), synthetic.password); this.loginPosts++;
    await this.loginGate;
    return new Response(null, { status: 302, headers: { location: "/account", "set-cookie": "delivery_session=" + synthetic.cookie + "; Path=/; HttpOnly; SameSite=Strict" } });
   }
   if (path === "/login") return new Response("<!doctype html><form method='post' action='/login'><label>User<input name='username' autocomplete='username'></label><label>Password<input name='password' type='password' autocomplete='current-password'></label><button>Login</button></form>", { headers: { "content-type": "text/html" } });
   if (path === "/redirect-destination") { this.redirectHits++; return new Response("must never be requested"); }
   const authenticated = request.headers.get("cookie")?.includes(synthetic.cookie) ?? false;
   if (path === "/account") return new Response("<!doctype html><h1>" + synthetic.response + "</h1><p>" + synthetic.password + "</p>", { status: authenticated ? 200 : 403, headers: { "content-type": "text/html", "x-private-result": synthetic.header } });
   if (request.method === "POST" && ["/messages/send", "/messages/redirect", "/messages/fail"].includes(path)) {
    this.documents.push({ path, body: await request.text(), contentType: request.headers.get("content-type") || "", authenticated });
    if (path === "/messages/redirect") return new Response(synthetic.response, { status: 307, headers: { location: "/redirect-destination", "x-private-result": synthetic.header } });
    return new Response(synthetic.response, { status: path === "/messages/fail" ? 503 : 202, headers: { "x-private-result": synthetic.header } });
   }
   return new Response("Not found", { status: 404 });
  } });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("UAC_") && !/^HEAVENKEY_(PUBLIC_ORIGIN|ORIGIN|SHARE_ORIGIN|PASSWORD_MANAGER|DOCUMENT)/.test(key)));
  this.server = spawn(this.binary, ["--password-manager", "--port", String(this.port), "--data-dir", this.temp], { cwd: root, env: { ...env, HEAVENKEY_BROKER_BROWSER: this.chrome, TMPDIR: this.profilesRoot, TEMP: this.profilesRoot, TMP: this.profilesRoot }, stdio: ["ignore", "ignore", "ignore"] });
  await until(async () => { try { return (await fetch(this.origin + "/health", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, Boolean, 20);
  const config = await fetch(this.origin + "/api/password-vault/config", { headers: { Origin: this.origin, "X-HeavenKey-Client": "password-manager" } }); assert.equal(config.status, 200); this.ownerToken = (await config.json() as any).token;
  this.browser = await chromium.launch({ headless: true, executablePath: this.chrome });
  const context = await this.browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(15000);
  await context.exposeBinding("recordAcceptanceClipboard", () => { this.clipboardWrites++; });
  await context.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => (window as any).recordAcceptanceClipboard(), write: async () => (window as any).recordAcceptanceClipboard() } }); });
  await context.route("**/*", route => new URL(route.request().url()).origin === this.origin ? route.continue() : route.abort("internetdisconnected"));
  context.on("request", req => { if (req.url().startsWith(this.origin + "/api/")) this.ownerBodies.push({ path: new URL(req.url()).pathname, body: req.postData() || "" }); });
  this.page = await context.newPage(); this.page.on("pageerror", error => this.errors.push(error.message)); await this.page.goto(this.origin + "/passwords/");
  await this.page.locator("#master").fill(synthetic.master); await this.page.locator("#master-confirm").fill(synthetic.master); await this.page.locator("#unlock").click(); await this.page.locator("#workspace:not([hidden])[aria-busy=false]").waitFor();
  await until(async () => (await this.owner("/api/password-broker")).value.unlocked, Boolean);
  await this.page.locator("#new-entry").click();
  for (const [field, value] of [["title", "Synthetic delivery account"], ["username", synthetic.username], ["password", synthetic.password], ["url", this.fixtureOrigin + "/login"]]) await this.page.locator("#entry-" + field).fill(value);
  await this.page.locator("#save-entry").click(); await this.page.locator("#editor").waitFor({ state: "hidden" }); await this.page.locator("#nav-settings").click();
  await this.page.locator("#protected-pair:not([disabled])").waitFor();
  const paired = this.page.waitForResponse(r => r.url().endsWith("/protected-pairing") && r.request().method() === "POST"); await this.page.locator("#protected-pair").click(); const code = (await (await paired).json()).code;
  const connected = await this.agent("connect", "", { code, label: "Synthetic protected acceptance agent" }); assert.equal(connected.status, 200); assert.equal(connected.value.protected, true);
  this.check("Real owner vault/login save and explicit protected pairing through product UI"); return connected.value as { client_id: string; token: string };
 }
 async compose(clientId: string, recipientPath?: string): Promise<Published> {
  await this.page.locator("#protected-new:not([disabled])").waitFor(); await this.page.locator("#protected-new").click();
  await until(async () => this.page.locator("#protected-client option[value='" + clientId + "']").count(), value => value === 1);
  assert.equal(await this.page.locator("#protected-client").inputValue(), ""); assert.equal(await this.page.locator("#protected-source").inputValue(), "");
  await this.page.locator("#protected-client").selectOption(clientId); const source = this.page.locator("#protected-source option").filter({ hasText: "Synthetic delivery account" }); await this.page.locator("#protected-source").selectOption((await source.getAttribute("value"))!);
  for (const [kind, value] of [["person", synthetic.person], ["email", synthetic.email], ["case", synthetic.case]]) await this.page.locator("#protected-" + kind).fill(value);
  if (recipientPath) await this.page.locator("#protected-recipient-path").fill(recipientPath);
  const published = this.page.waitForResponse(r => r.url().endsWith("/protected/workspaces") && r.request().method() === "POST"); await this.page.locator("#protected-publish").click(); const response = await published; assert.equal(response.status(), 200);
  const body = response.request().postDataJSON(); await this.page.locator("#protected-composer-dialog").waitFor({ state: "hidden" }); await this.page.locator("#protected-status").filter({ hasText: "Verschlüsselt gespeichert und" }).waitFor(); return body;
 }
 async approve(clientToken: string, workspace: Published) {
  const request = await this.agent("protected-login", clientToken, { workspace_id: workspace.workspace_id }); assert.equal(request.status, 200);
  const initial = await this.agent("status", clientToken, { request_id: request.value.request_id }); assert.deepEqual(initial.value, { status: "pending" });
  await this.page.locator("#broker-review-" + request.value.request_id).click(); await this.page.locator("#broker-approval-dialog").waitFor();
  assert.equal(await this.page.locator("#broker-account").inputValue(), workspace.source_id); assert(await this.page.locator("#broker-account").isDisabled()); assert(await this.page.locator("#broker-approve").isDisabled());
  await this.page.locator("#broker-consent").check(); const approved = this.page.waitForResponse(r => r.url().endsWith("/approve/" + request.value.request_id)); await this.page.locator("#broker-approve").click(); assert.equal((await approved).status(), 200); await this.page.locator("#broker-approval-dialog").waitFor({ state: "hidden" }); return request.value.request_id as string;
 }
 draft(workspace: Published) { return `Hallo [[HK:${workspace.references.find(r => r.kind === "person")!.id}]], zum Vorgang [[HK:${workspace.references.find(r => r.kind === "case")!.id}]] verwenden wir [[HK:${workspace.references.find(r => r.kind === "email")!.id}]].`; }
 async ownerWorkspace(id: string) { const result = await this.owner("/api/password-broker/protected/workspaces"); assert.equal(result.status, 200); return result.value.workspaces.find((row: any) => row.workspace_id === id); }
 async ready(workspace: Published) { return until(async () => { const row = await this.ownerWorkspace(workspace.workspace_id); assert(!["failed", "closed", "expired"].includes(row?.status), "Private browser failed before owner readiness: " + row?.status); return row; }, row => row?.status === "ready"); }
 async screenshot(name: string) { const path = join(resolve(this.reportPath, ".."), name + ".png"); await this.page.screenshot({ path, fullPage: true, animations: "disabled" }); this.screenshots.push({ path, sha256: digest(await readFile(path)) }); }
 noLeaks() {
  const all = this.agentResponses.join("\n");
  for (const value of [...Object.values(synthetic), Buffer.from(synthetic.password).toString("base64"), encodeURIComponent(synthetic.password)]) assert(!all.includes(value), "Private canary in agent response");
  for (const request of this.ownerBodies) for (const value of [synthetic.master, synthetic.username, synthetic.password, synthetic.person, synthetic.email, synthetic.case]) assert(!request.body.includes(value), "Private plaintext in owner API body " + request.path);
  assert.equal(this.clipboardWrites, 0); assert.deepEqual(this.errors, []);
 }
 async verifyBinding() { assert.deepEqual(await this.hashSources(), this.sourceHashes, "Source changed during acceptance"); assert.equal(digest(await readFile(this.binary)), this.binaryHash, "Binary changed during acceptance"); }
 async cleanup() {
  this.releaseLogin?.(); await this.browser?.close();
  if (this.server && this.server.exitCode === null && this.server.signalCode === null) {
   const child = this.server; await new Promise<void>(ok => { const hard = setTimeout(() => child.kill("SIGKILL"), 5000); child.once("exit", () => { clearTimeout(hard); ok(); }); child.kill("SIGTERM"); });
  }
  this.fixture?.stop(true);
  if (this.profilesRoot) for (const signal of ["SIGTERM", "SIGKILL"] as const) { const pids = this.privatePids(); if (!pids.length) break; for (const pid of pids) try { process.kill(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } await delay(500); }
  if (this.profilesRoot) assert.equal(this.privatePids().length, 0, "Owned private Chromium process remained after cleanup");
  if (this.temp) await rm(this.temp, { recursive: true, force: true });
 }
 async report(pass: boolean, details: Record<string, unknown>) {
  await mkdir(resolve(this.reportPath, ".."), { recursive: true });
  await writeFile(this.reportPath, JSON.stringify({ pass, synthetic_only: true, real_rust: true, real_chromium: true, binary: this.binary, binary_sha256: this.binaryHash, source_sha256: this.sourceHashes, cases: this.cases, errors: this.errors, screenshots: this.screenshots, clipboard_writes: this.clipboardWrites, ...details }, null, 2) + "\n");
 }
}

async function deliveryMain(h: ProtectedHarness) {
 const client = await h.start(true), workspace = await h.compose(client.client_id, "/messages/send"), request = await h.approve(client.token, workspace);
 await until(async () => { assert.notEqual((await h.ownerWorkspace(workspace.workspace_id)).status, "failed", "Private browser failed before fixture login"); return h.loginPosts; }, count => count === 1);
 assert.deepEqual((await h.agent("status", client.token, { request_id: request })).value, { status: "approved" });
 const draft = h.draft(workspace); assert.equal((await h.agent("protected-draft", client.token, { workspace_id: workspace.workspace_id, text: draft })).status, 200);
 assert.equal((await h.ownerWorkspace(workspace.workspace_id)).status, "running");
 h.check("Protected agent can draft after owner approval while real login is still blocked; no website result/session ID is exposed");
 h.releaseLogin!(); await h.ready(workspace); assert((await h.profiles()).length > 0); assert(h.privatePids().length > 0);
 const initialProjection = (await h.agent("protected-list", client.token)).value;
 const row = initialProjection.workspaces.find((value: any) => value.workspace_id === workspace.workspace_id); assert.equal(row.status, "drafted"); assert.deepEqual(Object.keys(row).sort(), ["expires_at", "prompt", "references", "status", "workspace_id"]);
 const state = (await h.owner("/api/password-broker")).value, draft_sha256 = await protectedDraftHash(draft), expected = `Hallo ${synthetic.person}, zum Vorgang ${synthetic.case} verwenden wir ${synthetic.email}.`;
 const path = "/api/password-broker/protected/workspaces/" + workspace.workspace_id + "/deliver";
 const valid = { epoch: state.epoch, revision: workspace.revision, draft_sha256, sealed: await sealProtectedDelivery(expected, h.fixtureOrigin + "/messages/send", state.public_key, workspace.workspace_id, state.epoch, workspace.revision, draft_sha256, () => {}) };
 const wrongRecipient = { ...valid, sealed: await sealProtectedDelivery(expected, h.fixtureOrigin + "/messages/other", state.public_key, workspace.workspace_id, state.epoch, workspace.revision, draft_sha256, () => {}) };
 const wrongCiphertext = { ...valid, sealed: { ...valid.sealed, ciphertext: (valid.sealed.ciphertext[0] === "A" ? "B" : "A") + valid.sealed.ciphertext.slice(1) } };
 for (const tampered of [wrongRecipient, wrongCiphertext, { ...valid, epoch: valid.epoch + 1 }, { ...valid, revision: valid.revision + 1 }, { ...valid, draft_sha256: "0".repeat(64) }]) assert.notEqual((await h.owner(path, tampered)).status, 200);
 assert.notEqual((await h.agent("", client.token, valid, path)).status, 200); assert.equal(h.documents.length, 0);
 h.check("Altered ciphertext, recipient, epoch, revision and draft digest plus agent-token delivery all fail before any website POST");
 await h.page.locator("#protected-preview-" + workspace.workspace_id).click(); await h.page.locator("#protected-send:not([hidden])").waitFor();
 assert.equal(await h.page.locator("#protected-recipient").innerText(), "Empfänger: " + h.fixtureOrigin + "/messages/send"); assert.equal(await h.page.locator("#protected-preview").innerText(), expected); assert.equal(h.documents.length, 0);
 await h.screenshot("delivery-owner-exact-preview"); const sent = h.page.waitForResponse(response => response.url().endsWith("/" + workspace.workspace_id + "/deliver") && response.request().method() === "POST"); await h.page.locator("#protected-send").click(); const delivered = await sent; assert.equal(delivered.status(), 200); const sealedBody = delivered.request().postDataJSON();
 assert.deepEqual(Object.keys(sealedBody).sort(), ["draft_sha256", "epoch", "revision", "sealed"]); assert.equal(sealedBody.draft_sha256, draft_sha256); assert(!JSON.stringify(sealedBody).includes(expected));
 await until(() => h.ownerWorkspace(workspace.workspace_id), value => value.delivery === "accepted");
 assert.deepEqual(h.documents, [{ path: "/messages/send", body: expected, contentType: "text/plain;charset=UTF-8", authenticated: true }]);
 assert.notEqual((await h.owner(path, sealedBody)).status, 200); assert.notEqual((await h.owner(path, valid)).status, 200); assert.equal(h.documents.length, 1);
 assert.deepEqual((await h.agent("status", client.token, { request_id: request })).value, { status: "approved" }); assert.deepEqual((await h.agent("protected-list", client.token)).value, initialProjection);
 await until(() => h.profiles(), values => values.length === 0); assert.equal(h.privatePids().length, 0);
 h.check("One explicit owner click delivers exactly the visible document with private cookie to the exact endpoint; accepted is server receipt, replay denied, agent projection unchanged and private browser/profile closed");
 for (const recipientPath of ["/messages/redirect", "/messages/fail"]) {
  const next = await h.compose(client.client_id, recipientPath), req = await h.approve(client.token, next); const nextDraft = h.draft(next);
  assert.equal((await h.agent("protected-draft", client.token, { workspace_id: next.workspace_id, text: nextDraft })).status, 200); await h.ready(next);
  const before = (await h.agent("protected-list", client.token)).value; await h.page.locator("#protected-preview-" + next.workspace_id).click(); await h.page.locator("#protected-send:not([hidden])").waitFor(); assert.equal(await h.page.locator("#protected-recipient").innerText(), "Empfänger: " + h.fixtureOrigin + recipientPath);
  await h.page.locator("#protected-send").click(); const outcome = await until(() => h.ownerWorkspace(next.workspace_id), value => ["failed", "unknown"].includes(value.delivery)); assert.notEqual(outcome.delivery, "accepted");
  assert.deepEqual((await h.agent("status", client.token, { request_id: req })).value, { status: "approved" }); assert.deepEqual((await h.agent("protected-list", client.token)).value, before);
  assert.equal(h.documents.filter(item => item.path === recipientPath).length, 1); assert.equal(h.redirectHits, 0); await until(() => h.profiles(), values => values.length === 0);
 }
 h.check("Real 307 and 503 delivery responses do not follow redirects or expose outcome/body/header to the protected agent; each closes its private profile");
 h.noLeaks(); await h.verifyBinding(); h.check("Captured agent responses/owner API bodies contain no private canaries, no clipboard writes/page errors, source and binary unchanged");
}

if (import.meta.main) {
 const report = resolve(process.env.HEAVENKEY_DELIVERY_REPORT || "docs/evidence/protected-delivery.json"), h = new ProtectedHarness(18348, 18349, report); let passed = false, cleaned = false;
 try { await deliveryMain(h); passed = true; } catch (error) { h.errors.push(error instanceof Error ? error.message : String(error)); console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }
 finally { try { await h.cleanup(); cleaned = true; } catch (error) { passed = false; h.errors.push(String(error)); process.exitCode = 1; } await h.report(passed, { private_profiles_cleaned: cleaned, document_posts: h.documents.length, redirect_destination_requests: h.redirectHits, accepted_semantics: "HTTP 2xx from exact destination server; no claim that a human read it", scope: "Real localhost fixture/private browser only; no universal covert-channel protection claim" }); console.log(JSON.stringify({ pass: passed, report })); }
}
