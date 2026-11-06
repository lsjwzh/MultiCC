use super::{fail, Error};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub grant: String,
    pub grant_id: String,
    pub added_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub digest: String,
    pub created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u8,
    pub id: String,
    pub name: String,
    pub peers: Vec<Peer>,
    pub grants: Vec<Grant>,
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn random(prefix: &str) -> Result<String, Error> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| fail(503, "machine_entropy_unavailable", "无法生成电脑授权"))?;
    Ok(format!(
        "{prefix}{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

pub fn digest(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}

pub fn constant_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub fn valid_id(value: &str) -> bool {
    value.len() >= 8
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn name(value: &str) -> Result<String, Error> {
    let clean = value.trim();
    if clean.is_empty() || clean.chars().count() > 50 || clean.chars().any(char::is_control) {
        return Err(fail(
            400,
            "machine_name_invalid",
            "电脑名称须为一至五十个字符",
        ));
    }
    Ok(clean.to_owned())
}

fn io_error(_: impl std::fmt::Display) -> Error {
    fail(503, "machine_store_unavailable", "电脑连接存储暂时不可用")
}

fn private_file(path: &Path) -> Result<File, Error> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(io_error("symlink"));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(io_error)?;
    }
    Ok(file)
}

pub struct Locked {
    _lock: File,
    path: PathBuf,
    pub registry: Registry,
}

impl Locked {
    pub fn open(root: &str) -> Result<Self, Error> {
        let root = Path::new(root);
        if !root.is_absolute() || !root.is_dir() {
            return Err(io_error("root"));
        }
        let lock = private_file(&root.join("machines.lock"))?;
        lock.lock_exclusive().map_err(io_error)?;
        let path = root.join("machines.json");
        let registry = if path.exists() {
            let mut raw = String::new();
            private_file(&path)?
                .take(256 * 1024)
                .read_to_string(&mut raw)
                .map_err(io_error)?;
            let registry: Registry = crate::json_lenient::from_str(&raw).map_err(io_error)?;
            if registry.version != 1 || !valid_id(&registry.id) {
                return Err(io_error("version"));
            }
            registry
        } else {
            Registry {
                version: 1,
                id: random("machine_")?,
                name: "当前电脑".into(),
                peers: Vec::new(),
                grants: Vec::new(),
            }
        };
        Ok(Self {
            _lock: lock,
            path,
            registry,
        })
    }

    pub fn save(&self) -> Result<(), Error> {
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", random("write_")?));
        let bytes = serde_json::to_vec(&self.registry).map_err(io_error)?;
        let result = (|| {
            let mut file = private_file(&temporary)?;
            file.write_all(&bytes).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            fs::rename(&temporary, &self.path).map_err(io_error)?;
            #[cfg(unix)]
            File::open(self.path.parent().unwrap())
                .and_then(|dir| dir.sync_all())
                .map_err(io_error)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}
