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
