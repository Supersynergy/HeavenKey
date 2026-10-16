use base64::Engine as _;
use ed25519_dalek::SigningKey;
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

const PLAINTEXT_HEADER: &[u8; 16] = b"SQLite format 3\0";

pub struct Store {
    pub db: Connection,
    pub issuer: SigningKey,
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(text: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let text = text.trim();
    if !text.len().is_multiple_of(2) || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("store key must be hex".into());
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).map_err(Into::into))
        .collect()
}

fn key_dir(os: &str, lookup: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let nonempty = |name: &str| lookup(name).filter(|value| !value.is_empty());
    match os {
        "windows" => nonempty("LOCALAPPDATA").map(PathBuf::from),
        "macos" => {
            nonempty("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
        }
        _ => match nonempty("XDG_CONFIG_HOME") {
            Some(path) => Some(PathBuf::from(path)),
            None => nonempty("HOME").map(|home| PathBuf::from(home).join(".config")),
        },
    }
    .map(|base| base.join("heavenkey"))
}

fn key_file_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(path) = std::env::var_os("UAC_STORE_KEY_FILE").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(key_dir(std::env::consts::OS, |name| std::env::var_os(name))
        .ok_or("no config directory for the store key; set UAC_STORE_KEY or UAC_STORE_KEY_FILE")?
        .join("store.key"))
}

fn write_new_key(path: &Path) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }
    }
    let mut bytes = [0; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    use std::io::Write;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(bytes)
}

fn resolve_key() -> Result<[u8; 32], Box<dyn std::error::Error>> {
    if let Ok(value) = std::env::var("UAC_STORE_KEY") {
        let bytes = hex_decode(&value)?;
        return bytes
            .try_into()
            .map_err(|_| "UAC_STORE_KEY must be 64 hex characters".into());
    }
    let path = key_file_path()?;
    let bytes = if path.exists() {
        fs::read(&path)?
    } else {
        write_new_key(&path)?.to_vec()
    };
    bytes
        .try_into()
        .map_err(|_| format!("invalid store key length in {}", path.display()).into())
}

fn is_plaintext(db_path: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    if !db_path.exists() {
        return Ok(false);
    }
    let mut header = [0; 16];
    use std::io::Read;
    let mut file = fs::File::open(db_path)?;
    let read = file.read(&mut header)?;
    Ok(read == 16 && &header == PLAINTEXT_HEADER)
}

fn key_pragma(key: &[u8; 32]) -> String {
    format!("PRAGMA key = \"x'{}'\";", hex_encode(key))
}

fn open_encrypted(
    db_path: &Path,
    key: &[u8; 32],
) -> Result<Connection, Box<dyn std::error::Error>> {
    let db = Connection::open(db_path)?;
    db.execute_batch(&key_pragma(key))?;
    db.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(
            |_| "store key rejected: data could not be decrypted (wrong key or corrupt store)",
        )?;
    Ok(db)
}

fn migrate_plaintext(db_path: &Path, key: &[u8; 32]) -> Result<(), Box<dyn std::error::Error>> {
    let temp = db_path.with_file_name(format!(
        "{}.enc-tmp",
        db_path.file_name().unwrap_or_default().to_string_lossy()
    ));
    if temp.exists() {
        fs::remove_file(&temp)?;
    }
    {
        let plain = Connection::open(db_path)?;
        plain.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        plain.execute_batch(&format!(
            "ATTACH DATABASE '{}' AS enc KEY \"x'{}'\"; SELECT sqlcipher_export('enc'); DETACH DATABASE enc;",
            temp.to_string_lossy().replace('\'', "''"),
            hex_encode(key)
        ))?;
    }
    fs::rename(&temp, db_path)?;
    for side in ["-wal", "-shm"] {
        let side = db_path.with_file_name(format!(
            "{}{}",
            db_path.file_name().unwrap_or_default().to_string_lossy(),
            side
        ));
        if side.exists() {
            fs::remove_file(&side)?;
        }
    }
    Ok(())
}

fn custody_issuer(
    db: &Connection,
    data: &Path,
    generate: impl Fn() -> [u8; 32],
) -> Result<SigningKey, Box<dyn std::error::Error>> {
    let mut stored: Option<Vec<u8>> = db
        .query_row("SELECT value FROM meta WHERE key='issuer_key'", [], |row| {
            row.get(0)
        })
        .optional()?;
    let key_path = data.join("issuer.key");
    if key_path.exists() {
        let bytes = fs::read(&key_path)?;
        match &stored {
            Some(existing) if *existing != bytes => {
                return Err(
                    "conflicting issuer custody: meta key and issuer.key file differ".into(),
                );
            }
            Some(_) => {}
            None => {
                db.execute(
                    "INSERT INTO meta(key,value) VALUES('issuer_key',?1)",
                    params![bytes.clone()],
                )?;
                stored = Some(bytes);
            }
        }
        fs::remove_file(&key_path)?;
    }
    let bytes = match stored {
        Some(existing) => existing,
        None => {
            let bytes = generate().to_vec();
            db.execute(
                "INSERT INTO meta(key,value) VALUES('issuer_key',?1)",
                params![bytes],
            )?;
            bytes
        }
    };
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "invalid issuer key length in store")?;
    Ok(SigningKey::from_bytes(&bytes))
}

