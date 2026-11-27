//! Node supplies the data-root resolver, iterable inputs, injected file system
//! and diagnostics. Production scheduling uses the libuv worker pool.
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use multicc_core::{artifact_cleanup::sweep, artifact_reference::is_artifact_id};
use napi::{
    bindgen_prelude::{AsyncTask, ToNapiValue},
    Task,
};
use napi_derive::napi;
use std::{collections::HashSet, path::PathBuf};

const WEEK_MS: f64 = 7. * 24. * 3600. * 1000.;

struct Sweep {
    root: PathBuf,
    now: f64,
    age: f64,
    pinned: HashSet<String>,
}

impl Task for Sweep {
    type Output = u32;
    type JsValue = u32;
    fn compute(&mut self) -> Result<u32> {
        Ok(sweep(&self.root, self.now, self.age, &self.pinned))
    }
    fn resolve(&mut self, _: Env, count: u32) -> Result<u32> {
        Ok(count)
    }
}

fn pins(value: L<'_>) -> Result<HashSet<String>> {
    let mut pinned = HashSet::new();
    if !value.truthy()? || value.kind()? == sys::ValueType::napi_string {
        return Ok(pinned);
    }
    let iterator = value.global()?.get(c"Symbol")?.get(c"iterator")?;
    if value.get_key(iterator)?.kind()? == sys::ValueType::napi_function {
        value.catch(|| {
            value.for_each(|item| {
                if let Some(id) = item.string()? {
                    let id = id.to_string_lossy();
                    if is_artifact_id(&id) {
                        pinned.insert(id);
                    }
                }
                Ok(())
            })
        })?;
    }
    Ok(pinned)
}

fn directory(fs: L<'_>, root: L<'_>) -> Result<bool> {
    let stat = call(fs, c"lstatSync", &[root])?;
    Ok(!call(stat, c"isSymbolicLink", &[])?.truthy()?
        && call(stat, c"isDirectory", &[])?.truthy()?)
}

fn injected(owner: L<'_>, fs: L<'_>, age: f64, pinned: &HashSet<String>) -> Result<(u32, bool)> {
    let path = owner.get(c"path")?;
    let root = owner.get(c"root")?;
    let mut count = 0;
    let mut changed = false;
    owner.catch(|| {
        if !directory(fs, root)? {
            return Ok(());
        }
        let now = owner.get(c"now")?.call_plain(&[])?.explicit_number()?;
        call(fs, c"readdirSync", &[root])?.for_each_while(|name| {
            if name
                .string()?
                .is_some_and(|id| pinned.contains(&id.to_string_lossy()))
            {
                return Ok(true);
            }
            let child = call(path, c"join", &[root, name])?;
            if !call(path, c"dirname", &[child])?.equals(root)? {
                return Ok(true);
            }
            owner.catch(|| {
                let mtime = call(fs, c"lstatSync", &[child])?
                    .get(c"mtimeMs")?
                    .number()?;
                if now - mtime > age {
                    if !directory(fs, root)? {
                        changed = true;
                        return Ok(());
                    }
                    let yes = flag(root, true)?;
                    call(
                        fs,
                        c"rmSync",
                        &[child, fields(root, &[("recursive", yes), ("force", yes)])?],
                    )?;
                    count += 1;
                }
                Ok(())
            })?;
            Ok(!changed)
        })
    })?;
    Ok((count, changed))
}

