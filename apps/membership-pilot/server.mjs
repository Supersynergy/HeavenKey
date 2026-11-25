import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { createDelegation, DelegationError } from './delegation.mjs';
import {
  CONFIGURATION, GRANT_TYPE, PROJECT, REQUEST_TTL, STATUS_CAPACITY, TENANT, VCT, VERIFIER,
  digest, makeProtocol, opaque, verifyIssuanceProof,
} from './protocol.mjs';
import { browserPage } from './browser.mjs';

const SESSION_TTL = 900;
const CREDENTIAL_TTL = 3600;
const ACCESS_TTL = 300;
const RECEIPT_TTL = 900;
const PROOF_MAX_AGE_WITH_SKEW = 65;
const BODY_LIMIT = 32_768;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function requireValue(condition, status, code) {
  if (!condition) throw new HttpError(status, code);
}

function response(res, status, body, type) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'content-type': type,
    // Preserve the same-origin form Origin header without sending referrers to external apps.
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function json(res, status, value) {
  response(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

async function read(req, type) {
  requireValue(req.headers['content-type']?.split(';')[0].trim().toLowerCase() === type, 415, 'invalid_content_type');
  requireValue(!(Number(req.headers['content-length']) > BODY_LIMIT), 413, 'request_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    requireValue(size <= BODY_LIMIT, 413, 'request_too_large');
    chunks.push(chunk);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, 'invalid_encoding');
  }
}

function parseObject(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new HttpError(400, 'invalid_json'); }
  requireValue(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'invalid_json');
  return parsed;
}

