"""Early CI failures must never republish checked-in success receipts."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class FreshCiEvidence(unittest.TestCase):
    def test_prepare_removes_all_exportable_historical_successes(self):
        with tempfile.TemporaryDirectory(prefix="heavenkey-ci-evidence-") as name:
            root = Path(name)
            for relative in (
                "docs/evidence/ci-source.log",
                "docs/evidence/commands.jsonl",
                "docs/evidence/e2e.json",
                "docs/evidence/heavenkey-missing-binary.json",
                "docs/evidence/browser-success.png",
                "docs/evidence/failure-diagnostic.json",
                "docs/evidence/failure-synthetic.png",
                "docs/evidence/password-access/browser.json",
                "docs/evidence/password-broker/browser.json",
                "docs/evidence/transfer-broker/browser.json",
                "docs/evidence/protected-flow/browser.json",
                "apps/extension/TEST-RECEIPT.json",
            ):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{"passed":true,"historical_fixture":true}\n')
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=CI fixture",
                    "-c",
                    "user.email=ci@example.invalid",
                    "commit",
                    "-qm",
                    "synthetic receipts",
                ],
                cwd=root,
                check=True,
            )
            subprocess.run(
                ["bash", str(ROOT / "scripts/ci.sh"), "prepare"], cwd=root, check=True
            )
            exporter = (ROOT / "scripts/ci/export_evidence.py").read_text()
            self.assertEqual(exporter.count('destination = Path("/evidence")'), 1)
            exporter = exporter.replace(
                'destination = Path("/evidence")',
                f"destination = Path({str(root / 'output')!r})",
            )
            subprocess.run(
                [sys.executable, "-c", exporter],
                cwd=root,
                check=True,
                env={**os.environ, "GITHUB_SHA": "synthetic-current-job"},
            )
            manifest = json.loads((root / "output/manifest.json").read_text())
            self.assertEqual(manifest["source_commit"], "synthetic-current-job")
            self.assertEqual(
                manifest["files"],
                {},
                "early setup failure must export no historical test success",
            )


if __name__ == "__main__":
    unittest.main()
