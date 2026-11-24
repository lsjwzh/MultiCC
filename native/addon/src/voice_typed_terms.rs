use multicc_core::{js::JsValue, voice_typed_terms::Vocabulary};
use napi::{sys, Env, Result};
use napi_derive::napi;

#[napi]
#[derive(Default)]
pub struct VoiceTypedVocabulary {
    tally: Vocabulary,
}

#[napi]
impl VoiceTypedVocabulary {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn observe(&mut self, session: u32, prose: String) {
        self.tally.observe(session, &prose);
    }

    #[napi]
    pub fn spellings(&self) -> Vec<String> {
        self.tally.spellings().map(str::to_owned).collect()
    }

    #[napi]
    pub fn terms(&self, env: Env, flags: Vec<bool>) -> Result<sys::napi_value> {
        let terms = self.tally.terms(&flags).map_err(napi::Error::from_reason)?;
        let rows = terms
            .into_iter()
            .map(|t| {
                let sessions = t
                    .sessions
                    .iter()
                    .map(|id| JsValue::Number(f64::from(*id)))
                    .collect();
                let forms = t
                    .forms
                    .iter()
                    .map(|(name, count)| {
                        JsValue::Array(vec![JsValue::string(name), JsValue::Number(*count as f64)])
                    })
                    .collect();
                JsValue::object(vec![
                    ("key", JsValue::string(t.key)),
                    ("term", JsValue::string(t.spelling)),
                    ("count", JsValue::Number(t.count as f64)),
                    ("sessionIds", JsValue::Array(sessions)),
                    ("forms", JsValue::Array(forms)),
                ])
            })
            .collect();
        unsafe { crate::js_bridge::write_value(env.raw(), &JsValue::Array(rows)) }
    }
}
