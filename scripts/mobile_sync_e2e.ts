import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dir, '..'), sdk = process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools';
const adbPath = join(sdk,'platform-tools/adb'), serial='emulator-5584', app='app.heavenkey.heavenkey_mobile';
const execute=promisify(execFile), pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const adb=async(...args:string[])=>(await execute(adbPath,['-s',serial,...args],{encoding:'utf8',timeout:20_000})).stdout;
const evidence=join(root,'docs/evidence/mobile/android-desktop-sync.json'), log=join(root,'docs/evidence/mobile/android-desktop-sync.log');
const phases: Record<string,string>={PAIR:'pair',DESKTOP_RECEIVE:'receive',DESKTOP_EDIT:'edit',VERIFY_DELETED:'verify_deleted',DELETE_PROBE:'delete_probe',CONFLICT_SEED:'conflict_seed',CONFLICT_EDIT:'conflict_edit',CONFLICT_ADVANCE:'conflict_advance',VERIFY_RESOLUTION:'verify_resolution',REVOKE:'revoke'};
const sourcePaths=['scripts/mobile_sync_e2e.ts','scripts/mobile_sync_desktop.ts','apps/mobile/integration_test/desktop_sync_test.dart',
  'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/DesktopSync.kt','apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/VaultStore.kt',
  'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/MainActivity.kt','apps/api/src/password_manager/mobile_sync.rs','apps/api/src/password_manager.rs',
  'apps/web/src/passwords-sync-crypto.ts','apps/web/src/passwords-mobile-sync.ts','apps/mobile/lib/connected_panel.dart','apps/mobile/lib/vault_controller.dart'];
