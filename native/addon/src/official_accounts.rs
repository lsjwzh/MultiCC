//! V8 仅负责活对象、Date.parse 与 Promise；账号规则和磁盘操作由 Rust 拥有。
use crate::{
    codex_home::{checked, json, resolve, string_or_empty, value},
    host_methods::{default_object, function},
    route_response::*,
};
use multicc_core::{codex_home_fs as io, js, official_accounts as store};
use napi_derive::napi;
use std::{
    ffi::CStr,
    path::{Path, PathBuf},
};

fn id(a: L<'_>) -> Result<String> {
    let id = string_or_empty(a)?;
    if !store::valid_id(&id) {
        return Err(crate::codex_home::failure(
            a,
            io::Failure::new("OFFICIAL_ACCOUNT_ID_INVALID", "invalid official account id"),
        )?
        .throw_error());
    }
    Ok(id)
}
fn root(a: L<'_>) -> Result<PathBuf> {
    Ok(PathBuf::from(
        a.get(c"root")?.coerce_string()?.to_string_lossy(),
    ))
}
fn path(a: L<'_>, raw: L<'_>, kind: &str) -> Result<PathBuf> {
    checked(a, store::account_path(&root(a)?, &id(raw)?, kind))
}
fn credential<'a>(
    a: L<'a>,
    file: &Path,
    op: &str,
    data: Option<L<'a>>,
    claude: bool,
    now: Option<L<'a>>,
) -> Result<L<'a>> {
    let data = data.map(json).transpose()?;
    value(
        a,
        &store::credential(file, op, data, claude, now.map(json).transpose()?)
            .map_err(napi::Error::from_reason)?,
    )
}
fn read<'a>(a: L<'a>, file: &Path) -> Result<L<'a>> {
    credential(a, file, "readJson", None, false, None)
}
fn write<'a>(a: L<'a>, file: &Path, data: L<'a>, patch: bool, claude: bool) -> Result<L<'a>> {
    credential(
        a,
        file,
        if patch { "patchJson" } else { "writeJson" },
        Some(data),
        claude,
        None,
    )
}
fn now(a: L<'_>) -> Result<f64> {
    call(a.global()?.get(c"Date")?, c"now", &[])?.number()
}
fn date(a: L<'_>) -> Result<f64> {
    call(a.global()?.get(c"Date")?, c"parse", &[a])?.number()
}
fn field_string<'a>(a: L<'a>, key: &CStr) -> Result<L<'a>> {
    let raw = a.get(key)?;
    if raw.kind()? == sys::ValueType::napi_string {
        Ok(raw)
    } else {
        text(a, "")
    }
}
fn trimmed(a: L<'_>) -> Result<L<'_>> {
    call(a, c"trim", &[])
}
fn array<'a>(a: L<'a>, rows: &[L<'a>]) -> Result<L<'a>> {
    let out = a.from_value(&V::Array(vec![]))?;
    for (i, row) in rows.iter().enumerate() {
        out.set_element(i as u32, *row)?;
    }
    Ok(out)
}
fn payload(a: L<'_>) -> Result<L<'_>> {
    Ok(a.catch(|| payload_inner(a))?.unwrap_or(fields(a, &[])?))
}
fn payload_inner(a: L<'_>) -> Result<L<'_>> {
    let raw = string(a)?.coerce_string()?.to_string_lossy();
    let data = raw.split('.').nth(1).unwrap_or("");
    let bytes = js::node_base64_decode(&js::JsString::from(data));
    let parsed = js::json_parse(&String::from_utf8_lossy(&bytes)).ok();
    let parsed = match parsed {
        Some(V::Object(o)) => V::Object(o),
        _ => V::Object(vec![]),
    };
    a.from_value(&parsed)
}
fn codex_description<'a>(a: L<'a>, file: &Path) -> Result<L<'a>> {
    let auth = read(a, file)?;
    if !auth.truthy()? {
        return fields(
            a,
            &[
                ("loggedIn", flag(a, false)?),
                ("reason", text(a, "credential_unreadable")?),
            ],
        );
    }
    let tokens = auth.get(c"tokens")?;
    let tokens = if tokens.truthy()? && tokens.kind()? == sys::ValueType::napi_object {
        tokens
    } else {
        fields(a, &[])?
    };
    let access = trimmed(field_string(tokens, c"access_token")?)?;
    if !access.truthy()? {
        return fields(
            a,
            &[
                ("loggedIn", flag(a, false)?),
                ("reason", text(a, "access_token_missing")?),
            ],
        );
    }
    let exp = payload(access)?.get(c"exp")?.explicit_number()? * 1000.;
    let id_token = tokens.get(c"id_token")?;
    let claims = payload(if id_token.truthy()? { id_token } else { access })?;
    let subscription = multicc_core::provider_credentials::codex_subscription(&json(auth)?);
    fields(
        a,
        &[
            ("loggedIn", flag(a, true)?),
            ("email", field_string(claims, c"email")?),
            ("accountExternalId", field_string(tokens, c"account_id")?),
            ("subscription", value(a, &subscription)?),
            (
                "expiresAt",
                if exp.is_finite() {
                    num(a, exp)?
                } else {
                    null(a)?
                },
            ),
            ("expired", flag(a, exp.is_finite() && exp <= now(a)?)?),
        ],
    )
}
fn claude_description(a: L<'_>) -> Result<L<'_>> {
    if !a.truthy()? {
        return fields(
            a,
            &[
                ("loggedIn", flag(a, false)?),
                ("reason", text(a, "credential_unreadable")?),
            ],
        );
    }
    let access = trimmed(field_string(a, c"access_token")?)?;
    if !access.truthy()? {
        return fields(
            a,
            &[
                ("loggedIn", flag(a, false)?),
                ("reason", text(a, "access_token_missing")?),
            ],
        );
    }
    let raw = a.get(c"expired")?;
    let expires = if raw.truthy()? {
        Some(date(raw)?)
    } else {
        None
    };
    // Number.isFinite(null) 是 false；不能提前把缺失值转换成 0。
    let expires = expires.filter(|n| n.is_finite());
    fields(
        a,
        &[
            ("loggedIn", flag(a, true)?),
            ("email", field_string(a, c"email")?),
            ("organizationName", field_string(a, c"organization_name")?),
            (
                "expiresAt",
                match expires {
                    Some(n) => num(a, n)?,
                    None => null(a)?,
                },
            ),
            (
                "expired",
                flag(
                    a,
                    match expires {
                        Some(n) => n <= now(a)?,
                        None => false,
                    },
                )?,
            ),
            (
                "hasRefreshToken",
                flag(a, trimmed(field_string(a, c"refresh_token")?)?.truthy()?)?,
            ),
        ],
    )
}
fn list(a: L<'_>, claude: bool) -> Result<L<'_>> {
    let root = root(a)?;
    let mut rows = vec![];
    for id in store::ids(&root, claude) {
        let file = checked(
            a,
            store::account_path(
                &root,
                &id,
                if claude {
                    "claudeFile"
                } else {
                    "codexMetaFile"
                },
            ),
        )?;
        let data = read(a, &file)?;
        let data = if data.truthy()? {
            data
        } else {
            fields(a, &[])?
        };
        let created = data.get(c"createdAt")?.explicit_number()?;
        let cli = data.get(c"source")?.is_string("cli-import")?;
        let auth = checked(a, store::account_path(&root, &id, "codexAuthFile"))?;
        let cli_copy = if !claude && cli {
            let imported = data.get(c"importedAt")?;
            let imported = fallback(imported, "".into())?;
            !store::rewritten_since(&auth, date(imported)?)
        } else {
            cli
        };
        let row = fields(
            a,
            &[
                ("id", text(a, &id)?),
                ("label", field_string(data, c"label")?),
                (
                    "createdAt",
                    if created != 0. && !created.is_nan() {
                        num(a, created)?
                    } else {
                        null(a)?
                    },
                ),
                ("source", field_string(data, c"source")?),
                ("cliCopy", flag(a, cli_copy)?),
            ],
        )?;
        row.spread_from(if claude {
            claude_description(data)?
        } else {
            codex_description(a, &auth)?
        })?;
        rows.push((if created.is_nan() { 0. } else { created }, row));
    }
    rows.sort_by(|a, b| {
        (a.0 - b.0)
            .partial_cmp(&0.)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    array(a, &rows.into_iter().map(|(_, row)| row).collect::<Vec<_>>())
}
fn write_claude<'a>(a: L<'a>, raw_id: L<'a>, data: L<'a>) -> Result<L<'a>> {
    let file = path(a, raw_id, "claudeFile")?;
    checked(a, io::private_dir(file.parent().unwrap()))?;
    let merged = write(a, &file, data, true, true)?;
    let callback = a.get(c"onCredentialWritten")?;
    if !callback.nullish()? && trimmed(field_string(merged, c"access_token")?)?.truthy()? {
        a.catch(|| {
            let result = callback.call_plain(&[raw_id, merged])?;
            let promise = call(a.global()?.get(c"Promise")?, c"resolve", &[result])?;
            let noop = function(a, "", 0, 0, |a, _| a.from_value(&V::Undefined))?;
            call(promise, c"catch", &[noop])?;
            Ok(())
        })?;
    }
    Ok(merged)
}
fn label(input: L<'_>) -> Result<L<'_>> {
    let raw = input.get(c"label")?;
    let raw = string(fallback(raw, "".into())?)?;
    let raw = trimmed(raw)?;
    call(raw, c"slice", &[num(raw, 0.)?, num(raw, 64.)?])
}
fn create_store<'a>(defaults: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = default_object(options)?;
    let raw = options.get(c"root")?;
    let raw = if raw.truthy()? {
        raw
    } else {
        defaults.get(c"DEFAULT_ROOT")?
    };
    if raw.kind()? != sys::ValueType::napi_string {
        return Err(raw.type_error("The path argument must be of type string"));
    }
    let store_root = resolve(raw, &raw.coerce_string()?.to_string_lossy())?;
    let callback = options.get(c"onCredentialWritten")?;
    let callback = if callback.kind()? == sys::ValueType::napi_function {
        callback
    } else {
        null(defaults)?
    };
    let owner = fields(
        defaults,
        &[
            ("root", text(defaults, &store_root.to_string_lossy())?),
            ("onCredentialWritten", callback),
        ],
    )?;
    let out = fields(
        defaults,
        &[
            ("root", owner.get(c"root")?),
            ("assertAccountId", defaults.get(c"assertAccountId")?),
        ],
    )?;
    for (key, kind) in [
        (c"codexDir", "codexDir"),
        (c"codexAuthFile", "codexAuthFile"),
        (c"claudeFile", "claudeFile"),
        (c"claudeHomeDir", "claudeHomeDir"),
    ] {
        out.set(
            key,
            function(owner, kind, 1, 1, move |a, args| {
                text(a, &path(a, args[0], kind)?.to_string_lossy())
            })?,
        )?;
    }
    out.set(
        c"createCodexAccount",
        function(owner, "createCodexAccount", 0, 1, |a, args| {
            let input = default_object(args[0])?;
            let id = checked(a, io::random_hex(8))?;
            let raw = text(a, &id)?;
            let dir = path(a, raw, "codexDir")?;
            checked(a, io::private_dir(&dir))?;
            let label = label(input)?;
            let meta = fields(a, &[("label", label), ("createdAt", num(a, now(a)?)?)])?;
            write(a, &path(a, raw, "codexMetaFile")?, meta, false, false)?;
            fields(
                a,
                &[
                    ("id", raw),
                    ("dir", text(a, &dir.to_string_lossy())?),
                    (
                        "authFile",
                        text(a, &path(a, raw, "codexAuthFile")?.to_string_lossy())?,
                    ),
                    ("label", label),
                ],
            )
        })?,
    )?;
    out.set(
        c"createClaudeAccount",
        function(owner, "createClaudeAccount", 0, 1, |a, args| {
            let input = default_object(args[0])?;
            let id = text(a, &checked(a, io::random_hex(8))?)?;
            let meta = fields(
                a,
                &[("label", label(input)?), ("createdAt", num(a, now(a)?)?)],
            )?;
            write_claude(a, id, meta)?;
            fields(
                a,
                &[
                    ("id", id),
                    (
                        "file",
                        text(a, &path(a, id, "claudeFile")?.to_string_lossy())?,
                    ),
                ],
            )
        })?,
    )?;
    out.set(
        c"writeCodexMeta",
        function(owner, "writeCodexMeta", 2, 2, |a, args| {
            write(a, &path(a, args[0], "codexMetaFile")?, args[1], true, false)
        })?,
    )?;
    out.set(
        c"writeCodexCredential",
        function(owner, "writeCodexCredential", 2, 2, |a, args| {
            let auth = args[1];
            if !auth.truthy()? || auth.kind()? != sys::ValueType::napi_object {
                return Err(auth.type_error("[official-accounts] auth object is required"));
            }
            let file = path(a, args[0], "codexAuthFile")?;
            checked(a, io::private_dir(file.parent().unwrap()))?;
            write(a, &file, auth, false, false)?;
            checked(a, io::mode(&file, 0o600))?;
            Ok(auth)
        })?,
    )?;
    out.set(
        c"readCodexCredential",
        function(owner, "readCodexCredential", 1, 2, |a, args| {
            let options = default_object(args[1])?;
            let clock = options.get(c"now")?;
            let clock = if clock.undefined()? {
                a.global()?.get(c"Date")?.get(c"now")?
            } else {
                clock
            };
            let file = path(a, args[0], "codexAuthFile")?;
            let now = clock.call_plain(&[])?;
            credential(a, &file, "codexCredential", None, false, Some(now))
        })?,
    )?;
    out.set(
        c"readClaudeCredential",
        function(owner, "readClaudeCredential", 1, 1, |a, args| {
            read(a, &path(a, args[0], "claudeFile")?)
        })?,
    )?;
    out.set(
        c"writeClaudeCredential",
        function(owner, "writeClaudeCredential", 2, 2, |a, args| {
            write_claude(a, args[0], args[1])
        })?,
    )?;
    for (key, name, claude) in [
        (c"listCodexAccounts", "listCodexAccounts", false),
        (c"listClaudeAccounts", "listClaudeAccounts", true),
    ] {
        out.set(
            key,
            function(owner, name, 0, 0, move |a, _| list(a, claude))?,
        )?;
    }
    for (key, name, claude) in [
        (c"deleteCodexAccount", "deleteCodexAccount", false),
        (c"deleteClaudeAccount", "deleteClaudeAccount", true),
    ] {
        out.set(
            key,
            function(owner, name, 1, 1, move |a, args| {
                checked(a, store::delete(&root(a)?, &id(args[0])?, claude))?;
                a.from_value(&V::Undefined)
            })?,
        )?;
    }
    out.freeze()
}
fn marker(provider: L<'_>) -> Result<L<'_>> {
    if !provider.truthy()? || provider.kind()? != sys::ValueType::napi_object {
        return null(provider);
    }
    let mut cfg = provider.get(c"settingsConfig")?;
    if cfg.kind()? == sys::ValueType::napi_string {
        cfg = provider
            .catch(|| call(provider.global()?.get(c"JSON")?, c"parse", &[cfg]))?
            .unwrap_or(fields(provider, &[])?);
    }
    if !cfg.truthy()? || cfg.kind()? != sys::ValueType::napi_object {
        return null(provider);
    }
    let marker = cfg.get(c"officialAccount")?;
    if !marker.truthy()? || marker.kind()? != sys::ValueType::napi_object {
        return null(provider);
    }
    let raw = string_or_empty(marker.get(c"id")?)?;
    if store::valid_id(&raw) {
        text(provider, &raw)
    } else {
        null(provider)
    }
}
fn sanitize<'a>(input: L<'a>, flow: L<'a>) -> Result<L<'a>> {
    if input.nullish()? {
        return fields(input, &[("ok", flag(input, true)?), ("env", null(input)?)]);
    }
    let fail = |message: &str| {
        fields(
            input,
            &[
                ("ok", flag(input, false)?),
                ("error", text(input, message)?),
            ],
        )
    };
    if input.kind()? != sys::ValueType::napi_object || input.is_array()? {
        return fail("loginEnv must be an object");
    }
    if !flow.truthy()? {
        return fail("loginEnv requires loginFlow");
    }
    let env = fields(input, &[])?;
    let mut count = 0;
    let mut keys = vec![("CODEX_HOME", c"CODEX_HOME", 0), ("HOME", c"HOME", 0)];
    if flow.is_string("agy-login")? {
        keys.extend([
            ("HTTP_PROXY", c"HTTP_PROXY", 1),
            ("HTTPS_PROXY", c"HTTPS_PROXY", 1),
            ("ALL_PROXY", c"ALL_PROXY", 1),
            ("http_proxy", c"http_proxy", 1),
            ("https_proxy", c"https_proxy", 1),
            ("all_proxy", c"all_proxy", 1),
            ("NO_PROXY", c"NO_PROXY", 2),
            ("no_proxy", c"no_proxy", 2),
        ]);
    }
    for (name, key, kind) in keys {
        let raw = input.get(key)?;
        if raw.nullish()? {
            continue;
        }
        let raw = string(raw)?;
        let raw = if kind != 0 { trimmed(raw)? } else { raw };
        let s = raw.coerce_string()?;
        let text = s.to_string_lossy();
        let control = s.as_units().iter().any(|n| [0, 10, 13].contains(n));
        let valid = match kind {
            0 => Path::new(&text).is_absolute() && s.len() <= 512,
            1 => {
                let url = text.to_ascii_lowercase();
                let scheme = [
                    "http://",
                    "https://",
                    "socks5://",
                    "socks5h://",
                    "socks4://",
                ]
                .iter()
                .find(|p| url.starts_with(**p));
                scheme.is_some_and(|p| url.len() > p.len())
                    && !text.chars().any(js::is_js_whitespace_char)
                    && s.len() <= 512
            }
            _ => !s.is_empty() && s.len() <= 256,
        };
        if !valid || control {
            return fail(&format!("invalid loginEnv.{name}"));
        }
        env.set(key, raw)?;
        count += 1;
    }
    fields(
        input,
        &[
            ("ok", flag(input, true)?),
            ("env", if count == 0 { null(input)? } else { env }),
        ],
    )
}
#[napi]
pub fn official_accounts_api(env: Env, default_root: String) -> Result<sys::napi_value> {
    let a = L::new(&env, env.get_global()?.into_unknown(&env)?);
    let pattern = a
        .global()?
        .get(c"RegExp")?
        .construct(&[text(a, "^[a-f0-9]{16}$")?])?;
    let out = fields(
        a,
        &[
            ("DEFAULT_ROOT", text(a, &default_root)?),
            ("ACCOUNT_ID_PATTERN", pattern),
        ],
    )?;
    out.set(
        c"assertAccountId",
        function(a, "assertAccountId", 1, 1, |a, args| text(a, &id(args[0])?))?,
    )?;
    out.set(
        c"createOfficialAccountStore",
        function(out, "createOfficialAccountStore", 0, 1, |a, args| {
            create_store(a, args[0])
        })?,
    )?;
    out.set(
        c"officialAccountIdFromProvider",
        function(a, "officialAccountIdFromProvider", 1, 1, |_, args| {
            marker(args[0])
        })?,
    )?;
    out.set(
        c"isCliCopy",
        function(a, "isCliCopy", 1, 1, |a, args| {
            flag(a, args[0].is_string("cli-import")?)
        })?,
    )?;
    out.set(
        c"sanitizeLoginEnv",
        function(a, "sanitizeLoginEnv", 2, 2, |_, args| {
            sanitize(args[0], args[1])
        })?,
    )?;
    for (key, name, kind) in [
        (
            c"codexAccountAuthFilePath",
            "codexAccountAuthFilePath",
            "codexAuthFile",
        ),
        (
            c"claudeAccountFilePath",
            "claudeAccountFilePath",
            "claudeFile",
        ),
    ] {
        out.set(
            key,
            function(out, name, 1, 2, move |a, args| {
                let id = id(args[0])?;
                let raw = if args[1].undefined()? {
                    a.get(c"DEFAULT_ROOT")?
                } else {
                    args[1]
                };
                if raw.kind()? != sys::ValueType::napi_string {
                    return Err(raw.type_error("The path argument must be of type string"));
                }
                let root = resolve(a, &raw.coerce_string()?.to_string_lossy())?;
                text(
                    a,
                    &checked(a, store::account_path(&root, &id, kind))?.to_string_lossy(),
                )
            })?,
        )?;
    }
    Ok(out.raw())
}
