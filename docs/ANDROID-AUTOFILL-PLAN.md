# Android 0.28: Formulare, App-Autofill und merkbare Passwörter

Stand: 27.10.2026. Ergänzung zur [Identity-Due-Diligence](IDENTITY-DUE-DILIGENCE.md),
[Gesamt-Roadmap](ROADMAP.md) und [Produktionsveröffentlichung](ANDROID-PRODUCTION.md).

## Vermutete Intention

HeavenKey soll zu einem persönlichen Zugangsbegleiter werden: einmal Daten sicher
hinterlegen, vorhandene Konten bequem verwenden und bei neuen Konten weniger tippen.
Die Android-App soll dabei selbständig funktionieren. Für angebundene Dienste ist
das Ziel weiter eine Anmeldung mit Passkey/OIDC ohne Nutzerpasswort. Für bestehende
Passwortdienste sind Generator und Autofill die Kompatibilitätsschicht. Das ist eine
Interpretation der Text- und Sprachanfragen, kein zusätzlich zugesagter KYC-Dienst.

Ein Adressprofil ist eine Selbstauskunft. Es wird nicht als geprüfte Identität an
den OIDC-Pilot oder an Dritte übertragen. Biometrie entsperrt den lokalen Tresor;
sie ersetzt weder ein Passwort bei einem fremden Anbieter noch dessen Registrierung.

## Umgesetzt im Quellstand

| Wunsch | Umsetzung und Grenze |
| --- | --- |
| Formulare automatisch ausfüllen | Bis zu 100 verschlüsselte Profile für Name, E-Mail, Telefon, Firma und Adresse. Eindeutige sichtbare Textfelder über Android-Hints bzw. HTML-Autocomplete. Profil und einzelne Felder vor Übergabe auswählen; keine Formularsendung. |
| Androidweit | System-Autofill ab Android 11 für unterstützende native Apps; freigegebener, signaturgeprüfter Standardbrowser für HTTPS-Webformulare. Kein Versprechen für jede App, WebView, Tastatur oder OEM-Version. |
| Sicher einer App zuordnen | Explizite Zuordnung eines vorhandenen HTTPS-Logins an Paketname und aktuellen SHA-256-Signatursatz. Vor jeder Freigabe neu geprüft. Änderung der Login-Herkunft entfernt alte App-Zuordnungen. Widerruf in der App. Dies belegt keine Website-Zugehörigkeit der App. |
| Automatisch ein neues Passwort machen | Bei klaren `newPassword`/`new-password`-Feldern Generator anbieten; zuerst als neuen Login sichern, dann auch ein eindeutiges Bestätigungsfeld ausfüllen. Kein Überschreiben bestehender Logins und keine automatische Kontoerstellung. |
| Trotzdem merkbar | Sechs oder acht unabhängig zufällige Wörter aus der vollständigen EFF-Liste mit 7.776 Einträgen; etwa 77,5/103,4 Bit Wortauswahl. Punkt als eindeutiger Trenner, erstes Wort groß, Ziffer/`!` für Kompatibilität. Englische Wörter; Längenbeschränkungen einzelner Anbieter beachten. |
| Kurze zufällige Passwörter | Bestehender kryptografischer Zeichengenerator bleibt verfügbar; im App-Editor 16/24/32/48 Zeichen. Im Registrierungsdialog zunächst 24 Zeichen. Gemeldete HTML-Längenlimits werden geprüft; HeavenKey kürzt Werte nicht selbst. Native Apps können eigene Eingabefilter haben. |
| Tastaturintegration | Neutrales gesperrtes HeavenKey-Inline-Angebot ab Android 11 bei passender IME-Schnittstelle; sonst Android-Auswahlmenü. Kontonamen und Profilinhalte stehen nicht in diesem gesperrten Angebot. |
| Ohne Desktop verwenden | Lokale Speicherung und V3-Sicherung mit Logins, exportierbaren Website-Passkeys und Profilen. Ältere V1-/V2-Android-Archive lesbar. App-Vertrauensfreigaben werden nicht exportiert und müssen auf neuen Geräten erneut erteilt werden. |
| Vorhandene Daten behalten | Bestehende V1-Tresore werden mit demselben Keystore-Schlüssel gelesen und bei der nächsten Änderung atomar in V2 überführt. Profile bleiben bei Login-/Passkey-Synchronisierung erhalten. |

