//! Each Node host shares two libuv worker slots across its native operations.
//! Keep the pending callbacks on a V8-owned array so GC can trace closures
//! (including a closure which itself refers back to this queue).
use crate::{host_methods::method, route_response::*};
use napi_derive::napi;

fn callback<'a>(
    s: L<'a>,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let env = Env::from_raw(s.env());
    let f = method(&env, s, "", count, count, run)?;
    Ok(L::from_raw(s.env(), f.raw()))
}

fn start(job: L<'_>) -> Result<()> {
    let owner = job.get(c"owner")?;
    let active = owner.get(c"active")?.number()?;
    owner.set(c"active", num(owner, active + 1.)?)?;
    let promise = call(owner.global()?.get(c"Promise")?, c"resolve", &[])?;
    let pending = call(promise, c"then", &[job.get(c"operation")?])?;
    let completion = call(
        pending,
        c"then",
        &[job.get(c"resolve")?, job.get(c"reject")?],
    )?;
    call(completion, c"finally", &[owner.get(c"release")?])?;
    Ok(())
}

#[napi]
pub fn create_native_queue(env: Env) -> Result<sys::napi_value> {
    let mut global = std::ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_get_global(env.raw(), &mut global) })?;
    let owner = L::from_raw(env.raw(), global);
    let state = fields(
        owner,
        &[
            ("active", num(owner, 0.)?),
            ("waiting", owner.from_value(&V::Array(vec![]))?),
        ],
    )?;
    state.set(
        c"release",
        callback(state, 0, |s, _| {
            s.set(c"active", num(s, s.get(c"active")?.number()? - 1.)?)?;
            let next = call(s.get(c"waiting")?, c"shift", &[])?;
            if !next.undefined()? {
                start(next)?;
            }
            s.from_value(&V::Undefined)
        })?,
    )?;
    let run = method(&env, state, "runNative", 1, 1, |s, a| {
        let job = fields(s, &[("owner", s), ("operation", a[0])])?;
        let executor = callback(job, 2, |job, a| {
            job.set(c"resolve", a[0])?;
            job.set(c"reject", a[1])?;
            let s = job.get(c"owner")?;
            if s.get(c"active")?.number()? < 2. {
                start(job)?;
            } else {
                call(s.get(c"waiting")?, c"push", &[job])?;
            }
            s.from_value(&V::Undefined)
        })?;
        s.global()?.get(c"Promise")?.construct(&[executor])
    })?;
    Ok(run.raw())
}

/// Counts completed native operations for the loader's diagnostic snapshot.
#[napi]
#[derive(Default)]
pub struct RustNativeCounters {
    search: f64,
    usage: f64,
}
#[napi]
impl RustNativeCounters {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    #[napi]
    pub fn record(&mut self, feature: String) {
        match feature.as_str() {
            "search" => self.search += 1.,
            "usage" => self.usage += 1.,
            _ => {}
        }
    }
    #[napi(getter)]
    pub fn search(&self) -> f64 {
        self.search
    }
    #[napi(getter)]
    pub fn usage(&self) -> f64 {
        self.usage
    }
}
