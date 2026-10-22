"""Create desktop archives and bundled local-autofill browser extensions."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tarfile
import tempfile
import tomllib
import zipfile

import build_openssl

from build_portable import TARGETS, source_fingerprint

ROOT = Path(__file__).resolve().parent.parent
VERSION = tomllib.loads((ROOT / "Cargo.toml").read_text())["workspace"]["package"][
    "version"
]
OUT = ROOT / "dist"
PLATFORMS = {
    "x86_64-pc-windows-gnu": "windows-x64",
    "aarch64-apple-darwin": "macos-arm64",
    "x86_64-apple-darwin": "macos-x64",
    "aarch64-unknown-linux-musl": "linux-arm64",
    "x86_64-unknown-linux-musl": "linux-x64",
}


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_architecture(binary, target):
    with binary.open("rb") as stream:
        header = stream.read(4096)
    if target.endswith("windows-gnu"):
        if header[:2] != b"MZ" or len(header) < 64:
            raise ValueError("Expected a Windows PE executable")
        offset = struct.unpack_from("<I", header, 60)[0]
        if (
            offset + 6 > len(header)
            or header[offset : offset + 4] != b"PE\0\0"
            or struct.unpack_from("<H", header, offset + 4)[0] != 0x8664
        ):
            raise ValueError("Expected Windows x64")
    elif "linux" in target:
        machine = 183 if target.startswith("aarch64") else 62
        if (
            header[:6] != b"\x7fELF\x02\x01"
            or struct.unpack_from("<H", header, 18)[0] != machine
        ):
            raise ValueError("Linux architecture mismatch")
    else:
        cpu = 0x100000C if target.startswith("aarch64") else 0x1000007
        if (
            header[:4] != b"\xcf\xfa\xed\xfe"
            or struct.unpack_from("<I", header, 4)[0] != cpu
        ):
            raise ValueError("macOS architecture mismatch")


def zip_directory(directory, output, prefix=""):
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                archive.write(path, prefix + path.relative_to(directory).as_posix())


def dependency_notices(destination):
    metadata = json.loads(
        subprocess.check_output(
            [
                "cargo",
                "metadata",
                "--locked",
                "--offline",
                "--format-version",
                "1",
                "--features",
                "portable",
            ],
            cwd=ROOT,
            timeout=60,
        )
    )
    notices = []
    for package in sorted(
        metadata["packages"], key=lambda item: (item["name"], item["version"])
    ):
        if package["source"] is None:
            continue
        name = f"{package['name']}-{package['version']}"
        source = Path(package["manifest_path"]).parent
        license_files = [
            path
            for path in source.iterdir()
            if path.is_file()
            and path.name.upper().startswith(
                ("LICENSE", "LICENCE", "COPYING", "COPYRIGHT")
            )
        ]
        if package["name"] == "openssl-src":
            license_files.append(source / "openssl/LICENSE.txt")
        if package["name"] == "libdbus-sys":
            license_files.append(source / "vendor/dbus/COPYING")
        if package["name"] == "libssh2-sys":
            license_files.append(source / "libssh2/COPYING")
        for path in license_files:
            target = destination / "licenses" / name / path.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        notices.append(
            {
                "package": name,
                "license": package["license"],
                "source": f"https://crates.io/crates/{package['name']}/{package['version']}",
            }
        )
        if "MPL-2.0" in (package["license"] or "") or package["name"] == "libdbus-sys":
            target = destination / "third-party-source"
            target.mkdir(exist_ok=True)
            with tarfile.open(target / f"{name}.tar.gz", "w:gz") as archive:
                archive.add(source, arcname=name)
    (destination / "THIRD-PARTY.json").write_text(json.dumps(notices, indent=2) + "\n")
    for name in ("LICENSE", "NOTICE.md"):
        shutil.copyfile(ROOT / name, destination / name)
    target = destination / "licenses/simplewebauthn-browser-MIT.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "docs/licenses/simplewebauthn-browser-MIT.txt", target)


def desktop(target):
    if target not in TARGETS:
        raise ValueError("Unsupported target")
    windows = "windows" in target
    binary = (
        ROOT / "target" / target / "release" / ("uac-api.exe" if windows else "uac-api")
    )
    build = json.loads((OUT / "builds" / f"{target}.json").read_text())
    if (
        build["target"] != target
        or build["features"] != ["portable"]
        or build["source_fingerprint"] != source_fingerprint()
        or build["binary_sha256"] != sha256(binary)
    ):
        raise ValueError("Build is stale or modified; run build_portable.py first")
    verify_architecture(binary, target)
    dirty = subprocess.check_output(
        [
            "git",
            "status",
            "--porcelain",
            "--untracked-files=normal",
            "--",
            ".",
            ":(exclude)docs/evidence",
        ],
        cwd=ROOT,
        text=True,
        timeout=10,
    )
    if dirty:
        raise ValueError(
            "Commit the source and documentation before creating release packages"
        )
    label = f"HeavenKey-{VERSION}-{PLATFORMS[target]}"
    with tempfile.TemporaryDirectory(prefix="heavenkey-package-") as temporary:
        directory = Path(temporary) / label
        directory.mkdir()
        executable = directory / ("HeavenKey.exe" if windows else "heavenkey")
        shutil.copyfile(binary, executable)
        executable.chmod(0o755)
        if windows:
            starter = directory / "Start HeavenKey.cmd"
            starter.write_bytes(
                b'@echo off\r\n"%~dp0HeavenKey.exe" --password-manager --open %*\r\nif errorlevel 1 pause\r\n'
            )
        else:
            starter = directory / (
                "Start HeavenKey.command" if "apple" in target else "start.sh"
            )
            starter.write_text(
                '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec ./heavenkey --password-manager --open "$@"\n'
            )
            starter.chmod(0o755)
        shutil.copyfile(ROOT / "docs/DISTRIBUTION.md", directory / "README.md")
        for name in (
            "PASSWORD-MANAGER.md", "PASSWORD-MANAGER-GAPS.md",
            "PASSWORD-MANAGER-VERIFICATION.md", "PASSWORD-MANAGER-RESEARCH-TOOLS.md",
            "ACCESS-AND-SHARING.md", "AGENT-BROKER.md", "AGENT-SANDBOX.md", "VAULT-KDF.md", "TRANSFER-BROKER.md", "SSH-KEYS.md",
            "password-manager-matrix.json", "LICENSING.md",
        ):
            shutil.copyfile(ROOT / "docs" / name, directory / name)
        shutil.copyfile(ROOT / "scripts/broker.rs", directory / "broker.rs")
        dependency_notices(directory)
        shutil.copyfile(ROOT / "docs/licenses/noble-hashes-MIT.txt", directory / "licenses/noble-hashes-MIT.txt")
        openssl_source = ROOT / ".platform-tools" / f"openssl-{build_openssl.VERSION}"
        shutil.copyfile(
            openssl_source / "LICENSE.txt", directory / "licenses/OpenSSL.txt"
        )
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=10
        ).strip()
        manifest = {
            "version": VERSION,
            "target": target,
            "source_commit": commit,
            "binary_sha256": sha256(executable),
            "source_fingerprint": build["source_fingerprint"],
            "portable_assets": True,
            "publisher_signed": False,
            "openssl_version": build["openssl_version"],
            "openssl_source_sha256": build["openssl_source_sha256"],
        }
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        suffix = ".tar.gz" if "linux" in target else ".zip"
        output = OUT / (label + suffix)
        if suffix == ".zip":
            zip_directory(directory, output, label + "/")
        else:
            with tarfile.open(output, "w:gz") as archive:
                archive.add(directory, arcname=label)
    return output


def extensions():
    outputs = []
    for browser in ("chromium", "firefox"):
        directory = OUT / f"extension-{browser}"
        built = OUT / f"extension-source-{browser}"
        manifest = json.loads((built / "manifest.json").read_text())
        if manifest.get("version") != VERSION:
            raise ValueError("Build browser extensions before packaging this version")
        if set(manifest.get("permissions", [])) != {"activeTab", "scripting", "storage", "contextMenus"}:
            raise ValueError("Unexpected extension permissions")
        if manifest.get("optional_host_permissions") != ["http://localhost/*"] or any(
            key in manifest for key in ("host_permissions", "externally_connectable", "content_scripts")
        ):
            raise ValueError("Unexpected persistent extension access")
        if directory.exists():
            shutil.rmtree(directory)
        shutil.copytree(built, directory)
        for name in ("smart-popup.js", "content.js", "background.js", "LICENSE", "THIRD-PARTY-NOTICE.md"):
            if not (directory / name).is_file():
                raise ValueError(f"Missing extension file: {name}")
        (directory / "BUILD.json").write_text(json.dumps({
            "version": VERSION, "source_commit": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=10
            ).strip(),
            "source_fingerprint": source_fingerprint(), "browser": browser,
        }, indent=2) + "\n")
        output = OUT / f"HeavenKey-{VERSION}-extension-{browser}.zip"
        zip_directory(directory, output)
        outputs.append(output)
    return outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", nargs="*", choices=TARGETS)
    parser.add_argument("--extensions-only", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(exist_ok=True)
    files = [] if args.extensions_only else [desktop(target) for target in args.targets]
    files += extensions()
    all_archives = sorted(
        path for path in OUT.iterdir() if path.suffix in (".zip", ".gz")
    )
    (OUT / "SHA256SUMS").write_text(
        "".join(f"{sha256(path)}  {path.name}\n" for path in all_archives)
    )
    for path in files:
        print(path)


if __name__ == "__main__":
    main()
