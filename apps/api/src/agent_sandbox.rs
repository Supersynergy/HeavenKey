//! The only bridge from an untrusted Linux container to a scoped broker client.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

type SafeResult<T> = Result<T, &'static str>;
const REQUEST_MAX: usize = 16_384;
const REPLY_MAX: usize = 1_048_576;
// Leave room for the fixed host receipt and final static error message.
const AGENT_OUTPUT_MAX: usize = REPLY_MAX - 4096;
const PATH_ENV: &str = "PATH=/usr/local/bin:/usr/bin:/bin";
const HOME_ENV: &str = "HOME=/tmp";
const ENDPOINT: &str = "http://127.0.0.1:18271";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pair {
    code: String,
    label: String,
}
impl Drop for Pair {
    fn drop(&mut self) {
        self.code.zeroize();
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    version: u8,
    id: u64,
    op: String,
    body: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    version: u8,
    id: u64,
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ask {
    origin: String,
    #[serde(default = "scope")]
    scope: String,
}
fn scope() -> String {
    "login_read".into()
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RequestId {
    request_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SessionId {
    session_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReadPage {
    session_id: String,
    path: String,
}

fn id_valid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|v| v.to_string() == id)
}
fn typed_body(op: &str, body: Value) -> SafeResult<Value> {
    match op {
        "request" => {
            let v: Ask = serde_json::from_value(body).map_err(|_| "Invalid request fields")?;
            if v.scope != "login_read"
                || v.origin.len() > 2048
                || v.origin.chars().any(char::is_control)
                || !(v.origin.starts_with("https://") || v.origin.starts_with("http://"))
            {
                return Err("Invalid request fields");
            }
            serde_json::to_value(v).map_err(|_| "Invalid request fields")
        }
        "status" => {
            let v: RequestId = serde_json::from_value(body).map_err(|_| "Invalid status fields")?;
            if !id_valid(&v.request_id) {
                return Err("Invalid request ID");
            }
            serde_json::to_value(v).map_err(|_| "Invalid status fields")
        }
        "close" => {
            let v: SessionId = serde_json::from_value(body).map_err(|_| "Invalid close fields")?;
            if !id_valid(&v.session_id) {
                return Err("Invalid session ID");
            }
            serde_json::to_value(v).map_err(|_| "Invalid close fields")
        }
        "read" => {
            let v: ReadPage = serde_json::from_value(body).map_err(|_| "Invalid read fields")?;
            if !id_valid(&v.session_id)
                || v.path.len() > 1024
                || !v.path.starts_with('/')
                || v.path.starts_with("//")
                || v.path
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '?' | '#' | '\\'))
            {
                return Err("Invalid read fields");
            }
            serde_json::to_value(v).map_err(|_| "Invalid read fields")
        }
        _ => Err("Unsupported sandbox operation"),
    }
}
fn parse_frame(bytes: &[u8]) -> SafeResult<Frame> {
    if bytes.len() > REQUEST_MAX {
        return Err("Sandbox request too large");
    }
    let mut f: Frame = serde_json::from_slice(bytes).map_err(|_| "Invalid sandbox frame")?;
    if f.version != 1 || f.id == 0 {
        return Err("Invalid sandbox frame");
    }
    f.body = typed_body(&f.op, f.body)?;
    Ok(f)
}
fn read_line(reader: &mut impl BufRead, max: usize) -> SafeResult<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let buf = reader.fill_buf().map_err(|_| "Sandbox pipe failed")?;
        if buf.is_empty() {
            return if bytes.len() > max {
                Err("Sandbox frame too large")
            } else if bytes.is_empty() {
                Err("Sandbox pipe closed")
            } else {
                Ok(bytes)
            };
        }
        let n = buf
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buf.len(), |p| p + 1);
        if bytes.len() + n > max + 1 {
            return Err("Sandbox frame too large");
        }
        bytes.extend_from_slice(&buf[..n]);
        reader.consume(n);
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.len() > max {
                return Err("Sandbox frame too large");
            }
            return Ok(bytes);
        }
    }
}
fn reader_thread<R: Read + Send + 'static>(
    reader: R,
    max: usize,
    stop: Arc<AtomicBool>,
) -> (mpsc::Receiver<SafeResult<Vec<u8>>>, thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::sync_channel(1);
    let h = thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        while !stop.load(Ordering::Acquire) {
            let item = read_line(&mut reader, max);
            let failed = item.is_err();
            let mut pending = item;
            loop {
                match tx.try_send(pending) {
                    Ok(()) => break,
                    Err(mpsc::TrySendError::Full(v)) => {
                        if stop.load(Ordering::Acquire) {
                            return;
                        }
                        pending = v;
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return,
                }
            }
            if failed {
                break;
            }
        }
    });
    (rx, h)
}
fn hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn immutable_image(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(hex64)
        || s.split_once("@sha256:").is_some_and(|(repo, digest)| {
            !repo.is_empty()
                && repo.bytes().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, b'/' | b':' | b'.' | b'_' | b'-')
                })
                && hex64(digest)
        })
}

