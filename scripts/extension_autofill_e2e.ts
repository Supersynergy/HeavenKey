/** Real unpacked Chromium + Rust vault. No donor execution, remote API or real data. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVault, openVault } from '../apps/web/src/passwords-crypto';
const root = resolve(import.meta.dir,'..');
const temporary = await mkdtemp(join(tmpdir(),'heavenkey-smartfield-'));
const binary = resolve(process.env.HEAVENKEY_BINARY || 'target/debug/uac-api');
const extension = resolve(process.env.HEAVENKEY_EXTENSION || 'dist/extension-source-chromium');
const browserPath = process.env.CHROME_PATH || '/Users/master/Library/Caches/ms-playwright/chromium-1169/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
const origin = 'http://localhost:18257', master = 'Synthetic-extension-master-only!';
const cases: {name:string;pass:boolean}[] = [], errors: string[] = [];
let browser: any, processServer: any, output = '';
const check = (name:string, truth = true) => { assert(truth,name); cases.push({name,pass:true}); console.log(`PASS ${name}`); };
const fixture = Bun.serve({ hostname: '127.0.0.1', port: 18258, fetch(request) {
  if (new URL(request.url).pathname === '/frame') return new Response('<label>Email in frame<input name="email" autocomplete="email"></label>',{headers:{'Content-Type':'text/html'}});
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px sans-serif;max-width:1000px}label{display:inline-block;margin:4px}input,select,textarea,[contenteditable]{min-width:90px;min-height:22px}.hidden{display:none}#honey{position:absolute;left:-9000px}</style></head><body><form id="form"><label>Benutzername<input id="username" autocomplete="username"></label><label>Passwort<input id="password" type="password" autocomplete="current-password"></label><label>Einmalcode<input id="otp" autocomplete="one-time-code"></label><label>Vorname<input id="firstName" autocomplete="given-name"></label><label>Nachname<input id="lastName" autocomplete="family-name"></label><label>E-Mail<input id="email" type="email"></label><label>Land<select id="country" autocomplete="country"><option value=""></option><option value="DE">Germany</option></select></label><label>Geburtstag<input id="bday" type="date" autocomplete="bday"></label><label>Tag<input id="day" autocomplete="bday-day"></label><label>Monat<input id="month" autocomplete="bday-month"></label><label>Jahr<input id="year" autocomplete="bday-year"></label><label>Betrag<input id="amount" type="number" name="amount"></label><label>Nachricht<textarea id="message" name="message"></textarea></label><div id="editable" contenteditable="true" aria-label="Betreff" style="border:1px solid;min-height:25px"></div><label>Bankname<input id="bankName" name="bankName"></label><label>IBAN<input id="iban" name="iban"></label><label>Generische Nummer<input id="generic" name="number"></label><label>Name vorausgefüllt<input id="prefilled" autocomplete="name" value="Manual value"></label><label>Unsichtbar<input id="hidden" class="hidden" autocomplete="email"></label><label>Honeypot<input id="honey" autocomplete="email"></label><label>Deaktiviert<input id="disabled" disabled autocomplete="email"></label><label>Nur lesen<input id="readonly" readonly autocomplete="email"></label><label>Off<input id="off" autocomplete="off" name="email"></label><label>Ich akzeptiere AGB<input id="consent" type="checkbox" name="company_terms"></label><label>Zahlungsart Firma<input id="payment" type="radio" name="company_payment" value="Acme"></label><label>Geschäftskonto<input id="business" type="checkbox" name="company" value="Acme"></label><fieldset><legend>Anrede</legend><label>Herr<input id="mr" type="radio" name="salutation" value="Herr"></label><label>Frau<input id="ms" type="radio" name="salutation" value="Frau"></label></fieldset><button>Absenden</button></form><div id="shadow"></div><iframe src="http://127.0.0.1:18258/frame"></iframe><script>window.submissions=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submissions++});let shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<label>E-Mail Schatten<input id="shadow-email" autocomplete="email"></label>';window.inputEvents=0;document.addEventListener('input',()=>window.inputEvents++);</script></body></html>`,{headers:{'Content-Type':'text/html'}});
}});
async function start() {
  output = '';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(UAC_|HEAVENKEY_(PUBLIC_ORIGIN|ORIGIN|PASSWORD_MANAGER|KEY_FILE|DOCUMENT))/.test(key)));
  processServer = spawn(binary,['--password-manager','--port','18257','--data-dir',join(temporary,'data')],{env,stdio:['ignore','pipe','pipe']});
  processServer.stdout.on('data',(bytes:any)=>output+=bytes); processServer.stderr.on('data',(bytes:any)=>output+=bytes);
  const until = Date.now()+15000;
  while(Date.now()<until) { if(processServer.exitCode!==null) throw new Error(`Rust server exited: ${output}`);try{if((await fetch(origin+'/health',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await Bun.sleep(100); }
  throw new Error('Rust server startup timed out');
}
async function stop(){ if(!processServer||processServer.exitCode!==null)return;processServer.kill('SIGINT');const until=Date.now()+3000;while(processServer.exitCode===null&&Date.now()<until)await Bun.sleep(50);if(processServer.exitCode===null)processServer.kill('SIGKILL');}
try {
  await start();
  const grantedExtension=join(temporary,'extension');await cp(extension,grantedExtension,{recursive:true});
  const testManifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));testManifest.host_permissions=['http://localhost/*'];
  await writeFile(join(grantedExtension,'manifest.json'),JSON.stringify(testManifest));
  browser = await chromium.launchPersistentContext(join(temporary,'profile'),{headless:true,executablePath:browserPath,args:[`--disable-extensions-except=${grantedExtension}`,`--load-extension=${grantedExtension}`,'--disable-background-networking','--no-first-run'],viewport:{width:1200,height:1000},timeout:30000});
  const manager = await browser.newPage(); await manager.goto('chrome://extensions');
  const item = manager.locator('extensions-item').filter({hasText:'HeavenKey'});await item.waitFor(); const id = await item.getAttribute('id');assert.match(id,/^[a-p]{32}$/);
  const target = await browser.newPage();await target.goto('http://localhost:18258/');
  const popup = await browser.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`); popup.on('pageerror',(e:any)=>errors.push(e.message));
  // Query the actual browser tab ID; all following scripting calls use native APIs.
  await target.bringToFront();
  const targetId = await popup.evaluate(async () => { const ext=(globalThis as any).chrome;return (await ext.tabs.query({active:true,currentWindow:true}))[0].id; });
  await popup.goto(`chrome-extension://${id}/popup.html?target=${targetId}`);
  const app = await browser.newPage();await app.goto(origin+'/passwords/');
  const appApi = async (path:string,body?:any,method?:string) => app.evaluate(async ({path,body,method})=>{const headers:any={'X-HeavenKey-Client':'password-manager'};const {token}=await(await fetch('/api/password-vault/config',{headers})).json();headers['X-HeavenKey-Token']=token;if(body)headers['Content-Type']='application/json';const response=await fetch('/api/password-vault'+path,{method:method||(body?'POST':'GET'),headers,...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw Error(`App API ${response.status}`);return response.json();},{path,body,method});
  if(!process.argv.includes('--engine-only')) {
  const generated = await createVault(master,{version:1,entries:[{id:'synthetic-login',title:'Synthetic login',username:'alex@example.invalid',password:'Synthetic-login-only#42',url:'http://localhost:18258/login',notes:'',totp:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',tags:[],favorite:false},{id:'wrong-origin',title:'Other origin login',username:'wrong',password:'SyntheticWrongOrigin',url:'https://other.invalid',notes:'',totp:'',tags:[],favorite:false}],profiles:[{id:'synthetic-profile',title:'Synthetic contact',entities:{firstName:'Alex',lastName:'Muster',email:'alex@example.invalid',name:'Alex Muster',country:'Deutschland',birthdate:'1990-03-14',amount:'1.234,56 EUR',message:'Synthetic message',subject:'Synthetic subject',iban:'DE89370400440532013000',bankName:'Synthetic Bank',company:'Acme',salutation:'Herr'},updatedAt:new Date().toISOString()}]} as any);
  await appApi('',{expected_revision:0,record:generated.envelope});
  const pairing=await appApi('/extension/pairing',{});
  await popup.locator('#pair-port').fill('18257');await popup.locator('#pair-code').fill(pairing.code);
  await popup.locator('#pair-extension').click();
  await popup.locator('#unlock-form').waitFor({state:'visible',timeout:10000}).catch(async e=>{console.log(await popup.locator('#smart-status').textContent());console.log(await popup.evaluate(async()=>({permissions:await (globalThis as any).chrome.permissions.getAll(),status:document.querySelector('#smart')?.getAttribute('aria-busy')})));throw e;});
  check('unpacked extension with declared test-only localhost grant; real Rust one-use pairing');
  await popup.locator('#extension-master').fill(master);await popup.locator('#unlock-extension').click();await popup.locator('#smart-workspace').waitFor({state:'visible',timeout:10000}).catch(async e=>{console.log('Unlock status:',await popup.locator('#smart-status').textContent(),errors);throw e;});
  check('real Rust encrypted snapshot decrypted in popup');
  const stored=await popup.evaluate(async()=>await (globalThis as any).chrome.storage.local.get(null));check('browser storage has connection/token only',Object.keys(stored).join()==='heavenkey.extension.v1'&&!JSON.stringify(stored).includes(master)&&!JSON.stringify(stored).includes('Synthetic-login-only'));
    const uiStatus=async(text:string)=>popup.waitForFunction(text=>document.querySelector('#smart-status')!.textContent!.includes(text),text);
  await popup.locator('[data-id="synthetic-profile"]').click();await popup.locator('#scan-page').click();await popup.locator('#fill-confirmation').waitFor({state:'visible'});
  await popup.locator('#fill-selected').click();await uiStatus('ausdrücklich bestätigen');check('popup requires fresh explicit target-origin confirmation',await target.locator('#firstName').inputValue()==='');
  for(const box of await popup.locator('#field-map [data-field]').all()) await box.uncheck();
  await popup.getByRole('checkbox',{name:/^Vorname ·/}).check();await popup.locator('#confirm-origin').check();await popup.locator('#fill-selected').click();await uiStatus('1 Felder gefüllt');
  check('real popup selective profile fill changes only selected field',await target.locator('#firstName').inputValue()==='Alex'&&await target.locator('#lastName').inputValue()==='');await popup.locator('#undo-fill').click();await uiStatus('1 Felder zurückgesetzt');
  await popup.locator('[data-id="wrong-origin"]').click();await popup.locator('#scan-page').click();await uiStatus('anderen Herkunft');check('popup rejects login saved for a different exact origin',await target.locator('#password').inputValue()==='');
  await popup.locator('[data-id="synthetic-login"]').click();await popup.locator('#scan-page').click();await popup.locator('#fill-confirmation').waitFor({state:'visible'});
  for(const box of await popup.locator('#field-map [data-field]').all()) await box.uncheck();
  for(const text of ['Benutzername','Passwort','Einmalcode']) await popup.getByRole('checkbox',{name:new RegExp('^'+text+' ·')}).check();
  await popup.locator('#include-secrets').check();await popup.locator('#confirm-origin').check();await popup.locator('#fill-selected').click();await uiStatus('3 Felder gefüllt');
  check('exact-origin login and fresh TOTP fill through real popup',await target.locator('#username').inputValue()==='alex@example.invalid'&&await target.locator('#password').inputValue()==='Synthetic-login-only#42'&&/^\d{6}$/.test(await target.locator('#otp').inputValue()));
  await popup.locator('#undo-fill').click();await uiStatus('3 Felder zurückgesetzt');
  await popup.locator('#smart-workspace details > summary').click();await popup.locator('#source-text').fill('First name: Jamie\nLast name: Example\nEmail: jamie@example.invalid');await popup.locator('#extract-text').click();await popup.locator('[data-entity="firstName"]').fill('Jana');await popup.locator('#profile-title').fill('Saved from editable text');await popup.locator('#save-profile').click();await uiStatus('Profil verschlüsselt gespeichert');
  const saved=await appApi(''),opened=await openVault(saved.record,master);check('text extraction/edit/encrypted CAS profile save preserves all logins and profiles',opened.vault.version===2&&opened.vault.entries.length===2&&opened.vault.profiles?.length===2&&opened.vault.profiles.some(p=>p.title==='Saved from editable text'&&p.entities.firstName==='Jana'));
  const disk=await readFile(join(temporary,'data/passwords.sqlite'));check('real persisted SQLite has no profile plaintext or login secrets',!disk.includes(Buffer.from('Jana'))&&!disk.includes(Buffer.from('Synthetic-login-only#42'))&&!JSON.stringify(saved).includes(master));
  await appApi('',{expected_revision:saved.revision,record:saved.record});await popup.locator('[data-entity="firstName"]').fill('Conflict edit');await popup.locator('#save-profile').click();await popup.locator('#smart-workspace').waitFor({state:'hidden'});check('stale extension revision cannot overwrite vault; popup locks on conflict',!JSON.stringify(await appApi('')).includes('Conflict edit'));
  await popup.locator('#extension-master').fill(master);await popup.locator('#unlock-extension').click();await popup.locator('#smart-workspace').waitFor({state:'visible'});
  await popup.reload();await popup.locator('#unlock-form').waitFor({state:'visible'});check('popup reload discards decrypted session and key',await popup.locator('#smart-workspace').isHidden()&&await popup.locator('#extension-master').inputValue()==='');
  await popup.locator('#extension-master').fill(master);await popup.locator('#unlock-extension').click();await popup.locator('#smart-workspace').waitFor({state:'visible'});

  for (const cancel of ['lock', 'pagehide', 'disconnect']) {
    await popup.locator('[data-id="synthetic-profile"]').click();await popup.locator('#scan-page').click();await popup.locator('#fill-confirmation').waitFor({state:'visible'});
    for (const box of await popup.locator('#field-map [data-field]').all()) await box.uncheck();
    await popup.getByRole('checkbox',{name:/^Vorname ·/}).check();await popup.locator('#confirm-origin').check();
    // Delay completion of the native installation call to exercise cancellation
    // before plaintext dispatch. Pairing, ciphertext and DOM calls remain real.
    await popup.evaluate(() => {
      const ext=(globalThis as any).chrome, state:any={waiting:false,fills:0};
      state.original=ext.scripting.executeScript.bind(ext.scripting);
      ext.scripting.executeScript=async(request:any)=>{
        if(request.args?.[0]?.action==='fill')state.fills++;
        const result=await state.original(request);
        if(request.files){state.waiting=true;await new Promise(resolve=>state.release=resolve);}
        return result;
      };
      (globalThis as any).__cancellationTest=state;
    });
    await popup.locator('#fill-selected').click();await popup.waitForFunction(()=>(globalThis as any).__cancellationTest.waiting);
    check(`${cancel} keeps source and consent controls disabled during pending fill`,await popup.locator('#include-secrets').isDisabled()&&await popup.locator('[data-entity="firstName"]').isDisabled()&&await popup.locator('[data-id="synthetic-profile"]').isDisabled());
    if(cancel==='lock')await popup.locator('#lock-extension').click();
    else if(cancel==='disconnect')await popup.locator('#disconnect').click();
    else await popup.evaluate(()=>dispatchEvent(new Event('pagehide')));
    const lockedStatus=await popup.locator('#smart-status').textContent();
    await popup.evaluate(()=>(globalThis as any).__cancellationTest.release());
    await popup.waitForFunction(()=>document.querySelector('#smart')?.getAttribute('aria-busy')==='false');
    check(`${cancel} cancels pending fill before plaintext dispatch and preserves locked status`,
      await target.locator('#firstName').inputValue()===''&&await popup.evaluate(()=>(globalThis as any).__cancellationTest.fills===0)&&await popup.locator('#smart-status').textContent()===lockedStatus);
    await popup.evaluate(()=>{const state=(globalThis as any).__cancellationTest;(globalThis as any).chrome.scripting.executeScript=state.original;delete(globalThis as any).__cancellationTest;});
    if(cancel==='disconnect') {
      const pairing=await appApi('/extension/pairing',{});await popup.locator('#pair-port').fill('18257');await popup.locator('#pair-code').fill(pairing.code);await popup.locator('#pair-extension').click();await popup.locator('#unlock-form').waitFor({state:'visible',timeout:10000}).catch(async error=>{console.log('Re-pair diagnostic',await popup.locator('#smart-status').textContent(),await popup.locator('#pair-port').inputValue(),await popup.locator('#smart').getAttribute('aria-busy'));throw error;});
    }
    await popup.locator('#extension-master').fill(master);await popup.locator('#unlock-extension').click();await popup.locator('#smart-workspace').waitFor({state:'visible'});
  }

}
  const invoke=async(action:string,args:any={})=>popup.evaluate(async({targetId,action,args})=>{const ext=(globalThis as any).chrome;await ext.scripting.executeScript({target:{tabId:targetId,frameIds:[0]},world:'ISOLATED',files:['content.js']});const [r]=await ext.scripting.executeScript({target:{tabId:targetId,frameIds:[0]},world:'ISOLATED',func:(req:any)=>{try{return{ok:true,value:(globalThis as any).__heavenkeyEngine(req)}}catch(e){return{ok:false,error:String(e)}}},args:[{action,origin:'http://localhost:18258',href:'http://localhost:18258/',...args}]});return r.result;},{targetId,action,args});
  const scan = await invoke('scan');assert(scan.ok); const fields=scan.value.fields;
  check('scan excludes hidden/honeypot/disabled/readonly/off/consent/payment',!fields.some((f:any)=>/Unsichtbar|Honeypot|Deaktiviert|Nur lesen|^Off$|AGB|Zahlungsart/.test(f.field)));

  check('bank-name target is independently classified as sensitive',fields.some((f:any)=>f.entity==='bankName'&&f.sensitive));
  const payload={username:'alex@example.invalid',password:'Synthetic-login-only#42',otp:'123456',firstName:'Alex',lastName:'Muster',email:'alex@example.invalid',name:'Alex Muster',country:'Deutschland',birthdate:'1990-03-14',amount:'1.234,56 EUR',message:'Synthetic message',subject:'Synthetic subject',iban:'DE89370400440532013000',bankName:'Synthetic Bank',company:'Acme',salutation:'Herr'};
  const selected=fields.filter((f:any)=>f.entity).map((f:any)=>({id:f.id,entity:f.entity}));
  const filled=await invoke('fill',{scan:scan.value.scan,entities:payload,selected,choices:true});assert(filled.ok);
  check('select/date/split date/number/textarea/contenteditable/native event fill',await target.locator('#country').inputValue()==='DE'&&await target.locator('#bday').inputValue()==='1990-03-14'&&await target.locator('#day').inputValue()==='14'&&await target.locator('#month').inputValue()==='03'&&await target.locator('#year').inputValue()==='1990'&&await target.locator('#amount').inputValue()==='1234.56'&&await target.locator('#message').inputValue()==='Synthetic message'&&await target.locator('#editable').innerText()==='Synthetic subject'&&await target.evaluate(()=>((window as any).inputEvents)>0));
  check('open shadow roots filled; frame remains untouched',await target.locator('#shadow-email').inputValue()==='alex@example.invalid'&&await target.frames().find((frame:any)=>frame.url().includes('/frame'))!.locator('input').inputValue()==='');
  check('secret and sensitive fields denied without opt-ins',await target.locator('#password').inputValue()===''&&await target.locator('#otp').inputValue()===''&&await target.locator('#iban').inputValue()===''&&await target.locator('#bankName').inputValue()==='');
  check('checkbox/radio values matched while consent/payment remain untouched',await target.locator('#business').isChecked()&&await target.locator('#mr').isChecked()&&!await target.locator('#ms').isChecked()&&!await target.locator('#consent').isChecked()&&!await target.locator('#payment').isChecked());
  check('existing values preserved and no submission',await target.locator('#prefilled').inputValue()==='Manual value'&&await target.evaluate(()=>(window as any).submissions===0));
  await target.locator('#firstName').fill('Edited by user');
  const undone=await invoke('undo');assert(undone.ok);check('undo restores empty select/number/contenteditable and preserves subsequent edits',await target.locator('#country').inputValue()===''&&await target.locator('#amount').inputValue()===''&&await target.locator('#editable').innerText()===''&&await target.locator('#firstName').inputValue()==='Edited by user'&&!await target.locator('#business').isChecked()&&!await target.locator('#mr').isChecked());
  const secrets=await invoke('scan');const secretFields=secrets.value.fields.filter((f:any)=>['password','otp','iban','bankName'].includes(f.entity));
  const allowedFill=await invoke('fill',{scan:secrets.value.scan,entities:payload,selected:secretFields.map((f:any)=>({id:f.id,entity:f.entity})),secrets:true,sensitive:true});assert(allowedFill.ok);
  check('explicit exact sensitive and secret opt-ins work',await target.locator('#password').inputValue()===payload.password&&await target.locator('#otp').inputValue()==='123456'&&await target.locator('#iban').inputValue()===payload.iban&&await target.locator('#bankName').inputValue()===payload.bankName);
  const captured=await invoke('capture');assert(captured.ok);check('reverse capture excludes secrets and sensitive values by default',!captured.value.entities.password&&!captured.value.entities.otp&&!captured.value.entities.iban&&!captured.value.entities.bankName&&captured.value.entities.firstName==='Edited by user');
  const capturedHigh=await invoke('capture',{sensitive:true});check('capture opt-in permits exact financial values but never passwords',capturedHigh.value.entities.iban===payload.iban&&!capturedHigh.value.entities.password&&!capturedHigh.value.entities.otp);
  const remapScan=await invoke('scan');const bank=remapScan.value.fields.find((f:any)=>f.entity==='bankName'), generic=remapScan.value.fields.find((f:any)=>f.field.includes('Generische'));const remapped=await invoke('fill',{scan:remapScan.value.scan,entities:payload,selected:[{id:bank.id,entity:'email'},{id:generic.id,entity:'iban'}],sensitive:true,secrets:true,overwrite:true});assert(remapped.ok);check('sensitivity cannot be downgraded; high values cannot use generic fallback',remapped.value.count===0&&await target.locator('#generic').inputValue()===''&&await target.locator('#bankName').inputValue()===payload.bankName);
  const mutationScan=await invoke('scan');const email=mutationScan.value.fields.find((f:any)=>f.entity==='email');await target.locator('#email').evaluate((el:any)=>{el.name='changed-after-preview'});const mutation=await invoke('fill',{scan:mutationScan.value.scan,entities:payload,selected:[{id:email.id,entity:'email'}]});check('changed field identity invalidates preview',!mutation.ok);
  const spaScan=await invoke('scan');await target.evaluate(()=>history.pushState({},'','/changed'));const stale=await invoke('fill',{scan:spaScan.value.scan,entities:payload,selected:[]});check('SPA navigation invalidates scan and undo origin binding',!stale.ok);await target.goto('http://localhost:18258/');
  const replacedScan=await invoke('scan');const first=replacedScan.value.fields.find((f:any)=>f.entity==='firstName');await target.locator('#firstName').evaluate((el:any)=>el.replaceWith(el.cloneNode(true)));const replaced=await invoke('fill',{scan:replacedScan.value.scan,entities:payload,selected:[{id:first.id,entity:'firstName'}]});check('SPA field replacement rejects stale DOM reference',!replaced.ok);
  const mismatch=await invoke('scan',{origin:'https://evil.invalid'});check('isolated coordinator rejects an origin mismatch',!mismatch.ok);

  if(!process.argv.includes('--engine-only')) {
    await mkdir(join(root,'apps/extension/evidence'),{recursive:true});await popup.setViewportSize({width:440,height:900});await popup.screenshot({path:join(root,'apps/extension/evidence/popup-unlocked.png'),fullPage:true});
    await popup.locator('#lock-extension').click();await popup.locator('#extension-master').fill('Synthetic-wrong-master-password');await popup.locator('#unlock-extension').click();await popup.waitForFunction(()=>document.querySelector('#smart-status')!.textContent!.includes('Entsperren fehlgeschlagen'));check('wrong master cannot unlock actual Rust ciphertext',await popup.locator('#smart-workspace').isHidden());
    await appApi('/extension/pairing',undefined,'DELETE');await popup.locator('#extension-master').fill(master);await popup.locator('#unlock-extension').click();await popup.locator('#pairing-form').waitFor({state:'visible'});check('server revoke disconnects paired popup and clears persisted token',Object.keys(await popup.evaluate(async()=>await (globalThis as any).chrome.storage.local.get(null))).length===0);
    const pending=await appApi('/extension/pairing',{});await popup.locator('#pair-port').fill('18257');await popup.locator('#pair-code').fill(pending.code);await popup.locator('#pair-extension').click();await popup.locator('#unlock-form').waitFor({state:'visible'});await stop();await start();await popup.locator('#extension-master').fill(master);await popup.locator('#unlock-extension').click();await popup.locator('#pairing-form').waitFor({state:'visible'});check('real Rust process restart invalidates pairing and requires explicit re-pair',await popup.locator('#smart-workspace').isHidden());
    await popup.screenshot({path:join(root,'apps/extension/evidence/popup-disconnected.png'),fullPage:true});
  }

  const sourcePaths=['scripts/extension_autofill_e2e.ts','apps/extension/popup.html','apps/extension/popup.css','apps/extension/popup.js','apps/extension/settings.js','apps/extension/content.ts','apps/extension/smart-popup.ts','apps/extension/background.ts','apps/extension/vendor/extract.js','apps/extension/vendor/fill.js','apps/web/src/passwords-crypto.ts','packages/forms/schema.ts','scripts/build_extension.ts'];
  const source_sha256=Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(join(root,path))).digest('hex')])));
  const report={source_sha256,pass:true,browser:browserPath,real_unpacked_extension:true,real_rust_pairing:!process.argv.includes('--engine-only'),mocks:false,test_only_manifest_grant:'http://localhost/*',native_optional_permission_prompt:'not automated: headless request waits for browser UI',synthetic_only:true,binary_sha256:createHash('sha256').update(await readFile(binary)).digest('hex'),manifest_sha256:createHash('sha256').update(await readFile(join(extension,'manifest.json'))).digest('hex'),cases,errors};
  await writeFile(join(root,process.argv.includes('--engine-only')?'apps/extension/ENGINE-RECEIPT.json':'apps/extension/TEST-RECEIPT.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} catch(error) {await writeFile(join(root,'apps/extension/INTEGRATION-BLOCKER.json'),JSON.stringify({pass:false,real_unpacked_extension:true,real_rust_pairing:cases.some(c=>c.name.includes('pairing')),error:error instanceof Error?error.message:String(error),cases,required_transport:'POST /api/password-vault/read JSON{} with strict extension Origin+token'},null,2)+'\n');throw error;} finally {await browser?.close();await stop();fixture.stop(true);await rm(temporary,{recursive:true,force:true});}
