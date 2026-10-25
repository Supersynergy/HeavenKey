# Changelog

## Unreleased — Android ohne Desktop

- Eigener Passkey-Bereich, kompakterer Sperrbildschirm und ruhiges Material-3-Design mit Hell-/Dunkelmodus, größeren Bedienelementen und Login-Karten.
- Drei sichtbare Login-Felder beim Einstieg; eigener Name und Notizen bei Bedarf. Passwortlängen 16/24/32/48 direkt wählbar; bestehende Passwörter werden weiterhin nur nach Bestätigung ersetzt.
- Android bietet die Einrichtung einer fehlenden Gerätesperre direkt an. Zurück im Editor führt in den Tresor. Die Desktop-Kopplung bleibt optional.
- Android-V2-Sicherungen enthalten Logins und Website-Passkeys einschließlich verschlüsselter privater Schlüssel. Import prüft beide Bestände, Schlüsselpaare, Duplikate und die Vorschau-Bindung; bestehende Passkeys bleiben erhalten. V1-Login-Sicherungen bleiben lesbar. V2 erfordert einen neuen Android-Client; iOS und alte Clients unterstützen das Format nicht.
- Native Schlüssel verlassen den Android-Teil nur innerhalb der verschlüsselten Datei. Geräteverlust erfordert weiterhin eine extern gespeicherte Sicherung und ihren getrennt aufbewahrten Wiederherstellungsschlüssel. Telefon- und externe Sicherheitsabnahme bleiben offen.


## 0.26.0 Preview

- Vereinfachter erster Login mit vier statt neun gleichzeitig sichtbaren Desktop-Feldern. Website ohne Protokoll wird als HTTPS vorbereitet; eigene Namen bleiben erhalten.
- Android: Einstieg mit Login-, Sicherungs- und Desktop-Auswahl, genaue Herkunftsvorschau, lokale Nutzernamen und optionale Notizen.
- Bestätigte Passwortersetzung auf Desktop und Android; Generatorhinweis zur getrennten Änderung beim Website-Konto.
- Kontextuelle nächste Schritte nach dem ersten Speichern; Schutz-, Import-, Sicherungs- und Kopplungsfreigaben bleiben ausdrücklich.

## 0.25.0 Vorschau — 2026-10-25

- Gemeinsames Release mit macOS ARM64/Intel, Windows x64, Linux ARM64/x64, Android und Chromium-/Firefox-Erweiterung. Versionsangaben, Download-Verweise und Paket-Manifeste sind zusammengeführt.
- Desktop und Android ausdrücklich koppeln und Logins sowie Website-Passkeys manuell verschlüsselt abgleichen. Gepinntes TLS, Revisionsgrenzen, Konfliktwahl und Gerätewiderruf schützen den Abgleich; Desktop-Metadaten bleiben erhalten.
- Website-Passkeys über Android Credential Provider ab Android 14 erstellen und im geprüften Standardbrowser verwenden. Der Desktop bewahrt synchronisierte Schlüssel im verschlüsselten Tresor auf; ein Desktop-Betriebssystemanbieter ist noch nicht enthalten.
- Gerätebereich in Flutter und Kopplungs-/Abgleichseinstellungen am Desktop. Fehler bei Replay-Historie, parallelen Änderungen und alten Relay-Revisionen sind korrigiert.
- Android bleibt eine Debug-signierte Testvorschau. iOS, physische Telefonabnahme, Herausgebersignaturen und Produktionsfreigabe stehen aus.

## 0.24.0 Android-Vorschau — 2026-10-25

- Ausdrückliche Einmalfreigabe für die gemeldete HTTPS-Domain vor der Geräteauthentifizierung. Gleiche Domain mit anderen HTTPS-Ports oder Frames wird im Freigabedialog erklärt; vollständige Portprüfung wird nicht behauptet.
- Aktuelles Brave im Android-Emulator geprüft. Verschlüsselte Login-Sicherung, Systemdateidialoge und Hintergrundsperre bestanden mit synthetischen Daten.

## 0.21.0 Release-Kandidat — 2026-10-23

- Browser-Erweiterungen mit Formularprofilen und einmaligem PRF-Passkey-Entsperrkanal. Vor dem Einfügen werden Website und ausgewählte Felder bestätigt.
- Gemeinsame Desktop-Ausgaben für macOS, Windows und Linux. Native macOS-Abnahme, Rosetta-, Wine- und QEMU-Prüfungen sind getrennt dokumentiert.

