# Enpass und 20 weitere Passwortmanager — HeavenKey-Anforderungen

Stand: 16. Oktober 2026. Genau 21 Produkte, 17 vergleichbare Merkmale. Primärquellen wurden heute abgerufen oder über den Suchindex gelesen. Dies ist eine Dokumentationsanalyse; keine Konkurrenz-App wurde installiert oder mit echten Zugangsdaten geprüft.

Enpass ist bereits ein Offline-Passwortmanager mit frei wählbarem Speicher, Passkeys, Autofill, Authenticator-Codes und WLAN-Sync. Ein lokaler verschlüsselter Tresor allein begründet deshalb keinen Funktionsvorsprung. HeavenKeys möglicher eigener Wert liegt in überprüfbaren, eng begrenzten Freigaben und Agentenzugriffen, kombiniert mit einem alltagstauglichen Passwortmanager. Ob Nutzer das bevorzugen, ist offen.

## Leseregeln

`Y` = Hersteller dokumentiert; `C` = bedingt; `N` = ausdrücklich ausgeschlossen; `U` = hier ungeklärt. Ein U bedeutet keine fehlende Produktfunktion. Tarif-/Clientgrenzen gelten. Quelloffenheit ist kein Sicherheitsnachweis. Hersteller-Auditbehauptungen wurden nicht als ausgeführte eigene Prüfung behandelt. Preise und Gesamtrankings sind absichtlich nicht bewertet.

Die 17 Merkmale und die Belegzuordnung jeder bestätigten Zelle stehen maschinenlesbar in [matrix.json](password-manager-matrix.json). Tabellenzellen nennen nur Status; die Produktabschnitte verlinken offizielle Quellen. Offline-Lesen, Offline-Schreiben, selbst gewählter Speicher und Selfhosting sind unterschiedliche Eigenschaften.

## Speichermodell und Offline-Grenzen

