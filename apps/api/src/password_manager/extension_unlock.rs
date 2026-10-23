use super::*;

const TTL: Duration = Duration::from_secs(90);
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicKey {
    x: String,
    y: String,
}
impl PublicKey {
    fn valid(&self) -> bool {
        decoded(&self.x, 32, 32) && decoded(&self.y, 32, 32)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sealed {
    public_key: PublicKey,
    iv: String,
    ciphertext: String,
}
pub(super) struct Pending {
    origin: String,
    token: String,
    key: PublicKey,
    revision: u64,
    salt: String,
    expires: Instant,
    sealed: Option<Sealed>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    public_key: PublicKey,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approve {
    id: String,
    sealed: Sealed,
}
fn unavailable() -> ApiError {
    forbidden("extension_unlock_unavailable")
}
fn live(app: &VaultApp, p: &Pending, extensions: &Extensions) -> ApiResult<()> {
    if p.expires <= Instant::now() || extensions.grants.get(&p.origin) != Some(&p.token) {
        return Err(unavailable());
    }
    let value = current(&*app.db.lock().map_err(internal)?)?;
    if value["revision"].as_u64() != Some(p.revision)
        || value["record"]["salt"].as_str() != Some(p.salt.as_str())
    {
        return Err(unavailable());
    }
    Ok(())
}
async fn start(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Start>,
) -> ApiResult<Json<Value>> {
    extension_access(&app, &headers)?;
    if !input.public_key.valid() {
        return Err(unavailable());
    }
    let origin = headers["origin"].to_str().map_err(internal)?.to_owned();
    let token = headers["x-heavenkey-token"]
        .to_str()
        .map_err(internal)?
        .to_owned();
    let mut extensions = app.extensions.lock().map_err(internal)?;
    extensions
        .unlocks
        .retain(|_, p| p.expires > Instant::now() && p.origin != origin);
    // Recheck after acquiring the mutation lock; pairing can be revoked concurrently.
    if extensions.grants.get(&origin) != Some(&token) {
        return Err(unavailable());
    }
    let record = current(&*app.db.lock().map_err(internal)?)?;
    let salt = record["record"]["salt"]
        .as_str()
        .ok_or_else(unavailable)?
        .to_owned();
    let revision = record["revision"].as_u64().ok_or_else(unavailable)?;
    let id = random_secret();
    extensions.unlocks.insert(
        id.clone(),
        Pending {
            origin,
            token,
            key: input.public_key,
            revision,
            salt,
            expires: Instant::now() + TTL,
            sealed: None,
        },
    );
    Ok(Json(json!({"id":id,"expires_in":90})))
}
async fn describe(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Id>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let extensions = app.extensions.lock().map_err(internal)?;
    let p = extensions.unlocks.get(&input.id).ok_or_else(unavailable)?;
    live(&app, p, &extensions)?;
    if p.sealed.is_some() {
        return Err(unavailable());
    }
    Ok(Json(
        json!({"id":input.id,"origin":p.origin,"public_key":p.key,"revision":p.revision,"vault_salt":p.salt}),
    ))
}
async fn approve(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Approve>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    if !input.sealed.public_key.valid()
        || !decoded(&input.sealed.iv, 12, 12)
        || !decoded(&input.sealed.ciphertext, 16, 8192)
    {
        return Err(unavailable());
    }
    let mut extensions = app.extensions.lock().map_err(internal)?;
    let p = extensions.unlocks.get(&input.id).ok_or_else(unavailable)?;
    live(&app, p, &extensions)?;
    if p.sealed.is_some() {
        return Err(unavailable());
    }
    extensions
        .unlocks
        .get_mut(&input.id)
        .ok_or_else(unavailable)?
        .sealed = Some(input.sealed);
    Ok(Json(json!({"approved":true})))
}
async fn poll(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Id>,
) -> ApiResult<Json<Value>> {
    extension_access(&app, &headers)?;
    let mut extensions = app.extensions.lock().map_err(internal)?;
    let p = extensions.unlocks.get(&input.id).ok_or_else(unavailable)?;
    if headers["origin"].to_str().ok() != Some(p.origin.as_str())
        || headers["x-heavenkey-token"].to_str().ok() != Some(p.token.as_str())
    {
        return Err(unavailable());
    }
    live(&app, p, &extensions)?;
    if p.sealed.is_none() {
        return Ok(Json(json!({"pending":true})));
    }
    let p = extensions
        .unlocks
        .remove(&input.id)
        .ok_or_else(unavailable)?;
    Ok(Json(
        json!({"pending":false,"sealed":p.sealed,"revision":p.revision,"vault_salt":p.salt}),
    ))
}
async fn cancel(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Id>,
) -> ApiResult<Json<Value>> {
    extension_access(&app, &headers)?;
    let mut extensions = app.extensions.lock().map_err(internal)?;
    if let Some(p) = extensions.unlocks.get(&input.id) {
        if headers["origin"].to_str().ok() != Some(p.origin.as_str()) {
            return Err(unavailable());
        }
        extensions.unlocks.remove(&input.id);
    }
    Ok(Json(json!({"cancelled":true})))
}
pub(super) fn routes() -> Router<VaultApp> {
    Router::new()
        .route(
            "/api/password-vault/extension/unlock/start",
            axum::routing::post(start),
        )
        .route(
            "/api/password-vault/extension/unlock/describe",
            axum::routing::post(describe),
        )
        .route(
            "/api/password-vault/extension/unlock/approve",
            axum::routing::post(approve),
        )
        .route(
            "/api/password-vault/extension/unlock/poll",
            axum::routing::post(poll),
        )
        .route(
            "/api/password-vault/extension/unlock/cancel",
            axum::routing::post(cancel),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_cannot_survive_expiry_pairing_replacement_or_vault_change() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE password_manager(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,record TEXT NOT NULL)").unwrap();
        let salt = URL_SAFE_NO_PAD.encode([0u8; 16]);
        let record = json!({"version":1,"kdf":"PBKDF2-SHA256","iterations":600000,"salt":salt,"iv":URL_SAFE_NO_PAD.encode([0u8;12]),"ciphertext":URL_SAFE_NO_PAD.encode([0u8;16])});
        db.execute(
            "INSERT INTO password_manager VALUES(1,1,?1)",
            [record.to_string()],
        )
        .unwrap();
        let app = VaultApp {
            db: Arc::new(Mutex::new(db)),
            origin: "http://localhost:18240".into(),
            host: "localhost:18240".into(),
            token: "synthetic".into(),
            extensions: Arc::new(Mutex::new(Extensions::default())),
            access: Arc::new(access::Access::new(18240, None).unwrap()),
            broker: Arc::new(broker::Broker::new()),
            transfer: Arc::new(transfer::TransferBroker::new()),
        };
        let mut extensions = Extensions::default();
        extensions.grants.insert("paired".into(), "token".into());
        let mut pending = Pending {
            origin: "paired".into(),
            token: "token".into(),
            key: PublicKey {
                x: random_secret(),
                y: random_secret(),
            },
            revision: 1,
            salt,
            expires: Instant::now() + TTL,
            sealed: None,
        };
        assert!(live(&app, &pending, &extensions).is_ok());
        pending.expires = Instant::now() - Duration::from_secs(1);
        assert!(live(&app, &pending, &extensions).is_err());
        pending.expires = Instant::now() + TTL;
        extensions
            .grants
            .insert("paired".into(), "replacement".into());
        assert!(live(&app, &pending, &extensions).is_err());
        extensions.grants.insert("paired".into(), "token".into());
        app.db
            .lock()
            .unwrap()
            .execute("UPDATE password_manager SET revision=2", [])
            .unwrap();
        assert!(live(&app, &pending, &extensions).is_err());
    }
}
