"""Real Firefox, native context menu, paired Rust API; disposable synthetic data."""

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import urllib.request
from scripts.firefox_e2e import http, wait, ELEMENT

ROOT = Path(__file__).resolve().parent.parent
MASTER = "Synthetic-firefox-master-only!"
ORIGIN = "http://localhost:18267"
TARGET = "http://127.0.0.1:18268/"


def main():
    out = Path(os.environ["HEAVENKEY_FIREFOX_EXTENSION_REPORT"]).resolve()
    cases = []

    def case(name):
        cases.append({"name": name, "pass": True})
        print("PASS " + name, flush=True)

    class Fixture(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            body = b'<!doctype html><html><head><meta charset="utf-8"></head><body><form><label>Benutzername<input id="username" autocomplete="username"></label><label>Passwort<input id="password" type="password" autocomplete="current-password"></label><button>Login</button></form><form><label>E-Mail<input id="email" autocomplete="email"></label><label>Neues Passwort<input id="new-password" type="password" autocomplete="new-password"></label></form><input id="hidden" style="display:none" autocomplete="username"><script>window.submissions=0;document.querySelectorAll("form").forEach(f=>f.onsubmit=e=>{e.preventDefault();window.submissions++})</script></body></html>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 18268), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    binary = Path(
        os.environ.get("HEAVENKEY_BINARY", ROOT / "target/debug/uac-api")
    ).resolve()
    driver = backend = None
    session = None
    try:
        with tempfile.TemporaryDirectory(prefix="heavenkey-firefox-extension-") as tmp:
            temp = Path(tmp)
            extension = temp / "extension"
            shutil.copytree(ROOT / "dist/extension-source-firefox", extension)
            manifest = json.loads((extension / "manifest.json").read_text())
            manifest["host_permissions"] = ["http://localhost/*"]
            (extension / "manifest.json").write_text(json.dumps(manifest))
            uuid = "c58d4770-783f-4ccf-b511-32ed00d01d6b"
            env = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith(("UAC_", "HEAVENKEY_"))
            }
            with (
                (temp / "api.log").open("w") as api_log,
                (temp / "driver.log").open("w") as driver_log,
            ):
                backend = subprocess.Popen(
                    [
                        str(binary),
                        "--password-manager",
                        "--port",
                        "18267",
                        "--data-dir",
                        str(temp / "data"),
                    ],
                    env=env,
                    stdout=api_log,
                    stderr=api_log,
                )
                wait(lambda: reachable(ORIGIN + "/health"))

                def owner(path, body=None):
                    headers = {
                        "Origin": ORIGIN,
                        "X-HeavenKey-Client": "password-manager",
                        "Content-Type": "application/json",
                    }
                    if path != "/config":
                        headers["X-HeavenKey-Token"] = token
                    req = urllib.request.Request(
                        ORIGIN + "/api/password-vault" + path,
                        headers=headers,
                        data=None if body is None else json.dumps(body).encode(),
                    )
                    with urllib.request.urlopen(req, timeout=5) as r:
                        return json.load(r)

                token = owner("/config")["token"]
                script = (
                    "import {createVault} from './apps/web/src/passwords-crypto'; const v=await createVault('"
                    + MASTER
                    + "',{version:1,entries:[{id:'firefox-login',title:'Firefox fixture',username:'firefox@example.invalid',password:'Synthetic-firefox-login#42',url:'"
                    + TARGET
                    + "',notes:'',totp:'',tags:[],favorite:false}],profiles:[{id:'firefox-profile',title:'Kontaktvorlage',entities:{email:'profile@example.invalid'},updatedAt:new Date().toISOString()}]});console.log(JSON.stringify(v.envelope));"
                )
                record = json.loads(
                    subprocess.check_output(
                        ["bun", "-e", script], cwd=ROOT, text=True, timeout=20
                    )
                )
                owner("", {"expected_revision": 0, "record": record})
                pair = owner("/extension/pairing", {})
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", 0))
                    port = probe.getsockname()[1]
                base = f"http://localhost:{port}"
                driver = subprocess.Popen(
                    [
                        os.environ["GECKODRIVER_PATH"],
                        "--allow-system-access",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(port),
                    ],
                    stdout=driver_log,
                    stderr=driver_log,
                )
                wait(lambda: reachable(base + "/status"))
                created = http(
                    base + "/session",
                    "POST",
                    {
                        "capabilities": {
                            "alwaysMatch": {
                                "browserName": "firefox",
                                "moz:firefoxOptions": {
                                    "binary": os.environ.get(
                                        "FIREFOX_PATH",
                                        "/Applications/Firefox.app/Contents/MacOS/firefox",
                                    ),
                                    "args": ["-headless"],
                                    "prefs": {
                                        "extensions.webextensions.uuids": json.dumps(
                                            {"heavenkey@supersynergy.local": uuid}
                                        )
                                    },
                                },
                            }
                        }
                    },
                )["value"]
                session = base + "/session/" + created["sessionId"]

                def cmd(path, body=None, method=None):
                    return http(
                        session + path,
                        method or ("GET" if body is None else "POST"),
                        body,
                    ).get("value")

                def js(source, *args):
                    return cmd("/execute/sync", {"script": source, "args": list(args)})

                def asyncjs(source, *args):
                    return cmd("/execute/async", {"script": source, "args": list(args)})

                def click(selector):
                    el = cmd("/element", {"using": "css selector", "value": selector})
                    cmd("/element/" + el[ELEMENT] + "/click", {})

                def fill(identity, value):
                    js(
                        'let e=document.getElementById(arguments[0]);e.value=arguments[1];e.dispatchEvent(new Event("input",{bubbles:true}));',
                        identity,
                        value,
                    )

                def visible(identity):
                    return js(
                        "return !document.getElementById(arguments[0]).hidden;",
                        identity,
                    )

                def status():
                    return js(
                        'return document.getElementById("smart-status").textContent;'
                    )

                cmd("/moz/addon/install", {"path": str(extension), "temporary": True})
                cmd("/url", {"url": TARGET})
                target_handle = cmd("/window")
                # Invoke the actual XUL context-menu command after a native right click.
                el = cmd("/element", {"using": "css selector", "value": "#username"})
                cmd(
                    "/actions",
                    {
                        "actions": [
                            {
                                "type": "pointer",
                                "id": "mouse",
                                "parameters": {"pointerType": "mouse"},
                                "actions": [
                                    {
                                        "type": "pointerMove",
                                        "duration": 0,
                                        "origin": el,
                                        "x": 0,
                                        "y": 0,
                                    },
                                    {"type": "pointerDown", "button": 2},
                                    {"type": "pointerUp", "button": 2},
                                ],
                            }
                        ]
                    },
                )
                cmd("/moz/context", {"context": "chrome"})
                wait(
                    lambda: js(
                        'return [...document.querySelectorAll("menuitem")].some(e=>e.getAttribute("label")==="HeavenKey · Login sicher einfügen …");'
                    )
                )
                js(
                    '[...document.querySelectorAll("menuitem")].find(e=>e.getAttribute("label")==="HeavenKey · Login sicher einfügen …").doCommand();document.getElementById("contentAreaContextMenu").hidePopup();'
                )
                cmd("/moz/context", {"context": "content"})
                wait(lambda: len(cmd("/window/handles")) == 2)
                popup_handle = next(
                    h for h in cmd("/window/handles") if h != target_handle
                )
                cmd("/window", {"handle": popup_handle})
                wait(lambda: "intent=login" in cmd("/url"))
                case("Firefox native context menu opens the target-bound login preview")
                fill("pair-port", "18267")
                fill("pair-code", pair["code"])
                click("#pair-extension")
                wait(lambda: visible("unlock-form"))
                fill("extension-master", MASTER)
                click("#unlock-extension")
                wait(lambda: visible("smart-workspace"))
                case(
                    "Firefox pairs with Rust and unlocks encrypted vault using master fallback"
                )
                click('[data-id="firefox-login"]')
                click("#quick-login")
                wait(lambda: visible("fill-confirmation"))
                assert (
                    js(
                        'return document.querySelectorAll("[data-field]:checked").length;'
                    )
                    == 2
                ), status()
                click("#confirm-origin")
                click("#fill-selected")
                wait(lambda: "2 Felder gefüllt" in status())
                cmd("/window", {"handle": target_handle})
                values = js(
                    'return [username.value,password.value,document.getElementById("email").value,document.getElementById("new-password").value,document.getElementById("hidden").value,window.submissions];'
                )
                assert values == [
                    "firefox@example.invalid",
                    "Synthetic-firefox-login#42",
                    "",
                    "",
                    "",
                    0,
                ]
                case(
                    "activeTab permits exact-form login fill without target host permission; no signup, hidden field or submit"
                )
                cmd("/window", {"handle": popup_handle})
                click("#undo-fill")
                wait(lambda: "2 Felder zurückgesetzt" in status())
                click('[data-id="firefox-profile"]')
                click("#scan-page")
                wait(lambda: visible("fill-confirmation"))
                click("#confirm-origin")
                click("#fill-selected")
                wait(lambda: "Felder gefüllt" in status())
                cmd("/window", {"handle": target_handle})
                assert (
                    js('return document.getElementById("email").value;')
                    == "profile@example.invalid"
                )
                case(
                    "saved encrypted contact template fills the recognized form in Firefox"
                )
                cmd("/window", {"handle": popup_handle})
                cmd("/window/rect", {"width": 500, "height": 1000})
                stored = asyncjs(
                    "browser.storage.local.get(null).then(v=>arguments[arguments.length-1](v));"
                )
                assert (
                    list(stored) == ["heavenkey.extension.v1"]
                    and MASTER not in json.dumps(stored)
                    and "Synthetic-firefox-login#42" not in json.dumps(stored)
                )
                case(
                    "persistent extension storage contains pairing only, never vault plaintext"
                )
                click("#lock-extension")
                click("#passkey-extension")
                wait(lambda: len(cmd("/window/handles")) == 3)
                approve_handle = next(
                    h
                    for h in cmd("/window/handles")
                    if h not in [target_handle, popup_handle]
                )
                cmd("/window", {"handle": approve_handle})
                wait(
                    lambda: js(
                        'return !!document.querySelector("#extension-unlock-heading");'
                    )
                )
                wait(
                    lambda: js(
                        'return document.querySelector("[data-code]").textContent.length===8;'
                    )
                )
                code = js('return document.querySelector("[data-code]").textContent;')
                assert len(code) == 8
                click("[data-unlock]")
                wait(
                    lambda: js(
                        'return document.querySelector("[data-status]").textContent.includes("403");'
                    )
                )
                case(
                    "no enrolled PRF passkey gives explicit failure without unlocking extension"
                )
                cmd("/window", {"handle": popup_handle})
                assert not visible("smart-workspace")
                fill("extension-master", MASTER)
                click("#unlock-extension")
                wait(lambda: visible("smart-workspace"))
                case(
                    "password fallback cancels pending passkey handoff and remains usable"
                )
                out.with_suffix(".png").write_bytes(
                    __import__("base64").b64decode(cmd("/screenshot"))
                )
                cmd("/refresh", {})
                wait(lambda: visible("unlock-form"))
                assert not visible("smart-workspace")
                case("popup reload drops decrypted session and requires new unlock")
                result = {
                    "pass": True,
                    "cases": cases,
                    "browser": created["capabilities"]["browserVersion"],
                    "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                    "test_only_localhost_grant": True,
                    "target_host_permission": False,
                    "native_context_menu_command": True,
                    "synthetic_only": True,
                    "physical_biometric_tested": False,
                }
                out.write_text(json.dumps(result, indent=2) + "\n")
    finally:
        if session:
            try:
                http(session, "DELETE")
            except (OSError, RuntimeError):
                pass
        for p in [driver, backend]:
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=3)
        server.shutdown()
        server.server_close()


def reachable(url):
    try:
        return bool(http(url))
    except (OSError, RuntimeError):
        return False


if __name__ == "__main__":
    main()
