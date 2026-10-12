#![forbid(unsafe_code)]

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uac_verifier::{Action, Error, delegation};

const DEFAULT_PORT: u16 = 18242;
const DOCUMENT_RESOURCE: &str = "urn:uac:lab:document";
const AUTH_HEADER: &str = "x-heavenkey-authorization";
const MAX_PRESENTATION_BYTES: usize = 32 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const STARTUP_ATTEMPTS: u32 = 10;
const STARTUP_RETRY_DELAY: Duration = Duration::from_millis(300);
const DEFAULT_SNAPSHOT_TTL: u64 = 60;

#[derive(Clone)]
struct App {
    snapshot: Arc<RwLock<Snapshot>>,
}

struct Snapshot {
    issuer: [u8; 32],
    revoked: BTreeSet<[u8; 32]>,
    fetched_at: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotDocument {
    profile: String,
    issuer: String,
    revoked: Vec<String>,
    time: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Presentation {
    chain: Vec<String>,
    holder: String,
    resource: String,
    action: Action,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn deny(status: StatusCode, code: &'static str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}

fn reason(error: &Error) -> &'static str {
    match error {
        Error::Time | Error::ClockRollback => "expired",
        Error::Revoked => "revoked",
        Error::Encoding | Error::Limits => "malformed",
        _ => "denied",
    }
}

fn decode_id(value: &str) -> Result<[u8; 32], String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "invalid base64url".to_owned())?
        .try_into()
        .map_err(|_| "expected 32 bytes".to_owned())
}

fn parse_snapshot(bytes: &[u8]) -> Result<Snapshot, String> {
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err("issuer snapshot exceeds size limit".into());
    }
    let document: SnapshotDocument =
        serde_json::from_slice(bytes).map_err(|_| "invalid issuer snapshot JSON".to_owned())?;
    if document.profile != delegation::PROFILE {
        return Err(format!("unsupported issuer profile {}", document.profile));
    }
    let issuer = decode_id(&document.issuer).map_err(|e| format!("invalid issuer key: {e}"))?;
    let mut revoked = BTreeSet::new();
    for id in &document.revoked {
        revoked.insert(decode_id(id).map_err(|e| format!("invalid revoked id: {e}"))?);
    }
    let _ = document.time;
    Ok(Snapshot {
        issuer,
        revoked,
        fetched_at: now(),
    })
}

fn decode_chunked(mut bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let Some(end) = bytes.windows(2).position(|w| w == b"\r\n") else {
            return Err("truncated chunk size".into());
        };
        let size_text = std::str::from_utf8(&bytes[..end]).map_err(|_| "bad chunk size")?;
        let size = usize::from_str_radix(size_text.trim(), 16).map_err(|_| "bad chunk size")?;
        bytes = &bytes[end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if bytes.len() < size + 2 {
            return Err("truncated chunk".into());
        }
        out.extend_from_slice(&bytes[..size]);
        bytes = &bytes[size + 2..];
        if out.len() > MAX_SNAPSHOT_BYTES {
            return Err("snapshot exceeds size limit".into());
        }
    }
}

async fn http_get(base_url: &str, path: &str) -> Result<Vec<u8>, String> {
    let address = base_url
        .strip_prefix("http://")
        .ok_or_else(|| "issuer URL must be plain http://".to_owned())?
        .trim_end_matches('/');
    let (host, port) = match address.split_once(':') {
        Some((host, port)) => (
            host.to_owned(),
            port.parse::<u16>().map_err(|_| "invalid issuer port")?,
        ),
        None => (address.to_owned(), 80),
    };
    if host.is_empty() {
        return Err("missing issuer host".into());
    }
    let exchange = async {
        let mut stream = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| format!("connect: {e}"))?;
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {address}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| format!("write: {e}"))?;
        let mut raw = Vec::new();
        stream
            .read_to_end(&mut raw)
            .await
            .map_err(|e| format!("read: {e}"))?;
        Ok::<_, String>(raw)
    };
    let raw = tokio::time::timeout(FETCH_TIMEOUT, exchange)
        .await
        .map_err(|_| "request timed out".to_owned())??;
    if raw.len() > MAX_SNAPSHOT_BYTES + 4096 {
        return Err("response exceeds size limit".into());
    }
    let head_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response".to_owned())?;
    let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
    let body = &raw[head_end + 4..];
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "malformed HTTP status".to_owned())?;
    if status != 200 {
        return Err(format!("issuer answered HTTP {status}"));
    }
    let chunked = head
        .lines()
        .skip(1)
        .any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"));
    if chunked {
        decode_chunked(body)
    } else {
        Ok(body.to_vec())
    }
}

