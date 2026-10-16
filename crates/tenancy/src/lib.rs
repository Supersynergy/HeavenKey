#![forbid(unsafe_code)]

//! Multi-tenant isolation primitives for HeavenKey.
//!
//! Every entity (user, credential, grant, delegation, operation) belongs to
//! exactly one [`TenantId`]. All access runs through a [`TenantScope`]: the
//! scope is the only way to look up, list, create, delegate, invoke or revoke
//! records, and it binds every operation to its tenant.
//!
//! Isolation is enforced on three layers:
//!
//! 1. **Compile time** — each `with_tenant` invocation mints a fresh,
//!    unforgeable lifetime brand `'t` (generativity pattern). Records are
//!    `Record<'t, T>` values that only fit the scope they came from, so a
//!    record can never be passed to another tenant's scope — it does not
//!    compile:
//!
//!    ```compile_fail
//!    let mut store = uac_tenancy::Store::in_memory().unwrap();
//!    let a = store.create_tenant("org-a").unwrap();
//!    let b = store.create_tenant("org-b").unwrap();
//!    store
//!        .with_tenant(&a, |scope_a| {
//!            let user = scope_a.create_user("ada", false).unwrap();
//!            store.with_tenant(&b, |scope_b| {
//!                // `user` is branded for scope_a and cannot move into scope_b:
//!                scope_b.create_credential(&user, "pk", "key").unwrap();
//!                Ok(())
//!            })
//!        })
//!        .unwrap();
//!    ```
//!
//!    A record cannot even escape its own scope invocation:
//!
//!    ```compile_fail
//!    let mut store = uac_tenancy::Store::in_memory().unwrap();
//!    let a = store.create_tenant("org-a").unwrap();
//!    let mut smuggled = None;
//!    store
//!        .with_tenant(&a, |scope| {
//!            smuggled = Some(scope.create_user("ada", false).unwrap());
//!            Ok(())
//!        })
//!        .unwrap();
//!    ```
//!
//! 2. **Runtime checks** — every method that takes a `Record` re-verifies
//!    `record.tenant_id() == scope.tenant_id()` ([`Error::CrossTenant`]), and
//!    every SQL statement carries `tenant_id` in its `WHERE` clause or
//!    `INSERT` values. The tenant id used for writes always comes from the
//!    scope, never from caller-supplied data.
//!
//! 3. **Database constraints** — each entity table declares
//!    `UNIQUE (tenant_id, id)` and foreign keys are *composite* keys of the
//!    form `FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)`,
//!    so a row can never reference a row of another tenant, even bypassing
//!    this library.
//!
//! By-id entry points (for HTTP handlers that only hold identifiers) return
//! [`Error::NotFound`] for missing *and* foreign identifiers alike, so the
//! error is no existence oracle for the neighbour tenant.
//!
//! No shared sequences exist: every identifier is a random UUID v4 and table
//! names are defined `WITHOUT ROWID`, so enumeration cannot leak which
//! tenant an id belongs to or how many entities a tenant owns.
//!
//! See `docs/TENANCY.md` for the design document (German).

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::marker::PhantomData;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Error>;

/// Errors surfaced by the tenant store.
#[derive(Debug)]
pub enum Error {
    /// Underlying SQLite failure.
    Sql(rusqlite::Error),
    /// The requested tenant does not exist.
    TenantNotFound,
    /// The requested record does not exist *in this tenant* — foreign ids are
    /// reported identically so the error leaks no cross-tenant information.
    NotFound,
    /// Runtime defense-in-depth check caught a record of another tenant.
    /// Unreachable through the safe API (the brand prevents it); kept as a
    /// fail-closed guard.
    CrossTenant,
    /// A foreign-key or existence check rejected a participant id.
    Foreign,
    /// A per-tenant uniqueness constraint was hit (e.g. duplicate user name).
    Duplicate,
    /// Caller input failed validation.
    Invalid(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql(e) => write!(f, "sqlite: {e}"),
            Self::TenantNotFound => f.write_str("tenant not found"),
            Self::NotFound => f.write_str("record not found"),
            Self::CrossTenant => f.write_str("record belongs to a different tenant"),
            Self::Foreign => f.write_str("referenced record is outside this tenant"),
            Self::Duplicate => f.write_str("conflicts with an existing record in this tenant"),
            Self::Invalid(what) => write!(f, "invalid {what}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sql(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(err, _) = &e {
            use rusqlite::ffi;
            match err.extended_code {
                ffi::SQLITE_CONSTRAINT_UNIQUE | ffi::SQLITE_CONSTRAINT_PRIMARYKEY => {
                    return Self::Duplicate;
                }
                ffi::SQLITE_CONSTRAINT_FOREIGNKEY => return Self::Foreign,
                _ => {}
            }
        }
        Self::Sql(e)
    }
}

macro_rules! entity_id {
    ($(#[$meta:meta])* pub struct $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            #[must_use]
            fn new() -> Self {
                Self(Uuid::new_v4())
            }

            /// Underlying UUID v4 value.
            #[must_use]
            pub fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = Error;
            fn from_str(s: &str) -> Result<Self> {
                Uuid::from_str(s)
                    .map(Self)
                    .map_err(|_| Error::Invalid(stringify!($name)))
            }
        }
    };
}

entity_id!(
    /// Identity of a tenant (organisation). Random UUID v4 — tenants are
    /// never numbered sequentially.
    pub struct TenantId
);
entity_id!(
    /// Identity of a user row within a tenant.
    pub struct UserId
);
entity_id!(
    /// Identity of a credential row within a tenant.
    pub struct CredentialId
);
entity_id!(
    /// Identity of a grant row within a tenant.
    pub struct GrantId
);
entity_id!(
    /// Identity of a delegation row within a tenant.
    pub struct DelegationId
);
entity_id!(
    /// Identity of an operation (invocation record) within a tenant.
    pub struct OperationId
);

