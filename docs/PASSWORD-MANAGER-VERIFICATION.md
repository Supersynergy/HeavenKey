# Passwortmanager 0.8 · Abnahme und Grenzen

Stand: 16. Oktober 2026. Lokale Vorschau, ausschließlich mit synthetischen Zugangsdaten geprüft. Der vollständige Funktionsvergleich steht in [der Gap-Analyse](PASSWORD-MANAGER-GAPS.md). Ein allgemeiner Vorsprung gegenüber Enpass ist nicht nachgewiesen.

## Ausgeführte lokale Prüfungen

- `just check`: Rust-Formatierung, Clippy, TypeScript, 104 Rust-Tests, 42 Python-Unitchecks und 15 ausdrücklich gestartete HTTP-/Integrationstests; zwölf Bun-Tests einschließlich acht Kryptotests. Ein experimenteller UCAN-Platzhalter zählt nicht als Interoperabilitätsnachweis.
- 34 Chrome-Fälle gegen die echte Rust-API: Tresor anlegen, Login bearbeiten/suchen/löschen, Tags/Favoriten, TOTP, Generator, Sperre, falsches Passwort, verschlüsseltes Backup, Restore, CSV, Passwortwechsel und konkurrierende Tabs.
- 1.000 synthetische Logins: Import, Verschlüsseln, Sperren, erneutes Entschlüsseln, Backup/Restore und kalter Prozessneustart. Externe Webanfragen sind dabei blockiert; Loopback bleibt erreichbar. Der lokale Dienst muss für neue Speichervorgänge laufen.
- Beschädigter Ciphertext, ungültiges Base64url und ungültiges altes JSON: normales Entsperren scheitert; ein gültiges Backup lässt sich vom Sperrbildschirm einspielen. Falsches Backup-Passwort und manipulierte Sicherung verändern den gespeicherten Tresor nicht. Eine veraltete Revision überschreibt keine konkurrierende Änderung.
- Zwölf ergänzende Browser-Prüfgruppen gegen einen API-Testserver: verzögerte Kryptovorgänge nach Sperre/Seitenwechsel, BFCache, Fokus und Breiten von 320 bis 1440 Pixeln. Clipboard verwendet hier ausdrücklich Testdoubles; die Inaktivitätszeit wird kontrolliert vorgerückt. Das beweist keine zugesicherte Löschung physischer Speicherinhalte oder der Betriebssystem-Zwischenablage.
- `just e2e`: alle 138 bestehenden Chrome-/virtuellen-CTAP2-Fälle des Zugangslabors bestanden. Weitere 14 Protokollfälle einschließlich lokaler Recovery und Agenten-/Widerrufspfade laufen in `just check`.
- Abhängigkeits-, Lizenz- und Advisoryprüfungen ohne neu hinzugefügte Bibliotheksversionen. `aislop` wurde ausgeführt; die übernommenen Prozess-Cleanup-Handler behandeln bereits beendete Prozesse absichtlich mit `ProcessLookupError`. Ein als Geheimnis markierter String ist eine ausdrücklich synthetische Browser-Testfixture.

## Sicherheitsprüfung

Ein unabhängiger interner Reviewer prüfte Kryptografie, Origin-/Host-Grenzen, KDF-/Dateigrenzen, Sperr-Races, Importe, Revisionsschutz und Wiederherstellung. Der gefundene Wiederherstellungs-P2 wurde mit zwei Fehlervarianten reproduziert und behoben. Die abschließende Nachprüfung fand im geprüften Umfang keine konkreten P1/P2-Blocker. Sie wiederholte die beiden beschädigten Formate mit 1.000 Einträgen und Neustart selbst gegen Rust und Chrome.

Die ursprüngliche Reviewbindung umfasst 161 Quelldateien, ohne generierte Evidenz. Die Hashliste und das aktuelle Testergebnis werden als Release-Nachweis bereitgestellt. Spätere Dokumentations- und mechanische Testhelper-Anpassungen werden getrennt geprüft. Dies ist kein externes Kryptografie-Audit und keine Garantie allgemeiner Fehlerfreiheit.

## Plattformpakete

Alle fünf Pakete müssen dieselbe Quellfingerprint enthalten. Jedes Paket enthält Manifest, SHA256-Bezug, Bedienanleitung und Lizenz-/Quellhinweise. Ein veralteter oder während des Builds veränderter Quellstand wird beim Bauen beziehungsweise Verpacken abgewiesen. Der SQLCipher-Portabilitätspfad nutzt die vorbereitete statische OpenSSL-3.6.5-Bibliothek. Linux-Binärdateien sind statisch gelinkt; macOS benötigt nur Systembibliotheken.

| Paket | Ausführung und Aussagegrenze |
| --- | --- |
| macOS ARM64 | Nativ auf Apple Silicon: Start, eingebettete Assets, Speichern und Neustart; vollständige 34 Passwortmanager-Browserfälle gegen die Release-Binärdatei. |
| macOS x64 | Start, Assets, Speichern und Neustart unter Rosetta; kein physischer Intel-Mac. |
| Windows x64 | Start, Assets, Speichern, Neustart und alle 34 Passwortmanager-Browserfälle unter Wine; keine native Windows-/Hello-Abnahme. |
| Linux ARM64 | Linux-Container auf ARM64: Start ohne WAN, eingebettete Assets, Speichern und Neustart. |
| Linux x64 | Linux-Container mit QEMU: Start ohne WAN, Assets, Speichern und Neustart; keine physische x64-Linux-Maschine. |

Der veröffentlichte `ACCEPTANCE.json`-Nachweis bindet diese Ausführungen an die konkreten Binärhashes. `SHA256SUMS` bindet die Archive. Das Manifest im Paket nennt den vollständigen Git-Commit und den Build-Fingerprint. Die Browser-Erweiterungen bleiben Launcher ohne Seitenrechte und ohne Autofill. Firefox lädt das unsignierte Paket temporär.

## Offene Grenzen

Herausgebersignaturen, Apple-Notarisierung, physische Passkeys, native Biometrie, native Windows-/Intel-/x64-Linux-Geräte und mobile Credential-Provider sind nicht abgenommen. Browser-Autofill, Gerätesynchronisation, Website-Passkey-Verwaltung, Anhänge, Passwort-Health-Prüfung und Eintragsfreigaben an Agenten fehlen. Die Agenten des getrennten Zugangslabors erhalten keinen Zugriff auf diesen Passworttresor. Eine beschädigte SQLite-Dateistruktur selbst lässt sich nicht über die Weboberfläche reparieren; verwende dafür eine gültige Sicherung in einem neuen Datenordner.
