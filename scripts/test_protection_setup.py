from pathlib import Path
import os
import tempfile
import unittest
from create_protection_key import create


class ProtectionSetupTests(unittest.TestCase):
    def test_existing_protection_key_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private' / 'protection.key'
            create(path)
            original = path.read_bytes()
            self.assertEqual(len(original), 32)
            if os.name != 'nt':
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                create(path)
            self.assertEqual(path.read_bytes(), original)
