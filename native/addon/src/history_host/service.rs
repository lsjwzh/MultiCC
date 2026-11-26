use super::*;
use crate::host_methods::variadic_method;

fn require_fn(obj: L<'_>, key: &str, nullable: bool) -> Result<()> {
    let v = obj.get_key(text(obj, key)?)?;
    if callable(v)? || (nullable && v.kind()? == sys::ValueType::napi_null) {
        Ok(())
    } else {
        Err(obj.type_error(&format!("[session] {key} must be a function")))
    }
}
#[napi]
pub fn history_service_with_owner(
    env: Env,
    native: Unknown<'_>,
    options: Unknown<'_>,
    lazy: Unknown<'_>,
) -> Result<sys::napi_value> {
    let n = L::new(&env, native);
    let opts = L::new(&env, options);
    let ports = fields(n, &[])?;
    for (k, default) in [
        (c"history", undefined(n)?),
        (c"idFactory", undefined(n)?),
        (c"clock", n.global()?.get(c"Date")?.get(c"now")?),
        (c"maxMessages", num(n, 10000.)?),
        (c"retentionPolicy", null(n)?),
        (c"postPersist", null(n)?),
        (
            c"onPostPersistError",
            function(n, "onPostPersistError", 0, 0, |n, _| undefined(n))?,
        ),
        (c"canDeleteSession", null(n)?),
        (
            c"isMessageProtected",
            function(n, "isMessageProtected", 2, 2, |n, a| {
                flag(n, a[1].get(c"taskId")?.truthy()?)
            })?,
        ),
        (
            c"referencingTasks",
            function(n, "referencingTasks", 0, 0, |n, _| array(n, &[]))?,
        ),
    ] {
        let v = opts.get(k)?;
        ports.set(k, if v.undefined()? { default } else { v })?;
    }
    let history = ports.get(c"history")?;
    call(n, c"sessionAssertChatHistoryPort", &[history])?;
    for (name, nullable) in [
        ("idFactory", false),
        ("clock", false),
        ("canDeleteSession", true),
        ("isMessageProtected", false),
        ("referencingTasks", false),
    ] {
        require_fn(ports, name, nullable)?;
    }
    let limit = ports.get(c"maxMessages")?;
    if !call(n.global()?.get(c"Number")?, c"isSafeInteger", &[limit])?.truthy()?
        || limit.number()? < 1.
    {
        return Err(n.type_error("[session] maxMessages must be a positive integer"));
    }
    for (name, nullable) in [
        ("retentionPolicy", true),
        ("postPersist", true),
        ("onPostPersistError", false),
    ] {
        require_fn(ports, name, nullable)?;
    }
    ports.set(c"withLazyMessages", L::new(&env, lazy))?;
    let anchor = fields(n, &[("ports", ports)])?;
    let owner = n.get(c"RustChatHistory")?.construct(&[anchor])?;
    let service = fields(n, &[])?;
    let f = fields(n, &[("owner", owner), ("anchor", anchor)])?;
    for name in [
        "append",
        "assertCanDeleteSession",
        "commitAppend",
        "containsDelivery",
        "deleteSession",
        "discardAppend",
        "ensurePersistedIds",
        "handoffCheckpoint",
        "hasPersistedDelivery",
        "invalidate",
        "latestAssistantAt",
        "latestAssistantConclusion",
        "paginate",
        "prepareAppend",
        "read",
        "remove",
        "replace",
        "taskContextSnapshot",
        "upsertInterim",
        "view",
    ] {
        let method = if name == "hasPersistedDelivery"
            && callable(history.get(c"hasPersistedDeliveryAsync")?)?
        {
            function(history, "", 2, 2, |h, a| {
                call(h, c"hasPersistedDeliveryAsync", a)
            })?
        } else {
            variadic_method(&env, f, "", 0, move |f, a| {
                call(
                    f.get(c"owner")?,
                    c"run",
                    &[f.get(c"anchor")?, text(f, name)?, array(f, a)?],
                )
            })?
        };
        service.set_key(text(n, name)?, method)?;
    }
    Ok(fields(
        n,
        &[
            ("service", service.freeze()?),
            ("owner", owner),
            ("anchor", anchor),
        ],
    )?
    .raw())
}

#[napi]
pub fn history_assert_deps(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    let d = L::new(&env, deps);
    if d.nullish()? || d.kind()? != sys::ValueType::napi_object {
        return Err(d.type_error("chat history dependencies are required"));
    }
    let missing = |s: &str| d.type_error(&format!("chat history dependency missing: {s}"));
    let h = d.get(c"history")?;
    if h.nullish()? || h.kind()? != sys::ValueType::napi_object {
        return Err(missing("history"));
    }
    for name in [
        "read",
        "writeAsync",
        "writeVisibilityAsync",
        "deleteSession",
        "hasPersistedDelivery",
    ] {
        if !callable(h.get_key(text(d, name)?)?)? {
            return Err(missing(&format!("history.{name}")));
        }
    }
    for name in ["persistedSessions", "chatSessions"] {
        if !callable(d.get_key(text(d, name)?)?.optional(c"get")?)? {
            return Err(missing(name));
        }
    }
    for name in [
        "idFactory",
        "chatBroadcast",
        "distillHistoryIntoMemory",
        "maybeSchedulePeriodicMemoryReview",
        "cliSwitchGitSnapshot",
        "clearAllNativeCliStates",
        "buildHandoffCheckpoint",
        "rememberActiveCliState",
    ] {
        if !callable(d.get_key(text(d, name)?)?)? {
            return Err(missing(name));
        }
    }
    if !callable(d.get(c"chatStream")?.optional(c"close")?)? {
        return Err(missing("chatStream.close"));
    }
    for name in ["projectMessages", "cwdForSession", "taskShortCode"] {
        let v = d.get_key(text(d, name)?)?;
        if !v.nullish()? && !callable(v)? {
            return Err(d.type_error(&format!("chat history dependency invalid: {name}")));
        }
    }
    Ok(d.raw())
}
