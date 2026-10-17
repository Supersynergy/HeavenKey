import {test,expect} from 'bun:test';
import {wrapMaster,unwrapMaster,serializeCredential} from './passwords-access';
import {freshBytes,encode64} from './passwords-crypto';
test('PRF wrapping binds origin, credential, vault and salt',async()=>{
 const prf=freshBytes(32),salt=encode64(freshBytes(32)),vault=encode64(freshBytes(16));
 const wrap=await wrapMaster('synthetic master password',prf,salt,vault,'credential','https://example.invalid');
 expect(JSON.stringify(wrap)).not.toContain('synthetic');
 expect(await unwrapMaster(wrap,prf,vault,'credential','https://example.invalid')).toBe('synthetic master password');
 for(const [v,c,o] of [[vault,'other','https://example.invalid'],[vault,'credential','https://other.invalid'],['other','credential','https://example.invalid']]) await expect(unwrapMaster(wrap,prf,v,c,o)).rejects.toThrow();
 await expect(unwrapMaster(wrap,freshBytes(32),vault,'credential','https://example.invalid')).rejects.toThrow();
});
test('serialized credential never transports PRF output',()=>{
 const result=serializeCredential({id:'AA',rawId:new Uint8Array([0]).buffer,type:'public-key',response:{clientDataJSON:new Uint8Array([1]).buffer,authenticatorData:new Uint8Array([2]).buffer,signature:new Uint8Array([3]).buffer,userHandle:null},getClientExtensionResults:()=>({prf:{results:{first:freshBytes(32)}}})} as unknown as PublicKeyCredential);
 expect(JSON.stringify(result)).not.toContain('prf');
});
test('generation cancellation prevents wrap operation completion',async()=>{
 let count=0; await expect(wrapMaster('synthetic master password',freshBytes(32),encode64(freshBytes(32)),'vault','id','https://example.invalid',()=>{if(++count>1) throw new Error('aborted');})).rejects.toThrow('aborted');
});
