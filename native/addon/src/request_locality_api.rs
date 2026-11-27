//! Stable CommonJS view over the same locality predicates as the HTTP gate.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;

#[napi]
pub fn request_locality_api(env: Env, addon: Unknown<'_>) -> Result<sys::napi_value> {
    let owner = L::new(&env, addon);
    let constants = call(
        owner,
        c"requestLocality",
        &[text(owner, "constants")?, null(owner)?],
    )?;
    let api = fields(owner, &[])?;
    let set = owner.global()?.get(c"Set")?;
    for (key, name) in [
        (c"LOOPBACK_ADDRESSES", c"loopback"),
        (c"FORWARDING_HEADERS", c"forwarding"),
    ] {
        api.set(key, set.construct(&[constants.get(name)?])?.freeze()?)?;
    }
    for (key, op) in [
        ("requestHost", "host"),
        ("hasForwardingMetadata", "forwarded"),
        ("isExternalProxyRequest", "external"),
        ("isLocalRequest", "local"),
        ("isPrivateNetworkAddress", "private-address"),
        ("isPrivateRequestPeer", "private-peer"),
    ] {
        api.set_key(
            text(api, key)?,
            function(owner, key, 1, 1, move |s, a| {
                call(s, c"requestLocality", &[text(s, op)?, a[0]])
            })?,
        )?;
    }
    Ok(api.raw())
}
