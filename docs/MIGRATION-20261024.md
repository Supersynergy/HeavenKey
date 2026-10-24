# HeavenKey-Integration vom 24. Oktober 2026

Ausgangspunkt ist `cacc4530f1fca4b2e4cee0176c725f6dd3c10c4f` auf GitHub `main`,
Version 0.21.0. Die Bestandsaufnahme enthält 31 Remote-Referenzen; 28 waren bereits
Vorfahren dieses Standes. Die vollständigen Köpfe stehen in
[der maschinenlesbaren Inventur](evidence/mobile/migration-inventory.json).

| Noch getrennte Entwicklung | Integration |
|---|---|
| `48da25d`: bebilderte Installation 0.12.0 | Als versionsgebundene Anleitung übernommen. Aktuelle README und Paketübersicht bei Konflikten erhalten. |
| `01fb75f`: älterer Gate-/CLI-Zweig | Die fehlende `hkv`-CLI übernommen. Den inzwischen weiterentwickelten Gate-Server und dessen Snapshot-/Zugriffsgrenzen erhalten. Keine alte öffentliche `/api/issuer`-Route eingeführt. |
| `ff31ff3`: UCAN-Brücke | Bibliothek, Dokumentation und unabhängige JavaScript-Testvektoren übernommen. Der Export bleibt ausdrücklich ein UCAN-förmiges, dienstsigniertes Format; keine allgemeine UCAN-Interoperabilitätsbehauptung. |

Der ältere Checkout `work/uac-spike` enthält noch lokale Desktop-Arbeiten. Er wurde
nicht verändert. Seine native macOS-Oberfläche und Paketierung sind durch die
neuere, bereits in `main` integrierte Umsetzung ersetzt; ein Rückimport würde diese
zurücksetzen. Die vorhandenen Rescue- und Entwicklungsbranches bleiben erhalten.

Die CLI liest Eingaben jetzt vor dem Parsen begrenzt ein. Der neue Regressionstest
war mit der ursprünglichen Implementierung rot und nach der Korrektur grün. Für
Base64url verwendet sie die bereits im Workspace vorhandene Bibliothek.

Die Ausgangsprüfung fand die Sicherheitsmeldung
[GHSA-834v-8h66-3h79](https://github.com/advisories/GHSA-834v-8h66-3h79) in
`happy-dom` 21.0.3. Die Abhängigkeit ist mit Lockfile auf 21.0.4 aktualisiert;
`bun audit` meldete danach keine bekannten Schwachstellen in den geprüften
43 Paketen. Die Extension-Prüfung verwendet außerdem den zur installierten
Playwright-Version gehörenden Browserpfad statt eines alten persönlichen Pfads.

Die neue [Flutter-App](MOBILE.md) liegt neben Web, API, Desktop und Erweiterungen
in `apps/mobile`. Desktop-Tresore, echte Zugangsdaten und laufende Installationen
wurden nicht migriert. Die Entwicklung und die ausstehende Geräteabnahme haben
getrennte SIS-Aufgaben. GitHub-Veröffentlichung und Quellprüfungen ersetzen die
signierte Handy-Abnahme nicht.
