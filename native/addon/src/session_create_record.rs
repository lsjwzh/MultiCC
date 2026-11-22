//! Native session-record creation. Host functions and live JS objects stay in
//! V8; the ordered decisions and asynchronous continuation are owned by Rust.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as J, session_create_record as core};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Error, JsValue, Result,
};
use napi_derive::napi;
use std::{
    ffi::{CStr, CString},
    ptr,
    rc::Rc,
};

fn obj(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Object(vec![]))
}
fn text<'a>(a: L<'a>, s: &str) -> Result<L<'a>> {
    a.from_value(&J::string(s))
}
fn boolean(a: L<'_>, v: bool) -> Result<L<'_>> {
    a.from_value(&J::Bool(v))
}
fn null(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Null)
}
fn get<'a>(a: L<'a>, key: &str) -> Result<L<'a>> {
    a.get(&CString::new(key).expect("static key"))
}
fn set(a: L<'_>, key: &str, v: L<'_>) -> Result<()> {
    a.set(&CString::new(key).expect("static key"), v)
}
fn call<'a>(o: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    o.get(key)?.call(o, args)
}
fn port<'a>(d: L<'a>, key: &str, args: &[L<'a>]) -> Result<L<'a>> {
    get(d, key)?.call_plain(args)
}
fn string<'a>(a: L<'a>, value: L<'a>) -> Result<L<'a>> {
    a.global()?.get(c"String")?.call_plain(&[value])
}
fn fallback<'a>(a: L<'a>, value: L<'a>) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        null(a)
    }
}
fn fail<'a>(a: L<'a>, message: L<'a>) -> Result<L<'a>> {
    let o = obj(a)?;
    o.set(c"ok", boolean(a, false)?)?;
    o.set(c"error", message)?;
    Ok(o)
}
fn failure<'a>(a: L<'a>, message: &str) -> Result<L<'a>> {
    fail(a, text(a, message)?)
}
fn success(a: L<'_>) -> Result<L<'_>> {
    let o = obj(a)?;
    o.set(c"ok", boolean(a, true)?)?;
    Ok(o)
}
fn unknown<'a>(env: &'a Env, v: L<'a>) -> Unknown<'a> {
    unsafe { Unknown::from_raw_unchecked(env.raw(), v.raw()) }
}

struct Anchor {
    env: sys::napi_env,
    reference: sys::napi_ref,
}
impl Anchor {
    fn new(v: L<'_>) -> Result<Rc<Self>> {
        let mut reference = ptr::null_mut();
        check_status!(unsafe { sys::napi_create_reference(v.env(), v.raw(), 1, &mut reference) })?;
        Ok(Rc::new(Self {
            env: v.env(),
            reference,
        }))
    }
    fn value<'a>(&self, env: &'a Env) -> Result<L<'a>> {
        let mut v = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(self.env, self.reference, &mut v) })?;
        if v.is_null() {
            return Err(Error::from_reason("session creation state unavailable"));
        }
        Ok(L::from_raw(env.raw(), v))
    }
}
impl Drop for Anchor {
    fn drop(&mut self) {
        unsafe {
            sys::napi_delete_reference(self.env, self.reference);
        }
    }
}

