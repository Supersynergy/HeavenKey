import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const verifierClientId = 'heavenkey-membership-verifier';
const host = '127.0.0.1';

function writePrivate(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

function openssl(directory, ...args) {
  const command = spawnSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  if (command.status !== 0) throw new Error('OpenSSL konnte das lokale Testzertifikat nicht erzeugen.');
}

function prepare(port) {
  if (!/^[0-9]{4,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    throw new Error('Der Vorschau-Port muss zwischen 1024 und 65535 liegen.');
  }
  process.umask(0o077);
  const temp = realpathSync(tmpdir());
  assertOutsideRepository(temp);
  const directory = mkdtempSync(join(temp, 'heavenkey-membership-'));
  const origin = `https://${host}:${port}`;
  openssl(directory, 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-days', '2', '-subj', '/CN=HeavenKey Membership Preview CA',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'ca.key', '-out', 'ca.pem');
  openssl(directory, 'req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-subj', `/CN=${host}`, '-keyout', 'server.key', '-out', 'server.csr');
  writeFileSync(join(directory, 'tls-extensions.txt'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
    { mode: 0o600, flag: 'wx' });
  openssl(directory, 'x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
    '-CAcreateserial', '-days', '2', '-extfile', 'tls-extensions.txt', '-out', 'server.pem');
  const issuer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const verifier = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const issuerJwk = issuer.publicKey.export({ format: 'jwk' });
  const verifierJwk = verifier.publicKey.export({ format: 'jwk' });
  const tlsCa = readFileSync(join(directory, 'ca.pem'), 'utf8');
  writePrivate(join(directory, 'android-wallet.json'), {
    origin, verifierClientId, issuerJwk, verifierJwk, tlsCa,
  });
  const machineToken = randomBytes(32).toString('base64url');
  writePrivate(join(directory, 'machine.json'), { origin, machineToken });
  writePrivate(join(directory, 'server.json'), {
    origin,
    issuerKey: issuer.privateKey.export({ format: 'jwk' }),
    verifierKey: verifier.privateKey.export({ format: 'jwk' }),
    machineToken,
  });
  console.log(directory);
}

function assertOutsideRepository(directory) {
  const fromRepository = relative(repository, directory);
  if (fromRepository === '' || (!fromRepository.startsWith('../') && !isAbsolute(fromRepository))) {
    throw new Error('Der Vorschau-Ordner muss außerhalb des Repositorys liegen.');
  }
}

function load(directory) {
  const resolved = realpathSync(directory);
  assertOutsideRepository(resolved);
  const profile = JSON.parse(readFileSync(join(resolved, 'server.json'), 'utf8'));
  const local = new URL(profile.origin);
  const expectedOrigin = `https://${host}:${local.port}`;
  if (profile.origin !== expectedOrigin || !local.port) throw new Error('Ungültiger Vorschau-Ursprung.');
  return { resolved, profile, local };
}

async function serve(directory) {
  process.umask(0o077);
  const { resolved, profile, local } = load(directory);
  const { createMembershipPilot } = await import('../apps/membership-pilot/server.mjs');
  const certificate = readFileSync(join(resolved, 'server.pem'));
  const pilot = await createMembershipPilot({
    ...profile,
    dbPath: join(resolved, 'membership.sqlite'),
    tls: { key: readFileSync(join(resolved, 'server.key')), cert: certificate },
  });
  pilot.server.listen(Number(local.port), host);
  await once(pilot.server, 'listening');
  const spki = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
  const pin = createHash('sha256').update(spki).digest('base64');
  console.log(`HeavenKey · synthetischer Testaussteller · ${local.origin}`);
  console.log(`Für einen isolierten Chromium-Test: --ignore-certificate-errors-spki-list=${pin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => pilot.close());
}

function verifySetup(directory) {
  const { resolved, profile, local } = load(directory);
  const android = JSON.parse(readFileSync(join(resolved, 'android-wallet.json'), 'utf8'));
  const issuer = profile.issuerKey;
  const verifier = profile.verifierKey;
  for (const [publicKey, privateKey] of [[android.issuerJwk, issuer], [android.verifierJwk, verifier]]) {
    if (publicKey.d || !['x', 'y', 'crv', 'kty'].every((field) => publicKey[field] === privateKey[field])) {
      throw new Error('Vorschau-Profil und Dienstschlüssel stimmen nicht überein.');
    }
  }
  if (android.origin !== local.origin || android.verifierClientId !== verifierClientId) {
    throw new Error('Der Vorschau-Empfänger stimmt nicht überein.');
  }
  const ca = new X509Certificate(android.tlsCa);
  const leaf = new X509Certificate(readFileSync(join(resolved, 'server.pem')));
  if (leaf.checkIP(host) !== host || !ca.ca || !leaf.verify(ca.publicKey)) {
    throw new Error('Das Vorschau-Zertifikat stimmt nicht überein.');
  }
  console.log('Vorschau-Profil und lokales TLS-Zertifikat überprüft.');
}

const [operation, value, extra] = process.argv.slice(2);
try {
  if (extra !== undefined) throw new Error('Zu viele Argumente.');
  if (operation === 'init') prepare(value ?? '9444');
  else if (operation === 'serve' && value) await serve(value);
  else if (operation === 'verify-setup' && value) verifySetup(value);
  else throw new Error('Aufruf: membership_wallet_preview.mjs init [port] | serve <ordner> | verify-setup <ordner>');
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Cannot find package')
    ? 'Installiere zuerst die gesperrten Abhängigkeiten mit npm ci --prefix apps/membership-pilot.'
    : error.message);
  process.exitCode = 1;
}
