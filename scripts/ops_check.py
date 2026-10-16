#!/usr/bin/env python3
"""Statische Pruefung der HeavenKey-Betriebskonfiguration (deploy/).

Prueft ohne installierte nginx-/caddy-Binaeren:
- Pflicht-Direktiven in deploy/caddy/Caddyfile und deploy/nginx/nginx.conf
  (TLS >= 1.2, keine schwachen Cipher, Upstream 127.0.0.1:18240,
  unveraenderte Host/Origin, statische Health-Route, begrenzte Timeouts,
  Body-Limit >= 32 KiB,
  HSTS).
- Haertungs-Defaults in deploy/systemd/*.service (NoNewPrivileges,
  ProtectSystem, PrivateTmp, StateDirectory, Restart, nicht-root User).
- Keine Klartext-Secrets in deploy/ (Private-Key-Bloecke, Token/Passwort-
  Zuweisungen).
- Konsistenter Upstream-Port 18240 ueber alle Configs und docs/OPERATIONS.md.
- Oeffentliche HTTPS-Identitaet und externe Headless-Schluesseldatei.

Exit-Code 0 = alles ok, 1 = mindestens ein Fehler, 2 = Aufruffehler.
Ausgabe: menschenlesbare Zeilen plus optionalem JSON-Report (--json),
z. B. fuer docs/evidence/ops-check.json. Siehe docs/OPERATIONS.md.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import shlex
import sys
from pathlib import Path
from urllib.parse import urlsplit

API_UPSTREAM_PORT = 18240
MIN_BODY_BYTES = 32 * 1024  # DefaultBodyLimit::max(32 * 1024) in apps/api

DEPLOY_FILES = [
    "deploy/caddy/Caddyfile",
    "deploy/nginx/nginx.conf",
    "deploy/systemd/uac-api.service",
    "deploy/systemd/uac-gate.service",
    "deploy/systemd/api.env.example",
]
DOC_FILE = "docs/OPERATIONS.md"

# Cipher-/Schluesselwoerter, die nicht vorkommen duerfen (TLS < 1.3-Niveau).
WEAK_TOKENS = re.compile(
    r"\b(RC4|3DES|DES-CBC|DES\b|NULL|aNULL|eNULL|EXPORT|EXP|MD5|ADH|DSS|"
    r"SEED|IDEA|CAMELLIA|SHA1)\b"
)

# Klartext-Secret-Muster fuer deploy/*: Private-Key-Bloecke und
# "name = wert"-Zuweisungen typischer Secret-Namen mit langem Wert.
SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(
        r"(?i)\b(api[_-]?key|secret|password|passwd|token|privkey|"
        r"private[_-]?key|issuer[_-]?key|UAC_STORE_KEY)\s*[:=]\s*"
        r"['\"]?[A-Za-z0-9+/_.=-]{12,}"
    ),
]


class Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def add(self, check_id: str, path: str, ok: bool, detail: str) -> None:
        self.checks.append(
            {
                "check": check_id,
                "file": path,
                "status": "pass" if ok else "fail",
                "detail": detail,
            }
        )
        print(f"{'PASS' if ok else 'FAIL'} {check_id:28} {path}: {detail}")

    @property
    def ok(self) -> bool:
        return all(c["status"] == "pass" for c in self.checks)

    def to_json(self) -> dict:
        failed = [c for c in self.checks if c["status"] == "fail"]
        return {
            "tool": "ops_check",
            "scope": "deploy/ + docs/OPERATIONS.md",
            "ok": self.ok,
            "total": len(self.checks),
            "failed": len(failed),
            "checks": self.checks,
        }


def strip_comments(text: str) -> str:
    """Entfernt #-Kommentare bis Zeilenende (ausreichend fuer unsere Dateien)."""
    out_lines = []
    for line in text.splitlines():
        # '#' am Zeilenanfang oder nach Whitespace beginnt einen Kommentar.
        out_lines.append(re.sub(r"(?<!['\"#])(?<!\S)#.*$", "", line))
    return "\n".join(out_lines)


