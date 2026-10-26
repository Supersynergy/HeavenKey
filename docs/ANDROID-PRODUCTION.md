# HeavenKey Android 0.27.0 – Produktionsveröffentlichung

Die Android-App arbeitet eigenständig: kein Desktop-Tresor und kein Cloudkonto
sind für die lokale Nutzung erforderlich. Die tägliche Freigabe verwendet die
Android-Gerätesperre bzw. starke Biometrie. Unterstützte Websites können Passkeys
verwenden; andere Websites benötigen weiterhin ein eigenes Passwort, das die App
erzeugt und speichert. Eine Android-PIN und ein separat gesicherter
Wiederherstellungsschlüssel bleiben erforderlich.

Android 11 / API 30 ist die Mindestversion. Der Website-Passkey-Anbieter benötigt
Android 14 / API 34. Die Desktop-Version und ihre bisherigen Vorschau-Releases
werden unabhängig versioniert.

## Was diese Freigabe enthält

- Vereinfachter Start, schneller Passwortgenerator und drei Hauptfelder für neue
  Logins; Name und Notizen sind optional.
- Überarbeitete helle und dunkle Oberfläche mit eigenem Passkey-Bereich.
- Native, über Android Keystore geschützte Speicherung. Die App speichert ihre
  Tresordateien außerhalb von Android-Systembackups.
- Verschlüsselte portable Sicherung von Logins **und Passkey-Schlüsseln** im
  Archivformat v2. Ältere Login-Archive v1 bleiben lesbar.
- Wiederherstellung mit Vorschau, Konfliktprüfung und Bindung an den aktuellen
  Tresorstand. Bei einem unterbrochenen Speichern beider Dateien wird ausdrücklich
  gesperrt und eine erneute Vorschau/Wiederherstellung verlangt.

Archiv und Wiederherstellungsschlüssel müssen getrennt aufbewahrt werden.
Wer beide besitzt, kann die enthaltenen Logins und Passkeys entschlüsseln.
Ohne beide lässt sich ein verlorenes Gerät nicht über HeavenKey zurücksetzen.

## Verbindliche Release-Prüfungen

Der Workflow [Android production release](../.github/workflows/android-release.yml)
läuft auf `main`, wenn die Android-Version oder die Release-Konfiguration geändert
wird. Er lässt sich auf `main` außerdem manuell starten. Er veröffentlicht erst,
wenn alle folgenden Schritte erfolgreich sind:

1. Gesperrte Flutter-Abhängigkeiten, Formatprüfung, statische Analyse und sämtliche
   Flutter-Tests.
2. Native Android-Konfiguration, Debug-Build, portable Kryptografie-/Format-Tests
   und sechs Tests der Produktionssignaturprüfung mit temporären Testschlüsseln.
3. Zwei Instrumentierungstests auf einem eigens erstellten, isolierten API-36-
   Emulator mit echter Android-PIN-Abfrage und echtem Android Keystore. Geprüft
   werden Wiederherstellung einschließlich nutzbarer Passkey-Signatur, falscher
   Schlüssel, Manipulation, veraltete Vorschau und gesperrter Export.
4. Produktionsbuild mit privatem Herausgeberschlüssel. Fehlende Konfiguration,
   Android-Debug-Identität, falsches Schlüsselpasswort, abgelaufenes Zertifikat und
   abweichende Zertifikatskennung sperren den Build.
5. Prüfung jedes APKs mit `apksigner`, jedes App Bundles mit `jarsigner -strict`,
   der Zertifikatskennung, Architektur, Version und des kompilierten Manifests.
   `debuggable`, `testOnly`, Systembackup und Klartextverkehr sind deaktiviert.
6. Veröffentlichung mit SHA-256-Prüfsummen und `RELEASE.json`, das den exakten
   Quellcommit, das Herausgeberzertifikat und die ausgeführten Gerätetests bindet.

Die Instrumentierung verwendet keine Authentifizierungs-Hintertür in der App.
Alle Testdaten sind erfunden. Emulator-Abnahme ist keine physische Geräteabnahme;
die Tests beanspruchen auch keine aktuelle vollständige Browser-Abnahme und keine
unabhängige Sicherheitszertifizierung. Alte Browser-Belege im Repository gelten
weiterhin nur für ihre dort angegebenen Quellstände.

