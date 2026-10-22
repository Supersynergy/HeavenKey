# SSH-Schlüssel und Passkeys verwenden

Unter **Einstellungen → Zugänge und Schlüssel** erreichst du Passkeys, den SSH-Schlüsselspeicher, Verbindungen und Formularprofile direkt. Passkeys entsperren den HeavenKey-Tresor. SSH-Schlüssel dienen der Anmeldung an SFTP-Servern. Die Verwaltung von Website-Passkeys durch einen eigenen Betriebssystem-Credential-Provider gehört nicht zu dieser Funktion.

## SSH-Schlüssel speichern

Wähle **SSH-Schlüssel → Schlüssel erzeugen**, gib einen Namen ein und speichere. HeavenKey erzeugt ein Ed25519-Paar im Besitzerbrowser. Der private Schlüssel wird mit dem Gesamttresor verschlüsselt und gehört zu dessen verschlüsselter Sicherung. Der öffentliche Schlüssel und sein SHA256-Fingerabdruck erscheinen im Schlüsselspeicher. Nur den öffentlichen Schlüssel beim Anbieter hinterlegen.

Ein vorhandenes Paar lässt sich über **Schlüssel importieren** übernehmen. Wähle den privaten Ed25519-Schlüssel im PKCS8-PEM-Format und die passende öffentliche OpenSSH-Datei. HeavenKey prüft die mathematische Zuordnung durch Signieren und Verifizieren einer lokalen Zufallsnachricht. Diese Prüfung bestätigt keine Serveranmeldung. Dateien bleiben lokal; privater Schlüsseltext wird nicht in ein sichtbares Textfeld übernommen.

| Format | Import |
| --- | --- |
| Privater Ed25519-Schlüssel, `BEGIN PRIVATE KEY`, unverschlüsseltes PKCS8 | Mit passender öffentlicher Datei |
| Öffentlicher OpenSSH-Schlüssel `ssh-ed25519 …` | Zusammen mit privatem PKCS8; ein Kommentar wird entfernt |
| Privater Schlüssel `BEGIN OPENSSH PRIVATE KEY` | Noch nicht unterstützt |
| Passwortgeschützter privater Schlüssel, RSA oder ECDSA | Noch nicht unterstützt |

Die private Datei darf höchstens 16 KiB groß sein, die öffentliche Datei höchstens 1 KiB. Ein zweiter Eintrag desselben öffentlichen Schlüssels wird unabhängig vom Namen abgewiesen. Private Originaldateien außerhalb von HeavenKey bleiben bestehen und brauchen eigene Zugriffsschutz- und Sicherungsentscheidungen.

## Schlüssel wiederverwenden

Füge unter **Verbindungen** ein SFTP-Profil hinzu und wähle einen gespeicherten SSH-Schlüssel. Überprüfe den SHA256-Hostfingerabdruck über einen unabhängigen Kanal. Der gespeicherte SSH-Schlüssel meldet den Benutzer an; der Hostfingerabdruck identifiziert den Server. Diese beiden Fingerabdrücke haben unterschiedliche Aufgaben.

Mehrere Verbindungen können auf dieselbe Identität verweisen. Die Anzeige nennt die Anzahl der Verwendungen. Solange eine Verbindung den Schlüssel verwendet, ist Entfernen gesperrt. Stelle zuerst die Verbindung um oder entferne sie. Das Entfernen in HeavenKey widerruft keinen bereits beim Anbieter hinterlegten öffentlichen Schlüssel.

Ältere inline gespeicherte Verbindungsschlüssel funktionieren weiter. **Vorhandene Verbindungsschlüssel übernehmen** prüft die Paare und speichert sie ohne Duplikate im Schlüsselspeicher. Profile und Schlüssel werden gemeinsam verschlüsselt gespeichert. Neue Verbindungen mit einem erzeugten Paar nutzen den Schlüsselspeicher bereits automatisch. Für solche Referenzen ist HeavenKey 0.17 oder neuer erforderlich.

Ein Agent erhält weiterhin nur eine gekoppelte Berechtigung und stellt einen einzelnen Auftrag. Erst nach Zustimmung löst der Besitzerbrowser die Schlüsselreferenz auf und verschlüsselt die vorhandene Übergabe an den Broker. Die Freigabegrenzen des [Transfer-Brokers](TRANSFER-BROKER.md) bleiben bestehen. Downloads legen den bestätigten Dateiinhalt offen. Shell-Agenten benötigen die Sandbox ohne zusätzlichen Hostzugriff.

## Verbindungsdaten übernehmen

Im Verbindungsdialog kannst du `ssh benutzer@server -p 2222`, eine SFTP-Adresse oder eine explizite FTPES-Adresse einfügen. Prüfe die Vorschau und übernimm die Felder. Es wird keine Verbindung aufgebaut. Adressen mit eingebettetem Passwort, Remote-Pfad oder zusätzlichen SSH-Optionen werden abgewiesen. Die Eingabe wird nach der Vorschau geleert. Der Anbieter, die Hostidentität und die Anmeldung benötigen weiterhin deine Prüfung.

## Passkey benennen

Bei einem eingerichteten Entsperr-Passkey kannst du **Umbenennen** wählen. Nur der Anzeigename ändert sich. Credential-ID, Passkey-Material und verschlüsselter Tresor bleiben erhalten. Eine Änderung für einen überholten Tresorstand wird abgewiesen. Das Masterpasswort bleibt der Rückweg, wenn ein Gerät kein PRF unterstützt oder ein Passkey nicht verfügbar ist. Physische Passkey-Hardware ist von den virtuellen Browserprüfungen getrennt zu bewerten.
