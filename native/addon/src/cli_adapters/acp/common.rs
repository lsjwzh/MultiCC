use crate::host_api::*;
use std::ffi::CStr;

pub(in crate::cli_adapters) fn host(ctx: L<'_>) -> Result<L<'_>> {
    ctx.get(c"host")
}

pub(in crate::cli_adapters) fn list<'a>(p: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let out = array(p)?;
    for (i, value) in values.iter().enumerate() {
        out.set_element(i as u32, *value)?;
    }
    Ok(out)
}
pub(in crate::cli_adapters) fn push<'a>(out: L<'a>, values: &[L<'a>]) -> Result<()> {
    call(out, c"push", values)?;
    Ok(())
}
pub(in crate::cli_adapters) fn concat<'a>(p: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    call(text(p, "")?, c"concat", values)
}
pub(in crate::cli_adapters) fn truthy_or<'a>(
    v: L<'a>,
    other: impl FnOnce() -> Result<L<'a>>,
) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        other()
    }
}
pub(in crate::cli_adapters) fn props<'a>(v: L<'a>, keys: &[&CStr]) -> Result<L<'a>> {
    let mut result = undef(v)?;
    for key in keys {
        result = v.get(key)?;
        if result.truthy()? {
            break;
        }
    }
    Ok(result)
}
pub(in crate::cli_adapters) fn method<'a>(
    api: L<'a>,
    ctx: L<'a>,
    name: &'static str,
    n: usize,
    f: Action,
) -> Result<()> {
    api.define_key(text(ctx, name)?, function(ctx, name, n, n, f)?)
}
pub(in crate::cli_adapters) fn invocation_payload<'a>(
    ctx: L<'a>,
    env: L<'a>,
    first: L<'a>,
) -> Result<L<'a>> {
    let prompt = call(host(ctx)?, c"renderPrompt", &[env])?;
    let mut payload = if first.truthy()? && env.get(c"rolePrompt")?.truthy()? {
        concat(
            ctx,
            &[
                text(ctx, "[Role prompt]\n")?,
                env.get(c"rolePrompt")?,
                text(ctx, "\n[End of role prompt]\n\n")?,
                prompt,
            ],
        )?
    } else {
        prompt
    };
    let reminder = ctx.get(c"userInputReminder")?;
    if reminder.truthy()? {
        payload = concat(ctx, &[reminder, text(ctx, "\n\n")?, payload])?;
    }
    Ok(payload)
}
pub(in crate::cli_adapters) fn supports_effort<'a>(ctx: L<'a>, so: L<'a>) -> Result<bool> {
    let model = truthy_or(so.get(c"rawModel")?, || so.get(c"effectiveModel"))?;
    call(
        host(ctx)?,
        c"supportsEffort",
        &[ctx.get(c"name")?, model, so.get(c"rawEffort")?],
    )?
    .truthy()
}
