use crate::{host_methods::function, js_live::spread, route_response::*};
use napi_derive::napi;

#[napi]
pub fn claude_quota_header_hooks(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            (
                "activity",
                function(p, "onActivity", 1, 2, |p, a| {
                    let state = a[0];
                    let event = a[1];
                    let opts = p.get(c"options")?;
                    if state.truthy()? && event.get(c"phase")?.is_string("request")? {
                        let ctx = fields(p, &[])?;
                        for key in [c"sessionId", c"role", c"providerId", c"providerName"] {
                            ctx.set(key, event.get(key)?)?;
                        }
                        state.set(c"context", ctx)?;
                    }
                    let cb = opts.get(c"onActivity")?;
                    if cb.nullish()? {
                        return p.from_value(&V::Undefined);
                    }
                    cb.call(opts, &[event])
                })?,
            ),
            (
                "rateLimit",
                function(p, "onRateLimit", 1, 2, |p, a| {
                    if !a[0].truthy()? {
                        return call(p.get(c"options")?, c"onRateLimit", &[a[1]]);
                    }
                    let ctx = spread(a[1])?;
                    ctx.delete(c"rateLimitInfo")?;
                    a[0].set(c"context", ctx)?;
                    a[0].set(c"fallback", a[1])?;
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "writeHead",
                function(p, "onWriteHead", 3, 4, |p, a| {
                    let state = a[0];
                    let res = a[1];
                    let status = a[2];
                    if ((200.0..300.).contains(&status.number()?) || status.is_number(429.)?)
                        && state.get(c"context")?.truthy()?
                    {
                        let headers = fields(p, &[])?;
                        if !res.get(c"getHeaders")?.nullish()? {
                            headers.spread_from(call(res, c"getHeaders", &[])?)?;
                        }
                        let first = a[3].element(0)?;
                        headers.spread_from(if first.kind()? == sys::ValueType::napi_string {
                            a[3].element(1)?
                        } else {
                            first
                        })?;
                        let info = call(p, c"extract", &[headers])?;
                        if info.truthy()? {
                            let event = spread(state.get(c"context")?)?;
                            event.set(c"rateLimitInfo", info)?;
                            call(p.get(c"options")?, c"onRateLimit", &[event])?;
                        } else if info.undefined()? && state.get(c"fallback")?.truthy()? {
                            call(
                                p.get(c"options")?,
                                c"onRateLimit",
                                &[state.get(c"fallback")?],
                            )?;
                        }
                    }
                    p.from_value(&V::Undefined)
                })?,
            ),
        ],
    )?
    .raw())
}
