#![forbid(unsafe_code)]

//! Authenticated issuer-key envelope, protected by an OS store or explicit external key file.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use openssl::symm::{Cipher, decrypt_aead, encrypt_aead};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, fs, io::Write, path::Path};
use zeroize::Zeroizing;

const AAD: &[u8] = b"HEAVENKEY-ISSUER-ENVELOPE-v1";
#[derive(Debug)]
pub struct StoreError(&'static str);
impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for StoreError {}
type Result<T> = std::result::Result<T, StoreError>;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    nonce: String,
    ciphertext: String,
    tag: String,
}

fn encode(secret: &[u8; 32], master: &[u8; 32]) -> Result<Vec<u8>> {
    let mut nonce = [0; 12];
    rand::rng().fill_bytes(&mut nonce);
    let mut tag = [0; 16];
    let ciphertext = encrypt_aead(
        Cipher::aes_256_gcm(),
        master,
        Some(&nonce),
        AAD,
        secret,
        &mut tag,
    )
    .map_err(|_| StoreError("issuer encryption failed"))?;
    serde_json::to_vec(&Envelope {
        version: 1,
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        tag: URL_SAFE_NO_PAD.encode(tag),
    })
    .map_err(|_| StoreError("issuer encoding failed"))
}
fn decode(bytes: &[u8], master: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>> {
    if bytes.len() > 2048 {
        return Err(StoreError("invalid issuer envelope"));
    }
    let e: Envelope =
        serde_json::from_slice(bytes).map_err(|_| StoreError("invalid issuer envelope"))?;
    let decode = |v: &str| {
        URL_SAFE_NO_PAD
            .decode(v)
            .map_err(|_| StoreError("invalid issuer envelope"))
    };
    let nonce = decode(&e.nonce)?;
    let ciphertext = decode(&e.ciphertext)?;
    let tag = decode(&e.tag)?;
    if e.version != 1 || nonce.len() != 12 || ciphertext.len() != 32 || tag.len() != 16 {
        return Err(StoreError("invalid issuer envelope"));
    }
    let plain = Zeroizing::new(
        decrypt_aead(
            Cipher::aes_256_gcm(),
            master,
            Some(&nonce),
            AAD,
            &ciphertext,
            &tag,
        )
        .map_err(|_| {
            StoreError("issuer authentication failed; protection key is wrong or data changed")
        })?,
    );
    let array: [u8; 32] = plain
        .as_slice()
        .try_into()
        .map_err(|_| StoreError("invalid issuer seed"))?;
    Ok(Zeroizing::new(array))
}
fn protected_read(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| StoreError("protected file unavailable"))?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(StoreError("invalid protected file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(StoreError("protected file must have permissions 0600"));
        }
    }
    fs::read(path).map_err(|_| StoreError("protected file read failed"))
}
fn persist(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut random = [0u8; 16];
    rand::rng().fill_bytes(&mut random);
    let temporary = path.with_extension(format!("{}.tmp", URL_SAFE_NO_PAD.encode(random)));
    let write = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| StoreError("protected file create failed"))?;
        file.write_all(bytes)
            .map_err(|_| StoreError("protected file write failed"))?;
        file.sync_all()
            .map_err(|_| StoreError("protected file sync failed"))?;
        fs::rename(&temporary, path).map_err(|_| StoreError("protected file commit failed"))?;
        Ok(())
    })();
    if write.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write
}
fn master(data: &Path, key_file: Option<&Path>, existing: bool) -> Result<Zeroizing<[u8; 32]>> {
    if let Some(path) = key_file {
        let canonical =
            fs::canonicalize(path).map_err(|_| StoreError("external protection file missing"))?;
        let data = fs::canonicalize(data).map_err(|_| StoreError("data path unavailable"))?;
        if canonical.starts_with(data) {
            return Err(StoreError(
                "protection key file must be outside the data directory",
            ));
        }
        let bytes = Zeroizing::new(protected_read(path, 32)?);
        return Ok(Zeroizing::new(bytes.as_slice().try_into().map_err(
            |_| StoreError("external protection key must contain exactly 32 bytes"),
        )?));
    }
    let data = fs::canonicalize(data).map_err(|_| StoreError("data path unavailable"))?;
    let name = URL_SAFE_NO_PAD.encode(Sha256::digest(data.to_string_lossy().as_bytes()));
    let entry = keyring::Entry::new("HeavenKey issuer protection v1", &name).map_err(|_| StoreError("OS credential store unavailable; configure an external protection key file for headless use"))?;
    let bytes = match entry.get_secret() {
        Ok(secret) => Zeroizing::new(secret),
        Err(keyring::Error::NoEntry) if !existing => {
            let mut secret = Zeroizing::new(vec![0u8; 32]);
            rand::rng().fill_bytes(&mut secret);
            entry
                .set_secret(&secret)
                .map_err(|_| StoreError("OS credential store write failed"))?;
            let check = Zeroizing::new(
                entry
                    .get_secret()
                    .map_err(|_| StoreError("OS credential store readback failed"))?,
            );
            if check.as_slice() != secret.as_slice() {
                return Err(StoreError("OS credential store readback mismatch"));
            }
            secret
        }
        Err(_) => {
            return Err(StoreError(
                "OS credential store locked, missing, or unavailable; no file fallback was used",
            ));
        }
    };
    Ok(Zeroizing::new(
        bytes
            .as_slice()
            .try_into()
            .map_err(|_| StoreError("invalid OS protection key"))?,
    ))
}

