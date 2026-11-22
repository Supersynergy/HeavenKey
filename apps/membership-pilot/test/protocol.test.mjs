import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createMembershipPilot } from '../server.mjs';

const verifierClientId = 'heavenkey-membership-verifier';
const grant = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';
const hash = (data) => createHash('sha256').update(data).digest('base64url');

async function createKeys() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  return { publicKey, privateKey, jwk: await exportJWK(publicKey), privateJwk: await exportJWK(privateKey) };
}

async function setup(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'hk-membership-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem'),
  ], { stdio: 'ignore' });
  const ca = readFileSync(join(tmp, 'cert.pem'));
  const issuer = await createKeys();
  const verifier = await createKeys();
  const machineToken = randomBytes(32).toString('base64url');
  let seconds = Math.floor(Date.now() / 1000);
  const pilot = await createMembershipPilot({
    // Request authority is checked against this fixed value. The listener uses a
    // separate ephemeral socket so tests can run in parallel.
    origin: 'https://127.0.0.1',
    issuerKey: issuer.privateJwk, verifierKey: verifier.privateJwk,
    machineToken, clock: () => seconds, tls: { cert: ca, key: readFileSync(join(tmp, 'key.pem')) },
  });
  t.after(() => pilot.close());
  pilot.server.listen(0, '127.0.0.1');
  await once(pilot.server, 'listening');
  const { port } = pilot.server.address();
  const origin = 'https://127.0.0.1';

  function call(path, { method = 'GET', form, body, headers = {} } = {}) {
    const payload = form ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body);
    return new Promise((done, fail) => {
      const req = request({
        method, host: '127.0.0.1', port, path, ca,
        headers: {
          host: '127.0.0.1', accept: 'application/json',
          ...(payload !== undefined && {
            'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
            'content-length': Buffer.byteLength(payload),
          }),
          ...headers,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          const data = res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text;
          done({ status: res.statusCode, data, headers: res.headers });
        });
        res.on('error', fail);
      });
      req.on('error', fail);
      req.end(payload);
    });
  }

  async function browser() {
    const home = await call('/');
    assert.equal(home.status, 200);
    const cookieHeader = home.headers['set-cookie'][0];
    assert.match(cookieHeader, /Secure; HttpOnly; SameSite=Strict/);
    const cookie = cookieHeader.split(';')[0];
    const csrf = home.data.csrf;
    return {
      cookie,
      get: (path) => call(path, { headers: { cookie } }),
      post: (path, fields = {}) => call(path, { method: 'POST', headers: { cookie, origin }, form: { csrf, ...fields } }),
    };
  }

  async function offerFrom(session) {
    const offerResult = await session.post('/browser/offer');
    assert.equal(offerResult.status, 200);
    const offerUri = new URL(offerResult.data.launch).searchParams.get('credential_offer_uri');
    const offer = await call(new URL(offerUri).pathname);
    assert.equal(offer.status, 200);
    assert.deepEqual(offer.data.credential_configuration_ids, ['membership']);
    return offer.data.grants[grant]['pre-authorized_code'];
  }

  async function exchange(code) {
    return call('/token', { method: 'POST', form: { grant_type: grant, 'pre-authorized_code': code } });
  }

  async function proof(holder, nonce, claims = {}) {
    return new SignJWT({ aud: origin, iat: seconds, nonce, ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: 'openid4vci-proof+jwt', jwk: holder.jwk })
      .sign(holder.privateKey);
  }

  async function issue(session) {
    const holder = await createKeys();
    const code = await offerFrom(session);
    const token = await exchange(code);
    assert.equal(token.status, 200);
    const nonce = await call('/nonce', { method: 'POST' });
    const authorization = 'Bearer ' + token.data.access_token;
    const proofJwt = await proof(holder, nonce.data.c_nonce);
    const result = await call('/credential', {
      method: 'POST', headers: { authorization }, body: {
        credential_configuration_id: 'membership', proofs: { jwt: [proofJwt] },
      },
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return { ...holder, credential: result.data.credentials[0].credential };
  }

  async function authorization(session, kind = 'project') {
    const result = await session.post('/browser/request/' + kind);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const launch = new URL(result.data.launch);
    assert.equal(launch.searchParams.get('client_id'), verifierClientId);
    const requestPath = new URL(launch.searchParams.get('request_uri')).pathname;
    const jar = await call(requestPath);
    assert.equal(jar.status, 200);
    assert.equal(jar.headers['content-type'], 'application/oauth-authz-req+jwt');
    const { payload } = await jwtVerify(jar.data, verifier.publicKey, {
      issuer: verifierClientId, audience: 'https://self-issued.me/v2', algorithms: ['ES256'], currentDate: new Date(seconds * 1000),
    });
    assert.equal(payload.jti, result.data.request_id);
    assert.equal(payload.client_id, verifierClientId);
    assert.equal(payload.response_uri, origin + '/present');
    return payload;
  }

  async function presentation(holder, request, { claims = {}, kb = true, discloseExtra = false, credential = holder.credential } = {}) {
    const [issuerJwt, ...disclosures] = credential.split('~');
    const disclosed = disclosures.filter((encoded) => encoded && (discloseExtra ||
      ['org_id', 'membership'].includes(JSON.parse(Buffer.from(encoded, 'base64url'))[1])));
    const unbound = [issuerJwt, ...disclosed, ''].join('~');
    if (!kb) return unbound;
    const payload = {
      aud: verifierClientId, nonce: request.nonce, iat: seconds, sd_hash: hash(unbound),
      ...(request.transaction_data && {
        transaction_data_hashes_alg: 'sha-256', transaction_data_hashes: request.transaction_data.map(hash),
      }),
      ...claims,
    };
    return unbound + await new SignJWT(payload).setProtectedHeader({ alg: 'ES256', typ: 'kb+jwt' }).sign(holder.privateKey);
  }

  function submit(request, vp) {
    return call('/present', { method: 'POST', form: {
      state: request.state, vp_token: JSON.stringify({ membership: [vp] }),
    } });
  }

  return { call, browser, issue, offerFrom, exchange, proof, authorization, presentation, submit,
    machineToken, issuer, db: pilot.db, tick: (advance) => { seconds += advance; } };
}

test('issuance validates fresh key proof and atomically consumes the offer and nonce', async (t) => {
  const f = await setup(t);
  const owner = await f.browser();
  const code = await f.offerFrom(owner);
  const results = await Promise.all([f.exchange(code), f.exchange(code)]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 400]);
  const token = results.find(({ status }) => status === 200).data.access_token;
  const nonce = (await f.call('/nonce', { method: 'POST' })).data.c_nonce;
  const holder = await createKeys();
  const issue = async (access, proofValue) => f.call('/credential', { method: 'POST',
    headers: { authorization: 'Bearer ' + access },
    body: { credential_configuration_id: 'membership', proofs: { jwt: [await proofValue] } },
  });
  assert.equal((await issue(token, f.proof(holder, nonce, { aud: 'https://wrong.invalid' }))).status, 400);
  assert.equal((await issue(token, f.proof(holder, nonce, { iss: 'unexpected' }))).status, 400);
  assert.equal((await issue(token, f.proof(holder, nonce))).status, 200);
  const newToken = (await f.exchange(await f.offerFrom(owner))).data.access_token;
  assert.equal((await issue(newToken, f.proof(holder, nonce))).data.error, 'invalid_nonce');
  const meta = await f.call('/.well-known/openid-credential-issuer');
  assert.equal(meta.status, 200);
  assert.equal(meta.data.credential_configurations_supported.membership.format, 'dc+sd-jwt');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM credentials').get().n, 1);
});

