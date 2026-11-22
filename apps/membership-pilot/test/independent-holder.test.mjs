import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Openid4vciClient } from '@openid4vc/openid4vci';
import { Openid4vpClient } from '@openid4vc/openid4vp';
import { SdJwtVcInstance } from '@sd-jwt/sd-jwt-vc';
import { compactVerify, decodeJwt, importJWK } from 'jose';
import { createMembershipPilot } from '../server.mjs';

const launcher = fileURLToPath(new URL('../../../scripts/membership_wallet_preview.mjs', import.meta.url));
const host = '127.0.0.1';
const algorithm = 'ES256';

async function nextPort() {
  const socket = createServer().listen(0, host);
  await once(socket, 'listening');
  const { port } = socket.address();
  socket.close();
  await once(socket, 'close');
  return port;
}

function pinnedFetch(origin, ca) {
  return async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, origin, 'All peer endpoints must use the configured HTTPS origin');
    const headers = Object.fromEntries(new Headers(options.headers));
    const body = options.body === undefined ? undefined : String(options.body);
    if (body !== undefined) {
      if (options.body instanceof URLSearchParams) {
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      }
      headers['content-length'] = Buffer.byteLength(body);
    }
    return new Promise((resolve, reject) => {
      const connection = request(url, { method: options.method, ca, headers, timeout: 4000 }, (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () => {
          resolve(new Response(Buffer.concat(chunks), {
            status: incoming.statusCode, headers: new Headers(incoming.headers),
          }));
        });
      });
      connection.once('timeout', () => connection.destroy(new Error('Loopback request timed out')));
      connection.once('error', reject);
      connection.end(body);
    });
  };
}

function hash(input, alg) {
  assert.equal(alg, 'sha-256');
  return createHash('sha256').update(typeof input === 'string' ? input : Buffer.from(input)).digest();
}

