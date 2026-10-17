#![forbid(unsafe_code)]

mod broker_agent;
mod desktop;
mod hosting;
mod password_manager;
mod platform;
mod store;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::SigningKey;
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uac_verifier::delegation::{self, DelegationGrant};
use uac_verifier::{Action, Grant, Signed, authorize_passkey_grant, grant_id, sign_grant};
use uuid::Uuid;
use webauthn_rs::prelude::*;

const RESOURCE: &str = "urn:uac:lab:document";
const CEREMONY_TTL: u64 = 120;
const MAX_PENDING: usize = 128;
const MAX_CREDENTIALS: usize = 8;
const MAX_APPROVALS: usize = 128;
const APPROVAL_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
struct App {
    inner: Arc<Mutex<Inner>>,
    origin: String,
    host: String,
    document: Arc<str>,
}
struct Inner {
    db: Connection,
    webauthn: Webauthn,
    issuer: SigningKey,
    bootstrap_hash: [u8; 32],
    registrations: HashMap<String, Registration>,
    enrollments: HashMap<String, Enrollment>,
    authentications: HashMap<String, Authentication>,
    approvals: HashMap<String, Approval>,
    sessions: HashMap<String, Session>,
    platform: platform::Platform,
}
struct Registration {
    name: String,
    user_id: Uuid,
    owner: bool,
    state: PasskeyRegistration,
    expires: u64,
}
struct Authentication {
    user: User,
    state: PasskeyAuthentication,
    invocation: Option<Invocation>,
    management: Option<ManagementCeremony>,
    delegation_invocation: Option<DelegationInvocation>,
    expires: u64,
}
struct ManagementCeremony {
    operation: Management,
    session_token: String,
}
struct Approval {
    user_id: String,
    session_token: String,
    credential_id: String,
    operation: Management,
    expires: Instant,
}
struct Enrollment {
    user_id: String,
    session_token: String,
    authorizing_credential_id: String,
    label: String,
    state: PasskeyRegistration,
    expires: u64,
}
struct Session {
    user_id: String,
    credential_id: String,
    expires: u64,
}
struct User {
    id: String,
    name: String,
    owner: bool,
    subject: [u8; 32],
}
struct Credential {
    id: String,
    passkey: Passkey,
    counter: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisterStart {
    name: String,
    bootstrap_token: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisterFinish {
    request_id: String,
    credential: RegisterPublicKeyCredential,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Invocation {
    grant: Signed<Grant>,
    resource: String,
    action: Action,
    arguments: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegationInvocation {
    id: String,
    resource: String,
    action: Action,
    arguments: std::collections::BTreeMap<String, String>,
}
struct DelegationRecord {
    id: String,
    parent_id: Option<String>,
    recipient_id: String,
    delegator_id: String,
    grant: Signed<DelegationGrant>,
    revoked: bool,
}
struct DelegationChain {
    chain: Vec<Signed<DelegationGrant>>,
    revoked: BTreeSet<[u8; 32]>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthStart {
    name: String,
    invocation: Option<Invocation>,
    management: Option<Management>,
    delegation_invocation: Option<DelegationInvocation>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthFinish {
    request_id: String,
    credential: PublicKeyCredential,
    invocation: Option<Invocation>,
    management: Option<Management>,
    delegation_invocation: Option<DelegationInvocation>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Management {
    CredentialAdd {
        label: String,
    },
    CredentialRevoke {
        id: String,
    },
    GrantCreate {
        guest_name: String,
        ttl_seconds: u64,
    },
    GrantRevoke {
        id: String,
    },
    DelegationCreate {
        guest_name: String,
        ttl_seconds: u64,
        remaining_delegations: u8,
    },
    DelegationDelegate {
        parent_id: String,
        guest_name: String,
        ttl_seconds: u64,
        remaining_delegations: u8,
    },
    DelegationRevoke {
        id: String,
    },
    RecoveryRotate,
    RecoveryDisable,
    AgentCreate {
        spec: platform::AgentSpec,
    },
    AgentRevoke {
        id: String,
    },
    VaultWrite {
        expected_revision: u64,
        digest: String,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegationCreate {
    guest_name: String,
    ttl_seconds: u64,
    remaining_delegations: u8,
    approval_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegationDelegate {
    parent_id: String,
    guest_name: String,
    ttl_seconds: u64,
    remaining_delegations: u8,
    approval_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegationRevoke {
    id: String,
    approval_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantCreate {
    guest_name: String,
    ttl_seconds: u64,
    approval_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantRevoke {
    id: String,
    approval_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialStart {
    label: String,
    approval_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialRevoke {
    id: String,
    approval_id: Option<String>,
}

#[derive(Debug)]
struct ApiError(StatusCode, &'static str);
type ApiResult<T> = Result<T, ApiError>;
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn internal(error: impl std::fmt::Debug) -> ApiError {
    eprintln!("UAC internal error: {error:?}");
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
}
fn forbidden(code: &'static str) -> ApiError {
    ApiError(StatusCode::FORBIDDEN, code)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
fn credential_id(key: &Passkey) -> String {
    URL_SAFE_NO_PAD.encode(key.cred_id().as_ref())
}
fn session_token(headers: &HeaderMap) -> ApiResult<&str> {
    headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "session_required"))
}
fn credential_label(label: &str) -> ApiResult<String> {
    let label = label.trim();
    if !(1..=48).contains(&label.chars().count()) || label.chars().any(char::is_control) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_label"));
    }
    Ok(label.to_owned())
}
fn token_id(grant: &Signed<Grant>) -> ApiResult<String> {
    grant_id(grant)
        .map(|id| URL_SAFE_NO_PAD.encode(id))
        .map_err(internal)
}
fn binding<T: Serialize>(invocation: &Option<T>) -> ApiResult<[u8; 32]> {
    Ok(Sha256::digest(serde_json::to_vec(invocation).map_err(internal)?).into())
}

impl Inner {
    fn prune(&mut self) {
        let time = now();
        self.platform.prune();
        self.registrations.retain(|_, v| v.expires > time);
        self.enrollments.retain(|_, v| v.expires > time);
        self.authentications.retain(|_, v| v.expires > time);
        let instant = Instant::now();
        self.approvals.retain(|_, v| v.expires > instant);
        self.sessions.retain(|_, v| v.expires > time);
    }
    fn user(&self, field: &str, value: &str) -> ApiResult<User> {
        let query = match field {
            "id" => "SELECT id,name,owner,credential_id FROM users WHERE id=?1",
            _ => "SELECT id,name,owner,credential_id FROM users WHERE name=?1",
        };
        let row = self
            .db
            .query_row(query, [value], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .optional()
            .map_err(internal)?;
        let (id, name, owner, subject_id) =
            row.ok_or(ApiError(StatusCode::NOT_FOUND, "user_not_found"))?;
        Ok(User {
            id,
            name,
            owner,
            subject: Sha256::digest(URL_SAFE_NO_PAD.decode(subject_id).map_err(internal)?).into(),
        })
    }
    fn active_credentials(&self, user_id: &str) -> ApiResult<Vec<Credential>> {
        let mut stmt = self
            .db
            .prepare("SELECT id,passkey,counter FROM credentials WHERE user_id=?1 AND active=1 ORDER BY created,id")
            .map_err(internal)?;
        let rows = stmt
            .query_map([user_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u32>(2)?,
                ))
            })
            .map_err(internal)?;
        rows.map(|row| {
            let (id, passkey, counter) = row.map_err(internal)?;
            Ok(Credential {
                id,
                passkey: serde_json::from_str(&passkey).map_err(internal)?,
                counter,
            })
        })
        .collect()
    }
    fn credential_active(&self, user_id: &str, id: &str) -> ApiResult<bool> {
        self.db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM credentials WHERE user_id=?1 AND id=?2 AND active=1)",
                params![user_id, id],
                |r| r.get(0),
            )
            .map_err(internal)
    }
    fn check_credential_capacity(&self, user_id: &str) -> ApiResult<()> {
        let count = self
            .db
            .query_row(
                "SELECT COUNT(*) FROM credentials WHERE user_id=?1 AND active=1",
                [user_id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(internal)?;
        if count >= MAX_CREDENTIALS as i64 {
            return Err(ApiError(StatusCode::CONFLICT, "credential_limit"));
        }
        Ok(())
    }
    fn check_credential_unique(&self, id: &str) -> ApiResult<()> {
        let exists: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM credentials WHERE id=?1)",
                [id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if exists {
            return Err(ApiError(StatusCode::CONFLICT, "credential_exists"));
        }
        Ok(())
    }
    fn session_user(&mut self, headers: &HeaderMap) -> ApiResult<User> {
        self.prune();
        let token = session_token(headers)?;
        let s = self
            .sessions
            .get(token)
            .ok_or(ApiError(StatusCode::UNAUTHORIZED, "session_expired"))?;
        if !self.credential_active(&s.user_id, &s.credential_id)? {
            return Err(ApiError(StatusCode::UNAUTHORIZED, "credential_revoked"));
        }
        self.user("id", &s.user_id)
    }
    fn management_allowed(&self, user: &User, operation: &Management) -> ApiResult<()> {
        match operation {
            Management::CredentialAdd { label } => {
                credential_label(label)?;
            }
            Management::CredentialRevoke { .. } => {}
            Management::GrantCreate { ttl_seconds, .. } => {
                if !user.owner {
                    return Err(forbidden("owner_required"));
                }
                if !(1..=3600).contains(ttl_seconds) {
                    return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_expiry"));
                }
            }
            Management::GrantRevoke { .. } => {
                if !user.owner {
                    return Err(forbidden("owner_required"));
                }
            }
            Management::DelegationCreate {
                guest_name,
                ttl_seconds,
                remaining_delegations,
            } => {
                self.delegation_target(
                    user,
                    guest_name,
                    *ttl_seconds,
                    *remaining_delegations,
                    None,
                )?;
            }
            Management::DelegationDelegate {
                parent_id,
                guest_name,
                ttl_seconds,
                remaining_delegations,
            } => {
                self.delegation_target(
                    user,
                    guest_name,
                    *ttl_seconds,
                    *remaining_delegations,
                    Some(parent_id),
                )?;
            }
            Management::DelegationRevoke { id } => {
                self.delegation_revoke_allowed(user, id)?;
            }
            Management::RecoveryRotate
            | Management::RecoveryDisable
            | Management::AgentCreate { .. }
            | Management::AgentRevoke { .. }
            | Management::VaultWrite { .. } => platform::management_allowed(self, user, operation)?,
        }
        Ok(())
    }
    fn take_approval(&mut self, id: Option<&str>) -> Option<Approval> {
        self.prune();
        id.and_then(|id| self.approvals.remove(id))
    }
    fn require_approval(
        &self,
        headers: &HeaderMap,
        user: &User,
        id: Option<&str>,
        approval: Option<Approval>,
        operation: &Management,
    ) -> ApiResult<String> {
        id.ok_or(forbidden("approval_required"))?;
        let approval = approval.ok_or(forbidden("approval_missing"))?;
        if approval.expires <= Instant::now() {
            return Err(forbidden("approval_missing"));
        }
        if approval.user_id != user.id
            || approval.session_token != session_token(headers)?
            || approval.operation != *operation
            || !self.credential_active(&user.id, &approval.credential_id)?
        {
            return Err(forbidden("approval_mismatch"));
        }
        Ok(approval.credential_id)
    }
    fn grant_allowed(&self, user: &User, invocation: &Invocation) -> ApiResult<()> {
        if invocation.arguments.len() > 8
            || invocation
                .arguments
                .iter()
                .any(|(k, v)| k.len() > 64 || v.len() > 256)
        {
            return Err(forbidden("argument_limit"));
        }
        if invocation.resource != RESOURCE {
            return Err(forbidden("resource_denied"));
        }
        let id = token_id(&invocation.grant)?;
        let revoked = self
            .db
            .query_row("SELECT revoked FROM grants WHERE id=?1", [&id], |r| {
                r.get::<_, bool>(0)
            })
            .optional()
            .map_err(internal)?
            .ok_or(forbidden("unknown_grant"))?;
        authorize_passkey_grant(
            &invocation.grant,
            &self.issuer.verifying_key().to_bytes(),
            &user.subject,
            RESOURCE,
            invocation.action,
            now(),
            revoked,
        )
        .map_err(|_| forbidden("grant_denied"))
    }
    fn delegation_record(&self, id: &str) -> ApiResult<DelegationRecord> {
        let row = self.db.query_row(
            "SELECT id,parent_id,recipient_id,delegator_id,token,revoked FROM delegations WHERE id=?1", [id],
            |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,bool>(5)?)),
        ).optional().map_err(internal)?.ok_or(ApiError(StatusCode::NOT_FOUND,"delegation_not_found"))?;
        Ok(DelegationRecord {
            id: row.0,
            parent_id: row.1,
            recipient_id: row.2,
            delegator_id: row.3,
            grant: delegation::decode(row.4.as_bytes())
                .map_err(|_| forbidden("delegation_denied"))?,
            revoked: row.5,
        })
    }
    fn delegation_chain(&self, id: &str) -> ApiResult<DelegationChain> {
        let mut current = id.to_owned();
        let mut seen = BTreeSet::new();
        let mut chain = Vec::new();
        let mut revoked = BTreeSet::new();
        loop {
            if seen.len() >= delegation::MAX_CHAIN || !seen.insert(current.clone()) {
                return Err(forbidden("delegation_denied"));
            }
            let row = self.delegation_record(&current)?;
            let raw_id = delegation::id(&row.grant).map_err(|_| forbidden("delegation_denied"))?;
            let parent = row
                .grant
                .body
                .parent
                .map(|parent| URL_SAFE_NO_PAD.encode(parent));
            let recipient = self.user("id", &row.recipient_id)?;
            let issuer = self.user("id", &row.delegator_id)?;
            if row.id != URL_SAFE_NO_PAD.encode(raw_id)
                || parent != row.parent_id
                || recipient.subject != row.grant.body.audience
                || match row.grant.body.delegator {
                    Some(alias) => issuer.subject != alias,
                    None => !issuer.owner,
                }
            {
                return Err(forbidden("delegation_denied"));
            }
            if row.revoked {
                revoked.insert(raw_id);
            }
            chain.push(row.grant);
            if let Some(parent) = row.parent_id {
                current = parent;
            } else {
                break;
            }
        }
        chain.reverse();
        delegation::verify_structure(&chain, &self.issuer.verifying_key().to_bytes())
            .map_err(|_| forbidden("delegation_denied"))?;
        Ok(DelegationChain { chain, revoked })
    }
    fn delegation_verify(
        &self,
        user: &User,
        chain: &DelegationChain,
        resource: &str,
        action: Action,
    ) -> ApiResult<()> {
        delegation::verify_chain(
            &chain.chain,
            delegation::Context {
                root: &self.issuer.verifying_key().to_bytes(),
                verified_holder: &user.subject,
                resource,
                action,
                now: now(),
                revoked: &chain.revoked,
            },
        )
        .map_err(|_| forbidden("delegation_denied"))
    }
    fn delegation_target(
        &self,
        user: &User,
        guest_name: &str,
        ttl: u64,
        budget: u8,
        parent_id: Option<&str>,
    ) -> ApiResult<(User, Option<DelegationChain>)> {
        if parent_id.is_none() && !user.owner {
            return Err(forbidden("owner_required"));
        }
        if !(1..=3600).contains(&ttl) {
            return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_expiry"));
        }
        if budget > 4 {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "invalid_delegation_budget",
            ));
        }
        let guest = self.user("name", guest_name)?;
        let parent = if let Some(id) = parent_id {
            let chain = self.delegation_chain(id)?;
            self.delegation_verify(user, &chain, RESOURCE, Action::Read)?;
            let leaf = &chain
                .chain
                .last()
                .ok_or(forbidden("delegation_denied"))?
                .body;
            if chain.chain.len() >= delegation::MAX_CHAIN
                || leaf.remaining_delegations == 0
                || budget >= leaf.remaining_delegations
                || now()
                    .checked_add(ttl)
                    .is_none_or(|expiry| expiry > leaf.expires_at)
                || chain
                    .chain
                    .iter()
                    .any(|grant| grant.body.audience == guest.subject)
            {
                return Err(forbidden("delegation_denied"));
            }
            Some(chain)
        } else {
            None
        };
        Ok((guest, parent))
    }
    fn delegation_revoke_allowed(&self, user: &User, id: &str) -> ApiResult<()> {
        let row = self.delegation_record(id)?;
        self.delegation_chain(id)?;
        if !user.owner && row.delegator_id != user.id {
            return Err(forbidden("delegation_revoke_denied"));
        }
        Ok(())
    }
    fn delegation_allowed(
        &self,
        user: &User,
        invocation: &DelegationInvocation,
    ) -> ApiResult<DelegationChain> {
        if invocation.arguments.len() > 8
            || invocation
                .arguments
                .iter()
                .any(|(k, v)| k.len() > 64 || v.len() > 256)
        {
            return Err(forbidden("argument_limit"));
        }
        if invocation.resource != RESOURCE {
            return Err(forbidden("resource_denied"));
        }
        let chain = self.delegation_chain(&invocation.id)?;
        self.delegation_verify(user, &chain, &invocation.resource, invocation.action)?;
        Ok(chain)
    }
    fn issue_delegation(
        &mut self,
        user: &User,
        guest: &User,
        ttl: u64,
        budget: u8,
        parent: Option<DelegationChain>,
    ) -> ApiResult<Json<Value>> {
        let time = now();
        let mut nonce = [0; 16];
        rand::rng().fill_bytes(&mut nonce);
        let parent_raw = parent
            .as_ref()
            .map(|chain| {
                delegation::id(chain.chain.last().ok_or(forbidden("delegation_denied"))?)
                    .map_err(internal)
            })
            .transpose()?;
        let grant = delegation::sign(
            &self.issuer,
            DelegationGrant {
                profile: delegation::PROFILE.into(),
                issuer: self.issuer.verifying_key().to_bytes(),
                delegator: parent_raw.map(|_| user.subject),
                audience: guest.subject,
                resource: RESOURCE.into(),
                actions: [Action::Read].into(),
                not_before: time,
                expires_at: time
                    .checked_add(ttl)
                    .ok_or(forbidden("delegation_denied"))?,
                remaining_delegations: budget,
                parent: parent_raw,
                nonce,
            },
        )
        .map_err(|_| forbidden("delegation_denied"))?;
        let id = URL_SAFE_NO_PAD.encode(delegation::id(&grant).map_err(internal)?);
        let parent_id = parent_raw.map(|id| URL_SAFE_NO_PAD.encode(id));
        let mut chain = parent.unwrap_or(DelegationChain {
            chain: Vec::new(),
            revoked: BTreeSet::new(),
        });
        chain.chain.push(grant.clone());
        self.delegation_verify(guest, &chain, RESOURCE, Action::Read)?;
        let tx = self.db.transaction().map_err(internal)?;
        tx.execute("INSERT INTO delegations(id,parent_id,recipient_id,delegator_id,token,revoked) VALUES(?1,?2,?3,?4,?5,0)",params![id,parent_id,guest.id,user.id,serde_json::to_string(&grant).map_err(internal)?]).map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(Json(json!({"id":id,"grant":grant,"chain":chain.chain})))
    }
}

async fn origin_guard(State(app): State<App>, req: Request, next: Next) -> Response {
    if req.headers().get("host").and_then(|h| h.to_str().ok()) != Some(&app.host) {
        return forbidden("host_denied").into_response();
    }
    if req.method() != axum::http::Method::GET
        && req.headers().get("origin").and_then(|h| h.to_str().ok()) != Some(&app.origin)
    {
        return forbidden("origin_denied").into_response();
    }
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert("cache-control", "no-store".parse().expect("static header"));
    headers.insert(
        "referrer-policy",
        "no-referrer".parse().expect("static header"),
    );
    if app.origin.starts_with("https://") {
        headers.insert(
            "strict-transport-security",
            "max-age=31536000".parse().expect("static header"),
        );
    }
    headers.insert(
        "x-content-type-options",
        "nosniff".parse().expect("static header"),
    );
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'".parse().expect("static header"));
    response
}

async fn register_start(
    State(app): State<App>,
    Json(input): Json<RegisterStart>,
) -> ApiResult<Json<Value>> {
    if !(3..=32).contains(&input.name.len())
        || !input
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_name"));
    }
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    if inner.registrations.len() + inner.enrollments.len() >= MAX_PENDING {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "ceremony_limit"));
    }
    let exists: bool = inner
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE name=?1)",
            [&input.name],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if exists {
        return Err(ApiError(StatusCode::CONFLICT, "user_exists"));
    }
    let owner_exists: bool = inner
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE owner=1)",
            [],
            |r| r.get(0),
        )
        .map_err(internal)?;
    let owner = match input.bootstrap_token.as_deref() {
        Some(token)
            if !owner_exists
                && token.len() == 43
                && <[u8; 32]>::from(Sha256::digest(token.as_bytes())) == inner.bootstrap_hash =>
        {
            true
        }
        Some(_) => return Err(forbidden("bootstrap_denied")),
        None if input.name == "owner" => return Err(forbidden("bootstrap_required")),
        None => false,
    };
    let user_id = Uuid::new_v4();
    let (options, state) = inner
        .webauthn
        .start_passkey_registration(user_id, &input.name, &input.name, None)
        .map_err(internal)?;
    let request_id = Uuid::new_v4().to_string();
    inner.registrations.insert(
        request_id.clone(),
        Registration {
            name: input.name,
            user_id,
            owner,
            state,
            expires: now() + CEREMONY_TTL,
        },
    );
    Ok(Json(json!({"request_id":request_id,"options":options})))
}

async fn register_finish(
    State(app): State<App>,
    Json(input): Json<RegisterFinish>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    let pending = inner
        .registrations
        .remove(&input.request_id)
        .ok_or(forbidden("ceremony_missing"))?;
    if pending.owner {
        let consumed: bool = inner
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE owner=1)",
                [],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if consumed {
            return Err(forbidden("bootstrap_consumed"));
        }
    }
    let key = inner
        .webauthn
        .finish_passkey_registration(&input.credential, &pending.state)
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "registration_invalid"))?;
    let id = credential_id(&key);
    inner.check_credential_unique(&id)?;
    let owner = pending.owner;
    let key_json = serde_json::to_string(&key).map_err(internal)?;
    let tx = inner.db.transaction().map_err(internal)?;
    tx.execute(
        "INSERT INTO users(id,name,owner,credential_id,passkey) VALUES(?1,?2,?3,?4,?5)",
        params![
            pending.user_id.to_string(),
            pending.name,
            owner,
            id,
            key_json,
        ],
    )
    .map_err(|_| ApiError(StatusCode::CONFLICT, "registration_conflict"))?;
    tx.execute(
        "INSERT INTO credentials(id,user_id,passkey,label,created) VALUES(?1,?2,?3,'Initial passkey',?4)",
        params![id, pending.user_id.to_string(), key_json, i64::try_from(now()).map_err(internal)?],
    )
    .map_err(internal)?;
    tx.commit().map_err(internal)?;
    Ok(Json(
        json!({"name":pending.name,"owner":owner,"registered":true}),
    ))
}

