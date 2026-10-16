use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

pub struct Options {
    pub port: u16,
    pub data: PathBuf,
    pub open: bool,
    pub store_query: Option<String>,
    pub password_manager: bool,
}

fn default_data(
    os: &str,
    lookup: impl Fn(&str) -> Option<OsString>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let nonempty = |name: &str| lookup(name).filter(|value| !value.is_empty());
    let base = match os {
        "windows" => PathBuf::from(nonempty("LOCALAPPDATA").ok_or("LOCALAPPDATA is missing")?),
        "macos" => PathBuf::from(nonempty("HOME").ok_or("HOME is missing")?)
            .join("Library/Application Support"),
        _ => match nonempty("XDG_DATA_HOME") {
            Some(path) => {
                let path = PathBuf::from(path);
                if !path.is_absolute() {
                    return Err("XDG_DATA_HOME must be absolute".into());
                }
                path
            }
            None => PathBuf::from(nonempty("HOME").ok_or("HOME is missing")?).join(".local/share"),
        },
    };
    if !base.is_absolute() {
        return Err("The user data directory must be absolute".into());
    }
    Ok(base.join("HeavenKey"))
}

pub fn options() -> Result<Option<Options>, Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let mut port = env::var("UAC_PORT").unwrap_or_else(|_| "18240".into());
    let mut data = env::var_os("UAC_DATA").filter(|value| !value.is_empty());
    let mut open = false;
    let mut store_query = None;
    let mut password_manager = env::var("HEAVENKEY_PASSWORD_MANAGER").is_ok_and(|v| v == "1");
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--version") => {
                println!("HeavenKey {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            Some("--help" | "-h") => {
                println!(
                    "HeavenKey {}\n\n--password-manager Local offline password vault (no account)\n--open             Open the browser\n--port NUMBER      Loopback port (default 18240)\n--data-dir PATH    Persistent data directory\n--store-query JSON Run one local maintenance query, then exit\n--version          Version\n\nUAC_PORT, UAC_DATA, UAC_STORE_KEY and UAC_STORE_KEY_FILE are supported.\nHEAVENKEY_PUBLIC_ORIGIN: exact HTTPS origin behind a trusted TLS proxy.\nHEAVENKEY_DOCUMENT: private UTF-8 document (required for HTTPS).\nThe listener stays on loopback. Stop with Ctrl+C.",
                    env!("CARGO_PKG_VERSION")
                );
                return Ok(None);
            }
            Some("--open") => open = true,
            Some("--password-manager") => password_manager = true,
            Some("--port") => {
                port = args
                    .next()
                    .ok_or("--port requires a number")?
                    .into_string()
                    .map_err(|_| "invalid port")?
            }
            Some("--data-dir") => {
                data = Some(
                    args.next()
                        .filter(|value| !value.is_empty())
                        .ok_or("--data-dir requires a path")?,
                )
            }
            Some("--store-query") => {
                store_query = Some(
                    args.next()
                        .filter(|value| !value.is_empty())
                        .ok_or("--store-query requires a JSON argument")?
                        .into_string()
                        .map_err(|_| "--store-query requires UTF-8 JSON")?,
                )
            }
            _ => {
                return Err(
                    format!("Unknown option: {}. Use --help.", arg.to_string_lossy()).into(),
                );
            }
        }
    }
    let port = port.parse()?;
    if port == 0 {
        return Err("Port 0 is not supported; choose a fixed localhost port".into());
    }
    let data = match data {
        Some(path) => PathBuf::from(path),
        None => default_data(env::consts::OS, |name| env::var_os(name))?,
    };
    Ok(Some(Options {
        port,
        data,
        open,
        store_query,
        password_manager,
    }))
}

pub fn prepare_data(data: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(data, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn open_browser(origin: &str) {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c", "start", "", origin]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(origin);
        command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(origin);
        command
    };
    let result = (|| -> std::io::Result<()> {
        let mut child = command.spawn()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait()? {
                if status.success() {
                    return Ok(());
                }
                return Err(std::io::Error::other(format!("browser opener: {status}")));
            }
            if Instant::now() >= deadline {
                child.kill()?;
                child.wait()?;
                return Err(std::io::Error::other("browser opener timeout"));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    })();
    if let Err(error) = result {
        eprintln!("Browser: {error}. Open {origin} manually.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_data_paths() {
        let root = env::temp_dir().join("heavenkey-config-test");
        let lookup = |name: &str| match name {
            "HOME" => Some(root.join("home").into_os_string()),
            "LOCALAPPDATA" => Some(root.join("AppData/Local").into_os_string()),
            _ => None,
        };
        assert_eq!(
            default_data("macos", lookup).unwrap(),
            root.join("home/Library/Application Support/HeavenKey")
        );
        assert_eq!(
            default_data("linux", lookup).unwrap(),
            root.join("home/.local/share/HeavenKey")
        );
        assert_eq!(
            default_data("windows", lookup).unwrap(),
            root.join("AppData/Local/HeavenKey")
        );
    }

    #[test]
    fn missing_or_relative_data_root_fails() {
        assert!(default_data("windows", |_| None).is_err());
        assert!(default_data("macos", |_| None).is_err());
        assert!(default_data("linux", |_| Some(OsString::from("relative"))).is_err());
    }

    #[test]
    fn xdg_data_home_overrides_home() {
        let root = env::temp_dir().join("heavenkey-xdg-test");
        assert_eq!(
            default_data("linux", |_| Some(root.clone().into_os_string())).unwrap(),
            root.join("HeavenKey")
        );
    }
}
