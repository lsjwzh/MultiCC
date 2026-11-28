use super::*;

#[derive(Default)]
struct State {
    assistant: JsString,
    turn: bool,
}
type Shared = Rc<RefCell<State>>;

fn banner<'a>(p: L<'a>, prefix: &str, suffix: &str) -> Result<L<'a>> {
    concat(p, &[text(p, prefix)?, p.get(c"banner")?, text(p, suffix)?])
}
fn open(p: L<'_>) -> Result<bool> {
    let ws = p.get(c"ws")?;
    Ok(ws.truthy()? && ws.get(c"readyState")?.is_number(1.)?)
}
fn clear_timer(p: L<'_>) -> Result<()> {
    p.global()?
        .get(c"clearTimeout")?
        .call_plain(&[p.get(c"timer")?])?;
    Ok(())
}
fn feed(p: L<'_>, evt: L<'_>, state: &Shared) -> Result<()> {
    if evt.get(c"type")?.is_string("assistant")?
        && evt.get(c"message")?.optional(c"content")?.truthy()?
    {
        evt.get(c"message")?.get(c"content")?.for_each(|block| {
            if block.get(c"type")?.is_string("text")? && block.get(c"text")?.truthy()? {
                let text = block.get(c"text")?.coerce_string()?;
                state.borrow_mut().assistant.push(&text);
            }
            Ok(())
        })?;
        return Ok(());
    }
    if evt.get(c"type")?.is_string("result")? {
        let output = rules::strip(&state.borrow().assistant);
        {
            let mut s = state.borrow_mut();
            s.assistant = JsString::new();
            s.turn = false;
        }
        if !output.is_empty() {
            let delivery = fields(p, &[("client", p), ("text", js_text(p, &output)?)])?;
            let promise = then(undef(p)?, delivery, |d, _| {
                let callback = d.get(c"client")?.get(c"onTurn")?;
                if callback.truthy()? {
                    callback.call_plain(&[d.get(c"text")?])
                } else {
                    Ok(callback)
                }
            })?;
            recover(promise, delivery, |d, a| {
                let p = d.get(c"client")?;
                let error = if a[0].truthy()? {
                    a[0].get(c"message")?
                } else {
                    a[0]
                };
                log(
                    p,
                    "error",
                    concat(p, &[banner(p, "Send to ", " failed: ")?, error])?,
                )
            })?;
        }
        return Ok(());
    }
    if evt.get(c"type")?.is_string("system")? && evt.get(c"subtype")?.is_string("init")? {
        return Ok(());
    }
    if evt.get(c"type")?.is_string("error")? {
        let error = fallback(evt.get(c"error")?, "unknown error".into())?;
        log(
            p,
            "error",
            concat(p, &[banner(p, "", " gateway: ")?, error])?,
        )?;
        state.borrow_mut().turn = false;
    }
    Ok(())
}

fn connect<'a>(p: L<'a>, state: &Shared) -> Result<L<'a>> {
    if p.get(c"ws")?.truthy()? {
        return undef(p);
    }
    if !p.get(c"getGateway")?.call_plain(&[])?.truthy()? {
        return undef(p);
    }
    let session = p
        .global()?
        .get(c"encodeURIComponent")?
        .call_plain(&[p.get(c"sessionId")?])?;
    let url = concat(
        p,
        &[
            text(p, "ws://127.0.0.1:")?,
            p.get(c"port")?,
            text(p, "/ws/chat?session=")?,
            session,
        ],
    )?;
    let ws = p.get(c"wsFactory")?.call_plain(&[url])?;
    p.set(c"ws", ws)?;
    call(
        ws,
        c"on",
        &[
            text(p, "open")?,
            function(p, "onOpen", 0, 0, |p, _| {
                log(
                    p,
                    "system",
                    banner(p, "Connected to ", " gateway chat session")?,
                )
            })?,
        ],
    )?;
    let s = state.clone();
    call(
        ws,
        c"on",
        &[
            text(p, "message")?,
            function(p, "onMessage", 1, 1, move |p, a| {
                let Some(evt) =
                    p.catch(|| json_call(p, c"parse", call(a[0], c"toString", &[])?))?
                else {
                    return undef(p);
                };
                feed(p, evt, &s)?;
                undef(p)
            })?,
        ],
    )?;
    call(
        ws,
        c"on",
        &[
            text(p, "close")?,
            function(p, "onClose", 0, 0, |p, _| {
                // Compatibility: a late close from the previous socket still clears
                // the active slot. Generation filtering is a separate behavior change.
                p.set(c"ws", null(p)?)?;
                if p.get(c"isRunning")?.call_plain(&[])?.truthy()?
                    && p.get(c"getGateway")?.call_plain(&[])?.truthy()?
                {
                    clear_timer(p)?;
                    let timer = p
                        .global()?
                        .get(c"setTimeout")?
                        .call_plain(&[p.get(c"connect")?, p.get(c"reconnectDelayMs")?])?;
                    p.set(c"timer", timer)?;
                }
                undef(p)
            })?,
        ],
    )?;
    call(
        ws,
        c"on",
        &[
            text(p, "error")?,
            function(p, "onError", 1, 1, |p, a| {
                log(
                    p,
                    "error",
                    concat(p, &[text(p, "Chat WS error: ")?, a[0].get(c"message")?])?,
                )
            })?,
        ],
    )?;
    undef(p)
}

