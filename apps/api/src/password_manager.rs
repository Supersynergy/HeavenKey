use super::*;

pub const MAX_BODY: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub struct VaultApp {
    db: Arc<Mutex<Connection>>,
    origin: String,
    host: String,
    token: Arc<str>,
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
        json!({"token": app.token.as_ref(), "revision": revision(&db)?}),
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
    access(&app, &headers, true)?;
    let db = app.db.lock().map_err(internal)?;
    Ok(Json(current(&db)?))
}

pub async fn save(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Save>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
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
    tx.execute(
        "INSERT INTO password_manager(id,revision,record) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record",
        params![(revision + 1) as i64, record],
    ).map_err(internal)?;
    tx.commit().map_err(internal)?;
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

async fn guard(State(app): State<VaultApp>, req: Request, next: Next) -> Response {
    if req.headers().get("host").and_then(|v| v.to_str().ok()) != Some(&app.host)
        || (req.method() != axum::http::Method::GET
            && req.headers().get("origin").and_then(|v| v.to_str().ok()) != Some(&app.origin))
    {
        return forbidden("local_vault_denied").into_response();
    }
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
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

pub async fn run(data: &Path, port: u16, open: bool) -> Result<(), Box<dyn std::error::Error>> {
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
    let origin = format!("http://localhost:{port}");
    let mut token = [0u8; 32];
    rand::rng().fill_bytes(&mut token);
    let app = VaultApp {
        db: Arc::new(Mutex::new(db)),
        origin: origin.clone(),
        host: format!("localhost:{port}"),
        token: URL_SAFE_NO_PAD.encode(token).into(),
    };
    let router = Router::new()
        .route(
            "/",
            get(|| async { axum::response::Redirect::temporary("/passwords/") }),
        )
        .route("/passwords/", get(page))
        .route("/passwords.js", get(script))
        .route("/passwords.css", get(style))
        .route(
            "/health",
            get(|| async { Json(json!({"status":"ok","mode":"local-password-manager"})) }),
        )
        .route("/api/password-vault/config", get(config))
        .route("/api/password-vault", get(read).post(save))
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
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
