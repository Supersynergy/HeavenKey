import {test,expect} from 'bun:test';
import {createVault,openVault,derive,freshBytes,encode64,sealVault} from './passwords-crypto';
test('new vault rejects obvious repeated and common master passwords',async()=>{
 for(const password of ['12345678901234','aaaaaaaaaaaaaa','passwordpassword','passwortpasswort','qwertyqwertyqwerty']) await expect(createVault(password)).rejects.toThrow();
});
test('legacy weak master still unlocks so the user can rotate without data loss',async()=>{
 const old='12345678901234',salt=freshBytes(16),key=await derive(old,salt),vault={version:1 as const,entries:[]};
 const envelope=await sealVault(vault,key,encode64(salt));expect((await openVault(envelope,old)).vault).toEqual(vault);
});
test('new policy accepts a long synthetic independent phrase',async()=>{const p='Synthetic independent cedar orbit 83!';const v=await createVault(p);expect((await openVault(v.envelope,p)).vault.entries).toEqual([]);});
