import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { fieldLabel } from './field-label';

test('multiple ARIA references retain their order and take precedence over surrounding labels', () => {
  const { document } = new Window();
  document.body.innerHTML = '<span id="a">Geschäftliche</span><span id="b">E-Mail</span><label>Falsche Zuordnung<input aria-labelledby="a missing b a" aria-label="Andere" value="private@example.invalid"></label>';
  expect(fieldLabel(document.querySelector('input')!)).toBe('Geschäftliche E-Mail');
});
test('shadow fields resolve labels in their own root, even with duplicate document IDs', () => {
  const { document } = new Window();
  document.body.innerHTML = '<span id="label">Rechnungsnummer</span><div></div>';
  const root = document.querySelector('div')!.attachShadow({mode:'open'});
  root.innerHTML = '<span id="label">Benutzername</span><input aria-labelledby="label">';
  expect(fieldLabel(root.querySelector('input')!)).toBe('Benutzername');
});
test('wrapped labels and references never include control values or editable content', () => {
  const { document } = new Window();
  document.body.innerHTML = '<label>Nachricht<textarea>secret-default</textarea><span contenteditable="true">secret-editable</span></label><input aria-labelledby="secret"><textarea id="secret">secret-reference</textarea>';
  expect(fieldLabel(document.querySelector('textarea')!)).toBe('Nachricht');
  expect(fieldLabel(document.querySelector('input')!)).toBe('');
});
