# HeavenKey entwickeln

## Projektaufbau

| Pfad | Inhalt |
| --- | --- |
| `apps/api/` | Rust-API mit Passkey-Verwaltung und SQLite-Zustand |
| `apps/web/` | TypeScript-Oberfläche und WebAuthn-Dialoge |
| `apps/extension/` | Erweiterung zum Öffnen des lokalen Dienstes, ohne Webseitenberechtigungen |
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
| `just ci` | Vollständige CI mit aktuellen Advisories und frischen Browserartefakten ausführen |
| `just github-ci` | Genau einen veröffentlichten Commit auf einem kostenlosen eigenen GitHub-Runner prüfen |
| `just e2e` | Vollständigen Ablauf mit virtuellen Passkeys in Chrome testen |
| `just portable TARGET` | Ein Desktop-Ziel mit eingebauter Oberfläche und statischem OpenSSL 3.6.5 bauen |
| `just package TARGET ...` | Verifizierte Builds samt Lizenzen und Erweiterungen archivieren |
| `bun scripts/delegation-reference.mjs` | Delegationsformat gegen öffentliche Testvektoren prüfen |

`just dev` läuft höchstens zwei Stunden. Prüfungen laufen im Vordergrund mit Zeitlimit. Bei Zeitablauf, Strg+C oder SIGTERM beendet der Befehlswrapper auch eigene Kindprozesse in separaten Sitzungen. Dafür benötigt er eine funktionierende Prozessliste über `ps`; unter Ubuntu stellt `procps` diesen Befehl bereit. Eine fehlende, fehlerhafte oder zu langsame Prozessliste vor dem Start beendet den Wrapper mit Code `125`, `cleanup_error=process_tree_preflight_failed` und `process_started=false`, ohne den Auftrag zu starten.

Fällt die Prozessliste erst beim Aufräumen aus, meldet der Wrapper `cleanup_error=process_tree_snapshot_failed`. Dann können abgetrennte Kindprozesse übrig bleiben. Prüfe in diesem Fall ausdrücklich die zum Auftrag gehörenden Prozesse. `just e2e` nutzt Port 18241; führe nur einen solchen Browserlauf gleichzeitig aus.

## Prüftools installieren

Für `just check` sind zusätzlich diese Versionen erforderlich:

```sh
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

`just check` und GitHub verwenden dieselbe Prüfliste in `scripts/ci.sh`. Rust-Tests laufen in beiden Umgebungen mit `cargo test --locked --offline`. `just ci` aktualisiert zusätzlich die Advisories, entfernt alte CI-Artefakte und führt die Browserprüfung aus. Die einzelnen CI-Stufen heißen `source`, `security`, `build` und `e2e`.

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

`just github-ci` benötigt Docker und ein für dieses private Repository authentifiziertes `gh` mit Adminrechten. Der Befehl erstellt eine lokale Runner-Umgebung, verarbeitet einen Job im Vordergrund und räumt die Registrierung auf. Die Grenzen, lokalen Nachweise und der Start nach einer Unterbrechung stehen im [CI-Ablauf](CI-REPAIR.md). Er installiert keinen Hintergrunddienst.
