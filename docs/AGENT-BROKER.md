# Lokaler Agenten-Broker

Ab Version 0.13.0 kann ein gekoppelter lokaler Agent eine klassische Formularanmeldung anfragen. Du wählst in HeavenKey den passenden Login für die genaue Website und bestätigst die Anmeldung. Ein eigener kurzlebiger Chromium-Prozess meldet sich an. Der Agent bekommt ausschließlich eine begrenzte Textansicht und interne Links. Jede weitere Anmeldung braucht eine neue Freigabe.

## Einrichtung

1. Starte den Passwortmanager und entsperre den Tresor.
2. Öffne **Einstellungen → Agent-Zugriff**. Installiertes Chrome, Chromium oder Edge wird benötigt. Der Broker berührt dein normales Browserprofil nicht.
3. Erzeuge einen Kopplungscode. Er ist einmalig und zwei Minuten gültig. Gib ausschließlich diesen Code an den gewünschten Agenten weiter.
4. Der Agent verbindet sich über den enthaltenen Client. Seine Bezeichnung ist selbst gewählt und kein Identitätsnachweis.
5. Prüfe die Anfrage, die vollständige Website-Adresse und den ausgewählten Login. Setze die Zustimmung ausdrücklich. Die Sitzung läuft höchstens fünf Minuten.

Unter **Gekoppelte Agenten** widerrufst du die Verbindung; unter **Aktive Sitzungen** beendest du den Browser. Sperren, Seitenwechsel mit Sperrung, fehlender Heartbeat, Änderungen am Tresor und ein Neustart beenden laufende Zugriffe. Ohne Heartbeat sperrt der Dienst nach spätestens 35 Sekunden; die Bereinigung läuft zusätzlich einmal pro Sekunde. Der Clientzugang verfällt nach einer Stunde. Eine bereits abgeschickte Website-Anfrage kann nicht zurückgerufen werden.

## Client ohne Zwischenablage

Das ausgelieferte Programm enthält `--broker-agent PORT BEFEHL`. Es liest JSON von stdin und gibt JSON aus. Der Port gehört ausschließlich zum lokalen HeavenKey-Dienst. Geheimnisse gehören weder in Argumente noch in Shellverläufe. Der Client braucht kein Rust oder Bun.

| Befehl | JSON auf stdin |
| --- | --- |
| `connect` | `{"code":"EINMALCODE","label":"Mein Agent"}` |
| `request` | `{"token":"CLIENTTOKEN","origin":"https://example.com"}` |
| `status` | `{"token":"CLIENTTOKEN","request_id":"ANFRAGE"}` |
| `read` | `{"token":"CLIENTTOKEN","session_id":"SITZUNG","path":"/konto"}` |
| `close` | `{"token":"CLIENTTOKEN","session_id":"SITZUNG"}` |

Beispiel: `./heavenkey --broker-agent 18240 request < anfrage.json`. Unter Windows heißt das Programm `HeavenKey.exe`. Das Clienttoken berechtigt zu eigenen Anfragen und freigegebenen Sitzungen; es öffnet keinen Tresor. Halte auch dieses Token vertraulich und außerhalb von Versionsverwaltung und Logs. Automatisierungen sollten stdin direkt aus ihrem Arbeitsspeicher übergeben.

Für die Entwicklung liegt `broker.rs` bei:

```sh
cargo +nightly-2026-10-11 -Zscript broker.rs /absoluter/pfad/heavenkey 18240 request < anfrage.json
```

Die festgelegte Toolchain ist Rust 1.101 nightly. `-Zscript` kompiliert das Hilfsskript automatisch und verwendet Caches. Es ersetzt weder den Produktbuild noch die Sicherheitsprüfung. Das Releaseprogramm verwendet keinen Script-Interpreter.

## Schutzgrenze und Trust-Marker

- Der ausgewählte Login wird mit AES-256-GCM und einem RSA-OAEP-SHA256-verpackten Zufallsschlüssel an den lokalen Ausführer übergeben. Die Bindung enthält Anfrage, Entsperr-Epoche und Tresorrevision. Masterpasswort und vollständiger Tresor werden nicht übertragen.
- Zwischenablage, rohe Browsersteuerung, JavaScript, Screenshots, Cookies und Tresorexport fehlen in der Agentenschnittstelle. Der private Browserkanal verwendet anonyme Betriebssystem-Pipes und keinen Debug-Port.
- Die Textansicht entfernt Formularwerte und bekannte Zugangsdaten sowie gängige Kodierungen. Das ist zusätzliche Filterung, keine Garantie gegen eine bösartige Zielwebsite. Die Zielwebsite erhält beim Anmelden die Zugangsdaten.
- Die Trennung schützt diese eingeschränkte Schnittstelle. Beliebige Programme desselben OS-Benutzers, Administratoren, Schadsoftware und ein kompromittierter Browser liegen außerhalb. Ein uneingeschränkter Agent mit Shell- oder Browserzugriff braucht eine zusätzliche OS-Sandbox, wenn diese Grenze durchgesetzt werden soll.
- Die Oberfläche kennzeichnet den unsignierten Herausgeber und den internen Review. Ein externes Audit, TEE-Nachweis und eine Hardware-Attestierung liegen nicht vor. Prüfsummen belegen Dateiintegrität relativ zur veröffentlichten Prüfsummenliste; sie ersetzen keine Herausgebersignatur.

Unterstützt werden gleichursprüngliche klassische Loginformulare. Externes SSO, CAPTCHA, mehrstufige Anmeldung und Website-Passkeys sind für diesen Broker nicht freigegeben. HTTP ist nur für localhost zulässig. Ungeeignete Formulare und fremde Origins werden abgelehnt. Alle Browserdaten gehören zu einem getrennten temporären Profil, das beim regulären Beenden gelöscht wird. Ein Prozessabsturz oder Stromausfall kann Betriebssystemartefakte zurücklassen; verschlüsselte Datenträger bleiben erforderlich, wenn auch diese geschützt werden sollen.
