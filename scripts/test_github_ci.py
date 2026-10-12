from pathlib import Path
import hashlib
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import github_ci


class RunnerGateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="heavenkey-runner-test-")
        self.addCleanup(self.directory.cleanup)
        self.evidence = Path(self.directory.name)
        self.files = {
            "e2e.json": json.dumps(
                {"completed": True, "failed": 0, "passed": 138, "total": 138}
            ),
            "ci-source.log": 'test result: ok. 45 passed\n{"passed":75}\n',
            "ci-security.log": "audit passed",
            "ci-build.log": "build passed",
            "ci-e2e.log": "browser passed",
            "commands.jsonl": "",
        }
        for name, value in self.files.items():
            (self.evidence / name).write_text(value)
        self.manifest = {
            "head_commit": "approved-head",
            "run_id": "7",
            "files": {
                name: hashlib.sha256((self.evidence / name).read_bytes()).hexdigest()
                for name in self.files
            },
        }
        self.write_manifest()

    def write_manifest(self):
        (self.evidence / "manifest.json").write_text(json.dumps(self.manifest))

    def test_rejects_stale_run_and_wrong_commit(self):
        for field in ("head_commit", "run_id"):
            with self.subTest(field=field):
                saved = self.manifest[field]
                self.manifest[field] = "stale"
                self.write_manifest()
                with self.assertRaisesRegex(RuntimeError, "another commit or run"):
                    github_ci.validate_evidence(self.evidence, "approved-head", 7)
                self.manifest[field] = saved

    def test_rejects_tampered_report(self):
        (self.evidence / "e2e.json").write_text("changed")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            github_ci.validate_evidence(self.evidence, "approved-head", 7)

    def test_rejects_missing_evidence(self):
        self.manifest["files"].pop("ci-security.log")
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, "evidence is missing"):
            github_ci.validate_evidence(self.evidence, "approved-head", 7)

    def test_rejects_incomplete_browser_suite_even_with_valid_hash(self):
        path = self.evidence / "e2e.json"
        path.write_text(
            json.dumps({"completed": True, "failed": 0, "passed": 0, "total": 0})
        )
        self.manifest["files"][path.name] = hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, "Browser acceptance"):
            github_ci.validate_evidence(self.evidence, "approved-head", 7)

    def test_dirty_source_never_registers_a_runner(self):
        with (
            patch.object(
                github_ci,
                "command",
                return_value=subprocess.CompletedProcess([], 0, " M source\n", ""),
            ),
            patch.object(github_ci, "api") as api,
        ):
            with self.assertRaisesRegex(RuntimeError, "Commit and publish"):
                github_ci.run_ci("unused")
            api.assert_not_called()

    def test_workflow_in_progress_with_queued_job_is_reused(self):
        run = {"id": 7, "path": ".github/workflows/ci.yml", "status": "in_progress"}
        with patch.object(
            github_ci, "api", return_value={"jobs": [{"status": "queued"}]}
        ):
            self.assertIs(github_ci.select_queued_run([run]), run)

    def test_running_job_is_preserved(self):
        run = {"id": 7, "path": ".github/workflows/ci.yml", "status": "in_progress"}
        with patch.object(
            github_ci, "api", return_value={"jobs": [{"status": "in_progress"}]}
        ):
            with self.assertRaisesRegex(RuntimeError, "already running"):
                github_ci.select_queued_run([run])

    def test_public_repository_never_registers_a_runner(self):
        values = [
            subprocess.CompletedProcess([], 0, text, "")
            for text in ("", "approved-head", "branch")
        ]
        with (
            patch.object(github_ci, "command", side_effect=values),
            patch.object(
                github_ci,
                "api",
                return_value={"private": False, "permissions": {"admin": True}},
            ) as api,
        ):
            with self.assertRaisesRegex(RuntimeError, "private repository"):
                github_ci.run_ci("unused")
            self.assertEqual(api.call_count, 1)


if __name__ == "__main__":
    unittest.main()
