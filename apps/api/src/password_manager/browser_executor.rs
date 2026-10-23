//! Restricted, ephemeral Chromium executor. CDP and credentials never leave this module.
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};
use webauthn_rs::prelude::Url;
use zeroize::{Zeroize, Zeroizing};

const FRAME_MAX: usize = 1_048_576;
const COMMAND_MAX: usize = 131_072;
const COMMAND_TIME: Duration = Duration::from_secs(5);
const NAVIGATION_TIME: Duration = Duration::from_secs(15);
const START_TIME: Duration = Duration::from_secs(45);
const SESSION_TIME: Duration = Duration::from_secs(300);
const TICK: Duration = Duration::from_millis(50);

pub struct Login {
    pub url: String,
    pub username: Zeroizing<String>,
    pub password: Zeroizing<String>,
    pub otp: Option<Zeroizing<String>>,
}

struct WriteRequest {
    bytes: Zeroizing<Vec<u8>>,
    done: SyncSender<bool>,
}

pub struct BrowserSession {
    child: Option<Child>,
    profile: PathBuf,
    reader: Option<Receiver<Result<Zeroizing<Vec<u8>>, ()>>>,
    writer: Option<SyncSender<WriteRequest>>,
    threads: Vec<JoinHandle<()>>,
    cancel: Arc<AtomicBool>,
    origin: Url,
    target_session: String,
    next_id: u64,
    replies: HashMap<u64, Value>,
    acknowledgements: HashSet<u64>,
    configured: HashSet<String>,
    secrets: Vec<Zeroizing<String>>,
    navigations: u64,
    current_url: String,
    expires: Instant,
    poisoned: bool,
}

pub fn available() -> bool {
    browser_path().is_some()
}

fn browser_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("HEAVENKEY_BROKER_BROWSER") {
        let path = PathBuf::from(path);
        return path
            .is_absolute()
            .then_some(path)
            .filter(|path| path.is_file());
    }
    #[cfg(target_os = "macos")]
    let paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    #[cfg(target_os = "linux")]
    let paths = [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ];
    #[cfg(windows)]
    let paths = [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    paths.iter().map(PathBuf::from).find(|path| path.is_file())
}

fn approved_url(value: &str, origin: &Url) -> bool {
    Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.origin() == origin.origin()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

fn public_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(matches!(a, 0 | 10 | 127)
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99)))
                || (a == 198 && (matches!(b, 18 | 19) || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
fn validated_pin(origin: &Url, answers: &[std::net::IpAddr]) -> Result<String, &'static str> {
    let host = origin.host_str().ok_or("invalid_origin")?;
    let local = origin.scheme() == "http" && host == "localhost";
    if answers.is_empty()
        || answers.iter().any(|ip| {
            if local {
                !ip.is_loopback()
            } else {
                !public_ip(*ip)
            }
        })
    {
        return Err("browser_address_denied");
    }
    let selected = answers
        .iter()
        .find(|ip| ip.is_ipv4())
        .unwrap_or(&answers[0]);
    let address = match selected {
        std::net::IpAddr::V4(ip) => ip.to_string(),
        std::net::IpAddr::V6(ip) => format!("[{ip}]"),
    };
    Ok(format!("MAP {host} {address}, MAP * ~NOTFOUND"))
}
fn resolve_pin(origin: &Url) -> Result<String, &'static str> {
    use std::net::ToSocketAddrs;
    static RESOLVING: AtomicBool = AtomicBool::new(false);
    struct ResolverGuard;
    impl Drop for ResolverGuard {
        fn drop(&mut self) {
            RESOLVING.store(false, Ordering::Release);
        }
    }
    if RESOLVING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("browser_dns_busy");
    }
    let guard = ResolverGuard;
    let host = origin.host_str().ok_or("invalid_origin")?.to_owned();
    let port = origin.port_or_known_default().ok_or("invalid_origin")?;
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("broker-dns".into())
        .spawn(move || {
            let _guard = guard;
            let result = (host.as_str(), port)
                .to_socket_addrs()
                .map(|addresses| addresses.map(|a| a.ip()).collect::<Vec<_>>());
            let _ = tx.send(result);
        })
        .map_err(|_| "browser_dns_failed")?;
    let answers = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "browser_dns_failed")?
        .map_err(|_| "browser_dns_failed")?;
    validated_pin(origin, &answers)
}

fn private_profile() -> Result<PathBuf, &'static str> {
    let profile = std::env::temp_dir().join(format!("heavenkey-broker-{}", uuid::Uuid::new_v4()));
    uac_browser_pipe::create_private_directory(&profile).map_err(|_| "browser_profile_failed")?;
    Ok(profile)
}

fn browser_command(browser: &Path, profile: &Path, resolver_rules: &str) -> Command {
    let mut command = Command::new(browser);
    command.args([
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--incognito",
    "--disable-extensions", "--disable-sync", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--disable-domain-reliability",
    "--disable-breakpad", "--disable-crash-reporter", "--disable-application-cache",
    "--disk-cache-size=0", "--media-cache-size=0", "--password-store=basic",
    "--disable-save-password-bubble", "--disable-client-side-phishing-detection",
    "--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication,Translate,MediaRouter,OptimizationHints,Prerender2",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--no-proxy-server", "--disable-quic", "--dns-prefetch-disable", "about:blank",
]).arg(format!("--host-resolver-rules={resolver_rules}"))
    .arg(format!("--user-data-dir={}", profile.display()))
    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(target_os = "macos")]
    command.arg("--use-mock-keychain");
    command
}

