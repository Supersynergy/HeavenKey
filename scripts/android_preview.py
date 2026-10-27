"""Verify the isolated, release-mode Android preview; never accepts production IDs.

Debug certificates identify only disposable test builds. They are recorded for
inspection, never treated as an enduring publisher identity or production update.
"""
import argparse
import json
import os
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

from android_release import ABIS, ABI_CODES, ANDROID, digest, require, run, verify_device_evidence


def verify(directory, version, code, commit, evidence):
    require(re.fullmatch(r"\d+\.\d+\.\d+", version), "Invalid preview version")
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "Exact source commit required")
    receipt = verify_device_evidence(evidence, commit)
    sdk = Path(os.environ["ANDROID_HOME"])
    signer = str(sdk / "build-tools/36.0.0/apksigner")
    analyzer = str(sdk / "cmdline-tools/latest/bin/apkanalyzer")
    expected = {f"HeavenKey-{version}-android-preview-{abi}.apk" for abi in ABIS}
    require({p.name for p in directory.glob("*.apk")} == expected, "Unexpected preview artifacts")
    records = []
    certificates = set()
    for abi in ABIS:
        apk = directory / f"HeavenKey-{version}-android-preview-{abi}.apk"
        report = run(signer, "verify", "--verbose", "--print-certs", str(apk))
        pins = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)", report)
        require(len(pins) == 1 and "CN=Android Debug" in report, "Expected an explicitly disposable preview signer")
        certificates.add(pins[0].lower())
        manifest = ET.fromstring(run(analyzer, "manifest", "print", str(apk)))
        require(manifest.get("package") == "app.heavenkey.heavenkey_mobile.preview", "Preview must be a separate installation")
        require(manifest.get(ANDROID + "versionName") == version + "-preview" and
                manifest.get(ANDROID + "versionCode") == str(code + ABI_CODES[abi]), "Unexpected preview version")
        app = manifest.find("application")
        for name in ("debuggable", "testOnly"):
            require(app.get(ANDROID + name, "false") == "false", "Preview must use the release runtime")
        for name in ("allowBackup", "usesCleartextTraffic"):
            require(app.get(ANDROID + name) == "false", "Unsafe preview manifest")
        require("Vorschau" in app.get(ANDROID + "label", ""), "Preview channel must be visible")
        require(manifest.find("uses-sdk").get(ANDROID + "minSdkVersion") == "30", "Unexpected minimum Android API")
        require(all("fixture" not in node.get(ANDROID + "name", "").lower() for node in app.findall("activity")), "Test activity shipped")
        with zipfile.ZipFile(apk) as archive:
            names = archive.namelist()
            require(f"lib/{abi}/libapp.so" in names, "Missing release AOT code")
            require("assets/flutter_assets/kernel_blob.bin" not in names, "Debug Flutter kernel shipped")
            require({name.split('/')[1] for name in names if name.startswith('lib/') and name.endswith('/libflutter.so')} == {abi}, "Wrong APK architecture")
            for name in names:
                if name.endswith('.dex'):
                    dex = archive.read(name)
                    require(b"integration_test" not in dex and b"AutofillFixtureActivity" not in dex, "Test code shipped")
        records.append({"name": apk.name, "sha256": digest(apk), "abi": abi})
    require(len(certificates) == 1, "Preview APKs must share one build identity")
    metadata = {"kind": "android-preview", "production": False, "version": version + "-preview",
                "application_id": "app.heavenkey.heavenkey_mobile.preview", "source_commit": commit,
                "signing_certificate_sha256": certificates.pop(), "stable_publisher_identity": False,
                "synthetic_test_data_only": True, "native_device_evidence": receipt, "artifacts": records}
    (directory / "PREVIEW.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (directory / "SHA256SUMS").write_text("".join(f"{row['sha256']}  {row['name']}\n" for row in records))
    (directory / "release-notes.md").write_text(f'''HeavenKey Android {version} – Vorschau für Testdaten

Enthält Formularprofile, native App-Zuordnungen mit Signaturprüfung, Tastaturvorschläge,
Passworterzeugung im Registrierungsformular, 6/8-Wort-Passphrasen und verschlüsselte
V3-Sicherung inklusive Profilen. OIDC/BioID/KYC bleiben getrennte Roadmap-Vorhaben.

Android 11 oder neuer; Website-Passkeys benötigen Android 14. Für die meisten
aktuellen Telefone `arm64-v8a` wählen. `armeabi-v7a` ist für 32-Bit-ARM,
`x86_64` für entsprechende Emulatoren/Geräte.

Eigene App-Kennung `.preview`: kann parallel zur bisherigen HeavenKey-App installiert
werden. Daten werden nicht automatisch übernommen. Es gibt keinen App-Store-Upload.
Release-Laufzeit ohne Debugger, aber mit kurzlebiger Android-Debug-Signatur: KEINE
Produktionsidentität, keine Zusage kompatibler zukünftiger Updates. Nur Testdaten.
Vor einem Installationskanalwechsel eine verschlüsselte Sicherung und den getrennten
Schlüssel sichern und die Wiederherstellung prüfen; keinen vorhandenen Tresor löschen.

Quellstand: {commit}. UI-/Controller-, native Unit- und vier API-36-Emulatortests
bestanden. Physisches Telefon, aktuelle Browser-/Tastaturmatrix und externe
Sicherheitsprüfung sind noch offen. Android stellt nicht in jeder App eindeutige
Autofill-Felder bereit. Keine automatischen Formularsendungen oder Passwortänderungen.

Nachweise und Zertifikat: `PREVIEW.json`; Dateiprüfsummen: `SHA256SUMS`.
''')
    print("PASS: isolated release-mode preview APKs, signatures, architectures and source-bound evidence verified")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--code", required=True, type=int)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--device-evidence", type=Path, required=True)
    args = parser.parse_args()
    verify(args.directory, args.version, args.code, args.commit, args.device_evidence)
