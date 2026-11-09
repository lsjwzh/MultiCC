//! Provider-scoped relay authority. Records, secrets, usage accounting and
//! sealing-key cache have one Rust owner; callers must await the durable write
//! before accepting a request. This module is also usable without N-API.
use crate::js::{self, JsString, JsValue as V};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use subtle::ConstantTimeEq;
use url::Url;

fn get<'a>(value: &'a V, key: &str) -> &'a V {
    value.get(key).unwrap_or(&V::Undefined)
}
fn clean(value: &V) -> JsString {
    if value.is_nullish() {
        JsString::new()
    } else {
        js::js_to_string(value).trim()
    }
}
fn text(value: &V) -> String {
    clean(value).to_string_lossy()
}
fn put(value: &mut V, key: &str, item: V) {
    let V::Object(fields) = value else {
        unreachable!("record object")
    };
    if let Some((_, value)) = fields.iter_mut().find(|(k, _)| k == key) {
        *value = item;
    } else {
        fields.push((key.into(), item));
    }
}
fn copy_object(value: V) -> V {
    match value {
        V::Object(_) => value,
        V::Array(values) => V::Object(
            values
                .into_iter()
                .enumerate()
                .map(|(i, v)| (i.to_string().into(), v))
                .collect(),
        ),
        V::String(s) => V::Object(
            s.as_units()
                .iter()
                .enumerate()
                .map(|(i, u)| {
                    (
                        i.to_string().into(),
                        V::String(JsString::from_units(vec![*u])),
                    )
                })
                .collect(),
        ),
        _ => V::Object(vec![]),
    }
}
fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| "RELAY_ENTROPY_FAILED: relay entropy unavailable")?;
    Ok(bytes)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
