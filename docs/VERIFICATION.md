# Prüfstatus

HeavenKey 0.5 ist lokal auf macOS und Ubuntu 24.04 geprüft. Die virtuellen CTAP2-Passkeys nutzen WebAuthn im echten Chrome-Browser, dessen tatsächlich erzeugte Antworten anschließend durch die Rust-API geprüft werden.

| Bereich | Ergebnis |
| --- | --- |
| Rust | Jeweils 45 Tests auf macOS und Ubuntu bestanden |
| Browser | Jeweils 138 Fälle auf macOS und Ubuntu bestanden |
| Delegationsreferenz | 75 Prüfungen bestanden |
| CI-Regressionen | Acht Stufen-/Artefaktprüfungen; zusätzlich acht Schutzprüfungen des kostenlosen Runner-Starters auf macOS bestanden |
| Quellcode und Abhängigkeiten | Formatierung, TypeScript, Clippy, Lizenz-, Quellen- und Advisory-Prüfungen bestanden |
| GitHub-CI | Kostenloser Runner-Routing-Test bestanden; vollständiger Lauf erfolgt über `just github-ci` |
| Befehlsabbrüche | Je sechs Fälle auf macOS und Ubuntu bestanden; eigene Kindprozesse beendet, unabhängiger Kontrollprozess erhalten |
| Prozesslisten vor dem Start | Fehlendes, fehlerhaftes, leeres, unlesbares oder hängendes `ps` startet keinen Auftrag; fünf Fälle auf macOS und Ubuntu bestanden |
| Physische Passkeys | Noch nicht abgenommen |

## Geprüftes Verhalten

- Eigentümer-Einrichtung mit einmaligem Code und Registrierung von Gästen.
- Mehrere Passkeys, Schutz des letzten Schlüssels und gesperrte Schlüssel nach Neustart.
- Aktionsgebundene Zustimmung sowie erneuter Versuch nach Abbruch.
- Weitergabe mit engeren Rechten, Laufzeiten und Weitergabegrenzen.
- Widerruf von Vorfahren, offenen Aufrufen und noch nicht ausgeführten Weitergaben.
- Ablehnung falscher Origin, RP, Challenge, Signatur, User Verification und fremder Konten.
- Ablehnung von Replay, parallelen Duplikaten, abgelaufenen Rechten und manipulierten Parametern.

## Nachweise und Wiederholung

[Browserfälle](evidence/e2e.json) · [Abnahme 0.5](evidence/acceptance.json) · [Testvektoren](vectors/delegation-v1.json) · [Delegationsreview](DELEGATION-REVIEW.md) · [CI-Prüfung](evidence/ci-repair-local.json) · [Plattformprüfungen](evidence/platform-checks.json) · [Wrapper-Prüfungen](evidence/wrapper-checks.json)

Die [Entwicklungsanleitung](DEVELOPMENT.md) beschreibt `just check` und `just e2e`. Der [CI-Ablauf](CI-REPAIR.md) erzeugt ausschließlich frische Testartefakte. Der Ubuntu-Nachweis stammt aus einem lokalen amd64-Container mit Rosetta auf macOS. Die [GitHub-Läufe](https://github.com/Supersynergy/HeavenKey/actions/workflows/ci.yml) bleiben eine separate Abnahme.

Die [CI-Härtung](evidence/ci-hardening.json) wurde mit dem integrierten Prozesswrapper erneut auf macOS geprüft: `just check` und alle 138 Browserfälle bestanden. Das Browserlimit beträgt nun 300 Sekunden, das Chrome-Startlimit 60 Sekunden. Die neuen CI-Regressionen wurden zusätzlich unter Ubuntu 24.04 ausgeführt; der vollständige Ubuntu-Anwendungsnachweis stammt vom vorherigen Stand.

Nach der neuen Prozesslistenprüfung wurden `just check` und alle 138 Browserfälle auf macOS erneut ausgeführt. Der geänderte Wrapper wurde zusätzlich in einem Ubuntu-ARM64-Container geprüft. Der vollständige Ubuntu-amd64-Lauf stammt vom Stand davor; der Anwendungsquellcode ist unverändert. Die Wrapper-Prüfung umfasst je elf Schutzfälle und zwei Fehler-Reproduktionen. Sie bestätigt auch die verbleibende Grenze: Fällt `ps` erst beim Aufräumen aus, ist die vollständige Bereinigung abgetrennter Kinder nicht garantiert.

Die Referenz prüft das HeavenKey-Profil und seine Testvektoren. Vollständige Kompatibilität mit fremden JSON-/Ed25519-Implementierungen, externe Protokolle, Hardware, Recovery und verteilte Ausführung sind zusätzliche Prüfziele. Eine bestandene lokale Simulation ist keine Produktionsfreigabe.
