#![forbid(unsafe_code)]

//! Deterministic export of a verified delegation-v1 chain into a
//! UCAN-1.0-shaped EdDSA JWT. This is a compatibility view on top of the
//! primary wire format, not a full UCAN stack; see docs/UCAN-BRIDGE.md.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use uac_verifier::delegation::{self, Context, DelegationGrant};
use uac_verifier::{Action, Error, Signed};

/// UCAN version carried in the JWT header.
pub const UCV: &str = "1.0.0";
/// did:key multicodec prefix for Ed25519 public keys.
const DID_KEY_ED25519: &[u8] = &[0xed, 0x01];
/// Multihash prefix for sha2-256, producing CIDv0-shaped proof strings.
const MULTIHASH_SHA2_256: &[u8] = &[0x12, 0x20];
const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn base58btc(data: &[u8]) -> String {
    let zeros = data.iter().take_while(|byte| **byte == 0).count();
    let mut digits = vec![0u8; data.len() * 138 / 100 + 2];
    let mut length = 0;
    for &byte in &data[zeros..] {
        let mut carry = u32::from(byte);
        for digit in digits.iter_mut().take(length) {
            carry += u32::from(*digit) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits[length] = (carry % 58) as u8;
            length += 1;
            carry /= 58;
        }
    }
    let mut out = "1".repeat(zeros);
    out.extend(
        digits[..length]
            .iter()
            .rev()
            .map(|digit| BASE58_ALPHABET[usize::from(*digit)] as char),
    );
    out
}

/// Encodes 32 bytes as a did:key Ed25519 identifier. Only the service issuer
/// key is a live Ed25519 key; audience and delegator entries are stable
/// account aliases wrapped in the same multicodec envelope.
pub fn did_key(key: &[u8; 32]) -> String {
    let mut data = Vec::with_capacity(34);
    data.extend_from_slice(DID_KEY_ED25519);
    data.extend_from_slice(key);
    format!("did:key:z{}", base58btc(&data))
}

/// Encodes a delegation link identifier as a CIDv0-shaped multihash string
/// for use in the `prf` proof array. It is an identifier, not a resolvable
/// content address.
pub fn link_cid(id: &[u8; 32]) -> String {
    let mut data = Vec::with_capacity(34);
    data.extend_from_slice(MULTIHASH_SHA2_256);
    data.extend_from_slice(id);
    base58btc(&data)
}

/// Maps a delegation action onto its attenuation `can` string.
pub fn ability(action: Action) -> &'static str {
    match action {
        Action::Read => "read",
        Action::Write => "write",
        Action::Unlock => "unlock",
    }
}

#[derive(Serialize)]
struct Header<'a> {
    alg: &'a str,
    typ: &'a str,
    ucv: &'a str,
}

#[derive(Serialize)]
struct Attenuation<'a> {
    can: &'a str,
    with: &'a str,
}

/// Payload fields serialize in declaration order, which is also alphabetical:
/// identical input therefore always produces identical JSON bytes.
#[derive(Serialize)]
struct Payload<'a> {
    att: Vec<Attenuation<'a>>,
    aud: String,
    exp: u64,
    iss: String,
    nbf: u64,
    prf: Vec<String>,
}

fn signing_input(leaf: &Signed<DelegationGrant>, prf: &[String]) -> Result<String, Error> {
    let grant = &leaf.body;
    let header = serde_json::to_vec(&Header {
        alg: "EdDSA",
        typ: "JWT",
        ucv: UCV,
    })
    .map_err(|_| Error::Encoding)?;
    let payload = serde_json::to_vec(&Payload {
        att: grant
            .actions
            .iter()
            .map(|action| Attenuation {
                can: ability(*action),
                with: &grant.resource,
            })
            .collect(),
        aud: did_key(&grant.audience),
        exp: grant.expires_at,
        iss: did_key(&grant.issuer),
        nbf: grant.not_before,
        prf: prf.to_vec(),
    })
    .map_err(|_| Error::Encoding)?;
    Ok(format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(payload)
    ))
}

