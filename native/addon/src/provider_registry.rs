//! Node transport for provider registry rules.
mod opencode;

use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use multicc_core::provider_registry::{ProviderCliFacts, ProviderIdQueries};
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

/// One live defaults owner; the production compatibility facade is not wired yet.
#[napi]
pub struct RustProviderDefaultsStore {
    inner: multicc_core::provider_defaults_store::ProviderDefaultsStore,
}

#[napi]
impl RustProviderDefaultsStore {
    #[napi(constructor)]
    pub fn new(file: String) -> Self {
        Self {
            inner: multicc_core::provider_defaults_store::ProviderDefaultsStore::open(file.into()),
        }
    }

    #[napi]
    pub fn snapshot(&self, env: Env) -> Result<sys::napi_value> {
        unsafe { crate::js_bridge::write_value(env.raw(), &self.inner.snapshot()) }
    }

    #[napi]
    pub fn assert_readable(&self) -> Result<()> {
        self.inner
            .assert_readable()
            .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn get(&self, env: Env, key: String) -> Result<sys::napi_value> {
        unsafe { crate::js_bridge::write_value(env.raw(), &self.inner.get(&key)) }
    }

    #[napi]
    pub fn set(&mut self, env: Env, key: String, input: Unknown<'_>) -> Result<()> {
        let value =
            unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
        self.inner.set(&key, value);
        Ok(())
    }

    #[napi]
    pub fn delete(&mut self, key: String) {
        self.inner.delete(&key);
    }

    #[napi]
    pub fn patch(&mut self, env: Env, input: Unknown<'_>) -> Result<()> {
        let value =
            unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
        self.inner.patch(value);
        Ok(())
    }

    #[napi]
    pub fn replace(&mut self, env: Env, input: Unknown<'_>) -> Result<()> {
        let value =
            unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
        self.inner.replace(value).map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn persist(&self) -> Result<()> {
        self.inner.persist().map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn commit(&mut self, env: Env, input: Unknown<'_>) -> Result<()> {
        let value =
            unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
        self.inner.commit(value).map_err(napi::Error::from_reason)
    }
}

#[napi]
pub fn provider_native_line(
    cli: Option<String>,
    id: String,
    phase: u32,
    vendors: Vec<String>,
    suffix: String,
    prefix: String,
) -> u32 {
    multicc_core::provider_registry::native_provider_line(
        cli.as_deref(),
        &id,
        phase,
        &vendors,
        &suffix,
        &prefix,
    )
}

/// `String(value)` for a truthy value; `None` for a falsy one. Mirrors the
/// `value || ''` / `String(...)` pairs the retired rules used.
fn live_truthy_text(string: L<'_>, value: L<'_>) -> Result<Option<String>> {
    if !value.truthy()? {
        return Ok(None);
    }
    let text = string.call_plain(&[value])?;
    Ok(text.string()?.map(|text| text.to_string_lossy()))
}

/// Reads the six [`multicc_core::provider_registry::ProviderCliFacts`] out of a
/// live provider summary/object. A falsy provider is `None`; a truthy primitive
/// reads every member as `undefined`, like JavaScript property access.
fn live_provider_cli_facts(anchor: L<'_>, value: L<'_>) -> Result<Option<ProviderCliFacts>> {
    if !value.truthy()? {
        return Ok(None);
    }
    let string = anchor.global()?.get(c"String")?;
    Ok(Some(ProviderCliFacts {
        app_type: value
            .get(c"appType")?
            .string()?
            .map(|text| text.to_string_lossy()),
        virtual_truthy: value.get(c"virtual")?.truthy()?,
        api_format: live_truthy_text(string, value.get(c"apiFormat")?)?,
        protocol: live_truthy_text(string, value.get(c"protocol")?)?,
        base_url_truthy: value.get(c"baseUrl")?.truthy()?,
        has_token_truthy: value.get(c"hasToken")?.truthy()?,
    }))
}

/// The two lazy facts the core validator cannot know: the official-catalog
/// normalizer and the provider-store summary. Both stay in the Node process and
/// are called in the retired order, only when the core reaches them.
struct LiveProviderIdQueries<'a> {
    anchor: L<'a>,
    providers: L<'a>,
    normalize: L<'a>,
    string: L<'a>,
    /// The cli exactly as the caller passed it, for a non-string cli the
    /// normalizer must still receive unchanged.
    cli_raw: L<'a>,
}

impl<'a> ProviderIdQueries for LiveProviderIdQueries<'a> {
    type Raw = L<'a>;
    type Error = napi::Error;

    fn can_normalize(&self) -> Result<bool> {
        Ok(self.normalize.kind()? == sys::ValueType::napi_function)
    }

    fn normalize(&mut self, cli: Option<&str>, id: &L<'a>) -> Result<Option<String>> {
        let target = match cli {
            Some(text) => self.anchor.from_value(&V::string(text))?,
            None => self.cli_raw,
        };
        let normalized = self.normalize.call(self.providers, &[target, *id])?;
        if normalized.nullish()? {
            return Ok(None);
        }
        // `String(normalized)`: the value every later rule and the answer use.
        let text = self.string.call_plain(&[normalized])?;
        Ok(text.string()?.map(|text| text.to_string_lossy()))
    }

    fn stringify(&mut self, id: &L<'a>) -> Result<Option<String>> {
        if id.nullish()? {
            return Ok(None);
        }
        let text = self.string.call_plain(&[*id])?;
        Ok(text.string()?.map(|text| text.to_string_lossy()))
    }

    fn summary(&mut self, app_type: Option<&str>, id: &str) -> Result<Option<ProviderCliFacts>> {
        let pool = match app_type {
            Some(text) => self.anchor.from_value(&V::string(text))?,
            None => self.anchor.from_value(&V::Undefined)?,
        };
        let provider_id = self.anchor.from_value(&V::string(id))?;
        // The runtime is read only now: the retired code touched
        // `deps.providerRouterRuntime` for the first time at this step, so a
        // missing runtime must not fail an id that never reaches rule ⑤.
        let runtime = self.anchor.get(c"providerRouterRuntime")?;
        let summary = runtime
            .get(c"getProviderSummary")?
            .call(runtime, &[pool, provider_id])?;
        live_provider_cli_facts(self.anchor, summary)
    }
}

/// Validation owns the control flow (`multicc_core::provider_registry`) while
/// the official catalog and the provider store stay in Node. Calls stay lazy
/// and in legacy order, including the `String(id)` coercion.
#[napi]
pub fn provider_validate_id(
    env: Env,
    deps: Unknown<'_>,
    cli: Unknown<'_>,
    id: Unknown<'_>,
    vendors: Vec<String>,
    suffix: String,
    prefix: String,
) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    let cli = L::new(&env, cli);
    let id = L::new(&env, id);
    let providers = deps.get(c"providers")?;
    let mut queries = LiveProviderIdQueries {
        anchor: deps,
        providers,
        normalize: providers.get(c"normalizeOfficialProviderId")?,
        string: deps.global()?.get(c"String")?,
        cli_raw: cli,
    };
    let cli_text = cli.string()?.map(|text| text.to_string_lossy());
    let validated = multicc_core::provider_registry::validate_provider_id(
        &mut queries,
        cli_text.as_deref(),
        &id,
        &vendors,
        &suffix,
        &prefix,
    )?;
    let result = deps.from_value(&V::Object(vec![]))?;
    result.set(c"ok", deps.from_value(&V::Bool(validated.ok))?)?;
    if let Some(value) = validated.value {
        result.set(c"value", deps.from_value(&V::string(&value))?)?;
    }
    Ok(result.raw())
}

/// `compatibleClisForFormat` + the credential gate, for the summary projection
/// and the model picker.
#[napi]
pub fn provider_compatible_clis(api_format: String, has_credentials: bool) -> Vec<String> {
    multicc_core::provider_registry::compatible_clis(&api_format, has_credentials)
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// `appTypeForCli`: a non-string cli hits no `===` branch and answers `null`.
#[napi]
pub fn provider_app_type_for_cli(env: Env, cli: Unknown<'_>) -> Result<Option<String>> {
    let cli = L::new(&env, cli);
    let Some(text) = cli.string()? else {
        return Ok(None);
    };
    let text = text.to_string_lossy();
    Ok(multicc_core::provider_registry::app_type_for_cli(&text).map(str::to_string))
}

/// `appTypesForCli`: the pools a cli may bind a provider from.
#[napi]
pub fn provider_app_types_for_cli(env: Env, cli: Unknown<'_>) -> Result<Vec<String>> {
    let cli = L::new(&env, cli);
    let Some(text) = cli.string()? else {
        return Ok(Vec::new());
    };
    let text = text.to_string_lossy();
    Ok(multicc_core::provider_registry::app_types_for_cli(&text)
        .into_iter()
        .map(str::to_string)
        .collect())
}

/// `providerSupportsCli(provider, cli)`: `String(cli)` decides, so a truthy
/// non-string cli still answers through its string form. A provider with a
/// `settingsConfig` must be summarized by the caller before it arrives here.
#[napi]
pub fn provider_supports_cli(env: Env, provider: Unknown<'_>, cli: Unknown<'_>) -> Result<bool> {
    let provider = L::new(&env, provider);
    let cli = L::new(&env, cli);
    let string = provider.global()?.get(c"String")?;
    let cli_text = live_truthy_text(string, cli)?;
    let facts = live_provider_cli_facts(provider, provider)?;
    Ok(multicc_core::provider_registry::provider_supports_cli(
        facts.as_ref(),
        cli_text.as_deref(),
    ))
}

#[napi]
pub fn provider_sanitize_probe_result(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = multicc_core::provider_registry::sanitize_probe_result_js(&value);
    unsafe { crate::js_bridge::write_value(raw, &result) }
}

/// One `{ kind, sessionId, sessionName }` reference, frozen as the retired
/// `src/providers/references.js` froze it. `sessionName` keeps the legacy
/// falsy chain `name || label || id || ''` and the `String(...)` coercion, so a
/// numeric or absent name reads exactly as before.
fn session_reference<'a>(anchor: L<'a>, kind: &str, session: L<'a>) -> Result<L<'a>> {
    let string = anchor.global()?.get(c"String")?;
    let id = session.get(c"id")?;
    let mut name = session.get(c"name")?;
    if !name.truthy()? {
        name = session.get(c"label")?;
    }
    if !name.truthy()? {
        name = id;
    }
    if !name.truthy()? {
        name = anchor.from_value(&V::string(""))?;
    }
    let reference = anchor.from_value(&V::Object(vec![]))?;
    reference.set(c"kind", anchor.from_value(&V::string(kind))?)?;
    reference.set(c"sessionId", string.call_plain(&[id])?)?;
    reference.set(c"sessionName", string.call_plain(&[name])?)?;
    reference.freeze()
}

/// `String(value || '')`, i.e. the retired code's *falsy* chain -- not a nullish
/// one. `0` and `false` collapse to the empty string here, which is what makes
/// a numeric-zero provider id have no references at all.
fn falsy_string(anchor: L<'_>, value: L<'_>) -> Result<String> {
    if !value.truthy()? {
        return Ok(String::new());
    }
    Ok(anchor
        .global()?
        .get(c"String")?
        .call_plain(&[value])?
        .string()?
        .map(|text| text.to_string_lossy())
        .unwrap_or_default())
}

/// Which sessions, defaults and Aux config still point at a provider, i.e. what
/// a delete would break. Rust owns the walk and every membership rule
/// (`multicc_core::provider_registry::reference_*`); the live session table,
/// the defaults view and the Aux config stay in the Node process and are read
/// here lazily, in the retired handler's order.
///
/// The id is compared with `===` against the *trimmed* target, as before: a
/// session holding a padded or non-string provider value is not a reference.
#[napi]
pub fn provider_find_references(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    let app_type = falsy_string(input, input.get(c"appType")?)?
        .trim()
        .to_string();
    let provider_id = falsy_string(input, input.get(c"providerId")?)?
        .trim()
        .to_string();
    let references = input.from_value(&V::Array(vec![]))?;
    if !multicc_core::provider_registry::reference_target_is_poolable(&app_type, &provider_id) {
        return Ok(references.freeze()?.raw());
    }
    let target = input.from_value(&V::string(&provider_id))?;
    let push = references.get(c"push")?;

    let sessions = input.get(c"sessions")?;
    let map_ctor = input.global()?.get(c"Map")?;
    let values = if sessions.instance_of(map_ctor)? {
        sessions.get(c"values")?.call(sessions, &[])?
    } else if sessions.is_array()? {
        sessions
    } else {
        input.from_value(&V::Array(vec![]))?
    };

    values.for_each(|session| {
        if !session.truthy()? {
            return Ok(());
        }
        let cli = session.get(c"cli")?;
        let cli_text = cli.string()?.map(|value| value.to_string_lossy());
        if !multicc_core::provider_registry::reference_cli_spans_pools(cli_text.as_deref())
            && multicc_core::provider_registry::reference_app_type_for_cli(cli_text.as_deref())
                != Some(app_type.as_str())
        {
            return Ok(());
        }
        if session.get(c"provider")?.equals(target)? {
            let reference = session_reference(input, "main", session)?;
            push.call(references, &[reference])?;
        }
        let selection = session.get(c"providerSelection")?;
        if !selection.nullish()? && selection.get(c"mode")?.is_string("auto")? {
            let candidates = selection.get(c"candidates")?;
            if !candidates.nullish()? {
                let mut matched = false;
                candidates.for_each(|candidate| {
                    if !matched && candidate.get(c"providerId")?.equals(target)? {
                        matched = true;
                    }
                    Ok(())
                })?;
                if matched {
                    let reference = session_reference(input, "auto_candidate", session)?;
                    push.call(references, &[reference])?;
                }
            }
        }
        let subagent = session.get(c"subagent")?;
        if subagent.truthy()? && subagent.get(c"providerId")?.equals(target)? {
            let reference = session_reference(input, "subagent", session)?;
            push.call(references, &[reference])?;
        }
        Ok(())
    })?;

    let defaults = input.get(c"defaults")?;
    if defaults.truthy()? {
        let key = input.from_value(&V::string(&app_type))?;
        if defaults.get_key(key)?.equals(target)? {
            let reference = input.from_value(&V::Object(vec![]))?;
            reference.set(c"kind", input.from_value(&V::string("default"))?)?;
            reference.set(c"cli", input.from_value(&V::string(&app_type))?)?;
            push.call(references, &[reference.freeze()?])?;
        }
    }

    let aux = input.get(c"aux")?;
    if aux.truthy()? && aux.get(c"providerId")?.equals(target)? {
        let protocol = aux.get(c"protocol")?;
        // No trim here: the retired rule lowercased but never trimmed, so a
        // padded `" openai "` stayed an Anthropic-shaped route.
        let protocol_text = falsy_string(input, protocol)?;
        if multicc_core::provider_registry::reference_aux_app_type(Some(&protocol_text)) == app_type
        {
            let reference = input.from_value(&V::Object(vec![]))?;
            reference.set(c"kind", input.from_value(&V::string("aux"))?)?;
            let shown = if protocol.truthy()? {
                protocol
            } else {
                input.from_value(&V::string("anthropic"))?
            };
            reference.set(c"protocol", shown)?;
            push.call(references, &[reference.freeze()?])?;
        }
    }
    Ok(references.freeze()?.raw())
}

/// The patch body that unwires `providerId` from one session, plus the manual
/// fallback to retry with when the trimmed Auto pool no longer validates.
///
/// Reads the *desired* state (staged pending configuration included) through
/// the caller's `desiredSession`, so a staged edit is not resurrected by the
/// detach. Rust owns the branch rules
/// (`multicc_core::provider_registry::detach_keeps_auto` / `detach_max_attempts`);
/// the session shape itself stays JavaScript, including the `...selection`
/// spread, so key order on the stored selection is preserved exactly.
fn session_detach_plan<'a>(
    anchor: L<'a>,
    desired_session: L<'a>,
    session: L<'a>,
    provider_id: L<'a>,
) -> Result<(L<'a>, L<'a>)> {
    let view = if session.get(c"pendingConfiguration")?.truthy()? {
        desired_session.call_plain(&[session])?
    } else {
        session
    };
    let body = anchor.from_value(&V::Object(vec![]))?;
    let mut fallback = anchor.from_value(&V::Null)?;
    let selection = view.get(c"providerSelection")?;
    let auto = selection.truthy()? && selection.get(c"mode")?.is_string("auto")?;
    let mut names_target = false;
    if auto {
        let candidates = selection.get(c"candidates")?;
        if candidates.truthy()? {
            candidates.for_each(|candidate| {
                if !names_target
                    && candidate.truthy()?
                    && candidate.get(c"providerId")?.equals(provider_id)?
                {
                    names_target = true;
                }
                Ok(())
            })?;
        }
    }
    if auto && names_target {
        // `(selection.candidates || []).filter(...)`: rows that are falsy or
        // name the provider go, and `enabled !== false` keeps an absent flag.
        let kept = anchor.from_value(&V::Array(vec![]))?;
        let enabled = anchor.from_value(&V::Array(vec![]))?;
        let kept_push = kept.get(c"push")?;
        let enabled_push = enabled.get(c"push")?;
        let candidates = selection.get(c"candidates")?;
        if candidates.truthy()? {
            candidates.for_each(|candidate| {
                if !candidate.truthy()? || candidate.get(c"providerId")?.equals(provider_id)? {
                    return Ok(());
                }
                kept_push.call(kept, &[candidate])?;
                if !candidate.get(c"enabled")?.is_false()? {
                    enabled_push.call(enabled, &[candidate])?;
                }
                Ok(())
            })?;
        }
        let enabled_len = enabled.get(c"length")?.number()? as usize;
        let first = enabled.element(0)?;
        let manual = anchor.from_value(&V::Object(vec![]))?;
        manual.set(c"providerSelection", anchor.from_value(&V::Null)?)?;
        manual.set(
            c"provider",
            if first.truthy()? {
                first.get(c"providerId")?
            } else {
                anchor.from_value(&V::Null)?
            },
        )?;
        if multicc_core::provider_registry::detach_keeps_auto(enabled_len) {
            let next = anchor.from_value(&V::Object(vec![]))?;
            next.spread_from(selection)?;
            next.set(c"candidates", kept)?;
            next.set(
                c"maxAttempts",
                anchor.from_value(&V::Number(
                    multicc_core::provider_registry::detach_max_attempts(enabled_len),
                ))?,
            )?;
            body.set(c"providerSelection", next)?;
            // A routing tier may still name the removed candidate; if the
            // trimmed pool fails validation, retry as a manual route.
            fallback = manual;
        } else {
            body.spread_from(manual)?;
        }
    } else if view.get(c"provider")?.equals(provider_id)? {
        body.set(c"provider", anchor.from_value(&V::Null)?)?;
    }
    let subagent = view.get(c"subagent")?;
    if subagent.truthy()? && subagent.get(c"providerId")?.equals(provider_id)? {
        body.set(c"subagent", anchor.from_value(&V::Null)?)?;
    }
    Ok((body, fallback))
}

/// Plan each effect on the Node-owned session table. The host applies effects
/// in order and feeds the settled PATCH response back before advancing.
#[napi]
pub fn provider_detach_request(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    let result = match op.as_str() {
        "scope" => detach_scope(input)?,
        "session" => detach_session(input)?,
        "response" => detach_response(input)?,
        _ => {
            return Err(napi::Error::from_reason(
                "invalid provider detach operation",
            ))
        }
    };
    Ok(result.raw())
}

fn detach_scope(input: L<'_>) -> Result<L<'_>> {
    let effects = input.from_value(&V::Array(vec![]))?;
    let effect_push = effects.get(c"push")?;
    let ordered = input.from_value(&V::Array(vec![]))?;
    let ordered_push = ordered.get(c"push")?;
    let session_ids = input.global()?.get(c"Set")?.construct(&[])?;
    let has = session_ids.get(c"has")?;
    let add = session_ids.get(c"add")?;
    input.for_each(|reference| {
        let kind = reference.get(c"kind")?;
        if kind.is_string("default")? || kind.is_string("aux")? {
            let row = input.from_value(&V::Object(vec![]))?;
            row.set(c"kind", kind)?;
            if kind.is_string("default")? {
                row.set(c"cli", reference.get(c"cli")?)?;
            } else {
                row.set(c"protocol", reference.get(c"protocol")?)?;
            }
            effect_push.call(effects, &[row])?;
        } else {
            let session_id = reference.get(c"sessionId")?;
            if session_id.truthy()? && !has.call(session_ids, &[session_id])?.truthy()? {
                add.call(session_ids, &[session_id])?;
                ordered_push.call(ordered, &[session_id])?;
            }
        }
        Ok(())
    })?;
    let result = input.from_value(&V::Object(vec![]))?;
    result.set(c"effects", effects)?;
    result.set(c"sessionIds", ordered)?;
    Ok(result)
}

fn detach_session(input: L<'_>) -> Result<L<'_>> {
    let session = input.get(c"session")?;
    if !session.truthy()? {
        return input.from_value(&V::Null);
    }
    let mut shown = session.get(c"name")?;
    if !shown.truthy()? {
        shown = session.get(c"label")?;
    }
    if !shown.truthy()? {
        shown = input.get(c"sessionId")?;
    }
    let name = input.global()?.get(c"String")?.call_plain(&[shown])?;
    let (patch, fallback) = session_detach_plan(
        input,
        input.get(c"desiredSession")?,
        session,
        input.get(c"providerId")?,
    )?;
    let keys = input.global()?.get(c"Object")?.get(c"keys")?;
    if !keys.call_plain(&[patch])?.get(c"length")?.truthy()? {
        return input.from_value(&V::Null);
    }
    if fallback.truthy()? && patch.get(c"subagent")?.kind()? == sys::ValueType::napi_null {
        fallback.set(c"subagent", input.from_value(&V::Null)?)?;
    }
    let result = input.from_value(&V::Object(vec![]))?;
    result.set(c"sessionName", name)?;
    result.set(c"patch", patch)?;
    result.set(c"fallback", fallback)?;
    Ok(result)
}

fn detach_response(input: L<'_>) -> Result<L<'_>> {
    let result = input.get(c"result")?;
    let status = result.get(c"status")?;
    let fallback = input.get(c"fallback")?;
    let succeeded = status.is_number(200.0)?;
    let response = input.from_value(&V::Object(vec![]))?;
    if !succeeded && fallback.truthy()? {
        response.set(c"retry", fallback)?;
        return Ok(response);
    }
    let body = result.get(c"body")?;
    let row = input.from_value(&V::Object(vec![]))?;
    row.set(c"kind", input.from_value(&V::string("session"))?)?;
    row.set(c"sessionId", input.get(c"sessionId")?)?;
    row.set(c"sessionName", input.get(c"sessionName")?)?;
    if succeeded {
        let deferred = body.truthy()? && body.get(c"deferred")?.truthy()?;
        row.set(c"deferred", input.from_value(&V::Bool(deferred))?)?;
        response.set(c"detached", row)?;
    } else {
        let string = input.global()?.get(c"String")?;
        let reported = if body.truthy()? && body.get(c"error")?.truthy()? {
            body.get(c"error")?
        } else {
            let status = string.call_plain(&[status])?;
            let text = format!(
                "HTTP {}",
                status
                    .string()?
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default(),
            );
            input.from_value(&V::string(&text))?
        };
        let text = string.call_plain(&[reported])?;
        let sliced = text.get(c"slice")?.call(
            text,
            &[
                input.from_value(&V::Number(0.0))?,
                input.from_value(&V::Number(
                    multicc_core::provider_registry::DETACH_ERROR_LIMIT,
                ))?,
            ],
        )?;
        row.set(c"error", sliced)?;
        response.set(c"failed", row)?;
    }
    Ok(response)
}
