#![forbid(unsafe_code)]

use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};
use uac_verifier::{
    Action, Error, Grant, Signed, authorize_passkey_grant, decode_grant, delegation, grant_id,
};

const MAX_PRESENTATION_BYTES: usize = 32 * 1024;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let number = ((chunk[0] as u32) << 16)
            | ((*chunk.get(1).unwrap_or(&0) as u32) << 8)
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(B64URL[(number >> 18) as usize & 63] as char);
        out.push(B64URL[(number >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64URL[(number >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL[number as usize & 63] as char);
        }
    }
    out
}

fn b64_decode(value: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(value.len() / 4 * 3 + 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for byte in value.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return Err("invalid base64url character".into()),
        };
        acc = (acc << 6) | u32::from(digit);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if bits >= 6 || acc != 0 {
        return Err("invalid base64url length or padding".into());
    }
    Ok(out)
}

fn b64_32(value: &str) -> Result<[u8; 32], String> {
    b64_decode(value)?
        .try_into()
        .map_err(|_| "expected 32 bytes".to_owned())
}

fn reason(error: &Error) -> &'static str {
    match error {
        Error::Time | Error::ClockRollback => "expired",
        Error::Revoked => "revoked",
        Error::Encoding | Error::Limits => "malformed",
        _ => "denied",
    }
}

const HELP: &str = "hkv — HeavenKey verifier command line\n\
     \n\
     Usage: hkv <subcommand> [options]\n\
     \n\
     Subcommands:\n\
     \x20 pubkey        print the base64url verifying key for an issuer seed file\n\
     \x20 inspect       decode a grant or delegation token and summarize it\n\
     \x20 verify        verify a delegation chain presentation\n\
     \x20 grant-verify  verify a legacy passkey grant\n\
     \n\
     Run 'hkv <subcommand> --help' for options.";

const PUBKEY_HELP: &str = "hkv pubkey --issuer-key <file>\n\
     \n\
     Reads a 32-byte Ed25519 issuer seed (as written by uac-api to issuer.key)\n\
     and prints the base64url (no padding) verifying key.";

const INSPECT_HELP: &str = "hkv inspect --input <file>\n\
     \n\
     Decodes a token JSON file — a signed heavenkey-delegation-v1 grant or a\n\
     legacy passkey grant — and prints a human-readable summary.";

const VERIFY_HELP: &str = "hkv verify --issuer <b64url> --input <file> [--revoked <id> ...] [--now <unix>]\n\
     \n\
     Verifies a delegation presentation document of the shape\n\
     \x20 {\"chain\": [\"<delegation token>\", ...root-to-leaf], \"holder\": \"<credential id\n\
     base64url>\", \"resource\": \"<urn>\", \"action\": \"Read\"}\n\
     The leaf audience must equal sha256 of the decoded holder credential id.\n\
     Prints {\"allowed\": true|false, \"reason\": <code>} and exits 0 or 1.";

const GRANT_VERIFY_HELP: &str = "hkv grant-verify --issuer <b64url> --input <file> [--now <unix>]\n\
     \n\
     Verifies a legacy grant document of the shape\n\
     \x20 {\"grant\": <signed grant>, \"holder\": \"<credential id base64url>\",\n\
     \x20 \"resource\": \"<urn>\", \"action\": \"Read\", \"revoked\": false, \"now\": <unix>}\n\
     using authorize_passkey_grant. Prints {\"allowed\": true|false, \"reason\": <code>}\n\
     and exits 0 or 1.";

struct Flags {
    values: HashMap<String, String>,
    lists: HashMap<String, Vec<String>>,
}

fn parse_flags(args: &[String], single: &[&str], repeatable: &[&str]) -> Result<Flags, String> {
    let mut values = HashMap::new();
    let mut lists: HashMap<String, Vec<String>> = HashMap::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let Some(name) = arg.strip_prefix("--") else {
            return Err(format!("unexpected argument {arg}"));
        };
        let value = iter
            .next()
            .ok_or_else(|| format!("missing value for {arg}"))?;
        if repeatable.contains(&name) {
            lists
                .entry(name.to_owned())
                .or_default()
                .push(value.clone());
        } else if single.contains(&name) {
            if values.insert(name.to_owned(), value.clone()).is_some() {
                return Err(format!("duplicate option {arg}"));
            }
        } else {
            return Err(format!("unknown option {arg}"));
        }
    }
    Ok(Flags { values, lists })
}

