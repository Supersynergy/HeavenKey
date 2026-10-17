# Passkeys und befristete Freigaben

## Tresor mit einem Passkey entsperren

Öffne den Tresor mit deinem Masterpasswort und wähle unter Einstellungen **Mit Passkey entsperren**. Vergib einen Gerätenamen, bestätige das Masterpasswort und folge den beiden Browserdialogen: zuerst wird der Passkey angelegt, anschließend seine PRF-Funktion geprüft. Erst nach erfolgreicher Prüfung ist er aktiv. Ein Browser oder Gerät ohne PRF-Unterstützung erhält keinen aktiven Eintrag; das Masterpasswort funktioniert weiterhin.

Beim nächsten Entsperren wählst du den Passkey ausdrücklich. Der Browser verifiziert ihn über WebAuthn mit Benutzerverifikation. Aus dem lokalen PRF-Ergebnis wird per HKDF-SHA256 ein AES-256-GCM-Schlüssel abgeleitet, der den gespeicherten Masterpasswort-Umschlag öffnet. Das PRF-Ergebnis und das Masterpasswort werden nicht an die API gesendet. Origin, Tresorsalz und Credential-ID sind an den Umschlag gebunden. Der bestehende Tresor und sein PBKDF2-Verfahren bleiben erhalten.

Die Passkey-Liste ist lokal. Synchronisierte Passkeys synchronisieren weder Tresordaten noch den Umschlag. Sichere den Tresor verschlüsselt und bewahre das Masterpasswort auf. Es gibt keinen Passwort-Reset. Bei einem Masterpasswortwechsel oder einer Wiederherstellung vom Sperrbildschirm werden die bisherigen Passkey-Umschläge entfernt und Freigaben widerrufen. Richte Passkeys danach erneut ein. Einstellungen erlauben das Entfernen einzelner Passkeys.

## Ausgewählte Felder teilen

1. Öffne einen Login oder unter Einstellungen ein Formularprofil und wähle **Befristet teilen**.
2. Wähle die Felder einzeln. Standardmäßig ist kein Feld ausgewählt. Prüfe insbesondere Passwörter und TOTP-Schlüssel.
3. Wähle fünf Minuten, eine Stunde, einen Tag oder sieben Tage und bestätige die Weitergabe ausdrücklich.
4. Kopiere den vollständigen Link vertraulich zum vorgesehenen Empfänger. Die Kopie enthält die ausgewählten Werte zum Erstellungszeitpunkt; spätere Änderungen am Original verändern sie nicht.
5. Der erste Empfänger legt einen eigenen Passkey an und bestätigt ihn. Erst diese verifizierte Anmeldung bindet die Kopie an ihn und gibt den verschlüsselten Inhalt frei. Spätere Abrufe erfordern denselben Passkey. Der Empfänger benötigt PRF hierfür nicht.

Ein zufälliger AES-256-GCM-Schlüssel verschlüsselt die Kopie im Browser. Schlüssel und Zugangstoken stehen im URL-Fragment, nicht in Anfragepfad oder Query. Die Empfängerseite entfernt das Fragment aus der sichtbaren Adresse. Der Dienst speichert den Token nur gehasht, die Werte nur verschlüsselt sowie ID, Typ und Zeitangaben. Jeder Abruf prüft serverseitig Laufzeit, Widerruf und Passkey. WebAuthn-Zeremonien laufen nach zwei Minuten ab, sind begrenzt und werden einmalig verbraucht.

Der Link ist keine verifizierte Personenidentität: Wer ihn zuerst mit einem eigenen Passkey beansprucht, wird zum Empfänger. Übermittle ihn über einen geeigneten vertraulichen Kanal. Ein verlorener Empfänger-Passkey kann nicht ersetzt werden; widerrufe die Kopie und erstelle eine neue.

Unter Einstellungen kannst du eine Freigabe sofort widerrufen. Ablauf und Widerruf verhindern weitere Serverabrufe. Bereits angezeigte oder kopierte Daten kann HeavenKey nicht zurückholen. Die offene Empfängerseite leert ihre Anzeige bei Ablauf beziehungsweise Seitenende; andere gespeicherte Kopien liegen außerhalb dieser Kontrolle.

## Lokaler Betrieb und andere Geräte

Standardmäßig lautet die Freigabeadresse `http://localhost:<port>/share/`. Sie funktioniert auf demselben Computer, während der lokale Dienst läuft. Auf einem anderen Gerät bezeichnet localhost dessen eigenen Computer. Ein lokaler Link erzeugt kein öffentliches Hosting.

Für einen selbst betriebenen Empfängerzugang:

```sh
HEAVENKEY_SHARE_ORIGIN=https://share.example.org ./heavenkey --password-manager --open
```

Der Dienst bleibt an Loopback gebunden. Ein selbst eingerichteter TLS-Reverse-Proxy muss den öffentlichen Host und die Browser-Origin unverändert weitergeben und nur folgende Pfade zulassen:

```text
/share/
/share.js
/passwords.css
/heavenkey-cover.png
/api/password-shares/recipient/start
/api/password-shares/recipient/verify
/api/password-shares/recipient/finish
```

Auf dem öffentlichen Host weist HeavenKey Verwaltungs-, Konfigurations-, Passkey- und Tresor-Endpunkte ab. Schreibe den Host nicht auf localhost um: Das würde diese Trennung umgehen. Verwende einen isolierten Dienst, TLS, geeignete Proxy-Grenzen und keine vollständigen URL-Fragmente in Protokollen. Der öffentliche Origin muss vor der Erstellung feststehen und darf keinen Pfad enthalten. Bereits gebundene Empfänger-Credentials gelten für dessen RP-ID. Ein Origin-Wechsel kann neue Freigaben und neue Empfänger-Passkeys erfordern. Der lokale Tresor benötigt kein öffentliches Hosting.

Die Release-Abnahme prüft virtuelle WebAuthn-Geräte und lokale Host-/Origin-Grenzen. Ein öffentlicher TLS-Betrieb, physische Passkeys, native mobile Credential-Provider und eine Verfügbarkeit außerhalb des laufenden eigenen Dienstes sind damit nicht zugesichert.

## Private GitHub-Downloads

Das Repository ist privat. Die Meldung „Could not resolve to a Repository“ in der GitHub-App beweist nicht, dass das Repository fehlt. Melde dich mit einem berechtigten Konto an und öffne [die Releases im Browser](https://github.com/Supersynergy/HeavenKey/releases/latest). Falls der Browser funktioniert, prüfe die Anmeldung der Handy-App erneut. Die App wird durch einen HeavenKey-Release nicht neu angemeldet; die Sichtbarkeit des Repositorys wird dafür nicht geändert.
