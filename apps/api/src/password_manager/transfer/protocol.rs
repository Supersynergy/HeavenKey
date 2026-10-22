use super::{MAX_BYTES, TransferProfile, TransferRequest};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use ssh2::{OpenFlags, OpenType, RenameFlags, Session};
use std::{
    io::{Read, Write},
    net::{IpAddr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, &'static str>;
const STEP: Duration = Duration::from_secs(8);
const DEADLINE: Duration = Duration::from_secs(30);

static DNS_ACTIVE: OnceLock<Arc<AtomicUsize>> = OnceLock::new();
fn resolve(
    host: String,
    port: u16,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<SocketAddr>> {
    if cancel.load(Ordering::SeqCst) {
        return Err("transfer_revoked");
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    resolve_with(
        host,
        port,
        cancel,
        deadline,
        DNS_ACTIVE
            .get_or_init(|| Arc::new(AtomicUsize::new(0)))
            .clone(),
        |host, port| {
            (host.as_str(), port)
                .to_socket_addrs()
                .map(|addresses| addresses.take(16).collect())
                .map_err(|_| "transfer_connect_failed")
        },
    )
}
fn resolve_with(
    host: String,
    port: u16,
    cancel: &AtomicBool,
    deadline: Instant,
    active: Arc<AtomicUsize>,
    resolver: impl FnOnce(String, u16) -> Result<Vec<SocketAddr>> + Send + 'static,
) -> Result<Vec<SocketAddr>> {
    if cancel.load(Ordering::SeqCst) {
        return Err("transfer_revoked");
    }
    if Instant::now() >= deadline {
        return Err("transfer_dns_timeout");
    }
    let permit = super::Permit::acquire(active, 2).ok_or("transfer_dns_busy")?;
    let (tx, rx) = mpsc::sync_channel(1);
    // This thread holds only endpoint data; no credentials, profile, or owner/client handles.
    std::thread::Builder::new()
        .name("transfer-dns".into())
        .spawn(move || {
            let _permit = permit;
            let result = resolver(host, port);
            let _ = tx.send(result);
        })
        .map_err(|_| "transfer_dns_busy")?;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("transfer_revoked");
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("transfer_dns_timeout");
        }
        match rx.recv_timeout(remaining.min(Duration::from_millis(25))) {
            Ok(result) => {
                if cancel.load(Ordering::SeqCst) {
                    return Err("transfer_revoked");
                }
                if Instant::now() >= deadline {
                    return Err("transfer_dns_timeout");
                }
                return result;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("transfer_connect_failed"),
        }
    }
}

struct SocketGuard {
    done: Arc<AtomicBool>,
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        self.done.store(true, Ordering::SeqCst);
    }
}
fn connect(p: &TransferProfile, cancel: Arc<AtomicBool>) -> Result<(TcpStream, SocketGuard)> {
    let deadline = Instant::now() + DEADLINE;
    let addrs = resolve(
        p.host.clone(),
        p.port,
        &cancel,
        deadline.min(Instant::now() + STEP),
    )?;
    let connect_deadline = deadline.min(Instant::now() + STEP);
    let mut connected = None;
    for addr in addrs {
        if addr.ip().is_unspecified() || addr.ip().is_multicast() || addr.port() == 0 {
            continue;
        }
        let remaining = connect_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || cancel.load(Ordering::SeqCst) {
            break;
        }
        if let Ok(stream) = TcpStream::connect_timeout(&addr, remaining) {
            connected = Some(stream);
            break;
        }
    }
    let stream = connected.ok_or("transfer_connect_failed")?;
    stream
        .set_read_timeout(Some(STEP))
        .map_err(|_| "transfer_connect_failed")?;
    stream
        .set_write_timeout(Some(STEP))
        .map_err(|_| "transfer_connect_failed")?;
    let socket = stream.try_clone().map_err(|_| "transfer_connect_failed")?;
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone();
    std::thread::Builder::new()
        .name("transfer-deadline".into())
        .spawn(move || {
            while !finished.load(Ordering::SeqCst) {
                if cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
                    cancel.store(true, Ordering::SeqCst);
                    let _ = socket.shutdown(Shutdown::Both);
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        })
        .map_err(|_| "transfer_busy")?;
    Ok((stream, SocketGuard { done }))
}
fn bounded_read(r: &mut impl Read, cancel: &AtomicBool) -> Result<Zeroizing<Vec<u8>>> {
    let mut output = Zeroizing::new(Vec::new());
    let mut buf = Zeroizing::new([0u8; 16384]);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("transfer_revoked");
        }
        let n = r.read(&mut *buf).map_err(|_| "transfer_io_failed")?;
        if n == 0 {
            break;
        }
        if output.len() + n > MAX_BYTES {
            return Err("transfer_size_limit");
        }
        output.extend_from_slice(&buf[..n]);
    }
    Ok(output)
}
fn content(data: &[u8]) -> Value {
    json!({"content":URL_SAFE_NO_PAD.encode(data),"sha256":format!("{:x}",Sha256::digest(data)),"bytes":data.len()})
}
fn file_type(mode: Option<u32>) -> Result<&'static str> {
    match mode.map(|m| m & 0o170000) {
        Some(0o100000) => Ok("file"),
        Some(0o040000) => Ok("directory"),
        _ => Err("transfer_path_denied"),
    }
}
// Best-effort path checks do not provide openat/no-follow guarantees across remote races.
// The configured account's server-enforced jail supplies the security boundary.
fn checked_sftp_path(
    sftp: &ssh2::Sftp,
    root: &Path,
    path: &str,
    new_file: bool,
) -> Result<PathBuf> {
    let mut dest = root.to_owned();
    let parts: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    for (i, part) in parts.iter().enumerate() {
        dest.push(part);
        if new_file && i + 1 == parts.len() {
            match sftp.lstat(&dest) {
                Ok(_) => return Err("transfer_destination_exists"),
                Err(e) if e.code() == ssh2::ErrorCode::SFTP(2) => {}
                Err(_) => return Err("transfer_path_denied"),
            }
        } else {
            let stat = sftp.lstat(&dest).map_err(|_| "transfer_path_denied")?;
            let kind = file_type(stat.perm)?;
            if i + 1 < parts.len() && kind != "directory" {
                return Err("transfer_path_denied");
            }
            let canonical = sftp.realpath(&dest).map_err(|_| "transfer_path_denied")?;
            if !canonical.starts_with(root) {
                return Err("transfer_path_denied");
            }
        }
    }
    Ok(dest)
}
pub(super) fn execute(
    p: &TransferProfile,
    r: &TransferRequest,
    cancel: Arc<AtomicBool>,
    authorize: impl Fn() -> bool,
) -> Result<Value> {
    // Neither FTP metadata nor portable SFTP path prechecks can enforce a sub-root jail.
    if p.root != "/" {
        return Err("transfer_account_root_required");
    }
    if !authorize() {
        return Err("transfer_revoked");
    }
    if p.protocol == "sftp" {
        sftp(p, r, cancel, authorize)
    } else {
        ftpes(p, r, cancel, authorize)
    }
}
fn sftp(
    p: &TransferProfile,
    r: &TransferRequest,
    cancel: Arc<AtomicBool>,
    authorize: impl Fn() -> bool,
) -> Result<Value> {
    let (stream, _guard) = connect(p, cancel.clone())?;
    let mut session = Session::new().map_err(|_| "transfer_connect_failed")?;
    session.set_timeout(STEP.as_millis() as u32);
    session.set_tcp_stream(stream);
    session.handshake().map_err(|_| "transfer_connect_failed")?;
    let (key, _) = session.host_key().ok_or("transfer_host_key_mismatch")?;
    let actual = format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(key)));
    if actual != p.host_key {
        return Err("transfer_host_key_mismatch");
    }
    if !authorize() {
        return Err("transfer_revoked");
    }
    if !p.private_key.is_empty() {
        session
            .userauth_pubkey_memory(&p.username, None, &p.private_key, None)
            .map_err(|_| "transfer_auth_failed")?;
    } else {
        session
            .userauth_password(&p.username, &p.password)
            .map_err(|_| "transfer_auth_failed")?;
    }
    if !session.authenticated() {
        return Err("transfer_auth_failed");
    }
    let sftp = session.sftp().map_err(|_| "transfer_protocol_failed")?;
    let configured = Path::new(&p.root);
    let mut ancestor = PathBuf::from("/");
    for part in p.root.split('/').filter(|p| !p.is_empty()) {
        ancestor.push(part);
        if file_type(
            sftp.lstat(&ancestor)
                .map_err(|_| "transfer_path_denied")?
                .perm,
        )? != "directory"
        {
            return Err("transfer_path_denied");
        }
    }
    let root = sftp
        .realpath(configured)
        .map_err(|_| "transfer_path_denied")?;
    let dest = checked_sftp_path(&sftp, &root, &r.path, r.operation == "put")?;
    match r.operation.as_str() {
        "list" => {
            let mut directory = sftp.opendir(&dest).map_err(|_| "transfer_path_denied")?;
            let mut entries = Vec::new();
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err("transfer_revoked");
                }
                match directory.readdir() {
                    Ok((name, stat)) => {
                        let name = name.to_str().ok_or("transfer_metadata_invalid")?;
                        if matches!(name, "." | "..") {
                            continue;
                        }
                        if entries.len() >= 200 {
                            return Err("transfer_entry_limit");
                        }
                        if !super::relative_path(name, false) || name.contains('/') {
                            return Err("transfer_metadata_invalid");
                        }
                        let kind = file_type(stat.perm).unwrap_or("blocked");
                        entries.push(json!({"name":name,"type":kind,"size":stat.size}));
                    }
                    Err(e) if e.code() == ssh2::ErrorCode::Session(-16) => break,
                    Err(_) => return Err("transfer_io_failed"),
                }
            }
            Ok(json!({"entries":entries}))
        }
        "stat" => {
            let s = sftp.lstat(&dest).map_err(|_| "transfer_path_denied")?;
            Ok(json!({"type":file_type(s.perm)?,"size":s.size}))
        }
        "get" => {
            let s = sftp.lstat(&dest).map_err(|_| "transfer_path_denied")?;
            if file_type(s.perm)? != "file" || s.size.is_some_and(|s| s > MAX_BYTES as u64) {
                return Err("transfer_size_limit");
            }
            let mut file = sftp.open(&dest).map_err(|_| "transfer_io_failed")?;
            let data = bounded_read(&mut file, &cancel)?;
            Ok(content(&data))
        }
        "put" => {
            let data = Zeroizing::new(
                URL_SAFE_NO_PAD
                    .decode(r.content.as_deref().unwrap_or(""))
                    .map_err(|_| "transfer_invalid_content")?,
            );
            let parent = dest.parent().ok_or("transfer_path_denied")?;
            let temp = parent.join(format!(".heavenkey-{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| {
                let mut file = sftp
                    .open_mode(
                        &temp,
                        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
                        0o600,
                        OpenType::File,
                    )
                    .map_err(|_| "transfer_io_failed")?;
                for chunk in data.chunks(16384) {
                    if cancel.load(Ordering::SeqCst) || !authorize() {
                        return Err("transfer_revoked");
                    }
                    file.write_all(chunk).map_err(|_| "transfer_io_failed")?;
                }
                file.fsync()
                    .map_err(|_| "transfer_safe_write_unavailable")?;
                file.close().map_err(|_| "transfer_io_failed")?;
                let checked = checked_sftp_path(&sftp, &root, &r.path, true)?;
                if checked != dest || cancel.load(Ordering::SeqCst) || !authorize() {
                    return Err("transfer_revoked");
                }
                // SFTP RENAME without OVERWRITE must fail when the destination exists.
                sftp.rename(&temp, &dest, Some(RenameFlags::ATOMIC))
                    .map_err(|_| "transfer_safe_write_unavailable")?;
                Ok(json!({"sha256":r.sha256,"bytes":data.len()}))
            })();
            if result.is_err() {
                let _ = sftp.unlink(&temp);
            }
            result
        }
        _ => Err("transfer_invalid_operation"),
    }
}

