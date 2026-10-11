# UAC-Spike: Simulation und neue Aufwandsschätzung

Dieser Bericht beschreibt den abgeschlossenen Stand 0.1. HeavenKey 0.2 ergänzt die kontrollierte Eigentümer-Einschreibung; die aktuelle Fallzahl steht in [e2e.json](evidence/e2e.json) und der Ausbau in [ROADMAP.md](ROADMAP.md).

Stand: 12. Oktober 2026. Auftrag: maximal acht Stunden, Rust + TypeScript, Metacode, Efficiency Orchestrator und die zehn ausgewählten Skills. Auf Wunsch des Nutzers wurde der Hardwaretest zurückgestellt. Die Ergebnisse betreffen die Simulation.

## Ergebnis

**Die Passkey-/Verifier-Verbindung funktioniert im simulierten Browserpfad.** Drei voneinander isolierte Browserkontexte stellen Eigentümer, Gast und fremden Nutzer dar. Virtuelle CTAP2-Authentikatoren erzeugen echte P-256-Signaturen über die WebAuthn-Daten. Die Oberfläche verwendet `navigator.credentials.create/get`; Rust prüft mit `webauthn-rs 0.5.5` und dem UAC-Verifier.

Der lokale Spike enthält Einschreibung, Anmeldung, ein signiertes Leserecht, einen daran gebundenen Passkey-Aufruf und bestätigten Widerruf. SQLite bewahrt Credentials, Widerrufe und akzeptierte Operationen über einen Server-Neustart. Vergebene Rechte sind an das eingeschriebene Gast-Credential gebunden. Der private Herausgeberschlüssel bleibt auf dem Server.

| Nachweis | Ergebnis | Datei |
|---|---|---|
| Rust-Kern | 24 Tests bestanden | [check.log](evidence/check.log) |
| Browser-/API-Pfad | 35 Fälle bestanden; 0 fehlgeschlagen | [e2e.json](evidence/e2e.json) |
| Formatting, TypeScript, Clippy und Builds | `just check` bestanden | [Prüfprotokoll](evidence/check.log) |
| Abhängigkeiten, Quellen und Lizenzen | cargo-deny, cargo-audit und bun audit bestanden | Im Prüfprotokoll |
| Semgrep | Vier Quelldateien, 0 Findings, 0 Parserfehler | [semgrep.json](evidence/semgrep.json) |
| Gitleaks, eigene Quellbereiche | apps/, crates/ und scripts/: jeweils 0 | [Metadaten und Diagnose](evidence/generated-secret-diagnosis.json) |
| Review des aktuellen Quellstands | Trust-, Fehler-, Zustands- und Aufrufpfade geprüft | [REVIEW.md](REVIEW.md) |

Die vollständige Fallliste enthält unter anderem gültige Einschreibung und Nutzung, fremden Empfänger, Schreibausweitung, falsche Ressource, verändertes signiertes Token, geänderte Argumente, Wechsel von Nutzung zu Login, Replay, parallele doppelte Nutzung, Ablauf, Widerruf zwischen Challenge und Ausführung sowie Credentials, Widerruf und Replay nach Neustart. Falsche Origin, RP-ID-Hash, Challenge, Nutzerverifikation und zurückgestellter Counter werden zusätzlich mit kryptografisch gültig neu signierten Testantworten geprüft. Ein kaputtes Signaturformat wird ebenfalls abgewiesen.

Die 35 Fälle liefen im letzten erfolgreichen Durchlauf in rund vier Sekunden. Das ist eine Dauer der lokalen Test-Suite mit automatischer Präsenzsimulation; keine Nutzerlatenz, keine Hardwaremessung und kein Sprachvergleich.

## Was die Simulation belegt

Die Browser-Serialisierung, WebAuthn-Zustandsmaschine, Signaturprüfung und Bindung an einen konkreten Aufruf arbeiten gemeinsam. Das Zugangsrecht kann nicht allein durch Kopieren des Tokens genutzt werden. Eine frisch geprüfte Passkey-Assertion gehört zum Zugriff.

