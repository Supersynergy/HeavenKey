"""Runtime acceptance for the combined storage, identity and HTTPS workstreams."""

import contextlib
import hashlib
import json
import os
from pathlib import Path
import socket
import signal
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
BINARY = os.environ.get("HEAVENKEY_INTEGRATION_BINARY")


@unittest.skipUnless(BINARY, "run after build with HEAVENKEY_INTEGRATION_BINARY")
class WorkstreamIntegration(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="heavenkey-integrated-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / "data"
        self.data.mkdir(mode=0o700)
        self.protection = self.root / "protection.key"
        self.protection.write_bytes(bytes([9]) * 32)
        self.protection.chmod(0o600)
        self.document = self.root / "private.txt"
        self.document.write_text("Private integration document: synthetic only")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("HEAVENKEY_", "UAC_"))
        }
        self.env.update(
            UAC_DATA=str(self.data),
            UAC_PORT=str(self.port),
            UAC_STORE_KEY="0a" * 32,
            HEAVENKEY_KEY_FILE=str(self.protection),
            HEAVENKEY_DOCUMENT=str(self.document),
        )
        self.binary = str(Path(BINARY).resolve())

    def request(self, path, body=None, host=None):
        headers = {"Host": host or f"localhost:{self.port}"}
        if body is not None:
            headers.update(
                Origin=f"http://localhost:{self.port}",
                **{"Content-Type": "application/json"},
            )
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=None if body is None else json.dumps(body).encode(),
            headers=headers,
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            return json.load(response)

    @contextlib.contextmanager
    def server(self, overrides=None, host=None):
        log = tempfile.TemporaryFile()
        process = subprocess.Popen(
            [self.binary], env=self.env | (overrides or {}), stdout=log, stderr=log
        )
        try:
            for _ in range(100):
                if process.poll() is not None:
                    log.seek(0)
                    self.fail(log.read().decode(errors="replace"))
                try:
                    value = self.request("/api/config", host=host)
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.05)
            else:
                self.fail("owned integration server did not start within five seconds")
            yield value
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            log.close()

    def refuses_start(self, overrides):
        result = subprocess.run(
            [self.binary], env=self.env | overrides, capture_output=True, timeout=10
        )
        self.assertNotEqual(
            result.returncode, 0, result.stdout.decode(errors="replace")
        )
        return result.stderr.decode(errors="replace")

    def test_encrypted_database_and_protected_issuer_survive_restart(self):
        with self.server() as config:
            issuer = config["issuer_public_key"]
            self.assertTrue((self.data / "issuer.enc").is_file())
        self.assertNotEqual(
            (self.data / "uac.sqlite").read_bytes()[:16], b"SQLite format 3\0"
        )
        with self.server() as config:
            self.assertEqual(config["issuer_public_key"], issuer)

    def test_wrong_database_key_is_rejected_without_replacing_data(self):
        with self.server():
            pass
        before = hashlib.sha256((self.data / "uac.sqlite").read_bytes()).digest()
        self.assertIn(
            "store key rejected", self.refuses_start({"UAC_STORE_KEY": "0b" * 32})
        )
        self.assertEqual(
            hashlib.sha256((self.data / "uac.sqlite").read_bytes()).digest(), before
        )

    def test_wrong_protection_key_is_rejected(self):
        with self.server():
            pass
        self.protection.write_bytes(bytes([8]) * 32)
        self.assertIn("authentication failed", self.refuses_start({}))

    def test_plaintext_migration_preserves_data_and_legacy_issuer(self):
        self.data = self.root / "operator's data"
        self.data.mkdir(mode=0o700)
        self.env["UAC_DATA"] = str(self.data)
        legacy = self.data / "issuer.key"
        legacy.write_bytes(bytes([7]) * 32)
        legacy.chmod(0o600)
        with sqlite3.connect(self.data / "uac.sqlite") as db:
            db.execute("CREATE TABLE legacy_probe(value TEXT)")
            db.execute("INSERT INTO legacy_probe VALUES('keep-me')")
        with self.server():
            self.assertFalse(legacy.exists())
            self.assertTrue((self.data / "issuer.enc").is_file())
        result = subprocess.run(
            [
                self.binary,
                "--store-query",
                json.dumps({"sql": "SELECT value FROM legacy_probe"}),
            ],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [["keep-me"]])

    def test_database_and_envelope_custody_conflict_fails_closed(self):
        with self.server():
            pass
        before = (self.data / "issuer.enc").read_bytes()
        result = subprocess.run(
            [
                self.binary,
                "--store-query",
                json.dumps(
                    {
                        "sql": "UPDATE meta SET value=x'"
                        + "08" * 32
                        + "' WHERE key='issuer_key'",
                    }
                ),
            ],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("conflicting issuer custody", self.refuses_start({}))
        self.assertEqual((self.data / "issuer.enc").read_bytes(), before)

    def test_existing_envelope_and_plaintext_database_keep_identity(self):
        with self.server() as config:
            issuer = config["issuer_public_key"]
        for suffix in ("", "-wal", "-shm"):
            (self.data / f"uac.sqlite{suffix}").unlink(missing_ok=True)
        with sqlite3.connect(self.data / "uac.sqlite") as db:
            db.execute("CREATE TABLE legacy_probe(value TEXT)")
        with self.server() as config:
            self.assertEqual(config["issuer_public_key"], issuer)

    def test_public_origin_infers_rp_id_and_keeps_document_private(self):
        with self.server(
            {"HEAVENKEY_PUBLIC_ORIGIN": "https://heaven.example"}, "heaven.example"
        ) as config:
            self.assertEqual(config["rp_id"], "heaven.example")
            self.assertEqual(config["origin"], "https://heaven.example")
            self.assertNotIn(self.document.read_text(), json.dumps(config))

    def test_origin_alias_is_honored_and_conflicting_aliases_fail(self):
        with self.server(
            {"HEAVENKEY_ORIGIN": "https://heaven.example"}, "heaven.example"
        ) as config:
            self.assertEqual(config["origin"], "https://heaven.example")
        self.assertIn(
            "origin",
            self.refuses_start(
                {
                    "HEAVENKEY_ORIGIN": "https://other.example",
                    "HEAVENKEY_PUBLIC_ORIGIN": "https://heaven.example",
                }
            ).lower(),
        )

    def test_rp_id_cannot_change_for_the_same_data_directory(self):
        with self.server():
            pass
        self.assertIn(
            "RP ID differs",
            self.refuses_start({"HEAVENKEY_PUBLIC_ORIGIN": "https://heaven.example"}),
        )

    def test_local_maintenance_does_not_depend_on_listener_or_document(self):
        with self.server():
            pass
        env = self.env | {"HEAVENKEY_ORIGIN": "https://heaven.example"}
        env.pop("HEAVENKEY_DOCUMENT", None)
        env.pop("UAC_PORT", None)
        result = subprocess.run(
            [
                self.binary,
                "--store-query",
                '{"sql":"SELECT count(*) FROM meta"}',
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreaterEqual(json.loads(result.stdout)[0][0], 1)


if __name__ == "__main__":
    unittest.main()
