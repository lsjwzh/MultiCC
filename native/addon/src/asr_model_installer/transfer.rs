use super::*;
use model::{DownloadLock, ResponsePlan};
use napi::bindgen_prelude::JsValue as _;
use std::{
    io,
    path::{Path, PathBuf},
};

fn io_error(e: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

pub(super) fn lock(p: L<'_>, root: String, at: f64) -> Result<L<'_>> {
    let runtime = env(p);
    let future = runtime.spawn_future_with_callback(
        async move {
            tokio::task::spawn_blocking(move || {
                DownloadLock::acquire(Path::new(&root), at).ok().flatten()
            })
            .await
            .map_err(io_error)
        },
        |env, lock| {
            let p = L::new(env, ().into_unknown(env)?);
            match lock {
                Some(lock) => unsafe {
                    External::to_napi_value(p.env(), External::new(RefCell::new(Some(lock))))
                },
                None => Ok(null(p)?.raw()),
            }
        },
    )?;
    Ok(raw(p, future.raw()))
}
pub(super) fn release(p: L<'_>) -> Result<L<'_>> {
    let value = p.get(c"lock")?;
    if value.nullish()? {
        return undef(p);
    }
    let cell =
        unsafe { External::<RefCell<Option<DownloadLock>>>::from_napi_ref(p.env(), value.raw())? };
    let lock = cell.borrow_mut().take();
    p.delete(c"lock")?;
    let runtime = env(p);
    let job = runtime.spawn_future(async move {
        tokio::task::spawn_blocking(move || drop(lock))
            .await
            .map_err(io_error)
    })?;
    Ok(raw(p, job.raw()))
}
pub(super) fn all(p: L<'_>) -> Result<L<'_>> {
    let root = PathBuf::from(fold_string(p.get(c"root")?)?);
    let artifacts = p.get(c"ports")?.get(c"artifacts")?;
    let mut chain = resolved(undef(p)?)?;
    for (i, artifact) in ARTIFACTS.iter().enumerate() {
        let dest = root.join(artifact.relative());
        let dest = dest.to_string_lossy();
        let op = fields(
            p,
            &[
                ("owner", p),
                ("index", num(p, i as f64)?),
                ("dest", text(p, &dest)?),
                ("part", text(p, &format!("{dest}.part"))?),
                ("mirror", num(p, 0.)?),
                ("sources", artifacts.element(i as u32)?.get(c"sources")?),
            ],
        )?;
        chain = then(chain, op, |op, _| {
            let p = op.get(c"owner")?;
            check_cancelled(p)?;
            let index = op.get(c"index")?.number()? as usize;
            progress(p, |v| v.artifact(index))?;
            let dest = PathBuf::from(fold_string(op.get(c"dest")?)?);
            let runtime = env(p);
            let ready = runtime.spawn_future(async move {
                let parent = dest
                    .parent()
                    .ok_or_else(|| io_error("model path has no directory"))?;
                tokio::fs::create_dir_all(parent).await.map_err(io_error)
            })?;
            then(raw(op, ready.raw()), op, |op, _| attempt(op))
        })?;
    }
    then(chain, p, |p, _| {
        check_cancelled(p)?;
        let at = now(p)?.number()?;
        let exists = ready(p)?.truthy()?;
        progress(p, |v| v.finish(at, exists))?;
        if exists {
            let elapsed = progress(p, |v| (at - v.started) / 1000.)?;
            log(p, c"log", &format!("models ready in {elapsed:.0}s"))?;
            let local = local(p)?;
            if callable(local.get(c"warmup")?)? {
                ignored(p, || {
                    then(undef(p)?, local, |local, _| call(local, c"warmup", &[]))
                })?;
            }
        }
        undef(p)
    })
}
fn attempt(op: L<'_>) -> Result<L<'_>> {
    let p = op.get(c"owner")?;
    check_cancelled(p)?;
    let sources = op.get(c"sources")?;
    let i = op.get(c"mirror")?.number()? as u32;
    if f64::from(i) >= sources.get(c"length")?.number()? {
        let last = op.get(c"lastError")?;
        if !last.nullish()? {
            return Err(last.throw_error());
        }
        return Err(io_error("没有可用的下载源"));
    }
    op.set(c"url", sources.element(i)?)?;
    op.set(c"mirror", num(op, f64::from(i) + 1.)?)?;
    let runtime = env(p);
    let part = fold_string(op.get(c"part")?)?;
    let stat = runtime.spawn_future(async move {
        match tokio::fs::metadata(part).await {
            Ok(meta) => Ok(meta.len() as f64),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0.),
            Err(e) => Err(io_error(e)),
        }
    })?;
    let response = then(raw(op, stat.raw()), op, |op, a| {
        let p = op.get(c"owner")?;
        check_cancelled(p)?;
        op.set(c"have", a[0])?;
        let have = a[0].number()? as u64;
        let headers = fields(p, &[])?;
        if have > 0 {
            headers.set(c"Range", text(p, &format!("bytes={have}-"))?)?;
        }
        let opts = fields(
            p,
            &[
                ("headers", headers),
                ("signal", p.get(c"controller")?.get(c"signal")?),
                ("redirect", text(p, "follow")?),
            ],
        )?;
        p.get(c"fetch")?.call_plain(&[op.get(c"url")?, opts])
    })?;
    let consumed = then(response, op, |op, a| consume(op, a[0]))?;
    recover(consumed, op, |op, a| {
        let p = op.get(c"owner")?;
        check_cancelled(p)?;
        let i = op.get(c"index")?.number()? as usize;
        let url = op.get(c"url")?;
        let host = op.catch(|| op.global()?.get(c"URL")?.construct(&[url])?.get(c"host"))?;
        let host = match host {
            Some(s) => fold_string(s)?,
            None => fold_string(url)?,
        };
        let error = fold_string(or(a[0].optional(c"message")?, a[0])?)?;
        log(
            p,
            c"error",
            &format!("{} from {host} failed: {error}", ARTIFACTS[i].id),
        )?;
        op.set(c"lastError", a[0])?;
        attempt(op)
    })
}
fn header(res: L<'_>, name: &str) -> Result<Option<String>> {
    let headers = res.get(c"headers")?;
    if !callable(headers.optional(c"get")?)? {
        return Ok(None);
    }
    let value = call(headers, c"get", &[text(res, name)?])?;
    if value.nullish()? {
        Ok(None)
    } else {
        Ok(Some(fold_string(value)?))
    }
}
fn discard_body(res: L<'_>) -> Result<()> {
    ignored(res, || {
        let body = res.get(c"body")?;
        let cancel = body.optional(c"cancel")?;
        if callable(cancel)? {
            cancel.call(body, &[])
        } else {
            undef(res)
        }
    })
}
fn consume<'a>(op: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let p = op.get(c"owner")?;
    check_cancelled(p)?;
    if !res.truthy()? {
        return Err(io_error("HTTP no response"));
    }
    let code = res.get(c"status")?.number()? as u16;
    if !res.get(c"ok")?.truthy()? && code != 416 {
        discard_body(res)?;
        return Err(io_error(format!("HTTP {code}")));
    }
    let have = op.get(c"have")?.number()? as u64;
    let plan = model::response_plan(
        code,
        have,
        header(res, "content-length")?.as_deref(),
        header(res, "content-range")?.as_deref(),
    );
    let (offset, expected) = match plan {
        Ok(ResponsePlan::Complete) => {
            discard_body(res)?;
            return promote(op, have);
        }
        Ok(ResponsePlan::Body { offset, expected }) => (offset, expected),
        Err(message) => {
            discard_body(res)?;
            return Err(io_error(message));
        }
    };
    let body = res.get(c"body")?;
    if !body.truthy()? {
        return Err(io_error("响应没有内容体"));
    }
    op.set(c"received", num(op, offset as f64)?)?;
    let expected_js = match expected {
        Some(n) => num(p, n as f64)?,
        None => null(p)?,
    };
    op.set(c"expected", expected_js)?;
    let on_chunk = function(op, "onChunk", 1, 1, |op, a| {
        let p = op.get(c"owner")?;
        check_cancelled(p)?;
        let received = op.get(c"received")?.number()? + a[0].number()?;
        op.set(c"received", num(p, received)?)?;
        let expected = op.get(c"expected")?.number_value()?.map(|n| n as u64);
        let at = now(p)?.number()?;
        progress(p, |v| v.update(at, received as u64, expected))?;
        undef(p)
    })?;
    let job = call(
        p.get(c"ports")?,
        c"writeBody",
        &[
            body,
            op.get(c"part")?,
            flag(p, offset > 0)?,
            on_chunk,
            p.get(c"controller")?,
            p.get(c"timeout")?,
        ],
    )?;
    then(job, op, |op, _| {
        let received = op.get(c"received")?.number()? as u64;
        if let Some(expected) = op.get(c"expected")?.number_value()? {
            if received != expected as u64 {
                return Err(io_error(format!(
                    "传输不完整（{received}/{expected} 字节）"
                )));
            }
        }
        promote(op, received)
    })
}
fn promote(op: L<'_>, received: u64) -> Result<L<'_>> {
    let p = op.get(c"owner")?;
    check_cancelled(p)?;
    let part = fold_string(op.get(c"part")?)?;
    let dest = fold_string(op.get(c"dest")?)?;
    let runtime = env(p);
    let job = runtime.spawn_future(async move {
        let actual = tokio::fs::metadata(&part).await.map_err(io_error)?.len();
        if actual != received {
            return Err(io_error(format!("传输不完整（{actual}/{received} 字节）")));
        }
        tokio::fs::rename(part, dest).await.map_err(io_error)?;
        Ok(())
    })?;
    Ok(raw(p, job.raw()))
}