/// Tenant metadata as stored in the `tenants` table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tenant {
    pub id: TenantId,
    pub label: String,
    /// Unix seconds when the tenant was created.
    pub created: u64,
}

/// A user row. `owner` marks the tenant's owning account (exactly one per
/// tenant, enforced by a partial unique index).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: UserId,
    pub name: String,
    pub owner: bool,
    pub created: u64,
}

/// A passkey credential row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    pub id: CredentialId,
    pub user_id: UserId,
    pub passkey: String,
    pub label: String,
    pub active: bool,
    pub created: u64,
}

/// A stored signed grant (`token` is the opaque wire token produced by the
/// verifier layer — this crate stores it, it never interprets it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub id: GrantId,
    pub holder_id: UserId,
    pub token: String,
    pub revoked: bool,
    pub created: u64,
}

/// A stored delegation link (child grant with an optional parent link).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delegation {
    pub id: DelegationId,
    pub parent_id: Option<DelegationId>,
    pub recipient_id: UserId,
    pub delegator_id: UserId,
    pub token: String,
    pub revoked: bool,
    pub created: u64,
}

/// An executed invocation recorded against a grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Operation {
    pub id: OperationId,
    pub grant_id: GrantId,
    pub holder_id: UserId,
    pub created: u64,
}

/// A record fetched or created through a [`TenantScope`]. The `'t` brand ties
/// it to the exact scope invocation that produced it: it cannot be passed to
/// a scope of a different brand (see crate docs).
pub struct Record<'t, T> {
    tenant: TenantId,
    data: T,
    // Invariant in `'t` (and still `Send`/`Sync` when `T` is) so two scope
    // brands are never unifiable.
    _brand: PhantomData<fn(&'t ()) -> &'t ()>,
}

impl<'t, T> Record<'t, T> {
    fn new(tenant: TenantId, data: T) -> Self {
        Self {
            tenant,
            data,
            _brand: PhantomData,
        }
    }

    /// Tenant this record belongs to.
    #[must_use]
    pub fn tenant_id(&self) -> TenantId {
        self.tenant
    }

    /// The record payload.
    #[must_use]
    pub fn data(&self) -> &T {
        &self.data
    }

    /// Consume the record, returning the payload.
    #[must_use]
    pub fn into_data(self) -> T {
        self.data
    }
}

impl<'t, T: fmt::Debug> fmt::Debug for Record<'t, T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Record")
            .field("tenant", &self.tenant)
            .field("data", &self.data)
            .finish()
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn unix(created: i64) -> Result<u64> {
    u64::try_from(created).map_err(|_| Error::Invalid("timestamp"))
}

/// Multi-tenant store holding the SQLite connection and the `tenants` table.
/// All entity access goes through [`Store::with_tenant`].
pub struct Store {
    conn: Connection,
}

impl Store {
    /// In-memory reference implementation (used by tests and the lab).
    ///
    /// # Errors
    /// SQLite open/schema errors.
    pub fn in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    /// Wrap any `rusqlite` connection (e.g. a file database), enabling
    /// foreign keys and creating the tenant schema if absent.
    ///
    /// # Errors
    /// SQLite schema errors.
    pub fn from_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        initialize(&conn)?;
        Ok(Self { conn })
    }

    /// Register a new organisation. Returns its freshly generated id.
    ///
    /// # Errors
    /// `Invalid` on an empty or overlong label, `Sql` on database failure.
    pub fn create_tenant(&self, label: &str) -> Result<TenantId> {
        if label.is_empty() || label.len() > 128 {
            return Err(Error::Invalid("label"));
        }
        let id = TenantId::new();
        self.conn.execute(
            "INSERT INTO tenants(id,label,created) VALUES(?1,?2,?3)",
            params![
                id.to_string(),
                label,
                i64::try_from(now()).map_err(|_| Error::Invalid("timestamp"))?
            ],
        )?;
        Ok(id)
    }

    /// Tenant metadata lookup (operator level — outside any tenant scope).
    ///
    /// # Errors
    /// `TenantNotFound` for unknown ids, `Sql` on database failure.
    pub fn tenant_info(&self, id: &TenantId) -> Result<Tenant> {
        self.conn
            .query_row(
                "SELECT id,label,created FROM tenants WHERE id=?1",
                [id.to_string()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Error::TenantNotFound,
                other => Error::from(other),
            })
            .and_then(|(id, label, created)| {
                Ok(Tenant {
                    id: TenantId::from_str(&id)?,
                    label,
                    created: unix(created)?,
                })
            })
    }

    /// List all tenants (operator level).
    ///
    /// # Errors
    /// `Sql` on database failure.
    pub fn list_tenants(&self) -> Result<Vec<Tenant>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,label,created FROM tenants ORDER BY created,id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, label, created)| {
                Ok(Tenant {
                    id: TenantId::from_str(&id)?,
                    label,
                    created: unix(created)?,
                })
            })
            .collect()
    }

    /// Open a tenant-scoped view and run `f` inside it. Every call mints a
    /// fresh brand `'t`, so records produced inside cannot flow into any
    /// other scope — even another scope for the same tenant.
    ///
    /// # Errors
    /// `TenantNotFound` when the tenant id is unknown; otherwise whatever `f`
    /// returns.
    pub fn with_tenant<'s, R>(
        &'s self,
        tenant: &TenantId,
        f: impl for<'t> FnOnce(&mut TenantScope<'s, 't>) -> Result<R>,
    ) -> Result<R> {
        self.tenant_info(tenant)?;
        f(&mut TenantScope {
            conn: &self.conn,
            tenant: *tenant,
            _brand: PhantomData,
        })
    }
}

