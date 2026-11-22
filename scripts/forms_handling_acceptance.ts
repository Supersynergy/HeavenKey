import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dir, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Iron.app/Contents/MacOS/Chromium';
const report = process.env.HEAVENKEY_FORMS_REPORT || '/tmp/hk-forms-browser.json';
const directory = await mkdtemp(join(tmpdir(), 'heavenkey-forms-'));
const sourcePaths = ['packages/forms/field-label.ts','packages/forms/feedback.ts','packages/forms/schema.ts','packages/forms/presets.ts','apps/web/src/passwords-workflows.ts','apps/extension/content.ts','apps/web/src/passwords.ts','apps/web/src/passwords.css','apps/web/dist/passwords.js','apps/extension/vendor/fill.js','apps/extension/smart-popup.ts','apps/extension/popup.html','apps/extension/popup.css','dist/extension-source-chromium/content.js','dist/extension-source-chromium/smart-popup.js','dist/extension-source-chromium/popup.html','dist/extension-source-chromium/popup.css','dist/extension-source-chromium/manifest.json','scripts/forms_handling_acceptance.ts'];
async function sourceHashes() { return Object.fromEntries(await Promise.all(sourcePaths.map(async file=>[file,createHash('sha256').update(await readFile(join(root,file))).digest('hex')]))); }
const sources = await sourceHashes();

