use super::*;

const TTL: Duration = Duration::from_secs(120);
const MAX_CEREMONIES: usize = 64;

pub(super) struct Access {
    local: Webauthn,
    recipient: Webauthn,
    pub share_origin: String,
    pub share_host: String,
    pending: Mutex<HashMap<String, Ceremony>>,
}

struct Ceremony {
    expires: Instant,
    phase: Phase,
}
enum Phase {
    Enroll {
        state: PasskeyRegistration,
        label: String,
        revision: u64,
        salt: String,
    },
    EnrollProof {
        state: PasskeyAuthentication,
        key: Box<Passkey>,
        label: String,
        revision: u64,
        salt: String,
    },
    Unlock {
        state: PasskeyAuthentication,
        salt: String,
    },
    Claim {
        state: PasskeyRegistration,
        id: String,
        token: String,
    },
    Recipient {
        state: PasskeyAuthentication,
        key: Option<Box<Passkey>>,
        id: String,
        token: String,
    },
}

impl Access {
    pub fn new(port: u16, public: Option<&str>) -> Result<Self, Box<dyn std::error::Error>> {
        let share = hosting::Hosting::new(port, public)?;
        let local_origin = Url::parse(&format!("http://localhost:{port}"))?;
        Ok(Self {
            local: WebauthnBuilder::new("localhost", &local_origin)?
                .rp_name("HeavenKey vault")
                .timeout(TTL)
                .build()?,
            recipient: WebauthnBuilder::new(&share.rp_id, &Url::parse(&share.origin)?)?
                .rp_name("HeavenKey shared copy")
                .timeout(TTL)
                .build()?,
            share_origin: share.origin,
            share_host: share.host,
            pending: Mutex::new(HashMap::new()),
        })
    }
    fn insert(&self, phase: Phase) -> ApiResult<String> {
        let mut pending = self.pending.lock().map_err(internal)?;
        pending.retain(|_, c| c.expires > Instant::now());
        if pending.len() >= MAX_CEREMONIES {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "ceremony_limit"));
        }
        let id = random_secret();
        pending.insert(
            id.clone(),
            Ceremony {
                expires: Instant::now() + TTL,
                phase,
            },
        );
        Ok(id)
    }
    fn take(&self, id: &str) -> ApiResult<Ceremony> {
        let c = self
            .pending
            .lock()
            .map_err(internal)?
            .remove(id)
            .ok_or_else(|| forbidden("ceremony_invalid"))?;
        if c.expires <= Instant::now() {
            return Err(forbidden("ceremony_expired"));
        }
        Ok(c)
    }
    pub fn invalidate(&self) -> ApiResult<()> {
        self.pending.lock().map_err(internal)?.clear();
        Ok(())
    }
}

