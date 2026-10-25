# HeavenKey 0.26 Vorschau

Diese Vorschau vereinheitlicht Desktop, Erweiterungen und Android auf Version 0.26. Der Schwerpunkt ist der erste Login: weniger gleichzeitig sichtbare Felder, Website-Übernahme, lokale Nutzernamen-Vorschläge und bestätigte Passwortersetzung. Die [Einstiegsanleitung](ONBOARDING.md) erklärt die Bedienung.

Die [Downloads](https://github.com/Supersynergy/HeavenKey/releases/tag/v0.26.0-preview.1) umfassen fünf Desktop-Pakete, zwei Browser-Erweiterungen und die Android-APK. `SHA256SUMS` enthält die Dateihashes. `ACCEPTANCE.json` bindet Pakete, Quellstand, CI und unabhängige Prüfung zusammen. Der [Bericht zur vorigen Vorschau](RELEASE-0.25.md) bleibt als historischer Nachweis erhalten.

## Abnahme

Der Desktop-Einstieg verwendet einen frischen synthetischen Tresor mit dem tatsächlichen Rust-Dienst. Die Journey prüft vier sichtbare Felder beim ersten Login, Generierung und Bestätigung, lokale Vorschläge, Sicherungsdownload, Tastaturfokus, Sperren und Speicherung nach erneutem Öffnen. `mk` beobachtet die gespeicherten Einträge im laufenden Browser. Ein absichtlich ausgelöster Browserfehler prüft, dass ein fehlgeschlagener Lauf keinen grünen Beleg zurücklässt.

Android wird auf dem isolierten API-36-Emulator mit tatsächlicher Gerätesperre geprüft. Einstieg, Desktop-Abgleich, Konfliktbehandlung, Website-Passkeys, adaptive Browserfreigabe und Sicherung besitzen getrennte Belege unter `docs/evidence/mobile`. Normale APK und Integrationstest-APK sind getrennt bezeichnet. Die veröffentlichte APK muss dem Hash der normalen, geprüften APK entsprechen.

Die fünf portablen Desktop-Binärdateien werden jeweils auf Version, eingebettete Oberfläche, verschlüsselte Speicherung, Neustart und Ablehnung einer fremden Herkunft geprüft. Apple Silicon läuft nativ; Intel-macOS verwendet Rosetta, Windows Wine und Linux x64 QEMU im Linux-Gastsystem. Das ersetzt weder einen Windows-Kernel-Test noch Windows-Hello-Abnahme. Linux ARM64 läuft im Docker-Gastsystem. Die macOS-Hülle besitzt zusätzlich einen eigenen Selbsttest.

## Grenzen

Dies bleibt eine Entwicklungsvorschau mit synthetischen Testdaten. Die Android-APK verwendet einen Debug-Schlüssel. iOS-Paket, physische Geräteabnahme, Herausgebersignaturen und externes Kryptografie-Audit fehlen. Eine gemessene menschliche Zeitersparnis oder Überlegenheit gegenüber anderen Passwortmanagern wird nicht behauptet. Repository und Downloads behalten ihre bisherigen Zugriffsrechte.
