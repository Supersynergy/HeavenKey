# Geschützte Aufträge

Ein eigener geschützter Agent kann einen Antwortentwurf mit Platzhaltern vorbereiten und eine gebundene Anmeldung anfragen. Person, E-Mail und Vorgang bleiben im verschlüsselten Tresor. Dieser Zugang darf keine Website-Inhalte lesen. Ab 0.19 kannst du den lokal aufgelösten Entwurf nach einer eigenen Prüfung einmal an einen vorher festgelegten Website-Endpunkt senden.

## Einrichten

1. Entsperre HeavenKey und lege einen klassischen Website-Login an.
2. Öffne Einstellungen → Geschützte Entwürfe → Geschützten Agenten koppeln. Verwende für Shell-Agenten ausschließlich den eingeschlossenen Startweg aus [AGENT-SANDBOX.md](AGENT-SANDBOX.md). Der einmalige Code gilt zwei Minuten. Die Bezeichnung eines Agenten ist kein Identitätsnachweis.
3. Wähle Geschützten Auftrag erstellen, den geschützten Agenten und den Login. Wähle auf Wunsch ein vorhandenes lokales Formularprofil für Name und E-Mail; den Vorgang ergänzt du selbst. Die App speichert diese Zuordnung zuerst verschlüsselt und veröffentlicht anschließend nur zufällige Referenzen für höchstens fünf Minuten. Für eine spätere Zustellung kannst du einen absoluten Pfad wie `/inbox` festlegen. Das ist ein Website-Endpunkt mit POST-Unterstützung, keine E-Mail-Adresse.
4. Der Agent fragt die Anmeldung an. Prüfe Website und fest gebundenen Login und bestätige ausdrücklich. Ein getrenntes temporäres Browserprofil meldet sich an. Der Agent erfährt ausschließlich, ob du die Anfrage freigegeben hast, ohne Sitzungsreferenz oder Website-Ergebnis. Nur deine Ansicht zeigt den tatsächlichen Anmeldezustand.
5. Der Agent schreibt den Entwurf mit den erhaltenen Platzhaltern. Lokal im Klartext ansehen ersetzt sie ausschließlich in dieser App. Entwurf verschlüsselt speichern erhält ihn im Tresor und beendet bestehende Live-Freigaben.
6. Für den Versand muss die Anmeldung erfolgreich und der veröffentlichte Empfängerpfad vorhanden sein. Öffne die Vorschau, prüfe Website, Pfad und vollständigen Text und klicke auf Senden. Die Besitzeroberfläche übergibt ausschließlich eine an Auftrag, Epoche, Revision und Entwurf gebundene verschlüsselte Hülle. Der private Browser sendet einmal `text/plain; charset=utf-8` an diese Website mit seiner bestehenden Sitzung. Er folgt keiner Weiterleitung und liest keinen Antwortinhalt. Danach wird das Browserprofil geschlossen. Der Agent erfährt weder Versandstatus noch Antwort. Eine Annahme durch den Endpunkt beweist kein Lesen durch einen Menschen.

Ein unsicheres oder fehlgeschlagenes Versandresultat wird nicht automatisch wiederholt. Prüfe beim Empfänger, bevor du einen neuen Auftrag anlegst: Ein bereits abgeschickter POST lässt sich durch Sperren oder Widerruf nicht zurückholen.

Ein Login mit gespeicherten geschützten Aufträgen lässt sich erst löschen, nachdem du diese Aufträge in den Einstellungen entfernt hast. So bleiben ihre verschlüsselten Zuordnungen nicht ohne gültigen Login zurück.

Beim Sperren, nach 35 Sekunden ohne Besitzer-Heartbeat, bei Tresoränderungen, Widerruf und Neustart enden die Live-Rechte. Gespeicherte Zuordnungen werden nach dem Entsperren nicht erneut veröffentlicht. Als neuen Auftrag vorbereiten erzeugt neue Referenzen und braucht eine neue Freigabe.

## Agentenschnittstelle

Der direkte Client benötigt stdin und zeigt nur JSON-Antworten. Er isoliert keine zusätzliche Host-Shell. Nutze für diese den Containerstart; dessen Gast erhält weder Besitzer- noch Clienttoken.

