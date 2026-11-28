//! Read only allowlisted metadata at the provider boundary. Both recursion
//! and message projection are bounded in UTF-16 units before serialization.
use crate::route_response::*;
use napi_derive::napi;
fn project<'a>(v: L<'a>, depth: f64, budget: L<'a>) -> Result<L<'a>> {
    let out = fields(v, &[])?;
    if !v.truthy()? || v.kind()? != sys::ValueType::napi_object || v.is_array()? || depth > 6. {
        return Ok(out);
    }
    let nodes = budget.get(c"nodes")?.number()?;
    budget.assign(c"nodes", num(v, nodes - 1.)?)?;
    if nodes <= 0. {
        return Ok(out);
    }
    for k in [
        c"message",
        c"code",
        c"name",
        c"type",
        c"errorName",
        c"category",
        c"httpStatus",
        c"statusCode",
        c"status",
    ] {
        let field = v.get(k)?;
        if field.kind()? == sys::ValueType::napi_string {
            let limit = if k == c"message" {
                budget.get(c"chars")?
            } else {
                num(v, 128.)?
            };
            let sliced = call(v.get(k)?, c"slice", &[num(v, 0.)?, limit])?;
            out.set(k, sliced)?;
            if k == c"message" {
                budget.assign(
                    c"chars",
                    num(
                        v,
                        budget.get(c"chars")?.number()? - sliced.get(c"length")?.number()?,
                    )?,
                )?;
            }
        } else if v.get(k)?.kind()? == sys::ValueType::napi_number
            && v.get(k)?.number_value()?.is_some_and(f64::is_finite)
        {
            out.set(k, v.get(k)?)?;
        }
    }
    for k in [c"rpcError", c"error", c"data"] {
        if v.get(k)?.truthy()? && v.get(k)?.kind()? == sys::ValueType::napi_object {
            out.set(k, project(v.get(k)?, depth + 1., budget)?)?;
        }
    }
    if v.get(c"response")?.optional(c"error")?.truthy()? {
        out.set(
            c"response",
            fields(
                v,
                &[(
                    "error",
                    project(v.get(c"response")?.get(c"error")?, depth + 1., budget)?,
                )],
            )?,
        )?;
    }
    Ok(out)
}
#[napi]
pub fn provider_error_fields(
    env: Env,
    raw: Unknown<'_>,
    depth: f64,
    budget: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(project(L::new(&env, raw), depth, L::new(&env, budget))?.raw())
}
