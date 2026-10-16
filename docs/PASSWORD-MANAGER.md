# Lokaler Passwortmanager · 0.9 Vorschau

Entpacke dein Plattformpaket und starte den enthaltenen Starter. Er öffnet `http://localhost:18240/passwords/`. Dafür sind weder Internet, ein HeavenKey-Konto noch ein Passkey erforderlich. Das Terminal bleibt geöffnet; `Ctrl+C` beendet den Dienst.

Beim ersten Start legst du ein Masterpasswort mit mindestens 14 Zeichen fest. Verwende eine eigene lange Passphrase. HeavenKey kann dieses Passwort nicht zurücksetzen. Sichere deshalb das Masterpasswort getrennt vom verschlüsselten Backup.

## Einträge und Sicherungen

Die App zeigt links Navigation und Tags, in der Mitte die Eintragsliste und rechts den ausgewählten Login. Suche und „Neuer Eintrag“ bleiben oben erreichbar. Die Feldaktionen im Detail kopieren Benutzername oder Passwort; Anzeigen und Kopieren sind getrennt. Favoriten und Tags filtern die Liste, die Sortierung wechselt zwischen A–Z und Z–A. Im schmalen Fenster öffnest du einen Eintrag aus der Liste und kehrst mit „Zurück“ zur erhaltenen Suche zurück.

„Einstellungen“ öffnet Import, verschlüsselte Sicherungen, Wiederherstellung und Masterpasswortwechsel. Das Hell-/Dunkel-Design lässt sich umschalten; gespeichert wird nur die Darstellungswahl. Zugangsdaten bleiben im verschlüsselten Tresor. Mit Strg/⌘ K erreichst du die Suche. Tastaturfokus und die aktive Auswahl sind sichtbar.

Der lokale Sicherheitscheck zeigt Einträge mit weniger als 14 Passwortzeichen und wiederverwendeten, nicht leeren Passwörtern. Von einem Hinweis gelangst du direkt zum betroffenen Login. Die Länge ist nur ein einfacher Anhaltspunkt und keine vollständige Stärkebewertung. Es werden keine Passwörter an einen Datenleckdienst gesendet.

Ein Login enthält Titel, Benutzername, Passwort, Website, Notiz, Tags, Favoritenstatus und optional ein TOTP-Geheimnis. Suche und Bearbeitung laufen im entsperrten Browser. Der Generator verwendet die Zufallsquelle des Browsers. TOTP wird lokal berechnet.

„Backup“ lädt ausschließlich den verschlüsselten Tresor herunter. Eine Wiederherstellung benötigt dessen Masterpasswort und eine ausdrückliche Bestätigung zum Ersetzen der aktuellen Einträge. Prüfe Wiederherstellung zuerst mit Beispieldaten. Ein CSV-Import liest eine lokale Datei im Browser; die gesamte Datei wird vor dem Speichern geprüft. CSV-Dateien aus anderen Programmen enthalten häufig Klartext. Bewahre solche Dateien nicht in öffentlichen oder synchronisierten Ordnern auf und entferne sie nach erfolgreicher Prüfung.

Auf dem Sperrbildschirm kannst du eine gültige Sicherung auch dann einspielen, wenn der aktuelle Tresor nicht mehr entschlüsselbar ist. Das Backup wird zuerst vollständig entschlüsselt und geprüft. Danach ersetzt es den bisherigen Tresor; anschließend gilt sein damaliges Masterpasswort. Eine falsche Backup-Passphrase oder manipulierte Sicherung verändert den gespeicherten Datensatz nicht. Bei einer Wiederherstellung im bereits entsperrten Tresor bleibt dagegen dessen aktuelles Masterpasswort erhalten.

