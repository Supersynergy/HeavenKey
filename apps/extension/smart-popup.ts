import './vendor/extract.js';
import { openVault, sealVault, validateEnvelope, totp, type Vault, type Envelope } from '../web/src/passwords-crypto';
import { PROFILE_KEYS, HIGH_FIELDS, validateProfiles, type FormProfile } from '../../packages/forms/schema';
import { generateChannel, channelCode, openUnlock, validateRequest, type UnlockRequest } from './unlock-channel';
const extension = (globalThis as any).browser || (globalThis as any).chrome;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const labels: Record<string,string> = { accountHolder:'Kontoinhaber',address2:'Adresszusatz',ahv:'AHV-Nummer',amount:'Betrag',bankName:'Bankname',bic:'BIC',birthdate:'Geburtsdatum',blz:'Bankleitzahl',caseno:'Aktenzeichen',ccExp:'Kartenablauf',ccHolder:'Karteninhaber',city:'Ort',company:'Firma',contractno:'Vertragsnummer',country:'Land',creditcard:'Kartennummer',creditorId:'Gläubiger-ID',currency:'Währung',customerno:'Kundennummer',cvc:'Kartenprüfnummer',date:'Datum',email:'E-Mail',familienstand:'Familienstand',firstName:'Vorname',geburtsname:'Geburtsname',geburtsort:'Geburtsort',gkv:'Krankenversicherung',houseNumber:'Hausnummer',hrb:'Handelsregister',iban:'IBAN',jobTitle:'Beruf / Position',konfession:'Konfession',language:'Sprache',lastName:'Nachname',mandatsref:'Mandatsreferenz',memberno:'Mitgliedsnummer',message:'Nachricht',name:'Name',nationality:'Staatsangehörigkeit',number:'Nummer',password:'Passwort',perso:'Ausweisnummer',phone:'Telefon',postbox:'Postfach',purpose:'Verwendungszweck',salutation:'Anrede',sozialvers:'Sozialversicherung',state:'Bundesland',steuerid:'Steuer-ID',steuernr:'Steuernummer',street:'Straße und Hausnummer',streetName:'Straße',subject:'Betreff',title:'Titel',url:'Webseite',username:'Benutzername',vat:'Umsatzsteuer-ID',zip:'Postleitzahl',otp:'Einmalcode',bday_day:'Geburtstag (Tag)',bday_month:'Geburtstag (Monat)',bday_year:'Geburtstag (Jahr)',cc_exp:'Kartenablauf',cc_month:'Kartenablauf (Monat)',cc_year:'Kartenablauf (Jahr)' };
type Connection = { origin: string; token: string };
type ExtendedVault = Vault & { profiles?: FormProfile[] };
type Field = { id: string; field: string; entity: string | null; score: number; hasValue: boolean; sensitive: boolean; secret: boolean; kind: string; form: string };
let connection: Connection | null = null, key: CryptoKey | null = null, vault: ExtendedVault | null = null, envelope: Envelope | null = null;
let revision = 0, epoch = 0, busy = false, lastActivity = Date.now(), entities: Record<string,string> = {}, sourceLogin: any = null, sourceProfile: FormProfile | null = null;
let pageTarget: { id: number; origin: string; href: string } | null = null, preview: { scan: string; fields: Field[] } | null = null;
let siteOrigin = '', pendingUnlock: {request: UnlockRequest; privateKey: CryptoKey; expires: number} | null = null;
let nextFocus: HTMLElement | null=null;
function focusAfter(control: HTMLElement) { if(busy) nextFocus=control;else control.focus(); }
const button = (label: string, fn: () => void, kind = 'secondary') => { const b = document.createElement('button'); b.type = 'button'; b.className = kind; b.textContent = label; b.addEventListener('click', () => { if (!busy) fn(); }); return b; };
function status(message: string, error = false) { $('smart-status').textContent = message; $('smart-status').dataset.error = String(error); }
function resetPreview() { preview = null; $('field-map').replaceChildren(); $('fill-confirmation').hidden = true; input('confirm-origin').checked = false; }
function resetSource() { $('quick-login').hidden=true; entities = {}; sourceLogin = null; sourceProfile = null; $('entity-preview').replaceChildren(); input('source-text').value = ''; input('profile-title').value = ''; input('include-sensitive').checked = false; input('include-secrets').checked = false; input('overwrite').checked = false; input('include-choices').checked = false; resetPreview(); }
function lock(message = 'Tresor gesperrt.') {
  nextFocus=null;
  const pending=pendingUnlock; pendingUnlock=null; $('complete-passkey').hidden=true; $('passkey-code').textContent='';
  if(pending && connection) void api('/api/password-vault/extension/unlock/cancel',{id:pending.request.id}).catch(()=>console.warn('HeavenKey: Abbruch beim Dienst nicht bestätigt; die Anfrage läuft nach spätestens 90 Sekunden ab.'));
  epoch++; key = null; vault = null; envelope = null; resetSource(); input('extension-master').value = ''; input('vault-search').value = ''; $('source-list').replaceChildren(); $('smart-workspace').hidden = true; $('unlock-form').hidden = !connection; $('lock-extension').hidden = true; status(message);
}
function connected() { $('pairing-form').hidden = !!connection; $('disconnect').hidden = !connection; $('unlock-form').hidden = !connection || !!key; $('connection-label').textContent = connection ? `Verbunden · ${connection.origin}` : 'Noch nicht verbunden'; }
async function disconnect(message = 'Verbindung getrennt. Erneut mit dem Programm koppeln.') { lock(message); connection = null; await extension.storage.local.remove('heavenkey.extension.v1'); connected(); }
function validConnection(value: unknown): value is Connection {
  if (!value || typeof value !== 'object') return false;
  const c = value as Connection;
  try { const url = new URL(c.origin); return url.protocol === 'http:' && url.hostname === 'localhost' && url.origin === c.origin && typeof c.token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(c.token); } catch { return false; }
}
async function api(path: string, body?: unknown) {
  if (!connection) throw new Error('Bitte zuerst koppeln.');
  const activeConnection = connection;
  const response = await fetch(activeConnection.origin + path, { method: body ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { 'X-HeavenKey-Client': 'password-extension', 'X-HeavenKey-Token': activeConnection.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 403 && path.includes('/extension/unlock/') && (await response.clone().json()).error==='extension_unlock_unavailable') throw Error('Passkey-Anfrage abgelaufen oder Tresor geändert. Erneut starten oder Masterpasswort verwenden.');
  if (response.status === 401 || response.status === 403) { await disconnect('Kopplung widerrufen oder Programm neu gestartet. Bitte erneut koppeln.'); throw new Error('Die Kopplung ist nicht mehr gültig.'); }
  if (response.status === 409) { lock('Speicherkonflikt. Erneut entsperren und die Änderung wiederholen.'); throw new Error('Der Tresor wurde inzwischen geändert.'); }
  if (!response.ok) throw new Error(`Lokales Programm antwortet mit ${response.status}.`);
  const data = await response.json();
  if (connection !== activeConnection) throw new Error('Die Verbindung hat sich geändert.');
  return data;
}
function snapshot(value: any) {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || !('record' in value)) throw new Error('Ungültige Tresorantwort.');
  return { revision: value.revision as number, record: value.record === null ? null : validateEnvelope(value.record) };
}
async function run(fn: (generation: number) => Promise<void>) {
  if (busy) return;
  busy = true; const generation = epoch;
  const controls = [...$('smart-workspace').querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea')].map(control => ({ control, disabled: control.disabled }));
  for (const { control } of controls) control.disabled = true;
  $('smart').setAttribute('aria-busy','true');
  try { await fn(generation); }
  catch (error) { if (generation === epoch) status(error instanceof Error ? error.message : 'Aktion fehlgeschlagen.',true); }
  finally { for (const { control, disabled } of controls) control.disabled = disabled; busy = false; $('smart').setAttribute('aria-busy','false'); if(generation===epoch && nextFocus?.isConnected) nextFocus.focus();nextFocus=null; }
}
function active(generation: number) { if (generation !== epoch) throw new Error('Die Sitzung wurde gesperrt.'); }
function renderSources() {
  if (!vault) return;
  const query = input('vault-search').value.trim().toLowerCase(), list = $('source-list'); list.replaceChildren();
  const profiles = vault.profiles || [];
  const intent=new URL(location.href).searchParams.get('intent');
  const matches=(entry: any)=>{ try{return new URL(entry.url).origin===siteOrigin;}catch{return false;} };
  const logins=[...vault.entries].sort((a,b)=>Number(matches(b))-Number(matches(a)) || a.title.localeCompare(b.title));
  for (const entry of [...logins.map(v => ({ v, kind: 'login' })), ...profiles.map(v => ({ v, kind: 'profile' }))]) {
    if(intent==='template' && entry.kind!=='profile') continue;
    if (!JSON.stringify({ title: entry.v.title, username: (entry.v as any).username, entities: entry.kind === 'profile' ? (entry.v as FormProfile).entities : undefined }).toLowerCase().includes(query)) continue;
    const b = button(`${entry.kind === 'login' ? matches(entry.v) ? 'Diese Seite' : 'Andere Seite' : 'Vorlage'} · ${entry.v.title}`, () => {
      resetSource();
      if (entry.kind === 'login') {
        sourceLogin = entry.v;
        entities = { username: (entry.v as any).username, email: (entry.v as any).username, password: (entry.v as any).password };
        status('Login gewählt. Füllen ist nur auf seiner exakt gespeicherten Herkunft erlaubt.');
      } else { sourceProfile = entry.v as FormProfile; entities = { ...sourceProfile.entities }; input('profile-title').value = sourceProfile.title; status('Profil gewählt. Prüfe die Werte und die Zielseite.'); }
      renderEntities();
      $('quick-login').hidden=entry.kind!=='login' || !matches(entry.v);
      if(entry.kind==='login' && matches(entry.v)) $('quick-login').textContent=`Login auf ${siteOrigin} prüfen`;
    });
    b.dataset.kind = entry.kind; b.dataset.id = entry.v.id; list.append(b);
  }
  if (!list.childElementCount) { const p = document.createElement('p'); p.className = 'note'; p.textContent = 'Keine passenden Einträge. Profile kannst du aus einem Text oder einem Formular erstellen.'; list.append(p); }
}
function renderEntities() {
  const list = $('entity-preview'); list.replaceChildren(); resetPreview();
  for (const [name,value] of Object.entries(entities)) {
    if (!PROFILE_KEYS.includes(name as any) && name !== 'otp') continue;
    const label = document.createElement('label'); label.className = 'entity-row'; label.textContent = (labels[name] || name) + (HIGH_FIELDS.has(name) ? ' · sensibel' : '');
    const field = document.createElement('input'); field.value = value; field.dataset.entity = name; field.maxLength = 10000; field.autocomplete = 'off'; field.type = ['password','otp'].includes(name) ? 'password' : 'text'; field.addEventListener('input', () => { entities[name] = field.value; resetPreview(); }); label.append(field); list.append(label);
  }
}
async function acceptOpened(opened: Awaited<ReturnType<typeof openVault>>, nextRevision: number, generation: number) {
  active(generation); validateProfiles((opened.vault as ExtendedVault).profiles || []);
  const pending=pendingUnlock;pendingUnlock=null;$('complete-passkey').hidden=true;$('passkey-code').textContent='';
  if(pending) {await api('/api/password-vault/extension/unlock/cancel',{id:pending.request.id});active(generation);}
  key=opened.key;vault=opened.vault;envelope=opened.envelope;revision=nextRevision;lastActivity=Date.now();
  try { siteOrigin=(await target()).origin; } catch { siteOrigin=''; }
  active(generation); $('site-origin').textContent=siteOrigin || 'Öffne HeavenKey auf einer HTTPS-Webseite.';
  connected();$('smart-workspace').hidden=false;$('lock-extension').hidden=false;renderSources();status('Entsperrt. Passende Logins stehen oben, gespeicherte Profile dienen als Vorlagen.');focusAfter(input('vault-search'));
}
async function target() {
  const param = new URL(location.href).searchParams.get('target');
  let tab;
  if (param && /^\d+$/.test(param)) tab = await extension.tabs.get(Number(param));
  else [tab] = await extension.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error('Öffne HeavenKey über sein Symbol auf der Zielseite.');
  const url = new URL(tab.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Füllen ist nur auf HTTPS-Seiten und lokalen Testseiten erlaubt.');
  if (url.username || url.password) throw new Error('Zieladressen mit eingebetteter Anmeldung sind gesperrt.');
  if (sourceLogin) {
    let loginOrigin = ''; try { loginOrigin = new URL(sourceLogin.url).origin; } catch { /* Empty or malformed URLs cannot authorize login fills. */ }
    if (url.origin !== loginOrigin) throw new Error('Dieser Login gehört zu einer anderen Herkunft. Schema, Host und Port müssen genau übereinstimmen.');
  }
  return { id: tab.id as number, href: tab.url as string, origin: url.origin };
}
async function inject(target: { id: number; href: string; origin: string }, action: string, generation: number, args = {}) {
  active(generation);
  const current = await extension.tabs.get(target.id);
  active(generation);
  if (current.url !== target.href) throw new Error('Die Zielseite wurde gewechselt. Bitte erneut prüfen.');
  await extension.scripting.executeScript({ target: { tabId: target.id, frameIds: [0] }, world: 'ISOLATED', files: ['content.js'] });
  active(generation);
  const results = await extension.scripting.executeScript({ target: { tabId: target.id, frameIds: [0] }, world: 'ISOLATED', func: (request: any) => {
    try { return { ok: true, value: (globalThis as any).__heavenkeyEngine(request) }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Formularaktion fehlgeschlagen.' }; }
  }, args: [{ action, href: target.href, origin: target.origin, ...args }] });
  active(generation);
  const result = results[0]?.result;
  if (!result?.ok) throw new Error(result?.error || 'Die Zielseite ist nicht erreichbar.');
  return result.value;
}
function available(entity: string) { return !!entities[entity] || entity.startsWith('bday_') && !!entities.birthdate || ['cc_exp','cc_month','cc_year'].includes(entity) && !!entities.ccExp || entity === 'cc_csc' && !!entities.cvc; }
function showMap(result: any) {
  preview = { scan: result.scan, fields: result.fields }; const list = $('field-map'); list.replaceChildren();
  for (const field of preview!.fields) {
    const row = document.createElement('div'); row.className = 'mapping-row';
    const label = document.createElement('label'); label.className = 'choice';
    const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.field = field.id;
    check.checked = !!field.entity && available(field.entity) && !field.sensitive && !field.secret && !field.hasValue;
    const text = document.createElement('span'); text.textContent = `${field.field} · ${field.kind}${field.hasValue ? ' · bereits befüllt' : ''}${field.sensitive ? ' · sensibel' : ''}${field.secret ? ' · Geheimnis' : ''}`;
    label.append(check,text);
    const options = document.createElement('select'); options.dataset.mapping = field.id; options.setAttribute('aria-label',`Wert für ${field.field}`);
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Nicht füllen'; options.append(empty);
    for (const name of [...Object.keys(entities), ...['bday_day','bday_month','bday_year','cc_exp','cc_month','cc_year'].filter(available)]) {
      const option = document.createElement('option'); option.value = name; option.textContent = labels[name] || name; options.append(option);
    }
    options.value = field.entity || ''; options.addEventListener('change', () => { check.checked = !!options.value; input('confirm-origin').checked = false; });
    check.addEventListener('change', () => { input('confirm-origin').checked = false; });
    row.append(label,options); list.append(row);
  }
  $('target-origin').textContent = result.origin; input('confirm-origin').checked = false; $('fill-confirmation').hidden = false;
}
$('pairing-form').addEventListener('submit', event => {
  event.preventDefault();
  const port = input('pair-port').value, code = input('pair-code').value.trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^[A-Za-z0-9_-]{20,128}$/.test(code)) { status('Gültigen Port und den Kopplungscode aus HeavenKey eingeben.',true); return; }
  // Request remains directly in the user's click gesture for Chromium/Firefox.
  const permission = extension.permissions.request({ origins: ['http://localhost/*'] });
  void run(async generation => {
    if (!await permission) throw new Error('Ohne deine lokale Verbindungsfreigabe ist keine Kopplung möglich.');
    const origin = `http://localhost:${Number(port)}`;
    const response = await fetch(origin + '/api/password-vault/extension/connect', { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000), headers: { 'Content-Type': 'application/json', 'X-HeavenKey-Client': 'password-extension' }, body: JSON.stringify({ code }) });
    input('pair-code').value = '';
    if (!response.ok) throw new Error('Kopplungscode ungültig oder abgelaufen. Im Programm einen neuen Code anfordern.');
    const result = await response.json(), next = { origin, token: result.token };
    active(generation); if (!validConnection(next)) throw new Error('Ungültige Kopplungsantwort.');
    connection = next; await extension.storage.local.set({ 'heavenkey.extension.v1': next }); connected(); status('Gekoppelt. Jetzt mit deinem Masterpasswort entsperren.'); input('extension-master').focus();
  });
});
$('unlock-form').addEventListener('submit', event => {
  event.preventDefault(); const master = input('extension-master').value; input('extension-master').value = '';
  void run(async generation => {
    // Privileged Chromium GET fetch omits Origin. This explicit read transport
    // keeps the server's extension-Origin binding intact on every request.
    const current = snapshot(await api('/api/password-vault/read', {})); active(generation);
    if (!current.record) throw new Error('Zuerst im HeavenKey-Programm einen Tresor erstellen.');
    const opened = await openVault(current.record, master); active(generation);
    await acceptOpened(opened,current.revision,generation);
  });
});
$('passkey-extension').addEventListener('click',()=>void run(async generation=>{
  if(!connection) return;
  const own=await extension.tabs.getCurrent();active(generation);
  if(!own?.id) {
    const current=await target();active(generation);
    await extension.tabs.create({url:extension.runtime.getURL(`popup.html?target=${current.id}&passkey=1`)});return;
  }
  const previous=pendingUnlock;pendingUnlock=null;
  if(previous) await api('/api/password-vault/extension/unlock/cancel',{id:previous.request.id});
  const channel=await generateChannel();active(generation);
  const result=await api('/api/password-vault/extension/unlock/start',{public_key:channel.public_key});active(generation);
  const current=snapshot(await api('/api/password-vault/read',{}));active(generation);
  if(!current.record || result.expires_in!==90) throw Error('Kein Tresor für diese Anfrage.');
  const request=validateRequest({id:result.id,origin:location.origin,public_key:channel.public_key,revision:current.revision,vault_salt:current.record.salt});
  const code=await channelCode(request);active(generation);
  pendingUnlock={request,privateKey:channel.privateKey,expires:Date.now()+90000};
  const waiting=pendingUnlock;setTimeout(()=>{if(pendingUnlock===waiting) lock('Passkey-Anfrage abgelaufen. Erneut starten oder Masterpasswort verwenden.');},90000);
  $('passkey-code').textContent=`Vergleichscode: ${code}`;$('complete-passkey').hidden=false;
  await extension.tabs.create({url:connection.origin+'/passwords/#extension-unlock='+encodeURIComponent(request.id)});active(generation);
  status('Im HeavenKey-Tab Code vergleichen und mit Passkey freigeben. Danach hier „Freigabe übernehmen“ wählen.');
}));
$('complete-passkey').addEventListener('click',()=>void run(async generation=>{
  const pending=pendingUnlock;if(!pending || Date.now()>=pending.expires) {lock('Freigabe abgelaufen. Bitte neu starten.');return;}
  const result=await api('/api/password-vault/extension/unlock/poll',{id:pending.request.id});active(generation);
  if(result.pending) {status('Noch keine Freigabe. Im HeavenKey-Tab zuerst mit Passkey bestätigen.');return;}
  pendingUnlock=null;$('complete-passkey').hidden=true;$('passkey-code').textContent='';
  if(result.revision!==pending.request.revision || result.vault_salt!==pending.request.vault_salt) throw Error('Der Tresor wurde geändert.');
  let master='';
  try {
    master=await openUnlock(pending.request,pending.privateKey,result.sealed);active(generation);
    const current=snapshot(await api('/api/password-vault/read',{}));active(generation);
    if(current.revision!==result.revision || !current.record || current.record.salt!==result.vault_salt) throw Error('Der Tresor wurde geändert. Neu anfordern.');
    const opened=await openVault(current.record,master);active(generation);await acceptOpened(opened,current.revision,generation);
  } finally {master='';}
}));
$('quick-login').addEventListener('click',()=>void run(async generation=>{
  if(!key || !sourceLogin) return;
  pageTarget=await target();active(generation);
  const result=await inject(pageTarget,'scan',generation);active(generation);showMap(result);
  const passwords=result.fields.filter((f:Field)=>f.entity==='password' && f.kind!=='new-password');
  const form=passwords.length===1 ? passwords[0].form : null;
  const allowed=form ? result.fields.filter((f:Field)=>f.form===form && ['username','email','password'].includes(f.entity||'') && !f.hasValue && f.kind!=='new-password') : [];
  for(const check of document.querySelectorAll<HTMLInputElement>('[data-field]')) check.checked=allowed.some((f:Field)=>f.id===check.dataset.field);
  input('include-secrets').checked=true;input('confirm-origin').checked=false;
  status(form ? 'Loginfelder ausgewählt. Prüfe die Adresse und gib das Einfügen frei. Es wird nichts abgesendet.' : 'Kein eindeutiges Loginformular. Wähle die Felder einzeln in der Vorschau.');$('fill-confirmation').scrollIntoView({block:'nearest'});focusAfter(input('confirm-origin'));
}));
$('lock-extension').addEventListener('click', () => { lock(); input('extension-master').focus(); });
$('disconnect').addEventListener('click', () => void disconnect());
input('vault-search').addEventListener('input', renderSources);
$('extract-text').addEventListener('click', () => {
  if (!key || busy) return; const text = input('source-text').value; if (text.length > 50000) { status('Der Text darf höchstens 50.000 Zeichen enthalten.',true); return; }
  entities = Object.fromEntries(Object.entries((globalThis as any).SmartFieldExtract.extract(text)).filter(([name]) => PROFILE_KEYS.includes(name as any))) as Record<string,string>;
  sourceLogin = null; sourceProfile = null; renderEntities(); status(`${Object.keys(entities).length} Werte erkannt. Bitte vor der Freigabe prüfen.`);
});
$('read-clipboard').addEventListener('click', () => void run(async generation => { const text = await navigator.clipboard.readText(); active(generation); if (!key) return; if (text.length > 50000) throw new Error('Zwischenablage ist zu groß.'); input('source-text').value = text; status('Zwischenablage eingefügt. Jetzt Werte erkennen.'); }));
$('read-selection').addEventListener('click', () => void run(async generation => {
  const current = await target(); active(generation); const results = await extension.scripting.executeScript({ target: { tabId: current.id, frameIds: [0] }, world: 'ISOLATED', func: () => String(window.getSelection() || '').slice(0,50000) }); active(generation); input('source-text').value = results[0]?.result || ''; status('Markierten Text übernommen. Jetzt Werte erkennen.');
}));
$('scan-page').addEventListener('click', () => void run(async generation => {
  if (!key || !Object.keys(entities).length) throw new Error('Zuerst Werte oder einen Login auswählen.');
  pageTarget = await target(); active(generation);
  if (sourceLogin?.totp) { const code = (await totp(sourceLogin.totp)).code; active(generation); entities.otp = code; }
  const result = await inject(pageTarget,'scan',generation); active(generation); showMap(result); status(`${result.fields.length} erreichbare Felder. Wähle genau die gewünschten Werte.`);
}));
$('fill-selected').addEventListener('click', () => void run(async generation => {
  if (!key || !pageTarget || !preview || !input('confirm-origin').checked) throw new Error('Die angezeigte Zielseite ausdrücklich bestätigen.');
  const current = await target(); active(generation); if (current.id !== pageTarget.id || current.href !== pageTarget.href) throw new Error('Die Zielseite hat sich geändert. Erneut prüfen.');
  const selected = [...document.querySelectorAll<HTMLInputElement>('[data-field]:checked')].map(field => ({ id: field.dataset.field!, entity: document.querySelector<HTMLSelectElement>(`[data-mapping="${field.dataset.field}"]`)!.value })).filter(row => row.entity);
  if (sourceLogin?.totp) { const code = (await totp(sourceLogin.totp)).code; active(generation); entities.otp = code; }
  const result = await inject(pageTarget,'fill',generation,{ scan: preview.scan, entities, selected, sensitive: input('include-sensitive').checked, secrets: input('include-secrets').checked, overwrite: input('overwrite').checked, choices: input('include-choices').checked }); active(generation);
  resetPreview(); status(`${result.count} Felder gefüllt.${result.blocked.length ? ` ${result.blocked.length} Felder wegen fehlender Freigabe oder Zuordnung ausgelassen.` : ''} Es wurde kein Formular abgesendet.`);
}));
$('undo-fill').addEventListener('click', () => void run(async generation => { if (!key || !pageTarget) throw new Error('Keine Füllung in dieser Sitzung.'); const result = await inject(pageTarget,'undo',generation); active(generation); resetPreview(); status(`${result.count} Felder zurückgesetzt. Unveränderte Zielseite und maximal 2 Minuten erforderlich.`); }));
$('capture-page').addEventListener('click', () => void run(async generation => {
  if (!key) return; sourceLogin = null; sourceProfile = null; pageTarget = await target(); active(generation);
  const result = await inject(pageTarget,'capture',generation,{ sensitive: input('include-sensitive').checked }); active(generation); entities = result.entities; renderEntities(); status(`${Object.keys(entities).length} Werte als Vorschau übernommen. Geheimnisse bleiben ausgeschlossen. Erst Speichern schreibt ein Profil.`);
}));
$('save-profile').addEventListener('click', () => void run(async generation => {
  if (!vault || !key || !envelope) return;
  const title = input('profile-title').value.trim(); if (!title) throw new Error('Einen Profilnamen eingeben.');
  const values = Object.fromEntries(Object.entries(entities).filter(([name,value]) => PROFILE_KEYS.includes(name as any) && !!value));
  if (values.password && values.password !== sourceProfile?.entities.password && !input('include-secrets').checked) throw new Error('Zum Speichern eines neuen Profilpassworts zuerst die Geheimnis-Freigabe aktivieren.');
  if (!Object.keys(values).length) throw new Error('Keine Profilwerte vorhanden.');
  const profile: FormProfile = { id: sourceProfile?.id || crypto.randomUUID(), title, entities: values, updatedAt: new Date().toISOString() };
  const profiles = [...(vault.profiles || []).filter(p => p.id !== profile.id), profile]; validateProfiles(profiles);
  const next: ExtendedVault = { ...vault, profiles }, sealed = await sealVault(next,key,envelope); active(generation);
  const saved = snapshot(await api('/api/password-vault',{ expected_revision: revision, record: sealed })); active(generation);
  vault = next; envelope = sealed; revision = saved.revision; sourceProfile = profile; renderSources(); status('Profil verschlüsselt gespeichert.');
}));
for (const id of ['include-sensitive','include-secrets','overwrite','include-choices']) input(id).addEventListener('change', () => { input('confirm-origin').checked = false; });
for (const type of ['pointerdown','keydown']) document.addEventListener(type, () => { lastActivity = Date.now(); });
setInterval(() => { if (key && Date.now() - lastActivity > 120000) lock('Nach 2 Minuten Inaktivität gesperrt.'); },10000);
addEventListener('pagehide', () => lock());
void (async () => { try { const saved = (await extension.storage.local.get('heavenkey.extension.v1'))['heavenkey.extension.v1']; if (validConnection(saved)) connection = saved; else if (saved) await extension.storage.local.remove('heavenkey.extension.v1'); connected(); if(connection && new URL(location.href).searchParams.get('passkey')==='1') $('passkey-extension').click(); } catch { status('Verbindungseinstellung konnte nicht geladen werden.',true); } })();
