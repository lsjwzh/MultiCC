//! Build Node-shaped `Error` objects for native filesystem failures.
//!
//! Node throws plain `Error` values whose `message` is
//! `"${code}: ${description}, ${syscall} '${path}'"` (rename uses
//! `"${code}: ${description}, rename '${src}' -> '${dest}'"`) and which carry
//! enumerable `errno`, `code`, `syscall`, `path` and, for rename, `dest`.
//! Callers branch on `.code` and forward it to clients, so the native path must
//! throw the same object. `read`/`write`/`fsync` failures are fd-based in Node
//! and therefore have no `path` property — pass `None` for it.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as J;
use multicc_core::node_fs_error::classify;
use napi::{Error, Result};
use std::path::Path;

fn text<'a>(a: L<'a>, value: &str) -> Result<L<'a>> {
    a.from_value(&J::string(value))
}
fn number(a: L<'_>, value: f64) -> Result<L<'_>> {
    a.from_value(&J::Number(value))
}

fn message(
    error: &std::io::Error,
    syscall: &str,
    path: Option<&Path>,
    dest: Option<&Path>,
) -> String {
    let info = classify(error);
    match (path, dest) {
        (Some(source), Some(dest)) => format!(
            "{}: {}, rename '{}' -> '{}'",
            info.code,
            info.description,
            source.display(),
            dest.display()
        ),
        (Some(path), None) => format!(
            "{}: {}, {} '{}'",
            info.code,
            info.description,
            syscall,
            path.display()
        ),
        (None, _) => format!("{}: {}, {}", info.code, info.description, syscall),
    }
}

/// Build and throw the JS error Node's sync call would have thrown. The
/// returned `napi::Error` carries a pending exception so `LiveValue::catch`
/// and `exception_value` can recover it with its identity.
pub(crate) fn throw(
    a: L<'_>,
    error: &std::io::Error,
    syscall: &str,
    path: Option<&Path>,
    dest: Option<&Path>,
) -> Error {
    match build(a, error, syscall, path, dest) {
        Ok(value) => value.throw_error(),
        Err(error) => error,
    }
}

/// Build, without throwing, the JS error Node's sync call would have thrown.
/// Callers that need the exact object (e.g. to hand it to a failure reporter
/// and then throw it) use this.
pub(crate) fn build<'a>(
    a: L<'a>,
    error: &std::io::Error,
    syscall: &str,
    path: Option<&Path>,
    dest: Option<&Path>,
) -> Result<L<'a>> {
    let info = classify(error);
    let value = a
        .global()?
        .get(c"Error")?
        .construct(&[text(a, &message(error, syscall, path, dest))?])?;
    value.set(c"errno", number(a, info.errno as f64)?)?;
    value.set(c"code", text(a, info.code)?)?;
    value.set(c"syscall", text(a, syscall)?)?;
    if let Some(path) = path {
        value.set(c"path", text(a, &path.to_string_lossy())?)?;
    }
    if let Some(dest) = dest {
        value.set(c"dest", text(a, &dest.to_string_lossy())?)?;
    }
    Ok(value)
}

/// Plain `Error` with a caller-supplied message (no fs properties), used for
/// `[state-store] mkdir ...` wrapping and Node range validation.
pub(crate) fn build_message<'a>(
    a: L<'a>,
    constructor: &std::ffi::CStr,
    message: &str,
) -> Result<L<'a>> {
    a.global()?
        .get(constructor)?
        .construct(&[text(a, message)?])
}

/// The message text of a failure, without building a JS value.
pub(crate) fn failure_message(
    error: &std::io::Error,
    syscall: &str,
    path: Option<&Path>,
    dest: Option<&Path>,
) -> String {
    message(error, syscall, path, dest)
}
