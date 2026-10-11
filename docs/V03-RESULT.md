# HeavenKey 0.3: Mehrere Passkeys und geprüfte Donoren

Das Titelbild ist quadratisch: **1254 × 1254 Pixel**. Schlüssel und Tor liegen auf der Mittelachse. Die README verwendet eine zentrierte Abbildung mit 560 Pixeln Breite; auf schmalen Ansichten bleibt ihr Seitenverhältnis 1:1. GitHubs GFM-Renderer behält das Bild und die Zentrierung. Eine lokale Browser-Vorschau prüft Desktop und 390 Pixel Breite. Sie ist keine eingeloggte GitHub-Webansicht.

## Umgesetzter Ausbau

Ein Konto kann bis zu acht aktive Passkeys besitzen. Die Oberfläche zeigt Namen und Status; Hinzufügen verlangt eine erneute Anmeldung. Ein Bestätigungsdialog nennt den zu widerrufenden Schlüssel. Der Server schützt den letzten aktiven Schlüssel und prüft die Grenzen bei konkurrierenden Vorgängen erneut.

Einschreibung bindet die genaue Sitzung und das Konto an den weiterhin aktiven autorisierenden Schlüssel. Ein Widerruf beendet alle Sitzungen und offenen Authentifizierungs-/Einschreibungsvorgänge des Kontos. Entfernte Schlüssel bleiben als gesperrte Datensätze erhalten. Eine idempotente SQLite-Migration übernimmt den alten Datenstand, ohne gesperrte Schlüssel beim Neustart wieder zu aktivieren.

Bestehende Grants bleiben dem Konto zugeordnet. Der erste Credential-Identifier dient im Vorschauprofil als stabiler Alias. Ein entfernter Schlüssel kann sich nicht mehr anmelden; ein anderer aktiver Schlüssel desselben Kontos darf vorhandene Grants weiter verwenden. Zum Entziehen des Zugangs wird der Grant widerrufen. Das ist kein interoperabler DID- oder Offline-Nachweis.

## Wiederverwendung

Der konkrete neue Code-Donor ist **@simplewebauthn/browser 14.0.0** unter MIT. Er ersetzt die handgeschriebene WebAuthn-Konvertierung; Rust bleibt der Verifier. Das Paket hat keine weiteren Paketabhängigkeiten. Version und SHA-512 sind gelockt, die veröffentlichte Tarball-Prüfsumme ist verifiziert und die MIT-Lizenz steht im erzeugten Browser-Bundle.

Enpass liefert Prinzipien für lokale Datenhoheit und für eine später optionale verschlüsselte Synchronisierung. KeePassXC liefert die Referenz für benannte Schlüssel und ausdrückliche Bestätigung. Es wurde kein Produktcode aus diesen Anwendungen kopiert. HeavenKey besitzt derzeit kein verschlüsseltes Vault und keine Zero-Knowledge-Synchronisierung. Die [Donor-Entscheidungen](DONORS.md) enthalten Originalquellen und Lizenzgrenzen. SQLCipher bleibt eine spätere Option mit gesondertem Schlüssel- und Recovery-Vertrag.

## Nachweise

| Prüfung | Ergebnis |
| --- | --- |
| just check | 29/29 Rust-Tests: 24 Verifier-Tests und 5 API-/Migrations-Tests; TypeScript, Clippy, Build und Abhängigkeitsprüfungen grün |
| just e2e | 69/69 Fälle; bisherige 41 sowie zweite Schlüssel, Sitzungs-/Zweckbindung, Cap, Widerruf, Neustart, Migration und responsive Ansichten |
| Portabler CI-Ablauf lokal | Exit 0 auf macOS; kein Ubuntu-Ausführungsnachweis |
| Unabhängiger Expertenreview | 12 Quell-/Manifest-/Lizenz-/Bundle-Hashes geprüft, 0 offene Blocker |
| Semgrep | 8 eigene Quelldateien, 0 Findings, 0 Fehler |
| Git-Historienscan | 0 Findings nach zwei exakt dokumentierten Prüfsummen-Ausnahmen |
| README-Bild | 560 × 560 auf Desktop; 276 × 276 bei 390 Pixeln Viewport; zentriert |

Die zwei ursprünglichen Gitleaks-Treffer waren die SHA-256-Prüfsummen des breiten Titelbilds in zwei historischen Acceptance-Dateien. Beide Werte wurden gegen die tatsächlichen PNG-Git-Blobs geprüft. Nur diese zwei unveränderlichen Fingerprints stehen in .gitleaksignore; Regeln werden nicht pauschal ausgeschaltet. Die Diagnose und der ursprüngliche rote Scan bleiben erhalten.

Der Nutzer hat drei Experten-Subagenten ausdrücklich autorisiert. Die getrennten Zuständigkeiten waren Rust-API, Browser/E2E und Donor-/Sicherheitsreview; Integration und Veröffentlichung lagen beim Controller. Kein Beschleunigungsfaktor wird daraus abgeleitet. Der letzte lokale CI-Ablauf brauchte unter gleichzeitiger Prüflast rund 121 Sekunden, während frühere gleiche Browser-Fälle in deutlich kürzeren Durchläufen bestanden. Diese Ausführung ist kein kontrollierter Geschwindigkeitsvergleich. Tokens, Abrechnung und aktiver menschlicher Aufwand sind unbekannt.

## Offene Grenzen

Alle Geräte sind virtuelle CTAP2-Authentikatoren; Hardware und Biometrie bleiben auf Nutzerwunsch für später. Ein abgebrochener Passkey-Dialog wurde im Quellcode geprüft, aber in den 69 Fällen nicht separat als Laufzeittest erfasst. Ein unabhängiger Quellreview ersetzt keinen externen Sicherheitsaudit.

Die GitHub-Ausführung war zuletzt vor dem ersten Schritt durch eine Zahlungs-/Ausgabenlimit-Bedingung des Accounts gesperrt. Linux und reale Geräte sind damit weiterhin nicht abgenommen. Der nächste fachliche Schritt ist das versionierte Delegationsprofil mit unabhängigen Testvektoren; Recovery, verschlüsselter Zustand und echte Geräte bleiben eigene Abnahmen.

Die verbleibende Pilotplanung bleibt **20–37 Personentage**. Der Zusatz reduziert einen konkreten Prototyp-Engpass; er belegt keine pauschale Verkürzung des Gesamtprojekts. Weitere Stufen und Größenordnungen stehen in [ROADMAP.md](ROADMAP.md).

Aktuelle maschinenlesbare Nachweise: [acceptance.json](evidence/acceptance.json), [e2e.json](evidence/e2e.json), [Review](evidence/v03-independent-review.json), [Donor-Provenienz](evidence/donors-v03.json), [Scan-Diagnose](evidence/v03-secret-scan-diagnosis.json).
