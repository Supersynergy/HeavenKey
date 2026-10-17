/** Injected in frame 0 / ISOLATED after a popup gesture. No network or storage. */
import './vendor/extract.js';
import './vendor/fill.js';
import { PROFILE_KEYS, HIGH_FIELDS } from '../../packages/forms/schema';

type Entities = Record<string, string>;
type Field = { id: string; field: string; entity: string | null; score: number; hasValue: boolean; sensitive: boolean; secret: boolean; kind: string };
type Target = { el: HTMLElement; fingerprint: string; field: Field };
type Request = { action: 'scan' | 'fill' | 'undo' | 'capture' | 'clear'; origin: string; href: string; scan?: string; entities?: Entities; selected?: { id: string; entity: string }[]; sensitive?: boolean; secrets?: boolean; overwrite?: boolean; choices?: boolean };
const root = globalThis as any;
const P = root.HeavenKeyFieldPrimitives;
const EX = root.SmartFieldExtract;
const sentinel = Object.fromEntries([...PROFILE_KEYS, 'otp'].map(key => [key, '1']));
const high = new Set([...HIGH_FIELDS, 'ccExp', 'ccHolder', 'blz', 'accountHolder', 'bankName', 'mandatsref', 'creditorId']);
const secret = new Set(['password', 'otp']);
const consent = /consent|terms|condition|privacy|cookie|newsletter|subscribe|marketing|payment|paymethod|zahlungsart|zahlungsmethode|lastschrift|sepa|agb|datenschutz|einwillig|zustimm|widerruf|akzeptier/i;
const acMap: Record<string, string> = { 'one-time-code': 'otp', 'current-password': 'password', 'new-password': 'password', 'cc-name': 'ccHolder', 'cc-exp': 'ccExp', 'cc-exp-month': 'cc_month', 'cc-exp-year': 'cc_year', 'cc-csc': 'cvc', 'cc-number': 'creditcard' };
const base = (key: string): string => key.startsWith('bday_') ? 'birthdate' : key === 'cc_month' || key === 'cc_year' || key === 'cc_exp' ? 'ccExp' : key === 'cc_csc' ? 'cvc' : key;
const allowed = (key: string) => PROFILE_KEYS.includes(base(key) as any) || key === 'otp';
const text = (el: any): string => el.isContentEditable ? el.innerText : el.getAttribute('role') === 'listbox' ? [...el.querySelectorAll('[aria-selected="true"]')].map((o: any) => o.textContent).join(', ') : el.getAttribute('role') === 'combobox' && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.textContent || '' : el.value ?? '';
const hasValue = (el: any) => ['checkbox','radio'].includes(el.type) ? !!el.checked : !!text(el).trim();
const fingerprint = (el: any) => [el.tagName, el.type, el.id, el.name, el.getAttribute('autocomplete'), P.tokens(el)].join('|');
function safePage(req: Request) {
  if (window.top !== window || location.origin !== req.origin || location.href !== req.href) throw new Error('Die Zielseite hat sich geändert. Bitte erneut prüfen.');
  const url = new URL(location.href);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Nur HTTPS-Seiten und lokale Testseiten sind erlaubt.');
}
function usable(el: any) {
  if (!el.isConnected || P.disabled(el) || el.readOnly || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-readonly') === 'true' || ['hidden','submit','button','image','file','reset','color'].includes(el.type) || !P.visible(el)) return false;
  if (el.getAttribute('autocomplete')?.split(/\s+/).includes('off')) return false;
  let node: any = el;
  while (node) {
    const style = getComputedStyle(node);
    if (node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    node = node.parentElement || node.getRootNode()?.host;
  }
  const rect = el.getBoundingClientRect();
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left > Math.max(innerWidth, document.documentElement.scrollWidth) || rect.top > Math.max(innerHeight, document.documentElement.scrollHeight)) return false;
  if ((['checkbox','radio'].includes(el.type) || el.tagName === 'SELECT' || ['combobox','listbox'].includes(el.getAttribute('role'))) && consent.test(P.tokens(el))) return false;
  return true;
}
function identify(el: any): { entity: string | null; score: number } {
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  for (const token of ac) if (acMap[token]) return { entity: acMap[token], score: 100 };
  if (el.type === 'password') return { entity: 'password', score: 100 };
  // Classify the actual target independently of the chosen payload. Generic
  // name/number anchors must never hide financial or identity field types.
  for (const key of [...high, 'password', 'otp']) if (exactSensitive(el, key)) return { entity: key, score: 95 };
  if (el.type === 'number' && EX.ENTITY_ANCHORS.amount.test(P.tokens(el))) return { entity:'amount',score:95 };
  if (el.type === 'date' && !/birth|geburt|\bdob\b/i.test(P.tokens(el))) return { entity:'date',score:90 };
  const scored = P.scoreField(el, sentinel, P.bdayParts({ birthdate: '2000-01-02' }));
  return scored?.entity && allowed(scored.entity) ? scored : { entity: null, score: 0 };
}
function exactSensitive(el: any, entity: string) {
  const key = base(entity), ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  if (ac.some((token: string) => base(acMap[token] || '') === key)) return true;
  const exact: Record<string, RegExp> = {
    iban: /\biban\b/i, bic: /\bbic\b|\bswift\b/i, creditcard: /credit ?card|kreditkarte|card ?number|kartennummer/i,
    cvc: /\bcvc\b|\bcvv\b|\bcsc\b|kartenprüfnummer/i, ccExp: /kartenablauf|card ?exp|cc ?exp|expiry|ablaufdatum/i,
    ccHolder: /karteninhaber|card ?holder|name on card/i, steuernr: /steuernummer|steuer ?nr|tax ?number/i,
    steuerid: /steuer ?id|tax ?id/i, perso: /personalausweis|passport|identity ?card|reisepass/i,
    sozialvers: /sozialversicherung|social ?security|\bssn\b/i, gkv: /krankenversicherung|versichertennummer|\bkvnr\b|\bgkv\b/i,
    ahv: /\bahv\b/i, konfession: /konfession|religion|denomination/i, blz: /\bblz\b|bankleitzahl|sort ?code/i,
    accountHolder: /kontoinhaber|account ?holder/i, bankName: /bankname|bank ?name|name der bank|kreditinstitut/i,
    mandatsref: /mandatsreferenz|mandate ?reference/i, creditorId: /gläubiger ?id|creditor ?id/i,
    password: /passwort|password|kennwort/i, otp: /\botp\b|one ?time|einmalcode|bestätigungscode/i,
  };
  return (key === 'password' && el.type === 'password') || !!exact[key]?.test(P.tokens(el));
}
function choices(el: any, value: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const valueNorm = norm(value), label = norm(P.labelText(el) || el.value || (el.getAttribute('role') === 'option' ? el.textContent : '') || '');
  const aliases = P.SALUTATIONS[value.toLowerCase()] || P.COUNTRIES[value.toLowerCase()] || [];
  return !!label && (label === valueNorm || norm(el.value || '') === valueNorm || aliases.some((s: string) => norm(s) === label));
}
function makeEngine() {
  let targets = new Map<string, Target>(), scan = '', href = '';
  let undo: { href: string; expires: number; rows: { el: any; value: string; checked: boolean; fingerprint: string; after: string; afterChecked: boolean; aria?: { el: Element; value: string | null }[] }[] }[] = [];
  const clear = () => { targets.clear(); scan = ''; href = ''; undo = []; };
  addEventListener('pagehide', clear);
  return (req: Request) => {
    safePage(req);
    if (req.action === 'clear') { clear(); return { cleared: true }; }
    if (req.action === 'scan' || req.action === 'capture') {
      targets = new Map(); scan = crypto.randomUUID(); href = location.href;
      const fields: Field[] = [], captured: Entities = {};
      for (const el of P.allFields().slice(0, 500)) {
        if (!usable(el)) continue;
        const match = identify(el), key = match.entity, id = crypto.randomUUID();
        const field: Field = { id, field: (P.labelText(el) || el.name || el.id || el.tagName).trim().slice(0, 120), entity: key, score: match.score, hasValue: hasValue(el), sensitive: !!key && high.has(base(key)), secret: !!key && secret.has(base(key)), kind: el.type || el.tagName.toLowerCase() };
        targets.set(id, { el, fingerprint: fingerprint(el), field }); fields.push(field);
        if (req.action === 'capture' && key && !secret.has(base(key)) && (!high.has(base(key)) || req.sensitive) && (!high.has(base(key)) || exactSensitive(el, key)) && !['checkbox','radio'].includes(el.type)) {
          const value = text(el).trim(); if (value && value.length <= 10000 && PROFILE_KEYS.includes(key as any) && !captured[key]) captured[key] = value;
        }
        if (fields.length === 200) break;
      }
      return { scan, href, origin: location.origin, fields, ...(req.action === 'capture' ? { entities: captured } : {}) };
    }
    if (req.action === 'undo') {
      const item = undo.pop();
      if (!item || item.href !== location.href || Date.now() > item.expires) return { count: 0 };
      let count = 0;
      for (const row of [...item.rows].reverse()) {
        const el = row.el;
        if (!usable(el) || fingerprint(el) !== row.fingerprint || text(el) !== row.after || !!el.checked !== row.afterChecked) continue;
        if (['checkbox','radio'].includes(el.type)) { el.checked = row.checked; P.fireSet(el, row.value); }
        else if (row.aria) { for (const option of row.aria) { if (option.value === null) option.el.removeAttribute('aria-selected'); else option.el.setAttribute('aria-selected',option.value); } P.fireSet(el,row.value); }
        else if (el.getAttribute('role') === 'combobox' && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { el.textContent = row.value; P.fireSet(el,row.value); }
        else if (el.isContentEditable) { el.innerText = row.value; P.fireSet(el,row.value); }
        else {
          const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,row.value); P.fireSet(el,row.value);
        }
        count++;
      }
      return { count };
    }
    if (req.action !== 'fill' || req.scan !== scan || href !== location.href) throw new Error('Die Vorschau ist abgelaufen. Bitte erneut prüfen.');
    if (!req.selected?.length || req.selected.length > 200 || !req.entities || Object.values(req.entities).some(v => typeof v !== 'string' || v.length > 10000)) throw new Error('Ungültige Feldauswahl.');
    const rows: any[] = [], blocked: string[] = [];
    const planned = req.selected.map(selection => {
      const target = targets.get(selection.id), key = selection.entity;
      if (!target || !allowed(key) || !usable(target.el) || fingerprint(target.el) !== target.fingerprint) throw new Error('Ein Feld hat sich geändert. Bitte erneut prüfen.');
      const el: any = target.el, original = target.field.entity;
      // Re-mapping cannot downgrade the sensitivity of the actual target.
      if ((original && (high.has(base(original)) || secret.has(base(original))) && base(original) !== base(key)) || (high.has(base(key)) && (!req.sensitive || !exactSensitive(el, key))) || (secret.has(base(key)) && (!req.secrets || !exactSensitive(el, key)))) { blocked.push(target.field.field); return null; }
      if (hasValue(el) && !req.overwrite) return null;
      if (['checkbox','radio'].includes(el.type) && (!req.choices || consent.test(P.tokens(el)))) return null;
      const bp = P.bdayParts(req.entities), value = P.resolveValue(key, req.entities, bp, el);
      if (!value) return null;
      return { el, value, target };
    });
    for (const item of planned) {
      if (!item) continue;
      safePage(req);
      const { el, value, target } = item;
      if (!usable(el) || fingerprint(el) !== target.fingerprint) break;
      const old = { el, value: text(el), checked: !!el.checked, fingerprint: target.fingerprint };
      if (['checkbox','radio'].includes(el.type)) {
        if (!choices(el, value)) continue;
        if (el.type === 'radio' && el.name) for (const sibling of P.allFields()) {
          if (sibling !== el && sibling.type === 'radio' && sibling.name === el.name && sibling.form === el.form && sibling.getRootNode() === el.getRootNode() && sibling.checked) rows.push({ el:sibling, value:text(sibling), checked:true, fingerprint:fingerprint(sibling), after:text(sibling), afterChecked:false });
        }
        el.checked = true; P.fireSet(el, value);
      } else if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
        if (!P.setValue(el, value)) continue;
      } else if (el.getAttribute('role') === 'combobox') { el.textContent = value; P.fireSet(el, value); }
      else if (el.getAttribute('role') === 'listbox') {
        const options = [...el.querySelectorAll('[role="option"]')] as HTMLElement[];
        const option = options.find(o => choices(o,value));
        if (!option) continue;
        (old as any).aria = options.map(o => ({ el:o, value:o.getAttribute('aria-selected') }));
        for (const o of options) o.setAttribute('aria-selected',String(o === option));
        P.fireSet(el,value);
      }
      else continue;
      rows.push({ ...old, after: text(el), afterChecked: !!el.checked });
    }
    if (rows.length) { undo = undo.filter(item => item.expires > Date.now()).slice(-4); undo.push({ href, expires: Date.now() + 120000, rows }); setTimeout(() => { undo = undo.filter(item => item.expires > Date.now()); }, 120100); }
    targets.clear(); scan = '';
    return { count: rows.length, blocked };
  };
}
root.__heavenkeyEngine ||= makeEngine();
