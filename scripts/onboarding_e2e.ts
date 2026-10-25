import { chromium, type Browser } from 'playwright-core';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dir, '..');
const report = process.env.HEAVENKEY_ONBOARDING_REPORT ?? join(root, 'docs/evidence/onboarding');
mkdirSync(report, { recursive: true });
const baseline = process.argv.includes('--baseline');
const receiptPath = join(report, baseline ? 'desktop-baseline.json' : 'desktop-acceptance.json');
rmSync(receiptPath, { force: true });
let receipt: Record<string, unknown> | undefined;
const scratch = mkdtempSync(join(tmpdir(), 'heavenkey-onboarding-'));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function port() {
  const listener = createServer();
  await new Promise<void>((ok, fail) => { listener.once('error', fail); listener.listen(0, '127.0.0.1', ok); });
  const address = listener.address(); assert(address && typeof address === 'object');
  const result = address.port; await new Promise<void>(ok => listener.close(() => ok())); return result;
}
const httpPort = await port(), cdpPort = await port();
const origin = `http://localhost:${httpPort}`;
let server: ChildProcess | undefined, chrome: ChildProcess | undefined, browser: Browser | undefined;
const sources = ['apps/web/src/passwords-entry-assist.ts', 'apps/web/src/passwords.ts', 'apps/web/src/passwords-onboarding.ts', 'apps/web/src/passwords.css', 'apps/web/passwords.html', 'scripts/onboarding_e2e.ts'];
const binaryHash = createHash('sha256').update(readFileSync(join(root, 'target/debug/uac-api'))).digest('hex');
const binaryVersion = execFileSync(join(root, 'target/debug/uac-api'), ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
const sourceHashes = Object.fromEntries(sources.map(p => [p, createHash('sha256').update(readFileSync(join(root, p))).digest('hex')]));
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let n = 0; n < 30 && child.exitCode === null; n++) await pause(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}
try {
  server = spawn(join(root, 'target/debug/uac-api'), ['--password-manager', '--port', String(httpPort), '--data-dir', join(scratch, 'vault')], { stdio: 'ignore', env: { ...process.env, HEAVENKEY_PUBLIC_ORIGIN: undefined, HEAVENKEY_ORIGIN: undefined, HEAVENKEY_SHARE_ORIGIN: undefined } });
  for (let n = 0; n < 100; n++) {
    assert.equal(server.exitCode, null, 'Owned desktop service must remain running');
    try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Startup is bounded by this loop. */ }
    await pause(100);
  }
  chrome = spawn(process.env.CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'), ['--headless=new', '--no-first-run', '--disable-background-networking', '--use-mock-keychain', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + join(scratch, 'chrome'), 'about:blank'], { stdio: 'ignore' });
  for (let n = 0; n < 100; n++) {
    assert.equal(chrome.exitCode, null, 'Owned browser must remain running');
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 500 }); break; } catch { /* CDP belongs to this fresh process. */ }
    await pause(100);
  }
  assert(browser, 'Fresh browser required');
  const context = browser.contexts()[0];
  const page = await context.newPage(); await page.setViewportSize({ width: 1440, height: 1000 });
  page.setDefaultTimeout(10_000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/passwords/');
  if (process.env.HEAVENKEY_ONBOARDING_FAULT === '1') { await page.evaluate(() => { setTimeout(() => { throw new Error("Synthetic onboarding receipt regression"); }, 0); }); await pause(50); assert(errors.length > 0); }
  await page.locator('#unlock:not([disabled])').waitFor();
  await page.screenshot({ path: join(report, baseline ? 'desktop-before-gate.png' : 'desktop-after-gate.png') });
  await page.locator('#master').fill('Synthetic-onboarding-master-2026!');
  await page.locator('#master-confirm').fill('Synthetic-onboarding-master-2026!');
  await page.locator('#unlock').click();
  await page.locator('#workspace:not([hidden])[aria-busy=false]').waitFor();
  await page.locator('[data-testid=setup-first-login]').click();
  const visibleFields = await page.locator('#entry-form input:visible, #entry-form textarea:visible, #entry-form select:visible').evaluateAll(nodes => nodes.map(n => n.id));
  await page.screenshot({ path: join(report, baseline ? 'desktop-before-entry.png' : 'desktop-after-entry.png') });
  if (baseline) {
    await page.locator('#entry-title').fill('Synthetic existing account');
    await page.locator('#entry-username').fill('synthetic@example.test');
    await page.locator('#entry-password').fill('Synthetic-existing-password-2026!');
    await page.locator('#entry-url').fill('example.com/login');
    await page.locator('#save-entry').click();
    assert(await page.locator('#editor').isVisible());
    const mismatch = await page.locator('#entry-url').evaluate(n => (n as HTMLInputElement).validity.typeMismatch);
    assert(mismatch, 'Baseline must reproduce bare-website rejection');
    receipt = { passed: true, baseline_only: true, synthetic_only: true, real_rust_service: true, source_files: sourceHashes, visible_editor_fields: visibleFields, bare_website_rejected: mismatch, human_time_delta_seconds: null, action_frequency_per_day: null };
    console.log('BASELINE: ' + visibleFields.length + ' visible editor fields; bare website rejected');
  } else {
    assert.deepEqual(visibleFields, ['entry-url', 'entry-title', 'entry-username', 'entry-password']);
    assert.equal(await page.locator('#entry-password').inputValue(), '', 'Existing accounts must never receive an automatic new password');
    assert(await page.locator('#entry-url').evaluate(n => n === document.activeElement));
    await page.locator('#entry-url').fill('example.com:8443/login');
    await page.locator('#entry-username').fill('synthetic@example.test');
    assert.equal(await page.locator('#entry-title').inputValue(), 'example.com');
    assert.equal(await page.locator('#entry-url').inputValue(), 'https://example.com:8443/login');
    await page.locator('#entry-password').fill('Synthetic-existing-password-2026!');
    await page.locator('#generate').click();
    assert.equal(await page.locator('#entry-password').inputValue(), 'Synthetic-existing-password-2026!');
    await page.locator('#generate-keep').click();
    await page.locator('#save-entry').click();
    await page.locator('[data-testid=first-login-backup]').waitFor();
    const downloadEvent = page.waitForEvent('download');
    await page.locator('[data-testid=first-login-backup]').click();
    const download = await downloadEvent;
    assert(download.suggestedFilename().endsWith('.json'));
    await page.locator('#new-entry').click();
    assert(await page.locator('#entry-advanced').getAttribute('open') !== null);
    await page.locator('#username-suggestions button').click();
    assert.equal(await page.locator('#entry-username').inputValue(), 'synthetic@example.test');
    await page.locator('#entry-title').fill('My chosen name');
    await page.locator('#entry-url').fill('https://accounts.example.com/signup');
    await page.locator('#entry-password').focus();
    assert.equal(await page.locator('#entry-title').inputValue(), 'My chosen name');
    await page.locator('#generate').click();
    const generated = await page.locator('#entry-password').inputValue();
    assert.equal(generated.length, 24);
    await page.locator('#generate').click();
    assert.equal(await page.locator('#entry-password').inputValue(), generated);
    await page.locator('#generate-replace').click();
    assert.notEqual(await page.locator('#entry-password').inputValue(), generated);
    await page.locator('#entry-url').fill('javascript:alert(1)');
    await page.locator('#save-entry').click();
    assert(await page.locator('#editor').isVisible());
    assert.equal(await page.locator('#entry-url').evaluate(n => (n as HTMLInputElement).validity.valid), false);
    await page.locator('#entry-url').fill('https://accounts.example.com/signup');
    await page.locator('#entry-password').focus();
    await page.keyboard.press('Control+Enter');
    await page.locator('#editor').waitFor({ state: 'hidden' });
    await page.locator('#onboarding-open').click();
    assert(await page.locator('#onboarding-backup').evaluate(n => n === document.activeElement));
    await page.keyboard.press('Escape');
    assert(await page.locator('#onboarding-open').evaluate(n => n === document.activeElement));
    await page.locator('#new-entry').click();
    await page.locator('#entry-title').fill('Unsaved synthetic draft');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#entry-title').inputValue(), '');
    await page.locator('#lock').click();
    assert.equal(await page.locator('#username-suggestions').textContent(), '');
    assert.equal(await page.locator('#entry-url-preview').textContent(), '');
    await page.reload();
    await page.locator('#unlock:not([disabled])').waitFor();
    await page.locator('#master').fill('Synthetic-onboarding-master-2026!');
    await page.locator('#unlock').click();
    await page.locator('#workspace:not([hidden])[aria-busy=false]').waitFor();
    assert.equal(await page.locator('[data-testid=login]').count(), 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#new-entry').click();
    assert(await page.locator('#editor').evaluate(n => n.getBoundingClientRect().right <= innerWidth));
    await page.screenshot({ path: join(report, 'desktop-after-narrow.png') });
    await page.keyboard.press('Escape');
    const mkRaw = execFileSync('mk', ['cdp', String(cdpPort), 'eval', 'document.querySelectorAll("[data-testid=login]").length === 2', '--target', origin], { encoding: 'utf8', timeout: 15_000 });
    const mk = JSON.parse(mkRaw); assert(mk.ok === true && JSON.parse(mk.value) === true, 'mk must independently observe the actual persisted entries');
    receipt = { passed: true, synthetic_only: true, real_rust_service: true, tested_binary_sha256: binaryHash, tested_binary_version: binaryVersion, source_files: sourceHashes, visible_editor_fields: visibleFields, bare_website_accepted: true, existing_password_preserved: true, replacement_confirmed: true, local_username_suggestions: true, backup_download: true, keyboard_focus_and_escape: true, unsafe_scheme_blocked: true, lock_clears_suggestions: true, encrypted_persistence: true, narrow_viewport: true, mk, human_time_delta_seconds: null, action_frequency_per_day: null };
    console.log('PASS: guided first login, explicit generation, backup, suggestions, keyboard, lock, persistence, narrow viewport and mk observation');
  }
  assert.deepEqual(errors, []);
  for (const [path, expected] of Object.entries(sourceHashes)) assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), expected, 'Source changed during journey: ' + path);
  assert(receipt);
  writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2) + '\n');
  renameSync(receiptPath + '.tmp', receiptPath);
} finally {
  await browser?.close(); await stop(chrome); await stop(server); rmSync(scratch, { recursive: true, force: true });
}
