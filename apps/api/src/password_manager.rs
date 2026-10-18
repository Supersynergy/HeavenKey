use super::*;
mod access;
mod broker;
mod browser_executor;

pub const MAX_BODY: usize = 2 * 1024 * 1024;
const PAIRING_TTL: Duration = Duration::from_secs(120);
const MAX_PAIRING_ATTEMPTS: u8 = 8;
const MAX_EXTENSION_CLIENTS: usize = 8;

#[derive(Clone)]
pub struct VaultApp {
    db: Arc<Mutex<Connection>>,
    origin: String,
    host: String,
    token: Arc<str>,
    extensions: Arc<Mutex<Extensions>>,
    access: Arc<access::Access>,
    broker: Arc<broker::Broker>,
}

#[derive(Default)]
struct Extensions {
    pending: Option<Pairing>,
    grants: HashMap<String, String>,
}

struct Pairing {
    code: String,
    expires: Instant,
    attempts: u8,
}

impl Extensions {
    fn expire(&mut self) {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| Instant::now() >= p.expires)
        {
            self.pending = None;
        }
    }
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn extension_origin(origin: &str) -> bool {
    if let Some(id) = origin.strip_prefix("chrome-extension://") {
        return id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b));
    }
    origin.strip_prefix("moz-extension://").is_some_and(|id| {
        id.len() == 36
            && uuid::Uuid::parse_str(id)
                .is_ok_and(|parsed| parsed.hyphenated().to_string() == id.to_ascii_lowercase())
    })
}

fn extension_access(app: &VaultApp, headers: &HeaderMap) -> ApiResult<()> {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let Some(origin) = header("origin").filter(|origin| extension_origin(origin)) else {
        return Err(forbidden("local_vault_denied"));
    };
    let Some(token) = header("x-heavenkey-token") else {
        return Err(forbidden("local_vault_denied"));
    };
    if header("x-heavenkey-client") != Some("password-extension") {
        return Err(forbidden("local_vault_denied"));
    }
    let extensions = app.extensions.lock().map_err(internal)?;
    if extensions.grants.get(origin).map(String::as_str) != Some(token) {
        return Err(forbidden("local_vault_denied"));
    }
    Ok(())
}

fn vault_access(app: &VaultApp, headers: &HeaderMap) -> ApiResult<()> {
    if headers
        .get("x-heavenkey-client")
        .and_then(|v| v.to_str().ok())
        == Some("password-extension")
    {
        extension_access(app, headers)
    } else {
        access(app, headers, true)
    }
}

async fn pairing_create(State(app): State<VaultApp>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let code = random_secret();
    app.extensions.lock().map_err(internal)?.pending = Some(Pairing {
        code: code.clone(),
        expires: Instant::now() + PAIRING_TTL,
        attempts: 0,
    });
    Ok(Json(
        json!({"code": code, "expires_in": PAIRING_TTL.as_secs()}),
    ))
}

async fn pairing_status(State(app): State<VaultApp>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let mut extensions = app.extensions.lock().map_err(internal)?;
    extensions.expire();
    let mut origins: Vec<_> = extensions.grants.keys().collect();
    origins.sort();
    Ok(Json(
        json!({"paired": origins.len(), "pending": extensions.pending.is_some(), "origins": origins}),
    ))
}

