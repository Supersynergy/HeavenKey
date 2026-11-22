/** Optional, per-website field affordance. Never reads values or receives vault data. */
import { website } from './site-access';
import { captureBoundary, sameBoundary } from './form-boundary';
import { fieldTask } from './workflow';
const ext = (globalThis as any).browser || (globalThis as any).chrome;
const state = globalThis as any;
if (window.top === window && !state.__heavenkeyInline) {
  state.__heavenkeyInline = true;
  const host = document.createElement('div');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `:host{color-scheme:light dark}
button{position:fixed;pointer-events:auto;box-sizing:border-box;width:24px;height:24px;border:1px solid transparent;border-radius:8px;background:transparent;color:#846026;cursor:pointer;display:grid;place-items:center;padding:4px;opacity:.24;box-shadow:none;transition:opacity .16s ease,box-shadow .16s ease,background-color .16s ease}
button:hover,button.near,button:focus-visible{opacity:1;border-color:#b8945080;background:linear-gradient(135deg,#fffdf3e8,#ead19a9e);box-shadow:inset 0 1px 0 #fff9,0 2px 9px #8b671a20;backdrop-filter:blur(8px)}
button:focus-visible{outline:2px solid #846026;outline-offset:2px}
svg{width:14px;height:14px;fill:currentColor;pointer-events:none}
button[hidden]{display:none}
.menu{position:fixed;pointer-events:auto;display:grid;gap:4px;width:246px;padding:10px;background:#faf8f2;color:#222c3a;border:1px solid #b38b3e;border-radius:12px;box-shadow:0 8px 32px #0003;font:13px/1.4 system-ui}
.menu button{position:static;display:block;width:100%;height:auto;min-height:36px;text-align:left;padding:7px 10px;background:#fff;border-color:#ddd9cf;box-shadow:none;opacity:1}
.brand{padding:3px 6px;font-weight:700}.hint{padding:3px 6px;font-size:11px;color:#5e6570}
@media(hover:none){button{opacity:.8}}@media(prefers-reduced-motion:reduce){button{transition:none}}`;
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
    const boundary = captureBoundary(el);
    state.__heavenkeyInlineTarget = { el, token, href: location.href, expires: Date.now() + 120000, valid: () => sameBoundary(el, boundary) };
    menu = document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', 'HeavenKey Aktionen');
    const brand = document.createElement('div'); brand.className = 'brand'; brand.textContent = 'HeavenKey'; menu.append(brand);
    const preferred = fieldTask(el);
    const options = [['login', 'Login auswählen'], ['template', 'Name & Adresse ausfüllen'], ['generate', 'Neues Passwort generieren'], ['manage', 'Passwörter verwalten']].sort((a,b) => Number(b[0] === preferred) - Number(a[0] === preferred));
    for (const [intent, label] of options) {
      const action = document.createElement('button'); action.type = 'button'; action.textContent = label;
      action.addEventListener('click', async click => {
        if (!click.isTrusted || !enabled || !relevant(el) || state.__heavenkeyInlineTarget?.token !== token) return;
        try { const result=await ext.runtime.sendMessage({ type: 'heavenkey.inline.open', intent, token, href: location.href }); if(!result?.ok) throw Error('Aktion abgelaufen'); close(); }
        catch { action.textContent = 'Erweiterung bitte neu öffnen'; }
      }); menu.append(action);
    }
    menu.addEventListener('keydown', event => {
      const controls = [...menu!.querySelectorAll('button')], current = controls.indexOf(shadow.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); close(); anchor.focus(); return; }
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : event.key === 'ArrowDown' ? (current + 1) % controls.length : event.key === 'ArrowUp' ? (current + controls.length - 1) % controls.length : -1;
      if (next >= 0) { event.preventDefault(); controls[next].focus(); }
    });
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Entsperren und Freigabe im HeavenKey-Fenster.'; menu.append(hint);
    const rect = anchor.getBoundingClientRect(); menu.style.left = `${Math.max(4, Math.min(rect.right - 246, innerWidth - 254))}px`; menu.style.top = `${Math.max(4, Math.min(rect.bottom + 6, innerHeight - 270))}px`;
    shadow.append(menu); menu.querySelector('button')?.focus();
  };
  const render = () => {
    pending = false;
    if (stopped) return;
    const visible = enabled ? fields(document).filter(relevant).slice(0, 60) : [];
    const roots = new Set<Document | ShadowRoot>([document, ...visible.map(el => el.getRootNode() as Document | ShadowRoot)]);
    const obstacles = [...roots].flatMap(root => [...root.querySelectorAll<HTMLElement>('input,button,select,textarea,a,summary,[role],[tabindex],[onclick],img,svg,canvas,video')])
      .filter(node => node !== host && (!visible.some(el => node.contains(el)) || node.matches('input,button,select,textarea,a,summary,[role="button"],[role="combobox"],[role="textbox"],[contenteditable="true"]')))
      .map(node => node.getBoundingClientRect()).filter(rect => rect.width && rect.height);
    const occupied: {left:number;right:number;top:number;bottom:number}[] = [];
    const textRects = new Map<Element, DOMRect[]>();
    const intersects = (a:{left:number;right:number;top:number;bottom:number}, b:{left:number;right:number;top:number;bottom:number}) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    for (const [el, button] of buttons) if (!visible.includes(el)) { button.remove(); buttons.delete(el); }
    for (const el of visible) {
      let button = buttons.get(el);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.title = 'HeavenKey öffnen'; button.setAttribute('aria-label', 'HeavenKey öffnen');
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2a6 6 0 0 0-2 11.66V22h4v-3h3v-3h-3v-2.34A6 6 0 0 0 8 2Zm0 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/></svg>';
        const own = button; button.addEventListener('click', event => open(el, own, event)); buttons.set(el, button); shadow.append(button);
      }
      const rect = el.getBoundingClientRect(), top = rect.top + (rect.height - 24) / 2;
      // Use the empty gutter, never the field's text or its native reveal icon.
      const free = (left: number) => {
        const area = {left,right:left+24,top,bottom:top+24};
        if (left < 4 || area.right > innerWidth - 4 || top < 4 || area.bottom > innerHeight - 4 || obstacles.some(rect => intersects(area,rect)) || occupied.some(rect => intersects(area,rect))) return false;
        return [2,12,22].every(dx => [2,12,22].every(dy => {
          const hit = document.elementsFromPoint(left + dx, top + dy).find(node => node !== host);
          if (!hit) return true;
          if (!hit.contains(el)) return false;
          if (!textRects.has(hit)) {
            const walker = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT), range = document.createRange(), rects:DOMRect[] = [];
            while (walker.nextNode()) {
              if (walker.currentNode.parentElement?.closest('script,style,textarea')) continue;
              range.selectNodeContents(walker.currentNode);rects.push(...range.getClientRects());
            }
            textRects.set(hit,rects);
          }
          return !textRects.get(hit)!.some(rect => intersects(area,rect));
        }));
      };
      const left = [rect.right + 4, rect.left - 28].find(free);
      button.hidden = left === undefined;
      if (left !== undefined) { button.style.left = `${left}px`; button.style.top = `${top}px`; occupied.push({left,right:left+24,top,bottom:top+24}); }
      button.classList.toggle('near', el.matches(':hover,:focus'));
    }
    if (enabled && !host.isConnected) document.documentElement.append(host);
    if (state.__heavenkeyInlineTarget && (!state.__heavenkeyInlineTarget.valid() || state.__heavenkeyInlineTarget.expires <= Date.now())) { close(); delete state.__heavenkeyInlineTarget; }
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
  for (const event of ['pointerover','pointerout']) document.addEventListener(event, event => { if (event.composedPath().some(node => node === host || node instanceof HTMLInputElement)) schedule(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  ext.storage.onChanged.addListener((changes: any) => { if (changes['heavenkey.inline.sites']) void refresh(); });
  addEventListener('popstate', () => { close(); delete state.__heavenkeyInlineTarget; void refresh(); });
  addEventListener('pagehide', () => { stopped = true; observer.disconnect(); host.remove(); delete state.__heavenkeyInlineTarget; });
  addEventListener('pageshow', () => { if(stopped) { stopped=false;observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['type','disabled','readonly','hidden','class','autocomplete','style']});void refresh();} });
  void refresh();
}
