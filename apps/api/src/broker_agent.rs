//! Narrow local client. Scoped client credentials enter through stdin, never argv.
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::time::Duration;

pub fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if args.len() != 3 {
        return Err("Usage: --broker-agent PORT connect|request|status|read|close|transfer-request|transfer-status|protected-list|protected-login|protected-draft|protected-close < request.json".into());
    }
    let port: u16 = args[1].parse().map_err(|_| "Invalid local broker port")?;
    if port == 0 {
        return Err("Invalid local broker port".into());
    }
    let command = args[2].as_str();
    if !matches!(
        command,
        "connect"
            | "request"
            | "status"
            | "read"
            | "close"
            | "transfer-request"
            | "transfer-status"
            | "protected-list"
            | "protected-login"
            | "protected-draft"
            | "protected-close"
    ) {
        return Err("Unsupported broker command".into());
    }
    let mut input = zeroize::Zeroizing::new(Vec::new());
    std::io::stdin().take(1_500_001).read_to_end(&mut input)?;
    if input.len()
        > if command.starts_with("transfer-") {
            1_500_000
        } else {
            16_384
        }
    {
        return Err("Broker request too large".into());
    }
    let mut body: Value =
        serde_json::from_slice(&input).map_err(|_| "Invalid broker request JSON")?;
    let object = body
        .as_object_mut()
        .ok_or("Broker request must be an object")?;
    let token = zeroize::Zeroizing::new(
        object
            .remove("token")
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default(),
    );
    if command != "connect"
        && (token.len() != 43
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')))
    {
        return Err("Missing scoped broker client token".into());
    }
    if command == "request" {
        object.entry("scope").or_insert(json!("login_read"));
    }
    let value = call(
        port,
        command,
        (!token.is_empty()).then_some(token.as_str()),
        &body,
        &std::sync::atomic::AtomicBool::new(false),
    )?;
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}

pub fn call(
    port: u16,
    action: &str,
    token: Option<&str>,
    value: &Value,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Value, &'static str> {
    use std::sync::atomic::Ordering;
    if port == 0
        || !matches!(
            action,
            "connect"
                | "request"
                | "status"
                | "read"
                | "close"
                | "disconnect"
                | "transfer-request"
                | "transfer-status"
                | "protected-list"
                | "protected-login"
                | "protected-draft"
                | "protected-close"
        )
    {
        return Err("Unsupported broker operation");
    }
    if token.is_some_and(|t| {
        t.len() != 43
            || !t
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    }) {
        return Err("Invalid scoped client token");
    }
    if action != "connect" && token.is_none() {
        return Err("Missing scoped client token");
    }
    let body =
        zeroize::Zeroizing::new(serde_json::to_vec(value).map_err(|_| "Invalid broker request")?);
    if body.len()
        > if action.starts_with("transfer-") {
            1_500_000
        } else {
            16_384
        }
        || cancel.load(Ordering::Acquire)
    {
        return Err("Broker request cancelled or too large");
    }
    let mut stream = TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(200),
    )
    .map_err(|_| "Local broker unavailable")?;
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|_| "Broker IO failed")?;
    stream
        .set_write_timeout(Some(Duration::from_millis(200)))
        .map_err(|_| "Broker IO failed")?;
    let path = match action {
        "transfer-request" => "/api/transfer-broker/agent/request".to_owned(),
        "transfer-status" => "/api/transfer-broker/agent/status".to_owned(),
        _ => format!("/api/password-broker/agent/{action}"),
    };
    write!(stream,"POST {path} HTTP/1.1\r\nHost: localhost:{port}\r\nX-HeavenKey-Client: password-agent\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",body.len()).map_err(|_|"Broker IO failed")?;
    if let Some(token) = token {
        write!(stream, "X-HeavenKey-Token: {token}\r\n").map_err(|_| "Broker IO failed")?;
    }
    stream
        .write_all(b"\r\n")
        .and_then(|()| stream.write_all(&body))
        .map_err(|_| "Broker IO failed")?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut response = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        if cancel.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
            return Err("Broker request cancelled or timed out");
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if response.len() + n > 1_500_000 {
                    return Err("Broker response too large");
                }
                response.extend_from_slice(&chunk[..n]);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => return Err("Broker IO failed"),
        }
    }
    let split = response
        .windows(4)
        .position(|v| v == b"\r\n\r\n")
        .ok_or("Invalid broker response")?;
    let header = std::str::from_utf8(&response[..split]).map_err(|_| "Invalid broker response")?;
    if !header.starts_with("HTTP/1.1 200 ") {
        return Err("Broker denied or could not complete the request");
    }
    serde_json::from_slice(&response[split + 4..]).map_err(|_| "Invalid broker response JSON")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_operations_and_no_header_injection() {
        let stop = std::sync::atomic::AtomicBool::new(false);
        assert!(call(18240, "../password-vault", None, &json!({}), &stop).is_err());
        assert!(call(18240, "read", Some("bad\r\nOrigin:x"), &json!({}), &stop).is_err());
        assert!(call(0, "connect", None, &json!({}), &stop).is_err());
    }
    #[test]
    fn cancellation_prevents_network_dispatch() {
        let stop = std::sync::atomic::AtomicBool::new(true);
        assert!(call(18240, "connect", None, &json!({}), &stop).is_err());
    }
}
