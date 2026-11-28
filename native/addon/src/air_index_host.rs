//! Air read-index transport. The model owns the cursor journal and cards;
//! this isolate retains only the accepted cursor and live notice objects.
use crate::host_api::*;
use napi_derive::napi;
mod notices;

fn message<'a>(p: L<'a>, op: &str, parts: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let c = fields(p, &[("op", text(p, op)?)])?;
    for (k, v) in parts {
        c.define_key(text(p, k)?, *v)?;
    }
    Ok(c)
}
fn both<'a>(p: L<'a>, one: L<'a>, two: L<'a>) -> Result<L<'a>> {
    let list = array(p)?;
    list.set_element(0, one)?;
    list.set_element(1, two)?;
    call(p.global()?.get(c"Promise")?, c"all", &[list])
}
fn run<'a>(s: L<'a>, command: L<'a>) -> Result<L<'a>> {
    if s.get(c"closed")?.truthy()? {
        let e = error_value(s, "首页摘要已关闭")?;
        e.set(c"status", num(s, 503.)?)?;
        e.set(c"code", text(s, "air_closed")?)?;
        return call(s.global()?.get(c"Promise")?, c"reject", &[e]);
    }
    // Both commands are admitted synchronously. Awaiting open before run would
    // permit the caller to mutate a command that appeared to be queued.
    let reply = call(
        s.get(c"model")?,
        c"run",
        &[message(s, "air", &[("command", command)])?],
    )?;
    then(both(s, s.get(c"opened")?, reply)?, s, |_, a| {
        a[0].element(1)
    })
}
fn accept<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let row = a[0];
    let cursor = row.optional(c"cursor")?;
    if cursor.truthy()? {
        s.set(c"cursor", cursor)?;
    }
    if row.optional(c"ready")?.truthy()?
        || row.optional(c"type")?.is_string("air_reset")?
        || row.optional(c"type")?.is_string("air_delta")?
    {
        s.set(c"ready", flag(s, true)?)?;
    }
    Ok(row)
}
fn change<'a>(s: L<'a>, a: &mut [L<'a>], publish: bool) -> Result<L<'a>> {
    let cmd = message(
        s,
        if publish { "publish" } else { "apply" },
        &[("snapshot", a[0])],
    )?;
    cmd.spread_from(a[1])?;
    if publish {
        cmd.set(c"dayStarts", with_default(a[2], array(s)?)?)?;
    }
    then(run(s, cmd)?, s, accept)
}
pub(super) fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let options = default_object(a[0])?;
    let mut model = options.get(c"model")?;
    let history = options.get(c"historyLimit")?;
    let bytes = options.get(c"maxDeltaBytes")?;
    if !model.truthy()? {
        let addon = p.get(c"getAddon")?.call_plain(&[])?;
        let version = addon.get(c"taskReadModelProtocolVersion")?;
        if version.nullish()? || !version.call(addon, &[])?.is_number(1.)? {
            return Err(error_value(p, "air_read_protocol_unavailable")?.throw_error());
        }
        model = p
            .get(c"createModel")?
            .call_plain(&[fields(p, &[("addon", addon)])?])?;
    }
    let epoch = p.get(c"uuid")?.call_plain(&[])?;
    let cursor = call(epoch, c"concat", &[text(p, ":0")?])?;
    let open = message(
        p,
        "open",
        &[
            ("epoch", epoch),
            ("historyLimit", history),
            ("maxDeltaBytes", bytes),
        ],
    )?;
    let opened = call(model, c"run", &[message(p, "air", &[("command", open)])?])?;
    call(opened, c"catch", &[function(p, "", 0, 0, |s, _| undef(s))?])?;
    let s = fields(
        p,
        &[
            ("model", model),
            ("opened", opened),
            ("cursor", cursor),
            ("ready", flag(p, false)?),
            ("closed", flag(p, false)?),
        ],
    )?;
    let out = defaulted_methods(
        s,
        &[
            ("isReady", 0, 0, |s, _| {
                flag(
                    s,
                    s.get(c"ready")?.truthy()? && !s.get(c"closed")?.truthy()?,
                )
            }),
            ("cursor", 0, 0, |s, _| s.get(c"cursor")),
            ("apply", 1, 2, |s, a| change(s, a, false)),
            ("publish", 1, 3, |s, a| change(s, a, true)),
            ("sync", 1, 2, |s, a| {
                run(
                    s,
                    message(
                        s,
                        "sync",
                        &[
                            ("since", string(fallback(a[0], "".into())?)?),
                            ("dayStart", with_default(a[1], num(s, 0.)?)?),
                        ],
                    )?,
                )
            }),
            ("changes", 1, 1, |s, a| {
                run(
                    s,
                    message(
                        s,
                        "changes",
                        &[("since", string(fallback(a[0], "".into())?)?)],
                    )?,
                )
            }),
            ("stats", 1, 1, |s, a| {
                run(s, message(s, "stats", &[("dayStart", a[0])])?)
            }),
            ("page", 0, 1, |s, a| {
                run(
                    s,
                    message(s, "page", &[("options", default_object(a[0])?)])?,
                )
            }),
            ("bootstrap", 0, 1, |s, a| {
                let cmd = message(s, "bootstrap", &[])?;
                cmd.spread_from(a[0])?;
                run(s, cmd)
            }),
            ("snapshot", 0, 0, |s, _| {
                run(s, message(s, "snapshot", &[])?)
            }),
            ("serialized", 0, 0, |s, _| {
                run(s, message(s, "serialized", &[])?)
            }),
            ("close", 0, 0, |s, _| {
                s.set(c"closed", flag(s, true)?)?;
                s.set(c"ready", flag(s, false)?)?;
                call(s.get(c"model")?, c"close", &[])
            }),
        ],
    )?;
    let api = fields(s, &[("backend", text(s, "rust")?)])?;
    api.spread_from(out)?;
    Ok(api)
}
#[napi]
pub fn air_index_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createAirIndex", 0, 1, create),
            ("createRustAirReadIndex", 0, 1, create),
            ("describeAirIssue", 1, 1, notices::describe),
            ("createAirStorageNotice", 0, 0, |p, _| {
                notices::standalone(p)
            }),
        ],
    )?;
    api.set(c"airNotices", notices::shared(p)?)?;
    Ok(api.raw())
}