const cases: string[] = [], errors: string[] = []; let writes = 0, browser: any;
const check = (name: string, value = true) => { assert(value, name); cases.push(name); console.log('PASS ' + name); };
const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
 const path = new URL(request.url).pathname;
 if (path === '/api/password-vault/config') return Response.json({token:'synthetic-only',vault_folder:'Formtest',revision:0});
 if (path.startsWith('/api/')) { if (request.method === 'POST' && path === '/api/password-vault') writes++; return Response.json({revision:0,record:null}); }
 const files: Record<string,[string,string]> = {'/passwords/':['apps/web/passwords.html','text/html'],'/passwords.js':['apps/web/dist/passwords.js','text/javascript'],'/passwords.css':['apps/web/src/passwords.css','text/css'],'/heavenkey-cover.png':['docs/assets/heavenkey-hero-square.png','image/png']};
 if(files[path]) { const [file,type]=files[path]; return new Response(await readFile(join(root,file)),{headers:{'Content-Type':type}}); }
 return new Response('<!doctype html><meta charset="utf-8"><style>input{display:block;width:220px;height:35px}</style><span id="a">Geschäftliche</span><span id="b">E-Mail</span><input id="email" aria-labelledby="a b"><span id="shadow-label">IBAN</span><div id="host"></div><input id="hidden" hidden autocomplete="email"><input id="readonly" readonly autocomplete="email">',{headers:{'Content-Type':'text/html'}});
}});
try {
 await writeFile(report,JSON.stringify({passed:false,stage:'running'}));
 const extension=join(root,'dist/extension-source-chromium');
 browser=await chromium.launchPersistentContext(join(directory,'profile'),{executablePath,headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run'],viewport:{width:1100,height:850}});
 browser.on('page',(page:any)=>page.on('pageerror',(e:Error)=>errors.push(e.message)));
 const origin=`http://localhost:${server.port}`, app=await browser.newPage(); await app.goto(origin+'/passwords/');
 await app.locator('#unlock:not([disabled])').waitFor(); await app.locator('#unlock').click();
 await app.locator('#unlock-form .form-feedback:not([hidden])').waitFor();
 check('HeavenKey native constraints expose an accessible error summary',await app.locator('#master').getAttribute('aria-invalid')==='true');
 await app.locator('#unlock-form .form-feedback button').first().click();
 check('keyboard-accessible error link focuses the actual field',await app.locator('#master').evaluate((el:any)=>el===document.activeElement));
 await app.locator('#master').fill('Synthetic-form-check-only');
 check('correcting a field removes only its owned error',!await app.locator('#master').getAttribute('aria-invalid'));
 await app.setViewportSize({width:320,height:850});
 check('validation feedback has no horizontal overflow at phone width',await app.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await app.locator('#unlock-form').evaluate((form:any)=>form.reset());
 check('reset removes all feedback references',await app.locator('#unlock-form .form-feedback').isHidden());
 const workers=browser.serviceWorkers(),worker=workers[0] || await browser.waitForEvent('serviceworker');
 const id=new URL(worker.url()).host,popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 check('shop inquiry and tax drafts are available in the real app and extension',await app.locator('#form-profiles .actions button').count()===3 && await popup.locator('#profile-preset option').count()===3);
 await popup.locator('#pair-extension').click();await popup.locator('#pairing-form .form-feedback:not([hidden])').waitFor();
 check('real unpacked extension exposes pairing validation without a request',await popup.locator('#pair-code').getAttribute('aria-invalid')==='true');
 await popup.locator('#pairing-form .form-feedback button').click();
 check('extension validation keeps field focus',await popup.locator('#pair-code').evaluate((el:any)=>el===document.activeElement));
 await popup.keyboard.press('Escape');
 await popup.screenshot({path:'/tmp/hk-forms-extension.png',fullPage:true});
 await browser.close();
 browser=await chromium.launchPersistentContext(join(directory,'engine-profile'),{executablePath,headless:true,viewport:{width:1100,height:850}});
 const target=await browser.newPage();target.on('pageerror',(error:Error)=>errors.push(error.message));
 await target.goto(origin+'/form-test.html');await target.locator('#host').waitFor({state:'attached'});
 await target.evaluate(()=>{document.querySelector('#host')!.attachShadow({mode:'open'}).innerHTML='<span id="shadow-label">Vorname</span><input id="first" aria-labelledby="shadow-label">';});
 await target.addScriptTag({path:join(extension,'content.js')});
 const result=await target.evaluate(()=>{
  const engine=(globalThis as any).__heavenkeyEngine, request={origin:location.origin,href:location.href};
  const scan=engine({...request,action:'scan'}), wanted=scan.fields.filter((field:any)=>['email','firstName'].includes(field.entity));
  const fill=engine({...request,action:'fill',scan:scan.scan,selected:wanted.map((field:any)=>({id:field.id,entity:field.entity})),entities:{email:'alex@example.invalid',firstName:'Alex'}});
  const first=document.querySelector('#host')!.shadowRoot!.querySelector('input')!;
  const filled=first.value==='Alex' && (document.querySelector('#email') as HTMLInputElement).value==='alex@example.invalid';
  first.value='Nora';const undo=engine({...request,action:'undo'});
  return {fields:scan.fields.map((field:any)=>({entity:field.entity,field:field.field})),count:fill.count,filled,undone:undo.count,preserved:first.value==='Nora',empty:(document.querySelector('#email') as HTMLInputElement).value===''};
 });
 check('Smartfield recognizes ordered ARIA references and root-local shadow labels',result.fields.length===2 && result.fields.some((f:any)=>f.entity==='firstName'&&f.field==='Vorname')&&result.fields.some((f:any)=>f.entity==='email'&&f.field==='Geschäftliche E-Mail'));
 check('explicit selected-field fill uses the production engine',result.count===2&&result.filled);
 check('undo preserves subsequent manual edits',result.undone===1&&result.preserved&&result.empty);

 await target.setContent('<meta charset="utf-8"><form id="shop"><label>Vorname<input id="given" autocomplete="section-delivery shipping given-name"></label><label>E-Mail<input id="mail" type="email" autocomplete="shipping email"></label><label>Land<select id="country" autocomplete="shipping country-name"><option value="">Bitte wählen</option><option value="DE">Deutschland</option></select></label><label>Newsletter<input id="newsletter" type="checkbox"></label><button type="submit">Bestellen</button></form>');
 const shop=await target.evaluate(()=>{
  let submits=0;document.querySelector('form')!.addEventListener('submit',event=>{event.preventDefault();submits++;});
  const engine=(globalThis as any).__heavenkeyEngine,request={origin:location.origin,href:location.href};
  const scan=engine({...request,action:'scan'}),entities={firstName:'Alex',email:'synthetic@example.invalid',country:'Deutschland'};
  const filled=engine({...request,action:'fill',scan:scan.scan,entities,selected:scan.fields.filter((field:any)=>field.entity in entities).map((field:any)=>({id:field.id,entity:field.entity}))});
  return {count:filled.count,given:(document.querySelector('#given') as HTMLInputElement).value,mail:(document.querySelector('#mail') as HTMLInputElement).value,country:(document.querySelector('#country') as HTMLSelectElement).value,newsletter:(document.querySelector('#newsletter') as HTMLInputElement).checked,submits};
 });
 check('shop autofill supports sectioned autocomplete and native country selects',shop.count===3&&shop.given==='Alex'&&shop.mail==='synthetic@example.invalid'&&shop.country==='DE');
 check('shop filling never subscribes or submits an order',!shop.newsletter&&shop.submits===0);
 await target.setContent('<meta charset="utf-8"><form><label>Betreff<input id="subject" name="subject"></label><label>Nachricht<textarea id="message" name="message"></textarea></label><input id="day" autocomplete="bday-day"><input id="month" autocomplete="bday-month"><input id="year" autocomplete="bday-year"></form>');
 const inquiry=await target.evaluate(()=>{
  const engine=(globalThis as any).__heavenkeyEngine,request={origin:location.origin,href:location.href};
  const scan=engine({...request,action:'scan'}),entities={subject:'TEST Anfrage',message:'Nur synthetische Testdaten.',birthdate:'1990-03-14'};
  const selected=scan.fields.filter((field:any)=>field.entity in entities||field.entity?.startsWith('bday_')).map((field:any)=>({id:field.id,entity:field.entity}));
  const filled=engine({...request,action:'fill',scan:scan.scan,entities,selected});
  return {count:filled.count,values:['subject','message','day','month','year'].map(id=>(document.getElementById(id) as HTMLInputElement).value)};
 });
 check('inquiries support textareas and split date fields',inquiry.count===5&&JSON.stringify(inquiry.values)===JSON.stringify(['TEST Anfrage','Nur synthetische Testdaten.','14','03','1990']));
 await target.setContent('<meta charset="utf-8"><form><label>Steuerliche Identifikationsnummer<input id="tax-id"></label><label>Steuernummer<input id="tax-number"></label><label>Umsatzsteuer-ID<input id="vat"></label></form>');
 const tax=await target.evaluate(()=>{
  const engine=(globalThis as any).__heavenkeyEngine,request={origin:location.origin,href:location.href};
  const entities={steuerid:'TEST-TAX-PRIVATE',steuernr:'TEST-NUMMER',vat:'TEST-VAT'};
  const perform=(sensitive:boolean)=>{const scan=engine({...request,action:'scan'});return engine({...request,action:'fill',scan:scan.scan,entities,sensitive,selected:scan.fields.map((field:any)=>({id:field.id,entity:field.entity}))});};
  const denied=perform(false),empty=[...document.querySelectorAll('input')].every(input=>!input.value),approved=perform(true);
  return {denied:denied.count,empty,approved:approved.count,values:[...document.querySelectorAll('input')].map(input=>input.value)};
 });
 check('tax identifiers and VAT require explicit sensitive-field consent',tax.denied===0&&tax.empty);
 check('approved tax fields receive only the selected synthetic identifiers',tax.approved===3&&JSON.stringify(tax.values)===JSON.stringify(['TEST-TAX-PRIVATE','TEST-NUMMER','TEST-VAT']));

 await target.setContent('<meta charset="utf-8"><form><div contenteditable="true" role="textbox" aria-label="Nachricht" style="min-height:24px"></div><input type="file"><iframe title="Separates Formular" srcdoc="<input autocomplete=email>"></iframe></form>');
 const rich=await target.evaluate(()=>{
  const engine=(globalThis as any).__heavenkeyEngine,request={origin:location.origin,href:location.href};
  const scan=engine({...request,action:'scan'}),message=scan.fields.find((field:any)=>field.entity==='message');
  const filled=engine({...request,action:'fill',scan:scan.scan,entities:{message:'TEST Anfrage im Richtextfeld'},selected:message?[{id:message.id,entity:'message'}]:[]});
  return {coverage:scan.coverage,count:filled.count,value:document.querySelector('[contenteditable]')!.textContent,file:(document.querySelector('[type=file]') as HTMLInputElement).files!.length};
 });
 check('richtext inquiry fields accept explicitly selected text',rich.count===1&&rich.value==='TEST Anfrage im Richtextfeld');
 check('coverage reports frames and manual file uploads without filling either',rich.coverage.frames===1&&rich.coverage.fileInputs===1&&rich.file===0);
 check('invalid local forms cause no vault writes',writes===0);
 check('no uncaught browser errors',errors.length===0);
 assert.deepEqual(await sourceHashes(),sources,'Sources changed during acceptance');
 await writeFile(report,JSON.stringify({passed:true,sources,scope:'isolated headless browser; synthetic data; real app and extension bundles',browser:executablePath,cases,source:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex')},null,2));
} catch(error) { await writeFile(report,JSON.stringify({passed:false,cases,error:String(error)},null,2)); throw error; }
finally {await browser?.close();server.stop(true);await rm(directory,{recursive:true,force:true});}
