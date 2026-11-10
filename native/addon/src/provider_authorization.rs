//! Synchronous proxy admission, with live host callbacks and captured records.
//! No host references are retained and no native borrow crosses a host call.
use crate::js_live::LiveValue;
use multicc_core::{
    cli_capability::is_resident,
    js::{JsString, JsValue},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn text<'a>(anchor: LiveValue<'a>, value: &str) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::string(value))
}

fn or_null(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    if value.truthy()? {
        Ok(value)
    } else {
        value.from_value(&JsValue::Null)
    }
}

/// A resident child outlives its turn, and so does the background work it
/// started: a run_in_background Task/Workflow subagent keeps calling the proxy
/// after the main result has closed the attempt, on the sub route when a
/// subagent provider is configured and on the main route when it is not.
/// While the capability is still the current one (same spawn contract, no
/// newer attempt, the turn ended cleanly) that traffic is the same warm process
/// finishing its own work, not a replay: it is admitted without reopening the
/// attempt and accounted as background. It never becomes a main producer, so it
/// cannot hold the next turn, and its usage is never bound to an attempt. A
/// cancelled or failed turn revokes the background too.
pub(crate) fn background_lingers(record: LiveValue<'_>) -> Result<bool> {
    if !record.truthy()? {
        return Ok(false);
    }
    let lifecycle = record.get(c"lifecycle")?;
    if !lifecycle
        .get(c"succeeded")?
        .call(lifecycle, &[])?
        .truthy()?
        || !record.get(c"spawnKey")?.truthy()?
    {
        return Ok(false);
    }
    let cli = record.get(c"cli")?.clean_text()?;
    let cli = cli.get(c"toLowerCase")?.call(cli, &[])?.string()?;
    // `is_resident` folds retired ids (claude-exp) and trims, so a record that
    // still spells the old lane answers like the lane that replaced it.
    Ok(cli.is_some_and(|cli| is_resident(&cli.to_string_lossy())))
}

#[napi]
pub fn provider_background_lingers(env: Env, record: Unknown<'_>) -> Result<bool> {
    background_lingers(LiveValue::new(&env, record))
}

struct Authorization<'a> {
    input: LiveValue<'a>,
    session: LiveValue<'a>,
    record: LiveValue<'a>,
    port: LiveValue<'a>,
}

impl<'a> Authorization<'a> {
    fn reject(&self, code: LiveValue<'a>, poison: bool) -> Result<LiveValue<'a>> {
        if poison {
            self.port
                .get(c"poisonProxyAttempt")?
                .call_plain(&[self.record, code])?;
        }
        let event = self.port.from_value(&JsValue::object(vec![
            ("type", JsValue::string("provider_proxy_request_rejected")),
            ("operation", JsValue::string("proxy_preflight")),
        ]))?;
        event.set(c"code", code)?;
        event.set(
            c"runtimeEpoch",
            if self.record.truthy()? {
                self.record.get(c"runtimeEpoch")?
            } else {
                self.port.get(c"runtimeEpoch")?
            },
        )?;
        for key in [c"turnId", c"routeAttemptId", c"routeGeneration"] {
            event.set(
                key,
                if self.record.truthy()? {
                    self.record.get(key)?
                } else {
                    self.port.from_value(&JsValue::Null)?
                },
            )?;
        }
        event.set(
            c"providerId",
            or_null(self.input.get(c"providerId")?.clean_text()?)?,
        )?;
        self.port
            .get(c"auditOnly")?
            .call_plain(&[self.session, event])?;
        let result = self
            .port
            .from_value(&JsValue::object(vec![("ok", false.into())]))?;
        result.set(c"code", code)?;
        result.set(c"sessionId", or_null(self.session)?)?;
        result.freeze()
    }
    fn deny(&self, code: &str, poison: bool) -> Result<LiveValue<'a>> {
        self.reject(text(self.port, code)?, poison)
    }
    fn allow(&self, terminal: bool, background: bool) -> Result<LiveValue<'a>> {
        let result = self.port.from_value(&JsValue::object(vec![
            ("ok", true.into()),
            ("code", JsValue::Null),
        ]))?;
        result.set(c"sessionId", self.session)?;
        result.set(
            c"attempt",
            if terminal {
                self.port.from_value(&JsValue::Null)?
            } else {
                self.port.get(c"snapshot")?.call_plain(&[self.record])?
            },
        )?;
        if terminal {
            result.set(c"terminal", self.port.from_value(&JsValue::Bool(true))?)?;
        }
        if background {
            result.set(c"background", self.port.from_value(&JsValue::Bool(true))?)?;
        }
        result.freeze()
    }
    fn revision_matches(&self, resolver: LiveValue<'a>) -> Result<bool> {
        Ok(self
            .port
            .catch(|| {
                resolver
                    .call_plain(&[self.record, self.input])?
                    .clean_text()?
                    .equals(self.record.get(c"providerRevision")?)
            })?
            .unwrap_or(false))
    }
    fn route_error(&self, role: LiveValue<'a>, background: bool) -> Result<Option<&'static str>> {
        if role.is_string("main")?
            && self.input.get(c"providerId")?.clean_text()?.truthy()?
            && !self
                .input
                .get(c"providerId")?
                .clean_text()?
                .equals(self.record.get(c"providerId")?)?
        {
            return Ok(Some("provider_route_mismatch"));
        }
        if !role.is_string("main")?
            && (background || !role.is_string("aux")?)
            && self.input.get(c"providerId")?.clean_text()?.truthy()?
        {
            let allowed = self.record.get(c"allowedSubProviderIds")?;
            let includes = allowed.get(c"includes")?;
            if !includes
                .call(allowed, &[self.input.get(c"providerId")?.clean_text()?])?
                .truthy()?
            {
                return Ok(Some("provider_subroute_not_allowed"));
            }
        }
        Ok(None)
    }
}

