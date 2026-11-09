//! Workspace-sharing capabilities and external references. Legacy wire/data
//! names remain compatible; this does not restore the retired Fleet UI.
//! One Rust owner publishes only
//! persisted state. Live directory/session ports are migration-time inputs.
pub mod access;
mod authority;
pub mod control;
pub mod external;
pub mod remote;
pub mod source;
mod state;
pub mod transport;
use crate::js::{self, JsString, JsValue as V};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
pub use state::{Store, VerifiedAccess};
#[cfg(test)]
mod tests;
use subtle::ConstantTimeEq;

pub const SCHEMA_VERSION: f64 = 1.0;
pub const MAX_PASSWORD_BYTES: usize = 1024;
pub const MAX_REMOTE_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_PROXY_BODY_BYTES: usize = 10 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 10000;

#[derive(Clone, Debug)]
pub struct Error {
    pub code: String,
    pub message: JsString,
    pub status: u16,
    pub metadata: V,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(code: &str, message: &str, status: u16) -> Self {
        Self {
            code: code.into(),
            message: JsString::from_rust_str(message),
            status,
            metadata: V::Object(vec![]),
        }
    }
    pub fn meta(mut self, metadata: V) -> Self {
        self.metadata = metadata;
        self
    }
    pub fn value(&self) -> V {
        V::object(vec![
            ("code", V::string(&self.code)),
            ("message", V::String(self.message.clone())),
            ("status", V::Number(self.status.into())),
            ("metadata", self.metadata.clone()),
        ])
    }
}
pub fn reply(result: Result<V>) -> String {
    js::json_stringify(&match result {
        Ok(v) => V::object(vec![("ok", true.into()), ("value", v)]),
        Err(e) => V::object(vec![("ok", false.into()), ("error", e.value())]),
    })
    .unwrap()
}
pub fn get<'a>(v: &'a V, key: &str) -> &'a V {
    v.get(key).unwrap_or(&V::Undefined)
}
pub fn truth(v: &V) -> bool {
    js::truthy(v)
}
pub fn number(v: &V) -> f64 {
    js::js_to_number(v)
}
pub fn text(v: &V) -> String {
    js::js_to_string(v).to_string_lossy()
}
pub fn or_text(v: &V) -> String {
    if truth(v) {
        text(v)
    } else {
        String::new()
    }
}
pub fn put(v: &mut V, key: &str, item: V) {
    put_key(v, JsString::from_rust_str(key), item);
}
pub(super) fn put_key(v: &mut V, key: JsString, item: V) {
    let V::Object(fields) = v else {
        unreachable!("workspace-sharing object")
    };
    if let Some((_, old)) = fields.iter_mut().find(|(k, _)| k == &key) {
        *old = item;
    } else {
        fields.push((key, item));
    }
}
pub fn object(v: &V) -> V {
    if matches!(v, V::Object(_)) {
        v.clone()
    } else {
        V::Object(vec![])
    }
}
pub fn array(v: &V) -> &[V] {
    if let V::Array(a) = v {
        a
    } else {
        &[]
    }
}
pub fn values(v: &V) -> Vec<&V> {
    if let V::Object(a) = v {
        a.iter().map(|(_, v)| v).collect()
    } else {
        vec![]
    }
}
pub fn clean(v: &V, max: usize, fallback: &str) -> V {
    let V::String(raw) = v else {
        return V::string(fallback);
    };
    let mut output = Vec::new();
    let mut space = false;
    for unit in raw.as_units() {
        if *unit < 32 || *unit == 127 || js::string::is_js_whitespace(*unit) {
            space = true;
        } else {
            if space && !output.is_empty() {
                output.push(32);
            }
            space = false;
            output.push(*unit);
        }
    }
    if output.is_empty() {
        V::string(fallback)
    } else {
        output.truncate(max);
        V::String(JsString::from_units(output))
    }
}
pub fn clean_string(v: &V, max: usize, fallback: &str) -> String {
    text(&clean(v, max, fallback))
}
pub fn token_valid(value: &V) -> bool {
    let s = or_text(value);
    s.strip_prefix("fleet_share_")
        .is_some_and(|v| (24..=96).contains(&v.len()) && v.bytes().all(url_byte))
}
pub fn grant_valid(value: &V) -> bool {
    let s = or_text(value);
    (43..=128).contains(&s.len()) && s.bytes().all(url_byte)
}
fn url_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}
pub fn random(bytes: usize) -> Result<String> {
    let mut out = vec![0; bytes];
    getrandom::fill(&mut out)
        .map_err(|_| Error::new("FLEET_ENTROPY_FAILED", "Fleet entropy unavailable", 500))?;
    Ok(URL_SAFE_NO_PAD.encode(out))
}
pub fn password(value: &V) -> Result<String> {
    let s = if let V::String(v) = value {
        v.to_string_lossy()
    } else {
        String::new()
    };
    if s.len() < 6 {
        return Err(Error::new("INVALID_PASSWORD", "密码必须至少 6 位", 400));
    }
    if s.len() > MAX_PASSWORD_BYTES {
        return Err(Error::new("INVALID_PASSWORD", "密码过长", 400));
    }
    Ok(s)
}
pub fn hash(password: &str, salt: &str) -> Result<String> {
    let mut bytes = [0; 32];
    let params = scrypt::Params::new(14, 8, 1, 32).unwrap();
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut bytes)
        .map_err(|_| Error::new("FLEET_HASH_FAILED", "Fleet hash failed", 500))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn secret_matches(left: &V, right: &V) -> bool {
    let (V::String(a), V::String(b)) = (left, right) else {
        return false;
    };
    !a.is_empty()
        && !b.is_empty()
        && bool::from(
            Sha256::digest(a.to_string_lossy().as_bytes())
                .ct_eq(&Sha256::digest(b.to_string_lossy().as_bytes())),
        )
}
pub fn password_matches(candidate: &str, record: &V) -> bool {
    let V::String(salt) = get(record, "salt") else {
        return false;
    };
    let Ok(candidate) = hash(candidate, &salt.to_string_lossy()) else {
        return false;
    };
    let raw = or_text(get(record, "passwordHash"));
    let expected: Vec<u8> = raw
        .as_bytes()
        .chunks_exact(2)
        .map_while(|p| {
            Some(((p[0] as char).to_digit(16)? * 16 + (p[1] as char).to_digit(16)?) as u8)
        })
        .collect();
    let actual: Vec<u8> = candidate
        .as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect();
    expected.len() == 32 && bool::from(actual.ct_eq(&expected))
}
pub fn positive(value: &V, min: f64, max: f64, fallback: f64, label: &str) -> Result<f64> {
    let n = if value.is_nullish() || value == &V::string("") {
        fallback
    } else {
        number(value)
    };
    if !n.is_finite() || n.fract() != 0.0 || n < min || n > max {
        return Err(Error::new(
            "INVALID_SHARE_OPTIONS",
            &format!("{label}必须是 {min}-{max} 的整数"),
            400,
        ));
    }
    Ok(n)
}
pub fn sessions(input: &V, source: bool) -> V {
    V::Array(
        array(input)
            .iter()
            .take(500)
            .map(|s| {
                let id = get(s, "id");
                let label = get(s, "label");
                let cli = get(s, "cli");
                let label = if source && !truth(label) { id } else { label };
                let allowed = [
                    "claude",
                    "claude-exp",
                    "codex",
                    "codex-exp",
                    "opencode",
                    "zcode",
                    "qoder",
                    "kimi",
                    "codebuddy",
                    "dsh",
                    "gemini",
                    "grok",
                    "commandcode",
                    "pi",
                ];
                let created = if source {
                    V::string(&or_text(get(s, "createdAt")))
                } else {
                    get(s, "createdAt").clone()
                };
                let mut r = V::object(vec![
                    ("id", clean(id, 180, "")),
                    ("label", clean(label, 120, "未命名会话")),
                    (
                        "cli",
                        if allowed.iter().any(|v| cli == &V::string(v)) {
                            cli.clone()
                        } else {
                            V::string("other")
                        },
                    ),
                    (
                        "kind",
                        V::string(if get(s, "kind") == &V::string("terminal") {
                            "terminal"
                        } else {
                            "chat"
                        }),
                    ),
                    (
                        "type",
                        V::string(if get(s, "type") == &V::string("commander") {
                            "commander"
                        } else {
                            "worker"
                        }),
                    ),
                ]);
                let created = clean(&created, 64, "");
                put(
                    &mut r,
                    "createdAt",
                    if truth(&created) { created } else { V::Null },
                );
                put(
                    &mut r,
                    "active",
                    V::Bool(get(s, "active") == &V::Bool(true)),
                );
                for (key, value, max) in [
                    ("model", get(s, "model"), 120),
                    ("effectiveModel", get(s, "effectiveModel"), 120),
                    ("provider", get(s, "provider"), 180),
                ] {
                    let v = clean(value, max, "");
                    put(&mut r, key, if truth(&v) { v } else { V::Null });
                }
                r
            })
            .filter(|v| truth(get(v, "id")))
            .collect(),
    )
}
pub fn validate_payload(value: &V) -> Result<V> {
    let fleet = get(value, "fleet");
    if get(value, "schemaVersion") != &V::Number(SCHEMA_VERSION)
        || !matches!(get(value, "instanceId"), V::String(_))
        || !truth(fleet)
        || !matches!(fleet, V::Object(_) | V::Array(_))
    {
        return Err(Error::new(
            "INVALID_REMOTE_RESPONSE",
            "远端返回了不兼容的工作区数据",
            502,
        ));
    }
    let instance = clean(get(value, "instanceId"), 128, "");
    let id = clean(get(fleet, "id"), 128, "");
    let name = clean(get(fleet, "name"), 120, "");
    if !truth(&instance) || !truth(&id) || !truth(&name) {
        return Err(Error::new(
            "INVALID_REMOTE_RESPONSE",
            "远端工作区数据不完整",
            502,
        ));
    }
    let capability = get(value, "capability");
    let token = clean(get(capability, "token"), 160, "");
    let grant = clean(get(capability, "grant"), 180, "");
    if !token_valid(&token) || !grant_valid(&grant) {
        return Err(Error::new(
            "INVALID_REMOTE_RESPONSE",
            "远端工作区未提供可操作授权",
            502,
        ));
    }
    let sessions = sessions(get(fleet, "sessions"), false);
    let count = array(&sessions).len();
    Ok(V::object(vec![
        ("sourceInstanceId", instance),
        ("sourceFleetId", id),
        ("remoteName", name),
        ("description", clean(get(fleet, "description"), 500, "")),
        ("sessions", sessions),
        ("sessionCount", V::Number(count as f64)),
        ("remoteToken", token),
        ("remoteGrant", grant),
    ]))
}
