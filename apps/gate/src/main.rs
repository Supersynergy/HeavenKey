#![forbid(unsafe_code)]

//! `uac-gate`: standalone authorization gate for a protected local resource.
//! Verifies a `heavenkey-delegation-v1` chain offline against `uac-verifier`;
//! no running uac-api process is required. Deny by default.

use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{StatusCode, header},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uac_verifier::delegation::{self, DelegationGrant};
use uac_verifier::{Action, Error, Signed};

const DEFAULT_LISTEN: &str = "127.0.0.1:18242";
const DEFAULT_RESOURCE: &str = "urn:uac:lab:document";
const MAX_BODY: usize = 64 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024;
const MAX_REVOCATIONS: usize = 16_384;

struct Options {
    listen: SocketAddr,
    resource: String,
    resource_file: PathBuf,
    issuer_key: PathBuf,
    revocations: PathBuf,
    now: Option<u64>,
}

fn usage() -> String {
    format!(
        "uac-gate {}\n\n\
        --listen ADDR           Bind address (default {DEFAULT_LISTEN})\n\
        --resource NAME         Resource URN the chain must grant (default {DEFAULT_RESOURCE})\n\
        --resource-file PATH    Protected local file served on grant (required)\n\
        --issuer-key PATH       Trusted issuer key: 32 raw bytes or 64 hex chars (required)\n\
        --revocations PATH      Revocation snapshot JSON file (required)\n\
        --now SECONDS           Fixed evaluation time for lab replay (default: wall clock)\n\
        --version               Version\n\n\
        UAC_GATE_LISTEN, UAC_GATE_RESOURCE, UAC_GATE_RESOURCE_FILE, UAC_GATE_ISSUER_KEY,\n\
        UAC_GATE_REVOCATIONS and UAC_GATE_NOW are also supported. Flags win over env.",
        env!("CARGO_PKG_VERSION")
    )
}

fn flag_value(
    flag: &str,
    args: &mut dyn Iterator<Item = OsString>,
) -> Result<OsString, Box<dyn std::error::Error>> {
    args.next()
        .ok_or_else(|| format!("{flag} requires a value").into())
}