async fn auth_start(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<AuthStart>,
) -> ApiResult<Json<Value>> {
    if usize::from(input.management.is_some())
        + usize::from(input.invocation.is_some())
        + usize::from(input.delegation_invocation.is_some())
        > 1
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "ambiguous_authentication",
        ));
    }
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    if inner.authentications.len() >= MAX_PENDING {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "ceremony_limit"));
    }
    let (user, management) = if let Some(operation) = input.management {
        let user = inner.session_user(&headers)?;
        if user.name != input.name {
            return Err(forbidden("management_user_mismatch"));
        }
        inner.management_allowed(&user, &operation)?;
        if inner.approvals.len() >= MAX_APPROVALS {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "approval_limit"));
        }
        (
            user,
            Some(ManagementCeremony {
                operation,
                session_token: session_token(&headers)?.to_owned(),
            }),
        )
    } else {
        (inner.user("name", &input.name)?, None)
    };
    if let Some(invocation) = &input.invocation {
        inner.grant_allowed(&user, invocation)?;
    }
    if let Some(invocation) = &input.delegation_invocation {
        inner.delegation_allowed(&user, invocation)?;
    }
    let keys: Vec<Passkey> = inner
        .active_credentials(&user.id)?
        .into_iter()
        .map(|credential| credential.passkey)
        .collect();
    if keys.is_empty() {
        return Err(forbidden("no_active_credentials"));
    }
    let (options, state) = inner
        .webauthn
        .start_passkey_authentication(&keys)
        .map_err(internal)?;
    let request_id = Uuid::new_v4().to_string();
    let bound = binding(&input.invocation)?;
    inner.authentications.insert(
        request_id.clone(),
        Authentication {
            user,
            state,
            invocation: input.invocation,
            management,
            delegation_invocation: input.delegation_invocation,
            expires: now() + CEREMONY_TTL,
        },
    );
    Ok(Json(
        json!({"request_id":request_id,"options":options,"invocation_binding":URL_SAFE_NO_PAD.encode(bound)}),
    ))
}

