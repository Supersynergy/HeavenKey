/** Injected in frame 0 / ISOLATED after a popup gesture. No network or storage. */
import './vendor/extract.js';
import './vendor/fill.js';
import { PROFILE_KEYS, HIGH_FIELDS, CUSTOM_PROFILE_KEY, profileKeyAllowed } from '../../packages/forms/schema';
import { captureBoundary, sameBoundary, fieldGroup, secretDestinationAllowed, formPolicy, ownerForm } from './form-boundary';

type Entities = Record<string, string>;
type Field = { id: string; field: string; entity: string | null; score: number; hasValue: boolean; sensitive: boolean; secret: boolean; kind: string; form: string; maxLength?: number; formMethod?: string; formDestinations?: string[]; anchored?: boolean };
type Target = { el: HTMLElement; fingerprint: string; boundary: ReturnType<typeof captureBoundary>; field: Field };
type Request = { action: 'scan' | 'fill' | 'undo' | 'capture' | 'clear'; origin: string; href: string; scan?: string; entities?: Entities; selected?: { id: string; entity: string }[]; sensitive?: boolean; secrets?: boolean; overwrite?: boolean; choices?: boolean; generated?: boolean; anchor?: string; submit?: boolean };
const root = globalThis as any;
const P = root.HeavenKeyFieldPrimitives;
const EX = root.SmartFieldExtract;
const sentinel = Object.fromEntries([...PROFILE_KEYS, 'otp'].map(key => [key, '1']));
const high = new Set([...HIGH_FIELDS, 'ccExp', 'ccHolder', 'blz', 'accountHolder', 'bankName', 'mandatsref', 'creditorId']);
const secret = new Set(['password', 'otp']);
const consent = /consent|terms|condition|privacy|cookie|newsletter|subscribe|marketing|payment|paymethod|zahlungsart|zahlungsmethode|lastschrift|sepa|agb|datenschutz|einwillig|zustimm|widerruf|akzeptier/i;
const acMap: Record<string, string> = { 'one-time-code': 'otp', 'current-password': 'password', 'new-password': 'password', 'cc-name': 'ccHolder', 'cc-exp': 'ccExp', 'cc-exp-month': 'cc_month', 'cc-exp-year': 'cc_year', 'cc-csc': 'cvc', 'cc-number': 'creditcard' };
const base = (key: string): string => key.startsWith('bday_') ? 'birthdate' : key === 'cc_month' || key === 'cc_year' || key === 'cc_exp' ? 'ccExp' : key === 'cc_csc' ? 'cvc' : key;
const allowed = (key: string) => profileKeyAllowed(base(key)) || key === 'otp';
const text = (el: any): string => el.isContentEditable ? el.innerText : el.getAttribute('role') === 'listbox' ? [...el.querySelectorAll('[aria-selected="true"]')].map((o: any) => o.textContent).join(', ') : el.getAttribute('role') === 'combobox' && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.textContent || '' : el.value ?? '';
const hasValue = (el: any) => ['checkbox','radio'].includes(el.type) ? !!el.checked : !!text(el).trim();
const fingerprint = (el: any) => [el.tagName, el.type, el.id, el.name, el.getAttribute('autocomplete'), P.tokens(el)].join('|');
function safePage(req: Request) {
  if (window.top !== window || location.origin !== req.origin || location.href !== req.href) throw new Error('Die Zielseite hat sich geändert. Bitte erneut prüfen.');
  const url = new URL(location.href);
  if (url.username || url.password) throw new Error('Zieladressen mit eingebetteter Anmeldung sind gesperrt.');
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
    ccHolder: /karteninhaber|card ?holder|name on card/i, steuernr: /\bsteuernummer\b|\bsteuer[\s-]*nr\b|\btax[\s-]*number\b/i,
    steuerid: /\bsteuer[\s-]*id\b|\btax[\s-]*id\b|\bsteuerliche[\s-]+identifikationsnummer\b|\bsteueridentifikationsnummer\b|\bidnr\b/i, vat: /\bvat\b|\bumsatzsteuer[\s-]*(?:id|identifikationsnummer)\b|\bust[\s-]*id[\s-]*(?:nr)?\b/i, perso: /personalausweis|passport|identity ?card|reisepass/i,
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
function submitControls(form: HTMLFormElement): (HTMLButtonElement | HTMLInputElement)[] {
  return [...form.querySelectorAll<HTMLElement>('button,input')]
    .filter(el => P.visible(el) && !(el as HTMLButtonElement).disabled && ownerForm(el) === form)
    .filter(el => el instanceof HTMLButtonElement && (!el.type || el.type === 'submit') || el instanceof HTMLInputElement && ['submit', 'image'].includes(el.type)) as (HTMLButtonElement | HTMLInputElement)[];
}
function validateSubmitPlan(elements: HTMLElement[], origin: string): HTMLFormElement {
  if (!elements.length) throw new Error('Ohne ausgewählte Felder wird nicht abgesendet.');
  const form = ownerForm(elements[0]);
  if (!form || elements.some(el => ownerForm(el) !== form)) throw new Error('Abgesendet wird nur ein vollständig zusammenhängendes HTML-Formular.');
  if (!elements.every(el => secretDestinationAllowed(el, origin))) throw new Error('Formularziele müssen exakt auf der freigegebenen Herkunft bleiben.');
  const policy = formPolicy(elements[0]);
  if (policy?.method !== 'post' || !policy.destinationOrigins.length || policy.destinationOrigins.some(destination => destination !== origin)) throw new Error('Blindes Absenden ist nur für zielgleiche POST-Formulare freigegeben.');
  if ((form.getAttribute('target') || '_self').toLowerCase() !== '_self') throw new Error('Blindes Absenden ist nur im selben Browsing-Kontext freigegeben.');
  const submitters = submitControls(form);
  if (submitters.length !== 1) throw new Error('Blindes Absenden verlangt genau einen sichtbaren Absende-Button.');
  const submitter = submitters[0];
  if ((submitter.getAttribute('formmethod') || 'post').toLowerCase() !== 'post') throw new Error('Absende-Buttons mit abweichender Methode sind gesperrt.');
  if (submitter.hasAttribute('formnovalidate')) throw new Error('Absende-Buttons ohne Validierung sind gesperrt.');
  if ((submitter.getAttribute('formtarget') || '_self').toLowerCase() !== '_self') throw new Error('Absende-Buttons mit abweichendem Zielkontext sind gesperrt.');
  return form;
}
function submitFilledForm(elements: HTMLElement[], origin: string): boolean {
  const form = validateSubmitPlan(elements, origin);
  if (!form.checkValidity()) return false;
  let submitEvent: SubmitEvent | null = null;
  form.addEventListener('submit', event => { submitEvent = event; }, { once: true });
  form.requestSubmit(submitControls(form)[0]);
  return !!submitEvent;
}

function makeEngine() {
  let targets = new Map<string, Target>(), scan = '', href = '', expires = 0, scanAnchor: string | undefined;
  let undo: { href: string; expires: number; rows: { el: any; value: string; checked: boolean; fingerprint: string; after: string; afterChecked: boolean; aria?: { el: Element; value: string | null }[] }[] }[] = [];
  const clear = () => { targets.clear(); scan = ''; href = ''; expires = 0; scanAnchor = undefined; undo = []; };
  addEventListener('pagehide', clear);
  return (req: Request) => {
    safePage(req);
    if (req.action === 'clear') { clear(); return { cleared: true }; }
    const anchor = req.anchor ? root.__heavenkeyInlineTarget : null;
    if (req.anchor && req.action !== 'undo' && (!anchor || anchor.token !== req.anchor || anchor.href !== location.href ||
      anchor.expires <= Date.now() || typeof anchor.valid !== 'function' || !anchor.valid() || !usable(anchor.el))) {
      throw new Error('Der Feldklick ist abgelaufen oder das Formular wurde geändert. Erneut auf den Schlüssel klicken.');
    }
    if (req.action === 'scan' || req.action === 'capture') {
      targets = new Map(); scan = crypto.randomUUID(); href = location.href; expires = Date.now() + 120000; scanAnchor = req.anchor;
      const fields: Field[] = [], captured: Entities = {}, forms=new Map<Node,string>();
      const candidates = P.allFields();
      let inspected = 0;
      for (const el of candidates.slice(0, 500)) {
        inspected++;
        if (!usable(el)) continue;
        if (anchor && (fieldGroup(el) !== fieldGroup(anchor.el) || el.getRootNode() !== anchor.el.getRootNode())) continue;
        const match = identify(el), key = match.entity, id = crypto.randomUUID();
        const form=fieldGroup(el);
        if(!forms.has(form)) forms.set(form,crypto.randomUUID());
        const field: Field = { id, field: (P.labelText(el) || el.name || el.id || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 120), entity: key, score: match.score, hasValue: hasValue(el), sensitive: !!key && high.has(base(key)), secret: !!key && secret.has(base(key)), kind: /\bnew-password\b/i.test(el.autocomplete || '') ? 'new-password' : el.type || el.tagName.toLowerCase(), form:forms.get(form)! };
        field.maxLength = el.maxLength >= 0 ? el.maxLength : undefined;
        const policy = formPolicy(el);
        if (policy) { field.formMethod = policy.method; field.formDestinations = policy.destinationOrigins; }
        field.anchored = !!req.anchor && anchor?.token === req.anchor && anchor.el === el && anchor.href === location.href && anchor.expires > Date.now();
        targets.set(id, { el, fingerprint: fingerprint(el), boundary: captureBoundary(el), field }); fields.push(field);
        if (req.action === 'capture' && key && !secret.has(base(key)) && (!high.has(base(key)) || req.sensitive) && (!high.has(base(key)) || exactSensitive(el, key)) && !['checkbox','radio'].includes(el.type)) {
          const value = text(el).trim(); if (value && value.length <= 10000 && profileKeyAllowed(key) && !captured[key]) captured[key] = value;
        }
        if (fields.length === 200) break;
      }
      const coverage = {
        inspected, eligible: fields.length,
        truncated: candidates.length > 500 || fields.length === 200,
        frames: document.querySelectorAll('iframe,frame').length,
        fileInputs: candidates.filter((el: HTMLInputElement) => el.type === 'file').length,
        unknown: fields.filter(field => !field.entity).length,
      };
      return { scan, href, origin: location.origin, fields, coverage, ...(req.action === 'capture' ? { entities: captured } : {}) };
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
    if (req.action !== 'fill' || !scan || req.scan !== scan || href !== location.href || Date.now() >= expires || req.anchor !== scanAnchor) throw new Error('Die Vorschau ist abgelaufen. Bitte erneut prüfen.');
    if (!req.selected?.length || req.selected.length > 200 || !req.entities || Object.values(req.entities).some(v => typeof v !== 'string' || v.length > 10000)) throw new Error('Ungültige Feldauswahl.');
    const rows: any[] = [], blocked: string[] = [], written: HTMLElement[] = [];
    const planned = req.selected.map(selection => {
      const target = targets.get(selection.id), key = selection.entity;
      if (!target || !allowed(key) || !usable(target.el) || fingerprint(target.el) !== target.fingerprint || !sameBoundary(target.el, target.boundary)) throw new Error('Ein Feld oder Formularziel hat sich geändert. Bitte erneut prüfen.');
      const el: any = target.el, original = target.field.entity;
      if (secret.has(base(key)) && target.field.kind === 'new-password' && !(req.generated && key === 'password')) { blocked.push(target.field.field); return null; }
      if (req.generated && key === 'password' && target.field.kind !== 'new-password') { blocked.push(target.field.field); return null; }
      if (secret.has(base(key)) && !secretDestinationAllowed(el, req.origin)) { blocked.push(target.field.field); return null; }
      // Re-mapping cannot downgrade the sensitivity of the actual target.
      if ((original && (high.has(base(original)) || secret.has(base(original))) && base(original) !== base(key)) || ((high.has(base(key)) || CUSTOM_PROFILE_KEY.test(base(key))) && (!req.sensitive || (!CUSTOM_PROFILE_KEY.test(base(key)) && !exactSensitive(el, key)))) || (secret.has(base(key)) && (!req.secrets || !exactSensitive(el, key)))) { blocked.push(target.field.field); return null; }
      if (hasValue(el) && !req.overwrite) return null;
      if (['checkbox','radio'].includes(el.type) && (!req.choices || consent.test(P.tokens(el)))) return null;
      const bp = P.bdayParts(req.entities), value = P.resolveValue(key, req.entities, bp, el);
      if (!value) return null;
      if (el.maxLength >= 0 && value.length > el.maxLength) { blocked.push(target.field.field); return null; }
      return { el, value, target };
    });
    if (req.submit === true) {
      if (planned.some(item => !item)) throw new Error('Blindes Absenden verlangt, dass jedes ausgewählte Feld eindeutig ausführbar ist.');
      validateSubmitPlan(planned.map(item => item!.el), req.origin);
    }
    // Consume before dispatching input events: page listeners cannot replay a scan.
    targets.clear(); scan = ''; expires = 0;
    for (const item of planned) {
      if (!item) continue;
      safePage(req);
      const { el, value, target } = item;
      if (!usable(el) || fingerprint(el) !== target.fingerprint || !sameBoundary(el, target.boundary)) { blocked.push(target.field.field); break; }
      // A previous field's input handler may have changed this field in the meantime.
      if (hasValue(el) && !req.overwrite) continue;
      if (el.maxLength >= 0 && value.length > el.maxLength || secret.has(base(target.field.entity || '')) && !secretDestinationAllowed(el, req.origin)) { blocked.push(target.field.field); break; }
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
      written.push(el);
    }
    if (rows.length) { undo = undo.filter(item => item.expires > Date.now()).slice(-4); undo.push({ href, expires: Date.now() + 120000, rows }); setTimeout(() => { undo = undo.filter(item => item.expires > Date.now()); }, 120100); }
    targets.clear(); scan = '';
    const submitted = req.submit === true && written.length === planned.length ? (safePage(req), submitFilledForm(written, req.origin)) : false;
    return { count: rows.length, blocked, submitted };
  };
}
root.__heavenkeyEngine ||= makeEngine();