// Docker's own CLI is trusted; only its stdout is read, never relayed or logged.
fn docker(args: &[String], cancel: &AtomicBool) -> SafeResult<Vec<u8>> {
    if cancel.load(Ordering::Acquire) {
        return Err("Sandbox cancelled");
    }
    let mut child = Command::new("docker")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Docker unavailable")?;
    let out = child.stdout.take().ok_or("Docker pipe unavailable")?;
    let reader = thread::spawn(move || {
        let mut v = Vec::new();
        let result = out.take((REPLY_MAX + 1) as u64).read_to_end(&mut v);
        if result.is_err() || v.len() > REPLY_MAX {
            Err("Docker output invalid or too large")
        } else {
            Ok(v)
        }
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err("Docker command cancelled or timed out");
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("Docker command failed");
            }
        }
    };
    let out = reader.join().map_err(|_| "Docker output failed")??;
    if !status.success() {
        return Err("Docker command failed");
    }
    Ok(out)
}
fn inspect(kind: &str, id: &str, cancel: &AtomicBool) -> SafeResult<Value> {
    let output = docker(&[kind.into(), "inspect".into(), id.into()], cancel)?;
    let mut v: Vec<Value> =
        serde_json::from_slice(&output).map_err(|_| "Docker inspection invalid")?;
    if v.len() != 1 {
        return Err("Docker inspection ambiguous");
    }
    Ok(v.remove(0))
}
fn empty(value: &Value) -> bool {
    value.is_null()
        || value.as_array().is_some_and(Vec::is_empty)
        || value.as_object().is_some_and(serde_json::Map::is_empty)
}
fn env_allowed(config: &Value) -> bool {
    let Some(vars) = config["Env"].as_array() else {
        return false;
    };
    let mut names = BTreeSet::new();
    vars.iter().all(|v| {
        let Some(s) = v.as_str() else {
            return false;
        };
        let Some((k, val)) = s.split_once('=') else {
            return false;
        };
        if !names.insert(k) {
            return false;
        }
        match k {
            "PATH" => {
                val == "/usr/local/bin:/usr/bin:/bin"
                    || val == "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            }
            "HOME" => val == "/tmp",
            "LANG" => val == "C.UTF-8",
            "PYTHON_VERSION" => {
                val.starts_with("3.13.")
                    && val.len() < 24
                    && val.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            }
            "PYTHON_SHA256" => hex64(val),
            _ => false,
        }
    })
}
fn verify_image(v: &Value) -> SafeResult<String> {
    let id = v["Id"].as_str().ok_or("Image identity missing")?;
    if !id.strip_prefix("sha256:").is_some_and(hex64)
        || v["Os"] != "linux"
        || !empty(&v["Config"]["Volumes"])
        || !env_allowed(&v["Config"])
    {
        return Err("Unsafe image configuration");
    }
    Ok(id.to_owned())
}
fn exact_strings(value: &Value, want: &[&str]) -> bool {
    value.as_array().is_some_and(|v| {
        v.len() == want.len() && v.iter().zip(want).all(|(a, b)| a.as_str() == Some(*b))
    })
}
fn verify_container(
    v: &Value,
    id: &str,
    image: &str,
    command: &[String],
    running: bool,
) -> SafeResult<()> {
    let h = &v["HostConfig"];
    let cfg = &v["Config"];
    let namespaces = ["PidMode", "UTSMode", "UsernsMode"].iter().all(|k| {
        h[*k]
            .as_str()
            .is_some_and(|v| v.is_empty() || v == "private")
    });
    let options_ok = h["SecurityOpt"].as_array().is_some_and(|opts| {
        opts.iter().all(|s| {
            matches!(
                s.as_str(),
                Some("no-new-privileges") | Some("no-new-privileges=true")
            )
        }) && opts.iter().any(|s| {
            s.as_str()
                .is_some_and(|s| s.starts_with("no-new-privileges"))
        })
    });
    let tmpfs = h["Tmpfs"].as_object().is_some_and(|m| {
        m.len() == 2
            && m.get("/tmp").and_then(Value::as_str) == Some("rw,nosuid,nodev,noexec,size=64m")
            && m.get("/work").and_then(Value::as_str)
                == Some("rw,nosuid,nodev,size=128m,uid=65532,gid=65532,mode=0700")
    });
    let mounts = v["Mounts"].as_array().is_some_and(|a| {
        a.iter().all(|m| {
            m["Type"] == "tmpfs" && matches!(m["Destination"].as_str(), Some("/tmp" | "/work"))
        })
    });
    let ulimits = h["Ulimits"].as_array().is_some_and(|a| {
        a.len() == 2
            && a.iter().all(|u| match u["Name"].as_str() {
                Some("core") => u["Soft"] == 0 && u["Hard"] == 0,
                Some("nofile") => u["Soft"] == 256 && u["Hard"] == 256,
                _ => false,
            })
    });
    let env = cfg["Env"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == HOME_ENV) && a.iter().any(|v| v == PATH_ENV));
    let mut cmd = vec!["--broker-sandbox-guest".to_string(), "--".to_string()];
    cmd.extend_from_slice(command);
    if v["Id"] != id
        || v["Image"] != image
        || cfg["Image"] != image
        || cfg["User"] != "65532:65532"
        || !env_allowed(cfg)
        || !env
        || !empty(&cfg["Volumes"])
        || cfg["WorkingDir"] != "/work"
        || !exact_strings(&cfg["Entrypoint"], &["/usr/local/bin/heavenkey"])
        || cfg["Cmd"] != json!(cmd)
        || cfg["Tty"] != false
        || cfg["OpenStdin"] != true
        || h["Privileged"] != false
        || h["ReadonlyRootfs"] != true
        || h["NetworkMode"] != "none"
        || h["IpcMode"] != "private"
        || !namespaces
        || h["CgroupnsMode"] != "private"
        || !exact_strings(&h["CapDrop"], &["ALL"])
        || !empty(&h["CapAdd"])
        || !options_ok
        || !empty(&h["Binds"])
        || !empty(&h["Devices"])
        || !empty(&h["DeviceRequests"])
        || !empty(&h["DeviceCgroupRules"])
        || !empty(&h["PortBindings"])
        || !empty(&h["Links"])
        || h["PublishAllPorts"] != false
        || h["Memory"] != 536_870_912_u64
        || h["MemorySwap"] != 536_870_912_u64
        || h["NanoCpus"] != 2_000_000_000_u64
        || h["PidsLimit"] != 128
        || !tmpfs
        || !mounts
        || !ulimits
        || (running
            && (v["State"]["Running"] != true || v["State"]["Pid"].as_u64().unwrap_or(0) == 0))
    {
        return Err("Container confinement inspection failed");
    }
    Ok(())
}
fn create_args(image: &str, command: &[String], cidfile: &str) -> Vec<String> {
    let mut args = [
        "create",
        "--pull=never",
        "--interactive",
        "--user=65532:65532",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--network=none",
        "--ipc=private",
        "--cgroupns=private",
        "--read-only",
        "--pids-limit=128",
        "--memory=512m",
        "--memory-swap=512m",
        "--cpus=2",
        "--ulimit=core=0",
        "--ulimit=nofile=256:256",
        "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m",
        "--tmpfs=/work:rw,nosuid,nodev,size=128m,uid=65532,gid=65532,mode=0700",
        "--workdir=/work",
        "--env=HOME=/tmp",
        "--env=PATH=/usr/local/bin:/usr/bin:/bin",
        "--entrypoint=/usr/local/bin/heavenkey",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect::<Vec<_>>();
    args.push(format!("--cidfile={cidfile}"));
    args.push(image.into());
    args.push("--broker-sandbox-guest".into());
    args.push("--".into());
    args.extend_from_slice(command);
    args
}
fn write_agent_output(output: &mut impl Write, line: &[u8], total: &mut usize) -> SafeResult<()> {
    let mut record =
        serde_json::to_vec(&json!({"heavenkey_agent_output":String::from_utf8_lossy(line)}))
            .map_err(|_| "Sandbox output invalid")?;
    record.push(b'\n');
    let next = total
        .checked_add(record.len())
        .filter(|n| *n <= AGENT_OUTPUT_MAX)
        .ok_or("Sandbox output limit exceeded")?;
    *total = next;
    output
        .write_all(&record)
        .map_err(|_| "Sandbox output failed")
}
enum OutputMessage {
    Record(Vec<u8>),
    Stop,
}
#[derive(Clone)]
struct OutputProducer {
    sender: mpsc::SyncSender<OutputMessage>,
    used: Arc<AtomicUsize>,
}
impl OutputProducer {
    fn send(&self, bytes: Vec<u8>) -> SafeResult<()> {
        let mut used = self.used.load(Ordering::Acquire);
        loop {
            let next = used
                .checked_add(bytes.len())
                .filter(|n| *n <= REPLY_MAX)
                .ok_or("Sandbox output limit exceeded")?;
            match self
                .used
                .compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => break,
                Err(current) => used = current,
            }
        }
        self.sender
            .try_send(OutputMessage::Record(bytes))
            .map_err(|_| "Sandbox output queue unavailable")
    }
}
struct OutputDrain {
    sender: mpsc::SyncSender<OutputMessage>,
    done: mpsc::Receiver<SafeResult<()>>,
}
impl OutputDrain {
    fn finish(self, timeout: Duration) -> SafeResult<()> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.sender.try_send(OutputMessage::Stop) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    return Err("Sandbox output writer unavailable");
                }
                Err(mpsc::TrySendError::Full(_)) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err("Sandbox output finish timed out");
                    }
                    thread::sleep(remaining.min(Duration::from_millis(10)));
                }
            }
        }
        self.done
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "Sandbox output finish timed out")?
    }
}
// This writer may be detached with an OS write blocked. The CLI caller must exit the
// process immediately after run returns; this module must not be used as a service.
fn bounded_output(mut writer: impl Write + Send + 'static) -> (OutputProducer, OutputDrain) {
    let (sender, receiver) = mpsc::sync_channel(16);
    let (finished, done) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (|| {
            while let Ok(message) = receiver.recv() {
                match message {
                    OutputMessage::Record(bytes) => writer
                        .write_all(&bytes)
                        .map_err(|_| "Sandbox output failed")?,
                    OutputMessage::Stop => {
                        return writer.flush().map_err(|_| "Sandbox output failed");
                    }
                }
            }
            Ok(())
        })();
        let _ = finished.send(result);
    });
    (
        OutputProducer {
            sender: sender.clone(),
            used: Arc::new(AtomicUsize::new(0)),
        },
        OutputDrain { sender, done },
    )
}
#[cfg(test)]
mod output_lifecycle_tests {
    use super::*;
    struct StalledWriter {
        entered: mpsc::SyncSender<()>,
        release: mpsc::Receiver<()>,
    }
    impl Write for StalledWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let _ = self.entered.try_send(());
            let _ = self.release.recv();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn stalled_output_cannot_block_bounded_finish() {
        let (entered, waiting) = mpsc::sync_channel(1);
        let (release, blocked) = mpsc::channel();
        let (output, drain) = bounded_output(StalledWriter {
            entered,
            release: blocked,
        });
        output.send(vec![b'x'; 8192]).unwrap();
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        let unstall = thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            drop(release);
        });
        let start = Instant::now();
        let result = drain.finish(Duration::from_millis(20));
        let elapsed = start.elapsed();
        drop(output);
        unstall.join().unwrap();
        assert!(
            elapsed < Duration::from_millis(150),
            "Output finish waited for blocked OS writer: {elapsed:?}"
        );
        assert!(
            result.is_err(),
            "Blocked sink must report incomplete output"
        );
    }
    #[test]
    fn stalled_output_queue_is_bounded_and_nonblocking() {
        let (entered, waiting) = mpsc::sync_channel(1);
        let (release, blocked) = mpsc::channel();
        let (output, drain) = bounded_output(StalledWriter {
            entered,
            release: blocked,
        });
        output.send(vec![b'x']).unwrap();
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        for _ in 0..16 {
            output.send(vec![b'x']).unwrap();
        }
        assert!(output.send(vec![b'x']).is_err());
        drop(release);
        drop(output);
        let _ = drain.finish(Duration::from_secs(1));
    }
}
struct PairedClient {
    port: u16,
    token: Zeroizing<String>,
    revoked: AtomicBool,
    attempts: AtomicU8,
}
impl PairedClient {
    fn disconnect(&self) -> SafeResult<()> {
        if self.revoked.load(Ordering::Acquire) {
            return Ok(());
        }
        if self.attempts.fetch_add(1, Ordering::AcqRel) >= 2 {
            return Err("Broker client revocation failed");
        }
        // Revocation must remain possible after the relay cancellation flag is set.
        crate::broker_agent::call(
            self.port,
            "disconnect",
            Some(&self.token),
            &json!({}),
            &AtomicBool::new(false),
        )?;
        self.revoked.store(true, Ordering::Release);
        Ok(())
    }
}
impl Drop for PairedClient {
    fn drop(&mut self) {
        let _ = self.disconnect();
    }
}
struct OwnedContainer {
    id: Option<String>,
    dir: std::path::PathBuf,
    client: Arc<PairedClient>,
}
impl OwnedContainer {
    fn remove(&mut self) -> SafeResult<()> {
        // Even failed create/start paths revoke unseen pending requests and browser jobs first.
        let _ = self.client.disconnect();
        if self.id.is_none()
            && let Ok(s) = fs::read_to_string(self.dir.join("cid"))
        {
            let s = s.trim();
            if hex64(s) {
                self.id = Some(s.into());
            }
        }
        if let Some(id) = &self.id {
            docker(
                &[
                    "rm".into(),
                    "--force".into(),
                    "--volumes".into(),
                    id.clone(),
                ],
                &AtomicBool::new(false),
            )?;
            self.id = None;
        }
        let _ = fs::remove_dir_all(&self.dir);
        Ok(())
    }
}
impl Drop for OwnedContainer {
    fn drop(&mut self) {
        let _ = self.remove();
    }
}

