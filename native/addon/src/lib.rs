use multicc_core::{search::SearchIndex, usage};
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::{sync::Arc, time::Instant};
pub mod cpr;
pub mod publication;
pub mod quota_history;
pub mod remote_screen;
pub mod sqlite;
pub mod subagent_defaults;
pub mod task_context;
pub mod task_read_model;

#[napi(object)]
pub struct NativeResult {
    pub result: String,
    pub compute_ms: f64,
}

fn error(message: String) -> napi::Error {
    napi::Error::from_reason(message)
}

#[napi]
pub fn protocol_version() -> u32 {
    1
}

#[napi]
pub struct RustSearchIndex {
    inner: Arc<SearchIndex>,
    build_ms: f64,
}

pub struct Build {
    input: String,
}
impl Task for Build {
    type Output = (SearchIndex, f64);
    type JsValue = RustSearchIndex;
    fn compute(&mut self) -> Result<Self::Output> {
        let start = Instant::now();
        let index = SearchIndex::build(&self.input).map_err(error)?;
        Ok((index, start.elapsed().as_secs_f64() * 1000.0))
    }
    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(RustSearchIndex {
            inner: Arc::new(output.0),
            build_ms: output.1,
        })
    }
}
#[napi]
pub fn build_search_index(input: String) -> AsyncTask<Build> {
    AsyncTask::new(Build { input })
}

pub struct Search {
    index: Arc<SearchIndex>,
    input: String,
}
impl Task for Search {
    type Output = NativeResult;
    type JsValue = NativeResult;
    fn compute(&mut self) -> Result<NativeResult> {
        let start = Instant::now();
        let result = self.index.search(&self.input).map_err(error)?;
        Ok(NativeResult {
            result,
            compute_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
    fn resolve(&mut self, _: Env, output: NativeResult) -> Result<NativeResult> {
        Ok(output)
    }
}
#[napi]
impl RustSearchIndex {
    #[napi(getter)]
    pub fn build_ms(&self) -> f64 {
        self.build_ms
    }
    #[napi]
    pub fn search(&self, input: String) -> AsyncTask<Search> {
        AsyncTask::new(Search {
            index: self.inner.clone(),
            input,
        })
    }
}

pub struct Usage {
    input: String,
}
impl Task for Usage {
    type Output = NativeResult;
    type JsValue = NativeResult;
    fn compute(&mut self) -> Result<NativeResult> {
        let start = Instant::now();
        let result = usage::compute(&self.input).map_err(error)?;
        Ok(NativeResult {
            result,
            compute_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
    fn resolve(&mut self, _: Env, output: NativeResult) -> Result<NativeResult> {
        Ok(output)
    }
}
#[napi]
pub fn compute_usage(input: String) -> AsyncTask<Usage> {
    AsyncTask::new(Usage { input })
}

pub mod claude_refresh;
pub mod codex_models;
