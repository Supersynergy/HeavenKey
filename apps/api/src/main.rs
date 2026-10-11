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
struct Session {
    user_id: String,
    expires: u64,
}
struct User {
    id: String,
    name: String,
    owner: bool,
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
fn holder(key: &Passkey) -> [u8; 32] {
    Sha256::digest(key.cred_id().as_ref()).into()
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
        self.authentications.retain(|_, v| v.expires > time);
        self.sessions.retain(|_, v| v.expires > time);
    }
    fn user(&self, field: &str, value: &str) -> ApiResult<User> {
        let query = match field {
            "id" => "SELECT id,name,owner,passkey,counter FROM users WHERE id=?1",
            _ => "SELECT id,name,owner,passkey,counter FROM users WHERE name=?1",
        };
        let row = self
            .db
            .query_row(query, [value], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, u32>(4)?,
                ))
            })
            .optional()
            .map_err(internal)?;
        let (id, name, owner, key, counter) =
            row.ok_or(ApiError(StatusCode::NOT_FOUND, "user_not_found"))?;
        Ok(User {
            id,
            name,
            owner,
            passkey: serde_json::from_str(&key).map_err(internal)?,
            counter,
        })
    }
    fn session_user(&mut self, headers: &HeaderMap) -> ApiResult<User> {
        self.prune();
        let token = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError(StatusCode::UNAUTHORIZED, "session_required"))?;
        let s = self
            .sessions
            .get(token)
            .ok_or(ApiError(StatusCode::UNAUTHORIZED, "session_expired"))?;
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
            &holder(&user.passkey),
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
    if inner.registrations.len() >= MAX_PENDING {
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
    let duplicate: bool = inner
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE credential_id=?1)",
            [URL_SAFE_NO_PAD.encode(key.cred_id().as_ref())],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if duplicate {
        return Err(ApiError(StatusCode::CONFLICT, "credential_exists"));
    }
    let owner = pending.owner;
    inner
        .db
        .execute(
            "INSERT INTO users(id,name,owner,credential_id,passkey) VALUES(?1,?2,?3,?4,?5)",
            params![
                pending.user_id.to_string(),
                pending.name,
                owner,
                URL_SAFE_NO_PAD.encode(key.cred_id().as_ref()),
                serde_json::to_string(&key).map_err(internal)?
            ],
        )
        .map_err(|_| ApiError(StatusCode::CONFLICT, "registration_conflict"))?;
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
    let (options, state) = inner
        .webauthn
        .start_passkey_authentication(std::slice::from_ref(&user.passkey))
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
    let mut pending = inner
        .authentications
        .remove(&input.request_id)
        .ok_or(forbidden("ceremony_missing"))?;
    if binding(&pending.invocation)? != binding(&input.invocation)? {
        return Err(forbidden("invocation_changed"));
    }
    // Reload the current counter before accepting concurrent ceremonies.
    let current = inner.user("id", &pending.user.id)?;
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
    if (result.counter() > 0 || current.counter > 0) && result.counter() <= current.counter {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "counter_not_increasing"));
    }
    pending.user.passkey = current.passkey;
    if pending.user.passkey.update_credential(&result).is_none() {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "credential_mismatch"));
    }
    if let Some(invocation) = &pending.invocation {
        inner.grant_allowed(&pending.user, invocation)?;
    }
    let key_json = serde_json::to_string(&pending.user.passkey).map_err(internal)?;
    let tx = inner.db.transaction().map_err(internal)?;
    tx.execute(
        "UPDATE users SET passkey=?1,counter=?2 WHERE id=?3",
        params![key_json, result.counter(), pending.user.id],
    )
    .map_err(internal)?;
    if let Some(invocation) = &pending.invocation {
        let id = token_id(&invocation.grant)?;
        let inserted=tx.execute("INSERT INTO operations(id,grant_id,holder,created) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM grants WHERE id=?2 AND revoked=0)",params![input.request_id,id,pending.user.id,i64::try_from(now()).map_err(internal)?]).map_err(internal)?;
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
                user_id: pending.user.id,
                expires: now() + 300,
            },
        );
        Ok(Json(
            json!({"session":session,"name":pending.user.name,"owner":pending.user.owner}),
        ))
    }
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
            audience: holder(&guest.passkey),
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
    let db = Connection::open(Path::new(&data).join("uac.sqlite"))?;
    db.busy_timeout(Duration::from_secs(2))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,owner INTEGER NOT NULL,credential_id TEXT UNIQUE NOT NULL,passkey TEXT NOT NULL,counter INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,guest_id TEXT REFERENCES users(id),token TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,grant_id TEXT REFERENCES grants(id),holder TEXT REFERENCES users(id),created INTEGER NOT NULL);")?;
    db.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON users(owner) WHERE owner=1;")?;
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
