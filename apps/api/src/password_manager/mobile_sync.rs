use super::*;
use axum::extract::Path as RoutePath;
use openssl::{
    asn1::Asn1Time,
    bn::{BigNum, MsbOption},
    hash::MessageDigest,
    pkey::PKey,
    rsa::Rsa,
    x509::{X509, X509NameBuilder},
};
use sha2::Digest;
use std::path::PathBuf;

const LIMIT: usize = 1_500_000;

pub(super) struct MobileSync {
    directory: PathBuf,
    port: u16,
    server: Mutex<Option<Server>>,
    pending: Mutex<Option<Pending>>,
}
struct Server {
    pin: String,
    handle: axum_server::Handle<std::net::SocketAddr>,
}
struct Pending {
    id: String,
    hash: [u8; 32],
    expires: Instant,
    attempts: u8,
}

impl Default for MobileSync {
    fn default() -> Self {
        Self::new(Path::new(""), 0)
    }
}
impl MobileSync {
    pub(super) fn new(directory: &Path, port: u16) -> Self {
        Self {
            directory: directory.to_owned(),
            port,
            server: Mutex::new(None),
            pending: Mutex::new(None),
        }
    }
    fn ensure_server(&self, app: VaultApp) -> ApiResult<String> {
        let mut server = self.server.lock().map_err(internal)?;
        if let Some(server) = server.as_ref() {
            return Ok(server.pin.clone());
        }
        if self.port == 0 {
            return Err(ApiError(StatusCode::CONFLICT, "sync_unavailable"));
        }
        let (certificate, private) = self.certificate().map_err(internal)?;
        let config = axum_server::tls_openssl::OpenSSLConfig::from_pem(&certificate, &private)
            .map_err(internal)?;
        let cert = X509::from_pem(&certificate).map_err(internal)?;
        let pin = URL_SAFE_NO_PAD.encode(cert.digest(MessageDigest::sha256()).map_err(internal)?);
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, self.port))
            .map_err(|_| ApiError(StatusCode::CONFLICT, "sync_port_unavailable"))?;
        listener.set_nonblocking(true).map_err(internal)?;
        let handle = axum_server::Handle::new();
        let lifetime = handle.clone();
        let tls_server = axum_server::from_tcp(listener)
            .map_err(internal)?
            .acceptor(axum_server::tls_openssl::OpenSSLAcceptor::new(config))
            .handle(lifetime);
        let router = Router::new()
            .route("/sync/v1/connect", axum::routing::post(connect))
            .route("/sync/v1/snapshot", axum::routing::post(peer_exchange))
            .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
            .layer(middleware::from_fn(remote_guard))
            .with_state(app);
        tokio::spawn(async move {
            if let Err(error) = tls_server.serve(router.into_make_service()).await {
                eprintln!("HeavenKey sync listener stopped: {error}");
            }
        });
        *server = Some(Server {
            pin: pin.clone(),
            handle,
        });
        Ok(pin)
    }
    fn certificate(&self) -> Result<(Vec<u8>, Vec<u8>), Box<dyn std::error::Error>> {
        let cert_path = self.directory.join("mobile-sync-cert.pem");
        let key_path = self.directory.join("mobile-sync-key.pem");
        if cert_path.exists() && key_path.exists() {
            for path in [&cert_path, &key_path] {
                if !fs::symlink_metadata(path)?.is_file() {
                    return Err("invalid sync certificate file".into());
                }
            }
            return Ok((fs::read(cert_path)?, fs::read(key_path)?));
        }
        if cert_path.exists() || key_path.exists() {
            return Err("incomplete sync certificate; preserve files and repair explicitly".into());
        }
        let key = PKey::from_rsa(Rsa::generate(2048)?)?;
        let mut name = X509NameBuilder::new()?;
        name.append_entry_by_text("CN", "HeavenKey paired local sync")?;
        let name = name.build();
        let mut cert = X509::builder()?;
        cert.set_version(2)?;
        let mut serial = BigNum::new()?;
        serial.rand(128, MsbOption::MAYBE_ZERO, false)?;
        let serial = serial.to_asn1_integer()?;
        cert.set_serial_number(&serial)?;
        cert.set_subject_name(&name)?;
        cert.set_issuer_name(&name)?;
        cert.set_pubkey(&key)?;
        let before = Asn1Time::days_from_now(0)?;
        let after = Asn1Time::days_from_now(3650)?;
        cert.set_not_before(&before)?;
        cert.set_not_after(&after)?;
        cert.sign(&key, MessageDigest::sha256())?;
        let certificate = cert.build().to_pem()?;
        let private = key.private_key_to_pem_pkcs8()?;
        for (path, bytes) in [(&key_path, &private), (&cert_path, &certificate)] {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            let mut output = options.open(path)?;
            output.write_all(bytes)?;
            output.sync_all()?;
        }
        Ok((certificate, private))
    }
    pub(super) fn shutdown(&self) {
        if let Ok(server) = self.server.lock()
            && let Some(server) = server.as_ref()
        {
            server.handle.shutdown();
        }
    }
    pub(super) fn resume(&self, app: VaultApp) -> ApiResult<()> {
        let count: i64 = app
            .db
            .lock()
            .map_err(internal)?
            .query_row(
                "SELECT count(*) FROM mobile_sync WHERE enabled=1 AND auth_hash IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if count > 0 {
            self.ensure_server(app)?;
        }
        Ok(())
    }
}

