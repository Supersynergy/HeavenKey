# Desktop-Verbindung und Website-Passkeys

Version 0.25 ergänzt den Android-Tresor um einen manuellen Abgleich mit dem
Desktop. Website-Passkeys können auf Android erstellt und verwendet werden.
Der Desktop führt sie im verschlüsselten Tresor mit und kann sie löschen.
Dies ersetzt keinen Passkey-Anbieter des Desktop-Betriebssystems.

## Geräte koppeln

1. Auf beiden Geräten HeavenKey öffnen und den Tresor entsperren.
2. Am Desktop unter **Einstellungen → Handy synchronisieren** die IPv4-Adresse
   oder den DNS-Namen dieses Computers im gemeinsamen Netzwerk eingeben.
   `localhost` bezeichnet auf dem Handy das Handy selbst.
3. Einen Gerätenamen eingeben und **Gerät koppeln** wählen. Damit öffnet
   HeavenKey einen eigenen TLS-Port, normalerweise den Desktop-Port plus eins.
   Die normale Desktop-Oberfläche bleibt ausschließlich über Loopback erreichbar.
4. Den einmaligen Code auf dem Handy unter **Geräte** einfügen und
   **Desktop koppeln und synchronisieren** wählen. Der Code enthält den geheimen
   gemeinsamen Schlüssel. Er gilt zwei Minuten und kann einmal verwendet werden.
5. Nach Änderungen auf beiden Seiten **Synchronisieren** wählen. Es gibt keinen
   Cloud-Dienst und keinen automatischen Hintergrundabgleich.

Eine belegte Portnummer wird als Fehler angezeigt. Gib keine fremde Adresse
ein und veröffentliche den Kopplungscode nicht. Die Verbindung prüft genau das
beim Koppeln übergebene Zertifikat; ein anderes Zertifikat wird abgewiesen.
Ein abgebrochener Kopplungsversuch kann als noch nicht abgeschlossen erscheinen.
Erneutes Synchronisieren setzt ihn fort, soweit Code und Freigabe noch gültig sind.

## Änderungen und Konflikte

Der Abgleich enthält Logins und Website-Passkeys. Auf dem Desktop vorhandene
Login-Metadaten bleiben erhalten, etwa Tags und Favoriten. Desktop-Einträge,
die außerhalb des mobilen Formats liegen, bleiben im gemeinsamen verschlüsselten
Stand erhalten; die App nennt deren Anzahl und macht sie nicht zu Autofill-Logins.

Beide Seiten vergleichen ihre Änderung mit dem letzten gemeinsamen Stand.
Eine Löschung ist eine Änderung: Ein unveränderter Eintrag auf der anderen Seite
stellt sie nicht wieder her. Wurde derselbe Eintrag auf beiden Geräten verändert,
erscheint ein Konflikt. Auf dem Handy zeigt **Geräte** die betroffenen Einträge
und bietet **Desktop-Stand wählen** beziehungsweise **Diesen Gerätestand wählen**.
Erst die anschließende Bestätigung ersetzt diese widersprüchlichen Einträge.
Andere Änderungen werden weiterhin zusammengeführt. Eine inzwischen veränderte
Vorschau muss erneut geprüft werden.

## Website-Passkeys verwenden

Die Android-Credential-Provider-Schnittstelle erfordert Android 14 oder neuer.
Wähle HeavenKey über **Geräte → Passkey-Anbieter einrichten** als Anbieter.
Aktiviere in Chromium-Browsern zusätzlich **Autofill using another service**
und bestätige den Browser-Neustart. Die konkrete Browser-Version muss diese
Weiterleitung unterstützen; eine erlaubte Signatur allein belegt das nicht.

Lege den Passkey auf der jeweiligen Website an. Android öffnet die
Anbieterauswahl; HeavenKey zeigt die HTTPS-Herkunft und verlangt Freigabe sowie
Geräteauthentifizierung. Beim Anmelden wird der passende Passkey ausdrücklich
gewählt. HeavenKey prüft den aktuellen Standardbrowser und dessen signierte
Identität erneut. Native Drittanbieter-Apps ohne geprüfte Browser-Herkunft
sind in dieser Version nicht Teil der Passkey-Freigabe.

