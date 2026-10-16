# Finaler unabhängiger Review

V4 ist freigegeben: keine konkreten P1/P2-Blocker im geprüften Umfang. Die folgenden datierten Prüfstände erhalten die Befundhistorie.

# Unabhängiger Review

## Erstprüfung, Manifest v1

**Ein P2-Blocker vor Veröffentlichung.** Basis: `origin/main` = `1aa9accabcbde3469e6ed4d3fe15c43ca5c04141`; Branch einschließlich uncommittierter Quellen geprüft.

Manifest-SHA-256: `419de78fedaeb170732989aa05982333994935706ef075091f55a3791c722674`. Zu Reviewbeginn stimmten alle 135 Dateihashes. Deklarierter Quelldigest: `366ac1a52b6eca895798da774ce22a67a73cbb946d8984e57ae2bf7c82df10eb`.

## P2: Widerrufsexport verwirft die tatsächlichen API-IDs

[scripts/revocation_snapshot.py:57](../../scripts/revocation_snapshot.py:57) akzeptiert ausschließlich 64-stellige Hex-IDs. Die API speichert Delegations-IDs als Base64url ([main.rs:724](../../apps/api/src/main.rs:724)). Damit bricht der Export nach dem ersten Widerruf ab; ein vorhandener leerer Snapshot bleibt bestehen und das Gate kann widerrufene Ketten weiter akzeptieren.

Reproduziert über den frisch gebauten API-Prozess und seinen verschlüsselten Store mit synthetischer widerrufener Delegation: Exit 1, `delegations.id is not a 64-hex grant id`; vorheriger Snapshot unverändert. Canonical Base64url-IDs vor dem Export nach Hex konvertieren und den echten API→Store→Exporter→Gate-Pfad prüfen. Vorhandene Exportertests benutzen ausschließlich Hex-/Blob-IDs und übersehen den Fehler.

## Ausgeführte Prüfung und Grenzen

`cargo test --locked --offline -p uac-api -p uac-keystore -p uac-gate`: 54 Tests bestanden. Frischer API-Build und neun Workstream-Integrationstests bestanden. Geprüft: SQLCipher-Migration, Meta-/Legacy-/Envelope-Abgleich, RP-Pinning, Host/Origin, Recovery, Agentrechte, Proxy und Headless-Konfiguration. Keine weiteren konkreten P1/P2-Befunde in diesen Pfaden.

Gate-Halteridentität und Snapshot-Aktualität bleiben laut Vertrag externe Vertrauensannahmen. Hardware, öffentliches Deployment und parallele Migration nicht ausgeführt. Abschlussprüfung: `scripts/test_revocation_snapshot.py` wurde während des Reviews fremd geändert; alle übrigen Manifestdateien stimmen weiterhin. Neue Tests/Fixes erneut binden und prüfen.

## Nachprüfung, Manifest v2

Manifest-SHA-256: `33bd8bae71b45e01e4f19d547ae17db185a0be96e0129313d40985d580c8bf38`; Quelldigest: `553917aadbf9ce44e71e06bd2acbd12f53234ba349e2edd23e4abac6342c93fe`. Alle 135 Dateihashes bestätigt.

**Ursprünglicher P2 behoben; ein weiterer P2 verbleibt.** Canonical Base64url-Konvertierung und lokaler Wartungszweig sind korrekt. 37 API-Tests, 19 Python-Tests einschließlich zehn Laufzeitfällen sowie alle 14 Protokollszenarien bestanden. Protokollprüfung separat mit temporärem Evidenzverzeichnis ausgeführt: API-Delegation am laufenden Gate akzeptiert, anschließend nach exportiertem Widerruf ohne Neustart HTTP 403.

### P2: Exporter überschreitet die Byte-Grenze des Gates

