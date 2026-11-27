//! Per-environment objects shared by the Node compatibility composition root.
use crate::{host_methods::function, route_response::*};
use napi::bindgen_prelude::ToNapiValue;
use napi_derive::napi;

#[napi]
pub fn shared_state_container(env: Env) -> Result<sys::napi_value> {
    let s = L::new(&env, env.get_global()?.into_unknown(&env)?);
    let empty = null(s)?;
    Ok(fields(
        s,
        &[
            ("sessions", empty),
            ("persistedSessions", empty),
            ("directories", empty),
        ],
    )?
    .raw())
}
#[napi]
pub fn shared_event_bus(env: Env, emitter: Unknown<'_>) -> Result<sys::napi_value> {
    let bus = L::new(&env, emitter).construct(&[])?;
    call(bus, c"setMaxListeners", &[num(bus, 50.0)?])?;
    Ok(bus.raw())
}
#[napi]
pub fn air_mount_api(env: Env, create: Unknown<'_>) -> Result<sys::napi_value> {
    let create = L::new(&env, create);
    let mount = function(create, "mountAirRoutes", 2, 2, |create, a| {
        let runtime = create.call_plain(&[a[1]])?;
        call(runtime, c"mount", &[a[0]])?;
        runtime.get(c"liveSync")
    })?;
    Ok(fields(create, &[("mountAirRoutes", mount)])?.raw())
}

/// Each supplier is evaluated immediately before its enumerable own properties
/// are copied. This preserves cyclic CommonJS initialisation and getter order.
#[napi]
pub fn chat_host_exports(env: Env, suppliers: Unknown<'_>) -> Result<sys::napi_value> {
    let suppliers = L::new(&env, suppliers);
    let exports = fields(suppliers, &[])?;
    suppliers.for_each(|load| exports.spread_from(load.call_plain(&[])?))?;
    Ok(exports.raw())
}
