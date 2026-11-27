use super::*;

/// V8 owns the fetch Promise, AbortSignal, response reader and streaming
/// TextDecoder. Each request has its own bound owner and UTF-16 SSE buffer.
pub(super) fn request<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let options = a[1];
        let o = fields(p, &[("cfg", p.get(c"cfg")?), ("prompt", a[0])])?;
        for key in [
            c"reqId",
            c"onStart",
            c"onFirstToken",
            c"onChunk",
            c"onDone",
            c"onError",
        ] {
            o.set(key, options.get(key)?)?;
        }
        let start = o.get(c"onStart")?;
        if callable(start)? {
            start.call_plain(&[])?;
        }
        if !o.get(c"cfg")?.get(c"OPENROUTER_API_KEY")?.truthy()? {
            o.get(c"onError")?
                .call_plain(&[text(p, "OPENROUTER_API_KEY 环境变量未设置")?])?;
            return undef(p);
        }
        let controller = p.global()?.get(c"AbortController")?.construct(&[])?;
        o.set(c"controller", controller)?;
        let abort = function(controller, "abort", 0, 0, |c, _| call(c, c"abort", &[]))?;
        let timer = p
            .global()?
            .get(c"setTimeout")?
            .call_plain(&[abort, num(p, 60000.)?])?;
        o.set(c"timeout", timer)?;
        let request = async_result(o, || send_request(o))?;
        let done = then(request, o, |o, _| {
            clear(o)?;
            o.get(c"onDone")?.call_plain(&[])?;
            undef(o)
        })?;
        recover(done, o, |o, a| {
            clear(o)?;
            let error = a[0];
            if error.get(c"name")?.is_string("AbortError")? {
                o.get(c"onChunk")?
                    .call_plain(&[text(o, "[超时：AI处理超过60秒，已中止]")?])?;
                o.get(c"onDone")?.call_plain(&[])?;
            } else {
                o.get(c"onError")?.call_plain(&[error.get(c"message")?])?;
            }
            undef(o)
        })
    })
}
fn clear(o: L<'_>) -> Result<()> {
    o.global()?
        .get(c"clearTimeout")?
        .call_plain(&[o.get(c"timeout")?])?;
    Ok(())
}
fn send_request(o: L<'_>) -> Result<L<'_>> {
    let cfg = o.get(c"cfg")?;
    o.set(c"start", gcall(o, c"Date", c"now", &[])?)?;
    let id = o.get(c"reqId")?.coerce_string()?;
    let model = cfg.get(c"OPENROUTER_MODEL")?;
    super::config::log(
        o,
        c"log",
        &[text(
            o,
            &format!(
                "[multicc/voice][{}] Sending request to OpenRouter (model: {})",
                id.to_string_lossy(),
                model.coerce_string()?.to_string_lossy()
            ),
        )?],
    )?;
    let mut url = cfg.get(c"OPENROUTER_BASE_URL")?.coerce_string()?;
    url.push_str("/chat/completions");
    let mut bearer = S::from("Bearer ");
    bearer.push(&cfg.get(c"OPENROUTER_API_KEY")?.coerce_string()?);
    let headers = fields(
        o,
        &[
            ("Content-Type", text(o, "application/json")?),
            ("Authorization", ls(o, bearer)?),
        ],
    )?;
    let messages = array(o)?;
    push(
        messages,
        fields(
            o,
            &[("role", text(o, "user")?), ("content", o.get(c"prompt")?)],
        )?,
    )?;
    let body = json_call(
        o,
        c"stringify",
        fields(
            o,
            &[
                ("model", cfg.get(c"OPENROUTER_MODEL")?),
                ("stream", flag(o, true)?),
                ("messages", messages),
            ],
        )?,
    )?;
    let options = fields(
        o,
        &[
            ("method", text(o, "POST")?),
            ("headers", headers),
            ("body", body),
            ("signal", o.get(c"controller")?.get(c"signal")?),
        ],
    )?;
    then(
        o.global()?
            .get(c"fetch")?
            .call_plain(&[ls(o, url)?, options])?,
        o,
        response,
    )
}
fn response<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let res = a[0];
    if !res.get(c"ok")?.truthy()? {
        return then(call(res, c"text", &[])?, res, |r, a| {
            let mut s = S::from("OpenRouter API ");
            s.push(&r.get(c"status")?.coerce_string()?);
            s.push_str(": ");
            s.push(&slice(a[0], 0., Some(200.))?.coerce_string()?);
            Err(r
                .global()?
                .get(c"Error")?
                .construct(&[ls(r, s)?])?
                .throw_error())
        });
    }
    let reader = call(res.get(c"body")?, c"getReader", &[])?;
    o.set(c"reader", reader)?;
    o.set(c"decoder", o.global()?.get(c"TextDecoder")?.construct(&[])?)?;
    o.set(c"buffer", text(o, "")?)?;
    let reading = async_result(o, || read(o))?;
    call(
        reading,
        c"finally",
        &[function(reader, "release", 0, 0, |r, _| {
            call(r, c"releaseLock", &[])
        })?],
    )
}
fn read(o: L<'_>) -> Result<L<'_>> {
    then(call(o.get(c"reader")?, c"read", &[])?, o, chunk)
}
fn chunk<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let done = a[0].get(c"done")?;
    let value = a[0].get(c"value")?;
    if done.truthy()? {
        return undef(o);
    }
    let decoded = call(
        o.get(c"decoder")?,
        c"decode",
        &[value, fields(o, &[("stream", flag(o, true)?)])?],
    )?;
    let mut buf = o.get(c"buffer")?.coerce_string()?;
    buf.push(&decoded.coerce_string()?);
    let mut lines = buf.as_units().split(|&c| c == 10).peekable();
    while let Some(line) = lines.next() {
        let s = S::from_units(line.to_vec());
        if lines.peek().is_none() {
            o.set(c"buffer", ls(o, s)?)?;
            break;
        }
        let s = s.trim();
        let Some(data) = s.as_units().strip_prefix(&[100, 97, 116, 97, 58, 32]) else {
            continue;
        };
        let data = S::from_units(data.to_vec());
        if data == "[DONE]" {
            continue;
        }
        o.catch(|| {
            let parsed = json_call(o, c"parse", ls(o, data)?)?;
            let choices = parsed.get(c"choices")?;
            if choices.nullish()? {
                return Ok(());
            }
            let content = choices
                .get_key(text(o, "0")?)?
                .optional(c"delta")?
                .optional(c"content")?;
            if content.truthy()? {
                if !o.get(c"first")?.truthy()? {
                    o.set(c"first", flag(o, true)?)?;
                    let first = o.get(c"onFirstToken")?;
                    if callable(first)? {
                        first.call_plain(&[num(
                            o,
                            gcall(o, c"Date", c"now", &[])?.number()?
                                - o.get(c"start")?.number()?,
                        )?])?;
                    }
                }
                o.get(c"onChunk")?.call_plain(&[content])?;
            }
            Ok(())
        })?;
    }
    read(o)
}
