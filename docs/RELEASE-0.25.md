# Gemeinsame Vorschau 0.25.0

[Alle Downloads](https://github.com/Supersynergy/HeavenKey/releases/tag/v0.25.0-preview.1)
liegen jetzt in einem Release. Zuvor verwies die README noch auf Desktop 0.21,
während der aktuelle Android-Stand getrennt als mobile 0.25 veröffentlicht war.
Die übrigen Desktop-Pakete stammten dadurch noch aus dem älteren Quellstand.

| Ausgabe | Paket |
| --- | --- |
| macOS Apple Silicon | `HeavenKey-0.25.0-macos-arm64.zip` |
| macOS Intel | `HeavenKey-0.25.0-macos-x64.zip` |
| Windows x64 | `HeavenKey-0.25.0-windows-x64.zip` |
| Linux ARM64 | `HeavenKey-0.25.0-linux-arm64.tar.gz` |
| Linux x64 | `HeavenKey-0.25.0-linux-x64.tar.gz` |
| Android | `HeavenKey-0.25.0-android-preview.apk` |
| Chrome/Edge | `HeavenKey-0.25.0-extension-chromium.zip` |
| Firefox | `HeavenKey-0.25.0-extension-firefox.zip` |

Desktop und Erweiterungen wurden mit der gemeinsamen Paketversion 0.25.0 neu
gebaut. Die Android-APK bleibt bytegleich mit der bereits auf API 36 und
Brave 1.98.60 geprüften Ausgabe. Ihre SHA-256 lautet
`66a070236893e472f1d7260d1cda3aac97ba78ba14d93894187b8e99888cdb89`.
Es wurde keine mobile Implementierung für diesen Versionsabgleich verändert.

`ACCEPTANCE.json` benennt den Quellcommit und die verwendeten Build-Fingerprints.
Es enthält die Dateihashes aller acht Pakete, Laufzeitbelege pro Architektur,
die unabhängige Quellprüfung und die zugehörige GitHub-CI. `SHA256SUMS` bindet
auch dieses Liefermanifest und die beiliegende Handy-Anleitung.

macOS ARM64 wird nativ geprüft; Intel-Code läuft unter Rosetta. Linux ARM64
wird mit dem Linux-Kernel des lokalen Docker-Systems geprüft, Linux x64 über
QEMU-Userspace. Windows läuft für diese Kompatibilitätsprüfung unter Wine.
Diese Umgebungen sind im Manifest ausdrücklich bezeichnet. Sie ersetzen keine
Windows-Hello- oder Windows-Kernel-Abnahme und keinen Test auf einem physischen
Linux-/Intel-Computer.

Die Android-Belege umfassen den tatsächlichen Credential Provider mit Erstellung
und zwei geprüften Anmeldungen nach Gerätefreigabe. Desktop-Abgleich, Konflikte,
Löschungen und Widerruf wurden gegen den echten Android Keystore geprüft.
Die Browserprüfung mit `mk` und die nativen Android-Dialoge sind getrennte
Nachweise. Details stehen im [mobilen Prüfstand](MOBILE-ACCEPTANCE.md).

Die Ausgabe bleibt eine Entwicklungsvorschau. Die APK verwendet einen
Debug-Schlüssel; macOS hat Ad-hoc-Integritätssiegel. Herausgebersignaturen,
Apple-Notarisierung, physische Telefone und Produktionsfreigabe stehen aus.
Ein iOS-Paket kann auf dem aktuellen Host ohne vollständiges Xcode/iPhone-SDK
und Apple-Provisionierung nicht erzeugt werden. Vorhandene Releases und ihre
historischen Nachweise bleiben erhalten.

Für ein Update zuerst eine verschlüsselte Sicherung exportieren, dann die
bisherige App beenden und das Paket für den eigenen Prozessor aus diesem Release
starten. Der Datenordner bleibt bestehen. [Desktop installieren](DISTRIBUTION.md)
und [Handy koppeln](MOBILE-SYNC-PASSKEYS.md) beschreiben die Schritte.

Für spätere Veröffentlichungen prüft `just release-check` die Vollständigkeit,
die aktuelle Quellenbindung und die live gemeldeten SHA-256-Werte von GitHub.
