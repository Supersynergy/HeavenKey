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

## Aufgabenorientierter Einstieg (0.30)

Im Erweiterungsfenster führen **Anmelden**, **Formular**, **Neues Passwort** und
**Verwalten** direkt zu den passenden Einträgen. Logins anderer Herkünfte sind
standardmäßig ausgeblendet; „Logins anderer Websites anzeigen“ bzw. „Verwalten“
macht sie bewusst zugänglich. Das erweitert keine Füllberechtigung.

Der Schlüssel priorisiert am neuen Passwortfeld den Generator und an Kontakt-
und Adressfeldern das Profil. Das Menü lässt sich mit Pfeiltasten sowie Home/End
bedienen; Escape schließt es und gibt den Fokus an den Schlüssel zurück.

Die Anzeige führt durch Auswahl → Prüfung → Freigabe. Vor dem Füllen zeigt sie
Anzahl, Geheimnisse, Überschreibregel und „kein Absenden“. Die Anzahl ist die
Auswahl, keine Garantie, dass jedes Feld gefüllt werden kann: fehlende Freigaben,
zwischenzeitlich befüllte Werte und Sicherheitsregeln können Felder auslassen.

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
angeklicktes Feld begrenzt Prüfung und Füllung auf seine Formulargruppe; ein
abgelaufener Klick wechselt nicht still zu einem anderen Formular. Neue Passwortfelder
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


Eigene Antragsfelder lassen sich im Profil-Entwurf mit einem verständlichen Feldnamen ergänzen.
HeavenKey speichert sie als begrenzte `custom_…`-Schlüssel im selben verschlüsselten Tresor.
Sie werden nicht automatisch erraten oder aus fremden Texten übernommen; die Zuordnung erfolgt
durch den blinden Auftrag oder manuell und bleibt wie jede andere Füllung freigabepflichtig. Weil HeavenKey
den Inhalt eigener Felder nicht einordnen kann, gelten sie vorsorglich als sensibel und benötigen die zusätzliche
Finanz-/Identitätsfreigabe.
Ältere HeavenKey-Versionen können solche Profile nicht lesen und müssen fail-closed ablehnen.

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


## Blinder Agentenauftrag für Formulare (0.31)

Die Erweiterung kann nach einer manuellen Feldprüfung einen **blinden Scan** als
sichtbaren JSON-Text bereitstellen. Er enthält Scan- und Feld-IDs, Feldbezeichnungen,
erkannte Feldtypen, Sensitivitätsmarkierungen, Feldlängen sowie Formularmethode und
Herkunftsziele. Er enthält keine Profilwerte, Klartextdaten, Cookies, Screenshots oder
sonstigen Seiteninhalte. Verfügbare Profilfeldtypen werden nur soweit angezeigt, wie sie
zu erkannten Feldern dieses Scans gehören. Zusätzlich erscheinen vom Betreuer ausdrücklich
angelegte eigene Feldtypen (`custom_…`), damit nicht standardisierte Behörden-, Vereins- und
Fachformularfelder überhaupt automatisiert zugeordnet werden können; auch dann sieht der
Agent nur den technischen Feldnamen und niemals den Wert.

Ein lokales Werkzeug oder ein Agent kann daraus einen ebenfalls wertefreien
**blinden Auftrag** erzeugen: Feld-ID → Profilfeldtyp plus Freigabeoptionen. Der mitgelieferte
Referenzplaner `bun scripts/blind_form_job.ts scan.json > job.json` nutzt nur diese Metadaten,
hat keinen Tresorzugriff und kann mit `--map FIELD_ID=ENTITY` ein neutrales Feld manuell
zuordnen sowie mit `--submit` das separate Absenden anfragen. Der Auftrag
wird in der Erweiterung eingefügt, strikt gegen Scan-ID, vollständige Adresse und Herkunft
geprüft und übernimmt nur die Zuordnung in der Oberfläche. Angefragte Sonderfreigaben für sensible Werte, Geheimnisse, Überschreiben oder Auswahlfelder werden nicht vormarkiert. Der Auftrag füllt nicht automatisch.
Die Besitzerin oder der Besitzer prüft die sichtbare Zuordnung, bestätigt die Zielherkunft
und startet das Füllen selbst. Änderungen an Seite, Feld, Formular oder Formularziel
machen den Auftrag unbrauchbar.