async fn pairing_revoke(State(app): State<VaultApp>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    *app.extensions.lock().map_err(internal)? = Extensions::default();
    Ok(Json(json!({"paired": 0})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Connect {
    code: String,
}

async fn connect(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Connect>,
) -> ApiResult<Json<Value>> {
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .filter(|origin| extension_origin(origin))
        .ok_or_else(|| forbidden("local_vault_denied"))?;
    if headers
        .get("x-heavenkey-client")
        .and_then(|v| v.to_str().ok())
        != Some("password-extension")
    {
        return Err(forbidden("local_vault_denied"));
    }
    let mut extensions = app.extensions.lock().map_err(internal)?;
    extensions.expire();
    let Some(pending) = extensions.pending.as_mut() else {
        return Err(forbidden("extension_pairing_denied"));
    };
    if input.code != pending.code {
        pending.attempts += 1;
        if pending.attempts >= MAX_PAIRING_ATTEMPTS {
            extensions.pending = None;
        }
        return Err(forbidden("extension_pairing_denied"));
    }
    extensions.pending = None;
    if extensions.grants.len() >= MAX_EXTENSION_CLIENTS && !extensions.grants.contains_key(origin) {
        return Err(ApiError(StatusCode::CONFLICT, "extension_client_limit"));
    }
    let db = app.db.lock().map_err(internal)?;
    let revision = revision(&db)?;
    let token = random_secret();
    extensions.grants.insert(origin.to_owned(), token.clone());
    Ok(Json(json!({"token": token, "revision": revision})))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    version: u8,
    kdf: String,
    iterations: u32,
    salt: String,
    iv: String,
    ciphertext: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Save {
    expected_revision: u64,
    record: Envelope,
}

fn decoded(value: &str, min: usize, max: usize) -> bool {
    if value.len() > max.div_ceil(3) * 4 {
        return false;
    }
    URL_SAFE_NO_PAD.decode(value).is_ok_and(|bytes| {
        (min..=max).contains(&bytes.len()) && URL_SAFE_NO_PAD.encode(&bytes) == value
    })
}

impl Envelope {
    fn valid(&self) -> bool {
        self.version == 1
            && self.kdf == "PBKDF2-SHA256"
            && self.iterations == 600_000
            && decoded(&self.salt, 16, 16)
            && decoded(&self.iv, 12, 12)
            && decoded(&self.ciphertext, 16, 1024 * 1024 + 16)
    }
}

fn access(app: &VaultApp, headers: &HeaderMap, token_required: bool) -> ApiResult<()> {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let origin = header("origin");
    if !app.origin.starts_with("http://localhost:")
        || header("x-heavenkey-client") != Some("password-manager")
        || origin.is_some_and(|origin| origin != app.origin)
        || (origin.is_none() && header("sec-fetch-site") != Some("same-origin"))
        || (token_required && header("x-heavenkey-token") != Some(&app.token))
    {
        return Err(forbidden("local_vault_denied"));
    }
    Ok(())
}

pub async fn config(State(app): State<VaultApp>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &headers, false)?;
    let db = app.db.lock().map_err(internal)?;
    Ok(Json(
        json!({"token": app.token.as_ref(), "revision": revision(&db)?, "share_origin": app.access.share_origin}),
    ))
}

fn revision(db: &Connection) -> ApiResult<u64> {
    let value = db
        .query_row(
            "SELECT revision FROM password_manager WHERE id=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(internal)?
        .unwrap_or(0);
    u64::try_from(value).map_err(internal)
}

fn current(db: &Connection) -> ApiResult<Value> {
    let row = db
        .query_row(
            "SELECT revision,record FROM password_manager WHERE id=1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(internal)?;
    match row {
        Some((revision, record)) => Ok(
            json!({"revision": revision, "record": serde_json::from_str::<Envelope>(&record).map_err(internal)?}),
        ),
        None => Ok(json!({"revision": 0, "record": null})),
    }
}

pub async fn read(State(app): State<VaultApp>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    vault_access(&app, &headers)?;
    let db = app.db.lock().map_err(internal)?;
    Ok(Json(current(&db)?))
}

async fn read_post(
    app: State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<serde_json::Map<String, Value>>,
) -> ApiResult<Json<Value>> {
    if !input.is_empty() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_vault_read",
        ));
    }
    read(app, headers).await
}

pub async fn save(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Save>,
) -> ApiResult<Json<Value>> {
    vault_access(&app, &headers)?;
    if !input.record.valid() || input.expected_revision >= i64::MAX as u64 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_password_vault",
        ));
    }
    let record = serde_json::to_string(&input.record).map_err(internal)?;
    let mut db = app.db.lock().map_err(internal)?;
    let tx = db.transaction().map_err(internal)?;
    let revision = revision(&tx)?;
    if revision != input.expected_revision {
        return Err(ApiError(StatusCode::CONFLICT, "password_vault_changed"));
    }
    let previous: Option<String> = tx
        .query_row(
            "SELECT record FROM password_manager WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(internal)?;
    let salt_changed = previous
        .as_deref()
        .and_then(|record| serde_json::from_str::<Envelope>(record).ok())
        .filter(Envelope::valid)
        .is_none_or(|record| record.salt != input.record.salt);
    if salt_changed {
        tx.execute("DELETE FROM password_passkeys", [])
            .map_err(internal)?;
        tx.execute("UPDATE password_shares SET revoked=1", [])
            .map_err(internal)?;
    }
    tx.execute(
        "INSERT INTO password_manager(id,revision,record) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record",
        params![(revision + 1) as i64, record],
    ).map_err(internal)?;
    tx.commit().map_err(internal)?;
    drop(db);
    app.broker.invalidate();
    if salt_changed {
        app.access.invalidate()?;
    }
    Ok(Json(
        json!({"revision": revision + 1, "record": input.record}),
    ))
}

