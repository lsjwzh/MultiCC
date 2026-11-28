//! Mutable V8 mirror over the resident Rust task board.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;
mod proxy;
mod sync;
mod transaction;
const KINDS: [&str; 3] = ["tasks", "modules", "taskGroups"];
fn js<'a>(s: L<'a>, class: &CStr) -> Result<L<'a>> {
    s.global()?.get(class)?.construct(&[])
}
fn keys(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Object")?, c"keys", &[v])
}
fn values(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Object")?, c"values", &[v])
}
fn holder<'a>(s: L<'a>, kind: L<'a>) -> Result<L<'a>> {
    let raw = s.get(c"raw")?;
    if kind.is_string("root")? {
        Ok(raw)
    } else {
        raw.get_key(kind)
    }
}
fn or_empty(v: L<'_>) -> Result<L<'_>> {
    if object(v)? {
        Ok(v)
    } else {
        fields(v, &[])
    }
}
fn own<'a>(v: L<'a>, k: L<'a>) -> Result<bool> {
    call(v.global()?.get(c"Object")?, c"hasOwn", &[v, k])?.truthy()
}
fn pair<'a>(p: L<'a>, k: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let a = array(p)?;
    a.set_element(0, k)?;
    a.set_element(1, v)?;
    Ok(a)
}
fn push<'a>(a: L<'a>, v: L<'a>) -> Result<()> {
    a.set_element(a.get(c"length")?.number()? as u32, v)
}
fn add<'a>(a: L<'a>, k: L<'a>) -> Result<()> {
    call(a, c"add", &[k])?;
    Ok(())
}
fn has<'a>(a: L<'a>, k: L<'a>) -> Result<bool> {
    call(a, c"has", &[k])?.truthy()
}
fn nonempty(v: L<'_>) -> Result<bool> {
    v.get(c"size")?.truthy()
}
fn integer(v: L<'_>) -> Result<bool> {
    if v.kind()? != sys::ValueType::napi_string {
        return Ok(false);
    }
    let k = fold_string(v)?;
    Ok(k.parse::<u32>()
        .is_ok_and(|n| n < u32::MAX && n.to_string() == k))
}
fn dirty<'a>(s: L<'a>, k: L<'a>) -> Result<L<'a>> {
    s.get(c"dirty")?.get_key(k)
}
fn note_date<'a>(s: L<'a>, v: L<'a>) -> Result<()> {
    if !object(v)? {
        return Ok(());
    }
    let d = v.get(c"dueAt")?;
    if d.undefined()? {
        return Ok(());
    }
    let known = s.get(c"known")?;
    let k = json_call(s, c"stringify", d)?;
    if has(known, k)? {
        return Ok(());
    }
    add(known, k)?;
    push(
        s.get(c"dates")?,
        pair(s, d, s.get(c"p")?.get(c"wireDate")?.call_plain(&[d])?)?,
    )
}
fn group_order<'a>(p: L<'a>, groups: L<'a>) -> Result<L<'a>> {
    let order = array(p)?;
    values(or_empty(groups)?)?.for_each(|g| {
        let id = g.optional(c"id")?;
        if id.truthy()? {
            push(order, id)?;
        }
        Ok(())
    })?;
    call(order, c"sort", &[p.get(c"compare")?])
}
fn mark_order<'a>(s: L<'a>, k: L<'a>) -> Result<()> {
    add(s.get(c"keyed")?, k)?;
    add(s.get(c"resort")?, k)
}
fn code_error(v: L<'_>) -> Result<napi::Error> {
    let msg = fold_string(fallback(v, "task_board_failed".into())?)?;
    let e = error_value(v, &msg)?;
    let code = msg.split(':').next().unwrap_or("");
    if code.starts_with(|ch: char| ch.is_ascii_alphabetic())
        && code.bytes().all(|x| x.is_ascii_alphanumeric() || x == b'_')
    {
        e.set(c"code", text(v, code)?)?
    }
    Ok(e.throw_error())
}
fn warn(s: L<'_>, msg: &str) -> Result<()> {
    s.catch(|| {
        let l = s.get(c"logger")?;
        let mut f = l.optional(c"warn")?;
        if !f.truthy()? {
            f = l.optional(c"log")?
        };
        if f.nullish()? {
            return undef(s);
        }
        f.call(l, &[text(s, msg)?])
    })?;
    Ok(())
}
fn check<'a>(s: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    let r = sync::send(s, c"verify", fields(s, &[("board", s.get(c"raw")?)])?, true)?;
    if r.get(c"ok")?.truthy()? {
        return flag(s, true);
    }
    let summaries = sync::restore(s, r.get(c"drift")?)?;
    let msg = format!(
        "TASK_BOARD_MIRROR_DRIFT:{}:{}",
        fold_string(reason)?,
        fold_string(call(summaries, c"join", &[text(s, ";")?])?)?
    );
    if s.get(c"verify")?.truthy()? {
        return Err(code_error(text(s, &msg)?)?);
    }
    warn(s, &format!("[multicc/taskboard] {msg}"))?;
    flag(s, false)
}
fn command<'a>(s: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let cmd = spread(input)?;
    cmd.delete(c"board")?;
    s.get(c"p")?
        .get(c"domain")?
        .get(c"forWire")?
        .call_plain(&[cmd])
}
fn execute<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cmd = command(s, a[0])?;
    let r = sync::send(s, c"apply", fields(s, &[("command", cmd)])?, true)?;
    if !r.get(c"ok")?.truthy()? {
        sync::restore(s, r.get(c"restore")?)?;
        return Err(code_error(r.get(c"error")?)?);
    }
    sync::apply_diff(s, r.get(c"diff")?)?;
    if r.get(c"readonlyMutated")?.truthy()? {
        let msg = format!(
            "TASK_BOARD_READONLY_MUTATED:{}.{}",
            fold_string(a[0].get(c"op")?)?,
            fold_string(fallback(a[0].get(c"action")?, "".into())?)?
        );
        if s.get(c"verify")?.truthy()? {
            return Err(code_error(text(s, &msg)?)?);
        }
        warn(s, &format!("[multicc/taskboard] {msg}"))?;
    }
    if s.get(c"verify")?.truthy()? {
        check(s, text(s, "call")?)?;
    }
    r.get(c"out")
}
fn run_async(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let start = function(f, "applyAsync", 0, 0, |f, _| {
        call(
            f.get(c"s")?.get(c"native")?,
            c"applyAsync",
            &[f.get(c"input")?],
        )
    })?;
    then(
        s.get(c"p")?.get(c"runNative")?.call_plain(&[start])?,
        s,
        |s, a| json_call(s, c"parse", a[0]),
    )
}
fn execute_async<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        sync::flush(s)?;
        let f = fields(
            s,
            &[
                ("s", s),
                (
                    "input",
                    json_call(
                        s,
                        c"stringify",
                        fields(s, &[("command", command(s, a[0])?)])?,
                    )?,
                ),
            ],
        )?;
        let res = recover(async_result(f, || run_async(f))?, f, |f, a| {
            let s = f.get(c"s")?;
            s.set(c"full", flag(s, true)?)?;
            if !fold_string(a[0].optional(c"message")?)?.contains("RESYNC_REQUIRED") {
                return Err(s
                    .get(c"p")?
                    .get(c"nativeCode")?
                    .call_plain(&[a[0]])?
                    .throw_error());
            }
            sync::flush(s)?;
            run_async(f)
        })?;
        then(res, s, |_, a| {
            if !a[0].get(c"ok")?.truthy()? {
                return Err(code_error(a[0].get(c"error")?)?);
            }
            a[0].get(c"out")
        })
    })
}
fn persist<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let repo = s.get(c"repo")?;
    let file = repo.optional(c"nativeFile")?;
    let result = if file.truthy()? {
        let r = sync::send(
            s,
            c"persist",
            fields(
                s,
                &[
                    ("file", file),
                    ("expectedRevision", a[0]),
                    ("onConflict", text(s, "preserve")?),
                ],
            )?,
            true,
        )?;
        sync::apply_diff(s, r.get(c"diff")?)?;
        if !r.get(c"ok")?.truthy()? {
            return Err(code_error(r.get(c"error")?)?);
        }
        r.get(c"result")?
    } else {
        let r = call(
            repo,
            c"save",
            &[
                snapshot(s, &mut [])?,
                a[0],
                fields(s, &[("onConflict", text(s, "preserve")?)])?,
            ],
        )?;
        let rev = r.optional(c"revision")?;
        let raw = s.get(c"raw")?;
        if !rev.nullish()? && rev.explicit_number()? != raw.get(c"revision")?.explicit_number()? {
            transaction::capture(s, text(s, "root")?, text(s, "revision")?)?;
            raw.set(c"revision", rev)?;
            add(dirty(s, text(s, "root")?)?, text(s, "revision")?)?;
        }
        r
    };
    call(s.get(c"volatile")?, c"clear", &[])?;
    call(s.get(c"replaced")?, c"clear", &[])?;
    if s.get(c"verify")?.truthy()? {
        check(s, text(s, "persist")?)?;
    }
    Ok(result)
}
fn snapshot<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    sync::send(s, c"snapshot", fields(s, &[])?, true)
}
fn open<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(a[0])?;
    let input = with_default(o.get(c"raw")?, null(o)?)?;
    let env = o.global()?.get(c"process")?.get(c"env")?;
    let v = o.get(c"verify")?;
    let v = if v.undefined()? {
        let ctl = env.get(c"MULTICC_TASK_BOARD_VERIFY")?;
        flag(
            p,
            ctl.is_string("1")?
                || (!ctl.is_string("0")? && env.get(c"NODE_TEST_CONTEXT")?.truthy()?),
        )?
    } else {
        v
    };
    let owner = p.get(c"Owner")?;
    if !callable(owner)? {
        return Err(error_value(
            p,
            "任务板常驻 Rust 接口不可用，请构建当前原生模块后手动重启",
        )?
        .throw_error());
    }
    let native = owner.construct(&[])?;
    let dates = array(o)?;
    values(or_empty(input.optional(c"tasks")?)?)?.for_each(|task| {
        let d = task.optional(c"dueAt")?;
        push(dates, pair(o, d, p.get(c"wireDate")?.call_plain(&[d])?)?)
    })?;
    let body = fields(
        p,
        &[
            ("raw", input),
            ("dates", dates),
            ("idOrder", group_order(p, input.optional(c"taskGroups")?)?),
            ("verifyReads", v),
        ],
    )?;
    let raw = json_call(
        o,
        c"parse",
        call(native, c"open", &[json_call(o, c"stringify", body)?])?,
    )?;
    let s = fields(
        p,
        &[
            ("p", p),
            ("raw", raw),
            ("native", native),
            ("verify", v),
            ("repo", o.get(c"repository")?),
            (
                "logger",
                with_default(o.get(c"logger")?, p.global()?.get(c"console")?)?,
            ),
        ],
    )?;
    for k in [c"keyed", c"resort", c"replaced", c"known"] {
        s.set(k, js(s, c"Set")?)?
    }
    for k in [c"metas", c"cache"] {
        s.set(k, js(s, c"WeakMap")?)?
    }
    for k in [c"volatile", c"containers"] {
        s.set(k, js(s, c"Map")?)?
    }
    s.set(c"dates", array(s)?)?;
    let dirty = fields(s, &[])?;
    s.set(c"dirty", dirty)?;
    for k in KINDS.into_iter().chain(["root"]) {
        let kind = text(s, k)?;
        dirty.define_key(kind, js(s, c"Set")?)?;
        if k != "root" {
            keys(or_empty(raw.get_key(kind)?)?)?.for_each(|id| {
                if integer(id)? {
                    add(s.get(c"keyed")?, kind)?;
                }
                Ok(())
            })?;
        }
    }
    for k in ["tasks", "taskGroups"] {
        add(s.get(c"resort")?, text(s, k)?)?;
    }
    values(or_empty(raw.get(c"tasks")?)?)?.for_each(|v| note_date(s, v))?;
    let store = methods(
        s,
        &[
            ("call", 1, execute),
            ("callAsync", 1, execute_async),
            ("flush", 0, |s, _| {
                sync::flush(s)?;
                undef(s)
            }),
            ("persist", 1, persist),
            ("transaction", 1, transaction::run),
            ("replaceTracked", 2, proxy::replace_tracked),
            ("rawOf", 1, |s, a| {
                call(s.get(c"metas")?, c"get", &[a[0]])?.optional(c"target")
            }),
            ("verify", 1, |s, a| {
                check(s, fallback(a[0], "manual".into())?)
            }),
            ("snapshot", 0, snapshot),
            ("cloneRaw", 0, snapshot),
            ("close", 0, |s, _| {
                let timer = s.get(c"timer")?;
                if timer.truthy()? {
                    s.global()?.get(c"clearInterval")?.call_plain(&[timer])?;
                }
                s.set(c"timer", null(s)?)?;
                undef(s)
            }),
        ],
    )?;
    s.set(c"store", store)?;
    let board = proxy::root(s)?;
    store.set(c"board", board)?;
    store.set(c"native", native)?;
    let ms = with_default(o.get(c"verifyIntervalMs")?, num(o, 600000.)?)?;
    if ms.explicit_number()? > 0. {
        let tick = function(s, "", 0, 0, |s, _| {
            s.catch(|| check(s, text(s, "periodic")?))?;
            undef(s)
        })?;
        let timer = s.global()?.get(c"setInterval")?.call_plain(&[tick, ms])?;
        if !timer.get(c"unref")?.nullish()? {
            call(timer, c"unref", &[])?;
        }
        s.set(c"timer", timer)?;
    }
    call(p.get(c"domain")?, c"registerBoardStore", &[board, store])?;
    Ok(store)
}
#[napi]
pub fn task_board_store_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(defaulted_methods(p, &[("openBoardStore", 0, 1, open)])?.raw())
}