Der Browser meldet für Autofill nur die HTTPS-Domain, nicht zuverlässig den Port
oder die Trennung gleichnamiger eingebetteter Formulare. Die vorhandene einmalige
Domainfreigabe bleibt deshalb erforderlich und umfasst andere HTTPS-Ports derselben
Domain. Unterschiedliche Domains, fehlende Feldherkunft, unklare Mehrfachfelder,
gemischte alte/neue Passwortfelder und nicht vertrauenswürdige Browser werden
abgelehnt. Native WebViews erhalten keine Ersatzfreigabe als vermeintlich native App.

## Due Diligence und Abwägung

| Entscheidung | Pro | Kontra / verbleibende Arbeit |
| --- | --- | --- |
| Android-Autofill statt Bildschirm-/Accessibility-Lesen | Enger Systemkanal, erkennbare Felder, Auswahl vor Datenfreigabe, kein pauschaler Bildschirminhalt. | Ziel-App muss die Schnittstelle korrekt anbieten; einige Apps und eingebettete Formulare bleiben unbrauchbar. |
| Manuelle App-Zuordnung mit Signatur | Verhindert automatische Freigabe allein durch App-Label, ähnliche Domain oder ersetztes Paket mit anderem Zertifikat. | Nutzer kann einer bösartigen App bewusst Daten anvertrauen. Digitale Asset Links und Zertifikatsrotation benötigen einen getrennten, nachgewiesenen Vertrauensprozess. |
| Profile mit Feldvorschau | Weniger Tippfehler, mehrere Identitäten/Adressen, Datensparsamkeit pro Formular. | Nutzer kann trotzdem zu viele Daten freigeben. Keine automatischen Zahlungs-, Ausweis-, Steuer-, Gesundheits- oder OTP-Felder. |
| Zufällige Passphrase | Merkbare Wörter ohne persönliche Muster; vollständig lokal und offline. | Länger und zunächst Englisch; ungeeignet bei kurzen Passwortlimits. Eigene Geschichten sollen das Merken erleichtern, nicht die Wortauswahl bestimmen. |
| Erst sichern, dann ausfüllen | Erzeugtes Passwort bleibt bei abgebrochener Registrierung auffindbar. | Unbenutzte Logins können verbleiben; Notiz weist auf noch zu prüfenden Abschluss beim Anbieter hin. |
| Authentifizierung pro Vorgang | Klare Zustimmung, kurze native Frist, Einmal-Anfrage, Hintergrundwechsel sperrt. | Mehr Interaktionen als eine sofortige ungesperrte Freigabe. |
| Getrennte Vorschau-Kennung | Parallel zur bestehenden App installierbar; Produktionssignatur bleibt geschützt. Release-Laufzeit ohne Debugger. | Vorschau hat eine kurzlebige Debug-Signatur und ist nur für Testdaten. Keine stabile Update-Zusage oder Store-Freigabe. |
| Bewusst späterer Profil-Sync | Bestehender Login-/Passkey-Abgleich bleibt kompatibel; kein stilles Verlieren sensibler Desktop-Felder. | Profile zunächst Android-lokal plus Backup; gemeinsame Desktop-Struktur muss verlustfrei und versioniert angebunden werden. |

### Datenschutz, Kryptografie und Betrieb

- Profile und App-Zuordnungen liegen gemeinsam mit Logins in einer authentifiziert
  verschlüsselten, atomar ersetzten privaten Datei. Keystore benötigt starke
  Geräteauthentifizierung. Android-Systembackup und Klartextverkehr bleiben aus.
- Generator, Feldklassifizierung und Profilwahl senden keine Daten an einen Server
  oder ein Sprachmodell. Bestehender Desktop-Sync bleibt ausdrücklich gekoppelt.
