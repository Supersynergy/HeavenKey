# Geschützte Aufträge

Ab 0.18 kann ein eigener geschützter Agent einen Antwortentwurf mit Platzhaltern vorbereiten und eine gebundene Anmeldung anfragen. Person, E-Mail und Vorgang bleiben im verschlüsselten Tresor. Dieser Zugang darf keine Website-Inhalte lesen. Die Klartextvorschau entsteht erst in deiner lokalen Besitzeransicht. Der Ablauf versendet keine Nachrichten.

## Einrichten

1. Entsperre HeavenKey und lege einen klassischen Website-Login an.
2. Öffne Einstellungen → Geschützte Entwürfe → Geschützten Agenten koppeln. Verwende für Shell-Agenten ausschließlich den eingeschlossenen Startweg aus [AGENT-SANDBOX.md](AGENT-SANDBOX.md). Der einmalige Code gilt zwei Minuten. Die Bezeichnung eines Agenten ist kein Identitätsnachweis.
3. Wähle Geschützten Auftrag erstellen, den geschützten Agenten und den Login. Trage Person, E-Mail und Vorgang ein. Die App speichert diese Zuordnung zuerst verschlüsselt und veröffentlicht anschließend nur zufällige Referenzen für höchstens fünf Minuten.
4. Der Agent fragt die Anmeldung an. Prüfe Website und fest gebundenen Login und bestätige ausdrücklich. Ein getrenntes temporäres Browserprofil meldet sich an. Der Agent erhält nur Status und eine Sitzungsreferenz.
5. Der Agent schreibt den Entwurf mit den erhaltenen Platzhaltern. Lokal im Klartext ansehen ersetzt sie ausschließlich in dieser App. Entwurf verschlüsselt speichern erhält ihn im Tresor und beendet bestehende Live-Freigaben.

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

Das Verfahren ist keine automatische Anonymisierung beliebiger Texte. Freitext, Dokumente, allgemeine Formulare, externe Nachrichtenzustellung und autonome Navigation sind nicht Teil dieser Vorlage. Auch ein bösartiger Agent kann eigene erfundene Angaben schreiben; die Vorlage kann deren Bedeutung nicht beweisen. Die lokale Besitzerprüfung bleibt erforderlich.

Eine bösartige Website oder ein kompromittierter Host kann Informationen über Timing, Erfolgszustände oder andere Nebenkanäle signalisieren. Darum ist der 24. Abnahmefall ausdrücklich ein verbleibendes Risiko und kein Beweis vollständiger Geheimhaltung. [Abnahme und Plattformgrenzen](PASSWORD-MANAGER-VERIFICATION.md).
