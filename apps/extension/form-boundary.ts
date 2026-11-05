/** DOM identity only. Never inspect or retain a field's value. */
type Field = HTMLElement & { form?: HTMLFormElement | null };
export function ownerForm(el: HTMLElement): HTMLFormElement | null {
  return (el as Field).form || el.closest('form');
}
export function fieldGroup(el: HTMLElement): Node {
  return ownerForm(el) || el.closest('fieldset,[role="form"],section') || el.getRootNode();
}
function destinations(el: HTMLElement): string[] {
  const form = ownerForm(el);
  if (!form) return [];
  const buttons = [...form.querySelectorAll<HTMLElement>('button[formaction],input[formaction]'),
    ...form.ownerDocument.querySelectorAll<HTMLElement>('button[formaction][form],input[formaction][form]')]
    .filter(button => ownerForm(button) === form);
  if (buttons.length > 200) throw Error('Zu viele Formularziele. Bitte manuell prüfen.');
  return [form.getAttribute('action') || el.ownerDocument.location.href,
    ...buttons.map(button => button.getAttribute('formaction') || el.ownerDocument.location.href)]
    .map(action => new URL(action, el.ownerDocument.baseURI).href);
}
function stamp(el: HTMLElement): string {
  const form = ownerForm(el);
  return JSON.stringify([
    ...['type','id','name','autocomplete','maxlength','form','role','disabled','readonly'].map(name => el.getAttribute(name)),
    form?.getAttribute('method'), form?.getAttribute('target'), destinations(el),
  ]);
}
export function captureBoundary(el: HTMLElement) {
  return { root: el.getRootNode(), form: ownerForm(el), group: fieldGroup(el), stamp: stamp(el) };
}
export function sameBoundary(el: HTMLElement, boundary: ReturnType<typeof captureBoundary>): boolean {
  try {
    return el.isConnected && el.getRootNode() === boundary.root && ownerForm(el) === boundary.form &&
      fieldGroup(el) === boundary.group && stamp(el) === boundary.stamp;
  } catch { return false; }
}
export function secretDestinationAllowed(el: HTMLElement, origin: string): boolean {
  try {
    return destinations(el).every(action => { const url = new URL(action); return url.origin === origin && !url.username && !url.password; });
  } catch { return false; }
}
