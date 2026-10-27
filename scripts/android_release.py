"""Verify signed Android release artifacts and produce checksums/provenance.

Uses Android/JDK signature tools; does not implement cryptographic signing.
Signing credentials are read only by the JDK from the process environment.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parent.parent
ANDROID = "{http://schemas.android.com/apk/res/android}"
ABIS = ("arm64-v8a", "armeabi-v7a", "x86_64")
ABI_CODES = {"armeabi-v7a": 1000, "arm64-v8a": 2000, "x86_64": 4000}
PACKAGE = "app.heavenkey.heavenkey_mobile"
BUNDLETOOL_SHA256 = "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29"


def run(*command):
    return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT, timeout=120)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def bundletool():
    path = ROOT / "dist/tooling/bundletool-all-1.18.3.jar"
    if not path.exists():
        url = "https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar"
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        require(hashlib.sha256(data).hexdigest() == BUNDLETOOL_SHA256, "Unexpected bundletool download digest")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    require(digest(path) == BUNDLETOOL_SHA256, "Unexpected bundletool tool digest")
    return str(path)


def verify_manifest(manifest, version, code):
    require(manifest.get("package") == PACKAGE, "Unexpected application ID")
    require(manifest.get(ANDROID + "versionName") == version and
            manifest.get(ANDROID + "versionCode") == str(code), "Unexpected Android version")
    app = manifest.find("application")
    require(app is not None, "Missing application manifest")
    for attribute in ("debuggable", "testOnly"):
        require(app.get(ANDROID + attribute, "false") == "false", "Test/debug APK is forbidden")
    for attribute in ("allowBackup", "usesCleartextTraffic"):
        require(app.get(ANDROID + attribute) == "false", "Unsafe manifest: " + attribute)
    require(manifest.find("uses-sdk").get(ANDROID + "minSdkVersion") == "30", "Unexpected minimum API")


def verify_device_evidence(device_evidence, commit):
    receipt = json.loads(device_evidence.read_text())
    for check in ("passed", "synthetic_only", "device_credential_authentication", "real_android_keystore",
                  "portable_passkey_restore_and_signature", "wrong_key_tamper_and_stale_preview_rejected",
                  "locked_export_rejected", "legacy_vault_migration", "profiles_backup_and_new_app_trust",
                  "native_system_autofill_profiles_logins_signup"):
        require(receipt.get(check) is True, "Missing native device evidence: " + check)
    require(receipt.get("tests") == 4 and receipt.get("source_commit") == commit,
            "Native device evidence belongs to another source commit")
    mobile = ROOT / "apps/mobile"
    source_paths = [*mobile.glob("android/app/src/main/**/*.kt"),
                    *mobile.glob("android/app/src/androidTest/**/*.kt"),
                    *mobile.glob("lib/**/*.dart"), *mobile.glob("assets/*"),
                    *mobile.glob("android/app/src/main/res/xml/*.xml"),
                    mobile / "android/app/src/androidTest/AndroidManifest.xml",
                    mobile / "android/app/build.gradle.kts",
                    mobile / "android/app/src/main/AndroidManifest.xml",
                    ROOT / "scripts/android_device_acceptance.py"]
    require(set(receipt.get("source_files", {})) == {str(p.relative_to(ROOT)) for p in source_paths},
            "Native device evidence does not cover all current sources")
    for relative, expected in receipt["source_files"].items():
        path = (ROOT / relative).resolve()
        require(path.is_relative_to(ROOT) and digest(path) == expected, "Stale device evidence: " + relative)

    return receipt


def verify(directory, version, code, commit, pin, device_evidence):
    require(re.fullmatch(r"\d+\.\d+\.\d+", version), "Invalid release version")
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "An exact source commit is required")
    pin = pin.replace(":", "").lower()
    require(re.fullmatch(r"[a-f0-9]{64}", pin), "A production certificate pin is required")
    require(code > 0, "A positive Android version code is required")
    receipt = verify_device_evidence(device_evidence, commit)

    sdk = Path(os.environ["ANDROID_HOME"])
    apksigner = str(sdk / "build-tools/36.0.0/apksigner")
    analyzer = str(sdk / "cmdline-tools/latest/bin/apkanalyzer")
    expected = {f"HeavenKey-{version}-android-{abi}.apk" for abi in ABIS}
    bundle_name = f"HeavenKey-{version}-android.aab"
    expected.add(bundle_name)
    actual = {p.name for p in directory.iterdir() if p.suffix in (".apk", ".aab")}
    require(actual == expected, "Missing or unexpected Android artifacts")
    for abi in ABIS:
        apk = directory / f"HeavenKey-{version}-android-{abi}.apk"
        report = run(apksigner, "verify", "--verbose", "--print-certs", str(apk))
        signers = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)", report)
        require([value.lower() for value in signers] == [pin], "Unexpected APK signing certificate")
        require("CN=Android Debug" not in report, "Debug-signed APK is forbidden")
        manifest = ET.fromstring(run(analyzer, "manifest", "print", str(apk)))
        # Flutter's --split-per-abi applies these documented Gradle offsets.
        verify_manifest(manifest, version, ABI_CODES[abi] + code)
        with zipfile.ZipFile(apk) as archive:
            require(archive.testzip() is None, "Damaged APK")
            architectures = {p.split("/")[1] for p in archive.namelist() if p.startswith("lib/")}
            require(architectures == {abi} and f"lib/{abi}/libapp.so" in archive.namelist(),
                    "Unexpected native APK architecture")
            require(not any("integration_test" in p.lower() for p in archive.namelist()), "Test assets in production APK")

    bundle = directory / bundle_name
    # Trust this pinned release entry, so a legitimate self-signed app certificate
    # is accepted while unsigned/tampered entries still fail jarsigner's strict check.
    run("jarsigner", "-verify", "-strict", "-keystore", os.environ["HEAVENKEY_ANDROID_KEYSTORE"],
        "-storepass:env", "HEAVENKEY_ANDROID_STORE_PASSWORD", str(bundle))
    certificates = run("keytool", "-printcert", "-jarfile", str(bundle), "-rfc")
    pem = re.search(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", certificates, re.S)
    require(pem is not None and hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.group())).hexdigest() == pin,
            "Unexpected app bundle signing certificate")
    with zipfile.ZipFile(bundle) as archive:
        require(archive.testzip() is None and "base/manifest/AndroidManifest.xml" in archive.namelist(), "Damaged app bundle")
        for abi in ABIS:
            require(f"base/lib/{abi}/libapp.so" in archive.namelist(), "Incomplete app bundle")
    tool = bundletool()
    run("java", "-jar", tool, "validate", "--bundle=" + str(bundle))
    manifest = ET.fromstring(run("java", "-jar", tool, "dump", "manifest", "--bundle=" + str(bundle)))
    verify_manifest(manifest, version, code)

    artifacts = {name: {"sha256": digest(directory / name), "bytes": (directory / name).stat().st_size}
                 for name in sorted(expected)}
    for abi in ABIS:
        artifacts[f"HeavenKey-{version}-android-{abi}.apk"]["version_code"] = ABI_CODES[abi] + code
    artifacts[bundle_name]["version_code"] = code
    provenance = {
        "version": version, "version_code": code, "package": PACKAGE,
        "source_commit": commit, "signing_certificate_sha256": pin,
        "verified_signatures": True, "debuggable": False,
        "native_device_acceptance": receipt,
        "physical_device_acceptance": False, "play_store_published": False,
        "artifacts": artifacts,
    }
    (directory / "RELEASE.json").write_text(json.dumps(provenance, indent=2) + "\n")
    checksum_names = [*sorted(expected), "RELEASE.json"]
    (directory / "SHA256SUMS").write_text("".join(f"{digest(directory / name)}  {name}\n" for name in checksum_names))
    print(f"Verified {len(expected)} Android artifacts: signatures, certificate, manifest, version and source-bound device evidence.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--code", required=True, type=int)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--device-evidence", required=True, type=Path)
    args = parser.parse_args()
    verify(args.directory, args.version, args.code, args.commit,
           os.environ.get("HEAVENKEY_ANDROID_CERT_SHA256", ""), args.device_evidence)


if __name__ == "__main__":
    main()
