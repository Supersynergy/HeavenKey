# HeavenKey Identity: Due Diligence und Produktentscheidung

Datum: 26.10.2026. Ausgangscode: `ac37ca5`. Grundlage: die beiden bereitgestellten Sprachnachrichten und die vorhandene Implementierung. Technische und produktstrategische Prüfung; kein externes Audit, keine rechtliche Freigabe oder institutionelle Anerkennung.

## Wahrscheinliche Intention

Diese Interpretation ist aus der Rückmeldung abgeleitet, kein zusätzlich abgestimmter Vertrag:

1. **Zugang statt Passwortarbeit:** Anwendung öffnen und selbst freigeben, ohne pro Dienst Geheimnisse zu pflegen.
2. **Fortbestehende Identität:** Ein neues Handy soll nicht einen neuen Menschen, neuen Account oder Zugangsverlust bedeuten.
3. **Glaubwürdiges Vertrauen:** Partner sollen angemeldetes Konto und tatsächlich geprüfte Person unterscheiden können.
4. **Eigene Kontrolle:** Geräte, Datenweitergabe und Rechte bleiben sichtbar und widerrufbar. Daraus folgt kein Allzweck-Gesichtstracking.
5. **Plattformnutzen:** Wiederverwendbarer Login für Supersynergy und Partner; später ausdrücklich begrenzte Agentenrechte.

Der erste belastbare Nachweis ist ein passwortloser Login über zwei Anwendungen. Gesichtserkennung ohne angeschlossene Verbraucher erfüllt den Zugangswunsch noch nicht.

## Bestandsprüfung

| Befund | Grundlage | Konsequenz |
| --- | --- | --- |
| Eigenständiger Android-Tresor ohne zusätzliches Masterpasswort | `VaultStore.kt`, `docs/MOBILE.md` | Gerätefreigabe wiederverwenden. |
| Website-Passkeys verschlüsselt, sicherbar und synchronisierbar | `PasskeyStore.kt`, `PortableVaultBackup.kt`, `DesktopSync.kt` | Nicht als generell nicht exportierbare Hardware-Schlüssel bewerben. |
| Android-Profil begrenzt Browser, ES256, none-Attestation; angeforderte Extensions werden abgewiesen | `HeavenCredentialProvider.kt`, `PasskeyProtocol.options` | IdP-Kompatibilität, Browser und native App-Verknüpfung einzeln prüfen. |
| Zugangslabor hat Konto-IDs, mehrere Passkeys, Recovery und enge Grants | `apps/api/src/main.rs`, `platform.rs`, `crates/verifier` | Grundlage, keine fertige öffentliche Identity-Plattform. |
| BioID, OIDC-Provider und KYC-Prozess fehlen im Ausgangsstand | Apps/Crates/API-Routen geprüft | Zusätzliche Integrationen und Betriebsgrenzen nötig. |
| RP-ID/Origin sind fest gebunden | `platform::identity`, `pin_identity` | Dauerhafte Login-Domain vor echtem Enrollment festlegen. |
| Code-/Paket-/Geräte-Abnahme ist begrenzt | `docs/RELEASE-0.26.md`, mobile Berichte | Implementierung, Emulator, reale Geräte und externes Audit getrennt ausweisen. |

Der neue Pilot verwendet einen eigenen temporären Bestand. Er migriert weder Passkeys noch Eigentümerrechte aus dem bisherigen Labor.

## Sicherheitsfragen auseinanderhalten

| Frage | Mechanismus | Nicht automatisch bewiesen |
| --- | --- | --- |
| Wer kontrolliert das Konto? | Passkey/WebAuthn und sichere Registrierung | Bürgerliche Identität oder Absicht einer konkreten Transaktion. |
| Wer ist die reale Person? | Vertrauenswürdige eID-/Dokumentnachweise, Validierung und Zuordnung | Aktuelle Anmeldung oder Berechtigung. |
| Ist die Aufnahme live und passend? | Liveness und 1:1-Gesichtsvergleich | Echtheit des Ausweises oder allgemeine KYC-Konformität. |
| Was darf Mensch/Agent jetzt tun? | Zielseitige Autorisierung, konkrete Freigabe, Widerruf | Dass jede Aktion einer angemeldeten Sitzung gewollt ist. |

NIST trennt Nachweisprüfung, Zuordnung zur Person und spätere Authentifizierung. OIDC Identity Assurance transportiert geprüfte Angaben samt Kontext; Akzeptanz gehört zum jeweiligen Vertrauensrahmen. Keine interne Boolean-Variable darf diese Stufen gleichsetzen.

## Pro/Contra und Architekturentscheidung

