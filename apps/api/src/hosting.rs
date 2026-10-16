use std::{fs, io::Read, path::Path};
use webauthn_rs::prelude::Url;

pub struct Hosting {
    pub origin: String,
    pub host: String,
    pub rp_id: String,
}

impl Hosting {
    pub fn new(port: u16, public: Option<&str>) -> Result<Self, Box<dyn std::error::Error>> {
        let Some(public) = public else {
            return Ok(Self {
                origin: format!("http://localhost:{port}"),
                host: format!("localhost:{port}"),
                rp_id: "localhost".into(),
            });
        };
        let url = Url::parse(public)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || url.domain().is_none()
        {
            return Err("HEAVENKEY_PUBLIC_ORIGIN must be an HTTPS domain origin without a path, credentials, query or fragment".into());
        }
        let rp_id = url.host_str().ok_or("missing HTTPS domain")?.to_string();
        if rp_id == "localhost" || !rp_id.contains('.') {
            return Err("public HTTPS origin requires a DNS domain".into());
        }
        let origin = url.origin().ascii_serialization();
        let host = origin
            .strip_prefix("https://")
            .ok_or("invalid origin")?
            .to_string();
        Ok(Self {
            origin,
            host,
            rp_id,
        })
    }
}

pub fn document(path: Option<&Path>, public: bool) -> Result<String, Box<dyn std::error::Error>> {
    let Some(path) = path else {
        if public {
            return Err("HTTPS hosting requires HEAVENKEY_DOCUMENT, a private UTF-8 file outside the web root".into());
        }
        return Ok("HeavenKey example document — verified access".into());
    };
    let mut text = String::new();
    fs::File::open(path)?
        .take(65537)
        .read_to_string(&mut text)?;
    if text.is_empty() || text.len() > 65536 {
        return Err("protected document must contain 1 to 65536 UTF-8 bytes".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_default_is_preserved() {
        let config = Hosting::new(18240, None).unwrap();
        assert_eq!(config.origin, "http://localhost:18240");
        assert_eq!(config.host, "localhost:18240");
        assert_eq!(config.rp_id, "localhost");
    }

    #[test]
    fn public_origin_binds_host_and_rp_exactly() {
        let config = Hosting::new(18240, Some("https://heaven.example:8443/")).unwrap();
        assert_eq!(config.origin, "https://heaven.example:8443");
        assert_eq!(config.host, "heaven.example:8443");
        assert_eq!(config.rp_id, "heaven.example");
    }

    #[test]
    fn insecure_or_ambiguous_public_origins_are_rejected() {
        for origin in [
            "http://heaven.example",
            "https://127.0.0.1",
            "https://localhost",
            "https://heaven.example/document",
            "https://user@heaven.example",
            "https://heaven.example?x=1",
            "https://heaven.example#x",
        ] {
            assert!(Hosting::new(18240, Some(origin)).is_err(), "{origin}");
        }
    }

    #[test]
    fn public_mode_requires_private_document() {
        assert!(document(None, true).is_err());
        assert!(document(None, false).is_ok());
    }
}