async function readForm(req) {
  const form = new URLSearchParams(await read(req, 'application/x-www-form-urlencoded'));
  requireValue(form.size === new Set(form.keys()).size, 400, 'duplicate_parameter');
  return Object.fromEntries(form);
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = operation();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function initialize(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      code TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS access_tokens (
      token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS nonces (
      nonce_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS credentials (
      idx INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), holder_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, issued INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), state_hash TEXT NOT NULL UNIQUE,
      nonce TEXT NOT NULL, operation TEXT NOT NULL, request_jwt TEXT NOT NULL,
      expires_at INTEGER NOT NULL, verified_at INTEGER, delegation_id TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS project_access (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id), credential_idx INTEGER NOT NULL REFERENCES credentials(idx),
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS credentials_by_session ON credentials(session_id);
    CREATE INDEX IF NOT EXISTS requests_by_session ON requests(session_id);
  `);
}

export async function createMembershipPilot({
  origin, dbPath = ':memory:', issuerKey, verifierKey, machineToken, tls,
  clock = () => Math.floor(Date.now() / 1000),
}) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin || !SECRET.test(machineToken ?? '')) {
    throw new Error('Expected an exact HTTPS origin and a generated 256-bit machine token');
  }
  const db = new DatabaseSync(dbPath);
  initialize(db);
  const protocol = await makeProtocol({ origin, issuerKey, verifierKey, clock, getStatus(now) {
    const statuses = Buffer.alloc(STATUS_CAPACITY / 8, 255);
    const valid = db.prepare('SELECT idx FROM credentials WHERE issued = 1 AND revoked = 0 AND expires_at > ?').all(now);
    for (const { idx } of valid) statuses[idx >> 3] &= ~(1 << (idx & 7));
    return statuses;
  } });

  function sessionActive(sessionId, now = clock()) {
    return db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(sessionId, now);
  }

  function browserSession(req) {
    const cookie = req.headers.cookie?.split(';').map((value) => value.trim())
      .filter((value) => value.startsWith('__Host-hk-membership='));
    const token = cookie?.length === 1 ? cookie[0].split('=')[1] : undefined;
    return SECRET.test(token ?? '') ? sessionActive(digest(token)) : undefined;
  }

  function projectAccess(sessionId, now) {
    return db.prepare(`
      SELECT c.idx, c.holder_id, a.expires_at FROM project_access a
      JOIN credentials c ON c.idx = a.credential_idx
      JOIN sessions s ON s.id = a.session_id
      WHERE a.session_id = ? AND a.expires_at > ? AND s.expires_at > ?
      AND c.expires_at > ? AND c.issued = 1 AND c.revoked = 0
    `).get(sessionId, now, now, now);
  }

  const delegation = createDelegation(db, {
    audience: origin, machineToken, currentTime: clock, clock,
    isAuthorized({ sessionId, holderId, credentialId, tenant, resource, action, agentId, now }) {
      if (tenant !== TENANT || resource !== 'order-demo-1' || action !== 'invoice.draft.create' ||
          agentId !== 'invoice-draft-agent') return false;
      const access = projectAccess(sessionId, now);
      return access?.holder_id === holderId && access?.idx === credentialId;
    },
  });

  function receipt(row) {
    const now = clock();
    const status = row.verified_at !== null ? 'verified' :
      row.expires_at <= now || !sessionActive(row.session_id, now) ? 'expired' : 'pending';
    const action = row.delegation_id && delegation.get({ sessionId: row.session_id, delegationId: row.delegation_id, now });
    return { receipt_id: row.id, status, ...(action && { action_status: action.status }) };
  }

  async function browserAction(req, res, path, session) {
    requireValue(session, 401, 'browser_session_required');
    requireValue(req.headers.origin === origin, 403, 'wrong_origin');
    const form = await readForm(req);
    requireValue(typeof form.csrf === 'string' && digest(form.csrf) === session.csrf, 403, 'invalid_csrf');
    const now = clock();
    requireValue(sessionActive(session.id, now), 401, 'browser_session_required');
    let result = {};
    if (path === '/browser/offer') {
      const id = randomUUID();
      const code = opaque();
      transaction(db, () => {
        db.prepare('DELETE FROM offers WHERE session_id = ? OR expires_at <= ?').run(session.id, now);
        db.prepare('INSERT INTO offers VALUES (?, ?, ?, ?, ?)').run(id, session.id, code, digest(code), now + REQUEST_TTL);
      });
      result = { launch: 'openid-credential-offer://?' + new URLSearchParams({
        credential_offer_uri: origin + '/offer/' + id,
      }) };
    } else if (path === '/browser/request/project' || path === '/browser/request/invoice') {
      const id = randomUUID();
      const isInvoice = path.endsWith('/invoice');
      requireValue(!isInvoice || projectAccess(session.id, now), 403, 'project_access_required');
      const operation = isInvoice ? delegation.operation(now) : {
        kind: 'project.access', tenant: TENANT, resource: PROJECT,
      };
      const state = opaque();
      const nonce = opaque();
      const expiration = now + REQUEST_TTL;
      const signed = await protocol.authorize({ id, nonce, state, operation, now, expiration });
      transaction(db, () => {
        requireValue(sessionActive(session.id), 401, 'browser_session_required');
        requireValue(!isInvoice || projectAccess(session.id, clock()), 403, 'project_access_required');
        db.prepare('DELETE FROM requests WHERE session_id = ? AND verified_at IS NULL AND expires_at <= ?').run(session.id, now);
        const { count } = db.prepare('SELECT count(*) AS count FROM requests WHERE session_id = ?').get(session.id);
        requireValue(count < 32, 429, 'request_limit');
        db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)')
          .run(id, session.id, digest(state), nonce, JSON.stringify(operation), signed, expiration);
      });
      result = { launch: 'openid4vp://authorize?' + new URLSearchParams({
        client_id: VERIFIER, request_uri: origin + '/request/' + id,
      }), request_id: id };
    } else if (path === '/browser/revoke-credential') {
      const { changes } = db.prepare('UPDATE credentials SET revoked = 1 WHERE session_id = ? AND revoked = 0')
        .run(session.id);
      result = { revoked: changes };
    } else if (path === '/browser/revoke-delegation') {
      result = delegation.revoke({ sessionId: session.id, delegationId: form.delegation_id, now });
    } else if (path === '/browser/logout') {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(now, session.id);
      res.setHeader('set-cookie', '__Host-hk-membership=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
      if (req.headers.accept !== 'application/json') {
        res.writeHead(303, { location: '/' });
        res.end();
        return;
      }
      result = { status: 'logged_out' };
    } else {
      throw new HttpError(404, 'not_found');
    }
    if (req.headers.accept === 'application/json') json(res, 200, result);
    else response(res, 200, browserPage({
      result, csrf: form.csrf, hasAccess: Boolean(projectAccess(session.id, now)),
    }), 'text/html; charset=utf-8');
  }

  async function issue(req, res) {
    const authorization = req.headers.authorization ?? '';
    const accessToken = authorization.startsWith('Bearer ') && authorization.slice(7);
    requireValue(SECRET.test(accessToken) && req.headers.authorization, 401, 'invalid_token');
    const input = parseObject(await read(req, 'application/json'));
    const proofJwt = input.proofs?.jwt;
    requireValue(input.credential_configuration_id === CONFIGURATION &&
      Array.isArray(proofJwt) && proofJwt.length === 1 && typeof proofJwt[0] === 'string', 400, 'invalid_credential_request');
    let proof;
    try { proof = await verifyIssuanceProof(proofJwt[0], origin, clock()); }
    catch { throw new HttpError(400, 'invalid_proof'); }
    const { sessionId, index, expiration, issuedAt } = transaction(db, () => {
      const now = clock();
      requireValue(proof.issuedAt >= now - PROOF_MAX_AGE_WITH_SKEW, 400, 'invalid_proof');
      const access = db.prepare('DELETE FROM access_tokens WHERE token_hash = ? AND expires_at > ? RETURNING session_id')
        .get(digest(accessToken), now);
      requireValue(access && sessionActive(access.session_id, now), 401, 'invalid_token');
      const consumedNonce = db.prepare('DELETE FROM nonces WHERE nonce_hash = ? AND expires_at > ?')
        .run(digest(proof.nonce), now);
      requireValue(consumedNonce.changes === 1, 400, 'invalid_nonce');
      const sessionId = access.session_id;
      const { count } = db.prepare('SELECT count(*) AS count FROM credentials WHERE session_id = ?').get(sessionId);
      requireValue(count < 8, 429, 'credential_limit');
      const expiration = now + CREDENTIAL_TTL;
      const { next: index } = db.prepare('SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM credentials').get();
      requireValue(index < STATUS_CAPACITY, 503, 'status_capacity');
      db.prepare('INSERT INTO credentials (idx, session_id, holder_id, expires_at) VALUES (?, ?, ?, ?)')
        .run(index, sessionId, proof.holderId, expiration);
      return { sessionId, index, expiration, issuedAt: now };
    });
    const credential = await protocol.issue({ ...proof, index, now: issuedAt, expiration });
    requireValue(sessionActive(sessionId), 401, 'browser_session_required');
    const result = db.prepare('UPDATE credentials SET issued = 1 WHERE idx = ? AND revoked = 0').run(index);
    requireValue(result.changes === 1, 400, 'issuance_cancelled');
    json(res, 200, { credentials: [{ credential }] });
  }

  async function present(req, res) {
    const form = await readForm(req);
    requireValue(SECRET.test(form.state ?? '') && typeof form.vp_token === 'string', 400, 'invalid_request');
    const row = db.prepare('SELECT * FROM requests WHERE state_hash = ?').get(digest(form.state));
    const checkedAt = clock();
    requireValue(row && row.expires_at > checkedAt && sessionActive(row.session_id, checkedAt), 400, 'invalid_request');
    requireValue(row.verified_at === null, 409, 'request_consumed');
    const token = parseObject(form.vp_token);
    const presentations = token.membership;
    requireValue(Object.keys(token).length === 1 && Array.isArray(presentations) &&
      presentations.length === 1 && typeof presentations[0] === 'string', 400, 'invalid_presentation');
    const operation = JSON.parse(row.operation);
    let verified;
    try { verified = await protocol.verify(presentations[0], { nonce: row.nonce, now: checkedAt, operation }); }
    catch { throw new HttpError(400, 'invalid_presentation'); }
    const completed = transaction(db, () => {
      const now = clock();
      requireValue(verified.proofIssuedAt >= now - PROOF_MAX_AGE_WITH_SKEW, 400, 'invalid_presentation');
      const consumed = db.prepare('UPDATE requests SET verified_at = ? WHERE id = ? AND verified_at IS NULL AND expires_at > ?')
        .run(now, row.id, now);
      requireValue(consumed.changes === 1, 409, 'request_consumed');
      const credential = db.prepare(`
        SELECT expires_at FROM credentials WHERE idx = ? AND holder_id = ?
        AND issued = 1 AND revoked = 0 AND expires_at > ?
      `).get(verified.credentialId, verified.holderId, now);
      requireValue(credential && sessionActive(row.session_id, now), 403, 'credential_not_authorized');
      if (operation.kind === 'project.access') {
        requireValue(operation.tenant === TENANT && operation.resource === PROJECT, 403, 'invalid_resource');
        db.prepare(`
          INSERT INTO project_access VALUES (?, ?, ?) ON CONFLICT(session_id)
          DO UPDATE SET credential_idx = excluded.credential_idx, expires_at = excluded.expires_at
        `).run(row.session_id, verified.credentialId, Math.min(credential.expires_at, now + ACCESS_TTL));
        return { ...row, verified_at: now };
      }
      const { delegation_id } = delegation.approve({
        ...verified, operation, requestId: row.id, sessionId: row.session_id, now,
      });
      db.prepare('UPDATE requests SET delegation_id = ? WHERE id = ?').run(delegation_id, row.id);
      return { ...row, verified_at: now, delegation_id };
    });
    json(res, 200, receipt(completed));
  }

  async function dispatch(req, res) {
    const now = clock();
    requireValue(req.headers.host === base.host && req.url?.startsWith('/') &&
      !req.url.startsWith('//') && !req.url.includes('\\'), 400, 'invalid_target');
    const url = new URL(req.url, origin);
    const path = url.pathname;
    requireValue(!url.search && !url.hash && path === req.url, 400, 'invalid_target');
    const get = req.method === 'GET';
    const post = req.method === 'POST';
    if (get && path === '/.well-known/openid-credential-issuer') {
      json(res, 200, {
        credential_issuer: origin, authorization_servers: [origin], credential_endpoint: origin + '/credential',
        nonce_endpoint: origin + '/nonce', display: [{ name: 'Supersynergy Testaussteller', locale: 'de' }],
        credential_configurations_supported: { [CONFIGURATION]: {
          format: 'dc+sd-jwt', vct: VCT, cryptographic_binding_methods_supported: ['jwk'],
          credential_signing_alg_values_supported: ['ES256'],
          proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES256'] } },
        } },
      });
    } else if (get && path === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: origin, token_endpoint: origin + '/token', response_types_supported: [],
        grant_types_supported: [GRANT_TYPE], token_endpoint_auth_methods_supported: ['none'],
        'pre-authorized_grant_anonymous_access_supported': true,
      });
    } else if (get && path === '/.well-known/jwt-vc-issuer') {
      json(res, 200, { issuer: origin, jwks: { keys: [protocol.issuerJwk] } });
    } else if (get && path === '/status') {
      response(res, 200, await protocol.statusJwt(), 'application/statuslist+jwt');
    } else if (get && new RegExp('^/offer/' + UUID + '$').test(path)) {
      const offer = db.prepare('SELECT * FROM offers WHERE id = ? AND expires_at > ?').get(path.split('/').at(-1), now);
      requireValue(offer && sessionActive(offer.session_id, now), 404, 'offer_unavailable');
      json(res, 200, {
        credential_issuer: origin, credential_configuration_ids: [CONFIGURATION],
        grants: { [GRANT_TYPE]: { 'pre-authorized_code': offer.code } },
      });
    } else if (post && path === '/token') {
      const form = await readForm(req);
      requireValue(form.grant_type === GRANT_TYPE && SECRET.test(form['pre-authorized_code'] ?? ''), 400, 'invalid_grant');
      const token = opaque();
      transaction(db, () => {
        const current = clock();
        const grant = db.prepare('DELETE FROM offers WHERE code_hash = ? AND expires_at > ? RETURNING session_id')
          .get(digest(form['pre-authorized_code']), current);
        requireValue(grant && sessionActive(grant.session_id, current), 400, 'invalid_grant');
        db.prepare('DELETE FROM access_tokens WHERE expires_at <= ?').run(current);
        db.prepare('INSERT INTO access_tokens VALUES (?, ?, ?)').run(digest(token), grant.session_id, current + 90);
      });
      json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 90 });
    } else if (post && path === '/nonce') {
      requireValue(!req.headers['transfer-encoding'] && Number(req.headers['content-length'] ?? 0) === 0,
        400, 'invalid_request');
      const nonce = opaque();
      transaction(db, () => {
        db.prepare('DELETE FROM nonces WHERE expires_at <= ?').run(now);
        const { count } = db.prepare('SELECT count(*) AS count FROM nonces').get();
        requireValue(count < 512, 429, 'nonce_limit');
        db.prepare('INSERT INTO nonces VALUES (?, ?)').run(digest(nonce), now + 60);
      });
      json(res, 200, { c_nonce: nonce });
    } else if (post && path === '/credential') {
      await issue(req, res);
    } else if (get && new RegExp('^/request/' + UUID + '$').test(path)) {
      const row = db.prepare('SELECT * FROM requests WHERE id = ? AND expires_at > ? AND verified_at IS NULL')
        .get(path.split('/').at(-1), now);
      requireValue(row && sessionActive(row.session_id, now), 404, 'request_unavailable');
      response(res, 200, row.request_jwt, 'application/oauth-authz-req+jwt');
    } else if (post && path === '/present') {
      await present(req, res);
    } else if (post && new RegExp('^/receipt/' + UUID + '$').test(path)) {
      const form = await readForm(req);
      requireValue(SECRET.test(form.state ?? ''), 400, 'invalid_request');
      const row = db.prepare('SELECT * FROM requests WHERE id = ? AND state_hash = ? AND expires_at > ?')
        .get(path.split('/').at(-1), digest(form.state), clock() - RECEIPT_TTL);
      requireValue(row, 404, 'request_unavailable');
      json(res, 200, receipt(row));
    } else if (post && path === '/agent/invoice-draft') {
      const input = parseObject(await read(req, 'application/json'));
      requireValue(Object.keys(input).length === 1 && typeof input.delegation_id === 'string', 400, 'invalid_request');
      json(res, 200, delegation.execute({
        authorization: req.headers.authorization, delegationId: input.delegation_id,
        idempotencyKey: req.headers['idempotency-key'],
      }));
    } else if (get && path === '/') {
      const token = opaque();
      const csrf = opaque();
      let session = browserSession(req);
      if (!session) {
        const id = digest(token);
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(id, digest(csrf), now + SESSION_TTL);
        res.setHeader('set-cookie', '__Host-hk-membership=' + token + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_TTL);
        session = { id };
      } else {
        db.prepare('UPDATE sessions SET csrf = ? WHERE id = ?').run(digest(csrf), session.id);
      }
      if (req.headers.accept === 'application/json') json(res, 200, { csrf, project_access: Boolean(projectAccess(session.id, now)) });
      else response(res, 200, browserPage({ csrf, hasAccess: Boolean(projectAccess(session.id, now)) }), 'text/html; charset=utf-8');
    } else if (get && path === '/project') {
      const session = browserSession(req);
      requireValue(session && projectAccess(session.id, now), 403, 'project_access_required');
      if (req.headers.accept === 'application/json') json(res, 200, { tenant: TENANT, resource: PROJECT, permission: 'project.read' });
      else response(res, 200, browserPage({ showProject: true }), 'text/html; charset=utf-8');
    } else if (get && new RegExp('^/browser/status/' + UUID + '$').test(path)) {
      const session = browserSession(req);
      requireValue(session, 401, 'browser_session_required');
      const row = db.prepare('SELECT * FROM requests WHERE id = ? AND session_id = ?')
        .get(path.split('/').at(-1), session.id);
      requireValue(row, 404, 'request_unavailable');
      const result = { ...receipt(row), project_access: Boolean(projectAccess(session.id, now)) };
      if (row.delegation_id) result.delegation = delegation.get({ sessionId: session.id, delegationId: row.delegation_id, now });
      if (req.headers.accept === 'application/json') json(res, 200, result);
      else {
        const csrf = opaque();
        db.prepare('UPDATE sessions SET csrf = ? WHERE id = ?').run(digest(csrf), session.id);
        response(res, 200, browserPage({ result, csrf, hasAccess: result.project_access }), 'text/html; charset=utf-8');
      }
    } else if (post && path.startsWith('/browser/')) {
      await browserAction(req, res, path, browserSession(req));
    } else {
      throw new HttpError(404, 'not_found');
    }
  }

  const server = createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192,
    requestTimeout: 15_000, headersTimeout: 10_000,
  }, (req, res) => {
    dispatch(req, res).catch((error) => {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError || error instanceof DelegationError) json(res, error.status, { error: error.code });
      else json(res, 500, { error: 'pilot_error' });
    });
  });
  server.maxConnections = 64;
  return {
    server, db,
    async close() {
      if (server.listening) await new Promise((done) => server.close(done));
      db.close();
    },
  };
}
