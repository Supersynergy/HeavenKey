"""Build one desktop target in the foreground; package with package_release.py."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

import build_openssl

ROOT = Path(__file__).resolve().parent.parent
TARGETS = (
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-gnu",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl",
)
EXTENSION_RUNTIME_EVIDENCE = {
    "TEST-RECEIPT.json", "ENGINE-RECEIPT.json", "INTEGRATION-BLOCKER.json",
    "WORKER-STATUS.md",
}


def source_fingerprint():
    paths = [
        ROOT / name
        for name in (
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
            ".cargo/config.toml",
            "apps/web/dist/main.js",
            "apps/web/dist/passwords.js",
            "apps/web/dist/share.js",
            "apps/web/index.html",
            "apps/web/passwords.html",
            "apps/web/share.html",
            "docs/assets/heavenkey-hero-square.png",
            "scripts/build_openssl.py",
            "scripts/build_portable.py",
            "scripts/build_extension.ts",
            "scripts/broker.rs",
            "scripts/build_agent_sandbox.ts",
            "scripts/sandbox/Dockerfile",
        )
    ]
    for name in ("apps/api", "crates", "apps/web/src", "apps/demo", "apps/extension", "packages/forms"):
        directory = ROOT / name
        for path in directory.rglob("*"):
            if not path.is_file():
                continue
            relative = path.relative_to(directory)
            if name == "apps/extension" and (
                relative.parts[0] == "evidence"
                or relative.as_posix() in EXTENSION_RUNTIME_EVIDENCE
            ):
                continue
            paths.append(path)
    digest = hashlib.sha256()
    for path in sorted(set(paths)):
        digest.update(
            path.relative_to(ROOT).as_posix().encode() + b"\0" + path.read_bytes()
        )
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=TARGETS)
    args = parser.parse_args()
    subprocess.run(["bun", "run", "build"], cwd=ROOT, check=True, timeout=60)
    fingerprint = source_fingerprint()
    subprocess.run(
        [
            "python3",
            "scripts/run.py",
            f"openssl-{args.target}",
            "780",
            "--",
            "python3",
            "scripts/build_openssl.py",
            args.target,
        ],
        cwd=ROOT,
        check=True,
        timeout=800,
    )
    openssl = (
        ROOT
        / ".platform-tools"
        / f"openssl-{build_openssl.VERSION}-builds"
        / args.target
        / "install"
    )
    env = os.environ.copy()
    env.update(OPENSSL_DIR=str(openssl), OPENSSL_STATIC="1", OPENSSL_NO_VENDOR="1")
    if args.target.endswith("windows-gnu"):
        env.update(
            CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="x86_64-w64-mingw32-gcc",
            CC_x86_64_pc_windows_gnu="x86_64-w64-mingw32-gcc",
            AR_x86_64_pc_windows_gnu="x86_64-w64-mingw32-ar",
        )
    command = [
        "cargo",
        "zigbuild" if "linux" in args.target else "build",
        "--release",
        "--locked",
        "--offline",
        "--features",
        "portable",
        "-p",
        "uac-api",
        "--target",
        args.target,
        "--jobs",
        "4",
    ]
    subprocess.run(
        [
            "python3",
            "scripts/run.py",
            f"portable-{args.target}",
            "1200",
            "--",
            *command,
        ],
        cwd=ROOT,
        env=env,
        check=True,
        timeout=1220,
    )
    if source_fingerprint() != fingerprint:
        raise RuntimeError(
            "Source changed during compilation; rebuild before packaging"
        )
    binary = (
        ROOT
        / "target"
        / args.target
        / "release"
        / ("uac-api.exe" if "windows" in args.target else "uac-api")
    )
    with binary.open("rb") as stream:
        binary_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    directory = ROOT / "dist/builds"
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {
        "target": args.target,
        "source_fingerprint": fingerprint,
        "binary_sha256": binary_hash,
        "features": ["portable"],
        "openssl_version": build_openssl.VERSION,
        "openssl_source_sha256": build_openssl.SHA256,
    }
    (directory / f"{args.target}.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