def parse_size(raw: str) -> int | None:
    """Parst Groessenangaben wie 64k, 64KB, 64KiB, 32M, 1048576 in Bytes."""
    m = re.fullmatch(r"\s*(\d+)\s*([A-Za-z]*)", raw)
    if not m:
        return None
    value, unit = int(m.group(1)), m.group(2).lower()
    factors = {
        "": 1,
        "b": 1,
        "k": 1024,
        "kb": 1000,
        "kib": 1024,
        "m": 1024**2,
        "mb": 10**6,
        "mib": 1024**2,
        "g": 1024**3,
        "gb": 10**9,
        "gib": 1024**3,
    }
    if unit not in factors:
        return None
    return value * factors[unit]


def bounded_timeouts(body: str, names: list[str]) -> bool:
    """Reject missing, disabled or over-two-minute template timeouts."""
    for name in names:
        values = re.findall(rf"(?m)^\s*{re.escape(name)}\s+([^\s;}}]+)", body)
        if not values:
            return False
        for value in values:
            match = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m)", value)
            if not match:
                return False
            seconds = (
                float(match.group(1)) * {"ms": 0.001, "s": 1, "m": 60}[match.group(2)]
            )
            if not 0 < seconds <= 120:
                return False
    return True


def check_caddy(text: str, rel: str, report: Report) -> None:
    body = strip_comments(text)

    def has(pattern: str) -> bool:
        return re.search(pattern, body) is not None

    report.add("caddy-tls", rel, has(r"(?m)^\s*tls\b"), "tls-Direktive vorhanden")
    proto = re.search(r"protocols\s+([^\n}]+)", body)
    proto_ok = bool(
        proto
        and "tls1.2" in proto.group(1)
        and "tls1.3" in proto.group(1)
        and not re.search(r"tls1\.[01]\b|tls1\b(?!\.[23])|ssl3", proto.group(1))
    )
    report.add(
        "caddy-tls-versions",
        rel,
        proto_ok,
        "protocols auf tls1.2/tls1.3 begrenzt",
    )
    ciphers = re.search(r"(?m)^\s*ciphers\s+([^\n}]+)", body)
    weak = WEAK_TOKENS.search(ciphers.group(1)) if ciphers else None
    report.add(
        "caddy-ciphers",
        rel,
        ciphers is not None and weak is None,
        "keine schwachen TLS1.2-Cipher",
    )
    report.add(
        "caddy-upstream",
        rel,
        has(
            rf"reverse_proxy\s+(?:https?://)?(?:127\.0\.0\.1|localhost):{API_UPSTREAM_PORT}\b"
        ),
        f"reverse_proxy -> 127.0.0.1:{API_UPSTREAM_PORT}",
    )
    report.add(
        "caddy-public-identity",
        rel,
        not has(r"(?im)^\s*header_up\s+[+\-]?(?:Host|Origin)\b"),
        "Host und Origin unveraendert (Caddy-Default)",
    )
    report.add(
        "caddy-health",
        rel,
        has(r"respond\s+/healthz\b") and has(r"respond\s+/healthz[^\n]*\b200\b"),
        "statische Health-Route /healthz -> 200",
    )
    size = re.search(r"max_size\s+([^\n}\s]+)", body)
    parsed = parse_size(size.group(1)) if size else None
    report.add(
        "caddy-body-limit",
        rel,
        parsed is not None and parsed >= MIN_BODY_BYTES,
        f"request_body max_size >= {MIN_BODY_BYTES} Bytes (API: 32 KiB)",
    )
    report.add(
        "caddy-hsts",
        rel,
        has(r"Strict-Transport-Security"),
        "HSTS-Header dokumentiert/gesetzt",
    )
    report.add(
        "caddy-timeouts",
        rel,
        bounded_timeouts(
            body,
            [
                "dial_timeout",
                "response_header_timeout",
                "read_timeout",
                "write_timeout",
            ],
        ),
        "alle Upstream-Timeouts > 0 und <= 120s",
    )


