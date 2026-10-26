import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as oidc from 'openid-client';
import { applications, issuer, localUrl, validateMetadata } from './config.mjs';

const lifetime = 300_000;
const token = () => randomBytes(32).toString('base64url');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const equal = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

function readCookie(header, name) {
  const values = (header ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

async function form(request) {
  if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') throw new Error('invalid_form');
  const chunks = []; let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 1024) throw new Error('form_too_large');
    chunks.push(part);
  }
  const result = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (result.getAll('csrf').length !== 1) throw new Error('invalid_csrf');
  return result;
}

function page(app, session) {
  const action = session.subject ? 'logout' : 'login';
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HeavenKey · ${escape(app.name)}</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#101b23;color:#edf4f1}body{max-width:760px;margin:9vh auto;padding:24px}article{padding:32px;border:1px solid #45615b;border-radius:24px;background:#16272e}h1{font-size:2.3rem;line-height:1.1}p{line-height:1.6}.eyebrow{color:#c7b88b}button{background:#ddcd9e;color:#182a2e;border:0;border-radius:14px;padding:15px 22px;font:inherit;font-weight:650;cursor:pointer}code{overflow-wrap:anywhere}.status{padding:14px;border-radius:12px;background:#243a40}small{color:#c1cfcc}
</style><article><p class="eyebrow">HEAVENKEY · LOKALER IDENTITÄTSPILOT</p><h1>${escape(app.name)}</h1>
<p>Ein persönlicher Zugang. Ohne Website-Passwort.</p>
<p class="status" data-testid="status">${session.subject ? 'Angemeldet mit HeavenKey' : 'Bereit für deine Passkey-Anmeldung'}</p>
${session.subject ? `<p>Deine Kennung in dieser Demo:<br><code data-testid="subject">${escape(session.subject)}</code></p><p data-testid="assurance">Identität nicht geprüft · kein KYC-Nachweis</p>` : '<p>Die Registrierung führt direkt zur Passkey-Einrichtung. Es wird kein Nutzerpasswort angelegt.</p>'}
<form method="post" action="/${action}"><input type="hidden" name="csrf" value="${session.csrf}"><button>${session.subject ? 'Diese Demo abmelden' : 'Mit HeavenKey anmelden'}</button></form>
${session.subject ? '' : `<form method="post" action="/register"><input type="hidden" name="csrf" value="${session.csrf}"><p><button>HeavenKey neu einrichten</button></p></form>`}
<p><small>Diese Demo ist keine Verbindung zu echten Office- oder Kundenkonten. Nur erfundene Testdaten verwenden. Abmelden beendet diese Demo-Sitzung; die Anmeldung beim Loginanbieter kann weiterbestehen. Eine Sitzung gilt höchstens fünf Minuten.</small></p></article></html>`;
}

export async function createPilotApp({ app, clientSecret, provider = issuer, now = Date.now }) {
  const origin = localUrl(app.origin);
  if (origin.pathname !== '/' || origin.search || !/^[a-z0-9-]+$/.test(app.id)
      || typeof clientSecret !== 'string' || clientSecret.length < 32) throw new Error('invalid_app_configuration');
  const providerUrl = localUrl(provider);
  const guardedFetch = async (url, options) => {
    if (localUrl(String(url)).origin !== providerUrl.origin) throw new Error('foreign_provider_request');
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
  };
  const configuration = await oidc.discovery(providerUrl, app.id, { client_secret: clientSecret, [oidc.clockTolerance]: 0 }, undefined, {
    execute: [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks], [oidc.customFetch]: guardedFetch,
  });
  validateMetadata(configuration.serverMetadata(), provider);
  const cookie = `hk_${app.id.replaceAll('-', '_')}`;
  const sessions = new Map();
  const setCookie = id => `${cookie}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`;
  const sweep = () => { for (const [id, s] of sessions) if (s.expires <= now()) sessions.delete(id); };

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    // Preserve the Origin of same-origin HTML POSTs; suppress cross-origin referrers.
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${providerUrl.origin}; frame-ancestors 'none'; base-uri 'none'`);
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type }); response.end(body);
    };
    const redirect = target => { response.writeHead(303, { Location: target }); response.end(); };
    try {
      if (request.headers.host !== origin.host || !request.url?.startsWith('/') || request.url.startsWith('//')) {
        send(403, 'host_denied'); return;
      }
      const url = new URL(request.url, origin);
      sweep();
      let id = readCookie(request.headers.cookie, cookie);
      let session = id ? sessions.get(id) : undefined;
      if (request.method === 'GET' && url.pathname === '/health') { send(200, 'ok'); return; }
      if (request.method === 'GET' && url.pathname === '/') {
        if (!session) {
          if (sessions.size >= 1000) { send(429, 'session_limit'); return; }
          id = token(); session = { csrf: token(), expires: now() + lifetime }; sessions.set(id, session);
          response.setHeader('Set-Cookie', setCookie(id));
        }
        send(200, page(app, session), 'text/html; charset=utf-8'); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/session') {
        send(200, JSON.stringify({ authenticated: Boolean(session?.subject), application: app.id,
          ...(session?.subject ? { subject: session.subject } : {}), identityVerified: false, proofing: 'not-configured' }), 'application/json'); return;
      }
      if (request.method === 'POST' && ['/login', '/register', '/logout'].includes(url.pathname)) {
        if (!session || request.headers.origin !== origin.origin || !equal((await form(request)).get('csrf'), session.csrf)) {
          send(403, 'request_denied'); return;
        }
        if (url.pathname === '/logout') {
          sessions.delete(id); response.setHeader('Set-Cookie', `${cookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
          redirect('/'); return;
        }
        const verifier = oidc.randomPKCECodeVerifier();
        session.pending = { verifier, state: oidc.randomState(), nonce: oidc.randomNonce(), expires: now() + lifetime };
        const authorization = oidc.buildAuthorizationUrl(configuration, {
          redirect_uri: `${origin.origin}/callback`, scope: 'openid', response_type: 'code',
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
          state: session.pending.state, nonce: session.pending.nonce,
        });
        if (url.pathname === '/register') {
          // Keycloak's documented registration endpoint; the OIDC transaction is unchanged.
          if (!authorization.pathname.endsWith('/protocol/openid-connect/auth')) throw new Error('registration_unavailable');
          authorization.pathname = authorization.pathname.slice(0, -4) + 'registrations';
        }
        redirect(authorization.href); return;
      }
      if (request.method === 'GET' && url.pathname === '/callback') {
        response.setHeader('Referrer-Policy', 'no-referrer');
        const pending = session?.pending;
        if (session) delete session.pending; // Every callback attempt consumes its transaction.
        if (!pending || pending.expires <= now() || !equal(url.searchParams.get('state'), pending.state)
            || ['state', 'code', 'error', 'iss'].some(key => url.searchParams.getAll(key).length > 1)) {
          send(400, 'login_rejected'); return;
        }
        const result = await oidc.authorizationCodeGrant(configuration, url, {
          pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true,
        });
        const claims = result.claims();
        if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.exp * 1000 <= now()) throw new Error('invalid_subject');
        // Rotate the browser session; retain no access, ID or refresh token.
        sessions.delete(id); id = token();
        sessions.set(id, { subject: claims.sub, csrf: token(), expires: Math.min(now() + lifetime, claims.exp * 1000) });
        response.setHeader('Set-Cookie', setCookie(id)); redirect('/'); return;
      }
      send(404, 'not_found');
    } catch {
      // Do not return provider responses, tokens, authorization codes or stack traces.
      send(400, 'login_rejected');
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 40;
  server.keepAliveTimeout = 1000;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const runtime = JSON.parse(await readFile(process.env.HEAVENKEY_PILOT_CONFIG, 'utf8'));
  const servers = [];
  for (const app of applications) {
    const server = await createPilotApp({ app, clientSecret: runtime.clientSecrets[app.id] });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(new URL(app.origin).port), '127.0.0.1', resolve); });
    servers.push(server); console.log(`${app.name}: ${app.origin}`);
  }
  const stop = () => { for (const server of servers) server.close(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
