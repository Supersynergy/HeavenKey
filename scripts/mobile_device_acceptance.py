"""Final mobile acceptance stays closed until actual platform evidence exists."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent.parent
receipt = root / 'docs/evidence/mobile/device-acceptance.json'
if not receipt.is_file():
    raise SystemExit('PENDING: signed iOS build/install and real Android/iOS browser autofill evidence required')
data = json.loads(receipt.read_text())
required = ['device_authentication', 'crud_persistence', 'background_lock', 'browser_autofill',
            'wrong_origin_rejected', 'cancellation_rejected', 'signed_install']
for platform in ('android', 'ios'):
    entry = data.get(platform, {})
    assert all(entry.get(flow) is True for flow in required), platform + ': missing executed acceptance'
    evidence = entry.get('evidence', {})
    assert evidence, platform + ': missing source/evidence hashes'
    for relative, expected in evidence.items():
        path = (root / relative).resolve()
        assert path.is_relative_to(root), 'evidence outside project'
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, 'stale evidence: ' + relative
print(json.dumps({'passed': True, 'platforms': ['android', 'ios']}))