const hashes=Object.fromEntries(sourcePaths.map(path=>[path,createHash('sha256').update(readFileSync(join(root,path))).digest('hex')]));
let host:ChildProcess|undefined, test:ChildProcess|undefined, nativeOutput='',hostOutput='';
let operations:Promise<void>=Promise.resolve(), failed:Error|undefined;const observed=new Set<string>();
async function rpc(command:string){
  await new Promise<void>((ok,fail)=>{const socket=connect('/tmp/heavenkey-connected-desktop.sock');let response='';
    socket.setTimeout(45_000,()=>{socket.destroy();fail(new Error('Desktop fixture timeout'));});socket.on('error',fail);
    socket.on('connect',()=>socket.write(JSON.stringify({command})+'\n'));socket.on('data',chunk=>{response+=chunk;if(response.includes('\n')){socket.end();const r=JSON.parse(response.split('\n')[0]);r.ok?ok():fail(new Error(r.error));}});
  });
}
async function privateFile(name:string,value:string){
  await adb('shell','run-as',app,'mkdir','-p','files');
  await new Promise<void>((ok,fail)=>{const child=spawn(adbPath,['-s',serial,'shell','run-as',app,'tee','files/'+name],{stdio:['pipe','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.on('error',fail);child.on('exit',code=>code===0?ok():fail(new Error('Private test fixture write failed: '+error)));child.stdin.end(value);});
}
async function authenticate(){
  for(let attempt=0;attempt<10;attempt++){
    await adb('shell','uiautomator','dump','/data/local/tmp/heavenkey-sync-auth.xml');
    const xml=await adb('shell','cat','/data/local/tmp/heavenkey-sync-auth.xml');
    const target=[...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]]))).find(n=>n.package==='com.android.systemui'&&/lockPassword|pinEntry/.test(n['resource-id']??''));
    if(target){const b=target.bounds.match(/\d+/g)!.map(Number);await adb('shell','input','tap',String((b[0]+b[2])/2),String((b[1]+b[3])/2));await adb('shell','input','text','417926');await adb('shell','input','keyevent','66');return;}
    await pause(150);
  }throw new Error('Actual Android PIN dialog not observed');
}
function inspect(){
  const auth=nativeOutput.match(/NATIVE_PHASE_AUTH/g)?.length??0;
  for(let n=0;n<auth;n++){const id='auth'+n;if(observed.has(id))continue;observed.add(id);operations=operations.then(authenticate).catch(error=>{failed=error;});}
  for(const match of nativeOutput.matchAll(/SYNC_PHASE_([A-Z_]+)/g)){
    const phase=match[1];if(observed.has(phase))continue;observed.add(phase);
    operations=operations.then(async()=>{console.log('SYNC_DRIVER '+phase);assert(phases[phase]);await rpc(phases[phase]);if(phase==='PAIR')await privateFile('heavenkey-test-pair.code',readFileSync('/tmp/heavenkey-connected-pair.code','utf8'));await privateFile('heavenkey-test-sync-ack','SYNC_PHASE_'+phase);}).catch(error=>{failed=error;});
  }
}
async function stop(child:ChildProcess|undefined){if(!child||child.exitCode!==null)return;child.kill('SIGINT');for(let i=0;i<100&&child.exitCode===null;i++)await pause(100);if(child.exitCode===null)child.kill('SIGKILL');}
try {
  assert.equal((await adb('shell','getprop','ro.boot.qemu.avd_name')).trim(),'heavenkey-20261024');
  writeFileSync(log,'');
  host=spawn(process.execPath,[join(root,'scripts/mobile_sync_desktop.ts')],{cwd:root,stdio:['pipe','pipe','pipe']});
  host.stdout.on('data',b=>{hostOutput+=b;appendFileSync(log,b);});host.stderr.on('data',b=>{hostOutput+=b;appendFileSync(log,b);});
  const readyEnd=Date.now()+30_000;while(!hostOutput.includes('SYNC_DESKTOP_READY')&&Date.now()<readyEnd){assert.equal(host.exitCode,null);await pause(100);}assert(hostOutput.includes('SYNC_DESKTOP_READY'));
  await adb('shell','am','force-stop',app);await adb('shell','input','keyevent','3');
  test=spawn('flutter',['test','integration_test/desktop_sync_test.dart','-d',serial,'--no-pub','--no-uninstall','--reporter','expanded'],{cwd:join(root,'apps/mobile'),stdio:['ignore','pipe','pipe']});
  test.stdout.on('data',b=>{nativeOutput+=b;appendFileSync(log,b);inspect();});test.stderr.on('data',b=>{nativeOutput+=b;appendFileSync(log,b);inspect();});
  const end=Date.now()+450_000;while(test.exitCode===null&&Date.now()<end&&!failed)await pause(100);
  await operations;if(failed)throw failed;assert.equal(test.exitCode,0,nativeOutput.slice(-2500));assert(nativeOutput.includes('SYNC_NATIVE_OK')&&nativeOutput.includes('All tests passed!'));
  for(const [path,hash]of Object.entries(hashes))assert.equal(createHash('sha256').update(readFileSync(join(root,path))).digest('hex'),hash,'Source changed during native sync test');
  writeFileSync(evidence,JSON.stringify({passed:true,synthetic_only:true,actual_android_keystore_and_tls:true,actual_desktop_browser_ui:true,pinned_certificate_rejection:true,end_to_end_encrypted:true,bidirectional_login_updates:true,desktop_metadata_preserved:true,website_passkeys_in_encrypted_desktop:true,deletion_no_resurrection:true,explicit_conflict_resolution:true,stale_conflict_resolution_rejected:true,device_revocation_rejected:true,mk_desktop_observation:true,source_files:hashes,physical_device_acceptance:false,phases:[...observed]},null,2)+'\n');
  console.log(JSON.stringify({passed:true,evidence}));
} catch(error){writeFileSync(evidence,JSON.stringify({passed:false,error:error instanceof Error?error.message:'Native sync failure',source_files:hashes},null,2)+'\n');throw error;}
finally{await stop(test);if(host?.exitCode===null){host.stdin?.end('stop\n');for(let i=0;i<300&&host.exitCode===null;i++)await pause(100);}await stop(host);await adb('shell','run-as',app,'rm','-f','files/heavenkey-test-pair.code','files/heavenkey-test-sync-ack');await adb('shell','rm','-f','/data/local/tmp/heavenkey-sync-auth.xml');}
