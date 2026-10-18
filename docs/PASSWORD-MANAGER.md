# Lokaler Passwortmanager · 0.12.0

Neu: [Passkey-Entsperren und befristete Feldfreigaben](ACCESS-AND-SHARING.md) sind direkt in Einstellungen und Eintragsansicht integriert. **Erste Schritte** führt zu Login, Import, Sicherung und optionalem Passkey. Ohne eigene HTTPS-Konfiguration bleiben Freigabelinks auf denselben Computer begrenzt.

Entpacke dein Plattformpaket und starte den enthaltenen Starter. Er öffnet `http://localhost:18240/passwords/`. Dafür sind weder Internet, ein HeavenKey-Konto noch ein Passkey erforderlich. Das Terminal bleibt geöffnet; `Ctrl+C` beendet den Dienst.

Beim ersten Start legst du ein Masterpasswort mit mindestens 14 Zeichen fest. Verwende eine eigene lange Passphrase. HeavenKey kann dieses Passwort nicht zurücksetzen. Sichere deshalb das Masterpasswort getrennt vom verschlüsselten Backup.

## Einträge und Sicherungen

Die App zeigt links Navigation und Tags, in der Mitte die Eintragsliste und rechts den ausgewählten Login. Suche und „Neuer Eintrag“ bleiben oben erreichbar. Die Feldaktionen im Detail kopieren Benutzername oder Passwort; Anzeigen und Kopieren sind getrennt. Favoriten und Tags filtern die Liste, die Sortierung wechselt zwischen A–Z und Z–A. Im schmalen Fenster öffnest du einen Eintrag aus der Liste und kehrst mit „Zurück“ zur erhaltenen Suche zurück.

„Einstellungen“ öffnet Import, verschlüsselte Sicherungen, Wiederherstellung und Masterpasswortwechsel. Das Hell-/Dunkel-Design lässt sich umschalten; gespeichert wird nur die Darstellungswahl. Zugangsdaten bleiben im verschlüsselten Tresor. Mit Strg/⌘ K erreichst du die Suche. F2 öffnet den Schnellzugriff für Logins und Formularprofile. Tastaturfokus und die aktive Auswahl sind sichtbar.

Der lokale Sicherheitscheck zeigt Einträge mit weniger als 14 Passwortzeichen und wiederverwendeten, nicht leeren Passwörtern. Von einem Hinweis gelangst du direkt zum betroffenen Login. Die Länge ist nur ein einfacher Anhaltspunkt und keine vollständige Stärkebewertung. Es werden keine Passwörter an einen Datenleckdienst gesendet.

Ein Login enthält Titel, Benutzername, Passwort, Website, Notiz, Tags, Favoritenstatus und optional ein TOTP-Geheimnis. Suche und Bearbeitung laufen im entsperrten Browser. Der Generator verwendet die Zufallsquelle des Browsers. TOTP wird lokal berechnet.

„Backup“ lädt ausschließlich den verschlüsselten Tresor herunter. Eine Wiederherstellung benötigt dessen Masterpasswort und eine ausdrückliche Bestätigung zum Ersetzen der aktuellen Einträge. Prüfe Wiederherstellung zuerst mit Beispieldaten. Ein CSV-Import liest eine lokale Datei im Browser; die gesamte Datei wird vor dem Speichern geprüft. Die Vorschau unterscheidet neue, identische und abweichende Logins anhand von Website-Origin und Benutzername. Identische Einträge und Konflikte werden zunächst übersprungen. Du kannst zusätzlich anlegen oder einen eindeutig zugeordneten Eintrag ersetzen. Erst die Bestätigung schreibt den gesamten ausgewählten Import. Ein identischer erneuter Import verändert standardmäßig nichts. CSV-Dateien aus anderen Programmen enthalten häufig Klartext. Bewahre solche Dateien nicht in öffentlichen oder synchronisierten Ordnern auf und entferne sie nach erfolgreicher Prüfung.

