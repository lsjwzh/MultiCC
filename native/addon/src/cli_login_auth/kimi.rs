use super::*;

const MESSAGE: &str = "Kimi Code 尚未登录。请打开「Kimi 登录」完成浏览器授权，或为会话选择一个带 API Key 的 MultiCC Provider。";

fn home<'a>(p: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let dir = e.get(c"KIMI_CODE_HOME")?;
    if dir.truthy()? {
        Ok(dir)
    } else {
        join(p, p.get(c"homedir")?.call_plain(&[])?, ".kimi-code")
    }
}
fn command(p: L<'_>) -> Result<L<'_>> {
    let v = process_env(p)?.get(c"KIMI_CMD")?;
    if v.truthy()? {
        Ok(v)
    } else {
        p.get(c"findExecutableOnPath")?
            .call_plain(&[text(p, "kimi")?])
    }
}
fn available(p: L<'_>) -> Result<L<'_>> {
    flag(p, p.catch(|| command(p)?.truthy())?.unwrap_or(false))
}
fn status<'a>(p: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let mut source = "none";
    if trimmed_string(e.get(c"KIMI_API_KEY")?)?.truthy()? {
        source = "env_key";
    } else {
        let dir = join(p, home(p, e)?, "credentials")?;
        if let Ok(entries) = fs::read_dir(filename(dir)?) {
            for entry in entries.flatten() {
                if !entry.file_name().to_string_lossy().ends_with(".json") {
                    continue;
                }
                if let Ok(bytes) = fs::read(entry.path()) {
                    let value = text(p, &String::from_utf8_lossy(&bytes))?;
                    if call(value, c"trim", &[])?.truthy()? {
                        source = "credentials";
                        break;
                    }
                }
            }
        }
    }
    let found = flag(p, source != "none")?;
    fields(
        p,
        &[
            ("configured", found),
            ("hasKey", found),
            ("source", text(p, source)?),
        ],
    )
}
fn verification<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    // Use V8 whitespace rules and preserve all UTF-16 units in the result.
    let re = p
        .global()?
        .get(c"RegExp")?
        .construct(&[text(p, r"Kimi device login:\s*(\S+)")?])?;
    let m = call(re, c"exec", &[string(nonempty(p, args[0])?)?])?;
    if m.truthy()? {
        let url = m.element(1)?;
        if call(url, c"startsWith", &[text(p, "https://")?])?.truthy()? {
            return Ok(url);
        }
    }
    null(p)
}
fn spawn_login<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let e = spread(process_env(p)?)?;
    e.delete(c"KIMI_CODE_HOME")?;
    let args = array(p)?;
    args.set_element(0, text(p, "login")?)?;
    let cmd = fallback(command(p)?, "kimi".into())?;
    p.get(c"spawn")?
        .call_plain(&[cmd, args, fields(p, &[("env", e)])?])
}
fn set_key<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let key = trimmed_string(a[0])?;
    if !key.truthy()? {
        return Err(error_value(p, "apiKey is required")?.throw_error());
    }
    let url = trimmed_string(default_object(a[1])?.get(c"baseURL")?)?;
    let dir = join(p, home(p, process_env(p)?)?, "credentials")?;
    mkdir(p, dir, false)?;
    let entry = fields(p, &[("apiKey", key)])?;
    if url.truthy()? {
        entry.set(c"baseURL", url)?;
    }
    let dest = filename(join(p, dir, "manual.json")?)?;
    let body = fold_string(json_string(p, entry)?)?;
    fs::write(&dest, body)
        .map_err(|e| crate::node_fs_error::throw(p, &e, "open", Some(&dest), None))?;
    fields(
        p,
        &[("ok", flag(p, true)?), ("source", text(p, "credentials")?)],
    )
}
fn ensure<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let provider = a[0].optional(c"provider")?;
    if provider.truthy()? {
        return admitted(p, provider, text(p, "multicc_provider")?);
    }
    let st = status(p, with_default(a[1], process_env(p)?)?)?;
    if st.get(c"configured")?.truthy()? {
        return admitted(p, null(p)?, st.get(c"source")?);
    }
    denied(p, MESSAGE, ("loginAvailable", available(p)?))
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    defaulted_methods(
        p,
        &[
            ("kimiHomeDir", 0, 1, |p, a| {
                home(p, with_default(a[0], process_env(p)?)?)
            }),
            ("isKimiLoginAvailable", 0, 0, |p, _| available(p)),
            ("getKimiAuthStatus", 0, 1, |p, a| {
                status(p, with_default(a[0], process_env(p)?)?)
            }),
            ("parseKimiLoginVerificationUrl", 1, 1, verification),
            ("spawnKimiLogin", 0, 0, spawn_login),
            ("setKimiApiKey", 1, 2, set_key),
            ("ensureKimiAuth", 1, 2, ensure),
        ],
    )
}