/// The only handle that can touch tenant data. Obtained from
/// [`Store::with_tenant`]; carries the tenant id and an unforgeable brand.
pub struct TenantScope<'s, 't> {
    conn: &'s Connection,
    tenant: TenantId,
    _brand: PhantomData<fn(&'t ()) -> &'t ()>,
}

impl<'s, 't> TenantScope<'s, 't> {
    /// The tenant this scope is bound to.
    #[must_use]
    pub fn tenant_id(&self) -> TenantId {
        self.tenant
    }

    /// Runtime defense in depth: re-verify a record's tenant before any use.
    /// Unreachable via the safe API (the brand already forbids mixing), kept
    /// so a hypothetical future construction path still fails closed.
    fn ensure<'r, T>(&self, record: &'r Record<'t, T>) -> Result<&'r T> {
        if record.tenant == self.tenant {
            Ok(&record.data)
        } else {
            Err(Error::CrossTenant)
        }
    }

    // -- users -------------------------------------------------------------

    /// Create a user inside this tenant. `name` is unique per tenant.
    ///
    /// # Errors
    /// `Duplicate` if the name is taken, `Invalid` on bad input.
    pub fn create_user(&mut self, name: &str, owner: bool) -> Result<Record<'t, User>> {
        if name.is_empty() || name.len() > 128 {
            return Err(Error::Invalid("name"));
        }
        let user = User {
            id: UserId::new(),
            name: name.to_string(),
            owner,
            created: now(),
        };
        self.conn.execute(
            "INSERT INTO users(id,tenant_id,name,owner,created) VALUES(?1,?2,?3,?4,?5)",
            params![
                user.id.to_string(),
                self.tenant.to_string(),
                user.name,
                user.owner,
                i64::try_from(user.created).map_err(|_| Error::Invalid("timestamp"))?,
            ],
        )?;
        Ok(Record::new(self.tenant, user))
    }

