//! One registry per binding instance, shared by push subscriptions, event rules,
//! trigger validation and the plugin host. V8 retains live host callbacks.
use crate::host_api::*;
use napi_derive::napi;

fn regex<'a>(p: L<'a>, pattern: &str) -> Result<L<'a>> {
    p.global()?.get(c"RegExp")?.construct(&[text(p, pattern)?])
}
fn clipped(v: L<'_>, limit: f64) -> Result<L<'_>> {
    call(v, c"slice", &[num(v, 0.)?, num(v, limit)?])
}
fn clean(v: L<'_>) -> Result<L<'_>> {
    string(fallback(v, "".into())?)
}
fn task_of<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let lookup = s.get(c"lookup")?;
    if !lookup.truthy()? || !id.truthy()? {
        return null(s);
    }
    let value = s
        .catch(|| lookup.call_plain(&[string(id)?]))?
        .unwrap_or(null(s)?);
    fallback(value, V::Null)
}
fn usage<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let out = array(s)?;
    s.get(c"sources")?.for_each(|f| {
        s.catch(|| {
            let items = f.call_plain(&[])?;
            if items.truthy()? {
                items.for_each(|v| {
                    if v.truthy()? && v.get(c"plugin")?.truthy()? {
                        call(out, c"push", &[v])?;
                    }
                    Ok(())
                })?;
            }
            Ok(())
        })?;
        Ok(())
    })?;
    Ok(out)
}
fn add_source<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let f = a[0];
    if !callable(f)? {
        return function(s, "", 0, 0, |s, _| undef(s));
    }
    let sources = s.get(c"sources")?;
    call(sources, c"add", &[f])?;
    let ctx = fields(s, &[("sources", sources), ("f", f)])?;
    function(ctx, "unsubscribe", 0, 0, |c, _| {
        call(c.get(c"sources")?, c"delete", &[c.get(c"f")?])
    })
}
fn check<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    for (name, v) in [(c"pluginId", a[0]), (c"targetId", a[1])] {
        if !call(s.get(name)?, c"test", &[clean(v)?])?.truthy()? {
            return text(s, "invalid channel action");
        }
    }
    let host = s.get(c"host")?;
    if !host.truthy()? || !callable(host.get(c"checkTarget")?)? {
        return text(s, "channel plugin not running");
    }
    call(host, c"checkTarget", a)
}
fn project<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let path = clean(a[0])?;
    let path = call(path, c"replace", &[regex(p, r"/+$")?, text(p, "")?])?;
    let root = call(path, c"split", &[text(p, "/.multicc-worktrees/")?])?.element(0)?;
    let cut = call(root, c"lastIndexOf", &[text(p, "/")?])?.number()? + 1.;
    call(root, c"slice", &[num(p, cut)?])
}
fn delivery<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let arg = a[0];
    let target = arg.get(c"target")?;
    let source = arg.get(c"source")?;
    let sid = arg.get(c"sessionId")?;
    let category = arg.get(c"category")?;
    let raw = arg.get(c"summary")?;
    let at = arg.get(c"occurredAt")?;
    let task = task_of(s, sid)?;
    let strip = call(
        clean(raw)?,
        c"replace",
        &[regex(s, r"^\[Chat\]\s*")?, text(s, "")?],
    )?;
    let ws = s
        .global()?
        .get(c"RegExp")?
        .construct(&[text(s, r"\s+")?, text(s, "g")?])?;
    let summary = call(call(strip, c"replace", &[ws, text(s, " ")?])?, c"trim", &[])?;
    let target = string(target)?;
    let source = clipped(string(fallback(source, "unknown".into())?)?, 80.)?;
    let sid_text = if sid.truthy()? {
        string(sid)?
    } else {
        text(s, "")?
    };
    let name = clipped(clean(task.optional(c"label")?)?, 80.)?;
    let proj = clipped(clean(task.optional(c"project")?)?, 80.)?;
    let chosen = if summary.truthy()? {
        summary
    } else {
        let label = task.optional(c"label")?;
        if label.truthy()? {
            label
        } else {
            category
        }
    };
    let summary = clipped(chosen, 300.)?;
    let at = if at.number_value()?.is_some_and(f64::is_finite) {
        at
    } else {
        call(s.global()?.get(c"Date")?, c"now", &[])?
    };
    let key = if sid.truthy()? && !category.is_string("test")? && !category.is_string("info")? {
        call(string(sid)?, c"concat", &[text(s, ":")?, string(category)?])?
    } else {
        null(s)?
    };
    fields(
        s,
        &[
            ("target", target),
            ("source", source),
            ("sessionId", sid_text),
            ("taskName", name),
            ("project", proj),
            ("category", category),
            ("summary", summary),
            ("occurredAt", at),
            ("dedupKey", key),
        ],
    )
}
fn still_active<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let category = a[1];
    let letters = s.get(c"letters")?.get_key(category)?;
    if !letters.truthy()? || !a[0].truthy()? {
        return flag(s, true);
    }
    let task = task_of(s, a[0])?;
    if !task.truthy()? {
        return flag(s, !s.get(c"lookup")?.truthy()?);
    }
    call(letters, c"includes", &[task.get(c"classifyState")?])
}
fn strings<'a>(p: L<'a>, list: &[&str]) -> Result<L<'a>> {
    let result = array(p)?;
    for (i, v) in list.iter().enumerate() {
        result.set_element(i as u32, text(p, v)?)?;
    }
    Ok(result)
}
#[napi]
pub fn channel_registry_api(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, anchor);
    let events = fields(
        p,
        &[
            ("task.failed", text(p, "error")?),
            ("task.waiting_user", text(p, "question")?),
            ("task.needs_interaction", text(p, "question")?),
            ("task.waiting_background", text(p, "background")?),
            ("task.finished", text(p, "done")?),
            ("task.achieved", text(p, "done")?),
        ],
    )?
    .freeze()?;
    let letters = fields(
        p,
        &[
            ("error", strings(p, &["E"])?),
            ("question", strings(p, &["W", "D"])?),
            ("background", strings(p, &["B"])?),
        ],
    )?
    .freeze()?;
    let s = fields(
        p,
        &[
            ("host", null(p)?),
            ("lookup", null(p)?),
            ("sources", p.global()?.get(c"Set")?.construct(&[])?),
            ("pluginId", regex(p, "^[a-z0-9][a-z0-9-]{0,63}$")?),
            ("targetId", regex(p, "^[A-Za-z0-9._:-]{1,64}$")?),
            ("events", events),
            ("letters", letters),
        ],
    )?;
    let api = fields(
        s,
        &[
            (
                "CATEGORIES",
                strings(p, &["done", "question", "background", "error"])?.freeze()?,
            ),
            (
                "DEFAULT_CATEGORIES",
                strings(p, &["error", "question"])?.freeze()?,
            ),
            ("PLUGIN_ID", s.get(c"pluginId")?),
            ("TARGET_ID", s.get(c"targetId")?),
        ],
    )?;
    api.spread_from(methods(
        s,
        &[
            ("register", 1, |s, a| {
                s.set(c"host", fallback(a[0], V::Null)?)?;
                undef(s)
            }),
            ("current", 0, |s, _| s.get(c"host")),
            ("setTaskLookup", 1, |s, a| {
                s.set(c"lookup", if callable(a[0])? { a[0] } else { null(s)? })?;
                undef(s)
            }),
            ("taskOf", 1, |s, a| task_of(s, a[0])),
            ("addUsageSource", 1, add_source),
            ("usage", 0, usage),
            ("checkTarget", 2, check),
            ("categoryOfPush", 2, |s, a| {
                if a[0].is_string("succeeded")? {
                    text(s, "done")
                } else if a[0].is_string("error")? {
                    text(s, "error")
                } else if a[0].is_string("waiting")? {
                    text(
                        s,
                        if a[1].is_string("B")? {
                            "background"
                        } else {
                            "question"
                        },
                    )
                } else {
                    null(s)
                }
            }),
            ("categoryOfEvent", 1, |s, a| {
                fallback(s.get(c"events")?.get_key(a[0])?, "info".into())
            }),
            ("projectName", 1, project),
            ("delivery", 1, delivery),
            ("deliver", 2, |s, a| {
                async_result(s, || {
                    let host = s.get(c"host")?;
                    if host.truthy()? && callable(host.get(c"deliver")?)? {
                        call(host, c"deliver", a)
                    } else {
                        fields(
                            s,
                            &[
                                ("ok", flag(s, false)?),
                                ("error", text(s, "channel plugin not running")?),
                                ("down", flag(s, true)?),
                            ],
                        )
                    }
                })
            }),
            ("stillActive", 2, still_active),
            ("reset", 0, |s, _| {
                s.set(c"host", null(s)?)?;
                s.set(c"lookup", null(s)?)?;
                call(s.get(c"sources")?, c"clear", &[])?;
                undef(s)
            }),
        ],
    )?)?;
    Ok(api.raw())
}
