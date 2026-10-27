# HeavenKey Identity: Plan, To-dos und Unteraufgaben

Stand: 26.10.2026. Reihenfolge nach Abhängigkeit, nicht nach Begeisterung für eine Technik. `[x]` bedeutet erledigte konkrete Teilaufgabe; ein offener Geräte-/Betriebsnachweis wird nicht durch Quellcode ersetzt. Jede Phase endet mit einem überprüfbaren Ergebnis.

## P0 — Gemeinsames Ziel und lokaler Login-Pilot

- [x] **HK-ID-001 — Intention und Due Diligence dokumentieren.**
  - [x] Sprachnachrichten in Produktanforderungen übersetzen; Interpretation als solche benennen.
  - [x] Vorhandenen Code und veröffentlichte Vorschau unterscheiden.
  - [x] Anmeldung, Identitätsprüfung, Liveness und Autorisierung getrennt beschreiben.
  - [x] Pro/Contra, Risiken, Alternativen und Nicht-Ziele in `IDENTITY-DUE-DILIGENCE.md` festhalten.
- [x] **HK-ID-002 — Isolierten OIDC-Pilot implementieren.**
  - [x] Eigener temporärer Keycloak-Realm; keine bestehenden Tresore oder Eigentümerrechte importieren.
  - [x] Nutzerregistrierung ohne Passwort-Erstellung; Passkey-Einrichtung als Pflichtschritt konfigurieren.
  - [x] Login über SSO-Cookie oder benutzerverifizierten Passkey konfigurieren; keinen Nutzer-Passwort-Grant aktivieren.
  - [x] Zwei klar gekennzeichnete Demo-Verbraucher mit exakten Callback-Adressen und S256-PKCE anbinden.
  - [x] State, Nonce, Browserbindung, einmaligen Callback und zusätzliche ID-Token-Signaturprüfung implementieren.
  - [x] Sitzung nach Anmeldung erneuern; kurzlebige serverseitige Sitzungen; Tokens nicht an Browser/API ausgeben.
  - [x] Pairwise-Mapper für dienstspezifische Kennungen konfigurieren.
  - [x] Identitätsprüfung im Pilot ausdrücklich als nicht vorhanden ausgeben.
