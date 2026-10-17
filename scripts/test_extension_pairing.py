"""Real local HTTP pairing boundaries; all records and origins are synthetic."""

import json
import os
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from scripts import test_password_manager


@unittest.skipUnless(os.environ.get("HEAVENKEY_INTEGRATION_BINARY"), "requires built API")
class ExtensionPairing(test_password_manager.PasswordManager):
    chrome = "chrome-extension://" + "a" * 32
    firefox = "moz-extension://12345678-1234-1234-1234-123456789abc"

    def http(self, path="", body=None, method=None, origin=None, token=None, headers=None):
        request_headers = {
            "Host": f"localhost:{self.port}", "Origin": origin or self.chrome,
            "X-HeavenKey-Client": "password-extension", "Content-Type": "application/json",
        }
        if token:
            request_headers["X-HeavenKey-Token"] = token
        request_headers.update(headers or {})
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/password-vault{path}",
            data=None if body is None else json.dumps(body).encode(),
            method=method, headers=request_headers,
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            raw = response.read()
            return (json.loads(raw) if raw else None), response.headers

    def reject(self, status=403, **kwargs):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.http(**kwargs)
        self.assertEqual(caught.exception.code, status)
        caught.exception.close()

    def pair(self, app_token, origin=None):
        pending = self.pm("/extension/pairing", body={}, token=app_token)
        self.assertEqual(pending["expires_in"], 120)
        self.assertGreaterEqual(len(pending["code"]), 22)
        return self.http("/extension/connect", {"code": pending["code"]}, origin=origin)[0]

    def test_pairing_origin_cas_replacement_revoke_restart(self):
        with self.server():
            app_token = self.pm("/config")["token"]
            connected = self.pair(app_token)
            token = connected["token"]
            self.assertGreaterEqual(len(token), 43)
            self.assertNotEqual(token, app_token)
            self.assertEqual(connected["revision"], 0)
            self.reject(token=app_token)
            self.reject(token=token, origin=self.firefox)
            self.reject(path="/config", token=token)
            self.reject(path="/extension/pairing", token=token)
            self.assertEqual(self.http(token=token)[0], {"revision": 0, "record": None})
            record = self.record()
            saved = self.http(body={"expected_revision": 0, "record": record}, token=token)[0]
            self.assertEqual(saved, {"revision": 1, "record": record})
            self.reject(409, body={"expected_revision": 0, "record": record}, token=token)
            self.reject(422, body={"expected_revision": 1, "record": record | {"iterations": 1}}, token=token)
            self.assertEqual(self.pm(token=app_token), saved)
            replacement = self.pair(app_token)["token"]
            self.reject(token=token)
            self.assertEqual(self.http(token=replacement)[0], saved)
            status = self.pm("/extension/pairing", token=app_token)
            self.assertEqual(status, {"paired": 1, "pending": False, "origins": [self.chrome]})
            value, _ = self.http("/extension/pairing", method="DELETE", token=app_token,
                                 origin=f"http://localhost:{self.port}",
                                 headers={"X-HeavenKey-Client": "password-manager"})
            self.assertEqual(value, {"paired": 0})
            self.reject(token=replacement)
            restart_token = self.pair(app_token)["token"]
        with self.server():
            self.reject(token=restart_token)
            self.assertEqual(self.pm("/extension/pairing", token=self.pm("/config")["token"]),
                             {"paired": 0, "pending": False, "origins": []})

    def test_one_use_codes_attempt_bound_and_management_authority(self):
        with self.server():
            app_token = self.pm("/config")["token"]
            self.denied(403, path="/extension/pairing", body={})
            pending = self.pm("/extension/pairing", body={}, token=app_token)
            self.reject(path="/extension/connect", body={"code": pending["code"]},
                        origin=f"http://localhost:{self.port}")
            connected = self.http("/extension/connect", {"code": pending["code"]})[0]
            self.reject(path="/extension/connect", body={"code": pending["code"]})
            pending = self.pm("/extension/pairing", body={}, token=app_token)
            for _ in range(8):
                self.reject(path="/extension/connect", body={"code": "wrong"})
            self.reject(path="/extension/connect", body={"code": pending["code"]})
            self.assertEqual(self.http(token=connected["token"])[0]["revision"], 0)
            older = self.pm("/extension/pairing", body={}, token=app_token)["code"]
            newer = self.pm("/extension/pairing", body={}, token=app_token)["code"]
            self.reject(path="/extension/connect", body={"code": older})
            self.http("/extension/connect", {"code": newer}, origin=self.firefox)
            self.assertEqual(self.pm("/extension/pairing", token=app_token)["paired"], 2)
            pending = self.pm("/extension/pairing", body={}, token=app_token)
            self.http("/extension/pairing", method="DELETE", token=app_token,
                      origin=f"http://localhost:{self.port}",
                      headers={"X-HeavenKey-Client": "password-manager"})
            self.reject(path="/extension/connect", body={"code": pending["code"]})

    def test_concurrent_code_redemption_has_one_winner(self):
        with self.server():
            app_token = self.pm("/config")["token"]
            pending = self.pm("/extension/pairing", body={}, token=app_token)

            def redeem(_):
                try:
                    self.http("/extension/connect", {"code": pending["code"]})
                    return 200
                except urllib.error.HTTPError as error:
                    status = error.code
                    error.close()
                    return status

            with ThreadPoolExecutor(max_workers=2) as pool:
                self.assertEqual(sorted(pool.map(redeem, range(2))), [200, 403])
            self.assertEqual(self.pm("/extension/pairing", token=app_token)["paired"], 1)

    def test_post_read_keeps_strict_origin_and_empty_body(self):
        with self.server():
            app_token = self.pm("/config")["token"]
            token = self.pair(app_token)["token"]
            empty = {"revision": 0, "record": None}
            self.assertEqual(self.http("/read", {}, token=token)[0], empty)
            record = self.record()
            saved = self.pm(body={"expected_revision": 0, "record": record}, token=app_token)
            self.assertEqual(self.http("/read", {}, token=token)[0], saved)
            self.assertEqual(self.http(token=token)[0], saved)
            self.reject(path="/read", body={})
            self.reject(path="/read", body={}, token=app_token)
            self.reject(path="/read", body={}, token=token, origin=self.firefox)
            self.reject(path="/read", body={}, token=token, headers={"Origin": ""})
            self.reject(path="/read", body={}, token=token, origin="https://evil.test")
            self.reject(path="/read", body={}, token=token, headers={"Host": f"127.0.0.1:{self.port}"})
            self.reject(422, path="/read", body={"unexpected": True}, token=token)
            self.reject(422, path="/read", body=[], token=token)
            self.reject(405, path="/read", token=token)
            preflight = {"Access-Control-Request-Method": "POST",
                         "Access-Control-Request-Headers": "content-type,x-heavenkey-client,x-heavenkey-token"}
            _, headers = self.http("/read", method="OPTIONS", headers=preflight)
            self.assertEqual(headers["Access-Control-Allow-Origin"], self.chrome)
            self.reject(path="/read", method="OPTIONS", headers=preflight | {"Access-Control-Request-Method": "GET"})
            self.assertEqual(self.pm(token=app_token), saved)

    def test_cors_is_narrow_and_not_authority(self):
        with self.server():
            app_token = self.pm("/config")["token"]
            pending = self.pm("/extension/pairing", body={}, token=app_token)
            preflight = {"Access-Control-Request-Method": "POST",
                         "Access-Control-Request-Headers": "content-type,x-heavenkey-client,x-heavenkey-token"}
            for path in ("", "/extension/connect"):
                value, headers = self.http(path, method="OPTIONS", headers=preflight)
                self.assertIsNone(value)
                self.assertEqual(headers["Access-Control-Allow-Origin"], self.chrome)
                self.assertIsNone(headers["Access-Control-Allow-Credentials"])
            for origin in ("null", "https://evil.test", "http://localhost.evil.test",
                           "chrome-extension://" + "q" * 32, self.chrome + "/", self.chrome + ":80",
                           "moz-extension://invalid", self.firefox + "?x"):
                self.reject(method="OPTIONS", headers=preflight, origin=origin)
                self.reject(path="/extension/connect", body={"code": pending["code"]}, origin=origin)
            self.reject(method="OPTIONS", headers=preflight | {"Host": f"127.0.0.1:{self.port}"})
            self.reject(method="OPTIONS", headers=preflight | {"Access-Control-Request-Method": "DELETE"})
            self.reject(method="OPTIONS", headers=preflight | {"Access-Control-Request-Headers": "authorization"})
            self.reject(path="/config", method="OPTIONS", headers=preflight)
            self.reject(path="/extension/pairing", method="OPTIONS", headers=preflight)
            self.reject(path="/extension/connect", body={"code": pending["code"]},
                        headers={"X-HeavenKey-Client": "password-manager"})
            self.reject(413, path="/extension/connect", body={"code": "A" * (2 * 1024 * 1024)})
            connected, headers = self.http("/extension/connect", {"code": pending["code"]})
            self.assertEqual(headers["Access-Control-Allow-Origin"], self.chrome)
            self.reject(token=connected["token"], headers={"Host": f"127.0.0.1:{self.port}"})
            self.reject()

    def test_client_count_is_bounded(self):
        with self.server():
            app_token = self.pm("/config")["token"]
            for letter in "abcdefgh":
                self.pair(app_token, "chrome-extension://" + letter * 32)
            pending = self.pm("/extension/pairing", body={}, token=app_token)
            self.reject(409, path="/extension/connect", body={"code": pending["code"]}, origin=self.firefox)
            self.assertEqual(self.pm("/extension/pairing", token=app_token)["paired"], 8)
            self.pair(app_token)

    def test_code_expires_at_real_120_second_boundary(self):
        with self.server():
            app_token = self.pm("/config")["token"]
            pending = self.pm("/extension/pairing", body={}, token=app_token)
            time.sleep(120.1)
            self.reject(path="/extension/connect", body={"code": pending["code"]})
            self.assertFalse(self.pm("/extension/pairing", token=app_token)["pending"])


if __name__ == "__main__":
    unittest.main()