[revocation_snapshot.py:96](../../scripts/revocation_snapshot.py:96) schreibt bis zu 16.384 Einträge mit Einrückung. Das erzeugt 1.146.944 Bytes und ersetzt einen vorhandenen Snapshot erfolgreich. [apps/gate/src/main.rs:196](../../apps/gate/src/main.rs:196) lehnt Dateien über 1.048.576 Bytes ab: Danach verweigert ein laufendes Gate sämtliche Zugriffe; Neustart scheitert ebenfalls.

Reproduziert mit 16.384 unterschiedlichen kanonischen API-IDs: Parser und Export erfolgreich, Gate-Start Exit 1 mit `revocation snapshot unreadable or invalid`. Byte- und Eintragsbudget gemeinsam abstimmen und einen Export→Gate-Grenztest ergänzen. Kompakte JSON-Ausgabe allein genügt bei 16.384 Einträgen ebenfalls nicht. Übrige Abnahmegrenzen aus v1 gelten weiterhin. Abschlussprüfung: nur `scripts/firefox_e2e.py` wurde zwischenzeitlich fremd geändert; neue Fassung erneut binden.

## Abschließende Bindung, Manifest v3

Manifest-SHA-256: `5ca95b639a926f883779023535294705725c65eb9e6403cd1677c282299711e4`; Quelldigest: `33857ca0e3c07216b3ddba548c7f3b6fa62d4aff80eb335ca0a397b559239421`. Alle 135 Dateihashes stimmen. Einziger Unterschied zu v2: `scripts/firefox_e2e.py`; die begrenzte Cleanup-Ausnahmebehandlung mit stderr-Ausgabe wurde geprüft, Python-Syntax ist gültig. Daraus ergibt sich kein weiterer Befund.

**Endurteil v3: ursprünglicher Base64url-P2 behoben; der oben reproduzierte P2 zur Snapshot-Byte-Grenze bleibt offen.** Exporter und Gate sind gegenüber v2 unverändert; die ausgeführten 37 API-, 19 Python- und 14 Protokolltests gelten für diese unveränderten Pfade. Keine Veröffentlichungsfreigabe ohne Behebung oder explizite Annahme dieses verbleibenden Befunds.

## Endurteil, Manifest v4

Manifest-SHA-256: `229f8c98569b3ec33f6108b43f6647a6e30d53ebb43ade2817889edd5a6078b7`; Quelldigest: `f94093cb36b2c801e362b1ed97a7907f958b5b66ea4599b0471bdc05d95c83a2`. Alle 135 Dateihashes zu Beginn und Abschluss bestätigt. Änderungen gegenüber v3 beschränken sich auf Gate, Exporter, dessen Tests, Firefox-Cleanup und die zugehörige Integrationsdokumentation.

**Beide P2-Befunde behoben. Keine konkreten P1/P2-Blocker im geprüften Integrationsumfang.** Gate und Exporter verwenden 16.384 Einträge und 2 MiB; der Exporter prüft beide Grenzen vor atomarer Ersetzung. Überkapazität erhält den vorherigen Snapshot. Die Dokumentation nennt dieselben Grenzen.

Ausgeführt: 16 Gate-Tests einschließlich voller Snapshot-Kapazität, 11 Exportertests und alle 14 Live-Protokollszenarien bestanden. Erneut bestätigt: API-ausgestellte Delegation erlaubt Zugriff am eigenständigen Gate; exportierter Widerruf sperrt ihn ohne Neustart. Die Evidenz dieses Prüflaufs entstand ausschließlich temporär.

Zusätzlich den tatsächlichen Firefox-Cleanup-Block mit einem synthetischen HTTP-Fehler ausgeführt: beide eigenen Prozesse beendet, Nachweis auf `pass: false` gesetzt und anschließend Fehler ausgelöst. Die Browseroberfläche wurde dabei nicht erneut ausgeführt. Hardware, externer Onlinebetrieb, Halterauthentifizierung des Offline-Gates und betrieblich aktuelle Snapshots bleiben die zuvor benannten Abnahmegrenzen.
