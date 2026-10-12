use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uac_verifier::{
    Action, Signed,
    delegation::{self, DelegationGrant},
};

const RESOURCE: &str = "urn:uac:lab:document";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn free_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port()
}

fn temp_path(tag: &str) -> std::path::PathBuf {
    let unique = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "uac-gate-test-{}-{tag}-{unique}.json",
        std::process::id()
    ))
}

fn request(port: u16, path: &str, headers: &[(&str, String)]) -> std::io::Result<(u16, String)> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut text =
        format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n");
    for (name, value) in headers {
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    text.push_str("\r\n");
    stream.write_all(text.as_bytes())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    Ok((status, body))
}

struct Gate {
    child: Child,
    port: u16,
}
impl Gate {
    fn spawn(args: &[String]) -> Self {
        let port = free_port();
        let mut full = vec!["--port".to_owned(), port.to_string()];
        full.extend_from_slice(args);
        let child = Command::new(env!("CARGO_BIN_EXE_uac-gate"))
            .args(&full)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn uac-gate");
        Self { child, port }
    }
    fn ready(&self) -> bool {
        request(self.port, "/health", &[])
            .map(|(status, _)| status == 200)
            .unwrap_or(false)
    }
    fn start(args: &[String]) -> Self {
        let gate = Self::spawn(args);
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if gate.ready() {
                return gate;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("uac-gate did not become ready");
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn subject(credential_id: &[u8]) -> [u8; 32] {
    Sha256::digest(credential_id).into()
}

fn next_nonce() -> [u8; 16] {
    (TEMP_COUNTER.fetch_add(1, Ordering::Relaxed) as u128).to_be_bytes()
}

fn grant(
    issuer: &SigningKey,
    delegator: Option<[u8; 32]>,
    audience: [u8; 32],
    parent: Option<&Signed<DelegationGrant>>,
    not_before: u64,
    expires_at: u64,
    remaining_delegations: u8,
) -> Signed<DelegationGrant> {
    delegation::sign(
        issuer,
        DelegationGrant {
            profile: delegation::PROFILE.into(),
            issuer: issuer.verifying_key().to_bytes(),
            delegator,
            audience,
            resource: RESOURCE.into(),
            actions: [Action::Read].into(),
            not_before,
            expires_at,
            remaining_delegations,
            parent: parent.map(|p| delegation::id(p).expect("parent id")),
            nonce: next_nonce(),
        },
    )
    .expect("sign delegation")
}

fn token(signed: &Signed<DelegationGrant>) -> String {
    serde_json::to_string(signed).expect("token JSON")
}

fn chain_for(
    issuer: &SigningKey,
    holder_credential: &[u8],
    not_before: u64,
    expires_at: u64,
) -> Vec<String> {
    let intermediate = subject(b"synthetic-intermediate");
    let root = grant(
        issuer,
        None,
        intermediate,
        None,
        not_before,
        expires_at.saturating_add(60),
        1,
    );
    let leaf = grant(
        issuer,
        Some(intermediate),
        subject(holder_credential),
        Some(&root),
        not_before,
        expires_at,
        0,
    );
    vec![token(&root), token(&leaf)]
}

fn presentation(
    chain: &[String],
    holder_credential: &[u8],
    resource: &str,
    action: &str,
) -> String {
    let document = json!({
        "chain": chain,
        "holder": URL_SAFE_NO_PAD.encode(holder_credential),
        "resource": resource,
        "action": action,
    });
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&document).expect("presentation"))
}

fn snapshot(issuer: &SigningKey, revoked: &[String]) -> String {
    serde_json::to_string(&json!({
        "profile": delegation::PROFILE,
        "issuer": URL_SAFE_NO_PAD.encode(issuer.verifying_key().to_bytes()),
        "revoked": revoked,
        "time": now(),
    }))
    .expect("snapshot JSON")
}

fn write_snapshot(issuer: &SigningKey, revoked: &[String]) -> std::path::PathBuf {
    let path = temp_path("snapshot");
    std::fs::write(&path, snapshot(issuer, revoked)).expect("write snapshot");
    path
}

fn document(port: u16, header: Option<String>) -> (u16, Value) {
    let headers = header
        .map(|value| vec![("X-HeavenKey-Authorization", value)])
        .unwrap_or_default();
    let (status, body) = request(port, "/document", &headers).expect("request");
    (
        status,
        serde_json::from_str(&body).unwrap_or_else(|_| json!({"raw": body})),
    )
}

#[test]
fn valid_chain_and_holder_gets_the_document() {
    let issuer = SigningKey::from_bytes(&[11; 32]);
    let holder = b"synthetic-holder-credential";
    let chain = chain_for(&issuer, holder, now() - 10, now() + 600);
    let path = write_snapshot(&issuer, &[]);
    let _gate = Gate::start(&[
        "--snapshot-file".into(),
        path.to_str().expect("path").into(),
    ]);
    let (status, body) = document(
        _gate.port,
        Some(presentation(&chain, holder, RESOURCE, "Read")),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["resource"], RESOURCE);
}

#[test]
fn revoked_leaf_is_denied() {
    let issuer = SigningKey::from_bytes(&[12; 32]);
    let holder = b"synthetic-holder-credential";
    let chain = chain_for(&issuer, holder, now() - 10, now() + 600);
    let leaf: Signed<DelegationGrant> =
        serde_json::from_str(chain.last().expect("leaf")).expect("leaf grant");
    let leaf_id = URL_SAFE_NO_PAD.encode(delegation::id(&leaf).expect("leaf id"));
    let path = write_snapshot(&issuer, &[leaf_id]);
    let _gate = Gate::start(&[
        "--snapshot-file".into(),
        path.to_str().expect("path").into(),
    ]);
    let (status, body) = document(
        _gate.port,
        Some(presentation(&chain, holder, RESOURCE, "Read")),
    );
    assert_eq!(status, 403);
    assert_eq!(body["error"], "revoked");
}

#[test]
fn expired_leaf_is_denied() {
    let issuer = SigningKey::from_bytes(&[13; 32]);
    let holder = b"synthetic-holder-credential";
    let chain = chain_for(&issuer, holder, now() - 3600, now() - 60);
    let path = write_snapshot(&issuer, &[]);
    let _gate = Gate::start(&[
        "--snapshot-file".into(),
        path.to_str().expect("path").into(),
    ]);
    let (status, body) = document(
        _gate.port,
        Some(presentation(&chain, holder, RESOURCE, "Read")),
    );
    assert_eq!(status, 403);
    assert_eq!(body["error"], "expired");
}

#[test]
fn wrong_holder_is_denied() {
    let issuer = SigningKey::from_bytes(&[14; 32]);
    let chain = chain_for(
        &issuer,
        b"synthetic-holder-credential",
        now() - 10,
        now() + 600,
    );
    let path = write_snapshot(&issuer, &[]);
    let _gate = Gate::start(&[
        "--snapshot-file".into(),
        path.to_str().expect("path").into(),
    ]);
    let (status, body) = document(
        _gate.port,
        Some(presentation(
            &chain,
            b"synthetic-other-credential",
            RESOURCE,
            "Read",
        )),
    );
    assert_eq!(status, 403);
    assert_eq!(body["error"], "denied");
}

#[test]
fn tampered_signature_is_denied() {
    let issuer = SigningKey::from_bytes(&[15; 32]);
    let holder = b"synthetic-holder-credential";
    let chain = chain_for(&issuer, holder, now() - 10, now() + 600);
    let mut forged: Signed<DelegationGrant> =
        serde_json::from_str(chain.last().expect("leaf")).expect("leaf grant");
    forged.signature[0] ^= 1;
    let forged = serde_json::to_string(&forged).expect("forged token");
    let chain = vec![chain[0].clone(), forged];
    let path = write_snapshot(&issuer, &[]);
    let _gate = Gate::start(&[
        "--snapshot-file".into(),
        path.to_str().expect("path").into(),
    ]);
    let (status, body) = document(
        _gate.port,
        Some(presentation(&chain, holder, RESOURCE, "Read")),
    );
    assert_eq!(status, 403);
    assert_eq!(body["error"], "denied");
}

#[test]
fn wrong_resource_or_action_is_denied() {
    let issuer = SigningKey::from_bytes(&[16; 32]);
    let holder = b"synthetic-holder-credential";
    let chain = chain_for(&issuer, holder, now() - 10, now() + 600);
    let path = write_snapshot(&issuer, &[]);
    let _gate = Gate::start(&[
        "--snapshot-file".into(),
        path.to_str().expect("path").into(),
    ]);
    for (resource, action) in [
        ("urn:uac:lab:other", "Read"),
        (RESOURCE, "Write"),
        (RESOURCE, "Unlock"),
    ] {
        let (status, body) = document(
            _gate.port,
            Some(presentation(&chain, holder, resource, action)),
        );
        assert_eq!(status, 403, "{resource} {action}");
        assert_eq!(body["error"], "denied", "{resource} {action}");
    }
}

#[test]
fn missing_or_malformed_header_is_rejected() {
    let issuer = SigningKey::from_bytes(&[17; 32]);
    let path = write_snapshot(&issuer, &[]);
    let _gate = Gate::start(&[
        "--snapshot-file".into(),
        path.to_str().expect("path").into(),
    ]);
    let (status, body) = document(_gate.port, None);
    assert_eq!(status, 401);
    assert_eq!(body["error"], "authorization_required");
    let (status, body) = document(_gate.port, Some(URL_SAFE_NO_PAD.encode(b"not json")));
    assert_eq!(status, 403);
    assert_eq!(body["error"], "malformed");
    let (status, body) = document(_gate.port, Some("!!!not-base64!!!".into()));
    assert_eq!(status, 403);
    assert_eq!(body["error"], "malformed");
}

struct IssuerStub {
    snapshot: Arc<Mutex<String>>,
    stop: Arc<Mutex<bool>>,
}
impl IssuerStub {
    fn serve(snapshot: String) -> (Self, u16) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind stub");
        let port = listener.local_addr().expect("stub addr").port();
        let state = Arc::new(Mutex::new(snapshot));
        let stop = Arc::new(Mutex::new(false));
        let worker = {
            let state = state.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                listener
                    .set_nonblocking(true)
                    .expect("nonblocking listener");
                loop {
                    if *stop.lock().expect("stop") {
                        return;
                    }
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let mut buffer = [0; 4096];
                            let _ = stream.read(&mut buffer);
                            let body = state.lock().expect("snapshot").clone();
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(20)),
                    }
                }
            })
        };
        std::mem::forget(worker);
        (
            Self {
                snapshot: state,
                stop,
            },
            port,
        )
    }
    fn set(&self, snapshot: String) {
        *self.snapshot.lock().expect("snapshot") = snapshot;
    }
}
impl Drop for IssuerStub {
    fn drop(&mut self) {
        *self.stop.lock().expect("stop") = true;
    }
}

