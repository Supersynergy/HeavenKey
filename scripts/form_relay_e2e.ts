/** Real Rust vault relay integration: scoped form-relay agent enrollment and value-free scan/job exchange. No mocks. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const temporary = await mkdtemp(join(tmpdir(), 'heavenkey-relay-'));
const binary = resolve(process.env.HEAVENKEY_BINARY || 'target/debug/uac-api');
const port = 18261, origin = `http://localhost:${port}`;
const cases: string[] = [];
const check = (name: string, truth = true) => { assert(truth, name); cases.push(name); console.log(`PASS ${name}`); };

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(UAC_|HEAVENKEY_)/.test(key)));
const server = spawn(binary, ['--password-manager', '--port', String(port), '--data-dir', join(temporary, 'data')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', (b) => output += b); server.stderr.on('data', (b) => output += b);

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; value: any }> {
  const response = await fetch(origin + path, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, value: await response.json().catch(() => null) };
}
const extOrigin = `chrome-extension://${'a'.repeat(32)}`;
const otherExtOrigin = `chrome-extension://${'b'.repeat(32)}`;
const extHeaders = (token: string, ext = extOrigin) => ({ Origin: ext, 'X-HeavenKey-Client': 'password-extension', 'X-HeavenKey-Token': token });
const agentHeaders = (token: string) => ({ 'X-HeavenKey-Client': 'form-relay-agent', 'X-HeavenKey-Token': token });

try {
  const until = Date.now() + 15000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`Rust server exited: ${output}`);
    try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
    if (Date.now() >= until) throw new Error('Rust server startup timed out');
    await Bun.sleep(100);
  }

  const config = await (await fetch(origin + '/api/password-vault/config', { headers: { Origin: origin, 'X-HeavenKey-Client': 'password-manager' } })).json();
  if (!config?.token) throw new Error(`owner config denied: ${JSON.stringify(config)}`);
  const owner = { Origin: origin, 'X-HeavenKey-Client': 'password-manager', 'X-HeavenKey-Token': config.token };

  const scan = {
    version: 1, kind: 'heavenkey-blind-form-scan', scan: crypto.randomUUID(),
    origin: 'https://antrag.example.invalid', href: 'https://antrag.example.invalid/formular',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    availableEntities: ['firstName', 'lastName', 'email', 'custom_verein'],
    fields: [{ id: 'f1', field: 'Vorname', kind: 'text', entity: 'firstName', sensitive: false, secret: false, hasValue: false }],
  };
  const job = {
    version: 1, kind: 'heavenkey-blind-form-job', scan: scan.scan, origin: scan.origin, href: scan.href,
    fields: [{ id: 'f1', entity: 'firstName' }],
    options: { sensitive: false, secrets: false, overwrite: false, choices: true, submit: false },
  };

  // One pending pairing at a time: enroll the extension first, then the relay agent.
  const pairingA = await post('/api/password-vault/extension/pairing', {}, owner);
  check('owner creates a one-use pairing code', pairingA.status === 200 && typeof pairingA.value.code === 'string');
  const connected = await post('/api/password-vault/extension/connect', { code: pairingA.value.code }, { Origin: extOrigin, 'X-HeavenKey-Client': 'password-extension' });
  check('extension pairing still works alongside', connected.status === 200 && connected.value.token?.length === 43);

  const pairingB = await post('/api/password-vault/extension/pairing', {}, owner);
  const denied = await post('/api/password-vault/form-relay/connect', { code: pairingB.value.code }, { 'X-HeavenKey-Client': 'password-extension' });
  check('relay connect rejects the extension client header', denied.status === 403);

  const enrolled = await post('/api/password-vault/form-relay/connect', { code: pairingB.value.code }, { 'X-HeavenKey-Client': 'form-relay-agent' });
  if (enrolled.status !== 200) console.error('enroll-debug', enrolled.status, JSON.stringify(enrolled.value));
  check('relay agent enrolls with the one-use code', enrolled.status === 200 && enrolled.value.token?.length === 43 && enrolled.value.agent?.length === 43);
  const replayed = await post('/api/password-vault/form-relay/connect', { code: pairingB.value.code }, { 'X-HeavenKey-Client': 'form-relay-agent' });
  check('pairing code is single-use for agents', replayed.status === 403);
  const extToken = connected.value.token, agentToken = enrolled.value.token;

  const unauthenticated = await post('/api/password-vault/form-relay/scan/latest', {}, {});
  check('agent endpoints reject missing credentials', unauthenticated.status === 403);
  const wrongScope = await post('/api/password-vault/form-relay/scan/latest', {}, extHeaders(extToken));
  check('extension tokens are not valid on agent endpoints', wrongScope.status === 403);
  const agentOnVault = await post('/api/password-vault/read', {}, { 'X-HeavenKey-Client': 'form-relay-agent', 'X-HeavenKey-Token': agentToken });
  check('agent tokens never read the vault', agentOnVault.status === 403);

  const empty = await post('/api/password-vault/form-relay/scan/latest', {}, agentHeaders(agentToken));
  check('latest scan is null before any publish', empty.status === 200 && empty.value.scan === null);

  const wrongKind = await post('/api/password-vault/extension/blind-scan', { scan: { ...scan, kind: 'other' } }, extHeaders(extToken));
  check('scan publish rejects foreign kinds', wrongKind.status === 422);
  const published = await post('/api/password-vault/extension/blind-scan', { scan }, extHeaders(extToken));
  check('extension publishes the value-free scan', published.status === 200 && published.value.scan_id === scan.scan);

  const latest = await post('/api/password-vault/form-relay/scan/latest', {}, agentHeaders(agentToken));
  check('agent receives scan metadata through the relay', latest.status === 200 && latest.value.scan?.scan === scan.scan && latest.value.scan.fields[0].id === 'f1');
  check('scan metadata carries no profile values', JSON.stringify(latest.value.scan).includes('Alex') === false);

  const badJob = await post('/api/password-vault/form-relay/job', { scan_id: scan.scan, job: { ...job, scan: 'different' } }, agentHeaders(agentToken));
  check('job must bind to the relayed scan id', badJob.status === 422);
  const missing = crypto.randomUUID();
  const unknownScan = await post('/api/password-vault/form-relay/job', { scan_id: missing, job: { ...job, scan: missing } }, agentHeaders(agentToken));
  check('job for unknown scan is rejected', unknownScan.status === 404);

  const submitted = await post('/api/password-vault/form-relay/job', { scan_id: scan.scan, job }, agentHeaders(agentToken));
  check('agent submits the value-free job', submitted.status === 200 && submitted.value.accepted === true);

  const crossOrigin = await post('/api/password-vault/extension/blind-job/poll', { scan_id: scan.scan }, extHeaders('x'.repeat(43), otherExtOrigin));
  check('other extensions cannot poll the scan', crossOrigin.status === 403);
  const polled = await post('/api/password-vault/extension/blind-job/poll', { scan_id: scan.scan }, extHeaders(extToken));
  check('publishing extension picks up the job', polled.status === 200 && typeof polled.value.job === 'string' && JSON.parse(polled.value.job).scan === scan.scan);
  const again = await post('/api/password-vault/extension/blind-job/poll', { scan_id: scan.scan }, extHeaders(extToken));
  check('job remains available until scan expiry for popup reopening', again.status === 200 && typeof again.value.job === 'string');

  // Restart persistence: agent enrollment survives, scans are memory-only.
  server.kill('SIGINT');
  await new Promise(resolve => server.once('exit', resolve));
  const restart = spawn(binary, ['--password-manager', '--port', String(port), '--data-dir', join(temporary, 'data')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (restart.exitCode !== null) throw new Error('restart failed');
    try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
    if (Date.now() >= deadline) throw new Error('restart timed out');
    await Bun.sleep(100);
  }
  const afterRestart = await post('/api/password-vault/form-relay/scan/latest', {}, agentHeaders(agentToken));
  check('agent enrollment survives process restart', afterRestart.status === 200);
  check('relayed scans are memory-only across restart', afterRestart.value.scan === null);
  restart.kill('SIGINT');
  await new Promise(resolve => restart.once('exit', resolve));

  const revokeServer = spawn(binary, ['--password-manager', '--port', String(port), '--data-dir', join(temporary, 'data')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const untilUp = Date.now() + 15000;
  for (;;) {
    if (revokeServer.exitCode !== null) throw new Error('revoke-test server failed');
    try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
    if (Date.now() >= untilUp) throw new Error('revoke-test server timed out');
    await Bun.sleep(100);
  }
  const config2 = await (await fetch(origin + '/api/password-vault/config', { headers: { Origin: origin, 'X-HeavenKey-Client': 'password-manager' } })).json();
  const owner2 = { Origin: origin, 'X-HeavenKey-Client': 'password-manager', 'X-HeavenKey-Token': config2.token };
  const revoked = await fetch(origin + '/api/password-vault/extension/pairing', { method: 'DELETE', headers: owner2 });
  check('owner revocation succeeds', revoked.ok);
  const afterRevoke = await post('/api/password-vault/form-relay/scan/latest', {}, agentHeaders(agentToken));
  check('revocation also retires relay agents', afterRevoke.status === 403);
  revokeServer.kill('SIGINT');
  await new Promise(resolve => revokeServer.once('exit', resolve));

  console.log(JSON.stringify({ pass: true, cases: cases.length, mocks: false, real_rust_process: true, synthetic_only: true }));
} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  await rm(temporary, { recursive: true, force: true });
}
