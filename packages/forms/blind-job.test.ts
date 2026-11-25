import { test, expect } from 'bun:test';
import { blindEntityAllowed, blindScanText, createBlindScan, entityAvailable, parseBlindJob, planBlindJob, validateBlindScan, type BlindJob } from './blind-job';

const scanFields = [
  { id: '11111111-1111-4111-8111-111111111111', field: 'Vorname', entity: 'firstName', score: 100, hasValue: false, sensitive: false, secret: false, kind: 'text', form: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', formMethod: 'post', formDestinations: ['https://antrag.example'] },
  { id: '22222222-2222-4222-8222-222222222222', field: 'IBAN', entity: 'iban', score: 95, hasValue: false, sensitive: true, secret: false, kind: 'text', form: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', formMethod: 'post', formDestinations: ['https://antrag.example'] },
  { id: '33333333-3333-4333-8333-333333333333', field: 'Nachricht', entity: 'message', score: 80, hasValue: false, sensitive: false, secret: false, kind: 'textarea', form: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', formMethod: 'post', formDestinations: ['https://antrag.example'] },
];
const scanInput = {
  scan: '44444444-4444-4444-8444-444444444444',
  origin: 'https://antrag.example',
  href: 'https://antrag.example/antrag/start?fall=synthetic',
  availableEntities: ['firstName', 'iban', 'message', 'birthdate', 'ccExp', 'cvc'],
  fields: scanFields,
};
function scan() { return createBlindScan({ ...scanInput, now: 1_700_000_000_000 }); }
function job(overrides: Record<string, unknown> = {}): BlindJob {
  return {
    version: 1,
    kind: 'heavenkey-blind-form-job',
    scan: scanInput.scan,
    origin: scanInput.origin,
    href: scanInput.href,
    fields: [
      { id: scanFields[0].id, entity: 'firstName' },
      { id: scanFields[2].id, entity: 'message' },
    ],
    options: { sensitive: false, secrets: false, overwrite: false, choices: false, submit: false },
    ...overrides,
  } as BlindJob;
}

test('scan export is strict metadata and never forwards values or extra properties', () => {
  const exported = createBlindScan({
    ...scanInput,
    now: 1_700_000_000_000,
    fields: [{ ...scanFields[0], value: 'synthetic-personal-value', anchored: true } as never],
  });
  expect(exported.fields).toHaveLength(1);
  expect(JSON.stringify(exported)).not.toContain('synthetic-personal-value');
  expect(JSON.stringify(exported)).not.toContain('anchored');
  expect(validateBlindScan(JSON.parse(blindScanText(exported)))).toEqual(exported);
});

test('valid blind job resolves without exposing profile values', () => {
  const accepted = parseBlindJob(JSON.stringify(job()), scan());
  expect(accepted.fields).toHaveLength(2);
  expect(JSON.stringify(accepted)).not.toContain('DE89370400440532013000');
});

test('job binding rejects wrong scan, changed URL, unknown keys and plaintext value channels', () => {
  for (const bad of [
    { ...job(), scan: '55555555-5555-4555-8555-555555555555' },
    { ...job(), href: 'https://antrag.example/anders' },
    { ...job(), fields: [{ ...job().fields[0], value: 'synthetic' }] },
    { ...job(), payload: { firstName: 'synthetic' } },
  ]) expect(() => parseBlindJob(JSON.stringify(bad), scan())).toThrow('Blinder Formularauftrag ungültig');
});

test('sensitive values require exact target and explicit sensitive permission', () => {
  const iban = { id: scanFields[1].id, entity: 'iban' };
  expect(() => parseBlindJob(JSON.stringify(job({ fields: [iban] })), scan())).toThrow('sensible Freigabe');
  const allowed = job({ fields: [iban], options: { sensitive: true, secrets: false, overwrite: false, choices: false, submit: false } });
  expect(parseBlindJob(JSON.stringify(allowed), scan()).fields).toEqual([iban]);
  const downgrade = job({ fields: [{ id: scanFields[1].id, entity: 'message' }], options: { sensitive: true, secrets: false, overwrite: false, choices: false, submit: false } });
  expect(() => parseBlindJob(JSON.stringify(downgrade), scan())).toThrow('Sensitivität');
});

test('derived birthdate and card fields use source availability rather than leaking values', () => {
  expect(blindEntityAllowed('bday_day')).toBe(true);
  expect(entityAvailable('bday_day', ['birthdate'])).toBe(true);
  expect(entityAvailable('cc_month', ['ccExp'])).toBe(true);
  expect(entityAvailable('cc_csc', ['cvc'])).toBe(true);
  expect(entityAvailable('firstName', ['lastName'])).toBe(false);
});

test('blind submit is limited to one same-origin POST form', () => {
  const submitJob = job({ fields: [job().fields[0]], options: { sensitive: false, secrets: false, overwrite: false, choices: false, submit: true } });
  expect(parseBlindJob(JSON.stringify(submitJob), scan()).options.submit).toBe(true);
  const multi = job({ fields: [job().fields[0], { ...job().fields[0], id: scanFields[1].id, entity: 'iban' }], options: { sensitive: true, secrets: false, overwrite: false, choices: false, submit: true } });
  expect(parseBlindJob(JSON.stringify(multi), scan()).options.submit).toBe(true);
  const altered = scan();
  altered.fields[0].formMethod = 'get';
  expect(() => parseBlindJob(JSON.stringify(submitJob), altered)).toThrow('POST');
  const foreign = scan();
  foreign.fields[0].formDestinations = ['https://evil.invalid'];
  expect(() => parseBlindJob(JSON.stringify(submitJob), foreign)).toThrow('zielgleiche');
  const separateForms = scan();
  separateForms.fields[1].form = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  expect(() => parseBlindJob(JSON.stringify(multi), separateForms)).toThrow('genau eines HTML-Formulars');
});

test('reference planner creates least-metadata jobs and derives only required permission requests', () => {
  const planned = planBlindJob(scan());
  expect(planned.fields.map(row => row.id)).toEqual([scanFields[0].id, scanFields[1].id, scanFields[2].id]);
  expect(planned.options).toEqual({ sensitive: true, secrets: false, overwrite: false, choices: true, submit: false });
  expect(JSON.stringify(planned)).not.toContain('Alex');
  expect(parseBlindJob(JSON.stringify(planned), scan())).toEqual(planned);
});

test('reference planner can explicitly map neutral fields without forwarding plaintext values', () => {
  const altered = scan();
  altered.fields[2].entity = null;
  const planned = planBlindJob(altered, { mapping: { [scanFields[2].id]: 'message' }, submit: true, ...({ values: { message: 'synthetic plaintext' } } as never) });
  expect(planned.fields.some(row => row.id === scanFields[2].id && row.entity === 'message')).toBe(true);
  expect(planned.options.submit).toBe(true);
  expect(JSON.stringify(planned)).not.toContain('synthetic plaintext');
});

test('custom application entities can be mapped without weakening exact sensitive boundaries', () => {
  const altered = scan();
  altered.availableEntities.push('custom_aufenthaltstitel');
  altered.fields[2].entity = null;
  const planned = planBlindJob(altered, { mapping: { [scanFields[2].id]: 'custom_aufenthaltstitel' } });
  expect(planned.fields.some(row => row.entity === 'custom_aufenthaltstitel')).toBe(true);
  expect(planned.options.sensitive).toBe(true);
  expect(() => parseBlindJob(JSON.stringify(job({ fields: [{ id: scanFields[1].id, entity: 'custom_aufenthaltstitel' }], options: { sensitive: true, secrets: false, overwrite: false, choices: false, submit: false } })), altered)).toThrow('Sensitivität');
  expect(() => parseBlindJob(JSON.stringify(job({ fields: [{ id: scanFields[2].id, entity: 'custom_aufenthaltstitel' }], options: { sensitive: false, secrets: false, overwrite: false, choices: false, submit: false } })), altered)).toThrow('sensible Freigabe');
});
