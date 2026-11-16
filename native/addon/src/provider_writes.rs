//! Node transport for the provider store's write decisions.
//!
//! One call per write: the host hands over the current record list plus the
//! facts it had to resolve (official-catalog verdicts, the virtual-line plan, a
//! fresh uuid, `Date.now()`), and gets back the commit the decision reached.
//! The host's only remaining job is to perform that commit -- persist the list,
//! answer, or hand off to the official catalog.
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;
use serde_json::{json, Map, Value};

use multicc_core::provider_writes as rules;
use multicc_core::provider_writes::Commit;

fn read(env: Env, input: Unknown<'_>) -> Result<Value> {
    let value =
        unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
    Ok(multicc_core::js::serde::to_serde(&value))
}

fn object_of(input: &Value, name: &str) -> Map<String, Value> {
    match input.get(name) {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn string_of(input: &Value, name: &str) -> String {
    input
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn bool_of(input: &Value, name: &str) -> bool {
    input.get(name).and_then(Value::as_bool).unwrap_or(false)
}

fn facts_of(input: &Value) -> rules::WriteFacts {
    let facts = input.get("facts").cloned().unwrap_or(Value::Null);
    rules::WriteFacts {
        official_catalog_mounted: bool_of(&facts, "officialCatalogMounted"),
        id_is_official: bool_of(&facts, "idIsOfficial"),
        normalized_id_is_official: bool_of(&facts, "normalizedIdIsOfficial"),
        normalized_id: facts
            .get("normalizedId")
            .and_then(Value::as_str)
            .map(str::to_string),
        assembled_is_official: bool_of(&facts, "assembledIsOfficial"),
        new_id: string_of(&facts, "newId"),
        now_ms: facts
            .get("nowMs")
            .and_then(Value::as_f64)
            .unwrap_or_default(),
        port: match facts.get("port") {
            Some(Value::String(text)) => text.clone(),
            Some(value @ Value::Number(_)) => multicc_core::js::serde::js_string(value),
            _ => "3000".to_string(),
        },
        // A JSON `null` means "not resolved yet", exactly like an absent key:
        // `Some(Null)` would pass for a resolved-but-empty plan and persist a
        // virtual line with no members.
        virtual_plan: facts
            .get("virtualPlan")
            .filter(|plan| !plan.is_null())
            .cloned(),
    }
}

/// The commit, as the JSON envelope the Node host switches on. An `Err` becomes
/// `{ error }` so the host can throw with its own `Error` identity and stack.
fn envelope(commit: std::result::Result<Commit, String>) -> Value {
    match commit {
        Err(error) => json!({ "kind": "error", "error": error }),
        Ok(Commit::Save { records, result }) => {
            json!({ "kind": "save", "records": records, "result": result })
        }
        Ok(Commit::Answer { result }) => json!({ "kind": "answer", "result": result }),
        Ok(Commit::NeedsVirtualPlan) => json!({ "kind": "needsVirtualPlan" }),
        Ok(Commit::OfficialCatalogEntry { app_type }) => {
            json!({ "kind": "officialCatalogEntry", "appType": app_type })
        }
        Ok(Commit::OfficialDelete {
            app_type,
            id,
            records,
            records_changed,
        }) => json!({
            "kind": "officialDelete",
            "appType": app_type,
            "id": id,
            "records": records,
            "recordsChanged": records_changed,
        }),
    }
}

fn write(env: Env, value: Value) -> Result<sys::napi_value> {
    let value = multicc_core::js::serde::from_serde(&value);
    unsafe { crate::js_bridge::write_value(env.raw(), &value) }
}

/// `createProvider`.
#[napi]
pub fn provider_create(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = read(env, input)?;
    let records = input.get("records").cloned().unwrap_or(Value::Null);
    let commit = rules::create_provider(&records, &object_of(&input, "input"), &facts_of(&input));
    write(env, envelope(commit))
}

/// `updateProvider`.
#[napi]
pub fn provider_update(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = read(env, input)?;
    let records = input.get("records").cloned().unwrap_or(Value::Null);
    let commit = rules::update_provider(
        &records,
        &string_of(&input, "appType"),
        &string_of(&input, "id"),
        &object_of(&input, "input"),
        input.get("existingVirtual").filter(|v| !v.is_null()),
        &facts_of(&input),
    );
    write(env, envelope(commit))
}

/// `deleteProvider`.
#[napi]
pub fn provider_delete(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = read(env, input)?;
    let records = input.get("records").cloned().unwrap_or(Value::Null);
    let commit = rules::delete_provider(
        &records,
        &string_of(&input, "appType"),
        &string_of(&input, "id"),
        &facts_of(&input),
    );
    write(env, envelope(commit))
}

/// The record `createProvider` would assemble, so the host can answer
/// `official-catalog.isOfficial(record)` before the decision consumes it.
/// `{ kind: 'record', record }`, `{ kind: 'virtual' }` or `{ kind: 'error' }`.
#[napi]
pub fn provider_create_record(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = read(env, input)?;
    let value = match rules::assemble_create_record(&object_of(&input, "input"), &facts_of(&input))
    {
        Err(error) => json!({ "kind": "error", "error": error }),
        Ok(None) => json!({ "kind": "virtual" }),
        Ok(Some(record)) => json!({ "kind": "record", "record": record }),
    };
    write(env, value)
}