/// One-invocation CLI only: the dispatcher must immediately call process::exit
/// after this returns, including errors. A blocked OS output writer is detached.
pub async fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let (output, drain) = bounded_output(io::stderr());
    #[cfg(unix)]
    let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(term) => term,
        Err(_) => {
            let _ = output
                .send(b"{\"heavenkey_sandbox_error\":\"Signal handler unavailable\"}\n".to_vec());
            let _ = drain.finish(Duration::from_secs(2));
            return Err("Sandbox signal handler unavailable".into());
        }
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = cancel.clone();
    let args = args.to_vec();
    let host_output = output.clone();
    let mut work = tokio::task::spawn_blocking(move || host(&args, worker_cancel, host_output));
    #[cfg(unix)]
    let result = tokio::select! {
        r = &mut work => r,
        _ = tokio::signal::ctrl_c() => { cancel.store(true, Ordering::Release); work.await },
        _ = term.recv() => { cancel.store(true, Ordering::Release); work.await },
    };
    #[cfg(not(unix))]
    let result = tokio::select! {
        r = &mut work => r,
        _ = tokio::signal::ctrl_c() => { cancel.store(true, Ordering::Release); work.await },
    };
    let result = result.map_err(|_| "Sandbox worker failed").and_then(|r| r);
    if result.is_err() {
        let _ = output.send(
            b"{\"heavenkey_sandbox_error\":\"Sandbox failed; inspect broker and Docker state\"}\n"
                .to_vec(),
        );
    }
    drop(output);
    let output_result = drain.finish(Duration::from_secs(2));
    result.and(output_result).map_err(Into::into)
}
fn host(args: &[String], cancel: Arc<AtomicBool>, output: OutputProducer) -> SafeResult<()> {
    if args.len() < 5
        || args[0] != "--broker-sandbox"
        || args[3] != "--"
        || !immutable_image(&args[2])
    {
        return Err("Usage: --broker-sandbox PORT IMMUTABLE_IMAGE -- COMMAND [ARG...]");
    }
    let port = args[1]
        .parse::<u16>()
        .ok()
        .filter(|p| *p != 0)
        .ok_or("Invalid broker port")?;
    let command = &args[4..];
    if command[0].is_empty() || command.iter().map(String::len).sum::<usize>() > REQUEST_MAX {
        return Err("Invalid sandbox command");
    }
    let image_info = inspect("image", &args[2], &cancel)?;
    let image = verify_image(&image_info)?;
    let (pair_rx, _) = reader_thread(io::stdin(), REQUEST_MAX, cancel.clone());
    let deadline = Instant::now() + Duration::from_secs(20);
    let pairing = loop {
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err("Pairing input cancelled or timed out");
        }
        match pair_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(v) => break Zeroizing::new(v?),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return Err("Pairing input unavailable"),
        }
    };
    drop(pair_rx);
    let mut pair: Pair = serde_json::from_slice(&pairing).map_err(|_| "Invalid pairing input")?;
    if pair.code.is_empty()
        || pair.code.len() > 128
        || pair.label.is_empty()
        || pair.label.len() > 80
        || pair.code.chars().any(char::is_control)
        || pair.label.chars().any(char::is_control)
    {
        return Err("Invalid pairing input");
    }
    let mut pair_body =
        json!({"code":std::mem::take(&mut pair.code),"label":std::mem::take(&mut pair.label)});
    let connected = crate::broker_agent::call(port, "connect", None, &pair_body, &cancel);
    if let Some(Value::String(code)) = pair_body.get_mut("code") {
        code.zeroize();
    }
    let mut connected = connected?;
    let token = match connected.as_object_mut().and_then(|v| v.remove("token")) {
        Some(Value::String(token)) => Zeroizing::new(token),
        _ => return Err("Broker pairing failed"),
    };
    let client = Arc::new(PairedClient {
        port,
        token,
        revoked: AtomicBool::new(false),
        attempts: AtomicU8::new(0),
    });
    drop(pair);
    drop(pairing);
    drop(connected);
    if client.token.len() != 43
        || !client
            .token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("Broker pairing failed");
    }
    let dir = std::env::temp_dir().join(format!("heavenkey-sandbox-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).map_err(|_| "Sandbox ownership file unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Sandbox ownership file unavailable")?;
    }
    let mut owned = OwnedContainer {
        id: None,
        dir,
        client: client.clone(),
    };
    let cid = owned.dir.join("cid");
    let cid = cid.to_str().ok_or("Sandbox ownership path invalid")?;
    let created = docker(&create_args(&image, command, cid), &cancel)?;
    let id = std::str::from_utf8(&created)
        .map_err(|_| "Docker container identity invalid")?
        .trim()
        .to_owned();
    if !hex64(&id) {
        return Err("Docker container identity invalid");
    }
    if fs::read_to_string(owned.dir.join("cid"))
        .ok()
        .as_deref()
        .map(str::trim)
        != Some(id.as_str())
    {
        return Err("Docker container ownership mismatch");
    }
    owned.id = Some(id.clone());
    let mut security_inspected = false;
    let result = relay_container(Relay {
        id: &id,
        image: &image,
        command,
        port,
        token: &client.token,
        cancel: &cancel,
        owned: &mut owned,
        inspected: &mut security_inspected,
        output: &output,
    });
    let removed = owned.remove();
    let mut receipt=serde_json::to_vec(&json!({"heavenkey_sandbox_receipt":1,"image_id":image,"container_id":id,"host_os":std::env::consts::OS,
        "container_os":"linux","security_inspected":security_inspected,"exit_code":result.as_ref().ok().and_then(|r|r.0),
        "cancelled":cancel.load(Ordering::Acquire),"client_revoked":client.revoked.load(Ordering::Acquire),"removed":removed.is_ok()})
    ).map_err(|_|"Sandbox receipt invalid")?;
    receipt.push(b'\n');
    let output_result = output.send(receipt);
    removed?;
    output_result?;
    if !client.revoked.load(Ordering::Acquire) {
        return Err("Broker client revocation failed");
    }
    let (exit, _) = result?;
    if cancel.load(Ordering::Acquire) {
        return Err("Sandbox cancelled");
    }
    if exit != Some(0) {
        return Err("Sandbox agent failed");
    }
    Ok(())
}
struct Relay<'a> {
    id: &'a str,
    image: &'a str,
    command: &'a [String],
    port: u16,
    token: &'a str,
    cancel: &'a Arc<AtomicBool>,
    owned: &'a mut OwnedContainer,
    inspected: &'a mut bool,
    output: &'a OutputProducer,
}
fn relay_container(context: Relay<'_>) -> SafeResult<(Option<i32>, bool)> {
    let Relay {
        id,
        image,
        command,
        port,
        token,
        cancel,
        owned,
        inspected,
        output,
    } = context;
    verify_container(
        &inspect("container", id, cancel)?,
        id,
        image,
        command,
        false,
    )?;
    let mut child = Command::new("docker")
        .args(["start", "--attach", "--interactive", id])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Docker start failed")?;
    let stop = Arc::new(AtomicBool::new(false));
    let (rx, reader) = reader_thread(
        child.stdout.take().ok_or("Sandbox stdout unavailable")?,
        REQUEST_MAX,
        stop.clone(),
    );
    let input = child.stdin.take().ok_or("Sandbox stdin unavailable")?;
    let stderr = child.stderr.take().ok_or("Sandbox stderr unavailable")?;
    let output_stop = stop.clone();
    let output_cancel = cancel.clone();
    let output = output.clone();
    let stderr_reader = thread::spawn(move || {
        let mut stderr = BufReader::new(stderr);
        let mut total = 0usize;
        while !output_stop.load(Ordering::Acquire) {
            match read_line(&mut stderr, REQUEST_MAX) {
                Ok(line) => {
                    let mut record = Vec::new();
                    if write_agent_output(&mut record, &line, &mut total)
                        .and_then(|()| output.send(record))
                        .is_err()
                    {
                        output_stop.store(true, Ordering::Release);
                        output_cancel.store(true, Ordering::Release);
                        return;
                    }
                }
                Err("Sandbox pipe closed") => return,
                Err(_) => {
                    output_stop.store(true, Ordering::Release);
                    output_cancel.store(true, Ordering::Release);
                    return;
                }
            }
        }
    });
    let (writes, write_results, writer) = pipe_writer(input);
    let lifetime = Instant::now() + Duration::from_secs(900);
    let lifetime_cancel = cancel.clone();
    let (finish_lifetime, lifetime_done) = mpsc::channel();
    let lifetime_timer = thread::spawn(move || {
        if lifetime_done
            .recv_timeout(Duration::from_secs(900))
            .is_err()
        {
            lifetime_cancel.store(true, Ordering::Release);
        }
    });
    let mut last_id = 0;
    let result = (|| {
        // The guest waits for a host acknowledgement before executing the child.
        let startup_deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let post = inspect("container", id, cancel)?;
            if post["State"]["Running"] == true {
                verify_container(&post, id, image, command, true)?;
                break;
            }
            if post["State"]["Status"] != "created" || Instant::now() >= startup_deadline {
                return Err("Sandbox did not enter running state");
            }
            thread::sleep(Duration::from_millis(50));
        }
        *inspected = true;
        write_pipe(
            &writes,
            &write_results,
            br#"{"version":1,"id":0,"ok":true,"value":{"start":true}}"#.to_vec(),
            cancel,
        )?;
        loop {
            if cancel.load(Ordering::Acquire)
                || stop.load(Ordering::Acquire)
                || Instant::now() >= lifetime
            {
                return Err("Sandbox cancelled or lifetime exceeded");
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Sandbox process check failed")?
            {
                return Ok((status.code(), *inspected));
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(bytes)) => {
                    let frame = parse_frame(&bytes)?;
                    if frame.id <= last_id {
                        return Err("Sandbox request ID reused");
                    }
                    last_id = frame.id;
                    let result = crate::broker_agent::call(
                        port,
                        &frame.op,
                        Some(token),
                        &frame.body,
                        cancel,
                    );
                    let reply = match result {
                        Ok(value) => Reply {
                            version: 1,
                            id: frame.id,
                            ok: true,
                            value: Some(value),
                            error: None,
                        },
                        Err(_) => Reply {
                            version: 1,
                            id: frame.id,
                            ok: false,
                            value: None,
                            error: Some("Broker operation denied or unavailable".into()),
                        },
                    };
                    let bytes = serde_json::to_vec(&reply).map_err(|_| "Sandbox reply invalid")?;
                    if bytes.len() > REPLY_MAX {
                        return Err("Sandbox reply too large");
                    }
                    write_pipe(&writes, &write_results, bytes, cancel)?;
                }
                Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // The pipe may close just before the docker client is reaped.
                    for _ in 0..10 {
                        if let Some(status) = child
                            .try_wait()
                            .map_err(|_| "Sandbox process check failed")?
                        {
                            return Ok((status.code(), *inspected));
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    return Err("Sandbox protocol closed");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    })();
    stop.store(true, Ordering::Release);
    drop(rx);
    drop(writes);
    // Removing this exact owned ID releases the attached stdout reader, including failure paths.
    let removal = owned.remove();
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    let _ = stderr_reader.join();
    let _ = writer.join();
    let _ = finish_lifetime.send(());
    let _ = lifetime_timer.join();
    if removal.is_err() {
        return Err("Sandbox cleanup failed");
    }
    result
}

fn pipe_writer(
    mut input: std::process::ChildStdin,
) -> (
    mpsc::SyncSender<Vec<u8>>,
    mpsc::Receiver<SafeResult<()>>,
    thread::JoinHandle<()>,
) {
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(1);
    let (done, results) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            let result = input
                .write_all(&bytes)
                .and_then(|()| input.write_all(b"\n"))
                .and_then(|()| input.flush())
                .map_err(|_| "Sandbox reply pipe failed");
            let failed = result.is_err();
            if done.send(result).is_err() || failed {
                break;
            }
        }
    });
    (tx, results, worker)
}
fn write_pipe(
    tx: &mpsc::SyncSender<Vec<u8>>,
    rx: &mpsc::Receiver<SafeResult<()>>,
    bytes: Vec<u8>,
    cancel: &AtomicBool,
) -> SafeResult<()> {
    tx.try_send(bytes)
        .map_err(|_| "Sandbox reply queue unavailable")?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err("Sandbox reply cancelled or timed out");
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(v) => return v,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return Err("Sandbox reply writer unavailable"),
        }
    }
}