pub(super) fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let factory = function(ports, "wsFactory", 1, 1, |p, a| {
        p.get(c"WebSocket")?.construct(&[a[0]])
    })?;
    let p = defaults(
        default_object(a[0])?,
        ports,
        &[
            (c"port", None),
            (c"sessionId", None),
            (c"getGateway", None),
            (c"isRunning", None),
            (c"log", None),
            (c"onTurn", None),
            (c"wsFactory", Some(factory)),
            (c"reconnectDelayMs", Some(num(ports, 1500.)?)),
            (c"hostLabel", None),
        ],
    )?;
    p.set(
        c"banner",
        if p.get(c"hostLabel")?.truthy()? {
            p.get(c"hostLabel")?
        } else {
            p.get(c"sessionId")?
        },
    )?;
    p.set(c"ws", null(p)?)?;
    p.set(c"timer", null(p)?)?;
    let state = Rc::new(RefCell::new(State::default()));
    let s = state.clone();
    let connect = function(p, "connect", 0, 0, move |p, _| connect(p, &s))?;
    p.set(c"connect", connect)?;
    let api = fields(p, &[("connect", connect)])?;
    let s = state.clone();
    api.set(
        c"disconnect",
        function(p, "disconnect", 0, 0, move |p, _| {
            clear_timer(p)?;
            p.set(c"timer", null(p)?)?;
            if p.get(c"ws")?.truthy()? {
                p.catch(|| call(p.get(c"ws")?, c"close", &[]))?;
                p.set(c"ws", null(p)?)?;
            }
            {
                let mut s = s.borrow_mut();
                s.assistant = JsString::new();
                s.turn = false;
            }
            undef(p)
        })?,
    )?;
    api.set(
        c"reconnectIfRunning",
        function(p, "reconnectIfRunning", 0, 0, |p, _| {
            if p.get(c"isRunning")?.call_plain(&[])?.truthy()? {
                p.get(c"connect")?.call_plain(&[])?;
            }
            undef(p)
        })?,
    )?;
    let s = state.clone();
    api.set(
        c"sendUserMessage",
        function(p, "sendUserMessage", 1, 1, move |p, a| {
            if !open(p)? {
                log(
                    p,
                    "error",
                    banner(
                        p,
                        "",
                        " gateway chat not connected — cannot deliver message",
                    )?,
                )?;
                return flag(p, false);
            }
            {
                let mut s = s.borrow_mut();
                s.assistant = JsString::new();
                s.turn = true;
            }
            let frame = fields(p, &[("type", text(p, "user_message")?), ("text", a[0])])?;
            // Read the method before serialization, just as ws.send(JSON.stringify).
            let ws = p.get(c"ws")?;
            let send = ws.get(c"send")?;
            send.call(ws, &[json_call(p, c"stringify", frame)?])?;
            flag(p, true)
        })?,
    )?;
    api.set(
        c"ensureOpen",
        function(p, "ensureOpen", 0, 1, |p, a| {
            async_result(p, || {
                let ws = p.get(c"ws")?;
                if !ws.truthy()? || !ws.get(c"readyState")?.is_number(0.)? {
                    return undef(p);
                }
                let wait = fields(
                    p,
                    &[
                        ("socket", ws),
                        ("timeoutMs", with_default(a[0], num(p, 2000.)?)?),
                    ],
                )?;
                let executor = function(wait, "executor", 2, 2, |w, a| {
                    let time = w
                        .global()?
                        .get(c"setTimeout")?
                        .call_plain(&[a[0], w.get(c"timeoutMs")?])?;
                    let owner = fields(w, &[("resolve", a[0]), ("timer", time)])?;
                    let opened = function(owner, "opened", 0, 0, |w, _| {
                        w.global()?
                            .get(c"clearTimeout")?
                            .call_plain(&[w.get(c"timer")?])?;
                        w.get(c"resolve")?.call_plain(&[])
                    })?;
                    call(w.get(c"socket")?, c"once", &[text(w, "open")?, opened])?;
                    undef(w)
                })?;
                p.global()?.get(c"Promise")?.construct(&[executor])
            })
        })?,
    )?;
    api.set(
        c"isOpen",
        function(p, "isOpen", 0, 0, |p, _| flag(p, open(p)?))?,
    )?;
    let s = state.clone();
    api.set(
        c"_feed",
        function(p, "_feed", 1, 1, move |p, a| {
            feed(p, a[0], &s)?;
            undef(p)
        })?,
    )?;
    let s = state.clone();
    api.set(
        c"_peekAssistantText",
        function(p, "_peekAssistantText", 0, 0, move |p, _| {
            js_text(p, &s.borrow().assistant)
        })?,
    )?;
    api.set(
        c"_peekTurnInProgress",
        function(p, "_peekTurnInProgress", 0, 0, move |p, _| {
            flag(p, state.borrow().turn)
        })?,
    )?;
    Ok(api)
}