fn ftp_kind(facts: &str) -> Result<&'static str> {
    for fact in facts.split(';') {
        if let Some((key, value)) = fact.trim().split_once('=')
            && key.eq_ignore_ascii_case("type")
        {
            return match value.to_ascii_lowercase().as_str() {
                "file" => Ok("file"),
                "dir" | "cdir" | "pdir" => Ok("directory"),
                _ => Err("transfer_path_denied"),
            };
        }
    }
    Err("transfer_path_denied")
}
fn tls_connector(p: &TransferProfile) -> Result<native_tls::TlsConnector> {
    let mut tls_builder = native_tls::TlsConnector::builder();
    tls_builder.min_protocol_version(Some(native_tls::Protocol::Tlsv12));
    if !p.ca_certificate.is_empty() {
        if !super::valid_ca(&p.ca_certificate) {
            return Err("transfer_tls_failed");
        }
        let ca = native_tls::Certificate::from_pem(p.ca_certificate.as_bytes())
            .map_err(|_| "transfer_tls_failed")?;
        tls_builder.add_root_certificate(ca);
    }
    tls_builder.build().map_err(|_| "transfer_tls_failed")
}

// MLST and PWD may follow symlinks; these metadata checks do not establish a jail.
// A dedicated, server-confined account must enforce the root / boundary.
fn ftp_checked(
    ftp: &mut suppaftp::NativeTlsFtpStream,
    root: &str,
    path: &str,
    write: bool,
) -> Result<(String, Option<&'static str>)> {
    let parts: Vec<_> = root
        .split('/')
        .chain(path.split('/'))
        .filter(|p| !p.is_empty())
        .collect();
    let mut absolute = String::new();
    let mut kind = Some("directory");
    for (i, part) in parts.iter().enumerate() {
        absolute.push('/');
        absolute.push_str(part);
        kind = match ftp.mlst(Some(&absolute)) {
            Ok(facts) => Some(ftp_kind(&facts)?),
            Err(suppaftp::FtpError::UnexpectedResponse(response))
                if write
                    && i + 1 == parts.len()
                    && response.status == suppaftp::Status::FileUnavailable =>
            {
                None
            }
            Err(_) => return Err("transfer_path_denied"),
        };
        if i + 1 < parts.len() && kind != Some("directory") {
            return Err("transfer_path_denied");
        }
        if kind == Some("directory") {
            ftp.cwd(&absolute).map_err(|_| "transfer_path_denied")?;
            if ftp
                .pwd()
                .map_err(|_| "transfer_path_denied")?
                .trim_end_matches('/')
                != absolute
            {
                return Err("transfer_path_denied");
            }
        }
    }
    if absolute.is_empty() {
        absolute.push('/');
        kind = Some(ftp_kind(
            &ftp.mlst(Some("/")).map_err(|_| "transfer_path_denied")?,
        )?);
    }
    if write && kind == Some("directory") {
        return Err("transfer_path_denied");
    }
    Ok((absolute, kind))
}

