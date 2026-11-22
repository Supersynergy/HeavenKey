import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertOwnedListener} from './office_login_acceptance';

test('owned-listener proof rejects a different process on the selected port',()=>{
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('not a vault')});
 try{expect(()=>assertOwnedListener(process.pid,server.port!)).not.toThrow();expect(()=>assertOwnedListener(process.ppid,server.port!)).toThrow();}finally{server.stop(true);}
});

test('missing credentials replace an earlier green report without starting a browser',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hk-office-report-')),report=join(directory,'report.json');
 try{await writeFile(report,JSON.stringify({passed:true,cases:['stale']}));const env={...process.env,CHROME_PATH:'/not-launched',HEAVENKEY_OFFICE_REPORT:report,HEAVENKEY_OFFICE_CREDENTIALS_FILE:''};const run=Bun.spawn([process.execPath,join(import.meta.dir,'office_login_acceptance.ts')],{env,stdout:'ignore',stderr:'ignore'});expect(await run.exited).toBe(1);const result=JSON.parse(await readFile(report,'utf8'));expect(result.passed).toBe(false);expect(result.cases).toEqual([]);}finally{await rm(directory,{recursive:true,force:true});}
},20000);
