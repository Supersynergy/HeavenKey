import { _android, type Locator } from 'playwright-core';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const browserPackage = process.env.HEAVENKEY_TEST_BROWSER ?? 'com.brave.browser';
if (!['com.android.chrome', 'com.brave.browser'].includes(browserPackage)) throw new Error('Unsupported test browser');
const sdk = process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools';
const execute = promisify(execFile);
const adb = async (...args: string[]) => (await execute(join(sdk, 'platform-tools/adb'), ['-s', 'emulator-5584', ...args], { encoding: 'utf8', timeout: 20_000 })).stdout;
const check = (value: unknown, label: string) => { if (!value) throw new Error(label); };
check((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).trim() === 'heavenkey-20261024', 'Own isolated AVD required');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function bounded<T>(label: string, work: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
const phase = (name: string) => console.log('BROWSER_PHASE ' + name);
type UiNode = Record<string, string>;
async function nodes(): Promise<UiNode[]> {
  await adb('shell', 'uiautomator', 'dump', '/data/local/tmp/heavenkey-autofill.xml');
  return [...(await adb('shell', 'cat', '/data/local/tmp/heavenkey-autofill.xml')).matchAll(/<node\s+([^>]+)>/g)].map(match =>
    Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(a => [a[1], a[2].replaceAll('&amp;', '&').replaceAll('&quot;', '"')])));
}
async function tap(node: UiNode) {
  const box = node.bounds?.match(/\d+/g)?.map(Number);
  check(box?.length === 4, 'Observed native bounds required');
  await adb('shell', 'input', 'tap', String((box![0] + box![2]) / 2), String((box![1] + box![3]) / 2));
}
async function clickNative(predicate: (node: UiNode) => boolean, label: string) {
  let state: UiNode[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    state = await nodes(); const found = state.find(predicate);
    if (found) { await tap(found); return; }
    await pause(350);
  }
  throw new Error(label + ': ' + JSON.stringify(state.filter(n => n.text || n['content-desc']).map(n => ({ text: n.text, id: n['resource-id'], description: n['content-desc'] }))));
}
const scratch = mkdtempSync(join(tmpdir(), 'heavenkey-adaptive-tls-'));
const servers: ReturnType<typeof createServer>[] = [];
let device: Awaited<ReturnType<typeof _android.devices>>[number] | undefined;
let receipt: Record<string, unknown> | undefined;
let context: Awaited<ReturnType<NonNullable<typeof device>['launchBrowser']>> | undefined;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=heavenkey.test', '-addext', 'subjectAltName=DNS:heavenkey.test,DNS:other.test', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { stdio: 'ignore', timeout: 15_000 });
  const pub = execFileSync('openssl', ['x509', '-in', join(scratch, 'cert.pem'), '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: pub });
  const pin = createHash('sha256').update(der).digest('base64');
  const form = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>HeavenKey synthetic test</title><form><p><label>Username <input id="u" name="username" autocomplete="username"></label></p><p><label>Password <input id="p" name="password" type="password" autocomplete="current-password"></label></p><button>Sign in</button></form><script>document.querySelector("form").onsubmit=e=>e.preventDefault()</script>';
  const handler = (req: {url?: string}, res: import('node:http').ServerResponse) => {
    const mobileFrame = (host: string) => '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><iframe style="width:100%;height:500px" src="https://' + host + ':9443/form"></iframe>';
    const body = req.url?.startsWith('/frame-other') ? mobileFrame('other.test') : req.url?.startsWith('/frame-same') ? mobileFrame('heavenkey.test') : form;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body);
  };
  for (const port of [8443, 9443]) {
    const server = createServer({ key: readFileSync(join(scratch, 'key.pem')), cert: readFileSync(join(scratch, 'cert.pem')) }, handler);
    await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); }); servers.push(server);
  }
  const plain = httpServer(handler);
  await new Promise<void>((ok, fail) => { plain.once('error', fail); plain.listen(8888, '127.0.0.1', ok); });
  servers.push(plain as unknown as ReturnType<typeof createServer>);
  device = (await _android.devices({ omitDriverInstall: true })).find(d => d.serial() === 'emulator-5584');
  check(device, 'Own emulator handle missing');
  const browserVersion = (await adb('shell', 'dumpsys', 'package', browserPackage)).match(/versionName=([^\s]+)/)?.[1];
  const legacyTestFlag = browserPackage === 'com.android.chrome' && Number(browserVersion?.split('.')[0]) < 135;
  const legacyFeature = 'AutofillVirtualViewStructureAndroid:skip_compatibility_check/skip_all_checks';
  const launch = async () => {
    phase('launch');
    const value = await bounded('launch browser', device!.launchBrowser({ pkg: browserPackage, viewport: null, args: ['--no-first-run', '--ignore-certificate-errors-spki-list=' + pin, '--host-resolver-rules="MAP heavenkey.test 10.0.2.2,MAP other.test 10.0.2.2"', ...(legacyTestFlag ? ['--enable-features=' + legacyFeature] : [])] }), 15_000);
    value.setDefaultTimeout(8_000); return value;
  };
  await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  await adb('shell', 'input', 'swipe', '540', '2000', '540', '400', '300');
  if ((await adb('shell', 'dumpsys', 'user')).includes('RUNNING_LOCKED')) {
    phase('unlock isolated test device');
    await clickNative(n => n.package === 'com.android.systemui' && /lockPassword|pinEntry/.test(n['resource-id'] ?? ''), 'Isolated device PIN');
    await adb('shell', 'input', 'text', '417926'); await adb('shell', 'input', 'keyevent', '66');
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await adb('shell', 'dumpsys', 'user')).includes('RUNNING_LOCKED')) break;
      await pause(100);
    }
    check(!(await adb('shell', 'dumpsys', 'user')).includes('RUNNING_LOCKED'), 'Test device credential storage must be unlocked');
  }
  await adb('shell', 'settings', 'put', 'secure', 'autofill_service', 'app.heavenkey.heavenkey_mobile/.HeavenAutofillService');
  await adb('shell', 'cmd', 'role', 'add-role-holder', 'android.app.role.BROWSER', browserPackage);
  context = await launch();
  let page = await context.newPage();
  async function browserSettings() {
    const result = await adb('shell', 'am', 'start', '-a', 'android.intent.action.APPLICATION_PREFERENCES', '-c', 'android.intent.category.DEFAULT', '-c', 'android.intent.category.APP_BROWSER', '-c', 'android.intent.category.PREFERENCE', '-p', browserPackage);
    check(!result.includes('Error'), 'Public browser autofill settings intent required');
  }
  phase('browser third-party mode');
  await page.bringToFront();
  const notice = (await nodes()).find(n => n.text === 'No thanks');
  if (notice) await tap(notice);
  await browserSettings();
  await clickNative(n => /Autofill (using|with) another service/i.test(n.text), 'Browser external provider mode');
  writeFileSync('/tmp/heavenkey-chrome-mode-before-restart.json', JSON.stringify(await nodes(), null, 2));
  await pause(1_000);
  const restart = (await nodes()).find(n => /restart|relaunch/i.test(n.text) && n.class === 'android.widget.Button');
  if (restart) {
    // Playwright removes this file after launch; Chrome's own restart needs the legacy test flag too.
    if (legacyTestFlag) {
      const flags = join(scratch, 'chrome-command-line');
      writeFileSync(flags, '_ --disable-fre --no-first-run --enable-features=' + legacyFeature + '\n');
      await adb('push', flags, '/data/local/tmp/chrome-command-line');
    }
    await tap(restart);
    await pause(1_000);
    await bounded('Chrome restart cleanup', context.close().catch(error => { if (!String(error).includes('closed')) throw error; }), 5_000);
    context = await launch(); page = await context.newPage();
  } else {
    await adb('shell', 'input', 'keyevent', '4');
  }
  writeFileSync('/tmp/heavenkey-autofill-system-state.txt', await adb('shell', 'dumpsys', 'autofill'));
  await page.bringToFront();
  await browserSettings();
  const mode = await nodes();
  writeFileSync('/tmp/heavenkey-chrome-mode-after-restart.json', JSON.stringify(mode, null, 2));
  const external = mode.find(n => /Autofill (using|with) another service/i.test(n.text));
  const labelBox = external?.bounds.match(/\d+/g)?.map(Number);
  check(labelBox && mode.some(n => {
    if (n.checked !== 'true' || n['resource-id'] !== browserPackage + ':id/radio_button') return false;
    const box = n.bounds.match(/\d+/g)!.map(Number), middle = (box[1] + box[3]) / 2;
    return middle >= labelBox![1] - 96 && middle <= labelBox![3] + 96;
  }), 'External autofill mode must remain selected after browser restart');
  await adb('shell', 'input', 'keyevent', '4');
  {
    const base = 'https://heavenkey.test:8443';
    async function nativeFocus(field: Locator) {
      await page.bringToFront();
      await field.scrollIntoViewIfNeeded();
      const state = await nodes();
      const container = state.find(n => n['resource-id'] === browserPackage + ':id/compositor_view_holder');
      const controls = state.find(n => n['resource-id'] === browserPackage + ':id/control_container');
      const area = container?.bounds.match(/\d+/g)?.map(Number);
      const toolbar = controls?.bounds.match(/\d+/g)?.map(Number);
      const box = await field.boundingBox();
      const ratio = await page.evaluate(() => devicePixelRatio * (visualViewport?.scale ?? 1));
      check(area?.length === 4 && toolbar?.length === 4 && box, 'Observed browser content and field geometry required');
      const left = area![0], top = Math.max(area![1], toolbar![3]);
      await adb('shell', 'input', 'tap', String(Math.round(left + (box!.x + box!.width / 2) * ratio)), String(Math.round(top + (box!.y + box!.height / 2) * ratio)));
      let focused = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (await field.evaluate(element => element.ownerDocument.activeElement === element)) { focused = true; break; }
        await pause(100);
      }
      if (!focused) writeFileSync('/tmp/heavenkey-autofill-focus.json', JSON.stringify({box, area, toolbar, ratio}));
      check(focused, 'Native tap must focus the intended form field');
    }
    async function request(path = '/form', frame = false) {
      phase('request ' + path);
      await page.goto(base + path); const scope = frame ? page.frameLocator('iframe') : page;
      await nativeFocus(scope.locator('#u'));
      phase('locked dataset');
      await clickNative(n => n.text?.includes('Domainfreigabe mit HeavenKey prüfen'), 'Native locked dataset');
      const state = await nodes();
      check(state.some(n => n.text?.includes('umfasst andere HTTPS-Ports')), 'Explicit port/frame scope must precede authentication');
      check(!state.some(n => n.package === 'com.android.systemui' && /lockPassword|pinEntry/.test(n['resource-id'] ?? '')), 'No authentication before host consent');
      return scope;
    }
    async function beginAuthentication() {
      phase('consent');
      await clickNative(n => /^einmal freigeben$/i.test(n.text), 'One-time host consent');
      await clickNative(n => n.package === 'com.android.systemui' && /lockPassword|pinEntry/.test(n['resource-id'] ?? ''), 'Native device authentication');
    }
    async function authorize() {
      await beginAuthentication();
      await adb('shell', 'input', 'text', '417926'); await adb('shell', 'input', 'keyevent', '66');
    }
    async function expectValue(field: Locator, value: string) {
      await bounded('Asynchronous native autofill result', (async () => {
        for (let attempt = 0; attempt < 80; attempt++) {
          if (await field.inputValue() === value) return;
          await pause(100);
        }
        throw new Error('Selected autofill value did not arrive');
      })(), 8_000);
    }
    const cancelled = await request();
    await clickNative(n => /^abbrechen$/i.test(n.text), 'Cancel host permission');
    check(await cancelled.locator('#p').inputValue() === '', 'Cancelled permission must not fill');
    const pinCancelled = await request(); await beginAuthentication();
    await adb('shell', 'input', 'keyevent', '4');
    check(await pinCancelled.locator('#p').inputValue() === '', 'Cancelled device authentication must not fill');
    const standard = await request(); await authorize();
    await clickNative(n => n.text?.startsWith('Default-port synthetic'), 'Explicit saved account selection');
    await Promise.all([expectValue(standard.locator('#u'), 'default@example.test'), expectValue(standard.locator('#p'), 'Synthetic-autofill-only-24')]);
    const sameFrame = await request('/frame-same', true); await authorize();
    await clickNative(n => n.text?.startsWith('Custom-port synthetic'), 'Explicit nondefault-port account');
    await Promise.all([expectValue(sameFrame.locator('#u'), 'port@example.test'), expectValue(sameFrame.locator('#p'), 'Synthetic-autofill-only-24')]);
    await page.goto(base + '/frame-other'); await nativeFocus(page.frameLocator('iframe').locator('#u')); await pause(500);
    check(!(await nodes()).some(n => n.text?.includes('Domainfreigabe mit HeavenKey prüfen')), 'Foreign-host frame must not receive a HeavenKey dataset');
    check(await page.frameLocator('iframe').locator('#p').inputValue() === '', 'Foreign frame stays empty');
    await page.goto('https://other.test:8443/form'); await nativeFocus(page.locator('#u'));
    // The generic locked prompt reveals no account metadata; an unrelated host has no matching entries.
    if ((await nodes()).some(n => n.text?.includes('Domainfreigabe mit HeavenKey prüfen'))) {
      await clickNative(n => n.text?.includes('Domainfreigabe mit HeavenKey prüfen'), 'Other host generic prompt');
      await authorize();
      const state = await nodes();
      check(state.some(n => n.text === 'Kein passender Login'), 'Unrelated host must have no matching saved account');
      check(!state.some(n => n.text?.includes('default@example.test')), 'Unrelated host gets no saved account metadata');
      await clickNative(n => /^schlie(?:ß|ss)en$/i.test(n.text), 'Close unmatched host');
    }
    check(await page.locator('#p').inputValue() === '', 'Other host gets no credentials');
    await page.goto('http://heavenkey.test:8888/form'); await nativeFocus(page.locator('#u'));
    check(!(await nodes()).some(n => n.text?.includes('Domainfreigabe mit HeavenKey prüfen')), 'HTTP is ineligible');
    const expired = await request();
    await pause(31_000);
    await clickNative(n => /^einmal freigeben$/i.test(n.text), 'Expired host confirmation');
    check(!(await nodes()).some(n => n.package === 'com.android.systemui' && /lockPassword|pinEntry/.test(n['resource-id'] ?? '')), 'Expired request must not start device authentication');
    check(await expired.locator('#p').inputValue() === '', 'Expired request cannot fill');
    const appSources = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/mobile'], {cwd: root, encoding: 'utf8'}).trim().split('\n');
    const sourceFiles = [...new Set(['scripts/mobile_autofill_e2e.ts', 'docs/evidence/mobile/test-browser-provenance.json', ...appSources])];
    receipt = { passed: true, synthetic_only: true, kind: 'actual Android Autofill and verified browser with pinned synthetic TLS certificate', browser_package: browserPackage, browser: browserVersion, engine_version: context!.browser()?.version(), legacy_test_flag: legacyTestFlag ? legacyFeature : null, current_phone_browser_acceptance: false, explicit_host_consent_before_auth: true, no_fill_without_consent: true, same_host_other_port_requires_consent: true, foreign_host_rejected: true, foreign_frame_rejected: true, same_host_frame_requires_consent: true, cancellation_rejected: true, device_authentication_cancelled: true, browser_signer_verified: true, http_rejected: true, full_field_origin_verified: false, apk_sha256: createHash('sha256').update(readFileSync(join(root, 'dist/mobile/HeavenKey-0.24.0-android-preview.apk'))).digest('hex'), source_files: Object.fromEntries(sourceFiles.map(p => [p, createHash('sha256').update(readFileSync(join(root, p))).digest('hex')])) };

  }
 } finally {
  phase('cleanup');
  await adb('shell', 'rm', '-f', '/data/local/tmp/chrome-command-line');
  await bounded('context cleanup', context?.close().catch(error => { if (!String(error).includes('closed')) throw error; }) ?? Promise.resolve(), 5_000);
  await bounded('device cleanup', device?.close() ?? Promise.resolve(), 5_000);
  for (const server of servers) server.closeAllConnections();
  await bounded('fixture cleanup', Promise.all(servers.map(server => new Promise<void>(r => server.close(() => r())))), 5_000);
  rmSync(scratch, { recursive: true, force: true });
}
if (receipt) {
  writeFileSync(join(root, 'docs/evidence/mobile/android-browser-adaptive.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, browser: receipt.browser, adaptive_host_scope: true, full_field_origin_verified: false }));
}