fn options() -> Result<Option<Options>, Box<dyn std::error::Error>> {
    let env_or = |name: &str| env::var(name).ok().filter(|value| !value.is_empty());
    let env_os = |name: &str| env::var_os(name).filter(|value| !value.is_empty());
    let mut listen = env_or("UAC_GATE_LISTEN").unwrap_or_else(|| DEFAULT_LISTEN.into());
    let mut resource = env_or("UAC_GATE_RESOURCE").unwrap_or_else(|| DEFAULT_RESOURCE.into());
    let mut resource_file = env_os("UAC_GATE_RESOURCE_FILE");
    let mut issuer_key = env_os("UAC_GATE_ISSUER_KEY");
    let mut revocations = env_os("UAC_GATE_REVOCATIONS");
    let mut now = env_or("UAC_GATE_NOW");
    let mut args = env::args_os().skip(1);
    while let Some(arg) = args.next() {
        let text = arg
            .to_str()
            .ok_or("arguments must be valid UTF-8")?
            .to_owned();
        match text.as_str() {
            "--version" => {
                println!("uac-gate {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--help" | "-h" => {
                println!("{}", usage());
                return Ok(None);
            }
            "--listen" => {
                listen = flag_value("--listen", &mut args)?
                    .into_string()
                    .map_err(|_| "--listen must be valid UTF-8")?;
            }
            "--resource" => {
                resource = flag_value("--resource", &mut args)?
                    .into_string()
                    .map_err(|_| "--resource must be valid UTF-8")?;
            }
            "--resource-file" => {
                resource_file = Some(flag_value("--resource-file", &mut args)?);
            }
            "--issuer-key" => {
                issuer_key = Some(flag_value("--issuer-key", &mut args)?);
            }
            "--revocations" => {
                revocations = Some(flag_value("--revocations", &mut args)?);
            }
            "--now" => {
                now = Some(
                    flag_value("--now", &mut args)?
                        .into_string()
                        .map_err(|_| "--now must be valid UTF-8")?,
                );
            }
            other => return Err(format!("unknown argument: {other}\n{}", usage()).into()),
        }
    }
    let missing = |flag: &str| -> Box<dyn std::error::Error> {
        format!("{flag} or its UAC_GATE_* equivalent is required").into()
    };
    Ok(Some(Options {
        listen: listen.parse()?,
        resource,
        resource_file: PathBuf::from(resource_file.ok_or_else(|| missing("--resource-file"))?),
        issuer_key: PathBuf::from(issuer_key.ok_or_else(|| missing("--issuer-key"))?),
        revocations: PathBuf::from(revocations.ok_or_else(|| missing("--revocations"))?),
        now: now.map(|value| value.parse()).transpose()?,
    }))
}

struct Gate {
    root: [u8; 32],
    resource: String,
    resource_file: PathBuf,
    revocations: PathBuf,
    now: Option<u64>,
}

/// Why a request was refused. Every variant maps to the same client-facing
/// `delegation_denied` answer; the distinction is for the gate operator log.
#[derive(Debug, PartialEq, Eq)]
enum Denial {
    UnsupportedAction,
    SnapshotUnavailable,
    Chain(Error),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccessRequest {
    chain: Vec<Signed<DelegationGrant>>,
    holder: [u8; 32],
    action: Option<Action>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevocationSnapshot {
    version: u32,
    #[serde(rename = "generated_at")]
    _generated_at: Option<u64>,
    revoked: Vec<String>,
}

fn parse_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok())
        .collect()
}

fn load_issuer_key(path: &Path) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let bytes = fs::read(path)?;
    if bytes.len() == 32 {
        return Ok(bytes.try_into().expect("length checked"));
    }
    if let Ok(text) = std::str::from_utf8(&bytes)
        && let Some(raw) = parse_hex(text.trim()).filter(|raw| raw.len() == 32)
    {
        return Ok(raw.try_into().expect("length checked"));
    }
    Err(format!(
        "{}: issuer key must be 32 raw bytes or 64 hex characters",
        path.display()
    )
    .into())
}

fn load_revocations(path: &Path) -> Result<BTreeSet<[u8; 32]>, Denial> {
    let metadata = fs::metadata(path).map_err(|_| Denial::SnapshotUnavailable)?;
    if !metadata.is_file() || metadata.len() > MAX_SNAPSHOT_BYTES {
        return Err(Denial::SnapshotUnavailable);
    }
    let bytes = fs::read(path).map_err(|_| Denial::SnapshotUnavailable)?;
    let snapshot: RevocationSnapshot =
        serde_json::from_slice(&bytes).map_err(|_| Denial::SnapshotUnavailable)?;
    if snapshot.version != 1 || snapshot.revoked.len() > MAX_REVOCATIONS {
        return Err(Denial::SnapshotUnavailable);
    }
    snapshot
        .revoked
        .iter()
        .map(|entry| {
            parse_hex(entry)
                .filter(|raw| raw.len() == 32)
                .and_then(|raw| raw.try_into().ok())
                .ok_or(Denial::SnapshotUnavailable)
        })
        .collect()
}

fn authorize(gate: &Gate, request: &AccessRequest, now: u64) -> Result<(), Denial> {
    if request.action.is_some_and(|action| action != Action::Read) {
        return Err(Denial::UnsupportedAction);
    }
    let revoked = load_revocations(&gate.revocations)?;
    delegation::verify_chain(
        &request.chain,
        delegation::Context {
            root: &gate.root,
            verified_holder: &request.holder,
            resource: &gate.resource,
            action: Action::Read,
            now,
            revoked: &revoked,
        },
    )
    .map_err(Denial::Chain)
}

fn denied(status: StatusCode, reason: &'static str) -> Response {
    (status, Json(json!({"allowed": false, "reason": reason}))).into_response()
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "profile": delegation::PROFILE,
        "max_chain": delegation::MAX_CHAIN,
    }))
}

