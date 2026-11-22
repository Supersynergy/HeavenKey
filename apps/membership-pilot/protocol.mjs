import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { SdJwtVcInstance } from '@sd-jwt/sd-jwt-vc';
import {
  calculateJwkThumbprint, compactVerify, decodeProtectedHeader,
  FlattenedSign, importJWK, jwtVerify, SignJWT,
} from 'jose';

export const VERIFIER = 'heavenkey-membership-verifier';
export const CONFIGURATION = 'membership';
export const VCT = 'https://heavenkey.app/credentials/membership/v1';
export const TENANT = 'supersynergy-demo';
export const PROJECT = 'project-demo-1';
export const MEMBERSHIP = 'project-member';
export const STATUS_CAPACITY = 2048;
export const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';
export const CLAIMS = ['org_id', 'membership'];
export const REQUEST_TTL = 120;
const TRANSACTION_TYPE = 'https://heavenkey.app/transactions/invoice-draft/v1';

export function transactionEntry(operation) {
  if (operation.kind !== 'invoice.draft.create') return undefined;
  return Buffer.from(JSON.stringify({
    type: TRANSACTION_TYPE, credential_ids: [CONFIGURATION], transaction_data_hashes_alg: ['sha-256'],
    ...operation,
  })).toString('base64url');
}
export const CLOCK_SKEW = 5;
const ALG = 'ES256';
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

export function opaque() {
  return randomBytes(32).toString('base64url');
}

export function digest(value) {
  return createHash('sha256').update(value).digest('base64url');
}

export function publicJwk(input) {
  if (input?.kty !== 'EC' || input.crv !== 'P-256' ||
      !COORDINATE.test(input.x ?? '') || !COORDINATE.test(input.y ?? '')) {
    throw new Error('Expected P-256 public coordinates');
  }
  return { kty: input.kty, crv: input.crv, x: input.x, y: input.y };
}

function sha256(data, alg) {
  if (alg !== 'sha-256') throw new Error('Unsupported digest');
  return createHash('sha256').update(typeof data === 'string' ? data : Buffer.from(data)).digest();
}

function signer(key) {
  return async (data) => {
    const [header, payload] = data.split('.');
    const protectedHeader = JSON.parse(Buffer.from(header, 'base64url'));
    const jws = await new FlattenedSign(Buffer.from(payload, 'base64url'))
      .setProtectedHeader(protectedHeader).sign(key);
    if (jws.protected !== header || jws.payload !== payload) throw new Error('JWS encoding mismatch');
    return jws.signature;
  };
}

function verifyWith(key) {
  return async (input, signature) => {
    await compactVerify(input + '.' + signature, key, { algorithms: [ALG] });
    return true;
  };
}

function signJwt(payload, key, { typ, kid, issuer, audience, now, exp }) {
  const token = new SignJWT(payload).setProtectedHeader({ alg: ALG, typ, kid })
    .setIssuer(issuer).setIssuedAt(now).setExpirationTime(exp);
  if (audience) token.setAudience(audience);
  return token.sign(key);
}

export async function verifyIssuanceProof(jwt, origin, now) {
  const header = decodeProtectedHeader(jwt);
  if (header.typ !== 'openid4vci-proof+jwt' || header.alg !== ALG || header.jwk?.d !== undefined) {
    throw new Error('Invalid issuance proof header');
  }
  const jwk = publicJwk(header.jwk);
  const { payload } = await jwtVerify(jwt, await importJWK(jwk, ALG), {
    algorithms: [ALG], audience: origin, requiredClaims: ['iat', 'nonce'],
    currentDate: new Date(now * 1000), maxTokenAge: 60, clockTolerance: CLOCK_SKEW,
  });
  if (payload.aud !== origin || payload.iss !== undefined || typeof payload.nonce !== 'string') {
    throw new Error('Invalid issuance proof');
  }
  return { jwk, holderId: await calculateJwkThumbprint(jwk), nonce: payload.nonce, issuedAt: payload.iat };
}

