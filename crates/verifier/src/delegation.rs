use crate::{Action, Error, Signed};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Deserializer, Serialize, de};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const PROFILE: &str = "heavenkey-delegation-v1";
pub const MAX_CHAIN: usize = 5;
pub const MAX_LINK_BYTES: usize = 4096;
pub const MAX_SAFE_TIME: u64 = 9_007_199_254_740_991;
const DOMAIN: &[u8] = b"HEAVENKEY-DELEGATION-v1\0";

#[derive(Debug, Clone, Serialize)]
pub struct DelegationGrant {
    pub profile: String,
    pub issuer: [u8; 32],
    pub delegator: Option<[u8; 32]>,
    pub audience: [u8; 32],
    pub resource: String,
    pub actions: BTreeSet<Action>,
    pub not_before: u64,
    pub expires_at: u64,
    pub remaining_delegations: u8,
    pub parent: Option<[u8; 32]>,
    pub nonce: [u8; 16],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireGrant {
    profile: String,
    issuer: [u8; 32],
    #[serde(deserialize_with = "required_nullable")]
    delegator: Option<[u8; 32]>,
    audience: [u8; 32],
    resource: String,
    #[serde(deserialize_with = "unique_actions")]
    actions: BTreeSet<Action>,
    not_before: u64,
    expires_at: u64,
    remaining_delegations: u8,
    #[serde(deserialize_with = "required_nullable")]
    parent: Option<[u8; 32]>,
    nonce: [u8; 16],
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

fn unique_actions<'de, D>(deserializer: D) -> Result<BTreeSet<Action>, D::Error>
where
    D: Deserializer<'de>,
{
    let actions = Vec::<Action>::deserialize(deserializer)?;
    let mut unique = BTreeSet::new();
    if actions.is_empty() || actions.into_iter().any(|action| !unique.insert(action)) {
        return Err(de::Error::custom("empty or duplicate delegation actions"));
    }
    Ok(unique)
}

impl<'de> Deserialize<'de> for DelegationGrant {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = WireGrant::deserialize(deserializer)?;
        let body = Self {
            profile: wire.profile,
            issuer: wire.issuer,
            delegator: wire.delegator,
            audience: wire.audience,
            resource: wire.resource,
            actions: wire.actions,
            not_before: wire.not_before,
            expires_at: wire.expires_at,
            remaining_delegations: wire.remaining_delegations,
            parent: wire.parent,
            nonce: wire.nonce,
        };
        validate_body(&body).map_err(|error| de::Error::custom(format!("{error:?}")))?;
        Ok(body)
    }
}

fn validate_body(body: &DelegationGrant) -> Result<(), Error> {
    if body.profile != PROFILE {
        return Err(Error::Encoding);
    }
    if !(1..=256).contains(&body.resource.len())
        || !body
            .resource
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte))
        || body.actions.is_empty()
        || body.remaining_delegations > 4
        || body.not_before > MAX_SAFE_TIME
        || body.expires_at > MAX_SAFE_TIME
    {
        return Err(Error::Limits);
    }
    if body.not_before >= body.expires_at {
        return Err(Error::Time);
    }
    if body
        .delegator
        .is_some_and(|delegator| delegator == body.audience)
        || body.delegator.is_some() != body.parent.is_some()
    {
        return Err(Error::Chain);
    }
    Ok(())
}

pub fn message(body: &DelegationGrant) -> Result<Vec<u8>, Error> {
    validate_body(body)?;
    let mut bytes = DOMAIN.to_vec();
    bytes.extend_from_slice(&body.issuer);
    bytes.push(u8::from(body.delegator.is_some()));
    if let Some(delegator) = body.delegator {
        bytes.extend_from_slice(&delegator);
    }
    bytes.extend_from_slice(&body.audience);
    bytes.extend_from_slice(&(body.resource.len() as u16).to_be_bytes());
    bytes.extend_from_slice(body.resource.as_bytes());
    let mask = body.actions.iter().fold(0, |mask, action| {
        mask | match action {
            Action::Read => 1,
            Action::Write => 2,
            Action::Unlock => 4,
        }
    });
    bytes.push(mask);
    bytes.extend_from_slice(&body.not_before.to_be_bytes());
    bytes.extend_from_slice(&body.expires_at.to_be_bytes());
    bytes.push(body.remaining_delegations);
    bytes.push(u8::from(body.parent.is_some()));
    if let Some(parent) = body.parent {
        bytes.extend_from_slice(&parent);
    }
    bytes.extend_from_slice(&body.nonce);
    Ok(bytes)
}

