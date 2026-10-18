import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, platform as hostPlatform, release as hostRelease } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."), binary = resolve(process.env.HEAVENKEY_BINARY || "target/debug/uac-api");
const image = process.env.HEAVENKEY_SANDBOX_IMAGE || "";
assert.match(image, /^(sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/, "Supply HEAVENKEY_SANDBOX_IMAGE as immutable existing image identity");
const report = resolve(process.env.HEAVENKEY_SANDBOX_REPORT || "docs/evidence/password-broker/sandbox-browser.json");
const backpressureOnly = process.env.HEAVENKEY_SANDBOX_BACKPRESSURE_ONLY === "1";
const chrome = process.env.CHROME_PATH || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const origin = "http://localhost:18278", destination = "http://localhost:18279";
const master = "Sandbox-synthetic-master-only!", username = "Sandbox-synthetic-user-only", password = "Sandbox-synthetic-password-only!", cookie = "Sandbox-synthetic-cookie-only!", canary = "Sandbox-host-canary-only!";
const directory = await mkdtemp(join(tmpdir(), "heavenkey-sandbox-e2e-")), canaryPath = join(directory, "host-canary");
await writeFile(canaryPath, canary, { mode: 0o600 });
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const sources = ["apps/api/src/agent_sandbox.rs", "apps/api/src/broker_agent.rs", "apps/api/src/main.rs", "apps/api/src/password_manager/broker.rs", "apps/api/src/password_manager/browser_executor.rs", "scripts/broker_sandbox_e2e.ts", "scripts/build_agent_sandbox.ts", "scripts/sandbox/Dockerfile"];
const hashSources = () => Promise.all(sources.map(async file => [file, sha(await readFile(join(root, file)))])).then(Object.fromEntries);
const sourceHashes = await hashSources(), binaryHash = sha(await readFile(binary));
const cases: { name: string; pass: true }[] = [], errors: string[] = [], launches: any[] = [], active = new Set<ChildProcess>(), ownedContainers = new Set<string>();
let server: ChildProcess | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, fixture: ReturnType<typeof Bun.serve> | undefined, owner: Page, ownerToken = "", serverOutput = "", loginPosts = 0;
let imageFacts: any, dockerFacts: any, sourceBindingsVerified = false;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (name: string) => { cases.push({ name, pass: true }); console.log("PASS " + name); };
async function until<T>(fn: () => Promise<T>, accept: (value: T) => boolean, seconds = 20): Promise<T> {
 const deadline = Date.now() + seconds * 1000;
 for (;;) { const value = await fn(); if (accept(value)) return value; if (Date.now() >= deadline) throw Error("Condition deadline exceeded"); await delay(200); }
}
async function docker(args: string[], allowFailure = false) {
 const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }); const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
 const bounded = async (stream: ReadableStream<Uint8Array>) => { const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0; for (;;) { const row = await reader.read(); if (row.done) break; size += row.value.length; if (size > 1048576) { child.kill("SIGKILL"); throw Error("Docker output limit"); } chunks.push(row.value); } return Buffer.concat(chunks).toString(); };
 try { const [out, err, code] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]); if (!allowFailure) assert.equal(code, 0, "Docker failed: " + err); return { out, err, code }; } finally { clearTimeout(timer); }
}
async function containers() { return (await docker(["ps", "-aq", "--no-trunc", "--filter", "ancestor=" + image])).out.trim().split("\n").filter(Boolean); }
async function free(port: number) {
 for (const host of ["127.0.0.1", "::1"]) await new Promise<void>((resolve, reject) => { const socket = createConnection({ host, port }); socket.setTimeout(500); socket.once("connect", () => { socket.destroy(); reject(Error("Refusing occupied test port " + port)); }); socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); error.code === "ECONNREFUSED" ? resolve() : reject(error); }); socket.once("timeout", () => { socket.destroy(); reject(Error("Port probe deadline")); }); });
}
async function api(path: string, body?: unknown) {
 const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "X-HeavenKey-Client": "password-manager", "X-HeavenKey-Token": ownerToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 assert.equal(response.status, 200, "Owner API failed " + path); return await response.json() as any;
}
async function settings() { if (await owner.locator("#settings-view").isHidden()) await owner.locator("#nav-settings").click(); await owner.locator("#broker-settings").waitFor(); }
async function pair() { await settings(); const response = owner.waitForResponse(row => row.url().endsWith("/api/password-broker/pairing") && row.request().method() === "POST"); await owner.locator("#broker-pair").click(); return (await (await response).json()).code as string; }
async function approve(id: string) {
 await settings(); await owner.locator("#broker-review-" + id).click(); await owner.locator("#broker-approval-dialog").waitFor(); const option = owner.locator("#broker-account option").filter({ hasText: "Sandbox synthetic account" }); await owner.locator("#broker-account").selectOption((await option.getAttribute("value"))!); await owner.locator("#broker-consent").check(); const response = owner.waitForResponse(row => row.url().endsWith("/approve/" + id)); await owner.locator("#broker-approve").click(); assert.equal((await response).status(), 200); await owner.locator("#broker-approval-dialog").waitFor({ state: "hidden" });
}
function launch(code: string, payload: string, extraEnv: Record<string, string> = {}) {
 const child = spawn(binary, ["--broker-sandbox", "18278", image, "--", "python3", "-c", payload], { cwd: root, env: { ...process.env, HEAVENKEY_HOST_CANARY: canary, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
 active.add(child); let stdout = "", stderr = "";
 child.stdout!.on("data", data => { stdout += data; if (stdout.length > 1048576) child.kill("SIGTERM"); }); child.stderr!.on("data", data => { stderr += data; if (stderr.length > 1048576) child.kill("SIGTERM"); });
 child.stdin!.end(JSON.stringify({ code, label: "OS-contained synthetic agent" }) + "\n");
 const completion = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", exit => { active.delete(child); resolve(exit); }); });
 const exitEvent = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
 const timer = setTimeout(() => child.kill("SIGTERM"), 90000); completion.finally(() => clearTimeout(timer));
 return { child, completion, exitEvent, output: () => ({ stdout, stderr }) };
}
async function inspectStarted(before: string[]) {
 const ids = await until(containers, list => list.some(id => !before.includes(id))); const added = ids.filter(id => !before.includes(id)); assert.equal(added.length, 1, "Ambiguous container ownership"); const id = added[0]; assert.match(id, /^[a-f0-9]{64}$/); ownedContainers.add(id);
 const facts = await until(async () => JSON.parse((await docker(["inspect", id])).out)[0], row => row.State.Running);
 assert.equal(facts.Image, imageFacts.Id); assert.equal(facts.Config.User, "65532:65532"); assert.equal(facts.HostConfig.NetworkMode, "none"); assert.equal(facts.HostConfig.ReadonlyRootfs, true); assert.equal(facts.HostConfig.Privileged, false); assert.equal(facts.HostConfig.PidMode, ""); assert.equal(facts.HostConfig.IpcMode, "private"); assert.equal(facts.HostConfig.Memory, 512 * 1024 * 1024); assert.equal(facts.HostConfig.PidsLimit, 128); assert.equal(facts.HostConfig.NanoCpus, 2e9); assert.deepEqual(facts.HostConfig.CapDrop, ["ALL"]); assert(!facts.HostConfig.CapAdd?.length); assert(facts.HostConfig.SecurityOpt.some((s: string) => /^no-new-privileges(?::true)?$/.test(s))); assert(!facts.HostConfig.SecurityOpt.some((s: string) => s.includes("unconfined"))); assert(!facts.HostConfig.Binds?.length && !facts.HostConfig.Devices?.length && !facts.Mounts?.some((m: any) => m.Type !== "tmpfs"));
 return { id, facts };
}
async function removed(id: string) { await until(async () => (await docker(["inspect", id], true)).code, code => code !== 0, 10); ownedContainers.delete(id); }
async function currentClient() {
 const state = await api("/api/password-broker"); assert.equal(state.clients.length, 1, "Exactly this test's paired client must be live"); return state.clients[0].id as string;
}
async function revoked(client: string, mode: string) {
 let observed: any;
 const clean = await until(async () => {
  const state = await api("/api/password-broker"), profiles = (await readdir(directory)).filter(name => /^heavenkey-broker-[0-9a-f-]{36}$/.test(name));
  observed = { client_id: client, clients_remaining: state.clients.length, live_requests: state.requests.filter((request: any) => ["pending", "running", "ready"].includes(request.status)), sessions_remaining: state.sessions.length, profiles_remaining: profiles };
  return { state, profiles };
 }, ({ state, profiles }) => state.clients.length === 0 && !state.requests.some((request: any) => ["pending", "running", "ready"].includes(request.status)) && state.sessions.length === 0 && profiles.length === 0, 15).catch(error => { throw Error(mode + " lifecycle cleanup failed: " + JSON.stringify(observed) + "; " + error); });
 assert(!clean.state.clients.some((value: any) => value.id === client));
 check(mode + " revokes entire paired client, all live requests/browser jobs and private profiles");
 return { client_id: client, clients_remaining: clean.state.clients.length, live_requests_remaining: 0, sessions_remaining: clean.state.sessions.length, private_profiles_remaining: clean.profiles.length, requests: clean.state.requests.filter((request: any) => request.client_id === client).map((request: any) => ({ id: request.id, status: request.status })) };
}
function structuredLogs(stderr: string): Record<string, unknown>[] {
 return stderr.split("\n").flatMap(line => { try { const value = JSON.parse(line); return value && typeof value === "object" && !Array.isArray(value) ? [value] : []; } catch { return []; } });
}
function agentLines(stderr: string): string[] {
 return structuredLogs(stderr).flatMap(record => Object.keys(record).length === 1 && typeof record.heavenkey_agent_output === "string" ? record.heavenkey_agent_output.split("\n") : []);
}
function receipt(output: { stdout: string; stderr: string }, container: string) {
 for (const secret of [master, username, password, cookie, canary, ownerToken]) assert(!JSON.stringify(output).includes(secret), "Secret exposed in actual agent/host output");
 const records = structuredLogs(output.stderr).filter(record => record.heavenkey_sandbox_receipt === 1);
 assert(records.length > 0, "Trusted final host receipt missing"); const final = records.at(-1);
 assert.equal(final.container_id, container); assert.equal(final.image_id, image); assert.equal(final.container_os, "linux"); assert.equal(final.removed, true); return final;
}
async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]); }
 finally { clearTimeout(timer); }
}
const pipeDriver = String.raw`
import os,sys,json,signal,subprocess,time,select
broker=None
read_fd=None
write_fd=None
def interrupted(signum,frame): raise RuntimeError('driver interrupted')
for signum in [signal.SIGTERM,signal.SIGINT,signal.SIGALRM]: signal.signal(signum,interrupted)
signal.alarm(45)
def emit(value): print(json.dumps(value),flush=True)
try:
 raw=sys.stdin.buffer.readline(65537)
 if not raw.endswith(b'\n') or len(raw)>65536: raise RuntimeError('invalid driver input')
 config=json.loads(raw)
 read_fd,write_fd=os.pipe()
 broker=subprocess.Popen([config['binary'],'--broker-sandbox','18278',config['image'],'--','python3','-c',config['payload']],cwd=config['cwd'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=write_fd,close_fds=True)
 os.close(write_fd);write_fd=None
 broker.stdin.write((json.dumps(config['pairing'])+'\n').encode());broker.stdin.close()
 emit({'driver_started':1,'broker_pid':broker.pid,'stderr_transport':'os.pipe','read_fd_unread':True})
 if not select.select([sys.stdin.buffer],[],[],25)[0]: raise RuntimeError('cancel command deadline')
 control=sys.stdin.buffer.readline(1025)
 if len(control)>1024 or json.loads(control)!={'cancel':True}: raise RuntimeError('invalid driver control')
 early=broker.poll() is not None
 start=time.monotonic()
 if not early: broker.terminate()
 exceeded=False
 try: exit_code=broker.wait(timeout=8)
 except subprocess.TimeoutExpired:
  exceeded=True
  exit_code=None
 elapsed=(time.monotonic()-start)*1000
 # No os.read has occurred before the actual owned broker wait above.
 before_first_read=not exceeded
 if exceeded:
  broker.kill();broker.wait(timeout=3)
 os.set_blocking(read_fd,False)
 chunks=[];size=0;truncated=False;eof=False;drain_end=time.monotonic()+2
 while time.monotonic()<drain_end:
  if not select.select([read_fd],[],[],min(.05,max(0,drain_end-time.monotonic())))[0]:continue
  try: chunk=os.read(read_fd,8192)
  except BlockingIOError:continue
  if not chunk:eof=True;break
  if size+len(chunk)>1048576:
   chunks.append(chunk[:1048576-size]);size=1048576;truncated=True;break
  chunks.append(chunk);size+=len(chunk)
 emit({'driver_result':1,'exit_code':exit_code,'exit_deadline_exceeded':exceeded,'exited_before_cancel':early,'exit_before_first_os_read':before_first_read,'cancel_to_wait_ms':elapsed,'stderr_bytes':size,'stderr_truncated':truncated,'drain_eof':eof,'stderr_captured':b''.join(chunks).decode('utf-8',errors='replace')})
except Exception:
 emit({'driver_error':'trusted pipe driver failed'})
 sys.exit(1)
finally:
 signal.alarm(0)
 if broker is not None and broker.poll() is None:
  broker.kill()
  try:broker.wait(timeout=3)
  except subprocess.TimeoutExpired:pass
 for fd in [read_fd,write_fd]:
  if fd is not None:
   try:os.close(fd)
   except OSError:pass
`;
async function stalledStderr() {
 const before = await containers(), code = await pair();
 const payload = "import sys,time\ntime.sleep(2)\nsys.stdout.write(('b'*1023+'\\n')*256)\nsys.stdout.flush()\ntime.sleep(120)\n";
 const driver = spawn("python3", ["-u", "-c", pipeDriver], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] }); active.add(driver);
 let stdout = "", stderr = "";
 driver.stdout!.on("data", data => { stdout += data; if (Buffer.byteLength(stdout) > 2 * 1048576) driver.kill("SIGTERM"); });
 driver.stderr!.on("data", data => { stderr = (stderr + data).slice(-16384); });
 const completion = new Promise<number | null>((resolve, reject) => { driver.once("error", reject); driver.once("close", exit => { active.delete(driver); resolve(exit); }); });
 driver.stdin!.write(JSON.stringify({ binary, image, cwd: root, payload, pairing: { code, label: "OS pipe-backpressure synthetic agent" } }) + "\n");
 const evidence: any = { kind: "host_stderr_backpressure_cancel", stderr_transport: "trusted Python os.pipe", planned_agent_output_bytes: 256 * 1024, pipe_unread_until_broker_wait: true, broker_wait_deadline_ms: 8000, driver_pid: driver.pid }; launches.push(evidence);
 let inspected: Awaited<ReturnType<typeof inspectStarted>> | undefined, client: string | undefined, result: Record<string, unknown> | undefined;
 try {
  const started = await until(async () => structuredLogs(stdout).find(record => record.driver_started === 1), Boolean, 20); assert(started); evidence.broker_pid = started.broker_pid;
  inspected = await inspectStarted(before); evidence.container = inspected.id; client = await currentClient(); evidence.client_id = client;
  await delay(3500); driver.stdin!.end(JSON.stringify({ cancel: true }) + "\n");
  assert.equal(await bounded(completion, 18000, "Trusted pipe driver wait/drain deadline exceeded"), 0, "Trusted pipe driver failed: " + stderr);
  result = structuredLogs(stdout).find(record => record.driver_result === 1); assert(result, "Trusted pipe result missing");
  Object.assign(evidence, Object.fromEntries(Object.entries(result).filter(([key]) => key !== "stderr_captured")));
  assert.equal(result.exit_deadline_exceeded, false, "Broker exceeded 8-second exit deadline with genuinely unread OS stderr pipe");
  assert.equal(result.exit_before_first_os_read, true); assert(Number(result.cancel_to_wait_ms) <= 8000); assert.notEqual(result.exit_code, 0);
 } finally {
  if (driver.exitCode === null && driver.signalCode === null) {
   driver.kill("SIGTERM");
   try { await bounded(completion, 4000, "Trusted driver termination deadline"); }
   catch { driver.kill("SIGKILL"); await bounded(completion, 4000, "Trusted driver reap deadline"); }
  }
 }
 assert(inspected && client && result); await removed(inspected.id); evidence.lifecycle = await revoked(client, "OS-pipe stderr backpressure cancellation");
 const captured = String(result.stderr_captured); evidence.output_sha256 = sha(captured);
 for (const secret of [master, username, password, cookie, canary, ownerToken, code]) assert(!captured.includes(secret));
 const hostReceipts = structuredLogs(captured).filter(record => record.heavenkey_sandbox_receipt === 1); evidence.host_receipt_delivered = hostReceipts.length > 0;
 if (hostReceipts.length) evidence.host_receipt = receipt({ stdout: "", stderr: captured }, inspected.id);
 check("genuinely unread OS stderr pipe permits broker exit within 8 seconds and owned-container/client cleanup");
}

