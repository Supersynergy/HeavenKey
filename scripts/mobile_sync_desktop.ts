import { chromium, type Page } from 'playwright-core';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { chmodSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dir, '..');
const origin = 'http://localhost:18360';
const scratch = mkdtempSync(join(tmpdir(), 'heavenkey-desktop-sync-'));
const codePath = process.env.HEAVENKEY_PAIR_FILE ?? '/tmp/heavenkey-connected-pair.code';
const socketPath = process.env.HEAVENKEY_DESKTOP_SOCKET ?? '/tmp/heavenkey-connected-desktop.sock';
const master = 'Synthetic-Desktop-Sync-Passphrase-2026!';
const cases: string[] = [];
let backend: ChildProcess | undefined, chrome: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined, page: Page;
let control: ReturnType<typeof createServer> | undefined;
let commandTail: Promise<void> = Promise.resolve();
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function ready() { await page.locator('#workspace:not([hidden])[aria-busy=false]').waitFor({timeout:15_000}); }
async function unlock() {
  if (await page.locator('#master').isVisible()) {
    await page.locator('#unlock:not([disabled])').waitFor(); await page.locator('#master').fill(master);
    if (await page.locator('#master-confirm').isVisible()) await page.locator('#master-confirm').fill(master);
    await page.locator('#unlock').click(); await ready();
  }
}
async function settings() { await unlock(); await page.locator('#nav-settings').click(); }
async function sync() {
  await settings(); await page.locator('[data-sync-id]').first().click(); await ready();
  const text = await page.locator('#status').textContent();
  assert(text?.includes('synchronisiert'), text ?? 'Desktop sync failed');
}
async function create(title: string) {
  await unlock(); await page.locator('#nav-all').click(); await page.locator('#new-entry').click();
  await page.locator('#entry-title').fill(title); await page.locator('#entry-username').fill('desktop@example.test');
  await page.locator('#entry-password').fill('Synthetic-Desktop-Password-25'); await page.locator('#entry-url').fill('https://example.test/login');
  await page.locator('#entry-notes').fill('Preserved desktop metadata'); await page.locator('#entry-tags').fill('desktop, preserved');
  await page.locator('#entry-favorite').check(); await page.locator('#save-entry').click(); await ready();
}
async function edit(title: string, values: {password?: string; notes?: string}) {
  await unlock(); await page.locator('#nav-all').click(); await page.locator('#entries').getByText(title, {exact:true}).click();
  await page.locator('[data-testid=edit-entry]').click();
  if (values.password) await page.locator('#entry-password').fill(values.password);
  if (values.notes) await page.locator('#entry-notes').fill(values.notes);
  await page.locator('#save-entry').click(); await ready();
}
async function remove(title: string) {
  await unlock(); await page.locator('#nav-all').click(); await page.locator('#entries').getByText(title,{exact:true}).click();
  await page.locator('[data-testid=delete-entry]').click(); await page.locator('#delete-confirm').click(); await ready();
}
async function mkCheck(expression: string) {
  const tabs = JSON.parse(execFileSync('mk',['act','--cdp','19339','tab list'],{encoding:'utf8',timeout:15_000}));
  const target = tabs.tabs.find((tab: {url:string}) => tab.url.startsWith(origin + '/passwords'));
  assert(target);
  const result=JSON.parse(execFileSync('mk',['act','--cdp','19339',`tab switch ${target.n};;eval ${expression}`],{encoding:'utf8',timeout:15_000}));
  assert(result.ok && JSON.parse(result.value)===true);
  writeFileSync(join(root,'docs/evidence/mobile/desktop-sync-mk.json'),JSON.stringify(result,null,2)+'\n');
}
async function command(name: string) {
  if (name==='pair') {
    await unlock(); await page.locator('#nav-all').click();
    if (!await page.locator('#entries').getByText('Desktop sync fixture',{exact:true}).count()) await create('Desktop sync fixture');
    await settings();
    while (await page.getByRole('button',{name:'Verbindung widerrufen',exact:true}).count()) {
      await page.getByRole('button',{name:'Verbindung widerrufen',exact:true}).first().click(); await ready();
    }
    await page.locator('#sync-host').fill('10.0.2.2'); await page.locator('#sync-label').fill('Isolated Android emulator');
    await page.locator('#sync-pair').click(); await page.locator('#sync-pair-code:not([hidden])').waitFor({timeout:15_000});
    const code=await page.locator('#sync-pair-code').inputValue(); assert(code.startsWith('hks1_'));
    writeFileSync(codePath,code,{mode:0o600});
    await mkCheck("document.querySelector('#sync-pair-code').value.startsWith('hks1_') && document.querySelectorAll('[data-sync-id]').length === 1");
  } else if(name==='receive') {
    await sync(); await page.locator('#nav-all').click(); await page.locator('#entries').getByText('Desktop sync fixture',{exact:true}).click();
    await page.locator('[data-testid=edit-entry]').click(); assert.equal(await page.locator('#entry-password').inputValue(),'Synthetic-Native-Changed-25');
    assert.equal(await page.locator('#entry-url').inputValue(),'https://example.test/login');
    assert.equal(await page.locator('#entry-tags').inputValue(),'desktop, preserved');
    assert(await page.locator('#entry-favorite').isChecked());
    await page.locator('#cancel-entry').click(); await settings();
    assert((await page.locator('#website-passkeys').textContent())?.includes('heavenkey.test'),'Native-created website passkey reaches encrypted desktop vault');
    await mkCheck("document.querySelector('#website-passkeys').textContent.includes('heavenkey.test')");
  } else if(name==='edit') { await edit('Desktop sync fixture',{notes:'Desktop changed note'});await sync();
  } else if(name==='verify_deleted') {
    await sync();await page.locator('#nav-all').click();assert.equal(await page.locator('#entries').getByText('Desktop sync fixture',{exact:true}).count(),0);
    await create('Desktop delete probe');await sync();
  } else if(name==='delete_probe') { await remove('Desktop delete probe');await sync();
  } else if(name==='conflict_seed') { await create('Conflict fixture');await sync();
  } else if(name==='conflict_edit') { await edit('Conflict fixture',{password:'Synthetic-Desktop-Conflict-25'});await sync();
  } else if(name==='conflict_advance') { await edit('Conflict fixture',{notes:'Desktop advanced conflict'});await sync();
  } else if(name==='verify_resolution') { await sync(); await page.locator('#nav-all').click();await page.locator('#entries').getByText('Conflict fixture',{exact:true}).click();await page.locator('[data-testid=edit-entry]').click();assert.equal(await page.locator('#entry-password').inputValue(),'Synthetic-Desktop-Conflict-25');await page.locator('#cancel-entry').click();
  } else if(name==='revoke') { await settings();await page.getByRole('button',{name:'Verbindung widerrufen',exact:true}).click();await ready();
  } else throw new Error('Unknown desktop fixture command');
  cases.push(name);writeFileSync(join(root,'docs/evidence/mobile/desktop-sync-stages.json'),JSON.stringify({cases,synthetic_only:true},null,2)+'\n');
  console.log('SYNC_DESKTOP_DONE '+name);
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode!==null) return;
  child.kill('SIGINT');for(let i=0;i<50&&child.exitCode===null;i++)await pause(100);
  if(child.exitCode===null)child.kill('SIGKILL');
}
try {
  backend=spawn(join(root,'target/debug/uac-api'),['--password-manager','--port','18360','--data-dir',join(scratch,'vault')],{stdio:['ignore','pipe','pipe'],env:{...process.env,HEAVENKEY_PUBLIC_ORIGIN:undefined,HEAVENKEY_ORIGIN:undefined,HEAVENKEY_SHARE_ORIGIN:undefined}});
  for(let i=0;i<100;i++){try{if((await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}await pause(100);}
  assert.equal(backend.exitCode,null,'Actual desktop backend must run');
  chrome=spawn(process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--disable-background-networking','--use-mock-keychain','--remote-debugging-port=19339','--user-data-dir='+join(scratch,'chrome'),'about:blank'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:19339',{timeout:1000});break;}catch{}await pause(100);}
  assert(browser,'Own desktop browser required');page=await browser.contexts()[0].newPage();page.setDefaultTimeout(15_000);await page.setViewportSize({width:1440,height:1000});
  await page.goto(origin);await unlock();
  control=createServer(client=>{
    client.setTimeout(45_000,()=>client.destroy());let input='';
    client.on('data',chunk=>{input+=chunk;if(input.length>2048){client.destroy();return;}if(!input.includes('\n'))return;
      const line=input.split('\n')[0];input='';
      commandTail=commandTail.then(async()=>{try{await command(JSON.parse(line).command);client.end('{"ok":true}\n');}catch(error){client.end(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)})+'\n');}});
    });
  });
  await new Promise<void>((ok,fail)=>{control!.once('error',fail);control!.listen(socketPath,ok);});chmodSync(socketPath,0o600);
  console.log('SYNC_DESKTOP_READY');
  const input=createInterface({input:process.stdin});
  for await(const line of input){if(line.trim()==='stop')break;commandTail=commandTail.then(async()=>{try{await command(JSON.parse(line).command);}catch(error){console.error('SYNC_DESKTOP_ERROR '+(error instanceof Error?error.message:String(error)));}});await commandTail;}
} finally {
  if(control){await new Promise<void>(ok=>control!.close(()=>ok()));rmSync(socketPath,{force:true});}
  await browser?.close();await stop(chrome);await stop(backend);rmSync(codePath,{force:true});rmSync(scratch,{recursive:true,force:true});
}