pub async fn page() -> Html<&'static str> {
    Html(include_str!("../../web/passwords.html"))
}

pub async fn script() -> Response {
    (
        [("content-type", "text/javascript")],
        include_bytes!("../../web/dist/passwords.js").as_slice(),
    )
        .into_response()
}

pub async fn style() -> Response {
    (
        [("content-type", "text/css")],
        include_str!("../../web/src/passwords.css"),
    )
        .into_response()
}

async fn cover() -> Response {
    (
        [("content-type", "image/png")],
        include_bytes!("../../../docs/assets/heavenkey-hero-square.png").as_slice(),
    )
        .into_response()
}

fn recipient_route(path: &str) -> bool {
    matches!(
        path,
        "/api/password-shares/recipient/start"
            | "/api/password-shares/recipient/verify"
            | "/api/password-shares/recipient/finish"
    )
}

fn host_allowed(app: &VaultApp, host: Option<&str>, path: &str) -> bool {
    host == Some(&app.host)
        || (host == Some(&app.access.share_host)
            && (recipient_route(path)
                || matches!(
                    path,
                    "/share/" | "/share.js" | "/passwords.css" | "/heavenkey-cover.png"
                )))
}

async fn guard(State(app): State<VaultApp>, req: Request, next: Next) -> Response {
    use axum::http::Method;
    let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
    let extension_route = matches!(
        req.uri().path(),
        "/api/password-vault"
            | "/api/password-vault/read"
            | "/api/password-vault/extension/connect"
    );
    let cors_origin = origin
        .filter(|value| extension_route && extension_origin(value))
        .map(str::to_owned);
    let recipient_route = recipient_route(req.uri().path());
    let host = req.headers().get("host").and_then(|v| v.to_str().ok());
    if !host_allowed(&app, host, req.uri().path()) {
        return forbidden("local_vault_denied").into_response();
    }
    let mut response = if req.method() == Method::OPTIONS {
        let method = req
            .headers()
            .get("access-control-request-method")
            .and_then(|v| v.to_str().ok());
        let allowed_method = method == Some("POST")
            || (method == Some("GET") && req.uri().path() == "/api/password-vault");
        let allowed_headers = req
            .headers()
            .get("access-control-request-headers")
            .is_none_or(|value| {
                value.to_str().is_ok_and(|value| {
                    value.split(',').all(|name| {
                        matches!(
                            name.trim().to_ascii_lowercase().as_str(),
                            "content-type" | "x-heavenkey-client" | "x-heavenkey-token"
                        )
                    })
                })
            });
        if cors_origin.is_some() && allowed_method && allowed_headers {
            StatusCode::NO_CONTENT.into_response()
        } else {
            forbidden("local_vault_denied").into_response()
        }
    } else if req.method() != Method::GET
        && origin
            != Some(if recipient_route {
                &app.access.share_origin
            } else {
                &app.origin
            })
        && cors_origin.is_none()
        && !broker::agent_transport(req.headers(), req.uri().path())
    {
        forbidden("local_vault_denied").into_response()
    } else {
        next.run(req).await
    };
    let headers = response.headers_mut();
    if let Some(origin) = cors_origin
        && let Ok(origin) = origin.parse()
    {
        headers.insert("access-control-allow-origin", origin);
        headers.insert("vary", "Origin".parse().expect("static header"));
        headers.insert(
            "access-control-allow-methods",
            "GET, POST, OPTIONS".parse().expect("static header"),
        );
        headers.insert(
            "access-control-allow-headers",
            "X-HeavenKey-Client, X-HeavenKey-Token, Content-Type"
                .parse()
                .expect("static header"),
        );
    }
    headers.insert("cache-control", "no-store".parse().expect("static header"));
    headers.insert(
        "referrer-policy",
        "no-referrer".parse().expect("static header"),
    );
    headers.insert(
        "x-content-type-options",
        "nosniff".parse().expect("static header"),
    );
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; connect-src 'self'".parse().expect("static header"));
    response
}

async fn shutdown_signal() {
    #[cfg(unix)]
    if let Ok(mut term) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        return;
    }
    let _ = tokio::signal::ctrl_c().await;
}

