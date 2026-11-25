//! Account status and login-terminal contracts. Terminal creation and disposal
//! are asynchronous Node ports; the native rules preserve each CLI's wire DTO.
use crate::route_response::*;
use multicc_core::js::JsString;
use napi_derive::napi;

#[napi]
pub fn commandcode_login_status(
    env: Env,
    settings: Unknown<'_>,
    read_file: Unknown<'_>,
) -> Result<sys::napi_value> {
    let settings = L::new(&env, settings);
    let names = fields(
        settings,
        &[
            ("local", text(settings, "auth.local.json")?),
            ("staging", text(settings, "auth.staging.json")?),
        ],
    )?;
    let file = fallback(
        names.get_key(settings.get(c"COMMANDCODE_API_ENV")?)?,
        "auth.json".into(),
    )?;
    let key = settings.get(c"COMMAND_CODE_API_KEY")?;
    let env_key = if key.kind()? == sys::ValueType::napi_string {
        let value = settings.get(c"COMMAND_CODE_API_KEY")?;
        value.get(c"trim")?.call(value, &[])?.truthy()?
    } else {
        false
    };
    let saved = settings
        .catch(|| {
            let json = settings.global()?.get(c"JSON")?;
            let data = call(
                json,
                c"parse",
                &[L::new(&env, read_file).call_plain(&[file])?],
            )?;
            let has_key = data.truthy()?
                && data.get(c"apiKey")?.kind()? == sys::ValueType::napi_string
                && data
                    .get(c"apiKey")?
                    .string()?
                    .is_some_and(|s| !s.trim().is_empty());
            let user = if has_key && data.get(c"userName")?.kind()? == sys::ValueType::napi_string {
                let name = data.get(c"userName")?.string()?.unwrap_or_default();
                JsString::from_units(
                    name.into_units()
                        .into_iter()
                        .filter(|&u| u >= 32 && u != 127)
                        .take(120)
                        .collect(),
                )
            } else {
                JsString::new()
            };
            Ok((has_key, user))
        })?
        .unwrap_or_default();
    Ok(fields(
        settings,
        &[
            ("credentialSaved", flag(settings, saved.0)?),
            ("userName", settings.from_value(&V::String(saved.1))?),
            ("environmentKey", flag(settings, env_key)?),
        ],
    )?
    .raw())
}

#[napi]
pub fn codex_login_status(env: Env, status: Unknown<'_>) -> Result<sys::napi_value> {
    let s = fallback(L::new(&env, status), V::Object(vec![]))?;
    let needs = s.get(c"needsLogin")?.truthy()?
        || s.get(c"lastOutcome")?
            .optional(c"outcome")?
            .is_string("no-credentials")?;
    let enabled = flag(s, s.get(c"enabled")?.truthy()?)?;
    let since = if s.get(c"needsLogin")?.truthy()? {
        s.get(c"needsLogin")?.get(c"since")?
    } else {
        null(s)?
    };
    let last = if s.get(c"lastOutcome")?.truthy()? {
        fallback(s.get(c"lastOutcome")?.get(c"outcome")?, V::Null)?
    } else {
        null(s)?
    };
    Ok(fields(
        s,
        &[
            ("ok", flag(s, true)?),
            ("enabled", enabled),
            ("needsLogin", flag(s, needs)?),
            ("needsLoginSince", since),
            ("lastOutcome", last),
            (
                "consecutiveFailures",
                fallback(s.get(c"consecutiveFailures")?, V::Number(0.0))?,
            ),
            ("retryAfter", fallback(s.get(c"retryAfter")?, V::Null)?),
            (
                "loginCommand",
                if needs {
                    text(s, "codex login")?
                } else {
                    null(s)?
                },
            ),
        ],
    )?
    .raw())
}

#[napi]
pub fn login_terminal_directory(
    env: Env,
    directories: Unknown<'_>,
    require_path: bool,
) -> Result<sys::napi_value> {
    let dirs = L::new(&env, directories);
    let mut all = Vec::new();
    if require_path || dirs.get(c"values")?.kind()? == sys::ValueType::napi_function {
        call(dirs, c"values", &[])?.for_each(|d| {
            all.push(d);
            Ok(())
        })?;
    }
    for d in &all {
        if d.truthy()? && d.get(c"path")?.truthy()? {
            return Ok(d.raw());
        }
    }
    Ok(if require_path {
        null(dirs)?
    } else {
        all.first().copied().unwrap_or(null(dirs)?)
    }
    .raw())
}

