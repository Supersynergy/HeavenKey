import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."), binary = resolve(process.env.HEAVENKEY_BINARY || "target/debug/uac-api");
const image = process.env.HEAVENKEY_SANDBOX_IMAGE || "", report = resolve(process.env.HEAVENKEY_PROTECTED_SANDBOX_REPORT || "docs/evidence/protected-sandbox.json");
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const origin = "http://localhost:18378", site = "http://localhost:18379";
const master = "Protected-sandbox-master-only!", username = "protected-user-only", password = "Protected-password-only!";
const privateValues = ["Synthetic Private Person", "synthetic-private@example.invalid", "Synthetic-Private-Case-987"], cookie = "protected-cookie-only", hostCanary = "protected-host-secret-only";
const directory = await mkdtemp(join(tmpdir(), "heavenkey-protected-sandbox-")), canaryPath = join(directory, "host-canary");
await writeFile(canaryPath, hostCanary, { mode: 0o600 });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sourceFiles = ["apps/api/src/agent_sandbox.rs", "apps/api/src/broker_agent.rs", "apps/api/src/password_manager/broker.rs", "apps/api/src/password_manager/broker/protected.rs", "apps/web/src/passwords-protected.ts", "packages/protected/schema.ts", "scripts/protected_sandbox_e2e.ts"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, sha(await readFile(join(root, path)))])));
const binaryHash = sha(await readFile(binary)), cases: { name: string; pass: true }[] = [];
let server: ChildProcess | undefined, guest: ChildProcess | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let fixture: ReturnType<typeof Bun.serve> | undefined, ownerToken = "", output = "", serverOutput = "", container = "", loginPosts = 0, passed = false, failure = "";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (name: string) => { cases.push({ name, pass: true }); console.log("PASS " + name); };
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, seconds = 25): Promise<T> {
 const end = Date.now() + seconds * 1000;
 for (;;) { const value = await fn(); if (ok(value)) return value; if (Date.now() >= end) throw Error("Protected sandbox deadline"); await delay(200); }
}
async function docker(args: string[], optional = false) {
 const result = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
 const timer = setTimeout(() => result.kill(), 10000);
 try { const [out, err, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]); if (!optional) assert.equal(code, 0, err); return { out, code }; } finally { clearTimeout(timer); }
}
async function api(path: string, body?: unknown) {
 const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(15000), headers: { Origin: origin, "X-HeavenKey-Client": "password-manager", "X-HeavenKey-Token": ownerToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 assert.equal(response.status, 200, path); return await response.json() as any;
}
const payload = String.raw`
import os,json,socket,time,urllib.request,urllib.error,pty
endpoint=os.environ['HEAVENKEY_AGENT_ENDPOINT'].rstrip('/')
def rpc(op,body):
 req=urllib.request.Request(endpoint+'/'+op,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=20) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:
  e.read(65536);return e.code,{}
def wait(fn,ok):
 end=time.monotonic()+50
 while time.monotonic()<end:
  value=fn()
  if ok(value):return value
  time.sleep(.2)
 raise RuntimeError('guest deadline')
assert 'HEAVENKEY_HOST_CANARY' not in os.environ
assert 'HEAVENKEY_TOKEN' not in os.environ
assert not os.path.exists('/Users/master')
assert os.getuid()==65532
try:
 socket.create_connection(('1.1.1.1',443),timeout=1)
 raise RuntimeError('network bypass')
except OSError:pass
try:
 master,slave=pty.openpty();os.close(master);os.close(slave);pty_available=True
except OSError:pty_available=False
for op in ['decrypt','unmask','cookies','storageState','screenshot','protected/read','transfer/list']:
 assert rpc(op,{})[0]!=200
workspace=wait(lambda:rpc('protected/list',{})[1].get('workspaces',[]),lambda rows:len(rows)==1)[0]
assert set(workspace)=={'workspace_id','prompt','references','status','expires_at'}
assert all(set(ref)=={'id','kind'} for ref in workspace['references'])
wid=workspace['workspace_id']
code,request=rpc('protected/login',{'workspace_id':wid});assert code==200
assert rpc('protected/login',{'workspace_id':wid})[0]!=200
ready=wait(lambda:rpc('status',{'request_id':request['request_id']})[1],lambda row:row.get('status')=='approved')
assert ready=={'status':'approved'}
assert rpc('read',{'session_id':'00000000-0000-4000-8000-000000000001','path':'/'})[0]!=200
assert rpc('request',{'origin':'https://example.invalid','scope':'login_read'})[0]!=200
assert rpc('protected/draft',{'workspace_id':wid,'text':'[[HK:00000000-0000-0000-0000-000000000000]]'})[0]!=200
refs={ref['kind']:'[[HK:'+ref['id']+']]' for ref in workspace['references']}
text='Hallo '+refs['person']+', deine Anfrage '+refs['case']+' wurde vorbereitet. Die E-Mail-Referenz lautet '+refs['email']+'.'
assert rpc('protected/draft',{'workspace_id':wid,'text':text})==(200,{'status':'drafted'})
assert rpc('protected/draft',{'workspace_id':wid,'text':text})[0]!=200
print(json.dumps({'protected_guest_pass':True,'pty_available':pty_available,'workspace_id':wid,'prompt':workspace['prompt'],'draft':text,'status_keys':sorted(ready)}),flush=True)
time.sleep(8)
assert rpc('protected/close',{'workspace_id':wid})[0]==200
`;
try {
 for (const url of [origin, site]) { try { await fetch(url, { signal: AbortSignal.timeout(300) }); throw Error("Occupied synthetic port"); } catch (error) { if (String(error).includes("Occupied")) throw error; } }
 fixture = Bun.serve({ port: 18379, hostname: "127.0.0.1", async fetch(req) {
  const path = new URL(req.url).pathname;
  if (req.method === "POST" && path === "/login") {
   const data = new URLSearchParams(await req.text()); assert.equal(data.get("username"), username); assert.equal(data.get("password"), password); loginPosts++;
   return new Response(null, { status: 302, headers: { location: "/private", "set-cookie": "session=" + cookie + "; HttpOnly; SameSite=Strict; Path=/" } });
  }
  if (req.headers.get("cookie")?.includes(cookie)) return new Response("<!doctype html><title>" + privateValues[0] + "</title><p>" + [password, ...privateValues].join(" ") + "</p>", { headers: { "content-type": "text/html" } });
  return new Response("<!doctype html><form method='post' action='/login'><input name='username' autocomplete='username'><input name='password' type='password' autocomplete='current-password'><button>Login</button></form>", { headers: { "content-type": "text/html" } });
 } });
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("UAC_") && !/^HEAVENKEY_(PUBLIC_ORIGIN|ORIGIN|SHARE_ORIGIN|PASSWORD_MANAGER|DOCUMENT)/.test(key)));
 server = spawn(binary, ["--password-manager", "--port", "18378", "--data-dir", join(directory, "vault")], { cwd: root, env: { ...env, HEAVENKEY_BROKER_BROWSER: chrome, TMPDIR: directory, TEMP: directory, TMP: directory }, stdio: ["ignore", "pipe", "pipe"] });
 server.stdout!.on("data", data => serverOutput = (serverOutput + data).slice(-16000)); server.stderr!.on("data", data => serverOutput = (serverOutput + data).slice(-16000));
 await until(async () => { try { return (await fetch(origin + "/health", { signal: AbortSignal.timeout(300) })).ok; } catch { return false; } }, Boolean);
 const config = await fetch(origin + "/api/password-vault/config", { headers: { Origin: origin, "X-HeavenKey-Client": "password-manager" } }); ownerToken = (await config.json() as any).token;
 browser = await chromium.launch({ headless: true, executablePath: chrome }); const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(15000);
 const owner = await context.newPage(); await owner.goto(origin + "/passwords/");
 await owner.locator("#master").fill(master); await owner.locator("#master-confirm").fill(master); await owner.locator("#unlock").click(); await owner.locator("#workspace:not([hidden])[aria-busy=false]").waitFor();
 await owner.locator("#new-entry").click(); await owner.locator("#entry-title").fill("Protected sandbox login"); await owner.locator("#entry-username").fill(username); await owner.locator("#entry-password").fill(password); await owner.locator("#entry-url").fill(site + "/login"); await owner.locator("#save-entry").click(); await owner.locator("#editor").waitFor({ state: "hidden" });
 await owner.locator("#nav-settings").click(); await owner.locator("#protected-pair:not([disabled])").waitFor();
 const paired = owner.waitForResponse(r => r.url().endsWith("/protected-pairing") && r.request().method() === "POST"); await owner.locator("#protected-pair").click(); const code = (await (await paired).json()).code;
 const before = (await docker(["ps", "-aq", "--no-trunc", "--filter", "ancestor=" + image])).out.trim().split("\n").filter(Boolean);
 guest = spawn(binary, ["--broker-sandbox", "18378", image, "--", "python3", "-c", payload], { cwd: root, env: { ...process.env, HEAVENKEY_HOST_CANARY: hostCanary }, stdio: ["pipe", "pipe", "pipe"] });
 for (const stream of [guest.stdout!, guest.stderr!]) stream.on("data", data => { output += data; if (output.length > 1048576) guest?.kill(); });
 guest.stdin!.end(JSON.stringify({ code, label: "Contained protected agent" }) + "\n");
 container = await until(async () => (await docker(["ps", "-aq", "--no-trunc", "--filter", "ancestor=" + image])).out.trim().split("\n").filter(id => id && !before.includes(id)), rows => rows.length === 1).then(rows => rows[0]);
 const facts = JSON.parse((await docker(["inspect", container])).out)[0];
 assert.equal(facts.Image, image); assert.equal(facts.Config.User, "65532:65532"); assert.equal(facts.HostConfig.NetworkMode, "none"); assert.equal(facts.HostConfig.ReadonlyRootfs, true); assert.equal(facts.HostConfig.Privileged, false); assert.deepEqual(facts.HostConfig.CapDrop, ["ALL"]); assert.equal(facts.HostConfig.PidMode, ""); assert.equal(facts.HostConfig.IpcMode, "private"); assert.equal(facts.HostConfig.PidsLimit, 128); assert.equal(facts.HostConfig.Memory, 512 * 1024 * 1024); assert(!facts.HostConfig.Binds?.length); assert(!facts.Mounts.some((m: any) => m.Type !== "tmpfs")); assert(facts.HostConfig.SecurityOpt.some((v: string) => v.startsWith("no-new-privileges")));
 check("actual Linux guest has no network, host mounts, capabilities or root authority");
 const state = await until(() => api("/api/password-broker"), row => row.clients.some((c: any) => c.protected)); const client = state.clients.find((c: any) => c.protected);
 await until(async () => owner.locator("#protected-new").isEnabled(), Boolean); await delay(3200); await owner.locator("#protected-new").click(); await owner.locator("#protected-client").selectOption(client.id); const option = owner.locator("#protected-source option").filter({ hasText: "Protected sandbox login" }); await owner.locator("#protected-source").selectOption((await option.getAttribute("value"))!);
 for (const [i, kind] of ["person", "email", "case"].entries()) await owner.locator("#protected-" + kind).fill(privateValues[i]);
 await owner.locator("#protected-publish").click(); await owner.locator("#protected-composer-dialog").waitFor({ state: "hidden" }); await owner.locator("#protected-status").filter({ hasText: "Verschlüsselt gespeichert und" }).waitFor();
 const pending = await until(() => api("/api/password-broker"), row => row.requests.some((r: any) => r.scope === "protected" && r.status === "pending")); const request = pending.requests.find((r: any) => r.scope === "protected" && r.status === "pending");
 await owner.locator("#broker-review-" + request.id).click(); await owner.locator("#broker-approval-dialog").waitFor(); assert.equal(await owner.locator("#broker-account").isDisabled(), true); await owner.locator("#broker-consent").check(); await owner.locator("#broker-approve").click(); await owner.locator("#broker-approval-dialog").waitFor({ state: "hidden" });
 const drafted = await until(() => api("/api/password-broker/protected/workspaces"), row => row.workspaces.some((w: any) => w.approved === true && typeof w.draft === "string")); const workspace = drafted.workspaces.find((w: any) => w.approved === true && typeof w.draft === "string");
 const ownerReady = await until(() => api("/api/password-broker"), row => row.requests.some((r:any) => r.id === request.id && ["ready","failed","denied","expired"].includes(r.status)));
 assert.equal(ownerReady.requests.find((r:any) => r.id === request.id).status,"ready");
 assert.equal(loginPosts, 1); check("contained shell authenticates through explicit owner approval without credentials or page data");
 await owner.locator("#protected-preview-" + workspace.workspace_id).click(); const preview = await owner.locator("#protected-preview").innerText(); for (const value of privateValues) assert(preview.includes(value));
 check("only local owner preview resolves private references");
 await until(async () => guest!.exitCode, code => code !== null, 20); assert.equal(guest.exitCode, 0, "Guest failed: " + output);
 const records = output.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
 const guestRecords = records.flatMap(row => typeof row.heavenkey_agent_output === "string" ? row.heavenkey_agent_output.split("\n").flatMap((line: string) => { try { return [JSON.parse(line)]; } catch { return []; } }) : []);
 assert(guestRecords.some(row => row.protected_guest_pass === true && JSON.stringify(row.status_keys) === JSON.stringify(["status"])));
 for (const secret of [master, username, password, cookie, hostCanary, ownerToken, code, ...privateValues]) assert(!output.includes(secret), "Synthetic secret in guest/host transcript");
 check("guest env/filesystem/PTY and arbitrary reveal operations cannot obtain host secrets"); check("guest can submit one pseudonymous draft but replay and legacy raw reads are denied");
 const receipt = records.filter(row => row.heavenkey_sandbox_receipt === 1).at(-1); assert(receipt && receipt.container_id === container && receipt.removed === true); assert.equal((await docker(["inspect", container], true)).code !== 0, true);
 await until(() => api("/api/password-broker"), row => !row.clients.length && !row.sessions.length); await until(() => readdir(directory), rows => !rows.some(name => name.startsWith("heavenkey-broker-")));
 check("guest exit removes owned container, capability, private browser and session");
 for (const [file, hash] of Object.entries(sourceHashes)) assert.equal(sha(await readFile(join(root, file))), hash); passed = true;
} catch (error) {
 failure = error instanceof Error ? error.message : String(error);
 let diagnostic = output; for (const value of [master, username, password, cookie, hostCanary, ownerToken, ...privateValues]) if (value) diagnostic = diagnostic.replaceAll(value, "[REDACTED]");
 console.error(diagnostic.slice(-4000)); throw error;
}
finally {
 if (guest?.exitCode === null) { guest.kill("SIGTERM"); await delay(1000); if (guest.exitCode === null) guest.kill("SIGKILL"); }
 if (container) await docker(["rm", "-f", container], true);
 await browser?.close(); if (server?.exitCode === null) { server.kill("SIGTERM"); await until(async () => server!.exitCode, code => code !== null, 5).catch(() => server!.kill("SIGKILL")); }
 fixture?.stop(true); await mkdir(resolve(report, ".."), { recursive: true });
 await writeFile(report, JSON.stringify({ pass: passed, cases, failure, host_platform: process.platform, guest_platform: "linux", image, binary_sha256: binaryHash, source_hashes: sourceHashes, login_posts: loginPosts, acceptance_scope: "Actual protected composer and contained Linux shell; local synthetic website only. Does not protect secrets from an independently privileged host agent or covert website timing.", ...(passed ? {} : { server_output: serverOutput }) }, null, 2) + "\n");
 await rm(directory, { recursive: true, force: true });
}