impl BrowserSession {
    pub fn start(login: Login, cancel: Arc<AtomicBool>) -> Result<Self, &'static str> {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled");
        }
        if login.username.len() > 4096
            || login.password.is_empty()
            || login.password.len() > 4096
            || login.otp.as_ref().is_some_and(|otp| otp.len() > 128)
            || login.url.len() > 4096
        {
            return Err("unsupported_login");
        }
        let mut origin = Url::parse(&login.url).map_err(|_| "invalid_origin")?;
        if !matches!(origin.scheme(), "http" | "https")
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.fragment().is_some()
        {
            return Err("invalid_origin");
        }
        if origin.scheme() == "http" && origin.host_str() != Some("localhost") {
            return Err("invalid_origin");
        }
        let resolver_rules = resolve_pin(&origin)?;
        origin.set_path("/");
        origin.set_query(None);
        origin.set_fragment(None);
        let browser = browser_path().ok_or("browser_unavailable")?;
        let profile = private_profile()?;
        let mut session = Self {
            child: None,
            profile,
            reader: None,
            writer: None,
            threads: Vec::new(),
            cancel,
            origin,
            target_session: String::new(),
            next_id: 1,
            replies: HashMap::new(),
            acknowledgements: HashSet::new(),
            configured: HashSet::new(),
            secrets: Vec::new(),
            navigations: 0,
            current_url: String::new(),
            expires: Instant::now() + SESSION_TIME,
            poisoned: false,
        };
        let mut command = browser_command(&browser, &session.profile, &resolver_rules);
        let (child, mut input, mut output) =
            uac_browser_pipe::spawn(&mut command).map_err(|_| "browser_start_failed")?;
        session.child = Some(child);
        let (tx, rx) = mpsc::sync_channel(2);
        session.reader = Some(rx);
        session.threads.push(
            thread::Builder::new()
                .name("broker-pipe-read".into())
                .spawn(move || {
                    let mut pending = Zeroizing::new(Vec::with_capacity(8192));
                    let mut chunk = Zeroizing::new([0_u8; 8192]);
                    loop {
                        let count = match input.read(&mut *chunk) {
                            Ok(0) | Err(_) => {
                                let _ = tx.send(Err(()));
                                break;
                            }
                            Ok(count) => count,
                        };
                        for byte in &chunk[..count] {
                            if *byte == 0 {
                                let frame = std::mem::replace(
                                    &mut pending,
                                    Zeroizing::new(Vec::with_capacity(8192)),
                                );
                                if !frame.is_empty() && tx.send(Ok(frame)).is_err() {
                                    return;
                                }
                            } else {
                                if pending.len() == FRAME_MAX {
                                    let _ = tx.send(Err(()));
                                    return;
                                }
                                pending.push(*byte);
                            }
                        }
                    }
                })
                .map_err(|_| "browser_start_failed")?,
        );
        let (tx, rx) = mpsc::sync_channel::<WriteRequest>(1);
        session.writer = Some(tx);
        session.threads.push(
            thread::Builder::new()
                .name("broker-pipe-write".into())
                .spawn(move || {
                    while let Ok(request) = rx.recv() {
                        let ok = output.write_all(&request.bytes).is_ok();
                        let _ = request.done.send(ok);
                        if !ok {
                            break;
                        }
                    }
                })
                .map_err(|_| "browser_start_failed")?,
        );
        session.add_redactions(&login.username);
        session.add_redactions(&login.password);
        if let Some(otp) = &login.otp {
            session.add_redactions(otp);
        }
        let deadline = Instant::now() + START_TIME;
        session.initialize(&login, deadline)?;
        Ok(session)
    }

    fn check(&self, deadline: Instant) -> Result<(), &'static str> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("cancelled");
        }
        if self.poisoned {
            return Err("browser_policy_denied");
        }
        if Instant::now() >= deadline || Instant::now() >= self.expires {
            return Err("browser_timeout");
        }
        Ok(())
    }

    fn send(
        &mut self,
        method: &str,
        params: &str,
        target: Option<&str>,
        deadline: Instant,
    ) -> Result<u64, &'static str> {
        self.check(deadline)?;
        let id = self.next_id;
        self.next_id += 1;
        let target = target
            .map(|value| {
                format!(
                    ",\"sessionId\":{}",
                    serde_json::to_string(value).unwrap_or_default()
                )
            })
            .unwrap_or_default();
        let mut frame = Zeroizing::new(
            format!("{{\"id\":{id},\"method\":\"{method}\",\"params\":{params}{target}}}")
                .into_bytes(),
        );
        frame.push(0);
        if frame.len() > COMMAND_MAX {
            return Err("browser_command_limit");
        }
        let (done, completed) = mpsc::sync_channel(1);
        self.writer
            .as_ref()
            .ok_or("browser_closed")?
            .try_send(WriteRequest { bytes: frame, done })
            .map_err(|_| "browser_busy")?;
        loop {
            self.check(deadline)?;
            match completed
                .recv_timeout(TICK.min(deadline.saturating_duration_since(Instant::now())))
            {
                Ok(true) => return Ok(id),
                Ok(false) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("browser_closed");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn command(
        &mut self,
        method: &str,
        params: Value,
        target: Option<&str>,
        deadline: Instant,
    ) -> Result<Value, &'static str> {
        let params =
            Zeroizing::new(serde_json::to_string(&params).map_err(|_| "browser_protocol_failed")?);
        self.command_raw(method, &params, target, deadline)
    }

    fn command_raw(
        &mut self,
        method: &str,
        params: &str,
        target: Option<&str>,
        deadline: Instant,
    ) -> Result<Value, &'static str> {
        let deadline = deadline.min(Instant::now() + COMMAND_TIME);
        let id = self.send(method, params, target, deadline)?;
        loop {
            self.check(deadline)?;
            if let Some(mut reply) = self.replies.remove(&id) {
                let failed = reply.get("error").is_some();
                let result = reply
                    .get_mut("result")
                    .map(Value::take)
                    .unwrap_or(Value::Null);
                wipe_json(&mut reply);
                if failed {
                    return Err("browser_command_failed");
                }
                return Ok(result);
            }
            self.pump(deadline)?;
        }
    }

    fn pump(&mut self, deadline: Instant) -> Result<(), &'static str> {
        self.check(deadline)?;
        let received = self
            .reader
            .as_ref()
            .ok_or("browser_closed")?
            .recv_timeout(TICK.min(deadline.saturating_duration_since(Instant::now())));
        match received {
            Ok(Ok(frame)) => {
                let mut value: Value =
                    serde_json::from_slice(&frame).map_err(|_| "browser_protocol_failed")?;
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if self.acknowledgements.remove(&id) {
                        let failed = value.get("error").is_some();
                        wipe_json(&mut value);
                        return if failed {
                            Err("browser_command_failed")
                        } else {
                            Ok(())
                        };
                    }
                    if self.replies.len() >= 64 {
                        return Err("browser_event_limit");
                    }
                    self.replies.insert(id, value);
                    Ok(())
                } else {
                    self.event(value, deadline)
                }
            }
            Ok(Err(())) | Err(mpsc::RecvTimeoutError::Disconnected) => Err("browser_closed"),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(()),
        }
    }

    fn notify(
        &mut self,
        method: &str,
        params: &str,
        target: Option<&str>,
        deadline: Instant,
    ) -> Result<(), &'static str> {
        if self.acknowledgements.len() >= 128 {
            return Err("browser_event_limit");
        }
        let id = self.send(method, params, target, deadline)?;
        self.acknowledgements.insert(id);
        Ok(())
    }

    fn event(&mut self, mut value: Value, deadline: Instant) -> Result<(), &'static str> {
        let result = self.event_inner(&value, deadline);
        wipe_json(&mut value);
        result
    }

    fn event_inner(&mut self, value: &Value, deadline: Instant) -> Result<(), &'static str> {
        let method = value["method"].as_str().unwrap_or("");
        let params = &value["params"];
        let target = value["sessionId"].as_str();
        match method {
            "Fetch.requestPaused" => {
                let id = params["requestId"]
                    .as_str()
                    .ok_or("browser_protocol_failed")?;
                let allowed = params["request"]["url"]
                    .as_str()
                    .is_some_and(|url| approved_url(url, &self.origin));
                if !allowed {
                    // Requests are held before any bytes reach the destination.
                    self.notify(
                        "Fetch.failRequest",
                        &json!({"requestId":id,"errorReason":"BlockedByClient"}).to_string(),
                        target,
                        deadline,
                    )?;
                    if params["resourceType"] == "Document" {
                        self.poisoned = true;
                        return Err("browser_policy_denied");
                    }
                } else if params.get("responseStatusCode").is_some() {
                    let mut headers = params["responseHeaders"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    headers.push(json!({"name":"Content-Security-Policy","value":
                        "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; form-action 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'; sandbox allow-scripts allow-same-origin allow-forms"}));
                    headers.push(json!({"name":"Cache-Control","value":"no-store"}));
                    self.notify(
                        "Fetch.continueResponse",
                        &json!({"requestId":id,"responseHeaders":headers,
                        "responseCode":params["responseStatusCode"]})
                        .to_string(),
                        target,
                        deadline,
                    )?;
                } else {
                    self.notify(
                        "Fetch.continueRequest",
                        &json!({"requestId":id}).to_string(),
                        target,
                        deadline,
                    )?;
                }
            }
            "Target.attachedToTarget" => {
                let attached = params["sessionId"]
                    .as_str()
                    .ok_or("browser_protocol_failed")?;
                let kind = params["targetInfo"]["type"].as_str().unwrap_or("");
                if !matches!(kind, "page" | "iframe") {
                    self.poisoned = true;
                    return Err("browser_policy_denied");
                }
                self.configure(attached, deadline)?;
                self.command(
                    "Runtime.runIfWaitingForDebugger",
                    json!({}),
                    Some(attached),
                    deadline,
                )?;
            }
            "Page.frameNavigated" => {
                let url = params["frame"]["url"].as_str().unwrap_or("");
                if url != "about:blank" && !approved_url(url, &self.origin) {
                    self.poisoned = true;
                    return Err("browser_policy_denied");
                }
                if params["frame"].get("parentId").is_none()
                    && target == Some(self.target_session.as_str())
                {
                    self.navigations += 1;
                    self.current_url = url.to_owned();
                }
            }
            "Inspector.targetCrashed" | "Target.targetCrashed" | "Inspector.detached" => {
                return Err("browser_closed");
            }
            _ => {}
        }
        Ok(())
    }

    fn configure(&mut self, target: &str, deadline: Instant) -> Result<(), &'static str> {
        if self.configured.contains(target) {
            return Ok(());
        }
        if self.configured.len() >= 8 {
            return Err("browser_target_limit");
        }
        self.configured.insert(target.to_owned());
        self.command("Fetch.enable", json!({"patterns":[
            {"urlPattern":"*","requestStage":"Request"}, {"urlPattern":"*","requestStage":"Response"}
        ]}), Some(target), deadline)?;
        self.command(
            "Network.setBypassServiceWorker",
            json!({"bypass":true}),
            Some(target),
            deadline,
        )?;
        self.command(
            "Network.setCacheDisabled",
            json!({"cacheDisabled":true}),
            Some(target),
            deadline,
        )?;
        self.command("Page.enable", json!({}), Some(target), deadline)?;
        self.command(
            "Target.setAutoAttach",
            json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
            Some(target),
            deadline,
        )?;
        Ok(())
    }

    fn initialize(&mut self, login: &Login, deadline: Instant) -> Result<(), &'static str> {
        let context = self.command(
            "Target.createBrowserContext",
            json!({"disposeOnDetach":true}),
            None,
            deadline,
        )?;
        let context = context["browserContextId"]
            .as_str()
            .ok_or("browser_protocol_failed")?;
        let page = self.command(
            "Target.createTarget",
            json!({"url":"about:blank","browserContextId":context}),
            None,
            deadline,
        )?;
        let page = page["targetId"].as_str().ok_or("browser_protocol_failed")?;
        let attached = self.command(
            "Target.attachToTarget",
            json!({"targetId":page,"flatten":true}),
            None,
            deadline,
        )?;
        self.target_session = attached["sessionId"]
            .as_str()
            .ok_or("browser_protocol_failed")?
            .to_owned();
        let target = self.target_session.clone();
        self.configure(&target, deadline)?;
        self.navigate(&login.url, deadline.min(Instant::now() + NAVIGATION_TIME))?;
        let user = Zeroizing::new(
            serde_json::to_string(login.username.as_str()).map_err(|_| "unsupported_login")?,
        );
        let password = Zeroizing::new(
            serde_json::to_string(login.password.as_str()).map_err(|_| "unsupported_login")?,
        );
        let otp = Zeroizing::new(match &login.otp {
            Some(otp) => serde_json::to_string(otp.as_str()).map_err(|_| "unsupported_login")?,
            None => "null".to_owned(),
        });
        let expression = Zeroizing::new(format!(
            "({LOGIN_JS})({},{},{})",
            user.as_str(),
            password.as_str(),
            otp.as_str()
        ));
        let before = self.navigations;
        let result = self.evaluate(&expression, deadline)?;
        if result != Value::Bool(true) {
            return Err("unsupported_login");
        }
        let deadline = deadline.min(Instant::now() + NAVIGATION_TIME);
        loop {
            self.pump(deadline)?;
            if self.navigations > before && self.evaluate(READY_JS, deadline)? == Value::Bool(true)
            {
                return Ok(());
            }
        }
    }

    fn evaluate(&mut self, expression: &str, deadline: Instant) -> Result<Value, &'static str> {
        let encoded = Zeroizing::new(
            serde_json::to_string(expression).map_err(|_| "browser_protocol_failed")?,
        );
        let params = Zeroizing::new(format!(
            "{{\"expression\":{},\"returnByValue\":true,\"userGesture\":false,\"timeout\":3000}}",
            encoded.as_str()
        ));
        let target = self.target_session.clone();
        let mut result = self.command_raw("Runtime.evaluate", &params, Some(&target), deadline)?;
        let failed = result.get("exceptionDetails").is_some();
        let value = result["result"].get_mut("value").map(Value::take);
        wipe_json(&mut result);
        if failed {
            return Err("unsupported_page");
        }
        value.ok_or("unsupported_page")
    }

    fn navigate(&mut self, url: &str, deadline: Instant) -> Result<(), &'static str> {
        if !approved_url(url, &self.origin) {
            return Err("invalid_path");
        }
        let before = self.navigations;
        let target = self.target_session.clone();
        let result = self.command("Page.navigate", json!({"url":url}), Some(&target), deadline)?;
        if result.get("errorText").is_some() {
            return Err("navigation_failed");
        }
        loop {
            self.pump(deadline)?;
            if self.navigations > before
                && self.evaluate("document.readyState === 'complete'", deadline)?
                    == Value::Bool(true)
            {
                return Ok(());
            }
        }
    }

    /// Owner-only fixed operation in an isolated world; website JavaScript cannot replace fetch.
    pub fn deliver(&mut self, recipient: &str, document: &str) -> &'static str {
        let outcome = self.deliver_inner(recipient, document).unwrap_or("unknown");
        self.close();
        outcome
    }
    fn deliver_inner(
        &mut self,
        recipient: &str,
        document: &str,
    ) -> Result<&'static str, &'static str> {
        let deadline = Instant::now() + COMMAND_TIME;
        self.check(deadline)?;
        if document.len() > 16000 || !approved_url(recipient, &self.origin) {
            return Ok("failed");
        }
        let target = self.target_session.clone();
        let tree = self.command("Page.getFrameTree", json!({}), Some(&target), deadline)?;
        let frame = tree["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or("browser_protocol_failed")?;
        let world = self.command(
            "Page.createIsolatedWorld",
            json!({"frameId":frame,"worldName":"HeavenKey protected delivery"}),
            Some(&target),
            deadline,
        )?;
        let context = world["executionContextId"]
            .as_u64()
            .ok_or("browser_protocol_failed")?;
        let url = Zeroizing::new(
            serde_json::to_string(recipient).map_err(|_| "browser_protocol_failed")?,
        );
        let body =
            Zeroizing::new(serde_json::to_string(document).map_err(|_| "browser_protocol_failed")?);
        let expression = Zeroizing::new(format!(
            "(async()=>{{try{{const r=await fetch({},{{method:'POST',credentials:'include',redirect:'error',cache:'no-store',headers:{{'Content-Type':'text/plain;charset=UTF-8'}},body:{}}});return r.ok?'accepted':'failed';}}catch{{return 'unknown';}}}})()",
            url.as_str(),
            body.as_str()
        ));
        let encoded = Zeroizing::new(
            serde_json::to_string(expression.as_str()).map_err(|_| "browser_protocol_failed")?,
        );
        let params = Zeroizing::new(format!(
            "{{\"expression\":{},\"contextId\":{context},\"returnByValue\":true,\"awaitPromise\":true,\"timeout\":4000}}",
            encoded.as_str()
        ));
        let mut reply = self.command_raw("Runtime.evaluate", &params, Some(&target), deadline)?;
        let outcome = if reply.get("exceptionDetails").is_some() {
            "unknown"
        } else {
            match reply["result"]["value"].as_str() {
                Some("accepted") => "accepted",
                Some("failed") => "failed",
                _ => "unknown",
            }
        };
        wipe_json(&mut reply);
        Ok(outcome)
    }

    pub fn read(&mut self, path: &str) -> Result<Value, &'static str> {
        let result = self.read_inner(path);
        if result.is_err() {
            self.close();
        }
        result
    }

    fn read_inner(&mut self, path: &str) -> Result<Value, &'static str> {
        let deadline = Instant::now() + NAVIGATION_TIME;
        self.check(deadline)?;
        if path.len() > 2048
            || !path.starts_with('/')
            || path.contains("//")
            || path
                .chars()
                .any(|c| c.is_control() || matches!(c, '\\' | '?' | '#'))
        {
            return Err("invalid_path");
        }
        let url = self.origin.join(path).map_err(|_| "invalid_path")?;
        if !approved_url(url.as_str(), &self.origin)
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("invalid_path");
        }
        if self.current_url != url.as_str() {
            self.navigate(url.as_str(), deadline)?;
        }
        let mut raw = self.evaluate(EXTRACT_JS, deadline)?;
        self.check(deadline)?;
        let actual = raw["url"].as_str().ok_or("unsupported_page")?;
        if !approved_url(actual, &self.origin) {
            self.poisoned = true;
            return Err("browser_policy_denied");
        }
        let url = self.redact(actual, 4096);
        let title = self.redact(raw["title"].as_str().ok_or("unsupported_page")?, 200);
        let text = self.redact(raw["text"].as_str().ok_or("unsupported_page")?, 8000);
        let mut links = Vec::new();
        for link in raw["links"]
            .as_array()
            .ok_or("unsupported_page")?
            .iter()
            .take(20)
        {
            let Some(path) = link["path"].as_str() else {
                continue;
            };
            if !path.starts_with('/') || path.contains("//") || path.contains(['?', '#', '\\']) {
                continue;
            }
            let Ok(parsed) = self.origin.join(path) else {
                continue;
            };
            if !approved_url(parsed.as_str(), &self.origin) {
                continue;
            }
            links.push(json!({"label":self.redact(link["label"].as_str().unwrap_or(""),200),"path":self.redact(path,2048)}));
        }
        wipe_json(&mut raw);
        Ok(json!({"url":url,"title":title,"text":text,"links":links}))
    }

    fn add_redactions(&mut self, secret: &str) {
        if secret.is_empty() {
            return;
        }
        let percent = |all: bool, lowercase: bool| {
            let mut encoded = String::new();
            for b in secret.bytes() {
                if !all && (b.is_ascii_alphanumeric() || b"-_.~".contains(&b)) {
                    encoded.push(b as char);
                } else {
                    use std::fmt::Write;
                    if lowercase {
                        let _ = write!(encoded, "%{b:02x}");
                    } else {
                        let _ = write!(encoded, "%{b:02X}");
                    }
                }
            }
            encoded
        };
        let encoded = percent(false, false);
        let mut variants = vec![
            secret.to_owned(),
            encoded.clone(),
            percent(false, true),
            encoded.replace("%20", "+"),
            percent(true, false),
            percent(true, true),
            STANDARD.encode(secret),
            URL_SAFE_NO_PAD.encode(secret),
            STANDARD.encode(secret).trim_end_matches('=').to_owned(),
            secret
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
                .replace('\'', "&#39;"),
            secret
                .chars()
                .map(|c| format!("&#{};", c as u32))
                .collect::<String>(),
            secret
                .chars()
                .map(|c| format!("&#x{:x};", c as u32))
                .collect::<String>(),
        ];
        variants.sort_by_key(|value| std::cmp::Reverse(value.len()));
        self.secrets
            .extend(variants.into_iter().map(Zeroizing::new));
        self.secrets
            .sort_by_key(|value| std::cmp::Reverse(value.len()));
    }

    fn redact(&self, input: &str, maximum: usize) -> String {
        let mut result = Zeroizing::new(input.to_owned());
        let marker = if self
            .secrets
            .iter()
            .any(|secret| "[redacted]".contains(secret.as_str()))
        {
            ""
        } else {
            "[redacted]"
        };
        for secret in &self.secrets {
            let mut replaced = Zeroizing::new(result.replace(secret.as_str(), marker));
            std::mem::swap(&mut result, &mut replaced);
        }
        // Deletions can concatenate fragments into another known credential.
        // Fail closed instead of returning a newly formed secret or looping.
        if self
            .secrets
            .iter()
            .any(|secret| result.contains(secret.as_str()))
        {
            return String::new();
        }
        result.chars().take(maximum).collect()
    }

    fn close(&mut self) {
        self.poisoned = true;
        self.writer.take();
        // Drop the receiver before killing: a reader blocked on a full bounded
        // channel must also wake, even when Chromium already exited.
        self.reader.take();
        if let Some(mut child) = self.child.take() {
            uac_browser_pipe::terminate(&mut child);
        }
        for worker in self.threads.drain(..) {
            let _ = worker.join();
        }
        for reply in self.replies.values_mut() {
            wipe_json(reply);
        }
        self.replies.clear();
        self.acknowledgements.clear();
        self.secrets.clear();
        let _ = fs::remove_dir_all(&self.profile);
    }
}

