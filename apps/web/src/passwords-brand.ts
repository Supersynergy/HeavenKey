let brandInstance = 0;

/** One silhouette, with independent paint resources for every mounted key. */
export function createGoldenKey(size: "compact" | "hero" = "compact"): SVGSVGElement {
  const id = `heavenkey-gold-${++brandInstance}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("class", `golden-key golden-key--${size}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("width", size === "hero" ? "224" : "36");
  svg.setAttribute("height", size === "hero" ? "224" : "36");
  const silhouette = "M110 22H146L176 52V88L150 114H142V174H164V194H142V210H160V230H114V114H106L80 88V52ZM116 44 102 58V81L116 95H140L154 81V58L140 44Z";
  svg.innerHTML = `
    <defs>
      <linearGradient id="${id}-edge" x1="80" y1="22" x2="169" y2="230" gradientUnits="userSpaceOnUse">
        <stop stop-color="#e9b957"/><stop offset=".35" stop-color="#8b4e13"/><stop offset=".66" stop-color="#b67922"/><stop offset="1" stop-color="#714014"/>
      </linearGradient>
      <linearGradient id="${id}-gold" x1="86" y1="54" x2="171" y2="179" gradientUnits="userSpaceOnUse">
        <stop stop-color="#fff1b6"/><stop offset=".18" stop-color="#eec56b"/><stop offset=".4" stop-color="#c28b2c"/><stop offset=".52" stop-color="#ffe3a0"/><stop offset=".66" stop-color="#e0ae4e"/><stop offset="1" stop-color="#ad721c"/>
      </linearGradient>
      <linearGradient id="${id}-bevel" x1="93" y1="25" x2="146" y2="227" gradientUnits="userSpaceOnUse">
        <stop stop-color="#fff8dc"/><stop offset=".36" stop-color="#fbe1a0"/><stop offset=".7" stop-color="#bb8227"/><stop offset="1" stop-color="#f7d47b"/>
      </linearGradient>
      <linearGradient id="${id}-inset" x1="105" y1="46" x2="148" y2="94" gradientUnits="userSpaceOnUse">
        <stop stop-color="#81501b"/><stop offset=".55" stop-color="#b27b27"/><stop offset="1" stop-color="#fff0b8"/>
      </linearGradient>
    </defs>
    ${size === "hero" ? '<ellipse cx="135" cy="225" rx="69" ry="7" fill="#725224" opacity=".12"/>' : ""}
    <g transform="rotate(-38 128 128)">
      <path d="${silhouette}" transform="translate(5 6)" fill="url(#${id}-edge)" fill-rule="evenodd"/>
      <path d="${silhouette}" fill="url(#${id}-gold)" fill-rule="evenodd" stroke="url(#${id}-bevel)" stroke-width="2" stroke-linejoin="round"/>
      <path d="m110 22 9 8h23l26 26 8-4-30-30Zm-30 30 8 5v27l23 23-5 7-26-26Z" fill="#fff4c5" opacity=".6"/>
      <path d="m154 58-14-14h-24l-14 14v23l14 14h24l14-14Z" fill="none" stroke="url(#${id}-inset)" stroke-width="4"/>
      <path d="M114 115h28v9h-28Z" fill="#9a641f"/><path d="M114 115h28v3h-28Z" fill="#ffe7a6"/>
      <path d="M120 131v90h9v-90" fill="#fff0b4" opacity=".34"/>
      <path d="M137 131v44l5 5v-49Zm5 60v3h22v-4Zm0 35v4h18v-4Z" fill="#88551b" opacity=".55"/>
      <path d="M118 228h40M145 177h17M145 213h13" fill="none" stroke="#ffe9ac" stroke-width="1.5"/>
      ${size === "hero" ? '<path d="M91 58v23l21 21M116 32h26l21 21M119 136v80" fill="none" stroke="#fff9e3" stroke-width="1" opacity=".7"/>' : ""}
    </g>`;
  return svg;
}

export function initBrand(): void {
  document.querySelectorAll<HTMLElement>("[data-heavenkey-brand]").forEach(host => {
    if (host.querySelector(".golden-key")) return;
    host.replaceChildren(createGoldenKey(host.dataset.heavenkeyBrand === "hero" ? "hero" : "compact"));
  });
}