| Option | Pro | Kontra / Grenze | Entscheidung |
| --- | --- | --- | --- |
| Passkeys + OIDC über etablierten IdP | Standardanschlüsse, SSO, vorhandener Lifecycle | Betrieb, Updates und Vertrauensbeziehung nötig | Jetzt als Pilot. |
| Vollständiger eigener OAuth-/OIDC-Server | Volle Gestaltung in Rust | Große neue Sicherheits-/Wartungsfläche | Für diesen Meilenstein verwerfen. |
| Native Gerätebiometrie für Passkey-Freigabe | Schnell, kein neuer zentraler Gesichtsbestand | Keine amtliche Identität | Standard im Alltag. |
| BioID Cloud | Dokumentierte APIs, weniger eigener Modellbetrieb | Serververarbeitung, Vertrag, Kosten und Verfügbarkeit | Optionaler Adapter nach Anbieterprüfung. |
| BioID auf eigener Infrastruktur | Mehr Verarbeitungskontrolle | Lizenz/Vertrag, Container, Datenbank, Betrieb | Für B2B/Datenschutzbedarf prüfen. |
| eID/vollständige Dokumentprüfung + bei Bedarf BioID | Vertrauenswürdige Attribute und Zuordnung möglich | Abdeckung und Zielakzeptanz unterschiedlich | Basis für verifizierte Identität. |
| Gesicht als alleiniger universeller Login/Reset | Bequeme Erzählung | Nicht frei austauschbare Biometrie, Injection, Fehlzuordnung | Nicht als Standard bauen. |
| Globale automatische 1:N-Gesichtssuche | Nutzername eventuell entbehrlich | Tracking-/Fehlzuordnungsrisiko, zentrale Datenbasis | Kontoauswahl oder Passkey-Discovery bevorzugen. |
| Optionaler Passworttresor | Bestehende Dienste bleiben nutzbar | Passwörter existieren weiter | Als Kompatibilität erhalten. |
| EUDI/verifizierbare Nachweise | Spätere standardisierte Wallet-Anschlüsse | Aussteller-/Verifier-Verbund und eigene Abnahme nötig | Nach konkretem Bedarf. |

Keycloak bleibt eine austauschbare Standardkomponente. Die App bleibt Schlüssel- und Freigabeort. Das bestehende Grant-Format wird nicht zu einem OIDC-Token umbenannt. Schlüssel, Kontologin, Identitätsnachweise und Agentenaufträge erhalten getrennte Lebenszyklen.

## BioID-Anbieterprüfung

PhotoVerify vergleicht Live-Aufnahmen mit einem übergebenen Referenzfoto und kann Liveness prüfen. Daraus folgt keine vollständige Ausweis-Echtheitsprüfung. BWS ist als Cloud-Verarbeitung und On-Premises-Installation dokumentiert; Letztere setzt Vereinbarung, Container und MongoDB voraus. Das ist kein belegtes reines Offline-SDK auf beliebigen Handys.

Vor Beschaffung bzw. realer Biometrieverarbeitung klären:

- Preise je Vorgang, Mindestumsatz, Test-/Produktivkonditionen und Kündigung.
- Genaues Produkt, Modellversion, PAD-/Injection-Prüfbericht und dessen Grenzen.
- Schwellen, Fehlannahme/-ablehnung, Geräteabdeckung und Aufnahmequalität.
- Verarbeitungsländer, Unterauftragnehmer, Speicherung und Löschung von Bildern/Templates.
- Rechtsgrundlage, Rollen/AVV, erforderliche Folgenabschätzung und angemessene Alternative ohne nutzbare Biometrie.
- Frische serverseitige Bindung von Antwort, Konto, Passkey und Zweck; kein clientseitig attestierter Erfolgsstatus.
- Ausfälle, Timeouts und manuelle Behandlung ohne automatisches Öffnen.

Der Pilot enthält keinen BioID-Schlüssel und keinen simulierten erfolgreichen KYC-Endpoint. Fehlende Verifikation wird sichtbar als fehlend behandelt.

## Datenschutz und Schlüsselmodell

Android-Passkeys im vorhandenen Format sind verschlüsselte, sicherbare Software-Schlüssel. Ein Keystore-geschützter Umschlag macht sie nicht automatisch hardwaregebunden. Bei höherem Schutzbedarf ein getrenntes Profil mit nicht exportierbaren Schlüsseln und geeigneter Attestierungsprüfung evaluieren; Recovery wird dadurch schwieriger.

