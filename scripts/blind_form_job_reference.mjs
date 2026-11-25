import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'heavenkey-blind-job-'));
try {
  const scan = {
    version: 1,
    kind: 'heavenkey-blind-form-scan',
    scan: '44444444-4444-4444-8444-444444444444',
    origin: 'https://antrag.example',
    href: 'https://antrag.example/antrag',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:02:00.000Z',
    availableEntities: ['firstName'],
    fields: [{
      id: '11111111-1111-4111-8111-111111111111', field: 'Vorname', entity: 'firstName', score: 100,
      hasValue: false, sensitive: false, secret: false, kind: 'text', form: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      formMethod: 'post', formDestinations: ['https://antrag.example'],
    }],
  };
  const scanPath = join(dir, 'scan.json'), jobPath = join(dir, 'job.json');
  await writeFile(scanPath, JSON.stringify(scan));
  const run = spawnSync('bun', ['scripts/blind_form_job.ts', '--submit', scanPath], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  await writeFile(jobPath, run.stdout);
  const job = JSON.parse(run.stdout);
  assert.equal(job.kind, 'heavenkey-blind-form-job');
  assert.equal(job.options.submit, true);
  assert.equal(job.fields.length, 1);
  assert(!run.stdout.includes('Alex') && !run.stdout.includes('DE89370400440532013000'));
  console.log('blind form job reference: PASS');
} finally {
  await rm(dir, { recursive: true, force: true });
}
