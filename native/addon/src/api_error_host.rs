//! Turn-owned API error decisions and retry timers on the host's event loop.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;

mod decision;
mod identity;
mod retry;

fn otherwise<'a>(value: L<'a>, fallback: L<'a>) -> Result<L<'a>> {
    Ok(if value.truthy()? { value } else { fallback })
}

fn freeze(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Object")?, c"freeze", &[v])
}

fn port<'a>(state: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    state.get(key)?.call_plain(args)
}

fn set_task<'a>(state: L<'a>, session: L<'a>, api_error: L<'a>, save: bool) -> Result<()> {
    port(
        state,
        c"setTaskState",
        &[
            session,
            fields(state, &[("apiError", api_error)])?,
            fields(state, &[("save", flag(state, save)?)])?,
        ],
    )?;
    Ok(())
}

fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let callbacks = [
        c"setTaskState",
        c"chatBroadcast",
        c"setSessionStatus",
        c"clearIncrementalSave",
        c"isCurrentTurnRunner",
        c"isShuttingDown",
    ];
    let state = pick(
        opts,
        &[c"policy", c"logger", c"persistedSessions", c"replay"],
    )?;
    for key in callbacks {
        state.set(key, opts.get(key)?)?;
    }
    for key in callbacks {
        if !callable(state.get(key)?)? {
            return Err(ports.type_error(&format!(
                "api error host dependency missing: {}",
                key.to_string_lossy()
            )));
        }
    }
    let policy = state.get(c"policy")?;
    if !policy.truthy()?
        || !callable(policy.get(c"evaluate")?)?
        || !callable(policy.get(c"recordSuccess")?)?
    {
        return Err(ports.type_error("api error host dependency missing: policy"));
    }
    if !state.get(c"logger")?.truthy()? || !state.get(c"persistedSessions")?.truthy()? {
        return Err(ports.type_error("api error host dependency missing: object port"));
    }
    let replay = state.get(c"replay")?;
    if !replay.truthy()? || !callable(replay.get(c"clear")?)? {
        return Err(ports.type_error("api error host dependency missing: replay"));
    }
    for key in [
        c"now",
        c"setTimeout",
        c"clearTimeout",
        c"recordProviderFailure",
        c"proxyFailureForAttempt",
    ] {
        let value = if callable(opts.get(key)?)? {
            opts.get(key)?
        } else if key == c"now" {
            state.global()?.get(c"Date")?.get(key)?
        } else if key == c"setTimeout" || key == c"clearTimeout" {
            state.global()?.get(key)?
        } else {
            null(state)?
        };
        state.set(key, value)?;
    }
    state.set(c"ports", ports)?;
    freeze(defaulted_methods(
        state,
        &[
            ("recordApiError", 1, 2, |s, a| {
                call(
                    s.get(c"policy")?,
                    c"evaluate",
                    &[a[0], default_object(a[1])?],
                )
            }),
            ("recordApiSuccess", 1, 2, |s, a| {
                call(
                    s.get(c"policy")?,
                    c"recordSuccess",
                    &[otherwise(a[0], text(s, "unknown")?)?, default_object(a[1])?],
                )?;
                undef(s)
            }),
            ("evaluateTurnApiError", 1, 1, decision::evaluate),
            ("meaningfulTurnOutput", 1, 1, |s, a| {
                flag(s, crate::chat_events::meaningful_output(a[0])?)
            }),
            ("turnHasSideEffects", 1, 1, |s, a| {
                let tools = a[0].optional(c"currentToolCalls")?;
                if !tools.truthy()? {
                    return flag(s, false);
                }
                let test = function(s, "", 1, 1, |s, a| {
                    flag(
                        s,
                        a[0].truthy()? && !a[0].get(c"name")?.is_string("Thinking")?,
                    )
                })?;
                flag(s, call(tools, c"some", &[test])?.truthy()?)
            }),
            ("clearSessionApiErrorState", 2, 2, |s, a| {
                if a[1].truthy()? {
                    a[1].assign(c"_apiRetryAttempt", num(s, 0.)?)?;
                    a[1].assign(c"_lastApiErrorDecision", null(s)?)?;
                }
                set_task(s, a[0], null(s)?, false)?;
                undef(s)
            }),
            ("scheduleOwnedRetry", 1, 1, retry::schedule),
            ("cancelRetry", 2, 2, retry::cancel),
            ("snapshot", 0, 0, |s, _| {
                fields(s, &[("policy", call(s.get(c"policy")?, c"snapshot", &[])?)])
            }),
        ],
    )?)
}

#[napi]
pub fn api_error_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(defaulted_methods(p, &[("createApiErrorHost", 0, 1, create)])?.raw())
}
