import { spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm, stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { verifyChain as referenceVerifyChain, id as referenceId, decodeSigned as referenceDecode } from "./delegation-reference.mjs";

const root = resolve(".");
const evidence = join(root, "docs/evidence");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(tmpdir(), "uac-sim-"));
let serverData = data;
let legacyData;
let bootstrapToken;
const port = 18241;
const origin = `http://localhost:${port}`;
let server, browser;
// Synthetic store key for the ephemeral e2e data dir (never a real credential).
const storeKey = "e2e".padEnd(64, "0").replace(/[^0-9a-f]/g, "e");
function storeQuery(sql, params = []) {
  const binary = resolve(process.env.HEAVENKEY_BINARY || join(root,"target/debug/uac-api"));
  const prefix = JSON.parse(process.env.HEAVENKEY_BINARY_PREFIX_JSON || "[]");
  const queryPath = process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? `Z:${serverData.replaceAll("/", "\\")}` : serverData;
  const protectionPath = join(tmpdir(), `heavenkey-protection-${serverData.split("/").pop()}.key`);
  const keyPath = process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? `Z:${protectionPath.replaceAll("/", "\\")}` : protectionPath;
  const r = spawnSync(prefix[0] || binary, [...prefix.slice(1), ...(prefix.length ? [binary] : []), "--store-query", JSON.stringify({ sql, params })], { cwd:process.env.HEAVENKEY_SERVER_CWD || root, env:{ ...process.env,UAC_DATA:queryPath,UAC_STORE_KEY:storeKey,HEAVENKEY_KEY_FILE:keyPath }, encoding:"utf8", timeout:15000 });
  if (r.status !== 0) throw new Error(`store query failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}
const cases = [];
const actors = [];
const protectionFiles = new Set();
let fatalError;
const started = performance.now();
async function test(name, action) {
  const start = performance.now();
  try { await action(); cases.push({ name, pass: true, elapsed_ms: Math.round(performance.now()-start) }); console.log(`PASS ${name}`); }
  catch (e) { cases.push({ name, pass: false, error: e.message }); throw e; }
}
async function startServer() {
  const binary = resolve(process.env.HEAVENKEY_BINARY || join(root,"target/debug/uac-api"));
  const prefix = JSON.parse(process.env.HEAVENKEY_BINARY_PREFIX_JSON || "[]");
  if (!Array.isArray(prefix) || prefix.some(value => typeof value !== "string")) throw new Error("invalid binary prefix");
  try { await stat(binary); }
  catch (error) { throw new Error(`server spawn failed: ${error.message}`); }
  const serverPath = process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? `Z:${serverData.replaceAll("/", "\\")}` : serverData;
  const protectionPath = join(tmpdir(), `heavenkey-protection-${serverData.split("/").pop()}.key`);
  try { await stat(protectionPath); } catch { await writeFile(protectionPath, randomBytes(32), { mode: 0o600 }); }
  protectionFiles.add(protectionPath);
  const keyPath = process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? `Z:${protectionPath.replaceAll("/", "\\")}` : protectionPath;
  server = spawn(prefix[0] || binary, prefix.length ? [...prefix.slice(1),binary] : [], { cwd:process.env.HEAVENKEY_SERVER_CWD || root, env:{ ...process.env,UAC_PORT:String(port),UAC_DATA:serverPath,UAC_STORE_KEY:storeKey,HEAVENKEY_KEY_FILE:keyPath,HEAVENKEY_ORIGIN:origin,HEAVENKEY_RP_ID:"localhost" }, stdio:["ignore","pipe","pipe"] });
  let output = "";
  let spawnError;
  server.on("error", error => { spawnError=error; });
  server.stdout.on("data", d => output += d); server.stderr.on("data", d => output += d);
  const startTimeout = Number(process.env.HEAVENKEY_SERVER_START_TIMEOUT_MS || 15000);
  if (!Number.isFinite(startTimeout) || startTimeout < 1000 || startTimeout > 60000) throw new Error("invalid server startup timeout");
  const end = Date.now()+startTimeout;
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
  const {authenticatorId}=await cdp.send("WebAuthn.addVirtualAuthenticator",{ options:authenticatorOptions });
  await page.goto(origin);
  await page.waitForFunction(()=>document.documentElement.dataset.ready==="true",null,{timeout:10000});
  await page.locator("#name").fill(name);
  const a={name,context,page,cdp,authenticatorId,errors,deviceName:"original",devices:new Map()};actors.push(a);return a;
}
const authenticatorOptions={protocol:"ctap2",ctap2Version:"ctap2_1",transport:"internal",hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true};
async function selectDevice(a,name) {
  if(a.deviceName===name) return;
  const {credentials}=await a.cdp.send("WebAuthn.getCredentials",{authenticatorId:a.authenticatorId});
  a.devices.set(a.deviceName,credentials);
  await a.cdp.send("WebAuthn.removeVirtualAuthenticator",{authenticatorId:a.authenticatorId});
  const {authenticatorId}=await a.cdp.send("WebAuthn.addVirtualAuthenticator",{options:authenticatorOptions});
  a.authenticatorId=authenticatorId;a.deviceName=name;
  for(const credential of a.devices.get(name) || []) await a.cdp.send("WebAuthn.addCredential",{authenticatorId,credential:{...credential,rpId:new URL(origin).hostname}});
}
async function get(a,path,session) {
  return a.page.evaluate(async ({path,session})=>{
    const r=await fetch(path,{headers:session?{Authorization:`Bearer ${session}`}:{}});
    return {status:r.status,body:r.headers.get("content-type")?.includes("application/json")?await r.json():{error:await r.text()}};
  },{path,session});
}
async function post(actor,path,body,session) {
  return actor.page.evaluate(async ({path,body,session})=>{
    const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json",...(session?{Authorization:`Bearer ${session}`}:{})},body:JSON.stringify(body)});
    return {status:r.status,body:r.headers.get("content-type")?.includes("application/json")?await r.json():{error:await r.text()}};
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
  const credential=await creation(a,start.body.options);
  return {request_id:start.body.request_id,credential};
}
async function creation(a,options) {
  return a.page.evaluate(async options=>{
    const dec=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
    options.publicKey.challenge=dec(options.publicKey.challenge);
    options.publicKey.user.id=dec(options.publicKey.user.id);
    for(const c of options.publicKey.excludeCredentials || []) c.id=dec(c.id);
    return (await navigator.credentials.create(options)).toJSON();
  },options);
}
async function additionalEnrollment(a,session,label,device) {
  const start=await approvedPost(a,"/api/credentials/start",{label},session);
  assert.equal(start.status,200,JSON.stringify(start.body));
  await selectDevice(a,device);
  return {request_id:start.body.request_id,credential:await creation(a,start.body.options)};
}
async function managementAssertion(a,session,management) {
  const start=await post(a,"/api/auth/start",{name:a.name,management},session);
  assert.equal(start.status,200,JSON.stringify(start.body));
  return {request_id:start.body.request_id,credential:await authentication(a,start.body.options),management};
}
async function approval(a,session,management) {
  const r=await post(a,"/api/auth/finish",await managementAssertion(a,session,management),session);
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.approved,true);assert.equal(r.body.expires_in,60);assert.equal("session" in r.body,false);
  return r.body.approval_id;
}
function managementFor(path,body) {
  const kinds={"/api/credentials/start":"credential_add","/api/credentials/revoke":"credential_revoke","/api/grants":"grant_create","/api/grants/revoke":"grant_revoke","/api/delegations":"delegation_create","/api/delegations/delegate":"delegation_delegate","/api/delegations/revoke":"delegation_revoke"};
  assert.ok(kinds[path],"known management mutation");return {kind:kinds[path],...body};
}
async function approvedPost(a,path,body,session) {
  const approval_id=await approval(a,session,managementFor(path,body));
  return post(a,path,{...body,approval_id},session);
}
async function confirmUI(a,title,target) {
  await a.page.locator("#management-dialog").waitFor({state:"visible"});
  assert.equal(await a.page.locator("#management-title").innerText(),title);
  assert.ok((await a.page.locator("#management-target").innerText()).includes(target));
  await a.page.locator("#management-confirm").click();
}
async function assertion(a,invocation=null) {
  const start=await post(a,"/api/auth/start",{name:a.name,invocation});
  assert.equal(start.status,200,JSON.stringify(start.body));
  const credential=await authentication(a,start.body.options);
  return {request_id:start.body.request_id,credential,invocation};
}
async function authentication(a,options) {
  return a.page.evaluate(async (options)=>{
    const dec=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
    options.publicKey.challenge=dec(options.publicKey.challenge);
    for(const c of options.publicKey.allowCredentials) c.id=dec(c.id);
    const credential=await navigator.credentials.get(options);
    return credential.toJSON();
  },options);
}
function delegatedInvocation(grant) { return {id:grant.id,resource:"urn:uac:lab:document",action:"Read",arguments:{document:"overview"}}; }
async function delegatedAssertion(a,grant,invocation=delegatedInvocation(grant)) {
  const start=await post(a,"/api/auth/start",{name:a.name,delegation_invocation:invocation});assert.equal(start.status,200,JSON.stringify(start.body));
  return {request_id:start.body.request_id,credential:await authentication(a,start.body.options),delegation_invocation:invocation};
}
async function uiDelegate(a,parent,recipient,ttl,budget) {
  await a.page.locator("#refresh").click();
  const form=a.page.locator(`.delegation[data-id="${parent.id}"] form`);await form.locator('[name="guest"]').fill(recipient);await form.locator('[name="ttl"]').fill(String(ttl));await form.locator('[name="budget"]').fill(String(budget));
  const response=a.page.waitForResponse(r=>r.url().endsWith("/api/delegations/delegate"));await form.locator("button").click();
  await a.page.locator("#management-dialog").waitFor({state:"visible"});const target=await a.page.locator("#management-target").innerText();
  for(const expected of [`Empfänger: ${recipient}`,`Gültigkeit: ${ttl} Sekunden`,`Erlaubte Weitergaben: ${budget}`]) assert.ok(target.includes(expected));
  await confirmUI(a,"Zugang weitergeben",parent.id);const r=await response;assert.equal(r.status(),200);return r.json();
}
function checkAPIChain(result,trustedIssuer) {
  assert.equal(result.id,Buffer.from(referenceId(result.grant),"hex").toString("base64url"));
  assert.equal(referenceId(result.grant),referenceId(result.chain.at(-1)));
  const leaf=result.chain.at(-1).body;
  assert.equal(referenceVerifyChain(result.chain,{issuer:trustedIssuer,audience:leaf.audience,resource:leaf.resource,action:"Read",now:Math.floor(Date.now()/1000)}).allowed,true);
  for(const grant of result.chain) assert.equal(referenceId(referenceDecode(JSON.stringify({signature:grant.signature,body:Object.fromEntries(Object.entries(grant.body).reverse())},null,2))),referenceId(grant));
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
  const { chromium } = await import("playwright-core");
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==="darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"),headless:true,args:["--disable-background-networking"],timeout:60000});
  const [owner,guest,foreign]=await Promise.all(["owner","guest","foreign"].map(actor));
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
  await test("bootstrap storage remains operator-only",async()=>{
    const path = process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? data : join(data,"owner-bootstrap.txt");
    assert.equal((await stat(path)).mode & 0o077,0);
  });
  await test("browser foreign holder registration",async()=>assert.equal((await registration(foreign)).owner,false));
  await test("browser owner authentication",async()=>{ownerSession=await login(owner);assert.ok(ownerSession);});
  await test("browser guest authentication",async()=>{guestSession=await login(guest);assert.ok(guestSession);});
  await test("owner grant issuance through UI",async()=>{
    const response=owner.page.waitForResponse(r=>r.url().endsWith("/api/grants") && r.request().method()==="POST");
    await owner.page.locator("#issue").click();await confirmUI(owner,"Zugang vergeben","Gültigkeit: 300 Sekunden");const r=await response;assert.equal(r.status(),200);grant=await r.json();
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
  await test("owner revocation committed",async()=>{const r=await approvedPost(owner,"/api/grants/revoke",{id:grant.id},ownerSession);assert.equal(r.status,200);assert.equal(r.body.revoked,true);});
  await test("revoked grant rejects already started ceremony",async()=>assert.equal((await post(guest,"/api/auth/finish",pending)).status,403));
  await test("revoked grant cannot start new invocation",async()=>assert.equal((await post(guest,"/api/auth/start",{name:"guest",invocation:invoke(grant)})).status,403));
  await test("duplicate name registration rejected",async()=>assert.equal((await post(guest,"/api/register/start",{name:"guest"})).status,409));
  await test("HTTP origin CSRF guard",async()=>{const r=await fetch(`${origin}/api/auth/start`,{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://attacker.invalid"},body:JSON.stringify({name:"guest",invocation:null})});assert.equal(r.status,403);});
  await test("expired grant denied",async()=>{const r=await approvedPost(owner,"/api/grants",{guest_name:"guest",ttl_seconds:1},ownerSession);assert.equal(r.status,200);await new Promise(r=>setTimeout(r,1200));assert.equal((await post(guest,"/api/auth/start",{name:"guest",invocation:invoke(r.body)})).status,403);});
  const approvalBeforeRestart=await approval(owner,ownerSession,{kind:"grant_create",guest_name:"guest",ttl_seconds:300});
  await stopServer();await startServer();
  await test("server restart discards outstanding action approvals",async()=>{
    ownerSession=await login(owner);
    const r=await post(owner,"/api/grants",{guest_name:"guest",ttl_seconds:300,approval_id:approvalBeforeRestart},ownerSession);assert.equal(r.status,403);assert.equal(r.body.error,"approval_missing");
  });
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
  await guest.page.setViewportSize({width:1280,height:900});
  ownerSession=await login(owner);
  const foreignSession=await login(foreign);
  let initialId,secondId,secondGrant,otherGuestSession,mutationSession;
  await test("credential list is scoped and exposes only public metadata",async()=>{
    const r=await get(guest,"/api/credentials",guestSession);assert.equal(r.status,200);assert.equal(r.body.credentials.length,1);
    const c=r.body.credentials[0];initialId=c.id;assert.equal(r.body.current_credential_id,initialId);assert.equal(c.active,true);
    assert.deepEqual(Object.keys(c).sort(),["active","created","id","label"]);assert.ok(Number.isInteger(c.created));
    const f=await get(foreign,"/api/credentials",foreignSession);assert.equal(f.status,200);assert.equal(f.body.credentials.length,1);assert.notEqual(f.body.credentials[0].id,initialId);
  });
  await test("credential listing and enrollment require a session",async()=>{
    assert.equal((await get(guest,"/api/credentials")).status,401);
    assert.equal((await post(guest,"/api/credentials/start",{label:"Spare key"})).status,401);
  });
  await test("last active passkey cannot be revoked through UI or API",async()=>{
    await guest.page.locator("#refresh").click();
    assert.equal(await guest.page.locator(".credential button").isDisabled(),true);
    assert.equal((await approvedPost(guest,"/api/credentials/revoke",{id:initialId},guestSession)).status,409);
    assert.equal((await get(guest,"/api/credentials",guestSession)).body.credentials[0].active,true);
  });
  await test("credential labels enforce nonempty 48-character bound",async()=>{
    for(const label of [" ","x".repeat(49)]) assert.equal((await post(guest,"/api/credentials/start",{label},guestSession)).status,400);
  });
  await test("credential enrollment cannot finish in another account session",async()=>{
    const p=await additionalEnrollment(guest,guestSession,"Foreign binding test","foreign-binding");
    assert.equal((await post(foreign,"/api/credentials/finish",p,foreignSession)).status,403);
    assert.equal((await get(guest,"/api/credentials",guestSession)).body.credentials.length,1);
    await selectDevice(guest,"original");
  });
  await test("credential enrollment is bound to the initiating same-account session",async()=>{
    const auth=await post(guest,"/api/auth/finish",await assertion(guest));assert.equal(auth.status,200);otherGuestSession=auth.body.session;
    const p=await additionalEnrollment(guest,guestSession,"Session binding test","session-binding");
    assert.equal((await post(guest,"/api/credentials/finish",p,otherGuestSession)).status,403);
    assert.equal((await get(guest,"/api/credentials",guestSession)).body.credentials.length,1);
    await selectDevice(guest,"original");
  });
  await test("browser enrolls second passkey on a separate device in the same account",async()=>{
    const grantResponse=await approvedPost(owner,"/api/grants",{guest_name:"guest",ttl_seconds:300},ownerSession);assert.equal(grantResponse.status,200);secondGrant=grantResponse.body;
    await guest.page.route("**/api/credentials/start",async route=>{await selectDevice(guest,"secondary");await route.continue();},{times:1});
    await guest.page.locator("#credential-label").fill("Ersatzschlüssel");
    const fresh=guest.page.waitForResponse(r=>r.url().endsWith("/api/auth/finish"));
    const finish=guest.page.waitForResponse(r=>r.url().endsWith("/api/credentials/finish"));
    await guest.page.locator("#credential-add").click();await confirmUI(guest,"Passkey hinzufügen","Ersatzschlüssel");
    const r=await finish;assert.equal(r.status(),200);const value=await r.json();secondId=value.id;assert.notEqual(secondId,initialId);assert.equal(value.label,"Ersatzschlüssel");
    assert.equal((await (await fresh).json()).approved,true);
    await guest.page.waitForFunction(()=>document.querySelector("#status").textContent.includes("hinzugefügt"));
    const listed=await get(guest,"/api/credentials",guestSession);assert.equal(listed.body.credentials.length,2);assert.equal(listed.body.current_credential_id,initialId);
    assert.equal(await guest.page.locator('.credential[data-active="true"]').count(),2);assert.equal(await guest.page.locator("#credential-label").inputValue(),"");
  });
  await test("second device authenticates after the original device is removed",async()=>{
    assert.equal(guest.deviceName,"secondary");guestSession=await login(guest);
    const r=await get(guest,"/api/credentials",guestSession);assert.equal(r.body.current_credential_id,secondId);
  });
  await test("second passkey invokes an existing same-account grant through the browser",async()=>{
    await guest.page.locator("#refresh").click();
    const response=guest.page.waitForResponse(r=>r.url().endsWith("/api/auth/finish"));
    await guest.page.locator(`.grant[data-id="${secondGrant.id}"]`).getByRole("button", { name: "Dokument lesen", exact: true }).click();assert.equal((await response).status(),200);
    await guest.page.waitForFunction(()=>document.querySelector("#result").textContent.includes('"authorized": true'));
    await guest.page.waitForFunction(()=>!document.querySelector("#credential-add").disabled);
    await guest.page.screenshot({path:join(evidence,"browser-credentials.png"),fullPage:true});
  });
  for(const [name,a,path,body,s] of [
    ["credential add",guest,"/api/credentials/start",{label:"Token-only spare"},guestSession],
    ["credential revoke",guest,"/api/credentials/revoke",{id:initialId},guestSession],
    ["grant create",owner,"/api/grants",{guest_name:"foreign",ttl_seconds:300},ownerSession],
    ["grant revoke",owner,"/api/grants/revoke",{id:secondGrant.id},ownerSession],
  ]) await test(`valid bearer alone cannot authorize ${name}`,async()=>{
    const r=await post(a,path,body,s);assert.equal(r.status,403);assert.equal(r.body.error,"approval_required");
  });
  const grantPurpose={kind:"grant_create",guest_name:"guest",ttl_seconds:300};
  await test("management ceremonies require a session and its exact account",async()=>{
    assert.equal((await post(owner,"/api/auth/start",{name:"owner",management:grantPurpose})).status,401);
    const r=await post(owner,"/api/auth/start",{name:"guest",management:grantPurpose},ownerSession);assert.equal(r.status,403);assert.equal(r.body.error,"management_user_mismatch");
  });
  await test("management rejects mixed purposes and unknown operation fields",async()=>{
    assert.equal((await post(owner,"/api/auth/start",{name:"owner",management:grantPurpose,invocation:invoke(secondGrant)},ownerSession)).status,400);
    for(const management of [{...grantPurpose,extra:true},{kind:"unknown"}]) assert.equal((await post(owner,"/api/auth/start",{name:"owner",management},ownerSession)).status,422);
  });
  await test("management approval cannot elevate a guest to owner",async()=>assert.equal((await post(guest,"/api/auth/start",{name:"guest",management:grantPurpose},guestSession)).status,403));
  await test("management assertion binds exact parameters and consumes a changed finish",async()=>{
    const p=await managementAssertion(owner,ownerSession,grantPurpose);
    const r=await post(owner,"/api/auth/finish",{...p,management:{...grantPurpose,ttl_seconds:301}},ownerSession);assert.equal(r.status,403);assert.equal(r.body.error,"management_changed");
    assert.equal((await post(owner,"/api/auth/finish",p,ownerSession)).status,403);
  });
  await test("management approval requires a valid authenticator signature",async()=>{
    const p=await managementAssertion(owner,ownerSession,grantPurpose);p.credential.response.signature=Buffer.alloc(70,0).toString("base64url");
    assert.equal((await post(owner,"/api/auth/finish",p,ownerSession)).status,401);
    assert.equal((await post(owner,"/api/auth/finish",p,ownerSession)).status,403);
  });
  const alternateOwner=await post(owner,"/api/auth/finish",await assertion(owner));assert.equal(alternateOwner.status,200);
  await test("management assertion is bound to the initiating same-account session",async()=>{
    const p=await managementAssertion(owner,ownerSession,grantPurpose);
    const r=await post(owner,"/api/auth/finish",p,alternateOwner.body.session);assert.equal(r.status,403);assert.equal(r.body.error,"management_session_changed");
    assert.equal((await post(owner,"/api/auth/finish",p,ownerSession)).status,403);
  });
  await test("management assertion cannot finish in another account",async()=>{
    const p=await managementAssertion(owner,ownerSession,grantPurpose);
    const r=await post(foreign,"/api/auth/finish",p,foreignSession);assert.equal(r.status,403);assert.equal(r.body.error,"management_session_changed");
  });
  for(const [name,a,path,approved,changed,s] of [
    ["credential label",guest,"/api/credentials/start",{label:"Approved label"},{label:"Changed label"},guestSession],
    ["credential target",guest,"/api/credentials/revoke",{id:initialId},{id:secondId},guestSession],
    ["grant recipient",owner,"/api/grants",{guest_name:"guest",ttl_seconds:300},{guest_name:"foreign",ttl_seconds:300},ownerSession],
    ["grant TTL",owner,"/api/grants",{guest_name:"guest",ttl_seconds:300},{guest_name:"guest",ttl_seconds:301},ownerSession],
    ["grant target",owner,"/api/grants/revoke",{id:secondGrant.id},{id:grant.id},ownerSession],
  ]) await test(`approval binds ${name} and mismatch burns the approval`,async()=>{
    const approval_id=await approval(a,s,managementFor(path,approved));
    const r=await post(a,path,{...changed,approval_id},s);assert.equal(r.status,403);assert.equal(r.body.error,"approval_mismatch");
    const retry=await post(a,path,{...approved,approval_id},s);assert.equal(retry.status,403);assert.equal(retry.body.error,"approval_missing");
  });
  await test("approval cannot be used for a different action kind",async()=>{
    const approval_id=await approval(guest,guestSession,{kind:"credential_add",label:"Kind binding"});
    const r=await post(guest,"/api/credentials/revoke",{id:initialId,approval_id},guestSession);assert.equal(r.status,403);assert.equal(r.body.error,"approval_mismatch");
  });
  for(const [name,a,s] of [["same-account session",guest,otherGuestSession],["other account",foreign,foreignSession]]) await test(`approval is bound to its ${name}`,async()=>{
    const label="Session-bound spare";const approval_id=await approval(guest,guestSession,{kind:"credential_add",label});
    const r=await post(a,"/api/credentials/start",{label,approval_id},s);assert.equal(r.status,403);assert.equal(r.body.error,"approval_mismatch");
    const retry=await post(guest,"/api/credentials/start",{label,approval_id},guestSession);assert.equal(retry.status,403);assert.equal(retry.body.error,"approval_missing");
  });
  await test("single-use approval rejects replay after a successful grant mutation",async()=>{
    const body={guest_name:"foreign",ttl_seconds:300};const approval_id=await approval(owner,ownerSession,managementFor("/api/grants",body));
    assert.equal((await post(owner,"/api/grants",{...body,approval_id},ownerSession)).status,200);
    const r=await post(owner,"/api/grants",{...body,approval_id},ownerSession);assert.equal(r.status,403);assert.equal(r.body.error,"approval_missing");
  });
  await test("parallel duplicate approval mutates exactly once",async()=>{
    const before=await get(owner,"/api/grants",ownerSession);const body={guest_name:"foreign",ttl_seconds:301};
    const approval_id=await approval(owner,ownerSession,managementFor("/api/grants",body));
    const results=await Promise.all([post(owner,"/api/grants",{...body,approval_id},ownerSession),post(owner,"/api/grants",{...body,approval_id},ownerSession)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,403]);assert.equal((await get(owner,"/api/grants",ownerSession)).body.grants.length,before.body.grants.length+1);
  });
  await test("enrollment accepts an approving active key distinct from the session key",async()=>{
    const backup=await additionalEnrollment(foreign,foreignSession,"Backup approver","foreign-backup");assert.equal((await post(foreign,"/api/credentials/finish",backup,foreignSession)).status,200);
    const another=await additionalEnrollment(foreign,foreignSession,"Approved by backup","foreign-third");assert.equal((await post(foreign,"/api/credentials/finish",another,foreignSession)).status,200);
    const r=await get(foreign,"/api/credentials",foreignSession);assert.equal(r.body.credentials.filter(c=>c.active).length,3);assert.notEqual(r.body.current_credential_id,backup.credential.rawId);
    await selectDevice(foreign,"original");
  });
  await test("browser action confirmation can be cancelled without starting a ceremony",async()=>{
    await owner.page.locator("#guest").fill("foreign");await owner.page.locator("#ttl").fill("77");
    let ceremonies=0;const observe=r=>{if(r.url().endsWith("/api/auth/start")) ceremonies++;};owner.page.on("request",observe);
    await owner.page.locator("#issue").click();await owner.page.locator("#management-dialog").waitFor({state:"visible"});
    assert.ok((await owner.page.locator("#management-target").innerText()).includes("Gültigkeit: 77 Sekunden"));
    await owner.page.locator("#management-cancel").click();await owner.page.waitForFunction(()=>!document.querySelector("#issue").disabled);
    owner.page.off("request",observe);assert.equal(ceremonies,0);
  });
  await test("actual browser passkey assertion abort leaves the action recoverable",async()=>{
    const before=await get(owner,"/api/grants",ownerSession);let finishes=0,writes=0;
    const observe=r=>{if(r.url().endsWith("/api/auth/finish")) finishes++;if(r.url().endsWith("/api/grants")&&r.method()==="POST") writes++;};owner.page.on("request",observe);
    await owner.cdp.send("WebAuthn.setAutomaticPresenceSimulation",{authenticatorId:owner.authenticatorId,enabled:false});
    try {
      await owner.page.locator("#issue").click();
      await owner.page.locator("#management-dialog").waitFor({state:"visible"});
      await owner.page.screenshot({path:join(evidence,"browser-management-confirmation.png"),fullPage:true});
      await confirmUI(owner,"Zugang vergeben","Empfänger: foreign");
      await owner.page.locator("#operation-cancel").waitFor({state:"visible",timeout:5000});
      await owner.page.locator("#operation-cancel").click();
      await owner.page.waitForFunction(()=>document.querySelector("#status").textContent.includes("abgebrochen")&&!document.querySelector("#issue").disabled,null,{timeout:5000});
      assert.equal(finishes,0);assert.equal(writes,0);assert.equal((await get(owner,"/api/grants",ownerSession)).body.grants.length,before.body.grants.length);
    } finally {owner.page.off("request",observe);await owner.cdp.send("WebAuthn.setAutomaticPresenceSimulation",{authenticatorId:owner.authenticatorId,enabled:true});}
  });
  await test("browser retry after a real assertion abort succeeds without a new login",async()=>{
    const finish=owner.page.waitForResponse(r=>r.url().endsWith("/api/grants")&&r.request().method()==="POST");
    await owner.page.locator("#issue").click();await confirmUI(owner,"Zugang vergeben","Gültigkeit: 77 Sekunden");
    const r=await finish;assert.equal(r.status(),200);assert.equal((await r.json()).guest,"foreign");
    assert.equal((await get(owner,"/api/credentials",ownerSession)).status,200);
  });
  await test("other account cannot revoke a passkey it does not own",async()=>assert.equal((await approvedPost(foreign,"/api/credentials/revoke",{id:initialId},foreignSession)).status,404));
  await selectDevice(guest,"original");
  const pendingKeyAuth=await assertion(guest);
  const pendingKeyInvocation=await assertion(guest,invoke(secondGrant));
  const pendingManagement=await managementAssertion(guest,guestSession,{kind:"credential_add",label:"Pending management"});
  const approvalBeforeRevocation=await approval(guest,guestSession,{kind:"credential_add",label:"Revocation-bound approval"});
  const pendingKeyEnrollment=await additionalEnrollment(guest,guestSession,"Pending spare","pending-spare");
  await selectDevice(guest,"secondary");
  const thirdGuestSession=await post(guest,"/api/auth/finish",await assertion(guest));assert.equal(thirdGuestSession.status,200);mutationSession=thirdGuestSession.body.session;
  await test("browser passkey revocation forces reauthentication and disables mutations",async()=>{
    await guest.page.locator(`.credential[data-id="${initialId}"] button`).click();
    assert.equal(await guest.page.locator("#management-dialog").evaluate(d=>d.open),true);
    const fresh=guest.page.waitForResponse(r=>r.url().endsWith("/api/auth/finish"));
    const revoke=guest.page.waitForResponse(r=>r.url().endsWith("/api/credentials/revoke"));
    await confirmUI(guest,"Passkey widerrufen",initialId);
    const r=await revoke;assert.equal(r.status(),200);const value=await r.json();assert.equal(value.revoked,true);assert.equal(value.reauthentication_required,true);
    assert.equal((await (await fresh).json()).approved,true);
    await guest.page.waitForFunction(()=>document.querySelector("#identity").textContent.includes("Erneute Anmeldung"));
    assert.equal(await guest.page.locator("#refresh").isDisabled(),true);assert.equal(await guest.page.locator("#credential-add").isDisabled(),true);
    assert.equal(await guest.page.locator("#management-dialog").evaluate(d=>d.open),false);
  });
  await test("passkey revocation invalidates every session for the account",async()=>{
    for(const s of [guestSession,otherGuestSession,mutationSession]) assert.equal((await get(guest,"/api/credentials",s)).status,401);
    assert.equal((await get(foreign,"/api/credentials",foreignSession)).status,200);
  });
  await test("passkey revocation invalidates pending login and invocation ceremonies",async()=>{
    assert.equal((await post(guest,"/api/auth/finish",pendingKeyAuth)).status,403);
    assert.equal((await post(guest,"/api/auth/finish",pendingKeyInvocation)).status,403);
  });
  guestSession=await login(guest);
  await test("credential revocation invalidates approvals and pending management ceremonies",async()=>{
    const r=await post(guest,"/api/credentials/start",{label:"Revocation-bound approval",approval_id:approvalBeforeRevocation},guestSession);assert.equal(r.status,403);assert.equal(r.body.error,"approval_missing");
    assert.equal((await post(guest,"/api/auth/finish",pendingManagement,guestSession)).status,403);
  });
  await test("last surviving passkey remains protected after another key is revoked",async()=>{
    assert.equal((await approvedPost(guest,"/api/credentials/revoke",{id:secondId},guestSession)).status,409);
    const list=await get(guest,"/api/credentials",guestSession);assert.equal(list.body.credentials.filter(c=>c.active).length,1);
  });
  await test("passkey revocation invalidates pending enrollment despite fresh surviving session",async()=>assert.equal((await post(guest,"/api/credentials/finish",pendingKeyEnrollment,guestSession)).status,403));
  await test("revoked passkey is excluded from fresh authentication options",async()=>{
    const r=await post(guest,"/api/auth/start",{name:"guest",invocation:null});assert.equal(r.status,200);
    const ids=r.body.options.publicKey.allowCredentials.map(c=>c.id);assert.ok(ids.includes(secondId));assert.ok(!ids.includes(initialId));
  });
  await test("genuine fresh assertion by revoked device is rejected",async()=>{
    const r=await post(guest,"/api/auth/start",{name:"guest",invocation:null});assert.equal(r.status,200);
    await selectDevice(guest,"original");
    r.body.options.publicKey.allowCredentials=[{type:"public-key",id:initialId}];
    const credential=await authentication(guest,r.body.options);
    assert.equal(credential.rawId,initialId);
    assert.equal((await post(guest,"/api/auth/finish",{request_id:r.body.request_id,credential,invocation:null})).status,401);
    await selectDevice(guest,"secondary");
  });
  await test("surviving passkey retains same-account grant invocation after revocation",async()=>{
    const r=await post(guest,"/api/auth/finish",await assertion(guest,invoke(secondGrant)));assert.equal(r.status,200);assert.equal(r.body.authorized,true);
    const list=await get(guest,"/api/credentials",guestSession);assert.equal(list.body.credentials.find(c=>c.id===initialId).active,false);assert.equal(list.body.credentials.find(c=>c.id===secondId).active,true);
    await guest.page.locator("#refresh").click();
    await guest.page.waitForFunction(()=>document.querySelector('#credentials [data-active="false"]'));
    await guest.page.screenshot({path:join(evidence,"browser-passkey-revoked.png"),fullPage:true});
  });
  await test("seven active passkeys enroll across distinct virtual devices",async()=>{
    for(let n=2;n<=7;n++) {
      const p=await additionalEnrollment(guest,guestSession,`Spare device ${n}`,`cap-${n}`);
      assert.equal((await post(guest,"/api/credentials/finish",p,guestSession)).status,200);
    }
    const r=await get(guest,"/api/credentials",guestSession);assert.equal(r.body.credentials.filter(c=>c.active).length,7);
  });
  const pendingAtCap=await additionalEnrollment(guest,guestSession,"Pending capacity","cap-pending");
  await selectDevice(guest,"secondary");
  await test("credential cap is rechecked when an in-flight enrollment finishes",async()=>{
    const last=await additionalEnrollment(guest,guestSession,"Eighth device","cap-final");assert.equal((await post(guest,"/api/credentials/finish",last,guestSession)).status,200);
    assert.equal((await post(guest,"/api/credentials/finish",pendingAtCap,guestSession)).status,409);
    assert.equal((await get(guest,"/api/credentials",guestSession)).body.credentials.filter(c=>c.active).length,8);
  });
  await selectDevice(guest,"secondary");
  await test("credential cap rejects new enrollment and disables the add control",async()=>{
    assert.equal((await post(guest,"/api/credentials/start",{label:"Ninth device"},guestSession)).status,409);
    await guest.page.locator("#refresh").click();await guest.page.waitForFunction(()=>document.querySelectorAll('.credential[data-active="true"]').length===8);
    assert.equal(await guest.page.locator("#credential-add").isDisabled(),true);
  });
  for(const width of [320,375,414,768]) await test(`credential workbench fits ${width}px and keeps buttons on one line`,async()=>{
    await guest.page.setViewportSize({width,height:900});
    assert.ok(await guest.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    assert.ok(await guest.page.locator("button").evaluateAll(buttons=>buttons.filter(b=>b.getClientRects().length).every(b=>{
      const range=document.createRange();range.selectNodeContents(b);return range.getClientRects().length<=1;
    })));
  });
  await guest.page.setViewportSize({width:375,height:900});
  await guest.page.screenshot({path:join(evidence,"browser-credentials-mobile.png"),fullPage:true});
  await stopServer();await startServer();
  await test("multiple passkeys and inactive original survive server restart",async()=>{
    guestSession=await login(guest);const r=await get(guest,"/api/credentials",guestSession);assert.equal(r.status,200);
    assert.equal(r.body.credentials.filter(c=>c.active).length,8);assert.equal(r.body.credentials.find(c=>c.id===initialId).active,false);assert.equal(r.body.current_credential_id,secondId);
    assert.equal((await post(guest,"/api/auth/finish",await assertion(guest,invoke(secondGrant)))).status,200);
  });
  ownerSession=await login(owner);const outsiderSession=await login(foreign);
  const [secondguest,thirdguest,fourthguest,fifthguest]=await Promise.all(["secondguest","thirdguest","fourthguest","fifthguest"].map(actor));
  for(const a of [secondguest,thirdguest,fourthguest,fifthguest]) assert.equal((await registration(a)).owner,false);
  const secondSession=await login(secondguest),thirdSession=await login(thirdguest),fourthSession=await login(fourthguest),fifthSession=await login(fifthguest);
  let delegationRoot,delegationChild,delegationLeaf,trustedIssuer;
  await test("owner issues a service-signed delegation root through exact-action UI",async()=>{
    await owner.page.locator("#delegation-guest").fill("guest");await owner.page.locator("#delegation-ttl").fill("240");await owner.page.locator("#delegation-budget").fill("2");
    const response=owner.page.waitForResponse(r=>r.url().endsWith("/api/delegations")&&r.request().method()==="POST");await owner.page.locator("#delegation-issue").click();
    await owner.page.locator("#management-dialog").waitFor({state:"visible"});const target=await owner.page.locator("#management-target").innerText();assert.ok(target.includes("Gültigkeit: 240 Sekunden"));assert.ok(target.includes("Erlaubte Weitergaben: 2"));
    await confirmUI(owner,"Weitergabe erlauben","Empfänger: guest");const r=await response;assert.equal(r.status(),200);delegationRoot=await r.json();trustedIssuer=delegationRoot.grant.body.issuer;
    checkAPIChain(delegationRoot,trustedIssuer);assert.equal(delegationRoot.chain.length,1);assert.equal(delegationRoot.grant.body.parent,null);assert.equal(delegationRoot.grant.body.delegator,null);
    assert.deepEqual(delegationRoot.grant.body.audience,[...createHash("sha256").update(Buffer.from(initialId,"base64url")).digest()]);
  });
  await test("holder delegates an attenuated child through the browser",async()=>{
    delegationChild=await uiDelegate(guest,delegationRoot,"secondguest",180,1);checkAPIChain(delegationChild,trustedIssuer);assert.equal(delegationChild.chain.length,2);assert.equal(delegationChild.grant.body.remaining_delegations,1);
    assert.deepEqual(delegationChild.grant.body.delegator,delegationRoot.grant.body.audience);assert.deepEqual(delegationChild.grant.body.parent,[...Buffer.from(referenceId(delegationRoot.grant),"hex")]);
  });
  await test("second holder delegates a grandchild to a third holder through the browser",async()=>{
    delegationLeaf=await uiDelegate(secondguest,delegationChild,"thirdguest",120,0);checkAPIChain(delegationLeaf,trustedIssuer);assert.equal(delegationLeaf.chain.length,3);assert.equal(delegationLeaf.grant.body.remaining_delegations,0);
  });
  for(const [a,grant,depth] of [[guest,delegationRoot,1],[secondguest,delegationChild,2],[thirdguest,delegationLeaf,3]]) await test(`${a.name} invokes a verified ${depth}-link chain through the browser`,async()=>{
    await a.page.locator("#refresh").click();const response=a.page.waitForResponse(r=>r.url().endsWith("/api/auth/finish"));
    await a.page.locator(`.delegation[data-id="${grant.id}"] .delegation-actions button`).filter({hasText:"Dokument lesen"}).click();const r=await response;assert.equal(r.status(),200);assert.equal((await r.json()).allowed,true);
    await a.page.waitForFunction(()=>document.querySelector("#result").textContent.includes('"allowed": true'));
  });
  await thirdguest.page.screenshot({path:join(evidence,"browser-delegation-chain.png"),fullPage:true});
  await test("delegation listings expose received and personally issued grants only",async()=>{
    const ownerList=await get(owner,"/api/delegations",ownerSession);assert.equal(ownerList.body.profile,"heavenkey-delegation-v1");assert.equal(ownerList.body.max_chain,5);
    const g=await get(guest,"/api/delegations",guestSession),s=await get(secondguest,"/api/delegations",secondSession),t=await get(thirdguest,"/api/delegations",thirdSession),f=await get(foreign,"/api/delegations",outsiderSession);
    assert.deepEqual(g.body.grants.map(x=>x.id).sort(),[delegationRoot.id,delegationChild.id].sort());assert.deepEqual(s.body.grants.map(x=>x.id).sort(),[delegationChild.id,delegationLeaf.id].sort());assert.deepEqual(t.body.grants.map(x=>x.id),[delegationLeaf.id]);assert.equal(f.body.grants.length,0);
    assert.equal((await get(guest,"/api/delegations")).status,401);assert.equal(g.body.grants.find(x=>x.id===delegationRoot.id).can_delegate,true);assert.equal(t.body.grants[0].can_delegate,false);
  });
  for(const [name,a,path,body,s] of [
    ["delegation root",owner,"/api/delegations",{guest_name:"guest",ttl_seconds:200,remaining_delegations:2},ownerSession],
    ["delegation child",guest,"/api/delegations/delegate",{parent_id:delegationRoot.id,guest_name:"foreign",ttl_seconds:60,remaining_delegations:0},guestSession],
    ["delegation revoke",owner,"/api/delegations/revoke",{id:delegationRoot.id},ownerSession],
  ]) await test(`bearer possession alone cannot authorize ${name}`,async()=>{const r=await post(a,path,body,s);assert.equal(r.status,403);assert.equal(r.body.error,"approval_required");});
  await test("delegation root issuance remains owner-only",async()=>assert.equal((await post(guest,"/api/auth/start",{name:"guest",management:{kind:"delegation_create",guest_name:"foreign",ttl_seconds:60,remaining_delegations:1}},guestSession)).status,403));
  await test("only the current parent audience can delegate its chain",async()=>assert.equal((await post(foreign,"/api/auth/start",{name:"foreign",management:{kind:"delegation_delegate",parent_id:delegationRoot.id,guest_name:"fourthguest",ttl_seconds:60,remaining_delegations:0}},outsiderSession)).status,403));
  await test("delegation cannot widen expiry or retain its parent's budget",async()=>{
    for(const change of [{ttl_seconds:3600,remaining_delegations:0},{ttl_seconds:60,remaining_delegations:2}]) assert.equal((await post(guest,"/api/auth/start",{name:"guest",management:{kind:"delegation_delegate",parent_id:delegationRoot.id,guest_name:"foreign",...change}},guestSession)).status,403);
  });
  await test("delegation prevents cycles back to any existing audience",async()=>{
    for(const guest_name of ["guest","secondguest"]) assert.equal((await post(secondguest,"/api/auth/start",{name:"secondguest",management:{kind:"delegation_delegate",parent_id:delegationChild.id,guest_name,ttl_seconds:60,remaining_delegations:0}},secondSession)).status,403);
  });
  await test("zero-budget leaf cannot authorize another delegation",async()=>assert.equal((await post(thirdguest,"/api/auth/start",{name:"thirdguest",management:{kind:"delegation_delegate",parent_id:delegationLeaf.id,guest_name:"foreign",ttl_seconds:30,remaining_delegations:0}},thirdSession)).status,403));
  await test("delegation root validates TTL and four-step maximum budget",async()=>{
    for(const [ttl_seconds,remaining_delegations] of [[0,2],[60,5]]) assert.equal((await post(owner,"/api/auth/start",{name:"owner",management:{kind:"delegation_create",guest_name:"guest",ttl_seconds,remaining_delegations}},ownerSession)).status,400);
  });
  for(const [name,a,grant,change] of [["wrong audience",foreign,delegationLeaf,{}],["resource escalation",thirdguest,delegationLeaf,{resource:"urn:uac:other"}],["action escalation",thirdguest,delegationLeaf,{action:"Write"}]]) await test(`delegated invocation denies ${name}`,async()=>assert.equal((await post(a,"/api/auth/start",{name:a.name,delegation_invocation:{...delegatedInvocation(grant),...change}})).status,403));
  await test("delegated invocation cannot mix with login-management or legacy invocation",async()=>{
    const d=delegatedInvocation(delegationLeaf);assert.equal((await post(thirdguest,"/api/auth/start",{name:"thirdguest",delegation_invocation:d,invocation:invoke(secondGrant)})).status,400);
    assert.equal((await post(thirdguest,"/api/auth/start",{name:"thirdguest",delegation_invocation:d,management:{kind:"credential_add",label:"Mixed"}},thirdSession)).status,400);
  });
  await test("delegated invocation binds exact ID, arguments and purpose at finish",async()=>{
    for(const change of [{id:delegationChild.id},{arguments:{document:"different"}},null]) {
      const p=await delegatedAssertion(thirdguest,delegationLeaf);p.delegation_invocation=change===null?null:{...p.delegation_invocation,...change};assert.equal((await post(thirdguest,"/api/auth/finish",p)).status,403);
    }
  });
  await test("delegated assertion replay and parallel duplicate execute once",async()=>{
    const p=await delegatedAssertion(thirdguest,delegationLeaf);assert.equal((await post(thirdguest,"/api/auth/finish",p)).status,200);assert.equal((await post(thirdguest,"/api/auth/finish",p)).status,403);
    const duplicate=await delegatedAssertion(thirdguest,delegationLeaf);const results=await Promise.all([post(thirdguest,"/api/auth/finish",duplicate),post(thirdguest,"/api/auth/finish",duplicate)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,403]);
  });
  await test("delegated assertion still requires a valid WebAuthn signature",async()=>{const p=await delegatedAssertion(thirdguest,delegationLeaf);p.credential.response.signature=Buffer.alloc(70,0).toString("base64url");assert.equal((await post(thirdguest,"/api/auth/finish",p)).status,401);});
  const branchResponse=await approvedPost(owner,"/api/delegations",{guest_name:"guest",ttl_seconds:230,remaining_delegations:2},ownerSession);assert.equal(branchResponse.status,200);const branch=branchResponse.body;checkAPIChain(branch,trustedIssuer);
  for(const [name,approved,changed] of [["recipient",{guest_name:"guest",ttl_seconds:200,remaining_delegations:2},{guest_name:"foreign",ttl_seconds:200,remaining_delegations:2}],["TTL",{guest_name:"guest",ttl_seconds:200,remaining_delegations:2},{guest_name:"guest",ttl_seconds:199,remaining_delegations:2}],["budget",{guest_name:"guest",ttl_seconds:200,remaining_delegations:2},{guest_name:"guest",ttl_seconds:200,remaining_delegations:1}]]) await test(`delegation approval binds exact ${name} and burns mismatch`,async()=>{
    const approval_id=await approval(owner,ownerSession,managementFor("/api/delegations",approved));const r=await post(owner,"/api/delegations",{...changed,approval_id},ownerSession);assert.equal(r.status,403);assert.equal(r.body.error,"approval_mismatch");assert.equal((await post(owner,"/api/delegations",{...approved,approval_id},ownerSession)).body.error,"approval_missing");
  });
  await test("delegation approval binds the exact parent",async()=>{
    const body={parent_id:delegationRoot.id,guest_name:"foreign",ttl_seconds:60,remaining_delegations:0};const approval_id=await approval(guest,guestSession,managementFor("/api/delegations/delegate",body));
    const r=await post(guest,"/api/delegations/delegate",{...body,parent_id:branch.id,approval_id},guestSession);assert.equal(r.status,403);assert.equal(r.body.error,"approval_mismatch");assert.equal((await post(guest,"/api/delegations/delegate",{...body,approval_id},guestSession)).body.error,"approval_missing");
  });
  await test("delegation approval cannot cross action kind or session",async()=>{
    const body={guest_name:"guest",ttl_seconds:200,remaining_delegations:2};const other=await post(owner,"/api/auth/finish",await assertion(owner));assert.equal(other.status,200);
    let approval_id=await approval(owner,ownerSession,managementFor("/api/delegations",body));assert.equal((await post(owner,"/api/delegations",{...body,approval_id},other.body.session)).body.error,"approval_mismatch");
    approval_id=await approval(owner,ownerSession,managementFor("/api/delegations",body));assert.equal((await post(owner,"/api/grants",{guest_name:"guest",ttl_seconds:200,approval_id},ownerSession)).body.error,"approval_mismatch");
  });
  await test("wrong-holder delegation attempt consumes a supplied approval",async()=>{
    const body={parent_id:delegationRoot.id,guest_name:"foreign",ttl_seconds:60,remaining_delegations:0};const approval_id=await approval(guest,guestSession,managementFor("/api/delegations/delegate",body));assert.equal((await post(secondguest,"/api/delegations/delegate",{...body,approval_id},secondSession)).status,403);
    assert.equal((await post(guest,"/api/delegations/delegate",{...body,approval_id},guestSession)).body.error,"approval_missing");
  });
  await test("delegation approval replay and parallel write cannot mint twice",async()=>{
    const body={guest_name:"foreign",ttl_seconds:210,remaining_delegations:1};const approval_id=await approval(owner,ownerSession,managementFor("/api/delegations",body));
    const before=(await get(owner,"/api/delegations",ownerSession)).body.grants.length;const results=await Promise.all([post(owner,"/api/delegations",{...body,approval_id},ownerSession),post(owner,"/api/delegations",{...body,approval_id},ownerSession)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,403]);checkAPIChain(results.find(x=>x.status===200).body,trustedIssuer);
    assert.equal((await get(owner,"/api/delegations",ownerSession)).body.grants.length,before+1);assert.equal((await post(owner,"/api/delegations",{...body,approval_id},ownerSession)).body.error,"approval_missing");
  });
  await test("parent holder cannot revoke a descendant issued by another account",async()=>assert.equal((await post(guest,"/api/auth/start",{name:"guest",management:{kind:"delegation_revoke",id:delegationLeaf.id}},guestSession)).status,403));
  const branchChildResponse=await approvedPost(guest,"/api/delegations/delegate",{parent_id:branch.id,guest_name:"secondguest",ttl_seconds:100,remaining_delegations:0},guestSession);assert.equal(branchChildResponse.status,200);const branchChild=branchChildResponse.body;checkAPIChain(branchChild,trustedIssuer);
  await test("actual child issuer can revoke its own child idempotently",async()=>{
    for(let n=0;n<2;n++) {const r=await approvedPost(guest,"/api/delegations/revoke",{id:branchChild.id},guestSession);assert.equal(r.status,200);assert.equal(r.body.revoked,true);}
    assert.equal((await post(secondguest,"/api/auth/start",{name:"secondguest",delegation_invocation:delegatedInvocation(branchChild)})).status,403);
  });
  await test("stored tokens are reverified for unknown profile and bad signature",async()=>{
    const saved=storeQuery("SELECT token FROM delegations WHERE id=?1",[delegationLeaf.id])[0][0];
    try {for(const mutation of [token=>{token.body.profile="unrecognized";},token=>{token.signature[0]^=1;}]) {const token=JSON.parse(saved);mutation(token);storeQuery("UPDATE delegations SET token=?1 WHERE id=?2",[JSON.stringify(token),delegationLeaf.id]);assert.equal((await post(thirdguest,"/api/auth/start",{name:"thirdguest",delegation_invocation:delegatedInvocation(delegationLeaf)})).status,403);}}
    finally {storeQuery("UPDATE delegations SET token=?1 WHERE id=?2",[saved,delegationLeaf.id]);}
  });
  await test("stored parent pointer cannot silently replace a signed parent",async()=>{
    try {storeQuery("UPDATE delegations SET parent_id=?1 WHERE id=?2",[branch.id,delegationChild.id]);assert.equal((await post(secondguest,"/api/auth/start",{name:"secondguest",delegation_invocation:delegatedInvocation(delegationChild)})).status,403);}
    finally {storeQuery("UPDATE delegations SET parent_id=?1 WHERE id=?2",[delegationRoot.id,delegationChild.id]);}
  });
  await test("five-link delegation depth succeeds and a sixth link is refused",async()=>{
    const root=await approvedPost(owner,"/api/delegations",{guest_name:"guest",ttl_seconds:300,remaining_delegations:4},ownerSession);assert.equal(root.status,200);let parent=root.body;checkAPIChain(parent,trustedIssuer);
    for(const [a,s,next,ttl,budget] of [[guest,guestSession,"secondguest",260,3],[secondguest,secondSession,"thirdguest",220,2],[thirdguest,thirdSession,"fourthguest",180,1],[fourthguest,fourthSession,"fifthguest",140,0]]) {const r=await approvedPost(a,"/api/delegations/delegate",{parent_id:parent.id,guest_name:next,ttl_seconds:ttl,remaining_delegations:budget},s);assert.equal(r.status,200);parent=r.body;checkAPIChain(parent,trustedIssuer);}
    assert.equal(parent.chain.length,5);assert.equal((await post(fifthguest,"/api/auth/finish",await delegatedAssertion(fifthguest,parent))).status,200);
    assert.equal((await post(fifthguest,"/api/auth/start",{name:"fifthguest",management:{kind:"delegation_delegate",parent_id:parent.id,guest_name:"foreign",ttl_seconds:30,remaining_delegations:0}},fifthSession)).status,403);
  });
  await test("expired delegation denies invocation without changing signed token",async()=>{const r=await approvedPost(owner,"/api/delegations",{guest_name:"foreign",ttl_seconds:1,remaining_delegations:0},ownerSession);assert.equal(r.status,200);await new Promise(resolve=>setTimeout(resolve,1200));assert.equal((await post(foreign,"/api/auth/start",{name:"foreign",delegation_invocation:delegatedInvocation(r.body)})).status,403);});
  const pendingDelegation=await delegatedAssertion(thirdguest,delegationLeaf);
  const pendingDelegateBody={parent_id:delegationChild.id,guest_name:"foreign",ttl_seconds:60,remaining_delegations:0};
  const pendingDelegateApproval=await approval(secondguest,secondSession,managementFor("/api/delegations/delegate",pendingDelegateBody));
  const pendingDelegateManagement=await managementAssertion(secondguest,secondSession,managementFor("/api/delegations/delegate",pendingDelegateBody));
  await test("owner ancestor revocation through UI invalidates the entire chain",async()=>{
    await owner.page.locator("#refresh").click();const response=owner.page.waitForResponse(r=>r.url().endsWith("/api/delegations/revoke"));await owner.page.locator(`.delegation[data-id="${delegationRoot.id}"] .delegation-actions button`).filter({hasText:"Weitergabe widerrufen"}).click();await confirmUI(owner,"Weitergabe widerrufen",delegationRoot.id);assert.equal((await response).status(),200);
    for(const [a,grant] of [[guest,delegationRoot],[secondguest,delegationChild],[thirdguest,delegationLeaf]]) assert.equal((await post(a,"/api/auth/start",{name:a.name,delegation_invocation:delegatedInvocation(grant)})).status,403);
  });
  await test("ancestor revocation denies pending invocation and approved new child",async()=>{
    assert.equal((await post(thirdguest,"/api/auth/finish",pendingDelegation)).status,403);assert.equal((await post(secondguest,"/api/delegations/delegate",{...pendingDelegateBody,approval_id:pendingDelegateApproval},secondSession)).status,403);
    assert.equal((await post(secondguest,"/api/auth/finish",pendingDelegateManagement,secondSession)).status,403);
    assert.equal((await post(secondguest,"/api/auth/start",{name:"secondguest",management:managementFor("/api/delegations/delegate",pendingDelegateBody)},secondSession)).status,403);
  });
  await test("inherited revocation is visible while descendant signatures stay unchanged",async()=>{
    const list=await get(thirdguest,"/api/delegations",thirdSession);const row=list.body.grants.find(x=>x.id===delegationLeaf.id);assert.equal(row.revoked,false);assert.equal(row.effective_revoked,true);assert.equal(row.can_delegate,false);
    assert.deepEqual(row.chain.map(referenceId),delegationLeaf.chain.map(referenceId));assert.throws(()=>referenceVerifyChain(row.chain,{issuer:trustedIssuer,audience:row.grant.body.audience,resource:row.grant.body.resource,action:"Read",now:Math.floor(Date.now()/1000),revoked:[referenceId(delegationRoot.grant)]}));
    await thirdguest.page.locator("#refresh").click();await thirdguest.page.waitForFunction(()=>document.querySelector("#delegations").textContent.includes("Vorfahre widerrufen"));await thirdguest.page.screenshot({path:join(evidence,"browser-delegation-revoked.png"),fullPage:true});
  });
  await test("signature-preserving ancestor skipping cannot bypass revocation",async()=>{
    try {storeQuery("UPDATE delegations SET parent_id=NULL WHERE id=?1",[delegationChild.id]);assert.equal((await post(thirdguest,"/api/auth/start",{name:"thirdguest",delegation_invocation:delegatedInvocation(delegationLeaf)})).status,403);assert.throws(()=>referenceVerifyChain(delegationLeaf.chain.slice(1),{issuer:trustedIssuer,audience:delegationLeaf.grant.body.audience,resource:delegationLeaf.grant.body.resource,action:"Read",now:Math.floor(Date.now()/1000)}));}
    finally {storeQuery("UPDATE delegations SET parent_id=?1 WHERE id=?2",[delegationRoot.id,delegationChild.id]);}
  });
  const restartDelegationApproval=await approval(owner,ownerSession,{kind:"delegation_create",guest_name:"foreign",ttl_seconds:100,remaining_delegations:0});
  await stopServer();await startServer();
  await test("ancestor tombstones and descendant denial survive restart",async()=>{
    const current=await login(thirdguest);const rows=(await get(thirdguest,"/api/delegations",current)).body.grants;assert.equal(rows.find(x=>x.id===delegationLeaf.id).effective_revoked,true);
    assert.equal((await post(thirdguest,"/api/auth/start",{name:"thirdguest",delegation_invocation:delegatedInvocation(delegationLeaf)})).status,403);
    const rootSession=await login(owner);const r=await post(owner,"/api/delegations",{guest_name:"foreign",ttl_seconds:100,remaining_delegations:0,approval_id:restartDelegationApproval},rootSession);assert.equal(r.status,403);assert.equal(r.body.error,"approval_missing");
  });
  await thirdguest.page.setViewportSize({width:375,height:900});
  await test("delegation workbench fits a mobile viewport",async()=>assert.ok(await thirdguest.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)));
  await thirdguest.page.screenshot({path:join(evidence,"browser-delegation-mobile.png"),fullPage:true});
  const legacyRow=storeQuery("SELECT id,name,owner,credential_id,passkey,counter FROM users WHERE name=?1",["foreign"])[0];
  const legacyUser={id:legacyRow[0],name:legacyRow[1],owner:legacyRow[2],credential_id:legacyRow[3],passkey:legacyRow[4],counter:legacyRow[5]};
  legacyData=await mkdtemp(join(tmpdir(),"uac-legacy-"));
  const legacyDb=new Database(join(legacyData,"uac.sqlite"));
  legacyDb.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,owner INTEGER NOT NULL,credential_id TEXT UNIQUE NOT NULL,passkey TEXT NOT NULL,counter INTEGER NOT NULL DEFAULT 0)");
  legacyDb.query("INSERT INTO users VALUES(?1,?2,?3,?4,?5,?6)").run(legacyUser.id,legacyUser.name,legacyUser.owner,legacyUser.credential_id,legacyUser.passkey,legacyUser.counter);legacyDb.close();
  await stopServer();serverData=legacyData;await startServer();
  await test("legacy single-passkey database migrates and authenticates with the same key",async()=>{
    const migratedSession=await login(foreign);const r=await get(foreign,"/api/credentials",migratedSession);assert.equal(r.status,200);assert.equal(r.body.credentials.length,1);
    assert.equal(r.body.credentials[0].id,legacyUser.credential_id);assert.equal(r.body.credentials[0].active,true);assert.equal(r.body.credentials[0].label,"Initial passkey");
  });
  await stopServer();await startServer();
  await test("legacy credential migration is idempotent across a second restart",async()=>{
    const migratedSession=await login(foreign);const r=await get(foreign,"/api/credentials",migratedSession);assert.equal(r.body.credentials.length,1);assert.equal(r.body.current_credential_id,legacyUser.credential_id);
  });
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
  for (const path of protectionFiles) await rm(path, { force: true });
  const report={completed:!fatalError,fatal_error:fatalError,mode:"virtual CTAP2 authenticators; real navigator.credentials + Rust verification",binary:process.env.HEAVENKEY_BINARY || "target/debug/uac-api",windows_compatibility:process.env.HEAVENKEY_WINDOWS_PATHS === "1",storage_permission_oracle:process.env.HEAVENKEY_WINDOWS_PATHS === "1" ? "private POSIX parent of Wine data; native Windows ACL unverified" : "POSIX bootstrap file permissions",hardware:"deferred by user",total:cases.length,passed:cases.filter(x=>x.pass).length,failed:cases.filter(x=>!x.pass).length,cases,elapsed_seconds:Math.round((performance.now()-started)/100)/10};
  await writeFile(join(evidence,"e2e.json"),JSON.stringify(report,null,2)+"\n");
  await rm(data,{recursive:true,force:true});
  if(legacyData) await rm(legacyData,{recursive:true,force:true});
  console.log(JSON.stringify({total:report.total,passed:report.passed,failed:report.failed,elapsed_seconds:report.elapsed_seconds}));
}
