//! Streaming ASR owner. Node provides only ws/agent and optional local SDK handles.
use crate::{host_api::*, voice_io as io};
use multicc_core::{js::JsValue, voice_asr as wire};
use napi_derive::napi;
use serde_json::json;

fn config(p: L<'_>) -> Result<L<'_>> {
    let cfg = fields(p, &[])?;
    cfg.set(
        c"defaultProvider",
        io::configured(p, &[(c"ASR_PROVIDER", "auto")])?.get(c"ASR_PROVIDER")?,
    )?;
    for (name, entries, rate) in [
        (
            c"openai" as &std::ffi::CStr,
            vec![
                (c"OPENAI_REALTIME_API_KEY", "apiKey", ""),
                (
                    c"OPENAI_REALTIME_URL",
                    "url",
                    "wss://api.openai.com/v1/realtime",
                ),
                (c"OPENAI_REALTIME_MODEL", "model", "gpt-4o-transcribe"),
            ],
            24000.,
        ),
        (
            c"volcano",
            vec![
                (c"VOLC_ASR_APP_ID", "appId", ""),
                (c"VOLC_ASR_ACCESS_TOKEN", "accessToken", ""),
                (
                    c"VOLC_ASR_RESOURCE_ID",
                    "resourceId",
                    "volc.bigasr.sauc.duration",
                ),
                (
                    c"VOLC_ASR_URL",
                    "url",
                    "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
                ),
            ],
            16000.,
        ),
        (
            c"funasr",
            vec![
                (c"FUNASR_WS_URL", "url", ""),
                (c"FUNASR_MODE", "mode", "2pass"),
            ],
            16000.,
        ),
    ] {
        let out = fields(p, &[])?;
        for (key, field, fallback) in entries {
            out.define_key(
                text(p, field)?,
                io::default(io::port(p, c"env")?.get(key)?, text(p, fallback)?)?,
            )?;
        }
        let rate = if name == c"openai" {
            let raw = io::default(
                io::port(p, c"env")?.get(c"OPENAI_REALTIME_SAMPLE_RATE")?,
                text(p, "24000")?,
            )?;
            p.global()?
                .get(c"parseInt")?
                .call_plain(&[raw, num(p, 10.)?])?
        } else {
            num(p, rate)?
        };
        out.set(c"sampleRate", rate)?;
        cfg.set(name, out)?;
    }
    Ok(cfg)
}
fn apply<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if !a[0].truthy()? {
        return undef(p);
    }
    let cfg = p.get(c"cfg")?;
    let u = a[0];
    io::set_if(cfg, u, c"ASR_PROVIDER", c"defaultProvider", true)?;
    for (section, keys) in [
        (
            c"openai" as &std::ffi::CStr,
            vec![
                (c"OPENAI_REALTIME_API_KEY", c"apiKey", false),
                (c"OPENAI_REALTIME_URL", c"url", true),
                (c"OPENAI_REALTIME_MODEL", c"model", true),
            ],
        ),
        (
            c"volcano",
            vec![
                (c"VOLC_ASR_APP_ID", c"appId", false),
                (c"VOLC_ASR_ACCESS_TOKEN", c"accessToken", false),
                (c"VOLC_ASR_RESOURCE_ID", c"resourceId", true),
                (c"VOLC_ASR_URL", c"url", true),
            ],
        ),
        (
            c"funasr",
            vec![
                (c"FUNASR_WS_URL", c"url", false),
                (c"FUNASR_MODE", c"mode", true),
            ],
        ),
    ] {
        for (from, to, truthy) in keys {
            io::set_if(cfg.get(section)?, u, from, to, truthy)?;
        }
    }
    let sample = u.get(c"OPENAI_REALTIME_SAMPLE_RATE")?;
    if sample.truthy()? {
        cfg.get(c"openai")?.set(
            c"sampleRate",
            io::default(
                p.global()?
                    .get(c"parseInt")?
                    .call_plain(&[sample, num(p, 10.)?])?,
                num(p, 24000.)?,
            )?,
        )?;
    }
    undef(p)
}
fn resolve<'a>(p: L<'a>, requested: L<'a>) -> Result<L<'a>> {
    if requested.truthy()? && !requested.is_string("auto")? {
        return Ok(requested);
    }
    if call(io::port(p, c"asrLocal")?, c"isAvailable", &[])?.truthy()? {
        return text(p, "local");
    }
    let cfg = p.get(c"cfg")?;
    if cfg.get(c"openai")?.get(c"apiKey")?.truthy()? {
        return text(p, "openai");
    }
    let volc = cfg.get(c"volcano")?;
    if volc.get(c"appId")?.truthy()? && volc.get(c"accessToken")?.truthy()? {
        return text(p, "volcano");
    }
    if cfg.get(c"funasr")?.get(c"url")?.truthy()? {
        return text(p, "funasr");
    }
    null(p)
}
fn rate<'a>(p: L<'a>, provider: L<'a>) -> Result<L<'a>> {
    if provider.is_string("local")? {
        return num(p, 16000.);
    }
    let cfg = p.get(c"cfg")?;
    io::default(
        io::default(cfg.get_key(provider)?, cfg.get(c"openai")?)?.get(c"sampleRate")?,
        num(p, 16000.)?,
    )
}
fn status<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let cfg = p.get(c"cfg")?;
    let local = call(io::port(p, c"asrLocal")?, c"status", &[])?;
    let openai = cfg.get(c"openai")?;
    let volc = cfg.get(c"volcano")?;
    let fun = cfg.get(c"funasr")?;
    Ok(fields(
        p,
        &[
            (
                "default",
                io::default(resolve(p, cfg.get(c"defaultProvider")?)?, text(p, "none")?)?,
            ),
            (
                "local",
                pick(local, &[c"ready", c"model", c"loaded", c"sampleRate"])?,
            ),
            (
                "openai",
                fields(
                    p,
                    &[
                        ("ready", flag(p, openai.get(c"apiKey")?.truthy()?)?),
                        ("model", openai.get(c"model")?),
                        ("sampleRate", openai.get(c"sampleRate")?),
                    ],
                )?,
            ),
            (
                "volcano",
                fields(
                    p,
                    &[
                        (
                            "ready",
                            flag(
                                p,
                                volc.get(c"appId")?.truthy()?
                                    && volc.get(c"accessToken")?.truthy()?,
                            )?,
                        ),
                        ("sampleRate", volc.get(c"sampleRate")?),
                    ],
                )?,
            ),
            (
                "funasr",
                fields(
                    p,
                    &[
                        ("ready", flag(p, fun.get(c"url")?.truthy()?)?),
                        ("mode", fun.get(c"mode")?),
                        ("sampleRate", fun.get(c"sampleRate")?),
                    ],
                )?,
            ),
        ],
    )?)
}
fn browser_send<'a>(p: L<'a>, body: L<'a>) -> Result<L<'a>> {
    p.catch(|| io::send_json(p, p.get(c"ws")?, body))?;
    undef(p)
}
fn callbacks(p: L<'_>) -> Result<L<'_>> {
    methods(
        p,
        &[
            ("onReady", 0, |p, _| {
                browser_send(
                    p,
                    fields(
                        p,
                        &[
                            ("type", text(p, "ready")?),
                            ("provider", p.get(c"provider")?),
                            ("sampleRate", rate(p, p.get(c"provider")?)?),
                        ],
                    )?,
                )
            }),
            ("onPartial", 1, |p, a| {
                let t = string(a[0])?.coerce_string()?;
                let mut out = io::state::<wire::Browser, _>(p, |s| s.aggregate.clone())?;
                out.push(&t);
                browser_send(
                    p,
                    fields(
                        p,
                        &[
                            ("type", text(p, "partial")?),
                            ("text", p.from_value(&JsValue::String(out))?),
                        ],
                    )?,
                )
            }),
            ("onFinal", 1, |p, a| {
                let t = string(a[0])?.coerce_string()?;
                let out = io::state::<wire::Browser, _>(p, |s| {
                    s.aggregate.push(&t);
                    s.aggregate.clone()
                })?;
                browser_send(
                    p,
                    fields(
                        p,
                        &[
                            ("type", text(p, "final")?),
                            ("text", p.from_value(&JsValue::String(out))?),
                        ],
                    )?,
                )
            }),
            ("onDone", 0, |p, _| {
                let out = io::state::<wire::Browser, _>(p, |s| s.aggregate.clone())?;
                browser_send(
                    p,
                    fields(
                        p,
                        &[
                            ("type", text(p, "done")?),
                            ("text", p.from_value(&JsValue::String(out))?),
                        ],
                    )?,
                )
            }),
            // onError is built below with two arguments: `code` is optional.
        ],
    )
}
fn terminate<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let upstream = p.get(c"upstream")?;
    if upstream.truthy()? {
        call(upstream, c"close", &[])?;
    }
    p.set(c"upstream", null(p)?)?;
    io::state::<wire::Browser, _>(p, |s| s.pcm.clear())?;
    undef(p)
}
fn browser_message<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if a[1].truthy()? {
        let upstream = p.get(c"upstream")?;
        if upstream.truthy()? {
            let result = (|| {
                let bytes = io::bytes(a[0])?;
                let samples = io::state::<wire::Browser, _>(p, |s| s.pcm.push(&bytes))?;
                if !samples.is_empty() {
                    call(upstream, c"pushAudio", &[io::i16_array(p, samples)?])?;
                }
                undef(p)
            })();
            if let Err(e) = result {
                let msg = io::message(p, e)?;
                io::callback(
                    p,
                    c"onError",
                    &[text(p, &format!("Invalid audio frame: {msg}"))?],
                )?;
                p.catch(|| call(upstream, c"close", &[]))?;
                p.set(c"upstream", null(p)?)?;
                io::state::<wire::Browser, _>(p, |s| s.pcm.clear())?;
            }
        }
        return undef(p);
    }
    let Some(m) = io::parse_json(p, a[0])? else {
        return undef(p);
    };
    if m.get(c"type")?.is_string("start")? {
        let requested = m.get(c"provider")?;
        let requested = if requested.truthy()? && !requested.is_string("auto")? {
            requested
        } else {
            p.get(c"cfg")?.get(c"defaultProvider")?
        };
        let provider = resolve(p, requested)?;
        p.set(c"provider", provider)?;
        io::state::<wire::Browser, _>(p, |s| s.pcm.clear())?;
        if !provider.truthy()? {
            io::callback(
                p,
                c"onError",
                &[
                    text(p, "语音识别未就绪：本地模型未安装，也没有配置云端识别")?,
                    text(p, "voice_not_ready")?,
                ],
            )?;
            return undef(p);
        }
        let opts = fields(p, &[("lang", m.get(c"lang")?)])?;
        match create_session(p, provider, opts) {
            Ok(v) => p.set(c"upstream", v)?,
            Err(e) => {
                let message = io::message(p, e)?;
                io::callback(p, c"onError", &[text(p, &message)?])?;
            }
        }
    } else if m.get(c"type")?.is_string("stop")? {
        io::state::<wire::Browser, _>(p, |s| s.pcm.clear())?;
        let upstream = p.get(c"upstream")?;
        if upstream.truthy()? {
            call(upstream, c"finish", &[])?;
        }
    }
    undef(p)
}
fn handle<'a>(owner: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = fields(
        owner,
        &[
            ("ports", owner.get(c"ports")?),
            ("cfg", owner.get(c"cfg")?),
            ("ws", a[0]),
            ("provider", text(owner, "")?),
            ("upstream", null(owner)?),
        ],
    )?;
    io::install(p, wire::Browser::default())?;
    let cb = callbacks(p)?;
    cb.set(
        c"onError",
        function(p, "onError", 2, 2, |p, a| {
            let body = fields(p, &[("type", text(p, "error")?), ("message", a[0])])?;
            if a[1].truthy()? {
                body.set(c"code", a[1])?;
            }
            browser_send(p, body)
        })?,
    )?;
    p.set(c"cb", cb)?;
    io::on(p, a[0], "message", 2, browser_message)?;
    io::on(p, a[0], "close", 0, terminate)?;
    io::on(p, a[0], "error", 0, terminate)?;
    undef(owner)
}
fn create_session<'a>(p: L<'a>, provider: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    if provider.is_string("local")? {
        return call(
            io::port(p, c"asrLocal")?,
            c"createStreamingSession",
            &[opts, p.get(c"cb")?],
        );
    }
    let name = if provider.is_string("volcano")? {
        "volcano"
    } else if provider.is_string("funasr")? {
        "funasr"
    } else {
        "openai"
    };
    let c = p.get(c"cfg")?.get_key(text(p, name)?)?;
    let missing = match name {
        "volcano" => !(c.get(c"appId")?.truthy()? && c.get(c"accessToken")?.truthy()?),
        "funasr" => !c.get(c"url")?.truthy()?,
        _ => !c.get(c"apiKey")?.truthy()?,
    };
    if missing {
        io::callback(
            p,
            c"onError",
            &[text(
                p,
                match name {
                    "volcano" => "火山 AppID/AccessToken 未配置",
                    "funasr" => "FUNASR_WS_URL 未配置",
                    _ => "OPENAI_REALTIME_API_KEY 未配置",
                },
            )?],
        )?;
        return null(p);
    }
    let options = fields(p, &[("agent", io::port(p, c"outboundAgent")?)])?;
    if name == "openai" {
        options.set(
            c"headers",
            fields(
                p,
                &[
                    (
                        "Authorization",
                        text(p, &format!("Bearer {}", fold_string(c.get(c"apiKey")?)?))?,
                    ),
                    ("OpenAI-Beta", text(p, "realtime=v1")?),
                ],
            )?,
        )?;
    } else if name == "funasr" {
        options.set(c"rejectUnauthorized", flag(p, false)?)?;
    } else {
        let date = num(p, io::clock(p)?)?;
        let id = fold_string(call(date, c"toString", &[num(p, 36.)?])?)?;
        options.set(
            c"headers",
            fields(
                p,
                &[
                    ("X-Api-App-Key", c.get(c"appId")?),
                    ("X-Api-Access-Key", c.get(c"accessToken")?),
                    ("X-Api-Resource-Id", c.get(c"resourceId")?),
                    ("X-Api-Connect-Id", text(p, &format!("mc_{id}"))?),
                ],
            )?,
        )?;
    }
    let ws = io::port(p, c"WebSocket")?.construct(&[c.get(c"url")?, options])?;
    let s = fields(
        p,
        &[
            ("ports", p.get(c"ports")?),
            ("cb", p.get(c"cb")?),
            ("c", c),
            ("opts", opts),
            ("ws", ws),
            ("name", text(p, name)?),
        ],
    )?;
    io::install(
        s,
        wire::Upstream {
            seq: 1,
            ..Default::default()
        },
    )?;
    io::on(s, ws, "open", 0, opened)?;
    io::on(s, ws, "message", 1, received)?;
    io::on(s, ws, "error", 1, |s, a| {
        io::callback(s, c"onError", &[a[0].get(c"message")?])
    })?;
    io::on(s, ws, "close", 0, |s, _| {
        if !io::state::<wire::Upstream, _>(s, |v| v.finished)? {
            io::callback(s, c"onDone", &[])?;
        }
        undef(s)
    })?;
    methods(
        s,
        &[
            ("pushAudio", 1, push),
            ("finish", 0, finish),
            ("close", 0, |s, _| {
                io::state::<wire::Upstream, _>(s, |v| v.finished = true)?;
                s.catch(|| call(s.get(c"ws")?, c"close", &[]))?;
                undef(s)
            }),
        ],
    )
}
fn opened<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    io::state::<wire::Upstream, _>(s, |v| v.open = true)?;
    let c = s.get(c"c")?;
    let name = fold_string(s.get(c"name")?)?;
    let lang = s.get(c"opts")?.get(c"lang")?;
    let body = match name.as_str() {
        "openai" => {
            let body = io::json(
                s,
                &json!({"type":"session.update","session":{"input_audio_format":"pcm16","input_audio_transcription":{},"turn_detection":{"type":"server_vad","silence_duration_ms":500}}}),
            )?;
            let transcription = body.get(c"session")?.get(c"input_audio_transcription")?;
            transcription.set(c"model", c.get(c"model")?)?;
            if lang.truthy()? && !lang.is_string("auto")? {
                transcription.set(c"language", lang)?;
            }
            body
        }
        "funasr" => {
            let body = io::json(
                s,
                &json!({"mode":null,"chunk_size":[5,10,5],"chunk_interval":10,"wav_name":"multicc","is_speaking":true,"itn":true}),
            )?;
            body.set(c"mode", c.get(c"mode")?)?;
            body
        }
        _ => {
            let body = io::json(
                s,
                &json!({"user":{"uid":"multicc"},"audio":{"format":"pcm","rate":16000,"bits":16,"channel":1},"request":{"model_name":"bigmodel","enable_itn":true,"enable_punc":true,"result_type":"single"}}),
            )?;
            body.get(c"audio")?.set(c"rate", c.get(c"sampleRate")?)?;
            if lang.truthy()? && !lang.is_string("auto")? {
                body.get(c"request")?.set(c"language", lang)?;
            }
            body
        }
    };
    if name == "volcano" {
        let seq = io::state::<wire::Upstream, _>(s, |v| {
            let n = v.seq;
            v.seq += 1;
            n
        })?;
        let data = fold_string(json_call(s, c"stringify", body)?)?;
        let frame = wire::frame(1, 1, true, Some(seq), data.as_bytes())
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        call(s.get(c"ws")?, c"send", &[io::buffer(s, &frame)?])?;
    } else {
        io::send_json(s, s.get(c"ws")?, body)?;
    }
    io::callback(s, c"onReady", &[])
}
fn received<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if s.get(c"name")?.is_string("volcano")? {
        // The deployed adapter swallows malformed packets, including callback errors.
        s.catch(|| {
            if let Some((kind, seq, j)) = wire::response(&io::bytes(a[0])?) {
                let m = json_call(s, c"parse", text(s, &String::from_utf8_lossy(&j))?)?;
                if kind == 15 {
                    return io::callback(
                        s,
                        c"onError",
                        &[io::default(
                            m.get(c"error")?,
                            text(s, "volcano asr error")?,
                        )?],
                    );
                }
                let result = io::default(m.get(c"result")?, fields(s, &[])?)?;
                let text = result.get(c"text")?;
                if text.truthy()? {
                    io::callback(
                        s,
                        if result.get(c"definite")?.truthy()? || seq < 0 {
                            c"onFinal"
                        } else {
                            c"onPartial"
                        },
                        &[text],
                    )?;
                }
            }
            undef(s)
        })?;
        return undef(s);
    }
    let Some(m) = io::parse_json(s, a[0])? else {
        return undef(s);
    };
    if s.get(c"name")?.is_string("funasr")? {
        let text = m.get(c"text")?;
        if text.truthy()? {
            io::callback(
                s,
                if m.get(c"mode")?.is_string("2pass-offline")? || m.get(c"is_final")?.truthy()? {
                    c"onFinal"
                } else {
                    c"onPartial"
                },
                &[text],
            )?;
        }
    } else if m
        .get(c"type")?
        .is_string("conversation.item.input_audio_transcription.delta")?
    {
        let t = m.get(c"delta")?;
        if t.truthy()? {
            io::callback(s, c"onPartial", &[t])?;
        }
    } else if m
        .get(c"type")?
        .is_string("conversation.item.input_audio_transcription.completed")?
    {
        let t = m.get(c"transcript")?;
        if t.truthy()? {
            io::callback(s, c"onFinal", &[t])?;
        }
    } else if m.get(c"type")?.is_string("error")? {
        io::callback(
            s,
            c"onError",
            &[io::default(
                m.get(c"error")?.optional(c"message")?,
                text(s, "OpenAI realtime error")?,
            )?],
        )?;
    }
    undef(s)
}
fn audio<'a>(s: L<'a>, data: &[u8], last: bool) -> Result<L<'a>> {
    let ws = s.get(c"ws")?;
    if !io::open(ws)? {
        return undef(s);
    }
    if s.get(c"name")?.is_string("volcano")? {
        let seq = io::state::<wire::Upstream, _>(s, |v| {
            let n = v.seq;
            v.seq += 1;
            if last {
                -n
            } else {
                n
            }
        })?;
        let b = wire::frame(2, if last { 3 } else { 1 }, false, Some(seq), data)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        call(ws, c"send", &[io::buffer(s, &b)?])
    } else if s.get(c"name")?.is_string("funasr")? {
        call(ws, c"send", &[io::buffer(s, data)?])
    } else {
        io::send_json(
            s,
            ws,
            io::json(
                s,
                &json!({"type":"input_audio_buffer.append","audio":wire::base64(data)}),
            )?,
        )
    }
}
fn push<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if !io::state::<wire::Upstream, _>(s, |v| v.open)? {
        return undef(s);
    }
    audio(s, &io::bytes(a[0])?, false)
}
fn finish<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let open = io::state::<wire::Upstream, _>(s, |v| {
        v.finished = true;
        v.open
    })?;
    let name = fold_string(s.get(c"name")?)?;
    if open && io::open(s.get(c"ws")?)? {
        if name == "volcano" {
            audio(s, &[], true)?;
        } else {
            s.catch(|| {
                io::send_json(
                    s,
                    s.get(c"ws")?,
                    io::json(
                        s,
                        &if name == "openai" {
                            json!({"type":"input_audio_buffer.commit"})
                        } else {
                            json!({"is_speaking":false})
                        },
                    )?,
                )
            })?;
        }
    }
    io::timer(s, if name == "openai" { 1200. } else { 1500. }, |s, _| {
        s.catch(|| call(s.get(c"ws")?, c"close", &[]))?;
        io::callback(s, c"onDone", &[])
    })?;
    undef(s)
}
#[napi]
pub fn voice_asr_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let owner = fields(p, &[("ports", p)])?;
    let cfg = config(owner)?;
    owner.set(c"cfg", cfg)?;
    let api = defaulted_methods(
        owner,
        &[
            ("handleVoiceWs", 3, 3, handle),
            ("applyConfig", 1, 1, apply),
            ("providerStatus", 0, 0, status),
            ("targetSampleRate", 1, 1, |p, a| rate(p, a[0])),
        ],
    )?;
    api.set(c"cfg", cfg)?;
    Ok(api.raw())
}
