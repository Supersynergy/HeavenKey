"""Observe first use on the owned synthetic Android emulator; never use real data."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
SDK = Path(
    os.environ.get("ANDROID_HOME", "/opt/homebrew/share/android-commandlinetools")
)
PKG = "app.heavenkey.heavenkey_mobile"
HERE = ROOT / "docs/evidence/mobile"
ENV = dict(os.environ)


def run(args, timeout=30, **kw):
    return subprocess.run(
        [str(a) for a in args],
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=ENV,
        **kw,
    ).stdout


def adb(*args):
    return run([SDK / "platform-tools/adb", "-s", "emulator-5584", *args])


def nodes():
    adb("shell", "uiautomator", "dump", "/data/local/tmp/hk-flow.xml")
    return [
        n.attrib
        for n in ET.fromstring(adb("shell", "cat", "/data/local/tmp/hk-flow.xml")).iter(
            "node"
        )
    ]


def tap(n):
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", n["bounds"]))
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def click(label, contains=False):
    for _ in range(4):
        ns = nodes()
        matches = [
            n
            for n in ns
            if (
                label in (n.get("text", "") + " " + n.get("content-desc", ""))
                if contains
                else label in [n.get("text"), n.get("content-desc")]
            )
            and n.get("enabled") == "true"
        ]
        found = next(
            (n for n in matches if label in n.get("text", "")),
            matches[0] if matches else None,
        )
        if found:
            tap(found)
            return
        time.sleep(0.4)
    (HERE / "ui-failure.json").write_text(json.dumps(ns, ensure_ascii=False, indent=2))
    raise AssertionError("Missing UI control: " + label)


def auth():
    for _ in range(10):
        ns = nodes()
        n = next(
            (
                n
                for n in ns
                if n.get("package") == "com.android.systemui"
                and re.search("lockPassword|pinEntry", n.get("resource-id", ""))
            ),
            None,
        )
        if n:
            tap(n)
            adb("shell", "input", "text", "417926")
            adb("shell", "input", "keyevent", "66")
            time.sleep(0.8)
            return
        time.sleep(0.3)
    raise AssertionError("Missing actual device credential dialog")


def visible(label):
    return any(
        label in (n.get("text", "") + " " + n.get("content-desc", "")) for n in nodes()
    )


def await_visible(label):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if visible(label):
            return True
    return False


def fill(label, value):
    ns = nodes()
    n = next(
        n
        for n in ns
        if n.get("class") == "android.widget.EditText"
        and (label in n.get("hint", "") or n.get("content-desc") == label)
    )
    tap(n)
    adb("shell", "input", "keyevent", "123")
    if n.get("text"):
        adb("shell", "input", "keyevent", *(["67"] * len(n["text"])))
    adb("shell", "input", "text", value.replace(" ", "%s"))
    hide_keyboard()


def hide_keyboard():
    state = adb("shell", "dumpsys", "input_method")
    if re.search(r"\bmInputShown=true", state):
        adb("shell", "input", "keyevent", "4")
        time.sleep(0.5)


def scroll(direction="down"):
    adb(
        "shell",
        "input",
        "swipe",
        "540",
        "1800" if direction == "down" else "550",
        "540",
        "550" if direction == "down" else "1800",
        "250",
    )


def find(label):
    hide_keyboard()
    for attempt in range(5):
        if visible(label):
            return
        scroll()
    raise AssertionError("Missing visible control: " + label)


def top():
    hide_keyboard()
    for _ in range(3):
        scroll("up")


def save():
    find("Login speichern")
    click("Login speichern")


def reauthenticate():
    click("Tresor sperren")
    click("Tresor entsperren")
    auth()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, required=True)
    args = parser.parse_args()
    assert (
        adb("shell", "getprop", "ro.boot.qemu.avd_name").strip() == "heavenkey-20261024"
    )
    (HERE / "android-onboarding.json").unlink(missing_ok=True)
    apk = args.apk.resolve()
    apk_hash = hashlib.sha256(apk.read_bytes()).hexdigest()
    sources = [
        "scripts/mobile_onboarding_e2e.py",
        "apps/mobile/lib/main.dart",
        "apps/mobile/lib/website_input.dart",
        "apps/mobile/lib/vault_entry.dart",
        "apps/mobile/lib/vault_controller.dart",
        "apps/mobile/pubspec.yaml",
        "apps/mobile/pubspec.lock",
    ]
    hashes = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sources}
    adb("install", "-r", apk)
    installed = adb("shell", "pm", "path", PKG).strip().split("package:", 1)[1]
    actual = subprocess.run(
        [
            str(SDK / "platform-tools/adb"),
            "-s",
            "emulator-5584",
            "exec-out",
            "cat",
            installed,
        ],
        check=True,
        capture_output=True,
        timeout=30,
    ).stdout
    assert hashlib.sha256(actual).hexdigest() == apk_hash, (
        "Installed APK must match frozen candidate"
    )
    adb("shell", "pm", "clear", PKG)
    adb("shell", "am", "start", "-n", PKG + "/.MainActivity")
    assert await_visible("Tresor entsperren")
    click("Tresor entsperren")
    auth()
    assert await_visible("Ersten Login speichern")
    assert visible("Sicherung wiederherstellen") and visible("Vom Desktop übernehmen")
    click("Vom Desktop übernehmen")
    assert visible("Desktop"), "Desktop setup must open"
    click("Tresor\nTab 1 of 5")
    click("Sicherung wiederherstellen")
    assert visible("Schlüssel"), "Backup setup must open"
    click("Tresor\nTab 1 of 5")
    reauthenticate()
    print("ONBOARDING_PHASE first login", flush=True)
    click("Ersten Login speichern")
    assert not visible("Notizen"), "Empty notes start collapsed"
    fill("HTTPS-Website", "example.com:8443/login?q=1#fragment")
    assert visible("Gespeichert wird: https://example.com:8443")
    fill("Benutzername oder E-Mail", "synthetic@example.test")
    fill("Passwort", "Synthetic-existing-password-2026!")
    find("Zufälliges Passwort erzeugen")
    click("Zufälliges Passwort erzeugen")
    assert visible("Passwort ersetzen?")
    click("Behalten")
    save()
    assert await_visible("Dein erster Login ist gespeichert")
    assert visible("example.com"), "Empty name must use the domain"
    print("ONBOARDING_PHASE edit and HTTP rejection", flush=True)
    reauthenticate()
    click("example.com", contains=True)
    top()
    assert visible("https://example.com:8443"), (
        "Stored origin must retain the exact port"
    )
    click("Eigenen Namen vergeben")
    fill("Name", "Synthetic onboarding custom")
    fill("HTTPS-Website", "http://example.com")
    save()
    top()
    assert visible("HTTPS-Domain eingeben"), "Explicit HTTP must remain rejected"
    fill("HTTPS-Website", "https://example.com:8443/login")
    save()
    assert await_visible("Synthetic onboarding custom")
    print("ONBOARDING_PHASE local suggestions and generation", flush=True)
    reauthenticate()
    click("Neuer Login")
    top()
    find("synthetic@example.test")
    click("synthetic@example.test", contains=True)
    top()
    fill("HTTPS-Website", "accounts.example.com")
    find("Zufälliges Passwort erzeugen")
    click("Zufälliges Passwort erzeugen")
    assert not visible("Passwort ersetzen?"), (
        "Empty password generation needs no overwrite approval"
    )
    click("Zufälliges Passwort erzeugen")
    assert visible("Passwort ersetzen?")
    click("Passwort ersetzen")
    save()
    assert await_visible("accounts.example.com")
    adb("shell", "am", "force-stop", PKG)
    adb("shell", "am", "start", "-n", PKG + "/.MainActivity")
    assert await_visible("Tresor entsperren")
    click("Tresor entsperren")
    auth()
    assert await_visible("Synthetic onboarding custom") and visible(
        "accounts.example.com"
    )
    click("Tresor sperren")
    assert await_visible("Tresor entsperren")
    for p, expected in hashes.items():
        assert hashlib.sha256((ROOT / p).read_bytes()).hexdigest() == expected, (
            "Source changed: " + p
        )
    result = dict(
        passed=True,
        synthetic_only=True,
        apk_sha256=apk_hash,
        api=36,
        source_files=hashes,
        actual_device_credential=True,
        empty_state_choices=True,
        backup_and_desktop_navigation=True,
        bare_website_accepted=True,
        exact_origin_preview=True,
        explicit_http_rejected=True,
        existing_password_confirmation=True,
        explicit_generation=True,
        local_username_suggestion=True,
        optional_notes=True,
        name_preserved=True,
        process_restart_persistence=True,
        lock_clears_ui=True,
        physical_device_acceptance=False,
        human_time_delta_seconds=None,
        action_frequency_per_day=None,
    )
    (HERE / "android-onboarding.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    )
    print(
        "PASS: actual Android first use, PIN, choices, origin, generation confirmation, suggestions, persistence and locking"
    )


if __name__ == "__main__":
    main()
