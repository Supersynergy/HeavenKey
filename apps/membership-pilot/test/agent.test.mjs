import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInvoiceDraft } from '../../../scripts/membership_wallet_agent.mjs';

const machineReference = () => randomBytes(32).toString('base64url');

test('CLI submits only bound references over scoped TLS and returns a minimized receipt', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'heavenkey-invoice-agent-'));
  const delegationId = randomUUID();
  const draftId = randomUUID();
  const machineToken = machineReference();
  const idempotencyKey = machineReference();
  const receipt = { delegation_id: delegationId, draft_id: draftId, status: 'executed' };
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const generate = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt',
    'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=HeavenKey agent test',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', 'test.key', '-out', 'ca.pem'],
  { cwd: directory, stdio: 'ignore' });
  assert.equal(generate.status, 0, 'ephemeral test certificate generation');
  let responseMode = 'receipt';
  let requests = 0;
  const server = createServer({ key: readFileSync(join(directory, 'test.key')),
    cert: readFileSync(join(directory, 'ca.pem')) }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests++;
    const validRequest = req.url === '/agent/invoice-draft' && req.method === 'POST'
      && req.headers.authorization === `Bearer ${machineToken}`
      && req.headers['idempotency-key'] === idempotencyKey
      && Buffer.concat(chunks).toString() === JSON.stringify({ delegation_id: delegationId });
    if (!validRequest) {
      res.writeHead(400);
    } else if (responseMode === 'redirect') {
      res.writeHead(307, { location: '/other-path' });
    } else if (responseMode === 'revoked') {
      res.writeHead(410, { 'Content-Type': 'application/json' });
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseMode === 'unexpected' ? { ...receipt, extra: 'unexpected' } : receipt));
      return;
    }
    res.end();
  });
  t.after(() => new Promise((done) => server.close(done)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `https://127.0.0.1:${server.address().port}`;
  const profileFile = join(directory, 'machine.json');
  writeFileSync(profileFile, JSON.stringify({ origin, machineToken }), { mode: 0o600 });

  assert.deepEqual(await runInvoiceDraft(directory, delegationId, idempotencyKey), receipt);
  responseMode = 'revoked';
  await assert.rejects(runInvoiceDraft(directory, delegationId, idempotencyKey), /widerrufen/);
  responseMode = 'redirect';
  await assert.rejects(runInvoiceDraft(directory, delegationId, idempotencyKey), /Ausgang unklar/);
  assert.equal(requests, 3, 'did not forward machine authentication on redirect');
  responseMode = 'unexpected';
  await assert.rejects(runInvoiceDraft(directory, delegationId, idempotencyKey), /Ausgang unklar/);
  await assert.rejects(runInvoiceDraft(directory, delegationId, `${idempotencyKey}\n`), /Aufruf:/);
  writeFileSync(profileFile, JSON.stringify({ origin: 'https://localhost:9444', machineToken }));
  await assert.rejects(runInvoiceDraft(directory, delegationId, idempotencyKey), /Agentenprofil/);
  assert.equal(requests, 4);
});
