import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { applications } from './config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = resolve(root, 'docs/evidence/identity/pilot.json');
await mkdir(dirname(evidence), { recursive: true });
await rm(evidence, { force: true }); // A failed run must not retain earlier success.
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
const checks = [];
let observedPage;
try {
  const context = await browser.newContext();
  const page = await context.newPage(); observedPage = page; page.setDefaultTimeout(20_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await page.goto(applications[0].origin);
  await page.getByRole('button', { name: 'HeavenKey neu einrichten', exact: true }).click();
  await page.locator('#username').waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  const username = 'synthetic-' + randomBytes(6).toString('hex');
  await page.locator('#username').fill(username);
  for (const [field, value] of [['firstName', 'Synthetic'], ['lastName', 'Pilot'], ['email', username + '@example.test']]) {
    if (await page.locator('#' + field).count()) await page.locator('#' + field).fill(value);
  }
  await page.locator('input[type=submit], button[type=submit]').first().click();
  // The account receives no tokens before the required passkey registration finishes.
  page.on('dialog', dialog => dialog.accept('Synthetic pilot passkey'));
  const register = page.locator('#registerWebAuthn, #registerWebAuthnButton');
  if (await register.count()) await register.first().click();
  // Keycloak asks for an authenticator label through a browser prompt.
  await page.waitForURL(applications[0].origin + '/', { timeout: 30_000 });
  assert.match(await page.getByTestId('status').innerText(), /Angemeldet/);
  assert.equal((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length, 1);
  checks.push('registration_and_first_login_without_user_password');
  const first = await page.getByTestId('subject').innerText();
  await page.goto(applications[0].origin + '/api/session');
  const firstStatus = JSON.parse(await page.locator('body').innerText());
  assert.equal(firstStatus.identityVerified, false); assert.equal(firstStatus.proofing, 'not-configured');
  checks.push('passkey_login_does_not_assert_verified_identity');

  await page.goto(applications[1].origin);
  await page.getByRole('button', { name: 'Mit HeavenKey anmelden', exact: true }).click();
  await page.waitForURL(applications[1].origin + '/');
  assert.match(await page.getByTestId('status').innerText(), /Angemeldet/);
  const second = await page.getByTestId('subject').innerText();
  assert.notEqual(first, second);
  checks.push('single_sign_on_to_second_application');
  checks.push('different_pairwise_subjects_for_separate_applications');
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.getByRole('button', { name: 'Diese Demo abmelden', exact: true }).click();
  await page.goto(applications[1].origin + '/api/session');
  const loggedOut = JSON.parse(await page.locator('body').innerText());
  assert.equal(loggedOut.authenticated, false);
  checks.push('explicit_local_session_logout');

  // New browser session, same virtual credential: exercise passkey authentication, not its SSO cookie.
  const credentials = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  const fresh = await browser.newContext(); const next = await fresh.newPage(); observedPage = next; next.setDefaultTimeout(20_000);
  const nextCdp = await fresh.newCDPSession(next); await nextCdp.send('WebAuthn.enable');
  const created = await nextCdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  // Synthetic test fixture only. This is not a device migration or hardware-key export feature.
  await nextCdp.send('WebAuthn.addCredential', { authenticatorId: created.authenticatorId, credential: credentials[0] });
  await next.goto(applications[0].origin);
  await next.getByRole('button', { name: 'Mit HeavenKey anmelden', exact: true }).click();
  const authenticate = next.locator('#authenticateWebAuthnButton, #authenticateWebAuthn');
  if (new URL(next.url()).origin !== applications[0].origin) await authenticate.first().click();
  await next.waitForURL(applications[0].origin + '/', { timeout: 30_000 });
  assert.equal(await next.getByTestId('subject').innerText(), first);
  checks.push('fresh_browser_login_with_existing_passkey_without_password');

  const files = ['apps/identity-pilot/config.mjs', 'apps/identity-pilot/server.mjs', 'apps/identity-pilot/e2e.mjs',
    'apps/identity-pilot/package.json', 'apps/identity-pilot/package-lock.json', 'scripts/identity_pilot.py'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
  await writeFile(evidence, JSON.stringify({ schema: 'heavenkey-identity-pilot-evidence-v1', passed: true,
    timestamp: new Date().toISOString(), keycloak: '26.8.1', node: process.version,
    browser: browser.version(), mode: 'local-loopback-synthetic-virtual-ctap2', checks, sourceHashes: hashes,
    hardwareVerified: false, androidProviderVerified: false, bioidIntegrated: false,
    kycApproved: false, realSupersynergyIntegrated: false, productionDeployment: false }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks, evidence: 'docs/evidence/identity/pilot.json' }));
} catch (error) {
  if (observedPage && !observedPage.isClosed()) {
    const url = new URL(observedPage.url());
    console.error(JSON.stringify({ stage: 'browser_observation', origin: url.origin, path: url.pathname,
      text: (await observedPage.locator('body').innerText()).slice(0, 2400) }));
  }
  throw error;
} finally {
  await browser.close();
}
