# Passwortmanager 0.18.0 RC · Abnahme und Grenzen

Diese Ausgabe ergänzt wiederverwendbare SSH-Identitäten, den Import passender PKCS8-/Public-Key-Dateien, die Duplikatprüfung, eine Verbindungsvorschau und das Benennen vorhandener Passkeys. Die SSH-Identitäten liegen in derselben verschlüsselten Tresorhülle. Der bestehende SFTP-/FTPES-Broker behält ausdrückliche Einzelaufträge und Metadatenexporte für zehn Transferprogramme. Zehn Anbietervorlagen einschließlich netcup erleichtern die Einrichtung. Die Vorlagen sind keine Abnahme echter Kundenkonten oder sämtlicher nativer Fremdprogramme. Der [Transfervertrag](TRANSFER-BROKER.md) verlangt ein serverseitig eingeschränktes Konto; HeavenKey kann dessen Verzeichnisgrenze nicht beweisen.

`scripts/transfer_broker_e2e.ts` prüft echte SFTP- und FTPES-Verbindungen zu synthetischen lokalen Servern: Auflisten, Metadaten, Download, Upload, Schlüsselanmeldung, Host- und Zertifikatsprüfung, Ablehnung ungültiger Aufträge, Zustimmung, Widerruf, Sperren und verschlüsselte Persistenz. Der Releasebericht nennt die tatsächlich ausgeführten Plattformen und bindet Quellen sowie Binärdateien. Ältere Windows-Pakete gehören nicht zum neuen Transfer-Release.

Die Ausgabe integriert optionales PRF-Passkey-Entsperren, befristete verschlüsselte Feldkopien mit Empfänger-Passkey und einen Einrichtungsassistenten in den bestehenden lokalen Passwortmanager. Browser-Autofill, Formularprofile, Schnellzugriff und Importvorschau bleiben erhalten. Ein allgemeiner Vorsprung gegenüber Enpass ist nicht nachgewiesen.

## Geschützter Composer

Die Ausgabe ergänzt einen eigenen geschützten Agentenzugang, drei strukturierte private Felder, zufällige Referenzen und eine lokale Klartextvorschau. Der geschützte Zugang darf keine Website-Inhalte lesen und kann keine gewöhnlichen Lese- oder Transferrechte übernehmen. `scripts/protected_flow_e2e.ts` prüft den Ablauf gegen die echte App; `scripts/protected_sandbox_e2e.ts` prüft zusätzlich die eingeschlossene Linux-Shell. Die 24 geplanten Fälle werden im Releasebericht einzeln zu ausgeführten Nachweisen oder verbleibenden Grenzen zugeordnet. Fall 24 behandelt Nebenkanäle als Restrisiko. Keine beliebige PII-Erkennung, externe Zustellung oder universelle Website-Automation wird behauptet. [Bedienung und Vertrag](PROTECTED-FLOW.md).

## Prüfumfang

Die Release-Abnahme verwendet `just check` und `just e2e`. Sie prüft Rust, Python, TypeScript, Kryptografie, lokale HTTP-Grenzen, Import, Backup, Wiederherstellung, Passwortwechsel und Revisionskonflikte. Die virtuellen WebAuthn-Prüfungen des getrennten Zugangslabors bleiben erhalten.

Der Passwortmanager läuft in Chromium gegen die echte Rust-API. Die Prüfungen umfassen Navigation und responsive Ansichten. Weitere Fälle prüfen Tastaturfokus sowie Datenschutzeinstellungen und die Bereinigung beim Sperren. Sie erhalten die bestehenden 1.000-Eintrags-, Neustart- und beschädigte-Tresor-Roundtrips. Profiltests prüfen verschlüsselte Speicherung und den Erhalt der Profile bei Login-Änderungen, Passwortwechsel und Wiederherstellung. Importtests prüfen Vorschau ohne Schreibzugriff sowie Abbruch. Identische Duplikate und ausdrücklich bestätigter Ersatz werden ebenfalls geprüft.

Die entpackte Chromium-Erweiterung koppelt mit dem echten Rust-Dienst. Sie prüft die genaue Login-Origin und die Feldzuordnung. Weitere Fälle behandeln sensible Werte mit gesonderten Freigaben sowie geschützte Frames. Rückgängig und veränderte Seiten erhalten eigene Prüfungen. Ein Browser-Test hält die native Script-Installation gezielt an und prüft, dass Sperren oder Trennen sowie `pagehide` eine wartende Füllung vor dem Klartext-Dispatch abbrechen. Dieser kontrollierte Zeitablauf ersetzt weder die echte API noch den echten Seiten-DOM. Bereits an den Browser übergebene Aktionen lassen sich nicht nachträglich zurückrufen.

Die headless Prüfung verwendet eine ausdrücklich im Testmanifest freigegebene localhost-Berechtigung. Der native optionale Berechtigungsdialog wird damit nicht abgenommen. Die ausgelieferten Manifeste enthalten diese feste Host-Freigabe nicht. Firefox wird auf Paketinhalt und Berechtigungen geprüft; eine Firefox-Laufzeitabnahme steht aus.

Zwischenablagebereinigung, vorgerückte Inaktivitätszeit und verzögerte Kryptovorgänge verwenden zusätzliche benannte Testdoubles. Diese beweisen keine physische Speicherlöschung oder garantierte Bereinigung der Betriebssystem-Zwischenablage. Sämtliche Testdaten sind synthetisch.

Die ausgeführten Fälle, Resultate und Binärhashes stehen in `ACCEPTANCE.json` beim Release. Frühere Nachweise gelten nur für ihre damaligen Quellen. Die unabhängige interne Quellprüfung ist an Dateihashes gebunden und ersetzt kein externes Kryptografie-Audit.