impl Drop for BrowserSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn wipe_json(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(wipe_json),
        Value::Object(values) => values.values_mut().for_each(wipe_json),
        _ => {}
    }
}

const LOGIN_JS: &str = r#"(username,password,otp) => {
    if (window !== window.top || location.origin === 'null') return false;
    const visible = e => {
        if(e.disabled || e.readOnly || e.closest('[hidden],[aria-hidden="true"]')) return false;
        const r=e.getBoundingClientRect();
        if(r.width<1 || r.height<1 || r.bottom<=0 || r.right<=0 || r.top>=innerHeight || r.left>=innerWidth) return false;
        for(let p=e;p;p=p.parentElement) { const s=getComputedStyle(p);
            if(s.display==='none' || s.visibility!=='visible' || Number(s.opacity)===0) return false; }
        return true;
    };
    const passwords = [...document.querySelectorAll('input[type=password]')].filter(visible);
    if (passwords.length !== 1) return false;
    const p = passwords[0], form = p.form;
    if (!form || !p.name || new URL(form.action || location.href, location.href).origin !== location.origin ||
        (form.target && form.target !== '_self') || form.method.toLowerCase() !== 'post') return false;
    const users = [...form.querySelectorAll('input')].filter(e => visible(e) &&
        ['text','email'].includes(e.type) && e.autocomplete !== 'one-time-code');
    if (users.length !== 1 || !users[0].name) return false;
    const otps = [...form.querySelectorAll('input[autocomplete="one-time-code"]')].filter(visible);
    if (otp !== null && (otps.length !== 1 || !otps[0].name)) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(users[0], username); set.call(p, password);
    if (otp !== null) set.call(otps[0], otp);
    // Native submission avoids site submit handlers changing the destination or method.
    HTMLFormElement.prototype.submit.call(form);
    return true;
}"#;

