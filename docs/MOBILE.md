# HeavenKey auf Android und iPhone

Die Flutter-App unter `apps/mobile` ergänzt den vorhandenen Desktop-Passwortmanager.
Diese Entwicklungsversion ist für synthetische Testdaten vorgesehen. Der
Quellstand 0.25 ergänzt auf Android die ausdrücklich gekoppelte, verschlüsselte
Desktop-Synchronisierung und Website-Passkeys. Der Abgleich wird auf beiden
Seiten manuell gestartet. Die adaptive Passwortfreigabe und die verschlüsselte
Login-Sicherung bleiben erhalten. Einrichtung und Grenzen stehen unter
[Desktop-Verbindung und Website-Passkeys](MOBILE-SYNC-PASSKEYS.md).

## Android-Vorschau installieren

Das [gemeinsame Release 0.26](https://github.com/Supersynergy/HeavenKey/releases/tag/v0.26.0-preview.1)
enthält `HeavenKey-0.26.0-android-preview.apk`, alle fünf Desktop-Pakete und beide Erweiterungen
und `SHA256SUMS`. Lade das APK auf ein
Android-Gerät und folge dessen Installationsdialog. Erforderlich sind Android
API 30 oder neuer und eine eingerichtete Gerätesperre. Das APK verwendet einen
Debug-Schlüssel und ist ausschließlich für Testdaten vorgesehen. Für den Abgleich
den Desktop aus demselben Release verwenden. Desktop und Erweiterungen tragen
jetzt ebenfalls Version 0.26.0; ihre Manifeste benennen den zugehörigen Quellcommit.

## Funktionen

Logins anlegen, ändern, suchen und löschen; zufällige Passwörter erzeugen;
kurze und mehrfach verwendete Passwörter lokal erkennen. Entsperren verwendet die
Gerätesperre. Nach einer Minute und beim Wechsel in den Hintergrund wird der
Tresor gesperrt. Der Editor entfernt dabei seine Passwortfelder aus der Oberfläche.

Android verwendet einen authentifizierungspflichtigen AES-GCM-Schlüssel im
Keystore und eine atomar geschriebene Datei im privaten, vom Backup ausgeschlossenen
Speicher. iOS verwendet einen gemeinsamen, durch Geräteauthentifizierung geschützten
Keychain-Eintrag für App und Credential Provider Extension. Die App implementiert
keine eigenen Verschlüsselungsprimitive. Die Argon2id-Verschlüsselung des
Desktop-Tresors bleibt bestehen. Verbindungsschlüssel und Website-Passkeys werden
in dessen verschlüsseltem Inhalt mitgeführt; sie stehen nicht im Klartext-Relay.

## Starten

Flutter 3.47.2 und Dart 3.13.2 wurden lokal verwendet.

```sh
cd apps/mobile
flutter pub get --enforce-lockfile
flutter run
```

Android benötigt API 30 oder neuer und eine eingerichtete Gerätesperre. Für den
lokalen Android-Build muss `ANDROID_HOME` auf das installierte SDK zeigen:

```sh
just mobile-check
just mobile-android
```

`just mobile-connected-check` verlangt die aktuellen quellgebundenen Nachweise
für Android-Abgleich, Browser-Passkeys, Autofill und Sicherung. Für dessen
JVM-Komponententest einmalig `bun scripts/mobile_policy_deps.ts` ausführen;
die kleine JSON-Testbibliothek wird vor Verwendung mit SHA-256 geprüft.

Das Debug-APK liegt danach unter
`apps/mobile/build/app/outputs/flutter-apk/app-debug.apk`. Es verwendet einen
Debug-Schlüssel und ist kein signiertes Produktionsrelease.

Für iOS 17 oder neuer `ios/Runner.xcworkspace` in Xcode öffnen. Für **Runner** und
**HeavenKeyAutofill** dasselbe Apple Developer Team auswählen und Credential
Provider sowie die gemeinsame Keychain-Gruppe in den Provisioning-Profilen
freigeben. Die Gruppe ist über `$(AppIdentifierPrefix)app.heavenkey.shared` gebunden.
Die Extension ist als eigenes Target eingebunden und wird in Runner eingebettet.
Ein Apple-Team oder eine Herausgebersignatur wird im Repository nicht vorgetäuscht.

## Sicherung und Wiederherstellung

Die mobile Sicherung enthält Logins. Website-Passkeys zusätzlich mit dem Desktop
synchronisieren und dessen verschlüsselten Tresor sichern.

Im Tab **Sicherung** einen Wiederherstellungsschlüssel erzeugen und getrennt
aufbewahren. Nach der Bestätigung speichert der Systemdialog eine verschlüsselte
`HeavenKey-YYYY-MM-DD.hkb.json`. Der Schlüssel steht nicht in dieser Datei.
Ohne ihn lässt sich die Sicherung nicht öffnen. Beim Dateidialog sperrt die App;
eine erfolgreiche Dateiauswahl entsperrt sie nicht automatisch.

Zum Wiederherstellen die Datei wählen, den Tresor erneut entsperren und den
Schlüssel eingeben. Die Vorschau zeigt Einträge ohne Passwörter. Vorhandene IDs
bleiben standardmäßig erhalten. **Vorhandene Einträge ersetzen** muss ausdrücklich
aktiviert werden. Änderungen am Tresor seit der Vorschau erfordern eine neue
Vorschau. Falscher Schlüssel und beschädigte Dateien ersetzen keine vorhandenen
Daten. Die Dateiauswahl bleibt höchstens fünf Minuten im Speicher.

Das mobile Format ist getrennt vom Argon2id-Desktopformat. Seine Verschlüsselung
wurde zwischen Swift CryptoKit und WebCrypto geprüft; die Android-Dateidialoge
und die Wiederherstellung wurden auf einem Emulator ausgeführt. Ein signierter
iPhone-Gerätetest steht noch aus.

## Browserfreigabe einrichten

Wähle HeavenKey in Androids Systemeinstellungen als Autofill-Dienst. In Chrome
muss zusätzlich Autofill mit einem anderen Dienst aktiviert sein. Die App bietet
beide Einstiege; ältere Browser können eine manuelle Einrichtung verlangen.

Vor jedem Vorgang prüft HeavenKey die Identität des aktuellen Standardbrowsers.
Bei der älteren Android-Schnittstelle wird anschließend die gemeldete HTTPS-Domain
angezeigt. Die Einmalfreigabe erklärt, dass andere HTTPS-Ports und eingebettete
Formulare derselben Domain dazugehören können. Erst danach folgen Gerätefreigabe
und Kontoauswahl. Die gespeicherte Adresse bleibt unverändert. Ein Abbruch setzt
keine Felder; eine spätere Anfrage braucht eine neue Freigabe.

Andere Hosts werden nicht aus einer gemeinsamen übergeordneten Domain abgeleitet.
HTTP und widersprüchliche Angaben werden abgewiesen. Eine Browsersignatur auf der
Vertrauensliste ist noch keine Kompatibilitätszusage für jede Browserversion.
Die [Regeln und Primärquellen](MOBILE-AUTOFILL-POLICY.md) erklären die Entscheidung.
Die alte 0.22-APK bleibt nach dem Portfehler zurückgezogen.

Der iPhone-Provider benötigt eine eindeutige HTTPS-URL. Zusätzliche Domain-Angaben
müssen dazu passen. Bei unvollständigem Kontext erklärt die Ansicht die Sperre;
das Entsperren bleibt deaktiviert. Eine gespeicherte Credential-Identität belegt
nicht die aktuelle Website. Die signierte iPhone-Abnahme steht weiterhin aus.

## Abnahme und Grenzen

`just mobile-check` prüft Dart-Formatierung, Analyse, Funktions- und Widgettests,
native Sicherheitskonfiguration und den tatsächlichen Xcode-Objektgraphen. Der
Swift-Origin-Validator wird mit positiven und negativen Fällen ausgeführt.
Diese Prüfung ersetzt keinen iOS-Build und keinen Test in Safari oder Chrome.

Die native Sicherung wurde auf einem isolierten Android-Emulator mit API 36
ausgeführt. Der aktuelle Browsercheck verwendet das offiziell signierte Brave
1.98.60 und lokale synthetische HTTPS-Seiten auf zwei Ports. Er verlangt vor
jeder Befüllung eine neue Freigabe und prüft auch fremde Frames, HTTP, Abbruch
und Ablauf. Die TLS-Ausnahme gilt ausschließlich für das Testzertifikat.
Chrome 133 liefert keine Herkunft je Eingabefeld und bleibt gesperrt.
Die Emulatorprüfung ersetzt keine Abnahme auf einem Telefon. Ergebnisse und
Quellenbindungen stehen im [Prüfstand](MOBILE-ACCEPTANCE.md).

Eine browserübergreifende Sicherheitsabnahme fehlt. Der
[Plattformvertrag](MOBILE-CONTRACT.md) unterscheidet den exakten URL-Abgleich und
die ausdrücklich erteilte Android-Einmalfreigabe. `just mobile-origin-check`
verlangt zur aktuellen Quelle passende Browserbelege; Parsertests allein reichen
nicht aus.

Offen sind der signierte iOS-Build mit Geräteprüfung, Safari-Autofill, die Prüfung
mit einem aktuellen Android-Browser auf einem Telefon, die native Sicherheitsreview
und die Abnahme weiterer Browser. Ohne extern gespeicherte Sicherung und den
zugehörigen Schlüssel können Daten bei Geräteverlust oder entfernter Gerätesperre
verloren gehen. Deshalb diese Version ausschließlich mit Testdaten verwenden.
TOTP ist in der mobilen Oberfläche noch nicht enthalten. Desktop-Abgleich und
Website-Passkeys gehören zum Android-Quellstand 0.25; Passkey-Nutzung als Anbieter
des Desktop-Betriebssystems ist damit nicht umgesetzt. Eine Überlegenheit gegenüber
anderen Passwortmanagern wurde nicht nachgewiesen.

Der abschließende Geräte-Oracle `python3 scripts/mobile_device_acceptance.py`
bleibt ohne vollständige, zur Quelle passende Plattformbelege rot. Die laufende
Entwicklung wird dadurch nicht als fertige App-Abnahme ausgegeben.
