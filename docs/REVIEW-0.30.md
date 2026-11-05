# HeavenKey 0.30: interner Red-Team-Review und Produktpriorisierung

Stand: 5. November 2026. Interner Quellcode- und Regressionstest, kein unabhängiges
Audit und keine Behauptung vollständiger Sicherheit. Ausschließlich synthetische
Konten, lokale Testseiten und wegwerfbare Browser-/Android-Testumgebungen.

## Ziele und Schutzbedingungen

Die Willenshierarchie wird hier als Produktheuristik angewandt: gewünschter
Fortschritt → persönliche Bedeutung → Schutzbedingungen → nachvollziehbarer
nächster Schritt → ausdrückliche Entscheidung → sichtbares Ergebnis. Das ist
keine empirisch bewiesene psychologische Formel.

| Gewünschtes Ergebnis | Übergeordnetes Schutzbedürfnis | Umsetzung |
| --- | --- | --- |
| Schnell anmelden | Das richtige Konto nur der richtigen Seite geben | Aufgabe Anmelden, genaue Herkunft, fremde Logins erst auf Wunsch |
| Neues Passwort | Den bisherigen Zugang nicht verlieren | Vorher verschlüsselt speichern; vorheriges Passwort auch bei manueller Änderung behalten |
| Namen und Adresse ausfüllen | Keine unnötigen persönlichen Angaben abgeben | Profilwahl, einzelne Felder, minimierter Übertragungsinhalt |
| Schnell fertig werden | Änderungen verstehen und kontrollieren | Auswahl → Prüfung → Freigabe; Anzahl und Überschreibregel vor dem Füllen |
| Fehler korrigieren | Bereits geleistete Eingaben erhalten | Nicht überschreiben als Standard, Rückgängig, erneute Prüfung bei Änderungen |

Die erwartete Erleichterung schafft Anziehung. Unerwartete Freigaben, Datenverlust
und unklare Zustände schaffen Abwehr. Vertrauen wird durch begrenzte Befugnisse
und überprüfbare Ergebnisse unterstützt. Sicherheitsrelevante Zustimmungen werden
deshalb nicht für eine niedrigere Klickzahl entfernt.

## Sweetspot-Priorisierung

Optimiert wird der Aufwand je **korrekt abgeschlossenem und ausdrücklich
freigegebenem Vorgang**, einschließlich Prüfung und möglicher Nacharbeit.
Herkunftsbindung, Verschlüsselung und Schutz vor ungewollter Weitergabe sind
Mindestbedingungen. Nutzen und Aufwand unten sind begründete Einschätzungen;
es gibt noch keine gemessene Zeitersparnis oder echte Nutzer-Conversion.

| Reihenfolge | Verbesserung | Erwarteter Nutzen | Aufwand / Grenze |
| --- | --- | --- | --- |
| 1 | Vorschau an Feld, Formularziel und Ablaufzeit binden | Verhindert alte oder umgelenkte Freigaben | Moderat; legitime Cross-Origin-Loginformulare brauchen manuelle Eingabe |
| 2 | Nur gewählte und freigegebene Werte übertragen | Weniger Klartext im Content-Script-Kontext | Klein; gleiche Einzelfeldfreigaben bleiben erforderlich |
| 3 | Jeden Browser-Passwortwechsel rückholbar halten | Zugang bei abgebrochener Website-Änderung erhalten | Klein; zusätzlicher verschlüsselter Eintrag muss später bewusst bereinigt werden |
| 4 | Vier Aufgaben und passende Einträge zuerst | Weniger Suchen und weniger irrelevante Optionen | Moderat; keine automatische Auswahl oder Freigabe |
| 5 | Android-Profilübersicht und einheitliche Profilgrenze | Profil schneller unterscheiden; erfolglose Eingaben vermeiden | Klein; keine neue Android-Overlay-Funktion |
| 6 | Release-Eingaben und Dateien vor Upload erneut prüfen | Keine gemischten oder veränderten Pakete im Gesamtbundle | Moderat; ersetzt keine Herausgebersignatur |

Eine passende spätere Messung erfasst lokal mit synthetischen Aufgaben: korrektes
Ergebnis, notwendige Entscheidungen, Korrekturen, Abbruchgrund und verstrichene
Zeit. Es wurde keine Telemetrie eingebaut und keine unbelegte Prozentverbesserung
in das Produkt geschrieben.

## Angreifermodell und Korrekturen

