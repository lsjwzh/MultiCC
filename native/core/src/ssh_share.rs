//! Host-side "borrowed SSH key" shares for remote `agy` accounts.
//!
//! A client that wants the real Mutagen sync (the relay transport is locked to
//! `remote_mcp`) has to reach the host over SSH. Rather than asking the owner to
//! hand over their own key, the host mints a dedicated ed25519 keypair per
//! share: the public half is appended to `~/.ssh/authorized_keys` behind a
//! `restrict` option, and the private half travels inside the share code.
//!
//! Anyone holding the code can log in as this host user, so the key is
//! single-purpose, option-restricted and revocable — revoking deletes exactly
//! the line we appended, identified by its `multicc-relay:<shareId>` tag.

use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;
use ring::signature::KeyPair;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agy_remote::{FILE_MODE_MUTAGEN, FILE_MODE_REMOTE_MCP};
use crate::state_file;

/// Comment appended to the public key, so revocation can find our own lines.
pub const TAG_PREFIX: &str = "multicc-relay:";

const STORE_FILE: &str = "agy-ssh-shares.json";
const KEYS_DIR: &str = "ssh-keys";

pub struct SshKeyPair {
    pub private_key: String,
    pub public_key: String,
    pub fingerprint: String,
}

fn put_str(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| "无法获取随机数，密钥生成中止".to_string())?;
    Ok(bytes)
}

fn random_share_id() -> Result<String, String> {
    let bytes = random_bytes::<8>()?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Serialise an ed25519 keypair the way `ssh-keygen -t ed25519` would: an
/// unencrypted `openssh-key-v1` container, base64 wrapped at 70 columns.
pub fn generate_key_pair(comment: &str) -> Result<SshKeyPair, String> {
    let seed = random_bytes::<32>()?;
    let key_pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&seed)
        .map_err(|err| format!("生成 ed25519 密钥失败: {err}"))?;
    let public = key_pair.public_key().as_ref();

    let mut blob = Vec::new();
    put_str(&mut blob, b"ssh-ed25519");
    put_str(&mut blob, public);
    let public_key = format!("ssh-ed25519 {}", STANDARD.encode(&blob));
    let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&blob)));

    let check = random_bytes::<4>()?;
    let mut private = Vec::new();
    private.extend_from_slice(&check);
    private.extend_from_slice(&check);
    put_str(&mut private, b"ssh-ed25519");
    put_str(&mut private, public);
    let mut secret = Vec::with_capacity(64);
    secret.extend_from_slice(&seed);
    secret.extend_from_slice(public);
    put_str(&mut private, &secret);
    put_str(&mut private, comment.as_bytes());
    let mut pad = 1u8;
    while private.len() % 8 != 0 {
        private.push(pad);
        pad = pad.wrapping_add(1);
    }

    let mut file = Vec::new();
    file.extend_from_slice(b"openssh-key-v1\0");
    put_str(&mut file, b"none");
    put_str(&mut file, b"none");
    put_str(&mut file, b"");
    file.extend_from_slice(&1u32.to_be_bytes());
    put_str(&mut file, &blob);
    put_str(&mut file, &private);

    let encoded = STANDARD.encode(&file);
    let mut pem = String::from("-----BEGIN OPENSSH PRIVATE KEY-----\n");
    for chunk in encoded.as_bytes().chunks(70) {
        pem.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        pem.push('\n');
    }
    pem.push_str("-----END OPENSSH PRIVATE KEY-----\n");

    Ok(SshKeyPair {
        private_key: pem,
        public_key,
        fingerprint,
    })
}

/// `restrict` keeps the borrowed key to a plain session: no port forwarding, no
/// agent forwarding, no pty, no X11. Mutagen only needs `sh`, so this holds.
/// `from=` is optional because the client's egress address is usually unknown.
pub fn authorized_keys_line(public_key: &str, tag: &str, restrict_from: Option<&str>) -> String {
    match restrict_from.map(str::trim).filter(|s| !s.is_empty()) {
        Some(from) => format!("restrict,from=\"{from}\" {public_key} {tag}"),
        None => format!("restrict {public_key} {tag}"),
    }
}

fn last_token(line: &str) -> Option<&str> {
    line.split_whitespace().next_back()
}

