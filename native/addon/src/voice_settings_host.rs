//! Loopback port for voice operations which use live services in the Node child.
use crate::host_api::*;
use multicc_core::voice_routes::HOST_PATH;
use napi_derive::napi;

mod operations;
mod settings;

fn record(v: L<'_>) -> Result<L<'_>> {
    if object(v)? && !v.is_array()? {
        Ok(v)
    } else {
        fields(v, &[])
    }
}

fn caught(p: L<'_>, err: napi::Error) -> Result<L<'_>> {
    match p.exception_value()? {
        Some(reason) => Ok(reason),
        None => error_value(p, &err.reason),
    }
}

fn ok<'a>(p: L<'a>, entries: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let out = fields(p, &[("ok", flag(p, true)?)])?;
    for (k, v) in entries {
        out.define_key(text(p, k)?, *v)?;
    }
    Ok(out)
}

fn message(err: L<'_>) -> Result<L<'_>> {
    let msg = err.optional(c"message")?;
    if msg.truthy()? {
        Ok(msg)
    } else {
        string(err)
    }
}

fn failure<'a>(res: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    let detail = fields(res, &[("message", string(message(reason)?)?)])?;
    let status = reason.optional(c"statusCode")?;
    if !status.nullish()? {
        detail.set(c"statusCode", status)?;
    }
    send(
        res,
        None,
        fields(res, &[("ok", flag(res, false)?), ("error", detail)])?,
    )
}

fn handle<'a>(ctx: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let (req, res) = (args[0], args[1]);
    async_result(ctx, || {
        if !ctx.get(c"isLocal")?.call_plain(&[req])?.truthy()? {
            return error(res, 404, "not found", false);
        }
        let body = record(req.get(c"body")?)?;
        match operations::dispatch(ctx, body, res) {
            Ok(v) => Ok(v),
            Err(e) => failure(res, caught(res, e)?),
        }
    })
}

fn mount<'a>(ports: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let (app, deps) = (args[0], default_object(args[1])?);
    if !callable(app.optional(c"post")?)? {
        return Err(app.type_error("[voice-host] Express-compatible app is required"));
    }
    let ctx = fields(app, &[])?;
    for key in [c"readEnvFile", c"writeEnvFile", c"getAuxQueue"] {
        let cb = deps.get(key)?;
        if !callable(cb)? {
            return Err(app.type_error(&format!(
                "[voice-host] {} is required",
                key.to_string_lossy()
            )));
        }
        ctx.set(key, cb)?;
    }
    for (key, prop, name) in [
        (c"voice", c"cfg", "voice"),
        (c"asrLocal", c"isAvailable", "local ASR"),
        (c"voiceAsr", c"providerStatus", "streaming ASR"),
        (c"ttsService", c"providerStatus", "TTS"),
    ] {
        let service = deps.get(key)?;
        let prop = service.optional(prop)?;
        let valid = if key == c"voice" {
            prop.truthy()?
        } else {
            callable(prop)?
        };
        if !valid {
            return Err(app.type_error(&format!("[voice-host] {name} service is required")));
        }
        ctx.set(key, service)?;
    }
    for key in [
        c"loadVoiceExamples",
        c"appendVoiceExample",
        c"loadWhisperVocab",
        c"saveWhisperVocab",
        c"extractCorrections",
        c"mergeWhisperVocab",
    ] {
        ctx.set(key, ctx.get(c"voice")?.get(key)?)?;
    }
    for key in [
        c"asrModelInstaller",
        c"applyRuntimeEnv",
        c"rollbackRuntimeEnv",
        c"reportFailure",
        c"getQwenAudioRuntimeStatus",
        c"onQwenAudioConfigChanged",
    ] {
        ctx.set(key, deps.get(key)?)?;
    }
    ctx.set(
        c"isLocal",
        with_default(deps.get(c"isLocal")?, ports.get(c"isLocalRequest")?)?,
    )?;
    ctx.set(
        c"log",
        with_default(deps.get(c"log")?, app.global()?.get(c"console")?)?,
    )?;
    ctx.set(
        c"runtimeEnv",
        with_default(
            deps.get(c"runtimeEnv")?,
            app.global()?.get(c"process")?.get(c"env")?,
        )?,
    )?;
    settings::mark(ctx, None)?;
    call(
        app,
        c"post",
        &[
            text(app, HOST_PATH)?,
            function(ctx, "voiceHost", 2, 2, handle)?,
        ],
    )?;
    methods(
        ctx,
        &[("getConsistency", 0, |ctx, _| {
            spread(ctx.get(c"consistency")?)
        })],
    )?
    .freeze()
}

#[napi]
pub fn voice_settings_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = fields(
        p,
        &[
            (
                "mountVoiceHostRoute",
                function(p, "mountVoiceHostRoute", 1, 2, mount)?,
            ),
            ("HOST_PATH", text(p, HOST_PATH)?),
        ],
    )?;
    Ok(api.raw())
}