pub(super) fn schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS mobile_sync(id TEXT PRIMARY KEY,label TEXT NOT NULL,auth_hash BLOB,enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 0,record TEXT);")
}

async fn remote_guard(req: Request, next: Next) -> Response {
    if req.headers().contains_key("origin")
        || req
            .headers()
            .get("x-heavenkey-client")
            .and_then(|v| v.to_str().ok())
            != Some("mobile-sync")
    {
        return forbidden("sync_denied").into_response();
    }
    let mut result = next.run(req).await;
    let headers = result.headers_mut();
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    result
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    host: String,
    label: String,
}
async fn start(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Start>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    if input.host.len() > 253
        || input.host.is_empty()
        || !input
            .host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        || input.host.starts_with('.')
        || input.host.ends_with('.')
        || input.label.trim().is_empty()
        || input.label.chars().count() > 80
    {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_sync_pairing",
        ));
    }
    let pin = app.mobile.ensure_server(app.clone())?;
    let db = app.db.lock().map_err(internal)?;
    db.execute(
        "UPDATE mobile_sync SET enabled=0 WHERE auth_hash IS NULL",
        [],
    )
    .map_err(internal)?;
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM mobile_sync WHERE enabled=1",
            [],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if count >= 8 {
        return Err(ApiError(StatusCode::CONFLICT, "sync_device_limit"));
    }
    let id = Uuid::new_v4().to_string();
    let code = random_secret();
    let mut pending = app.mobile.pending.lock().map_err(internal)?;
    if let Some(previous) = pending.take() {
        db.execute(
            "UPDATE mobile_sync SET enabled=0 WHERE id=?1 AND auth_hash IS NULL",
            [previous.id],
        )
        .map_err(internal)?;
    }
    db.execute(
        "INSERT INTO mobile_sync(id,label) VALUES(?1,?2)",
        params![id, input.label.trim()],
    )
    .map_err(internal)?;
    *pending = Some(Pending {
        id: id.clone(),
        hash: sha2::Sha256::digest(code.as_bytes()).into(),
        expires: Instant::now() + Duration::from_secs(120),
        attempts: 0,
    });
    Ok(Json(
        json!({"id":id,"code":code,"expires_in":120,"endpoint":format!("https://{}:{}",input.host,app.mobile.port),"certificate_sha256":pin}),
    ))
}
async fn status(State(app): State<VaultApp>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let db = app.db.lock().map_err(internal)?;
    let mut stmt=db.prepare("SELECT id,label,revision,auth_hash IS NOT NULL FROM mobile_sync WHERE enabled=1 ORDER BY rowid").map_err(internal)?;
    let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"connected":r.get::<_,bool>(3)?}))).map_err(internal)?;
    Ok(Json(
        json!({"devices":rows.collect::<Result<Vec<_>,_>>().map_err(internal)?}),
    ))
}
async fn revoke(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<String>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    app.db
        .lock()
        .map_err(internal)?
        .execute(
            "UPDATE mobile_sync SET enabled=0,auth_hash=NULL,record=NULL WHERE id=?1",
            [id],
        )
        .map_err(internal)?;
    Ok(Json(json!({"revoked":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Connect {
    id: String,
    code: String,
    token: String,
}
async fn connect(
    State(app): State<VaultApp>,
    Json(input): Json<Connect>,
) -> ApiResult<Json<Value>> {
    if input.id.len() > 80
        || input.code.len() > 80
        || !decode(&input.token, 32).is_some_and(|v| v.len() == 32)
    {
        return Err(forbidden("sync_pairing_denied"));
    }
    // Keep the database-before-pending lock order identical to pairing creation.
    let db = app.db.lock().map_err(internal)?;
    let mut pending = app.mobile.pending.lock().map_err(internal)?;
    let Some(value) = pending.as_mut() else {
        return Err(forbidden("sync_pairing_denied"));
    };
    if value.expires <= Instant::now() {
        *pending = None;
        return Err(forbidden("sync_pairing_denied"));
    }
    let hash: [u8; 32] = sha2::Sha256::digest(input.code.as_bytes()).into();
    if value.id != input.id || !openssl::memcmp::eq(&value.hash, &hash) {
        value.attempts += 1;
        if value.attempts >= 8 {
            *pending = None;
        }
        return Err(forbidden("sync_pairing_denied"));
    }
    let hash: [u8; 32] = sha2::Sha256::digest(input.token.as_bytes()).into();
    let changed=db.execute("UPDATE mobile_sync SET auth_hash=?1 WHERE id=?2 AND enabled=1 AND auth_hash IS NULL AND revision>0",params![hash.as_slice(),input.id]).map_err(internal)?;
    if changed != 1 {
        return Err(forbidden("sync_pairing_denied"));
    }
    *pending = None;
    Ok(Json(json!({"connected":true})))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ciphertext {
    version: u8,
    iv: String,
    ciphertext: String,
}
impl Ciphertext {
    fn valid(&self) -> bool {
        self.version == 1
            && decode(&self.iv, 12).is_some_and(|b| b.len() == 12)
            && decode(&self.ciphertext, LIMIT + 16).is_some_and(|b| b.len() >= 16)
    }
}
fn decode(s: &str, max: usize) -> Option<Vec<u8>> {
    if s.len() > max.div_ceil(3) * 4 {
        return None;
    }
    URL_SAFE_NO_PAD
        .decode(s)
        .ok()
        .filter(|v| v.len() <= max && URL_SAFE_NO_PAD.encode(v) == s)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Exchange {
    id: String,
    expected_revision: Option<u64>,
    record: Option<Ciphertext>,
}
fn exchange(db: &Connection, input: Exchange) -> ApiResult<Value> {
    if input.id.len() > 80
        || input.expected_revision.is_some() != input.record.is_some()
        || input.record.as_ref().is_some_and(|r| !r.valid())
    {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_sync_snapshot",
        ));
    }
    let current: Option<(i64, Option<String>)> = db
        .query_row(
            "SELECT revision,record FROM mobile_sync WHERE id=?1 AND enabled=1",
            [&input.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(internal)?;
    let (revision, record) = current.ok_or_else(|| forbidden("sync_denied"))?;
    if let Some(expected) = input.expected_revision {
        if expected != revision as u64 {
            return Err(ApiError(StatusCode::CONFLICT, "sync_revision_conflict"));
        }
        let next = revision
            .checked_add(1)
            .filter(|v| *v < 9_007_199_254_740_991)
            .ok_or(ApiError(StatusCode::CONFLICT, "sync_revision_limit"))?;
        let record = serde_json::to_string(&input.record.unwrap()).map_err(internal)?;
        db.execute("UPDATE mobile_sync SET revision=?1,record=?2 WHERE id=?3 AND enabled=1 AND revision=?4",params![next,record,input.id,revision]).map_err(internal)?;
        return Ok(
            json!({"revision":next,"record":serde_json::from_str::<Value>(&record).map_err(internal)?}),
        );
    }
    Ok(
        json!({"revision":revision,"record":record.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(internal)?}),
    )
}
async fn owner_exchange(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Exchange>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let db = app.db.lock().map_err(internal)?;
    Ok(Json(exchange(&db, input)?))
}
async fn peer_exchange(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Exchange>,
) -> ApiResult<Json<Value>> {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() == 43)
        .ok_or_else(|| forbidden("sync_denied"))?;
    let hash: [u8; 32] = sha2::Sha256::digest(token.as_bytes()).into();
    let db = app.db.lock().map_err(internal)?;
    let stored: Option<Vec<u8>> = db
        .query_row(
            "SELECT auth_hash FROM mobile_sync WHERE id=?1 AND enabled=1 AND auth_hash IS NOT NULL",
            [&input.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    if !stored.is_some_and(|v| openssl::memcmp::eq(&v, &hash)) {
        return Err(forbidden("sync_denied"));
    }
    Ok(Json(exchange(&db, input)?))
}
pub(super) fn routes() -> Router<VaultApp> {
    Router::new()
        .route("/api/mobile-sync/pairing", axum::routing::post(start))
        .route("/api/mobile-sync/devices", get(status))
        .route(
            "/api/mobile-sync/devices/{id}",
            axum::routing::delete(revoke),
        )
        .route(
            "/api/mobile-sync/snapshot",
            axum::routing::post(owner_exchange),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        schema(&db).unwrap();
        db.execute(
            "INSERT INTO mobile_sync(id,label) VALUES('one','Phone')",
            [],
        )
        .unwrap();
        db
    }
    fn record() -> Ciphertext {
        Ciphertext {
            version: 1,
            iv: URL_SAFE_NO_PAD.encode([1; 12]),
            ciphertext: URL_SAFE_NO_PAD.encode([2; 32]),
        }
    }
    #[test]
    fn sync_cas_preserves_snapshot_on_conflict_and_revocation() {
        let db = db();
        let push = || Exchange {
            id: "one".into(),
            expected_revision: Some(0),
            record: Some(record()),
        };
        assert_eq!(exchange(&db, push()).unwrap()["revision"], 1);
        assert_eq!(
            exchange(&db, push()).unwrap_err().1,
            "sync_revision_conflict"
        );
        assert_eq!(
            exchange(
                &db,
                Exchange {
                    id: "one".into(),
                    expected_revision: None,
                    record: None
                }
            )
            .unwrap()["revision"],
            1
        );
        db.execute("UPDATE mobile_sync SET enabled=0", []).unwrap();
        assert_eq!(exchange(&db, push()).unwrap_err().1, "sync_denied");
    }
    #[test]
    fn sync_rejects_malformed_records_before_storage() {
        let db = db();
        for iv in ["", "AAAA", "================"] {
            let mut r = record();
            r.iv = iv.into();
            assert!(
                exchange(
                    &db,
                    Exchange {
                        id: "one".into(),
                        expected_revision: Some(0),
                        record: Some(r)
                    }
                )
                .is_err()
            );
        }
        assert!(
            exchange(
                &db,
                Exchange {
                    id: "one".into(),
                    expected_revision: Some(0),
                    record: None
                }
            )
            .is_err()
        );
    }
}