def check_nginx(text: str, rel: str, report: Report) -> None:
    body = strip_comments(text)

    def has(pattern: str) -> bool:
        return re.search(pattern, body) is not None

    report.add(
        "nginx-listen-tls",
        rel,
        has(r"listen\s+[^\n;]*443[^\n;]*\bssl\b"),
        "listen 443 ssl konfiguriert",
    )
    proto = re.search(r"ssl_protocols\s+([^;]+);", body)
    proto_val = proto.group(1) if proto else ""
    proto_ok = bool(
        proto
        and re.search(r"\bTLSv1\.2\b", proto_val)
        and re.search(r"\bTLSv1\.3\b", proto_val)
        and not re.search(
            r"\b(TLSv1\.0|TLSv1\.1|SSLv2|SSLv3)\b|\bTLSv1\b(?!\.)", proto_val
        )
    )
    report.add(
        "nginx-tls-versions",
        rel,
        proto_ok,
        "ssl_protocols auf TLSv1.2/TLSv1.3 begrenzt",
    )
    ciphers = re.search(r"ssl_ciphers\s+['\"]?([^;'\"\n]+)", body)
    weak = WEAK_TOKENS.search(ciphers.group(1)) if ciphers else None
    report.add(
        "nginx-ciphers",
        rel,
        ciphers is not None and weak is None,
        "keine schwachen TLSv1.2-Cipher",
    )
    report.add(
        "nginx-cert",
        rel,
        has(r"ssl_certificate\s+\S+;") and has(r"ssl_certificate_key\s+\S+;"),
        "Zertifikat und Schluessel-Pfad gesetzt",
    )
    upstream = has(
        rf"proxy_pass\s+http://(?:127\.0\.0\.1|localhost):{API_UPSTREAM_PORT}\b"
    ) or (
        has(r"upstream\s+\w+\s*{")
        and has(rf"server\s+127\.0\.0\.1:{API_UPSTREAM_PORT}\s*;")
        and has(r"proxy_pass\s+http://\w+\s*;")
    )
    report.add(
        "nginx-upstream",
        rel,
        upstream,
        f"proxy_pass/upstream -> 127.0.0.1:{API_UPSTREAM_PORT}",
    )
    report.add(
        "nginx-public-identity",
        rel,
        re.findall(r"(?im)^\s*proxy_set_header\s+Host\s+([^;]+);", body)
        == ["$http_host"]
        and not has(r"(?im)^\s*proxy_set_header\s+Origin\b"),
        "Host=$http_host und Origin unveraendert",
    )
    report.add(
        "nginx-health",
        rel,
        has(r"location\s*=\s*/healthz") and has(r"return\s+200\b"),
        "statische Health-Route /healthz -> 200",
    )
    size = re.search(r"client_max_body_size\s+([^\s;]+)\s*;", body)
    parsed = parse_size(size.group(1)) if size else None
    report.add(
        "nginx-body-limit",
        rel,
        parsed is not None and parsed >= MIN_BODY_BYTES,
        f"client_max_body_size >= {MIN_BODY_BYTES} Bytes (API: 32 KiB)",
    )
    report.add(
        "nginx-hsts",
        rel,
        has(r"add_header\s+Strict-Transport-Security"),
        "HSTS-Header dokumentiert/gesetzt",
    )
    report.add(
        "nginx-timeouts",
        rel,
        bounded_timeouts(
            body,
            [
                "proxy_connect_timeout",
                "proxy_read_timeout",
                "proxy_send_timeout",
                "client_header_timeout",
                "client_body_timeout",
            ],
        ),
        "alle Proxy-/Client-Timeouts > 0 und <= 120s",
    )


