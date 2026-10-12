//! Extended edge-case parity tests for the heavenkey-delegation-v1 vectors.
//!
//! Loads the same independent TypeScript vectors as the unit tests and asserts
//! exact message/id/signature parity plus every deny expectation, including the
//! extended deep-chain, boundary and malformed-JSON coverage.

use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use uac_verifier::delegation::{
    Context, DelegationGrant, decode, id, message, sign, verify_chain, verify_structure,
};
use uac_verifier::{Action, Error, Signed};

#[derive(Deserialize)]
struct Vectors {
    seed_byte: u8,
    trusted_issuer: [u8; 32],
    fixtures: Vec<Fixture>,
    cases: Vec<Case>,
    invalid_json: Vec<InvalidJson>,
    #[serde(default)]
    equivalent_json: Vec<EquivalentJson>,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    grant: Value,
    message_hex: Option<String>,
    id_hex: Option<String>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    chain: Vec<String>,
    audience: [u8; 32],
    resource: String,
    action: Action,
    now: u64,
    revoked: Vec<String>,
    allowed: bool,
    expect_error: Option<String>,
    issuer: Option<[u8; 32]>,
}

#[derive(Deserialize)]
struct InvalidJson {
    name: String,
    json: String,
}

#[derive(Deserialize)]
struct EquivalentJson {
    name: String,
    fixture: String,
    json: String,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("../../../docs/vectors/delegation-v1.json"))
        .expect("independent TypeScript vectors")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex<const N: usize>(value: &str) -> [u8; N] {
    assert_eq!(value.len(), N * 2);
    std::array::from_fn(|i| u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).expect("fixture hex"))
}

fn fixture_grants<'a>(
    fixtures: &'a BTreeMap<String, &'a Fixture>,
    names: &[String],
) -> Result<Vec<Signed<DelegationGrant>>, Error> {
    names
        .iter()
        .map(|name| {
            decode(
                &serde_json::to_vec(&fixtures.get(name).expect("named fixture").grant)
                    .expect("fixture JSON"),
            )
        })
        .collect()
}

fn expected_error(name: &str) -> Error {
    match name {
        "Encoding" => Error::Encoding,
        "Limits" => Error::Limits,
        "Signature" => Error::Signature,
        "UntrustedRoot" => Error::UntrustedRoot,
        "Chain" => Error::Chain,
        "Escalation" => Error::Escalation,
        "Time" => Error::Time,
        "Revoked" => Error::Revoked,
        "Invocation" => Error::Invocation,
        other => panic!("unknown expected error {other}"),
    }
}

#[test]
fn edge_fixture_messages_ids_and_signatures_match() {
    let vectors = vectors();
    let signer = SigningKey::from_bytes(&[vectors.seed_byte; 32]);
    assert_eq!(signer.verifying_key().to_bytes(), vectors.trusted_issuer);
    for fixture in vectors.fixtures {
        let bytes = serde_json::to_vec(&fixture.grant).expect("fixture JSON");
        let decoded = decode(&bytes);
        if let Some(expected_message) = fixture.message_hex {
            let grant = decoded.unwrap_or_else(|error| panic!("{}: {error:?}", fixture.name));
            assert_eq!(
                hex(&message(&grant.body).expect("valid message")),
                expected_message,
                "{} message",
                fixture.name
            );
            assert_eq!(
                hex(&id(&grant).expect("valid ID")),
                fixture.id_hex.expect("ID"),
                "{} ID",
                fixture.name
            );
            let resigned = sign(&signer, grant.body.clone());
            if grant.body.issuer != vectors.trusted_issuer {
                assert_eq!(
                    resigned.err(),
                    Some(Error::UntrustedRoot),
                    "{} foreign issuer must not sign",
                    fixture.name
                );
            } else if fixture.name == "bad_signature" {
                assert_ne!(
                    resigned.expect("resign").signature,
                    grant.signature,
                    "{} tampered signature",
                    fixture.name
                );
            } else {
                assert_eq!(
                    resigned.expect("resign").signature,
                    grant.signature,
                    "{} signature",
                    fixture.name
                );
            }
        } else {
            assert!(
                decoded.is_err(),
                "{} rejects invalid encoding",
                fixture.name
            );
        }
    }
}