pub fn sign(key: &SigningKey, body: DelegationGrant) -> Result<Signed<DelegationGrant>, Error> {
    if body.issuer != key.verifying_key().to_bytes() {
        return Err(Error::UntrustedRoot);
    }
    let signature = key.sign(&message(&body)?).to_bytes().to_vec();
    let signed = Signed { body, signature };
    check_link_size(&signed)?;
    Ok(signed)
}

fn check_link_size(signed: &Signed<DelegationGrant>) -> Result<(), Error> {
    if signed.signature.len() != 64 {
        return Err(Error::Signature);
    }
    if serde_json::to_vec(signed)
        .map_err(|_| Error::Encoding)?
        .len()
        > MAX_LINK_BYTES
    {
        return Err(Error::Limits);
    }
    Ok(())
}

pub fn id(signed: &Signed<DelegationGrant>) -> Result<[u8; 32], Error> {
    check_link_size(signed)?;
    let mut hash = Sha256::new();
    hash.update(message(&signed.body)?);
    hash.update(&signed.signature);
    Ok(hash.finalize().into())
}

pub fn decode(bytes: &[u8]) -> Result<Signed<DelegationGrant>, Error> {
    if bytes.len() > MAX_LINK_BYTES {
        return Err(Error::Limits);
    }
    let signed = serde_json::from_slice(bytes).map_err(|_| Error::Encoding)?;
    check_link_size(&signed)?;
    Ok(signed)
}

pub fn verify_structure(chain: &[Signed<DelegationGrant>], root: &[u8; 32]) -> Result<(), Error> {
    if chain.is_empty() || chain.len() > MAX_CHAIN {
        return Err(Error::Limits);
    }
    let key = VerifyingKey::from_bytes(root).map_err(|_| Error::Signature)?;
    let mut previous: Option<&Signed<DelegationGrant>> = None;
    let mut audiences = BTreeSet::new();
    for signed in chain {
        check_link_size(signed)?;
        let grant = &signed.body;
        if grant.issuer != *root {
            return Err(Error::UntrustedRoot);
        }
        let signature = Signature::from_slice(&signed.signature).map_err(|_| Error::Signature)?;
        key.verify_strict(&message(grant)?, &signature)
            .map_err(|_| Error::Signature)?;
        if !audiences.insert(grant.audience) {
            return Err(Error::Chain);
        }
        if let Some(parent) = previous {
            let p = &parent.body;
            if grant.parent != Some(id(parent)?) || grant.delegator != Some(p.audience) {
                return Err(Error::Chain);
            }
            if grant.resource != p.resource
                || !grant.actions.is_subset(&p.actions)
                || grant.not_before < p.not_before
                || grant.expires_at > p.expires_at
                || p.remaining_delegations == 0
                || grant.remaining_delegations >= p.remaining_delegations
            {
                return Err(Error::Escalation);
            }
        } else if grant.parent.is_some() || grant.delegator.is_some() {
            return Err(Error::Chain);
        }
        previous = Some(signed);
    }
    Ok(())
}

pub struct Context<'a> {
    pub root: &'a [u8; 32],
    pub verified_holder: &'a [u8; 32],
    pub resource: &'a str,
    pub action: Action,
    pub now: u64,
    pub revoked: &'a BTreeSet<[u8; 32]>,
}

