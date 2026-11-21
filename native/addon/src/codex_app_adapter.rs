//! Codex app-server event state. Rust owns every lookup and transition;
//! opaque JS values live in a closure-held array so cycles remain collectable.
use crate::{codex_adapter::*, js_live::LiveValue as L};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::cell::RefCell;
mod events;
mod invocation;
const DELTA: usize = 0;
const REASONING: usize = 1;
const USAGE: usize = 2;
const ACTIVE: usize = 3;

#[derive(Default)]
struct State {
    tables: [Vec<u32>; 4],
    free: Vec<u32>,
    next: u32,
}
#[napi]
#[derive(Default)]
pub struct RustCodexAppAdapter {
    state: RefCell<State>,
}
impl RustCodexAppAdapter {
    fn find(&self, table: usize, key: L<'_>, storage: L<'_>) -> Result<Option<(usize, u32)>> {
        let slots = self.state.borrow().tables[table].clone();
        for (position, slot) in slots.into_iter().enumerate() {
            let held = storage.element(slot)?.get(c"key")?;
            if held.equals(key)?
                || (held.number_value()?.is_some_and(f64::is_nan)
                    && key.number_value()?.is_some_and(f64::is_nan))
            {
                return Ok(Some((position, slot)));
            }
        }
        Ok(None)
    }
    fn get<'a>(&self, table: usize, key: L<'a>, storage: L<'a>) -> Result<L<'a>> {
        match self.find(table, key, storage)? {
            Some((_, slot)) => storage.element(slot)?.get(c"value"),
            None => key.from_value(&V::Undefined),
        }
    }
    fn put(&self, table: usize, key: L<'_>, value: L<'_>, storage: L<'_>) -> Result<()> {
        let slot = if let Some((_, slot)) = self.find(table, key, storage)? {
            slot
        } else {
            let mut state = self.state.borrow_mut();
            let slot = if let Some(slot) = state.free.pop() {
                slot
            } else {
                let slot = state.next;
                state.next = state
                    .next
                    .checked_add(1)
                    .ok_or_else(|| napi::Error::from_reason("codex_adapter_capacity"))?;
                slot
            };
            state.tables[table].push(slot);
            slot
        };
        storage.set_element(slot, object(key, &[(c"key", key), (c"value", value)])?)
    }
    fn remove(&self, table: usize, key: L<'_>, storage: L<'_>) -> Result<bool> {
        let Some((_, slot)) = self.find(table, key, storage)? else {
            return Ok(false);
        };
        {
            let mut state = self.state.borrow_mut();
            if let Some(position) = state.tables[table].iter().position(|entry| *entry == slot) {
                state.tables[table].swap_remove(position);
                state.free.push(slot);
            }
        }
        storage.set_element(slot, key.from_value(&V::Undefined)?)?;
        Ok(true)
    }
}
pub(super) fn reconnect(value: L<'_>) -> Result<bool> {
    matches(
        string(or(value, || text(value, ""))?)?.clean_text()?,
        r"^Reconnecting\.\.\.\s*\d+/\d+(?:\s*\([^\r\n]*\))?\s*$",
        "i",
    )
}
pub(super) fn app_usage(source: L<'_>) -> Result<L<'_>> {
    let value = or(source.optional(c"last")?, || {
        or(source.optional(c"total")?, || {
            or(source, || object(source, &[]))
        })
    })?;
    let out = object(source, &[])?;
    for (key, field) in [
        (c"input_tokens", c"inputTokens"),
        (c"cached_input_tokens", c"cachedInputTokens"),
        (c"cache_creation_input_tokens", c"cacheWriteInputTokens"),
        (c"output_tokens", c"outputTokens"),
        (c"reasoning_output_tokens", c"reasoningOutputTokens"),
    ] {
        let number =
            property(value, field, || source.from_value(&V::Number(0.0)))?.explicit_number()?;
        out.set(key, source.from_value(&V::Number(number))?)?;
    }
    if !source.optional(c"modelContextWindow")?.nullish()? {
        out.set(c"model_context_window", source.get(c"modelContextWindow")?)?;
    }
    usage(out)
}
pub(super) fn add_usage<'a>(current: L<'a>, next: L<'a>) -> Result<L<'a>> {
    let out = object(current, &[])?;
    for key in [
        c"input_tokens",
        c"cached_input_tokens",
        c"cache_read_input_tokens",
        c"cache_creation_input_tokens",
        c"output_tokens",
        c"reasoning_output_tokens",
    ] {
        let a =
            property(current, key, || current.from_value(&V::Number(0.0)))?.explicit_number()?;
        let b = property(next, key, || current.from_value(&V::Number(0.0)))?.explicit_number()?;
        out.set(key, current.from_value(&V::Number(a + b))?)?;
    }
    let window = next.get(c"model_context_window")?;
    let window = if window.nullish()? {
        current.get(c"model_context_window")?
    } else {
        window
    };
    if !window.nullish()? {
        out.set(c"model_context_window", window)?;
    }
    Ok(out)
}

#[napi]
pub fn codex_app_adapter_ports(
    env: Env,
    deps: Unknown<'_>,
    default_bridge: String,
    executable: String,
    custom_executable: String,
) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    let bridge = deps.get(c"bridge")?;
    let executable = if bridge.truthy()? {
        custom_executable
    } else {
        executable
    };
    Ok(object(
        deps,
        &[
            (c"deps", deps),
            (c"bridge", or(bridge, || text(deps, &default_bridge))?),
            (c"executable", text(deps, &executable)?),
            (c"storage", array(deps)?),
        ],
    )?
    .raw())
}
#[napi]
pub fn codex_app_adapter_value(
    env: Env,
    op: String,
    input: Unknown<'_>,
    next: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    let next = L::new(&env, next);
    let value = match op.as_str() {
        "usage" => app_usage(input)?,
        "add" => add_usage(input, next)?,
        "reconnect" => boolean(input, reconnect(input)?)?,
        "question" => events::question(input)?,
        "terminal" => concat(
            input,
            &[
                property(input, c"codexCmd", || text(input, "codex"))?,
                text(input, " --help")?,
            ],
        )?,
        _ => {
            return Err(napi::Error::from_reason(
                "unknown_codex_app_adapter_operation",
            ))
        }
    };
    Ok(value.raw())
}
#[napi]
impl RustCodexAppAdapter {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    #[napi]
    pub fn invocation(
        &self,
        env: Env,
        input: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        Ok(invocation::build(L::new(&env, input), L::new(&env, ports))?.raw())
    }
    #[napi]
    pub fn decode(
        &self,
        env: Env,
        event: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        Ok(events::decode(self, L::new(&env, event), L::new(&env, ports))?.raw())
    }
}