## Einmalig erforderliche Herausgeberkonfiguration

Ein gültiger Release-Build benötigt den **vorgesehenen dauerhaften
Herausgeberschlüssel**. Der Workflow erzeugt dafür keinen neuen Schlüssel und
verwendet niemals ersatzweise einen Debug-Schlüssel.

Unter [Repository Settings → Environments](https://github.com/Supersynergy/HeavenKey/settings/environments)
die Umgebung `android-production` mit folgenden Werten einrichten. Geheimnisse
gehören ausschließlich in GitHub, weder in den Quellcode noch in einen Chat.

| Typ | Name | Inhalt |
| --- | --- | --- |
| Secret | `HEAVENKEY_ANDROID_KEYSTORE_BASE64` | Einzeilig Base64-kodierter bestehender JKS- oder PKCS12-Keystore |
| Secret | `HEAVENKEY_ANDROID_STORE_PASSWORD` | Keystore-Passwort |
| Secret | `HEAVENKEY_ANDROID_KEY_ALIAS` | Alias des privaten Herausgeberschlüssels |
| Secret | `HEAVENKEY_ANDROID_KEY_PASSWORD` | Passwort des privaten Schlüssels |
| Variable | `HEAVENKEY_ANDROID_CERT_SHA256` | SHA-256 des zugehörigen X.509-Zertifikats, optional mit Doppelpunkten |

Den Keystore einschließlich Passwörtern separat sichern. Zertifikat und
Schlüsselidentität anhand der bisherigen Veröffentlichungen prüfen. Ein Wechsel
verhindert reguläre Updates vorhandener Installationen. Eine geschützte Umgebung
kann zusätzlich eine von GitHub verlangte Freigabe durch einen Maintainer haben.
Nach Einrichtung den Workflow auf `main` erneut ausführen.

## Downloads und Installationskanäle

Der Release-Tag lautet `android-v0.27.0`. Ein Tag wird nie überschrieben; für eine
weitere Version müssen Versionsname und Buildnummer in `apps/mobile/pubspec.yaml`
erhöht werden. Der Workflow ersetzt nicht die globale Desktop-Release-Markierung.

| Datei | Zweck |
| --- | --- |
| `HeavenKey-0.27.0-android-arm64-v8a.apk` | Direkte Installation auf den meisten aktuellen Android-Handys |
| `HeavenKey-0.27.0-android-armeabi-v7a.apk` | Unterstützte 32-Bit-ARM-Geräte ab API 30 |
| `HeavenKey-0.27.0-android-x86_64.apk` | Android-Geräte bzw. Emulatoren mit x86-64 |
| `HeavenKey-0.27.0-android.aab` | App Bundle zur separaten Einreichung in einen Store |
| `SHA256SUMS`, `RELEASE.json` | Integrität, Herausgeberkennung, Quellcommit und Testergebnisse |

Ein veröffentlichter GitHub-Release bedeutet keine Veröffentlichung im Play Store.
Play-App-Signing, Store-Einreichung und physische Geräteabnahme sind gesonderte
Schritte. Ein Store kann einen anderen App-Signaturschlüssel verwenden; APKs
verschiedener Signaturkanäle sind nicht automatisch gegenseitig aktualisierbar.

**Vor einem Kanalwechsel eine portable Sicherung exportieren und mit ihrem
Schlüssel prüfen. Eine bestehende Tresor-App nicht deinstallieren, solange die
Wiederherstellung nicht gesichert ist.** Eine alte Debug-Installation kann nicht
einfach durch eine anders signierte Produktions-App ersetzt werden.

## Lokale Prüfungen

```sh
cd apps/mobile
flutter pub get --enforce-lockfile
flutter analyze --no-pub
flutter test --no-pub
flutter build apk --debug --no-pub
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebugAndroidTest --no-daemon
cd ../../..
python3 scripts/android_signing_test.py
python3 scripts/android_device_acceptance.py
```

Der Gerätetest benötigt das Android-SDK-Systemimage
`system-images;android-36;google_apis;x86_64`, `ANDROID_HOME`, JDK 17 und die
SDK-Werkzeuge im Pfad. Er erstellt und löscht seinen eigenen Emulator; echte oder
bereits angeschlossene Geräte werden nicht ausgewählt.
