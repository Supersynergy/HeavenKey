import { fieldLabel } from './field-label';

/** Local, value-free validation feedback; native constraint checks stay enabled. */
export function initFormFeedback(form: HTMLFormElement) {
  type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const document = form.ownerDocument;
  const summary = document.createElement('div');
  summary.className = 'form-feedback'; summary.hidden = true;
  summary.setAttribute('role', 'alert'); summary.tabIndex = -1;
  form.prepend(summary);
  const errors = new Map<Control, { id: string; invalid: string | null }>();
  function restore(field: Control) {
    const state = errors.get(field); if (!state) return;
    if (state.invalid === null) field.removeAttribute('aria-invalid'); else field.setAttribute('aria-invalid', state.invalid);
    // Remove only our reference, preserving descriptions added by other helpers.
    const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== state.id);
    if (ids.length) field.setAttribute('aria-describedby', ids.join(' ')); else field.removeAttribute('aria-describedby');
    errors.delete(field);
  }
  function render() {
    summary.replaceChildren();
    for (const field of errors.keys()) if (!field.isConnected || field.form !== form || !field.willValidate || field.validity.valid) restore(field);
    summary.hidden = !errors.size;
    if (!errors.size) return;
    const heading = document.createElement('p'); heading.textContent = 'Bitte prüfe diese Felder:'; summary.append(heading);
    const list = document.createElement('ul'); summary.append(list);
    for (const [field, state] of errors) {
      const row = document.createElement('li'); row.id = state.id;
      const button = document.createElement('button'); button.type = 'button';
      const reason = field.validity.valueMissing ? 'Bitte ausfüllen.' : field.validity.tooLong ? 'Eingabe ist zu lang.' : 'Bitte eine gültige Eingabe verwenden.';
      button.textContent = `${fieldLabel(field) || field.name || 'Eingabefeld'}: ${reason}`;
      button.addEventListener('click', () => field.focus()); row.append(button); list.append(row);
    }
  }
  function invalid(event: Event) {
    const field = event.target as Control;
    if (!field || field.form !== form || !field.validity || field.validity.valid) return;
    if (!errors.has(field)) errors.set(field, { id: `field-error-${crypto.randomUUID()}`, invalid: field.getAttribute('aria-invalid') });
    field.setAttribute('aria-invalid', 'true');
    const id = errors.get(field)!.id;
    const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!ids.includes(id)) field.setAttribute('aria-describedby', [...ids, id].join(' '));
    render();
  }
  function clear() { for (const field of errors.keys()) restore(field); render(); }
  form.addEventListener('invalid', invalid, true);
  form.addEventListener('input', render); form.addEventListener('change', render); form.addEventListener('reset', clear);
  return { clear, dispose() { clear(); summary.remove(); form.removeEventListener('invalid', invalid, true); form.removeEventListener('input', render); form.removeEventListener('change', render); form.removeEventListener('reset', clear); } };
}