fn open_database(data: &Path, key: &[u8; 32]) -> Result<Connection, Box<dyn std::error::Error>> {
    let db_path = data.join("uac.sqlite");
    if is_plaintext(&db_path)? {
        migrate_plaintext(&db_path, key)?;
    }
    let db = open_encrypted(&db_path, key)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value BLOB NOT NULL);")?;
    Ok(db)
}

#[cfg(test)]
fn open_with_key(data: &Path, key: &[u8; 32]) -> Result<Store, Box<dyn std::error::Error>> {
    let db = open_database(data, key)?;
    let issuer = custody_issuer(&db, data, || {
        let mut bytes = [0; 32];
        rand::rng().fill_bytes(&mut bytes);
        bytes
    })?;
    Ok(Store { db, issuer })
}

pub fn open(data: &Path) -> Result<Store, Box<dyn std::error::Error>> {
    let key = resolve_key()?;
    let db = open_database(data, &key)?;
    let stored: Option<Vec<u8>> = db
        .query_row("SELECT value FROM meta WHERE key='issuer_key'", [], |row| {
            row.get(0)
        })
        .optional()?;
    let imported: Option<[u8; 32]> = stored
        .map(|bytes| {
            bytes
                .try_into()
                .map_err(|_| "invalid issuer key length in store")
        })
        .transpose()?;
    let key_file = std::env::var_os("HEAVENKEY_KEY_FILE").map(PathBuf::from);
    let bytes = uac_keystore::load_issuer_with_seed(data, key_file.as_deref(), imported.as_ref())?;
    let issuer = custody_issuer(&db, data, || *bytes)?;
    Ok(Store { db, issuer })
}

fn json_to_param(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(v) => rusqlite::types::Value::Integer(i64::from(*v)),
        Value::Number(v) => v
            .as_i64()
            .map(rusqlite::types::Value::Integer)
            .unwrap_or_else(|| rusqlite::types::Value::Real(v.as_f64().unwrap_or(0.0))),
        Value::String(v) => rusqlite::types::Value::Text(v.clone()),
        _ => rusqlite::types::Value::Text(value.to_string()),
    }
}

fn column_json(row: &rusqlite::Row, index: usize) -> Value {
    match row.get_ref(index) {
        Ok(rusqlite::types::ValueRef::Null) => Value::Null,
        Ok(rusqlite::types::ValueRef::Integer(v)) => json!(v),
        Ok(rusqlite::types::ValueRef::Real(v)) => json!(v),
        Ok(rusqlite::types::ValueRef::Text(v)) => {
            Value::String(String::from_utf8_lossy(v).into_owned())
        }
        Ok(rusqlite::types::ValueRef::Blob(v)) => {
            json!({ "blob_base64": base64::engine::general_purpose::STANDARD.encode(v) })
        }
        Err(_) => Value::Null,
    }
}

