use crate::NativeResult;
use multicc_core::quota_history::History;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

#[napi]
pub struct RustQuotaHistory {
    state: Arc<Mutex<History>>,
}

pub struct HistoryJob {
    state: Arc<Mutex<History>>,
    input: String,
    query: bool,
}

impl Task for HistoryJob {
    type Output = NativeResult;
    type JsValue = NativeResult;
    fn compute(&mut self) -> Result<NativeResult> {
        let start = Instant::now();
        let result = {
            let mut history = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("quota_history_unavailable"))?;
            if self.query {
                history.query(&self.input)
            } else {
                history.record(&self.input)
            }
        }
        .map_err(|error| napi::Error::from_reason(format!("MULTICC_QUOTA_HISTORY:{error}")))?;
        Ok(NativeResult {
            result,
            compute_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
    fn resolve(&mut self, _: Env, result: NativeResult) -> Result<NativeResult> {
        Ok(result)
    }
}

#[napi]
impl RustQuotaHistory {
    #[napi(constructor)]
    pub fn new(file: String, retention_ms: Option<f64>) -> Result<Self> {
        let history = History::open(&file, retention_ms.map(|value| value as i64))
            .map_err(|error| napi::Error::from_reason(format!("quota_history_open_failed: {error}")))?;
        Ok(Self {
            state: Arc::new(Mutex::new(history)),
        })
    }

    #[napi]
    pub fn record(&self, input: String) -> AsyncTask<HistoryJob> {
        AsyncTask::new(HistoryJob {
            state: self.state.clone(),
            input,
            query: false,
        })
    }

    #[napi]
    pub fn query(&self, input: String) -> AsyncTask<HistoryJob> {
        AsyncTask::new(HistoryJob {
            state: self.state.clone(),
            input,
            query: true,
        })
    }
}

#[napi]
pub fn quota_history_protocol_version() -> u32 {
    1
}
