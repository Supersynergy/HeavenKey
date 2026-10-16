#![forbid(unsafe_code)]

//! High-entropy recovery codes. Only account-bound digests belong in storage.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub fn generate() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!("hk-recovery-v1.{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub fn digest(account: &str, code: &str) -> Option<[u8; 32]> {
    let encoded = code.strip_prefix("hk-recovery-v1.")?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != encoded {
        return None;
    }
    let mut hash = Sha256::new();
    hash.update(b"HEAVENKEY-ACCOUNT-RECOVERY-v1\0");
    hash.update((account.len() as u64).to_be_bytes());
    hash.update(account.as_bytes());
    hash.update(bytes);
    Some(hash.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codes_are_random_canonical_and_account_bound() {
        let a = generate();
        let b = generate();
        assert_ne!(a, b);
        assert_ne!(digest("a", &a), digest("b", &a));
        assert_ne!(digest("a", &a), digest("a", &b));
        assert!(digest("a", "short").is_none());
        assert!(digest("a", &(a.clone() + "=")).is_none());
        assert!(digest("a", &a).is_some());
    }
}
