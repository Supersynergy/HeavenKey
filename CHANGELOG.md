# Changelog

## Unreleased

- Teilen, Öffnen und Widerrufen eines Beispieldokuments ohne Anmeldung oder Installation.
- Eigener Browser-Einstieg unter `/demo/` und direkt nutzbare statische Dateien; keine zusätzliche Laufzeitabhängigkeit.
- Gespeicherter Demostand, Ablaufzeiten, Gastwechsel, Widerruf über mehrere Tabs und bestätigter Reset.
- Simulierte Rechte sind sichtbar gekennzeichnet und getrennt von der echten WebAuthn-/Serverprüfung.
- Encrypted local storage: `uac.sqlite` is a SQLCipher database keyed by `UAC_STORE_KEY` or a `store.key` file outside the data directory; plaintext databases migrate automatically on first start and a wrong key refuses to release any data.
- The issuer signing key moved from `data/issuer.key` into the database meta table; conflicting custody fails closed.
- New `--store-query '{"sql":..,"params":[..]}'` maintenance command for local operators, and `scripts/revocation_snapshot.py` exporting the delegation revocation set as a `uac-gate` snapshot (`{"version":1,"generated_at":…,"revoked":[…]}`) via `--store-query`.

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
