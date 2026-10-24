# Adaptive Browserfreigabe

Recherche und Produktentscheidung vom 24./25. Oktober 2026. Der Nutzer hat die
Recherche und die Anwendung geeigneter adaptiver Regeln beauftragt.

Die Qualität der Systemangaben bestimmt den Freigabeschritt. Wiederholte Nutzung
erzeugt keine weiteren Berechtigungen. Das Passwort wird weiterhin erst nach
Gerätefreigabe und Auswahl eines gespeicherten Logins übergeben.

| Verfügbare Angaben | Regel |
|---|---|
| Eindeutige HTTPS-URL aus dem iOS-Provider-Kontext | Exakten Host einschließlich Port vergleichen. Weitere Domain- oder URL-Angaben müssen dazu passen. |
| Android meldet HTTPS und den exakten Feld-Host, aber keinen verlässlichen Feld-Port | Browseridentität prüfen. Vor dem Entsperren eine Einmalfreigabe für diesen Host verlangen und den Umfang über andere HTTPS-Ports erklären. |
| HTTP, fehlendes Protokoll, widersprüchliche Hosts oder unbekannte Browsersignatur | Keine Passwortfreigabe. |
| Herkunft nur am übergeordneten Formular, ohne Angabe je Eingabefeld | Keine Passwortfreigabe; eingebettete fremde Felder lassen sich damit nicht zuordnen. |

## Begründung aus Primärquellen

[Bitwarden dokumentiert](https://bitwarden.com/help/uri-match-detection/), dass
Android-Autofill Ports und Pfade nicht zuverlässig für den URI-Abgleich liefert.
Ein aus der Browserleiste gelesener Port beweist außerdem nicht die Herkunft eines
eingebetteten Formularfeldes. Deshalb wird die Browserleiste nicht als Beleg für
eine vollständige Feldherkunft verwendet. Letzteres ist unsere Sicherheitsableitung.

[Androids Credential-Provider-Dokumentation](https://developer.android.com/reference/androidx/credentials/provider/CallingAppInfo)
verknüpft privilegierte Herkunftsangaben mit Paketname und Signatur. Für unseren
Autofill-Dienst übernehmen wir dieses Vertrauensprinzip. Der aktuelle Standardbrowser
muss eine bekannte aktuelle APK-Signatur besitzen. Die Signaturdaten stammen aus
[Googles öffentlicher Liste](https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json).
Es werden ausschließlich Release-Zertifikate ausgewählter Browserpakete übernommen.
Der eingefrorene Datensatz enthält 20 Pakete und 22 Zertifikate. Seine Herkunft
und SHA-256 stehen in `docs/evidence/mobile/browser-trust-provenance.json`.
Dies ist eine Vertrauensliste und keine Kompatibilitätszusage für alle Browser.
Während der Benutzung findet dafür kein Netzwerkabruf statt.

[Chrome unterstützt den nativen Android-Autofill-Dienst](https://android-developers.googleblog.com/2025/02/chrome-3p-autofill-services-update.html).
Die Einrichtung umfasst die Android-Auswahl und Chromes Option für einen anderen
Autofill-Dienst. Die App bietet einen Einstieg in diese Browsereinstellungen.
Der [Chromium-Vertrag](https://chromium.googlesource.com/chromium/src/+/HEAD/components/android_autofill/)
verlangt einen Neustart nach dieser Auswahl. Die Emulatorprüfung mit Chrome 133
verwendet zusätzlich dessen dokumentierte Legacy-Testoption. Chrome 133 liefert
[die Herkunft nur am Formular](https://github.com/chromium/chromium/blob/133.0.6943.137/components/android_autofill/browser/java/src/org/chromium/components/autofill/FormData.java);
HeavenKey weist diesen unvollständigen Kontext auch nach Einrichtung ab.
[Aktueller Chromium-Code liefert die Feldherkunft](https://github.com/chromium/chromium/blob/main/components/android_autofill/browser/java/src/org/chromium/components/autofill/FormData.java).
HeavenKey prüft die Angaben in jeder Anfrage. Das geschieht unabhängig von der
Browserversion. Emulatorbelege ersetzen keine Prüfung eines Telefonbrowsers.

[Apple unterscheidet Domain- und URL-Kennungen](https://developer.apple.com/documentation/authenticationservices/ascredentialserviceidentifier).
Eine Domain allein belegt kein HTTPS-Protokoll. Der iOS-Provider erklärt deshalb
den fehlenden Kontext und gibt dafür kein Passwort frei. Eine gespeicherte
Credential-Identity wird ebenfalls nicht als Beleg für die aktuelle Website benutzt.

## Umfang einer Android-Einmalfreigabe

Der Dialog zeigt den gemeldeten Host und erklärt die fehlende Trennung nach Ports
und eingebetteten Formularen derselben Domain. Die gespeicherte Adresse bleibt
unverändert. Es entstehen keine Wildcards oder Ausnahmen für übergeordnete Domains.
Bekannte widersprüchliche Feld-Hosts führen zum Abbruch. HTTP bleibt ausgeschlossen.
Die TLS-Verbindung selbst wird vom Browser geprüft; HeavenKey erhält dafür keinen
eigenständigen Zertifikatsnachweis.

Eine Anfrage läuft nach 30 Sekunden ab. Abbruch und Wechsel des Standardbrowsers
widerrufen die Freigabe. Die Auswahl prüft die Berechtigung erneut und verbraucht
sie genau einmal. Neue Passwörter, verdeckte Felder und mehrdeutige Formularpaare
erhalten keine gespeicherten Zugangsdaten.

Diese Entscheidung ersetzt die pauschale Android-Sperre der Vorschau 0.23 durch
eine ausdrückliche Berechtigung für jeden einzelnen Vorgang. Sie behauptet keine
vollständige Portprüfung der älteren Schnittstelle. Ausgeführte Browserbelege und
die weiterhin getrennte iPhone-Abnahme stehen in `MOBILE-ACCEPTANCE.md`.
