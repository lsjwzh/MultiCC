//! TTS provider and child-process owner. JS ports are SDK/IO only.
use crate::{host_api::*, voice_io as io};
use multicc_core::js::JsString;
use napi_derive::napi;

#[derive(Default)]
struct State {
    stopped: bool,
    settled: bool,
    finished: bool,
    audio: Vec<Vec<u8>>,
    stderr: JsString,
}
fn config(p: L<'_>) -> Result<L<'_>> {
    let cfg = fields(p, &[])?;
    let env = io::port(p, c"env")?;
    cfg.set(
        c"defaultProvider",
        io::default(env.get(c"TTS_PROVIDER")?, text(p, "edge")?)?,
    )?;
    let edge = fields(
        p,
        &[
            (
                "command",
                io::default(env.get(c"EDGE_TTS_CMD")?, text(p, "edge-tts")?)?,
            ),
            (
                "params",
                io::json(p, &serde_json::json!(["--voice", "zh-CN-XiaoxiaoNeural"]))?,
            ),
            ("sampleRate", num(p, 24000.)?),
        ],
    )?;
    let openai = fields(
        p,
        &[
            (
                "apiKey",
                io::default(env.get(c"OPENAI_TTS_API_KEY")?, text(p, "")?)?,
            ),
            ("url", text(p, "https://api.openai.com/v1/audio/speech")?),
            ("model", text(p, "tts-1")?),
            ("voice", text(p, "alloy")?),
            ("sampleRate", num(p, 24000.)?),
        ],
    )?;
    let volcano = fields(
        p,
        &[
            (
                "appId",
                io::default(env.get(c"VOLC_TTS_APP_ID")?, text(p, "")?)?,
            ),
            (
                "accessToken",
                io::default(env.get(c"VOLC_TTS_ACCESS_TOKEN")?, text(p, "")?)?,
            ),
            (
                "url",
                text(p, "wss://openspeech.bytedance.com/api/v1/sauc/bigmodel")?,
            ),
            ("resourceId", text(p, "volc.bigasr.sauc.duration")?),
            ("sampleRate", num(p, 24000.)?),
        ],
    )?;
    cfg.set(c"edge", edge)?;
    cfg.set(c"openai", openai)?;
    cfg.set(c"volcano", volcano)?;
    Ok(cfg)
}
fn apply<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let u = a[0];
    if !u.truthy()? {
        return undef(p);
    }
    let cfg = p.get(c"cfg")?;
    io::set_if(cfg, u, c"TTS_PROVIDER", c"defaultProvider", true)?;
    let voice = u.get(c"EDGE_TTS_VOICE")?;
    if !voice.undefined()? {
        let params = cfg.get(c"edge")?.get(c"params")?;
        let index = call(params, c"indexOf", &[text(p, "--voice")?])?.number()? + 1.;
        params.set_key(
            num(p, index)?,
            text(p, &format!("--voice {}", fold_string(voice)?))?,
        )?;
    }
    for (section, keys) in [
        (
            c"openai" as &std::ffi::CStr,
            vec![
                (c"OPENAI_TTS_API_KEY", c"apiKey", false),
                (c"OPENAI_TTS_URL", c"url", true),
                (c"OPENAI_TTS_MODEL", c"model", true),
                (c"OPENAI_TTS_VOICE", c"voice", true),
            ],
        ),
        (
            c"volcano",
            vec![
                (c"VOLC_TTS_APP_ID", c"appId", false),
                (c"VOLC_TTS_ACCESS_TOKEN", c"accessToken", false),
                (c"VOLC_TTS_URL", c"url", true),
            ],
        ),
    ] {
        for (from, to, truthy) in keys {
            io::set_if(cfg.get(section)?, u, from, to, truthy)?;
        }
    }
    undef(p)
}
fn status<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let cfg = p.get(c"cfg")?;
    let openai = cfg.get(c"openai")?;
    let volcano = cfg.get(c"volcano")?;
    let out = fields(p, &[])?;
    let s = fields(p, &[("ports", p.get(c"ports")?), ("out", out)])?;
    let result = (|| {
        let proc = io::port(p, c"spawn")?.call_plain(&[
            text(p, "which")?,
            io::json(p, &serde_json::json!(["edge-tts"]))?,
        ])?;
        io::on(s, proc, "error", 0, |s, _| {
            s.get(c"out")?
                .set(c"edge", fields(s, &[("ready", flag(s, false)?)])?)?;
            undef(s)
        })?;
        io::on(s, proc, "close", 1, |s, a| {
            s.get(c"out")?.set(
                c"edge",
                fields(
                    s,
                    &[
                        ("ready", flag(s, a[0].is_number(0.)?)?),
                        ("command", text(s, "edge-tts")?),
                    ],
                )?,
            )?;
            undef(s)
        })?;
        undef(p)
    })();
    if result.is_err() {
        p.exception_value()?;
        out.set(c"edge", fields(p, &[("ready", flag(p, false)?)])?)?;
    }
    out.set(
        c"openai",
        fields(
            p,
            &[
                ("ready", flag(p, openai.get(c"apiKey")?.truthy()?)?),
                ("model", openai.get(c"model")?),
                ("voice", openai.get(c"voice")?),
            ],
        )?,
    )?;
    out.set(
        c"volcano",
        fields(
            p,
            &[
                (
                    "ready",
                    flag(
                        p,
                        volcano.get(c"appId")?.truthy()?
                            && volcano.get(c"accessToken")?.truthy()?,
                    )?,
                ),
                ("resourceId", volcano.get(c"resourceId")?),
            ],
        )?,
    )?;
    Ok(out)
}
fn stopped(p: L<'_>) -> Result<bool> {
    io::state::<State, _>(p, |s| s.stopped)
}
fn edge<'a>(p: L<'a>, opts: L<'a>, cb: L<'a>) -> Result<L<'a>> {
    let value = io::default(opts.get(c"text")?, text(p, "")?)?;
    if !value.truthy()? {
        call(
            cb,
            c"onError",
            &[crate::route_response::text(p, "Text is empty")?],
        )?;
        return null(p);
    }
    let c = p.get(c"cfg")?.get(c"edge")?;
    let s = fields(
        p,
        &[
            ("ports", p.get(c"ports")?),
            ("c", c),
            ("cb", cb),
            ("proc", undef(p)?),
            ("text", value),
        ],
    )?;
    io::install(s, State::default())?;
    // Params are captured before either asynchronous proxy lookup.
    let params = array(p)?;
    for v in [
        crate::route_response::text(p, "--voice")?,
        c.get(c"params")?.element(1)?,
        crate::route_response::text(p, "--text")?,
        value,
        crate::route_response::text(p, "--write-media")?,
        crate::route_response::text(p, "/dev/stdout")?,
        crate::route_response::text(p, "--rate=+0%")?,
        crate::route_response::text(p, "--volume=+0%")?,
    ] {
        call(params, c"push", &[v])?;
    }
    s.set(c"params", params)?;
    let job = async_result(s, || {
        io::port(s, c"getChildProxyEnv")?.call_plain(&[io::port(s, c"env")?])
    })?;
    let job = then(job, s, |s, a| {
        if stopped(s)? {
            return undef(s);
        }
        s.set(c"env", a[0])?;
        let job = call(
            io::port(s, c"policy")?,
            c"proxyForUrl",
            &[text(s, "wss://speech.platform.bing.com")?],
        )?;
        then(job, s, |s, a| {
            if stopped(s)? {
                return undef(s);
            }
            let args = call(s.get(c"params")?, c"slice", &[])?;
            if a[0].truthy()? {
                call(args, c"push", &[text(s, "--proxy")?, a[0]])?;
            }
            let proc = io::port(s, c"spawn")?.call_plain(&[
                s.get(c"c")?.get(c"command")?,
                args,
                fields(s, &[("env", s.get(c"env")?)])?,
            ])?;
            s.set(c"proc", proc)?;
            io::on(s, proc, "error", 1, |s, a| {
                if io::state::<State, _>(s, |v| {
                    let old = v.settled;
                    v.settled = true;
                    old
                })? {
                    return undef(s);
                }
                let msg = fold_string(a[0].get(c"message")?)?;
                io::log(s, "[TTS][edge] spawn error:", &msg)?;
                io::callback(
                    s,
                    c"onError",
                    &[text(
                        s,
                        &format!(
                            "edge-tts 不可用：{msg}（请安装 edge-tts 或在设置里切换 TTS 提供方）"
                        ),
                    )?],
                )
            })?;
            io::on(s, proc.get(c"stdout")?, "data", 1, |s, a| {
                if !stopped(s)? {
                    let b = io::bytes(a[0])?;
                    io::state::<State, _>(s, |v| v.audio.push(b))?;
                }
                undef(s)
            })?;
            io::on(s, proc.get(c"stderr")?, "data", 1, |s, a| {
                io::log(
                    s,
                    "[TTS][edge] stderr:",
                    &fold_string(call(a[0], c"toString", &[])?)?,
                )?;
                undef(s)
            })?;
            io::on(s, proc, "close", 1, |s, a| {
                let done = io::state::<State, _>(s, |v| {
                    let old = v.settled || v.stopped;
                    v.settled = true;
                    old
                })?;
                if done {
                    return undef(s);
                }
                if !a[0].is_number(0.)? {
                    return io::callback(
                        s,
                        c"onError",
                        &[text(
                            s,
                            &format!("edge-tts exited with code {}", fold_string(a[0])?),
                        )?],
                    );
                }
                io::callback(s, c"onReady", &[s.get(c"c")?.get(c"sampleRate")?])?;
                let audio = io::state::<State, _>(s, |v| v.audio.clone())?;
                for b in audio {
                    io::callback(s, c"onAudio", &[io::buffer(s, &b)?])?;
                }
                io::callback(s, c"onDone", &[])
            })?;
            undef(s)
        })
    })?;
    recover(job, s, |s, _| {
        let stop = io::state::<State, _>(s, |v| {
            let old = v.stopped || v.settled;
            if !old {
                v.settled = true;
            }
            old
        })?;
        if stop {
            return undef(s);
        }
        io::callback(
            s,
            c"onError",
            &[text(s, "edge-tts 启动失败，请检查代理配置或安装状态")?],
        )
    })?;
    methods(
        s,
        &[("stop", 0, |s, _| {
            let old = io::state::<State, _>(s, |v| {
                let old = v.stopped;
                v.stopped = true;
                old
            })?;
            if !old {
                s.catch(|| call(s.get(c"proc")?, c"kill", &[text(s, "SIGTERM")?]))?;
            }
            undef(s)
        })],
    )
}
fn resolve(p: L<'_>) -> Result<L<'_>> {
    p.get(c"resolve")?.call_plain(&[null(p)?])
}
fn openai<'a>(p: L<'a>, opts: L<'a>, cb: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let value = io::default(opts.get(c"text")?, text(p, "")?)?;
        if !value.truthy()? {
            call(cb, c"onError", &[text(p, "Text is empty")?])?;
            return null(p);
        }
        let c = p.get(c"cfg")?.get(c"openai")?;
        let s = fields(p, &[("ports", p.get(c"ports")?), ("c", c), ("cb", cb)])?;
        io::install(s, State::default())?;
        let body = json_call(
            p,
            c"stringify",
            fields(
                p,
                &[
                    ("model", c.get(c"model")?),
                    ("input", value),
                    ("voice", c.get(c"voice")?),
                    ("response_format", text(p, "mp3")?),
                ],
            )?,
        )?;
        let url = p.global()?.get(c"URL")?.construct(&[c.get(c"url")?])?;
        s.set(
            c"options",
            fields(
                p,
                &[
                    ("agent", io::port(p, c"outboundAgent")?),
                    ("hostname", url.get(c"hostname")?),
                    ("port", io::default(url.get(c"port")?, num(p, 443.)?)?),
                    ("path", url.get(c"pathname")?),
                    ("method", text(p, "POST")?),
                    (
                        "headers",
                        fields(
                            p,
                            &[
                                ("Content-Type", text(p, "application/json")?),
                                (
                                    "Authorization",
                                    text(
                                        p,
                                        &format!("Bearer {}", fold_string(c.get(c"apiKey")?)?),
                                    )?,
                                ),
                            ],
                        )?,
                    ),
                ],
            )?,
        )?;
        s.set(c"body", body)?;
        p.global()?
            .get(c"Promise")?
            .construct(&[function(s, "request", 2, 2, |s, a| {
                s.set(c"resolve", a[0])?;
                let req = call(
                    io::port(s, c"https")?,
                    c"request",
                    &[
                        s.get(c"options")?,
                        function(s, "response", 1, 1, |s, a| {
                            let res = a[0];
                            if !res.get(c"statusCode")?.is_number(200.)? {
                                s.set(c"statusCode", res.get(c"statusCode")?)?;
                                io::on(s, res, "data", 1, |s, a| {
                                    let t = string(a[0])?.coerce_string()?;
                                    io::state::<State, _>(s, |v| v.stderr.push(&t))?;
                                    undef(s)
                                })?;
                                io::on(s, res, "end", 0, |s, _| {
                                    let data = io::state::<State, _>(s, |v| {
                                        v.stderr.clone().truncate_units(200)
                                    })?;
                                    io::callback(
                                        s,
                                        c"onError",
                                        &[text(
                                            s,
                                            &format!(
                                                "OpenAI TTS failed: {} - {}",
                                                fold_string(s.get(c"statusCode")?)?,
                                                data.to_string_lossy()
                                            ),
                                        )?],
                                    )?;
                                    resolve(s)
                                })?;
                                return undef(s);
                            }
                            io::on(s, res, "data", 1, |s, a| {
                                let b = io::bytes(a[0])?;
                                io::state::<State, _>(s, |v| v.audio.push(b))?;
                                undef(s)
                            })?;
                            io::on(s, res, "end", 0, |s, _| {
                                io::callback(s, c"onReady", &[s.get(c"c")?.get(c"sampleRate")?])?;
                                for b in io::state::<State, _>(s, |v| v.audio.clone())? {
                                    io::callback(s, c"onAudio", &[io::buffer(s, &b)?])?;
                                }
                                io::callback(s, c"onDone", &[])?;
                                resolve(s)
                            })?;
                            undef(s)
                        })?,
                    ],
                )?;
                io::on(s, req, "error", 1, |s, a| {
                    io::callback(
                        s,
                        c"onError",
                        &[text(
                            s,
                            &format!(
                                "OpenAI TTS request failed: {}",
                                fold_string(a[0].get(c"message")?)?
                            ),
                        )?],
                    )?;
                    resolve(s)
                })?;
                call(req, c"write", &[s.get(c"body")?])?;
                call(req, c"end", &[])?;
                undef(s)
            })?])
    })
}
fn volcano<'a>(p: L<'a>, opts: L<'a>, cb: L<'a>) -> Result<L<'a>> {
    let value = io::default(opts.get(c"text")?, text(p, "")?)?;
    if !value.truthy()? {
        call(cb, c"onError", &[text(p, "Text is empty")?])?;
        return null(p);
    }
    let c = p.get(c"cfg")?.get(c"volcano")?;
    let ws = io::port(p, c"WebSocket")?.construct(&[
        c.get(c"url")?,
        fields(p, &[("agent", io::port(p, c"outboundAgent")?)])?,
    ])?;
    let s = fields(
        p,
        &[
            ("ports", p.get(c"ports")?),
            ("c", c),
            ("ws", ws),
            ("cb", cb),
            ("text", value),
        ],
    )?;
    io::install(s, State::default())?;
    io::on(s, ws, "open", 0, |s, _| {
        let c = s.get(c"c")?;
        io::send_json(
            s,
            s.get(c"ws")?,
            fields(
                s,
                &[
                    (
                        "app",
                        fields(
                            s,
                            &[
                                ("appid", c.get(c"appId")?),
                                ("token", c.get(c"accessToken")?),
                            ],
                        )?,
                    ),
                    ("user", fields(s, &[("uid", text(s, "multicc")?)])?),
                    (
                        "audio",
                        fields(
                            s,
                            &[("format", text(s, "pcm")?), ("rate", c.get(c"sampleRate")?)],
                        )?,
                    ),
                    (
                        "request",
                        fields(
                            s,
                            &[
                                ("operation", text(s, "query")?),
                                ("text", s.get(c"text")?),
                                ("text_type", text(s, "plain")?),
                            ],
                        )?,
                    ),
                ],
            )?,
        )?;
        io::callback(s, c"onReady", &[c.get(c"sampleRate")?])
    })?;
    io::on(s, ws, "message", 2, |s, a| {
        if !io::state::<State, _>(s, |v| v.finished)? && a[1].truthy()? {
            return io::callback(s, c"onAudio", &[io::buffer(s, &io::bytes(a[0])?)?]);
        }
        undef(s)
    })?;
    io::on(s, ws, "error", 1, |s, a| {
        if io::state::<State, _>(s, |v| {
            let old = v.finished;
            v.finished = true;
            old
        })? {
            return undef(s);
        }
        io::callback(
            s,
            c"onError",
            &[text(
                s,
                &format!(
                    "Volcano TTS connection error: {}",
                    fold_string(a[0].get(c"message")?)?
                ),
            )?],
        )
    })?;
    io::on(s, ws, "close", 0, |s, _| {
        if !io::state::<State, _>(s, |v| {
            let old = v.finished;
            v.finished = true;
            old
        })? {
            io::callback(s, c"onDone", &[])?;
        }
        undef(s)
    })?;
    methods(
        s,
        &[("stop", 0, |s, _| {
            io::state::<State, _>(s, |v| v.finished = true)?;
            call(s.get(c"ws")?, c"close", &[])
        })],
    )
}
fn stop(p: L<'_>) -> Result<()> {
    let session = p.get(c"session")?;
    if session.truthy()? && callable(session.get(c"stop")?)? {
        p.catch(|| call(session, c"stop", &[]))?;
    }
    p.set(c"session", null(p)?)
}
fn handle<'a>(owner: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = fields(
        owner,
        &[
            ("ports", owner.get(c"ports")?),
            ("cfg", owner.get(c"cfg")?),
            ("ws", a[0]),
            ("session", null(owner)?),
        ],
    )?;
    io::on(p, a[0], "message", 2, |p, a| {
        if a[1].truthy()? {
            return undef(p);
        }
        let Some(m) = io::parse_json(p, a[0])? else {
            return undef(p);
        };
        if m.get(c"type")?.is_string("start")? {
            let provider =
                io::default(m.get(c"provider")?, p.get(c"cfg")?.get(c"defaultProvider")?)?;
            let view = fields(p, &[("ws", p.get(c"ws")?), ("provider", provider)])?;
            let cb = methods(
                view,
                &[
                    ("onReady", 1, |v, a| {
                        io::send_json(
                            v,
                            v.get(c"ws")?,
                            fields(
                                v,
                                &[
                                    ("type", text(v, "ready")?),
                                    ("provider", v.get(c"provider")?),
                                    ("sampleRate", a[0]),
                                ],
                            )?,
                        )
                    }),
                    ("onAudio", 1, |v, a| {
                        let ws = v.get(c"ws")?;
                        if io::open(ws)? {
                            call(ws, c"send", &[a[0]])?;
                        }
                        undef(v)
                    }),
                    ("onDone", 0, |v, _| {
                        let ws = v.get(c"ws")?;
                        if io::open(ws)? {
                            io::send_json(v, ws, fields(v, &[("type", text(v, "done")?)])?)?;
                        }
                        undef(v)
                    }),
                    ("onError", 1, |v, a| {
                        let ws = v.get(c"ws")?;
                        if io::open(ws)? {
                            io::send_json(
                                v,
                                ws,
                                fields(v, &[("type", text(v, "error")?), ("message", a[0])])?,
                            )?;
                        }
                        undef(v)
                    }),
                ],
            )?;
            let opts = fields(p, &[("text", io::default(m.get(c"text")?, text(p, "")?)?)])?;
            let session = if provider.is_string("openai")? {
                openai(p, opts, cb)?
            } else if provider.is_string("volcano")? {
                volcano(p, opts, cb)?
            } else {
                edge(p, opts, cb)?
            };
            p.set(c"session", session)?;
            if !session.truthy()? {
                io::send_json(
                    p,
                    p.get(c"ws")?,
                    fields(
                        p,
                        &[
                            ("type", text(p, "error")?),
                            ("message", text(p, "Failed to create TTS session")?),
                        ],
                    )?,
                )?;
            }
        } else if m.get(c"type")?.is_string("stop")? {
            stop(p)?;
        }
        undef(p)
    })?;
    io::on(p, a[0], "close", 0, |p, _| {
        stop(p)?;
        undef(p)
    })?;
    undef(owner)
}
#[napi]
pub fn tts_service_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let owner = fields(p, &[("ports", p)])?;
    let cfg = config(owner)?;
    owner.set(c"cfg", cfg)?;
    let api = methods(
        owner,
        &[
            ("handleTtsWs", 2, handle),
            ("applyConfig", 1, apply),
            ("providerStatus", 0, status),
        ],
    )?;
    api.set(c"cfg", cfg)?;
    Ok(api.raw())
}
