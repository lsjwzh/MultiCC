use super::*;

fn file(p: L<'_>) -> Result<L<'_>> {
    let raw = async_result(p, || {
        p.get(c"readFile")?
            .call_plain(&[p.get(c"credentialsFile")?])
    })?;
    let parsed = then(raw, p, |p, a| {
        let value = parse::credentials(a[0])?;
        value.set(c"store", text(p, "file")?)?;
        Ok(value)
    })?;
    recover(parsed, p, |p, _| {
        fields(
            p,
            &[
                ("ok", flag(p, false)?),
                ("reason", text(p, "unreadable")?),
                (
                    "store",
                    text(
                        p,
                        if p.get(c"platform")?.is_string("darwin")? {
                            "keychain"
                        } else {
                            "file"
                        },
                    )?,
                ),
            ],
        )
    })
}
pub(super) fn read(p: L<'_>) -> Result<L<'_>> {
    async_result(p, || {
        if !p.get(c"platform")?.is_string("darwin")? {
            return file(p);
        }
        let args = strings(p, &["find-generic-password", "-s"])?;
        push(args, p.get(c"keychainService")?)?;
        push(args, text(p, "-w")?)?;
        let result = p.get(c"run")?.call_plain(&[
            text(p, "security")?,
            args,
            fields(p, &[("timeoutMs", num(p, 10_000.)?)])?,
        ])?;
        then(result, p, |p, a| {
            if a[0].get(c"code")?.is_number(0.)? {
                let value = parse::credentials(a[0].get(c"stdout")?)?;
                if value.get(c"ok")?.truthy()? {
                    value.set(c"store", text(p, "keychain")?)?;
                    return Ok(value);
                }
            }
            file(p)
        })
    })
}
pub(super) fn environment(p: L<'_>) -> Result<L<'_>> {
    let opts = p.get(c"options")?;
    if callable(opts.get(c"buildEnv")?)? {
        return call(opts, c"buildEnv", &[]);
    }
    let built = p.get(c"buildChildEnv")?.call_plain(&[
        p.get(c"process")?.get(c"env")?,
        fields(p, &[("cli", text(p, "claude")?), ("provider", null(p)?)])?,
    ])?;
    let env = spread(built.get(c"env")?)?;
    env.delete(c"CLAUDE_CODE_OAUTH_TOKEN")?;
    let extra = opts.get(c"extraEnv")?;
    if extra.truthy()? {
        call(p.global()?.get(c"Object")?, c"entries", &[extra])?.for_each(|entry| {
            let key = entry.element(0)?;
            let v = entry.element(1)?;
            if v.nullish()? {
                call(p.global()?.get(c"Reflect")?, c"deleteProperty", &[env, key])?;
            } else {
                env.set_key(key, string(v)?)?;
            }
            Ok(())
        })?;
    }
    Ok(env)
}
pub(super) fn run<'a>(ctx: L<'a>, probe: bool) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let args = if probe {
        let args = strings(p, &["-p", "ok", "--max-turns", "1", "--model"])?;
        push(args, p.get(c"model")?)?;
        for s in ["--strict-mcp-config", "--no-session-persistence"] {
            push(args, text(p, s)?)?;
        }
        args
    } else {
        strings(p, &["auth", "status", "--json"])?
    };
    let opts = fields(
        p,
        &[
            ("timeoutMs", p.get(c"commandTimeoutMs")?),
            ("cwd", p.get(c"cwd")?),
            ("env", ctx.get(c"env")?),
        ],
    )?;
    p.get(c"run")?
        .call_plain(&[p.get(c"claudeBin")?, args, opts])
}
