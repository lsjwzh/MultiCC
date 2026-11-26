//! Live inputs for the quota, subscription, and credential kernels. Keep the
//! JSON boundary for caller-defined toJSON methods and for omitted properties.
use crate::route_response::*;
use napi::{
    bindgen_prelude::{FromNapiValue, JsValue as _, ToNapiValue},
    Result,
};
use napi_derive::napi;

fn encode(v: L<'_>) -> Result<String> {
    let wire = call(v.global()?.get(c"JSON")?, c"stringify", &[v])?;
    unsafe { String::from_napi_value(v.env(), wire.raw()) }
}
fn decode<'a>(p: L<'a>, wire: String) -> Result<L<'a>> {
    call(p.global()?.get(c"JSON")?, c"parse", &[text(p, &wire)?])
}
#[napi]
pub fn provider_credential_value(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    Ok(decode(
        input,
        crate::provider_host::provider_credential(encode(input)?)?,
    )?
    .raw())
}
#[napi]
pub fn read_provider_cli_value(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = encode(L::new(&env, input))?;
    let promise = env.spawn_future_with_callback(
        crate::provider_host::read_provider_cli_credential(input),
        |env, raw| Ok(decode(L::new(env, ().into_unknown(env)?), raw)?.raw()),
    )?;
    Ok(promise.raw())
}
#[napi]
pub fn account_subscription_value(
    env: Env,
    body: Unknown<'_>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let body = L::new(&env, body);
    let options = L::new(&env, options);
    let options = if options.undefined()? {
        fields(body, &[])?
    } else {
        options
    };
    let source = crate::js_iteration::read(options, c"source")?;
    let source = if source.undefined()? {
        text(body, "account")?
    } else {
        source
    };
    let at = options.get(c"observedAt")?;
    let at = if at.undefined()? {
        call(body.global()?.get(c"Date")?, c"now", &[])?
    } else {
        at
    };
    let req = fields(
        body,
        &[("body", body), ("source", source), ("observedAt", at)],
    )?;
    Ok(decode(
        body,
        crate::virtual_provider::parse_account_subscription(encode(req)?)?,
    )?
    .raw())
}
#[napi]
pub fn claude_quota_value(
    env: Env,
    op: Unknown<'_>,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    let answer = input.catch(|| {
        let req = crate::js_live::spread(input)?;
        req.set(c"op", L::new(&env, op))?;
        decode(input, crate::cpr::cpr_claude_quota(encode(req)?)?)
    })?;
    Ok(answer.unwrap_or(input.from_value(&V::Undefined)?).raw())
}
