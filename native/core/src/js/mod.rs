//! JavaScript value semantics, once.
//!
//! Every Rust kernel that replaced a JS module has to reproduce what JS did to
//! ordinary values: `String()`, `Number()`, `trim()`, `JSON.stringify`,
//! `JSON.parse`, UTF-16 length/slicing and truthiness. This module is the only
//! implementation. [`JsValue`] models the value losslessly (lone surrogates,
//! `undefined`, `NaN`, `-0`, bytes, dates); [`serde`] keeps the older
//! `serde_json::Value` kernels working while they wait for the direct bridge.
//!
//! ECMAScript rules and explicitly tested Node Buffer compatibility live here. Engine-defined
//! behavior — `Date.parse` outside the ISO grammar, `localeCompare`, `Intl`,
//! `Date.prototype.toString` — stays in JS and is precomputed by the bridge.
//!
//! `native/addon/src/js_bridge.rs` moves values across napi without JSON, so a
//! lone surrogate, `-0` or a `Buffer` is not lost at the boundary.

pub mod coerce;
pub mod buffer;
pub mod json;
pub mod number;
pub mod serde;
pub mod string;
pub mod tags;
pub mod value;

pub use coerce::{
    js_to_number, js_to_string, less_equal_number, less_number, math_min, nullish, or, truthy,
    truthy_opt,
};
pub use buffer::node_base64_decode;
pub use json::{
    date_to_iso_string, json_parse, json_quote, json_quote_str, json_stringify,
    json_stringify_or_undefined, JsonParseError,
};
pub use number::{format_f64, js_string_to_number, number_to_string, string_to_number};
pub use string::{
    compare_units, is_js_whitespace, is_js_whitespace_char, js_trim, utf16_len, utf16_prefix,
    utf16_prefix_units, utf16_suffix, utf16_truncate, JsString,
};
pub use value::JsValue;

pub use serde::{from_serde, to_serde};

#[cfg(test)]
mod tests;