const DEPS: &[&str] = &[
    "isResidentSession",
    "sharedWorkspace",
    "SUPPORTED_CHAT_CLIS",
    "validateExperimentalSession",
    "tuiChatMirrorEnabled",
    "normalizeEffort",
    "validEffortForCli",
    "codexDefaultReasoningLevel",
    "normalizeCliAgent",
    "validateProviderSelection",
    "providers",
    "primaryProviderCandidate",
    "providerDefaults",
    "validProviderId",
    "allocateSessionId",
    "persistedSessions",
    "ensureDirGitReady",
    "friendlyDirReason",
    "WORKTREE_SUBDIR",
    "gitWorktreeAdd",
    "gitWorktreeRollbackCreate",
    "sanitizeLoginEnv",
    "ensureCliStates",
    "sessionPersistence",
    "savePersistedSessionsBestEffort",
    "appendEvent",
    "cliForLoginFlow",
    "loginWorkspacePath",
];
const INPUTS: &[(&str, Option<&str>)] = &[
    ("dir", None),
    ("cli", None),
    ("kind", None),
    ("label", Some("null")),
    ("id", Some("null")),
    ("ephemeral", Some("false")),
    ("model", Some("null")),
    ("provider", None),
    ("providerSelection", Some("null")),
    ("effort", Some("null")),
    ("agent", Some("null")),
    ("subagent", None),
    ("cliAccounts", Some("null")),
    ("rolePrompt", Some("null")),
    ("rolePresetId", Some("null")),
    ("type", Some("null")),
    ("taskExecutionSlot", Some("false")),
    ("experimentalMode", Some("null")),
    ("loginFlow", Some("null")),
    ("loginEnv", Some("null")),
    ("persistence", Some("bestEffort")),
    ("persistenceSource", Some("runtime.create-session")),
    ("taskBoundTaskId", Some("null")),
    ("autoCommit", Some("true")),
    ("workspaceOwnerSessionId", Some("null")),
    ("workspaceBaseCommit", Some("null")),
    ("validateOnly", Some("false")),
];
fn inputs<'a>(value: L<'a>) -> Result<L<'a>> {
    if value.nullish()? {
        return Err(value.type_error(if value.undefined()? {
            "Cannot destructure property 'dir' of 'undefined' as it is undefined."
        } else {
            "Cannot destructure property 'dir' of 'object null' as it is null."
        }));
    }
    let out = obj(value)?;
    for (key, default) in INPUTS {
        let mut v = get(value, key)?;
        if v.undefined()? {
            if let Some(d) = default {
                v = match *d {
                    "null" => null(value)?,
                    "true" => boolean(value, true)?,
                    "false" => boolean(value, false)?,
                    _ => text(value, d)?,
                };
            }
        }
        set(out, key, v)?;
    }
    Ok(out)
}

