use multicc_core::publication;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;

pub struct PublicationText {
    text: String,
}

impl Task for PublicationText {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        Ok(publication::quick_commit_message(&self.text))
    }

    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[napi]
pub fn quick_commit_message(porcelain: String) -> AsyncTask<PublicationText> {
    AsyncTask::new(PublicationText { text: porcelain })
}

/// Coerce on the host thread (String accepts Symbols); the existing worker
/// produces the Git message without blocking that thread.
#[napi]
pub fn quick_commit_message_value(
    env: Env,
    raw: napi::bindgen_prelude::Unknown<'_>,
) -> Result<AsyncTask<PublicationText>> {
    use crate::js_live::LiveValue;
    let value = LiveValue::new(&env, raw);
    let text = if value.truthy()? {
        value
            .global()?
            .get(c"String")?
            .call_plain(&[value])?
            .coerce_string()?
            .to_string_lossy()
    } else {
        String::new()
    };
    Ok(quick_commit_message(text))
}