Auf dem Sperrbildschirm kannst du eine gültige Sicherung auch dann einspielen, wenn der aktuelle Tresor nicht mehr entschlüsselbar ist. Das Backup wird zuerst vollständig entschlüsselt und geprüft. Danach ersetzt es den bisherigen Tresor; anschließend gilt sein damaliges Masterpasswort. Eine falsche Backup-Passphrase oder manipulierte Sicherung verändert den gespeicherten Datensatz nicht. Bei einer Wiederherstellung im bereits entsperrten Tresor bleibt dagegen dessen aktuelles Masterpasswort erhalten.

Sperre den Tresor nach der Benutzung. HeavenKey sperrt zusätzlich nach fünf Minuten ohne Aktivität und nach 30 Sekunden im Hintergrund. Beim Sperren werden Schlüsselreferenz, Einträge und Formularwerte aus der Oberfläche entfernt. JavaScript garantiert keine physische Überschreibung aller früheren Speicherinhalte. Kopieren geschieht nur auf Knopfdruck. Die Bereinigung der Zwischenablage hängt von Browserberechtigungen ab; die Oberfläche nennt diese Grenze.

## Tastenkürzel und Datenschutz

F1 öffnet die Tastenkürzel mit einer eigenen Tastenkappe pro Taste. Die Suchfunktion verwendet Cmd+K unter macOS und Ctrl+K unter Windows/Linux. Ctrl+Alt+L sperrt den Tresor. Cmd+Enter beziehungsweise Ctrl+Enter speichert ausschließlich im geöffneten Editor. Escape schließt den aktuellen Dialog und setzt den Fokus zurück.

Die diskrete Ansicht verdeckt Benutzernamen, Websites und Notizen auch im auslesbaren HTML. Titel und Tags bleiben sichtbar; bewusstes Kopieren bleibt möglich. Bearbeiten, Passwortanzeige und Einmalcodes sind währenddessen gesperrt. Die Ansicht ersetzt keine Tresorsperre.

In den Einstellungen kannst du eine sofortige Hintergrundsperre aktivieren. Sonst gelten weiterhin 30 Sekunden. Angezeigte Passwörter werden nach 15 Sekunden verdeckt; wählbar sind 10 oder 30 Sekunden. Auswahlwechsel, Suche, Bearbeiten und Sperren beenden die Detailanzeige ebenfalls.

Das Sitzungsprotokoll enthält höchstens 40 Vorgänge mit Zeit, Aktion und Ergebnis. Es enthält keine Kontoinhalte oder Fehlertexte und wird beim Sperren gelöscht. Der Diagnoseexport enthält nur diese Metadaten und Datenschutzeinstellungen. Der Export lädt eine lokale Datei herunter. Datenschutzeinstellungen und Designpräferenz dürfen lokal gespeichert werden; entschlüsselte Tresorinhalte bleiben davon ausgeschlossen.

## Speicher und Verschlüsselung

Der Passwortmanager verwendet im angezeigten Datenordner die Datei `passwords.sqlite`. Darin liegen nur Revision und verschlüsselte Tresorhülle. Titel, Websites, Benutzernamen, Passwörter und TOTP-Geheimnisse werden gemeinsam im Browser verschlüsselt. Dieses Dateiformat ist unabhängig von der SQLCipher-Datenbank des Zugangslabors. Der lokale Server erhält weder Masterpasswort noch Entschlüsselungsschlüssel.

Neue Hüllen verwenden Argon2id mit 64 MiB Speicher, drei Durchläufen und einer Lane, 16 zufällige Salt-Bytes und AES-256-GCM mit einer neuen 12-Byte-IV je Speicherung. Legacy-Hüllen mit PBKDF2-HMAC-SHA256 und 600.000 Iterationen bleiben lesbar. Der Schlüssel ist im Browser nicht exportierbar. Version, Algorithmus, Größen und Kodierung werden vor der Entschlüsselung begrenzt. Normale Speichervorgänge behalten das vorhandene KDF-Format. Die [KDF- und Migrationsanleitung](VAULT-KDF.md) beschreibt den ausdrücklichen Wechsel samt Widerruf von Passkey-Umschlägen und Freigaben. Dies ersetzt kein unabhängiges Kryptografie-Audit.

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