fn ftpes(
    p: &TransferProfile,
    r: &TransferRequest,
    cancel: Arc<AtomicBool>,
    authorize: impl Fn() -> bool,
) -> Result<Value> {
    use suppaftp::{NativeTlsConnector, NativeTlsFtpStream, Status, types::FileType};
    let (stream, _guard) = connect(p, cancel.clone())?;
    let peer = stream
        .peer_addr()
        .map_err(|_| "transfer_connect_failed")?
        .ip();
    let builder = move |addr: std::net::SocketAddr| {
        if addr.ip() != peer || addr.port() < 1024 {
            return Err(suppaftp::FtpError::ConnectionError(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "passive endpoint denied",
            )));
        }
        let stream =
            TcpStream::connect_timeout(&addr, STEP).map_err(suppaftp::FtpError::ConnectionError)?;
        stream
            .set_read_timeout(Some(STEP))
            .map_err(suppaftp::FtpError::ConnectionError)?;
        stream
            .set_write_timeout(Some(STEP))
            .map_err(suppaftp::FtpError::ConnectionError)?;
        Ok(stream)
    };
    let ftp = NativeTlsFtpStream::connect_with_stream(stream)
        .map_err(|_| "transfer_connect_failed")?
        .passive_stream_builder(builder);
    let tls = tls_connector(p)?;
    // into_secure requires AUTH TLS and PBSZ 0 / PROT P, including encrypted data channels.
    let mut ftp = ftp
        .into_secure(NativeTlsConnector::from(tls), &p.host)
        .map_err(|_| "transfer_tls_failed")?;
    if !authorize() {
        return Err("transfer_revoked");
    }
    ftp.login(&p.username, &p.password)
        .map_err(|_| "transfer_auth_failed")?;
    ftp.transfer_type(FileType::Binary)
        .map_err(|_| "transfer_protocol_failed")?;
    let (path, kind) = ftp_checked(&mut ftp, &p.root, &r.path, r.operation == "put")?;
    if cancel.load(Ordering::SeqCst) || !authorize() {
        return Err("transfer_revoked");
    }
    match r.operation.as_str() {
        "stat" => Ok(
            json!({"type":kind.ok_or("transfer_path_denied")?,"size":if kind == Some("file") { ftp.size(&path).ok() } else { None }}),
        ),
        "get" => {
            if kind != Some("file")
                || ftp.size(&path).map_err(|_| "transfer_protocol_failed")? > MAX_BYTES
            {
                return Err("transfer_size_limit");
            }
            let mut stream = ftp
                .retr_as_stream(&path)
                .map_err(|_| "transfer_io_failed")?;
            let data = bounded_read(&mut stream, &cancel)?;
            stream.finish().map_err(|_| "transfer_io_failed")?;
            Ok(content(&data))
        }
        "put" => {
            let parent = Path::new(&path)
                .parent()
                .and_then(|p| p.to_str())
                .ok_or("transfer_path_denied")?;
            let prefix = format!(".heavenkey-{}", uuid::Uuid::new_v4());
            ftp.cwd(parent).map_err(|_| "transfer_path_denied")?;
            if ftp.pwd().map_err(|_| "transfer_path_denied")? != parent {
                return Err("transfer_path_denied");
            }
            let (response, mut data_stream) = ftp
                .custom_data_command(
                    format!("STOU {prefix}"),
                    &[Status::AboutToSend, Status::AlreadyOpen],
                )
                .map_err(|_| "transfer_safe_write_unavailable")?;
            let reply = response
                .as_string()
                .map_err(|_| "transfer_protocol_failed")?;
            let returned = reply
                .split_once("FILE:")
                .map(|(_, name)| name.trim())
                .ok_or("transfer_safe_write_unavailable")?;
            let returned_path = Path::new(returned);
            let name = returned_path
                .file_name()
                .and_then(|s| s.to_str())
                .filter(|s| {
                    s.starts_with(&prefix) && super::relative_path(s, false) && !s.contains('/')
                })
                .ok_or("transfer_path_denied")?;
            if returned_path.is_absolute()
                && returned_path.parent().and_then(|p| p.to_str()) != Some(parent)
            {
                return Err("transfer_path_denied");
            }
            let temporary = if parent == "/" {
                format!("/{name}")
            } else {
                format!("{parent}/{name}")
            };
            let data = Zeroizing::new(
                URL_SAFE_NO_PAD
                    .decode(r.content.as_deref().unwrap_or(""))
                    .map_err(|_| "transfer_invalid_content")?,
            );
            let result = (|| {
                for chunk in data.chunks(16384) {
                    if cancel.load(Ordering::SeqCst) || !authorize() {
                        return Err("transfer_revoked");
                    }
                    data_stream
                        .write_all(chunk)
                        .map_err(|_| "transfer_io_failed")?;
                }
                data_stream.finish().map_err(|_| "transfer_io_failed")?;
                if ftp_kind(
                    &ftp.mlst(Some(&temporary))
                        .map_err(|_| "transfer_path_denied")?,
                )? != "file"
                {
                    return Err("transfer_path_denied");
                }
                let (checked, _) = ftp_checked(&mut ftp, &p.root, &r.path, true)?;
                if checked != path || cancel.load(Ordering::SeqCst) || !authorize() {
                    return Err("transfer_revoked");
                }
                // RNTO may replace an existing regular file; owner approval authorizes this.
                ftp.rename(&temporary, &path)
                    .map_err(|_| "transfer_commit_failed")?;
                Ok(json!({"sha256":r.sha256,"bytes":data.len()}))
            })();
            if result.is_err() {
                let _ = ftp.rm(&temporary);
            }
            result
        }
        "list" => {
            if kind != Some("directory") {
                return Err("transfer_path_denied");
            }
            let (_, mut stream) = ftp
                .custom_data_command(
                    format!("MLSD {path}"),
                    &[Status::AboutToSend, Status::AlreadyOpen],
                )
                .map_err(|_| "transfer_io_failed")?;
            let data = bounded_read(&mut stream, &cancel)?;
            stream.finish().map_err(|_| "transfer_io_failed")?;
            let text = std::str::from_utf8(&data).map_err(|_| "transfer_metadata_invalid")?;
            let mut entries = Vec::new();
            for line in text.lines() {
                let (facts, name) = line.split_once(' ').ok_or("transfer_metadata_invalid")?;
                if matches!(name, "." | "..") {
                    continue;
                }
                if entries.len() >= 200 {
                    return Err("transfer_entry_limit");
                }
                if !super::relative_path(name, false) || name.contains('/') {
                    return Err("transfer_metadata_invalid");
                }
                let kind = ftp_kind(facts).unwrap_or("blocked");
                let size = facts.split(';').find_map(|f| {
                    f.split_once('=')
                        .filter(|(k, _)| k.eq_ignore_ascii_case("size"))
                        .and_then(|(_, v)| v.parse::<u64>().ok())
                });
                entries.push(json!({"name":name,"type":kind,"size":size}));
            }
            Ok(json!({"entries":entries}))
        }
        _ => Err("transfer_invalid_operation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transfer_bounded_reads_reject_oversized_files_and_cancel() {
        assert_eq!(
            bounded_read(
                &mut std::io::Cursor::new(vec![0; MAX_BYTES + 1]),
                &AtomicBool::new(false)
            )
            .err(),
            Some("transfer_size_limit")
        );
        assert_eq!(
            bounded_read(
                &mut std::io::Cursor::new(vec![0; 1]),
                &AtomicBool::new(true)
            )
            .err(),
            Some("transfer_revoked")
        );
    }
    #[test]
    fn transfer_rejects_ftp_symlinks_and_missing_facts() {
        assert_eq!(ftp_kind("type=file;size=1; file"), Ok("file"));
        assert_eq!(
            ftp_kind("type=OS.unix=slink:/etc; name"),
            Err("transfer_path_denied")
        );
        assert!(ftp_kind("size=10; name").is_err());
    }
}

