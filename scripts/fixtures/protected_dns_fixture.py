"""Disposable DNS/TLS fixture; contains only synthetic local test data."""

import http.server
import json
import os
from pathlib import Path
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import threading

ROLE = sys.argv[1]
ROOT = Path("/fixture")
DOMAIN = "rebind.heavenkey.test"
DNS_IP = "93.184.216.2"
GOOD_IP = "93.184.216.10"
EVIL_IP = "93.184.216.11"
USER = "dns-synthetic-user"
PASSWORD = "DNS-synthetic-password-only!"
state = {
    "role": ROLE,
    "queries": [],
    "login_posts": 0,
    "valid_login_posts": 0,
    "gets": 0,
}
lock = threading.Lock()


def json_response(handler, value):
    data = json.dumps(value).encode()
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class Control(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/facts":
            with lock:
                value = dict(state)
            if ROLE == "app":
                paths = sorted(Path("/tmp").glob("chromium-args-*.json"))
                value["launches"] = [json.loads(p.read_text()) for p in paths]
                value["process_alive"] = app.poll() is None
            json_response(self, value)
        elif self.path == "/resolve" and ROLE == "app":
            answers = sorted(
                {
                    r[4][0]
                    for r in socket.getaddrinfo(DOMAIN, 443, type=socket.SOCK_STREAM)
                }
            )
            json_response(self, {"answers": answers})
        else:
            self.send_error(404)


class DNS(socketserver.BaseRequestHandler):
    def handle(self):
        packet, sock = self.request
        if len(packet) < 17 or len(packet) > 4096:
            return
        end = 12
        labels = []
        while end < len(packet) and packet[end]:
            length = packet[end]
            if length > 63 or end + length + 1 >= len(packet):
                return
            labels.append(packet[end + 1 : end + length + 1].decode("ascii"))
            end += length + 1
        end += 1
        if end + 4 > len(packet):
            return
        name = ".".join(labels).lower()
        qtype, qclass = struct.unpack("!HH", packet[end : end + 4])
        answers = []
        with lock:
            if qtype == 1 and qclass == 1:
                if name == DOMAIN:
                    n = sum(
                        1
                        for row in state["queries"]
                        if row["name"] == name and row["type"] == 1
                    )
                    answers = [GOOD_IP if n == 0 else EVIL_IP]
                elif name == "private.heavenkey.test":
                    answers = ["127.0.0.1"]
                elif name == "mixed.heavenkey.test":
                    answers = [GOOD_IP, "127.0.0.1"]
            if name.endswith(".heavenkey.test"):
                state["queries"].append(
                    {"name": name, "type": qtype, "answers": answers}
                )
        flags = 0x8180 if name.endswith(".heavenkey.test") else 0x8183
        response = (
            packet[:2]
            + struct.pack("!HHHHH", flags, 1, len(answers), 0, 0)
            + packet[12 : end + 4]
        )
        for address in answers:
            response += (
                b"\xc0\x0c"
                + struct.pack("!HHIH", 1, 1, 0, 4)
                + socket.inet_aton(address)
            )
        sock.sendto(response, self.client_address)


class Site(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def reply(self, code, body, headers=()):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_GET(self):
        with lock:
            state["gets"] += 1
        if self.path == "/account":
            self.reply(
                200, "<title>Private synthetic page</title><p>" + PASSWORD + "</p>"
            )
        else:
            self.reply(
                200,
                "<!doctype html><form method='post' action='/login'><input name='username' autocomplete='username'><input type='password' name='password' autocomplete='current-password'><button>Login</button></form>",
            )

    def do_POST(self):
        from urllib.parse import parse_qs

        body = self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 16384))
        values = parse_qs(body.decode())
        with lock:
            state["login_posts"] += 1
            if values.get("username") == [USER] and values.get("password") == [
                PASSWORD
            ]:
                state["valid_login_posts"] += 1
        self.reply(
            302,
            "",
            [
                ("Location", "/account"),
                ("Set-Cookie", "dns_test=synthetic; HttpOnly; Path=/"),
            ],
        )


if ROLE == "dns":
    dns = socketserver.ThreadingUDPServer(("0.0.0.0", 53), DNS)
    threading.Thread(target=dns.serve_forever, daemon=True).start()
elif ROLE in ["good", "evil"]:
    site = http.server.ThreadingHTTPServer(("0.0.0.0", 443), Site)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(ROOT / "site.crt", ROOT / "site.key")
    site.socket = context.wrap_socket(site.socket, server_side=True)
    threading.Thread(target=site.serve_forever, daemon=True).start()
elif ROLE == "app":
    chrome = "/opt/heavenkey/browsers/chromium-1248/chrome-linux/chrome"
    if not Path(chrome).is_file():
        candidates = list(
            Path("/opt/heavenkey/browsers").glob("chromium-*/chrome-linux*/chrome")
        )
        if len(candidates) != 1:
            raise RuntimeError("Unambiguous cached Chromium required")
        chrome = str(candidates[0])
    spki = (ROOT / "spki.txt").read_text().strip()
    wrapper = Path("/tmp/chromium-fixture.py")
    wrapper.write_text(
        "#!/usr/bin/python3\nimport os,sys,socket,json,uuid\nfrom pathlib import Path\n"
        + "answers=sorted({r[4][0] for r in socket.getaddrinfo('rebind.heavenkey.test',443,type=socket.SOCK_STREAM)})\n"
        + "Path('/tmp/chromium-args-'+uuid.uuid4().hex+'.json').write_text(json.dumps({'resolver_rules':[a for a in sys.argv[1:] if a.startswith('--host-resolver-rules=')],'prelaunch_dns_answers':answers}))\n"
        + "os.execv("
        + repr(chrome)
        + ",["
        + repr(chrome)
        + ", '--no-sandbox', "
        + repr("--ignore-certificate-errors-spki-list=" + spki)
        + "]+sys.argv[1:])\n"
    )
    wrapper.chmod(0o755)
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("UAC_") and not k.startswith("HEAVENKEY_")
    }
    env["HEAVENKEY_BROKER_BROWSER"] = str(wrapper)
    app_log = open("/tmp/app.log", "w")
    app = subprocess.Popen(
        [
            "/fixture/heavenkey",
            "--password-manager",
            "--port",
            "18398",
            "--data-dir",
            "/tmp/vault",
        ],
        env=env,
        stdout=app_log,
        stderr=app_log,
    )
else:
    raise RuntimeError("Unknown fixture role")
http.server.ThreadingHTTPServer(("0.0.0.0", 18801), Control).serve_forever()