#[napi]
pub fn agy_login_environment(
    env: Env,
    home: Unknown<'_>,
    req: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (home, req) = (L::new(&env, home), L::new(&env, req));
    let config = fields(home, &[("HOME", home)])?;
    let body = req.get(c"body")?;
    let proxy = if body.truthy()? {
        req.get(c"body")?.get(c"proxyUrl")?
    } else {
        body
    };
    if proxy.kind()? == sys::ValueType::napi_string {
        let proxy = req.get(c"body")?.get(c"proxyUrl")?;
        let proxy = proxy.get(c"trim")?.call(proxy, &[])?;
        if proxy.truthy()? {
            for key in [
                c"HTTP_PROXY",
                c"HTTPS_PROXY",
                c"ALL_PROXY",
                c"http_proxy",
                c"https_proxy",
                c"all_proxy",
            ] {
                config.set(key, proxy)?
            }
            for key in [c"NO_PROXY", c"no_proxy"] {
                config.set(key, text(home, "127.0.0.1,localhost,::1")?)?
            }
        }
    }
    Ok(config.raw())
}

#[napi]
pub fn login_terminal_record(
    env: Env,
    cli: String,
    dir: Unknown<'_>,
    login_env: Unknown<'_>,
) -> Result<sys::napi_value> {
    let dir = L::new(&env, dir);
    let (id, label, source) = match cli.as_str() {
        "commandcode" => (
            "commandcode-login",
            "Command Code 官方账号登录",
            "http.commandcode-login",
        ),
        "codex" => ("codex-login", "Codex 登录", "runtime.codex-login"),
        "agy" => ("agy-login", "反重力登录", "http.agy-login-terminal"),
        _ => return Err(dir.type_error("unknown login terminal")),
    };
    let record = fields(dir, &[("dir", dir)])?;
    if cli == "commandcode" {
        record.set(c"id", text(dir, id)?)?
    }
    record.set(c"cli", text(dir, &cli)?)?;
    record.set(c"kind", text(dir, "terminal")?)?;
    if cli != "commandcode" {
        record.set(c"id", text(dir, id)?)?
    }
    record.set(c"label", text(dir, label)?)?;
    if cli != "agy" {
        record.set(c"provider", null(dir)?)?
    }
    record.set(c"loginFlow", text(dir, id)?)?;
    if cli == "agy" {
        record.set(c"loginEnv", L::new(&env, login_env))?
    }
    record.set(c"persistence", text(dir, "required")?)?;
    record.set(c"persistenceSource", text(dir, source)?)?;
    Ok(record.raw())
}

#[napi]
pub fn login_terminal_result(
    env: Env,
    cli: String,
    result: Unknown<'_>,
    response: Unknown<'_>,
) -> Result<sys::napi_value> {
    let r = L::new(&env, result);
    let res = L::new(&env, response);
    if !r.truthy()? || !r.get(c"ok")?.truthy()? {
        let message = if cli == "commandcode" {
            text(r, "无法创建 Command Code 登录终端。")?
        } else {
            fallback(
                if r.truthy()? { r.get(c"error")? } else { r },
                "session create failed".into(),
            )?
        };
        let out = fields(r, &[])?;
        if cli != "agy" {
            out.set(c"ok", flag(r, false)?)?
        }
        out.set(c"error", message)?;
        return Ok(match cli.as_str() {
            "codex" => out,
            "agy" => send(res, Some(400), out)?,
            _ => send(res, Some(500), out)?,
        }
        .raw());
    }
    if cli == "agy" {
        let mut id = r.get(c"id")?;
        if !id.truthy()? {
            let session = r.get(c"session")?;
            id = if session.truthy()? {
                r.get(c"session")?.get(c"id")?
            } else {
                session
            };
        }
        let out = fields(r, &[])?;
        out.spread_from(r.get(c"session")?)?;
        out.set(c"id", id)?;
        let suffix = r
            .global()?
            .get(c"encodeURIComponent")?
            .call_plain(&[id])?
            .coerce_string()?
            .to_string_lossy();
        out.set(c"url", text(r, &format!("/?id={suffix}"))?)?;
        return Ok(send(res, None, out)?.raw());
    }
    let out = fields(
        r,
        &[
            ("ok", flag(r, true)?),
            ("sessionId", r.get(c"id")?),
            ("reused", flag(r, r.get(c"reused")?.truthy()?)?),
        ],
    )?;
    if cli == "commandcode" {
        send(res, None, out)?;
        return Ok(r.from_value(&V::Undefined)?.raw());
    }
    Ok(out.raw())
}
