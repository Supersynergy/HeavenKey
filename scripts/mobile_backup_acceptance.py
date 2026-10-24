"""Require executed, source-matched native Android backup evidence."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent.parent
receipt = root/'docs/evidence/mobile/android-backup.json'
if not receipt.is_file():
    raise SystemExit('PENDING: native Android backup/file-picker evidence required')
data = json.loads(receipt.read_text())
checks = ['passed', 'device_authentication', 'fresh_archive_nonce', 'encrypted_export',
          'key_absent_from_archive', 'wrong_key_preserves_vault', 'tamper_preserves_vault',
          'stale_preview_preserves_vault', 'merge_preserves_existing_by_default',
          'explicit_replace_updates_existing', 'sensitive_copy_cleared_on_lock',
          'background_clipboard_regression', 'foreign_clipboard_preserved',
          'real_file_picker_save', 'real_file_picker_load', 'native_lock_after_picker',
          'unchanged_merge_skips_write', 'real_file_picker_cancel']
assert all(data.get(name) is True for name in checks), 'missing executed native acceptance'
assert data.get('source_files'), 'missing source binding'
for relative, expected in data['source_files'].items():
    path = (root/relative).resolve()
    assert path.is_relative_to(root), 'source outside project'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, 'stale native backup proof: '+relative
print('Native Android backup and document-picker receipt matched; iOS runtime acceptance separate')
