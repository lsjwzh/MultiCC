use multicc_core::{js::JsValue, voice_typed_terms::Vocabulary};
use napi::{sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn voice_rank_typed_hotwords(
    env: Env,
    user: &VoiceTypedVocabulary,
    user_flags: Vec<bool>,
    model: &VoiceTypedVocabulary,
    model_flags: Vec<bool>,
) -> Result<sys::napi_value> {
    let user_terms = user
        .tally
        .terms(&user_flags)
        .map_err(napi::Error::from_reason)?;
    let model_terms = model
        .tally
        .terms(&model_flags)
        .map_err(napi::Error::from_reason)?;
    let rows = multicc_core::voice_typed_terms::rank_scan_terms(user_terms, model_terms)
        .into_iter()
        .map(|t| {
            JsValue::object(vec![
                ("term", JsValue::string(t.term)),
                ("count", JsValue::Number(t.count as f64)),
                ("sessions", JsValue::Number(t.sessions as f64)),
                ("source", JsValue::string(t.source)),
            ])
        })
        .collect();
    unsafe { crate::js_bridge::write_value(env.raw(), &JsValue::Array(rows)) }
}

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
