use super::*;
use multicc_core::provider_credentials;
use std::{fs, io, time::UNIX_EPOCH};

fn valid(s: &str) -> bool {
    s.len() == 16
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn account_id(v: L<'_>) -> Result<String> {
    let id = printed(fallback(v, "".into())?)?;
    if !valid(&id) {
        return lift(
            v,
            Err(homes::Error::new(
                "OFFICIAL_ACCOUNT_ID_INVALID",
                "invalid official account id",
            )),
        );
    }
    Ok(id)
}
fn default_root(o: L<'_>) -> Result<PathBuf> {
    let h = call(o.get(c"os")?, c"homedir", &[])?;
    resolve(o, &[h, text(o, ".multicc")?, text(o, "official-accounts")?])
}
fn account_file(base: &Path, kind: &str, id: &str) -> PathBuf {
    let root = base.join(if kind.starts_with("codex") {
        "codex"
    } else {
        "claude"
    });
    match kind {
        "codexDir" => root.join(id),
        "codexMeta" => root.join(id).join("account.json"),
        "codexAuthFile" => root.join(id).join("auth.json"),
        "claudeHomeDir" => root.join(format!("{id}.home")),
        _ => root.join(format!("{id}.json")),
    }
}
pub(crate) fn marker(provider: L<'_>) -> Result<L<'_>> {
    if provider.kind()? != sys::ValueType::napi_object || !provider.truthy()? {
        return null(provider);
    }
    let mut cfg = provider.get(c"settingsConfig")?;
    if cfg.kind()? == sys::ValueType::napi_string {
        let obj = provider.global()?.get(c"JSON")?;
        let Some(parsed) = provider.catch(|| call(obj, c"parse", &[cfg]))? else {
            return null(provider);
        };
        cfg = parsed
    }
    let val = cfg.optional(c"officialAccount")?;
    if val.kind()? != sys::ValueType::napi_object || !val.truthy()? {
        return null(provider);
    }
    let id = printed(fallback(val.get(c"id")?, "".into())?)?;
    if valid(&id) {
        text(provider, &id)
    } else {
        null(provider)
    }
}
fn now(p: L<'_>) -> Result<f64> {
    call(p.global()?.get(c"Date")?, c"now", &[])?.number()
}
fn date(p: L<'_>, v: &Value) -> Result<f64> {
    call(p.global()?.get(c"Date")?, c"parse", &[js_obj(p, v)?])?.number()
}
fn json_input(v: L<'_>) -> Result<Value> {
    // The credential kernel consumes JSON, so use V8's actual toJSON, omission,
    // cycle and exception semantics before passing it to the Rust owner.
    let json = v.global()?.get(c"JSON")?;
    let s = call(json, c"stringify", &[v])?;
    if s.undefined()? {
        return Ok(Value::Null);
    }
    multicc_core::json_lenient::from_str(&printed(s)?)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}
fn credential(req: Value) -> Result<Value> {
    provider_credentials::run(&req).map_err(napi::Error::from_reason)
}
fn read(file: &Path) -> Result<Value> {
    credential(json!({"operation":"readJson","file":file}))
}
fn patch(file: &Path, data: Value, claude: bool) -> Result<Value> {
    credential(json!({"operation":"patchJson","file":file,"data":data,"claude":claude}))
}
fn strval<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn js_num(v: Option<&Value>) -> f64 {
    v.map(|n| js::js_to_number(&js::from_serde(n)))
        .unwrap_or(f64::NAN)
}
fn copy_source(v: &Value) -> bool {
    v["source"] == "cli-import"
}
fn summary(p: L<'_>, auth: &Value, codex: bool) -> Result<Value> {
    if auth.is_null() {
        return Ok(json!({"loggedIn":false,"reason":"credential_unreadable"}));
    }
    let tokens = if codex { &auth["tokens"] } else { auth };
    let access = js::js_trim(strval(tokens, "access_token"));
    if access.is_empty() {
        return Ok(json!({"loggedIn":false,"reason":"access_token_missing"}));
    }
    let mut out = json!({"loggedIn":true});
    let end = if codex {
        let claims = provider_credentials::jwt(access);
        let email_claims = if js::serde::truthy(&tokens["id_token"]) {
            provider_credentials::jwt(&js::serde::js_string(&tokens["id_token"]))
        } else {
            claims.clone()
        };
        out["email"] = json!(strval(&email_claims, "email"));
        out["accountExternalId"] = json!(strval(tokens, "account_id"));
        out["subscription"] = provider_credentials::codex_subscription(auth);
        js_num(claims.get("exp")) * 1000.
    } else {
        out["email"] = json!(strval(auth, "email"));
        out["organizationName"] = json!(strval(auth, "organization_name"));
        out["hasRefreshToken"] = json!(!js::js_trim(strval(auth, "refresh_token")).is_empty());
        if js::serde::truthy(&auth["expired"]) {
            date(p, &auth["expired"])?
        } else {
            f64::NAN
        }
    };
    out["expiresAt"] = json!(end);
    out["expired"] = json!(end.is_finite() && end <= now(p)?);
    Ok(out)
}
fn list(p: L<'_>, base: &Path, codex: bool) -> Result<Value> {
    let Ok(list) = fs::read_dir(base.join(if codex { "codex" } else { "claude" })) else {
        return Ok(json!([]));
    };
    let mut ids = Vec::new();
    for entry in list {
        let Ok(entry) = entry else {
            return Ok(json!([]));
        };
        let Ok(kind) = entry.file_type() else {
            return Ok(json!([]));
        };
        let n = entry.file_name().to_string_lossy().into_owned();
        let id = if codex && kind.is_dir() {
            Some(n.as_str())
        } else if !codex && kind.is_file() {
            n.strip_suffix(".json")
        } else {
            None
        };
        if let Some(id) = id.filter(|id| valid(id)) {
            ids.push(id.to_owned())
        }
    }
    ids.sort();
    let mut rows = vec![];
    for id in ids {
        let file = account_file(
            base,
            if codex { "codexAuthFile" } else { "claudeFile" },
            &id,
        );
        let mut meta = read(&account_file(
            base,
            if codex { "codexMeta" } else { "claudeFile" },
            &id,
        ))?;
        if meta.is_null() {
            meta = json!({})
        }
        let copy = if codex && copy_source(&meta) {
            let at = date(
                p,
                meta.get("importedAt")
                    .filter(|v| js::serde::truthy(v))
                    .unwrap_or(&Value::Null),
            )?;
            !at.is_finite()
                || fs::metadata(&file)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
                    .is_none_or(|t| t.as_secs_f64() * 1000. <= at + 2000.)
        } else {
            copy_source(&meta)
        };
        let created = js_num(meta.get("createdAt"));
        let created = if created == 0. || created.is_nan() {
            Value::Null
        } else {
            json!(created)
        };
        let mut row = json!({
            "id": id,
            "label": strval(&meta, "label"),
            "createdAt": created,
            "source": strval(&meta, "source"),
            "cliCopy": copy,
        });
        let auth = if codex { read(&file)? } else { meta };
        row.as_object_mut()
            .unwrap()
            .extend(summary(p, &auth, codex)?.as_object().unwrap().clone());
        rows.push(row)
    }
    rows.sort_by(|a, b| {
        a["createdAt"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&b["createdAt"].as_f64().unwrap_or(0.))
    });
    Ok(Value::Array(rows))
}
fn remove(path: &Path, recursive: bool) -> Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    match if recursive && meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    } {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => Ok(r?),
    }
}
fn write_claude<'a>(owner: L<'a>, base: &Path, id: &str, data: Value) -> Result<L<'a>> {
    let file = account_file(base, "claudeFile", id);
    homes::private_dir(file.parent().unwrap())?;
    let merged = patch(&file, data, true)?;
    let result = js_obj(owner, &merged)?;
    let hook = owner.get(c"hook")?;
    if hook.kind()? == sys::ValueType::napi_function
        && !js::js_trim(strval(&merged, "access_token")).is_empty()
    {
        owner.catch(|| {
            let value = hook.call_plain(&[text(owner, id)?, result])?;
            let promise = call(owner.global()?.get(c"Promise")?, c"resolve", &[value])?;
            call(
                promise,
                c"catch",
                &[function(owner, "", 0, 0, |o, _| undefined(o))?],
            )?;
            Ok(())
        })?;
    }
    Ok(result)
}
fn label(options: L<'_>) -> Result<js::JsString> {
    let v = fallback(options.get(c"label")?, "".into())?;
    Ok(string(v)?
        .string()?
        .unwrap_or_default()
        .trim()
        .truncate_units(64))
}
fn store<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let root = opts.get(c"root")?;
    let root = if root.truthy()? {
        resolve(p, &[root])?
    } else {
        PathBuf::from(printed(p.get(c"defaultRoot")?)?)
    };
    let o = fields(p, &[("hook", opts.get(c"onCredentialWritten")?)])?;
    let api = fields(
        o,
        &[
            ("root", text(o, &root.to_string_lossy())?),
            ("assertAccountId", p.get(c"assertId")?),
        ],
    )?;
    for (name, length, n) in [
        ("createCodexAccount", 0, 1),
        ("writeCodexMeta", 2, 2),
        ("listCodexAccounts", 0, 0),
        ("deleteCodexAccount", 1, 1),
        ("writeCodexCredential", 2, 2),
        ("readCodexCredential", 1, 2),
        ("codexDir", 1, 1),
        ("codexAuthFile", 1, 1),
        ("createClaudeAccount", 0, 1),
        ("writeClaudeCredential", 2, 2),
        ("readClaudeCredential", 1, 1),
        ("listClaudeAccounts", 0, 0),
        ("deleteClaudeAccount", 1, 1),
        ("claudeFile", 1, 1),
        ("claudeHomeDir", 1, 1),
    ] {
        let base = root.clone();
        method(o, api, name, length, n, move |o, a| {
            if name.starts_with("list") {
                return js_obj(o, &list(o, &base, name == "listCodexAccounts")?);
            }
            if name.starts_with("create") {
                let id = homes::random_hex::<8>()?;
                let label = label(crate::host_methods::default_object(a[0])?)?;
                let meta = json!({
                    "label": label.to_string_lossy(),
                    "createdAt": now(o)?,
                });
                if name == "createClaudeAccount" {
                    write_claude(o, &base, &id, meta)?;
                    return js_obj(
                        o,
                        &json!({"id":id,"file":account_file(&base,"claudeFile",&id)}),
                    );
                }
                let dir = account_file(&base, "codexDir", &id);
                homes::private_dir(&dir)?;
                credential(
                    json!({"operation":"writeJson","file":dir.join("account.json"),"data":meta}),
                )?;
                return fields(
                    o,
                    &[
                        ("id", text(o, &id)?),
                        ("dir", text(o, &dir.to_string_lossy())?),
                        (
                            "authFile",
                            text(o, &dir.join("auth.json").to_string_lossy())?,
                        ),
                        ("label", o.from_value(&V::String(label))?),
                    ],
                );
            }
            let id = account_id(a[0])?;
            match name {
                "codexDir" | "codexAuthFile" | "claudeFile" | "claudeHomeDir" => {
                    text(o, &account_file(&base, name, &id).to_string_lossy())
                }
                "deleteCodexAccount" => {
                    remove(&account_file(&base, "codexDir", &id), true)?;
                    undefined(o)
                }
                "deleteClaudeAccount" => {
                    remove(&account_file(&base, "claudeFile", &id), false)?;
                    remove(&account_file(&base, "claudeHomeDir", &id), true)?;
                    undefined(o)
                }
                "writeCodexMeta" => js_obj(
                    o,
                    &patch(
                        &account_file(&base, "codexMeta", &id),
                        json_input(a[1])?,
                        false,
                    )?,
                ),
                "writeClaudeCredential" => write_claude(o, &base, &id, json_input(a[1])?),
                "readClaudeCredential" => {
                    js_obj(o, &read(&account_file(&base, "claudeFile", &id))?)
                }
                "writeCodexCredential" => {
                    if a[1].kind()? != sys::ValueType::napi_object || a[1].nullish()? {
                        return Err(o.type_error("[official-accounts] auth object is required"));
                    }
                    let file = account_file(&base, "codexAuthFile", &id);
                    homes::private_dir(file.parent().unwrap())?;
                    credential(
                        json!({"operation":"writeJson","file":file,"data":json_input(a[1])?}),
                    )?;
                    homes::mode(&file, 0o600)?;
                    Ok(a[1])
                }
                _ => {
                    let clock = crate::host_methods::default_object(a[1])?.get(c"now")?;
                    let time = if clock.undefined()? {
                        now(o)?
                    } else {
                        clock.call_plain(&[])?.number()?
                    };
                    js_obj(
                        o,
                        &credential(
                            json!({"operation":"codexCredential","file":account_file(&base,"codexAuthFile",&id),"now":time}),
                        )?,
                    )
                }
            }
        })?;
    }
    api.freeze()
}
fn sanitize<'a>(o: L<'a>, input: L<'a>, flow: L<'a>) -> Result<L<'a>> {
    let reject = |msg: &str| js_obj(o, &json!({"ok":false,"error":msg}));
    if input.nullish()? {
        return js_obj(o, &json!({"ok":true,"env":null}));
    }
    if input.kind()? != sys::ValueType::napi_object || input.is_array()? {
        return reject("loginEnv must be an object");
    }
    if !flow.truthy()? {
        return reject("loginEnv requires loginFlow");
    }
    let agy = flow.is_string("agy-login")?;
    let env = fields(o, &[])?;
    let mut any = false;
    for key in [
        "CODEX_HOME",
        "HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        let path_key = matches!(key, "CODEX_HOME" | "HOME");
        if !path_key && !agy {
            break;
        }
        let v = input.get_key(text(o, key)?)?;
        if v.nullish()? {
            continue;
        }
        let s = string(v)?.string()?.unwrap_or_default();
        let s = if path_key { s } else { s.trim() };
        let raw = s.to_string_lossy();
        let no_proxy = key.eq_ignore_ascii_case("no_proxy");
        let valid = !raw.contains(['\0', '\r', '\n'])
            && s.len() <= if no_proxy { 256 } else { 512 }
            && if path_key {
                call(
                    o.get(c"path")?,
                    c"isAbsolute",
                    &[o.from_value(&V::String(s.clone()))?],
                )?
                .truthy()?
            } else if no_proxy {
                !s.is_empty()
            } else {
                raw.split_once("://").is_some_and(|(scheme, url)| {
                    matches!(
                        scheme.to_ascii_lowercase().as_str(),
                        "http" | "https" | "socks5" | "socks5h" | "socks4"
                    ) && !url.is_empty()
                        && !url.chars().any(js::is_js_whitespace_char)
                })
            };
        if !valid {
            return reject(&format!("invalid loginEnv.{key}"));
        }
        env.set_key(text(o, key)?, o.from_value(&V::String(s))?)?;
        any = true;
    }
    fields(
        o,
        &[
            ("ok", flag(o, true)?),
            ("env", if any { env } else { null(o)? }),
        ],
    )
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let root = default_root(p)?;
    let assert_id = function(p, "assertAccountId", 1, 1, |o, a| {
        text(o, &account_id(a[0])?)
    })?;
    let owner = fields(
        p,
        &[
            ("path", p.get(c"path")?),
            ("defaultRoot", text(p, &root.to_string_lossy())?),
            ("assertId", assert_id),
        ],
    )?;
    let pattern = p
        .global()?
        .get(c"RegExp")?
        .construct(&[text(p, "^[a-f0-9]{16}$")?])?;
    let api = fields(
        p,
        &[
            ("DEFAULT_ROOT", owner.get(c"defaultRoot")?),
            ("ACCOUNT_ID_PATTERN", pattern),
            ("assertAccountId", assert_id),
        ],
    )?;
    method(owner, api, "createOfficialAccountStore", 0, 1, |o, a| {
        store(o, crate::host_methods::default_object(a[0])?)
    })?;
    method(owner, api, "officialAccountIdFromProvider", 1, 1, |_, a| {
        marker(a[0])
    })?;
    method(owner, api, "sanitizeLoginEnv", 2, 2, |o, a| {
        sanitize(o, a[0], a[1])
    })?;
    method(owner, api, "isCliCopy", 1, 1, |o, a| {
        flag(o, a[0].is_string("cli-import")?)
    })?;
    for (name, kind) in [
        ("codexAccountAuthFilePath", "codexAuthFile"),
        ("claudeAccountFilePath", "claudeFile"),
    ] {
        method(owner, api, name, 1, 2, move |o, a| {
            let id = account_id(a[0])?;
            let root = resolve(
                o,
                &[if a[1].undefined()? {
                    o.get(c"defaultRoot")?
                } else {
                    a[1]
                }],
            )?;
            text(o, &account_file(&root, kind, &id).to_string_lossy())
        })?;
    }
    Ok(api)
}