async fn auth_finish(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<AuthFinish>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    let pending = inner
        .authentications
        .remove(&input.request_id)
        .ok_or(forbidden("ceremony_missing"))?;
    if usize::from(input.management.is_some())
        + usize::from(input.invocation.is_some())
        + usize::from(input.delegation_invocation.is_some())
        > 1
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "ambiguous_authentication",
        ));
    }
    match (&pending.management, &input.management) {
        (Some(management), Some(operation)) if management.operation == *operation => {
            let user = inner.session_user(&headers)?;
            if management.session_token != session_token(&headers)? || user.id != pending.user.id {
                return Err(forbidden("management_session_changed"));
            }
            inner.management_allowed(&user, operation)?;
            if inner.approvals.len() >= MAX_APPROVALS {
                return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "approval_limit"));
            }
        }
        (None, None) => {}
        _ => return Err(forbidden("management_changed")),
    }
    if binding(&pending.invocation)? != binding(&input.invocation)? {
        return Err(forbidden("invocation_changed"));
    }
    if binding(&pending.delegation_invocation)? != binding(&input.delegation_invocation)? {
        return Err(forbidden("delegation_invocation_changed"));
    }
    let user = inner.user("id", &pending.user.id)?;
    let result = inner
        .webauthn
        .finish_passkey_authentication(&input.credential, &pending.state)
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "authentication_invalid"))?;
    if !result.user_verified() {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "user_verification_required",
        ));
    }
    let id = URL_SAFE_NO_PAD.encode(result.cred_id().as_ref());
    let mut current = inner
        .active_credentials(&user.id)?
        .into_iter()
        .find(|credential| credential.id == id)
        .ok_or(forbidden("credential_revoked"))?;
    if (result.counter() > 0 || current.counter > 0) && result.counter() <= current.counter {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "counter_not_increasing"));
    }
    if current.passkey.update_credential(&result).is_none() {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "credential_mismatch"));
    }
    if let Some(invocation) = &pending.invocation {
        inner.grant_allowed(&user, invocation)?;
    }
    let delegated_chain = if let Some(invocation) = &pending.delegation_invocation {
        Some(inner.delegation_allowed(&user, invocation)?)
    } else {
        None
    };
    let key_json = serde_json::to_string(&current.passkey).map_err(internal)?;
    let tx = inner.db.transaction().map_err(internal)?;
    let updated = tx
        .execute(
            "UPDATE credentials SET passkey=?1,counter=?2 WHERE id=?3 AND user_id=?4 AND active=1",
            params![key_json, result.counter(), id, user.id],
        )
        .map_err(internal)?;
    if updated != 1 {
        return Err(forbidden("credential_revoked"));
    }
    tx.execute(
        "UPDATE users SET passkey=?1,counter=?2 WHERE id=?3 AND credential_id=?4",
        params![key_json, result.counter(), user.id, id],
    )
    .map_err(internal)?;
    if let Some(invocation) = &pending.invocation {
        let id = token_id(&invocation.grant)?;
        let inserted=tx.execute("INSERT INTO operations(id,grant_id,holder,created) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM grants WHERE id=?2 AND revoked=0)",params![input.request_id,id,user.id,i64::try_from(now()).map_err(internal)?]).map_err(internal)?;
        if inserted != 1 {
            return Err(forbidden("grant_revoked"));
        }
    }
    if let Some(invocation) = &pending.delegation_invocation {
        for grant in &delegated_chain
            .as_ref()
            .ok_or(forbidden("delegation_denied"))?
            .chain
        {
            let id = URL_SAFE_NO_PAD.encode(delegation::id(grant).map_err(internal)?);
            let active: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM delegations WHERE id=?1 AND revoked=0)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(internal)?;
            if !active {
                return Err(forbidden("delegation_denied"));
            }
        }
        tx.execute("INSERT INTO delegation_operations(id,delegation_id,holder,created) VALUES(?1,?2,?3,?4)",params![input.request_id,invocation.id,user.id,i64::try_from(now()).map_err(internal)?]).map_err(internal)?;
    }
    tx.commit().map_err(internal)?;
    if let Some(management) = pending.management {
        let approval_id = Uuid::new_v4().to_string();
        inner.approvals.insert(
            approval_id.clone(),
            Approval {
                user_id: user.id,
                session_token: management.session_token,
                credential_id: id,
                operation: management.operation,
                expires: Instant::now() + APPROVAL_TTL,
            },
        );
        Ok(Json(
            json!({"approval_id":approval_id,"approved":true,"expires_in":APPROVAL_TTL.as_secs()}),
        ))
    } else if let Some(invocation) = pending.delegation_invocation {
        Ok(Json(
            json!({"allowed":true,"resource":invocation.resource,"action":invocation.action,"arguments":invocation.arguments,"operation":input.request_id,"data":app.document.as_ref()}),
        ))
    } else if let Some(invocation) = pending.invocation {
        Ok(Json(
            json!({"authorized":true,"resource":invocation.resource,"action":invocation.action,"arguments":invocation.arguments,"operation":input.request_id,"data":app.document.as_ref()}),
        ))
    } else {
        let session = Uuid::new_v4().to_string();
        inner.sessions.insert(
            session.clone(),
            Session {
                user_id: user.id.clone(),
                credential_id: id,
                expires: now() + 300,
            },
        );
        Ok(Json(
            json!({"session":session,"name":user.name,"owner":user.owner,"account_id":user.id,"expires_in":300}),
        ))
    }
}

async fn credentials(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    let current_id = &inner.sessions[session_token(&headers)?].credential_id;
    let mut stmt = inner
        .db
        .prepare(
            "SELECT id,label,active,created FROM credentials WHERE user_id=?1 ORDER BY created,id",
        )
        .map_err(internal)?;
    let rows = stmt
        .query_map([&user.id], |row| {
            Ok(json!({
                "id":row.get::<_, String>(0)?,
                "label":row.get::<_, String>(1)?,
                "active":row.get::<_, bool>(2)?,
                "created":row.get::<_, i64>(3)?,
            }))
        })
        .map_err(internal)?;
    let out = rows.collect::<Result<Vec<_>, _>>().map_err(internal)?;
    Ok(Json(
        json!({"credentials":out,"current_credential_id":current_id}),
    ))
}

async fn credential_start(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<CredentialStart>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let label = credential_label(&input.label)?;
    let user = inner.session_user(&headers)?;
    if inner.registrations.len() + inner.enrollments.len() >= MAX_PENDING {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "ceremony_limit"));
    }
    inner.check_credential_capacity(&user.id)?;
    let token = session_token(&headers)?.to_owned();
    let authorizing_credential_id = inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &Management::CredentialAdd { label: input.label },
    )?;
    let excluded = inner
        .active_credentials(&user.id)?
        .into_iter()
        .map(|credential| credential.passkey.cred_id().clone())
        .collect();
    let (options, state) = inner
        .webauthn
        .start_passkey_registration(
            Uuid::parse_str(&user.id).map_err(internal)?,
            &user.name,
            &user.name,
            Some(excluded),
        )
        .map_err(internal)?;
    let request_id = Uuid::new_v4().to_string();
    inner.enrollments.insert(
        request_id.clone(),
        Enrollment {
            user_id: user.id,
            session_token: token,
            authorizing_credential_id,
            label,
            state,
            expires: now() + CEREMONY_TTL,
        },
    );
    Ok(Json(json!({"request_id":request_id,"options":options})))
}