test('browser forms preserve the same-origin header and reject foreign origins with a valid CSRF token', async (t) => {
  const f = await setup(t);
  const home = await f.call('/', { headers: { accept: 'text/html' } });
  assert.equal(home.headers['referrer-policy'], 'same-origin');
  assert.match(home.headers['content-security-policy'], /form-action 'self'/);
  assert.match(home.data, /<form method="post" action="\/browser\/offer">/);
  const session = await f.call('/');
  const cookie = session.headers['set-cookie'][0].split(';')[0];
  const submit = (origin) => f.call('/browser/offer', {
    method: 'POST', headers: { cookie, origin }, form: { csrf: session.data.csrf },
  });
  assert.equal((await submit('null')).status, 403);
  assert.equal((await submit('https://other.test')).status, 403);
  assert.equal((await submit('https://127.0.0.1')).status, 200);
});

test('selective presentation grants only the initiating project session and rejects replay and wrong holder', async (t) => {
  const f = await setup(t);
  const issuer = await f.browser();
  const relyingParty = await f.browser();
  const holder = await f.issue(issuer);
  const request = await f.authorization(relyingParty);
  const another = await f.authorization(issuer);
  const statusPath = '/browser/status/' + request.jti;
  assert.equal((await relyingParty.get('/project')).status, 403);
  assert.equal((await issuer.get(statusPath)).status, 404);
  assert.equal((await f.submit(another, await f.presentation(holder, request))).status, 400);
  assert.equal((await f.submit(request, await f.presentation(holder, request, { kb: false }))).status, 400);
  assert.equal((await f.submit(request, await f.presentation(holder, request, { claims: { aud: 'another-verifier' } }))).status, 400);
  assert.equal((await f.submit(request, await f.presentation(holder, request, { discloseExtra: true }))).status, 400);
  const impostor = await createKeys();
  assert.equal((await f.submit(request, await f.presentation({ ...holder, privateKey: impostor.privateKey }, request))).status, 400);

  const [issuerJWT, ...disclosures] = holder.credential.split('~');
  const forged = await new SignJWT(decodeJwt(issuerJWT)).setProtectedHeader({ alg: 'ES256', typ: 'dc+sd-jwt' }).sign(impostor.privateKey);
  assert.equal((await f.submit(request, await f.presentation(holder, request, {
    credential: [forged, ...disclosures].join('~'),
  }))).status, 400);
  const unsigned = Buffer.from(JSON.stringify({ alg: 'none', typ: 'dc+sd-jwt' })).toString('base64url') +
    '.' + issuerJWT.split('.')[1] + '.';
  assert.equal((await f.submit(request, await f.presentation(holder, request, {
    credential: [unsigned, ...disclosures].join('~'),
  }))).status, 400);
  const vp = await f.presentation(holder, request);
  const success = await f.submit(request, vp);
  assert.equal(success.status, 200, JSON.stringify(success.data));
  assert.deepEqual(success.data, { receipt_id: request.jti, status: 'verified' });
  assert.equal((await f.submit(request, vp)).status, 409);
  assert.deepEqual((await relyingParty.get('/project')).data, {
    tenant: 'supersynergy-demo', resource: 'project-demo-1', permission: 'project.read',
  });
  assert.equal((await issuer.get('/project')).status, 403);
  assert.equal((await f.call('/receipt/' + request.jti, { method: 'POST', form: { state: another.state } })).status, 404);
  assert.equal((await f.call('/receipt/' + request.jti, { method: 'POST', form: { state: request.state } })).data.status, 'verified');
});

