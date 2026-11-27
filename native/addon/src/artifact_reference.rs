//! Artifact references over a live host value: the former
//! `src/artifact-reference.js`, frozen in
//! `tests/helpers/legacy-artifact-reference.js`. The rules live in
//! `multicc_core::artifact_reference`; this file only walks the value, and it
//! walks it through the engine in the frozen module's exact order, because
//! getters and Proxy traps observe every read: `artifactId` twice, an array
//! `artifactIds` twice, and `Object.values` before any child is entered.
use std::ffi::CStr;

use multicc_core::{
    artifact_reference as core,
    js::{JsString, JsValue},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

use crate::js_iteration::IteratorRecord;
use crate::js_live::LiveValue as L;

/// Hand a plain value back to JS.
fn write(env: &Env, value: &JsValue) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), value) }
}

/// `isArtifactId(value)`.
#[napi]
pub fn artifact_reference_is_artifact_id(env: Env, value: Unknown<'_>) -> Result<bool> {
    let value = L::new(&env, value);
    Ok(value
        .string()?
        .is_some_and(|text| core::is_artifact_id(&text.to_string_lossy())))
}

/// `normalizeRelativePath(value)`: the normalized path, or `null`.
#[napi]
pub fn artifact_reference_normalize_relative_path(
    env: Env,
    value: Unknown<'_>,
) -> Result<sys::napi_value> {
    let value = L::new(&env, value);
    let normalized = value
        .string()?
        .and_then(|text| core::normalize_relative_path(&text));
    let out = match normalized {
        Some(text) => JsValue::String(text),
        None => JsValue::Null,
    };
    write(&env, &out)
}

/// `extractArtifactReferences(content)`.
#[napi]
pub fn artifact_reference_extract(env: Env, content: Unknown<'_>) -> Result<sys::napi_value> {
    let host = L::new(&env, content);
    let global = host.global()?;
    // The engine's own WeakSet keeps identity (cycles, shared objects) and
    // its own rules about what may be held weakly.
    let visited = global.get(c"WeakSet")?.construct(&[])?;
    let mut walk = Walk {
        collector: core::Collector::default(),
        visited,
        global,
        nodes: 0,
    };
    walk.visit(host, 0)?;
    let items = walk
        .collector
        .finish()
        .into_iter()
        .map(|reference| {
            JsValue::object(vec![
                ("artifactId", JsValue::string(&reference.artifact_id)),
                ("relativePath", JsValue::string(&reference.relative_path)),
            ])
        })
        .collect();
    write(&env, &JsValue::Array(items))
}

/// State of one `extractArtifactReferences` call.
struct Walk<'env> {
    collector: core::Collector,
    visited: L<'env>,
    global: L<'env>,
    nodes: usize,
}

impl<'env> Walk<'env> {
    /// `visit(value, depth)`.
    fn visit(&mut self, value: L<'env>, depth: usize) -> Result<()> {
        self.nodes += 1;
        if self.nodes > core::MAX_NODES || depth > core::MAX_DEPTH || self.collector.is_full() {
            return Ok(());
        }
        let kind = value.kind()?;
        if kind == sys::ValueType::napi_string {
            let text = value.string()?.expect("typeof string");
            for reference in core::references_in_text(&text.to_string_lossy()) {
                self.collector
                    .push(&reference.artifact_id, &reference.relative_path);
            }
            return Ok(());
        }
        // `!value || typeof value !== 'object'`: null, functions and the other
        // primitives are never entered. An addon's External is an object to JS.
        if !matches!(
            kind,
            sys::ValueType::napi_object | sys::ValueType::napi_external
        ) {
            return Ok(());
        }
        if self
            .visited
            .get(c"has")?
            .call(self.visited, &[value])?
            .truthy()?
        {
            return Ok(());
        }
        self.visited.get(c"add")?.call(self.visited, &[value])?;
        if value.is_array()? {
            return self
                .iterator(value, c"value is not iterable")?
                .for_each(|item| self.visit(item, depth + 1));
        }
        if self.owns(value, c"artifactId")?
            && value
                .get(c"artifactId")?
                .string()?
                .is_some_and(|text| core::is_artifact_id(&text.to_string_lossy()))
        {
            let relative_path = if self.owns(value, c"relativePath")? {
                value
                    .get(c"relativePath")?
                    .string()?
                    .and_then(|text| core::normalize_relative_path(&text))
            } else {
                Some(JsString::new())
            };
            if let Some(relative_path) = relative_path {
                // `add(value.artifactId, relativePath)` reads the id again.
                self.add(value.get(c"artifactId")?, &relative_path)?;
            }
        }
        let array = self.global.get(c"Array")?;
        if array
            .get(c"isArray")?
            .call(array, &[value.get(c"artifactIds")?])?
            .truthy()?
        {
            let empty = JsString::new();
            // for-of reads the property a second time.
            self.iterator(
                value.get(c"artifactIds")?,
                c"value.artifactIds is not iterable",
            )?
            .for_each(|artifact_id| self.add(artifact_id, &empty))?;
        }
        let object = self.global.get(c"Object")?;
        let children = object.get(c"values")?.call(object, &[value])?;
        self.iterator(
            children,
            c"Object.values is not a function or its return value is not iterable",
        )?
        .for_each(|child| self.visit(child, depth + 1))
    }

    fn iterator(&self, value: L<'env>, site: &CStr) -> Result<IteratorRecord<'env>> {
        IteratorRecord::open(value, site, || self.global.get(c"Symbol")?.get(c"iterator"))
    }

    /// `Object.prototype.hasOwnProperty.call(value, key)`.
    fn owns(&self, value: L<'env>, key: &CStr) -> Result<bool> {
        let key = value.from_value(&JsValue::string(key.to_str().expect("static property")))?;
        let has_own = self
            .global
            .get(c"Object")?
            .get(c"prototype")?
            .get(c"hasOwnProperty")?;
        has_own.get(c"call")?.call(has_own, &[value, key])?.truthy()
    }

    /// `add(artifactId, relativePath)`: a non-string id is dropped before any
    /// conversion, as `isArtifactId` does.
    fn add(&mut self, artifact_id: L<'env>, relative_path: &JsString) -> Result<()> {
        if let Some(text) = artifact_id.string()? {
            self.collector.add(&text.to_string_lossy(), relative_path);
        }
        Ok(())
    }
}

#[napi]
pub fn artifact_id_from_registry_url(url: Option<String>) -> Option<String> {
    multicc_core::docs_memory_routes::artifact_id_from_url(url.as_deref())
}

#[napi]
pub fn retained_artifact_ids(entries: String, roots: Vec<String>) -> napi::Result<Vec<String>> {
    let entries = serde_json::from_str::<Vec<serde_json::Value>>(&entries)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let roots = roots
        .into_iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    multicc_core::artifact_retention::retained(&entries, &roots)
        .map(|ids| ids.into_iter().collect())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub async fn retained_artifact_ids_async(
    entries: String,
    roots: Vec<String>,
) -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(move || retained_artifact_ids(entries, roots))
        .await
        .map_err(|e| napi::Error::from_reason(e.to_string()))?
}
