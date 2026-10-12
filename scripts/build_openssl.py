"""Build the reviewed OpenSSL release without shared libraries or downloads at runtime."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
VERSION = "3.6.5"
SHA256 = "a2157c2830efdec3788939b00c9b0638306d3f0bbb76dc4832ee503bb397df98"
URL = f"https://github.com/openssl/openssl/releases/download/openssl-{VERSION}/openssl-{VERSION}.tar.gz"


def prepare_source():
    directory = ROOT / ".platform-tools"
    directory.mkdir(exist_ok=True)
    archive = directory / f"openssl-{VERSION}.tar.gz"
    if not archive.exists():
        temporary = archive.with_suffix(".download")
        try:
            with (
                urllib.request.urlopen(URL, timeout=30) as response,
                temporary.open("wb") as stream,
            ):
                size = 0
                while data := response.read(1024 * 1024):
                    size += len(data)
                    if size > 100 * 1024 * 1024:
                        raise ValueError("OpenSSL archive exceeds the download limit")
                    stream.write(data)
            with temporary.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != SHA256:
                    raise ValueError("OpenSSL source checksum mismatch")
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    with archive.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != SHA256:
            raise ValueError("OpenSSL source checksum mismatch")
    source = directory / f"openssl-{VERSION}"
    if not source.exists():
        with tarfile.open(archive) as package:
            package.extractall(directory, filter="data")
    return source


def build(target):
    source = prepare_source()
    directory = ROOT / ".platform-tools" / f"openssl-{VERSION}-builds" / target
    install = directory / "install"
    receipt = directory / "receipt.json"
    if (
        receipt.exists()
        and (install / "lib/libcrypto.a").is_file()
        and (install / "lib/libssl.a").is_file()
    ):
        cached = json.loads(receipt.read_text())
        if cached == {"source_sha256": SHA256, "target": target}:
            return install
    directory.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    if "windows" in target:
        configure = "mingw64"
        env.update(
            CC="x86_64-w64-mingw32-gcc",
            AR="x86_64-w64-mingw32-ar",
            RANLIB="x86_64-w64-mingw32-ranlib",
        )
    elif "linux" in target:
        architecture = "aarch64" if target.startswith("aarch64") else "x86_64"
        configure = "linux-aarch64" if architecture == "aarch64" else "linux-x86_64"
        env.update(
            CC=f"zig cc -target {architecture}-linux-musl",
            AR="zig ar",
            RANLIB="zig ranlib",
        )
    else:
        architecture = "arm64" if target.startswith("aarch64") else "x86_64"
        configure = f"darwin64-{architecture}-cc"
        env.update(
            CC="clang", CFLAGS=f"-arch {architecture}", LDFLAGS=f"-arch {architecture}"
        )
    subprocess.run(
        [
            "perl",
            str(source / "Configure"),
            configure,
            "no-shared",
            "no-tests",
            "no-apps",
            "no-module",
            "no-dso",
            f"--prefix={install}",
            "--libdir=lib",
        ],
        cwd=directory,
        env=env,
        check=True,
        timeout=180,
    )
    subprocess.run(["make", "-j4"], cwd=directory, env=env, check=True, timeout=600)
    subprocess.run(
        ["make", "install_sw"], cwd=directory, env=env, check=True, timeout=60
    )
    receipt.write_text(json.dumps({"source_sha256": SHA256, "target": target}) + "\n")
    return install


if __name__ == "__main__":
    import sys

    print(build(sys.argv[1]))
