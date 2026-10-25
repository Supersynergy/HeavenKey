# Dein erster Login in HeavenKey

## Beginnen oder wiederherstellen

Am Desktop wählst du ein langes Masterpasswort für einen neuen Tresor. Wenn du bereits eine verschlüsselte Sicherung hast, öffne die Wiederherstellung. Prüfe Datei und Passwort, bevor du den vorhandenen Inhalt ausdrücklich ersetzt. HeavenKey kann dein Masterpasswort nicht zurücksetzen.

Android verwendet die Gerätesperre. Nach der Freigabe zeigt ein leerer Tresor drei Wege: ersten Login speichern, Sicherung wiederherstellen oder vom Desktop übernehmen. Vorhandene Einträge bleiben beim Entsperren erhalten.

## Einen bestehenden Login speichern

Gib die Website, deinen Nutzernamen und das aktuelle Passwort ein. Eine Domain wie `example.com` wird als HTTPS-Adresse vorbereitet. Ein leerer Name kann aus der Domain entstehen; einen selbst eingegebenen Namen ersetzt HeavenKey nicht.

Android zeigt die genaue gespeicherte Herkunft vor dem Speichern: `https://example.com:8443`. Pfad, Suchparameter und Fragment werden weggelassen. HTTPS, Domain und Port bleiben die Grenze für die Browserzuordnung. HTTP, IP-Adressen und eingebettete Zugangsdaten werden auf Android abgewiesen. Der Desktop unterstützt weiterhin ausdrücklich eingegebene HTTP-Adressen für bestehende lokale Anwendungen.

Nutzernamen-Vorschläge stammen ausschließlich aus dem aktuell entsperrten Tresor und werden erst nach deiner Auswahl eingesetzt. Es findet keine Verfügbarkeitsprüfung bei der Website statt. Notizen und weitere Optionen öffnest du bei Bedarf.

## Ein neues Passwort erzeugen

Nutze den Generator ausdrücklich für ein neues oder zu änderndes Website-Passwort. Bei einem bereits gefüllten Passwortfeld bestätigst du die Ersetzung. Speichern in HeavenKey ändert das Passwort deines Kontos bei der Website nicht. Führe diese Änderung auch dort durch.

## Danach

Nach dem ersten Speichern führen Aktionen zur verschlüsselten Sicherung und weiteren Einrichtung. Bewahre die Sicherung getrennt auf und prüfe die Wiederherstellung. Auf Android benötigst du zusätzlich den getrennt aufzubewahrenden Wiederherstellungsschlüssel. Ein gestarteter Download bestätigt keine sichere Aufbewahrung.

Richte Autofill und die Browsererweiterung ein, wenn du sie verwenden möchtest. Die Desktopkopplung, Website-Passkeys und jede sensible Freigabe bleiben ausdrückliche Entscheidungen. Der Einstieg ist keine Kontoerstellung bei anderen Websites.

## Prüfgrenzen

Die dokumentierten Journeys verwenden synthetische Daten. Automatisierte Tests messen sichtbare Felder und prüfen Speicherung, Sperren, Bestätigungen und Navigation. Eine menschliche Zeitersparnis, tägliche Nutzungshäufigkeit oder Überlegenheit gegenüber anderen Passwortmanagern wurde damit nicht gemessen. Physische Geräte und die iOS-Veröffentlichung benötigen eine eigene Abnahme.
