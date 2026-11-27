#!/usr/bin/env bun
/** Blind form relay agent: enroll once with a one-use pairing code, then exchange value-free
 *  scan metadata and form jobs with the local HeavenKey service. Values never pass through
 *  this client; filling still requires the owner's confirmation in the browser extension. */
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { planBlindJob } from '../packages/forms/blind-job';

const args = process.argv.slice(2);
const usage = `Usage:
  bun scripts/blind_form_agent.ts enroll <pairing-code> [--origin URL] [--store PATH]
  bun scripts/blind_form_agent.ts scan [--origin URL] [--store PATH] [--wait SECONDS]
  bun scripts/blind_form_agent.ts job [--submit] [--overwrite] [--no-choices] [--map FIELD=ENTITY] [--scan scan.json] [--origin URL] [--store PATH]
  bun scripts/blind_form_agent.ts auto [job options] [--origin URL] [--store PATH]

The scan export contains field metadata only, never profile values. Every fill
requires the owner's explicit confirmation in the HeavenKey browser extension.`;
if (args.includes('--help') || !args.length) { console.log(usage); process.exit(args.length ? 0 : 1); }

function flag(name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  return args.splice(index, 2)[1] ?? null;
}
function toggle(name: string): boolean {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}
const originFlag = flag('origin'), storeFlag = flag('store'), waitFlag = flag('wait'), scanFlag = flag('scan');
const storePath = storeFlag || `${process.env.HOME}/.config/heavenkey/form-relay.json`;

function checkedOrigin(value: string | null): string {
  const fallback = 'http://localhost:18240';
  if (!value) return fallback;
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.hostname === 'localhost'))) throw new Error('Use a configured HTTPS origin or localhost.');
  return parsed.origin;
}

type Stored = { origin: string; token: string; agent: string };
async function stored(): Promise<Stored> {
  let value: Stored;
  try { value = JSON.parse(await readFile(storePath, 'utf8')); } catch { throw new Error(`No enrolled agent at ${storePath}. Run enroll with a fresh pairing code first.`); }
  if (!value?.origin || typeof value.token !== 'string' || value.token.length !== 43) throw new Error('Stored agent enrollment is invalid. Enroll again.');
  return value;
}

async function post(path: string, body: unknown, auth: Stored | null): Promise<any> {
  const origin = checkedOrigin(auth?.origin ?? originFlag);
  const response = await fetch(origin + path, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', 'X-HeavenKey-Client': 'form-relay-agent', ...(auth ? { 'X-HeavenKey-Token': auth.token } : {}) },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error === 'extension_pairing_denied' ? 'Pairing code invalid or expired. Create a fresh code in HeavenKey.' : `Relay denied the request (${response.status} ${value.error || response.statusText}).`);
  return value;
}

const command = args[0];
if (command === 'enroll') {
  const code = args[1];
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(code || '')) throw new Error('Enroll needs the one-use pairing code from the HeavenKey app.');
  const result = await post('/api/password-vault/form-relay/connect', { code }, null);
  if (typeof result?.token !== 'string' || result.token.length !== 43 || typeof result?.agent !== 'string') throw new Error('Invalid enrollment response.');
  const record: Stored = { origin: checkedOrigin(originFlag), token: result.token, agent: result.agent };
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  await writeFile(storePath, JSON.stringify(record), { mode: 0o600 });
  await chmod(storePath, 0o600);
  console.log(JSON.stringify({ enrolled: true, agent: record.agent, origin: record.origin, store: storePath }));
  process.exit(0);
}

function parseJobOptions() {
  const submit = toggle('submit'), overwrite = toggle('overwrite'), choices = !toggle('no-choices');
  const mapping: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--map' || arg.startsWith('--map=')) {
      const pair = arg === '--map' ? args[index + 1] || '' : arg.slice(6), split = pair.indexOf('=');
      if (split < 1) throw new Error('--map needs FIELD_ID=ENTITY');
      mapping[pair.slice(0, split)] = pair.slice(split + 1);
      args.splice(index, arg === '--map' ? 2 : 1);
      index--;
    }
  }
  return { submit, overwrite, choices, mapping };
}

async function latestScan(auth: Stored, waitSeconds: number): Promise<any> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const result = await post('/api/password-vault/form-relay/scan/latest', {}, auth);
    if (result?.scan?.kind === 'heavenkey-blind-form-scan') {
      if (Date.parse(result.scan.expiresAt) <= Date.now()) throw new Error('The relayed scan has expired. Ask the owner to scan the page again.');
      return result.scan;
    }
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

if (!['scan', 'job', 'auto'].includes(command)) throw new Error(usage);
const auth = await stored();
const waitSeconds = waitFlag ? Number(waitFlag) : command === 'scan' ? 0 : 30;
if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) throw new Error('--wait must be 0..600 seconds.');

if (command === 'scan') {
  const scan = await latestScan(auth, waitSeconds);
  if (!scan) { console.error('No scan is waiting. The owner scans the page in the HeavenKey extension first.'); process.exit(2); }
  process.stdout.write(JSON.stringify(scan, null, 2) + '\n');
  process.exit(0);
}

const scan = scanFlag ? JSON.parse(await readFile(scanFlag, 'utf8')) : await latestScan(auth, waitSeconds);
if (!scan) { console.error('No scan is waiting. The owner scans the page in the HeavenKey extension first.'); process.exit(2); }
const options = parseJobOptions();
const job = planBlindJob(scan, options);
const posted = await post('/api/password-vault/form-relay/job', { scan_id: scan.scan, job }, auth);
console.log(JSON.stringify({ ...posted, fields: job.fields.length, submit: job.options.submit, note: 'The owner reviews and confirms the preselected mapping in the browser extension.' }));
