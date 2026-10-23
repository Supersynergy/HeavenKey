import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, ".."), binary = resolve(process.env.HEAVENKEY_BINARY || "target/debug/uac-api");
const mode = process.env.HEAVENKEY_UX_MODE || "current", report = resolve(process.env.HEAVENKEY_UX_REPORT || "docs/evidence/protected-ux.json");
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome", origin = "http://localhost:18388";
const temp = await mkdtemp(join(tmpdir(), "heavenkey-ux-")), master = "Synthetic UX local master only!";
let server: ChildProcess | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, passed = false, metrics: any;
const uiChecks: string[] = [], screenshots: string[] = [];
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v:T)=>boolean, seconds = 20) { const end = Date.now()+seconds*1000;for(;;){const v=await fn();if(ok(v))return v;if(Date.now()>end)throw Error("UX condition deadline");await delay(150);} }
try {
 try { await fetch(origin+"/health",{signal:AbortSignal.timeout(300)});throw Error("Occupied UX fixture port"); } catch(e){if(String(e).includes("Occupied"))throw e;}
 const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("UAC_")&&!/^HEAVENKEY_(PUBLIC_ORIGIN|ORIGIN|SHARE_ORIGIN|PASSWORD_MANAGER|DOCUMENT)/.test(key)));
 server = spawn(binary,["--password-manager","--port","18388","--data-dir",temp],{cwd:root,env:{...env,HEAVENKEY_BROKER_BROWSER:chrome},stdio:["ignore","ignore","ignore"]});
 await until(async()=>{try{return(await fetch(origin+"/health",{signal:AbortSignal.timeout(300)})).ok}catch{return false}},Boolean);
 browser = await chromium.launch({headless:true,executablePath:chrome});const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(15000);const page=await context.newPage();
 await page.goto(origin+"/passwords/");await page.locator("#master").fill(master);await page.locator("#master-confirm").fill(master);await page.locator("#unlock").click();await page.locator("#workspace[aria-busy=false]:not([hidden])").waitFor();
 await page.locator("#new-entry").click();await page.locator("#entry-title").fill("Synthetic UX account");await page.locator("#entry-username").fill("ux-synthetic-user");await page.locator("#entry-password").fill("Synthetic-UX-password-only!");await page.locator("#entry-url").fill("http://localhost:18389/login");await page.locator("#save-entry").click();await page.locator("#editor").waitFor({state:"hidden"});
 await page.locator("#nav-settings").click();await page.locator("#new-profile").click();await page.locator("#profile-title").fill("Synthetic UX profile");
 await page.locator("#profile-fields select").selectOption("name");await page.locator("#profile-fields input").fill("Synthetic UX Person");await page.locator("#add-profile-field").click();await page.locator("#profile-fields select").last().selectOption("email");await page.locator("#profile-fields input").last().fill("ux-profile@example.invalid");await page.locator("#profile-form button[type=submit]").click();await page.locator("#profile-editor").waitFor({state:"hidden"});
 await page.locator("#protected-pair:not([disabled])").waitFor();const pairing=page.waitForResponse(r=>r.url().endsWith("/protected-pairing")&&r.request().method()==="POST");await page.locator("#protected-pair").click();const code=(await(await pairing).json()).code;
 const connected=await fetch(origin+"/api/password-broker/agent/connect",{method:"POST",headers:{"Content-Type":"application/json","X-HeavenKey-Client":"password-agent"},body:JSON.stringify({code,label:"Synthetic UX protected agent"})});assert.equal(connected.status,200);const client=await connected.json() as any;
 await delay(3200);
 await page.evaluate(()=>{
  const state={active:false,events:[] as any[],intent:0,first_feedback:0,server_confirm:0};(window as any).__hkUX=state;
  const target=(event:Event)=>{const node=(event.target as Element)?.closest("button,select,input");if(!node)return null;return node.id&&/^[a-z-]+$/.test(node.id)?node.id:node.tagName.toLowerCase();};
  document.addEventListener("click",e=>{if((e.target as Element)?.closest("#protected-new")){state.active=true;state.intent=performance.now();requestAnimationFrame(()=>{if((document.getElementById("protected-composer-dialog") as HTMLDialogElement).open)state.first_feedback=performance.now();});}if(state.active)state.events.push({kind:"click",target_id:target(e),ts:performance.now()});},true);
  document.addEventListener("change",e=>{if(state.active&&(e.target as Element).tagName==="SELECT")state.events.push({kind:"selection",target_id:target(e),ts:performance.now()});},true);
  document.addEventListener("input",e=>{if(state.active&&(e.target as Element).tagName==="INPUT")state.events.push({kind:"input",target_id:target(e),characters:(e as InputEvent).data?.length??0,ts:performance.now()});},true);
 });
 await page.locator("#protected-new").click();await page.locator("#protected-client").selectOption(client.client_id);const source=page.locator("#protected-source option").filter({hasText:"Synthetic UX account"});await page.locator("#protected-source").selectOption((await source.getAttribute("value"))!);
 if(mode==="baseline") {await page.locator("#protected-person").fill("Synthetic UX Person");await page.locator("#protected-email").fill("ux-profile@example.invalid");}
 else {const profile=page.locator("#protected-profile");const choice=profile.locator("option").filter({hasText:"Synthetic UX profile"});await profile.selectOption((await choice.getAttribute("value"))!);assert.equal(await page.locator("#protected-person").inputValue(),"Synthetic UX Person");assert.equal(await page.locator("#protected-email").inputValue(),"ux-profile@example.invalid");}
 await page.locator("#protected-case").fill("UX-CASE-123");const published=page.waitForResponse(r=>r.url().endsWith("/protected/workspaces")&&r.request().method()==="POST");await page.locator("#protected-publish").click();assert.equal((await published).status(),200);
 await page.locator("#protected-composer-dialog").waitFor({state:"hidden"});await page.locator("#protected-status").filter({hasText:/gespeichert.*freigegeben/i}).waitFor();
 metrics=await page.evaluate(()=>{const s=(window as any).__hkUX;s.active=false;s.server_confirm=performance.now();return{events:s.events,button_clicks:s.events.filter((e:any)=>e.kind==="click").length,selection_changes:s.events.filter((e:any)=>e.kind==="selection").length,manual_input_fields:new Set(s.events.filter((e:any)=>e.kind==="input").map((e:any)=>e.target_id)).size,inserted_characters:s.events.filter((e:any)=>e.kind==="input").reduce((n:number,e:any)=>n+e.characters,0),first_feedback_ms:s.first_feedback-s.intent,durable_confirmation_ms:s.server_confirm-s.intent};});
 assert(metrics.first_feedback_ms>=0&&metrics.durable_confirmation_ms>0);
 if(mode!=="baseline") {
  await page.locator("#protected-new").click();await page.locator("#protected-client").selectOption(client.client_id);await page.locator("#protected-source").selectOption((await source.getAttribute("value"))!);
  await page.locator("#protected-person").focus();await delay(3400);assert.equal(await page.locator("#protected-person").evaluate(e=>e===document.activeElement),true);uiChecks.push("Status polling preserves editor focus");
  await page.locator("#protected-profile").selectOption({label:"Synthetic UX profile"});await page.locator("#protected-case").fill("UX-CASE-123");
  for(const theme of ["light","dark"]) {
   await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   const contrast=await page.locator("#protected-composer-dialog label").first().evaluate(e=>{
    const rgb=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});
    const lum=(s:string)=>rgb(s).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const fg=lum(getComputedStyle(e).color),bg=lum(getComputedStyle(e.closest("dialog")!).backgroundColor);return(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
   });assert(contrast>=4.5,theme+" label contrast");uiChecks.push(theme+" label contrast >=4.5:1");
   const path=resolve(report,"..","composer-"+theme+".png");await page.screenshot({path});screenshots.push(path);
  }
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const box=await page.locator("#protected-composer-dialog").boundingBox();assert(box&&box.x>=0&&box.x+box.width<=390);uiChecks.push("390px mobile viewport fits without horizontal overflow");
  for(const id of ["protected-profile","protected-person","protected-publish"]){const h=await page.locator("#"+id).evaluate(e=>e.getBoundingClientRect().height);assert(h>=44);}
  uiChecks.push("Primary form controls meet44px target height");await page.emulateMedia({reducedMotion:"reduce"});assert.equal(await page.locator("#protected-person").evaluate(e=>getComputedStyle(e).transitionDuration),"0s");uiChecks.push("Reduced motion removes transitions");
  const path=resolve(report,"..","composer-mobile.png");await page.screenshot({path});screenshots.push(path);
 }
 passed=true;
} finally {
 await browser?.close();if(server?.exitCode===null&&server.signalCode===null){server.kill("SIGTERM");await until(async()=>server!.exitCode!==null||server!.signalCode!==null,Boolean,5).catch(()=>server!.kill("SIGKILL"));}
 await mkdir(resolve(report,".."),{recursive:true});await writeFile(report,JSON.stringify({pass:passed,mode,uiChecks,screenshots,binary_sha256:createHash("sha256").update(await readFile(binary)).digest("hex"),workload:"Create a protected job from an existing local contact profile; explicit agent and login choice retained; no login approval or delivery included",metrics,measurement:"Synthetic browser click/change/input events, inserted characters and performance timestamps. No claim about human keystrokes, daily frequency or end-to-end one-click approval."},null,2)+"\n");await rm(temp,{recursive:true,force:true});
}
