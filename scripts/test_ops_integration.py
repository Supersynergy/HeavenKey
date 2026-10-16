"""Regression checks for HTTPS identity and headless service configuration."""

from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import tempfile
import unittest

import ops_check


ROOT = Path(__file__).resolve().parent.parent


class OpsIntegrationTests(unittest.TestCase):
    def check_proxy(self, name, text):
        report = ops_check.Report()
        with redirect_stdout(StringIO()):
            getattr(ops_check, f"check_{name}")(text, name, report)
        return {check["check"]: check["status"] for check in report.checks}

    def test_public_host_and_browser_origin_are_preserved(self):
        for name, path in [
            ("caddy", "deploy/caddy/Caddyfile"),
            ("nginx", "deploy/nginx/nginx.conf"),
        ]:
            with self.subTest(proxy=name):
                checks = self.check_proxy(name, (ROOT / path).read_text())
                self.assertEqual(checks.get(f"{name}-public-identity"), "pass")

    def test_identity_rewrites_are_rejected(self):
        for name, path, injection in [
            ("caddy", "deploy/caddy/Caddyfile", "header_up Host localhost:18240"),
            (
                "caddy",
                "deploy/caddy/Caddyfile",
                "header_up Origin https://lab.example.test",
            ),
            (
                "nginx",
                "deploy/nginx/nginx.conf",
                "proxy_set_header Origin https://lab.example.test;",
            ),
        ]:
            with self.subTest(proxy=name, injection=injection):
                checks = self.check_proxy(
                    name, (ROOT / path).read_text() + "\n" + injection
                )
                self.assertEqual(checks.get(f"{name}-public-identity"), "fail")
        text = (
            (ROOT / "deploy/nginx/nginx.conf")
            .read_text()
            .replace("Host $http_host;", "Host localhost:18240;")
        )
        self.assertEqual(
            self.check_proxy("nginx", text).get("nginx-public-identity"), "fail"
        )

    def test_disabled_or_unbounded_timeouts_are_rejected(self):
        for name, path, original in [
            ("caddy", "deploy/caddy/Caddyfile", "dial_timeout 5s"),
            ("nginx", "deploy/nginx/nginx.conf", "proxy_connect_timeout 5s"),
        ]:
            for invalid in ["0s", "600s", "invalid"]:
                with self.subTest(proxy=name, timeout=invalid):
                    text = (
                        (ROOT / path)
                        .read_text()
                        .replace(original, original.rsplit(" ", 1)[0] + " " + invalid)
                    )
                    self.assertEqual(
                        self.check_proxy(name, text).get(f"{name}-timeouts"), "fail"
                    )

    def test_missing_proxy_liveness_route_is_rejected(self):
        for name, path in [
            ("caddy", "deploy/caddy/Caddyfile"),
            ("nginx", "deploy/nginx/nginx.conf"),
        ]:
            with self.subTest(proxy=name):
                text = (ROOT / path).read_text().replace("/healthz", "/other")
                self.assertEqual(
                    self.check_proxy(name, text).get(f"{name}-health"), "fail"
                )

    def test_service_requires_headless_environment(self):
        text = (ROOT / "deploy/systemd/uac-api.service").read_text()
        for modified, expected in [
            (text, "pass"),
            (text.replace("EnvironmentFile=", "#EnvironmentFile="), "fail"),
        ]:
            report = ops_check.Report()
            with redirect_stdout(StringIO()):
                ops_check.check_systemd(
                    modified, "deploy/systemd/uac-api.service", report
                )
            checks = {check["check"]: check["status"] for check in report.checks}
            self.assertEqual(checks["systemd-api-env"], expected)

    def check_environment(self, root):
        report = ops_check.Report()
        with redirect_stdout(StringIO()):
            ops_check.check_environment(root, report)
        return {check["check"]: check["status"] for check in report.checks}

    def test_service_environment_matches_https_identity_and_key_custody(self):
        checks = self.check_environment(ROOT)
        self.assertTrue(checks)
        self.assertTrue(all(value == "pass" for value in checks.values()), checks)

    def test_database_key_has_a_separate_persistent_path(self):
        text = (ROOT / "deploy/systemd/api.env.example").read_text()
        self.assertIn("UAC_STORE_KEY_FILE=/etc/heavenkey/keys/store.key", text)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "deploy/systemd"
            target.mkdir(parents=True)
            for modified in [
                text.replace("UAC_STORE_KEY_FILE=", "#UAC_STORE_KEY_FILE="),
                text.replace(
                    "/etc/heavenkey/keys/store.key", "/var/lib/heavenkey/store.key"
                ),
                text.replace(
                    "/etc/heavenkey/keys/store.key",
                    "/etc/heavenkey/keys/protection.key",
                ),
            ]:
                (target / "api.env.example").write_text(modified)
                self.assertEqual(
                    self.check_environment(root).get("api-env-private-files"), "fail"
                )

    def test_matching_legacy_origin_alias_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "deploy/systemd"
            target.mkdir(parents=True)
            text = (ROOT / "deploy/systemd/api.env.example").read_text()
            (target / "api.env.example").write_text(
                text + "\nHEAVENKEY_ORIGIN=https://lab.example.test:443/\n"
            )
            self.assertEqual(
                self.check_environment(root).get("api-env-identity"), "pass"
            )

    def test_invalid_identity_and_in_data_key_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "deploy/systemd"
            target.mkdir(parents=True)
            source = ROOT / "deploy/systemd/api.env.example"
            self.assertTrue(
                source.is_file(), "headless service environment template is missing"
            )
            valid = source.read_text()
            for replacement in [
                valid.replace(
                    "HEAVENKEY_RP_ID=lab.example.test",
                    "HEAVENKEY_RP_ID=other.example.test",
                ),
                valid.replace("https://lab.example.test", "http://lab.example.test"),
                valid.replace("lab.example.test", "127.0.0.1"),
                valid.replace(
                    "/etc/heavenkey/keys/protection.key",
                    "/var/lib/heavenkey/protection.key",
                ),
                valid + "\nHEAVENKEY_ORIGIN=https://other.example.test\n",
            ]:
                (target / "api.env.example").write_text(replacement)
                self.assertIn("fail", self.check_environment(root).values())


if __name__ == "__main__":
    unittest.main()
