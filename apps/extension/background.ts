const extension = (globalThis as any).browser || (globalThis as any).chrome;
extension.runtime.onInstalled.addListener(() => {
  extension.contextMenus.create({ id: 'heavenkey-selection', title: 'Mit HeavenKey prüfen …', contexts: ['selection'] });
});
extension.contextMenus.onClicked.addListener(async (info: any, tab: any) => {
  if (info.menuItemId !== 'heavenkey-selection' || !tab?.id) return;
  // Selection stays in memory of a new preview page, never in extension storage.
  await extension.tabs.create({ url: extension.runtime.getURL(`popup.html?target=${tab.id}`) });
  // The preview retrieves the current selection only after an explicit click.
});
