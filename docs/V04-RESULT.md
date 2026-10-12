# HeavenKey 0.4: Zustimmung für die konkrete Änderung

Eine bestehende Sitzung allein darf keinen Passkey hinzufügen oder widerrufen und keinen Zugang ausstellen oder widerrufen. Der Server verlangt dafür einen frischen Passkey-Nachweis für genau diese Aktion. Der Nachweis gilt 60 Sekunden, gehört zur selben Sitzung und lässt sich einmal verwenden. Änderungen an Ziel, Label oder Gültigkeitsdauer machen ihn ungültig.

## Entscheidung und Wiederverwendung

Der wichtigste Aufwand ist Nacharbeit an Autorisierungsgrenzen. Der Ausgangstest auf Source-Commit `41f05eb` konnte mit einer gültigen Sitzung drei sensible Änderungen durchführen: einen Grant erstellen, einen zusätzlichen Schlüssel einschreiben und den ursprünglichen Schlüssel widerrufen. Alle drei Antworten waren 200. Die erwartete Ablehnung war 403. Der Test und sein absichtlich rotes Ergebnis bleiben in [stepup-baseline.json](evidence/stepup-baseline.json) erhalten.

Best Defaults priorisiert diese nachgewiesene Lücke vor einem größeren Delegationsprofil. Rust/Axum, webauthn-rs, SQLite und der vorhandene SimpleWebAuthn-Adapter decken den Ausbau ab. Neue Laufzeitabhängigkeiten, ein weiteres Backend und eigene Kryptografie sind dafür nicht nötig. Die zehn ausgewählten Entwicklungs-Skills bleiben im [Entwicklungsvertrag](DEVELOPMENT.md) dokumentiert; pro Arbeitsphase wird nur der passende Skill geladen.

