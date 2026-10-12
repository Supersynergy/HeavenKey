# Neu in HeavenKey 0.5

Version 0.5 ergänzt die begrenzte Weitergabe von Zugängen. Ein Gast kann einem weiteren registrierten Konto Zugang geben, ohne die vom Eigentümer festgelegten Rechte auszuweiten.

## Weitergabe mit festen Grenzen

- Der neue Zugang bleibt bei derselben Ressource und höchstens denselben Aktionen.
- Seine Gültigkeit bleibt innerhalb der Elternlaufzeit.
- Jede Weitergabe verringert die verbleibende Weitergabegrenze.
- Eine Kette besteht aus höchstens fünf Gliedern und vier Weitergaben.
- Eine frische Passkey-Bestätigung bindet die gewählten Angaben an die konkrete Änderung.

## Widerruf über die gesamte Kette

Auch ein noch gültig signierter Zugang verliert seine Wirkung, sobald ein Elternzugang widerrufen wird und damit die Berechtigungskette bis zum letzten abhängigen Glied unterbrochen ist. Die Sperre gilt sofort für offene Aufrufe. Die API prüft die aktuelle Kette bis zur Ausführung. Widerrufe bleiben über Neustarts erhalten.

Die Übersicht zeigt den Status geteilter Zugänge. Bestehende direkte Zugänge und die Passkey-Verwaltung aus 0.4 bleiben nutzbar.

## Technisches Profil

`heavenkey-delegation-v1` ist ein eigenes, versioniertes Format. Der Dienst signiert jedes Glied mit seinem Ed25519-Schlüssel, nachdem die Berechtigung des Kontos geprüft wurde. Kontokennungen sind keine DIDs oder öffentlichen Signierschlüssel.

Festgelegte Signierbytes sorgen dafür, dass JSON-Formatierung und Eigenschaftsreihenfolge den Identifier nicht verändern. Rust weist fehlerhafte Felder, Größen und Ketten ab. Eine unabhängige Referenz prüft die öffentlichen Testvektoren und tatsächlich erzeugte API-Signaturen. Der vollständige Vertrag steht unter [Delegationsformat](DELEGATION-CONTRACT.md).

## Prüfstand

| Prüfung | Ergebnis |
| --- | --- |
| Rust | 45 Tests bestanden |
| Browser | 138 Fälle mit virtuellen Passkeys bestanden |
| Referenz | 75 Prüfungen für Signaturen, Identifier und Kettenregeln bestanden |
| Ketten und Widerruf | Drei- und fünfgliedrige Ketten, Sperren offener Aufrufe und Neustart geprüft |

[Testfälle](evidence/e2e.json) · [Testvektoren](vectors/delegation-v1.json) · [Sicherheitsprüfung](DELEGATION-REVIEW.md)

Physische Geräte, UCAN-/DID-Kompatibilität und allgemeine Offline-Nutzung sind noch offen. Ein Offline-Ziel kann einen entfernten Widerruf erst nach Empfang berücksichtigen. Die nächsten Funktionen stehen in der [Roadmap](ROADMAP.md).