/// Exports a verified delegation chain as one deterministic UCAN-shaped JWT.
///
/// The chain is checked with the full `delegation::verify_chain` contract
/// first, so a token is only emitted for a chain that is currently valid in
/// `context` (issuer root, structure, time window, revocation set, holder,
/// resource and action). `service_key` must be the trusted root key: the
/// token `iss` DID and its Ed25519 signature both bind to it, so verifiers can
/// authenticate the token from `iss` alone.
///
/// Deterministic: equal chain, context and key always produce identical bytes.
pub fn export_token(
    chain: &[Signed<DelegationGrant>],
    context: Context<'_>,
    service_key: &SigningKey,
) -> Result<String, Error> {
    if *context.root != service_key.verifying_key().to_bytes() {
        return Err(Error::UntrustedRoot);
    }
    delegation::verify_chain(chain, context)?;
    let mut prf = Vec::with_capacity(chain.len().saturating_sub(1));
    for link in &chain[..chain.len().saturating_sub(1)] {
        prf.push(link_cid(&delegation::id(link)?));
    }
    let leaf = chain.last().ok_or(Error::Limits)?;
    let input = signing_input(leaf, &prf)?;
    let signature = URL_SAFE_NO_PAD.encode(service_key.sign(input.as_bytes()).to_bytes());
    Ok(format!("{input}.{signature}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use serde::Deserialize;
    use serde_json::Value;
    use std::collections::BTreeSet;
    use uac_verifier::delegation::{self, DelegationGrant};

    #[derive(Deserialize)]
    struct Vectors {
        seed_byte: u8,
        trusted_issuer: [u8; 32],
        fixtures: Vec<Fixture>,
        cases: Vec<Case>,
        invalid_tokens: Vec<InvalidToken>,
    }
    #[derive(Deserialize)]
    struct Fixture {
        name: String,
        chain: Vec<Value>,
        token: String,
        payload: Value,
    }
    #[derive(Deserialize)]
    struct Case {
        name: String,
        fixture: String,
        allowed: bool,
    }
    #[derive(Deserialize)]
    struct InvalidToken {
        name: String,
        token: String,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../../../docs/vectors/ucan-bridge-v1.json"))
            .expect("independent JavaScript vectors")
    }

    fn decode_chain(fixture: &Fixture) -> Vec<Signed<DelegationGrant>> {
        fixture
            .chain
            .iter()
            .map(|grant| {
                delegation::decode(&serde_json::to_vec(grant).expect("fixture JSON"))
                    .unwrap_or_else(|error| panic!("{}: {error:?}", fixture.name))
            })
            .collect()
    }

    static EMPTY_REVOKED: BTreeSet<[u8; 32]> = BTreeSet::new();

    fn context<'a>(root: &'a [u8; 32], leaf: &'a DelegationGrant) -> Context<'a> {
        Context {
            root,
            verified_holder: &leaf.audience,
            resource: &leaf.resource,
            action: Action::Read,
            now: leaf.not_before,
            revoked: &EMPTY_REVOKED,
        }
    }

    #[test]
    fn independent_javascript_tokens_and_payloads_match() {
        let vectors = vectors();
        let service = SigningKey::from_bytes(&[vectors.seed_byte; 32]);
        assert_eq!(
            service.verifying_key().to_bytes(),
            vectors.trusted_issuer,
            "seed derives the trusted issuer"
        );
        for fixture in &vectors.fixtures {
            let chain = decode_chain(fixture);
            let leaf = &chain.last().expect("nonempty chain").body;
            assert!(
                leaf.actions.contains(&Action::Read),
                "{} fixture must attest read",
                fixture.name
            );
            let token = export_token(&chain, context(&vectors.trusted_issuer, leaf), &service)
                .unwrap_or_else(|error| panic!("{}: {error:?}", fixture.name));
            assert_eq!(token, fixture.token, "{} token bytes", fixture.name);
            let payload = token.split('.').nth(1).expect("payload segment");
            assert_eq!(
                serde_json::from_slice::<Value>(
                    &URL_SAFE_NO_PAD.decode(payload).expect("payload base64url")
                )
                .expect("payload JSON"),
                fixture.payload,
                "{} payload",
                fixture.name
            );
        }
    }

    #[test]
    fn vectors_declare_cases_and_invalid_tokens() {
        let vectors = vectors();
        assert!(
            vectors.cases.iter().any(|case| case.allowed)
                && vectors.cases.iter().any(|case| !case.allowed)
                && vectors.cases.len() >= 8,
            "cases cover positive and denial paths"
        );
        assert!(vectors.invalid_tokens.len() >= 8);
        for invalid in &vectors.invalid_tokens {
            assert!(
                !invalid.name.is_empty() && !invalid.token.is_empty(),
                "invalid token fixture is named and carries a token"
            );
        }
        for case in &vectors.cases {
            assert!(
                vectors
                    .fixtures
                    .iter()
                    .any(|fixture| fixture.name == case.fixture),
                "{} references a known fixture",
                case.name
            );
        }
    }

    fn fixture_chain() -> (SigningKey, Vec<Signed<DelegationGrant>>) {
        let service = SigningKey::from_bytes(&[9; 32]);
        let issuer = service.verifying_key().to_bytes();
        let root = delegation::sign(
            &service,
            DelegationGrant {
                profile: delegation::PROFILE.to_string(),
                issuer,
                delegator: None,
                audience: [0xa0; 32],
                resource: "urn:uac:lab:document".to_string(),
                actions: [Action::Read, Action::Write].into(),
                not_before: 1_700_000_000,
                expires_at: 1_700_003_600,
                remaining_delegations: 2,
                parent: None,
                nonce: [0x11; 16],
            },
        )
        .expect("root grant");
        let child = delegation::sign(
            &service,
            DelegationGrant {
                profile: delegation::PROFILE.to_string(),
                issuer,
                delegator: Some([0xa0; 32]),
                audience: [0xb0; 32],
                resource: "urn:uac:lab:document".to_string(),
                actions: [Action::Read].into(),
                not_before: 1_700_000_060,
                expires_at: 1_700_001_800,
                remaining_delegations: 1,
                parent: Some(delegation::id(&root).expect("root id")),
                nonce: [0x22; 16],
            },
        )
        .expect("child grant");
        (service, vec![root, child])
    }

    #[test]
    fn export_is_byte_deterministic() {
        let (service, chain) = fixture_chain();
        let leaf = &chain[1].body;
        let root_key = service.verifying_key().to_bytes();
        let context = Context {
            root: &root_key,
            verified_holder: &leaf.audience,
            resource: &leaf.resource,
            action: Action::Read,
            now: 1_700_000_100,
            revoked: &EMPTY_REVOKED,
        };
        let first = export_token(&chain, context, &service).expect("export");
        let context = Context {
            root: &root_key,
            verified_holder: &leaf.audience,
            resource: &leaf.resource,
            action: Action::Read,
            now: 1_700_000_100,
            revoked: &EMPTY_REVOKED,
        };
        assert_eq!(
            first,
            export_token(&chain, context, &service).expect("export")
        );
        assert_eq!(
            first.split('.').count(),
            3,
            "compact JWS has three segments"
        );
    }

    #[test]
    fn export_requires_valid_chain_and_matching_key() {
        let (service, chain) = fixture_chain();
        let root_key = service.verifying_key().to_bytes();
        let leaf = &chain[1].body;
        let base = |now: u64| Context {
            root: &root_key,
            verified_holder: &leaf.audience,
            resource: &leaf.resource,
            action: Action::Read,
            now,
            revoked: &EMPTY_REVOKED,
        };
        let other = SigningKey::from_bytes(&[8; 32]);
        assert_eq!(
            export_token(&chain, base(1_700_000_100), &other),
            Err(Error::UntrustedRoot)
        );
        assert_eq!(
            export_token(&chain, base(1_700_001_800), &service),
            Err(Error::Time)
        );
        let mut tampered = chain.clone();
        tampered[1].signature[0] ^= 1;
        assert_eq!(
            export_token(&tampered, base(1_700_000_100), &service),
            Err(Error::Signature)
        );
    }

    #[test]
    fn did_key_and_cid_have_stable_shapes() {
        let did = did_key(&service_key_bytes());
        assert!(did.starts_with("did:key:z"));
        assert!((40..=60).contains(&did.len()));
        let cid = link_cid(&[0; 32]);
        assert!(cid.starts_with('Q'), "CIDv0 multihash prefix");
        assert_eq!(cid.len(), 46);
    }

    fn service_key_bytes() -> [u8; 32] {
        SigningKey::from_bytes(&[9; 32]).verifying_key().to_bytes()
    }
}
