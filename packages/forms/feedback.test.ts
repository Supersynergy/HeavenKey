import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { initFormFeedback } from './feedback';

test('validation links focus the field, preserve descriptions and clear after correction', () => {
  const win = new Window(); const document = win.document;
  document.body.innerHTML = '<form><label for="email">E-Mail</label><input id="email" type="email" required aria-describedby="help"><p id="help">Bestehender Hinweis</p><button>Speichern</button></form>';
  const form = document.querySelector('form')! as unknown as HTMLFormElement;
  const field = document.querySelector('input')!;
  const feedback = initFormFeedback(form);
  expect(form.checkValidity()).toBe(false);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(field.getAttribute('aria-describedby')).toContain('help field-error-');
  const summary = document.querySelector('.form-feedback')!;
  expect(summary.textContent).toContain('E-Mail: Bitte ausfüllen.');
  (summary.querySelector('button') as any).click(); expect(document.activeElement).toBe(field);
  field.value = 'alex@example.invalid'; field.dispatchEvent(new win.Event('input', {bubbles:true}));
  expect(field.hasAttribute('aria-invalid')).toBe(false);
  expect(field.getAttribute('aria-describedby')).toBe('help');
  expect(summary.hasAttribute('hidden')).toBe(true);
  feedback.dispose(); expect(document.querySelector('.form-feedback')).toBeNull();
});
test('secret values and custom validity messages stay out of feedback; reset clears all owned references', () => {
  const win = new Window(); const document = win.document;
  document.body.innerHTML = '<form><label>Passwort<input type="password" value="synthetic-secret" aria-describedby="original" aria-invalid="false"></label></form>';
  const form = document.querySelector('form')! as unknown as HTMLFormElement;
  const field = document.querySelector('input')!;
  initFormFeedback(form); field.setCustomValidity('synthetic-secret must never be announced');
  form.checkValidity();
  expect(document.querySelector('.form-feedback')!.textContent).not.toContain('synthetic-secret');
  field.setAttribute('aria-describedby', field.getAttribute('aria-describedby') + ' later-hint');
  form.reset();
  expect(field.getAttribute('aria-describedby')).toBe('original later-hint');
  expect(field.getAttribute('aria-invalid')).toBe('false');
});
