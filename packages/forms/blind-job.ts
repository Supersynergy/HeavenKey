import { CUSTOM_PROFILE_KEY, profileKeyAllowed, profileKeySensitive } from './schema';

export const BLIND_SCAN_KIND = 'heavenkey-blind-form-scan';
export const BLIND_JOB_KIND = 'heavenkey-blind-form-job';
export const BLIND_JOB_VERSION = 1;
export const BLIND_SCAN_TTL_MS = 120_000;

export type BlindField = {
  id: string;
  field: string;
  entity: string | null;
  score: number;
  hasValue: boolean;
  sensitive: boolean;
  secret: boolean;
  kind: string;
  form: string;
  maxLength?: number;
  formMethod?: string;
  formDestinations?: string[];
};
export type BlindScan = {
  version: 1;
  kind: typeof BLIND_SCAN_KIND;
  scan: string;
  origin: string;
  href: string;
  createdAt: string;
  expiresAt: string;
  availableEntities: string[];
  fields: BlindField[];
};
export type BlindSelection = { id: string; entity: string };
export type BlindJobOptions = {
  sensitive: boolean;
  secrets: boolean;
  overwrite: boolean;
  choices: boolean;
  submit: boolean;
};
export type BlindJob = {
  version: 1;
  kind: typeof BLIND_JOB_KIND;
  scan: string;
  origin: string;
  href: string;
  fields: BlindSelection[];
  options: BlindJobOptions;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const derived = new Set(['bday_day', 'bday_month', 'bday_year', 'cc_exp', 'cc_month', 'cc_year', 'cc_csc']);
const secrets = new Set(['password', 'otp']);

export function entityBase(entity: string): string {
  return entity.startsWith('bday_') ? 'birthdate'
    : ['cc_exp', 'cc_month', 'cc_year'].includes(entity) ? 'ccExp'
    : entity === 'cc_csc' ? 'cvc'
    : entity;
}
export function blindEntityAllowed(entity: string): boolean {
  return profileKeyAllowed(entityBase(entity)) || entity === 'otp' || derived.has(entity);
}
export function entityAvailable(entity: string, available: readonly string[]): boolean {
  const present = new Set(available);
  if (entity.startsWith('bday_')) return present.has('birthdate');
  if (['cc_exp', 'cc_month', 'cc_year'].includes(entity)) return present.has('ccExp');
  if (entity === 'cc_csc') return present.has('cvc');
  return present.has(entity);
}
function fail(message: string): never {
  throw new Error(`Blinder Formularauftrag ungültig: ${message}`);
}
function object(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} ist kein Objekt.`);
  const actual = Object.keys(value).sort();
  if (actual.join(',') !== [...keys].sort().join(',')) fail(`${name} hat unerwartete oder fehlende Eigenschaften.`);
  return value as Record<string, unknown>;
}
function objectSubset(value: unknown, required: readonly string[], optional: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} ist kein Objekt.`);
  const actual = Object.keys(value), allowed = new Set([...required, ...optional]);
  if (required.some(key => !actual.includes(key)) || actual.some(key => !allowed.has(key))) fail(`${name} hat unerwartete oder fehlende Eigenschaften.`);
  return value as Record<string, unknown>;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail(`${name} muss ein boolescher Wert sein.`);
  return value;
}
function text(value: unknown, name: string, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value || value.length > max || [...value].some(c => c.charCodeAt(0) < 32)) fail(`${name} ist ungültig.`);
  if (pattern && !pattern.test(value)) fail(`${name} ist ungültig.`);
  return value;
}
function canonicalOrigin(value: unknown, allowLocalHttp = true): string {
  const origin = text(value, 'Herkunft', 2048);
  let url: URL;
  try { url = new URL(origin); } catch { fail('Herkunft ist keine URL.'); }
  if (url.origin !== origin || url.username || url.password || url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('Herkunft ist nicht kanonisch und sicher.');
  return origin;
}
function canonicalHref(value: unknown): string {
  const href = text(value, 'Zieladresse', 2048);
  let url: URL;
  try { url = new URL(href); } catch { fail('Zieladresse ist keine URL.'); }
  if (url.href !== href || url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('Zieladresse ist nicht kanonisch und sicher.');
  return href;
}
function instant(value: unknown, name: string): number {
  const raw = text(value, name, 64);
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) fail(`${name} ist keine Zeitangabe.`);
  return time;
}
function field(value: unknown, index: number): BlindField {
  const row = objectSubset(value, ['id', 'field', 'entity', 'score', 'hasValue', 'sensitive', 'secret', 'kind', 'form'], ['maxLength', 'formMethod', 'formDestinations'], `Feld ${index + 1}`);
  const result: BlindField = {
    id: text(row.id, 'Feld-ID', 36, uuid),
    field: text(row.field, 'Feldbezeichnung', 120),
    entity: row.entity === null ? null : text(row.entity, 'Feldtyp', 80),
    score: typeof row.score === 'number' && Number.isFinite(row.score) && row.score >= 0 && row.score <= 100 ? row.score : fail('Feldwertung ist ungültig.'),
    hasValue: bool(row.hasValue, 'Befüllt-Markierung'),
    sensitive: bool(row.sensitive, 'Sensibel-Markierung'),
    secret: bool(row.secret, 'Geheimnis-Markierung'),
    kind: text(row.kind, 'Feldart', 80),
    form: text(row.form, 'Formular-ID', 36, uuid),
  };
  if (result.entity !== null && !blindEntityAllowed(result.entity)) fail('Feldtyp ist nicht zulässig.');
  if (row.maxLength !== undefined) {
    if (!Number.isSafeInteger(row.maxLength) || (row.maxLength as number) < 0 || (row.maxLength as number) > 1_000_000) fail('Feldlimit ist ungültig.');
    result.maxLength = row.maxLength as number;
  }
  if (row.formMethod !== undefined) {
    const method = text(row.formMethod, 'Formularmethode', 16).toLowerCase();
    if (!['get', 'post', 'dialog'].includes(method)) fail('Formularmethode ist ungültig.');
    result.formMethod = method;
  }
  if (row.formDestinations !== undefined) {
    if (!Array.isArray(row.formDestinations) || row.formDestinations.length > 8) fail('Formularziele sind ungültig.');
    result.formDestinations = row.formDestinations.map((destination, destinationIndex) => canonicalOrigin(destination) || fail(`Formularziel ${destinationIndex + 1} ist ungültig.`));
  }
  return result;
}
export function createBlindScan(input: {
  scan: string;
  origin: string;
  href: string;
  availableEntities: readonly string[];
  fields: readonly BlindField[];
  now?: number;
}): BlindScan {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) fail('Zeitpunkt ist ungültig.');
  const scan: BlindScan = {
    version: 1,
    kind: BLIND_SCAN_KIND,
    scan: text(input.scan, 'Scan-ID', 36, uuid),
    origin: canonicalOrigin(input.origin),
    href: canonicalHref(input.href),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + BLIND_SCAN_TTL_MS).toISOString(),
    availableEntities: [],
    fields: [],
  };
  if (new URL(scan.href).origin !== scan.origin) fail('Zieladresse gehört nicht zur Herkunft.');
  if (!Array.isArray(input.availableEntities) || input.availableEntities.length > 100) fail('Verfügbare Feldtypen sind ungültig.');
  scan.availableEntities = [...new Set(input.availableEntities.map(entity => {
    const value = text(entity, 'Verfügbarer Feldtyp', 80);
    if (!blindEntityAllowed(value)) fail('Verfügbarer Feldtyp ist nicht zulässig.');
    return value;
  }))];
  if (!Array.isArray(input.fields) || input.fields.length > 200) fail('Scanfeldliste ist ungültig.');
  scan.fields = input.fields.map((item, index) => {
    const clean: Record<string, unknown> = {};
    for (const key of ['id', 'field', 'entity', 'score', 'hasValue', 'sensitive', 'secret', 'kind', 'form', 'maxLength', 'formMethod', 'formDestinations'] as const) {
      if (item[key] !== undefined) clean[key] = item[key];
    }
    return field(clean, index);
  });
  const ids = new Set(scan.fields.map(item => item.id));
  if (ids.size !== scan.fields.length) fail('Scanfeld-IDs sind nicht eindeutig.');
  return validateBlindScan(scan);
}
export function validateBlindScan(value: unknown): BlindScan {
  const row = object(value, ['version', 'kind', 'scan', 'origin', 'href', 'createdAt', 'expiresAt', 'availableEntities', 'fields'], 'Scanexport');
  if (row.version !== 1 || row.kind !== BLIND_SCAN_KIND) fail('Scanexport hat eine unbekannte Version oder Art.');
  const created = instant(row.createdAt, 'Scan-Erstellung'), expires = instant(row.expiresAt, 'Scan-Ablauf');
  if (expires <= created || expires - created > BLIND_SCAN_TTL_MS) fail('Scan-Ablauf ist ungültig.');
  if (!Array.isArray(row.fields) || row.fields.length > 200) fail('Scanfeldliste ist ungültig.');
  const scan: BlindScan = {
    version: 1,
    kind: BLIND_SCAN_KIND,
    scan: text(row.scan, 'Scan-ID', 36, uuid),
    origin: canonicalOrigin(row.origin),
    href: canonicalHref(row.href),
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    availableEntities: Array.isArray(row.availableEntities) ? row.availableEntities.map(entity => text(entity, 'Verfügbarer Feldtyp', 80)) : fail('Verfügbare Feldtypen sind ungültig.'),
    fields: row.fields.map((item, index) => field(item, index)),
  };
  if (new URL(scan.href).origin !== scan.origin) fail('Zieladresse gehört nicht zur Herkunft.');
  if (scan.availableEntities.length > 100 || new Set(scan.availableEntities).size !== scan.availableEntities.length || scan.availableEntities.some(entity => !blindEntityAllowed(entity))) fail('Verfügbare Feldtypen sind ungültig.');
  if (new Set(scan.fields.map(item => item.id)).size !== scan.fields.length) fail('Scanfeld-IDs sind nicht eindeutig.');
  return scan;
}
export function validateBlindJob(value: unknown, scan: BlindScan): BlindJob {
  const row = object(value, ['version', 'kind', 'scan', 'origin', 'href', 'fields', 'options'], 'Auftrag');
  if (row.version !== 1 || row.kind !== BLIND_JOB_KIND) fail('Auftrag hat eine unbekannte Version oder Art.');
  const job: BlindJob = {
    version: 1,
    kind: BLIND_JOB_KIND,
    scan: text(row.scan, 'Scan-ID', 36, uuid),
    origin: canonicalOrigin(row.origin),
    href: canonicalHref(row.href),
    fields: [],
    options: { sensitive: false, secrets: false, overwrite: false, choices: false, submit: false },
  };
  const options = object(row.options, ['sensitive', 'secrets', 'overwrite', 'choices', 'submit'], 'Auftragsfreigaben');
  job.options = {
    sensitive: bool(options.sensitive, 'Sensible-Freigabe'),
    secrets: bool(options.secrets, 'Geheimnis-Freigabe'),
    overwrite: bool(options.overwrite, 'Überschreib-Freigabe'),
    choices: bool(options.choices, 'Auswahl-Freigabe'),
    submit: bool(options.submit, 'Absende-Anfrage'),
  };
  if (job.scan !== scan.scan || job.origin !== scan.origin || job.href !== scan.href) fail('Auftrag gehört nicht exakt zu diesem Scan und dieser Seite.');
  if (!Array.isArray(row.fields) || !row.fields.length || row.fields.length > 200) fail('Auftragsfelder sind ungültig.');
  const scanFields = new Map(scan.fields.map(item => [item.id, item]));
  const seen = new Set<string>();
  job.fields = row.fields.map((item, index) => {
    const selection = object(item, ['id', 'entity'], `Auftragsfeld ${index + 1}`);
    const id = text(selection.id, 'Feld-ID', 36, uuid);
    const entity = text(selection.entity, 'Feldtyp', 80);
    if (seen.has(id)) fail('Ein Feld ist im Auftrag doppelt enthalten.');
    seen.add(id);
    const target = scanFields.get(id);
    if (!target) fail('Ein Auftragsfeld ist im Scan nicht vorhanden.');
    if (!blindEntityAllowed(entity)) fail('Ein Feldtyp ist nicht zulässig.');
    if (!entityAvailable(entity, scan.availableEntities)) fail(`Für ${target.field} ist kein passender Wert im verschlüsselten Profil vorhanden.`);
    const base = entityBase(entity), targetBase = target.entity ? entityBase(target.entity) : '';
    if (((profileKeySensitive(base) && !CUSTOM_PROFILE_KEY.test(base)) || secrets.has(base)) && targetBase !== base) fail('Sensible Werte und Geheimnisse dürfen nur auf ihr exakt erkanntes Ziel abgebildet werden.');
    if ((target.sensitive || target.secret) && targetBase !== base) fail('Die Sensitivität eines Ziels kann nicht abgesenkt werden.');
    if (profileKeySensitive(base) && !job.options.sensitive) fail('Sensible Werte benötigen die ausdrückliche sensible Freigabe.');
    if (secrets.has(base) && !job.options.secrets) fail('Passwort und Einmalcode benötigen die ausdrückliche Geheimnis-Freigabe.');
    if (target.hasValue && !job.options.overwrite) fail('Befüllte Felder benötigen die ausdrückliche Überschreib-Freigabe.');
    return { id, entity };
  });
  if (job.options.submit) {
    const forms = new Set(job.fields.map(selection => scanFields.get(selection.id)!.form));
    if (forms.size !== 1) fail('Blindes Absenden ist nur für Felder genau eines HTML-Formulars zulässig.');
    const rows = job.fields.map(selection => scanFields.get(selection.id)!);
    if (rows.some(item => item.formMethod !== 'post')) fail('Blindes Absenden ist nur für POST-Formulare freigegeben.');
    if (rows.some(item => !item.formDestinations?.length || item.formDestinations.some(destination => destination !== scan.origin))) fail('Blindes Absenden verlangt ausschließlich zielgleiche Formularherkünfte.');
  }
  return job;
}