#[cfg(all(test, unix))]
mod sftp_integration {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        process::{Command, Stdio},
    };
    struct Fixture {
        child: std::process::Child,
        dir: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    #[test]
    #[ignore = "requires local sshd; synthetic localhost keys only"]
    fn transfer_sftp_pkcs8_roundtrip_pin_symlink_and_write() {
        // Protocol smoke test in explicit temporary paths; this does not prove server jail enforcement.
        let dir = std::env::temp_dir().join(format!("heavenkey-transfer-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let host =
            openssl::pkey::PKey::from_rsa(openssl::rsa::Rsa::generate(3072).unwrap()).unwrap();
        fs::write(dir.join("host"), host.private_key_to_pem_pkcs8().unwrap()).unwrap();
        fs::set_permissions(dir.join("host"), fs::Permissions::from_mode(0o600)).unwrap();
        let key = openssl::pkey::PKey::generate_ed25519().unwrap();
        let raw = key.raw_public_key().unwrap();
        let mut blob = Vec::new();
        blob.extend_from_slice(&11u32.to_be_bytes());
        blob.extend_from_slice(b"ssh-ed25519");
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&raw);
        let public = format!(
            "ssh-ed25519 {}",
            base64::engine::general_purpose::STANDARD.encode(blob)
        );
        fs::write(dir.join("authorized"), &public).unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let user = String::from_utf8(
            Command::new("/usr/bin/id")
                .arg("-un")
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let root = dir.join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("source"), b"synthetic transfer payload").unwrap();
        std::os::unix::fs::symlink("/etc", root.join("escape")).unwrap();
        let config = format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile {}\nAuthorizedKeysFile {}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowUsers {}\nSubsystem sftp internal-sftp\n",
            dir.join("host").display(),
            dir.join("pid").display(),
            dir.join("authorized").display(),
            user.trim()
        );
        fs::write(dir.join("config"), config).unwrap();
        let stderr = fs::File::create(dir.join("stderr")).unwrap();
        let child = Command::new("/usr/sbin/sshd")
            .args(["-D", "-e", "-f"])
            .arg(dir.join("config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()
            .unwrap();
        let mut fixture = Fixture {
            child,
            dir: dir.clone(),
        };
        let mut ready = false;
        for _ in 0..100 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                ready = true;
                break;
            }
            if fixture.child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            ready,
            "sshd: {}",
            fs::read_to_string(dir.join("stderr")).unwrap()
        );
        let mut session = Session::new().unwrap();
        session.set_tcp_stream(TcpStream::connect(("127.0.0.1", port)).unwrap());
        session.handshake().unwrap();
        let pin = format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(session.host_key().unwrap().0))
        );
        drop(session);
        let mut p = TransferProfile {
            id: uuid::Uuid::new_v4().to_string(),
            label: "synthetic".into(),
            provider: "custom".into(),
            protocol: "sftp".into(),
            host: "127.0.0.1".into(),
            port,
            username: user.trim().into(),
            root: "/".into(),
            host_key: pin,
            password: String::new(),
            private_key: String::from_utf8(key.private_key_to_pem_pkcs8().unwrap()).unwrap(),
            public_key: public,
            ca_certificate: String::new(),
        };
        assert!(p.valid());
        let mut r = TransferRequest {
            connection_id: p.id.clone(),
            operation: "get".into(),
            path: format!("{}/source", root.to_str().unwrap().trim_start_matches('/')),
            content: None,
            sha256: None,
        };
        let result = execute(&p, &r, Arc::new(AtomicBool::new(false)), || true).unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(result["content"].as_str().unwrap())
                .unwrap(),
            b"synthetic transfer payload"
        );
        r.operation = "list".into();
        r.path = root.to_str().unwrap().trim_start_matches('/').into();
        assert!(
            execute(&p, &r, Arc::new(AtomicBool::new(false)), || true).unwrap()["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["name"] == "source")
        );
        r.operation = "get".into();
        r.path = format!(
            "{}/escape/passwd",
            root.to_str().unwrap().trim_start_matches('/')
        );
        assert_eq!(
            execute(&p, &r, Arc::new(AtomicBool::new(false)), || true).err(),
            Some("transfer_path_denied")
        );
        r.operation = "put".into();
        r.path = format!("{}/created", root.to_str().unwrap().trim_start_matches('/'));
        r.content = Some(URL_SAFE_NO_PAD.encode(b"synthetic upload"));
        r.sha256 = Some(format!("{:x}", Sha256::digest(b"synthetic upload")));
        assert!(r.valid());
        assert!(execute(&p, &r, Arc::new(AtomicBool::new(false)), || true).is_ok());
        assert_eq!(fs::read(root.join("created")).unwrap(), b"synthetic upload");
        assert_eq!(
            execute(&p, &r, Arc::new(AtomicBool::new(false)), || true).err(),
            Some("transfer_destination_exists")
        );
        p.host_key = format!("SHA256:{}", STANDARD_NO_PAD.encode([0; 32]));
        assert_eq!(
            execute(&p, &r, Arc::new(AtomicBool::new(false)), || true).err(),
            Some("transfer_host_key_mismatch")
        );
    }
}

