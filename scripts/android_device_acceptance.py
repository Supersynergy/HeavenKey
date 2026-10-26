"""Exercise real Android Keystore recovery on a fresh, disposable API 36 emulator.

No user device is selected, no authentication bypass is installed, and every
credential is a synthetic fixture. Browser/physical-device acceptance is separate.
The Android SDK system image and debug + instrumentation APKs must already exist.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
SDK = Path(os.environ["ANDROID_HOME"])
ADB = str(SDK / "platform-tools/adb")
EMULATOR = str(SDK / "emulator/emulator")
NAME = "heavenkey_production_test"
SERIAL = "emulator-5556"
MOBILE = ROOT / "apps/mobile"
APP = MOBILE / "build/app/outputs/flutter-apk/app-debug.apk"
TEST = MOBILE / "build/app/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
EVIDENCE = ROOT / "dist/android-device-acceptance"


def run(command, *, timeout=60, **kwargs):
    return subprocess.run(command, check=True, text=True, capture_output=True,
                          timeout=timeout, **kwargs).stdout


def adb(*arguments, timeout=60):
    return run([ADB, "-s", SERIAL, *arguments], timeout=timeout)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    if not APP.is_file() or not TEST.is_file():
        raise SystemExit("Build the debug app and :app:assembleDebugAndroidTest first.")
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="heavenkey-device-") as scratch:
        env = os.environ | {"ANDROID_AVD_HOME": scratch,
                            "ANDROID_EMULATOR_HOME": scratch}
        run([str(SDK / "cmdline-tools/latest/bin/avdmanager"), "create", "avd",
             "--force", "--name", NAME, "--package",
             "system-images;android-36;google_apis;x86_64",
             "--path", str(Path(scratch) / "device")], input="no\n", env=env)
        # A dedicated serial avoids selecting any other attached device.
        run([ADB, "start-server"])
        command = [EMULATOR, "-avd", NAME, "-port", "5556", "-no-window",
                   "-no-audio", "-no-boot-anim", "-no-snapshot", "-no-metrics",
                   "-gpu", "swiftshader", "-memory", "2048", "-cores", "2"]
        if not Path("/dev/kvm").exists():
            command += ["-accel", "off"]
        with (EVIDENCE / "emulator.log").open("w") as log:
            process = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 600
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("Disposable emulator stopped; inspect emulator.log.")
                    try:
                        if adb("shell", "getprop", "sys.boot_completed", timeout=10).strip() == "1":
                            break
                    except (subprocess.SubprocessError, OSError):
                        pass
                    time.sleep(3)
                else:
                    raise TimeoutError("Disposable emulator did not finish booting.")
                print("Disposable Android emulator booted.", flush=True)
                assert adb("shell", "getprop", "ro.boot.qemu.avd_name").strip() == NAME
                assert adb("shell", "getprop", "ro.kernel.qemu").strip() == "1"
                adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
                adb("shell", "wm", "dismiss-keyguard")
                for setting in ("window_animation_scale", "transition_animation_scale", "animator_duration_scale"):
                    adb("shell", "settings", "put", "global", setting, "0")
                # This PIN belongs only to this newly created disposable emulator.
                output = adb("shell", "locksettings", "set-pin", "417926")
                assert "success" in output.lower(), "Synthetic emulator PIN could not be set"
                adb("install", "--no-streaming", "-r", "-t", str(APP), timeout=180)
                adb("install", "--no-streaming", "-r", "-t", str(TEST), timeout=90)
                output = adb("shell", "am", "instrument", "-w", "-r", "-e", "class",
                             "app.heavenkey.heavenkey_mobile.PortableVaultDeviceTest",
                             "app.heavenkey.heavenkey_mobile.test/androidx.test.runner.AndroidJUnitRunner",
                             timeout=300)
                (EVIDENCE / "instrumentation.txt").write_text(output)
                if "OK (2 tests)" not in output or "FAILURES!!!" in output:
                    # XML/logs include synthetic fixtures only.
                    try:
                        adb("shell", "uiautomator", "dump", "/sdcard/heavenkey-test-ui.xml")
                        (EVIDENCE / "failure-ui.xml").write_text(adb("shell", "cat", "/sdcard/heavenkey-test-ui.xml"))
                        (EVIDENCE / "logcat.txt").write_text(adb("logcat", "-d", "-t", "1500"))
                    except subprocess.SubprocessError:
                        pass
                    raise RuntimeError("Native device acceptance failed; inspect instrumentation.txt.")
                source_paths = [*MOBILE.glob("android/app/src/main/**/*.kt"),
                                *MOBILE.glob("android/app/src/androidTest/**/*.kt"),
                                MOBILE / "android/app/build.gradle.kts",
                                MOBILE / "android/app/src/main/AndroidManifest.xml",
                                Path(__file__).resolve()]
                receipt = {
                    "passed": True, "kind": "isolated Android API 36 emulator",
                    "synthetic_only": True, "tests": 2,
                    "device_credential_authentication": True,
                    "real_android_keystore": True,
                    "portable_passkey_restore_and_signature": True,
                    "wrong_key_tamper_and_stale_preview_rejected": True,
                    "locked_export_rejected": True,
                    "physical_device": False, "browser_passkey_flow": False,
                    "production_signed_app": False,
                    "source_commit": run(["git", "rev-parse", "HEAD"], cwd=ROOT).strip(),
                    "app_sha256": digest(APP),
                    "test_apk_sha256": digest(TEST),
                    "source_files": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                     for p in sorted(source_paths)},
                }
                (EVIDENCE / "acceptance.json").write_text(json.dumps(receipt, indent=2) + "\n")
                print("PASS: actual device authentication, Keystore recovery and rejection checks (2 tests).")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