fn want_help(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--help" || arg == "-h")
}

fn read_input(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|error| format!("read {path}: {error}"))
}

fn pubkey(args: &[String]) -> Result<String, String> {
    let flags = parse_flags(args, &["issuer-key"], &[])?;
    let seed = read_input(
        flags
            .values
            .get("issuer-key")
            .ok_or("missing --issuer-key")?
            .as_str(),
    )?;
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| "issuer key must be exactly 32 bytes".to_owned())?;
    let key = SigningKey::from_bytes(&seed);
    Ok(b64_encode(&key.verifying_key().to_bytes()))
}

fn summarize_delegation(signed: &Signed<delegation::DelegationGrant>) -> Result<String, String> {
    let body = &signed.body;
    let actions = body
        .actions
        .iter()
        .map(|action| format!("{action:?}"))
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "format: {}\n\
         id: {}\n\
         issuer: {}\n\
         delegator: {}\n\
         audience: {}\n\
         resource: {}\n\
         actions: {actions}\n\
         not_before: {}\n\
         expires_at: {}\n\
         remaining_delegations: {}\n\
         parent: {}\n\
         nonce: {}",
        body.profile,
        b64_encode(&delegation::id(signed).map_err(|error| format!("{error:?}"))?),
        b64_encode(&body.issuer),
        body.delegator.map_or("none".into(), |d| b64_encode(&d)),
        b64_encode(&body.audience),
        body.resource,
        body.not_before,
        body.expires_at,
        body.remaining_delegations,
        body.parent.map_or("none".into(), |p| b64_encode(&p)),
        b64_encode(&body.nonce),
    ))
}

fn summarize_grant(signed: &Signed<Grant>) -> Result<String, String> {
    let body = &signed.body;
    let actions = body
        .actions
        .iter()
        .map(|action| format!("{action:?}"))
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "format: uac-grant-v0\n\
         id: {}\n\
         issuer: {}\n\
         audience: {}\n\
         resource: {}\n\
         actions: {actions}\n\
         not_before: {}\n\
         expires_at: {}\n\
         remaining_delegations: {}\n\
         parent: {}",
        b64_encode(&grant_id(signed).map_err(|error| format!("{error:?}"))?),
        b64_encode(&body.issuer),
        b64_encode(&body.audience),
        body.resource,
        body.not_before,
        body.expires_at,
        body.remaining_delegations,
        body.parent.map_or("none".into(), |p| b64_encode(&p)),
    ))
}

