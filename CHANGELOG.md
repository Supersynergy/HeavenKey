# Changelog

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