const python = String.raw`
import os,sys,json,socket,ctypes,errno,time,urllib.request,urllib.error,http.client,concurrent.futures,subprocess,platform
checks={}
def ck(name,condition):
 checks[name]=bool(condition)
 if not condition: raise RuntimeError(name)
def denied_open(path):
 try:
  with open(path,'rb') as f: f.read(4096)
  return False
 except OSError: return True
endpoint=os.environ['HEAVENKEY_AGENT_ENDPOINT'].rstrip('/')
print(json.dumps({'heavenkey_sandbox_receipt':1,'container_id':'forged','image_id':'forged','removed':True}),flush=True)
def rpc(op,body):
 request=urllib.request.Request(endpoint+'/'+op,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(request,timeout=22) as response: return response.status,json.load(response)
 except urllib.error.HTTPError as error:
  try: value=json.load(error)
  except Exception: value={}
  return error.code,value
status=open('/proc/self/status').read()
ck('uid_65532',os.getuid()==65532)
for key,expected in [('NoNewPrivs','1'),('CapEff','0000000000000000'),('Seccomp','2')]: ck(key,next(line.split(':',1)[1].strip() for line in status.splitlines() if line.startswith(key+':'))==expected)
ck('host_canary_denied',denied_open(HOST_CANARY_PATH))
ck('host_home_denied',not os.path.exists(HOST_HOME))
ck('host_vault_denied',denied_open(HOST_VAULT))
ck('host_environment_absent','HEAVENKEY_HOST_CANARY' not in os.environ)
ck('docker_socket_absent',not os.path.exists('/var/run/docker.sock') and not os.path.exists('/run/docker.sock'))
for path in ['/proc/'+str(HOST_PID)+'/mem','/proc/'+str(HOST_PID)+'/fd/0']: ck(path,denied_open(path))
ck('host_process_namespace',not os.path.exists('/proc/'+str(HOST_PID)))
for host,port in [('127.0.0.1',18278),('127.0.0.1',18279),('host.docker.internal',18278),('192.0.2.1',443)]:
 try: s=socket.create_connection((host,port),timeout=.5);s.close();blocked=False
 except OSError: blocked=True
 ck('network_'+host+'_'+str(port),blocked)
for path in ['/escape-canary','/usr/local/bin/escape-canary']:
 try: open(path,'w').write('x');blocked=False
 except OSError as error: blocked=error.errno in [errno.EROFS,errno.EACCES]
 ck('root_readonly_'+path,blocked)
with open('/work/private-canary','w') as f:f.write('private')
ck('private_work_writable',open('/work/private-canary').read()=='private')
os.mkdir('/work/mountpoint')
libc=ctypes.CDLL(None,use_errno=True)
ck('mount_denied',libc.mount(b'none',b'/work/mountpoint',b'tmpfs',0,None)==-1 and ctypes.get_errno() in [errno.EPERM,errno.EACCES])
ck('ptrace_denied',libc.ptrace(16,1,None,None)==-1 and ctypes.get_errno() in [errno.EPERM,errno.EACCES])
ck('setns_denied',libc.setns(os.open('/proc/1/ns/mnt',os.O_RDONLY),0)==-1 and ctypes.get_errno() in [errno.EPERM,errno.EACCES])
for op,body in [('execute',{'javascript':'document.cookie'}),('../api/password-vault',{}),('connect',{'code':'no'}),('disconnect',{}),('request',{'origin':DESTINATION,'scope':'login_read','token':'forged'}),('request',{'origin':DESTINATION,'scope':'login_read','url':'file:///etc/passwd'}),('read',{'session_id':'no','path':'/','token':'forged'})]:
 try:
  code,value=rpc(op,body);denied=code>=400 or value.get('ok') is False or 'error' in value
 except (ConnectionResetError,http.client.RemoteDisconnected): denied=True
 except urllib.error.URLError as error:
  if not isinstance(error.reason,ConnectionResetError):raise
  denied=True
 ck('deny_'+op+'_'+str(len(body)),denied)
# Rejection may close before an invalid request body arrives; verify both wire outcomes.
split_resets=0
for attempt in range(8):
 stream=socket.create_connection(('127.0.0.1',18271),timeout=1)
 try:
  stream.sendall(b'POST /execute HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n')
  time.sleep(.02);stream.sendall(b'{}');response=b''
  while True:
   chunk=stream.recv(4096)
   if not chunk:break
   response+=chunk
  ck('split_forbidden_'+str(attempt),response.startswith(b'HTTP/1.1 400 '))
 except ConnectionResetError:
  split_resets+=1;ck('split_forbidden_'+str(attempt),True)
 finally:stream.close()
code,request=rpc('request',{'origin':DESTINATION,'scope':'login_read'})
ck('request_success',code==200 and isinstance(request.get('request_id'),str))
request_id=request['request_id']; code,state=rpc('status',{'request_id':request_id});ck('pending_before_owner_approval',code==200 and state.get('status')=='pending')
print('SANDBOX_PENDING '+json.dumps({'request_id':request_id}),flush=True)
deadline=time.monotonic()+45
while time.monotonic()<deadline:
 code,state=rpc('status',{'request_id':request_id})
 if state.get('status')=='ready':break
 if state.get('status') in ['failed','denied','expired']:raise RuntimeError('approval failed')
 time.sleep(.5)
ck('private_browser_login_ready',state.get('status')=='ready')
session_id=state['session_id'];code,view=rpc('read',{'session_id':session_id,'path':'/account'})
ck('authenticated_projection',code==200 and 'Synthetic contained account' in view.get('text',''))
ck('projection_shape',sorted(view.keys())==['links','text','title','url'])
code,_=rpc('close',{'session_id':session_id});ck('session_closed',code==200)
start=time.monotonic()
def flood(i):
 try:
  code,value=rpc('status',{'request_id':request_id});return code>=400 or 'error' in value or value.get('ok') is False
 except (OSError,TimeoutError):return True
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool: throttled=sum(pool.map(flood,range(160)))
ck('bounded_flood',time.monotonic()-start<30 and throttled>0)
print('SANDBOX_RESULT '+json.dumps({'checks':checks,'kernel':platform.release(),'machine':platform.machine(),'namespaces':{name:os.readlink('/proc/self/ns/'+name) for name in ['pid','mnt','net','ipc','user']},'flood_denied':throttled,'split_forbidden_requests':8,'split_connection_resets':split_resets}),flush=True)
`;
const requestAndWait = "import os,json,time,urllib.request\nendpoint=os.environ['HEAVENKEY_AGENT_ENDPOINT'].rstrip('/')\nrequest=urllib.request.Request(endpoint+'/request',data=json.dumps({'origin':" + JSON.stringify(destination) + ",'scope':'login_read'}).encode(),headers={'Content-Type':'application/json'})\nwith urllib.request.urlopen(request,timeout=22) as response: result=json.load(response)\nassert isinstance(result.get('request_id'),str)\nprint('SANDBOX_PENDING '+json.dumps({'request_id':result['request_id']}),flush=True)\ntime.sleep(120)\n";
async function pendingFrom(run: ReturnType<typeof launch>) {
 await until(async () => run.output().stderr, output => agentLines(output).some(line => line.startsWith("SANDBOX_PENDING ")) || run.child.exitCode !== null, 25);
 assert.equal(run.child.exitCode, null, "Guest ended before pending request: " + run.output().stderr);
 const line = agentLines(run.output().stderr).find(line => line.startsWith("SANDBOX_PENDING ")); assert(line, "Guest pending marker missing"); return JSON.parse(line.slice("SANDBOX_PENDING ".length)).request_id as string;
}

