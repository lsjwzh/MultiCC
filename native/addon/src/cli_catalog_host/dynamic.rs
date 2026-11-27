//! Probe configured compatible gateways concurrently. A provider failure keeps its static rows.
use super::*;
fn configured_key(raw: L<'_>) -> Result<L<'_>> {
    let Some(value) = raw.string()? else {
        return text(raw, "");
    };
    let trimmed = value.to_string_lossy();
    let trimmed = trimmed.trim_matches(multicc_core::js::is_js_whitespace_char);
    if let Some(var) = trimmed
        .strip_prefix("{env:")
        .and_then(|v| v.strip_suffix('}'))
    {
        let mut chars = var.chars();
        if chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return truthy_or(process_env(raw)?.get_key(text(raw, var)?)?, text(raw, "")?);
        }
    }
    text(raw, trimmed)
}
fn rows<'a>(provider: L<'a>, payload: L<'a>) -> Result<L<'a>> {
    let data = if payload.is_array()? {
        payload
    } else if payload.optional(c"data")?.is_array()? {
        payload.get(c"data")?
    } else if payload.optional(c"models")?.is_array()? {
        payload.get(c"models")?
    } else {
        return array(payload);
    };
    let mut seen = std::collections::HashSet::new();
    let out = array(payload)?;
    let pid = fold_string(provider)?;
    data.for_each_while(|e| {
        if !object(e)? {
            return Ok(true);
        }
        let id = fold_string(truthy_or(e.get(c"id")?, text(e, "")?)?)?;
        let id = id.trim_matches(multicc_core::js::is_js_whitespace_char);
        if id.is_empty() || !seen.insert(id.to_owned()) {
            return Ok(true);
        }
        let name = e
            .get(c"name")?
            .string()?
            .map(|v| v.to_string_lossy())
            .unwrap_or_default();
        let name = name.trim_matches(multicc_core::js::is_js_whitespace_char);
        let key = format!("{pid}/{id}");
        let label = if name.is_empty() {
            key
        } else {
            format!("{key} ({name})")
        };
        call(
            out,
            c"push",
            &[fields(
                e,
                &[
                    ("provider", provider),
                    ("model", text(e, id)?),
                    ("label", text(e, &label)?),
                ],
            )?],
        )?;
        Ok(seen.len() < kernel::MAX_MODELS)
    })?;
    Ok(out)
}
fn request<'a>(s: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let headers = fields(s, &[("accept", text(s, "application/json")?)])?;
    if key.truthy()? {
        headers.set(
            c"authorization",
            text(s, &format!("Bearer {}", fold_string(key)?))?,
        )?;
    }
    let ctor = s.global()?.get(c"AbortController")?;
    let (controller, timer) = if callable(ctor)? {
        let ctl = ctor.construct(&[])?;
        let abort = function(ctl, "", 0, 0, |c, _| call(c, c"abort", &[]))?;
        let timer = call(s.global()?, c"setTimeout", &[abort, num(s, 3000.0)?])?;
        (ctl, timer)
    } else {
        (undef(s)?, null(s)?)
    };
    let promise = async_result(s, || {
        let opts = fields(
            s,
            &[
                ("method", text(s, "GET")?),
                ("headers", headers),
                ("signal", controller.optional(c"signal")?),
            ],
        )?;
        s.get(c"fetch")?.call_plain(&[s.get(c"endpoint")?, opts])
    })?;
    let clear = function(timer, "", 0, 0, |timer, _| {
        if timer.truthy()? {
            call(timer.global()?, c"clearTimeout", &[timer])?;
        }
        undef(timer)
    })?;
    call(promise, c"finally", &[clear])
}
fn one(s: L<'_>) -> Result<L<'_>> {
    let key = s.get(c"key")?;
    let first = request(s, key)?;
    let response = then(first, s, |s, a| {
        let status = a[0].optional(c"status")?.number()?;
        if s.get(c"key")?.truthy()? && (status == 401.0 || status == 403.0) {
            request(s, text(s, "")?)
        } else {
            Ok(a[0])
        }
    })?;
    let loaded = then(response, s, |s, a| {
        if !a[0].optional(c"ok")?.truthy()? {
            return null(s);
        }
        let body = call(a[0], c"json", &[])?;
        then(body, s, |s, a| rows(s.get(c"id")?, a[0]))
    })?;
    let saved = then(loaded, s, |s, a| {
        if a[0].truthy()? && a[0].get(c"length")?.truthy()? {
            s.get(c"out")?.define_key(s.get(c"id")?, a[0])?;
        }
        undef(s)
    })?;
    recover(saved, s, |s, _| undef(s))
}
pub(super) fn collect<'a>(p: L<'a>, cfg: L<'a>, fetch: L<'a>) -> Result<L<'a>> {
    let out = fields(p, &[])?;
    if !cfg.truthy()? || !callable(fetch)? {
        return resolved(out);
    }
    let pending = array(p)?;
    call(p.global()?.get(c"Object")?, c"entries", &[cfg])?.for_each(|pair| {
        let (id, entry) = pair.iterator_pair()?;
        let opts = entry.optional(c"options")?;
        let Some(base) = opts.optional(c"baseURL")?.string()? else {
            return Ok(());
        };
        let base = base.to_string_lossy();
        let base = base
            .trim_matches(multicc_core::js::is_js_whitespace_char)
            .trim_end_matches('/');
        if base.is_empty() {
            return Ok(());
        }
        let url = if base.to_ascii_lowercase().ends_with("/models") {
            base.to_owned()
        } else {
            format!("{base}/models")
        };
        let request = async_result(p, || {
            one(fields(
                p,
                &[
                    ("id", id),
                    ("out", out),
                    ("endpoint", text(p, &url)?),
                    ("key", configured_key(opts.get(c"apiKey")?)?),
                    ("fetch", fetch),
                ],
            )?)
        })?;
        call(pending, c"push", &[recover(request, p, |p, _| undef(p))?])?;
        Ok(())
    })?;
    let all = call(p.global()?.get(c"Promise")?, c"all", &[pending])?;
    then(all, out, constant)
}