`scripts/password_access_e2e.ts` verwendet die echte Rust-API und virtuelle CTAP2-Geräte des Browsers einschließlich echter PRF-Ergebnisse. Es prüft Einrichtung, verschlüsselte Speicherung, Entsperren nach Dienstneustart, Abbruch während nativer Registrierung, fehlende PRF-Unterstützung und Masterpasswort-Rückweg. Für Freigaben prüft es die ausdrückliche Feldauswahl, einen unabhängigen Empfänger mit eigenem Passkey, erneute Anmeldung, Widerruf, tatsächlichen Zeitablauf sowie die gemeinsame Ungültigmachung bei einem Passwortwechsel. Der kurze Ablauf-Test erzeugt über die echte API eine Zwei-Sekunden-Kopie; die Oberfläche bietet mindestens fünf Minuten. Keine physische Hardware und keine öffentliche Bereitstellung werden damit simuliert als abgenommen ausgegeben.

## Agenten-Broker

`scripts/password_broker_e2e.ts` startet die echte App und einen privaten Chromium-Browser gegen eine synthetische Login-Website. Es prüft menschliche Auswahl und Zustimmung, verschlüsselte Übergabe, begrenzte Agentenantworten, getrennte Clientrechte, unbekannte Befehle sowie Widerruf, Sperren und Tresorrevisionen. Zwischenablageaufrufe der Besitzeroberfläche werden erfasst. Ein eigener Ausführertest prüft Pipe-Anmeldung und Bereinigung. Die Prüfungen verwenden keine echten Zugangsdaten. Vollständige Falllisten und Quell-/Binärhashes stehen im Releasebericht.

Im gehärteten Linux-CI-Container läuft ausschließlich die synthetische Browserfixture mit einem ausdrücklich benannten Sandbox-Testoverride. Diese Prüfung belegt keine Chromium-Sandbox. Das Produkt selbst setzt keinen solchen Override; der native macOS-Brokerlauf verwendet den unveränderten Browser.

Der direkte Broker ist kein externer Sicherheitsnachweis. Der zusätzliche Startweg `--broker-sandbox` isoliert ausschließlich den darin gestarteten Agentenprozess. Ein zweiter uneingeschränkter Host-Zugang bleibt außerhalb des Schutzes. Seine [Schutzgrenze](AGENT-BROKER.md#schutzgrenze-und-trust-marker) umfasst die vertrauenswürdige Zielwebsite und den lokalen Rechner. Native Windows-/Linux-Browserintegration benötigt eigene Plattformabnahme; Paketstart und Cross-Compile sind davon getrennt.

`scripts/broker_sandbox_e2e.ts` prüft zusätzlich einen echten Linux-Container mit einer beliebigen Python-Shell: freigegebene Anmeldung im privaten Hostbrowser, verbotene Host-Datei-/Prozess-/Netzwerkzugriffe, Mount-/Ptrace-/Namespace-Versuche, RPC-Missbrauch, Ratenlimits, gefälschte Ausgabebelege sowie Bereinigung bei Fehler und Abbruch. Der Bericht bindet Quellen, Hostbinärdatei, Image und Kernel. Container-Isolation auf einem macOS-Host belegt keine native Windows-Sandbox. Details und verbleibende Grenzen stehen in [AGENT-SANDBOX.md](AGENT-SANDBOX.md).

## Paketbindung und Laufzeitumgebungen

Alle vier Desktop-Pakete dieses Releases müssen denselben Quellfingerprint enthalten. Die Manifeste nennen Version, Git-Commit und Binärhash. `SHA256SUMS` bindet Archive und Abnahmebericht. Veraltete Builds werden abgelehnt; Lizenztexte und erforderliche Drittanbieterquellen liegen bei.

| Paket | Prüfumgebung und Aussagegrenze |
| --- | --- |
| macOS ARM64 | Natives Apple Silicon; Browserfälle gegen die entpackte Binärdatei. |
| macOS x64 | Rosetta auf Apple Silicon; kein physischer Intel-Mac. |
| Windows x64 (älterer Release) | Wine; keine native Windows-/Hello-Abnahme und keine Abnahme des neuen Transfer-Brokers. |
| Linux ARM64 | ARM64-Linux-Container ohne WAN. |
| Linux x64 | QEMU im Linux-Container ohne WAN; kein physischer x64-Linux-Rechner. |

Für jedes Paket werden Start ohne Quelldateien, eingebettete Assets, Speichern und kalter Neustart geprüft. Browsernachweise gelten nur für den benannten Binärhash. GitHub-CI verwendet einen kurzlebigen lokalen Linux-Runner ohne kostenpflichtige Runner.

## Offene Grenzen

Die Pakete sind nicht vom Herausgeber signiert oder Apple-notarisiert. Physische Passkeys, native Biometrie, mobile Credential-Provider, Gerätesynchronisation, verwaltete Website-Passkeys, Anhänge und öffentlich betriebenes Freigabe-Hosting sind nicht abgenommen. Die Agenten des Zugangslabors erhalten keinen Zugriff auf den Passworttresor. Bereits vom Empfänger gespeicherte Angaben können nicht zurückgerufen werden.

Eine beschädigte SQLite-Dateistruktur benötigt eine gültige Sicherung in einem neuen Datenordner. Bei beschädigtem Tresor-JSON oder Ciphertext kann dagegen eine vollständig geprüfte Sicherung vom Sperrbildschirm aus den bisherigen Datensatz ersetzen.