// Prepare through the first suspension point. Returning an object with `done`
// distinguishes early validation results from a live operation state.
fn prepare<'a>(env: &'a Env, deps: L<'a>, input: L<'a>, path: L<'a>) -> Result<L<'a>> {
    let i = inputs(input)?;
    let state = obj(input)?;
    state.set(c"deps", deps)?;
    state.set(c"input", i)?;
    state.set(c"path", path)?;
    let dir = i.get(c"dir")?;
    let cli = i.get(c"cli")?;
    let kind = i.get(c"kind")?;
    macro_rules! early {
        ($v:expr) => {{
            state.set(c"done", $v?)?;
            return Ok(state);
        }};
    }
    if !dir.truthy()? {
        early!(failure(input, "directory not found"));
    }
    let supported = deps.get(c"SUPPORTED_CHAT_CLIS")?;
    if !call(supported, c"includes", &[cli])?.truthy()? {
        let joined = call(supported, c"join", &[text(input, ", ")?])?;
        early!(failure(
            input,
            &format!("cli must be {}", joined.coerce_string()?.to_string_lossy())
        ));
    }
    let chat = kind.is_string("chat")?;
    let terminal = kind.is_string("terminal")?;
    if !chat && !terminal {
        early!(failure(input, "kind must be terminal or chat"));
    }
    let cli_str = cli.string()?.map(|v| v.to_string_lossy());
    if cli_str.as_deref().is_some_and(core::chat_only_cli) && !chat {
        early!(failure(
            input,
            &format!(
                "{} only supports chat sessions",
                cli_str.as_deref().unwrap_or_default()
            )
        ));
    }
    let login = i.get(c"loginFlow")?;
    let login_cli = if login.is_string("codex-login")? {
        text(input, "codex")?
    } else if login.is_string("claude-auth-login")? {
        text(input, "claude")?
    } else {
        port(deps, "cliForLoginFlow", &[login])?
    };
    if login.truthy()? && (!login_cli.equals(cli)? || !terminal) {
        early!(failure(
            input,
            "loginFlow only supports whitelisted interactive login terminal sessions"
        ));
    }
    let x = obj(input)?;
    x.set(c"enabled", port(deps, "tuiChatMirrorEnabled", &[])?)?;
    x.set(c"cli", cli)?;
    x.set(c"kind", kind)?;
    x.set(c"experimentalMode", i.get(c"experimentalMode")?)?;
    let experiment = port(deps, "validateExperimentalSession", &[x])?;
    if !experiment.get(c"ok")?.truthy()? {
        early!(Ok::<_, Error>(experiment));
    }
    state.set(c"experiment", experiment)?;
    let model = i.get(c"model")?;
    if model.truthy()? && !core::valid_model(&model.coerce_string()?.to_string_lossy()) {
        early!(failure(input, "invalid model"));
    }
    let effort = port(deps, "normalizeEffort", &[i.get(c"effort")?])?;
    if effort.undefined()? {
        early!(failure(input, "invalid effort"));
    }
    if !port(deps, "validEffortForCli", &[cli, effort])?.truthy()? {
        early!(failure(input, "invalid reasoning level"));
    }
    let session_effort = if effort.truthy()? {
        effort
    } else if cli.is_string("codex")? || cli.is_string("codex-exp")? {
        port(deps, "codexDefaultReasoningLevel", &[])?
    } else {
        null(input)?
    };
    state.set(c"sessionEffort", session_effort)?;
    let agent = port(deps, "normalizeCliAgent", &[cli, i.get(c"agent")?])?;
    if agent.undefined()? {
        early!(failure(input, "invalid agent"));
    }
    state.set(c"sessionAgent", agent)?;
    let role = i.get(c"rolePrompt")?;
    let rp = if role.nullish()? {
        null(input)?
    } else {
        let s = string(input, role)?;
        call(s, c"trim", &[])?
    };
    if rp.truthy()? && rp.get(c"length")?.number()? > 40000.0 {
        early!(failure(input, "rolePrompt too long (max 40000)"));
    }
    state.set(c"rolePrompt", rp)?;
    let providers = deps.get(c"providers")?;
    let opts = obj(input)?;
    opts.set(c"cli", cli)?;
    opts.set(c"providers", providers)?;
    let selection = port(
        deps,
        "validateProviderSelection",
        &[i.get(c"providerSelection")?, opts],
    )?;
    if !selection.get(c"ok")?.truthy()? {
        early!(fail(input, selection.get(c"error")?));
    }
    state.set(c"selection", selection)?;
    let provider = i.get(c"provider")?;
    let pool = match cli_str.as_deref() {
        Some(s) => text(input, core::provider_family(s))?,
        None => cli,
    };
    let mut provider_id = if provider.undefined()? {
        let primary = port(
            deps,
            "primaryProviderCandidate",
            &[selection.get(c"value")?, cli],
        )?;
        let native = if primary.truthy()? {
            let pid = primary.get(c"providerId")?;
            let pid = if pid.truthy()? { pid } else { text(input, "")? };
            core::is_vendor_native_line(&string(input, pid)?.coerce_string()?.to_string_lossy())
        } else {
            false
        };
        let candidate = if native || primary.nullish()? {
            null(input)?
        } else {
            primary.get(c"providerId")?
        };
        if candidate.truthy()? {
            candidate
        } else {
            let default = deps.get(c"providerDefaults")?.get_key(pool)?;
            if default.truthy()? {
                default
            } else {
                null(input)?
            }
        }
    } else {
        let validated = port(deps, "validProviderId", &[cli, provider])?;
        if !validated.get(c"ok")?.truthy()? {
            early!(failure(input, "invalid provider"));
        }
        let selected = selection.get(c"value")?;
        if selected.truthy()? {
            let candidates = selected.get(c"candidates")?;
            let holder = obj(input)?;
            holder.set(c"validated", validated)?;
            let captured = Anchor::new(holder)?;
            let predicate = env.create_function_from_closure::<Unknown<'_>, bool, _>(
                "enabledCandidate",
                move |ctx| {
                    let env: &Env = ctx.env;
                    let absent = L::new(env, ().into_unknown(env)?);
                    let candidate = if ctx.length() > 0 {
                        L::new(env, ctx.get::<Unknown<'_>>(0)?)
                    } else {
                        absent
                    };
                    Ok(candidate.get(c"enabled")?.truthy()?
                        && candidate
                            .get(c"providerId")?
                            .equals(captured.value(env)?.get(c"validated")?.get(c"value")?)?)
                },
            )?;
            let predicate = L::from_raw(env.raw(), predicate.into_unknown(env)?.raw());
            let found = call(candidates, c"some", &[predicate])?.truthy()?;
            if !found {
                early!(failure(
                    input,
                    "Auto Provider fallback must be an enabled candidate"
                ));
            }
        }
        validated.get(c"value")?
    };
    if login.truthy()? {
        provider_id = null(input)?;
    } else {
        provider_id = call(
            providers,
            c"normalizeOfficialProviderId",
            &[pool, provider_id],
        )?;
    }
    state.set(c"providerId", provider_id)?;
    let login_checked = port(deps, "sanitizeLoginEnv", &[i.get(c"loginEnv")?, login])?;
    if !login_checked.get(c"ok")?.truthy()? {
        early!(fail(input, login_checked.get(c"error")?));
    }
    state.set(c"loginChecked", login_checked)?;
    let subagent = i.get(c"subagent")?;
    let uses_default = subagent.undefined()?;
    state.set(c"usesDefault", boolean(input, uses_default)?)?;
    let opts = obj(input)?;
    opts.set(c"cli", cli)?;
    opts.set(c"provider", provider_id)?;
    opts.set(c"providerDefaults", deps.get(c"providerDefaults")?)?;
    opts.set(c"validProviderId", deps.get(c"validProviderId")?)?;
    opts.set(c"providers", providers)?;
    let checked = if uses_default {
        let checked = obj(input)?;
        checked.set(c"ok", boolean(input, true)?)?;
        let value = if core::default_subagent_allowed(
            chat,
            login.truthy()?,
            i.get(c"ephemeral")?.truthy()?,
        ) {
            let raw = crate::session_subagent::session_subagent_family_default(
                *env,
                Some(unknown(env, opts)),
            )?;
            L::from_raw(env.raw(), raw)
        } else {
            null(input)?
        };
        checked.set(c"value", value)?;
        checked
    } else {
        opts.set(
            c"subagent",
            if subagent.nullish()? {
                null(input)?
            } else {
                subagent
            },
        )?;
        let raw =
            crate::session_subagent::session_subagent_normalize(*env, Some(unknown(env, opts)))?;
        L::from_raw(env.raw(), raw)
    };
    if !checked.get(c"ok")?.truthy()? {
        early!(fail(input, checked.get(c"error")?));
    }
    state.set(c"subagentChecked", checked)?;
    if i.get(c"validateOnly")?.truthy()? {
        early!(success(input));
    }
    let id = i.get(c"id")?;
    let sid = if id.truthy()? {
        id
    } else {
        port(deps, "allocateSessionId", &[dir, cli, kind])?
    };
    state.set(c"sid", sid)?;
    let records = deps.get(c"persistedSessions")?;
    if call(records, c"has", &[sid])?.truthy()? {
        let o = success(input)?;
        o.set(c"id", sid)?;
        o.set(c"session", call(records, c"get", &[sid])?)?;
        o.set(c"reused", boolean(input, true)?)?;
        early!(Ok::<_, Error>(o));
    }
    let deferred = core::deferred_workspace(
        chat,
        i.get(c"taskBoundTaskId")?.truthy()?,
        i.get(c"workspaceOwnerSessionId")?.truthy()?,
    );
    state.set(c"deferred", boolean(input, deferred)?)?;
    state.set(c"gitless", boolean(input, deferred || login.truthy()?)?)?;
    Ok(state)
}