- Die Android-Paketsichtbarkeit umfasst Launcher- und Browser-Intents, damit die
  Signatur der gerade anfragenden App geprüft werden kann. Kein `QUERY_ALL_PACKAGES`
  und kein Sammeln eines App-Inventars. Ist ein Paket nicht sichtbar/verifizierbar,
  wird die Freigabe abgelehnt.
- Backup V3 verwendet Plattform-AES-GCM mit eigener Versionsbindung. Der zufällige
  Wiederherstellungsschlüssel bleibt getrennt von der Datei. Falsche Schlüssel,
  Manipulation und veraltete Vorschauen dürfen nichts überschreiben.
- Ein Restore über Tresor- und Passkey-Datei ist keine globale Dateisystemtransaktion.
  Eine spätere I/O-Unterbrechung wird als unvollständige Wiederherstellung gemeldet;
  die erneute Vorschau und idempotente Wiederholung bleiben erforderlich.
- Screenshots sind gesperrt. Android ab API 31 blendet überlagernde App-Fenster im
  Autofill-Dialog aus; wichtige Dialogaktionen verwerfen verdeckte Berührungen.
- Die EFF-Wortliste bleibt unverändert enthalten, Quelle und CC-BY-4.0-Lizenz sind
  beigefügt und im Lizenzdialog erreichbar. SHA-256:
  `addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e`.
- Produktions-APK/AAB erfordern die dauerhaft vorgesehenen Herausgeberwerte in
  `android-production`. Fehlende Werte sperren diesen Kanal. Es wird kein neuer
  Herausgeberschlüssel als Ersatzidentität erfunden.

Dies ist technische Produkt-Due-Diligence, keine unabhängige Sicherheitsprüfung
oder rechtliche Freigabe. BioID, rechtlich verlässliches KYC und produktiver OIDC-
Betrieb bleiben in der bestehenden Identity-Due-Diligence mit ihren Abhängigkeiten.

## Plan und To-do-Liste mit Unteraufgaben

### P0: Implementierung dieser Version

- [x] HK-APP-028-01: Formularprofile in der App.
  - [x] Striktes Schema, Grenzen, Profil-Editor, CRUD, Feldwahl bei Freigabe.
  - [x] Gerätespeicher erweitern, alte Tresore lesbar halten, auf Sperren Flutter-Daten leeren.
  - [x] Backup V3, Vorschau und konfliktbewusstes Wiederherstellen integrieren.
- [x] HK-APP-028-02: Android-Autofill verbreitern.
  - [x] Native Apps von vertrauenswürdigen Browsern unterscheiden; WebView-Umgehung ablehnen.
  - [x] App-Signaturbindung, explizite Zuordnung und Widerruf.
  - [x] Formulartypen, Bestätigungsfelder, Fristen, Einmalnutzung und IME-Fallback.
- [x] HK-APP-028-03: Generator verbessern.
  - [x] EFF-Liste mit Lizenz, sechs/acht Wörter, CSPRNG und eindeutige Trenner.
  - [x] Passworterzeugung beim Registrieren; Speicherung vor Datenübergabe.
  - [x] Bestehende Zeichenoptionen und Bestätigung beim Ersetzen erhalten.
- [x] HK-APP-028-04: Release vorbereiten.
  - [x] Version 0.28.0+28; Produktionsprüfung erhalten.
  - [x] Getrennte `.preview`-App, drei ABI-APKs, Signatur-/Manifest-/AOT-/Quellnachweise.
  - [x] CI-Gerätetests um Migration, Profil-Backup und echte native Autofill-Abläufe erweitern.

### P0: Abnahme und Veröffentlichung

- [ ] Vollständige Android-CI auf dem finalen Quellcommit bestehen lassen.
  - [ ] 42 Flutter-Tests, native Unit-Tests, vier API-36-Gerätetests.
  - [ ] Produktionssignatur-Negativtests und APK/AAB-Prüfung mit gelöschten Testschlüsseln.
  - [ ] Separate Vorschau auf falsche App-Kennung, Testcode und Debug-Laufzeit prüfen.
- [ ] Geprüften Stand auf `main` zusammenführen und Vorschau veröffentlichen.
- [ ] Produktions-APK/AAB mit vorhandener permanenter Herausgeberkonfiguration veröffentlichen.
  - [ ] Keystore, beide Passwörter, Alias und Zertifikat-Pin in GitHub vorhanden.
  - [ ] Kein Installationskanalwechsel ohne getestete Sicherung und getrennten Schlüssel.

