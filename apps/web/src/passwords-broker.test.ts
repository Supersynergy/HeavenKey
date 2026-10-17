import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { sealBrokerLogin, initPasswordBroker } from './passwords-broker';
import { encode64, decode64 } from './passwords-crypto';
const login={id:'login',title:'Synthetic',username:'fake-owner',password:'fake-password-42',url:'https://fixture.invalid/login',totp:'',notes:'',favorite:false,tags:[]};
const keys=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
const publicKey=encode64(new Uint8Array(await crypto.subtle.exportKey('spki',keys.publicKey)));
async function decrypt(sealed:any,aad='HeavenKey broker v1\x00request\x009\x004'){
 const raw=await crypto.subtle.decrypt({name:'RSA-OAEP'},keys.privateKey,decode64(sealed.key,512));
 const aes=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
 return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(sealed.iv,12),additionalData:new TextEncoder().encode(aad)},aes,decode64(sealed.ciphertext,20000))));
}
test('sealed handoff roundtrips only chosen login, ciphertext binds request/epoch/revision',async()=>{
 const sealed=await sealBrokerLogin(login,publicKey,'request',9,4,()=>{});
 expect(Object.keys(sealed).sort()).toEqual(['ciphertext','iv','key']);
 expect(JSON.stringify(sealed)).not.toContain(login.password);
 expect(await decrypt(sealed)).toEqual({version:1,url:login.url,username:login.username,password:login.password});
 await expect(decrypt(sealed,'HeavenKey broker v1\x00other\x009\x004')).rejects.toThrow();
 await expect(decrypt(sealed,'HeavenKey broker v1\x00request\x0010\x004')).rejects.toThrow();
});
test('late guard cancellation prevents sealed result',async()=>{
 let checks=0; await expect(sealBrokerLogin(login,publicKey,'request',9,4,()=>{if(++checks===3) throw new Error('cancelled');})).rejects.toThrow('cancelled');
});
const tick=()=>new Promise(r=>setTimeout(r,25));
function setup(){
 const win=new Window({url:'http://localhost/passwords'});
 Object.assign(globalThis,{window:win,document:win.document,MutationObserver:win.MutationObserver,HTMLElement:win.HTMLElement,HTMLButtonElement:win.HTMLButtonElement});
 win.document.body.innerHTML='<section id="settings-view"></section>';
 let generation=1,unlocked=true;const calls:any[]=[];
 const snapshot={token:'synthetic-token',revision:4,record:null,vault:{version:1,entries:[login,{...login,id:'other',title:'Other host',url:'https://wrong.invalid'}]},generation:1,discreet:false};
 const ctx:any={get:()=>({...snapshot,generation}),current:(g:number)=>g===generation,unlocked:()=>unlocked,announce:()=>{},run:async(fn:any)=>fn(generation),accept:()=>{}};
 const state={version:1,enabled:true,unlocked:true,epoch:9,public_key:publicKey,clients:[],requests:[{id:'request',client_id:'client',label:'<img src=x>',origin:'https://fixture.invalid',scope:'login_read',status:'pending',expires_at:Math.floor(Date.now()/1000)+90}],sessions:[],audit:[],browser_available:true,limits:{session_seconds:300}};
 globalThis.fetch=async(url:any,init:any={})=>{calls.push({path:String(url),...init,body:init.body?JSON.parse(init.body):undefined});return Response.json(String(url).endsWith('/unlock')?{epoch:9}:String(url).endsWith('/heartbeat')?{}:String(url).includes('/approve/')?{status:'running'}:String(url).endsWith('/lock')?{locked:true}:String(url).endsWith('/pairing')?{code:'ABCDEF',expires_in:120}:state);};
 return {win,ctx,calls,lock:()=>{generation++;unlocked=false},state};
}
test('approval requires exact-origin account plus independent consent; no untrusted markup',async()=>{
 const s=setup(), ui=initPasswordBroker(s.ctx);await ui.unlocked();
 s.win.document.querySelector<HTMLButtonElement>('#broker-review-request')!.click();
 const account=s.win.document.querySelector<HTMLSelectElement>('#broker-account')!,consent=s.win.document.querySelector<HTMLInputElement>('#broker-consent')!,approve=s.win.document.querySelector<HTMLButtonElement>('#broker-approve')!;
 expect(account.value).toBe(''); expect(account.options.length).toBe(2);expect(approve.disabled).toBe(true);expect(s.win.document.querySelector('img')).toBeNull();
 account.value='login';account.dispatchEvent(new s.win.Event('change'));expect(approve.disabled).toBe(true);
 consent.checked=true;consent.dispatchEvent(new s.win.Event('change'));expect(approve.disabled).toBe(false);
 s.win.document.querySelector('form')!.dispatchEvent(new s.win.Event('submit',{cancelable:true}));await tick();
 const sent=s.calls.find(c=>c.path.includes('/approve/'));expect(sent).toBeDefined();expect(Object.keys(sent.body).sort()).toEqual(['epoch','revision','sealed','source_id']);expect(JSON.stringify(sent.body)).not.toContain(login.password);
 expect(await decrypt(sent.body.sealed)).toEqual({version:1,url:login.url,username:login.username,password:login.password});ui.clear();
});
test('cancel clears selection and restores focus while busy',async()=>{
 const s=setup(),ui=initPasswordBroker(s.ctx);await ui.unlocked();const trigger=s.win.document.querySelector<HTMLButtonElement>('#broker-review-request')!;trigger.focus();trigger.click();
 const account=s.win.document.querySelector<HTMLSelectElement>('#broker-account')!;account.value='login';ui.setBusy(true);
 const cancel=s.win.document.querySelector<HTMLButtonElement>('#broker-approval-dialog [data-cancel]')!;expect(cancel.disabled).toBe(false);cancel.click();
 expect(account.options.length).toBe(0);expect(s.win.document.activeElement?.id).toBe('broker-settings');expect(s.calls.some(c=>c.path.includes('/approve/'))).toBe(false);ui.clear();
});
test('lock during encryption never dispatches approval or retains dialog values',async()=>{
 const s=setup(),ui=initPasswordBroker(s.ctx);await ui.unlocked();s.win.document.querySelector<HTMLButtonElement>('#broker-review-request')!.click();
 const account=s.win.document.querySelector<HTMLSelectElement>('#broker-account')!,consent=s.win.document.querySelector<HTMLInputElement>('#broker-consent')!;account.value='login';account.dispatchEvent(new s.win.Event('change'));consent.checked=true;consent.dispatchEvent(new s.win.Event('change'));
 s.win.document.querySelector('form')!.dispatchEvent(new s.win.Event('submit',{cancelable:true}));s.lock();ui.clear();await tick();
 expect(s.calls.some(c=>c.path.includes('/approve/'))).toBe(false);expect(s.calls.some(c=>c.path.endsWith('/lock')&&c.keepalive)).toBe(true);expect(account.options.length).toBe(0);expect(s.win.document.querySelector<HTMLDialogElement>('dialog')!.open).toBe(false);
});
test('pairing code appears only explicitly and is wiped on settings close',async()=>{
 const s=setup(),ui=initPasswordBroker(s.ctx);await ui.unlocked();expect(s.win.document.querySelector('#broker-pairing-code')!.textContent).toBe('');s.win.document.querySelector<HTMLButtonElement>('#broker-pair')!.click();await tick();expect(s.win.document.querySelector('#broker-pairing-code')!.textContent).toContain('ABCDEF');s.win.document.querySelector<HTMLElement>('#settings-view')!.hidden=true;await tick();expect(s.win.document.querySelector('#broker-pairing-code')!.textContent).toBe('');ui.clear();
});