Die Bindung entsteht aus der zufälligen WebAuthn-Challenge und dem dazu serverseitig gespeicherten Aufruf. Beim Abschluss wird der exakt gespeicherte Aufruf verglichen. Damit wird der Passkey korrekt als WebAuthn-Credential verwendet; er wird nicht als frei verwendbarer Ed25519-Signer behandelt. Die Registrierung und Verifikation folgen dem bestehenden Bibliothekspfad. [webauthn-rs](https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/).

Der virtuelle Authentikator simuliert Präsenz und Nutzerverifikation. Er ersetzt keine Messung von Touch ID, Hardwarebindung, Synchronisierung oder Recovery. Chrome beschreibt diese virtuellen Geräte ausdrücklich als Entwicklungswerkzeug. [Chrome WebAuthn-Emulation](https://developer.chrome.com/docs/devtools/webauthn).

Die Browseransicht nach einem akzeptierten Zugriff:

![UAC-Zugang im Browser erfolgreich geprüft](evidence/browser-success.png)

## Grenzen und Fehlerkorrekturen

Die Ressource ist ein künstliches Dokument im lokalen Labor. Der erste eingeschriebene Nutzer wird zum Eigentümer. Das ist ein explizites Bootstrap-Modell für den Spike; es weist kein reales Eigentum nach. Ein bestehendes Softwareprodukt oder externer Dienst wurde nicht angebunden. Der verwendete signierte Token ist ein eigenes lokales Profil und noch kein UCAN-Konformitätsnachweis.

Nicht geprüft wurden reale Geräte, Biometrie, ein zweites physisches Gerät, reale Mandanten, verlorene Geräte, produktives Recovery, Offline-Leases, Schlüsselrotation, verteilte Serverinstanzen, Wallets oder Fahrzeuge. Die SQLite-Transaktion deckt die künstliche Leseoperation ab; ein externer Aktuator oder Geldfluss braucht einen eigenen atomaren Ausführungs- bzw. Wiederaufnahmevertrag.

Im Verlauf wurden folgende konkrete Probleme behoben:

- Ein unbestätigter TypeScript-Pin war nicht verfügbar. Die Registry bestätigte 7.0.2; diese Version ist installiert und gelockt.
- Gemeinsames Target-Verzeichnis und globale Dependency-Optimierung belasteten den ersten Kaltlauf. Der Spike verwendet jetzt ein lokales Target, vier Build-Jobs und ein eigenes unoptimiertes Entwicklungsprofil. Globale Einstellungen und fremde Prozesse wurden nicht verändert.
- SQLite nimmt den verwendeten `u64`-Zeitwert nicht direkt an. Der Aufruf verwendet jetzt eine geprüfte Konvertierung zu `i64`.
- Der Browser erhielt ein ES-Modul als klassisches Skript. `type="module"` und ein expliziter Initialisierungscheck beheben die Ursache.
- Der erste Timeout-Guard beendete eine getrennte Prozessgruppe nicht vollständig. Eine eigene Probe reproduzierte den überlebenden Kindprozess. Der Guard beendet nun den ermittelten eigenen Prozessbaum; der E2E-Server bleibt zusätzlich in der Job-Gruppe. Die gleiche Probe prüft die Korrektur.
- Der breite Gitleaks-Aufruf erfasste neun PEM-Marker in erzeugten `.rmeta`-Dateien von Crypto-Abhängigkeiten. Die Quelldateien wurden getrennt geprüft. Der breite rote Scan ist im Ledger erhalten und wird nicht als bestandener Quellscan dargestellt. Die Metadaten entstanden vor den später generierten Simulationsschlüsseln; die Bibliotheksquellen enthalten die entsprechenden öffentlichen Dokumentations-/Testbeispiele.

`cargo audit` verwendete die vorhandene RustSec-Datenbank ohne Fetch und ohne den separaten Check zurückgezogener Registry-Versionen. Die Abnahme ist auf diesen Datenstand begrenzt. OSV und bun audit meldeten keine bekannte Schwachstelle. Die automatischen Checks und der dokumentierte Quellreview ersetzen keine unabhängige Sicherheitsprüfung.

## Aktualisierte Gesamtschätzung

Die Adapterfrage ist jetzt durch einen ausgeführten Browser-/Rust-Nachweis beantwortet. Eine erste Oberfläche und mehrere Persistenz-/Widerrufsfälle liegen bereits vor. Deshalb sinkt die verbleibende Pilotspanne etwas; ein pauschaler AI-Beschleunigungsfaktor wird nicht angesetzt.

| Stufe | Vor dem Spike | Nach dem Spike |
|---|---|---|
| Passkey-/Verifier-Spike | Budget 4–8 Arbeitsstunden | Simulierte Integration und Abnahme ausgeführt; Laufzeit im [Ledger](evidence/spike-metrics.json) |
| Hardwaregestützte Demo | 3–5 Personentage | Noch etwa 2–4 Personentage für Live-Geräte, kontrollierten HTTPS-Origin und Fehlerpfade |
| Belastbarer Softwarepilot | 23–43 Personentage | **Verbleibend etwa 20–37 Personentage**, inklusive Reserve; rund 4–8 Arbeitswochen bei fünf Projekttagen pro Woche |
| Produktionsfähiges Webprodukt mit SDK, Recovery und Betrieb | 3–5 Monate | **3–5 Monate** als grobe Planungsspanne; im Spike nicht abgenommen |
| Mobile Apps, ein Offline-Gerät und eine Wallet-Chain | 6–12 Monate mit 2–3 erfahrenen Entwicklern | **6–12 Monate**; diese Erweiterungen wurden nicht geprüft |
| Universeller Anbieterstandard | Kein seriöser Endtermin | Unverändert abhängig von Anbieterbeteiligung und Konformität |

Personentage sind acht Arbeitsstunden eines verantwortlichen Entwicklers. Die Stufen sind verschachtelt und werden nicht addiert. Die Pilotspanne umfasst die verbleibenden Arbeiten; die Monate für das Produkt bleiben eine Gesamtgrößenordnung. AI-Unterstützung ist in der Arbeitsweise berücksichtigt, aber nicht als gemessene Personalersparnis verrechnet.

Verbleibende Pilotbasis:

| Aufgabe | Personentage |
|---|---:|
| Verbindliches Profil und Authority-Vertrag | 2–3 |
| Reale Geräte, Origin und Browsermatrix | 2–4 |
| Produktions-Bootstrap, Geräte-/Mandantenmodell, dauerhafter Zustand | 5–8 |
| Anbindung des konkreten Softwaretools und UI-Abnahme | 2–3 |
| Recovery, Ausfälle und unabhängige Interoperabilitätsvektoren | 2–5 |
| Review, Lieferkette und Übergabe | 3–5 |
| Basis | 16–28 |
| Mit 20–30 % Planungsreserve, gerundet | 20–37 |

Der Live-Gerätetest ist die nächste Entscheidung. Besteht er, wird das benannte eigene Softwaretool angebunden. Erst dessen Ausführungs- und Recovery-Abnahme erlaubt eine engere Produktionsschätzung.

## Werkzeuge, Skills und Wiederaufnahme

Metacode wurde zur Kandidatensuche und Schema-Prüfung verwendet. Für WebAuthn/Axum enthielt der lokale Katalog keine direkten Treffer; Originaldokumentation und die gelockten Registry-Pakete schließen diese Lücke. Es wurde ein Backend gebaut, kein zusätzlicher TypeScript-Auth-Dienst. Der Efficiency Orchestrator hielt Ziel, Scope, Kostenklasse, Fehler, Zeitlimit und Abnahme getrennt.

Die zehn ausgewählten Skills sind mit Quellpfaden und Hashes in [skills.json](evidence/skills.json) dokumentiert: metacode, agent-efficiency-orchestrator, best-defaults, ponytail, speedtuning, security-review, rust-patterns, rust-testing, coding-standards und verification-loop. Hallmark wurde für die kleine Testoberfläche zusätzlich verwendet.

Das Acht-Stunden-Limit und die ausgeführten Befehle stehen unter docs/evidence/. Fehlläufe und abgebrochene Kaltläufe sind enthalten. Providerverbrauch, aktiver menschlicher Aufwand und Abrechnung wurden nicht erhoben; es wird keine Token- oder Geldersparnis behauptet. Alle simulierten Browser- und Serverprozesse wurden beendet.

Für einen später ausdrücklich gestarteten Live-Test zeigt [README.md](../README.md) den Start mit `just dev`. Diese separate manuelle Sitzung ist auf zwei Stunden begrenzt und wird nicht automatisch gestartet.