pub fn load_issuer(data: &Path, key_file: Option<&Path>) -> Result<Zeroizing<[u8; 32]>> {
    load_issuer_with_seed(data, key_file, None)
}

pub fn load_issuer_with_seed(
    data: &Path,
    key_file: Option<&Path>,
    imported: Option<&[u8; 32]>,
) -> Result<Zeroizing<[u8; 32]>> {
    let envelope = data.join("issuer.enc");
    let legacy = data.join("issuer.key");
    let master = master(data, key_file, envelope.exists())?;
    if envelope.exists() {
        let secret = decode(&protected_read(&envelope, 2048)?, &master)?;
        if imported.is_some_and(|seed| seed != secret.as_ref()) {
            return Err(StoreError(
                "conflicting issuer custody: database and envelope differ",
            ));
        }
        if legacy.exists() {
            let old = Zeroizing::new(protected_read(&legacy, 32)?);
            if old.as_slice() != secret.as_slice() {
                return Err(StoreError("legacy issuer and protected issuer differ"));
            }
            fs::remove_file(legacy).map_err(|_| StoreError("legacy issuer cleanup failed"))?;
        }
        return Ok(secret);
    }
    let secret = if legacy.exists() {
        let bytes = Zeroizing::new(protected_read(&legacy, 32)?);
        if imported.is_some_and(|seed| seed.as_slice() != bytes.as_slice()) {
            return Err(StoreError(
                "conflicting issuer custody: database and legacy file differ",
            ));
        }
        Zeroizing::new(
            bytes
                .as_slice()
                .try_into()
                .map_err(|_| StoreError("invalid legacy issuer"))?,
        )
    } else if let Some(seed) = imported {
        Zeroizing::new(*seed)
    } else {
        let mut bytes = Zeroizing::new([0u8; 32]);
        rand::rng().fill_bytes(bytes.as_mut());
        bytes
    };
    persist(&envelope, &encode(&secret, &master)?)?;
    let verified = decode(&protected_read(&envelope, 2048)?, &master)?;
    if *verified != *secret {
        return Err(StoreError("issuer readback mismatch"));
    }
    if legacy.exists() {
        fs::remove_file(legacy).map_err(|_| StoreError("legacy issuer cleanup failed"))?;
    }
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_envelope_rejects_wrong_keys_tampering_and_versions() {
        let encoded = encode(&[7; 32], &[9; 32]).unwrap();
        assert_eq!(*decode(&encoded, &[9; 32]).unwrap(), [7; 32]);
        assert!(decode(&encoded, &[8; 32]).is_err());
        let mut e: Envelope = serde_json::from_slice(&encoded).unwrap();
        e.version = 2;
        assert!(decode(&serde_json::to_vec(&e).unwrap(), &[9; 32]).is_err());
        e.version = 1;
        e.tag = URL_SAFE_NO_PAD.encode([0u8; 16]);
        assert!(decode(&serde_json::to_vec(&e).unwrap(), &[9; 32]).is_err());
        assert_ne!(encode(&[7; 32], &[9; 32]).unwrap(), encoded);
        assert!(decode(&vec![0; 2049], &[9; 32]).is_err());
    }
    #[test]
    fn migration_preserves_issuer_and_restart_requires_the_same_external_key() {
        let directory = std::env::temp_dir().join(format!("hk-store-{}", rand::random::<u64>()));
        let data = directory.join("data");
        fs::create_dir_all(&data).unwrap();
        let key = directory.join("external.key");
        persist(&key, &[9; 32]).unwrap();
        persist(&data.join("issuer.key"), &[7; 32]).unwrap();
        assert_eq!(*load_issuer(&data, Some(&key)).unwrap(), [7; 32]);
        assert!(!data.join("issuer.key").exists());
        assert_eq!(*load_issuer(&data, Some(&key)).unwrap(), [7; 32]);
        persist(&key, &[8; 32]).unwrap();
        assert!(load_issuer(&data, Some(&key)).is_err());
        persist(&data.join("forbidden.key"), &[9; 32]).unwrap();
        assert!(load_issuer(&data, Some(&data.join("forbidden.key"))).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