fn promise_resolve<'a>(a: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let p = a.global()?.get(c"Promise")?;
    call(p, c"resolve", &[value])
}
fn promise_reject<'a>(a: L<'a>, error: Error) -> Result<L<'a>> {
    let exception = a.exception_value()?;
    let p = a.global()?.get(c"Promise")?;
    let v = if let Some(e) = exception {
        e
    } else {
        let e = a
            .global()?
            .get(c"Error")?
            .construct(&[text(a, &error.reason)?])?;
        e.set(c"code", text(a, error.status.as_ref())?)?;
        e
    };
    call(p, c"reject", &[v])
}
#[derive(Clone, Copy)]
enum Stage {
    Ready,
    Added,
    AddFailed,
    RollbackAdd,
    RollbackPersist,
}
fn bind<'a>(env: &'a Env, state: &Rc<Anchor>, stage: Stage) -> Result<L<'a>> {
    let captured = Rc::clone(state);
    let callback = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "sessionCreateContinuation",
        move |ctx| {
            let env: &Env = ctx.env;
            let state = captured.value(env)?;
            let absent = L::new(env, ().into_unknown(env)?);
            let arg = if ctx.length() > 0 {
                L::new(env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            let value = match stage {
                Stage::Ready => after_ready(env, &captured, state, arg),
                Stage::Added => after_added(env, &captured, state, arg),
                Stage::AddFailed => worktree_error(env, &captured, state, arg),
                Stage::RollbackAdd => worktree_failure(state, state.get(c"caught")?),
                Stage::RollbackPersist => Err(state.get(c"caught")?.throw_error()),
            }?;
            Ok(value.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), callback.into_unknown(env)?.raw()))
}
fn then<'a>(
    env: &'a Env,
    state: &Rc<Anchor>,
    promise: L<'a>,
    ok: Stage,
    err: Option<Stage>,
) -> Result<L<'a>> {
    let success = bind(env, state, ok)?;
    if let Some(err) = err {
        let error = bind(env, state, err)?;
        call(promise, c"then", &[success, error])
    } else {
        call(promise, c"then", &[success])
    }
}
fn worktree_failure<'a>(state: L<'a>, error: L<'a>) -> Result<L<'a>> {
    if error.nullish()? {
        let value = if error.undefined()? {
            "undefined"
        } else {
            "null"
        };
        return Err(error.type_error(&format!(
            "Cannot read properties of {value} (reading 'message')"
        )));
    }
    let message = error.get(c"message")?.coerce_string()?;
    failure(
        state,
        &format!("worktree 创建失败: {}", message.to_string_lossy()),
    )
}
fn rollback<'a>(
    env: &'a Env,
    state_ref: &Rc<Anchor>,
    state: L<'a>,
    error: L<'a>,
    stage: Stage,
) -> Result<L<'a>> {
    state.set(c"caught", error)?;
    let deps = state.get(c"deps")?;
    let i = state.get(c"input")?;
    let dir = i.get(c"dir")?;
    let result = port(
        deps,
        "gitWorktreeRollbackCreate",
        &[
            dir.get(c"path")?,
            state.get(c"worktreePath")?,
            state.get(c"branch")?,
            state.get(c"rollbackOptions")?,
        ],
    )?;
    let p = promise_resolve(state, result)?;
    then(env, state_ref, p, stage, None)
}
fn worktree_error<'a>(
    env: &'a Env,
    state_ref: &Rc<Anchor>,
    state: L<'a>,
    error: L<'a>,
) -> Result<L<'a>> {
    let i = state.get(c"input")?;
    if !state.get(c"gitless")?.truthy()? && !i.get(c"workspaceOwnerSessionId")?.truthy()? {
        rollback(env, state_ref, state, error, Stage::RollbackAdd)
    } else {
        worktree_failure(state, error)
    }
}
fn caught_or_error<'a>(a: L<'a>, e: Error) -> Result<L<'a>> {
    if let Some(v) = a.exception_value()? {
        Ok(v)
    } else {
        let v = a
            .global()?
            .get(c"Error")?
            .construct(&[text(a, &e.reason)?])?;
        v.set(c"code", text(a, e.status.as_ref())?)?;
        Ok(v)
    }
}
fn after_ready<'a>(
    env: &'a Env,
    state_ref: &Rc<Anchor>,
    state: L<'a>,
    ready: L<'a>,
) -> Result<L<'a>> {
    let d = state.get(c"deps")?;
    let i = state.get(c"input")?;
    let dir = i.get(c"dir")?;
    let sid = state.get(c"sid")?;
    if !ready.get(c"ok")?.truthy()? {
        return fail(
            state,
            port(d, "friendlyDirReason", &[ready.get(c"reason")?])?,
        );
    }
    let path = state.get(c"path")?;
    let worktree = call(
        path,
        c"join",
        &[dir.get(c"path")?, d.get(c"WORKTREE_SUBDIR")?, sid],
    )?;
    state.set(c"worktreePath", worktree)?;
    state.set(
        c"branch",
        text(
            state,
            &format!("multicc/{}", sid.coerce_string()?.to_string_lossy()),
        )?,
    )?;
    let rollback = obj(state)?;
    rollback.set(c"sessionId", sid)?;
    rollback.set(c"baseBranch", dir.get(c"baseBranch")?)?;
    state.set(c"rollbackOptions", rollback)?;
    if state.get(c"gitless")?.truthy()? {
        if i.get(c"loginFlow")?.truthy()? {
            state.set(c"worktreePath", null(state)?)?;
            state.set(c"branch", null(state)?)?;
        }
        return finish(env, state_ref, state);
    }
    let owner = i.get(c"workspaceOwnerSessionId")?;
    if owner.truthy()? {
        let result = port(
            d,
            "sharedWorkspace",
            &[d.get(c"persistedSessions")?, owner, dir.get(c"id")?],
        );
        return match result {
            Ok(v) => after_added(env, state_ref, state, v),
            Err(e) => {
                let error = caught_or_error(state, e)?;
                worktree_error(env, state_ref, state, error)
            }
        };
    }
    let base = i.get(c"workspaceBaseCommit")?;
    let base = if base.truthy()? {
        base
    } else {
        dir.get(c"baseBranch")?
    };
    let result = port(d, "gitWorktreeAdd", &[dir.get(c"path")?, sid, base]);
    match result {
        Ok(value) => {
            let p = promise_resolve(state, value)?;
            then(env, state_ref, p, Stage::Added, Some(Stage::AddFailed))
        }
        Err(e) => {
            let error = caught_or_error(state, e)?;
            worktree_error(env, state_ref, state, error)
        }
    }
}
fn after_added<'a>(
    env: &'a Env,
    state_ref: &Rc<Anchor>,
    state: L<'a>,
    value: L<'a>,
) -> Result<L<'a>> {
    // Object destructuring errors in the worktree try block are handled just
    // like a rejected worktree creation.
    let result = (|| -> Result<()> {
        state.set(c"worktreePath", value.get(c"worktreePath")?)?;
        state.set(c"branch", value.get(c"branch")?)?;
        Ok(())
    })();
    if let Err(e) = result {
        let error = caught_or_error(state, e)?;
        return worktree_error(env, state_ref, state, error);
    }
    finish(env, state_ref, state)
}

