use super::*;
use openssl::{
    encrypt::Decrypter,
    hash::MessageDigest,
    pkey::{PKey, Private},
    rsa::{Padding, Rsa},
    symm::{Cipher, decrypt_aead},
};
use std::{
    collections::VecDeque,
    sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use zeroize::{Zeroize, Zeroizing};
mod protocol;
pub const MAX_BYTES: usize = 1024 * 1024;
const TTL: u64 = 300;
pub(super) fn agent_transport(headers: &HeaderMap, path: &str) -> bool {
    matches!(
        path,
        "/api/transfer-broker/agent/request" | "/api/transfer-broker/agent/status"
    ) && !headers.contains_key("origin")
        && headers
            .get("x-heavenkey-client")
            .and_then(|v| v.to_str().ok())
            == Some("password-agent")
}

pub struct TransferBroker {
    state: Mutex<Inner>,
    key: OnceLock<Result<PKey<Private>, ()>>,
    active: Arc<AtomicUsize>,
}
// Admission belongs to the actual thread, independently of request visibility/revocation.
struct Permit(Arc<AtomicUsize>);
impl Permit {
    fn acquire(active: Arc<AtomicUsize>, limit: usize) -> Option<Self> {
        let mut used = active.load(Ordering::Acquire);
        loop {
            if used >= limit {
                return None;
            }
            match active.compare_exchange_weak(used, used + 1, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => break,
                Err(current) => used = current,
            }
        }
        Some(Self(active))
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Default)]
struct Inner {
    identity: Option<(u64, u64)>,
    requests: HashMap<String, Pending>,
    audit: VecDeque<Value>,
}
struct Pending {
    id: String,
    client: String,
    label: String,
    request: TransferRequest,
    status: &'static str,
    expires: Instant,
    expires_at: u64,
    bytes: usize,
    cancel: Arc<AtomicBool>,
    result: Option<Value>,
    error: Option<&'static str>,
}
impl Inner {
    fn invalidate(&mut self) {
        for r in self.requests.values_mut() {
            r.cancel.store(true, Ordering::SeqCst);
            r.status = "denied";
            r.result = None;
            r.error = None;
            r.request.content = None;
        }
        self.identity = None;
    }
    fn sweep(&mut self) {
        let now = Instant::now();
        self.requests.retain(|_, r| {
            if r.expires <= now {
                r.cancel.store(true, Ordering::SeqCst);
                false
            } else {
                true
            }
        });
    }
    fn audit(&mut self, action: &str, id: &str, result: &str) {
        self.audit
            .push_back(json!({"at":now(),"action":action,"request_id":id,"result":result}));
        while self.audit.len() > 100 {
            self.audit.pop_front();
        }
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.invalidate();
    }
}
impl TransferBroker {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(Inner::default()),
            key: OnceLock::new(),
            active: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.invalidate();
        }
    }
    pub fn revoke_client(&self, client: &str) {
        if let Ok(mut s) = self.state.lock() {
            for request in s.requests.values_mut().filter(|r| r.client == client) {
                request.cancel.store(true, Ordering::SeqCst);
                request.status = "denied";
                request.result = None;
                request.request.content = None;
            }
        }
    }
    fn state(&self, app: &VaultApp) -> ApiResult<std::sync::MutexGuard<'_, Inner>> {
        let identity = broker::transfer_owner(app);
        let mut s = self.state.lock().map_err(internal)?;
        let identity = match identity {
            Ok(identity) => identity,
            Err(e) => {
                s.invalidate();
                return Err(e);
            }
        };
        if s.identity != Some(identity) {
            s.invalidate();
            s.identity = Some(identity);
        }
        s.sweep();
        Ok(s)
    }
    fn key(&self) -> ApiResult<&PKey<Private>> {
        self.key
            .get_or_init(|| Rsa::generate(3072).and_then(PKey::from_rsa).map_err(|_| ()))
            .as_ref()
            .map_err(|_| {
                ApiError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "transfer_key_unavailable",
                )
            })
    }
    fn unseal(&self, id: &str, epoch: u64, revision: u64, sealed: &Sealed) -> ApiResult<Payload> {
        if !decoded(&sealed.key, 384, 384)
            || !decoded(&sealed.iv, 12, 12)
            || !decoded(&sealed.ciphertext, 17, 49152)
        {
            return Err(invalid());
        }
        let mut dec = Decrypter::new(self.key()?).map_err(internal)?;
        dec.set_rsa_padding(Padding::PKCS1_OAEP).map_err(internal)?;
        dec.set_rsa_oaep_md(MessageDigest::sha256())
            .map_err(internal)?;
        dec.set_rsa_mgf1_md(MessageDigest::sha256())
            .map_err(internal)?;
        let wrapped = URL_SAFE_NO_PAD.decode(&sealed.key).map_err(|_| invalid())?;
        let mut key = Zeroizing::new(vec![0; 384]);
        if dec.decrypt(&wrapped, &mut key).map_err(|_| invalid())? != 32 {
            return Err(invalid());
        }
        let iv = URL_SAFE_NO_PAD.decode(&sealed.iv).map_err(|_| invalid())?;
        let cipher = URL_SAFE_NO_PAD
            .decode(&sealed.ciphertext)
            .map_err(|_| invalid())?;
        let split = cipher.len() - 16;
        let aad = format!("HeavenKey transfer v1\0{id}\0{epoch}\0{revision}");
        let plain = Zeroizing::new(
            decrypt_aead(
                Cipher::aes_256_gcm(),
                &key[..32],
                Some(&iv),
                aad.as_bytes(),
                &cipher[..split],
                &cipher[split..],
            )
            .map_err(|_| invalid())?,
        );
        let payload: Payload = serde_json::from_slice(&plain).map_err(|_| invalid())?;
        if payload.version != 1 || !payload.profile.valid() {
            return Err(invalid());
        }
        Ok(payload)
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn invalid() -> ApiError {
    ApiError(StatusCode::UNPROCESSABLE_ENTITY, "invalid_transfer_request")
}
fn denied() -> ApiError {
    forbidden("transfer_denied")
}
fn busy() -> ApiError {
    ApiError(StatusCode::CONFLICT, "transfer_busy")
}
fn safe_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
pub(super) fn relative_path(s: &str, empty: bool) -> bool {
    s.len() <= 1024
        && (empty || !s.is_empty())
        && !s.starts_with('/')
        && !s.chars().any(|c| c.is_control() || c == '\\')
        && (s.is_empty()
            || s.split('/')
                .all(|p| !p.is_empty() && !matches!(p, "." | "..")))
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferProfile {
    id: String,
    label: String,
    provider: String,
    protocol: String,
    host: String,
    port: u16,
    username: String,
    root: String,
    host_key: String,
    password: String,
    private_key: String,
    public_key: String,
    #[serde(default)]
    ca_certificate: String,
}
impl Drop for TransferProfile {
    fn drop(&mut self) {
        self.password.zeroize();
        self.private_key.zeroize();
    }
}
impl TransferProfile {
    fn valid(&self) -> bool {
        let host_valid = self.host.len() <= 253
            && !self.host.is_empty()
            && self
                .host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b':'))
            && !self.host.ends_with('.');
        // The server-enforced account jail is the boundary; subdirectory profiles are unsafe.
        let root_valid = self.root == "/";
        if Uuid::parse_str(&self.id).is_err()
            || !safe_text(&self.label, 100)
            || self.provider.len() > 100
            || !host_valid
            || self.port == 0
            || !safe_text(&self.username, 256)
            || !root_valid
            || self.password.len() > 4096
            || self.password.contains('\0')
            || self.private_key.len() > 16384
            || self.public_key.len() > 4096
            || self.ca_certificate.len() > 16384
        {
            return false;
        }
        match self.protocol.as_str() {
            "sftp" => {
                let pin = self
                    .host_key
                    .strip_prefix("SHA256:")
                    .and_then(|s| {
                        base64::engine::general_purpose::STANDARD_NO_PAD
                            .decode(s)
                            .ok()
                    })
                    .is_some_and(|b| b.len() == 32);
                self.ca_certificate.is_empty()
                    && pin
                    && ((!self.password.is_empty()
                        && self.private_key.is_empty()
                        && self.public_key.is_empty())
                        || (self.password.is_empty()
                            && self.private_key.starts_with("-----BEGIN PRIVATE KEY-----")
                            && self.public_key.starts_with("ssh-ed25519 ")
                            && PKey::private_key_from_pem(self.private_key.as_bytes()).is_ok_and(
                                |k| {
                                    if k.id() != openssl::pkey::Id::ED25519 {
                                        return false;
                                    }
                                    let Ok(raw) = k.raw_public_key() else {
                                        return false;
                                    };
                                    let mut blob = Vec::with_capacity(51);
                                    blob.extend_from_slice(&11u32.to_be_bytes());
                                    blob.extend_from_slice(b"ssh-ed25519");
                                    blob.extend_from_slice(&32u32.to_be_bytes());
                                    blob.extend_from_slice(&raw);
                                    self.public_key
                                        .split_whitespace()
                                        .nth(1)
                                        .is_some_and(|key| {
                                            base64::engine::general_purpose::STANDARD
                                                .decode(key)
                                                .is_ok_and(|key| key == blob)
                                        })
                                },
                            )))
            }
            "ftpes" => {
                !self.password.is_empty()
                    && self.private_key.is_empty()
                    && self.public_key.is_empty()
                    && self.host_key.is_empty()
                    && (self.ca_certificate.is_empty() || valid_ca(&self.ca_certificate))
            }
            _ => false,
        }
    }
}
fn valid_ca(pem: &str) -> bool {
    let pem = pem.trim();
    pem.starts_with("-----BEGIN CERTIFICATE-----")
        && pem.ends_with("-----END CERTIFICATE-----")
        && pem.matches("-----BEGIN CERTIFICATE-----").count() == 1
        && !pem.contains("PRIVATE KEY")
        && openssl::x509::X509::from_pem(pem.as_bytes()).is_ok()
        && native_tls::Certificate::from_pem(pem.as_bytes()).is_ok()
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferRequest {
    connection_id: String,
    operation: String,
    path: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
}
impl Drop for TransferRequest {
    fn drop(&mut self) {
        if let Some(s) = self.content.as_mut() {
            s.zeroize();
        }
    }
}
impl TransferRequest {
    fn valid(&self) -> bool {
        if Uuid::parse_str(&self.connection_id).is_err()
            || !relative_path(&self.path, self.operation == "list")
        {
            return false;
        }
        match self.operation.as_str() {
            "list" | "stat" | "get" => self.content.is_none() && self.sha256.is_none(),
            "put" => {
                let Some(encoded) = self
                    .content
                    .as_ref()
                    .filter(|s| s.len() <= MAX_BYTES.div_ceil(3) * 4)
                else {
                    return false;
                };
                let Some(hash) = self.sha256.as_ref().filter(|s| digest(s)) else {
                    return false;
                };
                let Ok(data) = URL_SAFE_NO_PAD.decode(encoded).map(Zeroizing::new) else {
                    return false;
                };
                data.len() <= MAX_BYTES && format!("{:x}", sha2::Sha256::digest(&*data)) == *hash
            }
            _ => false,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestId {
    request_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sealed {
    key: String,
    iv: String,
    ciphertext: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    epoch: u64,
    revision: u64,
    sealed: Sealed,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    version: u8,
    profile: TransferProfile,
    operation: String,
    path: String,
    sha256: Option<String>,
    disclose_content: bool,
}
async fn status(State(app): State<VaultApp>, h: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let public_key =
        URL_SAFE_NO_PAD.encode(app.transfer.key()?.public_key_to_der().map_err(internal)?);
    let s = app.transfer.state(&app)?;
    let (epoch, revision) = s.identity.ok_or_else(denied)?;
    Ok(Json(
        json!({"version":1,"public_key":public_key,"epoch":epoch,"revision":revision,"requests":s.requests.values().map(|r|json!({"id":r.id,"client_id":r.client,"label":r.label,"connection_id":r.request.connection_id,"operation":r.request.operation,"path":r.request.path,"sha256":r.request.sha256.as_deref().unwrap_or(""),"bytes":r.bytes,"status":r.status,"expires_at":r.expires_at})).collect::<Vec<_>>(),"audit":s.audit,"limits":{"max_bytes":MAX_BYTES,"request_seconds":TTL},"protocols":["sftp","ftpes"]}),
    ))
}
async fn request(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<TransferRequest>,
) -> ApiResult<Json<Value>> {
    let (client, label) = broker::transfer_client(&app, &h)?;
    if !input.valid() {
        return Err(invalid());
    }
    let mut s = app.transfer.state(&app)?;
    if s.requests.len() >= 32 {
        return Err(busy());
    }
    let id = Uuid::new_v4().to_string();
    s.requests.insert(
        id.clone(),
        Pending {
            id: id.clone(),
            client,
            label,
            bytes: input.content.as_ref().map(|s| s.len() * 3 / 4).unwrap_or(0),
            request: input,
            status: "pending",
            expires: Instant::now() + Duration::from_secs(TTL),
            expires_at: now() + TTL,
            cancel: Arc::new(AtomicBool::new(false)),
            result: None,
            error: None,
        },
    );
    s.audit("request", &id, "pending");
    Ok(Json(json!({"request_id":id,"status":"pending"})))
}
async fn agent_status(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<RequestId>,
) -> ApiResult<Json<Value>> {
    let (client, _) = broker::transfer_client(&app, &h)?;
    let s = app.transfer.state(&app)?;
    let r = s
        .requests
        .get(&input.request_id)
        .filter(|r| r.client == client)
        .ok_or_else(denied)?;
    Ok(Json(
        json!({"request_id":r.id,"status":r.status,"result":r.result,"error":r.error}),
    ))
}
async fn approve(
    State(app): State<VaultApp>,
    h: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<Approval>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let permit = Permit::acquire(app.transfer.active.clone(), 2).ok_or_else(busy)?;
    let payload = app
        .transfer
        .unseal(&id, input.epoch, input.revision, &input.sealed)?;
    let (r, cancel, client, identity) = {
        let mut s = app.transfer.state(&app)?;
        if s.identity != Some((input.epoch, input.revision)) {
            return Err(denied());
        }
        let r = s
            .requests
            .get_mut(&id)
            .filter(|r| r.status == "pending")
            .ok_or_else(denied)?;
        if payload.profile.id != r.request.connection_id
            || payload.operation != r.request.operation
            || payload.path != r.request.path
            || payload.sha256 != r.request.sha256
            || (r.request.operation == "get" && !payload.disclose_content)
        {
            return Err(denied());
        }
        r.status = "running";
        (
            r.request.clone(),
            r.cancel.clone(),
            r.client.clone(),
            (input.epoch, input.revision),
        )
    };
    let worker_app = app.clone();
    let worker_id = id.clone();
    let start_cancel = cancel.clone();
    let spawn = std::thread::Builder::new()
        .name("heavenkey-transfer".into())
        .spawn(move || {
            let _permit = permit;
            let authorized = || {
                !cancel.load(Ordering::SeqCst)
                    && broker::transfer_owner(&worker_app).is_ok_and(|v| v == identity)
                    && broker::transfer_client_alive(&worker_app, &client)
                    && worker_app.transfer.state.lock().is_ok_and(|s| {
                        s.requests.get(&worker_id).is_some_and(|r| {
                            r.client == client
                                && r.status == "running"
                                && !r.cancel.load(Ordering::SeqCst)
                        })
                    })
            };
            let result = protocol::execute(&payload.profile, &r, cancel.clone(), authorized);
            let live = authorized();
            if let Ok(mut s) = worker_app.transfer.state.lock() {
                if let Some(pending) = s.requests.get_mut(&worker_id) {
                    pending.request.content = None;
                    if !live {
                        pending.status = "denied";
                        pending.result = None;
                        pending.error = None;
                    } else {
                        match result {
                            Ok(value) => {
                                pending.status = "completed";
                                pending.result = Some(value);
                            }
                            Err(code) => {
                                pending.status = "failed";
                                pending.error = Some(code);
                            }
                        }
                    }
                }
                s.audit(
                    "execute",
                    &worker_id,
                    if live { "finished" } else { "revoked" },
                );
            }
        });
    if spawn.is_err() {
        start_cancel.store(true, Ordering::SeqCst);
        let mut s = app.transfer.state(&app)?;
        if let Some(r) = s.requests.get_mut(&id) {
            r.status = "failed";
            r.error = Some("transfer_start_failed");
        }
        return Err(busy());
    }
    Ok(Json(json!({"request_id":id,"status":"running"})))
}
async fn revoke(
    State(app): State<VaultApp>,
    h: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let mut s = app.transfer.state.lock().map_err(internal)?;
    if let Some(mut r) = s.requests.remove(&id) {
        r.cancel.store(true, Ordering::SeqCst);
        r.result = None;
    }
    s.audit("revoke", &id, "denied");
    Ok(Json(json!({"revoked":true})))
}
async fn lock(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(_): Json<Empty>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    app.transfer.invalidate();
    Ok(Json(json!({"locked":true})))
}
pub fn routes() -> Router<VaultApp> {
    Router::new()
        .route("/api/transfer-broker", get(status))
        .route("/api/transfer-broker/agent/request", post(request))
        .route("/api/transfer-broker/agent/status", post(agent_status))
        .route("/api/transfer-broker/approve/{id}", post(approve))
        .route(
            "/api/transfer-broker/requests/{id}",
            axum::routing::delete(revoke),
        )
        .route("/api/transfer-broker/lock", post(lock))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transfer_paths_reject_traversal_and_command_injection() {
        for p in [
            "/etc/passwd",
            "../x",
            "x/../y",
            "./x",
            "x//y",
            "x\\y",
            "x\r\nDELE x",
            "x/",
        ] {
            assert!(!relative_path(p, false), "{p:?}");
        }
        assert!(relative_path("folder/file.txt", false));
        assert!(relative_path("", true));
        assert!(!relative_path("", false));
    }
    #[test]
    fn transfer_request_digest_binds_upload_and_forbids_unexpected_fields() {
        let id = Uuid::new_v4().to_string();
        let mut r:TransferRequest=serde_json::from_value(json!({"connection_id":id,"operation":"put","path":"file","content":"eA","sha256":format!("{:x}",sha2::Sha256::digest(b"x"))})).unwrap();
        assert!(r.valid());
        r.content = Some("eQ".into());
        assert!(!r.valid());
        assert!(
            serde_json::from_value::<TransferRequest>(
                json!({"connection_id":id,"operation":"get","path":"file","host":"evil"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<RequestId>(json!({"request_id":"x","password":"secret"}))
                .is_err()
        );
    }
    #[test]
    fn transfer_revocation_drops_results_and_cancels_active_work() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut s = Inner::default();
        s.requests.insert(
            "x".into(),
            Pending {
                id: "x".into(),
                client: "a".into(),
                label: "test".into(),
                request: TransferRequest {
                    connection_id: Uuid::new_v4().to_string(),
                    operation: "get".into(),
                    path: "x".into(),
                    content: None,
                    sha256: None,
                },
                status: "completed",
                expires: Instant::now() + Duration::from_secs(30),
                expires_at: 0,
                bytes: 0,
                cancel: cancel.clone(),
                result: Some(json!({"content":"synthetic"})),
                error: None,
            },
        );
        s.invalidate();
        assert!(cancel.load(Ordering::SeqCst));
        assert!(s.requests["x"].result.is_none());
        assert_eq!(s.requests["x"].status, "denied");
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;
    use openssl::{encrypt::Encrypter, symm::encrypt_aead};
    fn seal(b: &TransferBroker, id: &str, epoch: u64, revision: u64, payload: &Value) -> Sealed {
        let key = Zeroizing::new([7u8; 32]);
        let iv = [9u8; 12];
        let mut tag = [0u8; 16];
        let aad = format!("HeavenKey transfer v1\0{id}\0{epoch}\0{revision}");
        let mut ciphertext = encrypt_aead(
            Cipher::aes_256_gcm(),
            &*key,
            Some(&iv),
            aad.as_bytes(),
            &serde_json::to_vec(payload).unwrap(),
            &mut tag,
        )
        .unwrap();
        ciphertext.extend_from_slice(&tag);
        let mut enc = Encrypter::new(b.key().unwrap()).unwrap();
        enc.set_rsa_padding(Padding::PKCS1_OAEP).unwrap();
        enc.set_rsa_oaep_md(MessageDigest::sha256()).unwrap();
        enc.set_rsa_mgf1_md(MessageDigest::sha256()).unwrap();
        let mut wrapped = vec![0; 384];
        enc.encrypt(&*key, &mut wrapped).unwrap();
        Sealed {
            key: URL_SAFE_NO_PAD.encode(wrapped),
            iv: URL_SAFE_NO_PAD.encode(iv),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        }
    }
    #[test]
    fn transfer_approval_is_bound_to_request_epoch_revision_and_known_profile_fields() {
        let b = TransferBroker::new();
        let id = Uuid::new_v4().to_string();
        let mut payload = json!({"version":1,"profile":{"id":Uuid::new_v4().to_string(),"label":"synthetic","provider":"custom","protocol":"ftpes","host":"example.com","port":21,"username":"synthetic","root":"/","host_key":"","password":"synthetic","private_key":"","public_key":""},"operation":"stat","path":"file","sha256":null,"disclose_content":false});
        let sealed = seal(&b, &id, 4, 12, &payload);
        assert!(b.unseal(&id, 4, 12, &sealed).is_ok());
        assert!(b.unseal("other", 4, 12, &sealed).is_err());
        assert!(b.unseal(&id, 5, 12, &sealed).is_err());
        assert!(b.unseal(&id, 4, 13, &sealed).is_err());
        payload["profile"]["command"] = json!("rm");
        let sealed = seal(&b, &id, 4, 12, &payload);
        assert!(b.unseal(&id, 4, 12, &sealed).is_err());
        payload["profile"]
            .as_object_mut()
            .unwrap()
            .remove("command");
        payload["profile"]["ca_certificate"] =
            json!("-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----");
        let sealed = seal(&b, &id, 4, 12, &payload);
        assert!(b.unseal(&id, 4, 12, &sealed).is_err());
    }
}

#[cfg(test)]
mod review_regressions {
    use super::*;
    #[test]
    fn transfer_rejects_profile_subroots_for_both_protocols() {
        for protocol in ["sftp", "ftpes"] {
            let pin = format!(
                "SHA256:{}",
                base64::engine::general_purpose::STANDARD_NO_PAD.encode([0; 32])
            );
            let value = json!({"id":Uuid::new_v4().to_string(),"label":"synthetic","provider":"custom","protocol":protocol,"host":"localhost","port":2222,"username":"synthetic","root":"/","host_key":if protocol=="sftp" {pin}else{String::new()},"password":"synthetic","private_key":"","public_key":""});
            let mut profile: TransferProfile = serde_json::from_value(value).unwrap();
            assert!(profile.valid());
            for root in ["/allowed", "/allowed/", "//", "", "../"] {
                profile.root = root.into();
                assert!(!profile.valid(), "{protocol} accepted {root}");
            }
        }
    }
    #[test]
    fn transfer_worker_permits_survive_revocation_and_request_removal_until_thread_exit() {
        let broker = TransferBroker::new();
        let cancel = Arc::new(AtomicBool::new(false));
        broker.state.lock().unwrap().requests.insert(
            "synthetic".into(),
            Pending {
                id: "synthetic".into(),
                client: "synthetic".into(),
                label: "synthetic".into(),
                request: TransferRequest {
                    connection_id: Uuid::new_v4().to_string(),
                    operation: "list".into(),
                    path: String::new(),
                    content: None,
                    sha256: None,
                },
                status: "running",
                expires: Instant::now() + Duration::from_secs(30),
                expires_at: 0,
                bytes: 0,
                cancel: cancel.clone(),
                result: None,
                error: None,
            },
        );
        let first = Permit::acquire(broker.active.clone(), 2).unwrap();
        let second = Permit::acquire(broker.active.clone(), 2).unwrap();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel::<()>(1);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let _permit = first;
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        broker.invalidate();
        broker.revoke_client("synthetic");
        assert!(cancel.load(Ordering::SeqCst));
        broker.state.lock().unwrap().requests.clear();
        assert_eq!(broker.active.load(Ordering::Acquire), 2);
        assert!(Permit::acquire(broker.active.clone(), 2).is_none());
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(broker.active.load(Ordering::Acquire), 1);
        let replacement = Permit::acquire(broker.active.clone(), 2).unwrap();
        assert!(Permit::acquire(broker.active.clone(), 2).is_none());
        drop(second);
        drop(replacement);
        assert_eq!(broker.active.load(Ordering::Acquire), 0);
    }
}
