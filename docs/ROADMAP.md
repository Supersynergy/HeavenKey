# HeavenKey: Identität, Anmeldung und kontrollierter Zugang

Stand: 26.10.2026. Bestandsprüfung auf `ac37ca5` (nach PR #36).

**Ziel: Eine persönliche Identität, mit der Menschen auf ihren Geräten passwortlos in angebundene Anwendungen gelangen und ausgewählte Rechte vergeben können.** Identität, Stärke der Anmeldung und Berechtigung werden getrennt bewertet. Ein Passkey-Login ist kein KYC-Nachweis.

- [Due Diligence, Intention, Alternativen und Pro/Contra](IDENTITY-DUE-DILIGENCE.md)
- [Plan und To-do-Liste mit Unteraufgaben](IDENTITY-BACKLOG.md)
- [Lokalen Login-Pilot ausführen](../apps/identity-pilot/README.md)
- [Android- und Desktop-Bestand](MOBILE.md)

## Produktentscheidung

| Ebene | Aufgabe | Entscheidung |
| --- | --- | --- |
| HeavenKey-App | Schlüssel verwenden, Zugänge freigeben, Geräte und Sicherung verwalten | Bestehende App weiterverwenden; Identity-Journey an einen funktionierenden Anbieter anbinden. |
| Identitätsanbieter | Passkey-Anmeldung und SSO für angeschlossene Anwendungen | OIDC auf einem etablierten Anbieter; zunächst isolierter Keycloak-Pilot. |
| Identitätsprüfung | Verlässliche Identitätsattribute feststellen | Separater optionaler Prozess mit eID/Dokumentenprüfung und bei Bedarf BioID. |
| Berechtigungen | Konkrete Aktionen von Mensch und Agent begrenzen | Bestehende enge Freigaben erhalten; Mandant, Ziel, Aktion und Widerruf am Ausführungspunkt prüfen. |
| Kompatibilität | Bestehende Passwort-Websites weiter nutzen | Tresor optional erhalten; Autofill nicht als Passwortabschaffung vermarkten. |

## Ausführungsreihenfolge

| Phase | Ergebnis | Stand / Freigabekriterium |
| --- | --- | --- |
| P0 — Login-Pilot | Registrierung ohne Nutzerpasswort, Passkey, zwei OIDC-Demos und verschiedene Dienstkennungen | Lokal sechs Browserprüfungen und zehn Sicherheitsregressionen bestanden; [Beleg](evidence/identity/pilot.json) an Quellhashes gebunden. CI gesondert prüfen. Kein produktiver Betrieb. |
| P1 — App und echtes Ziel | Android-Anbieter und tatsächliches Supersynergy Office nutzen denselben geprüften Loginanbieter | Physisches Android-Gerät, exakte Zielversion, Tenant-Zuordnung und Logout/Widerruf nachweisen. |
| P1 — Geräte und Recovery | Neues Gerät hinzufügen; verlorenes sperren; Zugriff sicher wiederherstellen | Keine Recovery allein durch E-Mail, SMS oder beliebiges Selfie; Verlustfälle ausführen. |
| P2 — Verifizierte Identität | Herkunft, Prüfmethode, Aktualität und Vertrauensniveau ausgewählter Angaben | Akzeptierter Identitätsnachweis; serverseitige Bindung an Konto/Passkey; keine Selbstauskunft als KYC ausgeben. |
| P2 — BioID | Optionaler Liveness-/1:1-Abgleich für Verifikation oder risikobasierte Zusatzprüfung | Vertrag, Kosten, Verarbeitungspfad, Datenschutz und reale Anbieterprüfung. |
| P3 — Partner und Agenten | Weitere OIDC-Verbraucher und kontrollierte Agentenaktionen | Rechte am echten Ziel erzwingen; menschliche Identität nicht pauschal an Agenten weiterreichen. |
| P3 — Wallet-Interoperabilität | Bei konkretem Bedarf EUDI/verifizierbare Nachweise | Eigene Standards-/Interop-Abnahme; keine staatliche Anerkennung behaupten. |
| Release | Verteilbares Produkt mit sicherem Betrieb | Signierung, reale Geräte, Recovery, externe Sicherheitsprüfung und betriebliche Abnahme. |

Keine Kalenderzusage ersetzt die Abnahme einer Phase. BioID-Verfügbarkeit, institutionelle Akzeptanz und Hardwaretests sind externe Abhängigkeiten.

## Was der erste Pilot integriert

- Eigener lokaler Keycloak-Realm mit Passkey-Anmeldung und Registrierung ohne Nutzerpasswort.
- Zwei als Demo gekennzeichnete OIDC-Verbraucher; kein vorgetäuschter Office-Connector.
- Authorization Code Flow mit S256-PKCE, State, Nonce und zusätzlicher ID-Token-Signaturprüfung.
- Tokens verbleiben in der serverseitigen Callback-Verarbeitung; im Browser nur flüchtige Sitzung.
- Unterschiedliche pseudonyme Nutzerkennungen je Demo-Anwendung.
- Identität bleibt **nicht geprüft**; keine KYC-Bescheinigung und kein BioID-Erfolg simuliert.
- Laufzeitbegrenzung, eigener temporärer Bestand und ausschließlich Loopback-Listener.
- Lokales Abmelden und Sitzungsablauf. Globales Logout und unmittelbarer Widerruf über alle Verbraucher bleiben P1.

Ein virtueller Browserlauf belegt weder den nativen Android-Anbieter noch ein physisches Telefon. Der Pilot hat keinen Produktivmodus und öffnet weder den vorhandenen Tresor noch dessen Zugangslabor.

## Bewusst nicht verfolgen

| Idee | Begründung / bessere Integration |
| --- | --- |
| Gesicht als universeller alleiniger Schlüssel | Schlüsselbesitz, Absicht und Recovery bleiben unzureichend abgesichert. Gesicht bei Bedarf als zusätzliche 1:1-Prüfung verwenden. |
| Globale Gesichtssuche beim Öffnen beliebiger Handys | Unnötige zentrale Identifizierbarkeit und Angriffsfläche. Freigegebene Geräte oder ausdrücklich gestartete Anmeldung verwenden. |
| BioID-Erfolg gleich KYC-Erfolg | Liveness, Bildvergleich und Echtheit des Identitätsnachweises getrennt prüfen. |
| Eigener OAuth-/JWT-Stack im vorhandenen Grant-Format | Experimentelle Grants sind keine OIDC-Tokens. Standardanbieter und geprüfte Bibliotheken integrieren. |
| Alle fremden Websites pauschal passwortlos machen | Zielanbieter muss Passkeys oder HeavenKey unterstützen. Legacy-Modus transparent benennen. |
| BioID bei jedem gewöhnlichen Login erzwingen | Mehr Verarbeitung, Kosten, Ausfälle und Reibung. Alltag über gerätelokale Passkey-Freigabe lösen. |

## Bestand und offene Abnahmen erhalten

Desktop: verschlüsselte Logins, Formularprofile, Importvorschau, PRF-Entsperren, befristete Feldfreigaben, SSH und SFTP/FTPES sowie geschützte Agentenaufträge. Android: eigener Tresor, Website-Passkeys und optionaler manueller Desktop-Abgleich. Quellfunktionen sind nicht automatisch Bestandteil bereits veröffentlichter APKs.

| Bereich | Weiter erforderlicher Nachweis |
| --- | --- |
| Windows | Echter Windows-Kernel mit Hello/PRF und nativen Sandbox-Prüfungen; Wine reicht nicht. |
| macOS | Herausgebersignatur, Notarisierung und Installation auf fremdem Gerät. |
| Android/iOS | Physische Geräte, aktuelle Browser, nativer Anbieter, Verlust/Recovery; iOS separat bauen und prüfen. |
| Firefox | Mozilla-Signierung und dauerhafte Installation. |
| Desktop-Fenster | Native Windows-/Linux-Shell samt Lifecycle und WebAuthn. |
| Connectoren | Reale Ziele, Tenant-Zuordnung, Fehler und Widerruf am Ausführungspunkt. |
| Sicherheit/Betrieb | Unabhängige Prüfung, Updates, Schlüsselrotation und tatsächliche Wiederherstellung. |

Parallel laufende Android-Releasearbeiten vor einer gemeinsamen Produktfreigabe separat abgleichen. Diese Roadmap erteilt keine Produktionsfreigabe.
