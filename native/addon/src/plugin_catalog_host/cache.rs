use super::*;
use std::{fs, path::PathBuf};
fn snapshot(o: L<'_>) -> Result<L<'_>> {
    let c = o.get(c"current")?;
    fields(
        o,
        &[
            (
                "catalog",
                if c.truthy()? {
                    c.get(c"catalog")?
                } else {
                    null(o)?
                },
            ),
            (
                "source",
                if c.truthy()? {
                    c.get(c"source")?
                } else {
                    null(o)?
                },
            ),
            (
                "fetchedAt",
                if c.truthy()? {
                    c.get(c"fetchedAt")?
                } else {
                    null(o)?
                },
            ),
            (
                "updatedAt",
                if c.truthy()? {
                    c.get(c"catalog")?.get(c"updatedAt")?
                } else {
                    null(o)?
                },
            ),
            ("error", o.get(c"lastError")?),
        ],
    )
}
fn accepted<'a>(o: L<'a>, body: L<'a>, sig: L<'a>) -> Result<L<'a>> {
    let p = o.get(c"ports")?;
    let k = parse::verify(p, body, sig, o.get(c"keys")?)?;
    let cat = parse::catalog(p, call(body, c"toString", &[text(p, "utf8")?])?)?;
    fields(p, &[("catalog", cat), ("keyId", k)])
}
fn load(o: L<'_>) -> Result<L<'_>> {
    let dir = PathBuf::from(text_of(o.get(c"dir")?)?);
    let read = |n: &str| fs::read(dir.join(n));
    let result = (|| -> Result<L<'_>> {
        let handle = |r: std::io::Result<Vec<u8>>| -> Result<Vec<u8>> {
            r.map_err(|e| {
                napi::Error::from_reason(if e.kind() == std::io::ErrorKind::NotFound {
                    "ENOENT".to_string()
                } else {
                    e.to_string()
                })
            })
        };
        let body = io::buffer(o, &handle(read("index.json"))?)?;
        let sig = handle(read("index.json.sig"))?;
        let current = accepted(o, body, text(o, &String::from_utf8_lossy(&sig))?)?;
        let meta = if let Ok(raw) = read("meta.json") {
            o.catch(|| json_call(o, c"parse", text(o, &String::from_utf8_lossy(&raw))?))?
                .unwrap_or(fields(o, &[])?)
        } else {
            fields(o, &[])?
        };
        for k in [c"source", c"fetchedAt"] {
            current.set(k, str_nonempty(meta.get(k)?)?)?;
        }
        Ok(current)
    })();
    match result {
        Ok(current) => o.set(c"current", current)?,
        Err(err) => {
            if err.reason != "ENOENT" {
                let e = message(o, err)?;
                log(
                    o.get(c"logger")?,
                    c"warn",
                    "plugin_catalog_cache_rejected",
                    fields(o, &[("error", e.get(c"message")?)])?,
                )?;
            }
        }
    }
    o.get(c"current")
}
fn get<'a>(o: L<'a>, url: L<'a>) -> Result<L<'a>> {
    let g = o.global()?;
    let ctrl = g.get(c"AbortController")?.construct(&[])?;
    let timer = g.get(c"setTimeout")?.call_plain(&[
        function(ctrl, "", 0, 0, |ctrl, _| call(ctrl, c"abort", &[]))?,
        o.get(c"timeout")?,
    ])?;
    let wait = async_result(o, || {
        let opts = fields(
            o,
            &[
                ("signal", ctrl.get(c"signal")?),
                (
                    "headers",
                    fields(o, &[("accept", text(o, "application/json")?)])?,
                ),
            ],
        )?;
        let fetch = o.get(c"fetch")?;
        let reply = if fetch.undefined()? {
            call(g, c"fetch", &[url, opts])?
        } else {
            fetch.call_plain(&[url, opts])?
        };
        let data = then(reply, o, |o, a| {
            if !a[0].get(c"ok")?.truthy()? {
                return reject(o, &format!("HTTP {}", fold_string(a[0].get(c"status")?)?));
            }
            call(a[0], c"arrayBuffer", &[])
        })?;
        then(data, o, |o, a| {
            let b = call(o.global()?.get(c"Buffer")?, c"from", &[a[0]])?;
            if b.get(c"length")?.number()? > 1048576. {
                return reject(o, "response too large");
            }
            Ok(b)
        })
    })?;
    call(
        wait,
        c"finally",
        &[function(timer, "", 0, 0, |t, _| {
            t.global()?.get(c"clearTimeout")?.call_plain(&[t])
        })?],
    )
}
fn iso(o: L<'_>) -> Result<L<'_>> {
    let d = o
        .global()?
        .get(c"Date")?
        .construct(&[o.get(c"now")?.call_plain(&[])?])?;
    call(d, c"toISOString", &[])
}
fn attempt(c: L<'_>) -> Result<L<'_>> {
    let o = c.get(c"o")?;
    let urls = o.get(c"urls")?;
    let i = c.get(c"i")?.number()? as u32;
    if i >= urls.get(c"length")?.number()? as u32 {
        let reason = fallback_to(
            call(c.get(c"failures")?, c"join", &[text(c, "; ")?])?,
            text(c, "no catalog source")?,
        )?;
        o.set(
            c"lastError",
            fields(o, &[("message", reason), ("at", iso(o)?)])?,
        )?;
        log(
            o.get(c"logger")?,
            c"warn",
            "plugin_catalog_refresh_failed",
            fields(o, &[("error", reason)])?,
        )?;
        return snapshot(o);
    }
    let url = urls.element(i)?;
    c.set(c"i", num(c, (i + 1) as f64)?)?;
    c.set(c"url", url)?;
    let work = async_result(o, || {
        let sig = then(get(o, url)?, c, |c, a| {
            c.set(c"body", a[0])?;
            get(
                c.get(c"o")?,
                call(text(c, "")?, c"concat", &[c.get(c"url")?, text(c, ".sig")?])?,
            )
        })?;
        then(sig, c, |c, a| {
            let o = c.get(c"o")?;
            let url = c.get(c"url")?;
            let body = c.get(c"body")?;
            let sig = call(a[0], c"toString", &[text(c, "utf8")?])?;
            let next = accepted(o, body, sig)?;
            let catalog = next.get(c"catalog")?;
            let date = c.global()?.get(c"Date")?;
            let when = catalog.get(c"updatedAt")?;
            let old = o.get(c"current")?;
            if old.truthy()? {
                let earlier = old.get(c"catalog")?.get(c"updatedAt")?;
                if call(date, c"parse", &[when])?.number()?
                    < call(date, c"parse", &[earlier])?.number()?
                {
                    return reject(
                        c,
                        &format!(
                            "older than the cached list ({} < {})",
                            fold_string(when)?,
                            fold_string(earlier)?
                        ),
                    );
                }
            }
            let at = iso(o)?;
            let meta = fields(
                c,
                &[
                    ("source", url),
                    ("fetchedAt", at),
                    ("updatedAt", when),
                    ("keyId", next.get(c"keyId")?),
                ],
            )?;
            next.set(c"source", url)?;
            next.set(c"fetchedAt", at)?;
            c.set(c"next", next)?;
            let dir = PathBuf::from(text_of(o.get(c"dir")?)?);
            let bytes = io::bytes(body)?;
            let sig = text_of(sig)?.into_bytes();
            let meta = fold_string(call(
                c.global()?.get(c"JSON")?,
                c"stringify",
                &[meta, null(c)?, num(c, 2.)?],
            )?)?
            .into_bytes();
            let write = io::background(c, move || {
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                for (name, raw) in [
                    ("index.json", bytes),
                    ("index.json.sig", sig),
                    ("meta.json", meta),
                ] {
                    let file = dir.join(name);
                    let tmp = dir.join(format!("{name}.{}.tmp", std::process::id()));
                    fs::write(&tmp, raw)
                        .and_then(|_| fs::rename(&tmp, &file))
                        .map_err(|e| e.to_string())?;
                }
                Ok(())
            })?;
            then(write, c, |c, _| {
                let o = c.get(c"o")?;
                let next = c.get(c"next")?;
                o.set(c"current", next)?;
                o.set(c"lastError", null(o)?)?;
                let warnings = next.get(c"catalog")?.get(c"warnings")?;
                if warnings.get(c"length")?.truthy()? {
                    log(
                        o.get(c"logger")?,
                        c"warn",
                        "plugin_catalog_entries_skipped",
                        fields(o, &[("warnings", warnings)])?,
                    )?;
                }
                snapshot(o)
            })
        })
    })?;
    recover(work, c, |c, a| {
        push(
            c.get(c"failures")?,
            call(
                text(c, "")?,
                c"concat",
                &[c.get(c"url")?, text(c, ": ")?, a[0].get(c"message")?],
            )?,
        )?;
        attempt(c)
    })
}
fn refresh(o: L<'_>) -> Result<L<'_>> {
    let active = o.get(c"inflight")?;
    if active.truthy()? {
        return Ok(active);
    }
    let res = async_result(o, || {
        attempt(fields(
            o,
            &[("o", o), ("i", num(o, 0.)?), ("failures", array(o)?)],
        )?)
    })?;
    let done = call(
        res,
        c"finally",
        &[function(o, "", 0, 0, |o, _| {
            o.set(c"inflight", null(o)?)?;
            undef(o)
        })?],
    )?;
    o.set(c"inflight", done)?;
    Ok(done)
}
pub(super) fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let dir = opts.get(c"cacheDir")?;
    if !dir.truthy()? {
        return Err(p.type_error("[plugin-catalog] cacheDir is required"));
    }
    let env = default_to(opts.get(c"env")?, p.get(c"process")?.get(c"env")?)?;
    let urls = array(p)?;
    let sources = default_to(opts.get(c"sources")?, p.get(c"sources")?)?;
    let custom = str_nonempty(env.get(c"MULTICC_PLUGIN_CATALOG_URL")?)?;
    let mut candidates = if custom.truthy()? {
        vec![custom]
    } else {
        vec![]
    };
    candidates.extend(items(sources)?);
    for url in candidates {
        if let Some(parsed) = p.catch(|| p.global()?.get(c"URL")?.construct(&[url]))? {
            let scheme = parsed.get(c"protocol")?;
            let host = parsed.get(c"hostname")?;
            if scheme.is_string("https:")?
                || scheme.is_string("http:")?
                    && (host.is_string("127.0.0.1")? || host.is_string("localhost")?)
            {
                push(urls, url)?;
            }
        }
    }
    let o = fields(
        p,
        &[
            ("ports", p),
            ("dir", dir),
            ("urls", urls),
            ("keys", default_to(opts.get(c"keys")?, p.get(c"keys")?)?),
            ("fetch", opts.get(c"fetch")?),
            (
                "logger",
                default_to(opts.get(c"logger")?, p.global()?.get(c"console")?)?,
            ),
            (
                "now",
                default_to(
                    opts.get(c"now")?,
                    function(p, "now", 0, 0, |p, _| now_js(p))?,
                )?,
            ),
            (
                "timeout",
                default_to(opts.get(c"timeoutMs")?, num(p, 15000.)?)?,
            ),
            ("current", null(p)?),
            ("lastError", null(p)?),
            ("timers", array(p)?),
        ],
    )?;
    load(o)?;
    let out = methods(
        o,
        &[
            ("refresh", 0, |o, _| refresh(o)),
            ("snapshot", 0, |o, _| snapshot(o)),
            ("start", 0, |o, _| {
                let timers = o.get(c"timers")?;
                if timers.get(c"length")?.truthy()? {
                    return undef(o);
                }
                for (k, ms) in [(c"setTimeout", 15000.), (c"setInterval", 86400000.)] {
                    let t = o.global()?.get(k)?.call_plain(&[
                        function(o, "", 0, 0, |o, _| {
                            refresh(o)?;
                            undef(o)
                        })?,
                        num(o, ms)?,
                    ])?;
                    let unref = t.optional(c"unref")?;
                    if callable(unref)? {
                        unref.call(t, &[])?;
                    }
                    push(timers, t)?;
                }
                undef(o)
            }),
            ("stop", 0, |o, _| {
                for t in items(o.get(c"timers")?)? {
                    o.global()?.get(c"clearTimeout")?.call_plain(&[t])?;
                }
                o.set(c"timers", array(o)?)?;
                undef(o)
            }),
            ("loadCache", 0, |o, _| load(o)),
        ],
    )?;
    out.set(c"sources", urls)?;
    Ok(out)
}