    /// Fetch a user by id — only inside this tenant.
    ///
    /// # Errors
    /// `Sql` on database failure.
    pub fn user(&self, id: &UserId) -> Result<Option<Record<'t, User>>> {
        self.conn
            .query_row(
                "SELECT id,name,owner,created FROM users WHERE id=?1 AND tenant_id=?2",
                params![id.to_string(), self.tenant.to_string()],
                |r| Ok(user_row(r)),
            )
            .optional()
            .map(|u| u.map(|u| Record::new(self.tenant, u)))
    }

    /// Fetch a user by per-tenant name.
    ///
    /// # Errors
    /// `Sql` on database failure.
    pub fn find_user(&self, name: &str) -> Result<Option<Record<'t, User>>> {
        self.conn
            .query_row(
                "SELECT id,name,owner,created FROM users WHERE name=?1 AND tenant_id=?2",
                params![name, self.tenant.to_string()],
                |r| Ok(user_row(r)),
            )
            .optional()
            .map(|u| u.map(|u| Record::new(self.tenant, u)))
    }

    /// List this tenant's users.
    ///
    /// # Errors
    /// `Sql` on database failure.
    pub fn list_users(&self) -> Result<Vec<Record<'t, User>>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,name,owner,created FROM users WHERE tenant_id=?1 ORDER BY created,id",
        )?;
        let rows = stmt
            .query_map([self.tenant.to_string()], |r| Ok(user_row(r)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|u| Record::new(self.tenant, u))
            .collect())
    }

    // -- credentials -------------------------------------------------------

    /// Register a passkey credential for a user of this tenant.
    ///
    /// # Errors
    /// `CrossTenant`/`Foreign` if the user record is not of this tenant.
    pub fn create_credential(
        &mut self,
        user: &Record<'t, User>,
        passkey: &str,
        label: &str,
    ) -> Result<Record<'t, Credential>> {
        let user = self.ensure(user)?;
        self.create_credential_id(&user.id, passkey, label)
    }

    /// Id-based variant for handler code that only holds identifiers.
    ///
    /// # Errors
    /// `NotFound` if the user id is unknown *or foreign* (uniform error).
    pub fn create_credential_id(
        &mut self,
        user_id: &UserId,
        passkey: &str,
        label: &str,
    ) -> Result<Record<'t, Credential>> {
        self.require_user(user_id)?;
        let credential = Credential {
            id: CredentialId::new(),
            user_id: *user_id,
            passkey: passkey.to_string(),
            label: label.to_string(),
            active: true,
            created: now(),
        };
        self.conn.execute(
            "INSERT INTO credentials(id,tenant_id,user_id,passkey,label,active,created) VALUES(?1,?2,?3,?4,?5,1,?6)",
            params![
                credential.id.to_string(),
                self.tenant.to_string(),
                credential.user_id.to_string(),
                credential.passkey,
                credential.label,
                i64::try_from(credential.created).map_err(|_| Error::Invalid("timestamp"))?,
            ],
        )?;
        Ok(Record::new(self.tenant, credential))
    }

    /// List a user's credentials (tenant-filtered).
    ///
    /// # Errors
    /// `CrossTenant` on foreign records, `Sql` on database failure.
    pub fn list_credentials(&self, user: &Record<'t, User>) -> Result<Vec<Record<'t, Credential>>> {
        let user = self.ensure(user)?;
        let mut stmt = self.conn.prepare(
            "SELECT id,user_id,passkey,label,active,created FROM credentials WHERE tenant_id=?1 AND user_id=?2 ORDER BY created,id",
        )?;
        let rows = stmt
            .query_map(params![self.tenant.to_string(), user.id.to_string()], |r| {
                Ok(credential_row(r))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|c| Record::new(self.tenant, c))
            .collect())
    }

    /// Deactivate a credential of this tenant.
    ///
    /// # Errors
    /// `NotFound` if unknown in this tenant.
    pub fn deactivate_credential(&mut self, credential: &Record<'t, Credential>) -> Result<()> {
        let credential = self.ensure(credential)?;
        self.deactivate_credential_id(&credential.id)
    }

    /// Id-based deactivation; `NotFound` for missing or foreign ids alike.
    pub fn deactivate_credential_id(&mut self, id: &CredentialId) -> Result<()> {
        affected(self.conn.execute(
            "UPDATE credentials SET active=0 WHERE id=?1 AND tenant_id=?2",
            params![id.to_string(), self.tenant.to_string()],
        )?)
    }

    // -- grants --------------------------------------------------------------

    /// Store a signed grant for a holder user of this tenant.
    ///
    /// # Errors
    /// `CrossTenant`/`Foreign` if the holder is not of this tenant.
    pub fn create_grant(
        &mut self,
        holder: &Record<'t, User>,
        token: &str,
    ) -> Result<Record<'t, Grant>> {
        let holder = self.ensure(holder)?;
        self.create_grant_id(&holder.id, token)
    }

    /// Id-based grant creation.
    ///
    /// # Errors
    /// `NotFound` if the holder id is unknown or foreign.
    pub fn create_grant_id(
        &mut self,
        holder_id: &UserId,
        token: &str,
    ) -> Result<Record<'t, Grant>> {
        self.require_user(holder_id)?;
        let grant = Grant {
            id: GrantId::new(),
            holder_id: *holder_id,
            token: token.to_string(),
            revoked: false,
            created: now(),
        };
        self.conn.execute(
            "INSERT INTO grants(id,tenant_id,holder_id,token,revoked,created) VALUES(?1,?2,?3,?4,0,?5)",
            params![
                grant.id.to_string(),
                self.tenant.to_string(),
                grant.holder_id.to_string(),
                grant.token,
                i64::try_from(grant.created).map_err(|_| Error::Invalid("timestamp"))?,
            ],
        )?;
        Ok(Record::new(self.tenant, grant))
    }

    /// Fetch a grant by id — only inside this tenant.
    ///
    /// # Errors
    /// `Sql` on database failure.
    pub fn grant(&self, id: &GrantId) -> Result<Option<Record<'t, Grant>>> {
        self.conn
            .query_row(
                "SELECT id,holder_id,token,revoked,created FROM grants WHERE id=?1 AND tenant_id=?2",
                params![id.to_string(), self.tenant.to_string()],
                |r| Ok(grant_row(r)),
            )
            .optional()
            .map(|g| g.map(|g| Record::new(self.tenant, g)))
    }

    /// List this tenant's grants.
    ///
    /// # Errors
    /// `Sql` on database failure.
    pub fn list_grants(&self) -> Result<Vec<Record<'t, Grant>>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,holder_id,token,revoked,created FROM grants WHERE tenant_id=?1 ORDER BY created,id",
        )?;
        let rows = stmt
            .query_map([self.tenant.to_string()], |r| Ok(grant_row(r)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|g| Record::new(self.tenant, g))
            .collect())
    }

    /// Revoke a grant of this tenant.
    ///
    /// # Errors
    /// `CrossTenant` on foreign records, `NotFound` if unknown here.
    pub fn revoke_grant(&mut self, grant: &Record<'t, Grant>) -> Result<()> {
        let grant = self.ensure(grant)?;
        self.revoke_grant_id(&grant.id)
    }

    /// Id-based revocation; `NotFound` for missing or foreign ids alike.
    pub fn revoke_grant_id(&mut self, id: &GrantId) -> Result<()> {
        affected(self.conn.execute(
            "UPDATE grants SET revoked=1 WHERE id=?1 AND tenant_id=?2",
            params![id.to_string(), self.tenant.to_string()],
        )?)
    }

    // -- delegations ---------------------------------------------------------

    /// Store a delegation link. `parent` (if any), `delegator` and `recipient`
    /// must all be records of this tenant — the brands guarantee it at
    /// compile time, `ensure` re-checks at runtime, and the composite foreign
    /// keys enforce it in SQLite itself.
    ///
    /// # Errors
    /// `CrossTenant`/`Foreign` on foreign participants, `NotFound` if the
    /// parent is unknown or already revoked.
    pub fn create_delegation(
        &mut self,
        parent: Option<&Record<'t, Delegation>>,
        delegator: &Record<'t, User>,
        recipient: &Record<'t, User>,
        token: &str,
    ) -> Result<Record<'t, Delegation>> {
        let parent_id = parent.map(|p| self.ensure(p).map(|p| p.id)).transpose()?;
        let delegator = self.ensure(delegator)?;
        let recipient = self.ensure(recipient)?;
        self.insert_delegation(parent_id.as_ref(), &delegator.id, &recipient.id, token)
    }

    /// Id-based delegation creation for handler code. A parent id that is
    /// missing, revoked or foreign produces `NotFound`; participant ids that
    /// are missing or foreign produce `NotFound` as well.
    ///
    /// # Errors
    /// `NotFound` for unknown/foreign ids, `Sql` on database failure.
    pub fn create_delegation_id(
        &mut self,
        parent: Option<&DelegationId>,
        delegator_id: &UserId,
        recipient_id: &UserId,
        token: &str,
    ) -> Result<Record<'t, Delegation>> {
        self.insert_delegation(parent, delegator_id, recipient_id, token)
    }

    fn insert_delegation(
        &self,
        parent: Option<&DelegationId>,
        delegator_id: &UserId,
        recipient_id: &UserId,
        token: &str,
    ) -> Result<Record<'t, Delegation>> {
        // Atomic pre-checks + insert so the parent cannot be revoked between
        // validation and write. Composite FKs provide a third guard anyway.
        let tx = self.conn.unchecked_transaction()?;
        if let Some(parent) = parent {
            let active: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM delegations WHERE id=?1 AND tenant_id=?2 AND revoked=0)",
                params![parent.to_string(), self.tenant.to_string()],
                |r| r.get(0),
            )?;
            if !active {
                return Err(Error::NotFound);
            }
        }
        for user_id in [delegator_id, recipient_id] {
            let known: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND tenant_id=?2)",
                params![user_id.to_string(), self.tenant.to_string()],
                |r| r.get(0),
            )?;
            if !known {
                return Err(Error::NotFound);
            }
        }
        if delegator_id == recipient_id {
            return Err(Error::Invalid("delegator/recipient"));
        }
        let delegation = Delegation {
            id: DelegationId::new(),
            parent_id: parent.copied(),
            recipient_id: *recipient_id,
            delegator_id: *delegator_id,
            token: token.to_string(),
            revoked: false,
            created: now(),
        };
        tx.execute(
            "INSERT INTO delegations(id,tenant_id,parent_id,recipient_id,delegator_id,token,revoked,created) VALUES(?1,?2,?3,?4,?5,?6,0,?7)",
            params![
                delegation.id.to_string(),
                self.tenant.to_string(),
                delegation.parent_id.map(|p| p.to_string()),
                delegation.recipient_id.to_string(),
                delegation.delegator_id.to_string(),
                delegation.token,
                i64::try_from(delegation.created).map_err(|_| Error::Invalid("timestamp"))?,
            ],
        )?;
        tx.commit()?;
        Ok(Record::new(self.tenant, delegation))
    }

    /// Fetch a delegation by id — only inside this tenant.
    ///
    /// # Errors
    /// `Sql` on database failure.
    pub fn delegation(&self, id: &DelegationId) -> Result<Option<Record<'t, Delegation>>> {
        self.conn
            .query_row(
                "SELECT id,parent_id,recipient_id,delegator_id,token,revoked,created FROM delegations WHERE id=?1 AND tenant_id=?2",
                params![id.to_string(), self.tenant.to_string()],
                |r| Ok(delegation_row(r)),
            )
            .optional()
            .map(|d| d.map(|d| Record::new(self.tenant, d)))
    }

    /// List this tenant's delegations.
    ///
    /// # Errors
    /// `Sql` on database failure.
    pub fn list_delegations(&self) -> Result<Vec<Record<'t, Delegation>>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,parent_id,recipient_id,delegator_id,token,revoked,created FROM delegations WHERE tenant_id=?1 ORDER BY created,id",
        )?;
        let rows = stmt
            .query_map([self.tenant.to_string()], |r| Ok(delegation_row(r)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|d| Record::new(self.tenant, d))
            .collect())
    }

    /// Revoke a delegation of this tenant.
    ///
    /// # Errors
    /// `CrossTenant` on foreign records, `NotFound` if unknown here.
    pub fn revoke_delegation(&mut self, delegation: &Record<'t, Delegation>) -> Result<()> {
        let delegation = self.ensure(delegation)?;
        self.revoke_delegation_id(&delegation.id)
    }

    /// Id-based revocation; `NotFound` for missing or foreign ids alike.
    pub fn revoke_delegation_id(&mut self, id: &DelegationId) -> Result<()> {
        affected(self.conn.execute(
            "UPDATE delegations SET revoked=1 WHERE id=?1 AND tenant_id=?2",
            params![id.to_string(), self.tenant.to_string()],
        )?)
    }

    // -- invocations ---------------------------------------------------------

    /// Record an invocation of a grant by its holder. The `INSERT … WHERE
    /// EXISTS` is a single atomic statement: the grant must exist *in this
    /// tenant*, belong to the holder and be unrevoked, otherwise the write
    /// simply does not happen.
    ///
    /// # Errors
    /// `NotFound` for foreign/revoked/mismatched ids.
    pub fn invoke(
        &mut self,
        grant: &Record<'t, Grant>,
        holder: &Record<'t, User>,
    ) -> Result<Record<'t, Operation>> {
        let grant = self.ensure(grant)?;
        let holder = self.ensure(holder)?;
        self.invoke_id(&grant.id, &holder.id)
    }

    /// Id-based invocation.
    ///
    /// # Errors
    /// `NotFound` for missing, foreign, revoked or mismatched ids alike.
    pub fn invoke_id(
        &mut self,
        grant_id: &GrantId,
        holder_id: &UserId,
    ) -> Result<Record<'t, Operation>> {
        let operation = Operation {
            id: OperationId::new(),
            grant_id: *grant_id,
            holder_id: *holder_id,
            created: now(),
        };
        affected(self.conn.execute(
            "INSERT INTO operations(id,tenant_id,grant_id,holder_id,created)
             SELECT ?1,?2,?3,?4,?5
             WHERE EXISTS(SELECT 1 FROM grants WHERE id=?3 AND tenant_id=?2 AND holder_id=?4 AND revoked=0)",
            params![
                operation.id.to_string(),
                self.tenant.to_string(),
                operation.grant_id.to_string(),
                operation.holder_id.to_string(),
                i64::try_from(operation.created).map_err(|_| Error::Invalid("timestamp"))?,
            ],
        )?)?;
        Ok(Record::new(self.tenant, operation))
    }

    /// List this tenant's recorded invocations.
    ///
    /// # Errors
    /// `Sql` on database failure.
    pub fn list_operations(&self) -> Result<Vec<Record<'t, Operation>>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,grant_id,holder_id,created FROM operations WHERE tenant_id=?1 ORDER BY created,id",
        )?;
        let rows = stmt
            .query_map([self.tenant.to_string()], |r| Ok(operation_row(r)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|o| Record::new(self.tenant, o))
            .collect())
    }

    // -- internals -----------------------------------------------------------

    fn require_user(&self, id: &UserId) -> Result<()> {
        let known: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND tenant_id=?2)",
            params![id.to_string(), self.tenant.to_string()],
            |r| r.get(0),
        )?;
        if known { Ok(()) } else { Err(Error::NotFound) }
    }
}

