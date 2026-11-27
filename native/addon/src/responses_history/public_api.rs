//! Public history operations and per-hook logger ownership.
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use napi_derive::napi;

#[napi]
pub fn codex_history_hooks_api(env: Env, history: Unknown<'_>) -> Result<sys::napi_value> {
    let history = super::make_rules(L::new(&env, history))?;
    let create = function(history, "createCodexHistoryHooks", 0, 1, |h, a| {
        let options = default_object(a[0])?;
        let logger = if crate::js_iteration::read(options, c"logger")?.truthy()?
            && options.get(c"logger")?.get(c"warn")?.kind()? == sys::ValueType::napi_function
        {
            options.get(c"logger")?
        } else {
            null(h)?
        };
        let owner = fields(h, &[("rules", h), ("logger", logger)])?;
        let hooks = fields(h, &[])?;
        for (name, method) in [
            ("onRequest", super::hooks::DialStage::Request),
            ("onUpstreamRejected", super::hooks::DialStage::Rejection),
        ] {
            hooks.set_key(
                text(h, name)?,
                function(owner, name, 1, 1, move |s, a| {
                    method.run(s.get(c"rules")?, a[0], s.get(c"logger")?)
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
    let h = super::make_rules(L::new(&env, history))?;
    let owner = fields(
        h,
        &[("rules", h), ("option", L::new(&env, normalize_option))],
    )?;
    let api = fields(h, &[])?;
    let methods: [(&str, usize, usize, super::Visitor); 7] = [
        ("fillWebSearchQueries", 1, 1, |_, a| {
            super::item_pass(a[0], super::ItemPass::Queries)
        }),
        ("normalizeResponsesHistory", 1, 2, |s, a| {
            let omit = s.get(c"option")?.call_plain(&[a[1]])?.truthy()?;
            super::normalize(s.get(c"rules")?, a[0], omit)
        }),
        ("preprocessResponsesHistory", 1, 1, |s, a| {
            super::preprocess::run(s.get(c"rules")?, a[0])
        }),
        ("repairRejectedResponsesHistory", 2, 2, |s, a| {
            super::repair::run(s.get(c"rules")?, a[0], a[1])
        }),
        ("stripReasoningContent", 1, 1, |_, a| {
            super::item_pass(a[0], super::ItemPass::Content)
        }),
        ("stripUnresolvedItemReferences", 1, 2, |s, a| {
            let ids = if a[1].undefined()? {
                super::array(s, &[])?
            } else {
                a[1]
            };
            super::references::run(a[0], ids)
        }),
        ("stripUnverifiableEncryptedContent", 1, 1, |_, a| {
            super::item_pass(a[0], super::ItemPass::Encrypted)
        }),
    ];
    for (name, length, count, run) in methods {
        api.set_key(text(h, name)?, function(owner, name, length, count, run)?)?;
    }
    Ok(api.raw())
}
