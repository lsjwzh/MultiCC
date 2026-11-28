//! Host-owned image worker. Each invocation gets its own private home, and
//! only the registered artifact reference crosses back into the chat.
use crate::host_api::*;
use napi_derive::napi;
use std::collections::HashSet;
mod files;
mod worker;

fn issue<'a>(p: L<'a>, code: L<'a>, msg: L<'a>) -> Result<L<'a>> {
    p.get(c"ImageBridgeError")?.construct(&[code, msg])
}
fn reject<'a>(p: L<'a>, code: &str, msg: &str) -> Result<L<'a>> {
    Err(issue(p, text(p, code)?, text(p, msg)?)?.throw_error())
}
fn safe(v: L<'_>, maximum: f64) -> Result<Option<L<'_>>> {
    if v.string()?.is_none() {
        return Ok(None);
    }
    let trimmed = call(v, c"trim", &[])?;
    if !trimmed.truthy()?
        || trimmed.get(c"length")?.number()? > maximum
        || call(trimmed, c"includes", &[text(v, "\0")?])?.truthy()?
    {
        Ok(None)
    } else {
        Ok(Some(trimmed))
    }
}
fn environment(e: L<'_>) -> Result<L<'_>> {
    let out = fields(e, &[])?;
    for key in [
        c"PATH",
        c"HOME",
        c"TMPDIR",
        c"TMP",
        c"TEMP",
        c"LANG",
        c"LC_ALL",
        c"LC_CTYPE",
        c"TERM",
    ] {
        let v = e.get(key)?;
        if v.string()?.is_some() && v.truthy()? {
            out.set(key, v)?;
        }
    }
    Ok(out)
}
fn references<'a>(p: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let out = array(p)?;
    if v.nullish()? {
        return Ok(out);
    }
    let bad = || {
        issue(
            p,
            text(p, "invalid_arguments")?,
            text(p, "reference_image_paths is invalid")?,
        )
    };
    if !v.is_array()? || v.get(c"length")?.number()? > 4. {
        return Err(bad()?.throw_error());
    }
    let seen = p.global()?.get(c"Set")?.construct(&[])?;
    v.for_each(|v| {
        let Some(file) = safe(v, 1024.)? else {
            return Err(bad()?.throw_error());
        };
        if !call(p.get(c"path")?, c"isAbsolute", &[file])?.truthy()?
            || call(seen, c"has", &[file])?.truthy()?
        {
            return Err(bad()?.throw_error());
        }
        call(seen, c"add", &[file])?;
        call(out, c"push", &[file])?;
        Ok(())
    })?;
    Ok(out)
}
fn auth_file<'a>(p: L<'a>, session: L<'a>) -> Result<L<'a>> {
    let mut candidates = vec![];
    let cli = session.optional(c"cli")?;
    if cli.is_string("codex")? || cli.is_string("codex-exp")? {
        let id = session.get(c"provider")?;
        if id.truthy()? {
            let row = p
                .get(c"getProvider")?
                .call_plain(&[text(p, "codex")?, id])?;
            if crate::codex_official_relay::official(row)? {
                candidates.push(p.get(c"resolveAuthFile")?.call_plain(&[row])?);
            }
        }
    }
    p.catch(|| {
        let list = p.get(c"fallbackAuthFiles")?.call_plain(&[])?;
        if list.truthy()? && callable(list.get_key(p.global()?.get(c"Symbol")?.get(c"iterator")?)?)?
        {
            list.for_each(|v| {
                candidates.push(v);
                Ok(())
            })?;
        }
        Ok(())
    })?;
    let mut seen = HashSet::new();
    for file in candidates {
        let Some(path) = file.string()? else {
            continue;
        };
        let path = path.to_string_lossy();
        if path.is_empty() || !seen.insert(path.clone()) {
            continue;
        }
        let at = call(p.global()?.get(c"Date")?, c"now", &[])?.number()?;
        let input = serde_json::json!({"operation":"codexCredential","file":path,"now":at});
        let value =
            multicc_core::provider_credentials::run(&input).map_err(napi::Error::from_reason)?;
        if value["ok"] == true {
            return Ok(file);
        }
    }
    null(p)
}
fn publish<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let image = a[0];
    let crypto = p.get(c"cryptoImpl")?;
    let bytes = call(crypto, c"randomBytes", &[num(p, 16.)?])?;
    let id = format!(
        "image_{}",
        fold_string(call(bytes, c"toString", &[text(p, "base64url")?])?)?
    );
    let ext = fold_string(image.get(c"ext")?)?;
    let filename = format!("image.{ext}");
    let dest = call(
        p.get(c"path")?,
        c"join",
        &[p.get(c"artifactsDir")?, text(p, &id)?, text(p, &filename)?],
    )?;
    let url = text(p, &format!("/artifacts/{id}/{filename}"))?;
    let artifact = fields(
        p,
        &[
            ("id", text(p, &id)?),
            ("url", url),
            ("mime_type", text(p, files::mime(&ext))?),
            ("bytes", image.get(c"bytes")?),
        ],
    )?;
    ctx.set(c"artifact", artifact)?;
    then(
        files::publish(ctx, image.get(c"file")?, dest)?,
        ctx,
        |ctx, _| {
            let p = ctx.get(c"p")?;
            let context = ctx.get(c"context")?;
            let artifact = ctx.get(c"artifact")?;
            ctx.catch(|| {
                p.get(c"registerArtifact")?.call_plain(&[fields(
                    p,
                    &[
                        ("kind", text(p, "file")?),
                        ("title", text(p, "Generated image")?),
                        ("url", artifact.get(c"url")?),
                        ("sessionId", context.get(c"sessionId")?),
                        ("taskId", fallback(context.get(c"taskId")?, "".into())?),
                        ("source", text(p, "image-bridge")?),
                    ],
                )?])
            })?;
            fields(p,&[("ok",flag(p,true)?),("artifact",artifact),("instruction",text(p,"The image is available at artifact.url. Include that URL in the user-facing result.")?)])
        },
    )
}
fn generate<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let options = default_object(a[0])?;
        let Some(prompt) = safe(options.get(c"prompt")?, 16384.)? else {
            return reject(
                p,
                "invalid_arguments",
                "prompt is required and must be at most 16384 characters",
            );
        };
        let refs = references(p, options.get(c"referenceImagePaths")?)?;
        let auth = auth_file(p, options.get(c"session")?)?;
        if !auth.truthy()? {
            return reject(
                p,
                "image_generation_unavailable",
                "an official Codex login is not available",
            );
        }
        let context = options.get(c"context")?;
        let key = context.optional(c"sessionId")?;
        let active = p.get(c"active")?;
        if call(active, c"has", &[key])?.truthy()? {
            return reject(
                p,
                "image_generation_busy",
                "an image generation is already running for this session",
            );
        }
        if active.get(c"size")?.number()? >= p.get(c"maxConcurrent")?.number()? {
            return reject(
                p,
                "image_generation_busy",
                "image generation is busy; retry shortly",
            );
        }
        let path = p.get(c"path")?;
        let root = p.get(c"stagingRoot")?;
        files::private(p, root, true)?;
        let run = call(
            p.get(c"fsImpl")?,
            c"mkdtempSync",
            &[call(path, c"join", &[root, text(p, "run-")?])?],
        )?;
        let home = call(path, c"join", &[run, text(p, "codex-home")?])?;
        let ctx = fields(
            p,
            &[
                ("p", p),
                ("context", context),
                ("args", options),
                ("auth", auth),
                ("refs", refs),
                ("prompt", prompt),
                ("run", run),
                ("home", home),
                ("signal", options.get(c"signal")?),
            ],
        )?;
        let chain = async_result(ctx, || {
            files::private(p, run, true)?;
            files::private(p, home, true)?;
            call(active, c"set", &[context.get(c"sessionId")?, ctx])?;
            let prepare = files::prepare(ctx)?;
            let exit = then(prepare, ctx, |ctx, a| {
                worker::invoke(ctx, a[0].get(c"inputs")?)
            })?;
            let generated = then(exit, ctx, |ctx, _| files::discover(ctx))?;
            then(generated, ctx, publish)
        })?;
        let cleanup = function(ctx, "cleanup", 0, 0, |ctx, _| {
            let p = ctx.get(c"p")?;
            let active = p.get(c"active")?;
            let key = ctx.get(c"context")?.optional(c"sessionId")?;
            if call(active, c"get", &[key])?.equals(ctx)? {
                call(active, c"delete", &[key])?;
            }
            let opts = fields(
                p,
                &[("recursive", flag(p, true)?), ("force", flag(p, true)?)],
            )?;
            let fs = p.get(c"fsImpl")?;
            let dir = ctx.get(c"run")?;
            if p.get(c"nativeFs")?.truthy()? {
                let gone = async_result(ctx, || call(fs.get(c"promises")?, c"rm", &[dir, opts]))?;
                recover(gone, ctx, |c, _| undef(c))
            } else {
                ctx.catch(|| call(fs, c"rmSync", &[dir, opts]))?;
                undef(ctx)
            }
        })?;
        call(chain, c"finally", &[cleanup])
    })
}
fn create<'a>(host: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(a[0])?;
    let p = spread(host)?;
    let dir = o.get(c"artifactsDir")?;
    if !dir.truthy()? || !call(p.get(c"path")?, c"isAbsolute", &[dir])?.truthy()? {
        return Err(p.type_error("artifactsDir is required"));
    }
    p.set(c"artifactsDir", dir)?;
    for (key, msg) in [
        (c"resolveSessionCwd", "resolveSessionCwd is required"),
        (c"getProvider", "getProvider is required"),
        (c"resolveAuthFile", "resolveAuthFile is required"),
    ] {
        let f = o.get(key)?;
        if !callable(f)? {
            return Err(p.type_error(msg));
        }
        p.set(key, f)?;
    }
    let fallback = with_default(
        o.get(c"fallbackAuthFiles")?,
        function(p, "fallbackAuthFiles", 0, 0, |p, _| array(p))?,
    )?;
    if !callable(fallback)? {
        return Err(p.type_error("fallbackAuthFiles must be a function"));
    }
    p.set(c"fallbackAuthFiles", fallback)?;
    let spawn = with_default(o.get(c"spawnImpl")?, p.get(c"spawn")?)?;
    if !callable(spawn)? {
        return Err(p.type_error("spawnImpl is required"));
    }
    p.set(c"spawnImpl", spawn)?;
    p.set(
        c"registerArtifact",
        with_default(
            o.get(c"registerArtifact")?,
            function(p, "registerArtifact", 0, 0, |p, _| undef(p))?,
        )?,
    )?;
    p.set(
        c"codexCommand",
        with_default(o.get(c"codexCommand")?, text(p, "codex")?)?,
    )?;
    let fs = with_default(o.get(c"fsImpl")?, p.get(c"fs")?)?;
    p.set(c"fsImpl", fs)?;
    p.set(c"nativeFs", flag(p, fs.equals(p.get(c"fs")?)?)?)?;
    p.set(
        c"cryptoImpl",
        with_default(o.get(c"cryptoImpl")?, p.get(c"crypto")?)?,
    )?;
    p.set(
        c"environment",
        with_default(o.get(c"environment")?, p.get(c"process")?.get(c"env")?)?,
    )?;
    let root = o.get(c"tempRoot")?;
    p.set(
        c"stagingRoot",
        if root.truthy()? {
            root
        } else {
            call(
                p.get(c"path")?,
                c"join",
                &[
                    p.get(c"tmpdir")?.call_plain(&[])?,
                    text(p, "multicc-image-bridge")?,
                ],
            )?
        },
    )?;
    p.set(
        c"timeoutMs",
        with_default(o.get(c"timeoutMs")?, num(p, 240000.)?)?,
    )?;
    p.set(
        c"maxConcurrent",
        with_default(o.get(c"maxConcurrent")?, num(p, 2.)?)?,
    )?;
    p.set(c"active", p.global()?.get(c"Map")?.construct(&[])?)?;
    defaulted_methods(
        p,
        &[
            ("generate", 0, 1, generate),
            ("isEligible", 1, 1, |p, a| {
                flag(p, auth_file(p, a[0])?.truthy()?)
            }),
            ("stopAll", 0, 0, |p, _| {
                let active = p.get(c"active")?;
                call(active, c"values", &[])?.for_each(worker::terminate)?;
                undef(p)
            }),
        ],
    )?
    .freeze()
}
#[napi]
pub fn codex_image_bridge_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createOfficialImageBridge", 0, 1, create),
            ("imageFormat", 1, 2, |p, a| {
                files::format(p, a[0], with_default(a[1], p.get(c"fs")?)?)
            }),
            ("privateEnvironment", 0, 1, |p, a| {
                environment(with_default(a[0], p.get(c"process")?.get(c"env")?)?)
            }),
        ],
    )?;
    api.set(c"DEFAULT_TIMEOUT_MS", num(p, 240000.)?)?;
    api.set(c"ImageBridgeError", p.get(c"ImageBridgeError")?)?;
    Ok(api.raw())
}
