use super::browser_executor::{self, BrowserSession, Login};
use super::*;
use openssl::{
    encrypt::Decrypter,
    hash::MessageDigest,
    pkey::{PKey, Private},
    rsa::{Padding, Rsa},
    symm::{Cipher, decrypt_aead},
};
use std::collections::VecDeque;
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use zeroize::{Zeroize, Zeroizing};
mod protected;

const CLIENT_TTL: u64 = 3600;
const SESSION_TTL: u64 = 300;
const OWNER_TTL: Duration = Duration::from_secs(35);
pub struct Broker {
    state: Mutex<Inner>,
    key: OnceLock<Result<PKey<Private>, ()>>,
    active: Arc<AtomicUsize>,
}
struct Active(Arc<AtomicUsize>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
#[derive(Default)]
struct Inner {
    epoch: u64,
    owner: Option<Instant>,
    revision: u64,
    pair: Option<Pairing>,
    protected_pair: bool,
    clients: HashMap<String, Client>,
    requests: HashMap<String, Pending>,
    jobs: HashMap<String, Job>,
    workspaces: HashMap<String, protected::Workspace>,
    audit: VecDeque<Value>,
    failures: Window,
}
#[derive(Clone)]
struct Client {
    protected: bool,
    id: String,
    label: String,
    token: String,
    until: Instant,
    expires: u64,
    budget: Window,
}
struct Pending {
    workspace: Option<String>,
    id: String,
    client: String,
    label: String,
    origin: String,
    status: &'static str,
    until: Instant,
    expires: u64,
    session: Option<String>,
}
struct Job {
    protected: bool,
    id: String,
    client: String,
    label: String,
    origin: String,
    until: Instant,
    expires: u64,
    cancel: Arc<AtomicBool>,
    tx: mpsc::SyncSender<BrowserCommand>,
}
enum BrowserCommand {
    Read(ReadCommand),
    Deliver {
        workspace: String,
        recipient: Zeroizing<String>,
        document: Zeroizing<String>,
    },
}
struct ReadCommand {
    path: String,
    result: mpsc::SyncSender<Result<Value, &'static str>>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn denied() -> ApiError {
    forbidden("broker_denied")
}
fn invalid() -> ApiError {
    ApiError(StatusCode::UNPROCESSABLE_ENTITY, "invalid_broker_request")
}
fn busy() -> ApiError {
    ApiError(StatusCode::CONFLICT, "broker_busy")
}
fn label(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= 48 && !s.chars().any(char::is_control)
}
fn canonical_origin(s: &str) -> bool {
    Url::parse(s).is_ok_and(|u| {
        u.origin().ascii_serialization() == s
            && u.username().is_empty()
            && u.password().is_none()
            && (u.scheme() == "https"
                || (u.scheme() == "http" && u.host_str() == Some("localhost")))
    })
}
fn agent_route(path: &str) -> bool {
    matches!(
        path,
        "/api/password-broker/agent/connect"
            | "/api/password-broker/agent/request"
            | "/api/password-broker/agent/status"
            | "/api/password-broker/agent/read"
            | "/api/password-broker/agent/close"
            | "/api/password-broker/agent/disconnect"
            | "/api/password-broker/agent/protected-list"
            | "/api/password-broker/agent/protected-login"
            | "/api/password-broker/agent/protected-draft"
            | "/api/password-broker/agent/protected-close"
    )
}
pub(super) fn agent_transport(headers: &HeaderMap, path: &str) -> bool {
    agent_route(path)
        && !headers.contains_key("origin")
        && headers
            .get("x-heavenkey-client")
            .and_then(|v| v.to_str().ok())
            == Some("password-agent")
}
#[derive(Clone)]
struct Window {
    start: Instant,
    used: u16,
}
impl Default for Window {
    fn default() -> Self {
        Self {
            start: Instant::now(),
            used: 0,
        }
    }
}
impl Window {
    fn allow(&mut self, limit: u16) -> bool {
        if self.start.elapsed() >= Duration::from_secs(60) {
            self.start = Instant::now();
            self.used = 0;
        }
        if self.used >= limit {
            return false;
        }
        self.used += 1;
        true
    }
}
fn throttled() -> ApiError {
    ApiError(StatusCode::TOO_MANY_REQUESTS, "broker_rate_limited")
}

pub(super) fn transfer_client(app: &VaultApp, headers: &HeaderMap) -> ApiResult<(String, String)> {
    let mut state = app.broker.state(app)?;
    if state.owner.is_none() {
        return Err(denied());
    }
    let client = state.client(headers)?;
    if client.protected {
        return Err(denied());
    }
    Ok((client.id, client.label))
}

pub(super) fn transfer_owner(app: &VaultApp) -> ApiResult<(u64, u64)> {
    let state = app.broker.state(app)?;
    if state.owner.is_none() {
        return Err(denied());
    }
    Ok((state.epoch, state.revision))
}

pub(super) fn transfer_client_alive(app: &VaultApp, id: &str) -> bool {
    app.broker.state(app).is_ok_and(|state| {
        state.owner.is_some() && state.clients.get(id).is_some_and(|c| !c.protected)
    })
}
impl Inner {
    fn revoke_client(&mut self, id: &str) {
        self.workspaces
            .retain(|_, workspace| workspace.client != id);
        self.clients.remove(id);
        self.jobs.retain(|_, job| {
            if job.client == id {
                job.cancel.store(true, Ordering::SeqCst);
                false
            } else {
                true
            }
        });
        for request in self
            .requests
            .values_mut()
            .filter(|request| request.client == id)
        {
            request.status = "denied";
            request.session = None;
        }
    }
    fn audit(&mut self, action: &str, result: &str, id: &str) {
        self.audit
            .push_back(json!({"at":now(),"action":action,"result":result,"request_id":id}));
        while self.audit.len() > 100 {
            self.audit.pop_front();
        }
    }
    fn invalidate(&mut self) {
        self.owner = None;
        self.pair = None;
        self.workspaces.clear();
        self.epoch = self.epoch.wrapping_add(1);
        for j in self.jobs.values() {
            j.cancel.store(true, Ordering::SeqCst);
        }
        self.jobs.clear();
        for p in self.requests.values_mut() {
            if matches!(p.status, "pending" | "running" | "ready") {
                p.status = "denied";
                p.session = None;
            }
        }
    }
    fn sweep(&mut self, revision: u64) {
        let t = Instant::now();
        if self.revision != revision || self.owner.is_some_and(|v| t.duration_since(v) >= OWNER_TTL)
        {
            self.invalidate();
        }
        self.revision = revision;
        self.clients.retain(|_, c| c.until > t);
        self.jobs.retain(|_, j| {
            let keep = j.until > t
                && !j.cancel.load(Ordering::SeqCst)
                && self.clients.contains_key(&j.client);
            if !keep {
                j.cancel.store(true, Ordering::SeqCst);
            }
            keep
        });
        for p in self.requests.values_mut() {
            if p.until <= t
                || !self.clients.contains_key(&p.client)
                || (p.status == "ready"
                    && p.session
                        .as_ref()
                        .is_none_or(|id| !self.jobs.contains_key(id)))
            {
                p.status = "expired";
                p.session = None;
            }
        }
        if self.pair.as_ref().is_some_and(|p| p.expires <= t) {
            self.pair = None;
        }
        self.sweep_workspaces();
    }
    fn client(&mut self, h: &HeaderMap) -> ApiResult<Client> {
        self.authenticate(h, true)
    }
    fn authenticate(&mut self, h: &HeaderMap, charge: bool) -> ApiResult<Client> {
        if !agent_transport(h, "/api/password-broker/agent/request") {
            return Err(denied());
        }
        let token = h
            .get("x-heavenkey-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if let Some(c) = self.clients.values_mut().find(|c| {
            c.token.len() == token.len()
                && openssl::memcmp::eq(c.token.as_bytes(), token.as_bytes())
        }) {
            if charge && !c.budget.allow(120) {
                return Err(throttled());
            }
            return Ok(c.clone());
        }
        if self.failures.allow(32) {
            Err(denied())
        } else {
            Err(throttled())
        }
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.invalidate();
    }
}
impl Broker {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(Inner::default()),
            key: OnceLock::new(),
            active: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn key(&self) -> ApiResult<&PKey<Private>> {
        self.key
            .get_or_init(|| Rsa::generate(3072).and_then(PKey::from_rsa).map_err(|_| ()))
            .as_ref()
            .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "broker_key_unavailable"))
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.invalidate();
        }
    }
    pub fn shutdown(&self) {
        self.invalidate();
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.active.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    pub fn supervise(this: &Arc<Self>, db: Arc<Mutex<Connection>>) {
        let weak = Arc::downgrade(this);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let Some(b) = weak.upgrade() else { break };
                let rev = db.lock().ok().and_then(|d| revision(&d).ok());
                if let Ok(mut s) = b.state.lock() {
                    if let Some(rev) = rev {
                        s.sweep(rev)
                    } else {
                        s.invalidate()
                    }
                }
            }
        });
    }
    fn state(&self, app: &VaultApp) -> ApiResult<std::sync::MutexGuard<'_, Inner>> {
        let db = app.db.lock().map_err(internal)?;
        let rev = revision(&db)?;
        drop(db);
        let mut s = self.state.lock().map_err(internal)?;
        s.sweep(rev);
        Ok(s)
    }
    fn unseal_bytes(&self, aad: &[u8], sealed: &Sealed) -> ApiResult<Zeroizing<Vec<u8>>> {
        if !decoded(&sealed.key, 384, 384)
            || !decoded(&sealed.iv, 12, 12)
            || !decoded(&sealed.ciphertext, 17, 100_000)
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
        let n = dec.decrypt(&wrapped, &mut key).map_err(|_| invalid())?;
        if n != 32 {
            return Err(invalid());
        }
        let iv = URL_SAFE_NO_PAD.decode(&sealed.iv).map_err(|_| invalid())?;
        let cipher = URL_SAFE_NO_PAD
            .decode(&sealed.ciphertext)
            .map_err(|_| invalid())?;
        let split = cipher.len() - 16;
        Ok(Zeroizing::new(
            decrypt_aead(
                Cipher::aes_256_gcm(),
                &key[..32],
                Some(&iv),
                aad,
                &cipher[..split],
                &cipher[split..],
            )
            .map_err(|_| invalid())?,
        ))
    }
    fn unseal(&self, id: &str, epoch: u64, rev: u64, sealed: &Sealed) -> ApiResult<Login> {
        if !decoded(&sealed.ciphertext, 17, 16384) {
            return Err(invalid());
        }
        let aad = format!("HeavenKey broker v1\0{id}\0{epoch}\0{rev}");
        let plain = self.unseal_bytes(aad.as_bytes(), sealed)?;
        let mut p: Payload = serde_json::from_slice(&plain).map_err(|_| invalid())?;
        if p.version != 1
            || p.url.len() > 2048
            || p.username.len() > 1024
            || p.password.is_empty()
            || p.password.len() > 1024
            || p.otp
                .as_ref()
                .is_some_and(|v| v.len() > 16 || !v.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(invalid());
        }
        Ok(Login {
            url: std::mem::take(&mut p.url),
            username: Zeroizing::new(std::mem::take(&mut p.username)),
            password: Zeroizing::new(std::mem::take(&mut p.password)),
            otp: p.otp.take().map(Zeroizing::new),
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Epoch {
    epoch: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Connect {
    code: String,
    label: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ask {
    origin: String,
    scope: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestId {
    request_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionId {
    session_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    session_id: String,
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    epoch: u64,
    revision: u64,
    source_id: String,
    sealed: Sealed,
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
struct Payload {
    version: u8,
    url: String,
    username: String,
    password: String,
    otp: Option<String>,
}
impl Drop for Payload {
    fn drop(&mut self) {
        self.username.zeroize();
        self.password.zeroize();
        if let Some(v) = self.otp.as_mut() {
            v.zeroize();
        }
    }
}
async fn status(State(app): State<VaultApp>, h: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let key = URL_SAFE_NO_PAD.encode(app.broker.key()?.public_key_to_der().map_err(internal)?);
    let s = app.broker.state(&app)?;
    Ok(Json(
        json!({"version":1,"enabled":true,"unlocked":s.owner.is_some(),"epoch":s.epoch,"public_key":key,"browser_available":browser_executor::available(),"process_protection":uac_browser_pipe::process_protection(),"limits":{"session_seconds":SESSION_TTL,"client_operations_per_minute":120,"invalid_tokens_per_minute":32},"clients":s.clients.values().map(|c|json!({"id":c.id,"label":c.label,"expires_at":c.expires,"protected":c.protected})).collect::<Vec<_>>(),"requests":s.requests.values().filter(|p| p.workspace.as_ref().is_none_or(|id| s.workspaces.get(id).is_some_and(|w| w.live(&s)))).map(|p|json!({"id":p.id,"client_id":p.client,"label":p.label,"origin":p.origin,"scope":if p.workspace.is_some(){"protected"}else{"login_read"},"source_id":p.workspace.as_ref().and_then(|id| s.workspaces.get(id)).map(|w| &w.source),"status":p.status,"expires_at":p.expires})).collect::<Vec<_>>(),"sessions":s.jobs.values().map(|j|json!({"id":j.id,"client_id":j.client,"label":j.label,"origin":j.origin,"expires_at":j.expires})).collect::<Vec<_>>(),"audit":s.audit}),
    ))
}
async fn unlock(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(_): Json<Empty>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let mut s = app.broker.state(&app)?;
    s.invalidate();
    s.owner = Some(Instant::now());
    s.audit("unlock", "ok", "");
    Ok(Json(json!({"epoch":s.epoch})))
}
async fn heartbeat(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<Epoch>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let mut s = app.broker.state(&app)?;
    if s.owner.is_none() || s.epoch != input.epoch {
        return Err(denied());
    }
    s.owner = Some(Instant::now());
    Ok(Json(json!({"ok":true})))
}
async fn lock(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(_): Json<Empty>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    app.broker.invalidate();
    app.transfer.invalidate();
    Ok(Json(json!({"locked":true})))
}
async fn pairing(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(_): Json<Empty>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let mut s = app.broker.state(&app)?;
    if s.owner.is_none() {
        return Err(denied());
    }
    let code = random_secret();
    s.pair = Some(Pairing {
        code: code.clone(),
        expires: Instant::now() + PAIRING_TTL,
        attempts: 0,
    });
    s.protected_pair = false;
    Ok(Json(json!({"code":code,"expires_in":120})))
}
async fn connect(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<Connect>,
) -> ApiResult<Json<Value>> {
    if !agent_transport(&h, "/api/password-broker/agent/connect")
        || !label(&input.label)
        || input.code.len() > 128
    {
        return Err(denied());
    }
    let mut s = app.broker.state(&app)?;
    if s.owner.is_none() {
        return Err(denied());
    }
    let pair = s.pair.as_mut().ok_or_else(denied)?;
    if pair.code.len() != input.code.len()
        || !openssl::memcmp::eq(pair.code.as_bytes(), input.code.as_bytes())
    {
        pair.attempts += 1;
        if pair.attempts >= 8 {
            s.pair = None;
        }
        return Err(denied());
    }
    let protected = s.protected_pair;
    s.pair = None;
    if s.clients.len() >= 8 {
        return Err(busy());
    }
    let c = Client {
        protected,
        id: Uuid::new_v4().to_string(),
        label: input.label,
        token: random_secret(),
        until: Instant::now() + Duration::from_secs(CLIENT_TTL),
        expires: now() + CLIENT_TTL,
        budget: Window::default(),
    };
    let output =
        json!({"client_id":c.id,"token":c.token,"expires_in":CLIENT_TTL,"protected":c.protected});
    s.audit("connect", "ok", &c.id);
    s.clients.insert(c.id.clone(), c);
    Ok(Json(output))
}
async fn request(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<Ask>,
) -> ApiResult<Json<Value>> {
    if input.scope != "login_read" || !canonical_origin(&input.origin) {
        return Err(invalid());
    }
    let mut s = app.broker.state(&app)?;
    let c = s.client(&h)?;
    if s.owner.is_none() || c.protected {
        return Err(denied());
    }
    if s.requests
        .values()
        .filter(|p| matches!(p.status, "pending" | "running"))
        .count()
        >= 8
    {
        return Err(busy());
    }
    if s.requests.len() >= 32 {
        s.requests.retain(|_, p| {
            p.workspace.is_some() || matches!(p.status, "pending" | "running" | "ready")
        });
    }
    let id = Uuid::new_v4().to_string();
    let expires = now() + 120;
    s.requests.insert(
        id.clone(),
        Pending {
            workspace: None,
            id: id.clone(),
            client: c.id,
            label: c.label,
            origin: input.origin,
            status: "pending",
            until: Instant::now() + Duration::from_secs(120),
            expires,
            session: None,
        },
    );
    s.audit("request", "pending", &id);
    Ok(Json(
        json!({"request_id":id,"status":"pending","expires_at":expires}),
    ))
}
async fn agent_status(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<RequestId>,
) -> ApiResult<Json<Value>> {
    let mut s = app.broker.state(&app)?;
    let c = s.client(&h)?;
    let p = s
        .requests
        .get(&input.request_id)
        .filter(|p| p.client == c.id)
        .ok_or_else(denied)?;
    let out = if let Some(workspace) = &p.workspace {
        let status = s.workspaces.get(workspace).map_or("closed", |w| {
            if !w.live(&s) {
                if w.status(&s) == "closed" {
                    "closed"
                } else {
                    "expired"
                }
            } else if w.approved {
                "approved"
            } else {
                "pending"
            }
        });
        json!({"status":status})
    } else {
        json!({"status":p.status,"session_id":p.session})
    };
    s.audit("status", "ok", &input.request_id);
    Ok(Json(out))
}
async fn approve(
    State(app): State<VaultApp>,
    h: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<Approval>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    if input.source_id.is_empty() || input.source_id.len() > 200 {
        return Err(invalid());
    }
    let (origin, client, label, cancel, sid, rx, protected) = {
        let mut s = app.broker.state(&app)?;
        if s.owner.is_none()
            || s.epoch != input.epoch
            || s.revision != input.revision
            || s.jobs.len() >= 2
            || app.broker.active.load(Ordering::SeqCst) >= 2
        {
            return Err(denied());
        }
        let p = s
            .requests
            .get(&id)
            .filter(|p| p.status == "pending" && p.until > Instant::now())
            .ok_or_else(denied)?;
        if let Some(workspace) = &p.workspace {
            let w = s
                .workspaces
                .get(workspace)
                .filter(|w| w.live(&s))
                .ok_or_else(denied)?;
            if w.source != input.source_id || w.origin != p.origin || w.client != p.client {
                return Err(denied());
            }
        }
        let protected = p.workspace.is_some();
        let (origin, client, label) = (p.origin.clone(), p.client.clone(), p.label.clone());
        let cancel = Arc::new(AtomicBool::new(false));
        let sid = Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::sync_channel(2);
        s.jobs.insert(
            sid.clone(),
            Job {
                protected,
                id: sid.clone(),
                client: client.clone(),
                label: label.clone(),
                origin: origin.clone(),
                until: Instant::now() + Duration::from_secs(SESSION_TTL),
                expires: now() + SESSION_TTL,
                cancel: cancel.clone(),
                tx,
            },
        );
        let p = s.requests.get_mut(&id).ok_or_else(denied)?;
        p.status = "running";
        p.until = Instant::now() + Duration::from_secs(SESSION_TTL);
        p.expires = now() + SESSION_TTL;
        p.session = Some(sid.clone());
        s.audit("approve", "running", &id);
        (origin, client, label, cancel, sid, rx, protected)
    };
    let login = match app
        .broker
        .unseal(&id, input.epoch, input.revision, &input.sealed)
    {
        Ok(v) => v,
        Err(e) => {
            cancel.store(true, Ordering::SeqCst);
            if let Ok(mut s) = app.broker.state.lock() {
                s.jobs.remove(&sid);
                if let Some(p) = s.requests.get_mut(&id) {
                    p.status = "failed";
                    p.session = None;
                }
            }
            return Err(e);
        }
    };
    if !Url::parse(&login.url).is_ok_and(|u| {
        u.origin().ascii_serialization() == origin
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
    }) {
        cancel.store(true, Ordering::SeqCst);
        let mut state = app.broker.state.lock().map_err(internal)?;
        state.jobs.remove(&sid);
        if let Some(p) = state.requests.get_mut(&id) {
            p.status = "failed";
            p.session = None;
        }
        return Err(invalid());
    }
    {
        let mut s = app.broker.state(&app)?;
        if s.owner.is_none()
            || s.epoch != input.epoch
            || s.revision != input.revision
            || !s.jobs.contains_key(&sid)
        {
            cancel.store(true, Ordering::SeqCst);
            return Err(denied());
        }
        let workspace = s.requests.get(&id).and_then(|p| p.workspace.clone());
        if let Some(w) = workspace.and_then(|id| s.workspaces.get_mut(&id)) {
            w.approved = true;
        }
        app.broker.active.fetch_add(1, Ordering::SeqCst);
    }
    let active = Active(app.broker.active.clone());
    let spawn_cancel = cancel.clone();
    let weak = Arc::downgrade(&app.broker);
    let spawned = std::thread::Builder::new()
        .name("broker-session".into())
        .spawn(move || {
            let _active = active;
            let _identity = (client, label);
            let deadline = Instant::now() + Duration::from_secs(SESSION_TTL);
            let started = BrowserSession::start(login, cancel.clone());
            let Ok(mut browser) = started else {
                if let Some(b) = weak.upgrade()
                    && let Ok(mut s) = b.state.lock()
                {
                    s.jobs.remove(&sid);
                    if let Some(p) = s.requests.get_mut(&id) {
                        p.status = "failed";
                        p.session = None;
                    }
                    s.audit("login", "failed", &id);
                }
                return;
            };
            if let Some(b) = weak.upgrade()
                && let Ok(mut s) = b.state.lock()
            {
                let owner = s.owner.is_some();
                if let Some(p) = s.requests.get_mut(&id) {
                    if !cancel.load(Ordering::SeqCst) && owner {
                        p.status = "ready";
                    } else {
                        cancel.store(true, Ordering::SeqCst);
                    }
                }
                s.audit("login", "ready", &id);
            }
            while !cancel.load(Ordering::SeqCst) && Instant::now() < deadline {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(BrowserCommand::Read(cmd)) => {
                        let result = if protected {
                            Err("broker_denied")
                        } else {
                            browser.read(&cmd.path)
                        };
                        if result.is_err() {
                            cancel.store(true, Ordering::SeqCst);
                        }
                        let _ = cmd.result.send(result);
                    }
                    Ok(BrowserCommand::Deliver {
                        workspace,
                        recipient,
                        document,
                    }) => {
                        let outcome = if protected {
                            browser.deliver(&recipient, &document)
                        } else {
                            "failed"
                        };
                        if let Some(b) = weak.upgrade()
                            && let Ok(mut s) = b.state.lock()
                            && let Some(w) = s.workspaces.get_mut(&workspace)
                        {
                            w.set_delivery(outcome);
                        }
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => break,
                }
            }
            drop(browser);
            if let Some(b) = weak.upgrade()
                && let Ok(mut s) = b.state.lock()
            {
                s.jobs.remove(&sid);
                let workspace = s.requests.get(&id).and_then(|p| p.workspace.clone());
                if let Some(w) = workspace.and_then(|id| s.workspaces.get_mut(&id)) {
                    w.set_delivery("unknown");
                }
                if let Some(p) = s.requests.get_mut(&id) {
                    p.status = "expired";
                    p.session = None;
                }
                s.audit("session", "closed", &id);
            }
        });
    if spawned.is_err() {
        spawn_cancel.store(true, Ordering::SeqCst);
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "broker_start_failed",
        ));
    }
    Ok(Json(json!({"status":"running"})))
}
async fn read_page(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<Read>,
) -> ApiResult<Json<Value>> {
    if input.path.len() > 1024
        || !input.path.starts_with('/')
        || input.path.starts_with("//")
        || input
            .path
            .chars()
            .any(|c| c.is_control() || matches!(c, '?' | '#' | '\\'))
    {
        return Err(invalid());
    }
    let (rx, cancel) = {
        let mut s = app.broker.state(&app)?;
        let c = s.client(&h)?;
        if s.owner.is_none() || c.protected {
            return Err(denied());
        }
        let j = s
            .jobs
            .get(&input.session_id)
            .filter(|j| j.client == c.id && !j.protected)
            .ok_or_else(denied)?;
        let (tx, rx) = mpsc::sync_channel(1);
        j.tx.try_send(BrowserCommand::Read(ReadCommand {
            path: input.path,
            result: tx,
        }))
        .map_err(|_| busy())?;
        (rx, j.cancel.clone())
    };
    let result =
        match tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(15))).await {
            Ok(Ok(Ok(value))) => value,
            _ => {
                cancel.store(true, Ordering::SeqCst);
                return Err(ApiError(StatusCode::BAD_GATEWAY, "broker_read_failed"));
            }
        };
    if cancel.load(Ordering::SeqCst) {
        return Err(denied());
    }
    let mut s = app.broker.state(&app)?;
    let c = s.authenticate(&h, false)?;
    if s.owner.is_none()
        || !s
            .jobs
            .get(&input.session_id)
            .is_some_and(|j| j.client == c.id && !j.protected)
    {
        return Err(denied());
    }
    Ok(Json(result))
}
async fn close(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<SessionId>,
) -> ApiResult<Json<Value>> {
    let mut s = app.broker.state(&app)?;
    let c = s.authenticate(&h, false)?;
    if c.protected {
        return Err(denied());
    }
    if s.jobs
        .get(&input.session_id)
        .is_some_and(|j| j.client == c.id && !j.protected)
    {
        if let Some(j) = s.jobs.remove(&input.session_id) {
            j.cancel.store(true, Ordering::SeqCst);
        }
    } else {
        return Err(denied());
    }
    s.audit("close", "ok", &input.session_id);
    Ok(Json(json!({"closed":true})))
}
async fn disconnect(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(_): Json<Empty>,
) -> ApiResult<Json<Value>> {
    let mut s = app.broker.state(&app)?;
    let client = s.authenticate(&h, false)?;
    s.revoke_client(&client.id);
    s.audit("disconnect", "ok", &client.id);
    drop(s);
    app.transfer.revoke_client(&client.id);
    Ok(Json(json!({"disconnected":true})))
}
async fn revoke(
    State(app): State<VaultApp>,
    h: HeaderMap,
    axum::extract::Path((kind, id)): axum::extract::Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let mut s = app.broker.state(&app)?;
    match kind.as_str() {
        "clients" => {
            s.revoke_client(&id);
        }
        "sessions" => {
            if let Some(j) = s.jobs.remove(&id) {
                j.cancel.store(true, Ordering::SeqCst);
            }
        }
        "requests" => {
            let session = s.requests.get_mut(&id).and_then(|p| {
                p.status = "denied";
                p.session.take()
            });
            if let Some(sid) = session
                && let Some(j) = s.jobs.remove(&sid)
            {
                j.cancel.store(true, Ordering::SeqCst);
            }
        }
        _ => return Err(invalid()),
    }
    s.audit("revoke", "ok", &id);
    drop(s);
    if kind == "clients" {
        app.transfer.revoke_client(&id);
    }
    Ok(Json(json!({"revoked":true})))
}
pub fn routes() -> Router<VaultApp> {
    Router::new()
        .merge(protected::routes())
        .route("/api/password-broker", get(status))
        .route("/api/password-broker/unlock", post(unlock))
        .route("/api/password-broker/heartbeat", post(heartbeat))
        .route("/api/password-broker/lock", post(lock))
        .route("/api/password-broker/pairing", post(pairing))
        .route("/api/password-broker/approve/{id}", post(approve))
        .route(
            "/api/password-broker/{kind}/{id}",
            axum::routing::delete(revoke),
        )
        .route("/api/password-broker/agent/connect", post(connect))
        .route("/api/password-broker/agent/request", post(request))
        .route("/api/password-broker/agent/status", post(agent_status))
        .route("/api/password-broker/agent/read", post(read_page))
        .route("/api/password-broker/agent/close", post(close))
        .route("/api/password-broker/agent/disconnect", post(disconnect))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openssl::{encrypt::Encrypter, symm::encrypt_aead};
    pub(super) fn app() -> VaultApp {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE password_manager(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,record TEXT NOT NULL); INSERT INTO password_manager VALUES(1,1,'{}');").unwrap();
        VaultApp {
            mobile: Arc::new(mobile_sync::MobileSync::default()),
            db: Arc::new(Mutex::new(db)),
            origin: "http://localhost:18268".into(),
            host: "localhost:18268".into(),
            token: "owner-only-synthetic".into(),
            extensions: Arc::new(Mutex::new(Extensions::default())),
            access: Arc::new(access::Access::new(18268, None).unwrap()),
            broker: Arc::new(Broker::new()),
            transfer: Arc::new(super::transfer::TransferBroker::new()),
        }
    }
    pub(super) fn owner(a: &VaultApp) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in [
            ("host", a.host.as_str()),
            ("origin", a.origin.as_str()),
            ("x-heavenkey-client", "password-manager"),
            ("x-heavenkey-token", &a.token),
        ] {
            h.insert(k, v.parse().unwrap());
        }
        h
    }
    pub(super) fn agent(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-heavenkey-client", "password-agent".parse().unwrap());
        h.insert("x-heavenkey-token", token.parse().unwrap());
        h
    }
    async fn paired(a: &VaultApp) -> HeaderMap {
        let _ = unlock(State(a.clone()), owner(a), Json(Empty {}))
            .await
            .unwrap();
        let Json(p) = pairing(State(a.clone()), owner(a), Json(Empty {}))
            .await
            .unwrap();
        let Json(c) = connect(
            State(a.clone()),
            agent(""),
            Json(Connect {
                code: p["code"].as_str().unwrap().into(),
                label: "Test agent".into(),
            }),
        )
        .await
        .unwrap();
        agent(c["token"].as_str().unwrap())
    }
    fn sealed(b: &Broker, id: &str, epoch: u64, rev: u64) -> Sealed {
        let key = [42; 32];
        let iv = [11; 12];
        let mut tag = [0; 16];
        let aad = format!("HeavenKey broker v1\0{id}\0{epoch}\0{rev}");
        let plain=br#"{"version":1,"url":"https://example.com/login","username":"synthetic-user","password":"synthetic-password"}"#;
        let mut cipher = encrypt_aead(
            Cipher::aes_256_gcm(),
            &key,
            Some(&iv),
            aad.as_bytes(),
            plain,
            &mut tag,
        )
        .unwrap();
        cipher.extend_from_slice(&tag);
        let mut enc = Encrypter::new(b.key().unwrap()).unwrap();
        enc.set_rsa_padding(Padding::PKCS1_OAEP).unwrap();
        enc.set_rsa_oaep_md(MessageDigest::sha256()).unwrap();
        enc.set_rsa_mgf1_md(MessageDigest::sha256()).unwrap();
        let mut wrapped = vec![0; 384];
        let n = enc.encrypt(&key, &mut wrapped).unwrap();
        wrapped.truncate(n);
        Sealed {
            key: URL_SAFE_NO_PAD.encode(wrapped),
            iv: URL_SAFE_NO_PAD.encode(iv),
            ciphertext: URL_SAFE_NO_PAD.encode(cipher),
        }
    }
    #[test]
    fn transport_has_no_browser_origin_or_raw_api() {
        let mut h = agent("x");
        assert!(agent_transport(&h, "/api/password-broker/agent/read"));
        assert!(!agent_transport(&h, "/api/password-vault"));
        h.insert("origin", "http://localhost:18268".parse().unwrap());
        assert!(!agent_transport(&h, "/api/password-broker/agent/read"));
    }
    #[test]
    fn protected_transport_is_explicit_and_does_not_allow_arbitrary_actions() {
        let h = agent("x");
        for action in [
            "protected-list",
            "protected-login",
            "protected-draft",
            "protected-close",
        ] {
            assert!(agent_transport(
                &h,
                &format!("/api/password-broker/agent/{action}")
            ));
        }
        for action in ["decrypt", "unmask", "screenshot", "cookies", "storageState"] {
            assert!(!agent_transport(
                &h,
                &format!("/api/password-broker/agent/{action}")
            ));
        }
    }
    #[test]
    fn origins_are_exact_secure_and_no_credentials() {
        for good in ["https://example.com", "http://localhost:18269"] {
            assert!(canonical_origin(good));
        }
        for bad in [
            "https://example.com/",
            "https://user@example.com",
            "https://example.com?x=1",
            "http://example.com",
            "file:///tmp/a",
            "https://example.com/path",
            "https://example.com#x",
        ] {
            assert!(!canonical_origin(bad), "{bad}");
        }
    }
    #[test]
    fn encrypted_handoff_is_bound_to_request_epoch_and_revision() {
        let b = Broker::new();
        let s = sealed(&b, "request", 3, 4);
        assert_eq!(
            b.unseal("request", 3, 4, &s).unwrap().password.as_str(),
            "synthetic-password"
        );
        assert!(b.unseal("other", 3, 4, &s).is_err());
        assert!(b.unseal("request", 4, 4, &s).is_err());
        assert!(b.unseal("request", 3, 5, &s).is_err());
        let mut tampered = s;
        tampered.ciphertext.replace_range(0..1, "A");
        assert!(b.unseal("request", 3, 4, &tampered).is_err());
    }
    #[tokio::test]
    async fn pairing_is_single_use_and_eight_failures_destroy_it() {
        let a = app();
        paired(&a).await;
        let Json(p) = pairing(State(a.clone()), owner(&a), Json(Empty {}))
            .await
            .unwrap();
        let code = p["code"].as_str().unwrap().to_owned();
        for _ in 0..8 {
            assert!(
                connect(
                    State(a.clone()),
                    agent(""),
                    Json(Connect {
                        code: "wrong".into(),
                        label: "a".into()
                    })
                )
                .await
                .is_err()
            );
        }
        assert!(
            connect(
                State(a.clone()),
                agent(""),
                Json(Connect {
                    code,
                    label: "a".into()
                })
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn owner_and_agent_capabilities_are_separate() {
        let a = app();
        let h = paired(&a).await;
        assert!(status(State(a.clone()), h.clone()).await.is_err());
        assert!(
            request(
                State(a.clone()),
                owner(&a),
                Json(Ask {
                    origin: "https://example.com".into(),
                    scope: "login_read".into()
                })
            )
            .await
            .is_err()
        );
        assert!(
            request(
                State(a.clone()),
                h,
                Json(Ask {
                    origin: "https://example.com".into(),
                    scope: "write".into()
                })
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn requests_are_client_scoped_and_bound_to_lock() {
        let a = app();
        let h = paired(&a).await;
        let Json(r) = request(
            State(a.clone()),
            h.clone(),
            Json(Ask {
                origin: "https://example.com".into(),
                scope: "login_read".into(),
            }),
        )
        .await
        .unwrap();
        let id = r["request_id"].as_str().unwrap().to_owned();
        assert!(
            agent_status(
                State(a.clone()),
                agent("different"),
                Json(RequestId {
                    request_id: id.clone()
                })
            )
            .await
            .is_err()
        );
        a.broker.invalidate();
        let Json(status) = agent_status(
            State(a.clone()),
            h.clone(),
            Json(RequestId { request_id: id }),
        )
        .await
        .unwrap();
        assert_eq!(status["status"], "denied");
        assert!(
            request(
                State(a),
                h,
                Json(Ask {
                    origin: "https://example.com".into(),
                    scope: "login_read".into()
                })
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn pending_requests_and_audit_are_bounded() {
        let a = app();
        let h = paired(&a).await;
        for _ in 0..8 {
            let _ = request(
                State(a.clone()),
                h.clone(),
                Json(Ask {
                    origin: "https://example.com".into(),
                    scope: "login_read".into(),
                }),
            )
            .await
            .unwrap();
        }
        assert!(
            request(
                State(a.clone()),
                h,
                Json(Ask {
                    origin: "https://example.com".into(),
                    scope: "login_read".into()
                })
            )
            .await
            .is_err()
        );
        let mut s = a.broker.state.lock().unwrap();
        for _ in 0..200 {
            s.audit("metadata", "ok", "");
        }
        assert_eq!(s.audit.len(), 100);
    }
    #[test]
    fn revision_heartbeat_and_restart_invalidate_sessions() {
        let b = Broker::new();
        let mut s = b.state.lock().unwrap();
        s.revision = 1;
        s.owner = Some(Instant::now());
        s.sweep(2);
        assert!(s.owner.is_none());
        s.owner = Some(Instant::now() - OWNER_TTL);
        s.sweep(2);
        assert!(s.owner.is_none());
        assert!(Broker::new().state.lock().unwrap().clients.is_empty());
    }
    #[test]
    fn lock_invalidates_unconsumed_pairing() {
        let b = Broker::new();
        let mut s = b.state.lock().unwrap();
        s.pair = Some(Pairing {
            code: "synthetic".into(),
            expires: Instant::now() + PAIRING_TTL,
            attempts: 0,
        });
        s.invalidate();
        assert!(s.pair.is_none());
    }
    #[test]
    fn unknown_input_fields_are_denied() {
        assert!(serde_json::from_value::<Ask>(json!({"origin":"https://example.com","scope":"login_read","script":"return password"})).is_err());
        assert!(
            serde_json::from_value::<Read>(json!({"session_id":"s","path":"/","cookies":true}))
                .is_err()
        );
    }
    #[test]
    fn expired_session_and_client_cancel_executor_without_waiting() {
        let mut s = Inner::default();
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, _rx) = mpsc::sync_channel(1);
        s.clients.insert(
            "client".into(),
            Client {
                protected: false,
                id: "client".into(),
                label: "synthetic".into(),
                token: "scoped".into(),
                until: Instant::now() + Duration::from_secs(60),
                expires: now() + 60,
                budget: Window::default(),
            },
        );
        s.jobs.insert(
            "session".into(),
            Job {
                protected: false,
                id: "session".into(),
                client: "client".into(),
                label: "synthetic".into(),
                origin: "https://example.com".into(),
                until: Instant::now() - Duration::from_secs(1),
                expires: now() - 1,
                cancel: cancel.clone(),
                tx,
            },
        );
        s.requests.insert(
            "request".into(),
            Pending {
                workspace: None,
                id: "request".into(),
                client: "client".into(),
                label: "synthetic".into(),
                origin: "https://example.com".into(),
                status: "ready",
                until: Instant::now() + Duration::from_secs(60),
                expires: now() + 60,
                session: Some("session".into()),
            },
        );
        s.sweep(0);
        assert!(cancel.load(Ordering::SeqCst));
        assert!(s.jobs.is_empty());
        assert_eq!(s.requests["request"].status, "expired");
        s.clients.get_mut("client").unwrap().until = Instant::now() - Duration::from_secs(1);
        s.sweep(0);
        assert!(s.clients.is_empty());
    }
    #[tokio::test]
    async fn revocation_clears_unobserved_jobs_and_pending_requests_atomically() {
        let a = app();
        let h = paired(&a).await;
        let Json(r) = request(
            State(a.clone()),
            h.clone(),
            Json(Ask {
                origin: "https://example.com".into(),
                scope: "login_read".into(),
            }),
        )
        .await
        .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let client = {
            let mut s = a.broker.state(&a).unwrap();
            let client = s.authenticate(&h, false).unwrap().id;
            let (tx, _rx) = mpsc::sync_channel(1);
            s.jobs.insert(
                "unobserved".into(),
                Job {
                    protected: false,
                    id: "unobserved".into(),
                    client: client.clone(),
                    label: "synthetic".into(),
                    origin: "https://example.com".into(),
                    until: Instant::now() + Duration::from_secs(60),
                    expires: now() + 60,
                    cancel: cancel.clone(),
                    tx,
                },
            );
            client
        };
        let _ = revoke(
            State(a.clone()),
            owner(&a),
            axum::extract::Path(("clients".into(), client.clone())),
        )
        .await
        .unwrap();
        let s = a.broker.state.lock().unwrap();
        assert!(!s.clients.contains_key(&client));
        assert!(
            s.jobs.is_empty(),
            "unobserved browser job survives revocation"
        );
        assert_eq!(
            s.requests[r["request_id"].as_str().unwrap()].status,
            "denied"
        );
        assert!(cancel.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn disconnect_ignores_exhausted_budget_but_requires_scoped_client() {
        let a = app();
        let h = paired(&a).await;
        {
            let mut s = a.broker.state(&a).unwrap();
            let id = s.authenticate(&h, false).unwrap().id;
            s.clients.get_mut(&id).unwrap().budget.used = 120;
        }
        assert!(
            disconnect(State(a.clone()), owner(&a), Json(Empty {}))
                .await
                .is_err()
        );
        assert!(
            disconnect(State(a.clone()), agent("wrong"), Json(Empty {}))
                .await
                .is_err()
        );
        assert!(
            disconnect(State(a.clone()), h.clone(), Json(Empty {}))
                .await
                .is_ok()
        );
        assert!(a.broker.state.lock().unwrap().clients.is_empty());
        assert!(disconnect(State(a), h, Json(Empty {})).await.is_err());
    }
    #[tokio::test]
    async fn invalid_token_bursts_are_throttled_without_blocking_real_owner_or_client() {
        let a = app();
        let valid = paired(&a).await;
        let mut last = None;
        for _ in 0..40 {
            last = Some(
                a.broker
                    .state(&a)
                    .unwrap()
                    .client(&agent("wrong"))
                    .err()
                    .unwrap()
                    .0,
            );
        }
        assert_eq!(last.unwrap(), StatusCode::TOO_MANY_REQUESTS);
        assert!(a.broker.state(&a).unwrap().client(&valid).is_ok());
        assert!(status(State(a.clone()), owner(&a)).await.is_ok());
    }
    #[tokio::test]
    async fn valid_client_operation_flood_has_a_bounded_budget() {
        let a = app();
        let valid = paired(&a).await;
        let mut last = None;
        for _ in 0..140 {
            last = a
                .broker
                .state(&a)
                .unwrap()
                .client(&valid)
                .err()
                .map(|e| e.0);
        }
        assert_eq!(last, Some(StatusCode::TOO_MANY_REQUESTS));
        assert!(
            lock(State(a.clone()), owner(&a), Json(Empty {}))
                .await
                .is_ok()
        );
    }
}
