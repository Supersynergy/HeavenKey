# Passwortmanager 0.9 · Abnahme und Grenzen

Stand: 16. Oktober 2026. Diese lokale Vorschau übernimmt die Appgestaltung mit Navigation, Eintragsliste und Details in den echten verschlüsselten Passwortmanager. Die fünf Desktop-Pakete enthalten die Oberfläche. Browser-Erweiterungen bleiben Launcher ohne Autofill. Ein allgemeiner Vorsprung gegenüber Enpass ist nicht nachgewiesen.

## Prüfumfang

Die Release-Abnahme verwendet `just check` und `just e2e`. Der Check umfasst Rust, Python, TypeScript, Kryptografie, lokale HTTP-Grenzen, Import, Backup, Wiederherstellung, Passwortwechsel und Revisionskonflikte. Die bestehenden virtuellen WebAuthn-Prüfungen des getrennten Zugangslabors bleiben erhalten.

Die neuen Designfälle laufen im selben Browserablauf gegen die echte Rust-API: drei Bereiche, Auswahl, Suche mit Tastatur, Editor mit Fokus und Escape, Filter und Sortierung, Hell/Dunkel mit Neustart, responsive Liste/Details, Verwaltung und vollständige Bereinigung beim Sperren. Die bisherigen 1.000-Eintrags-, beschädigte-Tresor- und Backup-Roundtrips bleiben Teil der Abnahme. Ausschließlich synthetische Zugangsdaten verwenden.

Zwischenablagebereinigung, kontrolliert vorgerückte Inaktivitätszeit und verzögerte Browser-Kryptovorgänge werden zusätzlich mit ausdrücklich benannten Testdoubles geprüft. Solche Prüfungen beweisen keine physische Speicherlöschung oder zugesicherte Bereinigung der Betriebssystem-Zwischenablage.

Die tatsächlichen ausgeführten Fälle, Resultate und Binärhashes stehen in `ACCEPTANCE.json` beim Release. Alte Belege der [Version 0.8](V08-VERIFICATION.md) sind Ausgangsstand und kein Nachweis für 0.9. Die unabhängige interne Prüfung muss an den veröffentlichten Quellenstand gebunden sein; sie ersetzt kein externes Kryptografie-Audit.

## Paketbindung und Laufzeitumgebungen

Alle fünf Desktop-Pakete müssen denselben Quellfingerprint enthalten. Das Paketmanifest nennt Version, vollständigen Git-Commit und Binärhash. `SHA256SUMS` bindet Archive und Abnahmebericht. Ein veralteter Build wird beim Verpacken abgelehnt. Lizenztexte und erforderliche Drittanbieterquellen liegen bei.

| Paket | Vorgesehene Prüfumgebung und Aussagegrenze |
| --- | --- |
| macOS ARM64 | Natives Apple Silicon; Browserfälle gegen die aus dem Paket entnommene Binärdatei. |
| macOS x64 | Rosetta auf Apple Silicon; kein physischer Intel-Mac. |
| Windows x64 | Wine; keine native Windows-/Hello-Abnahme. |
| Linux ARM64 | ARM64-Linux-Container ohne WAN. |
| Linux x64 | QEMU im Linux-Container ohne WAN; kein physisches x64-Linux-Gerät. |

Für jedes Paket prüfen wir Start ohne Quelldateien und Betriebssystem-Schlüssel, eingebettete Assets, Speichern und kalten Neustart. Browsernachweise für ein Paket gelten nur für dessen konkreten Binärhash. GitHub-CI verwendet den vorhandenen kurzlebigen lokalen Linux-Runner; kostenpflichtige Runner werden nicht genutzt.

## Offene Grenzen

Die Pakete sind nicht vom Herausgeber signiert oder Apple-notarisiert. Physische Passkeys, native Biometrie, mobile Credential-Provider, Autofill, Gerätesynchronisation, verwaltete Website-Passkeys, Anhänge und Eintragsfreigaben fehlen. Die Agenten des getrennten Zugangslabors erhalten keinen Zugriff auf den Passworttresor. Ein lokal berechneter Passwort-Hinweis wäre kein Online-Datenleckcheck.

Eine beschädigte SQLite-Dateistruktur selbst lässt sich nicht über die Weboberfläche reparieren. Verwende dafür eine gültige Sicherung in einem neuen Datenordner. Verschlüsselte Datensätze mit beschädigtem altem JSON oder Ciphertext können dagegen nach vollständiger Prüfung einer gültigen Sicherung vom Sperrbildschirm ersetzt werden.