def check_systemd(text: str, rel: str, report: Report) -> None:
    body = strip_comments(text)
    name = Path(rel).stem

    def directive(key: str) -> str | None:
        m = re.search(rf"(?m)^{re.escape(key)}=([^\n]+)", body)
        return m.group(1).strip() if m else None

    report.add(
        f"systemd-exec-{name}",
        rel,
        bool(directive("ExecStart")) and name in (directive("ExecStart") or ""),
        f"ExecStart referenziert {name}",
    )
    user = directive("User") or ""
    report.add(
        f"systemd-user-{name}",
        rel,
        bool(user) and user != "root",
        f"dedizierter Nicht-Root-User ({user or 'fehlt'})",
    )
    report.add(
        f"systemd-nnp-{name}",
        rel,
        directive("NoNewPrivileges") == "yes",
        "NoNewPrivileges=yes",
    )
    protect = directive("ProtectSystem") or ""
    report.add(
        f"systemd-protectsystem-{name}",
        rel,
        protect in {"yes", "full", "strict"},
        f"ProtectSystem={protect or 'fehlt'}",
    )
    report.add(
        f"systemd-privatetmp-{name}",
        rel,
        directive("PrivateTmp") == "yes",
        "PrivateTmp=yes",
    )
    report.add(
        f"systemd-statedir-{name}",
        rel,
        bool(directive("StateDirectory")),
        "StateDirectory fuer data/ gesetzt",
    )
    restart = directive("Restart") or ""
    report.add(
        f"systemd-restart-{name}",
        rel,
        restart in {"on-failure", "on-abnormal", "always"},
        f"Restart={restart or 'fehlt'} dokumentiert",
    )
    if name == "uac-api":
        report.add(
            "systemd-api-env",
            rel,
            directive("EnvironmentFile") == "/etc/heavenkey/api.env",
            "verbindliche Service-Umgebung /etc/heavenkey/api.env",
        )
        report.add(
            "systemd-api-custody",
            rel,
            directive("StateDirectoryMode") == "0700"
            and directive("UMask") == "0077"
            and directive("ReadOnlyPaths") == "/etc/heavenkey",
            "private Daten und schreibgeschuetzte externe Konfiguration",
        )
        report.add(
            "systemd-api-restart-limit",
            rel,
            directive("StartLimitIntervalSec") == "60s"
            and directive("StartLimitBurst") == "3",
            "hoechstens drei Starts pro Minute",
        )


def check_environment(root: Path, report: Report) -> None:
    rel = "deploy/systemd/api.env.example"
    path = root / rel
    values = {}
    valid = path.is_file()
    if valid:
        for line in strip_comments(path.read_text(encoding="utf-8")).splitlines():
            if not line.strip():
                continue
            match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
            try:
                parts = shlex.split(match.group(2)) if match else []
            except ValueError:
                parts = []
            if not match or len(parts) != 1 or match.group(1) in values:
                valid = False
                continue
            values[match.group(1)] = parts[0]
    report.add("api-env-format", rel, valid, "eindeutige EnvironmentFile-Zuweisungen")
    origin = values.get("HEAVENKEY_PUBLIC_ORIGIN", "")
    try:
        url = urlsplit(origin)
        alias = urlsplit(values.get("HEAVENKEY_ORIGIN", origin))
        try:
            ipaddress.ip_address(url.hostname or "")
            dns = False
        except ValueError:
            dns = bool(url.hostname and "." in url.hostname)
        identity = (
            url.scheme == "https"
            and bool(url.hostname)
            and dns
            and not url.username
            and not url.password
            and not url.query
            and not url.fragment
            and url.path in {"", "/"}
            and values.get("HEAVENKEY_RP_ID") == url.hostname
            and (alias.scheme, alias.hostname, alias.port or 443)
            == (url.scheme, url.hostname, url.port or 443)
            and not alias.username
            and not alias.password
            and not alias.query
            and not alias.fragment
            and alias.path in {"", "/"}
        )
        _ = url.port  # Reject malformed ports even when the host is valid.
    except ValueError:
        identity = False
    report.add(
        "api-env-identity",
        rel,
        identity,
        "HTTPS-Domain, gleiche RP-ID, kein konkurrierender Origin-Override",
    )
    key = Path(values.get("HEAVENKEY_KEY_FILE", ""))
    store_key = Path(values.get("UAC_STORE_KEY_FILE", ""))
    document = Path(values.get("HEAVENKEY_DOCUMENT", ""))
    private = (
        all(
            path.is_absolute() and ".." not in path.parts and len(path.parts) > 2
            for path in [key, store_key, document]
        )
        and all(
            not path.is_relative_to("/var/lib/heavenkey") for path in [key, store_key]
        )
        and len({key, store_key, document}) == 3
        and "UAC_STORE_KEY" not in values
    )
    report.add(
        "api-env-private-files",
        rel,
        private,
        "getrennte absolute Dokument-/Schluesselpfade; beide Schluessel ausserhalb data/",
    )