#[cfg(test)]
mod ftpes_integration {
    use super::*;
    use std::io::{BufRead, BufReader};
    fn tls_server(reject_auth: bool) -> (u16, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let job = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket.write_all(b"220 Synthetic TLS test\r\n").unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut command = String::new();
            reader.read_line(&mut command).unwrap();
            assert_eq!(command, "AUTH TLS\r\n");
            if reject_auth {
                socket.write_all(b"502 TLS unavailable\r\n").unwrap();
                return command;
            }
            socket.write_all(b"234 Start TLS\r\n").unwrap();
            let key =
                openssl::pkey::PKey::from_rsa(openssl::rsa::Rsa::generate(2048).unwrap()).unwrap();
            let mut name = openssl::x509::X509NameBuilder::new().unwrap();
            name.append_entry_by_text("CN", "localhost").unwrap();
            let name = name.build();
            let mut cert = openssl::x509::X509::builder().unwrap();
            cert.set_version(2).unwrap();
            cert.set_subject_name(&name).unwrap();
            cert.set_issuer_name(&name).unwrap();
            cert.set_pubkey(&key).unwrap();
            cert.set_not_before(&openssl::asn1::Asn1Time::days_from_now(0).unwrap())
                .unwrap();
            cert.set_not_after(&openssl::asn1::Asn1Time::days_from_now(1).unwrap())
                .unwrap();
            cert.sign(&key, openssl::hash::MessageDigest::sha256())
                .unwrap();
            let mut tls =
                openssl::ssl::SslAcceptor::mozilla_intermediate(openssl::ssl::SslMethod::tls())
                    .unwrap();
            tls.set_certificate(&cert.build()).unwrap();
            tls.set_private_key(&key).unwrap();
            assert!(
                tls.build().accept(socket).is_err(),
                "client unexpectedly trusted an untrusted certificate"
            );
            command
        });
        (port, job)
    }
    #[test]
    fn transfer_ftpes_rejects_tls_downgrade_and_untrusted_certificate_before_password() {
        for reject in [true, false] {
            let (port, job) = tls_server(reject);
            let p = TransferProfile {
                id: uuid::Uuid::new_v4().to_string(),
                label: "synthetic".into(),
                provider: "custom".into(),
                protocol: "ftpes".into(),
                host: "127.0.0.1".into(),
                port,
                username: "synthetic-user".into(),
                root: "/".into(),
                host_key: String::new(),
                password: "synthetic-not-a-real-password".into(),
                private_key: String::new(),
                public_key: String::new(),
                ca_certificate: String::new(),
            };
            let r = TransferRequest {
                connection_id: p.id.clone(),
                operation: "list".into(),
                path: String::new(),
                content: None,
                sha256: None,
            };
            assert_eq!(
                execute(&p, &r, Arc::new(AtomicBool::new(false)), || true).err(),
                Some("transfer_tls_failed")
            );
            assert!(!job.join().unwrap().contains(&p.password));
        }
    }
}