pub fn verify_chain(chain: &[Signed<DelegationGrant>], context: Context<'_>) -> Result<(), Error> {
    verify_structure(chain, context.root)?;
    if context.now > MAX_SAFE_TIME {
        return Err(Error::Time);
    }
    for signed in chain {
        if context.now < signed.body.not_before || context.now >= signed.body.expires_at {
            return Err(Error::Time);
        }
        if context.revoked.contains(&id(signed)?) {
            return Err(Error::Revoked);
        }
    }
    let leaf = &chain.last().ok_or(Error::Limits)?.body;
    if leaf.audience != *context.verified_holder
        || leaf.resource != context.resource
        || !leaf.actions.contains(&context.action)
    {
        return Err(Error::Invocation);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::BTreeMap;

    #[derive(Deserialize)]
    struct Vectors {
        seed_byte: u8,
        trusted_issuer: [u8; 32],
        fixtures: Vec<Fixture>,
        cases: Vec<Case>,
        invalid_json: Vec<InvalidJson>,
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
    }
    #[derive(Deserialize)]
    struct InvalidJson {
        name: String,
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
        std::array::from_fn(|i| {
            u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).expect("fixture hex")
        })
    }

    #[test]
    fn independent_typescript_messages_ids_and_signatures_match() {
        let vectors = vectors();
        let signer = SigningKey::from_bytes(&[vectors.seed_byte; 32]);
        assert_eq!(signer.verifying_key().to_bytes(), vectors.trusted_issuer);
        for fixture in vectors.fixtures {
            let bytes = serde_json::to_vec(&fixture.grant).expect("fixture JSON");
            let decoded = decode(&bytes);
            if let Some(expected) = fixture.message_hex {
                let grant = decoded.unwrap_or_else(|error| panic!("{}: {error:?}", fixture.name));
                assert_eq!(
                    hex(&message(&grant.body).expect("valid message")),
                    expected,
                    "{} message",
                    fixture.name
                );
                assert_eq!(
                    hex(&id(&grant).expect("valid ID")),
                    fixture.id_hex.expect("ID"),
                    "{} ID",
                    fixture.name
                );
                if fixture.name != "bad_signature" {
                    assert_eq!(
                        sign(&signer, grant.body)
                            .expect("validated signing")
                            .signature,
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
    fn independent_typescript_chain_allow_and_deny_cases_match() {
        let vectors = vectors();
        let fixtures: BTreeMap<_, _> = vectors
            .fixtures
            .iter()
            .map(|fixture| (&fixture.name, &fixture.grant))
            .collect();
        for case in vectors.cases {
            let chain: Result<Vec<_>, _> = case
                .chain
                .iter()
                .map(|name| {
                    decode(
                        &serde_json::to_vec(fixtures.get(name).expect("named fixture"))
                            .expect("JSON"),
                    )
                })
                .collect();
            let revoked = case.revoked.iter().map(|id| unhex::<32>(id)).collect();
            let allowed = chain
                .and_then(|chain| {
                    verify_chain(
                        &chain,
                        Context {
                            root: &vectors.trusted_issuer,
                            verified_holder: &case.audience,
                            resource: &case.resource,
                            action: case.action,
                            now: case.now,
                            revoked: &revoked,
                        },
                    )
                })
                .is_ok();
            assert_eq!(allowed, case.allowed, "{}", case.name);
        }
    }

    #[test]
    fn raw_json_duplicate_fields_and_size_are_rejected() {
        for invalid in vectors().invalid_json {
            assert!(decode(invalid.json.as_bytes()).is_err(), "{}", invalid.name);
        }
    }

    #[test]
    fn nullable_fields_are_required_and_all_byte_lengths_are_strict() {
        let original = vectors()
            .fixtures
            .into_iter()
            .find(|fixture| fixture.name == "root")
            .expect("root")
            .grant;
        for field in ["parent", "delegator", "nonce", "profile"] {
            let mut value = original.clone();
            value["body"].as_object_mut().expect("body").remove(field);
            assert!(
                decode(&serde_json::to_vec(&value).expect("JSON")).is_err(),
                "missing {field}"
            );
        }
        for (field, length) in [("issuer", 31), ("audience", 33), ("nonce", 15)] {
            let mut value = original.clone();
            value["body"][field] = serde_json::json!(vec![0; length]);
            assert!(
                decode(&serde_json::to_vec(&value).expect("JSON")).is_err(),
                "invalid {field} length"
            );
        }
        let mut value = original;
        value["signature"] = serde_json::json!(vec![0; 63]);
        assert_eq!(
            decode(&serde_json::to_vec(&value).expect("JSON")).err(),
            Some(Error::Signature)
        );
    }

    #[test]
    fn reordered_json_and_whitespace_do_not_change_signature_or_id() {
        let original = vectors()
            .fixtures
            .into_iter()
            .find(|fixture| fixture.name == "child")
            .expect("child");
        let compact =
            decode(&serde_json::to_vec(&original.grant).expect("compact")).expect("grant");
        let pretty = decode(
            serde_json::to_string_pretty(&original.grant)
                .expect("pretty")
                .as_bytes(),
        )
        .expect("pretty grant");
        assert_eq!(message(&compact.body), message(&pretty.body));
        assert_eq!(id(&compact), id(&pretty));
    }
}
