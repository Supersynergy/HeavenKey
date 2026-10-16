/** Local presentation helpers. This module never reads vault data or storage. */
export type IconName = "star" | "back" | "vault";
const iconPaths: Record<IconName, string> = {
  star: "M12 3l2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.6l6.3-.9Z",
  back: "M20 12H4m7-7-7 7 7 7",
  vault: "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm10 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-4-4v2m0 4v2m-4-4h2m4 0h2",
};
export function createIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon", `icon-${name}`);
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", iconPaths[name]);
  svg.append(path);
  return svg;
}

export function initPresentation(): void {
  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const names: Record<string, string> = {
    Mod: mac ? "Cmd" : "Ctrl", Ctrl: "Ctrl", Alt: mac ? "Option" : "Alt",
    Enter: "Enter", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓",
  };
  const accessible: Record<string, string> = { Cmd: "Command", Ctrl: "Control", Esc: "Escape", "↑": "Pfeil nach oben", "↓": "Pfeil nach unten" };
  for (const hint of document.querySelectorAll<HTMLElement>("[data-shortcut]")) {
    const keys = hint.dataset.shortcut!.split("+").map(key => names[key] ?? key);
    hint.replaceChildren(...keys.map(key => {
      const cap = document.createElement("kbd");
      cap.textContent = key;
      cap.setAttribute("aria-hidden", "true");
      return cap;
    }));
    hint.setAttribute("role", "img");
    hint.setAttribute("aria-label", keys.map(key => accessible[key] ?? key).join(" + "));
  }
  const dialog = document.querySelector<HTMLDialogElement>("#shortcuts-dialog");
  if (!dialog) return;
  const description = document.getElementById("shortcuts-description");
  if (description) description.textContent = `Tastenbelegung für ${mac ? "macOS" : /Win/.test(navigator.platform) ? "Windows" : "Linux"}. Die Kürzel zum Suchen und Sperren gelten im entsperrten Tresor.`;
  let returnFocus: HTMLElement | null = null;
  function openHelp(): void {
    if (dialog!.open) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog!.showModal();
  }
  document.querySelectorAll<HTMLElement>("[data-open-shortcuts]").forEach(button => button.addEventListener("click", openHelp));
  function restoreFocus(): void {
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus();
    returnFocus = null;
  }
  function closeHelp(): void { dialog!.close(); restoreFocus(); }
  document.querySelector("#close-shortcuts")?.addEventListener("click", closeHelp);
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeHelp(); });
  dialog.addEventListener("close", restoreFocus);
  document.addEventListener("keydown", event => {
    if (event.key === "F1" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      openHelp();
    }
  });
}
