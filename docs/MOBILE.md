# HeavenKey auf Android und iPhone

Die Flutter-App unter `apps/mobile` ergänzt den vorhandenen Desktop-Passwortmanager.
Diese Entwicklungsversion ist für synthetische Testdaten vorgesehen. Sie hat einen
eigenen lokalen Speicher; sie synchronisiert den Desktop-Tresor noch nicht.

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

## Browser einrichten

Android: HeavenKey als Autofill-Dienst aktivieren und den gewünschten Browser als
Systemstandard wählen. Chrome benötigt zusätzlich „Autofill mit einem anderen
Dienst“. Die native Implementierung zeigt zuerst eine Entsperraufforderung und
anschließend die passenden Logins zur ausdrücklichen Auswahl.

Auf dem iPhone HeavenKey in „Automatisch ausfüllen & Passwörter“ aktivieren. Die
Credential Provider Extension fordert Geräteauthentifizierung und eine Auswahl an.
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
und die Hintergrundsperre ausgeführt. In echtem Chrome 133 füllte der native
Autofill-Dienst beide Felder nach PIN und Kontoauswahl. Die abweichende Domain
`example.org` erhielt keine Zugangsdaten; ein PIN-Abbruch ließ beide Felder leer.
Das Formular bestand aus synthetischem HTML in einem geladenen HTTPS-Dokument.
Chrome 133 verwendete seine damalige Autofill-Testoption. Das ist keine Abnahme
auf einem physischen Telefon oder einem aktuellen Browser. Details und Hashes:
[Prüfstand](MOBILE-ACCEPTANCE.md).

Die Auswahl vergleicht gespeicherte HTTPS-Websites mit den Metadaten des Systems.
Android akzeptiert Web-Anfragen nur vom gewählten Standardbrowser. HTTP und
abweichende, im Request sichtbare Domains werden abgewiesen. Ein vollständiger
URL-Identifier unterscheidet auch Ports. Reine Domain-Identifier enthalten keine
vollständige URL; insbesondere die Port- und Frame-Grenzen müssen für die jeweiligen
Browser noch auf Geräten geprüft werden. Eine browserübergreifende Sicherheitsabnahme
ist offen. Der [Plattformvertrag](MOBILE-CONTRACT.md) beschreibt das Entwicklungsziel.

Offen sind der signierte iOS-Build mit Geräteprüfung, Safari-Autofill, die Prüfung
mit einem aktuellen Android-Browser auf einem Telefon, die native Sicherheitsreview
und mobile Sicherung/Wiederherstellung.
Bei Deinstallation, Geräteverlust oder Entfernen der Gerätesperre können die lokalen
Daten verloren gehen. Deshalb diese Version ausschließlich mit Testdaten verwenden.
TOTP, Synchronisierung und das Speichern fremder Passkeys sind in der mobilen App
noch nicht enthalten. Eine Überlegenheit gegenüber anderen Passwortmanagern wurde
nicht nachgewiesen.

Der abschließende Geräte-Oracle `python3 scripts/mobile_device_acceptance.py`
bleibt ohne vollständige, zur Quelle passende Plattformbelege rot. Die laufende
Entwicklung wird dadurch nicht als fertige App-Abnahme ausgegeben.
