# Changelog

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
