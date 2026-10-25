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

Der Freigabedialog startet ohne ausgewähltes Konto. Die Zustimmung bleibt zunächst offen.

`native-macos.png`: reales AppKit/WebKit-Fenster des 0.20-Builds auf macOS, eigener synthetischer Testtresor unter Port 18243. Der Login wurde in einer früheren lokalen Ausgabe angelegt und im aktualisierten Build entsperrt; keine echten Zugangsdaten.

## Android ohne Desktop (unveröffentlichter Quellstand)

`android-standalone-start.png`, `android-standalone-vault.png`,
`android-standalone-editor.png`, `android-standalone-passkeys.png` und
`android-standalone-dark.png` zeigen die tatsächlichen Flutter-Widgets bei
390 × 844 logischen Pixeln und zweifacher Renderauflösung. Gerendert mit Flutter
3.47.2/Dart 3.13.2 und den mit Flutter gelieferten Roboto- und Material-Icon-Schriften.
Alle Einträge und Geräteantworten sind synthetische Testdaten. Dies sind
Widget-Renders, keine Bildschirmaufnahmen eines physischen Android-Geräts und
kein Nachweis nativer Anmeldung oder Wiederherstellung. Der Editor verdeckt
Passwörter. Der vorhandene Release 0.26 enthält dieses Design noch nicht.
