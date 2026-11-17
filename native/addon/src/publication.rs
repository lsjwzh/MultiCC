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