Die Entscheidung entspricht den Anforderungen an [Passkey-Verwaltung](https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html) und [Transaktionsautorisierung](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html): frische Authentifizierung, serverseitige Prüfung und Bindung an die freizugebenden Daten. WebAuthn-Prüfungen bleiben bei der vorhandenen Bibliothek; der [WebAuthn-Vertrag](https://www.w3.org/TR/webauthn-3/) beschreibt die Prüfung von Challenge, Origin, RP und User Verification.

## Verhalten und Grenzen

Der Browser nennt die Aktion und das Ziel vor dem Passkey-Dialog. Der Server verbindet die Challenge mit der Aktion und der aktuellen Sitzung. Eine erfolgreiche Bestätigung erzeugt eine vorübergehende Approval-ID; sie erzeugt keine neue allgemeine Sitzung und führt noch keine Änderung aus. Erst die passende Mutation kann sie verbrauchen. Auch ein fehlgeschlagener Verwendungsversuch verbraucht eine angegebene Approval-ID.

Die 60 Sekunden werden mit einer monotonen Uhr gemessen. Höchstens 128 Bestätigungen liegen im Prozessspeicher. Neustart verwirft sie. Schlüsselwiderruf beendet die Sitzungen und offenen Vorgänge des betroffenen Kontos. Bestehende Grenzen bleiben erhalten: acht aktive Schlüssel, Schutz des letzten Schlüssels, eindeutige Credential-IDs, Owner-Rolle und dauerhaft gespeicherte Widerrufe.

Ein WebAuthn-Nachweis bindet die vom Browser signierte Challenge an serverseitige Aktionsdaten. Ein kompromittierter Browser kann dem Nutzer eine falsche Anzeige zeigen; dieser Ausbau liefert keine authentikatorseitige Anzeige oder Signatur der Transaktionsdaten. Aktionsbestätigung ersetzt keine Recovery, Mandantentrennung oder Prüfung realer Geräte.

## Abnahme

| Prüfung | Ausgeführtes Ergebnis |
| --- | --- |
| Vollständiger lokaler Prüfablauf | Exit 0: 36/36 Rust-Tests, davon 24 Verifier- und 12 API-Tests; Formatierung, TypeScript, Clippy, Build und Abhängigkeitsprüfungen grün |
| Browser-Abnahme | 96/96 Fälle; alle 69 bisherigen Fälle erhalten, 27 neue Fälle, kein entfernter Fall |
| Bearer-only API-Zugriff | Alle vier sensiblen Aktionen antworten ohne frische Freigabe mit 403 |
| Tatsächlicher Passkey-Abbruch | Native Browser-Abfrage abgebrochen; erneuter Versuch erfolgreich, ohne neue Anmeldung |
| Ablauf | Rust prüft abgelaufene monotone Freigaben; kein 60-Sekunden-Wartetest oder Runtime-Testclock |
| Unabhängiger Review | 17 Prüfungen, 14 Quell-/Manifest-/Bundle-Hashes verglichen, 0 offene Blocker |
| Source-Scans | Semgrep: 8 eigene Dateien, 0 Findings, 0 Fehler; gestagter Secret-Scan: 0 Findings |
| Code-Stilscan | 0 Fehler, 3 nichtblockierende Stilwarnungen zu Dateigröße und begrenztem Health-Polling |
| Frischer GitHub-Clone | Source-Commit `db31bae`, 22 integrierte Datei-Hashes gleich; gelockte Installation, leeres Build-Verzeichnis und 96/96 Browser-Fälle bestanden |
| Git-Historienscan | Exit 0, 0 Findings; nur die zwei bereits dokumentierten Prüfsummen-Ausnahmen |

Der Controller führte die vollständige `just _check`-Recipe über `scripts/run.py` und `ats-verify` aus. Dies ist der Prüfablauf hinter `just check`; die Wrapper-Grenze beträgt 900 Sekunden. Er brauchte hier rund 69 Sekunden. Der Browser-Lane führte `just e2e` aus: rund 36 Sekunden einschließlich Wrapper. Diese Einzelmessungen liefern keinen Vergleich der Entwicklungsgeschwindigkeit oder Abrechnung.

Der ursprüngliche rote Test ist ein Fehlernachweis für 0.3, keine bestandene Prüfung von 0.4. Die drei Stilwarnungen wurden geprüft; es wurde kein bestätigter Defekt gefunden. Ein Refactor nur zum Erhöhen eines Scanner-Scores gehört nicht zu dieser Sicherheitsänderung.

Der frische Clone hatte ein leeres Build-Verzeichnis und verwendete einen warmen Paket-Registry-Cache. Installation, Build und Simulation benötigten insgesamt rund 355 Sekunden; Build rund 258 und Browserlauf rund 66 Sekunden. Die gemessene Host-Last lag zwischenzeitlich über 90 bei 16 logischen CPUs. Fremde Arbeiten liefen weiter. Diese Abnahme ist daher ein Funktionsnachweis und kein kontrollierter Laufzeitvergleich. Das temporäre Clone-Verzeichnis wurde entfernt; Browser und Testserver sind beendet.

Aktuelle maschinenlesbare Nachweise: [acceptance.json](evidence/acceptance.json), [Browser-Matrix](evidence/e2e.json), [vollständige lokale Prüfung](evidence/stepup-check-full.log), [unabhängiger Review](evidence/stepup-independent-review.json), [frischer Clone](evidence/stepup-fresh-clone.json), [ursprünglicher Fehlernachweis](evidence/stepup-baseline.json).

Der [GitHub-CI-Job für 0.4](https://github.com/Supersynergy/HeavenKey/actions/runs/38186956142) wurde vor dem ersten Schritt durch eine Zahlungs-/Ausgabenlimit-Bedingung des Accounts abgewiesen. Die Annotation nennt beide Möglichkeiten und unterscheidet ihre Ursache nicht. Ubuntu ist damit weiterhin ungeprüft. Zahlungen, Limits und Runner wurden nicht geändert.

## Planung

Die verbleibende Pilotplanung bleibt vorläufig bei **20–37 Personentagen** beziehungsweise **4–8 Wochen** für einen Entwickler. Ein abgesichertes Webprodukt bleibt bei **3–5 Monaten**. Mobile Clients, ein kontrolliertes Offline-Gerät und ein Wallet-Adapter bleiben bei **6–12 Monaten mit 2–3 Entwicklern**, abhängig von Integrationszugang und realen Tests. Der Umfang von „perfekt integriert“ muss diese konkreten Zielsysteme benennen.

Diese Änderung beseitigt eine messbare Autorisierungslücke. Sie belegt keinen pauschalen Beschleunigungsfaktor für das Gesamtprojekt. Hardware bleibt auf Nutzerwunsch für einen späteren Live-Test. Die nächste Protokollphase folgt erst nach der Abnahme dieses Zustimmungsmechanismus.
