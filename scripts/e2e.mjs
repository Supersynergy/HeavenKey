import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm, stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const root = resolve(".");
const evidence = join(root, "docs/evidence");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(tmpdir(), "uac-sim-"));
let bootstrapToken;
const port = 18241;
const origin = `http://localhost:${port}`;
let server, browser;
const cases = [];
const actors = [];
let fatalError;
const started = performance.now();
async function test(name, action) {
  const start = performance.now();
  try { await action(); cases.push({ name, pass: true, elapsed_ms: Math.round(performance.now()-start) }); console.log(`PASS ${name}`); }
  catch (e) { cases.push({ name, pass: false, error: e.message }); throw e; }
}
async function startServer() {
  server = spawn(join(root,"target/debug/uac-api"), [], { cwd:root, env:{ ...process.env,UAC_PORT:String(port),UAC_DATA:data }, stdio:["ignore","pipe","pipe"] });
  let output = "";
  let spawnError;
  server.on("error", error => { spawnError=error; });
  server.stdout.on("data", d => output += d); server.stderr.on("data", d => output += d);
  const end = Date.now()+15000;
  while (Date.now()<end) {
    if (spawnError) throw new Error(`server spawn failed: ${spawnError.message}`);
    if (server.exitCode !== null) throw new Error(`server exited: ${output}`);
    try { if ((await fetch(`${origin}/health`,{ signal:AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r,100));
  }
  throw new Error(`server startup timeout: ${output}`);
}
async function stopServer() {
  if (!server || !server.pid || server.exitCode !== null) return;
  server.kill("SIGINT");
  const end=Date.now()+5000;
  while(server.exitCode===null && Date.now()<end) await new Promise(r=>setTimeout(r,50));
  if(server.exitCode===null) {
    server.kill("SIGKILL");
    const killedEnd=Date.now()+5000;
    while(server.exitCode===null && Date.now()<killedEnd) await new Promise(r=>setTimeout(r,50));
    if(server.exitCode===null) throw new Error("server shutdown timeout");
  }
}
async function actor(name) {
  const context=await browser.newContext();
  const page=await context.newPage();
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  const cdp=await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const {authenticatorId}=await cdp.send("WebAuthn.addVirtualAuthenticator",{ options:{ protocol:"ctap2",ctap2Version:"ctap2_1",transport:"internal",hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true } });
  await page.goto(origin);
  await page.waitForFunction(()=>document.documentElement.dataset.ready==="true",null,{timeout:10000});
  await page.locator("#name").fill(name);
  const a={name,context,page,cdp,authenticatorId,errors};actors.push(a);return a;
}
async function post(actor,path,body,session) {
  return actor.page.evaluate(async ({path,body,session})=>{
    const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json",...(session?{Authorization:`Bearer ${session}`}:{})},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  },{path,body,session});
}
async function login(a) {
  const response=a.page.waitForResponse(r=>r.url().endsWith("/api/auth/finish"));
  await a.page.locator("#login").click();
  const r=await response; assert.equal(r.status(),200);
  const value=await r.json();
  await a.page.waitForFunction(()=>document.querySelector("#status").textContent.includes("Sitzung ist aktiv"));
  return value.session;
}
async function registration(a) {
  const response=a.page.waitForResponse(r=>r.url().endsWith("/api/register/finish"));
  await a.page.locator("#register").click();
  const r=await Promise.race([response,a.page.waitForFunction(()=>document.querySelector("#status").dataset.error==="true").then(async()=>{throw new Error(await a.page.locator("#status").innerText());})]);assert.equal(r.status(),200);
  return r.json();
}
async function enrollment(a,token) {
  const start=await post(a,"/api/register/start",{name:a.name,bootstrap_token:token});
  assert.equal(start.status,200,JSON.stringify(start.body));
  const credential=await a.page.evaluate(async options=>{
    const dec=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
    options.publicKey.challenge=dec(options.publicKey.challenge);
    options.publicKey.user.id=dec(options.publicKey.user.id);
    return (await navigator.credentials.create(options)).toJSON();
  },start.body.options);
  return {request_id:start.body.request_id,credential};
}
async function assertion(a,invocation=null) {
  const start=await post(a,"/api/auth/start",{name:a.name,invocation});
  assert.equal(start.status,200,JSON.stringify(start.body));
  const credential=await a.page.evaluate(async (options)=>{
    const dec=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
    options.publicKey.challenge=dec(options.publicKey.challenge);
    for(const c of options.publicKey.allowCredentials) c.id=dec(c.id);
    const credential=await navigator.credentials.get(options);
    return credential.toJSON();
  },start.body.options);
  return {request_id:start.body.request_id,credential,invocation};
}
function invoke(grant) { return {grant:grant.grant,resource:"urn:uac:lab:document",action:"Read",arguments:{document:"overview"}}; }
async function resign(a,payload,change) {
  const {credentials}=await a.cdp.send("WebAuthn.getCredentials",{authenticatorId:a.authenticatorId});
  const own=credentials.find(c=>Buffer.from(c.credentialId,"base64").toString("base64url")===payload.credential.rawId);
  assert.ok(own,"virtual credential export available");
  const response=payload.credential.response;
  let client=JSON.parse(Buffer.from(response.clientDataJSON,"base64url").toString());
  let auth=Buffer.from(response.authenticatorData,"base64url");
  change(client,auth);
  const clientBytes=Buffer.from(JSON.stringify(client));
  response.clientDataJSON=clientBytes.toString("base64url");
  response.authenticatorData=auth.toString("base64url");
  const key=createPrivateKey({key:Buffer.from(own.privateKey,"base64"),format:"der",type:"pkcs8"});
  response.signature=sign("sha256",Buffer.concat([auth,createHash("sha256").update(clientBytes).digest()]),key).toString("base64url");
  return payload;
}
try {
  await startServer();
  bootstrapToken=(await readFile(join(data,"owner-bootstrap.txt"),"utf8")).trim();
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==="darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"),headless:true,args:["--disable-background-networking"],timeout:20000});
  const owner=await actor("owner"),guest=await actor("guest"),foreign=await actor("foreign");
  let ownerSession,guestSession,grant;
  await test("first guest enrollment does not claim ownership",async()=>assert.equal((await registration(guest)).owner,false));
  await test("reserved owner name requires bootstrap",async()=>assert.equal((await post(owner,"/api/register/start",{name:"owner"})).status,403));
  await test("invalid bootstrap cannot claim ownership",async()=>assert.equal((await post(owner,"/api/register/start",{name:"owner",bootstrap_token:randomBytes(32).toString("base64url")})).status,403));
  const contender=await actor("contender");
  const competingEnrollment=await enrollment(contender,bootstrapToken);
  await owner.page.locator("#bootstrap").fill(bootstrapToken);
  await test("browser owner passkey registration with operator bootstrap",async()=>{assert.equal((await registration(owner)).owner,true);assert.equal(await owner.page.locator("#bootstrap").inputValue(),"");});
  await test("pending competing enrollment cannot create another owner",async()=>assert.equal((await post(contender,"/api/register/finish",competingEnrollment)).status,403));
  await test("consumed bootstrap cannot start another owner enrollment",async()=>assert.equal((await post(contender,"/api/register/start",{name:"contender",bootstrap_token:bootstrapToken})).status,403));
  await test("bootstrap file remains operator-only",async()=>assert.equal((await stat(join(data,"owner-bootstrap.txt"))).mode & 0o077,0));
  await test("browser foreign holder registration",async()=>assert.equal((await registration(foreign)).owner,false));
  await test("browser owner authentication",async()=>{ownerSession=await login(owner);assert.ok(ownerSession);});
  await test("browser guest authentication",async()=>{guestSession=await login(guest);assert.ok(guestSession);});
  await test("owner grant issuance through UI",async()=>{
    const response=owner.page.waitForResponse(r=>r.url().endsWith("/api/grants") && r.request().method()==="POST");
    await owner.page.locator("#issue").click();const r=await response;assert.equal(r.status(),200);grant=await r.json();
    assert.equal(grant.guest,"guest");
  });
  await test("guest grant invocation through UI",async()=>{
    await guest.page.locator("#refresh").click();
    await guest.page.locator(".grant button").first().waitFor();
    const response=guest.page.waitForResponse(r=>r.url().endsWith("/api/auth/finish"));
    await guest.page.locator(".grant button").first().click();const r=await response;assert.equal(r.status(),200);assert.equal((await r.json()).authorized,true);
    await guest.page.waitForFunction(()=>document.querySelector("#result").textContent.includes('"authorized": true'));
    await guest.page.screenshot({path:join(evidence,"browser-success.png"),fullPage:true});
  });
  await test("copied token without session cannot issue grants",async()=>assert.equal((await post(guest,"/api/grants",{guest_name:"guest",ttl_seconds:300})).status,401));
  await test("guest cannot issue grants",async()=>assert.equal((await post(guest,"/api/grants",{guest_name:"foreign",ttl_seconds:300},guestSession)).status,403));
  await test("foreign holder denied before ceremony",async()=>assert.equal((await post(foreign,"/api/auth/start",{name:"foreign",invocation:invoke(grant)})).status,403));
  await test("write escalation denied",async()=>{const i=invoke(grant);i.action="Write";assert.equal((await post(guest,"/api/auth/start",{name:"guest",invocation:i})).status,403);});
  await test("foreign resource denied",async()=>{const i=invoke(grant);i.resource="urn:uac:other";assert.equal((await post(guest,"/api/auth/start",{name:"guest",invocation:i})).status,403);});
  await test("modified signed grant denied",async()=>{const i=invoke(structuredClone(grant));i.grant.body.expires_at+=999;assert.equal((await post(guest,"/api/auth/start",{name:"guest",invocation:i})).status,403);});
  await test("bound invocation arguments cannot change",async()=>{const p=await assertion(guest,invoke(grant));p.invocation.arguments.document="different";assert.equal((await post(guest,"/api/auth/finish",p)).status,403);});
  await test("bound invocation cannot become login",async()=>{const p=await assertion(guest,invoke(grant));p.invocation=null;assert.equal((await post(guest,"/api/auth/finish",p)).status,403);});
  for(const [name,change] of [
    ["valid signature with wrong origin",(client)=>{client.origin="https://attacker.invalid";}],
    ["valid signature with wrong challenge",(client)=>{client.challenge=Buffer.alloc(32,3).toString("base64url");}],
    ["valid signature with wrong RP hash",(_client,auth)=>{createHash("sha256").update("attacker.invalid").digest().copy(auth,0);}],
    ["valid signature without user verification",(_client,auth)=>{auth[32]&=~4;}],
    ["valid signature with rolled-back counter",(_client,auth)=>{auth.writeUInt32BE(0,33);}],
  ]) await test(name,async()=>{const p=await resign(guest,await assertion(guest,invoke(grant)),change);assert.equal((await post(guest,"/api/auth/finish",p)).status,401);});
  await test("tampered authenticator signature rejected",async()=>{const p=await assertion(guest,invoke(grant));p.credential.response.signature=Buffer.alloc(70,0).toString("base64url");assert.equal((await post(guest,"/api/auth/finish",p)).status,401);});
  let accepted;
  await test("valid fresh assertion accepted",async()=>{accepted=await assertion(guest,invoke(grant));assert.equal((await post(guest,"/api/auth/finish",accepted)).status,200);});
  await test("assertion replay rejected",async()=>assert.equal((await post(guest,"/api/auth/finish",accepted)).status,403));
  await test("parallel duplicate invocation executes once",async()=>{const p=await assertion(guest,invoke(grant));const r=await Promise.all([post(guest,"/api/auth/finish",p),post(guest,"/api/auth/finish",p)]);assert.deepEqual(r.map(x=>x.status).sort(),[200,403]);});
  await test("guest cannot revoke",async()=>assert.equal((await post(guest,"/api/grants/revoke",{id:grant.id},guestSession)).status,403));
  const pending=await assertion(guest,invoke(grant));
  await test("owner revocation committed",async()=>{const r=await post(owner,"/api/grants/revoke",{id:grant.id},ownerSession);assert.equal(r.status,200);assert.equal(r.body.revoked,true);});
  await test("revoked grant rejects already started ceremony",async()=>assert.equal((await post(guest,"/api/auth/finish",pending)).status,403));
  await test("revoked grant cannot start new invocation",async()=>assert.equal((await post(guest,"/api/auth/start",{name:"guest",invocation:invoke(grant)})).status,403));
  await test("duplicate name registration rejected",async()=>assert.equal((await post(guest,"/api/register/start",{name:"guest"})).status,409));
  await test("HTTP origin CSRF guard",async()=>{const r=await fetch(`${origin}/api/auth/start`,{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://attacker.invalid"},body:JSON.stringify({name:"guest",invocation:null})});assert.equal(r.status,403);});
  await test("expired grant denied",async()=>{const r=await post(owner,"/api/grants",{guest_name:"guest",ttl_seconds:1},ownerSession);assert.equal(r.status,200);await new Promise(r=>setTimeout(r,1200));assert.equal((await post(guest,"/api/auth/start",{name:"guest",invocation:invoke(r.body)})).status,403);});
  await stopServer();await startServer();
  await test("bootstrap stays consumed after server restart",async()=>assert.equal((await post(contender,"/api/register/start",{name:"contender",bootstrap_token:bootstrapToken})).status,403));
  await test("enrolled credentials authenticate after server restart",async()=>{await guest.page.reload();await guest.page.locator("#name").fill("guest");guestSession=await login(guest);assert.ok(guestSession);});
  await test("revocation survives server restart",async()=>assert.equal((await post(guest,"/api/auth/start",{name:"guest",invocation:invoke(grant)})).status,403));
  await test("replay rejected after server restart",async()=>assert.equal((await post(guest,"/api/auth/finish",accepted)).status,403));
  await guest.page.locator("#refresh").click();
  await guest.page.waitForFunction(()=>document.querySelector("#grants").textContent.includes("Widerrufen"));
  await guest.page.screenshot({path:join(evidence,"browser-revoked.png"),fullPage:true});
  const viewport={width:390,height:844};await guest.page.setViewportSize(viewport);
  await test("mobile width has no horizontal overflow",async()=>assert.ok(await guest.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)));
  await guest.page.screenshot({path:join(evidence,"browser-mobile.png"),fullPage:true});
} catch(e) {
  fatalError=e.message;
  console.error(e.stack);process.exitCode=1;
  const diagnostic=[];
  for(const a of actors) {
    diagnostic.push({actor:a.name,status:await a.page.locator("#status").innerText(),errors:a.errors});
    await a.page.screenshot({path:join(evidence,`failure-${a.name}.png`),fullPage:true});
  }
  await writeFile(join(evidence,"failure-diagnostic.json"),JSON.stringify(diagnostic,null,2)+"\n");
}
finally {
  await browser?.close();await stopServer();
  const report={completed:!fatalError,fatal_error:fatalError,mode:"virtual CTAP2 authenticators; real navigator.credentials + Rust verification",hardware:"deferred by user",total:cases.length,passed:cases.filter(x=>x.pass).length,failed:cases.filter(x=>!x.pass).length,cases,elapsed_seconds:Math.round((performance.now()-started)/100)/10};
  await writeFile(join(evidence,"e2e.json"),JSON.stringify(report,null,2)+"\n");
  await rm(data,{recursive:true,force:true});
  console.log(JSON.stringify({total:report.total,passed:report.passed,failed:report.failed,elapsed_seconds:report.elapsed_seconds}));
}
