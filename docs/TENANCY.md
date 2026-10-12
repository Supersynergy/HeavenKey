# Mandantenfähigkeit (Tenancy)

`crates/tenancy` liefert die Isolationsprimitiven, mit denen HeavenKey künftig mehrere getrennte Organisationen (Mandanten) auf einer Installation verwalten kann. Der Roadmap-Eintrag „Mandanten" verlangt als Prüfkriterium: keine Zugriffe zwischen Organisationen. Dieser Workstream liefert ausschließlich die Bibliothek `uac-tenancy` plus dieses Dokument — keine Verdrahtung in `apps/api` (siehe Abschnitt „Grenzen" und „Offene Punkte").

## Grundmodell

Jede Entität gehört genau einem Mandanten: `users`, `credentials`, `grants`, `delegations` und `operations` tragen eine `tenant_id`, die auf eine Zeile der neuen Tabelle `tenants` verweist. Sämtlicher Zugriff läuft über einen `TenantScope`, den `Store::with_tenant(&tenant_id, |scope| …)` erzeugt. Lookup, Listing, Erzeugen, Delegieren, Aufrufen (Invoke) und Widerruf tragen die `TenantId` des Scopes — niemals einen vom Aufrufer gelieferten Wert.

## Isolationsschichten

Die Isolation ist dreifach abgesichert (defense in depth):

1. **Compile-Zeit.** `with_tenant` prägt pro Aufruf eine frische, unerfundbare Lebenszeit-Marke `'t` (Generativitäts-Muster). Gelesene oder erzeugte Datensätze sind `Record<'t, T>` und passen nur in den Scope, aus dem sie stammen: Ein Datensatz von Mandant A kann an eine Methode von Mandant B nicht einmal übergeben werden — es kompiliert nicht. Die `compile_fail`-Doctests in `crates/tenancy/src/lib.rs` belegen das: Records können weder in einen fremden Scope übergeben noch aus ihrer eigenen Scope-Klammer herausgeschmuggelt werden. Zur Laufzeit zählt damit nur noch der versehentlich falsch gestempelte Datensatz.
2. **Laufzeit.** Jede Methode, die einen `Record` entgegennimmt, prüft erneut `record.tenant_id() == scope.tenant_id()` (`Error::CrossTenant`, fail-closed). Die id-basierten Varianten (`*_id`, gedacht für HTTP-Handler, die nur Bezeichner kennen) beantworten fehlende **und** fremde Bezeichner einheitlich mit `Error::NotFound` — der Fehler verrät nicht, ob die ID im Nachbartenant existiert (kein Existenz-Orakel). Alle SQL-Anweisungen enthalten `tenant_id` in `WHERE` bzw. `INSERT`-Werten; die tenant_id stammt stets aus dem Scope.
3. **Datenbank.** Jede Entitätstabelle deklariert `UNIQUE (tenant_id, id)`, und Fremdschlüssel sind zusammengesetzt: `FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)`. Ein Datensatz kann also selbst dann nicht auf einen Datensatz eines anderen Mandanten verweisen, wenn die Bibliothek umgangen wird. `delegations.parent_id` nutzt denselben Mechanismus als Selbstverweis.

## Keine geteilten Sequenzen

- Jede ID (Tenant, User, Credential, Grant, Delegation, Operation) ist eine zufällige UUID v4. Es gibt keine AUTOINCREMENT-/Zählerwerte.
- Alle Tabellen sind `WITHOUT ROWID` definiert; eine implizite `rowid`, aus der sich Einfügereihenfolge oder Zeilenzahl je Tenant ablesen ließe, existiert nicht.
- Listings liefern nur Zeilen des eigenen Mandanten (`WHERE tenant_id = ?`), die Sortierung (`created, id`) verrät nichts über fremde Tenants.
- Namensräume sind pro Mandant eindeutig: `UNIQUE (tenant_id, name)` erlaubt denselben Benutzernamen in verschiedenen Organisationen unter verschiedenen IDs; `Error::Duplicate` bleibt tenant-intern.
- Der partielle Index `one_owner_per_tenant` erzwingt genau einen Eigentümer pro Mandant (portiert das heutige globale `one_owner`-Indexmuster).