async fn credential_finish(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<RegisterFinish>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    let token = session_token(&headers)?;
    let pending = inner
        .enrollments
        .get(&input.request_id)
        .ok_or(forbidden("ceremony_missing"))?;
    if pending.user_id != user.id || pending.session_token != token {
        return Err(forbidden("enrollment_session_changed"));
    }
    if !inner.credential_active(&user.id, &pending.authorizing_credential_id)? {
        return Err(forbidden("credential_revoked"));
    }
    let pending = inner
        .enrollments
        .remove(&input.request_id)
        .ok_or(forbidden("ceremony_missing"))?;
    inner.check_credential_capacity(&user.id)?;
    let key = inner
        .webauthn
        .finish_passkey_registration(&input.credential, &pending.state)
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "registration_invalid"))?;
    let id = credential_id(&key);
    inner.check_credential_unique(&id)?;
    inner
        .db
        .execute(
            "INSERT INTO credentials(id,user_id,passkey,label,created) VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                user.id,
                serde_json::to_string(&key).map_err(internal)?,
                pending.label,
                i64::try_from(now()).map_err(internal)?
            ],
        )
        .map_err(internal)?;
    Ok(Json(
        json!({"id":id,"label":pending.label,"registered":true}),
    ))
}

async fn credential_revoke(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<CredentialRevoke>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let user = inner.session_user(&headers)?;
    inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &Management::CredentialRevoke {
            id: input.id.clone(),
        },
    )?;
    let tx = inner.db.transaction().map_err(internal)?;
    let active = tx
        .query_row(
            "SELECT active FROM credentials WHERE id=?1 AND user_id=?2",
            params![input.id, user.id],
            |r| r.get::<_, bool>(0),
        )
        .optional()
        .map_err(internal)?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "credential_not_found"))?;
    if !active {
        return Err(ApiError(StatusCode::CONFLICT, "credential_already_revoked"));
    }
    let count = tx
        .query_row(
            "SELECT COUNT(*) FROM credentials WHERE user_id=?1 AND active=1",
            [&user.id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(internal)?;
    if count <= 1 {
        return Err(ApiError(StatusCode::CONFLICT, "last_credential_required"));
    }
    tx.execute(
        "UPDATE credentials SET active=0 WHERE id=?1 AND user_id=?2 AND active=1",
        params![input.id, user.id],
    )
    .map_err(internal)?;
    tx.commit().map_err(internal)?;
    inner
        .sessions
        .retain(|_, session| session.user_id != user.id);
    inner
        .authentications
        .retain(|_, pending| pending.user.id != user.id);
    inner
        .enrollments
        .retain(|_, pending| pending.user_id != user.id);
    inner
        .approvals
        .retain(|_, approval| approval.user_id != user.id);
    Ok(Json(
        json!({"id":input.id,"revoked":true,"reauthentication_required":true}),
    ))
}

async fn create_grant(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<GrantCreate>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    if !(1..=3600).contains(&input.ttl_seconds) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_expiry"));
    }
    let owner = inner.session_user(&headers)?;
    if !owner.owner {
        return Err(forbidden("owner_required"));
    }
    let guest = inner.user("name", &input.guest_name)?;
    inner.require_approval(
        &headers,
        &owner,
        input.approval_id.as_deref(),
        approval,
        &Management::GrantCreate {
            guest_name: input.guest_name,
            ttl_seconds: input.ttl_seconds,
        },
    )?;
    let time = now();
    let grant = sign_grant(
        &inner.issuer,
        Grant {
            issuer: inner.issuer.verifying_key().to_bytes(),
            audience: guest.subject,
            resource: RESOURCE.into(),
            actions: [Action::Read].into(),
            not_before: time,
            expires_at: time + input.ttl_seconds,
            remaining_delegations: 0,
            parent: None,
        },
    )
    .map_err(internal)?;
    let id = token_id(&grant)?;
    inner
        .db
        .execute(
            "INSERT OR IGNORE INTO grants(id,guest_id,token,revoked) VALUES(?1,?2,?3,0)",
            params![
                id,
                guest.id,
                serde_json::to_string(&grant).map_err(internal)?
            ],
        )
        .map_err(internal)?;
    Ok(Json(json!({"id":id,"grant":grant,"guest":guest.name})))
}

async fn revoke_grant(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<GrantRevoke>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let owner = inner.session_user(&headers)?;
    if !owner.owner {
        return Err(forbidden("owner_required"));
    }
    inner.require_approval(
        &headers,
        &owner,
        input.approval_id.as_deref(),
        approval,
        &Management::GrantRevoke {
            id: input.id.clone(),
        },
    )?;
    let n = inner
        .db
        .execute("UPDATE grants SET revoked=1 WHERE id=?1", [&input.id])
        .map_err(internal)?;
    if n == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "grant_not_found"));
    }
    Ok(Json(
        json!({"id":input.id,"revoked":true,"confirmed_at":now()}),
    ))
}

async fn grants(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    let mut stmt=inner.db.prepare("SELECT g.id,u.name,g.token,g.revoked FROM grants g JOIN users u ON u.id=g.guest_id WHERE ?1 OR g.guest_id=?2 ORDER BY g.rowid DESC LIMIT 100").map_err(internal)?;
    let rows = stmt
        .query_map(params![user.owner, user.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })
        .map_err(internal)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, token, revoked) = row.map_err(internal)?;
        out.push(json!({"id":id,"guest":name,"grant":serde_json::from_str::<Value>(&token).map_err(internal)?,"revoked":revoked}));
    }
    Ok(Json(json!({"grants":out})))
}

async fn create_delegation(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<DelegationCreate>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let user = inner.session_user(&headers)?;
    let (guest, parent) = inner.delegation_target(
        &user,
        &input.guest_name,
        input.ttl_seconds,
        input.remaining_delegations,
        None,
    )?;
    inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &Management::DelegationCreate {
            guest_name: input.guest_name,
            ttl_seconds: input.ttl_seconds,
            remaining_delegations: input.remaining_delegations,
        },
    )?;
    inner.issue_delegation(
        &user,
        &guest,
        input.ttl_seconds,
        input.remaining_delegations,
        parent,
    )
}

async fn delegate_delegation(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<DelegationDelegate>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let user = inner.session_user(&headers)?;
    let (guest, parent) = inner.delegation_target(
        &user,
        &input.guest_name,
        input.ttl_seconds,
        input.remaining_delegations,
        Some(&input.parent_id),
    )?;
    inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &Management::DelegationDelegate {
            parent_id: input.parent_id,
            guest_name: input.guest_name,
            ttl_seconds: input.ttl_seconds,
            remaining_delegations: input.remaining_delegations,
        },
    )?;
    inner.issue_delegation(
        &user,
        &guest,
        input.ttl_seconds,
        input.remaining_delegations,
        parent,
    )
}

async fn revoke_delegation(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<DelegationRevoke>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let user = inner.session_user(&headers)?;
    inner.delegation_revoke_allowed(&user, &input.id)?;
    inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &Management::DelegationRevoke {
            id: input.id.clone(),
        },
    )?;
    let tx = inner.db.transaction().map_err(internal)?;
    tx.execute("UPDATE delegations SET revoked=1 WHERE id=?1", [input.id])
        .map_err(internal)?;
    tx.commit().map_err(internal)?;
    Ok(Json(json!({"revoked":true})))
}

async fn delegations(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    let mut stmt = inner.db.prepare("SELECT d.id,u.name FROM delegations d JOIN users u ON u.id=d.recipient_id WHERE ?1 OR d.recipient_id=?2 OR d.delegator_id=?2 ORDER BY d.rowid DESC LIMIT 100").map_err(internal)?;
    let rows = stmt
        .query_map(params![user.owner, user.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(internal)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, guest) = row.map_err(internal)?;
        let record = inner.delegation_record(&id)?;
        let chain = inner.delegation_chain(&id)?;
        let can_delegate = inner
            .delegation_verify(&user, &chain, RESOURCE, Action::Read)
            .is_ok()
            && record.grant.body.remaining_delegations > 0
            && chain.chain.len() < delegation::MAX_CHAIN;
        out.push(json!({"id":id,"guest":guest,"grant":record.grant,"chain":chain.chain,"parent_id":record.parent_id,"revoked":record.revoked,"effective_revoked":!chain.revoked.is_empty(),"can_delegate":can_delegate,"can_revoke":user.owner || record.delegator_id==user.id}));
    }
    Ok(Json(
        json!({"profile":delegation::PROFILE,"max_chain":delegation::MAX_CHAIN,"grants":out}),
    ))
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../../web/index.html"))
}
async fn script() -> Response {
    (
        [("content-type", "text/javascript")],
        include_bytes!("../../web/dist/main.js").as_slice(),
    )
        .into_response()
}
async fn style() -> Response {
    (
        [("content-type", "text/css")],
        include_str!("../../web/src/style.css"),
    )
        .into_response()
}

async fn demo() -> Html<&'static str> {
    Html(include_str!("../../demo/index.html"))
}

async fn demo_script() -> Response {
    (
        [("content-type", "text/javascript")],
        include_str!("../../demo/main.js"),
    )
        .into_response()
}

async fn demo_style() -> Response {
    (
        [("content-type", "text/css")],
        include_str!("../../demo/style.css"),
    )
        .into_response()
}

fn bootstrap_hash(data: &Path) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let path = data.join("owner-bootstrap.txt");
    if !path.exists() {
        let mut random = [0; 32];
        rand::rng().fill_bytes(&mut random);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        writeln!(file, "{}", URL_SAFE_NO_PAD.encode(random))?;
        file.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&path)?.permissions().mode() & 0o077 != 0 {
            return Err("owner bootstrap file must be accessible only by its operator".into());
        }
    }
    let token = fs::read_to_string(path)?;
    let token = token.trim();
    if token.len() != 43 || URL_SAFE_NO_PAD.decode(token)?.len() != 32 {
        return Err("invalid owner bootstrap file".into());
    }
    Ok(Sha256::digest(token.as_bytes()).into())
}

