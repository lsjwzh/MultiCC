//! Per-host prompt settings and the once-per-session plan reset marker.
use crate::{
    js_iteration::read,
    js_live::{fields, LiveValue as L},
};
use multicc_core::{
    host_prompts as prompts,
    js::{JsString, JsValue as V},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{cell::RefCell, collections::HashSet};

fn or<'a>(value: L<'a>, default: V) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        value.from_value(&default)
    }
}

// String(Symbol(...)) is valid. Keep session keys in UTF-16 so distinct
// unpaired surrogates cannot consume one another's reset.
fn as_string(value: L<'_>) -> Result<L<'_>> {
    value.global()?.get(c"String")?.call_plain(&[value])
}

fn trimmed(value: L<'_>) -> Result<JsString> {
    let value = as_string(or(value, "".into())?)?;
    value.get(c"trim")?.call(value, &[])?.coerce_string()
}

// assistRoot may have a toJSON method. Preserve the original keyed JSON
// boundary before passing it to the existing core renderer.
fn render<'a>(op: &str, payload: L<'a>) -> Result<L<'a>> {
    let json = payload.global()?.get(c"JSON")?;
    let raw = json
        .get(c"stringify")?
        .call(json, &[payload])?
        .coerce_string()?;
    let output = prompts::request(op, &raw.to_string_lossy()).map_err(napi::Error::from_reason)?;
    json.get(c"parse")?
        .call(json, &[payload.from_value(&output.into())?])
}

#[napi]
pub fn host_human_assist(env: Env, root: Unknown<'_>) -> Result<sys::napi_value> {
    let root = L::new(&env, root);
    Ok(render(
        "human-assist",
        fields(root, &[("assistRoot", or(root, "".into())?)])?,
    )?
    .raw())
}

#[napi]
pub fn host_subagent_hint(env: Env, subagent: Unknown<'_>) -> Result<String> {
    subagent_hint(L::new(&env, subagent))
}
fn subagent_hint(subagent: L<'_>) -> Result<String> {
    if subagent.kind()? != sys::ValueType::napi_object {
        return Ok(String::new());
    }
    let provider = trimmed(read(subagent, c"providerId")?)?;
    if provider.is_empty() {
        return Ok(String::new());
    }
    let model = trimmed(read(subagent, c"model")?)?;
    Ok(prompts::subagent_provider_hint(
        &provider.to_string_lossy(),
        &model.to_string_lossy(),
    ))
}

#[napi]
pub fn host_codex_constraint(enabled: bool) -> String {
    multicc_core::session_question::codex_constraint(enabled)
}

#[napi]
pub fn host_prompt_bundle(
    env: Env,
    settings: Unknown<'_>,
    root: Unknown<'_>,
    lines: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(bundle(
        L::new(&env, settings),
        L::new(&env, root),
        L::new(&env, lines),
    )?
    .raw())
}
fn bundle<'a>(settings: L<'a>, root: L<'a>, lines: L<'a>) -> Result<L<'a>> {
    let empty = settings.from_value(&"".into())?;
    let constraint =
        host_codex_constraint(!read(settings, c"CODEX_NO_ASK_TOOL_HINT")?.is_string("0")?);
    let keep_alive = if read(settings, c"CODEX_STAY_ALIVE_HINT")?.is_string("0")? {
        empty
    } else {
        settings.from_value(&prompts::KEEP_ALIVE_PROMPT.into())?
    };
    let root = or(root, "".into())?;
    let port = as_string(or(read(settings, c"PORT")?, V::Number(3000.0))?)?;
    let hint = render(
        "host-hint",
        fields(
            settings,
            &[
                ("assistRoot", root),
                ("port", port),
                ("userInputLines", lines),
            ],
        )?,
    )?;
    let reminder = lines
        .get(c"join")?
        .call(lines, &[settings.from_value(&"\n".into())?])?;
    fields(
        settings,
        &[
            (
                "codexEnvConstraint",
                settings.from_value(&constraint.into())?,
            ),
            ("codexStayAlivePrompt", keep_alive),
            ("multiccImgHint", hint),
            ("userInputReminder", reminder),
        ],
    )
}

