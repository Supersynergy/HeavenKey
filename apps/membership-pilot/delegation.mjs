import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const invoiceOperation = Object.freeze({
  kind: 'invoice.draft.create',
  tenant: 'supersynergy-demo',
  resource: 'order-demo-1',
  amount_minor: 45000,
  currency: 'EUR',
  agent_id: 'invoice-draft-agent',
  uses: 1,
});

const maxLifetimeSeconds = 120;
const safeId = /^[A-Za-z0-9_-]{16,128}$/;
const secretFormat = /^[A-Za-z0-9_-]{43,128}$/;
const digest = (value) => createHash('sha256').update(value).digest();
const clock = () => Math.floor(Date.now() / 1000);

export class DelegationError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function financeOperationMatches(operation, now) {
  return operation && Object.keys(operation).length === Object.keys(invoiceOperation).length + 1
    && Object.entries(invoiceOperation).every(([key, value]) => operation[key] === value)
    && Number.isSafeInteger(operation.expiration)
    && operation.expiration > now && operation.expiration <= now + maxLifetimeSeconds;
}

function receipt(grant, now, includeKey = false) {
  if (grant.draft_id) return { delegation_id: grant.id, status: 'executed', draft_id: grant.draft_id };
  if (grant.revoked_at !== null) return { delegation_id: grant.id, status: 'revoked' };
  if (grant.expires_at <= now) return { delegation_id: grant.id, status: 'expired' };
  const result = { delegation_id: grant.id, status: 'approved' };
  if (includeKey) result.idempotency_key = grant.idempotency_key;
  return result;
}

