import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { readFile,writeFile } from "node:fs/promises";
const config=JSON.parse(await readFile(process.env.HEAVENKEY_DNS_CONFIG!,"utf8")),origin="http://localhost:18398";
const baseline=process.env.HEAVENKEY_DNS_BASELINE==="1",chrome=process.env.CHROME_PATH||"/usr/bin/google-chrome";
const master="DNS-fixture-master-only!",username="dns-synthetic-user",password="DNS-synthetic-password-only!";
const browser=await chromium.launch({headless:true,executablePath:chrome,args:process.env.HEAVENKEY_DNS_CONTAINER==="1"?["--no-sandbox"]:[]});const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(15000);
const page=await context.newPage();let token="",passed=false,failure="";const cases:string[]=[],responses:string[]=[],observations:any[]=[];
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(fn:()=>Promise<T>,ok:(v:T)=>boolean,seconds=25){const end=Date.now()+seconds*1000;for(;;){const v=await fn();if(ok(v))return v;if(Date.now()>end)throw Error("DNS acceptance deadline");await delay(200);}}
async function owner(path:string,body?:unknown){const r=await fetch(origin+path,{method:body===undefined?"GET":"POST",headers:{Origin:origin,"X-HeavenKey-Client":"password-manager","X-HeavenKey-Token":token,...(body===undefined?{}:{"Content-Type":"application/json"})},signal:AbortSignal.timeout(15000),...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.status,200,path);return await r.json() as any;}
async function agent(action:string,client:string,body:unknown){const r=await fetch(origin+"/api/password-broker/agent/"+action,{method:"POST",headers:{"X-HeavenKey-Client":"password-agent","X-HeavenKey-Token":client,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const text=await r.text();responses.push(text);assert.equal(r.status,200,"Agent operation "+action);return JSON.parse(text);}
async function facts(ip:string,path="/facts"){const r=await fetch("http://"+ip+":18801"+path,{signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json() as any;}
async function settings(){if(await page.locator("#settings-view").isHidden())await page.locator("#nav-settings").click();}
async function addLogin(title:string,url:string){if(await page.locator("#settings-view").isVisible())await page.locator("#close-settings").click();await page.locator("#new-entry").click();for(const[id,v]of[["title",title],["username",username],["password",password],["url",url]])await page.locator("#entry-"+id).fill(v);await page.locator("#save-entry").click();await page.locator("#editor").waitFor({state:"hidden"});await page.locator("#workspace[aria-busy=false]").waitFor();}
try{
 console.log('phase: wait app health');
 await until(async()=>{try{return(await fetch(origin+"/health",{signal:AbortSignal.timeout(500)})).ok}catch{return false}},Boolean);
 const c=await fetch(origin+"/api/password-vault/config",{headers:{Origin:origin,"X-HeavenKey-Client":"password-manager"}});token=(await c.json() as any).token;
 await page.goto(origin+"/passwords/");await page.locator("#master").fill(master);await page.locator("#master-confirm").fill(master);await page.locator("#unlock").click();await page.locator("#workspace[aria-busy=false]:not([hidden])").waitFor();
 for(const[title,url]of[["Rebinding target","https://rebind.heavenkey.test/login"],["Private answer","https://private.heavenkey.test/login"],["Mixed answers","https://mixed.heavenkey.test/login"]])await addLogin(title,url);
 await settings();await page.locator("#protected-pair:not([disabled])").waitFor();const pairing=page.waitForResponse(r=>r.url().endsWith("/protected-pairing")&&r.request().method()==="POST");await page.locator("#protected-pair").click();const code=(await(await pairing).json()).code;const cr=await fetch(origin+"/api/password-broker/agent/connect",{method:"POST",headers:{"X-HeavenKey-Client":"password-agent","Content-Type":"application/json"},body:JSON.stringify({code,label:"DNS synthetic agent"})});assert.equal(cr.status,200);const client=await cr.json() as any;
 await delay(3200);
 for(const title of ["Rebinding target","Private answer","Mixed answers"]){
  await page.locator("#protected-new:not([disabled])").click();await page.locator("#protected-client").selectOption(client.client_id);const choice=page.locator("#protected-source option").filter({hasText:title});await page.locator("#protected-source").selectOption((await choice.getAttribute("value"))!);
  for(const[k,v]of[["person","Synthetic DNS Person"],["email","dns-private@example.invalid"],["case","DNS-CASE-1"]])await page.locator("#protected-"+k).fill(v);
  const published=page.waitForResponse(r=>r.url().endsWith("/protected/workspaces")&&r.request().method()==="POST");await page.locator("#protected-publish").click();const publish=await published;assert.equal(publish.status(),200);const workspace=publish.request().postDataJSON().workspace_id;await page.locator("#protected-composer-dialog").waitFor({state:"hidden"});
  const request=await agent("protected-login",client.token,{workspace_id:workspace});await page.locator("#broker-review-"+request.request_id).click();await page.locator("#broker-consent").check();await page.locator("#broker-approve").click();await page.locator("#broker-approval-dialog").waitFor({state:"hidden"});
  const state=await until(()=>owner("/api/password-broker"),row=>row.requests.some((r:any)=>r.id===request.request_id&&["ready","failed"].includes(r.status)));const actual=state.requests.find((r:any)=>r.id===request.request_id);
  const projection=await agent("status",client.token,{request_id:request.request_id});if(!baseline){assert.deepEqual(projection,{status:"approved"});const listing=await agent("protected-list",client.token,{});const item=listing.workspaces.find((w:any)=>w.workspace_id===workspace);assert.equal(item.status,"approved");assert(!JSON.stringify(item).includes("session_id"));}
  const good=await facts(config.good),evil=await facts(config.evil),app=await facts(config.app);
  observations.push({title,actual_status:actual.status,error:actual.error,good,evil,app,dns:await facts(config.dns)});
  if(title==="Rebinding target"){
   assert.equal(actual.status,"ready");assert.equal(good.valid_login_posts,1,"Approved credentials did not stay on the initially resolved server");assert.equal(evil.login_posts,0,"Rebound server received a login attempt");
   assert.equal(app.launches.length,1);assert(app.launches[0].resolver_rules.some((s:string)=>s.includes("rebind.heavenkey.test")&&s.includes("93.184.216.10")));assert.deepEqual(app.launches[0].prelaunch_dns_answers,["93.184.216.11"]);
   const changed=await facts(config.app,"/resolve");assert.deepEqual(changed.answers,["93.184.216.11"]);cases.push("Real DNS changes before Chromium starts, but login and redirects remain on the approved pinned IP");
  }else{assert.equal(actual.status,"failed");assert.equal(app.launches.length,1,"Private/mixed DNS answer started a browser");assert.equal(good.valid_login_posts,1);assert.equal(evil.login_posts,0);cases.push(title+" fails closed before Chromium or credential dispatch");}
 }
 for(const value of[username,password,master,"Synthetic DNS Person","dns-private@example.invalid","DNS-CASE-1"])assert(!responses.join("\n").includes(value));
 cases.push("Actual ready/failed website outcomes produce the same protected approval-only projection");passed=true;
} catch(error){failure=error instanceof Error?error.message:String(error);throw error;}
finally{await browser.close();await writeFile(config.driver_report,JSON.stringify({pass:passed,baseline,cases,failure,observations,fixture_scope:"Actual private Docker network, controlled UDP DNS, real HTTPS and Chromium. Fixture wrapper trusts one synthetic certificate SPKI and disables Chromium sandbox only inside test container. Product TLS validation is unchanged; no host DNS/trust-store mutation or WAN target."},null,2)+"\n");}
