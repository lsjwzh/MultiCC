//! Preserve filesystem return values and errors. Only publish completed writes
//! by renaming a sibling temporary, cleaning it up if writing or renaming fails.
use crate::{host_methods::method, route_response::*};
use napi_derive::napi;

fn write_atomic<'a>(p: L<'a>, file: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let fs = p.get(c"fs")?;
    let prefix = file.from_value(&V::String(file.coerce_string()?))?;
    let counter = p.get(c"counter")?;
    let n = counter.get(c"next")?;
    counter.set(c"next", num(p, n.number()? + 1.)?)?;
    let temporary = call(
        prefix,
        c"concat",
        &[text(p, ".tmp.")?, p.get(c"pid")?, text(p, ".")?, n],
    )?;
    let write = (|| {
        call(fs, c"writeFileSync", &[temporary, body, text(p, "utf8")?])?;
        call(fs, c"renameSync", &[temporary, file])
    })();
    if let Err(err) = write {
        let cause = p.exception_value()?.ok_or(err)?;
        p.catch(|| call(fs, c"unlinkSync", &[temporary]))?;
        return Err(cause.throw_error());
    }
    p.from_value(&V::Undefined)
}

#[napi]
pub fn memo_file_port(
    env: Env,
    fs: Unknown<'_>,
    counter: Unknown<'_>,
    pid: u32,
) -> Result<sys::napi_value> {
    let fs = L::new(&env, fs);
    let owner = fields(
        fs,
        &[
            ("fs", fs),
            ("counter", L::new(&env, counter)),
            ("pid", num(fs, pid.into())?),
        ],
    )?;
    let read = method(&env, fs, "readText", 1, 1, |fs, a| {
        call(fs, c"readFileSync", &[a[0], text(fs, "utf8")?])
    })?;
    let stat = method(&env, fs, "stat", 1, 1, |fs, a| call(fs, c"statSync", a))?;
    let exists = method(&env, fs, "exists", 1, 1, |fs, a| call(fs, c"existsSync", a))?;
    let ensure = method(&env, fs, "ensureDir", 1, 1, |fs, a| {
        call(
            fs,
            c"mkdirSync",
            &[a[0], fields(fs, &[("recursive", flag(fs, true)?)])?],
        )?;
        fs.from_value(&V::Undefined)
    })?;
    let remove = method(&env, fs, "remove", 1, 1, |fs, a| {
        call(
            fs,
            c"rmSync",
            &[a[0], fields(fs, &[("force", flag(fs, true)?)])?],
        )?;
        fs.from_value(&V::Undefined)
    })?;
    let write = method(&env, owner, "writeAtomic", 2, 2, |p, a| {
        write_atomic(p, a[0], a[1])
    })?;
    Ok(fields(
        fs,
        &[
            ("readText", read),
            ("stat", stat),
            ("exists", exists),
            ("ensureDir", ensure),
            ("remove", remove),
            ("writeAtomic", write),
        ],
    )?
    .freeze()?
    .raw())
}
