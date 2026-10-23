import { chromium, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import assert from "node:assert/strict";

const root = resolve(import.meta.dir, ".."), binary = resolve(process.env.HEAVENKEY_BINARY || "target/debug/uac-api");
const prefix: string[] = JSON.parse(process.env.HEAVENKEY_BINARY_PREFIX || "[]");
const reportPath = resolve(process.env.HEAVENKEY_BROKER_REPORT || "docs/evidence/password-broker/browser.json");
const ownerOrigin = "http://localhost:18268", fixtureOrigin = "http://localhost:18269";
const master = "Synthetic-broker-master-only!", username = "broker-synthetic-user", password = "Broker-synthetic-secret-only!", cookie = "Broker-synthetic-cookie-only!";
const chromePath = process.env.CHROME_PATH || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const temporary = await mkdtemp(join(tmpdir(), "heavenkey-broker-e2e-"));
const profileRoot = join(temporary, "browser-profiles");
await mkdir(profileRoot, { mode: 0o700 });
const sandboxDisabledForFixture = process.env.HEAVENKEY_BROKER_TEST_NO_SANDBOX === "1";
let brokerBrowser = chromePath;
if (sandboxDisabledForFixture) {
 if (process.platform !== "linux") throw Error("Test-only sandbox override is Linux-container-only");
 brokerBrowser = join(temporary, "fixture-chromium.sh");
 const quoted = "'" + chromePath.replaceAll("'", "'\\''") + "'";
 await writeFile(brokerBrowser, "#!/bin/sh\nexec " + quoted + " --no-sandbox \"$@\"\n", { mode: 0o700 });
}
const cases: { name: string; pass: boolean }[] = [], errors: string[] = [], ownerBodies: { path: string; body: string }[] = [], agentResponses: string[] = [];
const screenshots: { path: string; sha256: string }[] = [], fixtureTraffic: { path: string; method: string }[] = [];
let server: ChildProcess | undefined, serverOutput = "", browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let owner: Page, fixture: ReturnType<typeof Bun.serve> | undefined, ownerToken = "", lastApproval: { path: string; body: unknown } | undefined;
let loginPosts = 0, clipboardWrites = 0;
const sourceFiles = ["apps/api/src/password_manager/broker.rs", "apps/api/src/password_manager/browser_executor.rs", "apps/api/src/broker_agent.rs", "apps/web/src/passwords-broker.ts", "apps/web/src/passwords.ts", "apps/web/src/passwords.css", "scripts/password_broker_e2e.ts"];
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hashSources = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, digest(await readFile(join(root, path)))])));
const sourceHashes = await hashSources(), binaryHash = digest(await readFile(binary));
const check = (name: string) => { cases.push({ name, pass: true }); console.log("PASS " + name); };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(task: () => Promise<T>, accept: (result: T) => boolean, seconds = 20): Promise<T> {
 const end = Date.now() + seconds * 1000;
 while (true) { const value = await task(); if (accept(value)) return value; if (Date.now() >= end) throw Error("Bounded condition deadline"); await delay(200); }
}
const command = (args: string[]) => prefix.length ? [prefix[0], ...prefix.slice(1), binary, ...args] : [binary, ...args];
async function assertFree(port: number) {
 for (const host of ["127.0.0.1", "::1"]) await new Promise<void>((resolve, reject) => {
  const socket = createConnection({ host, port });
  socket.setTimeout(500);
  socket.once("connect", () => { socket.destroy(); reject(Error("Refusing to use an existing runtime on " + host + ":" + port)); });
  socket.once("error", error => { socket.destroy(); if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(); else reject(error); });
  socket.once("timeout", () => { socket.destroy(); reject(Error("Port ownership probe timed out")); });
 });
}
async function cli(action: string, body: unknown): Promise<any> {
 const child = Bun.spawn(command(["--broker-agent", "18268", action]), { cwd: root, stdin: new TextEncoder().encode(JSON.stringify(body)), stdout: "pipe", stderr: "pipe" });
 const timer = setTimeout(() => child.kill(), 22000);
 try { const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); assert.equal(code, 0, "Agent CLI failed: " + err); agentResponses.push(out); return JSON.parse(out); }
 finally { clearTimeout(timer); }
}
async function agent(path: string, token = "", body?: unknown, extra: Record<string, string> = {}, method = "POST") {
 const response = await fetch(ownerOrigin + (path.startsWith("/api/") ? path : "/api/password-broker/agent/" + path), { method, redirect: "manual", signal: AbortSignal.timeout(18000), headers: { "X-HeavenKey-Client": "password-agent", ...(token ? { "X-HeavenKey-Token": token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 const text = await response.text(); agentResponses.push(text);
 let value: any; try { value = JSON.parse(text); } catch { value = { text }; }
 return { status: response.status, value };
}
async function ownerApi(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
 const response = await fetch(ownerOrigin + path, { method, signal: AbortSignal.timeout(15000), headers: { Origin: ownerOrigin, "X-HeavenKey-Client": "password-manager", "X-HeavenKey-Token": ownerToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 return { status: response.status, value: await response.json() as any };
}
async function start() {
 await assertFree(18268);
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("UAC_") && !/^HEAVENKEY_(PUBLIC_ORIGIN|ORIGIN|SHARE_ORIGIN|PASSWORD_MANAGER|DOCUMENT)/.test(key)));
 env.HEAVENKEY_BROKER_BROWSER = brokerBrowser;
 const profileFolder = process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? "Z:" + profileRoot.replaceAll("/", "\\") : profileRoot;
 env.TMPDIR = profileFolder; env.TEMP = profileFolder; env.TMP = profileFolder;
 const folder = process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? "Z:" + temporary.replaceAll("/", "\\") : temporary;
 const args = command(["--password-manager", "--port", "18268", "--data-dir", folder]);
 server = spawn(args[0], args.slice(1), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
 serverOutput = ""; server.stdout?.on("data", d => serverOutput = (serverOutput + d).slice(-16000)); server.stderr?.on("data", d => serverOutput = (serverOutput + d).slice(-16000));
 await until(async () => { try { return (await fetch(ownerOrigin + "/health", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, Boolean, 15);
 const config = await fetch(ownerOrigin + "/api/password-vault/config", { headers: { Origin: ownerOrigin, "X-HeavenKey-Client": "password-manager" } }); assert.equal(config.status,200); ownerToken = (await config.json() as any).token;
 const status = await ownerApi("/api/password-broker"); assert.equal(status.status, 200, "Broker absent: rebuild binary/web before this integration run");
}
async function stop() {
 if (!server || server.exitCode !== null) return;
 const process = server;
 await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { process.kill("SIGKILL"); reject(Error("Rust shutdown deadline")); }, 5000); process.once("exit", () => { clearTimeout(timer); resolve(); }); process.kill("SIGTERM"); });
}
async function unlock(create = false) {
 await owner.locator("#unlock:not([disabled])").waitFor(); await owner.locator("#master").fill(master); if (create) await owner.locator("#master-confirm").fill(master); await owner.locator("#unlock").click(); await owner.locator("#workspace:not([hidden])[aria-busy=false]").waitFor();
 await until(async () => (await ownerApi("/api/password-broker")).value.unlocked, Boolean);
}
async function settings() { await owner.bringToFront(); if (await owner.locator("#settings-view").isHidden()) await owner.locator("#nav-settings").click(); await owner.locator("#broker-settings").waitFor(); }
async function entries() { if (await owner.locator("#settings-view").isVisible()) await owner.locator("#close-settings").click(); }
async function addLogin(title: string, url: string) {
 await entries(); await owner.locator("#new-entry").click(); await owner.locator("#entry-title").fill(title); await owner.locator("#entry-username").fill(username); await owner.locator("#entry-password").fill(password); await owner.locator("#entry-url").fill(url); await owner.locator("#save-entry").click(); await owner.locator("#editor").waitFor({ state: "hidden" });
 await until(async () => (await ownerApi("/api/password-broker")).value.unlocked, Boolean);
}
async function pair(label: string, useCli = false) {
 await settings(); const previous = owner.waitForResponse(r => r.url() === ownerOrigin + "/api/password-broker/pairing" && r.request().method() === "POST"); await owner.locator("#broker-pair").click(); const response = await (await previous).json();
 await owner.locator("#broker-pairing-code").filter({ hasText: response.code }).waitFor();
 const result = useCli ? await cli("connect", { code: response.code, label }) : (await agent("connect", "", { code: response.code, label })).value;
 assert.match(result.token, /^[\w-]{43}$/); return { ...result, code: response.code };
}
async function request(token: string, origin = fixtureOrigin) { const response = await agent("request", token, { origin, scope: "login_read" }); assert.equal(response.status, 200); return response.value.request_id as string; }
async function review(id: string) { await settings(); await owner.locator("#broker-review-" + id).click(); await owner.locator("#broker-approval-dialog").waitFor(); }
async function approve(id: string, title = "Synthetic broker account") {
 await review(id); const option = owner.locator("#broker-account option").filter({ hasText: title }); await owner.locator("#broker-account").selectOption(await option.getAttribute("value") || ""); await owner.locator("#broker-consent").check();
 const response = owner.waitForResponse(r => r.url().endsWith("/approve/" + id)); await owner.locator("#broker-approve").click(); const result = await response; assert.equal(result.status(), 200); lastApproval = { path: "/api/password-broker/approve/" + id, body: result.request().postDataJSON() }; await owner.locator("#broker-approval-dialog").waitFor({ state: "hidden" });
}
async function ready(token: string, id: string) {
 const result = await until(async () => (await agent("status", token, { request_id: id })).value, value => ["ready", "failed", "denied", "expired"].includes(value.status), 25);
 assert.equal(result.status, "ready", "Private Chrome login did not become ready"); assert(result.session_id); return result.session_id as string;
}
async function profiles() { return (await readdir(profileRoot)).filter(name => /^heavenkey-broker-[0-9a-f-]{36}$/.test(name)); }
async function cleanupOwnedBrowsers() {
 for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return;
  let found = false;
  for (const line of result.stdout.toString().split("\n")) {
   const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
   if (match && match[3].includes("--user-data-dir=" + profileRoot + "/heavenkey-broker-")) {
    found = true;
    try { process.kill(Number(match[1]), signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
   }
  }
  if (!found) return;
  await delay(500);
 }
}
async function screenshot(name: string) {
 const directory = resolve(process.env.HEAVENKEY_BROKER_SCREENSHOTS || join(resolve(reportPath, ".."), "screenshots")); await mkdir(directory, { recursive: true }); const path = join(directory, name + ".png"); await owner.screenshot({ path, fullPage: true, animations: "disabled" }); screenshots.push({ path, sha256: digest(await readFile(path)) });
}
async function contrast(scope: string) {
 const failures = await owner.locator(scope).evaluate(container => {
  const rgb = (v: string) => (v.match(/[\d.]+/g) || []).map(Number);
  const bg = (el: Element): number[] => { const color = rgb(getComputedStyle(el).backgroundColor); return color.length < 4 || color[3] > 0 ? color : el.parentElement ? bg(el.parentElement) : [255, 255, 255]; };
  const lum = (c: number[]) => c.slice(0, 3).reduce((sum, v, i) => { const n = v / 255; return sum + (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]; }, 0);
  const walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT), result: string[] = []; let samples = 0;
  while (walk.nextNode()) { const node = walk.currentNode, el = node.parentElement!; if (!node.textContent?.trim() || !el.getClientRects().length || el.closest("[hidden],:disabled")) continue; const a = lum(rgb(getComputedStyle(el).color)), b = lum(bg(el)); samples++; if ((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05) < 4.5) result.push(node.textContent.trim().slice(0,60)); }
  if (samples < 5) result.push("Missing contrast samples"); return result;
 }); assert.deepEqual(failures, []);
}
const initialProfiles = await profiles();
try {
 await mkdir(resolve(reportPath, ".."), { recursive: true });
 await assertFree(18269);
 fixture = Bun.serve({ port: 18269, hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url); fixtureTraffic.push({ path: url.pathname, method: req.method });
  if (url.pathname === "/login" && req.method === "POST") { const fields = new URLSearchParams(await req.text()); if (fields.get("username") !== username || fields.get("password") !== password) return new Response("Denied", { status: 403 }); loginPosts++; return new Response(null, { status: 302, headers: { location: "/account", "set-cookie": "broker_session=" + cookie + "; Path=/; HttpOnly; SameSite=Strict" } }); }
  const signed = req.headers.get("cookie")?.includes(cookie);
  if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:18269/evil" } });
  if (url.pathname === "/slow") { await delay(18000); return new Response("slow synthetic page", { headers: { "content-type": "text/html" } }); }
  if (url.pathname !== "/login" && signed) return new Response("<!doctype html><title>Synthetic Account</title><h1>Private synthetic account</h1><p>Cookie-backed session persists</p><p>" + username + " | " + password + " | " + Buffer.from(password).toString("base64") + " | " + encodeURIComponent(password) + "</p><input value='control-canary'><p hidden>hidden-canary</p><script>/* script-canary */</script><a href='/account'>Account page</a><a href='/redirect'>Redirect test</a><a href='https://example.invalid'>External</a>" + (url.pathname === "/frame" ? "<iframe src='http://127.0.0.1:18269/evil'></iframe>" : ""), { headers: { "content-type": "text/html" } });
  return new Response("<!doctype html><title>Synthetic Login</title><form method='post' action='/login'><label>User <input name='username' autocomplete='username'></label><label>Password <input name='password' type='password' autocomplete='current-password'></label><button>Login</button></form>", { headers: { "content-type": "text/html" } });
 } });
 await start(); assert((await ownerApi("/api/password-broker")).value.browser_available); check("real Rust broker endpoint and supported private Chrome available");
 browser = await chromium.launch({ headless: true, executablePath: chromePath });
 const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(12000);
 await context.exposeBinding("recordBrokerClipboard", () => { clipboardWrites++; });
 await context.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => (window as any).recordBrokerClipboard(), write: async () => (window as any).recordBrokerClipboard() } }); });
 await context.route("**/*", route => new URL(route.request().url()).origin === ownerOrigin ? route.continue() : route.abort("internetdisconnected"));
 context.on("request", req => { if (req.url().startsWith(ownerOrigin + "/api/")) ownerBodies.push({ path: new URL(req.url()).pathname, body: req.postData() || "" }); });
 owner = await context.newPage(); owner.on("pageerror", error => errors.push(error.message)); await owner.goto(ownerOrigin + "/passwords/"); await unlock(true);
 check("owner real encrypted vault creation unlocks broker only after local unlock");
 await addLogin("Synthetic broker account", fixtureOrigin + "/login"); await addLogin("Wrong origin account", "https://wrong.invalid/login"); await settings();
 check("synthetic logins saved through existing product UI with wrong-origin control");
 const client = await pair("Synthetic CLI agent", true); check("explicit owner pairing creates client through real native broker CLI");
 assert.notEqual((await agent("connect", "", { code: client.code, label: "Replay" })).status, 200); check("one-use pairing replay denied");
 const other = await pair("Other synthetic agent"); check("second client receives independent scoped capability");
 for (const path of ["/api/password-vault", "/api/password-vault/config", "/api/password-broker", "/api/password-broker/pairing"]) assert.notEqual((await agent(path, client.token, undefined, {}, path.endsWith("pairing") ? "POST" : "GET")).status, 200);
 check("agent token cannot access owner vault/config/status/pairing routes");
 assert.notEqual((await agent("request", "wrong", { origin: fixtureOrigin, scope: "login_read" })).status, 200); check("invalid client token denied");
 assert.notEqual((await agent("request", client.token, { origin: fixtureOrigin, scope: "login_read" }, { Origin: ownerOrigin })).status, 200); check("browser Origin on agent transport denied");
 assert.notEqual((await agent("request", client.token, { origin: fixtureOrigin, scope: "login_read", javascript: "document.cookie" })).status, 200); check("unknown agent request fields denied");
 for (const origin of [fixtureOrigin + "/login", "https://user:pass@example.invalid", "http://example.invalid", fixtureOrigin + "/", "file:///tmp"]) assert.notEqual((await agent("request", client.token, { origin, scope: "login_read" })).status, 200);
 check("noncanonical origins/credentials/remote insecure origin/file scheme denied");
 assert.notEqual((await agent("request", client.token, { origin: fixtureOrigin, scope: "write" })).status, 200); check("unsupported write scope denied");
 assert.notEqual((await agent("execute", client.token, { javascript: "document.cookie" })).status, 200); check("unknown raw browser operation has no agent route");
 const id = await request(client.token); assert.equal((await cli("status", { token: client.token, request_id: id })).status, "pending"); check("native CLI reports pending until explicit human approval");
 assert.notEqual((await agent("status", other.token, { request_id: id })).status, 200); check("cross-client request status denied");
 const preLoginPosts = loginPosts; await review(id);
 assert.equal(await owner.locator("#broker-account").inputValue(), ""); assert.equal(await owner.locator("#broker-account option").count(), 2); assert(await owner.locator("#broker-approve").isDisabled()); check("approval has no default selection and lists exact-origin login only");
 assert.match(await owner.locator("#broker-origin").innerText(), /http:\/\/localhost:18269/); assert.match(await owner.locator("#broker-client-label").innerText(), /nicht überprüft/); assert.match(await owner.locator("#broker-approval-dialog").innerText(), /5 Minuten/); assert.match(await owner.locator("#broker-settings").innerText(), /kein externes Audit/); check("honest client/trust/action/origin/session boundaries shown to owner");
 const option = await owner.locator("#broker-account option").nth(1).getAttribute("value"); await owner.locator("#broker-account").selectOption(option!); assert(await owner.locator("#broker-approve").isDisabled()); assert.equal(loginPosts, preLoginPosts); check("choosing account alone neither consents nor starts login");
 await owner.keyboard.press("Escape"); assert(await owner.locator("#broker-approval-dialog").isHidden()); assert.equal(await owner.evaluate(() => document.activeElement?.id), "broker-review-" + id); check("Escape cancels selection and restores requesting control focus");
 await review(id); assert.equal(await owner.locator("#broker-account").inputValue(), ""); assert(!(await owner.locator("#broker-consent").isChecked())); await owner.keyboard.press("Escape"); check("reopened approval retains no account choice or consent");
 await owner.locator("#theme-toggle").click(); assert.equal(await owner.locator("html").getAttribute("data-theme"), "dark"); await review(id); await contrast("#broker-approval-dialog"); await screenshot("approval-dark-desktop"); await owner.keyboard.press("Escape"); check("actual dark approval renders with text contrast at least 4.5:1");
 await owner.setViewportSize({ width: 390, height: 844 }); await review(id); assert(await owner.locator("#broker-approval-dialog").evaluate(el => el.getBoundingClientRect().width <= window.innerWidth)); assert(await owner.locator("#broker-approval-dialog").evaluate(el => el.scrollWidth <= el.clientWidth + 1)); await screenshot("approval-dark-mobile"); await owner.keyboard.press("Escape"); await owner.setViewportSize({ width: 1440, height: 1000 }); check("actual 390px mobile dialog fits viewport and has no horizontal overflow");
 await approve(id); const session = await ready(client.token, id); assert.equal(loginPosts, preLoginPosts + 1); check("explicit consent runs one real private Chromium pipe form login");
 assert(lastApproval); const sent = lastApproval.body as any; assert.deepEqual(Object.keys(sent).sort(), ["epoch", "revision", "sealed", "source_id"]); assert.deepEqual(Object.keys(sent.sealed).sort(), ["ciphertext", "iv", "key"]); assert(!JSON.stringify(sent).includes(password)); check("owner HTTP handoff transports authenticated ciphertext and metadata only");
 const read = await cli("read", { token: client.token, session_id: session, path: "/account" }); assert.deepEqual(Object.keys(read).sort(), ["links", "text", "title", "url"]); assert.match(read.text, /Cookie-backed session persists/); assert.equal(read.url, fixtureOrigin + "/account"); check("native CLI reads fixed projection from persisted private cookie session");
 assert(read.text.length <= 8000 && read.title.length <= 200 && read.links.length <= 20); for (const secret of [username,password,cookie,Buffer.from(password).toString("base64"),encodeURIComponent(password),"hidden-canary","control-canary","script-canary"]) assert(!JSON.stringify(read).includes(secret)); assert(read.links.every((link:any) => Object.keys(link).sort().join() === "label,path" && link.path.startsWith("/") && !link.path.startsWith("//"))); check("read bounds and redactions exclude secrets/cookies/controls/hidden/scripts/external links");
 assert.notEqual((await agent("read", other.token, { session_id: session, path: "/account" })).status, 200); check("cross-client session read denied");
 for (const path of ["//evil.invalid", "https://evil.invalid", "/account?x=1", "/account#x", "/a\\b", "/a\nb"]) assert.notEqual((await agent("read", client.token, { session_id: session, path })).status, 200); check("absolute URLs/protocol-relative/query/fragment/backslash/control read paths denied");
 assert.notEqual((await agent("read", client.token, { session_id: session, path: "/account", selector: "input" })).status, 200); check("arbitrary read selectors/unknown fields denied");
 assert.notEqual((await ownerApi(lastApproval.path, lastApproval.body)).status, 200); check("sealed approval replay denied after dispatch");
 await cli("close", { token: client.token, session_id: session }); check("native CLI closes owned session");
 assert.notEqual((await agent("read", client.token, { session_id: session, path: "/account" })).status, 200); check("closed session rejects replay reads");
 const frameId = await request(client.token); await approve(frameId); const frameSession = await ready(client.token, frameId);
 const framed = await agent("read", client.token, { session_id: frameSession, path: "/frame" }); assert([200, 403, 502].includes(framed.status)); assert(!fixtureTraffic.some(row => row.path === "/evil")); check("cross-origin iframe traffic blocked or session fails closed in actual private Chrome");
 await ownerApi("/api/password-broker/sessions/" + frameSession, undefined, "DELETE");
 const redirectId = await request(client.token); await approve(redirectId); const redirectSession = await ready(client.token, redirectId);
 const redirect = await agent("read", client.token, { session_id: redirectSession, path: "/redirect" }); assert.notEqual(redirect.status, 200); assert(!fixtureTraffic.some(row => row.path === "/evil")); check("cross-origin navigation fails closed without contacting destination");
 const live = await request(client.token); await approve(live); const liveSession = await ready(client.token, live); const slowRead = agent("read", client.token, { session_id: liveSession, path: "/slow" }); await delay(300); await entries(); await owner.locator("#lock").click(); assert.notEqual((await slowRead).status, 200); check("local vault lock cancels an in-progress private browser read");
 assert.notEqual((await agent("read", client.token, { session_id: liveSession, path: "/account" })).status, 200); assert.notEqual((await agent("request", client.token, { origin: fixtureOrigin, scope: "login_read" })).status, 200); check("locked broker rejects existing session and new requests");
 await unlock(); await settings(); const revokeId = await request(client.token); await approve(revokeId); const revokeSession = await ready(client.token, revokeId); await owner.locator("#broker-revoke-" + client.client_id).click(); assert.notEqual((await agent("read", client.token, { session_id: revokeSession, path: "/account" })).status, 200); check("owner UI client revoke invalidates its token and running browser");
 const saveId = await request(other.token); await approve(saveId); const saveSession = await ready(other.token, saveId); await addLogin("Revision bump", fixtureOrigin + "/login"); assert.notEqual((await agent("read", other.token, { session_id: saveSession, path: "/account" })).status, 200); check("real vault revision save cancels prior granted browser session");
 const pending = await request(other.token); await settings(); await owner.locator("#broker-deny-" + pending).click(); await until(async () => (await agent("status", other.token, { request_id: pending })).value.status, status => status === "denied"); check("owner UI denies pending request without login");
 const restartId = await request(other.token); await approve(restartId); const restartSession = await ready(other.token, restartId); await stop(); await start(); assert.notEqual((await agent("read", other.token, { session_id: restartSession, path: "/account" })).status, 200); assert.equal((await ownerApi("/api/password-broker")).value.clients.length, 0); check("process restart clears clients/grants/sessions and revokes prior capability");
 await until(profiles, found => found.every(name => initialProfiles.includes(name)), 15); check("all private Chromium profiles created by this run are removed");
 assert.equal(clipboardWrites, 0); check("owner flows perform zero clipboard writes");
 const allResponses = agentResponses.join("\n"); for (const secret of [username,password,cookie,master,Buffer.from(password).toString("base64"),encodeURIComponent(password)]) assert(!allResponses.includes(secret));
 for (const sent of ownerBodies) for (const secret of [username,password,master]) assert(!sent.body.includes(secret), "plaintext in owner API " + sent.path);
 check("all captured agent responses and owner API bodies contain no credential/cookie plaintext or encoded password");
 assert.deepEqual(errors, []); check("actual owner browser completes with no page errors");
 assert.deepEqual(await hashSources(), sourceHashes, "Source changed during acceptance; rerun against final source"); assert.equal(digest(await readFile(binary)),binaryHash,"Binary changed during acceptance"); check("source and binary hashes remain bound throughout integrated acceptance");
 await writeFile(reportPath, JSON.stringify({ pass:true, synthetic_only:true, real_rust:true, real_chromium:true, browser_sandbox:!sandboxDisabledForFixture, synthetic_fixture_sandbox_override:sandboxDisabledForFixture, native_hardware:false, binary, binary_sha256:binaryHash, source_sha256:sourceHashes, cases, errors, screenshots, login_posts:loginPosts, clipboard_writes:clipboardWrites, private_profiles_cleaned:true },null,2)+"\n"); console.log(JSON.stringify({pass:true,cases:cases.length,report:reportPath}));
} catch (error) {
 const message=String(error); errors.push(message); console.error(message); await mkdir(resolve(reportPath,".."),{recursive:true}); await writeFile(reportPath,JSON.stringify({pass:false,synthetic_only:true,binary,binary_sha256:binaryHash,source_sha256:sourceHashes,cases,errors,screenshots,owned_profiles_remaining:await profiles(),server_output:serverOutput},null,2)+"\n"); process.exitCode=1;
} finally { await browser?.close(); await stop(); fixture?.stop(true); await cleanupOwnedBrowsers(); await rm(temporary,{recursive:true,force:true}); }