| Produkt | Modell | Offline-Bedingungen |
|---|---|---|
| Enpass | local-first | Vollständig offline laut Anbieter. Synchronisierung optional über eigenen Cloudspeicher oder lokales WLAN; WLAN-Sync benötigt mindestens einen Desktop. |
| Bitwarden | server-with-cache | Bereits angemeldete/entsperrbare App: offline nur lesen. Kein Hinzufügen, Bearbeiten oder Import. Eigenes Hosting ändert diese Offline-Grenze nicht. |
| 1Password | server-with-cache | Mit Mitgliedschaft Zugriff online/offline dokumentiert; Offline-Schreibumfang und Erstregistrierung hier nicht geprüft. |
| KeePassXC | local-file | Lokale verschlüsselte KDBX-Datei; Cloudspeicher/Sync extern frei wählbar. Browser-Passkeys benötigen KeePassXC-Browser und aktivierte Integration. |
| KeePass | local-file | Lokale verschlüsselte Datenbank; portable Windows-App. Auto-Type gehört zum Kern, Browser-Plugins getrennt prüfen. |
| KeePassDX | local-file | Lokaler Android-Editor für KeePass-Dateien; Sync über externe Dateianbieter nicht mit eigenem Syncdienst gleichsetzen. |
| Strongbox | local-file | Lokale oder selbst gewählte Cloud-/WebDAV-/SFTP-Datenbank. Vergleich/Merge und automatische Backups dokumentiert; genaue Offline-Schreibmatrix nicht separat geprüft. |
| Proton Pass | server-with-cache | Desktop-Offlinezugriff wird für zahlende Nutzer dokumentiert; laut aktueller Anleitung automatisch aktiv. Offline-Schreibumfang und Free-Plan hier nicht nachgewiesen. |
| NordPass | server-with-cache | Angemeldeter Nord-Account erforderlich; offline lesen/kopieren, kein Anlegen/Bearbeiten/Löschen. Desktop muss mit Master-Passwort entsperrt sein. |
| Dashlane | server-with-conditional-cache | Master-Passwort: zuvor auf Gerät angemeldet, keine 2FA bei jedem Login. Passwortlose Konten immer online. SSO offline nur mobil mit vorherigem Biometrie/PIN-Setup; Webbrowser offen halten. |
| Keeper | server-with-cache | Offline Access vorab aktivieren und einmal online primen; Administrator kann es begrenzen. Lesen, Anlegen und Bearbeiten offline dokumentiert, Sync bei Wiederverbindung. |
| RoboForm | local-mode-or-cloud | Offlinezugriff und Betriebsmodus ohne Server-Sync dokumentiert. Exakte Offline-CRUD-/Konfliktmatrix nicht geprüft. |
| LastPass | server-with-cache | Einmaliger Online-Login erzeugt lokale verschlüsselte Cachekopie in Erweiterung/App. Offlinezugriff kann durch Richtlinie deaktiviert sein; Schreibumfang nicht aktuell verifiziert. |
| Zoho Vault | server-with-export-and-cache | Verschlüsselter HTML-Download mit Master-Passwort erlaubt serverunabhängiges Lesen. Mobile Cachegrenzen separat prüfen; Exporte sind Momentaufnahmen. |
| Sticky Password | local-mode-or-cloud | Cloudsync/Backup, lokales WLAN, manueller Offline-Modus oder kein Sync wählbar. Erststart-/Offline-Schreibmatrix nicht separat geprüft. |
| SafeInCloud / Safe | local-first | Eigene Cloud, WebDAV/NAS oder vollständig offline. Verschlüsselter oder unverschlüsselter Export möglich; kein Safe-Server speichert den Tresor. |
| Google Password Manager | local-device-or-account-sync | Chrome kann ohne Anmeldung Passwörter nur auf dem Gerät speichern. Account-Sync und Passkeys haben eigene Plattform-/Setupgrenzen; vollständige Offline-Passkeymatrix ungeprüft. |
| Passbolt | server-with-selective-cache | Seit 5.16 beta: Administrator aktiviert, Nutzer markiert einzelne v5-Ressourcen. Offline nur lesend über Quick Access, mit Passphrase; Standardlimit 1000. Retention begrenzt Cache. |
| Padloc | server-cloud-offline-unknown | Cloudspeicherung und Apps dokumentiert. Offline-Lese-/Schreibumfang in der geprüften aktuellen Landingpage nicht belegt; alte Selfhost-Anleitung ist keine Offline-Abnahme. |
| Psono | self-hosted-server-with-cache | Vorher online aktivierter Offline-Modus lädt alle Einträge verschlüsselt, geschützt durch separate Passphrase. Nur lesend; eigener Server bleibt reguläres Backend. |
| Apple Passwords | local-keychain-with-icloud-sync | Lokale Keychain; bei deaktiviertem iCloud-Sync bleiben Passwörter/Passkeys lokal. Geteilte Gruppen stehen nach Abmelden/Syncabschaltung nicht weiter zur Verfügung. Offline-Mutationsmatrix ungeprüft. |

## Funktionsmatrix

G = Generator; B = Browser-Autofill; M = mobiles Autofill; P = Passkeys fremder Dienste; T = TOTP; I/E = Import/Export; S = Teilen; H = Health/Breach; Bio = Biometrie; A = Anhänge; O = quelloffene App; Own = eigener Speicher/Server; Sync = Gerätesync; R/W = offline lesen/schreiben; Enc = verschlüsselte Speicherung.

