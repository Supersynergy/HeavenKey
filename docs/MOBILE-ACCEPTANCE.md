# HeavenKey Mobile: Prüfstand

Stand: 24. Oktober 2026. Die App ist eine Entwicklungsvorschau für Testdaten.

| Ausgeführt | Ergebnis und Grenze |
|---|---|
| Zusammenführung auf GitHub `main` | Commit `1a906e1`; CI mit 181 Rust-, 147 Referenz- und 138 Browser-Prüfungen grün. Betrifft den bestehenden Core. |
| Flutter | Formatierung, statische Analyse sowie neun Funktions- und Widgettests. Die Tests der Kanalfehler verwenden einen simulierten Plattformkanal. |
| Android-Build | Debug-APK mit dem regulären App-Einstiegspunkt. Kein Produktionsschlüssel. |
| Native Android-Integration | Tatsächlicher Keystore und Geräte-PIN auf einem isolierten API-36-Emulator: CRUD, verschlüsselte Datei, neue IV bei Änderung, erneutes Entsperren und Hintergrundsperre. |
| Android-Browser | Chrome 133 mit Autofill-Testoption: PIN, ausdrückliche Kontoauswahl, beide Loginfelder gefüllt, kein automatisches Absenden. Andere Domain und PIN-Abbruch liefern keine Zugangsdaten. |
| iOS | Plists, Entitlements, Xcode-Target und Einbettung geprüft. Swift-Origin-Regeln ausgeführt. Kein UIKit-Build, keine Signierung, kein Safari-Gerätetest. |

## Nachweise

Unter `docs/evidence/mobile` stehen `android-emulator.json`,
`android-browser.json`, die zugehörigen Protokolle und die Core-CI-Referenzen.
Die JSON-Dateien binden die tatsächlich verwendeten Quellen und APKs über SHA-256.
Der native Tresortest wurde nach den Autofill-Korrekturen erneut ausgeführt.
Test-APK und Vorschau-APK haben getrennte Einstiegspunkte und eigene Hashes.
Das Vorschau-APK enthält den regulären App-Einstiegspunkt; damit wurde auch der
Browsertest ausgeführt.

Die Browserprüfung lud öffentliche HTTPS-Beispieldomains und ersetzte deren
Dokumentinhalt durch das beigefügte synthetische Formular. Sie prüft den nativen
Browser-/Systempfad, keinen produktiven Login-Server. Formularabsenden blieb
unterbunden; Zugangsdaten wurden nicht an die Domains gesendet.

## Gefundene und behobene Fehler

Chrome liefert HTML-Attribute teilweise ohne Wert. Der erste native Request
stürzte daran ab; der Parser überspringt diese Attribute jetzt. Außerdem wurde
ein `Dataset` auf eine Anfrage nach einer ganzen `FillResponse` zurückgegeben.
Android wies dies mit `invalid index (65535)` zurück. Der Dienst verwendet nun
eine authentifizierte Dataset-Auswahl. Derselbe Browserablauf füllte danach
beide Felder. Die roten Protokolle und der grüne Beleg bleiben erhalten.

Weitere Regressionen prüften verspätete Entsperrantworten, gesperrte Schreibzugriffe,
Speichergrenzen und ungültige Ursprünge. Ein abgewiesenes Speichern wegen voller
Datei erhält den vorhandenen Tresor und den bearbeitbaren Entwurf.

## Offene Abnahme

Für die iPhone-Abnahme fehlen eine nutzbare Xcode-Umgebung, ein Apple Developer
Team und ein bereitgestelltes Testgerät. Auf beiden Plattformen fehlen eine
Produktionssignierung, die Sicherheitsreview und die vollständige Prüfung auf
physischen Telefonen mit aktuellen Browsern, einschließlich Port- und Frame-Fällen.
Synchronisierung, Sicherung und Wiederherstellung sind noch nicht implementiert.

`python3 scripts/mobile_device_acceptance.py` bleibt deshalb ohne vollständigen
Gerätenachweis rot. Der GitHub-PR bleibt ein Entwurf. Eine Überlegenheit gegenüber
anderen Passwortmanagern ist nicht belegt.
