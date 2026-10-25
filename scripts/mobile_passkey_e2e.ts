import { _android, type BrowserContext, type Page } from 'playwright-core';
import { decode } from 'cbor-x';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Execute only against the owned, already installed candidate; no virtual authenticator or app bypass.
// run-guard --timeout 360 --max-rss-gb 3 --threads 4 /Users/master/.bun/bin/bun scripts/mobile_passkey_e2e.ts
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serial = 'emulator-5584', browser = 'com.brave.browser', app = 'app.heavenkey.heavenkey_mobile';
const sdk = process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools';
const apk = resolve(process.env.HEAVENKEY_TEST_APK ?? join(root, 'apps/mobile/build/app/outputs/flutter-apk/app-debug.apk'));
const evidence = resolve(process.env.HEAVENKEY_PASSKEY_EVIDENCE ?? join(root, 'docs/evidence/mobile/android-browser-passkeys.json'));
const port = Number(process.env.HEAVENKEY_PASSKEY_PORT ?? 8543);
const origin = `https://heavenkey.test:${port}`, rpId = 'heavenkey.test';
const pin = process.env.HEAVENKEY_TEST_DEVICE_PIN ?? '417926';
const execute = promisify(execFile);
const adb = async (...args: string[]) => (await execute(join(sdk, 'platform-tools/adb'), ['-s', serial, ...args], { encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
const check: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
check(Number.isInteger(port) && port >= 1024 && port <= 65535 && /^\d{4,12}$/.test(pin), 'Valid fixture port and synthetic device PIN required');
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest();
const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
function bytes(value: unknown, max = 65_536): Buffer {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && value.length <= max * 4 / 3 + 4, 'Canonical bounded base64url required');
  const data = Buffer.from(value, 'base64url'); check(data.length <= max && b64(data) === value, 'Invalid base64url'); return data;
}
async function bounded<T>(name: string, promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}
type NativeNode = Record<string, string>;
const nativeFile = `/data/local/tmp/heavenkey-passkey-${process.pid}.xml`;
async function nodes(): Promise<NativeNode[]> {
  await adb('shell', 'uiautomator', 'dump', nativeFile);
  return [...(await adb('shell', 'cat', nativeFile)).matchAll(/<node\s+([^>]+)>/g)].map(match => Object.fromEntries(
    [...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(a => [a[1], a[2].replaceAll('&amp;', '&').replaceAll('&quot;', '"')])));
}
async function tap(node: NativeNode) {
  const box = node.bounds?.match(/\d+/g)?.map(Number); check(box?.length === 4, 'Observed native bounds required');
  await adb('shell', 'input', 'tap', String(Math.round((box[0] + box[2]) / 2)), String(Math.round((box[1] + box[3]) / 2)));
}
const scratch = mkdtempSync(join(tmpdir(), 'heavenkey-website-passkey-'));
const userName = `website-${randomBytes(6).toString('hex')}@example.test`;
const userHandle = randomBytes(32);
type Pending = { kind: 'create' | 'get'; expires: number; rp: string };
type Saved = { key: KeyObject; user: Buffer; rp: string };
const challenges = new Map<string, Pending>(), credentials = new Map<string, Saved>();
const verified = { registrations: 0, authentications: 0 };
const events: Array<Record<string, unknown>> = [];
const sources = ['scripts/mobile_passkey_e2e.ts', 'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/PasskeyStore.kt',
  'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/PasskeyActivity.kt', 'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/HeavenCredentialProvider.kt',
  'apps/mobile/android/app/src/main/assets/browser_trust.json', 'apps/mobile/android/app/build.gradle.kts', 'apps/mobile/android/app/src/main/AndroidManifest.xml'];
const sourceHashes = Object.fromEntries(sources.map(p => [p, sha(readFileSync(join(root, p))).toString('hex')]));
const apkHash = sha(readFileSync(apk)).toString('hex');
function field(value: unknown, key: string | number): unknown {
  return value instanceof Map ? value.get(key) : (value as Record<string, unknown> | undefined)?.[key];
}
function inspectAuth(value: Buffer, expectedRp: string, registration: boolean): number {
  check(value.length >= 37 && value.subarray(0, 32).equals(sha(expectedRp)), 'RP hash mismatch');
  const flags = value[32]; check((flags & 0x05) === 0x05 && (flags & 0x08) !== 0 && (!(flags & 0x10) || Boolean(flags & 0x08)), 'UP/UV/backup flags invalid');
  check((flags & 0x80) === 0 && Boolean(flags & 0x40) === registration && value.readUInt32BE(33) === 0, 'Unexpected extensions, attestation flag or counter');
  return flags;
}
function finish(kind: 'create' | 'get', payload: Record<string, unknown>) {
  check(payload.type === 'public-key' && typeof payload.id === 'string' && payload.rawId === payload.id, 'Credential identity mismatch');
  const response = payload.response as Record<string, unknown>;
  check(response && typeof response === 'object', 'Response required');
  const clientData = bytes(response.clientDataJSON, 8192);
  const client = JSON.parse(clientData.toString('utf8'));
  check(client.type === `webauthn.${kind}` && client.origin === origin && client.crossOrigin !== true, 'Client data origin/type mismatch');
  const pending = challenges.get(client.challenge); challenges.delete(client.challenge);
  check(pending && pending.kind === kind && Date.now() < pending.expires && pending.rp === rpId, 'Expired, replayed or mismatched server challenge');
  if (kind === 'create') {
    const attestation = decode(bytes(response.attestationObject));
    const statement = field(attestation, 'attStmt');
    check(field(attestation, 'fmt') === 'none' && statement && (statement instanceof Map ? statement.size : Object.keys(statement).length) === 0, 'none attestation required');
    const auth = Buffer.from(field(attestation, 'authData') as Uint8Array); inspectAuth(auth, rpId, true);
    check(auth.length > 55, 'Attested credential data required');
    const length = auth.readUInt16BE(53), id = auth.subarray(55, 55 + length);
    check(length === 32 && b64(id) === payload.id && auth.length > 55 + length, 'Attested credential ID mismatch');
    const cose = decode(auth.subarray(55 + length));
    check(field(cose, 1) === 2 && field(cose, 3) === -7 && field(cose, -1) === 1, 'ES256 P-256 COSE key required');
    const x = Buffer.from(field(cose, -2) as Uint8Array), y = Buffer.from(field(cose, -3) as Uint8Array);
    check(x.length === 32 && y.length === 32 && !credentials.has(payload.id), 'Invalid or duplicate public key');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(x), y: b64(y) }, format: 'jwk' });
    credentials.set(payload.id, { key, user: userHandle, rp: rpId }); verified.registrations++;
  } else {
    const saved = credentials.get(payload.id); check(saved && saved.rp === rpId, 'Unknown credential');
    const auth = bytes(response.authenticatorData); inspectAuth(auth, saved.rp, false); check(auth.length === 37, 'Assertion data length mismatch');
    check(bytes(response.userHandle, 64).equals(saved.user), 'User handle mismatch');
    // OpenSSL-backed Node crypto consumes the provider's DER ECDSA signature directly.
    check(verify('sha256', Buffer.concat([auth, sha(clientData)]), saved.key, bytes(response.signature, 256)), 'Assertion signature invalid');
    verified.authentications++;
  }
  return { verified: true, kind, credentialFingerprint: sha(payload.id).toString('hex') };
}
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>HeavenKey website passkey fixture</title>
<h1>Synthetic website passkey</h1><button id="create">Create synthetic passkey</button><button id="get">Use synthetic passkey</button><output id="status">idle</output>
<script>
let prepared, controller; const status=document.querySelector('#status');
const enc=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const dec=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
window.prepare=async(kind,wrong=false)=>{prepared=await (await fetch('/options/'+kind+(wrong?'?wrong=1':''))).json();status.textContent='ready';};
async function run(kind){controller=new AbortController();const timer=setTimeout(()=>controller.abort(),30000);status.textContent='pending';try{
const p=prepared;p.challenge=dec(p.challenge);if(p.user)p.user.id=dec(p.user.id);for(const k of ['allowCredentials','excludeCredentials'])if(p[k])p[k]=p[k].map(v=>({...v,id:dec(v.id)}));
const credential=await navigator.credentials[kind]({publicKey:p,signal:controller.signal});if(!credential)throw Error('No credential');const r=credential.response;
const payload={id:credential.id,rawId:enc(credential.rawId),type:credential.type,response:{clientDataJSON:enc(r.clientDataJSON)}};
for(const k of ['attestationObject','authenticatorData','signature','userHandle'])if(r[k])payload.response[k]=enc(r[k]);
const result=await fetch('/finish/'+kind,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});if(!result.ok)throw Error('Fixture verification failed');
const receipt=await result.json();status.textContent=JSON.stringify({state:'verified',kind,credentialFingerprint:receipt.credentialFingerprint});
}catch(error){status.textContent=JSON.stringify({state:'error',kind,name:error.name});}finally{clearTimeout(timer);}}
document.querySelector('#create').onclick=()=>run('create');document.querySelector('#get').onclick=()=>run('get');
</script>`;
let device: Awaited<ReturnType<typeof _android.devices>>[number] | undefined;
let context: BrowserContext | undefined, page: Page | undefined;
let engineVersion: string | undefined;
let forward: string | undefined, server: ReturnType<typeof createServer> | undefined;
let receipt: Record<string, unknown> | undefined;
const deadline = setTimeout(() => { console.error('Website passkey harness exceeded 350 seconds'); process.exitCode = 1; void context?.close(); }, 350_000);
try {
  check((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).trim() === 'heavenkey-20261024', 'Owned AVD heavenkey-20261024 on emulator-5584 required');
  check(Number((await adb('shell', 'getprop', 'ro.build.version.sdk')).trim()) >= 34, 'Credential Provider requires Android API34+');
  check(!(await adb('shell', 'dumpsys', 'user')).includes('RUNNING_LOCKED'), 'Parent must unlock the synthetic device before this journey');
  const browserVersion = (await adb('shell', 'dumpsys', 'package', browser)).match(/versionName=([^\s]+)/)?.[1];
  check(browserVersion, 'Installed Brave version required');
  const resolved = await adb('shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE', '-d', 'https://heavenkey.example');
  check(resolved.includes(browser + '/'), 'Current default browser must be official Brave');
  const enabled = await adb('shell', 'settings', 'get', 'secure', 'credential_service');
  check(enabled.includes(app + '/'), 'Enable HeavenKey in Android Passwords, passkeys & accounts before running');
  const installed = (await adb('shell', 'pm', 'path', app)).trim().split('\n');
  check(installed.length === 1 && installed[0].startsWith('package:'), 'Single installed candidate APK required');
  await adb('pull', installed[0].slice(8), join(scratch, 'installed.apk'));
  check(sha(readFileSync(join(scratch, 'installed.apk'))).toString('hex') === apkHash, 'Installed APK differs from candidate');
  const browserBase = (await adb('shell', 'pm', 'path', browser)).trim().split('\n').find(p => p.endsWith('/base.apk'));
  check(browserBase, 'Installed Brave APK required'); await adb('pull', browserBase.slice(8), join(scratch, 'browser.apk'));
  const tools = readdirSync(join(sdk, 'build-tools')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  check(tools.length > 0, 'Android apksigner required');
  const signer = (await execute(join(sdk, 'build-tools', tools[0], 'apksigner'), ['verify', '--print-certs', join(scratch, 'browser.apk')], { encoding: 'utf8', timeout: 20_000 })).stdout;
  const actual = [...signer.matchAll(/^(?:Signer #\d+|V[0-9.]+ Signer:) certificate SHA-256 digest: ([a-fA-F0-9]{64})$/gm)].map(m => m[1].toLowerCase());
  const pinned: string[] = JSON.parse(readFileSync(join(root, 'apps/mobile/android/app/src/main/assets/browser_trust.json'), 'utf8'))[browser];
  check(actual.length > 0 && actual.every(value => pinned.includes(value)), 'Brave official signer mismatch');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=heavenkey.test', '-addext', 'subjectAltName=DNS:heavenkey.test,DNS:other.test', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { stdio: 'ignore', timeout: 15_000 });
  const publicPem = execFileSync('openssl', ['x509', '-in', join(scratch, 'cert.pem'), '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: publicPem, timeout: 5000 });
  const tlsPin = sha(der).toString('base64');
  server = createServer({ key: readFileSync(join(scratch, 'key.pem')), cert: readFileSync(join(scratch, 'cert.pem')) }, async (req, res) => {
    const send = (status: number, body: unknown, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      check(req.headers.host === `heavenkey.test:${port}`, 'Wrong fixture host');
      const url = new URL(req.url ?? '/', origin), kind = url.pathname.endsWith('/create') ? 'create' : 'get';
      if (req.method === 'GET' && url.pathname.startsWith('/options/')) {
        for (const [key, value] of challenges) if (value.expires <= Date.now()) challenges.delete(key);
        check(challenges.size < 32, 'Fixture challenge bound exceeded');
        const challenge = b64(randomBytes(32)), rp = url.searchParams.has('wrong') ? 'other.test' : rpId;
        challenges.set(challenge, { kind, rp, expires: Date.now() + 30_000 });
        const options = kind === 'create' ? { challenge, rp: { id: rp, name: 'HeavenKey synthetic fixture' }, user: { id: b64(userHandle), name: userName, displayName: 'Synthetic website account' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 30_000, attestation: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' } } :
          { challenge, rpId: rp, timeout: 30_000, userVerification: 'required', allowCredentials: [...credentials.keys()].map(id => ({ type: 'public-key', id })) };
        send(200, options);
      } else if (req.method === 'POST' && url.pathname.startsWith('/finish/')) {
        check(req.headers.origin === origin && req.headers['content-type'] === 'application/json', 'Cross-origin fixture submission rejected');
        let size = 0; const chunks: Buffer[] = [];
        for await (const part of req) { size += part.length; check(size <= 65_536, 'Fixture payload bound exceeded'); chunks.push(Buffer.from(part)); }
        send(200, finish(kind, JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      } else if (req.method === 'GET' && url.pathname === '/') send(200, html, 'text/html; charset=utf-8');
      else send(404, { error: 'not_found' });
    } catch { send(400, { error: 'fixture_verification_rejected' }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((ok, fail) => { server!.once('error', fail); server!.listen(port, '127.0.0.1', ok); });
  device = (await _android.devices({ omitDriverInstall: true })).find(d => d.serial() === serial); check(device, 'Owned Android Playwright device required');
  async function launch() {
    context = await bounded('Brave launch', device!.launchBrowser({ pkg: browser, viewport: null, args: ['--no-first-run', '--ignore-certificate-errors-spki-list=' + tlsPin, '--host-resolver-rules="MAP heavenkey.test 10.0.2.2,MAP other.test 10.0.2.2"'] }), 20_000);
    engineVersion = context.browser()?.version();
    context.setDefaultTimeout(10_000); page = await context.newPage(); await page.goto(origin);
    check(await page.evaluate(() => isSecureContext && typeof PublicKeyCredential === 'function'), 'Real browser WebAuthn secure context required');
  }
  await launch();
  async function status() { const text = await page!.locator('#status').textContent(); try { return JSON.parse(text ?? '') as { state: string; name?: string }; } catch { return { state: text ?? '' }; } }
  async function prepare(kind: 'create' | 'get', wrong = false) {
    await page!.evaluate(async ({ kind, wrong }) => { await (window as unknown as { prepare: (kind: string, wrong: boolean) => Promise<void> }).prepare(kind, wrong); }, { kind, wrong });
    await page!.locator('#' + kind).click();
  }
  async function native(kind: 'create' | 'get', cancel = false) {
    const end = Date.now() + 30_000; let selected = false, cancelObserved = false;
    const observed = new Set<string>();
    while (Date.now() < end) {
      const current = await status(); if (current.state === 'verified' || current.state === 'error') { events.push({ kind, terminal: current, observed: [...observed] }); check(!cancel || cancelObserved, 'Cancellation must occur in actual HeavenKey UI'); return current; }
      const state = await nodes();
      const ours = state.some(n => n.package === app && /Passkey erstellen|Passkeys anzeigen|Mit Passkey anmelden/.test(n.text ?? ''));
      if (ours) {
        observed.add('HeavenKey activity');
        check(state.some(n => n.package === app && (n.text ?? '').includes(origin)), 'Actual provider must show the requested HTTPS origin');
        const button = state.find(n => n.package === app && new RegExp(cancel ? '^Abbrechen$' : '^Freigeben$', 'i').test(n.text ?? ''));
        check(button, 'Provider consent button missing'); await tap(button); if (cancel) cancelObserved = true;
      } else {
        const entry = state.find(n => n.package !== app && (/^HeavenKey(?: entsperren)?$/i.test(n.text ?? '') || n.text === userName));
        const system = state.find(n => /credentialmanager|permissioncontroller|google.android.gms/.test(n.package ?? '') && /^(Continue|Create|Save|Next|Weiter|Erstellen|Speichern)$/i.test(n.text ?? '') && state.some(item => /HeavenKey/.test(item.text ?? '')));
        const pinField = state.find(n => n.package === 'com.android.systemui' && /lockPassword|pinEntry/.test(n['resource-id'] ?? ''));
        if (pinField) { observed.add('Device credential authentication'); await tap(pinField); await adb('shell', 'input', 'text', pin); await adb('shell', 'input', 'keyevent', '66'); }
        else if (system) { observed.add('Android selected-provider confirmation'); selected = true; await tap(system); }
        else if (entry) { observed.add('Android credential selector'); selected = true; await tap(entry); }
        else {
          const system = state.find(n => /credentialmanager|permissioncontroller|google.android.gms/.test(n.package ?? '') && /^(Continue|Create|Save|Next|Weiter|Erstellen|Speichern)$/i.test(n.text ?? '') && selected);
          if (system) await tap(system);
        }
      }
      await pause(150);
    }
    events.push({ kind, observed: [...observed] });
    throw new Error('Native provider flow unavailable within 30s; inspect Credential Manager enablement, Brave routing and API34 system UI');
  }
  console.log('PASSKEY_PHASE registration cancellation');
  await prepare('create'); const cancelled = await native('create', true);
  check(cancelled.state === 'error' && ['NotAllowedError', 'AbortError'].includes(cancelled.name ?? '') && Number(verified.registrations) === 0, 'Cancelled registration must not produce a server credential');
  events.push({ phase: 'native_consent_cancellation', passed: true });
  console.log('PASSKEY_PHASE website registration');
  await prepare('create'); check((await native('create')).state === 'verified' && Number(verified.registrations) === 1, 'Actual website registration must verify');
  events.push({ phase: 'website_registration', passed: true });
  console.log('PASSKEY_PHASE website authentication');
  await prepare('get'); check((await native('get')).state === 'verified' && Number(verified.authentications) === 1, 'Actual provider assertion must verify');
  console.log('PASSKEY_PHASE wrong RP');
  await prepare('get', true);
  await page!.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('"state":"error"'), { timeout: 10_000 });
  check((await status()).name === 'SecurityError' && Number(verified.authentications) === 1, 'Browser must reject unrelated RP before provider use');
  check(!(await nodes()).some(n => n.package === app && /Passkeys anzeigen|Mit Passkey anmelden/.test(n.text ?? '')), 'Wrong RP must not open provider UI');
  events.push({ phase: 'browser_wrong_rp_rejection', passed: true });
  console.log('PASSKEY_PHASE persistence across app and browser restart');
  await bounded('Browser restart cleanup', context!.close(), 5000); context = undefined;
  await adb('shell', 'am', 'force-stop', app);
  await adb('shell', 'am', 'start', '-n', app + '/.MainActivity');
  await launch(); await prepare('get');
  check((await native('get')).state === 'verified' && Number(verified.authentications) === 2, 'Encrypted passkey must survive provider and browser restart');
  events.push({ phase: 'restart_persistence', passed: true });
  const sockets = [...new Set([...(await adb('shell', 'cat', '/proc/net/unix')).matchAll(/@(playwright_[a-f0-9]+_devtools_remote)\b/g)].map(m => m[1]))];
  check(sockets.length === 1, 'Exactly one owned Playwright browser socket required for mk observation');
  forward = (await adb('forward', 'tcp:0', 'localabstract:' + sockets[0])).trim(); check(/^\d+$/.test(forward), 'Owned CDP forward required');
  const tabs = JSON.parse((await execute('mk', ['act', '--cdp', forward, 'tab list'], {encoding:'utf8', timeout:15_000})).stdout);
  const selectedTab = tabs.tabs.find((tab: {url:string}) => tab.url === origin || tab.url === origin + '/');
  check(selectedTab, 'Observed fixture tab required for mk');
  const observation = (await execute('mk', ['act', '--cdp', forward, `tab switch ${selectedTab.n};;eval isSecureContext && location.origin === ${JSON.stringify(origin)} && JSON.parse(document.querySelector("#status").textContent).state === "verified"`], { encoding: 'utf8', timeout: 15_000 })).stdout;
  const mkResult = JSON.parse(observation);
  check(mkResult.ok === true && JSON.parse(mkResult.value) === true, 'mk must observe verified result in the actual Android browser');
  for (const [path, hash] of Object.entries(sourceHashes)) check(sha(readFileSync(join(root, path))).toString('hex') === hash, 'Candidate source changed during acceptance');
  check(sha(readFileSync(apk)).toString('hex') === apkHash, 'Candidate APK changed during acceptance');
  receipt = { passed: true, synthetic_only: true, real_browser_credential_provider: true, virtual_authenticator: false,
    browser_package: browser, browser_version: browserVersion, engine_version: engineVersion, browser_signers: actual, apk_sha256: apkHash, source_files: sourceHashes, origin,
    registrations: verified.registrations, authentications: verified.authentications, cancellation_rejected: true,
    wrong_rp_rejected_by_browser: true, app_browser_restart_persistence: true, mk_observation: observation.slice(0, 4096),
    physical_device_acceptance: false, sync_acceptance: false, synthetic_passkey_retained_for_manual_deletion: true, events };
 } catch (error) {
  writeFileSync(evidence, JSON.stringify({ passed: false, synthetic_only: true, apk_sha256: apkHash,
    source_files: sourceHashes, events, error: error instanceof Error ? error.message.replaceAll(pin, '[redacted]') : 'Harness failure' }, null, 2) + '\n');
  throw error;
} finally {
  clearTimeout(deadline);
  const cleanupErrors: string[] = [];
  const cleanup = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); } catch { cleanupErrors.push(label); }
  };
  if (forward) await cleanup('CDP forward', () => adb('forward', '--remove', 'tcp:' + forward!));
  await cleanup('Native snapshot', () => adb('shell', 'rm', '-f', nativeFile));
  await cleanup('Browser', () => bounded('Browser cleanup', context?.close() ?? Promise.resolve(), 5000));
  await cleanup('Device handle', () => bounded('Device cleanup', device?.close() ?? Promise.resolve(), 5000));
  server?.closeAllConnections();
  if (server) await cleanup('Fixture socket', () => bounded('Fixture cleanup', new Promise<void>(r => server!.close(() => r())), 5000));
  rmSync(scratch, { recursive: true, force: true });
  check(cleanupErrors.length === 0, 'Cleanup failed: ' + cleanupErrors.join(', '));
}
check(receipt, 'Actual acceptance receipt missing');
writeFileSync(evidence, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, real_android_provider: true, registrations: verified.registrations, authentications: verified.authentications, evidence }));
