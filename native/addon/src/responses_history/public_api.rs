//! Public history operations and per-hook logger ownership.
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use napi_derive::napi;

#[napi]
pub fn codex_history_hooks_api(env: Env, history: Unknown<'_>) -> Result<sys::napi_value> {
    let history = L::new(&env, history);
    let create = function(history, "createCodexHistoryHooks", 0, 1, |h, a| {
        let options = default_object(a[0])?;
        let logger = if crate::js_iteration::read(options, c"logger")?.truthy()?
            && options.get(c"logger")?.get(c"warn")?.kind()? == sys::ValueType::napi_function
        {
            options.get(c"logger")?
        } else {
            null(h)?
        };
        let owner = fields(h, &[("history", h), ("logger", logger)])?;
        let hooks = fields(h, &[])?;
        for (name, method) in [
            ("onRequest", c"onRequest"),
            ("onUpstreamRejected", c"onUpstreamRejected"),
        ] {
            hooks.set_key(
                text(h, name)?,
                function(owner, name, 1, 1, move |s, a| {
                    call(s.get(c"history")?, method, &[a[0], s.get(c"logger")?])
                })?,
            )?;
        }
        hooks.freeze()
    })?;
    Ok(fields(history, &[("createCodexHistoryHooks", create)])?.raw())
}

#[napi]
pub fn model_history_api(
    env: Env,
    history: Unknown<'_>,
    normalize_option: Unknown<'_>,
) -> Result<sys::napi_value> {
    let h = L::new(&env, history);
    let owner = fields(
        h,
        &[("history", h), ("option", L::new(&env, normalize_option))],
    )?;
    let api = fields(h, &[])?;
    for (name, target, length, count) in [
        ("fillWebSearchQueries", c"fillQueries", 1, 1),
        ("normalizeResponsesHistory", c"normalize", 1, 2),
        ("preprocessResponsesHistory", c"preprocess", 1, 1),
        ("repairRejectedResponsesHistory", c"repair", 2, 2),
        ("stripReasoningContent", c"stripContent", 1, 1),
        ("stripUnresolvedItemReferences", c"stripReferences", 1, 2),
        ("stripUnverifiableEncryptedContent", c"stripEncrypted", 1, 1),
    ] {
        api.set_key(
            text(h, name)?,
            function(owner, name, length, count, move |s, a| {
                if target == c"normalize" {
                    a[1] = s.get(c"option")?.call_plain(&[a[1]])?
                }
                if target == c"stripReferences" && a[1].undefined()? {
                    a[1] = s.from_value(&V::Array(vec![]))?
                }
                call(s.get(c"history")?, target, a)
            })?,
        )?;
    }
    Ok(api.raw())
}
