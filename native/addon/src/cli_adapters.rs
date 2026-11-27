//! CLI adapter factories share the host's executable paths, live callback values
//! and provider registry. Each adapter retains its own decoder and turn state.
use crate::host_api::*;
use napi_derive::napi;

mod acp;
mod agy;
mod command_code;
mod kimi;
mod opencode;
mod pi;
mod print_common;
mod registry;
mod result_adapters;
mod zcode;

#[napi]
pub fn cli_adapters_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let out = fields(p, &[])?;
    p.set(c"api", out)?;
    acp::install(p, out)?;
    opencode::install(p, out)?;
    result_adapters::install(p, out)?;
    zcode::install(p, out)?;
    kimi::install(p, out)?;
    pi::install(p, out)?;
    command_code::install(p, out)?;
    out.set(
        c"createAgyAdapter",
        function(p, "createAgyAdapter", 1, 1, |p, a| agy::create(p, a[0]))?,
    )?;
    out.set(
        c"createCliAdapters",
        function(p, "createCliAdapters", 1, 1, |p, a| {
            registry::create(p, a[0])
        })?,
    )?;
    Ok(out.raw())
}
