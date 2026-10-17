import assert from "node:assert/strict";
import { target, destinations } from "../apps/extension/settings.js";
for (const destination of destinations) {
  const url = target({ mode: "local", port: "18240", destination });
  assert.equal(new URL(url).origin, "http://localhost:18240");
  assert.equal(new URL(url).search, "");
}
for (const port of ["0", "65536", "-1", "1.5", "NaN", "18240/evil", "1e3", " 80"]) assert.throws(() => target({ mode: "local", port, destination: "overview" }));
for (const endpoint of ["http://example.test", "javascript:alert(1)", "https://user:password@example.test", "https://example.test/path", "https://example.test/?session=secret", "https://example.test/#secret"]) assert.throws(() => target({ mode: "https", endpoint, destination: "keys" }));
assert.equal(target({ mode: "https", endpoint: "https://heaven.example.test", destination: "keys" }), "https://heaven.example.test/#keys");
assert.equal(target({ mode: "local", port: "18240", destination: "passwords" }), "http://localhost:18240/passwords/");
assert.throws(() => target({ mode: "https", endpoint: "https://heaven.example.test", destination: "passwords" }));
assert.throws(() => target({ mode: "local", port: "18240", destination: "//evil.test" }));
console.log("Extension connection and destination validation passed.");

// Contract checks run against the emitted production descriptors, not the
// test-only host grant used by the headless browser acceptance fixture.
import { readFileSync } from 'node:fs';
const workspaceVersion = readFileSync(new URL('../Cargo.toml', import.meta.url),'utf8').match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/)[1];
for (const browser of ['chromium','firefox']) {
  const base = new URL(`../dist/extension-source-${browser}/`,import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'));
  assert.equal(manifest.version,workspaceVersion);
  assert.deepEqual([...manifest.permissions].sort(),['activeTab','contextMenus','scripting','storage']);
  assert.deepEqual(manifest.optional_host_permissions,['http://localhost/*']);
  for(const absent of ['host_permissions','content_scripts','externally_connectable','web_accessible_resources']) assert.equal(manifest[absent],undefined);
  assert.equal(manifest.action.default_popup,'popup.html');
  assert.equal(manifest.commands._execute_action.suggested_key.default,'Ctrl+Shift+Y');
  if (browser === 'firefox') assert.equal(manifest.browser_specific_settings.gecko.strict_min_version,'140.0');
  assert(manifest.content_security_policy.extension_pages.includes("script-src 'self'"));
  for(const name of ['smart-popup.js','content.js','background.js','LICENSE','THIRD-PARTY-NOTICE.md']) assert(readFileSync(new URL(name,base)).length>0);
}
await import('../apps/extension/vendor/extract.js');
const extracted=globalThis.SmartFieldExtract.extract('Vorname: Alex\nNachname: Muster\nE-Mail: alex@example.invalid\nStraße: Musterstraße 12a\nGeburtsdatum: 14. März 1990\nIBAN: DE89370400440532013000');
assert.equal(extracted.firstName,'Alex');assert.equal(extracted.lastName,'Muster');assert.equal(extracted.email,'alex@example.invalid');assert.equal(extracted.streetName,'Musterstraße');assert.equal(extracted.houseNumber,'12a');assert.equal(extracted.birthdate,'1990-03-14');assert.equal(extracted.iban,'DE89370400440532013000');
assert.equal(globalThis.SmartFieldExtract.ibanOk('DE00370400440532013000'),false);
assert.equal(globalThis.SmartFieldExtract.luhn('4111111111111111'),true);
console.log('Production manifest privilege boundaries, complete bundles and reviewed extraction passed.');
