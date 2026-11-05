import { website } from './site-access';
const extension = (globalThis as any).browser || (globalThis as any).chrome;
async function installMenus() {
  await extension.contextMenus.removeAll();
  extension.contextMenus.create({id:'heavenkey-login',title:'HeavenKey · Login sicher einfügen …',contexts:['page','editable']});
  extension.contextMenus.create({id:'heavenkey-template',title:'HeavenKey · Formularvorlage wählen …',contexts:['page','editable']});
  extension.contextMenus.create({ id: 'heavenkey-selection', title: 'Mit HeavenKey prüfen …', contexts: ['selection'] });
}
extension.runtime.onInstalled.addListener(()=>void installMenus());
extension.runtime.onStartup.addListener(()=>void installMenus());
extension.contextMenus.onClicked.addListener(async (info: any, tab: any) => {
  const intents: Record<string,string>={'heavenkey-selection':'selection','heavenkey-login':'login','heavenkey-template':'template'};
  const intent=intents[info.menuItemId];
  if (!intent || !tab?.id || (info.frameId && info.frameId!==0)) return;
  try {const url=new URL(tab.url);if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) return;}catch{return;}
  // Selection stays in memory of a new preview page, never in extension storage.
  await extension.tabs.create({ url: extension.runtime.getURL(`popup.html?target=${tab.id}&intent=${intent}`) });
  // The preview retrieves the current selection only after an explicit click.
});

const lastOpen = new Map<number, number>();
extension.runtime.onMessage.addListener((message: any, sender: any, respond: (value: unknown) => void) => {
  if (message?.type !== 'heavenkey.inline.open') return false;
  void (async () => {
    if (sender.id !== extension.runtime.id || sender.frameId !== 0 || !sender.tab?.id || !['login','template','generate','manage'].includes(message.intent) || typeof message.token !== 'string' || !/^[a-f0-9-]{36}$/.test(message.token)) throw Error('Ungültige Feldaktion.');
    const tab = await extension.tabs.get(sender.tab.id), site = website(tab.url);
    if (message.href !== tab.url || sender.url !== tab.url) throw Error('Die Zielseite wurde gewechselt.');
    const sites = (await extension.storage.local.get('heavenkey.inline.sites'))['heavenkey.inline.sites'];
    if (!Array.isArray(sites) || !sites.includes(site.origin) || !await extension.permissions.contains({ origins: [site.pattern] })) throw Error('Website nicht freigegeben.');
    const [anchor] = await extension.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: (token: string, href: string) => {
      const selected = (globalThis as any).__heavenkeyInlineTarget;
      return !!selected && selected.token === token && selected.href === href && location.href === href && selected.expires > Date.now() && selected.el.isConnected;
    }, args: [message.token, tab.url] });
    if (!anchor?.result || Date.now() - (lastOpen.get(tab.id) || 0) < 1000) throw Error('Feldaktion abgelaufen. Erneut auf den Schlüssel klicken.');
    lastOpen.set(tab.id, Date.now());
    const params = new URLSearchParams({ target: String(tab.id), intent: message.intent, anchor: message.token });
    await extension.windows.create({ url: extension.runtime.getURL(`popup.html?${params}`), type: 'popup', width: 500, height: 760 });
    respond({ ok: true });
  })().catch(() => respond({ ok: false }));
  return true;
});
extension.tabs.onRemoved.addListener((id: number) => lastOpen.delete(id));