/// Map "0 rows touched" to the uniform `NotFound` error.
fn affected(rows: usize) -> Result<()> {
    if rows == 0 {
        Err(Error::NotFound)
    } else {
        Ok(())
    }
}

trait OptionalExt<T> {
    fn optional(self) -> Result<Option<T>>;
}

impl<T> OptionalExt<T> for std::result::Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Error::from(e)),
        }
    }
}

fn user_row(r: &rusqlite::Row<'_>) -> User {
    User {
        id: UserId::from_str(&r.get_unwrap::<_, String>(0)).expect("uuid stored by this crate"),
        name: r.get_unwrap(1),
        owner: r.get_unwrap(2),
        created: r.get_unwrap::<_, i64>(3) as u64,
    }
}

fn credential_row(r: &rusqlite::Row<'_>) -> Credential {
    Credential {
        id: CredentialId::from_str(&r.get_unwrap::<_, String>(0))
            .expect("uuid stored by this crate"),
        user_id: UserId::from_str(&r.get_unwrap::<_, String>(1))
            .expect("uuid stored by this crate"),
        passkey: r.get_unwrap(2),
        label: r.get_unwrap(3),
        active: r.get_unwrap(4),
        created: r.get_unwrap::<_, i64>(5) as u64,
    }
}

fn grant_row(r: &rusqlite::Row<'_>) -> Grant {
    Grant {
        id: GrantId::from_str(&r.get_unwrap::<_, String>(0)).expect("uuid stored by this crate"),
        holder_id: UserId::from_str(&r.get_unwrap::<_, String>(1))
            .expect("uuid stored by this crate"),
        token: r.get_unwrap(2),
        revoked: r.get_unwrap(3),
        created: r.get_unwrap::<_, i64>(4) as u64,
    }
}

