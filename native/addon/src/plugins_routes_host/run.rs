use super::*;

pub(super) fn outcome<'a>(p: L<'a>, status: i32, payload: L<'a>) -> Result<L<'a>> {
    fields(
        p,
        &[("status", num(p, status as f64)?), ("payload", payload)],
    )
}
fn failure<'a>(p: L<'a>, status: i32, why: &str) -> Result<L<'a>> {
    outcome(p, status, fields(p, &[("error", text(p, why)?)])?)
}
fn finish<'a>(c: L<'a>, result: L<'a>) -> Result<L<'a>> {
    if c.get(c"settled")?.truthy()? {
        return undef(c);
    }
    c.set(c"settled", flag(c, true)?)?;
    c.global()?
        .get(c"clearTimeout")?
        .call_plain(&[c.get(c"timer")?])?;
    c.get(c"resolve")?.call_plain(&[result])
}
fn close<'a>(c: L<'a>, code: L<'a>) -> Result<L<'a>> {
    let text = call(c.get(c"stdout")?, c"trim", &[])?;
    let result = if !text.truthy()? {
        failure(
            c,
            502,
            &format!("插件没有返回结果（退出码 {}）", fold_string(code)?),
        )?
    } else if let Some(parsed) = c.catch(|| json_call(c, c"parse", text))? {
        if parsed.truthy()? && parsed.get(c"ok")?.is_true()? {
            let data = parsed.get(c"data")?;
            outcome(
                c,
                200,
                if data.nullish()? {
                    fields(c, &[])?
                } else {
                    data
                },
            )?
        } else {
            let detail = parsed.optional(c"error")?;
            if detail.truthy()? {
                outcome(c, 400, fields(c, &[("error", detail)])?)?
            } else {
                failure(
                    c,
                    400,
                    &format!("插件命令失败（退出码 {}）", fold_string(code)?),
                )?
            }
        }
    } else {
        failure(c, 502, "插件输出不是 JSON")?
    };
    finish(c, result)
}
fn warn_stdin<'a>(c: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let o = c.get(c"owner")?;
    call(
        o.get(c"logger")?,
        c"warn",
        &[
            text(c, "plugin_stdin_failed")?,
            fields(
                c,
                &[
                    ("id", c.get(c"id")?),
                    ("command", c.get(c"command")?),
                    ("error", error.get(c"message")?),
                ],
            )?,
        ],
    )?;
    undef(c)
}
fn observe<'a>(c: L<'a>, resolve: L<'a>) -> Result<L<'a>> {
    let child = c.get(c"child")?;
    c.set(c"resolve", resolve)?;
    c.set(c"stdout", text(c, "")?)?;
    let timer = c.global()?.get(c"setTimeout")?.call_plain(&[
        function(c, "", 0, 0, |c, _| {
            call(c.get(c"child")?, c"kill", &[text(c, "SIGKILL")?])?;
            finish(
                c,
                failure(
                    c,
                    504,
                    &format!("插件命令 {} 超时（20s）", fold_string(c.get(c"command")?)?),
                )?,
            )
        })?,
        num(c, 20000.)?,
    ])?;
    c.set(c"timer", timer)?;
    call(
        child.get(c"stdout")?,
        c"on",
        &[
            text(c, "data")?,
            function(c, "", 1, 1, |c, a| {
                let s = c.get(c"stdout")?;
                if s.get(c"length")?.number()? < 4. * 1024. * 1024. {
                    c.set(c"stdout", call(s, c"concat", &[a[0]])?)?
                }
                undef(c)
            })?,
        ],
    )?;
    call(
        child,
        c"on",
        &[
            text(c, "error")?,
            function(c, "", 1, 1, |c, a| {
                finish(
                    c,
                    failure(
                        c,
                        500,
                        &format!("插件进程出错：{}", fold_string(a[0].get(c"message")?)?),
                    )?,
                )
            })?,
        ],
    )?;
    call(
        child,
        c"on",
        &[
            text(c, "close")?,
            function(c, "", 1, 1, |c, a| close(c, a[0]))?,
        ],
    )?;
    let stdin = child.get(c"stdin")?;
    call(
        stdin,
        c"on",
        &[
            text(c, "error")?,
            function(c, "", 1, 1, |c, a| warn_stdin(c, a[0]))?,
        ],
    )?;
    let input = c.get(c"input")?;
    let sending = (|| -> Result<L<'_>> {
        call(
            stdin,
            c"end",
            &[json_call(
                c,
                c"stringify",
                if input.nullish()? {
                    fields(c, &[])?
                } else {
                    input
                },
            )?],
        )
    })();
    if let Err(err) = sending {
        warn_stdin(c, message(c, err)?)?;
    }
    undef(c)
}
pub(super) fn command<'a>(o: L<'a>, id: L<'a>, cmd: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let ctx = fields(
        o,
        &[("owner", o), ("id", id), ("command", cmd), ("input", input)],
    )?;
    then(discover::scan_async(o)?, ctx, |ctx, a| {
        let o = ctx.get(c"owner")?;
        let id = ctx.get(c"id")?;
        let cmd = ctx.get(c"command")?;
        let input = ctx.get(c"input")?;
        let plugins = a[0].get(c"plugins")?;
        let mut entry = None;
        for item in items(plugins)? {
            if item.get(c"id")?.equals(id)? {
                entry = Some(item);
                break;
            }
        }
        let name = fold_string(id)?;
        let Some(entry) = entry else {
            return failure(o, 404, &format!("插件 {name} 不存在"));
        };
        let command = fold_string(cmd)?;
        if !command
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            || !command
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return failure(o, 400, "命令名不合法");
        }
        if !call(entry.get(c"commands")?, c"includes", &[cmd])?.truthy()? {
            return failure(
                o,
                400,
                &format!("命令 {command} 不在插件 {name} 的白名单里"),
            );
        }
        let host = o.get(c"channelHost")?;
        if host.truthy()? && call(host, c"isResident", &[id])?.truthy()? {
            return call(host, c"run", &[id, cmd, input]);
        }
        let ports = o.get(c"ports")?;
        let found = discover::find(o, id)?;
        let bin = discover::binary(ports, found, o.get(c"platform")?, o.get(c"arch")?)?;
        if !bin.truthy()? {
            return failure(
                o,
                503,
                &format!(
                    "插件 {name} 的二进制不可用（{}）",
                    fold_string(entry.get(c"engine")?.get(c"reason")?)?
                ),
            );
        }
        let argv = array(o)?;
        push(argv, cmd)?;
        let opts = fields(o, &[("stdio", strings(o, &["pipe", "pipe", "pipe"])?)])?;
        let child = match ports.get(c"spawn")?.call_plain(&[bin, argv, opts]) {
            Ok(child) => child,
            Err(err) => {
                let e = message(o, err)?;
                return failure(
                    o,
                    500,
                    &format!("启动插件进程失败：{}", fold_string(e.get(c"message")?)?),
                );
            }
        };
        let c = fields(
            o,
            &[
                ("owner", o),
                ("id", id),
                ("command", cmd),
                ("input", input),
                ("child", child),
            ],
        )?;
        o.global()?
            .get(c"Promise")?
            .construct(&[function(c, "", 2, 2, |c, a| observe(c, a[0]))?])
    })
}