export async function makeProtocol({ origin, issuerKey, verifierKey, getStatus, clock }) {
  const issuerJwk = publicJwk(issuerKey);
  const verifierJwk = publicJwk(verifierKey);
  const issuerKid = await calculateJwkThumbprint(issuerJwk);
  const verifierKid = await calculateJwkThumbprint(verifierJwk);
  if (issuerKid === verifierKid) throw new Error('Issuer and verifier keys must differ');
  const issuerPrivateKey = await importJWK(issuerKey, ALG);
  const verifierPrivateKey = await importJWK(verifierKey, ALG);
  const issuerVerifier = verifyWith(await importJWK(issuerJwk, ALG));
  const statusUri = origin + '/status';
  async function statusJwt() {
    const now = clock();
    const bits = getStatus(now);
    if (!Buffer.isBuffer(bits) || bits.length !== STATUS_CAPACITY / 8) throw new Error('Unable to read status');
    return signJwt({ sub: statusUri, ttl: 1, status_list: {
      bits: 1,
      lst: deflateSync(bits).toString('base64url'),
    } }, issuerPrivateKey, { typ: 'statuslist+jwt', kid: issuerKid, issuer: origin, now, exp: now + 60 });
  }
  const sdjwt = new SdJwtVcInstance({
    signer: signer(issuerPrivateKey),
    signAlg: ALG,
    hashAlg: 'sha-256',
    hasher: sha256,
    allowedDisclosureHashAlgorithms: ['sha-256'],
    saltGenerator: () => randomBytes(16).toString('base64url'),
    verifier: issuerVerifier,
    kbVerifier: async (input, signature, payload) => {
      const jwk = publicJwk(payload.cnf?.jwk);
      return verifyWith(await importJWK(jwk, ALG))(input, signature);
    },
    maxStatusListDecompressedBytes: STATUS_CAPACITY / 8,
    statusListFetcher: async (uri) => {
      if (uri !== statusUri) throw new Error('Untrusted status URL');
      return statusJwt();
    },
    statusValidator: (status, context) => {
      if (status !== 0 || context.statusListJwt.payload.iss !== origin) throw new Error('Invalid status');
    },
    loadTypeMetadataFormat: false,
    fetch: () => { throw new Error('External metadata access is disabled'); },
  });
  return {
    issuerJwk: { ...issuerJwk, kid: issuerKid, alg: ALG },
    statusJwt,
    issue({ jwk, index, now, expiration }) {
      return sdjwt.issue({
        iss: origin, iat: now, nbf: now, exp: expiration, vct: VCT, cnf: { jwk },
        status: { status_list: { idx: index, uri: statusUri } },
        org_id: TENANT, membership: MEMBERSHIP, internal_label: 'synthetic-only',
      }, { _sd: [...CLAIMS, 'internal_label'] }, { header: { kid: issuerKid } });
    },
    authorize({ id, nonce, state, operation, now, expiration }) {
      const transaction = transactionEntry(operation);
      return signJwt({
        jti: id, client_id: VERIFIER, response_type: 'vp_token', response_mode: 'direct_post',
        response_uri: origin + '/present', nonce, state,
        dcql_query: { credentials: [{
          id: CONFIGURATION, format: 'dc+sd-jwt', meta: { vct_values: [VCT] },
          require_cryptographic_holder_binding: true, claims: CLAIMS.map((claim) => ({ path: [claim] })),
        }] },
        hk_operation: operation,
        ...(transaction && { transaction_data: [transaction] }),
      }, verifierPrivateKey, {
        typ: 'oauth-authz-req+jwt', kid: verifierKid, issuer: VERIFIER,
        audience: 'https://self-issued.me/v2', now, exp: expiration,
      });
    },
    async verify(presentation, { nonce, now, operation }) {
      const { payload, kb } = await sdjwt.verify(presentation, {
        expectedIssuer: origin, expectedVct: VCT, allowedIssuerAlgorithms: [ALG],
        allowedKeyBindingAlgorithms: [ALG], currentDate: now, skewSeconds: CLOCK_SKEW,
        expectedKeyBindingAudience: VERIFIER, keyBindingNonce: nonce, keyBindingMaxAgeSeconds: 60,
        requiredClaimKeys: ['exp', 'nbf', 'iat', 'cnf', 'status', ...CLAIMS],
      });
      const index = payload.status?.status_list?.idx;
      if (!kb || kb.payload.aud !== VERIFIER || kb.payload.nonce !== nonce ||
          !Number.isSafeInteger(index) || index < 0 || index >= STATUS_CAPACITY ||
          payload.status.status_list.uri !== statusUri || payload.exp <= now ||
          payload.org_id !== TENANT || payload.membership !== MEMBERSHIP || 'internal_label' in payload) {
        throw new Error('Presentation outside membership profile');
      }
      const transaction = transactionEntry(operation);
      const hashes = kb.payload.transaction_data_hashes;
      const algorithm = kb.payload.transaction_data_hashes_alg;
      if (transaction ? algorithm !== 'sha-256' || !Array.isArray(hashes) ||
        hashes.length !== 1 || hashes[0] !== digest(transaction) : hashes !== undefined || algorithm !== undefined) {
        throw new Error('Presentation has incorrect transaction data');
      }
      return { credentialId: index, holderId: await calculateJwkThumbprint(publicJwk(payload.cnf.jwk)),
        proofIssuedAt: kb.payload.iat };
    },
  };
}