export function planBlindJob(scanInput: unknown, options: { submit?: boolean; overwrite?: boolean; choices?: boolean; mapping?: Readonly<Record<string, string>> } = {}): BlindJob {
  const scan = validateBlindScan(scanInput);
  const overwrite = options.overwrite === true;
  const fields: BlindSelection[] = [];
  for (const target of scan.fields) {
    const explicit = options.mapping?.[target.id];
    const entity = explicit || target.entity;
    if (!entity) continue;
    if (!explicit && (!entityAvailable(entity, scan.availableEntities) || target.hasValue && !overwrite)) continue;
    fields.push({ id: target.id, entity });
  }
  const byId = new Map(scan.fields.map(target => [target.id, target]));
  const job: BlindJob = {
    version: 1,
    kind: BLIND_JOB_KIND,
    scan: scan.scan,
    origin: scan.origin,
    href: scan.href,
    fields,
    options: {
      sensitive: fields.some(selection => profileKeySensitive(entityBase(selection.entity))),
      secrets: fields.some(selection => secrets.has(entityBase(selection.entity))),
      overwrite,
      choices: options.choices !== false,
      submit: options.submit === true,
    },
  };
  if (!fields.length) fail('Kein automatisch zuordenbares Feld gefunden.');
  if (job.options.submit && fields.some(selection => byId.get(selection.id)?.hasValue && !overwrite)) fail('Befüllte Felder verhindern blindes Absenden ohne Überschreibfreigabe.');
  return validateBlindJob(job, scan);
}

export function parseBlindJob(input: string, scan: BlindScan): BlindJob {
  if (input.length > 65_536) fail('Auftrag ist zu groß.');
  let value: unknown;
  try { value = JSON.parse(input); } catch { fail('Auftrag ist kein JSON-Objekt.'); }
  return validateBlindJob(value, scan);
}
export function blindScanText(scan: BlindScan): string {
  return JSON.stringify(validateBlindScan(scan), null, 2) + '\n';
}