// Buffer.from(hex, 'hex') stops at the first invalid or incomplete pair.
fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks_exact(2)
        .map_while(|p| {
            Some(((p[0] as char).to_digit(16)? * 16 + (p[1] as char).to_digit(16)?) as u8)
        })
        .collect()
}
fn hash(secret: &str, salt: &str) -> Result<[u8; 32], String> {
    let mut output = [0; 32];
    let params = scrypt::Params::new(14, 8, 1, 32).map_err(|_| "RELAY_HASH_FAILED")?;
    scrypt::scrypt(secret.as_bytes(), salt.as_bytes(), &params, &mut output)
        .map_err(|_| "RELAY_HASH_FAILED")?;
    Ok(output)
}
fn secret(value: &V) -> Result<String, String> {
    let value = text(value);
    if !(8..=128).contains(&value.len()) || !value.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("RELAY_TOKEN_INVALID: relay token must be 8-128 printable ASCII characters without spaces".into());
    }
    Ok(value)
}
pub fn parse_credential(value: &V) -> Option<(String, String)> {
    let value = text(value);
    let value = value.strip_prefix("mcr1.")?;
    let (id, raw) = value.split_once('.')?;
    if id.len() != 16
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    Some((id.into(), secret(&V::string(raw)).ok()?))
}
fn decode(value: &str) -> Option<String> {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let h = (*bytes.get(i + 1)? as char).to_digit(16)?;
            let l = (*bytes.get(i + 2)? as char).to_digit(16)?;
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
fn target(url: &Url) -> Option<(&'static str, String)> {
    let parts: Vec<_> = url
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .map(decode)
        .collect::<Option<_>>()?;
    let id = parts.get(1).filter(|v| !v.is_empty())?.clone();
    match parts.first()?.as_str() {
        "claude-proxy" if parts.get(2).map(String::as_str) == Some("remote") => {
            Some(("claude", id))
        }
        "codex-proxy" => Some(("codex", id)),
        _ => None,
    }
}
pub fn route_target(value: &V) -> Option<V> {
    let parsed = Url::parse("http://multicc.local")
        .unwrap()
        .join(&text(value))
        .ok()?;
    let (kind, id) = target(&parsed)?;
    Some(V::object(vec![
        ("appType", V::string(kind)),
        ("providerId", V::string(&id)),
    ]))
}
pub fn relay_route(value: &V) -> Option<V> {
    let parsed = Url::parse(&text(value)).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || matches!(
            parsed.host_str().unwrap_or(""),
            "localhost" | "127.0.0.1" | "::1" | "[::1]"
        )
    {
        return None;
    }
    let (kind, id) = target(&parsed)?;
    let prefix = if kind == "claude" {
        "claude-proxy"
    } else {
        "codex-proxy"
    };
    let tail = if kind == "claude" { "/remote" } else { "" };
    let endpoint = format!(
        "{}/{prefix}/{}{tail}",
        parsed.origin().ascii_serialization(),
        crate::http_gate::encode_uri_component(&id)
    );
    Some(V::object(vec![
        ("appType", V::string(kind)),
        ("providerId", V::string(&id)),
        ("url", V::string(&endpoint)),
    ]))
}
fn public(record: &V) -> V {
    let mut fields = Vec::new();
    for key in [
        "id",
        "appType",
        "providerId",
        "providerName",
        "label",
        "publicBaseUrl",
        "relayBaseUrl",
        "tokenFingerprint",
    ] {
        fields.push((key, get(record, key).clone()));
    }
    let revoked = js::truthy(get(record, "revokedAt"));
    fields.push((
        "status",
        V::string(if revoked { "revoked" } else { "active" }),
    ));
    fields.push((
        "recoverable",
        V::Bool(!revoked && js::truthy(get(record, "credentialSealed"))),
    ));
    for key in ["createdAt", "revokedAt", "accessCount", "lastUsedAt"] {
        fields.push((key, get(record, key).clone()));
    }
    V::object(fields)
}
fn denied(code: &str) -> V {
    V::object(vec![("ok", V::Bool(false)), ("code", V::string(code))])
}

pub struct Store {
    file: PathBuf,
    key_file: PathBuf,
    records: Vec<V>,
    seal_key: Option<[u8; 32]>,
}
impl Store {
    pub fn open(file: PathBuf, key_file: Option<PathBuf>) -> Result<Self, String> {
        let value = crate::durable_state::load_or_recover(&file)?.unwrap_or(V::Array(vec![]));
        let V::Array(records) = value else {
            return Err(
                "RELAY_STORE_INVALID: provider relay share store data must be an array".into(),
            );
        };
        let key_file = key_file.unwrap_or_else(|| {
            let mut name = file.as_os_str().to_os_string();
            name.push(".key");
            name.into()
        });
        Ok(Self {
            file,
            key_file,
            records: records.into_iter().map(copy_object).collect(),
            seal_key: None,
        })
    }
    fn commit(&mut self, next: Vec<V>) -> Result<(), String> {
        crate::durable_state::save(&self.file, "provider-relay-shares", &V::Array(next.clone()))?;
        self.records = next;
        Ok(())
    }
    fn key(&mut self, create: bool) -> Option<[u8; 32]> {
        if let Some(key) = self.seal_key {
            return Some(key);
        }
        if let Ok(value) = fs::read_to_string(&self.key_file) {
            let value = js::string::js_trim(&value);
            if value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                let key: [u8; 32] = unhex(value).try_into().ok()?;
                self.seal_key = Some(key);
                return Some(key);
            }
        }
        if !create {
            return None;
        }
        let key = random::<32>().ok()?;
        crate::state_file::write_text_atomic(&self.key_file, &hex(&key), 0o600, 0o700).ok()?;
        self.seal_key = Some(key);
        Some(key)
    }
    fn seal(&mut self, credential: &str, id: &str) -> Result<V, String> {
        let Some(key) = self.key(true) else {
            return Ok(V::Null);
        };
        let iv = random::<12>()?;
        let encrypted = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: credential.as_bytes(),
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| "RELAY_SEAL_FAILED")?;
        let split = encrypted.len() - 16;
        Ok(V::object(vec![
            ("v", V::Number(1.0)),
            ("iv", V::string(&STANDARD.encode(iv))),
            ("tag", V::string(&STANDARD.encode(&encrypted[split..]))),
            ("data", V::string(&STANDARD.encode(&encrypted[..split]))),
        ]))
    }
    fn unseal(&mut self, sealed: &V, id: &str) -> Option<String> {
        let key = self.key(false)?;
        if get(sealed, "v") != &V::Number(1.0) {
            return None;
        }
        let V::String(iv_text) = get(sealed, "iv") else {
            return None;
        };
        let iv = js::node_base64_decode(iv_text);
        if iv.len() != 12 {
            return None;
        }
        let V::String(data_text) = get(sealed, "data") else {
            return None;
        };
        let mut data = js::node_base64_decode(data_text);
        let V::String(tag_text) = get(sealed, "tag") else {
            return None;
        };
        let tag = js::node_base64_decode(tag_text);
        if tag.len() != 16 {
            return None;
        }
        data.extend_from_slice(&tag);
        let result = Aes256Gcm::new_from_slice(&key)
            .ok()?
            .decrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: &data,
                    aad: id.as_bytes(),
                },
            )
            .ok()?;
        Some(String::from_utf8_lossy(&result).into_owned())
    }
    fn verify(record: &V, secret: &str) -> Result<bool, String> {
        let (V::String(salt), V::String(expected)) =
            (get(record, "tokenSalt"), get(record, "tokenHash"))
        else {
            return Err("RELAY_RECORD_INVALID: invalid relay hash fields".into());
        };
        let actual = hash(secret, &salt.to_string_lossy())?;
        let expected = unhex(&expected.to_string_lossy());
        Ok(expected.len() == 32 && bool::from(actual.as_slice().ct_eq(expected.as_slice())))
    }
    pub fn run(&mut self, operation: &str, input: &V, now: f64) -> Result<V, String> {
        match operation {
            "create" => self.create(input, now),
            "list" => {
                let app = clean(get(input, "appType"));
                let provider = clean(get(input, "providerId"));
                let mut records: Vec<_> = self
                    .records
                    .iter()
                    .filter(|r| {
                        (app.is_empty() || get(r, "appType") == &V::String(app.clone()))
                            && (provider.is_empty()
                                || get(r, "providerId") == &V::String(provider.clone()))
                    })
                    .collect();
                records.sort_by(|a, b| {
                    let order = js::js_to_number(get(b, "createdAt"))
                        - js::js_to_number(get(a, "createdAt"));
                    order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
                });
                Ok(V::Array(records.into_iter().map(public).collect()))
            }
            "getCredential" => {
                let id = clean(input);
                let Some(record) = self
                    .records
                    .iter()
                    .find(|r| get(r, "id") == &V::String(id.clone()))
                    .cloned()
                else {
                    return Ok(denied("not_found"));
                };
                if js::truthy(get(&record, "revokedAt")) {
                    return Ok(denied("revoked"));
                }
                let Some(credential) =
                    self.unseal(get(&record, "credentialSealed"), &id.to_string_lossy())
                else {
                    return Ok(denied("not_recoverable"));
                };
                let Some((parsed, secret)) = parse_credential(&V::string(&credential)) else {
                    return Ok(denied("not_recoverable"));
                };
                if id != parsed.as_str() || !Self::verify(&record, &secret)? {
                    return Ok(denied("not_recoverable"));
                }
                Ok(V::object(vec![
                    ("ok", V::Bool(true)),
                    ("credential", V::string(&credential)),
                    ("share", public(&record)),
                ]))
            }
            "authorize" => {
                let (Some((id, secret)), Some(target)) = (
                    parse_credential(get(input, "credential")),
                    route_target(get(input, "pathname")),
                ) else {
                    return Ok(denied("invalid_relay_credential"));
                };
                let Some(index) = self
                    .records
                    .iter()
                    .position(|r| get(r, "id") == &V::string(&id))
                else {
                    return Ok(denied("relay_share_inactive"));
                };
                let record = &self.records[index];
                if js::truthy(get(record, "revokedAt")) {
                    return Ok(denied("relay_share_inactive"));
                }
                if get(record, "appType") != get(&target, "appType")
                    || get(record, "providerId") != get(&target, "providerId")
                {
                    return Ok(denied("relay_share_scope_mismatch"));
                }
                if !Self::verify(record, &secret)? {
                    return Ok(denied("invalid_relay_credential"));
                }
                let count = js::js_to_number(get(record, "accessCount"));
                let count = if count.is_nan() { 0.0 } else { count.max(0.0) };
                let mut next = self.records.clone();
                put(&mut next[index], "accessCount", V::Number(count + 1.0));
                put(&mut next[index], "lastUsedAt", V::Number(now));
                self.commit(next)?;
                Ok(V::object(vec![
                    ("ok", V::Bool(true)),
                    ("code", V::Null),
                    ("shareId", V::string(&id)),
                ]))
            }
            "revoke" => {
                let id = V::String(clean(input));
                let Some(index) = self.records.iter().position(|r| get(r, "id") == &id) else {
                    return Ok(V::Null);
                };
                if js::truthy(get(&self.records[index], "revokedAt")) {
                    return Ok(public(&self.records[index]));
                }
                let mut next = self.records.clone();
                put(&mut next[index], "revokedAt", V::Number(now));
                self.commit(next)?;
                Ok(public(&self.records[index]))
            }
            "revokeProvider" => {
                let app = V::String(clean(get(input, "appType")));
                let id = V::String(clean(get(input, "providerId")));
                let mut next = self.records.clone();
                let mut count = 0;
                for r in &mut next {
                    if get(r, "appType") == &app
                        && get(r, "providerId") == &id
                        && !js::truthy(get(r, "revokedAt"))
                    {
                        count += 1;
                        put(r, "revokedAt", V::Number(now));
                    }
                }
                if count > 0 {
                    self.commit(next)?;
                }
                Ok(V::Number(count as f64))
            }
            _ => Err("RELAY_OPERATION_INVALID: unknown relay operation".into()),
        }
    }
    fn create(&mut self, input: &V, now: f64) -> Result<V, String> {
        let app = clean(get(input, "appType"));
        let provider = clean(get(input, "providerId"));
        let mut name = clean(get(input, "providerName"));
        if name.is_empty() {
            name = provider.clone();
        }
        let base = clean(get(input, "publicBaseUrl"));
        let relay = clean(get(input, "relayBaseUrl"));
        let secret = secret(get(input, "token"))?;
        if app != "claude" && app != "codex" {
            return Err("RELAY_TYPE_INVALID: relay share appType is invalid".into());
        }
        if provider.is_empty() || provider.len() > 256 {
            return Err("RELAY_PROVIDER_INVALID: relay share provider is invalid".into());
        }
        if base.is_empty() || relay.is_empty() {
            return Err("RELAY_URL_INVALID: relay share URL is invalid".into());
        }
        let mut id = None;
        for _ in 0..10 {
            let value = URL_SAFE_NO_PAD.encode(random::<12>()?);
            if !self
                .records
                .iter()
                .any(|r| get(r, "id") == &V::string(&value))
            {
                id = Some(value);
                break;
            }
        }
        let id = id.ok_or("RELAY_ID_FAILED: failed to allocate relay share id")?;
        let salt = hex(&random::<16>()?);
        let credential = format!("mcr1.{id}.{secret}");
        let label = clean(get(input, "label"));
        if label.len() > 100 || label.as_units().iter().any(|c| *c < 32 || *c == 127) {
            return Err("RELAY_LABEL_INVALID: relay share label is invalid".into());
        }
        let label = if label.is_empty() {
            V::Null
        } else {
            V::String(label)
        };
        let digest = hex(&hash(&secret, &salt)?);
        let fingerprint = hex(&Sha256::digest(credential.as_bytes()))[..12].to_string();
        let sealed = self.seal(&credential, &id)?;
        let record = V::object(vec![
            ("id", V::string(&id)),
            ("appType", V::String(app)),
            ("providerId", V::String(provider)),
            ("providerName", V::String(name)),
            ("label", label),
            ("publicBaseUrl", V::String(base)),
            ("relayBaseUrl", V::String(relay)),
            ("tokenSalt", V::string(&salt)),
            ("tokenHash", V::string(&digest)),
            ("tokenFingerprint", V::string(&fingerprint)),
            ("credentialSealed", sealed),
            ("createdAt", V::Number(now)),
            ("revokedAt", V::Null),
            ("accessCount", V::Number(0.0)),
            ("lastUsedAt", V::Null),
        ]);
        let share = public(&record);
        let mut next = self.records.clone();
        next.push(record);
        self.commit(next)?;
        Ok(V::object(vec![
            ("credential", V::string(&credential)),
            ("share", share),
        ]))
    }
}
