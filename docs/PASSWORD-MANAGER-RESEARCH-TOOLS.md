# Werkzeugnutzung und Nachweisgrenzen

Datum: 16. Oktober 2026. Verantwortungsbereich ausschließlich dieser Berichtsordner. Recherche ohne Käufe, bezahlte API-Aufrufe, Installation von Produkten, echte Zugangsdaten, externe Nachrichten oder Veröffentlichung.

## Verwendete Werkzeuge

- `superweb search 'Enpass features offline passkeys WiFi sync' --top 3 --deadline-ms 12000 --timeout-ms 12000`: fünf Treffer in 1,22 Sekunden; Ergebnis in `raw/search-enpass.json`.
- `superweb fetch raw/urls.txt --max-tier 2 --concurrent 8 --timeout-ms 12000 --deadline-ms 60000 --mode auto`: 22 erste Hersteller-URLs in 5,57 Sekunden. Ergebnis: `raw/vendor-fetch.jsonl`.
- Derselbe Fetch für `raw/supplemental-urls.txt`: 30 gezielte offizielle URLs in 7,22 Sekunden. Ergebnis: `raw/supplemental-fetch.jsonl`.
- Derselbe Fetch für `raw/final-urls.txt`, mit fünf parallelen Abrufen und 40 Sekunden Gesamtgrenze: fünf URLs in 1,50 Sekunden. Ergebnis: `raw/final-fetch.jsonl`.
- Offizielle Seiten wurden zusätzlich mit dem Web-Suchwerkzeug gelesen. Rohresultate: `raw/web-initial.json`, `raw/web-2.json` bis `raw/web-6.json`. Nichtoffizielle Treffer in diesen Suchantworten wurden nicht als Funktionsbelege übernommen.
- `metacode find 'password manager' --limit 12 --json`, `metacode find vault --limit 10 --json`, `metacode find KeePass --limit 8 --json`, `metacode find Bitwarden --limit 8 --json`: kein passender Donor in der lokalen Registry. Gespeicherte JSON-Dateien enthalten leere Trefferlisten. Kein Donorcode wurde übernommen.
- `spd 'offline first cross platform Rust password manager passkeys autofill secure vault' --top 5`: lokaler Discovery-Pack in `raw/spd.txt`. Treffer waren überwiegend generisch oder sachfremd, etwa Terminalbibliotheken und State-Management. Für die Funktionsmatrix und Implementierung nicht verwendet. Lokale Recall-Snippets sind keine aktuelle Herstellerquelle.
- `build_report.py`: manuell bewertete Merkmale als JSON und Markdown serialisiert; zählt Produkte, validiert Belegreferenzen und Statuswerte. Python wurde für Datenstruktur, Ausgabeformat und Validierung verwendet.
- `slopcheck REPORT.md` und `slopcheck TOOL-USAGE.md`: Sprachprüfung vor Übergabe. Resultat in `validation.json` beziehungsweise separater Prüfausgabe.

## Fehlversuche und Fallbacks

Die ersten URLs für KeePassXC `/project/`, Proton `/pass/features`, Keeper `/features.html`, SafeInCloud `/en/features.html`, Passbolt `/features` und Psono `/features` lieferten 404 oder unzureichenden Inhalt. Die offiziellen Startseiten, aktuellen Featurepfade und Benutzeranleitungen wurden anschließend gezielt abgerufen. Der Rohbestand bewahrt auch die Fehlantworten.

Buttercup lieferte am Abrufstag nur eine Maintenance-Seite (503). Es ist deshalb kein Mitglied der 21 verglichenen Produkte; Google Password Manager wurde aufgenommen. Diese Erreichbarkeitsbeobachtung ist kein Urteil über Buttercups vollständigen Produkt- oder Wartungszustand.

1Password-Mitgliedschaft, LastPass-Hilfe, Zoho-Offlinehilfe und Padloc-Einstellungen waren im direkten Fetch dünn oder eine JavaScript-Shell. Soweit die Matrix dort eine Aussage trifft, basiert sie auf der offiziellen Seite im Suchindex und ist im Bericht als solche erkennbar. Ein HTTP-200-Status allein wurde nicht als Inhaltsnachweis behandelt. Kein Browser-Bypass oder Login war nötig.

Einmalige Read-only-Sichtung der HeavenKey-README liegt als `raw/heavenkey-readme-snapshot.md` bei. Sie ist eine Dokumentationsaufnahme der parallel bearbeiteten Arbeitskopie, kein Build-/Runtime-Nachweis. Die ursprüngliche Aufgabenbeschreibung nennt den Startstand; neue parallele Credential-Änderungen werden vom integrierenden Agenten separat geprüft.

## Interpretation

17 Merkmale × 21 Produkte ergeben 357 Zellen. `U` bleibt offen; es bedeutet weder nicht vorhanden noch schlechter. Bei `Y` ist nur die dokumentierte Existenz belegt, keine plattformübergreifende Gleichwertigkeit. `C` nennt Einschränkungen. `N` wird nur bei einem ausdrücklichen Ausschluss verwendet. Herstellerwerbung über absolute Sicherheit, unhackbare Passkeys oder Wettbewerbsüberlegenheit wurde nicht übernommen.

Ein serverloses lokales Dateimodell, ein optionaler lokaler Modus, eine Cloud-App mit Offlinecache, ein exportierter Offline-Snapshot und ein selbst gehosteter Server bleiben getrennt. Passwortexport beweist keinen Passkey-Transfer. Offline-Revocation kann schon kopierte Geheimnisse nicht nachträglich entfernen. Diese Grenzen prägen die vorgeschlagenen HeavenKey-Abnahmen.
