/** Optional, per-website field affordance. Never reads values or receives vault data. */
import { website } from './site-access';
const ext = (globalThis as any).browser || (globalThis as any).chrome;
const state = globalThis as any;
if (window.top === window && !state.__heavenkeyInline) {
  state.__heavenkeyInline = true;
  const host = document.createElement('div');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = ':host{color-scheme:light dark}button{position:fixed;pointer-events:auto;box-sizing:border-box;width:28px;height:28px;border:1px solid #b38b3e;border-radius:8px;background:#faf5e9;color:#70501a;cursor:pointer;display:grid;place-items:center;padding:5px;box-shadow:0 1px 5px #0002}button:focus-visible{outline:3px solid #70501a;outline-offset:2px}svg{width:16px;height:16px;fill:currentColor;pointer-events:none}.menu{position:fixed;pointer-events:auto;display:grid;gap:4px;width:246px;padding:10px;background:#faf8f2;color:#222c3a;border:1px solid #b38b3e;border-radius:12px;box-shadow:0 8px 32px #0003;font:13px/1.4 system-ui}.menu button{position:static;display:block;width:100%;height:auto;min-height:36px;text-align:left;padding:7px 10px;background:#fff;border-color:#ddd9cf;box-shadow:none}.brand{padding:3px 6px;font-weight:700}.hint{padding:3px 6px;font-size:11px;color:#5e6570}';
  shadow.append(style);
  const buttons = new Map<HTMLInputElement, HTMLButtonElement>();
  let menu: HTMLElement | null = null, enabled = false, pending = false, stopped = false;
  const close = () => { menu?.remove(); menu = null; };
  const relevant = (el: HTMLInputElement) => {
    if (el.disabled || el.readOnly || el.closest('[inert],[hidden],[aria-hidden="true"]') || ['hidden','checkbox','radio','submit','button','file','search'].includes(el.type) || el.autocomplete.split(/\s+/).includes('off')) return false;
    const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
    if (rect.width < 55 || rect.height < 20 || rect.bottom <= 0 || rect.top >= innerHeight || rect.left >= innerWidth || rect.right <= 0 || css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0 || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const tokens = [el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.placeholder].join(' ');
    return el.type === 'password' || el.type === 'email' || el.type === 'tel' || /user|login|mail|name|adresse|address|street|city|postal|zip|phone|company|given-name|family-name|organization|country|vorname|nachname|firma|straße|telefon|plz|one-time-code/i.test(tokens);
  };
  const fields = (root: Document | ShadowRoot): HTMLInputElement[] => {
    const found = [...root.querySelectorAll<HTMLInputElement>('input')];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot && el !== host && found.length < 200) found.push(...fields(el.shadowRoot));
    return found.slice(0, 200);
  };
  const open = (el: HTMLInputElement, anchor: HTMLButtonElement, event: Event) => {
    if (!event.isTrusted || !enabled || !relevant(el)) return;
    close();
    const token = crypto.randomUUID();
    state.__heavenkeyInlineTarget = { el, token, href: location.href, expires: Date.now() + 120000 };
    menu = document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', 'HeavenKey Aktionen');
    const brand = document.createElement('div'); brand.className = 'brand'; brand.textContent = 'HeavenKey'; menu.append(brand);
    const options = [['login', 'Login auswählen'], ['template', 'Name & Adresse ausfüllen'], ['generate', 'Neues Passwort generieren'], ['manage', 'Passwörter verwalten']];
    for (const [intent, label] of options) {
      const action = document.createElement('button'); action.type = 'button'; action.textContent = label;
      action.addEventListener('click', async click => {
        if (!click.isTrusted || !enabled || !relevant(el) || state.__heavenkeyInlineTarget?.token !== token) return;
        try { const result=await ext.runtime.sendMessage({ type: 'heavenkey.inline.open', intent, token, href: location.href }); if(!result?.ok) throw Error('Aktion abgelaufen'); close(); }
        catch { action.textContent = 'Erweiterung bitte neu öffnen'; }
      }); menu.append(action);
    }
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Entsperren und Freigabe im HeavenKey-Fenster.'; menu.append(hint);
    const rect = anchor.getBoundingClientRect(); menu.style.left = `${Math.max(4, Math.min(rect.right - 246, innerWidth - 254))}px`; menu.style.top = `${Math.max(4, Math.min(rect.bottom + 6, innerHeight - 270))}px`;
    shadow.append(menu); menu.querySelector('button')?.focus();
  };
  const render = () => {
    pending = false;
    if (stopped) return;
    const visible = enabled ? fields(document).filter(relevant).slice(0, 60) : [];
    for (const [el, button] of buttons) if (!visible.includes(el)) { button.remove(); buttons.delete(el); }
    for (const el of visible) {
      let button = buttons.get(el);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.title = 'HeavenKey öffnen'; button.setAttribute('aria-label', 'HeavenKey öffnen');
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2a6 6 0 0 0-2 11.66V22h4v-3h3v-3h-3v-2.34A6 6 0 0 0 8 2Zm0 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/></svg>';
        const own = button; button.addEventListener('click', event => open(el, own, event)); buttons.set(el, button); shadow.append(button);
      }
      const rect = el.getBoundingClientRect(); button.style.left = `${Math.min(innerWidth - 32, rect.right - 31)}px`; button.style.top = `${rect.top + (rect.height - 28) / 2}px`;
    }
    if (enabled && !host.isConnected) document.documentElement.append(host);
    if (!enabled) { close(); host.remove(); delete state.__heavenkeyInlineTarget; }
  };
  const schedule = () => { if (!pending && !stopped) { pending = true; requestAnimationFrame(render); } };
  const refresh = async () => {
    try {
      const { origin } = website(location.href);
      const sites = (await ext.storage.local.get('heavenkey.inline.sites'))['heavenkey.inline.sites'] || [];
      enabled = Array.isArray(sites) && sites.includes(origin); schedule();
    } catch { enabled = false; schedule(); }
  };
  const observer = new MutationObserver(records => { if (records.some(record => record.target !== host)) schedule(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type','disabled','readonly','hidden','class','autocomplete','style'] });
  addEventListener('scroll', () => { close(); schedule(); }, true); addEventListener('resize', () => { close(); schedule(); });
  document.addEventListener('focusin', schedule); document.addEventListener('pointerdown', event => { if (!event.composedPath().includes(host)) close(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  ext.storage.onChanged.addListener((changes: any) => { if (changes['heavenkey.inline.sites']) void refresh(); });
  addEventListener('popstate', () => { close(); delete state.__heavenkeyInlineTarget; void refresh(); });
  addEventListener('pagehide', () => { stopped = true; observer.disconnect(); host.remove(); delete state.__heavenkeyInlineTarget; });
  addEventListener('pageshow', () => { if(stopped) { stopped=false;observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['type','disabled','readonly','hidden','class','autocomplete','style']});void refresh();} });
  void refresh();
}
