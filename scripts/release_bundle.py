"""Validate all platform versions and source provenance before bundling a preview."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
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
    bundle = directory / f'HeavenKey-{version}-all-platforms.zip'
    with zipfile.ZipFile(bundle, 'w', zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        for name in [*names, 'PREVIEW.json', 'RELEASE.json']:
            archive.write(directory / name, name)
        for name in ['README.md', 'LICENSE', 'docs/DISTRIBUTION.md', 'docs/AUTOFILL-COMPETITORS.md', 'docs/AUTOFILL-FLOWS.md', 'docs/releases/0.29.0.md']:
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
