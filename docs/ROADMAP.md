# HeavenKey Roadmap

## Verfügbar in der lokalen Vorschau

| Version | Funktionen |
| --- | --- |
| 0.1 | Passkey-Anmeldung, signierte Zugänge, gebundene Aufrufe und Widerruf |
| 0.2 | Einmaliger Einrichtungscode für den Eigentümer |
| 0.3 | Benannte Passkeys pro Konto mit Schutz des letzten aktiven Schlüssels |
| 0.4 | Frische Passkey-Zustimmung für konkrete Änderungen, Abbruch und erneuter Versuch |
| 0.5 | Begrenzte Weitergabe, bis zu fünf Kettenglieder und Widerruf aller abhängigen Nachfolger |

Der aktuelle Stand ist lokal mit virtuellen Passkeys auf macOS und Ubuntu geprüft. Physische Passkeys und der gehostete GitHub-CI-Lauf sind noch offen; siehe [Prüfstatus](VERIFICATION.md).

## Nächste Funktionen

| Bereich | Geplanter Nutzen | Erforderliche Prüfung |
| --- | --- | --- |
| Physische Passkeys | Passkeys auf eigenen Geräten einsetzen | Prüfung auf echten Geräten einschließlich abgebrochener Anmeldung |
| Recovery | Zugang bei Verlust aller Passkeys wiederherstellen | Missbrauchsschutz und vollständiger Wiederherstellungsablauf |
| Geschützter Speicher | Lokale Daten und Signierschlüssel absichern | Geprüfte Schlüsselverwahrung und Datenmigration; ein falscher Schlüssel darf keine Daten freigeben |
| HTTPS und Betrieb | Außerhalb der lokalen Demo nutzbar werden | Geprüfte HTTPS-Konfiguration und Fehlerabläufe im Betrieb |
| Mandanten | Mehrere getrennte Organisationen verwalten | Keine Zugriffe zwischen Organisationen |
| Externe Integrationen | Berechtigungen in einem konkreten Softwaretool einsetzen | Autorisierung am tatsächlichen Ausführungspunkt |
| Protokollkompatibilität | Zugänge mit einer externen Implementierung prüfen | Erfolgreiche Prüfung mit einer zweiten Implementierung |
| Offline-Ziele | Ein kontrolliertes Gerät ohne dauernde Verbindung nutzen | Kontrollierter Umgang mit veralteten Widerrufen und Ablaufzeiten |

## Vorläufige Zeitplanung

| Umfang | Planungsspanne |
| --- | --- |
| Verbleibender Softwarepilot | 20–37 Personentage, etwa 4–8 Wochen mit einem Entwickler |
| Webprodukt für produktiven Betrieb | 3–5 Monate |
| Mobile Clients mit einem Offline-Ziel sowie einem Wallet-Adapter | 6–12 Monate mit 2–3 Entwicklern |

Die Umfänge sind verschachtelt und werden nicht addiert. Es sind Schätzungen; Die konkreten Zielsysteme und reale Gerätetests bestimmen den tatsächlichen Aufwand. Ohne den erforderlichen API-Zugang ist kein verbindlicher Integrationstermin möglich. Nach dem Hardwaretest und der ersten konkreten Anbindung lässt sich die Planung enger fassen.