pub async fn run(data: &Path, port: u16, open: bool) -> Result<(), Box<dyn std::error::Error>> {
    uac_browser_pipe::harden_process()?;
    if std::env::var_os("HEAVENKEY_PUBLIC_ORIGIN").is_some()
        || std::env::var_os("HEAVENKEY_ORIGIN").is_some()
    {
        return Err("Password-manager mode is local only; remove public origin settings".into());
    }
    desktop::prepare_data(data)?;
    let path = data.join("passwords.sqlite");
    if !path.exists() {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?;
    }
    if !fs::symlink_metadata(&path)?.is_file() {
        return Err("Password database must be a regular file".into());
    }
    let db = Connection::open(&path)?;
    db.busy_timeout(Duration::from_secs(2))?;
    db.execute_batch("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS password_manager(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>0),record TEXT NOT NULL);")?;
    access::schema(&db)?;
    let share_origin = std::env::var_os("HEAVENKEY_SHARE_ORIGIN")
        .map(|value| value.into_string())
        .transpose()
        .map_err(|_| "HEAVENKEY_SHARE_ORIGIN must be valid UTF-8")?;
    let access = Arc::new(access::Access::new(port, share_origin.as_deref())?);
    let origin = format!("http://localhost:{port}");
    let app = VaultApp {
        db: Arc::new(Mutex::new(db)),
        origin: origin.clone(),
        host: format!("localhost:{port}"),
        token: random_secret().into(),
        extensions: Arc::new(Mutex::new(Extensions::default())),
        access,
        broker: Arc::new(broker::Broker::new()),
    };
    broker::Broker::supervise(&app.broker, app.db.clone());
    let shutdown_broker = app.broker.clone();
    let router = Router::new()
        .route(
            "/",
            get(|| async { axum::response::Redirect::temporary("/passwords/") }),
        )
        .route("/passwords/", get(page))
        .route("/passwords.js", get(script))
        .route("/passwords.css", get(style))
        .route(
            "/share/",
            get(|| async { Html(include_str!("../../web/share.html")) }),
        )
        .route(
            "/share.js",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_bytes!("../../web/dist/share.js").as_slice(),
                )
            }),
        )
        .route("/heavenkey-cover.png", get(cover))
        .route(
            "/health",
            get(|| async { Json(json!({"status":"ok","mode":"local-password-manager"})) }),
        )
        .route("/api/password-vault/config", get(config))
        .route(
            "/api/password-vault/extension/pairing",
            get(pairing_status)
                .post(pairing_create)
                .delete(pairing_revoke),
        )
        .route(
            "/api/password-vault/extension/connect",
            axum::routing::post(connect),
        )
        .route("/api/password-vault", get(read).post(save))
        .route("/api/password-vault/read", axum::routing::post(read_post))
        .merge(access::routes())
        .merge(broker::routes())
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!(
        "HeavenKey {}: {origin}/passwords/",
        env!("CARGO_PKG_VERSION")
    );
    println!(
        "Encrypted password vault / verschlüsselter Tresor: {}",
        path.display()
    );
    if open {
        desktop::open_browser(&format!("{origin}/passwords/"));
    }
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            let _ = tokio::task::spawn_blocking(move || shutdown_broker.shutdown()).await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_origins_and_pairing_expiry_are_strict() {
        assert!(extension_origin(&format!(
            "chrome-extension://{}",
            "a".repeat(32)
        )));
        assert!(extension_origin(
            "moz-extension://12345678-1234-1234-1234-123456789abc"
        ));
        for invalid in [
            "null",
            "https://example.test",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaq",
            "moz-extension://12345678123412341234123456789abc",
            "moz-extension://12345678-1234-1234-1234-123456789abc/",
        ] {
            assert!(!extension_origin(invalid));
        }
        let mut extensions = Extensions {
            pending: Some(Pairing {
                code: "synthetic".into(),
                expires: Instant::now(),
                attempts: 0,
            }),
            ..Extensions::default()
        };
        extensions.expire();
        assert!(extensions.pending.is_none());
    }

    #[test]
    fn strict_envelope_bounds_before_storage() {
        let mut value = Envelope {
            version: 1,
            kdf: "PBKDF2-SHA256".into(),
            iterations: 600_000,
            salt: URL_SAFE_NO_PAD.encode([0; 16]),
            iv: URL_SAFE_NO_PAD.encode([0; 12]),
            ciphertext: URL_SAFE_NO_PAD.encode([0; 16]),
        };
        assert!(value.valid());
        value.iterations = u32::MAX;
        assert!(!value.valid());
        value.iterations = 600_000;
        value.salt.push('=');
        assert!(!value.valid());
        assert!(!decoded(&"A".repeat(MAX_BODY), 16, 1024 * 1024 + 16));
    }
}
