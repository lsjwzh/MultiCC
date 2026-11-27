//! A setting update crosses five synchronous, independently fallible host boundaries.
use super::*;

fn keys(obj: L<'_>) -> Result<L<'_>> {
    call(obj.global()?.get(c"Object")?, c"keys", &[obj])
}
fn has<'a>(obj: L<'a>, key: L<'a>) -> Result<bool> {
    call(obj.global()?.get(c"Object")?, c"hasOwn", &[obj, key])?.truthy()
}
fn remove<'a>(obj: L<'a>, key: L<'a>) -> Result<()> {
    if !call(
        obj.global()?.get(c"Reflect")?,
        c"deleteProperty",
        &[obj, key],
    )?
    .truthy()?
    {
        return Err(obj.type_error("cannot delete runtime config property"));
    }
    Ok(())
}
fn clone_config(v: L<'_>) -> Result<L<'_>> {
    if v.is_array()? {
        return call(
            v,
            c"map",
            &[function(v, "cloneConfig", 1, 1, |_, a| clone_config(a[0]))?],
        );
    }
    if !object(v)? {
        return Ok(v);
    }
    let copy = fields(v, &[])?;
    keys(v)?.for_each(|k| copy.define_key(k, clone_config(v.get_key(k)?)?))?;
    Ok(copy)
}
fn replace<'a>(dst: L<'a>, src: L<'a>) -> Result<()> {
    if !object(dst)? {
        return Err(dst.type_error("runtime config is not mutable"));
    }
    keys(dst)?.for_each(|k| {
        if !has(src, k)? {
            remove(dst, k)?;
        }
        Ok(())
    })?;
    keys(src)?.for_each(|k| {
        let value = src.get_key(k)?;
        let current = dst.get_key(k)?;
        if object(value)? && !value.is_array()? && object(current)? && !current.is_array()? {
            replace(current, value)
        } else {
            dst.set_key(k, clone_config(value)?)
        }
    })
}
fn snapshot(service: L<'_>) -> Result<Option<L<'_>>> {
    if callable(service.get(c"snapshotConfig")?)? {
        return Ok(Some(call(service, c"snapshotConfig", &[])?));
    }
    let cfg = service.get(c"cfg")?;
    if cfg.truthy()? {
        Ok(Some(clone_config(cfg)?))
    } else {
        Ok(None)
    }
}
fn restore<'a>(service: L<'a>, saved: Option<L<'a>>) -> Result<()> {
    let v = saved.ok_or_else(|| {
        service.type_error("runtime service does not expose a config restore port")
    })?;
    if callable(service.get(c"restoreConfig")?)? {
        call(service, c"restoreConfig", &[v])?;
        Ok(())
    } else {
        replace(service.get(c"cfg")?, v)
    }
}
fn clock(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Date")?, c"now", &[])
}
pub(super) fn mark(ctx: L<'_>, failed: Option<&str>) -> Result<()> {
    let stale = flag(ctx, failed.is_some())?;
    ctx.set(
        c"consistency",
        fields(
            ctx,
            &[
                ("degraded", stale),
                ("dirty", stale),
                (
                    "reason",
                    match failed {
                        Some(s) => text(ctx, s)?,
                        None => null(ctx)?,
                    },
                ),
                (
                    "lastFailureAt",
                    if failed.is_some() {
                        clock(ctx)?
                    } else {
                        null(ctx)?
                    },
                ),
            ],
        )?,
    )
}
fn report(ctx: L<'_>, stage: &str, category: &str) -> Result<()> {
    ctx.catch(|| {
        ctx.get(c"reportFailure")?
            .call_plain(&[text(ctx, stage)?, text(ctx, category)?])
    })?;
    Ok(())
}
fn runtime<'a>(ctx: L<'a>, env: L<'a>, values: L<'a>, rollback: bool) -> Result<()> {
    let cb = ctx.get(if rollback {
        c"rollbackRuntimeEnv"
    } else {
        c"applyRuntimeEnv"
    })?;
    if !cb.undefined()? {
        cb.call_plain(&[env, values])?;
        return Ok(());
    }
    keys(values)?.for_each(|key| {
        let value = values.get_key(key)?;
        if rollback {
            if value.get(c"present")?.truthy()? {
                env.set_key(key, value.get(c"value")?)
            } else {
                remove(env, key)
            }
        } else if value.kind()? == sys::ValueType::napi_null {
            remove(env, key)
        } else {
            env.set_key(key, value)
        }
    })
}

