# Changelog

## 0.2.0: Research preview

- HeavenKey als eigenständiges Projekt im GitHub-Account Supersynergy vorbereitet.
- Ein lokaler, zufälliger Einrichtungscode provisioniert den Eigentümer mit einer verifizierten Passkey-Einschreibung.
- Frühe Gäste, falsche Codes und konkurrierende Einschreibungen erhalten keine Eigentümerrolle.
- README mit generiertem Titelbild und dokumentierten Sicherheitsgrenzen ergänzt. Die Architektur ist als Diagramm enthalten; die Roadmap benennt die nächsten Abnahmen.
- CI-Ablauf und konfigurierbaren Chrome-Pfad ergänzt.
- Prüfungen bleiben zeitlich begrenzt; die abgelaufene Spike-Deadline verhindert spätere Entwicklung nicht mehr.

## 0.1.0: UAC simulation spike

- WebAuthn mit signierten Leserechten für eine künstliche Ressource.
- 35 Browser-Fälle und 24 Rust-Core-Tests bestanden.
- Widerruf und die Aufrufbindung wurden über einen Neustart geprüft. Replay wird abgewiesen. Die Hardware-Abnahme wurde auf Wunsch auf später verschoben.
