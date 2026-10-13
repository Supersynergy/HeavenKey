# Heaven im Browser ausprobieren

Die Browserdemo zeigt eine vollständige Zugangsfreigabe mit Beispieldaten. Du brauchst keinen Account, Passkey, Installer oder eine Konsole.

Im aktuellen Entwicklungsstand öffnest du `/demo/` in der laufenden HeavenKey-Anwendung. Für einen statischen Einstieg kann der Inhalt von `apps/demo` auf einem vorhandenen Webhost liegen. Die drei Dateien benötigen keine Build-Werkzeuge. Lokal lässt sich `apps/demo/index.html` direkt im Browser öffnen; JavaScript muss aktiviert sein. Eine öffentliche Bereitstellung wurde hier nicht vorausgesetzt. Die veröffentlichten 0.6-Pakete enthalten die Demo noch nicht.

## Ausprobieren

1. Wähle Anna oder Ben und eine Laufzeit. Klicke auf **Zugang teilen**.
2. Öffne die Projektübersicht in der Gastansicht. Der ausgewählte Gast kann sie lesen.
3. Klicke in deinem Bereich auf **Zugang widerrufen**. Der Inhalt verschwindet sofort.
4. Versuche erneut, das Dokument zu öffnen. Der Zugriff wird abgewiesen.

Wechselst du die Gastansicht zu einem anderen Empfänger, kann dieser die Freigabe nicht benutzen. Nach Ablauf der vereinbarten Zeit endet der Zugang ebenfalls.

Der Demostand bleibt beim Neuladen im Browser erhalten. Ein Widerruf wird auch in anderen Tabs derselben Browser-Origin sichtbar. **Neu beginnen** setzt Freigabe und Verlauf nach Bestätigung zurück. Erlaubt der Browser kein lokales Speichern, funktioniert die Demo für den aktuellen Tab und zeigt diese Grenze an.

Gemeinsame Änderungen verwenden die Web-Locks-API und lesen vor jeder Aktion den aktuellen Stand. Fehlt diese Browserfunktion, bleibt der Demostand auf den aktuellen Tab begrenzt. Eine belegte Sperre bricht nach drei Sekunden ab und erlaubt einen neuen Versuch.

## Was die Demo prüft

Die Rechte sind im Browser simuliert. Das Beispieldokument ist Bestandteil der statischen Seite und enthält keine vertraulichen Daten. Die Demo schützt keine echten Dokumente und legt keine echte Eigentümerrolle oder Passkeys an.

Die bestehende HeavenKey-Anwendung behält ihre serverseitigen WebAuthn-, Freigabe- und Widerrufsprüfungen. Ein echter HTTPS-Pilot mit Einladungen und geschütztem Ressourcenabruf bleibt ein eigenes Arbeitspaket.

## Entwicklerabnahme

`bun scripts/demo_e2e.mjs` prüft die Demo in isolierten Chrome-Kontexten. Ohne Umgebungsvariable startet der Test einen temporären statischen Loopback-Server und beendet ihn anschließend. `HEAVEN_DEMO_ORIGIN=http://localhost:PORT/demo/` prüft den Einstieg über einen bereits laufenden HeavenKey-Server. `HEAVEN_DEMO_EVIDENCE` legt einen eigenen Ergebnisordner fest.

Die Browserfälle umfassen Teilen, Lesen, sofortigen Widerruf, erneute Zugriffsverweigerung, Neuladen, Reset/Abbruch, Tastaturfokus, Gastwechsel, mehrere Tabs, Ablauf, ungültige Speicherdaten, blockiertes Speichern, schmale Ansichten und direkten Dateistart. Ablaufzeiten werden im Test mit einer kontrollierten Browseruhr geprüft. Das ist kein physischer Passkey-Nachweis.

`just check` und `just e2e` bleiben die integrierten Projektgates. Die neuen statischen Dateien sind im API-Binary eingebettet; Änderungen daran verlangen einen erneuten nativen Build. Es wurden keine zusätzlichen Abhängigkeiten eingeführt.
