/** Live acceptance with an explicit dedicated test account; isolated browser/vault. */
import { chromium, type BrowserContext } from 'playwright-core';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { createVault, openVault } from '../apps/web/src/passwords-crypto';

export function assertOwnedListener(pid:number,port:number):void {
  assert(Number.isSafeInteger(pid)&&pid>0&&Number.isInteger(port)&&port>0&&port<65536,'Invalid owned listener');
  const found=execFileSync(process.platform==='darwin'?'/usr/sbin/lsof':'lsof',['-a','-p',String(pid),'-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-t'],{timeout:5000,stdio:['ignore','pipe','ignore']}).toString().trim().split(/\s+/);
  assert(found.length===1&&found[0]===String(pid),'Owned process must hold the listening socket');
}

async function main(){
const executablePath=process.env.CHROME_PATH;
const reportPath=process.env.HEAVENKEY_OFFICE_REPORT;
assert(reportPath&&isAbsolute(reportPath),'Explicit absolute report path required');
await writeFile(reportPath,JSON.stringify({passed:false,stage:'starting',cases:[]}),{mode:0o600});
const site='https://app.supersynergy.de', root=fileURLToPath(new URL('..',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'heavenkey-office-demo-'));
const reservation=createServer();await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
const address=reservation.address();assert(address&&typeof address==='object');const port=address.port;
await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
const origin=`http://localhost:${port}`, master=randomBytes(32).toString('base64url');
let browser:BrowserContext|undefined, server:ChildProcess|undefined;
let network:Record<string,unknown>={}, sitePage: import("playwright-core").Page|undefined;
let stage="public-login", diagnostic: import("playwright-core").Page|undefined;
let passed=false;
const cases:string[]=[];
const pass=(name:string)=>{cases.push(name);console.log('PASS '+name);};
try {
  assert(executablePath,'CHROME_PATH must explicitly select the acceptance browser');
  const credentialsPath=process.env.HEAVENKEY_OFFICE_CREDENTIALS_FILE;
  assert(credentialsPath,'Dedicated test credentials required; the public demo uses /demo-enter instead of password authentication');
  assert(((await stat(credentialsPath)).mode & 0o077)===0,'Test credential file must be private (0600)');
  const demo=JSON.parse(await readFile(credentialsPath,'utf8')) as {email:string;password:string;landingPath:string;totp:string};
  assert(typeof demo.email==='string'&&demo.email.includes('@')&&typeof demo.password==='string'&&demo.password.length>0&&demo.password.length<=1024,'Invalid dedicated test account');
  assert(typeof demo.landingPath==='string'&&/^\/[a-z0-9-]+\/dashboard$/.test(demo.landingPath),'Explicit tenant dashboard path required');
  assert(typeof demo.totp==='string'&&/^[A-Z2-7]{16,128}$/.test(demo.totp),'Dedicated MFA secret required');
  const extension=join(temporary,'extension');await cp(join(root,'dist/extension-source-chromium'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  manifest.host_permissions=['http://localhost/*',site+'/*'];
  await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  server=spawn(join(root,'target/debug/uac-api'),['--password-manager','--port',String(port),'--data-dir',join(temporary,'data')],{stdio:['ignore','pipe','ignore']});
  let ready=false,output='',spawnError=false;
  server.once('error',()=>{spawnError=true;});server.stdout!.on('data',(bytes:Buffer)=>{output=(output+bytes.toString()).slice(-8192);});
  for(let i=0;i<100;i++){assert(!spawnError&&server.exitCode===null&&server.signalCode===null,'Owned service exited before readiness');ready=output.split('\n').some(line=>line.startsWith('HeavenKey ')&&line.endsWith(origin+'/passwords/'));if(ready)break;await delay(100);}
  assert(ready,'Isolated vault service must become ready');
  const own=()=>{assert(server?.pid&&server.exitCode===null&&server.signalCode===null,'Owned service is not alive');assertOwnedListener(server.pid,port);};own();
  const headers:Record<string,string>={'X-HeavenKey-Client':'password-manager','Origin':origin,'Content-Type':'application/json'};
  const config=await(await fetch(origin+'/api/password-vault/config',{headers})).json() as {token:string};headers['X-HeavenKey-Token']=config.token;
  const api=async(path='',body?:unknown)=>{own();const r=await fetch(origin+'/api/password-vault'+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});assert(r.ok,'Vault HTTP request failed');return r.json();};
  browser=await chromium.launchPersistentContext(join(temporary,'browser'),{executablePath,headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run'],viewport:{width:1280,height:900}});
  browser.setDefaultTimeout(20000);
  const manager=await browser.newPage();await manager.goto('chrome://extensions');const item=manager.locator('extensions-item').filter({hasText:'HeavenKey'});await item.waitFor();const id=await item.getAttribute('id');assert(id,'Unpacked HeavenKey must be installed');
  const target=await browser.newPage();sitePage=target;target.on('request',request=>{if(request.url()===site+'/login'&&request.method()==='POST'){try{const body=request.postDataJSON();network={submitted:true,emailMatches:body.email===demo.email,passwordMatches:body.password===demo.password};}catch{network={submitted:true,unparsed:true};}}});target.on('response',response=>{if(response.url()===site+'/login'&&response.request().method()==='POST')network.status=response.status();});await target.goto(site+'/login');
  const record=await createVault(master,{version:1,entries:[{id:'office-demo',title:'Office acceptance test',username:demo.email,password:demo.password,url:site+'/login',notes:'Dedicated acceptance account',totp:demo.totp,tags:[],favorite:false}]});
  await api('',{expected_revision:0,record:record.envelope});
  const persisted=await api() as {record:Parameters<typeof openVault>[0]};
  assert((await openVault(persisted.record,master)).vault.entries.length===1,'Encrypted roundtrip must preserve login');pass('encrypted saved test login survives vault read');

  const popup=await browser.newPage();diagnostic=popup;await popup.goto(`chrome-extension://${id}/popup.html`);await target.bringToFront();
  const targetId=await popup.evaluate(async()=>{const c=(globalThis as unknown as {chrome:{tabs:{query(o:unknown):Promise<{id:number}[]>}}}).chrome;const matches=await c.tabs.query({url:'https://app.supersynergy.de/login'});if(matches.length!==1)throw Error('Login tab must be unique');return matches[0].id;});
  await popup.goto(`chrome-extension://${id}/popup.html?target=${targetId}`);await popup.bringToFront();
  const pairing=await api('/extension/pairing',{}) as {code:string};
  await popup.locator('#pair-port').fill(String(port));await popup.locator('#pair-code').fill(pairing.code);await popup.locator('#pair-extension').click();await popup.locator('#unlock-form').waitFor({state:'visible'});
  await popup.locator('#extension-master').fill(master);await popup.locator('#unlock-extension').click();await popup.locator('#smart-workspace').waitFor({state:'visible'});pass('real browser extension pairs and unlocks the isolated vault');
  stage='select-and-scan';await popup.locator('[data-task="login"]').click();await popup.locator('[data-id="office-demo"]').click();await popup.locator('#scan-page').click();await popup.locator('#fill-confirmation').waitFor({state:'visible'});
  stage='map-fields';for(const checkbox of await popup.locator('#field-map [data-field]').all())await checkbox.uncheck();
  await popup.getByRole('checkbox',{name:/^Benutzername(?: oder E-Mail)? ·/}).check();await popup.getByRole('checkbox',{name:/^Passwort ·/}).check();
  stage='fill-fields';await popup.locator('#include-secrets').check();await popup.locator('#confirm-origin').check();await popup.locator('#fill-selected').click();
  await popup.waitForFunction(()=>document.querySelector('#smart-status')?.textContent?.includes('2 Felder gefüllt'));
  assert(await target.locator('input[type=password]').inputValue()===demo.password,'Saved password must fill the exact current-password target');
  assert(await target.locator('input[autocomplete=username]').inputValue()===demo.email,'Saved username must fill the live login form');pass('HeavenKey fills live exact-origin username and password after consent');
  assert(new URL(target.url()).pathname==='/login','Fill must never submit automatically');
  stage='website-submit';await target.locator('form button[type=submit]').click();await target.waitForURL(site+'/two-factor-challenge');await target.bringToFront();await target.locator('input[autocomplete=one-time-code]').waitFor({state:'visible'});pass('password step requires the real mandatory MFA challenge');
  stage='mfa-fill';await popup.bringToFront();await popup.locator('#scan-page').click();await popup.locator('#fill-confirmation').waitFor({state:'visible'});
  for(const checkbox of await popup.locator('#field-map [data-field]').all())await checkbox.uncheck();await popup.getByRole('checkbox',{name:/^Code ·/}).check();await popup.locator('#include-secrets').check();await popup.locator('#confirm-origin').check();await popup.locator('#fill-selected').click();await popup.waitForFunction(()=>document.querySelector('#smart-status')?.textContent?.includes('1 Felder gefüllt'));assert(/^\d{6}$/.test(await target.locator('input[name=code]').inputValue()),'Fresh OTP must be filled by HeavenKey');pass('HeavenKey fills a current OTP into the real MFA form after consent');
  stage='mfa-submit';await target.locator('form button[type=submit]').click();await target.waitForURL(site+demo.landingPath);await target.locator('h1').filter({hasText:'Heute'}).waitFor();pass('explicit MFA submit authenticates the dedicated account at its tenant');
  const landed=target.url();await target.reload();await target.locator('h1').filter({hasText:'Heute'}).waitFor();assert(target.url()===landed,'Authenticated destination must persist');pass('authenticated destination persists on reload');
  await popup.bringToFront();await popup.locator('#lock-extension').click();await popup.locator('#smart-workspace').waitFor({state:'hidden'});pass('locking discards the decrypted extension workspace');
  passed=true;
} catch { console.error(JSON.stringify({stage,network,path:sitePage ? new URL(sitePage.url()).pathname:null,loginErrors:await sitePage?.locator('form .text-red-600').allTextContents().catch(()=>[]),status:await diagnostic?.locator('#smart-status').textContent().catch(()=>null),fields:await diagnostic?.locator('#field-map').innerText().catch(()=>null)}));console.error('Office acceptance failed; credentials and page payload suppressed. Last completed checks: '+cases.join('; '));process.exitCode=1; }
finally{
  try{await browser?.close();if(server?.exitCode===null){server.kill('SIGINT');for(let i=0;i<40&&server.exitCode===null;i++)await delay(50);if(server.exitCode===null)server.kill('SIGKILL');}await rm(temporary,{recursive:true,force:true});}
  catch{passed=false;process.exitCode=1;}
  const report={passed,stage,browser:executablePath,site,source:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),scope:'isolated temporary profile and vault; explicit dedicated test account; no installed-profile extension',cases};
  await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
