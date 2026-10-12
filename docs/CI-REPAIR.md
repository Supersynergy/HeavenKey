# GitHub-CI

Der Workflow `.github/workflows/ci.yml` prüft Pushes, Pull Requests und manuell gestartete Läufe auf Ubuntu 24.04.

## Prüfungen

Der Job installiert die festgelegten Rust- und Bun-Versionen, lädt Abhängigkeiten aus den Lockfiles und startet `scripts/ci.sh`. Der Ablauf prüft Formatierung, TypeScript, Delegationsreferenz, Clippy, Rust-Tests, Lizenz- und Abhängigkeitsregeln, Sicherheitsadvisories, Build und Browsertests.

cargo-deny 0.20.2 und cargo-audit 0.22.2 werden aus den offiziellen Linux-Archiven geladen. SHA256-Prüfungen sichern die verwendeten Dateien vor dem Auspacken. Die Advisory-Datenbanken werden online initialisiert und aktualisiert.

## Testartefakte

Vor den Prüfungen entfernt der Workflow alte Laufberichte und Screenshots aus dem Checkout. Dadurch kann ein früher Fehler keine zuvor gespeicherten grünen Browserergebnisse als neuen Nachweis hochladen.

Nach dem Lauf enthält `heavenkey-evidence` die frisch erzeugten CI-Logs, Browserberichte und Screenshots. Bei Browserfehlern kommen `failure-diagnostic.json` und `failure-*.png` hinzu. Artefakte bleiben sieben Tage verfügbar. Ein Fehler vor den Browsertests erzeugt keinen neuen Browserbericht.

## Aktuelle Startblockade

Die [GitHub-Läufe](https://github.com/Supersynergy/HeavenKey/actions/workflows/ci.yml) wurden vor Runner-Zuweisung und vor dem ersten Schritt abgewiesen. GitHub meldet eine Zahlungs- oder Budget-Bedingung des Accounts; die Annotation unterscheidet die Ursache nicht.

Prüfe [GitHub Billing](https://github.com/settings/billing). Sobald die Sperre aufgehoben ist, starte den Workflow unter **Actions → HeavenKey CI → Run workflow** erneut. Weitere Hinweise stehen in [GitHubs Fehlerdiagnose](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#reviewing-billing-errors).

`scripts/ci.sh` ist in einem lokalen Ubuntu-24.04-amd64-Container mit Rosetta bestanden: 45 Rust-Tests, 75 Referenzprüfungen und 138 Browserfälle. Der Browsertest benötigte 108,6 Sekunden bei unverändertem Zeitlimit von 180 Sekunden. Die GitHub-Ausführung und physische Passkeys bleiben offene Prüfziele; siehe [Prüfstatus](VERIFICATION.md).