/// Operator maintenance: run one statement against the local store.
/// SELECT returns JSON rows; other statements return {"affected": n}.
/// Requires store key custody (UAC_STORE_KEY / store key file) like the server.
pub fn query(
    db: &Connection,
    sql: &str,
    parameters: &[Value],
) -> Result<String, Box<dyn std::error::Error>> {
    let mut statement = db.prepare(sql)?;
    let bound: Vec<rusqlite::types::Value> = parameters.iter().map(json_to_param).collect();
    if statement.column_count() == 0 {
        let affected = statement.execute(rusqlite::params_from_iter(bound))?;
        return Ok(json!({ "affected": affected }).to_string());
    }
    let columns = statement.column_count();
    let mut rows = statement.query(rusqlite::params_from_iter(bound))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(Value::Array(
            (0..columns).map(|i| column_json(row, i)).collect(),
        ));
    }
    Ok(Value::Array(out).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("heavenkey-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_key(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    #[test]
    fn new_store_is_encrypted_and_rejects_wrong_key() {
        let dir = temp_dir("wrongkey");
        {
            let store = open_with_key(&dir, &test_key(1)).unwrap();
            store
                .db
                .execute("CREATE TABLE t(v TEXT)", [])
                .and_then(|_| store.db.execute("INSERT INTO t VALUES('secret')", []))
                .unwrap();
        }
        let db_path = dir.join("uac.sqlite");
        assert!(!is_plaintext(&db_path).unwrap());
        assert!(open_with_key(&dir, &test_key(2)).is_err());
        let store = open_with_key(&dir, &test_key(1)).unwrap();
        let value: String = store
            .db
            .query_row("SELECT v FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "secret");
    }

    #[test]
    fn plaintext_database_migrates_and_loses_plaintext_sidecars() {
        let dir = temp_dir("migrate");
        let db_path = dir.join("uac.sqlite");
        {
            let plain = Connection::open(&db_path).unwrap();
            plain
                .execute_batch("CREATE TABLE legacy(v TEXT); INSERT INTO legacy VALUES('row');")
                .unwrap();
        }
        fs::write(dir.join("uac.sqlite-wal"), b"stale").unwrap();
        let store = open_with_key(&dir, &test_key(9)).unwrap();
        assert!(!is_plaintext(&db_path).unwrap());
        let wal = dir.join("uac.sqlite-wal");
        assert!(!wal.exists() || fs::read(&wal).unwrap() != b"stale");
        let value: String = store
            .db
            .query_row("SELECT v FROM legacy", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "row");
        assert!(open_with_key(&dir, &test_key(8)).is_err());
    }

    #[test]
    fn issuer_file_migrates_into_meta_and_is_removed() {
        let dir = temp_dir("issuer");
        fs::write(dir.join("issuer.key"), [5; 32]).unwrap();
        let store = open_with_key(&dir, &test_key(1)).unwrap();
        assert!(!dir.join("issuer.key").exists());
        assert_eq!(store.issuer.to_bytes(), [5; 32]);
        let stored: Vec<u8> = store
            .db
            .query_row("SELECT value FROM meta WHERE key='issuer_key'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(stored, [5; 32]);
    }

    #[test]
    fn issuer_file_conflicting_with_meta_fails_closed() {
        let dir = temp_dir("conflict");
        {
            let _ = open_with_key(&dir, &test_key(1)).unwrap();
        }
        fs::write(dir.join("issuer.key"), [9; 32]).unwrap();
        assert!(open_with_key(&dir, &test_key(1)).is_err());
    }

    #[test]
    fn generated_issuer_is_stable_across_reopen() {
        let dir = temp_dir("stable");
        let first = open_with_key(&dir, &test_key(1)).unwrap().issuer.to_bytes();
        let second = open_with_key(&dir, &test_key(1)).unwrap().issuer.to_bytes();
        assert_eq!(first, second);
    }

    #[test]
    fn custody_conflict_detects_changed_file() {
        let dir = temp_dir("custody");
        let db = Connection::open(dir.join("t.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value BLOB NOT NULL);")
            .unwrap();
        db.execute(
            "INSERT INTO meta VALUES('issuer_key',?1)",
            params![vec![1u8; 32]],
        )
        .unwrap();
        fs::write(dir.join("issuer.key"), [2; 32]).unwrap();
        assert!(custody_issuer(&db, &dir, || [3; 32]).is_err());
    }

    #[test]
    fn query_returns_rows_and_affected() {
        let dir = temp_dir("query");
        let store = open_with_key(&dir, &test_key(1)).unwrap();
        store
            .db
            .execute_batch("CREATE TABLE q(a TEXT,b INTEGER); INSERT INTO q VALUES('x',7);")
            .unwrap();
        let rows: Value = serde_json::from_str(
            &query(&store.db, "SELECT a,b FROM q WHERE b=?1", &[json!(7)]).unwrap(),
        )
        .unwrap();
        assert_eq!(rows, json!([["x", 7]]));
        let affected: Value = serde_json::from_str(
            &query(
                &store.db,
                "UPDATE q SET b=?1 WHERE a=?2",
                &[json!(8), json!("x")],
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(affected, json!({ "affected": 1 }));
    }

    #[test]
    fn key_dir_prefers_xdg_config() {
        let root = PathBuf::from("/cfg");
        let lookup = |name: &str| match name {
            "XDG_CONFIG_HOME" => Some(root.join("xdg").into_os_string()),
            "HOME" => Some(root.join("home").into_os_string()),
            _ => None,
        };
        assert_eq!(
            key_dir("linux", lookup).unwrap(),
            root.join("xdg/heavenkey")
        );
        let home_only = |name: &str| match name {
            "HOME" => Some(root.join("home").into_os_string()),
            _ => None,
        };
        assert_eq!(
            key_dir("linux", home_only).unwrap(),
            root.join("home/.config/heavenkey")
        );
    }
}
