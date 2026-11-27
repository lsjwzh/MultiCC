//! Project a ticket's cross-process metadata. Host-local callbacks and cyclic
//! objects outside these admission fields must stay in the owning VM.
use crate::route_response::*;
use napi_derive::napi;
#[napi]
pub fn auth_ticket_projection(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let v = L::new(&env, value);
    let projected = v.catch(|| {
        let object = v.global()?.get(c"Object")?;
        let out = fields(v, &[])?;
        for key in [
            c"machineId",
            c"machineGrantId",
            c"fleetSessionId",
            c"fleetDirectoryId",
            c"requestId",
            c"correlationId",
        ] {
            if call(object, c"hasOwn", &[v, text(v, key.to_str().unwrap())?])?.truthy()? {
                out.set(key, v.get(key)?)?;
            }
        }
        if call(object, c"hasOwn", &[v, text(v, "upstream")?])?.truthy()? {
            let upstream = v.get(c"upstream")?;
            let value = if upstream.nullish()? {
                upstream
            } else {
                let addresses = upstream.get(c"addresses")?;
                let addresses = if addresses.is_array()? {
                    let mapped = crate::host_methods::function(v, "address", 1, 1, |_, a| {
                        fields(
                            a[0],
                            &[
                                ("address", a[0].optional(c"address")?),
                                ("family", a[0].optional(c"family")?),
                            ],
                        )
                    })?;
                    call(addresses, c"map", &[mapped])?
                } else {
                    addresses
                };
                fields(
                    v,
                    &[("url", upstream.get(c"url")?), ("addresses", addresses)],
                )?
            };
            out.set(c"upstream", value)?;
        }
        call(v.global()?.get(c"JSON")?, c"stringify", &[out])
    })?;
    Ok(projected.unwrap_or(null(v)?).raw())
}
