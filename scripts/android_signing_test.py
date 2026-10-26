"""Exercise the production signing guard using disposable, non-production keys."""

import argparse
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent
ANDROID = ROOT / "apps/mobile/android"
PREFIX = "HEAVENKEY_ANDROID_"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-artifacts", action="store_true",
                        help="Also build and verify all APK/AAB artifacts with the disposable fixture identity.")
    args = parser.parse_args()
    base = {name: value for name, value in os.environ.items() if not name.startswith(PREFIX)}
    with tempfile.TemporaryDirectory(prefix="heavenkey-signing-test-") as scratch:
        password = secrets.token_urlsafe(32)
        env = base | {"HEAVENKEY_FIXTURE_PASSWORD": password}

        def key(name, subject):
            path = Path(scratch) / (name + ".p12")
            subprocess.run(["keytool", "-genkeypair", "-keystore", str(path), "-storetype", "PKCS12",
                            "-alias", "fixture", "-storepass:env", "HEAVENKEY_FIXTURE_PASSWORD",
                            "-keypass:env", "HEAVENKEY_FIXTURE_PASSWORD", "-keyalg", "RSA", "-keysize", "2048",
                            "-validity", "2", "-dname", subject], env=env, check=True, capture_output=True)
            certificate = subprocess.check_output(["keytool", "-exportcert", "-keystore", str(path),
                                                  "-alias", "fixture", "-storepass:env", "HEAVENKEY_FIXTURE_PASSWORD"],
                                                 env=env, stderr=subprocess.DEVNULL)
            return env | {PREFIX + "KEYSTORE": str(path), PREFIX + "STORE_PASSWORD": password,
                          PREFIX + "KEY_ALIAS": "fixture", PREFIX + "KEY_PASSWORD": password,
                          PREFIX + "CERT_SHA256": hashlib.sha256(certificate).hexdigest()}

        def check(label, case, succeeds, message=None):
            result = subprocess.run(["./gradlew", ":app:verifyProductionSigning", "--no-daemon"],
                                    cwd=ANDROID, env=case, text=True, capture_output=True, timeout=180)
            output = result.stdout + result.stderr
            if (result.returncode == 0) != succeeds or (message and message not in output):
                raise RuntimeError("Signing guard failed: " + label + "\n" + output[-6000:])
            print("PASS: " + label, flush=True)

        good = key("fixture", "CN=HeavenKey disposable CI fixture,O=Not a production identity")
        check("missing configuration rejected", base, False, "Production signing is not configured")
        check("matching non-debug certificate accepted", good, True)
        check("unexpected certificate rejected", good | {PREFIX + "CERT_SHA256": "0" * 64}, False,
              "does not match the production pin")
        check("debug alias rejected", good | {PREFIX + "KEY_ALIAS": "androiddebugkey"}, False,
              "debug aliases are forbidden")
        check("incorrect private key password rejected", good | {PREFIX + "KEY_PASSWORD": "incorrect-fixture-password"}, False)
        check("debug certificate under a different alias rejected",
              key("debug", "CN=Android Debug,O=Android,C=US"), False, "debug certificates cannot")
        if args.release_artifacts:
            import re
            text = (ROOT / "apps/mobile/pubspec.yaml").read_text()
            match = re.search(r"^version: (\d+\.\d+\.\d+)\+(\d+)$", text, re.M)
            assert match, "A release version is required"
            version, code = match.groups()
            mobile = ROOT / "apps/mobile"
            for command in (["flutter", "build", "apk", "--release", "--split-per-abi"],
                            ["flutter", "build", "appbundle", "--release"]):
                # Do not pass --no-pub: release mode must regenerate the native
                # plugin registrant without integration_test/dev dependencies.
                subprocess.run(command, cwd=mobile, env=good, check=True, timeout=900)
            subprocess.run(["git", "diff", "--exit-code", "--", "apps/mobile/pubspec.lock"], cwd=ROOT, check=True)
            artifacts = Path(scratch) / "artifacts"
            artifacts.mkdir()
            for abi in ("arm64-v8a", "armeabi-v7a", "x86_64"):
                shutil.copyfile(mobile / f"build/app/outputs/flutter-apk/app-{abi}-release.apk",
                                artifacts / f"HeavenKey-{version}-android-{abi}.apk")
            shutil.copyfile(mobile / "build/app/outputs/bundle/release/app-release.aab",
                            artifacts / f"HeavenKey-{version}-android.aab")
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
            subprocess.run(["python3", "scripts/android_release.py", str(artifacts), "--version", version,
                            "--code", code, "--commit", commit, "--device-evidence",
                            str(ROOT / "dist/android-device-acceptance/acceptance.json")],
                           cwd=ROOT, env=good, check=True, timeout=300)
            print("PASS: all release APK/AAB signatures, manifests and provenance verified with a disposable identity.")
        print("Production signing guard: 6 cases passed; all fixture keys/artifacts deleted on exit.")


if __name__ == "__main__":
    main()
