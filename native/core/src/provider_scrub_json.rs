//! Rust-owned wire JSON adapter for the shared semantic walker. No N-API
//! properties are read or written here. Handles address an arena so key
//! renames, clone identity and write order use the same algorithm as live JS.
use crate::{
    exact_secret::Secrets,
    js::{
        json::{array_index, json_encode_wire},
        json_parse, JsString, JsValue,
    },
    provider_scrub::{scrub_semantic_structure, ScrubValue},
};
use std::cell::RefCell;

#[derive(Clone)]
enum Node {
    Leaf(JsValue),
    Array(Vec<usize>),
    Object(Vec<(JsString, usize)>),
}
#[derive(Default)]
struct Arena(RefCell<Vec<Node>>);
#[derive(Clone, Copy)]
struct Value<'a> {
    arena: &'a Arena,
    id: usize,
}

impl Arena {
    fn insert(&self, node: Node) -> Value<'_> {
        let mut nodes = self.0.borrow_mut();
        let id = nodes.len();
        nodes.push(node);
        Value { arena: self, id }
    }
    fn import(&self, value: JsValue) -> Value<'_> {
        let node = match value {
            JsValue::Array(items) => {
                Node::Array(items.into_iter().map(|v| self.import(v).id).collect())
            }
            JsValue::Object(items) => Node::Object(
                items
                    .into_iter()
                    .map(|(k, v)| (k, self.import(v).id))
                    .collect(),
            ),
            value => Node::Leaf(value),
        };
        self.insert(node)
    }
}
impl Value<'_> {
    fn node(self) -> Node {
        self.arena.0.borrow()[self.id].clone()
    }
    fn at(self, id: usize) -> Self {
        Self { id, ..self }
    }
    fn undefined(self) -> Self {
        self.arena.insert(Node::Leaf(JsValue::Undefined))
    }
    fn export(self) -> JsValue {
        match self.node() {
            Node::Leaf(v) => v,
            Node::Array(items) => {
                JsValue::Array(items.into_iter().map(|id| self.at(id).export()).collect())
            }
            Node::Object(_) => JsValue::Object(
                self.entries()
                    .expect("owned entries")
                    .into_iter()
                    .map(|(key, value)| (key, value.export()))
                    .collect(),
            ),
        }
    }
}
impl ScrubValue for Value<'_> {
    type Error = String;
    fn nullish(self) -> Result<bool, String> {
        Ok(matches!(
            &self.arena.0.borrow()[self.id],
            Node::Leaf(JsValue::Null | JsValue::Undefined)
        ))
    }
    fn string(self) -> Result<Option<JsString>, String> {
        Ok(match &self.arena.0.borrow()[self.id] {
            Node::Leaf(JsValue::String(s)) => Some(s.clone()),
            _ => None,
        })
    }
    fn equals(self, other: Self) -> Result<bool, String> {
        // Parsed wire JSON cannot contain NaN. Identical handles therefore
        // compare equal, including long strings, without reading their bytes.
        if self.id == other.id {
            return Ok(true);
        }
        Ok(
            match (
                &self.arena.0.borrow()[self.id],
                &self.arena.0.borrow()[other.id],
            ) {
                (Node::Leaf(a), Node::Leaf(b)) => a == b,
                _ => self.id == other.id,
            },
        )
    }
    fn too_deep(self) -> String {
        "Maximum call stack size exceeded".into()
    }
    fn object_like(self) -> Result<bool, String> {
        Ok(matches!(
            &self.arena.0.borrow()[self.id],
            Node::Array(_) | Node::Object(_)
        ))
    }
    fn is_string(self) -> Result<bool, String> {
        Ok(matches!(
            &self.arena.0.borrow()[self.id],
            Node::Leaf(JsValue::String(_))
        ))
    }
    fn is_array(self) -> Result<bool, String> {
        Ok(matches!(&self.arena.0.borrow()[self.id], Node::Array(_)))
    }
    fn array_length(self) -> Result<u32, String> {
        Ok(match &self.arena.0.borrow()[self.id] {
            Node::Array(v) => v.len() as u32,
            _ => 0,
        })
    }
    fn live_string(self, text: &JsString) -> Result<Self, String> {
        Ok(self.arena.insert(Node::Leaf(JsValue::String(text.clone()))))
    }
    fn new_array(self) -> Result<Self, String> {
        Ok(self.arena.insert(Node::Array(Vec::new())))
    }
    fn new_object(self) -> Result<Self, String> {
        Ok(self.arena.insert(Node::Object(Vec::new())))
    }
    fn get_property(self, name: &JsString) -> Result<Self, String> {
        let id = match &self.arena.0.borrow()[self.id] {
            Node::Object(items) => items.iter().find(|(k, _)| k == name).map(|(_, id)| *id),
            Node::Array(items) => array_index(name)
                .and_then(|i| items.get(i as usize))
                .copied(),
            _ => None,
        };
        Ok(id.map(|id| self.at(id)).unwrap_or_else(|| self.undefined()))
    }
    fn get_element(self, index: u32) -> Result<Self, String> {
        self.get_property(&JsString::from_rust_str(&index.to_string()))
    }
    fn set_property(self, name: &JsString, value: Self) -> Result<(), String> {
        self.define_value(name, value)
    }
    fn set_element(self, index: u32, value: Self) -> Result<(), String> {
        self.define_value(&JsString::from_rust_str(&index.to_string()), value)
    }
    fn has_own(self, name: &JsString) -> Result<bool, String> {
        Ok(match &self.arena.0.borrow()[self.id] {
            Node::Object(items) => items.iter().any(|(k, _)| k == name),
            Node::Array(items) => array_index(name).is_some_and(|i| (i as usize) < items.len()),
            _ => false,
        })
    }
    fn delete_property(self, name: &JsString) -> Result<(), String> {
        if let Node::Object(items) = &mut self.arena.0.borrow_mut()[self.id] {
            items.retain(|(k, _)| k != name);
        }
        Ok(())
    }
    fn define_value(self, name: &JsString, value: Self) -> Result<(), String> {
        let mut nodes = self.arena.0.borrow_mut();
        match &mut nodes[self.id] {
            Node::Object(items) => {
                if let Some((_, id)) = items.iter_mut().find(|(k, _)| k == name) {
                    *id = value.id;
                } else {
                    items.push((name.clone(), value.id));
                }
            }
            Node::Array(items) => {
                let index =
                    array_index(name).ok_or("non-index array property in wire JSON")? as usize;
                if index > items.len() {
                    return Err("sparse array in wire JSON".into());
                }
                if index == items.len() {
                    items.push(value.id);
                } else {
                    items[index] = value.id;
                }
            }
            _ => return Err("cannot write a primitive".into()),
        }
        Ok(())
    }
    fn entries(self) -> Result<Vec<(JsString, Self)>, String> {
        let mut entries = match self.node() {
            Node::Array(items) => {
                return Ok(items
                    .into_iter()
                    .enumerate()
                    .map(|(i, id)| (JsString::from_rust_str(&i.to_string()), self.at(id)))
                    .collect())
            }
            Node::Object(items) => items,
            _ => Vec::new(),
        };
        // Stable sort: numeric keys first; other keys keep insertion order.
        entries.sort_by_key(|(key, _)| array_index(key).map(u64::from).unwrap_or(u64::MAX));
        Ok(entries
            .into_iter()
            .map(|(key, id)| (key, self.at(id)))
            .collect())
    }
}

