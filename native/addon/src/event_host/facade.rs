//! Construct one event catalog per compatibility host. Table references stay
//! stable, while validators read the current input and supplied clock/ID ports.
use super::{dispatch, string_or_null};
use crate::{host_methods::method, route_response::*};
use napi_derive::napi;

#[napi]
pub fn event_policy_api(env: Env, os: Unknown<'_>) -> Result<sys::napi_value> {
    let os = L::new(&env, os);
    let catalog = call(
        os.global()?.get(c"JSON")?,
        c"parse",
        &[text(os, &crate::events::events_catalog()?)?],
    )?;
    let pattern = method(&env, os, "eventPatternString", 1, 1, |_, a| {
        string_or_null(a[0])
    })?;
    let state = fields(
        os,
        &[("os", os), ("catalog", catalog), ("pattern", pattern)],
    )?;
    let catalog_api = fields(state, &[])?;
    let rules = fields(state, &[])?;
    let envelope = fields(state, &[])?;
    let transitions = fields(state, &[])?;
    for (target, key, field, frozen) in [
        (catalog_api, c"TASK_EVENTS", c"taskEvents", true),
        (catalog_api, c"TURN_EVENTS", c"turnEvents", true),
        (catalog_api, c"EVENT_TYPES", c"eventTypes", true),
        (catalog_api, c"ALIASES", c"aliases", true),
        (rules, c"ACTION_KINDS", c"actionKinds", true),
        (
            rules,
            c"MIN_INJECT_COOLDOWN_MS",
            c"minInjectCooldownMs",
            false,
        ),
        (rules, c"MAX_CHAIN_STEPS", c"maxChainSteps", false),
        (envelope, c"CONCLUSION_MAX", c"conclusionMax", false),
        (envelope, c"SUMMARY_MAX", c"summaryMax", false),
        (transitions, c"LETTER_EVENT", c"letterEvent", true),
        (transitions, c"GOAL_EVENT", c"goalEvent", true),
    ] {
        let value = catalog.get(field)?;
        target.set(key, if frozen { value.freeze()? } else { value })?;
    }
    let set = os
        .global()?
        .get(c"Set")?
        .construct(&[catalog.get(c"conclusionEvents")?])?;
    envelope.set(c"CONCLUSION_EVENTS", set.freeze()?)?;
    for (target, entries) in [
        (
            catalog_api,
            &[
                ("isKnownPattern", 1),
                ("matchesPattern", 2),
                ("matchesAny", 2),
            ][..],
        ),
        (
            rules,
            &[
                ("validateEventRule", 0),
                ("validateAction", 1),
                ("validateWebhookUrl", 1),
                ("matchesFilter", 2),
                ("channelActions", 1),
                ("channelProblem", 2),
            ][..],
        ),
        (
            envelope,
            &[
                ("redactText", 1),
                ("clipText", 2),
                ("summaryOf", 1),
                ("renderInjection", 2),
            ][..],
        ),
        (
            transitions,
            &[
                ("deriveTaskEvents", 2),
                ("segmentKey", 1),
                ("letterOf", 1),
                ("goalOf", 1),
            ][..],
        ),
    ] {
        for &(name, arity) in entries {
            let handler = method(&env, state, name, arity, 2, move |s, args| {
                let mut first = args[0];
                let mut second = args[1];
                let port = match name {
                    "matchesAny" => s.get(c"pattern")?,
                    "redactText" | "clipText" | "summaryOf" => s.get(c"os")?,
                    _ => s.from_value(&V::Undefined)?,
                };
                if name == "summaryOf" {
                    second = s.get(c"catalog")?.get(c"summaryMax")?;
                }
                if name == "validateEventRule" {
                    if first.undefined()? {
                        first = fields(s, &[])?;
                    }
                    if second.undefined()? {
                        second = fields(s, &[])?;
                    }
                    let options = fields(s, &[])?;
                    for key in [c"idFactory", c"nowIso", c"scope"] {
                        let value = crate::js_iteration::read(second, key)?;
                        options.set(
                            key,
                            if key == c"scope" && value.undefined()? {
                                text(s, "global")?
                            } else {
                                value
                            },
                        )?;
                    }
                    second = options;
                }
                dispatch(name, first, second, port)
            })?;
            target.set_key(text(state, name)?, handler)?;
        }
    }
    Ok(fields(
        state,
        &[
            ("catalog", catalog_api),
            ("rules", rules),
            ("envelope", envelope),
            ("transitions", transitions),
        ],
    )?
    .raw())
}
