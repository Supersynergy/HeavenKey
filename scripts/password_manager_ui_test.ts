import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(".");
const build = await Bun.build({entrypoints:[`${root}/apps/web/src/passwords.ts`],target:"browser"});
const script = await build.outputs[0].text();
let record: any = null, revision = 0;
const writes: any[]=[];
const server=Bun.serve({port:0,hostname:"127.0.0.1",async fetch(request){
 const path=new URL(request.url).pathname;
 if(path==="/passwords/")return new Response(await readFile(`${root}/apps/web/passwords.html`),{headers:{"Content-Type":"text/html"}});
 if(path==="/passwords.css")return new Response(await readFile(`${root}/apps/web/src/passwords.css`),{headers:{"Content-Type":"text/css"}});
 if(path==="/passwords.js")return new Response(script,{headers:{"Content-Type":"text/javascript"}});
 if(path==="/api/password-vault/config")return Response.json({token:"synthetic-local-token",revision});
 if(path==="/api/password-vault"){
 if(request.method==="POST"){const body=await request.json();if(body.expected_revision!==revision)return new Response("conflict",{status:409});record=body.record;revision++;writes.push(body);}
 return Response.json({revision,record});
 }
 return new Response("not found",{status:404});
}});
let browser;
try {
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"),headless:true,args:["--disable-background-networking"],timeout:20000});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 const origin=`http://localhost:${server.port}`;await page.goto(`${origin}/passwords/`);await page.locator("#unlock:not([disabled])").waitFor();
 await page.locator("#master").fill("synthetic master password");await page.locator("#master-confirm").fill("synthetic master password");await page.locator("#unlock").click();await page.locator("#workspace:not([hidden])").waitFor();
 console.log("PASS browser vault creation");
 await page.locator("#new-entry").click();await page.locator("#entry-title").fill("<img src=x onerror=alert(1)> Synthetic");await page.locator("#entry-username").fill("demo@example.invalid");await page.locator("#entry-password").fill("synthetic-login-secret");await page.locator("#entry-url").fill("https://example.invalid");await page.locator("#entry-notes").fill("synthetic note");await page.locator("#entry-tags").fill("work, test");await page.locator("#entry-totp").fill("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");await page.locator("#entry-favorite").check();await page.locator("#save-entry").click();await page.locator('[data-testid="login"]').waitFor();
 assert.equal(await page.evaluate(() => document.activeElement?.id), "new-entry");assert.equal(await page.locator("#entries img").count(),0);assert.equal(writes.length,2);assert(!JSON.stringify(writes).includes("synthetic-login-secret"));
 await page.locator('[data-testid="show-totp"]').click();await page.locator('[data-testid="totp-code"]').waitFor();
 await page.locator("#search").fill("no match");assert.equal(await page.locator('[data-testid="login"]').count(),0);await page.locator("#search").fill("work");assert.equal(await page.locator('[data-testid="login"]').count(),1);
 console.log("PASS CRUD create/search/tags/favorite/TOTP and DOM injection rejection; API ciphertext only");
 const backup=JSON.stringify(record);const backupRevision=revision;
 await page.locator('[data-testid="edit-entry"]').click();await page.locator("#entry-title").fill("Edited synthetic");await page.locator("#save-entry").click();await page.waitForFunction(()=>document.querySelector("#entries")!.textContent!.includes("Edited synthetic"));
 await page.locator("#lock").click();await page.locator("#gate:not([hidden])").waitFor();assert.equal(await page.locator("#entries").textContent(),"");assert.equal(await page.locator("#entry-password").inputValue(),"");
 await page.locator("#unlock:not([disabled])").waitFor();await page.locator("#master").fill("incorrect synthetic password");await page.locator("#unlock").click();await page.waitForFunction(()=>document.querySelector("#status")!.textContent!.includes("Entsperren fehlgeschlagen"));assert(await page.locator("#workspace").isHidden());
 await page.locator("#master").fill("synthetic master password");await page.locator("#unlock").click();await page.locator("#workspace:not([hidden])").waitFor();assert((await page.locator("#entries").textContent())!.includes("Edited synthetic"));
 console.log("PASS edit/persistence and lock clears DOM; wrong master rejected");
 await page.locator("summary").filter({hasText:"CSV"}).click();await page.locator("#import-file").setInputFiles({name:"synthetic.csv",mimeType:"text/csv",buffer:Buffer.from('Title,Username,Password,URL,Notes\nCSV demo,demo,synthetic-csv-password,https://example.invalid,"line1\nline2"')});await page.locator("#import-csv").click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid="login"]').length===2);
 const validRevision=revision;await page.locator("#import-file").setInputFiles({name:"invalid.csv",mimeType:"text/csv",buffer:Buffer.from('Title,Password\nGood,synthetic\nBad,extra,invalid')});await page.locator("#import-csv").click();await page.waitForFunction(()=>document.querySelector("#status")!.textContent!.includes("Spaltenzahl"));assert.equal(revision,validRevision);assert.equal(await page.locator('[data-testid="login"]').count(),2);
 console.log("PASS CSV import and invalid-file atomicity");
 await page.locator("summary").filter({hasText:"Sicherung wiederherstellen"}).click();await page.locator("#restore-file").setInputFiles({name:"backup.json",mimeType:"application/json",buffer:Buffer.from(backup)});await page.locator("#restore-master").fill("incorrect synthetic password");await page.locator("#restore-confirm").check();await page.locator("#restore-backup").click();await page.waitForFunction(()=>document.querySelector("#status")!.textContent!.includes("Entsperren fehlgeschlagen"));assert.equal(revision,validRevision);
 await page.locator("#restore-master").fill("synthetic master password");await page.locator("#restore-backup").click();await page.waitForFunction(()=>document.querySelector("#status")!.textContent!.includes("wiederhergestellt"));assert.equal(await page.locator('[data-testid="login"]').count(),1);assert.equal(revision,validRevision+1);
 console.log("PASS encrypted backup restore and wrong backup password preserves current data");
 await page.locator("summary").filter({hasText:"Masterpasswort ändern"}).click();await page.locator("#new-master").fill("synthetic replacement password");await page.locator("#new-master-confirm").fill("synthetic replacement password");const salt=record.salt;await page.locator("#rekey").click();await page.waitForFunction(()=>document.querySelector("#status")!.textContent!.includes("Masterpasswort geändert"));assert.notEqual(record.salt,salt);
 await page.locator("#lock").click();await page.locator("#unlock:not([disabled])").waitFor();await page.locator("#master").fill("synthetic replacement password");await page.locator("#unlock").click();await page.locator("#workspace:not([hidden])").waitFor();
 console.log("PASS master rotation with new salt and re-unlock");

 await page.evaluate(()=>{Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{throw new Error("denied");},readText:async()=>""}});});await page.locator('[data-testid="copy-password"]').click();await page.waitForFunction(()=>document.querySelector("#status")!.textContent!.includes("Kopieren nicht erlaubt"));
 await page.evaluate(()=>{(window as any).syntheticClipboard="";Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async(text:string)=>{(window as any).syntheticClipboard=text;},readText:async()=>(window as any).syntheticClipboard}});const timeout=window.setTimeout.bind(window);window.setTimeout=((fn:()=>void,ms:number,...args:any[])=>{if(ms===30000){(window as any).clipboardCleanup=fn;return 0;}return timeout(fn,ms,...args);}) as typeof window.setTimeout;});
 await page.locator('[data-testid="copy-password"]').click();await page.waitForFunction(()=>typeof (window as any).clipboardCleanup==="function");await page.evaluate(()=>{(window as any).syntheticClipboard="user changed the clipboard";(window as any).clipboardCleanup();});await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>(window as any).syntheticClipboard),"user changed the clipboard");
 await page.locator('[data-testid="copy-password"]').click();await page.waitForTimeout(10);await page.evaluate(()=>(window as any).clipboardCleanup());await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>(window as any).syntheticClipboard),"");
 console.log("PASS clipboard permission denial, unchanged cleanup and changed-content preservation (stubbed clipboard)");
 await page.locator('[data-testid="delete-entry"]').click();await page.locator("#delete-dialog[open]").waitFor();await page.keyboard.press("Escape");assert(!(await page.locator("#delete-dialog").isVisible()));await page.locator('[data-testid="delete-entry"]').click();await page.locator("#delete-confirm").click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid="login"]').length===0);
 console.log("PASS delete modal Escape and confirmed deletion");

 // Delay encryption: locking must prevent the pending mutation from reaching the server.
 await page.locator("#new-entry").click();await page.locator("#entry-title").fill("Pending synthetic");await page.locator("#entry-password").fill("synthetic-pending-secret");
 await page.evaluate(()=>{const original=crypto.subtle.encrypt.bind(crypto.subtle);crypto.subtle.encrypt=(...args:any[])=>new Promise((resolve,reject)=>{(window as any).releaseEncrypt=()=>original(...args as Parameters<SubtleCrypto["encrypt"]>).then(resolve,reject);});});
 const beforePending=revision;await page.locator("#save-entry").click();await page.waitForFunction(()=>typeof (window as any).releaseEncrypt==="function");await page.locator("#lock").click();await page.evaluate(()=>{(window as any).releaseEncrypt();});await page.waitForTimeout(100);assert.equal(revision,beforePending);assert(await page.locator("#workspace").isHidden());assert.equal(await page.locator("#entry-password").inputValue(),"");
 await page.reload();await page.locator("#unlock:not([disabled])").waitFor();await page.locator("#master").fill("synthetic replacement password");
 // Delay decryption: pagehide must invalidate the async unlock result.
 await page.evaluate(()=>{const original=crypto.subtle.decrypt.bind(crypto.subtle);crypto.subtle.decrypt=(...args:any[])=>new Promise((resolve,reject)=>{(window as any).releaseDecrypt=()=>original(...args as Parameters<SubtleCrypto["decrypt"]>).then(resolve,reject);});});
 await page.locator("#unlock").click();await page.waitForFunction(()=>typeof (window as any).releaseDecrypt==="function");await page.evaluate(()=>{dispatchEvent(new PageTransitionEvent("pagehide"));(window as any).releaseDecrypt();});await page.waitForTimeout(100);assert(await page.locator("#workspace").isHidden());assert.equal(await page.locator("#entries").textContent(),"");
 console.log("PASS stale async encrypt/decrypt results cannot save or unlock after lock/pagehide");
 await page.evaluate(()=>dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})));await page.locator("#unlock:not([disabled])").waitFor();
 console.log("PASS restored page reloads gate after BFCache pageshow");
 await page.reload();await page.locator("#unlock:not([disabled])").waitFor();await page.locator("#master").fill("synthetic replacement password");await page.locator("#unlock").click();await page.locator("#workspace:not([hidden])").waitFor();
 for(const width of [320,375,414,768,1440]){await page.setViewportSize({width,height:900});const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert(size.scroll<=size.width,`overflow at ${width}: ${size.scroll}`);}
 console.log("PASS responsive widths 320/375/414/768/1440");
 await page.evaluate(()=>{const original=Date.now;Date.now=()=>original()+301000;});await page.locator("#workspace[hidden]").waitFor({state:"attached",timeout:2500});assert.equal(await page.locator("#entry-password").inputValue(),"");
 console.log("PASS 5min idle lock (controlled clock)");
 assert.deepEqual(errors,[]);console.log("fixture browser acceptance passed",{writes:writes.length,backupRevision});
} finally {await browser?.close();server.stop(true);}
