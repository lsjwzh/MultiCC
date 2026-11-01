//! 常驻任务板的 N-API 句柄：同步入口在主线程持锁执行，只读规则可走工作线程。
use crate::guard::guard;
use multicc_core::task_domain::handle::BoardState;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::sync::{Arc, Mutex, MutexGuard};

// 持锁区 panic 会毒化 Mutex：取回状态但标记失效，宿主下一次整板上送重建。
pub fn lock_board(inner: &Arc<Mutex<BoardState>>) -> MutexGuard<'_, BoardState> {
    match inner.lock() {
        Ok(state) => state,
        Err(poisoned) => {
            let mut state = poisoned.into_inner();
            state.mark_stale();
            inner.clear_poison();
            state
        }
    }
}

#[napi]
pub struct RustTaskBoard {
    inner: Arc<Mutex<BoardState>>,
}

impl RustTaskBoard {
    pub fn shared(&self) -> Arc<Mutex<BoardState>> {
        self.inner.clone()
    }
    fn call(
        &self,
        f: impl FnOnce(&mut BoardState) -> std::result::Result<String, String>,
    ) -> Result<String> {
        guard("TASK_BOARD_PANIC", || {
            f(&mut lock_board(&self.inner)).map_err(napi::Error::from_reason)
        })
    }
}

impl Default for RustTaskBoard {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustTaskBoard {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(BoardState::default())),
        }
    }
    #[napi]
    pub fn open(&self, input: String) -> Result<String> {
        self.call(|s| s.open(&input))
    }
    #[napi]
    pub fn apply(&self, input: String) -> Result<String> {
        self.call(|s| s.apply(&input))
    }
    #[napi]
    pub fn apply_async(&self, input: String) -> AsyncTask<BoardReadJob> {
        AsyncTask::new(BoardReadJob {
            inner: self.inner.clone(),
            input,
        })
    }
    #[napi]
    pub fn persist(&self, input: String) -> Result<String> {
        self.call(|s| s.persist(&input))
    }
    #[napi]
    pub fn snapshot(&self, input: String) -> Result<String> {
        self.call(|s| s.snapshot(&input))
    }
    #[napi]
    pub fn verify(&self, input: String) -> Result<String> {
        self.call(|s| s.verify(&input))
    }
}

pub struct BoardReadJob {
    inner: Arc<Mutex<BoardState>>,
    input: String,
}
impl Task for BoardReadJob {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        let inner = self.inner.clone();
        let input = std::mem::take(&mut self.input);
        guard("TASK_BOARD_PANIC", move || {
            lock_board(&inner)
                .apply_read(&input)
                .map_err(napi::Error::from_reason)
        })
    }
    fn resolve(&mut self, _: Env, out: String) -> Result<String> {
        Ok(out)
    }
}
