//! A cancellable model-request timer. Node owns the socket and reports
//! its lifecycle; the Rust task owns the timer and never holds Node's loop open.
use napi::bindgen_prelude::spawn;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::sync::Mutex;
use std::time::Duration;
use tokio::task::JoinHandle;

type Callback = ThreadsafeFunction<(), (), (), Status, false, true>;

#[napi]
pub struct RustRequestTimer {
    task: Mutex<Option<JoinHandle<()>>>,
}

#[napi]
impl RustRequestTimer {
    #[napi(constructor)]
    pub fn new(milliseconds: f64, callback: Callback) -> Result<Self> {
        if !milliseconds.is_finite() || milliseconds <= 0.0 || milliseconds > 2_147_483_647.0 {
            return Err(Error::from_reason("invalid request timer"));
        }
        let delay = Duration::from_millis((milliseconds.trunc() as u64).max(1));
        let deadline = tokio::time::Instant::now() + delay;
        let task = spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let _ = callback.call((), ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(Self {
            task: Mutex::new(Some(task)),
        })
    }

    #[napi]
    pub fn cancel(&self) {
        if let Some(task) = self.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
    }
}

impl Drop for RustRequestTimer {
    fn drop(&mut self) {
        self.cancel();
    }
}
