"""Exercise a portable binary from a directory containing no source or assets."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--prefix", nargs="*", default=[])
    parser.add_argument("--windows-paths", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    command = [*args.prefix, str(binary)]
    cases = []
    with tempfile.TemporaryDirectory(prefix="heavenkey-portable-") as temporary:
        root = Path(temporary)
        env = os.environ.copy()
        data = root / "private data"
        data_path = str(data)
        if args.windows_paths:
            data_path = "Z:" + data_path.replace("/", "\\")
        protection = root / "synthetic-protection.key"
        protection.write_bytes(os.urandom(32))
        protection.chmod(0o600)
        protection_path = str(protection)
        if args.windows_paths:
            protection_path = "Z:" + protection_path.replace("/", "\\")
        env.update(UAC_DATA=data_path, UAC_PORT="18244", HEAVENKEY_KEY_FILE=protection_path, HEAVENKEY_ORIGIN="http://localhost:18244", HEAVENKEY_RP_ID="localhost")
        for arguments, expected in (
            (["--version"], 0),
            (["--help"], 0),
            (["--unknown"], 1),
            (["--port", "0"], 1),
        ):
            result = subprocess.run(
                [*command, *arguments],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=45,
            )
            assert (result.returncode == 0) == (expected == 0), (
                arguments,
                result.returncode,
                result.stderr,
            )
            if arguments == ["--version"]:
                assert "0.7.0" in result.stdout, result.stdout
            cases.append({"arguments": arguments, "pass": True})
        assert not data.exists(), (
            "Informational or invalid options must not initialize storage"
        )
        fingerprint = None
        for iteration in range(2):
            with (root / "server.log").open("w") as log:
                server = subprocess.Popen(
                    command, cwd=root, env=env, stdout=log, stderr=log
                )
                try:
                    deadline = time.monotonic() + 45
                    while True:
                        try:
                            response = urllib.request.urlopen(
                                "http://localhost:18244/health", timeout=1
                            )
                            assert json.load(response)["status"] == "ok"
                            break
                        except urllib.error.URLError:
                            if (
                                server.poll() is not None
                                or time.monotonic() >= deadline
                            ):
                                raise RuntimeError((root / "server.log").read_text())
                            time.sleep(0.1)
                    for resource, marker in (
                        ("/", b"HeavenKey"),
                        ("/main.js", b"navigator.credentials"),
                        ("/style.css", b":root"),
                    ):
                        with urllib.request.urlopen(
                            "http://localhost:18244" + resource, timeout=3
                        ) as response:
                            assert marker in response.read(), resource
                            assert (
                                "form-action 'self'"
                                in response.headers["Content-Security-Policy"]
                            )
                    request = urllib.request.Request(
                        "http://localhost:18244/api/register/start",
                        data=b'{"name":"guest"}',
                        headers={
                            "Content-Type": "application/json",
                            "Origin": "http://localhost:18244",
                        },
                    )
                    with urllib.request.urlopen(request, timeout=3) as response:
                        assert (
                            "challenge" in json.load(response)["options"]["publicKey"]
                        )
                    current = hashlib.sha256(
                        (data / "issuer.enc").read_bytes()
                    ).hexdigest()
                    if fingerprint is not None:
                        assert current == fingerprint, (
                            "Restart must retain the issuer key"
                        )
                    fingerprint = current
                    cases.append(
                        {
                            "restart": iteration,
                            "assets_embedded": True,
                            "registration_options": True,
                            "pass": True,
                        }
                    )
                finally:
                    server.terminate()
                    try:
                        server.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=5)
    report = {
        "pass": True,
        "binary": str(binary),
        "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "windows_compatibility": args.windows_paths,
        "cases": cases,
    }
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