fn authorized_keys_path(home: &Path) -> PathBuf {
    home.join(".ssh").join("authorized_keys")
}

fn read_authorized_keys(path: &Path) -> Result<String, String> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| {
            "authorized_keys 不是有效的 UTF-8 文本，已中止以免破坏现有配置".to_string()
        }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!("读取 authorized_keys 失败: {err}")),
    }
}

/// Append `line` unless a line carrying `tag` already exists. Every other line
/// is preserved verbatim, so an untouched file stays byte-identical.
pub fn install_authorized_key(home: &Path, line: &str, tag: &str) -> Result<PathBuf, String> {
    let path = authorized_keys_path(home);
    let existing = read_authorized_keys(&path)?;
    let mut parts: Vec<&str> = existing
        .split('\n')
        .map(|raw| raw.trim_end_matches('\r'))
        .filter(|raw| last_token(raw) != Some(tag))
        .collect();
    while parts.len() > 1 && parts.last().is_some_and(|part| part.is_empty()) {
        parts.pop();
    }
    parts.push(line);
    let text = format!("{}\n", parts.join("\n"));
    let dir = home.join(".ssh");
    if !dir.is_dir() {
        fs::create_dir_all(&dir).map_err(|err| format!("创建 ~/.ssh 失败: {err}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    state_file::write_text_atomic(&path, &text, 0o600, 0o700)
        .map_err(|err| format!("写入 authorized_keys 失败: {err}"))?;
    Ok(path)
}

/// Drop the line carrying `tag`. Returns whether anything was removed.
pub fn remove_authorized_key(home: &Path, tag: &str) -> Result<bool, String> {
    let path = authorized_keys_path(home);
    if !path.exists() {
        return Ok(false);
    }
    let existing = read_authorized_keys(&path)?;
    let mut removed = false;
    let mut parts: Vec<&str> = Vec::new();
    for raw in existing.split('\n') {
        let raw = raw.trim_end_matches('\r');
        if last_token(raw) == Some(tag) {
            removed = true;
            continue;
        }
        parts.push(raw);
    }
    if !removed {
        return Ok(false);
    }
    while parts.len() > 1 && parts.last().is_some_and(|part| part.is_empty()) {
        parts.pop();
    }
    let text = if parts.is_empty() || parts == [""] {
        String::new()
    } else {
        format!("{}\n", parts.join("\n"))
    };
    state_file::write_text_atomic(&path, &text, 0o600, 0o700)
        .map_err(|err| format!("更新 authorized_keys 失败: {err}"))?;
    Ok(true)
}

/// Persist a borrowed private key on the importing (client) machine at 0600 and
/// return the path to hand to `ssh -i`.
pub fn store_identity_key(home: &Path, account_id: &str, private_key: &str) -> Result<PathBuf, String> {
    let trimmed = private_key.trim();
    if !trimmed.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        return Err("借用的私钥格式不正确（应为 OpenSSH 私钥）".to_string());
    }
    let dir = home.join(".multicc").join(KEYS_DIR);
    if !dir.is_dir() {
        fs::create_dir_all(&dir).map_err(|err| format!("创建密钥目录失败: {err}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    let path = dir.join(format!("agy-{account_id}.key"));
    state_file::write_text_atomic(&path, &format!("{trimmed}\n"), 0o600, 0o700)
        .map_err(|err| format!("保存借用私钥失败: {err}"))?;
    Ok(path)
}

pub fn file_mode_or_default(value: Option<&str>) -> Result<&'static str, String> {
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some(FILE_MODE_MUTAGEN) => Ok(FILE_MODE_MUTAGEN),
        Some(FILE_MODE_REMOTE_MCP) => Ok(FILE_MODE_REMOTE_MCP),
        Some(_) => Err("fileMode 只能是 mutagen 或 remote_mcp".to_string()),
    }
}

fn validate_ssh_target(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("缺少 SSH 目标（形如 user@host）".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("SSH 目标不能以 - 开头".to_string());
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || c == '\n' || c == '\r' || c.is_whitespace())
    {
        return Err("SSH 目标包含非法字符".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_restrict_from(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if value
        .chars()
        .any(|c| c.is_control() || c == '"' || c == '\\' || c == '\n' || c == '\r')
    {
        return Err("来源地址包含非法字符".to_string());
    }
    Ok(Some(value.to_string()))
}

fn store_path(home: &Path) -> PathBuf {
    home.join(".multicc").join(STORE_FILE)
}

fn read_store(home: &Path) -> Result<Vec<Value>, String> {
    let Some(value) = crate::provider_store::read(&store_path(home))? else {
        return Ok(Vec::new());
    };
    Ok(value
        .get("shares")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn write_store(home: &Path, shares: Vec<Value>) -> Result<(), String> {
    let path = store_path(home);
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            fs::create_dir_all(parent).map_err(|err| format!("创建 .multicc 目录失败: {err}"))?;
        }
    }
    state_file::write_json_atomic(&path, &json!({ "v": 1, "shares": shares }))
        .map_err(|err| format!("保存 SSH 借用记录失败: {err}"))
}

/// Shares are listed per account; `None` returns every account's shares.
pub fn list_shares(home: &Path, account_id: Option<&str>) -> Result<Vec<Value>, String> {
    let mut shares = read_store(home)?;
    if let Some(account_id) = account_id {
        shares.retain(|share| share.get("accountId").and_then(Value::as_str) == Some(account_id));
    }
    Ok(shares)
}

pub struct ShareRequest<'a> {
    pub account_id: &'a str,
    pub account_label: &'a str,
    pub ssh_target: &'a str,
    pub ssh_port: Option<u16>,
    pub file_mode: Option<&'a str>,
    pub label: &'a str,
    pub models: &'a [String],
    pub install: bool,
    pub restrict_from: Option<&'a str>,
}

pub struct CreatedShare {
    pub share: Value,
    pub code: String,
    pub authorized_keys_line: String,
}

pub fn create_share(home: &Path, request: &ShareRequest<'_>) -> Result<CreatedShare, String> {
    let ssh_target = validate_ssh_target(request.ssh_target)?;
    let file_mode = file_mode_or_default(request.file_mode)?;
    let restrict_from = validate_restrict_from(request.restrict_from)?;
    let share_id = random_share_id()?;
    let tag = format!("{TAG_PREFIX}{share_id}");
    let key = generate_key_pair(&tag)?;
    let line = authorized_keys_line(&key.public_key, &tag, restrict_from.as_deref());
    if request.install {
        install_authorized_key(home, &line, &tag)?;
    }
    let label = {
        let trimmed = request.label.trim();
        if trimmed.is_empty() {
            "SSH 借用".to_string()
        } else {
            trimmed.chars().take(64).collect()
        }
    };
    let share = json!({
        "id": share_id,
        "accountId": request.account_id,
        "accountLabel": request.account_label,
        "label": label,
        "sshTarget": ssh_target,
        "sshPort": request.ssh_port.unwrap_or(22),
        "fileMode": file_mode,
        "fingerprint": key.fingerprint,
        "publicKey": key.public_key,
        "tag": tag,
        "createdAt": crate::auth_runtime::now_ms().floor() as i64,
        "installed": request.install,
        "restrictFrom": restrict_from,
    });
    let mut shares = read_store(home)?;
    shares.push(share.clone());
    write_store(home, shares)?;
    let code = crate::provider_registry::encode_ssh_share_code(
        &format!("{} · SSH 借用", request.account_label),
        "agy",
        &ssh_target,
        request.ssh_port.unwrap_or(22),
        &key.private_key,
        file_mode,
        &share_id,
        request.models,
    );
    Ok(CreatedShare {
        share,
        code,
        authorized_keys_line: line,
    })
}

/// Revoke one share: remove its `authorized_keys` line, then forget the record.
pub fn revoke_share(home: &Path, share_id: &str) -> Result<bool, String> {
    let mut shares = read_store(home)?;
    let Some(index) = shares
        .iter()
        .position(|share| share.get("id").and_then(Value::as_str) == Some(share_id))
    else {
        return Ok(false);
    };
    let tag = shares[index]
        .get("tag")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{TAG_PREFIX}{share_id}"));
    remove_authorized_key(home, &tag)?;
    shares.remove(index);
    write_store(home, shares)?;
    Ok(true)
}

/// Deleting an account must not leave usable keys behind.
pub fn revoke_account_shares(home: &Path, account_id: &str) -> Result<usize, String> {
    let shares = read_store(home)?;
    let (mine, keep): (Vec<Value>, Vec<Value>) = shares
        .into_iter()
        .partition(|share| share.get("accountId").and_then(Value::as_str) == Some(account_id));
    if mine.is_empty() {
        return Ok(0);
    }
    for share in &mine {
        if let Some(tag) = share.get("tag").and_then(Value::as_str) {
            remove_authorized_key(home, tag)?;
        }
    }
    write_store(home, keep)?;
    Ok(mine.len())
}

/// Facts the share dialog needs before it promises anything: is sshd actually
/// listening, can we write `authorized_keys`, and what is already lent out.
pub fn preflight(home: &Path) -> Value {
    let path = authorized_keys_path(home);
    let writable = match path.metadata() {
        Ok(meta) => !meta.permissions().readonly(),
        Err(_) => home.is_dir(),
    };
    json!({
        "sshd": {
            "listening": sshd_listening(22),
            "port": 22,
        },
        "authorizedKeys": {
            "path": path.to_string_lossy(),
            "exists": path.exists(),
            "writable": writable,
        },
        "shares": list_shares(home, None).unwrap_or_default(),
    })
}

fn sshd_listening(port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::time::Duration;
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "multicc-ssh-share-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn generated_private_key_is_a_wrapped_openssh_pem() {
        let key = generate_key_pair("multicc-relay:abc").unwrap();
        assert!(key.private_key.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        assert!(key.private_key.ends_with("-----END OPENSSH PRIVATE KEY-----\n"));
        let body: String = key
            .private_key
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        let decoded = STANDARD.decode(&body).unwrap();
        assert!(decoded.starts_with(b"openssh-key-v1\0"));
        assert!(decoded.windows(16).any(|w| w == b"multicc-relay:ab"));
        assert!(key.public_key.starts_with("ssh-ed25519 "));
        assert!(key.fingerprint.starts_with("SHA256:"));
        assert!(!key.fingerprint.contains('='));
    }

    #[test]
    fn generated_keys_differ_per_call() {
        let first = generate_key_pair("a").unwrap();
        let second = generate_key_pair("a").unwrap();
        assert_ne!(first.public_key, second.public_key);
        assert_ne!(first.private_key, second.private_key);
    }

    #[test]
    fn authorized_keys_line_uses_restrict_and_optional_from() {
        let line = authorized_keys_line("ssh-ed25519 AAAA", "multicc-relay:1", None);
        assert_eq!(line, "restrict ssh-ed25519 AAAA multicc-relay:1");
        let line = authorized_keys_line("ssh-ed25519 AAAA", "multicc-relay:1", Some(" 1.2.3.4 "));
        assert_eq!(line, "restrict,from=\"1.2.3.4\" ssh-ed25519 AAAA multicc-relay:1");
    }

    #[test]
    fn install_is_idempotent_and_preserves_foreign_lines() {
        let home = temp_home("install");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::write(
            home.join(".ssh/authorized_keys"),
            "ssh-ed25519 EXISTING me@laptop\n",
        )
        .unwrap();
        let line = "restrict ssh-ed25519 AAAA multicc-relay:abc";
        install_authorized_key(&home, line, "multicc-relay:abc").unwrap();
        install_authorized_key(&home, line, "multicc-relay:abc").unwrap();
        let text = fs::read_to_string(home.join(".ssh/authorized_keys")).unwrap();
        assert_eq!(
            text,
            "ssh-ed25519 EXISTING me@laptop\nrestrict ssh-ed25519 AAAA multicc-relay:abc\n"
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn remove_deletes_only_the_tagged_line() {
        let home = temp_home("remove");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::write(
            home.join(".ssh/authorized_keys"),
            "ssh-ed25519 EXISTING me@laptop\nrestrict ssh-ed25519 AAAA multicc-relay:abc\n",
        )
        .unwrap();
        assert!(remove_authorized_key(&home, "multicc-relay:abc").unwrap());
        let text = fs::read_to_string(home.join(".ssh/authorized_keys")).unwrap();
        assert_eq!(text, "ssh-ed25519 EXISTING me@laptop\n");
        assert!(!remove_authorized_key(&home, "multicc-relay:abc").unwrap());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn removing_the_only_line_leaves_an_empty_file() {
        let home = temp_home("empty");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::write(
            home.join(".ssh/authorized_keys"),
            "restrict ssh-ed25519 AAAA multicc-relay:abc\n",
        )
        .unwrap();
        assert!(remove_authorized_key(&home, "multicc-relay:abc").unwrap());
        assert_eq!(fs::read_to_string(home.join(".ssh/authorized_keys")).unwrap(), "");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn create_share_records_and_revokes() {
        let home = temp_home("create");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        let request = ShareRequest {
            account_id: "0123456789abcdef",
            account_label: "本机反重力",
            ssh_target: "me@example.com",
            ssh_port: Some(2222),
            file_mode: Some("mutagen"),
            label: "",
            models: &[],
            install: true,
            restrict_from: None,
        };
        let created = create_share(&home, &request).unwrap();
        assert!(created.code.starts_with(crate::provider_registry::SSH_SHARE_CODE_PREFIX));
        assert_eq!(created.share["sshPort"], json!(2222));
        let listed = list_shares(&home, Some("0123456789abcdef")).unwrap();
        assert_eq!(listed.len(), 1);
        let keys = fs::read_to_string(home.join(".ssh/authorized_keys")).unwrap();
        assert!(keys.contains("restrict ssh-ed25519 "));
        let share_id = created.share["id"].as_str().unwrap().to_string();
        assert!(revoke_share(&home, &share_id).unwrap());
        assert_eq!(fs::read_to_string(home.join(".ssh/authorized_keys")).unwrap(), "");
        assert!(list_shares(&home, None).unwrap().is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn deleting_an_account_revokes_its_shares() {
        let home = temp_home("account");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        let request = ShareRequest {
            account_id: "aaaa",
            account_label: "A",
            ssh_target: "me@example.com",
            ssh_port: None,
            file_mode: None,
            label: "x",
            models: &[],
            install: true,
            restrict_from: None,
        };
        create_share(&home, &request).unwrap();
        assert_eq!(revoke_account_shares(&home, "aaaa").unwrap(), 1);
        assert!(list_shares(&home, None).unwrap().is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn store_identity_key_rejects_foreign_material() {
        let home = temp_home("identity");
        let err = store_identity_key(&home, "abc", "not a key").unwrap_err();
        assert!(err.contains("格式不正确"));
        let key = generate_key_pair("c").unwrap();
        let path = store_identity_key(&home, "abc", &key.private_key).unwrap();
        assert!(path.ends_with("agy-abc.key"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn ssh_target_and_from_validation_reject_injection() {
        assert!(validate_ssh_target("me@example.com").is_ok());
        assert!(validate_ssh_target("-oProxyCommand=sh").is_err());
        assert!(validate_ssh_target("me@host name").is_err());
        assert!(validate_ssh_target("me@host\nPermitRootLogin yes").is_err());
        assert!(validate_restrict_from(Some("1.2.3.4")).is_ok());
        assert!(validate_restrict_from(Some("1.2.3.4\",command=\"sh")).is_err());
    }

    /// Differential check against the real `ssh-keygen`: our key material must
    /// be readable by OpenSSH itself. Skipped when the binary is unavailable.
    #[test]
    fn generated_key_is_accepted_by_ssh_keygen() {
        let key = generate_key_pair("multicc-relay:diff").unwrap();
        let dir = temp_home("sshkeygen");
        let path = dir.join("id_ed25519");
        fs::write(&path, &key.private_key).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        let output = std::process::Command::new("ssh-keygen")
            .arg("-y")
            .arg("-f")
            .arg(&path)
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                // `ssh-keygen -y` echoes the comment we embedded; compare key material only.
                let derived = String::from_utf8_lossy(&output.stdout);
                let mut fields = derived.split_whitespace();
                let derived = format!(
                    "{} {}",
                    fields.next().unwrap_or_default(),
                    fields.next().unwrap_or_default()
                );
                assert_eq!(derived, key.public_key);
            }
        }
        let _ = fs::remove_dir_all(dir);
    }
}