Die erste Zeile startet den lokalen Passwortmanager, die zweite das bisherige Passkey-Zugangslabor auf einem anderen Port. Unter Windows heißt das Programm `HeavenKey.exe`. Das Labor enthält Passkeys, Recovery und begrenzte Agentenfreigaben; es benötigt weiterhin seinen eigenen Einrichtungscode und seine Schutzschlüssel. Die Datenbestände sind getrennt. Der Passwortmanager erlaubt mit `HEAVENKEY_SHARE_ORIGIN` einen getrennten HTTPS-Empfängerzugang; Verwaltungs- und Tresorpfade bleiben lokal.

## Abnahmegrenzen

Diese Ausgabe ist für den lokalen Betrieb vorgesehen. Automatische Passwortübernahme von Websites, mobile Apps, Cloud-/WLAN-Synchronisation, verwaltete Website-Passkeys, Anhänge und gemeinschaftlich bearbeitete Tresore sind noch offen. Die Browser-Erweiterungen ergänzen bestätigtes Autofill und Formularprofile; Installation und Browsergrenzen stehen in DISTRIBUTION.md. Desktoppakete sind nicht vom Herausgeber signiert oder notarisiert. Der aktuelle Vergleich und die Reihenfolge der verbleibenden Lücken stehen in [der Gap-Analyse](PASSWORD-MANAGER-GAPS.md).

## Formularprofile und Browserhilfe

Unter Einstellungen legst du Kontakt-, Adress- und weitere Formularprofile mit 58 unterstützten Feldtypen an. Werte und Titel werden mit dem Tresor verschlüsselt. Profile bleiben bei Login-Änderungen, Sicherungen und Passwortwechsel erhalten. Ein Tresor mit Profilen benötigt HeavenKey 0.11 oder neuer; ältere Ausgaben lehnen das neue innere Format ab. Die verschlüsselte Hülle bleibt kompatibel mit Version 1.

Die Erweiterung wird mit einem einmaligen, zwei Minuten gültigen Code aus den Einstellungen verbunden. Ihr eigenes Token gilt nur für die konkrete Erweiterungsherkunft und verschlüsselte Tresorzugriffe. Trennen oder Dienstneustart widerruft die Verbindung. Entsperren geschieht im geöffneten Popup; Passwort und Schlüssel werden nicht im Browserspeicher abgelegt.

Für Autofill wählst du den aktuellen Tab, das Profil und die Felder. Logins benötigen dieselbe Origin wie die gespeicherte Website. Allgemeine Profile benötigen eine ausdrückliche Bestätigung der Zielseite. Finanz- und Identitätsangaben sowie Geheimnisse benötigen gesonderte Freigaben. Vorhandene Werte bleiben standardmäßig erhalten. Die Erweiterung sendet keine Formulare ab und füllt keine fremden Frames aus. Die Seite kann bewusst ausgefüllte Werte wie manuelle Eingaben lesen.

Formularerkennung, Textübernahme, Zuordnung, Vorschau, Ausfüllen und Rückgängig laufen lokal. Eine Übernahme von Formulardaten wird erst nach Prüfung als verschlüsseltes Profil gespeichert; Passwörter werden dabei ausgeschlossen. Die Erweiterung braucht keine dauerhafte Berechtigung für alle Websites und keinen Smartfield-Daemon.

Beim Sperren oder Trennen werden wartende Formularaktionen vor der nächsten Browser-Dispatch-Grenze abgebrochen. Eine bereits an den Browser übergebene Füllung kann nachträglich nicht zurückgerufen werden; die Seite hat dann wie bei manueller Eingabe Zugriff auf diese Werte. Während einer Aktion sind Quellwerte und Freigaben gesperrt.
