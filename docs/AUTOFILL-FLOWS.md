# Schlüssel, Passwörter und Formulare

## Browser: einmal einrichten

1. Lokalen HeavenKey-Passwortmanager starten, Tresor erstellen bzw. entsperren.
2. Chromium- oder Firefox-Erweiterung laden und mit einem einmaligen Code koppeln.
3. Auf einer HTTPS-Website die Erweiterung öffnen und **Schlüssel auf dieser
   Website aktivieren** wählen. Die Browserfreigabe gilt für den ausgewählten
   Host. HeavenKey bindet seine Aktivierung zusätzlich an die genaue Herkunft
   einschließlich Port; verschiedene Ports werden separat aktiviert.
4. Der kleine Schlüssel erscheint an sichtbaren Login-, Kontakt- und Adressfeldern.
   Bei dynamischen Formularen, Größenänderungen und offenen Shadow-Roots wird die
   Position aktualisiert. Ausgeschlossene, deaktivierte und unsichtbare Felder
   erhalten keinen Schlüssel. `autocomplete="off"` bleibt respektiert.

Das Webseiten-Menü enthält nur vier feste Aktionen. Weder Passwortwerte noch
Profilnamen werden darin angezeigt. Ein Klick öffnet das vertrauenswürdige
Erweiterungsfenster; Entsperrung und Auswahl finden dort statt.

## Prozesskarte: Anmeldung und Kontaktformular

```mermaid
flowchart TD
  A["Schlüssel anklicken"] --> B{ "Welche Angaben?" }
  B --> C["Login wählen"]
  B --> D["Privates oder geschäftliches Profil"]
  C --> E["Tresor lokal entsperren"]
  D --> E
  E --> F["Eintrag und Felder auswählen"]
  F --> G{ "Website und Auswahl bestätigt?" }
  G -->|Ja| H["Gewählte Felder füllen"]
  G -->|Nein| F
  H --> I["Selbst absenden oder rückgängig"]
```

Logins verlangen eine exakte Übereinstimmung von Schema, Host und Port. Ein
angeklicktes Feld grenzt die Vorwahl auf sein Formular ein. Neue Passwortfelder
erhalten keine bestehenden Login-Passwörter. Einmalcodes werden bei Vorschau und
Freigabe frisch berechnet. Bereits eingegebene Werte bleiben standardmäßig stehen.
Finanz- und Identitätswerte benötigen ihre zusätzliche ausdrückliche Freigabe.

## Prozesskarte: neues Konto oder Passwortwechsel

```mermaid
flowchart TD
  A["Neues Passwort generieren"] --> B["Länge oder sechs Wörter wählen"]
  B --> C["Benutzername und Website prüfen"]
  C --> D{ "Bestehender Login?" }
  D -->|Ja| E["Ersetzen ausdrücklich bestätigen"]
  D -->|Nein| F["Neuen Login verschlüsseln"]
  E --> G["Bisheriges Passwort zusätzlich behalten"]
  G --> F
  F --> H["Neue Passwortfelder prüfen"]
  H --> I["Website bestätigen und füllen"]
  I --> J["Änderung auf Website selbst abschließen"]
```

Der Generator verwendet kryptografischen Zufall, keine KI. Zufallspasswörter
enthalten alle ausgewählten Zeichengruppen und vermeiden leicht verwechselbare
Zeichen. Sechs zufällige EFF-Wörter liefern rund 77,5 Bit Auswahlentropie; Wörter
werden durch Punkte getrennt, interne Bindestriche aus der Originalwortliste
bleiben erhalten. Eine selbst formulierte Phrase hat diese Garantie nicht.

Feldlimits unter 14 Zeichen werden nicht durch ein kürzeres Generatorpasswort
umgangen. Zu lange Passphrasen werden mit einer Fehlermeldung abgelehnt. Neue
Passwörter gelangen ausschließlich in ausdrücklich als `new-password`
gekennzeichnete Felder. Bei unklaren Registrierungsfeldern kann der Login trotzdem
gespeichert und anschließend in HeavenKey verwaltet werden.

## Verwaltung und Android

**Passwörter verwalten** öffnet die lokale Tresoroberfläche. In der Erweiterung
können Logins direkt angelegt oder nach zusätzlicher Bestätigung aktualisiert
werden. **Neues Formularprofil** bietet Name, E-Mail, Telefon, Firma und Adresse.
Speichern übernimmt den vorhandenen KDF und nutzt den aktuellen Tresorstand mit
Konfliktprüfung; ein Speicherkonflikt sperrt die Sitzung.

Android nutzt die System-Autofill-Schnittstelle. Unter **Autofill →
Formularprofile** führen **Privates Profil** und **Geschäftliches Profil** direkt
in einen passend benannten Editor. Das Formular wird weiterhin nach Auswahl
ausgefüllt; neue Passwörter und Passphrasen lassen sich im bestehenden nativen
Registrierungsablauf erzeugen und sichern. Ein Browser-Feldsymbol ist eine
Funktion der Desktop-Erweiterungen, kein Bildschirm-Overlay über Android-Apps.

## Schutz und Grenzen

- Website-Schlüssel lassen sich in der Erweiterung wieder deaktivieren.
  Browserrechte werden separat über die Website-Rechte des Browsers widerrufen.
- Browser-Match-Patterns können Ports nicht einzeln einschränken. Der wertfreie
  UI-Code kann deshalb auf demselben Host in einem anderen Port starten, blendet
  sich dort jedoch ohne exakte Aktivierung aus. Passwortfüllungen prüfen die
  exakte Herkunft unabhängig davon erneut.
- Keine neuen `host_permissions` im Installationsmanifest, keine automatische
  Aktivierung aller Websites, keine Nachrichten von externen Websites.
- Dynamische Skripte betreffen nur ausdrücklich aktivierte Websites und nur den
  obersten Frame. Bis zu 32 Herkunftsfreigaben, 60 sichtbare Schlüssel, 200
  geprüfte Eingabefelder pro Aktualisierung begrenzen den Aufwand.
- Seitenwechsel, ersetzte Felder, geänderte Feldidentität und Sperren verhindern
  die Nutzung einer veralteten Vorschau. Die maximale Sitzung ist weiterhin
  zwei Minuten Inaktivität.
- Die Website kann absichtlich eingefügte Werte wie manuell eingegebene Werte
  lesen. Es wird kein Formular automatisch abgesendet und keine Zahlung bestätigt.

Vergleich und Funktionskarte: [zehn Referenzprodukte](AUTOFILL-COMPETITORS.md).
Release- und Signierungsstatus: [0.29](releases/0.29.0.md).
