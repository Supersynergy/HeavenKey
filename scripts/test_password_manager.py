"""Local password-vault HTTP boundary and durable CAS acceptance (synthetic only)."""

import json
import os
import sqlite3
import unittest
import urllib.error
import urllib.request

from scripts import test_workstream_integration as workstream


@unittest.skipUnless(os.environ.get("HEAVENKEY_INTEGRATION_BINARY"), "requires built API")
class PasswordManager(unittest.TestCase):
    server = workstream.WorkstreamIntegration.server

    def setUp(self):
        workstream.WorkstreamIntegration.setUp(self)
        self.env["HEAVENKEY_PASSWORD_MANAGER"] = "1"

    def request(self, path, body=None, host=None):
        return workstream.WorkstreamIntegration.request(self, "/health" if path == "/api/config" else path, body, host)

    def pm(self, path="", body=None, token=None, headers=None):
        request_headers = {
            "Host": f"localhost:{self.port}",
            "Origin": f"http://localhost:{self.port}",
            "X-HeavenKey-Client": "password-manager",
            "Content-Type": "application/json",
        }
        if token:
            request_headers["X-HeavenKey-Token"] = token
        request_headers.update(headers or {})
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/password-vault{path}",
            headers=request_headers,
            data=None if body is None else json.dumps(body).encode(),
        )
        with urllib.request.urlopen(req, timeout=3) as response:
            return json.load(response)

    def denied(self, expected, **kwargs):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.pm(**kwargs)
        self.assertEqual(caught.exception.code, expected)
        caught.exception.close()

    @staticmethod
    def record():
        return {"version": 1, "kdf": "PBKDF2-SHA256", "iterations": 600000,
                "salt": "AAAAAAAAAAAAAAAAAAAAAA", "iv": "AAAAAAAAAAAAAAAA",
                "ciphertext": "A" * 32}

    def test_origin_and_per_process_token_are_required(self):
        with self.server():
            self.denied(403, path="/config", headers={"Origin": "https://evil.test"})
            self.denied(403, path="/config", headers={"X-HeavenKey-Client": ""})
            self.denied(403, path="/config", headers={"Origin": "", "Sec-Fetch-Site": "cross-site"})
            token = self.pm("/config")["token"]
            self.assertGreaterEqual(len(token), 43)
            self.denied(403)
            self.denied(403, token="invalid")
            self.assertEqual(self.pm(token=token), {"revision": 0, "record": None})

    def test_persistence_conflicts_and_invalid_write_are_atomic(self):
        with self.server():
            token = self.pm("/config")["token"]
            record = self.record()
            saved = self.pm(body={"expected_revision": 0, "record": record}, token=token)
            self.assertEqual(saved, {"revision": 1, "record": record})
            self.denied(409, body={"expected_revision": 0, "record": record}, token=token)
            for invalid in [record | {"iterations": 1}, record | {"salt": "bad"},
                            record | {"ciphertext": "bad=="}, record | {"password": "plaintext"}]:
                self.denied(422, body={"expected_revision": 1, "record": invalid}, token=token)
            self.assertEqual(self.pm(token=token), saved)
        with self.server():
            self.denied(403, token=token)
            token = self.pm("/config")["token"]
            self.assertEqual(self.pm(token=token), saved)

    def test_password_manager_is_not_exposed_by_public_pilot(self):
        with self.server({"HEAVENKEY_PASSWORD_MANAGER": "0", "HEAVENKEY_PUBLIC_ORIGIN": "https://vault.example.test"}, host="vault.example.test"):
            self.denied(404, path="/config", headers={"Host": "vault.example.test", "Origin": "https://vault.example.test"})

    def test_no_os_keystore_and_no_lab_keys_needed_and_large_vault_works(self):
        self.env.pop("UAC_STORE_KEY")
        self.env.pop("HEAVENKEY_KEY_FILE")
        self.protection.unlink()
        with self.server():
            token = self.pm("/config")["token"]
            record = self.record() | {"ciphertext": "A" * 65536}
            self.assertEqual(self.pm(body={"expected_revision": 0, "record": record}, token=token)["revision"], 1)
            self.assertFalse((self.data / "issuer.enc").exists())
            self.assertFalse((self.data / "uac.sqlite").exists())

    def test_replacement_does_not_require_parsing_the_corrupt_old_record(self):
        with self.server():
            token = self.pm("/config")["token"]
            self.pm(body={"expected_revision": 0, "record": self.record()}, token=token)
        with sqlite3.connect(self.data / "passwords.sqlite") as db:
            db.execute("UPDATE password_manager SET record='invalid old JSON'")
        with self.server():
            config = self.pm("/config")
            self.assertEqual(config["revision"], 1)
            restored = self.pm(body={"expected_revision": 1, "record": self.record()}, token=config["token"])
            self.assertEqual(restored, {"revision": 2, "record": self.record()})


if __name__ == "__main__":
    unittest.main()
