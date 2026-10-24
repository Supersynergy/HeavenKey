# Installationsanleitung 0.12.0 · Herkunft und Prüfstatus

Stand: 17. Oktober 2026. Dieses Protokoll gehört zur [bebilderten Installationsanleitung](INSTALLATION.md). Es dokumentiert eine **Dokumentationsprüfung**, keine neue Release-, Browser- oder Hardware-Abnahme.

## Festgelegte Quellen

- [Release v0.12.0](https://github.com/Supersynergy/HeavenKey/releases/tag/v0.12.0), veröffentlicht **2026-10-17 13:27:17 UTC**, Release-ID `415818054`.
- Quellstand des Releases: [`dfcd8b025dc05cb692c8ce843701a552a614d40a`](https://github.com/Supersynergy/HeavenKey/tree/dfcd8b025dc05cb692c8ce843701a552a614d40a).
- Abgleich mit `main` bei [`7773b0e0d6e3d57047f9dd42ea795dd264dcf0ea`](https://github.com/Supersynergy/HeavenKey/tree/7773b0e0d6e3d57047f9dd42ea795dd264dcf0ea). `main` enthielt bereits 0.13.0. Dessen Versionsangaben und Agenten-Broker bleiben erhalten; die Installationsanleitung und ihr Downloadlink sind ausdrücklich auf 0.12.0 festgelegt.
- [Paketierung](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/scripts/package_release.py), [Erweiterungsmanifest-Erzeugung](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/scripts/build_extension.ts), [Quellstarter](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/scripts/first_run.py), [CLI](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/apps/api/src/desktop.rs).
- [Tresoroberfläche](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/apps/web/passwords.html), [Einrichtung](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/apps/web/src/passwords-onboarding.ts), [Kopplung und Profile](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/apps/web/src/passwords-workflows.ts), [Passkeys](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/apps/web/src/passwords-access.ts), [Freigaben](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/apps/web/src/passwords-sharing.ts).
- [Popup](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/apps/extension/popup.html), [Kopplung und Autofill](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/apps/extension/smart-popup.ts), [Betriebsgrenzen](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/docs/ACCESS-AND-SHARING.md).

Die Repository-Metadaten bestätigen den privaten Zugriff. Release- und Dateimetadaten wurden über die berechtigte GitHub-Verbindung gelesen. Eine normale anonyme Git-Kopie war nicht möglich. Für die Bearbeitung wurden die benötigten Dateien versionsgebunden gelesen; es wurde kein vollständiger frischer Clone oder Paketdownload vorgetäuscht.

## Tatsächliche App-Bilder

Die folgenden PNGs wurden aus Tag v0.12.0 abgerufen, unverändert dekodiert und visuell geprüft. Die damalige [Bildherkunft](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/docs/screenshots/README.md) beschreibt Aufnahmen der laufenden App vom 17. Oktober mit separatem temporärem Datenordner und ausschließlich synthetischen Daten. **Für diese Dokumentationsänderung wurden keine neuen App-Screenshots aufgenommen.**

| Verwendung / Datei unter `docs/screenshots/` | Git-Blob im Release | SHA-256 der PNG-Datei |
| --- | --- | --- |
| Erster Start: `onboarding.png` | `f0e0e2583bad3af601e22e42bebc7b9d028649b2` | `13be667371cfc61b32d6834784b02d3ae7bab8e218233faa02499a91434f2799` |
| Sicherungs-Einstieg: `onboarding-guide.png` | `fb3db64d6480716d1938f58130f05ca86bd21638` | `cba7aa641136b355c11d79be5285819bb34bb1fa96efdf7f8e15066a8308bdde` |
| Kopplung und virtueller PRF-Passkey: `installation-v012-passkey-settings.png` | `b5ddcfcf8595acaf1b0f54349a5b7febbc26a0ab` | `b5758a2d1889e26d83a147035ba063ff5b97560a14e9b8a8bae710d22c826c77` |
| Feldauswahl beim Teilen: `timed-share.png` | `df4020de8bdf4ce6ee9e81de09e2f1c9a06a0ae2` | `dcbfc5d4959d9188d4d5c8de388e723796ce92bba7ba66f7ec36f54681eeb750` |

Die separate Passkey-Datei ist eine bytegleiche Kopie von `docs/screenshots/passkey-settings.png` **aus v0.12.0**. Die allgemeine Datei auf `main` war bereits für 0.13.0 erneuert worden und wurde nicht zurückgesetzt. Die anderen drei Dateien waren auf beiden geprüften Ständen identisch. Bildbeschriftungen nennen ausdrücklich die virtuelle WebAuthn-Prüfung; die Aufnahme eines aktiven Passkeys ist kein Nachweis physischer Hardware.

Die [SVGs und ihr Generator](images/README.md) sind schematische Illustrationen. Der Generator wurde ausgeführt, seine Ausgabe auf Wiederholbarkeit geprüft und die Installationsgrafiken wurden gerendert und visuell kontrolliert. Kopplung und Autofill werden als Ablaufkarten dargestellt. Native Berechtigungsdialoge wurden weder nachgebaut noch als Screenshots ausgegeben. Die Laborillustrationen bleiben getrennt gekennzeichnet.

## Geprüfte Inhalte

| Prüfung | Ergebnis / Aussagegrenze |
| --- | --- |
| Release-Assets und Dateinamen | Fünf Desktop-Archive, zwei Erweiterungs-ZIPs, `SHA256SUMS` und `ACCEPTANCE.json` im tatsächlichen v0.12.0-Release vorhanden. Namen gegen Paketierung abgeglichen. |
| Starter und Standardmodus | Paketstarter ergänzen `--password-manager --open`; direkter Programmaufruf ohne diesen Modusschalter startet das Labor. Quellassistent benötigt dafür ausdrücklich `--lab`. |
| Tresor und Sicherung | Feld- und Buttontexte gegen Oberfläche und Handler geprüft; 14–1024 Zeichen, Exportname `heavenkey-password-vault.json`, Wiederherstellungswege getrennt beschrieben. Kein Restore in echte Nutzerdaten ausgeführt. |
| Browsermanifest | `activeTab`, `scripting`, `storage`, `contextMenus`; optionale Hostfreigabe `http://localhost/*`; Chrome mindestens 120, Firefox mindestens 140. Kein permanentes `host_permissions`, kein `<all_urls>`, keine automatischen `content_scripts`, kein Native Messaging. |
| Kopplung | Code: einmalig, 120 Sekunden. Native Berechtigungsanforderung im bewussten Verbindungsaufruf. Eigener gespeicherter Token; nach Dienstneustart neue Kopplung. Popup benötigt Masterpasswort und sperrt nach Schließen oder zwei Minuten Inaktivität. |
| Autofill | HTTPS beziehungsweise lokales HTTP, exakte Login-Origin, ausgewählte Felder, zusätzliche Geheimnis-/Sensitivfreigaben, erneute Origin-Bestätigung, kein Absenden, Rückgängig höchstens zwei Minuten auf unveränderter Seite. Anhand des Codes geprüft. |
| Passkey / Teilen | Zwei Einrichtungsprüfungen und PRF-Voraussetzung; Masterpasswort-Rückweg; kein PRF-Entsperren im Erweiterungspopup. Empfänger-Passkey und lokaler/öffentlicher Freigabebetrieb getrennt erklärt. |
| Interne Links und Bilder | Ziele gegen den gelesenen Repository-Baum und die neuen Dateien geprüft; Markdown-Abschnittsanker mitgeprüft. |
| Externe Anleitungen | Apple Gatekeeper, Microsoft SmartScreen/Get-FileHash, Chrome entpacktes Laden/activeTab/Permissions sowie Mozilla temporäres Laden/Signierung anhand offizieller Seiten geprüft. Private GitHub-Quellen über die berechtigte Verbindung gelesen. |
| Quellassistent | `python3 scripts/first_run.py --help` ausgeführt. `--check-only` meldet fehlende Werkzeuge `cargo` und `bun`; kein Build gestartet. |

Ein maschinenlesbarer [Dokumentationsprüfbericht](evidence/installation-v012-review.json) enthält die Dateihashes und die tatsächlich ausgeführten statischen Prüfungen. Er ist **kein** Ersatz für `ACCEPTANCE.json` des Releases und macht keine Aussage über neu ausgeführte Produktregressionen.

## Offen: echte Installation und Laufzeit

Die Umgebung dieser Dokumentationsänderung stellt weder macOS noch Windows, Rust/Bun/`just` oder eine installierte lokale Chromium-/Firefox-Binärdatei bereit. `just check` und `just e2e` konnten deshalb nicht ausgeführt werden (`just: command not found`). Auch die Release-Archive wurden hier nicht binär heruntergeladen und neu gehasht. Die in der Anleitung genannten SHA-256-Schritte muss der Empfänger auf seinen heruntergeladenen Dateien ausführen.

| Noch auszuführen | Konkrete Abnahme |
| --- | --- |
| Frischer macOS-Start | Berechtigter Download, SHA-256, Finder-Entpacken, Einzel-Freigabe beider ggf. blockierter Dateien, Starter, Tresor, Sicherung und Test-Restore; Apple Silicon und physischer Intel-Mac getrennt. |
| Frischer Windows-x64-Start | Download/Hash, Explorer-Entpacken, konkreter SmartScreen-/Smart-App-Control-Fall, Starter, Tresor, Sicherung und Test-Restore; Wine ersetzt dies nicht. |
| Chrome / Edge mit ausgeliefertem Manifest | Entpacktes Laden, **nativen optionalen localhost-Dialog** ablehnen und annehmen, Kopplung, Popup-Masterpasswort, Seiten- und Feldauswahl, Geheimnisfreigabe, Füllen/Rückgängig, Sperren/Widerruf und Dienstneustart. Die frühere Headless-Prüfung mit fester Test-Hostfreigabe deckt den nativen Dialog nicht ab. |
| Firefox ab 140 | Temporäre Installation, nativer Berechtigungsdialog, sämtliche Kopplungs-/Autofill-Schritte und erneutes Laden nach Firefox-Neustart. Eine historische temporäre Installation aus 0.7 ist kein 0.12.0-Laufzeitnachweis. |
| Physische Passkeys | Je konkrete OS-/Browser-/Authenticator-Kombination: Erstellung, PRF, Benutzerverifikation, Abbruch, Sperren/Entsperren und Masterpasswort-Rückweg. Touch ID und Windows Hello hier nicht abgenommen. |
| Geräteübergreifende Freigabe | Eigener erreichbarer HTTPS-Host mit gültigem TLS und `HEAVENKEY_SHARE_ORIGIN`, unveränderte Host-/Origin-Weitergabe, nur erlaubte Empfängerpfade, Abruf von zweitem Gerät, Passkey-Bindung, Ablauf/Widerruf und Erreichbarkeit bei Dienststopp. Kein öffentliches Hosting eingerichtet. |

Die ursprünglichen Release-Nachweise sind in der [versionsgebundenen 0.12.0-Abnahme](https://github.com/Supersynergy/HeavenKey/blob/v0.12.0/docs/PASSWORD-MANAGER-VERIFICATION.md) beschrieben: natives Apple Silicon, Intel unter Rosetta, Windows unter Wine und Linux x64 unter QEMU sind unterschiedliche Aussagen. Ihre Wiederholung wird mit dieser Dokumentationsänderung nicht behauptet.
