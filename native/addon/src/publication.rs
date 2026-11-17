use multicc_core::publication;
use multicc_core::publication_identity;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::path::Path;

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

pub struct GitPublication {
    cwd: String,
    args: Vec<String>,
    log: Option<String>,
    range: Option<String>,
}

impl Task for GitPublication {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let cwd = Path::new(&self.cwd);
        if let Some(range) = &self.range {
            let policy =
                publication_identity::repository_policy(cwd).map_err(napi::Error::from_reason)?;
            let checked = publication_identity::validate_range(cwd, range, policy.as_ref())
                .map_err(napi::Error::from_reason)?;
            return Ok(checked.0.to_string());
        }
        if let Some(log) = &self.log {
            let policy =
                publication_identity::repository_policy(cwd).map_err(napi::Error::from_reason)?;
            let checked = publication_identity::validate_records(log, policy.as_ref())
                .map_err(napi::Error::from_reason)?;
            return Ok(checked.to_string());
        }
        let env = publication_identity::command_environment(cwd, &self.args)
            .map_err(napi::Error::from_reason)?;
        serde_json::to_string(&env).map_err(|_| napi::Error::from_reason("无法序列化提交身份"))
    }

    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[napi]
pub fn git_commit_environment(cwd: String, args: Vec<String>) -> AsyncTask<GitPublication> {
    AsyncTask::new(GitPublication {
        cwd,
        args,
        log: None,
        range: None,
    })
}

#[napi]
pub fn validate_publication_records(cwd: String, log: String) -> AsyncTask<GitPublication> {
    AsyncTask::new(GitPublication {
        cwd,
        args: Vec::new(),
        log: Some(log),
        range: None,
    })
}

#[napi]
pub fn validate_publication_range(cwd: String, range: String) -> AsyncTask<GitPublication> {
    AsyncTask::new(GitPublication {
        cwd,
        args: Vec::new(),
        log: None,
        range: Some(range),
    })
}