async fn access(State(gate): State<Arc<Gate>>, body: Bytes) -> Response {
    let request: AccessRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => return denied(StatusCode::BAD_REQUEST, "invalid_request"),
    };
    let now = gate.now.unwrap_or_else(now_secs);
    match authorize(&gate, &request, now) {
        Ok(()) => match fs::read(&gate.resource_file) {
            Ok(bytes) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/octet-stream")],
                bytes,
            )
                .into_response(),
            Err(_) => {
                eprintln!(
                    "uac-gate: authorized but resource unreadable: {}",
                    gate.resource_file.display()
                );
                denied(StatusCode::INTERNAL_SERVER_ERROR, "resource_unavailable")
            }
        },
        Err(denial) => {
            eprintln!("uac-gate: access denied: {denial:?}");
            denied(StatusCode::FORBIDDEN, "delegation_denied")
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn router(gate: Arc<Gate>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/access", post(access))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(gate)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(options) = options()? else {
        return Ok(());
    };
    let root = load_issuer_key(&options.issuer_key)?;
    load_revocations(&options.revocations).map_err(|_| {
        format!(
            "{}: revocation snapshot unreadable or invalid",
            options.revocations.display()
        )
    })?;
    if !fs::metadata(&options.resource_file).is_ok_and(|meta| meta.is_file()) {
        return Err(format!("{}: resource file missing", options.resource_file.display()).into());
    }
    eprintln!("uac-gate {}", env!("CARGO_PKG_VERSION"));
    eprintln!("listen: http://{}", options.listen);
    eprintln!(
        "resource: {} -> {}",
        options.resource,
        options.resource_file.display()
    );
    eprintln!("issuer key: {}", options.issuer_key.display());
    eprintln!("revocations: {}", options.revocations.display());
    let gate = Arc::new(Gate {
        root,
        resource: options.resource,
        resource_file: options.resource_file,
        revocations: options.revocations,
        now: options.now,
    });
    let listener = tokio::net::TcpListener::bind(options.listen).await?;
    axum::serve(listener, router(gate))
        .with_graceful_shutdown(async {
            if let Err(error) = tokio::signal::ctrl_c().await {
                eprintln!("uac-gate: shutdown signal failed: {error}");
            }
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const NOW: u64 = 1_700_000_100;
    const CONTENT: &[u8] = b"synthetische Labor-Ressource\n";

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../../docs/vectors/delegation-v1.json"))
            .expect("committed vectors")
    }

    fn grant(name: &str) -> Signed<DelegationGrant> {
        let fixture = vectors()["fixtures"]
            .as_array()
            .expect("fixtures")
            .iter()
            .find(|fixture| fixture["name"] == name)
            .unwrap_or_else(|| panic!("fixture {name}"))["grant"]
            .clone();
        delegation::decode(&serde_json::to_vec(&fixture).expect("fixture JSON"))
            .unwrap_or_else(|_| panic!("decode {name}"))
    }

    fn trusted_issuer() -> [u8; 32] {
        let bytes: Vec<u8> =
            serde_json::from_value(vectors()["trusted_issuer"].clone()).expect("issuer");
        bytes.try_into().expect("32 bytes")
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn gate_with(revoked: &[String], snapshot: Option<&str>) -> (PathBuf, Gate) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "uac-gate-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).expect("test dir");
        let resource_file = dir.join("resource.txt");
        fs::write(&resource_file, CONTENT).expect("resource file");
        let revocations = dir.join("revocations.json");
        match snapshot {
            Some(raw) => fs::write(&revocations, raw).expect("raw snapshot"),
            None => fs::write(
                &revocations,
                serde_json::to_vec(&json!({"version": 1, "revoked": revoked}))
                    .expect("snapshot JSON"),
            )
            .expect("snapshot file"),
        };
        (
            dir,
            Gate {
                root: trusted_issuer(),
                resource: DEFAULT_RESOURCE.into(),
                resource_file,
                revocations,
                now: Some(NOW),
            },
        )
    }

    fn request(names: &[&str], holder: [u8; 32]) -> AccessRequest {
        AccessRequest {
            chain: names.iter().map(|name| grant(name)).collect(),
            holder,
            action: None,
        }
    }

    fn chain_error(dir: &Path, gate: &Gate, request: &AccessRequest, error: Error) {
        assert_eq!(
            authorize(gate, request, gate.now.expect("fixed now")),
            Err(Denial::Chain(error))
        );
        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn valid_chain_is_authorized() {
        let (dir, gate) = gate_with(&[], None);
        let holder = grant("grandchild").body.audience;
        let req = request(&["root", "child", "grandchild"], holder);
        assert_eq!(authorize(&gate, &req, NOW), Ok(()));
        assert_eq!(
            fs::read(&gate.resource_file).expect("resource"),
            CONTENT.to_vec()
        );
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn expired_chain_is_denied() {
        let (dir, gate) = gate_with(&[], None);
        let holder = grant("grandchild").body.audience;
        let req = request(&["root", "child", "grandchild"], holder);
        assert_eq!(
            authorize(&gate, &req, 1_700_003_600),
            Err(Denial::Chain(Error::Time))
        );
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn directly_revoked_leaf_is_denied() {
        let leaf = delegation::id(&grant("grandchild")).expect("leaf id");
        let (dir, gate) = gate_with(&[hex(&leaf)], None);
        let holder = grant("grandchild").body.audience;
        let req = request(&["root", "child", "grandchild"], holder);
        chain_error(&dir, &gate, &req, Error::Revoked);
    }

    #[test]
    fn revoked_ancestor_denies_descendants() {
        let ancestor = delegation::id(&grant("root")).expect("root id");
        let (dir, gate) = gate_with(&[hex(&ancestor)], None);
        let holder = grant("grandchild").body.audience;
        let req = request(&["root", "child", "grandchild"], holder);
        chain_error(&dir, &gate, &req, Error::Revoked);
    }

    #[test]
    fn wrong_holder_is_denied() {
        let (dir, gate) = gate_with(&[], None);
        let holder = grant("child").body.audience;
        let req = request(&["root", "child", "grandchild"], holder);
        chain_error(&dir, &gate, &req, Error::Invocation);
    }

    #[test]
    fn tampered_signature_is_denied() {
        let (dir, gate) = gate_with(&[], None);
        let mut leaf = grant("grandchild");
        leaf.signature[0] ^= 1;
        let holder = leaf.body.audience;
        let req = AccessRequest {
            chain: vec![grant("root"), grant("child"), leaf],
            holder,
            action: None,
        };
        chain_error(&dir, &gate, &req, Error::Signature);
    }

    #[test]
    fn chain_deeper_than_five_links_is_denied() {
        let (dir, gate) = gate_with(&[], None);
        let holder = grant("depth_6").body.audience;
        let req = request(
            &[
                "depth_1", "depth_2", "depth_3", "depth_4", "depth_5", "depth_6",
            ],
            holder,
        );
        chain_error(&dir, &gate, &req, Error::Limits);
    }

    #[test]
    fn budget_violation_is_denied() {
        let (dir, gate) = gate_with(&[], None);
        let holder = grant("same_budget").body.audience;
        let req = request(&["root", "same_budget"], holder);
        chain_error(&dir, &gate, &req, Error::Escalation);
    }

    #[test]
    fn empty_chain_is_denied() {
        let (dir, gate) = gate_with(&[], None);
        let req = request(&[], [1; 32]);
        chain_error(&dir, &gate, &req, Error::Limits);
    }

    #[test]
    fn non_read_action_is_denied() {
        let (dir, gate) = gate_with(&[], None);
        let holder = grant("grandchild").body.audience;
        let mut req = request(&["root", "child", "grandchild"], holder);
        req.action = Some(Action::Write);
        assert_eq!(authorize(&gate, &req, NOW), Err(Denial::UnsupportedAction));
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn unreadable_snapshot_denies_closed() {
        let (dir, mut gate) = gate_with(&[], None);
        gate.revocations = dir.join("missing.json");
        let holder = grant("grandchild").body.audience;
        let req = request(&["root", "child", "grandchild"], holder);
        assert_eq!(
            authorize(&gate, &req, NOW),
            Err(Denial::SnapshotUnavailable)
        );
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn invalid_snapshot_content_denies_closed() {
        let (dir, gate) = gate_with(&[], Some("{\"version\":2,\"revoked\":[]}"));
        let holder = grant("grandchild").body.audience;
        let req = request(&["root", "child", "grandchild"], holder);
        assert_eq!(
            authorize(&gate, &req, NOW),
            Err(Denial::SnapshotUnavailable)
        );
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn malformed_request_body_is_rejected() {
        assert!(serde_json::from_slice::<AccessRequest>(b"{}").is_err());
        assert!(serde_json::from_slice::<AccessRequest>(b"not json").is_err());
        let holder = [1u8; 32];
        let mut value = json!({
            "chain": [serde_json::to_value(grant("root")).expect("root JSON")],
            "holder": holder,
        });
        assert!(serde_json::from_value::<AccessRequest>(value.clone()).is_ok());
        value["extra"] = json!(true);
        assert!(serde_json::from_value::<AccessRequest>(value).is_err());
    }

    #[test]
    fn issuer_key_accepts_hex_and_raw_32_bytes() {
        let dir = std::env::temp_dir().join(format!("uac-gate-key-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("key dir");
        let key = [7u8; 32];
        let hex_path = dir.join("issuer.hex");
        fs::write(&hex_path, format!("{}\n", hex(&key))).expect("hex key");
        assert_eq!(load_issuer_key(&hex_path).expect("hex"), key);
        let raw_path = dir.join("issuer.raw");
        fs::write(&raw_path, key).expect("raw key");
        assert_eq!(load_issuer_key(&raw_path).expect("raw"), key);
        fs::write(dir.join("bad.key"), b"too short").expect("bad key");
        assert!(load_issuer_key(&dir.join("bad.key")).is_err());
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    async fn post(addr: SocketAddr, path: &str, body: &str) -> (u16, Vec<u8>) {
        let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: gate\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).await.expect("head");
        stream.write_all(body.as_bytes()).await.expect("body");
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.expect("response");
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("header terminator");
        let status: u16 = String::from_utf8_lossy(&raw[..split])
            .split_whitespace()
            .nth(1)
            .expect("status code")
            .parse()
            .expect("numeric status");
        (status, raw[split + 4..].to_vec())
    }

    #[tokio::test]
    async fn http_gate_grants_and_denies() {
        let root_id = hex(&delegation::id(&grant("root")).expect("root id"));
        let (dir, gate) = gate_with(&[], None);
        let content = fs::read(dir.join("resource.txt")).expect("resource");
        let app = router(Arc::new(gate));
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("address");
        tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });

        let holder = grant("grandchild").body.audience;
        let valid = serde_json::to_string(&json!({
            "chain": [
                serde_json::to_value(grant("root")).expect("root JSON"),
                serde_json::to_value(grant("child")).expect("child JSON"),
                serde_json::to_value(grant("grandchild")).expect("grandchild JSON"),
            ],
            "holder": holder,
            "action": "Read",
        }))
        .expect("request JSON");
        let (status, body) = post(addr, "/access", &valid).await;
        assert_eq!((status, body), (200, content));

        let revoked = serde_json::to_string(&json!({
            "chain": [
                serde_json::to_value(grant("root")).expect("root JSON"),
                serde_json::to_value(grant("child")).expect("child JSON"),
                serde_json::to_value(grant("grandchild")).expect("grandchild JSON"),
            ],
            "holder": holder,
        }))
        .expect("request JSON");
        fs::write(
            dir.join("revocations.json"),
            serde_json::to_vec(&json!({"version": 1, "revoked": [root_id]})).expect("snapshot"),
        )
        .expect("update snapshot");
        let (status, body) = post(addr, "/access", &revoked).await;
        assert_eq!(status, 403);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).expect("denial JSON")["allowed"],
            false
        );

        let (status, _) = post(addr, "/access", "garbage").await;
        assert_eq!(status, 400);
        fs::remove_dir_all(&dir).expect("cleanup");
    }
}
