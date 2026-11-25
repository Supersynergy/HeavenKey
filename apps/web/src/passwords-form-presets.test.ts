import {test,expect} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';
import {initWorkflows} from './passwords-workflows';
import {validateVault,createVault,openVault,type Vault} from './passwords-crypto';
import {presetEntities} from '../../../packages/forms/presets';
test('native tax profile editor masks private fields, saves without changing logins and clears on lock',async()=>{
 const win=new Window({url:'http://localhost/passwords/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
 win.document.write(readFileSync('apps/web/passwords.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
 const previous={document:globalThis.document,window:globalThis.window};Object.assign(globalThis,{document:win.document,window:win});
 const login={id:'synthetic-login',title:'Synthetic',username:'alex@example.invalid',password:'Synthetic-only!42',url:'https://example.invalid',notes:'',totp:'',tags:[],favorite:false};
 let vault:Vault={version:1,entries:[login]},saves=0;
 const ui=initWorkflows({vault:()=>vault,revision:()=>1,generation:()=>1,current:r=>r===1,busy:()=>false,discreet:()=>false,run:async task=>task(1),commit:async(next)=>{vault=validateVault(next);saves++;return true;},status:()=>{},select:()=>{},settings:()=>{},copy:async()=>{},pairing:async()=>({})});
 try {
  const tax=[...win.document.querySelectorAll<HTMLButtonElement>('#form-profiles button')].find(b=>b.textContent==='Steuerdaten · vertraulich')!;tax.click();
  const fields=[...win.document.querySelectorAll('#profile-fields .profile-field')];expect(fields).toHaveLength(Object.keys(presetEntities('tax')).length);
  const id=fields.find(row=>row.querySelector('select')!.value==='steuerid')!.querySelector('input')!;
  expect(id.type).toBe('password');id.value='TEST-STEUERDATEN';
  win.document.querySelector('#profile-form')!.dispatchEvent(new win.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));
  expect(saves).toBe(1);expect(vault.entries).toEqual([login]);expect(vault.profiles?.[0].entities.steuerid).toBe('TEST-STEUERDATEN');
  tax.click();ui.clear();expect(win.document.querySelector('#profile-fields')!.childElementCount).toBe(0);expect(win.document.querySelector<HTMLDialogElement>('#profile-editor')!.open).toBe(false);
 } finally {ui.clear();Object.assign(globalThis,previous);await win.happyDOM.abort();}
});
test('tax profile and existing credentials remain authenticated inside the encrypted backup',async()=>{
 const phrase='Synthetic tax profile test master phrase';
 const profile={id:'synthetic-tax',title:'TEST only',entities:{...presetEntities('tax'),steuerid:'TEST-PRIVATE-ID',steuernr:'TEST-NUMBER',iban:'TEST-BANK'},updatedAt:new Date().toISOString()};
 const encrypted=await createVault(phrase,{version:1,entries:[],profiles:[profile]});
 expect(JSON.stringify(encrypted.envelope)).not.toContain('TEST-PRIVATE-ID');expect(JSON.stringify(encrypted.envelope)).not.toContain('TEST-NUMBER');
 expect((await openVault(encrypted.envelope,phrase)).vault.profiles).toEqual([profile]);
},60000);
