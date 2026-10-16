//! Local pilot features. All authorization is checked again at execution time.
use super::*;
use ed25519_dalek::{Signature, Signer, VerifyingKey};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Platform {
    recoveries: HashMap<String, RecoveryRegistration>,
    invocations: HashMap<String, AgentChallenge>,
    recovery_attempts: HashMap<String, (u8, Instant)>,
}
struct RecoveryRegistration {
    user_id: String,
    digest: String,
    label: String,
    state: PasskeyRegistration,
    expires: Instant,
}
struct AgentChallenge {
    invocation: AgentInvocation,
    message: Vec<u8>,
    expires: Instant,
}
impl Platform {
    pub fn prune(&mut self) {
        let instant = Instant::now();
        self.recoveries.retain(|_, x| x.expires > instant);
        self.invocations.retain(|_, x| x.expires > instant);
        self.recovery_attempts.retain(|_, x| x.1 > instant);
    }
}

pub(super) fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS platform_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS recovery_codes(account_id TEXT PRIMARY KEY REFERENCES users(id),digest TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES users(id),credential_id TEXT NOT NULL REFERENCES credentials(id),token TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,expires_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS agent_tasks_account ON agent_tasks(account_id);
         CREATE TABLE IF NOT EXISTS agent_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES agent_tasks(id),account_id TEXT NOT NULL REFERENCES users(id),created INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS crm_contacts(account_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,name TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(account_id,id));
         CREATE TABLE IF NOT EXISTS vaults(account_id TEXT PRIMARY KEY REFERENCES users(id),revision INTEGER NOT NULL,record TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES users(id),event TEXT NOT NULL,reference TEXT NOT NULL,created INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS audit_account ON audit_events(account_id,created);"
    )
}

pub(super) fn identity(origin: &str, rp_id: &str) -> Result<Url, Box<dyn std::error::Error>> {
    let parsed = Url::parse(origin)?;
    let host = parsed.domain().ok_or("origin requires a DNS hostname")?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || !(host == rp_id || host.ends_with(&format!(".{rp_id}")))
        || !(parsed.scheme() == "https"
            || parsed.scheme() == "http" && host == "localhost" && rp_id == "localhost")
        || rp_id.is_empty()
        || rp_id.contains(['/', ':', '@'])
    {
        return Err("invalid WebAuthn origin/RP ID; remote origins require HTTPS".into());
    }
    Ok(parsed)
}
pub(super) fn pin_identity(db: &Connection, rp_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let pinned: Option<String> = db
        .query_row(
            "SELECT value FROM platform_metadata WHERE key='rp_id'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match pinned {
        Some(pinned) if pinned != rp_id => return Err("RP ID differs from this data directory; provision new credentials in a separate directory".into()),
        Some(_) => {},
        None => {
            let users: i64 = db.query_row("SELECT count(*) FROM users", [], |r| r.get(0))?;
            if users > 0 && rp_id != "localhost" { return Err("existing localhost credentials cannot migrate to a different RP ID".into()); }
            db.execute("INSERT INTO platform_metadata(key,value) VALUES('rp_id',?1)", [rp_id])?;
        }
    }
    Ok(())
}
fn db_time(value: u64) -> ApiResult<i64> {
    i64::try_from(value).map_err(|_| forbidden("time_out_of_range"))
}
fn audit(db: &Connection, account: &str, event: &str, reference: &str) -> ApiResult<()> {
    db.execute(
        "INSERT INTO audit_events(id,account_id,event,reference,created) VALUES(?1,?2,?3,?4,?5)",
        params![
            Uuid::new_v4().to_string(),
            account,
            event,
            reference,
            db_time(now())?
        ],
    )
    .map_err(internal)?;
    Ok(())
}
fn invalidate_account(inner: &mut Inner, account: &str) {
    inner.sessions.retain(|_, s| s.user_id != account);
    inner.approvals.retain(|_, s| s.user_id != account);
    inner.enrollments.retain(|_, s| s.user_id != account);
    inner.authentications.retain(|_, s| s.user.id != account);
    inner
        .platform
        .recoveries
        .retain(|_, s| s.user_id != account);
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Approved {
    approval_id: Option<String>,
}

pub(super) async fn config(State(app): State<App>) -> ApiResult<Json<Value>> {
    let inner = app.inner.lock().map_err(internal)?;
    let rp_id: String = inner
        .db
        .query_row(
            "SELECT value FROM platform_metadata WHERE key='rp_id'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?
        .unwrap_or_else(|| "localhost".into());
    Ok(Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"origin":app.origin,"rp_id":rp_id,"issuer_public_key":URL_SAFE_NO_PAD.encode(inner.issuer.verifying_key().to_bytes()),"keystore":if std::env::var_os("HEAVENKEY_KEY_FILE").is_some(){"external-key-file"}else{"native-os-store"},"hardware_verified":false,"external_integration":"local-crm-sandbox","prf":"optional-client-side","session_seconds":300}),
    ))
}
pub(super) async fn session(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    let s = inner
        .sessions
        .get(session_token(&headers)?)
        .ok_or(forbidden("session_expired"))?;
    Ok(Json(
        json!({"account_id":user.id,"name":user.name,"owner":user.owner,"credential_id":s.credential_id,"expires_at":s.expires}),
    ))
}
pub(super) async fn logout(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.session_user(&headers)?;
    let token = session_token(&headers)?;
    inner.sessions.remove(token);
    inner.approvals.retain(|_, a| a.session_token != token);
    inner.enrollments.retain(|_, a| a.session_token != token);
    inner.authentications.retain(|_, a| {
        a.management
            .as_ref()
            .is_none_or(|m| m.session_token != token)
    });
    Ok(Json(json!({"logged_out":true})))
}
pub(super) async fn events(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    let mut stmt = inner.db.prepare("SELECT event,reference,created FROM audit_events WHERE account_id=?1 ORDER BY created DESC,rowid DESC LIMIT 100").map_err(internal)?;
    let rows = stmt.query_map([user.id], |r| Ok(json!({"event":r.get::<_,String>(0)?,"reference":r.get::<_,String>(1)?,"created":r.get::<_,i64>(2)?}))).map_err(internal)?;
    let rows: Vec<Value> = rows.collect::<Result<_, _>>().map_err(internal)?;
    Ok(Json(json!({"events":rows})))
}

