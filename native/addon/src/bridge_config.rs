//! Private storage shared by the messaging bridges. Keep V8's JSON encoding,
//! string coercion and Node path semantics at the public boundary.
use crate::{host_api::*, runtime_security};
use napi_derive::napi;
use std::path::Path;

fn private_dir(dir: L<'_>) -> Result<()> {
    runtime_security::private_dir(dir, Path::new(&dir.coerce_string()?.to_string_lossy()))
}

fn secure_file<'a>(ports: L<'a>, file: L<'a>) -> Result<()> {
    if let Some(name) = file.string()? {
        return runtime_security::secure_file(ports, Path::new(&name.to_string_lossy()));
    }
    // Legacy callers can pass a Buffer or file URL to the Node fs API.
    if let Err(e) = call(
        ports.get(c"fs")?,
        c"chmodSync",
        &[file, num(ports, 0o600 as f64)?],
    ) {
        let cause = ports.exception_value()?.ok_or(e)?;
        if !cause.get(c"code")?.is_string("ENOENT")? {
            return Err(cause.throw_error());
        }
    }
    Ok(())
}

fn write<'a>(ports: L<'a>, file: L<'a>, body: L<'a>) -> Result<()> {
    let store = ports.get(c"store")?;
    if file.kind()? == sys::ValueType::napi_string {
        if let Some(body) = body.string()? {
            return runtime_security::atomic(
                ports,
                file,
                &body.to_string_lossy(),
                0o600,
                0o700,
                store.get(c"reportFailure")?,
            );
        }
    }
    let options = fields(
        ports,
        &[
            ("mode", num(ports, 0o600 as f64)?),
            ("dirMode", num(ports, 0o700 as f64)?),
        ],
    )?;
    call(store, c"writeTextAtomic", &[file, body, options])?;
    Ok(())
}

fn config_file<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let dir = ports.get(c"paths")?.get(c"bridgesDir")?;
    private_dir(dir)?;
    let file = call(ports.get(c"path")?, c"join", &[dir, a[0]])?;
    let fs = ports.get(c"fs")?;
    let legacy = a[1];
    if !call(fs, c"existsSync", &[file])?.truthy()?
        && legacy.truthy()?
        && call(fs, c"existsSync", &[legacy])?.truthy()?
    {
        let body = call(fs, c"readFileSync", &[legacy, text(ports, "utf8")?])?;
        write(ports, file, body)?;
        secure_file(ports, legacy)?;
    }
    secure_file(ports, file)?;
    Ok(file)
}

fn save_config<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let json = ports.global()?.get(c"JSON")?;
    let body = call(json, c"stringify", &[a[1], null(ports)?, num(ports, 2.)?])?;
    write(ports, a[0], body)?;
    undef(ports)
}

fn history_file<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = string(fallback(a[0], V::from(""))?)?.coerce_string()?;
    if id.is_empty() {
        return Err(error_value(ports, "bridge history requires a session id")?.throw_error());
    }
    let mut name: String = id
        .into_units()
        .into_iter()
        .map(|u| match u {
            45 | 46 | 48..=57 | 65..=90 | 95 | 97..=122 => u as u8 as char,
            _ => '_',
        })
        .collect();
    name.push_str(".json");
    let dir = ports.get(c"paths")?.get(c"chatHistoryDir")?;
    private_dir(dir)?;
    call(ports.get(c"path")?, c"join", &[dir, text(ports, &name)?])
}

#[napi]
pub fn bridge_config_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = methods(
        p,
        &[
            ("bridgeConfigFile", 2, config_file),
            ("bridgeHistoryFile", 1, history_file),
            ("saveBridgeConfig", 2, save_config),
        ],
    )?;
    api.set(c"CONFIG_DIR", p.get(c"paths")?.get(c"bridgesDir")?)?;
    Ok(api.raw())
}