try {
 await free(18278); await free(18279);
 imageFacts = JSON.parse((await docker(["image", "inspect", image])).out)[0]; dockerFacts = JSON.parse((await docker(["info", "--format", "{{json .}}"])).out); assert.equal(dockerFacts.OSType, "linux");
 fixture = Bun.serve({ port: 18279, hostname: "localhost", async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/login" && request.method === "POST") { const body = new URLSearchParams(await request.text()); if (body.get("username") !== username || body.get("password") !== password) return new Response("denied", { status: 403 }); loginPosts++; return new Response(null, { status: 302, headers: { location: "/account", "set-cookie": "session=" + cookie + "; HttpOnly; SameSite=Strict; Path=/" } }); }
  if (request.headers.get("cookie")?.includes(cookie)) return new Response("<!doctype html><title>Synthetic contained account</title><h1>Synthetic contained account</h1><p>" + username + " " + password + "</p>", { headers: { "Content-Type": "text/html" } });
  return new Response("<!doctype html><title>Login</title><form method='post' action='/login'><input name='username' autocomplete='username'><input name='password' type='password' autocomplete='current-password'><button>Login</button></form>", { headers: { "Content-Type": "text/html" } });
 } });
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("UAC_") && !/^HEAVENKEY_(PUBLIC_ORIGIN|ORIGIN|SHARE_ORIGIN|PASSWORD_MANAGER|DOCUMENT)/.test(key)));
 env.HEAVENKEY_BROKER_BROWSER = chrome; env.TMPDIR = directory; env.TMP = directory; env.TEMP = directory;
 server = spawn(binary, ["--password-manager", "--port", "18278", "--data-dir", directory], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
 server.stdout!.on("data", d => serverOutput = (serverOutput + d).slice(-16000)); server.stderr!.on("data", d => serverOutput = (serverOutput + d).slice(-16000));
 await until(async () => { try { return (await fetch(origin + "/health", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, Boolean);
 const config = await fetch(origin + "/api/password-vault/config", { headers: { Origin: origin, "X-HeavenKey-Client": "password-manager" } }); assert.equal(config.status, 200); ownerToken = (await config.json() as any).token;
 browser = await chromium.launch({ headless: true, executablePath: chrome }); const context = await browser.newContext(); context.setDefaultTimeout(15000); await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
 owner = await context.newPage(); owner.on("pageerror", error => errors.push(error.message)); await owner.goto(origin + "/passwords/"); await owner.locator("#master").fill(master); await owner.locator("#master-confirm").fill(master); await owner.locator("#unlock").click(); await owner.locator("#workspace:not([hidden])[aria-busy=false]").waitFor();
 await owner.locator("#new-entry").click(); await owner.locator("#entry-title").fill("Sandbox synthetic account"); await owner.locator("#entry-username").fill(username); await owner.locator("#entry-password").fill(password); await owner.locator("#entry-url").fill(destination + "/login"); await owner.locator("#save-entry").click(); await owner.locator("#editor").waitFor({ state: "hidden" }); check("real owner browser creates synthetic encrypted vault and login");
 await stalledStderr();
 if (!backpressureOnly) {
 const code = await pair(), before = await containers();
 const payload = "HOST_CANARY_PATH=" + JSON.stringify(canaryPath) + "\nHOST_HOME=" + JSON.stringify(process.env.HOME) + "\nHOST_VAULT=" + JSON.stringify(join(directory, "passwords.sqlite")) + "\nHOST_PID=" + server.pid + "\nDESTINATION=" + JSON.stringify(destination) + "\n" + python;
 const run = launch(code, payload), inspected = await inspectStarted(before), client = await currentClient(); check("running Linux Docker container has exact inspected immutable image and enforcement settings");
 await until(async () => run.output().stderr, output => agentLines(output).some(line => line.startsWith("SANDBOX_PENDING ")) || run.child.exitCode !== null, 25); assert.equal(run.child.exitCode, null, "Guest ended before request: " + run.output().stderr);
 const pendingLine = agentLines(run.output().stderr).find(line => line.startsWith("SANDBOX_PENDING ")); assert(pendingLine, "Guest pending result missing"); const pending = JSON.parse(pendingLine.slice("SANDBOX_PENDING ".length));
 const status = await api("/api/password-broker"); assert(status.requests.some((request: any) => request.request_id === pending.request_id || request.id === pending.request_id)); check("contained guest request is pending in actual owner broker");
 await approve(pending.request_id); assert.equal(await run.completion, 0, "Contained agent failed: " + run.output().stderr);
 const resultLine = agentLines(run.output().stderr).find(line => line.startsWith("SANDBOX_RESULT ")); assert(resultLine, "Contained shell did not finish checks"); const result = JSON.parse(resultLine.slice("SANDBOX_RESULT ".length)); assert(Object.values(result.checks).every(Boolean)); assert.equal(loginPosts, 1);
 const trusted = receipt(run.output(), inspected.id); assert.equal(trusted.security_inspected, true); assert.equal(trusted.exit_code, 0); assert.equal(trusted.cancelled, false);
 const completed: any = { kind: "login_and_adversarial_shell", container: inspected.id, inspected: inspected.facts, result, output_sha256: sha(run.output().stderr), host_receipt: trusted }; launches.push(completed);
 await removed(inspected.id); completed.lifecycle = await revoked(client, "successful agent exit");
 check("real contained arbitrary Python shell passes host file/process/network/privilege/RPC/flood denials and private Chrome login"); check("forged agent receipt is superseded by final trusted host receipt matching independent Docker inspection");
 for (const mode of ["failure", "cancel"] as const) {
  const before = await containers(), code = await pair();
  const run = launch(code, mode === "failure" ? "import time,sys;time.sleep(3);sys.exit(23)" : "import time;time.sleep(120)"); const inspected = await inspectStarted(before), client = await currentClient(); let cancellationMs: number | undefined;
  if (mode === "cancel") { const start = Date.now(); run.child.kill("SIGTERM"); await run.completion; cancellationMs = Date.now() - start; assert(cancellationMs < 25000, "Cancellation cleanup exceeded bounded management deadlines"); } else assert.notEqual(await run.completion, 0, "Agent failure must propagate");
  const trusted = receipt(run.output(), inspected.id); if (mode === "cancel") assert.equal(trusted.cancelled, true);
  await removed(inspected.id); const lifecycle = await revoked(client, mode); launches.push({ kind: mode, container: inspected.id, lifecycle, cancellation_ms: cancellationMs, output_sha256: sha(run.output().stderr), host_receipt: trusted }); check(mode + " removes only its owned container");
 }
 for (const mode of ["pending_before_approval_cancel", "approved_before_status_cancel"] as const) {
  const before = await containers(), code = await pair(), run = launch(code, requestAndWait), inspected = await inspectStarted(before), client = await currentClient(), request = await pendingFrom(run);
  const pending = await api("/api/password-broker"); assert(pending.requests.some((value: any) => value.id === request && value.client_id === client && value.status === "pending"));
  if (mode === "approved_before_status_cancel") {
   await approve(request); const approved = await api("/api/password-broker"); assert(approved.sessions.some((session: any) => session.client_id === client), "Owner approval must have created a real browser job before cancellation");
   assert(!approved.audit.some((entry: any) => entry.action === "status" && entry.request_id === request), "Waiting agent must never have polled status");
  }
  const start = Date.now(); run.child.kill("SIGTERM"); assert.notEqual(await run.completion, 0); const cancellationMs = Date.now() - start; assert(cancellationMs < 25000);
  const trusted = receipt(run.output(), inspected.id); assert.equal(trusted.cancelled, true); await removed(inspected.id); const lifecycle = await revoked(client, mode);
  launches.push({ kind: mode, container: inspected.id, request_id: request, status_polls_by_agent: 0, cancellation_ms: cancellationMs, lifecycle, host_receipt: trusted, output_sha256: sha(run.output().stderr) });
 }
 {
  const before = await containers(), state = await api("/api/password-broker"), known = new Set(state.audit.filter((entry: any) => entry.action === "connect").map((entry: any) => entry.request_id)), code = await pair();
  // A private regular file used as TMPDIR deterministically fails ownership-directory creation after pairing.
  const run = launch(code, "raise RuntimeError('must never start')", { TMPDIR: canaryPath, TMP: canaryPath, TEMP: canaryPath }); assert.notEqual(await run.completion, 0);
  const failed = await api("/api/password-broker"), connected = failed.audit.filter((entry: any) => entry.action === "connect" && entry.result === "ok" && !known.has(entry.request_id)); assert.equal(connected.length, 1, "Pre-start failure must occur after successful pairing");
  assert.deepEqual(await containers(), before, "Pre-start failure must not create a container"); const lifecycle = await revoked(connected[0].request_id, "post-pairing pre-create failure");
  launches.push({ kind: "post_pairing_pre_create_failure", lifecycle, container_created: false, fault: "synthetic regular-file TMPDIR", output_sha256: sha(run.output().stderr) });
 }
 const exposed = launches.map(row => JSON.stringify(row)).join("\n"); for (const secret of [master, username, password, cookie, canary, ownerToken, code]) assert(!exposed.includes(secret), "Secret exposed in recorded agent/trusted output"); check("captured agent projections and trusted receipts contain no synthetic credentials/cookies/tokens/pairing code");
 assert.deepEqual(errors, []); assert.deepEqual(await hashSources(), sourceHashes); assert.equal(sha(await readFile(binary)), binaryHash); sourceBindingsVerified = true; check("browser has no page errors and acceptance remains source/binary bound");
 } else { assert.deepEqual(errors, []); assert.equal(sha(await readFile(binary)), binaryHash); check("stderr backpressure subset completes with unchanged host binary; full integrated acceptance was not run"); }
} catch (error) { errors.push(String(error)); console.error(String(error)); process.exitCode = 1; }
finally {
 for (const child of active) child.kill("SIGTERM"); await delay(300);
 for (const child of active) child.kill("SIGKILL");
 for (const id of ownedContainers) await docker(["rm", "-f", id], true);
 await browser?.close(); if (server && server.exitCode === null) { server.kill("SIGTERM"); await until(async () => server!.exitCode !== null, Boolean, 5).catch(() => server!.kill("SIGKILL")); } fixture?.stop(true);
 await mkdir(dirname(report), { recursive: true }); await writeFile(report, JSON.stringify({ pass: !process.exitCode, acceptance_scope: backpressureOnly ? "host_stderr_backpressure_subset" : "full_sandbox_browser", full_integration_pass: !process.exitCode && !backpressureOnly, source_bindings_verified_at_end: sourceBindingsVerified, synthetic_only: true, host_os: { platform: hostPlatform(), release: hostRelease() }, docker_linux_kernel: dockerFacts?.KernelVersion, docker_os: dockerFacts?.OperatingSystem, image: imageFacts?.Id, image_architecture: imageFacts?.Architecture, binary, binary_sha256: binaryHash, source_sha256: sourceHashes, native_windows_security_verified: false, cases, errors, launches, login_posts: loginPosts, server_output: process.exitCode ? serverOutput : undefined }, null, 2) + "\n"); await rm(directory, { recursive: true, force: true });
 console.log(JSON.stringify({ pass: !process.exitCode, cases: cases.length, report }));
}