pub(super) async fn recovery_status(
    State(app): State<App>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    let enabled: bool = inner
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM recovery_codes WHERE account_id=?1 AND used=0)",
            [&user.id],
            |r| r.get(0),
        )
        .map_err(internal)?;
    let count: i64 = inner
        .db
        .query_row(
            "SELECT count(*) FROM credentials WHERE user_id=?1 AND active=1",
            [&user.id],
            |r| r.get(0),
        )
        .map_err(internal)?;
    Ok(Json(
        json!({"enabled":enabled,"active_passkeys":count,"backup_passkey_recommended":count<2}),
    ))
}
pub(super) async fn recovery_rotate(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Approved>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let user = inner.session_user(&headers)?;
    inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &Management::RecoveryRotate,
    )?;
    let code = uac_recovery::generate();
    let digest = URL_SAFE_NO_PAD.encode(
        uac_recovery::digest(&user.id, &code)
            .ok_or_else(|| internal("recovery code generation"))?,
    );
    let tx = inner.db.transaction().map_err(internal)?;
    tx.execute("INSERT INTO recovery_codes(account_id,digest,used,created) VALUES(?1,?2,0,?3) ON CONFLICT(account_id) DO UPDATE SET digest=excluded.digest,used=0,created=excluded.created",params![user.id,digest,db_time(now())?]).map_err(internal)?;
    audit(&tx, &user.id, "recovery_rotated", "")?;
    tx.commit().map_err(internal)?;
    inner
        .platform
        .recoveries
        .retain(|_, r| r.user_id != user.id);
    Ok(Json(
        json!({"code":code,"display_once":true,"old_code_invalidated":true}),
    ))
}
pub(super) async fn recovery_disable(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Approved>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let user = inner.session_user(&headers)?;
    inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &Management::RecoveryDisable,
    )?;
    let tx = inner.db.transaction().map_err(internal)?;
    tx.execute("DELETE FROM recovery_codes WHERE account_id=?1", [&user.id])
        .map_err(internal)?;
    audit(&tx, &user.id, "recovery_disabled", "")?;
    tx.commit().map_err(internal)?;
    inner
        .platform
        .recoveries
        .retain(|_, r| r.user_id != user.id);
    Ok(Json(json!({"disabled":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecoveryStart {
    name: String,
    code: String,
    label: String,
}
pub(super) async fn recovery_start(
    State(app): State<App>,
    Json(input): Json<RecoveryStart>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    let label = credential_label(&input.label)?;
    if input.name.len() > 32 || input.code.len() > 96 {
        return Err(forbidden("recovery_denied"));
    }
    if inner.platform.recoveries.len() >= MAX_PENDING {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "ceremony_limit"));
    }
    let user = inner
        .user("name", &input.name)
        .map_err(|_| forbidden("recovery_denied"))?;
    let digest = uac_recovery::digest(&user.id, &input.code)
        .map(|digest| URL_SAFE_NO_PAD.encode(digest))
        .unwrap_or_default();
    let valid: bool = inner.db.query_row("SELECT EXISTS(SELECT 1 FROM recovery_codes WHERE account_id=?1 AND digest=?2 AND used=0)",params![user.id,digest],|r|r.get(0)).map_err(internal)?;
    if !valid {
        // Failed guesses must not lock the holder of a valid high-entropy code out.
        if !inner.platform.recovery_attempts.contains_key(&user.id)
            && inner.platform.recovery_attempts.len() >= MAX_PENDING
        {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "recovery_rate_limit",
            ));
        }
        let attempt = inner
            .platform
            .recovery_attempts
            .entry(user.id.clone())
            .or_insert((0, Instant::now() + Duration::from_secs(600)));
        if attempt.0 >= 10 {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "recovery_rate_limit",
            ));
        }
        attempt.0 += 1;
        return Err(forbidden("recovery_denied"));
    }
    let excluded = inner
        .active_credentials(&user.id)?
        .into_iter()
        .map(|c| c.passkey.cred_id().clone())
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
    inner.platform.recoveries.insert(
        request_id.clone(),
        RecoveryRegistration {
            user_id: user.id,
            digest,
            label,
            state,
            expires: Instant::now() + Duration::from_secs(CEREMONY_TTL),
        },
    );
    Ok(Json(json!({"request_id":request_id,"options":options})))
}
pub(super) async fn recovery_finish(
    State(app): State<App>,
    Json(input): Json<RegisterFinish>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    let pending = inner
        .platform
        .recoveries
        .remove(&input.request_id)
        .ok_or(forbidden("ceremony_missing"))?;
    let key = inner
        .webauthn
        .finish_passkey_registration(&input.credential, &pending.state)
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "registration_invalid"))?;
    let id = credential_id(&key);
    inner.check_credential_unique(&id)?;
    let tx = inner.db.transaction().map_err(internal)?;
    if tx
        .execute(
            "UPDATE recovery_codes SET used=1 WHERE account_id=?1 AND digest=?2 AND used=0",
            params![pending.user_id, pending.digest],
        )
        .map_err(internal)?
        != 1
    {
        return Err(forbidden("recovery_denied"));
    }
    tx.execute(
        "UPDATE credentials SET active=0 WHERE user_id=?1",
        [&pending.user_id],
    )
    .map_err(internal)?;
    tx.execute(
        "INSERT INTO credentials(id,user_id,passkey,label,created) VALUES(?1,?2,?3,?4,?5)",
        params![
            id,
            pending.user_id,
            serde_json::to_string(&key).map_err(internal)?,
            pending.label,
            db_time(now())?
        ],
    )
    .map_err(internal)?;
    tx.execute(
        "UPDATE agent_tasks SET revoked=1 WHERE account_id=?1",
        [&pending.user_id],
    )
    .map_err(internal)?;
    audit(&tx, &pending.user_id, "account_recovered", &id)?;
    tx.commit().map_err(internal)?;
    invalidate_account(&mut inner, &pending.user_id);
    inner.platform.recovery_attempts.remove(&pending.user_id);
    Ok(Json(
        json!({"recovered":true,"login_required":true,"all_old_passkeys_revoked":true,"agents_revoked":true,"vault_recovery_key_required":true}),
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AgentSpec {
    name: String,
    public_key: String,
    resource: String,
    actions: BTreeSet<Action>,
    ttl_seconds: u64,
    parent_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentGrant {
    profile: String,
    id: String,
    account_id: String,
    credential_id: String,
    spec: AgentSpec,
    not_before: u64,
    expires_at: u64,
}
fn agent_message(body: &AgentGrant) -> ApiResult<Vec<u8>> {
    let mut bytes = b"HEAVENKEY-AGENT-GRANT-v1\0".to_vec();
    bytes.extend(serde_json::to_vec(body).map_err(internal)?);
    Ok(bytes)
}
fn public_key(value: &str) -> ApiResult<VerifyingKey> {
    let bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| forbidden("invalid_agent_key"))?
        .try_into()
        .map_err(|_| forbidden("invalid_agent_key"))?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| forbidden("invalid_agent_key"))?;
    if key.is_weak() || URL_SAFE_NO_PAD.encode(bytes) != value {
        return Err(forbidden("invalid_agent_key"));
    }
    Ok(key)
}
fn agent_authority(inner: &Inner, user: &User, spec: &AgentSpec, expires_at: u64) -> ApiResult<()> {
    credential_label(&spec.name)?;
    public_key(&spec.public_key)?;
    if !(1..=3600).contains(&spec.ttl_seconds)
        || spec.actions.is_empty()
        || spec.actions.contains(&Action::Unlock)
    {
        return Err(forbidden("agent_scope_denied"));
    }
    match spec.resource.as_str() {
        "document" if spec.actions == BTreeSet::from([Action::Read]) => {}
        "crm.contacts" if user.owner && spec.parent_id.is_none() => {}
        _ => return Err(forbidden("agent_scope_denied")),
    }
    if let Some(parent) = &spec.parent_id {
        let chain = inner.delegation_chain(parent)?;
        inner.delegation_verify(user, &chain, RESOURCE, Action::Read)?;
        let leaf = chain.chain.last().ok_or(forbidden("delegation_denied"))?;
        if leaf.body.remaining_delegations == 0
            || expires_at > leaf.body.expires_at
            || spec.resource != "document"
        {
            return Err(forbidden("agent_scope_denied"));
        }
    } else if !user.owner {
        return Err(forbidden("agent_parent_required"));
    }
    Ok(())
}
pub(super) fn management_allowed(inner: &Inner, user: &User, op: &Management) -> ApiResult<()> {
    match op {
        Management::AgentCreate { spec } => agent_authority(
            inner,
            user,
            spec,
            now()
                .checked_add(spec.ttl_seconds)
                .ok_or(forbidden("agent_scope_denied"))?,
        ),
        Management::AgentRevoke { id } => {
            let owned: bool = inner
                .db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_tasks WHERE id=?1 AND account_id=?2)",
                    params![id, user.id],
                    |r| r.get(0),
                )
                .map_err(internal)?;
            if !owned {
                return Err(forbidden("agent_not_found"));
            }
            Ok(())
        }
        Management::RecoveryRotate
        | Management::RecoveryDisable
        | Management::VaultWrite { .. } => Ok(()),
        _ => Err(forbidden("management_changed")),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AgentCreate {
    spec: AgentSpec,
    approval_id: Option<String>,
}
pub(super) async fn agent_create(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<AgentCreate>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let user = inner.session_user(&headers)?;
    let credential = inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &Management::AgentCreate {
            spec: input.spec.clone(),
        },
    )?;
    let end = now()
        .checked_add(input.spec.ttl_seconds)
        .ok_or(forbidden("agent_scope_denied"))?;
    agent_authority(&inner, &user, &input.spec, end)?;
    let count: i64 = inner
        .db
        .query_row(
            "SELECT count(*) FROM agent_tasks WHERE account_id=?1 AND revoked=0 AND expires_at>?2",
            params![user.id, db_time(now())?],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if count >= 32 {
        return Err(forbidden("agent_limit"));
    }
    let id = Uuid::new_v4().to_string();
    let body = AgentGrant {
        profile: "heavenkey-agent-v1".into(),
        id: id.clone(),
        account_id: user.id.clone(),
        credential_id: credential.clone(),
        spec: input.spec,
        not_before: now(),
        expires_at: end,
    };
    let signature = inner
        .issuer
        .sign(&agent_message(&body)?)
        .to_bytes()
        .to_vec();
    let token = Signed { body, signature };
    let tx = inner.db.transaction().map_err(internal)?;
    tx.execute("INSERT INTO agent_tasks(id,account_id,credential_id,token,created,expires_at) VALUES(?1,?2,?3,?4,?5,?6)",params![id,user.id,credential,serde_json::to_string(&token).map_err(internal)?,db_time(now())?,db_time(end)?]).map_err(internal)?;
    audit(&tx, &user.id, "agent_created", &id)?;
    tx.commit().map_err(internal)?;
    Ok(Json(
        json!({"id":id,"grant":token,"proof_of_possession_required":true,"integration":"local-sandbox"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AgentRevoke {
    id: String,
    approval_id: Option<String>,
}
pub(super) async fn agent_revoke(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<AgentRevoke>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let user = inner.session_user(&headers)?;
    inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &Management::AgentRevoke {
            id: input.id.clone(),
        },
    )?;
    management_allowed(
        &inner,
        &user,
        &Management::AgentRevoke {
            id: input.id.clone(),
        },
    )?;
    let tx = inner.db.transaction().map_err(internal)?;
    tx.execute(
        "UPDATE agent_tasks SET revoked=1 WHERE id=?1 AND account_id=?2",
        params![input.id, user.id],
    )
    .map_err(internal)?;
    audit(&tx, &user.id, "agent_revoked", &input.id)?;
    tx.commit().map_err(internal)?;
    inner
        .platform
        .invocations
        .retain(|_, x| x.invocation.id != input.id);
    Ok(Json(json!({"revoked":true})))
}
fn agent_allowed(inner: &Inner, id: &str) -> ApiResult<AgentGrant> {
    let row: Option<(String, String, String, bool)> = inner
        .db
        .query_row(
            "SELECT token,account_id,credential_id,revoked FROM agent_tasks WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(internal)?;
    let (token, account, key, revoked) = row.ok_or(forbidden("agent_denied"))?;
    let token: Signed<AgentGrant> =
        serde_json::from_str(&token).map_err(|_| forbidden("agent_denied"))?;
    let grant = &token.body;
    let sig = Signature::from_slice(&token.signature).map_err(|_| forbidden("agent_denied"))?;
    inner
        .issuer
        .verifying_key()
        .verify_strict(&agent_message(grant)?, &sig)
        .map_err(|_| forbidden("agent_denied"))?;
    if revoked
        || grant.profile != "heavenkey-agent-v1"
        || grant.id != id
        || grant.account_id != account
        || grant.credential_id != key
        || grant.not_before > now()
        || grant.expires_at <= now()
        || !inner.credential_active(&account, &key)?
    {
        return Err(forbidden("agent_denied"));
    }
    agent_authority(
        inner,
        &inner.user("id", &account)?,
        &grant.spec,
        grant.expires_at,
    )?;
    Ok(token.body)
}
pub(super) async fn agents(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    let mut stmt=inner.db.prepare("SELECT id,token,revoked FROM agent_tasks WHERE account_id=?1 ORDER BY created DESC,rowid DESC LIMIT 100").map_err(internal)?;
    let rows = stmt
        .query_map([&user.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
            ))
        })
        .map_err(internal)?;
    let mut tasks = Vec::new();
    for row in rows {
        let (id, token, revoked) = row.map_err(internal)?;
        let token: Signed<AgentGrant> = serde_json::from_str(&token).map_err(internal)?;
        tasks.push(json!({"id":id,"grant":token,"revoked":revoked,"effective_active":agent_allowed(&inner,&id).is_ok()}));
    }
    Ok(Json(json!({"tasks":tasks,"sandbox_only":true})))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AgentInvocation {
    id: String,
    resource: String,
    action: Action,
    arguments: BTreeMap<String, String>,
}
fn invocation_allowed(inner: &Inner, inv: &AgentInvocation) -> ApiResult<AgentGrant> {
    let grant = agent_allowed(inner, &inv.id)?;
    if inv.resource != grant.spec.resource
        || !grant.spec.actions.contains(&inv.action)
        || inv.arguments.len() > 4
        || inv
            .arguments
            .iter()
            .any(|(k, v)| k.len() > 32 || v.len() > 256 || v.chars().any(char::is_control))
    {
        return Err(forbidden("agent_scope_denied"));
    }
    match (inv.resource.as_str(), inv.action) {
        ("document", Action::Read) | ("crm.contacts", Action::Read) if inv.arguments.is_empty() => {
        }
        ("crm.contacts", Action::Write)
            if inv.arguments.len() == 2
                && inv
                    .arguments
                    .get("id")
                    .is_some_and(|id| id == "demo-contact")
                && inv.arguments.contains_key("note") => {}
        _ => return Err(forbidden("agent_arguments_denied")),
    }
    Ok(grant)
}
pub(super) async fn agent_challenge(
    State(app): State<App>,
    Json(input): Json<AgentInvocation>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    invocation_allowed(&inner, &input)?;
    if inner.platform.invocations.len() >= MAX_PENDING
        || inner
            .platform
            .invocations
            .values()
            .filter(|x| x.invocation.id == input.id)
            .count()
            >= 8
    {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "challenge_limit"));
    }
    let mut nonce = [0u8; 32];
    rand::rng().fill_bytes(&mut nonce);
    let id = Uuid::new_v4().to_string();
    let mut message = b"HEAVENKEY-AGENT-INVOKE-v1\0".to_vec();
    message.extend(Sha256::digest(app.origin.as_bytes()));
    message.extend(nonce);
    message.extend(Sha256::digest(
        serde_json::to_vec(&input).map_err(internal)?,
    ));
    let encoded = URL_SAFE_NO_PAD.encode(&message);
    inner.platform.invocations.insert(
        id.clone(),
        AgentChallenge {
            invocation: input,
            message,
            expires: Instant::now() + Duration::from_secs(60),
        },
    );
    Ok(Json(
        json!({"challenge_id":id,"message":encoded,"expires_in":60,"algorithm":"Ed25519"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AgentProof {
    challenge_id: String,
    signature: String,
}
pub(super) async fn agent_invoke(
    State(app): State<App>,
    Json(input): Json<AgentProof>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    inner.prune();
    let pending = inner
        .platform
        .invocations
        .remove(&input.challenge_id)
        .ok_or(forbidden("challenge_missing"))?;
    let grant = invocation_allowed(&inner, &pending.invocation)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(&input.signature)
        .map_err(|_| forbidden("agent_signature_invalid"))?;
    let signature =
        Signature::from_slice(&bytes).map_err(|_| forbidden("agent_signature_invalid"))?;
    public_key(&grant.spec.public_key)?
        .verify_strict(&pending.message, &signature)
        .map_err(|_| forbidden("agent_signature_invalid"))?;
    let tx = inner.db.transaction().map_err(internal)?;
    tx.execute(
        "INSERT INTO agent_operations(id,task_id,account_id,created) VALUES(?1,?2,?3,?4)",
        params![
            input.challenge_id,
            grant.id,
            grant.account_id,
            db_time(now())?
        ],
    )
    .map_err(|_| forbidden("challenge_replayed"))?;
    let data = match pending.invocation.resource.as_str() {
        "document" => json!({"document":"HeavenKey example document — verified agent access"}),
        "crm.contacts" => {
            tx.execute("INSERT OR IGNORE INTO crm_contacts(account_id,id,name,note) VALUES(?1,'demo-contact','Hotel Alpenblick · Beispiel','Synthetischer Testkontakt')",[&grant.account_id]).map_err(internal)?;
            if pending.invocation.action == Action::Write {
                tx.execute(
                    "UPDATE crm_contacts SET note=?1 WHERE account_id=?2 AND id='demo-contact'",
                    params![pending.invocation.arguments.get("note"), grant.account_id],
                )
                .map_err(internal)?;
            }
            let contact=tx.query_row("SELECT id,name,note FROM crm_contacts WHERE account_id=?1 AND id='demo-contact'",[&grant.account_id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"note":r.get::<_,String>(2)?}))).map_err(internal)?;
            json!({"tenant":grant.account_id,"contacts":[contact],"sandbox":true})
        }
        _ => return Err(forbidden("agent_scope_denied")),
    };
    audit(
        &tx,
        &grant.account_id,
        if pending.invocation.action == Action::Write {
            "agent_write"
        } else {
            "agent_read"
        },
        &grant.id,
    )?;
    tx.commit().map_err(internal)?;
    Ok(Json(
        json!({"allowed":true,"operation":input.challenge_id,"data":data}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SessionRead {
    grant_id: Option<String>,
    delegation_id: Option<String>,
}
pub(super) async fn read(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<SessionRead>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    match (&input.grant_id, &input.delegation_id) {
        (Some(id), None) => {
            let token: String = inner
                .db
                .query_row("SELECT token FROM grants WHERE id=?1", [id], |r| r.get(0))
                .optional()
                .map_err(internal)?
                .ok_or(forbidden("unknown_grant"))?;
            let grant: Signed<Grant> = serde_json::from_str(&token).map_err(internal)?;
            inner.grant_allowed(
                &user,
                &Invocation {
                    grant,
                    resource: RESOURCE.into(),
                    action: Action::Read,
                    arguments: BTreeMap::new(),
                },
            )?;
        }
        (None, Some(id)) => {
            inner.delegation_allowed(
                &user,
                &DelegationInvocation {
                    id: id.clone(),
                    resource: RESOURCE.into(),
                    action: Action::Read,
                    arguments: BTreeMap::new(),
                },
            )?;
        }
        _ => return Err(forbidden("ambiguous_invocation")),
    }
    audit(
        &inner.db,
        &user.id,
        "session_read",
        input
            .grant_id
            .as_deref()
            .or(input.delegation_id.as_deref())
            .unwrap_or_default(),
    )?;
    Ok(Json(
        json!({"allowed":true,"data":"HeavenKey example document — session and current authorization verified","fresh_passkey_required":false}),
    ))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct VaultWrap {
    credential_id: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecoveryWrap {
    salt: String,
    nonce: String,
    ciphertext: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct VaultRecord {
    version: u8,
    nonce: String,
    ciphertext: String,
    wraps: Vec<VaultWrap>,
    recovery: RecoveryWrap,
}
fn binary_length(value: &str, min: usize, max: usize) -> ApiResult<()> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| forbidden("invalid_vault_record"))?;
    if !(min..=max).contains(&bytes.len()) || URL_SAFE_NO_PAD.encode(bytes) != value {
        return Err(forbidden("invalid_vault_record"));
    }
    Ok(())
}
fn validate_vault(inner: &Inner, user: &User, record: &VaultRecord) -> ApiResult<()> {
    if record.version != 1 || record.wraps.is_empty() || record.wraps.len() > 8 {
        return Err(forbidden("invalid_vault_record"));
    }
    binary_length(&record.nonce, 12, 12)?;
    binary_length(&record.ciphertext, 16, 8192)?;
    binary_length(&record.recovery.salt, 32, 32)?;
    binary_length(&record.recovery.nonce, 12, 12)?;
    binary_length(&record.recovery.ciphertext, 48, 48)?;
    let mut ids = BTreeSet::new();
    for w in &record.wraps {
        if !ids.insert(&w.credential_id) || !inner.credential_active(&user.id, &w.credential_id)? {
            return Err(forbidden("vault_credential_denied"));
        }
        binary_length(&w.salt, 32, 32)?;
        binary_length(&w.nonce, 12, 12)?;
        binary_length(&w.ciphertext, 48, 48)?;
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct VaultPrepare {
    expected_revision: u64,
    record: VaultRecord,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct VaultWrite {
    expected_revision: u64,
    record: VaultRecord,
    approval_id: Option<String>,
}
fn vault_operation(revision: u64, record: &VaultRecord) -> ApiResult<Management> {
    Ok(Management::VaultWrite {
        expected_revision: revision,
        digest: URL_SAFE_NO_PAD.encode(Sha256::digest(
            serde_json::to_vec(record).map_err(internal)?,
        )),
    })
}
pub(super) async fn vault(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    let row: Option<(i64, String)> = inner
        .db
        .query_row(
            "SELECT revision,record FROM vaults WHERE account_id=?1",
            [&user.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(internal)?;
    match row {
        Some((revision, record)) => Ok(Json(
            json!({"account_id":user.id,"revision":revision,"record":serde_json::from_str::<VaultRecord>(&record).map_err(internal)?}),
        )),
        None => Ok(Json(
            json!({"account_id":user.id,"revision":0,"record":null}),
        )),
    }
}
pub(super) async fn vault_prepare(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<VaultPrepare>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let user = inner.session_user(&headers)?;
    validate_vault(&inner, &user, &input.record)?;
    Ok(Json(
        json!({"management":vault_operation(input.expected_revision,&input.record)?}),
    ))
}
pub(super) async fn vault_write(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<VaultWrite>,
) -> ApiResult<Json<Value>> {
    let mut inner = app.inner.lock().map_err(internal)?;
    let approval = inner.take_approval(input.approval_id.as_deref());
    let user = inner.session_user(&headers)?;
    inner.require_approval(
        &headers,
        &user,
        input.approval_id.as_deref(),
        approval,
        &vault_operation(input.expected_revision, &input.record)?,
    )?;
    validate_vault(&inner, &user, &input.record)?;
    let revision = input
        .expected_revision
        .checked_add(1)
        .filter(|v| *v <= 9007199254740991)
        .ok_or(forbidden("vault_revision_conflict"))?;
    let record = serde_json::to_string(&input.record).map_err(internal)?;
    let tx = inner.db.transaction().map_err(internal)?;
    let changed = if input.expected_revision == 0 {
        tx.execute(
            "INSERT OR IGNORE INTO vaults(account_id,revision,record) VALUES(?1,1,?2)",
            params![user.id, record],
        )
    } else {
        tx.execute(
            "UPDATE vaults SET revision=?1,record=?2 WHERE account_id=?3 AND revision=?4",
            params![
                db_time(revision)?,
                record,
                user.id,
                db_time(input.expected_revision)?
            ],
        )
    }
    .map_err(internal)?;
    if changed != 1 {
        return Err(ApiError(StatusCode::CONFLICT, "vault_revision_conflict"));
    }
    audit(&tx, &user.id, "vault_updated", &revision.to_string())?;
    tx.commit().map_err(internal)?;
    Ok(Json(json!({"revision":revision,"saved":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{
        add_approval, app, delegation_app, headers, management_app, root_delegation,
    };
    fn spec(key: &SigningKey, resource: &str) -> AgentSpec {
        AgentSpec {
            name: "Synthetic agent".into(),
            public_key: URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
            resource: resource.into(),
            actions: BTreeSet::from([Action::Read]),
            ttl_seconds: 120,
            parent_id: None,
        }
    }
    async fn task(app: &App, token: &str, spec: AgentSpec) -> String {
        let approval_id = Some(add_approval(
            app,
            token,
            Management::AgentCreate { spec: spec.clone() },
        ));
        let result = agent_create(
            State(app.clone()),
            headers(token),
            Json(AgentCreate { spec, approval_id }),
        )
        .await
        .unwrap();
        result.0["id"].as_str().unwrap().to_owned()
    }
    async fn challenge(app: &App, id: &str, resource: &str) -> (String, Vec<u8>) {
        let result = agent_challenge(
            State(app.clone()),
            Json(AgentInvocation {
                id: id.into(),
                resource: resource.into(),
                action: Action::Read,
                arguments: BTreeMap::new(),
            }),
        )
        .await
        .unwrap();
        (
            result.0["challenge_id"].as_str().unwrap().into(),
            URL_SAFE_NO_PAD
                .decode(result.0["message"].as_str().unwrap())
                .unwrap(),
        )
    }
    async fn proof(
        app: &App,
        key: &SigningKey,
        id: String,
        message: &[u8],
    ) -> ApiResult<Json<Value>> {
        agent_invoke(
            State(app.clone()),
            Json(AgentProof {
                challenge_id: id,
                signature: URL_SAFE_NO_PAD.encode(key.sign(message).to_bytes()),
            }),
        )
        .await
    }
    #[tokio::test]
    async fn recovery_setup_requires_fresh_exact_approval_and_only_stores_a_digest() {
        let (app, owner, _, _) = management_app();
        assert_eq!(
            recovery_rotate(
                State(app.clone()),
                headers(&owner),
                Json(Approved { approval_id: None })
            )
            .await
            .unwrap_err()
            .1,
            "approval_required"
        );
        let approval = add_approval(&app, &owner, Management::RecoveryRotate);
        let first = recovery_rotate(
            State(app.clone()),
            headers(&owner),
            Json(Approved {
                approval_id: Some(approval.clone()),
            }),
        )
        .await
        .unwrap();
        let code = first.0["code"].as_str().unwrap();
        {
            let inner = app.inner.lock().unwrap();
            let user = inner.user("name", "owner").unwrap();
            let stored: String = inner
                .db
                .query_row(
                    "SELECT digest FROM recovery_codes WHERE account_id=?1",
                    [&user.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                stored,
                URL_SAFE_NO_PAD.encode(uac_recovery::digest(&user.id, code).unwrap())
            );
            assert_ne!(stored, code);
        }
        assert!(
            recovery_rotate(
                State(app.clone()),
                headers(&owner),
                Json(Approved {
                    approval_id: Some(approval)
                })
            )
            .await
            .is_err()
        );
        let approval = add_approval(&app, &owner, Management::RecoveryRotate);
        let second = recovery_rotate(
            State(app.clone()),
            headers(&owner),
            Json(Approved {
                approval_id: Some(approval),
            }),
        )
        .await
        .unwrap();
        assert_ne!(first.0["code"], second.0["code"]);
        assert_eq!(
            recovery_start(
                State(app.clone()),
                Json(RecoveryStart {
                    name: "owner".into(),
                    code: code.into(),
                    label: "Replacement".into()
                })
            )
            .await
            .unwrap_err()
            .1,
            "recovery_denied"
        );
        let wrong = add_approval(&app, &owner, Management::RecoveryRotate);
        assert_eq!(
            recovery_disable(
                State(app.clone()),
                headers(&owner),
                Json(Approved {
                    approval_id: Some(wrong)
                })
            )
            .await
            .unwrap_err()
            .1,
            "approval_mismatch"
        );
    }
    #[tokio::test]
    async fn agent_proof_is_required_one_use_and_bound_to_exact_action_and_authority() {
        let (app, owner, guest, _) = management_app();
        let key = SigningKey::from_bytes(&[31; 32]);
        let id = task(&app, &owner, spec(&key, "crm.contacts")).await;
        let (challenge_id, message) = challenge(&app, &id, "crm.contacts").await;
        let good = proof(&app, &key, challenge_id.clone(), &message)
            .await
            .unwrap();
        assert_eq!(good.0["allowed"], true);
        assert_eq!(
            proof(&app, &key, challenge_id, &message)
                .await
                .unwrap_err()
                .1,
            "challenge_missing"
        );
        let (challenge_id, message) = challenge(&app, &id, "crm.contacts").await;
        let wrong = SigningKey::from_bytes(&[32; 32]);
        assert_eq!(
            proof(&app, &wrong, challenge_id.clone(), &message)
                .await
                .unwrap_err()
                .1,
            "agent_signature_invalid"
        );
        assert!(proof(&app, &key, challenge_id, &message).await.is_err());
        assert!(
            agent_challenge(
                State(app.clone()),
                Json(AgentInvocation {
                    id: id.clone(),
                    resource: "crm.contacts".into(),
                    action: Action::Write,
                    arguments: BTreeMap::from([
                        ("id".into(), "demo-contact".into()),
                        ("note".into(), "changed".into())
                    ])
                })
            )
            .await
            .is_err()
        );
        let guest_user = {
            app.inner
                .lock()
                .unwrap()
                .session_user(&headers(&guest))
                .unwrap()
        };
        assert!(
            management_allowed(
                &app.inner.lock().unwrap(),
                &guest_user,
                &Management::AgentCreate {
                    spec: spec(&key, "crm.contacts")
                }
            )
            .is_err()
        );
        let (challenge_id, message) = challenge(&app, &id, "crm.contacts").await;
        let approval_id = Some(add_approval(
            &app,
            &owner,
            Management::AgentRevoke { id: id.clone() },
        ));
        let _ = agent_revoke(
            State(app.clone()),
            headers(&owner),
            Json(AgentRevoke {
                id: id.clone(),
                approval_id,
            }),
        )
        .await
        .unwrap();
        assert!(proof(&app, &key, challenge_id, &message).await.is_err());
        assert!(
            agent_challenge(
                State(app.clone()),
                Json(AgentInvocation {
                    id,
                    resource: "crm.contacts".into(),
                    action: Action::Read,
                    arguments: BTreeMap::new()
                })
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn delegated_agent_cannot_bypass_parent_budget_expiry_or_ancestor_revocation() {
        let (app, tokens) = delegation_app();
        let owner = &tokens["owner"];
        let guest = &tokens["guest"];
        let key = SigningKey::from_bytes(&[33; 32]);
        let parent = root_delegation(&app, owner, "guest", 300, 1).await.unwrap();
        let parent_id = parent.0["id"].as_str().unwrap().to_owned();
        let mut settings = spec(&key, "document");
        settings.parent_id = Some(parent_id.clone());
        let id = task(&app, guest, settings.clone()).await;
        let (challenge_id, message) = challenge(&app, &id, "document").await;
        {
            app.inner
                .lock()
                .unwrap()
                .db
                .execute("UPDATE delegations SET revoked=1 WHERE id=?1", [parent_id])
                .unwrap();
        }
        assert!(proof(&app, &key, challenge_id, &message).await.is_err());
        let parent = root_delegation(&app, owner, "guest", 300, 0).await.unwrap();
        settings.parent_id = Some(parent.0["id"].as_str().unwrap().into());
        let inner = app.inner.lock().unwrap();
        let user = inner.user("name", "guest").unwrap();
        assert!(agent_authority(&inner, &user, &settings, now() + 120).is_err());
        settings.ttl_seconds = u64::MAX;
        assert!(
            management_allowed(&inner, &user, &Management::AgentCreate { spec: settings }).is_err()
        );
    }
    fn vault_record(id: &str) -> VaultRecord {
        let w = RecoveryWrap {
            salt: URL_SAFE_NO_PAD.encode([1; 32]),
            nonce: URL_SAFE_NO_PAD.encode([2; 12]),
            ciphertext: URL_SAFE_NO_PAD.encode([3; 48]),
        };
        VaultRecord {
            version: 1,
            nonce: URL_SAFE_NO_PAD.encode([4; 12]),
            ciphertext: URL_SAFE_NO_PAD.encode([5; 32]),
            wraps: vec![VaultWrap {
                credential_id: id.into(),
                salt: w.salt.clone(),
                nonce: w.nonce.clone(),
                ciphertext: w.ciphertext.clone(),
            }],
            recovery: w,
        }
    }
    #[tokio::test]
    async fn vault_writes_bind_ciphertext_revision_and_active_account_keys() {
        let (app, owner, guest, _) = management_app();
        let credential = {
            let inner = app.inner.lock().unwrap();
            inner.sessions[&owner].credential_id.clone()
        };
        let record = vault_record(&credential);
        let approval = add_approval(&app, &owner, vault_operation(0, &record).unwrap());
        let result = vault_write(
            State(app.clone()),
            headers(&owner),
            Json(VaultWrite {
                expected_revision: 0,
                record: record.clone(),
                approval_id: Some(approval.clone()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(result.0["revision"], 1);
        assert!(
            vault_write(
                State(app.clone()),
                headers(&owner),
                Json(VaultWrite {
                    expected_revision: 0,
                    record: record.clone(),
                    approval_id: Some(approval)
                })
            )
            .await
            .is_err()
        );
        assert_eq!(
            vault(State(app.clone()), headers(&guest)).await.unwrap().0["record"],
            Value::Null
        );
        let stale = add_approval(&app, &owner, vault_operation(0, &record).unwrap());
        assert_eq!(
            vault_write(
                State(app.clone()),
                headers(&owner),
                Json(VaultWrite {
                    expected_revision: 0,
                    record: record.clone(),
                    approval_id: Some(stale)
                })
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::CONFLICT
        );
        let approval = add_approval(&app, &owner, vault_operation(1, &record).unwrap());
        let mut changed = record.clone();
        changed.ciphertext = URL_SAFE_NO_PAD.encode([6; 32]);
        assert_eq!(
            vault_write(
                State(app.clone()),
                headers(&owner),
                Json(VaultWrite {
                    expected_revision: 1,
                    record: changed,
                    approval_id: Some(approval)
                })
            )
            .await
            .unwrap_err()
            .1,
            "approval_mismatch"
        );
        let foreign = vault_record("not-an-account-credential");
        assert!(
            vault_prepare(
                State(app.clone()),
                headers(&owner),
                Json(VaultPrepare {
                    expected_revision: 1,
                    record: foreign
                })
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn session_reads_recheck_live_delegation_and_logout_invalidates_approvals() {
        let (app, tokens) = delegation_app();
        let owner = &tokens["owner"];
        let guest = &tokens["guest"];
        let parent = root_delegation(&app, owner, "guest", 300, 1).await.unwrap();
        let id = parent.0["id"].as_str().unwrap().to_owned();
        assert_eq!(
            read(
                State(app.clone()),
                headers(guest),
                Json(SessionRead {
                    grant_id: None,
                    delegation_id: Some(id.clone())
                })
            )
            .await
            .unwrap()
            .0["allowed"],
            true
        );
        app.inner
            .lock()
            .unwrap()
            .db
            .execute("UPDATE delegations SET revoked=1 WHERE id=?1", [id.clone()])
            .unwrap();
        assert!(
            read(
                State(app.clone()),
                headers(guest),
                Json(SessionRead {
                    grant_id: None,
                    delegation_id: Some(id)
                })
            )
            .await
            .is_err()
        );
        let approval = add_approval(&app, guest, Management::RecoveryRotate);
        let _ = logout(State(app.clone()), headers(guest)).await.unwrap();
        assert!(!app.inner.lock().unwrap().approvals.contains_key(&approval));
        assert!(session(State(app.clone()), headers(guest)).await.is_err());
    }
    #[test]
    fn rp_identity_is_durable_and_rejects_unsafe_origins() {
        for origin in [
            "http://evil.example",
            "https://x.example/path",
            "https://user@x.example/",
            "https://x.example/?token=x",
            "https://x.example/#fragment",
        ] {
            assert!(identity(origin, "x.example").is_err());
        }
        assert!(identity("https://auth.example.test", "example.test").is_ok());
        let app = app();
        let inner = app.inner.lock().unwrap();
        pin_identity(&inner.db, "localhost").unwrap();
        assert!(pin_identity(&inner.db, "new.example").is_err());
    }
}
