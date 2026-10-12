"""Install the unsigned preview in a disposable Firefox profile via Mozilla RDP."""

import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def receive(stream):
    size = b""
    while (byte := stream.read(1)) != b":":
        if not byte or len(size) > 10:
            raise RuntimeError("Invalid Firefox RDP frame")
        size += byte
    length = int(size)
    if length > 2_000_000:
        raise RuntimeError("Firefox RDP frame is too large")
    data = stream.read(length)
    if len(data) != length:
        raise RuntimeError("Truncated Firefox RDP frame")
    return json.loads(data)


def request(connection, stream, actor, kind, **parameters):
    data = json.dumps({"to": actor, "type": kind, **parameters}).encode()
    connection.sendall(str(len(data)).encode() + b":" + data)
    for _ in range(100):
        response = receive(stream)
        if response.get("from") == actor:
            if "error" in response:
                raise RuntimeError(str(response))
            return response
    raise RuntimeError("Firefox RDP response limit exceeded")


def main():
    binary = os.environ.get(
        "FIREFOX_PATH", "/Applications/Firefox.app/Contents/MacOS/firefox"
    )
    with tempfile.TemporaryDirectory(prefix="heavenkey-firefox-") as temporary:
        profile = Path(temporary)
        preferences = {
            "devtools.debugger.remote-enabled": True,
            "devtools.debugger.prompt-connection": False,
            "devtools.chrome.enabled": True,
            "browser.shell.checkDefaultBrowser": False,
            "browser.startup.homepage_override.mstone": "ignore",
        }
        (profile / "user.js").write_text(
            "".join(
                f"user_pref({json.dumps(name)}, {json.dumps(value)});\n"
                for name, value in preferences.items()
            )
        )
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        with (ROOT / "docs/evidence/extension-firefox-browser.log").open("w") as log:
            process = subprocess.Popen(
                [
                    binary,
                    "--headless",
                    "--no-remote",
                    "--profile",
                    str(profile),
                    "--start-debugger-server",
                    str(port),
                ],
                stdout=log,
                stderr=log,
            )
            try:
                deadline = time.monotonic() + 30
                while True:
                    try:
                        connection = socket.create_connection(
                            ("127.0.0.1", port), timeout=2
                        )
                        break
                    except OSError:
                        if process.poll() is not None or time.monotonic() >= deadline:
                            raise RuntimeError("Firefox debugger did not start")
                        time.sleep(0.1)
                with connection:
                    connection.settimeout(10)
                    with connection.makefile("rb") as stream:
                        receive(stream)
                        root = request(connection, stream, "root", "getRoot")
                        actor = root["addonsActor"]
                        result = request(
                            connection,
                            stream,
                            actor,
                            "installTemporaryAddon",
                            addonPath=str(ROOT / "dist/extension-firefox"),
                            openDevTools=False,
                        )
                        addon = result["addon"]
                        assert addon["id"] == "heavenkey@supersynergy.local", result
                        listed = request(connection, stream, "root", "listAddons")
                        matches = [
                            item
                            for item in listed["addons"]
                            if item["id"] == addon["id"]
                        ]
                        assert len(matches) == 1, listed
                        report = {
                            "pass": True,
                            "temporary_install": True,
                            "signed": False,
                            "addon": matches[0],
                            "popup_click_verified": False,
                        }
                        (ROOT / "docs/evidence/extension-firefox.json").write_text(
                            json.dumps(report, indent=2) + "\n"
                        )
                        print(json.dumps(report))
                        request(
                            connection,
                            stream,
                            actor,
                            "uninstallAddon",
                            addonId=addon["id"],
                        )
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
