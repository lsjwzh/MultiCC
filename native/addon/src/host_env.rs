//! The editable environment file belongs to the host. Keep its line order,
//! duplicate assignments, comments and existing parent directory permissions.
use crate::{host_methods::function, route_response::*, runtime_security::atomic};
use multicc_core::{dotenv::parse_line, js::is_js_whitespace};
use napi_derive::napi;
use std::{collections::HashSet, fs, path::Path};

fn read(file: L<'_>) -> Result<String> {
    Ok(fs::read(file.coerce_string()?.to_string_lossy())
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default())
}
fn read_env(p: L<'_>) -> Result<L<'_>> {
    let out = fields(p, &[])?;
    for line in read(call(p, c"envPath", &[])?)?.split('\n') {
        if let Some((key, value)) = parse_line(line) {
            out.set_key(text(p, key)?, text(p, value)?)?;
        }
    }
    Ok(out)
}
fn write_env<'a>(p: L<'a>, updates: L<'a>) -> Result<L<'a>> {
    let file = call(p, c"envPath", &[])?;
    let mut lines = Vec::new();
    let mut written = HashSet::new();
    for line in read(file)?.split('\n') {
        if let Some(end) = line.find('=') {
            if let Some((key, _)) = parse_line(&line[..=end]) {
                let k = text(p, key)?;
                if call(updates, c"hasOwnProperty", &[k])?.truthy()? {
                    written.insert(key.to_owned());
                    let value = updates.get_key(k)?;
                    if !value.nullish()? {
                        lines.push(format!(
                            "{key}={}",
                            value.coerce_string()?.to_string_lossy()
                        ));
                    }
                    continue;
                }
            }
        }
        if line.encode_utf16().any(|u| !is_js_whitespace(u)) {
            lines.push(line.to_owned());
        }
    }
    call(p.global()?.get(c"Object")?, c"entries", &[updates])?.for_each(|pair| {
        let key = pair.element(0)?.coerce_string()?.to_string_lossy();
        let value = pair.element(1)?;
        if !written.contains(&key) && !value.nullish()? {
            lines.push(format!(
                "{key}={}",
                value.coerce_string()?.to_string_lossy()
            ));
        }
        Ok(())
    })?;
    let name = file.coerce_string()?.to_string_lossy();
    #[cfg(unix)]
    let parent_mode = {
        use std::os::unix::fs::PermissionsExt;
        Path::new(&name)
            .parent()
            .and_then(|p| fs::metadata(p).ok())
            .map_or(0o755, |v| v.permissions().mode() & 0o777)
    };
    #[cfg(not(unix))]
    let parent_mode = 0o755;
    atomic(
        p,
        file,
        &(lines.join("\n") + "\n"),
        0o600,
        parent_mode,
        p.get(c"reportFailure")?,
    )?;
    p.from_value(&V::Undefined)
}
fn ensure(p: L<'_>) -> Result<L<'_>> {
    let ports = p.get(c"ports")?;
    let environment = ports.get(c"environment")?;
    let mut public = environment.get(c"VAPID_PUBLIC_KEY")?;
    let mut private = environment.get(c"VAPID_PRIVATE_KEY")?;
    if !public.truthy()? || !private.truthy()? {
        let logger = ports.global()?.get(c"console")?;
        call(
            logger,
            c"log",
            &[text(p, "[multicc/push] Generating VAPID keys...")?],
        )?;
        let keys = call(p.get(c"webpush")?, c"generateVAPIDKeys", &[])?;
        public = keys.get(c"publicKey")?;
        private = keys.get(c"privateKey")?;
        write_env(
            ports,
            fields(
                p,
                &[("VAPID_PUBLIC_KEY", public), ("VAPID_PRIVATE_KEY", private)],
            )?,
        )?;
        environment.assign(c"VAPID_PUBLIC_KEY", public)?;
        environment.assign(c"VAPID_PRIVATE_KEY", private)?;
        call(
            logger,
            c"log",
            &[text(
                p,
                "[multicc/push] VAPID keys generated and saved to .env",
            )?],
        )?;
    }
    fields(p, &[("pubKey", public), ("privKey", private)])
}
#[napi]
pub fn host_env_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = fields(
        p,
        &[
            (
                "readEnvFile",
                function(p, "readEnvFile", 0, 0, |p, _| read_env(p))?,
            ),
            (
                "writeEnvFile",
                function(p, "writeEnvFile", 1, 1, |p, a| write_env(p, a[0]))?,
            ),
            ("envPath", p.get(c"envPath")?),
            ("ENV_PATH", call(p, c"envPath", &[])?),
        ],
    )?;
    let context = fields(p, &[("ports", p), ("api", api)])?;
    api.set(
        c"createHostEnv",
        function(context, "createHostEnv", 1, 1, |ctx, a| {
            let push = a[0].optional(c"webpush")?;
            if push.optional(c"generateVAPIDKeys")?.kind()? != sys::ValueType::napi_function {
                return Err(
                    ctx.type_error("[host-env] webpush (with generateVAPIDKeys) is required")
                );
            }
            let api = ctx.get(c"api")?;
            let owner = fields(ctx, &[("ports", ctx.get(c"ports")?), ("webpush", push)])?;
            fields(
                ctx,
                &[
                    ("readEnvFile", api.get(c"readEnvFile")?),
                    ("writeEnvFile", api.get(c"writeEnvFile")?),
                    (
                        "ensureVapidKeys",
                        function(owner, "ensureVapidKeys", 0, 0, |p, _| ensure(p))?,
                    ),
                    ("ENV_PATH", api.get(c"ENV_PATH")?),
                ],
            )
        })?,
    )?;
    Ok(api.raw())
}