fn mutation_callback<'a>(env: &'a Env, state_ref: &Rc<Anchor>) -> Result<L<'a>> {
    let captured = Rc::clone(state_ref);
    let cb = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "recordMutation",
        move |ctx| {
            let env: &Env = ctx.env;
            let s = captured.value(env)?;
            let absent = L::new(env, ().into_unknown(env)?);
            let records = if ctx.length() > 0 {
                L::new(env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            Ok(call(records, c"set", &[s.get(c"sid")?, s.get(c"session")?])?.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), cb.into_unknown(env)?.raw()))
}
fn finish<'a>(env: &'a Env, state_ref: &Rc<Anchor>, state: L<'a>) -> Result<L<'a>> {
    let d = state.get(c"deps")?;
    let i = state.get(c"input")?;
    let sid = state.get(c"sid")?;
    let dir = i.get(c"dir")?;
    let cli = i.get(c"cli")?;
    let kind = i.get(c"kind")?;
    let date = state.global()?.get(c"Date")?.construct(&[])?;
    let created = call(date, c"toISOString", &[])?;
    let session = obj(state)?;
    for (key, value) in [
        ("id", sid),
        ("dirId", dir.get(c"id")?),
        ("cli", cli),
        ("kind", kind),
        ("cliSessionId", null(state)?),
        ("label", i.get(c"label")?),
        ("model", fallback(state, i.get(c"model")?)?),
        ("effort", fallback(state, state.get(c"sessionEffort")?)?),
        ("agent", fallback(state, state.get(c"sessionAgent")?)?),
        ("provider", state.get(c"providerId")?),
        ("providerSelection", state.get(c"selection")?.get(c"value")?),
        (
            "autoCommit",
            boolean(state, core::auto_commit(i.get(c"autoCommit")?.is_false()?))?,
        ),
    ] {
        set(session, key, value)?;
    }
    let resident_options = obj(state)?;
    resident_options.set(c"provider", state.get(c"providerId")?)?;
    resident_options.set(c"subagent", state.get(c"subagentChecked")?.get(c"value")?)?;
    let resident = port(d, "isResidentSession", &[cli, resident_options])?;
    let streaming = if resident.truthy()? {
        boolean(state, kind.is_string("chat")?)?
    } else {
        resident
    };
    session.set(c"streaming", streaming)?;
    session.set(c"autoContinue", boolean(state, true)?)?;
    session.set(c"createdAt", created)?;
    session.set(
        c"workspaceState",
        text(
            state,
            if state.get(c"deferred")?.truthy()? {
                "planned"
            } else {
                "awake"
            },
        )?,
    )?;
    session.set(c"workspaceBaseCommit", i.get(c"workspaceBaseCommit")?)?;
    session.set(c"lastWorkAt", created)?;
    session.set(c"worktreePath", state.get(c"worktreePath")?)?;
    session.set(
        c"workspaceOwnerSessionId",
        i.get(c"workspaceOwnerSessionId")?,
    )?;
    session.set(c"branch", state.get(c"branch")?)?;
    let rp = state.get(c"rolePrompt")?;
    if rp.truthy()? {
        session.set(c"rolePrompt", rp)?;
    }
    let sub = state.get(c"subagentChecked")?.get(c"value")?;
    if sub.truthy()? {
        let previous = null(state)?;
        let inherited = state.get(c"usesDefault")?;
        let raw = crate::session_subagent::session_subagent_with_source(
            *env,
            unknown(env, sub),
            Some(unknown(env, previous)),
            Some(unknown(env, inherited)),
        )?;
        session.set(c"subagent", L::from_raw(env.raw(), raw))?;
    }
    let accounts = i.get(c"cliAccounts")?;
    if accounts.truthy()?
        && accounts.kind()? == sys::ValueType::napi_object
        && !accounts.is_array()?
    {
        let object = state.global()?.get(c"Object")?;
        let entries = call(object, c"entries", &[accounts])?;
        let length = entries.get(c"length")?.number()? as u32;
        let picks = obj(state)?;
        let mut count = 0;
        for index in 0..length {
            let pair = entries.element(index)?;
            let key = pair.element(0)?;
            let id = pair.element(1)?;
            if id.kind()? == sys::ValueType::napi_string && id.truthy()? {
                picks.define_key(key, id)?;
                count += 1;
            }
        }
        if count > 0 {
            session.set(c"cliAccounts", picks)?;
        }
    }
    let preset = i.get(c"rolePresetId")?;
    if preset.truthy()? {
        let value = string(state, preset)?;
        session.set(c"rolePresetId", call(value, c"trim", &[])?)?;
    }
    let typ = i.get(c"type")?;
    if typ.truthy()? {
        session.set(c"type", typ)?;
    }
    let login = i.get(c"loginFlow")?;
    if login.truthy()? {
        session.set(c"loginFlow", login)?;
        let workspace = d.get(c"loginWorkspacePath")?;
        let cwd = if workspace.undefined()? {
            null(state)?
        } else {
            workspace.call_plain(&[sid])?
        };
        session.set(c"cwd", cwd)?;
    }
    let login_env = state.get(c"loginChecked")?.get(c"env")?;
    if login_env.truthy()? {
        session.set(c"loginEnv", login_env)?;
    }
    if typ.is_string("worker")? && i.get(c"taskExecutionSlot")?.truthy()? {
        session.set(c"taskExecutionSlot", boolean(state, true)?)?;
    }
    let ephemeral = i.get(c"ephemeral")?;
    if ephemeral.truthy()? {
        session.set(c"ephemeral", boolean(state, true)?)?;
    }
    let mode = state.get(c"experiment")?.get(c"mode")?;
    if mode.truthy()? {
        session.set(c"experimentalMode", mode)?;
    }
    let task = i.get(c"taskBoundTaskId")?;
    if task.truthy()? {
        let task = string(state, task)?;
        session.set(
            c"taskBoundTaskId",
            call(
                task,
                c"slice",
                &[
                    state.from_value(&J::Number(0.0))?,
                    state.from_value(&J::Number(120.0))?,
                ],
            )?,
        )?;
    }
    if kind.is_string("chat")? {
        port(d, "ensureCliStates", &[session])?;
    }
    state.set(c"session", session)?;
    let persisted = (|| -> Result<()> {
        let source = i.get(c"persistenceSource")?;
        if i.get(c"persistence")?.is_string("required")? {
            let persistence = d.get(c"sessionPersistence")?;
            let cb = mutation_callback(env, state_ref)?;
            call(persistence, c"mutate", &[source, cb])?;
        } else {
            let records = d.get(c"persistedSessions")?;
            call(records, c"set", &[sid, session])?;
            port(d, "savePersistedSessionsBestEffort", &[source])?;
        }
        Ok(())
    })();
    if let Err(e) = persisted {
        let error = caught_or_error(state, e)?;
        if !state.get(c"deferred")?.truthy()? && !i.get(c"workspaceOwnerSessionId")?.truthy()? {
            return rollback(env, state_ref, state, error, Stage::RollbackPersist);
        }
        return Err(error.throw_error());
    }
    let description = format!(
        "{} {}{}",
        cli.coerce_string()?.to_string_lossy(),
        kind.coerce_string()?.to_string_lossy(),
        if ephemeral.truthy()? { " (gw)" } else { "" }
    );
    port(
        d,
        "appendEvent",
        &[
            dir.get(c"id")?,
            text(state, "session_created")?,
            text(state, &description)?,
            sid,
        ],
    )?;
    let out = success(state)?;
    out.set(c"id", sid)?;
    out.set(c"session", session)?;
    Ok(out)
}

