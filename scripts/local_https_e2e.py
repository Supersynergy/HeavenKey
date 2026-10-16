"""Run the HTTPS browser oracle through an owned Caddy proxy and test certificate."""

import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main():
    if not shutil.which("caddy") or not shutil.which("openssl"):
        raise SystemExit("local HTTPS acceptance requires installed caddy and openssl")
    with tempfile.TemporaryDirectory(prefix="heavenkey-https-") as temporary:
        directory = Path(temporary)
        api_port, tls_port = free_port(), free_port()
        while tls_port == api_port:
            tls_port = free_port()
        origin = f"https://heaven.test:{tls_port}"
        protection, document = directory / "protection.key", directory / "private.txt"
        protection.write_bytes(os.urandom(32))
        protection.chmod(0o600)
        document.write_text(
            "HeavenKey private HTTPS integration document: synthetic only"
        )
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=heaven.test",
                "-addext",
                "subjectAltName=DNS:heaven.test",
                "-keyout",
                str(directory / "tls.key"),
                "-out",
                str(directory / "tls.crt"),
            ],
            check=True,
            capture_output=True,
            timeout=20,
        )
        config = directory / "Caddyfile"
        config.write_text(
            "{\n admin off\n auto_https off\n}\n"
            + origin
            + " {\n"
            + f" bind 127.0.0.1\n tls {directory / 'tls.crt'} {directory / 'tls.key'}\n"
            + f" reverse_proxy 127.0.0.1:{api_port}\n}}\n"
        )
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("HEAVENKEY_", "UAC_"))
        }
        env.update(
            UAC_DATA=str(directory / "data"),
            UAC_PORT=str(api_port),
            UAC_STORE_KEY="0a" * 32,
            HEAVENKEY_KEY_FILE=str(protection),
            HEAVENKEY_PUBLIC_ORIGIN=origin,
            HEAVENKEY_DOCUMENT=str(document),
            HEAVENKEY_TEST_ORIGIN=origin,
            HEAVENKEY_TEST_DATA=str(directory / "data"),
            HEAVENKEY_LOCAL_TLS_TEST="1",
            HEAVENKEY_TEST_EVIDENCE=str(ROOT / "docs/evidence/https-integrated"),
        )
        if os.environ.get("CHROME_PATH"):
            env["CHROME_PATH"] = os.environ["CHROME_PATH"]
        children = []
        with tempfile.TemporaryFile() as log:
            try:
                children.append(
                    subprocess.Popen(
                        [str(ROOT / "target/debug/uac-api")],
                        env=env,
                        stdout=log,
                        stderr=log,
                    )
                )
                children.append(
                    subprocess.Popen(
                        [
                            "caddy",
                            "run",
                            "--config",
                            str(config),
                            "--adapter",
                            "caddyfile",
                        ],
                        env=env,
                        stdout=log,
                        stderr=log,
                    )
                )
                for _ in range(100):
                    if any(child.poll() is not None for child in children):
                        log.seek(0)
                        raise RuntimeError(log.read().decode(errors="replace"))
                    try:
                        request = urllib.request.Request(
                            f"http://127.0.0.1:{api_port}/health",
                            headers={"Host": f"heaven.test:{tls_port}"},
                        )
                        with urllib.request.urlopen(request, timeout=1) as response:
                            if json.load(response)["mode"] == "https-passkey-pilot":
                                break
                    except (OSError, urllib.error.URLError):
                        time.sleep(0.05)
                else:
                    raise RuntimeError("owned API startup timed out")
                subprocess.run(
                    ["bun", "scripts/https_e2e.mjs"],
                    cwd=ROOT,
                    env=env,
                    check=True,
                    timeout=180,
                )
            finally:
                for child in reversed(children):
                    if child.poll() is None:
                        child.send_signal(signal.SIGINT)
                        try:
                            child.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait(timeout=3)


if __name__ == "__main__":
    main()
