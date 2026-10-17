"""Portable local-vault startup, HTTP isolation and restart with synthetic ciphertext."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--prefix-json", default="[]")
    parser.add_argument("--windows-paths", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve()
    command = [*json.loads(args.prefix_json), str(binary)]
    cases = []
    def encode(value):
        return base64.urlsafe_b64encode(value).decode().rstrip("=")
    record = {"version": 1, "kdf": "PBKDF2-SHA256", "iterations": 600000,
              "salt": encode(bytes(16)), "iv": encode(bytes(12)), "ciphertext": encode(bytes(48))}
    with tempfile.TemporaryDirectory(prefix="heavenkey-package-vault-") as temporary:
        root = Path(temporary)
        data = root / "private data"
        data_path = "Z:" + str(data).replace("/", "\\") if args.windows_paths else str(data)
        env = {key: value for key, value in os.environ.items() if not key.startswith(("UAC_", "HEAVENKEY_"))}
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        origin = f"http://localhost:{port}"

        def request(path, body=None, token=None, headers=None):
            request_headers = {"Origin": origin, "X-HeavenKey-Client": "password-manager", "Content-Type": "application/json"}
            if token:
                request_headers["X-HeavenKey-Token"] = token
            request_headers.update(headers or {})
            req = urllib.request.Request(origin + path, data=None if body is None else json.dumps(body).encode(), headers=request_headers)
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.load(response)

        version = subprocess.run([*command, "--version"], cwd=root, env=env, capture_output=True, text=True, timeout=45)
        assert version.returncode == 0 and "0.11.0" in version.stdout, version.stderr
        cases.append("version")
        previous_token = None
        for iteration in range(2):
            with (root / "server.log").open("w") as log:
                process = subprocess.Popen([*command, "--password-manager", "--port", str(port), "--data-dir", data_path], cwd=root, env=env, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 45
                    while True:
                        try:
                            assert request("/health")["mode"] == "local-password-manager"
                            break
                        except urllib.error.URLError:
                            if process.poll() is not None or time.monotonic() >= deadline:
                                raise RuntimeError((root / "server.log").read_text())
                            time.sleep(0.1)
                    for path, marker in [("/passwords/", b"Masterpasswort"), ("/passwords.js", b"PBKDF2"), ("/passwords.css", b":root")]:
                        with urllib.request.urlopen(origin + path, timeout=5) as response:
                            assert marker in response.read(), path
                            assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
                    token = request("/api/password-vault/config")["token"]
                    assert token != previous_token
                    if iteration == 0:
                        assert request("/api/password-vault", token=token) == {"revision": 0, "record": None}
                        assert request("/api/password-vault", {"expected_revision": 0, "record": record}, token)["revision"] == 1
                        cases.append("opaque ciphertext saved without OS keystore or lab keys")
                    else:
                        assert request("/api/password-vault", token=token) == {"revision": 1, "record": record}
                        try:
                            request("/api/password-vault", token=previous_token)
                            raise AssertionError("old token accepted")
                        except urllib.error.HTTPError as error:
                            assert error.code == 403
                            error.close()
                        cases.append("ciphertext retained and token rotated after restart")
                    try:
                        request("/api/password-vault/config", headers={"Origin": "https://evil.invalid"})
                        raise AssertionError("foreign origin accepted")
                    except urllib.error.HTTPError as error:
                        assert error.code == 403
                        error.close()
                    previous_token = token
                    cases.append(f"embedded assets and origin rejection restart {iteration}")
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
    report = {"pass": True, "binary": str(binary), "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "prefix": json.loads(args.prefix_json), "windows_compatibility": args.windows_paths, "cases": cases, "scope": "API portable runtime; no physical device or OS credential provider proof"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
