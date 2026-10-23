"""Build a macOS app bundle around the matching local HeavenKey service."""
import hashlib
from pathlib import Path
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def app_bundle(destination: Path, binary: Path, target: str, version: str) -> Path:
    architecture = {"aarch64-apple-darwin": "arm64", "x86_64-apple-darwin": "x86_64"}[target]
    app = destination / "HeavenKey.app"
    contents = app / "Contents"
    resources = contents / "Resources"
    macos = contents / "MacOS"
    resources.mkdir(parents=True)
    macos.mkdir()
    shutil.copyfile(binary, resources / "heavenkey")
    (resources / "heavenkey").chmod(0o755)
    subprocess.run([
        "swiftc", "-parse-as-library", "-swift-version", "5", "-O",
        "-target", f"{architecture}-apple-macosx14.0", "-framework", "AppKit", "-framework", "WebKit",
        str(ROOT / "apps/desktop/HeavenKey.swift"), "-o", str(macos / "HeavenKey"),
    ], check=True, timeout=90)
    iconset = destination / "HeavenKey.iconset"
    iconset.mkdir()
    try:
        for size in [16, 32, 128, 256, 512]:
            for scale in [1, 2]:
                name = f"icon_{size}x{size}" + ("@2x" if scale == 2 else "") + ".png"
                subprocess.run(["sips", "-z", str(size * scale), str(size * scale),
                                str(ROOT / "docs/assets/heavenkey-hero-square.png"), "--out", str(iconset / name)],
                               check=True, capture_output=True, timeout=10)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(resources / "HeavenKey.icns")], check=True, timeout=20)
    finally:
        shutil.rmtree(iconset)
    with (contents / "Info.plist").open("wb") as stream:
        plistlib.dump({
            "CFBundleExecutable": "HeavenKey", "CFBundleIdentifier": "com.supersynergy.heavenkey",
            "CFBundleName": "HeavenKey", "CFBundleDisplayName": "HeavenKey",
            "CFBundlePackageType": "APPL", "CFBundleIconFile": "HeavenKey.icns", "CFBundleShortVersionString": version,
            "CFBundleVersion": version, "LSMinimumSystemVersion": "14.0",
            "NSHighResolutionCapable": True,
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        }, stream)
    # Ad-hoc integrity seals are not a publisher signature or notarization.
    subprocess.run(["codesign", "--force", "--sign", "-", str(resources / "heavenkey")], check=True, timeout=20)
    subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True, timeout=20)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True, timeout=20)
    return app


def bundle_hashes(app: Path) -> dict[str, str]:
    return {p.relative_to(app).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(app.rglob("*")) if p.is_file()}