async fn fetch_snapshot(base_url: &str) -> Result<Snapshot, String> {
    let body = http_get(base_url, "/api/issuer").await?;
    parse_snapshot(&body)
}

fn load_snapshot_file(path: &std::path::Path) -> Result<Snapshot, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    parse_snapshot(&bytes)
}

fn authorize(app: &App, presentation: &[u8]) -> Result<Value, (StatusCode, &'static str)> {
    if presentation.len() > MAX_PRESENTATION_BYTES {
        return Err((StatusCode::FORBIDDEN, "malformed"));
    }
    let presentation: Presentation =
        serde_json::from_slice(presentation).map_err(|_| (StatusCode::FORBIDDEN, "malformed"))?;
    if presentation.resource != DOCUMENT_RESOURCE || presentation.action != Action::Read {
        return Err((StatusCode::FORBIDDEN, "denied"));
    }
    let holder = URL_SAFE_NO_PAD
        .decode(&presentation.holder)
        .map_err(|_| (StatusCode::FORBIDDEN, "malformed"))?;
    let holder_subject: [u8; 32] = Sha256::digest(&holder).into();
    let mut chain = Vec::with_capacity(presentation.chain.len());
    for token in &presentation.chain {
        chain.push(
            delegation::decode(token.as_bytes())
                .map_err(|error| (StatusCode::FORBIDDEN, reason(&error)))?,
        );
    }
    let snapshot = app
        .snapshot
        .read()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"))?;
    delegation::verify_structure(&chain, &snapshot.issuer)
        .map_err(|error| (StatusCode::FORBIDDEN, reason(&error)))?;
    delegation::verify_chain(
        &chain,
        delegation::Context {
            root: &snapshot.issuer,
            verified_holder: &holder_subject,
            resource: &presentation.resource,
            action: presentation.action,
            now: now(),
            revoked: &snapshot.revoked,
        },
    )
    .map_err(|error| (StatusCode::FORBIDDEN, reason(&error)))?;
    let leaf = &chain
        .last()
        .ok_or((StatusCode::FORBIDDEN, "malformed"))?
        .body;
    if leaf.audience != holder_subject {
        return Err((StatusCode::FORBIDDEN, "denied"));
    }
    Ok(json!({
        "document": "HeavenKey-Labordokument",
        "resource": DOCUMENT_RESOURCE,
        "profile": delegation::PROFILE,
        "holder": URL_SAFE_NO_PAD.encode(holder_subject),
        "snapshot_time": snapshot.fetched_at,
    }))
}

async fn health() -> Json<Value> {
    Json(json!({"status":"ok","mode":"heavenkey-gate"}))
}

async fn document(State(app): State<App>, headers: HeaderMap) -> Response {
    let Some(value) = headers.get(AUTH_HEADER).and_then(|v| v.to_str().ok()) else {
        return deny(StatusCode::UNAUTHORIZED, "authorization_required");
    };
    if value.len() > MAX_PRESENTATION_BYTES * 2 {
        return deny(StatusCode::FORBIDDEN, "malformed");
    }
    let Ok(presentation) = URL_SAFE_NO_PAD.decode(value) else {
        return deny(StatusCode::FORBIDDEN, "malformed");
    };
    match authorize(&app, &presentation) {
        Ok(document) => Json(document).into_response(),
        Err((status, code)) => deny(status, code),
    }
}

struct Options {
    port: u16,
    issuer_url: Option<String>,
    snapshot_file: Option<String>,
    snapshot_ttl: u64,
}

