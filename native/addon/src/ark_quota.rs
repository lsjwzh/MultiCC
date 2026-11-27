use crate::route_response::*;
use multicc_core::{ark_quota as core, js::JsString};
use napi_derive::napi;

fn parse(p: L<'_>) -> Result<L<'_>> {
    let s = p.coerce_string()?;
    if let Some(range) = core::object_range(s.as_units()) {
        let data = p.from_value(&V::String(s.slice_units(range.start, range.end)))?;
        if let Some(parsed) = p.catch(|| call(p.global()?.get(c"JSON")?, c"parse", &[data]))? {
            return Ok(parsed);
        }
    }
    null(p)
}
#[napi]
pub fn arkcli_json(env: Env, source: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(parse(L::new(&env, source))?.raw())
}
fn finite(p: L<'_>, n: f64) -> Result<L<'_>> {
    if n.is_finite() {
        num(p, n)
    } else {
        null(p)
    }
}
fn period(p: L<'_>) -> Result<L<'_>> {
    let reset = p.get(c"reset_at")?;
    let n = if reset.kind()? == sys::ValueType::napi_string {
        call(p.global()?.get(c"Date")?, c"parse", &[reset])?.number()?
    } else {
        reset.explicit_number()?
    };
    fields(
        p,
        &[
            ("label", string(fallback(p.get(c"label")?, "".into())?)?),
            ("used", finite(p, p.get(c"used")?.explicit_number()?)?),
            ("total", finite(p, p.get(c"total")?.explicit_number()?)?),
            ("percent", finite(p, p.get(c"percent")?.explicit_number()?)?),
            ("resetAt", finite(p, n)?),
        ],
    )
}
fn map_objects<'a>(p: L<'a>, f: fn(L<'a>) -> Result<L<'a>>) -> Result<L<'a>> {
    let out = p.from_value(&V::Array(vec![]))?;
    if p.is_array()? {
        p.for_each(|v| {
            if v.kind()? == sys::ValueType::napi_object {
                call(out, c"push", &[f(v)?])?;
            }
            Ok(())
        })?;
    }
    Ok(out)
}
fn item(p: L<'_>) -> Result<L<'_>> {
    let optional = |k| {
        let v = p.get(k)?;
        if v.truthy()? {
            string(v)
        } else {
            null(p)
        }
    };
    fields(
        p,
        &[
            ("product", string(fallback(p.get(c"product")?, "".into())?)?),
            ("edition", string(fallback(p.get(c"edition")?, "".into())?)?),
            ("tier", optional(c"tier")?),
            ("seatId", optional(c"seat_id")?),
            ("subscribed", flag(p, p.get(c"subscribed")?.is_true()?)?),
            ("error", optional(c"error")?),
            ("periods", map_objects(p.get(c"periods")?, period)?),
        ],
    )
}
fn failure<'a>(p: L<'a>, status: &str, message: L<'a>) -> Result<L<'a>> {
    fields(p, &[("status", text(p, status)?), ("error", message)])
}
#[napi]
pub fn ark_quota_result(env: Env, rs: Unknown<'_>, at: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, rs);
    let err = p.get(c"err")?;
    let stderr = p.get(c"stderr")?;
    let mut parsed = parse(p.get(c"stdout")?)?;
    if parsed.nullish()? {
        parsed = parse(stderr)?;
    }
    let result = if parsed.nullish()? {
        if err.optional(c"code")?.is_string("ENOENT")? {
            failure(p, "needs_install", text(p, "arkcli not found on PATH")?)?
        } else {
            let msg = if stderr.truthy()? {
                stderr
            } else {
                fallback(err.optional(c"message")?, "no output".into())?
            };
            failure(
                p,
                "unavailable",
                call(msg, c"slice", &[num(p, 0.)?, num(p, 300.)?])?,
            )?
        }
    } else if parsed.get(c"ok")?.is_false()? {
        let msg = fallback(
            parsed.get(c"error")?.optional(c"message")?,
            "unknown error".into(),
        )?;
        let s = msg.coerce_string()?;
        if core::needs_auth(&s.as_str_lossy())
            || core::needs_auth(&stderr.coerce_string()?.as_str_lossy())
        {
            let msg = JsString::concat(&[
                &JsString::from("需要先运行 arkcli auth login 登录火山账号后再查询（"),
                &s,
                &JsString::from("）"),
            ]);
            failure(p, "needs_auth", p.from_value(&V::String(msg))?)?
        } else {
            failure(p, "unavailable", msg)?
        }
    } else if !parsed.get(c"items")?.is_array()? {
        failure(p, "unavailable", text(p, "items missing")?)?
    } else {
        let viewer = parsed.get(c"viewer")?;
        fields(
            p,
            &[
                ("status", text(p, "ok")?),
                ("fetchedAt", L::new(&env, at)),
                (
                    "viewer",
                    if viewer.kind()? == sys::ValueType::napi_object {
                        viewer
                    } else {
                        null(p)?
                    },
                ),
                ("items", map_objects(parsed.get(c"items")?, item)?),
            ],
        )?
    };
    Ok(result.raw())
}

use crate::host_methods::{arg, env as host_env, function, raw};
fn ark_bin(p: L<'_>) -> Result<L<'_>> {
    let old = p.get(c"bin")?;
    if old.truthy()? {
        return Ok(old);
    }
    let ports = p.get(c"ports")?;
    let env = ports.get(c"env")?;
    let cmd = if env.get(c"ARKCLI_BIN")?.truthy()? {
        env.get(c"ARKCLI_BIN")?
    } else {
        call(ports, c"find", &[text(p, "arkcli")?])?
    };
    if !cmd.truthy()? {
        return null(p);
    }
    let bin = fields(
        p,
        &[("cmd", cmd), ("prefix", p.from_value(&V::Array(vec![]))?)],
    )?;
    p.set(c"bin", bin)?;
    Ok(bin)
}
fn ark_options(p: L<'_>, timeout: f64) -> Result<L<'_>> {
    fields(
        p,
        &[
            ("windowsHide", flag(p, true)?),
            ("timeout", num(p, timeout)?),
            ("maxBuffer", num(p, 8388608.)?),
            ("encoding", text(p, "utf8")?),
        ],
    )
}
#[napi]
pub fn ark_cli_owner(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let v = L::new(&env, ports);
    let p = fields(v, &[("ports", v), ("bin", null(v)?)])?;
    let resolve = function(p, "resolveArkcliBin", 0, 0, |p, _| ark_bin(p))?;
    let usage = function(p, "usagePlan", 0, 0, |p, _| {
        let bin = ark_bin(p)?;
        if !bin.truthy()? {
            return null(p);
        }
        let args = p.from_value(&V::Array(vec![]))?;
        bin.get(c"prefix")?.for_each(|v| {
            call(args, c"push", &[v])?;
            Ok(())
        })?;
        for a in ["usage", "plan", "--format", "json"] {
            call(args, c"push", &[text(p, a)?])?;
        }
        fields(
            p,
            &[
                ("cmd", bin.get(c"cmd")?),
                ("args", args),
                ("options", ark_options(p, 45000.)?),
            ],
        )
    })?;
    let install = function(p, "installation", 0, 0, |p, _| {
        let npm = call(p.get(c"ports")?, c"find", &[text(p, "npm")?])?;
        if !npm.truthy()? {
            return fields(p,&[("ok",flag(p,false)?),("error",text(p,"未找到 npm，无法自动安装。请手动安装 Node.js 后重试，或自行安装 @volcengine/ark-cli。")?)]);
        }
        fields(
            p,
            &[
                ("cmd", npm),
                (
                    "args",
                    p.from_value(&V::Array(
                        ["install", "-g", "@volcengine/ark-cli"]
                            .into_iter()
                            .map(V::from)
                            .collect(),
                    ))?,
                ),
                ("options", ark_options(p, 240000.)?),
            ],
        )
    })?;
    let installed = function(p, "installed", 1, 1, |p, a| {
        let result = a[0];
        let err = result.get(c"err")?;
        if err.truthy()? {
            let stderr = result.get(c"stderr")?;
            let msg = if stderr.truthy()? {
                stderr
            } else {
                fallback(err.get(c"message")?, "".into())?
            };
            let lines = call(call(msg, c"trim", &[])?, c"split", &[text(p, "\n")?])?;
            let detail = call(
                call(lines, c"slice", &[num(p, 0.)?, num(p, 3.)?])?,
                c"join",
                &[text(p, " ")?],
            )?;
            let m = JsString::concat(&[
                &"npm install -g @volcengine/ark-cli 失败：".into(),
                &fallback(detail, "未知错误".into())?.coerce_string()?,
            ]);
            return fields(
                p,
                &[
                    ("ok", flag(p, false)?),
                    ("error", p.from_value(&V::String(m))?),
                ],
            );
        }
        p.set(c"bin", null(p)?)?;
        fields(p, &[("ok", flag(p, true)?)])
    })?;
    let finish = function(p, "result", 2, 2, |p, a| {
        Ok(raw(
            p,
            ark_quota_result(host_env(p), arg(a[0])?, arg(a[1])?)?,
        ))
    })?;
    Ok(fields(
        p,
        &[
            ("resolveArkcliBin", resolve),
            ("usagePlan", usage),
            ("installation", install),
            ("installed", installed),
            ("result", finish),
        ],
    )?
    .raw())
}
