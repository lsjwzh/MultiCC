//! Compatibility factories over the same Rust adapters the low-level addon API exposes.
//! The returned callbacks retain instance state through V8's traced owner argument.
use crate::{
    claude_adapter as claude, codex_adapter as codex, codex_app_adapter as app,
    host_methods::{arg, args_default, default_object, env, function, raw},
    route_response::*,
};
use napi::bindgen_prelude::ToNapiValue;
use napi_derive::napi;

#[napi]
pub fn create_claude_adapter(
    e: Env,
    deps: Unknown<'_>,
    bridge: String,
    executable: String,
    host: Unknown<'_>,
) -> Result<sys::napi_value> {
    let h = L::new(&e, host);
    let ports = raw(
        h,
        claude::claude_adapter_ports(env(h), args_default(L::new(&e, deps))?, bridge, executable)?,
    );
    ports.set(c"displayName", h.get(c"displayName")?)?;
    ports.set(c"home", h.get(c"homedir")?)?;
    Ok(fields(
        h,
        &[
            ("name", text(h, "claude")?),
            ("createCompletionTracker", tracker(h, "claude")?),
            ("cmd", ports.get(c"cmd")?),
            (
                "buildTerminalCmd",
                function(ports, "buildTerminalCmd", 1, 1, |p, a| {
                    Ok(raw(
                        p,
                        claude::claude_adapter_terminal(env(p), arg(a[0])?, arg(p)?)?,
                    ))
                })?,
            ),
            (
                "buildInvocation",
                function(ports, "buildInvocation", 1, 1, |p, a| {
                    Ok(raw(
                        p,
                        claude::claude_adapter_invocation(env(p), arg(a[0])?, arg(p)?)?,
                    ))
                })?,
            ),
            (
                "decodeEvent",
                function(ports, "decodeEvent", 1, 1, |p, a| {
                    Ok(raw(
                        p,
                        claude::claude_adapter_decode(env(p), arg(a[0])?, arg(p)?)?,
                    ))
                })?,
            ),
            (
                "prepareSpawn",
                function(ports, "prepareSpawn", 1, 1, |p, a| {
                    let task = claude::claude_adapter_prepare_spawn(
                        env(p),
                        arg(crate::js_iteration::read(a[0], c"sessionId")?)?,
                        arg(p.get(c"home")?)?,
                    )?;
                    Ok(raw(p, unsafe {
                        napi::bindgen_prelude::AsyncTask::to_napi_value(p.env(), task)
                    }?))
                })?,
            ),
            ("needsAsyncSessionIdCapture", flag(h, false)?),
        ],
    )?
    .raw())
}

fn tracker<'a>(h: L<'a>, name: &'static str) -> Result<L<'a>> {
    use crate::cli_completion::tracker::{create, Protocol};
    function(h, "createCompletionTracker", 0, 0, move |h, _| {
        create(
            fields(h, &[])?,
            text(h, name)?,
            if name == "claude" {
                Protocol::Result
            } else {
                Protocol::Named
            },
        )
    })
}
#[napi]
pub fn create_codex_adapter(
    e: Env,
    deps: Unknown<'_>,
    host: Unknown<'_>,
) -> Result<sys::napi_value> {
    let h = L::new(&e, host);
    let ports = raw(h, codex::codex_adapter_ports(env(h), deps)?);
    ports.set(c"displayName", h.get(c"displayName")?)?;
    ports.set(c"extractUpstreamError", h.get(c"extractUpstreamError")?)?;
    let dispatch = |name, op: &'static str| {
        function(ports, name, 1, 1, move |p, a| {
            Ok(raw(
                p,
                codex::codex_adapter_call(env(p), op.to_owned(), arg(a[0])?, arg(p)?)?,
            ))
        })
    };
    Ok(fields(
        h,
        &[
            ("name", text(h, "codex")?),
            ("createCompletionTracker", tracker(h, "codex")?),
            ("cmd", ports.get(c"cmd")?),
            (
                "buildTerminalCmd",
                dispatch("buildTerminalCmd", "terminal")?,
            ),
            (
                "buildInvocation",
                dispatch("buildInvocation", "invocation")?,
            ),
            ("decodeEvent", dispatch("decodeEvent", "decode")?),
            ("needsAsyncSessionIdCapture", flag(h, true)?),
        ],
    )?
    .raw())
}
#[napi]
pub fn create_codex_exp_adapter(
    e: Env,
    deps: Unknown<'_>,
    gateway: String,
    executable: String,
    host: Unknown<'_>,
) -> Result<sys::napi_value> {
    let h = L::new(&e, host);
    let deps = default_object(L::new(&e, deps))?;
    let ports = raw(
        h,
        app::codex_app_adapter_ports(
            env(h),
            arg(deps)?,
            "codex-app-bridge".into(),
            gateway,
            executable,
        )?,
    );
    ports.set(c"displayName", h.get(c"displayName")?)?;
    let owner = app::RustCodexAppAdapter::default();
    Ok(fields(
        h,
        &[
            ("name", text(h, "codex-exp")?),
            ("cmd", ports.get(c"executable")?),
            ("createCompletionTracker", tracker(h, "codex-exp")?),
            (
                "buildTerminalCmd",
                function(deps, "buildTerminalCmd", 0, 0, |d, _| {
                    Ok(raw(
                        d,
                        app::codex_app_adapter_value(
                            env(d),
                            "terminal".into(),
                            arg(d)?,
                            arg(d.from_value(&V::Undefined)?)?,
                        )?,
                    ))
                })?,
            ),
            (
                "buildInvocation",
                function(ports, "buildInvocation", 1, 1, |p, a| {
                    let e = env(p);
                    Ok(raw(p, app::invocation::build(&e, a[0], p)?.raw()))
                })?,
            ),
            (
                "decodeEvent",
                function(ports, "decodeEvent", 1, 1, move |p, a| {
                    owner
                        .decode(env(p), arg(a[0])?, arg(p)?)
                        .map(|handle| raw(p, handle))
                })?,
            ),
            ("needsAsyncSessionIdCapture", flag(h, true)?),
        ],
    )?
    .raw())
}