fn usage() -> &'static str {
    "uac-gate — offline enforcement demo for HeavenKey delegation chains\n\
         \n\
         Usage: uac-gate (--issuer-url URL | --snapshot-file FILE) [OPTIONS]\n\
         \n\
         Options:\n\
         \x20 --issuer-url URL     fetch GET <URL>/api/issuer and refresh it\n\
         \x20 --snapshot-file FILE load the issuer snapshot once from a JSON file\n\
         \x20 --snapshot-ttl SECS  refresh interval for --issuer-url (default 60)\n\
         \x20 --port PORT          listen port (default 18242, env UAC_GATE_PORT)\n\
         \x20 --help               show this text\n\
         \n\
         Endpoints: GET /health, GET /document (X-HeavenKey-Authorization header)"
}

fn options() -> Result<Options, String> {
    let mut port = std::env::var("UAC_GATE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let mut issuer_url = None;
    let mut snapshot_file = None;
    let mut snapshot_ttl = DEFAULT_SNAPSHOT_TTL;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let take = |args: &mut std::iter::Skip<std::env::Args>, name: &str| {
            args.next()
                .ok_or_else(|| format!("missing value for {name}"))
        };
        match arg.as_str() {
            "--issuer-url" => issuer_url = Some(take(&mut args, "--issuer-url")?),
            "--snapshot-file" => snapshot_file = Some(take(&mut args, "--snapshot-file")?),
            "--snapshot-ttl" => {
                snapshot_ttl = take(&mut args, "--snapshot-ttl")?
                    .parse()
                    .map_err(|_| "invalid --snapshot-ttl".to_owned())?
            }
            "--port" => {
                port = take(&mut args, "--port")?
                    .parse()
                    .map_err(|_| "invalid --port".to_owned())?
            }
            "--help" | "-h" => unreachable!("handled before parsing"),
            _ if arg.parse::<u16>().is_ok() => port = arg.parse().map_err(|_| "invalid port")?,
            _ => return Err(format!("unknown argument {arg}\n{}", usage())),
        }
    }
    if issuer_url.is_some() == snapshot_file.is_some() {
        return Err(format!(
            "exactly one of --issuer-url or --snapshot-file is required\n{}",
            usage()
        ));
    }
    if snapshot_ttl == 0 {
        return Err("--snapshot-ttl must be positive".into());
    }
    Ok(Options {
        port,
        issuer_url,
        snapshot_file,
        snapshot_ttl,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", usage());
        return Ok(());
    }
    let options = match options() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let (snapshot, issuer_url) = if let Some(url) = &options.issuer_url {
        let mut last_error = String::new();
        let mut snapshot = None;
        for attempt in 1..=STARTUP_ATTEMPTS {
            match fetch_snapshot(url).await {
                Ok(found) => {
                    snapshot = Some(found);
                    break;
                }
                Err(error) => {
                    last_error = error;
                    if attempt < STARTUP_ATTEMPTS {
                        tokio::time::sleep(STARTUP_RETRY_DELAY).await;
                    }
                }
            }
        }
        match snapshot {
            Some(snapshot) => (snapshot, Some(url.clone())),
            None => {
                eprintln!(
                    "uac-gate: issuer unreachable after {STARTUP_ATTEMPTS} attempts: {last_error}"
                );
                std::process::exit(1);
            }
        }
    } else {
        let path = std::path::PathBuf::from(options.snapshot_file.expect("exclusive"));
        match load_snapshot_file(&path) {
            Ok(snapshot) => (snapshot, None),
            Err(error) => {
                eprintln!("uac-gate: invalid snapshot file: {error}");
                std::process::exit(1);
            }
        }
    };
    let app = App {
        snapshot: Arc::new(RwLock::new(snapshot)),
    };
    if let Some(url) = issuer_url {
        let refresh = app.snapshot.clone();
        let ttl = options.snapshot_ttl;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(ttl)).await;
                match fetch_snapshot(&url).await {
                    Ok(found) => {
                        if let Ok(mut current) = refresh.write() {
                            *current = found;
                        }
                    }
                    Err(error) => {
                        eprintln!("uac-gate: snapshot refresh failed, keeping previous: {error}");
                    }
                }
            }
        });
    }
    let router = Router::new()
        .route("/health", get(health))
        .route("/document", get(document))
        .with_state(app);
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, options.port)).await?;
    println!(
        "uac-gate {}: http://localhost:{}",
        env!("CARGO_PKG_VERSION"),
        options.port
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            if let Err(e) = tokio::signal::ctrl_c().await {
                eprintln!("shutdown signal: {e}");
            }
        })
        .await?;
    Ok(())
}
