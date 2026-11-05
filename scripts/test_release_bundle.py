"""Release provenance and complete-download integrity must fail closed."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import tomllib
import unittest
import zipfile

import release_bundle


class BundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.version = tomllib.loads((release_bundle.ROOT / 'Cargo.toml').read_text())['workspace']['package']['version']
        self.commit = 'a' * 40
        self.tag = f'v{self.version}-preview.1'
        binary = b'Synthetic desktop bytes, never an executable'
        self.metadata = {'version': self.version, 'source_commit': self.commit, 'source_fingerprint': 'b' * 64, 'binary_sha256': hashlib.sha256(binary).hexdigest()}
        for platform in ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-arm64', 'linux-x64']:
            name = f'HeavenKey-{self.version}-{platform}'
            data = json.dumps(self.metadata).encode()
            if platform.startswith('linux'):
                with tarfile.open(self.directory / (name + '.tar.gz'), 'w:gz') as archive:
                    info = tarfile.TarInfo(name + '/manifest.json')
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
                    info = tarfile.TarInfo(name + '/heavenkey')
                    info.size = len(binary)
                    archive.addfile(info, io.BytesIO(binary))
            else:
                with zipfile.ZipFile(self.directory / (name + '.zip'), 'w') as archive:
                    archive.writestr(name + '/manifest.json', data)
                    archive.writestr(name + ('/HeavenKey.exe' if platform == 'windows-x64' else '/heavenkey'), binary)
        for browser in ['chromium', 'firefox']:
            with zipfile.ZipFile(self.directory / f'HeavenKey-{self.version}-extension-{browser}.zip', 'w') as archive:
                archive.writestr('BUILD.json', json.dumps(self.metadata))
                archive.writestr('manifest.json', json.dumps({'version': self.version}))
                archive.writestr('inline.js', '// synthetic fixture only')
        artifacts = []
        for abi in ['arm64-v8a', 'armeabi-v7a', 'x86_64']:
            name = f'HeavenKey-{self.version}-android-preview-{abi}.apk'
            data = b'Synthetic unit-test bytes, not an installable APK'
            (self.directory / name).write_bytes(data)
            artifacts.append({'name': name, 'sha256': hashlib.sha256(data).hexdigest()})
        preview = {'version': self.version + '-preview', 'source_commit': self.commit, 'production': False,
                   'stable_publisher_identity': False, 'application_id': 'app.heavenkey.heavenkey_mobile.preview', 'artifacts': artifacts}
        (self.directory / 'PREVIEW.json').write_text(json.dumps(preview))

    def test_complete_download_contains_install_guide_and_verifiable_inner_packages(self):
        release_bundle.build(self.directory, self.commit, self.tag, self.metadata['source_fingerprint'])
        with zipfile.ZipFile(self.directory / f'HeavenKey-{self.version}-all-platforms.zip') as archive:
            self.assertIn('chrome://extensions', archive.read('README.md').decode())
            sums = archive.read('PACKAGE-SHA256SUMS').decode().splitlines()
            self.assertEqual(len(sums), 12)
            for row in sums:
                expected, name = row.split('  ', 1)
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), expected)

    def test_stale_source_and_incomplete_platform_sets_are_rejected(self):
        name = f'HeavenKey-{self.version}-extension-firefox.zip'
        with zipfile.ZipFile(self.directory / name, 'w') as archive:
            archive.writestr('BUILD.json', json.dumps({**self.metadata, 'source_commit': 'c' * 40}))
            archive.writestr('manifest.json', json.dumps({'version': self.version}))
            archive.writestr('inline.js', '// synthetic fixture only')
        with self.assertRaisesRegex(ValueError, 'Stale source'):
            release_bundle.build(self.directory, self.commit, self.tag, self.metadata['source_fingerprint'])
        (self.directory / name).unlink()
        with self.assertRaisesRegex(ValueError, 'Missing release package'):
            release_bundle.build(self.directory, self.commit, self.tag, self.metadata['source_fingerprint'])

    def test_matching_but_stale_platform_fingerprints_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'checked-out build inputs'):
            release_bundle.build(self.directory, self.commit, self.tag, 'c' * 64)

    def test_modified_desktop_binary_is_rejected(self):
        name = f'HeavenKey-{self.version}-windows-x64'
        with zipfile.ZipFile(self.directory / (name + '.zip'), 'w') as archive:
            archive.writestr(name + '/manifest.json', json.dumps(self.metadata))
            archive.writestr(name + '/HeavenKey.exe', b'changed synthetic bytes')
        with self.assertRaisesRegex(ValueError, 'Desktop binary mismatch'):
            release_bundle.build(self.directory, self.commit, self.tag, self.metadata['source_fingerprint'])