test('independent OpenWallet Foundation holder exchanges OpenID4VCI and OpenID4VP over TLS', {
  timeout: 15000,
}, async (context) => {
  const port = await nextPort();
  const directory = execFileSync(process.execPath, [launcher, 'init', String(port)], { encoding: 'utf8' }).trim();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const privateConfig = JSON.parse(readFileSync(join(directory, 'server.json'), 'utf8'));
  const publicConfig = JSON.parse(readFileSync(join(directory, 'android-wallet.json'), 'utf8'));
  const { origin, tlsCa, verifierClientId, issuerJwk, verifierJwk } = publicConfig;
  const pilot = await createMembershipPilot({
    ...privateConfig,
    tls: {
      key: readFileSync(join(directory, 'server.key')),
      cert: readFileSync(join(directory, 'server.pem')),
    },
  });
  context.after(() => pilot.close());
  pilot.server.listen(port, host);
  await once(pilot.server, 'listening');

  const fetch = pinnedFetch(origin, tlsCa);
  const holder = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const holderJwk = holder.publicKey.export({ format: 'jwk' });
  const peerJws = createPublicKey({ key: verifierJwk, format: 'jwk' });
  const signHolder = (data) => sign('sha256', Buffer.from(data), {
    key: holder.privateKey, dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

  const callbacks = {
    fetch,
    hash,
    generateRandom: randomBytes,
    clientAuthentication: ({ request: outgoing }) => outgoing,
    signJws: (_, { signingInput, protectedHeader }) => {
      assert.equal(protectedHeader.alg, algorithm);
      return { signature: signHolder(signingInput), signerJwk: holderJwk };
    },
    verifyJws: (_, { signingInput, signature, protectedHeader }) => {
      const verified = protectedHeader.alg === algorithm && verify('sha256', Buffer.from(signingInput),
        { key: peerJws, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
      return verified ? { verified, signerJwk: verifierJwk } : { verified };
    },
  };
  const issuance = new Openid4vciClient({ callbacks });
  const presentation = new Openid4vpClient({ callbacks });
  const browserResponse = await fetch(origin, { headers: { accept: 'application/json' } });
  const cookie = browserResponse.headers.get('set-cookie').split(';')[0];
  const { csrf } = await browserResponse.json();
  async function browserAction(path, extra = {}) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { origin, cookie, accept: 'application/json' },
      body: new URLSearchParams({ csrf, ...extra }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  const offer = await browserAction('/browser/offer');
  const credentialOffer = await issuance.resolveCredentialOffer(offer.launch);
  assert.equal(credentialOffer.credential_issuer, origin);
  const [credentialConfigurationId] = credentialOffer.credential_configuration_ids;
  assert.equal(credentialConfigurationId, 'membership');
  const issuerMetadata = await issuance.resolveIssuerMetadata(origin);
  const { accessTokenResponse } = await issuance.retrievePreAuthorizedCodeAccessTokenFromOffer({
    credentialOffer, issuerMetadata,
  });
  const { c_nonce: nonce } = await issuance.requestNonce({ issuerMetadata });
  const proof = await issuance.createCredentialRequestJwtProof({
    signer: { method: 'jwk', alg: algorithm, publicJwk: holderJwk },
    issuerMetadata,
    credentialConfigurationId,
    nonce,
  });
  const result = await issuance.retrieveCredentials({
    issuerMetadata,
    credentialConfigurationId,
    proofs: { jwt: [proof.jwt] },
    accessToken: accessTokenResponse.access_token,
  });
  const credential = result.credentialResponse.credentials[0].credential;
  const originalJwt = credential.split('~')[0];
  await compactVerify(originalJwt, await importJWK(issuerJwk, algorithm), { algorithms: [algorithm] });
  assert.deepEqual(decodeJwt(originalJwt).cnf.jwk, holderJwk);

  const sdJwt = new SdJwtVcInstance({ hasher: hash, kbSigner: signHolder, kbSignAlg: algorithm });
  async function prepare(path) {
    const { launch } = await browserAction(path);
    const parsed = presentation.parseOpenid4vpAuthorizationRequest({ authorizationRequest: launch });
    const resolved = await presentation.resolveOpenid4vpAuthorizationRequest({
      authorizationRequestPayload: parsed.params,
      responseMode: { type: 'direct_post' },
    });
    const parameters = resolved.authorizationRequestPayload;
    assert.ok(resolved.jar);
    assert.equal(parameters.client_id, verifierClientId);
    assert.equal(parameters.response_uri, origin + '/present');
    assert.ok(resolved.version >= 100);
    assert.deepEqual(parameters.dcql_query.credentials[0].claims.map(({ path }) => path), [
      ['org_id'], ['membership'],
    ]);
    return resolved;
  }

  async function present(authorizationRequestPayload, transactionClaims = {}) {
    const { nonce: requestNonce, client_id: audience } = authorizationRequestPayload;
    const token = await sdJwt.present(credential, { org_id: true, membership: true }, {
      kb: { payload: { aud: audience, nonce: requestNonce, iat: Math.floor(Date.now() / 1000), ...transactionClaims } },
    });
    const { authorizationResponsePayload } = await presentation.createOpenid4vpAuthorizationResponse({
      authorizationRequestPayload,
      authorizationResponsePayload: { vp_token: { membership: [token] } },
    });
    return (await presentation.submitOpenid4vpAuthorizationResponse({
      authorizationRequestPayload, authorizationResponsePayload,
    })).response;
  }

  const project = await prepare('/browser/request/project');
  const verification = await present(project.authorizationRequestPayload);
  assert.equal(verification.status, 200);
  assert.equal((await verification.json()).status, 'verified');
  const projectAccess = await fetch(origin + '/project', { headers: { cookie, accept: 'application/json' } });
  assert.deepEqual(await projectAccess.json(), {
    tenant: 'supersynergy-demo', resource: 'project-demo-1', permission: 'project.read',
  });

  const invoice = await prepare('/browser/request/invoice');
  assert.equal(invoice.transactionData.length, 1);
  const [entry] = invoice.transactionData;
  assert.equal(entry.transactionData.type, 'https://heavenkey.app/transactions/invoice-draft/v1');
  assert.equal(entry.transactionData.amount_minor, 45_000);
  const genericDisclosure = await present(invoice.authorizationRequestPayload);
  assert.equal(genericDisclosure.status, 400, 'Claim disclosure alone must not authorize a business action');
  const approval = await present(invoice.authorizationRequestPayload, {
    transaction_data_hashes_alg: 'sha-256',
    transaction_data_hashes: [hash(entry.encoded, 'sha-256').toString('base64url')],
  });
  assert.equal(approval.status, 200);
});
