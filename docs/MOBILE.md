# HeavenKey auf Android und iPhone

Die Flutter-App unter `apps/mobile` ergänzt den vorhandenen Desktop-Passwortmanager.
Diese Entwicklungsversion ist für synthetische Testdaten vorgesehen. Sie hat einen
eigenen lokalen Speicher; sie synchronisiert den Desktop-Tresor noch nicht.
Version 0.23.0 ergänzt eine verschlüsselte Sicherung mit Wiederherstellung.

## Funktionen

Logins anlegen, ändern, suchen und löschen; zufällige Passwörter erzeugen;
kurze und mehrfach verwendete Passwörter lokal erkennen. Entsperren verwendet die
Gerätesperre. Nach einer Minute und beim Wechsel in den Hintergrund wird der
Tresor gesperrt. Der Editor entfernt dabei seine Passwortfelder aus der Oberfläche.

Android verwendet einen authentifizierungspflichtigen AES-GCM-Schlüssel im
Keystore und eine atomar geschriebene Datei im privaten, vom Backup ausgeschlossenen
Speicher. iOS verwendet einen gemeinsamen, durch Geräteauthentifizierung geschützten
Keychain-Eintrag für App und Credential Provider Extension. Die App implementiert
keine eigenen Verschlüsselungsprimitive. Der vorhandene Argon2id-Desktop-Tresor
wird dadurch nicht verändert oder automatisch konvertiert.

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

## Browserfreigabe pausiert

Der alte Android-Pfad bot im echten Browsertest einen Standardport-Login auf
einem anderen HTTPS-Port an. Seine APK wurde zurückgezogen. Der Dienst und seine
Freigabe-Activity sind jetzt im Manifest deaktiviert. Parserprüfungen allein
belegen keine sichere Zuordnung der Formularfelder zu ihrer vollständigen Herkunft.

Der iPhone-Provider-Entwurf akzeptiert ausschließlich vollständige HTTPS-URL-Kontexte.
Domain-Angaben und einzelne Credential-Identitäten reichen nicht aus, um den
anfragenden Port sicher festzustellen. Die Browserintegration ist deshalb weiterhin
ein offener Teil des Auftrags.
Die offiziellen Schnittstellen sind in der
[Android-Anleitung](https://developer.android.com/identity/autofill/autofill-services)
und der [Apple-Dokumentation](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller)
beschrieben.

## Abnahme und Grenzen

`just mobile-check` prüft Dart-Formatierung, Analyse, Funktions- und Widgettests,
native Sicherheitskonfiguration und den tatsächlichen Xcode-Objektgraphen. Der
Swift-Origin-Validator wird mit positiven und negativen Fällen ausgeführt.
Diese Prüfung ersetzt keinen iOS-Build und keinen Test in Safari oder Chrome.

Auf einem isolierten Android-Emulator mit API 36 wurden Geräteauthentifizierung,
verschlüsseltes Speichern mit wechselnder IV, erneutes Öffnen, Ändern, Löschen
und die Hintergrundsperre ausgeführt. In Version 0.22 füllte der native
Autofill-Dienst beide Felder nach PIN und Kontoauswahl. Die abweichende Domain
`example.org` erhielt keine Zugangsdaten; ein PIN-Abbruch ließ beide Felder leer.
Das Formular bestand aus synthetischem HTML in einem geladenen HTTPS-Dokument.
Chrome 133 verwendete seine damalige Autofill-Testoption. Die spätere Portprobe
zeigte, dass diese früheren Checks nicht ausreichten. Das ist keine Abnahme
auf einem physischen Telefon oder einem aktuellen Browser. Details und Hashes:
[Prüfstand](MOBILE-ACCEPTANCE.md).

Eine browserübergreifende Sicherheitsabnahme fehlt. Der
[Plattformvertrag](MOBILE-CONTRACT.md) beschreibt das weiterhin offene Ziel einer
vollständigen Herkunftsprüfung; das Abschalten des unsicheren Pfads erfüllt dieses
Ziel noch nicht. `just mobile-origin-check` bleibt ohne passenden Browserbeleg rot.

Offen sind der signierte iOS-Build mit Geräteprüfung, Safari-Autofill, die Prüfung
mit einem aktuellen Android-Browser auf einem Telefon, die native Sicherheitsreview
und die direkte Browserintegration. Ohne extern gespeicherte Sicherung und den
zugehörigen Schlüssel können Daten bei Geräteverlust oder entfernter Gerätesperre
verloren gehen. Deshalb diese Version ausschließlich mit Testdaten verwenden.
TOTP, Synchronisierung und das Speichern fremder Passkeys sind in der mobilen App
noch nicht enthalten. Eine Überlegenheit gegenüber anderen Passwortmanagern wurde
nicht nachgewiesen.

Der abschließende Geräte-Oracle `python3 scripts/mobile_device_acceptance.py`
bleibt ohne vollständige, zur Quelle passende Plattformbelege rot. Die laufende
Entwicklung wird dadurch nicht als fertige App-Abnahme ausgegeben.