## 0.20.0

- Tokio 1.53.3 behebt den I/O-Sicherheitsbefund RUSTSEC-2026-0386.

- macOS 14+: eigenes AppKit/WebKit-Fenster, flüchtiger Web-Kontext, native Import-/Exportdialoge und App-Menüs.
- Die App startet und beendet ihren eigenen lokalen Dienst. Ein belegter Port wird abgewiesen; beim Beenden wird das Prozessende überprüft.
- Windows-x64: speicherbasierte SSH-Schlüsselnutzung über das vorhandene OpenSSL-Feature; aktueller SFTP-/FTPES-Build.
- Einrichtung mit nächstem sinnvollen Schritt, direkten Transfer-/Agentenlinks und einer zusammenhängenden Bedienreise. Die Links erteilen keine Rechte.
- Windows-/Linux-Oberfläche bleibt im Systembrowser. Windows-Kernel-Sandbox, physische Passkeys, Herausgebersignaturen und Notarisierung bleiben gesonderte Abnahmen.


## 0.17.0 (Release candidate) — 2026-10-22

- Wiederverwendbare Ed25519-Identitäten im verschlüsselten Tresor: erzeugen, öffentlichen Schlüssel herunterladen und vorhandene Verbindungsschlüssel ohne Duplikate übernehmen.
- Import passender PKCS8-/OpenSSH-Public-Key-Dateien mit kryptografischer Paarprüfung. Referenzierte Schlüssel bleiben vor dem Entfernen geschützt; ungenutzte Schlüssel benötigen eine Bestätigung.
- Bestehende SSH-Identitäten für mehrere SFTP-Verbindungen auswählen. Der Besitzerbrowser löst Schlüsselreferenzen vor der versiegelten Brokerübergabe auf.
- Geprüfte Vorschau für Hostnamen, SFTP-/FTPES-Adressen und einfache SSH-Verbindungsangaben. Feldübernahme erfordert Zustimmung und führt keine Befehle aus.
- Gemeinsamer Einstieg zu Passkeys, SSH-Schlüsseln, Verbindungen und Formularprofilen. Passkey-Namen lassen sich mit Prüfung von Tresor und Revision ändern.
- Keine zusätzliche Abhängigkeit. Website-Passkey-Verwaltung, OS-SSH-Agent und weitere private Schlüsselformate bleiben offen.

## 0.16.0 (Release candidate) — 2026-10-22

- SFTP-/FTPES-Broker für macOS und Linux: verschlüsselte Verbindungsprofile, Ed25519-Schlüsselerzeugung im Besitzerbrowser und ausdrückliche Freigabe jeder Dateiaktion.
- Getrennte Agentenrechte, versiegelte Zugangsdatenübergabe, Host-Key-Pinning beziehungsweise verpflichtende TLS-/Hostnamenprüfung, begrenzte Datei- und Verzeichnisgrößen, Widerruf sowie feste Worker-/DNS-Grenzen.
- Serverseitig beschränktes Transferkonto mit Kontowurzel `/` erforderlich. Portable Metadatenprüfungen ersetzen keine serverseitige Ordnersperre und beseitigen keine Rennen mit anderen Remote-Schreibern.
- FileZilla-Importvorschau, Exporte ohne Geheimnisse und Einrichtungshilfen für zehn Transferprogramme sowie zehn Hosting-Anbieter einschließlich netcup. Native Drittprogramm- und Kundenkontoabnahme wird nicht behauptet.
- Neue Ausgaben für macOS und Linux; Windows verbleibt beim vorherigen Release. Signierung, Apple-Notarisierung und externes Sicherheitsaudit stehen weiterhin aus.

## 0.15.0 (Release candidate)

- New vaults and explicit rekeys use bounded Argon2id (64 MiB, three passes, one lane) with AES-256-GCM. Legacy PBKDF2 vaults and backups remain readable.
- Normal saves and extension profile edits preserve the unlocked KDF. The settings marker displays the actual stored scheme.
- KDF changes and salt changes revoke passkey wrappers and existing shares atomically; stale revisions cannot overwrite a migration.
- This remains a prerelease: native Windows isolation, trusted publisher signing and an independent external audit are pending.

## 0.14.0 — 2026-10-18