Dienstspezifische Kennungen verringern direkte Verknüpfung zwischen Anwendungen. Der IdP sieht im OIDC-Modell weiterhin Anmeldevorgänge: Pairwise-IDs bedeuten keine vollständige Betreiberblindheit. Nur benötigte Attribute freigeben; Gesichtsbilder gehören nicht in gewöhnliche Login-Tokens.

Biometrische Identifikation benötigt eine gesonderte Datenschutzprüfung. EDPB-Hinweise unterstützen hohe Kontrolle durch Betroffene; aus deren Flughafenszenario wird hier keine pauschale HeavenKey-Rechtsgrundlage abgeleitet.

## Risiken und Nachweise

| Risiko | Priorität | Maßnahme / Nachweis |
| --- | --- | --- |
| Recovery hebelt Passkeys aus | P1, vor echten Konten | Zweitschlüssel/Gerätefreigabe oder akzeptierte erneute Identitätsprüfung; Verlust-/Missbrauchsfälle ausführen. |
| Fremdes Konto/falscher Mandant wird verknüpft | P1 | Issuer + Subject korrekt zuordnen; kein automatisches Linking allein anhand E-Mail. |
| Sitzung bleibt nach Widerruf nutzbar | P1 | Kurze Sitzungen plus Backchannel-Logout/Recheck; tatsächliche Widerrufsfrist messen. |
| Callback wird vertauscht/wiederholt | P0 | PKCE, State, Nonce, Browserbindung und Einmaligkeit prüfen. |
| Browser/OS kompromittiert | Vor Release | Vertrauensgrenze dokumentieren; keine absolute Sicherheitszusage. |
| Gesichtscheck wird als KYC vermarktet | P0/P2 | Im Pilot ungeprüft; später Quelle, Methode, Zeit und akzeptierten Rahmen übertragen. |
| Biometrie wird Trackingmerkmal | P2 | 1:1-Prüfung, Zweckbindung, Datenminimierung, Löschung und dienstspezifische Kennungen. |
| Fremde Dienste akzeptieren HeavenKey nicht | Produkt | Eigener Verbund/Partner zuerst; Integrationshilfe; Legacy ehrlich benennen. |
| IdP-Ausfall/Update blockiert Logins | Vor Release | Betriebsverantwortung, sichere Updates und Wiederherstellung tatsächlich prüfen. |

HTTP auf Loopback, temporäres H2 und flüchtige RP-Sitzungen belegen keine sichere Internetbereitstellung. Produktiv braucht es feste HTTPS-Origin, geeignete persistente Datenbank, Schlüsselrotation, sichere Administration und Systemabnahme.

## Produkt- und Geschäftsentscheidung

Erster Einsatz: eigene Supersynergy-Anwendungen und ein eingegrenztes Partnerportal. Hier lassen sich Integration und Zeit bis zum erfolgreichen Zugang messen. Anschließend nur Identitätsattribute ergänzen, die ein konkreter Kunde benötigt.

Aussagen wie „überall passwortlos“, „100 % echte Personen“ oder „KYC für alle Banken/Behörden“ vermeiden. B2B-Potenzial anhand Integrationszeit, Geräteabdeckung, Recovery-Aufwand und Betriebskosten prüfen. Preise und Marktakzeptanz sind noch nicht validiert; Interviews/Angebote bleiben offene Aufgaben.

## Primärquellen

Am 26.10.2026 geprüft; Anbieterzertifizierung nicht auf das Gesamtsystem übertragen:

- [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html)
- [OIDC Identity Assurance](https://openid.net/specs/openid-connect-4-identity-assurance-1_0.html)
- [Identity-Assurance-Schema](https://openid.net/specs/openid-ida-verified-claims-1_0.html)
- [NIST SP 800-63A-4](https://pages.nist.gov/800-63-4/sp800-63a.html)
- [Keycloak Passkeys](https://www.keycloak.org/docs/latest/server_admin/index.html)
- [Keycloak 26.8.1](https://www.keycloak.org/2026/10/keycloak-2681-released)
- [Keycloak Betrieb](https://www.keycloak.org/server/configuration-production)
- [openid-client](https://github.com/panva/openid-client)
- [BioID PhotoVerify](https://developer.bioid.com/bws/restful/photoverify)
- [BioID On-Premises](https://developer.bioid.com/bws/onprem/prerequisites)
- [FIDO Passkeys und Gerätewechsel](https://fidoalliance.org/passkeys-2/)
- [EDPB Biometrie](https://www.edpb.europa.eu/topics/ai-and-technology/biometrics_en)
- [EDPB Kontrolle biometrischer Daten](https://www.edpb.europa.eu/news/facial-recognition-at-airports-individuals-should-have-maximum-control-over-biometric-data_en)
