//! JS evaluates public argument coercions at their original points. The core
//! owns text normalization, set comparison and markdown structure.
use crate::route_response::*;
use multicc_core::{js::JsString as S, memory_distill};
use napi_derive::napi;
fn units(v: L<'_>) -> Result<S> {
    v.string()?
        .ok_or_else(|| v.type_error("expected memory text"))
}
#[napi]
pub fn clean_task_memory(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let v = L::new(&env, input);
    Ok(
        v.from_value(&memory_distill::clean(&units(v)?).map_or(V::Null, V::String))?
            .raw(),
    )
}
#[napi]
pub fn similar_task_memory(env: Env, a: Unknown<'_>, b: Unknown<'_>) -> Result<bool> {
    Ok(memory_distill::similar(
        &units(L::new(&env, a))?,
        &units(L::new(&env, b))?,
    ))
}
#[napi]
pub fn merge_task_memory(
    env: Env,
    content: Unknown<'_>,
    line: Unknown<'_>,
    candidate: Unknown<'_>,
    start: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, content);
    let (body, replaced) = memory_distill::merge(
        units(p)?.trim(),
        units(L::new(&env, line))?,
        || units(L::new(&env, candidate).call_plain(&[])?),
        || L::new(&env, start).call_plain(&[])?.number(),
    )?;
    Ok(fields(
        p,
        &[
            ("content", p.from_value(&V::String(body))?),
            ("replaced", flag(p, replaced)?),
        ],
    )?
    .raw())
}

/// Run the host's task-directory lookup against its current memory view. Only
/// the default filesystem takes the Rust path; injected hosts keep their I/O.
#[napi]
pub fn task_memory_recorder(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::host_methods::function;
    let p = L::new(&env, ports);
    Ok(function(p, "record", 1, 1, |p, a| {
        let request = a[0];
        let dir_id = request.get(c"dirId")?;
        let task_id = request.get(c"taskId")?;
        let input = request.get(c"text")?;
        let raw = if input.nullish()? {
            S::new()
        } else {
            string(input)?.coerce_string()?
        };
        let Some(clean) = memory_distill::clean(&raw) else {
            return flag(p, false);
        };
        if !dir_id.truthy()? || !task_id.truthy()? {
            return flag(p, false);
        }
        let persist: Result<bool> = (|| {
            let deps = p.get(c"deps")?;
            let dir = call(deps, c"taskDir", &[dir_id, task_id])?;
            if !dir.truthy()? {
                return Ok(false);
            }
            let file = call(p.get(c"path")?, c"join", &[dir, text(p, "MEMORY.md")?])?;
            let files = call(deps, c"listFiles", &[dir])?;
            let mut existing = S::new();
            files.for_each_while(|entry| {
                if entry.get(c"name")?.is_string("MEMORY.md")? {
                    existing = string(fallback(entry.get(c"content")?, "".into())?)?
                        .coerce_string()?
                        .trim();
                    Ok(false)
                } else {
                    Ok(true)
                }
            })?;
            let tag = request.get(c"tag")?;
            let tag = if tag.undefined()? {
                "aux".into()
            } else {
                tag.coerce_string()?
            };
            let candidate = S::concat(&[&"[".into(), &tag, &"] ".into(), &clean]);
            let line = S::concat(&[&"- ".into(), &candidate]);
            let (body, _) = memory_distill::merge(
                existing,
                line,
                || Ok::<_, napi::Error>(candidate.clone()),
                || Ok(-p.get(c"max")?.number()?),
            )?;
            let fs = p.get(c"fs")?;
            if fs.undefined()? {
                let path = std::path::PathBuf::from(file.coerce_string()?.to_string_lossy());
                write_memory(&path, &body.to_string_lossy())
                    .map_err(|e| crate::node_fs_error::throw(p, &e, "write", Some(&path), None))?;
            } else {
                call(
                    fs,
                    c"mkdirSync",
                    &[dir, fields(p, &[("recursive", flag(p, true)?)])?],
                )?;
                let now = call(p.global()?.get(c"Date")?, c"now", &[])?
                    .coerce_string()?
                    .to_string_lossy();
                let temp = text(
                    p,
                    &format!(
                        "{}.tmp-{}-{now}",
                        file.coerce_string()?.to_string_lossy(),
                        std::process::id()
                    ),
                )?;
                call(
                    fs,
                    c"writeFileSync",
                    &[temp, p.from_value(&V::String(body))?, text(p, "utf8")?],
                )?;
                call(fs, c"renameSync", &[temp, file])?;
            }
            Ok(true)
        })();
        match persist {
            Ok(written) => flag(p, written),
            Err(e) => {
                let message = match p.exception_value()? {
                    Some(e) => {
                        let m = e.optional(c"message")?;
                        if m.truthy()? {
                            m
                        } else {
                            string(e)?
                        }
                    }
                    None => text(p, &e.reason)?,
                };
                let logger = p.get(c"logger")?;
                if !logger.get(c"warn")?.nullish()? {
                    call(
                        logger,
                        c"warn",
                        &[
                            text(p, "task_memory_distill_failed")?,
                            fields(
                                p,
                                &[("dirId", dir_id), ("taskId", task_id), ("error", message)],
                            )?,
                        ],
                    )?;
                }
                flag(p, false)
            }
        }
    })?
    .raw())
}

fn write_memory(path: &std::path::Path, body: &str) -> std::io::Result<()> {
    use std::{
        fs,
        io::Write,
        sync::atomic::{AtomicU64, Ordering},
    };
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    fs::create_dir_all(parent)?;
    loop {
        let temp = parent.join(format!(
            "MEMORY.md.tmp-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut out = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
        {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            result => result?,
        };
        let result = out.write_all(body.as_bytes());
        drop(out);
        let result = result.and_then(|_| fs::rename(&temp, path));
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        return result;
    }
}
