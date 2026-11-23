//! A cancellable model-request timer. Node owns the socket and reports
//! its lifecycle; the Rust task owns the timer and never holds Node's loop open.
use crate::js_live::LiveValue;
use napi::bindgen_prelude::{spawn, Function, Object, This, Unknown};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, Error, Result};
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;

#[napi]
pub struct RustRequestTimer {
    active: Arc<AtomicBool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

#[napi]
impl RustRequestTimer {
    #[napi(constructor)]
    pub fn new(env: Env, milliseconds: f64, callback: Function<'_, (), ()>) -> Result<Self> {
        if !milliseconds.is_finite() || milliseconds <= 0.0 || milliseconds > 2_147_483_647.0 {
            return Err(Error::from_reason("invalid request timer"));
        }
        let delay = Duration::from_millis((milliseconds.trunc() as u64).max(1));
        let active = Arc::new(AtomicBool::new(true));
        let delivery = active.clone();
        let callback = callback.create_ref()?;
        // Cancellation can win after Tokio has already enqueued a JS callback.
        // Test the flag on the receiving thread immediately before delivery.
        let guarded =
            env.create_function_from_closure::<(), (), _>("requestTimeout", move |ctx| {
                if delivery.swap(false, Ordering::Relaxed) {
                    callback.borrow_back(ctx.env)?.call(())?;
                }
                Ok(())
            })?;
        let callback = guarded
            .build_threadsafe_function::<()>()
            .weak::<true>()
            .callee_handled::<false>()
            .build()?;
        let deadline = tokio::time::Instant::now() + delay;
        let task = spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let _ = callback.call((), ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(Self {
            active,
            task: Mutex::new(Some(task)),
        })
    }

    #[napi]
    pub fn cancel(&self) {
        self.active.store(false, Ordering::Relaxed);
        if let Some(task) = self.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
    }
    #[napi]
    pub fn unref<'env>(&self, this: This<'env>) -> Object<'env> {
        this.object
    }
}

impl Drop for RustRequestTimer {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[napi]
pub fn schedule_request_timer(
    env: Env,
    callback: Function<'_, (), ()>,
    milliseconds: Unknown<'_>,
) -> Result<RustRequestTimer> {
    let value = LiveValue::new(&env, milliseconds).explicit_number()?;
    let delay = if value > 0.0 && value <= 2_147_483_647.0 {
        value
    } else {
        1.0
    };
    RustRequestTimer::new(env, delay, callback)
}
