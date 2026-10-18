# Tresorverschlüsselung und Migration

Neue Tresore verwenden ab 0.15 Argon2id v1.3 mit 65.536 KiB Speicher, drei Durchläufen, einer Lane und einem 32-Byte-Schlüssel. Salt (16 Byte) und AES-GCM-Nonce (12 Byte) sind jeweils zufällig. Die Schlüsselableitung und Verschlüsselung laufen lokal im Browser; das Masterpasswort wird nicht an den Dienst gesendet. Die Version der Tresorhülle unterscheidet Argon2id von älteren PBKDF2-SHA256-Tresoren mit 600.000 Iterationen. Die Parameter werden vor einer Ableitung auf den festgelegten Satz geprüft. Unbekannte Formate werden abgewiesen.

## Einen bestehenden Tresor umstellen

1. Aktualisiere die App und die Browser-Erweiterung gemeinsam auf diese Version. Ältere Versionen können das neue Format nicht öffnen.
2. Entsperre deinen bisherigen Tresor und lade eine verschlüsselte Sicherung herunter. Bewahre das damalige Masterpasswort auf.
3. Öffne Einstellungen → Masterpasswort ändern. Wähle ein starkes neues Masterpasswort oder gib dein bisheriges starkes Passwort erneut ein.
4. Bestätige die Neuverschlüsselung. Erst der erfolgreiche revisionsgeprüfte Schreibvorgang ersetzt den gespeicherten Tresor. Ein Konflikt lässt die ältere Speicherung unverändert.
5. Sperre und entsperre den Tresor zur Kontrolle. Richte Passkeys anschließend erneut ein. Bestehende Freigaben wurden widerrufen; bereits gespeicherte Empfängerkopien bleiben erhalten.

Der Hinweis in den Einstellungen zeigt das tatsächlich gespeicherte Format. Normale Änderungen und Profiländerungen in der Erweiterung behalten dieses Format bei. Entsperren allein migriert keine Daten. Alte Sicherungen bleiben im alten Format und sollten entsprechend geschützt aufbewahrt werden. Ihre Wiederherstellung funktioniert weiterhin. Ein Downgrade der App nach einer Migration benötigt eine passende alte Sicherung und verliert zwischenzeitliche Änderungen.

## Was der Schutz leistet

Die Speicherkosten erschweren parallele Offline-Versuche an kopierten Tresordateien. Die Empfehlung für ein langes, zufälliges Masterpasswort gilt weiterhin. Eine starke KDF kann ein schwaches Passwort, einen kompromittierten Besitzerbrowser oder Administratorzugriff nicht ausgleichen. JavaScript und der Browser garantieren keine vollständige physische Speicherlöschung. Die App überschreibt ihre erreichbaren Bytepuffer; der importierte AES-Schlüssel ist nicht exportierbar. Ein langsames Gerät kann für die Ableitung deutlich länger brauchen. Gleichzeitig laufende Ableitungen sind begrenzt.

Die Implementierung verwendet das exakt gebundene MIT-Paket `@noble/hashes` 2.4.0. Die bekannte unabhängige Cure53-Prüfung früherer noble-hashes-Versionen schloss Argon2 ausdrücklich aus. Der Paketname ist daher kein unabhängiges Audit des HeavenKey-KDF-Pfades. Referenzvektoren, interne Quellprüfung und Browser-Abläufe stehen getrennt von einem weiterhin ausstehenden externen Audit.

Quellen: [Argon2-Spezifikation RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html), [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [noble-hashes Sicherheitsangaben](https://github.com/paulmillr/noble-hashes#security).