fn delegation_row(r: &rusqlite::Row<'_>) -> Delegation {
    Delegation {
        id: DelegationId::from_str(&r.get_unwrap::<_, String>(0))
            .expect("uuid stored by this crate"),
        parent_id: r
            .get_unwrap::<_, Option<String>>(1)
            .map(|p| DelegationId::from_str(&p).expect("uuid stored by this crate")),
        recipient_id: UserId::from_str(&r.get_unwrap::<_, String>(2))
            .expect("uuid stored by this crate"),
        delegator_id: UserId::from_str(&r.get_unwrap::<_, String>(3))
            .expect("uuid stored by this crate"),
        token: r.get_unwrap(4),
        revoked: r.get_unwrap(5),
        created: r.get_unwrap::<_, i64>(6) as u64,
    }
}

fn operation_row(r: &rusqlite::Row<'_>) -> Operation {
    Operation {
        id: OperationId::from_str(&r.get_unwrap::<_, String>(0))
            .expect("uuid stored by this crate"),
        grant_id: GrantId::from_str(&r.get_unwrap::<_, String>(1))
            .expect("uuid stored by this crate"),
        holder_id: UserId::from_str(&r.get_unwrap::<_, String>(2))
            .expect("uuid stored by this crate"),
        created: r.get_unwrap::<_, i64>(3) as u64,
    }
}

fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tenants(
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 128),
            created INTEGER NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS users(
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            name TEXT NOT NULL,
            owner INTEGER NOT NULL DEFAULT 0 CHECK(owner IN (0,1)),
            created INTEGER NOT NULL,
            UNIQUE(tenant_id, id),
            UNIQUE(tenant_id, name)
        ) WITHOUT ROWID;
        -- exactly one owner per tenant (the api's global one_owner index,
        -- partitioned by tenant)
        CREATE UNIQUE INDEX IF NOT EXISTS one_owner_per_tenant ON users(tenant_id) WHERE owner=1;

        CREATE TABLE IF NOT EXISTS credentials(
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            user_id TEXT NOT NULL,
            passkey TEXT NOT NULL,
            label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 48),
            active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
            created INTEGER NOT NULL,
            UNIQUE(tenant_id, id),
            FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS credentials_user_active ON credentials(tenant_id, user_id, active);

        CREATE TABLE IF NOT EXISTS grants(
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            holder_id TEXT NOT NULL,
            token TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
            created INTEGER NOT NULL,
            UNIQUE(tenant_id, id),
            FOREIGN KEY (tenant_id, holder_id) REFERENCES users(tenant_id, id)
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS delegations(
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            parent_id TEXT,
            recipient_id TEXT NOT NULL,
            delegator_id TEXT NOT NULL,
            token TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
            created INTEGER NOT NULL,
            UNIQUE(tenant_id, id),
            FOREIGN KEY (tenant_id, parent_id) REFERENCES delegations(tenant_id, id),
            FOREIGN KEY (tenant_id, recipient_id) REFERENCES users(tenant_id, id),
            FOREIGN KEY (tenant_id, delegator_id) REFERENCES users(tenant_id, id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS delegations_recipient ON delegations(tenant_id, recipient_id);
        CREATE INDEX IF NOT EXISTS delegations_delegator ON delegations(tenant_id, delegator_id);

        CREATE TABLE IF NOT EXISTS operations(
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            grant_id TEXT NOT NULL,
            holder_id TEXT NOT NULL,
            created INTEGER NOT NULL,
            FOREIGN KEY (tenant_id, grant_id) REFERENCES grants(tenant_id, id),
            FOREIGN KEY (tenant_id, holder_id) REFERENCES users(tenant_id, id)
        ) WITHOUT ROWID;",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids_of<'t, T>(records: &[Record<'t, T>], f: impl Fn(&T) -> Uuid) -> Vec<Uuid> {
        records.iter().map(|r| f(r.data())).collect()
    }

    /// Two tenants with a full set of entities in A; returns the ids an
    /// attacker in B would have to guess (which in tests they *know*).
    struct Fixture {
        store: Store,
        a: TenantId,
        b: TenantId,
        a_user: UserId,
        a_other: UserId,
        a_cred: CredentialId,
        a_grant: GrantId,
        a_delegation: DelegationId,
    }

    fn fixture() -> Fixture {
        let store = Store::in_memory().expect("store");
        let a = store.create_tenant("org-a").expect("tenant a");
        let b = store.create_tenant("org-b").expect("tenant b");
        let (a_user, a_other, a_cred, a_grant, a_delegation) = store
            .with_tenant(&a, |s| {
                let user = s.create_user("alice", true)?;
                let other = s.create_user("bob", false)?;
                let cred = s.create_credential(&user, "pk-a", "laptop")?;
                let grant = s.create_grant(&user, "token-a")?;
                let delegation = s.create_delegation(None, &user, &other, "deleg-a")?;
                Ok((
                    user.data().id,
                    other.data().id,
                    cred.data().id,
                    grant.data().id,
                    delegation.data().id,
                ))
            })
            .expect("fixture a");
        Fixture {
            store,
            a,
            b,
            a_user,
            a_other,
            a_cred,
            a_grant,
            a_delegation,
        }
    }

    #[test]
    fn reads_cannot_cross_tenants() {
        let f = fixture();
        f.store
            .with_tenant(&f.b, |s| {
                // Guessing every real id of tenant A yields nothing.
                assert!(s.user(&f.a_user).unwrap().is_none());
                assert!(s.user(&f.a_other).unwrap().is_none());
                assert!(s.find_user("alice").unwrap().is_none());
                assert!(s.grant(&f.a_grant).unwrap().is_none());
                assert!(s.delegation(&f.a_delegation).unwrap().is_none());
                assert!(s.list_users().unwrap().is_empty());
                assert!(s.list_grants().unwrap().is_empty());
                assert!(s.list_delegations().unwrap().is_empty());
                assert!(s.list_operations().unwrap().is_empty());
                Ok(())
            })
            .unwrap();
        // Tenant A still sees its own data.
        f.store
            .with_tenant(&f.a, |s| {
                assert_eq!(s.list_users().unwrap().len(), 2);
                assert_eq!(s.list_grants().unwrap().len(), 1);
                assert_eq!(s.list_delegations().unwrap().len(), 1);
                let g = s.grant(&f.a_grant).unwrap().unwrap();
                assert_eq!(g.tenant_id(), f.a);
                assert_eq!(g.data().holder_id, f.a_user);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn writes_cannot_cross_tenants() {
        let f = fixture();
        f.store
            .with_tenant(&f.b, |s| {
                assert!(matches!(
                    s.revoke_grant_id(&f.a_grant),
                    Err(Error::NotFound)
                ));
                assert!(matches!(
                    s.revoke_delegation_id(&f.a_delegation),
                    Err(Error::NotFound)
                ));
                assert!(matches!(
                    s.deactivate_credential_id(&f.a_cred),
                    Err(Error::NotFound)
                ));
                assert!(matches!(
                    s.create_grant_id(&f.a_user, "x"),
                    Err(Error::NotFound)
                ));
                assert!(matches!(
                    s.create_credential_id(&f.a_user, "pk", "lbl"),
                    Err(Error::NotFound)
                ));
                Ok(())
            })
            .unwrap();
        // Nothing changed on tenant A's side.
        f.store
            .with_tenant(&f.a, |s| {
                assert!(!s.grant(&f.a_grant).unwrap().unwrap().data().revoked);
                assert!(
                    !s.delegation(&f.a_delegation)
                        .unwrap()
                        .unwrap()
                        .data()
                        .revoked
                );
                let owner = s.user(&f.a_user).unwrap().unwrap();
                let creds = s.list_credentials(&owner).unwrap();
                assert!(creds.iter().all(|c| c.data().active));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn delegation_cannot_cross_tenants() {
        let f = fixture();
        f.store
            .with_tenant(&f.b, |s| {
                let bob_b = s.create_user("bob", false)?;
                let eve_b = s.create_user("eve", false)?;
                // Foreign parent, foreign delegator, foreign recipient.
                assert!(matches!(
                    s.create_delegation_id(
                        Some(&f.a_delegation),
                        &bob_b.data().id,
                        &eve_b.data().id,
                        "x"
                    ),
                    Err(Error::NotFound)
                ));
                assert!(matches!(
                    s.create_delegation_id(None, &f.a_user, &eve_b.data().id, "x"),
                    Err(Error::NotFound)
                ));
                assert!(matches!(
                    s.create_delegation_id(None, &bob_b.data().id, &f.a_other, "x"),
                    Err(Error::NotFound)
                ));
                assert!(s.list_delegations().unwrap().is_empty());
                // Sanity: a pure-B delegation does work.
                let d = s.create_delegation(None, &bob_b, &eve_b, "t")?;
                assert_eq!(d.tenant_id(), f.b);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn invocation_cannot_cross_tenants() {
        let f = fixture();
        // B cannot record an invocation against A's grant — with a foreign
        // holder id, with B's own holder id, not at all.
        f.store
            .with_tenant(&f.b, |s| {
                let b_user = s.create_user("mallory", false)?;
                assert!(matches!(
                    s.invoke_id(&f.a_grant, &f.a_user),
                    Err(Error::NotFound)
                ));
                assert!(matches!(
                    s.invoke_id(&f.a_grant, &b_user.data().id),
                    Err(Error::NotFound)
                ));
                assert!(s.list_operations().unwrap().is_empty());
                Ok(())
            })
            .unwrap();
        // A cannot invoke as B's holder either; A's own holder works.
        let b_user = f
            .store
            .with_tenant(&f.b, |s| {
                Ok(s.find_user("mallory").unwrap().unwrap().data().id)
            })
            .unwrap();
        f.store
            .with_tenant(&f.a, |s| {
                assert!(matches!(
                    s.invoke_id(&f.a_grant, &b_user),
                    Err(Error::NotFound)
                ));
                let op = s.invoke_id(&f.a_grant, &f.a_user)?;
                assert_eq!(op.tenant_id(), f.a);
                assert_eq!(op.data().grant_id, f.a_grant);
                assert_eq!(s.list_operations().unwrap().len(), 1);
                Ok(())
            })
            .unwrap();
        // And B still sees no operations.
        f.store
            .with_tenant(&f.b, |s| {
                assert!(s.list_operations().unwrap().is_empty());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn revoke_then_invoke_fails_closed() {
        let store = Store::in_memory().unwrap();
        let t = store.create_tenant("org").unwrap();
        store
            .with_tenant(&t, |s| {
                let u = s.create_user("alice", true)?;
                let g = s.create_grant(&u, "token")?;
                s.revoke_grant(&g)?;
                assert!(matches!(
                    s.invoke_id(&g.data().id, &u.data().id),
                    Err(Error::NotFound)
                ));
                // A revoked delegation cannot parent a new link.
                let v = s.create_user("bob", false)?;
                let w = s.create_user("carol", false)?;
                let d = s.create_delegation(None, &v, &w, "t")?;
                s.revoke_delegation(&d)?;
                assert!(matches!(
                    s.create_delegation_id(Some(&d.data().id), &v.data().id, &w.data().id, "x"),
                    Err(Error::NotFound)
                ));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn no_shared_sequences_and_per_tenant_names() {
        let store = Store::in_memory().unwrap();
        let a = store.create_tenant("org-a").unwrap();
        let b = store.create_tenant("org-b").unwrap();
        // The same name may exist in both tenants under different ids;
        // inside one tenant it stays unique.
        let (ua, ub) = (
            store
                .with_tenant(&a, |s| Ok(s.create_user("alice", true)?.data().id))
                .unwrap(),
            store
                .with_tenant(&b, |s| Ok(s.create_user("alice", false)?.data().id))
                .unwrap(),
        );
        assert_ne!(ua, ub);
        assert_eq!(ua.as_uuid().get_version_num(), 4);
        store
            .with_tenant(&a, |s| {
                assert!(matches!(
                    s.create_user("alice", false),
                    Err(Error::Duplicate)
                ));
                // A second owner in one tenant is rejected, but each tenant
                // may have its own owner.
                assert!(matches!(
                    s.create_user("second", true),
                    Err(Error::Duplicate)
                ));
                Ok(())
            })
            .unwrap();
        store
            .with_tenant(&b, |s| {
                assert!(s.create_user("owner-b", true).is_ok());
                Ok(())
            })
            .unwrap();
        // All generated ids are unique and v4 — no enumerable sequence.
        let mut seen = std::collections::BTreeSet::new();
        store
            .with_tenant(&a, |s| {
                let u = s.list_users()?;
                let g = s.list_grants()?;
                let d = s.list_delegations()?;
                seen.extend(ids_of(&u, |x| x.id.as_uuid()));
                seen.extend(ids_of(&g, |x| x.id.as_uuid()));
                seen.extend(ids_of(&d, |x| x.id.as_uuid()));
                for id in &seen {
                    assert_eq!(id.get_version_num(), 4);
                }
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn runtime_check_rejects_forged_records() {
        // Even if a record with a mismatched tenant stamp were constructed
        // (the safe API cannot produce one — tests reach the private fields),
        // the runtime check fails closed.
        let f = fixture();
        f.store
            .with_tenant(&f.a, |s| {
                // Forging a *stamped* record of tenant B inside tenant A's
                // scope is still possible in raw Rust — the runtime check
                // must catch it even though the brand already fits.
                let forged = Record::new(
                    f.b,
                    Grant {
                        id: f.a_grant,
                        holder_id: f.a_user,
                        token: "token-a".into(),
                        revoked: false,
                        created: 0,
                    },
                );
                assert!(matches!(s.ensure(&forged), Err(Error::CrossTenant)));
                assert!(matches!(s.revoke_grant(&forged), Err(Error::CrossTenant)));
                // And nothing was revoked.
                assert!(!s.grant(&f.a_grant).unwrap().unwrap().data().revoked);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn unknown_tenant_and_operator_views() {
        let store = Store::in_memory().unwrap();
        let ghost = TenantId::new();
        assert!(matches!(
            store.with_tenant(&ghost, |_| Ok(())),
            Err(Error::TenantNotFound)
        ));
        assert!(matches!(
            store.tenant_info(&ghost),
            Err(Error::TenantNotFound)
        ));
        let a = store.create_tenant("org-a").unwrap();
        let b = store.create_tenant("org-b").unwrap();
        assert_eq!(store.list_tenants().unwrap().len(), 2);
        assert_eq!(store.tenant_info(&a).unwrap().label, "org-a");
        assert_eq!(store.tenant_info(&b).unwrap().label, "org-b");
    }

    #[test]
    fn ids_roundtrip_through_serde_and_strings() {
        let store = Store::in_memory().unwrap();
        let t = store.create_tenant("org").unwrap();
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<TenantId>(&json).unwrap(), t);
        assert_eq!(TenantId::from_str(&t.to_string()).unwrap(), t);
        assert!(TenantId::from_str("not-a-uuid").is_err());
    }
}
