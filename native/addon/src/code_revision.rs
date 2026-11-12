use multicc_core::code_revision::{
    observe_files, observe_revision, FileDigest, RevisionObservation, DEFAULT_MAX_BYTES,
    DEFAULT_MAX_FILES,
};
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::path::Path;

#[napi]
pub struct RustCodeRevisionDigest {
    inner: FileDigest,
}

#[napi]
impl RustCodeRevisionDigest {
    #[napi]
    pub fn finish(&self, gitlinks: String) -> String {
        self.inner.finish(&gitlinks)
    }
}

pub struct FileObservation {
    cwd: String,
    files: Vec<String>,
    modes: Vec<String>,
    honor_file_mode: bool,
    max_bytes: u32,
}

impl Task for FileObservation {
    type Output = FileDigest;
    type JsValue = RustCodeRevisionDigest;
    fn compute(&mut self) -> Result<FileDigest> {
        observe_files(
            Path::new(&self.cwd),
            &self.files,
            &self.modes,
            self.honor_file_mode,
            self.max_bytes.into(),
        )
        .map_err(napi::Error::from_reason)
    }
    fn resolve(&mut self, _: Env, inner: FileDigest) -> Result<Self::JsValue> {
        Ok(RustCodeRevisionDigest { inner })
    }
}

#[napi]
pub fn observe_code_files(
    cwd: String,
    files: Vec<String>,
    modes: Vec<String>,
    honor_file_mode: bool,
    max_bytes: u32,
) -> AsyncTask<FileObservation> {
    AsyncTask::new(FileObservation {
        cwd,
        files,
        modes,
        honor_file_mode,
        max_bytes,
    })
}

// The stopped-writer capture: git orchestration, index parsing and file
// hashing as a single worker job, so a release never queues subprocesses on
// the host event loop.
#[napi(object)]
pub struct CodeRevisionObservation {
    #[napi(js_name = "repoId")]
    pub repo_id: String,
    pub head: String,
    pub revision: String,
    pub dirty: bool,
}

pub struct WholeRevisionObservation {
    cwd: String,
}

impl Task for WholeRevisionObservation {
    type Output = RevisionObservation;
    type JsValue = CodeRevisionObservation;
    fn compute(&mut self) -> Result<RevisionObservation> {
        observe_revision(
            Path::new(&self.cwd),
            DEFAULT_MAX_BYTES,
            DEFAULT_MAX_FILES,
            0,
        )
        .map_err(napi::Error::from_reason)
    }
    fn resolve(&mut self, _: Env, observation: RevisionObservation) -> Result<Self::JsValue> {
        Ok(CodeRevisionObservation {
            repo_id: observation.repo_id,
            head: observation.head,
            revision: observation.revision,
            dirty: observation.dirty,
        })
    }
}

#[napi]
pub fn observe_code_revision(cwd: String) -> AsyncTask<WholeRevisionObservation> {
    AsyncTask::new(WholeRevisionObservation { cwd })
}
