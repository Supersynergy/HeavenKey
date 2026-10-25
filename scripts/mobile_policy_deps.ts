import { mkdirSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const directory = resolve(import.meta.dir, '../.platform-tools');
const path = join(directory, 'mobile-policy-json-20250517.jar');
const expected = '3ea61b2a06e31edf1c91134fe9106b0ebb16628be169f3db75bc7a2b06b45796';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
if (existsSync(path)) {
  if (digest(readFileSync(path)) !== expected) throw new Error('Existing mobile-policy JSON fixture differs from its pinned digest; inspect it explicitly.');
} else {
  const response = await fetch('https://repo.maven.apache.org/maven2/org/json/json/20250517/json-20250517.jar', { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error('Pinned JVM JSON fixture unavailable.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 200_000 || digest(bytes) !== expected) throw new Error('Pinned JVM JSON fixture integrity check failed.');
  mkdirSync(directory, {recursive:true});
  const temporary = path + '.tmp-' + process.pid;
  try { await Bun.write(temporary, bytes); renameSync(temporary, path); }
  finally { rmSync(temporary, {force:true}); }
}
console.log('Pinned org.json 20250517 JVM test fixture ready; Public Domain, not bundled in the application.');