const READY_JS: &str = "document.readyState === 'complete' && ![...document.querySelectorAll('input[type=password]')].some(e => e.value.length > 0)";

const EXTRACT_JS: &str = r#"(() => {
    const blocked = 'input,textarea,select,button,option,script,style,noscript,template,iframe,object,embed,[hidden],[aria-hidden="true"]';
    const visible = e => { if (!e || e.closest(blocked)) return false;
        for (let p=e;p;p=p.parentElement) { const s=getComputedStyle(p);
            if (s.display==='none'||s.visibility!=='visible'||s.opacity==='0') return false; }
        return e.getClientRects().length>0; };
    let text='', count=0;
    const walker=document.createTreeWalker(document.body || document.documentElement,NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && count++<10000 && text.length<65536) {
        const n=walker.currentNode;
        if(visible(n.parentElement)) text+=n.textContent.slice(0,65536-text.length)+' ';
    }
    const links=[];
    for(const a of document.querySelectorAll('a[href]')) {
        if(links.length>=20) break;
        if(!visible(a)) continue;
        let u;try{u=new URL(a.href,location.href);}catch{continue;}
        if(u.origin!==location.origin||u.username||u.password||u.search||u.hash||u.pathname.length>2048) continue;
        let label='',n=0;const w=document.createTreeWalker(a,NodeFilter.SHOW_TEXT);
        while(w.nextNode()&&n++<1000&&label.length<32768) if(visible(w.currentNode.parentElement)) label+=w.currentNode.textContent.slice(0,32768-label.length);
        links.push({label,path:u.pathname});
    }
    return {url:location.href,title:document.title.slice(0,32768),text,links};
})()"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn private_browser_command_avoids_host_keychain_without_relaxing_isolation() {
        use std::os::unix::fs::PermissionsExt;
        let profile = private_profile().unwrap();
        assert_eq!(
            fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let command = browser_command(
            Path::new("/synthetic/chromium"),
            &profile,
            "MAP localhost 127.0.0.1, MAP * ~NOTFOUND",
        );
        let args: Vec<_> = command
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        fs::remove_dir_all(&profile).unwrap();
        assert!(
            args.iter().any(|arg| arg == "--use-mock-keychain"),
            "Ephemeral macOS Chromium must avoid host Safe Storage prompts"
        );
        for required in [
            "--incognito",
            "--headless=new",
            "--password-store=basic",
            "--disable-sync",
            "--no-proxy-server",
        ] {
            assert!(args.iter().any(|arg| arg == required));
        }
        assert!(
            args.iter()
                .any(|arg| arg == &format!("--user-data-dir={}", profile.display()))
        );
        assert!(
            args.iter()
                .any(|arg| arg.starts_with("--host-resolver-rules=MAP localhost 127.0.0.1"))
        );
        for forbidden in [
            "--no-sandbox",
            "--disable-web-security",
            "--ignore-certificate-errors",
            "--allow-insecure-localhost",
        ] {
            assert!(!args.iter().any(|arg| arg.starts_with(forbidden)));
        }
    }

    #[test]
    fn dns_all_answers_must_be_public_and_chromium_is_pinned_to_one() {
        let origin = Url::parse("https://synthetic.test/").unwrap();
        let parse = |s: &str| s.parse::<std::net::IpAddr>().unwrap();
        assert_eq!(
            validated_pin(&origin, &[parse("93.184.216.34"), parse("1.1.1.1")]).unwrap(),
            "MAP synthetic.test 93.184.216.34, MAP * ~NOTFOUND"
        );
        assert!(validated_pin(&origin, &[]).is_err());
        for ip in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "100::1",
            "2001:db8::1",
            "2002:7f00:1::1",
            "3fff::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
        ] {
            assert!(
                validated_pin(&origin, &[parse("93.184.216.34"), parse(ip)]).is_err(),
                "{ip}"
            );
        }
        assert!(public_ip(parse("2606:4700:4700::1111")));
        let local = Url::parse("http://localhost:1234/").unwrap();
        assert!(validated_pin(&local, &[parse("127.0.0.1"), parse("::1")]).is_ok());
        assert!(validated_pin(&local, &[parse("1.1.1.1")]).is_err());
    }

    #[test]
    fn redaction_handles_mixed_case_encoding_and_marker_credentials() {
        let mut session = BrowserSession {
            child: None,
            profile: private_profile().unwrap(),
            reader: None,
            writer: None,
            threads: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            origin: Url::parse("https://example.test/").unwrap(),
            target_session: String::new(),
            next_id: 1,
            replies: HashMap::new(),
            acknowledgements: HashSet::new(),
            configured: HashSet::new(),
            secrets: Vec::new(),
            navigations: 0,
            current_url: String::new(),
            expires: Instant::now() + SESSION_TIME,
            poisoned: false,
        };
        session.add_redactions("Ab:Cd");
        assert_eq!(session.redact("Ab%3aCd", 200), "[redacted]");
        session.add_redactions("[redacted]");
        assert_eq!(session.redact("Ab:Cd [redacted]", 200), " ");
        session.add_redactions("b");
        session.add_redactions("ac");
        assert_eq!(session.redact("abc", 200), "");
    }

    #[test]
    fn origin_comparison_rejects_credentials_and_cross_origin() {
        let origin = Url::parse("https://example.test/").unwrap();
        assert!(approved_url("https://example.test:443/account", &origin));
        for url in [
            "https://other.test/",
            "http://example.test/",
            "https://a@example.test/",
            "data:text/plain,test",
        ] {
            assert!(!approved_url(url, &origin));
        }
    }

    #[test]
    #[ignore = "requires installed Chromium; uses only synthetic localhost credentials"]
    fn synthetic_pipe_login_read_and_cleanup() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let forbidden = TcpListener::bind("127.0.0.1:0").unwrap();
        forbidden.set_nonblocking(true).unwrap();
        let forbidden_address = forbidden.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = stop.clone();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(70);
            while !server_stop.load(Ordering::Acquire) && Instant::now() < deadline {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(_) => break,
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = [0; 16384];
                let mut n = socket.read(&mut buffer).unwrap_or(0);
                loop {
                    let headers = String::from_utf8_lossy(&buffer[..n]);
                    let Some(end) = headers.find("\r\n\r\n") else {
                        if n == buffer.len() {
                            break;
                        }
                        match socket.read(&mut buffer[n..]) {
                            Ok(0) | Err(_) => break,
                            Ok(count) => n += count,
                        }
                        continue;
                    };
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if n >= end + 4 + length || n == buffer.len() {
                        break;
                    }
                    match socket.read(&mut buffer[n..]) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => n += count,
                    }
                }
                let request = String::from_utf8_lossy(&buffer[..n]);
                let response = if request.starts_with("POST /login ") {
                    assert!(
                        request
                            .ends_with("username=canary-user&password=canary-password&otp=123456"),
                        "native form did not send expected synthetic credentials"
                    );
                    "HTTP/1.1 303 See Other\r\nLocation: /account\r\nSet-Cookie: fixture=synthetic-cookie; HttpOnly; SameSite=Strict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
                } else if request.starts_with("POST /inbox ") {
                    assert!(request.contains("fixture=synthetic-cookie"));
                    assert!(
                        request
                            .to_ascii_lowercase()
                            .contains("content-type: text/plain;charset=utf-8")
                    );
                    assert!(request.ends_with("synthetic owner document"));
                    "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_owned()
                } else if request.starts_with("GET /offsite ") {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://{forbidden_address}/capture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                } else if request.starts_with("GET /stall ") {
                    while !server_stop.load(Ordering::Acquire) && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(10));
                    }
                    continue;
                } else if request.starts_with("GET /account ")
                    && request.contains("fixture=synthetic-cookie")
                {
                    let body = "<!doctype html><title>Fixture</title><h1>Signed in</h1><p>canary-user | canary-password | 123456 | Y2FuYXJ5LXBhc3N3b3Jk</p><input value='hidden-canary'><p hidden>hidden-marker</p><a href='/account'>Account</a><a href='https://example.invalid/'>External</a>";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                } else {
                    let body = "<!doctype html><title>Login</title><form method='post' action='/login'><input name='username' autocomplete='username'><input name='password' type='password'><input name='otp' autocomplete='one-time-code'><button>Login</button></form>";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                let _ = socket.write_all(response.as_bytes());
            }
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let result = BrowserSession::start(
            Login {
                url: format!("http://localhost:{}/", address.port()),
                username: Zeroizing::new("canary-user".into()),
                password: Zeroizing::new("canary-password".into()),
                otp: Some(Zeroizing::new("123456".into())),
            },
            cancel.clone(),
        );
        let mut session = result.expect("private pipe login");
        let profile = session.profile.clone();
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt;
            let output = Command::new("ps")
                .args([
                    "-p",
                    &session.child.as_ref().unwrap().id().to_string(),
                    "-o",
                    "command=",
                ])
                .output()
                .unwrap();
            assert!(output.status.success());
            let argv = String::from_utf8(output.stdout).unwrap();
            let required = [
                "--use-mock-keychain",
                "--incognito",
                "--headless=new",
                "--password-store=basic",
                "--no-proxy-server",
                "--remote-debugging-pipe",
            ];
            for flag in required {
                assert!(argv.contains(flag), "missing private browser flag {flag}");
            }
            for flag in [
                "--no-sandbox",
                "--ignore-certificate-errors",
                "--disable-web-security",
                "--allow-insecure-localhost",
            ] {
                assert!(
                    !argv.contains(flag),
                    "unexpected private browser flag {flag}"
                );
            }
            assert!(argv.contains(&format!("--user-data-dir={}", profile.display())));
            assert_eq!(
                fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
                0o700
            );
            println!(
                "private_browser_argv_flags={}",
                json!({"flags":required,"private_profile":true,"profile_mode_octal":"0700","tls_validation_disabled":false,"sandbox_disabled":false,"physical_popup_observed":false})
            );
        }
        let result = session.read("/account").expect("restricted read");
        let serialized = result.to_string();
        assert!(serialized.contains("Signed in"));
        for canary in [
            "canary-user",
            "canary-password",
            "123456",
            "Y2FuYXJ5LXBhc3N3b3Jk",
            "hidden-canary",
            "hidden-marker",
            "synthetic-cookie",
            "example.invalid",
        ] {
            assert!(!serialized.contains(canary), "canary leaked");
        }
        assert_eq!(result["links"].as_array().unwrap().len(), 1);
        let mut delivery = BrowserSession::start(
            Login {
                url: format!("http://localhost:{}/", address.port()),
                username: Zeroizing::new("canary-user".into()),
                password: Zeroizing::new("canary-password".into()),
                otp: Some(Zeroizing::new("123456".into())),
            },
            Arc::new(AtomicBool::new(false)),
        )
        .expect("delivery private browser");
        let delivery_profile = delivery.profile.clone();
        assert_eq!(
            delivery.deliver(
                &format!("http://localhost:{}/inbox", address.port()),
                "synthetic owner document"
            ),
            "accepted"
        );
        assert!(!delivery_profile.exists());
        drop(delivery);
        let mut redirected = BrowserSession::start(
            Login {
                url: format!("http://localhost:{}/", address.port()),
                username: Zeroizing::new("canary-user".into()),
                password: Zeroizing::new("canary-password".into()),
                otp: Some(Zeroizing::new("123456".into())),
            },
            Arc::new(AtomicBool::new(false)),
        )
        .expect("second isolated private browser");
        let redirected_profile = redirected.profile.clone();
        assert_eq!(
            redirected.read("/offsite").unwrap_err(),
            "browser_policy_denied"
        );
        assert!(!redirected_profile.exists());
        drop(redirected);
        let cancellation = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            cancel.store(true, Ordering::Release);
            Instant::now()
        });
        assert_eq!(session.read("/stall").unwrap_err(), "cancelled");
        let cancelled_at = cancellation.join().unwrap();
        assert!(cancelled_at.elapsed() < Duration::from_millis(500));
        println!(
            "broker fixture: native POST + private cookie + filtered projection + blocked cross-origin redirect + cancellation/profile cleanup ({} ms after cancellation)",
            cancelled_at.elapsed().as_millis()
        );
        assert!(!profile.exists());
        stop.store(true, Ordering::Release);
        server.join().unwrap();
        assert!(
            forbidden.accept().is_err(),
            "cross-origin connection reached forbidden listener"
        );
    }
}