test('reconciliation survives application logout for a bounded period without restoring access', async (t) => {
  const f = await setup(t);
  const browser = await f.browser();
  const holder = await f.issue(browser);
  const verified = await f.authorization(browser);
  const pending = await f.authorization(browser);
  assert.equal((await f.submit(verified, await f.presentation(holder, verified))).status, 200);
  assert.equal((await browser.post('/browser/logout')).status, 200);
  assert.equal((await browser.get('/project')).status, 403);
  const reconcile = (req) => f.call('/receipt/' + req.jti, { method: 'POST', form: { state: req.state } });
  assert.equal((await reconcile(verified)).data.status, 'verified');
  assert.equal((await reconcile(pending)).data.status, 'expired');
  f.tick(1021);
  assert.equal((await reconcile(verified)).status, 404);
});

test('freshness and published status block expired or revoked credentials and current access', async (t) => {
  const f = await setup(t);
  const owner = await f.browser();
  const holder = await f.issue(owner);
  const pending = await f.authorization(owner);
  f.tick(121);
  assert.equal((await f.submit(pending, await f.presentation(holder, pending))).status, 400);
  const request = await f.authorization(owner);
  assert.equal((await f.submit(request, await f.presentation(holder, request))).status, 200);
  assert.equal((await owner.get('/project')).status, 200);
  const next = await f.authorization(owner);
  assert.equal((await owner.post('/browser/revoke-credential')).data.revoked, 1);
  assert.equal((await owner.get('/project')).status, 403);
  assert.equal((await f.submit(next, await f.presentation(holder, next))).status, 400);
  const result = await f.call('/status');
  const { payload } = await jwtVerify(result.data, f.issuer.publicKey, {
    issuer: 'https://127.0.0.1', subject: 'https://127.0.0.1/status', algorithms: ['ES256'],
    currentDate: new Date((Math.floor(Date.now() / 1000) + 121) * 1000),
  });
  const status = inflateSync(Buffer.from(payload.status_list.lst, 'base64url'));
  assert.equal(status[0] & 1, 1);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('typed transaction hash and machine identity gate an idempotent invoice draft', async (t) => {
  const f = await setup(t);
  const owner = await f.browser();
  assert.equal((await owner.post('/browser/request/invoice')).status, 403);
  const holder = await f.issue(owner);
  const project = await f.authorization(owner);
  assert.equal((await f.submit(project, await f.presentation(holder, project))).status, 200);
  const invoice = await f.authorization(owner, 'invoice');
  const transaction = JSON.parse(Buffer.from(invoice.transaction_data[0], 'base64url'));
  assert.equal(transaction.type, 'https://heavenkey.app/transactions/invoice-draft/v1');
  assert.equal(transaction.amount_minor, 45000);
  for (const claims of [
    { transaction_data_hashes_alg: undefined, transaction_data_hashes: undefined },
    { transaction_data_hashes: [hash(invoice.transaction_data[0] + 'changed')] },
  ]) {
    assert.equal((await f.submit(invoice, await f.presentation(holder, invoice, { claims }))).status, 400);
  }
  const approved = await f.submit(invoice, await f.presentation(holder, invoice));
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.deepEqual(approved.data, { receipt_id: invoice.jti, status: 'verified', action_status: 'approved' });
  const status = await owner.get('/browser/status/' + invoice.jti);
  const { delegation_id, idempotency_key } = status.data.delegation;
  const execute = (machineToken, key) => f.call('/agent/invoice-draft', {
    method: 'POST', headers: { authorization: 'Bearer ' + machineToken, 'idempotency-key': key }, body: { delegation_id },
  });
  assert.equal((await execute(randomBytes(32).toString('base64url'), idempotency_key)).status, 401);
  assert.equal((await execute(f.machineToken, randomBytes(32).toString('base64url'))).status, 409);
  const [first, second] = await Promise.all([execute(f.machineToken, idempotency_key), execute(f.machineToken, idempotency_key)]);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data, second.data);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM membership_invoice_drafts').get().n, 1);
  const reconciled = await f.call('/receipt/' + invoice.jti, { method: 'POST', form: { state: invoice.state } });
  assert.deepEqual(reconciled.data, { receipt_id: invoice.jti, status: 'verified', action_status: 'executed' });
});

test('loss of current rights and explicit revocation block action after consent', async (t) => {
  const f = await setup(t);
  const owner = await f.browser();
  const holder = await f.issue(owner);
  const project = await f.authorization(owner);
  assert.equal((await f.submit(project, await f.presentation(holder, project))).status, 200);
  const approve = async () => {
    const invoice = await f.authorization(owner, 'invoice');
    assert.equal((await f.submit(invoice, await f.presentation(holder, invoice))).status, 200);
    const { data } = await owner.get('/browser/status/' + invoice.jti);
    return data.delegation;
  };
  const execute = (delegation) => f.call('/agent/invoice-draft', {
    method: 'POST', body: { delegation_id: delegation.delegation_id },
    headers: { authorization: 'Bearer ' + f.machineToken, 'idempotency-key': delegation.idempotency_key },
  });
  const revoked = await approve();
  const stranger = await f.browser();
  assert.equal((await stranger.post('/browser/revoke-delegation', { delegation_id: revoked.delegation_id })).status, 404);
  assert.equal((await owner.post('/browser/revoke-delegation', { delegation_id: revoked.delegation_id })).data.status, 'revoked');
  assert.equal((await execute(revoked)).status, 410);
  const staleRights = await approve();
  await owner.post('/browser/revoke-credential');
  assert.equal((await execute(staleRights)).status, 403);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM membership_invoice_drafts').get().n, 0);
});
