# GitHub-CI ohne gehostete Runner

HeavenKey verwendet eigene einmalige Runner in lokalen Ubuntu-24.04-ARM64-Containern. Der [Routing-Test](https://github.com/Supersynergy/HeavenKey/actions/runs/38227057526) besteht auf GitHub, obwohl gehostete Jobs desselben privaten Repositories wegen einer Zahlungs-/Budget-Bedingung abgewiesen werden. GitHub dokumentiert [eigene Runner als kostenlos](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners). Die lokale Maschine trägt Rechenzeit und Speicherbedarf.

Der Workflow verwendet weder GitHub-Cache noch Artefakt-Uploads. Build-Caches und Testnachweise liegen lokal unter `.ci-runner/`. Zahlungsdaten, Ausgabenlimits und die private Repository-Sichtbarkeit werden nicht geändert.

## Ausführen

Nach Commit und Push startet `just github-ci` einen bereits wartenden Lauf für genau diesen Commit. Falls keiner wartet, startet der Befehl den Workflow für den veröffentlichten Branch. Der Runner läuft im Vordergrund und verarbeitet höchstens einen Job. Danach werden Container, Runner-Registrierung und die temporäre Konfiguration entfernt.

Das ist kein dauerhaft installierter Hintergrunddienst. Ein wartender Workflow braucht den lokalen Startbefehl und eine verfügbare Docker-Engine. Ein unterbrochener Lauf hinterlegt `.ci-runner/session.json`; die nächste Ausführung verweigert neue Arbeit, bis die dort genannte eigene Registrierung und der Container geprüft wurden.

## Grenzen und Zugriff

- Die Vorbereitung der lokalen Umgebung erhält 900 Sekunden. Der GitHub-Job erhält 25 Minuten; der lokale Runner wartet höchstens 30 Minuten auf ihn.
- Jeder Container erhält höchstens vier CPU-Kerne, 6 GiB RAM und 512 Prozesse.
- Der Runner verwendet Benutzer-ID 501 ohne Linux-Capabilities. Er erhält keinen Docker-Socket und kein persönliches Home-Verzeichnis.
- GitHub-Zugriff erfolgt im Job mit `contents: read`; Checkout-Zugangsdaten werden nicht gespeichert. Das Registrierungspayload bleibt in einer lokalen Datei mit Modus 0600 und wird entfernt.
- Die Runner-Labels enthalten den vollständigen freigegebenen Commit-SHA und die konkrete Lauf-ID. Fork-PRs sind ausgeschlossen; die CLI verweigert öffentliche Repositories, fehlende Adminrechte sowie uncommitteten oder unveröffentlichten Code. Bereits laufende Jobs werden erhalten.

## Werkzeuge

Die Basis ist eine auf SHA256 festgelegte Ubuntu-24.04-ARM64-Umgebung. Runner 2.338.0, Bun 1.4.2, cargo-deny 0.20.2 und cargo-audit 0.22.2 stammen aus offiziellen Release-Archiven. Vor der Verwendung werden alle vier SHA256-Digests geprüft. Der Browser stammt aus der im Bun-Lockfile festgelegten Playwright-Core-Version. Rust verwendet weiterhin `nightly-2026-10-11` mit rustfmt und Clippy.

Ein Image-Schlüssel bindet Basis, Vorbereitungsskripte und Bun-Manifeste. Rustup, Cargo und Build-Ausgaben werden ausschließlich im lokalen Repository-Cache aufbewahrt. Jeder Lauf führt alle Prüfungen erneut aus.

## Prüfliste

| Schritt | Inhalt | Grenze |
| --- | --- | --- |
| Source | 16 CI-/Runner-Regressionen, Formatierung, TypeScript, Delegationsreferenz, Clippy, Rust-Tests und Startup-Probe | 900 Sekunden |
| Sicherheit | Lizenz-/Quellenregeln, aktuelle Rust-Advisories und Bun-Audit | 180 Sekunden |
| Build | Web-Bundle und Rust-API | 300 Sekunden |
| Browser | Vollständiger Ablauf mit virtuellen CTAP2-Authentikatoren in Chromium | 300 Sekunden |

Chrome/Chromium erhält zum Start 60 Sekunden. Der gemessene macOS-Lauf benötigte 201,8 Sekunden; ein vorheriger Versuch war bei 121 bestandenen Fällen nach dem alten 180-Sekunden-Limit abgebrochen worden. Alle 138 Fälle und ihre Ablehnungsprüfungen bleiben enthalten.

`just check` verwendet dieselben Source-, Sicherheits- und Build-Kommandos mit vorhandenen Rust-Advisory-Datenbanken. `just ci` führt die lokale vollständige Prüfliste einschließlich aktueller Advisories und Browserfällen aus; seine Grenze beträgt 1200 Sekunden.

## Nachweise

Vor dem Lauf entfernt `scripts/ci.sh prepare` alte CI-Logs, Befehlsledger, Browserberichte und Screenshots. Historische Abnahmen bleiben erhalten. Der letzte Schritt kopiert ausschließlich die frischen Laufdateien nach `.ci-runner/evidence-<run-id>/` und erzeugt ein SHA256-Manifest.

Der Starter verlangt den tatsächlichen grünen GitHub-Abschluss. Zusätzlich prüft er Commit, Lauf-ID, Dateihashes, mindestens 45 bestandene Rust-Tests, 75 Referenzprüfungen und einen abgeschlossenen Browserbericht mit mindestens 138 bestandenen Fällen ohne Fehler. Fehlende, veränderte oder fremde Nachweise führen zum Fehler.

Die bisherige lokale Abnahme ist in [ci-hardening.json](evidence/ci-hardening.json) dokumentiert. Der vollständige kostenlose GitHub-Lauf ist ein eigener Nachweis; sein Ergebnis und seine Logs werden lokal unter `.ci-runner/` gespeichert. Physische Passkeys bleiben ein separates Prüfziel.
