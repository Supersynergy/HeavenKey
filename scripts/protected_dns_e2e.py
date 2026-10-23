"""Exercise real DNS rebinding on an owned internal Docker network, without WAN."""

from pathlib import Path
import base64
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(
    os.environ.get("HEAVENKEY_DNS_REPORT", ROOT / "docs/evidence/protected-dns.json")
).resolve()
BINARY = Path(
    os.environ.get(
        "HEAVENKEY_DNS_BINARY",
        ROOT / "target/aarch64-unknown-linux-musl/release/uac-api",
    )
).resolve()
IMAGE = "sha256:a05f675057d8912a38880dfd6741207895c6a6b6876c11af2625b4015546135c"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


source_names = [
    "apps/api/src/password_manager/browser_executor.rs",
    "apps/api/src/password_manager/broker.rs",
    "apps/api/src/password_manager/broker/protected.rs",
    "scripts/protected_dns_e2e.py",
    "scripts/protected_dns_driver.ts",
    "scripts/fixtures/protected_dns_fixture.py",
]
sources = {f: sha(ROOT / f) for f in source_names}
network_name = "heavenkey-dns-" + uuid.uuid4().hex[:12]
network = None
containers = []
fixture_image = None
fixture_base = None
config = {}
passed = False
started = time.monotonic()
OUT.parent.mkdir(parents=True, exist_ok=True)


def run(args, seconds=20, optional=False, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=seconds)
    if result.returncode and not optional:
        raise RuntimeError(
            str(args[:3]) + ": " + result.stderr.decode(errors="replace")[-2000:]
        )
    return result