pub(super) fn schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS password_passkeys(id TEXT PRIMARY KEY,label TEXT NOT NULL,vault_salt TEXT NOT NULL,passkey TEXT NOT NULL,wrap TEXT NOT NULL,counter INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS password_shares(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,kind TEXT NOT NULL,token_hash TEXT NOT NULL,nonce TEXT NOT NULL,ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,passkey TEXT,counter INTEGER NOT NULL DEFAULT 0);")
}
fn invalid() -> ApiError {
    ApiError(StatusCode::UNPROCESSABLE_ENTITY, "invalid_access_request")
}
fn conflict() -> ApiError {
    ApiError(StatusCode::CONFLICT, "password_vault_changed")
}
fn ceremony_live(expires: Instant) -> ApiResult<()> {
    if expires <= Instant::now() {
        return Err(forbidden("ceremony_expired"));
    }
    Ok(())
}
fn checked_vault(db: &Connection, expected: u64, salt: &str) -> ApiResult<Value> {
    let v = current(db)?;
    if expected == 0
        || v["revision"].as_u64() != Some(expected)
        || v["record"]["salt"].as_str() != Some(salt)
    {
        return Err(conflict());
    }
    Ok(v)
}
fn vault_salt(db: &Connection) -> ApiResult<String> {
    current(db)?["record"]["salt"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(conflict)
}
fn key_json(key: &Passkey) -> ApiResult<String> {
    serde_json::to_string(key).map_err(internal)
}
fn key_parse(key: &str) -> ApiResult<Passkey> {
    serde_json::from_str(key).map_err(internal)
}
fn verify(
    wa: &Webauthn,
    credential: &PublicKeyCredential,
    state: &PasskeyAuthentication,
    key: &mut Passkey,
    counter: u32,
) -> ApiResult<u32> {
    let result = wa
        .finish_passkey_authentication(credential, state)
        .map_err(|_| forbidden("authentication_invalid"))?;
    if !result.user_verified()
        || ((result.counter() > 0 || counter > 0) && result.counter() <= counter)
        || key.update_credential(&result).is_none()
    {
        return Err(forbidden("authentication_invalid"));
    }
    Ok(result.counter())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Wrap {
    version: u8,
    prf_salt: String,
    nonce: String,
    ciphertext: String,
}
impl Wrap {
    fn valid(&self) -> bool {
        self.version == 1
            && decoded(&self.prf_salt, 32, 32)
            && decoded(&self.nonce, 12, 12)
            && decoded(&self.ciphertext, 16, 4112)
    }
}

async fn list(State(app): State<VaultApp>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let db = app.db.lock().map_err(internal)?;
    let salt = current(&db)?["record"]["salt"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let mut stmt = db
        .prepare("SELECT id,label,wrap FROM password_passkeys WHERE vault_salt=?1 ORDER BY rowid")
        .map_err(internal)?;
    let rows = stmt
        .query_map([&salt], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(internal)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, label, wrap) = row.map_err(internal)?;
        let wrap: Wrap = serde_json::from_str(&wrap).map_err(internal)?;
        out.push(json!({"id":id,"label":label,"prf_salt":wrap.prf_salt,"vault_salt":salt}));
    }
    Ok(Json(json!({"credentials":out,"supported":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enroll {
    label: String,
    expected_revision: u64,
    vault_salt: String,
}
async fn enroll_start(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Enroll>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let label = input.label.trim().to_owned();
    if label.is_empty() || label.chars().count() > 48 {
        return Err(invalid());
    }
    let db = app.db.lock().map_err(internal)?;
    checked_vault(&db, input.expected_revision, &input.vault_salt)?;
    let count: i64 = db
        .query_row("SELECT count(*) FROM password_passkeys", [], |r| r.get(0))
        .map_err(internal)?;
    if count >= 8 {
        return Err(ApiError(StatusCode::CONFLICT, "passkey_limit"));
    }
    let mut stmt = db
        .prepare("SELECT passkey FROM password_passkeys")
        .map_err(internal)?;
    let keys = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    let excluded = keys
        .iter()
        .map(|v| key_parse(v).map(|k| k.cred_id().clone()))
        .collect::<ApiResult<Vec<_>>>()?;
    let (options, state) = app
        .access
        .local
        .start_passkey_registration(Uuid::new_v4(), "local-vault", &label, Some(excluded))
        .map_err(internal)?;
    let request_id = app.access.insert(Phase::Enroll {
        state,
        label,
        revision: input.expected_revision,
        salt: input.vault_salt,
    })?;
    Ok(Json(json!({"request_id":request_id,"options":options})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    request_id: String,
    credential: RegisterPublicKeyCredential,
}
async fn enroll_verify(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Registration>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let ceremony = app.access.take(&input.request_id)?;
    let expires = ceremony.expires;
    let Phase::Enroll {
        state,
        label,
        revision,
        salt,
    } = ceremony.phase
    else {
        return Err(forbidden("ceremony_invalid"));
    };
    let db = app.db.lock().map_err(internal)?;
    checked_vault(&db, revision, &salt)?;
    let key = app
        .access
        .local
        .finish_passkey_registration(&input.credential, &state)
        .map_err(|_| forbidden("registration_invalid"))?;
    ceremony_live(expires)?;
    let id = credential_id(&key);
    let (options, state) = app
        .access
        .local
        .start_passkey_authentication(std::slice::from_ref(&key))
        .map_err(internal)?;
    let request_id = app.access.insert(Phase::EnrollProof {
        state,
        key: Box::new(key),
        label,
        revision,
        salt,
    })?;
    Ok(Json(
        json!({"request_id":request_id,"options":options,"credential_id":id}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollmentFinish {
    request_id: String,
    credential: PublicKeyCredential,
    wrap: Wrap,
}
async fn enroll_finish(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<EnrollmentFinish>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let ceremony = app.access.take(&input.request_id)?;
    let expires = ceremony.expires;
    let Phase::EnrollProof {
        state,
        mut key,
        label,
        revision,
        salt,
    } = ceremony.phase
    else {
        return Err(forbidden("ceremony_invalid"));
    };
    if !input.wrap.valid() {
        return Err(invalid());
    }
    let counter = verify(&app.access.local, &input.credential, &state, &mut key, 0)?;
    ceremony_live(expires)?;
    let id = credential_id(&key);
    let mut db = app.db.lock().map_err(internal)?;
    let tx = db.transaction().map_err(internal)?;
    checked_vault(&tx, revision, &salt)?;
    let count: i64 = tx
        .query_row("SELECT count(*) FROM password_passkeys", [], |r| r.get(0))
        .map_err(internal)?;
    if count >= 8 {
        return Err(ApiError(StatusCode::CONFLICT, "passkey_limit"));
    }
    tx.execute("INSERT INTO password_passkeys(id,label,vault_salt,passkey,wrap,counter) VALUES(?1,?2,?3,?4,?5,?6)",params![id,label,salt,key_json(&key)?,serde_json::to_string(&input.wrap).map_err(internal)?,counter]).map_err(internal)?;
    ceremony_live(expires)?;
    tx.commit().map_err(internal)?;
    Ok(Json(json!({"id":id,"label":label})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
async fn auth_start(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(_): Json<Empty>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let db = app.db.lock().map_err(internal)?;
    let salt = vault_salt(&db)?;
    let mut stmt = db
        .prepare("SELECT id,passkey,wrap FROM password_passkeys WHERE vault_salt=?1")
        .map_err(internal)?;
    let rows = stmt
        .query_map([&salt], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(internal)?;
    let mut keys = Vec::new();
    let mut credentials = Vec::new();
    for row in rows {
        let (id, key, wrap) = row.map_err(internal)?;
        keys.push(key_parse(&key)?);
        let wrap: Wrap = serde_json::from_str(&wrap).map_err(internal)?;
        credentials.push(json!({"id":id,"prf_salt":wrap.prf_salt,"vault_salt":salt}));
    }
    if keys.is_empty() {
        return Err(forbidden("passkey_unavailable"));
    }
    let (options, state) = app
        .access
        .local
        .start_passkey_authentication(&keys)
        .map_err(internal)?;
    let request_id = app.access.insert(Phase::Unlock { state, salt })?;
    Ok(Json(
        json!({"request_id":request_id,"options":options,"credentials":credentials}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assertion {
    request_id: String,
    credential: PublicKeyCredential,
}
async fn auth_finish(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<Assertion>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let ceremony = app.access.take(&input.request_id)?;
    let expires = ceremony.expires;
    let Phase::Unlock { state, salt } = ceremony.phase else {
        return Err(forbidden("ceremony_invalid"));
    };
    let mut db = app.db.lock().map_err(internal)?;
    let tx = db.transaction().map_err(internal)?;
    if vault_salt(&tx)? != salt {
        return Err(conflict());
    }
    let id = URL_SAFE_NO_PAD.encode(input.credential.raw_id.as_ref());
    let (key, wrap, counter): (String, String, u32) = tx
        .query_row(
            "SELECT passkey,wrap,counter FROM password_passkeys WHERE id=?1 AND vault_salt=?2",
            params![id, salt],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(|| forbidden("credential_removed"))?;
    let mut key = key_parse(&key)?;
    let counter = verify(
        &app.access.local,
        &input.credential,
        &state,
        &mut key,
        counter,
    )?;
    tx.execute(
        "UPDATE password_passkeys SET passkey=?1,counter=?2 WHERE id=?3",
        params![key_json(&key)?, counter, id],
    )
    .map_err(internal)?;
    let v = current(&tx)?;
    let wrap: Wrap = serde_json::from_str(&wrap).map_err(internal)?;
    ceremony_live(expires)?;
    tx.commit().map_err(internal)?;
    Ok(Json(
        json!({"credential_id":id,"wrap":wrap,"vault_salt":salt,"revision":v["revision"],"record":v["record"]}),
    ))
}
async fn remove(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    app.db
        .lock()
        .map_err(internal)?
        .execute("DELETE FROM password_passkeys WHERE id=?1", [id])
        .map_err(internal)?;
    Ok(Json(json!({"removed":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewShare {
    id: String,
    source_id: String,
    kind: String,
    ttl_seconds: u64,
    nonce: String,
    ciphertext: String,
}
fn token_hash(token: &str) -> ApiResult<String> {
    if !decoded(token, 32, 32) {
        return Err(forbidden("share_unavailable"));
    }
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes())))
}
async fn create_share(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<NewShare>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    if Uuid::parse_str(&input.id).is_err()
        || input.source_id.is_empty()
        || input.source_id.chars().count() > 100
        || !matches!(input.kind.as_str(), "login" | "profile")
        || !(1..=604800).contains(&input.ttl_seconds)
        || !decoded(&input.nonce, 12, 12)
        || !decoded(&input.ciphertext, 16, 32784)
    {
        return Err(invalid());
    }
    let token = random_secret();
    let created = now() as i64;
    let expires = created + input.ttl_seconds as i64;
    let mut db = app.db.lock().map_err(internal)?;
    let tx = db.transaction().map_err(internal)?;
    vault_salt(&tx)?;
    let count: i64 = tx
        .query_row(
            "SELECT count(*) FROM password_shares WHERE revoked=0 AND expires_at>?1",
            [created],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if count >= 128 {
        return Err(ApiError(StatusCode::CONFLICT, "share_limit"));
    }
    tx.execute("DELETE FROM password_shares WHERE id IN (SELECT id FROM password_shares WHERE revoked=1 OR expires_at<=?1 ORDER BY created_at,id LIMIT MAX(0,(SELECT count(*) FROM password_shares)-511))",[created]).map_err(internal)?;
    let count: i64 = tx
        .query_row("SELECT count(*) FROM password_shares", [], |r| r.get(0))
        .map_err(internal)?;
    if count >= 512 {
        return Err(ApiError(StatusCode::CONFLICT, "share_storage_limit"));
    }
    tx.execute("INSERT INTO password_shares(id,source_id,kind,token_hash,nonce,ciphertext,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![input.id,input.source_id,input.kind,token_hash(&token)?,input.nonce,input.ciphertext,created,expires]).map_err(internal)?;
    tx.commit().map_err(internal)?;
    Ok(Json(
        json!({"id":input.id,"access_token":token,"created_at":created,"expires_at":expires,"share_origin":app.access.share_origin}),
    ))
}
async fn shares(State(app): State<VaultApp>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    let db = app.db.lock().map_err(internal)?;
    let mut stmt=db.prepare("SELECT id,source_id,kind,created_at,expires_at,revoked,passkey IS NOT NULL FROM password_shares ORDER BY created_at DESC,id").map_err(internal)?;
    let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"source_id":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"created_at":r.get::<_,i64>(3)?,"expires_at":r.get::<_,i64>(4)?,"revoked":r.get::<_,bool>(5)?,"claimed":r.get::<_,bool>(6)?}))).map_err(internal)?.collect::<Result<Vec<_>,_>>().map_err(internal)?;
    Ok(Json(json!({"shares":rows})))
}
async fn revoke(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    access(&app, &headers, true)?;
    app.db
        .lock()
        .map_err(internal)?
        .execute("UPDATE password_shares SET revoked=1 WHERE id=?1", [id])
        .map_err(internal)?;
    Ok(Json(json!({"revoked":true})))
}
fn recipient_access(app: &VaultApp, headers: &HeaderMap) -> ApiResult<()> {
    if headers.get("host").and_then(|v| v.to_str().ok()) != Some(&app.access.share_host)
        || headers.get("origin").and_then(|v| v.to_str().ok()) != Some(&app.access.share_origin)
    {
        return Err(forbidden("share_origin_denied"));
    }
    Ok(())
}
struct Shared {
    passkey: Option<String>,
    counter: u32,
    nonce: String,
    ciphertext: String,
    created: i64,
    expires: i64,
}
fn shared(db: &Connection, id: &str, token: &str) -> ApiResult<Shared> {
    let hash = token_hash(token)?;
    db.query_row("SELECT passkey,counter,nonce,ciphertext,created_at,expires_at FROM password_shares WHERE id=?1 AND token_hash=?2 AND revoked=0 AND expires_at>?3",params![id,hash,now() as i64],|r|Ok(Shared{passkey:r.get(0)?,counter:r.get(1)?,nonce:r.get(2)?,ciphertext:r.get(3)?,created:r.get(4)?,expires:r.get(5)?})).optional().map_err(internal)?.ok_or_else(||forbidden("share_unavailable"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecipientStart {
    id: String,
    access_token: String,
}
async fn recipient_start(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<RecipientStart>,
) -> ApiResult<Json<Value>> {
    recipient_access(&app, &headers)?;
    let db = app.db.lock().map_err(internal)?;
    let share = shared(&db, &input.id, &input.access_token)?;
    let (options, phase, mode) = if let Some(key) = share.passkey {
        let key = key_parse(&key)?;
        let (options, state) = app
            .access
            .recipient
            .start_passkey_authentication(&[key])
            .map_err(internal)?;
        (
            serde_json::to_value(options).map_err(internal)?,
            Phase::Recipient {
                state,
                key: None,
                id: input.id,
                token: token_hash(&input.access_token)?,
            },
            "authenticate",
        )
    } else {
        let (options, state) = app
            .access
            .recipient
            .start_passkey_registration(
                Uuid::new_v4(),
                "share-recipient",
                "Shared copy recipient",
                None,
            )
            .map_err(internal)?;
        (
            serde_json::to_value(options).map_err(internal)?,
            Phase::Claim {
                state,
                id: input.id,
                token: token_hash(&input.access_token)?,
            },
            "register",
        )
    };
    let request_id = app.access.insert(phase)?;
    Ok(Json(
        json!({"request_id":request_id,"mode":mode,"options":options}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecipientVerify {
    id: String,
    access_token: String,
    request_id: String,
    credential: RegisterPublicKeyCredential,
}
async fn recipient_verify(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<RecipientVerify>,
) -> ApiResult<Json<Value>> {
    recipient_access(&app, &headers)?;
    let ceremony = app.access.take(&input.request_id)?;
    let expires = ceremony.expires;
    let Phase::Claim { state, id, token } = ceremony.phase else {
        return Err(forbidden("ceremony_invalid"));
    };
    if id != input.id || token != token_hash(&input.access_token)? {
        return Err(forbidden("ceremony_invalid"));
    }
    let db = app.db.lock().map_err(internal)?;
    if shared(&db, &id, &input.access_token)?.passkey.is_some() {
        return Err(forbidden("share_claimed"));
    }
    let key = app
        .access
        .recipient
        .finish_passkey_registration(&input.credential, &state)
        .map_err(|_| forbidden("registration_invalid"))?;
    ceremony_live(expires)?;
    let (options, state) = app
        .access
        .recipient
        .start_passkey_authentication(std::slice::from_ref(&key))
        .map_err(internal)?;
    let request_id = app.access.insert(Phase::Recipient {
        state,
        key: Some(Box::new(key)),
        id,
        token,
    })?;
    Ok(Json(
        json!({"request_id":request_id,"mode":"authenticate","options":options}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecipientFinish {
    id: String,
    access_token: String,
    request_id: String,
    credential: PublicKeyCredential,
}
async fn recipient_finish(
    State(app): State<VaultApp>,
    headers: HeaderMap,
    Json(input): Json<RecipientFinish>,
) -> ApiResult<Json<Value>> {
    recipient_access(&app, &headers)?;
    let ceremony = app.access.take(&input.request_id)?;
    let expires = ceremony.expires;
    let Phase::Recipient {
        state,
        key,
        id,
        token,
    } = ceremony.phase
    else {
        return Err(forbidden("ceremony_invalid"));
    };
    if id != input.id || token != token_hash(&input.access_token)? {
        return Err(forbidden("ceremony_invalid"));
    }
    let mut db = app.db.lock().map_err(internal)?;
    let tx = db.transaction().map_err(internal)?;
    let share = shared(&tx, &id, &input.access_token)?;
    ceremony_live(expires)?;
    let claiming = key.is_some();
    if claiming && share.passkey.is_some() {
        return Err(forbidden("share_claimed"));
    }
    let mut key = match key {
        Some(k) => k,
        None => Box::new(key_parse(
            share
                .passkey
                .as_deref()
                .ok_or_else(|| forbidden("share_unavailable"))?,
        )?),
    };
    let counter = verify(
        &app.access.recipient,
        &input.credential,
        &state,
        &mut key,
        share.counter,
    )?;
    let share = shared(&tx, &id, &input.access_token)?;
    let changed=tx.execute("UPDATE password_shares SET passkey=?1,counter=?2 WHERE id=?3 AND revoked=0 AND expires_at>?4 AND (passkey IS NULL)=?5",params![key_json(&key)?,counter,id,now() as i64,claiming]).map_err(internal)?;
    if changed != 1 {
        return Err(forbidden("share_unavailable"));
    }
    ceremony_live(expires)?;
    tx.commit().map_err(internal)?;
    Ok(Json(
        json!({"id":id,"nonce":share.nonce,"ciphertext":share.ciphertext,"created_at":share.created,"expires_at":share.expires}),
    ))
}

pub(super) fn routes() -> Router<VaultApp> {
    Router::new()
        .route("/api/password-passkeys", get(list))
        .route("/api/password-passkeys/enroll/start", post(enroll_start))
        .route("/api/password-passkeys/enroll/verify", post(enroll_verify))
        .route("/api/password-passkeys/enroll/finish", post(enroll_finish))
        .route("/api/password-passkeys/auth/start", post(auth_start))
        .route("/api/password-passkeys/auth/finish", post(auth_finish))
        .route("/api/password-passkeys/{id}", axum::routing::delete(remove))
        .route("/api/password-shares", get(shares).post(create_share))
        .route("/api/password-shares/{id}", axum::routing::delete(revoke))
        .route(
            "/api/password-shares/recipient/start",
            post(recipient_start),
        )
        .route(
            "/api/password-shares/recipient/verify",
            post(recipient_verify),
        )
        .route(
            "/api/password-shares/recipient/finish",
            post(recipient_finish),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app() -> VaultApp {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE password_manager(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,record TEXT NOT NULL)").unwrap();
        schema(&db).unwrap();
        let record = json!({"version":1,"kdf":"PBKDF2-SHA256","iterations":600000,"salt":URL_SAFE_NO_PAD.encode([0u8;16]),"iv":URL_SAFE_NO_PAD.encode([0u8;12]),"ciphertext":URL_SAFE_NO_PAD.encode([0u8;16])});
        db.execute(
            "INSERT INTO password_manager VALUES(1,1,?1)",
            [record.to_string()],
        )
        .unwrap();
        VaultApp {
            db: Arc::new(Mutex::new(db)),
            origin: "http://localhost:18240".into(),
            host: "localhost:18240".into(),
            token: "synthetic-process-token".into(),
            extensions: Arc::new(Mutex::new(Extensions::default())),
            access: Arc::new(Access::new(18240, None).unwrap()),
        }
    }
    fn headers(app: &VaultApp) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("host", app.host.parse().unwrap());
        h.insert("origin", app.origin.parse().unwrap());
        h.insert("x-heavenkey-client", "password-manager".parse().unwrap());
        h.insert("x-heavenkey-token", app.token.parse().unwrap());
        h
    }
    fn new_share(ttl: u64) -> NewShare {
        NewShare {
            id: Uuid::new_v4().to_string(),
            source_id: "synthetic-entry".into(),
            kind: "login".into(),
            ttl_seconds: ttl,
            nonce: URL_SAFE_NO_PAD.encode([0u8; 12]),
            ciphertext: URL_SAFE_NO_PAD.encode([0u8; 32]),
        }
    }
    #[tokio::test]
    async fn owner_share_crud_exposes_only_cipher_and_metadata() {
        let app = app();
        let h = headers(&app);
        let Json(created) = create_share(State(app.clone()), h.clone(), Json(new_share(60)))
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap();
        let token = created["access_token"].as_str().unwrap();
        {
            let db = app.db.lock().unwrap();
            let stored: String = db
                .query_row("SELECT token_hash FROM password_shares", [], |r| r.get(0))
                .unwrap();
            assert_ne!(stored, token);
            assert!(shared(&db, id, &random_secret()).is_err());
            assert!(shared(&db, id, token).is_ok());
        }
        let Json(rows) = shares(State(app.clone()), h.clone()).await.unwrap();
        assert!(rows["shares"][0].get("ciphertext").is_none());
        assert!(rows["shares"][0].get("token_hash").is_none());
        assert_eq!(rows["shares"][0]["claimed"], false);
        let Json(start) = recipient_start(
            State(app.clone()),
            h.clone(),
            Json(RecipientStart {
                id: id.into(),
                access_token: token.into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(start["mode"], "register");
        assert!(start.get("ciphertext").is_none());
        assert_eq!(
            start["options"]["publicKey"]["authenticatorSelection"]["userVerification"],
            "required"
        );
        let _ = revoke(State(app.clone()), h, axum::extract::Path(id.into()))
            .await
            .unwrap();
        assert!(shared(&app.db.lock().unwrap(), id, token).is_err());
    }
    #[tokio::test]
    async fn rekey_invalidates_atomically_ordinary_save_retains_and_stale_cas_rolls_back() {
        let app = app();
        let h = headers(&app);
        let _ = create_share(State(app.clone()), h.clone(), Json(new_share(60)))
            .await
            .unwrap();
        {
            let db = app.db.lock().unwrap();
            db.execute(
                "INSERT INTO password_passkeys VALUES('synthetic','test',?1,'{}','{}',0)",
                [URL_SAFE_NO_PAD.encode([0u8; 16])],
            )
            .unwrap();
        }
        let record: Envelope =
            serde_json::from_value(current(&app.db.lock().unwrap()).unwrap()["record"].clone())
                .unwrap();
        let _ = save(
            State(app.clone()),
            h.clone(),
            Json(Save {
                expected_revision: 1,
                record,
            }),
        )
        .await
        .unwrap();
        {
            let db = app.db.lock().unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM password_passkeys", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert!(
                !db.query_row("SELECT revoked FROM password_shares", [], |r| r
                    .get::<_, bool>(0))
                    .unwrap()
            );
        }
        let mut record: Envelope =
            serde_json::from_value(current(&app.db.lock().unwrap()).unwrap()["record"].clone())
                .unwrap();
        record.salt = URL_SAFE_NO_PAD.encode([1u8; 16]);
        let stale: Envelope =
            serde_json::from_value(serde_json::to_value(&record).unwrap()).unwrap();
        assert!(
            save(
                State(app.clone()),
                h.clone(),
                Json(Save {
                    expected_revision: 1,
                    record: stale
                })
            )
            .await
            .is_err()
        );
        assert_eq!(
            app.db
                .lock()
                .unwrap()
                .query_row("SELECT count(*) FROM password_passkeys", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let _ = save(
            State(app.clone()),
            h,
            Json(Save {
                expected_revision: 2,
                record,
            }),
        )
        .await
        .unwrap();
        let db = app.db.lock().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM password_passkeys", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(
            db.query_row("SELECT revoked FROM password_shares", [], |r| r
                .get::<_, bool>(0))
                .unwrap()
        );
    }
    #[test]
    fn ceremonies_are_bounded_expire_and_are_consumed_once() {
        let app = app();
        let a = &app.access;
        fn phase(a: &Access) -> Phase {
            let (_, state) = a
                .local
                .start_passkey_registration(Uuid::new_v4(), "synthetic", "synthetic", None)
                .unwrap();
            Phase::Enroll {
                state,
                label: "test".into(),
                revision: 1,
                salt: "salt".into(),
            }
        }
        let first = a.insert(phase(a)).unwrap();
        for _ in 1..64 {
            a.insert(phase(a)).unwrap();
        }
        assert!(a.insert(phase(a)).is_err());
        assert!(a.take(&first).is_ok());
        assert!(a.take(&first).is_err());
        let expired = a.insert(phase(a)).unwrap();
        a.pending.lock().unwrap().get_mut(&expired).unwrap().expires = Instant::now();
        assert!(a.take(&expired).is_err());
        a.invalidate().unwrap();
        assert!(a.pending.lock().unwrap().is_empty());
    }
    #[test]
    fn wrap_and_recipient_origin_are_strict() {
        let app = app();
        let mut wrap = Wrap {
            version: 1,
            prf_salt: random_secret(),
            nonce: URL_SAFE_NO_PAD.encode([0u8; 12]),
            ciphertext: URL_SAFE_NO_PAD.encode([0u8; 4112]),
        };
        assert!(wrap.valid());
        wrap.ciphertext = URL_SAFE_NO_PAD.encode([0u8; 4113]);
        assert!(!wrap.valid());
        wrap.ciphertext = URL_SAFE_NO_PAD.encode([0u8; 16]);
        wrap.prf_salt.push('=');
        assert!(!wrap.valid());
        let mut h = headers(&app);
        assert!(recipient_access(&app, &h).is_ok());
        h.insert("origin", "https://evil.test".parse().unwrap());
        assert!(recipient_access(&app, &h).is_err());
        assert!(Access::new(18240, Some("http://public.example")).is_err());
        assert!(Access::new(18240, Some("https://public.example/path")).is_err());
    }
    #[test]
    fn public_host_serves_only_exact_recipient_paths() {
        let mut app = app();
        app.access = Arc::new(Access::new(18240, Some("https://share.example:8443")).unwrap());
        for path in [
            "/share/",
            "/share.js",
            "/passwords.css",
            "/heavenkey-cover.png",
            "/api/password-shares/recipient/start",
            "/api/password-shares/recipient/verify",
            "/api/password-shares/recipient/finish",
        ] {
            assert!(host_allowed(&app, Some("share.example:8443"), path));
        }
        for path in [
            "/",
            "/passwords/",
            "/passwords.js",
            "/api/password-vault/config",
            "/api/password-vault",
            "/api/password-passkeys",
            "/api/password-shares",
            "/api/password-shares/recipient/start/",
            "/share",
            "/health",
        ] {
            assert!(!host_allowed(&app, Some("share.example:8443"), path));
            assert!(host_allowed(&app, Some("localhost:18240"), path));
        }
        assert!(!host_allowed(&app, Some("evil.example"), "/share/"));
        let mut h = headers(&app);
        assert!(recipient_access(&app, &h).is_err());
        h.insert("host", "share.example:8443".parse().unwrap());
        h.insert("origin", "https://share.example:8443".parse().unwrap());
        assert!(recipient_access(&app, &h).is_ok());
        h.insert("origin", "https://share.example".parse().unwrap());
        assert!(recipient_access(&app, &h).is_err());
    }
    #[tokio::test]
    async fn owner_extension_and_wrong_token_are_denied_and_input_bounds_hold() {
        let app = app();
        let mut h = headers(&app);
        h.insert("x-heavenkey-client", "password-extension".parse().unwrap());
        assert!(list(State(app.clone()), h.clone()).await.is_err());
        assert!(
            create_share(State(app.clone()), h, Json(new_share(60)))
                .await
                .is_err()
        );
        let mut h = headers(&app);
        h.insert("x-heavenkey-token", "wrong".parse().unwrap());
        assert!(list(State(app.clone()), h).await.is_err());
        for ttl in [0, 604801] {
            assert!(
                create_share(State(app.clone()), headers(&app), Json(new_share(ttl)))
                    .await
                    .is_err()
            );
        }
        let mut input = new_share(60);
        input.ciphertext = URL_SAFE_NO_PAD.encode([0u8; 32785]);
        assert!(
            create_share(State(app.clone()), headers(&app), Json(input))
                .await
                .is_err()
        );
        let salt = URL_SAFE_NO_PAD.encode([0u8; 16]);
        assert!(
            enroll_start(
                State(app.clone()),
                headers(&app),
                Json(Enroll {
                    label: "test".into(),
                    expected_revision: 0,
                    vault_salt: salt
                })
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn expired_shares_and_storage_capacity_fail_closed() {
        let app = app();
        let Json(created) = create_share(State(app.clone()), headers(&app), Json(new_share(1)))
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap();
        let token = created["access_token"].as_str().unwrap();
        {
            let db = app.db.lock().unwrap();
            db.execute("UPDATE password_shares SET expires_at=?1", [now() as i64])
                .unwrap();
            assert!(shared(&db, id, token).is_err());
        }
        for _ in 0..128 {
            let _ = create_share(State(app.clone()), headers(&app), Json(new_share(60)))
                .await
                .unwrap();
        }
        assert_eq!(
            create_share(State(app.clone()), headers(&app), Json(new_share(60)))
                .await
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        let count: i64 = app
            .db
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM password_shares", [], |r| r.get(0))
            .unwrap();
        assert!(count <= 512);
    }
}
