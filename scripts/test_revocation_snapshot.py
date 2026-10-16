import base64
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "revocation_snapshot", Path(__file__).with_name("revocation_snapshot.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

HEX_A = "ab" * 32
HEX_B = "cd" * 32


class ParseRowsTest(unittest.TestCase):
    def test_text_ids(self):
        revoked = MODULE.parse_rows(json.dumps([[HEX_A], [HEX_B]]))
        self.assertEqual(revoked, sorted([HEX_A, HEX_B]))

    def test_dedup_and_sort(self):
        revoked = MODULE.parse_rows(json.dumps([[HEX_B], [HEX_A], [HEX_B]]))
        self.assertEqual(revoked, [HEX_A, HEX_B])

    def test_blob_id_decoded(self):
        blob = base64.b64encode(bytes.fromhex(HEX_A)).decode()
        revoked = MODULE.parse_rows(json.dumps([[{"blob_base64": blob}]]))
        self.assertEqual(revoked, [HEX_A])

    def test_rejects_bad_id(self):
        with self.assertRaises(SystemExit):
            MODULE.parse_rows(json.dumps([["not-hex"]]))

    def test_rejects_non_list_rows(self):
        with self.assertRaises(SystemExit):
            MODULE.parse_rows('{"rows": []}')

    def test_rejects_wide_row(self):
        with self.assertRaises(SystemExit):
            MODULE.parse_rows(json.dumps([[HEX_A, "extra"]]))


class WriteSnapshotTest(unittest.TestCase):
    def test_envelope_shape_and_atomic_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "sub" / "revocations.json"
            MODULE.write_snapshot(str(out), [HEX_A], 1700000000)
            data = json.loads(out.read_text())
            self.assertEqual(data, {"version": 1, "generated_at": 1700000000, "revoked": [HEX_A]})
            self.assertEqual([p for p in Path(tmp).rglob("*") if p.is_file()], [out])


if __name__ == "__main__":
    unittest.main()