### P1: Tatsächliche Geräte und nahtlose Integration

- [ ] Android 11/14/16/17 auf physischen Geräten prüfen, mindestens Pixel und Samsung.
  - [ ] Aktuelles Chrome/Firefox, Gboard/Samsung-Tastatur, Dropdown und Inline.
  - [ ] Login, Registrierung, Bestätigung, Adresse, Abbruch, Rotation und App-Wechsel.
  - [ ] Flutter-/Compose-Formulare und native Eingabefilter gesondert abnehmen; Browser-/WebView-Herkunftsschutz bei zusätzlichen Adaptern erhalten.
  - [ ] Fremde Frames, lange Formulare, Shipping/Billing-Dopplung, Signaturwechsel negativ prüfen.
- [ ] Profil-Sync und Desktop-/Browserprofile verlustfrei zusammenführen.
  - [ ] Mapping zu `packages/forms/schema.ts` festlegen, insbesondere `givenName→firstName`,
    `familyName→lastName`, `postalCode→zip`, `region→state` und `addressLine1→street`.
  - [ ] Protokollversion, getrennte sensible Felder, Konfliktauflösung und alte Gegenstellen prüfen.
  - [ ] Unbekannte bzw. am Handy nicht freigegebene Felder erhalten; nie still verwerfen.
- [ ] Sichere SaveRequest-Journey für bereits manuell eingegebene Logins entwickeln.
  - [ ] Erneute Herkunfts-/App-Prüfung, Kontowechsel, keine stille Passwortrotation.
- [ ] Verifizierte Digital Asset Links für geeignete Partner, Zertifikatsrotation und Widerruf.
- [ ] Gemeinsames Credential-Manager-Angebot für native Passwörter nach Vertrauensprüfung.
- [ ] iOS-Profile und native Erweiterung mit echter iPhone-/Signierungsabnahme integrieren.
- [ ] Deutschsprachige, lizenzgeprüfte Wortliste mit gleichwertiger Entropie anbieten.
- [ ] Produktionsbetrieb: externe Sicherheitsprüfung, Store-Deklarationen, Wiederherstellungsabnahme.

### P2: Identität und kontrollierte Aktionen

- [ ] Native OIDC-Journey an echten Anbieter und echte Zielanwendung anbinden.
- [ ] Geräte hinzufügen/verlieren/widerrufen und Recovery mit Verlustfällen testen.
- [ ] Profilfreigaben als separate Scopes modellieren; Selbstauskunft und geprüfte Attribute unterscheiden.
- [ ] Optionales BioID/KYC erst nach Anbieter-, Datenschutz- und Vertrauensabnahme.
- [ ] Agentenaktionen auf Ziel, Aktion, Datenmenge und Zeit begrenzen; kein pauschales Identitätsdelegieren.

### Nicht sinnvoll als automatische Standardfunktion

- Alle Apps über Accessibility auslesen oder Herkunftssperren still ausschalten.
- Überall dasselbe merkbare Passwort, aus Namen/Geburtstag abgeleitete Kennwörter,
  kurze Wörterketten als gleichwertig zu zufälligen Passphrasen ausgeben.
- Unbeaufsichtigtes Absenden, Passwortwechsel, Kontoerstellung, Zahlungs-/KYC-Freigaben.
- Fremden Anbietern passwortlose Anmeldung versprechen, solange sie nur Passwörter akzeptieren.

## Primärquellen

- [Android: Build autofill services](https://developer.android.com/identity/autofill/autofill-services)
- [Android: Autofill optimieren](https://developer.android.com/identity/autofill/autofill-optimize)
- [Android: IME-Inline-Autofill](https://developer.android.com/identity/autofill/ime-autofill)
- [AndroidX Autofill 1.3.0](https://developer.android.com/jetpack/androidx/releases/autofill)
- [EFF: Zufällige Passphrasen](https://www.eff.org/dice)
- [EFF: Lizenz](https://www.eff.org/copyright)
