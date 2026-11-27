use super::*;
use crate::js_iteration::read;

fn stamp(p: L<'_>) -> Result<L<'_>> {
    call(
        p.global()?.get(c"Date")?.construct(&[])?,
        c"toISOString",
        &[],
    )
}
fn clock(p: L<'_>) -> Result<f64> {
    call(p.global()?.get(c"Date")?, c"now", &[])?.number()
}
fn installer_status(ctx: L<'_>) -> Result<L<'_>> {
    let installer = ctx.get(c"asrModelInstaller")?;
    if callable(installer.optional(c"status")?)? {
        call(installer, c"status", &[])
    } else {
        null(ctx)
    }
}

fn enqueue<'a>(ctx: L<'a>, body: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let meta = record(body.get(c"meta")?)?;
    let req = meta.get(c"reqId")?;
    let id = if req.truthy()? {
        fold_string(req)?
    } else {
        let random = call(ctx.global()?.get(c"Math")?, c"random", &[])?;
        let token = call(
            call(random, c"toString", &[num(ctx, 36.)?])?,
            c"slice",
            &[num(ctx, 2.)?, num(ctx, 6.)?],
        )?;
        format!("aux_{}_{}", clock(ctx)?, fold_string(token)?)
    };
    let prompt = body.get(c"prompt")?;
    let kind = body.get(c"type")?;
    let log = ctx.get(c"log")?;
    let started = clock(ctx)?;
    let prefix = format!("[multicc/voice][{id}]");
    let size = string(fallback(prompt, V::from(""))?)?
        .coerce_string()?
        .as_units()
        .len();
    call(
        log,
        c"log",
        &[text(
            ctx,
            &format!("{prefix} Routing to AuxQueue (prompt {size} chars)"),
        )?],
    )?;
    let state = fields(
        ctx,
        &[
            ("log", log),
            ("res", res),
            ("prefix", text(ctx, &prefix)?),
            ("type", kind),
            ("start", num(ctx, started)?),
        ],
    )?;
    let pending = async_result(ctx, || {
        let queue = ctx.get(c"getAuxQueue")?.call_plain(&[])?;
        call(
            queue,
            c"enqueue",
            &[fields(
                ctx,
                &[("type", kind), ("prompt", prompt), ("meta", meta)],
            )?],
        )
    })?;
    let success = then(pending, state, |s, a| {
        let v = fallback(read(a[0], c"text")?, V::from(""))?;
        let msg = format!(
            "{} AuxQueue {} done in {}ms, text length: {}",
            fold_string(s.get(c"prefix")?)?,
            fold_string(s.get(c"type")?)?,
            clock(s)? - s.get(c"start")?.number()?,
            fold_string(v.get(c"length")?)?
        );
        call(s.get(c"log")?, c"log", &[text(s, &msg)?])?;
        send(s.get(c"res")?, None, ok(s, &[("text", v)])?)
    })?;
    recover(success, state, |s, a| {
        let reason = a[0];
        let cancelled = reason.optional(c"cancelled")?.truthy()?;
        let msg = message(reason)?;
        let label = format!(
            "{} AuxQueue {} error after {}ms:",
            fold_string(s.get(c"prefix")?)?,
            fold_string(s.get(c"type")?)?,
            clock(s)? - s.get(c"start")?.number()?
        );
        call(
            s.get(c"log")?,
            c"error",
            &[
                text(s, &label)?,
                if cancelled {
                    text(s, "cancelled")?
                } else {
                    msg
                },
            ],
        )?;
        send(
            s.get(c"res")?,
            None,
            fields(
                s,
                &[
                    ("ok", flag(s, false)?),
                    ("cancelled", flag(s, cancelled)?),
                    ("message", msg),
                ],
            )?,
        )
    })
}
fn feedback<'a>(ctx: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let voice = ctx.get(c"voice")?;
    let example = pick(body, &[c"raw", c"refined", c"userFinal"])?;
    example.set(c"ts", stamp(ctx)?)?;
    ctx.get(c"appendVoiceExample")?.call_plain(&[example])?;
    let terms = ctx
        .get(c"extractCorrections")?
        .call_plain(&[body.get(c"raw")?, body.get(c"userFinal")?])?;
    if read(terms, c"length")?.positive()? {
        ctx.get(c"mergeWhisperVocab")?.call_plain(&[terms])?;
    }
    if voice.get(c"autoHotwordsEnabled")?.truthy()? {
        let service = voice.get(c"autoHotwords")?;
        if service.truthy()? {
            let item = pick(body, &[c"raw", c"userFinal"])?;
            item.set(c"ts", stamp(ctx)?)?;
            if let Err(e) = call(service, c"learnFromExample", &[item]) {
                let why = caught(ctx, e)?;
                call(
                    ctx.get(c"log")?,
                    c"error",
                    &[
                        text(ctx, "[multicc/hotwords] learn failed:")?,
                        why.get(c"message")?,
                    ],
                )?;
            }
        }
    }
    ok(ctx, &[])
}
fn facts<'a>(ctx: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let file = ctx.get(c"readEnvFile")?.call_plain(&[])?;
    let runtime = ctx.get(c"runtimeEnv")?;
    let env_out = fields(ctx, &[])?;
    let runtime_out = fields(ctx, &[])?;
    let keys = body.get(c"keys")?;
    if keys.is_array()? {
        keys.for_each(|key| {
            if key.kind()? == sys::ValueType::napi_string {
                for (src, dst) in [(file, env_out), (runtime, runtime_out)] {
                    if !src.nullish()? {
                        let v = src.get_key(key)?;
                        if v.kind()? == sys::ValueType::napi_string {
                            dst.define_key(key, v)?;
                        }
                    }
                }
            }
            Ok(())
        })?;
    }
    let status = call(ctx.get(c"voiceAsr")?, c"providerStatus", &[])?;
    let local = status.optional(c"local")?;
    if local.truthy()? {
        local.assign(c"download", installer_status(ctx)?)?;
    }
    let tts = call(ctx.get(c"ttsService")?, c"providerStatus", &[])?;
    let qwen = ctx.get(c"getQwenAudioRuntimeStatus")?;
    ok(
        ctx,
        &[
            ("env", env_out),
            ("runtime", runtime_out),
            ("asrStatus", status),
            ("ttsStatus", tts),
            (
                "qwenRuntime",
                if qwen.undefined()? {
                    null(ctx)?
                } else {
                    qwen.call_plain(&[])?
                },
            ),
        ],
    )
}
pub(super) fn dispatch<'a>(ctx: L<'a>, body: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let op = body
        .get(c"op")?
        .string()?
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    let voice = ctx.get(c"voice")?;
    let answer = match op.as_str() {
        "examples" => ok(
            ctx,
            &[("examples", ctx.get(c"loadVoiceExamples")?.call_plain(&[])?)],
        )?,
        "auxEnqueue" => return enqueue(ctx, body, res),
        "feedbackApply" => feedback(ctx, body)?,
        "vocabGet" => ok(
            ctx,
            &[("vocab", ctx.get(c"loadWhisperVocab")?.call_plain(&[])?)],
        )?,
        "vocabDelete" => {
            let target = body.get(c"target")?;
            let vocab = ctx.get(c"loadWhisperVocab")?.call_plain(&[])?;
            let remaining = call(
                vocab,
                c"filter",
                &[function(target, "retainTerm", 1, 1, |target, a| {
                    flag(
                        target,
                        !call(a[0].get(c"term")?, c"toLowerCase", &[])?.equals(target)?,
                    )
                })?],
            )?;
            ctx.get(c"saveWhisperVocab")?.call_plain(&[remaining])?;
            ok(ctx, &[("remaining", remaining.get(c"length")?)])?
        }
        "hotwords" | "hotwordsReject" => {
            let words = voice.get(c"autoHotwords")?;
            let present = words.truthy()?;
            if op == "hotwords" {
                ok(
                    ctx,
                    &[
                        ("present", flag(ctx, present)?),
                        (
                            "enabled",
                            flag(ctx, voice.get(c"autoHotwordsEnabled")?.truthy()?)?,
                        ),
                        (
                            "snapshot",
                            if present {
                                call(words, c"snapshot", &[])?
                            } else {
                                null(ctx)?
                            },
                        ),
                    ],
                )?
            } else {
                let accepted = present
                    && call(words, c"reject", &[pick(body, &[c"term", c"alias"])?])?.truthy()?;
                ok(
                    ctx,
                    &[
                        ("present", flag(ctx, present)?),
                        ("accepted", flag(ctx, accepted)?),
                    ],
                )?
            }
        }
        "readinessFacts" => {
            let streaming = ctx
                .catch(|| call(ctx.get(c"voiceAsr")?, c"providerStatus", &[]))?
                .unwrap_or(null(ctx)?);
            let local = call(ctx.get(c"asrLocal")?, c"isAvailable", &[])?.truthy()?;
            let download = installer_status(ctx)?;
            let cfg = voice.get(c"cfg")?;
            let keys = fields(
                ctx,
                &[
                    (
                        "whisper",
                        flag(ctx, cfg.get(c"WHISPER_API_KEY")?.truthy()?)?,
                    ),
                    (
                        "openrouter",
                        flag(ctx, cfg.get(c"OPENROUTER_API_KEY")?.truthy()?)?,
                    ),
                ],
            )?;
            ok(
                ctx,
                &[
                    ("localAvailable", flag(ctx, local)?),
                    ("download", download),
                    ("cloudKeys", keys),
                    ("streaming", fallback(streaming, V::Null)?),
                ],
            )?
        }
        "settingsFacts" => facts(ctx, body)?,
        "settingsApply" => settings::apply(ctx, record(body.get(c"updates")?)?)?,
        "asrModelCancel" => {
            let installer = ctx.get(c"asrModelInstaller")?;
            ok(
                ctx,
                &[
                    ("cancelled", call(installer, c"cancel", &[])?),
                    ("status", call(installer, c"status", &[])?),
                ],
            )?
        }
        "asrModelStart" => {
            let installer = ctx.get(c"asrModelInstaller")?;
            let transfer = call(installer, c"start", &[text(ctx, "manual")?])?;
            call(
                transfer,
                c"catch",
                &[function(ctx, "ignore", 0, 0, |s, _| undef(s))?],
            )?;
            ok(ctx, &[("status", call(installer, c"status", &[])?)])?
        }
        _ => return error(res, 400, "unknown host operation", false),
    };
    send(res, None, answer)
}
