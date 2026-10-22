import { chromium, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import assert from "node:assert/strict";

const root = resolve(import.meta.dir, ".."), binary = resolve(process.env.HEAVENKEY_BINARY || "target/debug/uac-api");
const prefix: string[] = JSON.parse(process.env.HEAVENKEY_BINARY_PREFIX || "[]");
const reportPath = resolve(process.env.HEAVENKEY_PROTECTED_REPORT || "docs/evidence/protected-flow/browser.json");
const ownerOrigin = "http://localhost:18368", fixtureOrigin = "http://localhost:18369";
const person = "Synthetic Protected Person", email = "protected-only@example.invalid", privateCase = "SYNTHETIC-CASE-7319";
const master = "Synthetic-broker-master-only!", username = "broker-synthetic-user", password = "Broker-synthetic-secret-only!", cookie = "Broker-synthetic-cookie-only!";
const chromePath = process.env.CHROME_PATH || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const temporary = await mkdtemp(join(tmpdir(), "heavenkey-protected-e2e-"));
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
const sourceFiles = ["apps/api/src/password_manager/broker/protected.rs", "apps/web/src/passwords-protected.ts", "packages/protected/schema.ts", "apps/api/src/password_manager/broker.rs", "apps/api/src/password_manager/browser_executor.rs", "apps/api/src/broker_agent.rs", "apps/web/src/passwords-broker.ts", "apps/web/src/passwords.ts", "apps/web/src/passwords.css", "scripts/protected_flow_e2e.ts"];
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
 const child = Bun.spawn(command(["--broker-agent", "18368", action]), { cwd: root, stdin: new TextEncoder().encode(JSON.stringify(body)), stdout: "pipe", stderr: "pipe" });
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
 await assertFree(18368);
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("UAC_") && !/^HEAVENKEY_(PUBLIC_ORIGIN|ORIGIN|SHARE_ORIGIN|PASSWORD_MANAGER|DOCUMENT)/.test(key)));
 env.HEAVENKEY_BROKER_BROWSER = brokerBrowser;
 const profileFolder = process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? "Z:" + profileRoot.replaceAll("/", "\\") : profileRoot;
 env.TMPDIR = profileFolder; env.TEMP = profileFolder; env.TMP = profileFolder;
 const folder = process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? "Z:" + temporary.replaceAll("/", "\\") : temporary;
 const args = command(["--password-manager", "--port", "18368", "--data-dir", folder]);
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
async function review(id: string) { await settings(); await owner.locator("#broker-review-" + id).click(); await owner.locator("#broker-approval-dialog").waitFor(); }
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
type PlannedCase = { scenario: string; expected: string; enforcement: string };
const plannedPath = join(root, "docs/protected-acceptance-plan.json");
const planned: { cases: PlannedCase[] } = JSON.parse(await readFile(plannedPath, "utf8"));
const mapped = new Map<number, { id: number; scenario: string; expected: string; status: "passed" | "partial" | "delegated" | "residual_risk"; evidence: string }>();
function mapCase(id: number, status: "passed" | "partial" | "delegated" | "residual_risk", evidence: string) {
 assert(planned.cases[id - 1]); mapped.set(id, { id, scenario: planned.cases[id - 1].scenario, expected: planned.cases[id - 1].expected, status, evidence });
}
const privateCanaries = [person, email, privateCase, username, password, cookie, master, Buffer.from(password).toString("base64"), encodeURIComponent(password)];
function noCanaries(value: unknown) { const text = typeof value === "string" ? value : JSON.stringify(value); for (const canary of privateCanaries) assert(!text.includes(canary), "Private canary crossed tested boundary"); }
async function deniedRequest(action: string, token: string, body: unknown) { const out = await agent(action, token, body); assert.notEqual(out.status, 200, "Unexpected allowed action " + action); noCanaries(out); return out; }
async function protectedPair(label: string, ui = false) {
 let code: string;
 if (ui) { await settings(); const response = owner.waitForResponse(r => r.url().endsWith("/protected-pairing") && r.request().method() === "POST"); await owner.locator("#protected-pair").click(); code = (await (await response).json()).code; await owner.locator("#protected-pairing-code").filter({ hasText: code }).waitFor(); }
 else { const p = await ownerApi("/api/password-broker/protected-pairing", {}); assert.equal(p.status, 200); code = p.value.code; }
 const result = await cli("connect", { code, label }); assert.equal(result.protected, true); return result;
}
async function compose(clientId: string, sourceId?: string) {
 await settings(); await until(async () => owner.locator("#protected-new").isEnabled(), Boolean);
 await owner.locator("#protected-new").click(); await owner.locator("#protected-composer-dialog").waitFor();
 await owner.locator("#protected-client").selectOption(clientId);
 if (sourceId) await owner.locator("#protected-source").selectOption(sourceId);
 else { const option = owner.locator("#protected-source option").filter({ hasText: "Synthetic broker account" }); sourceId = (await option.getAttribute("value"))!; await owner.locator("#protected-source").selectOption(sourceId); }
 await owner.locator("#protected-person").fill(person); await owner.locator("#protected-email").fill(email); await owner.locator("#protected-case").fill(privateCase);
 // The only page owned by the agent's future website is the local fixture; it never receives these inputs.
 const response = owner.waitForResponse(r => r.url().endsWith("/protected/workspaces") && r.request().method() === "POST", { timeout: 20000 });
 await owner.locator("#protected-publish").click(); const received = await response; assert.equal(received.status(), 200);
 const body = received.request().postDataJSON(); noCanaries(body);
 assert.deepEqual(Object.keys(body).sort(), ["client_id","epoch","origin","references","revision","source_id","template","workspace_id"]);
 assert.deepEqual(body.references.map((ref: any) => Object.keys(ref).sort().join()), ["id,kind","id,kind","id,kind"]);
 await owner.locator("#protected-composer-dialog").waitFor({ state: "hidden" });
 await owner.locator("#protected-status").filter({ hasText: "Verschlüsselt gespeichert und" }).waitFor();
 for (const kind of ["person","email","case"]) assert.equal(await owner.locator("#protected-" + kind).inputValue(), "");
 return body;
}
async function protectedApprove(id: string, source: string) {
 await review(id); assert.equal(await owner.locator("#broker-account").inputValue(), source); assert(await owner.locator("#broker-account").isDisabled());
 assert.equal(await owner.locator("#broker-account option").count(), 2); assert.match(await owner.locator("#broker-approval-heading").innerText(), /Geschützte/);
 assert.match(await owner.locator("#broker-approval-dialog").innerText(), /ohne Seitenlesen/); assert(await owner.locator("#broker-approve").isDisabled());
 await owner.locator("#broker-consent").check(); const response = owner.waitForResponse(r => r.url().endsWith("/approve/" + id)); await owner.locator("#broker-approve").click(); const received = await response;
 assert.equal(received.status(), 200); lastApproval = { path: "/api/password-broker/approve/" + id, body: received.request().postDataJSON() }; noCanaries(lastApproval.body);
 await owner.locator("#broker-approval-dialog").waitFor({ state: "hidden" });
}
async function localMain() {
 await mkdir(resolve(reportPath, ".."), { recursive: true });
 const binaryTime = (await stat(binary)).mtimeMs;
 for (const path of sourceFiles.filter(path => path !== "scripts/protected_flow_e2e.ts")) assert(binaryTime >= (await stat(join(root,path))).mtimeMs, "Binary predates source; root must rebuild before protected acceptance: " + path);
 await assertFree(18369);
 const freshLogins: boolean[] = [];
 fixture = Bun.serve({ port: 18369, hostname: "localhost", async fetch(req) {
  const url = new URL(req.url); fixtureTraffic.push({ path: url.pathname, method: req.method });
  if (url.pathname === "/evil") throw Error("Cross-origin private browser request escaped policy");
  if (url.pathname === "/redirect-login") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:18369/evil" } });
  if (url.pathname === "/login" && req.method === "GET") freshLogins.push(!req.headers.get("cookie")?.includes(cookie));
  if (url.pathname === "/login" && req.method === "POST") { const fields = new URLSearchParams(await req.text()); assert.equal(fields.get("username"), username); assert.equal(fields.get("password"),password); loginPosts++; return new Response(null, { status: 302, headers: { location: "/account", "set-cookie": "protected_session=" + cookie + "; Path=/; HttpOnly; SameSite=Strict", authorization: "Bearer " + password } }); }
  if (url.pathname === "/account" && req.headers.get("cookie")?.includes(cookie)) return new Response(`<!doctype html><title>${person}</title><h1 aria-label="${email}">${privateCase}</h1><p>${password} ${Buffer.from(password).toString("base64")} ${encodeURIComponent(password)}</p><img alt="${username}" src="data:image/svg+xml;base64,${Buffer.from(`<svg xmlns='http://www.w3.org/2000/svg'><text>${password}</text></svg>`).toString("base64")}"><a download="${person}.txt" href="/binary">private</a>`, { headers: { "content-type":"text/html", "x-private-meta":email, authorization:"Bearer "+password } });
  if (url.pathname === "/gzip") return new Response(Bun.gzipSync(new TextEncoder().encode(password.repeat(10000))), { headers: { "content-encoding":"gzip", "content-type":"text/plain" } });
  if (url.pathname === "/binary") return new Response(new TextEncoder().encode(password.repeat(10000)), { headers: { "content-type":"application/octet-stream" } });
  return new Response("<!doctype html><title>Synthetic Login</title><form method='post' action='/login'><label>User <input name='username' autocomplete='username'></label><label>Password <input name='password' type='password' autocomplete='current-password'></label><button>Login</button></form>", { headers: { "content-type":"text/html" } });
 } });
 await start(); assert((await ownerApi("/api/password-broker")).value.browser_available);
 browser = await chromium.launch({ headless:true, executablePath:chromePath });
 const context = await browser.newContext({ viewport:{ width:1440,height:1000 } }); context.setDefaultTimeout(12000);
 await context.exposeBinding("recordBrokerClipboard", () => { clipboardWrites++; });
 await context.addInitScript(() => { Object.defineProperty(navigator,"clipboard",{ configurable:true,value:{ writeText:async () => (window as any).recordBrokerClipboard(),write:async () => (window as any).recordBrokerClipboard() } }); });
 await context.route("**/*", route => new URL(route.request().url()).origin === ownerOrigin ? route.continue() : route.abort("internetdisconnected"));
 context.on("request", req => { if (req.url().startsWith(ownerOrigin + "/api/")) ownerBodies.push({ path:new URL(req.url()).pathname,body:req.postData()||"" }); });
 owner=await context.newPage(); owner.on("pageerror",error=>errors.push(error.message)); await owner.goto(ownerOrigin+"/passwords/"); await unlock(true);
 await addLogin("Synthetic broker account", fixtureOrigin+"/login"); await addLogin("Alternate same-origin account", fixtureOrigin+"/login"); await addLogin("Redirect control",fixtureOrigin+"/redirect-login");
 await settings(); await owner.locator("#protected-composer").waitFor();
 const client=await protectedPair("Protected UI fixture",true), other=await protectedPair("Other protected fixture");
 const legacyPair=await ownerApi("/api/password-broker/pairing",{}), legacy=(await agent("connect","",{code:legacyPair.value.code,label:"Legacy control"})).value;
 await deniedRequest("connect","",{code:legacyPair.value.code,label:"Pair replay"});
 await until(async()=>owner.locator("#protected-new").isEnabled(),Boolean);
 await owner.locator("#protected-new").click();
 await until(async()=>owner.locator("#protected-client option").count(), count=>count===3);
 assert.equal(await owner.locator(`#protected-client option[value='${legacy.client_id}']`).count(),0); await owner.keyboard.press("Escape");
 const published=await compose(client.client_id), workspace=published.workspace_id;
 check("real owner composer saves encrypted originals before publishing fixed references"); mapCase(1,"passed","Real composer entered three canaries; captured API bodies and synthetic remote traffic contain no originals. Only pseudonym references published.");
 const list=await cli("protected-list",{token:client.token}); assert.equal(list.workspaces.length,1); noCanaries(list); assert(!JSON.stringify(list).includes("source_id")&&!JSON.stringify(list).includes(fixtureOrigin));
 const refs=list.workspaces[0].references; assert.equal(refs.length,3); assert.match(list.workspaces[0].prompt,/\[\[HK:/);
 for(const action of ["decrypt","unmask","execute","reveal"]) await deniedRequest(action,client.token,{workspace_id:workspace});
 mapCase(2,"passed","Unknown decrypt/unmask/reveal/execute routes denied; agent identity also denied owner/vault endpoints.");
 for(const path of ["/api/password-vault","/api/password-vault/config","/api/password-broker","/api/password-broker/protected-pairing"]) assert.notEqual((await agent(path,client.token,undefined,{},path.endsWith("pairing")?"POST":"GET")).status,200);
 assert.equal((await cli("protected-list",{token:other.token})).workspaces.length,0); await deniedRequest("protected-login",other.token,{workspace_id:workspace});
 await deniedRequest("protected-list",legacy.token,{}); await deniedRequest("request",client.token,{origin:fixtureOrigin,scope:"login_read"});
 const transfer=await agent("/api/transfer-broker/agent/request",client.token,{connection_id:crypto.randomUUID(),operation:"list",path:""}); assert.equal(transfer.status,403);
 mapCase(3,"passed","Two independent protected principals: foreign workspace invisible and unusable. Same local vault is the explicit tenant boundary.");
 const requested=await cli("protected-login",{token:client.token,workspace_id:workspace}); const rid=requested.request_id;
 await deniedRequest("status",other.token,{request_id:rid}); await deniedRequest("protected-login",client.token,{workspace_id:workspace});
 for(const [key,value] of [["origin","https://wrong.invalid"],["source_id",crypto.randomUUID()],["cookies",true],["decrypt",true],["path","/account"]]) await deniedRequest("protected-login",client.token,{workspace_id:workspace,[key as string]:value});
 const wrong=await ownerApi("/api/password-broker/approve/"+rid,{epoch:published.epoch,revision:published.revision,source_id:"wrong-source",sealed:{key:"",iv:"",ciphertext:""}}); assert.equal(wrong.status,403);
 mapCase(7,"passed","Agent cannot supply origin/source/path/action fields; wrong owner source is rejected before sealed login decryption; UI source is preselected and disabled.");
 await protectedApprove(rid,published.source_id); const session=await ready(client.token,rid); assert.equal(loginPosts,1); const firstProfiles=await profiles(); assert(firstProfiles.length>0);
 assert(lastApproval); assert.notEqual((await ownerApi(lastApproval.path,lastApproval.body)).status,200);
 mapCase(5,"passed","Second protected-login and sealed owner approval replay both rejected.");
 mapCase(19,"passed","Explicit consent performed one real Chromium synthetic form login. Username/password reached only the approved local website; agent got status/session ID.");
 const beforeTraffic=fixtureTraffic.length;
 for(const path of ["/account","/gzip","/binary","/redirect","/account?pii="+encodeURIComponent(person)]) await deniedRequest("read",client.token,{session_id:session,path});
 assert.equal(fixtureTraffic.length,beforeTraffic);
 for(const action of ["cookies","storageState","screenshot","cdp","raw-download"]) await deniedRequest(action,client.token,{session_id:session});
 for(const field of ["cookies","storageState","screenshots","raw_download","decrypt","unmask"]) await deniedRequest("protected-list",client.token,{[field]:true});
 mapCase(9,"passed","Cookie/Authorization canaries existed in the real private login response; protected reads returned denial only.");
 mapCase(10,"passed","Protected read attempts for gzip/large/binary URLs were denied before any fixture request; those formats are deliberately not parsed or projected.");
 mapCase(11,"passed","Private account reflected plain/base64/URL-encoded/image canaries. No protected page output exists; captured agent responses contain none.");
 mapCase(12,"passed","Private title/aria/download-filename/header canaries remained private because protected reads and raw browser APIs are unavailable.");
 mapCase(18,"passed","Cookies/storageState/screenshots/CDP/raw-download routes and unknown fields denied in the actual API.");
 const foreignWorkspace=crypto.randomUUID(); await deniedRequest("protected-draft",client.token,{workspace_id:foreignWorkspace,text:`[[HK:${refs[0].id}]]`});
 const validText=`Hallo [[HK:${refs.find((r:any)=>r.kind==='person').id}]], wir bestätigen [[HK:${refs.find((r:any)=>r.kind==='case').id}]] und verwenden [[HK:${refs.find((r:any)=>r.kind==='email').id}]].`;
 for(const text of [`[[HK:${crypto.randomUUID()}]]`,validText+" [[HK:broken]]",validText+" <img src=x>",validText+" https://example.invalid",validText+"\n",validText+"x".repeat(8000)]) await deniedRequest("protected-draft",client.token,{workspace_id:workspace,text});
 mapCase(4,"passed","Forged UUID, malformed/unknown token and foreign workspace draft references all denied.");
 for(const body of [{workspace_id:workspace,text:validText,format:"html"},{workspace_id:workspace,text:validText,detector:false}]) await deniedRequest("protected-draft",client.token,body);
 mapCase(13,"passed","Unsupported format/detector fields and HTML rejected with no raw fallback. No general PII detector is claimed.");
 const splitBody=JSON.stringify({workspace_id:workspace,text:validText+" [[HK:broken]]"}); const at=splitBody.indexOf("[[HK:")+3;
 const chunks=[splitBody.slice(0,at),splitBody.slice(at)];
 const streamed=await fetch(ownerOrigin+"/api/password-broker/agent/protected-draft",{method:"POST",headers:{"X-HeavenKey-Client":"password-agent","X-HeavenKey-Token":client.token,"Content-Type":"application/json"},body:new ReadableStream({async start(controller){for(const chunk of chunks){controller.enqueue(new TextEncoder().encode(chunk));await delay(20);}controller.close();}}),signal:AbortSignal.timeout(15000)}); assert.notEqual(streamed.status,200); agentResponses.push(await streamed.text());
 assert.equal((await ownerApi("/api/password-broker/protected/workspaces")).value.workspaces[0].draft,null);
 mapCase(14,"passed","Chunked HTTP draft split inside a token was fully buffered then rejected for malformed trailing reference. No SSE/streaming output API exists.");
 const receipt=await cli("protected-draft",{token:client.token,workspace_id:workspace,text:validText}); assert.deepEqual(receipt,{status:"drafted"}); await deniedRequest("protected-draft",client.token,{workspace_id:workspace,text:validText});
 await owner.locator("#protected-preview-"+workspace).waitFor(); await owner.locator("#protected-preview-"+workspace).click();
 const preview=await owner.locator("#protected-preview").innerText(); for(const original of [person,email,privateCase]) assert(preview.includes(original)); assert(!preview.includes("[[HK:"));
 assert.equal(await owner.evaluate(()=>document.activeElement?.id),"protected-preview"); await screenshot("protected-local-owner-preview");
 mapCase(20,"partial","Supported scope is local draft only: exact references resolved by owner textContent preview. Transfer request from protected client denied; no external sending performed.");
 mapCase(21,"passed","Agent receives fixed drafted receipt; owner-only preview and vault endpoints denied to agent, including guessed live session reads.");
 await owner.locator("#protected-save-draft-"+workspace).click(); await owner.locator("#protected-status").filter({hasText:"Entwurf verschlüsselt gespeichert"}).waitFor();
 assert.equal((await cli("protected-list",{token:client.token})).workspaces.length,0); await deniedRequest("protected-login",client.token,{workspace_id:workspace});
 check("draft preview and encrypted draft save work; vault revision revokes the old grant");
 await until(profiles,values=>values.length===0,15);
 const second=await compose(client.client_id,published.source_id); const req2=await cli("protected-login",{token:client.token,workspace_id:second.workspace_id}); await protectedApprove(req2.request_id,second.source_id); const sid2=await ready(client.token,req2.request_id);
 assert.equal(loginPosts,2); assert(freshLogins.length>=2&&freshLogins.every(Boolean)); const secondProfiles=await profiles(); assert(secondProfiles.length>0); assert(!secondProfiles.some(name=>firstProfiles.includes(name)));
 mapCase(22,"passed","Two sequential real private browser logins used fresh profile identities and both first login GETs lacked the previous session cookie.");
 await cli("protected-close",{token:client.token,workspace_id:second.workspace_id}); await deniedRequest("read",client.token,{session_id:sid2,path:"/account"}); await deniedRequest("protected-login",client.token,{workspace_id:second.workspace_id});
 await ownerApi("/api/password-broker/protected/workspaces/"+second.workspace_id,undefined,"DELETE");
 mapCase(6,"partial","Explicit protected-close, owner deletion and actual vault revision revoke tested. Five-minute wall-clock expiry is covered by backend unit test, not waited in this 240-second browser run.");
 const redirectSource=await owner.locator("#protected-new").isEnabled(); assert(redirectSource); await owner.locator("#protected-new").click(); const redirectId=(await owner.locator("#protected-source option").filter({hasText:"Redirect control"}).getAttribute("value"))!; await owner.keyboard.press("Escape");
 const redirectJob=await compose(client.client_id,redirectId); const redirectRequest=await cli("protected-login",{token:client.token,workspace_id:redirectJob.workspace_id}); await protectedApprove(redirectRequest.request_id,redirectId);
 await until(async()=>(await agent("status",client.token,{request_id:redirectRequest.request_id})).value.status,value=>["failed","denied","expired"].includes(value),25);
 assert(!fixtureTraffic.some(row=>row.path==="/evil")); mapCase(8,"partial","Real private-browser cross-origin login redirect failed closed without requesting destination. DNS-rebinding is not independently simulated.");
 await entries(); await owner.locator(`[data-entry-id='${published.source_id}'] button`).click(); await owner.locator("[data-testid=delete-entry]").click(); await owner.locator("#delete-confirm").click();
 await owner.locator("#delete-dialog-status").filter({hasText:"geschützte Aufträge"}).waitFor(); await owner.locator("#delete-cancel").click(); await settings();
 check("referenced login cannot be removed before its encrypted protected records");
 await owner.locator("#protected-preview-"+workspace).click(); await entries(); await owner.locator("#lock").click();
 assert.equal(await owner.locator("#protected-preview").textContent(),""); for(const kind of ["person","email","case"]) assert.equal(await owner.locator("#protected-"+kind).inputValue(),"");
 await unlock(); await settings(); await owner.locator("#protected-preview-"+workspace).waitFor(); await owner.locator("#protected-preview-"+workspace).click(); assert((await owner.locator("#protected-preview").innerText()).includes(person));
 assert.equal((await cli("protected-list",{token:client.token})).workspaces.length,0);
 await stop(); await start(); await deniedRequest("protected-list",client.token,{}); assert.equal((await ownerApi("/api/password-broker")).value.clients.length,0);
 mapCase(23,"passed","Lock cleared originals and preview; unlock restored only encrypted saved records without republishing; process restart erased prior clients/grants and owned profiles were cleaned.");
 mapCase(15,"delegated","Contained-shell filesystem/env/argv isolation is root-owned acceptance, not browser proof."); mapCase(16,"delegated","OS/VM egress bypass proof is root-owned contained-shell acceptance."); mapCase(17,"delegated","PTY/reveal shell isolation is root-owned. This script additionally denied reveal API routes.");
 mapCase(24,"residual_risk","Malicious approved website receives login credentials; semantic/timing covert channels are not eliminated. No universal security or free-text PII-detection claim.");
 await until(profiles,values=>values.length===0,15); assert.equal(clipboardWrites,0); noCanaries(agentResponses.join("\n"));
 for(const request of ownerBodies) noCanaries(request.body);
 assert.deepEqual(errors,[]); assert.deepEqual(await hashSources(),sourceHashes,"Source changed during integrated acceptance"); assert.equal(digest(await readFile(binary)),binaryHash,"Binary changed during acceptance");
 assert.equal(mapped.size,24); check("24 planned cases mapped with explicit partial, delegated and residual statuses");
}
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
 await Promise.race([localMain(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error("Protected browser acceptance exceeded 230-second execution deadline")),230000);})]);
 await writeFile(reportPath,JSON.stringify({pass:true,synthetic_only:true,real_rust:true,real_chromium:true,native_hardware:false,binary,binary_sha256:binaryHash,source_sha256:sourceHashes,planned_acceptance_sha256:digest(await readFile(plannedPath)),cases,mapped_cases:[...mapped.values()].sort((a,b)=>a.id-b.id),errors,screenshots,login_posts:loginPosts,clipboard_writes:clipboardWrites,private_profiles_cleaned:true,scope:"Protected local drafting only; root must merge contained-shell evidence for delegated cases"},null,2)+"\n"); console.log(JSON.stringify({pass:true,report:reportPath,mapped_cases:mapped.size}));
} catch(error) {
 errors.push(String(error)); console.error(error instanceof Error ? error.stack : String(error)); await mkdir(resolve(reportPath,".."),{recursive:true}); await writeFile(reportPath,JSON.stringify({pass:false,synthetic_only:true,binary,binary_sha256:binaryHash,source_sha256:sourceHashes,cases,mapped_cases:[...mapped.values()],errors,screenshots},null,2)+"\n"); process.exitCode=1;
} finally {
 clearTimeout(deadline); await browser?.close(); await stop(); fixture?.stop(true); await cleanupOwnedBrowsers(); await rm(temporary,{recursive:true,force:true});
}
