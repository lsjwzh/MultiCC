use crate::guard::{guard, task_domain_panic_probe};
use napi::Result;
use napi_derive::napi;
#[napi]
pub fn task_domain(input: String) -> Result<String> {
    guard("TASK_DOMAIN_PANIC", || {
        task_domain_panic_probe(&input);
        multicc_core::task_domain::run(&input).map_err(napi::Error::from_reason)
    })
}

use crate::task_board::{lock_board, RustTaskBoard};
use multicc_core::task_domain::card_cache::CardCache;
use multicc_core::task_domain::handle::BoardState;
use napi::{bindgen_prelude::AsyncTask, Env, Task};
use std::sync::{Arc, Mutex, MutexGuard};
// 持锁区 panic 会毒化 Mutex；重置缓存后继续，避免永久 card_cache_unavailable。
fn lock_cache(inner: &Arc<Mutex<CardCache>>) -> MutexGuard<'_, CardCache> {
    match inner.lock() {
        Ok(cache) => cache,
        Err(poisoned) => {
            let mut cache = poisoned.into_inner();
            *cache = CardCache::default();
            inner.clear_poison();
            cache
        }
    }
}
#[napi]
pub struct RustAirCardCache {
    inner: Arc<Mutex<CardCache>>,
}
pub struct CacheJob {
    inner: Arc<Mutex<CardCache>>,
    input: String,
    prepare: Option<u32>,
    board: Option<Arc<Mutex<BoardState>>>,
}
impl Task for CacheJob {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        let inner = self.inner.clone();
        let input = self.input.clone();
        let prepare = self.prepare;
        let board = self.board.clone();
        guard("TASK_DOMAIN_PANIC", move || {
            task_domain_panic_probe(&input);
            let mut cache = lock_cache(&inner);
            match (prepare, board) {
                // 锁序固定为卡片缓存 → 任务板；主线程只单独锁任务板，不会成环。
                (Some(token), Some(board)) => {
                    let state = lock_board(&board);
                    if state.is_stale() {
                        Err("TASK_BOARD_RESYNC_REQUIRED".to_string())
                    } else {
                        cache.prepare_on(&input, state.board(), state.version(), token)
                    }
                }
                (Some(token), None) => cache.prepare(&input, token),
                (None, _) => cache.run(&input),
            }
            .map_err(napi::Error::from_reason)
        })
    }
    fn resolve(&mut self, _: Env, out: String) -> Result<String> {
        Ok(out)
    }
}
#[napi]
impl RustAirCardCache {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(CardCache::default())),
        }
    }
    #[napi]
    pub fn run(&self, input: String) -> Result<String> {
        guard("TASK_DOMAIN_PANIC", || {
            task_domain_panic_probe(&input);
            lock_cache(&self.inner)
                .run(&input)
                .map_err(napi::Error::from_reason)
        })
    }
    #[napi]
    pub fn run_async(&self, input: String) -> AsyncTask<CacheJob> {
        AsyncTask::new(CacheJob {
            inner: self.inner.clone(),
            input,
            prepare: None,
            board: None,
        })
    }
    #[napi]
    pub fn prepare_async(&self, input: String, known_token: u32) -> AsyncTask<CacheJob> {
        AsyncTask::new(CacheJob {
            inner: self.inner.clone(),
            input,
            prepare: Some(known_token),
            board: None,
        })
    }
    /// 卡片输入直接读常驻任务板：宿主先同步上送，输入里不再带整板。
    #[napi]
    pub fn prepare_board_async(
        &self,
        input: String,
        known_token: u32,
        board: &RustTaskBoard,
    ) -> AsyncTask<CacheJob> {
        AsyncTask::new(CacheJob {
            inner: self.inner.clone(),
            input,
            prepare: Some(known_token),
            board: Some(board.shared()),
        })
    }
}
impl Default for RustAirCardCache {
    fn default() -> Self {
        Self::new()
    }
}

pub struct DomainJob {
    input: String,
}
impl Task for DomainJob {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        guard("TASK_DOMAIN_PANIC", || {
            task_domain_panic_probe(&self.input);
            multicc_core::task_domain::run(&self.input).map_err(napi::Error::from_reason)
        })
    }
    fn resolve(&mut self, _: Env, out: String) -> Result<String> {
        Ok(out)
    }
}
#[napi]
pub fn task_domain_async(input: String) -> AsyncTask<DomainJob> {
    AsyncTask::new(DomainJob { input })
}

#[napi]
pub fn task_domain_protocol_version() -> u32 {
    1
}
