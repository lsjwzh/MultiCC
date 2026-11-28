use super::*;

fn chunk<'a>(c: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let n = c.get(c"received")?.number()? + value.get(c"length")?.number()?;
    let size = c.get(c"size")?.number()?;
    if n > size {
        return fail(
            c,
            "size",
            &format!("package is larger than the listed {size} bytes"),
        );
    }
    c.set(c"received", num(c, n)?)?;
    call(c.get(c"hash")?, c"update", &[value])?;
    push(
        c.get(c"chunks")?,
        call(c.global()?.get(c"Buffer")?, c"from", &[value])?,
    )?;
    next(c)
}
fn next(c: L<'_>) -> Result<L<'_>> {
    let iter = c.get(c"iter")?;
    then(c.get(c"next")?.call(iter, &[])?, c, |c, a| {
        let step = a[0];
        if step.get(c"done")?.truthy()? {
            return undef(c);
        }
        let value = step.get(c"value")?;
        if c.get(c"sync")?.truthy()? {
            return then(value, c, |c, a| chunk(c, a[0]));
        }
        chunk(c, value)
    })
}
fn response<'a>(c: L<'a>, r: L<'a>) -> Result<L<'a>> {
    if !r.get(c"ok")?.truthy()? {
        return fail(
            c,
            "download",
            &format!("HTTP {}", fold_string(r.get(c"status")?)?),
        );
    }
    let url = r.get(c"url")?;
    if url.truthy()? && !fold_string(url)?.starts_with("https://") {
        return fail(
            c,
            "download",
            &format!("redirected off https: {}", fold_string(url)?),
        );
    }
    let body = r.get(c"body")?;
    let sym = c.global()?.get(c"Symbol")?;
    let mut method = body.get_key(sym.get(c"asyncIterator")?)?;
    let sync = method.nullish()?;
    if sync {
        method = body.get_key(sym.get(c"iterator")?)?;
    }
    let iter = method.call(body, &[])?;
    c.set(c"sync", flag(c, sync)?)?;
    c.set(c"iter", iter)?;
    c.set(c"next", iter.get(c"next")?)?;
    let reading = async_result(c, || next(c))?;
    recover(reading, c, |c, a| {
        let err = a[0];
        let iter = c.get(c"iter")?;
        let closing = async_result(c, || {
            let f = iter.get(c"return")?;
            if f.nullish()? {
                return undef(c);
            }
            f.call(iter, &[])
        })?;
        let rethrow = function(err, "", 0, 0, |e, _| Err(e.throw_error()))?;
        call(closing, c"then", &[rethrow, rethrow])
    })
}
pub(super) fn get(c: L<'_>) -> Result<L<'_>> {
    let asset = c.get(c"asset")?;
    let size = asset.get(c"size")?;
    if !size
        .number_value()?
        .is_some_and(|v| v.fract() == 0. && v > 0. && v <= MAX_SIZE)
    {
        return fail(
            c,
            "size",
            &format!("package size {} is out of range", fold_string(size)?),
        );
    }
    let o = c.get(c"owner")?;
    let ports = o.get(c"ports")?;
    let g = c.global()?;
    let ctrl = g.get(c"AbortController")?.construct(&[])?;
    let timer = g.get(c"setTimeout")?.call_plain(&[
        function(ctrl, "", 0, 0, |ctrl, _| call(ctrl, c"abort", &[]))?,
        o.get(c"timeout")?,
    ])?;
    let reading = async_result(c, || {
        c.set(c"size", size)?;
        c.set(c"received", num(c, 0.)?)?;
        c.set(c"chunks", array(c)?)?;
        c.set(
            c"hash",
            call(ports.get(c"crypto")?, c"createHash", &[text(c, "sha256")?])?,
        )?;
        let opts = fields(
            c,
            &[
                ("signal", ctrl.get(c"signal")?),
                ("redirect", text(c, "follow")?),
            ],
        )?;
        then(
            o.get(c"fetch")?.call_plain(&[asset.get(c"url")?, opts])?,
            c,
            |c, a| response(c, a[0]),
        )
    })?;
    let checked = recover(reading, c, |c, a| {
        let e = a[0];
        let class = c.get(c"owner")?.get(c"ports")?.get(c"PluginInstallError")?;
        if object(e)? && e.instance_of(class)? {
            return Err(e.throw_error());
        }
        let msg = if e.optional(c"name")?.is_string("AbortError")? {
            "download timed out".into()
        } else {
            fold_string(e.optional(c"message")?)?
        };
        fail(c, "download", &msg)
    })?;
    let done = call(
        checked,
        c"finally",
        &[function(timer, "", 0, 0, |t, _| {
            t.global()?.get(c"clearTimeout")?.call_plain(&[t])
        })?],
    )?;
    then(done, c, |c, _| {
        let size = c.get(c"size")?.number()?;
        let received = c.get(c"received")?.number()?;
        if received != size {
            return fail(
                c,
                "size",
                &format!("got {received} bytes, the list says {size}"),
            );
        }
        let digest = call(c.get(c"hash")?, c"digest", &[text(c, "hex")?])?;
        if !digest.equals(c.get(c"asset")?.get(c"sha256")?)? {
            return fail(
                c,
                "checksum",
                &format!("sha256 {} does not match the list", fold_string(digest)?),
            );
        }
        call(
            c.global()?.get(c"Buffer")?,
            c"concat",
            &[c.get(c"chunks")?, num(c, received)?],
        )
    })
}
