# Produktbilder

Diese Screenshots wurden am 17. Oktober 2026 aus der laufenden HeavenKey-App mit einem eigenen temporären Datenordner aufgenommen. Sie zeigen keine zusammengesetzten Entwürfe. Alle Logins und Kontaktangaben sind erfundene Beispieldaten; es wurden keine echten Konten importiert oder externe Websites kontaktiert.

| Datei | Gezeigter Ablauf |
| --- | --- |
| `vault-desktop.png` | Entsperrter Tresor im hellen Design; Passwort verdeckt. |
| `vault-dark.png` | Derselbe Tresor im dunklen Design. |
| `quick-access.png` | F2-Schnellzugriff mit einer Suchanfrage. |
| `import-preview.png` | Neue CSV-Zeile sowie identisches Duplikat und Konflikt; anschließend ohne Speicherung abgebrochen. |
| `form-profile.png` | Editor eines verschlüsselten Formularprofils mit Beispieldaten. |
| `vault-mobile.png` | Responsive Browseransicht bei 390 Pixeln; keine native mobile App. |
| `vault-locked.png` | Gesperrter Tresor mit dem ursprünglichen Schlüssel-und-Himmelstor-Motiv. |
| `vault-locked-dark.png` | Derselbe Sperrbildschirm im dunklen Design. |
| `onboarding.png` | Erster Start mit Einrichtung und direkter Wiederherstellung. |
| `onboarding-guide.png` | Einrichtungsassistent im leeren Tresor. |
| `passkey-settings.png` | Lokaler Passkey nach erfolgreicher virtueller PRF-Registrierung. |
| `timed-share.png` | Ausdrückliche Auswahl eines Feldes und einer Laufzeit. |
| `timed-share-dark.png` | Dieselbe Freigabemaske im dunklen Design. |
| `recipient.png` | Empfängeransicht nach WebAuthn-Verifikation; ausschließlich freigegebenes Beispielfeld. |
| `recipient-dark.png` | Empfängeransicht im dunklen Design. |
| `broker-approval-dark.png` | Echte Broker-Anfrage mit ausdrücklicher Login-Auswahl und Zustimmung. |
| `broker-approval-mobile.png` | Dieselbe Freigabe bei 390 Pixeln, mit sichtbarer Schutzgrenze. |

Die Bilddateien sind unbearbeitete Browseraufnahmen. Sie belegen die abgebildete Ansicht, aber keine Abnahme echter Passkeys, nativer Windows- oder Mobilgeräte. Ausgeführte Funktionsprüfungen sind getrennt in der Release-Abnahme dokumentiert. Die früheren generierten Markenbilder bleiben unter `docs/assets/` mit ihrer eigenen Herkunftsbeschreibung erhalten.

## Festgelegte Bilder der Installationsanleitung 0.12.0

Die [Installationsanleitung](../INSTALLATION.md) verwendet `onboarding.png`, `onboarding-guide.png` und `timed-share.png` unverändert aus Tag `v0.12.0`. Diese Dateien waren beim Dokumentationsabgleich auch auf `main` bytegleich. `installation-v012-passkey-settings.png` ist eine unveränderte Kopie von `passkey-settings.png` aus diesem Tag, bevor die allgemeine Bilddatei auf `main` für 0.13.0 erneuert wurde. Sie zeigt die Browserkopplung und einen mit virtuellem WebAuthn-Gerät eingerichteten PRF-Passkey.

Diese Bilder wurden für die Dokumentationsänderung **nicht neu aufgenommen**. Dateihashes, Git-Blob-IDs und Quellcommit stehen im [Prüfprotokoll](../INSTALLATION-VERIFICATION.md). Die ergänzenden [SVGs](../images/README.md) sind ausdrücklich schematische Abläufe. Es gibt hier keine neuen Screenshots von Gatekeeper, SmartScreen, Chrome-/Firefox-Installation, dem nativen Berechtigungsdialog oder dem Autofill-Popup.

Der Freigabedialog startet ohne ausgewähltes Konto. Die Zustimmung bleibt zunächst offen.

