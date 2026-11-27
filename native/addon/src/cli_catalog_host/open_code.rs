//! The picker, CLI admission and automatic provider selection share this cache.
use super::*;
use std::path::{Path, PathBuf};

fn parse(value: L<'_>) -> Result<L<'_>> {
    let raw = truthy_or(value, text(value, "")?)?;
    from_json(
        value,
        &Value::Array(kernel::parse_open_code(&fold_string(raw)?)),
    )
}
fn peek(p: L<'_>) -> Result<L<'_>> {
    let rows = p.get(c"cache")?.optional(c"models")?;
    if rows.is_array()? {
        Ok(rows)
    } else {
        array(p)
    }
}
fn providers(p: L<'_>) -> Result<L<'_>> {
    from_json(p, &kernel::open_code_providers(Path::new(&home(p)?)))
}
fn fallback_list(p: L<'_>) -> Result<L<'_>> {
    from_json(
        p,
        &Value::Array(kernel::open_code_fallback(Path::new(&home(p)?))),
    )
}
fn authorized(p: L<'_>) -> Result<L<'_>> {
    let set = p.global()?.get(c"Set")?.construct(&[])?;
    let xdg = process_env(p)?
        .get(c"XDG_DATA_HOME")?
        .string()?
        .map(|s| s.to_string_lossy());
    for id in kernel::authorized_providers(Path::new(&home(p)?), xdg.as_deref()) {
        call(set, c"add", &[text(p, &id)?])?;
    }
    Ok(set)
}
fn row_key(m: L<'_>) -> Result<String> {
    Ok(format!(
        "{}/{}",
        fold_string(m.get(c"provider")?)?,
        fold_string(m.get(c"model")?)?
    ))
}
fn merge<'a>(configured: L<'a>, cli: L<'a>, auth: L<'a>) -> Result<L<'a>> {
    if !configured.get(c"length")?.truthy()? {
        return Ok(cli);
    }
    let mut seen = std::collections::HashSet::new();
    let sections = configured.global()?.get(c"Set")?.construct(&[])?;
    let out = call(configured, c"slice", &[])?;
    configured.for_each(|r| {
        seen.insert(row_key(r)?);
        call(sections, c"add", &[r.get(c"provider")?])?;
        Ok(())
    })?;
    cli.for_each(|r| {
        let provider = r.get(c"provider")?;
        let key = row_key(r)?;
        if seen.contains(&key) || call(sections, c"has", &[provider])?.truthy()? {
            return Ok(());
        }
        let zen = provider.is_string("opencode")?;
        if !zen && !call(auth, c"has", &[provider])?.truthy()? {
            return Ok(());
        }
        let row = if zen && r.get(c"label")?.is_string(&key)? {
            let updated = spread(r)?;
            updated.set(c"label", text(r, &format!("{key} (OpenCode Zen)"))?)?;
            updated
        } else {
            r
        };
        call(out, c"push", &[row])?;
        Ok(())
    })?;
    call(
        out,
        c"slice",
        &[num(out, 0.0)?, num(out, kernel::MAX_MODELS as f64)?],
    )
}
fn configured<'a>(p: L<'a>, providers: L<'a>, live: L<'a>) -> Result<L<'a>> {
    from_json(
        p,
        &Value::Array(kernel::configured(
            &live_json(providers)?,
            &live_json(live)?,
        )),
    )
}
fn validate<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let raw = if a[0].nullish()? {
        String::new()
    } else {
        fold_string(a[0])?
    };
    if !raw.contains('/') {
        return null(p);
    }
    let mut rows = Vec::new();
    peek(p)?.for_each(|r| {
        if let (Some(provider), Some(model)) =
            (r.get(c"provider")?.string()?, r.get(c"model")?.string()?)
        {
            rows.push((provider.to_string_lossy(), model.to_string_lossy()));
        }
        Ok(())
    })?;
    match kernel::validate_open_code(&raw, &rows) {
        None => null(p),
        Some(s) => fields(
            p,
            &[
                ("valid", flag(p, false)?),
                (
                    "suggestion",
                    match s {
                        Some(value) => text(p, &value)?,
                        None => null(p)?,
                    },
                ),
            ],
        ),
    }
}
fn candidates(p: L<'_>) -> Result<L<'_>> {
    let env = process_env(p)?;
    let out = array(p)?;
    let override_ = env.get(c"OPENCODE_BIN")?;
    if override_.truthy()? {
        call(out, c"push", &[override_])?;
    }
    call(out, c"push", &[text(p, "opencode")?])?;
    let home = home(p)?;
    if !home.is_empty() {
        for suffix in [".opencode/bin/opencode", ".local/bin/opencode"] {
            let path = PathBuf::from(&home).join(suffix);
            call(out, c"push", &[text(p, &path.to_string_lossy())?])?;
        }
    }
    if cfg!(windows) {
        let local = env.get(c"LOCALAPPDATA")?;
        if local.truthy()? {
            let path = PathBuf::from(fold_string(local)?).join("opencode/opencode.exe");
            call(out, c"push", &[text(p, &path.to_string_lossy())?])?;
        }
    }
    Ok(out)
}
fn try_next(s: L<'_>) -> Result<L<'_>> {
    let bins = s.get(c"bins")?;
    let cb = s.get(c"cb")?;
    let index = s.get(c"idx")?.number()? as u32;
    if index >= bins.get(c"length")?.number()? as u32 {
        return cb.call_plain(&[error_value(s, "opencode models unavailable")?, array(s)?]);
    }
    s.set(c"idx", num(s, f64::from(index + 1))?)?;
    let args = array(s)?;
    args.set_element(0, text(s, "models")?)?;
    let opts = fields(
        s,
        &[
            ("timeout", num(s, 2000.0)?),
            ("maxBuffer", num(s, 524288.0)?),
        ],
    )?;
    let end = function(s, "", 2, 2, |s, a| {
        if a[0].truthy()? {
            if a[0].get(c"killed")?.truthy()? && a[0].get(c"signal")?.is_string("SIGTERM")? {
                s.set(c"idx", s.get(c"bins")?.get(c"length")?)?;
            }
            return try_next(s);
        }
        let rows = parse(a[1])?;
        if !rows.get(c"length")?.truthy()? {
            return try_next(s);
        }
        s.get(c"cb")?.call_plain(&[null(s)?, rows])
    })?;
    call(
        s.get(c"owner")?,
        c"execFile",
        &[bins.element(index)?, args, opts, end],
    )
}
fn finish(s: L<'_>) -> Result<L<'_>> {
    if s.get(c"finished")?.truthy()?
        || !s.get(c"cliSettled")?.truthy()?
        || !s.get(c"dynamicSettled")?.truthy()?
    {
        return undef(s);
    }
    s.set(c"finished", flag(s, true)?)?;
    let configured = s.get(c"configured")?;
    let has_cfg = configured.get(c"length")?.truthy()?;
    let err = s.get(c"cliErr")?;
    let cb = s.get(c"cb")?;
    let owner = s.get(c"owner")?;
    if err.truthy()? && !has_cfg {
        return cb.call_plain(&[err, array(s)?, text(s, "fallback")?]);
    }
    let rows = if err.truthy()? {
        configured
    } else {
        merge(configured, s.get(c"cliModels")?, authorized(owner)?)?
    };
    cache(owner, rows)?;
    cb.call_plain(&[
        null(s)?,
        rows,
        text(s, if has_cfg { "config" } else { "cli" })?,
    ])
}
fn list<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cb = a[0];
    let opts = default_object(a[1])?;
    let entry = p.get(c"cache")?;
    if !opts.get(c"refresh")?.truthy()? && fresh(entry, 3600000.0)? {
        return immediate_cache(p, cb);
    }
    let cfg = p.catch(|| providers(p))?.unwrap_or(null(p)?);
    let static_rows = p
        .catch(|| {
            if cfg.truthy()? {
                configured(p, cfg, null(p)?)
            } else {
                fallback_list(p)
            }
        })?
        .unwrap_or(array(p)?);
    let s = fields(
        p,
        &[
            ("owner", p),
            ("cb", cb),
            ("providers", cfg),
            ("configured", static_rows),
        ],
    )?;
    let receive = function(s, "", 2, 2, |s, a| {
        s.set(c"cliErr", a[0])?;
        s.set(c"cliModels", truthy_or(a[1], array(s)?)?)?;
        s.set(c"cliSettled", flag(s, true)?)?;
        finish(s)
    })?;
    let cli = opts.get(c"cliLister")?;
    let result = if callable(cli)? {
        cli.call_plain(&[receive])
    } else {
        (|| {
            let state = fields(
                p,
                &[
                    ("owner", p),
                    ("cb", receive),
                    ("bins", candidates(p)?),
                    ("idx", num(p, 0.0)?),
                ],
            )?;
            try_next(state)
        })()
    };
    if let Err(err) = result {
        s.set(c"cliErr", caught(s, err)?)?;
        s.set(c"cliSettled", flag(s, true)?)?;
    }
    let fetch = truthy_or(opts.get(c"fetchImpl")?, p.global()?.get(c"fetch")?)?;
    let loaded = super::dynamic::collect(p, cfg, fetch)?;
    let merged = then(loaded, s, |s, a| {
        let result = configured(s, s.get(c"providers")?, a[0])?;
        s.set(c"configured", result)?;
        undef(s)
    })?;
    let ready = recover(merged, s, |s, _| undef(s))?;
    then(ready, s, |s, _| {
        s.set(c"dynamicSettled", flag(s, true)?)?;
        finish(s)
    })?;
    undef(p)
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let out = methods(
        p,
        &[
            ("parseOpenCodeStdout", 1, |_, a| parse(a[0])),
            ("peekOpenCodeModels", 0, |p, _| peek(p)),
            ("readOpenCodeJsonFallback", 0, |p, _| fallback_list(p)),
            ("readOpenCodeConfigProviders", 0, |p, _| providers(p)),
            ("validateOpenCodeModel", 1, validate),
            ("_setCacheForTest", 2, test_cache),
            ("_resetCacheForTest", 0, reset_cache),
        ],
    )?;
    reg(out, p, "listOpenCodeModels", 1, 2, list)?;
    reg(out, p, "mergeOpenCodeModels", 2, 3, |p, a| {
        let auth = if a[2].undefined()? {
            p.global()?.get(c"Set")?.construct(&[])?
        } else {
            a[2]
        };
        merge(a[0], a[1], auth)
    })?;
    Ok(out)
}
