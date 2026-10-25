"""Reject incomplete, stale or mismatched unified release downloads."""

import argparse
import hashlib
import json
import subprocess
import tarfile
import tomllib
import zipfile

from build_portable import ROOT, TARGETS, source_fingerprint
from package_release import PLATFORMS, verify_architecture

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--live", action="store_true")
args = parser.parse_args()
version = tomllib.loads((ROOT / "Cargo.toml").read_text())["workspace"]["package"][
    "version"
]
tag = f"v{version}-preview.1"
directory = ROOT / "dist" / f"release-{version}"
acceptance = json.loads((directory / "ACCEPTANCE.json").read_text())
head = subprocess.check_output(
    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
).strip()
assert acceptance["pass"] is True and acceptance["version"] == version
assert acceptance["source_commit"] == head, (
    "release acceptance belongs to another commit"
)
fingerprint = source_fingerprint()
assert acceptance["source_fingerprint"] == fingerprint, "compiled sources changed"
assert acceptance["independent_review"]["approved"] is True
for relative, expected in acceptance["independent_review"]["source_files"].items():
    path = (ROOT / relative).resolve()
    assert path.is_relative_to(ROOT), relative
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, relative
assert acceptance["ci"]["conclusion"] == "success"
assert acceptance["ci"]["head"] == head
for name in (
    "android-browser-adaptive.json",
    "android-browser-passkeys.json",
    "android-backup.json",
    "android-onboarding.json",
):
    receipt = json.loads((ROOT / "docs/evidence/mobile" / name).read_text())
    assert receipt["passed"] is True, name
    if "apk_sha256" in receipt:
        assert receipt["apk_sha256"] == acceptance["android"]["apk_sha256"], name
    for relative, expected in receipt["source_files"].items():
        path = (ROOT / relative).resolve()
        assert path.is_relative_to(ROOT)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, relative
onboarding = json.loads((ROOT / "docs/evidence/onboarding/desktop-acceptance.json").read_text())
assert onboarding["passed"] is True and onboarding["real_rust_service"] is True
assert len(onboarding["visible_editor_fields"]) == 4
for relative, expected in onboarding["source_files"].items():
    assert hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() == expected, relative
assert isinstance(acceptance["android"]["reused_unchanged"], bool)
assert acceptance["ios_available"] is False
assert acceptance["production_release"] is False

expected_packages = {
    f"HeavenKey-{version}-{label}" + (".tar.gz" if "linux" in label else ".zip")
    for label in PLATFORMS.values()
}
expected_packages |= {
    f"HeavenKey-{version}-extension-chromium.zip",
    f"HeavenKey-{version}-extension-firefox.zip",
    f"HeavenKey-{version}-android-preview.apk",
}
artifacts = acceptance["artifacts"]
assert set(artifacts) == expected_packages, "missing or unexpected platform packages"
assert (
    artifacts[f"HeavenKey-{version}-android-preview.apk"]["sha256"]
    == acceptance["android"]["apk_sha256"]
), "Android APK differs from executed emulator evidence"
for name, item in artifacts.items():
    path = (ROOT / item["path"]).resolve()
    assert path.is_relative_to(ROOT / "dist") and path.name == name
    assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"], name
    assert path.stat().st_size == item["size"], name
for target in TARGETS:
    build = json.loads((ROOT / "dist/builds" / f"{target}.json").read_text())
    binary = (
        ROOT
        / "target"
        / target
        / "release"
        / ("uac-api.exe" if "windows" in target else "uac-api")
    )
    assert build["source_fingerprint"] == fingerprint, target
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == build["binary_sha256"], (
        target
    )
    verify_architecture(binary, target)
    receipt = acceptance["platform_runtime"][target]
    assert (
        receipt["pass"] is True and receipt["binary_sha256"] == build["binary_sha256"]
    ), target
    assert receipt["cases"], target
    label = f"HeavenKey-{version}-{PLATFORMS[target]}"
    archive = (
        ROOT / artifacts[label + (".tar.gz" if "linux" in target else ".zip")]["path"]
    )
    executable = label + ("/HeavenKey.exe" if "windows" in target else "/heavenkey")
    if "linux" in target:
        with tarfile.open(archive) as package:
            embedded = json.load(package.extractfile(label + "/manifest.json"))
            with package.extractfile(executable) as stream:
                embedded_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    else:
        with zipfile.ZipFile(archive) as package:
            embedded = json.loads(package.read(label + "/manifest.json"))
            with package.open(executable) as stream:
                embedded_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    assert embedded["version"] == version and embedded["source_commit"] == head, target
    assert embedded["source_fingerprint"] == fingerprint, target
    assert embedded["binary_sha256"] == embedded_hash == build["binary_sha256"], target
for browser in ("chromium", "firefox"):
    name = f"HeavenKey-{version}-extension-{browser}.zip"
    with zipfile.ZipFile(ROOT / artifacts[name]["path"]) as package:
        manifest = json.loads(package.read("manifest.json"))
        build = json.loads(package.read("BUILD.json"))
    assert manifest["version"] == build["version"] == version, browser
    assert (
        build["source_commit"] == head and build["source_fingerprint"] == fingerprint
    ), browser
readme = (ROOT / "README.md").read_text()
assert f"releases/tag/{tag}" in readme
assert all(f"releases/download/{tag}/{name}" in readme for name in expected_packages)
assert "v0.21.0-rc.1" not in readme and "mobile-v0.24.0" not in readme

if args.live:

    def api(path):
        return json.loads(
            subprocess.check_output(
                ["gh", "api", f"repos/Supersynergy/HeavenKey/{path}"],
                text=True,
                timeout=30,
            )
        )

    release = api(f"releases/tags/{tag}")
    assert not release["draft"] and release["prerelease"]
    assert release["target_commitish"] == head
    assert api(f"git/ref/tags/{tag}")["object"]["sha"] == head
    expected_assets = expected_packages | {
        "ACCEPTANCE.json",
        "SHA256SUMS",
        "MOBILE-SYNC-PASSKEYS.md",
    }
    assert {asset["name"] for asset in release["assets"]} == expected_assets
    for asset in release["assets"]:
        name = asset["name"]
        if name in artifacts:
            expected = artifacts[name]["sha256"]
        else:
            path = (
                ROOT / "docs/MOBILE-SYNC-PASSKEYS.md"
                if name == "MOBILE-SYNC-PASSKEYS.md"
                else directory / name
            )
            expected = hashlib.sha256(path.read_bytes()).hexdigest()
        assert (
            asset["state"] == "uploaded" and asset["digest"] == "sha256:" + expected
        ), name
    print(
        f"Published {tag}: all eight packages and three supporting assets match current source, independent review, CI and GitHub digests"
    )
else:
    print(
        f"{tag}: all eight local packages match current source, independent review and CI"
    )
