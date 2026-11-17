use multicc_core::publication;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;

pub struct PublicationText {
    kind: String,
    text: String,
}

impl Task for PublicationText {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        if self.kind == "quick-commit" {
            return Ok(publication::quick_commit_message(&self.text));
        }
        publication::validate_english(&self.kind, &self.text).map_err(napi::Error::from_reason)?;
        Ok(String::new())
    }

    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[napi]
pub fn validate_publication_text(kind: String, text: String) -> AsyncTask<PublicationText> {
    AsyncTask::new(PublicationText { kind, text })
}

#[napi]
pub fn quick_commit_message(porcelain: String) -> AsyncTask<PublicationText> {
    AsyncTask::new(PublicationText {
        kind: "quick-commit".into(),
        text: porcelain,
    })
}
