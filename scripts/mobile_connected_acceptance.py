"""Validate source-bound executed connected Android acceptance receipts."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent.parent
evidence = root / 'docs/evidence/mobile'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources(manifest):
    assert manifest, 'missing source binding'
    for relative, expected in manifest.items():
        path = (root / relative).resolve()
        assert path.is_relative_to(root) and path.is_file(), relative
        assert digest(path) == expected, 'stale connected proof: ' + relative


def receipt(name, required):
    data = json.loads((evidence / name).read_text())
    assert data.get('passed') is True, name
    assert data.get('synthetic_only') is True, name
    assert all(data.get(key) is True for key in required), name
    sources(data['source_files'])
    return data


passkeys = receipt('android-browser-passkeys.json', (
    'real_browser_credential_provider', 'cancellation_rejected',
    'wrong_rp_rejected_by_browser', 'app_browser_restart_persistence'))
assert passkeys['virtual_authenticator'] is False
assert passkeys['registrations'] >= 1 and passkeys['authentications'] >= 2
observation = json.loads(passkeys['mk_observation'])
assert observation['ok'] is True and json.loads(observation['value']) is True
sync = receipt('android-desktop-sync.json', (
    'actual_android_keystore_and_tls', 'actual_desktop_browser_ui',
    'pinned_certificate_rejection', 'end_to_end_encrypted',
    'bidirectional_login_updates', 'desktop_metadata_preserved',
    'website_passkeys_in_encrypted_desktop', 'deletion_no_resurrection',
    'explicit_conflict_resolution', 'stale_conflict_resolution_rejected',
    'device_revocation_rejected', 'mk_desktop_observation'))
assert passkeys['physical_device_acceptance'] is False
assert sync['physical_device_acceptance'] is False
autofill = json.loads((evidence / 'android-browser-adaptive.json').read_text())
sources(autofill['source_files'])
assert passkeys['apk_sha256'] == autofill['apk_sha256'], 'different normal APKs'
apk = root / 'dist/mobile/HeavenKey-0.25.0-android-preview.apk'
if apk.is_file():
    assert digest(apk) == passkeys['apk_sha256'], 'candidate APK differs'
review = json.loads((evidence / 'connected-review.json').read_text())
assert review['approved'] is True, 'independent review required'
sources(review['source_files'])
assert digest(evidence / 'connected-review.md') == review['report_sha256']
print('Connected Android emulator acceptance matched: browser passkeys, encrypted desktop sync, mk, identical normal APK and independent review; physical devices/iOS separate')
