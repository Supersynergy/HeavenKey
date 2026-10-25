# HeavenKey Mobile: Prüfstand

Stand: 25. Oktober 2026. Version 0.26.0 ist eine Entwicklungsvorschau für Testdaten.

| Ausgeführt | Ergebnis und Grenze |
|---|---|
| Projektprüfungen | `just check` und `just e2e` lokal ausgeführt; Rust, TypeScript, Browser, Abhängigkeiten und Lizenzen grün. GitHub-CI ist ein eigener Nachweis. |
| Flutter | Statische Analyse und 30 Funktions-/Widgettests. Plattformkanalfehler verwenden einen simulierten Kanal. |
| Erster Einstieg | Desktop-Journey mit tatsächlichem Rust-Dienst und mk; Android-UI mit Gerätesperre. Sichtbare Felder und Freigaben sind geprüft; menschliche Zeitersparnis bleibt ungemessen. |
| Android-Regeln | 42 ausgeführte Kotlin-Fälle für HTTPS-Host, Signaturprüfung, Einmalfreigabe, Abbruch, Ablauf und Replay. |
| Native Android-Sicherung | Echter Keystore und sechs Gerätefreigaben auf API 36; verschlüsseltes Archiv, Fehler ohne Datenverlust, ausdrückliche Konfliktregel, Systemdateidialoge, Abbruch und Hintergrundsperre. |
| Sicherungsformat | 75 Prüfungen mit WebCrypto und tatsächlich kompiliertem Swift CryptoKit; gegenseitige Entschlüsselung, falscher Schlüssel, manipulierte Daten und Merge-Grenzen. |
| Android-Browser | Offiziell signiertes Brave 1.98.60 auf einem Emulator. Beide Felder nach Einmalfreigabe, PIN und Kontoauswahl befüllt; andere Ports, Frames, fremde Hosts, HTTP, Abbruch und Ablauf geprüft. |
| Website-Passkeys | Tatsächlicher Android Credential Provider im Browser; Erstellung und zwei geprüfte ES256-Anmeldungen, Abbruch, falsche RP und Persistenz über App-/Browser-Neustart. Kein virtueller Authenticator in diesem Test. |
| Desktop-Abgleich | Echte Desktop-Oberfläche und Android Keystore über gepinntes TLS; verschlüsselte Nutzdaten, Änderungen in beide Richtungen, Metadaten, Passkeys, Löschungen, Konfliktentscheidung, veraltete Vorschau und Widerruf geprüft. |
| Sicherheitsregressionen | 11 ausgeführte JVM-Komponentenfälle für Replay-Ablauf, parallele lokale Änderungen und Fehler beim Anwenden; fünf Web-Tests einschließlich verschlüsselter Revisionsgrenze. JVM-Dateien und Authentifizierung sind hier Test-Seams. |
| iOS | Swift-Regeln ausgeführt; Plists und das Xcode-Target geprüft. UIKit-Quelldatei syntaktisch geparst. Kein UIKit-Build und kein Safari-Gerätetest. |

## Aktuelle Nachweise

`docs/evidence/mobile/android-backup.json`, `android-browser-adaptive.json`,
`android-browser-passkeys.json`, `android-desktop-sync.json` und `android-onboarding.json`
binden die verwendeten Quellen und APKs mit SHA-256. Ihre Protokolle liegen daneben.
Test-APK und regulärer App-Einstiegspunkt bleiben getrennt. Die Herkunft des
Browser-APKs, sein Dateihash und die geprüfte Signatur stehen in
`test-browser-provenance.json`.

Die Browserprüfung verwendet lokale synthetische HTTPS-Seiten auf 8443/9443 sowie
eine HTTP-Gegenprobe auf 8888. Die Zertifikatsausnahme ist auf den SPKI des eigenen
Testzertifikats begrenzt. Formularabsenden bleibt unterbunden. Es wurden keine
echten Zugangsdaten verwendet oder an fremde Websites gesendet.

Die Android-Freigabe gilt einmalig für den gemeldeten HTTPS-Host einschließlich
anderer HTTPS-Ports und eingebetteter Formulare derselben Domain. Der Dialog
erklärt diesen Umfang vor der Authentifizierung. Eine vollständige Portprüfung
wird damit nicht behauptet. Gespeicherte Adressen bleiben unverändert.
Die [Entscheidung und Primärquellen](MOBILE-AUTOFILL-POLICY.md) beschreiben die Regeln.

Chrome 133 meldet keine Herkunft je Eingabefeld. Die native Anfrage wurde deshalb
abgewiesen; `android-legacy-missing-field-origin.log` hält das fest.
Die ältere 0.22-APK bleibt nach der widerlegten Portprüfung zurückgezogen.
Frühere Browserbelege sind historische Nachweise.

Die Sicherung prüft auch einen echten Wechsel für 31 Sekunden zum Android-
Startbildschirm. HeavenKeys eigene Zwischenablagekopie wird entfernt; eine fremde
Kopie bleibt erhalten. Nach der Gerätefreigabe wartet der Prüfcode auf den
zurückgekehrten Eingabefokus. Native Autofill-Ergebnisse werden erst nach ihrer
asynchronen Ankunft in den Browserfeldern gewertet.

## Offene Abnahme

Für iOS fehlen ein nutzbares iPhone-SDK, ein Apple Developer Team und ein
Testgerät. Produktionssignierung, die unabhängige Sicherheitsabnahme sowie
physische Telefone mit aktuellen Browsern stehen aus. Die Browser-Vertrauensliste
belegt keine Kompatibilität aller aufgeführten Pakete. Der Desktop verwahrt die
synchronisierten Website-Passkeys verschlüsselt; er ist kein Betriebssystem-
Passkey-Anbieter. Synchronisierung wird auf beiden Geräten manuell ausgelöst.

`python3 scripts/mobile_device_acceptance.py` bleibt ohne diese Gerätebelege rot.
Die Android-App wird als Entwicklungsvorschau verteilt. Eine allgemeine Überlegenheit gegenüber anderen
Passwortmanagern ist nicht belegt.
