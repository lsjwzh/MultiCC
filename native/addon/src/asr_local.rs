//! Local ASR owner. Only sherpa's native SDK handles remain in the Node realm.
//! Sync inference entrypoints retain their historical sync ABI; file decode is
//! Promise based and ffmpeg runs asynchronously through the host process port.
use crate::{host_api::*, voice_io as io};
use multicc_core::{
    js::{JsString, JsValue},
    voice_audio as audio,
};
use napi_derive::napi;

#[derive(Default)]
struct Local {
    sdk_attempted: bool,
    sdk_error: String,
    loaded: bool,
    load_ms: f64,
    warm: bool,
    vocab_at: f64,
    vocab: Vec<Vec<u16>>,
}
fn words(p: L<'_>) -> Result<L<'_>> {
    io::port(p, c"voiceConfig")?.call_plain(&[])
}
fn print(p: L<'_>, error: bool, message: &str) -> Result<()> {
    let logger = io::default(io::port(p, c"console")?, p.global()?.get(c"console")?)?;
    call(
        logger,
        if error { c"error" } else { c"log" },
        &[text(p, message)?],
    )?;
    Ok(())
}
fn join<'a>(p: L<'a>, names: &[L<'a>]) -> Result<L<'a>> {
    call(io::port(p, c"path")?, c"join", names)
}
fn model_dir(p: L<'_>) -> Result<L<'_>> {
    join(
        p,
        &[
            p.get(c"cfg")?.get(c"ASR_LOCAL_MODEL_DIR")?,
            text(p, multicc_core::asr_model_installer::SV_DIR)?,
        ],
    )
}
fn files(p: L<'_>) -> Result<bool> {
    Ok(p.catch(|| {
        let fs = io::port(p, c"fs")?;
        let model = model_dir(p)?;
        flag(
            p,
            call(
                fs,
                c"existsSync",
                &[join(p, &[model, text(p, "model.int8.onnx")?])?],
            )?
            .truthy()?
                && call(
                    fs,
                    c"existsSync",
                    &[join(p, &[model, text(p, "tokens.txt")?])?],
                )?
                .truthy()?,
        )
    })?
    .is_some_and(|v| v.truthy().unwrap_or(false)))
}
fn sdk(p: L<'_>) -> Result<L<'_>> {
    if io::state::<Local, _>(p, |s| s.sdk_attempted)? {
        return p.get(c"sdk");
    }
    io::state::<Local, _>(p, |s| s.sdk_attempted = true)?;
    match io::port(p, c"loadSherpa")?.call_plain(&[]) {
        Ok(value) => {
            p.set(c"sdk", value)?;
            Ok(value)
        }
        Err(e) => {
            let message = io::message(p, e)?;
            io::state::<Local, _>(p, |s| s.sdk_error = message.clone())?;
            p.set(c"sdk", null(p)?)?;
            io::log(
                p,
                "[multicc/asr-local] sherpa-onnx-node not loadable, local ASR disabled:",
                &message,
            )?;
            null(p)
        }
    }
}
fn available(p: L<'_>) -> Result<bool> {
    let mode = p.get(c"cfg")?.get(c"ASR_LOCAL")?;
    if mode.is_string("off")? || mode.is_string("0")? || mode.is_string("false")? {
        return Ok(false);
    }
    Ok(files(p)? && sdk(p)?.truthy()?)
}
fn recognizer(p: L<'_>) -> Result<L<'_>> {
    let cached = p.get(c"recognizer")?;
    if cached.truthy()? {
        return Ok(cached);
    }
    let s = sdk(p)?;
    if !s.truthy()? {
        let reason = io::state::<Local, _>(p, |v| v.sdk_error.clone())?;
        return Err(napi::Error::from_reason(format!(
            "sherpa-onnx-node 不可用: {}",
            if reason.is_empty() {
                "unknown"
            } else {
                &reason
            }
        )));
    }
    if !files(p)? {
        return Err(napi::Error::from_reason(format!(
            "本地 ASR 模型缺失: {}（运行 scripts/setup-local-asr.sh 下载）",
            fold_string(model_dir(p)?)?
        )));
    }
    let cfg = p.get(c"cfg")?;
    let at = io::clock(p)?;
    let dir = model_dir(p)?;
    let threads = io::default(
        p.global()?
            .get(c"parseInt")?
            .call_plain(&[cfg.get(c"ASR_LOCAL_THREADS")?, num(p, 10.)?])?,
        num(p, 2.)?,
    )?;
    let rec = s.get(c"OfflineRecognizer")?.construct(&[fields(
        p,
        &[(
            "modelConfig",
            fields(
                p,
                &[
                    (
                        "senseVoice",
                        fields(
                            p,
                            &[
                                ("model", join(p, &[dir, text(p, "model.int8.onnx")?])?),
                                ("language", cfg.get(c"ASR_LOCAL_LANGUAGE")?),
                                ("useInverseTextNormalization", num(p, 1.)?),
                            ],
                        )?,
                    ),
                    ("tokens", join(p, &[dir, text(p, "tokens.txt")?])?),
                    ("numThreads", threads),
                    ("provider", text(p, "cpu")?),
                    ("debug", num(p, 0.)?),
                ],
            )?,
        )],
    )?])?;
    p.set(c"recognizer", rec)?;
    let ms = io::clock(p)? - at;
    io::state::<Local, _>(p, |v| {
        v.loaded = true;
        v.load_ms = ms;
    })?;
    print(
        p,
        false,
        &format!(
            "[multicc/asr-local] SenseVoice loaded in {ms}ms (threads={})",
            fold_string(cfg.get(c"ASR_LOCAL_THREADS")?)?
        ),
    )?;
    Ok(rec)
}
fn correct<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    if !input.truthy()? {
        return Ok(input);
    }
    let at = io::clock(p)?;
    if io::state::<Local, _>(p, |s| at - s.vocab_at >= 30000.)? {
        let mut terms = Vec::new();
        let success = p
            .catch(|| {
                let list = call(
                    call(words(p)?, c"loadWhisperVocab", &[])?,
                    c"slice",
                    &[num(p, 0.)?, num(p, 40.)?],
                )?;
                list.for_each(|entry| {
                    let term = entry.get(c"term")?;
                    let candidate = string(term)?.coerce_string()?;
                    if audio::vocabulary_term(candidate.as_units()) {
                        // Preserve coercing RegExp.test followed by the original split.
                        call(term, c"split", &[text(p, "")?])?;
                        terms.push(candidate.as_units().to_vec());
                    }
                    Ok(())
                })?;
                undef(p)
            })?
            .is_some();
        io::state::<Local, _>(p, |s| {
            s.vocab_at = at;
            s.vocab = if success { terms } else { Vec::new() };
        })?;
    }
    let terms = io::state::<Local, _>(p, |s| s.vocab.clone())?;
    let mut out = input;
    if !terms.is_empty() {
        let units = input
            .string()?
            .ok_or_else(|| input.type_error("out.replace is not a function"))?;
        out = p.from_value(&JsValue::String(JsString::from_units(
            audio::correct_vocab(units.as_units(), &terms),
        )))?;
    }
    if let Some(value) = p.catch(|| {
        io::port(p, c"correctWithHotwords")?
            .call_plain(&[out, call(words(p)?, c"hotwordList", &[])?])
    })? {
        out = value;
    }
    Ok(out)
}
fn transcribe<'a>(p: L<'a>, samples: L<'a>, rate: L<'a>) -> Result<L<'a>> {
    let rec = recognizer(p)?;
    let at = io::clock(p)?;
    let stream = call(rec, c"createStream", &[])?;
    call(
        stream,
        c"acceptWaveform",
        &[fields(p, &[("sampleRate", rate), ("samples", samples)])?],
    )?;
    call(rec, c"decode", &[stream])?;
    let result = call(rec, c"getResult", &[stream])?;
    let text = call(
        io::default(result.get(c"text")?, text(p, "")?)?,
        c"trim",
        &[],
    )?;
    let text = correct(p, text)?;
    fields(
        p,
        &[("text", text), ("decodeMs", num(p, io::clock(p)? - at)?)],
    )
}
fn warmup<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        if io::state::<Local, _>(p, |s| s.warm)? || !available(p)? {
            return undef(p);
        }
        let result = (|| {
            let rec = recognizer(p)?;
            let stream = call(rec, c"createStream", &[])?;
            call(
                stream,
                c"acceptWaveform",
                &[fields(
                    p,
                    &[
                        ("sampleRate", num(p, 16000.)?),
                        ("samples", io::f32_array(p, vec![0.; 8000])?),
                    ],
                )?],
            )?;
            call(rec, c"decode", &[stream])?;
            call(rec, c"getResult", &[stream])?;
            io::state::<Local, _>(p, |s| s.warm = true)?;
            print(p, false, "[multicc/asr-local] warmup complete")?;
            undef(p)
        })();
        if let Err(e) = result {
            let message = io::message(p, e)?;
            io::log(p, "[multicc/asr-local] warmup failed:", &message)?;
        }
        undef(p)
    })
}
#[derive(Default)]
struct Decode {
    bytes: Vec<u8>,
    stderr: String,
}
fn ffmpeg<'a>(p: L<'a>, buf: L<'a>) -> Result<L<'a>> {
    let s = fields(p, &[("ports", p.get(c"ports")?), ("buffer", buf)])?;
    io::install(s, Decode::default())?;
    p.global()?
        .get(c"Promise")?
        .construct(&[function(s, "decode", 2, 2, move |s, a| {
            s.set(c"resolve", a[0])?;
            s.set(c"reject", a[1])?;
            // `buffer` is kept in the owner by the caller before entering this executor.
            let proc = io::port(s, c"spawn")?.call_plain(&[
                text(s, "ffmpeg")?,
                io::json(
                    s,
                    &serde_json::json!([
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-i",
                        "pipe:0",
                        "-f",
                        "f32le",
                        "-ac",
                        "1",
                        "-ar",
                        "16000",
                        "pipe:1"
                    ]),
                )?,
            ])?;
            s.set(c"proc", proc)?;
            let timer = io::timer(s, 15000., |s, _| {
                s.catch(|| call(s.get(c"proc")?, c"kill", &[text(s, "SIGKILL")?]))?;
                s.get(c"reject")?
                    .call_plain(&[error_value(s, "ffmpeg 解码超时")?])
            })?;
            s.set(c"timer", timer)?;
            io::on(s, proc.get(c"stdout")?, "data", 1, |s, a| {
                let b = io::bytes(a[0])?;
                io::state::<Decode, _>(s, |d| d.bytes.extend_from_slice(&b))?;
                undef(s)
            })?;
            io::on(s, proc.get(c"stderr")?, "data", 1, |s, a| {
                let t = fold_string(call(a[0], c"toString", &[])?)?;
                io::state::<Decode, _>(s, |d| d.stderr.push_str(&t))?;
                undef(s)
            })?;
            io::on(s, proc, "error", 1, |s, a| {
                io::cancel(s, s.get(c"timer")?)?;
                s.get(c"reject")?.call_plain(&[error_value(
                    s,
                    &format!("ffmpeg 不可用: {}", fold_string(a[0].get(c"message")?)?),
                )?])
            })?;
            io::on(s, proc, "close", 1, |s, a| {
                io::cancel(s, s.get(c"timer")?)?;
                if !a[0].is_number(0.)? {
                    let err = io::state::<Decode, _>(s, |d| d.stderr.clone())?;
                    let err = JsString::from_rust_str(&err)
                        .truncate_units(200)
                        .to_string_lossy();
                    return s.get(c"reject")?.call_plain(&[error_value(
                        s,
                        &format!("ffmpeg 解码失败 ({}): {err}", fold_string(a[0])?),
                    )?]);
                }
                let b = io::state::<Decode, _>(s, |d| d.bytes.clone())?;
                s.get(c"resolve")?
                    .call_plain(&[io::f32_array(s, audio::floats(&b))?])
            })?;
            io::on(s, proc.get(c"stdin")?, "error", 0, |s, _| undef(s))?;
            call(proc.get(c"stdin")?, c"end", &[s.get(c"buffer")?])?;
            undef(s)
        })?])
}
fn buffer_result<'a>(p: L<'a>, samples: L<'a>, rate: f64, at: f64) -> Result<L<'a>> {
    let decode_ms = io::clock(p)? - at;
    let length = samples.get(c"length")?.number()?;
    if length == 0. {
        return Err(napi::Error::from_reason("音频解码后为空"));
    }
    let out = transcribe(p, samples, num(p, rate)?)?;
    fields(
        p,
        &[
            ("text", out.get(c"text")?),
            ("ms", num(p, io::clock(p)? - at)?),
            ("decodeMs", num(p, decode_ms)?),
            ("inferMs", out.get(c"decodeMs")?),
            ("audioSec", num(p, length / rate)?),
        ],
    )
}
fn transcribe_buffer<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let at = io::clock(p)?;
        let bytes = io::bytes(a[0])?;
        let aligned = a[0].get(c"byteOffset")?.number().unwrap_or(0.) % 2. == 0.;
        if let Some((samples, rate)) = if aligned { audio::wav(&bytes) } else { None } {
            return buffer_result(p, io::f32_array(p, samples)?, rate as f64, at);
        }
        let frame = fields(
            p,
            &[
                ("ports", p.get(c"ports")?),
                ("owner", p),
                ("buffer", a[0]),
                ("at", num(p, at)?),
            ],
        )?;
        let job = ffmpeg(frame, a[0])?;
        then(job, frame, |f, a| {
            buffer_result(f.get(c"owner")?, a[0], 16000., f.get(c"at")?.number()?)
        })
    })
}
fn float_audio(v: L<'_>) -> Result<Vec<f32>> {
    let is_buffer = call(v.global()?.get(c"Buffer")?, c"isBuffer", &[v])?.truthy()?;
    let samples = if is_buffer {
        v.global()?.get(c"Int16Array")?.construct(&[
            v.get(c"buffer")?,
            v.get(c"byteOffset")?,
            num(v, (v.get(c"byteLength")?.number()? / 2.).floor())?,
        ])?
    } else {
        v
    };
    Ok(audio::pcm_float(&io::bytes(samples)?))
}
fn drain(p: L<'_>) -> Result<()> {
    let vad = p.get(c"vad")?;
    let owner = p.get(c"owner")?;
    while !call(vad, c"isEmpty", &[])?.truthy()? {
        let seg = call(vad, c"front", &[])?;
        call(vad, c"pop", &[])?;
        if !seg.truthy()? {
            continue;
        }
        let mut samples = seg.get(c"samples")?;
        if !samples.truthy()? || !samples.get(c"length")?.truthy()? {
            continue;
        }
        let start = seg.get(c"start")?;
        if start.kind()? == sys::ValueType::napi_number {
            let begin = start.number()?;
            let len = samples.get(c"length")?.number()?;
            let stored = io::state::<audio::Stream, _>(p, |s| s.len)?;
            if begin + len <= stored as f64 {
                let padded = io::state::<audio::Stream, _>(p, |s| {
                    s.slice(
                        (begin - audio::PAD as f64).max(0.) as usize,
                        (begin + len + audio::PAD as f64) as usize,
                    )
                })?;
                if let Some(values) = padded {
                    samples = io::f32_array(p, values)?;
                }
            }
        }
        let result = (|| {
            let out = transcribe(owner, samples, num(p, 16000.)?)?;
            let text = out.get(c"text")?;
            if text.truthy()? {
                io::state::<audio::Stream, _>(p, |s| s.emitted = true)?;
                io::callback(p, c"onFinal", &[text])?;
            }
            undef(p)
        })();
        if let Err(e) = result {
            let message = io::message(p, e)?;
            io::callback(
                p,
                c"onError",
                &[text(p, &format!("本地转写失败: {message}"))?],
            )?;
        }
    }
    Ok(())
}
fn streaming<'a>(owner: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cb = a[1];
    let s = sdk(owner)?;
    if !s.truthy()? || !available(owner)? {
        call(
            cb,
            c"onError",
            &[text(owner, "本地 ASR 未就绪（模型缺失或 addon 不可用）")?],
        )?;
        return null(owner);
    }
    if let Err(e) = recognizer(owner) {
        let msg = io::message(owner, e)?;
        call(cb, c"onError", &[text(owner, &msg)?])?;
        return null(owner);
    }
    let model = join(
        owner,
        &[
            owner.get(c"cfg")?.get(c"ASR_LOCAL_MODEL_DIR")?,
            text(owner, "silero_vad.onnx")?,
        ],
    )?;
    let config = io::json(
        owner,
        &serde_json::json!({"sileroVad":{"model":null,"threshold":0.5,"minSilenceDuration":0.25,"minSpeechDuration":0.15,"maxSpeechDuration":15,"windowSize":512},"sampleRate":16000,"numThreads":1,"provider":"cpu","debug":false}),
    )?;
    config.get(c"sileroVad")?.set(c"model", model)?;
    let vad = match s.get(c"Vad")?.construct(&[config, num(owner, 60.)?]) {
        Ok(v) => v,
        Err(e) => {
            let msg = io::message(owner, e)?;
            call(
                cb,
                c"onError",
                &[text(owner, &format!("VAD 初始化失败: {msg}"))?],
            )?;
            return null(owner);
        }
    };
    let p = fields(
        owner,
        &[
            ("ports", owner.get(c"ports")?),
            ("owner", owner),
            ("cb", cb),
            ("vad", vad),
        ],
    )?;
    io::install(p, audio::Stream::default())?;
    io::global_port(p, c"queueMicrotask")?.call_plain(&[function(
        p,
        "asrReady",
        0,
        0,
        |p, _| {
            if !io::state::<audio::Stream, _>(p, |s| s.closed)? {
                io::callback(p, c"onReady", &[])?;
            }
            undef(p)
        },
    )?])?;
    methods(
        p,
        &[
            ("pushAudio", 1, |p, a| {
                if io::state::<audio::Stream, _>(p, |s| s.closed)? {
                    return undef(p);
                }
                let samples = float_audio(a[0])?;
                io::state::<audio::Stream, _>(p, |s| s.retain(&samples))?;
                let result = (|| {
                    let windows = io::state::<audio::Stream, _>(p, |s| s.windows(&samples))?;
                    for window in windows {
                        call(
                            p.get(c"vad")?,
                            c"acceptWaveform",
                            &[io::f32_array(p, window)?],
                        )?;
                    }
                    drain(p)?;
                    undef(p)
                })();
                if let Err(e) = result {
                    let msg = io::message(p, e)?;
                    io::callback(p, c"onError", &[text(p, &msg)?])?;
                }
                undef(p)
            }),
            ("finish", 0, |p, _| {
                if io::state::<audio::Stream, _>(p, |s| {
                    let old = s.closed;
                    s.closed = true;
                    old
                })? {
                    return undef(p);
                }
                let result = (|| {
                    let vad = p.get(c"vad")?;
                    if callable(vad.get(c"flush")?)? {
                        call(vad, c"flush", &[])?;
                    }
                    drain(p)?;
                    let fallback = io::state::<audio::Stream, _>(p, |s| {
                        if !s.emitted && s.len > 4800 {
                            s.slice(0, s.len)
                        } else {
                            None
                        }
                    })?;
                    if let Some(all) = fallback {
                        let out =
                            transcribe(p.get(c"owner")?, io::f32_array(p, all)?, num(p, 16000.)?)?;
                        if out.get(c"text")?.truthy()? {
                            io::callback(p, c"onFinal", &[out.get(c"text")?])?;
                        }
                    }
                    undef(p)
                })();
                if let Err(e) = result {
                    let msg = io::message(p, e)?;
                    io::callback(p, c"onError", &[text(p, &msg)?])?;
                }
                io::state::<audio::Stream, _>(p, |s| s.clear())?;
                io::callback(p, c"onDone", &[])
            }),
            ("close", 0, |p, _| {
                io::state::<audio::Stream, _>(p, |s| {
                    s.closed = true;
                    s.clear();
                })?;
                undef(p)
            }),
        ],
    )
}
#[napi]
pub fn asr_local_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let p = fields(
        ports,
        &[
            ("ports", ports),
            ("sdk", undef(ports)?),
            ("recognizer", null(ports)?),
        ],
    )?;
    io::install(p, Local::default())?;
    let root = join(
        p,
        &[
            io::port(p, c"homedir")?.call_plain(&[])?,
            text(p, ".multicc")?,
            text(p, "asr-models")?,
        ],
    )?;
    let env = io::port(p, c"env")?;
    let cfg = fields(
        p,
        &[
            (
                "ASR_LOCAL",
                io::default(env.get(c"ASR_LOCAL")?, text(p, "auto")?)?,
            ),
            (
                "ASR_LOCAL_MODEL_DIR",
                io::default(env.get(c"ASR_LOCAL_MODEL_DIR")?, root)?,
            ),
            (
                "ASR_LOCAL_THREADS",
                io::default(env.get(c"ASR_LOCAL_THREADS")?, text(p, "2")?)?,
            ),
            (
                "ASR_LOCAL_LANGUAGE",
                io::default(env.get(c"ASR_LOCAL_LANGUAGE")?, text(p, "auto")?)?,
            ),
        ],
    )?;
    p.set(c"cfg", cfg)?;
    let exported = methods(
        p,
        &[
            ("applyEnvUpdates", 1, |p, a| {
                let cfg = p.get(c"cfg")?;
                let keys = call(p.global()?.get(c"Object")?, c"keys", &[cfg])?;
                keys.for_each(|key| {
                    let value = a[0].get_key(key)?;
                    if !value.undefined()? {
                        cfg.set_key(key, value)?;
                    }
                    Ok(())
                })?;
                undef(p)
            }),
            ("isAvailable", 0, |p, _| flag(p, available(p)?)),
            ("modelFilesExist", 0, |p, _| flag(p, files(p)?)),
            ("modelRoot", 0, |p, _| {
                p.get(c"cfg")?.get(c"ASR_LOCAL_MODEL_DIR")
            }),
            ("addonAvailable", 0, |p, _| flag(p, sdk(p)?.truthy()?)),
            ("status", 0, |p, _| {
                let ready = available(p)?;
                let (loaded, ms) = io::state::<Local, _>(p, |s| (s.loaded, s.load_ms))?;
                fields(
                    p,
                    &[
                        ("ready", flag(p, ready)?),
                        ("loaded", flag(p, loaded)?),
                        ("loadMs", num(p, ms)?),
                        ("model", text(p, "sense-voice-small-int8")?),
                        ("modelDir", model_dir(p)?),
                        ("sampleRate", num(p, 16000.)?),
                    ],
                )
            }),
            ("warmup", 0, warmup),
            ("transcribeBuffer", 2, transcribe_buffer),
            ("transcribeFloat32", 2, |p, a| transcribe(p, a[0], a[1])),
            ("createStreamingSession", 2, streaming),
            ("applyVocabCorrections", 1, |p, a| correct(p, a[0])),
        ],
    )?;
    let api = fields(p, &[("cfg", cfg)])?;
    api.spread_from(exported)?;
    if available(p)? {
        let timer = io::timer(p, 2000., |p, _| {
            warmup(p, &mut [])?;
            undef(p)
        })?;
        if callable(timer.optional(c"unref")?)? {
            call(timer, c"unref", &[])?;
        }
    }
    Ok(api.raw())
}
