use crate::route_response::*;
use napi_derive::napi;

fn state<'a>(p: L<'a>, value: &str) -> Result<L<'a>> {
    fields(p, &[("state", text(p, value)?)])
}
fn unavailable<'a>(p: L<'a>, detail: L<'a>) -> Result<L<'a>> {
    fields(p, &[("state", text(p, "unavailable")?), ("detail", detail)])
}
fn spawn_detail(error: L<'_>) -> Result<L<'_>> {
    let detail = if !error.truthy()? {
        "bad-reply"
    } else if error.get(c"code")?.is_string("EACCES")? {
        "agent-not-executable"
    } else if error.get(c"code")?.is_string("ENOENT")? {
        "agent-not-installed"
    } else {
        "agent-error"
    };
    text(error, detail)
}

#[napi]
pub fn unlock_desktop_reply(
    env: Env,
    reply: Unknown<'_>,
    error: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, reply);
    let err = L::new(&env, error);
    let value = if err.truthy()? || !p.optional(c"ok")?.is_true()? {
        unavailable(p, spawn_detail(err)?)?
    } else {
        let a = p.get(c"accessibility")?.is_true()?;
        let s = p.get(c"screenRecording")?.is_true()?;
        if a && s {
            state(p, "authorized")?
        } else {
            let permissions = fields(
                p,
                &[
                    ("accessibility", flag(p, a)?),
                    ("screenRecording", flag(p, s)?),
                ],
            )?;
            fields(p,&[("state",text(p,"permissions-required")?),("permissions",permissions),("message",text(p,"请先在这台 Mac 的系统设置中，为 MultiCC Agent 开启辅助功能和屏幕录制权限；这两项是自动解锁的前置条件。")?)])?
        }
    };
    Ok(value.raw())
}
#[napi]
pub fn unlock_probe_reply(
    env: Env,
    reply: Unknown<'_>,
    error: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, reply);
    let value = if p.kind()? != sys::ValueType::napi_object {
        unavailable(p, spawn_detail(L::new(&env, error))?)?
    } else if p.get(c"authorized")?.is_true()? {
        if p.get(c"powerProtocol")?.is_number(1.)? {
            state(p, "authorized")?
        } else {
            unavailable(p, text(p, "agent-update-required")?)?
        }
    } else if p.get(c"reason")?.is_string("no-password")? {
        state(p, "no-password")?
    } else if p.get(c"reason")?.is_string("waiting-for-user")? {
        state(p, "waiting-for-user")?
    } else {
        let reason = p.get(c"reason")?;
        let reason = if reason.truthy()? {
            reason
        } else {
            fallback(p.get(c"error")?, "agent-error".into())?
        };
        unavailable(p, string(reason)?)?
    };
    Ok(value.raw())
}

#[napi]
pub fn unlock_probe_command(env: Env, method: String, ui: Unknown<'_>) -> Result<sys::napi_value> {
    let v = L::new(&env, ui);
    let (args, timeout) = match method.as_str() {
        "status" => (vec!["status"], 3000.),
        "ping" => (vec!["ping"], 3000.),
        _ => {
            let mut args = vec!["probe-unlock", "8"];
            if v.truthy()? {
                args.push("--allow-ui");
            }
            (args, 10000.)
        }
    };
    Ok(fields(
        v,
        &[
            (
                "args",
                v.from_value(&V::Array(args.into_iter().map(V::from).collect()))?,
            ),
            ("timeout", num(v, timeout)?),
        ],
    )?
    .raw())
}
