use super::*;

pub(super) fn environment(p: L<'_>) -> Result<L<'_>> {
    let custom = p.get(c"buildEnv")?;
    if callable(custom)? {
        return custom.call_plain(&[]);
    }
    let provider = p.get(c"providerPorts")?.call_plain(&[])?;
    let opts = fields(p, &[("cli", text(p, "codex")?), ("provider", null(p)?)])?;
    stripped(call(provider, c"buildChildEnv", &[env(p)?, opts])?.get(c"env")?)
}
pub(super) fn run<'a>(p: L<'a>, args: L<'a>, env: L<'a>) -> Result<L<'a>> {
    let file = p.get(c"codexBin")?;
    let timeout = p.get(c"commandTimeoutMs")?;
    let cwd = p.get(c"cwd")?;
    let opts = fields(
        p,
        &[
            ("timeoutMs", timeout),
            ("cwd", cwd),
            ("env", env),
            ("input", text(p, "")?),
        ],
    )?;
    let custom = p.get(c"run")?;
    if callable(custom)? {
        return custom.call_plain(&[file, args, opts]);
    }
    let options = fields(
        p,
        &[
            ("cwd", cwd),
            ("env", env),
            ("input", text(p, "")?),
            ("timeout", timeout),
            ("killSignal", text(p, "SIGKILL")?),
            ("maxBuffer", num(p, 1048576.)?),
            ("windowsHide", flag(p, true)?),
        ],
    )?;
    let ctx = fields(
        p,
        &[
            ("execFile", p.get(c"execFile")?),
            ("file", file),
            ("args", args),
            ("options", options),
        ],
    )?;
    let executor = function(ctx, "run", 2, 2, |ctx, a| {
        let cb = function(a[0], "completed", 3, 3, |resolve, a| {
            let err = a[0];
            let code = if !err.truthy()? {
                num(resolve, 0.)?
            } else {
                let code = err.get(c"code")?;
                let number = resolve.global()?.get(c"Number")?;
                if call(number, c"isInteger", &[code])?.truthy()? {
                    code
                } else {
                    num(resolve, 1.)?
                }
            };
            let result = fields(
                resolve,
                &[
                    ("code", code),
                    ("stdout", clean(a[1])?),
                    ("stderr", clean(a[2])?),
                    (
                        "timedOut",
                        flag(resolve, err.truthy()? && err.get(c"killed")?.truthy()?)?,
                    ),
                    (
                        "error",
                        if err.truthy()? {
                            err.get(c"message")?
                        } else {
                            null(resolve)?
                        },
                    ),
                ],
            )?;
            resolve.call_plain(&[result])
        })?;
        ctx.get(c"execFile")?.call_plain(&[
            ctx.get(c"file")?,
            ctx.get(c"args")?,
            ctx.get(c"options")?,
            cb,
        ])?;
        undef(ctx)
    })?;
    p.global()?.get(c"Promise")?.construct(&[executor])
}
