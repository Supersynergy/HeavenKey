# Prüfstatus

HeavenKey 0.5 ist lokal auf macOS geprüft. Die virtuellen CTAP2-Passkeys nutzen WebAuthn im echten Chrome-Browser, dessen tatsächlich erzeugte Antworten anschließend durch die Rust-API geprüft werden.

| Bereich | Ergebnis |
| --- | --- |
| Rust | 45 Tests bestanden |
| Browser | 138 Fälle bestanden |
| Delegationsreferenz | 75 Prüfungen bestanden |
| Quellcode und Abhängigkeiten | Formatierung, TypeScript, Clippy, Lizenz-, Quellen- und Advisory-Prüfungen bestanden |
| Ubuntu-CI | Noch nicht ausgeführt; GitHub blockiert den Jobstart wegen einer Zahlungs-/Budget-Bedingung |
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

[Browserfälle](evidence/e2e.json) · [Abnahme 0.5](evidence/acceptance.json) · [Testvektoren](vectors/delegation-v1.json) · [Delegationsreview](DELEGATION-REVIEW.md) · [CI-Prüfung](evidence/ci-repair-local.json)

Die [Entwicklungsanleitung](DEVELOPMENT.md) beschreibt `just check` und `just e2e`. Der [CI-Ablauf](CI-REPAIR.md) erzeugt ausschließlich frische Testartefakte. Der [GitHub-Lauf mit dem korrigierten Workflow](https://github.com/Supersynergy/HeavenKey/actions/runs/38194022734) wurde vor dem ersten Schritt abgewiesen.

Die Referenz prüft das HeavenKey-Profil und seine Testvektoren. Vollständige Kompatibilität mit fremden JSON-/Ed25519-Implementierungen, externe Protokolle, Hardware, Recovery und verteilte Ausführung sind zusätzliche Prüfziele. Eine bestandene lokale Simulation ist keine Produktionsfreigabe.
