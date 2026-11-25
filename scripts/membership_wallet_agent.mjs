import { readFileSync, realpathSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reference = /^[A-Za-z0-9_-]{43}$/;
const usage = 'Aufruf: node scripts/membership_wallet_agent.mjs <Vorschauordner> <Auftragskennung> <Wiederholungsschlüssel>';

class AgentFailure extends Error {}

const validId = (value) => typeof value === 'string' && value.length === 36 && uuid.test(value);
const validReference = (value) => typeof value === 'string' && value.length === 43 && reference.test(value);

function readProfile(directory) {
  try {
    const profileDirectory = realpathSync(directory);
    const fromRepo = relative(repository, profileDirectory);
    if (fromRepo === '' || (fromRepo !== '..' && !fromRepo.startsWith(`..${sep}`) && !isAbsolute(fromRepo))) throw new Error();
    const profile = JSON.parse(readFileSync(join(profileDirectory, 'machine.json'), 'utf8'));
    const origin = new URL(profile.origin);
    if (Object.keys(profile).sort().join(',') !== 'machineToken,origin'
      || !validReference(profile.machineToken)
      || profile.origin !== `https://127.0.0.1:${origin.port}` || Number(origin.port) < 1024) throw new Error();
    const ca = readFileSync(join(profileDirectory, 'ca.pem'));
    if (ca.byteLength > 16_384) throw new Error();
    return { origin, ca, token: profile.machineToken };
  } catch {
    throw new AgentFailure('Das lokale Agentenprofil oder sein TLS-Zertifikat ist ungültig.');
  }
}

const statusMessages = new Map([
  [400, 'Der Agentenauftrag hat ungültige Referenzen.'],
  [401, 'Der Testdienst hat die Maschinenidentität abgewiesen.'],
  [403, 'Die aktuellen Rechte erlauben diesen Rechnungsentwurf nicht.'],
  [404, 'Der Testdienst findet diese Agentenfreigabe nicht.'],
  [409, 'Der Wiederholungsschlüssel passt nicht zur Agentenfreigabe.'],
  [410, 'Die Agentenfreigabe ist abgelaufen oder wurde widerrufen.'],
]);
const unknownOutcome = 'Ausgang unklar. Verwende für den Abgleich dieselbe Auftragskennung und denselben Wiederholungsschlüssel.';

export async function runInvoiceDraft(directory, delegationId, idempotencyKey) {
  if (typeof directory !== 'string' || !validId(delegationId) || !validReference(idempotencyKey)) throw new AgentFailure(usage);
  const profile = readProfile(directory);
  const agent = new Agent({ ca: profile.ca, minVersion: 'TLSv1.2', keepAlive: false });
  const body = JSON.stringify({ delegation_id: delegationId });
  try {
    return await new Promise((resolve, reject) => {
      const req = request(new URL('/agent/invoice-draft', profile.origin), {
        agent,
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        maxHeaderSize: 8192,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${profile.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Idempotency-Key': idempotencyKey,
        },
      }, async (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(new AgentFailure(statusMessages.get(res.statusCode) ?? unknownOutcome));
          return;
        }
        try {
          if (res.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Error();
          let length = 0;
          const chunks = [];
          for await (const chunk of res) {
            length += chunk.byteLength;
            if (length > 4096) throw new Error();
            chunks.push(chunk);
          }
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (Object.keys(value).sort().join(',') !== 'delegation_id,draft_id,status'
            || value.delegation_id !== delegationId || value.status !== 'executed'
            || !validId(value.draft_id)) throw new Error();
          resolve({ delegation_id: delegationId, draft_id: value.draft_id, status: 'executed' });
        } catch {
          res.destroy();
          reject(new AgentFailure(unknownOutcome));
        }
      });
      req.on('error', () => reject(new AgentFailure(unknownOutcome)));
      req.end(body);
    });
  } finally {
    agent.destroy();
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 5) throw new AgentFailure(usage);
    console.log(JSON.stringify(await runInvoiceDraft(...process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof AgentFailure ? error.message : unknownOutcome);
    process.exitCode = 1;
  }
}
