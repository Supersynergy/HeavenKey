# HeavenKey Mobile: Prüfstand

Stand: 24. Oktober 2026. Die App ist eine Entwicklungsvorschau für Testdaten.

| Ausgeführt | Ergebnis und Grenze |
|---|---|
| Zusammenführung auf GitHub `main` | Commit `1a906e1`; CI mit 181 Rust-, 147 Referenz- und 138 Browser-Prüfungen grün. Betrifft den bestehenden Core. |
| Flutter | Statische Analyse sowie 23 Funktions- und Widgettests. Kanalfehler und verzögerte Antworten verwenden einen simulierten Plattformkanal. |
| Android-Build | Aktueller nativer Test-Build mit Debug-Schlüssel. Test-APK und regulärer App-Einstiegspunkt werden getrennt gehalten. |
| Native Android-Sicherung | Echter Keystore und sechs Gerätefreigaben auf API-36-Emulator: verschlüsseltes Archiv, frische Nonces, Fehler ohne Datenverlust, Merge mit ausdrücklicher Konfliktregel, Systemdateidialoge zum Speichern und erneuten Öffnen, Abbruch und Sperre. |
| Format zwischen Plattformen | WebCrypto und tatsächlich kompiliertes Swift CryptoKit entschlüsseln gegenseitige Archive. Falscher Schlüssel und manipulierte Daten werden abgewiesen; Merge-Grenzen sind Teil des Oracles. |
| Android-Browser | Alte 0.22-APK bestand einfache Formularchecks. Eine spätere Portprobe widerlegte den vollständigen Herkunftsschutz. APK zurückgezogen; Legacy-Dienst und Freigabe-Activity deaktiviert. Browserintegration bleibt offen. |
| iOS | Plists und Xcode-Target geprüft. Swift-Regeln und Sicherungscode auf macOS ausgeführt. Domain-only-Anfragen abgewiesen. Kein UIKit-Build und kein Safari-Gerätetest. |

## Nachweise

Unter `docs/evidence/mobile` stehen `android-backup.json`,
`android-backup.log` und die vorherigen Core-/Browserbelege.
Die JSON-Dateien binden die tatsächlich verwendeten Quellen und APKs über SHA-256.
Test-APK und Vorschau-APK haben getrennte Einstiegspunkte und eigene Hashes.
Die frühere `android-browser.json` beschreibt den damaligen Stand und belegt
keine aktuelle Browserfreigabe.

Die Browserprüfung lud öffentliche HTTPS-Beispieldomains und ersetzte deren
Dokumentinhalt durch das beigefügte synthetische Formular. Sie prüft den nativen
Browser-/Systempfad, keinen produktiven Login-Server. Formularabsenden blieb
unterbunden; Zugangsdaten wurden nicht an die Domains gesendet.
Die spätere Portprobe verwendete lokale synthetische HTTPS-Seiten auf 8443/9443
mit einer auf das Testzertifikat begrenzten SPKI-Ausnahme. Sie belegte, dass die
alte APK den Standardport-Login auf `:8443` anbot. Der Beleg steht in
`android-port-browser-red.json`.

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
Bei Sicherungen bleiben Datei und Tresor nach falschem Schlüssel oder falschem
GCM-Tag erhalten. Veraltete Vorschaubindungen werden abgewiesen. Ein unveränderter
Import schreibt den Tresor nicht erneut; Ersetzen vorhandener IDs braucht die
ausdrückliche Auswahl. Die Android-Systemdateidialoge wurden tatsächlich bedient.

Ein unabhängiger Review fand einen Fehler beim Leeren der Android-Zwischenablage.
Der Gerätetest reproduzierte ihn nach einem 32-sekündigen App-Wechsel.
HeavenKey leert die eigene Kopie jetzt vor dem Fokusverlust. Kann Android die
Beschreibung gerade nicht liefern, bleibt die Eigentumsmarkierung für den
nächsten Fokuswechsel erhalten. Derselbe Test läuft grün; fremde Kopien bleiben
erhalten. Das rote Protokoll steht in `android-clipboard-red.log`.

## Offene Abnahme

Für die iPhone-Abnahme fehlen eine nutzbare Xcode-Umgebung, ein Apple Developer
Team und ein bereitgestelltes Testgerät. Auf beiden Plattformen fehlen eine
Produktionssignierung, die Sicherheitsreview und die vollständige Prüfung auf
physischen Telefonen mit aktuellen Browsern, einschließlich Port- und Frame-Fällen.
Die mobile Sicherung und Wiederherstellung sind implementiert und auf Android
ausgeführt. Die Synchronisierung mit dem Desktop bleibt offen. Die deaktivierte
Browserfreigabe erfüllt den ursprünglichen Integrationsauftrag noch nicht.

`python3 scripts/mobile_device_acceptance.py` bleibt deshalb ohne vollständigen
Gerätenachweis rot. Der GitHub-PR bleibt ein Entwurf. Eine Überlegenheit gegenüber
anderen Passwortmanagern ist nicht belegt.
