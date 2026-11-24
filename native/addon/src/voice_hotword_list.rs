//! Classify learned words in encounter order. Keep live V8 handles so a
//! pending or vetoed word is the same object supplied by the learner.
use crate::js_live::LiveValue;
use multicc_core::{js::JsValue, voice_hotword_list::word_character};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

/// V8 locates occurrences in its UTF-16 strings and supplies the two live
/// property reads. A substring hit inside an ASCII word may have a later,
/// standalone occurrence in the same text.
#[napi]
pub fn voice_hotword_match(
    env: Env,
    mut at: f64,
    ascii: bool,
    edges: Unknown<'_>,
    next: Unknown<'_>,
) -> Result<bool> {
    let edges = LiveValue::new(&env, edges);
    let next = LiveValue::new(&env, next);
    while at >= 0.0 {
        let index = edges.from_value(&JsValue::Number(at))?;
        let sides = edges.call_plain(&[index])?;
        if !ascii
            || (!word_character(sides.element(0)?.coerce_string()?.as_units())
                && !word_character(sides.element(1)?.coerce_string()?.as_units()))
        {
            return Ok(true);
        }
        at = next
            .call_plain(&[edges.from_value(&JsValue::Number(at + 1.0))?])?
            .number()?;
    }
    Ok(false)
}

fn method<'a>(object: LiveValue<'a>, name: &CStr, args: &[LiveValue<'a>]) -> Result<LiveValue<'a>> {
    object.get(name)?.call(object, args)
}

#[napi]
pub fn voice_hotword_list(
    env: Env,
    pairs: Unknown<'_>,
    typed: Unknown<'_>,
    rejected: Unknown<'_>,
    texts: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let pairs = LiveValue::new(&env, pairs);
    let rejected = LiveValue::new(&env, rejected);
    let texts = LiveValue::new(&env, texts);
    let ports = LiveValue::new(&env, ports);
    let active = pairs.global()?.get(c"Map")?.construct(&[])?;
    let pending = pairs.from_value(&JsValue::Array(vec![]))?;
    let vetoed = pairs.from_value(&JsValue::Array(vec![]))?;
    let add = |term, alias: Option<LiveValue>| -> Result<()> {
        let key = method(ports, c"lower", &[term])?;
        let mut entry = method(active, c"get", &[key])?;
        if entry.undefined()? {
            entry = pairs.from_value(&JsValue::Object(vec![]))?;
            entry.set(c"term", term)?;
            entry.set(c"aliases", pairs.from_value(&JsValue::Array(vec![]))?)?;
            method(active, c"set", &[key, entry])?;
        }
        if let Some(alias) = alias {
            let aliases = entry.get(c"aliases")?;
            if alias.truthy()? && !method(aliases, c"includes", &[alias])?.truthy()? {
                method(aliases, c"push", &[alias])?;
            }
        }
        Ok(())
    };
    pairs.for_each(|entry| {
        let (key, pair) = entry.iterator_pair()?;
        if method(rejected, c"has", &[key])?.truthy()? {
            return Ok(());
        }
        if !method(ports, c"alias", &[pair])?.truthy()? {
            add(method(ports, c"term", &[pair])?, None)?;
        } else if method(
            ports,
            c"vetoedBy",
            &[method(ports, c"alias", &[pair])?, texts],
        )?
        .truthy()?
        {
            method(vetoed, c"push", &[pair])?;
        } else if method(ports, c"activates", &[pair.get(c"count")?])?.truthy()? {
            add(
                method(ports, c"term", &[pair])?,
                Some(method(ports, c"alias", &[pair])?),
            )?;
        } else {
            method(pending, c"push", &[pair])?;
        }
        Ok(())
    })?;
    LiveValue::new(&env, typed)
        .call_plain(&[])?
        .for_each(|typed| {
            let key = method(ports, c"typedKey", &[method(ports, c"term", &[typed])?])?;
            if !method(rejected, c"has", &[key])?.truthy()? {
                add(method(ports, c"term", &[typed])?, None)?;
            }
            Ok(())
        })?;
    let array = pairs.global()?.get(c"Array")?;
    let entries = method(array, c"from", &[method(active, c"values", &[])?])?;
    let result = pairs.from_value(&JsValue::Object(vec![]))?;
    result.set(c"active", entries)?;
    result.set(c"pending", pending)?;
    result.set(c"vetoed", vetoed)?;
    Ok(result.raw())
}
