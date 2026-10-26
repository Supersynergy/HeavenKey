import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createPilotApp } from '../server.mjs';
import { localUrl, validateMetadata } from '../config.mjs';

const secret = randomBytes(48).toString('base64url');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const cookie = response => response.headers.get('set-cookie')?.split(';')[0];

async function fixture(t, variant = 'valid') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
  let provider, authorize, exchanges = 0;
  const idp = createServer(async (req, res) => {
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (req.url === '/.well-known/openid-configuration') {
      json({ issuer: provider, authorization_endpoint: provider + '/authorize', token_endpoint: provider + '/token',
        jwks_uri: provider + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'] }); return;
    }
    if (req.url === '/jwks') { json({ keys: [jwk] }); return; }
    if (req.url === '/token') {
      exchanges++;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      assert.equal(form.get('client_secret'), secret);
      assert.equal(form.get('code'), 'synthetic-code');
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'));
      const signed = await new SignJWT({ nonce: variant === 'wrong-nonce' ? 'another-transaction' : authorize.searchParams.get('nonce') })
        .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
        .setIssuer(variant === 'wrong-issuer' ? 'https://foreign.example' : provider)
        .setAudience(variant === 'wrong-audience' ? 'another-client' : 'demo')
        .setSubject('synthetic-user').setIssuedAt().setExpirationTime(variant === 'expired-token' ? '1 second ago' : '2 minutes').sign(privateKey);
      const parts = signed.split('.');
      if (variant === 'bad-signature') parts[2] = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1);
      json({ access_token: 'never-return-this-access-token', token_type: 'Bearer', expires_in: 120, id_token: parts.join('.') }); return;
    }
    res.writeHead(404); res.end();
  });
  provider = `http://localhost:${await listen(idp)}`;
  t.after(() => close(idp));
  // Allocate a free app port before discovery; no public listener is used.
  const reserve = createServer(); const appPort = await listen(reserve); await close(reserve);
  const origin = `http://localhost:${appPort}`;
  let clock = Date.now();
  const app = await createPilotApp({ app: { id: 'demo', name: 'Test-Demo', origin }, clientSecret: secret,
    provider, now: () => clock });
  await new Promise(resolve => app.listen(appPort, '127.0.0.1', resolve)); t.after(() => close(app));
  const call = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  const landing = await call('/'); let browserCookie = cookie(landing);
  const html = await landing.text(); const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const begin = async (headers = {}) => {
    const response = await call('/login', { method: 'POST', headers: { Cookie: browserCookie, Origin: origin,
      'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ csrf }) });
    if (response.status === 303) authorize = new URL(response.headers.get('location'));
    return response;
  };
  const callbackPath = () => '/callback?code=synthetic-code&state=' + authorize.searchParams.get('state') + '&iss=' + encodeURIComponent(provider);
  return { call, begin, callbackPath, get cookie() { return browserCookie; },
    set cookie(value) { browserCookie = value; }, get exchanges() { return exchanges; },
    advance: seconds => { clock += seconds * 1000; }, origin };
}

test('public, credential-bearing and unapproved local provider addresses are refused', () => {
  for (const url of ['https://example.org:443', 'http://127.0.0.1:8000', 'http://localhost.evil:8000', 'http://user:secret@localhost:8000']) {
    assert.throws(() => localUrl(url));
  }
  assert.throws(() => validateMetadata({ issuer: 'http://localhost:8000', authorization_endpoint: 'http://localhost:8000/auth',
    token_endpoint: 'http://portal.localhost:8000/token', jwks_uri: 'http://localhost:8000/jwks' }, 'http://localhost:8000'));
});

test('a valid signed code flow rotates the session, verifies PKCE and exposes no tokens or KYC assertion', async t => {
  const f = await fixture(t); const originalCookie = f.cookie;
  assert.equal((await f.begin()).status, 303);
  const complete = await f.call(f.callbackPath(), { headers: { Cookie: f.cookie } });
  assert.equal(complete.status, 303); f.cookie = cookie(complete); assert.notEqual(f.cookie, originalCookie);
  const status = await f.call('/api/session', { headers: { Cookie: f.cookie } });
  assert.deepEqual(await status.json(), { authenticated: true, application: 'demo', subject: 'synthetic-user', identityVerified: false, proofing: 'not-configured' });
  assert.equal((await (await f.call('/api/session', { headers: { Cookie: originalCookie } })).json()).authenticated, false);
  assert.equal((await f.call(f.callbackPath(), { headers: { Cookie: f.cookie } })).status, 400);
  assert.equal(f.exchanges, 1);
  f.advance(301);
  assert.equal((await (await f.call('/api/session', { headers: { Cookie: f.cookie } })).json()).authenticated, false);
});

for (const variant of ['wrong-nonce', 'wrong-issuer', 'wrong-audience', 'expired-token', 'bad-signature']) {
  test(`OIDC callback rejects ${variant}`, async t => {
    const f = await fixture(t, variant); await f.begin();
    assert.equal((await f.call(f.callbackPath(), { headers: { Cookie: f.cookie } })).status, 400);
    assert.equal((await (await f.call('/api/session', { headers: { Cookie: f.cookie } })).json()).authenticated, false);
    assert.equal((await f.call(f.callbackPath(), { headers: { Cookie: f.cookie } })).status, 400);
    assert.equal(f.exchanges, 1);
  });
}

test('login requires same-origin action and callback requires its initiating browser', async t => {
  const f = await fixture(t);
  assert.equal((await f.begin({ Origin: 'https://foreign.example' })).status, 403);
  await f.begin();
  assert.equal((await f.call(f.callbackPath())).status, 400); assert.equal(f.exchanges, 0);
  assert.equal((await f.call(f.callbackPath() + '&state=duplicate', { headers: { Cookie: f.cookie } })).status, 400);
  assert.equal(f.exchanges, 0);
});

test('wrong state consumes the attempt and expiry cannot authorize a stale transaction', async t => {
  const f = await fixture(t); await f.begin();
  const path = f.callbackPath();
  assert.equal((await f.call(path.replace(/state=[^&]+/, 'state=wrong'), { headers: { Cookie: f.cookie } })).status, 400);
  assert.equal((await f.call(path, { headers: { Cookie: f.cookie } })).status, 400);
  await f.begin(); f.advance(301);
  assert.equal((await f.call(f.callbackPath(), { headers: { Cookie: f.cookie } })).status, 400);
  assert.equal(f.exchanges, 0);
});

test('foreign Host and duplicate session cookies cannot reuse a session', async t => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(f.origin, { headers: { Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  await f.begin();
  assert.equal((await f.call(f.callbackPath(), { headers: { Cookie: f.cookie + '; ' + f.cookie } })).status, 400);
  assert.equal(f.exchanges, 0);
});
