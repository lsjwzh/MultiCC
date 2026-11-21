//! Live compatibility inputs; Rust owns decisions and the one metadata probe.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as V, zcode_engine as kernel};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn text<'a>(anchor: L<'a>, value: &str) -> Result<L<'a>> {
    anchor.from_value(&V::from(value))
}

fn builtin_config<'a>(engine: L<'a>, paths: L<'a>) -> Result<Option<L<'a>>> {
    if !engine.truthy()? || !kernel::is_script_path(&engine.coerce_string()?) {
        return Ok(None);
    }
    let resolve = paths.get(c"resolve")?;
    let directory = paths.get(c"dirname")?.call(paths, &[engine])?;
    let file = resolve.call(
        paths,
        &[
            directory,
            text(engine, "..")?,
            text(engine, "config")?,
            text(engine, "provider")?,
            text(engine, "zcode-builtin.json")?,
        ],
    )?;
    let Some(filename) = file.string()? else {
        return Ok(None);
    };
    // This is a single stat, with the existing synchronous launch contract;
    // no transcript or directory scanning runs on the host thread.
    Ok(std::fs::metadata(filename.to_string_lossy())
        .is_ok_and(|metadata| metadata.is_file())
        .then_some(file))
}

#[napi]
pub fn zcode_default_engine() -> String {
    kernel::DEFAULT_ENGINE.into()
}

#[napi]
pub fn zcode_engine_candidates(
    env: Env,
    options: Unknown<'_>,
    paths: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = L::new(&env, options);
    let paths = L::new(&env, paths);
    let windows = options.get(c"isWindows")?;
    let windows = if windows.undefined()? {
        options
            .global()?
            .get(c"process")?
            .get(c"platform")?
            .is_string("win32")?
    } else {
        windows.truthy()?
    };
    let home = options.get(c"homeDir")?;
    if windows {
        return Ok(options.from_value(&V::Array(vec![]))?.raw());
    }
    let candidates =
        options.from_value(&V::Array(vec![V::from(kernel::DEFAULT_ENGINE), V::Null]))?;
    if home.truthy()? {
        let file = paths.get(c"join")?.call(
            paths,
            &[
                home,
                text(home, "Applications")?,
                text(home, "ZCode.app")?,
                text(home, "Contents")?,
                text(home, "Resources")?,
                text(home, "glm")?,
                text(home, "zcode.cjs")?,
            ],
        )?;
        candidates.set_element(1, file)?;
    }
    Ok(candidates
        .get(c"filter")?
        .call(candidates, &[options.global()?.get(c"Boolean")?])?
        .raw())
}

#[napi]
pub fn zcode_builtin_provider_config(
    env: Env,
    engine: Unknown<'_>,
    paths: Unknown<'_>,
) -> Result<sys::napi_value> {
    let engine = L::new(&env, engine);
    Ok(match builtin_config(engine, L::new(&env, paths))? {
        Some(file) => file,
        None => engine.from_value(&V::Null)?,
    }
    .raw())
}

#[napi]
pub fn zcode_engine_env(
    env: Env,
    engine: Unknown<'_>,
    environment: Unknown<'_>,
    paths: Unknown<'_>,
) -> Result<sys::napi_value> {
    let environment = L::new(&env, environment);
    if environment
        .get(c"ZCODE_BUILTIN_PROVIDER_CONFIG_FILE")?
        .truthy()?
    {
        return Ok(environment.raw());
    }
    let Some(file) = builtin_config(L::new(&env, engine), L::new(&env, paths))? else {
        return Ok(environment.raw());
    };
    let output = environment.from_value(&V::Object(vec![]))?;
    output.spread_from(environment)?;
    output.set(c"ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", file)?;
    Ok(output.raw())
}