Die Implementierung verwendet ES256 über die Plattform-Kryptografie sowie
`none`-Attestation. Sie erstellt keine Geräteherkunftsbestätigung. Zusätzliche
Authenticator-Erweiterungen werden bislang abgewiesen. Eine RP muss Challenges
und Signaturen selbst prüfen und alte Challenges zurückweisen. Der Anbieter
verhindert die Wiederverwendung einer bereits autorisierten, abgelaufenen oder
abgebrochenen Provider-Transaktion; eine lebenslange Historie jeder jemals
gesehenen Challenge ist keine Zusage.

## Schlüssel und Wiederherstellung

Private Passkey-Schlüssel und Verbindungsdaten liegen auf Android in
authentifizierungspflichtig verschlüsselten Dateien im privaten No-Backup-Speicher.
Der Desktop-Sync-Dienst speichert nur verschlüsselte Nutzdaten und gehashte
Geräte-Zugangsdaten. Der gemeinsame Entschlüsselungsschlüssel gehört zum
verschlüsselten Desktop-Tresor und zum geschützten Handy-Speicher.

Die mobile Sicherung enthält weiterhin **Logins**. Website-Passkeys lassen sich
über den synchronisierten Desktop-Tresor und dessen verschlüsselte Sicherung
aufbewahren. Dafür den Desktop nach Handy-Änderungen tatsächlich synchronisieren
und anschließend eine aktuelle Desktop-Sicherung erstellen.

Ein Masterpasswortwechsel widerruft Geräteverbindungen am Desktop. Koppel sie
danach neu. Auch verlorene Geräte ausdrücklich am Desktop widerrufen. **Verbindung
lokal entfernen** löscht nur die Verbindung auf dem Handy und bewahrt dortige
Logins und Passkeys; die Desktop-Freigabe muss zusätzlich widerrufen werden.
Eine Löschung im Tresor entfernt nicht die Registrierung bei der Website.
Bereits früher kopierte Schlüssel lassen sich dadurch nicht zurückrufen.

## Belegte Grenzen

Beide Clients führen eine akzeptierte Revisionsgrenze mit. Ein älterer, noch
authentischer Relay-Stand darf diese Grenze nicht unterschreiten. Werden jedoch
auch sämtliche lokalen Hochwasserstände aus einer alten vollständigen Sicherung
zurückgespielt, besteht kein unabhängiger Hardware-Zähler als Rollback-Nachweis.

Ein erfolgreicher Remote-Schreibvorgang und die mehreren lokalen Dateien bilden
keine gemeinsame Datenbanktransaktion. Der alte Vergleichsstand bleibt bei
unvollständiger Anwendung erhalten; ein erneuter Abgleich ist nötig. Gezielt
injizierte Strom-/Prozessabbrüche an jeder Dateigrenze sind noch keine ausgeführte
Geräteabnahme. Zertifikatsreparatur und eine unterbrechungsfreie Schlüsselrotation
sind ebenfalls keine verifizierten Produktfunktionen.

Android kann Zwischenablagezugriff im Hintergrund verweigern. Eine Löschung
genau nach 30 Sekunden im Hintergrund ist deshalb nicht garantiert; HeavenKey
versucht sie beim Wiedererlangen des Eingabefokus erneut. Physische Telefone,
iPhone/Safari und die Produktionsfreigabe bleiben separate Abnahmen.

## Primärquellen

- [Android Credential Provider](https://developer.android.com/identity/sign-in/credential-provider)
- [AndroidX Credentials: Versionen](https://developer.android.com/jetpack/androidx/releases/credentials)
- [Chromium-WebAuthn: Routing zwischen FIDO2 und Credential Manager](https://chromium.googlesource.com/chromium/src/+/HEAD/components/webauthn/android/)
- [Axum Server: OpenSSL-TLS](https://docs.rs/axum-server/0.8.0/axum_server/tls_openssl/)

Die Pakete sind exakt festgelegt: AndroidX Credentials 1.6.0, CBOR 0.9 und
axum-server 0.8.0. Plattform-Signaturen und AES-GCM stammen aus den vorhandenen
Plattform- beziehungsweise OpenSSL-Implementierungen. Die Tests verwenden
ausschließlich synthetische Konten und Schlüssel.