pub(super) fn apply<'a>(ctx: L<'a>, updates: L<'a>) -> Result<L<'a>> {
    let names = keys(updates)?;
    let old = ctx.get(c"readEnvFile")?.call_plain(&[])?;
    let env = ctx.get(c"runtimeEnv")?;
    let saved_disk = fields(ctx, &[])?;
    let saved_env = fields(ctx, &[])?;
    let mut refresh = false;
    names.for_each(|key| {
        if fold_string(key)?.starts_with("QWEN_AUDIO_") {
            refresh = true;
        }
        saved_disk.define_key(
            key,
            if has(old, key)? {
                old.get_key(key)?
            } else {
                null(ctx)?
            },
        )?;
        let present = has(env, key)?;
        saved_env.define_key(
            key,
            fields(
                ctx,
                &[
                    ("present", flag(ctx, present)?),
                    (
                        "value",
                        if present {
                            env.get_key(key)?
                        } else {
                            undef(ctx)?
                        },
                    ),
                ],
            )?,
        )
    })?;
    let asr = ctx.get(c"voiceAsr")?;
    let tts = ctx.get(c"ttsService")?;
    let voice = ctx.get(c"voice")?;
    let before_asr = snapshot(asr)?;
    let before_tts = snapshot(tts)?;
    let before_voice = snapshot(voice)?;
    let write = ctx.get(c"writeEnvFile")?;
    let stages = [
        "persist",
        "voice_asr_apply",
        "tts_apply",
        "runtime_env_apply",
        "voice_apply",
    ];
    let compensations = [
        "env_restore",
        "voice_asr_restore",
        "tts_restore",
        "runtime_env_restore",
        "voice_restore",
    ];
    for (i, stage) in stages.iter().enumerate() {
        let result = match i {
            0 => write.call_plain(&[updates]).map(drop),
            1 => call(asr, c"applyConfig", &[updates]).map(drop),
            2 => call(tts, c"applyConfig", &[updates]).map(drop),
            3 => runtime(ctx, env, updates, false),
            _ => call(voice, c"applyEnvUpdates", &[updates]).map(drop),
        };
        if let Err(err) = result {
            let cause = caught(ctx, err)?;
            report(ctx, stage, "apply_failed")?;
            let mut failed = None;
            // Include the throwing boundary: it may already have mutated its state.
            for j in (0..=i).rev() {
                let attempt = ctx.catch(|| match j {
                    0 => write.call_plain(&[saved_disk]).map(drop),
                    1 => restore(asr, before_asr),
                    2 => restore(tts, before_tts),
                    3 => runtime(ctx, env, saved_env, true),
                    _ => restore(voice, before_voice),
                })?;
                if attempt.is_none() {
                    failed.get_or_insert(compensations[j]);
                    report(ctx, compensations[j], "compensation_failed")?;
                }
            }
            mark(ctx, failed)?;
            return Err(cause.throw_error());
        }
    }
    mark(ctx, None)?;
    let cfg = voice.get(c"cfg")?;
    for (name, model, base, key) in [
        (
            "voice",
            c"OPENROUTER_MODEL",
            c"OPENROUTER_BASE_URL",
            c"OPENROUTER_API_KEY",
        ),
        (
            "stt",
            c"WHISPER_MODEL",
            c"WHISPER_BASE_URL",
            c"WHISPER_API_KEY",
        ),
    ] {
        let message = format!(
            "[multicc/{name}] Settings updated: model={}, baseUrl={}, key={}",
            fold_string(cfg.get(model)?)?,
            fold_string(cfg.get(base)?)?,
            if cfg.get(key)?.truthy()? {
                "set"
            } else {
                "empty"
            }
        );
        call(ctx.get(c"log")?, c"log", &[text(ctx, &message)?])?;
    }
    let notify = ctx.get(c"onQwenAudioConfigChanged")?;
    if refresh && !notify.undefined()? {
        recover(notify.call_plain(&[])?, ctx, |ctx, _| {
            report(ctx, "qwen_audio_runtime_refresh", "apply_failed")?;
            undef(ctx)
        })?;
    }
    ok(ctx, &[])
}
