# Bibliotheken und Referenzen

Rust prüft die Passkeys und signiert Zugänge. Für diese Aufgaben verwendet HeavenKey die unten genannten Bibliotheken; ihre Versions- und Prüfsummendaten stehen zusammen mit den übrigen Abhängigkeiten in den Lockfiles. Versionen und Prüfsummen stehen in `Cargo.lock` und `bun.lock`; Lizenzhinweise in [NOTICE.md](../NOTICE.md).

## Verwendete Bibliotheken

| Bibliothek | Aufgabe | Lizenz |
| --- | --- | --- |
| `webauthn-rs 0.5.5` | Passkey-Einschreibung und Prüfung der WebAuthn-Antworten in Rust | MPL-2.0 |
| `@simplewebauthn/browser 14.0.0` | WebAuthn-Dialoge und Umwandlung der Browserantworten | MIT |
| `ed25519-dalek 2.2.0` | Signieren und strikte Prüfung der Zugänge | BSD-3-Clause |
| `axum` und `tokio` | HTTP-API und asynchrone Ausführung | Details im Lockfile und den Paketlizenzen |
| `rusqlite` | Lokale Speicherung des Kontozustands | Details im Lockfile und den Paketlizenzen |

Der Browseradapter wird lokal gebündelt. Sein Copyright- und MIT-Hinweis bleibt im erzeugten Bundle erhalten. Die Rust-API prüft jede Antwort; der Adapter vergibt selbst keine Berechtigungen.

Paketquellen: [webauthn-rs](https://github.com/kanidm/webauthn-rs/blob/d2c10d53ca5ef033d37ee6462e936e9eb72ad98c/webauthn-rs/Cargo.toml), [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn/tree/83f87addc67b652ff5b84e681669451648216ef6/packages/browser), [ed25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek/blob/8016d6d9b9cdbaa681f24147e0b9377cc8cef934/ed25519-dalek/Cargo.toml).

## Gestaltungsprinzipien

[Enpass](https://www.enpass.io/security/) ist eine Referenz für lokale Datenhoheit und optionale verschlüsselte Synchronisierung. [KeePassXC](https://github.com/keepassxreboot/keepassxc/blob/9e0f57a4a4c6c629fa6d0a593acb7d089b1d95cd/docs/topics/Passkeys.adoc) ist eine Referenz für benannte Passkeys, Übersichten und ausdrückliche Bestätigung.

Produktcode aus diesen Anwendungen wird nicht eingebunden. HeavenKey besitzt derzeit weder einen verschlüsselten Tresor noch verschlüsselte Synchronisierung. SQLCipher ist bisher nicht integriert. Vor einer verschlüsselten Datenbank müssen Schlüsselverwahrung und Wiederherstellung geklärt sein, damit ein Umstieg bestehende Daten weder verliert noch unzugänglich macht.

## Delegationsformat

Das eigene HeavenKey-Profil übernimmt begrenzte Weitergabe und die Bindung an Vorgänger als Prinzipien. Der Dienst signiert alle Kettenglieder. Kontokennungen sind keine DIDs; eine UCAN-Implementierung wird nicht eingebunden. Das [Format](DELEGATION-CONTRACT.md) definiert die signierten Daten und die Kettenregeln. `uac-gate` und `hkv` prüfen dieses Format ohne neue externe Bibliotheken: Der Abruf des Issuer-Schnappschusses läuft über einen kleinen HTTP-Client auf `tokio::net::TcpStream`, die Argumentverarbeitung von `hkv` ist handgeschrieben.

Die [Lizenz- und Paketbelege](evidence/donors-v03.json) und [Quellen zum Delegationsprofil](evidence/v05-donor-research.json) enthalten die detaillierten Versions- und Herkunftsdaten.
