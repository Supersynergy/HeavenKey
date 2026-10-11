#![forbid(unsafe_code)]

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const GRANT_DOMAIN: &[u8] = b"UAC-AUDIT-GRANT-v0\0";
const INVOCATION_DOMAIN: &[u8] = b"UAC-AUDIT-INVOKE-v0\0";
pub const MAX_CHAIN: usize = 8;
pub const MAX_GRANT_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Action {
    Read,
    Write,
    Unlock,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub issuer: [u8; 32],
    pub audience: [u8; 32],
    pub resource: String,
    pub actions: BTreeSet<Action>,
    pub not_before: u64,
    pub expires_at: u64,
    pub remaining_delegations: u8,
    pub parent: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invocation {
    pub grant: [u8; 32],
    pub resource: String,
    pub action: Action,
    pub arguments_hash: [u8; 32],
    pub nonce: [u8; 32],
    pub issued_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signed<T> {
    pub body: T,
    pub signature: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Encoding,
    Limits,
    Signature,
    UntrustedRoot,
    Chain,
    Escalation,
    Time,
    ClockRollback,
    Revoked,
    Invocation,
    Replay,
}

fn message<T: Serialize>(domain: &[u8], body: &T) -> Result<Vec<u8>, Error> {
    let mut bytes = domain.to_vec();
    bytes.extend(serde_json::to_vec(body).map_err(|_| Error::Encoding)?);
    Ok(bytes)
}

pub fn sign_grant(key: &SigningKey, body: Grant) -> Result<Signed<Grant>, Error> {
    let signature = key.sign(&message(GRANT_DOMAIN, &body)?).to_bytes().to_vec();
    Ok(Signed { body, signature })
}

pub fn sign_invocation(key: &SigningKey, body: Invocation) -> Result<Signed<Invocation>, Error> {
    let signature = key
        .sign(&message(INVOCATION_DOMAIN, &body)?)
        .to_bytes()
        .to_vec();
    Ok(Signed { body, signature })
}

fn verify_signature<T: Serialize>(
    signed: &Signed<T>,
    public: &[u8; 32],
    domain: &[u8],
) -> Result<(), Error> {
    let key = VerifyingKey::from_bytes(public).map_err(|_| Error::Signature)?;
    let signature = Signature::from_slice(&signed.signature).map_err(|_| Error::Signature)?;
    key.verify_strict(&message(domain, &signed.body)?, &signature)
        .map_err(|_| Error::Signature)
}

pub fn grant_id(signed: &Signed<Grant>) -> Result<[u8; 32], Error> {
    let mut hash = Sha256::new();
    hash.update(GRANT_DOMAIN);
    hash.update(serde_json::to_vec(signed).map_err(|_| Error::Encoding)?);
    Ok(hash.finalize().into())
}

pub fn decode_grant(bytes: &[u8]) -> Result<Signed<Grant>, Error> {
    if bytes.len() > MAX_GRANT_BYTES {
        return Err(Error::Limits);
    }
    serde_json::from_slice(bytes).map_err(|_| Error::Encoding)
}

pub fn authorize_passkey_grant(
    signed: &Signed<Grant>,
    root: &[u8; 32],
    verified_holder: &[u8; 32],
    resource: &str,
    action: Action,
    now: u64,
    revoked: bool,
) -> Result<(), Error> {
    if serde_json::to_vec(signed)
        .map_err(|_| Error::Encoding)?
        .len()
        > MAX_GRANT_BYTES
    {
        return Err(Error::Limits);
    }
    verify_signature(signed, &signed.body.issuer, GRANT_DOMAIN)?;
    let grant = &signed.body;
    if &grant.issuer != root || grant.parent.is_some() {
        return Err(Error::UntrustedRoot);
    }
    if revoked {
        return Err(Error::Revoked);
    }
    if &grant.audience != verified_holder
        || grant.resource != resource
        || !grant.actions.contains(&action)
    {
        return Err(Error::Invocation);
    }
    if grant.not_before >= grant.expires_at || now < grant.not_before || now >= grant.expires_at {
        return Err(Error::Time);
    }
    Ok(())
}

pub struct RequestContext<'a> {
    pub now: u64,
    pub action: Action,
    pub arguments_hash: [u8; 32],
    pub expected_nonce: &'a [u8; 32],
}

pub struct Verifier {
    root: [u8; 32],
    resource: String,
    revoked: BTreeSet<[u8; 32]>,
    seen_nonces: BTreeSet<[u8; 32]>,
    last_time: u64,
}

impl Verifier {
    pub fn new(root: [u8; 32], resource: String) -> Self {
        Self {
            root,
            resource,
            revoked: BTreeSet::new(),
            seen_nonces: BTreeSet::new(),
            last_time: 0,
        }
    }

    pub fn revoke(&mut self, id: [u8; 32]) {
        self.revoked.insert(id);
    }

    pub fn verify(
        &mut self,
        chain: &[Signed<Grant>],
        invocation: &Signed<Invocation>,
        context: RequestContext<'_>,
    ) -> Result<(), Error> {
        if chain.is_empty() || chain.len() > MAX_CHAIN {
            return Err(Error::Limits);
        }
        if context.now < self.last_time {
            return Err(Error::ClockRollback);
        }
        self.last_time = context.now;
        let mut previous: Option<&Signed<Grant>> = None;
        for signed in chain {
            let grant = &signed.body;
            if serde_json::to_vec(signed)
                .map_err(|_| Error::Encoding)?
                .len()
                > MAX_GRANT_BYTES
            {
                return Err(Error::Limits);
            }
            verify_signature(signed, &grant.issuer, GRANT_DOMAIN)?;
            if grant.actions.is_empty() || grant.resource != self.resource {
                return Err(Error::Escalation);
            }
            if grant.not_before >= grant.expires_at
                || context.now < grant.not_before
                || context.now >= grant.expires_at
            {
                return Err(Error::Time);
            }
            if self.revoked.contains(&grant_id(signed)?) {
                return Err(Error::Revoked);
            }
            if let Some(parent) = previous {
                let p = &parent.body;
                if grant.issuer != p.audience || grant.parent != Some(grant_id(parent)?) {
                    return Err(Error::Chain);
                }
                if !grant.actions.is_subset(&p.actions)
                    || grant.not_before < p.not_before
                    || grant.expires_at > p.expires_at
                    || p.remaining_delegations == 0
                    || grant.remaining_delegations >= p.remaining_delegations
                {
                    return Err(Error::Escalation);
                }
            } else if grant.issuer != self.root || grant.parent.is_some() {
                return Err(Error::UntrustedRoot);
            }
            previous = Some(signed);
        }
        let leaf = previous.ok_or(Error::Limits)?;
        let request = &invocation.body;
        verify_signature(invocation, &leaf.body.audience, INVOCATION_DOMAIN)?;
        if request.grant != grant_id(leaf)?
            || request.resource != self.resource
            || request.action != context.action
            || request.arguments_hash != context.arguments_hash
            || request.nonce != *context.expected_nonce
            || !leaf.body.actions.contains(&context.action)
        {
            return Err(Error::Invocation);
        }
        if context.now < request.issued_at || context.now - request.issued_at >= 30 {
            return Err(Error::Time);
        }
        if !self.seen_nonces.insert(request.nonce) {
            return Err(Error::Replay);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESOURCE: &str = "urn:demo:tool:alpha";
    const NOW: u64 = 100;
    const NONCE: [u8; 32] = [7; 32];
    const ARGS: [u8; 32] = [9; 32];

    fn key(byte: u8) -> SigningKey {
        SigningKey::from_bytes(&[byte; 32])
    }

    fn fixture() -> (Verifier, Vec<Signed<Grant>>, Signed<Invocation>) {
        let root = key(1);
        let owner = key(2);
        let guest = key(3);
        let parent = sign_grant(
            &root,
            Grant {
                issuer: root.verifying_key().to_bytes(),
                audience: owner.verifying_key().to_bytes(),
                resource: RESOURCE.into(),
                actions: [Action::Read, Action::Write].into(),
                not_before: 0,
                expires_at: 1000,
                remaining_delegations: 1,
                parent: None,
            },
        )
        .unwrap();
        let child = sign_grant(
            &owner,
            Grant {
                issuer: owner.verifying_key().to_bytes(),
                audience: guest.verifying_key().to_bytes(),
                resource: RESOURCE.into(),
                actions: [Action::Read].into(),
                not_before: 10,
                expires_at: 200,
                remaining_delegations: 0,
                parent: Some(grant_id(&parent).unwrap()),
            },
        )
        .unwrap();
        let invocation = sign_invocation(
            &guest,
            Invocation {
                grant: grant_id(&child).unwrap(),
                resource: RESOURCE.into(),
                action: Action::Read,
                arguments_hash: ARGS,
                nonce: NONCE,
                issued_at: NOW,
            },
        )
        .unwrap();
        (
            Verifier::new(root.verifying_key().to_bytes(), RESOURCE.into()),
            vec![parent, child],
            invocation,
        )
    }

    fn check(
        v: &mut Verifier,
        c: &[Signed<Grant>],
        i: &Signed<Invocation>,
        now: u64,
    ) -> Result<(), Error> {
        v.verify(
            c,
            i,
            RequestContext {
                now,
                action: Action::Read,
                arguments_hash: ARGS,
                expected_nonce: &NONCE,
            },
        )
    }

    fn change_child(
        c: &mut [Signed<Grant>],
        i: &mut Signed<Invocation>,
        change: impl FnOnce(&mut Grant),
    ) {
        change(&mut c[1].body);
        c[1] = sign_grant(&key(2), c[1].body.clone()).unwrap();
        i.body.grant = grant_id(&c[1]).unwrap();
        *i = sign_invocation(&key(3), i.body.clone()).unwrap();
    }

    #[test]
    fn accepts_valid_attenuated_chain() {
        let (mut v, c, i) = fixture();
        assert_eq!(check(&mut v, &c, &i, NOW), Ok(()));
    }

    #[test]
    fn rejects_signed_rights_escalation() {
        let (mut v, mut c, mut i) = fixture();
        change_child(&mut c, &mut i, |g| {
            g.actions.insert(Action::Unlock);
        });
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Escalation));
    }

    #[test]
    fn rejects_different_resource() {
        let (mut v, mut c, mut i) = fixture();
        change_child(&mut c, &mut i, |g| g.resource = "urn:demo:tool:beta".into());
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Escalation));
    }

    #[test]
    fn rejects_child_outliving_parent() {
        let (mut v, mut c, mut i) = fixture();
        change_child(&mut c, &mut i, |g| g.expires_at = 1001);
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Escalation));
    }

    #[test]
    fn rejects_child_with_earlier_validity() {
        let (mut v, mut c, mut i) = fixture();
        c[0].body.not_before = 20;
        c[0] = sign_grant(&key(1), c[0].body.clone()).unwrap();
        let parent_id = grant_id(&c[0]).unwrap();
        change_child(&mut c, &mut i, |g| g.parent = Some(parent_id));
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Escalation));
    }

    #[test]
    fn rejects_delegation_budget_expansion() {
        let (mut v, mut c, mut i) = fixture();
        change_child(&mut c, &mut i, |g| g.remaining_delegations = 1);
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Escalation));
    }

    #[test]
    fn rejects_delegation_when_parent_forbids_it() {
        let (mut v, mut c, mut i) = fixture();
        c[0].body.remaining_delegations = 0;
        c[0] = sign_grant(&key(1), c[0].body.clone()).unwrap();
        let parent_id = grant_id(&c[0]).unwrap();
        change_child(&mut c, &mut i, |g| g.parent = Some(parent_id));
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Escalation));
    }

    #[test]
    fn rejects_broken_parent_binding() {
        let (mut v, mut c, mut i) = fixture();
        change_child(&mut c, &mut i, |g| g.parent = Some([0; 32]));
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Chain));
    }

    #[test]
    fn rejects_wrong_intermediate_issuer() {
        let (mut v, mut c, mut i) = fixture();
        c[1].body.issuer = key(4).verifying_key().to_bytes();
        c[1] = sign_grant(&key(4), c[1].body.clone()).unwrap();
        i.body.grant = grant_id(&c[1]).unwrap();
        i = sign_invocation(&key(3), i.body).unwrap();
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Chain));
    }

    #[test]
    fn rejects_untrusted_root() {
        let (_, c, i) = fixture();
        let mut v = Verifier::new(key(4).verifying_key().to_bytes(), RESOURCE.into());
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::UntrustedRoot));
    }

    #[test]
    fn rejects_expired_grant_at_boundary() {
        let (mut v, c, i) = fixture();
        assert_eq!(check(&mut v, &c, &i, 200), Err(Error::Time));
    }

    #[test]
    fn rejects_future_grant() {
        let (mut v, mut c, mut i) = fixture();
        change_child(&mut c, &mut i, |g| g.not_before = 101);
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Time));
    }

    #[test]
    fn rejects_clock_rollback_within_process() {
        let (mut v, c, i) = fixture();
        assert_eq!(check(&mut v, &c, &i, 101), Ok(()));
        assert_eq!(check(&mut v, &c, &i, 100), Err(Error::ClockRollback));
    }

    #[test]
    fn rejects_tampered_signature() {
        let (mut v, mut c, i) = fixture();
        c[1].signature[0] ^= 1;
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Signature));
    }

    #[test]
    fn requires_holder_proof_even_with_valid_chain() {
        let (mut v, c, i) = fixture();
        let forged = sign_invocation(&key(4), i.body).unwrap();
        assert_eq!(check(&mut v, &c, &forged, NOW), Err(Error::Signature));
    }

    #[test]
    fn rejects_replayed_invocation() {
        let (mut v, c, i) = fixture();
        assert_eq!(check(&mut v, &c, &i, NOW), Ok(()));
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Replay));
    }

    #[test]
    fn rejects_unknown_challenge() {
        let (mut v, c, mut i) = fixture();
        i.body.nonce = [8; 32];
        i = sign_invocation(&key(3), i.body).unwrap();
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Invocation));
    }

    #[test]
    fn rejects_changed_request_arguments() {
        let (mut v, c, mut i) = fixture();
        i.body.arguments_hash = [0; 32];
        i = sign_invocation(&key(3), i.body).unwrap();
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Invocation));
    }

    #[test]
    fn rejects_request_action_outside_context() {
        let (mut v, c, mut i) = fixture();
        i.body.action = Action::Write;
        i = sign_invocation(&key(3), i.body).unwrap();
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Invocation));
    }

    #[test]
    fn rejects_old_invocation_at_boundary() {
        let (mut v, c, i) = fixture();
        assert_eq!(check(&mut v, &c, &i, 130), Err(Error::Time));
    }

    #[test]
    fn rejects_descendant_of_revoked_parent() {
        let (mut v, c, i) = fixture();
        v.revoke(grant_id(&c[0]).unwrap());
        assert_eq!(check(&mut v, &c, &i, NOW), Err(Error::Revoked));
    }

    #[test]
    fn offline_verifier_cannot_know_remote_revocation() {
        let (mut offline, c, i) = fixture();
        let (mut online, _, _) = fixture();
        online.revoke(grant_id(&c[0]).unwrap());
        assert_eq!(check(&mut online, &c, &i, NOW), Err(Error::Revoked));
        assert_eq!(check(&mut offline, &c, &i, NOW), Ok(()));
    }

    #[test]
    fn rejects_empty_and_excessive_chains() {
        let (mut v, c, i) = fixture();
        assert_eq!(check(&mut v, &[], &i, NOW), Err(Error::Limits));
        assert_eq!(
            check(&mut v, &vec![c[0].clone(); MAX_CHAIN + 1], &i, NOW),
            Err(Error::Limits)
        );
    }

    #[test]
    fn rejects_oversized_and_unknown_fields_before_verification() {
        assert!(matches!(
            decode_grant(&vec![0; MAX_GRANT_BYTES + 1]),
            Err(Error::Limits)
        ));
        let (_, c, _) = fixture();
        let mut value = serde_json::to_value(&c[0]).unwrap();
        value["body"]["geofence"] = serde_json::json!({"radius":25});
        assert!(matches!(
            decode_grant(&serde_json::to_vec(&value).unwrap()),
            Err(Error::Encoding)
        ));
        assert!(decode_grant(&serde_json::to_vec(&c[0]).unwrap()).is_ok());
    }
}
