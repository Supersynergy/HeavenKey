from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest


class CiFailureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="heavenkey-ci-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "scripts").mkdir()
        shutil.copyfile(Path(__file__).with_name("ci.sh"), self.root / "scripts/ci.sh")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        stub = bin_dir / "tool"
        stub.write_text(
            f"#!{sys.executable}\n"
            "from pathlib import Path\n"
            "import json, os, sys\n"
            "call = [Path(sys.argv[0]).name, *sys.argv[1:]]\n"
            "with open(os.environ['CI_TEST_TRACE'], 'a') as trace:\n"
            "    trace.write(json.dumps(call) + '\\n')\n"
            "raise SystemExit(23 if call == json.loads(os.environ.get('CI_TEST_FAIL', '[]')) else 0)\n"
        )
        stub.chmod(0o755)
        for name in ("cargo", "bun", "python3"):
            (bin_dir / name).symlink_to(stub.name)
        self.trace = self.root / "trace.jsonl"
        self.env = dict(
            os.environ,
            PATH=f"{bin_dir}:{os.environ['PATH']}",
            CI_TEST_TRACE=str(self.trace),
            HEAVENKEY_ADVISORIES_OFFLINE="0",
        )

    def run_stage(self, stage, **env):
        return subprocess.run(
            ["bash", "scripts/ci.sh", stage],
            cwd=self.root,
            env=dict(self.env, **env),
            capture_output=True,
            text=True,
            timeout=10,
        )

    def calls(self):
        return (
            [json.loads(line) for line in self.trace.read_text().splitlines()]
            if self.trace.exists()
            else []
        )

    def test_failed_check_stops_before_build_or_browser(self):
        for failure in (["cargo", "fmt", "--check"], ["bun", "audit"]):
            with self.subTest(failure=failure):
                self.trace.unlink(missing_ok=True)
                result = self.run_stage("all", CI_TEST_FAIL=json.dumps(failure))
                self.assertEqual(result.returncode, 23, result.stderr)
                self.assertEqual(self.calls()[-1], failure)
                self.assertNotIn(["bun", "run", "build"], self.calls())

    def test_failed_build_stops_before_browser(self):
        failure = ["cargo", "build", "--locked", "--offline"]
        result = self.run_stage("all", CI_TEST_FAIL=json.dumps(failure))
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(self.calls()[-1], failure)

    def test_browser_failure_is_preserved(self):
        failure = [
            "python3",
            "scripts/run.py",
            "ci-e2e",
            "180",
            "--",
            "bun",
            "scripts/e2e.mjs",
        ]
        result = self.run_stage("e2e", CI_TEST_FAIL=json.dumps(failure))
        self.assertEqual(result.returncode, 23, result.stderr)

    def test_unknown_stage_runs_no_tools(self):
        result = self.run_stage("soruce")
        self.assertEqual(result.returncode, 2)
        self.assertIn("Unknown CI stage", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_security_refreshes_advisories_by_default(self):
        result = self.run_stage("security")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["cargo", "audit", "--no-yanked"], self.calls())
        self.assertIn(["cargo", "deny", "--locked", "check"], self.calls())

    def test_local_security_uses_existing_advisories(self):
        result = self.run_stage("security", HEAVENKEY_ADVISORIES_OFFLINE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["cargo", "audit", "--no-fetch", "--no-yanked"], self.calls())
        self.assertIn(["cargo", "deny", "--locked", "--offline", "check"], self.calls())

    def test_prepare_removes_old_results_and_keeps_acceptance(self):
        evidence = self.root / "docs/evidence"
        evidence.mkdir(parents=True)
        stale = (
            "ci.log",
            "ci-source.log",
            "ci-e2e.log",
            "commands.jsonl",
            "e2e.json",
            "browser-success.png",
            "failure-owner.png",
            "failure-diagnostic.json",
            "heavenkey-missing-binary.json",
        )
        for name in (*stale, "acceptance.json", "ci-repair-local.json"):
            (evidence / name).write_text("old evidence")
        self.assertEqual(self.run_stage("prepare").returncode, 0)
        self.assertEqual(
            sorted(p.name for p in evidence.iterdir()),
            ["acceptance.json", "ci-repair-local.json"],
        )

    def test_prepare_works_without_an_evidence_directory(self):
        result = self.run_stage("prepare")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "docs/evidence").is_dir())


if __name__ == "__main__":
    unittest.main()