## Referenz-Implementierung

`Store::in_memory()` baut das Schema in einer SQLite-In-Memory-Datenbank via `rusqlite` (Workspace-Dependency, `bundled`) auf; `Store::from_connection(conn)` hüllt beliebige Verbindungen ein (spätere API-Anbindung). `PRAGMA foreign_keys = ON` wird beim Öffnen gesetzt. `unchecked_transaction` kapselt die Delegations-Vorprüfungen atomar mit dem Einfügen. Invokationen laufen als einzelne `INSERT … WHERE EXISTS`-Anweisung: Der Grant muss im selben Tenant liegen, dem Inhaber gehören und nicht widerrufen sein, sonst schreibt die Anweisung schlicht nichts und es wird `NotFound` gemeldet.

Methodenübersicht (Auswahl): `create_tenant`, `tenant_info`, `list_tenants` (Operatorebene); pro Scope `create_user`/`user`/`find_user`/`list_users`, `create_credential`/`list_credentials`/`deactivate_credential(_id)`, `create_grant`/`grant`/`list_grants`/`revoke_grant(_id)`, `create_delegation`/`create_delegation_id`/`delegation`/`list_delegations`/`revoke_delegation(_id)`, `invoke`/`invoke_id`/`list_operations`.

## Übertragung auf die heutigen Tabellen (`apps/api`)

Heute sind `users`, `grants`, `operations`, `credentials`, `delegations`, `delegation_operations` global. Die Partitionierung um `tenant_id`:

| Tabelle | Änderung |
| --- | --- |
| `users` | `+ tenant_id`; `UNIQUE (tenant_id, name)` statt `UNIQUE (name)`; Index `one_owner` → `UNIQUE (tenant_id) WHERE owner=1`. `credential_id` bleibt **global** `UNIQUE` — Passkey-Credential-IDs sind per Authenticator weltweit eindeutig; ein erneutes Registrieren desselben Schlüssels in einem zweiten Mandanten bleibt verboten (entspricht der heutigen Anti-Reuse-Regel). |
| `credentials` | `+ tenant_id`; `UNIQUE (tenant_id, id)`; `FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)`; alle `WHERE user_id = ?`-Abfragen bekommen `AND tenant_id = ?`. |
| `grants` | `+ tenant_id`; `UNIQUE (tenant_id, id)`; `holder`/`guest_id` als Composite-FK auf `users(tenant_id, id)`; Token bleibt global einzigartig (Wire-Format unverändert). |
| `delegations` | `+ tenant_id`; `UNIQUE (tenant_id, id)`; Composite-FKs für `parent_id`, `recipient_id`, `delegator_id`. |
| `operations` / `delegation_operations` | `+ tenant_id`; Composite-FKs auf `grants`/`delegations` und `users`. |
| `tenants` (neu) | `id TEXT PRIMARY KEY`, `label`, `created`. |

