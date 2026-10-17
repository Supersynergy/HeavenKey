//! Narrow local client. Scoped client credentials enter through stdin, never argv.
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::time::Duration;

pub fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if args.len() != 3 {
        return Err("Usage: --broker-agent PORT connect|request|status|read|close < request.json (see AGENT-BROKER.md)".into());
    }
    let port: u16 = args[1].parse().map_err(|_| "Invalid local broker port")?;
    if port == 0 {
        return Err("Invalid local broker port".into());
    }
    let command = args[2].as_str();
    if !matches!(command, "connect" | "request" | "status" | "read" | "close") {
        return Err("Unsupported broker command".into());
    }
    let mut input = zeroize::Zeroizing::new(Vec::new());
    std::io::stdin().take(17_000).read_to_end(&mut input)?;
    if input.len() > 16_384 {
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
    let body = zeroize::Zeroizing::new(serde_json::to_vec(&body)?);
    let mut stream = TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_secs(3),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    write!(
        stream,
        "POST /api/password-broker/agent/{command} HTTP/1.1\r\nHost: localhost:{port}\r\nX-HeavenKey-Client: password-agent\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    )?;
    if !token.is_empty() {
        write!(stream, "X-HeavenKey-Token: {}\r\n", token.as_str())?;
    }
    stream.write_all(b"\r\n")?;
    stream.write_all(&body)?;
    let mut response = Vec::new();
    stream.take(1_049_601).read_to_end(&mut response)?;
    if response.len() > 1_049_600 {
        return Err("Broker response too large".into());
    }
    let split = response
        .windows(4)
        .position(|v| v == b"\r\n\r\n")
        .ok_or("Invalid broker response")?;
    let header = std::str::from_utf8(&response[..split]).map_err(|_| "Invalid broker response")?;
    if !header.starts_with("HTTP/1.1 200 ") {
        return Err("Broker denied or could not complete the request; check owner approval and session expiry".into());
    }
    let value: Value = serde_json::from_slice(&response[split + 4..])
        .map_err(|_| "Invalid broker response JSON")?;
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}