- Eingeschlossener Agentenstart mit geprüftem Linux-Container, unveränderlicher Image-ID und fest begrenztem Brokerkanal. Agenten erhalten weder Host-Dateien noch Clienttoken oder direkten Netzwerkzugang.
- Begrenzte Ressourcen und Laufzeit, Bereinigung der eigenen Container-ID sowie Linux-Prozessschutz gegen Core-Dumps und gewöhnliche Ptrace-Zugriffe.
- Ratenlimits für Clientoperationen und ungültige Tokens; Besitzerzugriff und Widerruf bleiben verfügbar.
- Neue triviale und kurzperiodisch wiederholte Masterpasswörter werden abgewiesen. Bestehende Tresore bleiben zum Passwortwechsel zugänglich.
- Ausdrückliche Schutzgrenzen und Anleitung für Shell-Agenten. Native Windows-Sandbox-Abnahme und externes Audit stehen aus.

## 0.13.0 — 2026-10-17

- Lokaler Agenten-Broker mit einmaliger Kopplung, ausdrücklicher Login-Auswahl und Zustimmung pro Anmeldung.
- Verschlüsselte Übergabe eines ausgewählten Logins an einen privaten Chromium-Ausführer über anonyme Betriebssystem-Pipes; kein Debug-Port und keine Zwischenablage.
- Begrenzte Textansicht statt roher Browsersteuerung; eigene Clientrechte, maximal fünf Minuten pro Sitzung, Widerruf und Sperrung bei Tresoränderung oder fehlendem Heartbeat.
- Ehrliche Trust-Marker zu unsigniertem Herausgeber, internem Review und OS-/Website-Vertrauensgrenze.
- Enthaltener Agentenclient und optionales Cargo-`-Zscript`-Hilfsskript auf Rust 1.101 nightly.
- Integrierte Browserprüfungen mit synthetischer Anmeldung, privaten Cookies, Consent, Widerruf und Profilbereinigung.

## 0.12.0 — 2026-10-17

- Optionales PRF-Passkey-Entsperren direkt im lokalen Passwortmanager; verifizierte Anmeldung, verschlüsselter Masterpasswort-Umschlag und unveränderter Masterpasswort-Rückweg.
- Befristete, verschlüsselte Kopien ausgewählter Login- und Profilfelder. Eigener Empfänger-Passkey, erneute Verifikation, serverseitiger Ablauf und Widerruf.
- Passkey-Umschläge und Freigaben werden beim Masterpasswortwechsel oder gesperrten Wiederherstellen gemeinsam ungültig.
- Einrichtungsassistent mit erstem Login, Import, Sicherung und optionalem Passkey; klare Hinweise auf lokale Freigabelinks und private GitHub-Downloads.
- Wiederherstellung einer gültigen Sicherung ersetzt weiterhin einen beschädigten alten Tresordatensatz.
- Integrierte Browserabnahme gegen Rust mit echten virtuellen WebAuthn-/PRF-Zeremonien, Neustart, Abbruch, Ablauf und Widerruf. Physische Geräte und externes HTTPS-Hosting bleiben gesonderte Abnahmen.

## 0.11.2 — 2026-10-17

- Restore the original HeavenKey cover to the README and embed the original square artwork in the local lock screen.
- Keep the consent-first product idea visible in the entry screen and browser connection settings, with the access lab's status explicit.
- Remove the theme-switch contrast flash; refine dark surfaces, placeholders, keycaps and control borders.
- Add a keyboard-accessible theme switch before unlock and clearer guidance for an empty vault.
- Check actual rendered text and control contrast in both themes, dialogs and locked responsive views.

## 0.11.1 — 2026-10-17

- Synchronize all existing feature PRs into main; close already-integrated stacked PRs by verified commit ancestry.
- Replace the old 0.9 README with current setup, features and tested platform limits.
- Add seven new real-app screenshots using only synthetic data.
- Publish the HeavenKey Proprietary License 1.0, retaining mandatory and third-party rights.
- Include the licensing guide in portable desktop archives.

## 0.10.0 preview · 2026-10-16

- Einzelne plattformgerechte Tastenkappen, F1-Hilfe und einheitliche SVG-Symbole.
- Browser-Adresskürzel bleiben verfügbar; Ctrl+Alt+L sperrt den Tresor.
- Diskrete Ansicht ohne Benutzernamen, Website oder Notizen im DOM.
- Begrenzte Detail-Passwortanzeige und optionale sofortige Hintergrundsperre.
- Sitzungsprotokoll und Diagnoseexport mit festem Metadatenschema; Protokoll wird beim Sperren gelöscht.
- Kurze Erfolgsmeldungen, dauerhafte Fehlermeldungen und größere Bedienflächen.

