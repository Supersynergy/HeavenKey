/** Real native extension APIs, real Rust ciphertext, real trusted pointer events. */
import assert from 'node:assert/strict';
import { openVault } from '../apps/web/src/passwords-crypto';
export async function inlineCases({browser,popup,target,appApi,master,check}:any) {
  const status=(page:any,text:string)=>page.waitForFunction((value:string)=>document.querySelector('#smart-status')?.textContent?.includes(value) && document.querySelector('#smart')?.getAttribute('aria-busy')==='false',text);
  const cdp=await browser.newCDPSession(target);
  const clickAX=async(name:string)=>{
    const {nodes}=await cdp.send('Accessibility.getFullAXTree');
    const node=nodes.find((node:any)=>node.role?.value==='button' && node.name?.value===name);assert(node,`Inline action ${name}`);
    const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId:node.backendDOMNodeId});
    await target.mouse.click((model.border[0]+model.border[4])/2,(model.border[1]+model.border[5])/2);
  };
  const windowFor=async(selector:string,label:string)=>{
    await target.bringToFront();await target.locator(selector).scrollIntoViewIfNeeded();await target.waitForTimeout(50);const box=await target.locator(selector).boundingBox();assert(box);
    const {nodes}=await cdp.send('Accessibility.getFullAXTree');let key:any;
    for(const node of nodes.filter((node:any)=>node.role?.value==='button'&&node.name?.value==='HeavenKey öffnen')){
      const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId:node.backendDOMNodeId});const [left,top]=model.border;
      if(Math.abs(top+model.height/2-(box.y+box.height/2))<1 && (left>=box.x+box.width||left+model.width<=box.x)){key={left,top,...model};break;}
    }
    assert(key,'Field key must occupy a free outer gutter and stay vertically centered');assert.equal(key.width,24);assert.equal(key.height,24);
    await target.mouse.click(key.left+key.width/2,key.top+key.height/2);await target.waitForTimeout(100);
    const opened=browser.waitForEvent('page');await clickAX(label);const page=await opened;
    await page.waitForLoadState('domcontentloaded');await page.locator('#unlock-form').waitFor({state:'visible'});
    await page.locator('#extension-master').fill(master);await page.locator('#unlock-extension').click();await page.locator('#smart-workspace').waitFor({state:'visible'});return page;
  };
  await popup.bringToFront();await popup.locator('#enable-inline').click();await status(popup,'Schlüssel für diese Website aktiviert');
  check('per-site activation registers persistent top-frame UI with exact host pattern',await popup.evaluate(async()=>{
    const scripts=await(globalThis as any).chrome.scripting.getRegisteredContentScripts();return scripts.length===1 && scripts[0].matches.join()==='http://localhost/*' && !scripts[0].allFrames;
  }));
  await target.reload();await target.waitForTimeout(200);
  check('closed shadow UI exposes no vault data in page text',await target.evaluate(()=>!document.body.innerText.includes('HeavenKey') && !document.body.innerText.includes('Synthetic-login-only')));
  const login=await windowFor('#password','Login auswählen');await login.locator('[data-id="synthetic-login"]').click();await login.locator('#fill-confirmation').waitFor({state:'visible'});
  check('field key opens trusted extension window and anchored login preview',!await login.locator('#confirm-origin').isChecked() && await login.locator('#field-map [data-field]:checked').count()>=2);
  await login.locator('#confirm-origin').check();await login.locator('#fill-selected').click();await status(login,'Felder gefüllt');
  check('inline login fills exact-origin password and fresh TOTP without submit',await target.locator('#password').inputValue()==='Synthetic-login-only#42' && /^\d{6}$/.test(await target.locator('#otp').inputValue()) && await target.evaluate(()=>(window as any).submissions===0));
  await login.locator('#undo-fill').click();await status(login,'Felder zurückgesetzt');
  await login.locator('[data-id="synthetic-login"]').click();await login.locator('#fill-confirmation').waitFor({state:'visible'});
  for(const field of await login.locator('#field-map [data-field]').all()) await field.uncheck();
  await login.getByRole('checkbox',{name:/^Benutzername ·/}).check();
  await login.evaluate(()=>{
    const ext=(globalThis as any).chrome, original=ext.scripting.executeScript.bind(ext.scripting);
    (globalThis as any).__payloadAudit={original,keys:[]};
    ext.scripting.executeScript=async(request:any)=>{if(request.args?.[0]?.action==='fill')(globalThis as any).__payloadAudit.keys=Object.keys(request.args[0].entities);return original(request);};
  });
  try {
    await login.locator('#confirm-origin').check();await login.locator('#fill-selected').click();await status(login,'1 Felder gefüllt');
    check('red team: unselected password and TOTP never enter native delivery arguments',await login.evaluate(()=>(globalThis as any).__payloadAudit.keys.join()==='username') && await target.locator('#password').inputValue()==='');
  } finally {await login.evaluate(()=>{(globalThis as any).chrome.scripting.executeScript=(globalThis as any).__payloadAudit.original;delete(globalThis as any).__payloadAudit;});}
  await login.close();await target.reload();await target.waitForTimeout(150);
  const profile=await windowFor('#firstName','Name & Adresse ausfüllen');await profile.locator('[data-id="synthetic-profile"]').click();await profile.locator('#fill-confirmation').waitFor({state:'visible'});
  await profile.locator('#confirm-origin').check();await profile.locator('#fill-selected').click();await status(profile,'Felder gefüllt');
  check('inline identity fills names while financial fields and consent stay empty',await target.locator('#firstName').inputValue()==='Alex' && await target.locator('#lastName').inputValue()==='Muster' && await target.locator('#iban').inputValue()==='' && !await target.locator('#consent').isChecked());
  await profile.close();await target.reload();
  await target.evaluate(()=>{const form=document.createElement('form');form.id='signup';form.innerHTML='<label>Neues Passwort<input id="inline-new" type="password" autocomplete="new-password" maxlength="20"></label><label>Bestätigen<input id="inline-confirm" type="password" autocomplete="new-password" maxlength="20"></label>';document.body.prepend(form);});await target.waitForTimeout(150);
  const generated=await windowFor('#inline-new','Neues Passwort generieren');await generated.locator('#login-username').fill('new-inline@example.invalid');await generated.locator('#generate-password').click();await status(generated,'Neues Passwort erzeugt');
  const secret=await generated.locator('#login-password').inputValue();assert.equal(secret.length,20);
  check('generator honors field limit and requires saving before delivery',await target.locator('#inline-new').inputValue()==='' && await generated.locator('#preview-generated').isHidden());
  await generated.locator('#save-login').click();await status(generated,'Login verschlüsselt gespeichert');
  const encrypted=await appApi(''),opened=await openVault(encrypted.record,master);
  check('new password is in actual encrypted Rust vault before delivery',opened.vault.entries.some(entry=>entry.password===secret && entry.username==='new-inline@example.invalid') && !JSON.stringify(encrypted).includes(secret));
  await generated.locator('#preview-generated').click();await generated.locator('#fill-confirmation').waitFor({state:'visible'});assert.equal(await generated.locator('#field-map [data-field]:checked').count(),2);
  await generated.locator('#confirm-origin').check();await generated.locator('#fill-selected').click();await status(generated,'Felder gefüllt');
  check('generated secret fills new and confirmation fields only without submit',await target.locator('#inline-new').inputValue()===secret && await target.locator('#inline-confirm').inputValue()===secret && await target.locator('#password').inputValue()==='' && await target.evaluate(()=>(window as any).submissions===0));
  await generated.locator('#undo-fill').click();await status(generated,'Felder zurückgesetzt');check('generated fill is undoable after encrypted save',await target.locator('#inline-new').inputValue()==='' && await target.locator('#inline-confirm').inputValue()==='');
  await generated.locator('[data-id="synthetic-login"]').click();await generated.locator('#generate-password').click();await status(generated,'Neues Passwort erzeugt');
  await generated.locator('#save-login').click();await status(generated,'Ersetzen des gespeicherten Logins ausdrücklich bestätigen');
  await generated.locator('#confirm-login-update').check();await generated.locator('#save-login').click();await status(generated,'Login verschlüsselt gespeichert');
  const changed=await openVault((await appApi('')).record,master);
  check('password update needs consent and preserves previous working secret',changed.vault.entries.some(entry=>entry.title.endsWith('bisheriges Passwort') && entry.password==='Synthetic-login-only#42') && changed.vault.entries.find(entry=>entry.id==='synthetic-login')!.password!=='Synthetic-login-only#42');
  const previous=changed.vault.entries.find(entry=>entry.id==='synthetic-login')!.password;
  await generated.locator('#login-password').fill('Synthetic-manual-replacement#42');await generated.locator('#confirm-login-update').check();await generated.locator('#save-login').click();await status(generated,'Login verschlüsselt gespeichert');
  const manual=await openVault((await appApi('')).record,master);
  check('red team: manually replacing a password also preserves the previous encrypted credential',manual.vault.entries.some(entry=>entry.title.endsWith('bisheriges Passwort') && entry.password===previous) && manual.vault.entries.find(entry=>entry.id==='synthetic-login')!.password==='Synthetic-manual-replacement#42');
  await generated.close();await target.bringToFront();
  await target.evaluate(()=>{
    const fixture=document.createElement('label');fixture.id='key-collision-fixture';fixture.style.cssText='position:fixed;left:0;top:117.5px;width:100vw;height:32px;margin:0;z-index:100000';
    fixture.innerHTML='<input id="key-collision-email" type="email" autocomplete="email" style="box-sizing:border-box;width:calc(100% - 32px);height:32px;margin:0"><button id="key-collision-reveal" type="button" aria-label="Synthetic reveal" style="position:absolute;left:calc(100% - 23px);top:10px;width:4px;height:4px;min-width:0;min-height:0;padding:0;border:0"></button>';
    document.body.append(fixture);
  });
  const keysAtCollisionRow=async()=>{
    await target.waitForTimeout(100);const box=await target.locator('#key-collision-email').boundingBox();assert(box);
    const {nodes}=await cdp.send('Accessibility.getFullAXTree');const found:any[]=[];
    for(const node of nodes.filter((node:any)=>node.role?.value==='button'&&node.name?.value==='HeavenKey öffnen')){
      const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId:node.backendDOMNodeId});
      if(Math.abs(model.border[1]+model.height/2-(box.y+box.height/2))<.25)found.push(model);
    }return found;
  };
  check('inline key never covers a tiny control inside the otherwise free gutter',(await keysAtCollisionRow()).length===0);
  await target.locator('#key-collision-reveal').evaluate((el:any)=>el.remove());
  check('inline key appears when the entire 24px gutter becomes free',(await keysAtCollisionRow()).some(key=>key.width===24&&key.height===24));
  await target.locator('#key-collision-email').evaluate((el:any)=>el.style.width='100%');
  check('inline key stays hidden when both outer gutters are outside the viewport',(await keysAtCollisionRow()).length===0);
  await target.locator('#key-collision-fixture').evaluate((el:any)=>el.remove());
  await popup.bringToFront();await popup.locator('#disable-inline').click();await status(popup,'Schlüssel auf dieser Website deaktiviert');
  check('per-site disable removes persistent registration',await popup.evaluate(async()=>(await(globalThis as any).chrome.scripting.getRegisteredContentScripts()).length===0));
  await popup.evaluate(async()=>{await(globalThis as any).chrome.storage.local.remove('heavenkey.inline.sites');});await target.reload();await cdp.detach();
}