fn report(owner: L<'_>, count: u32) -> Result<L<'_>> {
    if count > 0 {
        owner.get(c"log")?.call_plain(&[text(
            owner,
            &format!("[multicc/artifacts] cleaned up {count} expired artifact(s)"),
        )?])?;
    }
    num(owner, count as f64)
}

fn cleanup<'a>(owner: L<'a>, age: L<'a>, values: L<'a>, asynchronous: bool) -> Result<L<'a>> {
    let age = if age.nullish()? {
        WEEK_MS
    } else {
        age.explicit_number()?
    };
    if !age.is_finite() || age < 0. {
        return Err(owner.type_error("artifact max age must be non-negative"));
    }
    let pinned = pins(values)?;
    let fs = owner.get(c"fs")?;
    if !fs.undefined()? {
        let (count, changed) = injected(owner, fs, age, &pinned)?;
        return if changed {
            num(owner, count as f64)
        } else {
            report(owner, count)
        };
    }
    let path = PathBuf::from(owner.get(c"root")?.coerce_string()?.to_string_lossy());
    // Keep the injected clock's original call order and soft failure semantics.
    if !asynchronous && !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
        return num(owner, 0.);
    }
    let now = owner
        .catch(|| owner.get(c"now")?.call_plain(&[])?.explicit_number())?
        .unwrap_or(f64::NAN);
    let mut work = Sweep {
        root: path,
        now,
        age,
        pinned,
    };
    if !asynchronous {
        return report(owner, work.compute()?);
    }
    let job = AsyncTask::new(work);
    let promise = L::from_raw(owner.env(), unsafe {
        AsyncTask::to_napi_value(owner.env(), job)
    }?);
    let done = function(owner, "reportCleanup", 1, 1, |p, a| {
        report(p, a[0].number()? as u32)
    })?;
    call(promise, c"then", &[done])
}

fn cleaner<'a>(ports: L<'a>, opts: L<'a>, asynchronous: bool) -> Result<L<'a>> {
    let opts = default_object(opts)?;
    let path = ports.get(c"path")?;
    let input = string(fallback(opts.get(c"artifactsDir")?, "".into())?)?;
    let root = call(path, c"resolve", &[input])?;
    if !call(path, c"isAbsolute", &[input])?.truthy()?
        || root.equals(call(path, c"parse", &[root])?.get(c"root")?)?
    {
        return Err(ports.type_error("artifact cleanup requires a bounded absolute directory"));
    }
    let mut fs = opts.get(c"fsImpl")?;
    if fs.equals(ports.get(c"fs")?)? {
        fs = ports.from_value(&V::Undefined)?;
    }
    let mut now = opts.get(c"now")?;
    if now.undefined()? {
        now = ports.global()?.get(c"Date")?.get(c"now")?;
    }
    let mut log = opts.get(c"log")?;
    if log.undefined()? {
        log = ports.global()?.get(c"console")?.get(c"log")?;
    }
    if [now, log]
        .iter()
        .any(|v| v.kind().ok() != Some(sys::ValueType::napi_function))
    {
        return Err(ports.type_error("artifact cleanup clock and logger must be functions"));
    }
    let owner = fields(
        ports,
        &[
            ("fs", fs),
            ("now", now),
            ("log", log),
            ("path", path),
            ("root", root),
        ],
    )?;
    function(owner, "cleanup", 0, 2, move |p, a| {
        cleanup(p, a[0], a[1], asynchronous)
    })
}

#[napi]
pub fn artifact_cleanup_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let root = p.get(c"artifactsDir")?;
    let legacy = call(
        p.get(c"path")?,
        c"join",
        &[p.get(c"home")?, text(p, ".multicc")?, text(p, "artifacts")?],
    )?;
    p.set(c"legacy", legacy)?;
    p.get(c"environment")?
        .assign(c"MULTICC_ARTIFACTS_DIR", root)?;
    let roots = function(p, "servedRoots", 0, 0, |p, _| {
        let primary = p.get(c"artifactsDir")?;
        let legacy = p.get(c"legacy")?;
        let result = p.from_value(&V::Array(vec![]))?;
        result.set_element(0, primary)?;
        if !primary.equals(legacy)? {
            result.set_element(1, legacy)?;
        }
        Ok(result)
    })?;
    Ok(fields(
        p,
        &[
            ("ARTIFACTS_DIR", root),
            ("LEGACY_ARTIFACTS_DIR", legacy),
            ("servedRoots", roots),
            ("cleanup", cleaner(p, p, false)?),
            ("cleanupAsync", cleaner(p, p, true)?),
            (
                "createCleanup",
                function(p, "createCleanup", 0, 1, |p, a| cleaner(p, a[0], false))?,
            ),
        ],
    )?
    .raw())
}