## 0.7.0 · 2026-10-16 · Quellstand

- Konto-Recovery mit einmaligem 256-Bit-Code, frischer Einrichtungsgenehmigung und atomarer Sperrung alter Schlüssel/Sitzungen/Agenten.
- AES-GCM-geschützter Dienst-Signierschlüssel mit OS-Keystore oder expliziter externer Schutzdatei; bestehender Seed wird erhalten.
- Optionaler PRF-Notiztresor mit getrennten Passkey-Umschlägen, Offline-Wiederherstellung und Versionsprüfung.
- Begrenzte Agentenaufträge mit eigenem Ed25519-Schlüssel, einmaligem Aufrufnachweis und ausführbarem synthetischem CRM-Ziel.
- Sitzungsgebundenes Lesen mit erneuter aktueller Berechtigungsprüfung, Abmeldung und Pilot-Audit.
- Chrome-/Firefox-Popup mit Bereichsauswahl, lokaler/HTTPS-Verbindung und gespeicherten Verbindungseinstellungen ohne zusätzliche Berechtigungen.
- Einfacher Quellstarter und sieben reproduzierbare Bedienillustrationen; Installations- und Benutzeranleitungen.
- SQLCipher-Speicher, Schlüsselhülle, Recovery und HTTPS auf einem gemeinsamen Stand integriert; widersprüchliche Schlüssel und Origin-Angaben verhindern den Start.
- HTTPS-Passkey-Zugriff, Sitzungslesen und Dokument-Agenten verwenden dieselbe private Dokumentquelle. TLS-Proxys erhalten die öffentliche Host-/Origin-Bindung.
- Offline-Gate, Widerruf-Snapshot, Mandantenbibliothek und unabhängige Referenzvektoren zusammengeführt. Die Mandantenbibliothek ist noch kein externer Produktconnector.
- Software-Protokollintegration, Browser-, DOM- und Kryptografietests ergänzt. Hardware, native Keystores, neue Desktop-Pakete und Firefox-Signierung bleiben offen.


## Unreleased: Browserdemo

- Teilen, Öffnen und Widerrufen eines Beispieldokuments ohne Anmeldung oder Installation.
- Eigener Browser-Einstieg unter `/demo/` und direkt nutzbare statische Dateien; keine zusätzliche Laufzeitabhängigkeit.
- Gespeicherter Demostand, Ablaufzeiten, Gastwechsel, Widerruf über mehrere Tabs und bestätigter Reset.
- Simulierte Rechte sind sichtbar gekennzeichnet und getrennt von der echten WebAuthn-/Serverprüfung.
- Encrypted local storage: `uac.sqlite` is a SQLCipher database keyed by `UAC_STORE_KEY` or a `store.key` file outside the data directory; plaintext databases migrate automatically on first start and a wrong key refuses to release any data.
- The issuer signing key moved from `data/issuer.key` into the database meta table; conflicting custody fails closed.
- New `--store-query '{"sql":..,"params":[..]}'` maintenance command for local operators, and `scripts/revocation_snapshot.py` exporting the delegation revocation set as a `uac-gate` snapshot (`{"version":1,"generated_at":…,"revoked":[…]}`) via `--store-query`.
- Grant-v0 conformance suite: `docs/vectors/grant-v0.json` (29 fixtures, 34 chain cases, 12 authorize cases, 17 decode rejections) generated by `crates/verifier/tests/grant_v0.rs` and independently re-verified by `scripts/grant-reference.mjs` in `scripts/ci.sh`; contract in `docs/GRANT-V0-CONTRACT.md`.

## 0.6.0 preview

- Desktop packages for Windows x64, macOS ARM64/Intel and Linux ARM64/x64, with browser assets embedded in the executable.
- User-profile data directories, browser-opening starters and explicit command-line configuration.
- Permission-free Manifest V3 launcher extensions for Chrome/Edge and Firefox.
- Static OpenSSL 3.6.5 from a checksum-verified upstream release; dependency notices and MPL source archives included.
- Release packaging rejects stale or modified builds and records source fingerprints and SHA256 checksums.

## 0.5: Test reliability fixes

- Eine fehlende API-Datei beendet den Browsertest unter macOS und Linux mit einer eindeutigen Fehlermeldung.
- Strg+C, SIGTERM und Zeitablauf beenden auch abgetrennte Kindprozesse des Befehlswrappers; normale Rückgabecodes bleiben erhalten.
- Eine fehlende oder fehlerhafte Prozessliste verhindert den Start von Befehlen mit Code `125`; Ausfälle während des Aufräumens werden ausdrücklich gemeldet.