try:
    assert BINARY.read_bytes()[:4] == b"\x7fELF"
    binary_hash = sha(BINARY)
    facts = json.loads(run(["docker", "image", "inspect", IMAGE]).stdout)[0]
    assert facts["Architecture"] == "arm64" and facts["Config"]["User"] == "heavenkey"
    network = (
        run(
            [
                "docker",
                "network",
                "create",
                "--internal",
                "--subnet",
                "93.184.216.0/24",
                network_name,
            ]
        )
        .stdout.decode()
        .strip()
    )
    assert len(network) == 64
    net_facts = json.loads(run(["docker", "network", "inspect", network]).stdout)[0]
    assert (
        net_facts["Internal"]
        and net_facts["IPAM"]["Config"][0]["Subnet"] == "93.184.216.0/24"
    )
    with tempfile.TemporaryDirectory(prefix="heavenkey-dns-context-") as temp:
        fixture = Path(temp) / "fixture"
        fixture.mkdir()
        shutil.copy2(
            ROOT / "scripts/fixtures/protected_dns_fixture.py", fixture / "run.py"
        )
        run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-sha256",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=rebind.heavenkey.test",
                "-addext",
                "subjectAltName=DNS:rebind.heavenkey.test,DNS:private.heavenkey.test,DNS:mixed.heavenkey.test",
                "-keyout",
                str(fixture / "site.key"),
                "-out",
                str(fixture / "site.crt"),
            ]
        )
        pub = run(
            ["openssl", "x509", "-in", str(fixture / "site.crt"), "-pubkey", "-noout"]
        ).stdout
        der = run(["openssl", "pkey", "-pubin", "-outform", "DER"], data=pub).stdout
        spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
        (fixture / "spki.txt").write_text(spki)
        (fixture / "site.key").chmod(0o644)
        shutil.copy2(BINARY, fixture / "heavenkey")
        driver_source = (
            (ROOT / "scripts/protected_dns_driver.ts")
            .read_text()
            .replace(
                'from "playwright-core"',
                'from "/opt/heavenkey/deps/node_modules/playwright-core/index.mjs"',
            )
        )
        (fixture / "driver.ts").write_text(driver_source)
        (fixture / "config.json").write_text(
            json.dumps(
                {
                    "dns": "93.184.216.2",
                    "good": "93.184.216.10",
                    "evil": "93.184.216.11",
                    "app": "93.184.216.20",
                    "driver_report": "/tmp/dns-driver.json",
                }
            )
        )
        fixture_base = network_name + ":base"
        run(["docker", "image", "tag", IMAGE, fixture_base])
        assert (
            json.loads(run(["docker", "image", "inspect", fixture_base]).stdout)[0][
                "Id"
            ]
            == IMAGE
        )
        (Path(temp) / "Dockerfile").write_text(
            "FROM " + fixture_base + "\nCOPY --chown=501:20 fixture /fixture\n"
        )
        fixture_image = network_name + ":fixture"
        run(
            [
                "env",
                "DOCKER_BUILDKIT=0",
                "docker",
                "build",
                "--network=none",
                "--pull=false",
                "-t",
                fixture_image,
                temp,
            ],
            seconds=60,
        )
        for role, ip in [
            ("dns", "93.184.216.2"),
            ("good", "93.184.216.10"),
            ("evil", "93.184.216.11"),
            ("app", "93.184.216.20"),
        ]:
            args = [
                "docker",
                "create",
                "--pull=never",
                "--name",
                network_name + "-" + role,
                "--network",
                network_name,
                "--ip",
                ip,
                "--dns",
                "93.184.216.2",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges",
                "--read-only",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,exec,size=268435456",
                "--memory",
                "3g" if role == "app" else "256m",
                "--pids-limit",
                "768" if role == "app" else "128",
                "--cpus",
                "2",
                "--sysctl",
                "net.ipv4.ip_unprivileged_port_start=0",
                "-e",
                "HOME=/tmp",
                "-e",
                "XDG_CONFIG_HOME=/tmp/config",
                "-e",
                "XDG_CACHE_HOME=/tmp/cache",
                "--entrypoint",
                "python3",
            ]
            cid = (
                run(args + [fixture_image, "/fixture/run.py", role])
                .stdout.decode()
                .strip()
            )
            assert len(cid) == 64
            containers.append(cid)
            config[role] = cid
            run(["docker", "start", cid])
        config["driver_report"] = str(OUT.with_suffix(".driver.json"))
        chrome = "/opt/heavenkey/browsers/chromium-1248/chrome-linux64/chrome"
        chrome_probe = run(
            [
                "docker",
                "exec",
                config["app"],
                "python3",
                "-c",
                "from pathlib import Path; print(next(Path('/opt/heavenkey/browsers').glob('chromium-*/chrome-linux*/chrome')))",
            ]
        )
        chrome = chrome_probe.stdout.decode().strip()
        driver_command = [
            "docker",
            "exec",
            "-e",
            "HEAVENKEY_DNS_CONFIG=/fixture/config.json",
            "-e",
            "HEAVENKEY_DNS_CONTAINER=1",
            "-e",
            "CHROME_PATH=" + chrome,
        ]
        if os.environ.get("HEAVENKEY_DNS_BASELINE") == "1":
            driver_command += ["-e", "HEAVENKEY_DNS_BASELINE=1"]
        with OUT.with_suffix(".driver.log").open("wb") as log:
            result = subprocess.run(
                driver_command + [config["app"], "bun", "/fixture/driver.ts"],
                cwd=ROOT,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=180,
            )
        exported = run(
            ["docker", "exec", config["app"], "cat", "/tmp/dns-driver.json"],
            optional=True,
        )
        if exported.returncode == 0:
            Path(config["driver_report"]).write_bytes(exported.stdout)
        driver = json.loads(Path(config["driver_report"]).read_text())
        if result.returncode:
            diagnostics = {}
            for role, cid in config.items():
                if role == "driver_report":
                    continue
                diagnostics[role] = run(
                    ["docker", "logs", cid], optional=True
                ).stderr.decode(errors="replace")[-3000:]
            diagnostics["app_log"] = run(
                ["docker", "exec", config["app"], "cat", "/tmp/app.log"], optional=True
            ).stdout.decode(errors="replace")[-3000:]
            OUT.with_suffix(".fixture-diagnostics.json").write_text(
                json.dumps(diagnostics, indent=2) + "\n"
            )
            raise RuntimeError("DNS driver failed; see redacted synthetic driver log")
        assert driver["pass"]
        for file, digest in sources.items():
            assert sha(ROOT / file) == digest, file
        assert sha(BINARY) == binary_hash
        passed = True
finally:
    for cid in reversed(containers):
        run(["docker", "rm", "-f", cid], optional=True)
    if network:
        run(["docker", "network", "rm", network], optional=True)
    if fixture_image:
        run(["docker", "image", "rm", fixture_image], optional=True)
    if fixture_base:
        run(["docker", "image", "rm", fixture_base], optional=True)
    remaining = [
        cid
        for cid in containers
        if run(["docker", "inspect", cid], optional=True).returncode == 0
    ]
    assert not remaining, "Owned DNS fixture container cleanup failed"
    if network:
        assert (
            run(["docker", "network", "inspect", network], optional=True).returncode
            != 0
        )
    report = {
        "pass": passed,
        "baseline": os.environ.get("HEAVENKEY_DNS_BASELINE") == "1",
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "binary_sha256": sha(BINARY),
        "source_hashes": sources,
        "image": IMAGE,
        "network": network,
        "network_internal": True,
        "wan_access": False,
        "host_dns_changed": False,
        "host_trust_store_changed": False,
        "owned_containers_removed": True,
        "cases": json.loads(Path(config["driver_report"]).read_text()).get("cases", [])
        if config.get("driver_report") and Path(config["driver_report"]).exists()
        else [],
    }
    OUT.write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                k: report[k]
                for k in [
                    "pass",
                    "baseline",
                    "elapsed_seconds",
                    "owned_containers_removed",
                ]
            }
        )
    )
