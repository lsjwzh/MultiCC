//! JS values shared by the three print-mode clients. Preserve UTF-16 prompts,
//! injected callbacks and per-run completion state at the addon boundary.
pub(super) use crate::host_api::*;
use std::ffi::CStr;

pub(super) fn port<'a>(p: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    p.get(name)?.call_plain(args)
}

pub(super) fn or<'a>(v: L<'a>, next: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        next()
    }
}

pub(super) fn strings<'a>(p: L<'a>, args: &[&str]) -> Result<L<'a>> {
    let list = array(p)?;
    for s in args {
        call(list, c"push", &[text(p, s)?])?;
    }
    Ok(list)
}

pub(super) fn push<'a>(list: L<'a>, values: &[L<'a>]) -> Result<()> {
    call(list, c"push", values)?;
    Ok(())
}

pub(super) fn option<'a>(list: L<'a>, key: &str, value: L<'a>) -> Result<()> {
    if value.truthy()? {
        push(list, &[text(list, key)?, value])?;
    }
    Ok(())
}

pub(super) fn command<'a>(s: L<'a>, args: L<'a>, payload: L<'a>) -> Result<L<'a>> {
    fields(
        s,
        &[
            ("cmd", s.get(c"cmd")?),
            ("args", args),
            ("payload", payload),
        ],
    )
}

pub(super) fn prompt<'a>(p: L<'a>, envelope: L<'a>, first: L<'a>) -> Result<L<'a>> {
    let rendered = port(p, c"renderPrompt", &[envelope])?;
    if first.truthy()? && envelope.get(c"rolePrompt")?.truthy()? {
        call(
            text(p, "[Role prompt]\n")?,
            c"concat",
            &[
                envelope.get(c"rolePrompt")?,
                text(p, "\n[End of role prompt]\n\n")?,
                rendered,
            ],
        )
    } else {
        Ok(rendered)
    }
}

pub(super) fn quote(value: L<'_>) -> Result<L<'_>> {
    let escaped = call(
        string(value)?,
        c"replaceAll",
        &[text(value, "'")?, text(value, "'\"'\"'")?],
    )?;
    let mark = text(value, "'")?;
    call(mark, c"concat", &[escaped, mark])
}

pub(super) fn row<'a>(p: L<'a>, kind: &str, values: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let row = fields(p, &[("type", text(p, kind)?)])?;
    for &(key, value) in values {
        row.define_key(text(p, key)?, value)?;
    }
    Ok(row)
}

pub(super) fn single(v: L<'_>) -> Result<L<'_>> {
    let out = array(v)?;
    push(out, &[v])?;
    Ok(out)
}

pub(super) fn tracker<'a>(
    p: L<'a>,
    class: &CStr,
    context: L<'a>,
    observe: Action,
    close: Action,
) -> Result<L<'a>> {
    let native = port(p, c"getNative", &[])?.get(class)?.construct(&[])?;
    let owner = fields(p, &[("native", native), ("context", context)])?;
    let hooks = fields(
        p,
        &[
            ("observe", function(owner, "observe", 1, 1, observe)?),
            ("close", function(owner, "close", 3, 3, close)?),
        ],
    )?;
    port(p, c"createCompletionTracker", &[hooks])
}