| Produkt | G | B | M | P | T | I | E | S | H | Bio | A | O | Own | Sync | R | W | Enc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Enpass | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | U | Y | Y | Y | Y | Y |
| Bitwarden | Y | Y | U | Y | C | U | U | Y | Y | Y | Y | Y | U | Y | Y | N | Y |
| 1Password | Y | Y | Y | Y | Y | U | U | Y | Y | U | U | U | U | Y | Y | U | Y |
| KeePassXC | Y | Y | U | Y | Y | Y | Y | C | Y | Y | Y | Y | Y | U | Y | Y | Y |
| KeePass | Y | U | U | U | U | Y | Y | U | U | U | Y | Y | Y | U | Y | Y | Y |
| KeePassDX | U | U | Y | Y | Y | U | U | U | U | Y | U | Y | Y | U | Y | Y | Y |
| Strongbox | U | U | Y | Y | Y | U | U | C | Y | Y | U | U | Y | Y | Y | U | Y |
| Proton Pass | Y | Y | Y | Y | Y | Y | C | Y | Y | U | Y | Y | U | Y | C | U | Y |
| NordPass | Y | Y | U | Y | Y | Y | U | Y | Y | Y | U | U | U | Y | Y | N | Y |
| Dashlane | Y | Y | Y | U | U | Y | U | Y | Y | U | U | U | U | Y | C | U | Y |
| Keeper | Y | Y | Y | Y | Y | U | U | Y | Y | Y | Y | U | U | Y | Y | C | Y |
| RoboForm | Y | Y | U | Y | Y | Y | Y | Y | Y | U | U | U | Y | Y | Y | U | Y |
| LastPass | Y | Y | Y | Y | U | U | U | Y | U | U | U | U | U | Y | Y | U | Y |
| Zoho Vault | Y | Y | Y | U | Y | Y | Y | Y | Y | Y | Y | U | U | Y | Y | U | Y |
| Sticky Password | Y | Y | U | U | U | Y | U | Y | Y | Y | U | U | Y | Y | Y | U | Y |
| SafeInCloud / Safe | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | U | Y | Y | Y | C | Y |
| Google Password Manager | Y | Y | Y | C | U | Y | Y | C | Y | Y | U | U | Y | Y | C | U | Y |
| Passbolt | U | Y | U | U | Y | U | U | Y | U | U | U | Y | Y | Y | C | N | Y |
| Padloc | U | U | U | U | Y | U | U | Y | Y | U | Y | Y | U | Y | U | U | Y |
| Psono | Y | Y | Y | Y | U | U | U | Y | U | U | U | Y | Y | Y | Y | N | Y |
| Apple Passwords | U | Y | Y | Y | Y | U | U | Y | Y | U | U | U | Y | Y | C | U | Y |

## Quellen und offene Punkte je Produkt

### Enpass