fn initialize_database(db: &mut Connection) -> rusqlite::Result<()> {
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    let tx = db.transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,owner INTEGER NOT NULL,credential_id TEXT UNIQUE NOT NULL,passkey TEXT NOT NULL,counter INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,guest_id TEXT REFERENCES users(id),token TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,grant_id TEXT REFERENCES grants(id),holder TEXT REFERENCES users(id),created INTEGER NOT NULL);
         CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON users(owner) WHERE owner=1;
         CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),passkey TEXT NOT NULL,counter INTEGER NOT NULL DEFAULT 0 CHECK(counter>=0),label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 48),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),created INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS credentials_user_active ON credentials(user_id,active);
         CREATE TABLE IF NOT EXISTS delegations(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES delegations(id),recipient_id TEXT NOT NULL REFERENCES users(id),delegator_id TEXT NOT NULL REFERENCES users(id),token TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)));
         CREATE INDEX IF NOT EXISTS delegations_recipient ON delegations(recipient_id);
         CREATE INDEX IF NOT EXISTS delegations_delegator ON delegations(delegator_id);
         CREATE TABLE IF NOT EXISTS delegation_operations(id TEXT PRIMARY KEY,delegation_id TEXT NOT NULL REFERENCES delegations(id),holder TEXT NOT NULL REFERENCES users(id),created INTEGER NOT NULL);",
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO credentials(id,user_id,passkey,counter,label,active,created) SELECT credential_id,id,passkey,counter,'Initial passkey',1,?1 FROM users",
        [i64::try_from(now())
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?],
    )?;
    platform::initialize(&tx)?;
    tx.commit()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "portable")]
    if !openssl::version::version().starts_with("OpenSSL 3.6.5 ") {
        return Err(
            "Portable builds require the pinned OpenSSL 3.6.5; use scripts/build_portable.py"
                .into(),
        );
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|v| v == "--broker-agent") {
        return broker_agent::run(&args);
    }
    let Some(options) = desktop::options()? else {
        return Ok(());
    };
    if options.password_manager {
        if options.store_query.is_some() {
            return Err("--store-query is for the access lab only".into());
        }
        return password_manager::run(&options.data, options.port, options.open).await;
    }
    if let Some(spec) = options.store_query {
        let spec: Value = serde_json::from_str(&spec)?;
        let sql = spec
            .get("sql")
            .and_then(Value::as_str)
            .ok_or("--store-query requires a \"sql\" string")?;
        let parameters = spec
            .get("params")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        desktop::prepare_data(&options.data)?;
        let store = store::open(&options.data)?;
        println!("{}", store::query(&store.db, sql, &parameters)?);
        return Ok(());
    }
    let port = options.port;
    let public_origin = std::env::var("HEAVENKEY_PUBLIC_ORIGIN").ok();
    let alias_origin = std::env::var("HEAVENKEY_ORIGIN").ok();
    if let (Some(public), Some(alias)) = (&public_origin, &alias_origin)
        && Url::parse(public)?.origin() != Url::parse(alias)?.origin()
    {
        return Err("HEAVENKEY_ORIGIN and HEAVENKEY_PUBLIC_ORIGIN disagree".into());
    }
    let configured_origin = public_origin.as_deref().or(alias_origin.as_deref());
    let local_origin = format!("http://localhost:{port}");
    let hosting = hosting::Hosting::new(
        port,
        configured_origin.filter(|value| *value != local_origin),
    )?;
    let origin = hosting.origin;
    let rp_id = std::env::var("HEAVENKEY_RP_ID").unwrap_or(hosting.rp_id);
    platform::identity(&origin, &rp_id)?;
    let document_path = std::env::var_os("HEAVENKEY_DOCUMENT");
    let document = hosting::document(
        document_path.as_deref().map(Path::new),
        origin.starts_with("https://"),
    )?;
    let data = options.data;
    desktop::prepare_data(&data)?;
    let bootstrap_hash = bootstrap_hash(&data)?;
    let store::Store { mut db, issuer } = store::open(&data)?;
    db.busy_timeout(Duration::from_secs(2))?;
    initialize_database(&mut db)?;
    let webauthn = WebauthnBuilder::new(&rp_id, &Url::parse(&origin)?)?
        .rp_name("HeavenKey access lab")
        .build()?;
    platform::pin_identity(&db, &rp_id)?;
    let app = App {
        inner: Arc::new(Mutex::new(Inner {
            db,
            webauthn,
            issuer,
            bootstrap_hash,
            registrations: HashMap::new(),
            enrollments: HashMap::new(),
            authentications: HashMap::new(),
            approvals: HashMap::new(),
            sessions: HashMap::new(),
            platform: platform::Platform::default(),
        })),
        origin: origin.clone(),
        host: hosting.host,
        document: document.into(),
    };
    let router = Router::new()
        .route("/", get(index))
        .route("/main.js", get(script))
        .route("/style.css", get(style))
        .route("/demo/", get(demo))
        .route("/demo/index.html", get(demo))
        .route("/demo/main.js", get(demo_script))
        .route("/demo/style.css", get(demo_style))
        .route(
            "/health",
            get(|State(app): State<App>| async move { Json(json!({"status":"ok","mode":if app.origin.starts_with("https://") {"https-passkey-pilot"} else {"simulation-lab"}})) }),
        )
        .route("/api/register/start", post(register_start))
        .route("/api/register/finish", post(register_finish))
        .route("/api/auth/start", post(auth_start))
        .route("/api/auth/finish", post(auth_finish))
        .route("/api/credentials", get(credentials))
        .route("/api/credentials/start", post(credential_start))
        .route("/api/credentials/finish", post(credential_finish))
        .route("/api/credentials/revoke", post(credential_revoke))
        .route("/api/grants", get(grants).post(create_grant))
        .route("/api/grants/revoke", post(revoke_grant))
        .route("/api/delegations", get(delegations).post(create_delegation))
        .route("/api/delegations/delegate", post(delegate_delegation))
        .route("/api/delegations/revoke", post(revoke_delegation))
        .route("/api/config", get(platform::config))
        .route("/api/session", get(platform::session))
        .route("/api/logout", post(platform::logout))
        .route("/api/audit", get(platform::events))
        .route("/api/read", post(platform::read))
        .route("/api/recovery", get(platform::recovery_status))
        .route("/api/recovery/rotate", post(platform::recovery_rotate))
        .route("/api/recovery/disable", post(platform::recovery_disable))
        .route("/api/recovery/start", post(platform::recovery_start))
        .route("/api/recovery/finish", post(platform::recovery_finish))
        .route(
            "/api/agents",
            get(platform::agents).post(platform::agent_create),
        )
        .route("/api/agents/revoke", post(platform::agent_revoke))
        .route("/api/agents/challenge", post(platform::agent_challenge))
        .route("/api/agents/invoke", post(platform::agent_invoke))
        .route(
            "/api/vault",
            get(platform::vault).post(platform::vault_write),
        )
        .route("/api/vault/prepare", post(platform::vault_prepare))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), origin_guard))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("HeavenKey {}: {origin}", env!("CARGO_PKG_VERSION"));
    println!("Daten / data: {}", data.display());
    println!(
        "Einrichtungscode / setup code: {}",
        data.join("owner-bootstrap.txt").display()
    );
    println!("Beenden / stop: Ctrl+C. Hardware verification deferred.");
    if options.open {
        desktop::open_browser(&origin);
    }
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            if let Err(e) = tokio::signal::ctrl_c().await {
                eprintln!("shutdown signal: {e}");
            }
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn app() -> App {
        let mut db = Connection::open_in_memory().expect("synthetic database");
        initialize_database(&mut db).expect("schema");
        let origin = "http://localhost:18240";
        App {
            inner: Arc::new(Mutex::new(Inner {
                db,
                webauthn: WebauthnBuilder::new("localhost", &Url::parse(origin).expect("origin"))
                    .expect("builder")
                    .build()
                    .expect("webauthn"),
                issuer: SigningKey::from_bytes(&[7; 32]),
                bootstrap_hash: [0; 32],
                registrations: HashMap::new(),
                enrollments: HashMap::new(),
                authentications: HashMap::new(),
                approvals: HashMap::new(),
                sessions: HashMap::new(),
                platform: platform::Platform::default(),
            })),
            origin: origin.into(),
            host: "localhost:18240".into(),
            document: "HeavenKey example document — verified access".into(),
        }
    }

    fn add_user(inner: &mut Inner, name: &str, owner: bool) -> (String, String) {
        let user_id = Uuid::new_v4().to_string();
        let id = URL_SAFE_NO_PAD.encode(format!("synthetic-{name}"));
        inner
            .db
            .execute(
                "INSERT INTO users(id,name,owner,credential_id,passkey) VALUES(?1,?2,?3,?4,'{}')",
                params![user_id, name, owner, id],
            )
            .expect("synthetic legacy user");
        initialize_database(&mut inner.db).expect("migrate user");
        (user_id, id)
    }

    fn add_credential(inner: &Inner, user_id: &str, id: &str) {
        inner.db.execute(
            "INSERT INTO credentials(id,user_id,passkey,label,created) VALUES(?1,?2,'{}','Synthetic extra',1)",
            params![id,user_id],
        ).expect("synthetic credential metadata");
    }

    fn add_session(inner: &mut Inner, user_id: &str, credential_id: &str) -> String {
        let token = Uuid::new_v4().to_string();
        inner.sessions.insert(
            token.clone(),
            Session {
                user_id: user_id.into(),
                credential_id: credential_id.into(),
                expires: now() + 300,
            },
        );
        token
    }

    pub(super) fn headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("Bearer {token}").parse().expect("header"),
        );
        headers
    }

    fn add_enrollment(inner: &mut Inner, user_id: &str, token: &str, key_id: &str) {
        let (_, state) = inner
            .webauthn
            .start_passkey_registration(
                Uuid::parse_str(user_id).expect("user UUID"),
                "synthetic",
                "synthetic",
                None,
            )
            .expect("registration challenge");
        inner.enrollments.insert(
            user_id.into(),
            Enrollment {
                user_id: user_id.into(),
                session_token: token.into(),
                authorizing_credential_id: key_id.into(),
                label: "Synthetic extra".into(),
                state,
                expires: now() + CEREMONY_TTL,
            },
        );
    }

    pub(super) fn add_approval(app: &App, token: &str, operation: Management) -> String {
        let mut inner = app.inner.lock().expect("inner");
        let session = inner.sessions.get(token).expect("synthetic session");
        let approval = Approval {
            user_id: session.user_id.clone(),
            session_token: token.into(),
            credential_id: session.credential_id.clone(),
            operation,
            expires: Instant::now() + APPROVAL_TTL,
        };
        let id = Uuid::new_v4().to_string();
        inner.approvals.insert(id.clone(), approval);
        id
    }

    pub(super) fn management_app() -> (App, String, String, String) {
        let app = app();
        let (owner_token, guest_token, guest_id) = {
            let mut inner = app.inner.lock().expect("inner");
            let (owner, owner_id) = add_user(&mut inner, "owner", true);
            let (guest, guest_id) = add_user(&mut inner, "guest", false);
            add_credential(&inner, &guest, "guest-backup");
            let owner_token = add_session(&mut inner, &owner, &owner_id);
            let guest_token = add_session(&mut inner, &guest, &guest_id);
            (owner_token, guest_token, guest_id)
        };
        (app, owner_token, guest_token, guest_id)
    }

    #[test]
    fn legacy_migration_survives_restart_without_resurrecting_revoked_keys() {
        let path =
            std::env::temp_dir().join(format!("heavenkey-migration-{}.sqlite", Uuid::new_v4()));
        let mut db = Connection::open(&path).expect("legacy file");
        db.execute_batch("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,owner INTEGER NOT NULL,credential_id TEXT UNIQUE NOT NULL,passkey TEXT NOT NULL,counter INTEGER NOT NULL DEFAULT 0); CREATE TABLE grants(id TEXT PRIMARY KEY,guest_id TEXT REFERENCES users(id),token TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0); CREATE TABLE operations(id TEXT PRIMARY KEY,grant_id TEXT REFERENCES grants(id),holder TEXT REFERENCES users(id),created INTEGER NOT NULL);").expect("actual legacy schema");
        db.execute(
            "INSERT INTO users VALUES('user','owner',1,'bGVnYWN5','legacy-key',44)",
            [],
        )
        .expect("legacy user");
        db.execute(
            "INSERT INTO grants VALUES('grant','user','legacy-grant',0)",
            [],
        )
        .expect("legacy grant");
        db.execute(
            "INSERT INTO operations VALUES('operation','grant','user',1)",
            [],
        )
        .expect("legacy operation");
        initialize_database(&mut db).expect("first upgrade");
        let migrated: (String, u32, String, bool, i64) = db.query_row(
            "SELECT passkey,counter,label,active,created FROM credentials WHERE id='bGVnYWN5' AND user_id='user'", [],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        ).expect("migrated key");
        assert_eq!(
            (&migrated.0, migrated.1, migrated.2.as_str(), migrated.3),
            (&"legacy-key".to_owned(), 44, "Initial passkey", true)
        );
        assert!(migrated.4 > 0);
        db.execute("UPDATE credentials SET passkey='updated-key',counter=55,label='Retired original',active=0 WHERE id='bGVnYWN5'", []).expect("revoke original");
        db.execute(
            "INSERT INTO credentials VALUES('extra','user','extra-key',3,'Surviving key',1,2)",
            [],
        )
        .expect("extra key");
        drop(db);
        let mut db = Connection::open(&path).expect("reopen upgraded file");
        initialize_database(&mut db).expect("repeat upgrade");
        initialize_database(&mut db).expect("idempotent upgrade");
        let original: (String, u32, String, bool, i64) = db
            .query_row(
                "SELECT passkey,counter,label,active,created FROM credentials WHERE id='bGVnYWN5'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .expect("original metadata");
        assert_eq!(
            original,
            (
                "updated-key".into(),
                55,
                "Retired original".into(),
                false,
                migrated.4
            )
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM credentials", [], |r| r
                .get::<_, i64>(0))
                .expect("key count"),
            2
        );
        assert_eq!(
            db.query_row("SELECT credential_id FROM users", [], |r| r
                .get::<_, String>(0))
                .expect("subject alias"),
            "bGVnYWN5"
        );
        assert_eq!(
            db.query_row("SELECT token FROM grants", [], |r| r.get::<_, String>(0))
                .expect("existing grant"),
            "legacy-grant"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM operations", [], |r| r
                .get::<_, i64>(0))
                .expect("operation count"),
            1
        );
        drop(db);
        fs::remove_file(path).expect("remove synthetic file");
    }

    #[tokio::test]
    async fn revoke_is_account_scoped_invalidates_sessions_and_preserves_last_key() {
        let app = app();
        let (alice, alice_id, bob, bob_id, token, other_token, bob_token) = {
            let mut inner = app.inner.lock().expect("inner");
            let (alice, alice_id) = add_user(&mut inner, "alice", false);
            let (bob, bob_id) = add_user(&mut inner, "bob", false);
            add_credential(&inner, &alice, "extra");
            let token = add_session(&mut inner, &alice, &alice_id);
            let other_token = add_session(&mut inner, &alice, "extra");
            let bob_token = add_session(&mut inner, &bob, &bob_id);
            add_enrollment(&mut inner, &alice, &token, &alice_id);
            add_enrollment(&mut inner, &bob, &bob_token, &bob_id);
            (alice, alice_id, bob, bob_id, token, other_token, bob_token)
        };
        let foreign = credential_revoke(
            State(app.clone()),
            headers(&token),
            Json(CredentialRevoke {
                id: bob_id.clone(),
                approval_id: Some(add_approval(
                    &app,
                    &token,
                    Management::CredentialRevoke { id: bob_id.clone() },
                )),
            }),
        )
        .await
        .expect_err("foreign key denied");
        assert_eq!(
            (foreign.0, foreign.1),
            (StatusCode::NOT_FOUND, "credential_not_found")
        );
        let alice_approval = add_approval(
            &app,
            &other_token,
            Management::CredentialAdd {
                label: "Next key".into(),
            },
        );
        let bob_approval = add_approval(
            &app,
            &bob_token,
            Management::CredentialAdd {
                label: "Next key".into(),
            },
        );
        let Json(revoked) = credential_revoke(
            State(app.clone()),
            headers(&token),
            Json(CredentialRevoke {
                id: alice_id.clone(),
                approval_id: Some(add_approval(
                    &app,
                    &token,
                    Management::CredentialRevoke {
                        id: alice_id.clone(),
                    },
                )),
            }),
        )
        .await
        .expect("revoke initial");
        assert_eq!(revoked["reauthentication_required"], true);
        let surviving_token = {
            let mut inner = app.inner.lock().expect("inner");
            assert!(!inner.sessions.contains_key(&token));
            assert!(!inner.sessions.contains_key(&other_token));
            assert!(!inner.enrollments.contains_key(&alice));
            assert!(inner.enrollments.contains_key(&bob));
            assert!(!inner.approvals.contains_key(&alice_approval));
            assert!(inner.approvals.contains_key(&bob_approval));
            assert!(inner.session_user(&headers(&bob_token)).is_ok());
            assert!(
                !inner
                    .credential_active(&alice, &alice_id)
                    .expect("inactive original")
            );
            assert!(
                inner
                    .credential_active(&bob, &bob_id)
                    .expect("other account intact")
            );
            add_session(&mut inner, &alice, "extra")
        };
        let last = credential_revoke(
            State(app.clone()),
            headers(&surviving_token),
            Json(CredentialRevoke {
                id: "extra".into(),
                approval_id: Some(add_approval(
                    &app,
                    &surviving_token,
                    Management::CredentialRevoke { id: "extra".into() },
                )),
            }),
        )
        .await
        .expect_err("last key denied");
        assert_eq!(
            (last.0, last.1),
            (StatusCode::CONFLICT, "last_credential_required")
        );
        let Json(list) = credentials(State(app), headers(&surviving_token))
            .await
            .expect("surviving session");
        assert_eq!(list["current_credential_id"], "extra");
        assert_eq!(list["credentials"].as_array().expect("keys").len(), 2);
    }

    #[tokio::test]
    async fn active_key_rechecks_and_zero_key_authentication_fail_closed() {
        let app = app();
        let token = {
            let mut inner = app.inner.lock().expect("inner");
            let (user, id) = add_user(&mut inner, "alice", false);
            let token = add_session(&mut inner, &user, &id);
            inner
                .db
                .execute("UPDATE credentials SET active=0 WHERE user_id=?1", [user])
                .expect("simulate changed persisted state");
            token
        };
        let error = credentials(State(app.clone()), headers(&token))
            .await
            .expect_err("revoked session rejected at access");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::UNAUTHORIZED, "credential_revoked")
        );
        let error = auth_start(
            State(app),
            HeaderMap::new(),
            Json(AuthStart {
                name: "alice".into(),
                invocation: None,
                management: None,
                delegation_invocation: None,
            }),
        )
        .await
        .expect_err("empty active list rejected");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "no_active_credentials")
        );
    }

    #[tokio::test]
    async fn credential_cap_counts_active_keys_and_rejects_retired_duplicates() {
        let app = app();
        let (user, token) = {
            let mut inner = app.inner.lock().expect("inner");
            let (user, id) = add_user(&mut inner, "alice", false);
            for n in 1..MAX_CREDENTIALS {
                add_credential(&inner, &user, &format!("extra-{n}"));
            }
            let token = add_session(&mut inner, &user, &id);
            (user, token)
        };
        let error = credential_start(
            State(app.clone()),
            headers(&token),
            Json(CredentialStart {
                label: "Ninth key".into(),
                approval_id: None,
            }),
        )
        .await
        .expect_err("cap enforced before ceremony");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::CONFLICT, "credential_limit")
        );
        let inner = app.inner.lock().expect("inner");
        inner
            .db
            .execute("UPDATE credentials SET active=0 WHERE id='extra-1'", [])
            .expect("retire one key");
        assert!(inner.check_credential_capacity(&user).is_ok());
        let duplicate = inner
            .check_credential_unique("extra-1")
            .expect_err("retired IDs cannot be reassigned");
        assert_eq!(
            (duplicate.0, duplicate.1),
            (StatusCode::CONFLICT, "credential_exists")
        );
    }

    #[tokio::test]
    async fn existing_grant_keeps_initial_subject_after_original_key_revocation() {
        let app = app();
        let (guest, original_id, token) = {
            let mut inner = app.inner.lock().expect("inner");
            let (owner, owner_id) = add_user(&mut inner, "owner", true);
            let (guest, id) = add_user(&mut inner, "guest", false);
            add_credential(&inner, &guest, "surviving");
            (guest, id, add_session(&mut inner, &owner, &owner_id))
        };
        let Json(created) = create_grant(
            State(app.clone()),
            headers(&token),
            Json(GrantCreate {
                guest_name: "guest".into(),
                ttl_seconds: 60,
                approval_id: Some(add_approval(
                    &app,
                    &token,
                    Management::GrantCreate {
                        guest_name: "guest".into(),
                        ttl_seconds: 60,
                    },
                )),
            }),
        )
        .await
        .expect("old account grant");
        let grant: Signed<Grant> = serde_json::from_value(created["grant"].clone()).expect("grant");
        let inner = app.inner.lock().expect("inner");
        inner
            .db
            .execute(
                "UPDATE credentials SET active=0 WHERE id=?1",
                [&original_id],
            )
            .expect("retired original");
        let user = inner.user("id", &guest).expect("guest account");
        assert_eq!(
            user.subject,
            <[u8; 32]>::from(Sha256::digest(
                URL_SAFE_NO_PAD
                    .decode(original_id)
                    .expect("raw initial credential")
            ))
        );
        assert!(!user.owner);
        inner
            .grant_allowed(
                &user,
                &Invocation {
                    grant,
                    resource: RESOURCE.into(),
                    action: Action::Read,
                    arguments: Default::default(),
                },
            )
            .expect("existing grant survives with same account subject");
    }

    #[tokio::test]
    async fn bearer_sessions_cannot_perform_any_management_mutation() {
        let (app, owner_token, guest_token, guest_id) = management_app();
        let errors = [
            credential_start(
                State(app.clone()),
                headers(&guest_token),
                Json(CredentialStart {
                    label: "Backup".into(),
                    approval_id: None,
                }),
            )
            .await
            .expect_err("add requires approval"),
            credential_revoke(
                State(app.clone()),
                headers(&guest_token),
                Json(CredentialRevoke {
                    id: guest_id,
                    approval_id: None,
                }),
            )
            .await
            .expect_err("revoke requires approval"),
            create_grant(
                State(app.clone()),
                headers(&owner_token),
                Json(GrantCreate {
                    guest_name: "guest".into(),
                    ttl_seconds: 60,
                    approval_id: None,
                }),
            )
            .await
            .expect_err("grant requires approval"),
            revoke_grant(
                State(app.clone()),
                headers(&owner_token),
                Json(GrantRevoke {
                    id: "grant".into(),
                    approval_id: None,
                }),
            )
            .await
            .expect_err("grant revocation requires approval"),
        ];
        for error in errors {
            assert_eq!(
                (error.0, error.1),
                (StatusCode::FORBIDDEN, "approval_required")
            );
        }
        let inner = app.inner.lock().expect("inner");
        assert!(inner.enrollments.is_empty());
        assert_eq!(
            inner
                .db
                .query_row("SELECT COUNT(*) FROM grants", [], |r| r.get::<_, i64>(0))
                .expect("no writes"),
            0
        );
        assert_eq!(
            inner
                .db
                .query_row("SELECT COUNT(*) FROM credentials WHERE active=1", [], |r| r
                    .get::<_, i64>(0))
                .expect("keys unchanged"),
            3
        );
    }

    #[test]
    fn every_operation_parameter_is_exact_and_mismatches_consume_approval() {
        let (app, token, _, _) = management_app();
        let cases = [
            (
                Management::CredentialAdd {
                    label: "Backup".into(),
                },
                Management::CredentialAdd {
                    label: " Backup ".into(),
                },
            ),
            (
                Management::CredentialRevoke { id: "one".into() },
                Management::CredentialRevoke { id: "two".into() },
            ),
            (
                Management::GrantCreate {
                    guest_name: "guest".into(),
                    ttl_seconds: 60,
                },
                Management::GrantCreate {
                    guest_name: "guest".into(),
                    ttl_seconds: 61,
                },
            ),
            (
                Management::GrantCreate {
                    guest_name: "guest".into(),
                    ttl_seconds: 60,
                },
                Management::GrantCreate {
                    guest_name: "other".into(),
                    ttl_seconds: 60,
                },
            ),
            (
                Management::GrantRevoke { id: "one".into() },
                Management::GrantRevoke { id: "two".into() },
            ),
            (
                Management::GrantRevoke { id: "one".into() },
                Management::CredentialRevoke { id: "one".into() },
            ),
        ];
        for (approved, attempted) in cases {
            let id = add_approval(&app, &token, approved.clone());
            let mut inner = app.inner.lock().expect("inner");
            let user = inner.session_user(&headers(&token)).expect("session");
            let taken = inner.take_approval(Some(&id));
            let error = inner
                .require_approval(&headers(&token), &user, Some(&id), taken, &attempted)
                .expect_err("parameter mismatch");
            assert_eq!(
                (error.0, error.1),
                (StatusCode::FORBIDDEN, "approval_mismatch")
            );
            let replay = inner.take_approval(Some(&id));
            let error = inner
                .require_approval(&headers(&token), &user, Some(&id), replay, &approved)
                .expect_err("mismatched approval cannot be retried");
            assert_eq!(
                (error.0, error.1),
                (StatusCode::FORBIDDEN, "approval_missing")
            );
        }
    }

    #[tokio::test]
    async fn invalid_parameters_and_wrong_sessions_burn_supplied_approvals() {
        let (app, token, guest_token, _) = management_app();
        let operation = Management::GrantCreate {
            guest_name: "guest".into(),
            ttl_seconds: 60,
        };
        let invalid_id = add_approval(&app, &token, operation.clone());
        let invalid = create_grant(
            State(app.clone()),
            headers(&token),
            Json(GrantCreate {
                guest_name: "guest".into(),
                ttl_seconds: 0,
                approval_id: Some(invalid_id.clone()),
            }),
        )
        .await
        .expect_err("invalid expiry");
        assert_eq!(
            (invalid.0, invalid.1),
            (StatusCode::BAD_REQUEST, "invalid_expiry")
        );
        assert!(
            !app.inner
                .lock()
                .expect("inner")
                .approvals
                .contains_key(&invalid_id)
        );
        let alternate_token = {
            let mut inner = app.inner.lock().expect("inner");
            let user = inner.user("name", "owner").expect("owner");
            let credential_id = inner.sessions[&token].credential_id.clone();
            add_session(&mut inner, &user.id, &credential_id)
        };
        for attempted_token in [&alternate_token, &guest_token] {
            let id = add_approval(
                &app,
                &token,
                Management::CredentialAdd {
                    label: "Backup".into(),
                },
            );
            let error = credential_start(
                State(app.clone()),
                headers(attempted_token),
                Json(CredentialStart {
                    label: "Backup".into(),
                    approval_id: Some(id.clone()),
                }),
            )
            .await
            .expect_err("session or account mismatch");
            assert_eq!(
                (error.0, error.1),
                (StatusCode::FORBIDDEN, "approval_mismatch")
            );
            assert!(!app.inner.lock().expect("inner").approvals.contains_key(&id));
        }
        let unauthenticated_id = add_approval(&app, &token, operation);
        let error = create_grant(
            State(app.clone()),
            HeaderMap::new(),
            Json(GrantCreate {
                guest_name: "guest".into(),
                ttl_seconds: 60,
                approval_id: Some(unauthenticated_id.clone()),
            }),
        )
        .await
        .expect_err("missing authentication");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::UNAUTHORIZED, "session_required")
        );
        assert!(
            !app.inner
                .lock()
                .expect("inner")
                .approvals
                .contains_key(&unauthenticated_id)
        );
    }

    #[tokio::test]
    async fn duplicate_approved_mutations_commit_once() {
        let (app, token, _, _) = management_app();
        let id = add_approval(
            &app,
            &token,
            Management::GrantCreate {
                guest_name: "guest".into(),
                ttl_seconds: 60,
            },
        );
        let input = || {
            Json(GrantCreate {
                guest_name: "guest".into(),
                ttl_seconds: 60,
                approval_id: Some(id.clone()),
            })
        };
        let (first, second) = tokio::join!(
            create_grant(State(app.clone()), headers(&token), input()),
            create_grant(State(app.clone()), headers(&token), input()),
        );
        assert!(first.is_ok());
        let error = second.expect_err("single-use duplicate denied");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "approval_missing")
        );
        let inner = app.inner.lock().expect("inner");
        assert_eq!(
            inner
                .db
                .query_row("SELECT COUNT(*) FROM grants", [], |r| r.get::<_, i64>(0))
                .expect("one grant"),
            1
        );
    }

    #[tokio::test]
    async fn monotonic_expiry_and_signer_state_are_checked_at_consumption() {
        let (app, token, _, _) = management_app();
        let operation = Management::GrantCreate {
            guest_name: "guest".into(),
            ttl_seconds: 60,
        };
        let expired = add_approval(&app, &token, operation.clone());
        {
            let mut inner = app.inner.lock().expect("inner");
            inner.approvals.get_mut(&expired).expect("approval").expires = Instant::now();
        }
        let error = create_grant(
            State(app.clone()),
            headers(&token),
            Json(GrantCreate {
                guest_name: "guest".into(),
                ttl_seconds: 60,
                approval_id: Some(expired),
            }),
        )
        .await
        .expect_err("monotonic expired approval");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "approval_missing")
        );
        let revoked = add_approval(&app, &token, operation);
        {
            let mut inner = app.inner.lock().expect("inner");
            let owner = inner.user("name", "owner").expect("owner");
            add_credential(&inner, &owner.id, "revoked-approver");
            inner
                .approvals
                .get_mut(&revoked)
                .expect("approval")
                .credential_id = "revoked-approver".into();
            inner
                .db
                .execute(
                    "UPDATE credentials SET active=0 WHERE id='revoked-approver'",
                    [],
                )
                .expect("retire approving key while session key remains active");
        }
        let error = create_grant(
            State(app.clone()),
            headers(&token),
            Json(GrantCreate {
                guest_name: "guest".into(),
                ttl_seconds: 60,
                approval_id: Some(revoked),
            }),
        )
        .await
        .expect_err("active signer required");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "approval_mismatch")
        );
    }

    #[tokio::test]
    async fn management_checks_authority_and_bounds_outstanding_approvals() {
        let (app, token, guest_token, _) = management_app();
        let operation = Management::GrantCreate {
            guest_name: "guest".into(),
            ttl_seconds: 60,
        };
        let error = auth_start(
            State(app.clone()),
            headers(&guest_token),
            Json(AuthStart {
                name: "guest".into(),
                invocation: None,
                management: Some(operation),
                delegation_invocation: None,
            }),
        )
        .await
        .expect_err("owner-only approval");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "owner_required")
        );
        let error = auth_start(
            State(app.clone()),
            headers(&token),
            Json(AuthStart {
                name: "guest".into(),
                invocation: None,
                management: Some(Management::CredentialAdd {
                    label: "Backup".into(),
                }),
                delegation_invocation: None,
            }),
        )
        .await
        .expect_err("session account must match requested name");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "management_user_mismatch")
        );
        for _ in 0..MAX_APPROVALS {
            add_approval(
                &app,
                &token,
                Management::CredentialAdd {
                    label: "Backup".into(),
                },
            );
        }
        let error = auth_start(
            State(app.clone()),
            headers(&token),
            Json(AuthStart {
                name: "owner".into(),
                invocation: None,
                management: Some(Management::CredentialAdd {
                    label: "Backup".into(),
                }),
                delegation_invocation: None,
            }),
        )
        .await
        .expect_err("approval map is capped");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::TOO_MANY_REQUESTS, "approval_limit")
        );
        assert_eq!(
            app.inner.lock().expect("inner").approvals.len(),
            MAX_APPROVALS
        );
    }

    #[test]
    fn management_schema_rejects_ambiguous_or_extra_fields() {
        for invalid in [
            json!({"kind":"credential_add","label":"Backup","id":"extra"}),
            json!({"kind":"grant_revoke","id":"grant","ttl_seconds":60}),
            json!({"kind":"credential_add"}),
            json!({"kind":"unknown","id":"grant"}),
            json!({"kind":"grant_create","guest_name":"guest","ttl_seconds":"60"}),
        ] {
            assert!(serde_json::from_value::<Management>(invalid).is_err());
        }
        assert_eq!(
            serde_json::from_value::<Management>(json!({"kind":"credential_add","label":"Backup"}))
                .expect("exact shape"),
            Management::CredentialAdd {
                label: "Backup".into()
            }
        );
    }

    pub(super) fn delegation_app() -> (App, HashMap<&'static str, String>) {
        let app = app();
        let mut tokens = HashMap::new();
        {
            let mut inner = app.inner.lock().expect("inner");
            for name in ["owner", "guest", "second", "third", "fourth"] {
                let (user, key) = add_user(&mut inner, name, name == "owner");
                tokens.insert(name, add_session(&mut inner, &user, &key));
            }
        }
        (app, tokens)
    }

    pub(super) async fn root_delegation(
        app: &App,
        token: &str,
        guest: &str,
        ttl: u64,
        budget: u8,
    ) -> ApiResult<Json<Value>> {
        let approval = add_approval(
            app,
            token,
            Management::DelegationCreate {
                guest_name: guest.into(),
                ttl_seconds: ttl,
                remaining_delegations: budget,
            },
        );
        create_delegation(
            State(app.clone()),
            headers(token),
            Json(DelegationCreate {
                guest_name: guest.into(),
                ttl_seconds: ttl,
                remaining_delegations: budget,
                approval_id: Some(approval),
            }),
        )
        .await
    }
    async fn child_delegation(
        app: &App,
        token: &str,
        parent: &str,
        guest: &str,
        ttl: u64,
        budget: u8,
    ) -> ApiResult<Json<Value>> {
        let approval = add_approval(
            app,
            token,
            Management::DelegationDelegate {
                parent_id: parent.into(),
                guest_name: guest.into(),
                ttl_seconds: ttl,
                remaining_delegations: budget,
            },
        );
        delegate_delegation(
            State(app.clone()),
            headers(token),
            Json(DelegationDelegate {
                parent_id: parent.into(),
                guest_name: guest.into(),
                ttl_seconds: ttl,
                remaining_delegations: budget,
                approval_id: Some(approval),
            }),
        )
        .await
    }
    async fn approved_delegation_revoke(
        app: &App,
        token: &str,
        id: &str,
    ) -> ApiResult<Json<Value>> {
        let approval = add_approval(app, token, Management::DelegationRevoke { id: id.into() });
        revoke_delegation(
            State(app.clone()),
            headers(token),
            Json(DelegationRevoke {
                id: id.into(),
                approval_id: Some(approval),
            }),
        )
        .await
    }

    #[tokio::test]
    async fn delegation_mutations_require_exact_fresh_approvals() {
        let (app, tokens) = delegation_app();
        let error = create_delegation(
            State(app.clone()),
            headers(&tokens["owner"]),
            Json(DelegationCreate {
                guest_name: "guest".into(),
                ttl_seconds: 300,
                remaining_delegations: 2,
                approval_id: None,
            }),
        )
        .await
        .expect_err("token alone cannot mint");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "approval_required")
        );
        let Json(root) = root_delegation(&app, &tokens["owner"], "guest", 300, 2)
            .await
            .expect("root");
        let id = root["id"].as_str().expect("id");
        let error = delegate_delegation(
            State(app.clone()),
            headers(&tokens["guest"]),
            Json(DelegationDelegate {
                parent_id: id.into(),
                guest_name: "second".into(),
                ttl_seconds: 200,
                remaining_delegations: 1,
                approval_id: None,
            }),
        )
        .await
        .expect_err("token alone cannot delegate");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "approval_required")
        );
        let error = revoke_delegation(
            State(app.clone()),
            headers(&tokens["owner"]),
            Json(DelegationRevoke {
                id: id.into(),
                approval_id: None,
            }),
        )
        .await
        .expect_err("token alone cannot revoke");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "approval_required")
        );
        let approval = add_approval(
            &app,
            &tokens["owner"],
            Management::DelegationCreate {
                guest_name: "guest".into(),
                ttl_seconds: 300,
                remaining_delegations: 2,
            },
        );
        let error = create_delegation(
            State(app.clone()),
            headers(&tokens["owner"]),
            Json(DelegationCreate {
                guest_name: "guest".into(),
                ttl_seconds: 300,
                remaining_delegations: 1,
                approval_id: Some(approval.clone()),
            }),
        )
        .await
        .expect_err("budget is bound");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "approval_mismatch")
        );
        assert!(
            !app.inner
                .lock()
                .expect("inner")
                .approvals
                .contains_key(&approval)
        );
        let inner = app.inner.lock().expect("inner");
        assert_eq!(
            inner
                .db
                .query_row("SELECT COUNT(*) FROM delegations", [], |r| r
                    .get::<_, i64>(0))
                .expect("one authorized root"),
            1
        );
        assert!(inner.authentications.is_empty());
    }

    #[tokio::test]
    async fn delegation_attenuation_and_visibility_are_account_bound() {
        let (app, tokens) = delegation_app();
        let Json(root) = root_delegation(&app, &tokens["owner"], "guest", 300, 2)
            .await
            .expect("root");
        let root_id = root["id"].as_str().expect("root id");
        for (token, guest, ttl, budget) in [
            (&tokens["second"], "third", 200, 1),
            (&tokens["guest"], "second", 301, 1),
            (&tokens["guest"], "second", 200, 2),
            (&tokens["guest"], "guest", 200, 1),
        ] {
            let error = child_delegation(&app, token, root_id, guest, ttl, budget)
                .await
                .expect_err("invalid holder or attenuation");
            assert_eq!(
                (error.0, error.1),
                (StatusCode::FORBIDDEN, "delegation_denied")
            );
        }
        let Json(child) = child_delegation(&app, &tokens["guest"], root_id, "second", 200, 1)
            .await
            .expect("child");
        let child_id = child["id"].as_str().expect("child id");
        let Json(grandchild) = child_delegation(&app, &tokens["second"], child_id, "third", 100, 0)
            .await
            .expect("grandchild");
        assert_eq!(grandchild["chain"].as_array().expect("chain").len(), 3);
        let grant: Signed<DelegationGrant> =
            serde_json::from_value(grandchild["grant"].clone()).expect("signed leaf");
        assert_eq!(
            grant.body.issuer,
            app.inner
                .lock()
                .expect("inner")
                .issuer
                .verifying_key()
                .to_bytes()
        );
        let Json(owner_list) = delegations(State(app.clone()), headers(&tokens["owner"]))
            .await
            .expect("owner list");
        assert_eq!(owner_list["grants"].as_array().expect("grants").len(), 3);
        let Json(guest_list) = delegations(State(app.clone()), headers(&tokens["guest"]))
            .await
            .expect("guest list");
        assert_eq!(guest_list["grants"].as_array().expect("grants").len(), 2);
        let Json(third_list) = delegations(State(app.clone()), headers(&tokens["third"]))
            .await
            .expect("third list");
        assert_eq!(third_list["grants"].as_array().expect("grants").len(), 1);
        assert_eq!(third_list["grants"][0]["can_delegate"], false);
        assert_eq!(third_list["grants"][0]["can_revoke"], false);
        let Json(fourth_list) = delegations(State(app.clone()), headers(&tokens["fourth"]))
            .await
            .expect("unrelated list");
        assert!(fourth_list["grants"].as_array().expect("grants").is_empty());
        let unauthorized = approved_delegation_revoke(
            &app,
            &tokens["guest"],
            grandchild["id"].as_str().expect("grandchild id"),
        )
        .await
        .expect_err("ancestor holder cannot revoke another issuer's child");
        assert_eq!(
            (unauthorized.0, unauthorized.1),
            (StatusCode::FORBIDDEN, "delegation_revoke_denied")
        );
        let Json(revoked) = approved_delegation_revoke(&app, &tokens["guest"], child_id)
            .await
            .expect("actual child issuer can revoke");
        assert_eq!(revoked["revoked"], true);
        let Json(repeated) = approved_delegation_revoke(&app, &tokens["guest"], child_id)
            .await
            .expect("authorized repeated revoke is idempotent");
        assert_eq!(repeated["revoked"], true);
    }

    #[tokio::test]
    async fn ancestor_revocation_invalidates_descendants_and_preapproved_writes_after_restart() {
        let (app, tokens) = delegation_app();
        let Json(root) = root_delegation(&app, &tokens["owner"], "guest", 300, 2)
            .await
            .expect("root");
        let root_id = root["id"].as_str().expect("root id");
        let Json(child) = child_delegation(&app, &tokens["guest"], root_id, "second", 200, 1)
            .await
            .expect("child");
        let child_id = child["id"].as_str().expect("child id");
        let Json(grandchild) = child_delegation(&app, &tokens["second"], child_id, "third", 100, 0)
            .await
            .expect("grandchild");
        let grandchild_id = grandchild["id"].as_str().expect("grandchild id");
        let approval = add_approval(
            &app,
            &tokens["second"],
            Management::DelegationDelegate {
                parent_id: child_id.into(),
                guest_name: "fourth".into(),
                ttl_seconds: 50,
                remaining_delegations: 0,
            },
        );
        let Json(revoked) = approved_delegation_revoke(&app, &tokens["owner"], root_id)
            .await
            .expect("revoke ancestor");
        assert_eq!(revoked["revoked"], true);
        let error = delegate_delegation(
            State(app.clone()),
            headers(&tokens["second"]),
            Json(DelegationDelegate {
                parent_id: child_id.into(),
                guest_name: "fourth".into(),
                ttl_seconds: 50,
                remaining_delegations: 0,
                approval_id: Some(approval.clone()),
            }),
        )
        .await
        .expect_err("current ancestry overrides past approval");
        assert_eq!(
            (error.0, error.1),
            (StatusCode::FORBIDDEN, "delegation_denied")
        );
        assert!(
            !app.inner
                .lock()
                .expect("inner")
                .approvals
                .contains_key(&approval)
        );
        let Json(list) = delegations(State(app.clone()), headers(&tokens["third"]))
            .await
            .expect("revoked list remains visible");
        assert_eq!(list["grants"][0]["revoked"], false);
        assert_eq!(list["grants"][0]["effective_revoked"], true);
        assert_eq!(list["grants"][0]["can_delegate"], false);
        let path =
            std::env::temp_dir().join(format!("heavenkey-delegation-{}.sqlite", Uuid::new_v4()));
        {
            let inner = app.inner.lock().expect("inner");
            inner
                .db
                .execute("VACUUM INTO ?1", [path.to_str().expect("temporary path")])
                .expect("persist synthetic database");
        }
        let restarted = self::app();
        {
            let mut inner = restarted.inner.lock().expect("inner");
            let mut db = Connection::open(&path).expect("reopened persisted data");
            initialize_database(&mut db).expect("idempotent startup");
            inner.db = db;
            let user = inner.user("name", "third").expect("recipient");
            let error = inner
                .delegation_allowed(
                    &user,
                    &DelegationInvocation {
                        id: grandchild_id.into(),
                        resource: RESOURCE.into(),
                        action: Action::Read,
                        arguments: Default::default(),
                    },
                )
                .err()
                .expect("revoked ancestor persists");
            assert_eq!(
                (error.0, error.1),
                (StatusCode::FORBIDDEN, "delegation_denied")
            );
            assert!(
                inner.sessions.is_empty()
                    && inner.approvals.is_empty()
                    && inner.authentications.is_empty()
            );
            assert_eq!(
                inner
                    .db
                    .query_row("SELECT COUNT(*) FROM delegations", [], |r| r
                        .get::<_, i64>(0))
                    .expect("no post-revoke child"),
                3
            );
        }
        drop(restarted);
        fs::remove_file(path).expect("remove synthetic file");
    }

    #[tokio::test]
    async fn signed_database_tokens_cannot_skip_or_replace_their_parent_metadata() {
        let (app, tokens) = delegation_app();
        let Json(root) = root_delegation(&app, &tokens["owner"], "guest", 300, 2)
            .await
            .expect("root");
        let root_id = root["id"].as_str().expect("root id");
        let Json(child) = child_delegation(&app, &tokens["guest"], root_id, "second", 200, 1)
            .await
            .expect("child");
        let id = child["id"].as_str().expect("child id");
        let inner = app.inner.lock().expect("inner");
        inner
            .db
            .execute("UPDATE delegations SET parent_id=NULL WHERE id=?1", [id])
            .expect("simulate signature-preserving ancestor skip");
        assert!(inner.delegation_chain(id).is_err());
        inner
            .db
            .execute(
                "UPDATE delegations SET parent_id=?1 WHERE id=?2",
                params![root_id, id],
            )
            .expect("restore parent metadata");
        let owner = inner.user("name", "owner").expect("owner");
        inner
            .db
            .execute(
                "UPDATE delegations SET delegator_id=?1 WHERE id=?2",
                params![owner.id, id],
            )
            .expect("simulate metadata authority substitution");
        assert!(inner.delegation_chain(id).is_err());
    }
}