export function createDelegation(db, { audience, machineToken, isAuthorized, currentTime = clock }) {
  const origin = new URL(audience);
  if (origin.protocol !== 'https:' || origin.origin !== audience || typeof isAuthorized !== 'function' || typeof currentTime !== 'function'
    || typeof machineToken !== 'string' || !secretFormat.test(machineToken)) {
    throw new Error('invalid_delegation_configuration');
  }
  const machineBinding = digest(machineToken);
  db.exec(`
    CREATE TABLE IF NOT EXISTS membership_invoice_grants (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      credential_id INTEGER NOT NULL,
      audience TEXT NOT NULL,
      machine_binding BLOB NOT NULL,
      operation TEXT NOT NULL,
      tenant TEXT NOT NULL,
      resource TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      currency TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      revoked_at INTEGER,
      draft_id TEXT UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS membership_invoice_drafts (
      id TEXT PRIMARY KEY,
      delegation_id TEXT NOT NULL UNIQUE REFERENCES membership_invoice_grants(id),
      tenant TEXT NOT NULL,
      order_ref TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status = 'draft'),
      created_at INTEGER NOT NULL
    ) STRICT;
  `);
  const insertGrant = db.prepare(`INSERT INTO membership_invoice_grants
    (id, request_id, session_id, holder_id, credential_id, audience, machine_binding, operation,
    tenant, resource, amount_minor, currency, agent_id, expires_at, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING`);
  const selectGrant = db.prepare('SELECT * FROM membership_invoice_grants WHERE id = ? AND audience = ?');
  const insertDraft = db.prepare(`INSERT INTO membership_invoice_drafts
    (id, delegation_id, tenant, order_ref, amount_minor, currency, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`);
  const consumeGrant = db.prepare(`UPDATE membership_invoice_grants SET draft_id = ?
    WHERE id = ? AND draft_id IS NULL AND revoked_at IS NULL AND expires_at > ?`);
  const revokeGrant = db.prepare(`UPDATE membership_invoice_grants SET revoked_at = ?
    WHERE id = ? AND draft_id IS NULL AND revoked_at IS NULL AND expires_at > ?`);

  function immediate(run) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  function find(delegationId) {
    if (typeof delegationId !== 'string' || !safeId.test(delegationId)) {
      throw new DelegationError('delegation_not_found', 404);
    }
    const grant = selectGrant.get(delegationId, audience);
    if (!grant) throw new DelegationError('delegation_not_found', 404);
    return grant;
  }

  function ownedGrant(sessionId, delegationId) {
    const grant = find(delegationId);
    if (grant.session_id !== sessionId) throw new DelegationError('delegation_not_found', 404);
    return grant;
  }

  function requireAuthorization(context) {
    if (isAuthorized(context) !== true) throw new DelegationError('delegation_policy_denied', 403);
  }

  return Object.freeze({
    operation(now = clock()) {
      return Object.freeze({ ...invoiceOperation, expiration: now + maxLifetimeSeconds });
    },

    approve({ operation, requestId, sessionId, holderId, credentialId, now = clock() }) {
      if (!db.isTransaction) throw new Error('delegation_approval_requires_verification_transaction');
      if (!financeOperationMatches(operation, now) || !Number.isSafeInteger(credentialId) || credentialId < 0
        || ![requestId, sessionId, holderId].every((id) => typeof id === 'string' && safeId.test(id))) {
        throw new DelegationError('invalid_delegation_binding', 400);
      }
      requireAuthorization({ sessionId, holderId, credentialId, tenant: operation.tenant,
        resource: operation.resource, action: operation.kind, agentId: operation.agent_id, now });
      const id = randomUUID();
      const key = randomBytes(32).toString('base64url');
      const { changes } = insertGrant.run(id, requestId, sessionId, holderId, credentialId, audience,
        machineBinding, operation.kind, operation.tenant, operation.resource, operation.amount_minor,
        operation.currency, operation.agent_id, operation.expiration, key);
      if (changes !== 1) throw new DelegationError('delegation_request_used', 409);
      return receipt(find(id), now, true);
    },

    execute({ authorization, delegationId, idempotencyKey, now: at }) {
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length) : '';
      if (!secretFormat.test(token) || !timingSafeEqual(digest(token), machineBinding)) {
        throw new DelegationError('machine_authentication_required', 401);
      }
      return immediate(() => {
        const now = at ?? currentTime();
        const grant = find(delegationId);
        if (!timingSafeEqual(grant.machine_binding, machineBinding)) {
          throw new DelegationError('delegation_not_found', 404);
        }
        if (typeof idempotencyKey !== 'string' || !secretFormat.test(idempotencyKey)
          || !timingSafeEqual(digest(idempotencyKey), digest(grant.idempotency_key))) {
          throw new DelegationError('idempotency_key_mismatch', 409);
        }
        const before = receipt(grant, now);
        if (before.status === 'executed') return before;
        if (before.status !== 'approved') throw new DelegationError(`delegation_${before.status}`, 410);
        const operation = { kind: grant.operation, tenant: grant.tenant, resource: grant.resource,
          amount_minor: grant.amount_minor, currency: grant.currency, agent_id: grant.agent_id,
          expiration: grant.expires_at, uses: 1 };
        if (!financeOperationMatches(operation, now)) throw new DelegationError('invalid_delegation_binding', 403);
        requireAuthorization({ sessionId: grant.session_id, holderId: grant.holder_id,
          credentialId: grant.credential_id, tenant: operation.tenant, resource: operation.resource,
          action: operation.kind, agentId: operation.agent_id, now });
        const draftId = randomUUID();
        if (consumeGrant.run(draftId, grant.id, now).changes !== 1) {
          throw new DelegationError('delegation_state_changed', 409);
        }
        insertDraft.run(draftId, grant.id, operation.tenant, operation.resource,
          operation.amount_minor, operation.currency, now);
        return { delegation_id: grant.id, status: 'executed', draft_id: draftId };
      });
    },

    get({ sessionId, delegationId, now = clock() }) {
      return receipt(ownedGrant(sessionId, delegationId), now, true);
    },

    revoke({ sessionId, delegationId, now = clock() }) {
      return immediate(() => {
        const grant = ownedGrant(sessionId, delegationId);
        revokeGrant.run(now, grant.id, now);
        return receipt(find(grant.id), now);
      });
    },
  });
}