#[test]
fn issuer_url_mode_fetches_and_refreshes_revocations() {
    let issuer = SigningKey::from_bytes(&[18; 32]);
    let holder = b"synthetic-holder-credential";
    let chain = chain_for(&issuer, holder, now() - 10, now() + 600);
    let leaf: Signed<DelegationGrant> =
        serde_json::from_str(chain.last().expect("leaf")).expect("leaf grant");
    let leaf_id = URL_SAFE_NO_PAD.encode(delegation::id(&leaf).expect("leaf id"));
    let (stub, stub_port) = IssuerStub::serve(snapshot(&issuer, &[]));
    let _gate = Gate::start(&[
        "--issuer-url".into(),
        format!("http://localhost:{stub_port}"),
        "--snapshot-ttl".into(),
        "1".into(),
    ]);
    let header = presentation(&chain, holder, RESOURCE, "Read");
    let (status, _) = document(_gate.port, Some(header.clone()));
    assert_eq!(status, 200);
    stub.set(snapshot(&issuer, &[leaf_id]));
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last = (0, json!(null));
    while Instant::now() < deadline {
        last = document(_gate.port, Some(header.clone()));
        if last.0 == 403 {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert_eq!(last.0, 403, "{}", last.1);
    assert_eq!(last.1["error"], "revoked");
}

#[test]
fn startup_requires_a_snapshot_source() {
    let output = Command::new(env!("CARGO_BIN_EXE_uac-gate"))
        .arg("--port")
        .arg(free_port().to_string())
        .output()
        .expect("run uac-gate");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--issuer-url") && stderr.contains("--snapshot-file"));
}

#[test]
fn issuer_url_mode_fails_clearly_when_unreachable() {
    let output = Command::new(env!("CARGO_BIN_EXE_uac-gate"))
        .args([
            "--issuer-url",
            &format!("http://localhost:{}", free_port()),
            "--port",
            &free_port().to_string(),
        ])
        .output()
        .expect("run uac-gate");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("issuer unreachable"), "{stderr}");
}
