import { mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const version = (await readFile(join(root, 'Cargo.toml'), 'utf8')).match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/)?.[1];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid workspace version');
const source = join(root, 'apps/extension');
for (const browser of ['chromium','firefox']) {
  const out = join(root, 'dist', `extension-source-${browser}`);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  for (const entry of ['smart-popup.ts','content.ts','background.ts']) {
    const result = await Bun.build({ entrypoints: [join(source, entry)], outdir: out, target: 'browser', format: 'iife', minify: false, naming: entry.replace('.ts','.js') });
    if (!result.success) throw new AggregateError(result.logs, `Extension build failed: ${entry}`);
  }
  for (const name of ['popup.html','popup.css','popup.js','settings.js','THIRD-PARTY-NOTICE.md','EXTENSION-CONTRACT.md','FEATURE-MAP.md']) await copyFile(join(source, name), join(out, name));
  await copyFile(join(root, 'LICENSE'), join(out, 'LICENSE'));
  const manifest: any = {
    manifest_version: 3, name: 'HeavenKey', version,
    description: 'Lokaler verschlüsselter Tresor und Formularhilfe mit deiner Freigabe.',
    permissions: ['activeTab','scripting','storage','contextMenus'], optional_host_permissions: ['http://localhost/*'],
    action: { default_popup: 'popup.html', default_title: 'HeavenKey öffnen' },
    commands: { _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' }, description: 'HeavenKey öffnen' } },
    content_security_policy: { extension_pages: "default-src 'self'; script-src 'self'; object-src 'none'; connect-src http://localhost:*; img-src 'self' data:; style-src 'self'; base-uri 'none'; form-action 'none'" },
    background: browser === 'chromium' ? { service_worker: 'background.js' } : { scripts: ['background.js'] },
    ...(browser === 'firefox' ? { browser_specific_settings: { gecko: { id: 'heavenkey@supersynergy.local', strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } } } } : { minimum_chrome_version: '120' }),
  };
  await writeFile(join(out,'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
  console.log(`${browser} ${version}: ${out}`);
}
