# Passwortmanager 0.11.2 · Abnahme und Grenzen

Die Ausgabe ergänzt bestätigtes Browser-Autofill, verschlüsselte Formularprofile, den Schnellzugriff mit F2 und eine CSV-Importvorschau mit Duplikatprüfung. Ein allgemeiner Vorsprung gegenüber Enpass ist nicht nachgewiesen.

## Prüfumfang

Die Release-Abnahme verwendet `just check` und `just e2e`. Sie prüft Rust, Python, TypeScript, Kryptografie, lokale HTTP-Grenzen, Import, Backup, Wiederherstellung, Passwortwechsel und Revisionskonflikte. Die virtuellen WebAuthn-Prüfungen des getrennten Zugangslabors bleiben erhalten.

Der Passwortmanager läuft in Chromium gegen die echte Rust-API. Die Prüfungen umfassen Navigation und responsive Ansichten. Weitere Fälle prüfen Tastaturfokus sowie Datenschutzeinstellungen und die Bereinigung beim Sperren. Sie erhalten die bestehenden 1.000-Eintrags-, Neustart- und beschädigte-Tresor-Roundtrips. Profiltests prüfen verschlüsselte Speicherung und den Erhalt der Profile bei Login-Änderungen, Passwortwechsel und Wiederherstellung. Importtests prüfen Vorschau ohne Schreibzugriff sowie Abbruch. Identische Duplikate und ausdrücklich bestätigter Ersatz werden ebenfalls geprüft.

Die entpackte Chromium-Erweiterung koppelt mit dem echten Rust-Dienst. Sie prüft die genaue Login-Origin und die Feldzuordnung. Weitere Fälle behandeln sensible Werte mit gesonderten Freigaben sowie geschützte Frames. Rückgängig und veränderte Seiten erhalten eigene Prüfungen. Ein Browser-Test hält die native Script-Installation gezielt an und prüft, dass Sperren oder Trennen sowie `pagehide` eine wartende Füllung vor dem Klartext-Dispatch abbrechen. Dieser kontrollierte Zeitablauf ersetzt weder die echte API noch den echten Seiten-DOM. Bereits an den Browser übergebene Aktionen lassen sich nicht nachträglich zurückrufen.

Die headless Prüfung verwendet eine ausdrücklich im Testmanifest freigegebene localhost-Berechtigung. Der native optionale Berechtigungsdialog wird damit nicht abgenommen. Die ausgelieferten Manifeste enthalten diese feste Host-Freigabe nicht. Firefox wird auf Paketinhalt und Berechtigungen geprüft; eine Firefox-Laufzeitabnahme steht aus.

Zwischenablagebereinigung, vorgerückte Inaktivitätszeit und verzögerte Kryptovorgänge verwenden zusätzliche benannte Testdoubles. Diese beweisen keine physische Speicherlöschung oder garantierte Bereinigung der Betriebssystem-Zwischenablage. Sämtliche Testdaten sind synthetisch.

Die ausgeführten Fälle, Resultate und Binärhashes stehen in `ACCEPTANCE.json` beim Release. Frühere Nachweise gelten nur für ihre damaligen Quellen. Die unabhängige interne Quellprüfung ist an Dateihashes gebunden und ersetzt kein externes Kryptografie-Audit.

## Paketbindung und Laufzeitumgebungen

Alle fünf Desktop-Pakete müssen denselben Quellfingerprint enthalten. Die Manifeste nennen Version, Git-Commit und Binärhash. `SHA256SUMS` bindet Archive und Abnahmebericht. Veraltete Builds werden abgelehnt; Lizenztexte und erforderliche Drittanbieterquellen liegen bei.

| Paket | Prüfumgebung und Aussagegrenze |
| --- | --- |
| macOS ARM64 | Natives Apple Silicon; Browserfälle gegen die entpackte Binärdatei. |
| macOS x64 | Rosetta auf Apple Silicon; kein physischer Intel-Mac. |
| Windows x64 | Wine; keine native Windows-/Hello-Abnahme. |
| Linux ARM64 | ARM64-Linux-Container ohne WAN. |
| Linux x64 | QEMU im Linux-Container ohne WAN; kein physischer x64-Linux-Rechner. |

Für jedes Paket werden Start ohne Quelldateien, eingebettete Assets, Speichern und kalter Neustart geprüft. Browsernachweise gelten nur für den benannten Binärhash. GitHub-CI verwendet einen kurzlebigen lokalen Linux-Runner ohne kostenpflichtige Runner.

## Offene Grenzen

Die Pakete sind nicht vom Herausgeber signiert oder Apple-notarisiert. Physische Passkeys, native Biometrie, mobile Credential-Provider, Gerätesynchronisation, verwaltete Website-Passkeys, Anhänge und Eintragsfreigaben sind nicht abgenommen. Die Agenten des Zugangslabors erhalten keinen Zugriff auf den Passworttresor.

Eine beschädigte SQLite-Dateistruktur benötigt eine gültige Sicherung in einem neuen Datenordner. Bei beschädigtem Tresor-JSON oder Ciphertext kann dagegen eine vollständig geprüfte Sicherung vom Sperrbildschirm aus den bisherigen Datensatz ersetzen.
