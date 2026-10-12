# HeavenKey entwickeln

## Projektaufbau

| Pfad | Inhalt |
| --- | --- |
| `apps/api/` | Rust-API mit Passkey-Verwaltung und SQLite-Zustand |
| `apps/web/` | TypeScript-Oberfläche und WebAuthn-Dialoge |
| `crates/verifier/` | Signierte Zugänge und Prüfung der Delegationsketten |
| `scripts/` | Build, Browsertests und CI |
| `docs/vectors/` | Testvektoren zum Delegationsformat |

Die Rust-Version ist festgelegt. Nutze `rust-toolchain.toml`. Bun benötigt Version **1.4.2**. Für die Hilfsskripte brauchst du Python 3 und `just`; die Browserprüfung verwendet Google Chrome. Der native macOS-Build benötigt die Xcode Command Line Tools. Installiere Anwendungsabhängigkeiten mit `bun install --frozen-lockfile --ignore-scripts` und `cargo fetch --locked`.

## Befehle

| Befehl | Ergebnis |
| --- | --- |
| `just build` | Weboberfläche bündeln und Rust-API bauen |
| `just dev` | Lokale Oberfläche auf `http://localhost:18240` starten |
| `just check` | Source- und Abhängigkeitschecks ausführen; anschließend bauen |
| `just e2e` | Vollständigen Ablauf mit virtuellen Passkeys in Chrome testen |
| `bun scripts/delegation-reference.mjs` | Delegationsformat gegen öffentliche Testvektoren prüfen |

`just dev` läuft höchstens zwei Stunden. Prüfungen laufen im Vordergrund mit Zeitlimit. Bei Zeitablauf, Strg+C oder SIGTERM beendet der Befehlswrapper auch eigene Kindprozesse in separaten Sitzungen. `just e2e` nutzt Port 18241; führe nur einen solchen Browserlauf gleichzeitig aus.

## Prüftools installieren

Für `just check` sind zusätzlich diese Versionen erforderlich:

```sh
cargo install --locked --version 0.9.146 cargo-nextest
cargo install --locked --version 0.20.2 cargo-deny
cargo install --locked --version 0.22.2 cargo-audit
```

Die Prüftools brauchen lokale Advisory-Datenbanken. Bei einer neuen Installation müssen diese erst online geladen werden, bevor `just check` seine Prüfungen ohne erneutes Laden der Rust-Datenbanken ausführen kann:

```sh
cargo deny --locked check
cargo audit --no-yanked
just check
just e2e
```

Lokale Checks verwenden anschließend die vorhandenen Rust-Advisory-Datenbanken. Aktualisiere sie regelmäßig mit den beiden Online-Befehlen. Bun prüft seine Abhängigkeiten online.

## Konfiguration

| Variable | Zweck | Standard |
| --- | --- | --- |
| `UAC_PORT` | Port der lokalen API | `18240` |
| `UAC_DATA` | Verzeichnis des lokalen Datenbestands | `data/` |
| `CHROME_PATH` | Ausführbare Chrome-Datei für Browsertests | Plattformpfad in `scripts/e2e.mjs` |

## Änderungen prüfen

Führe `just check` und `just e2e` aus. Sicherheitsrelevante Änderungen müssen auch die passenden Ablehnungsfälle erhalten: fremde Konten, veränderte Parameter, Replay, abgelaufene Rechte, Widerruf und Neustart.

Nutze ausschließlich synthetische Testdaten. Einrichtungscodes, Sitzungen, Signierschlüssel, echte Passkeys und lokale Datenbanken gehören nicht ins Repository. Protokolländerungen benötigen eine Versionsentscheidung und passende Testvektoren. Die [Aktionsfreigaben](STEPUP-CONTRACT.md) und das [Delegationsformat](DELEGATION-CONTRACT.md) definieren die Schnittstellen.

Der [CI-Ablauf](CI-REPAIR.md) führt Source-, Sicherheits- und Browserprüfungen aus. Der [Prüfstatus](VERIFICATION.md) trennt lokale Simulation, Ubuntu-CI und Hardwaretests.
