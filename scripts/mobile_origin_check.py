"""Execute native JVM origin regressions and check the current browser receipt."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
sdk = Path(os.environ.get('ANDROID_HOME', '/opt/homebrew/share/android-commandlinetools'))
android = sdk / 'platforms/android-36/android.jar'
compiler = shutil.which('kotlinc')
if not compiler or not android.is_file():
    raise SystemExit('Kotlin compiler and Android API 36 SDK required for native policy regression')
native = root / 'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile'
with tempfile.TemporaryDirectory(prefix='heavenkey-origin-') as scratch:
    binary = str(Path(scratch) / 'policy.jar')
    subprocess.run([compiler, str(native/'OriginPolicy.kt'), str(native/'WebOriginPolicy.kt'),
                    str(root/'scripts/mobile_origin_test.kt'), '-classpath', str(android),
                    '-include-runtime', '-d', binary], check=True, timeout=60)
    subprocess.run(['java', '-cp', binary+os.pathsep+str(android),
                    'app.heavenkey.heavenkey_mobile.Mobile_origin_testKt'], check=True, timeout=15)
if '--policy-only' not in sys.argv:
    receipt = root / 'docs/evidence/mobile/android-browser-origin.json'
    if not receipt.is_file():
        raise SystemExit('PENDING: current real browser full-origin and port receipt required')
    data = json.loads(receipt.read_text())
    assert all(data.get(name) is True for name in ('passed', 'full_origin_filled', 'other_port_rejected', 'wrong_domain_rejected', 'cancellation_rejected'))
    assert data.get('source_files'), 'missing source binding'
    for relative, expected in data['source_files'].items():
        path = (root/relative).resolve()
        assert path.is_relative_to(root) and hashlib.sha256(path.read_bytes()).hexdigest() == expected, relative
print('Native full-origin policy accepted' + ('; browser acceptance separate' if '--policy-only' in sys.argv else '; current browser receipt matched'))