## Vermittelter Agentenauftrag ohne Kopieren (0.32)

Zusätzlich zum sichtbaren Kopierweg kann die lokale Vermittlung (form relay) denselben
wertefreien Austausch automatisch transportieren. Die Besitzerin oder der Besitzer erzeugt
in HeavenKey wie bei der Browserkopplung einen Einmal-Code und meldet das Agentenwerkzeug
einmalig an: `bun scripts/blind_form_agent.ts enroll CODE`. Der Agent erhält ein eigenes,
widerrufliches **Vermittlungs**-Zugangstoken. Dieses Token berechtigt ausschließlich zum
Lesen des neuesten Scans und zum Einreichen von Aufträgen — niemals zum Tresor, zu
Profilwerten, zu Kopplungsverwaltung oder zu sonstigen Endpunkten.

Nach der manuellen Feldprüfung überträgt die Erweiterung den blinden Scan an den lokalen
Dienst; der Agent holt ihn mit `scan` ab oder erzeugt und reicht den Auftrag in einem
Schritt mit `bun scripts/blind_form_agent.ts auto` ein (Optionen wie `--submit`,
`--overwrite`, `--no-choices`, `--map FIELD_ID=ENTITY` entsprechen dem Referenzplaner).
Scans und Aufträge liegen nur flüchtig im Speicher des Dienstes, sind an Scan-ID und die
publishierende Erweiterung gebunden und überleben keinen Neustart. Die Abnahmepflichten
bleiben unverändert: Die Erweiterung zeigt den eingegangenen Auftrag nur als Vorauswahl,
sämtliche Sonderfreigaben bleiben unmarkiert und die Besitzerin oder der Besitzer bestätigt
Zuordnung, Herkunft und Füllen selbst. Der sichtbare Kopierweg bleibt als Ausweichweg
bestehen. Mehrstufige Anträge werden als Folge einzelner Seiten bearbeitet: Scan, Auftrag,
Bestätigung und gebundenes Absenden je Schritt, danach die nächste Seite.

Füllen und Absenden bleiben getrennte Risiken. Ein Auftrag kann einmaliges Absenden nur
anfragen. Zusätzlich zur normalen Herkunftsbestätigung ist eine eigene Absende-Freigabe
nötig. Die erste Version löst Absenden ausschließlich bei genau einem zusammenhängenden
HTML-POST-Formular mit genau einem sichtbaren Absende-Button aus, dessen sämtliche Ziele auf derselben Herkunft bleiben. GET-Formulare,
mehrere Formulare, formularlose Schaltflächen, Zahlungen, Einwilligungen und fremde oder
geänderte Ziele bleiben gesperrt. `requestSubmit` wird höchstens einmal ausgelöst. Ob der
Server den Antrag annimmt, kann HeavenKey nicht sehen; das Ergebnis muss auf der Website
oder beim Empfänger geprüft werden.

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
  die Nutzung einer veralteten Vorschau. Auch Formularzuordnung, Zieladresse und
  Feldlänge bleiben an die Vorschau gebunden. Klick und Vorschau gelten je höchstens
  zwei Minuten; eine Vorschau kann nur einmal verwendet werden. Die Sitzung sperrt
  weiterhin nach zwei Minuten Inaktivität.
- Passwort und OTP werden nicht in ein Formular mit abweichender Zielherkunft
  eingefügt. Das umfasst alternative `formaction`-Ziele, auch an extern zugeordneten
  Absende-Buttons. Bei legitimen Formularen mit einem anderen Anmeldeserver ist
  deshalb manuelle Eingabe erforderlich.
- Vor jedem einzelnen Schreibvorgang werden Zustand, Kontext und vorhandener Wert
  erneut geprüft. Ereignisbehandler eines vorherigen Feldes können eine spätere
  Eingabe nicht still überschreiben lassen. Nur ausgewählte und freigegebene
  Quellwerte werden an den isolierten Formularcode übergeben.
- Die Website kann absichtlich eingefügte Werte wie manuell eingegebene Werte
  lesen. Es wird kein Formular automatisch abgesendet und keine Zahlung bestätigt.

Vergleich und Funktionskarte: [zehn Referenzprodukte](AUTOFILL-COMPETITORS.md).
Release- und Signierungsstatus: [0.30](releases/0.30.0.md). Interner Review: [Sicherheit und Priorisierung](REVIEW-0.30.md).
