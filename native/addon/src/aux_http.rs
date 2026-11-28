//! Live wire codecs plus an asynchronous native HTTP request. No provider/store
//! lookup occurs here: the existing caller supplies its already resolved target.
use crate::host_api::*;
use multicc_core::aux_http as transport;
use napi::bindgen_prelude::{External, FromNapiRef, ToNapiValue};
use napi_derive::napi;
use std::cell::RefCell;

fn add<'a>(p: L<'a>, prefix: &str, value: L<'a>) -> Result<L<'a>> {
    call(text(p, prefix)?, c"concat", &[value])
}
fn parse_json(v: L<'_>) -> Result<L<'_>> {
    json_call(v, c"parse", v)
}
fn stringify(v: L<'_>) -> Result<L<'_>> {
    json_call(v, c"stringify", v)
}
fn err<'a>(p: L<'a>, msg: L<'a>) -> Result<L<'a>> {
    Err(p.global()?.get(c"Error")?.construct(&[msg])?.throw_error())
}
fn items(v: L<'_>) -> Result<L<'_>> {
    if v.is_array()? {
        Ok(v)
    } else {
        array(v)
    }
}
fn parse_text<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let value = a[0];
    let wire = s.get(c"wire")?;
    let texts = array(s)?;
    if wire.is_string("messages")? {
        items(value.get(c"content")?)?.for_each(|b| {
            if b.get(c"type")?.is_string("text")? {
                call(texts, c"push", &[fallback(b.get(c"text")?, "".into())?])?;
            }
            Ok(())
        })?;
        return call(texts, c"join", &[text(s, " ")?]);
    }
    if wire.is_string("responses")? {
        if value.get(c"output_text")?.truthy()? {
            return value.get(c"output_text");
        }
        items(value.get(c"output")?)?.for_each(|i| {
            items(i.get(c"content")?)?.for_each(|b| {
                if b.get(c"type")?.is_string("text")? || b.get(c"type")?.is_string("output_text")? {
                    call(texts, c"push", &[fallback(b.get(c"text")?, "".into())?])?;
                }
                Ok(())
            })
        })?;
    } else {
        let choices = value.get(c"choices")?;
        let first = if choices.truthy()? {
            choices.element(0)?
        } else {
            choices
        };
        let message = if first.truthy()? {
            first.get(c"message")?
        } else {
            first
        };
        let content = if message.truthy()? {
            message.get(c"content")?
        } else {
            text(s, "")?
        };
        if content.kind()? == sys::ValueType::napi_string {
            return Ok(content);
        }
        items(content)?.for_each(|b| {
            call(texts, c"push", &[fallback(b.get(c"text")?, "".into())?])?;
            Ok(())
        })?;
    }
    call(texts, c"join", &[text(s, "")?])
}
fn build<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let target = a[0];
    let input = a[1];
    let wire = if target.truthy()? {
        target.get(c"wireApi")?
    } else {
        target
    };
    if !wire.is_string("messages")?
        && !wire.is_string("responses")?
        && !wire.is_string("chat_completions")?
    {
        return err(p, add(p, "不支持的 Aux wire API：", wire)?);
    }
    let (model, prompt, system) = (
        input.get(c"model")?,
        input.get(c"prompt")?,
        input.get(c"systemPrompt")?,
    );
    let messages = array(p)?;
    let body = if wire.is_string("responses")? {
        let content = array(p)?;
        content.set_element(
            0,
            fields(p, &[("type", text(p, "input_text")?), ("text", prompt)])?,
        )?;
        messages.set_element(
            0,
            fields(p, &[("role", text(p, "user")?), ("content", content)])?,
        )?;
        fields(
            p,
            &[
                ("model", model),
                ("input", messages),
                ("instructions", fallback(system, "".into())?),
                ("stream", flag(p, true)?),
            ],
        )?
    } else {
        if wire.is_string("chat_completions")? && system.truthy()? {
            call(
                messages,
                c"push",
                &[fields(
                    p,
                    &[("role", text(p, "system")?), ("content", system)],
                )?],
            )?;
        }
        call(
            messages,
            c"push",
            &[fields(
                p,
                &[("role", text(p, "user")?), ("content", prompt)],
            )?],
        )?;
        let body = fields(
            p,
            &[
                ("model", model),
                ("max_tokens", num(p, 128000.)?),
                ("messages", messages),
            ],
        )?;
        if wire.is_string("messages")? && system.truthy()? {
            body.set(c"system", system)?;
        }
        body
    };
    let headers = fields(
        p,
        &[
            ("Content-Type", text(p, "application/json")?),
            ("Authorization", add(p, "Bearer ", target.get(c"apiKey")?)?),
        ],
    )?;
    if wire.is_string("messages")? {
        headers.define_key(text(p, "anthropic-version")?, text(p, "2023-06-01")?)?;
        headers.define_key(text(p, "x-api-key")?, target.get(c"apiKey")?)?;
    }
    let state = fields(p, &[("wire", wire)])?;
    fields(
        p,
        &[
            ("body", body),
            ("headers", headers),
            ("parse", function(state, "parse", 1, 1, parse_text)?),
        ],
    )
}
fn sse<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let Some(data) = a[0].string()? else {
        return Err(a[0].type_error("data.replace is not a function"));
    };
    let mut done = undef(p)?;
    for payload in transport::payloads(&data) {
        let value = parse_json(p.from_value(&V::String(payload))?)?;
        let kind = value.get(c"type")?;
        if transport::is_failure_event(&kind.coerce_string()?.to_string_lossy()) {
            let error = value.get(c"response")?.optional(c"error")?;
            let error = if error.truthy()? {
                error
            } else {
                value.get(c"error")?
            };
            let message = error.optional(c"message")?;
            let message = if message.truthy()? {
                message
            } else {
                fallback(value.get(c"message")?, V::Undefined)?
            };
            return err(
                p,
                if message.truthy()? {
                    message
                } else {
                    add(p, "Aux ", kind)?
                },
            );
        }
        if kind.is_string("response.completed")? {
            done = value.get(c"response")?;
        }
    }
    if !done.truthy()? {
        return err(
            p,
            text(p, "Aux Responses stream disconnected before completion")?,
        );
    }
    Ok(done)
}
fn http_error<'a>(p: L<'a>, status: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let fallback = add(p, "HTTP ", status)?;
    let parsed = p.catch(|| -> Result<L<'a>> {
        let v = parse_json(body)?;
        let error = v.get(c"error")?;
        if error.truthy()? {
            let message = error.get(c"message")?;
            let message = if message.truthy()? {
                message
            } else {
                stringify(error)?
            };
            if message.truthy()? {
                return Ok(message);
            }
        }
        let message = v.get(c"message")?;
        Ok(if message.truthy()? { message } else { fallback })
    })?;
    if let Some(message) = parsed {
        return Ok(message);
    }
    let prefix = call(string(body)?, c"slice", &[num(p, 0.)?, num(p, 200.)?])?;
    let regex = p
        .global()?
        .get(c"RegExp")?
        .construct(&[text(p, "\n")?, text(p, "g")?])?;
    let prefix = call(prefix, c"replace", &[regex, text(p, " ")?])?;
    call(fallback, c"concat", &[text(p, ": ")?, prefix])
}
fn state<'a>(p: L<'a>) -> Result<&'a RefCell<transport::ResponseState>> {
    let v = p.get(c"state")?;
    Ok(unsafe { External::<RefCell<transport::ResponseState>>::from_napi_ref(p.env(), v.raw())? })
}
fn finish<'a>(p: L<'a>, error: Option<L<'a>>, result: L<'a>) -> Result<L<'a>> {
    let accepted = state(p)?.borrow_mut().settle();
    if !accepted {
        return undef(p);
    }
    p.global()?
        .get(c"clearTimeout")?
        .call_plain(&[p.get(c"timer")?])?;
    match error {
        Some(error) => p.get(c"reject")?.call_plain(&[error]),
        None => p.get(c"resolve")?.call_plain(&[result]),
    }
}
fn reject_event<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    finish(p, Some(a[0]), undef(p)?)
}
fn end<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let data = state(p)?.borrow().data.clone();
    let data = p.from_value(&V::String(data))?;
    let response = p.get(c"response")?;
    let status = response.get(c"statusCode")?;
    if status.number()? >= 400. {
        let message = http_error(p, status, data)?;
        return finish(
            p,
            Some(p.global()?.get(c"Error")?.construct(&[message])?),
            undef(p)?,
        );
    }
    let parsed = (|| -> Result<L<'a>> {
        let target = p.get(c"target")?;
        let content_type = response
            .get(c"headers")?
            .get_key(text(p, "content-type")?)?;
        let content_type = string(fallback(content_type, "".into())?)?;
        let parsed = if target.get(c"wireApi")?.is_string("responses")?
            && call(content_type, c"includes", &[text(p, "text/event-stream")?])?.truthy()?
        {
            sse(p, &mut [data])?
        } else {
            parse_json(data)?
        };
        let error = parsed.get(c"error")?;
        if error.truthy()? {
            let message = error.get(c"message")?;
            return err(
                p,
                if message.truthy()? {
                    message
                } else {
                    stringify(error)?
                },
            );
        }
        let status = parsed.get(c"status")?;
        if status.is_string("failed")? || status.is_string("incomplete")? {
            return err(p, add(p, "Aux response ", status)?);
        }
        call(p.get(c"request")?, c"parse", &[parsed])
    })();
    match parsed {
        Ok(value) => finish(p, None, value),
        Err(error) => {
            let cause = match p.exception_value()? {
                Some(cause) => cause,
                None => error_value(p, &error.reason)?,
            };
            finish(p, Some(cause), undef(p)?)
        }
    }
}
fn response<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let response = a[0];
    p.set(c"response", response)?;
    call(response, c"setEncoding", &[text(p, "utf8")?])?;
    let data = function(p, "responseData", 1, 1, |p, a| {
        let chunk = a[0]
            .string()?
            .ok_or_else(|| a[0].type_error("response chunk must be a string"))?;
        let accepted = state(p)?.borrow_mut().append(&chunk);
        if !accepted {
            let error = error_value(p, "Aux response exceeds size limit")?;
            finish(p, Some(error), undef(p)?)?;
            call(p.get(c"req")?, c"destroy", &[error])?;
        }
        undef(p)
    })?;
    call(response, c"on", &[text(p, "data")?, data])?;
    call(
        response,
        c"on",
        &[
            text(p, "error")?,
            function(p, "responseError", 1, 1, reject_event)?,
        ],
    )?;
    call(
        response,
        c"on",
        &[
            text(p, "aborted")?,
            function(p, "responseAborted", 0, 0, |p, _| {
                finish(
                    p,
                    Some(error_value(
                        p,
                        "Aux response disconnected before completion",
                    )?),
                    undef(p)?,
                )
            })?,
        ],
    )?;
    call(
        response,
        c"on",
        &[text(p, "end")?, function(p, "responseEnd", 0, 0, end)?],
    )?;
    undef(p)
}
fn start<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    p.set(c"resolve", a[0])?;
    p.set(c"reject", a[1])?;
    let url = p.get(c"url")?;
    let secure = url.get(c"protocol")?.is_string("https:")?;
    let options = fields(
        p,
        &[
            ("hostname", url.get(c"hostname")?),
            (
                "port",
                fallback(url.get(c"port")?, if secure { "443" } else { "80" }.into())?,
            ),
            (
                "path",
                call(url.get(c"pathname")?, c"concat", &[url.get(c"search")?])?,
            ),
            ("method", text(p, "POST")?),
            ("headers", p.get(c"request")?.get(c"headers")?),
        ],
    )?;
    let transport = p
        .get(c"ports")?
        .get(if secure { c"https" } else { c"http" })?;
    let req = call(
        transport,
        c"request",
        &[options, function(p, "response", 1, 1, response)?],
    )?;
    p.set(c"req", req)?;
    call(
        req,
        c"on",
        &[
            text(p, "error")?,
            function(p, "requestError", 1, 1, reject_event)?,
        ],
    )?;
    let timeout = function(p, "timeout", 0, 0, |p, _| {
        let error = error_value(p, "timeout")?;
        finish(p, Some(error), undef(p)?)?;
        call(p.get(c"req")?, c"destroy", &[error])?;
        undef(p)
    })?;
    let timer = p.global()?.get(c"setTimeout")?.call_plain(&[
        timeout,
        fallback(p.get(c"input")?.get(c"timeoutMs")?, V::Number(120000.))?,
    ])?;
    p.set(c"timer", timer)?;
    call(req, c"end", &[stringify(p.get(c"request")?.get(c"body")?)?])?;
    undef(p)
}
fn execute<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(ports, || {
        let input = a[0];
        let target = input.get(c"target")?;
        let model = input.get(c"model")?;
        if !model.truthy()? {
            return err(ports, text(ports, "Aux Provider 没有可用模型")?);
        }
        let parsed = ports.catch(|| {
            ports
                .global()?
                .get(c"URL")?
                .construct(&[target.get(c"url")?])
        })?;
        let Some(url) = parsed else {
            return err(
                ports,
                add(
                    ports,
                    "Aux Provider URL 无效：",
                    fallback(target.get(c"url")?, "".into())?,
                )?,
            );
        };
        let request = build(ports, &mut [target, input])?;
        let p = fields(
            ports,
            &[
                ("ports", ports),
                ("input", input),
                ("target", target),
                ("url", url),
                ("request", request),
            ],
        )?;
        let external = unsafe {
            External::to_napi_value(
                p.env(),
                External::new(RefCell::new(transport::ResponseState::default())),
            )?
        };
        p.set(c"state", L::from_raw(p.env(), external))?;
        p.global()?
            .get(c"Promise")?
            .construct(&[function(p, "startAuxRequest", 2, 2, start)?])
    })
}
#[napi]
pub fn aux_http_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    Ok(methods(
        ports,
        &[
            ("buildAuxHttpRequest", 2, build),
            ("executeAuxHttp", 1, execute),
            ("parseResponsesStream", 1, sse),
        ],
    )?
    .raw())
}