fn start<'a>(env: &'a Env, deps: L<'a>, input: L<'a>, path: L<'a>) -> Result<L<'a>> {
    let state = prepare(env, deps, input, path)?;
    let done = state.get(c"done")?;
    if !done.undefined()? {
        return promise_resolve(state, done);
    }
    let anchor = Anchor::new(state)?;
    if state.get(c"gitless")?.truthy()? {
        let ready = success(state)?;
        let value = after_ready(env, &anchor, state, ready)?;
        return promise_resolve(state, value);
    }
    let value = port(
        deps,
        "ensureDirGitReady",
        &[state.get(c"input")?.get(c"dir")?],
    )?;
    let promise = promise_resolve(state, value)?;
    then(env, &anchor, promise, Stage::Ready, None)
}

#[napi]
pub fn session_create_record_factory(
    env: Env,
    deps: Unknown<'_>,
    node_path: Unknown<'_>,
) -> Result<sys::napi_value> {
    let d = L::new(&env, deps);
    let resident = d.optional(c"isResidentSession")?;
    if resident.kind()? != sys::ValueType::napi_function {
        return Err(d.type_error("[session/create-record] isResidentSession port is required"));
    }
    let snapshot = obj(d)?;
    for key in DEPS {
        set(snapshot, key, get(d, key)?)?;
    }
    let holder = obj(d)?;
    holder.set(c"deps", snapshot)?;
    holder.set(c"path", L::new(&env, node_path))?;
    let anchor = Anchor::new(holder)?;
    let callback = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "createSessionRecord",
        move |ctx| {
            let env: &Env = ctx.env;
            let absent = L::new(env, ().into_unknown(env)?);
            let input = if ctx.length() > 0 {
                L::new(env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            let body = (|| -> Result<L<'_>> {
                let holder = anchor.value(env)?;
                start(env, holder.get(c"deps")?, input, holder.get(c"path")?)
            })();
            match body {
                Ok(value) => Ok(value.raw()),
                Err(error) => Ok(promise_reject(absent, error)?.raw()),
            }
        },
    )?;
    let value = L::from_raw(env.raw(), callback.into_unknown(&env)?.raw());
    let descriptor = sys::napi_property_descriptor {
        utf8name: c"length".as_ptr(),
        value: state_number(&env, 1.0)?,
        attributes: sys::PropertyAttributes::configurable,
        ..unsafe { std::mem::zeroed() }
    };
    check_status!(unsafe { sys::napi_define_properties(env.raw(), value.raw(), 1, &descriptor) })?;
    Ok(value.raw())
}
fn state_number(env: &Env, number: f64) -> Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_double(env.raw(), number, &mut value) })?;
    Ok(value)
}