Offizielle Quellen: [main](https://www.enpass.io/personal/) · [help](https://help.enpass.io/personal/latest/all/why-enpass) · [wifi](https://www.enpass.io/wifi-sync/) · [passkeys](https://www.enpass.io/passkeys/) · [audit](https://help.enpass.io/personal/latest/all/password-health-audit) · [transfer](https://help.enpass.io/personal/latest/all/importing-from-enpass).

Plattformangabe: Windows, macOS, Linux, Android, iOS; Browser. Offen: Quelloffene App.

Enpass-Importdokumentation schließt Passkey-Export zwischen Managern aus. Passwortexport ist deshalb kein Passkey-Portabilitätsnachweis; Aussagen anderer Anbieter können andere Formate/Versionen betreffen.

### Bitwarden

Offizielle Quellen: [main](https://bitwarden.com/products/personal/) · [offline](https://bitwarden.com/help/using-bitwarden-offline/) · [biometrics](https://bitwarden.com/help/biometrics/) · [opensource](https://bitwarden.com/open-source/).

Plattformangabe: Desktop, mobile Apps, Browser; genaue Plattformmatrix hier nicht vollständig geprüft. Offen: Mobiles Autofill, Passwortimport, Passwortexport, Eigener Speicher / eigener Server.

Offline-Schreibunterstützung ausdrücklich ausgeschlossen; im JSON als N erfasst.

### 1Password

Offizielle Quellen: [main](https://1password.com/features) · [offline](https://support.1password.com/why-membership/).

Plattformangabe: Windows, macOS, Linux, Android, iOS; Browser. Offen: Passwortimport, Passwortexport, Biometrisches Entsperren, Dateien/Anhänge, Quelloffene App, Eigener Speicher / eigener Server, Offline erstellen/ändern.

Offline-Beleg aus offizieller indexierter Supportseite; direkter Fetch lieferte nur eine dünne Antwort.

### KeePassXC

Offizielle Quellen: [main](https://keepassxc.org/) · [guide](https://keepassxc.org/docs/KeePassXC_UserGuide).

Plattformangabe: Windows, macOS, Linux; mobile KeePass-Clients sind eigenständige Produkte. Offen: Mobiles Autofill, Geräte-Synchronisierung.

### KeePass

Offizielle Quellen: [main](https://keepass.info/features.html).

Plattformangabe: Windows; Ports anderer Anbieter für weitere Systeme. Offen: Browser-Autofill, Mobiles Autofill, Passkeys fremder Dienste speichern/verwenden, Integrierte TOTP-Codes, Geheimnisse teilen, Passwort-/Breach-Prüfung, Biometrisches Entsperren, Geräte-Synchronisierung.

Auto-Type ist kein belegtes origin-gebundenes Browser-Autofill. Plugin-Funktionen zählen hier nicht als Kernfunktion.

### KeePassDX

Offizielle Quellen: [main](https://raw.githubusercontent.com/Kunzisoft/KeePassDX/master/README.md) · [autofill](https://github.com/Kunzisoft/KeePassDX/wiki/AutoFill).

Plattformangabe: Android. Offen: Passwortgenerator, Browser-Autofill, Passwortimport, Passwortexport, Geheimnisse teilen, Passwort-/Breach-Prüfung, Dateien/Anhänge, Geräte-Synchronisierung.

README stammt vom unversionierten master-Branch. Kein installierter APK-Test.

### Strongbox

Offizielle Quellen: [main](https://strongboxsafe.com/).

Plattformangabe: macOS, iOS, iPadOS; andere KeePass-Clients getrennt. Offen: Passwortgenerator, Browser-Autofill, Passwortimport, Passwortexport, Dateien/Anhänge, Quelloffene App, Offline erstellen/ändern.

### Proton Pass

Offizielle Quellen: [main](https://proton.me/pass) · [offline](https://proton.me/support/how-to-use-proton-pass-desktop-app) · [passkeys](https://proton.me/pass/passkeys).

Plattformangabe: Windows, macOS, Linux, Android, iOS; Browser. Offen: Biometrisches Entsperren, Eigener Speicher / eigener Server, Offline erstellen/ändern.

### NordPass

Offizielle Quellen: [main](https://nordpass.com/features/) · [offline](https://support.nordpass.com/hc/en-us/articles/360013952697-How-to-use-Offline-Mode).

Plattformangabe: Desktop/mobile; einzelne Betriebssysteme hier nicht vollständig belegt. Offen: Mobiles Autofill, Passwortexport, Dateien/Anhänge, Quelloffene App, Eigener Speicher / eigener Server.

Featureseite enthält Business-Funktionen; kein Anspruch auf Free-/Personal-Verfügbarkeit jeder Funktion.

### Dashlane

Offizielle Quellen: [main](https://www.dashlane.com/features) · [offline](https://support.dashlane.com/hc/en-us/articles/202625182-Can-I-access-Dashlane-offline) · [premium](https://support.dashlane.com/hc/en-us/articles/202699091-Dashlane-Premium-plan) · [browser](https://support.dashlane.com/hc/en-us/articles/115005432325-Dashlane-in-your-browser).

Plattformangabe: Browser-Webapp, Android, iOS. Offen: Passkeys fremder Dienste speichern/verwenden, Integrierte TOTP-Codes, Passwortexport, Biometrisches Entsperren, Dateien/Anhänge, Quelloffene App, Eigener Speicher / eigener Server, Offline erstellen/ändern.

### Keeper

Offizielle Quellen: [main](https://www.keepersecurity.com/features/) · [offline](https://www.keepersecurity.com/features/offline-mode/).

Plattformangabe: Desktop, Web/Browser, iOS, Android. Offen: Passwortimport, Passwortexport, Quelloffene App, Eigener Speicher / eigener Server.

### RoboForm

Offizielle Quellen: [main](https://www.roboform.com/features) · [forms](https://www.roboform.com/features).

Plattformangabe: Windows-App; weitere Desktop/mobile Browserangebote laut Featureübersicht. Offen: Mobiles Autofill, Biometrisches Entsperren, Dateien/Anhänge, Quelloffene App, Offline erstellen/ändern.

Modus ohne Sync ist explizit; keine Ableitung vollwertiger offline eingerichteter Erstnutzung.

### LastPass

Offizielle Quellen: [main](https://www.lastpass.com/features) · [offline](https://community.lastpass.com/kb/articles/71-fact-sheet-quick-helpdesk-guide-for-lastpass-business-admins).

Plattformangabe: Browsererweiterungen, Android, iOS; macOS/Windows-Installer. Offen: Integrierte TOTP-Codes, Passwortimport, Passwortexport, Passwort-/Breach-Prüfung, Biometrisches Entsperren, Dateien/Anhänge, Quelloffene App, Eigener Speicher / eigener Server, Offline erstellen/ändern.

Aktuelle offizielle Hilfeseite über Suchindex gelesen; direkter Fetch blieb JavaScript-Shell. Alte Blogtexte allein wurden nicht als heutige Schreibzusage übernommen.

### Zoho Vault

Offizielle Quellen: [main](https://www.zoho.com/vault/features.html) · [pricing](https://www.zoho.com/vault/pricing.html) · [offline](https://help.zoho.com/portal/en/kb/vault/user-guide/offline-access-and-backup/articles/vault-secure-password-access-offline) · [advanced](https://www.zoho.com/vault/features/advanced-password-management-features.html).

Plattformangabe: Web/Browser, iOS, Android; Desktop laut Preisseite. Offen: Passkeys fremder Dienste speichern/verwenden, Quelloffene App, Eigener Speicher / eigener Server, Offline erstellen/ändern.

Passkey zum Entsperren ist nicht automatisch Nachweis eines Passkey-Managers für fremde Websites. Indexierte englische Preisseite nennt Passkey-Speicherung; direkter deutscher Fetch nicht eindeutig: U.

### Sticky Password

Offizielle Quellen: [main](https://www.stickypassword.com/features) · [sharing](https://www.stickypassword.com/features).

Plattformangabe: Windows, macOS, Android, iOS; Chrome, Firefox, Safari und weitere. Offen: Mobiles Autofill, Passkeys fremder Dienste speichern/verwenden, Integrierte TOTP-Codes, Passwortexport, Dateien/Anhänge, Quelloffene App, Offline erstellen/ändern.

### SafeInCloud / Safe

Offizielle Quellen: [main](https://www.safe-in-cloud.com/en/) · [data](https://www.safe-in-cloud.com/en/features/your-data/).

Plattformangabe: Windows, macOS, Android, iOS; Chrome, Firefox, Edge, Safari. Offen: Quelloffene App.

### Google Password Manager

Offizielle Quellen: [main](https://passwords.google/) · [chrome](https://support.google.com/chrome/answer/95606?hl=en) · [transfer](https://support.google.com/chrome/answer/13068232?hl=en).

Plattformangabe: Chrome/Google-Ökosystem; Android und Chrome als iOS-Autofill-Anbieter. Offen: Integrierte TOTP-Codes, Dateien/Anhänge, Quelloffene App, Offline erstellen/ändern.

### Passbolt

Offizielle Quellen: [main](https://www.passbolt.com/) · [offline](https://www.passbolt.com/docs/user/advanced-features/offline-mode/).

Plattformangabe: Browsererweiterung, mobile und Desktop-Apps laut Anbieter. Offen: Passwortgenerator, Mobiles Autofill, Passkeys fremder Dienste speichern/verwenden, Passwortimport, Passwortexport, Passwort-/Breach-Prüfung, Biometrisches Entsperren, Dateien/Anhänge.

### Padloc

Offizielle Quellen: [main](https://padloc.app/).

Plattformangabe: Windows, macOS, Linux, iOS, Android; Chrome/Firefox. Offen: Passwortgenerator, Browser-Autofill, Mobiles Autofill, Passkeys fremder Dienste speichern/verwenden, Passwortimport, Passwortexport, Biometrisches Entsperren, Eigener Speicher / eigener Server, Offline lesen, Offline erstellen/ändern.

Erreichbare Herstellerseite bestätigt Angebot, aber aktive Wartung/Releasekadenz hier nicht verifiziert. Kein Urteil über heutige Produktqualität.

### Psono

Offizielle Quellen: [main](https://psono.com/) · [download](https://psono.com/download) · [offline](https://doc.psono.com/user/other/offline-mode.html).

Plattformangabe: Windows, macOS, Linux, Android, iOS; Chrome/Firefox/Edge; Safari laut Downloadseite nicht unterstützt. Offen: Integrierte TOTP-Codes, Passwortimport, Passwortexport, Passwort-/Breach-Prüfung, Biometrisches Entsperren, Dateien/Anhänge.

Generator in offizieller indexierter Startseite dokumentiert; dynamischer Direkt-Fetch blendet Tarifliste aus.

### Apple Passwords

Offizielle Quellen: [main](https://support.apple.com/guide/passwords/welcome/mac) · [keychain](https://support.apple.com/en-ie/109016) · [sharing](https://support.apple.com/en-ie/guide/iphone/iphe6b2b7043/ios).

Plattformangabe: Apple-Geräte; iCloud-Windows-Integration hier nicht separat geprüft. Offen: Passwortgenerator, Passwortimport, Passwortexport, Biometrisches Entsperren, Dateien/Anhänge, Quelloffene App, Offline erstellen/ändern.

## HeavenKey: Ausgangslage und Release-Grenzen

### Aktueller Produktstand 0.11.1

Die unten folgende 0.9-Tabelle ist der historische Ausgangsstand. Inzwischen sind bestätigtes Chromium-Autofill, verschlüsselte Formularprofile, F2-Schnellzugriff und die CSV-Importvorschau mit Duplikat- und Konfliktprüfung integriert. Die aktuelle [Bedienung](PASSWORD-MANAGER.md) und [Release-Abnahme](PASSWORD-MANAGER-VERIFICATION.md) nennen die Funktionen und Plattformgrenzen. Automatische Übernahme neuer Website-Logins, Firefox-Laufzeit, mobile Provider und Gerätesynchronisation bleiben getrennte offene Punkte. Die Anforderungen im hinteren Teil sind weiterhin der Zielkatalog; eine Teilfunktion ist keine vollständige Abnahme dieses Katalogs.

### Integrierte 0.9-Vorschau

Die nachstehende Recherche beschreibt den Ausgangspunkt. Die neue Version ergänzt einen eigenständigen lokalen Passwortmanager; die ausgeführten Prüfungen und Paketgrenzen stehen in [der Release-Abnahme](PASSWORD-MANAGER-VERIFICATION.md).

| Anforderung | Stand der Vorschau |
| --- | --- |
| Lokale Logins | CRUD, Suche, Tags, Favoriten und eine URL je Eintrag implementiert. Mehrere URLs je Eintrag fehlen. |
| Offline | Kein Konto und keine WAN-Verbindung für den lokalen Modus erforderlich. Der lokale Dienst muss zum Speichern laufen. TOTP funktioniert im entsperrten Browser auch bei gestopptem Netzwerkzugriff. |
| Sicherungen | Authentifizierte verschlüsselte Backups; bestätigter Restore im entsperrten und gesperrten Zustand. Kein Passwortreset ohne bekanntes Backup-Passwort. |
| Migration | Begrenzter Login-CSV-Import für gemeinsame Enpass-/Bitwarden-Spalten; ungültige Dateien werden atomar abgewiesen. Erneuter Import erzeugt dokumentiert Duplikate. Keine Mapping-Vorschau oder Passkey-Übernahme. |
| Generator/TOTP | CSPRNG-Generator und RFC-6238-Codes implementiert. Lokaler Sicherheitscheck erkennt Wiederverwendung und Länge unter 14 Zeichen; keine vollständige Stärkebewertung oder Datenleckprüfung. |
| Sperre/Clipboard | Inaktivitäts-, Hintergrund- und Seitenwechsel-Sperre; Clipboard-Bereinigung mit Browserberechtigung. Native biometrische Entsperrung fehlt. |
| Autofill/Mobil/Sync | Offen. Erweiterungen sind Launcher. Keine mobile Credential-Provider-App oder Gerätesynchronisation. |
| Agenten und Passkeys | Bestehendes Zugangslabor separat integriert; noch kein Zugriff auf echte Passwortmanager-Einträge und keine Website-Passkey-Verwaltung. |
| Veröffentlichung | Plattformpakete mit Quell-/Binärbindung und SHA256; Signierung, Notarisierung und externes Sicherheits-Audit bleiben offen. |

Diese Vorschau erfüllt einen Teil der folgenden Zielanforderungen. Die Tabelle ist kein vollständiger Enpass-Ersatz und kein Überlegenheitsnachweis.

Bezugsstand ist der zugewiesene Ausgangssnapshot und die einmal gelesene README in `/Users/master/Documents/Codex/work/heavenkey-password-manager-20261016`: WebAuthn-Anmeldung, mehrere Passkeys, SQLCipher, PRF-Notiztresor, Recovery, begrenzte Zugangsweitergabe, Agentenrechte und fünf Desktop-Paketziele sind beschrieben. Ein vollständiger Credential-Manager war beim Aufgabenstart nicht nachgewiesen. Parallel entstehender Code ist in diesem Bericht weder geprüft noch abgenommen. Diese Liste muss mit dem abschließenden integrierten Stand abgeglichen werden.

Ein Passkey, mit dem man sich bei HeavenKey anmeldet, macht HeavenKey noch nicht zum Anbieter von Passkeys für andere Websites. Ein Launcher in einer Browser-Erweiterung ist noch kein Autofill. SQLCipher schützt die Datenbank auf dem Datenträger; dies belegt weder browserseitige Geheimnisentkopplung noch einen gegen den lokalen Dienst geschützten Zero-Knowledge-Tresor. Fünf Desktop-Buildziele belegen keine mobile Credential-Provider-Integration.

Die folgenden Anforderungen sind eine Reihenfolge für Abnahme, keine Aussage über bereits implementierte Funktionen. Synthetische Daten verwenden; Erstnutzer, verlorenes Gerät, Serverausfall und beschädigte Datei müssen Teil der Abnahme sein.

| Rang | Release-Anforderung | Messbare Abnahme |
|---|---|---|
| P0.1 | Schlüssel- und Bedrohungsmodell | Jede persistierte Geheimnisart, jeder Schlüssel und jeder Entschlüsselungsort ist dokumentiert. Falscher Schlüssel, ungültiger Recovery-Code und manipulierter Ciphertext ergeben keinen Klartext. Kein fest eingebauter Schlüssel und kein Klartext in Log, URL, Exporttempdatei oder Browser-Storage. PRF-unfähige Geräte zeigen einen überprüften Fallback statt Datenverlust. |
| P0.2 | Vollständiger lokaler Credential-Tresor | Login, Benutzername, Passwort, mehrere URLs und Notiz lassen sich erstellen, suchen, ändern, kopieren und löschen. Sperren, Tabneuladen und Prozessneustart erhalten genau den bestätigten Zustand; gesperrt wird kein Geheimnis ausgeliefert. |
| P0.3 | Ehrlicher Offlinevertrag | Bei geblocktem WAN: kalter Neustart, Unlock, CRUD, Generator und lokaler Backup/Restore funktionieren. Bei gestopptem lokalen Dienst wird getrennt ausgewiesen, was noch funktioniert. Kein stiller Cloudzwang. Gleiche 1000 synthetische Einträge in Online-/Offline-Prüfung. |
| P0.4 | Sichere Migration und Ausstieg | Enpass-CSV plus generisches CSV mit 1000 Einträgen, Unicode, Quotes, Mehrzeilen, leeren und mehrfachen URLs importieren. Vorschau, Mapping, Duplikate und Fehlerzahlen stimmen. Ungültige Datei verändert nichts. Erneuter Import folgt dokumentierter Idempotenzregel. Export/Reimport erhält alle unterstützten Felder; verschlüsseltes Backup auf neuer Installation wiederherstellbar. |
| P0.5 | Alltagstaugliches, sicheres Browser-Autofill | Chrome/Edge und Firefox: Registrierung speichern, Login ausfüllen und Passwortänderung aktualisieren. Gleichnamige fremde Domain, Subdomaingrenze, HTTP-Downgrade, Iframe und manipuliertes Formular erhalten ohne passende Regel keinen Wert. Nutzerbestätigung und Undo; keine universelle Seiteninjektion. |
| P0.6 | Recovery, Sperre und Datenhaltbarkeit | Nach verlorener Passkey-Quelle aus unabhängiger Recoverykopie wiederherstellen. Recovery entwertet alte Schlüssel und Sitzungen wie dokumentiert. Kill während Speichern/Backup ergibt alten oder neuen konsistenten Stand; niemals halbe Einträge. Beschädigte Backups verändern den Tresor nicht. |
| P1.1 | Generator, TOTP und lokale Health-Prüfung | OS-CSPRNG verwenden; Länge/Zeichenregeln validieren. TOTP gegen RFC-6238-Vektoren einschließlich Zeitgrenzen; QR-Import nur für erlaubte Schemas. Wiederverwendung/schwache Passwörter lokal erkennen, ohne Passwörter an externe Dienste zu senden. |
| P1.2 | Native Entsperrung und Clipboard | Plattform-Keystore/Hello/Touch-ID-Integration je tatsächlich unterstütztem OS prüfen. Automatische Sperre bei Timeout und relevanten Lifecycle-Ereignissen. Clipboard wird nach konfiguriertem TTL nur gelöscht, wenn es noch den kopierten Wert enthält; nie fremden neu kopierten Text löschen. |
| P1.3 | Sichere Synchronisierung | Zwei Geräte offline ändern denselben Eintrag; Reconnect zeigt reproduzierbaren Konflikt statt stiller Überschreibung. Verschlüsselte Versionen, Tombstones, atomare Schreibweise, falscher Server und Wiederholung alter Daten testen. Optionales WLAN/WebDAV ist ein separates Lieferziel. |
| P1.4 | Wirkliche Passkey-Verwaltung | Auf mindestens zwei unabhängigen Test-RPs Passkey registrieren und anmelden. RP-ID/Origin/Challenge, User Verification, Widerruf und Wiederherstellung testen. OS-/Browser-/Providerintegration und Exportformat separat abnehmen; HeavenKey-Login zählt nicht dafür. |
| P1.5 | Mobile Alltagswege | Android-Credential-Provider und iOS-Autofill/Passkey-Provider auf realem Gerät: Suche, Unlock, App-/Web-Login, Fokuswechsel und Wiederkehr nach Sperre prüfen. Responsive Weboberfläche ist nur eine Teilabnahme. |
| P1.6 | Freigaben und begrenzte Agentenzugriffe | Zwei Besitzer/Gäste/Agenten mit synthetischen Konten: scopes, TTL, Weitergabekette, frische Zustimmung und Widerruf auch nach Neustart prüfen. Agent erhält nur den gewählten Eintrag/ausführbare Operation; kein gesamter Tresor. Bereits gelesene Passwörter lassen sich nicht zurückrufen; tatsächliche Credentialrotation separat durchführen. |
| P2 | Vertrauenswürdige Auslieferung | Signierte, prüfbare Pakete und Update-/Rollbackpfad; exakte Build-Hashes, SBOM/Lizenzen, Sicherheitskontakt und unabhängige Kryptografie-/Extensionprüfung vor breitem Einsatz mit echten Geheimnissen. Native Tests und Releaseassets je Plattform belegen, nicht aus einem Cross-Build ableiten. |

## Produktentscheidung

Zuerst einen vollständigen persönlichen Offline-Tresor mit sicherem Import, Recovery und Browser-Autofill abnehmen. Danach begrenzte Agentenoperationen an konkreten Zugangsdaten ergänzen. Wer bereits Enpass nutzt, braucht einen messbaren Wechselgrund: beispielsweise eine synthetisch nachgewiesene Aktion, die ein Agent mit einem einzelnen zeitlich begrenzten Recht ausführt, ohne den gesamten Tresor lesen zu können. Komfort, Sicherheit und Leistungsfähigkeit müssen mit identischem Aufgabenpaket und derselben Plattform verglichen werden.

Eine globale Aussage „besser als Enpass und 20 andere“ ist durch diese Quellen nicht gedeckt. Für einen späteren Vergleich: identischer Importbestand, gleiche Loginseiten, gleiche Offlinefehler, gleiche Recoveryaufgabe, gleiche Geräte; Erfolgsquote, Zeit bis erster nutzbarer Aktion, Datenverlust, Fehlbefüllung und Wiederherstellungsdauer messen. Hardware-, Installations- und reale Nutzerabnahme bleiben eigenständige Nachweise.

## Recherchegrenzen

Die Breite von 21 Produkten liefert eine Anforderungsbasis, keine vollständige Sicherheitsprüfung. Ungeklärte Zellen sind sichtbar. Kein Accountkauf, keine bezahlte API, keine Kontaktaufnahme, keine Veröffentlichung. Buttercup wurde wegen einer heute nur als Maintenance-Seite erreichbaren Website nicht in die 21 aufgenommen; Google Password Manager ersetzt es. Padloc ist erreichbar, aktuelle Wartung bleibt unbestätigt. Siehe [TOOL-USAGE.md](PASSWORD-MANAGER-RESEARCH-TOOLS.md) für Abrufe, Fallbacks und erfolglose Donorsuche.
