"""Validate all platform versions and source provenance before bundling a preview."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tarfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build(directory, commit, tag):
    version = tomllib.loads((ROOT / 'Cargo.toml').read_text())['workspace']['package']['version']
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'v' + re.escape(version) + r'-preview\.[1-9][0-9]*', tag):
        raise ValueError('A matching immutable preview tag and full source commit are required')
    names = [f'HeavenKey-{version}-{platform}' + ('.tar.gz' if platform.startswith('linux') else '.zip')
             for platform in ['macos-arm64','macos-x64','windows-x64','linux-arm64','linux-x64']]
    names += [f'HeavenKey-{version}-extension-{browser}.zip' for browser in ['chromium','firefox']]
    names += [f'HeavenKey-{version}-android-preview-{abi}.apk' for abi in ['arm64-v8a','armeabi-v7a','x86_64']]
    for name in names:
        if not (directory / name).is_file():
            raise ValueError(f'Missing release package: {name}')
    fingerprints = set()
    for name in names[:7]:
        path = directory / name
        if '-extension-' in name:
            with zipfile.ZipFile(path) as archive:
                metadata = json.loads(archive.read('BUILD.json'))
                manifest = json.loads(archive.read('manifest.json'))
                assert manifest['version'] == version
                assert 'inline.js' in archive.namelist()
        elif name.endswith('.zip'):
            with zipfile.ZipFile(path) as archive:
                metadata = json.loads(archive.read(name.removesuffix('.zip') + '/manifest.json'))
        else:
            with tarfile.open(path) as archive:
                metadata = json.load(archive.extractfile(name.removesuffix('.tar.gz') + '/manifest.json'))
        assert metadata['source_commit'] == commit and metadata['version'] == version, name
        fingerprints.add(metadata['source_fingerprint'])
    assert len(fingerprints) == 1, 'Platform packages were built from different inputs'
    preview = json.loads((directory / 'PREVIEW.json').read_text())
    assert preview['source_commit'] == commit and preview['version'] == version + '-preview'
    assert preview['production'] is False and preview['stable_publisher_identity'] is False
    assert preview['application_id'] == 'app.heavenkey.heavenkey_mobile.preview'
    assert {row['name'] for row in preview['artifacts']} == set(names[7:])
    for row in preview['artifacts']:
        assert digest(directory / row['name']) == row['sha256'], row['name']
    artifacts = {name: {'sha256': digest(directory / name), 'size': (directory / name).stat().st_size} for name in names}
    report = {'version': version, 'source_commit': commit, 'source_fingerprint': fingerprints.pop(),
              'tag': tag, 'production': False, 'complete_platform_set': True, 'artifacts': artifacts,
              'limits': ['Android preview identity only; no production APK/AAB or store upload',
                         'macOS ad-hoc integrity seals; no publisher signing/notarization',
                         'Chrome unpacked; Firefox temporary/unsigned; no store approval',
                         'Hardware verification and independent security audit deferred']}
    (directory / 'RELEASE.json').write_text(json.dumps(report, indent=2) + '\n')
    package_sums = ''.join(f'{digest(directory / name)}  {name}\n' for name in [*names, 'RELEASE.json', 'PREVIEW.json'])
    guide = f'''# HeavenKey {version} – App, Computer und Browser

Alle Pakete stammen aus Quellstand `{commit}`. Diese Ausgabe ist eine Vorschau.

## Das passende Paket öffnen

| Gerät | Datei |
| --- | --- |
| Android, die meisten aktuellen Handys | HeavenKey-{version}-android-preview-arm64-v8a.apk |
| Android mit 32-Bit-ARM | HeavenKey-{version}-android-preview-armeabi-v7a.apk |
| Android x86-64, Emulatoren | HeavenKey-{version}-android-preview-x86_64.apk |
| Mac mit Apple Silicon | HeavenKey-{version}-macos-arm64.zip |
| Mac mit Intel-Prozessor | HeavenKey-{version}-macos-x64.zip |
| Windows x64 | HeavenKey-{version}-windows-x64.zip |
| Linux x64 / ARM64 | HeavenKey-{version}-linux-x64.tar.gz / HeavenKey-{version}-linux-arm64.tar.gz |
| Chrome / Chromium | HeavenKey-{version}-extension-chromium.zip |
| Firefox | HeavenKey-{version}-extension-firefox.zip |

Desktop-Archiv vollständig entpacken. Auf dem Mac `HeavenKey.app`, unter Windows
`Start HeavenKey.cmd`, unter Linux `start.sh` öffnen. Die jeweilige beiliegende
Anleitung beschreibt Betriebssystemhinweise und den Datenordner.

Browser-Erweiterung entpacken. In Chrome unter `chrome://extensions` den
Entwicklermodus und „Entpackte Erweiterung laden“ verwenden. Firefox: unter
`about:debugging#/runtime/this-firefox` „Temporäres Add-on laden“ und `manifest.json`
auswählen. Lokales HeavenKey starten, Erweiterung mit einem einmaligen Code koppeln,
auf der Zielwebsite „Schlüssel auf dieser Website aktivieren“ wählen. Das Menü am
Feld bietet Login, Name/Adresse, Generator und Verwaltung.

Android benötigt Android 11 oder neuer; Website-Passkeys Android 14. Die Vorschau
hat eine von der Produktions-App getrennte Kennung und eine Testsignatur. Eine
bereits installierte Vorschau lässt sich mit einer anderen Testsignatur eventuell
nicht direkt aktualisieren. Keine Daten werden automatisch übernommen; keinen
ungesicherten Tresor deinstallieren. Nur Testdaten verwenden. Kein Play-Store-
Upload, keine dauerhafte Android-Herausgebersignatur, keine Apple-Notarisierung
oder Browser-Store-Signierung. Vor einem Kanalwechsel eine verschlüsselte Sicherung
mit getrenntem Schlüssel erstellen und die Wiederherstellung prüfen.

`PACKAGE-SHA256SUMS` prüft die enthaltenen Einzelpakete; die separat veröffentlichte
`SHA256SUMS` prüft auch dieses Gesamtarchiv. Unter Linux `sha256sum -c
PACKAGE-SHA256SUMS`, auf macOS `shasum -a 256 -c PACKAGE-SHA256SUMS` verwenden.
`RELEASE.json` und `PREVIEW.json` enthalten Quellstand, Version und Android-Zertifikat.

[Vollständige README](https://github.com/Supersynergy/HeavenKey/blob/{commit}/README.md)
· [Release](https://github.com/Supersynergy/HeavenKey/releases/tag/{tag})
· [Funktions- und Prozesskarten](https://github.com/Supersynergy/HeavenKey/blob/{commit}/docs/AUTOFILL-FLOWS.md)
'''
    bundle = directory / f'HeavenKey-{version}-all-platforms.zip'
    with zipfile.ZipFile(bundle, 'w', zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        for name in [*names, 'PREVIEW.json', 'RELEASE.json']:
            archive.write(directory / name, name)
        archive.writestr('README.md', guide)
        archive.writestr('PACKAGE-SHA256SUMS', package_sums)
        for name in ['LICENSE', 'docs/DISTRIBUTION.md', 'docs/AUTOFILL-COMPETITORS.md', 'docs/AUTOFILL-FLOWS.md', 'docs/releases/0.29.0.md']:
            archive.write(ROOT / name, name)
    sums = [*names, bundle.name, 'RELEASE.json', 'PREVIEW.json']
    (directory / 'SHA256SUMS').write_text(''.join(f'{digest(directory / name)}  {name}\n' for name in sums))
    print(f'Validated {len(names)} source-bound packages; complete bundle: {bundle.name}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    build(args.directory.resolve(), args.commit, args.tag)
