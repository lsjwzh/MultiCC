//! Public edge health, pinned transports and the outside-in Funnel probe.
use crate::host_api::*;
use crate::plugin_catalog_host::{default_to, fallback_to, items, keys, push, strings};
use napi_derive::napi;
use std::ffi::CStr;
mod parse;
mod probe;
mod resolve;
mod transport;
pub(super) use probe::{clear, owner, run};
const TIMEOUT: f64 = 8000.;
const STATUS_LIMIT: usize = 256 * 1024;
const HEALTH_LIMIT: usize = 4 * 1024;
const DNS_LIMIT: usize = 64 * 1024;
fn bounded<'a>(p: L<'a>, raw: L<'a>, limit: usize) -> Result<L<'a>> {
    let Some(s) = raw.string()? else {
        return null(p);
    };
    if s.to_string_lossy().len() > limit {
        return null(p);
    }
    let Some(v) = p.catch(|| json_call(p, c"parse", raw))? else {
        return null(p);
    };
    if object(v)? && !v.is_array()? {
        Ok(v)
    } else {
        null(p)
    }
}
fn failed<'a>(p: L<'a>, why: &str) -> Result<L<'a>> {
    fields(p, &[("ok", flag(p, false)?), ("reason", text(p, why)?)])
}
fn status<'a>(p: L<'a>, verdict: &str, why: &str, code: L<'a>) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("verdict", text(p, verdict)?),
            ("reason", text(p, why)?),
            ("httpCode", code),
        ],
    )
}
fn settle<'a>(c: L<'a>, v: L<'a>) -> Result<L<'a>> {
    if c.get(c"settled")?.truthy()? {
        return undef(c);
    }
    c.set(c"settled", flag(c, true)?)?;
    c.get(c"resolve")?.call_plain(&[v])
}
fn all<'a>(p: L<'a>, vals: L<'a>) -> Result<L<'a>> {
    call(p.global()?.get(c"Promise")?, c"all", &[vals])
}
fn after<'a>(
    v: L<'a>,
    c: L<'a>,
    f: impl for<'b> Fn(L<'b>, L<'b>) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    call(
        resolved(v)?,
        c"then",
        &[function(c, "", 1, 1, move |c, a| f(c, a[0]))?],
    )
}
#[napi]
pub fn tailscale_funnel_health_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createTailscaleFunnelProbe", 0, 1, |p, a| {
                probe::create(p, a[0])
            }),
            ("isPublicAddress", 1, 1, |p, a| {
                flag(p, parse::public(a[0])?)
            }),
            ("parseFunnelStatusJson", 2, 2, |p, a| {
                parse::funnel(p, a[0], a[1])
            }),
            ("parseTailscaleStatusJson", 1, 1, |p, a| {
                parse::control(p, a[0])
            }),
            ("requestHealth", 1, 1, |p, a| transport::health(p, a[0])),
            ("resolvePublicFunnelAddresses", 1, 2, |p, a| {
                resolve::resolve(p, a[0], a[1])
            }),
            ("validateHealthResponse", 3, 4, |p, a| {
                flag(p, parse::valid(p, a[0], a[1], a[2], a[3])?)
            }),
        ],
    )?;
    Ok(api.raw())
}
