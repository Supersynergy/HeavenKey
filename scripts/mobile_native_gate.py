"""Check native configuration and execute the shared iOS origin policy.

This is a source/configuration gate, not a signed iOS build or browser-device proof.
"""
from pathlib import Path
import json
import plistlib
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
MOBILE = ROOT / 'apps/mobile'
ANDROID = '{http://schemas.android.com/apk/res/android}'
platform = sys.argv[1] if len(sys.argv) == 2 else 'all'
if platform not in ('android', 'ios', 'all'):
    raise SystemExit('expected android, ios or all')
checks = []

def require(condition, name):
    if not condition:
        raise SystemExit('FAIL: ' + name)
    checks.append(name)

if platform in ('android', 'all'):
    manifest = ET.parse(MOBILE / 'android/app/src/main/AndroidManifest.xml').getroot()
    app = manifest.find('application')
    require(app.get(ANDROID + 'allowBackup') == 'false', 'Android backup disabled')
    require(app.get(ANDROID + 'usesCleartextTraffic') == 'false', 'Android cleartext disabled')
    require(any(node.get(ANDROID+'name') == 'android.permission.INTERNET' for node in manifest.findall('uses-permission')), 'explicit paired TLS synchronization permission')
    provider = next(node for node in app.findall('service') if node.get(ANDROID+'name') == '.HeavenCredentialProvider')
    require(provider.get(ANDROID+'permission') == 'android.permission.BIND_CREDENTIAL_PROVIDER_SERVICE', 'system-only credential provider binding')
    passkey_activity = next(node for node in app.findall('activity') if node.get(ANDROID+'name') == '.PasskeyActivity')
    require(passkey_activity.get(ANDROID+'exported') == 'false', 'private passkey consent activity')
    service = next(node for node in app.findall('service') if node.get(ANDROID+'name') == '.HeavenAutofillService')
    require(service.get(ANDROID+'permission') == 'android.permission.BIND_AUTOFILL_SERVICE', 'autofill service system permission')
    require(service.get(ANDROID+'enabled') == 'true', 'adaptive browser service enabled')
    activity = next(node for node in app.findall('activity') if node.get(ANDROID+'name') == '.AutofillActivity')
    require(activity.get(ANDROID+'exported') == 'false', 'authentication activity is private')
    require(activity.get(ANDROID+'enabled') == 'true', 'explicit browser confirmation activity enabled')
    source = (MOBILE / 'android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/VaultStore.kt').read_text()
    require('setUserAuthenticationRequired(true)' in source and 'setUserAuthenticationParameters(60,' in source, 'Keystore authentication required')
    require('AES/GCM/NoPadding' in source and 'updateAAD(' in source, 'authenticated encryption configured')
    require('AtomicFile(' in source and 'noBackupFilesDir' in source and 'hasStoredData()' in source, 'atomic private vault and recovery detection')
    require('minSdk = 30' in (MOBILE/'android/app/build.gradle.kts').read_text(), 'Android API 30 minimum')

if platform in ('ios', 'all'):
    def plist(path):
        return plistlib.loads((MOBILE / 'ios' / path).read_bytes())
    runner = plist('Runner/Runner.entitlements')
    extension = plist('HeavenKeyAutofill/HeavenKeyAutofill.entitlements')
    require(runner['keychain-access-groups'] == extension['keychain-access-groups'], 'app and extension share one Keychain access group')
    for entitlements in (runner, extension):
        require(entitlements.get('com.apple.developer.authentication-services.autofill-credential-provider') is True, 'credential provider entitlement')
    require(plist('Runner/Info.plist')['HeavenKeyAccessGroup'] == plist('HeavenKeyAutofill/Info.plist')['HeavenKeyAccessGroup'], 'matching Keychain group substitutions')
    project = MOBILE / 'ios/Runner.xcodeproj/project.pbxproj'
    if shutil.which('plutil'):
        graph = json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', str(project)], timeout=15))
        objects = graph['objects']
        target = next(v for v in objects.values() if v.get('isa') == 'PBXNativeTarget' and v.get('name') == 'HeavenKeyAutofill')
        require(target['productType'] == 'com.apple.product-type.app-extension', 'actual extension target')
        runner_target = next(v for v in objects.values() if v.get('isa') == 'PBXNativeTarget' and v.get('name') == 'Runner')
        embeds = [objects[i] for i in runner_target['buildPhases'] if objects[i]['isa'] == 'PBXCopyFilesBuildPhase']
        require(any(str(phase.get('dstSubfolderSpec')) == '13' and any(objects[b]['fileRef'] == target['productReference'] for b in phase.get('files', [])) for phase in embeds), 'extension embedded in Runner')
        for native_target in (target, runner_target):
            sources = [objects[b]['fileRef'] for phase_id in native_target['buildPhases'] if objects[phase_id]['isa'] == 'PBXSourcesBuildPhase' for b in objects[phase_id]['files']]
            paths = [objects[ref].get('path') for ref in sources]
            require('Shared/VaultPolicy.swift' in paths and 'Shared/NativeVault.swift' in paths, 'shared native sources in target')
    else:
        raise SystemExit('plutil required to validate Xcode object graph; no iOS build claim')
    source = (MOBILE / 'ios/Shared/NativeVault.swift').read_text()
    require('kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly' in source and '.userPresence' in source, 'device-only user-presence Keychain policy')
    require('pendingUnlock' in source and 'generation' in source, 'authentication cancellation fencing configured')
    if shutil.which('swiftc'):
        with tempfile.TemporaryDirectory(prefix='heavenkey-policy-') as scratch:
            binary = str(Path(scratch) / 'policy')
            subprocess.run(['swiftc', '-swift-version', '5', str(MOBILE/'ios/Shared/VaultPolicy.swift'), str(ROOT/'scripts/mobile_policy_test.swift'), '-o', binary], check=True, timeout=45)
            subprocess.run([binary], check=True, timeout=10)
        checks.append('executed Swift HTTPS origin and record validation')
    else:
        raise SystemExit('swiftc required for executed native policy test')
print(json.dumps({'passed': True, 'kind': 'native-source-configuration-and-policy', 'checks': checks,
                  'signed_ios_build': False, 'real_browser_autofill_acceptance': False}))
