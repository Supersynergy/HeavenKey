import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { createDelegation } from '../delegation.mjs';

const audience = 'https://localhost:18475';
const now = 1795356000;

function open(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function policy(db) {
  const permissions = db.prepare(`SELECT active FROM test_membership
    WHERE session_id = ? AND holder_id = ? AND credential_id = ? AND starts <= ? AND expires > ?`);
  return ({ sessionId, holderId, credentialId, tenant, resource, action, agentId, now: at }) =>
    tenant === 'supersynergy-demo' && resource === 'order-demo-1' && action === 'invoice.draft.create'
    && agentId === 'invoice-draft-agent'
    && permissions.get(sessionId, holderId, credentialId, at, at)?.active === 1;
}

function fixture(t, path = ':memory:') {
  const db = open(path);
  t.after(() => db.close());
  const sessionId = randomUUID();
  const holderId = randomUUID();
  const credentialId = 0;
  const requestId = randomUUID();
  const machineToken = randomBytes(32).toString('base64url');
  db.exec(`CREATE TABLE test_membership (session_id TEXT NOT NULL, holder_id TEXT NOT NULL,
    credential_id INTEGER NOT NULL, starts INTEGER NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL)`);
  db.prepare('INSERT INTO test_membership VALUES (?, ?, ?, ?, ?, 1)')
    .run(sessionId, holderId, credentialId, now, now + 600);
  const delegation = createDelegation(db, { audience, machineToken, isAuthorized: policy(db) });

  function approve(overrides = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = delegation.approve({ operation: delegation.operation(now), requestId, sessionId,
        holderId, credentialId, now, ...overrides });
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function agentInput(grant, overrides = {}) {
    return { authorization: `Bearer ${machineToken}`, delegationId: grant.delegation_id,
      idempotencyKey: grant.idempotency_key, now, ...overrides };
  }

  return { db, delegation, sessionId, machineToken, approve, agentInput };
}

function draftCount(db) {
  return db.prepare('SELECT count(*) AS count FROM membership_invoice_drafts').get().count;
}

if (!isMainThread) {
  const db = open(workerData.path);
  try {
    const machineToken = workerData.machineToken;
    const delegation = createDelegation(db, { audience, machineToken, isAuthorized: policy(db) });
    const barrier = new Int32Array(workerData.barrier);
    parentPort.postMessage('ready');
    Atomics.wait(barrier, 0, 0, 10000);
    parentPort.postMessage(delegation.execute(workerData.input));
  } finally {
    db.close();
  }
} else {
  test('approval binds one finance operation and one verified request', (t) => {
    const { db, delegation, approve } = fixture(t);
    const operation = delegation.operation(now);
    assert.throws(() => delegation.approve({ operation }), /approval_requires_verification_transaction/);
    assert.throws(() => approve({ holderId: randomUUID() }), /delegation_policy_denied/);
    assert.throws(() => approve({ credentialId: 2 }), /delegation_policy_denied/);
    for (const mutation of [{ amount_minor: 1 }, { currency: 'USD' }, { tenant: 'different' },
      { kind: 'invoice.send' }, { resource: 'order-demo-2' }, { agent_id: 'different' },
      { uses: 2 }, { expiration: now + 121 }, { expiration: now }, { recipient: 'unexpected' }]) {
      assert.throws(() => approve({ operation: { ...operation, ...mutation } }), /invalid_delegation_binding/);
    }
    const grant = approve();
    assert.equal(grant.status, 'approved');
    assert.throws(() => approve(), /delegation_request_used/);
    assert.equal(draftCount(db), 0);
  });

  test('machine, audience, session and idempotency bindings fail closed', (t) => {
    const { db, delegation, sessionId, machineToken, approve, agentInput } = fixture(t);
    const grant = approve();
    const input = agentInput(grant);
    assert.throws(() => delegation.execute({ ...input, authorization: null }), /machine_authentication_required/);
    assert.throws(() => delegation.execute({ ...input, authorization: `Bearer ${grant.idempotency_key}` }), /machine_authentication_required/);
    assert.throws(() => delegation.execute({ ...input, idempotencyKey: randomBytes(32).toString('base64url') }), /idempotency_key_mismatch/);
    assert.throws(() => delegation.get({ sessionId: randomUUID(), delegationId: grant.delegation_id }), /delegation_not_found/);
    assert.throws(() => delegation.revoke({ sessionId: randomUUID(), delegationId: grant.delegation_id }), /delegation_not_found/);
    const otherOrigin = createDelegation(db, { audience: 'https://othersite.localhost:18475', machineToken, isAuthorized: policy(db) });
    assert.throws(() => otherOrigin.execute(input), /delegation_not_found/);
    const rotatedToken = randomBytes(32).toString('base64url');
    const rotatedAgent = createDelegation(db, { audience, machineToken: rotatedToken, isAuthorized: policy(db) });
    assert.throws(() => rotatedAgent.execute({ ...input, authorization: `Bearer ${rotatedToken}` }), /delegation_not_found/);
    assert.deepEqual(delegation.get({ sessionId, delegationId: grant.delegation_id, now }), grant);
    assert.equal(draftCount(db), 0);
  });

  test('current rights, expiry and owner revocation gate the business action', (t) => {
    const { db, delegation, sessionId, approve, agentInput } = fixture(t);
    const grant = approve();
    const input = agentInput(grant);
    db.exec('UPDATE test_membership SET active = 0');
    assert.throws(() => delegation.execute(input), /delegation_policy_denied/);
    assert.equal(draftCount(db), 0);
    db.exec('UPDATE test_membership SET active = 1');
    assert.throws(() => delegation.execute({ ...input, now: now + 120 }), /delegation_expired/);
    assert.deepEqual(delegation.revoke({ sessionId, delegationId: grant.delegation_id, now }),
      { delegation_id: grant.delegation_id, status: 'revoked' });
    assert.throws(() => delegation.execute({ ...input, now: now + 10 }), /delegation_revoked/);
    assert.equal(draftCount(db), 0);
  });

  test('execute samples the target clock only after acquiring the write transaction', (t) => {
    const { db, approve, agentInput, machineToken } = fixture(t);
    const grant = approve();
    const delegation = createDelegation(db, {
      audience, machineToken, isAuthorized: policy(db),
      currentTime() {
        assert.equal(db.isTransaction, true);
        return now + 120;
      },
    });
    assert.throws(() => delegation.execute({ ...agentInput(grant), now: undefined }), /delegation_expired/);
    assert.equal(draftCount(db), 0);
  });

  test('storage failure rolls back consumption; same request returns one minimized receipt', (t) => {
    const { db, delegation, sessionId, approve, agentInput } = fixture(t);
    const grant = approve();
    const input = agentInput(grant);
    db.exec(`CREATE TRIGGER simulate_unavailable_storage BEFORE INSERT ON membership_invoice_drafts
      BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`);
    assert.throws(() => delegation.execute(input), /storage unavailable/);
    assert.equal(draftCount(db), 0);
    assert.equal(delegation.get({ sessionId, delegationId: grant.delegation_id, now }).status, 'approved');
    db.exec('DROP TRIGGER simulate_unavailable_storage');
    const result = delegation.execute(input);
    assert.deepEqual(Object.keys(result).sort(), ['delegation_id', 'draft_id', 'status']);
    assert.equal(result.status, 'executed');
    assert.deepEqual(delegation.execute({ ...input, now: now + 140 }), result);
    assert.deepEqual(delegation.get({ sessionId, delegationId: grant.delegation_id, now: now + 140 }), result);
    assert.deepEqual(delegation.revoke({ sessionId, delegationId: grant.delegation_id, now: now + 140 }), result);
    assert.equal(draftCount(db), 1);
    const saved = db.prepare('SELECT tenant, order_ref, status, amount_minor, currency FROM membership_invoice_drafts').get();
    assert.deepEqual({ ...saved }, { tenant: 'supersynergy-demo', order_ref: 'order-demo-1',
      status: 'draft', amount_minor: 45000, currency: 'EUR' });
  });

  test('concurrent target invocations and a reopened database reconcile the same draft', { timeout: 15000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'heavenkey-delegation-'));
    const path = join(directory, 'fixture.sqlite');
    const { db, approve, agentInput, machineToken } = fixture(t, path);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const grant = approve();
    const input = agentInput(grant);
    const barrier = new SharedArrayBuffer(4);
    const workers = [1, 2].map(() => new Worker(new URL(import.meta.url), {
      workerData: { path, machineToken, input, barrier },
    }));
    t.after(async () => Promise.all(workers.map((worker) => worker.terminate())));
    for (const [message] of await Promise.all(workers.map((worker) => once(worker, 'message')))) {
      assert.equal(message, 'ready');
    }
    const answers = Promise.all(workers.map((worker) => once(worker, 'message')));
    const gate = new Int32Array(barrier);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const [[first], [second]] = await answers;
    assert.deepEqual(first, second);
    assert.equal(draftCount(db), 1);
    const restarted = open(path);
    t.after(() => restarted.close());
    const newDelegation = createDelegation(restarted, { audience, machineToken, isAuthorized: policy(restarted) });
    assert.deepEqual(newDelegation.execute({ ...input, now: now + 140 }), first);
    assert.equal(draftCount(restarted), 1);
  });
}