#[derive(Default)]
#[napi]
pub struct RustPlanPromptState {
    pending: RefCell<HashSet<JsString>>,
}

#[napi]
impl RustPlanPromptState {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn mark(&self, env: Env, session: Unknown<'_>) -> Result<()> {
        self.mark_live(L::new(&env, session))
    }

    #[napi]
    pub fn progress(&self, env: Env, session: Unknown<'_>, opts: Unknown<'_>) -> Result<String> {
        self.progress_live(L::new(&env, session), L::new(&env, opts))
    }
}
impl RustPlanPromptState {
    fn mark_live(&self, session: L<'_>) -> Result<()> {
        let name = trimmed(session)?;
        if !name.is_empty() {
            self.pending.borrow_mut().insert(name);
        }
        Ok(())
    }
    fn progress_live(&self, session: L<'_>, opts: L<'_>) -> Result<String> {
        let first = !opts.truthy()? || !read(opts, c"isFirstTurn")?.is_false()?;
        // Consume even on a first turn. Conversion can reenter this owner.
        let reset = if session.truthy()? {
            let key = as_string(session)?.coerce_string()?;
            self.pending.borrow_mut().remove(&key)
        } else {
            false
        };
        Ok(prompts::plan_progress_prompt(first || reset).into())
    }
}

#[napi]
pub fn host_prompts_api(env: Env, process: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::{
        host_methods::method,
        route_response::{call, text},
    };
    use std::rc::Rc;
    let process = L::new(&env, process);
    let prompt = multicc_core::session_question::request("prompt", "null")
        .map_err(napi::Error::from_reason)?;
    let lines = call(
        process.global()?.get(c"JSON")?,
        c"parse",
        &[text(process, &prompt)?],
    )?
    .freeze()?;
    let owner = fields(process, &[("process", process), ("lines", lines)])?;
    let plan = Rc::new(RustPlanPromptState::new());
    let marker = plan.clone();
    Ok(fields(
        owner,
        &[
            ("USER_INPUT_SIGNAL_PROMPT", lines),
            (
                "buildCodexUserInputConstraint",
                method(
                    &env,
                    owner,
                    "buildCodexUserInputConstraint",
                    0,
                    1,
                    |s, a| {
                        text(
                            s,
                            &host_codex_constraint(a[0].undefined()? || a[0].truthy()?),
                        )
                    },
                )?,
            ),
            (
                "buildSubagentProviderHint",
                method(&env, owner, "buildSubagentProviderHint", 1, 1, |s, a| {
                    text(s, &subagent_hint(a[0])?)
                })?,
            ),
            (
                "buildHumanAssistPrompt",
                method(&env, owner, "buildHumanAssistPrompt", 1, 1, |s, a| {
                    render(
                        "human-assist",
                        fields(s, &[("assistRoot", or(a[0], "".into())?)])?,
                    )
                })?,
            ),
            (
                "markPlanContextReset",
                method(&env, owner, "markPlanContextReset", 1, 1, move |s, a| {
                    marker.mark_live(a[0])?;
                    s.from_value(&V::Undefined)
                })?,
            ),
            (
                "buildPlanProgressPrompt",
                method(&env, owner, "buildPlanProgressPrompt", 3, 3, move |s, a| {
                    text(s, &plan.progress_live(a[1], a[2])?)
                })?,
            ),
            (
                "createHostPrompts",
                method(&env, owner, "createHostPrompts", 0, 2, |s, a| {
                    let settings = if a[0].undefined()? {
                        s.get(c"process")?.get(c"env")?
                    } else {
                        a[0]
                    };
                    let root = if a[1].undefined()? {
                        a[1]
                    } else {
                        read(a[1], c"assistRoot")?
                    };
                    bundle(settings, root, s.get(c"lines")?)
                })?,
            ),
        ],
    )?
    .raw())
}
