use crate::js_live::LiveValue;
use multicc_core::{
    js::{JsString, JsValue},
    voice_hotword_pairs,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn voice_mine_hotword_pairs(
    env: Env,
    raw: Unknown<'_>,
    edited: Unknown<'_>,
    same_spelling: Unknown<'_>,
    sound_alike: Unknown<'_>,
) -> Result<sys::napi_value> {
    let host = LiveValue::new(&env, raw);
    let compare = |port: LiveValue, first: &JsString, second: &JsString| -> Result<bool> {
        port.call_plain(&[
            host.from_value(&JsValue::String(first.clone()))?,
            host.from_value(&JsValue::String(second.clone()))?,
        ])?
        .is_true()
    };
    let same_spelling = LiveValue::new(&env, same_spelling);
    let sound_alike = LiveValue::new(&env, sound_alike);
    let mut rows = Vec::new();
    if let (Some(raw), Some(edited)) = (host.string()?, LiveValue::new(&env, edited).string()?) {
        for pair in voice_hotword_pairs::mine_pairs(
            &raw,
            &edited,
            |a, b| compare(same_spelling, a, b),
            |a, b| compare(sound_alike, a, b),
        )? {
            let mut fields = vec![("term", JsValue::String(pair.term))];
            if let Some(alias) = pair.alias {
                fields.push(("alias", JsValue::String(alias)));
            }
            rows.push(JsValue::object(fields));
        }
    }
    Ok(host.from_value(&JsValue::Array(rows))?.raw())
}
