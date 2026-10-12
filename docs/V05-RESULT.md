# HeavenKey 0.5: begrenzte Weitergabe von Zugängen

Ein Empfänger kann einen Zugang an einen weiteren registrierten Gast weitergeben. Die Weitergabe darf keine Rechte ergänzen. Ihre Laufzeit und Weitergabegrenze bleiben innerhalb der Vorgabe des Elternzugangs. Sie verlangt eine frische Passkey-Zustimmung für genau diese Änderung. Ein Widerruf eines Vorfahren sperrt die davon abhängigen Zugänge, auch wenn deren eigene Signaturen weiterhin gültig sind.

## Gewähltes Profil

Das Profil `heavenkey-delegation-v1` verwendet den bestehenden Ed25519-Schlüssel des Dienstes als Signierer aller Kettenglieder. Der Dienst bestätigt nach erfolgreicher Passkey-Prüfung, welches Konto weitergeben durfte. Kontokennungen sind stabile Account-Aliase; sie sind keine öffentlichen Signierschlüssel oder DIDs. Die Kette ist auf fünf Glieder und vier Weitergaben begrenzt.

Das ist ein eigenes Profil. Rust und die unabhängig geschriebene Node/TypeScript-Referenz prüfen dieselben öffentlichen Testvektoren und tatsächlich erzeugte API-Signaturen. UCAN-Kompatibilität, unabhängige Signierer im Browser und allgemeine Offline-Nutzung gehören zu weiteren Abnahmen. Ein Offline-Verifier kann einen neuen entfernten Widerruf erst berücksichtigen, wenn er davon erfährt.

Die signierten Daten haben eine festgelegte Byte-Reihenfolge und eine eigene Versionsdomäne. JSON-Eigenschaftsreihenfolge oder Formatierung verändern den Identifier nicht. Ein unbekanntes Profil, zusätzliche Felder, unzulässige Größen und eine fehlerhafte Kette werden abgewiesen. Kryptografische Operationen bleiben bei ed25519-dalek; die Browser-Prüfung verwendet Standard-Krypto.

## Best Defaults und Metacode

Der größte vermeidbare Aufwand ist Nacharbeit an Autorisierung und Protokollgrenzen. Best Defaults wählt deshalb einen vollständigen Online-Ablauf vor zusätzlicher Schlüsselverwahrung und einem allgemeinen DID-/UCAN-Stack. Die bestehenden Legacy-Grants und die 0.4-Passkey-Verwaltung bleiben erhalten. Separate Tabellen und Versionsdomänen begrenzen die Migration.

Metacode wurde vor dem Ausbau nach Delegations- und Ed25519/WebAuthn-Bausteinen durchsucht. Der lokale Index hatte keinen passenden Delegations-Donor; die allgemeine Rust-Quelle wurde live geprüft. Ein Quellenindex ist kein Sicherheits- oder Lizenznachweis für ein Produkt. Der Ausbau nutzt bestehende Abhängigkeiten; keine neue Laufzeitabhängigkeit wird dafür benötigt. Originalquellen und die Entscheidung werden im unabhängigen Review verlinkt.

Die Implementierung verteilt sich auf zwei Experten-Lanes für Rust/API und Browser samt Referenzimplementierung. Ein dritter Experte prüft unabhängig die Sicherheitsgrenzen. Jeder Auftrag enthält Pfade, Grenzen und Abnahme. Der Controller integriert native Gates, Dokumentation und Veröffentlichung. Kein Beschleunigungsfaktor wird aus der Parallelisierung abgeleitet.

## Abnahme