def check_secrets(root: Path, report: Report) -> None:
    hits = []
    for path in sorted(root.glob("deploy/**/*")):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for line_no, line in enumerate(text.splitlines(), 1):
            for pattern in SECRET_PATTERNS:
                if pattern.search(line):
                    hits.append(f"{path.relative_to(root)}:{line_no}")
    report.add(
        "secrets-scan",
        "deploy/",
        not hits,
        "keine Klartext-Secrets" + (f" (Treffer: {', '.join(hits)})" if hits else ""),
    )


def check_port_consistency(root: Path, report: Report) -> None:
    """Alle Upstream-/Bind-Referenzen muessen Port 18240 nutzen."""
    found: dict[str, set[int]] = {}

    def add(rel: str, port: int) -> None:
        found.setdefault(rel, set()).add(port)

    for rel in DEPLOY_FILES:
        path = root / rel
        if not path.exists():
            continue
        body = strip_comments(path.read_text(encoding="utf-8"))
        # Upstream-Ziele (kein 'listen': das ist der oeffentliche TLS-Port).
        for m in re.finditer(
            r"(?:reverse_proxy|proxy_pass\s+http://|server\s+)"
            r"(?:https?://)?(?:127\.0\.0\.1|localhost|\w+):(\d+)",
            body,
        ):
            add(rel, int(m.group(1)))
        for m in re.finditer(r"--port\s+(\d+)", body):
            add(rel, int(m.group(1)))

    doc = root / DOC_FILE
    doc_ok = doc.exists() and str(API_UPSTREAM_PORT) in doc.read_text(
        encoding="utf-8", errors="replace"
    )
    report.add(
        "doc-mentions-port",
        DOC_FILE,
        doc_ok,
        f"docs/OPERATIONS.md nennt Port {API_UPSTREAM_PORT}",
    )

    bad = {
        rel: sorted(ports)
        for rel, ports in found.items()
        if ports != {API_UPSTREAM_PORT}
    }
    report.add(
        "port-consistency",
        "deploy/",
        not bad,
        f"alle Upstream-Referenzen auf Port {API_UPSTREAM_PORT}"
        + (f" (abweichend: {bad})" if bad else ""),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        default=Path(__file__).resolve().parent.parent,
        type=Path,
        help="Repo-Wurzel (Standard: uebergeordneter Ordner des Skripts)",
    )
    parser.add_argument(
        "--json",
        type=Path,
        default=None,
        help="JSON-Report in diese Datei schreiben (z. B. docs/evidence/ops-check.json)",
    )
    args = parser.parse_args()
    root = args.root.resolve()

    report = Report()
    for rel in DEPLOY_FILES + [DOC_FILE]:
        report.add(
            "exists",
            rel,
            (root / rel).is_file(),
            "Datei vorhanden" if (root / rel).is_file() else "Datei fehlt",
        )

    caddy_path = root / "deploy/caddy/Caddyfile"
    if caddy_path.is_file():
        check_caddy(
            caddy_path.read_text(encoding="utf-8"), "deploy/caddy/Caddyfile", report
        )
    nginx_path = root / "deploy/nginx/nginx.conf"
    if nginx_path.is_file():
        check_nginx(
            nginx_path.read_text(encoding="utf-8"), "deploy/nginx/nginx.conf", report
        )
    for rel in DEPLOY_FILES:
        if not rel.endswith(".service"):
            continue
        path = root / rel
        if path.is_file():
            check_systemd(path.read_text(encoding="utf-8"), rel, report)

    check_secrets(root, report)
    check_environment(root, report)
    check_port_consistency(root, report)

    summary = report.to_json()
    print(
        f"ops_check: {summary['total']} Checks, "
        f"{summary['failed']} Fehler -> {'OK' if summary['ok'] else 'FEHLER'}"
    )
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"Report: {args.json}")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