| Direkter Befehl | Container-RPC | Felder zusätzlich zum direkten Clienttoken |
| --- | --- | --- |
| `protected-list` | `/protected/list` | keine |
| `protected-login` | `/protected/login` | `workspace_id` |
| `status` | `/status` | `request_id` |
| `protected-draft` | `/protected/draft` | `workspace_id`, `text` |
| `protected-close` | `/protected/close` | `workspace_id` |

Der Agent erhält einen festen deutschen Arbeitsauftrag mit Referenzen wie `[[HK:UUID]]`. Die drei Referenzarten sind `person`, `email` und `case`. Er muss die Platzhalter unverändert zurückgeben. Anmeldung und Entwurf sind jeweils einmalig. Entwürfe bleiben auf 8.000 UTF-8-Bytes begrenzt; HTML, URLs, Steuerzeichen, fremde und fehlerhafte Referenzen werden abgelehnt. Unbekannte Befehle und zusätzliche Felder öffnen keinen allgemeinen Browserkanal. Es gibt keine Entschlüsselungs-, Cookie-, Screenshot-, Download- oder Sendeoperation für diesen Zugang. Er kann sich auch keine gewöhnlichen Lese- oder Transferrechte geben.

## Trust-Marker und Grenzen

- Verschlüsselt gespeichert: Originale und gespeicherte Entwürfe gehören zur bestehenden verschlüsselten Tresorhülle. Der Server speichert keine zweite Klartext-Zuordnung.
- Nur Referenzen freigegeben: Der geschützte Auftrag enthält keine Originalwerte, keine Kontobezeichnungen und keine Zieladresse. Die Besitzeransicht behält diese Angaben.
- Anmeldung einzeln bestätigt: Ausgewählter Login, Website, Agent, Entsperr-Epoche und Tresorrevision sind gebunden. Die Zielwebsite erhält die für ihre Anmeldung benötigten Zugangsdaten.
- Keine Seitenansicht: Selbst reflektierte Zugangsdaten in HTML, Bildern, Seitentiteln oder kodierten Antworten werden über diesen Kanal nicht als Inhalte zurückgegeben. Der Agent kann in diesem Modus keine beliebigen Website-Aufgaben erledigen.
- Shell nur eingeschlossen: Der Schutz setzt voraus, dass der Agent keinen zweiten uneingeschränkten Zugang zu Host, Besitzerbrowser, Zwischenablage, Docker oder Administratorrechten hat. Ein bereits außerhalb der Sandbox laufender Codex-Agent wird dadurch nicht nachträglich isoliert.
- Intern geprüft: Quellprüfung und ausführbare Tests ersetzen kein externes Kryptografie-Audit. Pakete sind unsigniert und nicht notarisiert.

Das Verfahren ist keine automatische Anonymisierung beliebiger Texte. Allgemeine Formulare, E-Mail-/Messenger-Zustellung und autonome Navigation sind nicht Teil dieser Vorlage. Der Empfänger muss den festgelegten Text-Endpunkt unterstützen; ein beliebiges Kontaktformular reicht dafür nicht. Auch ein bösartiger Agent kann eigene erfundene Angaben schreiben; die Vorlage kann deren Bedeutung nicht beweisen. Die lokale Besitzerprüfung bleibt erforderlich.

Für HTTPS werden sämtliche aufgelösten IP-Adressen vor dem Start geprüft. Private und gemischte Antworten werden abgelehnt; eine öffentliche Adresse wird für das private Browserprofil fest gebunden. HTTP bleibt auf exakt `localhost` begrenzt. Das schließt den geprüften DNS-Wechsel und Website-Ergebnisse als direkte Agentenantwort aus. Die Zielwebsite erhält weiterhin die Zugangsdaten und den ausdrücklich versendeten Text. Ein kompromittierter Host, Administratorrechte, gemeinsame CPU-/Netzwerkzeit und externe Kommunikationswege können weitere Nebenkanäle eröffnen. Darum bleibt der 24. Abnahmefall ein Restrisiko. JavaScript-Zeichenketten und Browser-/Betriebssystemspeicher erlauben keine garantierte forensische Löschung. [Abnahme und Plattformgrenzen](PASSWORD-MANAGER-VERIFICATION.md).
