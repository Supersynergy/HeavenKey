# HeavenKey Roadmap

## Implementiert in der lokalen Vorschau

| Stand | Funktionsumfang |
| --- | --- |
| 0.1–0.5 | Passkey-Anmeldung, Bootstrap für Eigentümer, mehrere Schlüssel, genaue Aktionsbestätigung, begrenzte Weitergabe und vererbter Widerruf. |
| 0.6 | Desktop-Pakete und minimale Erweiterungen; die veröffentlichten Pakete entsprechen diesem älteren Stand. |
| 0.7 · Quellstand | Konto-Recovery, verschlüsselter Signierschlüssel mit separater Verwahrung, optionaler PRF-Tresor, Sitzungslesen, Agenten-Schlüsselbesitznachweis, lokaler CRM-Pilot, Bereichsauswahl in Erweiterungen und bebilderte Installation. |
| 0.7 · Integration | SQLCipher-Speicher und Migration, gemeinsame HTTPS-Origin/RP-ID, privates Dokument für Passkey-/Sitzungs-/Agentenlesen, Betriebs-Vorlagen, Offline-Gate, Widerruf-Snapshots und Mandantenbibliothek. |

Der aktuelle Nachweis steht in [0.7-Verifikation](V07-VERIFICATION.md). Physische Passkeys, echte Betriebssystem-Keystores und neue Browserläufe sind dort ausdrücklich separat ausgewiesen.

## Nächste Abnahmen und Integrationen

| Priorität | Nächster Schritt | Erfolgskriterium |
| --- | --- | --- |
| 1 | Chrome und Firefox auf geeigneter Testmaschine | Komplette Passkey-, Recovery- und Erweiterungsabläufe einschließlich Abbruch; Screenshots des realen Ablaufs. |
| 1 | Physische Geräte und native Keystores | macOS, Windows, Linux; gesperrter Keystore, Geräteverlust und Neustart tatsächlich prüfen. |
| 1 | Neue 0.7-Desktop-Pakete | Plattform-Builds, überprüfte Startdateien, Prüfsummen, anschließende Signierung/Notarisierung. |
| 2 | Dauerhafte Firefox-Verteilung | Mozilla-Signierung und Installation nach Browser-Neustart. |
| 2 | Dauerhafter HTTPS-Betrieb | Feste Domain, tatsächliches Hosting sowie Backup und Restore im Zielbetrieb abnehmen. Die gemeinsame Implementierung und lokale TLS-Prüfung sind enthalten. |
| 2 | Server-Backup und Restore | Verschlüsselte Datenbank, beide Schutzschlüssel und bestehende Identitäten nach Restore gemeinsam prüfen. |
| 2 | Reale Next-Office-Anbindung | Rechte am tatsächlichen Connector prüfen; echte Tenant-Zuordnung, Wiederholungen, Fehler und Widerruf testen. |
| 3 | Mandanten, externe Protokolle, Offline | Enthaltene Mandantenbibliothek und Offline-Gate an konkrete Produktcaller binden; keine interoperablen oder verteilten Garantien aus dem lokalen Pilot ableiten. |

Eine neue verbindliche Zeitplanung folgt aus den konkreten Plattform- und Integrationsabnahmen. Frühere Schätzungen sind keine Zusage für diesen erweiterten Umfang.
