import {test,expect} from 'bun:test';
import {encryptShare,decryptShare,validateSharedPayload,readShareFragment} from './passwords-sharing';
import {freshBytes,encode64} from './passwords-crypto';
const payload={version:1 as const,title:'Synthetic',kind:'login' as const,fields:[{label:'Username',value:'synthetic@example.invalid'}]};
test('selected-field snapshot authenticates and binds share id',async()=>{
 const key=freshBytes(32),sealed=await encryptShare(payload,key,'synthetic-id');
 expect(JSON.stringify(sealed)).not.toContain('synthetic@example.invalid');
 expect(await decryptShare(sealed,key,'synthetic-id')).toEqual(payload);
 await expect(decryptShare(sealed,key,'other-id')).rejects.toThrow();
 await expect(decryptShare(sealed,freshBytes(32),'synthetic-id')).rejects.toThrow();
});
test('strict snapshot and fragment bounds',()=>{
 expect(()=>validateSharedPayload({...payload,fields:[{label:'x',value:'a'.repeat(10001)}]})).toThrow();
 expect(()=>validateSharedPayload({...payload,fields:Array(101).fill({label:'x',value:'v'})})).toThrow();
 expect(()=>validateSharedPayload({...payload,fields:[{label:'x',value:'a'.repeat(10000)},{label:'x',value:'a'.repeat(10000)},{label:'x',value:'a'.repeat(10000)},{label:'x',value:'a'.repeat(10000)}]})).toThrow();
 const fragment='#id=9a65f6d7-1e98-4804-950b-e6cd42e3de54&token='+encode64(freshBytes(32))+'&key='+encode64(freshBytes(32));
 expect(readShareFragment(fragment).key.length).toBe(32);
 expect(()=>readShareFragment(fragment+'&key=AA')).toThrow();
});
test('Unix server expiry uses seconds, rejects invalid timestamps',async()=>{
 const {shareTime}=await import('./passwords-sharing');
 expect(shareTime(1792252800)).toBe(1792252800000);
 for(const invalid of [null,'1792252800',-1,Infinity,Number.MAX_SAFE_INTEGER])expect(()=>shareTime(invalid)).toThrow();
});