#[napi]
pub fn provider_authorize_proxy_request(
    env: Env,
    input: Unknown<'_>,
    context: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let context = LiveValue::new(&env, context);
    let auth = Authorization {
        input: LiveValue::new(&env, input),
        session: context.get(c"sessionId")?,
        record: context.get(c"record")?,
        port: LiveValue::new(&env, port),
    };
    let role = auth.input.get(c"role")?;
    let role = if role.truthy()? {
        role
    } else {
        auth.input.get(c"roleKind")?
    };
    let role = if role.truthy()? {
        role
    } else {
        text(auth.port, "main")?
    }
    .clean_text()?;
    let role = role.get(c"toLowerCase")?.call(role, &[])?;
    let method = auth.input.get(c"method")?.clean_text()?;
    let method = method.get(c"toUpperCase")?.call(method, &[])?;
    let quota = auth.port.get(c"quotaGuard")?;
    if quota.truthy()? && (!method.truthy()? || method.is_string("POST")?) {
        let verdict = auth
            .port
            .catch(|| {
                let check = quota.get(c"check")?;
                let args = auth.port.from_value(&JsValue::Object(vec![]))?;
                args.set(c"providerId", auth.input.get(c"providerId")?.clean_text()?)?;
                check.call(quota, &[args])
            })?
            .unwrap_or(auth.port.from_value(&JsValue::Null)?);
        if verdict.truthy()? && verdict.get(c"blocked")?.truthy()? {
            let mut reason = JsString::from_rust_str("quota_guard:");
            reason.push(&verdict.get(c"window")?.coerce_string()?);
            reason.push_str(":");
            let math = auth.port.global()?.get(c"Math")?;
            let round = math.get(c"round")?;
            reason.push(
                &round
                    .call(math, &[verdict.get(c"usedPercent")?])?
                    .coerce_string()?,
            );
            reason.push_str("pct");
            return Ok(auth
                .reject(auth.port.from_value(&JsValue::String(reason))?, false)?
                .raw());
        }
    }
    let terminal_resolver = auth.port.get(c"resolveTerminalRoute")?;
    if !auth.record.truthy()? && auth.session.truthy()? && terminal_resolver.truthy()? {
        let terminal = terminal_resolver.call_plain(&[auth.session])?;
        if terminal.truthy()? {
            if !context.get(c"encoded")?.truthy()?
                || !context
                    .get(c"token")?
                    .clean_text()?
                    .equals(terminal.get(c"token")?.clean_text()?)?
            {
                return Ok(auth.deny("proxy_route_capability_mismatch", false)?.raw());
            }
            let requested = auth.input.get(c"providerId")?.clean_text()?;
            if role.is_string("main")?
                && requested.truthy()?
                && !requested.equals(terminal.get(c"providerId")?.clean_text()?)?
            {
                return Ok(auth.deny("provider_route_mismatch", false)?.raw());
            }
            if !role.is_string("main")? && !role.is_string("aux")? && requested.truthy()? {
                let allowed = terminal.get(c"allowedSubProviderIds")?;
                if !allowed
                    .get(c"includes")?
                    .call(allowed, &[requested])?
                    .truthy()?
                {
                    return Ok(auth.deny("provider_subroute_not_allowed", false)?.raw());
                }
            }
            let event = auth.port.from_value(&JsValue::object(vec![
                (
                    "type",
                    JsValue::string("provider_proxy_terminal_route_allowed"),
                ),
                ("operation", JsValue::string("proxy_preflight")),
            ]))?;
            event.set(c"runtimeEpoch", auth.port.get(c"runtimeEpoch")?)?;
            event.set(
                c"providerId",
                if requested.truthy()? {
                    requested
                } else {
                    terminal.get(c"providerId")?.clean_text()?
                },
            )?;
            event.set(c"role", role)?;
            auth.port
                .get(c"auditOnly")?
                .call_plain(&[auth.session, event])?;
            return Ok(auth.allow(true, false)?.raw());
        }
    }
    if !auth.session.truthy()? || !context.get(c"exact")?.truthy()? {
        return Ok(auth.deny("proxy_route_capability_mismatch", false)?.raw());
    }
    if background_lingers(auth.record)? {
        if let Some(code) = auth.route_error(role, true)? {
            return Ok(auth.deny(code, false)?.raw());
        }
        let resolver = auth.port.get(c"resolveProviderRevision")?;
        if resolver.truthy()? && !auth.revision_matches(resolver)? {
            return Ok(auth.deny("provider_revision_mismatch", false)?.raw());
        }
        return Ok(auth.allow(false, true)?.raw());
    }
    if !auth.record.truthy()? {
        return Ok(auth.deny("proxy_attempt_not_running", false)?.raw());
    }
    let lifecycle = auth.record.get(c"lifecycle")?;
    if !lifecycle.get(c"running")?.call(lifecycle, &[])?.truthy()? {
        return Ok(auth.deny("proxy_attempt_not_running", false)?.raw());
    }
    let lifecycle = auth.record.get(c"lifecycle")?;
    if lifecycle
        .get(c"budget")?
        .call(lifecycle, &[])?
        .get(c"stalled")?
        .truthy()?
    {
        return Ok(auth.deny("attempt_stalled", false)?.raw());
    }
    if let Some(code) = auth.route_error(role, false)? {
        return Ok(auth.deny(code, true)?.raw());
    }
    let resolver = auth.port.get(c"resolveProviderRevision")?;
    if resolver.truthy()? && !auth.revision_matches(resolver)? {
        return Ok(auth.deny("provider_revision_mismatch", true)?.raw());
    }
    Ok(auth.allow(false, false)?.raw())
}
