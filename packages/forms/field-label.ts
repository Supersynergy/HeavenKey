/** Accessible field names only. Never read a control's current value. */
export function fieldLabel(el: Element): string {
  const text = (node: Element) => {
    if (node.matches('input,textarea,select,button,[contenteditable],script,style')) return '';
    const copy = node.cloneNode(true) as Element;
    copy.querySelectorAll('input,textarea,select,button,[contenteditable],script,style').forEach(child => child.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  };
  const join = (nodes: Element[]) => [...new Set(nodes.map(text).filter(Boolean))].join(' ').slice(0, 300);
  const root = el.getRootNode() as Document | ShadowRoot;
  const references = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).slice(0, 20)
    .map(id => root.getElementById?.(id)).filter((node): node is HTMLElement => !!node);
  const referenced = join(references);
  if (referenced) return referenced;
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria.slice(0, 300);
  const labels = (el as HTMLInputElement).labels;
  const explicit = join(labels ? Array.from(labels) : []);
  if (explicit) return explicit;
  const wrapped = el.closest('label');
  if (wrapped) return text(wrapped);
  const previous = el.previousElementSibling;
  if (previous && /^(SPAN|P)$/.test(previous.tagName)) return text(previous);
  return '';
}