fn inspect(args: &[String]) -> Result<String, String> {
    let flags = parse_flags(args, &["input"], &[])?;
    let bytes = read_input(flags.values.get("input").ok_or("missing --input")?)?;
    if let Ok(delegation) = delegation::decode(&bytes) {
        return summarize_delegation(&delegation);
    }
    if let Ok(grant) = decode_grant(&bytes) {
        return summarize_grant(&grant);
    }
    Err("input is neither a delegation nor a grant token".into())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Presentation {
    chain: Vec<String>,
    holder: String,
    resource: String,
    action: Action,
}

fn verify(args: &[String]) -> Result<String, String> {
    let flags = parse_flags(args, &["issuer", "input", "now"], &["revoked"])?;
    let issuer = b64_32(flags.values.get("issuer").ok_or("missing --issuer")?)?;
    let bytes = read_input(flags.values.get("input").ok_or("missing --input")?)?;
    if bytes.len() > MAX_PRESENTATION_BYTES {
        return Err("presentation exceeds size limit".into());
    }
    let presentation: Presentation =
        serde_json::from_slice(&bytes).map_err(|_| "malformed presentation".to_owned())?;
    let holder = b64_decode(&presentation.holder).map_err(|_| "malformed holder".to_owned())?;
    let holder_subject: [u8; 32] = Sha256::digest(&holder).into();
    let mut revoked = BTreeSet::new();
    for id in flags.lists.get("revoked").cloned().unwrap_or_default() {
        revoked.insert(b64_32(&id)?);
    }
    let time = match flags.values.get("now") {
        Some(value) => value.parse().map_err(|_| "invalid --now".to_owned())?,
        None => now(),
    };
    let allowed = || -> Result<(), Error> {
        let mut chain = Vec::with_capacity(presentation.chain.len());
        for token in &presentation.chain {
            chain.push(delegation::decode(token.as_bytes())?);
        }
        delegation::verify_structure(&chain, &issuer)?;
        delegation::verify_chain(
            &chain,
            delegation::Context {
                root: &issuer,
                verified_holder: &holder_subject,
                resource: &presentation.resource,
                action: presentation.action,
                now: time,
                revoked: &revoked,
            },
        )?;
        if chain.last().ok_or(Error::Limits)?.body.audience != holder_subject {
            return Err(Error::Invocation);
        }
        Ok(())
    }();
    Ok(match allowed {
        Ok(()) => json!({"allowed":true}).to_string(),
        Err(error) => json!({"allowed":false,"reason":reason(&error)}).to_string(),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantRequest {
    grant: Value,
    holder: String,
    resource: String,
    action: Action,
    revoked: Option<bool>,
    now: Option<u64>,
}

fn grant_verify(args: &[String]) -> Result<String, String> {
    let flags = parse_flags(args, &["issuer", "input", "now"], &[])?;
    let issuer = b64_32(flags.values.get("issuer").ok_or("missing --issuer")?)?;
    let bytes = read_input(flags.values.get("input").ok_or("missing --input")?)?;
    let request: GrantRequest =
        serde_json::from_slice(&bytes).map_err(|_| "malformed grant request".to_owned())?;
    let holder = b64_decode(&request.holder).map_err(|_| "malformed holder".to_owned())?;
    let holder_subject: [u8; 32] = Sha256::digest(&holder).into();
    let time = match flags.values.get("now") {
        Some(value) => value.parse().map_err(|_| "invalid --now".to_owned())?,
        None => request.now.unwrap_or_else(now),
    };
    let allowed = || -> Result<(), Error> {
        let grant_bytes = serde_json::to_vec(&request.grant).map_err(|_| Error::Encoding)?;
        let signed = decode_grant(&grant_bytes)?;
        authorize_passkey_grant(
            &signed,
            &issuer,
            &holder_subject,
            &request.resource,
            request.action,
            time,
            request.revoked.unwrap_or(false),
        )
    }();
    Ok(match allowed {
        Ok(()) => json!({"allowed":true}).to_string(),
        Err(error) => json!({"allowed":false,"reason":reason(&error)}).to_string(),
    })
}

fn report(result: Result<String, String>, help: &str, verdict: bool) -> ExitCode {
    match result {
        Ok(output) => {
            println!("{output}");
            if verdict && !output.contains("\"allowed\":true") {
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}\n\n{help}");
            ExitCode::from(2)
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(subcommand) = args.first() else {
        eprintln!("{HELP}");
        return ExitCode::from(2);
    };
    let rest = &args[1..];
    if want_help(rest) {
        let help = match subcommand.as_str() {
            "pubkey" => PUBKEY_HELP,
            "inspect" => INSPECT_HELP,
            "verify" => VERIFY_HELP,
            "grant-verify" => GRANT_VERIFY_HELP,
            _ => HELP,
        };
        println!("{help}");
        return ExitCode::SUCCESS;
    }
    match subcommand.as_str() {
        "pubkey" => report(pubkey(rest), PUBKEY_HELP, false),
        "inspect" => report(inspect(rest), INSPECT_HELP, false),
        "verify" => report(verify(rest), VERIFY_HELP, true),
        "grant-verify" => report(grant_verify(rest), GRANT_VERIFY_HELP, true),
        "--help" | "-h" => {
            println!("{HELP}");
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("unknown subcommand {other}\n\n{HELP}");
            ExitCode::from(2)
        }
    }
}
