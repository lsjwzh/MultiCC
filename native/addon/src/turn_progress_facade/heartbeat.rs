//! V8 保留构造器和定时器句柄。截止时间由 Rust 进度 owner 给出。
use super::*;
use napi::bindgen_prelude::ToNapiValue;

fn init<'a>(s: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    if !func(read(opts, c"onHeartbeat")?)? {
        return Err(s.type_error("onHeartbeat is required"));
    }
    let interval = number_option(opts, c"intervalMs", DEFAULT_INTERVAL_MS)?;
    if !interval.number()?.is_finite() || interval.number()? <= 0.0 {
        return Err(s.type_error("intervalMs must be a positive finite number"));
    }
    s.assign(c"intervalMs", interval)?;
    s.assign(c"_onHeartbeat", read(opts, c"onHeartbeat")?)?;
    for (from, to) in [
        (c"now", c"_now"),
        (c"setInterval", c"_setInterval"),
        (c"clearInterval", c"_clearInterval"),
    ] {
        let value = read(opts, from)?;
        let value = if value.truthy()? {
            value
        } else if from == c"now" {
            s.global()?.get(c"Date")?.get(from)?
        } else {
            s.global()?.get(from)?
        };
        s.assign(to, value)?;
    }
    for k in [c"_now", c"_setInterval", c"_clearInterval"] {
        if !func(s.get(k)?)? {
            return Err(s.type_error("now, setInterval, and clearInterval must be functions"));
        }
    }
    let owner = read(opts, c"owner")?;
    let owner = if owner.truthy()? {
        owner
    } else {
        new_owner(fields(s, &[("intervalMs", interval)])?)?
    };
    s.assign(c"_owner", owner)?;
    s.assign(c"_timer", null(s)?)?;
    s.assign(c"_timerDue", null(s)?)?;
    let log = if func(read(opts, c"logWarn")?)? {
        read(opts, c"logWarn")?
    } else {
        null(s)?
    };
    s.assign(c"_logWarn", log)?;
    let ports = fields(s, &[])?;
    add(ports, s, "now", 0, 0, |s, _| call(s, c"_now", &[]))?;
    add(ports, s, "onHeartbeat", 1, 1, |s, a| {
        call(s, c"_onHeartbeat", &[a[0].freeze()?])
    })?;
    add(ports, s, "logWarn", 2, 2, |s, a| {
        if s.get(c"_logWarn")?.truthy()? {
            s.catch(|| call(s, c"_logWarn", a))?;
        }
        undefined(s)
    })?;
    s.assign(c"_ports", ports)?;
    undefined(s)
}