| Prüfung | Ausgeführtes Ergebnis |
| --- | --- |
| Public `just check` | Exit 0; 45/45 Rust-Tests, TypeScript, Clippy, Formatierung, Build und Abhängigkeitsprüfungen grün |
| Public `just e2e` | 138/138 Fälle; sämtliche 96 bisherigen Fälle erhalten, 42 ergänzt, kein Fall entfernt |
| Unabhängige Referenz | 75 Prüfungen, 32 synthetische Grant-Vektoren, 35 Kettenfälle und sieben geprüfte JSON-Ablehnungen |
| Weitergabe und Nutzung | Drei- und fünfgliedrige Ketten durch tatsächliche Browser-/Passkey-/API-Aufrufe geprüft; API-Signaturen und Identifier unabhängig verifiziert |
| Widerruf eines Vorfahren | Nachfolger und offene Aufrufe abgewiesen; bereits bestätigte neue Weitergabe ebenfalls gesperrt; Zustand über Neustart erhalten |
| Unabhängiger Review | 19 Prüfungen, 24 Quellen-/Manifest-/Bundle-Hashes und acht Evidenz-Hashes abgeglichen; 0 offene Blocker |
| Semgrep | Zehn eigene Quelldateien, 0 Findings, 0 Fehler |
| Secret-Scans | Gestagter Stand und Git-Historie ohne Findings; nur die zwei dokumentierten historischen Bildprüfsummen-Ausnahmen |
| Frischer GitHub-Clone | Commit `4916bda`, 28 Datei-Hashes identisch; gelockte Installation, Referenzprüfung, leeres Build-Verzeichnis und 138/138 Browserfälle bestanden |

Der Controller führte beide öffentlichen Gates mit den 0.5-Manifesten aus. Der vollständige Check brauchte hier rund 19 Sekunden, der Browserlauf rund 27 Sekunden einschließlich Wrapper. Ein vorheriger Lauf der Browser-Lane bestand dieselben 138 Fälle. Die Referenz wurde mit Bun und separat mit Node ausgeführt, jeweils 75 Prüfungen grün. Der frische Clone benötigte insgesamt rund 31 Sekunden, davon rund 14 für den Build und 14 für die Simulation. Diese Einzelmessungen liefern keinen kontrollierten Geschwindigkeitsvergleich oder Abrechnungsnachweis.

Die Veröffentlichungsprüfung erkannte eine zunächst nicht mitcommittete Bun-Lockversion; sie wurde vor dem Clone-Test ergänzt. Ein falscher Vergleichs-Hash im ersten Testaufruf stoppte vor Installation oder Codeausführung. Der erfolgreiche zweite Aufruf liest den erwarteten Hash direkt aus Git. Beide Befunde werden als Verpackungs-/Prüfablauffehler dokumentiert; die geprüften Anwendungssourcen blieben unverändert. Temporäre Clone-Daten, Browser und Testserver sind bereinigt.

Der [GitHub-CI-Job für den geprüften Stand](https://github.com/Supersynergy/HeavenKey/actions/runs/38192503038) enthält keinen ausgeführten Schritt. GitHub meldet eine Zahlungs-/Ausgabenlimit-Bedingung und unterscheidet beide Ursachen nicht. Linux bleibt damit ungeprüft; Zahlungen, Limits und Runner wurden nicht geändert.

Maschinenlesbare Belege: [Abnahme](evidence/acceptance.json), [Browserfälle](evidence/e2e.json), [unabhängiger Review](evidence/v05-independent-review.json), [frischer Clone](evidence/v05-fresh-clone.json), [Primärquellen](evidence/v05-donor-research.json).

Tests verwenden virtuelle CTAP2-Geräte im echten Browser und den tatsächlichen Rust-Verifier. Es werden keine Hardware-Geräte, persönlichen Passkeys oder produktiven Zielsysteme verwendet. Die unabhängige Referenz prüft die eigenen Testbytes; sie ersetzt keinen Standard-Konformitätstest oder externen Penetrationstest.

Rust bleibt der maßgebliche Parser für das Profil. Die unabhängige Referenz beweist die angegebenen Vektoren, Signierbytes und API-Signaturen; sie belegt keine vollständige Gleichheit aller JSON-Zahlendarstellungen oder Ed25519-Verifikationsregeln in fremden Implementierungen. Auch die bestehenden Sitzungs- und Ceremony-Uhren werden dadurch nicht zu einer abgesicherten Offline-Zeitquelle.

## Verbleibende Arbeit

Die Pilotplanung bleibt vorläufig bei 20–37 Personentagen beziehungsweise 4–8 Wochen für einen Entwickler. Recovery, Mandanten, verschlüsselter Zustand, HTTPS-Betrieb, Schlüsselrotation und reale Geräte bleiben eigene Abnahmen. Die Webprodukt-Planung von 3–5 Monaten und das größere Mobile-/Offline-/Wallet-Ziel von 6–12 Monaten mit 2–3 Entwicklern sind weiterhin Schätzbereiche, keine zugesagten Integrationstermine.