Der Angreifer kontrolliert die Zielseite: Formulare, Feldattribute, Navigation,
alternative Absendeziele und synchrone Input-Handler. Er kontrolliert nicht den
Browser, das Betriebssystem oder den Erweiterungscode. Die Tests greifen nur
lokale Fixtures an, keine fremden Websites.

| Befund in 0.29 | Korrektur in 0.30 | Regression |
| --- | --- | --- |
| Ein aktives Popup konnte eine alte Vorschau weiterverwenden | Eigene Zweiminutenfrist und einmalige Nutzung | Kontrolliert gealterte Uhr und erneuter Füllversuch |
| Ein abgelaufener Feldanker konnte zur allgemeinen Formularauswahl zurückfallen | Ungültiger Anker bricht ab; Formulargruppe bleibt gebunden | Fehlender Anker wird abgewiesen |
| Gleiches Feld konnte einem anderen Formular oder Ziel zugeordnet werden | DOM-Objekt, Root, Gruppe, Formular und Zielstempel prüfen | Verschieben, Aktionswechsel und Feldlimitwechsel |
| Herkunft des Absendeziels wurde nicht separat geprüft | Passwort/OTP nur für gleiche Formular-Zielherkunft | Cross-Origin-Aktion und externer `formaction`-Button |
| Ein früher Input-Handler konnte ein späteres Feld verändern | Zustand und Überschreibregel unmittelbar vor jedem Schreiben erneut prüfen | Folgefeld befüllt bzw. Formaktion während des Füllens geändert |
| Auch ungewählte Quellwerte wurden dem isolierten Koordinator mitgegeben | Payload vor dem Scripting-Aufruf auf Auswahl und Freigaben reduzieren | Echte native Aufrufargumente enthalten nur den gewählten Benutzernamen |
| Altes Passwort wurde nur bei Generatorwechsel zusätzlich behalten | Jede ausdrücklich gespeicherte Browser-Passwortänderung bewahrt es auf | Manuelle Änderung und erneutes Entschlüsseln des echten Rust-Tresors |
| Einheitliche Paket-Fingerprints mussten nicht zum frischen Checkout passen; Python-Assertions konnten entfallen | Frisch berechneten Fingerprint verlangen, explizite Fehler statt Assertions, enthaltene Dateien hashen | Gemeinsamer veralteter Fingerprint und geänderte Programmdatei |

Die Testfälle stehen in `scripts/extension_redteam_cases.ts`,
`scripts/extension_inline_cases.ts`, `apps/extension/form-boundary.test.ts`,
`apps/extension/workflow.test.ts` und `scripts/test_release_bundle.py`.
Der Browserlauf verwendet echte Erweiterungs-APIs und den echten Rust-Tresor.
Nur für den Ablaufzeittest wird `Date.now` im isolierten Testkontext kurz
vorgestellt; Berechtigungs- und Kryptografieschnittstellen werden dabei nicht
ersetzt. Der native Website-Berechtigungsdialog bleibt eine getrennte manuelle
Abnahme; die Browserfixture hat einen ausdrücklich markierten localhost-Zugriff.

## Nicht behobene Vertrauensgrenzen

Eine Seite kann absichtlich eingefügte Werte lesen und über ihre Skripte
versenden. Gleichherkunftsprüfungen verhindern keine kompromittierte echte
Website oder einen kompromittierten Browser. Auch ein gleichherkunftiges
Formularziel kann serverseitig weiterleiten. Closed Shadow DOM ist keine
Sicherheitsgrenze gegen andere privilegierte Erweiterungen. Darum enthält das
Feldmenü keine Tresorwerte; Auswahl und Freigabe bleiben im Erweiterungsfenster.

Physische Authenticator-/Telefonabnahme, vollständige native Windows-Abnahme,
Firefox-Laufzeitabnahme der neuen Inline-Fälle und ein unabhängiges Audit sind
getrennte Nachweise. Der Chromium-Browserlauf beweist nicht das Verhalten aller
Browser. Die Android-Pakete bleiben wegen fehlender dauerhafter Publisher-Identität
Vorschaupakete; Apple-Notarisierung und Browser-Store-Veröffentlichung fehlen.

## Primärquellen für den Review

- [Chrome: Message passing und untrusted content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security_considerations)
- [OWASP: Browser Extension Vulnerabilities](https://cheatsheetseries.owasp.org/cheatsheets/Browser_Extension_Vulnerabilities_Cheat_Sheet.html)
- [1Password: Browser-Sicherheitsmodell und isolierte Freigabeoberfläche](https://support.1password.com/1password-browser-security/)
- [Funktionsvergleich der zehn Referenzprodukte](AUTOFILL-COMPETITORS.md)