## 0.5.0: Delegation profile preview

- Eigenes versioniertes Profil mit festgelegten Signierbytes und Identifiern; der Dienst signiert nach Passkey-Zustimmung jedes Kettenglied.
- Gäste geben erhaltene Rechte innerhalb der Laufzeit- und Weitergabegrenzen weiter; höchstens fünf Glieder und vier Weitergaben.
- Widerruf eines Vorfahren sperrt Nachfolger, offene Aufrufe und bereits bestätigte neue Weitergaben; Sperren bleiben über Neustart erhalten.
- Separate Delegationstabellen erhalten Legacy-Grants, Credentials und die 0.4-Aktionsfreigaben.
- 138 Browserfälle bestanden, alle 96 bisherigen erhalten; 45 Rust-Tests und 75 unabhängige Referenzprüfungen grün.
- Keine neue Laufzeitabhängigkeit; UCAN/DID- und Hardware-Abnahme bleiben gesondert.

## 0.4.0: Action approval preview

- Vier sensible API-Aktionen verlangen eine frische Passkey-Freigabe: Schlüssel hinzufügen/widerrufen und Zugang erstellen/widerrufen.
- Freigabe bindet die genauen Parameter, Sitzung, Konto und aktiven Signierschlüssel; monotone Gültigkeit von 60 Sekunden und einmaliger Verbrauch.
- Manipulierte Versuche verbrauchen die Freigabe. Neustart und Schlüsselwiderruf verwerfen offene Zustimmungen.
- Oberfläche nennt Aktion und Ziel, erlaubt den Abbruch des Passkey-Dialogs und anschließend einen erneuten Versuch.
- 96 Browser-Fälle bestanden; sämtliche 69 bisherigen Fälle erhalten. Die Rust-Suite umfasst 36 Tests.
- Keine neuen externen Abhängigkeiten. Das Delegationsprofil folgt nach diesem nachgewiesenen Autorisierungsengpass.

## 0.3.0: Credential lifecycle preview

- Quadratisches HeavenKey-Titelbild mit mittiger README-Platzierung.
- Bis zu acht aktive Passkeys pro Konto, mit ausdrücklichem Widerruf und Schutz des letzten Schlüssels.
- Bestehende Grants bleiben über einen stabilen Konto-Alias mit Ersatzschlüsseln verwendbar. Entfernte Schlüssel können sich nicht mehr anmelden.
- Sitzungs- und Zweckbindung beim Hinzufügen; Widerruf beendet Kontositzungen und offene Vorgänge.
- Idempotente Legacy-Migration erhält Sperren und alte Grant-Bytes.
- MIT-Adapter SimpleWebAuthn 14.0.0 ersetzt die eigene Browser-Konvertierung; Lizenz im Bundle erhalten.
- 69 Browser-Fälle und 29 Rust-Tests bestanden; unabhängiger Quellreview ohne offene Blocker.

## 0.2.0: Research preview

- HeavenKey als eigenständiges Projekt im GitHub-Account Supersynergy vorbereitet.
- Ein lokaler, zufälliger Einrichtungscode provisioniert den Eigentümer mit einer verifizierten Passkey-Einschreibung.
- Frühe Gäste, falsche Codes und konkurrierende Einschreibungen erhalten keine Eigentümerrolle.
- README mit generiertem Titelbild und dokumentierten Sicherheitsgrenzen ergänzt. Die Architektur ist als Diagramm enthalten; die Roadmap benennt die nächsten Abnahmen.
- CI-Ablauf und konfigurierbaren Chrome-Pfad ergänzt.
- Prüfungen bleiben zeitlich begrenzt; die ursprüngliche Spike-Frist blockiert spätere Entwicklungsphasen nicht.
- Build und Browser-Test verwenden dasselbe lokale Zielverzeichnis. Eine fehlende Server-Binärdatei führt zu einem schnellen Fehler mit beendetem Testlauf; die Regression wird bei der Prüfung ausgeführt.

## 0.1.0: UAC simulation spike

- WebAuthn mit signierten Leserechten für eine künstliche Ressource.
- 35 Browser-Fälle und 24 Rust-Core-Tests bestanden.
- Widerruf und die Aufrufbindung wurden über einen Neustart geprüft. Replay wird abgewiesen. Die Hardware-Abnahme wurde auf Wunsch auf später verschoben.