#[test]
fn edge_chain_allow_and_deny_cases_match() {
    let vectors = vectors();
    let fixtures: BTreeMap<String, &Fixture> = vectors
        .fixtures
        .iter()
        .map(|fixture| (fixture.name.clone(), fixture))
        .collect();
    assert!(vectors.cases.len() >= 50, "extended case coverage present");
    for case in vectors.cases {
        let revoked: BTreeSet<[u8; 32]> = case.revoked.iter().map(|id| unhex::<32>(id)).collect();
        let root = case.issuer.as_ref().unwrap_or(&vectors.trusted_issuer);
        let outcome = fixture_grants(&fixtures, &case.chain).and_then(|chain| {
            verify_chain(
                &chain,
                Context {
                    root,
                    verified_holder: &case.audience,
                    resource: &case.resource,
                    action: case.action,
                    now: case.now,
                    revoked: &revoked,
                },
            )
        });
        assert_eq!(outcome.is_ok(), case.allowed, "{}", case.name);
        if let Some(expected) = &case.expect_error {
            assert_eq!(
                outcome.expect_err("denied case"),
                expected_error(expected),
                "{} error kind",
                case.name
            );
        }
    }
}

#[test]
fn edge_deep_chain_structure_variants() {
    let vectors = vectors();
    let fixtures: BTreeMap<String, &Fixture> = vectors
        .fixtures
        .iter()
        .map(|fixture| (fixture.name.clone(), fixture))
        .collect();
    let names = |names: &[&str]| {
        names
            .iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>()
    };
    let four = fixture_grants(&fixtures, &names(&["a1", "a2", "a3", "a4"])).expect("four links");
    let five =
        fixture_grants(&fixtures, &names(&["b1", "b2", "b3", "b4", "b5"])).expect("five links");
    assert!(verify_structure(&four, &vectors.trusted_issuer).is_ok());
    assert!(verify_structure(&five, &vectors.trusted_issuer).is_ok());
    assert_eq!(five.len(), 5);
    assert_eq!(five.last().expect("leaf").body.remaining_delegations, 0);
    let six = fixture_grants(
        &fixtures,
        &names(&["depth_1", "depth_2", "depth_3", "depth_4", "six_5", "six_6"]),
    )
    .expect("six links decode");
    assert_eq!(
        verify_structure(&six, &vectors.trusted_issuer),
        Err(Error::Limits)
    );
    let skipped = fixture_grants(&fixtures, &names(&["root", "grandchild"])).expect("decodes");
    assert_eq!(
        verify_structure(&skipped, &vectors.trusted_issuer),
        Err(Error::Chain)
    );
    let doubled_root =
        fixture_grants(&fixtures, &names(&["root", "second_root"])).expect("decodes");
    assert_eq!(
        verify_structure(&doubled_root, &vectors.trusted_issuer),
        Err(Error::Chain)
    );
    let exhausted =
        fixture_grants(&fixtures, &names(&["exhausted_root", "exhausted_child"])).expect("decodes");
    assert_eq!(
        verify_structure(&exhausted, &vectors.trusted_issuer),
        Err(Error::Escalation)
    );
    let two_hop_cycle =
        fixture_grants(&fixtures, &names(&["a1", "a2", "a3", "a4_cycle"])).expect("decodes");
    assert_eq!(
        verify_structure(&two_hop_cycle, &vectors.trusted_issuer),
        Err(Error::Chain)
    );
    let root_only = fixture_grants(&fixtures, &names(&["root"])).expect("decodes");
    let foreign_root = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
    assert_eq!(
        verify_structure(&root_only, &foreign_root),
        Err(Error::UntrustedRoot)
    );
}

#[test]
fn edge_invalid_json_vectors_are_rejected() {
    let vectors = vectors();
    assert!(
        vectors.invalid_json.len() >= 25,
        "extended malformed coverage"
    );
    for invalid in vectors.invalid_json {
        assert!(decode(invalid.json.as_bytes()).is_err(), "{}", invalid.name);
    }
}

#[test]
fn edge_equivalent_json_serializations_keep_id_and_message() {
    let vectors = vectors();
    let fixtures: BTreeMap<String, &Fixture> = vectors
        .fixtures
        .iter()
        .map(|fixture| (fixture.name.clone(), fixture))
        .collect();
    assert!(!vectors.equivalent_json.is_empty());
    for entry in vectors.equivalent_json {
        let decoded = decode(entry.json.as_bytes())
            .unwrap_or_else(|error| panic!("{}: {error:?}", entry.name));
        let fixture = fixtures.get(&entry.fixture).expect("named fixture");
        assert_eq!(
            hex(&message(&decoded.body).expect("message")),
            fixture.message_hex.clone().expect("fixture message"),
            "{} message",
            entry.name
        );
        assert_eq!(
            hex(&id(&decoded).expect("ID")),
            fixture.id_hex.clone().expect("fixture ID"),
            "{} ID",
            entry.name
        );
    }
}