- [x] **HK-ID-003 — Pilot verifizieren und CI binden.**
  - [x] Zehn Sicherheitsregressionen einschließlich falscher Signatur, Issuer, Audience, Nonce, Replay und Ablauf bestanden.
  - [x] Dependency-Audit des neuen Node-Pakets: keine bekannten gemeldeten Schwachstellen beim Lauf.
  - [x] Registrierung bis erstem Anwendungseinstieg ohne Nutzerpasswort ausführen.
  - [x] SSO in die zweite Anwendung ausführen; verschiedene pseudonyme Kennungen prüfen.
  - [x] Neue Browsersitzung mit bestehendem synthetischem Passkey anmelden.
  - [x] Lokales Abmelden und ungeprüften Identitätsstatus im echten Flow nachweisen.
  - [x] Frischen Beleg mit Quellhashes erzeugen; bei Fehlschlag keinen alten Erfolgsbeleg behalten.
  - [x] [Identity-CI bestanden](https://github.com/Supersynergy/HeavenKey/actions/runs/40250235572) am Runtime-Stand `cef6bef`; virtuelle CTAP2-Abnahme ausdrücklich von Hardware getrennt.

**Abnahme:** `npm test --prefix apps/identity-pilot` und `python3 scripts/identity_pilot.py --e2e`; frisches `docs/evidence/identity/pilot.json`. Der Pilot ist weder ein echtes Office-Login noch ein Android-Hardwaretest.

## P1 — App und echte Supersynergy-Anbindung

- [ ] **HK-ID-010 — Dauerhafte Identitätsumgebung festlegen.** Abhängigkeit: HK-ID-003.
  - [ ] Betreiber, dauerhafte HTTPS-Login-Domain/RP-ID und Pilotmandant festlegen.
  - [ ] Persistente Datenbank, Admin-/Signierschlüssel, Updates, Sicherung und Restore einrichten.
  - [ ] `start-dev`, Loopback-HTTP und temporäre Daten NICHT als Produktivkonfiguration übernehmen.
  - [ ] Mandanten- und Verbraucherregistrierung mit exakten Redirects und minimalen Scopes festlegen.
- [ ] **HK-ID-011 — HeavenKey-Android-Anbieter gegen den IdP testen.**
  - [ ] Aktuelle, signierte App und physisches Android-Gerät mit unterstütztem Browser erfassen.
  - [ ] Samsung S24 Ultra/Android 16 als erste Geräteabnahme vorsehen; Fingerabdruck, Geräte-PIN und Gesicht getrennt bewerten.
  - [ ] Tatsächliche WebAuthn-Optionen des IdP prüfen: ES256, discoverable Credentials, UV, Attestation, Extensions.
  - [ ] Benötigte optionale Extensions standardkonform behandeln; verpflichtende ununterstützte Merkmale weiterhin ablehnen.
  - [ ] Origin/RP-ID, fremde Browser/App-Signaturen, Abbruch und Replay mit negativen Fällen prüfen.
  - [ ] Native App-Login-Journey über Systembrowser/geeignete App-Verknüpfung entwickeln; keine geheime WebView-Ausnahme.
- [ ] **HK-ID-012 — Tatsächliches Supersynergy Office als OIDC-Verbraucher anbinden.**
  - [ ] Aktuelle Auth-/Tenant-Implementierung im Office-Repository prüfen; eigenen Branch und synthetischen Tenant nutzen.
  - [ ] Issuer + Subject auf internes Benutzerkonto abbilden; E-Mail allein verknüpft keine Konten.
  - [ ] Mitgliedschaft, Rolle und Berechtigung bleiben beim Zielsystem; Login erteilt keine Ownerrechte.
  - [ ] Anmeldung, Erstzuordnung, gesperrter Tenant, fremde Audience und bestehende Benutzerkonten testen.
  - [ ] Erste reale Partneranwendung erst nach der Office-Abnahme aufnehmen.
- [ ] **HK-ID-013 — Logout, Sperren und Widerrufsfristen abschließen.**
  - [ ] Lokales Logout, IdP-Logout, Gerätewiderruf und Kontosperre getrennt spezifizieren.
  - [ ] Backchannel-Logout oder kontrollierten Recheck in jedem Verbraucher implementieren.
  - [ ] Zugriff nach Geräte-/Kontosperre an beiden Zielanwendungen tatsächlich messen.
  - [ ] Abgelaufene Tokens, Uhrabweichung, Neustart und verlorene Verbindungen prüfen.
- [ ] **HK-ID-014 — Identity-Journey in die App integrieren.**
  - [ ] Einstieg mit „Identität einrichten“ und „Vorhandene Identität verwenden“; vorhandene Geräte sicher zuordnen.
  - [ ] Identität, Geräte, verbundene Anwendungen und Freigaben verständlich anzeigen.
  - [ ] Kontologin und verifizierte Person sichtbar unterscheiden; fehlende Prüfung nicht durch einen grünen Sicherheitsstatus verdecken.
  - [ ] Vor Datenaustausch Ziel und benötigte Attribute zeigen; Einzelverbindungen widerrufbar machen.
  - [ ] Bestehende Passwort-Logins als optionalen Kompatibilitätsbereich erhalten.
  - [ ] Keine unverbundenen Loginbuttons ausliefern; die tatsächliche Ende-zu-Ende-Journey abnehmen.

**Abnahme:** Echte HeavenKey-App meldet synthetischen Benutzer in tatsächlichem Office an. Falscher Tenant und widerrufener Zugang werden am Ziel abgewiesen. Erst dann den Einstieg als integrierte Produktfunktion zeigen.

## P1 — Geräte, Verlust und Wiederherstellung

- [ ] **HK-ID-020 — Weitere Geräte sicher aufnehmen.** Abhängigkeit: HK-ID-010/011.
  - [ ] Freigabe durch vorhandenes vertrauenswürdiges Gerät oder anderen bereits registrierten Schlüssel.
  - [ ] Pro Gerät eigener Passkey; Gerätename, letzter Zugriff und Widerruf sichtbar.
  - [ ] Standard-Cross-Device-Flow nur für tatsächlich unterstützte Plattformkombinationen anbieten.
  - [ ] Verschlüsselte Synchronisierung vom Hinzufügen einer neuen Geräteberechtigung unterscheiden.
- [ ] **HK-ID-021 — Recovery ohne schwachen Hintereingang.**
  - [ ] Zweitschlüssel/-gerät und sicheren Verlustablauf entwerfen.
  - [ ] Vollständigen Verlust aller Geräte mit akzeptierter erneuter Identitätsprüfung oder anderem festgelegten starken Verfahren behandeln.
  - [ ] Selfie, E-Mail oder SMS allein erteilen keinen neuen Vollzugriff.
  - [ ] Neue Schlüsselaufnahme, Widerruf alter Schlüssel und Ziel-Sitzungen gemeinsam ausführen.
  - [ ] Diebstahl, zurückgespielte alte Sicherung, Abbruch und Identitätskonflikt testen.

**Abnahme:** Zweites physisches Gerät aufnehmen; erstes verlieren/sperren; berechtigten Zugriff wiederherstellen; Angreifer-Recovery scheitert. Ein virtueller Credential-Import im Test ist hierfür kein Nachweis.

## P2 — Verifizierte Identität und BioID

- [ ] **HK-ID-030 — Vertrauensmodell pro Zielkunde definieren.**
  - [ ] Benötigte Attribute und akzeptierte Identitätsnachweise/Verfahren schriftlich bestimmen.
  - [ ] Normales Konto, verifiziertes Attribut und regulatorischer Nachweis getrennt kennzeichnen.
  - [ ] Identitätsdaten, Quelle, Methode, Prüfer, Zeitpunkt, Ablauf und Widerruf modellieren.
  - [ ] OIDC `verified_claims` nur für tatsächlich geprüfte Angaben verwenden; `acr` nicht als KYC-Ersatz nutzen.
- [ ] **HK-ID-031 — Identitätsprüfung integrieren.**
  - [ ] Geeigneten eID-/Dokumentprüfer samt Echtheitsprüfung auswählen.
  - [ ] Serverseitigen einmaligen Prüfauftrag an Konto und vorgesehenen Passkey binden.
  - [ ] Ergebnis über authentifizierten Anbieterkanal prüfen; Clientstatus ist kein Beleg.
  - [ ] Vertauschte Vorgänge, falsche Person, abgelaufene Nachweise, Widerruf und Datenminimierung testen.
- [ ] **HK-ID-032 — BioID-Due-Diligence abschließen.** Externe Abhängigkeit: Anbieterzugang/Vertrag.
  - [ ] Produkt, Lizenz, Preise, Mindestmengen, SLA, Datenstandorte, AVV und Löschung klären.
  - [ ] Aktuelle PAD-/Injection-Berichte, Modellversionen, Schwellen und Geräteabdeckung prüfen.
  - [ ] Cloud versus eigene Infrastruktur anhand konkreter Kosten und Datenschutzanforderungen entscheiden.
  - [ ] Rechtsgrundlage, Folgenabschätzung und alternative Verfahren fachlich prüfen lassen.
- [ ] **HK-ID-033 — BioID-Adapter und optionale Zusatzprüfung implementieren.**
  - [ ] Keine Secrets im Client, Repository, Log oder Prompt; Anbieterzugang serverseitig verwalten.
  - [ ] Aufnahme, Frische, Zweck/Kontobindung und 1:1-Referenzvergleich festlegen.
  - [ ] Liveness, Gesichtstreffer und gültigen Identitätsnachweis unabhängig auswerten.
  - [ ] Timeout/Fehler führen zu keiner Freigabe; Ablehnung und manuelle Bearbeitung nutzbar gestalten.
  - [ ] Keine generelle BioID-Pflicht bei gewöhnlichem Login; sensible Aktionen gezielt zusätzlich bestätigen.

**Abnahme:** Zielkunde akzeptiert das Verfahren; reale Anbieterprüfung mit rechtmäßig erhobenen Daten und unabhängiger Sicherheitsabnahme. Kein weltweites KYC-Versprechen.

## P3 — Partner, Wallets und Agenten

- [ ] **HK-ID-040 — Partnerintegration vereinfachen.**
  - [ ] Dokumentierte OIDC-Integration, Beispielkonfiguration und kontrolliertes Onboarding für Verbraucher.
  - [ ] Dienstspezifische Kennungen, minimale Attribute, Zustimmung und Datenfreigaben sichtbar machen.
  - [ ] Drei konkrete Kunden-/Partnergespräche; Integrationszeit, Recovery-Support und Betriebskosten messen.
- [ ] **HK-ID-041 — Agenten erhalten eigene begrenzte Rechte.**
  - [ ] Menschenkonto und Maschinenidentität getrennt halten.
  - [ ] Tenant, Ressource, Aktion, Parameter, Laufzeit und Zielserver binden.
  - [ ] Frische Zustimmung für sensible Aktionen und zielseitigen Widerruf nachweisen.
  - [ ] Keine Passwort-/Cookie-Freigabe oder pauschale Identitätsvererbung durch OIDC-Login.
- [ ] **HK-ID-042 — Wallet-Interoperabilität bei bestätigtem Bedarf.**
  - [ ] Konkrete EUDI-/Nachweis-Verbraucher und Aussteller bestimmen.
  - [ ] OID4VP/OID4VCI und zulässige Nachweisformate gegen aktuelle Primärspezifikationen prüfen.
  - [ ] Nur nach erfolgreicher Interop-Abnahme anbieten; Labor-Grants nicht als offizielle Wallet-Credentials ausgeben.

## Gemeinsame Release-Abnahme

- [ ] Laufende Android-Releaseänderungen zusammenführen und ihre Quellen-/Paketbelege separat prüfen.
- [ ] Bestehende `just check`-/`just e2e`-Oracles am endgültigen Integrationsstand bestehen.
- [ ] Physische Plattformmatrix, aktuelle Browser und gegebenenfalls iOS abschließen.
- [ ] Herausgebersignaturen/Notarisierung und sichere Updateverteilung nachweisen.
- [ ] Unabhängige Sicherheitsprüfung, Wiederherstellung und Betriebsverantwortung vor produktiven Identitätskonten.
- [ ] Öffentlich nur tatsächlich bestandene Funktionen und Grenzen kommunizieren.

## Android-Ergänzung 0.28

Die App-Anforderungen aus dem Gesamtkontext werden im
[Android-Plan mit Unteraufgaben](ANDROID-AUTOFILL-PLAN.md) geführt. Profile werden
nicht automatisch zu Identitätsnachweisen oder OIDC-Claims. Profil-Sync, Digital
Asset Links, Credential-Manager-Passwörter und iOS folgen erst nach den dort
aufgeführten Vertrauens- und Interoperabilitätsprüfungen.
