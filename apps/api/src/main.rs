#![forbid(unsafe_code)]

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
    collections::HashMap,
    fs,
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uac_verifier::{Action, Grant, Signed, authorize_passkey_grant, grant_id, sign_grant};
use uuid::Uuid;
use webauthn_rs::prelude::*;

const RESOURCE: &str = "urn:uac:lab:document";
const CEREMONY_TTL: u64 = 120;
const MAX_PENDING: usize = 128;
const MAX_CREDENTIALS: usize = 8;

#[derive(Clone)]
struct App {
    inner: Arc<Mutex<Inner>>,
    origin: String,
    host: String,
}
struct Inner {
    db: Connection,
    webauthn: Webauthn,
    issuer: SigningKey,
    bootstrap_hash: [u8; 32],
    registrations: HashMap<String, Registration>,
    enrollments: HashMap<String, Enrollment>,
    authentications: HashMap<String, Authentication>,
    sessions: HashMap<String, Session>,
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
    expires: u64,
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthStart {
    name: String,
    invocation: Option<Invocation>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthFinish {
    request_id: String,
    credential: PublicKeyCredential,
    invocation: Option<Invocation>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantCreate {
    guest_name: String,
    ttl_seconds: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantRevoke {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialStart {
    label: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialRevoke {
    id: String,
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
fn binding(invocation: &Option<Invocation>) -> ApiResult<[u8; 32]> {
    Ok(Sha256::digest(serde_json::to_vec(invocation).map_err(internal)?).into())
}

impl Inner {
    fn prune(&mut self) {
        let time = now();
        self.registrations.retain(|_, v| v.expires > time);
        self.enrollments.retain(|_, v| v.expires > time);
        self.authentications.retain(|_, v| v.expires > time);
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
        "x-content-type-options",
        "nosniff".parse().expect("static header"),
    );
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'".parse().expect("static header"));
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
    Json(input): Json<AuthStart>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    if inner.authentications.len() >= MAX_PENDING {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "ceremony_limit"));
    }
    let user = inner.user("name", &input.name)?;
    if let Some(invocation) = &input.invocation {
        inner.grant_allowed(&user, invocation)?;
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
            expires: now() + CEREMONY_TTL,
        },
    );
    Ok(Json(
        json!({"request_id":request_id,"options":options,"invocation_binding":URL_SAFE_NO_PAD.encode(bound)}),
    ))
}

async fn auth_finish(
    State(app): State<App>,
    Json(input): Json<AuthFinish>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    let pending = inner
        .authentications
        .remove(&input.request_id)
        .ok_or(forbidden("ceremony_missing"))?;
    if binding(&pending.invocation)? != binding(&input.invocation)? {
        return Err(forbidden("invocation_changed"));
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
    tx.commit().map_err(internal)?;
    if let Some(invocation) = pending.invocation {
        Ok(Json(
            json!({"authorized":true,"resource":invocation.resource,"action":invocation.action,"arguments":invocation.arguments,"operation":input.request_id,"data":"HeavenKey example document — verified access"}),
        ))
    } else {
        let session = Uuid::new_v4().to_string();
        inner.sessions.insert(
            session.clone(),
            Session {
                user_id: user.id,
                credential_id: id,
                expires: now() + 300,
            },
        );
        Ok(Json(
            json!({"session":session,"name":user.name,"owner":user.owner}),
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
    let label = credential_label(&input.label)?;
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    if inner.registrations.len() + inner.enrollments.len() >= MAX_PENDING {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "ceremony_limit"));
    }
    inner.check_credential_capacity(&user.id)?;
    let token = session_token(&headers)?.to_owned();
    let authorizing_credential_id = inner.sessions[&token].credential_id.clone();
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
    if pending.user_id != user.id
        || pending.session_token != token
        || pending.authorizing_credential_id != inner.sessions[token].credential_id
    {
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
    let user = inner.session_user(&headers)?;
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
    Ok(Json(
        json!({"id":input.id,"revoked":true,"reauthentication_required":true}),
    ))
}

async fn create_grant(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<GrantCreate>,
) -> ApiResult<Json<Value>> {
    if !(1..=3600).contains(&input.ttl_seconds) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_expiry"));
    }
    let mut inner = app.inner.lock().map_err(internal)?;
    let owner = inner.session_user(&headers)?;
    if !owner.owner {
        return Err(forbidden("owner_required"));
    }
    let guest = inner.user("name", &input.guest_name)?;
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
    if !inner.session_user(&headers)?.owner {
        return Err(forbidden("owner_required"));
    }
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

async fn index() -> Html<&'static str> {
    Html(include_str!("../../web/index.html"))
}
async fn script() -> ApiResult<Response> {
    Ok((
        [("content-type", "text/javascript")],
        fs::read("apps/web/dist/main.js").map_err(internal)?,
    )
        .into_response())
}
async fn style() -> Response {
    (
        [("content-type", "text/css")],
        include_str!("../../web/src/style.css"),
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
         CREATE INDEX IF NOT EXISTS credentials_user_active ON credentials(user_id,active);",
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO credentials(id,user_id,passkey,counter,label,active,created) SELECT credential_id,id,passkey,counter,'Initial passkey',1,?1 FROM users",
        [i64::try_from(now())
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?],
    )?;
    tx.commit()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("UAC_PORT")
        .unwrap_or_else(|_| "18240".into())
        .parse()?;
    let origin = format!("http://localhost:{port}");
    let data = std::env::var("UAC_DATA").unwrap_or_else(|_| "data".into());
    fs::create_dir_all(&data)?;
    let bootstrap_hash = bootstrap_hash(Path::new(&data))?;
    let key_path = Path::new(&data).join("issuer.key");
    let bytes = if key_path.exists() {
        fs::read(&key_path)?
    } else {
        let mut bytes = [0; 32];
        rand::rng().fill_bytes(&mut bytes);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&key_path)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        bytes.to_vec()
    };
    let issuer = SigningKey::from_bytes(&bytes.try_into().map_err(|_| "invalid issuer key")?);
    let mut db = Connection::open(Path::new(&data).join("uac.sqlite"))?;
    db.busy_timeout(Duration::from_secs(2))?;
    initialize_database(&mut db)?;
    let webauthn = WebauthnBuilder::new("localhost", &Url::parse(&origin)?)?
        .rp_name("HeavenKey access lab")
        .build()?;
    let app = App {
        inner: Arc::new(Mutex::new(Inner {
            db,
            webauthn,
            issuer,
            bootstrap_hash,
            registrations: HashMap::new(),
            enrollments: HashMap::new(),
            authentications: HashMap::new(),
            sessions: HashMap::new(),
        })),
        origin: origin.clone(),
        host: format!("localhost:{port}"),
    };
    let router = Router::new()
        .route("/", get(index))
        .route("/main.js", get(script))
        .route("/style.css", get(style))
        .route(
            "/health",
            get(|| async { Json(json!({"status":"ok","mode":"simulation-lab"})) }),
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
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), origin_guard))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("HeavenKey listening on {origin}; hardware verification deferred");
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

    fn app() -> App {
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
                sessions: HashMap::new(),
            })),
            origin: origin.into(),
            host: "localhost:18240".into(),
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

    fn headers(token: &str) -> HeaderMap {
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
            Json(CredentialRevoke { id: bob_id.clone() }),
        )
        .await
        .expect_err("foreign key denied");
        assert_eq!(
            (foreign.0, foreign.1),
            (StatusCode::NOT_FOUND, "credential_not_found")
        );
        let Json(revoked) = credential_revoke(
            State(app.clone()),
            headers(&token),
            Json(CredentialRevoke {
                id: alice_id.clone(),
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
            Json(CredentialRevoke { id: "extra".into() }),
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
            Json(AuthStart {
                name: "alice".into(),
                invocation: None,
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
}
