# HeavenKey 0.3: mehrere Passkeys

Historischer Funktionsstand. Aktuelle Benutzung und Grenzen stehen in der [Anleitung](USAGE.md).

## Neue Funktionen

- Bis zu acht aktive Passkeys pro Konto mit Namen und Status.
- Ausdrücklicher Widerruf eines Schlüssels und Schutz des letzten aktiven Schlüssels.
- Ersatzschlüssel können bestehende Zugänge desselben Kontos weiter nutzen.
- Widerruf beendet Kontositzungen und offene Einschreibungs-/Anmeldevorgänge.
- Gesperrte Schlüssel bleiben beim Neustart gesperrt; alte Datenbestände werden idempotent migriert.

Die Version verwendet den MIT-lizenzierten SimpleWebAuthn-Browseradapter. Ein quadratisches, mittig platziertes Titelbild ergänzt die README.

## Prüfstand dieser Version

29 Rust-Tests und 69 virtuelle Browserfälle bestanden, einschließlich mehrerer Schlüssel, fremder Konten, Widerruf, Neustart und Migration. Hardware und Biometrie waren noch offen.

Eine frische, serverseitig an die genaue Änderung gebundene Zustimmung wurde mit [Version 0.4](V04-RESULT.md) ergänzt. Wenn du einen einzelnen Passkey widerrufst, kann ein anderer aktiver Schlüssel desselben Kontos die bestehenden Zugänge weiter nutzen, bis du auch den jeweiligen Zugang widerrufst. Das Konto bleibt erhalten.

[Historische Abnahme](evidence/acceptance-v03.json) · [Bibliotheken und Lizenzen](DONORS.md) · [Aktueller Prüfstatus](VERIFICATION.md)
