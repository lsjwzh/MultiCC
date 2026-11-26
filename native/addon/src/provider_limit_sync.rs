//! Build the display-only quota event and notify sessions using its provider.
use crate::{js_live::LiveValue, quota_bar_view};
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn snapshot<'a>(
    entry: LiveValue<'a>,
    now: LiveValue<'a>,
    threshold: f64,
    subtract: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let null = entry.from_value(&JsValue::Null)?;
    if !entry.truthy()? || entry.get(c"kind")?.is_string("availability")? {
        return Ok(null);
    }
    let stale = !entry.get(c"fetchedAt")?.nullish()?
        && subtract
            .call_plain(&[now, entry.get(c"fetchedAt")?])?
            .explicit_number()?
            > threshold;
    let stale = entry.from_value(&JsValue::Bool(stale))?;
    let fields = entry.from_value(&JsValue::Object(vec![]))?;
    fields.spread_from(entry)?;
    fields.set(c"stale", stale)?;
    let input = entry.from_value(&JsValue::Object(vec![]))?;
    input.set(c"entry", fields)?;
    input.set(c"nowMs", now)?;
    let bar = quota_bar_view::view("providerLimitBar", input)?;
    if !bar.truthy()? {
        return Ok(null);
    }
    let event = entry.from_value(&JsValue::Object(vec![]))?;
    event.set(
        c"type",
        entry.from_value(&JsValue::string("provider_limit_updated"))?,
    )?;
    event.set(c"ok", entry.from_value(&JsValue::Bool(true))?)?;
    for field in [
        c"appType",
        c"providerId",
        c"kind",
        c"fetchedAt",
        c"updatedAt",
    ] {
        event.set(field, entry.get(field)?)?;
    }
    event.set(c"stale", stale)?;
    event.set(c"bar", bar)?;
    let kind = if entry.get(c"kind")?.is_string("balance")? {
        "balance"
    } else {
        "window"
    };
    event.set(
        c"dto",
        entry.from_value(&JsValue::object(vec![("kind", JsValue::string(kind))]))?,
    )?;
    Ok(event)
}

#[napi]
pub fn provider_limit_snapshot(
    env: Env,
    entry: Unknown<'_>,
    now: Unknown<'_>,
    threshold: f64,
    subtract: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(snapshot(
        LiveValue::new(&env, entry),
        LiveValue::new(&env, now),
        threshold,
        LiveValue::new(&env, subtract),
    )?
    .raw())
}

#[napi]
pub fn provider_limit_candidate_matches(
    env: Env,
    entry: Unknown<'_>,
    candidate: Unknown<'_>,
) -> Result<bool> {
    LiveValue::new(&env, candidate)
        .get(c"providerId")?
        .equals(LiveValue::new(&env, entry).get(c"providerId")?)
}

fn cli(record: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let cli = record.get(c"cli")?;
    if cli.truthy()? {
        Ok(cli)
    } else {
        record.from_value(&JsValue::string("claude"))
    }
}

#[napi]
#[allow(clippy::too_many_arguments)]
pub fn broadcast_provider_limit(
    env: Env,
    entry: Unknown<'_>,
    now: Unknown<'_>,
    threshold: f64,
    subtract: Unknown<'_>,
    sessions: Unknown<'_>,
    providers: Unknown<'_>,
    broadcast: Unknown<'_>,
    matches: Unknown<'_>,
) -> Result<()> {
    broadcast_live(
        LiveValue::new(&env, entry),
        LiveValue::new(&env, now),
        threshold,
        LiveValue::new(&env, subtract),
        LiveValue::new(&env, sessions),
        LiveValue::new(&env, providers),
        LiveValue::new(&env, broadcast),
        Some(LiveValue::new(&env, matches)),
    )
}

#[allow(clippy::too_many_arguments)]
fn broadcast_live<'a>(
    entry: LiveValue<'a>,
    now: LiveValue<'a>,
    threshold: f64,
    subtract: LiveValue<'a>,
    sessions: LiveValue<'a>,
    providers: LiveValue<'a>,
    send: LiveValue<'a>,
    matches: Option<LiveValue<'a>>,
) -> Result<()> {
    let event = snapshot(entry, now, threshold, subtract)?;
    if !event.truthy()? {
        return Ok(());
    }
    sessions.for_each(|pair| {
        let (id, record) = pair.iterator_pair()?;
        let mut types = providers.get(c"appTypesForCli")?;
        if !types.nullish()? {
            types = types.call(providers, &[cli(record)?])?;
        }
        if !types.truthy()? {
            let fallback = providers
                .get(c"appTypeForCli")?
                .call(providers, &[cli(record)?])?;
            types = entry.from_value(&JsValue::Array(vec![]))?;
            types.set_element(0, fallback)?;
        }
        if !types
            .get(c"includes")?
            .call(types, &[entry.get(c"appType")?])?
            .truthy()?
        {
            return Ok(());
        }
        if !record.get(c"provider")?.equals(entry.get(c"providerId")?)? {
            let candidates = record.get(c"providerSelection")?.optional(c"candidates")?;
            if candidates.nullish()? {
                return Ok(());
            }
            let some = candidates.get(c"some")?;
            let env = Env::from_raw(entry.env());
            let predicate = if let Some(matches) = matches {
                matches
                    .get(c"bind")?
                    .call(matches, &[entry.from_value(&JsValue::Undefined)?, entry])?
            } else {
                crate::host_methods::method(&env, entry, "", 1, 1, |e, a| {
                    crate::route_response::flag(
                        e,
                        a[0].get(c"providerId")?.equals(e.get(c"providerId")?)?,
                    )
                })?
            };
            if !some.call(candidates, &[predicate])?.truthy()? {
                return Ok(());
            }
        }
        send.catch(|| {
            let message = entry.from_value(&JsValue::Object(vec![]))?;
            message.spread_from(event)?;
            message.set(c"sessionId", id)?;
            send.call_plain(&[id, message])
        })?;
        Ok(())
    })
}

#[napi]
pub fn subscribe_provider_limits(
    env: Env,
    options: Unknown<'_>,
    threshold: f64,
    subtract: Unknown<'_>,
) -> Result<sys::napi_value> {
    use crate::{host_methods::method, route_response::*};
    let o = L::new(&env, options);
    let cache = o.get(c"cache")?;
    let owner = fields(
        o,
        &[
            ("sessions", o.get(c"persistedSessions")?),
            ("providers", o.get(c"providers")?),
            ("send", o.get(c"broadcast")?),
            ("subtract", L::new(&env, subtract)),
        ],
    )?;
    let listener = method(&env, owner, "", 1, 1, move |s, a| {
        let now = call(s.global()?.get(c"Date")?, c"now", &[])?;
        broadcast_live(
            a[0],
            now,
            threshold,
            s.get(c"subtract")?,
            s.get(c"sessions")?,
            s.get(c"providers")?,
            s.get(c"send")?,
            None,
        )?;
        s.from_value(&V::Undefined)
    })?;
    Ok(call(cache, c"subscribe", &[listener])?.raw())
}
