use super::*;
use multicc_core::recurring::Expression;
pub(super) fn valid(expr: L<'_>) -> Result<bool> {
    Ok(Expression::parse(&strval(expr)?).is_some())
}
pub(super) fn next<'a>(p: L<'a>, expr: L<'a>, from: L<'a>) -> Result<L<'a>> {
    let Some(expr) = Expression::parse(&strval(expr)?) else {
        return null(p);
    };
    let ms = call(from, c"getTime", &[])?.number()?;
    if !ms.is_finite() || ms.abs() > 8_640_000_000_000_000. {
        return null(p);
    }
    let zone = super::timezone::snapshot(p, ms as i64, ms as i64 + 368 * super::timezone::DAY_MS)?;
    p.from_value(
        &expr
            .next_in(ms as i64, None, &zone)
            .map(|n| V::Number(n as f64))
            .unwrap_or(V::Null),
    )
}
pub(super) fn recent<'a>(
    p: L<'a>,
    task: L<'a>,
    limit: L<'a>,
    output_limit: L<'a>,
) -> Result<L<'a>> {
    let limit = if limit.undefined()? {
        num(p, 10.)?
    } else {
        limit
    };
    let output_limit = if output_limit.undefined()? {
        num(p, 2000.)?
    } else {
        output_limit
    };
    let runs = task.get(c"runs")?;
    let runs = if runs.is_array()? { runs } else { array(p)? };
    let reversed = call(slice(runs, -limit.number()?, None)?, c"reverse", &[])?;
    let f = fields(p, &[("outputLimit", output_limit)])?;
    call(
        reversed,
        c"map",
        &[function(f, "", 1, 1, |f, a| {
            let run = a[0];
            let output = run.get(c"output")?;
            if output.truthy()?
                && output.get(c"length")?.number()? > f.get(c"outputLimit")?.number()?
            {
                let copy = spread(run)?;
                copy.set(
                    c"output",
                    slice(output, -f.get(c"outputLimit")?.number()?, None)?,
                )?;
                Ok(copy)
            } else {
                Ok(run)
            }
        })?],
    )
}
pub(super) fn render<'a>(o: L<'a>, t: L<'a>) -> Result<L<'a>> {
    let d = deps(o)?;
    let dir = if d.truthy()? {
        call(d.get(c"directories")?, c"get", &[t.get(c"dirId")?])?
    } else {
        d
    };
    let summary = if t.get(c"taskId")?.truthy()? && d.optional(c"taskSummary")?.truthy()? {
        call(d, c"taskSummary", &[t.get(c"taskId")?])?
    } else {
        null(o)?
    };
    let script = t.get(c"kind")?.is_string("script")?;
    let binding_error = if script {
        text(o, "")?
    } else {
        either(
            t.get(c"taskBindingError")?,
            text(
                o,
                if summary.optional(c"readOnly")?.truthy()? {
                    "固定任务已归档或只读"
                } else {
                    ""
                },
            )?,
        )?
    };
    let v = fields(o, &[])?;
    for k in [c"id", c"name", c"dirId"] {
        v.set(k, t.get(k)?)?;
    }
    v.set(
        c"dirName",
        if dir.truthy()? {
            dir.get(c"name")?
        } else {
            text(o, "(已删除)")?
        },
    )?;
    v.set(c"kind", either(t.get(c"kind")?, text(o, "agent")?)?)?;
    v.set(c"command", either(t.get(c"command")?, text(o, "")?)?)?;
    v.set(
        c"scriptTimeoutMs",
        either(t.get(c"scriptTimeoutMs")?, null(o)?)?,
    )?;
    v.set(
        c"cli",
        if script {
            null(o)?
        } else {
            either(
                summary.optional(c"runtime")?.optional(c"cli")?,
                either(t.get(c"cli")?, text(o, "claude")?)?,
            )?
        },
    )?;
    for k in [c"provider", c"model", c"effort"] {
        v.set(
            k,
            if script {
                null(o)?
            } else {
                either(summary.optional(c"runtime")?.optional(k)?, null(o)?)?
            },
        )?;
    }
    v.set(
        c"prompt",
        if script {
            text(o, "")?
        } else {
            t.get(c"prompt")?
        },
    )?;
    v.set(c"cron", t.get(c"cron")?)?;
    v.set(c"enabled", flag(o, t.get(c"enabled")?.truthy()?)?)?;
    v.set(
        c"createdBy",
        either(t.get(c"createdBy")?, text(o, "user")?)?,
    )?;
    v.set(c"createdAt", t.get(c"createdAt")?)?;
    for k in [c"lastRunAt", c"lastStatus"] {
        v.set(k, either(t.get(k)?, null(o)?)?)?;
    }
    v.set(c"lastError", either(t.get(c"lastError")?, text(o, "")?)?)?;
    v.set(
        c"lastSessionId",
        either(
            t.get(c"taskSessionId")?,
            either(t.get(c"lastSessionId")?, null(o)?)?,
        )?,
    )?;
    v.set(
        c"lastExitCode",
        if script && !t.get(c"lastExitCode")?.undefined()? {
            t.get(c"lastExitCode")?
        } else {
            null(o)?
        },
    )?;
    v.set(
        c"lastOutput",
        if script && t.get(c"lastOutput")?.truthy()? {
            slice(string(t.get(c"lastOutput")?)?, -400., None)?
        } else {
            text(o, "")?
        },
    )?;
    v.set(
        c"taskId",
        if script {
            null(o)?
        } else {
            either(t.get(c"taskId")?, null(o)?)?
        },
    )?;
    v.set(
        c"taskTitle",
        if script {
            null(o)?
        } else {
            either(summary.optional(c"title")?, t.get(c"name")?)?
        },
    )?;
    v.set(
        c"taskStatus",
        if script {
            null(o)?
        } else {
            either(
                summary.optional(c"status")?,
                text(
                    o,
                    if t.get(c"taskId")?.truthy()? {
                        "unknown"
                    } else {
                        "binding"
                    },
                )?,
            )?
        },
    )?;
    v.set(
        c"taskReadOnly",
        flag(o, summary.optional(c"readOnly")?.is_true()?)?,
    )?;
    v.set(c"taskBindingError", binding_error)?;
    v.set(
        c"taskBindingBroken",
        flag(o, !script && binding_error.truthy()?)?,
    )?;
    v.set(
        c"taskBindingBrokenAt",
        either(t.get(c"taskBindingBrokenAt")?, null(o)?)?,
    )?;
    v.set(
        c"taskRebindHistory",
        if t.get(c"taskRebindHistory")?.is_array()? {
            t.get(c"taskRebindHistory")?
        } else {
            array(o)?
        },
    )?;
    v.set(
        c"taskUrl",
        if t.get(c"taskId")?.truthy()? {
            let encode = o.global()?.get(c"encodeURIComponent")?;
            text(
                o,
                &format!(
                    "/air?task={}&dir={}",
                    strval(encode.call_plain(&[t.get(c"taskId")?])?)?,
                    strval(encode.call_plain(&[t.get(c"dirId")?])?)?
                ),
            )?
        } else {
            null(o)?
        },
    )?;
    for k in [c"lastReceiptId", c"lastDecision"] {
        v.set(k, either(t.get(k)?, null(o)?)?)?;
    }
    v.set(c"runCount", either(t.get(c"runCount")?, num(o, 0.)?)?)?;
    v.set(c"recentRuns", recent(o, t, num(o, 10.)?, num(o, 400.)?)?)?;
    v.set(
        c"nextRunAt",
        if t.get(c"enabled")?.truthy()? {
            next(
                o,
                t.get(c"cron")?,
                o.global()?.get(c"Date")?.construct(&[])?,
            )?
        } else {
            null(o)?
        },
    )?;
    Ok(v)
}
pub(super) fn sanitize<'a>(o: L<'a>, body: L<'a>, existing: L<'a>) -> Result<L<'a>> {
    let out = spread(existing)?;
    if !body.get(c"kind")?.undefined()? {
        out.set(
            c"kind",
            text(
                o,
                if body.get(c"kind")?.is_string("script")? {
                    "script"
                } else {
                    "agent"
                },
            )?,
        )?;
    }
    for (k, limit, trim) in [
        (c"command", 4000., true),
        (c"name", 80., true),
        (c"createdBy", 80., false),
    ] {
        if !body.get(k)?.undefined()? {
            let s = string(body.get(k)?)?;
            let s = if trim { call(s, c"trim", &[])? } else { s };
            out.set(k, slice(s, 0., Some(limit))?)?;
        }
    }
    if !body.get(c"scriptTimeoutMs")?.undefined()? {
        let ms = body.get(c"scriptTimeoutMs")?.explicit_number()?.floor();
        out.set(
            c"scriptTimeoutMs",
            if ms.is_finite() && ms > 0. {
                num(o, ms.min(3_600_000.))?
            } else {
                null(o)?
            },
        )?;
    }
    let mut dir = undefined(o)?;
    if !body.get(c"dirId")?.undefined()? {
        dir = string(body.get(c"dirId")?)?;
        out.set(c"dirId", dir)?;
    }
    if !dir.truthy()? && body.get(c"dirPath")?.truthy()? {
        let path = ports(o)?.get(c"path")?;
        let abs = call(path, c"resolve", &[string(body.get(c"dirPath")?)?])?;
        call(deps(o)?.get(c"directories")?, c"values", &[])?.for_each_while(|d| {
            if call(path, c"resolve", &[d.get(c"path")?])?.equals(abs)? {
                out.set(c"dirId", d.get(c"id")?)?;
                return Ok(false);
            }
            Ok(true)
        })?;
    }
    if !body.get(c"cli")?.undefined()? {
        out.set(
            c"cli",
            either(
                slice(
                    call(
                        string(either(body.get(c"cli")?, text(o, "")?)?)?,
                        c"trim",
                        &[],
                    )?,
                    0.,
                    Some(40.),
                )?,
                text(o, "claude")?,
            )?,
        )?;
    }
    if !body.get(c"prompt")?.undefined()? {
        out.set(c"prompt", string(body.get(c"prompt")?)?)?;
    }
    if !body.get(c"cron")?.undefined()? {
        out.set(c"cron", call(string(body.get(c"cron")?)?, c"trim", &[])?)?;
    }
    if !body.get(c"enabled")?.undefined()? {
        out.set(c"enabled", flag(o, body.get(c"enabled")?.truthy()?)?)?;
    }
    Ok(out)
}
pub(super) fn validate(o: L<'_>, t: L<'_>) -> Result<Option<&'static str>> {
    if !t.get(c"name")?.truthy()? {
        return Ok(Some("任务名不能为空"));
    }
    if !t.get(c"dirId")?.truthy()?
        || !call(deps(o)?.get(c"directories")?, c"get", &[t.get(c"dirId")?])?.truthy()?
    {
        return Ok(Some("目标目录无效"));
    }
    if t.get(c"kind")?.is_string("script")? {
        if !t.get(c"command")?.truthy()? || !call(t.get(c"command")?, c"trim", &[])?.truthy()? {
            return Ok(Some("脚本命令不能为空"));
        }
    } else {
        let clis = deps(o)?.get(c"clis")?;
        if clis.optional(c"length")?.truthy()?
            && !call(
                clis,
                c"includes",
                &[either(t.get(c"cli")?, text(o, "claude")?)?],
            )?
            .truthy()?
        {
            return Ok(Some("CLI 无效"));
        }
        if !t.get(c"prompt")?.truthy()? || !call(t.get(c"prompt")?, c"trim", &[])?.truthy()? {
            return Ok(Some("prompt 不能为空"));
        }
    }
    if !valid(either(t.get(c"cron")?, text(o, "")?)?)? {
        return Ok(Some("cron 表达式无效（需 5 段：分 时 日 月 周）"));
    }
    Ok(None)
}
