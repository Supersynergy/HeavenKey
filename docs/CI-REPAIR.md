# GitHub-CI

Der Workflow `.github/workflows/ci.yml` prüft Pushes auf `main`, Pull Requests und manuell gestartete Läufe auf Ubuntu 24.04. Ein Push auf einen PR-Branch startet einen PR-Lauf; ein zweiter Push-Lauf für denselben Branch entfällt. Neuere Commits brechen ältere Läufe desselben Refs ab.

## Prüfungen

Der Job installiert die festgelegten Rust- und Bun-Versionen und lädt Abhängigkeiten aus den Lockfiles ohne Bun-Installationsskripte. Rust, Bun, Python und Chrome geben ihre verwendeten Versionen im Laufprotokoll aus. Die Prüfungen stehen als getrennte GitHub-Schritte im Job:

| Schritt | Prüfungen | Zeitlimit |
| --- | --- | --- |
| Source | CI-Regressionen, Formatierung, TypeScript, Delegationsreferenz, Clippy, Rust-Tests, fehlendes API-Binary | 900 Sekunden |
| Sicherheit | Lizenz-/Quellenregeln, aktuelle Rust-Advisories und Bun-Audit | 180 Sekunden |
| Build | Web-Bundle und Rust-API | 300 Sekunden |
| Browser | Virtuelle CTAP2-Authentikatoren im echten Chrome | 300 Sekunden |

Ein Fehler beendet den Ablauf mit dem ursprünglichen Exitcode. Die nächste Stufe startet erst nach einer bestandenen Vorgängerstufe. Die CI-Regressionen prüfen Fehlerweitergabe, ungültige Stufen, Advisory-Aktualisierung und die Entfernung alter Testartefakte. Der gesamte GitHub-Job bleibt auf 25 Minuten begrenzt.

Chrome darf zum Start höchstens 60 Sekunden benötigen. Ein lokaler Nachtest bei einer Last von 265 erreichte 121 bestandene Fälle, bevor das bisherige Gesamtlimit von 180 Sekunden griff. Der Browserlauf erhält deshalb einschließlich Start und Aufräumen 300 Sekunden. Alle 138 Fälle und ihre Ablehnungsprüfungen bleiben erhalten.

`just check` verwendet dieselben Source-, Sicherheits- und Build-Kommandos. Dabei nutzt es vorhandene Rust-Advisory-Datenbanken. `just ci` führt den vollständigen Ablauf mit frischen Advisories und Browserprüfungen im Vordergrund aus; sein Gesamtlimit beträgt 1200 Sekunden. Vor dem äußeren Befehlswrapper entfernt es alte Artefakte, damit kein geöffnetes Laufprotokoll gelöscht wird.

cargo-deny 0.20.2 und cargo-audit 0.22.2 werden aus den offiziellen Linux-Archiven geladen. SHA256-Prüfungen sichern die verwendeten Dateien vor dem Auspacken. Die Advisory-Datenbanken werden in GitHub online initialisiert und aktualisiert.

## Cache

Die auf Commit-SHA festgelegte GitHub-Action `actions/cache` speichert Rust-Registry, Git-Abhängigkeiten und Build-Ausgaben. Der Schlüssel enthält Betriebssystem, Architektur, Toolchain, Lockfile, Cargo-Konfiguration und Rust-Quellstand. Bei geändertem Quellstand kann ein Cache derselben Toolchain und Abhängigkeiten als Ausgangspunkt dienen; Cargo prüft die Build-Fingerprints erneut.

Tests, Sicherheitsprüfungen und Browsertests laufen auch bei einem Cache-Treffer. Bun-Abhängigkeiten werden bei jedem Lauf aus dem eingefrorenen Lockfile installiert. Testartefakte und Advisory-Datenbanken gehören nicht zum Cache. Die Auswirkung auf GitHub-Laufzeiten ist noch nicht gemessen.

## Testartefakte

Vor den Prüfungen entfernt `scripts/ci.sh prepare` alte CI-Logs, Befehlsledger, Browserberichte, Startup-Probe-Berichte und Screenshots aus dem Checkout. Historische Abnahmeberichte bleiben erhalten. Dadurch kann ein früher Fehler keine zuvor gespeicherten grünen Browserergebnisse als neuen Nachweis hochladen.

Nach dem Lauf enthält `heavenkey-evidence` ausschließlich die frisch erzeugten CI-Logs, `commands.jsonl`, den Startup-Probe-Bericht und Browserartefakte. Der Ledger hält Befehle, Exitcodes, Laufzeiten und die Abbruchdiagnose fest. Bei Browserfehlern kommen `failure-diagnostic.json` und `failure-*.png` hinzu. Der Upload läuft auch bei einem vorherigen Prüffehler; Artefakte bleiben sieben Tage verfügbar. Ein Fehler vor den Browsertests erzeugt keinen neuen Browserbericht.

## Aktuelle Startblockade

Am 12. Oktober 2026 scheiterte [Lauf 38205830472](https://github.com/Supersynergy/HeavenKey/actions/runs/38205830472) für Commit `46fdb65a26cfceb4673203d776e254bcb8200549` vor dem ersten Schritt. Die GitHub-Annotation meldet fehlgeschlagene Kontozahlungen oder ein zu niedriges Ausgabenlimit. Sie unterscheidet die Ursache nicht. Für das Repository ist kein selbst gehosteter Runner registriert.

Prüfe [GitHub Billing](https://github.com/settings/billing) und gegebenenfalls die Organisationseinstellungen. Sobald die Sperre aufgehoben ist, starte den Workflow unter **Actions → HeavenKey CI → Run workflow** erneut. Weitere Hinweise stehen in [GitHubs Fehlerdiagnose](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#reviewing-billing-errors). Ein Workflow-Patch hebt eine Kontosperre nicht auf.

Der bisherige Ubuntu-Nachweis gilt für den vorherigen Stand: 45 Rust-Tests, 75 Referenzprüfungen und 138 Browserfälle. Die Browserprüfung benötigte 108,6 Sekunden bei einem Zeitlimit von 180 Sekunden. GitHub-Ausführung und physische Passkeys bleiben separate Prüfziele; siehe [Prüfstatus](VERIFICATION.md).

Der aktuelle integrierte Stand besteht lokal `just check` und `just e2e`: 45 Rust-Tests, 75 Referenzprüfungen, acht CI-Regressionen und 138 Browserfälle. Der letzte Browserlauf benötigte 201,8 Sekunden auf dem belasteten macOS-Rechner. [Aktuelle Nachweise mit Quellhashes](evidence/ci-hardening.json) halten Ergebnisse, Befehle, Abbrüche und die verbleibende GitHub-Sperre fest. Eine Laufzeitverbesserung durch den GitHub-Cache ist noch nicht nachgewiesen.