fn clean(v: L<'_>) -> Result<L<'_>> {
    if v.nullish()? {
        text(v, "")
    } else {
        call(string(v)?, c"trim", &[])
    }
}
fn arm(s: L<'_>) -> Result<L<'_>> {
    let due = owner::invoke(s.get(c"_owner")?, c"heartbeatNextDue", &[])?;
    if due.nullish()? {
        call(s, c"_clearTimer", &[])?;
        return undefined(s);
    }
    if !s.get(c"_timer")?.nullish()?
        && !s.get(c"_timerDue")?.nullish()?
        && s.get(c"_timerDue")?.number()? <= due.number()?
    {
        return undefined(s);
    }
    call(s, c"_clearTimer", &[])?;
    let delay = due.number()? - call(s, c"_now", &[])?.explicit_number()?;
    let delay = if delay.is_nan() {
        delay
    } else {
        delay.max(0.0)
    };
    s.assign(c"_timerDue", due)?;
    let tick = bound(s, "", 0, 0, |s, _| call(s, c"_tick", &[]))?;
    let timer = call(s, c"_setInterval", &[tick, num(s, delay)?])?;
    s.assign(c"_timer", timer)?;
    if timer.truthy()? && func(read(timer, c"unref")?)? {
        call(timer, c"unref", &[])?;
    }
    undefined(s)
}
fn tick(s: L<'_>) -> Result<L<'_>> {
    call(s, c"_clearTimer", &[])?;
    let result = (|| {
        let at = call(s, c"_timestamp", &[])?;
        owner::invoke(s.get(c"_owner")?, c"heartbeatDue", &[at, s.get(c"_ports")?])
    })();
    let thrown = if result.is_err() {
        s.exception_value()?
    } else {
        None
    };
    call(s, c"_arm", &[])?;
    if let Some(e) = thrown {
        return Err(e.throw_error());
    }
    result?;
    undefined(s)
}
fn run<'a>(name: &str, s: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    match name {
        "start" => {
            let session = clean(a[0])?;
            if !session.truthy()? {
                return Err(s.type_error("sessionId is required"));
            }
            let turn = clean(a[1])?;
            if !turn.truthy()? {
                return Err(s.type_error("turnId is required"));
            }
            let snap = owner::invoke(
                s.get(c"_owner")?,
                c"heartbeatStart",
                &[session, turn, options(a[2])?, s.get(c"_ports")?],
            )?;
            call(s, c"_arm", &[])?;
            snap.freeze()
        }
        "_find" => {
            let session = clean(a[0])?;
            let turn = clean(a[1])?;
            if !session.truthy()? || !turn.truthy()? {
                null(s)
            } else {
                fields(s, &[("session", session), ("turn", turn)])
            }
        }
        "touchVisible" | "touchActivity" | "updatePhase" | "stop" => {
            let found = call(s, c"_find", &a[..2])?;
            if !found.truthy()? {
                return flag(s, false);
            }
            let owner = s.get(c"_owner")?;
            let session = read(found, c"session")?;
            let turn = read(found, c"turn")?;
            let result = match name {
                "touchVisible" => owner::invoke(
                    owner,
                    c"heartbeatTouchVisible",
                    &[session, turn, s.get(c"_ports")?],
                )?,
                "touchActivity" => owner::invoke(
                    owner,
                    c"heartbeatTouchActivity",
                    &[session, turn, s.get(c"_ports")?],
                )?,
                "updatePhase" => owner::invoke(
                    owner,
                    c"heartbeatUpdatePhase",
                    &[session, turn, a[2], a[3], s.get(c"_ports")?],
                )?,
                _ => owner::invoke(owner, c"heartbeatStop", &[session, turn])?,
            };
            if name == "touchVisible" || (name == "stop" && result.truthy()?) {
                call(s, c"_arm", &[])?;
            }
            Ok(result)
        }
        "status" => {
            let session = clean(a[0])?;
            if !session.truthy()? {
                return null(s);
            }
            let result = owner::invoke(
                s.get(c"_owner")?,
                c"heartbeatStatus",
                &[session, s.get(c"_ports")?],
            )?;
            if result.truthy()? {
                result.freeze()
            } else {
                null(s)
            }
        }
        "stopAll" => {
            let count = owner::invoke(s.get(c"_owner")?, c"heartbeatStopAll", &[])?;
            call(s, c"_disarm", &[])?;
            Ok(count)
        }
        "_timestamp" => {
            let timestamp = call(s, c"_now", &[])?.explicit_number()?;
            if !timestamp.is_finite() {
                return Err(s.type_error("now must return a finite number"));
            }
            num(s, timestamp)
        }
        "_clearTimer" => {
            if !s.get(c"_timer")?.nullish()? {
                call(s, c"_clearInterval", &[s.get(c"_timer")?])?;
                s.assign(c"_timer", null(s)?)?;
                s.assign(c"_timerDue", null(s)?)?;
            }
            undefined(s)
        }
        "_arm" => arm(s),
        "_disarm" => {
            call(s, c"_clearTimer", &[])?;
            undefined(s)
        }
        "_tick" => tick(s),
        _ => unreachable!(),
    }
}
unsafe extern "C" fn construct(
    env: sys::napi_env,
    info: sys::napi_callback_info,
) -> sys::napi_value {
    use std::ptr;
    let run = || -> Result<sys::napi_value> {
        let mut argc = 1usize;
        let mut arg = ptr::null_mut();
        let mut this = ptr::null_mut();
        napi::check_status!(sys::napi_get_cb_info(
            env,
            info,
            &mut argc,
            &mut arg,
            &mut this,
            ptr::null_mut()
        ))?;
        let this = L::from_raw(env, this);
        let mut target = ptr::null_mut();
        napi::check_status!(sys::napi_get_new_target(env, info, &mut target))?;
        if target.is_null() {
            return Err(this.type_error(
                "Class constructor TurnProgressHeartbeat cannot be invoked without 'new'",
            ));
        }
        let opts = if argc == 0 {
            fields(this, &[])?
        } else {
            options(L::from_raw(env, arg))?
        };
        init(this, opts)?;
        Ok(this.raw())
    };
    match run() {
        Ok(v) => v,
        Err(e) => {
            let mut pending = false;
            sys::napi_is_exception_pending(env, &mut pending);
            if !pending {
                napi::JsError::from(e).throw_into(env);
            }
            ptr::null_mut()
        }
    }
}
pub(super) fn class(root: L<'_>) -> Result<L<'_>> {
    let mut ctor = std::ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_create_function(
            root.env(),
            c"TurnProgressHeartbeat".as_ptr(),
            c"TurnProgressHeartbeat".to_bytes().len() as isize,
            Some(construct),
            std::ptr::null_mut(),
            &mut ctor,
        )
    })?;
    let ctor = L::from_raw(root.env(), ctor);
    let proto = ctor.get(c"prototype")?;
    let descriptor = fields(root, &[("writable", flag(root, false)?)])?;
    call(
        root.global()?.get(c"Object")?,
        c"defineProperty",
        &[ctor, text(root, "prototype")?, descriptor],
    )?;
    let object = root.global()?.get(c"Object")?;
    let env = Env::from_raw(root.env());
    for (name, length, count) in [
        ("start", 2, 3),
        ("touchVisible", 2, 2),
        ("touchActivity", 2, 2),
        ("updatePhase", 4, 4),
        ("stop", 2, 2),
        ("status", 1, 1),
        ("stopAll", 0, 0),
        ("_find", 2, 2),
        ("_timestamp", 0, 0),
        ("_clearTimer", 0, 0),
        ("_arm", 0, 0),
        ("_disarm", 0, 0),
        ("_tick", 0, 0),
    ] {
        let f = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            name,
            move |ctx| {
                let receiver = L::new(ctx.env, ctx.this()?);
                let missing = undefined(receiver)?;
                let mut args = Vec::with_capacity(count);
                for i in 0..count {
                    args.push(if i < ctx.length() {
                        L::new(ctx.env, ctx.get(i)?)
                    } else {
                        missing
                    });
                }
                Ok(run(name, receiver, &args)?.raw())
            },
        )?;
        let f = L::new(&env, f.into_unknown(&env)?);
        call(
            object,
            c"defineProperty",
            &[
                f,
                text(root, "length")?,
                fields(root, &[("value", num(root, length as f64)?)])?,
            ],
        )?;
        let descriptor = fields(
            root,
            &[
                ("value", f),
                ("writable", flag(root, true)?),
                ("configurable", flag(root, true)?),
            ],
        )?;
        call(
            object,
            c"defineProperty",
            &[proto, text(root, name)?, descriptor],
        )?;
    }
    Ok(ctor)
}