#[cfg(test)]
mod ca_tests {
    use super::*;
    use openssl::{
        asn1::{Asn1Integer, Asn1Time},
        bn::BigNum,
        hash::MessageDigest,
        pkey::PKey,
        rsa::Rsa,
        ssl::{SslAcceptor, SslMethod},
        x509::{
            X509, X509NameBuilder,
            extension::{BasicConstraints, ExtendedKeyUsage, KeyUsage, SubjectAlternativeName},
        },
    };
    fn certificate() -> (X509, X509, PKey<openssl::pkey::Private>) {
        let root_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let leaf_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let mut name = X509NameBuilder::new().unwrap();
        name.append_entry_by_text("CN", "HeavenKey synthetic local CA")
            .unwrap();
        let name = name.build();
        let mut root = X509::builder().unwrap();
        root.set_version(2).unwrap();
        root.set_serial_number(&Asn1Integer::from_bn(&BigNum::from_u32(1).unwrap()).unwrap())
            .unwrap();
        root.set_subject_name(&name).unwrap();
        root.set_issuer_name(&name).unwrap();
        root.set_pubkey(&root_key).unwrap();
        root.set_not_before(&Asn1Time::days_from_now(0).unwrap())
            .unwrap();
        root.set_not_after(&Asn1Time::days_from_now(1).unwrap())
            .unwrap();
        root.append_extension(BasicConstraints::new().critical().ca().build().unwrap())
            .unwrap();
        root.append_extension(
            KeyUsage::new()
                .critical()
                .key_cert_sign()
                .crl_sign()
                .build()
                .unwrap(),
        )
        .unwrap();
        root.sign(&root_key, MessageDigest::sha256()).unwrap();
        let root = root.build();
        let mut leaf_name = X509NameBuilder::new().unwrap();
        leaf_name.append_entry_by_text("CN", "localhost").unwrap();
        let leaf_name = leaf_name.build();
        let mut leaf = X509::builder().unwrap();
        leaf.set_version(2).unwrap();
        leaf.set_serial_number(&Asn1Integer::from_bn(&BigNum::from_u32(2).unwrap()).unwrap())
            .unwrap();
        leaf.set_subject_name(&leaf_name).unwrap();
        leaf.set_issuer_name(root.subject_name()).unwrap();
        leaf.set_pubkey(&leaf_key).unwrap();
        leaf.set_not_before(&Asn1Time::days_from_now(0).unwrap())
            .unwrap();
        leaf.set_not_after(&Asn1Time::days_from_now(1).unwrap())
            .unwrap();
        leaf.append_extension(BasicConstraints::new().critical().build().unwrap())
            .unwrap();
        leaf.append_extension(
            KeyUsage::new()
                .critical()
                .digital_signature()
                .key_encipherment()
                .build()
                .unwrap(),
        )
        .unwrap();
        leaf.append_extension(ExtendedKeyUsage::new().server_auth().build().unwrap())
            .unwrap();
        let san = SubjectAlternativeName::new()
            .dns("localhost")
            .ip("127.0.0.1")
            .build(&leaf.x509v3_context(Some(&root), None))
            .unwrap();
        leaf.append_extension(san).unwrap();
        leaf.sign(&root_key, MessageDigest::sha256()).unwrap();
        (root, leaf.build(), leaf_key)
    }
    #[test]
    fn transfer_private_ca_accepts_valid_chain_but_never_wrong_hostname_or_missing_anchor() {
        let (root, leaf, key) = certificate();
        let ca = String::from_utf8(root.to_pem().unwrap()).unwrap();
        assert!(super::super::valid_ca(&ca));
        assert!(!super::super::valid_ca(&(ca.clone() + "garbage")));
        assert!(!super::super::valid_ca(
            &(ca.clone() + &String::from_utf8(key.private_key_to_pem_pkcs8().unwrap()).unwrap())
        ));
        for (anchor, hostname, expected) in [
            (true, "localhost", true),
            (true, "wrong.invalid", false),
            (false, "localhost", false),
        ] {
            let mut server = SslAcceptor::mozilla_intermediate(SslMethod::tls()).unwrap();
            server.set_certificate(&leaf).unwrap();
            server.set_private_key(&key).unwrap();
            let server = server.build();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let job = std::thread::spawn(move || {
                let (socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let _ = server.accept(socket);
            });
            let profile = TransferProfile {
                id: uuid::Uuid::new_v4().to_string(),
                label: "synthetic".into(),
                provider: "custom".into(),
                protocol: "ftpes".into(),
                host: hostname.into(),
                port: addr.port(),
                username: "synthetic".into(),
                root: "/".into(),
                host_key: String::new(),
                password: "synthetic".into(),
                private_key: String::new(),
                public_key: String::new(),
                ca_certificate: if anchor { ca.clone() } else { String::new() },
            };
            assert!(profile.valid());
            let socket = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let result = tls_connector(&profile).unwrap().connect(hostname, socket);
            assert_eq!(
                result.is_ok(),
                expected,
                "anchor={anchor}, hostname={hostname}, error={:?}",
                result.err()
            );
            job.join().unwrap();
        }
    }
}

#[cfg(test)]
mod dns_regressions {
    use super::*;
    fn wait_empty(active: &AtomicUsize) {
        let until = Instant::now() + Duration::from_secs(1);
        while active.load(Ordering::Acquire) != 0 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(active.load(Ordering::Acquire), 0);
    }
    #[test]
    fn transfer_dns_timeouts_keep_global_slots_until_resolver_exit() {
        let active = Arc::new(AtomicUsize::new(0));
        let cancel = AtomicBool::new(false);
        let mut releases = Vec::new();
        for _ in 0..2 {
            let (tx, rx) = mpsc::sync_channel(1);
            releases.push(tx);
            let result = resolve_with(
                "synthetic.invalid".into(),
                22,
                &cancel,
                Instant::now() + Duration::from_millis(15),
                active.clone(),
                move |host, port| {
                    assert_eq!(host, "synthetic.invalid");
                    assert_eq!(port, 22);
                    rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    Ok(Vec::new())
                },
            );
            assert_eq!(result.err(), Some("transfer_dns_timeout"));
        }
        assert_eq!(active.load(Ordering::Acquire), 2);
        assert_eq!(
            resolve_with(
                "synthetic.invalid".into(),
                22,
                &cancel,
                Instant::now() + STEP,
                active.clone(),
                |_, _| panic!("unadmitted resolver executed")
            )
            .err(),
            Some("transfer_dns_busy")
        );
        for tx in releases {
            tx.send(()).unwrap();
        }
        wait_empty(&active);
        assert!(
            resolve_with(
                "synthetic.invalid".into(),
                22,
                &cancel,
                Instant::now() + STEP,
                active.clone(),
                |_, _| Ok(Vec::new())
            )
            .is_ok()
        );
        wait_empty(&active);
    }
    #[test]
    fn transfer_dns_cancellation_releases_credential_worker_without_releasing_stalled_resolver() {
        let active = Arc::new(AtomicUsize::new(0));
        let cancel = Arc::new(AtomicBool::new(false));
        let setting = cancel.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(15));
            setting.store(true, Ordering::SeqCst);
        });
        assert_eq!(
            resolve_with(
                "synthetic.invalid".into(),
                21,
                &cancel,
                Instant::now() + STEP,
                active.clone(),
                move |_, _| {
                    rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    Ok(Vec::new())
                }
            )
            .err(),
            Some("transfer_revoked")
        );
        setter.join().unwrap();
        assert_eq!(active.load(Ordering::Acquire), 1);
        tx.send(()).unwrap();
        wait_empty(&active);
        assert_eq!(
            resolve_with(
                "synthetic.invalid".into(),
                21,
                &AtomicBool::new(false),
                Instant::now() - Duration::from_millis(1),
                active.clone(),
                |_, _| panic!("expired resolution executed")
            )
            .err(),
            Some("transfer_dns_timeout")
        );
        assert_eq!(active.load(Ordering::Acquire), 0);
    }
}
