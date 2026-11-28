//! Single-file orchestration snapshots. Each factory call owns one immutable
//! revision and one FIFO promise tail. V8 retains the live callbacks and errors.
mod disk;
mod queue;
mod state;
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;

fn undef(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Undefined)
}
fn func(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn option<'a>(options: L<'a>, key: &CStr, default: L<'a>) -> Result<L<'a>> {
    let value = crate::js_iteration::read(options, key)?;
    Ok(if value.undefined()? { default } else { value })
}
fn join<'a>(v: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let empty = text(v, "")?;
    v.global()?
        .get(c"String")?
        .get(c"prototype")?
        .get(c"concat")?
        .call(empty, parts)
}
fn json<'a>(v: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(v.global()?.get(c"JSON")?, name, args)
}
fn reason<'a>(v: L<'a>, error: napi::Error) -> Result<L<'a>> {
    match v.exception_value()? {
        Some(e) => Ok(e),
        None => v
            .global()?
            .get(c"Error")?
            .construct(&[text(v, &error.reason)?]),
    }
}
fn corrupt<'a>(ports: L<'a>, msg: L<'a>, file: L<'a>, cause: Option<L<'a>>) -> Result<L<'a>> {
    let meta = fields(ports, &[("file", file)])?;
    if let Some(cause) = cause {
        meta.set(c"cause", cause)?;
    }
    Err(ports
        .get(c"CorruptError")?
        .construct(&[msg, meta])?
        .throw_error())
}

pub(crate) fn create<'a>(ports: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = default_object(options)?;
    let file = crate::js_iteration::read(options, c"file")?;
    let fs = option(options, c"fsImpl", ports.get(c"fs")?)?;
    let path = option(options, c"pathImpl", ports.get(c"path")?)?;
    let now = option(options, c"now", ports.global()?.get(c"Date")?.get(c"now")?)?;
    let hooks = option(options, c"hooks", fields(ports, &[])?)?;
    if file.kind()? != sys::ValueType::napi_string || !file.truthy()? {
        return Err(ports.type_error("[orchestration-store] create requires an injected { file }"));
    }
    if !fs.truthy()? || !func(fs.get(c"readFileSync")?)? {
        return Err(
            ports.type_error("[orchestration-store] fsImpl must implement the Node fs contract")
        );
    }
    if !func(now)? {
        return Err(ports.type_error("[orchestration-store] now must be a function"));
    }
    let owner = fields(
        ports,
        &[
            ("ports", ports),
            ("file", file),
            ("fsImpl", fs),
            ("pathImpl", path),
            ("now", now),
            ("hooks", hooks),
        ],
    )?;
    owner.set(c"state", state::freeze(disk::load(ports, owner)?)?)?;
    queue::facade(owner)
}

#[napi]
pub fn orchestration_json_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = fields(p, &[])?;
    macro_rules! expose {
        ($name:literal, $argc:expr, $f:expr) => {
            api.set_key(text(p, $name)?, function(p, $name, $argc, $argc, $f)?)?
        };
    }
    expose!("createOrchestrationStore", 1, |p, a| create(p, a[0]));
    expose!("_cloneJson", 1, |_, a| state::clone_json(a[0]));
    expose!("_deepFreeze", 1, |_, a| state::freeze(a[0]));
    expose!("_initialState", 0, |p, _| state::initial(p));
    expose!("_validateState", 2, |p, a| state::validate(p, a[0], a[1]));
    expose!("_loadState", 1, |p, a| disk::load(p, a[0]));
    expose!("_writeAtomic", 1, |p, a| {
        disk::write(p, a[0], a[0].get(c"state")?)?;
        undef(p)
    });
    Ok(api.raw())
}

/// Public stores expose ordinary VM promises for mutate/mutateIf. The
/// internal runtime can still recognize and use the native store factory.
#[napi]
pub fn public_orchestration_store(
    env: Env,
    store: Unknown<'_>,
    async_methods: Unknown<'_>,
) -> Result<sys::napi_value> {
    use crate::host_methods::variadic_method;
    let s = L::new(&env, store);
    let asynchronous = L::new(&env, async_methods).call_plain(&[s])?;
    let out = fields(
        s,
        &[
            ("backend", s.get(c"backend")?),
            ("file", s.get(c"file")?),
            ("mutate", asynchronous.get(c"mutate")?),
            ("mutateIf", asynchronous.get(c"mutateIf")?),
        ],
    )?;
    out.set(
        c"runNativeCommandSync",
        variadic_method(&env, s, "runNativeCommandSync", 1, |s, a| {
            call(s, c"runNativeCommandSync", a)
        })?,
    )?;
    for (name, n) in [(c"read", 1), (c"snapshot", 0), (c"flush", 0)] {
        out.set(
            name,
            function(s, name.to_str().unwrap(), n, n, move |s, a| {
                call(s, name, a)
            })?,
        )?;
    }
    Ok(out.freeze()?.raw())
}
#[napi]
pub fn create_sqlite_host_store(
    env: Env,
    options: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = default_object(L::new(&env, options))?;
    for key in [c"Database", c"fsImpl", c"pathImpl"] {
        if !options.get(key)?.nullish()? {
            return Err(options.type_error(&format!(
                "[orchestration-sqlite-store] {} injection is unsupported by the Rust store",
                key.to_string_lossy()
            )));
        }
    }
    let p = L::new(&env, ports);
    Ok(call(p, c"createNativeStore", &[options, p])?.raw())
}