/// Input is original wire JSON, never JSON.stringify of a live host object.
/// Preserve the original bytes on a no-op, and JS numeric/UTF-16 semantics
/// when a string edit requires re-encoding.
pub fn scrub_json(text: &str, secrets: &Secrets) -> Result<String, String> {
    let value = json_parse(text).map_err(|error| error.to_string())?;
    let arena = Arena::default();
    let original = arena.import(value);
    let safe = scrub_semantic_structure(original, secrets)?;
    if safe.equals(original)? {
        return Ok(text.to_string());
    }
    json_encode_wire(&safe.export()).ok_or_else(|| "wire JSON became undefined".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exact_secret::normalize_secrets;

    #[test]
    fn split_fields_and_keys_use_the_same_three_passes() {
        let secrets = normalize_secrets(["secret".into()]);
        let source =
            r#"{"type":"tool_start","input":{"sec":"interposed","ret":1,"values":["se","cret"]}}"#;
        let actual = scrub_json(source, &secrets).unwrap();
        assert_eq!(
            actual,
            r#"{"type":"tool_start","input":{"values":["[REDACTED_PROVIDER_ROUTE]","[REDACTED_PROVIDER_ROUTE]"],"[REDACTED_PROVIDER_ROUTE]":"interposed","[REDACTED_PROVIDER_ROUTE]#2":1}}"#
        );
    }

    #[test]
    fn reencoding_edits_strings_without_changing_wire_numbers() {
        let source = r#"{"type":"tool_start","input":"secret","negative":-0,"overflow":1e400,"lone":"\ud800"}"#;
        let actual = scrub_json(source, &normalize_secrets(["secret".into()])).unwrap();
        let parsed = json_parse(&actual).unwrap();
        assert_eq!(
            parsed.get("input"),
            Some(&JsValue::string("[REDACTED_PROVIDER_ROUTE]"))
        );
        let Some(JsValue::Number(negative)) = parsed.get("negative") else {
            panic!("number")
        };
        assert!(negative.is_sign_negative());
        assert_eq!(
            parsed.get("overflow"),
            Some(&JsValue::Number(f64::INFINITY))
        );
        assert_eq!(
            parsed.get("lone"),
            Some(&JsValue::String(JsString::from_units(vec![0xd800])))
        );
        // JSON.stringify still has its own, different contract.
        assert_eq!(
            crate::js::json_stringify(&JsValue::Number(-0.0)),
            Some("0".into())
        );
        assert_eq!(
            crate::js::json_stringify(&JsValue::Number(f64::INFINITY)),
            Some("null".into())
        );
    }

    #[test]
    fn unchanged_wire_text_is_returned_verbatim() {
        let source = " {\"type\":\"assistant\", \"message\":{\"content\":\"hello\"}, \"n\":1.0 }\n";
        assert_eq!(scrub_json(source, &Secrets::default()).unwrap(), source);
        assert!(scrub_json("{", &Secrets::default()).is_err());
    }
}