Zusätzlich gilt: Sessions, Approvals und WebAuthn-Challenges liegen derzeit prozess-intern — bei der API-Verdrahtung sind Schlüssel/Kontexte dieser Strukturen ebenfalls um den Tenant zu erweitern (TODO). Der dienstweite Issuer-Ed25519-Key bleibt vorerst global (Signaturwurzel des Dienstes); ein Tenant-spezifischer Issuer ist eine offene Entscheidung (siehe „Offene Punkte").

### Migrationsskizze

1. `CREATE TABLE tenants`; einen Default-Mandanten anlegen (z. B. Label „default").
2. Neue Tabellen mit `tenant_id`-Schema anlegen (neu erstellt statt `ALTER TABLE`, da `UNIQUE`/Composite-FKs nicht nachträglich setzbar sind).
3. Daten kopieren: `INSERT INTO users_new SELECT ?, id, name, …` mit der Default-Tenant-ID — jede Tabelle einmal.
4. Alte Tabellen umbenennen/löschen, neue umbenennen; `PRAGMA foreign_keys=ON`; `PRAGMA foreign_key_check`.
5. Idempotent machen (`IF NOT EXISTS`, `INSERT OR IGNORE` für den Default-Tenant), damit bestehende Lab-DBs beim ersten Start migriert werden — analog zur heutigen Credentials-Nachmigration in `initialize_database`.
6. Tenant-Auflösung am Request: Header/Subdomain/Session — Entscheidung folgt bei der Verdrahtung.

### Endpunkte mit Tenant-Kontext (Voraussicht)

Bootstrap/Enrollment, `/api/auth/start`+`/api/auth/finish` (Login, Approval, Invocation), `/api/credentials*`, `/api/grants*`, `/api/delegations*`. Tenant-lose Operatormethoden (Tenant anlegen/auflisten) brauchen ein eigenes Autorisierungsmodell — nicht Teil dieses Workstreams.

## Grenzen und Nichtziele

- Reine Bibliothek; **keine** Verdrahtung in `apps/api`, `apps/web`, `apps/extension` oder `crates/verifier` (bewusst — Dateien außerhalb des Workstreams bleiben unverändert).
- `TenantScope` ist an eine Closure gebunden; Datensätze leben nur innerhalb eines Scope-Aufrufs. Für anfrageweite Nutzung später: Scope pro Request erzeugen, ids über `*_id`-Varianten erneut auflösen.
- `Error::NotFound` deckt bewusst „fehlt", „fremd" und „nicht nutzbar" ab — maximal datensparsam, minimal unterscheidbar. Feinere Fehler für eigene Datensätze kann die API-Schicht später differenzieren, ohne Tenant-Information preiszugeben.
- Keine Quotas, kein RBAC innerhalb eines Tenants, kein Tenant-übergreifender „Admin-Scope" (bewusst nicht gebaut).
- Single-Prozess/SQLite; Recovery, geschützter Speicher und Offline-Szenarien sind eigene Roadmap-Blöcke.
- Physische Passkey-/Hardware-Prüfung bleibt deferred (Lab-Status, siehe VERIFICATION.md).
- Kein UCAN-Interoperabilitätsanspruch; das Grant-Wire-Format bleibt experimentell.

## Offene Punkte (TODO für Folge-Workstreams)

- Tenant-Auflösung aus dem HTTP-Kontext (Header/Subdomain/Session) und Operator-Autorisierung für `create_tenant`/`list_tenants`.
- Sessions/Approvals/Challenges tenant-binden; `users.credential_id`-Globalunik in Zusammenarbeit mit Enrollment prüfen.
- Reale Migration bestehender `data/`-Datenbanken samt Integrations-Test.
- Issuer-Strategie: ein dienstweiter Issuer vs. Issuer je Tenant (rotierbar, widerrufbar).
- Optionale `serde`-DTOs an der HTTP-Grenze und Fehler-Mapping `Error` → HTTP-Status.

## Nachweis

- Unit-Tests `cargo test -p uac-tenancy` (9 Tests + 2 `compile_fail`-Doctests): kein Lesen, Schreiben, Delegieren, Widerrufen oder Invokation über Tenant-Grenzen — auch nicht mit erratenen/übernommenen IDs des Nachbarmandanten; Widerruf schließt Invocation/Kinddelegation aus; Runtime-Check fängt gestempelte Fremd-Records ab; keine gemeinsamen Sequenzen; Namens- und Owner-Regeln pro Tenant.
- Auszug und Zusammenfassung: `docs/evidence/tenancy-tests.log` und `docs/evidence/tenancy-isolation.json`.