fn verify_guest() -> SafeResult<Value> {
    if std::env::consts::OS != "linux" || std::process::id() != 1 {
        return Err("Guest requires isolated Linux PID namespace");
    }
    let status =
        fs::read_to_string("/proc/self/status").map_err(|_| "Guest process facts unavailable")?;
    let field = |name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name).map(str::trim))
    };
    if field("Uid:").is_none_or(|s| s.split_whitespace().any(|n| n != "65532"))
        || field("Gid:").is_none_or(|s| s.split_whitespace().any(|n| n != "65532"))
        || field("NoNewPrivs:") != Some("1")
        || field("Seccomp:") != Some("2")
        || field("CapEff:") != Some("0000000000000000")
        || field("CapPrm:") != Some("0000000000000000")
        || field("CapBnd:") != Some("0000000000000000")
    {
        return Err("Guest process confinement missing");
    }
    if std::path::Path::new("/var/run/docker.sock").exists()
        || std::path::Path::new("/run/docker.sock").exists()
    {
        return Err("Guest has forbidden Docker access");
    }
    let mounts =
        fs::read_to_string("/proc/self/mountinfo").map_err(|_| "Guest mount facts unavailable")?;
    let root_readonly = mounts.lines().any(|l| {
        let f = l.split_whitespace().collect::<Vec<_>>();
        f.len() > 6 && f[4] == "/" && f[5].split(',').any(|v| v == "ro")
    });
    if !root_readonly {
        return Err("Guest root is writable");
    }
    let workspace_tmpfs = mounts.lines().any(|line| {
        let Some((mount, filesystem)) = line.split_once(" - ") else {
            return false;
        };
        let fields = mount.split_whitespace().collect::<Vec<_>>();
        fields.len() > 5
            && fields[4] == "/work"
            && filesystem.starts_with("tmpfs ")
            && ["rw", "nosuid", "nodev"]
                .iter()
                .all(|required| fields[5].split(',').any(|flag| flag == *required))
    });
    if !workspace_tmpfs {
        return Err("Guest workspace is not private tmpfs");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let workspace = fs::metadata("/work").map_err(|_| "Guest workspace unavailable")?;
        if !workspace.is_dir()
            || workspace.uid() != 65532
            || workspace.gid() != 65532
            || workspace.mode() & 0o777 != 0o700
        {
            return Err("Guest workspace ownership or permissions invalid");
        }
    }
    let probe = format!("/work/.heavenkey-check-{}", uuid::Uuid::new_v4());
    let writable = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| "Guest workspace is not writable")?;
    drop(writable);
    fs::remove_file(probe).map_err(|_| "Guest workspace cleanup failed")?;
    let namespaces = ["pid", "mnt", "net", "ipc", "uts", "user", "cgroup"]
        .iter()
        .map(|n| {
            fs::read_link(format!("/proc/self/ns/{n}"))
                .ok()
                .and_then(|v| v.to_str().map(str::to_owned))
                .map(|v| ((*n).to_owned(), Value::String(v)))
        })
        .collect::<Option<serde_json::Map<String, Value>>>()
        .ok_or("Guest namespace facts unavailable")?;
    let interface =
        fs::read_dir("/sys/class/net").map_err(|_| "Guest network facts unavailable")?;
    if interface
        .filter_map(Result::ok)
        .any(|e| e.file_name() != "lo")
    {
        return Err("Guest network isolation missing");
    }
    Ok(
        json!({"guest_confinement":1,"uid":65532,"pid":1,"no_new_privs":1,"cap_eff":0,"seccomp":2,"root_readonly":true,"workspace_private_tmpfs":true,"workspace_writable":true,"namespaces":namespaces}),
    )
}
fn http_request(stream: &mut TcpStream) -> SafeResult<(String, Value)> {
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|_| "Guest IO failed")?;
    stream
        .set_write_timeout(Some(Duration::from_millis(200)))
        .map_err(|_| "Guest IO failed")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut header = Vec::new();
    loop {
        if Instant::now() >= deadline {
            return Err("Guest HTTP timed out");
        }
        let mut b = [0u8; 1];
        match stream.read(&mut b) {
            Ok(1) => header.push(b[0]),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                continue;
            }
            _ => return Err("Guest HTTP closed"),
        }
        if header.len() > 8192 {
            return Err("Guest HTTP headers too large");
        }
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let header = std::str::from_utf8(&header).map_err(|_| "Guest HTTP invalid")?;
    let mut lines = header.split("\r\n");
    let first = lines
        .next()
        .ok_or("Guest HTTP invalid")?
        .split(' ')
        .collect::<Vec<_>>();
    if first.len() != 3 || first[0] != "POST" || first[2] != "HTTP/1.1" {
        return Err("Guest requires HTTP POST");
    }
    let op = match first[1] {
        "/request" => "request",
        "/status" => "status",
        "/read" => "read",
        "/close" => "close",
        _ => return Err("Unsupported sandbox operation"),
    };
    let mut length = None;
    for line in lines.filter(|s| !s.is_empty()) {
        let (name, value) = line.split_once(':').ok_or("Guest HTTP invalid")?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err("Guest HTTP transfer encoding unsupported");
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err("Guest HTTP duplicate length");
            }
            length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "Guest HTTP invalid length")?,
            );
        }
        if name.eq_ignore_ascii_case("authorization")
            || name.eq_ignore_ascii_case("x-heavenkey-token")
            || name.eq_ignore_ascii_case("cookie")
        {
            return Err("Guest credentials forbidden");
        }
    }
    let length = length
        .filter(|n| *n <= REQUEST_MAX)
        .ok_or("Guest HTTP length missing or too large")?;
    let mut bytes = vec![0u8; length];
    let mut read = 0;
    while read < length {
        if Instant::now() >= deadline {
            return Err("Guest HTTP timed out");
        }
        match stream.read(&mut bytes[read..]) {
            Ok(0) => return Err("Guest HTTP closed"),
            Ok(n) => read += n,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => return Err("Guest HTTP failed"),
        }
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| "Guest JSON invalid")?;
    Ok((op.into(), typed_body(op, body)?))
}
fn http_reply(stream: &mut TcpStream, ok: bool, value: &Value) -> SafeResult<()> {
    let body = serde_json::to_vec(value).map_err(|_| "Guest reply invalid")?;
    if body.len() > REPLY_MAX {
        return Err("Guest reply too large");
    }
    write!(stream,"HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",if ok {"200 OK"} else {"400 Bad Request"},body.len())
        .and_then(|()|stream.write_all(&body)).map_err(|_| "Guest HTTP write failed")
}
fn receive_reply(rx: &mpsc::Receiver<SafeResult<Vec<u8>>>, id: u64) -> SafeResult<Reply> {
    let bytes = rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| "Host response timed out or closed")??;
    let reply: Reply = serde_json::from_slice(&bytes).map_err(|_| "Invalid host response")?;
    if reply.version != 1
        || reply.id != id
        || (reply.ok && (reply.value.is_none() || reply.error.is_some()))
        || (!reply.ok && (reply.error.is_none() || reply.value.is_some()))
    {
        return Err("Invalid host response");
    }
    Ok(reply)
}
pub fn guest(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    guest_inner(args).map_err(Into::into)
}
fn guest_inner(args: &[String]) -> SafeResult<()> {
    if args.len() < 3
        || args[0] != "--broker-sandbox-guest"
        || args[1] != "--"
        || args[2].is_empty()
    {
        return Err("Guest command missing");
    }
    let facts = verify_guest()?;
    eprintln!("{facts}");
    let stop = Arc::new(AtomicBool::new(false));
    let (rx, _) = reader_thread(io::stdin(), REPLY_MAX, stop.clone());
    let startup = receive_reply(&rx, 0)?;
    if !startup.ok || startup.value.as_ref().is_none_or(|v| v["start"] != true) {
        return Err("Host confinement acknowledgement missing");
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 18271))
        .map_err(|_| "Guest endpoint unavailable")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Guest listener failed")?;
    let mut child = Command::new(&args[2])
        .args(&args[3..])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", "/tmp")
        .env("LANG", "C.UTF-8")
        .env("HEAVENKEY_AGENT_ENDPOINT", ENDPOINT)
        .current_dir("/work")
        .stdin(Stdio::null())
        .stdout(Stdio::from(io::stderr()))
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|_| "Guest child failed to start")?;
    let result = guest_loop(listener, &mut child, &rx);
    stop.store(true, Ordering::Release);
    let _ = child.kill();
    let _ = child.wait();
    result
}
fn guest_loop(
    listener: TcpListener,
    child: &mut Child,
    rx: &mpsc::Receiver<SafeResult<Vec<u8>>>,
) -> SafeResult<()> {
    let deadline = Instant::now() + Duration::from_secs(895);
    let mut id = 0u64;
    let mut output = io::stdout().lock();
    loop {
        if Instant::now() >= deadline {
            return Err("Guest lifetime exceeded");
        }
        if let Some(status) = child.try_wait().map_err(|_| "Guest child failed")? {
            return if status.success() {
                Ok(())
            } else {
                Err("Guest child failed")
            };
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let request = http_request(&mut stream);
                let (op, body) = match request {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = http_reply(
                            &mut stream,
                            false,
                            &json!({"error":"Invalid or forbidden sandbox request"}),
                        );
                        continue;
                    }
                };
                id = id.checked_add(1).ok_or("Guest request limit reached")?;
                let frame = serde_json::to_vec(&Frame {
                    version: 1,
                    id,
                    op,
                    body,
                })
                .map_err(|_| "Guest frame invalid")?;
                if frame.len() > REQUEST_MAX {
                    let _ = http_reply(
                        &mut stream,
                        false,
                        &json!({"error":"Sandbox request too large"}),
                    );
                    continue;
                }
                output
                    .write_all(&frame)
                    .and_then(|()| output.write_all(b"\n"))
                    .and_then(|()| output.flush())
                    .map_err(|_| "Guest relay failed")?;
                let reply = receive_reply(rx, id)?;
                let value = reply
                    .value
                    .unwrap_or_else(|| json!({"error":"Broker operation denied or unavailable"}));
                let _ = http_reply(&mut stream, reply.ok, &value);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(_) => return Err("Guest listener failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mock_client(
        directory: Option<std::path::PathBuf>,
    ) -> (PairedClient, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e)
                        if e.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(10))
                    }
                    _ => panic!("Paired client did not disconnect after lifecycle exit"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0u8; 1];
            while !bytes.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 8192);
            }
            let header = String::from_utf8(bytes).unwrap();
            assert!(header.starts_with("POST /api/password-broker/agent/disconnect HTTP/1.1\r\n"));
            assert!(header.contains(&format!("X-HeavenKey-Token: {}\r\n", "a".repeat(43))));
            let mut body = [0u8; 2];
            stream.read_exact(&mut body).unwrap();
            assert_eq!(&body, b"{}");
            if let Some(path) = directory {
                assert!(
                    path.is_dir(),
                    "Revocation must precede filesystem/container removal"
                );
            }
            let body = br#"{"disconnected":true}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });
        (
            PairedClient {
                port,
                token: Zeroizing::new("a".repeat(43)),
                revoked: AtomicBool::new(false),
                attempts: AtomicU8::new(0),
            },
            server,
        )
    }
    #[test]
    fn paired_client_revokes_on_early_failure() {
        let (client, server) = mock_client(None);
        fn fail_after_pairing(_client: PairedClient) -> SafeResult<()> {
            Err("Synthetic create failure")
        }
        assert!(fail_after_pairing(client).is_err());
        server.join().unwrap();
    }
    #[test]
    fn owned_cleanup_revokes_before_removal_and_is_idempotent() {
        let dir =
            std::env::temp_dir().join(format!("heavenkey-cleanup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let (client, server) = mock_client(Some(dir.clone()));
        let client = Arc::new(client);
        let mut owned = OwnedContainer {
            id: None,
            dir: dir.clone(),
            client: client.clone(),
        };
        owned.remove().unwrap();
        assert!(client.revoked.load(Ordering::Acquire));
        assert!(!dir.exists());
        owned.remove().unwrap();
        drop(owned);
        assert_eq!(client.attempts.load(Ordering::Acquire), 1);
        drop(client);
        server.join().unwrap();
    }
    #[test]
    fn newline_only_output_cannot_exceed_serialized_limit() {
        let flood = vec![b'\n'; REPLY_MAX + 1];
        let mut input = io::Cursor::new(flood);
        let mut output = Vec::new();
        let mut total = 0;
        while let Ok(line) = read_line(&mut input, REQUEST_MAX) {
            if write_agent_output(&mut output, &line, &mut total).is_err() {
                break;
            }
        }
        assert!(
            output.len() <= REPLY_MAX,
            "Serialized empty-line records escaped the output budget"
        );
        assert_eq!(total, output.len());
    }
    #[test]
    fn escaped_control_output_cannot_exceed_serialized_limit() {
        let line = vec![0u8; 8192];
        let mut output = Vec::new();
        let mut total = 0;
        for _ in 0..256 {
            if write_agent_output(&mut output, &line, &mut total).is_err() {
                break;
            }
        }
        assert!(
            output.len() <= REPLY_MAX,
            "JSON escaping escaped the output budget"
        );
        assert_eq!(total, output.len());
    }
    #[test]
    fn immutable_images_only() {
        let digest = "a".repeat(64);
        assert!(immutable_image(&format!("sha256:{digest}")));
        assert!(immutable_image(&format!("local/heavenkey@sha256:{digest}")));
        for v in [
            "latest",
            "python:3.13",
            "--privileged",
            "sha256:abc",
            "host@sha256:",
        ] {
            assert!(!immutable_image(v));
        }
    }
    #[test]
    fn relay_rejects_owner_ops_and_untyped_fields() {
        for op in [
            "connect",
            "disconnect",
            "unlock",
            "approve",
            "eval",
            "cookies",
            "../owner",
            "http://host/read",
        ] {
            assert!(
                parse_frame(
                    &serde_json::to_vec(&json!({"version":1,"id":1,"op":op,"body":{}})).unwrap()
                )
                .is_err()
            );
        }
        assert!(
            typed_body(
                "request",
                json!({"origin":"https://example.com","token":"secret"})
            )
            .is_err()
        );
        assert!(
            typed_body(
                "request",
                json!({"origin":"https://example.com","scope":"owner"})
            )
            .is_err()
        );
        assert!(parse_frame(br#"{"version":1,"id":1,"op":"request","body":{"origin":"https://example.com"},"url":"http://owner"}"#).is_err());
        assert!(typed_body("request", json!({"origin":"https://example.com"})).is_ok());
    }
    #[test]
    fn bounded_frames_and_relative_reads() {
        assert!(
            read_line(
                &mut io::Cursor::new(vec![b'x'; REQUEST_MAX + 1]),
                REQUEST_MAX
            )
            .is_err()
        );
        assert!(parse_frame(&vec![b' '; REQUEST_MAX + 1]).is_err());
        let id = uuid::Uuid::new_v4().to_string();
        for path in [
            "https://example.com",
            "//host/path",
            "/path?token=a",
            "/x#y",
            "/x\\y",
            "/\n",
        ] {
            assert!(typed_body("read", json!({"session_id":id,"path":path})).is_err());
        }
        assert!(typed_body("read", json!({"session_id":id,"path":"/safe"})).is_ok());
    }
    #[test]
    fn image_environment_is_closed_allowlist() {
        assert!(env_allowed(
            &json!({"Env":[PATH_ENV,HOME_ENV,"LANG=C.UTF-8","PYTHON_VERSION=3.13.12"]})
        ));
        for secret in [
            "HEAVENKEY_TOKEN=secret",
            "AWS_SECRET_ACCESS_KEY=x",
            "LD_PRELOAD=/tmp/evil",
            "PATH=/tmp",
        ] {
            assert!(!env_allowed(&json!({"Env":[PATH_ENV,HOME_ENV,secret]})));
        }
    }
    #[test]
    fn host_cannot_enter_guest_mode() {
        assert!(verify_guest().is_err());
    }
}