Sperre den Tresor nach der Benutzung. HeavenKey sperrt zusätzlich nach fünf Minuten ohne Aktivität und nach 30 Sekunden im Hintergrund. Beim Sperren werden Schlüsselreferenz, Einträge und Formularwerte aus der Oberfläche entfernt. JavaScript garantiert keine physische Überschreibung aller früheren Speicherinhalte. Kopieren geschieht nur auf Knopfdruck. Die Bereinigung der Zwischenablage hängt von Browserberechtigungen ab; die Oberfläche nennt diese Grenze.

## Speicher und Verschlüsselung

Der Passwortmanager verwendet im angezeigten Datenordner die Datei `passwords.sqlite`. Darin liegen nur Revision und verschlüsselte Tresorhülle. Titel, Websites, Benutzernamen, Passwörter und TOTP-Geheimnisse werden gemeinsam im Browser verschlüsselt. Dieses Dateiformat ist unabhängig von der SQLCipher-Datenbank des Zugangslabors. Der lokale Server erhält weder Masterpasswort noch Entschlüsselungsschlüssel.

Die Hülle verwendet PBKDF2-HMAC-SHA256 mit 600.000 Iterationen, 16 zufällige Salt-Bytes und AES-256-GCM mit einer neuen 12-Byte-IV je Speicherung. Der Schlüssel ist im Browser nicht exportierbar. Version, Algorithmus, Größen und Kodierung werden vor der Entschlüsselung begrenzt. Die authentifizierten Zusatzdaten lauten `HeavenKey password vault v1`. Die genaue Schreibweise ist Bestandteil des Dateiformats. Die Wahl der KDF folgt der [OWASP-Empfehlung für PBKDF2](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); dies ersetzt kein unabhängiges Kryptografie-Audit.

Der Dienst bindet ausschließlich an IPv4-Loopback. Exakter Host, Browser-Origin, eigener Anfrageheader und ein zufälliges Prozess-Token schützen die Schreibschnittstelle gegen fremde Webseiten. Ein Neustart erneuert das Token. Gleichzeitige Bearbeitung aus mehreren Tabs wird durch Revisionsprüfung abgewiesen; fremde Änderungen werden nicht still überschrieben. Programme im selben Benutzerkonto und ein kompromittierter Browser gehören zur Vertrauensgrenze.

| System | Standard-Datenordner |
| --- | --- |
| macOS | `~/Library/Application Support/HeavenKey` |
| Windows | `%LOCALAPPDATA%\HeavenKey` |
| Linux | `$XDG_DATA_HOME/HeavenKey` oder `~/.local/share/HeavenKey` |

Der ausführbare Programmordner darf beim Update ersetzt werden. Der Datenordner bleibt erhalten. Mit `--data-dir PFAD` lässt sich ein eigener Ordner wählen. Sichere den verschlüsselten Export regelmäßig an einem zweiten Ort.

## Zwei Startmodi

```sh
./heavenkey --password-manager --open
./heavenkey --port 18241 --open
```

Die erste Zeile startet den lokalen Passwortmanager, die zweite das bisherige Passkey-Zugangslabor auf einem anderen Port. Unter Windows heißt das Programm `HeavenKey.exe`. Das Labor enthält Passkeys, Recovery und begrenzte Agentenfreigaben; es benötigt weiterhin seinen eigenen Einrichtungscode und seine Schutzschlüssel. Die Datenbestände sind getrennt. Öffentliche HTTPS-Konfiguration ist im Passwortmanager-Modus ausgeschlossen.

## Abnahmegrenzen

Diese Ausgabe ist eine lokale Vorschau. Browser-Autofill, automatische Passwortübernahme von Websites, mobile Apps, Cloud-/WLAN-Synchronisation, verwaltete Website-Passkeys, Anhänge und Freigabe echter Tresore sind noch offen. Die Browser-Erweiterungen öffnen die Oberfläche; sie füllen keine fremden Webseiten aus. Desktoppakete sind nicht vom Herausgeber signiert oder notarisiert. Der aktuelle Vergleich und die Reihenfolge der verbleibenden Lücken stehen in [der Gap-Analyse](PASSWORD-MANAGER-GAPS.md).
